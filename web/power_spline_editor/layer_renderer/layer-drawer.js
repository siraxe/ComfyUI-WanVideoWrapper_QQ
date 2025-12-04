/**
 * Layer Drawer Module
 *
 * Orchestrates layer rendering for all layer types (normal, handdraw, box) and states (active, inactive).
 * This is the largest module handling the complexity of drawing different layer types.
 *
 * This module handles:
 * - Active layer rendering (drawActiveLayer)
 * - Inactive layer rendering (drawInactiveLayer)
 * - Box layer visualizations and keyframe paths
 * - Line and dot rendering for all layer types
 * - Preview states and rotation handles
 */

import { BOX_BASE_RADIUS, POINT_BASE_RADIUS, transformVideoToCanvasSpace } from '../spline_utils.js';
import { BOX_TIMELINE_MAX_POINTS } from '../canvas/canvas_constants.js';

/**
 * Draws the active layer with lines, dots, and box-specific visualizations
 *
 * @param {Object} context - The LayerRenderer instance (this)
 * @param {Object} widget - The widget representing the layer
 */
export function drawActiveLayer(context, widget) {
    const points = Array.isArray(context.splineEditor.points) ? context.splineEditor.points : [];
    const hasPoints = points.length > 0;
    const layerType = context._getLayerType(widget);
    const isBoxLayer = layerType === 'box';
    const safePoints = hasPoints
        ? points.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))
        : [];

    // For non-box layers, we need points to render anything
    if (!safePoints.length && !isBoxLayer) return;

    // Strictly determine interpolation based on widget type to prevent bleeding
    const interpolation = isBoxLayer
        ? (widget.value.interpolation || 'linear')
        : context._normalizeInterpolation(widget.value.interpolation, layerType);

    const isPointMode = layerType === 'box' ? true : interpolation === 'points';
    const styles = context._getLayerStyles(layerType, 'active', isPointMode);

    // Draw lines and dots for regular spline layers (not box layers)
    if (hasPoints && !isBoxLayer) {
        drawActiveLine(context, interpolation, isPointMode, layerType, styles);
        drawActiveDots(context, interpolation, isPointMode, layerType, styles, points);
    }

    if (isBoxLayer) {
        // First: Draw the current interpolated box visualization
        // We pass the widget, but we WON'T pass safePoints anymore.
        // The function will fetch them fresh.
        drawCurrentBoxVisualization(context, widget);

        // Second: Draw the box layer keyframe timeline visualization (red dots and connecting lines)
        drawBoxKeyPath(context, context.activeLayerPanel, widget, true);

        // Third: Get the actual keyframe points from box_keys for rotation handles and green center dots
        const sortedKeys = context.splineEditor._ensureBoxLayerData(widget);
        if (sortedKeys.length > 0) {
            const keyframeNormPoints = sortedKeys.map(k => ({ x: k.x, y: k.y }));
            const keyframeDenormPoints = safeDenormalizePoints(context, keyframeNormPoints);

            if (keyframeDenormPoints && keyframeDenormPoints.length > 0) {
                const validKeyframePoints = keyframeDenormPoints.filter(p =>
                    p && Number.isFinite(p.x) && Number.isFinite(p.y)
                );

                if (validKeyframePoints.length > 0) {
                    // Temporarily removed rotation handles for all keyframes to avoid visual duplication
                    // with orange keyframe indicators. Will be added back with hover-based display.
                    // drawBoxRotationHandles(context, context.activeLayerPanel, validKeyframePoints, sortedKeys);
                    // Note: Removed duplicate green center dots as they conflict with orange keyframe indicators
                }
            }
        }

        // Fourth: Draw the preview hover state
        drawBoxPreview(context, widget);
    }
}

/**
 * Draws the current (active frame) box visualization with squares, rotation handles, and reference images
 *
 * @param {Object} context - The LayerRenderer instance (this)
 * @param {Object} widget - The widget representing the box layer
 */
