import os
import sys
import torch
import numpy as np
import json
import subprocess
import tempfile
from PIL import Image
import datetime
import re
import folder_paths

def get_ffmpeg_path():
    """Minimal ffmpeg detection based on VideoHelperSuite approach"""
    # Check environment variable first
    ffmpeg_path = os.environ.get("VHS_FORCE_FFMPEG_PATH")
    if ffmpeg_path and os.path.exists(ffmpeg_path):
        return ffmpeg_path

    ffmpeg_paths = []

    # Try to use imageio-ffmpeg (same as VideoHelperSuite)
    try:
        from imageio_ffmpeg import get_ffmpeg_exe
        imageio_ffmpeg_path = get_ffmpeg_exe()
        if imageio_ffmpeg_path:
            ffmpeg_paths.append(imageio_ffmpeg_path)
    except ImportError:
        pass

    # Try system PATH
    if os.name == 'nt':  # Windows
        ffmpeg_names = ['ffmpeg.exe']
    else:  # Linux/Mac
        ffmpeg_names = ['ffmpeg']

    for name in ffmpeg_names:
        try:
            result = subprocess.run([name, '-version'], capture_output=True, check=True, timeout=5)
            ffmpeg_paths.append(name)
            break
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
            continue

    # Try common locations (same as VideoHelperSuite)
    if os.name == 'nt':
        common_paths = [
            os.path.abspath("ffmpeg.exe"),
            os.path.abspath(os.path.join(os.path.dirname(__file__), "ffmpeg.exe")),
        ]
    else:
        common_paths = [
            os.path.abspath("ffmpeg"),
            os.path.abspath(os.path.join(os.path.dirname(__file__), "ffmpeg")),
        ]

    for path in common_paths:
        if os.path.exists(path):
            ffmpeg_paths.append(path)

    # Return the best path (prioritize system PATH over bundled)
    if len(ffmpeg_paths) == 0:
        return None
    elif len(ffmpeg_paths) == 1:
        return ffmpeg_paths[0]
    else:
        # Prefer system ffmpeg over bundled ones
        return ffmpeg_paths[-1]

def tensor_to_bytes(tensor):
    """Convert tensor to bytes"""
    tensor = tensor.cpu().numpy()
    tensor = np.clip(tensor * 255, 0, 255).astype(np.uint8)
    return tensor

# Get ffmpeg path using minimal detection
FFMPEG_PATH = get_ffmpeg_path()

# Use a simple string for imageOrLatent to avoid JSON serialization issues
imageOrLatent = "IMAGE"

class WanVideoCacheSamples:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "cache_path": ("STRING", {"default": "cache_data", "multiline": False}),
                "cache_name": ("STRING", {"default": "wanvideo_cached_samples.pt", "multiline": False}),
                "save_over": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "samples": ("LATENT", {"forceInput": True}),
            }
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("samples",)
    FUNCTION = "cache_or_load_samples"
    CATEGORY = "WanVideoWrapper_QQ/utils"

    def cache_or_load_samples(self, cache_path, cache_name, save_over, samples=None):
        # Get ComfyUI's output directory
        output_dir = folder_paths.get_output_directory()

        # Sanitize cache_path to prevent it from being an absolute path
        # and ensure it's just a directory name.
        sanitized_cache_path = os.path.basename(cache_path)

        # The cache directory will be inside ComfyUI's output directory.
        full_cache_dir = os.path.join(output_dir, sanitized_cache_path)
        os.makedirs(full_cache_dir, exist_ok=True)

        full_cache_file_path = os.path.join(full_cache_dir, cache_name)

        if save_over:
            # Save over mode: use input samples and cache them
            if samples is not None:
                print(f"WanVideoCacheSamples: Caching samples to {full_cache_file_path}")
                torch.save(samples, full_cache_file_path)
                return (samples,)
            else:
                # No samples provided, try to load from cache as fallback
                if os.path.exists(full_cache_file_path):
                    print(f"WanVideoCacheSamples: No input provided, loading samples from cache {full_cache_file_path}")
                    loaded_samples = torch.load(full_cache_file_path)
                    return (loaded_samples,)
                else:
                    raise FileNotFoundError(f"WanVideoCacheSamples: No samples provided and no cached samples found at {full_cache_file_path}")
        else:
            # Load-only mode: ignore input, only load from cache
            if os.path.exists(full_cache_file_path):
                print(f"WanVideoCacheSamples: Load-only mode - loading samples from cache {full_cache_file_path}")
                loaded_samples = torch.load(full_cache_file_path)
                return (loaded_samples,)
            else:
                raise FileNotFoundError(f"WanVideoCacheSamples: Load-only mode - no cached samples found at {full_cache_file_path}")


