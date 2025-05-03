import os
import torch

class WanVideoCacheSamples:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "cache_path": ("STRING", {"default": "cache_data", "multiline": False}),
                "cache_name": ("STRING", {"default": "wanvideo_cached_samples.pt", "multiline": False}),
            },
            "optional": {
                "samples": ("LATENT", {"forceInput": True}),
            }
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("samples",)
    FUNCTION = "cache_or_load_samples"
    CATEGORY = "WanVideoWrapper_QQ/utils"

    def cache_or_load_samples(self, cache_path, cache_name, samples=None):
        # Get the path to the ComfyUI-WanVideoWrapper_QQ directory
        qq_wrapper_path = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

        # Sanitize cache_path to prevent it from being an absolute path
        # and ensure it's just a directory name.
        sanitized_cache_path = os.path.basename(cache_path)

        # The cache directory will be inside the node's directory.
        full_cache_dir = os.path.join(qq_wrapper_path, sanitized_cache_path)
        os.makedirs(full_cache_dir, exist_ok=True)
        
        full_cache_file_path = os.path.join(full_cache_dir, cache_name)

        if samples is not None:
            # Samples are provided, cache them and pass them through
            print(f"WanVideoCacheSamples: Caching samples to {full_cache_file_path}")
            torch.save(samples, full_cache_file_path)
            return (samples,)
        else:
            # Samples are not provided, try to load from cache
            if os.path.exists(full_cache_file_path):
                print(f"WanVideoCacheSamples: Loading samples from {full_cache_file_path}")
                loaded_samples = torch.load(full_cache_file_path)
                return (loaded_samples,)
            else:
                raise FileNotFoundError(f"WanVideoCacheSamples: No samples provided and no cached samples found at {full_cache_file_path}")

# Register the node
NODE_CLASS_MAPPINGS = {
    "WanVideoCacheSamples": WanVideoCacheSamples
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WanVideoCacheSamples": "WanVideo Cache Samples"
}
