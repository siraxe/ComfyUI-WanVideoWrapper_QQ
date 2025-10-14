import { app } from "../../../../scripts/app.js";
import { LoraPickerDialog } from "./lora_picker_dialog.js";
import { api } from "../../../../scripts/api.js";
import {
    fitString,
    measureText,
    isLowQuality,
    drawRoundedRectangle,
    drawTogglePart,
    drawNumberWidgetPart,
    drawWidgetButton,
    RgthreeBaseWidget,
    RgthreeBetterButtonWidget,
    moveArrayItem,
    removeArrayItem,
    RgthreeDividerWidget
} from "./power_lora_loader_ui.js";
import { getLoraSlotInPosition, getLoraSlotMenuOptions } from "./lora_context_menu.js";
import { loraPatternMatcher } from "./lora_pattern_matcher.js";

// === WAN VIDEO LORA API ===
// Adapted from rgthree's API calls
async function getWanVideoLoras() {
    try {
        const response = await fetch("/wanvideowrapper_qq/loras");
        const data = await response.json();
        // Filter out any "None" entries that might come from the API
        const loras = (data.loras || []).filter(l => {
            const name = typeof l === 'string' ? l : l.name;
            return name && name.toLowerCase() !== "none";
        });
        return loras;
    } catch (error) {
        console.error("Error fetching WanVideo loras:", error);
        return [];
    }
}

function saveFavorites(favorites) {
    localStorage.setItem("wanVideoPowerLoraLoader.favorites", JSON.stringify(favorites));
}

function loadFavorites() {
    const favorites = localStorage.getItem("wanVideoPowerLoraLoader.favorites");
    return favorites ? JSON.parse(favorites) : [];
}

function saveFavoritesOnly(favoritesOnly) {
    localStorage.setItem("wanVideoPowerLoraLoader.favoritesOnly", JSON.stringify(favoritesOnly));
}

function loadFavoritesOnly() {
    const favoritesOnly = localStorage.getItem("wanVideoPowerLoraLoader.favoritesOnly");
    return favoritesOnly !== null ? JSON.parse(favoritesOnly) : false;
}

function saveFoldersVisible(foldersVisible) {
    localStorage.setItem("wanVideoPowerLoraLoader.foldersVisible", JSON.stringify(foldersVisible));
}

function loadFoldersVisible() {
    const foldersVisible = localStorage.getItem("wanVideoPowerLoraLoader.foldersVisible");
    return foldersVisible !== null ? JSON.parse(foldersVisible) : false;
}

