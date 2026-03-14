"""
SAM2 Masker - Point-click masking using Segment Anything Model 2

This module provides a singleton SAM2 masker for efficient model reuse
and lazy loading of the SAM2 model for point-click masking operations.
"""
import numpy as np
from PIL import Image
import torch
import os
import sys
import warnings

# Disable torch.jit to avoid source code inspection issues in embedded Python
os.environ['PYTORCH_JIT_DISABLE'] = '1'

# Monkey-patch torch.jit.script to avoid JIT compilation issues
original_jit_script = torch.jit.script
def no_jit_script(fn, *args, **kwargs):
    """Wrapper that disables JIT compilation and returns function as-is"""
    return fn
torch.jit.script = no_jit_script

# Also patch torch.jit.trace to be safe
original_jit_trace = torch.jit.trace
def no_jit_trace(fn, *args, **kwargs):
    """Wrapper that disables JIT tracing"""
    return fn
torch.jit.trace = no_jit_trace

warnings.filterwarnings('ignore', message='torch.jit')

# Import from local utility/sam directory
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
sys.path.insert(0, parent_dir)

from utility.sam.sam2_image_predictor import SAM2ImagePredictor


class SAM2Masker:
    """
    Singleton SAM2 masker for efficient model reuse.

    This class implements lazy loading of the SAM2 model to avoid
    unnecessary GPU memory usage and startup time. The model is only
    loaded on first use.
    """
    _instance = None
    _predictor = None
    _model_loaded = False

    def __new__(cls):
        """Implement singleton pattern"""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def load_model(self, device='cuda'):
        """
        Load SAM2 model with lazy loading.

        Args:
            device: 'cuda' or 'cpu' - defaults to 'cuda'
        """
        if not self._model_loaded:
            try:
                # Try to load model with error handling for JIT compilation issues
                import os
                os.environ['SAM2_DISABLE_TORCH_COMPILE'] = '1'  # Disable torch.compile

                self._predictor = SAM2ImagePredictor.from_pretrained(
                    "facebook/sam2-hiera-base-plus",
                    device=device
                )
                self._model_loaded = True
            except Exception as e:
                # Try fallback to CPU if CUDA fails
                if device == 'cuda':
                    try:
                        self._predictor = SAM2ImagePredictor.from_pretrained(
                            "facebook/sam2-hiera-base-plus",
                            device='cpu'
                        )
                        self._model_loaded = True
                    except Exception as e2:
                        print(f"[SAM2] Model loading failed: {e}")
                        raise
                else:
                    print(f"[SAM2] Model loading failed: {e}")
                    raise

    def predict_from_points(self, image, point_coords, point_labels):
        """
        Predict mask from point prompts.

        Args:
            image: PIL Image or numpy array [H, W, C] in RGB format
            point_coords: List of (x, y) tuples or Nx2 numpy array in pixel coordinates
            point_labels: List of 1 (foreground) or 0 (background)

        Returns:
            mask: [H, W] numpy array (binary mask)
            score: float (confidence score for the best mask)
        """
        self.load_model()

        # Convert PIL to numpy if needed
        if isinstance(image, Image.Image):
            image = np.array(image)

        # Ensure RGB format (convert RGBA to RGB if needed)
        if image.shape[-1] == 4:
            image = image[:, :, :3]  # Remove alpha channel

        # Set image for prediction
        self._predictor.set_image(image)

        # Convert to numpy arrays if needed
        if isinstance(point_coords, list):
            point_coords = np.array(point_coords)
        if isinstance(point_labels, list):
            point_labels = np.array(point_labels)

        # Predict masks
        masks, scores, _ = self._predictor.predict(
            point_coords=point_coords,
            point_labels=point_labels,
            multimask_output=True
        )

        # Return best mask
        best_idx = np.argmax(scores)
        return masks[best_idx], float(scores[best_idx])


# Global instance for use across the application
sam2_masker = SAM2Masker()
