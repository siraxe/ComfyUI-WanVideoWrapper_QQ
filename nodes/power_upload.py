"""
Power Load Video - A video loading node with drag-and-drop upload support
Similar to LoadImage but for videos, with an integrated timeline UI.
"""

import os
import cv2
import numpy as np
from PIL import Image
import torch
import folder_paths

class PowerLoadVideo:
    """
    Loads a video file via drag-and-drop upload and outputs frames as IMAGE tensor.

    Outputs:
        - IMAGE: Tensor of shape [frame_count, height, width, 3]
        - frame_count: Number of frames loaded
    """
    
    @classmethod
    def INPUT_TYPES(cls):
        # Get input directory and list video files
        input_dir = folder_paths.get_input_directory()

        # Video extensions to accept
        video_extensions = {'.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.m4v', '.mpeg', '.mpg'}

        files = []
        if os.path.exists(input_dir):
            for f in os.listdir(input_dir):
                filepath = os.path.join(input_dir, f)
                if os.path.isfile(filepath):
                    ext = os.path.splitext(f)[1].lower()
                    if ext in video_extensions:
                        files.append(f)

        return {
            "required": {
                "video": (sorted(files), {"video_upload": True}),
            },
            "optional": {
                "frame_load_cap": (
                    "INT",
                    {
                        "default": -1,
                        "min": -1,
                        "max": 9999,
                        "step": 1,
                        "display": "number",
                    },
                ),
            }
        }

    RETURN_TYPES = ("IMAGE", "INT")
    FUNCTION = "load_video"
    OUTPUT_NODE = True
    CATEGORY = "Power/Video"
    DESCRIPTION = "Load a video file via drag-and-drop. Outputs frames as IMAGE tensor and frame count."

    def load_video(self, video=None, frame_load_cap=-1):
        """
        Load video frames from uploaded video file.

        Args:
            video: Video filename from upload widget
            frame_load_cap: Max frames to load (-1 for all)

        Returns:
            tuple: (IMAGE tensor, frame_count)
        """
        if video is None or video == "":
            raise ValueError("No video file provided. Please drag and drop a video onto this node.")

        # Get the actual file path using ComfyUI's helper
        try:
            filename = folder_paths.get_annotated_filepath(video)
        except Exception:
            # Fallback: assume it's just a filename in input directory
            input_dir = folder_paths.get_input_directory()
            filename = os.path.join(input_dir, video)

        if not os.path.exists(filename):
            raise ValueError(f"Video file not found: {filename}")

        # Open video with OpenCV
        cap = cv2.VideoCapture(filename)
        if not cap.isOpened():
            raise ValueError(f"Could not open video file: {filename}")

        # Get video properties
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        # Calculate which frames to load
        frames_to_load = list(range(total_frames))

        # Apply frame_load_cap
        if frame_load_cap > 0 and len(frames_to_load) > frame_load_cap:
            frames_to_load = frames_to_load[:frame_load_cap]

        # Read frames
        images = []
        for frame_idx in frames_to_load:
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
            ret, frame = cap.read()
            if ret:
                # Convert BGR to RGB
                frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                pil_image = Image.fromarray(frame)
                images.append(pil_image)

        cap.release()

        if not images:
            raise ValueError("No frames could be loaded from video")

        # Convert to tensor
        image_tensor = self.pil_totensor(images)
        frame_count = len(images)

        return (image_tensor, frame_count)

    def pil_totensor(self, images):
        """
        Convert list of PIL Images to PyTorch tensor.

        Args:
            images: List of PIL Image objects

        Returns:
            torch.Tensor: Tensor of shape [N, H, W, 3] with values in [0, 1]
        """
        # Convert each image to numpy array
        img_list = []
        for img in images:
            np_img = np.array(img.copy(), dtype=np.float32) / 255.0
            img_list.append(np_img)

        # Stack into tensor [N, H, W, C]
        stacked = np.stack(img_list, axis=0)

        # Convert to torch tensor
        tensor = torch.from_numpy(stacked)

        return tensor

    @classmethod
    def IS_CHANGED(s, video):
        """Return a hash for cache invalidation when file changes."""
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
    def VALIDATE_INPUTS(s, video):
        """Validate that the video file exists."""
        if not video:
            return True  # Let the node handle empty input
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