export function drawCurrentBoxVisualization(context, widget) {
    const styles = context._getLayerStyles('box', 'active', true, false);

    // HELPER: Fetch fresh points directly from the source
    const getFreshBoxPoints = () => {
        const rawPoints = context.splineEditor.points || [];
        return rawPoints.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    };

    const pts = getFreshBoxPoints();
    const sortedPoints = [...pts].sort((a, b) =>
        context.splineEditor.getBoxPointRadius(b) - context.splineEditor.getBoxPointRadius(a)
    );

    // 1. Queue the GREEN SQUARES
    const attachment = context._getSelectedRefAttachment(widget);

    // During preview mode (_boxRefOnlyMode), don't render green boxes or rotation controls
    if (!context._boxRefOnlyMode) {
        sortedPoints.forEach((dot, index) => {
            const radius = context.getScaledBoxRadius(dot);
            const rotation = context._getBoxRotationValue(dot);

            const svgStyles = {
                radius: radius,
                stroke: styles.pointStroke || "#139613",
                strokeWidth: styles.lineWidth || 2,
                fill: styles.pointFill || "rgba(19, 150, 19, 0.1)",
                cursor: "default"
            };

            const element = context._createSVGPath('square', dot, svgStyles, rotation);
            if (element) {
                // Add event handlers
                element.addEventListener('mousedown', (e) => {
                    if (context.splineEditor.handlePointPointerDown) {
                        context.splineEditor.handlePointPointerDown(dot, e);
                    }
                });
                element.addEventListener('mouseover', (e) => {
                    if (context.splineEditor.mouseOverHandler) {
                        context.splineEditor.mouseOverHandler.call(dot);
                    }
                });
                element.addEventListener('mouseout', (e) => {
                    if (context.splineEditor.mouseOutHandler) {
                        context.splineEditor.mouseOutHandler.call(dot);
                    }
                });
                // Queue for rendering after vis.render()
                context._pendingShapes.activeBoxDots.push(element);
            }

            // Add rotation text display (green with 60% opacity) - only for first box
            if (index === 0) {
                const rotationRad = context._getBoxRotationValue(dot);
                const rotationDeg = rotationRad * (180 / Math.PI);

                // Create a group to hold the text so we can position it correctly
                const textGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                textGroup.setAttribute('data-rotation-text', 'true');

                const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                // Position at top-left corner of the box (relative to box center)
                const offsetX = -radius;
                const offsetY = -radius - 5;
                text.setAttribute('x', offsetX);
                text.setAttribute('y', offsetY);
                text.setAttribute('fill', 'rgba(19, 150, 19, 0.6)'); // Green with 60% opacity
                text.setAttribute('font-size', '14');
                text.setAttribute('font-family', 'monospace');
                text.setAttribute('font-weight', 'bold');
                text.setAttribute('text-anchor', 'start');
                text.setAttribute('pointer-events', 'none');
                text.style.userSelect = 'none';
                text.textContent = `${rotationDeg.toFixed(1)}°`;

                textGroup.appendChild(text);
                const transformedPoint = transformVideoToCanvasSpace(context.splineEditor, dot.x, dot.y);

                textGroup.setAttribute('transform', `translate(${transformedPoint.x},${transformedPoint.y})`);
                textGroup.style.pointerEvents = 'none';

                context._pendingShapes.activeBoxDots.push(textGroup);
            }
        });

        // Draw rotation handle and center dot when not in ref-only mode
        drawCurrentBoxRotationHandle(context, () => {
            const pts = getFreshBoxPoints();
            return pts.length > 0 ? pts[0] : null;
        }, styles);

        drawCurrentBoxCenterDot(context, () => {
            const pts = getFreshBoxPoints();
            return pts.length > 0 ? pts[0] : null;
        }, styles);
    }

    // Queue attached reference image (fit inside box, preserve aspect)
    // Get fresh points to ensure image follows box during dragging/rotation
    const freshPoints = getFreshBoxPoints();
    const freshSortedPoints = [...freshPoints].sort((a, b) =>
        context.splineEditor.getBoxPointRadius(b) - context.splineEditor.getBoxPointRadius(a)
    );

    if (attachment && (attachment.base64 || attachment.path) && freshSortedPoints.length > 0) {
        const point = freshSortedPoints[0];
        const boxRadius = context.getScaledBoxRadius(point);
        const boxSize = boxRadius * 2;
        const imgW = Math.max(1, attachment.width || boxSize);
        const imgH = Math.max(1, attachment.height || boxSize);
        const scale = Math.min(boxSize / imgW, boxSize / imgH);
        const renderW = imgW * scale;
        const renderH = imgH * scale;
        const rotationDeg = context._getBoxRotationValue(point) * (180 / Math.PI);

        const image = document.createElementNS('http://www.w3.org/2000/svg', 'image');
        // Use cached URL to prevent blinking during timeline scrub
        const imageHref = context._getRefImageUrl(widget, attachment);
        if (!imageHref) return; // Skip if no valid image source

        // Force image reload by setting href to empty first, then to actual URL
        // This prevents browser from using stale cached image data
        image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '');
        image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', imageHref);

        image.setAttribute('width', renderW);
        image.setAttribute('height', renderH);
        image.setAttribute('x', -renderW / 2);
        image.setAttribute('y', -renderH / 2);
        image.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        const transformedPoint = transformVideoToCanvasSpace(context.splineEditor, point.x, point.y);

        image.setAttribute('transform', `translate(${transformedPoint.x},${transformedPoint.y}) rotate(${rotationDeg})`);
        image.style.pointerEvents = 'none';
        image.style.opacity = '0.9';
        // Store cache bust version to track if image needs updating
        image.dataset.cacheBustVersion = context._cacheBustCounter;

        context._pendingShapes.activeBoxImages.push(image);
    }
}

/**
 * Draws the rotation handle (stem and tip circle) for the active box
 *
 * @param {Object} context - The LayerRenderer instance (this)
 * @param {Function} pointGetter - Function that returns the current point
 * @param {Object} styles - Style configuration object
 */
export function drawCurrentBoxRotationHandle(context, pointGetter, styles = {}) {
    // 1. Draw handle line (Stem)
    context.activeLayerPanel.add(pv.Line)
        .data(() => {
            // Only render if current layer is still a box layer
            const activeWidget = context.node.layerManager.getActiveWidget();
            if (context._getLayerType(activeWidget) !== 'box') return [];

            const point = pointGetter(); // <--- Dynamic lookup
            const geom = context._computeBoxHandleGeometry(point);
            return geom ? [geom.base, geom.tip] : [];
        })
        .left(d => transformVideoToCanvasSpace(context.splineEditor, d.x, d.y).x)
        .top(d => transformVideoToCanvasSpace(context.splineEditor, d.x, d.y).y)

    // 2. Draw handle tip (Circle)
    context.activeLayerPanel.add(pv.Dot)
        .data(() => {
            // Only render if current layer is still a box layer
            const activeWidget = context.node.layerManager.getActiveWidget();
            if (context._getLayerType(activeWidget) !== 'box') return [];

            const point = pointGetter(); // <--- Dynamic lookup
            const geom = context._computeBoxHandleGeometry(point);
            return geom ? [{ point, tip: geom.tip }] : [];
        })
        .left(d => transformVideoToCanvasSpace(context.splineEditor, d.tip.x, d.tip.y).x)
        .top(d => transformVideoToCanvasSpace(context.splineEditor, d.tip.x, d.tip.y).y)
        .shape('circle')
        .radius(5)
        .fillStyle(styles.pointFill || 'rgba(45, 242, 109, 0.9)')
        .strokeStyle(styles.pointStroke || '#064f1c')
        .lineWidth(1.5)
        .cursor('grab')
        .event("mousedown", (d) => {
            const idx = context.splineEditor.resolvePointIndex?.(d.point) ?? context.splineEditor.points.indexOf(d.point);
            if (idx >= 0 && context.splineEditor.startBoxRotationDrag) {
                context.splineEditor.startBoxRotationDrag(idx, pv.event);
            }
        });
}

