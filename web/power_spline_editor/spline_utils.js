import { app } from '../../../scripts/app.js';
import { showCustomDrivenToggleMenu } from './context_menu.js';
import { NodeSizeManager } from './node_size_manager.js';

// Re-export for convenience
export { NodeSizeManager };

//from melmass
export function makeUUID() {
  let dt = new Date().getTime()
  const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = ((dt + Math.random() * 16) % 16) | 0
    dt = Math.floor(dt / 16)
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
  return uuid
}

export const loadScript = (
    FILE_URL,
    async = true,
    type = 'text/javascript',
  ) => {
    return new Promise((resolve, reject) => {
      try {
        // Check if the script already exists
        const existingScript = document.querySelector(`script[src="${FILE_URL}"]`)
        if (existingScript) {
          resolve({ status: true, message: 'Script already loaded' })
          return
        }
  
        const scriptEle = document.createElement('script')
        scriptEle.type = type
        scriptEle.async = async
        scriptEle.src = FILE_URL
  
        scriptEle.addEventListener('load', (ev) => {
          resolve({ status: true })
        })
  
        scriptEle.addEventListener('error', (ev) => {
          reject({
            status: false,
            message: `Failed to load the script ${FILE_URL}`,
          })
        })
  
        document.body.appendChild(scriptEle)
      } catch (error) {
        reject(error)
      }
    })
  }
  
export const create_documentation_stylesheet = () => {
    const tag = 'qq-splineditor-stylesheet'

    let styleTag = document.head.querySelector(tag)

    if (!styleTag) {
      styleTag = document.createElement('style')
      styleTag.type = 'text/css'
      styleTag.id = tag
      styleTag.innerHTML = `
       .spline-editor {

        position: relative;

        font: 12px monospace;
        line-height: 1.5em;
        padding: 0px;
        z-index: 0;
        overflow: hidden;
        display: block;
       }
        `
      document.head.appendChild(styleTag)
    }
  }

// === CANVAS UTILITY FUNCTIONS (from power_lora_loader.js) ===
export function binarySearch(max, getValue, match) {
    let min = 0;
    while (min <= max) {
        let guess = Math.floor((min + max) / 2);
        const compareVal = getValue(guess);
        if (compareVal === match)
            return guess;
        if (compareVal < match)
            min = guess + 1;
        else
            max = guess - 1;
    }
    return max;
}

export function fitString(ctx, str, maxWidth) {
    let width = ctx.measureText(str).width;
    const ellipsis = "…";
    const ellipsisWidth = measureText(ctx, ellipsis);
    if (width <= maxWidth || width <= ellipsisWidth) {
        return str;
    }
    const index = binarySearch(str.length, (guess) => measureText(ctx, str.substring(0, guess)), maxWidth - ellipsisWidth);
    return str.substring(0, index) + ellipsis;
}

export function measureText(ctx, str) {
    return ctx.measureText(str).width;
}

export function isLowQuality() {
    var _a;
    const canvas = app.canvas;
    return (((_a = canvas.ds) === null || _a === void 0 ? void 0 : _a.scale) || 1) <= 0.5;
}

export function drawRoundedRectangle(ctx, options) {
    const lowQuality = isLowQuality();
    options = { ...options };
    ctx.save();
    ctx.strokeStyle = options.colorStroke || LiteGraph.WIDGET_OUTLINE_COLOR;
    ctx.fillStyle = options.colorBackground || LiteGraph.WIDGET_BGCOLOR;
    ctx.beginPath();
    ctx.roundRect(...options.pos, ...options.size, lowQuality ? [0] : options.borderRadius ? [options.borderRadius] : [options.size[1] * 0.5]);
    ctx.fill();
    !lowQuality && ctx.stroke();
    ctx.restore();
}

export function drawWidgetButton(ctx, options, text = null, isMouseDownedAndOver = false) {
    var _a;
    const borderRadius = isLowQuality() ? 0 : ((_a = options.borderRadius) !== null && _a !== void 0 ? _a : 4);
    ctx.save();
    if (!isLowQuality() && !isMouseDownedAndOver) {
        drawRoundedRectangle(ctx, {
            size: [options.size[0] - 2, options.size[1]],
            pos: [options.pos[0] + 1, options.pos[1] + 1],
            borderRadius,
            colorBackground: "#000000aa",
            colorStroke: "#000000aa",
        });
    }
    drawRoundedRectangle(ctx, {
        size: options.size,
        pos: [options.pos[0], options.pos[1] + (isMouseDownedAndOver ? 1 : 0)],
        borderRadius,
        colorBackground: isMouseDownedAndOver ? "#444" : LiteGraph.WIDGET_BGCOLOR,
        colorStroke: "transparent",
    });
    if (isLowQuality()) {
        ctx.restore();
        return;
    }
    if (!isMouseDownedAndOver) {
        drawRoundedRectangle(ctx, {
            size: [options.size[0] - 0.75, options.size[1] - 0.75],
            pos: options.pos,
            borderRadius: borderRadius - 0.5,
            colorBackground: "transparent",
            colorStroke: "#00000044",
        });
        drawRoundedRectangle(ctx, {
            size: [options.size[0] - 0.75, options.size[1] - 0.75],
            pos: [options.pos[0] + 0.75, options.pos[1] + 0.75],
            borderRadius: borderRadius - 0.5,
            colorBackground: "transparent",
            colorStroke: "#ffffff11",
        });
    }
    drawRoundedRectangle(ctx, {
        size: [options.size[0] - 1.5, options.size[1] - 1.5],
        pos: [options.pos[0] + 0.75, options.pos[1] + (isMouseDownedAndOver ? 1.75 : 0.75)],
        borderRadius: borderRadius - 1,
        colorBackground: "transparent",
        colorStroke: isMouseDownedAndOver ? "#00000088" : "#ffffff22",
    });
    if (text) {
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.fillText(text, options.pos[0] + options.size[0] / 2, options.pos[1] + options.size[1] / 2 + (isMouseDownedAndOver ? 1 : 0));
    }
    ctx.restore();
}

