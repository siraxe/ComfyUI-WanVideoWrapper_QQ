"""LoRA merging functionality for LTX models."""

import torch
from ..utils.progress import ProgressBar
from ..utils.naming import LORA_DOWN_UP_FORMATS

DEFAULT_PROCESS_DTYPE = torch.bfloat16


def get_layer_strength(block_name, layer_strengths):
    """
    Get the appropriate strength multiplier for a given layer name.

    Args:
        block_name: Name of the layer block
        layer_strengths: Dictionary of layer-specific strengths

    Returns:
        The strength multiplier for this layer type
    """
    key_str = str(block_name).lower()

    # Video to audio cross-attention (most specific)
    if "video_to_audio_attn" in key_str:
        return layer_strengths["video_to_audio"]
    # Audio to video cross-attention (new in updated LTX model)
    elif "audio_to_video_attn" in key_str:
        return layer_strengths["audio_to_video"]
    # Audio attention layers
    elif ".audio_attn" in key_str or "audio_ff.net" in key_str:
        return layer_strengths["audio"]
    # Video attention and FF layers (most general)
    elif ".attn" in key_str or ".ff.net" in key_str:
        return layer_strengths["video"]
    # Everything else
    else:
        return layer_strengths["other"]


def merge_on_model_weights(all_blocks, lora_data_list, target_rank, device, checkpoint_path, show_progress):
    """
    Merge LoRAs on model weights (more accurate than pure LoRA SVD merge).

    Algorithm:
    1. Load base model weight for current block only (block swapping to save VRAM)
    2. Apply LoRAs to base weight: W_modified = W_base + sum(strength_i * (up_i @ down_i))
    3. Extract delta: delta = W_modified - W_base
    4. Apply SVD to delta to get new up/down matrices
    5. Move result to CPU, free memory, repeat for next block

    Args:
        all_blocks: Dictionary of block_name -> list of LoRA data
        lora_data_list: List of LoRA data dictionaries
        target_rank: Target rank for merged LoRA
        device: Device to use for computation
        checkpoint_path: Path to base model checkpoint
        show_progress: Whether to show progress bar

    Returns:
        Merged state dictionary
    """
    from safetensors.torch import safe_open

    if show_progress:
        print(f"Loading base model from: {checkpoint_path}")

    # Open checkpoint once, but load weights one at a time (block swapping)
    with safe_open(checkpoint_path, framework="pt", device="cpu") as f:
        checkpoint_keys = list(f.keys())

        if show_progress:
            print(f"Checkpoint has {len(checkpoint_keys)} total keys")

        merged_sd = {}
        total_blocks = len(all_blocks)

        if show_progress:
            print(f"\nMerging {total_blocks} layers on model weights (block-swapping mode)...")
            progress_bar = ProgressBar(total_blocks, "Model-weight merge")
            progress_bar.start()

        processed_count = 0
        skipped_count = 0

        for block_idx, (block_name, blocks) in enumerate(all_blocks.items()):
            if not blocks:
                continue

            is_conv2d = blocks[0]["is_conv2d"]
            down_name = blocks[0]["down_name"]
            up_name = blocks[0]["up_name"]

            # Map LoRA keys to model keys
            model_key = (
                down_name
                .replace(".lora_down", "")
                .replace(".lora_up", "")
                .replace(".lora_A", "")
                .replace(".lora_B", "")
                .replace(".down", "")
                .replace(".up", "")
            )

            # Handle checkpoint prefix mismatch
            if not model_key.startswith("model."):
                model_key = "model." + model_key

            if model_key not in f.keys():
                skipped_count += 1
                if show_progress and skipped_count <= 3:
                    print(f"  Warning: Model key not found for block '{block_name}'")
                    print(f"    Expected checkpoint key: {model_key}")
                if show_progress:
                    progress_bar.update(1)
                continue

            # Load ONLY this block's weight from checkpoint (block swapping!)
            base_weight = f.get_tensor(model_key).to(DEFAULT_PROCESS_DTYPE).to(device)

            # Start with base weight
            modified_weight = base_weight.clone()

            # Apply each LoRA: W += strength * (up @ down)
            for block in blocks:
                strength = block["strength"]
                if abs(strength) < 1e-6:
                    continue

                down = block["down"].to(device).to(DEFAULT_PROCESS_DTYPE)
                up = block["up"].to(device).to(DEFAULT_PROCESS_DTYPE)

                if is_conv2d:
                    down_flat = down.reshape(down.shape[0], -1)
                    up_flat = up.reshape(up.shape[0], -1)
                    delta = (up_flat @ down_flat) * strength
                    delta = delta.reshape(base_weight.shape[0], base_weight.shape[1],
                                      base_weight.shape[2], base_weight.shape[3])
                else:
                    delta = (up @ down) * strength

                modified_weight += delta

            # Extract delta
            delta_weight = modified_weight - base_weight

            # Clear memory before SVD
            del base_weight, modified_weight
            if str(device) == "cuda":
                torch.cuda.empty_cache()

            if delta_weight.norm() < 1e-8:
                # Exception: preserve to_gate_logits layers even with low norm
                is_gate_logits = "to_gate_logits" in block_name.lower()
                if not is_gate_logits:
                    del delta_weight
                    if show_progress:
                        progress_bar.update(1)
                    continue

            # Apply SVD to factorize at target rank (SVD requires float32)
            # For to_gate_logits, use higher effective rank to preserve information
            is_gate_logits = "to_gate_logits" in block_name.lower()
            effective_rank = target_rank if not is_gate_logits else max(target_rank * 4, 256)

            if is_conv2d:
                out_c = delta_weight.shape[0]
                in_c = delta_weight.shape[1]
                kh, kw = delta_weight.shape[2], delta_weight.shape[3]

                delta_flat = delta_weight.reshape(out_c, -1)
                U, S, Vh = torch.linalg.svd(delta_flat.float())
                actual_rank = min(effective_rank, len(S), U.shape[1], Vh.shape[0])

                U = U[:, :actual_rank] @ torch.diag(S[:actual_rank])
                Vh = Vh[:actual_rank, :]

                new_up = U.reshape(out_c, actual_rank, 1, 1).to(DEFAULT_PROCESS_DTYPE).cpu()
                new_down = Vh.reshape(actual_rank, in_c, kh, kw).to(DEFAULT_PROCESS_DTYPE).cpu()
            else:
                U, S, Vh = torch.linalg.svd(delta_weight.float())
                actual_rank = min(effective_rank, len(S), U.shape[1], Vh.shape[0])

                U = U[:, :actual_rank] @ torch.diag(S[:actual_rank])
                Vh = Vh[:actual_rank, :]

                new_up = U.to(DEFAULT_PROCESS_DTYPE).cpu()
                new_down = Vh.to(DEFAULT_PROCESS_DTYPE).cpu()

            # Clear memory and save to CPU
            del delta_weight, U, S, Vh
            if str(device) == "cuda":
                torch.cuda.empty_cache()

            merged_sd[down_name] = new_down
            merged_sd[up_name] = new_up
            merged_sd[f"{block_name}.alpha"] = torch.tensor(actual_rank, dtype=torch.int)

            processed_count += 1

            if show_progress:
                progress_bar.update(1)

    if show_progress:
        progress_bar.finish()
        print(f"  Processed: {processed_count} layers, Skipped (not in model): {skipped_count} layers")

    return merged_sd


