"""
Driver utilities for spline coordinate transformation.
Used by PowerSplineEditor to apply coordinate driving between layers.
"""

import math


def rotate_path(path, angle_degrees, pivot=None):
    """
    Rotate a path of coordinates around a pivot point.

    Args:
        path: List of coordinate dicts with 'x' and 'y' keys
        angle_degrees: Rotation angle in degrees (positive = counterclockwise)
        pivot: Pivot point dict with 'x' and 'y' keys. If None, uses first point of path.

    Returns:
        Rotated path (new list of dicts)
    """
    if not path or len(path) == 0:
        return []

    if angle_degrees == 0:
        return [p.copy() for p in path]

    # Use first point as pivot if not specified
    if pivot is None:
        pivot = path[0]

    pivot_x = float(pivot['x'])
    pivot_y = float(pivot['y'])

    angle_rad = math.radians(angle_degrees)
    cos_a = math.cos(angle_rad)
    sin_a = math.sin(angle_rad)

    rotated = []
    for point in path:
        px = float(point['x'])
        py = float(point['y'])

        # Translate to origin
        rel_x = px - pivot_x
        rel_y = py - pivot_y

        # Rotate
        new_rel_x = rel_x * cos_a - rel_y * sin_a
        new_rel_y = rel_x * sin_a + rel_y * cos_a

        # Translate back
        rotated_point = {
            'x': new_rel_x + pivot_x,
            'y': new_rel_y + pivot_y
        }

        # Preserve other properties
        for key in point:
            if key not in ('x', 'y'):
                rotated_point[key] = point[key]

        rotated.append(rotated_point)

    return rotated


def smooth_path(path, smooth_factor):
    """
    Apply smoothing by scaling the path relative to its first point.

    Args:
        path: List of coordinate dicts with 'x' and 'y' keys
        smooth_factor: Smoothing factor from 0.0 (no effect) to 1.0 (path collapsed to first point)

    Returns:
        Smoothed path (new list of dicts)
    """
    if not path or len(path) == 0 or smooth_factor is None:
        return [p.copy() for p in path]

    # Clamp smooth factor
    smooth_factor = max(0.0, min(1.0, smooth_factor))
    
    if smooth_factor == 0.0:
        return [p.copy() for p in path]

    scale_factor = 1.0 - smooth_factor

    pivot_point = path[0]
    pivot_x = float(pivot_point['x'])
    pivot_y = float(pivot_point['y'])

    smoothed = []
    for point in path:
        px = float(point['x'])
        py = float(point['y'])

        # Vector from pivot to point
        vec_x = px - pivot_x
        vec_y = py - pivot_y

        # Scale the vector
        scaled_vec_x = vec_x * scale_factor
        scaled_vec_y = vec_y * scale_factor

        # New point position
        new_x = pivot_x + scaled_vec_x
        new_y = pivot_y + scaled_vec_y
        
        new_point = {
            'x': new_x,
            'y': new_y
        }
        
        # Preserve other properties
        for key in point:
            if key not in ('x', 'y'):
                new_point[key] = point[key]
        
        smoothed.append(new_point)

    return smoothed


def interpolate_path(path, target_frames):
    """
    Linearly interpolate a path to a target number of frames.

    Args:
        path: List of coordinate dicts with 'x' and 'y' keys
        target_frames: Desired number of frames

    Returns:
        Interpolated path with target_frames points
    """
    n_coords = len(path)

    if target_frames <= 0:
        print("driver_utils Warning: target_frames is 0 or negative. Returning original path.")
        return [p.copy() for p in path]

    if n_coords == target_frames:
        return [p.copy() for p in path]

    if n_coords == 0:
        print("driver_utils Warning: Cannot interpolate empty path.")
        return []

    if n_coords == 1:
        # Single point - duplicate it
        return [path[0].copy() for _ in range(target_frames)]

    if target_frames == 1:
        # Return first point only
        return [path[0].copy()]

    interpolated = []

    # Ensure coordinates are floats
    float_coords = []
    try:
        for p in path:
            float_coords.append({'x': float(p['x']), 'y': float(p['y'])})
    except (KeyError, ValueError) as e:
        print(f"driver_utils Error: Invalid coordinate format - {e}")
        return [p.copy() for p in path]

    for i in range(target_frames):
        # Calculate position in original path
        pos = i * (n_coords - 1) / (target_frames - 1)
        idx1 = math.floor(pos)
        idx2 = math.ceil(pos)

        if idx1 == idx2:
            interpolated.append(float_coords[idx1].copy())
        else:
            # Linear interpolation
            t = pos - idx1
            p1 = float_coords[idx1]
            p2 = float_coords[idx2]

            new_x = p1['x'] * (1.0 - t) + p2['x'] * t
            new_y = p1['y'] * (1.0 - t) + p2['y'] * t
            interpolated.append({'x': new_x, 'y': new_y})

    return interpolated


def apply_driver_offset(driven_coords, driver_coords, rotate=0, smooth=0.0):
    """
    Apply driver coordinate transformation to driven coordinates.

    This is the main function that orchestrates the driver logic:
    1. Rotate driver path if rotate != 0
    2. Smooth driver path if smooth > 0.0
    3. Interpolate driver path to match driven length
    4. Calculate offset from driver's first point
    5. Apply offset to each driven coordinate

    Args:
        driven_coords: List of coordinate dicts to be driven
        driver_coords: List of coordinate dicts from the driver layer
        rotate: Rotation angle in degrees
        smooth: Smoothing factor (0.0 to 1.0)

    Returns:
        New list of driven coordinates with driver offset applied
    """
    if not driven_coords or len(driven_coords) == 0:
        return []

    if not driver_coords or len(driver_coords) == 0:
        print("driver_utils Warning: No driver coordinates provided. Returning original driven coords.")
        return [c.copy() for c in driven_coords]

    # Step 1: Apply rotation to driver path
    transformed_driver = driver_coords
    if rotate != 0:
        transformed_driver = rotate_path(transformed_driver, rotate)

    # Step 2: Apply smoothing to driver path
    if smooth > 0.0:
        transformed_driver = smooth_path(transformed_driver, smooth)

    # Step 3: Interpolate driver to match driven length
    driven_length = len(driven_coords)
    interpolated_driver = interpolate_path(transformed_driver, driven_length)

    if not interpolated_driver or len(interpolated_driver) == 0:
        print("driver_utils Warning: Driver interpolation failed. Returning original driven coords.")
        return [c.copy() for c in driven_coords]

    # Step 4: Calculate reference offset from driver's first point
    ref_offset_x = float(interpolated_driver[0]['x'])
    ref_offset_y = float(interpolated_driver[0]['y'])

    # Step 5: Apply offset to each driven coordinate
    result = []
    for i in range(driven_length):
        driven_point = driven_coords[i]
        driver_point = interpolated_driver[i]

        # Calculate offset
        offset_x = float(driver_point['x']) - ref_offset_x
        offset_y = float(driver_point['y']) - ref_offset_y

        # Apply offset to driven
        new_point = {
            'x': float(driven_point['x']) + offset_x,
            'y': float(driven_point['y']) + offset_y
        }

        # Preserve other properties from driven point
        for key in driven_point:
            if key not in ('x', 'y'):
                new_point[key] = driven_point[key]

        result.append(new_point)

    return result
