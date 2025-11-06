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

Coord = Dict[str, Any]  # expects {'x': float, 'y': float, ...}
Path = List[Coord]

# Constants
DEFAULT_FRAME_WIDTH = 512
DEFAULT_FRAME_HEIGHT = 512
DEFAULT_TOTAL_FRAMES = 16
DEFAULT_SHAPE_SIZE = 40
PREVIEW_SCALE_FACTOR = 0.5
DRIVER_SCALE_FACTOR = 1.0
ACCELERATION_THRESHOLD = 0.001
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

    def _calculate_driver_offset(self, frame_index: int, interpolated_driver: Path,
                                pause_frames: Tuple[int, int], total_frames: int,
                                driver_scale: float = DRIVER_SCALE_FACTOR,
                                frame_width: int = DEFAULT_FRAME_WIDTH,
                                frame_height: int = DEFAULT_FRAME_HEIGHT) -> Tuple[float, float]:
        """
        Calculate driver offset for a given frame based on interpolated driver path.

        Driver paths define motion that can be applied to other coordinates.
        The offset is computed relative to the driver's first keyframe position
        to ensure consistent motion regardless of the driver's starting position.

        Returns (offset_x, offset_y).
        """
        start_p, end_p = pause_frames
        if frame_index < start_p:
            driver_index = 0
        elif frame_index >= total_frames - end_p:
            driver_index = len(interpolated_driver) - 1
        else:
            driver_index = frame_index - start_p

        if 0 <= driver_index < len(interpolated_driver):
            ref_x = float(interpolated_driver[0]['x'])
            ref_y = float(interpolated_driver[0]['y'])
            current_x = float(interpolated_driver[driver_index]['x'])
            current_y = float(interpolated_driver[driver_index]['y'])

            # Driver offset is computed relative to the driver's first keyframe
            # The driver path is in normalized coordinates (0-1), so we need to scale it to frame dimensions
            offset_x = (current_x - ref_x) * driver_scale * frame_width
            offset_y = (current_y - ref_y) * driver_scale * frame_height
            return offset_x, offset_y

        return 0.0, 0.0

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
                               static_points_pause_frames: Tuple[int, int] = (0, 0),
                               coords_driver_info_list: Optional[List[Optional[Dict[str, Any]]]] = None,
                               scales_list: Optional[List[float]] = None,
                               static_points_scale: float = 1.0,
                               static_points_scales_list: Optional[List[float]] = None,
                               static_points_driver_info_list: Optional[List[Optional[Dict[str, Any]]]] = None,
                               static_points_interpolated_drivers: Optional[List[Dict[str, Any]]] = None) -> Image.Image:
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

                # Draw each point in this layer with the layer's driver offset applied
                for point_idx, point in enumerate(static_points):
                    driver_offset_x = driver_offset_y = 0.0

                    # Use the layer's driver if available
                    if layer_driver_info and isinstance(layer_driver_info, dict):
                        interpolated_driver = layer_driver_info.get('path')
                        driver_d_scale = layer_driver_info.get('d_scale', DRIVER_SCALE_FACTOR)

                        if interpolated_driver and len(interpolated_driver) > 0:
                            driver_offset_x, driver_offset_y = self._calculate_driver_offset(
                                frame_index, interpolated_driver, static_points_pause_frames,
                                total_frames, driver_d_scale, frame_width, frame_height
                            )

                    try:
                        location_x = point['x'] + driver_offset_x
                        location_y = point['y'] + driver_offset_y
                    except (KeyError, TypeError):
                        continue

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
                # For points-type layers with driver, draw all points with driver offset applied
                # In points mode, all points in the layer receive the same driver offset for this frame
                driver_info = coords_driver_info_list[path_idx]
                interpolated_driver = driver_info.get('interpolated_path')
                driver_pause_frames = driver_info.get('pause_frames', (0, 0))
                d_scale = driver_info.get('d_scale', 1.0)
                
                # Calculate driver offset for this frame using helper method
                driver_offset_x, driver_offset_y = self._calculate_driver_offset(
                    frame_index, interpolated_driver, driver_pause_frames,
                    total_frames, d_scale, frame_width, frame_height
                )
                    
                    
                # Apply per-path scale if scales_list is provided
                path_current_width = float(shape_width)
                path_current_height = float(shape_height)
                if scales_list and path_idx < len(scales_list):
                    scale = float(scales_list[path_idx])
                    path_current_width *= scale
                    path_current_height *= scale
                
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
                                 ati_tracks: Optional[List[List[Dict[str, Any]]]] = None) -> torch.Tensor:
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

  
        # Draw orange lines using ATI tracks (all coordinate paths including p_coordinates)
        if ati_tracks and len(ati_tracks) > 0:
            for frame_idx in range(batch_size):
                draw = ImageDraw.Draw(preview_pil_list[frame_idx])

                for track_idx, track in enumerate(ati_tracks):
                    if not track or len(track) == 0:
                        continue

                    # Collect points for this track, apply preview scaling
                    track_points = []
                    for point in track:
                        try:
                            x = int(point.get('x', 0)) * scale_factor
                            y = int(point.get('y', 0)) * scale_factor
                            track_points.append((x, y))
                        except (ValueError, TypeError):
                            continue

                    # Draw orange line if we have multiple points
                    if len(track_points) > 1:
                        draw.line(track_points, fill='orange', width=2)

        # Convert PIL images back to tensor
        result_frames = []
        for pil_img in preview_pil_list:
            frame_tensor = pil2tensor(pil_img)  # [1, H, W, C]
            result_frames.append(frame_tensor)

        result_tensor = torch.cat(result_frames, dim=0)  # [B, H, W, C]
        return result_tensor

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
            "easing_functions": 'linear',
            "easing_paths": 'full',
            "easing_strengths": 1.0,
            "scales": 1.0,
            "drivers": None,
            "p_coordinates_use_driver": False,
            "static_points_driver_path": None,
            "static_points_driver_smooth": 0.0,
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
                for k in ("start_p_frames", "end_p_frames", "offsets", "interpolations", "easing_functions", "easing_paths", "easing_strengths", "accelerations", "scales", "drivers", "p_coordinates_use_driver", "static_points_driver_path", "static_points_driver_smooth", "coord_width", "coord_height"):
                    if k in parsed:
                        metadata[k] = parsed[k]
            else:
                # Not an object: treat as raw coordinates
                coordinates_data = coordinates_str
        except Exception:
            # Fall back to treating string as raw coordinates
            coordinates_data = coordinates_str

        return coordinates_data, p_coordinates_data, metadata

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
                        elif isinstance(sub, dict) and 'x' in sub and 'y' in sub:
                            # Single point as a layer
                            static_point_layers.append([{'x': float(sub['x']), 'y': float(sub['y']), **{k: v for k, v in sub.items() if k not in ('x', 'y')}}])
        except Exception:
            # On any parse error, return empty list
            return []
        return static_point_layers

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

    def _scale_points_and_drivers(self, static_point_layers: List[List[Coord]], static_points_driver_path: Optional[Path],
                                  coord_width: Optional[float], coord_height: Optional[float],
                                  frame_width: int, frame_height: int) -> Tuple[List[List[Coord]], Optional[Path]]:
        """
        Scale static point layers and driver path if coordinate space differs from frame size.

        The coordinate system can be normalized (0-1) or use absolute pixel values.
        This method ensures all coordinates are properly scaled to match the output frame dimensions.

        Returns tuple (scaled_static_point_layers, scaled_driver_path_or_none).
        """
        if not coord_width or not coord_height:
            return static_point_layers, static_points_driver_path

        scale_x = float(frame_width) / float(coord_width) if coord_width and coord_width != 0 else 1.0
        scale_y = float(frame_height) / float(coord_height) if coord_height and coord_height != 0 else 1.0

        if scale_x == 1.0 and scale_y == 1.0:
            return static_point_layers, static_points_driver_path

        scaled_static_layers = []
        for layer in static_point_layers:
            scaled_layer = []
            for p in layer:
                sp = {**p}
                sp['x'] = float(p['x']) * scale_x
                sp['y'] = float(p['y']) * scale_y
                scaled_layer.append(sp)
            scaled_static_layers.append(scaled_layer)

        scaled_driver = None
        if static_points_driver_path:
            scaled_driver = []
            for p in static_points_driver_path:
                if isinstance(p, dict) and 'x' in p and 'y' in p:
                    sp = {**p}
                    sp['x'] = float(p['x']) * scale_x
                    sp['y'] = float(p['y']) * scale_y
                    scaled_driver.append(sp)

        return scaled_static_layers, scaled_driver

    def _process_static_points_driver_path(self, raw_path: Optional[Path], total_frames: int, smooth_strength: float,
                               easing_function: str, easing_path: str, easing_strength: float) -> Optional[Path]:
        """
        Interpolate static_points_driver_path to match total_frames and optionally smooth it.
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
                    neighbor_weight = smooth_strength * TRAILING_WEIGHT_FACTOR
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

    def _normalize_easing_lists(self, num_paths: int, easing_meta, default_value) -> List:
        """
        Normalize easing metadata values to per-path lists with length num_paths:
        - For functions: default 'linear'
        - For paths: default 'full'
        - For strengths: default 1.0
        """
        easing_list = []
        if isinstance(easing_meta, dict):
            # New format: {"p": [...], "c": [...]} or old format: single value/list
            c_easing = easing_meta.get("c", [])
            if isinstance(c_easing, list):
                easing_list = c_easing + [default_value] * (num_paths - len(c_easing))
            else:
                easing_list = [default_value] * num_paths
        elif isinstance(easing_meta, list):
            easing_list = easing_meta + [default_value] * (num_paths - len(easing_meta))
        else:
            # Single value for all paths
            if isinstance(default_value, str):
                easing_val = easing_meta if isinstance(easing_meta, str) else default_value
                easing_list = [easing_val] * num_paths
            elif isinstance(default_value, (int, float)):
                easing_val = easing_meta if isinstance(easing_meta, (int, float)) else default_value
                easing_list = [easing_val] * num_paths
            else:
                easing_list = [default_value] * num_paths

        # Ensure the list has exactly num_paths elements
        if len(easing_list) < num_paths:
            easing_list.extend([default_value] * (num_paths - len(easing_list)))
        elif len(easing_list) > num_paths:
            easing_list = easing_list[:num_paths]
            
        return easing_list

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
                                  easing_functions_meta, easing_paths_meta, easing_strengths_meta,
                                  scales_meta, accelerations_meta=None,
                                  coord_width: Optional[float] = None, coord_height: Optional[float] = None,
                                  frame_width: int = 512, frame_height: int = 512) -> Tuple[List[Path], List[Tuple[int, int]], List[Optional[Dict[str, Any]]], List[float]]:
        """
        Given raw coordinate lists and metadata, produce:
         - processed_coords_list: list of resampled/interpolated paths
         - path_pause_frames: list of (start_p, end_p) for each processed path
         - coords_driver_info_list: per-path driver info dict or None
        Raises or returns empty list if no valid paths.
        """
        if not coords_list_raw:
            return [], [], [], []

        num_paths = len(coords_list_raw)
        start_p_frames_list, end_p_frames_list, interpolations_list, drivers_list, offsets_list = self._normalize_metadata_lists(
            num_paths, start_p_frames_meta, end_p_frames_meta, interpolations_meta, drivers_meta, offsets_meta
        )
        # Normalize per-path easing parameters
        easing_functions_list = self._normalize_easing_lists(num_paths, easing_functions_meta, "easing_function")
        easing_paths_list = self._normalize_easing_lists(num_paths, easing_paths_meta, "easing_path")
        easing_strengths_list = self._normalize_easing_lists(num_paths, easing_strengths_meta, "easing_strength")
        accelerations_list = self._normalize_easing_lists(num_paths, accelerations_meta, 0.00)
        scales_list = self._normalize_easing_lists(num_paths, scales_meta, 1.0)

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
                path_easing_function = easing_functions_list[i] if i < len(easing_functions_list) else "in_out"
                path_easing_path = easing_paths_list[i] if i < len(easing_paths_list) else "full"
                path_easing_strength = float(easing_strengths_list[i]) if i < len(easing_strengths_list) else 1.0

                path_animation_frames = max(1, total_frames - path_start_p - path_end_p)
                effective_easing_path = path_easing_path

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
                    interpolated_path, path_animation_frames, path_easing_function, effective_easing_path, bounce_between=0.0, easing_strength=path_easing_strength, interpolation=path_interpolation
                )
                
                # Apply acceleration remapping if acceleration is not zero
                path_acceleration = float(accelerations_list[i]) if i < len(accelerations_list) else 0.00
                if abs(path_acceleration) > ACCELERATION_THRESHOLD:  # Only apply if acceleration is not close to zero
                    processed_path = draw_utils.InterpMath.apply_acceleration_remapping(processed_path, path_acceleration)

                # Prepare per-path driver interpolation (for per-frame offsets)
                driver_info_for_frame = None
                if isinstance(path_driver_info, dict):
                    raw_driver_path = path_driver_info.get('path')
                    driver_rotate = path_driver_info.get('rotate', 0)
                    driver_d_scale = path_driver_info.get('d_scale', 1.0)
                    
                    # Use driver's own interpolation parameters if available, otherwise fall back to driven layer's parameters
                    driver_easing_function = path_driver_info.get('easing_function', path_easing_function)
                    driver_easing_path = path_driver_info.get('easing_path', path_easing_path)
                    driver_easing_strength = path_driver_info.get('easing_strength', path_easing_strength)
                    driver_acceleration = path_driver_info.get('acceleration', 0.00)
                    
                    if raw_driver_path and len(raw_driver_path) > 0:
                        transformed_driver = raw_driver_path
                        # NOTE: Driver paths are already scaled in drawshapemask() at lines 391-415
                        # Do NOT scale them again here or they'll be scaled twice

                        if driver_rotate and driver_rotate != 0:
                            transformed_driver = rotate_path(transformed_driver, driver_rotate)
                        # d_scale will be applied during rendering to the offset
                        interpolated_driver = draw_utils.InterpMath.interpolate_or_downsample_path(
                            transformed_driver, total_frames, driver_easing_function, driver_easing_path, bounce_between=0.0, easing_strength=driver_easing_strength
                        )
                        
                        # Apply acceleration remapping if acceleration is not zero
                        if abs(driver_acceleration) > ACCELERATION_THRESHOLD:  # Only apply if acceleration is not close to zero
                            interpolated_driver = draw_utils.InterpMath.apply_acceleration_remapping(interpolated_driver, driver_acceleration)
                        
                        driver_info_for_frame = {'interpolated_path': interpolated_driver, 'pause_frames': (path_start_p, path_end_p), 'd_scale': driver_d_scale, 'easing_function': driver_easing_function, 'easing_path': driver_easing_path, 'easing_strength': driver_easing_strength}

                # Apply offset timing (modify processed_path and adjust pauses)
                if path_offset != 0:
                    processed_path, start_adj, end_adj = self._apply_offset_timing(processed_path, path_offset)
                    path_start_p += start_adj
                    path_end_p += end_adj

                processed_coords_list.append(processed_path)
                path_pause_frames.append((path_start_p, path_end_p))
                coords_driver_info_list.append(driver_info_for_frame)
                scales_list.append(float(scales_list[i]) if i < len(scales_list) else 1.0)
                valid_paths_exist = True
            except Exception:
                # Skip this path on processing error
                continue

        if not valid_paths_exist:
            return [], [], [], []

        return processed_coords_list, path_pause_frames, coords_driver_info_list, scales_list

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
        coordinates_data, p_coordinates_data, meta = self._parse_coordinate_metadata(coordinates)
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

        # Scale static points and static_points_driver_path if necessary
        static_point_layers, static_points_driver_path_processed = self._scale_points_and_drivers(static_point_layers, static_points_driver_path_raw, coord_width, coord_height, frame_width, frame_height)

        # Interpolate static_points_driver_path to total_frames and apply smoothing
        # For static points, use the easing parameters from metadata
        easing_function = meta.get("easing_functions", "in_out")
        easing_path = meta.get("easing_paths", "full")
        easing_strength = meta.get("easing_strengths", 1.0)

        # Store interpolated driver paths for each static point layer
        static_points_interpolated_drivers: List[Optional[Dict[str, Any]]] = []
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
                        # Interpolate this driver path to match total_frames using its own interpolation parameters
                        interpolated = self._process_static_points_driver_path(
                            driver_path, total_frames, static_points_driver_smooth,
                            driver_easing_function, driver_easing_path, driver_easing_strength
                        )
                        static_points_interpolated_drivers[idx] = {
                            'path': interpolated,
                            'd_scale': driver_d_scale,
                            'easing_function': driver_easing_function,
                            'easing_path': driver_easing_path,
                            'easing_strength': driver_easing_strength
                        }
        elif static_points_use_driver and static_points_driver_path_processed:
            # Use the single driver for all layers (legacy mode)
            legacy_driver = {
                'path': static_points_driver_path_processed,
                'd_scale': DRIVER_SCALE_FACTOR,  # No scaling for legacy single driver
                'easing_function': easing_function,
                'easing_path': easing_path,
                'easing_strength': easing_strength
            }
            if num_static_point_layers > 0:
                static_points_interpolated_drivers = [legacy_driver.copy() for _ in range(num_static_point_layers)]
            else:
                static_points_interpolated_drivers = [legacy_driver]
        else:
            static_points_interpolated_drivers = []

        # Code-side fallback: automatically enable static_points_use_driver if drivers.p exists
        if isinstance(meta.get("drivers"), dict) and meta["drivers"].get("p"):
            static_points_use_driver = True

        if static_points_use_driver and static_points_driver_path_processed:
            static_points_driver_path_processed = self._process_static_points_driver_path(static_points_driver_path_processed, total_frames, static_points_driver_smooth, easing_function, easing_path, easing_strength)

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
                        empty_image = torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32)
                        empty_mask = torch.zeros([1, frame_height, frame_width], dtype=torch.float32)
                        empty_preview = torch.zeros([1, 1, 1, 3], dtype=torch.float32)  # 1x1 pixel for efficiency
                        return (empty_image, empty_mask, "[]", empty_preview)  # preview instead of frames
                else:
                    # Unexpected format
                    empty_image = torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32)
                    empty_mask = torch.zeros([1, frame_height, frame_width], dtype=torch.float32)
                    empty_preview = torch.zeros([1, 1, 1, 3], dtype=torch.float32)  # 1x1 pixel for efficiency
                    return (empty_image, empty_mask, "[]", empty_preview)  # preview instead of frames
            except Exception:
                empty_image = torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32)
                empty_mask = torch.zeros([1, frame_height, frame_width], dtype=torch.float32)
                empty_preview = torch.zeros([1, 1, 1, 3], dtype=torch.float32)  # 1x1 pixel for efficiency
                return (empty_image, empty_mask, "[]", empty_preview)  # preview instead of frames
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
        # Handle different formats for easing parameters - could be single values, lists, or objects
        easing_functions_meta = meta.get("easing_functions", "in_out")
        easing_paths_meta = meta.get("easing_paths", "full")
        easing_strengths_meta = meta.get("easing_strengths", 1.0)
        accelerations_meta = meta.get("accelerations", 0.00)
        
        # Get interpolations metadata to check for points mode
        interpolations_meta = meta.get("interpolations", 'linear')
        
        processed_coords_list, path_pause_frames, coords_driver_info_list, scales_list = self._build_interpolated_paths(
            coords_list_raw, total_frames,
            meta.get("start_p_frames", 0), meta.get("end_p_frames", 0),
            meta.get("offsets", 0), interpolations_meta,
            meta.get("drivers", None),
            easing_functions_meta,
            easing_paths_meta,
            easing_strengths_meta,
            meta.get("scales", 1.0),
            accelerations_meta,
            coord_width, coord_height, frame_width, frame_height
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
                        d_start_p, d_end_p = driver_pause_frames
                        
                        # Check if this is a "points" type layer
                        if path_idx < len(interpolations_list) and interpolations_list[path_idx] == 'points':
                            # For points mode, DON'T apply offsets here to processed_coords_list
                            # The offsets will be applied per-frame in _draw_single_frame_pil
                            # Just mark this as a points-mode layer with driver
                            coords_driver_info_list[path_idx] = {
                                'interpolated_path': interpolated_driver,
                                'pause_frames': driver_pause_frames,
                                'd_scale': d_scale,
                                'easing_function': driver_info.get('easing_function', 'linear'),
                                'easing_path': driver_info.get('easing_path', 'full'),
                                'easing_strength': driver_info.get('easing_strength', 1.0),
                                'is_points_mode': True
                            }
                        else:
                            # For non-points layers, apply driver offset to each frame of the processed path
                            for frame_idx in range(len(coords)):
                                if frame_idx < d_start_p:
                                    driver_index = 0
                                elif frame_idx >= total_frames - d_end_p:
                                    driver_index = len(interpolated_driver) - 1
                                else:
                                    driver_index = frame_idx - d_start_p
                                
                                if 0 <= driver_index < len(interpolated_driver):
                                    ref_x = float(interpolated_driver[0]['x'])
                                    ref_y = float(interpolated_driver[0]['y'])
                                    current_x = float(interpolated_driver[driver_index]['x'])
                                    current_y = float(interpolated_driver[driver_index]['y'])
                                    driver_offset_x = (current_x - ref_x) * d_scale
                                    driver_offset_y = (current_y - ref_y) * d_scale
                                    
                                    # Apply the offset to the already interpolated coordinate
                                    coords[frame_idx]['x'] += driver_offset_x
                                    coords[frame_idx]['y'] += driver_offset_y
        
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
                static_point_layers, static_points_use_driver, static_points_driver_path_processed, (start_p_frames, end_p_frames), coords_driver_info_list, scales_list, static_points_scale, static_points_scales_list, static_points_driver_info_list, static_points_interpolated_drivers
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
                    path_start_p, path_end_p = path_pause_frames[path_idx]
                    single_path_coords = []
                    for i in range(total_frames):
                        if i < path_start_p:
                            coord_index = 0
                        elif i >= total_frames - path_end_p:
                            coord_index = len(path_coords) - 1
                        else:
                            coord_index = i - path_start_p
                        coord_index = max(0, min(coord_index, len(path_coords) - 1))
                        
                        # Extract x, y
                        coord = path_coords[coord_index]
                        location_x = float(coord["x"])
                        location_y = float(coord["y"])
                        
                        # Driver offsets are now pre-applied to processed_coords_list in drawshapemask
                        # No need to apply them again here
                        # This ensures the driven layer's interpolation is preserved and the driver offset is added on top
                        
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
        
        # Process static points (p_coordinates) - affected by static_fade_start
        if static_point_layers:
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

                # Process each layer of static points
                for layer_idx, static_points in enumerate(static_point_layers):
                    if not static_points:
                        continue

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
                            # Apply driver offset for static points
                            driver_offset_x = driver_offset_y = 0.0

                            # Use the layer's driver if available
                            if layer_driver_info and isinstance(layer_driver_info, dict):
                                interpolated_driver = layer_driver_info.get('path')
                                driver_d_scale = layer_driver_info.get('d_scale', 1.0)

                                if interpolated_driver and len(interpolated_driver) > 0:
                                    # Apply the same logic as for animated paths
                                    p_start_p, p_end_p = meta.get("start_p_frames", 0), meta.get("end_p_frames", 0)
                                    # Handle dictionary case (from metadata parsing)
                                    if isinstance(p_start_p, dict):
                                        p_start_p = p_start_p.get("p", 0)
                                        p_end_p = p_end_p.get("p", 0)
                                    # Handle list case (from metadata parsing)
                                    if isinstance(p_start_p, list):
                                        p_start_p = p_start_p[0] if p_start_p else 0
                                        p_end_p = p_end_p[0] if p_end_p else 0

                                    if i < p_start_p:
                                        driver_index = 0
                                    elif i >= total_frames - p_end_p:
                                        driver_index = len(interpolated_driver) - 1
                                    else:
                                        driver_index = i - p_start_p

                                    if 0 <= driver_index < len(interpolated_driver):
                                        ref_x = float(interpolated_driver[0]['x'])
                                        ref_y = float(interpolated_driver[0]['y'])
                                        current_x = float(interpolated_driver[driver_index]['x'])
                                        current_y = float(interpolated_driver[driver_index]['y'])
                                        # For p_coordinates, we need to compute the driver offset relative to the driver's first keyframe
                                        # This ensures the point follows the driver path correctly
                                        driver_offset_x = (current_x - ref_x) * driver_d_scale * frame_width  # Scale by frame dimensions
                                        driver_offset_y = (current_y - ref_y) * driver_d_scale * frame_height

                            location_x = float(point["x"]) + driver_offset_x
                            location_y = float(point["y"]) + driver_offset_y

                            if static_fade_start == 0 or i < fade_start_frame:
                                visibility = 1  # Visible
                            else:
                                visibility = 0  # Invisible after fade_start_frame

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
                frame_width, frame_height, clean_tracks
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
