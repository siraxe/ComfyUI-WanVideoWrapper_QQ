/**
 * @class LayerRenderer
 * A dedicated class to handle the rendering of active and inactive spline layers
 * on the Protovis canvas. This centralizes drawing logic and state management
 * for rendering, making it more robust and easier to maintain.
 */
export class LayerRenderer {
    constructor(splineEditor, vis) {
        this.splineEditor = splineEditor;
        this.vis = vis;
        this.node = splineEditor.node;

        // Track individual panels for each inactive layer to ensure complete isolation
        // Each layer gets its own panel to prevent state pollution and rendering artifacts
        this.inactiveLayerPanels = [];
        this.activeLayerPanel = this.vis.add(pv.Panel);

        // Store metadata for inactive layers to enable hit detection
        // Format: [{ widget: widgetRef, points: [...], panel: panelRef }, ...]
        this.inactiveLayerMetadata = [];

        // Flow animation for inactive layers (non-"points" types)
        this._dashAnimOffset = 0;
        this._lastDashUpdateMs = 0;
        this._dashTimer = setInterval(() => {
            this._dashAnimOffset = (this._dashAnimOffset + 2) % 1000;
            try { this.updateInactiveDash(); } catch {}
        }, 80);
    }

    // Apply/update marching-dash on inactive paths via DOM attributes
    updateInactiveDash() {
        if (!this.splineEditor) return;
        const svg = this.vis && this.vis.canvas ? this.vis.canvas() : null;
        if (!svg) return;
        // If disabled, strip dash styling and stop
        if (this.splineEditor._inactiveFlowEnabled === false) {
            const allPaths = svg.getElementsByTagName('path');
            for (const p of allPaths) {
                if (p.hasAttribute('stroke-dasharray')) p.removeAttribute('stroke-dasharray');
                if (p.hasAttribute('stroke-dashoffset')) p.removeAttribute('stroke-dashoffset');
                if (p.dataset && 'dashOffset' in p.dataset) delete p.dataset.dashOffset;
            }
            return;
        }
        const paths = svg.getElementsByTagName('path');
        // If any target path lacks a dasharray, force an immediate apply (skip throttle)
        let needsInitialApply = false;
        for (const el of paths) {
            if (el.getAttribute) {
                const stroke = (el.getAttribute('stroke') || '').toLowerCase();
                const sw = Number(el.getAttribute('stroke-width') || '0');
                if ((stroke.includes('120,70,180') || stroke.includes('#7846b4') || stroke.includes('255,127,14') || stroke.includes('#ff7f0e')) && sw > 1 && !el.hasAttribute('stroke-dasharray')) {
                    needsInitialApply = true; break;
                }
            }
        }
        // Throttle dash updates to reduce load during active drawing
        const now = Date.now();
        const minInterval = this.splineEditor._handdrawActive ? 120 : 60; // slower while drawing
        if (!needsInitialApply && (now - this._lastDashUpdateMs < minInterval)) return;
        this._lastDashUpdateMs = now;
        const norm = (s) => (s || '').replace(/\s+/g, '').toLowerCase();
        const isInactiveTarget = (p) => {
            const stroke = norm(p.getAttribute('stroke'));
            const blue = '#1f77b4'; // active normal
            const yellow = '#d7c400'; // active handdraw
            if (stroke === blue || stroke === '#1f77b4' || stroke === yellow || stroke === '#d7c400') return false;
            // Orange inactive (rgba or rgb) or purple inactive
            const isOrange = stroke.includes('255,127,14') || stroke.includes('#ff7f0e') || stroke.includes('rgba(255,127,14') || stroke.includes('rgb(255,127,14)');
            const isPurple = stroke.includes('120,70,180') || stroke.includes('#7846b4') || stroke.includes('rgb(120,70,180)');
            if (!(isOrange || isPurple)) return false;
            // Exclude thin 1px orange (points type) by stroke-width
            const sw = Number(p.getAttribute('stroke-width') || '0');
            if (isOrange && sw <= 1.01) return false;
            return true;
        };
        // Helper easing functions (return 0..1 shape factor)
        const easeValue = (t, mode) => {
            t = Math.max(0, Math.min(1, t));
            switch (mode) {
                case 'in': return t; // grow along path
                case 'out': return 1 - t; // shrink along path
                case 'in_out': return Math.sin(Math.PI * t); // squeezed at ends, widest in middle
                case 'out_in': return 1 - Math.sin(Math.PI * t); // widest at ends, squeezed middle
                case 'linear':
                default: return 1; // constant strip size
            }
        };
        // Split candidates by color to preserve draw order mapping
        const phase = ((this._dashAnimOffset % 200) / 200);
        const purplePaths = [];
        const orangePaths = [];
        for (const p of paths) {
            if (!isInactiveTarget(p)) continue;
            const stroke = norm(p.getAttribute('stroke'));
            const isPurple = stroke.includes('120,70,180') || stroke.includes('#7846b4') || stroke.includes('rgb(120,70,180)');
            const list = isPurple ? purplePaths : orangePaths;
            const len = (typeof p.getTotalLength === 'function') ? p.getTotalLength() : 0;
            list.push({ p, len });
        }
        const purpleMetas = (this.inactiveLayerMetadata || []).filter(d => d?.widget?.value?.type === 'handdraw');
        const orangeMetas = (this.inactiveLayerMetadata || []).filter(d => (d?.widget?.value?.type !== 'handdraw') && ((d?.widget?.value?.interpolation || 'linear') !== 'points'));
        const applyFor = (pairs, metas) => {
            const count = Math.min(pairs.length, metas.length);
            for (let idx = 0; idx < count; idx++) {
                const { p, len: pathLength } = pairs[idx];
                const easingMode = metas[idx]?.widget?.value?.easing || 'linear';
                const segments = Math.max(14, Math.min(100, Math.round(pathLength / 36)));
                const baseDash = 10;
                const baseGap = 6;
                const minFactor = 0.25;
                const maxFactor = 1.6;
                const pattern = [];
                let sum = 0;
                for (let i = 0; i < segments; i++) {
                    const t = (i / segments + phase) % 1;
                    const f = easeValue(t, easingMode);
                    const dash = Math.max(2, baseDash * (minFactor + (maxFactor - minFactor) * f));
                    const gap = Math.max(2, baseGap * (1.0 - 0.2 * f));
                    pattern.push(dash, gap);
                    sum += dash + gap;
                }
                if (sum > 0 && pathLength > 0) {
                    const scale = pathLength / sum;
                    for (let k = 0; k < pattern.length; k++) pattern[k] = Math.max(1, pattern[k] * scale);
                }
                p.setAttribute('stroke-dasharray', pattern.join(' '));
                const dashOffsetPx = -phase * (pathLength || 1);
                p.setAttribute('stroke-dashoffset', String(dashOffsetPx));
            }
        };
        applyFor(purplePaths, purpleMetas);
        applyFor(orangePaths, orangeMetas);
    }