def merge_lora_state_dicts(lora_data_list, target_rank, device, show_progress=True, checkpoint_path=None):
    """
    Merge multiple LoRA state dicts into one.

    For each block (down/up pair), we:
    1. Compute the full weight matrix: W = up @ down for each LoRA
    2. Apply layer-specific and overall strength multipliers
    3. Sum all contributions
    4. Apply SVD to factorize at target rank

    Args:
        lora_data_list: List of dictionaries with 'sd', 'strength_model', and 'layer_strengths'
        target_rank: Target rank for the merged LoRA
        device: Device to use for computation
        show_progress: Whether to show progress bar

    Returns:
        Merged state dictionary
    """
    # Build a map of block_name -> list of (down, up, alpha) from each LoRA
    all_blocks = {}

    for lora_data in lora_data_list:
        sd = lora_data["sd"]
        strength_model = lora_data["strength_model"]
        layer_strengths = lora_data["layer_strengths"]

        for key in sd.keys():
            if key.endswith(".alpha"):
                continue

            key_parts = key.split(".")
            for fmt_down, fmt_up in LORA_DOWN_UP_FORMATS:
                if len(key_parts) >= 2 and key_parts[-2] == fmt_down:
                    block_name = ".".join(key_parts[:-2])
                    weight_suffix = (
                        "." + key_parts[-1]
                        if key_parts[-1] in ["weight", "bias"]
                        else ""
                    )
                    up_key = f"{block_name}.{fmt_up}{weight_suffix}"

                    if up_key in sd:
                        if block_name not in all_blocks:
                            all_blocks[block_name] = []

                        # Get layer-specific strength
                        layer_str = get_layer_strength(block_name, layer_strengths)
                        combined_strength = strength_model * layer_str

                        all_blocks[block_name].append({
                            "down": sd[key],
                            "up": sd[up_key],
                            "alpha": sd.get(f"{block_name}.alpha"),
                            "strength": combined_strength,
                            "is_conv2d": len(sd[key].shape) == 4,
                            "down_name": key,
                            "up_name": up_key,
                        })
                    break

    # Model-weight merge if checkpoint_path is provided
    if checkpoint_path:
        return merge_on_model_weights(
            all_blocks, lora_data_list, target_rank, device, checkpoint_path, show_progress
        )

    # Initialize merged state dict
    merged_sd = {}

    # Separate single-LoRA blocks from multi-LoRA blocks
    single_lora_blocks = []
    multi_lora_blocks = []

    for block_name, blocks in all_blocks.items():
        if len(blocks) == 1:
            single_lora_blocks.append((block_name, blocks[0]))
        else:
            multi_lora_blocks.append((block_name, blocks))

    # Process single-LoRA blocks (no SVD needed, just scale)
    for block_name, block in single_lora_blocks:
        strength = block["strength"]
        is_conv2d = block["is_conv2d"]
        down_name = block["down_name"]
        up_name = block["up_name"]
        alpha = block["alpha"]

        # For single LoRA, just scale the down matrix (faster than SVD)
        merged_sd[down_name] = block["down"] * strength
        merged_sd[up_name] = block["up"]
        if alpha is not None:
            merged_sd[f"{block_name}.alpha"] = alpha * strength

    # Process multi-LoRA blocks with SVD
    if multi_lora_blocks:
        total_blocks = len(multi_lora_blocks)

        if show_progress:
            print(f"\nMerging {total_blocks} multi-LoRA layers...")
            progress_bar = ProgressBar(total_blocks, "Merging")
            progress_bar.start()

        processed_count = 0

        for block_name, blocks in multi_lora_blocks:
            if not blocks:
                continue

            processed_count += 1
            is_conv2d = blocks[0]["is_conv2d"]
            down_name = blocks[0]["down_name"]
            up_name = blocks[0]["up_name"]

            # Compute merged weight matrix by summing all contributions
            merged_weight = None

            for block in blocks:
                if abs(block["strength"]) < 1e-6:
                    continue

                down = block["down"].to(device).to(DEFAULT_PROCESS_DTYPE)
                up = block["up"].to(device).to(DEFAULT_PROCESS_DTYPE)
                strength = block["strength"]

                if is_conv2d:
                    # Flatten conv for matrix multiplication
                    up_flat = up.reshape(up.shape[0], -1)
                    down_flat = down.reshape(down.shape[0], -1)
                    weight_contrib = (up_flat @ down_flat) * strength
                else:
                    weight_contrib = (up @ down) * strength

                if merged_weight is None:
                    merged_weight = weight_contrib
                else:
                    merged_weight = merged_weight + weight_contrib

            if merged_weight is None or merged_weight.norm() < 1e-8:
                # Exception: preserve to_gate_logits layers even with low norm
                # (they may have important gating information)
                is_gate_logits = "to_gate_logits" in block_name.lower()
                if not is_gate_logits:
                    if show_progress:
                        progress_bar.update(1)
                    continue

            # Apply SVD to factorize at target rank
            # For to_gate_logits, use higher effective rank to preserve information
            is_gate_logits = "to_gate_logits" in block_name.lower()
            effective_rank = target_rank if not is_gate_logits else max(target_rank * 4, 256)

            if is_conv2d:
                out_c = merged_weight.shape[0]
                in_c = merged_weight.shape[1]
                # Get kernel size from original down
                _, _, kh, kw = blocks[0]["down"].shape

                U, S, Vh = torch.linalg.svd(merged_weight.float())
                actual_rank = min(effective_rank, len(S), U.shape[1], Vh.shape[0])

                # Truncate and apply singular values to U
                U = U[:, :actual_rank] @ torch.diag(S[:actual_rank])
                Vh = Vh[:actual_rank, :]

                new_up = U.reshape(out_c, actual_rank, 1, 1).to(DEFAULT_PROCESS_DTYPE).cpu()
                new_down = Vh.reshape(actual_rank, in_c, kh, kw).to(DEFAULT_PROCESS_DTYPE).cpu()
            else:
                U, S, Vh = torch.linalg.svd(merged_weight.float())
                actual_rank = min(effective_rank, len(S), U.shape[1], Vh.shape[0])

                # Truncate and apply singular values to U
                U = U[:, :actual_rank] @ torch.diag(S[:actual_rank])
                Vh = Vh[:actual_rank, :]

                new_up = U.to(DEFAULT_PROCESS_DTYPE).cpu()
                new_down = Vh.to(DEFAULT_PROCESS_DTYPE).cpu()

            # Store in merged state dict
            merged_sd[down_name] = new_down
            merged_sd[up_name] = new_up
            merged_sd[f"{block_name}.alpha"] = torch.tensor(actual_rank, dtype=torch.int)

            if show_progress:
                progress_bar.update(1)

        if show_progress:
            progress_bar.finish()

    if show_progress:
        progress_bar.finish()

    return merged_sd


def count_layer_types(all_blocks):
    """
    Count the number of layers by type.

    Args:
        all_blocks: Dictionary of block_name -> list of blocks

    Returns:
        Dictionary with layer type counts
    """
    layer_counts = {
        "video": 0,
        "audio": 0,
        "video_to_audio": 0,
        "audio_to_video": 0,
        "other": 0,
    }

    for block_name in all_blocks.keys():
        key_lower = block_name.lower()
        if "video_to_audio_attn" in key_lower:
            layer_counts["video_to_audio"] += 1
        elif "audio_to_video_attn" in key_lower:
            layer_counts["audio_to_video"] += 1
        elif ".audio_attn" in key_lower or "audio_ff.net" in key_lower:
            layer_counts["audio"] += 1
        elif ".attn" in key_lower or ".ff.net" in key_lower:
            layer_counts["video"] += 1
        else:
            layer_counts["other"] += 1

    return layer_counts