export function drawTogglePart(ctx, options) {
    const lowQuality = isLowQuality();
    ctx.save();
    const { posX, posY, height, value } = options;
    const toggleRadius = height * 0.36;
    const toggleBgWidth = height * 1.5;
    if (!lowQuality) {
        ctx.beginPath();
        ctx.roundRect(posX + 4, posY + 4, toggleBgWidth - 8, height - 8, [height * 0.5]);
        ctx.globalAlpha = app.canvas.editor_alpha * 0.25;
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.fill();
        ctx.globalAlpha = app.canvas.editor_alpha;
    }
    // Check for truthiness - objects (driven config) should render as "on"
    const isOn = !!value;
    ctx.fillStyle = isOn ? "#89B" : "#888";
    const toggleX = lowQuality || !value
        ? posX + height * 0.5
        : posX + height;
    ctx.beginPath();
    ctx.arc(toggleX, posY + height * 0.5, toggleRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return [posX, toggleBgWidth];
}

export function drawNumberWidgetPart(ctx, options) {
    const arrowWidth = 9;
    const arrowHeight = 10;
    const innerMargin = 3;
    const numberWidth = 32;
    const xBoundsArrowLess = [0, 0];
    const xBoundsNumber = [0, 0];
    const xBoundsArrowMore = [0, 0];
    ctx.save();
    let posX = options.posX;
    const { posY, height, value, textColor } = options;
    const midY = posY + height / 2;
    if (options.direction === -1) {
        posX = posX - arrowWidth - innerMargin - numberWidth - innerMargin - arrowWidth;
    }
    
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const oldTextcolor = ctx.fillStyle;
    if (textColor) {
        ctx.fillStyle = textColor;
    }

    // Draw left arrow
    ctx.fillText("◀", posX + arrowWidth / 2, midY);
    xBoundsArrowLess[0] = posX;
    xBoundsArrowLess[1] = arrowWidth;
    posX += arrowWidth + innerMargin;

    // Draw number with precision and suffix support
    const precision = options.precision !== undefined ? options.precision : 0;
    const suffix = options.suffix || "";
    const valueText = value.toFixed(precision) + suffix;
    ctx.fillText(fitString(ctx, valueText, numberWidth), posX + numberWidth / 2, midY);
    xBoundsNumber[0] = posX;
    xBoundsNumber[1] = numberWidth;
    posX += numberWidth + innerMargin;

    // Draw right arrow
    ctx.fillText("▶", posX + arrowWidth / 2, midY);
    xBoundsArrowMore[0] = posX;
    xBoundsArrowMore[1] = arrowWidth;

    ctx.fillStyle = oldTextcolor;
    ctx.restore();
    return [xBoundsArrowLess, xBoundsNumber, xBoundsArrowMore];
}
drawNumberWidgetPart.WIDTH_TOTAL = 9 + 3 + 32 + 3 + 9;

// === BASE WIDGET CLASS ===
export class RgthreeBaseWidget {
    constructor(name) {
        this.type = "custom";
        this.options = {};
        this.y = 0;
        this.last_y = 0;
        this.mouseDowned = null;
        this.isMouseDownedAndOver = false;
        this.hitAreas = {};
        this.downedHitAreasForMove = [];
        this.downedHitAreasForClick = [];
        this.name = name;
    }

    serializeValue(node, index) {
        return this.value;
    }

    clickWasWithinBounds(pos, bounds) {
        let xStart = bounds[0];
        let xEnd = xStart + (bounds.length > 2 ? bounds[2] : bounds[1]);
        const clickedX = pos[0] >= xStart && pos[0] <= xEnd;
        if (bounds.length === 2) {
            return clickedX;
        }
        return clickedX && pos[1] >= bounds[1] && pos[1] <= bounds[1] + bounds[3];
    }

    mouse(event, pos, node) {
        var _a, _b, _c;
        const canvas = app.canvas;
        if (event.type == "pointerdown") {
            this.mouseDowned = [...pos];
            this.isMouseDownedAndOver = true;
            this.downedHitAreasForMove.length = 0;
            this.downedHitAreasForClick.length = 0;
            let anyHandled = false;
            // Check if it's a right click (button 2)
            const isRightClick = event.button === 2;
            for (const part of Object.values(this.hitAreas)) {
                if (this.clickWasWithinBounds(pos, part.bounds)) {
                    if (part.onMove) {
                        this.downedHitAreasForMove.push(part);
                    }
                    if (part.onClick) {
                        this.downedHitAreasForClick.push(part);
                    }
                    // Check for right-click BEFORE calling onDown to prevent toggle from firing on right-click
                    if (isRightClick && part.onRightDown) {
                        const thisHandled = part.onRightDown.apply(this, [event, pos, node, part]);
                        anyHandled = anyHandled || thisHandled == true;
                    } else if (part.onDown) {
                        // Only call onDown if it's NOT a right-click with onRightDown
                        const thisHandled = part.onDown.apply(this, [event, pos, node, part]);
                        anyHandled = anyHandled || thisHandled == true;
                    }
                    part.wasMouseClickedAndIsOver = true;
                }
            }
            return (_a = this.onMouseDown(event, pos, node)) !== null && _a !== void 0 ? _a : anyHandled;
        }
        if (event.type == "pointerup") {
            if (!this.mouseDowned)
                return true;
            this.downedHitAreasForMove.length = 0;
            const wasMouseDownedAndOver = this.isMouseDownedAndOver;
            this.cancelMouseDown();
            let anyHandled = false;
            for (const part of Object.values(this.hitAreas)) {
                if (part.onUp && this.clickWasWithinBounds(pos, part.bounds)) {
                    const thisHandled = part.onUp.apply(this, [event, pos, node, part]);
                    anyHandled = anyHandled || thisHandled == true;
                }
                part.wasMouseClickedAndIsOver = false;
            }
            for (const part of this.downedHitAreasForClick) {
                if (this.clickWasWithinBounds(pos, part.bounds)) {
                    const thisHandled = part.onClick.apply(this, [event, pos, node, part]);
                    anyHandled = anyHandled || thisHandled == true;
                }
            }
            this.downedHitAreasForClick.length = 0;
            if (wasMouseDownedAndOver) {
                const thisHandled = this.onMouseClick(event, pos, node);
                anyHandled = anyHandled || thisHandled == true;
            }
            return (_b = this.onMouseUp(event, pos, node)) !== null && _b !== void 0 ? _b : anyHandled;
        }
        if (event.type == "pointermove") {
            this.isMouseDownedAndOver = !!this.mouseDowned;
            if (this.mouseDowned &&
                (pos[0] < 15 ||
                    pos[0] > node.size[0] - 15 ||
                    pos[1] < this.last_y ||
                    pos[1] > this.last_y + LiteGraph.NODE_WIDGET_HEIGHT)) {
                this.isMouseDownedAndOver = false;
            }
            for (const part of Object.values(this.hitAreas)) {
                if (this.downedHitAreasForMove.includes(part)) {
                    part.onMove.apply(this, [event, pos, node, part]);
                }
                if (this.downedHitAreasForClick.includes(part)) {
                    part.wasMouseClickedAndIsOver = this.clickWasWithinBounds(pos, part.bounds);
                }
            }
            return (_c = this.onMouseMove(event, pos, node)) !== null && _c !== void 0 ? _c : true;
        }
        return false;
    }

    cancelMouseDown() {
        this.mouseDowned = null;
        this.isMouseDownedAndOver = false;
        this.downedHitAreasForMove.length = 0;
    }

    onMouseDown(event, pos, node) {
        return;
    }

    onMouseUp(event, pos, node) {
        return;
    }

    onMouseClick(event, pos, node) {
        return;
    }

    onMouseMove(event, pos, node) {
        return;
    }
}

// === DIMENSIONS WIDGET ===
export class DimensionsWidget extends RgthreeBaseWidget {
    constructor(name = "DimensionsWidget") {
        super(name);
        this.type = "custom";
        this.options = { serialize: false };
        this.value = {};
        this.haveMouseMovedValue = false;
        this.hitAreas = {
            widthDec: { bounds: [0, 0] },
            widthVal: { bounds: [0, 0] },
            widthInc: { bounds: [0, 0] },
            widthAny: { bounds: [0, 0] },
            heightDec: { bounds: [0, 0] },
            heightVal: { bounds: [0, 0] },
            heightInc: { bounds: [0, 0] },
            heightAny: { bounds: [0, 0] },
        };
    }

    draw(ctx, node, w, posY, height) {
        const margin = 80; // Increased margin from sides
        const innerMargin = 10; // Reduced space between label and number
        const spacingBetweenControls = 30; // Space between width and height controls
        const midY = posY + height * 0.5;

        ctx.save();
        drawRoundedRectangle(ctx, { pos: [margin, posY], size: [node.size[0] - margin * 2, height] });

        if (isLowQuality()) {
            ctx.restore();
            return;
        }

        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.textBaseline = "middle";

        const widthWidget = node.widgets?.find(w => w.name === "mask_width");
        const widthValue = widthWidget ? widthWidget.value : 512;
        const heightWidget = node.widgets?.find(w => w.name === "mask_height");
        const heightValue = heightWidget ? heightWidget.value : 512;

        // Standardize label widths for alignment across widgets
        const widthLabel = "width:";
        const heightLabel = "height:";
        const maxLeftLabelWidth = Math.max(ctx.measureText(widthLabel).width, ctx.measureText("start_pause:").width);
        const maxRightLabelWidth = Math.max(ctx.measureText(heightLabel).width, ctx.measureText("end_pause:").width);

        const totalWidth = maxLeftLabelWidth + innerMargin + drawNumberWidgetPart.WIDTH_TOTAL +
                          spacingBetweenControls +
                          maxRightLabelWidth + innerMargin + drawNumberWidgetPart.WIDTH_TOTAL;

        const startX = (node.size[0] - totalWidth) / 2;
        let posX = startX;

        // Draw "width:" label (right-aligned)
        ctx.textAlign = "right";
        ctx.fillText(widthLabel, posX + maxLeftLabelWidth, midY);
        posX += maxLeftLabelWidth + innerMargin;

        // Draw width control
        const [wLeftArrow, wText, wRightArrow] = drawNumberWidgetPart(ctx, {
            posX: posX,
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

        posX += drawNumberWidgetPart.WIDTH_TOTAL + spacingBetweenControls;

        // Draw "height:" label (right-aligned)
        ctx.textAlign = "right";
        ctx.fillText(heightLabel, posX + maxRightLabelWidth, midY);
        posX += maxRightLabelWidth + innerMargin;

        // Draw height control
        const [hLeftArrow, hText, hRightArrow] = drawNumberWidgetPart(ctx, {
            posX: posX,
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

        ctx.restore();
    }

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

    onMouseUp(event, pos, node) {
        super.onMouseUp(event, pos, node);
        this.haveMouseMovedValue = false;
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    }
}

// === INTERPOLATION WIDGET ===
export class InterpolationWidget extends RgthreeBaseWidget {
    constructor(name = "InterpolationWidget") {
        super(name);
        this.type = "custom";
        this.options = { serialize: false };
        this.value = {};
        this.haveMouseMovedValue = false;
        this.hitAreas = {
            interpDec: { bounds: [0, 0] },
            interpVal: { bounds: [0, 0] },
            interpInc: { bounds: [0, 0] },
            interpAny: { bounds: [0, 0] },
        };
    }

    draw(ctx, node, w, posY, height) {
        const margin = 130;
        const innerMargin = 10;
        const midY = posY + height * 0.5;

        ctx.save();
        drawRoundedRectangle(ctx, { pos: [margin, posY], size: [node.size[0] - margin * 2, height] });

        if (isLowQuality()) {
            ctx.restore();
            return;
        }

        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.textBaseline = "middle";

        const interpWidget = node.widgets?.find(w => w.name === "interpolation");
        const interpValue = interpWidget ? interpWidget.value : "linear";

        // Interpolation modes - display abbreviated versions
        const interpModes = ['linear', 'cardinal', 'basis', 'points'];
        const interpShortNames = ['linear', 'cardinal', 'basis', 'points'];
        const interpIndex = interpModes.indexOf(interpValue);
        const interpDisplayText = interpIndex >= 0 ? interpShortNames[interpIndex] : 'linear';

        // Label
        const interpLabel = "interpolation:";
        const maxLabelWidth = Math.max(
            ctx.measureText("width:").width,
            ctx.measureText("start_pause:").width,
            ctx.measureText("offset:").width,
            ctx.measureText(interpLabel).width
        );

        // Calculate interpolation text width
        const interpTextWidth = Math.max(
            ctx.measureText("cardinal").width,
            ctx.measureText("linear").width,
            ctx.measureText("basis").width,
            ctx.measureText("points").width
        ) + 20; // Add padding

        const arrowWidth = 9;
        const innerMargin2 = 3;
        const totalWidth = maxLabelWidth + innerMargin + arrowWidth + innerMargin2 + interpTextWidth + innerMargin2 + arrowWidth;

        const startX = (node.size[0] - totalWidth) / 2;
        let posX = startX;

        // Draw "interpolation:" label (right-aligned)
        ctx.textAlign = "right";
        ctx.fillText(interpLabel, posX + maxLabelWidth, midY);
        posX += maxLabelWidth + innerMargin;

        // Left arrow bounds
        this.hitAreas.interpDec.bounds = [posX, arrowWidth];
        ctx.textAlign = "center";
        ctx.fillText("◀", posX + arrowWidth / 2, midY);
        posX += arrowWidth + innerMargin2;

        // Text bounds
        this.hitAreas.interpVal.bounds = [posX, interpTextWidth];
        ctx.fillText(interpDisplayText, posX + interpTextWidth / 2, midY);
        posX += interpTextWidth + innerMargin2;

        // Right arrow bounds
        this.hitAreas.interpInc.bounds = [posX, arrowWidth];
        ctx.fillText("▶", posX + arrowWidth / 2, midY);

        // Combined bounds for all interp controls
        this.hitAreas.interpAny.bounds = [this.hitAreas.interpDec.bounds[0], arrowWidth + innerMargin2 + interpTextWidth + innerMargin2 + arrowWidth];
        this.hitAreas.interpDec.onClick = () => this.stepInterp(node, -1);
        this.hitAreas.interpInc.onClick = () => this.stepInterp(node, 1);
        this.hitAreas.interpVal.onClick = () => this.cycleInterp(node);

        ctx.restore();
    }

    stepInterp(node, step) {
        const widget = node.widgets?.find(w => w.name === "interpolation");
        if (widget) {
            const modes = ['linear', 'cardinal', 'basis', 'points'];
            const currentIndex = modes.indexOf(widget.value);
            const newIndex = (currentIndex + step + modes.length) % modes.length;
            widget.value = modes[newIndex];
            if (widget.callback) widget.callback(widget.value);
            node.setDirtyCanvas(true, true);
        }
    }

    cycleInterp(node) {
        // Clicking the text cycles through modes
        this.stepInterp(node, 1);
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    }
}

// === DRIVER ROTATION & D_SCALE WIDGET (Combined driver_rotation and driver_d_scale) ===
export class DriverRotationDScaleWidget extends RgthreeBaseWidget {
    constructor(name = "DriverRotationDScaleWidget") {
        super(name);
        this.type = "custom";
        this.options = { serialize: false };
        this.value = {};
        this.haveMouseMovedValue = false;
        this.hitAreas = {
            rotationDec: { bounds: [0, 0] },
            rotationVal: { bounds: [0, 0] },
            rotationInc: { bounds: [0, 0] },
            rotationAny: { bounds: [0, 0] },
            dScaleDec: { bounds: [0, 0] },
            dScaleVal: { bounds: [0, 0] },
            dScaleInc: { bounds: [0, 0] },
            dScaleAny: { bounds: [0, 0] },
        };
    }

    draw(ctx, node, w, posY, height) {
        const margin = 40;
        const innerMargin = 10;
        const spacingBetweenGroups = 20;
        const midY = posY + height * 0.5;

        ctx.save();
        drawRoundedRectangle(ctx, { pos: [margin, posY], size: [node.size[0] - margin * 2, height] });

        if (isLowQuality()) {
            ctx.restore();
            return;
        }

        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.textBaseline = "middle";

        const rotationWidget = node.widgets?.find(w => w.name === "driver_rotation");
        const rotationValue = rotationWidget ? rotationWidget.value : 0;
        const dScaleWidget = node.widgets?.find(w => w.name === "driver_d_scale");
        const dScaleValue = dScaleWidget ? dScaleWidget.value : 1.0;

        // Labels
        const rotationLabel = "driver_rotation:";
        const dScaleLabel = "driver_d_scale:";
        const maxLeftLabelWidth = Math.max(
            ctx.measureText("width:").width,
            ctx.measureText("driver_rotation:").width
        );
        const maxRightLabelWidth = Math.max(
            ctx.measureText("height:").width,
            ctx.measureText("driver_d_scale:").width
        );

        // Total width: left label + controls + spacing + right label + controls
        const totalWidth = maxLeftLabelWidth + innerMargin +
                          drawNumberWidgetPart.WIDTH_TOTAL +
                          spacingBetweenGroups +
                          maxRightLabelWidth + innerMargin +
                          drawNumberWidgetPart.WIDTH_TOTAL;

        const startX = (node.size[0] - totalWidth) / 2;
        let posX = startX;

        // Draw "driver_rotation:" label (right-aligned)
        ctx.textAlign = "right";
        ctx.fillText(rotationLabel, posX + maxLeftLabelWidth, midY);
        posX += maxLeftLabelWidth + innerMargin;

        // Draw rotation control (with ° suffix)
        const [rLeftArrow, rText, rRightArrow] = drawNumberWidgetPart(ctx, {
            posX: posX,
            posY,
            height,
            value: rotationValue,
            direction: 1,
            suffix: "°"
        });

        this.hitAreas.rotationDec.bounds = rLeftArrow;
        this.hitAreas.rotationVal.bounds = rText;
        this.hitAreas.rotationInc.bounds = rRightArrow;
        this.hitAreas.rotationAny.bounds = [rLeftArrow[0], rRightArrow[0] + rRightArrow[1] - rLeftArrow[0]];
        this.hitAreas.rotationDec.onClick = () => this.stepRotation(node, -15);
        this.hitAreas.rotationInc.onClick = () => this.stepRotation(node, 15);
        this.hitAreas.rotationVal.onClick = () => this.promptRotation(node);
        this.hitAreas.rotationAny.onMove = (event) => this.dragRotation(node, event);

        posX += drawNumberWidgetPart.WIDTH_TOTAL + spacingBetweenGroups;

        // Draw "driver_d_scale:" label (right-aligned)
        ctx.textAlign = "right";
        ctx.fillText(dScaleLabel, posX + maxRightLabelWidth, midY);
        posX += maxRightLabelWidth + innerMargin;

        // Draw d_scale control
        const [sLeftArrow, sText, sRightArrow] = drawNumberWidgetPart(ctx, {
            posX: posX,
            posY,
            height,
            value: dScaleValue,
            direction: 1,
            precision: 2
        });

        this.hitAreas.dScaleDec.bounds = sLeftArrow;
        this.hitAreas.dScaleVal.bounds = sText;
        this.hitAreas.dScaleInc.bounds = sRightArrow;
        this.hitAreas.dScaleAny.bounds = [sLeftArrow[0], sRightArrow[0] + sRightArrow[1] - sLeftArrow[0]];
        this.hitAreas.dScaleDec.onClick = () => this.stepDScale(node, -0.01);
        this.hitAreas.dScaleInc.onClick = () => this.stepDScale(node, 0.01);
        this.hitAreas.dScaleVal.onClick = () => this.promptDScale(node);
        this.hitAreas.dScaleAny.onMove = (event) => this.dragDScale(node, event);

        ctx.restore();
    }

    stepRotation(node, step) {
        const widget = node.widgets?.find(w => w.name === "driver_rotation");
        if (widget) {
            widget.value = Math.max(-360, Math.min(360, widget.value + step));
            if (widget.callback) widget.callback(widget.value);
            node.setDirtyCanvas(true, true);
        }
    }
    promptRotation(node) {
        if (this.haveMouseMovedValue) return;
        const widget = node.widgets?.find(w => w.name === "driver_rotation");
        if (widget) {
            app.canvas.prompt("driver_rotation", widget.value, (v) => {
                widget.value = Math.max(-360, Math.min(360, Number(v)));
                if (widget.callback) widget.callback(widget.value);
            });
        }
    }
    dragRotation(node, event) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            const widget = node.widgets?.find(w => w.name === "driver_rotation");
            if (widget) {
                widget.value = Math.max(-360, Math.min(360, widget.value + event.deltaX));
                if (widget.callback) widget.callback(widget.value);
                node.setDirtyCanvas(true, true);
            }
        }
    }

    stepDScale(node, step) {
        const widget = node.widgets?.find(w => w.name === "driver_d_scale");
        if (widget) {
            widget.value = Math.max(0.0, Math.min(1.0, widget.value + step));
            if (widget.callback) widget.callback(widget.value);
            node.setDirtyCanvas(true, true);
        }
    }
    promptDScale(node) {
        if (this.haveMouseMovedValue) return;
        const widget = node.widgets?.find(w => w.name === "driver_d_scale");
        if (widget) {
            app.canvas.prompt("driver_d_scale", widget.value, (v) => {
                widget.value = Math.max(0.0, Math.min(1.0, Number(v)));
                if (widget.callback) widget.callback(widget.value);
            });
        }
    }
    dragDScale(node, event) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            const widget = node.widgets?.find(w => w.name === "driver_d_scale");
            if (widget) {
                widget.value = Math.max(0.0, Math.min(1.0, widget.value + event.deltaX * 0.01)); // Scale for float precision
                if (widget.callback) widget.callback(widget.value);
                node.setDirtyCanvas(true, true);
            }
        }
    }

    onMouseUp(event, pos, node) {
        super.onMouseUp(event, pos, node);
        this.haveMouseMovedValue = false;
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    }
}

// === PAUSE WIDGET (Combined start_pause and end_pause) ===
export class PauseWidget extends RgthreeBaseWidget {
    constructor(name = "PauseWidget") {
        super(name);
        this.type = "custom";
        this.options = { serialize: false };
        this.value = {};
        this.haveMouseMovedValue = false;
        this.hitAreas = {
            startPauseDec: { bounds: [0, 0] },
            startPauseVal: { bounds: [0, 0] },
            startPauseInc: { bounds: [0, 0] },
            startPauseAny: { bounds: [0, 0] },
            endPauseDec: { bounds: [0, 0] },
            endPauseVal: { bounds: [0, 0] },
            endPauseInc: { bounds: [0, 0] },
            endPauseAny: { bounds: [0, 0] },
        };
    }

    draw(ctx, node, w, posY, height) {
        const margin = 40;
        const innerMargin = 10;
        const spacingBetweenGroups = 20; // Space between start_pause and end_pause
        const midY = posY + height * 0.5;

        ctx.save();
        drawRoundedRectangle(ctx, { pos: [margin, posY], size: [node.size[0] - margin * 2, height] });

        if (isLowQuality()) {
            ctx.restore();
            return;
        }

        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.textBaseline = "middle";

        const startPauseWidget = node.widgets?.find(w => w.name === "start_pause");
        const startPauseValue = startPauseWidget ? startPauseWidget.value : 0;
        const endPauseWidget = node.widgets?.find(w => w.name === "end_pause");
        const endPauseValue = endPauseWidget ? endPauseWidget.value : 0;

        // Labels
        const startLabel = "start_pause:";
        const endLabel = "end_pause:";
        const maxLeftLabelWidth = Math.max(
            ctx.measureText("width:").width,
            ctx.measureText("start_pause:").width,
            ctx.measureText("offset:").width,
            ctx.measureText("interpolation:").width
        );
        const maxRightLabelWidth = Math.max(
            ctx.measureText("height:").width,
            ctx.measureText("end_pause:").width,
            ctx.measureText("repeat:").width
        );

        // Total width: left label + controls + spacing + right label + controls
        const totalWidth = maxLeftLabelWidth + innerMargin +
                          drawNumberWidgetPart.WIDTH_TOTAL +
                          spacingBetweenGroups +
                          maxRightLabelWidth + innerMargin +
                          drawNumberWidgetPart.WIDTH_TOTAL;

        const startX = (node.size[0] - totalWidth) / 2;
        let posX = startX;

        // Draw "start_pause:" label (right-aligned)
        ctx.textAlign = "right";
        ctx.fillText(startLabel, posX + maxLeftLabelWidth, midY);
        posX += maxLeftLabelWidth + innerMargin;

        // Draw start_pause control
        const [spLeftArrow, spText, spRightArrow] = drawNumberWidgetPart(ctx, {
            posX: posX,
            posY,
            height,
            value: startPauseValue,
            direction: 1,
        });

        this.hitAreas.startPauseDec.bounds = spLeftArrow;
        this.hitAreas.startPauseVal.bounds = spText;
        this.hitAreas.startPauseInc.bounds = spRightArrow;
        this.hitAreas.startPauseAny.bounds = [spLeftArrow[0], spRightArrow[0] + spRightArrow[1] - spLeftArrow[0]];
        this.hitAreas.startPauseDec.onClick = () => this.stepStartPause(node, -1);
        this.hitAreas.startPauseInc.onClick = () => this.stepStartPause(node, 1);
        this.hitAreas.startPauseVal.onClick = () => this.promptStartPause(node);
        this.hitAreas.startPauseAny.onMove = (event) => this.dragStartPause(node, event);

        posX += drawNumberWidgetPart.WIDTH_TOTAL + spacingBetweenGroups;

        // Draw "end_pause:" label (right-aligned)
        ctx.textAlign = "right";
        ctx.fillText(endLabel, posX + maxRightLabelWidth, midY);
        posX += maxRightLabelWidth + innerMargin;

        // Draw end_pause control
        const [epLeftArrow, epText, epRightArrow] = drawNumberWidgetPart(ctx, {
            posX: posX,
            posY,
            height,
            value: endPauseValue,
            direction: 1,
        });

        this.hitAreas.endPauseDec.bounds = epLeftArrow;
        this.hitAreas.endPauseVal.bounds = epText;
        this.hitAreas.endPauseInc.bounds = epRightArrow;
        this.hitAreas.endPauseAny.bounds = [epLeftArrow[0], epRightArrow[0] + epRightArrow[1] - epLeftArrow[0]];
        this.hitAreas.endPauseDec.onClick = () => this.stepEndPause(node, -1);
        this.hitAreas.endPauseInc.onClick = () => this.stepEndPause(node, 1);
        this.hitAreas.endPauseVal.onClick = () => this.promptEndPause(node);
        this.hitAreas.endPauseAny.onMove = (event) => this.dragEndPause(node, event);

        ctx.restore();
    }

    stepStartPause(node, step) {
        const widget = node.widgets?.find(w => w.name === "start_pause");
        if (widget) {
            widget.value = Math.max(0, widget.value + step);
            if (widget.callback) widget.callback(widget.value);
            node.setDirtyCanvas(true, true);
        }
    }
    promptStartPause(node) {
        if (this.haveMouseMovedValue) return;
        const widget = node.widgets?.find(w => w.name === "start_pause");
        if (widget) {
            app.canvas.prompt("start_pause", widget.value, (v) => {
                widget.value = Math.max(0, Number(v));
                if (widget.callback) widget.callback(widget.value);
            });
        }
    }
    dragStartPause(node, event) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            const widget = node.widgets?.find(w => w.name === "start_pause");
            if (widget) {
                widget.value = Math.max(0, widget.value + event.deltaX);
                if (widget.callback) widget.callback(widget.value);
                node.setDirtyCanvas(true, true);
            }
        }
    }

    stepEndPause(node, step) {
        const widget = node.widgets?.find(w => w.name === "end_pause");
        if (widget) {
            widget.value = Math.max(0, widget.value + step);
            if (widget.callback) widget.callback(widget.value);
            node.setDirtyCanvas(true, true);
        }
    }
    promptEndPause(node) {
        if (this.haveMouseMovedValue) return;
        const widget = node.widgets?.find(w => w.name === "end_pause");
        if (widget) {
            app.canvas.prompt("end_pause", widget.value, (v) => {
                widget.value = Math.max(0, Number(v));
                if (widget.callback) widget.callback(widget.value);
            });
        }
    }
    dragEndPause(node, event) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            const widget = node.widgets?.find(w => w.name === "end_pause");
            if (widget) {
                widget.value = Math.max(0, widget.value + event.deltaX);
                if (widget.callback) widget.callback(widget.value);
                node.setDirtyCanvas(true, true);
            }
        }
    }

    onMouseUp(event, pos, node) {
        super.onMouseUp(event, pos, node);
        this.haveMouseMovedValue = false;
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    }
}

