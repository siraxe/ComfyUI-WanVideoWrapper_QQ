import torch
from safetensors.torch import save_file, safe_open
from pathlib import Path
from typing import Optional, Dict


def load_lora(path, device="cpu"):
    """Load LoRA from safetensors or pytorch file."""
    path = Path(path)
    if path.suffix == ".safetensors":
        with safe_open(path, framework="pt", device=device) as f:
            sd = {k: f.get_tensor(k) for k in f.keys()}
            metadata = f.metadata()
    else:
        sd = torch.load(path, map_location=device)
        if isinstance(sd, dict) and "state_dict" in sd:
            sd = sd["state_dict"]
        metadata = None
    return sd, metadata


def save_lora(sd, output_path, metadata=None, dtype=None, output_format="lora"):
    """
    Save state dict to safetensors with optional conversion.

    Args:
        sd: State dict to save
        output_path: Output file path
        metadata: Optional metadata dict
        dtype: Optional dtype for conversion
        output_format: Format to save as - "lora" or "lokr"
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Convert to LoKR format if requested
    if output_format == "lokr":
        from ltx_merger.utils.lokr import convert_lora_to_lokr
        sd = convert_lora_to_lokr(sd)

        # Update metadata for LoKR
        from ltx_merger.utils.lokr import get_lokr_metadata
        factor = None
        conv_dim = None

        # Try to extract factor from metadata or state dict
        if metadata:
            if "ss_network_dim" in metadata:
                factor = int(metadata.get("ss_network_dim", factor))
            if "lokr_conv_dim" in metadata:
                conv_dim = int(metadata.get("lokr_conv_dim", conv_dim))

        metadata = get_lokr_metadata(factor=factor, conv_dim=conv_dim, original_metadata=metadata)

    processed_sd = {}
    for k, v in sd.items():
        if isinstance(v, torch.Tensor):
            v = v.cpu()
            if dtype is not None and v.dtype.is_floating_point:
                v = v.to(dtype)
            processed_sd[k] = v
        else:
            processed_sd[k] = v

    save_file(processed_sd, str(output_path), metadata=metadata)