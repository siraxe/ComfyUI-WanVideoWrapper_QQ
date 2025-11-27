import json
import torch
import torch.nn.functional as F
from torchvision import transforms
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter
import cv2
from typing import List, Tuple, Optional, Dict, Any


# -------------------------
# Module-level constants
# -------------------------
DEFAULT_BG_CHANNELS = 3
MASK_FEATHER_SIGMA = 1.5  # gaussian sigma used to feather masks
MASK_THRESHOLD = 0.01     # threshold to consider a mask pixel "active"


# -------------------------
# Utility helpers
# -------------------------
def ensure_dir(path: Path) -> None:
    """Ensure a directory exists."""
    path.mkdir(parents=True, exist_ok=True)


def tensor_to_pil(image_tensor: torch.Tensor) -> Image.Image:
    """
    Convert a torch image tensor to PIL Image.
    Accepts HWC or CHW or single-channel (grayscale) tensors.
    Expects float tensors in 0..1 or uint8 0..255.
    """
    if torch.is_floating_point(image_tensor):
        img = torch.clamp(image_tensor, 0.0, 1.0)
        img = (img * 255.0).byte()
    else:
        img = image_tensor.byte()

    # Convert to CHW if HWC provided with channels last
    if img.ndim == 3 and img.shape[2] in (1, 3, 4):
        img = img.permute(2, 0, 1)

    # torchvision transform expects CHW and byte or float
    pil = transforms.ToPILImage()(img)
    return pil


def pil_to_tensor(img: Image.Image) -> torch.Tensor:
    """Convert a PIL Image to a torch float tensor in 0..1 HWC format."""
    tensor = transforms.ToTensor()(img)  # CHW float 0..1
    tensor = tensor.permute(1, 2, 0)     # HWC
    return tensor


def clamp_float_tensor(t: torch.Tensor) -> torch.Tensor:
    """Clamp float tensor to 0..1."""
    if torch.is_floating_point(t):
        return torch.clamp(t, 0.0, 1.0)
    return t


def safe_device(tensor: torch.Tensor) -> str:
    """Return a short string describing tensor's device for debug."""
    return str(tensor.device) if isinstance(tensor, torch.Tensor) else "n/a"


# -------------------------
# Parsing / validation
# -------------------------
def parse_ref_layer_data_from_prompt(prompt: Optional[Dict], unique_id: Optional[str]) -> List[Dict[str, Any]]:
    """
    Extract ref_layer_data from the serialized prompt structure that the front-end provides.
    Supports multiple possible serialization shapes (list/dict/value/__value__).
    """
    if not prompt or not unique_id or str(unique_id) not in prompt:
        return []

    node_data = prompt[str(unique_id)]
    inputs = node_data.get("inputs", {}) if isinstance(node_data, dict) else {}
    raw_data = inputs.get("ref_layer_data")

    if raw_data is None:
        return []

    # Normalize different container shapes into a list of dicts
    if isinstance(raw_data, list):
        return raw_data
    if isinstance(raw_data, dict):
        # prefer '__value__' then 'value'
        if "__value__" in raw_data and isinstance(raw_data["__value__"], list):
            return raw_data["__value__"]
        if "value" in raw_data:
            val = raw_data["value"]
            if isinstance(val, list):
                return val
            if isinstance(val, (tuple,)):
                return list(val)
            # single value
            return [val] if val else []
        # fallback: wrap dict
        return [raw_data]

    # fallback: unknown type
    return []