// === OFFSET REPEAT WIDGET (Combined offset and repeat) ===
export class OffsetRepeatWidget extends RgthreeBaseWidget {
    constructor(name = "OffsetRepeatWidget") {
        super(name);
        this.type = "custom";
        this.options = { serialize: false };
        this.value = {};
        this.haveMouseMovedValue = false;
        this.hitAreas = {
            offsetDec: { bounds: [0, 0] },
            offsetVal: { bounds: [0, 0] },
            offsetInc: { bounds: [0, 0] },
            offsetAny: { bounds: [0, 0] },
            repeatDec: { bounds: [0, 0] },
            repeatVal: { bounds: [0, 0] },
            repeatInc: { bounds: [0, 0] },
            repeatAny: { bounds: [0, 0] },
        };
    }

    draw(ctx, node, w, posY, height) {
        const margin = 40;
        const innerMargin = 10;
        const spacingBetweenGroups = 20; // Space between offset and repeat
        const midY = posY + height * 0.5;

        ctx.save();
        drawRoundedRectangle(ctx, { pos: [margin, posY], size: [node.size[0] - margin * 2, height] });

        if (isLowQuality()) {
            ctx.restore();
            return;
        }

        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.textBaseline = "middle";

        const offsetWidget = node.widgets?.find(w => w.name === "offset");
        const offsetValue = offsetWidget ? offsetWidget.value : 0;
        const repeatWidget = node.widgets?.find(w => w.name === "repeat");
        const repeatValue = repeatWidget ? repeatWidget.value : 1;

        // Labels
        const offsetLabel = "offset:";
        const repeatLabel = "repeat:";
        const maxLeftLabelWidth = Math.max(
            ctx.measureText("width:").width,
            ctx.measureText("start_pause:").width,
            ctx.measureText("offset:").width,
            ctx.measureText("interpolation:").width
        );
        const maxRightLabelWidth = Math.max(
            ctx.measureText("height:").width,
            ctx.measureText("end_pause:").width,
            ctx.measureText("repeat:").width
        );

        // Total width: left label + controls + spacing + right label + controls
        const totalWidth = maxLeftLabelWidth + innerMargin +
                          drawNumberWidgetPart.WIDTH_TOTAL +
                          spacingBetweenGroups +
                          maxRightLabelWidth + innerMargin +
                          drawNumberWidgetPart.WIDTH_TOTAL;

        const startX = (node.size[0] - totalWidth) / 2;
        let posX = startX;

        // Draw "offset:" label (right-aligned)
        ctx.textAlign = "right";
        ctx.fillText(offsetLabel, posX + maxLeftLabelWidth, midY);
        posX += maxLeftLabelWidth + innerMargin;

        // Draw offset control
        const [oLeftArrow, oText, oRightArrow] = drawNumberWidgetPart(ctx, {
            posX: posX,
            posY,
            height,
            value: offsetValue,
            direction: 1,
        });

        this.hitAreas.offsetDec.bounds = oLeftArrow;
        this.hitAreas.offsetVal.bounds = oText;
        this.hitAreas.offsetInc.bounds = oRightArrow;
        this.hitAreas.offsetAny.bounds = [oLeftArrow[0], oRightArrow[0] + oRightArrow[1] - oLeftArrow[0]];
        this.hitAreas.offsetDec.onClick = () => this.stepOffset(node, -1);
        this.hitAreas.offsetInc.onClick = () => this.stepOffset(node, 1);
        this.hitAreas.offsetVal.onClick = () => this.promptOffset(node);
        this.hitAreas.offsetAny.onMove = (event) => this.dragOffset(node, event);

        posX += drawNumberWidgetPart.WIDTH_TOTAL + spacingBetweenGroups;

        // Draw "repeat:" label (right-aligned)
        ctx.textAlign = "right";
        ctx.fillText(repeatLabel, posX + maxRightLabelWidth, midY);
        posX += maxRightLabelWidth + innerMargin;

        // Draw repeat control
        const [rLeftArrow, rText, rRightArrow] = drawNumberWidgetPart(ctx, {
            posX: posX,
            posY,
            height,
            value: repeatValue,
            direction: 1,
        });

        this.hitAreas.repeatDec.bounds = rLeftArrow;
        this.hitAreas.repeatVal.bounds = rText;
        this.hitAreas.repeatInc.bounds = rRightArrow;
        this.hitAreas.repeatAny.bounds = [rLeftArrow[0], rRightArrow[0] + rRightArrow[1] - rLeftArrow[0]];
        this.hitAreas.repeatDec.onClick = () => this.stepRepeat(node, -1);
        this.hitAreas.repeatInc.onClick = () => this.stepRepeat(node, 1);
        this.hitAreas.repeatVal.onClick = () => this.promptRepeat(node);
        this.hitAreas.repeatAny.onMove = (event) => this.dragRepeat(node, event);

        ctx.restore();
    }

