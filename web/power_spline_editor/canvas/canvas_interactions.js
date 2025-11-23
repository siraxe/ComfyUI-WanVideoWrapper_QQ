import { app } from '../../../../scripts/app.js';
import { BOX_BASE_RADIUS } from '../spline_utils.js';

export function attachInteractionHandlers(editor) {
  editor.isRotatingBoxHandle = false;
  editor.boxRotationIndex = -1;
  editor.getBoxPointRadius = (point) => {
    const boxScale = editor.getPointScaleForMode(point, true);
    return BOX_BASE_RADIUS * boxScale;
  };

  editor.pickBoxPointFromCoords = (coords) => {
    if (!coords || !Array.isArray(editor.points)) return null;
    let best = null;
    let bestDist = Infinity;
    for (let idx = 0; idx < editor.points.length; idx++) {
      const point = editor.points[idx];
      if (!point) continue;
      const dx = Math.abs(coords.x - (point.x ?? 0));
      const dy = Math.abs(coords.y - (point.y ?? 0));
      const maxDist = Math.max(dx, dy);
      const radius = editor.getBoxPointRadius(point);
      if (maxDist > radius) {
        continue;
      }
      if (
        maxDist < bestDist ||
        (Math.abs(maxDist - bestDist) < 1e-3 && radius < (best?.radius ?? Infinity))
      ) {
        bestDist = maxDist;
        best = { point, index: idx, radius };
      }
    }
    return best;
  };

  editor.resolvePointIndex = (dot) => {
    if (!Array.isArray(editor.points) || !dot) {
      return -1;
    }
    const dotUid = dot?.uid;
    if (dotUid !== undefined && dotUid !== null) {
      for (let idx = 0; idx < editor.points.length; idx++) {
        const p = editor.points[idx];
        if (p && (p.uid === dotUid)) {
          return idx;
        }
      }
    }
    const directIdx = editor.points.indexOf(dot);
    if (directIdx !== -1) {
      return directIdx;
    }
    let fallbackIdx = -1;
    let bestDist = Infinity;
    const dxDot = dot.x ?? 0;
    const dyDot = dot.y ?? 0;
    for (let idx = 0; idx < editor.points.length; idx++) {
      const p = editor.points[idx];
      if (!p) continue;
      const dx = (p.x ?? 0) - dxDot;
      const dy = (p.y ?? 0) - dyDot;
      const dist = dx * dx + dy * dy;
      if (dist <= 1e-4) {
        return idx;
      }
      if (dist < bestDist) {
        bestDist = dist;
        fallbackIdx = idx;
      }
    }
    return fallbackIdx;
  };

  editor._getPointerCoords = (event) => {
    const canvasEl = editor.vis?.canvas?.();
    if (!canvasEl || !event) {
      return { x: 0, y: 0 };
    }
    const e = (event.touches && event.touches.length > 0) ? event.touches[0] : event;
    const rect = canvasEl.getBoundingClientRect();
    const scale = app.canvas.ds.scale || 1;
    return {
      x: (e.clientX - rect.left) / scale,
      y: (e.clientY - rect.top) / scale
    };
  };

  editor._updateBoxRotationFromCoords = (coords) => {
    if (!editor.isRotatingBoxHandle || editor.boxRotationIndex < 0) {
      return;
    }
    if (!coords || !Array.isArray(editor.points)) {
      return;
    }
    const point = editor.points[editor.boxRotationIndex];
    if (!point) {
      return;
    }
    const dx = (coords.x ?? 0) - (point.x ?? 0);
    const dy = (coords.y ?? 0) - (point.y ?? 0);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      return;
    }
    if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) {
      return;
    }
    const angle = Math.atan2(dy, dx);
    const newRotation = angle + Math.PI / 2;

    // Calculate rotation delta to allow unlimited rotation (360+)
    // Store previous angle to detect when we cross the -π/π boundary
    if (editor._lastBoxRotationAngle !== undefined) {
      const prevAngle = editor._lastBoxRotationAngle;
      let delta = newRotation - prevAngle;

      // Detect wrapping across -π/π boundary
      if (delta > Math.PI) {
        delta -= 2 * Math.PI;
      } else if (delta < -Math.PI) {
        delta += 2 * Math.PI;
      }

      // Accumulate the delta
      const currentRotation = point.rotation || point.boxRotation || 0;
      point.rotation = currentRotation + delta;
      point.boxRotation = point.rotation;
    } else {
      // First update - set initial rotation
      point.rotation = newRotation;
      point.boxRotation = newRotation;
    }

    editor._lastBoxRotationAngle = newRotation;
    editor.layerRenderer?.render();
  };

  editor.startBoxRotationDrag = (pointRef, rawEvent) => {
    const index = typeof pointRef === 'number' ? pointRef : editor.resolvePointIndex(pointRef);
    if (!Array.isArray(editor.points) || index < 0 || !editor.points[index]) {
      return;
    }
    rawEvent?.preventDefault?.();
    rawEvent?.stopPropagation?.();
    editor.isDragging = true;
    editor.isRotatingBoxHandle = true;
    editor.boxRotationIndex = index;
    const usePointer = typeof PointerEvent !== 'undefined';
    const move = (evt) => {
      evt?.preventDefault?.();
      const coords = editor._getPointerCoords(evt);
      editor._updateBoxRotationFromCoords(coords);
    };
    const end = (evt) => {
      cleanup();
      editor.isRotatingBoxHandle = false;
      editor.boxRotationIndex = -1;
      editor._lastBoxRotationAngle = undefined; // Reset for next drag
      editor.dragEndHandler(evt);
    };
    const cleanup = () => {
      if (usePointer) {
        document.removeEventListener('pointermove', move, true);
        document.removeEventListener('pointerup', end, true);
        document.removeEventListener('pointercancel', end, true);
      } else {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', end, true);
      }
    };
    if (usePointer) {
      document.addEventListener('pointermove', move, true);
      document.addEventListener('pointerup', end, true);
      document.addEventListener('pointercancel', end, true);
    } else {
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', end, true);
    }
    const initialCoords = editor._getPointerCoords(rawEvent);
    editor._updateBoxRotationFromCoords(initialCoords);
  };

  editor.updateBoxCursor = (coords) => {
    const canvasEl = editor.vis?.canvas?.();
    if (!canvasEl) return;
    const activeInterp = editor.getActiveWidget()?.value?.interpolation || editor.interpolation;
    let desired = 'default';
    if (activeInterp === 'box' && coords) {
      const picked = editor.pickBoxPointFromCoords(coords);
      if (picked) {
        desired = 'move';
      }
    }
    if (canvasEl.style.cursor !== desired) {
      canvasEl.style.cursor = desired;
    }
  };

  editor.handleBoxKeyframePointerDown = (keyframeData, pvEvent) => {
    const event = pvEvent || window.event;
    if (!event) return;
    const { x, y } = editor._getPointerCoords(event);
    const widget = keyframeData.widget;

    if (!widget || !editor._isBoxLayerWidget(widget)) {
      console.warn("[SplineEditor] handleBoxKeyframePointerDown: invalid widget");
      return;
    }

    // Allow S + left click to delete keyframes even when drag handlers would run
    if (event.button === 0 && editor.isShortcutActive('s')) {
      if (editor._handleBoxCanvasShortcut(widget, { x, y })) {
        event.preventDefault?.();
        event.stopPropagation?.();
        return;
      }
    }

    // Store the keyframe being manipulated
    editor._manipulatingBoxKeyframe = {
      widget: widget,
      frame: keyframeData.frame,
      index: keyframeData.boxKeyIndex,
      originalKeys: JSON.parse(JSON.stringify(widget.value.box_keys || []))
    };

    event.preventDefault?.();
    event.stopPropagation?.();

    // Use a virtual point for drag handling
    const virtualPoint = {
      x: keyframeData.x,
      y: keyframeData.y,
      isBoxKeyframe: true,
      frame: keyframeData.frame
    };

    editor.dragStartHandler(virtualPoint, x, y, event);
    const dragTarget = virtualPoint;
    const needsTracking = editor.isDragging || editor.isDraggingAll || editor.isScalingAll || editor.isRotatingAll;
    if (!needsTracking) return;

    const usePointer = typeof PointerEvent !== 'undefined';
    const move = (evt) => {
      evt.preventDefault?.();
      const coords = editor._getPointerCoords(evt);
      editor.dragHandler(dragTarget, coords.x, coords.y);
    };
    const end = (evt) => {
      cleanup();
      editor.dragEndHandler(evt);
    };
    const cleanup = () => {
      if (usePointer) {
        document.removeEventListener('pointermove', move, true);
        document.removeEventListener('pointerup', end, true);
        document.removeEventListener('pointercancel', end, true);
      } else {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', end, true);
      }
    };
    if (usePointer) {
      document.addEventListener('pointermove', move, true);
      document.addEventListener('pointerup', end, true);
      document.addEventListener('pointercancel', end, true);
    } else {
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', end, true);
    }
  };

  editor.handlePointPointerDown = (dot, pvEvent) => {
    const event = pvEvent || window.event;
    if (!event) return;
    const { x, y } = editor._getPointerCoords(event);
    const activeWidget = editor.getActiveWidget();
    const activeInterp = activeWidget?.value?.interpolation || editor.interpolation;
    if (event.button === 0 && editor.isShortcutActive('s') && editor._isBoxLayerWidget(activeWidget)) {
      if (editor._handleBoxCanvasShortcut(activeWidget, { x, y })) {
        event.preventDefault?.();
        event.stopPropagation?.();
        return;
      }
    }
    let dragDot = dot;
    if (activeInterp === 'box') {
      const picked = editor.pickBoxPointFromCoords({ x, y });
      if (!picked) {
        return;
      }
      dragDot = picked.point;
    }
    event.preventDefault?.();
    event.stopPropagation?.();
    editor.dragStartHandler(dragDot, x, y, event);
    const dragTarget = dragDot;
    const needsTracking = editor.isDragging || editor.isDraggingAll || editor.isScalingAll || editor.isRotatingAll;
    if (!needsTracking) return;
    const usePointer = typeof PointerEvent !== 'undefined';
    const move = (evt) => {
      evt.preventDefault?.();
      const coords = editor._getPointerCoords(evt);
      editor.dragHandler(dragTarget, coords.x, coords.y);
    };
    const end = (evt) => {
      cleanup();
      editor.dragEndHandler(evt);
    };
    const cleanup = () => {
      if (usePointer) {
        document.removeEventListener('pointermove', move, true);
        document.removeEventListener('pointerup', end, true);
        document.removeEventListener('pointercancel', end, true);
      } else {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', end, true);
      }
    };
    if (usePointer) {
      document.addEventListener('pointermove', move, true);
      document.addEventListener('pointerup', end, true);
      document.addEventListener('pointercancel', end, true);
    } else {
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', end, true);
    }
  };

  editor.dragStartHandler = (d, mouseX, mouseY, rawEvent) => {
    const dot = d;

    // Handle box keyframe manipulation
    if (dot.isBoxKeyframe && editor._manipulatingBoxKeyframe) {
      const widget = editor._manipulatingBoxKeyframe.widget;
      const keys = widget.value.box_keys || [];

      // Convert box_keys to temporary points array for manipulation
      const keyframeNormPoints = keys.map(k => ({ x: k.x, y: k.y, scale: k.scale, rotation: k.rotation }));
      const keyframeDenormPoints = editor.denormalizePoints ? editor.denormalizePoints(keyframeNormPoints) : keyframeNormPoints;

      // Store as temporary points for manipulation
      editor._boxKeyframePoints = keyframeDenormPoints;
      editor.i = editor._manipulatingBoxKeyframe.index;
      editor.hoverIndex = editor.i;

      if (editor.i === -1 || !editor._boxKeyframePoints[editor.i]) {
        console.warn("[SplineEditor] dragStartHandler: unable to resolve box keyframe point", dot);
        return;
      }
    } else {
      editor.i = editor.resolvePointIndex(dot);
      editor.hoverIndex = editor.i;
      if (editor.i === -1 || !editor.points[editor.i]) {
        console.warn("[SplineEditor] dragStartHandler: unable to resolve point for drag", dot);
        return;
      }
    }

    let localX = mouseX;
    let localY = mouseY;
    if (typeof localX !== 'number' || typeof localY !== 'number') {
      const coords = editor._getPointerCoords(rawEvent || pv.event);
      localX = coords.x;
      localY = coords.y;
    }

    // Use appropriate points array
    const workingPoints = editor._boxKeyframePoints || editor.points;
    const pointX = workingPoints[editor.i].x;
    const pointY = workingPoints[editor.i].y;
    editor.dragOffset = { x: pointX - localX, y: pointY - localY };

    if ((rawEvent?.shiftKey) && (rawEvent?.button === 1)) {
      if (editor.i !== 0 && editor.i !== -1) {
        workingPoints[editor.i].highlighted = !workingPoints[editor.i].highlighted;
        editor.layerRenderer.render();
        if (!editor._boxKeyframePoints) {
          editor.updatePath();
        }
      }
      return;
    }

    if ((rawEvent?.altKey) && (rawEvent?.button === 0)) {
      editor.isRotatingAll = true;
      editor.originalPoints = workingPoints.map(p => ({ ...p }));
      editor.anchorPoint = { ...workingPoints[editor.i] };
      editor.anchorIndex = editor.i;
      editor.initialRotationAngle = Math.atan2(localY - editor.anchorPoint.y, localX - editor.anchorPoint.x);
      editor.isDragging = true;
      return;
    }

    if ((rawEvent?.altKey) && (rawEvent?.button === 1)) {
      editor.isDraggingAll = true;
      editor.dragStartPos = { x: localX, y: localY };
      editor.translateAllSnapshot = {
        points: workingPoints.map(p => ({ ...p })),
        pivotIndex: editor.i,
        pivotX: workingPoints[editor.i].x,
        pivotY: workingPoints[editor.i].y,
        offsetX: editor.dragOffset ? editor.dragOffset.x : 0,
        offsetY: editor.dragOffset ? editor.dragOffset.y : 0,
      };
      try { if (dot && typeof dot === 'object') { dot.fix = { x: 0, y: 0 }; } } catch {}
      editor.isDragging = true;
      return;
    }

    if ((rawEvent?.altKey) && (rawEvent?.button === 2)) {
      const activeInterp = editor.getActiveWidget()?.value?.interpolation || editor.interpolation;
      const isBoxMode = activeInterp === 'box';

      // For box keyframes: always scale all points (no individual scaling)
      // For box mode (current point): Ctrl+Alt+Right = scale whole curve, Alt+Right = scale individual point
      // For normal mode: Alt+Right = scale whole curve
      const isManipulatingKeyframes = !!editor._boxKeyframePoints;
      const shouldScaleAll = isManipulatingKeyframes || !isBoxMode || (rawEvent?.ctrlKey);

      if (isBoxMode && !shouldScaleAll && !isManipulatingKeyframes) {
        // Box mode: individual point scaling (original behavior)
        editor.isScalingPoint = true;
        editor.scalingPointIndex = editor.i;
        const targetPoint = editor.points[editor.i];
        if (!targetPoint) {
          editor.isScalingPoint = false;
          return;
        }
        editor.scalingPointBaseScale = (targetPoint.scale || 1.0);
        editor.scalingPointInitialDistance = localX - targetPoint.x;
        if (Math.abs(editor.scalingPointInitialDistance) < 10) {
          editor.scalingPointInitialDistance = editor.scalingPointInitialDistance >= 0 ? 10 : -10;
        }
        editor.isDragging = true;
        return;
      }

      // Scale whole curve (for both box keyframes, box layers with Ctrl, and normal layers)
      editor.isScalingAll = true;
      editor.originalPoints = workingPoints.map(p => ({ ...p }));
      editor.anchorPoint = { ...workingPoints[editor.i] };
      editor.anchorIndex = editor.i;
      editor.initialXDistance = localX - editor.anchorPoint.x;
      if (Math.abs(editor.initialXDistance) < 10) {
        editor.initialXDistance = editor.initialXDistance >= 0 ? 10 : -10;
      }
      editor.isDragging = true;
      return;
    }

    editor.isDragging = true;
    if ((rawEvent?.button === 2) && editor.i !== 0 && editor.i !== editor.points.length - 1) {
      editor.points.splice(editor.i--, 1);
      editor._forceRebuildNextRender = true;
      editor.layerRenderer.render();
    }
  };

  editor.dragEndHandler = () => {
    // For box keyframes, save the final state
    if (editor._boxKeyframePoints && editor._manipulatingBoxKeyframe) {
      editor._updateBoxKeysFromWorkingPoints();
      const widget = editor._manipulatingBoxKeyframe.widget;
      if (widget && editor.node) {
        editor.node.setDirtyCanvas?.(true, true);
      }
    }

    // For normal points
    if (editor.isScalingAll || editor.isRotatingAll) {
      if (!editor._boxKeyframePoints) {
        editor.setActivePoints(editor.points);
      }
    }

    if (editor.pathElements !== null && !editor._boxKeyframePoints) {
      editor.updatePath();
    }

    try { if (Array.isArray(editor.points)) { for (const p of editor.points) { if (p && p.fix !== undefined) delete p.fix; } } } catch {}

    // Clean up box keyframe state
    editor._boxKeyframePoints = null;
    editor._manipulatingBoxKeyframe = null;

    editor.translateAllSnapshot = null;
    editor.dragOffset = null;
    editor.isDragging = false;
    editor.isDraggingAll = false;
    editor.isScalingAll = false;
    editor.isScalingPoint = false;
    editor.scalingPointIndex = -1;
    editor.scalingPointBaseScale = 1.0;
    editor.scalingPointInitialDistance = 0;
    editor.isRotatingAll = false;
    editor.dragStartPos = null;
    editor.initialXDistance = 0;
    editor.initialRotationAngle = 0;
    editor.anchorPoint = null;
    editor.anchorIndex = -1;
    editor.originalPoints = null;
    editor.isRotatingBoxHandle = false;
    editor.boxRotationIndex = -1;
  };

  editor.dragHandler = (d, mouseX, mouseY) => {
    let adjustedX = (typeof mouseX === 'number') ? mouseX : (editor.vis.mouse().x / app.canvas.ds.scale);
    let adjustedY = (typeof mouseY === 'number') ? mouseY : (editor.vis.mouse().y / app.canvas.ds.scale);

    // Use appropriate points array
    const workingPoints = editor._boxKeyframePoints || editor.points;

    if (editor.isRotatingAll && editor.anchorPoint && editor.originalPoints) {
      const currentAngle = Math.atan2(adjustedY - editor.anchorPoint.y, adjustedX - editor.anchorPoint.x);
      const rotationAngle = currentAngle - editor.initialRotationAngle;
      const cos = Math.cos(rotationAngle);
      const sin = Math.sin(rotationAngle);

      for (let j = 0; j < editor.originalPoints.length; j++) {
        const originalPoint = editor.originalPoints[j];
        if (j === editor.anchorIndex) {
          workingPoints[j].x = editor.anchorPoint.x;
          workingPoints[j].y = editor.anchorPoint.y;
          workingPoints[j].highlighted = !!originalPoint.highlighted;
        } else {
          const translatedX = originalPoint.x - editor.anchorPoint.x;
          const translatedY = originalPoint.y - editor.anchorPoint.y;
          const rotatedX = translatedX * cos - translatedY * sin;
          const rotatedY = translatedX * sin + translatedY * cos;
          workingPoints[j].x = editor.anchorPoint.x + rotatedX;
          workingPoints[j].y = editor.anchorPoint.y + rotatedY;
          workingPoints[j].highlighted = !!originalPoint.highlighted;
        }
      }
      editor._updateBoxKeysFromWorkingPoints();
      editor.layerRenderer.render();
      return;
    }

    if (editor.isDraggingAll && editor.translateAllSnapshot) {
      const snap = editor.translateAllSnapshot;
      const deltaX = adjustedX - snap.pivotX;
      const deltaY = adjustedY - snap.pivotY;
      try { if (d && typeof d === 'object') { d.fix = { x: 0, y: 0 }; } } catch {}
      const basePoints = snap ? snap.points : workingPoints;
      for (let j = 0; j < workingPoints.length; j++) {
        const bp = basePoints[j] || workingPoints[j];
        workingPoints[j].x = bp.x + deltaX;
        workingPoints[j].y = bp.y + deltaY;
        workingPoints[j].highlighted = !!workingPoints[j].highlighted;
      }
      editor._updateBoxKeysFromWorkingPoints();
      editor.layerRenderer.render();
      return;
    }

    if (editor.isScalingPoint && editor.scalingPointIndex >= 0 && editor.scalingPointInitialDistance !== 0) {
      const point = editor.points[editor.scalingPointIndex];
      if (point) {
        const currentXDistance = adjustedX - point.x;
        const scaleFactor = currentXDistance / editor.scalingPointInitialDistance;
        const dampingFactor = 0.1;
        const dampedFactor = 1.0 + (scaleFactor - 1.0) * dampingFactor;
        const newScale = Math.max(0.2, Math.min(3.0, editor.scalingPointBaseScale * dampedFactor));
        point.boxScale = newScale;
        point.scale = newScale;
        // Force a full rebuild so box size updates immediately while dragging
        editor._forceRebuildNextRender = true;
        editor.layerRenderer.render();
      }
      return;
    }

    if (editor.isScalingAll && editor.anchorPoint && editor.originalPoints && editor.initialXDistance !== 0) {
      const currentXDistance = adjustedX - editor.anchorPoint.x;
      const scaleFactor = currentXDistance / editor.initialXDistance;
      const dampingFactor = 0.1;
      const dampedScaleFactor = 1.0 + (scaleFactor - 1.0) * dampingFactor;
      const clampedScaleFactor = Math.max(0.1, Math.min(10, dampedScaleFactor));

      for (let j = 0; j < editor.originalPoints.length; j++) {
        const originalPoint = editor.originalPoints[j];
        if (j === editor.anchorIndex) {
          workingPoints[j].x = editor.anchorPoint.x;
          workingPoints[j].y = editor.anchorPoint.y;
          workingPoints[j].highlighted = !!originalPoint.highlighted;
        } else {
          const vecX = originalPoint.x - editor.anchorPoint.x;
          const vecY = originalPoint.y - editor.anchorPoint.y;
          workingPoints[j].x = editor.anchorPoint.x + vecX * clampedScaleFactor;
          workingPoints[j].y = editor.anchorPoint.y + vecY * clampedScaleFactor;
          workingPoints[j].highlighted = !!originalPoint.highlighted;
        }
      }
      editor._updateBoxKeysFromWorkingPoints();
      editor.layerRenderer.render();
      return;
    }

    if (!editor.isDraggingAll && !editor.isScalingAll && !editor.isRotatingAll) {
      if (editor.dragOffset && editor.i >= 0 && workingPoints[editor.i]) {
        workingPoints[editor.i].x = adjustedX + editor.dragOffset.x;
        workingPoints[editor.i].y = adjustedY + editor.dragOffset.y;
        workingPoints[editor.i].highlighted = !!workingPoints[editor.i].highlighted;
      }
      editor._updateBoxKeysFromWorkingPoints();
      editor.layerRenderer.render();
    }
  };

  // Helper function to update box_keys from working points
  editor._updateBoxKeysFromWorkingPoints = () => {
    if (!editor._boxKeyframePoints || !editor._manipulatingBoxKeyframe) {
      return; // Not manipulating box keyframes
    }

    const widget = editor._manipulatingBoxKeyframe.widget;
    if (!widget || !editor._isBoxLayerWidget(widget)) {
      return;
    }

    // Normalize the working points back to 0-1 range
    const normalizedPoints = editor.normalizePoints ?
      editor.normalizePoints(editor._boxKeyframePoints) :
      editor._boxKeyframePoints;

    // Update box_keys with new positions
    const keys = widget.value.box_keys || [];
    for (let i = 0; i < normalizedPoints.length && i < keys.length; i++) {
      keys[i].x = normalizedPoints[i].x;
      keys[i].y = normalizedPoints[i].y;
      // Preserve scale and rotation
      if (normalizedPoints[i].scale !== undefined) {
        keys[i].scale = normalizedPoints[i].scale;
      }
      if (normalizedPoints[i].rotation !== undefined) {
        keys[i].rotation = normalizedPoints[i].rotation;
      }
    }

    widget.value.box_keys = keys;

    // If we're on the current frame, update the active point too
    const currentFrame = widget.value.box_timeline_point || 1;
    if (editor.applyBoxTimelineFrame) {
      editor.applyBoxTimelineFrame(widget, currentFrame);
    }
  };

  editor.mouseOverHandler = (d) => {
    editor.hoverIndex = editor.resolvePointIndex(d);
    // No need to re-render on hover if there's no visual feedback
  };

  editor.mouseOutHandler = () => {
    if (!editor.isDragging) {
      editor.hoverIndex = -1;
    }
    // No need to re-render on hover if there's no visual feedback
  };
}
