# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

ComfyUI-WanVideoWrapper_QQ is a custom node collection for ComfyUI that provides utilities and nodes for WanVideo video generation workflows. It includes video manipulation, LoRA loading, path animation, image encoding, and visual drawing tools.

## Architecture

### Node Registration System

The node system uses **dynamic class discovery** via `__init__.py`:
- Classes are imported from `/nodes/*.py` modules
- Any class with `INPUT_TYPES`, `FUNCTION`, and `CATEGORY` attributes is automatically registered
- Display names are auto-generated from class names (e.g., `WanVideoSpeed` → "Wan Video Speed (QQ)")
- Classes containing "Math" in their name are explicitly excluded (line 41 in `__init__.py:41`)
- Manual override via `DISPLAY_NAME` class attribute if custom naming is needed

The registration creates two dictionaries:
- `NODE_CLASS_MAPPINGS`: Maps node class names to Python classes
- `NODE_DISPLAY_NAME_MAPPINGS`: Maps node class names to human-readable display names

### Frontend Integration

The repository includes browser-based UI components in `/web/`:
- **Power LoRA Loader**: Custom widget system (`/web/power_lora_loader_js/`) with rgthree-style UI
- **Spline Editors**: Canvas-based path drawing (`/web/spline_editor/`, `/web/power_spline_editor/`)
- **Static Assets**: External libraries in `/kjweb_async/` (served via aiohttp route at `/kjweb_async`)

The `__init__.py` sets up an aiohttp static route to serve `/kjweb_async` content to the web interface.

### Data Flow Patterns

**1. Video Tensor Format**
- ComfyUI uses BHWC format: (Batch, Height, Width, Channels)
- Internal processing often converts to CHW or NTCHW for PyTorch operations
- Always verify tensor dimensions when working with video nodes

**2. Coordinate System**
- Path coordinates are stored in JSON format with metadata: `{"coordinates": [...], "start_p_frames": N, "end_p_frames": M}`
- Two coordinate types:
  - `coordinates`: Animated paths (interpolated over frames)
  - `p_coordinates`: Static points (rendered on all frames, optionally driven by driver path)
- Supports scaling via `coord_width`/`coord_height` metadata when canvas size differs from output size

**3. LoRA Loading Architecture**
- `WanVideoPowerLoraLoader` (nodes/power_lora.py) uses `FlexibleOptionalInputType` for unlimited dynamic inputs
- Returns `WANVIDLORA` type containing list of LoRA configurations with paths, strengths, and block selections
- Supports "High/Low" LoRA pair detection: automatically identifies matching low-res variants (e.g., `foo-High.safetensors` → `foo-Low.safetensors`)
- JavaScript widget manages UI state; Python backend processes the serialized widget values
- Properties like `low_mem_load` and `merge_loras` are passed via `OptionsWidget` in the workflow JSON

## Key Node Categories

### Video Manipulation Nodes (nodes/nodes.py)

- **WanFrames**: Adjusts frame counts (divisible by 4)
- **WanVideoMerge**: Blends 2-3 videos with customizable transition frames
- **WanVideoSpeed**: Adjusts playback speed by resampling frames
- **WanVideoExtractFrame**: Extracts frames from video tensors
- **WanReplaceFirstFrame**: Replaces first frame with provided image

### Image-to-Video Encoding (nodes/image_to_video.py)

Contains the TAEHV (Tiny AutoEncoder for Hunyuan Video) implementation:
- **Memory Management**: Supports parallel (fast, high memory) and sequential (slow, low memory) processing modes
- **MemBlocks**: Temporal memory blocks that reference previous frames during encoding/decoding
- **TPool/TGrow**: Temporal pooling and growth layers for frame compression/expansion
- **WanVideoImageToVideoEncode_v2**: Main encoding node with support for start/mid/end image conditioning

Key features:
- Temporal feathering for smooth frame transitions (cosine interpolation)
- Configurable latent strength multipliers for start/mid/end frames
- Support for dual end frames (one at custom position, one at final frame)
- Noise augmentation for improved motion in I2V tasks

### Path Animation & Drawing (nodes/draw_shapes.py)