    stepOffset(node, step) {
        const widget = node.widgets?.find(w => w.name === "offset");
        if (widget) {
            widget.value = Math.max(-100, Math.min(100, widget.value + step));
            if (widget.callback) widget.callback(widget.value);
            node.setDirtyCanvas(true, true);
        }
    }
    promptOffset(node) {
        if (this.haveMouseMovedValue) return;
        const widget = node.widgets?.find(w => w.name === "offset");
        if (widget) {
            app.canvas.prompt("offset", widget.value, (v) => {
                widget.value = Math.max(-100, Math.min(100, Number(v)));
                if (widget.callback) widget.callback(widget.value);
            });
        }
    }
    dragOffset(node, event) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            const widget = node.widgets?.find(w => w.name === "offset");
            if (widget) {
                widget.value = Math.max(-100, Math.min(100, widget.value + event.deltaX));
                if (widget.callback) widget.callback(widget.value);
                node.setDirtyCanvas(true, true);
            }
        }
    }

    stepRepeat(node, step) {
        const widget = node.widgets?.find(w => w.name === "repeat");
        if (widget) {
            widget.value = Math.max(1, Math.min(20, widget.value + step));
            if (widget.callback) widget.callback(widget.value);
            node.setDirtyCanvas(true, true);
        }
    }
    promptRepeat(node) {
        if (this.haveMouseMovedValue) return;
        const widget = node.widgets?.find(w => w.name === "repeat");
        if (widget) {
            app.canvas.prompt("repeat", widget.value, (v) => {
                widget.value = Math.max(1, Math.min(20, Number(v)));
                if (widget.callback) widget.callback(widget.value);
            });
        }
    }
    dragRepeat(node, event) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            const widget = node.widgets?.find(w => w.name === "repeat");
            if (widget) {
                widget.value = Math.max(1, Math.min(20, widget.value + Math.round(event.deltaX / 10)));
                if (widget.callback) widget.callback(widget.value);
                node.setDirtyCanvas(true, true);
            }
        }
    }

    onMouseUp(event, pos, node) {
        super.onMouseUp(event, pos, node);
        this.haveMouseMovedValue = false;
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    }
}

