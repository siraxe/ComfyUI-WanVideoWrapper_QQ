from server import PromptServer
from aiohttp import web
import base64
from io import BytesIO
from PIL import Image
import torch
import numpy as np
from pathlib import Path
import os
import folder_paths

# Import PrepareRefs class
from .prepare_refs import PrepareRefs
from .video_background_handler import should_create_video, save_frames_as_video


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

        # Decode bg_image to tensor (supports both single images and video frames)
        bg_tensor = None
        bg_is_video = False
        if bg_image_b64:
            # Check if bg_image_b64 is a list (video frames) or string (single image)
            if isinstance(bg_image_b64, list):
                # Multiple frames - video
                bg_is_video = True
                bg_frames = []
                for idx, frame_b64 in enumerate(bg_image_b64):
                    # Remove data URL prefix if present
                    if frame_b64.startswith('data:image'):
                        frame_b64 = frame_b64.split(',', 1)[1]

                    image_bytes = base64.b64decode(frame_b64)
                    pil_img = Image.open(BytesIO(image_bytes))

                    # Convert to RGB if needed
                    if pil_img.mode != 'RGB':
                        pil_img = pil_img.convert('RGB')

                    # Convert to tensor [H, W, C]
                    frame_tensor = pil_to_tensor(pil_img)
                    bg_frames.append(frame_tensor)

                # Stack into [B, H, W, C]
                bg_tensor = torch.stack(bg_frames, dim=0)
                print(f"[trigger_prepare_refs] Decoded bg_video: {len(bg_frames)} frames, shape: {bg_tensor.shape}")
            else:
                # Single image
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

        # Serialize ref_layer_data to JSON string (PrepareRefs expects STRING parameter)
        import json
        ref_layer_data_json = json.dumps(ref_layer_data) if ref_layer_data else "[]"

        # Create PrepareRefs instance and execute
        print(f"[trigger_prepare_refs] Calling PrepareRefs.prepare()...")
        prep_refs = PrepareRefs()
        result = prep_refs.prepare(
            mask_width=mask_width,
            mask_height=mask_height,
            internal_state="{}",
            export_filename="",
            ref_layer_data=ref_layer_data_json,
            bg_image=bg_tensor,
            extra_refs=extra_refs_tensor,
            unique_id="unique_id",
            prompt=None
        )

        # Extract paths from result
        ui_data = result.get("ui", {})
        paths = {
            "bg_image_cl": ui_data.get("bg_image_path", [None])[0],
            "bg_preview": ui_data.get("bg_image_preview_path", [None])[0],
            "ref_images": ui_data.get("ref_images_paths", []),
            "ref_masks": ui_data.get("ref_masks_paths", [])
        }

        # Handle video background if bg_image was a video
        if bg_is_video and bg_tensor is not None and should_create_video(bg_tensor):
            try:
                # Get the web directory path - SAVE TO power_spline_editor FOLDER
                web_dir = Path(__file__).parent.parent / "web" / "power_spline_editor"
                bg_folder = web_dir / "bg"
                bg_folder.mkdir(parents=True, exist_ok=True)
                video_path = bg_folder / "bg_video.mp4"

                # Calculate appropriate FPS
                num_frames = bg_tensor.shape[0]
                video_fps = min(30.0, max(12.0, float(num_frames) / 2.0)) if num_frames > 1 else 24.0

                print(f"[trigger_prepare_refs] Creating bg_video with {num_frames} frames at {video_fps} fps")

                # Save video
                video_metadata = save_frames_as_video(
                    images=bg_tensor,
                    output_path=str(video_path),
                    fps=video_fps,
                    codec="libx264",
                    quality=23
                )

                # Add video metadata to response
                paths["bg_video"] = {
                    "path": "power_spline_editor/bg/bg_video.mp4",  # UPDATED PATH
                    "num_frames": video_metadata["num_frames"],
                    "fps": video_metadata["fps"],
                    "width": video_metadata["width"],
                    "height": video_metadata["height"],
                    "duration": video_metadata["duration"]
                }

                print(f"[trigger_prepare_refs] bg_video created successfully: {video_metadata}")
            except Exception as e:
                print(f"[trigger_prepare_refs] WARNING: Failed to create bg_video: {e}")
                # Continue without video - not a critical error

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