/**
 * Draws the center dot for the active box
 *
 * @param {Object} context - The LayerRenderer instance (this)
 * @param {Function} pointGetter - Function that returns the current point
 * @param {Object} styles - Style configuration object
 */
export function drawCurrentBoxCenterDot(context, pointGetter, styles = {}) {
    context.activeLayerPanel.add(pv.Dot)
        .data(() => {
            // Only render if current layer is still a box layer
            const activeWidget = context.node.layerManager.getActiveWidget();
            if (context._getLayerType(activeWidget) !== 'box') return [];

            const point = pointGetter(); // <--- Dynamic lookup
            return point ? [point] : [];
        })
        .left(d => transformVideoToCanvasSpace(context.splineEditor, d.x, d.y).x)
        .top(d => transformVideoToCanvasSpace(context.splineEditor, d.x, d.y).y)
        .radius(3)
        .fillStyle(styles.pointFill || '#2df26d')
        .strokeStyle(styles.pointStroke || '#064f1c')
        .lineWidth(1)
        .events('none');
}

/**
 * Queues a box manipulator for rendering at the current timeline point
 *
 * @param {Object} context - The LayerRenderer instance (this)
 * @param {Object} widget - The widget representing the box layer
 */
export function queueBoxManipulator(context, widget) {
    if (!widget || widget?.value?.type !== 'box_layer') return;
    const editor = context.splineEditor;
    const maxFrames = editor?._getMaxFrames ? editor._getMaxFrames() : BOX_TIMELINE_MAX_POINTS;
    const frame = Math.max(1, Math.min(maxFrames, Math.round(widget.value?.box_timeline_point || 1)));
    const normalized = editor?._computeBoxLayerPosition
        ? editor._computeBoxLayerPosition(widget, frame)
        : { x: 0.5, y: 0.5, scale: 1, rotation: 0 };
    const denorm = editor?.denormalizePoints
        ? editor.denormalizePoints([{ x: normalized.x ?? 0.5, y: normalized.y ?? 0.5 }])
        : [{ x: 0, y: 0 }];
    const point = denorm[0] || { x: 0, y: 0 };
    point.boxScale = context.clampPointScale(normalized.scale ?? 1);
    point.scale = point.boxScale;
    point.boxRotation = (typeof normalized.rotation === 'number' && !Number.isNaN(normalized.rotation)) ? normalized.rotation : 0;

    const styles = context._getLayerStyles('box', 'active', true, false);
    const radius = context.getScaledBoxRadius(point);
    const svgStyles = {
        radius,
        stroke: styles.pointStroke || "#139613",
        strokeWidth: styles.lineWidth || 2,
        fill: styles.pointFill || "rgba(19, 150, 19, 0.1)",
        cursor: "default"
    };
    const attachment = context._getSelectedRefAttachment(widget);

    // During preview mode (_boxRefOnlyMode), don't render green boxes or rotation text
    if (!context._boxRefOnlyMode) {
        const element = context._createSVGPath('square', point, svgStyles, context._getBoxRotationValue(point));
        if (element) {
            element.style.pointerEvents = 'none';
            context._pendingShapes.activeBoxDots.push(element);
        }

        // Add rotation text display (green with 60% opacity)
        const rotationRad = context._getBoxRotationValue(point);
        const rotationDeg = rotationRad * (180 / Math.PI);

        // Create a group to hold the text so we can position it correctly
        const textGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        textGroup.setAttribute('data-rotation-text', 'true');

        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        // Position at top-left corner of the box (relative to box center)
        const offsetX = -radius;
        const offsetY = -radius - 5;
        text.setAttribute('x', offsetX);
        text.setAttribute('y', offsetY);
        text.setAttribute('fill', 'rgba(19, 150, 19, 0.6)'); // Green with 60% opacity
        text.setAttribute('font-size', '14');
        text.setAttribute('font-family', 'monospace');
        text.setAttribute('font-weight', 'bold');
        text.setAttribute('text-anchor', 'start');
        text.setAttribute('pointer-events', 'none');
        text.style.userSelect = 'none';
        text.textContent = `${rotationDeg.toFixed(1)}°`;

        textGroup.appendChild(text);
        const transformedPoint = transformVideoToCanvasSpace(context.splineEditor, point.x, point.y);

        textGroup.setAttribute('transform', `translate(${transformedPoint.x},${transformedPoint.y})`);
        textGroup.style.pointerEvents = 'none';

        context._pendingShapes.activeBoxDots.push(textGroup);
    }

    // Render attached reference image if it exists
    if (attachment && (attachment.base64 || attachment.path)) {
        const boxSize = radius * 2;
        const imgW = Math.max(1, attachment.width || boxSize);
        const imgH = Math.max(1, attachment.height || boxSize);
        const scale = Math.min(boxSize / imgW, boxSize / imgH);
        const renderW = imgW * scale;
        const renderH = imgH * scale;
        const rotationDeg = context._getBoxRotationValue(point) * (180 / Math.PI);

        const image = document.createElementNS('http://www.w3.org/2000/svg', 'image');
        // Use cached URL to prevent blinking during timeline scrub
        const imageHref = context._getRefImageUrl(widget, attachment);
        if (!imageHref) return; // Skip if no valid image source

        // Force image reload by setting href to empty first, then to actual URL
        // This prevents browser from using stale cached image data
        image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '');
        image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', imageHref);

        image.setAttribute('width', renderW);
        image.setAttribute('height', renderH);
        image.setAttribute('x', -renderW / 2);
        image.setAttribute('y', -renderH / 2);
        image.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        const transformedPoint = transformVideoToCanvasSpace(context.splineEditor, point.x, point.y);

        image.setAttribute('transform', `translate(${transformedPoint.x},${transformedPoint.y}) rotate(${rotationDeg})`);
        image.style.pointerEvents = 'none';
        image.style.opacity = '0.9';
        // Store cache bust version to track if image needs updating
        image.dataset.cacheBustVersion = context._cacheBustCounter;

        context._pendingShapes.activeBoxImages.push(image);
    }
}