// === SPLINE MULTI WIDGET ===
export class PowerSplineHeaderWidget extends RgthreeBaseWidget {
    constructor(name = "PowerSplineHeaderWidget") {
        super(name);
        this.value = { type: "PowerSplineHeaderWidget" };
        this.type = "custom";
        this.options = { serialize: false };
        this.hitAreas = {
            toggle: { bounds: [0, 0], onDown: this.onToggleDown },
        };
    }

    draw(ctx, node, w, posY, height) {
        const margin = 10;
        const innerMargin = margin * 0.33;
        const lowQuality = isLowQuality();
        const allSplineState = node.allSplinesState ? node.allSplinesState() : false;
        posY += 2;
        const midY = posY + height * 0.5;
        let posX = 10;
        ctx.save();
        this.hitAreas.toggle.bounds = drawTogglePart(ctx, { posX, posY, height, value: allSplineState });
        if (!lowQuality) {
            posX += this.hitAreas.toggle.bounds[1] + innerMargin;
            ctx.globalAlpha = app.canvas.editor_alpha * 0.55;
            ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText("Toggle All", posX, midY);

            let rposX = node.size[0] - margin - innerMargin - innerMargin;
            ctx.textAlign = "center";

            // Match the widget layout exactly:
            // 1. Repeat control (far right) - drawNumberWidgetPart.WIDTH_TOTAL = 56
            const repeatWidth = drawNumberWidgetPart.WIDTH_TOTAL;
            ctx.fillText("Repeat", rposX - repeatWidth / 2, midY);
            rposX -= repeatWidth + 10;

            // 2. Interpolation selector - just text, no arrows (width = 70)
            const interpTextWidth = 70;
            ctx.fillText("Interpolation", rposX - interpTextWidth / 2, midY);
            rposX -= interpTextWidth + 10;

            const numberWidth = drawNumberWidgetPart.WIDTH_TOTAL;
            ctx.fillText("Z-Pause", rposX - numberWidth / 2, midY);
            rposX -= numberWidth + 10;
            ctx.fillText("A-Pause", rposX - numberWidth / 2, midY);
            rposX -= numberWidth + 10;
            ctx.fillText("Offset", rposX - numberWidth / 2, midY);
            rposX -= numberWidth + 10;
            ctx.fillText("Driven", rposX - numberWidth / 2, midY);
            rposX -= numberWidth + 10;
        }
        ctx.restore();
    }