@PromptServer.instance.routes.post("/wanvideowrapper_qq/process_video_file")
async def process_video_file(request):
    """
    Process video file from ComfyUI input folder and create bg_video.mp4

    Input JSON:
    {
        "video_filename": "video.mp4",
        "mask_width": 640,
        "mask_height": 480
    }

    Output JSON:
    {
        "success": true/false,
        "paths": {
            "bg_video": {
                "path": "bg/bg_video.mp4",
                "num_frames": 120,
                "fps": 24.0,
                "width": 1920,
                "height": 1080,
                "duration": 5.0
            }
        },
        "message": "Video processed successfully",
        "error": "error message if failed"
    }
    """
    try:
        import cv2

        data = await request.json()
        video_filename = data.get("video_filename")
        mask_width = data.get("mask_width", 640)
        mask_height = data.get("mask_height", 480)

        print(f"[process_video_file DEBUG] Received data: {data}")
        print(f"[process_video_file DEBUG] Video filename: {video_filename}")
        print(f"[process_video_file DEBUG] Mask dimensions: {mask_width}x{mask_height}")

        if not video_filename:
            print("[process_video_file DEBUG] No video_filename provided")
            return web.json_response({
                "success": False,
                "error": "No video_filename provided"
            }, status=400)

        print(f"[process_video_file] Processing video: {video_filename}")

        # Get ComfyUI input folder
        input_dir = folder_paths.get_input_directory()
        print(f"[process_video_file DEBUG] Input directory: {input_dir}")
        
        video_path = os.path.join(input_dir, video_filename)
        print(f"[process_video_file DEBUG] Full video path: {video_path}")

        if not os.path.exists(video_path):
            print(f"[process_video_file DEBUG] Video file not found at: {video_path}")
            return web.json_response({
                "success": False,
                "error": f"Video file not found: {video_filename}"
            }, status=404)

        # Load video with OpenCV
        cap = cv2.VideoCapture(video_path)
        print(f"[process_video_file DEBUG] OpenCV VideoCapture created")

        if not cap.isOpened():
            print(f"[process_video_file DEBUG] Could not open video file with OpenCV")
            return web.json_response({
                "success": False,
                "error": f"Could not open video file: {video_filename}"
            }, status=400)

        # Get video properties
        fps = cap.get(cv2.CAP_PROP_FPS)
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        print(f"[process_video_file] Video properties: {frame_count} frames, {fps} fps, {width}x{height}")
        print(f"[process_video_file DEBUG] Raw OpenCV values - FPS: {fps}, Frame Count: {frame_count}, Width: {width}, Height: {height}")

        # Read all frames
        frames = []
        frame_idx = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                print(f"[process_video_file DEBUG] Failed to read frame {frame_idx}, stopping")
                break

            # Convert BGR to RGB
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

            # Convert to tensor [H, W, C] in range [0, 1]
            frame_tensor = torch.from_numpy(frame_rgb).float() / 255.0
            frames.append(frame_tensor)
            frame_idx += 1
            
            # Log first few frames for debugging
            if frame_idx <= 3:
                print(f"[process_video_file DEBUG] Frame {frame_idx} shape: {frame_rgb.shape}")

        cap.release()
        print(f"[process_video_file DEBUG] VideoCapture released, read {len(frames)} frames")

        if len(frames) == 0:
            print(f"[process_video_file DEBUG] No frames were read from video")
            return web.json_response({
                "success": False,
                "error": "No frames could be read from video"
            }, status=400)

        # Stack into batch [B, H, W, C]
        frames_tensor = torch.stack(frames, dim=0)

        print(f"[process_video_file] Loaded {len(frames)} frames, tensor shape: {frames_tensor.shape}")

        # Create bg_video.mp4
        web_dir = Path(__file__).parent.parent / "web" / "power_spline_editor"  # UPDATED
        bg_folder = web_dir / "bg"
        bg_folder.mkdir(parents=True, exist_ok=True)
        output_video_path = bg_folder / "bg_video.mp4"

        print(f"[process_video_file DEBUG] Output directory: {bg_folder}")
        print(f"[process_video_file DEBUG] Output path: {output_video_path}")

        # Calculate appropriate FPS
        video_fps = fps if fps > 0 else 24.0
        print(f"[process_video_file DEBUG] Using FPS: {video_fps}")

        print(f"[process_video_file] Creating bg_video.mp4 with {len(frames)} frames at {video_fps} fps")

        # Save video
        try:
            video_metadata = save_frames_as_video(
                images=frames_tensor,
                output_path=str(output_video_path),
                fps=video_fps,
                codec="libx264",
                quality=23
            )
            print(f"[process_video_file DEBUG] save_frames_as_video returned: {video_metadata}")
        except Exception as save_error:
            print(f"[process_video_file DEBUG] Error in save_frames_as_video: {save_error}")
            import traceback
            traceback.print_exc()
            raise

        # Add path info
        result_metadata = {
            "path": "power_spline_editor/bg/bg_video.mp4",  # UPDATED PATH
            "num_frames": video_metadata["num_frames"],
            "fps": video_metadata["fps"],
            "width": video_metadata["width"],
            "height": video_metadata["height"],
            "duration": video_metadata["duration"]
        }

        print(f"[process_video_file] Video created successfully: {result_metadata}")

        return web.json_response({
            "success": True,
            "paths": {
                "bg_video": result_metadata
            },
            "message": f"Video processed successfully: {len(frames)} frames"
        })

    except Exception as e:
        print(f"[process_video_file] ERROR: {e}")
        import traceback
        traceback.print_exc()
        return web.json_response({
            "success": False,
            "error": str(e)
        }, status=500)
