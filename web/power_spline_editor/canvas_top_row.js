import { app } from '../../../scripts/app.js';
import {
    drawWidgetButton,
    drawNumberWidgetPart,
    RgthreeBaseWidget
} from './drawing_utils.js';

// === TOP ROW WIDGET (Combined refresh button, bg_image dropdown, and width/height controls) ===
export class TopRowWidget extends RgthreeBaseWidget {
    constructor(name = "TopRowWidget") {
        super(name);
        this.type = "custom";
        this.options = { serialize: false };
        this.value = {};
        this.haveMouseMovedValue = false;
        this.canvasButtonMouseDown = false;
        this.framesButtonMouseDown = false;
        this.hitAreas = {
            refreshCanvasButton: { bounds: [0, 0], onClick: null },
            refreshFramesButton: { bounds: [0, 0], onClick: null },
            bgImgLeftArrow: { bounds: [0, 0], onClick: null },
            bgImgVal: { bounds: [0, 0], onClick: null },
            bgImgRightArrow: { bounds: [0, 0], onClick: null },
            bgImgAny: { bounds: [0, 0], onClick: null },
            widthDec: { bounds: [0, 0], onClick: null },
            widthVal: { bounds: [0, 0], onClick: null },
            widthInc: { bounds: [0, 0], onClick: null },
            widthAny: { bounds: [0, 0], onMove: null },
            heightDec: { bounds: [0, 0], onClick: null },
            heightVal: { bounds: [0, 0], onClick: null },
            heightInc: { bounds: [0, 0], onClick: null },
            heightAny: { bounds: [0, 0], onMove: null },
        };
    }

