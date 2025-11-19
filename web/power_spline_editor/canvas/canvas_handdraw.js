export function attachHanddrawHelpers(editor) {
  editor.enterHanddrawMode = (mode = 'create', widget = null) => {
    editor._handdrawMode = mode;
    editor._handdrawEditWidget = mode === 'edit' ? widget : null;
    editor._handdrawActive = true;
    editor._handdrawPath = [];

    if (editor._teardownHanddrawListeners) {
      try { editor._teardownHanddrawListeners(); } catch {}
      editor._teardownHanddrawListeners = null;
    }
    const canvasEl = editor.vis?.canvas?.();
    if ((mode === 'edit' || mode === 'create') && canvasEl) {
      const onMouseDown = (ev) => {
        if (ev && ev.button === 1) {
          ev.preventDefault?.(); ev.stopPropagation?.();
          try { editor.exitHanddrawMode(false); } catch {}
          try { editor.layerRenderer?.render(); } catch {}
          try { editor.node?.setDirtyCanvas?.(true, true); } catch {}
        }
      };
      canvasEl.addEventListener('mousedown', onMouseDown, true);
      editor._teardownHanddrawListeners = () => {
        canvasEl.removeEventListener('mousedown', onMouseDown, true);
      };
    }
  };

  editor.exitHanddrawMode = () => {
    editor._handdrawMode = 'off';
    editor._handdrawEditWidget = null;
    editor._handdrawActive = false;
    editor._handdrawPath = [];
    if (editor._teardownHanddrawListeners) {
      try { editor._teardownHanddrawListeners(); } catch {}
      editor._teardownHanddrawListeners = null;
    }
    try { editor.layerRenderer?.render(); } catch {}
  };

  editor.smoothActiveHanddraw = (tolerancePx, relaxStrength = 0.15, relaxIterations = 1) => {
    const activeWidget = editor.getActiveWidget?.();
    if (!activeWidget || activeWidget.value?.type !== 'handdraw') {
      return false;
    }

    let storedPoints = [];
    try {
      storedPoints = JSON.parse(activeWidget.value.points_store || '[]');
    } catch (e) {
      console.error("[SplineEditor] smoothActiveHanddraw: failed to parse points_store", e);
      return false;
    }
    if (!Array.isArray(storedPoints) || storedPoints.length < 3) {
      return false;
    }

    const tolerance = typeof tolerancePx === 'number' ? tolerancePx : 4;
    const simplified = [storedPoints[0]];
    let prev = storedPoints[0];
    const tol2 = tolerance * tolerance;
    for (let i = 1; i < storedPoints.length; i++) {
      const point = storedPoints[i];
      const dx = (point.x - prev.x);
      const dy = (point.y - prev.y);
      const dist2 = dx * dx + dy * dy;
      if (dist2 >= tol2 || i === storedPoints.length - 1) {
        simplified.push(point);
        prev = point;
      }
    }

    const relax = (points, strength) => {
      const relaxed = points.map(p => ({ ...p }));
      for (let iter = 0; iter < relaxIterations; iter++) {
        for (let i = 1; i < relaxed.length - 1; i++) {
          relaxed[i].x = relaxed[i].x + (points[i - 1].x + points[i + 1].x - 2 * relaxed[i].x) * strength;
          relaxed[i].y = relaxed[i].y + (points[i - 1].y + points[i + 1].y - 2 * relaxed[i].y) * strength;
        }
      }
      return relaxed;
    };

    const relaxedPoints = relax(simplified, relaxStrength);
    activeWidget.value.points_store = JSON.stringify(relaxedPoints);
    if (editor.getActiveWidget() === activeWidget) {
      editor.points = editor.denormalizePoints(relaxedPoints);
      editor.updatePath();
      editor.layerRenderer.render();
    }
    return true;
  };
}
