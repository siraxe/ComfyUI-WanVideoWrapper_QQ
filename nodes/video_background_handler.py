"""
Video Background Handler for PowerSplineEditor

Converts IMAGE tensors (multiple frames) into video files for background playback
in the PowerSplineEditor widget with timeline scrubbing support.
"""

import os
import av
import torch
from fractions import Fraction


def should_create_video(images: torch.Tensor) -> bool:
    """
    Check if images tensor has multiple frames (batch size > 1).

    Args:
        images: Torch tensor, expected shape [batch, height, width, channels]

    Returns:
        bool: True if tensor has multiple frames, False otherwise
    """
    return images is not None and images.dim() == 4 and images.shape[0] > 1


def save_frames_as_video(
    images: torch.Tensor,
    output_path: str,
    fps: float = 24.0,
    codec: str = "libx264",
    quality: int = 23
) -> dict:
    """
    Convert IMAGE tensor to video file.

    Args:
        images: Torch tensor [batch, height, width, channels] in float32 0-1 range
        output_path: Full path where video should be saved
        fps: Frames per second for video (default: 24.0)
        codec: Video codec (default: "libx264" for H.264 MP4)
        quality: CRF value for quality, lower = better quality (default: 23)
                Range: 0-51, recommended 18-28

    Returns:
        dict with video metadata:
            - path: relative path to video file
            - num_frames: number of frames in video
            - fps: frames per second
            - width: video width in pixels
            - height: video height in pixels
            - duration: video duration in seconds

    Raises:
        ValueError: If images tensor has invalid shape or values
        RuntimeError: If video encoding fails
    """
    # Validate input
    if images is None or images.dim() != 4:
        raise ValueError(f"Expected 4D tensor [batch, height, width, channels], got shape {images.shape if images is not None else 'None'}")

    if images.shape[0] < 1:
        raise ValueError("Images tensor must have at least 1 frame")

    # Get video dimensions
    num_frames = images.shape[0]
    height = images.shape[1]
    width = images.shape[2]
    channels = images.shape[3]

    if channels != 3:
        raise ValueError(f"Expected 3 channels (RGB), got {channels}")

    # Ensure tensor is on CPU
    if images.device != torch.device('cpu'):
        images = images.cpu()

    # Determine container format from extension
    file_ext = os.path.splitext(output_path)[1].lower()
    if file_ext == '.mp4':
        container_format = 'mp4'
    elif file_ext == '.webm':
        container_format = 'webm'
    else:
        # Default to mp4
        container_format = 'mp4'

    try:
        # Open video container for writing
        container = av.open(output_path, mode="w", format=container_format)

        # Add video stream
        stream = container.add_stream(codec, rate=Fraction(round(fps * 1000), 1000))
        stream.width = width
        stream.height = height
        stream.pix_fmt = "yuv420p"  # Standard pixel format for H.264

        # Set encoding options
        stream.options = {
            'crf': str(quality),  # Constant Rate Factor (quality)
            'preset': 'medium'    # Encoding speed/compression tradeoff
        }

        # Encode each frame
        for frame_idx in range(num_frames):
            # Get frame tensor [height, width, channels]
            frame_tensor = images[frame_idx]

            # Clamp values to [0, 1] range and convert to uint8 [0, 255]
            frame_tensor = torch.clamp(frame_tensor, min=0, max=1)
            frame_np = (frame_tensor * 255).to(dtype=torch.uint8).numpy()

            # Create VideoFrame from numpy array
            video_frame = av.VideoFrame.from_ndarray(frame_np, format="rgb24")

            # Encode frame
            for packet in stream.encode(video_frame):
                container.mux(packet)

        # Flush remaining packets
        for packet in stream.encode():
            container.mux(packet)

        # Close container
        container.close()

        # Calculate duration
        duration = num_frames / fps

        # Return metadata
        return {
            'path': os.path.basename(output_path),
            'num_frames': num_frames,
            'fps': fps,
            'width': width,
            'height': height,
            'duration': duration
        }

    except Exception as e:
        raise RuntimeError(f"Failed to encode video: {str(e)}") from e
