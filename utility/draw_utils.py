import math

class InterpMath:
    @staticmethod
    def _linear_interp(p0, p1, t):
        result = {
            'x': p0['x'] + (p1['x'] - p0['x']) * t,
            'y': p0['y'] + (p1['y'] - p0['y']) * t
        }
        # Interpolate box rotation field if present
        if 'boxR' in p0 or 'boxR' in p1:
            br0 = p0.get('boxR', 0.0)
            br1 = p1.get('boxR', 0.0)
            result['boxR'] = br0 + (br1 - br0) * t
        # Preserve other fields from p0
        for key in p0:
            if key not in result:
                result[key] = p0[key]
        return result

    @staticmethod
    def _ease_in(t, strength=1.0):
        return t ** (2.0 * strength)

    @staticmethod
    def _ease_out(t, strength=1.0):
        return 1 - (1 - t) ** (2.0 * strength)

    @staticmethod
    def _ease_in_out(t, strength=1.0):
        if t < 0.5:
            return (2 ** (2.0 * strength - 1)) * (t ** (2.0 * strength))
        else:
            return 1 - (2 ** (2.0 * strength - 1)) * ((1 - t) ** (2.0 * strength))

    @staticmethod
    def _ease_out_in(t, strength=1.0):
        if t < 0.5:
            return 0.5 * (1 - (1 - 2*t) ** (2.0 * strength))
        else:
            return 0.5 + 0.5 * ((2*t - 1) ** (2.0 * strength))

    @staticmethod
    def interpolate_or_downsample_path(points, target_frames, method='linear', easing_path='full', bounce_between=0.0, easing_strength=1.0, interpolation='linear'):
        n_points = len(points)
        if n_points == target_frames:
            return points
        if n_points < 2:
            return [points[0]] * target_frames if n_points == 1 else []

        output_points = []
        easing_map = {
            "linear": lambda t, s=1.0: t,
            "in": lambda t, s=easing_strength: InterpMath._ease_in(t, s),
            "out": lambda t, s=easing_strength: InterpMath._ease_out(t, s),
            "in_out": lambda t, s=easing_strength: InterpMath._ease_in_out(t, s),
            "out_in": lambda t, s=easing_strength: InterpMath._ease_out_in(t, s)
        }
        apply_easing = easing_map.get(method, lambda t, s=1.0: t)

        # Create inverted easing functions for "alternate" mode
        inverted_easing_map = {
            "linear": lambda t, s=1.0: t,
            "in": lambda t, s=easing_strength: InterpMath._ease_out(t, s),
            "out": lambda t, s=easing_strength: InterpMath._ease_in(t, s),
            "in_out": lambda t, s=easing_strength: InterpMath._ease_out_in(t, s),
            "out_in": lambda t, s=easing_strength: InterpMath._ease_in_out(t, s)
        }
        apply_inverted_easing = inverted_easing_map.get(method, lambda t, s=1.0: t)

        total_path_length = 0
        segment_lengths = []
        for i in range(n_points - 1):
            dx = points[i+1]['x'] - points[i]['x']
            dy = points[i+1]['y'] - points[i]['y']
            length = (dx**2 + dy**2)**0.5
            segment_lengths.append(length)

        for i in range(len(segment_lengths)):
            if segment_lengths[i] == 0:
                segment_lengths[i] = 1e-9
        
        total_path_length = sum(segment_lengths)

        if total_path_length == 0:
            return [points[0]] * target_frames

        major_segments = []
        control_point_indices = []

        if easing_path == 'each':
            if interpolation == 'basis':
                control_point_indices = [i for i, p in enumerate(points) if p.get('highlighted')]
                # If no highlighted points for basis+each, we let control_point_indices be empty, 
                # which causes a fallback to 'full' path easing later.
            else:
                control_point_indices = [i for i, p in enumerate(points) if p.get('is_control')]
                if not control_point_indices:
                    # Fallback for non-basis interpolations
                    control_point_indices = list(range(n_points))
        elif easing_path == 'full':
            if interpolation != 'linear':
                control_point_indices = [i for i, p in enumerate(points) if p.get('highlighted')]
        elif easing_path == 'alternate':
            # For alternate mode, use the same segment boundaries as 'each' mode
            if interpolation == 'basis':
                control_point_indices = [i for i, p in enumerate(points) if p.get('highlighted')]
                # If no highlighted points for basis+each, we let control_point_indices be empty, 
                # which causes a fallback to 'full' path easing later.
            else:
                control_point_indices = [i for i, p in enumerate(points) if p.get('is_control')]
                if not control_point_indices:
                    # Fallback for non-basis interpolations
                    control_point_indices = list(range(n_points))

        if len(control_point_indices) > 1:
            if control_point_indices[0] != 0:
                control_point_indices.insert(0, 0)
            if control_point_indices[-1] != n_points - 1:
                control_point_indices.append(n_points - 1)
            control_point_indices = sorted(list(set(control_point_indices)))

            for i in range(len(control_point_indices) - 1):
                start_idx = control_point_indices[i]
                end_idx = control_point_indices[i+1]
                length = sum(segment_lengths[start_idx:end_idx])
                major_segments.append({'start_idx': start_idx, 'end_idx': end_idx, 'length': length})

        segment_frame_ranges = []
        if major_segments:
            frames_allocated = 0
            segment_lengths_sum = sum(seg['length'] for seg in major_segments)
            if segment_lengths_sum > 0:
                frames_per_segment_float = [(seg['length'] / segment_lengths_sum) * target_frames for seg in major_segments]
            else:
                frames_per_segment_float = [target_frames / len(major_segments)] * len(major_segments) if len(major_segments) > 0 else []

            frames_per_segment_int = [int(f) for f in frames_per_segment_float]
            remainders = [(f - i, idx) for idx, (f, i) in enumerate(zip(frames_per_segment_float, frames_per_segment_int))]
            remainders.sort(key=lambda x: x[0], reverse=True)
            
            missing_frames = target_frames - sum(frames_per_segment_int)
            if missing_frames > 0:
                for i in range(missing_frames):
                    if not remainders: break
                    frames_per_segment_int[remainders[i % len(remainders)][1]] += 1

            for idx, seg in enumerate(major_segments):
                num_frames = frames_per_segment_int[idx]
                segment_frame_ranges.append({
                    'segment': seg,
                    'start_frame': frames_allocated,
                    'frame_count': num_frames,
                    'segment_idx': idx  # Track the segment index for alternating easing
                })
                frames_allocated += num_frames

        for i in range(target_frames):
            t_linear = i / (target_frames - 1) if target_frames > 1 else 0
            eased_target_dist = 0

            if segment_frame_ranges:
                target_segment_info = None
                for seg_info in segment_frame_ranges:
                    if i >= seg_info['start_frame'] and i < seg_info['start_frame'] + seg_info['frame_count']:
                        target_segment_info = seg_info
                        break

                if target_segment_info is None:
                    target_segment_info = segment_frame_ranges[-1]

                frame_index_in_segment = i - target_segment_info['start_frame']
                if target_segment_info['frame_count'] > 1:
                    t_segment_local = frame_index_in_segment / (target_segment_info['frame_count'] - 1)
                elif target_segment_info['frame_count'] == 1:
                    t_segment_local = 1.0
                else:
                    t_segment_local = 0.0

                # Apply normal easing or inverted easing based on the segment index for 'alternate' mode
                if easing_path == 'alternate':
                    # Alternate between normal and inverted easing based on segment index
                    if target_segment_info['segment_idx'] % 2 == 0:  # Even index (0, 2, 4, ...)
                        t_segment_eased = apply_easing(t_segment_local, easing_strength)
                    else:  # Odd index (1, 3, 5, ...)
                        t_segment_eased = apply_inverted_easing(t_segment_local, easing_strength)
                else:
                    # For 'each' and 'full' modes, use the normal easing
                    t_segment_eased = apply_easing(t_segment_local, easing_strength)

                dist_before_segment = 0
                for seg in major_segments:
                    if seg == target_segment_info['segment']:
                        break
                    dist_before_segment += seg['length']

                eased_target_dist = dist_before_segment + t_segment_eased * target_segment_info['segment']['length']
            
            else:
                t_eased = apply_easing(t_linear, easing_strength)
                eased_target_dist = t_eased * total_path_length

            current_dist = 0.0
            segment_index = 0
            while segment_index < len(segment_lengths) and current_dist + segment_lengths[segment_index] < eased_target_dist:
                current_dist += segment_lengths[segment_index]
                segment_index += 1
            
            segment_index = min(segment_index, n_points - 2)

            dist_into_segment = eased_target_dist - current_dist
            micro_segment_len = segment_lengths[segment_index]
            
            t_micro_segment = dist_into_segment / micro_segment_len if micro_segment_len > 0 else 0

            p0 = points[segment_index]
            p1 = points[segment_index + 1]
            
            interpolated_point = InterpMath._linear_interp(p0, p1, t_micro_segment)
            output_points.append(interpolated_point)

        if target_frames > 0 and output_points:
            output_points[0] = points[0].copy()
            if target_frames > 1:
                output_points[-1] = points[-1].copy()

        return output_points

    @staticmethod
    def apply_acceleration_remapping(points, acceleration):
        """
        Apply acceleration-based timing remapping to a sequence of points.
        
        For positive acceleration (> 0.00):
        - Movement is faster at the end by squishing end coordinates and stretching starting ones
        
        For negative acceleration (< 0.00):
        - Movement is slower at the end by stretching end coordinates (and compressing starting ones)
        
        For zero acceleration (0.00):
        - Skip the function (return original points)
        
        Args:
            points: List of points with x, y coordinates
            acceleration: Acceleration value from -1.0 to 1.0
        
        Returns:
            List of remapped points
        """
        if abs(acceleration) < 0.001:  # Close to zero, skip remapping
            return points
        
        if len(points) <= 2:
            return points
        
        n_points = len(points)
        output_points = []
        
        for i in range(n_points):
            # Calculate normalized position along the path (0 to 1)
            t = i / (n_points - 1) if n_points > 1 else 0
            
            # Apply acceleration remapping with clamped values to prevent math errors
            # Convert acceleration to proper easing behavior:
            # Positive acceleration should create ease-out (start fast, end slow)
            # Negative acceleration should create ease-in (start slow, end fast)
            clamped_acceleration = max(-0.99, min(0.99, acceleration))
            
            if clamped_acceleration > 0:
                # For positive acceleration, create ease-out behavior (start fast, end slow)
                # Use exponent < 1 to make time progress faster at the start and slower at the end
                exponent = max(0.01, 1.0 - clamped_acceleration)
            else:
                # For negative acceleration, create ease-in behavior (start slow, end fast)
                # Use exponent > 1 to make time progress slower at the start and faster at the end
                # abs(negative_acceleration) is positive, so 1.0 + positive_value > 1
                exponent = 1.0 + abs(clamped_acceleration)
                
            # Handle edge cases to avoid math errors
            if t == 0.0:
                remap_t = 0.0
            elif t == 1.0:
                remap_t = 1.0
            else:
                remap_t = pow(t, exponent)
            
            # Ensure remap_t stays within bounds
            remap_t = max(0.0, min(1.0, remap_t))
            
            # Map remap_t back to original point index
            original_index = remap_t * (n_points - 1)
            index_low = int(original_index)
            index_high = min(index_low + 1, n_points - 1)
            t_local = original_index - index_low
            
            # Linear interpolation between the two nearest points
            if index_low == index_high:
                output_points.append(points[index_low].copy())
            else:
                p1 = points[index_low]
                p2 = points[index_high]
                
                x = p1['x'] * (1.0 - t_local) + p2['x'] * t_local
                y = p1['y'] * (1.0 - t_local) + p2['y'] * t_local
                
                new_point = {'x': x, 'y': y}
                
                # Preserve any additional properties from the original points
                for key in p1:
                    if key not in ['x', 'y']:
                        new_point[key] = p1[key]
                
                output_points.append(new_point)
        
        # Ensure the first and last points match the original to maintain path integrity
        if output_points and len(output_points) > 1:
            output_points[0] = points[0].copy()
            output_points[-1] = points[-1].copy()
        
        return output_points

