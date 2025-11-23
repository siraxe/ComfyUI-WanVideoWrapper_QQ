import { BOX_TIMELINE_MAX_POINTS } from './canvas_constants.js';

export function attachBoxTimelineHelpers(editor) {
  // Helper to get max frames dynamically (can be overridden by editor._maxFrames)
  editor._getMaxFrames = () => {
    return editor._maxFrames || BOX_TIMELINE_MAX_POINTS;
  };

  editor._isBoxLayerWidget = (widget) => widget?.value?.type === 'box_layer';

  editor._ensureBoxLayerData = (widget) => {
    if (!editor._isBoxLayerWidget(widget)) return null;
    if (!Array.isArray(widget.value.box_keys)) {
      widget.value.box_keys = [];
    }
    const width = Math.max(1, Number(editor.width) || 1);
    const height = Math.max(1, Number(editor.height) || 1);
    widget.value.box_keys = widget.value.box_keys
      .map((key) => {
        if (!key) return null;
        const rawX = typeof key.x === 'number' ? key.x : 0.5;
        const rawY = typeof key.y === 'number' ? key.y : 0.5;
        const normX = Math.abs(rawX) > 1 ? rawX / width : rawX;
        const normY = Math.abs(rawY) > 1 ? rawY / height : rawY;
        const scaleVal = (typeof key.scale === 'number' && !Number.isNaN(key.scale)) ? key.scale : 1;
        const rotationVal = (typeof key.rotation === 'number' && !Number.isNaN(key.rotation)) ? key.rotation : 0;
        return {
          frame: Math.max(1, Math.min(editor._getMaxFrames(), Math.round(key.frame || 1))),
          x: Math.max(0, Math.min(1, normX)),
          y: Math.max(0, Math.min(1, normY)),
          scale: editor.clampScaleValue ? editor.clampScaleValue(scaleVal) : Math.max(0.2, Math.min(3, scaleVal)),
          rotation: rotationVal,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a.frame || 0) - (b.frame || 0));
    const current = Number(widget.value.box_timeline_point) || 1;
    widget.value.box_timeline_point = Math.max(1, Math.min(editor._getMaxFrames(), Math.round(current)));
    return widget.value.box_keys;
  };

  editor._getBoxLayerStoredPoint = (widget) => {
    if (!widget) return { x: 0.5, y: 0.5, scale: 1, rotation: 0 };
    let stored = [];
    try {
      stored = JSON.parse(widget.value.points_store || '[]');
    } catch {}
    const point = stored && stored[0] ? stored[0] : { x: 0.5, y: 0.5 };
    const rotation = (() => {
      if (typeof point.rotation === 'number' && !Number.isNaN(point.rotation)) {
        return point.rotation;
      }
      if (typeof point.boxRotation === 'number' && !Number.isNaN(point.boxRotation)) {
        return point.boxRotation;
      }
      return 0;
    })();
    return {
      x: typeof point.x === 'number' ? point.x : 0.5,
      y: typeof point.y === 'number' ? point.y : 0.5,
      scale: editor.clampScaleValue(
        typeof point.boxScale === 'number'
          ? point.boxScale
          : (typeof point.scale === 'number' ? point.scale : 1)
      ),
      rotation,
    };
  };

  editor._basisInterpolate = (p0, p1, p2, p3, t) => {
    const t2 = t * t;
    const t3 = t2 * t;

    const b0 = (1 - t3 + 3 * t2 - 3 * t) / 6;
    const b1 = (4 - 6 * t2 + 3 * t3) / 6;
    const b2 = (1 + 3 * t + 3 * t2 - 3 * t3) / 6;
    const b3 = t3 / 6;

    return {
      x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
      y: b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y,
      scale: b0 * p0.scale + b1 * p1.scale + b2 * p2.scale + b3 * p3.scale,
      rotation: b0 * p0.rotation + b1 * p1.rotation + b2 * p2.rotation + b3 * p3.rotation,
    };
  };

  editor._computeBoxLayerPosition = (widget, frame) => {
    const keys = editor._ensureBoxLayerData(widget);
    if (!keys || !keys.length) {
      return editor._getBoxLayerStoredPoint(widget);
    }
    const sorted = keys.slice().sort((a, b) => a.frame - b.frame);
    const clampedFrame = Math.max(1, Math.min(editor._getMaxFrames(), frame));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const resolveRotation = (entry) => {
      const rot = entry?.rotation;
      return (typeof rot === 'number' && !Number.isNaN(rot)) ? rot : 0;
    };
    if (clampedFrame <= first.frame) {
      return { x: first.x, y: first.y, scale: first.scale ?? 1, rotation: resolveRotation(first) };
    }
    if (clampedFrame >= last.frame) {
      return { x: last.x, y: last.y, scale: last.scale ?? 1, rotation: resolveRotation(last) };
    }
    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i];
      const next = sorted[i + 1];
      const interpolationMode = widget.value.box_interpolation || 'linear';

      if (clampedFrame === current.frame) {
        if (interpolationMode === 'basis' && sorted.length >= 3) {
          for (let j = 0; j < sorted.length - 1; j++) {
            if (sorted[j].frame === current.frame) {
              const prev = sorted[Math.max(0, j - 1)];
              const curr = sorted[j];
              const nextPt = sorted[j + 1];
              const nextNext = sorted[Math.min(sorted.length - 1, j + 2)];

              const makePoint = (point) => ({
                x: point?.x ?? 0.5,
                y: point?.y ?? 0.5,
                scale: point?.scale ?? 1,
                rotation: resolveRotation(point),
              });

              const cp0 = makePoint(prev);
              const cp1 = makePoint(curr);
              const cp2 = makePoint(nextPt);
              const cp3 = makePoint(nextNext);

              return editor._basisInterpolate(cp0, cp1, cp2, cp3, 0);
            }
          }
        }
        return { x: current.x, y: current.y, scale: current.scale ?? 1, rotation: resolveRotation(current) };
      }

      if (clampedFrame > current.frame && clampedFrame < next.frame) {
        const span = next.frame - current.frame;
        const t = span > 0 ? (clampedFrame - current.frame) / span : 0;
        // Linear interpolation without wrapping - allows unlimited rotation (360+)
        const rotCurrent = resolveRotation(current);
        const rotNext = resolveRotation(next);
        const rotation = rotCurrent + (rotNext - rotCurrent) * t;

        if (interpolationMode === 'linear') {
          return {
            x: current.x + (next.x - current.x) * t,
            y: current.y + (next.y - current.y) * t,
            scale: (current.scale ?? 1) + ((next.scale ?? 1) - (current.scale ?? 1)) * t,
            rotation,
          };
        }

        const p0 = sorted[Math.max(0, i - 1)];
        const p1 = current;
        const p2 = next;
        const p3 = sorted[Math.min(sorted.length - 1, i + 2)];

        const makePoint = (point) => ({
          x: point?.x ?? 0.5,
          y: point?.y ?? 0.5,
          scale: point?.scale ?? 1,
          rotation: resolveRotation(point),
        });

        const cp0 = makePoint(p0);
        const cp1 = makePoint(p1);
        const cp2 = makePoint(p2);
        const cp3 = makePoint(p3);

        if (interpolationMode === 'basis') {
          return editor._basisInterpolate(cp0, cp1, cp2, cp3, t);
        }

        return {
          x: current.x + (next.x - current.x) * t,
          y: current.y + (next.y - current.y) * t,
          scale: (current.scale ?? 1) + ((next.scale ?? 1) - (current.scale ?? 1)) * t,
          rotation,
        };
      }
    }
    return { x: last.x, y: last.y, scale: last.scale ?? 1, rotation: resolveRotation(last) };
  };

  editor._applyBoxLayerPoint = (widget, normalizedPoint) => {
    if (!editor._isBoxLayerWidget(widget)) return;
    const activeWidget = editor.getActiveWidget();
    const point = normalizedPoint || editor._getBoxLayerStoredPoint(widget);
    const clampedX = typeof point.x === 'number' ? point.x : 0.5;
    const clampedY = typeof point.y === 'number' ? point.y : 0.5;
    const scale = editor.clampScaleValue(point.scale ?? 1);
    const rotation = (typeof point.rotation === 'number' && !Number.isNaN(point.rotation))
      ? point.rotation
      : (typeof point.boxRotation === 'number' && !Number.isNaN(point.boxRotation) ? point.boxRotation : 0);
    const payload = [{
      x: clampedX,
      y: clampedY,
      highlighted: false,
      boxScale: scale,
      pointScale: scale,
      scale,
      rotation,
      boxRotation: rotation,
    }];
    widget.value.points_store = JSON.stringify(payload);
    if (activeWidget === widget) {
      editor.points = editor.denormalizePoints(payload);
      editor.ensurePointScaleFields(editor.points);
      editor.ensurePointUids(editor.points);
      if (editor.vis) {
        editor.updatePath();
      }
    }
    try { editor.layerRenderer?.render(); } catch {}
    editor.node?.setDirtyCanvas?.(true, true);
  };

  editor._getBoxKeyScreenPoints = (widget) => {
    if (!editor._isBoxLayerWidget(widget)) return [];
    const keys = editor._ensureBoxLayerData(widget) || [];
    if (!keys.length) return [];
    const normPoints = keys.map(k => ({ x: k.x, y: k.y }));
    let denormPoints = [];
    try {
      denormPoints = editor.denormalizePoints(normPoints);
    } catch {
      return [];
    }
    return denormPoints.map((pt, index) => ({
      x: pt.x,
      y: pt.y,
      frame: keys[index]?.frame || 1,
    }));
  };

  editor._pickBoxKeyAtPosition = (widget, coords, tolerance = 12) => {
    if (!coords) return null;
    const keyPoints = editor._getBoxKeyScreenPoints(widget);
    if (!keyPoints.length) return null;
    const tol = Math.max(2, tolerance);
    const tolSq = tol * tol;
    let best = null;
    for (const point of keyPoints) {
      const dx = (coords.x - point.x);
      const dy = (coords.y - point.y);
      const distSq = dx * dx + dy * dy;
      if (distSq <= tolSq) {
        if (!best || distSq < best.distSq) {
          best = { frame: point.frame, distSq };
        }
      }
    }
    return best ? best.frame : null;
  };

  editor._handleBoxCanvasShortcut = (widget, coords) => {
    if (!editor._isBoxLayerWidget(widget)) return false;
    try { editor.node.layerManager?.setActiveWidget(widget); } catch {}
    if (coords) {
      const targetedFrame = editor._pickBoxKeyAtPosition(widget, coords, 14);
      if (targetedFrame) {
        editor.deleteBoxLayerKey(widget, targetedFrame);
        return true;
      }
    }
    const insideBox = coords ? editor.pickBoxPointFromCoords(coords) : null;
    if (!insideBox) return false;
    const frame = widget.value.box_timeline_point || 1;
    editor.addBoxLayerKey(widget, frame);
    return true;
  };

  editor.applyBoxTimelineFrame = (widget, frame) => {
    if (!editor._isBoxLayerWidget(widget)) return;
    const clampedFrame = Math.max(1, Math.min(editor._getMaxFrames(), Math.round(frame || 1)));
    widget.value.box_timeline_point = clampedFrame;
    if (editor._boxPreviewState && editor._boxPreviewState.widget === widget) {
      editor._boxPreviewState = null;
    }
    const targetPoint = editor._computeBoxLayerPosition(widget, clampedFrame);
    editor._applyBoxLayerPoint(widget, targetPoint);
  };

  editor.addBoxLayerKey = (widget, frame) => {
    if (!editor._isBoxLayerWidget(widget)) return false;
    const keys = editor._ensureBoxLayerData(widget) || [];
    const stored = editor._getBoxLayerStoredPoint(widget);
    const normalized = (() => {
      const width = Math.max(1, Number(editor.width) || 1);
      const height = Math.max(1, Number(editor.height) || 1);
      const rawX = (typeof stored?.x === 'number' && !Number.isNaN(stored.x)) ? stored.x : 0.5;
      const rawY = (typeof stored?.y === 'number' && !Number.isNaN(stored.y)) ? stored.y : 0.5;
      const normX = Math.abs(rawX) > 1 ? rawX / width : rawX;
      const normY = Math.abs(rawY) > 1 ? rawY / height : rawY;
      return {
        x: Math.max(0, Math.min(1, normX)),
        y: Math.max(0, Math.min(1, normY)),
        scale: editor.clampScaleValue(stored?.scale ?? 1),
        rotation: (typeof stored?.rotation === 'number' && !Number.isNaN(stored.rotation)) ? stored.rotation : 0,
      };
    })();
    const targetFrame = Math.max(1, Math.min(editor._getMaxFrames(), Math.round(frame || widget.value.box_timeline_point || 1)));
    const payload = {
      frame: targetFrame,
      x: normalized.x,
      y: normalized.y,
      scale: normalized.scale ?? 1,
      rotation: (typeof normalized.rotation === 'number' && !Number.isNaN(normalized.rotation)) ? normalized.rotation : 0,
    };
    const existingIndex = keys.findIndex(k => k.frame === targetFrame);
    if (existingIndex >= 0) {
      keys[existingIndex] = payload;
    } else {
      keys.push(payload);
    }
    keys.sort((a, b) => a.frame - b.frame);
    widget.value.box_keys = keys;
    editor.applyBoxTimelineFrame(widget, targetFrame);
    editor._forceRebuildNextRender = true;
    try { editor.layerRenderer?.render(); } catch {}
    try { editor.node?.setDirtyCanvas?.(true, true); } catch {}
    return true;
  };

  editor.deleteBoxLayerKey = (widget, frame) => {
    if (!editor._isBoxLayerWidget(widget)) return false;
    const keys = editor._ensureBoxLayerData(widget) || [];
    const targetFrame = Math.max(1, Math.min(editor._getMaxFrames(), Math.round(frame || widget.value.box_timeline_point || 1)));
    const idx = keys.findIndex(k => k.frame === targetFrame);
    if (idx === -1) return false;
    keys.splice(idx, 1);
    widget.value.box_keys = keys;
    editor.applyBoxTimelineFrame(widget, targetFrame);
    return true;
  };

  editor.clearBoxLayerKeys = (widget) => {
    if (!editor._isBoxLayerWidget(widget)) return false;
    widget.value.box_keys = [];
    editor.applyBoxTimelineFrame(widget, widget.value.box_timeline_point || 1);
    return true;
  };

  editor.setBoxTimelinePreview = (widget, frame) => {
    if (!editor._isBoxLayerWidget(widget)) return;
    const clampedFrame = Math.max(1, Math.min(editor._getMaxFrames(), Math.round(frame || 1)));
    const normalizedPoint = editor._computeBoxLayerPosition(widget, clampedFrame);
    const denorm = editor.denormalizePoints([{ x: normalizedPoint.x, y: normalizedPoint.y }]) || [];
    const actualPoint = denorm[0] || { x: 0, y: 0 };
    editor._boxPreviewState = {
      widget,
      frame: clampedFrame,
      normalized: normalizedPoint,
      x: actualPoint.x,
      y: actualPoint.y,
      rotation: (typeof normalizedPoint.rotation === 'number' && !Number.isNaN(normalizedPoint.rotation)) ? normalizedPoint.rotation : 0,
    };
    try { editor.layerRenderer?.render(); } catch {}
  };

  editor.clearBoxTimelinePreview = (widget = null) => {
    if (editor._boxPreviewState && (!widget || editor._boxPreviewState.widget === widget)) {
      editor._boxPreviewState = null;
      try { editor.layerRenderer?.render(); } catch {}
    }
  };

  editor._updateBoxKeyFromActivePoint = (widget, normalizedPoint) => {
    if (!editor._isBoxLayerWidget(widget)) return;
    const keys = editor._ensureBoxLayerData(widget) || [];
    const frame = Math.max(1, Math.min(editor._getMaxFrames(), Math.round(widget.value.box_timeline_point || 1)));
    const idx = keys.findIndex(k => k.frame === frame);
    if (idx >= 0) {
      keys[idx] = {
        frame,
        x: normalizedPoint.x,
        y: normalizedPoint.y,
        scale: normalizedPoint.scale ?? 1,
        rotation: (typeof normalizedPoint.rotation === 'number' && !Number.isNaN(normalizedPoint.rotation)) ? normalizedPoint.rotation : 0,
      };
    }
  };
}
