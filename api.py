import json
import base64
from aiohttp import web
from server import PromptServer
import os
from PIL import Image
from io import BytesIO
import folder_paths
import subprocess
import sys


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

def get_lora_full_path(lora_name):
    """Get the full path to a LoRA file"""
    try:
        # Get the LoRA folder paths from ComfyUI
        lora_folders = folder_paths.get_folder_paths("loras")

        # Search for the LoRA file in all LoRA folders
        for folder in lora_folders:
            lora_path = os.path.join(folder, lora_name)
            if os.path.exists(lora_path):
                return os.path.abspath(lora_path)

            # Also check for common extensions if not provided
            if not lora_name.lower().endswith(('.safetensors', '.ckpt', '.pt')):
                for ext in ['.safetensors', '.ckpt', '.pt']:
                    lora_path_with_ext = os.path.join(folder, lora_name + ext)
                    if os.path.exists(lora_path_with_ext):
                        return os.path.abspath(lora_path_with_ext)

        return None
    except Exception as e:
        print(f"Error finding LoRA path: {e}")
        return None

@PromptServer.instance.routes.post("/wanvideo_wrapper/open_explorer")
async def open_explorer(request):
    """API endpoint to open Windows Explorer at the LoRA file location"""
    try:
        if not sys.platform.startswith('win'):
            return web.json_response({"error": "This feature is only available on Windows"}, status=400)

        post = await request.post()
        data = await request.json() if request.content_type == 'application/json' else {}

        lora_name = data.get("lora_name") or post.get("lora_name")

        if not lora_name:
            return web.json_response({"error": "No LoRA name provided"}, status=400)

        # Get the full path to the LoRA file
        lora_path = get_lora_full_path(lora_name)

        if not lora_path:
            return web.json_response({"error": f"LoRA file not found: {lora_name}"}, status=404)

        # Open Windows Explorer and select the file
        try:
            # Use start command to open Explorer with the file selected
            subprocess.run(['explorer', '/select,', lora_path], check=True, shell=False)
            return web.json_response({"success": True, "path": lora_path})
        except subprocess.CalledProcessError as e:
            # Fallback: open the folder if selecting the file fails
            try:
                folder_path = os.path.dirname(lora_path)
                subprocess.run(['explorer', folder_path], check=True, shell=False)
                return web.json_response({"success": True, "path": folder_path, "message": "Opened folder instead of selecting file"})
            except subprocess.CalledProcessError as e2:
                return web.json_response({"error": f"Failed to open Explorer: {str(e2)}"}, status=500)

    except Exception as e:
        print(f"Error opening Explorer: {e}")
        import traceback
        traceback.print_exc()
        return web.json_response({"error": str(e)}, status=500)

@PromptServer.instance.routes.post("/wanvideo_wrapper/get_lora_path")
async def get_lora_path(request):
    """API endpoint to get the full path of a LoRA file"""
    try:
        post = await request.post()
        data = await request.json() if request.content_type == 'application/json' else {}

        lora_name = data.get("lora_name") or post.get("lora_name")

        if not lora_name:
            return web.json_response({"error": "No LoRA name provided"}, status=400)

        # Get the full path to the LoRA file
        lora_path = get_lora_full_path(lora_name)

        if not lora_path:
            return web.json_response({"error": f"LoRA file not found: {lora_name}"}, status=404)

        return web.json_response({"success": True, "path": lora_path})

    except Exception as e:
        print(f"Error getting LoRA path: {e}")
        import traceback
        traceback.print_exc()
        return web.json_response({"error": str(e)}, status=500)

