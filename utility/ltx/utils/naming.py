import torch

LORA_DOWN_UP_FORMATS = [
    ("lora_down", "lora_up"),  # sd-scripts LoRA
    ("lora_A", "lora_B"),      # PEFT LoRA
    ("down", "up"),            # ControlLoRA
]

def is_audio_layer(key):
    """Check if a key corresponds to an audio/video layer."""
    # Use dot-notation checks to avoid false positives (e.g., "audio" in other contexts)
    key_lower = key.lower()
    return (
        ".audio_attn" in key_lower or
        "audio_ff" in key_lower or
        "audio_to_video_attn" in key_lower or
        "video_to_audio_attn" in key_lower
    )


def is_audio_ff_layer(key: str) -> bool:
    """Detect audio FF layers specifically (audio_ff in key)."""
    return ".audio_ff." in key


def is_video_ff_layer(key: str) -> bool:
    """Detect video FF layers (ff layers that are NOT audio_ff).

    Note: to_gate_logits is part of attention layers (not FF), so we
    explicitly exclude it from FF classification.
    """
    # Check for actual FF/MLP layer patterns (using dot notation to avoid false matches)
    key_lower = key.lower()
    # Exclude to_gate_logits (part of attention, not FF)
    if "to_gate_logits" in key_lower:
        return False
    # Look for actual FF/MLP patterns (e.g., ".ff.", ".feed_forward.", ".mlp.", ".gate.")
    # Using dot notation avoids false matches like "ff" in "diffusion_model"
    # Also exclude audio_ff since those are audio layers, not video FF
    has_ff_pattern = (".ff." in key_lower or ".feed_forward." in key_lower or ".mlp." in key_lower or ".gate." in key_lower)
    is_not_audio_ff = ".audio_ff." not in key_lower
    return has_ff_pattern and is_not_audio_ff


# ============================================================================
# Semantic Layer Detection (for AIT-style smart merging)
# ============================================================================

def is_cross_attention_layer(key: str) -> bool:
    """
    Detect cross-attention layers (prompt routing).

    Cross-attention layers handle text-to-image/video conditioning and act
    as "trigger routers" - they control which prompts activate which features.

    These benefit from Bilateral Subspace Orthogonalization (BSO) to prevent
    trigger conflicts between merged LoRAs.
    """
    key_lower = key.lower()
    return any(
        indicator in key_lower
        for indicator in ["attn2", "txt_attn", "context", "txt_in", "enc"]
    )


def is_temporal_layer(key: str) -> bool:
    """
    Detect temporal/motion layers.

    Temporal layers handle video motion and timing. Like audio, they act as
    style controllers and benefit from BSO to prevent motion style conflicts.
    """
    key_lower = key.lower()
    return any(
        indicator in key_lower
        for indicator in ["temp", "time", "video", "motion"]
    )


def is_mlp_layer(key: str) -> bool:
    """
    Detect MLP/structural layers.

    MLP layers handle the actual feature transformation (not routing). They
    benefit from Magnitude/Direction Decoupling (DO-Merge) to prevent one
    LoRA's magnitude from overpowering another.

    Note: to_gate_logits is part of attention layers (not MLP/FF), so we
    explicitly exclude it from MLP classification.
    """
    key_lower = key.lower()
    # Exclude to_gate_logits (part of attention, not MLP/FF)
    if "to_gate_logits" in key_lower:
        return False
    # Look for actual FF/MLP patterns (using dot notation to avoid false matches)
    # Note: audio_ff is also an MLP/FF layer, so we include it
    return any(
        f".{indicator}." in key_lower
        for indicator in ["ff", "audio_ff", "feed_forward", "mlp", "gate"]
    )


def is_video_only_layer(key: str) -> bool:
    """
    Detect video-only layers (non-FF, non-audio).

    Video-only layers are cross-attention, temporal, and other structural
    layers that are NOT audio layers and NOT FF/MLP layers.
    """
    return not is_audio_layer(key) and not is_mlp_layer(key)


def get_layer_semantic_type(key: str) -> str:
    """
    Determine the semantic type of a layer for smart merging.

    Returns:
        "cross_attn": Cross-attention (prompt routing) → use BSO
        "audio": Audio layers → use BSO
        "temporal": Temporal/motion layers → use BSO
        "mlp": Structural/MLP layers → use DO-Merge
        "other": Other layers → default behavior
    """
    if is_audio_layer(key):
        return "audio"
    if is_cross_attention_layer(key):
        return "cross_attn"
    if is_temporal_layer(key):
        return "temporal"
    if is_mlp_layer(key):
        return "mlp"
    return "other"

def normalize_lora_key(key):
    """Normalize a LoRA key to a standard format for matching."""
    normalized = key
    for fmt in LORA_DOWN_UP_FORMATS:
        normalized = normalized.replace(f".{fmt[0]}", ".lora_down")
        normalized = normalized.replace(f".{fmt[1]}", ".lora_up")
    return normalized

def get_layer_info(lora_sd):
    """Analyze LoRA layers and count different types."""
    layer_counts = {
        "attn1": 0, "attn2": 0, "ff": 0, "audio": 0, "other": 0, "total": 0
    }
    blocks = set()

    for key in lora_sd.keys():
        if key.endswith(".alpha"): continue

        key_parts = key.split(".")
        for fmt_down, _ in LORA_DOWN_UP_FORMATS:
            if len(key_parts) >= 2 and fmt_down == key_parts[-2]:
                block_name = ".".join(key_parts[:-2])
                if block_name not in blocks:
                    blocks.add(block_name)
                    if is_audio_layer(block_name):
                        layer_counts["audio"] += 1
                    elif "attn1" in block_name:
                        layer_counts["attn1"] += 1
                    elif "attn2" in block_name:
                        layer_counts["attn2"] += 1
                    elif any(x in block_name for x in ["ff", "feed_forward"]):
                        layer_counts["ff"] += 1
                    else:
                        layer_counts["other"] += 1
                break

    layer_counts["total"] = len(blocks)
    return layer_counts

def build_block_map(lora_sd):
    """
    Build a block map from a single LoRA state dict.
    Returns dict mapping block_name -> block_data with down/up weights.
    Used by both pruner.py and merger.py.
    """
    blocks = {}
    for key in lora_sd.keys():
        if key.endswith(".alpha"): continue

        key_parts = key.split(".")
        for fmt_down, fmt_up in LORA_DOWN_UP_FORMATS:
            if len(key_parts) >= 2 and fmt_down == key_parts[-2]:
                block_name = ".".join(key_parts[:-2])

                # Determine suffix (.weight or empty)
                weight_suffix = "." + key_parts[-1] if key_parts[-1] in ["weight", "bias"] else ""
                up_key = f"{block_name}.{fmt_up}{weight_suffix}"

                if up_key in lora_sd:
                    blocks[block_name] = {
                        "down": lora_sd[key],
                        "up": lora_sd[up_key],
                        "alpha": lora_sd.get(f"{block_name}.alpha"),
                        "down_name": key,
                        "up_name": up_key,
                        "is_conv2d": len(lora_sd[key].shape) == 4,
                        "is_audio": is_audio_layer(block_name)
                    }
                break
    return blocks