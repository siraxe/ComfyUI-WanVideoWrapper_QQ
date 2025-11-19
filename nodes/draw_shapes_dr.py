"""
Driver-chain helpers for draw_shapes.

This module isolates the logic required to resolve multi-layer driver chains,
including metadata normalization, graph construction, and topological sorting.
The helpers are intentionally generic so they can be reused from both the UI
side (for previews) and the server-side rendering path.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from ..utility import draw_utils


@dataclass(frozen=True)
class LayerDriverRecord:
    """
    Represents a single animated layer, the optional driver referenced by it,
    and any metadata that should be propagated downstream.

    Attributes:
        index: Zero-based layer index inside processed_coords_list.
        name: Human readable name for the layer (unique within the node).
        driver_target: Name of the layer that should drive this layer.
        driver_meta: Metadata dictionary describing how to apply the driver.
    """

    index: int
    name: str
    driver_target: Optional[str]
    driver_meta: Optional[Dict[str, Any]]


class DriverGraphError(RuntimeError):
    """Raised when driver dependency resolution fails (e.g., circular reference)."""


def round_coord(value: Any, precision: int = 4) -> float:
    try:
        return round(float(value), precision)
    except (TypeError, ValueError):
        return 0.0


def calculate_driver_offset(
    frame_index: int,
    interpolated_driver: List[Dict[str, Any]],
    pause_frames: Tuple[int, int],
    total_frames: int,
    driver_scale: float = 1.0,
    frame_width: int = 512,
    frame_height: int = 512,
    driver_scale_factor: float = 1.0,
    driver_radius_delta: float = 0.0,
    driver_path_normalized: bool = True,
    apply_scale_to_offset: bool = True,
) -> Tuple[float, float]:
    """
    Calculate driver offset for a given frame based on interpolated driver path.
    """
    if not interpolated_driver:
        return 0.0, 0.0

    driver_index = max(0, min(frame_index, len(interpolated_driver) - 1))
    if 0 <= driver_index < len(interpolated_driver):
        ref_x = float(interpolated_driver[0]["x"])
        ref_y = float(interpolated_driver[0]["y"])
        current_x = float(interpolated_driver[driver_index]["x"])
        current_y = float(interpolated_driver[driver_index]["y"])

        scale_multiplier = driver_scale * driver_scale_factor if apply_scale_to_offset else driver_scale
        offset_x = (current_x - ref_x) * scale_multiplier
        offset_y = (current_y - ref_y) * scale_multiplier

        if driver_radius_delta and (offset_x or offset_y):
            length = math.hypot(offset_x, offset_y)
            if length > 0:
                offset_x += (offset_x / length) * driver_radius_delta
                offset_y += (offset_y / length) * driver_radius_delta

        if driver_path_normalized:
            offset_x *= frame_width
            offset_y *= frame_height
        return offset_x, offset_y

    return 0.0, 0.0


def apply_box_pivot_scaling(
    loc_x: float,
    loc_y: float,
    pivot: Optional[Tuple[float, float]],
    offset_x: float,
    offset_y: float,
    scale_factor: float,
    frame_width: int,
    frame_height: int,
    pivot_normalized: bool = True,
) -> Tuple[float, float]:
    if not pivot or abs(scale_factor - 1.0) < 1e-6:
        return loc_x, loc_y
    pivot_x, pivot_y = pivot
    if pivot_normalized:
        pivot_x *= frame_width
        pivot_y *= frame_height

    base_loc_x = loc_x - offset_x
    base_loc_y = loc_y - offset_y
    dx = base_loc_x - pivot_x
    dy = base_loc_y - pivot_y
    scaled_x = pivot_x + dx * scale_factor
    scaled_y = pivot_y + dy * scale_factor

    return scaled_x + offset_x, scaled_y + offset_y


def _fallback_layer_name(index: int) -> str:
    return f"Layer {index + 1}"


def normalize_layer_names(meta: Optional[Dict[str, Any]], num_layers: int,
                          names_key: str = "c", fallback_prefix: str = "Layer") -> List[str]:
    """
    Returns a list of layer names for animated coordinate paths.

    Metadata format follows PowerSplineEditor exports where names live under
    meta['names']['c']. If names are missing or shorter than num_layers,
    deterministic fallback names are generated.
    """
    result: List[str] = []
    if isinstance(meta, dict):
        names_meta = meta.get("names")
        if isinstance(names_meta, dict):
            coords_names = names_meta.get(names_key) or names_meta.get("layers") or []
            if isinstance(coords_names, list):
                result = [str(name) for name in coords_names[:num_layers]]

    if len(result) < num_layers:
        for idx in range(len(result), num_layers):
            result.append(f"{fallback_prefix} {idx + 1}")
    elif len(result) > num_layers:
        result = result[:num_layers]

    return result


def _extract_driver_reference(driver_meta: Optional[Dict[str, Any]]) -> Optional[str]:
    """
    Pulls the driver layer reference from driver metadata.

    Supports several keys to allow UI/back-end evolution without touching this helper:
    - 'driver_layer'
    - 'driver_layer_name'
    - 'driver_layer_ref'
    - 'driver_source'
    - 'driver_source_name'
    - 'driver_name'
    - 'source_layer'
    - 'source_name'
    """
    if not isinstance(driver_meta, dict):
        return None

    candidate_keys = (
        "driver_layer",
        "driver_layer_name",
        "driver_layer_ref",
        "driver_source",
        "driver_source_name",
        "driver_name",
        "source_layer",
        "source_name",
    )

    for key in candidate_keys:
        value = driver_meta.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    # Allow referencing by index when the UI provides driver_layer_index
    layer_index = driver_meta.get("driver_layer_index")
    if isinstance(layer_index, int):
        # The caller can translate this index to a name using normalize_layer_names
        # and replace driver_target later if needed.
        return str(layer_index)

    return None


def build_layer_driver_records(
    meta: Optional[Dict[str, Any]],
    coords_driver_info_list: Iterable[Optional[Dict[str, Any]]],
    names_key: str = "c",
    fallback_prefix: str = "Layer",
) -> List[LayerDriverRecord]:
    """
    Builds LayerDriverRecord entries for every animated layer.
    """
    driver_infos = list(coords_driver_info_list)
    names = normalize_layer_names(meta, len(driver_infos), names_key, fallback_prefix)
    records: List[LayerDriverRecord] = []

    for idx, driver_meta in enumerate(driver_infos):
        driver_target = _extract_driver_reference(driver_meta)

        # If the target looks like a numeric index we will temporarily store it.
        if driver_target is not None and driver_target.isdigit():
            int_idx = int(driver_target)
            if 0 <= int_idx < len(names):
                driver_target = names[int_idx]

        records.append(
            LayerDriverRecord(
                index=idx,
                name=names[idx],
                driver_target=driver_target,
                driver_meta=driver_meta,
            )
        )

    return records


def build_dependency_graph(records: Iterable[LayerDriverRecord]) -> Dict[str, Set[str]]:
    """
    Creates an adjacency list graph where edges point from driver -> driven layer.
    """
    graph: Dict[str, Set[str]] = {}
    for record in records:
        graph.setdefault(record.name, set())

    for record in records:
        if record.driver_target and record.driver_target in graph:
            graph.setdefault(record.driver_target, set()).add(record.name)

    return graph


def detect_cycles(graph: Dict[str, Set[str]]) -> Optional[List[str]]:
    """
    Performs cycle detection using DFS. Returns the nodes in the found cycle if any.
    """
    visited: Set[str] = set()
    stack: Set[str] = set()
    parent: Dict[str, str] = {}

    def visit(node: str) -> Optional[List[str]]:
        visited.add(node)
        stack.add(node)
        for neighbor in graph.get(node, ()):
            if neighbor not in visited:
                parent[neighbor] = node
                cycle = visit(neighbor)
                if cycle:
                    return cycle
            elif neighbor in stack:
                # Build cycle path
                cycle_path = [neighbor]
                current = node
                while current != neighbor:
                    cycle_path.append(current)
                    current = parent[current]
                cycle_path.append(neighbor)
                cycle_path.reverse()
                return cycle_path
        stack.remove(node)
        return None

    for node in graph:
        if node not in visited:
            cycle = visit(node)
            if cycle:
                return cycle
    return None


def topologically_sort_layers(records: Iterable[LayerDriverRecord]) -> List[LayerDriverRecord]:
    """
    Returns records sorted so that drivers appear before the layers they drive.
    """
    record_map = {record.name: record for record in records}
    graph = build_dependency_graph(records)

    cycle = detect_cycles(graph)
    if cycle:
        readable_cycle = " -> ".join(cycle)
        raise DriverGraphError(f"Circular driver chain detected: {readable_cycle}")

    # Kahn's algorithm
    indegree: Dict[str, int] = {name: 0 for name in graph}
    for node, neighbors in graph.items():
        for neighbor in neighbors:
            indegree[neighbor] += 1

    queue: List[str] = [name for name, deg in indegree.items() if deg == 0]
    ordered_names: List[str] = []

    while queue:
        node = queue.pop(0)
        ordered_names.append(node)
        for neighbor in graph.get(node, ()):
            indegree[neighbor] -= 1
            if indegree[neighbor] == 0:
                queue.append(neighbor)

    if len(ordered_names) != len(graph):
        raise DriverGraphError("Failed to resolve driver ordering due to disconnected nodes.")

    return [record_map[name] for name in ordered_names if name in record_map]


def resolve_driver_processing_order(
    meta: Optional[Dict[str, Any]],
    coords_driver_info_list: Iterable[Optional[Dict[str, Any]]],
    names_key: str = "c",
    fallback_prefix: str = "Layer",
) -> Tuple[List[LayerDriverRecord], List[int]]:
    """
    Convenience helper that builds LayerDriverRecords and returns both the sorted
    records and the list of layer indices in processing order.
    """
    records = build_layer_driver_records(meta, coords_driver_info_list, names_key, fallback_prefix)
    sorted_records = topologically_sort_layers(records)
    sorted_indices = [record.index for record in sorted_records]
    return sorted_records, sorted_indices


def apply_driver_chain_offsets(
    meta: Optional[Dict[str, Any]],
    driver_info_list: List[Optional[Dict[str, Any]]],
    total_frames: int,
    names_key: str = "c",
    path_key: str = "interpolated_path",
    fallback_prefix: str = "Layer",
    resolved_paths: Optional[Dict[str, List[Dict[str, float]]]] = None,
) -> Dict[str, List[Dict[str, float]]]:
    """
    Adjusts driver interpolated paths so that drivers driven by other drivers inherit the parent's motion.
    """
    if not driver_info_list:
        return resolved_paths or {}

    resolved_paths = resolved_paths or {}

    try:
        driver_records, _ = resolve_driver_processing_order(
            meta, driver_info_list, names_key=names_key, fallback_prefix=fallback_prefix
        )
    except DriverGraphError as exc:
        print(f"[DriverChain] error: {exc}")
        return resolved_paths

    for record in driver_records:
        idx = record.index
        if idx >= len(driver_info_list):
            continue
        driver_info = driver_info_list[idx]
        if not isinstance(driver_info, dict):
            continue
        path = driver_info.get(path_key)
        if not isinstance(path, list) or not path:
            continue

        parent_name = record.driver_target
        parent_path = resolved_paths.get(parent_name) if parent_name else None
        parent_ref_x = parent_ref_y = 0.0
        if parent_path:
            parent_ref_x = float(parent_path[0].get("x", 0.0))
            parent_ref_y = float(parent_path[0].get("y", 0.0))

        adjusted_path: List[Dict[str, float]] = []
        for pt in path:
            try:
                # Preserve all fields from original point, update x and y with rounded values
                new_pt = dict(pt) if isinstance(pt, dict) else {}
                new_pt["x"] = round_coord(pt.get("x", 0.0))
                new_pt["y"] = round_coord(pt.get("y", 0.0))
                adjusted_path.append(new_pt)
            except (AttributeError, TypeError, ValueError):
                adjusted_path.append({"x": 0.0, "y": 0.0})

        if parent_name and parent_name in resolved_paths:
            parent_world_path = resolved_paths[parent_name]

            if not adjusted_path and parent_world_path:
                adjusted_path = [{"x": 0.0, "y": 0.0}] * len(parent_world_path)

            if names_key == "p":
                # For point (p_) layers, we do NOT overwrite the layer's own
                # base path with the parent's path anymore. Instead, we let
                # the layer keep its own per-point positions and later apply
                # the parent's motion purely as an offset at render time.
                # So here we leave adjusted_path as-is for 'p', and only
                # apply full path inheritance for non-point layers.
                pass
            else:
                limit = min(len(adjusted_path), len(parent_world_path))
                parent_ref_x = float(parent_world_path[0].get("x", 0.0)) if parent_world_path else 0.0
                parent_ref_y = float(parent_world_path[0].get("y", 0.0)) if parent_world_path else 0.0
                for i in range(limit):
                    parent_delta_x = float(parent_world_path[i].get("x", 0.0)) - parent_ref_x
                    parent_delta_y = float(parent_world_path[i].get("y", 0.0)) - parent_ref_y
                    adjusted_path[i]["x"] = round_coord(adjusted_path[i]["x"] + parent_delta_x)
                    adjusted_path[i]["y"] = round_coord(adjusted_path[i]["y"] + parent_delta_y)

        driver_info[path_key] = adjusted_path
        if names_key == "p" and parent_name and parent_name in resolved_paths:
            driver_info["driver_path_normalized"] = False
            if adjusted_path:
                try:
                    driver_info["driver_pivot"] = (
                        float(adjusted_path[0].get("x", 0.0)),
                        float(adjusted_path[0].get("y", 0.0)),
                    )
                except (TypeError, ValueError):
                    pass
        driver_info["_chain_resolved"] = True

        base_layer_path = resolved_paths.get(record.name)
        parent_world = resolved_paths.get(parent_name) if parent_name else None
        world_adjusted: List[Dict[str, float]] = []
        if isinstance(base_layer_path, list) and base_layer_path:
            if isinstance(parent_world, list) and parent_world:
                ref_px = float(parent_world[0].get("x", 0.0))
                ref_py = float(parent_world[0].get("y", 0.0))
                limit = min(len(base_layer_path), len(parent_world))
                for i in range(limit):
                    bx = float(base_layer_path[i].get("x", 0.0))
                    by = float(base_layer_path[i].get("y", 0.0))
                    dx = float(parent_world[i].get("x", 0.0)) - ref_px
                    dy = float(parent_world[i].get("y", 0.0)) - ref_py
                    # Preserve all fields from base_layer_path
                    new_pt = dict(base_layer_path[i]) if isinstance(base_layer_path[i], dict) else {}
                    new_pt["x"] = round_coord(bx + dx)
                    new_pt["y"] = round_coord(by + dy)
                    world_adjusted.append(new_pt)
            else:
                for pt in base_layer_path:
                    try:
                        new_pt = dict(pt) if isinstance(pt, dict) else {}
                        new_pt["x"] = round_coord(pt.get("x", 0.0))
                        new_pt["y"] = round_coord(pt.get("y", 0.0))
                        world_adjusted.append(new_pt)
                    except Exception:
                        world_adjusted.append({"x": 0.0, "y": 0.0})
        else:
            for pt in adjusted_path:
                try:
                    new_pt = dict(pt) if isinstance(pt, dict) else {}
                    new_pt["x"] = round_coord(pt.get("x", 0.0))
                    new_pt["y"] = round_coord(pt.get("y", 0.0))
                    world_adjusted.append(new_pt)
                except Exception:
                    world_adjusted.append({"x": 0.0, "y": 0.0})

        resolved_paths[record.name] = world_adjusted

    return resolved_paths


def build_layer_path_map(layer_names: List[str], processed_coords_list: List[List[Dict[str, Any]]]) -> Dict[str, List[Dict[str, float]]]:
    layer_map: Dict[str, List[Dict[str, float]]] = {}
    for idx, path in enumerate(processed_coords_list):
        if idx >= len(layer_names):
            break
        layer_name = layer_names[idx]
        if not layer_name:
            continue
        sanitized_path: List[Dict[str, float]] = []
        if isinstance(path, list):
            for pt in path:
                if isinstance(pt, dict):
                    # Preserve all fields from original point
                    new_pt = dict(pt)
                    new_pt["x"] = round_coord(pt.get("x", 0.0))
                    new_pt["y"] = round_coord(pt.get("y", 0.0))
                    sanitized_path.append(new_pt)
        layer_map[layer_name] = sanitized_path
    return layer_map


def get_driver_scale_for_frame(driver_info: Dict[str, Any], frame_index: int, default_scale: float = 1.0) -> float:
    profile = driver_info.get("driver_scale_profile")
    if isinstance(profile, list) and profile:
        idx = max(0, min(frame_index, len(profile) - 1))
        try:
            return float(profile[idx])
        except (TypeError, ValueError):
            pass
    return float(driver_info.get("driver_scale_factor", default_scale))


def scale_points_and_driver_path(
    static_point_layers: List[List[Dict[str, Any]]],
    static_points_driver_path: Optional[List[Dict[str, Any]]],
    coord_width: Optional[float],
    coord_height: Optional[float],
    frame_width: int,
    frame_height: int,
) -> Tuple[List[List[Dict[str, Any]]], Optional[List[Dict[str, Any]]], bool]:
    if not coord_width or not coord_height:
        return static_point_layers, static_points_driver_path, True

    scale_x = float(frame_width) / float(coord_width) if coord_width else 1.0
    scale_y = float(frame_height) / float(coord_height) if coord_height else 1.0

    if scale_x == 1.0 and scale_y == 1.0:
        return static_point_layers, static_points_driver_path, True

    scaled_static_layers: List[List[Dict[str, Any]]] = []
    for layer in static_point_layers:
        scaled_layer: List[Dict[str, Any]] = []
        for pt in layer:
            sp = dict(pt)
            sp["x"] = float(pt["x"]) * scale_x
            sp["y"] = float(pt["y"]) * scale_y
            scaled_layer.append(sp)
        scaled_static_layers.append(scaled_layer)

    scaled_driver: Optional[List[Dict[str, Any]]] = None
    if static_points_driver_path:
        scaled_driver = []
        for pt in static_points_driver_path:
            if isinstance(pt, dict) and "x" in pt and "y" in pt:
                sp = dict(pt)
                sp["x"] = float(pt["x"]) * scale_x
                sp["y"] = float(pt["y"]) * scale_y
                scaled_driver.append(sp)

    return scaled_static_layers, scaled_driver, False


def process_driver_path(
    raw_path: Optional[List[Dict[str, Any]]],
    total_frames: int,
    smooth_strength: float,
    easing_function: str,
    easing_path: str,
    easing_strength: float,
    trailing_weight_factor: float = 0.5,
    rotate_degrees: float = 0.0,
) -> Optional[List[Dict[str, Any]]]:
    if not raw_path:
        return None
    try:
        source_path = raw_path
        if rotate_degrees and rotate_degrees != 0.0:
            try:
                source_path = draw_utils.rotate_path(source_path, rotate_degrees)
            except Exception:
                source_path = raw_path

        if len(source_path) != total_frames:
            processed = draw_utils.InterpMath.interpolate_or_downsample_path(
                source_path,
                total_frames,
                easing_function,
                easing_path,
                bounce_between=0.0,
                easing_strength=easing_strength,
            )
        else:
            processed = [dict(p) for p in source_path]

        if smooth_strength and smooth_strength > 0.0 and len(processed) > 2:
            smoothed = [processed[0].copy()]
            neighbor_weight = smooth_strength * trailing_weight_factor
            for i in range(1, len(processed) - 1):
                curr = processed[i]
                prev = processed[i - 1]
                nxt = processed[i + 1]
                current_weight = 1.0 - (2 * neighbor_weight)
                sx = (
                    current_weight * float(curr["x"])
                    + neighbor_weight * float(prev["x"])
                    + neighbor_weight * float(nxt["x"])
                )
                sy = (
                    current_weight * float(curr["y"])
                    + neighbor_weight * float(prev["y"])
                    + neighbor_weight * float(nxt["y"])
                )
                # Preserve all fields from curr, then update x and y with smoothed values
                smoothed_pt = dict(curr)
                smoothed_pt["x"] = sx
                smoothed_pt["y"] = sy
                smoothed.append(smoothed_pt)
            smoothed.append(processed[-1].copy())
            processed = smoothed
        return processed
    except Exception:
        return None


def scale_driver_metadata(
    meta: Dict[str, Any],
    coord_width: Optional[float],
    coord_height: Optional[float],
    frame_width: int,
    frame_height: int,
    static_points_use_driver: bool,
    num_static_point_layers: int,
) -> Tuple[Optional[Dict[str, Any]], Optional[List[Optional[Dict[str, Any]]]]]:
    drivers_meta = meta.get("drivers")
    if not ((coord_width or coord_height) and isinstance(drivers_meta, dict)):
        return drivers_meta, None

    scale_x = float(frame_width) / float(coord_width) if coord_width else 1.0
    scale_y = float(frame_height) / float(coord_height) if coord_height else 1.0

    def scale_point_value(value: Any) -> Any:
        if isinstance(value, (list, tuple)) and len(value) >= 2:
            try:
                return (float(value[0]) * scale_x, float(value[1]) * scale_y)
            except (TypeError, ValueError):
                return value
        return value

    def scale_driver_entries(entries: Iterable[Any]) -> List[Any]:
        scaled_entries: List[Any] = []
        for driver_info in entries:
            if isinstance(driver_info, dict):
                driver_path = driver_info.get("path")
                if isinstance(driver_path, list) and driver_path:
                    scaled_path = []
                    for pt in driver_path:
                        if isinstance(pt, dict) and "x" in pt and "y" in pt:
                            scaled_path.append(
                                {
                                    **{k: v for k, v in pt.items() if k not in ("x", "y")},
                                    "x": float(pt["x"]) * scale_x,
                                    "y": float(pt["y"]) * scale_y,
                                }
                            )
                    dcopy = driver_info.copy()
                    dcopy["path"] = scaled_path
                    pivot = driver_info.get("driver_pivot")
                    if pivot:
                        dcopy["driver_pivot"] = scale_point_value(pivot)
                    dcopy["driver_path_normalized"] = False
                    scaled_entries.append(dcopy)
                else:
                    scaled_entries.append(driver_info)
            else:
                scaled_entries.append(driver_info)
        return scaled_entries

    for key in ("c", "b", "p"):
        entries = drivers_meta.get(key)
        if isinstance(entries, list):
            drivers_meta[key] = scale_driver_entries(entries)

    meta["drivers"] = drivers_meta

    refreshed_list: Optional[List[Optional[Dict[str, Any]]]] = None
    if static_points_use_driver and num_static_point_layers > 0:
        refreshed = drivers_meta.get("p")
        if isinstance(refreshed, list):
            refreshed_list = [None] * num_static_point_layers
            for idx in range(min(num_static_point_layers, len(refreshed))):
                info = refreshed[idx]
                if isinstance(info, dict) and isinstance(info.get("path"), list) and info["path"]:
                    refreshed_list[idx] = info

    return drivers_meta, refreshed_list


ACCELERATION_THRESHOLD = 0.001
Coord = Dict[str, Any]
Path = List[Coord]


def resample_scale_profile(
    scale_profile: Optional[List[float]],
    target_length: int,
    easing_function: str = "linear",
    easing_strength: float = 1.0,
) -> List[float]:
    if target_length <= 0:
        return []
    cleaned = []
    if isinstance(scale_profile, list):
        for value in scale_profile:
            try:
                cleaned.append(float(value))
            except (TypeError, ValueError):
                continue
    if not cleaned:
        return [1.0] * target_length

    if len(cleaned) == 1:
        return [cleaned[0]] * target_length

    max_index = len(cleaned) - 1
    result = []

    def apply_easing(value):
        easing_map = {
            "linear": lambda t: t,
            "in": lambda t: draw_utils.InterpMath._ease_in(t, easing_strength),
            "out": lambda t: draw_utils.InterpMath._ease_out(t, easing_strength),
            "in_out": lambda t: draw_utils.InterpMath._ease_in_out(t, easing_strength),
            "out_in": lambda t: draw_utils.InterpMath._ease_out_in(t, easing_strength),
        }
        return easing_map.get(easing_function, lambda t: t)(value)

    for i in range(target_length):
        if target_length == 1:
            result.append(cleaned[-1])
            continue
        t_linear = i / (target_length - 1)
        eased_t = apply_easing(t_linear)
        position = eased_t * max_index
        idx1 = int(math.floor(position))
        idx2 = min(max_index, idx1 + 1)
        t = position - idx1
        if idx1 == idx2:
            result.append(cleaned[idx1])
        else:
            result.append(cleaned[idx1] * (1.0 - t) + cleaned[idx2] * t)
    return result


def _normalize_metadata_lists(
    num_paths: int,
    start_p_frames_meta,
    end_p_frames_meta,
    interpolations_meta,
    drivers_meta,
    offsets_meta,
    box_prefix_count: int = 0,
) -> Tuple[List[int], List[int], List[str], List[Optional[Any]], List[int]]:
    """
    Normalize metadata values to per-path lists with length num_paths:
    - start_p_frames_list, end_p_frames_list -> lists of ints
    - interpolations_list -> list of strings
    - drivers_list -> list of driver dicts or None
    - offsets_list -> list of ints
    """

    def expand_int_meta(value, count, default=0):
        if count <= 0:
            return []
        if isinstance(value, list):
            cleaned = []
            for entry in value:
                try:
                    cleaned.append(int(entry))
                except (TypeError, ValueError):
                    cleaned.append(default)
            if len(cleaned) >= count:
                return cleaned[:count]
            return cleaned + [default] * (count - len(cleaned))
        if isinstance(value, (int, float)):
            return [int(value)] * count
        return [default] * count

    coords_count = max(num_paths - box_prefix_count, 0)
    start_p_frames_list = expand_int_meta(
        start_p_frames_meta.get("b") if isinstance(start_p_frames_meta, dict) else start_p_frames_meta,
        box_prefix_count,
    ) + expand_int_meta(
        start_p_frames_meta.get("c") if isinstance(start_p_frames_meta, dict) else start_p_frames_meta,
        coords_count,
        0,
    )
    end_p_frames_list = expand_int_meta(
        end_p_frames_meta.get("b") if isinstance(end_p_frames_meta, dict) else end_p_frames_meta,
        box_prefix_count,
    ) + expand_int_meta(
        end_p_frames_meta.get("c") if isinstance(end_p_frames_meta, dict) else end_p_frames_meta,
        coords_count,
        0,
    )

    def expand_interp_meta(value, count, default="linear"):
        if count <= 0:
            return []
        if isinstance(value, list):
            cleaned = [str(v) if v is not None else default for v in value]
            if len(cleaned) >= count:
                return cleaned[:count]
            return cleaned + [default] * (count - len(cleaned))
        if isinstance(value, str):
            return [value] * count
        return [default] * count

    if isinstance(interpolations_meta, dict):
        b_inter = interpolations_meta.get("b", "linear")
        c_inter = interpolations_meta.get("c", "linear")
        interpolations_list = expand_interp_meta(b_inter, box_prefix_count) + expand_interp_meta(
            c_inter, coords_count
        )
    else:
        interpolations_list = expand_interp_meta(interpolations_meta, num_paths)

    def expand_drivers_meta(value, count):
        if count <= 0:
            return []
        if isinstance(value, list):
            trimmed = value[:count]
            if len(trimmed) < count:
                trimmed.extend([None] * (count - len(trimmed)))
            return trimmed
        if isinstance(value, dict):
            return [value] + [None] * (count - 1)
        return [None] * count

    if isinstance(drivers_meta, dict):
        b_drivers = drivers_meta.get("b", [])
        c_drivers = drivers_meta.get("c", [])
        drivers_list = expand_drivers_meta(b_drivers, box_prefix_count) + expand_drivers_meta(
            c_drivers, coords_count
        )
    else:
        drivers_list = [None] * num_paths

    offsets_list = expand_int_meta(
        offsets_meta.get("b") if isinstance(offsets_meta, dict) else offsets_meta, box_prefix_count
    ) + expand_int_meta(
        offsets_meta.get("c") if isinstance(offsets_meta, dict) else offsets_meta, coords_count, 0
    )

    return start_p_frames_list, end_p_frames_list, interpolations_list, drivers_list, offsets_list


def _normalize_easing_lists(
    num_paths: int, easing_meta, default_value, box_prefix_count: int = 0
) -> List:
    """
    Normalize easing metadata values to per-path lists with length num_paths:
    - For functions: default 'linear'
    - For paths: default 'full'
    - For strengths: default 1.0
    """

    def expand_meta(value, count):
        if count <= 0:
            return []
        if isinstance(value, list):
            cleaned = [v if v is not None else default_value for v in value]
            if len(cleaned) >= count:
                return cleaned[:count]
            return cleaned + [default_value] * (count - len(cleaned))
        if isinstance(value, (int, float, str)):
            return [value] * count
        return [default_value] * count

    coords_count = max(num_paths - box_prefix_count, 0)
    if isinstance(easing_meta, dict):
        b_meta = easing_meta.get("b", default_value)
        c_meta = easing_meta.get("c", default_value)
        easing_list = expand_meta(b_meta, box_prefix_count) + expand_meta(c_meta, coords_count)
    else:
        easing_list = expand_meta(easing_meta, num_paths)

    if len(easing_list) < num_paths:
        easing_list.extend([default_value] * (num_paths - len(easing_list)))

    return easing_list[:num_paths]


def _apply_offset_timing(points: Path, offset: int) -> Tuple[Path, int, int]:
    """
    Apply timing offset by removing coordinates and returning pause adjustments.
    Returns (modified_points, start_pause_adjustment, end_pause_adjustment).
    """
    if offset == 0 or not points:
        return points, 0, 0

    offset_abs = abs(offset)
    path_length = len(points)
    if offset_abs >= path_length:
        offset_abs = max(0, path_length - 1)

    if offset > 0:
        # Positive offset: remove last N frames, add N to start pause
        return (points[:-offset_abs] if offset_abs > 0 else points, offset_abs, 0)
    else:
        # Negative: remove last N frames, add N to end pause
        return (points[:-offset_abs] if offset_abs > 0 else points, 0, offset_abs)


def build_interpolated_paths(
    coords_list_raw: List[Path],
    total_frames: int,
    start_p_frames_meta,
    end_p_frames_meta,
    offsets_meta,
    interpolations_meta,
    drivers_meta,
    easing_functions_meta,
    easing_paths_meta,
    easing_strengths_meta,
    scales_meta,
    accelerations_meta=None,
    box_prefix_count: int = 0,
    coord_width: Optional[float] = None,
    coord_height: Optional[float] = None,
    frame_width: int = 512,
    frame_height: int = 512,
    meta: Optional[Dict[str, Any]] = None,
    layer_names_override: Optional[List[str]] = None,
    layer_types_override: Optional[List[str]] = None,
) -> Tuple[List[Path], List[Tuple[int, int]], List[Optional[Dict[str, Any]]], List[float]]:
    """
    Given raw coordinate lists and metadata, produce:
     - processed_coords_list: list of resampled/interpolated paths
     - path_pause_frames: list of (start_p, end_p) for each processed path
     - coords_driver_info_list: per-path driver info dict or None
    Raises or returns empty list if no valid paths.
    """
    if not coords_list_raw:
        return [], [], [], []

    effective_meta = meta or {}
    num_paths = len(coords_list_raw)
    if layer_names_override:
        resolved_layer_names = list(layer_names_override[:num_paths])
    else:
        resolved_layer_names = normalize_layer_names(
            effective_meta, num_paths, names_key="c", fallback_prefix="Layer"
        )
    if layer_types_override:
        types_list = list(layer_types_override[:num_paths])
    else:
        types_list = []
    if len(types_list) < num_paths:
        types_list.extend(["path"] * (num_paths - len(types_list)))
    (
        start_p_frames_list,
        end_p_frames_list,
        interpolations_list,
        drivers_list,
        offsets_list,
    ) = _normalize_metadata_lists(
        num_paths,
        start_p_frames_meta,
        end_p_frames_meta,
        interpolations_meta,
        drivers_meta,
        offsets_meta,
        box_prefix_count,
    )
    # Normalize per-path easing parameters
    easing_functions_list = _normalize_easing_lists(num_paths, easing_functions_meta, "easing_function")
    easing_paths_list = _normalize_easing_lists(num_paths, easing_paths_meta, "easing_path")
    easing_strengths_list = _normalize_easing_lists(num_paths, easing_strengths_meta, "easing_strength")
    accelerations_list = _normalize_easing_lists(num_paths, accelerations_meta, 0.00)
    scales_list = _normalize_easing_lists(num_paths, scales_meta, 1.0, box_prefix_count)

    processed_coords_list: List[Path] = []
    path_pause_frames: List[Tuple[int, int]] = []
    coords_driver_info_list: List[Optional[Dict[str, Any]]] = []
    valid_paths_exist = False

    for i, path in enumerate(coords_list_raw):
        if not isinstance(path, list) or len(path) == 0:
            continue

        # Validate and ensure float coordinates
        valid = True
        for pt_idx, pt in enumerate(path):
            if not isinstance(pt, dict) or "x" not in pt or "y" not in pt:
                valid = False
                break
            try:
                pt["x"] = float(pt["x"])
                pt["y"] = float(pt["y"])
            except (ValueError, TypeError):
                valid = False
                break
        if not valid:
            continue

        try:
            path_start_p = int(start_p_frames_list[i])
            path_end_p = int(end_p_frames_list[i])
            path_offset = int(offsets_list[i])
            path_interpolation = interpolations_list[i]
            path_driver_info = drivers_list[i] if i < len(drivers_list) else None
            path_easing_function = (
                easing_functions_list[i] if i < len(easing_functions_list) else "in_out"
            )
            path_easing_path = easing_paths_list[i] if i < len(easing_paths_list) else "full"
            path_easing_strength = float(easing_strengths_list[i]) if i < len(easing_strengths_list) else 1.0

            path_animation_frames = max(1, total_frames - path_start_p - path_end_p)
            effective_easing_path = path_easing_path
            layer_type = types_list[i] if i < len(types_list) else "path"
            is_points_mode = path_interpolation == "points" or layer_type == "points"

            # Mark control points for 'each' easing path
            if effective_easing_path == "each":
                for p in path:
                    p["is_control"] = True

            # Interpolate points (or use 'points' mode)
            if is_points_mode:
                interpolated_path = path
            else:
                # draw_utils.interpolate_points will handle cardinal, basis, etc.
                interpolated_path = draw_utils.interpolate_points(path, path_interpolation, effective_easing_path)

            # Resample/interpolate to match path_animation_frames
            processed_path = draw_utils.InterpMath.interpolate_or_downsample_path(
                interpolated_path,
                path_animation_frames,
                path_easing_function,
                effective_easing_path,
                bounce_between=0.0,
                easing_strength=path_easing_strength,
                interpolation=path_interpolation,
            )

            # Apply acceleration remapping if acceleration is not zero
            path_acceleration = float(accelerations_list[i]) if i < len(accelerations_list) else 0.00
            if abs(path_acceleration) > ACCELERATION_THRESHOLD:
                processed_path = draw_utils.InterpMath.apply_acceleration_remapping(
                    processed_path, path_acceleration
                )

            # Prepare per-path driver interpolation (for per-frame offsets)
            driver_info_for_frame = None
            if isinstance(path_driver_info, dict):
                raw_driver_path = path_driver_info.get("path")
                driver_rotate = path_driver_info.get("rotate", 0)
                driver_d_scale = path_driver_info.get("d_scale", 1.0)

                # Use driver's own interpolation parameters if available, otherwise fall back to driven layer's parameters
                driver_easing_function = path_driver_info.get("easing_function", path_easing_function)
                driver_easing_path = path_driver_info.get("easing_path", path_easing_path)
                driver_easing_strength = path_driver_info.get("easing_strength", path_easing_strength)
                driver_acceleration = path_driver_info.get("acceleration", 0.00)

                if raw_driver_path and len(raw_driver_path) > 0:
                    transformed_driver = raw_driver_path
                    # NOTE: Driver paths are already scaled in drawshapemask() at lines 391-415
                    # Do NOT scale them again here or they'll be scaled twice

                    if driver_rotate and driver_rotate != 0:
                        transformed_driver = draw_utils.rotate_path(transformed_driver, driver_rotate)
                    # d_scale will be applied during rendering to the offset
                    interpolated_driver = draw_utils.InterpMath.interpolate_or_downsample_path(
                        transformed_driver,
                        total_frames,
                        driver_easing_function,
                        driver_easing_path,
                        bounce_between=0.0,
                        easing_strength=driver_easing_strength,
                    )

                    # Apply acceleration remapping if acceleration is not zero
                    if abs(driver_acceleration) > ACCELERATION_THRESHOLD:
                        interpolated_driver = draw_utils.InterpMath.apply_acceleration_remapping(
                            interpolated_driver, driver_acceleration
                        )

                    raw_scale_profile = path_driver_info.get("driver_scale_profile") or []
                    interpolated_scale_profile = resample_scale_profile(
                        raw_scale_profile,
                        len(interpolated_driver),
                        driver_easing_function,
                        driver_easing_strength,
                    )
                    driver_scale_factor = (
                        float(interpolated_scale_profile[-1]) if interpolated_scale_profile else 1.0
                    )
                    driver_pivot = path_driver_info.get("driver_pivot")
                    if not driver_pivot and transformed_driver and isinstance(transformed_driver[0], dict):
                        try:
                            driver_pivot = (
                                float(transformed_driver[0].get("x", 0.0)),
                                float(transformed_driver[0].get("y", 0.0)),
                            )
                        except (TypeError, ValueError):
                            driver_pivot = None

                    # Resolve driver target reference
                    driver_target_ref = _extract_driver_reference(path_driver_info)
                    if driver_target_ref and driver_target_ref.isdigit():
                        idx = int(driver_target_ref)
                        if 0 <= idx < len(resolved_layer_names):
                            driver_target_ref = resolved_layer_names[idx]

                    driver_info_for_frame = {
                        "interpolated_path": interpolated_driver,
                        "pause_frames": (path_start_p, path_end_p),
                        "d_scale": driver_d_scale,
                        "easing_function": driver_easing_function,
                        "easing_path": driver_easing_path,
                        "easing_strength": driver_easing_strength,
                        # Propagate driver's own timing if available
                        "start_pause": int(path_driver_info.get("start_pause", 0)),
                        "end_pause": int(path_driver_info.get("end_pause", 0)),
                        "offset": int(path_driver_info.get("offset", 0)),
                        "is_points_mode": is_points_mode,
                        "driver_scale_factor": driver_scale_factor,
                        "driver_scale_profile": interpolated_scale_profile,
                        "driver_pivot": driver_pivot,
                        "driver_type": path_driver_info.get("driver_type"),
                        "driver_path_normalized": path_driver_info.get("driver_path_normalized", True),
                        "driver_layer_name": driver_target_ref,
                        "layer_name": resolved_layer_names[i],
                    }
                    print(
                        f"[DriverDebug] driver_info_for_frame layer={resolved_layer_names[i]} target={driver_info_for_frame['driver_layer_name']} is_points={is_points_mode}"
                    )

            # Apply offset timing (modify processed_path and adjust pauses)
            if path_offset != 0:
                processed_path, start_adj, end_adj = _apply_offset_timing(processed_path, path_offset)
                path_start_p += start_adj
                path_end_p += end_adj

            processed_coords_list.append(processed_path)
            path_pause_frames.append((path_start_p, path_end_p))
            coords_driver_info_list.append(driver_info_for_frame)
            scales_list.append(float(scales_list[i]) if i < len(scales_list) else 1.0)
            valid_paths_exist = True
        except Exception:
            # Skip this path on processing error
            continue

    if not valid_paths_exist:
        return [], [], [], []

    return processed_coords_list, path_pause_frames, coords_driver_info_list, scales_list


__all__ = [
    "DriverGraphError",
    "LayerDriverRecord",
    "normalize_layer_names",
    "build_layer_driver_records",
    "build_dependency_graph",
    "detect_cycles",
    "topologically_sort_layers",
    "resolve_driver_processing_order",
    "round_coord",
    "calculate_driver_offset",
    "apply_box_pivot_scaling",
    "apply_driver_chain_offsets",
    "build_layer_path_map",
    "get_driver_scale_for_frame",
    "scale_points_and_driver_path",
    "process_driver_path",
    "scale_driver_metadata",
    "build_interpolated_paths",
    "resample_scale_profile",
]