def filter_layers_with_shapes(ref_layer_data: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Validate and filter out layers that do not contain lasso shapes or have no additivePaths.
    Only layers that are dicts and contain 'lassoShape' with 'additivePaths' will be returned.
    """
    valid_layers = []
    if not isinstance(ref_layer_data, list):
        return valid_layers

    for idx, layer in enumerate(ref_layer_data):
        if not isinstance(layer, dict):
            print(f"[PrepareRefs WARNING] Layer {idx} is not a dict: {type(layer)} - skipping")
            continue

        lasso = layer.get("lassoShape")
        if not lasso:
            print(f"[PrepareRefs WARNING] Layer {idx} ({layer.get('name','unknown')}) missing lassoShape - skipping")
            continue

        additive_paths = lasso.get("additivePaths", [])
        if not additive_paths:
            print(f"[PrepareRefs WARNING] Layer {idx} ({layer.get('name','unknown')}) additivePaths empty - skipping")
            continue

        # optional: only include layers explicitly turned "on" if present
        if "on" in layer and not layer.get("on", False):
            print(f"[PrepareRefs INFO] Layer {idx} ({layer.get('name','unknown')}) 'on' flag is False - skipping")
            continue

        valid_layers.append(layer)

    if len(valid_layers) < len(ref_layer_data):
        print(f"[PrepareRefs INFO] Filtered layers: {len(ref_layer_data)} → {len(valid_layers)} (removed {len(ref_layer_data)-len(valid_layers)} empty/invalid)")
    return valid_layers


# -------------------------
# Mask & image creation
# -------------------------
def create_mask_from_additive_paths(additive_paths: List[List[Dict[str, float]]], width: int, height: int,
                                    feather_sigma: float = MASK_FEATHER_SIGMA) -> np.ndarray:
    """
    Build a feathered mask (numpy float32 HxW) from an array of additive paths.
    Each path is a list of {'x': float, 'y': float} where coordinates are normalized 0..1.
    """
    mask_img = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask_img)

    for path in additive_paths:
        if not path or not isinstance(path, list):
            continue
        pts = []
        for p in path:
            if isinstance(p, dict) and "x" in p and "y" in p:
                x = int(p["x"] * width)
                y = int(p["y"] * height)
                pts.append((x, y))
        if len(pts) >= 3:
            draw.polygon(pts, fill=255)

    mask_np = np.array(mask_img).astype(np.float32) / 255.0
    if feather_sigma and feather_sigma > 0:
        mask_np = gaussian_filter(mask_np, sigma=feather_sigma)

    mask_np = np.clip(mask_np, 0.0, 1.0)
    return mask_np


def create_image_and_mask_from_layer(base_image: torch.Tensor,
                                     layer: Dict[str, Any],
                                     width: int,
                                     height: int,
                                     export_alpha: bool) -> Tuple[Optional[torch.Tensor], Optional[torch.Tensor]]:
    """
    Given a base image tensor (B,H,W,C), create a per-layer image tensor and mask tensor.
    Returns:
        image_tensor: HWC float tensor in 0..1 (RGB or RGBA depending on export_alpha)
        mask_tensor: HW float tensor in 0..1 (feathered)
    """
    try:
        lasso_shape = layer.get("lassoShape", {})
        additive_paths = lasso_shape.get("additivePaths", [])
        if not additive_paths:
            return None, None

        # Construct feathered mask (numpy) and convert to torch
        mask_np = create_mask_from_additive_paths(additive_paths, width, height)
        mask_tensor = torch.from_numpy(mask_np).float().to(base_image.device)

        # Use the first image in the base batch as source
        source_image = base_image[0]  # [H,W,C]

        if export_alpha:
            # Original RGB channels plus mask as alpha
            rgb = source_image[..., :3]
            img_tensor = torch.cat((rgb, mask_tensor.unsqueeze(-1)), dim=-1)
        else:
            img_tensor = source_image[..., :3]

        return img_tensor, mask_tensor
    except Exception as e:
        print(f"[PrepareRefs ERROR] create_image_and_mask_from_layer failed: {e}")
        return None, None


def extract_lasso_shapes_as_images(base_image: torch.Tensor,
                                   width: int,
                                   height: int,
                                   ref_layers: List[Dict[str, Any]],
                                   export_alpha: bool) -> Tuple[Optional[torch.Tensor], Optional[torch.Tensor]]:
    """
    For each valid layer in ref_layers, create an image and mask tensor.
    Returns stacked tensors: images [N, H, W, C], masks [N, H, W] or (None, None) if none found.
    """
    if not ref_layers:
        return None, None

    images = []
    masks = []
    for layer in ref_layers:
        img, m = create_image_and_mask_from_layer(base_image, layer, width, height, export_alpha)
        if img is not None and m is not None:
            images.append(img)
            masks.append(m)

    if not images:
        return None, None

    images_tensor = torch.stack(images, dim=0)
    masks_tensor = torch.stack(masks, dim=0)
    return images_tensor, masks_tensor


# -------------------------
# Mask combining & preview
# -------------------------
def combine_masks_union(ref_masks: torch.Tensor) -> torch.Tensor:
    """
    Combine multiple mask tensors (N,H,W) into a single HxW mask using max (union).
    Result is float32 0..1.
    """
    if ref_masks is None or ref_masks.numel() == 0:
        return None
    return torch.clamp(torch.max(ref_masks, dim=0)[0], 0.0, 1.0)


def save_combined_mask_preview(combined_mask: torch.Tensor, save_path: Path) -> None:
    """
    Save a preview of the combined mask as an RGB PNG for debugging/previewing.
    combined_mask is a float tensor HxW with values 0..1
    """
    try:
        pil = tensor_to_pil(combined_mask.cpu())
        pil = pil.convert("RGB")
        ensure_dir(save_path.parent)
        pil.save(str(save_path))
    except Exception as e:
        print(f"[PrepareRefs ERROR] save_combined_mask_preview failed: {e}")


def apply_mask_to_bg_with_cv2_preview(combined_mask: torch.Tensor, bg_image_path: Path, out_path: Path) -> None:
    """
    If a bg_image exists on disk, apply the combined mask and save a masked bg preview using cv2.
    This mirrors the original behavior that produced bg_image_masked.png for frontend debugging.
    """
    if not bg_image_path.exists():
        return

    try:
        bg_np = cv2.imread(str(bg_image_path))
        if bg_np is None:
            return

        mask_np = (combined_mask.cpu().numpy() * 255).astype(np.uint8)
        if mask_np.shape != (bg_np.shape[0], bg_np.shape[1]):
            mask_np = cv2.resize(mask_np, (bg_np.shape[1], bg_np.shape[0]))

        mask_3c = cv2.cvtColor(mask_np, cv2.COLOR_GRAY2BGR)
        masked = cv2.bitwise_and(bg_np, mask_3c)
        ensure_dir(out_path.parent)
        cv2.imwrite(str(out_path), masked)
    except Exception as e:
        print(f"[PrepareRefs ERROR] apply_mask_to_bg_with_cv2_preview failed: {e}")


# -------------------------
# Inpainting
# -------------------------
def inpaint_background_torch(image_tensor: torch.Tensor, mask_tensor: torch.Tensor) -> torch.Tensor:
    """
    Inpaint image_tensor using OpenCV inpainting based on mask_tensor.
    image_tensor: [1,H,W,C] float 0..1 (RGB)
    mask_tensor: HxW float 0..1
    Returns inpainted [1,H,W,C] tensor float 0..1
    """
    if image_tensor is None:
        return image_tensor

    # Expect B=1; if not, operate on first
    img_np = image_tensor[0].mul(255).byte().cpu().numpy()  # HWC uint8
    # ensure image is contiguous with channels last
    if img_np.ndim != 3 or img_np.shape[2] not in (3, 4):
        # try to permute if CHW provided
        try:
            img_np = np.transpose(img_np, (1, 2, 0))
        except Exception:
            pass

    mask_np = (mask_tensor.cpu().numpy() > MASK_THRESHOLD).astype(np.uint8) * 255

    try:
        img_bgr = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR)
        inpainted_bgr = cv2.inpaint(img_bgr, mask_np, 3, cv2.INPAINT_TELEA)
        inpainted_rgb = cv2.cvtColor(inpainted_bgr, cv2.COLOR_BGR2RGB)
        out_tensor = torch.from_numpy(inpainted_rgb).float().div(255.0).unsqueeze(0).to(image_tensor.device)
        return out_tensor
    except Exception as e:
        print(f"[PrepareRefs ERROR] inpaint_background_torch failed: {e}")
        return image_tensor


# -------------------------
# Bounding box / squaring helpers
# -------------------------
def find_bounding_box(image_tensor: torch.Tensor, mask_tensor: Optional[torch.Tensor] = None) -> Tuple[int, int, int, int]:
    """
    Find the bounding box of non-transparent/active pixels.
    Returns min_x, min_y, max_x, max_y.
    """
    if mask_tensor is not None:
        mask = mask_tensor > MASK_THRESHOLD
    elif image_tensor.shape[-1] == 4:
        mask = image_tensor[..., 3] > MASK_THRESHOLD
    else:
        rgb_sum = torch.sum(image_tensor[..., :3], dim=-1)
        mask = rgb_sum > MASK_THRESHOLD

    if not mask.any():
        return 0, 0, image_tensor.shape[1], image_tensor.shape[0]

    ys, xs = torch.where(mask)
    min_x = int(xs.min().item())
    max_x = int(xs.max().item())
    min_y = int(ys.min().item())
    max_y = int(ys.max().item())
    return min_x, min_y, max_x, max_y


def create_square_canvas(max_dim: int, channels: int = 4) -> torch.Tensor:
    """Create a zero-initialized square canvas tensor HxWxC (float32)."""
    return torch.zeros((max_dim, max_dim, channels), dtype=torch.float32)


def place_image_in_square(source_image: torch.Tensor,
                          target_canvas: torch.Tensor,
                          bbox: Tuple[int, int, int, int],
                          has_alpha: bool = True) -> torch.Tensor:
    """
    Center the visible content from source_image (HWC) inside target_canvas (square HWC).
    Handles alpha if present.
    """
    min_x, min_y, max_x, max_y = bbox
    src_w = max_x - min_x + 1
    src_h = max_y - min_y + 1
    visible = source_image[min_y:max_y + 1, min_x:max_x + 1, :]

    canvas_size = target_canvas.shape[0]
    offset_x = (canvas_size - src_w) // 2
    offset_y = (canvas_size - src_h) // 2
    end_x = offset_x + src_w
    end_y = offset_y + src_h

    if has_alpha and visible.shape[-1] == 4:
        target_canvas[offset_y:end_y, offset_x:end_x, :] = visible
    else:
        target_canvas[offset_y:end_y, offset_x:end_x, :visible.shape[-1]] = visible
    return target_canvas


def scale_and_center_in_square(source_image: torch.Tensor,
                                bbox: Tuple[int, int, int, int],
                                square_size: int = 768,
                                has_alpha: bool = True) -> torch.Tensor:
    """
    Crop to bounding box, scale to fill as much of square_size as possible (maintaining aspect ratio),
    and center in a square canvas.

    Args:
        source_image: Input image tensor (H, W, C)
        bbox: Bounding box (min_x, min_y, max_x, max_y)
        square_size: Target square size (default 768)
        has_alpha: Whether image has alpha channel

    Returns:
        Square canvas with scaled and centered image
    """
    min_x, min_y, max_x, max_y = bbox
    src_w = max_x - min_x + 1
    src_h = max_y - min_y + 1

    # Crop to bounding box
    visible = source_image[min_y:max_y + 1, min_x:max_x + 1, :]

    # Calculate scale factor to fill square as much as possible
    scale = min(square_size / src_w, square_size / src_h)

    new_w = int(src_w * scale)
    new_h = int(src_h * scale)

    # Resize the cropped content using bilinear interpolation
    # Convert to CHW format for interpolation
    visible_chw = visible.permute(2, 0, 1).unsqueeze(0)  # (1, C, H, W)
    resized_chw = F.interpolate(visible_chw, size=(new_h, new_w), mode='bilinear', align_corners=False)
    resized = resized_chw.squeeze(0).permute(1, 2, 0)  # Back to HWC

    # Create square canvas
    channels = visible.shape[-1]
    canvas = torch.zeros((square_size, square_size, channels), dtype=torch.float32)

    # Center the scaled content
    offset_x = (square_size - new_w) // 2
    offset_y = (square_size - new_h) // 2

    canvas[offset_y:offset_y + new_h, offset_x:offset_x + new_w, :] = resized

    return canvas


# -------------------------
# File saving helpers
# -------------------------
def save_bg_preview(bg_image: torch.Tensor, out_folder: Path) -> None:
    """
    Save bg_image tensor (B,H,W,C) to out_folder/bg_image.png for UI preview.
    """
    try:
        if bg_image.device != torch.device("cpu"):
            bg_image = bg_image.cpu()

        img_tensor = bg_image[0]
        # convert to CHW if necessary
        if img_tensor.dim() == 3 and img_tensor.shape[0] != 3 and img_tensor.shape[2] == 3:
            img_tensor = img_tensor.permute(2, 0, 1)
        elif img_tensor.dim() == 2:
            img_tensor = img_tensor.unsqueeze(0).repeat(3, 1, 1)

        img_tensor = clamp_float_tensor(img_tensor)
        pil = tensor_to_pil(img_tensor)
        ensure_dir(out_folder)
        pil.save(str(out_folder / "bg_image.png"), format="PNG")
    except Exception as e:
        print(f"[PrepareRefs ERROR] save_bg_preview failed: {e}")


def save_image_to_ref_folder(image: Image.Image, layer_name: str, ref_folder: Path) -> Optional[str]:
    """
    Save a PIL image to ref_folder/<layer_name>.png and return its relative path (ref/...).
    """
    try:
        ensure_dir(ref_folder)
        if image.mode not in ("RGB", "RGBA"):
            image = image.convert("RGB")
        out_path = ref_folder / f"{layer_name}.png"
        image.save(str(out_path), format="PNG")
        return f"ref/{layer_name}.png"
    except Exception as e:
        print(f"[PrepareRefs ERROR] save_image_to_ref_folder failed for {layer_name}: {e}")
        return None


def save_masks_to_folder(masks: torch.Tensor, ref_layer_data: List[Dict[str, Any]], ref_folder: Path) -> None:
    """
    Save mask tensors (N,H,W) to <ref_folder>/<layer_name>_mask.png
    """
    try:
        ensure_dir(ref_folder)
        if masks.device != torch.device("cpu"):
            masks_cpu = masks.cpu()
        else:
            masks_cpu = masks

        for idx in range(masks_cpu.shape[0]):
            if idx < len(ref_layer_data):
                layer_name = ref_layer_data[idx].get("name", f"ref_{idx + 1}")
            else:
                layer_name = f"ref_{idx + 1}"

            mask_tensor = masks_cpu[idx]
            if mask_tensor.ndim == 2:
                mask_np = (mask_tensor.numpy() * 255).astype("uint8")
            elif mask_tensor.ndim == 3 and mask_tensor.shape[2] == 1:
                mask_np = (mask_tensor[:, :, 0].numpy() * 255).astype("uint8")
            else:
                # Unexpected shape: try to pick first channel
                try:
                    mask_np = (mask_tensor[0, :, :].numpy() * 255).astype("uint8")
                except Exception:
                    print(f"[PrepareRefs WARNING] Unexpected mask dims for {layer_name}: {mask_tensor.shape}")
                    continue

            pil = Image.fromarray(mask_np, mode="L")
            pil.save(str(ref_folder / f"{layer_name}_mask.png"), format="PNG")
    except Exception as e:
        print(f"[PrepareRefs ERROR] save_masks_to_folder failed: {e}")


# -------------------------
# Main class (PrepareRefs)
# -------------------------
class PrepareRefs:
    """
    Canvas-enabled node for preparing background/ref images with drawn shapes.
    Exports ref images with lasso shapes as masks.
    """

    # Node metadata (kept as original)
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask_width": ("INT", {"default": 640, "min": 8, "max": 4096, "step": 8}),
                "mask_height": ("INT", {"default": 480, "min": 8, "max": 4096, "step": 8}),
            },
            "optional": {
                "bg_image": ("IMAGE", {"forceInput": True}),
                "extra_refs": ("IMAGE", {"forceInput": True}),
                "extra_masks": ("MASK", {"forceInput": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
            }
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "MASK")
    RETURN_NAMES = ("bg_image", "ref_images", "ref_masks")
    FUNCTION = "prepare"
    CATEGORY = "WanVideoWrapper_QQ"
    DESCRIPTION = """
    Canvas node for prepping background/reference images.
    Can export ref images with lasso shapes as masks.
    """

    def prepare(self, mask_width: int, mask_height: int, bg_image: Optional[torch.Tensor] = None,
                extra_refs: Optional[torch.Tensor] = None, extra_masks: Optional[torch.Tensor] = None,
                unique_id: Optional[str] = None, prompt: Optional[Dict] = None):
        """
        Main entry point. High-level orchestration:
          - Resolve base dimensions and images
          - Parse & validate ref layer data
          - Short-circuit if no valid layers
          - Create per-layer images and masks
          - Create combined mask preview and inpaint background
          - Crop to 768x768 bounding boxes and scale images
          - Save preview/ref images/masks to disk and return UI metadata + tensors

        Note: export_alpha and to_bounding_box are always True now (hardcoded).
        """

        # Hardcoded settings: always export alpha and use 768x768 bounding boxes
        export_alpha = True
        to_bounding_box = True

        # Resolve final dims and base images
        width, height, output_bg_image, internal_processing_image = self._resolve_base_images(mask_width, mask_height, bg_image)

        # Parse and validate ref_layer_data early
        raw_ref_data = parse_ref_layer_data_from_prompt(prompt, unique_id)
        valid_ref_layers = filter_layers_with_shapes(raw_ref_data)

        # EARLY GUARD: if no valid layers, warn and return empty outputs (no further processing)
        if not valid_ref_layers:
            # Build empty outputs matching expected shapes
            empty_ref_images = torch.zeros((1, height, width, 4 if export_alpha else 3), dtype=torch.float32)
            empty_ref_masks = torch.zeros((1, height, width), dtype=torch.float32)
            ui_out = {"bg_image_dims": [{"width": float(width), "height": float(height)}]}
            # Persist bg preview only if original bg_image was provided
            if bg_image is not None:
                try:
                    save_bg_preview(bg_image, Path(__file__).parent.parent / "web" / "power_spline_editor" / "bg")
                    ui_out["bg_image_path"] = ["bg/bg_image.png"]
                except Exception as exc:
                    print(f"[PrepareRefs WARNING] Failed to save bg preview: {exc}")
            return {"ui": ui_out, "result": (output_bg_image, empty_ref_images, empty_ref_masks)}

        # Extract per-layer images and masks (full-size)
        ref_images, ref_masks = extract_lasso_shapes_as_images(internal_processing_image, width, height, valid_ref_layers, export_alpha)

        # Ensure we always have tensors for downstream logic
        if ref_images is None or ref_images.shape[0] == 0:
            ref_images = torch.zeros((1, height, width, 4 if export_alpha else 3), dtype=torch.float32)
            ref_masks = torch.zeros((1, height, width), dtype=torch.float32)

        # Optionally save a combined mask preview and create masked BG preview
        if ref_masks is not None and ref_masks.shape[0] > 0 and to_bounding_box:
            combined_mask = combine_masks_union(ref_masks)
            preview_mask_path = Path(__file__).parent.parent / "web" / "power_spline_editor" / "bg" / "combined_ref_mask.png"
            save_combined_mask_preview(combined_mask, preview_mask_path)

            bg_image_path = Path(__file__).parent.parent / "web" / "power_spline_editor" / "bg" / "bg_image.png"
            masked_bg_out = Path(__file__).parent.parent / "web" / "power_spline_editor" / "bg" / "bg_image_masked.png"
            apply_mask_to_bg_with_cv2_preview(combined_mask, bg_image_path, masked_bg_out)

        # Combine all masks at original dims for inpainting BEFORE any cropping
        if ref_masks is not None and ref_masks.shape[0] > 0:
            combined_original_dims_mask = combine_masks_union(ref_masks)
        else:
            combined_original_dims_mask = torch.zeros((height, width), dtype=torch.float32, device=output_bg_image.device)

        # Apply inpainting if combined mask has active areas
        if torch.any(combined_original_dims_mask > MASK_THRESHOLD):
            output_bg_image = inpaint_background_torch(output_bg_image, combined_original_dims_mask)

        # Determine bounding boxes and optionally crop to square images
        # Always use 768x768 squares and scale each layer to fill as much space as possible
        FIXED_SQUARE_SIZE = 768
        max_dim = max(width, height)

        if ref_images.shape[0] > 0 and to_bounding_box:
            all_bboxes = []
            for i in range(ref_images.shape[0]):
                bbox = find_bounding_box(ref_images[i], mask_tensor=ref_masks[i] if ref_masks is not None else None)
                all_bboxes.append(bbox)

            # Build 768x768 square canvases with scaled and centered images + masks
            square_images = []
            square_masks = []

            for i in range(ref_images.shape[0]):
                img = ref_images[i]
                mask = ref_masks[i] if ref_masks is not None else torch.zeros((height, width), dtype=torch.float32)
                bbox = all_bboxes[i]

                # Scale and center image in 768x768 canvas
                sq_img = scale_and_center_in_square(img, bbox, square_size=FIXED_SQUARE_SIZE, has_alpha=export_alpha)
                square_images.append(sq_img)

                # Scale and center mask in 768x768 canvas
                min_x, min_y, max_x, max_y = bbox
                src_w = max_x - min_x + 1
                src_h = max_y - min_y + 1
                visible_mask = mask[min_y:max_y + 1, min_x:max_x + 1]

                # Calculate same scale factor as for image
                scale = min(FIXED_SQUARE_SIZE / src_w, FIXED_SQUARE_SIZE / src_h)
                new_w = int(src_w * scale)
                new_h = int(src_h * scale)

                # Resize mask
                mask_chw = visible_mask.unsqueeze(0).unsqueeze(0)  # (1, 1, H, W)
                resized_mask_chw = F.interpolate(mask_chw, size=(new_h, new_w), mode='bilinear', align_corners=False)
                resized_mask = resized_mask_chw.squeeze(0).squeeze(0)  # (H, W)

                # Create square mask canvas and center
                sq_mask = torch.zeros((FIXED_SQUARE_SIZE, FIXED_SQUARE_SIZE), dtype=torch.float32)
                offset_x = (FIXED_SQUARE_SIZE - new_w) // 2
                offset_y = (FIXED_SQUARE_SIZE - new_h) // 2
                sq_mask[offset_y:offset_y + new_h, offset_x:offset_x + new_w] = resized_mask

                square_masks.append(sq_mask)

            # Replace with square versions
            ref_images = torch.stack(square_images, dim=0)
            ref_masks = torch.stack(square_masks, dim=0)
            max_dim = FIXED_SQUARE_SIZE  # Update max_dim for subsequent operations

        # Process extra_refs and extra_masks if provided
        if extra_refs is not None:
            print(f"[PrepareRefs INFO] Processing extra_refs with shape: {extra_refs.shape}")

            # extra_refs expected shape: [B, H, W, C] where B is the number of extra ref images
            num_extra_refs = extra_refs.shape[0]
            extra_square_images = []
            extra_square_masks = []

            for i in range(num_extra_refs):
                extra_img = extra_refs[i]  # [H, W, C]

                # Get corresponding mask if extra_masks is provided
                if extra_masks is not None and i < extra_masks.shape[0]:
                    # extra_masks shape could be [B, H, W] or [B, H, W, 1]
                    extra_mask = extra_masks[i]
                    if extra_mask.ndim == 3 and extra_mask.shape[-1] == 1:
                        extra_mask = extra_mask.squeeze(-1)  # [H, W]
                    elif extra_mask.ndim == 2:
                        pass  # Already [H, W]
                    else:
                        print(f"[PrepareRefs WARNING] Unexpected extra_mask shape: {extra_mask.shape}, creating empty mask")
                        extra_mask = torch.zeros((extra_img.shape[0], extra_img.shape[1]), dtype=torch.float32, device=extra_img.device)
                else:
                    # No mask provided, create a full white mask (fully visible)
                    extra_mask = torch.ones((extra_img.shape[0], extra_img.shape[1]), dtype=torch.float32, device=extra_img.device)

                # Find bounding box for the extra image
                extra_bbox = find_bounding_box(extra_img, mask_tensor=extra_mask)

                # Scale and center in 768x768 canvas (same as regular refs)
                sq_img = scale_and_center_in_square(extra_img, extra_bbox, square_size=FIXED_SQUARE_SIZE, has_alpha=export_alpha)
                extra_square_images.append(sq_img)

                # Scale and center mask in 768x768 canvas
                min_x, min_y, max_x, max_y = extra_bbox
                src_w = max_x - min_x + 1
                src_h = max_y - min_y + 1
                visible_mask = extra_mask[min_y:max_y + 1, min_x:max_x + 1]

                # Calculate scale factor
                scale = min(FIXED_SQUARE_SIZE / src_w, FIXED_SQUARE_SIZE / src_h)
                new_w = int(src_w * scale)
                new_h = int(src_h * scale)

                # Resize mask
                mask_chw = visible_mask.unsqueeze(0).unsqueeze(0)  # (1, 1, H, W)
                resized_mask_chw = F.interpolate(mask_chw, size=(new_h, new_w), mode='bilinear', align_corners=False)
                resized_mask = resized_mask_chw.squeeze(0).squeeze(0)  # (H, W)

                # Create square mask canvas and center
                sq_mask = torch.zeros((FIXED_SQUARE_SIZE, FIXED_SQUARE_SIZE), dtype=torch.float32, device=extra_mask.device)
                offset_x = (FIXED_SQUARE_SIZE - new_w) // 2
                offset_y = (FIXED_SQUARE_SIZE - new_h) // 2
                sq_mask[offset_y:offset_y + new_h, offset_x:offset_x + new_w] = resized_mask

                extra_square_masks.append(sq_mask)

            # Append extra refs to ref_images and ref_masks
            if extra_square_images:
                extra_refs_tensor = torch.stack(extra_square_images, dim=0)
                extra_masks_tensor = torch.stack(extra_square_masks, dim=0)

                # Concatenate with existing ref_images and ref_masks
                ref_images = torch.cat([ref_images, extra_refs_tensor], dim=0)
                ref_masks = torch.cat([ref_masks, extra_masks_tensor], dim=0)

                print(f"[PrepareRefs INFO] Added {num_extra_refs} extra refs. New ref_images shape: {ref_images.shape}")

        # Align batch sizes: if base batch size greater than refs, pad refs
        ref_batch_size = ref_images.shape[0]
        base_batch_size = internal_processing_image.shape[0]
        if base_batch_size > ref_batch_size:
            extra_count = base_batch_size - ref_batch_size
            extra_channels = ref_images.shape[-1]
            extra_images = torch.zeros((extra_count, max_dim, max_dim, extra_channels), dtype=ref_images.dtype, device=ref_images.device)
            ref_images = torch.cat([ref_images, extra_images], dim=0)

            extra_masks = torch.zeros((extra_count, max_dim, max_dim), dtype=ref_masks.dtype, device=ref_masks.device)
            ref_masks = torch.cat([ref_masks, extra_masks], dim=0)

        # Build ui_out
        ui_out = {"bg_image_dims": [{"width": float(width), "height": float(height)}]}

        # Save bg preview if bg_image provided
        if bg_image is not None:
            try:
                save_bg_preview(bg_image, Path(__file__).parent.parent / "web" / "power_spline_editor" / "bg")
                ui_out["bg_image_path"] = ["bg/bg_image.png"]
            except Exception as exc:
                print(f"[PrepareRefs WARNING] Failed to save bg preview: {exc}")

        # Save input-like ref images (converted to PIL) and record ui paths
        ref_paths = []
        try:
            # ensure CPU for PIL conversion
            if ref_images.device != torch.device("cpu"):
                ref_images_cpu = ref_images.cpu()
            else:
                ref_images_cpu = ref_images

            transform_to_pil = transforms.ToPILImage()
            ref_folder = Path(__file__).parent.parent / "web" / "power_spline_editor" / "ref"
            ensure_dir(ref_folder)

            for idx in range(ref_images_cpu.shape[0]):
                if idx < len(valid_ref_layers):
                    layer_name = valid_ref_layers[idx].get("name", f"ref_{idx + 1}")
                else:
                    layer_name = f"ref_{idx + 1}"

                img_tensor = ref_images_cpu[idx]

                # Normalize and permute CHW/HWC as needed for torchvision
                if img_tensor.dim() == 3:
                    # If channels last (HWC) and last dim is channels, torchvision expects CHW
                    if img_tensor.shape[0] not in (3, 4) and img_tensor.shape[2] in (3, 4):
                        img_tensor = img_tensor.permute(2, 0, 1)
                    elif img_tensor.shape[0] in (3, 4) and img_tensor.shape[2] not in (3, 4):
                        # already CHW
                        pass
                elif img_tensor.dim() == 2:
                    img_tensor = img_tensor.unsqueeze(0).repeat(3, 1, 1)

                img_tensor = clamp_float_tensor(img_tensor)
                pil_img = transform_to_pil(img_tensor)
                rel_path = save_image_to_ref_folder(pil_img, layer_name, ref_folder)
                if rel_path:
                    ref_paths.append(rel_path)

            if ref_paths:
                ui_out["ref_images_paths"] = ref_paths
        except Exception as e:
            print(f"[PrepareRefs ERROR] saving input ref images failed: {e}")

        # Save output images (clean bg_image) and ref images/masks per-layer
        try:
            # Save output bg_image_cl.png
            if output_bg_image is not None:
                out_ref_folder = Path(__file__).parent.parent / "web" / "power_spline_editor" / "ref"
                ensure_dir(out_ref_folder)
                # prepare a PIL image
                bg_img = output_bg_image
                if bg_img.device != torch.device("cpu"):
                    bg_img = bg_img.cpu()
                transform_to_pil = transforms.ToPILImage()
                img_tensor = bg_img[0]
                if img_tensor.dim() == 3 and img_tensor.shape[2] == 3:
                    img_tensor = img_tensor.permute(2, 0, 1)
                img_tensor = clamp_float_tensor(img_tensor)
                pil = transform_to_pil(img_tensor)
                if pil.mode not in ("RGB", "RGBA"):
                    pil = pil.convert("RGB")
                pil.save(str(out_ref_folder / "bg_image_cl.png"), format="PNG")
        except Exception as e:
            print(f"[PrepareRefs ERROR] failed to save bg_image_cl: {e}")

        # Save final per-layer ref images and masks (named by layer)
        try:
            ref_folder = Path(__file__).parent.parent / "web" / "power_spline_editor" / "ref"
            ensure_dir(ref_folder)

            # Save ref_images outputs with layer names
            if ref_images.device != torch.device("cpu"):
                ref_imgs_cpu = ref_images.cpu()
            else:
                ref_imgs_cpu = ref_images

            transform_to_pil = transforms.ToPILImage()
            for idx in range(ref_imgs_cpu.shape[0]):
                if idx < len(valid_ref_layers):
                    layer_name = valid_ref_layers[idx].get("name", f"ref_{idx + 1}")
                else:
                    layer_name = f"ref_{idx + 1}"

                img_tensor = ref_imgs_cpu[idx]
                # ensure CHW for ToPILImage
                if img_tensor.dim() == 3 and img_tensor.shape[2] == 3:
                    img_tensor = img_tensor.permute(2, 0, 1)

                img_tensor = clamp_float_tensor(img_tensor)
                pil_img = transform_to_pil(img_tensor)
                if pil_img.mode not in ("RGB", "RGBA"):
                    pil_img = pil_img.convert("RGB")
                pil_img.save(str(ref_folder / f"{layer_name}.png"), format="PNG")
        except Exception as e:
            print(f"[PrepareRefs ERROR] failed to save final ref images: {e}")

        # Save masks
        try:
            ref_folder = Path(__file__).parent.parent / "web" / "power_spline_editor" / "ref"
            save_masks_to_folder(ref_masks, valid_ref_layers, ref_folder)
        except Exception as e:
            print(f"[PrepareRefs ERROR] failed to save ref masks: {e}")

        return {"ui": ui_out, "result": (output_bg_image, ref_images, ref_masks)}

    # -------------------------
    # Internal helper
    # -------------------------
    def _resolve_base_images(self, mask_width: int, mask_height: int, bg_image: Optional[torch.Tensor]):
        """
        Determine final width/height and internal images used during processing.
        Returns (width, height, output_bg_image, internal_processing_image)
        """
        final_w = int(mask_width)
        final_h = int(mask_height)

        output_bg_image = None
        internal_processing_image = None

        if bg_image is not None:
            # bg_image expected shape: [B,H,W,C] or [1,H,W,C]
            final_h = bg_image.shape[1]
            final_w = bg_image.shape[2]
            output_bg_image = bg_image
            internal_processing_image = bg_image
        else:
            output_bg_image = torch.zeros((1, final_h, final_w, DEFAULT_BG_CHANNELS), dtype=torch.float32)
            internal_processing_image = output_bg_image

        return final_w, final_h, output_bg_image, internal_processing_image