    // Apply/update easing-shaped dash for ACTIVE handdraw layer (yellow line)
    updateActiveHanddrawDash() {
        if (!this.splineEditor || this.splineEditor._inactiveFlowEnabled === false) return;
        const now = Date.now();
        const minInterval = this.splineEditor._handdrawActive ? 120 : 60;
        if ((this._lastDashUpdateMs || 0) && (now - this._lastDashUpdateMs < minInterval)) return;
        this._lastDashUpdateMs = now;

        const svg = this.vis && this.vis.canvas ? this.vis.canvas() : null;
        if (!svg) return;
        const active = this.node?.layerManager?.getActiveWidget?.();
        if (!active || active.value?.type !== 'handdraw') return;

        const easingMode = active.value?.easing || 'linear';
        const paths = svg.getElementsByTagName('path');
        const norm = (s) => (s || '').replace(/\s+/g, '').toLowerCase();
        const yellow = '#d7c400';

        // Easing factor
        const easeValue = (t, mode) => {
            t = Math.max(0, Math.min(1, t));
            switch (mode) {
                case 'in': return t;
                case 'out': return 1 - t;
                case 'in_out': return Math.sin(Math.PI * t);
                case 'out_in': return 1 - Math.sin(Math.PI * t);
                case 'linear':
                default: return 1;
            }
        };

        const phase = ((this._dashAnimOffset % 200) / 200);

        for (const p of paths) {
            const stroke = norm(p.getAttribute('stroke'));
            if (stroke !== yellow && stroke !== '#d7c400') continue;
            const pathLength = (typeof p.getTotalLength === 'function') ? p.getTotalLength() : 0;
            const segments = Math.max(14, Math.min(100, Math.round(pathLength / 36)));
            const baseDash = 10;
            const baseGap = 6;
            const minFactor = 0.35;
            const maxFactor = 1.45;
            const pattern = [];
            let sum = 0;
            for (let i = 0; i < segments; i++) {
                const t = (i / segments + phase) % 1;
                const f = easeValue(t, easingMode);
                const dash = Math.max(2, baseDash * (minFactor + (maxFactor - minFactor) * f));
                const gap = baseGap;
                pattern.push(dash, gap);
                sum += dash + gap;
            }
            if (sum > 0 && pathLength > 0) {
                const scale = pathLength / sum;
                for (let k = 0; k < pattern.length; k++) pattern[k] = Math.max(1, pattern[k] * scale);
            }
            p.setAttribute('stroke-dasharray', pattern.join(' '));
            const dashOffsetPx = -phase * (pathLength || 1);
            p.setAttribute('stroke-dashoffset', String(dashOffsetPx));
        }
    }

