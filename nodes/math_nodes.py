class HolocineFrames:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "video_length": ("INT", {"default": 161, "min": 41, "max": 541, "step": 4}),
                "shots": ("INT", {"default": 2, "min": 2, "max": 10, "step": 1}),
                "distribution": ("FLOAT", {"default": 0.50, "min": 0.01, "max": 1.00, "step": 0.01}),
            },
            "optional": {
                "shot_list": ("WANVID_HOLOCINE_SHOT_LIST",),
            }
        }

    RETURN_TYPES = ("INT", "STRING")
    RETURN_NAMES = ("video_length", "shots_string")
    FUNCTION = "calculate_holocine_frames"
    CATEGORY = "WanVideoWrapper_QQ"
    DESCRIPTION = "Calculates video frame distribution for Holocine video generation"

    def calculate_holocine_frames(self, video_length, shots, distribution, shot_list=None):
        """
        Compute cut positions using exponent-based easing:
        - distribution < 0.5 → front-loaded (gamma > 1)
        - distribution = 0.5 → linear (gamma = 1)
        - distribution > 0.5 → back-loaded (gamma < 1)
        Guarantees strictly increasing intermediate cuts and reserves final frame.
        """

        # Use shot_list length if provided and valid, otherwise use shots parameter
        if shot_list is not None and hasattr(shot_list, '__len__') and len(shot_list) >= 2:
            actual_shots = len(shot_list)
        else:
            actual_shots = shots

        # Number of intermediate cuts between start (0) and final (video_length)
        num_cuts = max(1, actual_shots - 1)

        d = float(distribution)
        # Map distribution to exponent gamma
        gamma_min = 0.35
        gamma_max = 4.0
        if d < 0.5:
            # Front-load: push more cuts earlier
            gamma = 1.0 + (1.0 - (d / 0.5)) * (gamma_max - 1.0)
        elif d > 0.5:
            # Back-load: push more cuts later
            gamma = 1.0 - (((d - 0.5) / 0.5) * (1.0 - gamma_min))
        else:
            gamma = 1.0

        shot_positions = []
        prev = 0
        for i in range(1, num_cuts + 1):
            # Uniform fraction in (0,1)
            t = i / float(actual_shots)
            # Exponent-based easing
            f = t ** gamma
            pos = int(round(f * video_length))

            # Reserve space for remaining cuts and final frame
            remaining = num_cuts - i
            max_allowed = (video_length - 1) - remaining
            # Clamp and enforce strict monotonic increase
            pos = max(prev + 1, min(max_allowed, pos))
            shot_positions.append(pos)
            prev = pos

        # Always end with video_length
        shot_positions.append(video_length)

        # Post-processing: enforce first cut >= 9 and min gap >= 8
        min_first = 9
        min_gap = 8
        cuts = shot_positions[:-1]
        L = video_length
        n = len(cuts)

        if n > 0:
            # Compute feasible gap given first cut constraint
            gap_eff = min_gap
            if n > 1:
                max_gap_for_min_first = (L - 1 - min_first) // (n - 1)
                if max_gap_for_min_first < gap_eff:
                    gap_eff = max(1, max_gap_for_min_first)

            # Clamp first cut within feasible bounds
            max_first_allowed = L - 1 - (n - 1) * gap_eff
            if max_first_allowed < 1:
                max_first_allowed = 1
            cuts[0] = max(cuts[0], min_first)
            if cuts[0] > max_first_allowed:
                cuts[0] = max_first_allowed

            # Forward pass: enforce min gaps and feasibility
            for i in range(1, n):
                min_i = cuts[i - 1] + gap_eff
                max_i = L - 1 - (n - 1 - i) * gap_eff
                if cuts[i] < min_i:
                    cuts[i] = min_i
                if cuts[i] > max_i:
                    cuts[i] = max_i

            # Backward pass: tighten from the end while keeping feasibility
            for i in range(n - 2, -1, -1):
                max_from_next = cuts[i + 1] - gap_eff
                bound = L - 1 - (n - 1 - i) * gap_eff
                max_allowed = min(max_from_next, bound)
                if cuts[i] > max_allowed:
                    cuts[i] = max_allowed

            # Final forward pass to ensure min gaps after backward tightening
            for i in range(1, n):
                min_i = cuts[i - 1] + gap_eff
                if cuts[i] < min_i:
                    cuts[i] = min_i

            # Ensure last intermediate cut doesn't exceed L - 1
            if cuts[-1] > L - 1:
                cuts[-1] = L - 1

            # Recombine with final frame
            shot_positions = cuts + [L]

        # Convert to comma-separated string
        shots_string = ",".join(map(str, shot_positions))

        return (video_length, shots_string)
    
NODE_CLASS_MAPPINGS = {
    "HolocineFrames": HolocineFrames
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "HolocineFrames": "Holocine Frames"
}
