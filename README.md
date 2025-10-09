# ComfyUI-WanVideoWrapper_QQ

A collection of custom nodes for ComfyUI providing video manipulation, LoRA loading, path animation, and visual drawing tools for WanVideo workflows.

### Available Nodes
![Node List](git_assets/img/list.png)

### Spline Editor & Other nodes
![Spline Editor](git_assets/img/spline.png)

## Features

- **Power LoRA Loader**: Advanced LoRA loading with High/Low pair detection, block selection, and custom UI
- **Power Spline Editors**: Multi-layer canvas-based path drawing with interpolation modes (linear, cardinal, basis, points)
- **Video Manipulation**: Speed adjustment, frame extraction, video merging, and frame replacement
- **Path Animation**: Draw shapes (circle/square/triangle) along animated paths with easing functions
- **Image-to-Video Encoding**: TAEHV (Tiny AutoEncoder for Hunyuan Video) with temporal feathering and memory-efficient modes
- **Cache Management**: Sample caching for faster workflow iteration
- **VAE Frame Replacement**: Replace specific frames in VAE-encoded video latents

## Installation

1. Navigate to your ComfyUI custom nodes directory:
```bash
cd ComfyUI/custom_nodes/
```

2. Clone this repository:
```bash
git clone https://github.com/siraxe/ComfyUI-WanVideoWrapper_QQ.git
```

3. Restart ComfyUI

## Node Categories

All nodes are organized under the **WanVideoWrapper_QQ** category with the following types:

- **Video Processing**: Frame manipulation, speed control, merging, and extraction
- **LoRA Tools**: Power LoRA Loader with advanced configuration options
- **Path Animation**: Spline editors and shape drawing on paths
- **Encoding**: Image-to-video encoding with temporal conditioning
- **Utilities**: Cache management, frame configuration, and VAE utilities

## Requirements

- ComfyUI (latest version recommended)
- PyTorch with CUDA support (for GPU acceleration)
- Standard ComfyUI dependencies

## Credits

Experimental node package for WanVideo workflows in ComfyUI.

**Special Thanks**
- **KJ** - [ComfyUI-WanVideoWrapper](https://github.com/kijai/ComfyUI-WanVideoWrapper)
- **rgthree** - [rgthree-comfy](https://github.com/rgthree/rgthree-comfy)

