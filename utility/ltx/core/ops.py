import torch

DEFAULT_PROCESS_DTYPE = torch.bfloat16

def merge_linear_block(block_loras, device, process_dtype=DEFAULT_PROCESS_DTYPE):
    """Core math for merging Linear LoRA layers."""
    first_lora = block_loras[0]
    in_rank, in_size = first_lora["down"].shape
    out_size, out_rank = first_lora["up"].shape

    merged_weight = torch.zeros(out_size, in_size, dtype=process_dtype, device=device)
    for lora_data in block_loras:
        strength = lora_data["strength"]
        if abs(strength) < 1e-6: continue

        lora_down = lora_data["down"].to(process_dtype).to(device)
        lora_up = lora_data["up"].to(process_dtype).to(device)
        merged_weight += (lora_up @ lora_down) * strength

    return merged_weight

def decompose_to_rank(merged_weight, target_rank):
    """Performs SVD and truncates to target_rank."""
    U, S, Vh = torch.linalg.svd(merged_weight.float())
    actual_rank = min(target_rank, len(S))

    U = U[:, :actual_rank] @ torch.diag(S[:actual_rank])
    Vh = Vh[:actual_rank, :]
    return U, Vh, actual_rank

def resize_lora_block(lora_down, lora_up, new_rank, alpha=None, device="cpu", process_dtype=DEFAULT_PROCESS_DTYPE, create_alpha=True):
    """Resize a single LoRA block to new rank using SVD.

    Args:
        lora_down: Down projection weight tensor
        lora_up: Up projection weight tensor
        new_rank: Target rank for resize
        alpha: Original alpha value (tensor or scalar)
        device: Device to use for computation
        process_dtype: Data type for computation
        create_alpha: If True, calculate and return new_alpha. If False, return None.

    Returns:
        tuple: (new_down, new_up, new_alpha) where new_alpha may be None if create_alpha=False
    """
    conv2d = len(lora_down.size()) == 4
    lora_down = lora_down.to(process_dtype).to(device)
    lora_up = lora_up.to(process_dtype).to(device)

    if conv2d:
        out_size, in_rank_up, _, _ = lora_up.shape
        in_rank_down, in_size, kh, kw = lora_down.shape
        merged = lora_up.reshape(out_size, -1) @ lora_down.reshape(in_rank_down, -1)
    else:
        merged = lora_up @ lora_down

    U, Vh, actual_rank = decompose_to_rank(merged, new_rank)

    if conv2d:
        new_down = Vh.reshape(actual_rank, in_size, kh, kw).cpu()
        new_up = U.reshape(out_size, actual_rank, 1, 1).cpu()
    else:
        new_down = Vh.cpu()
        new_up = U.cpu()

    # Only calculate alpha if requested
    new_alpha = None
    if create_alpha:
        orig_rank = lora_down.shape[0]
        alpha_val = alpha.item() if isinstance(alpha, torch.Tensor) else (alpha or orig_rank)
        new_alpha = float(alpha_val * actual_rank / orig_rank)

    return new_down, new_up, new_alpha

def apply_dare(weight, drop_rate=0.9):
    """
    Applies DARE (Drop and REscale) to a weight matrix.

    Args:
        weight: The reconstructed weight matrix (Delta).
        drop_rate: Proportion of weights to drop (0.9 = 90% dropped).

    Returns:
        The thinned weight matrix with same dtype as input.
    """
    if drop_rate <= 0:
        return weight

    original_dtype = weight.dtype
    weight = weight.float()

    # Create a random mask the same shape as the weight
    mask = torch.bernoulli(torch.full_like(weight, 1 - drop_rate))

    # Apply mask and rescale
    rescale_factor = 1 / (1 - drop_rate)
    result = (weight * mask) * rescale_factor

    return result.to(original_dtype)


