import json
import base64
from aiohttp import web
from server import PromptServer
import os
from PIL import Image
from io import BytesIO
import folder_paths


import os
import folder_paths
from datetime import datetime

def get_bg_folder_path():
    """Get the path to the bg folder where A.jpg and ref_image.jpg are stored"""
    # Look for the bg folder relative to this file
    import pathlib
    current_dir = pathlib.Path(__file__).parent
    bg_path = current_dir / "web" / "power_spline_editor" / "bg"
    
    # Create the directory if it doesn't exist
    bg_path.mkdir(parents=True, exist_ok=True)
    
    return str(bg_path)

@PromptServer.instance.routes.post("/wanvideowrapper_qq/save_ref_image")
async def save_ref_image(request):
    """API endpoint to save ref_image to the bg folder"""
    try:
        post = await request.post()
        image_data = post.get("image")
        
        if not image_data:
            return web.json_response({"error": "No image data provided"}, status=400)
        
        # Decode base64 image data
        if image_data.startswith('data:image'):
            # Remove data URL prefix (e.g., "data:image/png;base64,")
            header, encoded = image_data.split(',', 1)
            image_format = header.split('/')[1].split(';')[0]  # Extract format like 'png' or 'jpeg'
        else:
            encoded = image_data
            image_format = 'png'  # Default to PNG
        
        # Decode the base64 string
        image_bytes = base64.b64decode(encoded)
        
        # Verify it's a valid image
        try:
            img = Image.open(BytesIO(image_bytes))
            img.verify()  # Verify it's a valid image
            img = Image.open(BytesIO(image_bytes))  # Reopen after verify
        except Exception as e:
            return web.json_response({"error": f"Invalid image data: {str(e)}"}, status=400)
        
        # Get the bg folder path
        bg_folder = get_bg_folder_path()
        ref_image_path = os.path.join(bg_folder, "ref_image.jpg")
        
        # Save the image as JPEG
        rgb_img = img.convert('RGB')
        rgb_img.save(ref_image_path, format='JPEG', quality=95)
        
        return web.json_response({"success": True, "path": ref_image_path, "message": "Reference image saved successfully"})

    except Exception as e:
        print(f"Error saving ref image: {e}")
        import traceback
        traceback.print_exc()
        return web.json_response({"error": str(e)}, status=500)

