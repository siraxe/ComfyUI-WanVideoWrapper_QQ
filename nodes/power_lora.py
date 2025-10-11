import os
from typing import Union
import folder_paths


class AnyType(str):
    """A special class that is always equal in not equal comparisons. Credit to pythongosssss"""

    def __ne__(self, __value: object) -> bool:
        return False


class FlexibleOptionalInputType(dict):
    """A special class to make flexible nodes that pass data to our python handlers.

    Enables both flexible/dynamic input types (like for Any Switch) or a dynamic number of inputs
    (like for Any Switch, Context Switch, Context Merge, Power Lora Loader, etc).

    Initially, ComfyUI only needed to return True for `__contains__` below, which told ComfyUI that
    our node will handle the input, regardless of what it is.

    However, after https://github.com/comfyanonymous/ComfyUI/pull/2666 ComdyUI's execution changed
    also checking the data for the key; specifcially, the type which is the first tuple entry. This
    type is supplied to our FlexibleOptionalInputType and returned for any non-data key. This can be a
    real type, or use the AnyType for additional flexibility.
    """

    def __init__(self, type, data: Union[dict, None] = None):
        """Initializes the FlexibleOptionalInputType.

        Args:
          type: The flexible type to use when ComfyUI retrieves an unknown key (via `__getitem__`).
          data: An optional dict to use as the basis. This is stored both in a `data` attribute, so we
            can look it up without hitting our overrides, as well as iterated over and adding its key
            and values to our `self` keys. This way, when looked at, we will appear to represent this
            data. When used in an "optional" INPUT_TYPES, these are the starting optional node types.
        """
        self.type = type
        self.data = data
        if self.data is not None:
            for k, v in self.data.items():
                self[k] = v

    def __getitem__(self, key):
        # If we have this key in the initial data, then return it. Otherwise return the tuple with our
        # flexible type.
        if self.data is not None and key in self.data:
            val = self.data[key]
            return val
        return (self.type,)

    def __contains__(self, key):
        """Always contain a key, and we'll always return the tuple above when asked for it."""
        return True


any_type = AnyType("*")


class WanVideoPowerLoraLoader:
    """A power lora loader for WanVideo that supports unlimited loras with rgthree-style UI."""

    def __init__(self):
        self.properties = {
            "low_mem_load": True,
            "merge_loras": False
        }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
            },
            "optional": FlexibleOptionalInputType(type=any_type, data={
                "prev_lora": ("WANVIDLORA", {"default": None, "tooltip": "For loading multiple LoRAs"}),
                "blocks": ("SELECTEDBLOCKS", {"tooltip": "Block selection for lora application"}),
            }),
            "hidden": {},
        }

    RETURN_TYPES = ("WANVIDLORA", "WANVIDLORA")
    RETURN_NAMES = ("selected_lora", "low_lora")
    FUNCTION = "load_loras"
    CATEGORY = "WanVideoWrapper_QQ/utils"
    DESCRIPTION = "A powerful, flexible node to load multiple WanVideo loras with rgthree-style UI"

    def load_loras(self, prev_lora=None, blocks=None, **kwargs):
        """Loops over the provided loras in kwargs and applies valid ones."""
        # Get options from widget data first, fallback to attributes
        options_data = kwargs.get('OptionsWidget')

        if options_data:
            low_mem_load = options_data.get('low_mem_load', False)
            merge_loras = options_data.get('merge_loras', True)
        else:
            # Fallback to ComfyUI properties
            low_mem_load = getattr(self, 'low_mem_load', False)
            merge_loras = getattr(self, 'merge_loras', True)

        if not merge_loras:
            low_mem_load = False  # Unmerged LoRAs don't need low_mem_load

        loras_list = list(prev_lora) if prev_lora else []
        low_loras_list = []

        # Get available lora files for validation
        lora_files = folder_paths.get_filename_list("loras")

        for key, value in kwargs.items():
            if key.startswith('lora_') and isinstance(value, dict) and 'on' in value and 'lora' in value and 'strength' in value:
                # Check if lora is enabled and has valid data
                if not value['on']:
                    continue

                lora_name = value['lora']
                if not lora_name or lora_name.lower() == "none" or lora_name not in lora_files:
                    continue

                strength_model = value['strength']
                # If we just passed one strength value, then use it for both, if we passed a strengthTwo
                # as well, then our `strength` will be for the model, and `strengthTwo` for clip.
                strength_clip = value.get('strengthTwo', strength_model)

                # Round strength values to avoid floating point precision issues
                strength_model = round(strength_model, 4) if not isinstance(strength_model, list) else strength_model
                strength_clip = round(strength_clip, 4) if not isinstance(strength_clip, list) else strength_clip

                # Skip if both strengths are zero
                if strength_model == 0.0 and strength_clip == 0.0:
                    continue

                # Build lora entry in WanVideo format
                lora_entry = {
                    "path": folder_paths.get_full_path("loras", lora_name),
                    "strength": strength_model,
                    "name": os.path.splitext(lora_name)[0],
                    "blocks": blocks.get("selected_blocks", {}) if blocks else {},
                    "layer_filter": blocks.get("layer_filter", "") if blocks else "",
                    "low_mem_load": low_mem_load,
                    "merge_loras": merge_loras,
                }

                # Add clip strength if it's different from model strength
                if strength_clip != strength_model:
                    lora_entry["strength_clip"] = strength_clip

                loras_list.append(lora_entry)

                # Check if JavaScript detected a low variant for this LoRA
                is_low = value.get('is_low', False)
                low_variant_name = value.get('low_variant_name')
                print(f"[WanVideoPowerLoraLoader] LoRA '{lora_name}' is_low flag: {is_low}, low_variant_name: {low_variant_name}")

                if is_low and low_variant_name:
                    # Use low_strength for the low variant LoRA, fallback to strength_model if not available
                    low_strength = value.get('low_strength', strength_model)
                    
                    # Create entry for the low variant LoRA
                    low_lora_entry = {
                        "path": folder_paths.get_full_path("loras", low_variant_name),
                        "strength": low_strength,
                        "name": os.path.splitext(low_variant_name)[0],
                        "blocks": blocks.get("selected_blocks", {}) if blocks else {},
                        "layer_filter": blocks.get("layer_filter", "") if blocks else "",
                        "low_mem_load": low_mem_load,
                        "merge_loras": merge_loras,
                    }

                    # Add clip strength if the original high LoRA was using separate model/clip strengths
                    if strength_clip != strength_model:
                        # For low variant with separate model/clip strengths, we should probably use the same clip strength
                        # but some users might want to apply the low_strength concept to clip as well
                        # For now, maintain the same clip strength relationship as the original
                        low_lora_entry["strength_clip"] = strength_clip

                    low_loras_list.append(low_lora_entry)
                    print(f"[WanVideoPowerLoraLoader] Added low variant '{low_variant_name}' to low_loras_list with strength: {low_strength}")

        return (loras_list, low_loras_list)


NODE_CLASS_MAPPINGS = {
    "WanVideoPowerLoraLoader": WanVideoPowerLoraLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WanVideoPowerLoraLoader": "Wan Video Power Lora Loader",
}