def apply_magprune(weight, drop_rate=0.9, epsilon=0.5, row_wise=True):
    """
    Applies MagPrune (DELLA-style magnitude-based pruning) to a weight matrix.

    DELLA = Drop and rEscaLe via sampLing with mAgnitude

    Instead of random dropping (DARE), ranks weights by magnitude and assigns
    higher drop probability to low-magnitude weights. Each weight gets its own
    rescaling factor based on its drop probability.

    Args:
        weight: The reconstructed weight matrix (Delta).
        drop_rate: Average drop probability (p). Default 0.9 = 90% average drop.
        epsilon: Spread of drop probabilities. Higher = more aggressive magnitude bias.
                 0.0 = uniform (same as DARE), 1.0 = wide spread.
        row_wise: If True, rank within each row (better per DELLA paper).
                  If False, rank globally across the entire matrix.

    Returns:
        The thinned weight matrix with same dtype as input.

    Reference:
        "DELLA-Merging: Reducing Interference in Model Merging through Magnitude-Based Sampling"
        https://arxiv.org/abs/2406.11617
    """
    if drop_rate <= 0:
        return weight
    if drop_rate >= 1:
        return torch.zeros_like(weight)

    original_dtype = weight.dtype
    weight = weight.float()

    # Step 1: Rank weights by magnitude
    if row_wise:
        # Row-wise ranking (better per DELLA paper)
        # For each row, rank elements by their absolute magnitude
        n = weight.shape[1]
        # argsort twice to get ranks: 0 = highest magnitude, n-1 = lowest
        ranks = torch.argsort(torch.argsort(weight.abs(), dim=1, descending=True), dim=1)
        # Calculate drop probabilities: p_i = p_min + (epsilon/n) * rank_i
        # where p_min = drop_rate - epsilon/2
        p_min = drop_rate - epsilon / 2
        delta = epsilon / n
        drop_probs = p_min + delta * ranks
    else:
        # Global ranking across the entire matrix
        flat = weight.flatten()
        ranks = torch.argsort(torch.argsort(flat.abs(), descending=True))
        n = len(flat)
        p_min = drop_rate - epsilon / 2
        delta = epsilon / n
        drop_probs_flat = p_min + delta * ranks
        drop_probs = drop_probs_flat.reshape(weight.shape)

    # Clamp probabilities to valid range [0, 1]
    drop_probs = drop_probs.clamp(0, 1)

    # Step 2: Sample mask and apply per-weight rescaling
    mask = torch.bernoulli(1 - drop_probs)
    # Per-weight rescaling factor: 1 / (1 - p_i)
    rescale_factor = 1 / (1 - drop_probs)
    # Avoid division by zero
    rescale_factor = torch.where(drop_probs >= 1, torch.zeros_like(rescale_factor), rescale_factor)

    result = (weight * mask) * rescale_factor

    return result.to(original_dtype)


def apply_lambda_scaling(weight, lambda_val=1.0, mode="uniform", min_scale=None, top_k=None):
    """
    Applies lambda scaling to a weight matrix with multiple modes.

    DELLA found that constant lambda scaling after merge significantly
    improves performance over adaptive scaling. The optimal lambda is
    typically found by sweeping values like [0.5, 0.7, 1.0, 1.3, 1.5].

    Args:
        weight: The weight matrix to scale.
        lambda_val: Scaling factor. 1.0 = no change.
                   < 1.0 = dampen, > 1.0 = amplify.
        mode: Scaling mode. Options:
            - "uniform": Constant scaling (default, original behavior)
            - "magnitude": Magnitude-aware scaling - preserves small weights
            - "singular": Scale only top-k singular values
            - "clipped": Prevents weights from being scaled below threshold
        min_scale: For "clipped" mode, minimum scale factor (e.g., 0.5)
        top_k: For "singular" mode, number of singular values to scale (None = all)

    Returns:
        The scaled weight matrix with same dtype as input.

    Reference:
        DELLA-Merging paper, Section 4 "Adaptive vs Constant lambda"
    """
    if lambda_val == 1.0:
        return weight

    if mode == "uniform":
        return weight * lambda_val

    original_dtype = weight.dtype
    weight_float = weight.float()

    if mode == "magnitude":
        # Magnitude-aware scaling: Scale less aggressively for small weights
        # This preserves fine details while still applying scaling to strong weights
        with torch.no_grad():
            abs_weight = weight_float.abs()
            max_abs = abs_weight.max().clamp(min=1e-8)

            # Normalize to [0, 1], then apply magnitude-aware scaling
            # Small weights get scale closer to 1.0, large weights get full lambda
            normalized = abs_weight / max_abs

            # Interpolate between 1.0 and lambda based on magnitude
            # Small magnitude -> scale closer to 1.0 (preserve)
            # Large magnitude -> scale closer to lambda (full effect)
            scale_per_weight = 1.0 + (lambda_val - 1.0) * normalized

            result = weight_float * scale_per_weight
        return result.to(original_dtype)

    elif mode == "singular":
        # Singular value scaling: Scale only the top-k singular values
        # This preserves the rank structure while still applying scaling
        U, S, Vh = torch.linalg.svd(weight_float, full_matrices=False)

        # Scale singular values
        S_scaled = S.clone()
        if top_k is None:
            S_scaled = S * lambda_val
        else:
            k = min(top_k, len(S))
            S_scaled[:k] = S[:k] * lambda_val
            # Remaining singular values unchanged

        # Reconstruct
        result = U @ torch.diag(S_scaled) @ Vh
        return result.to(original_dtype)

    elif mode == "clipped":
        # Clipped scaling: Ensure small weights aren't scaled below threshold
        # min_scale acts as a floor - no weight gets scaled more than this
        if min_scale is None:
            min_scale = 0.5

        # For lambda < 1 (reduction), min_scale is the maximum reduction
        # For lambda > 1 (amplification), we clamp the lower bound
        if lambda_val < 1.0:
            # When reducing, don't reduce below min_scale
            effective_scale = max(lambda_val, min_scale)
        else:
            # When amplifying, min_scale prevents small weights from getting too small
            # This is more about preserving the minimum magnitude
            with torch.no_grad():
                abs_weight = weight_float.abs()
                max_abs = abs_weight.max().clamp(min=1e-8)
                normalized = abs_weight / max_abs
                # Small weights get less amplification
                scale_per_weight = 1.0 + (lambda_val - 1.0) * normalized
                # Apply minimum scale floor
                scale_per_weight = scale_per_weight.clamp(min=min_scale)
                result = weight_float * scale_per_weight
            return result.to(original_dtype)

        return weight * effective_scale

    else:
        raise ValueError(f"Unknown scaling mode: {mode}. Choose from: uniform, magnitude, singular, clipped")


