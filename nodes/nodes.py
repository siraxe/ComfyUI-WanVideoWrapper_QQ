import torch

class WanFrames:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "frames": ("INT", {"default": 5, "min": 5, "max": 1000, "step": 4, "tooltip": "Number of frames, 4 * n + 1"})
            }
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("frame_count",)
    FUNCTION = "calculate_frames"
    CATEGORY = "WanVideoWrapper_QQ"
    DESCRIPTION = "Calculates frame count as input + 1, ensuring input is divisible by 4"

    def calculate_frames(self, frames):
        return (frames,)

class WanVideoMerge:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {
                    "video1": ("IMAGE",),
                    "video2": ("IMAGE",),
                    "video_speed": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 3.0, "step": 0.05, "tooltip": "Speed factor for the resulting video. Lower values create slower, longer videos. Higher values create faster, shorter videos."}),
                    "transition1_frames": ("INT", {"default": 10, "min": 0, "max": 1000, "step": 1, "tooltip": "Number of frames for transition between video1 and video2"}),
                },
                "optional": {
                    "video3": ("IMAGE",),
                    "transition2_frames": ("INT", {"default": 20, "min": 0, "max": 1000, "step": 1, "tooltip": "Number of frames for transition between video2 and video3"}),
                }
            }

    RETURN_TYPES = ("IMAGE", "INT")
    RETURN_NAMES = ("video", "frame_count")
    FUNCTION = "merge_videos"
    CATEGORY = "WanVideoWrapper_QQ"
    DESCRIPTION = "Blends 2 or 3 videos with customizable transition frame counts: video1 → transition1 → video2 → (transition2 → video3 if provided)"

    def merge_videos(self, video1, video2, transition1_frames, video_speed=1.0, video3=None, transition2_frames=20):
        # Get the frame counts
        video1_frames = video1.shape[0]
        video2_frames = video2.shape[0]
        
        # Initialize the total frames count
        total_frames = video1_frames + video2_frames + transition1_frames
        
        # Include video3 frames if provided
        video3_frames = 0
        if video3 is not None:
            video3_frames = video3.shape[0]
            total_frames += video3_frames + transition2_frames
        
        # Adjust for speed
        adjusted_frames = max(1, int(total_frames / video_speed))
        
        # Create the output tensor
        height = video1.shape[1]
        width = video1.shape[2]
        channels = video1.shape[3]
        output = torch.zeros((adjusted_frames, height, width, channels), dtype=video1.dtype, device=video1.device)
        
        # Calculate frame indices for transitions
        v1_end = video1_frames
        t1_end = v1_end + transition1_frames
        v2_end = t1_end + video2_frames
        
        # Process all frames
        for i in range(adjusted_frames):
            # Map the adjusted frame index back to the original timeline
            orig_idx = min(int(i * video_speed), total_frames - 1)
            
            if orig_idx < video1_frames:
                # Copy from video1
                output[i] = video1[orig_idx]
            elif orig_idx < t1_end:
                # First transition
                t_factor = (orig_idx - video1_frames) / transition1_frames
                frame1 = video1[min(video1_frames - 1, video1_frames - 1)]
                frame2 = video2[0]
                output[i] = frame1 * (1 - t_factor) + frame2 * t_factor
            elif orig_idx < v2_end:
                # Copy from video2
                v2_idx = orig_idx - t1_end
                output[i] = video2[min(v2_idx, video2_frames - 1)]
            elif video3 is not None:
                # Process video3 and second transition if video3 is provided
                t2_end = v2_end + transition2_frames
                
                if orig_idx < t2_end:
                    # Second transition
                    t_factor = (orig_idx - v2_end) / transition2_frames
                    frame1 = video2[min(video2_frames - 1, video2_frames - 1)]
                    frame2 = video3[0]
                    output[i] = frame1 * (1 - t_factor) + frame2 * t_factor
                else:
                    # Copy from video3
                    v3_idx = orig_idx - t2_end
                    output[i] = video3[min(v3_idx, video3_frames - 1)]
        
        return (output, adjusted_frames)

