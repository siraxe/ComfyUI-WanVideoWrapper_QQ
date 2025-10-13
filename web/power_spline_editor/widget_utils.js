import { app } from '../../../scripts/app.js';
import { isLowQuality, drawTogglePart, drawNumberWidgetPart, drawRoundedRectangle, fitString, RgthreeBaseWidget } from './drawing_utils.js';
import { initializeDrivenConfig, initializeEasingConfig, initializeScaleConfig, toggleDrivenState, prepareDrivenMenu } from './persistence.js';
import { showCustomEasingMenu, showCustomDrivenToggleMenu } from './context_menu.js';

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

            // Easing column - same width as interpolation
            const easingTextWidth = 70;
            ctx.fillText("Easing", rposX - easingTextWidth / 2, midY);
            rposX -= easingTextWidth + 10;

            // Scale column
            ctx.fillText("Scale", rposX - numberWidth / 2, midY);
            rposX -= numberWidth + 10;
            
            // Driven column (moved after Scale)
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
            easingVal: { bounds: [0, 0], onClick: this.onEasingClick, onRightDown: this.onEasingRightDown },
            drivenToggle: { bounds: [0, 0], onDown: this.onDrivenToggleDown, onRightDown: this.onDrivenToggleRightDown },
            scaleDec: { bounds: [0, 0], onClick: this.onScaleDec },
            scaleVal: { bounds: [0, 0], onClick: this.onScaleClick },
            scaleInc: { bounds: [0, 0], onClick: this.onScaleInc },
            scaleAny: { bounds: [0, 0], onMove: this.onScaleMove },
        };
        this._value = {
            on: true,
            name: "Spline",
            interpolation: 'linear',
            repeat: 1,
            offset: 0,
            a_pause: 0,
            z_pause: 0,
            easing: 'in_out', // Use simple name for consistency
            driven: false, // false = off, object = on with config
            _drivenConfig: { driver: "", rotate: 0, d_scale: 1.0 }, // Preserved config
            easingConfig: { path: "each", strength: 1.0 }, // Easing configuration
            scale: 1.00, // Scale factor with min 0.01, max 8.00, default 1.00
            points_store: "[]",
            coordinates: "[]",
        };
    }

    set value(v) {
        // Merge constructor defaults with loaded data
        this._value = { ...this._value, ...(typeof v === 'object' && v !== null ? v : {}) };

        // Initialize persistent configurations using centralized functions
        initializeDrivenConfig(this._value, v);
        initializeEasingConfig(this._value, v);
        initializeScaleConfig(this._value, v);
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
            drawRoundedRectangle(ctx, { pos: [posX, posY], size: [node.size[0] - margin * 2, height], colorStroke: "#1f77b4", colorBackground: "#222222CC" });
        } else {
            drawRoundedRectangle(ctx, { pos: [posX, posY], size: [node.size[0] - margin * 2, height], colorBackground: "#222222CC" });
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

        // Draw easing selector (same approach as interpolation)
        const easingModes = ['linear', 'in', 'out', 'in_out', 'out_in'];
        const easingShortNames = ['linear', 'in', 'out', 'in_out', 'out_in'];
        const easingIndex = easingModes.indexOf(this.value.easing || 'in_out');
        const easingDisplayText = easingIndex >= 0 ? easingShortNames[easingIndex] : 'in_out';
        const easingTextWidth = 70;
        ctx.textAlign = "center";
        ctx.fillText(easingDisplayText, rposX - easingTextWidth / 2, midY);
        this.hitAreas.easingVal.bounds = [rposX - easingTextWidth, easingTextWidth];
        rposX -= easingTextWidth + 10;

        // Draw scale control
        const [scaleL, scaleT, scaleR] = drawNumberWidgetPart(ctx, {
            posX: rposX, posY, height, value: this.value.scale || 1.00, direction: -1, precision: 2,
        });
        this.hitAreas.scaleDec.bounds = scaleL;
        this.hitAreas.scaleVal.bounds = scaleT;
        this.hitAreas.scaleInc.bounds = scaleR;
        this.hitAreas.scaleAny.bounds = [scaleL[0], scaleR[0] + scaleR[1] - scaleL[0]];
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

    onEasingClick() {
        // Cycle through easing modes
        const modes = ['linear', 'in', 'out', 'in_out', 'out_in'];
        const currentIndex = modes.indexOf(this.value.easing || 'in_out');
        const newIndex = (currentIndex + 1) % modes.length;
        this.value.easing = modes[newIndex];
        this.parent.setDirtyCanvas(true, true);
        return true;
    }

    onEasingRightDown(event, pos, node) {
        event.preventDefault(); // Prevent default browser context menu
        event.stopPropagation(); // Stop event from propagating further

        // Get screen position for the menu (similar to Driven toggle)
        const canvas = app.canvas;
        let x = 100;
        let y = 100;

        // Try to get from last_mouse_position (canvas screen coords)
        if (canvas.last_mouse_position) {
            x = canvas.last_mouse_position[0];
            y = canvas.last_mouse_position[1];
        }
        // Try canvas_mouse (might be available)
        else if (canvas.canvas_mouse) {
            x = canvas.canvas_mouse[0];
            y = canvas.canvas_mouse[1];
        }
        // Convert graph coordinates to screen coordinates
        else if (canvas.graph_mouse && canvas.ds) {
            const graphX = canvas.graph_mouse[0];
            const graphY = canvas.graph_mouse[1];
            // Convert from graph space to canvas space
            x = graphX * canvas.ds.scale + canvas.ds.offset[0];
            y = graphY * canvas.ds.scale + canvas.ds.offset[1];
            // Convert from canvas space to screen space
            const canvasRect = canvas.canvas.getBoundingClientRect();
            x += canvasRect.left;
            y += canvasRect.top;
        }

        console.log("Easing menu position calculated:", {x, y});

        // Show context menu for easing configuration (UI only)
        showCustomEasingMenu(event, this, { x, y });
        this.cancelMouseDown();
        return true;
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
        // Call the centralized toggle logic
        toggleDrivenState(this);
        this.cancelMouseDown();
        return true;
    }

    onDrivenToggleRightDown(event, pos, node) {
        event.preventDefault(); // Prevent default browser context menu
        event.stopPropagation(); // Stop event from propagating further

        // Call the centralized function to prepare the config object
        prepareDrivenMenu(this);

        // Show context menu for the driven toggle specifically
        showCustomDrivenToggleMenu(event, this, { x: pos[0], y: pos[1] });
        this.cancelMouseDown();
        return true;
    }

    onScaleDec() {
        this.value.scale = Math.max(0.01, parseFloat((this.value.scale || 1.00) - 0.01).toFixed(2));
        this.parent.setDirtyCanvas(true, true);
        return true;
    }

    onScaleInc() {
        this.value.scale = Math.min(8.00, parseFloat((this.value.scale || 1.00) + 0.01).toFixed(2));
        this.parent.setDirtyCanvas(true, true);
        return true;
    }

    onScaleClick() {
        if (this.haveMouseMovedValue) return;
        const canvas = app.canvas;
        canvas.prompt("Scale", this.value.scale || 1.00, (v) => {
            this.value.scale = Math.max(0.01, Math.min(8.00, parseFloat(Number(v).toFixed(2))));
            this.parent.setDirtyCanvas(true, true);
        });
        return true;
    }

    onScaleMove(event, pos, node) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            this.value.scale = Math.max(0.01, Math.min(8.00, parseFloat(((this.value.scale || 1.00) + (event.deltaX / 1000)).toFixed(2))));
            node.setDirtyCanvas(true, true);
        }
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