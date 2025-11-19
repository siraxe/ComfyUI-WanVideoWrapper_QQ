
import json
import math
import numpy as np

import torch
from PIL import Image

from ..utility.utility import pil2tensor, tensor2pil

# Match Power Spline box sizing reference (radius 56 -> diameter 112)
DEFAULT_BOX_BASE_SIZE = 112.0


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
            }
        }

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
        try:
            parsed = self._safe_json_load(coordinates_str)
            if isinstance(parsed, dict):
                coords = parsed.get("coordinates") or parsed.get("box_coordinates") or []
                coord_width = parsed.get("coord_width")
                coord_height = parsed.get("coord_height")
            elif isinstance(parsed, list):
                coords = parsed
        except Exception:
            pass
        cleaned = []
        for c in coords or []:
            if isinstance(c, dict) and "x" in c and "y" in c:
                cleaned.append(c)
        if cleaned and all(isinstance(c.get("frame", None), (int, float)) for c in cleaned):
            cleaned = sorted(cleaned, key=lambda item: float(item.get("frame", 0)))
        return cleaned, coord_width, coord_height

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

    def _compute_target_size(self, base_w, base_h, scale_factor, frame_width, frame_height, use_box_scale_size):
        if use_box_scale_size:
            target_short = DEFAULT_BOX_BASE_SIZE * scale_factor
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
               fallback_scale=1.0, overlay_opacity=1.0, frames=0):
        try:
            overlay_opacity = max(0.0, min(1.0, float(overlay_opacity)))
        except (TypeError, ValueError):
            overlay_opacity = 1.0
        # Parse coordinates and metadata
        coords, coord_width, coord_height = self._parse_coordinates(coordinates)
        if not coords:
            # Nothing to draw, return background and empty coords
            return bg_image, "[]"

        total_frames = int(frames) if frames is not None else 0
        if total_frames < 0:
            total_frames = 0
        coords = self._normalize_frame_count(coords, total_frames)
        if not coords:
            return bg_image, "[]"

        frame_width, frame_height = self._compute_frame_dimensions(bg_image)

        # Prepare PIL images
        bg_pils = tensor2pil(bg_image)

        # Build reference RGBA, honoring input alpha; apply optional ref_masks (inverted)
        ref_rgba = None
        try:
            ref_list = tensor2pil(ref_images if ref_images.ndim == 3 else ref_images[0].unsqueeze(0))
            if ref_list:
                ref_rgba = ref_list[0].convert("RGBA")
                if ref_masks is not None:
                    try:
                        mask_tensor = ref_masks[0] if ref_masks.ndim == 4 else ref_masks
                        mask_arr = np.clip(mask_tensor.cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
                        mask_img = Image.fromarray(np.squeeze(mask_arr), mode="L")
                        # Invert mask to align with expected compositing from editor
                        inv_mask = mask_img.point(lambda v: 255 - v)
                        r, g, b, _ = ref_rgba.split()
                        ref_rgba = Image.merge("RGBA", (r, g, b, inv_mask))
                    except Exception:
                        pass
        except Exception:
            ref_rgba = None

        if ref_rgba is None:
            return bg_image, json.dumps(coords)

        base_ref = ref_rgba
        base_w, base_h = base_ref.size

        frames = []
        mask_frames = []
        for idx, point in enumerate(coords):
            bg_src = bg_pils[min(idx, len(bg_pils) - 1)] if bg_pils else None
            bg_rgba = bg_src.convert("RGBA") if bg_src else Image.new("RGBA", (frame_width, frame_height), (0, 0, 0, 255))
            mask_base = Image.new("L", (frame_width, frame_height), 0)

            pos_x, pos_y = self._scale_point(point, frame_width, frame_height, coord_width, coord_height)
            scale_factor = self._get_scale(point, fallback_scale)

            new_w, new_h = self._compute_target_size(
                base_w, base_h, scale_factor, frame_width, frame_height, use_box_scale_size
            )
            ref_img = base_ref.resize((new_w, new_h), Image.LANCZOS)
            mask_img = None
            if ref_masks is not None:
                try:
                    mask_tensor = ref_masks[0] if ref_masks.ndim == 4 else ref_masks
                    mask_arr = np.clip(mask_tensor.cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
                    mask_img = Image.fromarray(np.squeeze(mask_arr), mode="L").resize((new_w, new_h), Image.LANCZOS)
                    # Invert for expected compositor behavior
                    mask_img = mask_img.point(lambda v: 255 - v)
                except Exception:
                    mask_img = None

            if overlay_opacity < 1.0:
                # Preserve existing alpha but scale by overlay_opacity
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
