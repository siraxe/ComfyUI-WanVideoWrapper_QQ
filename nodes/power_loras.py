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


def get_lora_by_filename_basic(file_path, lora_paths=None, log_node=None):
    """Basic implementation of LoRA path resolution based on rgthree-comfy's get_lora_by_filename."""
    if lora_paths is None:
        lora_paths = folder_paths.get_filename_list("loras")
    
    # Direct match
    if file_path in lora_paths:
        return file_path
    
    # Check without extension
    lora_paths_no_ext = [os.path.splitext(x)[0] for x in lora_paths]
    file_path_no_ext = os.path.splitext(file_path)[0]
    
    if file_path in lora_paths_no_ext:
        found = lora_paths[lora_paths_no_ext.index(file_path)]
        return found
    
    if file_path_no_ext in lora_paths_no_ext:
        found = lora_paths[lora_paths_no_ext.index(file_path_no_ext)]
        return found
    
    # Check just the filename
    lora_filenames_only = [os.path.basename(x) for x in lora_paths]
    if file_path in lora_filenames_only:
        found = lora_paths[lora_filenames_only.index(file_path)]
        if log_node is not None:
            print(f"[{log_node}] Matched LoRA input '{file_path}' to '{found}'.")
        return found
    
    # Check filename without extension
    file_path_filename = os.path.basename(file_path)
    if file_path_filename in lora_filenames_only:
        found = lora_paths[lora_filenames_only.index(file_path_filename)]
        if log_node is not None:
            print(f"[{log_node}] Matched LoRA input '{file_path}' to '{found}'.")
        return found
    
    # Check filename without extension
    lora_filenames_no_ext = [os.path.splitext(os.path.basename(x))[0] for x in lora_paths]
    if file_path in lora_filenames_no_ext:
        found = lora_paths[lora_filenames_no_ext.index(file_path)]
        if log_node is not None:
            print(f"[{log_node}] Matched LoRA input '{file_path}' to '{found}'.")
        return found
    
    file_path_filename_no_ext = os.path.splitext(os.path.basename(file_path))[0]
    if file_path_filename_no_ext in lora_filenames_no_ext:
        found = lora_paths[lora_filenames_no_ext.index(file_path_filename_no_ext)]
        if log_node is not None:
            print(f"[{log_node}] Matched LoRA input '{file_path}' to '{found}'.")
        return found
    
    # Fuzzy match - check if the input exists in any path
    for index, lora_path in enumerate(lora_paths):
        if file_path in lora_path:
            found = lora_paths[index]
            if log_node is not None:
                print(f"[{log_node}] Fuzzy-matched LoRA input '{file_path}' to '{found}'.")
            return found
    
    if log_node is not None:
        print(f"[{log_node}] LoRA '{file_path}' not found, skipping.")
    return None


