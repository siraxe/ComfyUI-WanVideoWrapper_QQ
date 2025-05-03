import os
import gc
import torch
import torch.nn as nn
import torch.nn.functional as F
from tqdm.auto import tqdm as tqdm_auto
from collections import namedtuple

from comfy import model_management as mm
from comfy.utils import common_upscale

script_directory = os.path.dirname(os.path.abspath(__file__))

device = mm.get_torch_device()
offload_device = mm.unet_offload_device()

VAE_STRIDE = (4, 8, 8)
PATCH_SIZE = (1, 2, 2)

# ============================================================================
# Utility Functions
# ============================================================================

def add_noise_to_reference_video(image, ratio=None):
    sigma = torch.ones((image.shape[0],)).to(image.device, image.dtype) * ratio
    image_noise = torch.randn_like(image) * sigma[:, None, None, None]
    image_noise = torch.where(image==-1, torch.zeros_like(image), image_noise)
    image = image + image_noise
    return image

# ============================================================================
# TAEHV - Tiny AutoEncoder for Hunyuan Video
# ============================================================================

DecoderResult = namedtuple("DecoderResult", ("frame", "memory"))
TWorkItem = namedtuple("TWorkItem", ("input_tensor", "block_index"))

def conv(n_in, n_out, **kwargs):
    return nn.Conv2d(n_in, n_out, 3, padding=1, **kwargs)

class Clamp(nn.Module):
    def forward(self, x):
        return torch.tanh(x / 3) * 3

class MemBlock(nn.Module):
    def __init__(self, n_in, n_out):
        super().__init__()
        self.conv = nn.Sequential(conv(n_in * 2, n_out), nn.ReLU(inplace=True), conv(n_out, n_out), nn.ReLU(inplace=True), conv(n_out, n_out))
        self.skip = nn.Conv2d(n_in, n_out, 1, bias=False) if n_in != n_out else nn.Identity()
        self.act = nn.ReLU(inplace=True)
    def forward(self, x, past):
        return self.act(self.conv(torch.cat([x, past], 1)) + self.skip(x))

class TPool(nn.Module):
    def __init__(self, n_f, stride):
        super().__init__()
        self.stride = stride
        self.conv = nn.Conv2d(n_f*stride,n_f, 1, bias=False)
    def forward(self, x):
        _NT, C, H, W = x.shape
        return self.conv(x.reshape(-1, self.stride * C, H, W))

class TGrow(nn.Module):
    def __init__(self, n_f, stride):
        super().__init__()
        self.stride = stride
        self.conv = nn.Conv2d(n_f, n_f*stride, 1, bias=False)
    def forward(self, x):
        _NT, C, H, W = x.shape
        x = self.conv(x)
        return x.reshape(-1, C, H, W)

def apply_model_with_memblocks(model, x, parallel, show_progress_bar):
    """
    Apply a sequential model with memblocks to the given input.
    Args:
    - model: nn.Sequential of blocks to apply
    - x: input data, of dimensions NTCHW
    - parallel: if True, parallelize over timesteps (fast but uses O(T) memory)
        if False, each timestep will be processed sequentially (slow but uses O(1) memory)
    - show_progress_bar: if True, enables tqdm progressbar display

    Returns NTCHW tensor of output data.
    """
    assert x.ndim == 5, f"TAEHV operates on NTCHW tensors, but got {x.ndim}-dim tensor"
    N, T, C, H, W = x.shape
    if parallel:
        x = x.reshape(N*T, C, H, W)
        # parallel over input timesteps, iterate over blocks
        for b in tqdm_auto(model, disable=not show_progress_bar):
            if isinstance(b, MemBlock):
                NT, C, H, W = x.shape
                T = NT // N
                _x = x.reshape(N, T, C, H, W)
                mem = F.pad(_x, (0,0,0,0,0,0,1,0), value=0)[:,:T].reshape(x.shape)
                x = b(x, mem)
            else:
                x = b(x)
        NT, C, H, W = x.shape
        T = NT // N
        x = x.view(N, T, C, H, W)
    else:
        # TODO(oboerbohan): at least on macos this still gradually uses more memory during decode...
        # need to fix :(
        out = []
        # iterate over input timesteps and also iterate over blocks.
        # because of the cursed TPool/TGrow blocks, this is not a nested loop,
        # it's actually a ***graph traversal*** problem! so let's make a queue
        work_queue = [TWorkItem(xt, 0) for t, xt in enumerate(x.reshape(N, T * C, H, W).chunk(T, dim=1))]
        # in addition to manually managing our queue, we also need to manually manage our progressbar.
        # we'll update it for every source node that we consume.
        progress_bar = tqdm_auto(range(T), disable=not show_progress_bar)
        # we'll also need a separate addressable memory per node as well
        mem = [None] * len(model)
        while work_queue:
            xt, i = work_queue.pop(0)
            if i == 0:
                # new source node consumed
                progress_bar.update(1)
            if i == len(model):
                # reached end of the graph, append result to output list
                out.append(xt)
            else:
                # fetch the block to process
                b = model[i]
                if isinstance(b, MemBlock):
                    # mem blocks are simple since we're visiting the graph in causal order
                    if mem[i] is None:
                        xt_new = b(xt, xt * 0)
                        mem[i] = xt
                    else:
                        xt_new = b(xt, mem[i])
                        mem[i].copy_(xt) # inplace might reduce mysterious pytorch memory allocations? doesn't help though
                    # add successor to work queue
                    work_queue.insert(0, TWorkItem(xt_new, i+1))
                elif isinstance(b, TPool):
                    # pool blocks are miserable
                    if mem[i] is None:
                        mem[i] = [] # pool memory is itself a queue of inputs to pool
                    mem[i].append(xt)
                    if len(mem[i]) > b.stride:
                        # pool mem is in invalid state, we should have pooled before this
                        raise ValueError("???")
                    elif len(mem[i]) < b.stride:
                        # pool mem is not yet full, go back to processing the work queue
                        pass
                    else:
                        # pool mem is ready, run the pool block
                        N, C, H, W = xt.shape
                        xt = b(torch.cat(mem[i], 1).view(N*b.stride, C, H, W))
                        # reset the pool mem
                        mem[i] = []
                        # add successor to work queue
                        work_queue.insert(0, TWorkItem(xt, i+1))
                elif isinstance(b, TGrow):
                    xt = b(xt)
                    NT, C, H, W = xt.shape
                    # each tgrow has multiple successor nodes
                    for xt_next in reversed(xt.view(N, b.stride*C, H, W).chunk(b.stride, 1)):
                        # add successor to work queue
                        work_queue.insert(0, TWorkItem(xt_next, i+1))
                else:
                    # normal block with no funny business
                    xt = b(xt)
                    # add successor to work queue
                    work_queue.insert(0, TWorkItem(xt, i+1))
        progress_bar.close()
        x = torch.stack(out, 1)
    return x

