import os
import sys
import gc
import hashlib
import torch
import torch.nn as nn
import logging
import folder_paths

import comfy.model_management as mm
from comfy.utils import load_torch_file

try:
    from accelerate import init_empty_weights
except ImportError:
    # Mock the context manager if accelerate is not installed
    from contextlib import contextmanager
    @contextmanager
    def init_empty_weights():
        log.warning("`accelerate` library not found. The 'skip_cpu' option will not be effective.")
        yield


# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
log = logging.getLogger(__name__)

def set_module_tensor_to_device(module, tensor_name, device, value=None, dtype=None):
    """
    A helper function to set a given tensor (parameter of buffer) of a module on a specific device
    """
    # Recurse if needed
    if "." in tensor_name:
        splits = tensor_name.split(".")
        for split in splits[:-1]:
            new_module = getattr(module, split)
            if new_module is None:
                raise ValueError(f"{module} has no attribute {split}.")
            module = new_module
        tensor_name = splits[-1]

    if tensor_name not in module._parameters and tensor_name not in module._buffers:
        raise ValueError(f"{module} does not have a parameter or a buffer named {tensor_name}.")
    is_buffer = tensor_name in module._buffers
    old_value = getattr(module, tensor_name)

    if old_value.device == torch.device("meta") and device not in ["meta", torch.device("meta")] and value is None:
        raise ValueError(f"{tensor_name} is on the meta device, we need a `value` to put in on {device}.")

    param = module._parameters[tensor_name] if tensor_name in module._parameters else None
    param_cls = type(param)

    with torch.no_grad():
        if value is None:
            new_value = old_value.to(device)
            if dtype is not None and device in ["meta", torch.device("meta")]:
                if not str(old_value.dtype).startswith(("torch.uint", "torch.int", "torch.bool")):
                    new_value = new_value.to(dtype)
                if not is_buffer:
                    module._parameters[tensor_name] = param_cls(new_value, requires_grad=old_value.requires_grad)
        elif isinstance(value, torch.Tensor):
            new_value = value.to(device)
        else:
            new_value = torch.tensor(value, device=device)

        if is_buffer:
            module._buffers[tensor_name] = new_value
        elif value is not None:
            param_cls = type(module._parameters[tensor_name])
            new_value = param_cls(new_value, requires_grad=False).to(device)
            module._parameters[tensor_name] = new_value

