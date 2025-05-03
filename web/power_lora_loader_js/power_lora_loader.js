import { app } from "../../../scripts/app.js";

// Canvas utility functions 
function binarySearch(max, getValue, match) {
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
    ctx.fillStyle = value === true ? "#89B" : "#888";
    const toggleX = lowQuality || value === false
        ? posX + height * 0.5
        : value === true
            ? posX + height
            : posX + height * 0.75;
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
    // ctx.fill(new Path2D(`M ${posX} ${midY} l ${arrowWidth} ${arrowHeight / 2} l 0 -${arrowHeight} L ${posX} ${midY} z`));
    xBoundsArrowLess[0] = posX;
    xBoundsArrowLess[1] = arrowWidth;
    posX += arrowWidth + innerMargin;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const oldTextcolor = ctx.fillStyle;
    if (textColor) {
        ctx.fillStyle = textColor;
    }
    ctx.fillText(fitString(ctx, value.toFixed(3), numberWidth), posX + numberWidth / 2, midY);
    ctx.fillStyle = oldTextcolor;
    xBoundsNumber[0] = posX;
    xBoundsNumber[1] = numberWidth;
    posX += numberWidth + innerMargin;
    // ctx.fill(new Path2D(`M ${posX} ${midY - arrowHeight / 2} l ${arrowWidth} ${arrowHeight / 2} l -${arrowWidth} ${arrowHeight / 2} v -${arrowHeight} z`));
    xBoundsArrowMore[0] = posX;
    xBoundsArrowMore[1] = arrowWidth;
    ctx.restore();
    return [xBoundsArrowLess, xBoundsNumber, xBoundsArrowMore];
}
drawNumberWidgetPart.WIDTH_TOTAL = 9 + 3 + 32 + 3 + 9;

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
        size: options.size,
        pos: [options.pos[0], options.pos[1] + (isMouseDownedAndOver ? 1 : 0)],
        borderRadius,
        colorBackground: "transparent",
    });
    if (!isLowQuality() && text) {
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.fillText(text, options.size[0] / 2, options.pos[1] + options.size[1] / 2 + (isMouseDownedAndOver ? 1 : 0));
    }
    ctx.restore();
}