    draw(ctx, node, w, posY, height) {
        const margin = 15;
        const spacing = 10; // Reduced spacing to fit within 100%
        const midY = posY + height * 0.5;

        ctx.save();

        // Get widget values
        const widthWidget = node.widgets?.find(w => w.name === "mask_width");
        const widthValue = widthWidget ? widthWidget.value : 512;
        const heightWidget = node.widgets?.find(w => w.name === "mask_height");
        const heightValue = heightWidget ? heightWidget.value : 512;
        const bgImgWidget = node.widgets?.find(w => w.name === "bg_img");
        const bgImgValue = bgImgWidget ? bgImgWidget.value : "None";

        // Calculate available width for components (excluding margins and spacing)
        const availableWidth = node.size[0] - margin * 2 - spacing * 4; // Account for spacing between elements

        // Calculate component widths based on percentages (now totaling 100% of available width)
        const refreshCanvasWidth = availableWidth * 0.12;
        const refreshFramesWidth = availableWidth * 0.12;
        const bgImgDropdownWidth = availableWidth * 0.14;
        const iconButtonWidth = Math.max(20, Math.min(28, availableWidth * 0.05));
        const dimensionsAreaWidth = availableWidth - (
            refreshCanvasWidth + spacing +
            refreshFramesWidth + spacing +
            bgImgDropdownWidth + spacing +
            iconButtonWidth
        );

        // Calculate total width and starting position to center everything
        const totalWidth = refreshCanvasWidth + spacing + refreshFramesWidth + spacing + bgImgDropdownWidth + spacing + iconButtonWidth + spacing + dimensionsAreaWidth;
        const startX = margin; // Start from left margin instead of centering
        let posX = startX;

        // Draw Refresh Canvas button
        drawWidgetButton(
            ctx,
            { size: [refreshCanvasWidth, height], pos: [posX, posY] },
            "🔃 Canvas",
            this.canvasButtonMouseDown
        );
        this.hitAreas.refreshCanvasButton.bounds = [posX, refreshCanvasWidth];
        posX += refreshCanvasWidth + spacing;

        // Draw Refresh Frames button
        drawWidgetButton(
            ctx,
            { size: [refreshFramesWidth, height], pos: [posX, posY] },
            "🕞 Frames",
            this.framesButtonMouseDown
        );
        this.hitAreas.refreshFramesButton.bounds = [posX, refreshFramesWidth];
        posX += refreshFramesWidth + spacing;

        // Draw bg_img control with left/right arrows
        const arrowWidth = 7; // Smaller arrows

        // Draw background box
        ctx.fillStyle = LiteGraph.WIDGET_BGCOLOR;
        ctx.fillRect(posX, posY, bgImgDropdownWidth, height);
        ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
        ctx.strokeRect(posX, posY, bgImgDropdownWidth, height);

        // Draw left arrow (positioned at the very left edge)
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.fillText("<", posX + arrowWidth / 2, midY);
        this.hitAreas.bgImgLeftArrow.bounds = [posX, arrowWidth];

        // Draw text value (centered in the control)
        ctx.fillText(bgImgValue, posX + bgImgDropdownWidth / 2, midY);
        this.hitAreas.bgImgVal.bounds = [posX + arrowWidth, bgImgDropdownWidth - (arrowWidth * 2)];

        // Draw right arrow (positioned at the very right edge)
        ctx.fillText(">", posX + bgImgDropdownWidth - arrowWidth / 2, midY);
        this.hitAreas.bgImgRightArrow.bounds = [posX + bgImgDropdownWidth - arrowWidth, arrowWidth];

        // Combined bounds for the entire control
        this.hitAreas.bgImgAny.bounds = [posX, bgImgDropdownWidth];
        posX += bgImgDropdownWidth + spacing;

        // Animation toggle icon for inactive flow animation (default OFF)
        const isAnimOn = !!(node?.editor?._inactiveFlowEnabled ?? false);
        drawWidgetButton(
            ctx,
            { size: [iconButtonWidth, height], pos: [posX, posY] },
            "~", // wavy line icon
            isAnimOn
        );
        if (isAnimOn) {
            const pad = 0.5;
            ctx.save();
            ctx.strokeStyle = '#2cc6ff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.roundRect(posX + pad, posY + pad, iconButtonWidth - pad * 2, height - pad * 2, [4]);
            ctx.stroke();
            ctx.restore();
        }
        this.hitAreas.animToggleButton = { bounds: [posX, iconButtonWidth], onClick: (e, p, n) => {
            if (n?.editor) {
                n.editor._inactiveFlowEnabled = !n.editor._inactiveFlowEnabled;
                try { n.editor.layerRenderer?.updateInactiveDash?.(); } catch {}
                n.setDirtyCanvas(true, true);
            }
            return true;
        }};
        posX += iconButtonWidth + spacing;

        // Draw rounded area for width/height controls
        const roundedAreaX = posX;
        const roundedAreaY = posY;
        const roundedAreaWidth = dimensionsAreaWidth;
        const roundedAreaHeight = height;

        // Draw rounded rectangle background
        ctx.fillStyle = LiteGraph.WIDGET_BGCOLOR;
        ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
        ctx.beginPath();
        ctx.roundRect(roundedAreaX, roundedAreaY, roundedAreaWidth, roundedAreaHeight, [roundedAreaHeight * 0.5]);
        ctx.fill();
        ctx.stroke();

        // Calculate positions for width and height controls within the rounded area
        // Center the controls in the rounded area
        const controlSpacing = 20;
        const numberControlWidth = drawNumberWidgetPart.WIDTH_TOTAL; // Width of each number control
        const labelWidth = 40; // Approximate width for labels
        const totalControlWidth = labelWidth + numberControlWidth + controlSpacing + labelWidth + numberControlWidth;

        // Center the controls in the rounded area
        const controlsStartX = roundedAreaX + (roundedAreaWidth - totalControlWidth) / 2;

        // Width control with label
        const widthLabel = "width:";
        const widthControlX = controlsStartX;

        // Draw width label
        ctx.textAlign = "left";
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.fillText(widthLabel, widthControlX, midY);

        // Draw width control (positioned after label)
        const widthControlStartX = widthControlX + labelWidth;
        const [wLeftArrow, wText, wRightArrow] = drawNumberWidgetPart(ctx, {
            posX: widthControlStartX,
            posY,
            height,
            value: widthValue,
            direction: 1,
        });

        this.hitAreas.widthDec.bounds = wLeftArrow;
        this.hitAreas.widthVal.bounds = wText;
        this.hitAreas.widthInc.bounds = wRightArrow;
        this.hitAreas.widthAny.bounds = [wLeftArrow[0], wRightArrow[0] + wRightArrow[1] - wLeftArrow[0]];
        this.hitAreas.widthDec.onClick = () => this.stepWidth(node, -16);
        this.hitAreas.widthInc.onClick = () => this.stepWidth(node, 16);
        this.hitAreas.widthVal.onClick = () => this.promptWidth(node);
        this.hitAreas.widthAny.onMove = (event) => this.dragWidth(node, event);

        // Height control with label
        const heightControlX = widthControlStartX + numberControlWidth + controlSpacing;
        const heightLabel = "height:";

        // Draw height label
        ctx.fillText(heightLabel, heightControlX, midY);

        // Draw height control (positioned after label)
        const heightControlStartX = heightControlX + labelWidth;
        const [hLeftArrow, hText, hRightArrow] = drawNumberWidgetPart(ctx, {
            posX: heightControlStartX,
            posY,
            height,
            value: heightValue,
            direction: 1,
        });

        this.hitAreas.heightDec.bounds = hLeftArrow;
        this.hitAreas.heightVal.bounds = hText;
        this.hitAreas.heightInc.bounds = hRightArrow;
        this.hitAreas.heightAny.bounds = [hLeftArrow[0], hRightArrow[0] + hRightArrow[1] - hLeftArrow[0]];
        this.hitAreas.heightDec.onClick = () => this.stepHeight(node, -16);
        this.hitAreas.heightInc.onClick = () => this.stepHeight(node, 16);
        this.hitAreas.heightVal.onClick = () => this.promptHeight(node);
        this.hitAreas.heightAny.onMove = (event) => this.dragHeight(node, event);

        // Set up event handlers for refresh button
        this.hitAreas.refreshCanvasButton.onClick = async () => {
            // Update all box layer ref images from connected ref_images
            if (node.updateAllBoxLayerRefs) {
                try {
                    await node.updateAllBoxLayerRefs();
                } catch (e) {
                    console.warn('Failed to update box layer refs:', e);
                }
            }

            // Wait for reference image update and scale recalculation to complete
            if (node.updateReferenceImageFromConnectedNode) {
                try {
                    // This now properly awaits the image loading and scale recalculation
                    await node.updateReferenceImageFromConnectedNode();

                    // Force a final render with the correct scale
                    // The scale should already be correct from handleImageLoad -> recenterBackgroundImage
                    if (node.editor && node.editor.layerRenderer) {
                        node.editor.layerRenderer.render();
                    }
                } catch (e) {
                    console.warn('Failed to update reference image:', e);
                }
            }

            // Check for frames input and handle box layer keyframe scaling
            if (node.handleFramesRefresh) {
                node.handleFramesRefresh();
            }
        };
        this.hitAreas.refreshCanvasButton.onDown = () => {
            this.canvasButtonMouseDown = true;
            node.setDirtyCanvas(true, false);
        };
        this.hitAreas.refreshCanvasButton.onUp = () => {
            this.canvasButtonMouseDown = false;
            node.setDirtyCanvas(true, false);
        };

        this.hitAreas.refreshFramesButton.onClick = () => {
            if (node.handleFramesRefresh) {
                node.handleFramesRefresh();
            }
        };
        this.hitAreas.refreshFramesButton.onDown = () => {
            this.framesButtonMouseDown = true;
            node.setDirtyCanvas(true, false);
        };
        this.hitAreas.refreshFramesButton.onUp = () => {
            this.framesButtonMouseDown = false;
            node.setDirtyCanvas(true, false);
        };

        // Set up event handlers for bg_img control
        this.hitAreas.bgImgLeftArrow.onClick = () => this.stepBgImg(node, -1);
        this.hitAreas.bgImgVal.onClick = () => this.stepBgImg(node, 1);
        this.hitAreas.bgImgRightArrow.onClick = () => this.stepBgImg(node, 1);

        ctx.restore();
    }

