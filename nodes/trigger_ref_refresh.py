from server import PromptServer
from aiohttp import web
import base64
from io import BytesIO
from PIL import Image
import torch
import numpy as np

# Import PrepareRefs class
from .prepare_refs import PrepareRefs


def pil_to_tensor(pil_img):
    """Convert PIL image to tensor [1, H, W, C] in range [0, 1]"""
    img_np = np.array(pil_img).astype(np.float32) / 255.0
    if len(img_np.shape) == 2:  # Grayscale
        img_np = np.stack([img_np] * 3, axis=-1)
    return torch.from_numpy(img_np)


@PromptServer.instance.routes.post("/wanvideowrapper_qq/trigger_prepare_refs")
async def trigger_prepare_refs(request):
    """
    Backend trigger to run PrepareRefs processing without node execution.

    Input JSON:
    {
        "bg_image": "data:image/png;base64,...",
        "ref_layer_data": [{name, on, lassoShape: {additivePaths}}],
        "mask_width": 640,
        "mask_height": 480,
        "extra_refs": ["data:image/png;base64,...", ...] (optional)
    }

    Note: export_alpha and to_bounding_box are always True (hardcoded in PrepareRefs).
    All ref images are exported as 768x768 PNG with alpha channel.
    If extra_refs are provided, they will be numbered starting from ref_N.png where N
    is the number of layers from ref_layer_data + 1.

    Output JSON:
    {
        "success": true/false,
        "paths": {
            "bg_image_cl": "ref/bg_image_cl.png",
            "bg_preview": "bg/bg_image.png",
            "ref_images": ["ref/ref_1.png", ...],
            "ref_masks": ["ref/ref_1_mask.png", ...]
        },
        "message": "PrepareRefs processing complete: N layers processed",
        "error": "error message if failed"
    }
    """
    try:
        data = await request.json()

        # Extract parameters
        bg_image_b64 = data.get("bg_image")
        ref_layer_data = data.get("ref_layer_data", [])
        mask_width = data.get("mask_width", 640)
        mask_height = data.get("mask_height", 480)
        extra_refs_b64 = data.get("extra_refs", [])

        print(f"[trigger_prepare_refs] Received request with {len(ref_layer_data)} layers, {len(extra_refs_b64)} extra_refs, dims: {mask_width}x{mask_height}")

        # Validate that we have at least one source of refs (layer data OR extra_refs)
        if (not ref_layer_data or len(ref_layer_data) == 0) and (not extra_refs_b64 or len(extra_refs_b64) == 0):
            return web.json_response({
                "success": False,
                "error": "No ref_layer_data or extra_refs provided"
            }, status=400)

        # Decode bg_image to tensor
        bg_tensor = None
        if bg_image_b64:
            # Remove data URL prefix if present
            if bg_image_b64.startswith('data:image'):
                bg_image_b64 = bg_image_b64.split(',', 1)[1]

            image_bytes = base64.b64decode(bg_image_b64)
            pil_img = Image.open(BytesIO(image_bytes))

            # Convert to RGB if needed
            if pil_img.mode != 'RGB':
                pil_img = pil_img.convert('RGB')

            print(f"[trigger_prepare_refs] Decoded bg_image: {pil_img.size}, mode: {pil_img.mode}")

            # Convert to tensor [1, H, W, C]
            bg_tensor = pil_to_tensor(pil_img).unsqueeze(0)

        # Decode extra_refs to tensor if provided
        extra_refs_tensor = None
        if extra_refs_b64 and len(extra_refs_b64) > 0:
            # Target size for all extra_refs is 768x768
            TARGET_SIZE = 768

            extra_ref_tensors = []
            for idx, ref_b64 in enumerate(extra_refs_b64):
                try:
                    # Remove data URL prefix if present
                    if ref_b64.startswith('data:image'):
                        ref_b64 = ref_b64.split(',', 1)[1]

                    image_bytes = base64.b64decode(ref_b64)
                    pil_img = Image.open(BytesIO(image_bytes))

                    print(f"[trigger_prepare_refs] Decoded extra_ref {idx + 1}: {pil_img.size}, mode: {pil_img.mode}")

                    # Convert to RGBA to match PrepareRefs export_alpha=True behavior
                    # Preserve original alpha if present
                    if pil_img.mode not in ('RGBA', 'LA'):
                        pil_img = pil_img.convert('RGBA')

                    # Find bounding box of visible (non-transparent) pixels
                    bbox = pil_img.getbbox()
                    if bbox:
                        # Crop to visible pixels only
                        pil_img = pil_img.crop(bbox)
                        print(f"[trigger_prepare_refs] Cropped extra_ref {idx + 1} to visible bbox: {pil_img.size}")

                    # Scale to 768x768 while preserving aspect ratio and filling as much as possible
                    img_ratio = pil_img.width / pil_img.height

                    if img_ratio > 1:
                        # Image is wider, fit to width
                        new_width = TARGET_SIZE
                        new_height = int(TARGET_SIZE / img_ratio)
                    else:
                        # Image is taller or square, fit to height
                        new_height = TARGET_SIZE
                        new_width = int(TARGET_SIZE * img_ratio)

                    # Resize to fill as much of 768x768 as possible
                    resized_img = pil_img.resize((new_width, new_height), Image.Resampling.LANCZOS)

                    # Create 768x768 canvas with transparent background
                    canvas = Image.new('RGBA', (TARGET_SIZE, TARGET_SIZE), (0, 0, 0, 0))

                    # Center the resized image
                    paste_x = (TARGET_SIZE - new_width) // 2
                    paste_y = (TARGET_SIZE - new_height) // 2
                    canvas.paste(resized_img, (paste_x, paste_y), resized_img)

                    pil_img = canvas
                    print(f"[trigger_prepare_refs] Scaled extra_ref {idx + 1} to 768x768 (visible content: {new_width}x{new_height})")

                    # Convert to tensor [H, W, C]
                    ref_tensor = pil_to_tensor(pil_img)
                    extra_ref_tensors.append(ref_tensor)

                except Exception as e:
                    print(f"[trigger_prepare_refs] WARNING: Failed to decode extra_ref {idx + 1}: {e}")
                    continue

            # Stack into batch [B, H, W, C]
            if extra_ref_tensors:
                extra_refs_tensor = torch.stack(extra_ref_tensors, dim=0)
                print(f"[trigger_prepare_refs] Stacked {len(extra_ref_tensors)} extra_refs into tensor: {extra_refs_tensor.shape}")

        # Construct prompt structure (PrepareRefs expects this format)
        prompt = {
            "unique_id": {
                "inputs": {
                    "ref_layer_data": ref_layer_data
                }
            }
        }

        # Create PrepareRefs instance and execute
        print(f"[trigger_prepare_refs] Calling PrepareRefs.prepare()...")
        prep_refs = PrepareRefs()
        result = prep_refs.prepare(
            mask_width=mask_width,
            mask_height=mask_height,
            bg_image=bg_tensor,
            extra_refs=extra_refs_tensor,
            unique_id="unique_id",  # Key used in prompt dict
            prompt=prompt
        )

        # Extract paths from result
        ui_data = result.get("ui", {})
        paths = {
            "bg_image_cl": ui_data.get("bg_image_path", [None])[0],
            "bg_preview": ui_data.get("bg_image_preview_path", [None])[0],
            "ref_images": ui_data.get("ref_images_paths", []),
            "ref_masks": ui_data.get("ref_masks_paths", [])
        }

        print(f"[trigger_prepare_refs] Processing complete. Generated paths: {paths}")

        # Calculate total refs processed
        total_refs = len(ref_layer_data) + len(extra_refs_b64)
        message = f"PrepareRefs processing complete: {len(ref_layer_data)} layers"
        if extra_refs_b64:
            message += f" + {len(extra_refs_b64)} extra refs = {total_refs} total refs processed"
        else:
            message += " processed"

        return web.json_response({
            "success": True,
            "paths": paths,
            "message": message
        })

    except Exception as e:
        print(f"[trigger_prepare_refs] ERROR: {e}")
        import traceback
        traceback.print_exc()
        return web.json_response({
            "success": False,
            "error": str(e)
        }, status=500)
