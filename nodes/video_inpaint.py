import torch
import torch.nn.functional as F
import numpy as np
import cv2
from typing import Optional


class VideoInpaint:
    """
    Simple video inpainting node that fills masked areas using inpainting.
    Similar to Prepare Refs but simplified for video processing.
    """

    # Module-level constants from PrepareRefs
    MASK_THRESHOLD = 0.01  # threshold to consider a mask pixel "active"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("IMAGE", {"forceInput": True}),
                "video_mask": ("IMAGE", {"forceInput": True}),
                "padding": ("INT", {"default": 0, "min": 0, "max": 100, "step": 1}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("video",)
    FUNCTION = "inpaint_video"
    CATEGORY = "WanVideoWrapper_QQ"
    DESCRIPTION = """
    Fill masked areas in video using inpainting.
    video_mask: black and white image mask (same size as video frames)
    padding: expand mask by N pixels (0 = off)
    """

    def inpaint_video(self, video: torch.Tensor, video_mask: torch.Tensor, padding: int):
        """
        Main entry point for video inpainting.

        Args:
            video: [B, H, W, C] tensor of video frames (float 0..1)
            video_mask: [B, H, W, C] or [B, H, W] tensor mask (black and white)
            padding: number of pixels to expand the mask

        Returns:
            inpainted_video: [B, H, W, C] tensor with masked areas filled
        """
        if video is None:
            raise ValueError("video input is required")
        if video_mask is None:
            raise ValueError("video_mask input is required")

        # Ensure video is in BHWC format
        if video.dim() != 4:
            raise ValueError(f"video must be 4D tensor [B,H,W,C], got shape {video.shape}")

        batch_size, height, width, channels = video.shape

        # Process video_mask to get single channel mask [B, H, W]
        processed_mask = self._process_mask(video_mask, height, width)

        # Apply padding to mask if requested
        if padding > 0:
            processed_mask = self._apply_padding(processed_mask, padding)

        # Process each frame in the batch
        inpainted_frames = []
        for i in range(batch_size):
            frame = video[i]  # [H, W, C]
            mask = processed_mask[i]  # [H, W]

            # Apply inpainting to this frame
            inpainted_frame = self._inpaint_frame(frame, mask)
            inpainted_frames.append(inpainted_frame)

        # Stack back into batch
        inpainted_video = torch.stack(inpainted_frames, dim=0)

        return (inpainted_video,)

    def _process_mask(self, video_mask: torch.Tensor, target_height: int, target_width: int) -> torch.Tensor:
        """
        Process video_mask to get a single channel mask tensor [B, H, W].
        Handles both [B, H, W, C] and [B, H, W] formats.
        """
        # Ensure we have a batch dimension
        if video_mask.dim() == 3:
            # [H, W, C] or [H, W]
            if video_mask.shape[-1] in (1, 3, 4):
                video_mask = video_mask.unsqueeze(0)  # [1, H, W, C]
            else:
                video_mask = video_mask.unsqueeze(0).unsqueeze(-1)  # [1, H, W, 1]
        elif video_mask.dim() == 2:
            video_mask = video_mask.unsqueeze(0).unsqueeze(-1)  # [1, H, W, 1]

        # Now video_mask should be [B, H, W, C] or [B, H, W, 1]
        mask_batch = video_mask.shape[0]
        mask_h = video_mask.shape[1]
        mask_w = video_mask.shape[2]

        # Extract single channel from mask
        if video_mask.dim() == 4 and video_mask.shape[-1] > 1:
            # For multi-channel masks, average the channels (grayscale)
            processed = video_mask.mean(dim=-1)  # [B, H, W]
        else:
            # Squeeze the last dimension if it's 1
            processed = video_mask.squeeze(-1)  # [B, H, W]

        # Resize if needed
        if mask_h != target_height or mask_w != target_width:
            # Add channel dimension for interpolation
            processed = processed.unsqueeze(1)  # [B, 1, H, W]
            processed = F.interpolate(
                processed,
                size=(target_height, target_width),
                mode='bilinear',
                align_corners=False
            )
            processed = processed.squeeze(1)  # [B, H, W]

        # Ensure mask is in 0..1 range
        processed = torch.clamp(processed, 0.0, 1.0)

        return processed

    def _apply_padding(self, mask: torch.Tensor, padding: int) -> torch.Tensor:
        """
        Expand the mask by padding pixels using morphological dilation.

        Args:
            mask: [B, H, W] tensor
            padding: number of pixels to expand

        Returns:
            padded_mask: [B, H, W] tensor with expanded mask
        """
        padded_masks = []

        for i in range(mask.shape[0]):
            mask_np = mask[i].cpu().numpy()

            # Convert to binary (0 or 255)
            mask_binary = (mask_np > self.MASK_THRESHOLD).astype(np.uint8) * 255

            # Create a kernel for dilation
            kernel_size = padding * 2 + 1
            kernel = np.ones((kernel_size, kernel_size), np.uint8)

            # Apply dilation to expand the mask
            dilated = cv2.dilate(mask_binary, kernel, iterations=1)

            # Convert back to float 0..1
            dilated_tensor = torch.from_numpy(dilated.astype(np.float32) / 255.0)
            padded_masks.append(dilated_tensor)

        return torch.stack(padded_masks).to(mask.device)

    def _inpaint_frame(self, frame: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        """
        Inpaint a single frame using the mask.
        Uses the same inpainting approach as PrepareRefs.

        Args:
            frame: [H, W, C] tensor (float 0..1)
            mask: [H, W] tensor (float 0..1)

        Returns:
            inpainted_frame: [H, W, C] tensor
        """
        # Check if mask has any active areas
        if not torch.any(mask > self.MASK_THRESHOLD):
            return frame

        # Convert to numpy for OpenCV
        frame_np = frame.mul(255).byte().cpu().numpy()  # HWC uint8

        # Ensure RGB format
        if frame_np.shape[-1] != 3:
            # If not RGB, try to use first 3 channels
            if frame_np.shape[-1] >= 3:
                frame_np = frame_np[..., :3]
            else:
                # Grayscale, convert to RGB
                frame_np = cv2.cvtColor(frame_np, cv2.COLOR_GRAY2RGB)

        # Prepare mask
        mask_np = (mask.cpu().numpy() > self.MASK_THRESHOLD).astype(np.uint8) * 255

        try:
            # Convert to BGR for OpenCV
            frame_bgr = cv2.cvtColor(frame_np, cv2.COLOR_RGB2BGR)

            # Apply inpainting
            inpainted_bgr = cv2.inpaint(frame_bgr, mask_np, 3, cv2.INPAINT_TELEA)

            # Convert back to RGB
            inpainted_rgb = cv2.cvtColor(inpainted_bgr, cv2.COLOR_BGR2RGB)

            # Convert back to tensor
            inpainted_tensor = torch.from_numpy(inpainted_rgb).float().div(255.0).to(frame.device)

            return inpainted_tensor
        except Exception as e:
            print(f"[VideoInpaint ERROR] inpaint_frame failed: {e}")
            return frame


# Node registration for ComfyUI
NODE_CLASS_MAPPINGS = {
    "VideoInpaint": VideoInpaint,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoInpaint": "Video Inpaint",
}
