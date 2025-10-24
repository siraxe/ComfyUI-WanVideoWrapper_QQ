import torch
import torch.nn.functional as F

class WanVideoVACEFrameReplace:

    RETURN_TYPES = ("IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("video", "mask", "middle_frames")
    FUNCTION = "keep_images_in_batch"
    CATEGORY = "WanVideoWrapper_QQ"
    DESCRIPTION = """
Enhanced frame processing with multiple input formats:
- Single numbers (e.g., "5"): Replace frame with gray_level color
- Single numbers with + (e.g., "5+"): Replace frame with next replacement_image
- Single numbers with * (e.g., "41*"): Replace frame with next replacement_image
- Ranges (e.g., "22-26"): Replace range of frames with gray_level color (applies -1 logic)
- Ranges with * (e.g., "*1-5" or "1-5*"): Replace start or end frame with next replacement_image and remove the rest of the frames in the range
- a-b-c patterns: Use replacement_images if provided for middle frames
- +a-b-c: Duplicate middle frame image to frame before (b-1)
- a-b-c+: Duplicate middle frame image to frame after (b+1)
- +a-b-c+: Duplicate middle frame image to both before and after (b-1 and b+1)
- Multiple +: Use multiple + signs for gradual blending (e.g., "++a-b-c" creates 2 left duplicates)
- Custom opacity: Add space and float value (0.0-1.0) after patterns (e.g., "a-b-c+ 0.6", "++a-b-c+ 0.8")
  to specify mask opacity for duplicated frames with gradual blending (closest=strongest, farthest=weakest)

Base masks (optional):
- Provide starting masks that will be used as the base for all frame operations
- Automatically scaled to match image dimensions
- Applied to corresponding frames - these masks are preserved unless overridden by replacement operations
- Frames not explicitly replaced will keep their original masks from this input
- If no masks provided, defaults to black masks (all frames kept)

Replacement masks (optional):
- Provide custom mask patterns instead of generated opacity values
- Automatically scaled to match image dimensions
- Used for middle frames and + suffix frames when available
- Falls back to generated masks when replacement_masks run out
- For + patterns with opacity: blends replacement mask with specified opacity

All image/mask replacements share the same counter.
Creates a mask showing which frames were kept (black) and which were replaced (varying patterns/opacity).
"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "images": ("IMAGE",),
                "indexes": ("STRING", {"default": "2-5-3", "multiline": True}),
                "gray_level": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01}),
                "max_frames": ("INT", {"default": -1, "min": -1, "max": 1000, "step": 1}),
                "mask_opacity": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01}),
            },
            "optional": {
                "masks": ("MASK",),
                "replacement_images": ("IMAGE",),
                "replacement_masks": ("MASK",),

            }
        }

    def _scale_mask_to_image_dimensions(self, mask, target_height, target_width):
        """Scale a mask to match target image dimensions"""
        if mask.shape[0] == target_height and mask.shape[1] == target_width:
            return mask

        # Add batch dimension if needed for interpolation
        if len(mask.shape) == 2:
            mask_for_scaling = mask.unsqueeze(0).unsqueeze(0)  # [1, 1, H, W]
        else:
            mask_for_scaling = mask.unsqueeze(0)  # [1, H, W]

        # Scale using bilinear interpolation
        scaled_mask = F.interpolate(
            mask_for_scaling,
            size=(target_height, target_width),
            mode='bilinear',
            align_corners=False
        )

        # Remove added dimensions and return
        return scaled_mask.squeeze(0).squeeze(0) if len(mask.shape) == 2 else scaled_mask.squeeze(0)

    def keep_images_in_batch(self, images, indexes, gray_level, max_frames, mask_opacity, replacement_images=None, replacement_masks=None, masks=None):
        # Parse the indexes string with enhanced format support
        index_list = []
        middle_frames = []
        frames_to_remove = []  # New: frames to be removed (gray masked)
        range_to_remove = []   # New: ranges to be removed (gray masked)
        frames_to_replace_with_images = []  # New: frames to replace with images (+ suffix)
        middle_frame_duplicates = {}  # New: {frame_index: middle_frame_index} for duplicates

        # Create a unified counter for replacement images
        replacement_counter = 0

        if indexes.strip() != "":
            try:
                parsed_lines = []

                # First pass: parse all valid lines
                for line in indexes.strip().split('\n'):
                    line = line.strip()
                    if line:
                        if '-' in line:
                            # Check if it's a two-number range (22-26) or a-b-c pattern
                            first_part = line.split(',')[0].strip() if ',' in line else line
                            parts = first_part.split('-')
                            if len(parts) == 2:
                                # Two-number range format (e.g., "22-26", "*1-5", "1-5*")
                                try:
                                    start_str, end_str = parts[0], parts[1]

                                    # Check for '*' prefix for start frame replacement
                                    if start_str.startswith('*'):
                                        start_val = int(start_str.lstrip('*'))
                                        end_val = int(end_str)
                                        frame_to_replace = start_val - 1
                                        frames_to_replace_with_images.append(frame_to_replace)
                                        # Add the rest of the range for removal
                                        if start_val < end_val:
                                            range_to_remove.append((start_val, end_val - 1))
                                    # Check for '*' suffix for end frame replacement
                                    elif end_str.endswith('*'):
                                        start_val = int(start_str)
                                        end_val = int(end_str.rstrip('*'))
                                        frame_to_replace = end_val - 1
                                        frames_to_replace_with_images.append(frame_to_replace)
                                        # Add the rest of the range for removal
                                        if start_val < end_val:
                                            range_to_remove.append((start_val - 1, end_val - 2))
                                    # Default to range removal (gray masking)
                                    else:
                                        start, end = int(start_str) - 1, int(end_str) - 1
                                        range_to_remove.append((start, end))
                                except ValueError:
                                    continue
                            elif len(parts) >= 3:
                                # a-b-c pattern - for replacement logic, check for + prefix/suffix and opacity
                                try:
                                    # Check for opacity value after the pattern
                                    opacity_value = 0.5  # Default 50% gray
                                    pattern_part = first_part

                                    # Look for space and float value after the pattern
                                    if ' ' in line:
                                        pattern_and_opacity = line.split(' ', 1)
                                        if len(pattern_and_opacity) == 2:
                                            pattern_part = pattern_and_opacity[0].strip()
                                            try:
                                                opacity_value = float(pattern_and_opacity[1].strip())
                                                opacity_value = max(0.0, min(1.0, opacity_value))  # Clamp between 0 and 1
                                            except ValueError:
                                                opacity_value = 0.5  # Default if parsing fails

                                    # Count + prefix and suffix occurrences in the pattern part
                                    prefix_count = 0
                                    suffix_count = 0

                                    # Count leading + signs
                                    for char in pattern_part:
                                        if char == '+':
                                            prefix_count += 1
                                        else:
                                            break

                                    # Count trailing + signs
                                    for char in reversed(pattern_part):
                                        if char == '+':
                                            suffix_count += 1
                                        else:
                                            break

                                    # Clean the parts for parsing
                                    clean_parts = pattern_part.strip('+').split('-')
                                    left, middle, right = int(clean_parts[0]), int(clean_parts[1]) - 1, int(clean_parts[2])
                                    parsed_lines.append((left, middle, right, opacity_value))
                                    middle_frames.append(middle)

                                    # Add duplicate frames based on + prefix count with gradual opacity
                                    if prefix_count > 0:
                                        for i in range(1, prefix_count + 1):
                                            duplicate_frame = middle - i
                                            if duplicate_frame >= 0:
                                                # Gradual opacity: i/prefix_count * opacity_value
                                                gradual_opacity = (i / prefix_count) * opacity_value
                                                middle_frame_duplicates[duplicate_frame] = (middle, gradual_opacity)

                                    # Add duplicate frames based on + suffix count with gradual opacity
                                    if suffix_count > 0:
                                        for i in range(1, suffix_count + 1):
                                            duplicate_frame = middle + i
                                            # Gradual opacity: closest frame gets full opacity, further ones get less
                                            gradual_opacity = ((suffix_count - i + 1) / suffix_count) * opacity_value
                                            middle_frame_duplicates[duplicate_frame] = (middle, gradual_opacity)

                                except ValueError:
                                    continue
                        else:
                            # Handle single number lines - check for + or * suffix
                            import re
                            if '+' in line:
                                # Single number with + suffix - for image replacement
                                numbers = re.findall(r'\d+', line)
                                if numbers:
                                    try:
                                        single_frame = int(numbers[0]) - 1  # Convert UI frame to array index
                                        frames_to_replace_with_images.append(single_frame)
                                    except ValueError:
                                        continue
                            elif '*' in line:
                                # Single number with * suffix - for image replacement
                                numbers = re.findall(r'\d+', line)
                                if numbers:
                                    try:
                                        single_frame = int(numbers[0]) - 1  # Convert UI frame to array index
                                        frames_to_replace_with_images.append(single_frame)
                                    except ValueError:
                                        continue
                            else:
                                # Single number without + or * - for removal/gray masking
                                numbers = re.findall(r'\d+', line)
                                if numbers:
                                    try:
                                        single_frame = int(numbers[0]) - 1  # Convert UI frame to array index
                                        frames_to_remove.append(single_frame)
                                    except ValueError:
                                        continue

                # Expand ranges to individual frames for removal
                for start, end in range_to_remove:
                    frames_to_remove.extend(range(start, end + 1))

                # Second pass: process the parsed lines (a-b-c patterns) - calculate all borders
                if parsed_lines:
                    # First line: keep frames 0 to (middle-left-1), middle frame
                    first_left, first_middle, first_right, first_opacity = parsed_lines[0]
                    keep_until = first_middle - first_left - 1
                    if keep_until >= 0:
                        index_list.extend(range(0, keep_until + 1))  # 0 to middle-left-1
                    index_list.append(first_middle)  # middle frame

                    # Process subsequent lines
                    for i in range(1, len(parsed_lines)):
                        left, middle, right, opacity = parsed_lines[i]
                        prev_left, prev_middle, prev_right, prev_opacity = parsed_lines[i-1]

                        # Keep frames between patterns
                        start_frame = prev_middle + prev_right + 1
                        end_frame = middle - left - 1
                        if start_frame <= end_frame:
                            index_list.extend(range(start_frame, end_frame + 1))
                        index_list.append(middle)  # middle frame

                    # After the last pattern, keep all frames until the end
                    if parsed_lines:
                        _, last_middle, last_right, last_opacity = parsed_lines[-1]
                        start_frame = last_middle + last_right + 1
                        if start_frame < images.shape[0]:
                            index_list.extend(range(start_frame, images.shape[0]))

            except (ValueError, IndexError):
                # If parsing fails, use empty lists
                index_list = []
                middle_frames = []
                frames_to_remove = []
                range_to_remove = []
                frames_to_replace_with_images = []
                middle_frame_duplicates = {}

        # Remove duplicates for efficiency and correctness
        index_list = list(set(index_list))

        # Determine required batch size
        if max_frames > 0:
            # Validate max_frames follows the 4n+1 pattern (5, 9, 13, 17, etc.)
            if (max_frames - 1) % 4 != 0:
                # Adjust to nearest valid value
                max_frames = ((max_frames - 1) // 4) * 4 + 1
            required_batch_size = max_frames
        elif index_list:
            # Use the maximum index + 1 as required batch size
            required_batch_size = max(index_list) + 1
        else:
            # No specific requirements, use current batch size
            required_batch_size = images.shape[0]

        original_batch_size = images.shape[0]
        height = images.shape[1]
        width = images.shape[2]
        channels = images.shape[3]

        # Create gray image with custom gray level
        gray_image = torch.full((height, width, channels), gray_level, dtype=images.dtype)

        # Handle cases where we need to extend or trim the batch
        if required_batch_size > original_batch_size:
            # Need to create extra frames
            extra_frames = required_batch_size - original_batch_size
            extra_images = gray_image.unsqueeze(0).repeat(extra_frames, 1, 1, 1)
            output_images = torch.cat([images, extra_images], dim=0)
        else:
            # Clone the input images and trim if necessary
            output_images = images[:required_batch_size].clone()

        batch_size = output_images.shape[0]

        # No more "fill till end" logic - each pattern defines exactly which frames to keep

        # Remove duplicates again after adding end frames
        index_list = list(set(index_list))

        # Remove duplicates from frames_to_remove and frames_to_replace_with_images
        frames_to_remove = list(set(frames_to_remove))
        frames_to_replace_with_images = list(set(frames_to_replace_with_images))

        # Create gray image for replacement (using gray_level)
        replacement_image = torch.full((height, width, channels), gray_level, dtype=images.dtype)

        # Create mask tensor - use provided masks as starting point, otherwise default to black (kept frames)
        if masks is not None:
            # Use provided masks as starting point
            mask = torch.zeros((batch_size, height, width), dtype=torch.float32)
            # Apply provided masks to corresponding frames
            for i in range(min(masks.shape[0], batch_size)):
                base_mask = masks[i]
                # Scale mask to match image dimensions
                scaled_base_mask = self._scale_mask_to_image_dimensions(base_mask, height, width)
                mask[i] = scaled_base_mask
        else:
            # Default: black masks (all frames kept) when no masks provided
            mask = torch.zeros((batch_size, height, width), dtype=torch.float32)

        # Prepare replacement images if provided
        replacement_image_list = []
        if replacement_images is not None:
            # Convert replacement_images tensor to list for easier indexing
            for i in range(replacement_images.shape[0]):
                replacement_image_list.append(replacement_images[i])

        # Prepare replacement masks if provided
        replacement_mask_list = []
        if replacement_masks is not None:
            # Convert replacement_masks tensor to list and scale to match image dimensions
            for i in range(replacement_masks.shape[0]):
                replacement_mask = replacement_masks[i]
                # Scale mask to match image dimensions
                scaled_mask = self._scale_mask_to_image_dimensions(replacement_mask, height, width)
                replacement_mask_list.append(scaled_mask)

        # Create dictionaries to store opacity values for different frame types
        duplicate_frame_opacities = {}  # Store opacity for duplicate frames only

        # Store opacity values for duplicate frames from middle_frame_duplicates
        for duplicate_frame, source_info in middle_frame_duplicates.items():
            source_middle_frame, opacity = source_info
            duplicate_frame_opacities[duplicate_frame] = opacity

        # Process each frame (original logic)
        middle_frame_images = {}  # Store middle frame images for duplicates
        middle_frame_masks = {}  # Store middle frame masks for duplicates

        # No need for separate counters - we'll use position-based indexing directly

        for i in range(batch_size):
            if i in frames_to_remove:
                # Replace frame with gray_level color and set mask to white (1.0)
                output_images[i] = replacement_image
                mask[i] = torch.ones((height, width), dtype=torch.float32)
            elif i in frames_to_replace_with_images and replacement_image_list:
                # Calculate position in the frames_to_replace_with_images order
                # Find position by sorting frames_to_replace_with_images and getting index
                sorted_frames_to_replace = sorted(frames_to_replace_with_images)
                position_in_plus_replacements = sorted_frames_to_replace.index(i)

                # Use the unified replacement counter to ensure sequential assignment
                current_replacement_index = min(replacement_counter, len(replacement_image_list) - 1)
                output_images[i] = replacement_image_list[current_replacement_index]

                # Use replacement mask if available, otherwise default to a black mask (fully visible)
                # Important: Use the same index for mask as we used for the image
                if replacement_mask_list:
                    current_mask_index = min(current_replacement_index, len(replacement_mask_list) - 1)
                    mask[i] = replacement_mask_list[current_mask_index]
                else:
                    mask[i] = torch.zeros((height, width), dtype=torch.float32)  # Default black mask

                # Increment unified counter after using the replacement image
                replacement_counter += 1

            elif i in middle_frames and replacement_image_list:
                # Use the unified replacement counter to ensure sequential assignment
                current_replacement_index = min(replacement_counter, len(replacement_image_list) - 1)
                output_images[i] = replacement_image_list[current_replacement_index]

                # Use replacement mask if available, otherwise black mask (0.0)
                # Important: Use the same index for mask as we used for the image
                if replacement_mask_list:
                    current_mask_index = min(current_replacement_index, len(replacement_mask_list) - 1)
                    mask[i] = replacement_mask_list[current_mask_index]
                    # Store the mask for potential duplicates
                    middle_frame_masks[i] = replacement_mask_list[current_mask_index]
                else:
                    # Middle frames use black mask (0.0) when no replacement mask
                    mask[i] = torch.zeros((height, width), dtype=torch.float32)
                # Store the image for potential duplicates
                middle_frame_images[i] = replacement_image_list[current_replacement_index]
                
                # Increment unified counter after using the replacement image
                replacement_counter += 1
            elif i < original_batch_size and (not index_list or i in index_list):
                # Keep the original frame - preserve the provided mask if available, otherwise set to black (0.0)
                if masks is None or i >= masks.shape[0]:
                    mask[i] = torch.zeros((height, width), dtype=torch.float32)
            elif i < original_batch_size:
                # Replace original frame with gray and set mask to white (1.0)
                output_images[i] = gray_image
                mask[i] = torch.ones((height, width), dtype=torch.float32)
            else:
                # Extra frames (i >= original_batch_size) - handle mask properly
                output_images[i] = gray_image
                mask[i] = torch.ones((height, width), dtype=torch.float32)

        # Second pass: Apply duplicate image insertions (after all original processing is complete)
        for duplicate_frame, source_info in middle_frame_duplicates.items():
            source_middle_frame, opacity = source_info
            if duplicate_frame < batch_size and source_middle_frame in middle_frame_images:
                # Copy the middle frame image to the duplicate position
                output_images[duplicate_frame] = middle_frame_images[source_middle_frame]

                # Use replacement mask if available for the source middle frame
                if source_middle_frame in middle_frame_masks:
                    # Blend the replacement mask with opacity
                    base_mask = middle_frame_masks[source_middle_frame]
                    inverted_opacity = 1.0 - opacity
                    # Blend: base_mask * (1 - inverted_opacity) + inverted_opacity
                    # This applies the opacity while preserving the mask pattern
                    blended_mask = base_mask * (1.0 - inverted_opacity) + inverted_opacity
                    mask[duplicate_frame] = blended_mask
                else:
                    # Use inverted opacity as before when no replacement mask
                    inverted_opacity = 1.0 - opacity
                    mask[duplicate_frame] = torch.full((height, width), inverted_opacity, dtype=torch.float32)

        # Apply mask opacity (fill masks with white) on all frames except the first and last frames
        # and frames that are specifically for image replacement
        if mask_opacity > 0.0:
            for i in range(1, batch_size - 1):  # Skip first frame (index 0) and last frame (batch_size - 1)
                # Don't apply global opacity to frames that were specifically marked for image replacement
                # as these should keep their specific masks (or default black masks)
                if i not in frames_to_replace_with_images and i not in middle_frames:
                    # Fill mask with white color at specified opacity percentage
                    # Blend current mask with white (1.0) using mask_opacity as alpha
                    mask[i] = mask[i] * (1.0 - mask_opacity) + 1.0 * mask_opacity

        # Convert middle_frames list to string for output
        middle_frames_str = ','.join(map(str, middle_frames)) if middle_frames else ""

        return (output_images, mask, middle_frames_str)