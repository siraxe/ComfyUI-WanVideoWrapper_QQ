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
    }

    /**
     * Main render method. Clears previous drawings and redraws all layers.
     */
    render() {
        this.clearLayers();

        const activeWidget = this.node.layerManager.getActiveWidget();
        const allWidgets = this.node.layerManager.getSplineWidgets();

        // Render inactive and off layers - each in its own isolated panel
        allWidgets.forEach(widget => {
            if (widget !== activeWidget) {
                this.drawInactiveLayer(widget);
            }
        });

        // Draw the active layer on top in its dedicated panel
        if (activeWidget) {
            this.drawActiveLayer(activeWidget);
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
            .strokeStyle(() => interpolation === 'points' ? "#1f77b4" : "#1f77b4")
            .lineWidth(() => interpolation === 'points' ? 1 : 3);

        // ALWAYS draw dots - bigger for points mode, all circles
        // Use closures to ensure drag handlers can find points via indexOf()
        this.activeLayerPanel.add(pv.Dot)
            .data(() => points)
            .left(d => d.x)
            .top(d => d.y)
            .radius(() => interpolation === 'points' ? 9 : 6)
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
                if (index === 0 && interpolation !== 'points') {
                    return "green";
                }
                return interpolation === 'points' ? "#139613" : "#1f77b4";
            })
            .fillStyle((dot) => {
                const index = this.splineEditor.points.indexOf(dot);
                if (index === 0 && interpolation !== 'points') {
                    return "rgba(0, 255, 0, 0.5)";
                }
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
        const strokeColor = isOff ? "rgba(255, 255, 255, 0.1)" : "rgba(255, 127, 14, 0.5)";
        const fillColor = isOff ? "rgba(255, 255, 255, 0.1)" : "rgba(255, 127, 14, 0.4)";

        let points;
        try {
            const storedPoints = JSON.parse(widget.value.points_store || '[]');
            points = this.splineEditor.denormalizePoints(storedPoints);
        } catch (e) {
            console.error("Error parsing points for inactive layer:", e);
            return;
        }

        if (!points || points.length === 0) return;

        // Create a new isolated panel for this layer
        const layerPanel = this.vis.add(pv.Panel);
        this.inactiveLayerPanels.push(layerPanel);

        // Store metadata for hit detection (widget reference and points)
        this.inactiveLayerMetadata.push({
            widget: widget,
            points: points,
            panel: layerPanel
        });

        const interpolation = widget.value.interpolation || 'linear';

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
        layerPanel.add(pv.Line)
            .data(renderPoints)
            .left(d => d.x)
            .top(d => d.y)
            .interpolate(interpolation === 'points' ? 'linear' : interpolation)
            .strokeStyle(strokeColor)
            .lineWidth(interpolation === 'points' ? 1 : 3);

        // Handle different interpolation modes for inactive layers
        if (interpolation === 'points') {
            layerPanel.add(pv.Line)
                .data(pointsSnapshot)
                .left(d => d.x)
                .top(d => d.y)
                .interpolate('linear')
                .strokeStyle(strokeColor)
                .lineWidth(1);
            
            layerPanel.add(pv.Dot)
                .data(pointsSnapshot)
                .left(d => d.x)
                .top(d => d.y)
                .radius(6)
                .shape("circle")
                .strokeStyle(strokeColor)
                .fillStyle(fillColor);
        } else {
            // ONLY draw triangle at first point for all other modes
            if (pointsSnapshot.length > 0) {
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
        let closestWidget = null;
        let closestDistance = threshold;

        // Check each inactive layer's points
        for (const layerData of this.inactiveLayerMetadata) {
            const points = layerData.points;

            // Check distance to each point
            for (const point of points) {
                const dx = mouseX - point.x;
                const dy = mouseY - point.y;
                const distance = Math.sqrt(dx * dx + dy * dy);

                if (distance < closestDistance) {
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
