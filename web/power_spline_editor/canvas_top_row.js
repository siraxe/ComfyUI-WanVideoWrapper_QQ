import { app } from '../../../scripts/app.js';
import {
    drawWidgetButton,
    drawNumberWidgetPart,
    RgthreeBaseWidget
} from './drawing_utils.js';
import { triggerPrepareRefsBackend } from './trigger_ref_refresh.js';

// === TOP ROW WIDGET (Combined refresh button, bg_image dropdown, and width/height controls) ===
export class TopRowWidget extends RgthreeBaseWidget {
    constructor(name = "TopRowWidget", visibility = {}) {
        super(name);
        this.type = "custom";
        this.options = { serialize: false };
        this.value = {};
        this.haveMouseMovedValue = false;
        this.canvasButtonMouseDown = false;
        this.framesButtonMouseDown = false;
        this.visibility = {
            refreshCanvasButton: true,
            refreshFramesButton: true,
            bgImgControl: true,
            animToggleButton: true,
            widthControl: true,
            heightControl: true,
            ...visibility,
        };
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

        const assignBounds = (name, bounds) => {
            const area = this.hitAreas[name];
            if (!area) return;
            area.bounds = bounds;
            area.onClick = null;
            area.onDown = null;
            area.onUp = null;
            area.onMove = null;
            area.onRightDown = null;
        };

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
        if (this.visibility.refreshCanvasButton) {
            drawWidgetButton(
                ctx,
                { size: [refreshCanvasWidth, height], pos: [posX, posY] },
                "🔃 Canvas",
                this.canvasButtonMouseDown
            );
        }
        assignBounds("refreshCanvasButton", [posX, refreshCanvasWidth]);
        posX += refreshCanvasWidth + spacing;

        // Draw Refresh Frames button
        if (this.visibility.refreshFramesButton) {
            drawWidgetButton(
                ctx,
                { size: [refreshFramesWidth, height], pos: [posX, posY] },
                "🕞 Frames",
                this.framesButtonMouseDown
            );
        }
        assignBounds("refreshFramesButton", [posX, refreshFramesWidth]);
        posX += refreshFramesWidth + spacing;

        // Draw bg_img control with left/right arrows
        const arrowWidth = 7; // Smaller arrows

        if (this.visibility.bgImgControl) {
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

            // Draw text value (centered in the control)
            ctx.fillText(bgImgValue, posX + bgImgDropdownWidth / 2, midY);

            // Draw right arrow (positioned at the very right edge)
            ctx.fillText(">", posX + bgImgDropdownWidth - arrowWidth / 2, midY);
        }

        assignBounds("bgImgLeftArrow", [posX, arrowWidth]);
        assignBounds("bgImgVal", [posX + arrowWidth, bgImgDropdownWidth - (arrowWidth * 2)]);
        assignBounds("bgImgRightArrow", [posX + bgImgDropdownWidth - arrowWidth, arrowWidth]);

        // Combined bounds for the entire control
        assignBounds("bgImgAny", [posX, bgImgDropdownWidth]);
        posX += bgImgDropdownWidth + spacing;

        // Animation toggle icon for inactive flow animation (default OFF)
        const isAnimOn = !!(node?.editor?._inactiveFlowEnabled ?? false);
        if (this.visibility.animToggleButton) {
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
        } else {
            assignBounds("animToggleButton", [posX, iconButtonWidth]);
        }
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
        if (this.visibility.widthControl) {
            ctx.textBaseline = "middle";
            ctx.textAlign = "left";
            ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
            ctx.fillText(widthLabel, widthControlX, midY);
        }

        // Draw width control (positioned after label)
        const widthControlStartX = widthControlX + labelWidth;
        const [wLeftArrow, wText, wRightArrow] = drawNumberWidgetPart(ctx, {
            posX: widthControlStartX,
            posY,
            height,
            value: widthValue,
            direction: 1,
            textColor: this.visibility.widthControl ? undefined : "transparent",
        });

        assignBounds("widthDec", wLeftArrow);
        assignBounds("widthVal", wText);
        assignBounds("widthInc", wRightArrow);
        assignBounds("widthAny", [wLeftArrow[0], wRightArrow[0] + wRightArrow[1] - wLeftArrow[0]]);
        if (this.visibility.widthControl) {
            this.hitAreas.widthDec.onClick = () => this.stepWidth(node, -16);
            this.hitAreas.widthInc.onClick = () => this.stepWidth(node, 16);
            this.hitAreas.widthVal.onClick = () => this.promptWidth(node);
            this.hitAreas.widthAny.onMove = (event) => this.dragWidth(node, event);
        }

        // Height control with label
        const heightControlX = widthControlStartX + numberControlWidth + controlSpacing;
        const heightLabel = "height:";

        // Draw height label
        if (this.visibility.heightControl) {
            ctx.textBaseline = "middle";
            ctx.fillText(heightLabel, heightControlX, midY);
        }

        // Draw height control (positioned after label)
        const heightControlStartX = heightControlX + labelWidth;
        const [hLeftArrow, hText, hRightArrow] = drawNumberWidgetPart(ctx, {
            posX: heightControlStartX,
            posY,
            height,
            value: heightValue,
            direction: 1,
            textColor: this.visibility.heightControl ? undefined : "transparent",
        });

        assignBounds("heightDec", hLeftArrow);
        assignBounds("heightVal", hText);
        assignBounds("heightInc", hRightArrow);
        assignBounds("heightAny", [hLeftArrow[0], hRightArrow[0] + hRightArrow[1] - hLeftArrow[0]]);
        if (this.visibility.heightControl) {
            this.hitAreas.heightDec.onClick = () => this.stepHeight(node, -16);
            this.hitAreas.heightInc.onClick = () => this.stepHeight(node, 16);
            this.hitAreas.heightVal.onClick = () => this.promptHeight(node);
            this.hitAreas.heightAny.onMove = (event) => this.dragHeight(node, event);
        }

        // Set up event handlers for refresh button
        if (this.visibility.refreshCanvasButton) {
            this.hitAreas.refreshCanvasButton.onClick = async () => {
                // Check if ref_images input is connected to PrepareRefs
                let isPrepareRefsConnected = false;
                let prepareRefsNode = null;
                try {
                    // Import the graph query function at the top of the file
                    const { findConnectedSourceNode } = await import('./graph_query.js');
                    const sourceNodeObj = findConnectedSourceNode(node, 'ref_images');
                    if (sourceNodeObj && sourceNodeObj.node) {
                        if (sourceNodeObj.node.type === 'PrepareRefs') {
                            console.log('[Refresh] PowerSplineEditor connected to PrepareRefs');
                            isPrepareRefsConnected = true;
                            prepareRefsNode = sourceNodeObj.node;
                        }
                    }
                } catch (e) {
                    console.warn('Failed to check ref_images connection:', e);
                }

                if (isPrepareRefsConnected && prepareRefsNode) {
                    // Trigger backend PrepareRefs processing
                    console.log('[Refresh] Triggering backend PrepareRefs processing...');
                    const result = await triggerPrepareRefsBackend(prepareRefsNode);

                    if (result.success) {
                        console.log('[Refresh] Backend processing complete, loading results...');

                        // Load the newly generated images from ref folder
                        await this.loadImagesFromRefFolder(node);

                        console.log('[Refresh] Canvas refresh complete');
                    } else {
                        // Silent error handling - log only, no user interruption
                        console.error('[Refresh] Backend processing failed:', result.error);
                    }
                } else {
                    // Original behavior: fetch from connected nodes
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
        }

        if (this.visibility.refreshFramesButton) {
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
        }

        // Set up event handlers for bg_img control
        if (this.visibility.bgImgControl) {
            this.hitAreas.bgImgLeftArrow.onClick = () => this.stepBgImg(node, -1);
            this.hitAreas.bgImgVal.onClick = () => this.stepBgImg(node, 1);
            this.hitAreas.bgImgRightArrow.onClick = () => this.stepBgImg(node, 1);
        }

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

    // Load images from ref folder when PrepareRefs is connected
    async loadImagesFromRefFolder(node) {
        const { loadImageAsBase64 } = await import('./graph_query.js');
        const timestamp = Date.now();

        // 1. Load bg_image_cl.png from ref folder
        try {
            const bgImageUrl = new URL(`ref/bg_image_cl.png?t=${timestamp}`, import.meta.url).href;
            const bgImageData = await loadImageAsBase64(bgImageUrl);

            if (bgImageData) {
                // Store the background image
                node.originalRefImageData = {
                    name: 'bg_image_cl.png',
                    base64: bgImageData.split(',')[1],
                    type: 'image/png'
                };

                // Update background image display based on current bg_img selection
                const bgImgWidget = node.widgets?.find(w => w.name === "bg_img");
                const bg_img = bgImgWidget ? bgImgWidget.value : "None";
                await node.updateBackgroundImage(bg_img);

                console.log('Successfully loaded bg_image_cl.png from ref folder');
            }
        } catch (e) {
            console.warn('Failed to load bg_image_cl.png from ref folder:', e);
        }

        // 2. Find and load all ref_*.png files from ref folder
        const refImages = [];
        const maxRefs = 5; // Try to load up to 5 reference images

        for (let i = 1; i <= maxRefs; i++) {
            try {
                const refImageUrl = new URL(`ref/ref_${i}.png?t=${timestamp}`, import.meta.url).href;
                const refImageData = await loadImageAsBase64(refImageUrl);

                if (refImageData) {
                    refImages.push(refImageData);
                    console.log(`Successfully loaded ref_${i}.png from ref folder`);
                } else {
                    // Stop trying if we can't load this image
                    break;
                }
            } catch (e) {
                // Stop trying if we encounter an error (file doesn't exist)
                console.log(`No more ref images found after ref_${i - 1}.png`);
                break;
            }
        }

        // 3. Update box layer refs with loaded images
        if (refImages.length > 0) {
            const activeWidget = node.layerManager?.getActiveWidget?.();
            if (!activeWidget || activeWidget.value?.type !== 'box_layer') {
                console.log('No active box layer to attach ref images');
                // Try to update all box layers instead
                await this.updateAllBoxLayersFromRefFolder(node, refImages);
            } else {
                // Update active box layer
                await this.updateBoxLayerWithRefImages(node, activeWidget, refImages);
            }
        }

        // Force a final render
        if (node.editor && node.editor.layerRenderer) {
            node.editor.layerRenderer.render();
        }
    }

    // Update a specific box layer with ref images from folder
    async updateBoxLayerWithRefImages(node, boxWidget, refImages) {
        const attachments = [];

        for (let i = 0; i < refImages.length; i++) {
            const imgData = refImages[i];
            const base64Data = imgData.startsWith('data:')
                ? imgData.split(',')[1]
                : imgData;
            const dataUrl = imgData.startsWith('data:')
                ? imgData
                : `data:image/png;base64,${base64Data}`;

            // Load dimensions
            const dims = await new Promise((resolve) => {
                const img = new Image();
                img.onload = () => resolve({ width: img.width, height: img.height });
                img.onerror = () => resolve({ width: 1, height: 1 });
                img.src = dataUrl;
            });

            const filename = `ref_${i + 1}.png`;
            attachments.push({
                path: `ref/${filename}`,
                type: 'image/png',
                width: dims.width,
                height: dims.height,
                name: filename
            });
        }

        boxWidget.value.ref_attachment = { entries: attachments };

        // Preserve existing ref_selection if valid, otherwise default to first ref
        const currentSelection = boxWidget.value.ref_selection;
        if (attachments.length > 0) {
            // Check if current selection is still valid
            if (currentSelection && currentSelection !== 'no_ref') {
                const refIndex = parseInt(currentSelection.split('_')[1], 10);
                if (refIndex > 0 && refIndex <= attachments.length) {
                    // Keep the current selection as it's still valid
                    boxWidget.value.ref_selection = currentSelection;
                } else {
                    // Current selection is out of range, default to ref_1
                    boxWidget.value.ref_selection = 'ref_1';
                }
            } else {
                // No current selection or it was 'no_ref', default to ref_1
                boxWidget.value.ref_selection = 'ref_1';
            }
        } else {
            boxWidget.value.ref_selection = 'no_ref';
        }

        // Clear ref image cache to force reload
        if (node.editor?.layerRenderer?.clearRefImageCache) {
            node.editor.layerRenderer.clearRefImageCache();
        }

        node.setDirtyCanvas(true, true);
    }

    // Update all box layers with ref images from folder
    async updateAllBoxLayersFromRefFolder(node, refImages) {
        const widgets = node.layerManager?.getSplineWidgets?.() || [];
        const boxWidgets = widgets.filter(w => w?.value?.type === 'box_layer');

        if (!boxWidgets.length) {
            console.log('No box layers found to update');
            return;
        }

        for (const boxWidget of boxWidgets) {
            await this.updateBoxLayerWithRefImages(node, boxWidget, refImages);
        }

        console.log(`Updated ${boxWidgets.length} box layer(s) with ref images from folder`);
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