    /**
     * Main render method. Clears previous drawings and redraws all layers.
     */
    render() {
        // During drag operations, avoid rebuilding the scene graph.
        // Recreating marks while Protovis drag behavior is active breaks internal state
        // and causes errors like reading undefined 'x'/'fix'. Just re-render in place.
        const forceRebuild = !!this.splineEditor._forceRebuildNextRender;
        if (forceRebuild) {
            this.splineEditor._forceRebuildNextRender = false;
        }
        if (!forceRebuild && (this.splineEditor.isDragging || this.splineEditor.isDraggingAll || this.splineEditor.isScalingAll || this.splineEditor.isRotatingAll)) {
            this.vis.render();
            return;
        }

        this.clearLayers();

        const activeWidget = this.node.layerManager.getActiveWidget();
        const allWidgets = this.node.layerManager.getSplineWidgets();
        const isDrawing = !!this.splineEditor._handdrawActive;
        const handdrawMode = this.splineEditor._handdrawMode || 'off';
        const activeIsHand = !!(activeWidget && activeWidget.value && activeWidget.value.type === 'handdraw');

        // Render inactive and off layers - each in its own isolated panel
        allWidgets.forEach(widget => {
            // While drawing in 'create' mode, also render the currently selected layer as inactive
            const treatActiveAsInactive = isDrawing && handdrawMode === 'create' && widget === activeWidget;
            if (widget !== activeWidget || treatActiveAsInactive) {
                this.drawInactiveLayer(widget);
            }
        });

        // Draw the active layer on top in its dedicated panel
        if (activeWidget && !(isDrawing && handdrawMode === 'create')) {
            // Normal case: draw the active widget unless we're creating a new handdraw stroke
            this.drawActiveLayer(activeWidget);
        } 
        if (this.splineEditor._handdrawActive && this.splineEditor.points && this.splineEditor.points.length > 0) {
            // During handdraw drawing, render a live preview on top (even if another layer is selected)
            // No active widget yet (e.g., first-ever handdraw stroke). Render a live preview
            // using handdraw styling so users can see the stroke while drawing.
            const pseudoWidget = { value: { interpolation: 'linear', type: 'handdraw' } };
            this.drawActiveLayer(pseudoWidget);
        }

        // Ensure active panel is always the last child so it renders on top
        // This prevents inactive layers from blocking mouse events when overlapping
        const activePanelIndex = this.vis.children.indexOf(this.activeLayerPanel);
        if (activePanelIndex > -1) {
            this.vis.children.splice(activePanelIndex, 1);
            this.vis.children.push(this.activeLayerPanel);
        }

        // Apply the changes to the SVG
        this.vis.render();
        // Avoid extra DOM work while freehand drawing; timer will animate
        if (!this.splineEditor._handdrawActive) {
            this.updateInactiveDash();
            this.updateActiveHanddrawDash();
        } else {
            // still update lazily by throttle
            this.updateActiveHanddrawDash();
        }
    }