/**
 * Draws the line connecting active layer points
 *
 * @param {Object} context - The LayerRenderer instance (this)
 * @param {string} interpolation - Interpolation mode (linear, cardinal, basis, points)
 * @param {boolean} isPointMode - Whether in point mode
 * @param {string} layerType - Type of layer (normal, handdraw, box)
 * @param {Object} styles - Style configuration object
 */
export function drawActiveLine(context, interpolation, isPointMode, layerType, styles) {
    if (layerType === 'box') return; // Box layers render via box helpers only
    // We ignore the passed 'safePoints' and fetch fresh ones inside .data()
    context.activeLayerPanel.add(pv.Line)
        .data(() => {
            const currentPoints = context.splineEditor.points || [];
            const validPoints = currentPoints.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));

            // If we don't have points, or if this is actually a box layer
            // (but the renderer got confused), return empty to hide the line.
            const activeWidget = context.node.layerManager.getActiveWidget();
            const activeType = context._getLayerType(activeWidget);
            if (activeType === 'box') return [];

            return prepareLineData(validPoints, interpolation, isPointMode);
        })
        .left(d => transformVideoToCanvasSpace(context.splineEditor, d.x, d.y).x)
        .top(d => transformVideoToCanvasSpace(context.splineEditor, d.x, d.y).y)
        .interpolate(() => isPointMode ? 'linear' : interpolation)
        .strokeStyle(() => styles.lineStroke)
        .lineWidth(() => styles.lineWidth);
}

/**
 * Prepares line data by inserting helper points around highlighted points for linear segments
 *
 * @param {Array} safePoints - Array of valid points
 * @param {string} interpolation - Interpolation mode
 * @param {boolean} isPointMode - Whether in point mode
 * @returns {Array} Prepared points for line rendering
 */
export function prepareLineData(safePoints, interpolation, isPointMode) {
    if (isPointMode || interpolation === 'linear') return safePoints;

    const hasHighlighted = safePoints.some(p => p.highlighted);
    if (!hasHighlighted) return safePoints;

    // Insert helper points around highlighted points for linear segments
    const result = [];
    for (let i = 0; i < safePoints.length; i++) {
        const point = safePoints[i];

        if (point.highlighted) {
            if (i > 0) {
                const prev = safePoints[i - 1];
                const dx = point.x - prev.x, dy = point.y - prev.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const offset = Math.min(0.01, 1 / dist);
                result.push({ x: prev.x + dx * (1 - offset), y: prev.y + dy * (1 - offset) });
            }

            result.push(point);

            if (i < safePoints.length - 1) {
                const next = safePoints[i + 1];
                const dx = next.x - point.x, dy = next.y - point.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const offset = Math.min(0.01, 1 / dist);
                result.push({ x: point.x + dx * offset, y: point.y + dy * offset });
            }
        } else {
            result.push(point);
        }
    }
    return result;
}

/**
 * Draws dots (circles, triangles, squares) for active layer points
 *
 * @param {Object} context - The LayerRenderer instance (this)
 * @param {string} interpolation - Interpolation mode
 * @param {boolean} isPointMode - Whether in point mode
 * @param {string} layerType - Type of layer
 * @param {Object} styles - Style configuration object
 * @param {Array} allPoints - All points in the layer
 */
export function drawActiveDots(context, interpolation, isPointMode, layerType, styles, allPoints) {
    if (layerType === 'box') return; // Box layers use box-specific drawing

    // Get current points
    const currentPoints = context.splineEditor.points || [];
    const validPoints = currentPoints.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));

    // Queue SVG elements for each point (will be rendered after vis.render())
    validPoints.forEach((point, idx) => {
        const shape = context._getDotShape(point, interpolation, layerType, idx);
        const strokeStyle = context._getDotStrokeStyle(point, interpolation, isPointMode, layerType, styles, validPoints);
        const fillStyle = context._getDotFillStyle(point, interpolation, isPointMode, layerType, styles, validPoints);

        const svgStyles = {
            radius: styles.pointRadius || 6,
            stroke: strokeStyle,
            strokeWidth: styles.strokeWidth || styles.lineWidth || 3,
            fill: fillStyle || 'none',
            cursor: isPointMode ? 'default' : 'move'
        };

        let element;
        if (shape === 'circle') {
            element = context._createSVGCircle(point, svgStyles);
        } else if (shape === 'triangle' || shape === 'square') {
            const rotation = context._getDotAngle(point, interpolation, layerType);
            element = context._createSVGPath(shape, point, svgStyles, rotation);
        }

        if (element) {
            // Add event handlers
            element.addEventListener('mousedown', (e) => {
                if (context.splineEditor.handlePointPointerDown) {
                    context.splineEditor.handlePointPointerDown(point, e);
                }
            });
            element.addEventListener('mouseover', (e) => {
                if (context.splineEditor.mouseOverHandler) {
                    context.splineEditor.mouseOverHandler.call(context.splineEditor, point);
                }
            });
            element.addEventListener('mouseout', (e) => {
                if (context.splineEditor.mouseOutHandler) {
                    context.splineEditor.mouseOutHandler.call(context.splineEditor, point);
                }
            });

            // Queue for rendering after vis.render()
            context._pendingShapes.activeDots.push(element);
        }
    });
}