def apply_magnitude_scaling(weight, lambda_val=1.0):
    """
    Magnitude-aware scaling: Preserves small weights while scaling large ones.

    Small weights are scaled less aggressively than large weights, preventing
    fine details from vanishing when lambda < 1.0, and preventing small weights
    from becoming too large when lambda > 1.0.

    Args:
        weight: The weight matrix to scale.
        lambda_val: Scaling factor (1.0 = no change).

    Returns:
        The scaled weight matrix with same dtype as input.
    """
    return apply_lambda_scaling(weight, lambda_val, mode="magnitude")


def apply_singular_value_scaling(weight, lambda_val=1.0, top_k=None):
    """
    Singular value scaling: Scales only the top-k singular values.

    This preserves the rank structure of the weight matrix while applying
    scaling to the most important directions. The singular values represent
    the "energy" in each direction - scaling them preserves the structure.

    Args:
        weight: The weight matrix to scale.
        lambda_val: Scaling factor (1.0 = no change).
        top_k: Number of top singular values to scale (None = all).

    Returns:
        The scaled weight matrix with same dtype as input.
    """
    return apply_lambda_scaling(weight, lambda_val, mode="singular", top_k=top_k)


def apply_clipped_scaling(weight, lambda_val=1.0, min_scale=0.5):
    """
    Clipped scaling: Prevents weights from being scaled below a threshold.

    When reducing weights (lambda < 1.0), ensures no weight is scaled below
    min_scale. This prevents small weights from vanishing completely.

    Args:
        weight: The weight matrix to scale.
        lambda_val: Scaling factor (1.0 = no change).
        min_scale: Minimum scale factor (default 0.5).

    Returns:
        The scaled weight matrix with same dtype as input.
    """
    return apply_lambda_scaling(weight, lambda_val, mode="clipped", min_scale=min_scale)


# ============================================================================
# DO-Merge: Magnitude & Direction Decoupling (from AIT/MergeOrthogonalProcess)
# ============================================================================

def frobenius_norm_product(U: torch.Tensor, D: torch.Tensor) -> torch.Tensor:
    """
    Computes the Frobenius norm of (U @ D) in O(R^2 * d) time instead of O(d^2) time.
    norm(U @ D)^2 = tr(D^T U^T U D) = tr(U^T U D D^T)

    This is used in DO-Merge to efficiently compute LoRA magnitudes without
    expanding to the full [d_out, d_in] matrix.

    Args:
        U: Up projection matrix [d_out, rank]
        D: Down projection matrix [rank, d_in]

    Returns:
        Frobenius norm of the product U @ D
    """
    UT_U = torch.matmul(U.t(), U)
    D_DT = torch.matmul(D, D.t())
    return torch.sqrt(torch.abs(torch.trace(torch.matmul(UT_U, D_DT))))