@PromptServer.instance.routes.post("/wanvideo_wrapper/rename_lora")
async def rename_lora(request):
    """API endpoint to rename a LoRA file and its associated files"""
    try:
        post = await request.post()
        data = await request.json() if request.content_type == 'application/json' else {}

        old_name = data.get("old_name") or post.get("old_name")
        new_name = data.get("new_name") or post.get("new_name")
        variant = data.get("variant") or post.get("variant", "high")

        if not old_name:
            return web.json_response({"error": "No old LoRA name provided"}, status=400)

        if not new_name:
            return web.json_response({"error": "No new LoRA name provided"}, status=400)

        # Get the full path to the LoRA file
        old_lora_path = get_lora_full_path(old_name)

        if not old_lora_path:
            return web.json_response({"error": f"LoRA file not found: {old_name}"}, status=404)

        # Get the directory and file extension
        lora_dir = os.path.dirname(old_lora_path)
        old_base_name = os.path.splitext(os.path.basename(old_lora_path))[0]
        lora_ext = os.path.splitext(old_lora_path)[1]

        # Create the new file paths
        new_lora_path = os.path.join(lora_dir, f"{new_name}{lora_ext}")

        # Check if new file already exists
        if os.path.exists(new_lora_path):
            return web.json_response({"error": f"A file with the name '{new_name}{lora_ext}' already exists"}, status=409)

        # Rename the main LoRA file
        try:
            os.rename(old_lora_path, new_lora_path)
            print(f"Renamed LoRA: {old_lora_path} -> {new_lora_path}")
        except Exception as e:
            return web.json_response({"error": f"Failed to rename LoRA file: {str(e)}"}, status=500)

        # Rename associated files (JSON and preview images)
        renamed_files = [new_lora_path]

        # Determine if this is a model or LoRA based on file path
        is_model = any(old_lora_path.startswith(folder) for folder in folder_paths.get_folder_paths("checkpoints"))

        if is_model:
            # Handle model files - check checkpoints directory
            model_folders = folder_paths.get_folder_paths("checkpoints")
            for folder in model_folders:
                # Look for _power_preview subfolder
                preview_folder = os.path.join(folder, "_power_preview")
                if os.path.exists(preview_folder):
                    renamed_files.extend(_rename_preview_files(old_base_name, new_name, preview_folder))
        else:
            # Handle LoRA files - check loras directory
            lora_folders = folder_paths.get_folder_paths("loras")
            for folder in lora_folders:
                # Look for _power_preview subfolder
                preview_folder = os.path.join(folder, "_power_preview")
                if os.path.exists(preview_folder):
                    renamed_files.extend(_rename_preview_files(old_base_name, new_name, preview_folder))

        return web.json_response({
            "success": True,
            "message": f"Successfully renamed LoRA and {len(renamed_files)-1} associated files",
            "new_high_path": new_lora_path,
            "new_low_path": new_lora_path,  # For high variant, low path is the same
            "renamed_files": renamed_files
        })

    except Exception as e:
        print(f"Error renaming LoRA: {e}")
        import traceback
        traceback.print_exc()
        return web.json_response({"error": str(e)}, status=500)

def _rename_preview_files(old_base_name, new_name, preview_folder):
    """Helper function to rename preview files (JSON and images) in a preview folder."""
    renamed_files = []

    try:
        # Rename JSON file
        old_json_path = os.path.join(preview_folder, f"{old_base_name}.json")
        new_json_path = os.path.join(preview_folder, f"{new_name}.json")
        if os.path.exists(old_json_path):
            try:
                os.rename(old_json_path, new_json_path)
                renamed_files.append(new_json_path)
                print(f"Renamed JSON: {old_json_path} -> {new_json_path}")
            except Exception as e:
                print(f"Warning: Failed to rename JSON file: {e}")

        # Rename preview images (with various suffixes)
        for suffix in ["_01", "_02", "_03", "_thumb"]:
            for ext in [".jpg", ".jpeg", ".png", ".webp"]:
                old_img_path = os.path.join(preview_folder, f"{old_base_name}{suffix}{ext}")
                new_img_path = os.path.join(preview_folder, f"{new_name}{suffix}{ext}")
                if os.path.exists(old_img_path):
                    try:
                        os.rename(old_img_path, new_img_path)
                        renamed_files.append(new_img_path)
                        print(f"Renamed image: {old_img_path} -> {new_img_path}")
                    except Exception as e:
                        print(f"Warning: Failed to rename image file: {e}")

        # Also check for image without suffix (backward compatibility)
        for ext in [".jpg", ".jpeg", ".png", ".webp"]:
            old_img_path = os.path.join(preview_folder, f"{old_base_name}{ext}")
            new_img_path = os.path.join(preview_folder, f"{new_name}{ext}")
            if os.path.exists(old_img_path):
                try:
                    os.rename(old_img_path, new_img_path)
                    renamed_files.append(new_img_path)
                    print(f"Renamed image: {old_img_path} -> {new_img_path}")
                except Exception as e:
                    print(f"Warning: Failed to rename image file: {e}")

    except Exception as e:
        print(f"Error in _rename_preview_files: {e}")

    return renamed_files