/**
 * Draws a preview dot showing hover state on active box layer
 *
 * @param {Object} context - The LayerRenderer instance (this)
 * @param {Object} widget - The widget representing the box layer
 */
export function drawBoxPreview(context, widget) {
    const previewState = context.splineEditor._boxPreviewState;
    if (!previewState || previewState.widget !== widget ||
        !Number.isFinite(previewState.x) || !Number.isFinite(previewState.y)) return;

    context.activeLayerPanel.add(pv.Dot)
        .data(() => {
            // Only render if current layer is still a box layer
            const activeWidget = context.node.layerManager.getActiveWidget();
            if (context._getLayerType(activeWidget) !== 'box') return [];
            return [previewState];
        })
        .left(d => d.x)
        .top(d => d.y)
        .radius(() => POINT_BASE_RADIUS)
        .fillStyle('rgba(44, 198, 255, 0.85)')
        .strokeStyle('#0b3b4b')
        .lineWidth(1.5)
        .events('none');
}

/**
 * Draws an inactive layer with lines and dots
 *
 * @param {Object} context - The LayerRenderer instance (this)
 * @param {Object} widget - The widget representing the layer
 */
export function drawInactiveLayer(context, widget) {
    const layerType = context._getLayerType(widget);
    const isOff = !widget.value.on;
    const isBoxLayer = layerType === 'box';

    let points;
    try {
        points = isBoxLayer ? getBoxLayerPoints(context, widget) : getRegularLayerPoints(context, widget);
    } catch (e) {
        console.error("Error parsing points for inactive layer:", e);
        return;
    }

    if (!points?.length) return;

    const layerPanel = context.vis.add(pv.Panel);
    context.inactiveLayerPanels.push(layerPanel);
    context.inactiveLayerMetadata.push({ widget, points, panel: layerPanel });

    if (isBoxLayer) {
        const boxStyles = context._getLayerStyles('box', 'inactive', true, isOff);
        drawInactiveBoxLayer(context, layerPanel, points, widget, boxStyles);
        return;
    }

    const interpolation = context._normalizeInterpolation(widget.value.interpolation, layerType);
    const isPointMode = (interpolation === 'points');
    const styles = context._getLayerStyles(layerType, 'inactive', isPointMode, isOff);

    drawInactiveLine(context, layerPanel, points, interpolation, isPointMode, styles, widget);

    if (layerType !== 'handdraw') {
        drawInactiveDots(context, layerPanel, points, interpolation, isPointMode, styles, layerType, widget);
    }
}

/**
 * Gets points for a box layer from its keyframe data
 *
 * @param {Object} context - The LayerRenderer instance (this)
 * @param {Object} widget - The widget representing the box layer
 * @returns {Array} Array of denormalized points
 */
export function getBoxLayerPoints(context, widget) {
    const boxKeys = Array.isArray(widget.value.box_keys) ? widget.value.box_keys : [];
    if (!boxKeys.length) return null;

    const sortedKeys = boxKeys
        .filter(k => typeof k?.x === 'number' && typeof k?.y === 'number')
        .slice()
        .sort((a, b) => (a.frame || 0) - (b.frame || 0));

    if (!sortedKeys.length) return null;

    const interpolationMode = widget.value.box_interpolation || 'linear';
    let curvePoints;

    if (interpolationMode === 'basis' && sortedKeys.length >= 3) {
        curvePoints = generateBasisCurvePoints(sortedKeys);
    } else {
        curvePoints = sortedKeys.map(k => ({ x: k.x, y: k.y }));
    }

    return context.splineEditor.denormalizePoints(curvePoints);
}

/**
 * Gets points for a regular (non-box) layer from stored points
 *
 * @param {Object} context - The LayerRenderer instance (this)
 * @param {Object} widget - The widget representing the layer
 * @returns {Array} Array of denormalized points
 */
export function getRegularLayerPoints(context, widget) {
    const storedPoints = JSON.parse(widget.value.points_store || '[]');
    return context.splineEditor.denormalizePoints(storedPoints);
}

/**
 * Draws a line for an inactive layer
 *
 * @param {Object} context - The LayerRenderer instance (this)
 * @param {Object} layerPanel - The Protovis panel for the layer
 * @param {Array} points - Array of points to draw
 * @param {string} interpolation - Interpolation mode
 * @param {boolean} isPointMode - Whether in point mode
 * @param {Object} styles - Style configuration object
 */
export function drawInactiveLine(context, layerPanel, points, interpolation, isPointMode, styles, widget) {
    const renderPoints = prepareLineData(points, interpolation, isPointMode);
    const lineWidth = styles.lineWidth ?? (isPointMode ? 1 : 3);

    layerPanel.add(pv.Line).events("none")
        .data(renderPoints)
        .left(d => transformVideoToCanvasSpace(context.splineEditor, d.x, d.y).x)
        .top(d => transformVideoToCanvasSpace(context.splineEditor, d.x, d.y).y)
        .interpolate(isPointMode ? 'linear' : interpolation)
        .strokeStyle(styles.lineStroke)
        .lineWidth(lineWidth);
    
    // Add a second, wider, transparent line for hit detection
    layerPanel.add(pv.Line)
        .data(renderPoints)
        .left(d => transformVideoToCanvasSpace(context.splineEditor, d.x, d.y).x)
        .top(d => transformVideoToCanvasSpace(context.splineEditor, d.x, d.y).y)
        .interpolate(isPointMode ? 'linear' : interpolation)
        .strokeStyle("rgba(0,0,0,0)") // transparent
        .lineWidth(Math.max(lineWidth, 10)) // wider
        .event("dblclick", () => {
            if (context.splineEditor?.node?.layerManager && widget) {
                context.splineEditor.node.layerManager.setActiveWidget(widget);
            }
        })
        .cursor("default");
}