def trace_product(U1: torch.Tensor, D1: torch.Tensor, U2: torch.Tensor, D2: torch.Tensor) -> torch.Tensor:
    """
    Computes the trace of (U1 @ D1)^T @ (U2 @ D2) efficiently.
    tr(D1^T U1^T U2 D2) = tr(D2 D1^T U1^T U2)

    This measures the alignment between two LoRA weight matrices without
    expanding to full size. Used in DO-Merge to compute directional similarity.

    Args:
        U1, D1: Up and down matrices of first LoRA
        U2, D2: Up and down matrices of second LoRA

    Returns:
        Trace value representing alignment (-1 to 1 range approximately)
    """
    U1T_U2 = torch.matmul(U1.t(), U2)
    D2_D1T = torch.matmul(D2, D1.t())
    return torch.trace(torch.matmul(D2_D1T, U1T_U2))


def decoupled_magnitude_direction_merge(
    W_up1: torch.Tensor, W_up2: torch.Tensor,
    W_down1: torch.Tensor, W_down2: torch.Tensor
) -> tuple[torch.Tensor, torch.Tensor, int]:
    """
    Magnitude/Direction Decoupling (DO-Merge style) with Exact Rank Preservation.

    This solves the issue where one LoRA has massive weight magnitudes and overpowers
    the other during structure merging, even if their directional vectors are aligned.

    By distributing the calculated DO-Merge scalars directly into the down-projection
    matrices, we achieve mathematically perfect concatenation with ZERO data loss,
    ZERO approximation error, and instantaneous calculation speed (bypassing SVD).

    Algorithm:
    1. Calculate true magnitudes efficiently using frobenius_norm_product
    2. Calculate direction alignment via trace_product
    3. Compute balanced target magnitude using geometric mean
    4. Calculate scaling factors for each LoRA to achieve exact DO-Merge equation
    5. Apply scalars and concatenate (100% exact math, 0 data loss, 0 SVD)

    Args:
        W_up1: Up matrix of first LoRA [d_out, rank1]
        W_up2: Up matrix of second LoRA [d_out, rank2]
        W_down1: Down matrix of first LoRA [rank1, d_in]
        W_down2: Down matrix of second LoRA [rank2, d_in]

    Returns:
        tuple: (lora_up_new, lora_down_new, optimal_rank)
            - lora_up_new: Concatenated up matrix [d_out, rank1 + rank2]
            - lora_down_new: Scaled and concatenated down matrix [rank1 + rank2, d_in]
            - optimal_rank: rank1 + rank2 (exact preservation)

    Reference:
        DO-Merge: "Decoupling Magnitude and Direction for Efficient Model Merging"
        AIT implementation: MergeOrthogonalProcess.py lines 61-100
    """
    # 1. Calculate true magnitudes efficiently without expanding to full matrices
    mag1 = frobenius_norm_product(W_up1.float(), W_down1.float()) + 1e-8
    mag2 = frobenius_norm_product(W_up2.float(), W_down2.float()) + 1e-8

    # 2. Calculate the direction sum norm efficiently
    # norm(dir1 + dir2)^2 = 2 + 2 * tr(dir1^T dir2)
    cross_trace = trace_product(W_up1.float(), W_down1.float(), W_up2.float(), W_down2.float())
    norm_dir_sum_sq = 2.0 + 2.0 * cross_trace / (mag1 * mag2)
    norm_dir_sum_sq = torch.clamp(norm_dir_sum_sq, min=1e-8)
    norm_dir_sum = torch.sqrt(norm_dir_sum_sq)

    # 3. Calculate the balanced target magnitude (Geometric Mean)
    merged_mag = torch.sqrt(mag1 * mag2)

    # 4. Calculate final scaling factors for each LoRA to achieve the exact DO-Merge equation
    global_scalar = merged_mag / norm_dir_sum

    scale1 = global_scalar / mag1
    scale2 = global_scalar / mag2

    # 5. Apply scalars to the down matrices and concatenate (100% exact math, 0 data loss, 0 SVD)
    down1_new = W_down1.float() * scale1
    down2_new = W_down2.float() * scale2

    lora_up_new = torch.cat([W_up1.float(), W_up2.float()], dim=1)
    lora_down_new = torch.cat([down1_new, down2_new], dim=0)

    optimal_rank = lora_up_new.shape[1]  # rank1 + rank2 exactly

    return lora_up_new.to(W_up1.dtype), lora_down_new.to(W_down1.dtype), optimal_rank


