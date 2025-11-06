// Hand-draw layer widget and helpers
import { RgthreeBaseWidget, drawRoundedRectangle, drawTogglePart, drawNumberWidgetPart, fitString } from './drawing_utils.js';
import { initializeDrivenConfig, initializeEasingConfig, initializeScaleConfig, toggleDrivenState, prepareDrivenMenu } from './persistence.js';
import { showCustomEasingMenu, showCustomDrivenToggleMenu } from './context_menu.js';
import { app } from '../../../scripts/app.js';

export class HandDrawLayerWidget extends RgthreeBaseWidget {
    constructor(name) {
        super(name);
        this.type = 'custom';
        this.options = { serialize: true };
        this.haveMouseMovedValue = false;
        this.hitAreas = {
            toggle: { bounds: [0,0], onDown: this.onToggleDown },
            name: { bounds: [0,0] },
            drawLabel: { bounds: [0,0] },
            repeatDec: { bounds: [0,0], onClick: this.onRepeatDec },
            repeatVal: { bounds: [0,0], onClick: this.onRepeatClick },
            repeatInc: { bounds: [0,0], onClick: this.onRepeatInc },
            repeatAny: { bounds: [0,0], onMove: this.onRepeatMove },
            // Offset / A-Pause / Z-Pause controls (initialize to avoid undefined)
            offsetDec: { bounds: [0,0], onClick: this.onOffsetDec },
            offsetVal: { bounds: [0,0], onClick: this.onOffsetClick },
            offsetInc: { bounds: [0,0], onClick: this.onOffsetInc },
            offsetAny: { bounds: [0,0], onMove: this.onOffsetMove },
            aPauseDec: { bounds: [0,0], onClick: this.onAPauseDec },
            aPauseVal: { bounds: [0,0], onClick: this.onAPauseClick },
            aPauseInc: { bounds: [0,0], onClick: this.onAPauseInc },
            aPauseAny: { bounds: [0,0], onMove: this.onAPauseMove },
            zPauseDec: { bounds: [0,0], onClick: this.onZPauseDec },
            zPauseVal: { bounds: [0,0], onClick: this.onZPauseClick },
            zPauseInc: { bounds: [0,0], onClick: this.onZPauseInc },
            zPauseAny: { bounds: [0,0], onMove: this.onZPauseMove },
            easingVal: { bounds: [0,0], onClick: this.onEasingClick, onRightDown: this.onEasingRightDown },
            drivenToggle: { bounds: [0,0], onDown: this.onDrivenToggleDown, onRightDown: this.onDrivenToggleRightDown },
            scaleDec: { bounds: [0,0], onClick: this.onScaleDec },
            scaleVal: { bounds: [0,0], onClick: this.onScaleClick },
            scaleInc: { bounds: [0,0], onClick: this.onScaleInc },
            scaleAny: { bounds: [0,0], onMove: this.onScaleMove },
        };
        this.value = {
            type: 'handdraw',
            on: true,
            name: 'Handdraw',
            repeat: 1,
            points_store: '[]',
            interpolation: 'points',
            // parity with normal layers
            offset: 0,
            a_pause: 0,
            z_pause: 0,
            easing: 'in_out',
            easingConfig: { path: 'full', strength: 1.0 },
            driven: false,
            _drivenConfig: { driver: '', rotate: 0, d_scale: 1.0 },
            scale: 1.00,
        };
        // ensure configs exist
        initializeDrivenConfig(this.value, this.value);
        initializeEasingConfig(this.value, this.value);
        initializeScaleConfig(this.value, this.value);
    }

