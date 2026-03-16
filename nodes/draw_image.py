
import json
import math
import numpy as np
import os

import torch
import torch.nn.functional as F
from PIL import Image

from ..utility.utility import pil2tensor, tensor2pil
from ..config.constants import BOX_BASE_RADIUS

# Supersampling factor for smooth scaling
SUPERSAMPLE = 4

class DrawImageOnPath:
    RETURN_TYPES = ("IMAGE", "MASK",)
    RETURN_NAMES = ("image", "mask",)
    FUNCTION = "create"
    CATEGORY = "WanVideoWrapper_QQ/depr"
    DESCRIPTION = """
Draws an input image along a coordinate path for each frame, returning the rendered image and an optional mask.
"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "bg_image": ("IMAGE", ),
                "coordinates": ("STRING", {"forceInput": True}),
                "frames": ("INT", {"default": 0, "min": 0, "max": 10000, "step": 1,"forceInput": True}),
                "ref_images": ("IMAGE", ),
            },
            "optional": {
                "ref_masks": ("MASK", ),
                "use_box_rotation": ("BOOLEAN", {"default": True}),
                "use_box_scale_size": ("BOOLEAN", {"default": True}),
                "fallback_scale": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 100.0, "step": 0.01}),
                "overlay_opacity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "add_shadows": ("BOOLEAN", {"default": False}),
                "mask_fill": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "use_gpu": ("BOOLEAN", {"default": True}),
                "gpu_batch": ("INT", {"default": 8, "min": 1, "max": 64, "step": 1}),
            }
        }

    def __init__(self):
        # Load shadow image
        self.shadow_image = None
        try:
            shadow_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "web", "power_spline_editor", "bg", "shadow_ref.png")
            if os.path.exists(shadow_path):
                self.shadow_image = Image.open(shadow_path).convert("RGBA")
        except Exception as e:
            print(f"Warning: Could not load shadow_ref.png: {e}")

    def _safe_json_load(self, text):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return json.loads(text.replace("'", '"'))

    def _compute_frame_dimensions(self, bg_image):
        try:
            _, h, w, _ = bg_image.shape
            return int(w), int(h)
        except Exception:
            return 512, 512

    def _parse_coordinates(self, coordinates_str):
        coord_width = None
        coord_height = None
        coords = []
        ref_selections = []
        visibility = []
        editor_scale = 1.0
        try:
            parsed = self._safe_json_load(coordinates_str)
            if isinstance(parsed, dict):
                # Get coordinates - prefer "coordinates" since box coords are merged there
                coords_raw = parsed.get("coordinates") or []
                coord_width = parsed.get("coord_width")
                coord_height = parsed.get("coord_height")
                editor_scale = float(parsed.get("editor_scale", 1.0))

                # Extract ref_selections metadata
                ref_selections_meta = parsed.get("ref_selections", {})
                if isinstance(ref_selections_meta, dict):
                    # ref_selections has structure {"p": [...], "c": [...], "b": [...]}
                    # Since box coordinates are merged into "c", we use the "c" list
                    ref_selections = ref_selections_meta.get("c", [])

                # Extract visibility metadata
                visibility_meta = parsed.get("visibility", {})
                if isinstance(visibility_meta, dict):
                    # visibility has structure {"p": [...], "c": [...], "b": [...]}
                    # Since box coordinates are merged into "c", we use the "c" list
                    visibility = visibility_meta.get("c", [])

                # Handle both single layer and multiple layers
                if isinstance(coords_raw, list):
                    # Check if this is array of arrays (multiple layers) or single array
                    if coords_raw and len(coords_raw) > 0 and isinstance(coords_raw[0], list):
                        # Multiple layers - DON'T flatten, keep as separate layers
                        # DrawImageOnPath should process each layer separately
                        coords = coords_raw
                    else:
                        # Single layer - could be a single array or empty
                        coords = coords_raw
                        # For single layer, expand ref_selection to match all coordinates
                        if ref_selections and len(ref_selections) > 0:
                            ref_sel = ref_selections[0]
                            ref_selections = [ref_sel] * len(coords)
            elif isinstance(parsed, list):
                coords = parsed
        except Exception as e:
            print(f"Error parsing coordinates: {e}")
            pass
        # Clean coordinates - handle both single layer and multiple layers
        if coords and len(coords) > 0 and isinstance(coords[0], list):
            # Multiple layers - clean each layer separately
            cleaned = []
            for layer in coords:
                layer_cleaned = []
                for c in layer:
                    if isinstance(c, dict) and "x" in c and "y" in c:
                        layer_cleaned.append(c)
                if layer_cleaned and all(isinstance(c.get("frame", None), (int, float)) for c in layer_cleaned):
                    layer_cleaned = sorted(layer_cleaned, key=lambda item: float(item.get("frame", 0)))
                cleaned.append(layer_cleaned)
            return cleaned, coord_width, coord_height, ref_selections, visibility, editor_scale
        else:
            # Single layer
            cleaned = []
            for c in coords or []:
                if isinstance(c, dict) and "x" in c and "y" in c:
                    cleaned.append(c)
            if cleaned and all(isinstance(c.get("frame", None), (int, float)) for c in cleaned):
                cleaned = sorted(cleaned, key=lambda item: float(item.get("frame", 0)))
            return cleaned, coord_width, coord_height, ref_selections, visibility, editor_scale

    def _scale_point(self, point, frame_width, frame_height, coord_width, coord_height):
        try:
            x = float(point.get("x", 0.0))
            y = float(point.get("y", 0.0))
        except (TypeError, ValueError):
            return 0.0, 0.0

        if coord_width and coord_height:
            scale_x = float(frame_width) / float(coord_width)
            scale_y = float(frame_height) / float(coord_height)
            return x * scale_x, y * scale_y

        # Assume normalized if within [0, 1]
        if 0.0 <= x <= 1.0 and 0.0 <= y <= 1.0:
            return x * frame_width, y * frame_height

        return x, y

    def _get_scale(self, point, fallback_scale):
        for key in ("pointScale", "boxScale", "scale"):
            try:
                if key in point:
                    return max(0.0, float(point.get(key, fallback_scale)))
            except (TypeError, ValueError):
                continue
        return max(0.0, float(fallback_scale))

    def _get_ref_index_from_selection(self, ref_selection):
        """Convert ref_selection string like 'ref_1', 'ref_2' to 0-based index"""
        if not ref_selection or ref_selection == 'no_ref':
            return 0
        try:
            # Extract number from 'ref_N' format
            if isinstance(ref_selection, str) and ref_selection.startswith('ref_'):
                parts = ref_selection.split('_')
                if len(parts) > 1:
                    idx = int(parts[1])
                    return max(0, idx - 1)  # Convert to 0-based index
        except (ValueError, IndexError):
            pass
        return 0

    def _compute_target_size(self, base_w, base_h, scale_factor, frame_width, frame_height, use_box_scale_size, editor_scale=1.0):
        if use_box_scale_size:
            # Match the editor's formula: box_radius = BOX_BASE_RADIUS * pointScale * canvasScale
            # BOX_BASE_RADIUS = 200, so diameter = 400 * pointScale * canvasScale
            # We map this from canvas space to video space using editor_scale
            adjusted_scale = scale_factor * editor_scale
            box_diameter = (BOX_BASE_RADIUS * 2) * adjusted_scale
            # Calculate the scale factor to fit the image within the box diameter
            # This matches the editor's: scale = Math.min(boxSize / imgW, boxSize / imgH)
            scale_w = box_diameter / max(1.0, base_w)
            scale_h = box_diameter / max(1.0, base_h)
            fit_scale = min(scale_w, scale_h)
            new_w = int(round(base_w * fit_scale))
            new_h = int(round(base_h * fit_scale))
        else:
            new_w = int(round(base_w * scale_factor))
            new_h = int(round(base_h * scale_factor))

        new_w = max(1, new_w)
        new_h = max(1, new_h)
        return new_w, new_h

    def _create_shadow(self, ref_img_width, ref_img_height, pos_x, pos_y, scale_factor):
        """
        Create a shadow image scaled horizontally to match ref_image width only.
        Shadow is positioned at the bottom center of the original (non-rotated) ref_image.
        Returns: (shadow_img, shadow_paste_x, shadow_paste_y) or None if shadow unavailable
        """
        if self.shadow_image is None:
            return None

        # Scale shadow to match ref_image width only (maintain original shadow height)
        shadow_orig_w, shadow_orig_h = self.shadow_image.size
        # Calculate height maintaining aspect ratio based on width scaling
        width_scale = ref_img_width / shadow_orig_w
        shadow_new_h = int(round(shadow_orig_h * width_scale))
        shadow_scaled = self.shadow_image.resize((ref_img_width, shadow_new_h), Image.LANCZOS)

        # Position shadow at the bottom center of the original ref_image position
        # The ref_img is centered at (pos_x, pos_y), so bottom center is at:
        # x: pos_x (horizontally centered)
        # y: pos_y + ref_img_height/2 (bottom of ref_img)
        # Then we need to center the shadow horizontally and align its top to ref_img bottom
        # Offset shadow upward slightly so it overlaps with the bottom of the ref_image
        shadow_offset_y = shadow_new_h * 0.5  # Offset by 50% of shadow height
        shadow_paste_x = int(round(pos_x - shadow_scaled.width / 2))
        shadow_paste_y = int(round(pos_y + ref_img_height / 2 - shadow_offset_y))

        return shadow_scaled, shadow_paste_x, shadow_paste_y

    def _normalize_frame_count(self, coords, total_frames):
        if not coords:
            return []
        if total_frames <= 0:
            return coords
        if len(coords) == total_frames:
            return coords
        if len(coords) > total_frames:
            return coords[:total_frames]
        # Pad with last coordinate if fewer than requested frames
        last = coords[-1]
        padded = list(coords)
        for _ in range(total_frames - len(coords)):
            padded.append(dict(last))
        return padded

    def _get_interpolated_point(self, coords, target_frame):
        """
        Get interpolated coordinates for a target frame using the 'frame' property.
        This matches the Power Spline Editor's box timeline interpolation logic.
        """
        if not coords:
            return None

        # Filter out coords without a frame property
        valid_coords = [c for c in coords if isinstance(c.get("frame"), (int, float))]
        if not valid_coords:
            # Fall back to first coordinate
            return coords[0] if coords else None

        # Sort by frame number
        sorted_coords = sorted(valid_coords, key=lambda c: float(c.get("frame", 0)))

        first = sorted_coords[0]
        last = sorted_coords[-1]
        first_frame = float(first.get("frame", 1))
        last_frame = float(last.get("frame", 1))

        # Clamp target frame to keyframe range
        if target_frame <= first_frame:
            return first
        if target_frame >= last_frame:
            return last

        # Find the two keyframes that bracket our target frame
        for i in range(len(sorted_coords) - 1):
            curr = sorted_coords[i]
            next_c = sorted_coords[i + 1]
            curr_frame = float(curr.get("frame", 0))
            next_frame = float(next_c.get("frame", 0))

            if curr_frame <= target_frame <= next_frame:
                # Exact match on current frame
                if target_frame == curr_frame:
                    return curr

                # Interpolate between curr and next_c
                if next_frame == curr_frame:
                    return curr

                t = (target_frame - curr_frame) / (next_frame - curr_frame)

                # Interpolate all numeric properties
                result = {}

                # Copy non-numeric properties as-is from curr
                for key, value in curr.items():
                    if key not in ("x", "y", "scale", "pointScale", "boxScale", "rotation", "boxR", "frame"):
                        result[key] = value

                # Interpolate numeric properties
                for prop in ("x", "y", "scale", "pointScale", "boxScale", "rotation", "boxR"):
                    curr_val = curr.get(prop)
                    next_val = next_c.get(prop)

                    if isinstance(curr_val, (int, float)) and isinstance(next_val, (int, float)):
                        result[prop] = curr_val + (next_val - curr_val) * t
                    elif isinstance(curr_val, (int, float)):
                        result[prop] = curr_val
                    elif isinstance(next_val, (int, float)):
                        result[prop] = next_val

                # Copy frame from target
                result["frame"] = target_frame

                return result

        # Shouldn't reach here, but return last as fallback
        return last

    def create(self, bg_image, ref_images, coordinates, ref_masks=None, use_box_rotation=True, use_box_scale_size=True,
               fallback_scale=1.0, overlay_opacity=1.0, frames=0, add_shadows=False, mask_fill=0.0, use_gpu=True, gpu_batch=8):
        try:
            overlay_opacity = max(0.0, min(1.0, float(overlay_opacity)))
        except (TypeError, ValueError):
            overlay_opacity = 1.0

        # Use GPU path if enabled and available
        if use_gpu and torch.cuda.is_available():
            return self._create_gpu(bg_image, ref_images, coordinates, ref_masks, use_box_rotation,
                                   use_box_scale_size, fallback_scale, overlay_opacity, frames,
                                   add_shadows, mask_fill, gpu_batch)

        # Parse coordinates and metadata
        coords, coord_width, coord_height, ref_selections, visibility, editor_scale = self._parse_coordinates(coordinates)
        if not coords:
            # Nothing to draw, return background and empty coords
            return bg_image, torch.zeros([bg_image.shape[0], bg_image.shape[1], bg_image.shape[2]], dtype=torch.float32)

        total_frames = int(frames) if frames is not None else 0
        if total_frames < 0:
            total_frames = 0

        # Check if we have multiple layers
        is_multiple_layers = isinstance(coords, list) and len(coords) > 0 and isinstance(coords[0], list)

        if is_multiple_layers:
            # Normalize each layer separately
            normalized_layers = []
            for layer_coords in coords:
                normalized = self._normalize_frame_count(layer_coords, total_frames)
                if normalized:
                    normalized_layers.append(normalized)
            coords = normalized_layers
            if not coords:
                return bg_image, torch.zeros([bg_image.shape[0], bg_image.shape[1], bg_image.shape[2]], dtype=torch.float32)
        else:
            coords = self._normalize_frame_count(coords, total_frames)
            if not coords:
                return bg_image, torch.zeros([bg_image.shape[0], bg_image.shape[1], bg_image.shape[2]], dtype=torch.float32)

        frame_width, frame_height = self._compute_frame_dimensions(bg_image)

        # Prepare PIL images
        bg_pils = tensor2pil(bg_image)

        # Build reference RGBA list from all ref_images, honoring input alpha
        # Note: ref_masks will be applied per-layer during rendering based on ref_selection
        # Also support 4-channel RGBA tensors to preserve PNG transparency
        ref_rgba_list = []
        try:
            # Check if we have RGBA data (4 channels) or just RGB (3 channels)
            # Shape can be [B, H, W, C] for batch or [H, W, C] for single image
            has_alpha_channel = False
            if ref_images.ndim == 4 and ref_images.shape[-1] == 4:
                # Batch with alpha: [B, H, W, 4]
                has_alpha_channel = True
                for i in range(ref_images.shape[0]):
                    img_tensor = ref_images[i]  # [H, W, 4]
                    # Split RGB and Alpha
                    rgb_array = np.clip(255.0 * img_tensor[:, :, :3].cpu().numpy(), 0, 255).astype(np.uint8)
                    alpha_array = np.clip(255.0 * img_tensor[:, :, 3].cpu().numpy(), 0, 255).astype(np.uint8)
                    # Create PIL images
                    rgb_pil = Image.fromarray(rgb_array)
                    alpha_pil = Image.fromarray(alpha_array, mode='L')
                    # Merge into RGBA
                    ref_rgba = rgb_pil.convert("RGBA")
                    ref_rgba.putalpha(alpha_pil)
                    ref_rgba_list.append(ref_rgba)
            elif ref_images.ndim == 3 and ref_images.shape[-1] == 4:
                # Single image with alpha: [H, W, 4]
                has_alpha_channel = True
                rgb_array = np.clip(255.0 * ref_images[:, :, :3].cpu().numpy(), 0, 255).astype(np.uint8)
                alpha_array = np.clip(255.0 * ref_images[:, :, 3].cpu().numpy(), 0, 255).astype(np.uint8)
                rgb_pil = Image.fromarray(rgb_array)
                alpha_pil = Image.fromarray(alpha_array, mode='L')
                ref_rgba = rgb_pil.convert("RGBA")
                ref_rgba.putalpha(alpha_pil)
                ref_rgba_list.append(ref_rgba)
            else:
                # Standard RGB handling (no alpha in tensor)
                if ref_images.ndim == 4:
                    # Batch of images
                    for i in range(ref_images.shape[0]):
                        ref_pils = tensor2pil(ref_images[i].unsqueeze(0))
                        if ref_pils:
                            ref_rgba = ref_pils[0].convert("RGBA")
                            ref_rgba_list.append(ref_rgba)
                else:
                    # Single image
                    ref_pils = tensor2pil(ref_images)
                    if ref_pils:
                        ref_rgba = ref_pils[0].convert("RGBA")
                        ref_rgba_list.append(ref_rgba)
        except Exception as e:
            print(f"Error loading ref_images: {e}")
            pass

        if not ref_rgba_list:
            return bg_image, torch.zeros([bg_image.shape[0], bg_image.shape[1], bg_image.shape[2]], dtype=torch.float32)

        frames = []
        mask_frames = []

        # Supersample factor for subpixel precision during scaling/positioning
        SUPERSAMPLE = 4

        if is_multiple_layers:
            # Process multiple layers - composite all layers for each frame
            num_frames = max(len(layer) for layer in coords) if coords else 0

            for frame_idx in range(num_frames):
                # Render at higher resolution for subpixel precision
                hi_width = frame_width * SUPERSAMPLE
                hi_height = frame_height * SUPERSAMPLE

                bg_src = bg_pils[min(frame_idx, len(bg_pils) - 1)] if bg_pils else None
                if bg_src:
                    bg_rgba = bg_src.convert("RGBA").resize((hi_width, hi_height), Image.LANCZOS)
                else:
                    bg_rgba = Image.new("RGBA", (hi_width, hi_height), (0, 0, 0, 255))
                # Use gray background for mask if mask_fill > 0.0
                mask_bg_value = int(mask_fill * 255) if mask_fill > 0.0 else 0
                mask_base = Image.new("L", (hi_width, hi_height), mask_bg_value)

                # Process each layer for this frame (reversed so top layers in list draw on top)
                for reversed_idx, layer_coords in enumerate(reversed(coords)):
                    if not layer_coords:
                        continue

                    # Use interpolation to get the correct point for this frame
                    # Coordinates already have per-frame data, so use frame index directly
                    point = self._get_interpolated_point(layer_coords, frame_idx + 1)
                    if point is None:
                        continue

                    # Get original layer index (before reversal) for ref_selections
                    layer_idx = len(coords) - 1 - reversed_idx

                    # Skip this layer if visibility is False
                    if visibility and layer_idx < len(visibility) and not visibility[layer_idx]:
                        continue

                    # Determine which ref_image to use for this layer
                    ref_selection = ref_selections[layer_idx] if layer_idx < len(ref_selections) else 'no_ref'
                    ref_idx = self._get_ref_index_from_selection(ref_selection)
                    ref_idx = min(ref_idx, len(ref_rgba_list) - 1)

                    # Get the base reference image for this layer
                    base_ref = ref_rgba_list[ref_idx]
                    base_w, base_h = base_ref.size

                    pos_x, pos_y = self._scale_point(point, frame_width, frame_height, coord_width, coord_height)
                    scale_factor = self._get_scale(point, fallback_scale)
                    new_w, new_h = self._compute_target_size(
                        base_w, base_h, scale_factor, frame_width, frame_height, use_box_scale_size, editor_scale
                    )
                    # Scale image size by SUPERSAMPLE for subpixel precision
                    new_w = new_w * SUPERSAMPLE
                    new_h = new_h * SUPERSAMPLE
                    ref_img = base_ref.resize((new_w, new_h), Image.LANCZOS)
                    mask_img = None

                    # Apply mask to ref_img alpha channel based on ref_idx
                    # If no ref_masks, the original alpha from ref_images (e.g., PNG transparency) is preserved
                    if ref_masks is not None:
                        try:
                            # Handle both batch and single mask tensors
                            # Masks can be shape [B, H, W] or [H, W]
                            if ref_masks.ndim == 3 and ref_idx < ref_masks.shape[0]:
                                # Batch of masks [B, H, W]
                                mask_tensor = ref_masks[ref_idx]
                            elif ref_masks.ndim == 2:
                                # Single mask [H, W]
                                mask_tensor = ref_masks
                            elif ref_masks.ndim == 4 and ref_idx < ref_masks.shape[0]:
                                # Sometimes masks are [B, H, W, 1]
                                mask_tensor = ref_masks[ref_idx].squeeze(-1) if ref_masks.shape[-1] == 1 else ref_masks[ref_idx]
                            else:
                                mask_tensor = None

                            if mask_tensor is not None:
                                mask_arr = np.clip(mask_tensor.cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
                                mask_pil = Image.fromarray(mask_arr, mode="L")
                                # Resize mask to match ref_img size (supersampled)
                                mask_resized = mask_pil.resize((new_w, new_h), Image.LANCZOS)
                                # Don't invert mask - use it directly
                                # Multiply ref_mask with existing alpha channel from ref_img (preserves PNG transparency)
                                r, g, b, original_alpha = ref_img.split()
                                # Combine original alpha with mask by multiplying them
                                mask_arr_float = np.array(mask_resized).astype(np.float32) / 255.0
                                original_alpha_arr = np.array(original_alpha).astype(np.float32) / 255.0
                                combined_alpha_arr = np.clip(mask_arr_float * original_alpha_arr * 255.0, 0, 255).astype(np.uint8)
                                combined_alpha = Image.fromarray(combined_alpha_arr, mode="L")
                                ref_img = Image.merge("RGBA", (r, g, b, combined_alpha))
                                # Store mask for mask output without inversion
                                mask_img = mask_resized
                        except Exception as e:
                            print(f"Error applying mask: {e}, mask shape: {ref_masks.shape if ref_masks is not None else 'None'}, ref_idx: {ref_idx}")
                            pass

                    if overlay_opacity < 1.0:
                        r, g, b, a = ref_img.split()
                        a = a.point(lambda v: int(v * float(overlay_opacity)))
                        ref_img = Image.merge("RGBA", (r, g, b, a))

                    rotation_rad = 0.0
                    if use_box_rotation:
                        try:
                            rotation_rad = float(point.get("boxR", 0.0) or 0.0)
                        except (TypeError, ValueError):
                            rotation_rad = 0.0
                    rotation_deg = -math.degrees(rotation_rad)

                    if abs(rotation_deg) > 1e-4:
                        ref_img = ref_img.rotate(rotation_deg, resample=Image.Resampling.BICUBIC, expand=True)
                        if mask_img is not None:
                            mask_img = mask_img.rotate(rotation_deg, resample=Image.Resampling.BICUBIC, expand=True)

                    # Use float positions at supersampled resolution for subpixel precision
                    paste_x = int(round(pos_x * SUPERSAMPLE - ref_img.width / 2))
                    paste_y = int(round(pos_y * SUPERSAMPLE - ref_img.height / 2))

                    # Add shadow if enabled (before ref_img, behind it)
                    if add_shadows:
                        shadow_result = self._create_shadow(new_w, new_h, pos_x * SUPERSAMPLE, pos_y * SUPERSAMPLE, scale_factor)
                        if shadow_result is not None:
                            shadow_img, shadow_paste_x, shadow_paste_y = shadow_result
                            bg_rgba.alpha_composite(shadow_img, dest=(shadow_paste_x, shadow_paste_y))

                    bg_rgba.alpha_composite(ref_img, dest=(paste_x, paste_y))

                    if mask_img is not None:
                        mask_base.paste(mask_img, box=(paste_x, paste_y), mask=mask_img)

                # Downsample to final resolution
                frames.append(bg_rgba.resize((frame_width, frame_height), Image.LANCZOS).convert("RGB"))
                mask_frames.append(mask_base.resize((frame_width, frame_height), Image.LANCZOS))

        else:
            # Process single layer
            # Check if this single layer is visible
            layer_visible = True
            if visibility and len(visibility) > 0:
                layer_visible = visibility[0]

            # If layer is not visible, return background unchanged
            if not layer_visible:
                return bg_image, torch.zeros([bg_image.shape[0], bg_image.shape[1], bg_image.shape[2]], dtype=torch.float32)

            for idx, point in enumerate(coords):
                # Render at higher resolution for subpixel precision
                hi_width = frame_width * SUPERSAMPLE
                hi_height = frame_height * SUPERSAMPLE

                bg_src = bg_pils[min(idx, len(bg_pils) - 1)] if bg_pils else None
                if bg_src:
                    bg_rgba = bg_src.convert("RGBA").resize((hi_width, hi_height), Image.LANCZOS)
                else:
                    bg_rgba = Image.new("RGBA", (hi_width, hi_height), (0, 0, 0, 255))
                # Use gray background for mask if mask_fill > 0.0
                mask_bg_value = int(mask_fill * 255) if mask_fill > 0.0 else 0
                mask_base = Image.new("L", (hi_width, hi_height), mask_bg_value)

                # For single layer, use first ref_selection
                ref_selection = ref_selections[0] if ref_selections else 'no_ref'
                ref_idx = self._get_ref_index_from_selection(ref_selection)
                ref_idx = min(ref_idx, len(ref_rgba_list) - 1)

                base_ref = ref_rgba_list[ref_idx]
                base_w, base_h = base_ref.size

                pos_x, pos_y = self._scale_point(point, frame_width, frame_height, coord_width, coord_height)
                scale_factor = self._get_scale(point, fallback_scale)

                new_w, new_h = self._compute_target_size(
                    base_w, base_h, scale_factor, frame_width, frame_height, use_box_scale_size, editor_scale
                )
                # Scale image size by SUPERSAMPLE for subpixel precision
                new_w = new_w * SUPERSAMPLE
                new_h = new_h * SUPERSAMPLE
                ref_img = base_ref.resize((new_w, new_h), Image.LANCZOS)
                mask_img = None

                # Apply mask to ref_img alpha channel based on ref_idx
                # If no ref_masks, the original alpha from ref_images (e.g., PNG transparency) is preserved
                if ref_masks is not None:
                    try:
                        # Handle both batch and single mask tensors
                        # Masks can be shape [B, H, W] or [H, W]
                        if ref_masks.ndim == 3 and ref_idx < ref_masks.shape[0]:
                            # Batch of masks [B, H, W]
                            mask_tensor = ref_masks[ref_idx]
                        elif ref_masks.ndim == 2:
                            # Single mask [H, W]
                            mask_tensor = ref_masks
                        elif ref_masks.ndim == 4 and ref_idx < ref_masks.shape[0]:
                            # Sometimes masks are [B, H, W, 1]
                            mask_tensor = ref_masks[ref_idx].squeeze(-1) if ref_masks.shape[-1] == 1 else ref_masks[ref_idx]
                        else:
                            mask_tensor = None

                        if mask_tensor is not None:
                            mask_arr = np.clip(mask_tensor.cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
                            mask_pil = Image.fromarray(mask_arr, mode="L")
                            # Resize mask to match ref_img size (supersampled)
                            mask_resized = mask_pil.resize((new_w, new_h), Image.LANCZOS)
                            # Don't invert mask - use it directly
                            # Multiply ref_mask with existing alpha channel from ref_img (preserves PNG transparency)
                            r, g, b, original_alpha = ref_img.split()
                            # Combine original alpha with mask by multiplying them
                            mask_arr_float = np.array(mask_resized).astype(np.float32) / 255.0
                            original_alpha_arr = np.array(original_alpha).astype(np.float32) / 255.0
                            combined_alpha_arr = np.clip(mask_arr_float * original_alpha_arr * 255.0, 0, 255).astype(np.uint8)
                            combined_alpha = Image.fromarray(combined_alpha_arr, mode="L")
                            ref_img = Image.merge("RGBA", (r, g, b, combined_alpha))
                            # Store mask for mask output without inversion
                            mask_img = mask_resized
                    except Exception as e:
                        print(f"Error applying mask: {e}, mask shape: {ref_masks.shape if ref_masks is not None else 'None'}, ref_idx: {ref_idx}")
                        pass

                if overlay_opacity < 1.0:
                    r, g, b, a = ref_img.split()
                    a = a.point(lambda v: int(v * float(overlay_opacity)))
                    ref_img = Image.merge("RGBA", (r, g, b, a))

                rotation_rad = 0.0
                if use_box_rotation:
                    try:
                        rotation_rad = float(point.get("boxR", 0.0) or 0.0)
                    except (TypeError, ValueError):
                        rotation_rad = 0.0
                rotation_deg = -math.degrees(rotation_rad)

                if abs(rotation_deg) > 1e-4:
                    ref_img = ref_img.rotate(rotation_deg, resample=Image.Resampling.BICUBIC, expand=True)
                    if mask_img is not None:
                        mask_img = mask_img.rotate(rotation_deg, resample=Image.Resampling.BICUBIC, expand=True)

                # Use float positions at supersampled resolution for subpixel precision
                paste_x = int(round(pos_x * SUPERSAMPLE - ref_img.width / 2))
                paste_y = int(round(pos_y * SUPERSAMPLE - ref_img.height / 2))

                frame_image = bg_rgba.copy()

                # Add shadow if enabled (before ref_img, behind it)
                if add_shadows:
                    shadow_result = self._create_shadow(new_w, new_h, pos_x * SUPERSAMPLE, pos_y * SUPERSAMPLE, scale_factor)
                    if shadow_result is not None:
                        shadow_img, shadow_paste_x, shadow_paste_y = shadow_result
                        frame_image.alpha_composite(shadow_img, dest=(shadow_paste_x, shadow_paste_y))

                frame_image.alpha_composite(ref_img, dest=(paste_x, paste_y))
                # Downsample to final resolution
                frames.append(frame_image.resize((frame_width, frame_height), Image.LANCZOS).convert("RGB"))

                if mask_img is not None:
                    mask_frame = mask_base.copy()
                    mask_frame.paste(mask_img, box=(paste_x, paste_y), mask=mask_img)
                    mask_frames.append(mask_frame.resize((frame_width, frame_height), Image.LANCZOS))
                else:
                    mask_frames.append(mask_base.resize((frame_width, frame_height), Image.LANCZOS))

        output_tensor = torch.cat([pil2tensor(frame) for frame in frames], dim=0)
        output_tensor = torch.clamp(output_tensor, 0.0, 1.0)

        if mask_frames:
            mask_tensors = []
            for m in mask_frames:
                arr = np.array(m).astype(np.float32) / 255.0
                mask_tensors.append(torch.from_numpy(arr))
            mask_tensor = torch.stack(mask_tensors, dim=0).float()
        else:
            mask_tensor = torch.zeros([output_tensor.shape[0], frame_height, frame_width], dtype=torch.float32)

        return output_tensor, mask_tensor

    def _create_gpu(self, bg_image, ref_images, coordinates, ref_masks, use_box_rotation, use_box_scale_size,
                    fallback_scale, overlay_opacity, frames, add_shadows=False, mask_fill=0.0, gpu_batch=8):
        """GPU-accelerated rendering using torch operations with batched processing to avoid OOM."""
        device = torch.device('cuda')

        # Parse coordinates and metadata
        coords, coord_width, coord_height, ref_selections, visibility, editor_scale = self._parse_coordinates(coordinates)
        if not coords:
            empty_mask = torch.zeros([bg_image.shape[0], bg_image.shape[1], bg_image.shape[2]], dtype=torch.float32, device='cpu')
            return bg_image, empty_mask

        total_frames = int(frames) if frames is not None else 0
        if total_frames < 0:
            total_frames = 0

        is_multiple_layers = isinstance(coords, list) and len(coords) > 0 and isinstance(coords[0], list)

        frame_width, frame_height = self._compute_frame_dimensions(bg_image)

        # Prepare reference images as tensors on CPU (keep off GPU to save memory)
        ref_tensors_cpu = self._prepare_ref_images_gpu(ref_images, torch.device('cpu'))

        if not ref_tensors_cpu:
            return bg_image, torch.zeros([bg_image.shape[0], frame_height, frame_width], dtype=torch.float32)

        # Keep background on CPU
        bg_cpu = bg_image.to('cpu')

        if is_multiple_layers:
            return self._render_multiple_layers_gpu_batched(
                coords, coord_width, coord_height, ref_selections, visibility, editor_scale,
                total_frames, frame_width, frame_height, ref_tensors_cpu, ref_masks,
                use_box_rotation, use_box_scale_size, fallback_scale, overlay_opacity,
                add_shadows, mask_fill, bg_cpu, device, gpu_batch
            )
        else:
            return self._render_single_layer_gpu_batched(
                coords, coord_width, coord_height, ref_selections, visibility, editor_scale,
                total_frames, frame_width, frame_height, ref_tensors_cpu, ref_masks,
                use_box_rotation, use_box_scale_size, fallback_scale, overlay_opacity,
                add_shadows, mask_fill, bg_cpu, device, gpu_batch
            )

    def _prepare_ref_images_gpu(self, ref_images, device):
        """Convert reference images to GPU tensors with alpha channel."""
        tensors = []
        try:
            # Check if we have RGBA data (4 channels)
            if ref_images.ndim == 4 and ref_images.shape[-1] == 4:
                for i in range(ref_images.shape[0]):
                    img = ref_images[i].to(device)
                    tensors.append(img)  # [H, W, 4]
            elif ref_images.ndim == 3 and ref_images.shape[-1] == 4:
                tensors.append(ref_images.to(device))
            else:
                # Convert RGB to RGBA
                if ref_images.ndim == 4:
                    for i in range(ref_images.shape[0]):
                        rgb = ref_images[i].to(device)  # [H, W, 3]
                        alpha = torch.ones((rgb.shape[0], rgb.shape[1], 1), device=device, dtype=rgb.dtype)
                        rgba = torch.cat([rgb, alpha], dim=2)  # [H, W, 4]
                        tensors.append(rgba)
                else:
                    rgb = ref_images.to(device)
                    alpha = torch.ones((rgb.shape[0], rgb.shape[1], 1), device=device, dtype=rgb.dtype)
                    rgba = torch.cat([rgb, alpha], dim=2)
                    tensors.append(rgba)
        except Exception as e:
            print(f"Error preparing ref images for GPU: {e}")
            return []
        return tensors

    def _render_single_layer_gpu_batched(self, coords, coord_width, coord_height, ref_selections, visibility, editor_scale,
                                         total_frames, frame_width, frame_height, ref_tensors_cpu, ref_masks,
                                         use_box_rotation, use_box_scale_size, fallback_scale, overlay_opacity,
                                         add_shadows, mask_fill, bg_cpu, device, gpu_batch=8):
        """Render single layer on GPU with batched processing to avoid OOM."""
        # Treat as single layer in multi-layer format
        coords_wrapped = [coords] if coords else []
        ref_selections_wrapped = ref_selections if isinstance(ref_selections, list) else [ref_selections or 'no_ref']
        visibility_wrapped = visibility if isinstance(visibility, list) else [visibility] if visibility is not None else []

        return self._render_multiple_layers_gpu_batched(
            coords_wrapped, coord_width, coord_height, ref_selections_wrapped, visibility_wrapped, editor_scale,
            total_frames, frame_width, frame_height, ref_tensors_cpu, ref_masks,
            use_box_rotation, use_box_scale_size, fallback_scale, overlay_opacity,
            add_shadows, mask_fill, bg_cpu, device, gpu_batch
        )

    def _render_multiple_layers_gpu_batched(self, coords, coord_width, coord_height, ref_selections, visibility, editor_scale,
                                            total_frames, frame_width, frame_height, ref_tensors_cpu, ref_masks,
                                            use_box_rotation, use_box_scale_size, fallback_scale, overlay_opacity,
                                            add_shadows, mask_fill, bg_cpu, device, gpu_batch=8):
        """Render multiple layers on GPU with batched processing for memory efficiency."""
        if not coords:
            empty_mask = torch.zeros([bg_cpu.shape[0], frame_height, frame_width], dtype=torch.float32, device='cpu')
            return bg_cpu, empty_mask

        # Determine actual number of frames
        num_frames = max(len(layer) for layer in coords) if coords else 0
        if num_frames == 0:
            return bg_cpu, torch.zeros([bg_cpu.shape[0], frame_height, frame_width], dtype=torch.float32)

        # Determine batch size (clamp between 1 and num_frames)
        batch_size = max(1, min(gpu_batch, num_frames))

        # Preallocate output tensors on CPU
        all_frames = []
        all_masks = []

        # Process in batches
        for batch_start in range(0, num_frames, batch_size):
            batch_end = min(batch_start + batch_size, num_frames)
            current_batch_size = batch_end - batch_start

            # Clear CUDA cache before processing batch
            torch.cuda.empty_cache()

            # Move reference tensors to GPU for this batch
            ref_tensors = [t.to(device) for t in ref_tensors_cpu]

            # Move background batch to GPU
            if bg_cpu.shape[0] == 1:
                bg_batch = bg_cpu.repeat(current_batch_size, 1, 1, 1).to(device)
            else:
                bg_batch = bg_cpu[batch_start:batch_end].to(device)

            # Extract coordinate batch for each layer
            # Use interpolation to get correct coordinates for each frame in the batch
            coords_batch = []
            for layer_coords in coords:
                batch_coords = []
                for i in range(current_batch_size):
                    actual_frame = batch_start + i + 1  # Frames are 1-indexed
                    # Coordinates already have per-frame data, so use frame directly
                    point = self._get_interpolated_point(layer_coords, actual_frame)
                    if point is None:
                        # Create a default point if interpolation fails
                        point = {"x": 0.5, "y": 0.5, "scale": 1, "frame": actual_frame}
                    batch_coords.append(point)
                coords_batch.append(batch_coords)

            # Render this batch using the existing GPU method
            output_batch, mask_batch = self._render_multiple_layers_gpu(
                coords_batch, coord_width, coord_height, ref_selections, visibility, editor_scale,
                current_batch_size, frame_width, frame_height, ref_tensors, ref_masks,
                use_box_rotation, use_box_scale_size, fallback_scale, overlay_opacity,
                add_shadows, mask_fill, bg_batch, device
            )

            # Move results back to CPU and accumulate
            all_frames.append(output_batch.cpu())
            all_masks.append(mask_batch.cpu())

            # Delete GPU tensors to free memory
            del ref_tensors, bg_batch, output_batch, mask_batch
            torch.cuda.empty_cache()

        # Concatenate all batches
        final_output = torch.cat(all_frames, dim=0)
        final_mask = torch.cat(all_masks, dim=0)

        return final_output, final_mask

    def _render_multiple_layers_gpu(self, coords, coord_width, coord_height, ref_selections, visibility, editor_scale,
                                    total_frames, frame_width, frame_height, ref_tensors, ref_masks,
                                    use_box_rotation, use_box_scale_size, fallback_scale, overlay_opacity,
                                    add_shadows, mask_fill, bg_gpu, device):
        """Render multiple layers on GPU with supersampling for smooth scaling."""
        # Supersampled dimensions for subpixel precision
        hi_width = frame_width * SUPERSAMPLE
        hi_height = frame_height * SUPERSAMPLE

        # Normalize layers
        num_frames = max(len(layer) for layer in coords) if coords else 0

        # Create background frames at supersampled resolution
        bg_upsampled = F.interpolate(
            bg_gpu.permute(0, 3, 1, 2),  # [B, C, H, W]
            size=(hi_height, hi_width),
            mode='bilinear',
            align_corners=False
        ).permute(0, 2, 3, 1)  # [B, H, W, C]

        if bg_upsampled.shape[0] == 1:
            bg_frames = bg_upsampled.repeat(num_frames, 1, 1, 1)
        else:
            bg_frames = bg_upsampled[:num_frames]

        # Create RGBA canvas at supersampled resolution
        composite_rgba = torch.cat([bg_frames,
                                    torch.ones_like(bg_frames[..., :1])], dim=-1)  # [F, H, W, 4]

        # Mask canvas at supersampled resolution
        mask_bg_value = mask_fill
        mask_frames_base = torch.full((num_frames, hi_height, hi_width), mask_bg_value,
                                     dtype=torch.float32, device=device)

        # Process all layers and composite
        for reversed_idx, layer_coords in enumerate(reversed(coords)):
            layer_idx = len(coords) - 1 - reversed_idx

            # Check visibility
            if visibility and layer_idx < len(visibility) and not visibility[layer_idx]:
                continue

            # Get ref selection
            ref_selection = ref_selections[layer_idx] if layer_idx < len(ref_selections) else 'no_ref'
            ref_idx = self._get_ref_index_from_selection(ref_selection)
            ref_idx = min(ref_idx, len(ref_tensors) - 1)

            ref_tensor = ref_tensors[ref_idx]  # [H, W, 4]
            base_h, base_w = ref_tensor.shape[0], ref_tensor.shape[1]

            # Process all frames for this layer
            for frame_idx in range(num_frames):
                if frame_idx >= len(layer_coords):
                    continue

                point = layer_coords[frame_idx]
                pos_x, pos_y = self._scale_point(point, frame_width, frame_height, coord_width, coord_height)
                scale_factor = self._get_scale(point, fallback_scale)

                # Compute target size (will be scaled by SUPERSAMPLE)
                if use_box_scale_size:
                    adjusted_scale = scale_factor * editor_scale
                    box_diameter = (BOX_BASE_RADIUS * 2) * adjusted_scale
                    scale_w = box_diameter / max(1.0, base_w)
                    scale_h = box_diameter / max(1.0, base_h)
                    fit_scale = min(scale_w, scale_h)
                    new_w = int(round(base_w * fit_scale * SUPERSAMPLE))
                    new_h = int(round(base_h * fit_scale * SUPERSAMPLE))
                else:
                    new_w = int(round(base_w * scale_factor * SUPERSAMPLE))
                    new_h = int(round(base_h * scale_factor * SUPERSAMPLE))

                new_w = max(1, new_w)
                new_h = max(1, new_h)

                # Resize reference image using GPU
                ref_resized = F.interpolate(
                    ref_tensor.permute(2, 0, 1).unsqueeze(0),  # [1, 4, H, W]
                    size=(new_h, new_w),
                    mode='bilinear',
                    align_corners=False
                ).squeeze(0).permute(1, 2, 0)  # [H, W, 4]

                # Apply ref mask if provided
                if ref_masks is not None:
                    mask_tensor = self._get_ref_mask_tensor(ref_masks, ref_idx, device)
                    if mask_tensor is not None:
                        mask_resized = F.interpolate(
                            mask_tensor.unsqueeze(0).unsqueeze(0),  # [1, 1, H, W]
                            size=(new_h, new_w),
                            mode='bilinear',
                            align_corners=False
                        ).squeeze()  # [H, W]
                        # Multiply alpha channel
                        ref_resized[..., 3] = ref_resized[..., 3] * mask_resized

                # Apply overlay opacity
                if overlay_opacity < 1.0:
                    ref_resized[..., 3] = ref_resized[..., 3] * overlay_opacity

                # Handle rotation
                rotation_rad = 0.0
                if use_box_rotation:
                    try:
                        rotation_rad = float(point.get("boxR", 0.0) or 0.0)
                    except (TypeError, ValueError):
                        pass

                if abs(rotation_rad) > 1e-4:
                    ref_resized = self._rotate_image_gpu(ref_resized, rotation_rad)

                # Composite onto canvas with supersampled positions
                composite_rgba[frame_idx] = self._composite_image_gpu(
                    composite_rgba[frame_idx], ref_resized,
                    pos_x * SUPERSAMPLE, pos_y * SUPERSAMPLE,
                    hi_width, hi_height
                )

        # Downsample to final resolution
        output = F.interpolate(
            composite_rgba[..., :3].permute(0, 3, 1, 2),  # [F, C, H, W]
            size=(frame_height, frame_width),
            mode='bilinear',
            align_corners=False
        ).permute(0, 2, 3, 1)  # [F, H, W, C]

        # Downsample masks
        mask_output = F.interpolate(
            mask_frames_base.unsqueeze(1),  # [F, 1, H, W]
            size=(frame_height, frame_width),
            mode='bilinear',
            align_corners=False
        ).squeeze(1)  # [F, H, W]

        # Move back to CPU
        return output.to('cpu'), mask_output.to('cpu')

    def _get_ref_mask_tensor(self, ref_masks, ref_idx, device):
        """Get reference mask as tensor on GPU."""
        try:
            if ref_masks.ndim == 3 and ref_idx < ref_masks.shape[0]:
                return ref_masks[ref_idx].to(device)
            elif ref_masks.ndim == 2:
                return ref_masks.to(device)
            elif ref_masks.ndim == 4 and ref_idx < ref_masks.shape[0]:
                mask = ref_masks[ref_idx]
                if mask.shape[-1] == 1:
                    return mask.squeeze(-1).to(device)
                return mask.to(device)
        except Exception as e:
            print(f"Error getting ref mask tensor: {e}")
        return None

    def _rotate_image_gpu(self, img_tensor, angle_rad):
        """Rotate image tensor by angle (radians) on GPU."""
        angle_deg = -math.degrees(angle_rad)

        # Simple rotation using torch (for small angles, approximation)
        # For proper rotation, we'd use grid_sample with rotation matrix
        cos_a = math.cos(angle_rad)
        sin_a = math.sin(angle_rad)

        h, w = img_tensor.shape[:2]

        # Create rotation matrix
        # Center the image, rotate, then uncenter
        cx, cy = w / 2.0, h / 2.0

        # Create grid for sampling
        y_coords = torch.arange(h, dtype=torch.float32, device=img_tensor.device)
        x_coords = torch.arange(w, dtype=torch.float32, device=img_tensor.device)
        try:
            yy, xx = torch.meshgrid(y_coords, x_coords, indexing='ij')
        except TypeError:
            # Older PyTorch versions don't support indexing parameter
            yy, xx = torch.meshgrid(y_coords, x_coords)
            yy, xx = yy.transpose(0, 1), xx.transpose(0, 1)  # Swap to get 'ij' indexing

        # Normalize to [-1, 1]
        yy_norm = (yy - cy) / cy
        xx_norm = (xx - cx) / cx

        # Apply rotation
        xx_rot = xx_norm * cos_a - yy_norm * sin_a
        yy_rot = xx_norm * sin_a + yy_norm * cos_a

        # Denormalize
        xx_rot = xx_rot * cx + cx
        yy_rot = yy_rot * cy + cy

        # Normalize for grid_sample [-1, 1]
        xx_rot = 2.0 * xx_rot / (w - 1) - 1.0
        yy_rot = 2.0 * yy_rot / (h - 1) - 1.0

        grid = torch.stack([xx_rot, yy_rot], dim=-1).unsqueeze(0)

        # Apply rotation to each channel
        rotated = F.grid_sample(
            img_tensor.permute(2, 0, 1).unsqueeze(0),  # [1, 4, H, W]
            grid,
            mode='bilinear',
            padding_mode='zeros',
            align_corners=True
        ).squeeze(0).permute(1, 2, 0)  # [H, W, 4]

        return rotated

    def _composite_image_gpu(self, canvas, img, pos_x, pos_y, canvas_w, canvas_h):
        """Composite image onto canvas at position (pos_x, pos_y) using subpixel precision."""
        img_h, img_w = img.shape[:2]

        # Calculate paste position (center aligned)
        start_x = int(round(pos_x - img_w / 2))
        start_y = int(round(pos_y - img_h / 2))
        end_x = start_x + img_w
        end_y = start_y + img_h

        # Clamp to canvas bounds
        x_start = max(0, start_x)
        y_start = max(0, start_y)
        x_end = min(canvas_w, end_x)
        y_end = min(canvas_h, end_y)

        if x_end <= x_start or y_end <= y_start:
            return canvas

        # Calculate corresponding regions in image
        img_x_start = x_start - start_x
        img_y_start = y_start - start_y
        img_x_end = img_x_start + (x_end - x_start)
        img_y_end = img_y_start + (y_end - y_start)

        # Get image region
        img_region = img[img_y_start:img_y_end, img_x_start:img_x_end, :]  # [H, W, 4]

        # Get canvas region
        canvas_region = canvas[y_start:y_end, x_start:x_end, :]  # [H, W, 4]

        # Alpha blend
        alpha = img_region[..., 3:4]  # [H, W, 1]
        rgb = img_region[..., :3]  # [H, W, 3]

        # Blend: canvas = canvas * (1 - alpha) + img * alpha
        blended = canvas_region[..., :3] * (1 - alpha) + rgb * alpha

        # Update canvas
        canvas[y_start:y_end, x_start:x_end, :3] = blended
        canvas[y_start:y_end, x_start:x_end, 3] = torch.maximum(
            canvas_region[..., 3],
            alpha[..., 0]
        )

        return canvas
