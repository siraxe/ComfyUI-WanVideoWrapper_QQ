import { app } from "../../../../scripts/app.js";
import { api } from "../../../../scripts/api.js";

app.registerExtension({
    name: "WanVideo.VideoRGBAnalysis.Graph",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        // Defensive check to ensure nodeData exists and has name property
        if (!nodeData || !nodeData.name) {
            return;
        }

        if (nodeData.name === "VideoRGBAnalysis") {
            // Ensure we're only modifying the intended node type
            nodeType.prototype.wanVideoRGBGraphExtensionApplied = true;

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                // Only apply our modifications if this is our specific node
                if (this.wanVideoRGBGraphExtensionApplied !== true) {
                    return onNodeCreated?.apply(this, arguments);
                }

                try {
                    onNodeCreated?.apply(this, arguments);

                    const element = document.createElement("div");
                    const graphWidget = this.addDOMWidget("rgb_graph", "div", element, {
                        serialize: false,
                    });

                    graphWidget.element = element;
                    graphWidget.element.style.width = "100%";
                    graphWidget.element.style.height = "200px";
                    graphWidget.element.style.padding = "0";
                    graphWidget.element.style.margin = "0";
                    graphWidget.element.style.boxSizing = "border-box";
                    graphWidget.element.innerHTML = `<p style="color: #555; text-align: center; margin-top: 0; padding-top: 80px;">RGB graph will appear here after running.</p>`;

                    graphWidget.computeSize = function(width) {
                        return [width, 200];
                    }

                    this.rgbGraphWidget = graphWidget;

                } catch (error) {
                    console.error("Error in VideoRGBAnalysis onNodeCreated:", error);
                }
            };

            const onExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (message) {
                // Only execute our custom logic if this is our specific node
                if (this.wanVideoRGBGraphExtensionApplied !== true) {
                    return onExecuted?.apply(this, arguments);
                }

                try {
                    onExecuted?.apply(this, arguments);

                    if (message.rgb_analysis_graph) {
                        const graphData = Array.isArray(message.rgb_analysis_graph) ? message.rgb_analysis_graph[0] : message.rgb_analysis_graph;
                        this.graphData = graphData;
                        this.drawRGBGraph(graphData);
                    }
                } catch (error) {
                    console.error("Error in VideoRGBAnalysis onExecuted:", error);
                }
            };

            const onResize = nodeType.prototype.onResize;
            nodeType.prototype.onResize = function(size) {
                // Only execute our custom logic if this is our specific node
                if (this.wanVideoRGBGraphExtensionApplied !== true) {
                    return onResize?.apply(this, arguments);
                }

                try {
                    onResize?.apply(this, arguments);
                    if (this.graphData) {
                        this.drawRGBGraph(this.graphData);
                    }
                } catch (error) {
                    console.error("Error in VideoRGBAnalysis onResize:", error);
                }
            };

            nodeType.prototype.drawRGBGraph = function(data) {
                if (!this.rgbGraphWidget || !this.rgbGraphWidget.element) {
                    console.error("Cannot draw RGB graph - missing widget or element");
                    return;
                }

                if (!window.protovisLoaded || typeof window.pv === 'undefined') {
                    console.warn("Protovis not loaded, skipping RGB graph drawing");
                    this.rgbGraphWidget.element.innerHTML = `<p style="color: #888; text-align: center; margin-top: 80px;">Graph visualization unavailable</p>`;
                    return;
                }

                let parsedData = data;
                if (typeof data === 'string') {
                    try {
                        parsedData = JSON.parse(data);
                    } catch (e) {
                        console.error("Failed to parse RGB graph data string:", e);
                        return;
                    }
                }

                if (!parsedData || !parsedData.x) {
                    console.error("Cannot draw RGB graph - parsedData or parsedData.x is missing", parsedData);
                    return;
                }

                // Check if we have valid data
                if (parsedData.x.length === 0) {
                    this.rgbGraphWidget.element.innerHTML = `<p style="color: #888; text-align: center; margin-top: 80px;">No frames to analyze</p>`;
                    return;
                }

                this.rgbGraphWidget.element.innerHTML = "";

                const padding = { left: 45, right: 15, top: 30, bottom: 35 };
                const w = this.rgbGraphWidget.element.clientWidth;
                const h = this.rgbGraphWidget.element.clientHeight;

                const vis = new pv.Panel()
                    .width(w)
                    .height(h)
                    .fillStyle("#2a2a2a")
                    .canvas(this.rgbGraphWidget.element);

                const plotWidth = w - padding.left - padding.right;
                const plotHeight = h - padding.top - padding.bottom;

                const num_frames = parsedData.x.length;
                const x = pv.Scale.linear(0, num_frames - 1).range(padding.left, w - padding.right);
                const y = pv.Scale.linear(0, 1.0).range(padding.bottom, h - padding.top);

                // X-axis Label
                vis.add(pv.Label)
                    .left(padding.left + plotWidth / 2)
                    .bottom(10)
                    .textAlign("center")
                    .text("frame")
                    .font("10px sans-serif")
                    .textStyle("white");

                // Y-axis Label
                vis.add(pv.Label)
                    .top(padding.top + plotHeight / 2)
                    .left(12)
                    .textAlign("center")
                    .textAngle(-Math.PI / 2)
                    .text("value")
                    .font("10px sans-serif")
                    .textStyle("white");

                // X-axis ticks and grid lines
                vis.add(pv.Rule)
                    .data(x.ticks(Math.min(10, num_frames)))
                    .left(x)
                    .bottom(padding.bottom)
                    .top(padding.top)
                    .strokeStyle("#444")
                    .anchor("bottom").add(pv.Label)
                    .text(x.tickFormat)
                    .textStyle("#aaa");

                // Y-axis ticks and grid lines
                vis.add(pv.Rule)
                    .data(y.ticks(5))
                    .bottom(y)
                    .left(padding.left)
                    .right(w - padding.right)
                    .strokeStyle("#444")
                    .anchor("left").add(pv.Label)
                    .text(y.tickFormat)
                    .textStyle("#aaa");

                // Prepare data for each line
                const redData = parsedData.y_r.map((val, i) => ({x: parsedData.x[i], y: val}));
                const greenData = parsedData.y_g.map((val, i) => ({x: parsedData.x[i], y: val}));
                const blueData = parsedData.y_b.map((val, i) => ({x: parsedData.x[i], y: val}));
                const brightnessData = parsedData.y_brightness.map((val, i) => ({x: parsedData.x[i], y: val}));

                // Helper function to add line with legend
                const addLine = (data, color, label, index) => {
                    // Line
                    vis.add(pv.Line)
                        .data(data)
                        .left(d => x(d.x))
                        .bottom(d => y(d.y))
                        .strokeStyle(color)
                        .lineWidth(2);

                    // Legend
                    const legendX = padding.left + 15 + (index * 95);
                    const legendY = h - 18;

                    vis.add(pv.Label)
                        .left(legendX)
                        .bottom(legendY)
                        .text(label)
                        .font("9px sans-serif")
                        .textStyle(color)
                        .textAlign("left");
                };

                // Add lines in order: Red, Green, Blue, Brightness
                addLine(redData, "#ff4444", "Red", 0);
                addLine(greenData, "#44ff44", "Green", 1);
                addLine(blueData, "#4444ff", "Blue", 2);
                addLine(brightnessData, "#ffff44", "Brightness", 3);

                try {
                    vis.render();
                } catch (e) {
                    console.error("Error rendering RGB graph:", e);
                    this.rgbGraphWidget.element.innerHTML = `<p style="color: #888; text-align: center; margin-top: 80px;">Error rendering graph</p>`;
                }
            };
        }
    },
});