async function showLoraPicker(event, callback, parentMenu, loras, sort = "Latest", favorites = [], favoritesOnly = false, onFavoriteToggle = null, foldersVisible = null) {
    const dialog = new LoraPickerDialog(loras, {
        callback: callback,
        sort: sort,
        favorites: favorites,
        favoritesOnly: favoritesOnly,
        onFavoriteToggle: onFavoriteToggle,
        foldersVisible: foldersVisible
    });
    dialog.show();
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
        
        // Update node properties to ensure they're in sync
        node.properties['low_mem_load'] = value.low_mem_load;
        node.properties['merge_loras'] = value.merge_loras;
        node.properties['overwrite_duplicates'] = value.overwrite_duplicates;
        
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

        const allLoras = this.parent?.constructor?.prototype?.lorasCache || [];
        if (!allLoras.length) {
            return;
        }

        // Extract just the names from the cache objects for checking
        const loraNames = allLoras.map(l => typeof l === 'string' ? l : l.name);

        // Use the pattern matcher to find low variant
        const result = loraPatternMatcher.checkLowLoraVariant(loraName, loraNames);
        
        this.value.is_low = result.found;
        this.value.low_variant_name = result.variantName;
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

        // Ensure is_low and low_variant_name are preserved
        v.is_low = this.value.is_low || false;
        v.low_variant_name = this.value.low_variant_name || null;

        return v;
    }

    onToggleDown(event, pos, node) {
        this.value.on = !this.value.on;
        this.cancelMouseDown();
        return true;
    }

    onLoraClick(event, pos, node) {
        const sort = node.properties["Sort by"] || "Latest";
        // Always load favoritesOnly from persistence to ensure it's up-to-date
        const favoritesOnly = loadFavoritesOnly();
        // Update the node property to keep it in sync
        node.properties["Favorites only"] = favoritesOnly;

        // Ensure favorites array exists
        if (!node.favorites) {
            node.favorites = loadFavorites();
        }

        const onFavoriteToggle = (loraName) => {
            const index = node.favorites.indexOf(loraName);
            if (index > -1) {
                node.favorites.splice(index, 1);
            } else {
                node.favorites.push(loraName);
            }
            saveFavorites(node.favorites);
        };

        // Load folders visible state from persistence
        const foldersVisible = loadFoldersVisible();
        
        // Use cached loras from parent node for instant response, same as Add Lora button
        const cachedLoras = node.constructor.prototype.lorasCache || [];
        if (cachedLoras.length > 0) {
            // Use cached data for instant response
            showLoraPicker(event, (value) => {
                if (typeof value === "string") {
                    this.setLora(value);
                }
                node.setDirtyCanvas(true, true);
            }, null, [...cachedLoras, "None"], sort, node.favorites, favoritesOnly, onFavoriteToggle, foldersVisible);
        } else {
            // Fallback to API call if cache is empty
            showLoraPicker(event, (value) => {
                if (typeof value === "string") {
                    this.setLora(value);
                }
                node.setDirtyCanvas(true, true);
            }, null, null, sort, node.favorites, favoritesOnly, onFavoriteToggle, foldersVisible);
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
        this.doOnStrengthTwoAnyMove(event, true);
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
app.registerExtension({
    name: "WanVideo.PowerLoraLoader",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "WanVideoPowerLoraLoader") {
            // Add the properties to the node class
            nodeType.prototype.lorasCache = []; // Initialize cache for loras
            nodeType.prototype.lorasCacheLoaded = false; // Flag to track if cache is loaded

            // Load loras when the node is created
            getWanVideoLoras().then((initialLoras) => {
                // Store the full lora objects with mtime data
                nodeType.prototype.lorasCache = initialLoras;
                nodeType.prototype.lorasCacheLoaded = true;
                
                // Trigger a redraw of all existing nodes to update their UI
                app.graph._nodes.forEach(node => {
                    if (node.type === "WanVideoPowerLoraLoader") {
                        node.setDirtyCanvas(true, true);
                    }
                });
            }).catch(error => {
                console.error("[WanVideoPowerLoraLoader] Error loading loras:", error);
                nodeType.prototype.lorasCacheLoaded = true; // Set flag even on error to avoid infinite loading
            });

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
                
                // Mark node as needing widget serialization
                this.serialize_widgets = true;

                return widget;
            };

            // Add method to add new lora widget (for the button)
            nodeType.prototype.addNewLoraWidget = function (loraName) {
                this.loraWidgetsCounter++; // Increment counter like the original
                const loraWidget = this.addCustomWidget(new PowerLoraLoaderWidget("lora_" + this.loraWidgetsCounter));
                if (loraName) {
                    loraWidget.setLora(loraName); // Use setLora to properly set the lora name and check for low variant
                }
                
                // Ensure the widget is properly serialized
                this.serialize_widgets = true;
                
                // Find the Add Lora button and insert before it to keep button at bottom
                const addButtonIndex = this.widgets.findIndex(w => w instanceof RgthreeBetterButtonWidget && w.label === "➕ Add Lora");
                if (addButtonIndex !== -1) {
                    moveArrayItem(this.widgets, loraWidget, addButtonIndex);
                } else if (this.widgetButtonSpacer) {
                    // Fallback to spacer if button not found yet
                    moveArrayItem(this.widgets, loraWidget, this.widgets.indexOf(this.widgetButtonSpacer));
                }
                
                return loraWidget;
            };

            // Add onNodeCreated method to the node prototype for ComfyUI compatibility
            nodeType.prototype.onNodeCreated = function() {
                // Initialize node properties
                this.serialize_widgets = true;
                this.loraWidgetsCounter = 0;
                this.widgetButtonSpacer = null;
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
                if (this.properties['Favorites only'] === undefined) {
                    this.properties['Favorites only'] = loadFavoritesOnly();
                }

                // Initialize favorites
                this.favorites = loadFavorites();

                // Add non lora widgets
                this.addNonLoraWidgets();

                // Ensure minimum size
                const computed = this.computeSize();
                this.size = this.size || [0, 0];
                this.size[0] = Math.max(MINIMUM_NODE_WIDTH, this.size[0], computed[0]);
                this.size[1] = Math.max(this.size[1], computed[1]);
                
                // Force a redraw to ensure the UI is visible
                this.setDirtyCanvas(true, true);
            };

            // Override the clone method to preserve LoRA widgets when copying
            const originalClone = nodeType.prototype.clone;
            nodeType.prototype.clone = function() {
                // First, call the original clone function to get base node
                const cloned = originalClone.apply(this, arguments);
                
                // Copy favorites
                cloned.favorites = [...this.favorites];
                
                // Clear the cloned node's widgets to prevent duplication during addNonLoraWidgets
                cloned.widgets = [];
                
                // Store the original Lora widgets' values to recreate them
                const loraWidgetValues = [];
                if (this.widgets) {
                    for (const widget of this.widgets) {
                        if (widget.name?.startsWith("lora_")) {
                            loraWidgetValues.push({
                                name: widget.name,
                                value: { ...widget.value }
                            });
                        }
                    }
                }
                
                // Add non lora widgets to the cloned node first
                cloned.addNonLoraWidgets();
                
                // Then add the Lora widgets after non-Lora widgets are in place
                for (const loraWidgetData of loraWidgetValues) {
                    const clonedWidget = cloned.addCustomWidget(new PowerLoraLoaderWidget(loraWidgetData.name));
                    clonedWidget.value = { ...loraWidgetData.value };
                    clonedWidget.parent = cloned;
                    
                    // Move the widget to the correct position before the Add Lora button
                    const addButtonIndex = cloned.widgets.findIndex(w => w instanceof RgthreeBetterButtonWidget && w.label === "➕ Add Lora");
                    if (addButtonIndex !== -1) {
                        moveArrayItem(cloned.widgets, clonedWidget, addButtonIndex);
                    } else if (cloned.widgetButtonSpacer) {
                        // Fallback to spacer if button not found yet
                        moveArrayItem(cloned.widgets, clonedWidget, cloned.widgets.indexOf(cloned.widgetButtonSpacer));
                    }
                }
                
                // Restore size from original
                cloned.size = [...this.size];
                
                return cloned;
            };

            // Add method to add non lora widgets so they can be placed correctly
            nodeType.prototype.addNonLoraWidgets = function () {
                this.widgets = this.widgets || [];
                
                // Check if widgets already exist to prevent duplicates
                const hasOptionsWidget = this.widgets.find(w => w instanceof OptionsWidget);
                const hasHeaderWidget = this.widgets.find(w => w instanceof PowerLoraLoaderHeaderWidget);
                const hasAddButton = this.widgets.find(w => w instanceof RgthreeBetterButtonWidget && w.label === "➕ Add Lora");
                
                // Only add widgets if they don't already exist
                if (!hasOptionsWidget) {
                    // Add divider at position 0
                    moveArrayItem(this.widgets, this.addCustomWidget(new RgthreeDividerWidget({ marginTop: 4, marginBottom: 0, thickness: 0 })), 0);

                    // Add options widget at position 1
                    moveArrayItem(this.widgets, this.addCustomWidget(new OptionsWidget()), 1);
                }
                
                if (!hasHeaderWidget) {
                    // Add header at position 2
                    moveArrayItem(this.widgets, this.addCustomWidget(new PowerLoraLoaderHeaderWidget()), 2);
                }
                
                // Add spacer before button (check if it exists)
                if (!this.widgetButtonSpacer) {
                    this.widgetButtonSpacer = this.addCustomWidget(new RgthreeDividerWidget({ marginTop: 4, marginBottom: 0, thickness: 0 }));
                }

                if (!hasAddButton) {
                    // Add button (will be at the end)
                    this.addCustomWidget(new RgthreeBetterButtonWidget("➕ Add Lora", (event, pos, node) => {
                        const sort = node.properties["Sort by"] || "Latest";
                        // Always load favoritesOnly from persistence to ensure it's up-to-date
                        const favoritesOnly = loadFavoritesOnly();
                        // Update the node property to keep it in sync
                        node.properties["Favorites only"] = favoritesOnly;

                        // Ensure favorites array exists
                        if (!node.favorites) {
                            node.favorites = loadFavorites();
                        }

                        const onFavoriteToggle = (loraName) => {
                            const index = node.favorites.indexOf(loraName);
                            if (index > -1) {
                                node.favorites.splice(index, 1);
                            } else {
                                node.favorites.push(loraName);
                            }
                            saveFavorites(node.favorites);
                        };

                        // Load folders visible state from persistence
                        const foldersVisible = loadFoldersVisible();
                        
                        // Use cached loras for instant response
                        const loras = this.constructor.prototype.lorasCache.length > 0 ? this.constructor.prototype.lorasCache : [];
                        showLoraPicker(event, (value) => {
                            if (typeof value === "string") {
                                if (value !== "None" && value !== "none") {
                                    this.addNewLoraWidget(value);
                                    const computed = this.computeSize();
                                    this.size[1] = Math.max(this.size[1], computed[1]);
                                    this.setDirtyCanvas(true, true);
                                }
                            }
                        }, null, [...loras, "None"], sort, node.favorites, favoritesOnly, onFavoriteToggle, foldersVisible);
                        return true;
                    }));
                }
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
                // Clear the cache and force refresh
                this.constructor.prototype.lorasCache = [];
                this.constructor.prototype.lorasCacheLoaded = false;

                // Fetch fresh loras and update cache
                getWanVideoLoras().then((lorasDetails) => {
                    // Store the full lora objects with mtime data
                    this.constructor.prototype.lorasCache = lorasDetails;
                    this.constructor.prototype.lorasCacheLoaded = true;

                    // Update all nodes of this type
                    app.graph._nodes.forEach(node => {
                        if (node.type === "WanVideoPowerLoraLoader") {
                            // Update any existing widgets that might need the fresh data
                            for (const widget of node.widgets || []) {
                                if (widget.name?.startsWith("lora_")) {
                                    // Update the widget's parent reference to this node
                                    widget.parent = node;

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
                            node.setDirtyCanvas(true, true);
                        }
                    });
                }).catch(error => {
                    console.error('[WanVideoPowerLoraLoader] Error refreshing LoRA cache:', error);
                    this.constructor.prototype.lorasCacheLoaded = true; // Set flag even on error
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
            nodeType['@Favorites only'] = {
                type: 'boolean',
                default: false,
            };
            
            // Add method to compute size properly
            nodeType.prototype.computeSize = function(width) {
                const minWidth = MINIMUM_NODE_WIDTH;
                const minHeight = 100; // Base height
                let computedHeight = minHeight;
                
                // Calculate height based on number of lora widgets
                if (this.widgets) {
                    const loraWidgets = this.widgets.filter(w => w.name?.startsWith("lora_"));
                    if (loraWidgets.length > 0) {
                        computedHeight += loraWidgets.length * LiteGraph.NODE_WIDGET_HEIGHT;
                    }
                }
                
                // Account for other widgets too
                if (this.widgets) {
                    // Count non-lora widgets that contribute to height
                    const nonLoraWidgets = this.widgets.filter(w => !w.name?.startsWith("lora_") && 
                                                                  !(w.computeSize === undefined));
                    if (nonLoraWidgets.length > 0) {
                        for (const widget of nonLoraWidgets) {
                            if (widget.computeSize) {
                                const widgetSize = widget.computeSize(width || this.size[0]);
                                if (widgetSize && widgetSize[1]) {
                                    computedHeight += widgetSize[1];
                                } else {
                                    computedHeight += LiteGraph.NODE_WIDGET_HEIGHT;
                                }
                            } else {
                                computedHeight += LiteGraph.NODE_WIDGET_HEIGHT;
                            }
                        }
                    } else {
                        // If there are no special computeSize widgets, just add base amount for non-lora widgets
                        const otherWidgetsCount = this.widgets.length - (this.widgets.filter(w => w.name?.startsWith("lora_")).length);
                        computedHeight += otherWidgetsCount * LiteGraph.NODE_WIDGET_HEIGHT;
                    }
                }
                
                return [minWidth, computedHeight];
            };
            
            // Add context menu methods to the node type prototype
            nodeType.prototype.getSlotInPosition = getLoraSlotInPosition;
            nodeType.prototype.getSlotMenuOptions = getLoraSlotMenuOptions;
        }
    },
    configure(node, nodeData) {
        if(node.type === "WanVideoPowerLoraLoader") {
            // Clear existing widgets using ComfyUI's method but keep non-Lora widgets
            if (node.widgets) {
                // Keep track of non-Lora widgets to restore them
                const nonLoraWidgets = node.widgets.filter(w => !w.name?.startsWith("lora_"));
                node.widgets = [...nonLoraWidgets]; // Keep only non-Lora widgets
            }
            
            // Initialize favorites if not already done
            if (!node.favorites) {
                node.favorites = loadFavorites();
            }

            // Restore Lora widgets from saved data
            // Use nodeData.widgets_values which should contain the original widget values
            const widgetValues = nodeData.widgets_values || [];
            for (const widgetValue of widgetValues) {
                if (widgetValue?.lora !== undefined) {
                    const widget = node.addNewLoraWidget();
                    
                    // Ensure low_strength is preserved during restore
                    const restoredValue = { ...widgetValue };
                    if (restoredValue.low_strength === undefined) {
                        restoredValue.low_strength = 1;
                    }
                    widget.value = restoredValue;
                }
            }

            // Add back the non-lora widgets if they're not already there
            if (!node.widgets || node.widgets.length === 0) {
                node.addNonLoraWidgets();
            }
            
            // Ensure proper serialization
            node.serialize_widgets = true;
            
            // Update parent references for all widgets
            for (const widget of node.widgets || []) {
                if (widget.name?.startsWith("lora_")) {
                    widget.parent = node;
                    // Re-check low variant if lora is set and cache is available
                    if (widget.value?.lora && widget.value.lora !== "None" && node.constructor.prototype.lorasCacheLoaded) {
                        widget.checkLowLoraVariant(widget.value.lora);
                    }
                }
            }
            
            // Force a redraw to ensure the UI is visible
            node.setDirtyCanvas(true, true);
        }
    },
    nodeCreated(node) {
        if(node.type === "WanVideoPowerLoraLoader") {
            // Initialize favorites for this node instance
            node.favorites = loadFavorites();
            
            // Call the onNodeCreated method if it exists
            if (typeof node.onNodeCreated === 'function') {
                node.onNodeCreated();
            }
            
            // Set up cache loading listener
            const updateWidgetReferences = () => {
                // Update parent references for all widgets
                for (const widget of node.widgets || []) {
                    if (widget.name?.startsWith("lora_")) {
                        widget.parent = node;
                        // Re-check low variant if lora is set
                        if (widget.value?.lora && widget.value.lora !== "None") {
                            widget.checkLowLoraVariant(widget.value.lora);
                        }
                    }
                }
                // Force a redraw to update the UI
                node.setDirtyCanvas(true, true);
            };
            
            // If loras cache is already loaded, update immediately
            if (node.constructor.prototype.lorasCacheLoaded) {
                setTimeout(updateWidgetReferences, 100);
            } else {
                // Set up a listener to update when cache is loaded
                const checkCache = setInterval(() => {
                    if (node.constructor.prototype.lorasCacheLoaded) {
                        clearInterval(checkCache);
                        updateWidgetReferences();
                    }
                }, 100);
                
                // Clear the interval after 10 seconds to prevent memory leaks
                setTimeout(() => {
                    clearInterval(checkCache);
                }, 10000);
            }
        }
    },
    loadedGraphNode(node, app) {
        if(node?.constructor?.nodeData?.name === "WanVideoPowerLoraLoader") {
            // Initialize favorites for this node instance
            node.favorites = loadFavorites();
            
            // Initialize properties if they don't exist
            node.properties = node.properties || {};
            if (node.properties['low_mem_load'] === undefined) node.properties['low_mem_load'] = true;
            if (node.properties['merge_loras'] === undefined) node.properties['merge_loras'] = false;
            if (node.properties['overwrite_duplicates'] === undefined) node.properties['overwrite_duplicates'] = false;
            if (node.properties['Favorites only'] === undefined) node.properties['Favorites only'] = loadFavoritesOnly();
            if (node.properties[PROP_LABEL_SHOW_STRENGTHS] === undefined) {
                node.properties[PROP_LABEL_SHOW_STRENGTHS] = PROP_VALUE_SHOW_STRENGTHS_SINGLE;
            }
            
            // Clear widgets array first to prevent duplicates
            node.widgets = [];
            
            // Restore LoRA widgets from saved widget values
            // node.widgets_values is an array of widget values, not an object
            const widgetValues = node.widgets_values || [];
            
            // Filter out the non-Lora widgets (the options and header widgets) and only process Lora ones
            // We need to identify which values belong to Lora widgets by checking for required Lora properties
            for (let i = 0; i < widgetValues.length; i++) {
                const widgetValue = widgetValues[i];
                
                // Check if this widget value is a Lora widget by checking for required Lora properties
                if (widgetValue && typeof widgetValue === "object" && 
                    'lora' in widgetValue && 'on' in widgetValue && 'strength' in widgetValue) {
                    
                    // Create a new widget with the saved data
                    // We need to generate the proper widget name based on position
                    const widgetName = `lora_${i}`;
                    const loraWidget = new PowerLoraLoaderWidget(widgetName);
                    loraWidget.value = { ...DEFAULT_LORA_WIDGET_DATA, ...widgetValue };
                    loraWidget.parent = node;
                    
                    // Add the widget to the node
                    node.addCustomWidget(loraWidget);
                    
                    // Move the widget to the correct position before the Add Lora button
                    const addButtonIndex = node.widgets.findIndex(w => w instanceof RgthreeBetterButtonWidget && w.label === "➕ Add Lora");
                    if (addButtonIndex !== -1) {
                        moveArrayItem(node.widgets, loraWidget, addButtonIndex);
                    } else if (node.widgetButtonSpacer) {
                        // Fallback to spacer if button not found yet
                        moveArrayItem(node.widgets, loraWidget, node.widgets.indexOf(node.widgetButtonSpacer));
                    }
                }
            }
            
            // Add non lora widgets after the node is loaded
            node.addNonLoraWidgets();
            
            // Make sure we have the right size
            const computed = node.computeSize();
            node.size[1] = Math.max(node.size[1], computed[1]);
            
            // Function to update widget parent references and check low variants
            const updateWidgetReferences = () => {
                // Update parent references for all widgets
                for (const widget of node.widgets || []) {
                    if (widget.name?.startsWith("lora_")) {
                        widget.parent = node;
                        // Re-check low variant if lora is set
                        if (widget.value?.lora && widget.value.lora !== "None") {
                            widget.checkLowLoraVariant(widget.value.lora);
                        }
                    }
                }
                // Force a redraw to update the UI
                node.setDirtyCanvas(true, true);
            };
            
            // If loras cache is already loaded, update immediately
            if (node.constructor.prototype.lorasCacheLoaded) {
                updateWidgetReferences();
            } else {
                // Set up a listener to update when cache is loaded
                const checkCache = setInterval(() => {
                    if (node.constructor.prototype.lorasCacheLoaded) {
                        clearInterval(checkCache);
                        updateWidgetReferences();
                    }
                }, 100); // Check every 100ms
                
                // Clear the interval after 10 seconds to prevent memory leaks
                setTimeout(() => {
                    clearInterval(checkCache);
                }, 10000);
            }
        }
    },
    onRemoved: function () {
        // When the node is removed, clear all non-Lora widgets
        // to prevent UI conflicts when a new node is added.
        if (this.widgets) {
            for (let i = this.widgets.length - 1; i >= 0; i--) {
                const widget = this.widgets[i];
                if (widget.type !== 'custom' || !widget.name?.startsWith('lora_')) {
                    this.widgets.splice(i, 1);
                }
            }
        }
    },
});