def interpolate_points(points, interpolation, easing_path='full', steps_per_segment=3):
    if not points or len(points) < 2:
        return points

    if interpolation in ['cardinal', 'basis']:
        highlighted_indices = [i for i, p in enumerate(points) if p.get('highlighted')]
        if highlighted_indices:
            boundaries = sorted(list(set([0] + highlighted_indices + [len(points) - 1])))
            if len(boundaries) > 2:
                final_path = []
                for i in range(len(boundaries) - 1):
                    start_idx = boundaries[i]
                    end_idx = boundaries[i+1]
                    segment = points[start_idx : end_idx + 1]

                    if len(segment) > 1:
                        interpolated_segment = interpolate_points(segment, interpolation, easing_path, steps_per_segment)
                        if i > 0:
                            final_path.extend(interpolated_segment[1:])
                        else:
                            final_path.extend(interpolated_segment)
                return final_path

    interpolated_points = []
    if interpolation == 'linear':
        interpolated_points = [p.copy() for p in points]

    elif interpolation == 'cardinal':
        num_points = len(points)
        padded_points = [points[0]] + points + [points[-1]]
        interpolated_points.append(points[0].copy())

        for i in range(num_points - 1):
            p0, p1, p2, p3 = padded_points[i:i+4]
            for t_step in range(1, steps_per_segment + 1):
                t = t_step / float(steps_per_segment)
                t2, t3 = t * t, t * t * t
                c0 = -0.5 * t3 + 1.0 * t2 - 0.5 * t
                c1 =  1.5 * t3 - 2.5 * t2 + 1.0
                c2 = -1.5 * t3 + 2.0 * t2 + 0.5 * t
                c3 =  0.5 * t3 - 0.5 * t2
                x = p0['x'] * c0 + p1['x'] * c1 + p2['x'] * c2 + p3['x'] * c3
                y = p0['y'] * c0 + p1['y'] * c1 + p2['y'] * c2 + p3['y'] * c3
                interpolated_points.append({'x': x, 'y': y})
    
    elif interpolation == 'basis':
        num_points = len(points)
        padded_points = [points[0]] * 2 + points + [points[-1]] * 2 

        for i in range(num_points + 1):
            p0, p1, p2, p3 = padded_points[i:i+4]
            for t_step in range(steps_per_segment + 1):
                if i > 0 and t_step == 0:
                    continue
                t = t_step / float(steps_per_segment)
                t2, t3 = t * t, t * t * t
                b0 = (1 - t)**3 / 6
                b1 = (3 * t3 - 6 * t2 + 4) / 6
                b2 = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6
                b3 = t3 / 6
                x = p0['x'] * b0 + p1['x'] * b1 + p2['x'] * b2 + p3['x'] * b3
                y = p0['y'] * b0 + p1['y'] * b1 + p2['y'] * b2 + p3['y'] * b3
                interpolated_points.append({'x': x, 'y': y})
        # The basis spline doesn't naturally pass through the last control point, so we add it explicitly.
        if points:
            interpolated_points.append(points[-1].copy())
    if not interpolated_points:
        return points

    control_points_to_process = [p.copy() for p in points]

    for cp in control_points_to_process:
        min_dist_sq = float('inf')
        closest_point_in_path = None
        for ip in interpolated_points:
            dist_sq = (ip['x'] - cp['x'])**2 + (ip['y'] - cp['y'])**2
            if dist_sq < min_dist_sq:
                min_dist_sq = dist_sq
                closest_point_in_path = ip
        
        if closest_point_in_path is not None:
            for key, value in cp.items():
                if key not in ['x', 'y']:
                    closest_point_in_path[key] = value

    return interpolated_points
