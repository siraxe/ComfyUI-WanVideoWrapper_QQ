import { app } from "../../../../scripts/app.js";

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
    // ctx.fill(new Path2D(`M ${posX} ${midY - arrowHeight / 2} l ${arrowWidth} ${arrowHeight / 2} l -${arrowWidth} ${arrowHeight} v -${arrowHeight} z`));
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