/**
 * Draws dots for an inactive layer
 *
 * @param {Object} context - The LayerRenderer instance (this)
 * @param {Object} layerPanel - The Protovis panel for the layer
 * @param {Array} points - Array of points to draw
 * @param {string} interpolation - Interpolation mode
 * @param {boolean} isPointMode - Whether in point mode
 * @param {Object} styles - Style configuration object
 * @param {string} layerType - Type of layer
 * @param {Object} widget - The widget representing the layer
 */
export function drawInactiveDots(context, layerPanel, points, interpolation, isPointMode, styles, layerType, widget) {
    if (layerType === 'box') return;
    // Create deep copy to prevent sharing with active layers
    const orderedDots = [...points].map(p => ({...p})).sort((a, b) =>
        context.splineEditor.getBoxPointRadius ? context.splineEditor.getBoxPointRadius(b) - context.splineEditor.getBoxPointRadius(a) : 0
    );

    const firstPointOriginal = points.length > 0 ? points[0] : null;

    orderedDots.forEach((dot) => {
        let shape = 'circle';
        let isFirstPoint = false;

        // Determine shape based on layer type and position
        if (layerType === 'normal' && !isPointMode) {
            // Check if this dot is the first point by comparing coordinates
            if (firstPointOriginal &&
                Math.abs(dot.x - firstPointOriginal.x) < 0.001 &&
                Math.abs(dot.y - firstPointOriginal.y) < 0.001) {
                shape = 'triangle';
                isFirstPoint = true;
            } else {
                shape = 'circle';
            }
        } else if (layerType === 'handdraw') {
            shape = 'circle';
        }

        const pointRadius = isPointMode ? POINT_BASE_RADIUS * 0.6 : 4.5;
        const svgStyles = {
            radius: pointRadius,
            stroke: styles.pointStroke || 'rgb(31,119,180)',
            strokeWidth: styles.strokeWidth || 3,
            fill: styles.pointFill || 'none',
            cursor: 'default'
        };

        let element;
        if (shape === 'circle') {
            element = context._createSVGCircle(dot, svgStyles);
        } else if (shape === 'triangle') {
            // Calculate rotation for the first point triangle
            let rotationRad = 0;
            if (isFirstPoint && points.length > 1) {
                const dx = points[1].x - points[0].x;
                const dy = points[1].y - points[0].y;
                rotationRad = (dx !== 0 || dy !== 0) ? (Math.atan2(dy, dx) - Math.PI / 2 + Math.PI + 2 * Math.PI) % (2 * Math.PI) : 0;
            }
            element = context._createSVGPath(shape, dot, svgStyles, rotationRad);
        }

        if (element) {
            // Inactive dots need to be clickable for double-click layer switching
            element.style.pointerEvents = 'auto';
            element.style.cursor = 'default';

            // Add double-click event handler to switch to this layer
            element.addEventListener('dblclick', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (context.splineEditor?.node?.layerManager && widget) {
                    context.splineEditor.node.layerManager.setActiveWidget(widget);
                }
            });

            // Queue for rendering after vis.render()
            context._pendingShapes.inactiveDots.push(element);
        }
    });

    return; // Disable old Protovis code
}

/**
 * Draws an inactive box layer with keyframe path and reference image
 *
 * @param {Object} context - The LayerRenderer instance (this)
 * @param {Object} layerPanel - The Protovis panel for the layer
 * @param {Array} points - Array of points to draw
 * @param {Object} widget - The widget representing the box layer
 * @param {Object} styles - Style configuration object
 */
export function drawInactiveBoxLayer(context, layerPanel, points, widget, styles) {
    // Always render ref image even if no keyframes exist
    const hasPoints = points && points.length > 0;

    if (hasPoints) {
        // Only use the main keyframe points for the inactive circles
        const sanitizedKeys = context.splineEditor._ensureBoxLayerData(widget);
        const keyframeNormPoints = sanitizedKeys.map(k => ({ x: k.x, y: k.y }));
        const keyframeDenormPoints = safeDenormalizePoints(context, keyframeNormPoints) || [];
        const orderedDots = [...keyframeDenormPoints].map(p => ({ ...p })).sort((a, b) =>
            context.splineEditor.getBoxPointRadius ? context.splineEditor.getBoxPointRadius(b) - context.splineEditor.getBoxPointRadius(a) : 0
        );

        drawInactiveLine(context, layerPanel, points, 'linear', true, styles, widget);

        // Keyframe markers (uses Protovis) - relying solely on this for keyframe circles
        drawBoxKeyPath(context, layerPanel, widget, false);
    }

    // Render reference image for inactive box layer at 50% opacity (even without keyframes)
    renderInactiveBoxRefImage(context, widget, 0.5);
}

/**
 * Renders the reference image for an inactive box layer
 *
 * @param {Object} context - The LayerRenderer instance (this)
 * @param {Object} widget - The widget representing the box layer
 * @param {number} opacity - Opacity for the image (0-1)
 */