class VideoTextEncodeCached_KJ:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {
            "model_name": (folder_paths.get_filename_list("text_encoders"), {"tooltip": "These models are loaded from 'ComfyUI/models/text_encoders'"}),
            "precision": (["fp32", "bf16", "fp8"],
                    {"default": "bf16"}
                ),
            "positive_prompt": ("STRING", {"default": "", "multiline": True} ),
            "negative_prompt": ("STRING", {"default": "", "multiline": True} ),
            "quantization": (['disabled', 'fp8_e4m3fn'], {"default": 'fp8_e4m3fn', "tooltip": "optional quantization method"}),
            "use_disk_cache": ("BOOLEAN", {"default": True, "tooltip": "Cache the text embeddings to disk for faster re-use, under the customnodes/ComfyUI-WanVideoWrapper/text_embed_cache directory"}),
            "device": (["gpu", "cpu"], {"default": "gpu", "tooltip": "Device to run the text encoding on."}),
            "skip_cpu": ("BOOLEAN", {"default": True, "tooltip": "If True, loads the model directly to VRAM, skipping the initial load to RAM. This can be faster but may use more VRAM."}),
            },
            "optional": {
                "extender_args": ("WANVIDEOPROMPTEXTENDER_ARGS", {"tooltip": "Use this node to extend the prompt with additional text."}),
            }
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("positive", "negative")
    FUNCTION = "process"
    CATEGORY = "WanVideoWrapper"
    DESCRIPTION = "Cached text encoding that outputs standard ComfyUI conditioning (positive/negative) using WanVideo caching logic"

    def process(self, model_name, precision, positive_prompt, negative_prompt, quantization='disabled', use_disk_cache=True, device="gpu", skip_cpu=False, extender_args=None):
        # For now, let's create a simplified version that uses basic T5 loading
        # This avoids the complex import issues with the WanVideo modules

        # Create cache directory if needed
        cache_dir = os.path.join(os.path.dirname(__file__), '..', 'text_embed_cache')
        os.makedirs(cache_dir, exist_ok=True)

        # Create cache file paths
        def get_cache_path(prompt):
            prompt_hash = hashlib.md5(prompt.encode()).hexdigest()
            return os.path.join(cache_dir, f"{prompt_hash}.safetensors")

        pos_cache_path = get_cache_path(positive_prompt)
        neg_cache_path = get_cache_path(negative_prompt)

        pos_embeds = None
        neg_embeds = None

        # Try to load from cache
        if use_disk_cache and os.path.exists(pos_cache_path):
            try:
                pos_embeds = torch.load(pos_cache_path, map_location='cpu')
                log.info(f"Loaded positive embeddings from cache: {pos_cache_path}, shape: {pos_embeds.shape}")
                # Check if cached embeddings have wrong dimensions
                if pos_embeds.shape[-1] != 4096:
                    log.warning(f"Cached embeddings have wrong dimensions: {pos_embeds.shape}, expected last dim to be 4096. Ignoring cache.")
                    pos_embeds = None
            except Exception as e:
                log.warning(f"Failed to load positive cache: {e}")

        if use_disk_cache and os.path.exists(neg_cache_path):
            try:
                neg_embeds = torch.load(neg_cache_path, map_location='cpu')
                log.info(f"Loaded negative embeddings from cache: {neg_cache_path}, shape: {neg_embeds.shape}")
                # Check if cached embeddings have wrong dimensions
                if neg_embeds.shape[-1] != 4096:
                    log.warning(f"Cached embeddings have wrong dimensions: {neg_embeds.shape}, expected last dim to be 4096. Ignoring cache.")
                    neg_embeds = None
            except Exception as e:
                log.warning(f"Failed to load negative cache: {e}")

        # If not loaded from cache, we need to generate actual embeddings
        if pos_embeds is None or neg_embeds is None:
            try:
                from .wanvideo_t5.t5 import T5Encoder
                from .wanvideo_t5.tokenizers import HuggingfaceTokenizer as T5Tokenizer

                if precision == 'fp8':
                    # For FP8, we load in a higher precision first (e.g., bf16) and then convert
                    dtype = torch.bfloat16
                else:
                    dtype = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}[precision]
                
                device_torch = mm.get_torch_device() if device == "gpu" else torch.device("cpu")

                # Get model path
                model_path = folder_paths.get_full_path("text_encoders", model_name)
                
                # Config for umt5-xxl encoder, from wanvideo.modules.t5.py
                t5_config = {
                    'vocab': 256384, 'dim': 4096, 'dim_attn': 4096, 'dim_ffn': 10240,
                    'num_heads': 64, 'num_layers': 24, 'num_buckets': 32, 'shared_pos': False
                }

                if skip_cpu and device == "gpu":
                    log.info(f"Loading T5 model directly to VRAM ({device_torch}) using empty weight initialization.")
                    # Instantiate model on 'meta' device to avoid allocating RAM
                    with init_empty_weights():
                        t5_encoder = T5Encoder(**t5_config).eval().requires_grad_(False)
                    
                    # Load state dict directly to the target device
                    sd = load_torch_file(model_path, safe_load=True, device=device_torch)
                    
                    # Materialize the 'meta' model on the target device without copying data
                    t5_encoder.to_empty(device=device_torch)
                    # Change the dtype of the materialized model before loading the state dict
                    t5_encoder.to(dtype=dtype)
                    
                    # Load the state dict
                    t5_encoder.load_state_dict(sd, strict=False)
                else:
                    log.info(f"Loading T5 model via RAM from: {model_path}")
                    # Instantiate the custom T5Encoder on CPU
                    t5_encoder = T5Encoder(**t5_config).eval().requires_grad_(False)
                    sd = load_torch_file(model_path, safe_load=True)
                    t5_encoder.load_state_dict(sd, strict=False)
                    t5_encoder.to(device_torch, dtype=dtype)
                
                log.info(f"Loaded custom T5 model to {device_torch} with precision: {precision if precision != 'fp8' else 'bf16'}")

                if precision == 'fp8':
                    if not hasattr(torch, 'float8_e4m3fn'):
                        log.error("FP8 not supported. Your PyTorch version is too old or this build doesn't support it.")
                        raise RuntimeError("FP8 not supported. Your PyTorch version is too old or this build doesn't support it.")
                    if device != 'gpu':
                        log.error("FP8 precision is only available on GPU.")
                        raise RuntimeError("FP8 precision is only available on GPU.")

                    log.info("Converting T5 Encoder to FP8.")
                    from ..utility.fp8_optimization import convert_fp8_linear
                    
                    # Convert linear layer weights to fp8
                    for name, submodule in t5_encoder.named_modules():
                        if isinstance(submodule, nn.Linear):
                            submodule.weight.data = submodule.weight.data.to(torch.float8_e4m3fn)
                    
                    # Patch the forward pass to use fp8 matmul
                    convert_fp8_linear(t5_encoder, base_dtype=torch.bfloat16)
                    log.info("T5 Encoder converted to FP8.")

                # Load tokenizer
                tokenizer_path = os.path.join(os.path.dirname(__file__), '..', 'configs', 'T5_tokenizer')
                tokenizer = T5Tokenizer(name=tokenizer_path, seq_len=512)

                def encode_prompt(prompt_text):
                    if not prompt_text: prompt_text = ""
                    
                    input_ids = tokenizer(prompt_text, return_tensors="pt", padding="longest", truncation=True, max_length=512).to(device_torch)
                    
                    with torch.no_grad():
                        embeddings = t5_encoder(ids=input_ids, mask=None)
                    
                    seq_len = embeddings.shape[1]
                    if seq_len < 256:
                        padding = torch.zeros(embeddings.shape[0], 256 - seq_len, embeddings.shape[-1], device=embeddings.device, dtype=embeddings.dtype)
                        embeddings = torch.cat([embeddings, padding], dim=1)
                    elif seq_len > 256:
                        embeddings = embeddings[:, :256, :]
                        
                    return embeddings

                # Generate positive embeddings if needed
                if pos_embeds is None:
                    pos_embeds = encode_prompt(positive_prompt)
                    log.info(f"Generated positive embeddings with shape: {pos_embeds.shape}")
                    if use_disk_cache:
                        torch.save(pos_embeds.cpu(), pos_cache_path)

                # Generate negative embeddings if needed
                if neg_embeds is None:
                    neg_embeds = encode_prompt(negative_prompt)
                    log.info(f"Generated negative embeddings with shape: {neg_embeds.shape}")
                    if use_disk_cache:
                        torch.save(neg_embeds.cpu(), neg_cache_path)

                # Clean up
                del t5_encoder, sd
                mm.soft_empty_cache()

            except Exception as e:
                log.error(f"Failed to generate T5 embeddings: {e}")
                raise RuntimeError(f"Failed to generate T5 embeddings: {e}")

        # Create standard ComfyUI conditioning format
        positive_conditioning = [[pos_embeds, {}]]
        negative_conditioning = [[neg_embeds, {}]]

        # Debug: Log final shapes
        log.info(f"Final positive conditioning tensor shape: {positive_conditioning[0][0].shape}")
        log.info(f"Final negative conditioning tensor shape: {negative_conditioning[0][0].shape}")

        # Clean up
        mm.soft_empty_cache()
        gc.collect()

        return (positive_conditioning, negative_conditioning)

NODE_CLASS_MAPPINGS = {
    "VideoTextEncodeCached_KJ": VideoTextEncodeCached_KJ,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoTextEncodeCached_KJ": "Video Text Encode Cached (KJ)",
}