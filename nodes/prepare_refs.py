import json
import torch
import torch.nn.functional as F
from torchvision import transforms
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter
import cv2


class PrepareRefs:
    """
    Canvas-enabled node for preparing background/ref images with drawn shapes.
    Exports ref images with lasso shapes as masks.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask_width": ("INT", {"default": 640, "min": 8, "max": 4096, "step": 8}),
                "mask_height": ("INT", {"default": 480, "min": 8, "max": 4096, "step": 8}),
            },
            "optional": {
                "bg_image": ("IMAGE", {"forceInput": True}),
                "export_alpha": ("BOOLEAN", {"default": True}),
                "to_bounding_box": ("BOOLEAN", {"default": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
            }
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "MASK", "PREPAREREFS")
    RETURN_NAMES = ("bg_image", "ref_images", "ref_masks", "prepare_refs_data")
    FUNCTION = "prepare"
    CATEGORY = "WanVideoWrapper_QQ"
    DESCRIPTION = """
    Canvas node for prepping background/reference images.
    Can export ref images with lasso shapes as masks.
    """

    def prepare(self, mask_width, mask_height, bg_image=None, export_alpha=True, to_bounding_box=True, unique_id=None, prompt=None):
        # Determine the final output width and height
        # If bg_image is provided, use its dimensions. Otherwise, use mask_width/height as fallback.
        final_width = int(mask_width)
        final_height = int(mask_height)

        output_bg_image = None
        internal_processing_image = None

        if bg_image is not None:
            final_height = bg_image.shape[1]
            final_width = bg_image.shape[2]
            output_bg_image = bg_image
            internal_processing_image = bg_image
        else:
            output_bg_image = torch.zeros((1, final_height, final_width, 3), dtype=torch.float32)
            internal_processing_image = output_bg_image

        # Use final_width and final_height consistently
        width = final_width
        height = final_height

        ref_layer_data = None
        if prompt and unique_id and str(unique_id) in prompt:
            node_data = prompt[str(unique_id)]
            inputs = node_data.get("inputs", {})
            # The ref_layer_data should be in the inputs from the serialized widget
            if "ref_layer_data" in inputs:
                raw_data = inputs["ref_layer_data"]

                # Handle the case where ref_layer_data might be a dict or list
                if isinstance(raw_data, list):
                    ref_layer_data = raw_data
                elif isinstance(raw_data, dict):
                    # If it's a dict, it might contain the data in a nested structure
                    # Try to extract the actual ref layer data from the dict
                    if '__value__' in raw_data and isinstance(raw_data['__value__'], list):
                        ref_layer_data = raw_data['__value__']
                    elif 'value' in raw_data and isinstance(raw_data['value'], list):
                        ref_layer_data = raw_data['value']
                    elif 'value' in raw_data:
                        # If value isn't a list, check if it's the data itself
                        if isinstance(raw_data['value'], (list, tuple)):
                            ref_layer_data = list(raw_data['value'])
                        else:
                            ref_layer_data = [raw_data['value']] if raw_data['value'] else []
                    else:
                        # If not in 'value' or '__value__' key, check if the dict itself contains the list
                        # This might happen if the widget serialization works differently
                        ref_layer_data = [raw_data]  # Wrap in list if it's a single dict item

        # Create ref images and masks from lasso shapes
        ref_images, ref_masks = self._extract_lasso_shapes_as_images(
            internal_processing_image, width, height, ref_layer_data, export_alpha, unique_id, prompt)
        
        # Combined masks
        if ref_masks is not None and ref_masks.shape[0] > 0 and to_bounding_box:
            self._process_combined_mask_before_crop(ref_masks, output_bg_image)

        # If no ref images from lasso shapes, use empty tensor
        if ref_images is None or ref_images.shape[0] == 0:
            # Create a single empty image/mask if no shapes exist
            if export_alpha:
                ref_images = torch.zeros((1, height, width, 4), dtype=torch.float32)
            else:
                ref_images = torch.zeros((1, height, width, 3), dtype=torch.float32)
            ref_masks = torch.zeros((1, height, width), dtype=torch.float32)
        
        # --- NEW LOGIC START (Mask Combining and Inpainting at Original Dims) ---
        # Combine all reference masks (at original dimensions) into a single mask for inpainting the background
        combined_original_dims_mask = None
        if ref_masks.shape[0] > 0:
            combined_original_dims_mask = torch.max(ref_masks, dim=0)[0]
        else:
            combined_original_dims_mask = torch.zeros((height, width), dtype=torch.float32, device=output_bg_image.device)
        
        # Store the original combined mask for later use after cropping
        original_combined_mask = combined_original_dims_mask.clone() if combined_original_dims_mask is not None else None
        
        # Apply inpainting to the output_bg_image if a combined mask exists and has active areas
        if torch.any(combined_original_dims_mask > 0.01):
            output_bg_image = self._inpaint_background_torch(output_bg_image, combined_original_dims_mask)
        # --- NEW LOGIC END ---

        # Initialize max_dim for potential use in padding later, ensuring it's always defined.
        # This will be overridden if to_bounding_box is true and ref_images are present.
        max_dim = max(width, height)

        # Now proceed with to_bounding_box logic for ref_images and ref_masks outputs
        if ref_images.shape[0] > 0 and to_bounding_box: # Only apply if there are actual ref_images and to_bounding_box is true
            # Find the largest bounding box among all images using their masks
            max_dim = 0 # Reset to calculate based on bounding boxes
            all_bboxes = []
            
            for i in range(ref_images.shape[0]):
                image_tensor = ref_images[i]
                mask_tensor = ref_masks[i]
                bbox = self._find_bounding_box(image_tensor, mask_tensor=mask_tensor)
                all_bboxes.append(bbox)
                
                # Calculate the dimensions of this bounding box
                bbox_width = bbox[2] - bbox[0] + 1
                bbox_height = bbox[3] - bbox[1] + 1
                max_dim = max(max_dim, bbox_width, bbox_height)
                
            
            # Create square images for each reference image
            square_images = []
            square_masks = []
            
            for i in range(ref_images.shape[0]):
                image_tensor = ref_images[i]
                mask_tensor = ref_masks[i]
                bbox = all_bboxes[i]
                
                # Create a square canvas
                channels = 4 if export_alpha else 3
                square_canvas = self._create_square_canvas(max_dim, channels)
                
                # Place the image content in the square canvas
                square_image = self._place_image_in_square(image_tensor, square_canvas, bbox, has_alpha=export_alpha)
                square_images.append(square_image)
                
                # Create a corresponding mask for the square image
                square_mask = torch.zeros((max_dim, max_dim), dtype=torch.float32)
                
                # Calculate the position where the image was placed
                bbox_width = bbox[2] - bbox[0] + 1
                bbox_height = bbox[3] - bbox[1] + 1
                offset_x = (max_dim - bbox_width) // 2
                offset_y = (max_dim - bbox_height) // 2
                end_x = offset_x + bbox_width
                end_y = offset_y + bbox_height
                
                # Copy the mask content to the square mask
                # Extract only the visible part of the mask based on the bounding box
                visible_mask = mask_tensor[bbox[1]:bbox[3]+1, bbox[0]:bbox[2]+1]
                square_mask[offset_y:end_y, offset_x:end_x] = visible_mask
                square_masks.append(square_mask)
            
            # Replace the original ref_images and ref_masks with the square versions
            ref_images = torch.stack(square_images, dim=0)
            ref_masks = torch.stack(square_masks, dim=0)
        
        # The batch size adjustment logic follows, unchanged.
        # This part still ensures ref_images/ref_masks align with internal_processing_image's batch size
        # (which is 1) for downstream compatibility.
        ref_batch_size = ref_images.shape[0]
        base_batch_size = internal_processing_image.shape[0] # Use internal_processing_image

        # We explicitly do NOT pad internal_processing_image based on ref_batch_size,
        # as the user wants the output bg_image to be singular.
        # If internal_processing_image needs to be batched for other purposes,
        # it should be handled internally or by subsequent nodes.

        if base_batch_size > ref_batch_size:
            # If there are more internal_processing_image items than ref_images,
            # pad the ref_images batch with empty images.
            extra_count = base_batch_size - ref_batch_size
            extra_channels = ref_images.shape[-1]
            extra_images = torch.zeros((extra_count, max_dim, max_dim, extra_channels),
                                       dtype=ref_images.dtype, device=ref_images.device)
            ref_images = torch.cat([ref_images, extra_images], dim=0)

            extra_masks = torch.zeros((extra_count, max_dim, max_dim),
                                      dtype=ref_masks.dtype, device=ref_masks.device)
            ref_masks = torch.cat([ref_masks, extra_masks], dim=0)

        # Note: We don't need to recombine masks here since we already applied inpainting before cropping
        # The masks have been cropped to bounding boxes, so they're no longer at the original dimensions
        # We'll use the original_combined_mask that was saved before cropping

        ui_out = {
            "bg_image_dims": [{"width": float(width), "height": float(height)}],
        }

        # Persist preview to disk so the frontend can pull it without bloating UI payloads
        if bg_image is not None:
            try:
                self._save_bg_preview(bg_image)
                ui_out["bg_image_path"] = ["bg/bg_image.png"]
            except Exception as exc:  # pragma: no cover - UI helper
                print(f"PrepareRefs: failed to save bg preview: {exc}")

        # Return the ref layer data as well for the export node
        # Use our extracted ref_layer_data which is already properly formatted

        return {"ui": ui_out, "result": (output_bg_image, ref_images, ref_masks, ref_layer_data or [])}

    def _to_image_tensor(self, image, width, height):
        if image is not None:
            # Ensure image has proper dimensions
            if image.shape[1] != height or image.shape[2] != width:
                # Resize image to match specified dimensions
                img_bchw = image.permute(0, 3, 1, 2)  # [B, C, H, W]
                resized_bchw = F.interpolate(img_bchw, size=(height, width), mode='bilinear', align_corners=False)
                image = resized_bchw.permute(0, 2, 3, 1)  # [B, H, W, C]
            return image
        return torch.zeros((1, height, width, 3), dtype=torch.float32)
    
    def _process_combined_mask_before_crop(self, ref_masks, bg_image=None):
        """
        Called right after masks are created, but BEFORE bounding-box cropping/squaring.
        At this point all masks are still full-size (width x height) and perfectly aligned.
        
        Use this for:
        - Previewing the union of all refs
        - Running extra logic on combined mask
        - Saving a "total reference mask" for debugging
        - Applying the combined mask to bg_image using cv2
        """
        if ref_masks.shape[0] == 0:
            return
        
        # Combine all masks (union)
        combined_mask = torch.clamp(torch.sum(ref_masks, dim=0), 0, 1)  # or torch.max()
        
        # Example: Save preview of combined mask
        mask_pil = transforms.ToPILImage()(combined_mask.cpu())
        mask_pil = mask_pil.convert("RGB")
        save_path = Path(__file__).parent.parent / "web" / "power_spline_editor" / "bg" / "combined_ref_mask.png"
        save_path.parent.mkdir(parents=True, exist_ok=True)
        mask_pil.save(save_path)
        
        # Apply the combined mask to bg_image using cv2
        # Get the bg_image path
        bg_image_path = Path(__file__).parent.parent / "web" / "power_spline_editor" / "bg" / "bg_image.png"
        
        # Check if bg_image exists
        if bg_image_path.exists():
            # Load the bg_image
            bg_image_cv2 = cv2.imread(str(bg_image_path))
            if bg_image_cv2 is not None:
                # Convert mask to numpy for cv2
                mask_np = (combined_mask.cpu().numpy() * 255).astype(np.uint8)
                
                # Resize mask if it doesn't match bg_image dimensions
                if mask_np.shape != (bg_image_cv2.shape[0], bg_image_cv2.shape[1]):
                    mask_np = cv2.resize(mask_np, (bg_image_cv2.shape[1], bg_image_cv2.shape[0]))
                
                # Apply the mask to create a masked version of bg_image
                # Convert mask to 3-channel for proper masking
                mask_3ch = cv2.cvtColor(mask_np, cv2.COLOR_GRAY2BGR)
                masked_bg_image = cv2.bitwise_and(bg_image_cv2, mask_3ch)
                
                # Save the masked bg_image
                masked_bg_path = Path(__file__).parent.parent / "web" / "power_spline_editor" / "bg" / "bg_image_masked.png"
                cv2.imwrite(str(masked_bg_path), masked_bg_image)
        
        # Return it if downstream nodes want it
        return combined_mask

    def _extract_lasso_shapes_as_images(self, base_image, width, height, ref_layer_data, export_alpha, unique_id=None, prompt=None):
        """
        Extract lasso shapes from the frontend and convert them to image tensors with masks.
        This method processes the serialized ref layer data containing the lasso shapes.
        """
        # Process the ref layer data to create images with masks
        if not ref_layer_data or not isinstance(ref_layer_data, list):
            return None, None

        # Filter out layers that don't have shapes (empty additivePaths)
        layers_with_shapes = []
        for layer_data in ref_layer_data:
            if isinstance(layer_data, dict) and layer_data.get('on', False):
                lasso_shape = layer_data.get('lassoShape', {})
                additive_paths = lasso_shape.get('additivePaths', [])
                if additive_paths and len(additive_paths) > 0:
                    # This layer has shapes, add it to our list
                    layers_with_shapes.append(layer_data)

        if not layers_with_shapes:
            # No layers with shapes found
            return None, None

        # Create images and masks for each layer with shapes
        images = []
        masks = []

        for layer_data in layers_with_shapes:
            # Create an image with the shape filled in
            image, mask = self._create_image_from_lasso_shape(base_image, layer_data, width, height, export_alpha)
            if image is not None and mask is not None:
                images.append(image)
                masks.append(mask)

        if not images:
            return None, None

        # Stack all images and masks into tensors
        images_tensor = torch.stack(images, dim=0)
        masks_tensor = torch.stack(masks, dim=0)

        return images_tensor, masks_tensor

    def _create_image_from_lasso_shape(self, base_image, layer_data, width, height, export_alpha):
        """
        Create an image and mask from a single lasso shape.
        This version extracts the content from the base_image using the mask.
        """
        try:
            lasso_shape = layer_data.get('lassoShape', {})
            additive_paths = lasso_shape.get('additivePaths', [])

            if not additive_paths:
                return None, None

            # Create a PIL image and mask
            mask_img = Image.new('L', (width, height), 0)
            mask_draw = ImageDraw.Draw(mask_img)

            # Draw all paths on the mask
            for path in additive_paths:
                if not path or not isinstance(path, list):
                    continue
                actual_points = []
                for point in path:
                    if isinstance(point, dict) and 'x' in point and 'y' in point:
                        x = int(point['x'] * width)
                        y = int(point['y'] * height)
                        actual_points.append((x, y))
                if len(actual_points) >= 3:
                    mask_draw.polygon(actual_points, fill=255)

            # Apply 3-pixel feather to the mask using a Gaussian blur
            mask_np = np.array(mask_img).astype(np.float32) / 255.0
            mask_np = gaussian_filter(mask_np, sigma=1.5)
            
            mask_tensor = torch.from_numpy(mask_np).to(base_image.device)

            # Use the first image from the base_image batch as the source
            source_image = base_image[0]  # Shape: [H, W, C]

            if export_alpha:
                # Take the original RGB channels of the source_image
                original_rgb = source_image[..., :3]
                # Concatenate the original RGB with the feathered mask as the alpha channel
                image_tensor = torch.cat((original_rgb, mask_tensor.unsqueeze(-1)), dim=-1)
            else:
                # If not exporting alpha, just return the original RGB of the source within the mask area.
                # The feathering in mask_tensor is still present, but won't be explicitly used as alpha
                # in the output image_tensor if it's RGB.
                image_tensor = source_image[..., :3]

            return image_tensor, mask_tensor
        except Exception as e:
            print(f"Error creating image from lasso shape: {e}")
            return None, None

    def _save_bg_preview(self, bg_image):
        if bg_image.device != torch.device("cpu"):
            bg_image = bg_image.cpu()

        transform = transforms.ToPILImage()
        img_tensor = bg_image[0]
        if img_tensor.dim() == 3 and img_tensor.shape[0] != 3 and img_tensor.shape[2] == 3:
            img_tensor = img_tensor.permute(2, 0, 1)
        elif img_tensor.dim() == 2:
            img_tensor = img_tensor.unsqueeze(0).repeat(3, 1, 1)

        if torch.is_floating_point(img_tensor):
            img_tensor = torch.clamp(img_tensor, 0, 1)

        image = transform(img_tensor)
        if image.mode != "RGB":
            image = image.convert("RGB")

        bg_folder = Path(__file__).parent.parent / "web" / "power_spline_editor" / "bg"
        bg_folder.mkdir(parents=True, exist_ok=True)
        bg_path = bg_folder / "bg_image.png"
        image.save(str(bg_path), format="PNG")

    def _inpaint_background_torch(self, image_tensor: torch.Tensor, mask_tensor: torch.Tensor) -> torch.Tensor:
        """
        Applies OpenCV's inpainting to a torch tensor image using a torch tensor mask.
        image_tensor: [B, H, W, C] (float32, 0-1)
        mask_tensor: [H, W] (float32, 0-1), where 1 indicates masked areas
        """
        if image_tensor.shape[0] != 1:
            # Handle batching: apply inpaint to each image in batch if necessary.
            # For this use case, we expect B=1 for the bg_image
            pass # We'll handle a single image for now based on the problem description.

        # Convert image to numpy (H, W, C) for OpenCV, assuming B=1
        img_np = image_tensor[0].mul(255).byte().cpu().numpy() # Convert from 0-1 float to 0-255 uint8

        # Convert mask to numpy (H, W), boolean to uint8 (0 or 255)
        mask_np = (mask_tensor.cpu().numpy() > 0.01).astype(np.uint8) * 255


        # Perform inpainting
        # cv2.inpaint expects BGR format, so we need to convert if image_tensor is RGB
        # ComfyUI typically uses RGB. Let's assume input is RGB and convert to BGR for inpaint.
        img_bgr = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR)
        inpainted_bgr_np = cv2.inpaint(img_bgr, mask_np, 3, cv2.INPAINT_TELEA)
        inpainted_rgb_np = cv2.cvtColor(inpainted_bgr_np, cv2.COLOR_BGR2RGB)

        # Convert back to torch tensor, (B, H, W, C)
        inpainted_tensor = torch.from_numpy(inpainted_rgb_np).float().div(255.0).unsqueeze(0).to(image_tensor.device)

        return inpainted_tensor

    def _find_bounding_box(self, image_tensor, mask_tensor=None):
        """
        Find the bounding box of non-transparent pixels in an image tensor.
        
        Args:
            image_tensor: Image tensor of shape [H, W, C]
            mask_tensor: Optional mask tensor of shape [H, W] indicating visible pixels
            
        Returns:
            Tuple of (min_x, min_y, max_x, max_y) representing the bounding box
        """
        if mask_tensor is not None:
            # Use the provided mask to find visible pixels
            mask = mask_tensor > 0.01  # Threshold for considering a pixel visible
        elif image_tensor.shape[-1] == 4:
            # Use alpha channel to find non-transparent pixels
            alpha = image_tensor[..., 3]
            mask = alpha > 0.01  # Threshold for considering a pixel non-transparent
        else:
            # For RGB images, check if pixels are not black (have some color)
            # Sum the RGB channels and check if they have any value
            rgb_sum = torch.sum(image_tensor[..., :3], dim=-1)
            mask = rgb_sum > 0.01  # Threshold for considering a pixel non-black
        
        if not mask.any():
            # No non-transparent pixels found
            return (0, 0, image_tensor.shape[1], image_tensor.shape[0])
        
        # Find coordinates of non-transparent pixels
        y_indices, x_indices = torch.where(mask)
        
        min_x = x_indices.min().item()
        max_x = x_indices.max().item()
        min_y = y_indices.min().item()
        max_y = y_indices.max().item()
        
        return (min_x, min_y, max_x, max_y)
    
    def _create_square_canvas(self, max_dim, channels=4):
        """
        Create a square canvas with the specified dimensions.
        
        Args:
            max_dim: The size of the square canvas (width and height)
            channels: Number of channels (3 for RGB, 4 for RGBA)
            
        Returns:
            A square tensor of shape [max_dim, max_dim, channels]
        """
        return torch.zeros((max_dim, max_dim, channels), dtype=torch.float32)
    
    def _place_image_in_square(self, source_image, target_canvas, bbox, has_alpha=True):
        """
        Place the visible content of the source image into the target square canvas.
        
        Args:
            source_image: Source image tensor
            target_canvas: Target square canvas tensor
            bbox: Bounding box of the source image (min_x, min_y, max_x, max_y)
            has_alpha: Whether the source image has an alpha channel
            
        Returns:
            Modified target_canvas with the source image placed in it
        """
        min_x, min_y, max_x, max_y = bbox
        source_width = max_x - min_x + 1
        source_height = max_y - min_y + 1
        
        # Extract the visible content from the source image
        if has_alpha:
            visible_content = source_image[min_y:max_y+1, min_x:max_x+1, :]
        else:
            visible_content = source_image[min_y:max_y+1, min_x:max_x+1, :]
        
        # Calculate position to center the content in the square canvas
        canvas_size = target_canvas.shape[0]
        offset_x = (canvas_size - source_width) // 2
        offset_y = (canvas_size - source_height) // 2
        
        # Place the visible content in the center of the square canvas
        end_x = offset_x + source_width
        end_y = offset_y + source_height
        
        if has_alpha and visible_content.shape[-1] == 4:
            # Handle alpha channel properly
            alpha = visible_content[..., 3:4]
            target_canvas[offset_y:end_y, offset_x:end_x, :] = visible_content
        else:
            target_canvas[offset_y:end_y, offset_x:end_x, :visible_content.shape[-1]] = visible_content
        
        return target_canvas
