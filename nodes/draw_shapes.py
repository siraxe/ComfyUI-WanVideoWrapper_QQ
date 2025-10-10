import json
import math
import concurrent.futures
from typing import Any, Dict, List, Optional, Tuple, Union

import torch
from PIL import Image, ImageDraw, ImageFilter

# External utilities: keep relative imports as in original file / environment
from ..utility.utility import pil2tensor, tensor2pil
from ..utility import draw_utils
from ..utility.driver_utils import apply_driver_offset, rotate_path, smooth_path, interpolate_path


# ----------------------------
# Helper Types
# ----------------------------
Coord = Dict[str, Any]  # expects {'x': float, 'y': float, ...}
Path = List[Coord]


# ----------------------------
# Node / Config Classes
# ----------------------------
class PathFrameConfig:
    """Configuration node for path animation frame timing and easing"""

    RETURN_TYPES = ("PATH_FRAME_CONFIG",)
    RETURN_NAMES = ("path_frame_config",)
    FUNCTION = "create_config"
    CATEGORY = "WanVideoWrapper_QQ"
    DESCRIPTION = """
Creates a frame configuration for path-based animation nodes.
Controls total frames, easing functions, and before/after frame padding.
"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "total_frames": ("INT", {"default": 16, "min": 1, "max": 10000, "step": 4}),
                "easing_function": (["linear", "ease_in", "ease_out", "ease_in_out", "ease_out_in"], {"default": "linear"}),
                "easing_path": (["each", "full"], {"default": "full"}),
                "easing_strength": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 10.0, "step": 0.05}),
            }
        }

    def create_config(self, total_frames, easing_function, easing_path, easing_strength):
        """Package frame configuration into a dictionary."""
        config = {
            "total_frames": total_frames,
            "easing_function": easing_function,
            "easing_path": easing_path,
            "easing_strength": easing_strength,
        }
        return (config,)


class DrawShapeOnPath:
    """
    ComfyUI node: Draw shapes along paths and return image batch, mask batch and JSON path output.

    All helper methods are defined as private methods to keep behavior encapsulated within the class.
    """

    RETURN_TYPES = ("IMAGE", "MASK", "STRING",)
    RETURN_NAMES = ("image", "mask", "output_coordinates",)
    FUNCTION = "drawshapemask"
    CATEGORY = "WanVideoWrapper_QQ"
    DESCRIPTION = """
