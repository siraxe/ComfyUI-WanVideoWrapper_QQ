import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "WanVideoWrapper_QQ.ModelInfoDetector",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "WanVideoModelInfoDetector") {
            // Add custom styling and behavior for the model detector node
            const onNodeCreated = nodeType.prototype.onNodeCreated;

            nodeType.prototype.onNodeCreated = function() {
                if (onNodeCreated) {
                    onNodeCreated.apply(this, arguments);
                }

                // Add a custom widget to display detected information
                this.addWidget("text", "model_info", "", function() {}, {
                    multiline: true,
                    property: "model_info_display"
                });

                this.addWidget("text", "lora_info", "", function() {}, {
                    multiline: true,
                    property: "lora_info_display"
                });

                // Style the node
                this.bgcolor = "#2a2a3e";
                this.color = "#ffffff";
                this.shape = "box";

                // Add title styling
                this.title = "📊 Model Info Detector";
                this.title_text_color = "#4CAF50";

                // Resize to accommodate text displays
                this.size = [400, 200];
                this.resizable = true;
            };

            // Override the execution to update display widgets
            const onExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function(message) {
                if (onExecuted) {
                    onExecuted.apply(this, arguments);
                }

                // Update display widgets with execution results
                if (message && message.text) {
                    const outputs = message.text;

                    // Find and update model info widget
                    const modelInfoWidget = this.widgets?.find(w => w.name === "model_info");
                    if (modelInfoWidget && outputs.length > 1) {
                        modelInfoWidget.value = outputs[1] || "No model info available";
                    }

                    // Find and update lora info widget
                    const loraInfoWidget = this.widgets?.find(w => w.name === "lora_info");
                    if (loraInfoWidget && outputs.length > 2) {
                        loraInfoWidget.value = outputs[2] || "No LoRA info available";
                    }

                    // Trigger a redraw
                    this.setDirtyCanvas(true);
                }
            };

            // Add context menu options
            const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
            nodeType.prototype.getExtraMenuOptions = function(_, options) {
                if (getExtraMenuOptions) {
                    getExtraMenuOptions.apply(this, arguments);
                }

                options.push({
                    content: "📋 Copy Model Info",
                    callback: () => {
                        const modelWidget = this.widgets?.find(w => w.name === "model_info");
                        if (modelWidget && modelWidget.value) {
                            navigator.clipboard.writeText(modelWidget.value);
                            console.log("Model info copied to clipboard");
                        }
                    }
                });

                options.push({
                    content: "📋 Copy LoRA Info",
                    callback: () => {
                        const loraWidget = this.widgets?.find(w => w.name === "lora_info");
                        if (loraWidget && loraWidget.value) {
                            navigator.clipboard.writeText(loraWidget.value);
                            console.log("LoRA info copied to clipboard");
                        }
                    }
                });

                options.push({
                    content: "📋 Copy All Info",
                    callback: () => {
                        const modelWidget = this.widgets?.find(w => w.name === "model_info");
                        const loraWidget = this.widgets?.find(w => w.name === "lora_info");

                        let allInfo = "";
                        if (modelWidget && modelWidget.value) {
                            allInfo += modelWidget.value + "\n\n";
                        }
                        if (loraWidget && loraWidget.value) {
                            allInfo += loraWidget.value;
                        }

                        if (allInfo) {
                            navigator.clipboard.writeText(allInfo);
                            console.log("All model info copied to clipboard");
                        }
                    }
                });

                options.push({
                    content: "🔄 Refresh Display",
                    callback: () => {
                        // Trigger a re-execution to refresh the display
                        app.queuePrompt(0, 1);
                    }
                });
            };

            // Custom drawing for better visualization
            const onDrawForeground = nodeType.prototype.onDrawForeground;
            nodeType.prototype.onDrawForeground = function(ctx) {
                if (onDrawForeground) {
                    onDrawForeground.apply(this, arguments);
                }

                // Add status indicator
                const status = this.properties?.detection_status || "ready";
                let statusColor = "#4CAF50"; // green for ready

                if (status === "detecting") {
                    statusColor = "#FF9800"; // orange for detecting
                } else if (status === "error") {
                    statusColor = "#F44336"; // red for error
                }

                // Draw status indicator
                ctx.fillStyle = statusColor;
                ctx.beginPath();
                ctx.arc(this.size[0] - 15, 15, 5, 0, Math.PI * 2);
                ctx.fill();

                // Add helpful text if no info is displayed
                const modelWidget = this.widgets?.find(w => w.name === "model_info");
                const loraWidget = this.widgets?.find(w => w.name === "lora_info");

                if ((!modelWidget || !modelWidget.value) && (!loraWidget || !loraWidget.value)) {
                    ctx.fillStyle = "#888888";
                    ctx.font = "12px Arial";
                    ctx.textAlign = "center";
                    ctx.fillText("Connect a model input and execute to see info",
                               this.size[0] / 2, this.size[1] / 2);
                }
            };
        }
    }
});

// Add custom CSS for better styling
const style = document.createElement("style");
style.textContent = `
    .comfy-multiline-input {
        font-family: 'Courier New', monospace !important;
        font-size: 11px !important;
        line-height: 1.2 !important;
        background-color: #1e1e1e !important;
        color: #d4d4d4 !important;
        border: 1px solid #404040 !important;
        padding: 8px !important;
        white-space: pre-wrap !important;
        word-wrap: break-word !important;
        max-height: 200px !important;
        overflow-y: auto !important;
    }

    .litegraph .node.WanVideoModelInfoDetector {
        border: 2px solid #4CAF50 !important;
        border-radius: 8px !important;
    }

    .litegraph .node.WanVideoModelInfoDetector .title {
        background: linear-gradient(90deg, #4CAF50, #45a049) !important;
        color: white !important;
        font-weight: bold !important;
    }
`;

document.head.appendChild(style);

console.log("WanVideoWrapper_QQ Model Info Detector extension loaded");