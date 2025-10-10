import torch
import json
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageColor
import concurrent.futures # Added for multiprocessing
import math # Needed for atan2, degrees, hypot
import torch.nn.functional as F # Added for grid_sample
# Assuming utility functions are in a parent directory utility module
from ..utility.utility import pil2tensor, tensor2pil # Ensure both are imported
from ..utility import draw_utils
from ..utility.driver_utils import apply_driver_offset, rotate_path, smooth_path, interpolate_path

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
        """Package frame configuration into a dictionary"""
        config = {
            "total_frames": total_frames,
            "easing_function": easing_function,
            "easing_path": easing_path,
            "easing_strength": easing_strength,
        }
        return (config,)

class DrawShapeOnPath:
    
    RETURN_TYPES = ("IMAGE", "MASK", "STRING",)
    RETURN_NAMES = ("image","mask", "output_coordinates",)
    FUNCTION = "drawshapemask" # Renamed function
    CATEGORY = "WanVideoWrapper_QQ" # Changed category
    DESCRIPTION = """
Creates an image or batch of images with the specified shape drawn along a coordinate path.
Locations are center locations. Allows coordinates outside the frame for 'fly-in' effects.
"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "shape": (
            [   'circle',
                'square',
                'triangle',
            ],
            {
            "default": 'circle'
             }),
                "bg_image": ("IMAGE", ),
                "coordinates": ("STRING", {"forceInput": True}),
                "path_frame_config": ("PATH_FRAME_CONFIG", ),
                "shape_width": ("INT", {"default": 40,"min": 2, "max": 1000, "step": 5}),
                "shape_height": ("INT", {"default": 40,"min": 2, "max": 1000, "step": 5}),
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

    def _draw_single_frame_pil(self, frame_index, processed_coords_list, path_pause_frames, total_frames, frame_width, frame_height, shape_width, shape_height, shape_color, bg_color, blur_radius, shape, border_width, border_color, static_points=None, p_coords_use_driver=False, p_driver_path=None, p_coords_pause_frames=None, coords_driver_info_list=None):
        """Helper function to draw a single frame using PIL. Runs in a separate process."""
        image = Image.new("RGB", (frame_width, frame_height), bg_color)
        draw = ImageDraw.Draw(image)

        current_width = float(shape_width)
        current_height = float(shape_height)

        # FIRST: Draw points from p_coordinates (if present)
        if static_points:
            # Calculate driver offset for this frame if driver is used
            driver_offset_x = 0.0
            driver_offset_y = 0.0

            if p_coords_use_driver and p_driver_path and p_coords_pause_frames:
                # Get pause frames for p_coordinates
                p_start_p, p_end_p = p_coords_pause_frames
                p_animation_frames = total_frames - p_start_p - p_end_p

                # Map frame_index to driver index
                if frame_index < p_start_p:
                    driver_index = 0  # Hold at first position
                elif frame_index >= total_frames - p_end_p:
                    driver_index = len(p_driver_path) - 1  # Hold at last position
                else:
                    driver_index = frame_index - p_start_p  # Normal animation

                # Bounds check and get driver offset
                if 0 <= driver_index < len(p_driver_path):
                    # Calculate offset from first driver position
                    ref_x = float(p_driver_path[0]['x'])
                    ref_y = float(p_driver_path[0]['y'])
                    current_x = float(p_driver_path[driver_index]['x'])
                    current_y = float(p_driver_path[driver_index]['y'])
                    driver_offset_x = current_x - ref_x
                    driver_offset_y = current_y - ref_y

            # Draw ALL points with the driver offset (all move together)
            for point in static_points:
                try:
                    # Apply driver offset to point position
                    location_x = point['x'] + driver_offset_x
                    location_y = point['y'] + driver_offset_y

                    # Draw shape at location
                    if shape == 'circle' or shape == 'square':
                        left_up_point = (location_x - current_width / 2.0, location_y - current_height / 2.0)
                        right_down_point = (location_x + current_width / 2.0, location_y + current_height / 2.0)
                        two_points = [left_up_point, right_down_point]

                        if shape == 'circle':
                            if border_width > 0:
                                draw.ellipse(two_points, fill=shape_color, outline=border_color, width=border_width)
                            else:
                                draw.ellipse(two_points, fill=shape_color)
                        elif shape == 'square':
                            if border_width > 0:
                                draw.rectangle(two_points, fill=shape_color, outline=border_color, width=border_width)
                            else:
                                draw.rectangle(two_points, fill=shape_color)

                    elif shape == 'triangle':
                        left_up_point = (location_x - current_width / 2.0, location_y + current_height / 2.0)
                        right_down_point = (location_x + current_width / 2.0, location_y + current_height / 2.0)
                        top_point = (location_x, location_y - current_height / 2.0)

                        if border_width > 0:
                            draw.polygon([top_point, left_up_point, right_down_point], fill=shape_color, outline=border_color, width=border_width)
                        else:
                            draw.polygon([top_point, left_up_point, right_down_point], fill=shape_color)
                except (KeyError, TypeError) as e:
                    print(f"Error drawing p_coordinate point: {e}")
                    continue

        # THEN: Draw animated path on top (existing logic continues below)
        for path_idx, coords in enumerate(processed_coords_list):
            if not isinstance(coords, list):
                # Safety check
                continue

            # Get per-path pause frames
            path_start_p, path_end_p = path_pause_frames[path_idx]
            path_animation_frames = total_frames - path_start_p - path_end_p

            # Map frame_index to coordinate index for this specific path
            if frame_index < path_start_p:
                coord_index = 0  # Hold at first position
            elif frame_index >= total_frames - path_end_p:
                coord_index = path_animation_frames - 1  # Hold at last position
            else:
                coord_index = frame_index - path_start_p  # Normal animation

            # Bounds check
            if coord_index < 0 or coord_index >= len(coords):
                continue

            try:
                location_x = coords[coord_index]['x']
                location_y = coords[coord_index]['y']
            except (KeyError, IndexError, TypeError):
                 # Skip drawing for this path on this frame if error
                 continue

            # --- APPLY PER-FRAME DRIVER OFFSET FOR ANIMATED COORDINATES ---
            # Calculate driver offset for this frame if driver is used
            driver_offset_x = 0.0
            driver_offset_y = 0.0

            if coords_driver_info_list and path_idx < len(coords_driver_info_list):
                driver_info = coords_driver_info_list[path_idx]

                if driver_info and isinstance(driver_info, dict):
                    interpolated_driver = driver_info.get('interpolated_path')
                    driver_pause_frames = driver_info.get('pause_frames', (0, 0))

                    if interpolated_driver and len(interpolated_driver) > 0:
                        driver_start_p, driver_end_p = driver_pause_frames
                        driver_animation_frames = total_frames - driver_start_p - driver_end_p

                        # Map frame_index to driver index
                        if frame_index < driver_start_p:
                            driver_index = 0  # Hold at first position
                        elif frame_index >= total_frames - driver_end_p:
                            driver_index = len(interpolated_driver) - 1  # Hold at last position
                        else:
                            driver_index = frame_index - driver_start_p  # Normal animation

                        # Bounds check and get driver offset
                        if 0 <= driver_index < len(interpolated_driver):
                            # Calculate offset from first driver position
                            ref_x = float(interpolated_driver[0]['x'])
                            ref_y = float(interpolated_driver[0]['y'])
                            current_x = float(interpolated_driver[driver_index]['x'])
                            current_y = float(interpolated_driver[driver_index]['y'])
                            driver_offset_x = current_x - ref_x
                            driver_offset_y = current_y - ref_y

            # Apply driver offset to location
            location_x += driver_offset_x
            location_y += driver_offset_y
            # --- END APPLY PER-FRAME DRIVER OFFSET ---

            # Draw shapes
            if shape == 'circle' or shape == 'square':
                left_up_point = (location_x - current_width / 2.0, location_y - current_height / 2.0)
                right_down_point = (location_x + current_width / 2.0, location_y + current_height / 2.0)
                two_points = [left_up_point, right_down_point]

                if shape == 'circle':
                    if border_width > 0:
                        draw.ellipse(two_points, fill=shape_color, outline=border_color, width=border_width)
                    else:
                        draw.ellipse(two_points, fill=shape_color)
                elif shape == 'square':
                    if border_width > 0:
                        draw.rectangle(two_points, fill=shape_color, outline=border_color, width=border_width)
                    else:
                        draw.rectangle(two_points, fill=shape_color)
            
            elif shape == 'triangle':
                left_up_point = (location_x - current_width / 2.0, location_y + current_height / 2.0) 
                right_down_point = (location_x + current_width / 2.0, location_y + current_height / 2.0) 
                top_point = (location_x, location_y - current_height / 2.0) 
                poly_points = [top_point, left_up_point, right_down_point]

                if border_width > 0:
                    draw.polygon(poly_points, fill=shape_color, outline=border_color, width=border_width)
                else:
                    draw.polygon(poly_points, fill=shape_color)

        # Apply blur if needed - Apply before returning PIL image
        if blur_radius > 0.0: 
            image = image.filter(ImageFilter.GaussianBlur(blur_radius))
            
        return image # Return the PIL image for this frame

    def _interpolate_coords(self, coords, target_frames):
        """Linearly interpolates coordinates to match target_frames."""
        n_coords = len(coords)

        if target_frames <= 0:
            print("SplineEditor Warning: target_frames is 0 or negative. Returning original coords.")
            return coords
        if n_coords == target_frames:
            return coords  # No interpolation needed
        if n_coords == 0:
            print("SplineEditor Warning: Cannot interpolate empty coordinate list.")
            return []
        if n_coords == 1:
            try:
                single_point = {'x': float(coords[0]['x']), 'y': float(coords[0]['y'])}
                return [single_point.copy() for _ in range(target_frames)]
            except (KeyError, ValueError) as e:
                print(f"SplineEditor Error: Invalid single point format {coords[0]} - {e}")
                return []
        if target_frames == 1:
            try:
                first_point = {'x': float(coords[0]['x']), 'y': float(coords[0]['y'])}
                return [first_point.copy()]
            except (KeyError, ValueError) as e:
                print(f"SplineEditor Error: Invalid first point format {coords[0]} - {e}")
                return []

        interpolated = [None] * target_frames
        # Ensure original coords are floats before interpolating
        float_coords = []
        try:
            for i, p in enumerate(coords):
                float_coords.append({'x': float(p['x']), 'y': float(p['y'])})
        except (KeyError, ValueError) as e:
            print(f"SplineEditor Error: Invalid coordinate format at index {i} ({p}) - {e}")
            return []

        for i in range(target_frames):
            pos = i * (n_coords - 1) / (target_frames - 1)
            idx1 = math.floor(pos)
            idx2 = math.ceil(pos)

            if idx1 == idx2:
                interpolated[i] = float_coords[idx1].copy()
            else:
                t = pos - idx1
                p1 = float_coords[idx1]
                p2 = float_coords[idx2]

                new_x = p1['x'] * (1.0 - t) + p2['x'] * t
                new_y = p1['y'] * (1.0 - t) + p2['y'] * t
                interpolated[i] = {'x': new_x, 'y': new_y}

        return interpolated



    def _apply_offset_timing(self, points, offset):
        """
        Apply timing offset by removing coordinates and returning pause adjustments.
        This creates pause frames via metadata rather than duplicating coordinates.

        Positive offset: remove LAST N frames, add N to start_pause
            - Waits at START position for N frames, then animates to N frames before end
            - Example: offset=5 holds start for 5 frames, plays, stops 5 frames early
        Negative offset: remove LAST N frames, add N to end_pause
            - Animates normally but stops N frames early, then holds END position
            - Example: offset=-5 plays normally, stops 5 frames early, holds for 5 frames

        Returns: (modified_points, start_pause_adjustment, end_pause_adjustment)
        """
        if offset == 0 or not points or len(points) == 0:
            return points, 0, 0

        offset_abs = abs(offset)
        path_length = len(points)

        # Validation: Warn if offset is too large
        if offset_abs >= path_length:
            print(f"[Offset Warning] Offset value {offset} exceeds path length {path_length}. Clamping to {path_length - 1}.")
            offset_abs = path_length - 1

        # Additional warning if offset removes more than 80% of frames
        if offset_abs > path_length * 0.8:
            print(f"[Offset Warning] Offset {offset} removes {offset_abs}/{path_length} frames ({offset_abs/path_length*100:.1f}%), leaving only {path_length - offset_abs} animation frames.")

        if offset > 0:
            # Positive: remove LAST N frames, add N to start_pause
            # This waits at start position, then animates to N frames before end
            return points[:-offset_abs] if offset_abs > 0 else points, offset_abs, 0
        else:
            # Negative: remove last N frames, add to end pause
            return points[:-offset_abs] if offset_abs > 0 else points, 0, offset_abs

    def drawshapemask(self, coordinates, bg_image, shape_width, shape_height, shape_color,
                        bg_color, blur_radius, shape, intensity, path_frame_config, trailing=1.0, border_width=0, border_color='black'):
        # Extract config parameters
        total_frames = path_frame_config["total_frames"]
        easing_function = path_frame_config["easing_function"]
        easing_path = path_frame_config["easing_path"]
        easing_strength = path_frame_config.get("easing_strength", 1.0)  # Default to 1.0 for backward compatibility

        # Parse coordinates to extract metadata (new format) or use defaults (old format)
        start_p_frames_meta = 0
        end_p_frames_meta = 0
        offsets_meta = 0 # Initialize offsets_meta
        interpolations_meta = 'linear' # Initialize interpolations_meta
        drivers_meta = None  # Driver metadata for all paths
        p_coordinates_data = None  # For static shapes
        coordinates_data = None    # For animated path
        p_coordinates_use_driver = False  # Whether p_coordinates use driver for group movement
        p_driver_path = None  # Driver path for p_coordinates
        p_driver_smooth = 0.0  # Smoothing strength for driver path

        try:
            coord_parsed = json.loads(coordinates.replace("'", '"'))
            # Check if it's the new metadata format
            if isinstance(coord_parsed, dict):
                # Extract p_coordinates if present (for static shapes)
                if "p_coordinates" in coord_parsed:
                    p_coordinates_data = json.dumps(coord_parsed["p_coordinates"])

                # Extract coordinates if present (for animated path)
                if "coordinates" in coord_parsed:
                    coordinates_data = json.dumps(coord_parsed["coordinates"]) # Now contains control points

                # Extract metadata
                start_p_frames_meta = coord_parsed.get("start_p_frames", 0)
                end_p_frames_meta = coord_parsed.get("end_p_frames", 0)
                offsets_meta = coord_parsed.get("offsets", 0)
                interpolations_meta = coord_parsed.get("interpolations", 'linear') # <-- Extract interpolations_meta
                drivers_meta = coord_parsed.get("drivers")  # Extract driver metadata for all paths

                # Old logic to handle p_coordinates driver from metadata (for backward compatibility)
                if isinstance(drivers_meta, dict):
                    p_drivers = drivers_meta.get("p")
                    
                    raw_driver_path = None
                    if isinstance(p_drivers, list) and p_drivers:
                        # Find the first valid driver path from the list of driver objects
                        for driver_info in p_drivers:
                            if isinstance(driver_info, dict) and 'path' in driver_info:
                                candidate_path = driver_info['path']
                                if isinstance(candidate_path, list) and candidate_path:
                                    raw_driver_path = candidate_path
                                    break # Found a valid raw path, stop searching
                    
                    # If a raw path was found, clean it
                    if raw_driver_path:
                        cleaned_driver_path = []
                        for point in raw_driver_path:
                            if isinstance(point, dict) and 'x' in point and 'y' in point:
                                cleaned_driver_path.append(point)
                        
                        # If the cleaned path has points, use it
                        if cleaned_driver_path:
                            p_coordinates_use_driver = True
                            p_driver_path = cleaned_driver_path
                
                # Fallback to old driver logic if new one fails for backward compatibility
                if not p_coordinates_use_driver:
                    p_coordinates_use_driver = coord_parsed.get("p_coordinates_use_driver", False)
                    if p_coordinates_use_driver:
                        p_driver_path = coord_parsed.get("p_driver_path", None)

                # Smoothing is a separate, top-level parameter, applied regardless of driver source
                p_driver_smooth = coord_parsed.get("p_driver_smooth", 0.0)

                # Extract coordinate space dimensions (for scaling)
                coord_width = coord_parsed.get("coord_width", None)
                coord_height = coord_parsed.get("coord_height", None)
            else:
                # Old format: coordinates is already the right format
                coordinates_data = coordinates
                coord_width = None
                coord_height = None
        except (json.JSONDecodeError, TypeError, KeyError) as e:
            print(f"DrawShapeOnPath: Error parsing coordinates metadata: {e}. Using defaults.")
            coordinates_data = coordinates
            coord_width = None
            coord_height = None

        # Parse p_coordinates into static_points list (if present)
        static_points = []
        if p_coordinates_data:
            try:
                p_coords = json.loads(p_coordinates_data.replace("'", '"'))
                if isinstance(p_coords, list) and p_coords:
                    # Handle both single list of points and list of lists
                    if isinstance(p_coords[0], dict):
                        # It's a single list of points, validate each one before adding
                        for point in p_coords:
                            if isinstance(point, dict) and 'x' in point and 'y' in point:
                                static_points.append(point)
                    elif isinstance(p_coords[0], list):
                        # It's a list of lists, flatten and validate each point
                        for sublist in p_coords:
                            if isinstance(sublist, list):
                                for point in sublist:
                                    if isinstance(point, dict) and 'x' in point and 'y' in point:
                                        static_points.append(point)
            except Exception as e:
                print(f"Error parsing p_coordinates: {e}")

        # Define the number of images in the batch
        # Get frame dimensions from bg_image tensor (BHWC format)
        try:
            _, frame_height, frame_width, _ = bg_image.shape
        except Exception as e:
            print(f"Error getting dimensions from bg_image: {e}. Using default 512x512.")
            frame_width, frame_height = 512, 512 # Fallback dimensions

        # Calculate scale factors if coordinate space differs from bg_image dimensions
        scale_x = 1.0
        scale_y = 1.0
        if coord_width and coord_height:
            if coord_width != frame_width or coord_height != frame_height:
                scale_x = float(frame_width) / float(coord_width)
                scale_y = float(frame_height) / float(coord_height)

                # Scale static_points if they exist
                if static_points:
                    scaled_static_points = []
                    for point in static_points:
                        scaled_point = {
                            'x': point['x'] * scale_x,
                            'y': point['y'] * scale_y
                        }
                        # Preserve any other properties
                        for key in point:
                            if key not in ['x', 'y']:
                                scaled_point[key] = point[key]
                        scaled_static_points.append(scaled_point)
                    static_points = scaled_static_points

                # Scale p_driver_path if it exists
                if p_driver_path:
                    scaled_driver_path = []
                    for point in p_driver_path:
                        scaled_point = {
                            'x': point['x'] * scale_x,
                            'y': point['y'] * scale_y
                        }
                        # Preserve any other properties
                        for key in point:
                            if key not in ['x', 'y']:
                                scaled_point[key] = point[key]
                        scaled_driver_path.append(scaled_point)
                    p_driver_path = scaled_driver_path

        # Interpolate p_driver_path to match total_frames if needed
        if p_coordinates_use_driver and p_driver_path:
            if len(p_driver_path) != total_frames:
                p_driver_path = draw_utils.InterpMath.interpolate_or_downsample_path(
                    p_driver_path, total_frames, easing_function, easing_path,
                    bounce_between=0.0, easing_strength=easing_strength
                )

            # Apply smoothing AFTER interpolation if p_driver_smooth > 0
            if p_driver_smooth > 0.0 and len(p_driver_path) > 2:
                smoothed_path = []

                # Keep first point unchanged
                smoothed_path.append(p_driver_path[0].copy())

                # Smooth middle points using neighbor-based weighted average
                for i in range(1, len(p_driver_path) - 1):
                    curr = p_driver_path[i]
                    prev = p_driver_path[i - 1]
                    next_pt = p_driver_path[i + 1]

                    # Calculate weighted average based on smoothing strength
                    # At smooth=0.0, use 100% current point (no smoothing)
                    # At smooth=1.0, use 50% neighbors, 50% current (max smoothing)
                    neighbor_weight = p_driver_smooth * 0.5  # 0.0 to 0.5
                    current_weight = 1.0 - (2 * neighbor_weight)  # 1.0 to 0.0

                    smoothed_x = (current_weight * float(curr['x']) +
                                  neighbor_weight * float(prev['x']) +
                                  neighbor_weight * float(next_pt['x']))
                    smoothed_y = (current_weight * float(curr['y']) +
                                  neighbor_weight * float(prev['y']) +
                                  neighbor_weight * float(next_pt['y']))

                    smoothed_path.append({'x': smoothed_x, 'y': smoothed_y})

                # Keep last point unchanged
                smoothed_path.append(p_driver_path[-1].copy())

                p_driver_path = smoothed_path

        # Handle potential multiple coordinate lists
        coords_list_raw = [] # Raw paths before interpolation

        # If only p_coordinates (no animated coordinates), skip coords parsing
        if coordinates_data is None:
            coords_list_raw = []
        else:
            try:
                # Use double quotes for JSON standard, replace single quotes if present
                coords_data = json.loads(coordinates_data.replace("'", '"'))
                if isinstance(coords_data, list):
                    if len(coords_data) > 0 and isinstance(coords_data[0], list):
                        # It's a list of lists of coordinates (multiple paths)
                        coords_list_raw = coords_data
                    elif len(coords_data) > 0 and isinstance(coords_data[0], dict):
                        # It's a single list of coordinates (single path)
                        coords_list_raw = [coords_data] # Wrap in a list for consistent processing
                    else:
                         # Handle empty list case or lists containing non-dict/non-list items
                        print(f"Warning: Coordinate data is an empty list or contains unexpected item types: {type(coords_data[0]) if len(coords_data) > 0 else 'N/A'}")
                        # Return empty/black tensor matching expected output shape
                        return (torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32), torch.zeros([1, frame_height, frame_width], dtype=torch.float32))
                else:
                     print(f"Warning: Unexpected coordinate data format: {type(coords_data)}")
                     return (torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32), torch.zeros([1, frame_height, frame_width], dtype=torch.float32))
            except json.JSONDecodeError as e:
                print(f"Error decoding coordinates JSON: {e}")
                print(f"Received coordinates: {coordinates_data}")
                return (torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32), torch.zeros([1, frame_height, frame_width], dtype=torch.float32))
            except Exception as e:
                print(f"Error processing coordinates: {e}")
                return (torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32), torch.zeros([1, frame_height, frame_width], dtype=torch.float32))

            # Scale coordinates if coordinate space differs from bg_image dimensions
            if scale_x != 1.0 or scale_y != 1.0:
                scaled_coords_list = []
                for path in coords_list_raw:
                    scaled_path = []
                    for point in path:
                        scaled_point = {
                            'x': point['x'] * scale_x,
                            'y': point['y'] * scale_y
                        }
                        # Preserve any other properties
                        for key in point:
                            if key not in ['x', 'y']:
                                scaled_point[key] = point[key]
                        scaled_path.append(scaled_point)
                    scaled_coords_list.append(scaled_path)
                coords_list_raw = scaled_coords_list

                # Also scale driver paths if they exist in drivers_meta
                if isinstance(drivers_meta, dict):
                    c_drivers = drivers_meta.get("c", [])
                    if isinstance(c_drivers, list):
                        scaled_c_drivers = []
                        for driver_info in c_drivers:
                            if isinstance(driver_info, dict):
                                scaled_driver_info = driver_info.copy()
                                driver_path = driver_info.get('path')
                                if isinstance(driver_path, list) and driver_path:
                                    scaled_driver_path = []
                                    for point in driver_path:
                                        if isinstance(point, dict) and 'x' in point and 'y' in point:
                                            scaled_point = {
                                                'x': point['x'] * scale_x,
                                                'y': point['y'] * scale_y
                                            }
                                            # Preserve any other properties
                                            for key in point:
                                                if key not in ['x', 'y']:
                                                    scaled_point[key] = point[key]
                                            scaled_driver_path.append(scaled_point)
                                    scaled_driver_info['path'] = scaled_driver_path
                                scaled_c_drivers.append(scaled_driver_info)
                            else:
                                scaled_c_drivers.append(driver_info)
                        drivers_meta['c'] = scaled_c_drivers

        # Extract pause frames for p_coordinates (if using driver)
        p_coords_pause_frames = (0, 0)
        if p_coordinates_use_driver and static_points:
            start_val, end_val = 0, 0
            # Safely extract start pause value
            if isinstance(start_p_frames_meta, dict):
                p_start = start_p_frames_meta.get("p", 0)
                if isinstance(p_start, list) and p_start:
                    start_val = p_start[0]
                elif isinstance(p_start, (int, float)):
                    start_val = p_start
            elif isinstance(start_p_frames_meta, (int, float)):
                start_val = start_p_frames_meta
            
            # Safely extract end pause value
            if isinstance(end_p_frames_meta, dict):
                p_end = end_p_frames_meta.get("p", 0)
                if isinstance(p_end, list) and p_end:
                    end_val = p_end[0]
                elif isinstance(p_end, (int, float)):
                    end_val = p_end
            elif isinstance(end_p_frames_meta, (int, float)):
                end_val = end_p_frames_meta
            
            p_coords_pause_frames = (start_val, end_val)

        # Initialize coords_driver_info_list for all code paths
        coords_driver_info_list = []

        # Check if any valid paths were parsed
        if not coords_list_raw:
            if static_points:
                # No animated coordinates but we have static points
                if p_coordinates_use_driver:
                    # Driver-controlled points - use total_frames from config
                    batch_size = total_frames
                else:
                    # Static points - create 1 frame
                    batch_size = 1
                    total_frames = 1
                processed_coords_list = []
                path_pause_frames = []
            else:
                # No data at all
                print("Warning: No valid coordinate paths or static points found after parsing.")
                return (torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32), torch.zeros([1, frame_height, frame_width], dtype=torch.float32))
        else:
            # --- Interpolate/Downsample Paths --- START ---
            # Normalize pause frames to arrays matching number of paths
            num_paths = len(coords_list_raw)
            # Handle different pause frame formats
            if isinstance(start_p_frames_meta, dict):
                # New format with separate pause frames for p and c
                c_start = start_p_frames_meta.get("c", 0)
                c_end = end_p_frames_meta.get("c", 0)
                # Normalize c pause frames to lists
                if isinstance(c_start, int):
                    start_p_frames_list = [c_start] * num_paths
                    end_p_frames_list = [c_end] * num_paths
                elif isinstance(c_start, list):
                    start_p_frames_list = c_start + [0] * (num_paths - len(c_start))
                    end_p_frames_list = c_end + [0] * (num_paths - len(c_end)) if isinstance(c_end, list) else [c_end] * num_paths
                else:
                    start_p_frames_list = [0] * num_paths
                    end_p_frames_list = [0] * num_paths
            elif isinstance(start_p_frames_meta, int):
                # Single value - apply to all paths
                start_p_frames_list = [start_p_frames_meta] * num_paths
                end_p_frames_list = [end_p_frames_meta] * num_paths
            elif isinstance(start_p_frames_meta, list):
                # Already array - pad if needed
                start_p_frames_list = start_p_frames_meta + [0] * (num_paths - len(start_p_frames_meta))
                end_p_frames_list = end_p_frames_meta + [0] * (num_paths - len(end_p_frames_meta))
            else:
                # Default
                start_p_frames_list = [0] * num_paths
                end_p_frames_list = [0] * num_paths

            # Normalize interpolations to arrays matching number of paths
            interpolations_list = []
            if isinstance(interpolations_meta, dict):
                c_interpolations = interpolations_meta.get("c", 'linear')
                if isinstance(c_interpolations, str):
                    interpolations_list = [c_interpolations] * num_paths
                elif isinstance(c_interpolations, list):
                    interpolations_list = c_interpolations + ['linear'] * (num_paths - len(c_interpolations))
                else:
                    interpolations_list = ['linear'] * num_paths
            elif isinstance(interpolations_meta, str):
                interpolations_list = [interpolations_meta] * num_paths
            elif isinstance(interpolations_meta, list):
                interpolations_list = interpolations_meta + ['linear'] * (num_paths - len(interpolations_meta))
            else:
                interpolations_list = ['linear'] * num_paths

            # Normalize drivers to arrays matching number of paths
            drivers_list = []
            if isinstance(drivers_meta, dict):
                c_drivers = drivers_meta.get("c", [])
                if isinstance(c_drivers, list):
                    # Pad with None if list is shorter than num_paths
                    drivers_list = c_drivers + [None] * (num_paths - len(c_drivers))
                else:
                    drivers_list = [None] * num_paths
            else:
                drivers_list = [None] * num_paths

            # Normalize offsets to arrays matching number of paths
            num_paths = len(coords_list_raw)
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

            processed_coords_list = []
            path_pause_frames = []  # Store (start_p, end_p) for each processed path
            valid_paths_exist = False
            for i, path in enumerate(coords_list_raw):
                if isinstance(path, list) and len(path) > 0:
                     # Validate points format within the path
                     valid_path = True
                     for pt_idx, pt in enumerate(path):
                         if not isinstance(pt, dict) or 'x' not in pt or 'y' not in pt:
                             print(f"Warning: Invalid point format in path {i} at index {pt_idx}: {pt}. Skipping path.")
                             valid_path = False
                             break
                         # Attempt to convert coords to float immediately
                         try:
                             pt['x'] = float(pt['x'])
                             pt['y'] = float(pt['y'])
                         except (ValueError, TypeError):
                             print(f"Warning: Non-numeric coordinate value in path {i} at index {pt_idx}: {pt}. Skipping path.")
                             valid_path = False
                             break

                     if valid_path:
                             try:
                                 # Get per-path pause frames, offset, and interpolation type
                                 path_start_p = start_p_frames_list[i]
                                 path_end_p = end_p_frames_list[i]
                                 path_offset = offsets_list[i]
                                 path_interpolation = interpolations_list[i] # Get interpolation type for this path
                                 path_driver_info = drivers_list[i] if i < len(drivers_list) else None  # Get driver info for this path

                                 # Calculate animation frames for this specific path
                                 path_animation_frames = total_frames - path_start_p - path_end_p

                                 effective_easing_path = easing_path

                                 # Mark original points as control points for 'each' easing
                                 if effective_easing_path == 'each':
                                     for p in path:
                                         p['is_control'] = True

                                 # Perform interpolation based on type
                                 if path_interpolation == 'points':
                                     # 'points' mode means use raw control points, no interpolation
                                     interpolated_path = path
                                 else:
                                     # Perform backend interpolation for linear, cardinal, basis
                                     interpolated_path = draw_utils.interpolate_points(path, path_interpolation, effective_easing_path)
                                 
                                 # Resample the (potentially newly interpolated) path to match animation frames
                                 # InterpMath.interpolate_or_downsample_path is now used for resampling only
                                 processed_path = draw_utils.InterpMath.interpolate_or_downsample_path(interpolated_path, path_animation_frames, easing_function, effective_easing_path, bounce_between=0.0, easing_strength=easing_strength, interpolation=path_interpolation)

                                 # --- PREPARE DRIVER FOR PER-FRAME APPLICATION ---
                                 # Prepare driver info for per-frame application (only for animated coordinates)
                                 driver_info_for_frame = None
                                 if path_driver_info and isinstance(path_driver_info, dict):
                                     raw_driver_path = path_driver_info.get('path')
                                     driver_rotate = path_driver_info.get('rotate', 0)
                                     driver_smooth = path_driver_info.get('smooth', 0.0)

                                     if raw_driver_path and len(raw_driver_path) > 0:
                                         # Apply rotation to driver path
                                         transformed_driver = raw_driver_path
                                         if driver_rotate != 0:
                                             transformed_driver = rotate_path(transformed_driver, driver_rotate)

                                         # Apply smoothing to driver path
                                         if driver_smooth > 0.0:
                                             transformed_driver = smooth_path(transformed_driver, driver_smooth)

                                         # Interpolate to total_frames for per-frame use
                                         interpolated_driver = draw_utils.InterpMath.interpolate_or_downsample_path(
                                             transformed_driver, total_frames, easing_function, easing_path,
                                             bounce_between=0.0, easing_strength=easing_strength
                                         )

                                         driver_info_for_frame = {
                                             'interpolated_path': interpolated_driver,
                                             'pause_frames': (path_start_p, path_end_p)
                                         }

                                 coords_driver_info_list.append(driver_info_for_frame)
                                 # --- END PREPARE DRIVER ---

                                 # --- APPLY OFFSET TIMING ---
                                 # Offset creates pause frames by removing coordinates and adjusting pause metadata
                                 # Positive: removes LAST N frames → adds start pause → waits at START, plays to N before end
                                 # Negative: removes LAST N frames → adds end pause → plays normally, holds at END
                                 if path_offset != 0:
                                     processed_path, start_adj, end_adj = self._apply_offset_timing(processed_path, path_offset)
                                     path_start_p += start_adj  # Add removed start frames to pause
                                     path_end_p += end_adj      # Add removed end frames to pause
                                     print(f"[Offset Applied] Path {i}: offset={path_offset}, removed {start_adj} start + {end_adj} end frames, new pause: ({path_start_p}, {path_end_p})")
                                 # --- END APPLY OFFSET TIMING ---

                                 processed_coords_list.append(processed_path)
                                 path_pause_frames.append((path_start_p, path_end_p))  # Store adjusted pause frames for this path
                                 valid_paths_exist = True
                             except Exception as e:
                                 print(f"Error processing path {i} with interpolation/downsampling: {e}. Skipping path.")
                     # else: path was already marked invalid
                else:
                     print(f"Warning: Skipping empty or invalid path item {i} (type: {type(path)}). Len: {len(path) if isinstance(path, list) else 'N/A'}")
                 
            if not valid_paths_exist:
                print("Warning: No valid paths remained after processing/validation.")
                return (torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32), torch.zeros([1, frame_height, frame_width], dtype=torch.float32))
            # --- Interpolate/Downsample Paths --- END ---

        # Batch size is always total_frames (before/after frames hold position, don't add frames)
        batch_size = total_frames
        
        # --- Use threading to generate frames ---
        # Simplified: Now PIL is used only if blur > 0, otherwise tensors handled directly?
        # Let's stick to threading for PIL generation for now, simpler refactor.
        pil_images = [None] * batch_size # Pre-allocate list for results


        # Use ThreadPoolExecutor to run _draw_single_frame_pil in parallel threads
        with concurrent.futures.ThreadPoolExecutor() as executor:
            # Build args list - pass frame_index directly and let draw function map per-path
            args_list = []
            for i in range(batch_size):
                args_list.append((i, processed_coords_list, path_pause_frames, total_frames, frame_width, frame_height, shape_width, shape_height, shape_color, bg_color, blur_radius, shape, border_width, border_color, static_points, p_coordinates_use_driver, p_driver_path, p_coords_pause_frames, coords_driver_info_list))

            try:
                # Pass the method directly to map
                results = list(executor.map(lambda p: self._draw_single_frame_pil(*p), args_list))
                pil_images = results # Assign results directly
            except Exception as e:
                 print(f"Error during threaded frame generation: {e}")
                 # If map fails, fill with blank images as a fallback
                 pil_images = [Image.new("RGB", (frame_width, frame_height), bg_color) for _ in range(batch_size)]


        # --- Post-processing loop (sequential for trailing effect) ---
        images_list_bchw = [] # Collect final BCHW tensors
        masks_list_bhw = [] # Collect final BHW tensors
        previous_output_chw = None # For trailing effect, needs to be CHW

        for i in range(batch_size):
            pil_image = pil_images[i]
            if pil_image is None: # Should not happen with fallback, but safety check
                 print(f"Warning: Missing PIL image for frame {i}, using blank.")
                 pil_image = Image.new("RGB", (frame_width, frame_height), bg_color)

            # Convert PIL image (RGB) to tensor (BHWC, float 0-1)
            image_tensor_bhwc = pil2tensor(pil_image) 
            
            # If image_tensor_bhwc has unexpected shape, try to recover or use zeros
            if image_tensor_bhwc.shape[0] != 1 or image_tensor_bhwc.shape[1] != frame_height or image_tensor_bhwc.shape[2] != frame_width:
                 print(f"Warning: Tensor shape mismatch for frame {i}. Expected [1, {frame_height}, {frame_width}, 3], got {image_tensor_bhwc.shape}. Using zeros.")
                 image_tensor_bhwc = torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32)

            # Remove batch dim (B=1), permute to CHW for processing
            image_tensor_chw = image_tensor_bhwc[0].permute(2, 0, 1) # CHW [C, H, W]

            # Apply trailing effect (works on CHW tensor)
            if trailing != 1.0 and previous_output_chw is not None:
                try:
                    # Ensure previous tensor is on the same device as current
                    if previous_output_chw.device != image_tensor_chw.device:
                         previous_output_chw = previous_output_chw.to(image_tensor_chw.device)
                         
                    image_tensor_chw = image_tensor_chw + trailing * previous_output_chw
                    # Clamp after adding trailing
                    image_tensor_chw = torch.clamp(image_tensor_chw, 0.0, 1.0) 

                except Exception as e:
                    print(f"Error applying trailing effect at index {i}: {e}. Skipping trailing.")
                    # Skip trailing for this frame

            # Store current tensor (CHW) for next iteration's trailing calculation
            previous_output_chw = image_tensor_chw.clone() if trailing != 1.0 else None

            # Apply intensity (on CHW tensor)
            image_tensor_chw = image_tensor_chw * intensity
            
            # Clamp final CHW image tensor before creating mask and appending
            image_tensor_chw = torch.clamp(image_tensor_chw, 0.0, 1.0)
            
            # Create mask (take Red channel [0] from CHW tensor)
            mask_tensor_hw = image_tensor_chw[0, :, :].clone() # HW tensor
            
            # Append tensors (add batch dim back)
            masks_list_bhw.append(mask_tensor_hw.unsqueeze(0)) # BH_mask W_mask
            images_list_bchw.append(image_tensor_chw.unsqueeze(0)) # BCHW

        # --- Concatenate the list of tensors into batch tensors ---
        if not images_list_bchw or not masks_list_bhw:
             print("Warning: No images or masks were generated after post-processing.")
             # Use derived dimensions for fallback tensor
             return (torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32), 
                     torch.zeros([1, frame_height, frame_width], dtype=torch.float32))

        # Concatenate image tensors (BCHW)
        out_images_bchw = torch.cat(images_list_bchw, dim=0)
        # Permute to ComfyUI format (BHWC) and move to CPU
        out_images = out_images_bchw.permute(0, 2, 3, 1).cpu().float()

        # Concatenate mask tensors (BHW)
        out_masks = torch.cat(masks_list_bhw, dim=0).cpu().float()
        
        # Final clamp on output tensors (safety net)
        out_images = torch.clamp(out_images, 0.0, 1.0)
        out_masks = torch.clamp(out_masks, 0.0, 1.0)

        # --- Prepare output coordinates ---
        output_coords_json = "[]"
        if processed_coords_list:
            # For simplicity, output the coordinates of the first path
            first_path_coords = []
            path_start_p, path_end_p = path_pause_frames[0]
            
            for i in range(total_frames):
                coord_index = 0 # Default to first point
                if i < path_start_p:
                    coord_index = 0
                elif i >= total_frames - path_end_p:
                    coord_index = len(processed_coords_list[0]) - 1
                else:
                    coord_index = i - path_start_p
                
                # Clamp index to be safe
                if processed_coords_list[0]:
                    coord_index = max(0, min(coord_index, len(processed_coords_list[0]) - 1))
                    first_path_coords.append(processed_coords_list[0][coord_index])

            output_coords_json = json.dumps(first_path_coords)

        return (out_images, out_masks, output_coords_json)