Creates an image or batch of images with the specified shape drawn along a coordinate path.
Locations are center locations. Allows coordinates outside the frame for 'fly-in' effects.
"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "shape": (
                    ['circle', 'square', 'triangle'],
                    {"default": 'circle'}
                ),
                "bg_image": ("IMAGE",),
                "coordinates": ("STRING", {"forceInput": True}),
                "path_frame_config": ("PATH_FRAME_CONFIG",),
                "shape_width": ("INT", {"default": 40, "min": 2, "max": 1000, "step": 5}),
                "shape_height": ("INT", {"default": 40, "min": 2, "max": 1000, "step": 5}),
                "shape_color": ("STRING", {"default": 'white'}),
                "bg_color": ("STRING", {"default": 'black'}),
                "blur_radius": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 100, "step": 1.0}),
                "intensity": ("FLOAT", {"default": 1.0, "min": 0.01, "max": 100.0, "step": 0.01}),
            },
            "optional": {
                "trailing": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.01}),
                "border_width": ("INT", {"default": 0, "min": 0, "max": 100, "step": 1}),
                "border_color": ("STRING", {"default": 'black'}),
            }
        }

    # ----------------------------
    # Low-level drawing helper
    # ----------------------------
    def _draw_single_frame_pil(self, frame_index: int, processed_coords_list: List[Path],
                               path_pause_frames: List[Tuple[int, int]], total_frames: int,
                               frame_width: int, frame_height: int,
                               shape_width: int, shape_height: int,
                               shape_color: str, bg_color: str,
                               blur_radius: float, shape: str,
                               border_width: int, border_color: str,
                               static_points: Optional[List[Coord]] = None,
                               p_coords_use_driver: bool = False,
                               p_driver_path: Optional[Path] = None,
                               p_coords_pause_frames: Tuple[int, int] = (0, 0),
                               coords_driver_info_list: Optional[List[Optional[Dict[str, Any]]]] = None) -> Image.Image:
        """
        Draw one frame using PIL.
        This function is thread-safe and used by ThreadPoolExecutor in drawshapemask.
        Returns a PIL RGB image.
        """
        image = Image.new("RGB", (frame_width, frame_height), bg_color)
        draw = ImageDraw.Draw(image)
        current_width = float(shape_width)
        current_height = float(shape_height)

        # Draw static points (p_coordinates), optionally driven by p_driver_path
        if static_points:
            driver_offset_x = driver_offset_y = 0.0
            if p_coords_use_driver and p_driver_path and p_coords_pause_frames:
                p_start_p, p_end_p = p_coords_pause_frames
                p_animation_frames = max(1, total_frames - p_start_p - p_end_p)
                if frame_index < p_start_p:
                    driver_index = 0
                elif frame_index >= total_frames - p_end_p:
                    driver_index = len(p_driver_path) - 1
                else:
                    driver_index = frame_index - p_start_p

                if 0 <= driver_index < len(p_driver_path):
                    ref_x = float(p_driver_path[0]['x'])
                    ref_y = float(p_driver_path[0]['y'])
                    current_x = float(p_driver_path[driver_index]['x'])
                    current_y = float(p_driver_path[driver_index]['y'])
                    driver_offset_x = current_x - ref_x
                    driver_offset_y = current_y - ref_y

            # Draw each static point with driver offset applied
            for point in static_points:
                try:
                    location_x = point['x'] + driver_offset_x
                    location_y = point['y'] + driver_offset_y
                except (KeyError, TypeError):
                    continue

                if shape in ('circle', 'square'):
                    left_up_point = (location_x - current_width / 2.0, location_y - current_height / 2.0)
                    right_down_point = (location_x + current_width / 2.0, location_y + current_height / 2.0)
                    two_points = [left_up_point, right_down_point]

                    if shape == 'circle':
                        if border_width > 0:
                            draw.ellipse(two_points, fill=shape_color, outline=border_color, width=border_width)
                        else:
                            draw.ellipse(two_points, fill=shape_color)
                    else:  # square
                        if border_width > 0:
                            draw.rectangle(two_points, fill=shape_color, outline=border_color, width=border_width)
                        else:
                            draw.rectangle(two_points, fill=shape_color)

                elif shape == 'triangle':
                    left = (location_x - current_width / 2.0, location_y + current_height / 2.0)
                    right = (location_x + current_width / 2.0, location_y + current_height / 2.0)
                    top = (location_x, location_y - current_height / 2.0)
                    poly_points = [top, left, right]
                    if border_width > 0:
                        try:
                            draw.polygon(poly_points, fill=shape_color, outline=border_color)
                        except TypeError:
                            draw.polygon(poly_points, fill=shape_color)
                    else:
                        draw.polygon(poly_points, fill=shape_color)

        # Draw animated paths
        for path_idx, coords in enumerate(processed_coords_list):
            if not isinstance(coords, list) or len(coords) == 0:
                continue

            # Determine per-path frame mapping
            path_start_p, path_end_p = path_pause_frames[path_idx]
            path_animation_frames = max(1, total_frames - path_start_p - path_end_p)
            if frame_index < path_start_p:
                coord_index = 0
            elif frame_index >= total_frames - path_end_p:
                coord_index = path_animation_frames - 1
            else:
                coord_index = frame_index - path_start_p

            if coord_index < 0 or coord_index >= len(coords):
                continue

            try:
                location_x = coords[coord_index]['x']
                location_y = coords[coord_index]['y']
            except (KeyError, IndexError, TypeError):
                continue

            # Apply per-path driver offset (if present)
            driver_offset_x = driver_offset_y = 0.0
            if coords_driver_info_list and path_idx < len(coords_driver_info_list):
                driver_info = coords_driver_info_list[path_idx]
                if driver_info and isinstance(driver_info, dict):
                    interpolated_driver = driver_info.get('interpolated_path')
                    driver_pause_frames = driver_info.get('pause_frames', (0, 0))
                    d_scale = driver_info.get('d_scale', 1.0)
                    if interpolated_driver and len(interpolated_driver) > 0:
                        d_start_p, d_end_p = driver_pause_frames
                        if frame_index < d_start_p:
                            driver_index = 0
                        elif frame_index >= total_frames - d_end_p:
                            driver_index = len(interpolated_driver) - 1
                        else:
                            driver_index = frame_index - d_start_p

                        if 0 <= driver_index < len(interpolated_driver):
                            ref_x = float(interpolated_driver[0]['x'])
                            ref_y = float(interpolated_driver[0]['y'])
                            current_x = float(interpolated_driver[driver_index]['x'])
                            current_y = float(interpolated_driver[driver_index]['y'])
                            driver_offset_x = (current_x - ref_x) * d_scale
                            driver_offset_y = (current_y - ref_y) * d_scale

            location_x += driver_offset_x
            location_y += driver_offset_y

            # Draw the shape at the computed location
            if shape in ('circle', 'square'):
                left_up_point = (location_x - current_width / 2.0, location_y - current_height / 2.0)
                right_down_point = (location_x + current_width / 2.0, location_y + current_height / 2.0)
                two_points = [left_up_point, right_down_point]

                if shape == 'circle':
                    if border_width > 0:
                        draw.ellipse(two_points, fill=shape_color, outline=border_color, width=border_width)
                    else:
                        draw.ellipse(two_points, fill=shape_color)
                else:  # square
                    if border_width > 0:
                        draw.rectangle(two_points, fill=shape_color, outline=border_color, width=border_width)
                    else:
                        draw.rectangle(two_points, fill=shape_color)

            elif shape == 'triangle':
                left = (location_x - current_width / 2.0, location_y + current_height / 2.0)
                right = (location_x + current_width / 2.0, location_y + current_height / 2.0)
                top = (location_x, location_y - current_height / 2.0)
                poly_points = [top, left, right]
                if border_width > 0:
                    try:
                        draw.polygon(poly_points, fill=shape_color, outline=border_color)
                    except TypeError:
                        draw.polygon(poly_points, fill=shape_color)
                else:
                    draw.polygon(poly_points, fill=shape_color)

        if blur_radius and blur_radius > 0.0:
            image = image.filter(ImageFilter.GaussianBlur(blur_radius))

        return image

    # ----------------------------
    # Data processing helpers (all inside class)
    # ----------------------------
    def _safe_json_load(self, text: str) -> Any:
        """
        Safely load JSON from string, trying to tolerate single quotes by replacing them.
        Returns parsed JSON or raises JSONDecodeError.
        """
        if not isinstance(text, str):
            raise TypeError("Expected JSON string")
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            # Try replacing single quotes with double quotes (best-effort)
            return json.loads(text.replace("'", '"'))

    def _parse_coordinate_metadata(self, coordinates_str: str) -> Tuple[
            Optional[str], Optional[str], Dict[str, Any]]:
        """
        Parse the top-level coordinates string which may either be:
         - a JSON object containing metadata and 'coordinates'/'p_coordinates'
         - a plain JSON array / path list (older format)
        Returns (coordinates_data, p_coordinates_data, metadata_dict)
        where coordinates_data/p_coordinates_data are either JSON strings or None,
        and metadata_dict contains extracted fields (with defaults).
        """
        metadata = {
            "start_p_frames": 0,
            "end_p_frames": 0,
            "offsets": 0,
            "interpolations": 'linear',
            "drivers": None,
            "p_coordinates_use_driver": False,
            "p_driver_path": None,
            "p_driver_smooth": 0.0,
            "coord_width": None,
            "coord_height": None
        }
        coordinates_data = None
        p_coordinates_data = None

        try:
            parsed = self._safe_json_load(coordinates_str)
            if isinstance(parsed, dict):
                # Extract common fields safely
                if "coordinates" in parsed:
                    coordinates_data = json.dumps(parsed["coordinates"])
                if "p_coordinates" in parsed:
                    p_coordinates_data = json.dumps(parsed["p_coordinates"])
                for k in ("start_p_frames", "end_p_frames", "offsets", "interpolations", "drivers", "p_coordinates_use_driver", "p_driver_path", "p_driver_smooth", "coord_width", "coord_height"):
                    if k in parsed:
                        metadata[k] = parsed[k]
            else:
                # Not an object: treat as raw coordinates
                coordinates_data = coordinates_str
        except Exception:
            # Fall back to treating string as raw coordinates
            coordinates_data = coordinates_str

        return coordinates_data, p_coordinates_data, metadata

    def _parse_static_points(self, p_coordinates_json: Optional[str]) -> List[Coord]:
        """
        Parse static p_coordinates JSON string into a flat list of coordinate dicts.
        Returns [] if none or invalid.
        """
        if not p_coordinates_json:
            return []

        static_points: List[Coord] = []
        try:
            parsed = self._safe_json_load(p_coordinates_json)
            if isinstance(parsed, list):
                # Could be list of dicts or list of lists
                if parsed and isinstance(parsed[0], dict):
                    for p in parsed:
                        if isinstance(p, dict) and 'x' in p and 'y' in p:
                            static_points.append({'x': float(p['x']), 'y': float(p['y']), **{k: v for k, v in p.items() if k not in ('x', 'y')}})
                else:
                    # Flatten nested lists
                    for sub in parsed:
                        if isinstance(sub, list):
                            for p in sub:
                                if isinstance(p, dict) and 'x' in p and 'y' in p:
                                    static_points.append({'x': float(p['x']), 'y': float(p['y']), **{k: v for k, v in p.items() if k not in ('x', 'y')}})
        except Exception:
            # On any parse error, return empty list
            return []
        return static_points

    def _compute_frame_dimensions(self, bg_image: torch.Tensor) -> Tuple[int, int]:
        """
        Extract width and height from bg_image tensor (expected BHWC).
        Returns (width, height), defaults to (512, 512) on error.
        """
        try:
            _, frame_height, frame_width, _ = bg_image.shape
            return frame_width, frame_height
        except Exception:
            return 512, 512

    def _scale_points_and_drivers(self, static_points: List[Coord], p_driver_path: Optional[Path],
                                  coord_width: Optional[float], coord_height: Optional[float],
                                  frame_width: int, frame_height: int) -> Tuple[List[Coord], Optional[Path]]:
        """
        Scale static points and driver path if coordinate space differs from frame size.
        Returns tuple (scaled_static_points, scaled_driver_path_or_none).
        """
        if not coord_width or not coord_height:
            return static_points, p_driver_path

        scale_x = float(frame_width) / float(coord_width) if coord_width and coord_width != 0 else 1.0
        scale_y = float(frame_height) / float(coord_height) if coord_height and coord_height != 0 else 1.0

        if scale_x == 1.0 and scale_y == 1.0:
            return static_points, p_driver_path

        scaled_static = []
        for p in static_points:
            sp = {**p}
            sp['x'] = float(p['x']) * scale_x
            sp['y'] = float(p['y']) * scale_y
            scaled_static.append(sp)

        scaled_driver = None
        if p_driver_path:
            scaled_driver = []
            for p in p_driver_path:
                if isinstance(p, dict) and 'x' in p and 'y' in p:
                    sp = {**p}
                    sp['x'] = float(p['x']) * scale_x
                    sp['y'] = float(p['y']) * scale_y
                    scaled_driver.append(sp)

        return scaled_static, scaled_driver

    def _process_p_driver_path(self, raw_path: Optional[Path], total_frames: int, smooth_strength: float,
                               easing_function: str, easing_path: str, easing_strength: float) -> Optional[Path]:
        """
        Interpolate p_driver_path to match total_frames and optionally smooth it.
        Returns processed path or None.
        """
        if not raw_path:
            return None
        try:
            if len(raw_path) != total_frames:
                processed = draw_utils.InterpMath.interpolate_or_downsample_path(raw_path, total_frames, easing_function, easing_path, bounce_between=0.0, easing_strength=easing_strength)
            else:
                processed = [dict(p) for p in raw_path]
            if smooth_strength and smooth_strength > 0.0 and len(processed) > 2:
                smoothed = []
                smoothed.append(processed[0].copy())
                for i in range(1, len(processed) - 1):
                    curr = processed[i]
                    prev = processed[i - 1]
                    nxt = processed[i + 1]
                    neighbor_weight = smooth_strength * 0.5
                    current_weight = 1.0 - (2 * neighbor_weight)
                    sx = (current_weight * float(curr['x']) + neighbor_weight * float(prev['x']) + neighbor_weight * float(nxt['x']))
                    sy = (current_weight * float(curr['y']) + neighbor_weight * float(prev['y']) + neighbor_weight * float(nxt['y']))
                    smoothed.append({'x': sx, 'y': sy})
                smoothed.append(processed[-1].copy())
                processed = smoothed
            return processed
        except Exception:
            return None

    def _normalize_metadata_lists(self, num_paths: int, start_p_frames_meta, end_p_frames_meta, interpolations_meta, drivers_meta, offsets_meta) -> Tuple[List[int], List[int], List[str], List[Optional[Any]], List[int]]:
        """
        Normalize metadata values to per-path lists with length num_paths:
        - start_p_frames_list, end_p_frames_list -> lists of ints
        - interpolations_list -> list of strings
        - drivers_list -> list of driver dicts or None
        - offsets_list -> list of ints
        """
        # Start/end pauses
        start_p_frames_list = []
        end_p_frames_list = []
        if isinstance(start_p_frames_meta, dict):
            c_start = start_p_frames_meta.get("c", 0)
            c_end = end_p_frames_meta.get("c", 0)
            if isinstance(c_start, int):
                start_p_frames_list = [c_start] * num_paths
                end_p_frames_list = [c_end] * num_paths
            elif isinstance(c_start, list):
                start_p_frames_list = c_start + [0] * (num_paths - len(c_start))
                end_p_frames_list = c_end + [0] * (num_paths - len(c_end)) if isinstance(c_end, list) else [c_end] * num_paths
            else:
                start_p_frames_list = [0] * num_paths
                end_p_frames_list = [0] * num_paths
        elif isinstance(start_p_frames_meta, (int, float)):
            start_p_frames_list = [int(start_p_frames_meta)] * num_paths
            end_p_frames_list = [int(end_p_frames_meta)] * num_paths
        elif isinstance(start_p_frames_meta, list):
            start_p_frames_list = [int(v) for v in start_p_frames_meta] + [0] * (num_paths - len(start_p_frames_meta))
            end_p_frames_list = [int(v) for v in end_p_frames_meta] + [0] * (num_paths - len(end_p_frames_meta)) if isinstance(end_p_frames_meta, list) else [int(end_p_frames_meta)] * num_paths
        else:
            start_p_frames_list = [0] * num_paths
            end_p_frames_list = [0] * num_paths

        # Interpolations
        interpolations_list = []
        if isinstance(interpolations_meta, dict):
            c_inter = interpolations_meta.get("c", 'linear')
            if isinstance(c_inter, str):
                interpolations_list = [c_inter] * num_paths
            elif isinstance(c_inter, list):
                interpolations_list = c_inter + ['linear'] * (num_paths - len(c_inter))
            else:
                interpolations_list = ['linear'] * num_paths
        elif isinstance(interpolations_meta, str):
            interpolations_list = [interpolations_meta] * num_paths
        elif isinstance(interpolations_meta, list):
            interpolations_list = interpolations_meta + ['linear'] * (num_paths - len(interpolations_meta))
        else:
            interpolations_list = ['linear'] * num_paths

        # Drivers list
        drivers_list = []
        if isinstance(drivers_meta, dict):
            c_drivers = drivers_meta.get("c", [])
            if isinstance(c_drivers, list):
                drivers_list = c_drivers + [None] * (num_paths - len(c_drivers))
            else:
                drivers_list = [None] * num_paths
        else:
            drivers_list = [None] * num_paths

        # Offsets
        offsets_list = []
        if isinstance(offsets_meta, dict):
            c_offsets = offsets_meta.get("c", 0)
            if isinstance(c_offsets, int):
                offsets_list = [c_offsets] * num_paths
            elif isinstance(c_offsets, list):
                offsets_list = c_offsets + [0] * (num_paths - len(c_offsets))
            else:
                offsets_list = [0] * num_paths
        elif isinstance(offsets_meta, int):
            offsets_list = [offsets_meta] * num_paths
        elif isinstance(offsets_meta, list):
            offsets_list = offsets_meta + [0] * (num_paths - len(offsets_meta))
        else:
            offsets_list = [0] * num_paths

        return start_p_frames_list, end_p_frames_list, interpolations_list, drivers_list, offsets_list

    def _apply_offset_timing(self, points: Path, offset: int) -> Tuple[Path, int, int]:
        """
        Apply timing offset by removing coordinates and returning pause adjustments.
        Returns (modified_points, start_pause_adjustment, end_pause_adjustment).
        """
        if offset == 0 or not points:
            return points, 0, 0

        offset_abs = abs(offset)
        path_length = len(points)
        if offset_abs >= path_length:
            offset_abs = max(0, path_length - 1)

        if offset > 0:
            # Positive offset: remove last N frames, add N to start pause
            return (points[:-offset_abs] if offset_abs > 0 else points, offset_abs, 0)
        else:
            # Negative: remove last N frames, add N to end pause
            return (points[:-offset_abs] if offset_abs > 0 else points, 0, offset_abs)

    def _build_interpolated_paths(self, coords_list_raw: List[Path], total_frames: int,
                                  start_p_frames_meta, end_p_frames_meta,
                                  offsets_meta, interpolations_meta, drivers_meta,
                                  easing_function: str, easing_path: str, easing_strength: float,
                                  coord_width: Optional[float] = None, coord_height: Optional[float] = None,
                                  frame_width: int = 512, frame_height: int = 512) -> Tuple[List[Path], List[Tuple[int, int]], List[Optional[Dict[str, Any]]]]:
        """
        Given raw coordinate lists and metadata, produce:
         - processed_coords_list: list of resampled/interpolated paths
         - path_pause_frames: list of (start_p, end_p) for each processed path
         - coords_driver_info_list: per-path driver info dict or None
        Raises or returns empty list if no valid paths.
        """
        if not coords_list_raw:
            return [], [], []

        num_paths = len(coords_list_raw)
        start_p_frames_list, end_p_frames_list, interpolations_list, drivers_list, offsets_list = self._normalize_metadata_lists(
            num_paths, start_p_frames_meta, end_p_frames_meta, interpolations_meta, drivers_meta, offsets_meta
        )

        processed_coords_list: List[Path] = []
        path_pause_frames: List[Tuple[int, int]] = []
        coords_driver_info_list: List[Optional[Dict[str, Any]]] = []
        valid_paths_exist = False

        for i, path in enumerate(coords_list_raw):
            if not isinstance(path, list) or len(path) == 0:
                continue

            # Validate and ensure float coordinates
            valid = True
            for pt_idx, pt in enumerate(path):
                if not isinstance(pt, dict) or 'x' not in pt or 'y' not in pt:
                    valid = False
                    break
                try:
                    pt['x'] = float(pt['x'])
                    pt['y'] = float(pt['y'])
                except (ValueError, TypeError):
                    valid = False
                    break
            if not valid:
                continue

            try:
                path_start_p = int(start_p_frames_list[i])
                path_end_p = int(end_p_frames_list[i])
                path_offset = int(offsets_list[i])
                path_interpolation = interpolations_list[i]
                path_driver_info = drivers_list[i] if i < len(drivers_list) else None

                path_animation_frames = max(1, total_frames - path_start_p - path_end_p)
                effective_easing_path = easing_path

                # Mark control points for 'each' easing path
                if effective_easing_path == 'each':
                    for p in path:
                        p['is_control'] = True

                # Interpolate points (or use 'points' mode)
                if path_interpolation == 'points':
                    interpolated_path = path
                else:
                    # draw_utils.interpolate_points will handle cardinal, basis, etc.
                    interpolated_path = draw_utils.interpolate_points(path, path_interpolation, effective_easing_path)

                # Resample/interpolate to match path_animation_frames
                processed_path = draw_utils.InterpMath.interpolate_or_downsample_path(
                    interpolated_path, path_animation_frames, easing_function, effective_easing_path, bounce_between=0.0, easing_strength=easing_strength, interpolation=path_interpolation
                )

                # Prepare per-path driver interpolation (for per-frame offsets)
                driver_info_for_frame = None
                if isinstance(path_driver_info, dict):
                    raw_driver_path = path_driver_info.get('path')
                    driver_rotate = path_driver_info.get('rotate', 0)
                    driver_d_scale = path_driver_info.get('d_scale', 1.0)
                    if raw_driver_path and len(raw_driver_path) > 0:
                        transformed_driver = raw_driver_path
                        # NOTE: Driver paths are already scaled in drawshapemask() at lines 391-415
                        # Do NOT scale them again here or they'll be scaled twice

                        if driver_rotate and driver_rotate != 0:
                            transformed_driver = rotate_path(transformed_driver, driver_rotate)
                        # d_scale will be applied during rendering to the offset
                        interpolated_driver = draw_utils.InterpMath.interpolate_or_downsample_path(
                            transformed_driver, total_frames, easing_function, easing_path, bounce_between=0.0, easing_strength=easing_strength
                        )
                        driver_info_for_frame = {'interpolated_path': interpolated_driver, 'pause_frames': (path_start_p, path_end_p), 'd_scale': driver_d_scale}

                # Apply offset timing (modify processed_path and adjust pauses)
                if path_offset != 0:
                    processed_path, start_adj, end_adj = self._apply_offset_timing(processed_path, path_offset)
                    path_start_p += start_adj
                    path_end_p += end_adj

                processed_coords_list.append(processed_path)
                path_pause_frames.append((path_start_p, path_end_p))
                coords_driver_info_list.append(driver_info_for_frame)
                valid_paths_exist = True
            except Exception:
                # Skip this path on processing error
                continue

        if not valid_paths_exist:
            return [], [], []

        return processed_coords_list, path_pause_frames, coords_driver_info_list

    # ----------------------------
    # Post-processing helpers
    # ----------------------------
    def _postprocess_frames_to_tensors(self, pil_images: List[Image.Image], frame_width: int, frame_height: int,
                                       trailing: float, intensity: float) -> Tuple[torch.Tensor, torch.Tensor]:
        """
        Convert list of PIL images (length = batch_size) into:
         - out_images (BHWC float tensor)
         - out_masks (BHW float tensor)
        Applies trailing and intensity in CHW domain.
        """
        images_list_bchw = []
        masks_list_bhw = []
        previous_output_chw = None

        for i, pil_image in enumerate(pil_images):
            if pil_image is None:
                pil_image = Image.new("RGB", (frame_width, frame_height), (0, 0, 0))

            image_tensor_bhwc = pil2tensor(pil_image)  # expects [1, H, W, C] float32 0..1
            # Validate shape and fallback if necessary
            if image_tensor_bhwc.ndim != 4 or image_tensor_bhwc.shape[0] != 1:
                image_tensor_bhwc = torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32)

            image_tensor_chw = image_tensor_bhwc[0].permute(2, 0, 1)  # [C, H, W]

            # Trailing effect
            if trailing != 1.0 and previous_output_chw is not None:
                try:
                    if previous_output_chw.device != image_tensor_chw.device:
                        previous_output_chw = previous_output_chw.to(image_tensor_chw.device)
                    image_tensor_chw = image_tensor_chw + trailing * previous_output_chw
                    image_tensor_chw = torch.clamp(image_tensor_chw, 0.0, 1.0)
                except Exception:
                    pass

            previous_output_chw = image_tensor_chw.clone() if trailing != 1.0 else None

            # Apply intensity
            image_tensor_chw = image_tensor_chw * float(intensity)
            image_tensor_chw = torch.clamp(image_tensor_chw, 0.0, 1.0)

            # Mask = red channel (index 0) per original code
            mask_tensor_hw = image_tensor_chw[0, :, :].clone()

            masks_list_bhw.append(mask_tensor_hw.unsqueeze(0))
            images_list_bchw.append(image_tensor_chw.unsqueeze(0))

        if not images_list_bchw or not masks_list_bhw:
            return (torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32),
                    torch.zeros([1, frame_height, frame_width], dtype=torch.float32))

        out_images_bchw = torch.cat(images_list_bchw, dim=0)
        out_images = out_images_bchw.permute(0, 2, 3, 1).cpu().float()
        out_masks = torch.cat(masks_list_bhw, dim=0).cpu().float()

        out_images = torch.clamp(out_images, 0.0, 1.0)
        out_masks = torch.clamp(out_masks, 0.0, 1.0)

        return out_images, out_masks

    # ----------------------------
    # Main Node Method
    # ----------------------------
    def drawshapemask(self, coordinates, bg_image, shape_width, shape_height, shape_color,
                      bg_color, blur_radius, shape, intensity, path_frame_config,
                      trailing=1.0, border_width=0, border_color='black'):
        """
        Main entry point. Orchestrates:
         - Parsing coordinates + metadata
         - Scaling coordinates to frame dimensions
         - Interpolating/resampling coordinate paths
         - Rendering frames in parallel (PIL)
         - Post-processing tensors, masks, and optional trailing/intensity
         - Returning (images, masks, json_coords_string)
        """

        # ----- Extract frame config -----
        total_frames = int(path_frame_config.get("total_frames", 1))
        easing_function = path_frame_config.get("easing_function", "linear")
        easing_path = path_frame_config.get("easing_path", "full")
        easing_strength = float(path_frame_config.get("easing_strength", 1.0))

        # ----- Parse coordinate metadata & static points -----
        coordinates_data, p_coordinates_data, meta = self._parse_coordinate_metadata(coordinates)
        static_points = self._parse_static_points(p_coordinates_data)

        # Driver metadata for p_coordinates (older and newer logic)
        p_coords_use_driver = bool(meta.get("p_coordinates_use_driver", False))
        p_driver_path_raw = meta.get("p_driver_path", None)
        p_driver_smooth = float(meta.get("p_driver_smooth", 0.0))

        # Attempt to find a driver path inside drivers metadata if present
        if isinstance(meta.get("drivers"), dict) and not p_driver_path_raw:
            p_drivers = meta["drivers"].get("p")
            raw_driver_path = None
            if isinstance(p_drivers, list) and p_drivers:
                for d in p_drivers:
                    if isinstance(d, dict) and 'path' in d and isinstance(d['path'], list) and d['path']:
                        raw_driver_path = d['path']
                        break
            if raw_driver_path:
                p_driver_path_raw = raw_driver_path
                p_coords_use_driver = True

        # ----- Frame dimensions and scaling -----
        frame_width, frame_height = self._compute_frame_dimensions(bg_image)
        coord_width = meta.get("coord_width", None)
        coord_height = meta.get("coord_height", None)

        # Scale static points and p_driver_path if necessary
        static_points, p_driver_path_processed = self._scale_points_and_drivers(static_points, p_driver_path_raw, coord_width, coord_height, frame_width, frame_height)

        # Interpolate p_driver_path to total_frames and apply smoothing
        if p_coords_use_driver and p_driver_path_processed:
            p_driver_path_processed = self._process_p_driver_path(p_driver_path_processed, total_frames, p_driver_smooth, easing_function, easing_path, easing_strength)

        # ----- Parse animated coordinates list (coords_list_raw) -----
        coords_list_raw: List[Path] = []
        if coordinates_data is not None:
            try:
                coords_parsed = self._safe_json_load(coordinates_data)
                if isinstance(coords_parsed, list):
                    if len(coords_parsed) == 0:
                        coords_list_raw = []
                    elif isinstance(coords_parsed[0], list):
                        coords_list_raw = coords_parsed
                    elif isinstance(coords_parsed[0], dict):
                        coords_list_raw = [coords_parsed]
                    else:
                        # Unexpected format
                        return (torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32),
                                torch.zeros([1, frame_height, frame_width], dtype=torch.float32))
                else:
                    # Unexpected format
                    return (torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32),
                            torch.zeros([1, frame_height, frame_width], dtype=torch.float32))
            except Exception:
                return (torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32),
                        torch.zeros([1, frame_height, frame_width], dtype=torch.float32))
        else:
            coords_list_raw = []

        # If coordinate space scaled needs to affect drivers embedded in meta['drivers'] -> scale them too
        drivers_meta = meta.get("drivers", None)
        if (coord_width or coord_height) and isinstance(drivers_meta, dict):
            # proper scaling for drivers 'c' if present
            c_drivers = drivers_meta.get("c", [])
            scaled_c = []
            for driver_info in c_drivers:
                if isinstance(driver_info, dict):
                    driver_path = driver_info.get('path')
                    if isinstance(driver_path, list) and driver_path:
                        scaled_path = []
                        for pt in driver_path:
                            if isinstance(pt, dict) and 'x' in pt and 'y' in pt:
                                scaled_path.append({'x': float(pt['x']) * (frame_width / coord_width if coord_width else 1.0),
                                                    'y': float(pt['y']) * (frame_height / coord_height if coord_height else 1.0),
                                                    **{k: v for k, v in pt.items() if k not in ('x', 'y')}})
                        dcopy = driver_info.copy()
                        dcopy['path'] = scaled_path
                        scaled_c.append(dcopy)
                    else:
                        scaled_c.append(driver_info)
                else:
                    scaled_c.append(driver_info)
            drivers_meta['c'] = scaled_c
            meta['drivers'] = drivers_meta

        # If coords_list_raw needs scaling because coord_width/coord_height differ
        if coord_width and coord_height and (coord_width != frame_width or coord_height != frame_height):
            scaled_coords_list = []
            scale_x = float(frame_width) / float(coord_width)
            scale_y = float(frame_height) / float(coord_height)
            for path in coords_list_raw:
                scaled_path = []
                for point in path:
                    if isinstance(point, dict) and 'x' in point and 'y' in point:
                        sp = {**point}
                        sp['x'] = float(point['x']) * scale_x
                        sp['y'] = float(point['y']) * scale_y
                        scaled_path.append(sp)
                scaled_coords_list.append(scaled_path)
            coords_list_raw = scaled_coords_list

        # ----- Build interpolated/resampled animated paths -----
        processed_coords_list, path_pause_frames, coords_driver_info_list = self._build_interpolated_paths(
            coords_list_raw, total_frames,
            meta.get("start_p_frames", 0), meta.get("end_p_frames", 0),
            meta.get("offsets", 0), meta.get("interpolations", 'linear'),
            meta.get("drivers", None), easing_function, easing_path, easing_strength,
            coord_width, coord_height, frame_width, frame_height
        )

        # Special cases: no animated coords but static points exist -> set batch size accordingly
        if not processed_coords_list:
            if static_points:
                if p_coords_use_driver and p_driver_path_processed:
                    batch_size = total_frames
                else:
                    batch_size = 1
                    total_frames = 1
                processed_coords_list = []
                path_pause_frames = []
            else:
                # No input to render
                return (torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32),
                        torch.zeros([1, frame_height, frame_width], dtype=torch.float32))

        # ----- Frame Generation (PIL) in threads -----
        batch_size = total_frames
        pil_images: List[Optional[Image.Image]] = [None] * batch_size

        # Prepare arguments for thread execution
        args_list = []
        for i in range(batch_size):
            # Safely extract start_p_frames and end_p_frames, handling all possible data types
            start_p_frames = meta.get("start_p_frames", 0)
            end_p_frames = meta.get("end_p_frames", 0)
            
            # Handle dictionary case (from metadata parsing)
            if isinstance(start_p_frames, dict):
                start_p_frames = start_p_frames.get("c", 0)
            if isinstance(end_p_frames, dict):
                end_p_frames = end_p_frames.get("c", 0)
                
            # Handle list case (from metadata parsing) - take first element or default to 0
            if isinstance(start_p_frames, list):
                start_p_frames = start_p_frames[0] if start_p_frames else 0
            if isinstance(end_p_frames, list):
                end_p_frames = end_p_frames[0] if end_p_frames else 0
                
            # Ensure we have integers at this point with proper error handling
            try:
                start_p_frames = int(start_p_frames)
                end_p_frames = int(end_p_frames)
            except (ValueError, TypeError):
                # Fallback to default values if conversion fails
                start_p_frames = 0
                end_p_frames = 0
                
            args_list.append((
                i, processed_coords_list, path_pause_frames, total_frames,
                frame_width, frame_height, shape_width, shape_height,
                shape_color, bg_color, blur_radius, shape, border_width, border_color,
                static_points, p_coords_use_driver, p_driver_path_processed, (start_p_frames, end_p_frames), coords_driver_info_list
            ))

        try:
            with concurrent.futures.ThreadPoolExecutor() as executor:
                results = list(executor.map(lambda p: self._draw_single_frame_pil(*p), args_list))
                pil_images = results
        except Exception:
            # Fallback to sequential generation if threading fails
            pil_images = [self._draw_single_frame_pil(*a) for a in args_list]

        # ----- Post-processing into tensors (apply trailing & intensity) -----
        out_images, out_masks = self._postprocess_frames_to_tensors(pil_images, frame_width, frame_height, trailing, intensity)

        # ----- Build output coordinates JSON (basic: first path across frames) -----
        output_coords_json = "[]"
        if processed_coords_list:
            try:
                first_path_coords = []
                path_start_p, path_end_p = path_pause_frames[0]
                for i in range(total_frames):
                    if i < path_start_p:
                        coord_index = 0
                    elif i >= total_frames - path_end_p:
                        coord_index = len(processed_coords_list[0]) - 1
                    else:
                        coord_index = i - path_start_p
                    coord_index = max(0, min(coord_index, len(processed_coords_list[0]) - 1))
                    first_path_coords.append(processed_coords_list[0][coord_index])
                output_coords_json = json.dumps(first_path_coords)
            except Exception:
                output_coords_json = "[]"

        return (out_images, out_masks, output_coords_json)
