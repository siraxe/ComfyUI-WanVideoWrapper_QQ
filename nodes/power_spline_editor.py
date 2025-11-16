import io
import json
import torch
import base64
import math

from torchvision import transforms
from ..utility.driver_utils import apply_driver_offset

BOX_BASE_RADIUS = 56

class PowerSplineEditor:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "points_store": ("STRING", {"default": "[{\"x\":200,\"y\":240},{\"x\":304,\"y\":240}]", "multiline": False}),
                "coordinates": ("STRING", {"multiline": False}),
                "mask_width": ("INT", {"default": 640, "min": 8, "max": 4096, "step": 8}),
                "mask_height": ("INT", {"default": 480, "min": 8, "max": 4096, "step": 8}),
                "bg_img": (["None", "A", "B", "C"], {"default": "None", "tooltip": "Select background image to overlay at 60% opacity"}),
            },
            "optional": {
                "ref_image": ("IMAGE", ),
                "coord_in": ("STRING", {"forceInput": True}),
                "frames": ("INT", {"forceInput": True}),
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING", "INT",)
    RETURN_NAMES = ("ref_image", "coord_out", "frames",)
    FUNCTION = "splinedata"
    CATEGORY = "WanVideoWrapper_QQ"
    DESCRIPTION = """WIP"""

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

    def _interpolate_points(self, points, interpolation, steps_per_segment=3):
        """Helper function to interpolate points based on the chosen method."""
        if not points:
            return []

        if len(points) < 2 or interpolation == 'linear':
            # Not enough points to interpolate or linear selected
            return points

        if interpolation == 'cardinal':
            # First, duplicate highlighted points to force hard corners
            # For Catmull-Rom, duplicating a point makes the curve pass through it as a corner
            processed_points = []
            for i, point in enumerate(points):
                if point.get('highlighted', False):
                    # Duplicate the highlighted point to force a corner
                    processed_points.append(point)
                    processed_points.append(point)
                else:
                    processed_points.append(point)

            # Now interpolate using the processed points
            interpolated_points = []
            num_points = len(processed_points)

            # Catmull-Rom requires 4 points (p0, p1, p2, p3) to define the segment between p1 and p2
            padded_points = [processed_points[0]] + processed_points + [processed_points[-1]]

            for i in range(num_points - 1):
                p0 = padded_points[i]
                p1 = padded_points[i+1]
                p2 = padded_points[i+2]
                p3 = padded_points[i+3]

                if i == 0:
                    # First point - preserve is_control property
                    first_point = {'x': p1['x'], 'y': p1['y']}
                    if p1.get('is_control', False):
                        first_point['is_control'] = True
                    if p1.get('highlighted', False):
                        first_point['highlighted'] = True
                    interpolated_points.append(first_point)

                # Calculate intermediate points (Catmull-Rom, tension=0)
                for t_step in range(1, steps_per_segment + 1):
                    t = t_step / float(steps_per_segment)
                    t2 = t * t
                    t3 = t2 * t

                    # Catmull-Rom spline formula coefficients
                    c0 = -0.5 * t3 + 1.0 * t2 - 0.5 * t
                    c1 =  1.5 * t3 - 2.5 * t2 + 1.0
                    c2 = -1.5 * t3 + 2.0 * t2 + 0.5 * t
                    c3 =  0.5 * t3 - 0.5 * t2

                    x = p0['x'] * c0 + p1['x'] * c1 + p2['x'] * c2 + p3['x'] * c3
                    y = p0['y'] * c0 + p1['y'] * c1 + p2['y'] * c2 + p3['y'] * c3
                    point_data = {'x': round(x), 'y': round(y)}

                    # Check if this is the last step (t=1.0) - this represents the next control point
                    if t_step == steps_per_segment:
                        # This is p2 (the next control point)
                        if p2.get('is_control', False):
                            point_data['is_control'] = True

                    # Preserve highlighted property if it exists on the current segment's control point
                    if p1.get('highlighted', False):
                        point_data['highlighted'] = True
                    interpolated_points.append(point_data)

            # Ensure the very last point is included exactly
            if interpolated_points[-1] != processed_points[-1]:
                last_point = {'x': processed_points[-1]['x'], 'y': processed_points[-1]['y']}
                if processed_points[-1].get('is_control', False):
                    last_point['is_control'] = True
                if processed_points[-1].get('highlighted', False):
                    last_point['highlighted'] = True
                interpolated_points.append(last_point)

            return interpolated_points

        if interpolation == 'basis':
            # First, insert duplicate points at highlighted positions to force hard corners
            # B-spline needs multiple duplicates to create a corner
            processed_points = []
            for i, point in enumerate(points):
                if point.get('highlighted', False):
                    # Duplicate the highlighted point 3 times to force a sharp corner in B-spline
                    processed_points.append(point)
                    processed_points.append(point)
                    processed_points.append(point)
                else:
                    processed_points.append(point)

            # Now interpolate using the processed points
            interpolated_points = []
            num_points = len(processed_points)

            # B-spline (basis) requires 4 points for a segment
            padded_points = [processed_points[0], processed_points[0]] + processed_points + [processed_points[-1], processed_points[-1]]

            for i in range(num_points + 1):
                p0 = padded_points[i]
                p1 = padded_points[i + 1]
                p2 = padded_points[i + 2]
                p3 = padded_points[i + 3]

                # B-spline basis function (cubic)
                for t_step in range(0, steps_per_segment):
                    t = t_step / float(steps_per_segment)
                    t2 = t * t
                    t3 = t2 * t

                    # B-spline basis coefficients
                    b0 = (1 - t) ** 3 / 6
                    b1 = (3 * t3 - 6 * t2 + 4) / 6
                    b2 = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6
                    b3 = t3 / 6

                    x = p0['x'] * b0 + p1['x'] * b1 + p2['x'] * b2 + p3['x'] * b3
                    y = p0['y'] * b0 + p1['y'] * b1 + p2['y'] * b2 + p3['y'] * b3
                    point_data = {'x': round(x), 'y': round(y)}

                    # Mark control points: first point in segment if it represents a control point
                    if t_step == 0 and p1.get('is_control', False):
                        point_data['is_control'] = True

                    # Preserve highlighted property if it exists on the current segment's control point
                    if p1.get('highlighted', False):
                        point_data['highlighted'] = True
                    interpolated_points.append(point_data)

            return interpolated_points

        else:
            # Default fallback (shouldn't happen with current INPUT_TYPES)
            return points

    def _round_points(self, points, precision=4):
        """Return a deep copy of points with x/y rounded to desired precision."""
        rounded = []
        for pt in points or []:
            if not isinstance(pt, dict):
                continue
            new_pt = dict(pt)
            try:
                if 'x' in new_pt:
                    new_pt['x'] = round(float(new_pt['x']), precision)
                if 'y' in new_pt:
                    new_pt['y'] = round(float(new_pt['y']), precision)
            except (TypeError, ValueError):
                new_pt['x'] = float(new_pt.get('x', 0.0))
                new_pt['y'] = float(new_pt.get('y', 0.0))
            rounded.append(new_pt)
        return rounded

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

        Example with offset=5 on 10 points:
        - Removes LAST 5 points (keeps points 0-4)
        - Returns (points[:-5], 5, 0)
        - Caller adds 5 to start_pause metadata
        - Visual result: 5-frame pause holding position 0, then animates through 0-4
        """
        if offset == 0 or not points or len(points) == 0:
            return points, 0, 0

        offset_abs = abs(offset)
        # Clamp offset to prevent removing all points
        if offset_abs >= len(points):
            offset_abs = len(points) - 1

        if offset > 0:
            # Positive: remove LAST N frames, add N to start_pause
            # This waits at start position, then animates to N frames before end
            modified_points = points[:-offset_abs] if offset_abs > 0 else points
            return modified_points, offset_abs, 0
        else:
            # Negative: remove last N frames, add to end pause
            modified_points = points[:-offset_abs] if offset_abs > 0 else points
            return modified_points, 0, offset_abs

    def splinedata(self, mask_width, mask_height, coordinates, points_store, bg_img,
                   ref_image=None, coord_in=None, frames=None):

        # Use default frames value if not provided (from input)
        if frames is None:
            frames = 41  # Default value that was previously hardcoded


        # Parse coordinates which now contains array of spline widget data
        all_splines = []
        try:
            parsed_coords = json.loads(coordinates) if isinstance(coordinates, str) else coordinates
            if isinstance(parsed_coords, list):
                all_splines = parsed_coords

        except (json.JSONDecodeError, TypeError) as e:
            print(f"Warning: Could not parse coordinates: {e}")

        # Handle coordinate input - keep p_coordinates and coordinates separate
        incoming_p_paths = []  # Static points from p_coordinates
        incoming_coord_paths = []  # Animated paths from coordinates
        incoming_p_start_frames = []  # Pause frames for p_coordinates
        incoming_p_end_frames = []
        incoming_coord_start_frames = []  # Pause frames for coordinates
        incoming_coord_end_frames = []

        # Only process coord_in if it's actually provided and not None/empty
        if coord_in is not None and isinstance(coord_in, str) and len(coord_in.strip()) > 0 and coord_in.strip() != '[]':
            try:
                coord_in_data = json.loads(coord_in)
                # Check if it's the new metadata format (supports both "coordinates" and "p_coordinates")
                if isinstance(coord_in_data, dict) and ("coordinates" in coord_in_data or "p_coordinates" in coord_in_data):

                    # Process p_coordinates separately (static points)
                    if "p_coordinates" in coord_in_data:
                        incoming_p_coords = coord_in_data["p_coordinates"]
                        # Normalize to list of paths
                        if isinstance(incoming_p_coords, list) and len(incoming_p_coords) > 0:
                            if isinstance(incoming_p_coords[0], dict):
                                # Single path - wrap it in a list
                                incoming_p_paths = [incoming_p_coords]
                            elif isinstance(incoming_p_coords[0], list):
                                # Already multi-path
                                incoming_p_paths = incoming_p_coords

                    # Process coordinates separately (animated paths)
                    if "coordinates" in coord_in_data:
                        incoming_coords = coord_in_data["coordinates"]
                        # Normalize to list of paths
                        if isinstance(incoming_coords, list) and len(incoming_coords) > 0:
                            if isinstance(incoming_coords[0], dict):
                                # Single path - wrap it in a list
                                incoming_coord_paths = [incoming_coords]
                            elif isinstance(incoming_coords[0], list):
                                # Already multi-path
                                incoming_coord_paths = incoming_coords

                    # Extract metadata - could be single values or arrays or objects
                    incoming_start_p = coord_in_data.get("start_p_frames", 0)
                    incoming_end_p = coord_in_data.get("end_p_frames", 0)

                    # Handle different pause frame formats
                    # New format: {"p": [...], "c": [...]} or old format: single value/list
                    if isinstance(incoming_start_p, dict):
                        # New format with separate pause frames
                        p_start = incoming_start_p.get("p", [])
                        c_start = incoming_start_p.get("c", [])
                        p_end = incoming_end_p.get("p", [])
                        c_end = incoming_end_p.get("c", [])

                        # Normalize to lists
                        incoming_p_start_frames = p_start if isinstance(p_start, list) else [p_start] * len(incoming_p_paths)
                        incoming_coord_start_frames = c_start if isinstance(c_start, list) else [c_start] * len(incoming_coord_paths)
                        incoming_p_end_frames = p_end if isinstance(p_end, list) else [p_end] * len(incoming_p_paths)
                        incoming_coord_end_frames = c_end if isinstance(c_end, list) else [c_end] * len(incoming_coord_paths)
                    else:
                        # Old format - apply to whichever type exists
                        if incoming_p_paths and not incoming_coord_paths:
                            # Only p_coordinates
                            if isinstance(incoming_start_p, int):
                                incoming_p_start_frames = [incoming_start_p] * len(incoming_p_paths)
                                incoming_p_end_frames = [incoming_end_p] * len(incoming_p_paths)
                            elif isinstance(incoming_start_p, list):
                                incoming_p_start_frames = incoming_start_p + [0] * (len(incoming_p_paths) - len(incoming_start_p))
                                incoming_p_end_frames = incoming_end_p + [0] * (len(incoming_p_paths) - len(incoming_end_p))
                        elif incoming_coord_paths and not incoming_p_paths:
                            # Only coordinates
                            if isinstance(incoming_start_p, int):
                                incoming_coord_start_frames = [incoming_start_p] * len(incoming_coord_paths)
                                incoming_coord_end_frames = [incoming_end_p] * len(incoming_coord_paths)
                            elif isinstance(incoming_start_p, list):
                                incoming_coord_start_frames = incoming_start_p + [0] * (len(incoming_coord_paths) - len(incoming_start_p))
                                incoming_coord_end_frames = incoming_end_p + [0] * (len(incoming_coord_paths) - len(incoming_end_p))
                        else:
                            # Both exist - apply to both (backward compatibility)
                            if isinstance(incoming_start_p, int):
                                incoming_p_start_frames = [incoming_start_p] * len(incoming_p_paths)
                                incoming_p_end_frames = [incoming_end_p] * len(incoming_p_paths)
                                incoming_coord_start_frames = [incoming_start_p] * len(incoming_coord_paths)
                                incoming_coord_end_frames = [incoming_end_p] * len(incoming_coord_paths)
                            elif isinstance(incoming_start_p, list):
                                incoming_p_start_frames = incoming_start_p[:len(incoming_p_paths)] + [0] * max(0, len(incoming_p_paths) - len(incoming_start_p))
                                incoming_p_end_frames = incoming_end_p[:len(incoming_p_paths)] + [0] * max(0, len(incoming_p_paths) - len(incoming_end_p))
                                incoming_coord_start_frames = incoming_start_p[len(incoming_p_paths):] + [0] * max(0, len(incoming_coord_paths) - (len(incoming_start_p) - len(incoming_p_paths)))
                                incoming_coord_end_frames = incoming_end_p[len(incoming_p_paths):] + [0] * max(0, len(incoming_coord_paths) - (len(incoming_end_p) - len(incoming_p_paths)))
                else:
                    # Old format - just coordinates array (single path), no metadata - treat as animated
                    if isinstance(coord_in_data, list) and len(coord_in_data) > 0:
                        if isinstance(coord_in_data[0], dict):
                            incoming_coord_paths = [coord_in_data]
                            incoming_coord_start_frames = [0]
                            incoming_coord_end_frames = [0]
                        elif isinstance(coord_in_data[0], list):
                            incoming_coord_paths = coord_in_data
                            incoming_coord_start_frames = [0] * len(coord_in_data)
                            incoming_coord_end_frames = [0] * len(coord_in_data)
            except (json.JSONDecodeError, TypeError, AttributeError) as e:
                print(f"Warning: Could not parse coord_in: {e}. Will only use local coordinates.")

        # For PowerSplineEditor, process each spline widget's data
        # Each widget contains: {on, name, interpolation, repeat, points_store, coordinates}
        all_p_paths = list(incoming_p_paths)  # Copy incoming static paths
        all_p_names: list = []
        all_p_types: list = []
        all_p_start_frames = list(incoming_p_start_frames)
        all_p_end_frames = list(incoming_p_end_frames)
        all_p_visibility: list = [True] * len(all_p_paths)

        all_coord_paths = list(incoming_coord_paths)  # Copy incoming animated paths
        all_coord_names: list = []
        all_coord_types: list = []
        all_coord_start_frames = list(incoming_coord_start_frames)
        all_coord_end_frames = list(incoming_coord_end_frames)
        all_coord_visibility: list = [True] * len(all_coord_paths)

        all_box_paths = []
        all_box_names: list = []
        all_box_types: list = []
        all_box_start_frames = []
        all_box_end_frames = []
        all_box_visibility: list = []

        all_p_offsets = [] # Initialize list for p_coordinates offsets
        all_coord_offsets = [] # Initialize list for coordinates offsets
        all_box_offsets = [] # Initialize list for box offsets
        all_p_interpolations = [] # Initialize list for p_coordinates interpolations
        all_coord_interpolations = [] # Initialize list for coordinates interpolations
        all_box_interpolations = [] # Initialize list for box interpolations
        all_p_easing_functions = [] # Initialize list for p_coordinates easing functions
        all_coord_easing_functions = [] # Initialize list for coordinates easing functions
        all_box_easing_functions = [] # Initialize list for box easing functions
        all_p_easing_paths = [] # Initialize list for p_coordinates easing paths
        all_coord_easing_paths = [] # Initialize list for coordinates easing paths
        all_box_easing_paths = [] # Initialize list for box easing paths
        all_p_easing_strengths = [] # Initialize list for p_coordinates easing strengths
        all_coord_easing_strengths = [] # Initialize list for coordinates easing strengths
        all_box_easing_strengths = [] # Initialize list for box easing strengths
        all_p_accelerations = [] # Initialize list for p_coordinates accelerations
        all_coord_accelerations = [] # Initialize list for coordinates accelerations
        all_box_accelerations = [] # Initialize list for box accelerations
        all_p_scales = [] # Initialize list for p_coordinates scales
        all_coord_scales = [] # Initialize list for coordinates scales
        all_box_scales = [] # Initialize list for box scales
        all_p_drivers = []  # Driver info for p_coordinates
        all_coord_drivers = []  # Driver info for coordinates
        all_box_drivers = []  # Driver info for box coordinates

        # Build layer lookup map for driver processing
        # Map layer names to their processed coordinates for driving
        layer_map = {}
        for spline_data in all_splines:
            if not isinstance(spline_data, dict):
                continue

            layer_name = spline_data.get('name', '')
            control_points_str = spline_data.get('points_store', '[]')

            try:
                layer_coords = json.loads(control_points_str) if isinstance(control_points_str, str) else control_points_str
                if (not isinstance(layer_coords, list) or len(layer_coords) == 0):
                    alt_coords = spline_data.get('coordinates', [])
                    layer_coords = alt_coords if isinstance(alt_coords, list) else []
                if isinstance(layer_coords, list) and len(layer_coords) > 0:
                    # Apply repeat logic to driver coords too (same as driven)
                    repeat_count = int(spline_data.get('repeat', 1))
                    if repeat_count > 1 and len(layer_coords) > 1:
                        original_path = list(layer_coords)
                        is_closed = (original_path[0]['x'] == original_path[-1]['x'] and
                                     original_path[0]['y'] == original_path[-1]['y'])
                        loop_segment = list(original_path)
                        if not is_closed:
                            loop_segment.append(original_path[0])
                        repeated_path = list(loop_segment)
                        following_loop_segment = loop_segment[1:]
                        if following_loop_segment:
                            for i in range(repeat_count - 1):
                                repeated_path.extend(following_loop_segment)
                        layer_coords = repeated_path

                    layer_map[layer_name] = self._round_points(layer_coords)
            except (json.JSONDecodeError, TypeError) as e:
                print(f"Warning: Could not parse layer '{layer_name}' for driver map: {e}")

        for spline_data in all_splines:
            if not isinstance(spline_data, dict):
                continue

            is_on = bool(spline_data.get('on', True))

            # Get spline parameters
            control_points_str = spline_data.get('points_store', '[]') # Use 'points_store' for raw control points
            # Get interpolation type; handdraw is always treated as linear coordinates
            spline_type = spline_data.get('type', 'spline')
            spline_interpolation = spline_data.get('interpolation', 'linear')
            if spline_type == 'handdraw':
                spline_interpolation = 'linear'
            start_frames = spline_data.get('a_pause', 0)
            end_frames = spline_data.get('z_pause', 0)
            repeat_count = int(spline_data.get('repeat', 1))
            
            # Get easing parameters
            easing_function = spline_data.get('easing', 'in_out') # Get easing function using simple name
            easing_config = spline_data.get('easingConfig', {'path': 'full', 'strength': 1.0, 'acceleration': 0.00}) # Get easing config
            easing_path = easing_config.get('path', 'full') # Get easing path ('each' or 'full')
            easing_strength = easing_config.get('strength', 1.0) # Get easing strength
            acceleration = easing_config.get('acceleration', 0.00) # Get acceleration value
            
            # Get scale parameter
            scale = spline_data.get('scale', 1.00) # Get scale value
            offset = int(spline_data.get('offset', 0)) # Get offset value

            # Parse control points
            try:
                # control_points_str contains the raw control points (normalized) from the UI
                # If it's already a list, use as-is; otherwise parse JSON string
                spline_coords = json.loads(control_points_str) if isinstance(control_points_str, str) else control_points_str
                if (not isinstance(spline_coords, list) or len(spline_coords) == 0):
                    # Fallback: use coordinates field if present in the incoming object
                    alt_coords = spline_data.get('coordinates', [])
                    spline_coords = alt_coords if isinstance(alt_coords, list) else []
                
                if not isinstance(spline_coords, list) or len(spline_coords) == 0:
                    print(f"[PowerSplineEditor] Skipping layer '{spline_data.get('name','')}' — no control points parsed")
                    continue

                # --- REPEAT LOGIC (Looping Effect) ---
                # This logic now applies to the raw control points.
                if repeat_count > 1 and len(spline_coords) > 1:
                    original_path = list(spline_coords)
                    
                    # Create a single closed loop segment by appending the start point to the end if it's not already closed.
                    is_closed = (original_path[0]['x'] == original_path[-1]['x'] and 
                                 original_path[0]['y'] == original_path[-1]['y'])
                    
                    loop_segment = list(original_path)
                    if not is_closed:
                        loop_segment.append(original_path[0])

                    # Start the final path with one full loop.
                    repeated_path = list(loop_segment)
                    
                    # Define the segment for subsequent loops (all points except the first).
                    following_loop_segment = loop_segment[1:]

                    # Add the subsequent loop segments for each additional repeat.
                    if following_loop_segment:
                        for i in range(repeat_count - 1):
                            repeated_path.extend(following_loop_segment)
                    
                    spline_coords = repeated_path
                # --- END REPEAT LOGIC ---

                spline_coords = self._round_points(spline_coords)

                # --- DRIVER LOGIC (Coordinate Driving) ---
                # Check if this spline is driven by another layer
                driver_info_for_layer = None
                driven_config = spline_data.get('driven', False)
                if driven_config and isinstance(driven_config, dict):
                    driver_name = driven_config.get('driver', '').strip()
                    driver_rotate = driven_config.get('rotate', 0)
                    driver_d_scale = driven_config.get('d_scale', 1.0)

                    # Get current spline name for self-driving prevention
                    current_spline_name = spline_data.get('name', '')

                    if driver_name:
                        # Prevent self-driving
                        if driver_name == current_spline_name:
                            print(f"Warning: Layer '{current_spline_name}' is trying to drive itself. Skipping driver logic.")
                        elif driver_name in layer_map:
                            # Driver layer found
                            driver_coords = layer_map[driver_name]
                            
                            # Find the driver layer's interpolation parameters
                            driver_easing_function = 'linear'  # Default
                            driver_easing_path = 'full'  # Default
                            driver_easing_strength = 1.0  # Default
                            driver_acceleration = 0.00  # Default
                            
                            # Search for the driver layer in all_splines to get its interpolation parameters
                            driver_type = 'linear'
                            for driver_spline_data in all_splines:
                                if isinstance(driver_spline_data, dict) and driver_spline_data.get('name', '') == driver_name:
                                    driver_easing_function = driver_spline_data.get('easing', 'linear')
                                    driver_easing_config = driver_spline_data.get('easingConfig', {'path': 'full', 'strength': 1.0, 'acceleration': 0.00})
                                    driver_easing_path = driver_easing_config.get('path', 'full')
                                    driver_easing_strength = driver_easing_config.get('strength', 1.0)
                                    driver_acceleration = driver_easing_config.get('acceleration', 0.00)
                                    driver_type = driver_spline_data.get('interpolation', 'linear')
                                    break

                            # Gather driver's own timing so consumers can respect it
                            driver_start_pause = int(driver_spline_data.get('a_pause', 0))
                            driver_end_pause = int(driver_spline_data.get('z_pause', 0))
                            driver_offset_val = int(driver_spline_data.get('offset', 0))

                            def extract_point_scale(point):
                                if not isinstance(point, dict):
                                    return 1.0
                                for key in ('boxScale', 'scale'):
                                    value = point.get(key)
                                    if isinstance(value, (int, float)):
                                        return float(value)
                                return 1.0

                            driver_scale_profile = []
                            driver_scale_factor = 1.0
                            if driver_coords and isinstance(driver_coords, list) and len(driver_coords) > 0:
                                base_scale = extract_point_scale(driver_coords[0]) or 1.0
                                if abs(base_scale) < 1e-6:
                                    base_scale = 1.0
                                for pt in driver_coords:
                                    scale_val = extract_point_scale(pt)
                                    ratio = scale_val / base_scale if base_scale else 1.0
                                    driver_scale_profile.append(ratio)
                                driver_scale_factor = max(driver_scale_profile) if driver_scale_profile else 1.0
                            driver_radius_delta = BOX_BASE_RADIUS * (driver_scale_factor - 1.0)
                            driver_pivot = None
                            if driver_coords and isinstance(driver_coords[0], dict):
                                try:
                                    driver_pivot = (
                                        float(driver_coords[0].get('x', 0.0)),
                                        float(driver_coords[0].get('y', 0.0))
                                    )
                                except (TypeError, ValueError):
                                    driver_pivot = None

                            driver_info_for_layer = {
                                "path": driver_coords,
                                "rotate": driver_rotate,
                                "d_scale": driver_d_scale,
                                "easing_function": driver_easing_function,
                                "easing_path": driver_easing_path,
                                "easing_strength": driver_easing_strength,
                                "acceleration": driver_acceleration,
                                # Driver timing (used by DrawShapeOnPath to delay/advance driver motion)
                                "start_pause": driver_start_pause,
                                "end_pause": driver_end_pause,
                                "offset": driver_offset_val,
                                "driver_type": driver_type,
                                "driver_scale_profile": driver_scale_profile,
                                "driver_scale_factor": driver_scale_factor,
                                "driver_radius_delta": driver_radius_delta,
                                "driver_pivot": driver_pivot,
                                "driver_layer_name": driver_name
                            }
                            print(f"Stored driver '{driver_name}' for layer '{current_spline_name}' (mode={spline_interpolation}, rotate={driver_rotate}°, d_scale={driver_d_scale}, easing={driver_easing_function})")
                        else:
                            print(f"Warning: Driver layer '{driver_name}' not found for layer '{current_spline_name}'. Available layers: {list(layer_map.keys())}")
                # --- END DRIVER LOGIC ---

                # NO OFFSET LOGIC HERE - it's moved to DrawShapeOnPath

                # Add to appropriate output; force handdraw into coordinates bucket like normal layers
                if spline_type == 'handdraw':
                    all_coord_paths.append(spline_coords)
                    all_coord_names.append(spline_data.get('name', ''))
                    all_coord_types.append(spline_type)
                    all_coord_start_frames.append(start_frames)
                    all_coord_end_frames.append(end_frames)
                    all_coord_offsets.append(offset)
                    all_coord_interpolations.append('linear')
                    all_coord_easing_functions.append(easing_function)
                    all_coord_easing_paths.append(easing_path)
                    all_coord_easing_strengths.append(easing_strength)
                    all_coord_accelerations.append(acceleration)
                    all_coord_scales.append(scale)
                    all_coord_drivers.append(driver_info_for_layer)
                    all_coord_visibility.append(is_on)
                elif spline_interpolation == 'points':
                    all_p_paths.append(spline_coords)
                    all_p_names.append(spline_data.get('name', ''))
                    all_p_types.append(spline_type)
                    all_p_start_frames.append(start_frames)
                    all_p_end_frames.append(end_frames)
                    all_p_offsets.append(offset) # Collect offset for p_coordinates
                    all_p_interpolations.append(spline_interpolation) # Collect interpolation type
                    all_p_easing_functions.append(easing_function) # Collect easing function
                    all_p_easing_paths.append(easing_path) # Collect easing path
                    all_p_easing_strengths.append(easing_strength) # Collect easing strength
                    all_p_accelerations.append(acceleration) # Collect acceleration value
                    all_p_scales.append(scale) # Collect scale value
                    all_p_drivers.append(driver_info_for_layer)  # Collect driver info (None if no driver)
                    all_p_visibility.append(is_on)
                elif spline_interpolation == 'box':
                    all_box_paths.append(spline_coords)
                    all_box_names.append(spline_data.get('name', ''))
                    all_box_types.append('box')
                    all_box_start_frames.append(start_frames)
                    all_box_end_frames.append(end_frames)
                    all_box_offsets.append(offset)
                    all_box_interpolations.append(spline_interpolation)
                    all_box_easing_functions.append(easing_function)
                    all_box_easing_paths.append(easing_path)
                    all_box_easing_strengths.append(easing_strength)
                    all_box_accelerations.append(acceleration)
                    all_box_scales.append(scale)
                    all_box_drivers.append(driver_info_for_layer)
                    all_box_visibility.append(is_on)
                else:
                    all_coord_paths.append(spline_coords)
                    all_coord_names.append(spline_data.get('name', ''))
                    all_coord_types.append(spline_type)
                    all_coord_start_frames.append(start_frames)
                    all_coord_end_frames.append(end_frames)
                    all_coord_offsets.append(offset) # Collect offset for coordinates
                    all_coord_interpolations.append(spline_interpolation) # Collect interpolation type
                    all_coord_easing_functions.append(easing_function) # Collect easing function
                    all_coord_easing_paths.append(easing_path) # Collect easing path
                    all_coord_easing_strengths.append(easing_strength) # Collect easing strength
                    all_coord_accelerations.append(acceleration) # Collect acceleration value
                    all_coord_scales.append(scale) # Collect scale value
                    all_coord_drivers.append(driver_info_for_layer)  # Collect driver info (None if no driver)
                    all_coord_visibility.append(is_on)

            except (json.JSONDecodeError, TypeError) as e:
                print(f"Warning: Could not parse spline coordinates: {e}")

        # Determine background image dimensions first (needed for coord_width/coord_height)
        bg_h = float(mask_height)
        bg_w = float(mask_width)
        if ref_image is not None and ref_image.dim() == 4 and ref_image.shape[0] > 0:
             bg_h = float(ref_image.shape[1])
             bg_w = float(ref_image.shape[2])

        # Build output data structure
        coord_out_data = {}

        # Add p_coordinates if present
        p_start_out = []
        p_end_out = []
        if all_p_paths:
            if len(all_p_paths) > 1:
                coord_out_data["p_coordinates"] = all_p_paths
                p_start_out = all_p_start_frames
                p_end_out = all_p_end_frames
            else:
                coord_out_data["p_coordinates"] = all_p_paths[0]
                p_start_out = all_p_start_frames[0] if all_p_start_frames else 0
                p_end_out = all_p_end_frames[0] if all_p_end_frames else 0

        # Add coordinates if present
        c_start_out = []
        c_end_out = []
        if all_coord_paths:
            if len(all_coord_paths) > 1:
                coord_out_data["coordinates"] = all_coord_paths
                c_start_out = all_coord_start_frames
                c_end_out = all_coord_end_frames
            else:
                coord_out_data["coordinates"] = all_coord_paths[0]
                c_start_out = all_coord_start_frames[0] if all_coord_start_frames else 0
                c_end_out = all_coord_end_frames[0] if all_coord_end_frames else 0

        # Add box coordinates if present
        b_start_out = []
        b_end_out = []
        if all_box_paths:
            if len(all_box_paths) > 1:
                coord_out_data["box_coordinates"] = all_box_paths
                b_start_out = all_box_start_frames
                b_end_out = all_box_end_frames
            else:
                coord_out_data["box_coordinates"] = all_box_paths[0]
                b_start_out = all_box_start_frames[0] if all_box_start_frames else 0
                b_end_out = all_box_end_frames[0] if all_box_end_frames else 0

        def assemble_meta(p_has, p_val, c_has, c_val, b_has, b_val):
            if not (p_has or c_has or b_has):
                return []
            return {
                "p": p_val if p_has else [],
                "c": c_val if c_has else [],
                "b": b_val if b_has else []
            }

        has_p = bool(all_p_paths)
        has_c = bool(all_coord_paths)
        has_b = bool(all_box_paths)
        if not (has_p or has_c or has_b):
            # No paths at all
            coord_out_data["start_p_frames"] = 0
            coord_out_data["end_p_frames"] = 0
            coord_out_data["offsets"] = []  # Default empty list
            coord_out_data["interpolations"] = []  # Default empty list
            coord_out_data["easing_functions"] = []  # Default empty list for easing functions
            coord_out_data["easing_paths"] = []  # Default empty list for easing paths
            coord_out_data["easing_strengths"] = []  # Default empty list for easing strengths
            coord_out_data["accelerations"] = []  # Default empty list for accelerations
            coord_out_data["scales"] = []  # Default empty list for scales
            coord_out_data["drivers"] = []  # Default empty list
            coord_out_data["names"] = {"p": [], "c": [], "b": []}
            coord_out_data["types"] = {"p": [], "c": [], "b": []}
            coord_out_data["visibility"] = {"p": [], "c": [], "b": []}
            print("Warning: No paths to output")
        else:
            coord_out_data["start_p_frames"] = assemble_meta(has_p, p_start_out, has_c, c_start_out, has_b, b_start_out)
            coord_out_data["end_p_frames"] = assemble_meta(has_p, p_end_out, has_c, c_end_out, has_b, b_end_out)
            coord_out_data["offsets"] = assemble_meta(has_p, all_p_offsets, has_c, all_coord_offsets, has_b, all_box_offsets)
            coord_out_data["interpolations"] = assemble_meta(has_p, all_p_interpolations, has_c, all_coord_interpolations, has_b, all_box_interpolations)
            coord_out_data["easing_functions"] = assemble_meta(has_p, all_p_easing_functions, has_c, all_coord_easing_functions, has_b, all_box_easing_functions)
            coord_out_data["easing_paths"] = assemble_meta(has_p, all_p_easing_paths, has_c, all_coord_easing_paths, has_b, all_box_easing_paths)
            coord_out_data["easing_strengths"] = assemble_meta(has_p, all_p_easing_strengths, has_c, all_coord_easing_strengths, has_b, all_box_easing_strengths)
            coord_out_data["accelerations"] = assemble_meta(has_p, all_p_accelerations, has_c, all_coord_accelerations, has_b, all_box_accelerations)
            coord_out_data["scales"] = assemble_meta(has_p, all_p_scales, has_c, all_coord_scales, has_b, all_box_scales)
            coord_out_data["drivers"] = assemble_meta(has_p, all_p_drivers, has_c, all_coord_drivers, has_b, all_box_drivers)
            coord_out_data["names"] = assemble_meta(has_p, all_p_names, has_c, all_coord_names, has_b, all_box_names)
            coord_out_data["types"] = assemble_meta(has_p, all_p_types, has_c, all_coord_types, has_b, all_box_types)
            coord_out_data["visibility"] = assemble_meta(has_p, all_p_visibility, has_c, all_coord_visibility, has_b, all_box_visibility)

        # Include coordinate space dimensions so DrawShapeOnPath can scale if needed
        # Coordinates from the frontend are in normalized 0-1 range
        # Set coord_width/coord_height to 1 so draw_shapes knows to scale them to frame dimensions
        coord_out_data["coord_width"] = 1.0
        coord_out_data["coord_height"] = 1.0

        coord_out = json.dumps(coord_out_data)


        # Determine background image dimensions if present
        bg_h = float(mask_height)
        bg_w = float(mask_width)
        if ref_image is not None and ref_image.dim() == 4 and ref_image.shape[0] > 0:
             bg_h = float(ref_image.shape[1])
             bg_w = float(ref_image.shape[2])


        # Prepare the UI output dictionary for background image preview
        ui_out = {}

        if coord_in is not None:
            ui_out["coord_in"] = coord_in

        # Always send dimensions to UI so canvas can initialize properly
        ui_out["ref_image_dims"] = [{"width": bg_w, "height": bg_h}]

        if ref_image is not None:
            # Ensure ref_image is on CPU before converting
            if ref_image.device != torch.device('cpu'):
                ref_image = ref_image.cpu()

            transform = transforms.ToPILImage()
            # Use the first image in the batch for the preview
            # Ensure tensor is in CHW format (channels, height, width)
            img_tensor = ref_image[0]
            if img_tensor.dim() == 3 and img_tensor.shape[0] != 3 and img_tensor.shape[2] == 3:
                 img_tensor = img_tensor.permute(2, 0, 1) # HWC to CHW if needed
            elif img_tensor.dim() == 2: # Grayscale HW -> 1HW -> CHW (repeat channel)
                 img_tensor = img_tensor.unsqueeze(0).repeat(3, 1, 1)

            # Clamp tensor values to [0, 1] if they are floats
            if torch.is_floating_point(img_tensor):
                img_tensor = torch.clamp(img_tensor, 0, 1)

            try:
                image = transform(img_tensor)
                
                # Save the image directly to the bg folder as ref_image.jpg
                self._save_ref_image_to_bg_folder(image)
                
                # Also provide the base64 version for the UI (as before)
                buffered = io.BytesIO()
                image.save(buffered, format="PNG") # Use PNG to preserve quality for display
                img_bytes = buffered.getvalue()
                img_base64 = base64.b64encode(img_bytes).decode('utf-8')
                ui_out["ref_image"] = [img_base64]
            except Exception as e:
                print(f"Error processing background image for UI preview: {e}")

        # Return results
        # Create proper blank tensor if no ref_image provided (ComfyUI expects BHWC format)
        if ref_image is not None:
            result_image = ref_image
        else:
            # Create blank image tensor in BHWC format (Batch, Height, Width, Channels)
            result_image = torch.zeros((1, int(bg_h), int(bg_w), 3), dtype=torch.float32)

        result = (result_image, coord_out, frames)

        # Include bg_img selection in UI output so frontend can use it
        ui_out["bg_img"] = [bg_img]
        
        # Always return UI data with at least dimensions for proper canvas initialization
        return {"ui": ui_out, "result": result}

    def _save_ref_image_to_bg_folder(self, image):
        """Save the reference image directly to the bg folder"""
        import os
        from pathlib import Path
        
        # Get the bg folder path (relative to this file)
        bg_folder = Path(__file__).parent.parent / "web" / "power_spline_editor" / "bg"
        bg_folder.mkdir(parents=True, exist_ok=True)
        ref_image_path = bg_folder / "ref_image.jpg"
        
        # Convert image to RGB if it's not already
        if image.mode != 'RGB':
            image = image.convert('RGB')
        
        # Save as JPEG with good quality
        image.save(str(ref_image_path), format="JPEG", quality=95)
        
        print(f"Reference image saved to: {ref_image_path}")