    /**
     * Clears all drawings from the layer panels.
     * Properly destroys individual inactive layer panels to prevent memory leaks.
     */
    clearLayers() {
        // Remove all inactive layer panels from the vis
        this.inactiveLayerPanels.forEach(panel => {
            const index = this.vis.children.indexOf(panel);
            if (index > -1) {
                this.vis.children.splice(index, 1);
            }
        });
        // Clear the arrays
        this.inactiveLayerPanels = [];
        this.inactiveLayerMetadata = [];

        // Clear active layer panel
        this.activeLayerPanel.children = [];
    }

    /**
     * Draws the currently active spline layer.
     * This includes the main line, control points with drag behaviors, and highlights.
     * Uses closures to ensure drag events work with actual point objects.
     * @param {object} widget - The active spline widget.
     */
    drawActiveLayer(widget) {
        const points = this.splineEditor.points;
        if (!points || points.length === 0) return;

        const interpolation = widget.value.interpolation || 'linear';
        // Treat preview drawing as handdraw for styling when armed
        const isHanddraw = (widget?.value?.type === 'handdraw') || !!this.splineEditor._handdrawActive;

        // ALWAYS draw line - thin for points mode, normal otherwise
        // Points mode uses linear interpolation with a thin line
        // For non-points interpolation, we need to handle highlighted points specially
        this.activeLayerPanel.add(pv.Line)
            .data(() => {
                // Special handling for curve rendering when points are highlighted
                if (interpolation !== 'points' && interpolation !== 'linear') {
                    const hasAnyHighlighted = points.some(p => p.highlighted);
                    if (hasAnyHighlighted) {
                        // Insert duplicate points at highlighted positions to force linear segments
                        const renderPoints = [];
                        for (let i = 0; i < points.length; i++) {
                            const point = points[i];
    
                            if (point.highlighted) {
                                // Add a point slightly before (for incoming linear segment)
                                if (i > 0) {
                                    const prevPoint = points[i - 1];
                                    const dx = point.x - prevPoint.x;
                                    const dy = point.y - prevPoint.y;
                                    const dist = Math.sqrt(dx * dx + dy * dy);
                                    const offset = Math.min(0.01, 1 / dist); // Very small offset
                                    renderPoints.push({
                                        x: prevPoint.x + dx * (1 - offset),
                                        y: prevPoint.y + dy * (1 - offset)
                                    });
                                }
    
                                // Add the highlighted point itself
                                renderPoints.push(point);
    
                                // Add a point slightly after (for outgoing linear segment)
                                if (i < points.length - 1) {
                                    const nextPoint = points[i + 1];
                                    const dx = nextPoint.x - point.x;
                                    const dy = nextPoint.y - point.y;
                                    const dist = Math.sqrt(dx * dx + dy * dy);
                                    const offset = Math.min(0.01, 1 / dist); // Very small offset
                                    renderPoints.push({
                                        x: point.x + dx * offset,
                                        y: point.y + dy * offset
                                    });
                                }
                            } else {
                                renderPoints.push(point);
                            }
                        }
                        return renderPoints;
                    }
                }
                return points;
            })
            .left(d => d.x)
            .top(d => d.y)
            .interpolate(() => interpolation === 'points' ? 'linear' : interpolation)
            .strokeStyle(() => {
                if (isHanddraw) {
                    return '#d7c400'; // muted yellow for active handdraw
                }
                return '#1f77b4';
            })
            .lineWidth(() => {
                // Handdraw (active) should have same thickness as normal lines
                if (isHanddraw) return 3;
                return interpolation === 'points' ? 1 : 3;
            });

        // ALWAYS draw dots - bigger for points mode, all circles
        // Use closures to ensure drag handlers can find points via indexOf()
        this.activeLayerPanel.add(pv.Dot)
            .data(() => points)
            .left(d => d.x)
            .top(d => d.y)
            .radius(() => {
                if (isHanddraw) return 2; // make yellow hand-draw points smaller
                return interpolation === 'points' ? 9 : 6;
            })
        .shape((dot) => {
            if (interpolation === 'points') return "circle";
            // If interpolation is 'basis' AND the point is highlighted, draw a square
            if (interpolation === 'basis' && dot.highlighted) return "square";
            const index = this.splineEditor.points.indexOf(dot);
            return index === 0 ? "triangle" : "circle";
        })            .angle((dot) => {
                if (interpolation === 'points') return 0;
                const index = this.splineEditor.points.indexOf(dot);
                if (index !== 0 || points.length <= 1) return 0;

                const dx = points[1].x - points[0].x;
                const dy = points[1].y - points[0].y;
                if (dx !== 0 || dy !== 0) {
                    const angle = Math.atan2(dy, dx) - Math.PI / 2;
                    return (angle + 2 * Math.PI) % (2 * Math.PI);
                }
                return 0;
            })
            .cursor("move")
            .strokeStyle((dot) => {
                const index = this.splineEditor.points.indexOf(dot);
                if (!isHanddraw && index === 0 && interpolation !== 'points') {
                    return "green";
                }
                if (isHanddraw) return '#d7c400';
                return interpolation === 'points' ? "#139613" : "#1f77b4";
            })
            .fillStyle((dot) => {
                const index = this.splineEditor.points.indexOf(dot);
                if (!isHanddraw && index === 0 && interpolation !== 'points') {
                    return "rgba(0, 255, 0, 0.5)";
                }
                if (isHanddraw) return "rgba(215, 196, 0, 0.45)";
                return interpolation === 'points' ? "rgba(19, 150, 19, 0.5)" : "rgba(100, 100, 100, 0.5)";
            })
            .event("mousedown", pv.Behavior.drag())
            .event("dragstart", this.splineEditor.dragStartHandler)
            .event("dragend", this.splineEditor.dragEndHandler)
            .event("drag", this.splineEditor.dragHandler)
            .event("mouseover", this.splineEditor.mouseOverHandler)
            .event("mouseout", this.splineEditor.mouseOutHandler);
        // No labels for any mode - removed the label anchor
    }

