import torch
import torch.nn.functional as F
import numpy as np

class WanVideoMotionToFlowmap:
    """
    Analyzes video motion and generates flowmap (displacement map).
    Supports multiple motion detection algorithms.
    """

    MOTION_MODES = [
        "gradient_flow",      # Gradient-based optical flow (GPU, fast)
        "frame_diff",         # Simple frame difference with directional analysis
        "centroid_track",     # Track bright regions/orbs
        "optical_flow"        # OpenCV Farneback (if available)
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("IMAGE",),  # BHWC tensor
                "mode": (cls.MOTION_MODES,),
                "strength": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 10.0,
                    "step": 0.1,
                    "display": "slider"
                }),
                "smoothing": ("FLOAT", {
                    "default": 0.0,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.05,
                    "display": "slider"
                }),
                "threshold": ("FLOAT", {
                    "default": 0.5,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display": "slider"
                }),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("flowmap",)
    FUNCTION = "generate_flowmap"
    CATEGORY = "WanVideoWrapper_QQ/video"
    DESCRIPTION = "Detects motion in video and generates RGB flowmap (R=horizontal, G=vertical, B=magnitude)"

    def generate_flowmap(self, video, mode, strength, smoothing, threshold):
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        video_tensor = video.to(device)

        if mode == "gradient_flow":
            flowmap = self._gradient_flow(video_tensor, strength, smoothing)
        elif mode == "frame_diff":
            flowmap = self._frame_diff(video_tensor, strength, smoothing)
        elif mode == "centroid_track":
            flowmap = self._centroid_track(video_tensor, strength, threshold, smoothing)
        elif mode == "optical_flow":
            flowmap = self._optical_flow(video_tensor, strength, smoothing)
        else:
            flowmap = self._frame_diff(video_tensor, strength, smoothing)

        return (flowmap.cpu(),)

    def _gradient_flow(self, video, strength, smoothing):
        """
        Gradient-based optical flow using PyTorch.
        Based on Lucas-Kanade brightness constancy assumption.
        """
        device = video.device
        b, h, w, c = video.shape

        # Convert to grayscale if needed
        if c == 3:
            gray = 0.299 * video[..., 0] + 0.587 * video[..., 1] + 0.114 * video[..., 2]
        else:
            gray = video[..., 0]

        # Initialize flow output [B, H, W, 3] (R=u, G=v, B=magnitude)
        flow_output = torch.zeros((b, h, w, 3), device=device, dtype=video.dtype)

        # For first frame, no motion
        if b < 2:
            flow_output[..., :] = 0.5  # Neutral (no displacement)
            return flow_output

        # Calculate flow for each frame pair
        prev_smoothed_flow = None

        for i in range(1, b):
            frame_prev = gray[i-1]
            frame_curr = gray[i]

            # Spatial gradients (Sobel filters)
            # Convert to NCHW for conv2d: [1, 1, H, W]
            frame_prev_nchw = frame_prev.unsqueeze(0).unsqueeze(0)
            frame_curr_nchw = frame_curr.unsqueeze(0).unsqueeze(0)

            # Sobel kernels
            sobel_x = torch.tensor([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]],
                                   dtype=video.dtype, device=device).view(1, 1, 3, 3) / 8.0
            sobel_y = torch.tensor([[-1, -2, -1], [0, 0, 0], [1, 2, 1]],
                                   dtype=video.dtype, device=device).view(1, 1, 3, 3) / 8.0

            # Calculate gradients (average between frames for stability)
            Ix_prev = F.conv2d(frame_prev_nchw, sobel_x, padding=1)
            Iy_prev = F.conv2d(frame_prev_nchw, sobel_y, padding=1)
            Ix_curr = F.conv2d(frame_curr_nchw, sobel_x, padding=1)
            Iy_curr = F.conv2d(frame_curr_nchw, sobel_y, padding=1)

            Ix = (Ix_prev + Ix_curr) / 2.0
            Iy = (Iy_prev + Iy_curr) / 2.0

            # Temporal gradient
            It = (frame_curr - frame_prev).unsqueeze(0).unsqueeze(0)

            # Remove batch/channel dims [H, W]
            Ix = Ix.squeeze()
            Iy = Iy.squeeze()
            It = It.squeeze()

            # Lucas-Kanade: solve for flow (u, v)
            # Using simplified approach: u = -Ix*It / (Ix^2 + eps), v = -Iy*It / (Iy^2 + eps)
            eps = 1e-6
            denominator = Ix**2 + Iy**2 + eps

            u = -(Ix * It) / denominator  # Horizontal flow
            v = -(Iy * It) / denominator  # Vertical flow

            # Apply strength multiplier
            u = u * strength
            v = v * strength

            # Apply temporal smoothing
            if smoothing > 0 and prev_smoothed_flow is not None:
                u = smoothing * prev_smoothed_flow[..., 0] + (1 - smoothing) * u
                v = smoothing * prev_smoothed_flow[..., 1] + (1 - smoothing) * v

            # Calculate magnitude
            magnitude = torch.sqrt(u**2 + v**2)

            # Normalize to [0, 1] range
            # Flow values centered at 0.5 (no motion), scaled by max observed flow
            max_flow = torch.max(torch.abs(torch.stack([u, v]))) + eps
            u_norm = (u / (max_flow * 2.0)) + 0.5
            v_norm = (v / (max_flow * 2.0)) + 0.5
            mag_norm = magnitude / (max_flow + eps)

            # Clamp to valid range
            u_norm = torch.clamp(u_norm, 0.0, 1.0)
            v_norm = torch.clamp(v_norm, 0.0, 1.0)
            mag_norm = torch.clamp(mag_norm, 0.0, 1.0)

            # Store in output [H, W, 3]
            flow_output[i, :, :, 0] = u_norm
            flow_output[i, :, :, 1] = v_norm
            flow_output[i, :, :, 2] = mag_norm

            # Store for smoothing
            prev_smoothed_flow = torch.stack([u, v], dim=-1)

        # First frame copies second frame's flow
        if b > 1:
            flow_output[0] = flow_output[1]

        return flow_output

    def _frame_diff(self, video, strength, smoothing):
        """
        Simple frame difference with directional analysis.
        Faster but less accurate than optical flow.
        """
        device = video.device
        b, h, w, c = video.shape

        # Convert to grayscale
        if c == 3:
            gray = 0.299 * video[..., 0] + 0.587 * video[..., 1] + 0.114 * video[..., 2]
        else:
            gray = video[..., 0]

        flow_output = torch.zeros((b, h, w, 3), device=device, dtype=video.dtype)

        if b < 2:
            flow_output[..., :] = 0.5
            return flow_output

        prev_flow = None

        for i in range(1, b):
            # Frame difference
            diff = (gray[i] - gray[i-1]) * strength

            # Estimate directional flow using spatial gradients
            diff_nchw = diff.unsqueeze(0).unsqueeze(0)

            # Simple gradient
            sobel_x = torch.tensor([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]],
                                   dtype=video.dtype, device=device).view(1, 1, 3, 3) / 8.0
            sobel_y = torch.tensor([[-1, -2, -1], [0, 0, 0], [1, 2, 1]],
                                   dtype=video.dtype, device=device).view(1, 1, 3, 3) / 8.0

            grad_x = F.conv2d(diff_nchw, sobel_x, padding=1).squeeze()
            grad_y = F.conv2d(diff_nchw, sobel_y, padding=1).squeeze()

            # Apply smoothing
            if smoothing > 0 and prev_flow is not None:
                grad_x = smoothing * prev_flow[..., 0] + (1 - smoothing) * grad_x
                grad_y = smoothing * prev_flow[..., 1] + (1 - smoothing) * grad_y

            # Magnitude
            magnitude = torch.sqrt(grad_x**2 + grad_y**2)

            # Normalize
            max_val = torch.max(torch.abs(torch.stack([grad_x, grad_y]))) + 1e-6
            u_norm = (grad_x / (max_val * 2.0)) + 0.5
            v_norm = (grad_y / (max_val * 2.0)) + 0.5
            mag_norm = magnitude / (max_val + 1e-6)

            flow_output[i, :, :, 0] = torch.clamp(u_norm, 0.0, 1.0)
            flow_output[i, :, :, 1] = torch.clamp(v_norm, 0.0, 1.0)
            flow_output[i, :, :, 2] = torch.clamp(mag_norm, 0.0, 1.0)

            prev_flow = torch.stack([grad_x, grad_y], dim=-1)

        if b > 1:
            flow_output[0] = flow_output[1]

        return flow_output

    def _centroid_track(self, video, strength, threshold, smoothing):
        """
        Track bright regions (orbs) and generate flow field.
        Good for videos with distinct bright objects.
        """
        device = video.device
        b, h, w, c = video.shape

        # Convert to grayscale
        if c == 3:
            gray = 0.299 * video[..., 0] + 0.587 * video[..., 1] + 0.114 * video[..., 2]
        else:
            gray = video[..., 0]

        flow_output = torch.zeros((b, h, w, 3), device=device, dtype=video.dtype)

        if b < 2:
            flow_output[..., :] = 0.5
            return flow_output

        # Create coordinate grids
        y_coords = torch.arange(h, device=device, dtype=video.dtype).view(h, 1).expand(h, w)
        x_coords = torch.arange(w, device=device, dtype=video.dtype).view(1, w).expand(h, w)

        prev_centroid = None

        for i in range(b):
            # Threshold to find bright regions
            mask = (gray[i] > threshold).float()

            if mask.sum() > 0:
                # Calculate centroid
                total_mass = mask.sum()
                cx = (mask * x_coords).sum() / total_mass
                cy = (mask * y_coords).sum() / total_mass

                if prev_centroid is not None and i > 0:
                    # Calculate displacement
                    dx = (cx - prev_centroid[0]) * strength
                    dy = (cy - prev_centroid[1]) * strength

                    # Create flow field: pixels closer to bright regions have stronger flow
                    # Distance from each pixel to current centroid
                    dist_x = x_coords - cx
                    dist_y = y_coords - cy
                    dist = torch.sqrt(dist_x**2 + dist_y**2) + 1e-6

                    # Falloff: closer pixels get more displacement
                    max_dist = torch.sqrt(torch.tensor(h**2 + w**2, dtype=video.dtype, device=device))
                    falloff = torch.clamp(1.0 - (dist / (max_dist * 0.3)), 0.0, 1.0)

                    # Apply displacement with falloff
                    u = dx * falloff * mask
                    v = dy * falloff * mask
                    magnitude = torch.sqrt(u**2 + v**2)

                    # Normalize
                    max_disp = max(torch.max(torch.abs(u)), torch.max(torch.abs(v))) + 1e-6
                    u_norm = (u / (max_disp * 2.0)) + 0.5
                    v_norm = (v / (max_disp * 2.0)) + 0.5
                    mag_norm = magnitude / (max_disp + 1e-6)

                    flow_output[i, :, :, 0] = torch.clamp(u_norm, 0.0, 1.0)
                    flow_output[i, :, :, 1] = torch.clamp(v_norm, 0.0, 1.0)
                    flow_output[i, :, :, 2] = torch.clamp(mag_norm, 0.0, 1.0)
                else:
                    flow_output[i, :, :, :] = 0.5

                prev_centroid = (cx, cy)
            else:
                flow_output[i, :, :, :] = 0.5
                prev_centroid = None

        return flow_output

    def _optical_flow(self, video, strength, smoothing):
        """
        OpenCV Farneback optical flow (CPU fallback if GPU unavailable).
        """
        try:
            import cv2
        except ImportError:
            print("[WARNING] OpenCV not available, falling back to gradient_flow")
            return self._gradient_flow(video, strength, smoothing)

        b, h, w, c = video.shape

        # Convert to numpy and grayscale
        video_np = video.cpu().numpy()

        if c == 3:
            gray_frames = []
            for i in range(b):
                gray = cv2.cvtColor((video_np[i] * 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
                gray_frames.append(gray)
        else:
            gray_frames = [(video_np[i, :, :, 0] * 255).astype(np.uint8) for i in range(b)]

        flow_output = np.zeros((b, h, w, 3), dtype=np.float32)

        if b < 2:
            flow_output[..., :] = 0.5
            return torch.from_numpy(flow_output).to(video.device)

        prev_flow = None

        for i in range(1, b):
            # Calculate optical flow
            flow = cv2.calcOpticalFlowFarneback(
                gray_frames[i-1], gray_frames[i],
                None, 0.5, 3, 15, 3, 5, 1.2, 0
            )

            # flow is [H, W, 2] where [:,:,0]=horizontal, [:,:,1]=vertical
            u = flow[..., 0] * strength
            v = flow[..., 1] * strength

            # Apply smoothing
            if smoothing > 0 and prev_flow is not None:
                u = smoothing * prev_flow[..., 0] + (1 - smoothing) * u
                v = smoothing * prev_flow[..., 1] + (1 - smoothing) * v

            magnitude = np.sqrt(u**2 + v**2)

            # Normalize
            max_flow = max(np.max(np.abs(u)), np.max(np.abs(v))) + 1e-6
            u_norm = np.clip((u / (max_flow * 2.0)) + 0.5, 0.0, 1.0)
            v_norm = np.clip((v / (max_flow * 2.0)) + 0.5, 0.0, 1.0)
            mag_norm = np.clip(magnitude / (max_flow + 1e-6), 0.0, 1.0)

            flow_output[i, :, :, 0] = u_norm
            flow_output[i, :, :, 1] = v_norm
            flow_output[i, :, :, 2] = mag_norm

            prev_flow = np.stack([u, v], axis=-1)

        if b > 1:
            flow_output[0] = flow_output[1]

        return torch.from_numpy(flow_output).to(video.device)


class WanVideoFlowmapDistortion:
    """
    Applies flowmap distortion to a video using displacement mapping.
    Uses GPU-accelerated grid_sample for efficient warping.
    """

    EDGE_MODES = ["border", "reflection", "zeros"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("IMAGE",),        # Source video to distort
                "flowmap": ("IMAGE",),      # Displacement map (R=X, G=Y, B=magnitude)
                "distortion_strength": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 10.0,
                    "step": 0.1,
                    "display": "slider"
                }),
                "edge_mode": (cls.EDGE_MODES,),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("distorted_video",)
    FUNCTION = "apply_flowmap"
    CATEGORY = "WanVideoWrapper_QQ/video"
    DESCRIPTION = "Applies flowmap-based distortion to video using displacement mapping"

    def apply_flowmap(self, video, flowmap, distortion_strength, edge_mode):
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

        video_tensor = video.to(device)
        flowmap_tensor = flowmap.to(device)

        b, h, w, c = video_tensor.shape
        bf, hf, wf, cf = flowmap_tensor.shape

        # Ensure flowmap matches video dimensions
        if (hf != h) or (wf != w):
            # Resize flowmap to match video
            flowmap_bchw = flowmap_tensor.permute(0, 3, 1, 2)
            flowmap_bchw = F.interpolate(flowmap_bchw, size=(h, w), mode='bilinear', align_corners=False)
            flowmap_tensor = flowmap_bchw.permute(0, 2, 3, 1)

        # Ensure batch sizes match
        if bf != b:
            if bf < b:
                # Repeat last flowmap frame
                flowmap_tensor = torch.cat([
                    flowmap_tensor,
                    flowmap_tensor[-1:].repeat(b - bf, 1, 1, 1)
                ], dim=0)
            else:
                flowmap_tensor = flowmap_tensor[:b]

        # Process each frame
        output_frames = []

        for i in range(b):
            distorted_frame = self._apply_single_frame(
                video_tensor[i:i+1],
                flowmap_tensor[i:i+1],
                distortion_strength,
                edge_mode,
                device
            )
            output_frames.append(distorted_frame)

        output_video = torch.cat(output_frames, dim=0)

        return (output_video.cpu(),)

    def _apply_single_frame(self, frame, flowmap, strength, edge_mode, device):
        """
        Apply flowmap distortion to a single frame using grid_sample.
        """
        # frame: [1, H, W, C]
        # flowmap: [1, H, W, 3] (R=u, G=v, B=magnitude)

        h, w = frame.shape[1:3]

        # Convert frame to BCHW for grid_sample
        frame_bchw = frame.permute(0, 3, 1, 2)

        # Extract flow components (stored as [0, 1] range, 0.5 = no motion)
        u_norm = flowmap[0, :, :, 0]  # Horizontal displacement
        v_norm = flowmap[0, :, :, 1]  # Vertical displacement

        # Convert from [0, 1] to displacement in pixels
        # 0.5 = no displacement, <0.5 = negative, >0.5 = positive
        u_pixels = (u_norm - 0.5) * 2.0 * strength * w  # Scale by image width
        v_pixels = (v_norm - 0.5) * 2.0 * strength * h  # Scale by image height

        # Create base coordinate grid
        y_coords = torch.arange(h, device=device, dtype=frame.dtype)
        x_coords = torch.arange(w, device=device, dtype=frame.dtype)
        grid_y, grid_x = torch.meshgrid(y_coords, x_coords, indexing='ij')

        # Apply displacement
        sample_x = grid_x + u_pixels
        sample_y = grid_y + v_pixels

        # Normalize to [-1, 1] for grid_sample
        norm_x = (sample_x / max(w - 1.0, 1e-6)) * 2.0 - 1.0
        norm_y = (sample_y / max(h - 1.0, 1e-6)) * 2.0 - 1.0

        # Stack as [H, W, 2] and add batch dimension [1, H, W, 2]
        grid_normalized = torch.stack([norm_x, norm_y], dim=-1).unsqueeze(0)

        # Map edge_mode to grid_sample padding_mode
        padding_mode_map = {
            "border": "border",
            "reflection": "reflection",
            "zeros": "zeros"
        }
        padding_mode = padding_mode_map.get(edge_mode, "border")

        # Apply grid sampling
        distorted_bchw = F.grid_sample(
            frame_bchw,
            grid_normalized,
            mode='bilinear',
            padding_mode=padding_mode,
            align_corners=True
        )

        # Convert back to BHWC
        distorted_bhwc = distorted_bchw.permute(0, 2, 3, 1)

        # Clamp to valid range
        distorted_bhwc = torch.clamp(distorted_bhwc, 0.0, 1.0)

        return distorted_bhwc


# Node registration
NODE_CLASS_MAPPINGS = {
    "WanVideoMotionToFlowmap": WanVideoMotionToFlowmap,
    "WanVideoFlowmapDistortion": WanVideoFlowmapDistortion,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WanVideoMotionToFlowmap": "Wan Video Motion to Flowmap",
    "WanVideoFlowmapDistortion": "Wan Video Flowmap Distortion",
}
