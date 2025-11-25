import torch
import torch.nn.functional as F # Added F
import folder_paths
from PIL import Image
import numpy as np
import os
from concurrent.futures import ThreadPoolExecutor

class ImageBlend_GPU:
    # Moved blend modes inside the class
    BLEND_MODES = [
        "normal", "multiply", "screen", "overlay", "add", "subtract", 
        "difference", "darken", "lighten", 
        # Add other modes supported by the original chop_image if known
    ]

    # Keep NODE_NAME if used for printing
    NODE_NAME = "Image Blend GPU (Optimized)" 

    @classmethod
    def INPUT_TYPES(self):
        # Input types remain the same structurally
        return {
            "required": {
                "background_image": ("IMAGE",), # BHWC tensor
                "layer_image": ("IMAGE",),      # BHWC tensor
                "blend_mode": (self.BLEND_MODES,), # Reference class attribute
                "opacity": ("INT", {"default": 100, "min": 0, "max": 100, "step": 1}),
            },
            "optional": {
                "layer_mask": ("MASK",),       # BHW tensor
                "invert_mask": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = 'image_blend_gpu' # Renamed function to reflect GPU implementation
    CATEGORY = 'WanVideoWrapper_QQ/image' # Keep category or update as needed

    def blend_normal(self, background, layer):
        # Standard alpha compositing is handled by the final masking stage
        return layer

    def blend_multiply(self, background, layer):
        return background * layer

    def blend_screen(self, background, layer):
        return 1.0 - (1.0 - background) * (1.0 - layer)

    def blend_overlay(self, background, layer):
        # Equivalent to:
        # low = 2.0 * background * layer
        # high = 1.0 - 2.0 * (1.0 - background) * (1.0 - layer)
        # return torch.where(background < 0.5, low, high)
        # Faster implementation:
        return torch.where(background < 0.5, 
                           2.0 * background * layer, 
                           1.0 - 2.0 * (1.0 - background) * (1.0 - layer))

    def blend_add(self, background, layer):
        return torch.clamp(background + layer, 0.0, 1.0)

    def blend_subtract(self, background, layer):
        return torch.clamp(background - layer, 0.0, 1.0)
        
    def blend_difference(self, background, layer):
        return torch.abs(background - layer)

    def blend_darken(self, background, layer):
        return torch.minimum(background, layer)

    def blend_lighten(self, background, layer):
        return torch.maximum(background, layer)

    def image_blend_gpu(self, background_image, layer_image,
                         blend_mode, opacity,
                        layer_mask=None,
                        invert_mask=False):

        device = background_image.device # Use the device of the input tensor
        
        # Ensure tensors are BHWC, float32, and on the correct device
        bg_bhwc = background_image.to(device, dtype=torch.float32)
        layer_bhwc = layer_image.to(device, dtype=torch.float32)

        b_frames = bg_bhwc.shape[0]
        l_frames = layer_bhwc.shape[0]
        max_frames = max(b_frames, l_frames) # Calculate max_frames early

        # --- Mask Handling --- If layer_mask is provided, use it. Otherwise, no mask (full opacity) ---
        mask_bhwc = None # Initialize
        if layer_mask is not None:
            # Input mask is BHW, float32
            mask_b = layer_mask.to(device, dtype=torch.float32)
            if mask_b.dim() == 2: # Single mask image for batch
                 mask_b = mask_b.unsqueeze(0).repeat(max_frames, 1, 1)
            elif mask_b.shape[0] != max_frames:
                 # Repeat last mask frame if batch size mismatches
                 if mask_b.shape[0] < max_frames:
                     mask_b = torch.cat([mask_b, mask_b[-1:].repeat(max_frames - mask_b.shape[0], 1, 1)], dim=0)
                 else: # Truncate if mask batch is longer
                     mask_b = mask_b[:max_frames]

            if invert_mask: # Apply inversion ONLY if mask was provided
                mask_b = 1.0 - mask_b
            else:
                print(f"[INFO] Not inverting provided mask.")
                
            # Unsqueeze to BHWC for broadcasting (B, H, W, 1)
            mask_bhwc = mask_b.unsqueeze(-1)

        # --- Default Mask: If no layer_mask was provided, create a full white mask ---
        else: 
            # Determine target H/W. Use layer's spatial dimensions as default target.
            target_h = layer_bhwc.shape[1] # Use layer height
            target_w = layer_bhwc.shape[2] # Use layer width
            
            # If background and layer differ, resize happens later, mask should match initial layer size here?
            # Let's create mask matching the potentially un-resized layer dimensions first.
            mask_bhwc = torch.ones((max_frames, target_h, target_w, 1), dtype=torch.float32, device=device)
            # Note: invert_mask is NOT applied here, as no mask was input by the user.


        # --- Ensure consistent Channel Counts (RGB) --- 
        # Background should be RGB (remove alpha if present)
        if bg_bhwc.shape[3] == 4:
             print("[WARNING] Background has alpha, removing it.") # Replaced log
             bg_bhwc = bg_bhwc[...,:3]
        elif bg_bhwc.shape[3] == 1: # Grayscale to RGB
             bg_bhwc = bg_bhwc.repeat(1, 1, 1, 3)

        # Layer should be RGB (remove alpha if present)
        if layer_bhwc.shape[3] == 4:
            layer_bhwc = layer_bhwc[..., :3]
        elif layer_bhwc.shape[3] == 1: # Grayscale to RGB
            layer_bhwc = layer_bhwc.repeat(1, 1, 1, 3)
        elif layer_bhwc.shape[3] != 3:
            raise ValueError(f"Layer image must have 1 (grayscale), 3 (RGB), or 4 (RGBA) channels. Got shape: {layer_bhwc.shape}")


        # --- Handle Batch Size Mismatch (using max_frames calculated earlier) ---
        if b_frames < max_frames:
            bg_bhwc = torch.cat([bg_bhwc, bg_bhwc[-1:].repeat(max_frames - b_frames, 1, 1, 1)], dim=0)
        elif b_frames > max_frames: 
             bg_bhwc = bg_bhwc[:max_frames]
             
        if l_frames < max_frames:
            layer_bhwc = torch.cat([layer_bhwc, layer_bhwc[-1:].repeat(max_frames - l_frames, 1, 1, 1)], dim=0)
        elif l_frames > max_frames: 
            layer_bhwc = layer_bhwc[:max_frames]

        # --- Ensure mask batch size matches (redundant check, should be correct) ---
        if mask_bhwc.shape[0] != max_frames:
             print(f"[WARNING] Correcting mask batch size mismatch. Mask: {mask_bhwc.shape[0]}, Target: {max_frames}") # Replaced log
             if mask_bhwc.shape[0] < max_frames:
                 mask_bhwc = torch.cat([mask_bhwc, mask_bhwc[-1:].repeat(max_frames - mask_bhwc.shape[0], 1, 1, 1)], dim=0)
             else:
                 mask_bhwc = mask_bhwc[:max_frames]


        # --- Resize layer and mask if needed (using interpolate) ---
        if bg_bhwc.shape[1:3] != layer_bhwc.shape[1:3]:
            target_h, target_w = bg_bhwc.shape[1:3]
            # Permute layer to BCHW for interpolate
            layer_bchw = layer_bhwc.permute(0, 3, 1, 2)
            layer_bchw_resized = F.interpolate(layer_bchw, size=(target_h, target_w), mode='bilinear', align_corners=False)
            layer_bhwc = layer_bchw_resized.permute(0, 2, 3, 1)

            # Also resize mask (it must exist at this point, either user-provided or default white)
            # Permute mask to BCHW (B, 1, H, W)
            mask_bchw = mask_bhwc.permute(0, 3, 1, 2)
            mask_bchw_resized = F.interpolate(mask_bchw, size=(target_h, target_w), mode='bilinear', align_corners=False)
            mask_bhwc = mask_bchw_resized.permute(0, 2, 3, 1)

        # --- Apply Blending Logic --- 
        blend_mode = blend_mode.lower() # Ensure lowercase
        
        # Default to layer if mode unknown, mimics normal blend before masking
        blended_layer = layer_bhwc 

        if blend_mode == "normal":
             blended_layer = self.blend_normal(bg_bhwc, layer_bhwc) # Essentially returns layer
        elif blend_mode == "multiply":
             blended_layer = self.blend_multiply(bg_bhwc, layer_bhwc)
        elif blend_mode == "screen":
             blended_layer = self.blend_screen(bg_bhwc, layer_bhwc)
        elif blend_mode == "overlay":
             blended_layer = self.blend_overlay(bg_bhwc, layer_bhwc)
        elif blend_mode == "add":
             blended_layer = self.blend_add(bg_bhwc, layer_bhwc)
        elif blend_mode == "subtract":
             blended_layer = self.blend_subtract(bg_bhwc, layer_bhwc)
        elif blend_mode == "difference":
             blended_layer = self.blend_difference(bg_bhwc, layer_bhwc)
        elif blend_mode == "darken":
             blended_layer = self.blend_darken(bg_bhwc, layer_bhwc)
        elif blend_mode == "lighten":
             blended_layer = self.blend_lighten(bg_bhwc, layer_bhwc)
        # --- Add elif conditions for other blend functions here ---
        else:
            print(f"[WARNING] Unsupported blend mode '{blend_mode}'. Using 'normal'.") # Replaced log
            blended_layer = self.blend_normal(bg_bhwc, layer_bhwc)

        # --- Apply Opacity and Mask ---
        opacity_factor = opacity / 100.0
        
        # Combine opacity with mask: effective_mask = mask * opacity
        # mask_bhwc here is either the (potentially inverted) user mask or the default white mask
        effective_mask = mask_bhwc * opacity_factor
        
        # Composite: background * (1 - effective_mask) + blended_layer * effective_mask
        output_bhwc = bg_bhwc * (1.0 - effective_mask) + blended_layer * effective_mask
        
        # Clamp final result
        output_bhwc = torch.clamp(output_bhwc, 0.0, 1.0)        
        # Return tensor on CPU as expected by ComfyUI
        return (output_bhwc.cpu(),)


class CreateImageList:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "export_alpha": ("BOOLEAN", {"default": True})
            },
            "optional": {
                "image1": ("IMAGE",),
                "image_ref": ("IMAGE",),
                "method": (
            [
                'mkl',
                'hm',
                'reinhard',
                'mvgd',
                'hm-mvgd-hm',
                'hm-mkl-hm',
            ], {
               "default": 'mkl'
            }),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.01}),
                "multithread": ("BOOLEAN", {"default": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("images", "masks")
    FUNCTION = "batch"
    CATEGORY = "WanVideoWrapper_QQ/image"
    DESCRIPTION = """
Creates a batch of images from multiple dynamic image inputs.
Optionally applies color matching to all images if image_ref is provided.

Color matching uses the color-matcher library to transfer color characteristics
from a reference image to all batch images. This is useful for maintaining
consistent color grading across multiple images.

Supports alpha channel preservation with export_alpha option.
"""

    def load_image_with_alpha(self, image_path):
        """Load image from path with alpha channel preserved"""
        try:
            img = Image.open(image_path)

            # Handle RGBA images
            if img.mode == 'RGBA':
                img_np = np.array(img).astype(np.float32) / 255.0
                img_tensor = torch.from_numpy(img_np)[None,]  # [1, H, W, 4]
                return img_tensor
            else:
                # Convert to RGB and add alpha=1.0
                img = img.convert('RGB')
                img_np = np.array(img).astype(np.float32) / 255.0
                alpha = np.ones((img_np.shape[0], img_np.shape[1], 1), dtype=np.float32)
                img_rgba = np.concatenate([img_np, alpha], axis=2)
                img_tensor = torch.from_numpy(img_rgba)[None,]  # [1, H, W, 4]
                return img_tensor
        except Exception as e:
            print(f"Error loading image with alpha from {image_path}: {e}")
            return None

    def find_source_image_path(self, prompt, node_id, input_name):
        """Trace connections to find LoadImage node and get the filename"""
        try:
            # Get the current node from prompt
            if str(node_id) not in prompt:
                return None

            current_node = prompt[str(node_id)]
            inputs = current_node.get("inputs", {})

            # Check if the input is connected (array format: [source_node_id, source_output_index])
            if input_name in inputs and isinstance(inputs[input_name], list):
                source_node_id = str(inputs[input_name][0])

                # Recursively trace through connections
                return self._trace_to_load_image(prompt, source_node_id)

            return None
        except Exception as e:
            print(f"Error tracing connections: {e}")
            return None

    def _trace_to_load_image(self, prompt, node_id):
        """Recursively trace back to LoadImage node"""
        try:
            if node_id not in prompt:
                return None

            node = prompt[node_id]
            class_type = node.get("class_type", "")

            # Found LoadImage node!
            if class_type in ["LoadImage", "LoadImageMask"]:
                inputs = node.get("inputs", {})
                if "image" in inputs:
                    filename = inputs["image"]
                    # Get full path
                    input_dir = folder_paths.get_input_directory()
                    image_path = os.path.join(input_dir, filename)
                    if os.path.exists(image_path):
                        print(f"Found LoadImage source: {image_path}")
                        return image_path

            # Not a LoadImage, check its inputs
            inputs = node.get("inputs", {})
            for input_name, input_value in inputs.items():
                if isinstance(input_value, list):
                    source_node_id = str(input_value[0])
                    result = self._trace_to_load_image(prompt, source_node_id)
                    if result:
                        return result

            return None
        except Exception as e:
            print(f"Error in trace: {e}")
            return None

    def apply_color_match(self, images, image_ref, method, strength, multithread):
        """Apply color matching to a batch of images using a reference image"""
        try:
            from color_matcher import ColorMatcher
        except:
            raise Exception("Can't import color-matcher, did you install requirements.txt? Manual install: pip install color-matcher")

        images = images.cpu()
        image_ref = image_ref.cpu()
        batch_size = images.size(0)

        # Handle alpha channel: extract RGB for color matching
        has_alpha = images.shape[-1] == 4
        if has_alpha:
            rgb_images = images[:, :, :, :3]
            alpha_channel = images[:, :, :, 3]
        else:
            rgb_images = images

        # Extract RGB from reference if it has alpha
        if image_ref.shape[-1] == 4:
            image_ref_rgb = image_ref[:, :, :, :3]
        else:
            image_ref_rgb = image_ref

        images_rgb = rgb_images.squeeze()
        images_ref = image_ref_rgb.squeeze()

        image_ref_np = images_ref.numpy()
        images_rgb_np = images_rgb.numpy()

        def process(i):
            cm = ColorMatcher()
            image_rgb_np_i = images_rgb_np if batch_size == 1 else images_rgb[i].numpy()
            image_ref_np_i = image_ref_np if image_ref_rgb.size(0) == 1 else images_ref[i].numpy()
            try:
                image_result = cm.transfer(src=image_rgb_np_i, ref=image_ref_np_i, method=method)
                image_result = image_rgb_np_i + strength * (image_result - image_rgb_np_i)
                return torch.from_numpy(image_result)
            except Exception as e:
                print(f"Color matching thread {i} error: {e}")
                return torch.from_numpy(image_rgb_np_i)  # fallback

        if multithread and batch_size > 1:
            max_threads = min(os.cpu_count() or 1, batch_size)
            with ThreadPoolExecutor(max_workers=max_threads) as executor:
                out = list(executor.map(process, range(batch_size)))
        else:
            out = [process(i) for i in range(batch_size)]

        out = torch.stack(out, dim=0).to(torch.float32)
        out.clamp_(0, 1)

        # Reattach alpha channel if it was present
        if has_alpha:
            out = torch.cat([out, alpha_channel.unsqueeze(-1)], dim=-1)

        return out

    def batch(self, export_alpha, unique_id=None, prompt=None, image_ref=None, method='mkl', strength=1.0, multithread=True, **kwargs):
        # Collect all image inputs from kwargs (dynamic inputs)
        images = []

        # Sort by key to maintain order (image1, image2, image3, etc.)
        sorted_inputs = sorted(kwargs.items(), key=lambda x: x[0])

        for input_name, img in sorted_inputs:
            if img is not None:
                # Try to reload with alpha if tracing is available
                if prompt and unique_id:
                    path = self.find_source_image_path(prompt, unique_id, input_name)
                    if path:
                        reloaded = self.load_image_with_alpha(path)
                        if reloaded is not None:
                            print(f"Reloaded {input_name} with alpha: {path}")
                            img = reloaded

                images.append(img)

        # If no images provided, return empty tensors
        if len(images) == 0:
            empty_image = torch.zeros((1, 64, 64, 3 if not export_alpha else 4))
            empty_mask = torch.zeros((1, 64, 64))
            return (empty_image, empty_mask)

        # If only one image, just process it
        if len(images) == 1:
            img = images[0]
            # Ensure alpha channel exists
            if img.shape[-1] == 3:
                img = torch.nn.functional.pad(img, (0, 1), mode='constant', value=1.0)

            # Apply color matching if image_ref is provided
            if image_ref is not None:
                img = self.apply_color_match(img, image_ref, method, strength, multithread)

            # Extract masks
            masks = img[:, :, :, 3]

            # Conditionally strip alpha
            if export_alpha:
                output_images = img
            else:
                output_images = img[:, :, :, :3]

            return (output_images, masks)

        # Multiple images: pad channels and find max dimension
        processed_images = []
        for img in images:
            # Pad channels if needed - always ensure we have alpha channel
            if img.shape[-1] == 3:
                img = torch.nn.functional.pad(img, (0, 1), mode='constant', value=1.0)
            processed_images.append(img)

        # Find the largest dimension across all images to create square canvas
        max_dim = max(img.shape[1] for img in processed_images)
        max_dim = max(max_dim, max(img.shape[2] for img in processed_images))

        # Process each image to fit in square canvas
        def fit_to_square(img, canvas_size):
            h, w, c = img.shape[1], img.shape[2], img.shape[3]

            # If already square and correct size, return as-is
            if h == canvas_size and w == canvas_size:
                return img

            # Scale to fit (preserve aspect ratio)
            scale = canvas_size / max(h, w)
            new_h = int(h * scale)
            new_w = int(w * scale)

            # Resize (this will scale both RGB and alpha channels)
            img_bchw = img.permute(0, 3, 1, 2)
            scaled = F.interpolate(img_bchw, size=(new_h, new_w), mode='bilinear', align_corners=False)
            scaled = scaled.permute(0, 2, 3, 1)

            # Create square canvas and center the image
            canvas = torch.zeros((img.shape[0], canvas_size, canvas_size, c), dtype=img.dtype, device=img.device)
            y_offset = (canvas_size - new_h) // 2
            x_offset = (canvas_size - new_w) // 2

            # Copy entire scaled image (including its alpha) to canvas
            canvas[:, y_offset:y_offset+new_h, x_offset:x_offset+new_w, :] = scaled

            return canvas

        fitted_images = [fit_to_square(img, max_dim) for img in processed_images]

        # Concatenate all images
        s = torch.cat(fitted_images, dim=0)

        # Apply color matching if image_ref is provided
        if image_ref is not None:
            s = self.apply_color_match(s, image_ref, method, strength, multithread)

        # Extract alpha channel as masks (MASK format is BHW, not BHWC)
        masks = s[:, :, :, 3]  # Shape: [B, H, W]

        # Conditionally strip alpha channel from image output
        if export_alpha:
            output_images = s  # Keep RGBA (4 channels)
        else:
            output_images = s[:, :, :, :3]  # Strip alpha, output RGB (3 channels)

        return (output_images, masks)
class ImageRadialZoomBlur_GPU:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE",), # ComfyUI tensor [B, H, W, C], float [0, 1]
                "strength": ("FLOAT", {
                    "default": 50.0,
                    "min": 0.0,
                    "max": 200.0,
                    "step": 0.1,
                    "display": "slider"
                }),
                "center_x": ("FLOAT", {
                    "default": 0.5,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display": "slider"
                }),
                "center_y": ("FLOAT", {
                    "default": 0.5,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display": "slider"
                }),
                "num_samples": ("INT", {
                    "default": 30,
                    "min": 1,
                    "max": 256, # Keep max reasonable, but higher is possible with more VRAM
                    "step": 1,
                    "display": "number"
                }),
                "frames": ("INT", {
                    "default": 1,
                    "min": 1,
                    "max": 1000,
                    "step": 1,
                    "display": "number"
                }),
                "offset_x": ("FLOAT", {
                    "default": 0.0,
                    "min": -1.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display": "slider"
                }),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "apply_radial_zoom_blur_gpu"
    CATEGORY = "WanVideoWrapper_QQ/image" # Categorize the node

    def apply_radial_zoom_blur_gpu(self, image, strength, center_x, center_y, num_samples, frames=1, offset_x=0.0):
        # If frames == 1, behave as before
        if frames == 1:
            processed_images = []
            for single_image in image:
                processed_images.append(self._apply_single_image(single_image.unsqueeze(0), strength, center_x, center_y, num_samples))
            return (torch.cat(processed_images, dim=0),)
        
        # If frames > 1, output a list of frames with center_x offset and bounce
        batch_results = []
        for single_image in image:
            frame_images = []
            cx = center_x
            direction = 1 if offset_x >= 0 else -1
            for i in range(frames):
                frame_images.append(self._apply_single_image(single_image.unsqueeze(0), strength, cx, center_y, num_samples))
                # Update center_x for next frame
                cx += offset_x * direction
                # Bounce logic: if cx goes outside [0, 1], flip direction and clamp
                if cx > 1.0:
                    cx = 1.0 - (cx - 1.0)
                    direction *= -1
                elif cx < 0.0:
                    cx = -cx
                    direction *= -1
            # Concatenate frames for this image along batch dim
            frame_images_cat = torch.cat(frame_images, dim=0) # [frames, H, W, C]
            batch_results.append(frame_images_cat)
        # Concatenate all images in batch (if input batch > 1)
        result = torch.cat(batch_results, dim=0) # [(batch*frames), H, W, C]
        return (result,)


    def _apply_single_image(self, image_bhwc, strength, center_x, center_y, num_samples):
        """
        Applies the radial zoom blur to a single image tensor [1, H, W, C].
        """
        # ComfyUI image tensor is [B, H, W, C], float [0, 1]
        # Move to CUDA device if available
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        img_tensor = image_bhwc.to(device)

        # Permute to [B, C, H, W] for torch.nn.functional functions like grid_sample
        img_bchw = img_tensor.permute(0, 3, 1, 2)
        b, c, h, w = img_bchw.shape # b should be 1 here after batch processing loop

        # Handle edge cases: strength 0 or num_samples <= 1 mean no blur
        if strength <= 0 or num_samples <= 1:
             # Return original image tensor on original device
             return image_bhwc.to(image_bhwc.device)

        # Calculate center in pixel coordinates (0-indexed)
        # Center coordinate should be center_x * (width-1) and center_y * (height-1)
        cx = center_x * (w - 1.0)
        cy = center_y * (h - 1.0)
        center_pos = torch.tensor([cx, cy], device=device, dtype=img_bchw.dtype)


        # --- Generate Sampling Grid ---

        # Create a grid of output pixel coordinates (x, y) for the target locations [H, W, 2]
        # The grid shape [H, W] must match the output image dimensions.
        # The coordinates in the grid must be [x, y] where x is column index, y is row index.

        y_coords = torch.arange(h, device=device, dtype=img_bchw.dtype) # 0 to h-1 (rows)
        x_coords = torch.arange(w, device=device, dtype=img_bchw.dtype) # 0 to w-1 (columns)

        # Use indexing='ij' (matrix indexing) which gives grids of shape (len(y), len(x)) = (H, W)
        # grid_y will vary along the first dimension (rows, H)
        # grid_x will vary along the second dimension (columns, W)
        grid_y, grid_x = torch.meshgrid(y_coords, x_coords, indexing='ij')

        # Stack as [H, W, 2] where the last dimension is [x, y] for each pixel at (h, w)
        # out_coords[h, w] should be [w, h] (pixel coordinates)
        out_coords = torch.stack([grid_x, grid_y], dim=-1) # Shape [H, W, 2]. out_coords[h, w] = [x, y]


        # Calculate vectors FROM center TO each output pixel
        # out_coords [H, W, 2], center_pos [2] - broadcasting works
        vecs_to_pixel = out_coords - center_pos # Shape [H, W, 2]

        # Calculate distance from center to each output pixel
        dists_to_center = torch.linalg.norm(vecs_to_pixel, dim=-1, keepdim=True) # Shape [H, W, 1]

        # Calculate unit vectors from center to each output pixel
        # Add a small epsilon to avoid division by zero exactly at the center
        epsilon = 1e-6
        unit_vecs_to_pixel = torch.where(
            dists_to_center < epsilon,
            torch.zeros_like(vecs_to_pixel),
            vecs_to_pixel / dists_to_center
        ) # Shape [H, W, 2]


        # Calculate the length of the line segment to sample along for each pixel
        # This scales with distance from center and the input strength
        # Strength 100 samples up to the distance from center
        # Lengths are relative to the pixel's distance from the center
        sample_line_lengths = dists_to_center * (strength / 100.0) # Shape [H, W, 1]

        # Generate steps from 0 to 1 (inclusive) for sampling along the line segment
        # num_samples points means num_samples-1 steps of equal size
        # The first sample is at the current pixel (t=0), the last is t=1 * length
        steps = torch.linspace(0, 1, num_samples, device=device, dtype=img_bchw.dtype) # Shape [num_samples]

        # Calculate the offset vectors for each sample point, for each output pixel.
        # offset = t * length * unit_vec (where unit_vec points from center to pixel)
        # sample_point = current_pixel_pos - offset
        # Need to broadcast shapes:
        # steps [num_samples] -> [num_samples, 1, 1, 1]
        # sample_line_lengths [H, W, 1] -> [1, H, W, 1]
        # unit_vecs_to_pixel [H, W, 2] -> [1, H, W, 2]
        # Resulting offset_vectors shape: [num_samples, H, W, 2]
        offset_vectors = steps.view(num_samples, 1, 1, 1) * sample_line_lengths.view(1, h, w, 1) * unit_vecs_to_pixel.view(1, h, w, 2)


        # Calculate the actual sample points in pixel coordinates
        # sample_points_pixel = current_pixel_pos - offset_vectors
        # current_pixel_pos [H, W, 2] -> [1, H, W, 2] for broadcasting
        sample_points_pixel = out_coords.unsqueeze(0) - offset_vectors # Shape [num_samples, H, W, 2]


        # --- Prepare for grid_sample ---
        # Use num_samples as the batch dimension for grid_sample

        # Input image for grid_sample: Repeat the original image num_samples times
        # Input shape required by grid_sample: [N, C, H_in, W_in] -> [num_samples, C, H, W]
        img_input_for_grid = img_bchw.repeat(num_samples, 1, 1, 1) # Shape [num_samples, C, H, W]


        # Grid for grid_sample: This is our calculated sample_points_pixel, reshaped
        # The grid must have shape [N, H_out, W_out, 2]
        # Our sample_points_pixel is [num_samples, H, W, 2]. This fits if N = num_samples, H_out = H, W_out = W.
        # The last dimension is already [x, y] as required.
        grid_pixel_coords = sample_points_pixel # Shape is [num_samples, H, W, 2]


        # Normalize pixel coordinates [-1, 1] for grid_sample
        # grid_sample maps [-1, 1] to the corners (0,0) and (W-1, H-1) with align_corners=True
        # Normalization: pixel_coord -> (pixel_coord / (dim - 1)) * 2 - 1
        # Need to handle W=1 or H=1 case to avoid division by zero by (dim-1)
        # Use max(dim - 1.0, 1e-6) for safety.
        norm_x_factor = 2.0 / max(w - 1.0, 1e-6)
        norm_y_factor = 2.0 / max(h - 1.0, 1e-6)

        # Apply normalization to the x and y coordinates in the grid
        grid_x_norm = (grid_pixel_coords[..., 0] * norm_x_factor) - 1.0
        grid_y_norm = (grid_pixel_coords[..., 1] * norm_y_factor) - 1.0
        grid_normalized = torch.stack([grid_x_norm, grid_y_norm], dim=-1) # Shape [num_samples, H, W, 2]


        # Perform grid sampling
        # input: [num_samples, C, H, W]
        # grid: [num_samples, H, W, 2]
        # Output shape: [num_samples, C, H, W] (sampled values for each sample point for each output pixel)
        sampled_values = F.grid_sample(
            img_input_for_grid,
            grid_normalized,
            mode='bilinear',
            padding_mode='border', # Use border to avoid black edges when sampling near edges
            align_corners=True # This is important for correct mapping between pixel coords and [-1, 1] grid
        ) # Output shape [num_samples, C, H, W]

        # Average the sampled values for each output pixel
        # Average along the num_samples dimension (dim 0)
        output_chw = torch.mean(sampled_values, dim=0) # Shape [C, H, W]

        # Reshape back to image dimensions [1, H, W, C] for ComfyUI
        output_hwc = output_chw.permute(1, 2, 0) # Shape [H, W, C]
        output_bhwc = output_hwc.unsqueeze(0) # Shape [1, H, W, C]

        # Clamp to ensure valid pixel values (0-1 range)
        output_bhwc = torch.clamp(output_bhwc, 0.0, 1.0)

        # ComfyUI requires CPU tensor output for saving etc.
        return output_bhwc.cpu()

class WanScaleAB:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_A": ("IMAGE",),
                "A2size": ("INT", {"default": 512, "min": 64, "max": 2048, "step": 16}),
                "A1scale": ("FLOAT", {"default": 0.5, "min": 0.1, "max": 2.0, "step": 0.1}),
                "scaling_method": (["area","lanczos","bilinear", "bicubic" ,"nearest" ], {"default": "area"}),
                "match_to": (["A_crop", "A_stretch", "B_crop", "B_stretch",], {"default": "A_crop"}),
            },
            "optional": {
                "image_B": ("IMAGE",),
            }
        }
    
    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "IMAGE")
    RETURN_NAMES = ("image_A1", "image_A2", "image_B1", "image_B2")
    FUNCTION = "scale_images"
    CATEGORY = "WanVideoWrapper_QQ/image"
    
    def scale_images(self, image_A, A2size, A1scale, scaling_method, match_to, image_B=None):
        # If B_stretch is selected and image_B is present, use modular approach
        if image_B is not None and match_to == "B_stretch":
            # Step 1: Calculate image_B2 and image_B1 dimensions using image_A's methods
            b_s1, b_s2 = self._calculate_s1_s2(image_B, A2size)
            
            # Get image_B dimensions for aspect ratio
            _, b_h, b_w, _ = image_B.shape
            
            # Calculate image_B1 dimensions as scaled version of B2
            # Special case: when A1scale=1.0, B1 should match B2 dimensions exactly
            if abs(A1scale - 1.0) < 1e-6:
                b_target_h = b_s1
                b_target_w = b_s2
            else:
                b_target_h = self._round_up_to_multiple(b_s1 * A1scale, 16)
                b_target_w = self._round_up_to_multiple(b_s2 * A1scale, 16)
            
            # Step 2: Now reverse the process - use these dimensions for image_A
            # Calculate image_A2 and image_A1 using image_B's calculated dimensions
            image_A2 = self._scale_image(image_A, b_s1, b_s2, scaling_method)
            image_A1 = self._scale_image(image_A, int(b_target_h), int(b_target_w), scaling_method)
            
            # Step 3: Create image_B outputs using the calculated dimensions
            image_B2 = self._scale_image(image_B, b_s1, b_s2, scaling_method)
            image_B1 = self._scale_image(image_B, int(b_target_h), int(b_target_w), scaling_method)
        elif image_B is not None and match_to == "B_crop":
            # B_crop should work like B_stretch for dimension calculations but use cropping
            # Step 1: Calculate image_B2 and image_B1 dimensions using image_B's methods (like B_stretch)
            b_s1, b_s2 = self._calculate_s1_s2(image_B, A2size)

            # Step 2: Scale and crop image_A to match image_B2's dimensions (reversed from A_crop)
            image_A2 = self._scale_and_crop_to_match(image_A, b_s1, b_s2, scaling_method)

            # Step 3: Calculate image_B1 dimensions as scaled version of B2
            if abs(A1scale - 1.0) < 1e-6:
                b_target_h = b_s1
                b_target_w = b_s2
            else:
                b_target_h = self._round_up_to_multiple(b_s1 * A1scale, 16)
                b_target_w = self._round_up_to_multiple(b_s2 * A1scale, 16)

            # Step 4: Scale image_B to preserve aspect ratio while fitting within target dimensions
            image_B1 = self._scale_and_crop_to_match(image_B, int(b_target_h), int(b_target_w), scaling_method)
            image_B2 = self._scale_image(image_B, b_s1, b_s2, scaling_method)

            # Step 5: Scale image_A1 to preserve aspect ratio while fitting within B1 dimensions
            # This ensures image_A is cropped to match image_B's calculated dimensions
            image_A1 = self._scale_and_crop_to_match(image_A, int(b_target_h), int(b_target_w), scaling_method)
        else:
            # Original logic for other match_to options (A_crop, A_stretch, etc.)
            # Calculate s1 and s2 for image_A2
            s1, s2 = self._calculate_s1_s2(image_A, A2size)

            # Get original dimensions of image_A
            _, h, w, _ = image_A.shape

            # Process image_A1 as a direct scaled version of A2 (s1, s2)
            # Special case: when A1scale=1.0, A1 should match A2 dimensions exactly
            if abs(A1scale - 1.0) < 1e-6:
                target_height = s1
                target_width = s2
            else:
                target_height = self._round_up_to_multiple(s1 * A1scale, 16)
                target_width = self._round_up_to_multiple(s2 * A1scale, 16)

            # Scale image_A1 and image_A2
            image_A1 = self._scale_image(image_A, int(target_height), int(target_width), scaling_method)
            image_A2 = self._scale_image(image_A, s1, s2, scaling_method)

            # Process image_B based on match_to option
            if image_B is not None:
                if match_to == "A_stretch":
                    # Scale image_B to match image_A2 and image_A1 sizes
                    image_B1 = self._scale_image(image_B, int(target_height), int(target_width), scaling_method)
                    image_B2 = self._scale_image(image_B, s1, s2, scaling_method)
                elif match_to == "A_crop":
                    # Scale and crop image_B to match image_A2 dimensions
                    image_B2 = self._scale_and_crop_to_match(image_B, s1, s2, scaling_method)
                    # Scale image_B1 to preserve aspect ratio while fitting within A1 dimensions
                    # This prevents stretching when image_A and image_B have different aspect ratios
                    image_B1 = self._scale_and_crop_to_match(image_B, int(target_height), int(target_width), scaling_method)
                else:
                    # Default behavior for other match_to options
                    # Get original dimensions
                    _, h, w, _ = image_B.shape
                    # Calculate new dimensions based on scale
                    new_h = int(h * A1scale)
                    new_w = int(w * A1scale)
                    image_B1 = self._scale_image(image_B, new_h, new_w, scaling_method)
                    image_B2 = self._scale_image(image_B, new_h, new_w, scaling_method)
            else:
                # Return empty tensors if image_B is not provided
                image_B1 = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
                image_B2 = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
        
        return (image_A1, image_A2, image_B1, image_B2)
    
    def _calculate_s1_s2(self, image_A, A2size):
        """
        Calculate s1 and s2 based on the special scaling rules.

        s1: Target the largest side to be approximately A2size (rounded up to a multiple of 16),
            regardless of how many times A2size fits into the original largest side. This ensures
            A2size is respected as the intended output size for the larger dimension.
        s2: Proportionally scale the smallest side to match s1, then adjust to be divisible by 16 (rounding up)
        """
        # Get original dimensions
        _, h, w, _ = image_A.shape
        
        # Determine which is the largest and smallest side
        if h >= w:
            largest_side = h
            smallest_side = w
        else:
            largest_side = w
            smallest_side = h
        
        # Step 1: Compute s1 so that the output's largest side is ~A2size
        # Round A2size up to the nearest multiple of 16 to satisfy model constraints
        s1 = self._round_up_to_multiple(A2size, 16)

        # Step 2: Find s2
        # Calculate the proportional scaling factor
        scale_factor = s1 / largest_side
        
        # Apply this scaling to the smallest side
        scaled_smallest = smallest_side * scale_factor
        
        # Find s2 as the closest multiple of 16 (rounding up)
        s2 = self._round_up_to_multiple(scaled_smallest, 16)
        
        # Determine the final dimensions based on original orientation
        if h >= w:
            # Height was the largest side
            return s1, s2
        else:
            # Width was the largest side
            return s2, s1
    
    def _round_up_to_multiple(self, value, multiple):
        """Round up value to the nearest multiple of 'multiple'."""
        import math
        return int(math.ceil(value / multiple) * multiple)
    
    
    def _scale_and_crop_to_match(self, image, target_h, target_w, method):
        """
        Scale image proportionally to match the largest side of target dimensions,
        then crop from center to exactly match target dimensions.
        """
        # Get original dimensions
        _, h, w, _ = image.shape
        
        # Determine which dimension to match
        if target_h >= target_w:
            # Target height is larger, match height
            scale_factor = target_h / h
            scaled_h = target_h
            scaled_w = int(w * scale_factor)
        else:
            # Target width is larger, match width
            scale_factor = target_w / w
            scaled_h = int(h * scale_factor)
            scaled_w = target_w
        
        # Scale the image
        scaled_image = self._scale_image(image, scaled_h, scaled_w, method)
        
        # Calculate crop amounts to center the image
        if scaled_h > target_h:
            # Need to crop height
            crop_h = (scaled_h - target_h) // 2
            cropped_image = scaled_image[:, crop_h:crop_h+target_h, :, :]
        else:
            # No height cropping needed
            cropped_image = scaled_image
        
        if scaled_w > target_w:
            # Need to crop width
            crop_w = (scaled_w - target_w) // 2
            cropped_image = cropped_image[:, :, crop_w:crop_w+target_w, :]
        
        # Ensure the final dimensions match exactly
        final_h, final_w = cropped_image.shape[1], cropped_image.shape[2]
        if final_h != target_h or final_w != target_w:
            # If dimensions still don't match, force resize
            cropped_image = self._scale_image(cropped_image, target_h, target_w, method)
        
        return cropped_image
    
    def _scale_image(self, image, height, width, method):
        """Helper function to scale an image to the specified dimensions."""
        # Convert from BHWC to BCHW for F.interpolate
        image_bchw = image.permute(0, 3, 1, 2)
        
        # Determine interpolation mode based on method string
        if method == "bilinear":
            mode = 'bilinear'
            align_corners = False
        elif method == "nearest":
            mode = 'nearest'
            align_corners = None
        elif method == "bicubic":
            mode = 'bicubic'
            align_corners = False
        elif method == "area":
            mode = 'area'
            align_corners = None
        elif method == "lanczos":
            # PyTorch doesn't have lanczos, use bicubic as approximation
            mode = 'bicubic'
            align_corners = False
        else:
            # Default to bilinear
            mode = 'bilinear'
            align_corners = False
        
        # Perform interpolation
        if align_corners is not None:
            resized = F.interpolate(image_bchw, size=(height, width), mode=mode, align_corners=align_corners)
        else:
            resized = F.interpolate(image_bchw, size=(height, width), mode=mode)
        
        # Convert back to BHWC
        return resized.permute(0, 2, 3, 1)

NODE_CLASS_MAPPINGS = {
    "CreateImageList": CreateImageList,
    "ImageRadialZoomBlur_GPU": ImageRadialZoomBlur_GPU,
    "ImageBlend_GPU": ImageBlend_GPU,
    "WanScaleAB": WanScaleAB
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "CreateImageList": "Create Image List",
    "ImageRadialZoomBlur_GPU": "Image Radial Zoom Blur (GPU)",
    "ImageBlend_GPU": "Image Blend (GPU)",
    "WanScaleAB": "Wan Scale AB"
}