    /**
     * Draws an inactive or off spline layer.
     * Each layer gets its own isolated panel to prevent state pollution.
     * @param {object} widget - The inactive or off spline widget.
     */
    drawInactiveLayer(widget) {
        const isOff = !widget.value.on;
        const isHanddraw = widget?.value?.type === 'handdraw';
        let strokeColor = isOff
            ? "rgba(255, 255, 255, 0.1)"
            : (isHanddraw ? "rgba(120, 70, 180, 0.85)" : "rgba(255, 127, 14, 0.5)");
        const fillColor = isOff
            ? "rgba(255, 255, 255, 0.1)"
            : (isHanddraw ? "rgba(120, 70, 180, 0.6)" : "rgba(255, 127, 14, 0.4)");

        let points;
        try {
            const storedPoints = JSON.parse(widget.value.points_store || '[]');
            points = this.splineEditor.denormalizePoints(storedPoints);
        } catch (e) {
            console.error("Error parsing points for inactive layer:", e);
            return;
        }

        if (!points || points.length === 0) return;

        // Create a new isolated panel for this layer. Disable events so it never steals interaction.
        const layerPanel = this.vis.add(pv.Panel).events("none");
        this.inactiveLayerPanels.push(layerPanel);

        // Store metadata for hit detection (widget reference and points)
        this.inactiveLayerMetadata.push({
            widget: widget,
            points: points,
            panel: layerPanel
        });

        const interpolation = widget.value.interpolation || 'linear';
        // For inactive points layers (non-handdraw), reduce line opacity to 20%
        if (!isHanddraw && !isOff && interpolation === 'points') {
            strokeColor = "rgba(255, 127, 14, 0.2)";
        }

        // Snapshot points to avoid closure issues
        const pointsSnapshot = [...points];

        // For inactive layers, we also need to handle highlighted points for consistency
        let renderPoints = pointsSnapshot;
        if (interpolation !== 'points' && interpolation !== 'linear') {
            const hasAnyHighlighted = points.some(p => p.highlighted);
            if (hasAnyHighlighted) {
                // Insert duplicate points at highlighted positions to force linear segments
                const tempRenderPoints = [];
                for (let i = 0; i < points.length; i++) {
                    const point = points[i];

                    if (point.highlighted) {
                        if (i > 0) {
                            const prevPoint = points[i - 1];
                            const dx = point.x - prevPoint.x;
                            const dy = point.y - prevPoint.y;
                            const dist = Math.sqrt(dx * dx + dy * dy);
                            const offset = Math.min(0.01, 1 / dist);
                            tempRenderPoints.push({ x: prevPoint.x + dx * (1 - offset), y: prevPoint.y + dy * (1 - offset), _helper: true });
                        }
                        tempRenderPoints.push(point);
                        if (i < points.length - 1) {
                            const nextPoint = points[i + 1];
                            const dx = nextPoint.x - point.x;
                            const dy = nextPoint.y - point.y;
                            const dist = Math.sqrt(dx * dx + dy * dy);
                            const offset = Math.min(0.01, 1 / dist);
                            tempRenderPoints.push({ x: point.x + dx * offset, y: point.y + dy * offset, _helper: true });
                        }
                    } else {
                        tempRenderPoints.push(point);
                    }
                }
                renderPoints = tempRenderPoints;
            }
        }

        // ALWAYS draw line
        const lineWidthMain = (interpolation === 'points') ? (isHanddraw ? 3 : 1) : 3;
        const inactiveLine = layerPanel.add(pv.Line).events("none")
            .data(renderPoints)
            .left(d => d.x)
            .top(d => d.y)
            .interpolate(interpolation === 'points' ? 'linear' : interpolation)
            .strokeStyle(strokeColor)
            .lineWidth(lineWidthMain);
        // Note: dash animation is applied post-render via updateInactiveDash()

        // If this is a handdraw layer in inactive (purple) state, render line-only and skip markers/dots
        if (isHanddraw) {
            return;
        }

        // Handle different interpolation modes for inactive layers
        if (interpolation === 'points') {
            const lineWidthPts = isHanddraw ? 3 : 1;
            layerPanel.add(pv.Line).events("none")
                .data(pointsSnapshot)
                .left(d => d.x)
                .top(d => d.y)
                .interpolate('linear')
                .strokeStyle(strokeColor)
                .lineWidth(lineWidthPts);
            // For points-type layers, also show point markers when inactive (non-handdraw only)
            if (!isHanddraw && pointsSnapshot.length > 0) {
                layerPanel.add(pv.Dot).events("none")
                    .data(pointsSnapshot)
                    .left(d => d.x)
                    .top(d => d.y)
                    .radius(7.0)
                    .shape('circle')
                    .strokeStyle(strokeColor)
                    .fillStyle(fillColor);
                // Keep first-point triangle marker for direction
                layerPanel.add(pv.Dot).events("none")
                    .data([pointsSnapshot[0]])
                    .left(d => d.x)
                    .top(d => d.y)
                    .radius(6)
                    .shape("triangle")
                    .strokeStyle(strokeColor)
                    .fillStyle(fillColor)
                    .angle((dot) => {
                        const points = pointsSnapshot;
                        if (points.length <= 1) return 0;
                        const firstPoint = points[0];
                        const secondPoint = points[1];
                        const dx = secondPoint.x - firstPoint.x;
                        const dy = secondPoint.y - firstPoint.y;
                        if (dx !== 0 || dy !== 0) {
                            const angle = Math.atan2(dy, dx) - Math.PI / 2;
                            return (angle + 2 * Math.PI) % (2 * Math.PI);
                        }
                        return 0;
                    });
            }
        } else {
            // ONLY draw triangle at first point for all other modes
            if (!isHanddraw && pointsSnapshot.length > 0) {
                layerPanel.add(pv.Dot)
                    .data([pointsSnapshot[0]])
                    .left(d => d.x)
                    .top(d => d.y)
                    .radius(6)
                    .shape("triangle")
                    .strokeStyle(strokeColor)
                    .fillStyle(fillColor)
                    .angle((dot) => {
                        const points = pointsSnapshot;
                        if (points.length <= 1) return 0;
                        const firstPoint = points[0];
                        const secondPoint = points[1];
                        const dx = secondPoint.x - firstPoint.x;
                        const dy = secondPoint.y - firstPoint.y;
                        if (dx !== 0 || dy !== 0) {
                            const angle = Math.atan2(dy, dx) - Math.PI / 2;
                            return (angle + 2 * Math.PI) % (2 * Math.PI);
                        }
                        return 0;
                    });
            }
        }
    }