- **PathFrameConfig**: Defines easing functions, frame counts, and timing for animations
- **DrawShapeOnPath**: Renders shapes (circle/square/triangle) along coordinate paths
  - Supports multiple paths with per-path pause frames
  - Interpolation modes: linear, cardinal (Catmull-Rom), basis (B-spline), points (no interpolation)
  - Driver offset system: Apply movement from one path to transform another path
  - Handles "highlighted" control points for hard corners in spline interpolation

### Spline Editor Nodes (nodes/spline_editor.py, nodes/power_spline_editor.py)

- SplineEditor2: Single-path editor with driver offset, rotation, and smoothing
- PowerSplineEditor: Multi-layer path editor with per-layer controls
- Both output coordinate metadata in JSON format for downstream nodes
- Frontend canvas editors in `/web/` directories

### Utility Functions (utility/)

- `utility.py`: Tensor/PIL/numpy conversion utilities (pil2tensor, tensor2pil, tensor2np, np2tensor)
- `draw_utils.py`: Path interpolation, easing functions, and drawing helpers
- `driver_utils.py`: Driver path offset calculations
- `numerical.py`, `magictex.py`, `fluid.py`: Mathematical/visual effects utilities

## Common Development Tasks

### Adding a New Node

1. Create a new class in an appropriate file under `/nodes/` or create a new file
2. Define required class attributes:
   ```python
   class MyNewNode:
       @classmethod
       def INPUT_TYPES(cls):
           return {"required": {...}, "optional": {...}}

       RETURN_TYPES = ("IMAGE",)
       RETURN_NAMES = ("output",)
       FUNCTION = "process"
       CATEGORY = "WanVideoWrapper_QQ"
       DESCRIPTION = "..."

       def process(self, ...):
           return (result,)
   ```
3. The node will auto-register on ComfyUI reload (no manual registration needed)
4. Add to NODE_CLASS_MAPPINGS/NODE_DISPLAY_NAME_MAPPINGS at end of file if creating a new module

### Modifying Video Processing

- Always clone tensors before modification to avoid in-place operations: `output_video = video.clone()`
- Use `torch.clamp(tensor, 0.0, 1.0)` to ensure valid pixel values
- For frame-by-frame processing, consider using `concurrent.futures.ThreadPoolExecutor` (see draw_shapes.py)
- Ensure tensor devices match before operations: `tensor.to(device=target.device, dtype=target.dtype)`

### Working with Coordinates

- Coordinate JSON format: `{"coordinates": [[{x, y}, ...]], "start_p_frames": {...}, "end_p_frames": {...}}`
- Pause frames can be:
  - Single value: applied to all paths
  - List: per-path values
  - Dict with "p" and "c" keys: separate for p_coordinates and coordinates
- Interpolation helpers in `draw_utils.py`:
  - `interpolate_points()`: Spline interpolation (cardinal/basis)
  - `InterpMath.interpolate_or_downsample_path()`: Resampling to target frame count with easing

### Frontend Widget Development

- Custom widgets extend `RgthreeBaseWidget` (see power_lora_loader.js)
- Widgets must implement:
  - `draw(ctx, node, width, posY, height)`: Render the widget
  - `serializeValue(node, index)`: Save widget state to workflow JSON
  - `mouse(event, pos, node)`: Handle mouse interactions
- Use hit areas for clickable regions: `this.hitAreas.myButton = {bounds: [x, width], onClick: this.onButtonClick}`
- Widget state is stored in `widget.value` and must be serializable to JSON

### Testing Workflow

1. Load ComfyUI with this custom node installed
2. Press `R` to refresh node definitions after code changes
3. Test with example workflows (if available in repository)
4. For LoRA nodes: Ensure LoRA files are in ComfyUI's `models/loras/` directory
5. For video nodes: Test with batch IMAGE tensors (BHWC format)

## Important Notes

- This is a **ComfyUI custom node package**, not a standalone application
- Must be installed in `ComfyUI/custom_nodes/` directory
- Requires ComfyUI's server and frontend to function
- Python nodes run in ComfyUI's backend process
- JavaScript files are loaded by ComfyUI's frontend
- The "(QQ)" suffix in node names distinguishes these nodes from similar nodes by other authors
- VAE operations expect specific stride values: `VAE_STRIDE = (4, 8, 8)` for temporal/spatial compression
- Image-to-video encoding uses 4-frame temporal grouping (num_frames must satisfy `(n-1) % 4 == 0`)
