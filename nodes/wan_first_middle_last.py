# -*- coding: utf-8 -*-

import torch
import node_helpers
import comfy
import comfy.utils
import comfy.clip_vision
from nodes import MAX_RESOLUTION
from typing import Optional, Tuple, Any


class WanFMLF:
    """
    3-frame reference node for Wan2.2 A14B I2V with dual MoE conditioning.
    
    Features:
    - First, middle, and last frame reference
    - Dual conditioning outputs for high-noise and low-noise stages
    - Adjustable constraint strengths for MoE dual-phase sampling
    - Designed for LightX2V distilled model (8 steps: 4 high-noise + 4 low-noise)
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive": ("CONDITIONING",),
                "negative": ("CONDITIONING",),
                "vae": ("VAE",),
                "width": ("INT", {"default": 832, "min": 16, "max": MAX_RESOLUTION, "step": 16}),
                "height": ("INT", {"default": 480, "min": 16, "max": MAX_RESOLUTION, "step": 16}),
                "length": ("INT", {"default": 81, "min": 1, "max": MAX_RESOLUTION, "step": 4}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 4096}),
            },
            "optional": {
                "start_image": ("IMAGE",),
                "middle_image": ("IMAGE",),
                "end_image": ("IMAGE",),
                "middle_frame_ratio": ("FLOAT", {
                    "default": 0.5, 
                    "min": 0.0, 
                    "max": 1.0, 
                    "step": 0.01,
                    "display": "slider",
                }),
                # Dual-stage strength control
                "high_noise_strength": ("FLOAT", {
                    "default": 0.8,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.05,
                    "display": "slider",
                    "tooltip": "Middle frame constraint strength for high-noise stage (determines motion trajectory)"
                }),
                "low_noise_strength": ("FLOAT", {
                    "default": 0.2,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.05,
                    "display": "slider",
                    "tooltip": "Middle frame constraint strength for low-noise stage (prevents detail flickering)"
                }),
                "motion_amplitude": ("FLOAT", {
                    "default": 1.15,
                    "min": 1.0,
                    "max": 2.0,
                    "step": 0.05,
                    "display": "slider",
                    "tooltip": "Motion amplitude enhancement (fixes 4-step LoRA slow-motion issues)"
                }),
                "clip_vision_start_image": ("CLIP_VISION_OUTPUT",),
                "clip_vision_middle_image": ("CLIP_VISION_OUTPUT",),
                "clip_vision_end_image": ("CLIP_VISION_OUTPUT",),
            },
        }

    # 🎯 Three outputs: positive high-noise, positive low-noise, latent
    # Negative conditioning uses original input (following ComfyUI conventions)
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive_high_noise", "positive_low_noise", "negative", "latent")
    FUNCTION = "generate"
    CATEGORY = "ComfyUI-Wan22FMLF/video"

    def generate(self, positive: Tuple[Any, ...],
                 negative: Tuple[Any, ...],
                 vae: Any,
                 width: int,
                 height: int,
                 length: int,
                 batch_size: int,
                 start_image: Optional[torch.Tensor] = None,
                 middle_image: Optional[torch.Tensor] = None,
                 end_image: Optional[torch.Tensor] = None,
                 middle_frame_ratio: float = 0.5,
                 high_noise_strength: float = 0.8,
                 low_noise_strength: float = 0.2,
                 motion_amplitude: float = 1.15,
                 clip_vision_start_image: Optional[Any] = None,
                 clip_vision_middle_image: Optional[Any] = None,
                 clip_vision_end_image: Optional[Any] = None) -> Tuple[Tuple[Any, ...], Tuple[Any, ...], Tuple[Any, ...], dict]:
        
        spacial_scale = vae.spacial_compression_encode()
        latent_channels = vae.latent_channels
        latent_t = ((length - 1) // 4) + 1
        
        device = comfy.model_management.intermediate_device()
        
        latent = torch.zeros([batch_size, latent_channels, latent_t, 
                             height // spacial_scale, width // spacial_scale], 
                             device=device)
        
        # Image preprocessing
        if start_image is not None:
            start_image = comfy.utils.common_upscale(
                start_image[:length].movedim(-1, 1), width, height, 
                "bilinear", "center").movedim(1, -1)
        
        if middle_image is not None:
            middle_image = comfy.utils.common_upscale(
                middle_image[:1].movedim(-1, 1), width, height, 
                "bilinear", "center").movedim(1, -1)
        
        if end_image is not None:
            end_image = comfy.utils.common_upscale(
                end_image[-length:].movedim(-1, 1), width, height, 
                "bilinear", "center").movedim(1, -1)
        
        # Create timeline and base mask
        image = torch.ones((length, height, width, 3), device=device) * 0.5
        mask_base = torch.ones((1, 1, latent_t * 4, latent.shape[-2], latent.shape[-1]), 
                              device=device)
        
        def calculate_aligned_position(ratio: float, total_frames: int) -> Tuple[int, int]:
            desired_pixel_idx = int(total_frames * ratio)
            latent_idx = desired_pixel_idx // 4
            aligned_pixel_idx = latent_idx * 4
            aligned_pixel_idx = max(0, min(aligned_pixel_idx, total_frames - 1))
            return aligned_pixel_idx, latent_idx
        
        middle_idx, middle_latent_idx = calculate_aligned_position(middle_frame_ratio, length)
        middle_idx = max(4, min(middle_idx, length - 5))
        
        # 🎯 Key fix: create masks in advance to avoid only creating when middle_image exists
        mask_high_noise = mask_base.clone()
        mask_low_noise = mask_base.clone()
        
        # Place reference frames
        if start_image is not None:
            image[:start_image.shape[0]] = start_image
            mask_base[:, :, :start_image.shape[0] + 3] = 0.0
            mask_high_noise[:, :, :start_image.shape[0] + 3] = 0.0
            mask_low_noise[:, :, :start_image.shape[0] + 3] = 0.0
        
        if middle_image is not None:
            image[middle_idx:middle_idx + 1] = middle_image
            
            # 🎯 Fix: masks are now created, directly set middle frame masks
            start_range = max(0, middle_idx)
            end_range = min(length, middle_idx + 4)
            high_noise_mask_value = 1.0 - high_noise_strength
            mask_high_noise[:, :, start_range:end_range] = high_noise_mask_value
            
            # Low noise mask (weak constraint)
            low_noise_mask_value = 1.0 - low_noise_strength
            mask_low_noise[:, :, start_range:end_range] = low_noise_mask_value
        
        if end_image is not None:
            image[-end_image.shape[0]:] = end_image
            if middle_image is not None:
                mask_high_noise[:, :, -end_image.shape[0]:] = 0.0
                mask_low_noise[:, :, -end_image.shape[0]:] = 0.0
        
        # 🎯 Separate high-noise and low-noise latent images
        # High noise stage: includes middle frame
        concat_latent_image_high = vae.encode(image[:, :, :, :3])
        
        # Low noise stage: skip middle frame if strength is 0
        if low_noise_strength == 0.0:
            # 🎯 Low noise strength is 0: create latent without middle frame
            image_low_only = torch.ones((length, height, width, 3), device=device) * 0.5
            
            # Only place start and end frames
            if start_image is not None:
                image_low_only[:start_image.shape[0]] = start_image
            if end_image is not None:
                image_low_only[-end_image.shape[0]:] = end_image
            
            concat_latent_image_low = vae.encode(image_low_only[:, :, :, :3])
        else:
            # Low noise strength > 0: use complete image
            concat_latent_image_low = vae.encode(image[:, :, :, :3])

        # Motion amplitude enhancement processing (fixes 4-step LoRA slow-motion issues)
        if motion_amplitude > 1.0:
            concat_latent_image_high = self._apply_motion_amplitude(concat_latent_image_high, motion_amplitude)
            concat_latent_image_low = self._apply_motion_amplitude(concat_latent_image_low, motion_amplitude)

        # Mask reshaping
        mask_high_reshaped = mask_high_noise.view(1, mask_high_noise.shape[2] // 4, 4, mask_high_noise.shape[3], mask_high_noise.shape[4]).transpose(1, 2)
        mask_low_reshaped = mask_low_noise.view(1, mask_low_noise.shape[2] // 4, 4, mask_low_noise.shape[3], mask_low_noise.shape[4]).transpose(1, 2)
        
        # 🎯 Create three conditioning settings
        # High noise stage: strong constraint, determines motion trajectory
        positive_high_noise = node_helpers.conditioning_set_values(positive, {
            "concat_latent_image": concat_latent_image_high,
            "concat_mask": mask_high_reshaped
        })
        
        # Low noise stage: decide whether to use middle frame based on strength
        positive_low_noise = node_helpers.conditioning_set_values(positive, {
            "concat_latent_image": concat_latent_image_low,  # 🎯 Separated latent image
            "concat_mask": mask_low_reshaped
        })
        
        # Negative conditioning uses original input
        negative_out = negative
        
        # CLIP Vision processing (mainly for detail optimization in low-noise stage)
        clip_vision_output = self._merge_clip_vision_outputs(
            clip_vision_start_image, 
            clip_vision_middle_image, 
            clip_vision_end_image
        )
        
        if clip_vision_output is not None:
            # Only add CLIP Vision in low-noise stage (better detail understanding)
            positive_low_noise = node_helpers.conditioning_set_values(positive_low_noise, 
                                                                   {"clip_vision_output": clip_vision_output})
        
        out_latent = {"samples": latent}
        
        return (positive_high_noise, positive_low_noise, negative_out, out_latent)

    def _apply_motion_amplitude(self, concat_latent_image: torch.Tensor, motion_amplitude: float) -> torch.Tensor:
        """
        Apply motion amplitude enhancement (brightness preservation core algorithm)

        Args:
            concat_latent_image: VAE-encoded latent image
            motion_amplitude: Motion amplitude multiplier (>1.0 enhances motion)

        Returns:
            Enhanced latent image
        """
        if motion_amplitude <= 1.0:
            return concat_latent_image

        # Separate first frame and subsequent frames
        base_latent = concat_latent_image[:, :, 0:1]  # First frame
        gray_latent = concat_latent_image[:, :, 1:]   # Subsequent gray frames

        if gray_latent.shape[2] == 0:
            return concat_latent_image

        # Calculate motion vectors and separate brightness
        diff = gray_latent - base_latent
        diff_mean = diff.mean(dim=(1, 3, 4), keepdim=True)  # Preserve brightness mean
        diff_centered = diff - diff_mean  # Pure motion vector with brightness removed

        # Apply motion amplitude enhancement
        scaled_latent = base_latent + diff_centered * motion_amplitude + diff_mean

        # Clamp range to prevent anomalies
        scaled_latent = torch.clamp(scaled_latent, -6, 6)

        # Reassemble: first frame + enhanced subsequent frames
        result = torch.cat([base_latent, scaled_latent], dim=2)

        return result

    def _merge_clip_vision_outputs(self, *outputs: Any) -> Optional[Any]:
        valid_outputs = [o for o in outputs if o is not None]
        
        if not valid_outputs:
            return None
        
        if len(valid_outputs) == 1:
            return valid_outputs[0]
        
        all_states = [o.penultimate_hidden_states for o in valid_outputs]
        combined_states = torch.cat(all_states, dim=-2)
        
        result = comfy.clip_vision.Output()
        result.penultimate_hidden_states = combined_states
        return result


NODE_CLASS_MAPPINGS = {
    "WanFMLF": WanFMLF
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WanFMLF": "WanFMLF (Dual MoE) 🎬"
}