class WanVideoPowerLoraLoader:
    """A power lora loader for WanVideo that supports unlimited loras with rgthree-style UI."""

    def __init__(self):
        self.properties = {
            "low_mem_load": True,
            "merge_loras": False  # Default to false to allow users to enable it
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
            merge_loras = options_data.get('merge_loras', False)
        else:
            # Fallback to ComfyUI properties
            low_mem_load = getattr(self, 'low_mem_load', False)
            merge_loras = getattr(self, 'merge_loras', False)

        if not merge_loras:
            low_mem_load = False  # Unmerged LoRAs don't need low_mem_load

        loras_list = list(prev_lora) if prev_lora else []
        low_loras_list = []

        # Lists to collect LoRA information for summary printing
        high_loras_summary = []
        low_loras_summary = []

        # Get available lora files for validation
        lora_files = folder_paths.get_filename_list("loras")

        for key, value in kwargs.items():
            if key.startswith('lora_') and isinstance(value, dict) and 'on' in value and 'lora' in value and 'strength' in value:
                # Check if lora is enabled and has valid data
                if not value['on']:
                    continue

                lora_name = value['lora']
                if not lora_name or lora_name.lower() == "none":
                    continue
                
                # Use the sophisticated LoRA path resolution from rgthree-comfy
                try:
                    from rgthree_comfy.py.power_prompt_utils import get_lora_by_filename
                    lora_filename = get_lora_by_filename(lora_name, log_node=self.__class__.__name__)
                except ImportError:
                    # Fallback to basic path resolution if rgthree-comfy is not available
                    lora_filename = get_lora_by_filename_basic(lora_name, log_node=self.__class__.__name__)
                
                if lora_filename is None:
                    print(f"[WanVideoPowerLoraLoader] LoRA '{lora_name}' not found, skipping.")
                    continue

                strength_model = value['strength']
                # If we just passed one strength value, then use it for both, if we passed a strengthTwo
                # as well, then our `strength` will be for the model, and `strengthTwo` for clip.
                strength_clip = value.get('strengthTwo', strength_model)

                # Round strength values to avoid floating point precision issues
                strength_model = round(strength_model, 4) if not isinstance(strength_model, list) else strength_model
                strength_clip = round(strength_clip, 4) if not isinstance(strength_clip, list) and strength_clip is not None else strength_clip

                # Skip if both strengths are zero or None
                if (strength_model == 0.0 or strength_model is None) and (strength_clip == 0.0 or strength_clip is None):
                    continue

                # Build lora entry in WanVideo format
                lora_entry = {
                    "path": folder_paths.get_full_path("loras", lora_filename),
                    "strength": strength_model,
                    "name": os.path.splitext(lora_filename)[0],
                    "blocks": blocks.get("selected_blocks", {}) if blocks else {},
                    "layer_filter": blocks.get("layer_filter", "") if blocks else "",
                    "low_mem_load": low_mem_load,
                    "merge_loras": merge_loras,
                }

                # Add clip strength if it's different from model strength and not None
                if strength_clip is not None and strength_clip != strength_model:
                    lora_entry["strength_clip"] = strength_clip

                loras_list.append(lora_entry)

                # Check if JavaScript detected a low variant for this LoRA
                is_low = value.get('is_low', False)
                low_variant_name = value.get('low_variant_name')
                
                # Add to high loras summary
                high_loras_summary.append((strength_model, lora_filename))

                if is_low and low_variant_name:
                    # Use low_strength for the low variant LoRA, fallback to strength_model if not available
                    low_strength = value.get('low_strength', strength_model)
                    # Ensure low_strength is not None
                    if low_strength is None:
                        low_strength = 0.0
                    
                    # Use the sophisticated LoRA path resolution for low variant
                    try:
                        from rgthree_comfy.py.power_prompt_utils import get_lora_by_filename
                        low_variant_filename = get_lora_by_filename(low_variant_name, log_node=self.__class__.__name__)
                    except ImportError:
                        # Fallback to basic path resolution if rgthree-comfy is not available
                        low_variant_filename = get_lora_by_filename_basic(low_variant_name, log_node=self.__class__.__name__)
                    
                    if low_variant_filename is None:
                        print(f"[WanVideoPowerLoraLoader] Low variant LoRA '{low_variant_name}' not found, skipping low variant.")
                        continue
                    
                    # Create entry for the low variant LoRA
                    low_lora_entry = {
                        "path": folder_paths.get_full_path("loras", low_variant_filename),
                        "strength": low_strength,
                        "name": os.path.splitext(low_variant_filename)[0],
                        "blocks": blocks.get("selected_blocks", {}) if blocks else {},
                        "layer_filter": blocks.get("layer_filter", "") if blocks else "",
                        "low_mem_load": low_mem_load,
                        "merge_loras": merge_loras,
                    }

                    # Add clip strength if the original high LoRA was using separate model/clip strengths
                    if strength_clip is not None and strength_clip != strength_model:
                        # For low variant with separate model/clip strengths, we should probably use the same clip strength
                        # but some users might want to apply the low_strength concept to clip as well
                        # For now, maintain the same clip strength relationship as the original
                        low_lora_entry["strength_clip"] = strength_clip

                    low_loras_list.append(low_lora_entry)
                    # Add to low loras summary
                    low_loras_summary.append((low_strength, low_variant_filename))

        # Print the summary in the requested format
        if high_loras_summary:
            print("------------------------------")
            print(" == HIGH LORAS :")
            for strength, filename in high_loras_summary:
                print(f"    {strength:.2f} - {filename}")
        
        if low_loras_summary:
            print(" == LOW LORAS :")
            for strength, filename in low_loras_summary:
                print(f"    {strength:.2f} - {filename}")
            print("------------------------------")

        return (loras_list, low_loras_list)

class PowerLoraLoaderV2:
    """A power lora loader v2 that combines features from both WanVideoPowerLoraLoader and PowerLoraLoaderV2."""

    def __init__(self):
        self.properties = {
            "Show Strengths": "Single Strength"  # Single Strength or Separate Model & Clip
        }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
            },
            "optional": FlexibleOptionalInputType(type=any_type, data={
                "model_low": ("MODEL",),
                "clip": ("CLIP",),
            }),
            "hidden": {},
        }

    RETURN_TYPES = ("MODEL", "MODEL", "CLIP")
    RETURN_NAMES = ("MODEL", "MODEL_LOW", "CLIP")
    FUNCTION = "load_loras"
    CATEGORY = "WanVideoWrapper_QQ/utils"
    DESCRIPTION = "Power Lora Loader v2 - combines features from v1 and v2 with model_low support"
    OUTPUT_NODE = False  # Allow dynamic return types based on inputs

    def load_loras(self, model=None, model_low=None, clip=None, **kwargs):
        """Combines functionality from both v1 and v2 loaders."""
        # Get show_strengths property
        show_strengths = getattr(self, 'Show Strengths', 'Single Strength')
        
        # Check if clip is actually connected (from JavaScript hasClip property)
        has_clip = getattr(self, 'hasClip', clip is not None)

        # Initialize lists for WanVideo format
        loras_list = []
        low_loras_list = []
        
        # Lists to collect LoRA information for summary printing
        high_loras_summary = []
        low_loras_summary = []
        
        # Get available lora files for validation
        lora_files = folder_paths.get_filename_list("loras")

        for key, value in kwargs.items():
            if key.startswith('lora_') and isinstance(value, dict) and 'on' in value and 'lora' in value and 'strength' in value:
                # Check if lora is enabled and has valid data
                if not value['on']:
                    continue

                lora_name = value['lora']
                if not lora_name or lora_name.lower() == "none":
                    continue
                
                # Use the sophisticated LoRA path resolution from rgthree-comfy
                try:
                    from rgthree_comfy.py.power_prompt_utils import get_lora_by_filename
                    lora_filename = get_lora_by_filename(lora_name, log_node=self.__class__.__name__)
                except ImportError:
                    # Fallback to basic path resolution if rgthree-comfy is not available
                    lora_filename = get_lora_by_filename_basic(lora_name, log_node=self.__class__.__name__)
                
                if lora_filename is None:
                    # Try to get the full path directly from ComfyUI as a fallback
                    try:
                        # First try to get the full path using the original input
                        lora_path = folder_paths.get_full_path("loras", lora_name)
                        if os.path.exists(lora_path):
                            # Extract just the filename for consistency with the rest of the code
                            lora_filename = os.path.basename(lora_name.replace('\\', '/'))
                            print(f"[PowerLoraLoaderV2] Found LoRA at full path: '{lora_path}'")
                        else:
                            print(f"[PowerLoraLoaderV2] LoRA file '{lora_name}' not found in loras folder.")
                            continue
                    except Exception as e:
                        print(f"[PowerLoraLoaderV2] Error getting full path for '{lora_name}': {e}")
                        continue

                strength_model = value['strength']
                # Handle both single strength and separate model/clip strengths
                if show_strengths == "Separate Model & Clip" and 'strengthTwo' in value:
                    strength_clip = value['strengthTwo']
                else:
                    strength_clip = value.get('strengthTwo', strength_model)

                # Round strength values to avoid floating point precision issues
                strength_model = round(strength_model, 4) if not isinstance(strength_model, list) else strength_model
                strength_clip = round(strength_clip, 4) if not isinstance(strength_clip, list) and strength_clip is not None else strength_clip

                # Skip if both strengths are zero or None
                if (strength_model == 0.0 or strength_model is None) and (strength_clip == 0.0 or strength_clip is None):
                    continue
                
                # Apply LoRA to model and clip (PowerLoraLoaderV2 style)
                try:
                    # Always use the relative filename for LoraLoader, not the full path
                    # LoraLoader expects just the filename, not an absolute path
                    lora_path = lora_filename
                    
                    # Apply the lora using ComfyUI's LoraLoader
                    from nodes import LoraLoader
                    
                    # If no clip is provided or not connected, act like LoraLoaderModelOnly
                    if not has_clip:
                        # Only apply to model, use 0 for clip strength
                        if model is not None and strength_model is not None:
                            model, _ = LoraLoader().load_lora(model, None, lora_path, strength_model, 0)
                        
                        # Apply to model_low if it exists
                        if model_low is not None and strength_model is not None:
                            model_low, _ = LoraLoader().load_lora(model_low, None, lora_path, strength_model, 0)
                    else:
                        # Normal operation with clip provided
                        if model is not None and strength_model is not None and strength_clip is not None:
                            model, clip = LoraLoader().load_lora(model, clip, lora_path, strength_model, strength_clip)
                        
                        # Apply to model_low if it exists
                        if model_low is not None and strength_model is not None and strength_clip is not None:
                            model_low, _ = LoraLoader().load_lora(model_low, clip, lora_path, strength_model, strength_clip)
                
                except Exception as e:
                    print(f"[PowerLoraLoaderV2] Error loading lora '{lora_name}': {e}")
                    continue

                # Build lora entry in WanVideo format (WanVideoPowerLoraLoader style)
                lora_entry = {
                    "path": folder_paths.get_full_path("loras", lora_filename),
                    "strength": strength_model,
                    "name": os.path.splitext(lora_filename)[0],
                    "blocks": {},
                    "layer_filter": "",
                }

                # Add clip strength if it's different from model strength and not None
                if strength_clip is not None and strength_clip != strength_model:
                    lora_entry["strength_clip"] = strength_clip

                loras_list.append(lora_entry)

                # Check if JavaScript detected a low variant for this LoRA
                is_low = value.get('is_low', False)
                low_variant_name = value.get('low_variant_name')
                
                # Add to high loras summary
                high_loras_summary.append((strength_model, lora_filename))

                if is_low and low_variant_name:
                    # Use low_strength for the low variant LoRA, fallback to strength_model if not available
                    low_strength = value.get('low_strength', strength_model)
                    # Ensure low_strength is not None
                    if low_strength is None:
                        low_strength = 0.0
                    
                    # Use the sophisticated LoRA path resolution for low variant
                    try:
                        from rgthree_comfy.py.power_prompt_utils import get_lora_by_filename
                        low_variant_filename = get_lora_by_filename(low_variant_name, log_node=self.__class__.__name__)
                    except ImportError:
                        # Fallback to basic path resolution if rgthree-comfy is not available
                        low_variant_filename = get_lora_by_filename_basic(low_variant_name, log_node=self.__class__.__name__)
                    
                    if low_variant_filename is None:
                        print(f"[PowerLoraLoaderV2] Low variant LoRA '{low_variant_name}' not found, skipping low variant.")
                        continue
                    
                    # Create entry for the low variant LoRA
                    low_lora_entry = {
                        "path": folder_paths.get_full_path("loras", low_variant_filename),
                        "strength": low_strength,
                        "name": os.path.splitext(low_variant_filename)[0],
                        "blocks": {},
                        "layer_filter": "",
                    }

                    # Add clip strength if the original high LoRA was using separate model/clip strengths
                    if strength_clip is not None and strength_clip != strength_model:
                        # For low variant with separate model/clip strengths, we should probably use the same clip strength
                        # but some users might want to apply the low_strength concept to clip as well
                        # For now, maintain the same clip strength relationship as the original
                        low_lora_entry["strength_clip"] = strength_clip

                    low_loras_list.append(low_lora_entry)
                    # Add to low loras summary
                    low_loras_summary.append((low_strength, low_variant_filename))

        # Print the summary in the requested format
        if high_loras_summary:
            print("------------------------------")
            print(" == HIGH LORAS :")
            for strength, filename in high_loras_summary:
                print(f"    {strength:.2f} - {filename}")
        
        if low_loras_summary:
            print(" == LOW LORAS :")
            for strength, filename in low_loras_summary:
                print(f"    {strength:.2f} - {filename}")
            print("------------------------------")

        # Return different tuples based on whether clip was connected
        if not has_clip:
            # No clip connected, only return model and model_low (like LoraLoaderModelOnly)
            return (model, model_low)
        else:
            # Clip connected, return all three outputs
            return (model, model_low, clip)

NODE_CLASS_MAPPINGS = {
    "WanVideoPowerLoraLoader": WanVideoPowerLoraLoader,
    "PowerLoraLoaderV2": PowerLoraLoaderV2,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WanVideoPowerLoraLoader": "Wan Video Power Lora Loader",
    "PowerLoraLoaderV2": "Power Lora Loader V2",
}