def apply_ties_delta_scaling(delta_weights, densities, lambda_val=1.0):
    """
    Applies DELLA-style lambda scaling to TIES-merged deltas.

    After the TIES merge (Trim, Elect, Merge), applies a constant
    lambda scaling factor to boost or dampen the merged result.

    Args:
        delta_weights: List of reconstructed weight matrices (Deltas) from each LoRA
        densities: List of densities (0.0 to 1.0) for trimming
        lambda_val: Post-merge scaling factor

    Returns:
        Scaled merged weight matrix.
    """
    merged = apply_ties(delta_weights, densities)
    return apply_lambda_scaling(merged, lambda_val)

def apply_ties(delta_weights, densities):
    """
    Applies TIES (Trim, Elect, and Merge) to multiple weight matrices.

    TIES treats weight deltas like a democratic election to decide which
    LoRA gets to control which specific parameter.

    Args:
        delta_weights: List of reconstructed weight matrices (Deltas) from each LoRA
        densities: List of floats (0.0 to 1.0) for trimming noise per LoRA.
                   0.2 = keep top 20% most significant weights, zero out the rest.

    Returns:
        A single consensus weight matrix.

    The three stages:
    1. Trim: Keep only top k% magnitudes per LoRA (remove noise)
    2. Elect: Sign consensus - positive vs negative "votes" per parameter
    3. Merge: Disjoint merge - average only values that agree with winning sign
    """
    if len(delta_weights) == 0:
        raise ValueError("No delta weights provided")

    if len(delta_weights) == 1:
        return delta_weights[0]

    # Store original dtype for consistent output
    original_dtype = delta_weights[0].dtype

    # ==============================
    # Stage 1: Trim - Keep only top k% magnitudes per LoRA
    # ==============================
    trimmed_deltas = []
    for delta, density in zip(delta_weights, densities):
        if density >= 1.0:
            trimmed_deltas.append(delta)
            continue

        if density <= 0.0:
            trimmed_deltas.append(torch.zeros_like(delta))
            continue

        # Convert to float for consistent threshold computation
        delta_float = delta.float()
        flat_delta = delta_float.abs().flatten()

        # Calculate k (number of elements to keep)
        k = int(density * flat_delta.numel())
        if k == 0:
            trimmed_deltas.append(torch.zeros_like(delta))
            continue

        # Get threshold value at the k-th position
        threshold = torch.topk(flat_delta, k).values[-1]

        # Create mask and apply
        mask = (delta_float.abs() >= threshold).to(delta_float.dtype)
        trimmed_deltas.append((delta_float * mask).to(delta.dtype))

    # ==============================
    # Stage 2: Elect - Sign Consensus
    # ==============================
    stacked_deltas = torch.stack(trimmed_deltas)
    signs = torch.sign(stacked_deltas)

    # Sum the magnitudes for positive and negative directions
    # This creates the "vote count" for each direction
    pos_mask = (signs > 0).float()
    neg_mask = (signs < 0).float()

    pos_sum = (stacked_deltas.abs() * pos_mask).sum(dim=0)
    neg_sum = (stacked_deltas.abs() * neg_mask).sum(dim=0)

    # The winning sign is the one with more total magnitude
    final_sign = torch.where(pos_sum >= neg_sum, 1.0, -1.0)

    # ==============================
    # Stage 3: Disjoint Merge - Average only agreeing values
    # ==============================
    # Create mask where LoRA agrees with the winning sign
    consensus_mask = (signs == final_sign).float()

    # Mask out disagreeing values and sum across LoRAs
    sum_agreed = (stacked_deltas * consensus_mask).sum(dim=0)

    # Count how many LoRAs contributed to each parameter's agreement
    count_agreed = consensus_mask.sum(dim=0).clamp(min=1.0)

    # Average only the values that agreed with the winning sign
    result = sum_agreed / count_agreed

    return result.to(original_dtype)
