import torch
import json
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageColor
import torch.nn.functional as F # Added for grid_sample
# Assuming utility functions are in a parent directory utility module
from ..utility.utility import pil2tensor, tensor2pil # Ensure both are imported
from ..utility import draw_utils

class DrawJointOnPath:
    RETURN_TYPES = ("IMAGE", "STRING",) # Added STRING
    RETURN_NAMES = ("image", "output_coordinates",) # Added output_coordinates
    FUNCTION = "create"
    CATEGORY = "WanVideoWrapper_QQ/depr"
    DESCRIPTION = """
Draws a rectangle defined by the first and last points of a coordinate list.
The width is controlled by shape_width, and the length is the distance between the first and last points.
If pivot_coordinates are provided:
  - relative_pivot=True: The pivot movement offsets the entire shape from its path-defined position.
  - relative_pivot=False: The pivot replaces the starting point of the shape for positioning.
"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "coordinates": ("STRING", {"multiline": True, "default": '[{"x":100,"y":100},{"x":400,"y":400}]'}),
                "bg_image": ("IMAGE", ),
                "path_frame_config": ("PATH_FRAME_CONFIG", ),
                "shape_width": ("INT", {"default": 20, "min": 1, "max": 4096, "step": 1}),
                "shape_width_end": ("INT", {"default": 0, "min": 0, "max": 4096, "step": 0}),
                "bg_color": ("STRING", {"default": "black"}),
                "fill_color": ("STRING", {"default": "white"}),
                "blur_radius": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100.0, "step": 0.1}),
                "intensity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 100.0, "step": 0.01}),
                "trailing": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 2.0, "step": 0.01}),
                "bounce_between": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01}),
            },
            "optional": {
                "pivot_coordinates": ("STRING", {"multiline": False}),
                "relative_pivot": ("BOOLEAN", {"default": True}),
                "scaling_enabled": ("BOOLEAN", {"default": True}),
            }
        }

    def create(self, coordinates, bg_image, shape_width, shape_width_end, fill_color, bg_color, path_frame_config, blur_radius, intensity, trailing, bounce_between,
                scaling_enabled=False,
                pivot_coordinates=None,
                relative_pivot=True):
        # Extract config parameters
        total_frames = path_frame_config["total_frames"]
        easing_function = path_frame_config["easing_function"]
        easing_path = path_frame_config["easing_path"]
        easing_strength = path_frame_config.get("easing_strength", 1.0)  # Default to 1.0 for backward compatibility

        # Parse coordinates to extract metadata (new format) or use defaults (old format)
        start_p_frames = 0
        end_p_frames = 0
        coordinates_data = coordinates  # Will be updated if new format is detected

        try:
            coord_parsed = json.loads(coordinates.replace("'", '"'))
            # Check if it's the new metadata format
            if isinstance(coord_parsed, dict) and "coordinates" in coord_parsed:
                # New format: extract metadata
                start_p_frames = coord_parsed.get("start_p_frames", 0)
                end_p_frames = coord_parsed.get("end_p_frames", 0)
                # Re-serialize just the coordinates for downstream parsing
                coordinates_data = json.dumps(coord_parsed["coordinates"])
                print(f"DrawJointOnPath: Using coordinate metadata - start_p_frames={start_p_frames}, end_p_frames={end_p_frames}")
            else:
                # Old format: coordinates is already the right format
                coordinates_data = coordinates
                print("DrawJointOnPath: Using old coordinate format (no metadata)")
        except (json.JSONDecodeError, TypeError, KeyError) as e:
            print(f"DrawJointOnPath: Error parsing coordinates metadata: {e}. Using defaults.")
            coordinates_data = coordinates

        # Calculate animation frames (excluding before/after hold frames)
        animation_frames = total_frames - start_p_frames - end_p_frames

        output_coords_list = [] # Initialize list for output coordinates

        # --- Get frame dimensions from bg_image --- 
        try:
            _, frame_height, frame_width, _ = bg_image.shape
            print(f"Using dimensions from bg_image: {frame_width}x{frame_height}")
        except Exception as e:
            print(f"Error getting dimensions from bg_image: {e}. Using default 512x512.")
            frame_width, frame_height = 512, 512 # Fallback dimensions

        # --- Standardize coordinates input ---
        if isinstance(coordinates_data, str):
            # Try parsing as a list of lists first, if it looks like it
            try:
                potential_list = json.loads(coordinates_data.replace("'", '"'))
                if isinstance(potential_list, list) and all(isinstance(item, list) for item in potential_list):
                    # It's likely a string representation of a list of paths
                    # Re-dump each inner list to treat them as separate coord strings
                    coord_strings = [json.dumps(path) for path in potential_list]
                    print(f"Interpreted single string input as {len(coord_strings)} paths.")
                elif isinstance(potential_list, list) and all(isinstance(item, dict) for item in potential_list):
                     # It's a single path represented as a string
                     coord_strings = [coordinates_data]
                else:
                     # Fallback: treat as single path string if format is unexpected
                     print("Warning: Unexpected format in single coordinate string. Treating as one path.")
                     coord_strings = [coordinates_data]
            except Exception as e:
                 print(f"Warning: Could not parse single coordinate string as JSON list. Treating as one path string. Error: {e}")
                 coord_strings = [coordinates_data] # Treat as a single path string if parsing fails
        elif isinstance(coordinates_data, list) and all(isinstance(item, str) for item in coordinates_data):
            coord_strings = coordinates_data # Already a list of strings
        else:
            print(f"Error: Invalid coordinates input type: {type(coordinates_data)}. Expected string or list of strings.")
            # Use derived dimensions for fallback image
            img = Image.new('RGB', (frame_width, frame_height), color=bg_color)
            return (pil2tensor(img), json.dumps([])) # Return empty coords list as well

        all_paths_control_points = []
        all_paths_processed = [] # Store the interpolated/downsampled paths
        all_paths_original_p0 = []
        all_paths_initial_p1 = []
        valid_paths_found = False
        for i, coord_string in enumerate(coord_strings):
            try:
                coords = json.loads(coord_string.replace("'", '"'))
                if not isinstance(coords, list) or len(coords) < 1: # Need at least 1 point
                    print(f"Warning: Path {i+1} has < 1 point or invalid format. Skipping.")
                    all_paths_control_points.append(None) # Placeholder for skipped path
                    all_paths_processed.append(None)
                    all_paths_original_p0.append(None)
                    all_paths_initial_p1.append(None)
                    continue
                # Validate and convert points
                points_validated = []
                valid_path_segment = True
                for pt_idx, pt in enumerate(coords):
                    if not isinstance(pt, dict) or 'x' not in pt or 'y' not in pt:
                         print(f"Warning: Invalid point format in path {i} at index {pt_idx}: {pt}. Skipping path.")
                         valid_path_segment = False
                         break
                    try:
                         pt_copy = pt.copy()
                         pt_copy['x'] = float(pt['x'])
                         pt_copy['y'] = float(pt['y'])
                         points_validated.append(pt_copy)
                    except (ValueError, TypeError):
                         print(f"Warning: Non-numeric coordinate value in path {i} at index {pt_idx}: {pt}. Skipping path.")
                         valid_path_segment = False
                         break
                         
                if not valid_path_segment:
                     all_paths_control_points.append(None)
                     all_paths_processed.append(None)
                     all_paths_original_p0.append(None)
                     all_paths_initial_p1.append(None)
                     continue
                     
                # Store original control points as numpy arrays for fixed length/vector calculation
                control_points_np = [np.array((p['x'], p['y'])) for p in points_validated]
                all_paths_control_points.append(control_points_np)
                all_paths_original_p0.append(control_points_np[0])
                all_paths_initial_p1.append(control_points_np[1] if len(control_points_np) > 1 else control_points_np[0])

                # Process the path using InterpMath with animation_frames (not total_frames)
                processed_path = draw_utils.InterpMath.interpolate_or_downsample_path(points_validated, animation_frames, easing_function, easing_path, bounce_between=bounce_between, easing_strength=easing_strength)
                all_paths_processed.append(processed_path)
                valid_paths_found = True
            except Exception as e:
                print(f"Error parsing coordinates for path {i+1}: {e}. Skipping path.")
                all_paths_control_points.append(None) # Placeholder for skipped path
                all_paths_processed.append(None)
                all_paths_original_p0.append(None)
                all_paths_initial_p1.append(None)
                continue

        if not valid_paths_found:
             print("Error: No valid coordinate paths found.")
             # Use derived dimensions for fallback image
             img = Image.new('RGB', (frame_width, frame_height), color=bg_color)
             return (pil2tensor(img), json.dumps([])) # Return empty coords list as well

        output_images = []
        previous_frame_tensor = None

        # --- Parse and Adjust Pivot Coordinates ---
        # (Applies the *same* pivot motion to *all* paths if provided)
        pivot_points_adjusted = None
        use_dynamic_pivot = False
        static_pivot_point = None # Used if pivot_coordinates is None or invalid

        if pivot_coordinates and pivot_coordinates.strip() and pivot_coordinates.strip() != '[]':
            try:
                pivot_coords_raw = json.loads(pivot_coordinates.replace("'", '"'))
                if isinstance(pivot_coords_raw, list) and len(pivot_coords_raw) > 0:
                    pivot_points_raw = [np.array((c['x'], c['y'])) for c in pivot_coords_raw]
                    current_len = len(pivot_points_raw)
                    if current_len < total_frames:
                        last_point = pivot_points_raw[-1]
                        padding = [last_point] * (total_frames - current_len)
                        pivot_points_adjusted = pivot_points_raw + padding
                    elif current_len > total_frames:
                        pivot_points_adjusted = pivot_points_raw[:total_frames]
                    else:
                        pivot_points_adjusted = pivot_points_raw

                    if pivot_points_adjusted:
                         use_dynamic_pivot = True
                         print(f"Using dynamic pivot points. Adjusted count: {len(pivot_points_adjusted)}")
            except Exception as e:
                print(f"Warning: Error parsing pivot_coordinates: {e}. Using static p0 for each path.")
                use_dynamic_pivot = False
        # else: use_dynamic_pivot remains False

        # --- Pre-calculate fixed length and direction for paths if needed ---
        all_paths_fixed_length = []
        all_paths_fixed_v_normalized = []
        for i in range(len(all_paths_control_points)):
             if all_paths_control_points[i] is None:
                 all_paths_fixed_length.append(0)
                 all_paths_fixed_v_normalized.append(None)
                 continue

             p0_orig = all_paths_original_p0[i]
             p1_init = all_paths_initial_p1[i]
             fixed_v = p1_init - p0_orig
             fixed_len = np.linalg.norm(fixed_v)
             fixed_v_norm = None
             if fixed_len > 0 and not scaling_enabled:
                 fixed_v_norm = fixed_v / fixed_len
             elif fixed_len == 0 and not scaling_enabled:
                 print(f"Warning: Path {i+1} initial control points p0 and p1 are identical. Fixed length is 0.")
                 pass # No action needed for zero length path

             all_paths_fixed_length.append(fixed_len)
             all_paths_fixed_v_normalized.append(fixed_v_norm)


        try:
            fill_rgb = ImageColor.getrgb(fill_color)
        except ValueError:
            print(f"Warning: Invalid fill_color '{fill_color}'. Defaulting to white.")
            fill_rgb = (255, 255, 255)

        # --- Loop through frames ---
        for frame_idx in range(total_frames):
            img_frame = Image.new('RGB', (frame_width, frame_height), color=bg_color)
            draw_frame = ImageDraw.Draw(img_frame)

            # Map frame index to coordinate index (before/after frames "hold" at start/end)
            if frame_idx < start_p_frames:
                coord_index = 0  # Hold at first position for start_p_frames
            elif frame_idx >= total_frames - end_p_frames:
                coord_index = animation_frames - 1  # Hold at last position for end_p_frames
            else:
                coord_index = frame_idx - start_p_frames  # Normal animation frames

            # --- Loop through paths for the current frame ---
            for path_idx, control_points in enumerate(all_paths_control_points):
                if control_points is None: # Skip invalid/skipped paths
                    continue

                p0_original = all_paths_original_p0[path_idx]
                # p1_initial = all_paths_initial_p1[path_idx] # No longer needed directly here
                fixed_length = all_paths_fixed_length[path_idx]
                fixed_v_normalized = all_paths_fixed_v_normalized[path_idx]

                # Get the pre-calculated point for this frame and path
                processed_path_for_frame = all_paths_processed[path_idx]
                if processed_path_for_frame is None or coord_index >= len(processed_path_for_frame):
                     print(f"Warning: Missing processed point for coord_index {coord_index}, path {path_idx}. Skipping draw.")
                     continue

                current_frame_point = processed_path_for_frame[coord_index] # This is a dict {'x': ?, 'y': ?}
                target_point_relative_to_p0 = np.array((current_frame_point['x'], current_frame_point['y'])) - p0_original

                # --- Determine current pivot for this frame ---
                # If dynamic pivot is used, all paths use the same pivot point for this frame.
                # Otherwise, each path uses its own original p0 as the static pivot.
                current_pivot = p0_original # Default to path's own p0 if no dynamic pivot
                if use_dynamic_pivot and pivot_points_adjusted:
                    # Use coord_index for pivot lookup to match animation
                    pivot_idx = min(coord_index, len(pivot_points_adjusted) - 1)
                    current_pivot = pivot_points_adjusted[pivot_idx]

                # --- Apply Relative vs Absolute Pivot Logic ---
                draw_start_point = None
                draw_end_point = None
                length_for_draw = 0
                normalized_v_for_draw = None

                if relative_pivot:
                    # 1. Calculate the shape's geometry based *only* on its own path, originating at p0_original
                    #    (p0_calc, pn_calc, length_calc, normalized_v_calc)
                    p0_calc = p0_original
                    target_calc = p0_calc + target_point_relative_to_p0
                    v_dir_calc = target_calc - p0_calc
                    dir_length_calc = np.linalg.norm(v_dir_calc)
                    pn_calc = p0_calc # Default end point is start
                    length_calc = 0
                    normalized_v_calc = None

                    if scaling_enabled:
                        if dir_length_calc > 0:
                            pn_calc = target_calc
                            length_calc = dir_length_calc
                            normalized_v_calc = v_dir_calc / length_calc
                    else: # Fixed Length
                        if fixed_length > 0:
                            length_calc = fixed_length
                            if dir_length_calc > 0:
                                normalized_v_calc = v_dir_calc / dir_length_calc
                                pn_calc = p0_calc + normalized_v_calc * length_calc
                            elif fixed_v_normalized is not None:
                                normalized_v_calc = fixed_v_normalized
                                pn_calc = p0_calc + normalized_v_calc * length_calc

                    # 2. Determine the initial offset (once per path, could be cached outside frame loop if performance needed)
                    initial_pivot_point = p0_original # Default if no dynamic pivot used for frame 0
                    if use_dynamic_pivot and pivot_points_adjusted:
                        initial_pivot_point = pivot_points_adjusted[0]
                    initial_offset_vector = p0_original - initial_pivot_point

                    # 3. Apply the *initial* offset to the *current* pivot point to get the draw start point
                    frame_pivot_point = current_pivot # Already determined for this frame
                    draw_start_point = frame_pivot_point + initial_offset_vector

                    # 4. Calculate the draw end point by applying the shape's calculated vector to the draw start point
                    shape_vector = pn_calc - p0_calc
                    draw_end_point = draw_start_point + shape_vector

                    # 5. Set draw parameters
                    length_for_draw = length_calc
                    normalized_v_for_draw = normalized_v_calc

                else: # Absolute pivot positioning (previous logic)
                    # Calculate offset target based on current pivot
                    offset_target = current_pivot + target_point_relative_to_p0

                    # Determine vector, length, end point (pn) based on current_pivot, offset_target, scaling
                    v_dir = offset_target - current_pivot
                    dir_length = np.linalg.norm(v_dir)
                    pn = current_pivot # Default end point is the pivot itself
                    length = 0
                    normalized_v = None

                    if scaling_enabled:
                        if dir_length > 0:
                            pn = offset_target
                            length = dir_length
                            normalized_v = v_dir / length
                    else: # Fixed Length
                        if fixed_length > 0:
                            length = fixed_length
                            if dir_length > 0:
                                normalized_v = v_dir / dir_length
                                pn = current_pivot + normalized_v * length
                            elif fixed_v_normalized is not None:
                                normalized_v = fixed_v_normalized
                                pn = current_pivot + normalized_v * length

                    # Set draw parameters
                    draw_start_point = current_pivot
                    draw_end_point = pn
                    length_for_draw = length
                    normalized_v_for_draw = normalized_v

                # --- Draw the polygon for this path using calculated/offset points ---
                if length_for_draw > 0 and normalized_v_for_draw is not None and draw_start_point is not None and draw_end_point is not None:
                    perp_v = np.array([-normalized_v_for_draw[1], normalized_v_for_draw[0]])
                    
                    # Calculate half-widths for start and end based on inputs
                    half_w_start = perp_v * (shape_width / 2.0)
                    
                    # Use shape_width_end if > 0, otherwise use shape_width
                    end_width = shape_width_end if shape_width_end > 0 else shape_width
                    half_w_end = perp_v * (end_width / 2.0)
                    
                    # Use draw_start_point and draw_end_point for corners with respective widths
                    c1 = tuple((draw_start_point - half_w_start).astype(int))
                    c2 = tuple((draw_start_point + half_w_start).astype(int))
                    c3 = tuple((draw_end_point + half_w_end).astype(int)) # Use end width at the end point
                    c4 = tuple((draw_end_point - half_w_end).astype(int)) # Use end width at the end point

                    draw_frame.polygon([c1, c2, c3, c4], fill=fill_rgb)

                # --- Store output coordinate for the first path ---
                if path_idx == 0:
                    if draw_end_point is not None:
                        output_coords_list.append({'x': int(round(draw_end_point[0])), 'y': int(round(draw_end_point[1]))})
                    elif draw_start_point is not None: # Fallback if end point is None but start isn't
                        print(f"Warning Frame {frame_index}: draw_end_point was None for path 0. Using draw_start_point for output coords.")
                        output_coords_list.append({'x': int(round(draw_start_point[0])), 'y': int(round(draw_start_point[1]))})
                    else: # Fallback if both are None
                         print(f"Warning Frame {frame_index}: Both start and end points were None for path 0. Appending {{'x':0, 'y':0}} to output coords.")
                         output_coords_list.append({'x': 0, 'y': 0})

            # --- Post-processing for the completed frame ---
            if blur_radius > 0.0:
                img_frame = img_frame.filter(ImageFilter.GaussianBlur(blur_radius))

            current_frame_tensor = pil2tensor(img_frame)

            if trailing > 0.0 and previous_frame_tensor is not None:
                current_frame_tensor = current_frame_tensor + trailing * previous_frame_tensor
                # Normalize after adding trailing to prevent exceeding 1.0 (or clamp)
                max_val = torch.max(current_frame_tensor)
                if max_val > 1.0:
                    current_frame_tensor = current_frame_tensor / max_val # Normalize
                    # Alternative: Clamping
                    # current_frame_tensor = torch.clamp(current_frame_tensor, 0.0, 1.0)

            previous_frame_tensor = current_frame_tensor.clone() # Store state before intensity multiplication

            # Apply intensity (on CHW tensor)
            current_frame_tensor = current_frame_tensor * intensity
            # Clamp final CHW image tensor before creating mask and appending
            current_frame_tensor = torch.clamp(current_frame_tensor, 0.0, 1.0)

            output_images.append(current_frame_tensor)

        # --- Final Output ---
        if not output_images:
            print("Warning: No frames generated. Returning a single blank image.")
            # Use derived dimensions for fallback image
            img = Image.new('RGB', (frame_width, frame_height), color=bg_color)
            return (pil2tensor(img), json.dumps([])) # Return empty coords list as well

        # --- Final Output ---
        output_coords_json = json.dumps(output_coords_list, separators=(',', ':')) # Convert list to JSON string
        batch_output = torch.cat(output_images, dim=0)
        return (batch_output, output_coords_json,) # Added output_coords_json
