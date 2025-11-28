export function attachStateHelpers(editor) {
  editor.getActiveWidget = () => {
    const widget = editor.node.layerManager.getActiveWidget();
    return widget;
  };

  editor.getActivePoints = () => {
    const activeWidget = editor.getActiveWidget();
    if (!activeWidget) {
      return [];
    }
    try {
      const points = JSON.parse(activeWidget.value.points_store || '[]');
      const denorm = editor.denormalizePoints(points);
      editor.ensurePointScaleFields(denorm);
      editor.ensurePointUids(denorm);
      return denorm.map(point => ({
        ...point,
        scale: (typeof point.scale === 'number' ? point.scale : 1.0),
        uid: point.uid
      }));
    } catch (e) {
      console.error("[SplineEditor] getActivePoints: failed to parse points_store", e);
      return [];
    }
  };

  editor.setActivePoints = (points) => {
    const activeWidget = editor.getActiveWidget();
    if (!activeWidget) {
      console.warn("[SplineEditor] setActivePoints: no active widget");
      return;
    }
    if (editor._isBoxLayerWidget(activeWidget)) {
      let coercedPoints = Array.isArray(points) ? points.slice(0, 1) : [];
      if (!coercedPoints.length) {
        const defaultPoint = {
          x: editor.width * 0.5,
          y: editor.height * 0.5,
          boxScale: 1,
          pointScale: 1,
          scale: 1,
          highlighted: false,
          rotation: 0,
        };
        coercedPoints = [defaultPoint];
      }
      editor.ensurePointScaleFields(coercedPoints);
      editor.ensurePointUids(coercedPoints);
      editor.points = coercedPoints;
      const normalized = editor.normalizePoints(coercedPoints);
      activeWidget.value.points_store = JSON.stringify(normalized);
      const normalizedPoint = {
        x: normalized[0].x ?? 0.5,
        y: normalized[0].y ?? 0.5,
        scale: editor.clampScaleValue(normalized[0].boxScale ?? normalized[0].scale ?? 1),
        rotation: (typeof normalized[0].boxRotation === 'number' && !Number.isNaN(normalized[0].boxRotation))
          ? normalized[0].boxRotation
          : ((typeof normalized[0].rotation === 'number' && !Number.isNaN(normalized[0].rotation)) ? normalized[0].rotation : 0),
      };
      editor._updateBoxKeyFromActivePoint(activeWidget, normalizedPoint);
      if (editor.vis) {
        editor.updatePath();
        try { editor.layerRenderer?.render(); } catch {}
      }
      return;
    }
    const safePoints = Array.isArray(points) ? points.slice() : [];
    editor.ensurePointUids(safePoints);
    activeWidget.value.points_store = JSON.stringify(editor.normalizePoints(safePoints));
    if (editor.vis) {
      editor.updatePath();
    }
  };

  editor.isShortcutActive = (key) => {
    if (!key) return false;
    const normalized = String(key).toLowerCase();
    const lastKeyDownTime = editor._shortcutKeys && editor._shortcutKeys[normalized];

    if (lastKeyDownTime === undefined || lastKeyDownTime === 0) {
      return false; // Key is not currently pressed or hasn't been pressed
    }
    // Consider key active if it was pressed recently (e.g., within a small time window)
    // to account for race conditions between keydown and mousedown events.
    const currentTime = performance.now();
    const latencyThreshold = 500; // milliseconds - increased to account for longer delays
    return (currentTime - lastKeyDownTime < latencyThreshold);
  };

  editor.ensurePointUids = (points) => {
    if (!Array.isArray(points)) return;
    let nextUid = editor.nextPointUid || 1;
    for (const point of points) {
      if (!point) continue;
      const rawUid = Number(point.uid);
      const hasUid = (point.uid !== undefined && point.uid !== null && !Number.isNaN(rawUid));
      if (hasUid) {
        const candidate = Math.max(nextUid, rawUid + 1);
        nextUid = candidate;
      } else {
        point.uid = nextUid;
        nextUid += 1;
      }
    }
    editor.nextPointUid = nextUid;
  };

  editor.clampScaleValue = (value) => {
    if (typeof value !== 'number' || Number.isNaN(value)) return 1;
    return Math.max(0.2, Math.min(3.0, value));
  };

  editor.ensurePointScaleFields = (points) => {
    if (!Array.isArray(points)) return;
    for (const point of points) {
      if (!point) continue;
      const boxRaw = (typeof point.boxScale === 'number' && !Number.isNaN(point.boxScale))
        ? point.boxScale
        : ((typeof point.scale === 'number' && !Number.isNaN(point.scale)) ? point.scale : 1);
      point.boxScale = editor.clampScaleValue(boxRaw);

      const pointRaw = (typeof point.pointScale === 'number' && !Number.isNaN(point.pointScale))
        ? point.pointScale
        : 1;
      point.pointScale = editor.clampScaleValue(pointRaw);

      if (typeof point.scale !== 'number' || Number.isNaN(point.scale)) {
        point.scale = point.boxScale;
      } else {
        point.scale = editor.clampScaleValue(point.scale);
      }
      const rotationRaw = (typeof point.boxRotation === 'number' && !Number.isNaN(point.boxRotation))
        ? point.boxRotation
        : ((typeof point.rotation === 'number' && !Number.isNaN(point.rotation)) ? point.rotation : 0);
      point.boxRotation = rotationRaw;
      point.rotation = rotationRaw;
    }
  };

  editor.getPointScaleForMode = (point, forBox = true) => {
    if (!point) return 1;
    const candidate = (() => {
      if (forBox && typeof point.boxScale === 'number' && !Number.isNaN(point.boxScale)) {
        return point.boxScale;
      }
      if (!forBox && typeof point.pointScale === 'number' && !Number.isNaN(point.pointScale)) {
        return point.pointScale;
      }
      if (typeof point.scale === 'number' && !Number.isNaN(point.scale)) {
        return point.scale;
      }
      return 1;
    })();
    return editor.clampScaleValue(candidate);
  };

  editor.normalizePoints = function normalizePoints(points) {
    const mediaWidth = this.originalImageWidth || this.videoMetadata?.width || this.width;
    const mediaHeight = this.originalImageHeight || this.videoMetadata?.height || this.height;

    return points.map(p => {
      const { x, y } = p; // These are media space points
      const nx = x / mediaWidth;
      const ny = y / mediaHeight;
      return { ...p, x: nx, y: ny };
    });
  };

  editor.denormalizePoints = function denormalizePoints(points) {
    const mediaWidth = this.originalImageWidth || this.videoMetadata?.width || this.width;
    const mediaHeight = this.originalImageHeight || this.videoMetadata?.height || this.height;

    // Assume stored points are always normalized.
    return points.map(p => {
      const { x: nx, y: ny } = p; // These are normalized points
      const x = nx * mediaWidth;
      const y = ny * mediaHeight;
      return { ...p, x, y };
    });
  };
}
