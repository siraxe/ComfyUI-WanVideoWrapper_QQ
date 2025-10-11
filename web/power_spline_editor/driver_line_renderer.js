/**
 * Draws connector lines on the canvas for all driven spline widgets within a node.
 * This is called from the node's onAfterDraw method.
 * @param {CanvasRenderingContext2D} ctx The canvas context to draw on.
 * @param {LGraphNode} node The PowerSplineEditor node instance.
 */
export function drawDriverLines(ctx, node) {
    if (!node.layerManager) return; // Not initialized yet

    const splineWidgets = node.layerManager.getSplineWidgets();
    if (!splineWidgets?.length) return;

    const widgetMap = new Map(splineWidgets.map(w => [w.value.name, w]));

    ctx.save();
    ctx.strokeStyle = "orange";
    ctx.fillStyle = "orange";
    ctx.lineWidth = 2;

    for (const drivenWidget of splineWidgets) {
        const driverName = drivenWidget.value._drivenConfig?.driver;
        const isDrivenOn = !!drivenWidget.value.driven; // Check if driven toggle is on
        if (driverName && driverName !== "None" && isDrivenOn) {
            const driverWidget = widgetMap.get(driverName);

            if (driverWidget && drivenWidget.hitAreas?.drivenToggle && driverWidget.hitAreas?.name) {
                // Point A (start): Driven layer's toggle button (center, offset left)
                const startX = drivenWidget.hitAreas.drivenToggle.bounds[0] + drivenWidget.hitAreas.drivenToggle.bounds[1] / 2 - 20;
                const startY = drivenWidget.last_y + LiteGraph.NODE_WIDGET_HEIGHT / 2;

                // Point B (end): Near the end of the driver layer's name (35% across)
                const endX = driverWidget.hitAreas.name.bounds[0] + driverWidget.hitAreas.name.bounds[2] * 0.35;
                const endY = driverWidget.last_y + LiteGraph.NODE_WIDGET_HEIGHT / 2;

                // Draw the line
                ctx.beginPath();
                ctx.moveTo(startX, startY);
                ctx.lineTo(endX, endY);
                ctx.stroke();

                // Draw the arrowhead
                const arrowSize = 6;
                const angle = Math.atan2(endY - startY, endX - startX);
                ctx.beginPath();
                ctx.moveTo(endX, endY);
                ctx.lineTo(endX - arrowSize * Math.cos(angle - Math.PI / 6), endY - arrowSize * Math.sin(angle - Math.PI / 6));
                ctx.lineTo(endX - arrowSize * Math.cos(angle + Math.PI / 6), endY - arrowSize * Math.sin(angle + Math.PI / 6));
                ctx.closePath();
                ctx.fill();
            }
        }
    }
    ctx.restore();
}