class WanVideoCacheVideos:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "cache_path": ("STRING", {"default": "cache_data", "multiline": False}),
                "cache_name": ("STRING", {"default": "wanvideo_cached_video.mp4", "multiline": False}),
                "save_over": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "images": (imageOrLatent, {"forceInput": True}),
                "save_multiple": ("BOOLEAN", {"default": False}),
                "use_multi_cached": ("BOOLEAN", {"default": False}),
                "cache_num": ("INT", {"default": 1, "min": 1, "max": 999, "step": 1}),
            }
        }

    RETURN_TYPES = (imageOrLatent,)
    RETURN_NAMES = ("images",)
    FUNCTION = "cache_or_load_videos"
    CATEGORY = "WanVideoWrapper_QQ/utils"

    def cache_or_load_videos(self, cache_path, cache_name, save_over, images=None, save_multiple=False, use_multi_cached=False, cache_num=1):
        # Get ComfyUI's output directory
        output_dir = folder_paths.get_output_directory()

        # Sanitize cache_path to prevent it from being an absolute path
        # and ensure it's just a directory name.
        sanitized_cache_path = os.path.basename(cache_path)

        # The cache directory will be inside ComfyUI's output directory.
        full_cache_dir = os.path.join(output_dir, sanitized_cache_path)
        os.makedirs(full_cache_dir, exist_ok=True)

        full_cache_file_path = os.path.join(full_cache_dir, cache_name)

        if FFMPEG_PATH is None:
            raise Exception("ffmpeg is required for MP4 video caching but VideoHelperSuite could not find it.\n\nTo fix this:\n1. Make sure VideoHelperSuite is properly installed (Video Combine 🎥🅥🅗🅢 node should work)\n2. If Video Combine works but this doesn't, there may be a path issue\n3. Try installing imageio-ffmpeg: pip install imageio-ffmpeg\n4. Or install ffmpeg system-wide from https://ffmpeg.org/download.html")

        if save_over:
            # Save over mode: use input images and cache them as MP4
            if images is not None:
                # Determine the actual filename to save
                if save_multiple:
                    actual_save_path = self._get_cache_filename(full_cache_file_path, save_multiple=True)
                    print(f"WanVideoCacheVideos: Saving images as MP4 to {actual_save_path} (multiple cache mode)")
                else:
                    actual_save_path = full_cache_file_path
                    print(f"WanVideoCacheVideos: Saving images as MP4 to {actual_save_path}")

                self._save_images_as_mp4(images, actual_save_path)
                return (images,)
            else:
                # No images provided, try to load from cache as fallback
                cache_file = self._find_cached_file(full_cache_file_path, use_multi_cached, cache_num)
                if cache_file:
                    print(f"WanVideoCacheVideos: No input provided, loading images from MP4 {cache_file}")
                    loaded_images = self._load_images_from_mp4(cache_file)
                    return (loaded_images,)
                else:
                    raise FileNotFoundError(f"WanVideoCacheVideos: No images provided and no cached MP4 file found (searched for numbered versions up to {cache_num})")
        else:
            # Load-only mode: ignore input, only load from MP4 cache
            cache_file = self._find_cached_file(full_cache_file_path, use_multi_cached, cache_num)
            if cache_file:
                print(f"WanVideoCacheVideos: Load-only mode - loading images from MP4 {cache_file}")
                loaded_images = self._load_images_from_mp4(cache_file)
                return (loaded_images,)
            else:
                if use_multi_cached:
                    raise FileNotFoundError(f"WanVideoCacheVideos: Load-only mode - no cached MP4 file found for cache_num {cache_num} (tried base filename too)")
                else:
                    raise FileNotFoundError(f"WanVideoCacheVideos: Load-only mode - no cached MP4 file found at {full_cache_file_path}")

    def _save_images_as_mp4(self, images, output_path):
        """Save images as MP4 video with 16 fps, H.264, CRF 18"""
        if FFMPEG_PATH is None:
            raise Exception("ffmpeg is required for MP4 caching but could not be found")

        try:
            # Handle both IMAGE and LATENT formats
            if isinstance(images, dict) and "samples" in images:
                # LATENT format - convert to images (basic conversion)
                latent_samples = images["samples"]
                if latent_samples.dim() == 4:
                    # Convert from latent space to pixel space
                    images_np = ((latent_samples * 0.5 + 0.5) * 255).clamp(0, 255).cpu().numpy().astype(np.uint8)
                    images_np = np.transpose(images_np, (0, 2, 3, 1))  # NCHW -> NHWC
                else:
                    raise ValueError(f"Unexpected latent tensor shape: {latent_samples.shape}")
            else:
                # IMAGE format - ensure it's in the right format
                if torch.is_tensor(images):
                    images_np = images.cpu().numpy()
                else:
                    images_np = images

                if images_np.ndim == 4:
                    # Handle different tensor formats
                    if images_np.shape[1] in [3, 4]:  # NCHW format
                        images_np = np.transpose(images_np, (0, 2, 3, 1))  # NCHW -> NHWC
                    images_np = (images_np * 255).astype(np.uint8)

            # Get dimensions from first frame
            if len(images_np) == 0:
                raise ValueError("No images to save")

            first_frame = images_np[0]
            height, width = first_frame.shape[:2]
            has_alpha = first_frame.shape[-1] == 4

            # Choose pixel format
            if has_alpha:
                i_pix_fmt = 'rgba'
                o_pix_fmt = 'yuva420p'
            else:
                i_pix_fmt = 'rgb24'
                o_pix_fmt = 'yuv420p'

            # Prepare ffmpeg arguments (16 fps, H.264, CRF 18)
            frame_rate = 16
            args = [
                FFMPEG_PATH, "-y",  # Overwrite output file
                "-f", "rawvideo",
                "-pix_fmt", i_pix_fmt,
                "-s", f"{width}x{height}",
                "-r", str(frame_rate),
                "-i", "-",
                "-c:v", "libx264",
                "-crf", "18",
                "-pix_fmt", o_pix_fmt,
                "-r", str(frame_rate),
                output_path
            ]

            # Process frames and send to ffmpeg
            process = subprocess.Popen(args,
                                     stdin=subprocess.PIPE,
                                     stderr=subprocess.PIPE,
                                     env=os.environ.copy())

            try:
                for img_np in images_np:
                    # Convert frame to bytes and send to ffmpeg
                    frame_bytes = img_np.astype(np.uint8).tobytes()
                    process.stdin.write(frame_bytes)

                process.stdin.close()
                stderr_output = process.stderr.read()

                return_code = process.wait()
                if return_code != 0:
                    error_msg = stderr_output.decode('utf-8', errors='ignore') if stderr_output else "Unknown ffmpeg error"
                    raise Exception(f"FFmpeg error (code {return_code}): {error_msg}")
                elif stderr_output:
                    print(f"FFmpeg warning: {stderr_output.decode('utf-8', errors='ignore')}")

                print(f"WanVideoCacheVideos: Successfully saved MP4 to {output_path}")

            except BrokenPipeError as e:
                process.stdin.close()
                stderr_output = process.stderr.read()
                error_msg = stderr_output.decode('utf-8', errors='ignore') if stderr_output else "Broken pipe error"
                raise Exception(f"FFmpeg broken pipe: {error_msg}")

        except Exception as e:
            print(f"WanVideoCacheVideos: Error saving MP4: {e}")
            raise e

    def _get_cache_filename(self, base_path, save_multiple=False):
        """Generate cache filename with number suffix if save_multiple is True"""
        if not save_multiple:
            return base_path

        # Split filename and extension
        name, ext = os.path.splitext(base_path)

        # Find the next available number
        num = 1
        while True:
            if num < 10:
                suffix = f"_0{num}"
            else:
                suffix = f"_{num}"

            new_filename = f"{name}{suffix}{ext}"
            if not os.path.exists(new_filename):
                return new_filename
            num += 1

    def _find_cached_file(self, base_path, use_multi_cached=False, cache_num=1):
        """Find cached file with optional number suffix"""
        if not use_multi_cached:
            # Try base filename first
            if os.path.exists(base_path):
                return base_path
            else:
                return None

        # Try numbered version
        name, ext = os.path.splitext(base_path)
        if cache_num < 10:
            suffix = f"_0{cache_num}"
        else:
            suffix = f"_{cache_num}"

        numbered_filename = f"{name}{suffix}{ext}"
        if os.path.exists(numbered_filename):
            return numbered_filename

        # If numbered version not found, fall back to base filename
        if os.path.exists(base_path):
            return base_path

        return None

    def _load_images_from_mp4(self, video_path):
        """Load frames from MP4 video"""
        if FFMPEG_PATH is None:
            raise Exception("ffmpeg is required for MP4 loading but could not be found")

        try:
            # First get video info to get dimensions
            info_cmd = [FFMPEG_PATH, '-i', video_path]
            result = subprocess.run(info_cmd, capture_output=True, text=True)

            width, height = None, None

            # Parse ffmpeg output for dimensions
            import re
            dimension_match = re.search(r'(\d{3,4})x(\d{3,4})', result.stderr)
            if dimension_match:
                width, height = int(dimension_match.group(1)), int(dimension_match.group(2))
                print(f"Detected video dimensions: {width}x{height}")

            if width is None or height is None:
                # Try ffprobe as backup
                ffprobe_path = FFMPEG_PATH.replace('ffmpeg', 'ffprobe') if 'ffmpeg' in FFMPEG_PATH else None
                if ffprobe_path and os.path.exists(ffprobe_path):
                    try:
                        probe_cmd = [ffprobe_path, '-v', 'error', '-select_streams', 'v:0',
                                   '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', video_path]
                        probe_result = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=10)
                        if probe_result.returncode == 0 and probe_result.stdout.strip():
                            dims = probe_result.stdout.strip().split(',')
                            if len(dims) >= 2:
                                width, height = int(dims[0]), int(dims[1])
                                print(f"Probed video dimensions: {width}x{height}")
                    except Exception as probe_error:
                        print(f"Warning: ffprobe failed: {probe_error}")

            # If still no dimensions, try inference from common sizes
            if width is None or height is None:
                print("Could not detect dimensions, trying inference...")
                # First, get a small sample of frame data
                sample_cmd = [FFMPEG_PATH, '-i', video_path, '-frames:v', '1',
                             '-f', 'image2pipe', '-pix_fmt', 'rgb24', '-vcodec', 'rawvideo', '-']
                sample_result = subprocess.run(sample_cmd, capture_output=True)
                sample_data = sample_result.stdout

                # Try common video dimensions
                common_sizes = [(320, 240), (480, 270), (512, 512), (640, 360), (640, 480),
                               (720, 405), (720, 480), (854, 480), (1280, 720), (1920, 1080)]

                for w, h in common_sizes:
                    frame_size = w * h * 3  # RGB24
                    if len(sample_data) == frame_size:
                        width, height = w, h
                        print(f"Inferred video dimensions from sample: {width}x{height}")
                        break

                if width is None or height is None:
                    raise Exception(f"Could not determine video dimensions. Sample data size: {len(sample_data)} bytes")

            # Now extract all frames at 16 fps
            cmd = [
                FFMPEG_PATH, '-i', video_path,
                '-vf', 'fps=16',  # Ensure 16 fps loading
                '-f', 'image2pipe',
                '-pix_fmt', 'rgb24',
                '-vcodec', 'rawvideo',
                '-'
            ]

            result = subprocess.run(cmd, check=True, capture_output=True)
            frame_data = result.stdout

            if not frame_data:
                raise Exception("No frame data received from ffmpeg")

            # Calculate frame count
            frame_size = width * height * 3  # RGB24
            frame_count = len(frame_data) // frame_size

            if frame_count == 0:
                raise Exception(f"No complete frames found in video data. Data size: {len(frame_data)}, Frame size: {frame_size}")

            # Verify frame data integrity
            if len(frame_data) % frame_size != 0:
                print(f"Warning: Frame data size ({len(frame_data)}) is not perfectly divisible by frame size ({frame_size})")
                frame_count = len(frame_data) // frame_size
                print(f"Using {frame_count} complete frames, discarding {len(frame_data) % frame_size} bytes")

            # Reshape into numpy array
            frames = np.frombuffer(frame_data, dtype=np.uint8).reshape((frame_count, height, width, 3))

            # Convert to torch tensor (NHWC format as expected by ComfyUI)
            images_tensor = torch.from_numpy(frames).float() / 255.0

            print(f"WanVideoCacheVideos: Successfully loaded {frame_count} frames ({width}x{height}) from {video_path}")
            return images_tensor

        except Exception as e:
            print(f"WanVideoCacheVideos: Error loading MP4: {e}")
            raise e

# Update the node mappings to include the new class
NODE_CLASS_MAPPINGS = {
    "WanVideoCacheSamples": WanVideoCacheSamples,
    "WanVideoCacheVideos": WanVideoCacheVideos
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WanVideoCacheSamples": "WanVideo Cache Samples",
    "WanVideoCacheVideos": "WanVideo Cache Videos"
}