class TAEHV(nn.Module):
    latent_channels = 16
    image_channels = 3
    def __init__(self, state_dict, parallel=False, decoder_time_upscale=(True, True), decoder_space_upscale=(True, True, True)):
        """Initialize pretrained TAEHV from the given checkpoint.

        Arg:
            checkpoint_path: path to weight file to load. taehv.pth for Hunyuan, taew2_1.pth for Wan 2.1.
            decoder_time_upscale: whether temporal upsampling is enabled for each block. upsampling can be disabled for a cheaper preview.
            decoder_space_upscale: whether spatial upsampling is enabled for each block. upsampling can be disabled for a cheaper preview.
        """
        super().__init__()
        self.encoder = nn.Sequential(
            conv(TAEHV.image_channels, 64), nn.ReLU(inplace=True),
            TPool(64, 2), conv(64, 64, stride=2, bias=False), MemBlock(64, 64), MemBlock(64, 64), MemBlock(64, 64),
            TPool(64, 2), conv(64, 64, stride=2, bias=False), MemBlock(64, 64), MemBlock(64, 64), MemBlock(64, 64),
            TPool(64, 1), conv(64, 64, stride=2, bias=False), MemBlock(64, 64), MemBlock(64, 64), MemBlock(64, 64),
            conv(64, TAEHV.latent_channels),
        )
        n_f = [256, 128, 64, 64]
        self.frames_to_trim = 2**sum(decoder_time_upscale) - 1
        self.decoder = nn.Sequential(
            Clamp(), conv(TAEHV.latent_channels, n_f[0]), nn.ReLU(inplace=True),
            MemBlock(n_f[0], n_f[0]), MemBlock(n_f[0], n_f[0]), MemBlock(n_f[0], n_f[0]), nn.Upsample(scale_factor=2 if decoder_space_upscale[0] else 1), TGrow(n_f[0], 1), conv(n_f[0], n_f[1], bias=False),
            MemBlock(n_f[1], n_f[1]), MemBlock(n_f[1], n_f[1]), MemBlock(n_f[1], n_f[1]), nn.Upsample(scale_factor=2 if decoder_space_upscale[1] else 1), TGrow(n_f[1], 2 if decoder_time_upscale[0] else 1), conv(n_f[1], n_f[2], bias=False),
            MemBlock(n_f[2], n_f[2]), MemBlock(n_f[2], n_f[2]), MemBlock(n_f[2], n_f[2]), nn.Upsample(scale_factor=2 if decoder_space_upscale[2] else 1), TGrow(n_f[2], 2 if decoder_time_upscale[1] else 1), conv(n_f[2], n_f[3], bias=False),
            nn.ReLU(inplace=True), conv(n_f[3], TAEHV.image_channels),
        )
        if state_dict is not None:
            self.load_state_dict(self.patch_tgrow_layers(state_dict))
        self.dtype = torch.float16
        self.parallel = parallel

    def patch_tgrow_layers(self, sd):
        """Patch TGrow layers to use a smaller kernel if needed.

        Args:
            sd: state dict to patch
        """
        new_sd = self.state_dict()
        for i, layer in enumerate(self.decoder):
            if isinstance(layer, TGrow):
                key = f"decoder.{i}.conv.weight"
                if sd[key].shape[0] > new_sd[key].shape[0]:
                    # take the last-timestep output channels
                    sd[key] = sd[key][-new_sd[key].shape[0]:]
        return sd

    def encode_video(self, x, parallel=False, show_progress_bar=True):
        """Encode a sequence of frames.

        Args:
            x: input NTCHW RGB (C=3) tensor with values in [0, 1].
            parallel: if True, all frames will be processed at once.
              (this is faster but may require more memory).
              if False, frames will be processed sequentially.
        Returns NTCHW latent tensor with ~Gaussian values.
        """
        return apply_model_with_memblocks(self.encoder, x, self.parallel, show_progress_bar)

    def decode_video(self, x, parallel=False, show_progress_bar=True):
        """Decode a sequence of frames.

        Args:
            x: input NTCHW latent (C=12) tensor with ~Gaussian values.
            parallel: if True, all frames will be processed at once.
              (this is faster but may require more memory).
              if False, frames will be processed sequentially.
        Returns NTCHW RGB tensor with ~[0, 1] values.
        """
        x = apply_model_with_memblocks(self.decoder, x, self.parallel, show_progress_bar)
        return x[:, self.frames_to_trim:]

    def forward(self, x):
        return self.c(x)