    draw(ctx, node, w, posY, height) {
        const margin = 10;
        const innerMargin = margin * 0.33;
        const midY = posY + height * 0.5;
        let posX = 10;
        ctx.save();
        // background (match active selection style of normal layers)
        if (node.layerManager && node.layerManager.getActiveWidget() === this) {
            drawRoundedRectangle(ctx, {
                pos: [posX, posY],
                size: [node.size[0] - margin * 2, height],
                colorStroke: '#2cc6ff',
                colorBackground: '#080808E6'
            });
        } else {
            drawRoundedRectangle(ctx, { pos: [posX, posY], size: [node.size[0] - margin * 2, height], colorBackground: '#222222CC' });
        }
        // toggle
        this.hitAreas.toggle.bounds = drawTogglePart(ctx, { posX, posY, height, value: this.value.on });
        posX += this.hitAreas.toggle.bounds[1] + innerMargin;

        // Name
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        let rposX = node.size[0] - margin - innerMargin;

        // Order and spacing mirrors normal layer:
        // [Repeat] [Draw(label=70)] [Z-Pause] [A-Pause] [Offset] [Easing(label=70)] [Scale] [Driven] ... Name

        // Repeat control at far right
        const [repeatL, repeatT, repeatR] = drawNumberWidgetPart(ctx, {
            posX: rposX, posY, height, value: this.value.repeat || 1, direction: -1,
        });
        this.hitAreas.repeatDec.bounds = repeatL;
        this.hitAreas.repeatVal.bounds = repeatT;
        this.hitAreas.repeatInc.bounds = repeatR;
        this.hitAreas.repeatAny.bounds = [repeatL[0], repeatR[0] + repeatR[1] - repeatL[0]];
        rposX -= drawNumberWidgetPart.WIDTH_TOTAL + 10;

        // Draw label in the Interpolation slot (70px)
        const labelWidth = 70;
        ctx.textAlign = 'center';
        ctx.fillText('draw', rposX - labelWidth / 2, midY);
        this.hitAreas.drawLabel.bounds = [rposX - labelWidth, labelWidth];
        rposX -= labelWidth + 10;

        // Z-Pause
        const [zPauseL, zPauseT, zPauseR] = drawNumberWidgetPart(ctx, {
            posX: rposX, posY, height, value: this.value.z_pause || 0, direction: -1,
        });
        this.hitAreas.zPauseDec.bounds = zPauseL;
        this.hitAreas.zPauseVal.bounds = zPauseT;
        this.hitAreas.zPauseInc.bounds = zPauseR;
        this.hitAreas.zPauseAny.bounds = [zPauseL[0], zPauseR[0] + zPauseR[1] - zPauseL[0]];
        rposX -= drawNumberWidgetPart.WIDTH_TOTAL + 10;

        // A-Pause
        const [aPauseL, aPauseT, aPauseR] = drawNumberWidgetPart(ctx, {
            posX: rposX, posY, height, value: this.value.a_pause || 0, direction: -1,
        });
        this.hitAreas.aPauseDec.bounds = aPauseL;
        this.hitAreas.aPauseVal.bounds = aPauseT;
        this.hitAreas.aPauseInc.bounds = aPauseR;
        this.hitAreas.aPauseAny.bounds = [aPauseL[0], aPauseR[0] + aPauseR[1] - aPauseL[0]];
        rposX -= drawNumberWidgetPart.WIDTH_TOTAL + 10;

        // Offset
        const [offsetL, offsetT, offsetR] = drawNumberWidgetPart(ctx, {
            posX: rposX, posY, height, value: this.value.offset || 0, direction: -1,
        });
        this.hitAreas.offsetDec.bounds = offsetL;
        this.hitAreas.offsetVal.bounds = offsetT;
        this.hitAreas.offsetInc.bounds = offsetR;
        this.hitAreas.offsetAny.bounds = [offsetL[0], offsetR[0] + offsetR[1] - offsetL[0]];
        rposX -= drawNumberWidgetPart.WIDTH_TOTAL + 10;

        // Easing (text, opens config on click)
        const easingModes = ['linear', 'in', 'out', 'in_out', 'out_in'];
        const easingShortNames = ['linear', 'in', 'out', 'in_out', 'out_in'];
        const easingIndex = easingModes.indexOf(this.value.easing || 'in_out');
        const easingDisplayText = easingIndex >= 0 ? easingShortNames[easingIndex] : 'in_out';
        const easingTextWidth = 70;
        ctx.textAlign = 'center';
        ctx.fillText(easingDisplayText, rposX - easingTextWidth / 2, midY);
        this.hitAreas.easingVal.bounds = [rposX - easingTextWidth, easingTextWidth];
        rposX -= easingTextWidth + 10;

        // Scale control
        const [scaleL, scaleT, scaleR] = drawNumberWidgetPart(ctx, {
            posX: rposX, posY, height, value: this.value.scale || 1.00, direction: -1, precision: 2,
        });
        this.hitAreas.scaleDec.bounds = scaleL;
        this.hitAreas.scaleVal.bounds = scaleT;
        this.hitAreas.scaleInc.bounds = scaleR;
        this.hitAreas.scaleAny.bounds = [scaleL[0], scaleR[0] + scaleR[1] - scaleL[0]];
        rposX -= drawNumberWidgetPart.WIDTH_TOTAL + 10;

        // Driven toggle (aligned like normal)
        ctx.textAlign = 'left';
        const numberWidth = drawNumberWidgetPart.WIDTH_TOTAL;
        const drivenPosX = rposX - numberWidth / 2 - 15;
        this.hitAreas.drivenToggle.bounds = drawTogglePart(ctx, { posX: drivenPosX, posY, height, value: this.value.driven });
        rposX -= numberWidth + 10;

        // Layer name on left
        ctx.textAlign = 'left';
        const nameText = fitString(ctx, this.value.name || 'Handdraw', rposX - posX - innerMargin);
        ctx.fillText(nameText, posX, midY);
        this.hitAreas.name.bounds = [posX, 0, rposX - posX, height];
        ctx.restore();
    }