class WanVideoSpeed:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {
                    "video": ("IMAGE",),
                    "output_frames": ("INT", {"default": 33, "min": 1, "max": 10000, "step": 1, "tooltip": "Desired number of frames for the output video. Adjusts speed to match."}),
                }
            }

    RETURN_TYPES = ("IMAGE", "INT")
    RETURN_NAMES = ("video", "frame_count")
    FUNCTION = "adjust_speed"
    CATEGORY = "WanVideoWrapper_QQ"
    DESCRIPTION = "Adjusts the speed of a video sequence by controlling frame count and interpolation to match a target number of output frames."

    def adjust_speed(self, video, output_frames=100):
        # Get the original frame count
        original_frames = video.shape[0]
        
        # New frame count is directly the output_frames
        new_frames = max(1, output_frames)
        
        # Create the output tensor
        height = video.shape[1]
        width = video.shape[2]
        channels = video.shape[3]
        output = torch.zeros((new_frames, height, width, channels), dtype=video.dtype, device=video.device)
        
        # Process all frames
        if original_frames == 0: # Handle empty input video
            return (output, new_frames)

        for i in range(new_frames):
            # Map the new frame index back to the original timeline
            # This effectively speeds up (skips frames) or slows down (duplicates/holds frames)
            orig_idx_float = i * (original_frames / new_frames)
            orig_idx = min(int(orig_idx_float), original_frames - 1)
            output[i] = video[orig_idx]
        
        return (output, new_frames)

class WanVideoExtractFrame:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "video": ("IMAGE", {"tooltip": "Input video/images tensor (T, H, W, C) or (B, T, H, W, C)"}),
                "first_frame": ("BOOLEAN", {"default": True, "tooltip": "If True, extract from start; if False, extract from end."}),
                "offset": ("INT", {"default": 0, "min": 0, "tooltip": "Frame offset from start or end."}),
            },
        }

    RETURN_TYPES = ("IMAGE", )
    RETURN_NAMES = ("image", )
    FUNCTION = "process"
    CATEGORY = "WanVideoWrapper_QQ"
    DESCRIPTION = "Extracts a frame at a given offset from the start or end of a video/images tensor."

    def process(self, video, first_frame=True, offset=0):
        # Accepts (T, H, W, C) or (B, T, H, W, C)
        # If batch dimension, process first batch
        if video.ndim == 5:
            video = video[0]
        # video is now (T, H, W, C)
        num_frames = video.shape[0]
        # Clamp offset
        offset = max(0, min(offset, num_frames - 1))
        if first_frame:
            idx = offset
        else:
            idx = num_frames - 1 - offset
            idx = max(0, idx)  # Ensure not negative
        frame = video[idx]
        # Add batch dimension for output if needed
        return (frame.unsqueeze(0),)

class WanReplaceFirstFrame:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "Single image to replace the first frame of the video."}),
                "video": ("IMAGE", {"tooltip": "Video whose first frame will be replaced."}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("video",)
    FUNCTION = "replace_first_frame"
    CATEGORY = "WanVideoWrapper_QQ"
    DESCRIPTION = "Replaces the first frame of the input video with the input image."

    def replace_first_frame(self, image: torch.Tensor, video: torch.Tensor):
        if not isinstance(image, torch.Tensor) or not isinstance(video, torch.Tensor):
            # This check might be redundant if ComfyUI always provides tensors, but good for robustness
            print("Error: Inputs 'image' and 'video' must be PyTorch tensors.")
            return (video,) # Return original video on type error

        if image.ndim != 4:
            print(f"Error: Input 'image' must be a 4D tensor (B, H, W, C), but got shape {image.shape}")
            return (video,) # Return original video
        if image.shape[0] == 0:
            print("Error: Input 'image' is empty (batch size is 0).")
            return (video,) # Return original video

        if video.ndim != 4:
            print(f"Error: Input 'video' must be a 4D tensor (T, H, W, C), but got shape {video.shape}")
            return (image,) # If video is invalid, maybe return the image as a single-frame video? Or original video if available?
                            # For now, let's return the image as a potential single-frame video.
        if video.shape[0] == 0:
            print("Warning: Input 'video' is empty. Outputting the input 'image' as a new one-frame video.")
            return (image,) # If video is empty, treat the input image as the new video.

        # Take the first frame from the 'image' input (IMAGE type is B, H, W, C)
        image_to_use = image[0]  # Shape: (H, W, C)

        # Ensure the dimensions (H, W, C) match between the image_to_use and video frames
        if image_to_use.shape[0] != video.shape[1] or \
           image_to_use.shape[1] != video.shape[2] or \
           image_to_use.shape[2] != video.shape[3]:
            error_message = (
                f"Error: Image dimensions ({image_to_use.shape[0]}H x {image_to_use.shape[1]}W x {image_to_use.shape[2]}C) "
                f"do not match video frame dimensions ({video.shape[1]}H x {video.shape[2]}W x {video.shape[3]}C). "
                "Please ensure they are the same size."
            )
            print(error_message)
            return (video,) # Return original video on dimension mismatch

        # Clone the video tensor to avoid modifying the input tensor in place,
        # ensuring the original video tensor passed to other nodes is not affected.
        output_video = video.clone()
        
        # Replace the first frame
        # Ensure image_to_use has the same dtype and device as output_video for assignment
        output_video[0] = image_to_use.to(device=output_video.device, dtype=output_video.dtype)
        
        return (output_video,)