// === COPIED FROM RGTHREE BASE WIDGET CLASS ===
// From rgthree/web/comfyui/utils_widgets.js
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
            for (const part of Object.values(this.hitAreas)) {
                if (this.clickWasWithinBounds(pos, part.bounds)) {
                    if (part.onMove) {
                        this.downedHitAreasForMove.push(part);
                    }
                    if (part.onClick) {
                        this.downedHitAreasForClick.push(part);
                    }
                    if (part.onDown) {
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

// Button Widget from rgthree
export class RgthreeBetterButtonWidget extends RgthreeBaseWidget {
    constructor(name, mouseClickCallback, label) {
        super(name);
        this.type = "custom";
        this.value = "";
        this.label = "";
        this.mouseClickCallback = mouseClickCallback;
        this.label = label || name;
    }

    draw(ctx, node, width, y, height) {
        drawWidgetButton(ctx, { size: [width - 30, height], pos: [15, y] }, this.label, this.isMouseDownedAndOver);
    }

    onMouseClick(event, pos, node) {
        var _a;
        return (_a = this.mouseClickCallback) === null || _a === void 0 ? void 0 : _a.call(this, event, pos, node);
    }
}

// === UTILITY FUNCTIONS FROM RGTHREE ===
// From rgthree/web/common/shared_utils.js
export function moveArrayItem(arr, itemOrFrom, to) {
    const from = typeof itemOrFrom === "number" ? itemOrFrom : arr.indexOf(itemOrFrom);
    if (from === -1 || to < 0 || to >= arr.length || from === to) return;
    const item = arr.splice(from, 1)[0];
    arr.splice(to, 0, item);
}

export function removeArrayItem(arr, itemOrIndex) {
    const index = typeof itemOrIndex === "number" ? itemOrIndex : arr.indexOf(itemOrIndex);
    if (index !== -1) {
        arr.splice(index, 1);
    }
}

// === DIVIDER WIDGET FROM RGTHREE ===
// From rgthree/web/comfyui/utils_widgets.js
export class RgthreeDividerWidget extends RgthreeBaseWidget {
    constructor(widgetOptions) {
        super("divider");
        this.value = {};
        this.options = { serialize: false };
        this.type = "custom";
        this.widgetOptions = {
            marginTop: 7,
            marginBottom: 7,
            marginLeft: 15,
            marginRight: 15,
            color: LiteGraph.WIDGET_OUTLINE_COLOR,
            thickness: 1,
        };
        Object.assign(this.widgetOptions, widgetOptions || {});
    }

    draw(ctx, node, width, posY, h) {
        if (this.widgetOptions.thickness) {
            ctx.strokeStyle = this.widgetOptions.color;
            const x = this.widgetOptions.marginLeft;
            const y = posY + this.widgetOptions.marginTop;
            const w = width - this.widgetOptions.marginLeft - this.widgetOptions.marginRight;
            const thickness = this.widgetOptions.thickness;
            ctx.fillStyle = this.widgetOptions.color;
            ctx.fillRect(x, y, w, thickness);
        }
    }

    computeSize(width) {
        return [
            width,
            this.widgetOptions.marginTop + this.widgetOptions.thickness + this.widgetOptions.marginBottom,
        ];
    }
}

// === WAN VIDEO LORA API ===
// Adapted from rgthree's API calls
async function getWanVideoLoras() {
    try {
        const response = await fetch("/object_info");
        const objectInfo = await response.json();

        // Look for WanVideo lora nodes to get file list
        if (objectInfo.WanVideoLoraSelectMulti?.input?.required?.lora_0) {
            const loraFiles = objectInfo.WanVideoLoraSelectMulti.input.required.lora_0[0];
            if (Array.isArray(loraFiles)) {
                return loraFiles.map(file => ({ file }));
            }
        }

        // Try other lora nodes
        for (const [nodeName, nodeData] of Object.entries(objectInfo)) {
            if (nodeName.includes("Lora") || nodeName.includes("LoRA")) {
                const inputs = nodeData.input?.required || {};
                for (const [inputName, inputData] of Object.entries(inputs)) {
                    if (inputName.toLowerCase().includes('lora') && Array.isArray(inputData[0])) {
                        return inputData[0].map(file => ({ file }));
                    }
                }
            }
        }

        return [];
    } catch (error) {
        console.error("Error fetching WanVideo loras:", error);
        return [];
    }
}

async function showLoraChooser(event, callback, parentMenu, loras) {
    var _a, _b;
    const canvas = app.canvas;
    if (!loras) {
        const lorasDetails = await getWanVideoLoras();
        loras = ["None", ...lorasDetails.map(l => l.file)];
    }
    new LiteGraph.ContextMenu(loras, {
        event: event,
        parentMenu: parentMenu != null ? parentMenu : undefined,
        title: "Choose a lora",
        scale: Math.max(1, (_b = (_a = canvas.ds) === null || _a === void 0 ? void 0 : _a.scale) !== null && _b !== void 0 ? _b : 1),
        className: "dark",
        callback,
    });
}

// === POWER LORA WIDGET ===
// Properties constants from rgthree
const PROP_LABEL_SHOW_STRENGTHS = "Show Strengths";
const PROP_VALUE_SHOW_STRENGTHS_SINGLE = "Single Strength";
const PROP_VALUE_SHOW_STRENGTHS_SEPARATE = "Separate Model & Clip";

const MINIMUM_NODE_WIDTH = 480;

const DEFAULT_LORA_WIDGET_DATA = {
    on: true,
    lora: null,
    strength: 1,
    strengthTwo: null,
    is_low: false,
    low_strength: 1,
};

// === HEADER WIDGET FROM RGTHREE ===
// From rgthree/web/comfyui/power_lora_loader.js
class OptionsWidget extends RgthreeBaseWidget {
    constructor(name = "OptionsWidget") {
        super(name);
        this.type = "custom";
        this.options = { serialize: true };  // Enable serialization
        this.value = {};  // Add value property like other widgets
        this.hitAreas = {
            low_mem_toggle: { bounds: [0, 0] },
            merge_loras_toggle: { bounds: [0, 0] },
            overwrite_toggle: { bounds: [0, 0] },
            high_to_low_button: { bounds: [0, 0] },
            low_to_high_button: { bounds: [0, 0] },
        };
        this.highToLowPressed = false;
        this.lowToHighPressed = false;
    }

    serializeValue(node, index) {
        if (!node.properties) node.properties = {};
        if (node.properties['low_mem_load'] === undefined) node.properties['low_mem_load'] = true;
        if (node.properties['merge_loras'] === undefined) node.properties['merge_loras'] = false;
        if (node.properties['overwrite_duplicates'] === undefined) node.properties['overwrite_duplicates'] = false;

        const value = {
            low_mem_load: node.properties['low_mem_load'] || false,
            merge_loras: node.properties['merge_loras'] !== false ? true : false,
            overwrite_duplicates: node.properties['overwrite_duplicates'] || false
        };
        console.log(`[JS] OptionsWidget serializing: `, value);
        return value;
    }

    draw(ctx, node, w, posY, height) {
        // Ensure properties exist
        if (!node.properties) node.properties = {};
        if (node.properties['low_mem_load'] === undefined) node.properties['low_mem_load'] = true;
        if (node.properties['merge_loras'] === undefined) node.properties['merge_loras'] = false;
        if (node.properties['overwrite_duplicates'] === undefined) node.properties['overwrite_duplicates'] = false;

        // Constants
        const margin = 20;
        const innerMargin = margin * 0.33;
        const buttonWidth = 25;
        const buttonHeight = height;
        const buttonSpacing = 20;
        const rightOffset = 48;

        // Calculated values
        const midY = posY + height * 0.5;
        const totalButtonsWidth = (buttonWidth * 2) + buttonSpacing;
        const rightX = w - margin - totalButtonsWidth - rightOffset;
        let posX = 10;

        // Widget state
        const lowMemValue = node.properties['low_mem_load'] || false;
        const mergeValue = node.properties['merge_loras'] === false ? false : true;
        const overwriteValue = node.properties['overwrite_duplicates'] || false;

        ctx.save();
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;

        // Draw Low Mem toggle
        ctx.fillText("Low Mem", posX, midY);
        posX += ctx.measureText("Low Mem").width + innerMargin;
        let bounds = drawTogglePart(ctx, { posX, posY, height, value: lowMemValue });
        this.hitAreas['low_mem_toggle'].bounds = bounds;
        this.hitAreas['low_mem_toggle'].onDown = () => {
            node.properties['low_mem_load'] = !lowMemValue;
            this.cancelMouseDown();
            node.setDirtyCanvas(true, true);
            return true;
        };
        posX += bounds[1] + innerMargin * 3;

        // Draw Merge toggle
        ctx.fillText("Merge", posX, midY);
        posX += ctx.measureText("Merge").width + innerMargin;
        bounds = drawTogglePart(ctx, { posX, posY, height, value: mergeValue });
        this.hitAreas['merge_loras_toggle'].bounds = bounds;
        this.hitAreas['merge_loras_toggle'].onDown = () => {
            node.properties['merge_loras'] = !mergeValue;
            this.cancelMouseDown();
            node.setDirtyCanvas(true, true);
            return true;
        };
        posX += bounds[1] + innerMargin * 3;

        // Draw Overwrite toggle
        ctx.fillText("Overwrite", posX, midY);
        posX += ctx.measureText("Overwrite").width + innerMargin;
        bounds = drawTogglePart(ctx, { posX, posY, height, value: overwriteValue });
        this.hitAreas['overwrite_toggle'].bounds = bounds;
        this.hitAreas['overwrite_toggle'].onDown = () => {
            node.properties['overwrite_duplicates'] = !overwriteValue;
            this.cancelMouseDown();
            node.setDirtyCanvas(true, true);
            return true;
        };

        // Draw ">" button (high to low)
        const highToLowX = rightX;
        drawWidgetButton(ctx, {
            size: [buttonWidth, buttonHeight],
            pos: [highToLowX, posY]
        }, null, this.highToLowPressed);

        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.fillText(">", highToLowX + buttonWidth / 2, posY + buttonHeight / 2);
        ctx.restore();

        this.hitAreas['high_to_low_button'].bounds = [highToLowX, buttonWidth];
        this.hitAreas['high_to_low_button'].onDown = () => {
            this.highToLowPressed = true;
            node.setDirtyCanvas(true, true);
            return true;
        };
        this.hitAreas['high_to_low_button'].onUp = () => {
            this.highToLowPressed = false;
            node.setDirtyCanvas(true, true);
            return true;
        };
        this.hitAreas['high_to_low_button'].onClick = () => {
            this.copyHighToLowStrengths(node);
            this.cancelMouseDown();
            node.setDirtyCanvas(true, true);
            return true;
        };

        // Draw "<" button (low to high)
        const lowToHighX = rightX + buttonWidth + buttonSpacing;
        drawWidgetButton(ctx, {
            size: [buttonWidth, buttonHeight],
            pos: [lowToHighX, posY]
        }, null, this.lowToHighPressed);

        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.fillText("<", lowToHighX + buttonWidth / 2, posY + buttonHeight / 2);
        ctx.restore();

        this.hitAreas['low_to_high_button'].bounds = [lowToHighX, buttonWidth];
        this.hitAreas['low_to_high_button'].onDown = () => {
            this.lowToHighPressed = true;
            node.setDirtyCanvas(true, true);
            return true;
        };
        this.hitAreas['low_to_high_button'].onUp = () => {
            this.lowToHighPressed = false;
            node.setDirtyCanvas(true, true);
            return true;
        };
        this.hitAreas['low_to_high_button'].onClick = () => {
            this.copyLowToHighStrengths(node);
            this.cancelMouseDown();
            node.setDirtyCanvas(true, true);
            return true;
        };

        ctx.restore();
    }
    
    copyHighToLowStrengths(node) {
        // Copy high strength values to low strength values (> button)
        for (const widget of node.widgets || []) {
            if (widget.name?.startsWith("lora_") && widget.value) {
                widget.value.low_strength = widget.value.strength || 1;
            }
        }
        console.log('[JS] Copied all high strengths to low strengths (H -> L)');
    }

    copyLowToHighStrengths(node) {
        // Copy low strength values to high strength values (< button)
        for (const widget of node.widgets || []) {
            if (widget.name?.startsWith("lora_") && widget.value) {
                widget.value.strength = widget.value.low_strength || 1;
                // Also update strengthTwo if in model/clip mode
                if (widget.showModelAndClip && widget.value.strengthTwo !== undefined) {
                    widget.value.strengthTwo = widget.value.low_strength || 1;
                }
            }
        }
        console.log('[JS] Copied all low strengths to high strengths (L -> H)');
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    }
}

class PowerLoraLoaderHeaderWidget extends RgthreeBaseWidget {
    constructor(name = "PowerLoraLoaderHeaderWidget") {
        super(name);
        this.value = { type: "PowerLoraLoaderHeaderWidget" };
        this.type = "custom";
        this.hitAreas = {
            toggle: { bounds: [0, 0], onDown: this.onToggleDown },
        };
        this.showModelAndClip = null;
    }

    draw(ctx, node, w, posY, height) {
        if (!node.hasLoraWidgets()) {
            return;
        }
        this.showModelAndClip =
            node.properties[PROP_LABEL_SHOW_STRENGTHS] === PROP_VALUE_SHOW_STRENGTHS_SEPARATE;
        const margin = 10;
        const innerMargin = margin * 0.33;
        const lowQuality = isLowQuality();
        const allLoraState = node.allLorasState();
        posY += 2;
        const midY = posY + height * 0.5;
        let posX = 10;
        ctx.save();
        this.hitAreas.toggle.bounds = drawTogglePart(ctx, { posX, posY, height, value: allLoraState });
        if (!lowQuality) {
            posX += this.hitAreas.toggle.bounds[1] + innerMargin;
            ctx.globalAlpha = app.canvas.editor_alpha * 0.55;
            ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText("Toggle All", posX, midY);
            let rposX = node.size[0] - margin - innerMargin - innerMargin;
            ctx.textAlign = "center";

            const lowLabelWidth = 30;
            ctx.fillText("*", rposX - lowLabelWidth / 2, midY);
            rposX -= lowLabelWidth;

            // Always show L label for low strength slider
            ctx.fillText("Low", rposX - drawNumberWidgetPart.WIDTH_TOTAL / 2, midY);
            rposX = rposX - drawNumberWidgetPart.WIDTH_TOTAL - 2;

            // Always show H label for main strength slider
            ctx.fillText("High", rposX - drawNumberWidgetPart.WIDTH_TOTAL / 2, midY);
            if (this.showModelAndClip) {
                rposX = rposX - drawNumberWidgetPart.WIDTH_TOTAL - 2;
                ctx.fillText("High", rposX - drawNumberWidgetPart.WIDTH_TOTAL / 2, midY);
            }
        }
        ctx.restore();
    }

    onToggleDown(event, pos, node) {
        node.toggleAllLoras();
        this.cancelMouseDown();
        return true;
    }
}

class PowerLoraLoaderWidget extends RgthreeBaseWidget {
    constructor(name) {
        super(name);
        this.type = "custom";
        this.haveMouseMovedStrength = false;
        this.showModelAndClip = null;
        this.hitAreas = {
            toggle: { bounds: [0, 0], onDown: this.onToggleDown },
            lora: { bounds: [0, 0], onClick: this.onLoraClick },
            strengthDec: { bounds: [0, 0], onClick: this.onStrengthDecDown },
            strengthVal: { bounds: [0, 0], onClick: this.onStrengthValUp },
            strengthInc: { bounds: [0, 0], onClick: this.onStrengthIncDown },
            strengthAny: { bounds: [0, 0], onMove: this.onStrengthAnyMove },
            strengthTwoDec: { bounds: [0, 0], onClick: this.onStrengthTwoDecDown },
            strengthTwoVal: { bounds: [0, 0], onClick: this.onStrengthTwoValUp },
            strengthTwoInc: { bounds: [0, 0], onClick: this.onStrengthTwoIncDown },
            strengthTwoAny: { bounds: [0, 0], onMove: this.onStrengthTwoAnyMove },
            lowStrengthDec: { bounds: [0, 0], onClick: this.onLowStrengthDecDown },
            lowStrengthVal: { bounds: [0, 0], onClick: this.onLowStrengthValUp },
            lowStrengthInc: { bounds: [0, 0], onClick: this.onLowStrengthIncDown },
            lowStrengthAny: { bounds: [0, 0], onMove: this.onLowStrengthAnyMove },
        };
        this._value = {
            on: true,
            lora: null,
            strength: 1,
            strengthTwo: null,
            low_strength: 1,
        };
    }

    set value(v) {
        this._value = v;
        if (typeof this._value !== "object") {
            this._value = { ...DEFAULT_LORA_WIDGET_DATA };
            if (this.showModelAndClip) {
                this._value.strengthTwo = this._value.strength;
            }
        }
        // Ensure low_strength is always initialized
        if (this._value.low_strength === undefined) {
            this._value.low_strength = 1;
        }
    }

    get value() {
        return this._value;
    }

    setLora(lora) {
        this._value.lora = lora;
        this.checkLowLoraVariant(lora);
    }

    checkLowLoraVariant(loraName) {
        if (!loraName || loraName === "None") {
            this.value.is_low = false;
            this.value.low_variant_name = null;
            return;
        }

        const allLoras = this.parent?.lorasCache || [];
        if (!allLoras.length) {
            return;
        }

        const generatePatterns = (tokens) => {
            const separators = ['-', '_', ' '];
            const infixes = [], prefixes = [], suffixes = [];
            for (const token of tokens) {
                for (const sep of separators) {
                    prefixes.push(token + sep);
                    suffixes.push(sep + token);
                    infixes.push(sep + token + sep);
                }
            }
            return { infixes, prefixes, suffixes };
        };

        const highPatterns = generatePatterns(['High', 'high', 'HIGH', 'h', 'H']);
        const lowPatterns = generatePatterns(['Low', 'low', 'LOW', 'l', 'L']);

        let foundLowVariant = false;
        let lowVariantName = null;

        // Check for infix patterns
        for (const highPattern of highPatterns.infixes) {
            if (loraName.includes(highPattern)) {
                for (const lowPattern of lowPatterns.infixes) {
                    const expectedLowName = loraName.replace(highPattern, lowPattern);
                    if (loraName !== expectedLowName && allLoras.includes(expectedLowName)) {
                        foundLowVariant = true;
                        lowVariantName = expectedLowName;
                        break;
                    }
                }
            }
            if (foundLowVariant) break;
        }

        // Check for prefix patterns
        if (!foundLowVariant) {
            for (const highPattern of highPatterns.prefixes) {
                if (loraName.startsWith(highPattern)) {
                    for (const lowPattern of lowPatterns.prefixes) {
                        const expectedLowName = loraName.replace(highPattern, lowPattern);
                        if (loraName !== expectedLowName && allLoras.includes(expectedLowName)) {
                            foundLowVariant = true;
                            lowVariantName = expectedLowName;
                            break;
                        }
                    }
                }
                if (foundLowVariant) break;
            }
        }

        // Check for suffix patterns
        if (!foundLowVariant) {
            const nameWithoutExt = loraName.substring(0, loraName.lastIndexOf('.'));
            for (const highPattern of highPatterns.suffixes) {
                if (nameWithoutExt.endsWith(highPattern)) {
                    for (const lowPattern of lowPatterns.suffixes) {
                        const expectedLowName = loraName.replace(highPattern, lowPattern);
                        if (loraName !== expectedLowName && allLoras.includes(expectedLowName)) {
                            foundLowVariant = true;
                            lowVariantName = expectedLowName;
                            break;
                        }
                    }
                }
                if (foundLowVariant) break;
            }
        }

        this.value.is_low = foundLowVariant;
        this.value.low_variant_name = lowVariantName;

        // Debug logging
        console.log(`[JS] checkLowLoraVariant for '${loraName}': is_low=${foundLowVariant}, low_variant_name=${lowVariantName}`);
    }

    draw(ctx, node, w, posY, height) {
        var _b, _c, _d, _e;
        let currentShowModelAndClip = node.properties[PROP_LABEL_SHOW_STRENGTHS] === PROP_VALUE_SHOW_STRENGTHS_SEPARATE;
        if (this.showModelAndClip !== currentShowModelAndClip) {
            let oldShowModelAndClip = this.showModelAndClip;
            this.showModelAndClip = currentShowModelAndClip;
            if (this.showModelAndClip) {
                if (oldShowModelAndClip != null) {
                    this.value.strengthTwo = (_b = this.value.strength) !== null && _b !== void 0 ? _b : 1;
                }
            }
            else {
                this.value.strengthTwo = null;
                this.hitAreas.strengthTwoDec.bounds = [0, -1];
                this.hitAreas.strengthTwoVal.bounds = [0, -1];
                this.hitAreas.strengthTwoInc.bounds = [0, -1];
                this.hitAreas.strengthTwoAny.bounds = [0, -1];
            }
        }

        ctx.save();
        const margin = 10;
        const innerMargin = margin * 0.33;
        const lowQuality = isLowQuality();
        const midY = posY + height * 0.5;
        let posX = margin;

        drawRoundedRectangle(ctx, { pos: [posX, posY], size: [node.size[0] - margin * 2, height] });
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
        let rposX = node.size[0] - margin - innerMargin - innerMargin;

        const iconWidth = 30;
        const iconRadius = height * 0.2;
        const iconCenterX = rposX - iconWidth / 2;
        const iconCenterY = midY;
        const oldFillStyle = ctx.fillStyle;
        ctx.fillStyle = this.value.is_low ? "lime" : "#555";
        ctx.beginPath();
        ctx.arc(iconCenterX, iconCenterY, iconRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = oldFillStyle;
        rposX -= iconWidth;

        // Draw low strength slider (L)
        const lowStrengthValue = this.value.low_strength || 1;
        const [lowLeftArrow, lowText, lowRightArrow] = drawNumberWidgetPart(ctx, {
            posX: rposX,
            posY,
            height,
            value: lowStrengthValue,
            direction: -1,
        });

        this.hitAreas.lowStrengthDec.bounds = lowLeftArrow;
        this.hitAreas.lowStrengthVal.bounds = lowText;
        this.hitAreas.lowStrengthInc.bounds = lowRightArrow;
        this.hitAreas.lowStrengthAny.bounds = [lowLeftArrow[0], lowRightArrow[0] + lowRightArrow[1] - lowLeftArrow[0]];
        rposX = lowLeftArrow[0] - 2;

        // Draw main strength slider (H)
        const strengthValue = this.showModelAndClip
            ? ((_c = this.value.strengthTwo) !== null && _c !== void 0 ? _c : 1)
            : ((_d = this.value.strength) !== null && _d !== void 0 ? _d : 1);

        const [leftArrow, text, rightArrow] = drawNumberWidgetPart(ctx, {
            posX: rposX,
            posY,
            height,
            value: strengthValue,
            direction: -1,
        });

        this.hitAreas.strengthDec.bounds = leftArrow;
        this.hitAreas.strengthVal.bounds = text;
        this.hitAreas.strengthInc.bounds = rightArrow;
        this.hitAreas.strengthAny.bounds = [leftArrow[0], rightArrow[0] + rightArrow[1] - leftArrow[0]];
        rposX = leftArrow[0] - 2;

        if (this.showModelAndClip) {
            rposX -= 2;
            this.hitAreas.strengthTwoDec.bounds = this.hitAreas.strengthDec.bounds;
            this.hitAreas.strengthTwoVal.bounds = this.hitAreas.strengthVal.bounds;
            this.hitAreas.strengthTwoInc.bounds = this.hitAreas.strengthInc.bounds;
            this.hitAreas.strengthTwoAny.bounds = this.hitAreas.strengthAny.bounds;

            const [leftArrow, text, rightArrow] = drawNumberWidgetPart(ctx, {
                posX: rposX,
                posY,
                height,
                value: (_e = this.value.strength) !== null && _e !== void 0 ? _e : 1,
                direction: -1,
            });

            this.hitAreas.strengthDec.bounds = leftArrow;
            this.hitAreas.strengthVal.bounds = text;
            this.hitAreas.strengthInc.bounds = rightArrow;
            this.hitAreas.strengthAny.bounds = [
                leftArrow[0],
                rightArrow[0] + rightArrow[1] - leftArrow[0],
            ];
            rposX = leftArrow[0] - 2;
        }

        const loraWidth = rposX - posX;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const loraLabel = String(this.value?.lora || "None");
        ctx.fillText(fitString(ctx, loraLabel, loraWidth), posX, midY);
        this.hitAreas.lora.bounds = [posX, loraWidth];

        ctx.globalAlpha = app.canvas.editor_alpha;
        ctx.restore();
    }

    serializeValue(node, index) {
        var _b;
        const v = { ...this.value };

        // Handle model/clip strength modes
        if (!this.showModelAndClip) {
            delete v.strengthTwo;
        }
        else {
            this.value.strengthTwo = (_b = this.value.strengthTwo) !== null && _b !== void 0 ? _b : 1;
            v.strengthTwo = this.value.strengthTwo;
        }

        // Ensure low_strength is always included
        if (v.low_strength === undefined) {
            v.low_strength = 1;
        }

        // Keep the original selected LoRA - let Python backend handle the outputs
        if (v.is_low && v.low_variant_name) {
            console.log(`[JS] High LoRA '${v.lora}' has low variant '${v.low_variant_name}' - sending both to backend`);
            console.log(`[JS] High strength: ${v.strength}, Low strength: ${v.low_strength}`);
        }

        // Enhanced debug logging
        console.log(`[JS] serializeValue for ${this.name}:`, {
            final_lora: v.lora,
            final_strength: v.strength,
            original_low_strength: v.low_strength,
            is_low: v.is_low,
            low_variant_name: v.low_variant_name,
            full_object: v
        });

        return v;
    }

    onToggleDown(event, pos, node) {
        this.value.on = !this.value.on;
        this.cancelMouseDown();
        return true;
    }

    onLoraClick(event, pos, node) {
        // Use cached loras from parent node for instant response, same as Add Lora button
        const cachedLoras = node.lorasCache || [];
        if (cachedLoras.length > 0) {
            // Use cached data for instant response
            showLoraChooser(event, (value) => {
                if (typeof value === "string") {
                    this.setLora(value);
                }
                node.setDirtyCanvas(true, true);
            }, null, ["None", ...cachedLoras]);
        } else {
            // Fallback to API call if cache is empty
            showLoraChooser(event, (value) => {
                if (typeof value === "string") {
                    this.setLora(value);
                }
                node.setDirtyCanvas(true, true);
            });
        }
        this.cancelMouseDown();
    }

    onStrengthDecDown(event, pos, node) {
        this.stepStrength(-1, false);
    }

    onStrengthIncDown(event, pos, node) {
        this.stepStrength(1, false);
    }

    onStrengthTwoDecDown(event, pos, node) {
        this.stepStrength(-1, true);
    }

    onStrengthTwoIncDown(event, pos, node) {
        this.stepStrength(1, true);
    }

    onStrengthAnyMove(event, pos, node) {
        this.doOnStrengthAnyMove(event, false);
    }

    onStrengthTwoAnyMove(event, pos, node) {
        this.doOnStrengthAnyMove(event, true);
    }

    onLowStrengthDecDown(event, pos, node) {
        this.stepLowStrength(-1);
    }

    onLowStrengthIncDown(event, pos, node) {
        this.stepLowStrength(1);
    }

    onLowStrengthAnyMove(event, pos, node) {
        this.doOnLowStrengthAnyMove(event);
    }

    onLowStrengthValUp(event, pos, node) {
        this.doOnLowStrengthValUp(event);
    }

    doOnStrengthAnyMove(event, isTwo = false) {
        var _b;
        if (event.deltaX) {
            let prop = isTwo ? "strengthTwo" : "strength";
            this.haveMouseMovedStrength = true;
            this.value[prop] = ((_b = this.value[prop]) !== null && _b !== void 0 ? _b : 1) + event.deltaX * 0.05;
        }
    }

    onStrengthValUp(event, pos, node) {
        this.doOnStrengthValUp(event, false);
    }

    onStrengthTwoValUp(event, pos, node) {
        this.doOnStrengthValUp(event, true);
    }

    doOnStrengthValUp(event, isTwo = false) {
        if (this.haveMouseMovedStrength)
            return;
        let prop = isTwo ? "strengthTwo" : "strength";
        const canvas = app.canvas;
        canvas.prompt("Value", this.value[prop], (v) => (this.value[prop] = Number(v)), event);
    }

    onMouseUp(event, pos, node) {
        super.onMouseUp(event, pos, node);
        this.haveMouseMovedStrength = false;
    }

    stepStrength(direction, isTwo = false) {
        var _b;
        let step = 0.05;
        let prop = isTwo ? "strengthTwo" : "strength";
        let strength = ((_b = this.value[prop]) !== null && _b !== void 0 ? _b : 1) + step * direction;
        this.value[prop] = Math.round(strength * 100) / 100;
    }

    doOnLowStrengthAnyMove(event) {
        var _b;
        if (event.deltaX) {
            this.haveMouseMovedStrength = true;
            this.value.low_strength = ((_b = this.value.low_strength) !== null && _b !== void 0 ? _b : 1) + event.deltaX * 0.05;
        }
    }

    doOnLowStrengthValUp(event) {
        if (this.haveMouseMovedStrength)
            return;
        const canvas = app.canvas;
        canvas.prompt("Value", this.value.low_strength, (v) => (this.value.low_strength = Number(v)), event);
    }

    stepLowStrength(direction) {
        var _b;
        let step = 0.05;
        let strength = ((_b = this.value.low_strength) !== null && _b !== void 0 ? _b : 1) + step * direction;
        this.value.low_strength = Math.round(strength * 100) / 100;
    }

    showLoraInfoDialog() {
        if (!this.value.lora || this.value.lora === "None") {
            return;
        }

        // Import and show the complete rgthree-style dialog
        import("./dialog_info.js").then(({ WanLoraInfoDialog }) => {
            const infoDialog = new WanLoraInfoDialog(this.value.lora).show();
            infoDialog.addEventListener("close", ((e) => {
                if (e.detail.dirty) {
                    // Dialog was modified, could trigger refresh if needed
                    console.log("LoRA info was modified");
                }
            }));
        }).catch(error => {
            // Fallback to simple alert if dialog fails to load
            console.error("Failed to load LoRA info dialog:", error);
            const loraInfo = `LoRA Information:

File: ${this.value.lora}
Status: ${this.value.on ? "Enabled" : "Disabled"}
Model Strength: ${this.value.strength || 1.0}${this.value.strengthTwo !== undefined ? `
Clip Strength: ${this.value.strengthTwo}` : ""}`;

            alert(loraInfo);
        });
    }
}

// === MAIN NODE EXTENSION ===
// Based exactly on rgthree's registration pattern
class WanVideePowerLoraLoader {
    constructor(title = "Wan Video Power Lora Loader") {
        this.serialize_widgets = true;
        this.loraWidgetsCounter = 0;
        this.properties = {};
        this.properties[PROP_LABEL_SHOW_STRENGTHS] = PROP_VALUE_SHOW_STRENGTHS_SINGLE;

        // Fetch loras on creation
        getWanVideoLoras();
    }

    configure(info) {
        var _b;
        while ((_b = this.widgets) === null || _b === void 0 ? void 0 : _b.length)
            this.removeWidget(0);

        this._tempWidth = this.size[0];
        this._tempHeight = this.size[1];

        for (const widgetValue of info.widgets_values || []) {
            if ((widgetValue === null || widgetValue === void 0 ? void 0 : widgetValue.lora) !== undefined) {
                const widget = this.addNewLoraWidget();
                widget.value = { ...widgetValue };
            }
        }

        this.addNonLoraWidgets();
        this.size[0] = Math.max(MINIMUM_NODE_WIDTH, this._tempWidth);
        this.size[1] = Math.max(this._tempHeight, this.computeSize()[1]);
    }

    onNodeCreated() {
        this.addNonLoraWidgets();
        const computed = this.computeSize();
        this.size = this.size || [0, 0];
        this.size[0] = Math.max(MINIMUM_NODE_WIDTH, this.size[0], computed[0]);
        this.size[1] = Math.max(this.size[1], computed[1]);
        this.setDirtyCanvas(true, true);
    }

    addNewLoraWidget(lora) {
        this.loraWidgetsCounter++;
        const widget = this.addCustomWidget(new PowerLoraLoaderWidget("lora_" + this.loraWidgetsCounter));
        if (lora)
            widget.setLora(lora);
        return widget;
    }

    addNonLoraWidgets() {
        this.addCustomWidget(new RgthreeBetterButtonWidget("➕ Add Lora", (event, pos, node) => {
            getWanVideoLoras().then((lorasDetails) => {
                const loras = lorasDetails.map((l) => l.file);
                showLoraChooser(event, (value) => {
                    if (typeof value === "string") {
                        if (value !== "None") {
                            this.addNewLoraWidget(value);
                            const computed = this.computeSize();
                            const tempHeight = this._tempHeight || 15;
                            this.size[1] = Math.max(tempHeight, computed[1]);
                            this.setDirtyCanvas(true, true);
                        }
                    }
                }, null, [...loras]);
            });
            return true;
        }));
    }
}

WanVideePowerLoraLoader.title = "Wan Video Power Lora Loader";
WanVideePowerLoraLoader.type = "WanVideoPowerLoraLoader";
WanVideePowerLoraLoader.comfyClass = "WanVideoPowerLoraLoader";

const NODE_CLASS = WanVideePowerLoraLoader;

app.registerExtension({
    name: "WanVideoWrapper_QQ.PowerLoraLoader",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "WanVideoPowerLoraLoader") {
            // Store original functions
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            const originalConfigure = nodeType.prototype.configure;

            // Add configure method for workflow persistence
            nodeType.prototype.configure = function(info) {
                // Clear existing widgets using ComfyUI's method
                if (this.widgets) {
                    this.widgets.length = 0;
                }
                this.widgetButtonSpacer = null;

                // Call original configure if it exists
                if (originalConfigure) {
                    originalConfigure.call(this, info);
                }

                // Store size for restoration
                this._tempWidth = this.size[0];
                this._tempHeight = this.size[1];

                // Recreate LoRA widgets from saved data
                for (const widgetValue of info.widgets_values || []) {
                    if (widgetValue?.lora !== undefined) {
                        const widget = this.addNewLoraWidget();

                        // Ensure low_strength is preserved during restore
                        const restoredValue = { ...widgetValue };
                        if (restoredValue.low_strength === undefined) {
                            restoredValue.low_strength = 1;
                        }

                        console.log(`[JS] Restoring widget with value:`, {
                            lora: restoredValue.lora,
                            strength: restoredValue.strength,
                            low_strength: restoredValue.low_strength,
                            is_low: restoredValue.is_low,
                            full_object: restoredValue
                        });

                        widget.value = restoredValue;
                    }
                }

                // Add back the non-lora widgets
                this.addNonLoraWidgets();

                // Restore size
                this.size[0] = Math.max(MINIMUM_NODE_WIDTH, this._tempWidth);
                this.size[1] = Math.max(this._tempHeight, this.computeSize()[1]);
            };

            // Add the missing addCustomWidget method that ComfyUI needs
            nodeType.prototype.addCustomWidget = function(widget) {
                widget.parent = this;
                this.widgets = this.widgets || [];
                this.widgets.push(widget);

                // Ensure proper ComfyUI integration
                const self = this;
                const originalMouse = widget.mouse;
                widget.mouse = function(event, pos, node) {
                    // Convert global pos to local widget pos
                    const localPos = [pos[0], pos[1] - (widget.last_y || 0)];
                    return originalMouse?.call(this, event, localPos, node);
                };

                return widget;
            };

            nodeType.prototype.onNodeCreated = function() {
                const result = onNodeCreated?.apply(this, arguments);

                this.serialize_widgets = true;
                this.loraWidgetsCounter = 0;
                this.widgetButtonSpacer = null;
                this.lorasCache = []; // Cache loras for performance
                this.properties = this.properties || {};
                this.properties[PROP_LABEL_SHOW_STRENGTHS] = PROP_VALUE_SHOW_STRENGTHS_SINGLE;
                if (this.properties['low_mem_load'] === undefined) {
                    this.properties['low_mem_load'] = true;
                }
                if (this.properties['merge_loras'] === undefined) {
                    this.properties['merge_loras'] = false;
                }
                if (this.properties['overwrite_duplicates'] === undefined) {
                    this.properties['overwrite_duplicates'] = false;
                }

                // Pre-fetch loras for better performance
                getWanVideoLoras().then((lorasDetails) => {
                    this.lorasCache = lorasDetails.map((l) => l.file);
                });

                this.addNonLoraWidgets();

                const computed = this.computeSize();
                this.size = this.size || [0, 0];
                this.size[0] = Math.max(MINIMUM_NODE_WIDTH, this.size[0], computed[0]);
                this.size[1] = Math.max(this.size[1], computed[1]);
                this.setDirtyCanvas(true, true);

                return result;
            };

            nodeType.prototype.addNewLoraWidget = function(lora) {
                this.loraWidgetsCounter++;
                const widget = this.addCustomWidget(new PowerLoraLoaderWidget("lora_" + this.loraWidgetsCounter));
                if (lora)
                    widget.setLora(lora);

                // Insert before the spacer to keep Add Lora button at bottom
                if (this.widgetButtonSpacer) {
                    moveArrayItem(this.widgets, widget, this.widgets.indexOf(this.widgetButtonSpacer));
                }
                return widget;
            };

            // Add context menu methods for right-click functionality
            nodeType.prototype.getSlotInPosition = function(canvasX, canvasY) {
                const slot = LGraphNode.prototype.getSlotInPosition?.call(this, canvasX, canvasY);
                if (!slot) {
                    let lastWidget = null;
                    for (const widget of this.widgets) {
                        if (!widget.last_y)
                            return;
                        if (canvasY > this.pos[1] + widget.last_y) {
                            lastWidget = widget;
                            continue;
                        }
                        break;
                    }
                    if (lastWidget?.name?.startsWith("lora_")) {
                        return { widget: lastWidget, output: { type: "LORA WIDGET" } };
                    }
                }
                return slot;
            };

            nodeType.prototype.getSlotMenuOptions = function(slot) {
                if (slot?.widget?.name?.startsWith("lora_")) {
                    const widget = slot.widget;
                    const index = this.widgets.indexOf(widget);
                    const canMoveUp = !!this.widgets[index - 1]?.name?.startsWith("lora_");
                    const canMoveDown = !!this.widgets[index + 1]?.name?.startsWith("lora_");

                    // Return menu items in ComfyUI's expected format for getSlotMenuOptions
                    const menuItems = [
                        {
                            content: `ℹ️ Show Info`,
                            callback: () => {
                                widget.showLoraInfoDialog();
                            },
                        },
                        null, // separator
                        {
                            content: `${widget.value.on ? "⚫" : "🟢"} Toggle ${widget.value.on ? "Off" : "On"}`,
                            callback: () => {
                                widget.value.on = !widget.value.on;
                                this.setDirtyCanvas(true, true);
                            },
                        },
                        {
                            content: `⬆️ Move Up`,
                            disabled: !canMoveUp,
                            callback: () => {
                                moveArrayItem(this.widgets, widget, index - 1);
                                this.setDirtyCanvas(true, true);
                            },
                        },
                        {
                            content: `⬇️ Move Down`,
                            disabled: !canMoveDown,
                            callback: () => {
                                moveArrayItem(this.widgets, widget, index + 1);
                                this.setDirtyCanvas(true, true);
                            },
                        },
                        {
                            content: `🗑️ Remove`,
                            callback: () => {
                                removeArrayItem(this.widgets, widget);
                                this.setDirtyCanvas(true, true);
                            },
                        },
                    ];

                    // Return the menu items and let ComfyUI handle the context menu creation
                    return menuItems;
                }
                return LGraphNode.prototype.getSlotMenuOptions?.call(this, slot);
            };

            nodeType.prototype.addNonLoraWidgets = function() {
                this.widgets = this.widgets || [];
                // Add divider at position 0
                moveArrayItem(this.widgets, this.addCustomWidget(new RgthreeDividerWidget({ marginTop: 4, marginBottom: 0, thickness: 0 })), 0);

                // Add options widget at position 1
                moveArrayItem(this.widgets, this.addCustomWidget(new OptionsWidget()), 1);

                // Add header at position 2
                moveArrayItem(this.widgets, this.addCustomWidget(new PowerLoraLoaderHeaderWidget()), 2);

                // Add spacer before button
                this.widgetButtonSpacer = this.addCustomWidget(new RgthreeDividerWidget({ marginTop: 4, marginBottom: 0, thickness: 0 }));

                // Add button (will be at the end)
                this.addCustomWidget(new RgthreeBetterButtonWidget("➕ Add Lora", (event, pos, node) => {
                    // Use cached loras for instant response
                    const loras = this.lorasCache.length > 0 ? this.lorasCache : ["none"];
                    showLoraChooser(event, (value) => {
                        if (typeof value === "string") {
                            if (value !== "None" && value !== "none") {
                                this.addNewLoraWidget(value);
                                const computed = this.computeSize();
                                this.size[1] = Math.max(this.size[1], computed[1]);
                                this.setDirtyCanvas(true, true);
                            }
                        }
                    }, null, [...loras]);
                    return true;
                }));
            };

            // Add helper methods for header widget
            nodeType.prototype.hasLoraWidgets = function() {
                return !!(this.widgets?.find((w) => w.name?.startsWith("lora_")));
            };

            nodeType.prototype.allLorasState = function() {
                let allOn = true;
                let allOff = true;
                for (const widget of this.widgets || []) {
                    if (widget.name?.startsWith("lora_")) {
                        const on = widget.value?.on;
                        allOn = allOn && on === true;
                        allOff = allOff && on === false;
                        if (!allOn && !allOff) {
                            return null;
                        }
                    }
                }
                return allOn && this.widgets?.length ? true : false;
            };

            nodeType.prototype.toggleAllLoras = function() {
                const allOn = this.allLorasState();
                const toggledTo = !allOn ? true : false;
                for (const widget of this.widgets || []) {
                    if (widget.name?.startsWith("lora_") && widget.value?.on != null) {
                        widget.value.on = toggledTo;
                    }
                }
                this.setDirtyCanvas(true, true);
            };

            // Add refreshComboInNode method to handle R key press for reloading definitions
            nodeType.prototype.refreshComboInNode = function(defs) {
                console.log('[WanVideoPowerLoraLoader] Refreshing LoRA cache due to R key press');
                // Clear the cache and force refresh
                this.lorasCache = [];

                // Fetch fresh loras and update cache
                getWanVideoLoras().then((lorasDetails) => {
                    this.lorasCache = lorasDetails.map((l) => l.file);
                    console.log(`[WanVideoPowerLoraLoader] Refreshed LoRA cache with ${this.lorasCache.length} items`);

                    // Update any existing widgets that might need the fresh data
                    for (const widget of this.widgets || []) {
                        if (widget.name?.startsWith("lora_")) {
                            // Update the widget's parent reference to this node
                            widget.parent = this;

                            // Refresh low variant detection for existing LoRAs with new cache
                            if (widget.value?.lora && widget.value.lora !== "None") {
                                const oldIsLow = widget.value.is_low;
                                const oldVariantName = widget.value.low_variant_name;

                                // Re-run the low variant check with updated cache
                                widget.checkLowLoraVariant(widget.value.lora);

                                // Log changes in low variant detection
                                if (oldIsLow !== widget.value.is_low || oldVariantName !== widget.value.low_variant_name) {
                                    console.log(`[WanVideoPowerLoraLoader] Low variant status changed for '${widget.value.lora}': ` +
                                              `${oldIsLow} -> ${widget.value.is_low}, ` +
                                              `variant: '${oldVariantName}' -> '${widget.value.low_variant_name}'`);
                                }
                            }
                        }
                    }

                    // Trigger a redraw to update the green low icons
                    this.setDirtyCanvas(true, true);
                    console.log('[WanVideoPowerLoraLoader] Low variant detection refreshed for all widgets');
                }).catch(error => {
                    console.error('[WanVideoPowerLoraLoader] Error refreshing LoRA cache:', error);
                });
            };

            // Add width locking mechanism to prevent shrinking below minimum width
            nodeType.prototype.onResize = function(size) {
                // Enforce minimum width constraint
                if (size && size[0] < MINIMUM_NODE_WIDTH) {
                    size[0] = MINIMUM_NODE_WIDTH;
                }

                // Call the original onResize if it exists
                if (LGraphNode.prototype.onResize) {
                    return LGraphNode.prototype.onResize.call(this, size);
                }

                return size;
            };

            // Set up properties for the node class
            nodeType[`@${PROP_LABEL_SHOW_STRENGTHS}`] = {
                type: "combo",
                values: [PROP_VALUE_SHOW_STRENGTHS_SINGLE, PROP_VALUE_SHOW_STRENGTHS_SEPARATE],
            };
            nodeType['@low_mem_load'] = {
                type: 'boolean',
                default: false,
            };
            nodeType['@merge_loras'] = {
                type: 'boolean',
                default: true,
            };
            nodeType['@overwrite_duplicates'] = {
                type: 'boolean',
                default: false,
            };
        }
    },
});