    onToggleDown(event, pos, node) {
        if (node.toggleAllSplines) {
            node.toggleAllSplines();
        }
        this.cancelMouseDown();
        return true;
    }
}

export class PowerSplineWidget extends RgthreeBaseWidget {
    constructor(name) {
        super(name);
        this.type = "custom";
        this.options = { serialize: true };
        this.haveMouseMovedValue = false;
        this.hitAreas = {
            toggle: { bounds: [0, 0], onDown: this.onToggleDown },
            name: { bounds: [0, 0], onClick: this.onNameClick },
            interpVal: { bounds: [0, 0], onClick: this.onInterpClick },
            repeatDec: { bounds: [0, 0], onClick: this.onRepeatDec },
            repeatVal: { bounds: [0, 0], onClick: this.onRepeatClick },
            repeatInc: { bounds: [0, 0], onClick: this.onRepeatInc },
            repeatAny: { bounds: [0, 0], onMove: this.onRepeatMove },
            offsetDec: { bounds: [0, 0], onClick: this.onOffsetDec },
            offsetVal: { bounds: [0, 0], onClick: this.onOffsetClick },
            offsetInc: { bounds: [0, 0], onClick: this.onOffsetInc },
            offsetAny: { bounds: [0, 0], onMove: this.onOffsetMove },
            aPauseDec: { bounds: [0, 0], onClick: this.onAPauseDec },
            aPauseVal: { bounds: [0, 0], onClick: this.onAPauseClick },
            aPauseInc: { bounds: [0, 0], onClick: this.onAPauseInc },
            aPauseAny: { bounds: [0, 0], onMove: this.onAPauseMove },
            zPauseDec: { bounds: [0, 0], onClick: this.onZPauseDec },
            zPauseVal: { bounds: [0, 0], onClick: this.onZPauseClick },
            zPauseInc: { bounds: [0, 0], onClick: this.onZPauseInc },
            zPauseAny: { bounds: [0, 0], onMove: this.onZPauseMove },
            drivenToggle: { bounds: [0, 0], onDown: this.onDrivenToggleDown, onRightDown: this.onDrivenToggleRightDown },
        };
        this._value = {
            on: true,
            name: "Spline",
            interpolation: 'linear',
            repeat: 1,
            offset: 0,
            a_pause: 0,
            z_pause: 0,
            driven: false, // false = off, object = on with config
            _drivenConfig: { driver: "", rotate: 0, smooth: 0.0 }, // Preserved config
            points_store: "[]",
            coordinates: "[]",
        };
    }

    set value(v) {
        // Always merge with defaults to ensure all required fields exist
        // This prevents issues with old saves, corrupted data, or missing fields
        // Each widget gets properly isolated values, preventing interpolation contamination
        this._value = {
            on: true,
            name: "Spline",
            interpolation: 'linear',
            repeat: 1,
            offset: 0,
            a_pause: 0,
            z_pause: 0,
            driven: false, // false = off, object = on with config
            _drivenConfig: { driver: "", rotate: 0, smooth: 0.0 }, // Preserved config
            points_store: "[]",
            coordinates: "[]",
            ...(typeof v === 'object' && v !== null ? v : {})
        };

        // If driven is an object (old format), extract config and mark as enabled
        if (typeof this._value.driven === 'object' && this._value.driven !== null) {
            this._value._drivenConfig = { ...this._value.driven };
            this._value.driven = this._value._drivenConfig; // Keep object format for "on" state
        }
        // Ensure _drivenConfig exists
        if (!this._value._drivenConfig || typeof this._value._drivenConfig !== 'object') {
            this._value._drivenConfig = { driver: "", rotate: 0, smooth: 0.0 };
        }
    }

    get value() {
        return this._value;
    }

