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
        "mask_height": 480
    }

    Note: export_alpha and to_bounding_box are always True (hardcoded in PrepareRefs).
    All ref images are exported as 768x768 PNG with alpha channel.

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

        print(f"[trigger_prepare_refs] Received request with {len(ref_layer_data)} layers, dims: {mask_width}x{mask_height}")

        # Validate layer data
        if not ref_layer_data or len(ref_layer_data) == 0:
            return web.json_response({
                "success": False,
                "error": "No ref_layer_data provided"
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

        return web.json_response({
            "success": True,
            "paths": paths,
            "message": f"PrepareRefs processing complete: {len(ref_layer_data)} layers processed"
        })

    except Exception as e:
        print(f"[trigger_prepare_refs] ERROR: {e}")
        import traceback
        traceback.print_exc()
        return web.json_response({
            "success": False,
            "error": str(e)
        }, status=500)
