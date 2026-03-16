import os
import sys
import torch
import numpy as np
import hashlib
import requests
from tqdm import tqdm
from pathlib import Path
from typing import Optional

# Add matanyone2 to path
matanyone2_path = Path(__file__).parent.parent / "utility" / "matanyone2"
if str(matanyone2_path) not in sys.path:
    sys.path.insert(0, str(matanyone2_path))

from matanyone.inference.inference_core import InferenceCore
from matanyone.utils.get_default_model import get_matanyone_model


def download_matanyone2_model(checkpoint_dir: Path = None) -> Path:
    """Download MatAnyone2 model if not already present."""
    MODEL_URL = "https://github.com/pq-yang/MatAnyone2/releases/download/v1.0.0/matanyone2.pth"
    MODEL_MD5 = "b1d3cfbb7596ecf3b88391198427ca95"
    MODEL_NAME = "matanyone2.pth"

    if checkpoint_dir is None:
        checkpoint_dir = matanyone2_path / "checkpoints"

    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    model_path = checkpoint_dir / MODEL_NAME

    if model_path.exists():
        with open(model_path, 'rb') as f:
            file_hash = hashlib.md5(f.read()).hexdigest()
        if file_hash == MODEL_MD5:
            return model_path
        print(f"[MatAnyone2] Model corrupted, redownloading...")
        model_path.unlink()

    print(f"[MatAnyone2] Downloading model...")
    try:
        response = requests.get(MODEL_URL, stream=True)
        response.raise_for_status()
        total_size = int(response.headers.get('content-length', 0))

        with open(model_path, 'wb') as f:
            with tqdm(total=total_size, unit='B', unit_scale=True, desc=MODEL_NAME) as pbar:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
                        pbar.update(len(chunk))

        with open(model_path, 'rb') as f:
            file_hash = hashlib.md5(f.read()).hexdigest()
        if file_hash != MODEL_MD5:
            model_path.unlink()
            raise ValueError(f"Incorrect MD5: {file_hash}")

        print(f"[MatAnyone2] Model downloaded")
        return model_path

    except Exception as e:
        if model_path.exists():
            model_path.unlink()
        raise RuntimeError(f"Failed to download: {e}")