    draw(ctx, node, w, posY, height) {
        ctx.save();
        const margin = 10;
        const innerMargin = margin * 0.33;
        const lowQuality = isLowQuality();
        const midY = posY + height * 0.5;
        let posX = margin;

        // Highlight if active
        if (node.layerManager && node.layerManager.getActiveWidget() === this) {
            drawRoundedRectangle(ctx, { pos: [posX, posY], size: [node.size[0] - margin * 2, height], colorStroke: "#1f77b4" });
        } else {
            drawRoundedRectangle(ctx, { pos: [posX, posY], size: [node.size[0] - margin * 2, height] });
        }

        this.hitAreas.toggle.bounds = drawTogglePart(ctx, { posX, posY, height, value: this.value.on });
        posX += this.hitAreas.toggle.bounds[1] + innerMargin;

        if (lowQuality) {
            ctx.restore();
            return;
        }

        if (!this.value.on) {
            ctx.globalAlpha = app.canvas.editor_alpha * 0.4;
        }

        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.textBaseline = "middle";
        let rposX = node.size[0] - margin - innerMargin;

        // Draw repeat control (far right)
        const [repeatL, repeatT, repeatR] = drawNumberWidgetPart(ctx, {
            posX: rposX, posY, height, value: this.value.repeat || 1, direction: -1,
        });
        this.hitAreas.repeatDec.bounds = repeatL;
        this.hitAreas.repeatVal.bounds = repeatT;
        this.hitAreas.repeatInc.bounds = repeatR;
        this.hitAreas.repeatAny.bounds = [repeatL[0], repeatR[0] + repeatR[1] - repeatL[0]];
        rposX -= drawNumberWidgetPart.WIDTH_TOTAL + 10;

        // Draw interpolation selector
        const interpModes = ['linear', 'cardinal', 'basis', 'points'];
        const interpShortNames = ['linear', 'cardinal', 'basis', 'points'];
        const interpIndex = interpModes.indexOf(this.value.interpolation || 'linear');
        const interpDisplayText = interpIndex >= 0 ? interpShortNames[interpIndex] : 'linear';
        const interpTextWidth = 70;
        ctx.textAlign = "center";
        ctx.fillText(interpDisplayText, rposX - interpTextWidth / 2, midY);
        this.hitAreas.interpVal.bounds = [rposX - interpTextWidth, interpTextWidth];
        rposX -= interpTextWidth + 10;

        // Draw z_pause control
        const [zPauseL, zPauseT, zPauseR] = drawNumberWidgetPart(ctx, {
            posX: rposX, posY, height, value: this.value.z_pause || 0, direction: -1,
        });
        this.hitAreas.zPauseDec.bounds = zPauseL;
        this.hitAreas.zPauseVal.bounds = zPauseT;
        this.hitAreas.zPauseInc.bounds = zPauseR;
        this.hitAreas.zPauseAny.bounds = [zPauseL[0], zPauseR[0] + zPauseR[1] - zPauseL[0]];
        rposX -= drawNumberWidgetPart.WIDTH_TOTAL + 10;

        // Draw a_pause control
        const [aPauseL, aPauseT, aPauseR] = drawNumberWidgetPart(ctx, {
            posX: rposX, posY, height, value: this.value.a_pause || 0, direction: -1,
        });
        this.hitAreas.aPauseDec.bounds = aPauseL;
        this.hitAreas.aPauseVal.bounds = aPauseT;
        this.hitAreas.aPauseInc.bounds = aPauseR;
        this.hitAreas.aPauseAny.bounds = [aPauseL[0], aPauseR[0] + aPauseR[1] - aPauseL[0]];
        rposX -= drawNumberWidgetPart.WIDTH_TOTAL + 10;

        // Draw offset control
        // Offset creates pause frames by removing coordinates and adjusting pause metadata
        // Positive: waits at START for N frames, then animates to N frames before end
        // Negative: animates normally, then holds at END for N frames
        const [offsetL, offsetT, offsetR] = drawNumberWidgetPart(ctx, {
            posX: rposX, posY, height, value: this.value.offset || 0, direction: -1,
        });
        this.hitAreas.offsetDec.bounds = offsetL;
        this.hitAreas.offsetVal.bounds = offsetT;
        this.hitAreas.offsetInc.bounds = offsetR;
        this.hitAreas.offsetAny.bounds = [offsetL[0], offsetR[0] + offsetR[1] - offsetL[0]];
        rposX -= drawNumberWidgetPart.WIDTH_TOTAL + 10;

        // Draw driven toggle
        const numberWidth = drawNumberWidgetPart.WIDTH_TOTAL;
        // Align driven toggle with the header label by using precise positioning
        const drivenPosX = rposX - numberWidth / 2 - 15; // Shift driven toggle a bit to the left (by 5 pixels)
        this.hitAreas.drivenToggle.bounds = drawTogglePart(ctx, { posX: drivenPosX, posY, height, value: this.value.driven });
        rposX -= numberWidth + 10;

        // Draw name (left side, after toggle)
        ctx.textAlign = "left";
        const nameText = fitString(ctx, this.value.name || "Spline", rposX - posX - innerMargin);
        ctx.fillText(nameText, posX, midY);
        this.hitAreas.name.bounds = [posX, 0, rposX - posX, height];

        ctx.restore();
    }

    onMouseDown(event, pos, node) {
        // Check if the click was on the toggle button
        if (this.hitAreas.toggle && this.clickWasWithinBounds(pos, this.hitAreas.toggle.bounds)) {
            // If it was on the toggle, do not set active widget.
            // The onToggleDown handler will take care of the toggle action.
        } else if (node.layerManager) {
            // Otherwise, set this widget as active
            node.layerManager.setActiveWidget(this);
        }
        return super.onMouseDown?.(event, pos, node);
    }

    onToggleDown(event, pos, node) {
        this.value.on = !this.value.on;
        this.cancelMouseDown();
        node.setDirtyCanvas(true, true);
        return true;
    }

    onNameClick(event, pos, node) {
        // Single click just activates the layer
        // Double-click rename is handled at the node level via onDblClick
        return true;
    }

    onInterpDec() {
        const modes = ['linear', 'cardinal', 'basis', 'points'];
        const currentIndex = modes.indexOf(this.value.interpolation || 'linear');
        const newIndex = (currentIndex - 1 + modes.length) % modes.length;
        this.value.interpolation = modes[newIndex];
        this.parent.setDirtyCanvas(true, true);
        // Update editor immediately if this is the active layer
        if (this.parent.layerManager?.getActiveWidget() === this && this.parent.editor) {
            if (this.parent.editor.layerRenderer) {
                this.parent.editor.layerRenderer.render();
            }
        }
        return true;
    }

    onInterpInc() {
        const modes = ['linear', 'cardinal', 'basis', 'points'];
        const currentIndex = modes.indexOf(this.value.interpolation || 'linear');
        const newIndex = (currentIndex + 1) % modes.length;
        this.value.interpolation = modes[newIndex];
        this.parent.setDirtyCanvas(true, true);
        // Update editor immediately if this is the active layer
        if (this.parent.layerManager?.getActiveWidget() === this && this.parent.editor) {
            if (this.parent.editor.layerRenderer) {
                this.parent.editor.layerRenderer.render();
            }
        }
        return true;
    }

    onInterpClick() {
        // Cycle through modes
        this.onInterpInc();
        return true;
    }

    onRepeatDec() {
        this.value.repeat = Math.max(1, (this.value.repeat || 1) - 1);
        this.parent.setDirtyCanvas(true, true);
        return true;
    }

    onRepeatInc() {
        this.value.repeat = Math.min(20, (this.value.repeat || 1) + 1);
        this.parent.setDirtyCanvas(true, true);
        return true;
    }

    onRepeatClick() {
        const canvas = app.canvas;
        canvas.prompt("Repeat", this.value.repeat || 1, (v) => {
            this.value.repeat = Math.max(1, Math.min(20, Number(v)));
            this.parent.setDirtyCanvas(true, true);
        });
        return true;
    }

