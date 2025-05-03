import torch
import json
import numpy as np
from PIL import ImageColor
import math # Needed for atan2, degrees, hypot
import torch.nn.functional as F # Added for grid_sample
# Assuming utility functions are in a parent directory utility module
from ..utility.utility import pil2tensor, tensor2pil # Ensure both are imported
from ..utility import draw_utils

class DrawImageOnPath:
    RETURN_TYPES = ("IMAGE", "STRING",)
    RETURN_NAMES = ("image", "output_coordinates",)
    FUNCTION = "create"
    CATEGORY = "WanVideoWrapper_QQ/depr"
    DESCRIPTION = """
Draws an input image along a coordinate path for each frame.
The image is rotated to align with the path segment direction.
The position is determined by the coordinate path and optional pivot coordinates.
If pivot_coordinates are provided:
  - relative_pivot=True: The pivot movement offsets the image from its path-defined position.
  - relative_pivot=False: The pivot replaces the starting point for positioning.
"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "coordinates": ("STRING", {"multiline": True, "default": '[{"x":100,"y":100},{"x":400,"y":400}]'}),
                "bg_image": ("IMAGE", ),
                "driven_image": ("IMAGE", ),
                "path_frame_config": ("PATH_FRAME_CONFIG", ),
                "bg_color": ("STRING", {"default": "black"}),
                "driven_image_scale": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 50.0, "step": 0.1}),
                "blur_radius": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100.0, "step": 0.1}),
                "intensity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 100.0, "step": 0.01}),
                "trailing": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 2.0, "step": 0.01}),
            },
            "optional": {
                "pivot_coordinates": ("STRING", {"multiline": False}),
                "relative_pivot": ("BOOLEAN", {"default": True}),
            }
        }

    def create(self, coordinates, driven_image, bg_image, path_frame_config,
                bg_color, blur_radius, intensity, trailing,
                driven_image_scale,
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
                print(f"DrawImageOnPath: Using coordinate metadata - start_p_frames={start_p_frames}, end_p_frames={end_p_frames}")
            else:
                # Old format: coordinates is already the right format
                coordinates_data = coordinates
                print("DrawImageOnPath: Using old coordinate format (no metadata)")
        except (json.JSONDecodeError, TypeError, KeyError) as e:
            print(f"DrawImageOnPath: Error parsing coordinates metadata: {e}. Using defaults.")
            coordinates_data = coordinates

        # Calculate animation frames (excluding before/after hold frames)
        animation_frames = total_frames - start_p_frames - end_p_frames
        
        # --- Device Selection ---
        # Select GPU if available, otherwise CPU
        # Consider making device selection an optional input later?
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        print(f"Using device: {device}")

        # --- Get Output Frame Dimensions from bg_image ---
        try:
            # bg_image is BHWC, float [0, 1]
            _, frame_height, frame_width, _ = bg_image.shape
            print(f"Output frame dimensions: {frame_width}x{frame_height}")
        except Exception as e:
            print(f"Error getting dimensions from bg_image: {e}. Using default 512x512.")
            frame_width, frame_height = 512, 512 # Fallback dimensions

        # --- Process driven_image Tensor ---
        if driven_image is None:
            print("Error: driven_image input is missing (None).")
            return (torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32), json.dumps([]))

        image_tensor_bhwc = None
        if isinstance(driven_image, list):
            # Handle case where input comes wrapped in a list
            if len(driven_image) > 0 and isinstance(driven_image[0], torch.Tensor):
                batch_tensor = driven_image[0]
                if batch_tensor.dim() == 4 and batch_tensor.shape[0] > 0: # BHWC
                    image_tensor_bhwc = batch_tensor # Keep the whole batch
                else:
                    print(f"Error: Tensor in list has invalid shape: {batch_tensor.shape}. Expected BHWC.")
            else:
                print("Error: driven_image is a list, but first element is missing or not a tensor.")
        elif isinstance(driven_image, torch.Tensor):
            if driven_image.dim() == 4 and driven_image.shape[0] > 0: # BHWC
                image_tensor_bhwc = driven_image # Use the whole batch
            elif driven_image.dim() == 3: # HWC? Assume B=1
                print("Warning: driven_image has 3 dims (HWC?), adding batch dim.")
                image_tensor_bhwc = driven_image.unsqueeze(0)
            else:
                print(f"Error: driven_image tensor has invalid shape: {driven_image.shape}. Expected BHWC or HWC.")
        else:
            print(f"Error: driven_image has invalid type: {type(driven_image)}.")

        if image_tensor_bhwc is None or image_tensor_bhwc.nelement() == 0:
            print("Error: Could not process driven_image into valid BHWC tensor.")
            return (torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32), json.dumps([]))
        
        # --- Store number of frames and original dimensions from first frame ---
        num_driven_frames = image_tensor_bhwc.shape[0]
        H_driven_orig = image_tensor_bhwc.shape[1] # Original Height from first frame
        W_driven_orig = image_tensor_bhwc.shape[2] # Original Width from first frame
        print(f"Detected {num_driven_frames} frame(s) in driven_image. Original dims: {W_driven_orig}x{H_driven_orig}")

        # --- Move driven_image to GPU and Prepare (BCHW) ---
        try:
            # Ensure float32 for grid_sample compatibility
            driven_gpu_bhwc = image_tensor_bhwc.to(device, dtype=torch.float32) 
            driven_gpu_bchw = driven_gpu_bhwc.permute(0, 3, 1, 2) # B, C, H, W
            _, C_driven, _, _ = driven_gpu_bchw.shape # Get Channel count
            print(f"Original Driven image tensor batch (GPU, BCHW): {driven_gpu_bchw.shape}, dtype={driven_gpu_bchw.dtype}")
        except Exception as e:
             print(f"Error moving/permuting driven_image to GPU: {e}")
             return (torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32), json.dumps([]))

        # --- Parse and Interpolate Coordinate Path ---
        p0_np = None # First point for scale calc
        p1_np = None # Second point for scale calc
        p_pivot_np = None # First point, fixed pivot for rotation
        points_validated = [] # List of raw {x, y} dicts for interpolation
        processed_path = [] # List of interpolated {x, y} dicts for each frame
        output_coords_list = [] # List to store output coordinates

        try:
            coords_data = json.loads(coordinates_data.replace("'", '"'))
            first_path_raw = None
            # Find the first valid list of points
            if isinstance(coords_data, list):
                if len(coords_data) > 0 and isinstance(coords_data[0], dict):
                    first_path_raw = coords_data # Single path
                    print("Using the first path provided.")
                elif len(coords_data) > 0 and isinstance(coords_data[0], list):
                    if len(coords_data[0]) > 0 and isinstance(coords_data[0][0], dict):
                        first_path_raw = coords_data[0] # First path in list of paths
                        print("Using the first path from the list of paths.")

            if not first_path_raw:
                print("Error: No valid coordinate path found in input.")
                raise ValueError("No valid coordinate path.")

            # Validate points and store for interpolation and initial calculations
            valid_path_segment = True
            for pt_idx, pt in enumerate(first_path_raw):
                if not isinstance(pt, dict) or 'x' not in pt or 'y' not in pt:
                    print(f"Warning: Invalid point format at index {pt_idx}: {pt}. Skipping path.")
                    valid_path_segment = False
                    break
                try:
                    # Store validated dict for interpolation
                    pt_validated = {'x': float(pt['x']), 'y': float(pt['y'])}
                    points_validated.append(pt_validated)
                    # Store first point as pivot
                    if pt_idx == 0:
                        p_pivot_np = np.array((pt_validated['x'], pt_validated['y']), dtype=np.float32)
                        p0_np = p_pivot_np # Use first point for scale calc
                    # Store second point for scale calc
                    elif pt_idx == 1:
                        p1_np = np.array((pt_validated['x'], pt_validated['y']), dtype=np.float32)
                except (ValueError, TypeError):
                    print(f"Warning: Non-numeric coordinate value at index {pt_idx}: {pt}. Skipping path.")
                    valid_path_segment = False
                    break
                
            if not valid_path_segment or not points_validated:
                print("Error: Path contains invalid points or is empty.")
                raise ValueError("Invalid or empty path.")

            # Ensure we have a pivot point
            if p_pivot_np is None:
                raise ValueError("First point (pivot) is missing.")

            # Ensure we have points needed for scale calc
            if p0_np is None or (len(points_validated) > 1 and p1_np is None):
                print("Warning: Less than two valid points found for initial scale calculation.")
                if p0_np is not None: p1_np = p0_np # Use p0 as p1 for scale if only one point exists
                else: raise ValueError("Need at least one point.")
            
            print(f"Using pivot p0: {p_pivot_np}")
            if p1_np is not None: print(f"Using p1 for initial scale: {p1_np}")

            # Prepare points for interpolation (start from p1 if available)
            interpolation_points = []
            if len(points_validated) >= 2:
                interpolation_points = points_validated[1:] # Use points AFTER the fixed p0
                print(f"Interpolating path starting from 2nd point ({len(interpolation_points)} points) over {animation_frames} frames...")
            elif len(points_validated) == 1:
                interpolation_points = [points_validated[0]] # Only one point, use it (will be static relative to p0)
                print(f"Path has only one point. Animation target will be static relative to the first point.")
            else:
                # This case should be caught earlier, but as safety:
                raise ValueError("No points available for interpolation.")

            # Use animation_frames (not total_frames) for interpolation
            processed_path = draw_utils.InterpMath.interpolate_or_downsample_path(
                interpolation_points, animation_frames, easing_function, easing_path, bounce_between=0.0, easing_strength=easing_strength
            )
            if not processed_path:
                raise ValueError("Interpolation failed.")
            print(f"Generated {len(processed_path)} points for animation path.")

        except Exception as e:
            print(f"Error processing/interpolating coordinates: {e}")
            return (torch.zeros([total_frames, frame_height, frame_width, 3], dtype=torch.float32), json.dumps([]))
        

        # --- Calculate Target Height for Resizing (Based on initial p0, p1) ---
        try:
            dist_p0_p1 = np.linalg.norm(p1_np - p0_np) if p1_np is not None else 0.0
            height_coeff = float(frame_height) / 480.0 # Compare output height to reference 480
            target_h_float = dist_p0_p1 * 2.0 * height_coeff * float(driven_image_scale)
            target_h = max(1.0, target_h_float) # Ensure at least 1 pixel height
            print(f"Target Height Calc: dist={dist_p0_p1:.2f}, height_coeff={height_coeff:.2f}, input_scale={driven_image_scale:.2f} => target_h={target_h:.2f}")
        except Exception as e:
            print(f"Error calculating target height: {e}. Target height might be inaccurate.")
            target_h = H_driven_orig # Fallback to original height

        # --- Resize driven_image based on target_h (ONCE, entire batch) ---
        driven_resized_gpu_bchw = None
        H_driven_resized, W_driven_resized = H_driven_orig, W_driven_orig # Initialize with original
        try:
            # Avoid division by zero if original height is 0 (shouldn't happen with checks)
            resize_scale_factor = target_h / H_driven_orig if H_driven_orig > 0 else 1.0 
            target_w_float = W_driven_orig * resize_scale_factor
            target_w = max(1.0, target_w_float)
            
            target_h_int = int(round(target_h))
            target_w_int = int(round(target_w))

            if target_h_int != H_driven_orig or target_w_int != W_driven_orig:
                print(f"Resizing driven_image batch from {W_driven_orig}x{H_driven_orig} to {target_w_int}x{target_h_int}")
                # Resize the whole batch
                driven_resized_gpu_bchw = F.interpolate(
                    driven_gpu_bchw, 
                    size=(target_h_int, target_w_int), 
                    mode='bilinear', 
                    align_corners=False
                )
            else:
                print("Skipping resize as target dimensions match original.")
                driven_resized_gpu_bchw = driven_gpu_bchw

            _, C_driven_resized, H_driven_resized, W_driven_resized = driven_resized_gpu_bchw.shape
            print(f"Resized driven image batch shape (BCHW): {driven_resized_gpu_bchw.shape}")

        except Exception as e:
            print(f"Error resizing driven_image batch: {e}. Using original image.")
            driven_resized_gpu_bchw = driven_gpu_bchw # Fallback
            _, C_driven_resized, H_driven_resized, W_driven_resized = driven_resized_gpu_bchw.shape
        
        # --- Pre-calculate constants for frame loop ---
        try:
            # === Calculate anchor shift based on ORIGINAL height ===
            anchor_shift_y = (H_driven_orig - 1.0) / 2.0
            print(f"Calculated anchor_shift_y for sampling adjustment: {anchor_shift_y:.2f}")

            # Background tensor (constant)
            bg_rgb = ImageColor.getrgb(bg_color)
            bg_tensor_rgb = torch.tensor([c / 255.0 for c in bg_rgb], dtype=torch.float32, device=device)
            # Use resized channel count
            bg_chw = bg_tensor_rgb.view(C_driven_resized, 1, 1).expand(-1, frame_height, frame_width)

            # Resized Driven Image Center (constant)
            center_x_driven = (W_driven_resized - 1.0) / 2.0
            center_y_driven = (H_driven_resized - 1.0) / 2.0
            driven_center_gpu = torch.tensor([center_x_driven, center_y_driven], device=device, dtype=torch.float32)

            # Translation matrix to driven image center (constant)
            T_center = torch.eye(3, device=device, dtype=torch.float32)
            T_center[0, 2] = driven_center_gpu[0]
            T_center[1, 2] = driven_center_gpu[1]

            # Calculate offset compensation for top-center scaling anchor (constant)
            # Uses Resized H and Original H
            offset_y = (H_driven_resized - H_driven_orig) / 2.0 
            T_offset_inv = torch.eye(3, device=device, dtype=torch.float32)
            T_offset_inv[1, 2] = -offset_y # Apply inverse vertical shift
            print(f"Calculated top-center anchor offset_y: {offset_y:.2f}")

            # Output grid (constant)
            y_coords = torch.linspace(0.0, frame_height - 1.0, steps=frame_height, device=device, dtype=torch.float32)
            x_coords = torch.linspace(0.0, frame_width - 1.0, steps=frame_width, device=device, dtype=torch.float32)
            grid_y, grid_x = torch.meshgrid(y_coords, x_coords, indexing='ij')
            out_grid_pix = torch.stack((grid_x, grid_y), dim=-1)
            out_grid_homo = torch.cat(
                (out_grid_pix, torch.ones(frame_height, frame_width, 1, device=device, dtype=torch.float32)),
                dim=-1
            )
            out_grid_flat = out_grid_homo.view(-1, 3)

            # Normalization factors (constant)
            norm_factor_x = 2.0 / max(W_driven_resized - 1.0, 1e-6)
            norm_factor_y = 2.0 / max(H_driven_resized - 1.0, 1e-6)

            # Mask input tensor (no longer constant, created in loop)
            # mask_input = torch.ones_like(driven_resized_gpu_bchw[:, 0:1, :, :]) # REMOVED

            # Fixed rotation pivot (constant)
            p_pivot_gpu = torch.from_numpy(p_pivot_np).to(device)
            initial_angle_rad = torch.tensor(-math.pi / 2.0, device=device, dtype=torch.float32)

        except Exception as e:
            print(f"Error during pre-calculation: {e}")
            return (torch.zeros([total_frames, frame_height, frame_width, 3], dtype=torch.float32), json.dumps([]))

        # --- Frame Loop for Animation ---
        output_frames_list = []
        print(f"Generating {total_frames} frames...")
        for frame_idx in range(total_frames):
            try:
                # Map frame index to coordinate index (before/after frames "hold" at start/end)
                if frame_idx < start_p_frames:
                    coord_index = 0  # Hold at first position for start_p_frames
                elif frame_idx >= total_frames - end_p_frames:
                    coord_index = animation_frames - 1  # Hold at last position for end_p_frames
                else:
                    coord_index = frame_idx - start_p_frames  # Normal animation frames

                # Get current interpolated point for this frame
                current_point_dict = processed_path[coord_index]
                p_current_np = np.array((current_point_dict['x'], current_point_dict['y']), dtype=np.float32)
                p_current_gpu = torch.from_numpy(p_current_np).to(device)

                # Store output coordinates (using the animated target point relative to p0)
                # Calculate the final position: p0 + (p_current - p0) = p_current
                output_coords_list.append({'x': int(round(p_current_np[0])), 'y': int(round(p_current_np[1]))})

                # --- Calculate Per-Frame Rotation ---
                # Rotation is based on vector from pivot (p0) to current target point
                vec_pivot_to_target = p_current_gpu - p_pivot_gpu 
                # Handle case where current point is same as pivot (avoid atan2(0,0))
                if torch.linalg.norm(vec_pivot_to_target) < 1e-6:
                    # If at pivot, maybe keep previous rotation or set to 0?
                    # Let's default to 0 rotation (aligned with initial angle)
                    rotation_rad = -initial_angle_rad # Results in 0 effective rotation from initial
                else:
                    target_angle_rad = torch.atan2(vec_pivot_to_target[1], vec_pivot_to_target[0])
                    rotation_rad = target_angle_rad - initial_angle_rad

                # --- Build Per-Frame Inverse Transform Matrix ---
                # T_p_current_inv: Translate current point p_current back to origin
                T_p_current_inv = torch.eye(3, device=device, dtype=torch.float32)
                T_p_current_inv[0, 2] = -p_current_gpu[0] # Use animated position
                T_p_current_inv[1, 2] = -p_current_gpu[1] # Use animated position
  
                # R_inv: Rotate back by -rotation_rad around origin
                cos_r = torch.cos(-rotation_rad)
                sin_r = torch.sin(-rotation_rad)
                R_inv = torch.eye(3, device=device, dtype=torch.float32)
                R_inv[0, 0] = cos_r
                R_inv[0, 1] = -sin_r
                R_inv[1, 0] = sin_r
                R_inv[1, 1] = cos_r

                # Combine: M_inv = T_center @ T_offset_inv @ R_inv @ T_p_current_inv
                M_inv = T_center @ T_offset_inv @ R_inv @ T_p_current_inv

                # --- Transform Grid, Normalize, Sample, Blend (Per Frame) ---
                transformed_grid_flat = out_grid_flat @ M_inv.T
                transformed_grid_homo = transformed_grid_flat.view(frame_height, frame_width, 3)
                transformed_grid_pix = transformed_grid_homo[..., :2]

                # === MODIFIED: Apply anchor shift to y-coordinate ===
                adjusted_transformed_grid_pix = transformed_grid_pix - torch.tensor([0.0, anchor_shift_y], device=device, dtype=torch.float32)

                # Normalize the ADJUSTED grid coordinates
                norm_grid_x = adjusted_transformed_grid_pix[..., 0] * norm_factor_x - 1.0
                norm_grid_y = adjusted_transformed_grid_pix[..., 1] * norm_factor_y - 1.0
                # === END MODIFICATION ===

                norm_grid = torch.stack((norm_grid_x, norm_grid_y), dim=-1)
                final_grid = norm_grid.unsqueeze(0) # Shape: [1, H_out, W_out, 2]

                # --- Select driven frame and create mask ---
                driven_frame_index = min(frame_index, num_driven_frames - 1)
                current_driven_frame_bchw = driven_resized_gpu_bchw[driven_frame_index:driven_frame_index+1] # Shape: [1, C, H_res, W_res]
                # Create mask for the *selected* frame (e.g., from first channel or alpha if available)
                # For simplicity, using ones like before, but now per-frame based on selected frame shape
                current_mask_input = torch.ones_like(current_driven_frame_bchw[:, 0:1, :, :]) # Shape: [1, 1, H_res, W_res]

                # Sample the selected driven frame
                sampled_bchw = F.grid_sample(
                    current_driven_frame_bchw, # Use the selected frame
                    final_grid, 
                    mode='bilinear', 
                    padding_mode='zeros', 
                    align_corners=True # Often True for affine transforms
                )

                # Sample the corresponding mask
                mask_bchw = F.grid_sample(
                    current_mask_input, # Use the mask for the selected frame
                    final_grid, 
                    mode='nearest', # Use nearest for masks
                    padding_mode='zeros', 
                    align_corners=True
                )
                mask_chw = mask_bchw.squeeze(0) # Shape: [1, H_out, W_out] -> [C=1, H_out, W_out]

                # Blend background and sampled frame using the mask
                output_chw = bg_chw * (1.0 - mask_chw) + sampled_bchw.squeeze(0) * mask_chw
                
                # --- Convert frame to Output Format (BHWC, CPU) ---
                output_bhwc = output_chw.permute(1, 2, 0).unsqueeze(0) # H, W, C -> 1, H, W, C
                output_frames_list.append(output_bhwc.cpu())

            except Exception as e:
                 print(f"Error processing frame {frame_index}: {e}")
                 # Append a blank frame as fallback for this frame
                 blank_frame = torch.zeros([1, frame_height, frame_width, C_driven_resized], dtype=torch.float32) # Use C from resized
                 output_frames_list.append(blank_frame)
                 # Add a placeholder coordinate if frame failed
                 output_coords_list.append({'x': 0, 'y': 0}) # Add placeholder coord
                 continue

        # --- Concatenate Frames and Final Return ---
        if not output_frames_list:
            print("Error: No frames generated.")
            # Return a single blank frame if list is empty
            final_output_batch = torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32)
        else:
            try:
                final_output_batch = torch.cat(output_frames_list, dim=0) # B=total_frames, H, W, C
            except Exception as e:
                print(f"Error concatenating frames: {e}. Returning first frame only.")
                final_output_batch = output_frames_list[0] if output_frames_list else torch.zeros([1, frame_height, frame_width, 3], dtype=torch.float32)
        
        output_coords_json = json.dumps(output_coords_list, separators=(',', ':'))
        print(f"DrawImageOnPath GPU animation finished. Output shape: {final_output_batch.shape}")
        return (final_output_batch, output_coords_json)
