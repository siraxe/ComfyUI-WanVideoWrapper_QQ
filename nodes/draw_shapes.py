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
from .draw_shapes_dr import (
    apply_box_pivot_scaling,
    apply_driver_chain_offsets,
    build_interpolated_paths,
    build_layer_path_map,
    calculate_driver_offset,
    DriverGraphError,
    get_driver_scale_for_frame,
    normalize_layer_names,
    process_driver_path,
    resolve_driver_processing_order,
    resample_scale_profile,
    round_coord,
    scale_driver_metadata,
    scale_points_and_driver_path,
)

Coord = Dict[str, Any]  # expects {'x': float, 'y': float, ...}
Path = List[Coord]

# Constants
DEFAULT_FRAME_WIDTH = 512
DEFAULT_FRAME_HEIGHT = 512
DEFAULT_TOTAL_FRAMES = 16
DEFAULT_SHAPE_SIZE = 40
PREVIEW_SCALE_FACTOR = 0.5
DRIVER_SCALE_FACTOR = 1.0
TRAILING_WEIGHT_FACTOR = 0.5
ALPHA_BLEND_FACTOR = 0.5
MIN_SHAPE_SIZE = 2
MAX_SHAPE_SIZE = 1000
MIN_BLUR_RADIUS = 0.0
MAX_BLUR_RADIUS = 100.0
MIN_INTENSITY = 0.01
MAX_INTENSITY = 100.0
MIN_BORDER_WIDTH = 0
MAX_BORDER_WIDTH = 100