    onRepeatMove(event, pos, node) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            this.value.repeat = Math.max(1, Math.min(20, (this.value.repeat || 1) + Math.round(event.deltaX / 10)));
            node.setDirtyCanvas(true, true);
        }
    }

    onOffsetDec() {
        this.value.offset = Math.max(-100, (this.value.offset || 0) - 1);
        this.parent.setDirtyCanvas(true, true);
        return true;
    }

    onOffsetInc() {
        this.value.offset = Math.min(100, (this.value.offset || 0) + 1);
        this.parent.setDirtyCanvas(true, true);
        return true;
    }

    onOffsetClick() {
        if (this.haveMouseMovedValue) return;
        const canvas = app.canvas;
        // Offset creates pause frames: +5 waits 5 frames then plays, -5 plays then holds 5 frames
        canvas.prompt("Offset", this.value.offset || 0, (v) => {
            this.value.offset = Math.max(-100, Math.min(100, Number(v)));
            this.parent.setDirtyCanvas(true, true);
        });
        return true;
    }

    onOffsetMove(event, pos, node) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            this.value.offset = Math.max(-100, Math.min(100, (this.value.offset || 0) + Math.round(event.deltaX / 10)));
            node.setDirtyCanvas(true, true);
        }
    }

    onAPauseDec() {
        this.value.a_pause = Math.max(0, (this.value.a_pause || 0) - 1);
        this.parent.setDirtyCanvas(true, true);
        return true;
    }

    onAPauseInc() {
        this.value.a_pause = Math.min(100, (this.value.a_pause || 0) + 1);
        this.parent.setDirtyCanvas(true, true);
        return true;
    }

    onAPauseClick() {
        if (this.haveMouseMovedValue) return;
        const canvas = app.canvas;
        canvas.prompt("A Pause", this.value.a_pause || 0, (v) => {
            this.value.a_pause = Math.max(0, Math.min(100, Number(v)));
            this.parent.setDirtyCanvas(true, true);
        });
        return true;
    }

    onAPauseMove(event, pos, node) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            this.value.a_pause = Math.max(0, Math.min(100, (this.value.a_pause || 0) + Math.round(event.deltaX / 10)));
            node.setDirtyCanvas(true, true);
        }
    }

    onZPauseDec() {
        this.value.z_pause = Math.max(0, (this.value.z_pause || 0) - 1);
        this.parent.setDirtyCanvas(true, true);
        return true;
    }

    onZPauseInc() {
        this.value.z_pause = Math.min(100, (this.value.z_pause || 0) + 1);
        this.parent.setDirtyCanvas(true, true);
        return true;
    }

    onZPauseClick() {
        if (this.haveMouseMovedValue) return;
        const canvas = app.canvas;
        canvas.prompt("Z Pause", this.value.z_pause || 0, (v) => {
            this.value.z_pause = Math.max(0, Math.min(100, Number(v)));
            this.parent.setDirtyCanvas(true, true);
        });
        return true;
    }

    onZPauseMove(event, pos, node) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            this.value.z_pause = Math.max(0, Math.min(100, (this.value.z_pause || 0) + Math.round(event.deltaX / 10)));
            node.setDirtyCanvas(true, true);
        }
    }

    onMouseUp(event, pos, node) {
        super.onMouseUp(event, pos, node);
        this.haveMouseMovedValue = false;

        // Set this widget as active when clicked
        if (node.layerManager) {
            node.layerManager.setActiveWidget(this);
        }
    }

    onDrivenToggleDown(event, pos, node) {
        // Toggle between false (off) and config object (on)
        // Preserve the config object so settings aren't lost
        if (this.value.driven) {
            // Currently on - save config and turn off
            if (typeof this.value.driven === 'object') {
                this.value._drivenConfig = { ...this.value.driven };
            }
            this.value.driven = false;
        } else {
            // Currently off - restore config and turn on
            this.value.driven = { ...this.value._drivenConfig };
        }
        this.cancelMouseDown();
        node.setDirtyCanvas(true, true);
        return true;
    }

    onDrivenToggleRightDown(event, pos, node) {
        event.preventDefault(); // Prevent default browser context menu
        event.stopPropagation(); // Stop event from propagating further

        // Ensure driven is in object format when opening menu
        // If it's currently false, use the saved config
        if (!this.value.driven) {
            // Don't toggle - just prepare the config for the menu
            // The menu will work with the _drivenConfig
            if (!this.value._drivenConfig || typeof this.value._drivenConfig !== 'object') {
                this.value._drivenConfig = { driver: "", rotate: 0, smooth: 0.0 };
            }
        } else if (typeof this.value.driven === 'object') {
            // Update the saved config with current values
            this.value._drivenConfig = { ...this.value.driven };
        }

        // Show context menu for the driven toggle specifically
        showCustomDrivenToggleMenu(event, this, { x: pos[0], y: pos[1] });
        this.cancelMouseDown();
        return true;
    }

    // Also need to make sure we properly handle the right-click event in the base mouse handler
    mouse(event, pos, node) {
        var _a, _b, _c;
        const canvas = app.canvas;
        if (event.type == "pointerdown") {
            this.mouseDowned = [...pos];
            this.isMouseDownedAndOver = true;
            this.downedHitAreasForMove.length = 0;
            this.downedHitAreasForClick.length = 0;
            let anyHandled = false;
            // Check if it's a right click (button 2)
            const isRightClick = event.button === 2;
            for (const part of Object.values(this.hitAreas)) {
                if (this.clickWasWithinBounds(pos, part.bounds)) {
                    if (part.onMove) {
                        this.downedHitAreasForMove.push(part);
                    }
                    if (part.onClick) {
                        this.downedHitAreasForClick.push(part);
                    }
                    // Check for right-click BEFORE calling onDown to prevent toggle from firing on right-click
                    if (isRightClick && part.onRightDown) {
                        const thisHandled = part.onRightDown.apply(this, [event, pos, node, part]);
                        anyHandled = anyHandled || thisHandled == true;
                    } else if (part.onDown) {
                        // Only call onDown if it's NOT a right-click with onRightDown
                        const thisHandled = part.onDown.apply(this, [event, pos, node, part]);
                        anyHandled = anyHandled || thisHandled == true;
                    }
                    part.wasMouseClickedAndIsOver = true;
                }
            }
            return (_a = this.onMouseDown(event, pos, node)) !== null && _a !== void 0 ? _a : anyHandled;
        }
        if (event.type == "pointerup") {
            if (!this.mouseDowned)
                return true;
            this.downedHitAreasForMove.length = 0;
            const wasMouseDownedAndOver = this.isMouseDownedAndOver;
            this.cancelMouseDown();
            let anyHandled = false;
            for (const part of Object.values(this.hitAreas)) {
                if (part.onUp && this.clickWasWithinBounds(pos, part.bounds)) {
                    const thisHandled = part.onUp.apply(this, [event, pos, node, part]);
                    anyHandled = anyHandled || thisHandled == true;
                }
                part.wasMouseClickedAndIsOver = false;
            }
            for (const part of this.downedHitAreasForClick) {
                if (this.clickWasWithinBounds(pos, part.bounds)) {
                    const thisHandled = part.onClick.apply(this, [event, pos, node, part]);
                    anyHandled = anyHandled || thisHandled == true;
                }
            }
            this.downedHitAreasForClick.length = 0;
            if (wasMouseDownedAndOver) {
                const thisHandled = this.onMouseClick(event, pos, node);
                anyHandled = anyHandled || thisHandled == true;
            }
            return (_b = this.onMouseUp(event, pos, node)) !== null && _b !== void 0 ? _b : anyHandled;
        }
        if (event.type == "pointermove") {
            this.isMouseDownedAndOver = !!this.mouseDowned;
            if (this.mouseDowned &&
                (pos[0] < 15 ||
                    pos[0] > node.size[0] - 15 ||
                    pos[1] < this.last_y ||
                    pos[1] > this.last_y + LiteGraph.NODE_WIDGET_HEIGHT)) {
                this.isMouseDownedAndOver = false;
            }
            for (const part of Object.values(this.hitAreas)) {
                if (this.downedHitAreasForMove.includes(part)) {
                    part.onMove.apply(this, [event, pos, node, part]);
                }
                if (this.downedHitAreasForClick.includes(part)) {
                    part.wasMouseClickedAndIsOver = this.clickWasWithinBounds(pos, part.bounds);
                }
            }
            return (_c = this.onMouseMove(event, pos, node)) !== null && _c !== void 0 ? _c : true;
        }
        return false;
    }
    serializeValue(node, index) {
        // Return a deep copy to prevent reference sharing between widgets during serialization
        // This ensures each widget has independent interpolation and other values
        const serialized = JSON.parse(JSON.stringify(this.value));
        return serialized;
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    }
}

export function chainCallback(object, property, callback) {
  if (object == undefined) {
      //This should not happen.
      console.error("Tried to add callback to non-existant object")
      return;
  }
  if (property in object) {
      const callback_orig = object[property]
      object[property] = function () {
          const r = callback_orig.apply(this, arguments);
          callback.apply(this, arguments);
          return r
      };
  } else {
      object[property] = callback;
  }
}

export function hideWidgetForGood(node, widget, suffix = '') {
  widget.origType = widget.type;
  widget.type = 'hidden' + suffix;
  widget.hidden = true;
  
  // Monkeypatch draw to do nothing
  widget.draw = () => {};
  
  // Monkeypatch computeSize to return [0, -4]
  // This is a hack to make the widget not take up any space
  // We need to return -4 instead of 0 because of how LiteGraph calculates node height
  // In recent versions of LiteGraph, it adds 4 to the widget height
  widget.computeSize = () => [0, -4];
  
  // Prevent the widget from being serialized
  if (!widget.options) {
    widget.options = {};
  }
  // widget.options.serialize = false;
  
  // Hide the widget from the node's list of widgets
  // This is another hack to prevent the widget from being drawn
  // We can't just remove it from the list, because other parts of the code
  // might still need to access it
  const index = node.widgets.indexOf(widget);
  if (index > -1) {
    node.widgets.splice(index, 1);
    node.widgets.push(widget);
  }
}