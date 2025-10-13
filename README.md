# ComfyUI-WanVideoWrapper_QQ

A collection of custom nodes for ComfyUI providing video manipulation, LoRA loading, path animation, and visual drawing tools for WanVideo workflows.

<table>
<tr>
<td width="50%">

https://github.com/user-attachments/assets/16f0da4c-38f1-4789-97dc-c331ad8a6d92
</td>
<td width="50%">

https://github.com/user-attachments/assets/5689c666-924a-4362-9788-d8f662c0d925
</td>
</tr>
</table>

### Power Spline Editor
<table>
<tr>
<td width="50%">

![img](git_assets/img/spline.png)

</td>
<td width="50%" valign="top">

[Power Spline Editor - usage](git_assets/docs/power_spline_editor.md)
- **Multi-layer canvas**: Draw unlimited paths with per-layer controls
- **Interpolation modes**: `linear`, `cardinal` (Catmull-Rom), `basis` (B-spline), `points` (static)
- **Repeat system**: Loop animations with automatic closed-path handling
- **Driver/driven**: One path controls another with rotation, scaling, and smoothing
- **Easing functions**: Smooth transitions with various easing curves for path animation
- **Right-click controls**: Context menu for driver path with additional options
- **Offset timing**: Positive/negative timing shifts with pause frame control
- **Pause frames**: Start/end pause per layer for precise animation timing
</td>
</tr>
</table>

### Power Lora Loader
<table>
<tr>
<td width="50%">

![img](git_assets/img/lora.png)

</td>
<td width="50%" valign="top">

- **LoRAs**: Dynamic UI with rgthree-style interface
- **Auto-detection**: Finds Low variant pairs from High LoRAs automatically
- **Smart patterns**: `-`, `_`, ` ` separators at prefix/suffix/infix positions
- **Case variations**: `High`/`high`/`HIGH`/`H`/`h` → `Low`/`low`/`LOW`/`L`/`l`
- **Dual strength**: Separate High (H) and Low (L) sliders with copy buttons
- **Block selection**: Per-LoRA layer control with merge and memory options
</td>
</tr>
</table>

### Wan Video VACE Frame Replace
<table>
<tr>
<td width="50%">

![img](git_assets/img/vace.png)

</td>
<td width="50%" valign="top">

[Wan Video VACE Frame Replace - example](git_assets/examples/frame_replace.json)
- **Single frames**: `5` (gray), `5+` (replacement image)
- **Ranges**: `22-26` (gray), `*1-5` (keep start), `1-5*` (keep end)
- **a-b-c patterns**: Middle frame `b` with `a` left/`c` right context
- **Multiple +**: `++a-b-c++` creates gradual duplicates on both sides
- **Custom opacity**: `++a-b-c++ 0.8` for blend strength control
- **Custom masks**: Auto-scaled replacement masks with opacity blending
</td>
</tr>
</table>

### Wan Video Cache Samples
<table>
<tr>
<td width="35%">

![img](git_assets/img/cache.png)

</td>
<td width="65%" valign="top">

- **Cache/Load workflow**: Save latent samples to disk for faster workflow iteration
- **Dual mode**: With input → cache and passthrough; Without input → load from cache
- **Auto-path handling**: Saves to node directory with customizable cache names
- **Workflow speedup**: Skip HIGH sampling steps during prompt/parameter testing to resample LOW
</td>
</tr>
</table>

### Wan Video Image To Video Encode_v2
<table>
<tr>
<td width="35%">

![img](git_assets/img/encode.png)

</td>
<td width="65%" valign="top">

- (EXPERIMENTAL) Maybe there's native ways to do this , but it seems to work
- **Multi-frame I2V**: Start/mid/end image conditioning with position control
- **Temporal feathering**: Cosine interpolation for smooth frame transitions
- **Latent strength**: Per-frame multipliers (start/mid/end) for motion control (default setting work but can be adjusted)
</td>
</tr>
</table>

### Other Experimental Node List
![Node List](git_assets/img/list.png)


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

## Requirements

- ComfyUI (latest version recommended)
- PyTorch with CUDA support (for GPU acceleration)
- Standard ComfyUI dependencies

## Credits

Experimental node package for WanVideo workflows in ComfyUI.

**Special Thanks**
- **KJ** - [ComfyUI-WanVideoWrapper](https://github.com/kijai/ComfyUI-WanVideoWrapper)
- **rgthree** - [rgthree-comfy](https://github.com/rgthree/rgthree-comfy)

