import { app } from "../../../../scripts/app.js";
import { api } from "../../../../scripts/api.js";

// Make sure protovis is loaded
window.protovisLoaded = false;
const loadProtovis = async () => {
    // Check if protovis is already loaded to prevent multiple loads
    if (typeof window.pv !== 'undefined') {
        window.protovisLoaded = true;
        return;
    }
    
    try {
        await loadScript('/kjweb_async/protovis.min.js');
        // Wait a bit to ensure protovis is fully loaded
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Verify protovis is now available
        if (typeof window.pv !== 'undefined') {
            window.protovisLoaded = true;
        } else {
            console.warn("Protovis library did not load properly");
        }
    } catch (e) {
        console.error("Failed to load protovis.min.js", e);
    }
};

loadProtovis();

app.registerExtension({
    name: "WanVideo.VideoMergeABC.Graph",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        // Defensive check to ensure nodeData exists and has name property
        if (!nodeData || !nodeData.name) {
            return;
        }
        
        if (nodeData.name === "VideoMergeABC") {
            // Ensure we're only modifying the intended node type
            // Add a unique identifier to ensure we don't affect other nodes 
            nodeType.prototype.wanVideoGraphExtensionApplied = true;

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                // Only apply our modifications if this is our specific node
                if (this.wanVideoGraphExtensionApplied !== true) {
                    return onNodeCreated?.apply(this, arguments);
                }
                
                try {
                    onNodeCreated?.apply(this, arguments);


                const element = document.createElement("div");
                const graphWidget = this.addDOMWidget("graph", "div", element, {
                    serialize: false,
                });
                
                graphWidget.element = element;
                graphWidget.element.style.width = "100%";
                graphWidget.element.style.height = "150px";
                graphWidget.element.style.padding = "0";
                graphWidget.element.style.margin = "0";
                graphWidget.element.style.boxSizing = "border-box";
                graphWidget.element.innerHTML = `<p style=\"color: #555; text-align: center; margin-top: 0; padding-top: 50px;\">Graph will appear here after running.</p>`;

                graphWidget.computeSize = function(width) {
                    return [width, 150];
                }

                this.graphWidget = graphWidget;

                // Hide the opacity_curve widget using ComfyUI's built-in methods
                const opacityCurveWidget = this.widgets.find(w => w.name === "opacity_curve");
                if (opacityCurveWidget) {
                    // Store original visibility for potential restoration
                    opacityCurveWidget.originalVisible = opacityCurveWidget.visible !== false;
                    opacityCurveWidget.visible = false;
                    
                    // Update the computed size of the node to account for hidden widgets
                    setTimeout(() => {
                        if (this.onResize) {
                            this.onResize(this.size);
                        }
                    }, 10);
                }

                const handleGraphData = (event) => {
                    const { uid, data } = event.detail;
                    const nodeId = this.id;
                   
                    if (nodeId == uid) {
                        this.graphData = data;
                        if (this.graphData && this.graphData.x) {
                            this.num_frames = this.graphData.x.length;
                        }
                        this.drawGraph(this.graphData);
                    }
                };

                api.addEventListener("wanvideo-graph-data", handleGraphData);

                const onRemoved = this.onRemoved;
                this.onRemoved = () => {
                    try {
                        api.removeEventListener("wanvideo-graph-data", handleGraphData);
                        
                        // Restore original widget visibility if needed
                        const opacityCurveWidget = this.widgets?.find(w => w.name === "opacity_curve");
                        if (opacityCurveWidget && opacityCurveWidget.originalVisible) {
                            opacityCurveWidget.visible = opacityCurveWidget.originalVisible;
                        }
                    } catch (error) {
                        console.warn("Error during VideoMergeABC cleanup:", error);
                    }
                    onRemoved?.apply(this, arguments);
                };

                const flamesOverlapWidget = this.widgets.find(w => w.name === "FlamesOverlap");
                if (flamesOverlapWidget) {
                    const originalCallback = flamesOverlapWidget.callback;
                    flamesOverlapWidget.callback = (value) => {
                        originalCallback?.call(flamesOverlapWidget, value);
                        // Only update graph if this is our specific node
                        if (this.wanVideoGraphExtensionApplied === true) {
                            this.updateGraphFromWidget();
                        }
                    };
                }
                
                const easingTypeWidget = this.widgets.find(w => w.name === "easing_type");
                if (easingTypeWidget) {
                    const originalCallback = easingTypeWidget.callback;
                    easingTypeWidget.callback = (value) => {
                        originalCallback?.call(easingTypeWidget, value);
                        // Only update graph if this is our specific node
                        if (this.wanVideoGraphExtensionApplied === true) {
                            this.updateGraphFromWidget();
                        }
                    };
                }

                const clampStrWidget = this.widgets.find(w => w.name === "easing_clamp");
                if (clampStrWidget) {
                    const originalCallback = clampStrWidget.callback;
                    clampStrWidget.callback = (value) => {
                        originalCallback?.call(clampStrWidget, value);
                        // Only update graph if this is our specific node
                        if (this.wanVideoGraphExtensionApplied === true) {
                            this.updateGraphFromWidget();
                        }
                    };
                }
            } catch (error) {
                console.error("Error in VideoMergeABC onNodeCreated:", error);
            }
        };

            const onExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (message) {
                // Only execute our custom logic if this is our specific node
                if (this.wanVideoGraphExtensionApplied !== true) {
                    return onExecuted?.apply(this, arguments);
                }
                
                try {
                    onExecuted?.apply(this, arguments);
                    
                    if (message.transition_graph) {
                        const graphData = Array.isArray(message.transition_graph) ? message.transition_graph[0] : message.transition_graph;
                        this.graphData = graphData; // Store data on node
                        if (graphData && graphData.x) {
                            this.num_frames = graphData.x.length;
                        }
                        this.drawGraph(this.graphData);

                        // Update hidden widget with properly clamped curve values
                        const opacityCurveWidget = this.widgets.find(w => w.name === "opacity_curve");
                        if (opacityCurveWidget && this.graphData && this.graphData.y) {
                            // Clamp values to prevent negative jumping
                            const clampedY = this.graphData.y.map(val => Math.max(0.0, Math.min(1.0, val)));
                            opacityCurveWidget.value = JSON.stringify(clampedY);
                        }
                    }
                } catch (error) {
                    console.error("Error in VideoMergeABC onExecuted:", error);
                }
            };

            const onResize = nodeType.prototype.onResize;
            nodeType.prototype.onResize = function(size) {
                // Only execute our custom logic if this is our specific node
                if (this.wanVideoGraphExtensionApplied !== true) {
                    return onResize?.apply(this, arguments);
                }
                
                try {
                    onResize?.apply(this, arguments);
                    if (this.graphData) {
                        this.drawGraph(this.graphData);
                    }
                } catch (error) {
                    console.error("Error in VideoMergeABC onResize:", error);
                }
            };

            nodeType.prototype.updateGraphFromWidget = function() {
                if (!this.num_frames) {
                    return; // Not ready yet
                }
                const flamesOverlapWidget = this.widgets.find(w => w.name === "FlamesOverlap");
                const easingTypeWidget = this.widgets.find(w => w.name === "easing_type");
                const clampStrWidget = this.widgets.find(w => w.name === "easing_clamp");

                let flamesOverlap = flamesOverlapWidget.value;
                const easingType = easingTypeWidget.value;
                const easing_clamp = clampStrWidget.value;
                const num_frames = this.num_frames;

                // Visually cap flamesOverlap at half the frame count
                if (flamesOverlap > num_frames / 2) {
                    flamesOverlap = Math.floor(num_frames / 2);
                }

                // Use original remap_clamp calculation to allow negative values
                const remap_clamp = (easing_clamp - 0.5) * 2;
                
                // Re-implement the python logic in JS with easing
                const x = Array.from({length: num_frames}, (_, i) => i);
                let y = new Array(num_frames).fill(0.0);

                if (flamesOverlap > 0 && flamesOverlap < num_frames) {
                    // Apply easing function based on the selected type
                    for (let i = 1; i < Math.min(flamesOverlap + 1, num_frames); i++) {
                        const progress = i / flamesOverlap;
                        const y_eased = this.applyEasing(progress, easingType);
                        y[i] = Math.pow(y_eased, Math.pow(2, -remap_clamp));
                    }
                    
                    const end_point = Math.max(num_frames - flamesOverlap, flamesOverlap + 1);
                    for (let i = flamesOverlap; i < Math.min(end_point, num_frames); i++) {
                        y[i] = 1.0;
                    }
                    
                    // Apply inverted easing function for the transition from (num_frames - flamesOverlap) to num_frames
                    if (num_frames - flamesOverlap > flamesOverlap) {
                        for (let i = num_frames - flamesOverlap; i < num_frames; i++) {
                            let progress;
                            if (flamesOverlap > 1) {
                                progress = (i - (num_frames - flamesOverlap)) / (flamesOverlap - 1);
                            } else {
                                progress = 1.0;
                            }
                            const invertedEasingType = this.invertEasingType(easingType);
                            const y_eased = 1.0 - this.applyEasing(progress, invertedEasingType);
                            y[i] = Math.pow(y_eased, Math.pow(2, -remap_clamp));
                        }
                    }
                }

                const key_frames = [0, Math.round(flamesOverlap), Math.round(num_frames - flamesOverlap), num_frames - 1];
                const key_values = key_frames.map(k => (k >= 0 && k < y.length) ? y[k] : 0.0);

                this.graphData = { x, y, key_frames, key_values };
                this.drawGraph(this.graphData);

                // Update hidden widget with properly clamped curve values
                const opacityCurveWidget = this.widgets.find(w => w.name === "opacity_curve");
                if (opacityCurveWidget) {
                    // Clamp values to prevent negative jumping before sending to Python
                    const clampedY = y.map(val => Math.max(0.0, Math.min(1.0, val)));
                    opacityCurveWidget.value = JSON.stringify(clampedY);
                }
            }
            
            // Easing function implementation
            nodeType.prototype.applyEasing = function(t, easingType) {
                if (easingType === "linear") {
                    return t;
                } else if (easingType === "ease_in") {
                    return t * t;
                } else if (easingType === "ease_out") {
                    return 1.0 - (1.0 - t) * (1.0 - t);
                } else if (easingType === "ease_in_out") {
                    if (t < 0.5) {
                        return 2.0 * t * t;
                    } else {
                        return 1.0 - 2.0 * (1.0 - t) * (1.0 - t);
                    }
                } else {
                    return t; // Default to linear
                }
            }
            
            // Function to invert easing type for the ending part of the curve
            nodeType.prototype.invertEasingType = function(easingType) {
                if (easingType === "ease_in") {
                    return "ease_out";
                } else if (easingType === "ease_out") {
                    return "ease_in";
                } else {
                    return easingType; // linear and ease_in_out remain the same
                }
            }

            nodeType.prototype.drawGraph = function(data) {
                
                if (!this.graphWidget || !this.graphWidget.element) {
                    console.error("Cannot draw graph - missing widget or element");
                    return;
                }
                
                if (!window.protovisLoaded || typeof window.pv === 'undefined') {
                    console.warn("Protovis not loaded, skipping graph drawing");
                    this.graphWidget.element.innerHTML = `<p style="color: #888; text-align: center; margin-top: 50px;">Graph visualization unavailable</p>`;
                    return;
                }

                let parsedData = data;
                if (typeof data === 'string') {
                    try {
                        parsedData = JSON.parse(data);
                    } catch (e) {
                        console.error("Failed to parse graph data string:", e);
                        return;
                    }
                }

                if (!parsedData || !parsedData.x) {
                    console.error("Cannot draw graph - parsedData or parsedData.x is missing", parsedData);
                    return;
                }

                this.graphWidget.element.innerHTML = "";

                const padding = { left: 35, right: 10, top: 10, bottom: 25 };
                const w = this.graphWidget.element.clientWidth;
                const h = this.graphWidget.element.clientHeight;

                const vis = new pv.Panel()
                    .width(w)
                    .height(h)
                    .fillStyle("#2a2a2a")
                    .canvas(this.graphWidget.element);

                const plotWidth = w - padding.left - padding.right;
                const plotHeight = h - padding.top - padding.bottom;

                const num_frames = parsedData.x.length;
                const x = pv.Scale.linear(1, num_frames).range(padding.left, w - padding.right);
                const y = pv.Scale.linear(0, 1.1).range(padding.bottom, h - padding.top);

                // X-axis Label
                vis.add(pv.Label)
                    .left(padding.left + plotWidth / 2)
                    .bottom(5)
                    .textAlign("center")
                    .text("frames")
                    .font("10px sans-serif")
                    .textStyle("white");

                // Y-axis Label
                vis.add(pv.Label)
                    .top(padding.top + plotHeight / 2)
                    .left(10)
                    .textAlign("center")
                    .textAngle(-Math.PI / 2)
                    .text("opacity")
                    .font("10px sans-serif")
                    .textStyle("white");

                // X-axis ticks and grid lines
                vis.add(pv.Rule)
                    .data(x.ticks())
                    .left(x)
                    .bottom(padding.bottom)
                    .top(padding.top)
                    .strokeStyle("#444")
                  .anchor("bottom").add(pv.Label)
                    .text(x.tickFormat);

                // Y-axis ticks and grid lines
                vis.add(pv.Rule)
                    .data(y.ticks(5))
                    .bottom(y)
                    .left(padding.left)
                    .right(w - padding.right)
                    .strokeStyle("#444")
                  .anchor("left").add(pv.Label)
                    .text(y.tickFormat);
                
                // Main line
                const lineData = parsedData.y.map((val, i) => ({x: i + 1, y: val}));

                vis.add(pv.Line)
                    .data(lineData)
                    .left(d => x(d.x))
                    .bottom(d => y(d.y))
                    .strokeStyle("cyan")
                    .lineWidth(2);

                // Key points
                if (parsedData.key_frames) {
                    vis.add(pv.Dot)
                        .data(parsedData.key_frames.map((frame, i) => ({x: frame + 1, y: parsedData.key_values[i]})))
                        .left(d => x(d.x))
                        .bottom(d => y(d.y))
                        .fillStyle("white")
                        .size(20);
                }

                try {
                    vis.render();
                } catch (e) {
                    console.error("Error rendering graph:", e);
                    this.graphWidget.element.innerHTML = `<p style="color: #888; text-align: center; margin-top: 50px;">Error rendering graph</p>`;
                }
            };
        }
    },

});

// Helper to load scripts
function loadScript(url) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${url}"]`)) {
            resolve();
            return;
        }
        const script = document.createElement('script');
        script.type = 'text/javascript';
        script.src = url;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}