class MatAnyone2:
    """
    MatAnyone2 video matting node.
    Propagates a mask through video frames.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("IMAGE", {"forceInput": True}),
                "mask": ("IMAGE", {"forceInput": True}),
            },
            "optional": {
                "warmup_iterations": ("INT", {"default": 5, "min": 0, "max": 10}),
                "force_cpu": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("video",)
    FUNCTION = "propagate_mask"
    CATEGORY = "WanVideoWrapper_QQ"
    DESCRIPTION = """
    Propagate a mask through video frames using MatAnyone2.
    video: Input video frames [B,H,W,C]
    mask: Starting frame mask (black and white)
    warmup_iterations: Number of refinement passes for first frame (0-10, default 5). Lower = faster but less accurate.
    force_cpu: If False, uses GPU if available. If True, forces CPU processing.
    """

    def __init__(self):
        self.processor = None

    def _load_processor(self, device: torch.device):
        """Load MatAnyone2 processor if not already loaded."""
        if self.processor is not None:
            return

        checkpoint_path = download_matanyone2_model()

        original_dir = os.getcwd()
        try:
            os.chdir(str(matanyone2_path))
            model = get_matanyone_model(str(checkpoint_path), device=device)
            self.processor = InferenceCore(model, cfg=model.cfg, device=device)
        finally:
            os.chdir(original_dir)

    def _process_input_mask(self, mask: torch.Tensor) -> torch.Tensor:
        """Convert mask to [num_objects, H, W] format for MatAnyone2.
        Expected output: float tensor in range [0, 255] with shape [1, H, W] for single object.
        The model will internally normalize by dividing by 255.
        """
        # Remove batch dimension if present: [B, H, W, C] -> [H, W, C]
        if mask.dim() == 4:
            mask = mask[0]

        # Convert [H, W, C] to [H, W]
        if mask.dim() == 3:
            if mask.shape[-1] > 1:
                # RGB/RGBA -> grayscale by averaging channels
                mask = mask.mean(dim=-1)
            else:
                # Already single channel -> remove it
                mask = mask.squeeze(-1)

        # Ensure float in [0, 255] range (model will divide by 255 internally)
        if mask.dtype == torch.uint8 or mask.dtype == torch.int8:
            mask = mask.float()
        elif mask.max() <= 1.0:
            # Already in [0, 1] range -> convert to [0, 255]
            mask = (mask * 255.0).float()

        # Add object dimension: [H, W] -> [1, H, W]
        mask = mask.unsqueeze(0)

        # Ensure tensor is contiguous
        return mask.contiguous()

    def _process_frame(self, frame: torch.Tensor) -> torch.Tensor:
        """Convert frame [H, W, C] to [3, H, W] for MatAnyone2."""
        frame_np = (frame.cpu().numpy() * 255).astype(np.uint8)
        if frame_np.shape[-1] == 4:
            frame_np = frame_np[:, :, :3]
        tensor = torch.from_numpy(frame_np / 255.0).float().permute(2, 0, 1)
        return tensor

    def _output_to_image(self, prob: torch.Tensor) -> torch.Tensor:
        """Convert MatAnyone2 output to [H, W, C] image format.

        prob can be:
        - [H, W] - single probability map
        - [1, H, W] - with batch/object dimension
        - [2, H, W] - [background, foreground] probabilities
        - [num_objects, H, W] - multiple objects
        """
        # Handle different input formats
        if prob.dim() == 3 and prob.shape[0] == 2:
            # [2, H, W] format -> take foreground (index 1)
            prob = prob[1]  # Take foreground channel
        elif prob.dim() == 3 and prob.shape[0] == 1:
            # [1, H, W] format -> squeeze the batch dimension
            prob = prob.squeeze(0)
        elif prob.dim() > 2:
            # Try to squeeze only dimensions of size 1
            prob = prob.squeeze()

        # Now prob should be [H, W]
        prob_np = (prob.detach().cpu().numpy() * 255).astype(np.uint8)
        prob_rgb = np.stack([prob_np] * 3, axis=-1)
        return torch.from_numpy(prob_rgb / 255.0).float()

    def propagate_mask(self, video: torch.Tensor, mask: torch.Tensor, warmup_iterations: int = 5, force_cpu: bool = False):
        """
        Propagate mask through video.

        Args:
            video: [B, H, W, C] tensor
            mask: [B, H, W, C] or [H, W, C] tensor mask
            warmup_iterations: Number of warmup iterations for first frame
            force_cpu: If True, force CPU processing. If False, use GPU if available.

        Returns:
            [B, H, W, C] tensor with propagated masks
        """
        # Determine device: GPU by default, CPU if forced or unavailable
        if force_cpu:
            device = torch.device('cpu')
        else:
            device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

        batch_size = video.shape[0]

        self._load_processor(device)

        # Clear processor memory to prevent dimension conflicts from previous runs
        self.processor.clear_memory()

        # Force all frames to exact same dimensions to prevent padding mismatches
        target_h, target_w = video.shape[1], video.shape[2]
        video = torch.nn.functional.interpolate(
            video.permute(0, 3, 1, 2),  # [B, C, H, W]
            size=(target_h, target_w),
            mode='bilinear',
            align_corners=False
        ).permute(0, 2, 3, 1)  # [B, H, W, C]

        # Resize mask to match video dimensions if needed
        if mask.dim() == 4:  # [B, H, W, C]
            mask_h, mask_w = mask.shape[1], mask.shape[2]
        elif mask.dim() == 3:  # [H, W, C]
            mask_h, mask_w = mask.shape[0], mask.shape[1]
        else:
            mask_h, mask_w = mask.shape[-2], mask.shape[-1]

        if mask_h != target_h or mask_w != target_w:
            # Reshape mask for interpolation: [H, W, C] -> [1, C, H, W]
            if mask.dim() == 3:
                mask_to_resize = mask.permute(2, 0, 1).unsqueeze(0)  # [1, C, H, W]
            else:  # [B, H, W, C] -> [B, C, H, W]
                mask_to_resize = mask.permute(0, 3, 1, 2)

            # Resize to match video
            mask_resized = torch.nn.functional.interpolate(
                mask_to_resize,
                size=(target_h, target_w),
                mode='bilinear',
                align_corners=False
            )

            # Restore original shape
            if mask.dim() == 3:
                mask = mask_resized.squeeze(0).permute(1, 2, 0)  # [H, W, C]
            else:
                mask = mask_resized.permute(0, 2, 3, 1)  # [B, H, W, C]

        mask_input = self._process_input_mask(mask)

        outputs = []
        for i in range(batch_size):
            frame = video[i]
            frame_tensor = self._process_frame(frame).to(device)

            # Ensure mask_input is on the correct device
            if mask_input.device != device:
                mask_input = mask_input.to(device)

            # Ensure frame_tensor is on the correct device and has correct shape
            if frame_tensor.device != device:
                frame_tensor = frame_tensor.to(device)
            if frame_tensor.dim() != 3:
                raise ValueError(f"Expected frame_tensor to have 3 dimensions [C, H, W], got {frame_tensor.shape}")

            if i == 0:
                out_prob = self.processor.step(frame_tensor, mask_input, objects=[1])
                for warmup_idx in range(warmup_iterations):
                    out_prob = self.processor.step(frame_tensor, first_frame_pred=True)
            else:
                out_prob = self.processor.step(frame_tensor)

            output_frame = self._output_to_image(out_prob.squeeze(0))
            outputs.append(output_frame)

            if device.type == 'cuda' and i % 10 == 0:
                torch.cuda.empty_cache()

        stacked = torch.stack(outputs, dim=0)
        # Move output back to original device (usually CPU for ComfyUI)
        output_device = video.device
        if output_device != device:
            stacked = stacked.to(output_device)

        return (stacked,)


NODE_CLASS_MAPPINGS = {
    "MatAnyone2": MatAnyone2,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MatAnyone2": "MatAnyone2",
}