    // Methods for width controls
    stepWidth(node, step) {
        const widthWidget = node.widgets?.find(w => w.name === "mask_width");
        if (widthWidget) {
            const newValue = widthWidget.value + step;
            widthWidget.value = node.sizeManager ? node.sizeManager.constrainCanvasWidth(newValue) : Math.max(64, newValue);
            if (widthWidget.callback) {
                widthWidget.callback(widthWidget.value);
            }
            node.setDirtyCanvas(true, true);
        }
    }

    promptWidth(node) {
        if (this.haveMouseMovedValue) return;
        const widthWidget = node.widgets?.find(w => w.name === "mask_width");
        if (widthWidget) {
            const canvas = app.canvas;
            canvas.prompt("Width", widthWidget.value, (v) => {
                const newValue = Number(v);
                widthWidget.value = node.sizeManager ? node.sizeManager.constrainCanvasWidth(newValue) : Math.max(64, newValue);
                if (widthWidget.callback) {
                    widthWidget.callback(widthWidget.value);
                }
            });
        }
    }

    dragWidth(node, event) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            const widthWidget = node.widgets?.find(w => w.name === "mask_width");
            if (widthWidget) {
                const newValue = widthWidget.value + event.deltaX * 2;
                widthWidget.value = node.sizeManager ? node.sizeManager.constrainCanvasWidth(newValue) : Math.max(64, newValue);
                if (widthWidget.callback) {
                    widthWidget.callback(widthWidget.value);
                }
                node.setDirtyCanvas(true, true);
            }
        }
    }

    // Methods for height controls
    stepHeight(node, step) {
        const heightWidget = node.widgets?.find(w => w.name === "mask_height");
        if (heightWidget) {
            const newValue = heightWidget.value + step;
            heightWidget.value = node.sizeManager ? node.sizeManager.constrainCanvasHeight(newValue) : Math.max(64, newValue);
            if (heightWidget.callback) {
                heightWidget.callback(heightWidget.value);
            }
            node.setDirtyCanvas(true, true);
        }
    }

    promptHeight(node) {
        if (this.haveMouseMovedValue) return;
        const heightWidget = node.widgets?.find(w => w.name === "mask_height");
        if (heightWidget) {
            const canvas = app.canvas;
            canvas.prompt("Height", heightWidget.value, (v) => {
                const newValue = Number(v);
                heightWidget.value = node.sizeManager ? node.sizeManager.constrainCanvasHeight(newValue) : Math.max(64, newValue);
                if (heightWidget.callback) {
                    heightWidget.callback(heightWidget.value);
                }
            });
        }
    }

    dragHeight(node, event) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            const heightWidget = node.widgets?.find(w => w.name === "mask_height");
            if (heightWidget) {
                const newValue = heightWidget.value + event.deltaX * 2;
                heightWidget.value = node.sizeManager ? node.sizeManager.constrainCanvasHeight(newValue) : Math.max(64, newValue);
                if (heightWidget.callback) {
                    heightWidget.callback(heightWidget.value);
                }
                node.setDirtyCanvas(true, true);
            }
        }
    }

    // Methods for bg_img controls
    stepBgImg(node, step) {
        const bgImgWidget = node.widgets?.find(w => w.name === "bg_img");
        if (bgImgWidget) {
            const options = ["None", "A", "B", "C"];
            const currentIndex = options.indexOf(bgImgWidget.value);
            const newIndex = (currentIndex + step + options.length) % options.length;
            bgImgWidget.value = options[newIndex];
            if (bgImgWidget.callback) {
                bgImgWidget.callback(bgImgWidget.value);
            }
            node.setDirtyCanvas(true, true);
        }
    }


    // Mouse event handlers
    mouse(event, pos, node) {
        // Use the parent's mouse handling which properly manages hit areas
        return super.mouse(event, pos, node);
    }

    onMouseUp(event, pos, node) {
        super.onMouseUp(event, pos, node);
        this.haveMouseMovedValue = false;
        this.canvasButtonMouseDown = false;
        this.framesButtonMouseDown = false;
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    }
}
