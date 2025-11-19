import { BOX_TIMELINE_MAX_POINTS } from './canvas_constants.js';

export function attachPathHelpers(editor) {
  // Ensure _getMaxFrames is available
  if (!editor._getMaxFrames) {
    editor._getMaxFrames = () => {
      return editor._maxFrames || BOX_TIMELINE_MAX_POINTS;
    };
  }

  editor.updateAllPaths = () => {
    const allWidgets = editor.node.layerManager.getSplineWidgets();
    const allSplineData = [];

    for (const widget of allWidgets) {
      if (!widget.value.on) continue;

      let widgetCoordinates;
      try {
        widgetCoordinates = JSON.parse(widget.value.points_store || '[]');
      } catch (e) {
        console.error(`Error parsing points_store for ${widget.value.name}:`, e);
        widgetCoordinates = [];
      }

      const isHanddraw = widget?.value?.type === 'handdraw';
      const isBoxLayer = widget?.value?.type === 'box_layer';
      const outInterpolation = isHanddraw ? 'linear' : (widget.value.interpolation || 'linear');

      const payload = {
        on: widget.value.on,
        name: widget.value.name,
        type: widget.value.type || (isHanddraw ? 'handdraw' : 'spline'),
        interpolation: outInterpolation,
        repeat: widget.value.repeat || 1,
        points_store: widget.value.points_store,
        coordinates: widgetCoordinates
      };
      if (isBoxLayer) {
        payload.box_keys = Array.isArray(widget.value.box_keys) ? widget.value.box_keys : [];
        payload.box_timeline_point = widget.value.box_timeline_point || 1;
      }
      allSplineData.push(payload);
    }

    if (editor.coordWidget) {
      editor.coordWidget.value = JSON.stringify(allSplineData);
    }
  };

  editor.updatePath = () => {
    if (!editor.points || editor.points.length === 0) {
      return;
    }

    if (!editor.vis) {
      console.warn("[SplineEditor] updatePath: vis not ready");
      return;
    }

    const activeWidget = editor.getActiveWidget();
    if (activeWidget) {
      activeWidget.value.points_store = JSON.stringify(editor.normalizePoints(editor.points));
    }

    editor.renderPreviousSplines();
    editor.layerRenderer.render();

    if (editor.pointsLayer) {
      editor.pointsLayer.data([]);
    }

    const allWidgets = editor.node.layerManager.getSplineWidgets();
    const onWidgets = allWidgets.filter(w => w.value.on);
    const allSplineData = [];

    let usePathSampling = false;
    let splinePaths = [];
    if (onWidgets.length > 0) {
      const pathElements = editor.vis.canvas().getElementsByTagName('path');
      const normalizeStroke = (stroke) => (stroke || '').replace(/\s+/g, '').toLowerCase();
      const filtered = [];
      for (const el of Array.from(pathElements)) {
        const stroke = normalizeStroke(el.getAttribute('stroke'));
        if (!stroke) continue;
        if (stroke.includes('255,255,255')) continue;
        if (stroke.includes('0,128,0')) continue;
        if (stroke.includes('255,127,14') && !stroke.includes('0.85')) continue;
        filtered.push({ stroke, element: el });
      }
      const expectedStrokes = onWidgets.map(widget => {
        if (widget?.value?.type === 'box_layer') {
          return ['#f04d3a', 'rgba(240,77,58,0.85)'];
        }
        if (widget?.value?.type === 'handdraw') {
          return ['#d7c400'];
        }
        return ['#1f77b4'];
      });
      splinePaths = [];
      let ptr = 0;
      for (const strokeGroup of expectedStrokes) {
        let found = null;
        while (ptr < filtered.length) {
          const candidate = filtered[ptr++];
          if (strokeGroup.some(stroke => candidate.stroke.includes(stroke.replace(/[^a-z0-9#.,]/gi, '')))) {
            found = candidate.element;
            break;
          }
        }
        if (found) splinePaths.push(found);
      }
      usePathSampling = splinePaths.length === onWidgets.length;
    }

    let pathIndex = 0;
    for (const widget of onWidgets) {
      const pathElement = usePathSampling ? splinePaths[pathIndex++] : null;
      let sampledCoords;

      const isBoxLayer = widget?.value?.type === 'box_layer';

      let controlPoints;
      const activeWidgetRef = editor.getActiveWidget();
      if (widget === activeWidgetRef) {
        controlPoints = editor.points;
      } else {
        try {
          controlPoints = editor.denormalizePoints(JSON.parse(widget.value.points_store || '[]'));
        } catch (e) {
          controlPoints = [];
        }
      }

      if (isBoxLayer) {
        sampledCoords = [];
        for (let frame = 1; frame <= editor._getMaxFrames(); frame++) {
          const target = editor._computeBoxLayerPosition(widget, frame) || {};
          const scaleVal = editor.clampScaleValue(target.scale ?? 1);
          const rotationVal = (typeof target.rotation === 'number' && !Number.isNaN(target.rotation)) ? target.rotation : 0;
          const normalizedPoint = {
            x: typeof target.x === 'number' ? target.x : 0.5,
            y: typeof target.y === 'number' ? target.y : 0.5,
            boxScale: scaleVal,
            pointScale: scaleVal,
            scale: scaleVal,
            rotation: rotationVal,
            boxRotation: rotationVal,
          };
          const denorm = editor.denormalizePoints([normalizedPoint]);
          const point = denorm && denorm[0] ? denorm[0] : { x: 0, y: 0 };
          sampledCoords.push({
            ...point,
            frame,
            boxScale: scaleVal,
            pointScale: scaleVal,
            scale: scaleVal,
            rotation: rotationVal,
            boxRotation: rotationVal,
          });
        }
      } else if (widget.value.interpolation === 'points' || widget.value.interpolation === 'box' || !usePathSampling) {
        sampledCoords = controlPoints;
      } else if (pathElement) {
        sampledCoords = [];
        const pathLength = pathElement.getTotalLength();
        if (pathLength > 0) {
          const numSamples = Math.max(100, controlPoints.length * 20);
          for (let j = 0; j < numSamples; j++) {
            const distance = (pathLength / (numSamples - 1)) * j;
            const point = pathElement.getPointAtLength(distance);
            sampledCoords.push(point);
          }
        } else {
          sampledCoords = controlPoints;
        }
      } else {
        sampledCoords = controlPoints;
      }

      const normalizedCoords = editor.normalizePoints(sampledCoords);

      const isHanddraw = widget?.value?.type === 'handdraw';
      const interp = widget.value.interpolation || 'linear';
      const outInterpolation = isHanddraw ? 'linear' : interp;
      const isDrivenOn = !!widget.value.driven;
      const driverName = widget.value._drivenConfig?.driver;
      let driver_offset_inherit = 0;
      if (isDrivenOn && driverName && driverName !== 'None') {
        const driverWidget = onWidgets.find(w => (w?.value?.name) === driverName)
          || allWidgets.find(w => (w?.value?.name) === driverName);
        if (driverWidget && driverWidget.value) {
          const dOff = Number(driverWidget.value.offset || 0) || 0;
          const dAPause = Number(driverWidget.value.a_pause || 0) || 0;
          const dZPause = Number(driverWidget.value.z_pause || 0) || 0;
          driver_offset_inherit = dOff + dAPause + dZPause;
        }
      }

      const payload = {
        on: widget.value.on,
        name: widget.value.name,
        interpolation: outInterpolation,
        type: widget.value.type || 'spline',
        repeat: widget.value.repeat || 1,
        offset: widget.value.offset || 0,
        a_pause: widget.value.a_pause || 0,
        z_pause: widget.value.z_pause || 0,
        driven: !!widget.value.driven,
        driver: driverName || "",
        driver_offset_inherit,
        easing: widget.value.easing || 'linear',
        easingConfig: JSON.parse(JSON.stringify(widget.value.easingConfig || { path: 'each', strength: 1.0 })),
        scale: typeof widget.value.scale === 'number' ? widget.value.scale : Number(widget.value.scale) || 1,
        points_store: widget.value.points_store,
        coordinates: normalizedCoords
      };

      if (isBoxLayer) {
        const normalizedKeys = Array.isArray(widget.value.box_keys)
          ? widget.value.box_keys.map(k => ({
            frame: Math.max(1, Math.min(editor._getMaxFrames(), Math.round(k.frame || 1))),
            x: typeof k.x === 'number' ? k.x : 0.5,
            y: typeof k.y === 'number' ? k.y : 0.5,
            scale: editor.clampScaleValue(k.scale ?? 1),
            rotation: (typeof k.rotation === 'number' && !Number.isNaN(k.rotation)) ? k.rotation : 0,
          }))
          : [];
        normalizedKeys.sort((a, b) => a.frame - b.frame);
        payload.box_keys = normalizedKeys;
        payload.box_timeline_point = widget.value.box_timeline_point || 1;
        payload.box_timeline_frames = editor._getMaxFrames();
      }

      allSplineData.push(payload);
    }

    if (editor.coordWidget) {
      const coordString = JSON.stringify(allSplineData);
      editor.coordWidget.value = coordString;
    } else {
      console.warn(`[updatePath] WARNING: coordWidget is null/undefined!`);
    }
  };
}