class DrawShapeOnPath:
    """
    ComfyUI node: Draw shapes along paths and return image batch, mask batch and JSON path output.

    All helper methods are defined as private methods to keep behavior encapsulated within the class.
    """

    RETURN_TYPES = ("IMAGE", "MASK", "STRING", "IMAGE",)
    RETURN_NAMES = ("image", "mask", "output_coordinates", "preview",)
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
                "shape_width": ("INT", {"default": DEFAULT_SHAPE_SIZE, "min": MIN_SHAPE_SIZE, "max": MAX_SHAPE_SIZE, "step": 5}),
                "shape_height": ("INT", {"default": DEFAULT_SHAPE_SIZE, "min": MIN_SHAPE_SIZE, "max": MAX_SHAPE_SIZE, "step": 5}),
                "shape_color": ("STRING", {"default": 'white'}),
                "bg_color": ("STRING", {"default": 'black'}),
                "blur_radius": ("FLOAT", {"default": 1.0, "min": MIN_BLUR_RADIUS, "max": MAX_BLUR_RADIUS, "step": 1.0}),
                "intensity": ("FLOAT", {"default": 1.0, "min": MIN_INTENSITY, "max": MAX_INTENSITY, "step": 0.01}),
            },
            "optional": {
                "trailing": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "border_width": ("INT", {"default": MIN_BORDER_WIDTH, "min": MIN_BORDER_WIDTH, "max": MAX_BORDER_WIDTH, "step": 1}),
                "border_color": ("STRING", {"default": 'black'}),
                "frames": ("INT", {"forceInput": True},{"default": 121 }),
                "animated_fade_start": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "static_fade_start": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "preview_enabled": ("BOOLEAN", {"default": True}),
            }
        }

    # ----------------------------
    # Low-level drawing helper
    # ----------------------------
    def _draw_shape_at_location(self, draw: ImageDraw.ImageDraw, location_x: float, location_y: float,
                               shape: str, shape_width: float, shape_height: float,
                               shape_color: str, border_width: int, border_color: str) -> None:
        """
        Draw a single shape at the specified location.
        This consolidates the repeated shape drawing logic.
        """
        if shape in ('circle', 'square'):
            left_up_point = (location_x - shape_width / 2.0, location_y - shape_height / 2.0)
            right_down_point = (location_x + shape_width / 2.0, location_y + shape_height / 2.0)
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
            left = (location_x - shape_width / 2.0, location_y + shape_height / 2.0)
            right = (location_x + shape_width / 2.0, location_y + shape_height / 2.0)
            top = (location_x, location_y - shape_height / 2.0)
            poly_points = [top, left, right]
            if border_width > 0:
                try:
                    draw.polygon(poly_points, fill=shape_color, outline=border_color)
                except TypeError:
                    draw.polygon(poly_points, fill=shape_color)
            else:
                draw.polygon(poly_points, fill=shape_color)

    def _draw_single_frame_pil(self, frame_index: int, processed_coords_list: List[Path],
                               path_pause_frames: List[Tuple[int, int]], total_frames: int,
                               frame_width: int, frame_height: int,
                               shape_width: int, shape_height: int,
                               shape_color: str, bg_color: str,
                               blur_radius: float, shape: str,
                               border_width: int, border_color: str,
                               static_point_layers: Optional[List[List[Coord]]] = None,
                               static_points_use_driver: bool = False,
                               static_points_driver_path: Optional[Path] = None,
                               static_points_pause_frames_list: Optional[List[Tuple[int, int]]] = None,
                               coords_driver_info_list: Optional[List[Optional[Dict[str, Any]]]] = None,
                               scales_list: Optional[List[float]] = None,
                               static_points_scale: float = 1.0,
                               static_points_scales_list: Optional[List[float]] = None,
                               static_points_driver_info_list: Optional[List[Optional[Dict[str, Any]]]] = None,
                               static_points_interpolated_drivers: Optional[List[Dict[str, Any]]] = None,
                               resolved_driver_paths: Optional[Dict[str, List[Dict[str, float]]]] = None,
                               layer_visibility: Optional[List[bool]] = None,
                               static_points_offsets_list: Optional[List[int]] = None,
                               static_points_visibility_list: Optional[List[bool]] = None) -> Image.Image:
        """
        Draw one frame using PIL.
        This function is thread-safe and used by ThreadPoolExecutor in drawshapemask.
        Returns a PIL RGB image.

        Coordinate System:
        - All coordinates are expected in pixel coordinates relative to frame dimensions
        - Static points (p_coordinates) represent fixed positions that can be driven by driver paths
        - Animated paths contain sequences of coordinates representing motion over time
        - Driver paths are in normalized coordinates (0-1) and get scaled to frame dimensions
        """
        image = Image.new("RGB", (frame_width, frame_height), bg_color)
        draw = ImageDraw.Draw(image)
        current_width = float(shape_width)
        current_height = float(shape_height)
        
        # Apply scale to shape dimensions if scales_list is provided
        if scales_list and len(scales_list) > 0:
            # Use the first scale value for static points (if any)
            scale = float(scales_list[0])
            current_width *= scale
            current_height *= scale

        driver_cache: Dict[str, Dict[str, Any]] = {}

        def _register_driver_info(info: Optional[Dict[str, Any]]):
            if isinstance(info, dict):
                name = info.get('layer_name')
                if name:
                    driver_cache[name] = info

        if coords_driver_info_list:
            for info in coords_driver_info_list:
                _register_driver_info(info)
        if static_points_interpolated_drivers:
            for info in static_points_interpolated_drivers:
                _register_driver_info(info)

        def _get_effective_frame(driver_info: Dict[str, Any], base_frame_index: int) -> int:
            start_pause = int(driver_info.get('start_pause', 0))
            offset_val = int(driver_info.get('offset', 0))
            pos_delay = start_pause + max(0, offset_val)
            neg_lead = -min(0, offset_val)
            return max(0, base_frame_index - pos_delay + neg_lead)

        def _compute_single_driver_offset(driver_info: Optional[Dict[str, Any]], base_frame_index: int) -> Tuple[float, float]:
            if not driver_info or not isinstance(driver_info, dict):
                return 0.0, 0.0
            path_key = driver_info.get('driver_path_key', 'interpolated_path')
            driver_path = driver_info.get(path_key)
            if not isinstance(driver_path, list) or len(driver_path) == 0:
                return 0.0, 0.0
            eff_frame = _get_effective_frame(driver_info, base_frame_index)
            driver_path_normalized = driver_info.get('driver_path_normalized', False)
            d_scale = driver_info.get('d_scale', 1.0)
            driver_scale_factor = driver_info.get('driver_scale_factor', 1.0)
            driver_radius_delta = driver_info.get('driver_radius_delta', 0.0)
            apply_scale_to_offset = driver_info.get('apply_scale_to_offset', None)
            if apply_scale_to_offset is None:
                apply_scale_to_offset = driver_info.get('driver_type') != 'box'

            # For box drivers, make the offset purely translational so that
            # driven points follow only the box's positional change. Box
            # scale / radius_delta should not expand or contract the offset
            # applied to other layers.
            if driver_info.get('driver_type') == 'box':
                d_scale = 1.0
                driver_scale_factor = 1.0
                driver_radius_delta = 0.0

            return calculate_driver_offset(
                eff_frame, driver_path, (0, 0), total_frames, d_scale,
                frame_width, frame_height, driver_scale_factor=driver_scale_factor,
                driver_radius_delta=driver_radius_delta,
                driver_path_normalized=driver_path_normalized,
                apply_scale_to_offset=apply_scale_to_offset
            )

        def _accumulate_driver_offsets(driver_info: Optional[Dict[str, Any]], base_frame_index: int) -> Tuple[float, float]:
            if not driver_info:
                return 0.0, 0.0
            return _compute_single_driver_offset(driver_info, base_frame_index)

        total_static_layers = len(static_point_layers) if static_point_layers else 0
        aligned_static_drivers = bool(static_points_interpolated_drivers) and len(static_points_interpolated_drivers) == total_static_layers
        first_static_driver = None
        if static_points_interpolated_drivers:
            for entry in static_points_interpolated_drivers:
                if isinstance(entry, dict):
                    first_static_driver = entry
                    break

        # Draw static points (p_coordinates), optionally driven by static_points_driver_path
        # Static points are individual points that stay in one location but can be moved by driver paths
        # They differ from animated paths which contain multiple coordinate points over time
        if static_point_layers:
            # Draw each layer of static points with its own driver if available
            for layer_idx, static_points in enumerate(static_point_layers):
                if not static_points:
                    continue

                # Skip rendering for hidden layers
                if static_points_visibility_list and layer_idx < len(static_points_visibility_list) and not static_points_visibility_list[layer_idx]:
                    continue

                # Apply scale to shape dimensions for static points using per-layer scales if available
                layer_scale = static_points_scale
                if static_points_scales_list and layer_idx < len(static_points_scales_list):
                    layer_scale = float(static_points_scales_list[layer_idx])

                static_width = float(shape_width) * layer_scale
                static_height = float(shape_height) * layer_scale

                # Get the driver for this layer if available
                layer_driver_info = None
                if static_points_use_driver and static_points_interpolated_drivers:
                    if layer_idx < len(static_points_interpolated_drivers):
                        layer_driver_info = static_points_interpolated_drivers[layer_idx]
                    if layer_driver_info is None and not aligned_static_drivers:
                        layer_driver_info = first_static_driver

                # Get this layer's specific timing
                layer_start_pause = static_points_pause_frames_list[layer_idx][0] if static_points_pause_frames_list and layer_idx < len(static_points_pause_frames_list) else 0
                layer_end_pause = static_points_pause_frames_list[layer_idx][1] if static_points_pause_frames_list and layer_idx < len(static_points_pause_frames_list) else 0
                layer_offset = static_points_offsets_list[layer_idx] if static_points_offsets_list and layer_idx < len(static_points_offsets_list) else 0

                # Calculate the adjusted frame index for the driver based on the points layer's timing
                driver_eval_frame = frame_index
                if driver_eval_frame < layer_start_pause:
                    driver_eval_frame = layer_start_pause
                if total_frames - layer_end_pause > layer_start_pause:
                    if driver_eval_frame >= total_frames - layer_end_pause:
                        driver_eval_frame = total_frames - layer_end_pause - 1
                
                driver_eval_frame = driver_eval_frame - layer_start_pause - layer_offset

                # Draw each point in this layer with the layer's driver offset applied
                for point_idx, point in enumerate(static_points):
                    driver_offset_x = driver_offset_y = 0.0
                    driver_frame_index = 0

                    driver_type = None
                    driver_pivot = None
                    driver_scale_profile = None

                    if layer_driver_info and isinstance(layer_driver_info, dict):
                        driver_offset_x, driver_offset_y = _accumulate_driver_offsets(layer_driver_info, driver_eval_frame)
                        driver_frame_index = _get_effective_frame(layer_driver_info, driver_eval_frame)
                        driver_type = layer_driver_info.get('driver_type')
                        driver_pivot = layer_driver_info.get('driver_pivot')
                        driver_scale_profile = layer_driver_info.get('driver_scale_profile')

                    try:
                        base_x = float(point['x'])
                        base_y = float(point['y'])
                    except (KeyError, TypeError, ValueError):
                        continue

                    # Per-point scaling factors
                    try:
                        point_scale = float(point.get('pointScale', point.get('scale', 1.0)))
                    except (TypeError, ValueError):
                        point_scale = 1.0
                    try:
                        box_scale_factor = float(point.get('boxScale', 1.0))
                    except (TypeError, ValueError):
                        box_scale_factor = 1.0

                    # Default: no positional scaling, just translation
                    scaled_x = base_x
                    scaled_y = base_y

                    # Apply independent scale-out when driven by a box
                    if driver_type == 'box' and driver_pivot is not None and driver_scale_profile:
                        pivot_x, pivot_y = driver_pivot
                        pivot_normalized = layer_driver_info.get('driver_path_normalized', True)
                        if pivot_normalized:
                            pivot_x *= frame_width
                            pivot_y *= frame_height

                        boxScale0 = 1.0
                        try:
                            if len(driver_scale_profile) > 0:
                                boxScale0 = float(driver_scale_profile[0]) or 1.0
                        except (TypeError, ValueError):
                            boxScale0 = 1.0

                        try:
                            if driver_frame_index < len(driver_scale_profile):
                                boxScale_f = float(driver_scale_profile[driver_frame_index])
                            else:
                                boxScale_f = float(driver_scale_profile[-1])
                        except (TypeError, ValueError):
                            boxScale_f = boxScale0

                        if boxScale0 != 0.0:
                            R_box = boxScale_f / boxScale0
                        else:
                            R_box = 1.0

                        # Per-point relative scale
                        R_point = 1.0 + (R_box - 1.0) * point_scale * box_scale_factor

                        dx0 = base_x - pivot_x
                        dy0 = base_y - pivot_y
                        scaled_x = pivot_x + dx0 * R_point
                        scaled_y = pivot_y + dy0 * R_point

                    # Finally, apply pure translation from the driver
                    location_x = scaled_x + driver_offset_x
                    location_y = scaled_y + driver_offset_y

                    # Draw the shape at the computed location using the helper method
                    self._draw_shape_at_location(draw, location_x, location_y, shape,
                                               static_width, static_height, shape_color,
                                               border_width, border_color)

        # Draw animated paths
        # Animated paths contain sequences of coordinates that change over time
        # Each path represents the motion of a shape through the frames
        for path_idx, coords in enumerate(processed_coords_list):
            if not isinstance(coords, list) or len(coords) == 0:
                continue

            # Skip rendering for hidden layers but keep them available for driver calculations
            if layer_visibility and path_idx < len(layer_visibility) and not layer_visibility[path_idx]:
                continue

            # Check if this is a points-type layer with driver info
            # Points mode means the layer contains multiple points that should all be drawn simultaneously
            # rather than a single coordinate that changes over time
            is_points_mode_with_driver = (
                coords_driver_info_list and
                path_idx < len(coords_driver_info_list) and
                coords_driver_info_list[path_idx] and
                coords_driver_info_list[path_idx].get('is_points_mode', False)
            )

            if is_points_mode_with_driver:
                driver_info = coords_driver_info_list[path_idx]
                driver_offset_x = driver_offset_y = 0.0
                eff_frame = 0
                print(f"[DriverDebug] points branch idx={path_idx} layer={driver_info.get('layer_name')} target={driver_info.get('driver_layer_name')}")
                if driver_info:
                    driver_offset_x, driver_offset_y = _accumulate_driver_offsets(driver_info, frame_index)
                    eff_frame = _get_effective_frame(driver_info, frame_index)

                # Apply per-path scale if scales_list is provided
                path_current_width = float(shape_width)
                path_current_height = float(shape_height)
                if scales_list and path_idx < len(scales_list):
                    scale = float(scales_list[path_idx])
                    path_current_width *= scale
                    path_current_height *= scale
                
                driver_pivot = driver_info.get('driver_pivot') if driver_info else None
                driver_scale = (
                    get_driver_scale_for_frame(driver_info, eff_frame, DRIVER_SCALE_FACTOR)
                    if driver_info
                    else 1.0
                )

                # Draw all points with the same driver offset
                for point in coords:
                    try:
                        location_x = point['x'] + driver_offset_x
                        location_y = point['y'] + driver_offset_y
                    except (KeyError, TypeError):
                        continue

                    # Draw the shape at the computed location using the helper method
                    self._draw_shape_at_location(draw, location_x, location_y, shape,
                                               path_current_width, path_current_height, shape_color,
                                               border_width, border_color)
            else:
                # Regular path drawing (non-points or points without driver)
                # Determine which coordinate from the path should be used for this frame
                # This handles pausing at the start and end of path animations
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

                # Apply driver offset for animated paths if driver info is present
                driver_offset_x = driver_offset_y = 0.0
                driver_info = None
                driver_type = None
                is_box_driver = False
                eff_frame3 = 0
                if coords_driver_info_list and path_idx < len(coords_driver_info_list):
                    driver_info = coords_driver_info_list[path_idx]
                    driver_type = driver_info.get('driver_type') if driver_info else None
                    is_box_driver = driver_type == 'box'
                    if driver_info and not driver_info.get('is_points_mode', False):
                        driver_offset_x, driver_offset_y = _accumulate_driver_offsets(driver_info, frame_index)
                        eff_frame3 = _get_effective_frame(driver_info, frame_index)

                location_x += driver_offset_x
                location_y += driver_offset_y

                # Apply per-path scale if scales_list is provided
                path_current_width = float(shape_width)
                path_current_height = float(shape_height)
                if scales_list and path_idx < len(scales_list):
                    scale = float(scales_list[path_idx])
                    path_current_width *= scale
                    path_current_height *= scale

                # Driver offsets are now pre-applied to processed_coords_list in drawshapemask
                # No need to apply them again here
                # This ensures the driven layer's interpolation is preserved and the driver offset is added on top

                # Draw the shape at the computed location using the helper method
                self._draw_shape_at_location(draw, location_x, location_y, shape,
                                           path_current_width, path_current_height, shape_color,
                                           border_width, border_color)

        if blur_radius and blur_radius > 0.0:
            image = image.filter(ImageFilter.GaussianBlur(blur_radius))

        return image

    def _draw_splines_on_preview(self, preview_tensor: torch.Tensor, processed_coords_list: List[Path],
                                 path_pause_frames: List[Tuple[int, int]], total_frames: int,
                                 coords_driver_info_list: Optional[List[Optional[Dict[str, Any]]]] = None,
                                 static_point_layers: Optional[List[List[Coord]]] = None,
                                 static_points_use_driver: bool = False,
                                 static_points_driver_path: Optional[Path] = None,
                                 start_p_frames_meta=0, end_p_frames_meta=0,
                                 static_points_driver_info_list: Optional[List[Optional[Dict[str, Any]]]] = None,
                                 static_points_interpolated_drivers: Optional[List[Dict[str, Any]]] = None,
                                 frame_width: int = DEFAULT_FRAME_WIDTH, frame_height: int = DEFAULT_FRAME_HEIGHT,
                                 layer_visibility: Optional[List[bool]] = None) -> torch.Tensor:
        """
        Draw thin orange splines on the preview frames to visualize the paths.
        Works on already scaled (50%) preview tensor in BHWC format.
        Returns modified tensor.
        """
        batch_size, scaled_height, scaled_width, channels = preview_tensor.shape
        scale_factor = PREVIEW_SCALE_FACTOR  # Preview is scaled to 50%

        # Convert tensor to list of PIL images for drawing
        preview_pil_list = []
        for i in range(batch_size):
            frame_np = (preview_tensor[i].cpu().numpy() * 255).astype('uint8')
            pil_img = Image.fromarray(frame_np, mode='RGB')
            preview_pil_list.append(pil_img)

        # Return input tensor unchanged, no preview lines drawn
        return preview_tensor

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
            Optional[str], Optional[str], Optional[str], Dict[str, Any]]:
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
            "easing_functions": 'linear',
            "easing_paths": 'full',
            "easing_strengths": 1.0,
            "scales": 1.0,
            "drivers": None,
            "p_coordinates_use_driver": False,
            "static_points_driver_path": None,
            "static_points_driver_smooth": 0.0,
            "coord_width": None,
            "coord_height": None,
            "names": {"p": [], "c": [], "b": []},
            "types": {"p": [], "c": [], "b": []},
            "visibility": {"p": [], "c": [], "b": []},
        }
        coordinates_data = None
        p_coordinates_data = None
        box_coordinates_data = None

        try:
            parsed = self._safe_json_load(coordinates_str)
            if isinstance(parsed, dict):
                # Extract common fields safely
                if "coordinates" in parsed:
                    coordinates_data = json.dumps(parsed["coordinates"])
                if "p_coordinates" in parsed:
                    p_coordinates_data = json.dumps(parsed["p_coordinates"])
                if "box_coordinates" in parsed:
                    box_coordinates_data = json.dumps(parsed["box_coordinates"])
                for k in ("start_p_frames", "end_p_frames", "offsets", "interpolations", "easing_functions", "easing_paths", "easing_strengths", "accelerations", "scales", "drivers", "p_coordinates_use_driver", "static_points_driver_path", "static_points_driver_smooth", "coord_width", "coord_height"):
                    if k in parsed:
                        metadata[k] = parsed[k]
                for k in ("names", "types", "visibility"):
                    if k in parsed:
                        metadata[k] = parsed[k]
            else:
                # Not an object: treat as raw coordinates
                coordinates_data = coordinates_str
        except Exception:
            # Fall back to treating string as raw coordinates
            coordinates_data = coordinates_str

        return coordinates_data, p_coordinates_data, box_coordinates_data, metadata

    def _parse_animated_paths(self, data_str: Optional[str], label: str) -> List[Path]:
        """
        Parse a JSON string representing animated paths. Returns a list of paths (each is a list of coords).
        Raises ValueError if the format isn't recognized.
        """
        if not data_str:
            return []

        parsed = self._safe_json_load(data_str)
        if isinstance(parsed, list):
            if len(parsed) == 0:
                return []
            first = parsed[0]
            if isinstance(first, list):
                return parsed
            if isinstance(first, dict):
                return [parsed]
        raise ValueError(f"Unexpected coordinate format for {label}")
    def _parse_static_points(self, p_coordinates_json: Optional[str]) -> List[List[Coord]]:
        """
        Parse static p_coordinates JSON string into a list of point layers.
        Each layer is a list of coordinate dicts.
        Returns [] if none or invalid.
        """
        if not p_coordinates_json:
            return []

        static_point_layers: List[List[Coord]] = []
        try:
            parsed = self._safe_json_load(p_coordinates_json)
            if isinstance(parsed, list):
                # Could be list of dicts or list of lists
                if parsed and isinstance(parsed[0], dict):
                    # Single layer of points
                    layer = []
                    for p in parsed:
                        if isinstance(p, dict) and 'x' in p and 'y' in p:
                            layer.append({'x': float(p['x']), 'y': float(p['y']), **{k: v for k, v in p.items() if k not in ('x', 'y')}})
                    static_point_layers.append(layer)
                else:
                    # Multiple layers - preserve structure
                    for sub in parsed:
                        if isinstance(sub, list):
                            layer = []
                            for p in sub:
                                if isinstance(p, dict) and 'x' in p and 'y' in p:
                                    layer.append({'x': float(p['x']), 'y': float(p['y']), **{k: v for k, v in p.items() if k not in ('x', 'y')}})
                            static_point_layers.append(layer)
                        elif isinstance(sub, list) and not sub:
                            static_point_layers.append([])
                        elif isinstance(sub, dict) and 'x' in sub and 'y' in sub:
                            # Single point as a layer
                            static_point_layers.append([{'x': float(sub['x']), 'y': float(sub['y']), **{k: v for k, v in sub.items() if k not in ('x', 'y')}}])
        except Exception:
            # On any parse error, return empty list
            return []
        return static_point_layers

    def _extract_layer_names(self, meta: Dict[str, Any], key: str, count: int,
                             fallback_prefix: str = "Layer ") -> List[str]:
        """
        Extract layer names for animated or static layers based on metadata.
        Falls back to deterministic names when metadata is missing.
        """
        result: List[str] = []
        names_meta = meta.get("names")
        if isinstance(names_meta, dict):
            raw_names = names_meta.get(key, [])
            if isinstance(raw_names, list):
                result = [str(name) for name in raw_names[:count]]
        while len(result) < count:
            result.append(f"{fallback_prefix}{len(result) + 1}")
        return result

    def _compute_frame_dimensions(self, bg_image: torch.Tensor) -> Tuple[int, int]:
        """
        Extract width and height from bg_image tensor (expected BHWC).
        Returns (width, height), defaults to (512, 512) on error.
        """
        try:
            _, frame_height, frame_width, _ = bg_image.shape
            return frame_width, frame_height
        except Exception:
            return DEFAULT_FRAME_WIDTH, DEFAULT_FRAME_HEIGHT

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

            # Trailing effect - 0.0 = no trailing, 1.0 = max trailing
            if trailing > 0.0 and previous_output_chw is not None:
                try:
                    if previous_output_chw.device != image_tensor_chw.device:
                        previous_output_chw = previous_output_chw.to(image_tensor_chw.device)
                    image_tensor_chw = image_tensor_chw + trailing * previous_output_chw
                    image_tensor_chw = torch.clamp(image_tensor_chw, 0.0, 1.0)
                except Exception:
                    pass

            previous_output_chw = image_tensor_chw.clone() if trailing > 0.0 else None

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
    def drawshapemask(self, coordinates, bg_image,
                      shape_width, shape_height, shape_color, bg_color, blur_radius, shape, intensity, static_fade_start, animated_fade_start,
                      trailing=1.0, border_width=0, border_color='black', frames=None, preview_enabled=True):
        """
        Main entry point. Orchestrates:
         - Parsing coordinates + metadata
         - Scaling coordinates to frame dimensions
         - Interpolating/resampling coordinate paths
         - Rendering frames in parallel (PIL)
         - Post-processing tensors, masks, and optional trailing/intensity
         - Returning (images, masks, json_coords_string)
        """

        # ----- Use passed parameters -----
        total_frames = int(frames) if frames is not None else DEFAULT_TOTAL_FRAMES
        # Note: easing_function, easing_path, and easing_strength are now passed directly as parameters

        # ----- Parse coordinate metadata & static points -----
        coordinates_data, p_coordinates_data, box_coordinates_data, meta = self._parse_coordinate_metadata(coordinates)
        static_point_layers = self._parse_static_points(p_coordinates_data)

        # Driver metadata for static points (older and newer logic)
        static_points_use_driver = bool(meta.get("p_coordinates_use_driver", False))
        static_points_driver_path_raw = meta.get("static_points_driver_path", None)
        static_points_driver_smooth = float(meta.get("static_points_driver_smooth", 0.0))

        # Store driver info for each static point path (for points layers)
        num_static_point_layers = len(static_point_layers)
        static_points_driver_info_list: List[Optional[Dict[str, Any]]] = [None] * num_static_point_layers

        # Attempt to find a driver path inside drivers metadata if present
        if isinstance(meta.get("drivers"), dict):
            p_drivers = meta["drivers"].get("p")
            # Check if we have drivers for static points
            if isinstance(p_drivers, list) and p_drivers:
                # Process each driver for static points, preserving layer order
                for idx in range(min(num_static_point_layers, len(p_drivers))):
                    driver_info = p_drivers[idx]
                    if isinstance(driver_info, dict) and isinstance(driver_info.get('path'), list) and driver_info['path']:
                        static_points_driver_info_list[idx] = driver_info
                        if not static_points_driver_path_raw:
                            # Keep the first one for backward compatibility
                            static_points_driver_path_raw = driver_info['path']
                        static_points_use_driver = True
                    else:
                        static_points_driver_info_list[idx] = None

        # ----- Frame dimensions and scaling -----
        frame_width, frame_height = self._compute_frame_dimensions(bg_image)
        coord_width = meta.get("coord_width", None)
        coord_height = meta.get("coord_height", None)

        _drivers_meta, refreshed_static_info = scale_driver_metadata(
            meta,
            coord_width,
            coord_height,
            frame_width,
            frame_height,
            static_points_use_driver,
            num_static_point_layers,
        )
        if refreshed_static_info is not None:
            static_points_driver_info_list = refreshed_static_info

        # Scale static points and static_points_driver_path if necessary
        static_point_layers, static_points_driver_path_processed, static_driver_normalized = scale_points_and_driver_path(
            static_point_layers, static_points_driver_path_raw, coord_width, coord_height, frame_width, frame_height
        )

        # Interpolate static_points_driver_path to total_frames and apply smoothing
        # For static points, use the easing parameters from metadata
        easing_function = meta.get("easing_functions", "in_out")
        easing_path = meta.get("easing_paths", "full")
        easing_strength = meta.get("easing_strengths", 1.0)

        # Store interpolated driver paths for each static point layer
        static_points_interpolated_drivers: List[Optional[Dict[str, Any]]] = []
        static_layer_names = self._extract_layer_names(meta, "p", num_static_point_layers, "P-Layer ")

        if static_points_use_driver and static_points_driver_info_list:
            static_points_interpolated_drivers = [None] * len(static_points_driver_info_list)
            for idx, driver_info in enumerate(static_points_driver_info_list):
                if driver_info and isinstance(driver_info, dict):
                    driver_path = driver_info.get('path')
                    driver_d_scale = driver_info.get('d_scale', DRIVER_SCALE_FACTOR)

                    # Use driver's own interpolation parameters if available, otherwise fall back to defaults
                    driver_easing_function = driver_info.get('easing_function', easing_function)
                    driver_easing_path = driver_info.get('easing_path', easing_path)
                    driver_easing_strength = driver_info.get('easing_strength', easing_strength)

                    if driver_path and len(driver_path) > 0:
                        interpolated = process_driver_path(
                            driver_path, total_frames, static_points_driver_smooth,
                            driver_easing_function, driver_easing_path, driver_easing_strength, TRAILING_WEIGHT_FACTOR
                        )
                        if interpolated:
                            scale_profile = driver_info.get('driver_scale_profile', [])
                            resampled_scale_profile = resample_scale_profile(
                                scale_profile, len(interpolated),
                                driver_easing_function, driver_easing_strength
                            )
                            static_scale = float(resampled_scale_profile[-1]) if resampled_scale_profile else float(driver_info.get('driver_scale_factor', DRIVER_SCALE_FACTOR))
                            driver_pivot = driver_info.get('driver_pivot')
                            if not driver_pivot and isinstance(interpolated[0], dict):
                                try:
                                    driver_pivot = (
                                        float(interpolated[0].get('x', 0.0)),
                                        float(interpolated[0].get('y', 0.0))
                                    )
                                except (TypeError, ValueError):
                                    driver_pivot = None

                            static_points_interpolated_drivers[idx] = {
                                'path': interpolated,
                                'd_scale': driver_d_scale,
                                'easing_function': driver_easing_function,
                                'easing_path': driver_easing_path,
                                'easing_strength': driver_easing_strength,
                                # Propagate driver's timing if present
                                'start_pause': int(driver_info.get('start_pause', 0)),
                                'end_pause': int(driver_info.get('end_pause', 0)),
                                'offset': int(driver_info.get('offset', 0)),
                                'driver_scale_profile': resampled_scale_profile,
                                'driver_scale_factor': static_scale,
                                'driver_pivot': driver_pivot,
                                'driver_type': driver_info.get('driver_type'),
                                'driver_radius_delta': driver_info.get('driver_radius_delta', 0.0),
                                'driver_path_normalized': static_driver_normalized,
                                'driver_layer_name': driver_info.get('driver_layer_name')
                            }
                            static_points_interpolated_drivers[idx]['layer_name'] = static_layer_names[idx] if idx < len(static_layer_names) else f"P-Layer {idx + 1}"
                            static_points_interpolated_drivers[idx]['driver_path_key'] = 'path'
        elif static_points_use_driver and static_points_driver_path_processed:
            # Use the single driver for all layers (legacy mode)
            interpolated_profile = resample_scale_profile(
                [], len(static_points_driver_path_processed),
                easing_function, easing_strength
            )
            legacy_scale_factor = float(interpolated_profile[-1]) if interpolated_profile else DRIVER_SCALE_FACTOR
            legacy_pivot = None
            if isinstance(static_points_driver_path_processed, list) and static_points_driver_path_processed:
                first_pt = static_points_driver_path_processed[0]
                if isinstance(first_pt, dict):
                    try:
                        legacy_pivot = (
                            float(first_pt.get('x', 0.0)),
                            float(first_pt.get('y', 0.0))
                        )
                    except (TypeError, ValueError):
                        legacy_pivot = None
            legacy_driver = {
                'path': static_points_driver_path_processed,
                'd_scale': DRIVER_SCALE_FACTOR,  # No scaling for legacy single driver
                'easing_function': easing_function,
                'easing_path': easing_path,
                'easing_strength': easing_strength,
                'driver_scale_profile': interpolated_profile,
                'driver_scale_factor': legacy_scale_factor,
                'driver_type': None,
                'driver_pivot': legacy_pivot,
                'driver_radius_delta': 0.0,
                'driver_path_normalized': static_driver_normalized,
                'driver_layer_name': None
            }
            if num_static_point_layers > 0:
                static_points_interpolated_drivers = []
                for idx in range(num_static_point_layers):
                    driver_copy = legacy_driver.copy()
                    driver_copy['layer_name'] = static_layer_names[idx] if idx < len(static_layer_names) else f"P-Layer {idx + 1}"
                    driver_copy['driver_path_key'] = 'path'
                    static_points_interpolated_drivers.append(driver_copy)
            else:
                legacy_driver['layer_name'] = static_layer_names[0] if static_layer_names else "P-Layer 1"
                legacy_driver['driver_path_key'] = 'path'
                static_points_interpolated_drivers = [legacy_driver]
        else:
            static_points_interpolated_drivers = []

        # Defer applying driver chain offsets for static layers until after animated paths are processed

        # Code-side fallback: automatically enable static_points_use_driver if drivers.p exists
        if isinstance(meta.get("drivers"), dict) and meta["drivers"].get("p"):
            static_points_use_driver = True

        if static_points_use_driver and static_points_driver_path_processed:
            static_points_driver_path_processed = process_driver_path(
                static_points_driver_path_processed,
                total_frames,
                static_points_driver_smooth,
                easing_function,
                easing_path,
                easing_strength,
                TRAILING_WEIGHT_FACTOR,
            )

        try:
            coords_list_raw = self._parse_animated_paths(coordinates_data, "coordinates")
            # Box coordinates are only used indirectly via drivers.meta['path'],
            # so we don't merge them into the animated path list for drawing.
            _ = self._parse_animated_paths(box_coordinates_data, "box coordinates")
        except Exception:
            empty_image = torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32)
            empty_mask = torch.zeros([1, frame_height, frame_width], dtype=torch.float32)
            empty_preview = torch.zeros([1, 1, 1, 3], dtype=torch.float32)
            return (empty_image, empty_mask, "[]", empty_preview)
        layer_names = normalize_layer_names(meta, len(coords_list_raw), names_key="c", fallback_prefix="Layer")
        coord_types_raw = meta.get("types", {}).get("c", [])
        coord_types = list(coord_types_raw) if isinstance(coord_types_raw, list) else []
        coord_visibility_meta = meta.get("visibility", {})
        coord_visibility_list: List[bool] = []
        if isinstance(coord_visibility_meta, dict):
            raw_vis = coord_visibility_meta.get("c")
            if isinstance(raw_vis, list):
                coord_visibility_list = [bool(v) for v in raw_vis[:len(coords_list_raw)]]
            elif isinstance(raw_vis, (bool, int)):
                coord_visibility_list = [bool(raw_vis)] * len(coords_list_raw)
        if len(coord_visibility_list) < len(coords_list_raw):
            coord_visibility_list.extend([True] * (len(coords_list_raw) - len(coord_visibility_list)))

        static_points_visibility_list: List[bool] = []
        if isinstance(coord_visibility_meta, dict):
            raw_vis = coord_visibility_meta.get("p")
            if isinstance(raw_vis, list):
                static_points_visibility_list = [bool(v) for v in raw_vis[:num_static_point_layers]]
            elif isinstance(raw_vis, (bool, int)):
                static_points_visibility_list = [bool(raw_vis)] * num_static_point_layers
        if len(static_points_visibility_list) < num_static_point_layers:
            static_points_visibility_list.extend([True] * (num_static_point_layers - len(static_points_visibility_list)))

        box_paths_count = 0


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
        # Handle different formats for easing parameters - could be single values, lists, or objects
        easing_functions_meta = meta.get("easing_functions", "in_out")
        easing_paths_meta = meta.get("easing_paths", "full")
        easing_strengths_meta = meta.get("easing_strengths", 1.0)
        accelerations_meta = meta.get("accelerations", 0.00)
        
        # Get interpolations metadata to check for points mode
        interpolations_meta = meta.get("interpolations", 'linear')
        
        processed_coords_list, path_pause_frames, coords_driver_info_list, scales_list = build_interpolated_paths(
            coords_list_raw, total_frames,
            meta.get("start_p_frames", 0), meta.get("end_p_frames", 0),
            meta.get("offsets", 0), interpolations_meta,
            meta.get("drivers", None),
            easing_functions_meta,
            easing_paths_meta,
            easing_strengths_meta,
            meta.get("scales", 1.0),
            accelerations_meta,
            box_prefix_count=0,
            coord_width=coord_width, coord_height=coord_height, frame_width=frame_width, frame_height=frame_height,
            meta=meta,
            layer_names_override=layer_names,
            layer_types_override=coord_types
        )

        # Normalize interpolations list to check for points mode
        num_paths = len(processed_coords_list)
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
        
        # Apply driver offsets to processed coordinates after they've been interpolated with their own easing
        # This ensures that the driven layer's interpolation is preserved and the driver offset is added on top
        for path_idx, coords in enumerate(processed_coords_list):
            if path_idx < len(coords_driver_info_list) and coords_driver_info_list[path_idx]:
                driver_info = coords_driver_info_list[path_idx]
                if driver_info and isinstance(driver_info, dict):
                    interpolated_driver = driver_info.get('interpolated_path')
                    driver_pause_frames = driver_info.get('pause_frames', (0, 0))
                    d_scale = driver_info.get('d_scale', 1.0)
                    if interpolated_driver and len(interpolated_driver) > 0:
                        sanitized_info = dict(driver_info)
                        sanitized_info['interpolated_path'] = interpolated_driver
                        sanitized_info['pause_frames'] = driver_pause_frames
                        sanitized_info['d_scale'] = d_scale
                        sanitized_info['easing_function'] = driver_info.get('easing_function', 'linear')
                        sanitized_info['easing_path'] = driver_info.get('easing_path', 'full')
                        sanitized_info['easing_strength'] = driver_info.get('easing_strength', 1.0)
                        sanitized_info['start_pause'] = int(driver_info.get('start_pause', 0))
                        sanitized_info['end_pause'] = int(driver_info.get('end_pause', 0))
                        sanitized_info['offset'] = int(driver_info.get('offset', 0))
                        sanitized_info['driver_scale_factor'] = driver_info.get('driver_scale_factor', 1.0)
                        sanitized_info['driver_scale_profile'] = driver_info.get('driver_scale_profile')
                        sanitized_info['driver_pivot'] = driver_info.get('driver_pivot')
                        sanitized_info['driver_type'] = driver_info.get('driver_type')
                        sanitized_info['driver_path_normalized'] = driver_info.get('driver_path_normalized', True)
                        sanitized_info['driver_layer_name'] = driver_info.get('driver_layer_name')
                        sanitized_info['driver_path_key'] = 'interpolated_path'
                        sanitized_info['layer_name'] = layer_names[path_idx]
                        print(f"[DriverDebug] sanitized layer={layer_names[path_idx]} driver_target={sanitized_info['driver_layer_name']} is_points={sanitized_info['is_points_mode']}")

                        # Check if this is a "points" type layer
                        layer_type = coord_types[path_idx] if path_idx < len(coord_types) else ''
                        sanitized_info['is_points_mode'] = ((path_idx < len(interpolations_list) and interpolations_list[path_idx] == 'points') or layer_type == 'points')
                        coords_driver_info_list[path_idx] = sanitized_info

        base_layer_path_map = build_layer_path_map(layer_names, processed_coords_list)
        resolved_driver_paths = apply_driver_chain_offsets(
            meta, coords_driver_info_list, total_frames,
            names_key="c", path_key="interpolated_path", fallback_prefix="Layer",
            resolved_paths=base_layer_path_map
        )

        if static_points_interpolated_drivers:
            # Seed resolved paths with any referenced box (or other) driver world paths
            # so points layers can follow the parent's world motion even when the parent
            # isn't in the animated ('c') set.
            for entry in static_points_interpolated_drivers:
                if not isinstance(entry, dict):
                    continue
                ref_name = entry.get('driver_layer_name')
                if ref_name and ref_name not in resolved_driver_paths:
                    p = entry.get('path')
                    if isinstance(p, list) and p:
                        try:
                            sanitized = []
                            for pt in p:
                                if isinstance(pt, dict):
                                    sanitized.append({
                                    'x': round_coord(pt.get('x', 0.0)),
                                    'y': round_coord(pt.get('y', 0.0))
                                    })
                            if sanitized:
                                resolved_driver_paths[ref_name] = sanitized
                        except Exception:
                            pass

            resolved_driver_paths = apply_driver_chain_offsets(
                meta, static_points_interpolated_drivers, total_frames,
                names_key="p", path_key="path", fallback_prefix="P-Layer",
                resolved_paths=resolved_driver_paths
            )
            print(f"[DriverDebug] resolved static drivers: {list(resolved_driver_paths.keys())}")
        
        # Extract scale for static points (p_coordinates) from scales metadata
        scales_meta = meta.get("scales", 1.0)
        static_points_scale = 1.0
        static_points_scales_list = None  # Per-layer scales for p_coordinates

        if isinstance(scales_meta, dict):
            # New format: {"p": [...], "c": [...]} where "p" is for static points
            p_scales = scales_meta.get("p", [1.0])
            if isinstance(p_scales, list) and len(p_scales) > 0:
                static_points_scale = float(p_scales[0])
                static_points_scales_list = p_scales  # Store full list for per-layer scaling
            elif isinstance(p_scales, (int, float)):
                static_points_scale = float(p_scales)
        elif isinstance(scales_meta, (int, float)):
            # Single value for both static and animated (fallback)
            static_points_scale = float(scales_meta)
        elif isinstance(scales_meta, list):
            # List format: first value for static points
            static_points_scale = float(scales_meta[0]) if scales_meta else 1.0

        # Special cases: no animated coords but static point layers exist -> set batch size accordingly
        if not processed_coords_list:
            if static_point_layers:
                # Always use total_frames for static points to ensure proper spline generation
                batch_size = total_frames
                processed_coords_list = []
                path_pause_frames = []
            else:
                # No input to render - return empty tensors
                empty_image = torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32)
                empty_mask = torch.zeros([1, frame_height, frame_width], dtype=torch.float32)
                empty_preview = torch.zeros([1, 1, 1, 3], dtype=torch.float32)  # 1x1 pixel for efficiency
                return (empty_image, empty_mask, "[]", empty_preview)  # preview instead of frames

        # ----- Frame Generation (PIL) in threads -----
        batch_size = total_frames
        pil_images: List[Optional[Image.Image]] = [None] * batch_size

        # Prepare arguments for thread execution
        args_list = []
        # Build per-layer pause frames list for static points (p branch)
        num_static_layers = len(static_point_layers) if static_point_layers else 0
        p_start_meta = meta.get("start_p_frames", 0)
        p_end_meta = meta.get("end_p_frames", 0)
        p_offsets_meta = meta.get("offsets", 0)
        def to_list(meta_val):
            if isinstance(meta_val, dict):
                val = meta_val.get("p", 0)
            else:
                val = meta_val
            if isinstance(val, list):
                out = val
            else:
                out = [val] * max(1, num_static_layers)
            # pad or trim
            if len(out) < num_static_layers:
                out = out + [0] * (num_static_layers - len(out))
            elif len(out) > num_static_layers:
                out = out[:num_static_layers]
            # ensure ints
            cleaned = []
            for x in out:
                try:
                    cleaned.append(int(x))
                except (ValueError, TypeError):
                    cleaned.append(0)
            return cleaned
        p_start_list = to_list(p_start_meta) if num_static_layers else []
        p_end_list = to_list(p_end_meta) if num_static_layers else []
        p_offsets_list = to_list(p_offsets_meta) if num_static_layers else []
        static_points_pause_frames_list = [(p_start_list[i], p_end_list[i]) for i in range(num_static_layers)] if num_static_layers else []

        for i in range(batch_size):
            args_list.append((
                i, processed_coords_list, path_pause_frames, total_frames,
                frame_width, frame_height, shape_width, shape_height,
                shape_color, bg_color, blur_radius, shape, border_width, border_color,
                static_point_layers, static_points_use_driver, static_points_driver_path_processed,
                static_points_pause_frames_list, coords_driver_info_list, scales_list,
                static_points_scale, static_points_scales_list,
                static_points_driver_info_list, static_points_interpolated_drivers,
                resolved_driver_paths, coord_visibility_list, p_offsets_list, static_points_visibility_list
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

        # Note: Preview will be created after building ATI tracks (below)

        # ----- Build output coordinates JSON (format expected by ATI nodes) -----
        # Follow the same format as WanVideoATITracksVisualize
        # Generate coordinate tracks with visibility in the third component
        output_coords_json = "[]"
        all_coords = []
        
        # Process animated paths (affected by animated_fade_start)
        if processed_coords_list:
            try:
                # Calculate the fade start frame by multiplying percentage by total frames
                fade_start_frame = int(animated_fade_start * total_frames) if animated_fade_start > 0 else 0
                
                for path_idx, path_coords in enumerate(processed_coords_list):
                    # Check layer visibility toggle
                    if coord_visibility_list and path_idx < len(coord_visibility_list) and not coord_visibility_list[path_idx]:
                        continue

                    path_start_p, path_end_p = path_pause_frames[path_idx]
                    single_path_coords = []

                    # Base position for this path: first key as P0
                    base_coord0 = path_coords[0] if path_coords else {"x": 0.0, "y": 0.0}
                    P0x = float(base_coord0.get("x", 0.0))
                    P0y = float(base_coord0.get("y", 0.0))

                    # Box driver path + scale profile, if this layer is driven by a box
                    box_path = None
                    box_scale_profile = None
                    B0x = B0y = 0.0
                    S0 = 1.0
                    if coords_driver_info_list and path_idx < len(coords_driver_info_list):
                        base_driver_info = coords_driver_info_list[path_idx]
                        if isinstance(base_driver_info, dict) and base_driver_info.get("driver_type") == "box":
                            box_path = base_driver_info.get("interpolated_path") or base_driver_info.get("path")
                            box_scale_profile = base_driver_info.get("driver_scale_profile")
                            if box_path:
                                try:
                                    B0x = float(box_path[0].get("x", 0.0))
                                    B0y = float(box_path[0].get("y", 0.0))
                                except (TypeError, ValueError):
                                    B0x = B0y = 0.0
                            if isinstance(box_scale_profile, list) and box_scale_profile:
                                try:
                                    S0 = float(box_scale_profile[0]) or 1.0
                                except (TypeError, ValueError):
                                    S0 = 1.0
                    for i in range(total_frames):
                        if i < path_start_p:
                            coord_index = 0
                        elif i >= total_frames - path_end_p:
                            coord_index = len(path_coords) - 1
                        else:
                            coord_index = i - path_start_p
                        coord_index = max(0, min(coord_index, len(path_coords) - 1))
                        
                        # Extract x, y and apply driver offset if present
                        coord = path_coords[coord_index]
                        driver_offset_x = driver_offset_y = 0.0
                        interpolated_driver = None
                        d_scale = DRIVER_SCALE_FACTOR
                        driver_info = None
                        driver_type = None
                        is_box_driver = False
                        eff_frame = 0
                        if coords_driver_info_list and path_idx < len(coords_driver_info_list):
                            driver_info = coords_driver_info_list[path_idx]
                            driver_type = driver_info.get('driver_type') if driver_info else None
                            is_box_driver = driver_type == 'box'
                            if driver_info and not driver_info.get('is_points_mode', False):
                                interpolated_driver = driver_info.get('interpolated_path')
                                d_scale = driver_info.get('d_scale', 1.0)

                        if interpolated_driver and len(interpolated_driver) > 0:
                            driver_start_p = int(driver_info.get('start_pause', 0))
                            driver_offset_val = int(driver_info.get('offset', 0))
                            pos_delay = driver_start_p + max(0, driver_offset_val)
                            neg_lead = -min(0, driver_offset_val)
                            eff_frame = max(0, i - pos_delay + neg_lead)

                            if not is_box_driver:
                                # Original behavior for non-box drivers: offset relative to driver's first point
                                driver_offset_x, driver_offset_y = calculate_driver_offset(
                                    eff_frame, interpolated_driver, (0, 0),
                                    total_frames, d_scale, frame_width, frame_height,
                                    driver_scale_factor=driver_info.get('driver_scale_factor', 1.0),
                                    driver_radius_delta=driver_info.get('driver_radius_delta', 0.0),
                                    driver_path_normalized=False,
                                    apply_scale_to_offset=True
                                )
                            else:
                                # Box drivers for animated paths: compute pure relative
                                # offset and relative scale around the path's own base
                                # position so points never snap to the box origin.
                                # We ignore calculate_driver_offset for this case and use
                                # the raw box path instead.
                                if box_path:
                                    box_idx = max(0, min(eff_frame, len(box_path) - 1))
                                    box_pt = box_path[box_idx]
                                    try:
                                        Bfx = float(box_pt.get("x", 0.0))
                                        Bfy = float(box_pt.get("y", 0.0))
                                    except (TypeError, ValueError):
                                        Bfx = B0x
                                        Bfy = B0y

                                    # Relative box offset from frame 0
                                    deltaBx = Bfx - B0x
                                    deltaBy = Bfy - B0y

                                    # Relative scale from frame 0
                                    if isinstance(box_scale_profile, list) and box_scale_profile and box_idx < len(box_scale_profile):
                                        try:
                                            Sf = float(box_scale_profile[box_idx])
                                        except (TypeError, ValueError):
                                            Sf = S0
                                    else:
                                        Sf = S0
                                    Rf = Sf / S0 if S0 != 0 else 1.0

                                    # Apply relative scale around P0, then add box offset
                                    raw_x = float(coord["x"])
                                    raw_y = float(coord["y"])
                                    location_x = P0x + (raw_x - P0x) * Rf + deltaBx
                                    location_y = P0y + (raw_y - P0y) * Rf + deltaBy
                                else:
                                    # Fallback: no box path, just use raw coord
                                    location_x = float(coord["x"])
                                    location_y = float(coord["y"])

                        # Non-box drivers or no driver: apply offset or use raw coord
                        if not is_box_driver:
                            location_x = float(coord["x"]) + driver_offset_x
                            location_y = float(coord["y"]) + driver_offset_y

                        # Determine visibility based on animated_fade_start
                        if animated_fade_start == 0 or i < fade_start_frame:
                            visibility = 1  # Visible
                        else:
                            visibility = 0  # Invisible after fade_start_frame
                        
                        single_path_coords.append({
                            "x": int(location_x),
                            "y": int(location_y),
                            "v": visibility
                        })
                    
                    # Convert to the format expected by ATI: [x, y, visibility]
                    # This will be further processed by the ATI node like WanVideoATITracksVisualize
                    all_coords.append(single_path_coords)
            except Exception:
                pass
        
        # Add driver preview tracks for box drivers so preview can draw their curve
        if coords_driver_info_list:
            for driver_info in coords_driver_info_list:
                if not isinstance(driver_info, dict):
                    continue
                if driver_info.get('driver_type') != 'box':
                    continue
                interpolated_driver = driver_info.get('interpolated_path')
                if not interpolated_driver:
                    continue
                driver_track = []
                normalized = driver_info.get('driver_path_normalized', True)
                for i in range(total_frames):
                    idx = min(i, len(interpolated_driver) - 1)
                    pt = interpolated_driver[idx]
                    try:
                        x = float(pt.get('x', 0.0))
                        y = float(pt.get('y', 0.0))
                    except (TypeError, ValueError):
                        continue
                    if normalized:
                        x *= frame_width
                        y *= frame_height
                    driver_track.append({
                        "x": int(x),
                        "y": int(y),
                        "v": 1
                    })
                if driver_track:
                    all_coords.append(driver_track)

        # Process static points (p_coordinates) - affected by static_fade_start
        if static_point_layers:
            preview_resolved_map = resolved_driver_paths or {}

            def _resolve_preview_driver_path(info: Optional[Dict[str, Any]], key: str):
                if not info or not isinstance(info, dict):
                    return info.get(key) if isinstance(info, dict) else None
                target = info.get('driver_layer_name')
                if target and target in preview_resolved_map:
                    info[key] = preview_resolved_map[target]
                    return info[key]
                return info.get(key)

            aligned_preview_static_drivers = bool(static_points_interpolated_drivers) and len(static_points_interpolated_drivers) == len(static_point_layers)
            first_preview_static_driver = None
            if static_points_interpolated_drivers:
                for entry in static_points_interpolated_drivers:
                    if isinstance(entry, dict):
                        first_preview_static_driver = entry
                        break
            try:
                # Calculate the fade start frame by multiplying percentage by total frames
                fade_start_frame = int(static_fade_start * total_frames) if static_fade_start > 0 else 0

                # Normalize per-layer pause frames for static points for preview generation (use 'p')
                prev_p_start = meta.get("start_p_frames", 0)
                prev_p_end = meta.get("end_p_frames", 0)
                def prev_to_list(val):
                    if isinstance(val, dict):
                        v = val.get("p", 0)
                    else:
                        v = val
                    if isinstance(v, list):
                        out = v
                    else:
                        out = [v] * (len(static_point_layers) if static_point_layers else 1)
                    return out
                prev_start_list_raw = prev_to_list(prev_p_start)
                prev_end_list_raw = prev_to_list(prev_p_end)
                # ensure lengths and ints
                L = len(static_point_layers) if static_point_layers else 0
                def clean_len_int(lst):
                    if L == 0:
                        return []
                    out = (lst or [])[:L] + [0] * max(0, L - len(lst or []))
                    cleaned = []
                    for x in out:
                        try:
                            cleaned.append(int(x))
                        except (ValueError, TypeError):
                            cleaned.append(0)
                    return cleaned
                prev_start_list = clean_len_int(prev_start_list_raw)
                prev_end_list = clean_len_int(prev_end_list_raw)

                # Process each layer of static points
                for layer_idx, static_points in enumerate(static_point_layers):
                    if not static_points:
                        continue

                    # Get this layer's specific timing
                    layer_start_pause = p_start_list[layer_idx] if layer_idx < len(p_start_list) else 0
                    layer_end_pause = p_end_list[layer_idx] if layer_idx < len(p_end_list) else 0
                    layer_offset = p_offsets_list[layer_idx] if layer_idx < len(p_offsets_list) else 0

                    # Check layer visibility toggle
                    layer_is_visible = static_points_visibility_list[layer_idx] if static_points_visibility_list and layer_idx < len(static_points_visibility_list) else True
                    if not layer_is_visible:
                        continue # Skip this layer if toggled off

                    # Get the driver for this layer if available
                    layer_driver_info = None
                    if static_points_use_driver and static_points_interpolated_drivers:
                        if layer_idx < len(static_points_interpolated_drivers):
                            layer_driver_info = static_points_interpolated_drivers[layer_idx]
                        if layer_driver_info is None and not aligned_preview_static_drivers:
                            layer_driver_info = first_preview_static_driver

                    # Process each point in this layer
                    for point_idx, point in enumerate(static_points):
                        single_point_spline = []
                        for i in range(total_frames):
                            # Calculate the adjusted frame index for the driver based on the points layer's timing
                            driver_eval_frame = i
                            if driver_eval_frame < layer_start_pause:
                                driver_eval_frame = layer_start_pause
                            if total_frames - layer_end_pause > layer_start_pause:
                                if driver_eval_frame >= total_frames - layer_end_pause:
                                    driver_eval_frame = total_frames - layer_end_pause - 1
                            
                            driver_eval_frame = driver_eval_frame - layer_start_pause - layer_offset
                            
                            driver_offset_x = driver_offset_y = 0.0
                            eff_static_frame = 0
                            driver_scale_profile = None
                            driver_pivot = None

                            is_box_driver = False
                            if layer_driver_info and isinstance(layer_driver_info, dict):
                                interpolated_driver = _resolve_preview_driver_path(layer_driver_info, 'path')
                                driver_d_scale = layer_driver_info.get('d_scale', 1.0)
                                is_box_driver = layer_driver_info.get('driver_type') == 'box'
                                driver_pivot = layer_driver_info.get('driver_pivot')
                                driver_scale_profile = layer_driver_info.get('driver_scale_profile')

                                if interpolated_driver and len(interpolated_driver) > 0:
                                    driver_start_p = int(layer_driver_info.get('start_pause', 0))
                                    driver_offset_val = int(layer_driver_info.get('offset', 0))
                                    pos_delay = driver_start_p + max(0, driver_offset_val)
                                    neg_lead = -min(0, driver_offset_val)
                                    eff_static_frame = max(0, driver_eval_frame - pos_delay + neg_lead)

                                    if not is_box_driver:
                                        # Original behavior for non-box drivers: offset is relative to driver's first point
                                        driver_offset_x, driver_offset_y = calculate_driver_offset(
                                            eff_static_frame, interpolated_driver, (0, 0),
                                            total_frames, driver_d_scale, frame_width, frame_height,
                                            driver_scale_factor=layer_driver_info.get('driver_scale_factor', 1.0),
                                            driver_radius_delta=layer_driver_info.get('driver_radius_delta', 0.0),
                                            driver_path_normalized=layer_driver_info.get('driver_path_normalized', True),
                                            apply_scale_to_offset=True
                                        )
                                    else:
                                        # Box drivers: pure translational offset, independent of scale/radius.
                                        driver_offset_x, driver_offset_y = calculate_driver_offset(
                                            eff_static_frame, interpolated_driver, (0, 0),
                                            total_frames, 1.0, frame_width, frame_height,
                                            driver_scale_factor=1.0,
                                            driver_radius_delta=0.0,
                                            driver_path_normalized=layer_driver_info.get('driver_path_normalized', True),
                                            apply_scale_to_offset=False
                                        )

                            # Base point position
                            base_x = float(point["x"])
                            base_y = float(point["y"])

                            # Per-point scaling factors
                            try:
                                point_scale = float(point.get("pointScale", point.get("scale", 1.0)))
                            except (TypeError, ValueError):
                                point_scale = 1.0
                            try:
                                box_scale_factor = float(point.get("boxScale", 1.0))
                            except (TypeError, ValueError):
                                box_scale_factor = 1.0

                            # Default: no positional scaling, just translation
                            scaled_x = base_x
                            scaled_y = base_y

                            # Apply independent scale-out when driven by a box
                            if is_box_driver and driver_pivot is not None and driver_scale_profile:
                                pivot_x, pivot_y = driver_pivot
                                pivot_normalized = layer_driver_info.get('driver_path_normalized', True)
                                if pivot_normalized:
                                    pivot_x *= frame_width
                                    pivot_y *= frame_height

                                boxScale0 = 1.0
                                try:
                                    if len(driver_scale_profile) > 0:
                                        boxScale0 = float(driver_scale_profile[0]) or 1.0
                                except (TypeError, ValueError):
                                    boxScale0 = 1.0

                                try:
                                    if eff_static_frame < len(driver_scale_profile):
                                        boxScale_f = float(driver_scale_profile[eff_static_frame])
                                    else:
                                        boxScale_f = float(driver_scale_profile[-1])
                                except (TypeError, ValueError):
                                    boxScale_f = boxScale0

                                if boxScale0 != 0.0:
                                    R_box = boxScale_f / boxScale0
                                else:
                                    R_box = 1.0

                                R_point = 1.0 + (R_box - 1.0) * point_scale * box_scale_factor

                                dx0 = base_x - pivot_x
                                dy0 = base_y - pivot_y
                                scaled_x = pivot_x + dx0 * R_point
                                scaled_y = pivot_y + dy0 * R_point

                            location_x = scaled_x + driver_offset_x
                            location_y = scaled_y + driver_offset_y

                            if static_fade_start == 0 or i < fade_start_frame:
                                visibility = 1
                            else:
                                visibility = 0

                            single_point_spline.append({
                                "x": int(location_x),
                                "y": int(location_y),
                                "v": visibility
                            })

                        all_coords.append(single_point_spline)
            except Exception as e:
                print(f"Error processing static points: {e}")
                pass
        
        # Ensure we have at least one track to avoid the ATI error
        if not all_coords:
            # Create a default track at origin if no coordinates exist
            default_track = []
            for i in range(total_frames):
                default_track.append({
                    "x": 0,
                    "y": 0,
                    "v": 1
                })
            all_coords.append(default_track)

        # Format output as a JSON string that ATI nodes can parse
        # Follow the same format as WanVideoATITracksVisualize
        try:
            # Convert tracks to the format that matches what WanVideoATITracksVisualize expects
            # The tracks will be padded to 121 frames and subsampled to 81 frames by the ATI node
            clean_tracks = []
            for track in all_coords:
                clean_track = []
                for point in track:
                    # Include visibility if it exists, default to 1 if not
                    v = int(point.get("v", 1))
                    clean_track.append({
                        "x": int(point["x"]),
                        "y": int(point["y"]),
                        "v": v
                    })
                clean_tracks.append(clean_track)
            
            # Format output according to the number of tracks:
            # - If there's only one track, output it as a single list: [{...}, {...}]
            # - If there are multiple tracks, output as a list of lists: [[{...}], [{...}]]
            if len(clean_tracks) == 1:
                output_coords_json = json.dumps(clean_tracks[0])
            else:
                output_coords_json = json.dumps(clean_tracks)
            
            # Verify the JSON can be parsed correctly
            test_parse = json.loads(output_coords_json)
        except Exception as e:
            # Fallback to empty array if there's an issue
            output_coords_json = "[]"

        # ----- Create preview output: bg_image duplicated with splines under shapes -----
        if preview_enabled:
            # First, duplicate and scale the background
            bg_frame = bg_image[0]  # Shape: [H, W, C]
            bg_frames_duplicated = bg_frame.unsqueeze(0).repeat(batch_size, 1, 1, 1)  # [B, H, W, C]

            # Scale background to 50% size
            bg_frames_duplicated = bg_frames_duplicated.permute(0, 3, 1, 2)  # BHWC -> BCHW
            scaled_height = bg_frames_duplicated.shape[2] // 2
            scaled_width = bg_frames_duplicated.shape[3] // 2
            bg_frames_duplicated = torch.nn.functional.interpolate(
                bg_frames_duplicated,
                size=(scaled_height, scaled_width),
                mode='bilinear',
                align_corners=False
            )
            bg_frames_duplicated = bg_frames_duplicated.permute(0, 2, 3, 1)  # BCHW -> BHWC

            # Draw orange splines using ATI tracks (now available after building them)
            preview_with_splines = self._draw_splines_on_preview(
                bg_frames_duplicated, processed_coords_list, path_pause_frames,
                total_frames, coords_driver_info_list, static_point_layers,
                static_points_use_driver, static_points_driver_path_processed,
                meta.get("start_p_frames", 0), meta.get("end_p_frames", 0),
                static_points_driver_info_list, static_points_interpolated_drivers,
                frame_width, frame_height, coord_visibility_list
            )

            # Now composite the drawn shapes at 50% opacity on top of bg+splines
            preview_frames = []
            for i in range(batch_size):
                # Scale the drawn frame to 50%
                drawn_frame = out_images[i].unsqueeze(0)  # [1, H, W, C]
                drawn_frame = drawn_frame.permute(0, 3, 1, 2)  # -> [1, C, H, W]
                drawn_frame = torch.nn.functional.interpolate(
                    drawn_frame,
                    size=(scaled_height, scaled_width),
                    mode='bilinear',
                    align_corners=False
                )
                drawn_frame = drawn_frame.permute(0, 2, 3, 1).squeeze(0)  # -> [H, W, C]

                # Convert to same device/dtype as preview_with_splines
                drawn_frame = drawn_frame.to(device=preview_with_splines.device, dtype=preview_with_splines.dtype)

                # Normal alpha blending: (bg+splines) * (1 - alpha) + drawn * alpha, where alpha = 0.5
                preview_frame = preview_with_splines[i] * ALPHA_BLEND_FACTOR + drawn_frame * ALPHA_BLEND_FACTOR
                preview_frame = torch.clamp(preview_frame, 0.0, 1.0)
                preview_frames.append(preview_frame.unsqueeze(0))

            # Stack all preview frames into a batch
            preview_output = torch.cat(preview_frames, dim=0)
        else:
            # Return minimal 1x1 pixel preview for efficiency when preview is disabled
            preview_output = torch.zeros([batch_size, 1, 1, 3], dtype=torch.float32)

        return (out_images, out_masks, output_coords_json, preview_output)