class WanVideoEmptyEmbeds_v2:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {
            "width": ("INT", {"default": 832, "min": 64, "max": 8096, "step": 8, "tooltip": "Width of the image to encode"}),
            "height": ("INT", {"default": 480, "min": 64, "max": 8096, "step": 8, "tooltip": "Height of the image to encode"}),
            "num_frames": ("INT", {"default": 81, "min": 1, "max": 10000, "step": 4, "tooltip": "Number of frames to encode"}),
            },
            "optional": {
                "control_embeds": ("WANVIDIMAGE_EMBEDS", {"tooltip": "control signal for the Fun -model"}),
                "extra_latents": ("LATENT", {"tooltip": "First latent to use for the Pusa -model"}),
            }
        }

    RETURN_TYPES = ("WANVIDIMAGE_EMBEDS", )
    RETURN_NAMES = ("image_embeds",)
    FUNCTION = "process"
    CATEGORY = "WanVideoWrapper_QQ/utils"

    def process(self, num_frames, width, height, control_embeds=None, extra_latents=None):
        target_shape = (16, (num_frames - 1) // VAE_STRIDE[0] + 1,
                        height // VAE_STRIDE[1],
                        width // VAE_STRIDE[2])

        embeds = {
            "target_shape": target_shape,
            "num_frames": num_frames,
            "lat_h": height // VAE_STRIDE[1],
            "lat_w": width // VAE_STRIDE[2],
            "control_embeds": control_embeds["control_embeds"] if control_embeds is not None else None,
            "has_ref": extra_latents is not None,
        }

        if extra_latents is not None:
            embeds["extra_latents"] = extra_latents["samples"]

        return (embeds,)

class WanVideoImageToVideoEncode_v2:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {
            "width": ("INT", {"default": 832, "min": 64, "max": 8096, "step": 8, "tooltip": "Width of the image to encode"}),
            "height": ("INT", {"default": 480, "min": 64, "max": 8096, "step": 8, "tooltip": "Height of the image to encode"}),
            "num_frames": ("INT", {"default": 81, "min": 1, "max": 10000, "step": 4, "tooltip": "Number of frames to encode"}),
            "noise_aug_strength": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 10.0, "step": 0.001, "tooltip": "Strength of noise augmentation, helpful for I2V where some noise can add motion and give sharper results"}),
            "start_latent_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.001, "tooltip": "Additional latent multiplier, helpful for I2V where lower values allow for more motion"}),
            "mid_latent_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.001, "tooltip": "Additional latent multiplier for mid frame, helpful for I2V where lower values allow for more motion"}),
            "end_latent_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.001, "tooltip": "Additional latent multiplier, helpful for I2V where lower values allow for more motion"}),
            "end_final_strength": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 10.0, "step": 0.001, "tooltip": "Strength for end_image copy placed at final frame for temporal consistency"}),
            "mid_position": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Position of mid_image as fraction of total frames (0.0 = start, 1.0 = end)"}),
            "end_position": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Position of end_image relative to remaining timeline after mid_image"}),
            "force_offload": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "vae": ("WANVAE",),
                "clip_embeds": ("WANVIDIMAGE_CLIPEMBEDS", {"tooltip": "Clip vision encoded image"}),
                "start_image": ("IMAGE", {"tooltip": "Image to encode"}),
                "mid_image": ("IMAGE", {"tooltip": "middle frame"}),
                "end_image": ("IMAGE", {"tooltip": "end frame"}),
                "control_embeds": ("WANVIDIMAGE_EMBEDS", {"tooltip": "Control signal for the Fun -model"}),
                "fun_or_fl2v_model": ("BOOLEAN", {"default": True, "tooltip": "Enable when using official FLF2V or Fun model"}),
                "temporal_mask": ("MASK", {"tooltip": "mask"}),
                "extra_latents": ("LATENT", {"tooltip": "Extra latents to add to the input front, used for Skyreels A2 reference images"}),
                "tiled_vae": ("BOOLEAN", {"default": False, "tooltip": "Use tiled VAE encoding for reduced memory use"}),
                "add_cond_latents": ("ADD_COND_LATENTS", {"advanced": True, "tooltip": "Additional cond latents WIP"}),
            }
        }

    RETURN_TYPES = ("WANVIDIMAGE_EMBEDS",)
    RETURN_NAMES = ("image_embeds",)
    FUNCTION = "process"
    CATEGORY = "WanVideoWrapper_QQ/utils"

    def _cosine_feather_weight(self, distance, feather_radius):
        """Calculate smooth feathering weight using cosine interpolation."""
        if feather_radius <= 0:
            return 1.0 if distance == 0 else 0.0

        if abs(distance) >= feather_radius:
            return 0.0

        # Cosine interpolation for smooth falloff
        normalized_dist = abs(distance) / feather_radius
        return 0.5 * (1.0 + torch.cos(torch.tensor(normalized_dist * 3.14159)))

    def _apply_temporal_feathering(self, tensor, position, feather_radius=2):
        """Apply temporal feathering around a specific position."""
        if feather_radius <= 0 or position >= tensor.shape[1]:
            return tensor

        feathered = tensor.clone()
        for i in range(max(0, position - feather_radius), min(tensor.shape[1], position + feather_radius + 1)):
            if i != position:
                distance = i - position
                weight = self._cosine_feather_weight(distance, feather_radius)
                # Blend current frame with neighboring frames
                if 0 <= i < tensor.shape[1]:
                    neighbor_weight = 1.0 - weight
                    feathered[:, i] = weight * tensor[:, position] + neighbor_weight * tensor[:, i]

        return feathered

    def process(self, width, height, num_frames, force_offload, noise_aug_strength,
                start_latent_strength, mid_latent_strength, end_latent_strength, end_final_strength, mid_position, end_position, start_image=None, mid_image=None, end_image=None, control_embeds=None, fun_or_fl2v_model=False,
                temporal_mask=None, extra_latents=None, clip_embeds=None, tiled_vae=False, add_cond_latents=None, vae=None):

        if start_image is None and mid_image is None and end_image is None and add_cond_latents is None:
            return WanVideoEmptyEmbeds_v2().process(
                num_frames, width, height, control_embeds=control_embeds, extra_latents=extra_latents,
            )
        if vae is None:
            raise ValueError("VAE is required for image encoding.")
        H = height
        W = width

        lat_h = H // vae.upsampling_factor
        lat_w = W // vae.upsampling_factor

        num_frames = ((num_frames - 1) // 4) * 4 + 1
        two_ref_images = start_image is not None and end_image is not None
        has_mid_image = mid_image is not None

        # Calculate mid position for mid_image placement using float parameter
        if has_mid_image:
            # Calculate position as fraction of total frames
            raw_pos = int(num_frames * mid_position)
            # Round to steps of 4 and add 1 for i2v requirements
            mid_position_frame = ((raw_pos // 4) * 4) + 1
            # Ensure it's within valid bounds (at least 1 frame from start/end)
            mid_position_frame = max(1, min(mid_position_frame, num_frames - 2))
        else:
            mid_position_frame = None

        # Calculate end position for end_image placement using float parameter
        has_end_image = end_image is not None
        if has_end_image:
            if has_mid_image and mid_position_frame is not None:
                # Position between mid_image and end of video
                available_range = 1.0 - mid_position
                end_pos = mid_position + (end_position * available_range)
            else:
                # Position relative to entire video
                end_pos = end_position

            # Convert to frame number with step-of-4 + 1
            raw_end_pos = int(num_frames * end_pos)
            end_position_frame = ((raw_end_pos // 4) * 4) + 1
            # Ensure bounds and after mid_image if exists
            min_end = mid_position_frame + 2 if mid_position_frame else 2
            end_position_frame = max(min_end, min(end_position_frame, num_frames - 1))
        else:
            end_position_frame = None

        if start_image is None and end_image is not None:
            fun_or_fl2v_model = True # end image alone only works with this option

        # Adjust base_frames calculation to account for mid_image
        extra_frames = 0
        if two_ref_images and not fun_or_fl2v_model:
            extra_frames += 1
        if has_mid_image and not fun_or_fl2v_model:
            extra_frames += 1
        base_frames = num_frames + extra_frames

        if temporal_mask is None:
            mask = torch.zeros(1, base_frames, lat_h, lat_w, device=device, dtype=vae.dtype)
            if start_image is not None:
                mask[:, 0:start_image.shape[0]] = 1  # First frame
            if mid_image is not None:
                mask[:, mid_position_frame:mid_position_frame+mid_image.shape[0]] = 1  # Middle frame
            if end_image is not None:
                mask[:, end_position_frame:end_position_frame+end_image.shape[0]] = 1  # End frame at custom position
                # If dual end frame (end_position < 1.0), final frame will also have end_image (handled in post-processing)
                if end_position < 1.0:
                    mask[:, -1:] = 1  # Final frame will also have end_image content
        else:
            mask = common_upscale(temporal_mask.unsqueeze(1).to(device), lat_w, lat_h, "nearest", "disabled").squeeze(1)
            if mask.shape[0] > base_frames:
                mask = mask[:base_frames]
            elif mask.shape[0] < base_frames:
                mask = torch.cat([mask, torch.zeros(base_frames - mask.shape[0], lat_h, lat_w, device=device)])
            mask = mask.unsqueeze(0).to(device, vae.dtype)

        # Repeat frames - start, mid, and optionally end frame
        start_mask_repeated = torch.repeat_interleave(mask[:, 0:1], repeats=4, dim=1) # T, C, H, W

        # Handle different combinations of reference frames
        if has_mid_image and not fun_or_fl2v_model:
            mid_mask_repeated = torch.repeat_interleave(mask[:, mid_position_frame:mid_position_frame+1], repeats=4, dim=1)
            if end_image is not None and not fun_or_fl2v_model:
                end_mask_repeated = torch.repeat_interleave(mask[:, end_position_frame:end_position_frame+1], repeats=4, dim=1)
                # start + mid + end: combine all three with proper indexing
                # Simplified mask combination - handle dual end frame through post-processing
                if end_position_frame > mid_position_frame:
                    mask = torch.cat([start_mask_repeated, mask[:, 1:mid_position_frame], mid_mask_repeated, mask[:, mid_position_frame+1:end_position_frame], end_mask_repeated, mask[:, end_position_frame+1:]], dim=1)
                else:
                    # Handle edge case where end comes before mid (shouldn't happen with proper bounds)
                    mask = torch.cat([start_mask_repeated, mask[:, 1:end_position_frame], end_mask_repeated, mask[:, end_position_frame+1:mid_position_frame], mid_mask_repeated, mask[:, mid_position_frame+1:]], dim=1)
            else:
                # start + mid only
                mask = torch.cat([start_mask_repeated, mask[:, 1:mid_position_frame], mid_mask_repeated, mask[:, mid_position_frame+1:]], dim=1)
        elif end_image is not None and not fun_or_fl2v_model:
            # start + end
            end_mask_repeated = torch.repeat_interleave(mask[:, end_position_frame:end_position_frame+1], repeats=4, dim=1)
            # Simplified mask combination - handle dual end frame through post-processing
            mask = torch.cat([start_mask_repeated, mask[:, 1:end_position_frame], end_mask_repeated, mask[:, end_position_frame+1:]], dim=1)
        else:
            # start only or fun_or_fl2v_model mode
            mask = torch.cat([start_mask_repeated, mask[:, 1:]], dim=1)

        # Ensure mask has proper divisibility by 4 for video processing
        current_frames = mask.shape[1]
        if current_frames % 4 != 0:
            # Pad mask to make it divisible by 4
            padding_needed = 4 - (current_frames % 4)
            padding = torch.zeros(1, padding_needed, lat_h, lat_w, device=device, dtype=mask.dtype)
            mask = torch.cat([mask, padding], dim=1)

        # Reshape mask into groups of 4 frames
        mask = mask.view(1, mask.shape[1] // 4, 4, lat_h, lat_w) # 1, T, C, H, W
        mask = mask.movedim(1, 2)[0]# C, T, H, W

        # Resize and rearrange the input image dimensions
        resized_mid_image = None
        resized_end_image = None
        # Store copies for output embedding
        output_mid_image = None
        output_end_image = None
        if start_image is not None:
            start_image = start_image[..., :3]
            if start_image.shape[1] != H or start_image.shape[2] != W:
                resized_start_image = common_upscale(start_image.movedim(-1, 1), W, H, "lanczos", "disabled").movedim(0, 1)
            else:
                resized_start_image = start_image.permute(3, 0, 1, 2) # C, T, H, W
            resized_start_image = resized_start_image * 2 - 1
            if noise_aug_strength > 0.0:
                resized_start_image = add_noise_to_reference_video(resized_start_image, ratio=noise_aug_strength)

        if end_image is not None:
            end_image = end_image[..., :3]
            if end_image.shape[1] != H or end_image.shape[2] != W:
                resized_end_image = common_upscale(end_image.movedim(-1, 1), W, H, "lanczos", "disabled").movedim(0, 1)
            else:
                resized_end_image = end_image.permute(3, 0, 1, 2) # C, T, H, W
            resized_end_image = resized_end_image * 2 - 1
            if noise_aug_strength > 0.0:
                resized_end_image = add_noise_to_reference_video(resized_end_image, ratio=noise_aug_strength)
            # Store copy for output embedding
            output_end_image = resized_end_image.clone()

        if mid_image is not None:
            mid_image = mid_image[..., :3]
            if mid_image.shape[1] != H or mid_image.shape[2] != W:
                resized_mid_image = common_upscale(mid_image.movedim(-1, 1), W, H, "lanczos", "disabled").movedim(0, 1)
            else:
                resized_mid_image = mid_image.permute(3, 0, 1, 2) # C, T, H, W
            resized_mid_image = resized_mid_image * 2 - 1
            if noise_aug_strength > 0.0:
                resized_mid_image = add_noise_to_reference_video(resized_mid_image, ratio=noise_aug_strength)
            # Store copy for output embedding
            output_mid_image = resized_mid_image.clone()

        # Concatenate image with zero frames and encode
        if temporal_mask is None:
                # Create concatenated frames normally, then post-process for dual end frame if needed

            # Handle all combinations of start/mid/end images
            if start_image is not None and mid_image is not None and end_image is not None:
                # All three images: start + mid + end (at custom positions) - simplified
                zero_frames_1 = torch.zeros(3, mid_position_frame-start_image.shape[0], H, W, device=device, dtype=vae.dtype)
                zero_frames_2 = torch.zeros(3, end_position_frame-mid_position_frame-mid_image.shape[0], H, W, device=device, dtype=vae.dtype)
                zero_frames_3 = torch.zeros(3, num_frames-end_position_frame-end_image.shape[0], H, W, device=device, dtype=vae.dtype)
                concatenated = torch.cat([
                    resized_start_image.to(device, dtype=vae.dtype),
                    zero_frames_1,
                    resized_mid_image.to(device, dtype=vae.dtype),
                    zero_frames_2,
                    resized_end_image.to(device, dtype=vae.dtype),
                    zero_frames_3
                ], dim=1)
                del zero_frames_1, zero_frames_2, zero_frames_3
                del resized_start_image, resized_mid_image
            elif start_image is not None and mid_image is not None:
                # Start + mid only
                zero_frames_1 = torch.zeros(3, mid_position_frame-start_image.shape[0], H, W, device=device, dtype=vae.dtype)
                zero_frames_2 = torch.zeros(3, num_frames-mid_position_frame-mid_image.shape[0], H, W, device=device, dtype=vae.dtype)
                concatenated = torch.cat([
                    resized_start_image.to(device, dtype=vae.dtype),
                    zero_frames_1,
                    resized_mid_image.to(device, dtype=vae.dtype),
                    zero_frames_2
                ], dim=1)
                del resized_start_image, resized_mid_image, zero_frames_1, zero_frames_2
            elif start_image is not None and end_image is not None:
                # Start + end (at custom end position) - simplified
                zero_frames_1 = torch.zeros(3, end_position_frame-start_image.shape[0], H, W, device=device, dtype=vae.dtype)
                zero_frames_2 = torch.zeros(3, num_frames-end_position_frame-end_image.shape[0], H, W, device=device, dtype=vae.dtype)
                concatenated = torch.cat([
                    resized_start_image.to(device, dtype=vae.dtype),
                    zero_frames_1,
                    resized_end_image.to(device, dtype=vae.dtype),
                    zero_frames_2
                ], dim=1)
                del resized_start_image, zero_frames_1, zero_frames_2
            elif mid_image is not None and end_image is not None:
                # Mid + end (at custom positions) - simplified
                zero_frames_1 = torch.zeros(3, mid_position_frame, H, W, device=device, dtype=vae.dtype)
                zero_frames_2 = torch.zeros(3, end_position_frame-mid_position_frame-mid_image.shape[0], H, W, device=device, dtype=vae.dtype)
                zero_frames_3 = torch.zeros(3, num_frames-end_position_frame-end_image.shape[0], H, W, device=device, dtype=vae.dtype)
                concatenated = torch.cat([
                    zero_frames_1,
                    resized_mid_image.to(device, dtype=vae.dtype),
                    zero_frames_2,
                    resized_end_image.to(device, dtype=vae.dtype),
                    zero_frames_3
                ], dim=1)
                del resized_mid_image, zero_frames_1, zero_frames_2, zero_frames_3
            elif start_image is not None:
                # Start only (original behavior)
                zero_frames = torch.zeros(3, num_frames-start_image.shape[0], H, W, device=device, dtype=vae.dtype)
                concatenated = torch.cat([resized_start_image.to(device, dtype=vae.dtype), zero_frames], dim=1)
                del resized_start_image, zero_frames
            elif mid_image is not None:
                # Mid only
                zero_frames_1 = torch.zeros(3, mid_position_frame, H, W, device=device, dtype=vae.dtype)
                zero_frames_2 = torch.zeros(3, num_frames-mid_position_frame-mid_image.shape[0], H, W, device=device, dtype=vae.dtype)
                concatenated = torch.cat([zero_frames_1, resized_mid_image.to(device, dtype=vae.dtype), zero_frames_2], dim=1)
                del resized_mid_image, zero_frames_1, zero_frames_2
            elif end_image is not None:
                # End only (at custom position) - simplified
                zero_frames_1 = torch.zeros(3, end_position_frame, H, W, device=device, dtype=vae.dtype)
                zero_frames_2 = torch.zeros(3, num_frames-end_position_frame-end_image.shape[0], H, W, device=device, dtype=vae.dtype)
                concatenated = torch.cat([
                    zero_frames_1,
                    resized_end_image.to(device, dtype=vae.dtype),
                    zero_frames_2
                ], dim=1)
                del zero_frames_1, zero_frames_2
            else:
                # No images
                concatenated = torch.zeros(3, num_frames, H, W, device=device, dtype=vae.dtype)
        else:
            temporal_mask = common_upscale(temporal_mask.unsqueeze(1), W, H, "nearest", "disabled").squeeze(1)
            concatenated = resized_start_image[:,:num_frames].to(vae.dtype) * temporal_mask[:num_frames].unsqueeze(0).to(vae.dtype)
            del resized_start_image, temporal_mask

        # Apply temporal feathering around reference frame positions to smooth transitions
        if temporal_mask is None:
            feather_radius_pixel = 1  # Small radius for pixel space feathering

            # Apply feathering around mid_image position if present
            if mid_image is not None and mid_position_frame > 0:
                # Create a gradient that smoothly blends the mid frame with surrounding zero frames
                for i in range(max(0, mid_position_frame - feather_radius_pixel),
                              min(concatenated.shape[1], mid_position_frame + feather_radius_pixel + 1)):
                    if i != mid_position_frame:
                        distance = abs(i - mid_position_frame)
                        feather_weight = self._cosine_feather_weight(distance, feather_radius_pixel) * 0.3  # Gentle feathering
                        if feather_weight > 0 and i < concatenated.shape[1] and mid_position_frame < concatenated.shape[1]:
                            # Blend with mid frame content
                            concatenated[:, i:i+1] = (1.0 - feather_weight) * concatenated[:, i:i+1] + feather_weight * concatenated[:, mid_position_frame:mid_position_frame+1]

            # Apply feathering around end_image position if present
            if end_image is not None and end_position_frame > 0 and end_position_frame < concatenated.shape[1]:
                for i in range(max(0, end_position_frame - feather_radius_pixel),
                              min(concatenated.shape[1], end_position_frame + feather_radius_pixel + 1)):
                    if i != end_position_frame:
                        distance = abs(i - end_position_frame)
                        feather_weight = self._cosine_feather_weight(distance, feather_radius_pixel) * 0.3  # Gentle feathering
                        if feather_weight > 0 and i < concatenated.shape[1]:
                            # Blend with end frame content
                            concatenated[:, i:i+1] = (1.0 - feather_weight) * concatenated[:, i:i+1] + feather_weight * concatenated[:, end_position_frame:end_position_frame+1]

        # Handle dual end frame: smooth blending for final frame if end_position < 1.0
        if end_image is not None and end_position < 1.0 and temporal_mask is None:
            # Apply smooth blending instead of abrupt overwrite
            final_frame_idx = num_frames - 1
            if final_frame_idx < concatenated.shape[1]:
                # Use end_final_strength for blending weight
                blend_weight = end_final_strength
                original_final_frame = concatenated[:, final_frame_idx:final_frame_idx+1]
                end_frame_content = resized_end_image.to(device, dtype=concatenated.dtype)

                # Smooth blend: (1-weight) * original + weight * end_image
                blended_frame = (1.0 - blend_weight) * original_final_frame + blend_weight * end_frame_content
                concatenated[:, final_frame_idx:final_frame_idx+1] = blended_frame

                # Apply temporal feathering around the final frame for smoother transitions
                feather_radius = 2  # Feather 2 frames on each side
                if final_frame_idx >= feather_radius:
                    start_feather = final_frame_idx - feather_radius
                    end_feather = min(concatenated.shape[1], final_frame_idx + feather_radius + 1)

                    for i in range(start_feather, end_feather):
                        if i != final_frame_idx:
                            distance = abs(i - final_frame_idx)
                            feather_weight = self._cosine_feather_weight(distance, feather_radius)
                            if feather_weight > 0:
                                # Blend surrounding frames with reduced end_image influence
                                reduced_end_influence = blend_weight * feather_weight * 0.5  # Reduce influence for surrounding frames
                                concatenated[:, i:i+1] = (1.0 - reduced_end_influence) * concatenated[:, i:i+1] + reduced_end_influence * end_frame_content

        # Ensure concatenated frames are divisible by 4 for video processing
        concat_frames = concatenated.shape[1]
        if concat_frames % 4 != 0:
            # Pad concatenated frames to make it divisible by 4
            padding_needed = 4 - (concat_frames % 4)
            padding = torch.zeros(3, padding_needed, H, W, device=device, dtype=concatenated.dtype)
            concatenated = torch.cat([concatenated, padding], dim=1)

        mm.soft_empty_cache()
        gc.collect()

        vae.to(device)
        # Update VAE encoding to account for additional reference frames
        # Always use end_=True when end_image exists since we always place it at final position
        has_extra_ref_frames = (end_image is not None and not fun_or_fl2v_model) or (mid_image is not None and not fun_or_fl2v_model)
        y = vae.encode([concatenated], device, end_=has_extra_ref_frames, tiled=tiled_vae)[0]
        vae.model.clear_cache()
        del concatenated

        has_ref = False
        if extra_latents is not None:
            samples = extra_latents["samples"].squeeze(0)
            y = torch.cat([samples, y], dim=1)
            mask = torch.cat([torch.ones_like(mask[:, 0:samples.shape[1]]), mask], dim=1)
            num_frames += samples.shape[1] * 4
            has_ref = True
        # Apply smoothed latent strengths with temporal feathering
        feather_radius_latent = 1  # Smaller radius for latent space (since it's 4x compressed)

        # Apply start_latent_strength with feathering
        y[:, :1] *= start_latent_strength
        if y.shape[1] > 1 and feather_radius_latent > 0:
            for i in range(1, min(feather_radius_latent + 1, y.shape[1])):
                feather_weight = self._cosine_feather_weight(i, feather_radius_latent)
                smooth_strength = 1.0 + feather_weight * (start_latent_strength - 1.0)
                y[:, i:i+1] *= smooth_strength

        # Apply end_latent_strength to end frame if present at calculated position
        if end_image is not None:
            # Calculate end latent position - need to account for VAE compression (4x temporal)
            end_latent_pos = end_position_frame // 4
            if end_latent_pos < y.shape[1]:
                # Apply strength with feathering
                y[:, end_latent_pos:end_latent_pos+1] *= end_latent_strength

                # Apply feathering around end position
                for i in range(max(0, end_latent_pos - feather_radius_latent),
                              min(y.shape[1], end_latent_pos + feather_radius_latent + 1)):
                    if i != end_latent_pos:
                        distance = abs(i - end_latent_pos)
                        feather_weight = self._cosine_feather_weight(distance, feather_radius_latent)
                        smooth_strength = 1.0 + feather_weight * (end_latent_strength - 1.0)
                        y[:, i:i+1] *= smooth_strength

            # Apply end_final_strength to final frame if dual end frame case
            if end_position < 1.0:
                # Final frame gets smoothed end_final_strength
                final_latent_pos = y.shape[1] - 1
                y[:, -1:] *= end_final_strength

                # Apply feathering before final frame
                for i in range(max(0, final_latent_pos - feather_radius_latent), final_latent_pos):
                    distance = final_latent_pos - i
                    feather_weight = self._cosine_feather_weight(distance, feather_radius_latent)
                    smooth_strength = 1.0 + feather_weight * (end_final_strength - 1.0)
                    y[:, i:i+1] *= smooth_strength
        else:
            # If no end_image, apply to last frame as before with feathering
            y[:, -1:] *= end_latent_strength
            if y.shape[1] > 1 and feather_radius_latent > 0:
                for i in range(max(0, y.shape[1] - feather_radius_latent - 1), y.shape[1] - 1):
                    distance = (y.shape[1] - 1) - i
                    feather_weight = self._cosine_feather_weight(distance, feather_radius_latent)
                    smooth_strength = 1.0 + feather_weight * (end_latent_strength - 1.0)
                    y[:, i:i+1] *= smooth_strength

        # Apply mid_latent_strength to mid frame if present
        if mid_image is not None:
            # Calculate mid latent position - need to account for VAE compression (4x temporal)
            mid_latent_pos = mid_position_frame // 4
            if mid_latent_pos < y.shape[1]:
                # Apply strength with feathering
                y[:, mid_latent_pos:mid_latent_pos+1] *= mid_latent_strength

                # Apply feathering around mid position
                for i in range(max(0, mid_latent_pos - feather_radius_latent),
                              min(y.shape[1], mid_latent_pos + feather_radius_latent + 1)):
                    if i != mid_latent_pos:
                        distance = abs(i - mid_latent_pos)
                        feather_weight = self._cosine_feather_weight(distance, feather_radius_latent)
                        smooth_strength = 1.0 + feather_weight * (mid_latent_strength - 1.0)
                        y[:, i:i+1] *= smooth_strength

        # Calculate maximum sequence length
        patches_per_frame = lat_h * lat_w // (PATCH_SIZE[1] * PATCH_SIZE[2])

        # Count additional frames for sequence calculation
        # Note: We don't count padding frames here - only actual reference frames
        additional_frames = 1  # Base frame
        if end_image is not None and not fun_or_fl2v_model:
            additional_frames += 1
            # Don't add extra frame for dual end frame case in sequence calculation
            # The padding is handled separately and shouldn't affect sequence length
        if mid_image is not None and not fun_or_fl2v_model:
            additional_frames += 1

        frames_per_stride = (num_frames - 1) // 4 + additional_frames
        max_seq_len = frames_per_stride * patches_per_frame

        if add_cond_latents is not None:
            add_cond_latents["ref_latent_neg"] = vae.encode(torch.zeros(1, 3, 1, H, W, device=device, dtype=vae.dtype), device)

        if force_offload:
            vae.model.to(offload_device)
            mm.soft_empty_cache()
            gc.collect()

        image_embeds = {
            "image_embeds": y,
            "clip_context": clip_embeds.get("clip_embeds", None) if clip_embeds is not None else None,
            "negative_clip_context": clip_embeds.get("negative_clip_embeds", None) if clip_embeds is not None else None,
            "max_seq_len": max_seq_len,
            "num_frames": num_frames,
            "lat_h": lat_h,
            "lat_w": lat_w,
            "control_embeds": control_embeds["control_embeds"] if control_embeds is not None else None,
            "end_image": output_end_image,
            "mid_image": output_mid_image,
            "fun_or_fl2v_model": fun_or_fl2v_model,
            "has_ref": has_ref,
            "add_cond_latents": add_cond_latents,
            "mask": mask
        }

        return (image_embeds,)

# Node class mappings
NODE_CLASS_MAPPINGS = {
    "WanVideoImageToVideoEncode_v2": WanVideoImageToVideoEncode_v2,
    "WanVideoEmptyEmbeds_v2": WanVideoEmptyEmbeds_v2,
}

# Node display name mappings
NODE_DISPLAY_NAME_MAPPINGS = {
    "WanVideoImageToVideoEncode_v2": "WanVideo ImageToVideo Encode v2",
    "WanVideoEmptyEmbeds_v2": "WanVideo Empty Embeds v2",
}