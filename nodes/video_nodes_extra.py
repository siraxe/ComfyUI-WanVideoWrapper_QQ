import torch
import torch.nn.functional as F
import io
import base64
import numpy as np
import json


class VideoMergeABC:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_A": ("IMAGE",),
                "image_B": ("IMAGE",),
                "image_C": ("IMAGE",),
                "A_overlap": (
                    "INT",
                    {"default": 24, "min": 0, "max": 10000, "step": 1},
                ),
                "B_overlap": (
                    "INT",
                    {"default": 24, "min": 0, "max": 10000, "step": 1},
                ),
                "easing_clamp": (
                    "FLOAT",
                    {"default": 0.5, "min": -1.0, "max": 2.0, "step": 0.01},
                ),
                "easing_type": (["linear", "ease_in", "ease_out", "ease_in_out"],),
                "resize_to_B": (["off", "on"], {"default": "off"}),
            },
            "hidden": {
                "opacity_curve": ("STRING", {"default": "[]", "multiline": True}),
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "VIDEO_META")
    RETURN_NAMES = ("images", "debug", "video_meta")
    FUNCTION = "merge_abc"
    CATEGORY = "WanVideoWrapper_QQ/video"

    def merge_abc(
        self,
        image_A,
        image_B,
        image_C,
        A_overlap,
        B_overlap,
        easing_clamp,
        easing_type,
        resize_to_B,
        **kwargs,
    ):
        opacity_curve = kwargs.get("opacity_curve", "[]")
        num_b = image_B.shape[0]
        device = image_B.device

        try:
            opacity_y = json.loads(opacity_curve)
            if not isinstance(opacity_y, list) or len(opacity_y) != num_b:
                y_list = self._generate_y_values(
                    num_b, A_overlap, B_overlap, easing_clamp, easing_type
                )
                opacity_y = torch.tensor(y_list, dtype=torch.float32, device=device)
            else:
                # Resample the curve from JS UI to ensure consistency
                opacity_y = self._resample_curve(
                    opacity_y, num_b, A_overlap, B_overlap, easing_clamp, easing_type, device
                )
        except (json.JSONDecodeError, ValueError) as e:
            y_list = self._generate_y_values(
                num_b, A_overlap, B_overlap, easing_clamp, easing_type
            )
            opacity_y = torch.tensor(y_list, dtype=torch.float32, device=device)

        num_a, h_a, w_a, c_a = image_A.shape
        num_c, h_c, w_c, c_c = image_C.shape
        h_b, w_b, c_b = image_B.shape[1:]

        # Check if resize_to_B is enabled
        if resize_to_B == "on":
            # Use image_B's dimensions as the target
            target_h = h_b
            target_w = w_b
            target_c = max(c_a, c_b, c_c)

            # Resize image_A and image_C to match image_B's dimensions
            image_A = self._resize_to_target(
                image_A, num_a, target_h, target_w, target_c
            )
            image_C = self._resize_to_target(
                image_C, num_c, target_h, target_w, target_c
            )
            # image_B already has the correct dimensions, but ensure channel consistency
            image_B = self._resize_to_target(
                image_B, num_b, target_h, target_w, target_c
            )
        else:
            # Original behavior: use the maximum dimensions
            target_h = max(h_a, h_b, h_c)
            target_w = max(w_a, w_b, w_c)
            target_c = max(c_a, c_b, c_c)

            image_A = self._resize_to_target(
                image_A, num_a, target_h, target_w, target_c
            )
            image_B = self._resize_to_target(
                image_B, num_b, target_h, target_w, target_c
            )
            image_C = self._resize_to_target(
                image_C, num_c, target_h, target_w, target_c
            )

        safe_A_overlap = min(A_overlap, num_a, num_b // 2)
        safe_B_overlap = min(B_overlap, num_c, num_b // 2)

        A1 = image_A[:-safe_A_overlap]
        A2 = image_A[-safe_A_overlap:]
        C1 = image_C[:safe_B_overlap]
        C2 = image_C[safe_B_overlap:]

        B_old = torch.zeros_like(image_B)
        B_old[:safe_A_overlap] = A2
        B_old[-safe_B_overlap:] = C1

        # Use modular blending function for actual output
        B_new = self._blend_images(image_B, B_old, opacity_y)

        result = torch.cat([A1, B_new, C2], dim=0)

        # Create debug visualization with blue overlay on image_B
        debug_image = self._create_debug_image(image_A, image_B, image_C, opacity_y)

        graph_data = self._create_transition_graph(
            num_b, A_overlap, B_overlap, easing_clamp, easing_type
        )

        video_meta = {
            "A_overlap": A_overlap,
            "B_overlap": B_overlap,
            "easing_clamp": easing_clamp,
            "easing_type": easing_type,
            "num_frames_b": num_b,
            "safe_A_overlap": safe_A_overlap,
            "safe_B_overlap": safe_B_overlap,
        }

        ui_data = {"transition_graph": [graph_data]}
        return {"ui": ui_data, "result": (result, debug_image, video_meta)}

    def _generate_y_values(self, num_frames, A_overlap, B_overlap, easing_clamp, easing_type):
        """
        Generate opacity curve for blending.
        """
        y = [0.0] * num_frames

        safe_A_overlap = min(A_overlap, num_frames // 2)
        safe_B_overlap = min(B_overlap, num_frames // 2)

        # Use original remap_clamp calculation to match JS behavior
        remap_clamp = (easing_clamp - 0.5) * 2

        if safe_A_overlap > 0:
            for i in range(1, safe_A_overlap + 1):
                progress = i / safe_A_overlap
                y_eased = self._apply_easing(progress, easing_type)
                y[i] = y_eased ** (2**-remap_clamp)

            for i in range(safe_A_overlap + 1, num_frames - safe_B_overlap):
                y[i] = 1.0

        if safe_B_overlap > 0:
            inverted_easing_type = self._invert_easing_type(easing_type)
            for i in range(num_frames - safe_B_overlap, num_frames):
                progress = (
                    (i - (num_frames - safe_B_overlap)) / (safe_B_overlap - 1)
                    if safe_B_overlap > 1
                    else 1.0
                )
                y_eased = 1.0 - self._apply_easing(progress, inverted_easing_type)
                y[i] = y_eased ** (2**-remap_clamp)

        if num_frames > 0:
            y[0] = 0.0
            if num_frames > 1:
                y[num_frames - 1] = 0.0

        return y

    def _resample_curve(
        self, js_curve, target_frames, A_overlap, B_overlap, easing_clamp, easing_type, device
    ):
        """
        Resample the curve from JS UI to ensure consistency and prevent negative jumping.

        Args:
            js_curve: List of y values from JS UI
            target_frames: Number of frames to resample to
            A_overlap: Overlap parameter for A side
            B_overlap: Overlap parameter for B side
            easing_clamp: Easing clamp parameter
            easing_type: Type of easing
            device: PyTorch device

        Returns:
            Resampled tensor of opacity values
        """

        # If the curve already has the right number of frames, use it directly
        if len(js_curve) == target_frames:
            # Ensure values are properly clamped to prevent negative jumping
            resampled = []
            for val in js_curve:
                # Clamp values to prevent negative jumping
                clamped_val = max(0.0, min(1.0, float(val)))
                resampled.append(clamped_val)
            return torch.tensor(resampled, dtype=torch.float32, device=device)

        # Otherwise, generate a new curve using the current parameters
        # This ensures consistency between JS and Python
        y_list = self._generate_y_values(
            target_frames, A_overlap, B_overlap, easing_clamp, easing_type
        )
        return torch.tensor(y_list, dtype=torch.float32, device=device)

    def _create_transition_graph(
        self, num_frames, A_overlap, B_overlap, easing_clamp, easing_type
    ):
        y = self._generate_y_values(
            num_frames, A_overlap, B_overlap, easing_clamp, easing_type
        )
        x = list(range(num_frames))

        safe_A_overlap = min(A_overlap, num_frames // 2)
        safe_B_overlap = min(B_overlap, num_frames // 2)
        key_frames = [0, safe_A_overlap, num_frames - safe_B_overlap, num_frames - 1]
        key_values = [y[k] if 0 <= k < len(y) else 0.0 for k in key_frames]

        return {"x": x, "y": y, "key_frames": key_frames, "key_values": key_values}

    def _apply_easing(self, t, easing_type):
        if easing_type == "ease_in":
            return t * t
        elif easing_type == "ease_out":
            return 1.0 - (1.0 - t) * (1.0 - t)
        elif easing_type == "ease_in_out":
            return 2.0 * t * t if t < 0.5 else 1.0 - 2.0 * (1.0 - t) * (1.0 - t)
        return t

    def _invert_easing_type(self, easing_type):
        if easing_type == "ease_in":
            return "ease_out"
        elif easing_type == "ease_out":
            return "ease_in"
        return easing_type

    def _resize_to_target(self, image, target_b, target_h, target_w, target_c):
        b, h, w, c = image.shape

        if c != target_c:
            # Basic channel handling
            if c == 1:
                image = image.repeat(1, 1, 1, target_c)
            else:
                image = image[..., :target_c]

        if b != target_b:
            if b == 1:
                image = image.repeat(target_b, 1, 1, 1)
            elif b < target_b:
                image = torch.cat(
                    [image, image[-1:].repeat(target_b - b, 1, 1, 1)], dim=0
                )
            else:
                image = image[:target_b]

        if h != target_h or w != target_w:
            # Calculate scale factors for each dimension
            scale_h = target_h / h if h > 0 else 1.0
            scale_w = target_w / w if w > 0 else 1.0

            # Use the larger scale factor (scale to cover, then crop)
            scale = max(scale_h, scale_w)

            new_h = int(h * scale)
            new_w = int(w * scale)

            # Resize using bicubic interpolation for better quality
            image = image.permute(0, 3, 1, 2)  # [B, C, H, W]
            image = F.interpolate(image, size=(new_h, new_w), mode="bicubic", align_corners=False)
            image = image.permute(0, 2, 3, 1)  # [B, H, W, C]

            # Center crop to target dimensions
            start_h = (new_h - target_h) // 2
            start_w = (new_w - target_w) // 2
            image = image[:, start_h:start_h + target_h, start_w:start_w + target_w, :]

        return image

    def _blend_images(self, base_image, overlay_image, opacity):
        """Modular blending function that blends two images using the given opacity.

        Args:
            base_image: The base image (image_B in our case)
            overlay_image: The image to overlay (B_old for actual output, blue for debug)
            opacity: Tensor of opacity values for each frame

        Returns:
            Blended image tensor
        """
        opacity_4d = opacity.view(opacity.shape[0], 1, 1, 1)
        # Simple mix blending: base * opacity + overlay * (1 - opacity)
        return base_image * opacity_4d + overlay_image * (1.0 - opacity_4d)

    def _create_debug_image(self, image_A, image_B, image_C, opacity_y):
        """Create a debug visualization showing image_B with blue overlay based on opacity curve."""
        b, h, w, c = image_B.shape
        device = image_B.device
        blue_overlay = torch.zeros_like(image_B)
        blue_overlay[..., 2] = 1.0  # Set blue channel to 1.0 (assuming RGB order)
        image_B_with_overlay = self._blend_images(image_B, blue_overlay, opacity_y)

        return image_B_with_overlay

class VideoAudioMergeAB:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_A": ("IMAGE",),
                "image_B": ("IMAGE",),
                "Overlap_A": ("INT", {"default": 24, "min": 0, "max": 1000, "step": 1}),
                "Overlap_B": ("INT", {"default": 24, "min": 0, "max": 1000, "step": 1}),
                "video_fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0, "step": 0.5}),
                "easing_clamp": ("FLOAT", {"default": 0.5, "min": -1.0, "max": 2.0, "step": 0.01}),
                "easing_type": (["linear", "ease_in", "ease_out", "ease_in_out"],),
                "normalize_volume": ("BOOLEAN", {"default": True}),
                "b_volume_gain": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.01}),
                "cut_mode": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "audio_A": ("AUDIO",),
                "audio_B": ("AUDIO",),
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "DEBUG")
    RETURN_NAMES = ("images", "audio", "debug")
    FUNCTION = "merge_ab"
    CATEGORY = "WanVideoWrapper_QQ/video"

    def merge_ab(self, image_A, image_B, Overlap_A, Overlap_B, video_fps, easing_clamp, easing_type, normalize_volume, b_volume_gain, cut_mode, audio_A=None, audio_B=None):
        device = image_A.device
        num_a = image_A.shape[0]
        num_b = image_B.shape[0]

        # 1. Image Pre-processing
        h_a, w_a, c_a = image_A.shape[1:]
        h_b, w_b, c_b = image_B.shape[1:]
        target_h, target_w, target_c = max(h_a, h_b), max(w_a, w_b), max(c_a, c_b)

        image_A = self._resize_to_target(image_A, num_a, target_h, target_w, target_c)
        image_B = self._resize_to_target(image_B, num_b, target_h, target_w, target_c)

        # Handle single-frame A: overlay it on top of B's beginning with fade-out
        if num_a == 1:
            safe_overlap = min(Overlap_A, num_b)
            if safe_overlap > 0:
                # Duplicate A to match overlap length for fading
                image_A_extended = torch.cat([image_A] * safe_overlap, dim=0)
                y_list = self._generate_y_values_ab(safe_overlap, easing_clamp, easing_type)
                opacity_y = torch.tensor(y_list, dtype=torch.float32, device=device)
                # Fade A OUT over B's first frames (reverse opacity: start opaque, end transparent)
                blended_start = self._blend_images(image_A_extended, image_B[:safe_overlap], 1.0 - opacity_y)
                result_image = torch.cat([blended_start, image_B[safe_overlap:]], dim=0)
            else:
                result_image = image_B
        else:
            # Calculate safe overlap: use min of both overlaps, clamped to available frames
            safe_overlap = min(Overlap_A, Overlap_B, num_a // 2, num_b // 2)

            # NORMAL MODE: crossfade merge A -> B
            if safe_overlap > 0:
                A1 = image_A[:-safe_overlap]
                A2 = image_A[-safe_overlap:]
                B1 = image_B[:safe_overlap]
                B2 = image_B[safe_overlap:]

                y_list = self._generate_y_values_ab(safe_overlap, easing_clamp, easing_type)
                opacity_y = torch.tensor(y_list, dtype=torch.float32, device=device)
                blended_img = self._blend_images(B1, A2, opacity_y)
                result_image = torch.cat([A1, blended_img, B2], dim=0)
            else:
                result_image = torch.cat([image_A, image_B], dim=0)

        # 3. Handle audio (skip in cut_mode)
        if cut_mode:
            # CUT MODE: no audio processing
            result_audio = {"waveform": torch.zeros((1, 2, 1), device=device), "sample_rate": 44100}
            debug_info = {
                "video_frames": result_image.shape[0],
                "audio_samples": 0,
                "overlap_frames": safe_overlap,
                "sample_rate": 44100,
                "mode": "cut_mode",
                "note": "Cut mode - image_B overlaid at end of image_A, no audio"
            }
            return (result_image, result_audio, debug_info)

        # Normal mode: check if both audio inputs are missing
        has_audio_a = audio_A is not None
        has_audio_b = audio_B is not None

        if not has_audio_a and not has_audio_b:
            # No audio provided, return video only with empty audio
            result_audio = {"waveform": torch.zeros((1, 2, 1), device=device), "sample_rate": 44100}
            debug_info = {
                "video_frames": result_image.shape[0],
                "audio_samples": 0,
                "overlap_frames": safe_overlap,
                "sample_rate": 44100,
                "note": "No audio inputs provided - video merge only"
            }
            return (result_image, result_audio, debug_info)

        # 3. Audio Extraction (Fixed for LazyAudioMap)
        output_sr = 44100
        if has_audio_a:
            waveform_a, sr_a = self._extract_audio(audio_A)
            waveform_a = self._to_std_audio(waveform_a, device)
            output_sr = max(output_sr, sr_a)
        else:
            # Create silent audio for A with matching duration
            waveform_a = torch.zeros((int(num_a * 44100 / video_fps), 2), device=device)
            sr_a = 44100

        if has_audio_b:
            waveform_b, sr_b = self._extract_audio(audio_B)
            waveform_b = self._to_std_audio(waveform_b, device)
            output_sr = max(output_sr, sr_b)
            # Apply gain to B before normalization or mixing
            waveform_b = waveform_b * b_volume_gain
        else:
            # Create silent audio for B with matching duration
            waveform_b = torch.zeros((int(num_b * 44100 / video_fps), 2), device=device)
            sr_b = 44100

        if normalize_volume and has_audio_a:
            waveform_a = self._normalize_audio(waveform_a)
        if normalize_volume and has_audio_b:
            waveform_b = self._normalize_audio(waveform_b)

        max_channels = max(waveform_a.shape[1], waveform_b.shape[1])
        waveform_a = self._match_channels(waveform_a, max_channels)
        waveform_b = self._match_channels(waveform_b, max_channels)

        # 4. Precise Audio Resampling
        overlap_samples = int(safe_overlap * output_sr / video_fps)
        a_part1_samples = int((num_a - safe_overlap) * output_sr / video_fps)
        b_part2_samples = int((num_b - safe_overlap) * output_sr / video_fps)

        # Calculate indices based on ratios to maintain sync
        audio_a_part1 = self._resample_waveform(waveform_a[:int(waveform_a.shape[0] * (num_a-safe_overlap)/num_a)], a_part1_samples)
        audio_a_overlap = self._resample_waveform(waveform_a[int(waveform_a.shape[0] * (num_a-safe_overlap)/num_a):], overlap_samples)
        audio_b_overlap = self._resample_waveform(waveform_b[:int(waveform_b.shape[0] * safe_overlap/num_b)], overlap_samples)
        audio_b_part2 = self._resample_waveform(waveform_b[int(waveform_b.shape[0] * safe_overlap/num_b):], b_part2_samples)

        # 5. Audio Crossfade
        if overlap_samples > 0:
            y_list_audio = self._generate_y_values_ab(overlap_samples, easing_clamp, easing_type)
            opacity_audio = torch.tensor(y_list_audio, dtype=torch.float32, device=device).unsqueeze(-1)
            blended_audio = (audio_b_overlap * opacity_audio) + (audio_a_overlap * (1.0 - opacity_audio))
            result_audio_waveform = torch.cat([audio_a_part1, blended_audio, audio_b_part2], dim=0)
        else:
            result_audio_waveform = torch.cat([audio_a_part1, audio_b_part2], dim=0)

        result_audio = {
            "waveform": result_audio_waveform.t().unsqueeze(0),
            "sample_rate": output_sr,
        }

        debug_info = {
            "video_frames": result_image.shape[0],
            "audio_samples": result_audio_waveform.shape[0],
            "overlap_frames": safe_overlap,
            "sample_rate": output_sr,
            "has_audio_a": has_audio_a,
            "has_audio_b": has_audio_b
        }

        return (result_image, result_audio, debug_info)

    def _extract_audio(self, audio):
        """Standardizes input that might be a dict, LazyAudioMap, or Tensor."""
        waveform = None
        sample_rate = 44100
        
        if hasattr(audio, "get"): # Handle LazyAudioMap
            waveform = audio.get("waveform")
            sample_rate = audio.get("sample_rate", 44100)
        elif isinstance(audio, dict): # Handle standard dict
            waveform = audio.get("waveform")
            sample_rate = audio.get("sample_rate", 44100)
        else:
            waveform = audio
            
        return waveform, sample_rate

    def _to_std_audio(self, w, device):
        # Final safety check before converting to tensor
        if not isinstance(w, torch.Tensor):
            if hasattr(w, "numpy"): w = torch.from_numpy(w())
            else: w = torch.tensor(w, dtype=torch.float32)
            
        w = w.to(device)
        if w.ndim == 1: w = w.unsqueeze(-1)
        while w.ndim > 2: w = w.squeeze(0) 
        if w.shape[0] < w.shape[1]: w = w.t() 
        return w

    def _match_channels(self, w, target_c):
        if w.shape[1] < target_c:
            return w.repeat(1, target_c // w.shape[1] + 1)[:, :target_c]
        return w

    def _normalize_audio(self, w, target_db=-20.0):
        rms = torch.sqrt(torch.mean(w**2) + 1e-9)
        target_amp = 10**(target_db / 20)
        return w * (target_amp / rms)

    def _resample_waveform(self, waveform, target_samples):
        if target_samples <= 0: return torch.empty((0, waveform.shape[1]), device=waveform.device)
        if waveform.shape[0] == 0: return torch.zeros((target_samples, waveform.shape[1]), device=waveform.device)
        w = waveform.t().unsqueeze(0)
        resampled = F.interpolate(w, size=int(target_samples), mode='linear', align_corners=False)
        return resampled.squeeze(0).t()

    def _generate_y_values_ab(self, num_frames, easing_clamp, easing_type):
        if num_frames <= 1: return [0.5] if num_frames == 1 else []
        remap_clamp = (easing_clamp - 0.5) * 2
        y = []
        for i in range(num_frames):
            t = i / (num_frames - 1)
            t_eased = self._apply_easing(t, easing_type)
            y.append(t_eased ** (2**-remap_clamp))
        return y

    def _apply_easing(self, t, easing_type):
        if easing_type == "ease_in": return t * t
        if easing_type == "ease_out": return 1.0 - (1.0 - t)**2
        if easing_type == "ease_in_out": return 2*t*t if t < 0.5 else 1-2*(1-t)**2
        return t

    def _resize_to_target(self, image, target_b, target_h, target_w, target_c):
        b, h, w, c = image.shape
        if (h, w, c) != (target_h, target_w, target_c):
            image = image.permute(0, 3, 1, 2)
            image = F.interpolate(image, size=(target_h, target_w), mode="bilinear", align_corners=False)
            image = image.permute(0, 2, 3, 1)
        return image

    def _blend_images(self, base, overlay, opacity):
        mask = opacity.view(-1, 1, 1, 1)
        return base * mask + overlay * (1.0 - mask)

    def _cut_mode_merge(self, image_A, image_B, safe_overlap, easing_clamp, easing_type, device):
        """
        CUT MODE: Overlay image_B at the end of image_A.

        Example: image_A=121 frames, image_B=21 frames, FlamesOverlap=5
        - Discard first (21-5)=16 frames of B
        - Use last 5 frames of B blended from 0% to 100% opacity over A's last 5 frames
        - Result: 121 frames total, with last frame being 100% image_B
        """
        num_a = image_A.shape[0]

        # Get the last safe_overlap frames of B to overlay
        b_overlay = image_B[-safe_overlap:] if safe_overlap <= image_B.shape[0] else image_B
        a_background_end = image_A[-safe_overlap:]

        # Generate opacity curve from 0 to 1 (fade in B over A)
        y_list = self._generate_y_values_ab(safe_overlap, easing_clamp, easing_type)
        opacity_y = torch.tensor(y_list, dtype=torch.float32, device=device)

        # Blend: result = B * opacity + A * (1 - opacity)
        blended_end = self._blend_images(b_overlay, a_background_end, opacity_y)

        # Concatenate: full A minus last safe_overlap frames + blended end
        if safe_overlap > 0 and num_a > safe_overlap:
            result_image = torch.cat([image_A[:-safe_overlap], blended_end], dim=0)
        else:
            result_image = blended_end

        return result_image


class AudioMergeABC:
    """
    Merges three audio sources (A, B, C) using the same easing curve parameters as VideoMergeABC.

    The merge structure mirrors the video:
    - A fades out during A→B transition zone
    - B is at full volume in the middle section
    - B fades out and C fades in during B→C transition zone

    Uses video_meta from VideoMergeABC to ensure synchronized transitions.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio_A": ("AUDIO",),
                "audio_B": ("AUDIO",),
                "audio_C": ("AUDIO",),
                "video_meta": ("VIDEO_META",),
                "video_fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0, "step": 0.5}),
                "normalize_volume": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "merge_abc_audio"
    CATEGORY = "WanVideoWrapper_QQ/audio"

    def merge_abc_audio(
        self,
        video_meta,
        video_fps,
        normalize_volume,
        audio_A=None,
        audio_B=None,
        audio_C=None,
    ):
        # Use CPU for audio processing to avoid device mismatch issues
        device = torch.device("cpu")
        output_sr = 44100

        # Extract merge settings from video_meta (from VideoMergeABC)
        A_overlap = video_meta.get("A_overlap", 24)
        B_overlap = video_meta.get("B_overlap", 24)
        easing_clamp = video_meta.get("easing_clamp", 0.5)
        easing_type = video_meta.get("easing_type", "linear")

        # Extract audio from inputs
        has_audio_a = audio_A is not None
        has_audio_b = audio_B is not None
        has_audio_c = audio_C is not None

        if has_audio_a:
            waveform_a, sr_a = self._extract_audio(audio_A)
            waveform_a = self._to_std_audio(waveform_a, device)
            output_sr = max(output_sr, sr_a)
        else:
            waveform_a = torch.zeros((int(120 * 44100 / video_fps), 2), device=device)
            sr_a = 44100

        if has_audio_b:
            waveform_b, sr_b = self._extract_audio(audio_B)
            waveform_b = self._to_std_audio(waveform_b, device)
            output_sr = max(output_sr, sr_b)
        else:
            waveform_b = torch.zeros((int(120 * 44100 / video_fps), 2), device=device)
            sr_b = 44100

        if has_audio_c:
            waveform_c, sr_c = self._extract_audio(audio_C)
            waveform_c = self._to_std_audio(waveform_c, device)
            output_sr = max(output_sr, sr_c)
        else:
            waveform_c = torch.zeros((int(120 * 44100 / video_fps), 2), device=device)
            sr_c = 44100

        # Normalize volume if enabled
        if normalize_volume and has_audio_a:
            waveform_a = self._normalize_audio(waveform_a)
        if normalize_volume and has_audio_b:
            waveform_b = self._normalize_audio(waveform_b)
        if normalize_volume and has_audio_c:
            waveform_c = self._normalize_audio(waveform_c)

        # Match channels
        max_channels = max(
            waveform_a.shape[1], waveform_b.shape[1], waveform_c.shape[1]
        )
        waveform_a = self._match_channels(waveform_a, max_channels)
        waveform_b = self._match_channels(waveform_b, max_channels)
        waveform_c = self._match_channels(waveform_c, max_channels)

        # Get frame counts from audio duration (assuming they match video frames)
        num_a = int(waveform_a.shape[0] * video_fps / output_sr)
        num_b = int(waveform_b.shape[0] * video_fps / output_sr)
        num_c = int(waveform_c.shape[0] * video_fps / output_sr)

        # Calculate safe overlaps (matching VideoMergeABC logic)
        safe_A_overlap = min(A_overlap, num_a, num_b // 2)
        safe_B_overlap = min(B_overlap, num_c, num_b // 2)

        # Convert frame overlaps to sample counts
        a_overlap_samples = int(safe_A_overlap * output_sr / video_fps)
        b_overlap_samples = int(safe_B_overlap * output_sr / video_fps)

        # Calculate part lengths in samples
        a_part1_samples = int((num_a - safe_A_overlap) * output_sr / video_fps)
        b_middle_samples = int((num_b - safe_A_overlap - safe_B_overlap) * output_sr / video_fps)
        c_part2_samples = int((num_c - safe_B_overlap) * output_sr / video_fps)

        # Generate opacity curves for transitions
        # A→B transition: B fades in (0→1), so A fades out (1→0)
        if a_overlap_samples > 0:
            y_ab = self._generate_y_values_ab(a_overlap_samples, easing_clamp, easing_type)
            opacity_ab = torch.tensor(y_ab, dtype=torch.float32, device=device).unsqueeze(-1)

        # B→C transition: C fades in (0→1), B fades out (1→0)
        if b_overlap_samples > 0:
            y_bc = self._generate_y_values_ab(b_overlap_samples, easing_clamp, easing_type)
            opacity_bc = torch.tensor(y_bc, dtype=torch.float32, device=device).unsqueeze(-1)

        # Split and process audio segments using ratio-based slicing for sync
        # Audio A: part1 + overlap_region (for crossfade with B)
        if a_part1_samples > 0:
            ratio_a1_end = (num_a - safe_A_overlap) / num_a if num_a > 0 else 1.0
            idx_a1_end = int(waveform_a.shape[0] * ratio_a1_end)
            audio_a_part1 = self._resample_waveform(
                waveform_a[:idx_a1_end], a_part1_samples
            )
        else:
            audio_a_part1 = torch.zeros((0, max_channels), device=device)

        # A overlap region (will be crossfaded with B)
        if a_overlap_samples > 0 and safe_A_overlap > 0:
            ratio_a_fade_start = (num_a - safe_A_overlap) / num_a if num_a > 0 else 0.0
            idx_a_fade_start = int(waveform_a.shape[0] * ratio_a_fade_start)
            audio_a_overlap = self._resample_waveform(
                waveform_a[idx_a_fade_start:], a_overlap_samples
            )
        else:
            audio_a_overlap = torch.zeros((0, max_channels), device=device)

        # Audio B: overlap_region (with A) + middle + overlap_region (with C)
        if safe_A_overlap > 0 and a_overlap_samples > 0:
            ratio_b_fade_end = safe_A_overlap / num_b if num_b > 0 else 1.0
            idx_b_fade_end = int(waveform_b.shape[0] * ratio_b_fade_end)
            audio_b_overlap_a = self._resample_waveform(
                waveform_b[:idx_b_fade_end], a_overlap_samples
            )
        else:
            audio_b_overlap_a = torch.zeros((0, max_channels), device=device)

        if b_middle_samples > 0:
            ratio_b_mid_start = safe_A_overlap / num_b if num_b > 0 else 0.0
            ratio_b_mid_end = (num_b - safe_B_overlap) / num_b if num_b > 0 else 1.0
            idx_b_mid_start = int(waveform_b.shape[0] * ratio_b_mid_start)
            idx_b_mid_end = int(waveform_b.shape[0] * ratio_b_mid_end)
            audio_b_middle = self._resample_waveform(
                waveform_b[idx_b_mid_start:idx_b_mid_end], b_middle_samples
            )
        else:
            audio_b_middle = torch.zeros((0, max_channels), device=device)

        if safe_B_overlap > 0 and b_overlap_samples > 0:
            ratio_b_fadeout_start = (num_b - safe_B_overlap) / num_b if num_b > 0 else 0.0
            idx_b_fadeout_start = int(waveform_b.shape[0] * ratio_b_fadeout_start)
            audio_b_overlap_c = self._resample_waveform(
                waveform_b[idx_b_fadeout_start:], b_overlap_samples
            )
        else:
            audio_b_overlap_c = torch.zeros((0, max_channels), device=device)

        # Audio C: overlap_region (with B) + part2
        if safe_B_overlap > 0 and b_overlap_samples > 0:
            ratio_c_fade_end = safe_B_overlap / num_c if num_c > 0 else 1.0
            idx_c_fade_end = int(waveform_c.shape[0] * ratio_c_fade_end)
            audio_c_overlap = self._resample_waveform(
                waveform_c[:idx_c_fade_end], b_overlap_samples
            )
        else:
            audio_c_overlap = torch.zeros((0, max_channels), device=device)

        if c_part2_samples > 0:
            ratio_c2_start = safe_B_overlap / num_c if num_c > 0 else 0.0
            idx_c2_start = int(waveform_c.shape[0] * ratio_c2_start)
            audio_c_part2 = self._resample_waveform(
                waveform_c[idx_c2_start:], c_part2_samples
            )
        else:
            audio_c_part2 = torch.zeros((0, max_channels), device=device)

        # Crossfade blending: gradually blend overlapping audios using the same curve as video
        # A→B crossfade: B fades in (opacity 0→1), A fades out (1-opacity)
        if a_overlap_samples > 0:
            # blended = B * opacity + A * (1 - opacity) where opacity goes from 0 to 1
            blended_ab = (audio_b_overlap_a * opacity_ab) + (audio_a_overlap * (1.0 - opacity_ab))
        else:
            blended_ab = torch.zeros((0, max_channels), device=device)

        # B→C crossfade: C fades in (opacity 0→1), B fades out (1-opacity)
        if b_overlap_samples > 0:
            # blended = C * opacity + B * (1 - opacity) where opacity goes from 0 to 1
            blended_bc = (audio_c_overlap * opacity_bc) + (audio_b_overlap_c * (1.0 - opacity_bc))
        else:
            blended_bc = torch.zeros((0, max_channels), device=device)

        # Final concatenation: A_part1 + AB_crossfade + B_middle + BC_crossfade + C_part2
        result_waveform = torch.cat(
            [
                audio_a_part1,
                blended_ab,
                audio_b_middle,
                blended_bc,
                audio_c_part2,
            ],
            dim=0,
        )

        # Ensure non-zero output
        if result_waveform.shape[0] == 0:
            result_waveform = torch.zeros((output_sr, max_channels), device=device)

        result_audio = {
            "waveform": result_waveform.t().unsqueeze(0),
            "sample_rate": output_sr,
        }

        return (result_audio,)

    def _extract_audio(self, audio):
        """Standardizes input that might be a dict, LazyAudioMap, or Tensor."""
        waveform = None
        sample_rate = 44100

        if hasattr(audio, "get"):  # Handle LazyAudioMap
            waveform = audio.get("waveform")
            sample_rate = audio.get("sample_rate", 44100)
        elif isinstance(audio, dict):  # Handle standard dict
            waveform = audio.get("waveform")
            sample_rate = audio.get("sample_rate", 44100)
        else:
            waveform = audio

        return waveform, sample_rate

    def _to_std_audio(self, w, device):
        """Convert audio to standard [samples, channels] tensor format."""
        if not isinstance(w, torch.Tensor):
            if hasattr(w, "numpy"):
                w = torch.from_numpy(w())
            else:
                w = torch.tensor(w, dtype=torch.float32)

        w = w.to(device)
        if w.ndim == 1:
            w = w.unsqueeze(-1)
        while w.ndim > 2:
            w = w.squeeze(0)
        # Ensure samples first, channels second
        if w.shape[0] < w.shape[1]:
            w = w.t()
        return w

    def _match_channels(self, w, target_c):
        """Match audio to target channel count."""
        if w.shape[1] < target_c:
            return w.repeat(1, target_c // w.shape[1] + 1)[:, :target_c]
        return w

    def _normalize_audio(self, w, target_db=-20.0):
        """Normalize audio to target RMS level."""
        rms = torch.sqrt(torch.mean(w**2) + 1e-9)
        target_amp = 10 ** (target_db / 20)
        return w * (target_amp / rms)

    def _resample_waveform(self, waveform, target_samples):
        """Resample audio waveform to target sample count using linear interpolation."""
        if target_samples <= 0:
            return torch.empty((0, waveform.shape[1]), device=waveform.device)
        if waveform.shape[0] == 0:
            return torch.zeros(
                (target_samples, waveform.shape[1]), device=waveform.device
            )
        w = waveform.t().unsqueeze(0)  # [1, channels, samples]
        resampled = F.interpolate(
            w, size=int(target_samples), mode="linear", align_corners=False
        )
        return resampled.squeeze(0).t()  # [samples, channels]

    def _generate_y_values_ab(self, num_frames, easing_clamp, easing_type):
        """Generate fade curve from 0 to 1 for AB-style transition."""
        if num_frames <= 1:
            return [0.5] if num_frames == 1 else []
        remap_clamp = (easing_clamp - 0.5) * 2
        y = []
        for i in range(num_frames):
            t = i / (num_frames - 1)
            t_eased = self._apply_easing(t, easing_type)
            y.append(t_eased ** (2**-remap_clamp))
        return y

    def _apply_easing(self, t, easing_type):
        """Apply easing function to normalized time value."""
        if easing_type == "ease_in":
            return t * t
        if easing_type == "ease_out":
            return 1.0 - (1.0 - t) ** 2
        if easing_type == "ease_in_out":
            return 2 * t * t if t < 0.5 else 1 - 2 * (1 - t) ** 2
        return t


class VideoPrepAB:
    """
    Prepares a video sequence by combining end frames from image_A, start frames from image_B,
    and inserting empty colored frames in the middle.

    Uses image_A's size as reference - scales image_B to match on one dimension
    and crops the larger one.

    Optionally handles audio the same way: end of audio_A + silent mid + start of audio_B.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_A": ("IMAGE",),
                "image_B": ("IMAGE",),
                "mid_frames_RGB": ("STRING", {"default": "0,191,0"}),
                "end_A_frames": ("INT", {"default": 24, "min": 0, "max": 10000, "step": 1}),
                "start_B_frames": ("INT", {"default": 24, "min": 0, "max": 10000, "step": 1}),
                "total_frames": ("INT", {"default": 121, "min": 1, "max": 993, "step": 8}),
                "video_fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0, "step": 0.5}),
                "audio_blend_frames": ("INT", {"default": 4, "min": 0, "max": 1000, "step": 1}),
            },
            "optional": {
                "audio_A": ("AUDIO",),
                "audio_B": ("AUDIO",),
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "IMAGE")
    RETURN_NAMES = ("Images", "audio", "audio_mask")
    FUNCTION = "video_prep_ab"
    CATEGORY = "WanVideoWrapper_QQ/video"

    def video_prep_ab(self, image_A, image_B, mid_frames_RGB, end_A_frames, start_B_frames, total_frames, video_fps, audio_blend_frames, audio_A=None, audio_B=None):
        device = image_A.device

        # Get dimensions
        num_a, h_a, w_a, c_a = image_A.shape
        num_b, h_b, w_b, c_b = image_B.shape

        # Use image_A's dimensions as target
        target_h, target_w, target_c = h_a, w_a, max(c_a, c_b)

        # Resize/scale image_B to match image_A's size (scale on matching side, crop biggest)
        image_B_resized = self._resize_to_match(image_B, num_b, target_h, target_w, target_c)

        # Ensure image_A has correct channels
        if c_a != target_c:
            if c_a == 1:
                image_A = image_A.repeat(1, 1, 1, target_c)
            else:
                image_A = image_A[..., :target_c]

        # Calculate mid frames count
        mid_frames_count = total_frames - end_A_frames - start_B_frames

        # Clamp frame counts to available frames
        end_A_frames = min(end_A_frames, num_a)
        start_B_frames = min(start_B_frames, image_B_resized.shape[0])

        # If mid_frames_count is negative, we need to reduce total or the overlap frames
        if mid_frames_count < 0:
            # Reduce end_A and start_B proportionally
            excess = -mid_frames_count
            end_A_frames = max(0, end_A_frames - excess // 2)
            start_B_frames = max(0, start_B_frames - (excess + excess % 2) // 2)
            mid_frames_count = total_frames - end_A_frames - start_B_frames

        # Get frames from image_A (last end_A_frames)
        if end_A_frames > 0:
            frames_a = image_A[-end_A_frames:] if end_A_frames <= num_a else image_A
        else:
            frames_a = torch.zeros((0, target_h, target_w, target_c), device=device)

        # Get frames from image_B (first start_B_frames)
        if start_B_frames > 0:
            frames_b = image_B_resized[:start_B_frames]
        else:
            frames_b = torch.zeros((0, target_h, target_w, target_c), device=device)

        # Parse RGB color string (e.g., "0,191,0") and convert to 0.0-1.0 range
        try:
            r_str, g_str, b_str = mid_frames_RGB.split(",")
            r_val = float(r_str.strip()) / 255.0
            g_val = float(g_str.strip()) / 255.0
            b_val = float(b_str.strip()) / 255.0
        except (ValueError, AttributeError):
            # Fallback to grayscale if parsing fails
            try:
                val = float(mid_frames_RGB) / 100.0
                r_val = g_val = b_val = val
            except:
                r_val = g_val = b_val = 0.5

        if mid_frames_count > 0:
            # Create colored fill for each channel
            if target_c == 1:
                # Grayscale: use average of RGB
                color_value = (r_val + g_val + b_val) / 3.0
                mid_frames = torch.full(
                    (mid_frames_count, target_h, target_w, target_c),
                    color_value,
                    device=device
                )
            elif target_c == 3:
                # RGB: create separate channel values
                mid_frames = torch.zeros((mid_frames_count, target_h, target_w, target_c), device=device)
                mid_frames[..., 0] = r_val
                mid_frames[..., 1] = g_val
                mid_frames[..., 2] = b_val
            else:  # RGBA or more channels
                mid_frames = torch.zeros((mid_frames_count, target_h, target_w, target_c), device=device)
                mid_frames[..., 0] = r_val
                mid_frames[..., 1] = g_val
                mid_frames[..., 2] = b_val
        else:
            mid_frames = torch.zeros((0, target_h, target_w, target_c), device=device)

        # Concatenate: A_end + mid_empty + B_start
        result = torch.cat([frames_a, mid_frames, frames_b], dim=0)

        # === Audio Processing (mirrors video structure) ===
        output_sr = 44100
        has_audio_a = audio_A is not None
        has_audio_b = audio_B is not None

        if has_audio_a or has_audio_b:
            # Extract audio from inputs
            if has_audio_a:
                waveform_a, sr_a = self._extract_audio(audio_A)
                waveform_a = self._to_std_audio(waveform_a, device)
                output_sr = max(output_sr, sr_a)
            else:
                waveform_a = torch.zeros((int(total_frames * 44100 / video_fps), 2), device=device)

            if has_audio_b:
                waveform_b, sr_b = self._extract_audio(audio_B)
                waveform_b = self._to_std_audio(waveform_b, device)
                output_sr = max(output_sr, sr_b)
            else:
                waveform_b = torch.zeros((int(total_frames * 44100 / video_fps), 2), device=device)

            # Match channels
            max_channels = max(waveform_a.shape[1], waveform_b.shape[1])
            waveform_a = self._match_channels(waveform_a, max_channels)
            waveform_b = self._match_channels(waveform_b, max_channels)

            # Calculate sample counts from frame counts
            end_A_samples = int(end_A_frames * output_sr / video_fps)
            start_B_samples = int(start_B_frames * output_sr / video_fps)
            mid_samples = int(mid_frames_count * output_sr / video_fps)

            # Get audio segments (mirroring video logic)
            num_a = waveform_a.shape[0]
            num_b = waveform_b.shape[0]

            # Audio A: last end_A_samples
            if end_A_samples > 0 and num_a > 0:
                actual_end_A = min(end_A_samples, num_a)
                audio_a = self._resample_waveform(waveform_a[-actual_end_A:], end_A_samples)
            else:
                audio_a = torch.zeros((0, max_channels), device=device)

            # Audio B: first start_B_samples
            if start_B_samples > 0 and num_b > 0:
                actual_start_B = min(start_B_samples, num_b)
                audio_b = self._resample_waveform(waveform_b[:actual_start_B], start_B_samples)
            else:
                audio_b = torch.zeros((0, max_channels), device=device)

            # Mid: silent samples
            if mid_samples > 0:
                audio_mid = torch.zeros((mid_samples, max_channels), device=device)
            else:
                audio_mid = torch.zeros((0, max_channels), device=device)

            # Concatenate: A_end + mid_silent + B_start
            result_waveform = torch.cat([audio_a, audio_mid, audio_b], dim=0)
        else:
            # No audio inputs - create silent output matching video duration
            total_samples = int(total_frames * output_sr / video_fps)
            result_waveform = torch.zeros((total_samples, 2), device=device)

        result_audio = {
            "waveform": result_waveform.t().unsqueeze(0),
            "sample_rate": output_sr,
        }

        # === Audio Mask Generation ===
        # Creates a mask mirroring the video structure:
        # - White (1.0) for end_A_frames region (A's portion)
        # - Black (0.0) for mid frames region
        # - White (1.0) for start_B_frames region (B's portion)
        # With linear transitions using audio_blend_frames on both sides

        total_samples = int(total_frames * output_sr / video_fps)
        end_A_samples = int(end_A_frames * output_sr / video_fps)
        start_B_samples = int(start_B_frames * output_sr / video_fps)
        blend_samples = max(1, int(audio_blend_frames * output_sr / video_fps))

        # Create mask: black (0.0) everywhere initially
        audio_mask = torch.zeros((total_samples,), dtype=torch.float32, device=device)

        # White region at start (A's portion): samples 0 to end_A_samples
        # With fade-out transition over blend_samples
        if end_A_samples > 0:
            white_end = max(0, end_A_samples - blend_samples)
            audio_mask[:white_end] = 1.0
            # Linear fade from 1 to 0
            fade_start = white_end
            fade_end = min(end_A_samples, total_samples)
            if fade_end > fade_start:
                fade_len = fade_end - fade_start
                for i in range(fade_start, fade_end):
                    progress = (i - fade_start) / max(1, fade_len - 1)
                    audio_mask[i] = 1.0 - progress

        # White region at end (B's portion): samples (total - start_B_samples) to total
        # With fade-in transition over blend_samples
        if start_B_samples > 0:
            b_region_start = max(0, total_samples - start_B_samples)
            white_start = min(b_region_start + blend_samples, total_samples)
            audio_mask[white_start:] = 1.0
            # Linear fade from 0 to 1
            if b_region_start < white_start:
                fade_len = white_start - b_region_start
                for i in range(b_region_start, white_start):
                    progress = (i - b_region_start) / max(1, fade_len - 1)
                    audio_mask[i] = progress

        # Reshape to match video dimensions [total_frames, height, width, channels] for IMAGE output
        # Create one frame per video frame, each showing the mask value at that point in time
        # Each frame is target_h x target_w x 3 (RGB grayscale), filled with the corresponding mask value
        audio_mask_per_frame = torch.zeros((total_frames, target_h, target_w, 3), dtype=torch.float32, device=device)
        for f in range(total_frames):
            sample_idx = min(int(f * total_samples / total_frames), total_samples - 1)
            mask_value = audio_mask[sample_idx]
            audio_mask_per_frame[f] = mask_value  # Broadcast scalar to entire frame (all 3 channels)

        return (result, result_audio, audio_mask_per_frame)

    def _resize_to_match(self, image, num_frames, target_h, target_w, target_c):
        """
        Resize image to match target dimensions by scaling on one axis and cropping the other.
        Scales to fit within both dimensions while maintaining aspect ratio,
        then centers crops/pads as needed.
        """
        b, h, w, c = image.shape

        # Calculate scale factors for each dimension
        scale_h = target_h / h if h > 0 else 1.0
        scale_w = target_w / w if w > 0 else 1.0

        # Use the larger scale factor (scale to cover, then crop)
        scale = max(scale_h, scale_w)

        new_h = int(h * scale)
        new_w = int(w * scale)

        # Resize using bicubic interpolation for better quality
        image = image.permute(0, 3, 1, 2)  # [B, C, H, W]
        image = F.interpolate(image, size=(new_h, new_w), mode="bicubic", align_corners=False)
        image = image.permute(0, 2, 3, 1)  # [B, H, W, C]

        # Center crop to target dimensions
        start_h = (new_h - target_h) // 2
        start_w = (new_w - target_w) // 2
        image = image[:, start_h:start_h + target_h, start_w:start_w + target_w, :]

        # Handle channels
        if c != target_c:
            if c == 1:
                image = image.repeat(1, 1, 1, target_c)
            else:
                image = image[..., :target_c]

        return image

    def _extract_audio(self, audio):
        """Standardizes input that might be a dict, LazyAudioMap, or Tensor."""
        waveform = None
        sample_rate = 44100

        if hasattr(audio, "get"):  # Handle LazyAudioMap
            waveform = audio.get("waveform")
            sample_rate = audio.get("sample_rate", 44100)
        elif isinstance(audio, dict):  # Handle standard dict
            waveform = audio.get("waveform")
            sample_rate = audio.get("sample_rate", 44100)
        else:
            waveform = audio

        return waveform, sample_rate

    def _to_std_audio(self, w, device):
        """Convert audio to standard [samples, channels] tensor format."""
        if not isinstance(w, torch.Tensor):
            if hasattr(w, "numpy"):
                w = torch.from_numpy(w())
            else:
                w = torch.tensor(w, dtype=torch.float32)

        w = w.to(device)
        if w.ndim == 1:
            w = w.unsqueeze(-1)
        while w.ndim > 2:
            w = w.squeeze(0)
        # Ensure samples first, channels second
        if w.shape[0] < w.shape[1]:
            w = w.t()
        return w

    def _match_channels(self, w, target_c):
        """Match audio to target channel count."""
        if w.shape[1] < target_c:
            return w.repeat(1, target_c // w.shape[1] + 1)[:, :target_c]
        return w

    def _resample_waveform(self, waveform, target_samples):
        """Resample audio waveform to target sample count using linear interpolation."""
        if target_samples <= 0:
            return torch.empty((0, waveform.shape[1]), device=waveform.device)
        if waveform.shape[0] == 0:
            return torch.zeros((target_samples, waveform.shape[1]), device=waveform.device)
        w = waveform.t().unsqueeze(0)  # [1, channels, samples]
        resampled = F.interpolate(
            w, size=int(target_samples), mode="linear", align_corners=False
        )
        return resampled.squeeze(0).t()  # [samples, channels]


class VideoRGBAnalysis:
    """
    Analyzes video frames for RGB channel intensity and overall brightness.
    Displays a real-time graph showing color distribution over time.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "display_mode": (["intensity", "saturation"], {"default": "intensity"}),
            },
        }

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "analyze_rgb"
    CATEGORY = "WanVideoWrapper_QQ/video"

    def analyze_rgb(self, image, display_mode):
        """
        Analyze RGB channels and brightness for each frame.

        Args:
            image: Video tensor [B, H, W, C] where B=frames, C=3 (RGB)
            display_mode: "intensity" for mean channel values, "saturation" for HSV-style saturation

        Returns:
            Dictionary with UI graph data and result (original image passed through)
        """
        device = image.device
        b, h, w, c = image.shape

        # Handle edge cases
        if b == 0:
            empty_graph = {"x": [], "y_r": [], "y_g": [], "y_b": [], "y_brightness": []}
            ui_data = {"rgb_analysis_graph": [empty_graph]}
            return {"ui": ui_data}

        # Calculate per-frame channel means
        # image shape: [B, H, W, C]
        # Mean over H and W dimensions: [B, C]
        frame_means = torch.mean(image.float(), dim=[1, 2])  # [B, 3]

        # Extract individual channels
        red_values = frame_means[:, 0].cpu().tolist()  # R channel
        green_values = frame_means[:, 1].cpu().tolist()  # G channel
        blue_values = frame_means[:, 2].cpu().tolist()  # B channel

        # Calculate brightness using Rec. 601 luminance formula
        # brightness = 0.299 * R + 0.587 * G + 0.114 * B
        frame_means_cpu = frame_means.cpu()
        brightness_values = (
            0.299 * frame_means_cpu[:, 0]
            + 0.587 * frame_means_cpu[:, 1]
            + 0.114 * frame_means_cpu[:, 2]
        ).tolist()

        # Build graph data
        x = list(range(b))

        if display_mode == "saturation":
            # For saturation mode, normalize by max value per frame
            # This shows how vivid each color is relative to the brightest channel
            red_sat = []
            green_sat = []
            blue_sat = []

            for i in range(b):
                r, g, b_val = red_values[i], green_values[i], blue_values[i]
                max_val = max(r, g, b_val, 0.001)  # Avoid division by zero

                red_sat.append(r / max_val)
                green_sat.append(g / max_val)
                blue_sat.append(b_val / max_val)

            y_r = red_sat
            y_g = green_sat
            y_b = blue_sat
        else:  # intensity mode (default)
            y_r = red_values
            y_g = green_values
            y_b = blue_values

        graph_data = {
            "x": x,
            "y_r": y_r,
            "y_g": y_g,
            "y_b": y_b,
            "y_brightness": brightness_values,
            "display_mode": display_mode,
        }

        # Return in UI format (no output, just graph)
        ui_data = {"rgb_analysis_graph": [graph_data]}
        return {"ui": ui_data}

class VideoLoopMove:
    """
    Moves the last N frames of a video loop to the beginning.
    Useful for adjusting loop start points without re-rendering.

    Example: 100-frame video with num_frames=16
    - Takes last 16 frames (frames 84-99)
    - Puts them at the start
    - Result order: [84, 85, ..., 99, 0, 1, ..., 83]
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "num_frames": ("INT", {"default": 16, "min": 0, "max": 10000, "step": 1}),
            },
            "optional": {
                "audio": ("AUDIO",),
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO")
    RETURN_NAMES = ("image", "audio")
    FUNCTION = "loop_move"
    CATEGORY = "WanVideoWrapper_QQ/video"

    def loop_move(self, image, num_frames, audio=None):
        total_frames = image.shape[0]

        # Handle edge cases
        if num_frames <= 0:
            result_image = image
        elif num_frames >= total_frames:
            # If num_frames >= total, just return as-is
            result_image = image
        else:
            # Split: last num_frames go to front, rest follow
            moved_part = image[-num_frames:]  # Last N frames
            remaining_part = image[:-num_frames]  # First (total - N) frames
            result_image = torch.cat([moved_part, remaining_part], dim=0)

        # Apply same loop move to audio if provided
        if audio is not None:
            waveform = audio["waveform"]
            sample_rate = audio["sample_rate"]
            total_samples = waveform.shape[-1]

            # Calculate samples per frame ratio
            samples_per_frame = total_samples / total_frames
            num_samples_to_move = int(num_frames * samples_per_frame)

            if num_samples_to_move > 0 and num_samples_to_move < total_samples:
                # Apply same loop move to audio
                moved_audio = waveform[..., -num_samples_to_move:]
                remaining_audio = waveform[..., :-num_samples_to_move]
                result_audio_waveform = torch.cat([moved_audio, remaining_audio], dim=-1)
            else:
                result_audio_waveform = waveform

            result_audio = {"waveform": result_audio_waveform, "sample_rate": sample_rate}
        else:
            result_audio = audio

        return (result_image, result_audio)


NODE_CLASS_MAPPINGS = {
    "VideoMergeABC": VideoMergeABC,
    "VideoAudioMergeAB": VideoAudioMergeAB,
    "AudioMergeABC": AudioMergeABC,
    "VideoPrepAB": VideoPrepAB,
    "VideoRGBAnalysis": VideoRGBAnalysis,
    "VideoLoopMove": VideoLoopMove,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoMergeABC": "Video Merge ABC",
    "VideoAudioMergeAB": "VideoAudio Merge AB",
    "AudioMergeABC": "Audio Merge ABC",
    "VideoPrepAB": "Video Prep AB",
    "VideoRGBAnalysis": "Video RGB Analysis",
    "VideoLoopMove": "Video Loop Move",
}
