
import json
import math
import numpy as np
import os

import torch
from PIL import Image

from ..utility.utility import pil2tensor, tensor2pil
from ..config.constants import BOX_BASE_SIZE


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
                "ref_images": ("IMAGE", ),
            },
            "optional": {
                "ref_masks": ("MASK", ),
                "frames": ("INT", {"default": 0, "min": 0, "max": 10000, "step": 1}),
                "use_box_rotation": ("BOOLEAN", {"default": True}),
                "use_box_scale_size": ("BOOLEAN", {"default": True}),
                "fallback_scale": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 100.0, "step": 0.01}),
                "overlay_opacity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "add_shadows": ("BOOLEAN", {"default": False}),
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
            # Apply editor_scale to match what was shown in the Power Spline Editor canvas
            # The editor displays boxes at: BOX_BASE_RADIUS * scale * editor_scale
            # So the final size should be: BOX_BASE_SIZE * scale * editor_scale
            adjusted_scale = scale_factor * editor_scale
            target_short = BOX_BASE_SIZE * adjusted_scale
            ratio = target_short / max(1.0, min(base_w, base_h))
            new_w = int(round(base_w * ratio))
            new_h = int(round(base_h * ratio))
        else:
            new_w = int(round(base_w * scale_factor))
            new_h = int(round(base_h * scale_factor))

        max_size_fraction = 1.0
        max_w = int(frame_width * max_size_fraction)
        max_h = int(frame_height * max_size_fraction)
        if new_w > max_w or new_h > max_h:
            clamp_ratio = min(max_w / max(1, new_w), max_h / max(1, new_h))
            new_w = max(1, int(new_w * clamp_ratio))
            new_h = max(1, int(new_h * clamp_ratio))

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

    def create(self, bg_image, ref_images, coordinates, ref_masks=None, use_box_rotation=True, use_box_scale_size=True,
               fallback_scale=1.0, overlay_opacity=1.0, frames=0, add_shadows=False):
        try:
            overlay_opacity = max(0.0, min(1.0, float(overlay_opacity)))
        except (TypeError, ValueError):
            overlay_opacity = 1.0
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

        if is_multiple_layers:
            # Process multiple layers - composite all layers for each frame
            num_frames = max(len(layer) for layer in coords) if coords else 0

            for frame_idx in range(num_frames):
                bg_src = bg_pils[min(frame_idx, len(bg_pils) - 1)] if bg_pils else None
                bg_rgba = bg_src.convert("RGBA") if bg_src else Image.new("RGBA", (frame_width, frame_height), (0, 0, 0, 255))
                mask_base = Image.new("L", (frame_width, frame_height), 0)

                # Process each layer for this frame (reversed so top layers in list draw on top)
                for reversed_idx, layer_coords in enumerate(reversed(coords)):
                    if frame_idx >= len(layer_coords):
                        continue

                    point = layer_coords[frame_idx]

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
                                # Resize mask to match ref_img size
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
                        ref_img = ref_img.rotate(rotation_deg, expand=True)
                        if mask_img is not None:
                            mask_img = mask_img.rotate(rotation_deg, expand=True)

                    paste_x = int(round(pos_x - ref_img.width / 2))
                    paste_y = int(round(pos_y - ref_img.height / 2))

                    # Add shadow if enabled (before ref_img, behind it)
                    if add_shadows:
                        shadow_result = self._create_shadow(new_w, new_h, pos_x, pos_y, scale_factor)
                        if shadow_result is not None:
                            shadow_img, shadow_paste_x, shadow_paste_y = shadow_result
                            bg_rgba.alpha_composite(shadow_img, dest=(shadow_paste_x, shadow_paste_y))

                    bg_rgba.alpha_composite(ref_img, dest=(paste_x, paste_y))

                    if mask_img is not None:
                        mask_base.paste(mask_img, box=(paste_x, paste_y), mask=mask_img)

                frames.append(bg_rgba.convert("RGB"))
                mask_frames.append(mask_base)

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
                bg_src = bg_pils[min(idx, len(bg_pils) - 1)] if bg_pils else None
                bg_rgba = bg_src.convert("RGBA") if bg_src else Image.new("RGBA", (frame_width, frame_height), (0, 0, 0, 255))
                mask_base = Image.new("L", (frame_width, frame_height), 0)

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
                            # Resize mask to match ref_img size
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
                    ref_img = ref_img.rotate(rotation_deg, expand=True)
                    if mask_img is not None:
                        mask_img = mask_img.rotate(rotation_deg, expand=True)

                paste_x = int(round(pos_x - ref_img.width / 2))
                paste_y = int(round(pos_y - ref_img.height / 2))

                frame_image = bg_rgba.copy()

                # Add shadow if enabled (before ref_img, behind it)
                if add_shadows:
                    shadow_result = self._create_shadow(new_w, new_h, pos_x, pos_y, scale_factor)
                    if shadow_result is not None:
                        shadow_img, shadow_paste_x, shadow_paste_y = shadow_result
                        frame_image.alpha_composite(shadow_img, dest=(shadow_paste_x, shadow_paste_y))

                frame_image.alpha_composite(ref_img, dest=(paste_x, paste_y))
                frames.append(frame_image.convert("RGB"))

                if mask_img is not None:
                    mask_frame = mask_base.copy()
                    mask_frame.paste(mask_img, box=(paste_x, paste_y), mask=mask_img)
                    mask_frames.append(mask_frame)
                else:
                    mask_frames.append(mask_base)

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