    /**
     * Find the inactive layer widget that contains the given mouse position.
     * Returns the widget closest to the click position, or null if none found.
     * @param {number} mouseX - Mouse X coordinate on canvas
     * @param {number} mouseY - Mouse Y coordinate on canvas
     * @param {number} threshold - Distance threshold in pixels (default: 15)
     * @returns {object|null} The widget reference or null
     */
    findInactiveLayerAtPosition(mouseX, mouseY, threshold = 15) {
        // Be a bit more permissive around the first point (triangle marker)
        const firstPointThreshold = Math.max(threshold, 22);
        let closestWidget = null;
        let closestDistance = threshold;

        // Check each inactive layer's points
        for (const layerData of this.inactiveLayerMetadata) {
            const points = layerData.points;

            // Check distance to each point (use larger threshold for the first point/triangle)
            for (let idx = 0; idx < points.length; idx++) {
                const point = points[idx];
                const dx = mouseX - point.x;
                const dy = mouseY - point.y;
                const distance = Math.sqrt(dx * dx + dy * dy);

                const localThreshold = idx === 0 ? firstPointThreshold : threshold;
                if (distance < Math.min(closestDistance, localThreshold)) {
                    closestDistance = distance;
                    closestWidget = layerData.widget;
                }
            }

            // Also check distance to line segments between points
            for (let i = 0; i < points.length - 1; i++) {
                const p1 = points[i];
                const p2 = points[i + 1];
                const distance = this.distanceToLineSegment(mouseX, mouseY, p1.x, p1.y, p2.x, p2.y);

                if (distance < closestDistance) {
                    closestDistance = distance;
                    closestWidget = layerData.widget;
                }
            }
        }

        return closestWidget;
    }

    /**
     * Calculate the perpendicular distance from a point to a line segment.
     * @param {number} px - Point X coordinate
     * @param {number} py - Point Y coordinate
     * @param {number} x1 - Line segment start X
     * @param {number} y1 - Line segment start Y
     * @param {number} x2 - Line segment end X
     * @param {number} y2 - Line segment end Y
     * @returns {number} Distance in pixels
     */
    distanceToLineSegment(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const lengthSquared = dx * dx + dy * dy;

        if (lengthSquared === 0) {
            // Line segment is a point
            const dpx = px - x1;
            const dpy = py - y1;
            return Math.sqrt(dpx * dpx + dpy * dpy);
        }

        // Calculate projection parameter t
        let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
        t = Math.max(0, Math.min(1, t)); // Clamp to [0, 1]

        // Find closest point on line segment
        const closestX = x1 + t * dx;
        const closestY = y1 + t * dy;

        // Return distance to closest point
        const distX = px - closestX;
        const distY = py - closestY;
        return Math.sqrt(distX * distX + distY * distY);
    }
}