export function renderInactiveBoxRefImage(context, widget, opacity = 0.5) {
    // Get selected ref attachment for this widget
    const attachment = context._getSelectedRefAttachment(widget);
    if (!attachment || (!attachment.base64 && !attachment.path)) return;
    if (widget.value.ref_selection === 'no_ref') return;

    // Get current frame from timeline
    const maxFrames = context.splineEditor._getMaxFrames ? context.splineEditor._getMaxFrames() : 250;
    const frame = Math.max(1, Math.min(maxFrames, Math.round(widget.value?.box_timeline_point || 1)));

    // Compute box position at current frame
    const normalized = context.splineEditor._computeBoxLayerPosition
        ? context.splineEditor._computeBoxLayerPosition(widget, frame)
        : { x: 0.5, y: 0.5, scale: 1, rotation: 0 };

    // Denormalize coordinates to canvas space
    const denorm = context.splineEditor.denormalizePoints
        ? context.splineEditor.denormalizePoints([{ x: normalized.x ?? 0.5, y: normalized.y ?? 0.5 }])
        : [{ x: 0, y: 0 }];

    const point = denorm[0] || { x: 0, y: 0 };
    point.boxScale = context.clampPointScale ? context.clampPointScale(normalized.scale ?? 1) : (normalized.scale ?? 1);
    point.scale = point.boxScale;
    point.boxRotation = (typeof normalized.rotation === 'number' && !Number.isNaN(normalized.rotation)) ? normalized.rotation : 0;

    // Calculate box size
    const boxRadius = context.getScaledBoxRadius(point);
    const boxSize = boxRadius * 2;
    const imgW = Math.max(1, attachment.width || boxSize);
    const imgH = Math.max(1, attachment.height || boxSize);

    // Calculate image dimensions (preserve aspect ratio)
    const scale = Math.min(boxSize / imgW, boxSize / imgH);
    const renderW = imgW * scale;
    const renderH = imgH * scale;
    const rotationDeg = point.boxRotation * (180 / Math.PI);

    // Create SVG image element
    const image = document.createElementNS('http://www.w3.org/2000/svg', 'image');

    // Get cached image URL
    const imageHref = context._getRefImageUrl(widget, attachment);
    if (!imageHref) return; // Skip if no valid image source

    // Force image reload by setting href to empty first, then to actual URL
    image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '');
    image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', imageHref);

    image.setAttribute('width', renderW);
    image.setAttribute('height', renderH);
    image.setAttribute('x', -renderW / 2);
    image.setAttribute('y', -renderH / 2);
    image.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    // Transform to canvas space and apply rotation
    const transformedPoint = transformVideoToCanvasSpace(context.splineEditor, point.x, point.y);
    image.setAttribute('transform', `translate(${transformedPoint.x},${transformedPoint.y}) rotate(${rotationDeg})`);

    // Set opacity and pointer events
    image.style.pointerEvents = 'none';
    image.style.opacity = String(opacity);

    // Store cache bust version to track if image needs updating
    image.dataset.cacheBustVersion = context._cacheBustCounter;

    // Push to inactive box images queue
    context._pendingShapes.inactiveBoxImages.push(image);
}

/**
 * Draws the keyframe path for a box layer (connecting line and keyframe indicators)
 *
 * @param {Object} context - The LayerRenderer instance (this)
 * @param {Object} panel - The Protovis panel for the layer
 * @param {Object} widget - The widget representing the box layer
 * @param {boolean} isActive - Whether this is the active layer
 */
