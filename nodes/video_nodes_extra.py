import torch
import torch.nn.functional as F
import io
import base64
import numpy as np
import json

class VideoMergeABC:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_A": ("IMAGE",),
                "image_B": ("IMAGE",),
                "image_C": ("IMAGE",),
                "FlamesOverlap": ("INT", {"default": 15, "min": 1, "max": 10000, "step": 1}),
                "easing_clamp": ("FLOAT", {"default": 0.5, "min": -1.0, "max": 2.0, "step": 0.01}),
                "easing_type": (["linear", "ease_in", "ease_out", "ease_in_out"],),
                "resize_to_B": (["off", "on"], {"default": "off"}),
            },
            "hidden": {
                "opacity_curve": ("STRING", {"default": "[]", "multiline": True}),
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("images", "debug")
    FUNCTION = "merge_abc"
    CATEGORY = "WanVideoWrapper_QQ/video"

    def merge_abc(self, image_A, image_B, image_C, FlamesOverlap, easing_clamp, easing_type, resize_to_B, **kwargs):
        opacity_curve = kwargs.get('opacity_curve', '[]')
        num_b = image_B.shape[0]
        device = image_B.device

        try:
            opacity_y = json.loads(opacity_curve)
            if not isinstance(opacity_y, list) or len(opacity_y) != num_b:
                y_list = self._generate_y_values(num_b, FlamesOverlap, easing_clamp, easing_type)
                opacity_y = torch.tensor(y_list, dtype=torch.float32, device=device)
            else:
                # Resample the curve from JS UI to ensure consistency
                opacity_y = self._resample_curve(opacity_y, num_b, FlamesOverlap, easing_clamp, easing_type, device)
        except (json.JSONDecodeError, ValueError) as e:
            y_list = self._generate_y_values(num_b, FlamesOverlap, easing_clamp, easing_type)
            opacity_y = torch.tensor(y_list, dtype=torch.float32, device=device)

        num_a, h_a, w_a, c_a = image_A.shape
        num_c, h_c, w_c, c_c = image_C.shape
        h_b, w_b, c_b = image_B.shape[1:]

        # Check if resize_to_B is enabled
        if resize_to_B == "on":
            # Use image_B's dimensions as the target
            target_h = h_b
            target_w = w_b
            target_c = max(c_a, c_b, c_c)
            
            # Resize image_A and image_C to match image_B's dimensions
            image_A = self._resize_to_target(image_A, num_a, target_h, target_w, target_c)
            image_C = self._resize_to_target(image_C, num_c, target_h, target_w, target_c)
            # image_B already has the correct dimensions, but ensure channel consistency
            image_B = self._resize_to_target(image_B, num_b, target_h, target_w, target_c)
        else:
            # Original behavior: use the maximum dimensions
            target_h = max(h_a, h_b, h_c)
            target_w = max(w_a, w_b, w_c)
            target_c = max(c_a, c_b, c_c)

            image_A = self._resize_to_target(image_A, num_a, target_h, target_w, target_c)
            image_B = self._resize_to_target(image_B, num_b, target_h, target_w, target_c)
            image_C = self._resize_to_target(image_C, num_c, target_h, target_w, target_c)

        safe_overlap = min(FlamesOverlap, num_a, num_c, num_b // 2)

        if safe_overlap == 0:
            return (image_B, image_B)  # Return same image for both outputs when no overlap

        A1 = image_A[:-safe_overlap]
        A2 = image_A[-safe_overlap:]
        C1 = image_C[:safe_overlap]
        C2 = image_C[safe_overlap:]

        B_old = torch.zeros_like(image_B)
        B_old[:safe_overlap] = A2
        B_old[-safe_overlap:] = C1

        # Use modular blending function for actual output
        B_new = self._blend_images(image_B, B_old, opacity_y)

        result = torch.cat([A1, B_new, C2], dim=0)

        # Create debug visualization with blue overlay on image_B
        debug_image = self._create_debug_image(image_A, image_B, image_C, opacity_y)

        graph_data = self._create_transition_graph(num_b, FlamesOverlap, easing_clamp, easing_type)
        
        ui_data = {"transition_graph": [graph_data]}
        return {"ui": ui_data, "result": (result, debug_image)}

    def _generate_y_values(self, num_frames, FlamesOverlap, easing_clamp, easing_type):
        y = [0.0] * num_frames
        
        safe_overlap = min(FlamesOverlap, num_frames // 2)
        # Use original remap_clamp calculation to match JS behavior
        remap_clamp = (easing_clamp - 0.5) * 2
        if safe_overlap > 0:
            for i in range(1, safe_overlap + 1):
                progress = i / safe_overlap
                y_eased = self._apply_easing(progress, easing_type)
                # Use original remap_clamp to allow negative values
                y[i] = y_eased ** (2 ** -remap_clamp)

            for i in range(safe_overlap + 1, num_frames - safe_overlap):
                y[i] = 1.0

            inverted_easing_type = self._invert_easing_type(easing_type)
            for i in range(num_frames - safe_overlap, num_frames):
                progress = (i - (num_frames - safe_overlap)) / (safe_overlap - 1) if safe_overlap > 1 else 1.0
                y_eased = 1.0 - self._apply_easing(progress, inverted_easing_type)
                # Use original remap_clamp to allow negative values
                y[i] = y_eased ** (2 ** -remap_clamp)
        
        if num_frames > 0:
            y[0] = 0.0
            if num_frames > 1:
                 y[num_frames-1] = 0.0

        return y

    def _resample_curve(self, js_curve, target_frames, FlamesOverlap, easing_clamp, easing_type, device):
        """
        Resample the curve from JS UI to ensure consistency and prevent negative jumping.
        
        Args:
            js_curve: List of y values from JS UI
            target_frames: Number of frames to resample to
            FlamesOverlap: Overlap parameter
            easing_clamp: Easing clamp parameter
            easing_type: Type of easing
            device: PyTorch device
            
        Returns:
            Resampled tensor of opacity values
        """

        # If the curve already has the right number of frames, use it directly
        if len(js_curve) == target_frames:
            # Ensure values are properly clamped to prevent negative jumping
            resampled = []
            for val in js_curve:
                # Clamp values to prevent negative jumping
                clamped_val = max(0.0, min(1.0, float(val)))
                resampled.append(clamped_val)
            return torch.tensor(resampled, dtype=torch.float32, device=device)
        
        # Otherwise, generate a new curve using the current parameters
        # This ensures consistency between JS and Python
        y_list = self._generate_y_values(target_frames, FlamesOverlap, easing_clamp, easing_type)
        return torch.tensor(y_list, dtype=torch.float32, device=device)

    def _create_transition_graph(self, num_frames, FlamesOverlap, easing_clamp, easing_type):
        y = self._generate_y_values(num_frames, FlamesOverlap, easing_clamp, easing_type)
        x = list(range(num_frames))
        
        safe_overlap = min(FlamesOverlap, num_frames // 2)
        key_frames = [0, safe_overlap, num_frames - safe_overlap, num_frames - 1]
        key_values = [y[k] if 0 <= k < len(y) else 0.0 for k in key_frames]

        return { "x": x, "y": y, "key_frames": key_frames, "key_values": key_values }

    def _apply_easing(self, t, easing_type):
        if easing_type == "ease_in":
            return t * t
        elif easing_type == "ease_out":
            return 1.0 - (1.0 - t) * (1.0 - t)
        elif easing_type == "ease_in_out":
            return 2.0 * t * t if t < 0.5 else 1.0 - 2.0 * (1.0 - t) * (1.0 - t)
        return t

    def _invert_easing_type(self, easing_type):
        if easing_type == "ease_in":
            return "ease_out"
        elif easing_type == "ease_out":
            return "ease_in"
        return easing_type

    def _resize_to_target(self, image, target_b, target_h, target_w, target_c):
        b, h, w, c = image.shape
        
        if c != target_c:
            # Basic channel handling
            if c == 1: image = image.repeat(1, 1, 1, target_c)
            else: image = image[..., :target_c]

        if b != target_b:
            if b == 1:
                image = image.repeat(target_b, 1, 1, 1)
            elif b < target_b:
                image = torch.cat([image, image[-1:].repeat(target_b - b, 1, 1, 1)], dim=0)
            else:
                image = image[:target_b]
        
        if h != target_h or w != target_w:
            image = image.permute(0, 3, 1, 2)
            image = F.interpolate(image, size=(target_h, target_w), mode='bilinear', align_corners=False)
            image = image.permute(0, 2, 3, 1)
        
        return image

    def _blend_images(self, base_image, overlay_image, opacity):
        """Modular blending function that blends two images using the given opacity.
        
        Args:
            base_image: The base image (image_B in our case)
            overlay_image: The image to overlay (B_old for actual output, blue for debug)
            opacity: Tensor of opacity values for each frame
            
        Returns:
            Blended image tensor
        """
        opacity_4d = opacity.view(opacity.shape[0], 1, 1, 1)
        # Simple mix blending: base * opacity + overlay * (1 - opacity)
        return base_image * opacity_4d + overlay_image * (1.0 - opacity_4d)
    
    def _create_debug_image(self, image_A, image_B, image_C, opacity_y):
        """Create a debug visualization showing image_B with blue overlay based on opacity curve."""
        b, h, w, c = image_B.shape
        device = image_B.device
        blue_overlay = torch.zeros_like(image_B)
        blue_overlay[..., 2] = 1.0  # Set blue channel to 1.0 (assuming RGB order)
        image_B_with_overlay = self._blend_images(image_B, blue_overlay, opacity_y)

        return image_B_with_overlay

NODE_CLASS_MAPPINGS = {
    "VideoMergeABC": VideoMergeABC,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoMergeABC": "Video Merge ABC",
}
