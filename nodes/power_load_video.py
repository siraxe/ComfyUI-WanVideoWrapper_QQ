"""
Power Load Video - A video loading node with drag-and-drop upload support
Similar to LoadImage but for videos, with an integrated timeline UI.
"""

import os
import re
import subprocess
import cv2
import numpy as np
from PIL import Image
import torch
import folder_paths


def _find_ffmpeg():
    """Find ffmpeg executable."""
    # Check common locations
    candidates = []
    for cmd in ["ffmpeg", "ffmpeg.exe"]:
        # Check PATH
        import shutil
        path = shutil.which(cmd)
        if path:
            candidates.append(path)
    # Check relative to ComfyUI
    for rel in ["ffmpeg", "ffmpeg.exe", "../ffmpeg", "../ffmpeg.exe"]:
        p = os.path.abspath(os.path.join(os.path.dirname(__file__), rel))
        if os.path.isfile(p):
            candidates.append(p)
    return candidates[0] if candidates else "ffmpeg"


def extract_audio(file_path, start_time=0, duration=0):
    """Extract audio from a video file using ffmpeg.

    Args:
        file_path: Path to the video file.
        start_time: Start time in seconds.
        duration: Duration in seconds (0 = until end).

    Returns:
        dict: {"waveform": Tensor[1, C, T], "sample_rate": int} or None.
    """
    ffmpeg_path = _find_ffmpeg()
    args = [ffmpeg_path, "-i", file_path]
    if start_time > 0:
        args += ["-ss", str(start_time)]
    if duration > 0:
        args += ["-t", str(duration)]
    try:
        res = subprocess.run(
            args + ["-f", "f32le", "-"],
            capture_output=True, check=True,
        )
        audio = torch.frombuffer(bytearray(res.stdout), dtype=torch.float32)
        match = re.search(r', (\d+) Hz, (\w+), ', res.stderr.decode('utf-8', errors='replace'))
    except subprocess.CalledProcessError:
        return None
    except Exception:
        return None

    if match:
        sample_rate = int(match.group(1))
        ac = {"mono": 1, "stereo": 2}.get(match.group(2), 2)
    else:
        sample_rate = 44100
        ac = 2

    if audio.numel() == 0:
        return None

    audio = audio.reshape((-1, ac)).transpose(0, 1).unsqueeze(0)
    return {"waveform": audio, "sample_rate": sample_rate}


class PowerLoadVideo:
    """
    Loads a video file via drag-and-drop upload and outputs frames as IMAGE tensor.

    Outputs:
        - IMAGE: Tensor of shape [frame_count, height, width, 3]
        - AUDIO: Audio waveform dict {"waveform", "sample_rate"}
        - FPS: Vide real FPS
    """

    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        try:
            files = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
            files = folder_paths.filter_files_content_types(files, ["video"])
            files = sorted(files)
        except Exception:
            files = []
        return {
            "required": {},
            "optional": {
                "video": (files, {"video_upload": True}),
                "start_frame": ("INT", {"default": 1, "min": 1}),
                "end_frame": ("INT", {"default": -1, "min": -1}),
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "FPS")
    FUNCTION = "load_video"
    OUTPUT_NODE = True
    CATEGORY = "Power/Video"
    DESCRIPTION = "Load a video file via drag-and-drop. Outputs frames as IMAGE tensor, audio, and FPS."

    def load_video(self, video=None, start_frame=1, end_frame=-1):
        """
        Load video frames and audio from uploaded video file.

        Args:
            video: Video filename
            start_frame: First frame to load (1-based). Default 1 = first frame.
            end_frame: Last frame to load (1-based). Default -1 = last frame.

        Returns:
            tuple: (IMAGE tensor, AUDIO dict, fps)
        """
        video_filename = video

        if not video_filename:
            raise ValueError("No video file provided. Please use the Upload button or drag and drop a video onto this node.")

        # Get the actual file path
        try:
            filename = folder_paths.get_annotated_filepath(video_filename)
        except Exception:
            input_dir = folder_paths.get_input_directory()
            filename = os.path.join(input_dir, video_filename)

        if not os.path.exists(filename):
            raise ValueError(f"Video file not found: {filename}")

        # Open video with OpenCV
        cap = cv2.VideoCapture(filename)
        if not cap.isOpened():
            raise ValueError(f"Could not open video file: {filename}")

        # Get video properties
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        native_fps = cap.get(cv2.CAP_PROP_FPS)
        if native_fps <= 0:
            native_fps = 24.0

        # Convert 1-based frame numbers to 0-based index range
        first_idx = max(0, (start_frame or 1) - 1)
        last_idx = (total_frames - 1) if (end_frame is None or end_frame <= 0) else min(end_frame - 1, total_frames - 1)

        # Check if we're using the full video (no trimming needed)
        full_video = (first_idx == 0) and (last_idx == total_frames - 1)

        # Read frames
        images = []
        if full_video:
            # Optimized path: read all frames sequentially without seeking
            while True:
                ret, frame = cap.read()
                if not ret:
                    break
                frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                pil_image = Image.fromarray(frame)
                images.append(pil_image)
        else:
            # Trimmed path: seek to each frame (slower but necessary for trimming)
            frames_to_load = list(range(first_idx, last_idx + 1))
            for frame_idx in frames_to_load:
                cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
                ret, frame = cap.read()
                if ret:
                    frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    pil_image = Image.fromarray(frame)
                    images.append(pil_image)

        cap.release()

        if not images:
            raise ValueError("No frames could be loaded from video")

        # Convert to tensor
        image_tensor = self.pil_totensor(images)

        # Extract audio (skip trimming if full video)
        audio = None
        if full_video:
            audio = extract_audio(filename, start_time=0, duration=0)
        else:
            audio_start_time = first_idx / native_fps
            audio_duration = (last_idx - first_idx + 1) / native_fps
            audio = extract_audio(filename, audio_start_time, audio_duration)

        return (image_tensor, audio, native_fps)

    def pil_totensor(self, images):
        """Convert list of PIL Images to PyTorch tensor [N, H, W, C] in [0, 1]."""
        img_list = []
        for img in images:
            np_img = np.array(img.copy(), dtype=np.float32) / 255.0
            img_list.append(np_img)
        stacked = np.stack(img_list, axis=0)
        return torch.from_numpy(stacked)

    @classmethod
    def IS_CHANGED(s, video=None, start_frame=1, end_frame=-1):
        if not video:
            return 0
        try:
            image_path = folder_paths.get_annotated_filepath(video)
            import hashlib
            m = hashlib.sha256()
            with open(image_path, 'rb') as f:
                m.update(f.read())
            return m.digest().hex()
        except:
            return 0

    @classmethod
    def VALIDATE_INPUTS(s, video=None):
        if not video:
            return True
        try:
            if not folder_paths.exists_annotated_filepath(video):
                return "Invalid video file: {}".format(video)
        except:
            pass
        return True


# Node registration
NODE_CLASS_MAPPINGS = {
    "PowerLoadVideo": PowerLoadVideo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PowerLoadVideo": "Power Load Video",
}