    onMouseDown(event, pos, node) {
        // Selecting the row should activate this layer
        if (node.layerManager) {
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
        canvas.prompt('Repeat', this.value.repeat || 1, (v) => {
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

    // EASING handlers
    onEasingClick() {
        // Match normal layers: left-click cycles easing types
        const modes = ['linear', 'in', 'out', 'in_out', 'out_in'];
        const currentIndex = modes.indexOf(this.value.easing || 'in_out');
        const newIndex = (currentIndex + 1) % modes.length;
        this.value.easing = modes[newIndex];
        this.parent.setDirtyCanvas(true, true);
        return true;
    }
    onEasingRightDown(event, pos, node) {
        // Right-click opens the easing configuration menu
        showCustomEasingMenu(event, this, { x: event?.clientX ?? pos[0], y: event?.clientY ?? pos[1] });
        return true;
    }

    // DRIVEN handlers
    onDrivenToggleDown(event, pos, node) {
        toggleDrivenState(this);
        node.setDirtyCanvas(true, true);
        return true;
    }
    onDrivenToggleRightDown(event, pos, node) {
        prepareDrivenMenu(this);
        showCustomDrivenToggleMenu(event, this, { x: pos[0], y: pos[1] });
        return true;
    }

    // SCALE handlers
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

    // OFFSET/A/Z handlers (mirroring normal layer behaviors)
    onOffsetDec() { this.value.offset = Math.max(-100, (this.value.offset || 0) - 1); this.parent.setDirtyCanvas(true, true); return true; }
    onOffsetInc() { this.value.offset = Math.min(100, (this.value.offset || 0) + 1); this.parent.setDirtyCanvas(true, true); return true; }
    onOffsetClick() { const c = app.canvas; c.prompt('Offset', this.value.offset || 0, (v)=>{ this.value.offset = Math.max(-100, Math.min(100, Number(v))); this.parent.setDirtyCanvas(true, true); }); return true; }
    onOffsetMove(event, pos, node) { if (event.deltaX) { this.haveMouseMovedValue = true; this.value.offset = Math.max(-100, Math.min(100, (this.value.offset || 0) + Math.round(event.deltaX / 10))); node.setDirtyCanvas(true, true);} }

    onAPauseDec() { this.value.a_pause = Math.max(0, (this.value.a_pause || 0) - 1); this.parent.setDirtyCanvas(true, true); return true; }
    onAPauseInc() { this.value.a_pause = Math.min(100, (this.value.a_pause || 0) + 1); this.parent.setDirtyCanvas(true, true); return true; }
    onAPauseClick() { const c = app.canvas; c.prompt('A-Pause', this.value.a_pause || 0, (v)=>{ this.value.a_pause = Math.max(0, Math.min(100, Number(v))); this.parent.setDirtyCanvas(true, true); }); return true; }
    onAPauseMove(event, pos, node) { if (event.deltaX) { this.haveMouseMovedValue = true; this.value.a_pause = Math.max(0, Math.min(100, (this.value.a_pause || 0) + Math.round(event.deltaX / 10))); node.setDirtyCanvas(true, true);} }

    onZPauseDec() { this.value.z_pause = Math.max(0, (this.value.z_pause || 0) - 1); this.parent.setDirtyCanvas(true, true); return true; }
    onZPauseInc() { this.value.z_pause = Math.min(100, (this.value.z_pause || 0) + 1); this.parent.setDirtyCanvas(true, true); return true; }
    onZPauseClick() { const c = app.canvas; c.prompt('Z-Pause', this.value.z_pause || 0, (v)=>{ this.value.z_pause = Math.max(0, Math.min(100, Number(v))); this.parent.setDirtyCanvas(true, true); }); return true; }
    onZPauseMove(event, pos, node) { if (event.deltaX) { this.haveMouseMovedValue = true; this.value.z_pause = Math.max(0, Math.min(100, (this.value.z_pause || 0) + Math.round(event.deltaX / 10))); node.setDirtyCanvas(true, true);} }
}

// Called by editor when user finishes freehand drawing.
// If active widget is handdraw: replace its points.
// If active is normal: create a new handdraw layer and set points.
export function commitHanddrawPath(node, points) {
    const lm = node.layerManager;
    if (!lm) return;
    const active = lm.getActiveWidget?.();
    const isHand = active && active.value?.type === 'handdraw';
    const pointsStore = JSON.stringify(points || []);
    if (isHand) {
        active.value.points_store = pointsStore;
        node.setDirtyCanvas(true, true);
        if (node.editor?.layerRenderer) node.editor.layerRenderer.render();
        if (node.editor?.updatePath) node.editor.updatePath();
        return active;
    }
    // create new handdraw layer
    if (lm.addNewHanddraw) {
        const w = lm.addNewHanddraw('Handdraw');
        w.value.points_store = pointsStore;
        // Make the new handdraw layer active
        lm.setActiveWidget(w);
        node.setDirtyCanvas(true, true);
        if (node.editor?.layerRenderer) node.editor.layerRenderer.render();
        if (node.editor?.updatePath) node.editor.updatePath();
        return w;
    }
}