export function drawBoxKeyPath(context, panel, widget, isActive) {
    const sortedKeys = context.splineEditor._ensureBoxLayerData(widget);
    if (!sortedKeys.length) return;

    // Check if we're currently manipulating box keyframes
    const isManipulating = context.splineEditor._boxKeyframePoints &&
                           context.splineEditor._manipulatingBoxKeyframe &&
                           context.splineEditor._manipulatingBoxKeyframe.widget === widget;

    let keyframeDenormPoints;
    let keyframeNormPoints;

    if (isManipulating) {
        // Use the working points being manipulated for real-time updates
        keyframeDenormPoints = context.splineEditor._boxKeyframePoints.filter(p =>
            p && Number.isFinite(p.x) && Number.isFinite(p.y)
        );
        // Also create normalized points for path generation
        keyframeNormPoints = context.splineEditor.normalizePoints ?
            context.splineEditor.normalizePoints(keyframeDenormPoints) :
            sortedKeys.map(k => ({ x: k.x, y: k.y }));
    } else {
        // Use the stored box_keys
        keyframeNormPoints = sortedKeys.map(k => ({ x: k.x, y: k.y }));
        keyframeDenormPoints = safeDenormalizePoints(context, keyframeNormPoints);
    }

    if (!keyframeDenormPoints || !keyframeDenormPoints.length) return;

    const interpolationMode = widget.value.box_interpolation || 'linear';

    // Validate denormalized points to prevent drawing artifacts
    const validKeyframeDenormPoints = keyframeDenormPoints.filter(p =>
        p && Number.isFinite(p.x) && Number.isFinite(p.y)
    );

    if (!validKeyframeDenormPoints.length) return;

    // Generate path points for connecting line
    let pathNormPoints = keyframeNormPoints;
    if (interpolationMode === 'basis' && sortedKeys.length >= 3) {
        pathNormPoints = generateBasisCurvePoints(sortedKeys);
    }

    let pathDenormPoints = validKeyframeDenormPoints;
    if (pathNormPoints !== keyframeNormPoints) {
        const tempPath = safeDenormalizePoints(context, pathNormPoints);
        if (tempPath && tempPath.length >= 2) {
            pathDenormPoints = tempPath;
        }
    }

    const activeColor = '#2df26d';
    const inactiveColor = '#f04d3a';
    const color = isActive ? activeColor : inactiveColor;
    const fillColor = isActive ? 'rgba(45, 242, 109, 0.3)' : 'rgba(240,77,58,0.25)';

    // Manually draw connecting path for active box layer to fix render bug
    if (isActive && sortedKeys.length >= 2) {
        const targetWidget = widget; 
        const currentManipulating = context.splineEditor._boxKeyframePoints &&
                                   context.splineEditor._manipulatingBoxKeyframe &&
                                   context.splineEditor._manipulatingBoxKeyframe.widget === targetWidget;

        let pathPoints;
        if (currentManipulating) {
            pathPoints = context.splineEditor._boxKeyframePoints.filter(p =>
                p && Number.isFinite(p.x) && Number.isFinite(p.y)
            );
        } else {
            const currentSortedKeys = context.splineEditor._ensureBoxLayerData(targetWidget);
            const interpolationMode = targetWidget.value.box_interpolation || 'linear';

            let normPoints = currentSortedKeys.map(k => ({ x: k.x, y: k.y }));
            if (interpolationMode === 'basis' && currentSortedKeys.length >= 3) {
                normPoints = generateBasisCurvePoints(currentSortedKeys);
            }
            pathPoints = safeDenormalizePoints(context, normPoints);
        }
        
        if (pathPoints && pathPoints.length >= 2) {
            const canvasPoints = pathPoints.map(p => transformVideoToCanvasSpace(context.splineEditor, p.x, p.y));
            const d = canvasPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', d);
            path.setAttribute('stroke', color);
            path.setAttribute('stroke-width', String(isActive ? 2 : 1.5));
            path.setAttribute('fill', 'none');
            path.style.pointerEvents = 'none';

            context._pendingShapes.activeLines.push(path);
        }
    }

    // Draw keyframe indicator circles with interaction support
    // These show where keyframes exist on the timeline and can be manipulated
    validKeyframeDenormPoints.forEach((point, index) => {
        // Add frame info to the point so we can identify which keyframe it belongs to
        const keyframeData = {
            ...point,
            frame: sortedKeys[index]?.frame,
            isBoxKeyframe: true,  // Mark this as a box keyframe for special handling
            boxKeyIndex: index,
            widget: widget
        };

        if (isActive) {
            // Active layer: make keyframes interactive with dynamic positioning
            panel.add(pv.Dot)
                .data(() => {
                    // Get real-time position during manipulation
                    const currentManipulating = context.splineEditor._boxKeyframePoints &&
                                               context.splineEditor._manipulatingBoxKeyframe &&
                                               context.splineEditor._manipulatingBoxKeyframe.widget === widget;

                    if (currentManipulating && context.splineEditor._boxKeyframePoints[index]) {
                        // Use working point position
                        return [{
                            ...keyframeData,
                            x: context.splineEditor._boxKeyframePoints[index].x,
                            y: context.splineEditor._boxKeyframePoints[index].y
                        }];
                    }
                    // Use original position
                    return [keyframeData];
                })
                .left(d => transformVideoToCanvasSpace(context.splineEditor, d.x, d.y).x)
                .top(d => transformVideoToCanvasSpace(context.splineEditor, d.x, d.y).y)
                .shape('circle')
                .radius(4)
                .strokeStyle(color)
                .lineWidth(2)
                .fillStyle(fillColor)  // Semi-transparent fill for better visibility
                .event("mousedown", (d) => {
                    if (context.splineEditor.handleBoxKeyframePointerDown) {
                        context.splineEditor.handleBoxKeyframePointerDown(d, pv.event);
                    }
                })
                .event("mouseover", (d) => {
                    if (context.splineEditor.mouseOverHandler) {
                        context.splineEditor.mouseOverHandler(d);
                    }
                })
                .event("mouseout", (d) => {
                    if (context.splineEditor.mouseOutHandler) {
                        context.splineEditor.mouseOutHandler();
                    }
                });
        } else {
            // Inactive layer: non-interactive
            panel.add(pv.Dot)
                .data([keyframeData])
                .left(d => transformVideoToCanvasSpace(context.splineEditor, d.x, d.y).x)
                .top(d => transformVideoToCanvasSpace(context.splineEditor, d.x, d.y).y)
                .shape('circle')
                .radius(3)
                .strokeStyle(color)
                .lineWidth(2)
                .fillStyle(fillColor)
                .event("dblclick", (d) => {
                    if (context.splineEditor?.node?.layerManager && d.widget) {
                        context.splineEditor.node.layerManager.setActiveWidget(d.widget);
                    }
                })
                .cursor("default");
        }
    });
}

/**
 * Generates smooth basis spline curve points from keyframes
 *
 * @param {Array} sortedKeys - Array of keyframe data sorted by frame
 * @returns {Array} Array of points along the smooth curve
 */
export function generateBasisCurvePoints(sortedKeys) {
    if (sortedKeys.length < 3) {
        return sortedKeys.map(k => ({ x: k.x, y: k.y }));
    }

    const points = [];
    const stepsPerSegment = 20;

    const basisInterpolate = (p0, p1, p2, p3, t) => {
        const t2 = t * t, t3 = t2 * t;
        const b0 = (1 - t3 + 3 * t2 - 3 * t) / 6;
        const b1 = (4 - 6 * t2 + 3 * t3) / 6;
        const b2 = (1 + 3 * t + 3 * t2 - 3 * t3) / 6;
        const b3 = t3 / 6;
        return {
            x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
            y: b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y
        };
    };

    for (let i = 0; i < sortedKeys.length - 1; i++) {
        const p0 = sortedKeys[Math.max(0, i - 1)];
        const p1 = sortedKeys[i];
        const p2 = sortedKeys[i + 1];
        const p3 = sortedKeys[Math.min(sortedKeys.length - 1, i + 2)];

        if (i === 0) points.push({ x: p1.x, y: p1.y });

        for (let step = 1; step < stepsPerSegment; step++) {
            const t = step / stepsPerSegment;
            points.push(basisInterpolate(p0, p1, p2, p3, t));
        }

        if (i === sortedKeys.length - 2) points.push({ x: p2.x, y: p2.y });
    }

    return points;
}

/**
 * Safely denormalizes points, returning null if denormalization fails
 *
 * @param {Object} context - The LayerRenderer instance (this)
 * @param {Array} points - Array of normalized points
 * @returns {Array|null} Denormalized points or null on error
 */
function safeDenormalizePoints(context, points) {
    if (!points?.length) return null;
    try {
        return context.splineEditor.denormalizePoints(points);
    } catch {
        return null;
    }
}
