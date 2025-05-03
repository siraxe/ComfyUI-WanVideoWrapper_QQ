import { app } from '../../../scripts/app.js';
import { PowerSplineWidget } from './spline_utils.js';

// Helper to create interactive number input with arrows and drag support
function createNumberInput(widget, configObj, field, min, max, step, precision = 0) {
    const container = document.createElement('div');
    container.style.cssText = `
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 2px !important;
        padding: 2px 2px !important;
        background-color: #1a1a1a !important;
        color: #aaa !important;
    `;

    // Left arrow
    const leftArrow = document.createElement('div');
    leftArrow.textContent = '◀';
    leftArrow.style.cssText = `
        cursor: pointer !important;
        user-select: none !important;
        padding: 0 1px !important;
        color: #aaa !important;
        font-size: 10px !important;
    `;
    leftArrow.onmouseover = () => leftArrow.style.color = '#fff';
    leftArrow.onmouseout = () => leftArrow.style.color = '#aaa';
    leftArrow.onclick = (e) => {
        e.stopPropagation();
        const newValue = Math.max(min, configObj[field] - step);
        configObj[field] = newValue;
        // Sync back to both driven and _drivenConfig
        if (widget.value.driven && typeof widget.value.driven === 'object') {
            widget.value.driven[field] = newValue;
        }
        widget.value._drivenConfig[field] = newValue;
        numberDisplay.textContent = newValue.toFixed(precision);
        app.graph.setDirtyCanvas(true, true);
    };

    // Number display (draggable only)
    const numberDisplay = document.createElement('div');
    numberDisplay.textContent = configObj[field].toFixed(precision);
    numberDisplay.style.cssText = `
        min-width: 24px !important;
        text-align: center !important;
        cursor: ew-resize !important;
        user-select: none !important;
        outline: none !important;
        color: #ddd !important;
        font-size: 11px !important;
    `;

    let isDragging = false;
    let startX = 0;
    let startValue = 0;

    const onMouseMove = (e) => {
        if (isDragging) {
            e.stopPropagation();
            e.preventDefault();
            const deltaX = e.clientX - startX;
            const delta = Math.round(deltaX / 5) * step;
            const newValue = Math.max(min, Math.min(max, startValue + delta));
            configObj[field] = newValue;
            // Sync back to both driven and _drivenConfig
            if (widget.value.driven && typeof widget.value.driven === 'object') {
                widget.value.driven[field] = newValue;
            }
            widget.value._drivenConfig[field] = newValue;
            numberDisplay.textContent = newValue.toFixed(precision);
            app.graph.setDirtyCanvas(true, true);
        }
    };

    const onMouseUp = () => {
        if (isDragging) {
            isDragging = false;
            numberDisplay.style.cursor = 'ew-resize';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        }
    };

    numberDisplay.onmousedown = (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (e.button === 0) {
            isDragging = true;
            startX = e.clientX;
            startValue = configObj[field];
            numberDisplay.style.cursor = 'ew-resize';
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        }
    };

    // Right arrow
    const rightArrow = document.createElement('div');
    rightArrow.textContent = '▶';
    rightArrow.style.cssText = `
        cursor: pointer !important;
        user-select: none !important;
        padding: 0 1px !important;
        color: #aaa !important;
        font-size: 10px !important;
    `;
    rightArrow.onmouseover = () => rightArrow.style.color = '#fff';
    rightArrow.onmouseout = () => rightArrow.style.color = '#aaa';
    rightArrow.onclick = (e) => {
        e.stopPropagation();
        const newValue = Math.min(max, configObj[field] + step);
        configObj[field] = newValue;
        // Sync back to both driven and _drivenConfig
        if (widget.value.driven && typeof widget.value.driven === 'object') {
            widget.value.driven[field] = newValue;
        }
        widget.value._drivenConfig[field] = newValue;
        numberDisplay.textContent = newValue.toFixed(precision);
        app.graph.setDirtyCanvas(true, true);
    };

    container.appendChild(leftArrow);
    container.appendChild(numberDisplay);
    container.appendChild(rightArrow);

    return container;
}

// Helper to create text input field
function createTextInput(widget, configObj, field, placeholder = '') {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = configObj[field] || '';
    input.placeholder = placeholder;
    input.style.cssText = `
        width: 100% !important;
        padding: 2px 3px !important;
        background-color: #1a1a1a !important;
        border: 1px solid #333 !important;
        color: #ddd !important;
        font-family: Arial, sans-serif !important;
        font-size: 11px !important;
        outline: none !important;
    `;
    input.onfocus = () => {
        input.style.borderColor = '#555';
        input.style.backgroundColor = '#222';
    };
    input.onblur = () => {
        input.style.borderColor = '#333';
        input.style.backgroundColor = '#1a1a1a';
    };
    input.oninput = (e) => {
        e.stopPropagation();
        configObj[field] = input.value;
        // Sync back to both driven and _drivenConfig
        if (widget.value.driven && typeof widget.value.driven === 'object') {
            widget.value.driven[field] = input.value;
        }
        widget.value._drivenConfig[field] = input.value;
        app.graph.setDirtyCanvas(true, true);
    };
    input.onclick = (e) => e.stopPropagation();
    input.onmousedown = (e) => e.stopPropagation();

    return input;
}

// Function to display a custom HTML context menu with interactive inputs
export function showCustomDrivenToggleMenu(event, widget, position) {
    console.log("showCustomDrivenToggleMenu called.");
    // Remove any existing custom menu to prevent duplicates
    const existingMenu = document.getElementById('custom-driven-toggle-menu');
    if (existingMenu) {
        existingMenu.remove();
    }

    // Work with the config object - either from driven (if on) or _drivenConfig (if off)
    // This ensures we preserve settings even when the toggle is off
    let configObj;
    if (widget.value.driven && typeof widget.value.driven === 'object') {
        // Driven is on - use the active config
        configObj = widget.value.driven;
    } else {
        // Driven is off - use the preserved config
        if (!widget.value._drivenConfig || typeof widget.value._drivenConfig !== 'object') {
            widget.value._drivenConfig = { driver: "", rotate: 0, smooth: 0.0 };
        }
        configObj = widget.value._drivenConfig;
    }

    // Ensure all fields exist
    if (!configObj.driver) configObj.driver = "";
    if (typeof configObj.rotate !== 'number') configObj.rotate = 0;
    if (typeof configObj.smooth !== 'number') configObj.smooth = 0.0;

    const menu = document.createElement('div');
    menu.id = 'custom-driven-toggle-menu';
    menu.className = 'litegraph litecontextmenu litemenubar-panel';
    menu.style.cssText = `
        position: absolute !important;
        left: ${position.x}px !important;
        top: ${position.y}px !important;
        background-color: #1a1a1a !important;
        border: 1px solid #000 !important;
        box-shadow: 0 2px 6px rgba(0,0,0,0.8) !important;
        z-index: 10000 !important;
        padding: 4px !important;
        border-radius: 0px !important;
        min-width: 50 !important;
        display: block !important;
        font-family: Arial, sans-serif !important;
        font-size: 11px !important;
    `;

    // Create grid container
    const container = document.createElement('div');
    container.style.cssText = `
        display: grid !important;
        grid-template-columns: 1fr 0.5fr 0.5fr !important;
        grid-template-rows: auto auto !important;
        gap: 2px !important;
        width: 100% !important;
    `;

    // Helper to create header label
    const createHeader = (text) => {
        const header = document.createElement('div');
        header.textContent = text;
        header.style.cssText = `
            padding: 2px 4px !important;
            text-align: center !important;
            font-size: 11px !important;
            color: #888 !important;
            background-color: #1a1a1a !important;
            font-weight: normal !important;
        `;
        return header;
    };

    // Row 1: Headers
    container.appendChild(createHeader('Driver:'));
    container.appendChild(createHeader('Rotate:'));
    container.appendChild(createHeader('Smooth:'));

    // Row 2: Interactive inputs
    container.appendChild(createTextInput(widget, configObj, 'driver', 'None'));
    container.appendChild(createNumberInput(widget, configObj, 'rotate', -360, 360, 1, 0));
    container.appendChild(createNumberInput(widget, configObj, 'smooth', 0.0, 1.0, 0.01, 2));

    menu.appendChild(container);
    document.body.appendChild(menu);
    console.log("Menu appended to body, position:", position);

    // Prevent menu close when interacting with inputs
    menu.onclick = (e) => e.stopPropagation();
    menu.onmousedown = (e) => e.stopPropagation();

    // Hide menu when clicking outside
    const hideMenu = (e) => {
        if (menu && !menu.contains(e.target)) {
            console.log("Hiding menu");
            menu.remove();
            document.removeEventListener('click', hideMenu);
            document.removeEventListener('contextmenu', hideMenu);
            document.removeEventListener('mousedown', hideMenu);
        }
    };

    // Add listeners after a short delay to prevent immediate closure
    setTimeout(() => {
        document.addEventListener('click', hideMenu);
        document.addEventListener('contextmenu', hideMenu);
        document.addEventListener('mousedown', hideMenu);
    }, 100);
}

export function getSlotInPosition(canvasX, canvasY) {
    const slot = LGraphNode.prototype.getSlotInPosition?.call(this, canvasX, canvasY);
    if (!slot) {
        // Check if click is on a spline widget
        for (const widget of this.widgets || []) {
            if (!widget.last_y) continue;

            // Check if click Y is within this widget's bounds
            const widgetTop = this.pos[1] + widget.last_y;
            const widgetBottom = widgetTop + LiteGraph.NODE_WIDGET_HEIGHT;

            if (canvasY >= widgetTop && canvasY <= widgetBottom) {
                // Found the widget at this position
                if (widget.name?.startsWith("spline_")) {
                    // Use the actual hitAreas.drivenToggle.bounds from the widget
                    if (widget.hitAreas && widget.hitAreas.drivenToggle) {
                        const drivenToggleBounds = widget.hitAreas.drivenToggle.bounds;
                        // drivenToggleBounds is [posX, toggleBgWidth] relative to the widget's draw area
                        // We need to convert these to canvas coordinates

                        const toggleAbsXStart = this.pos[0] + drivenToggleBounds[0];
                        const toggleAbsXEnd = toggleAbsXStart + drivenToggleBounds[1];
                        const toggleAbsYStart = widgetTop; // The widget's top is the start Y
                        const toggleAbsYEnd = widgetBottom; // The widget's bottom is the end Y

                        if (canvasX >= toggleAbsXStart && canvasX <= toggleAbsXEnd &&
                            canvasY >= toggleAbsYStart && canvasY <= toggleAbsYEnd) {
                            return { widget: widget, output: { type: "DRIVEN_TOGGLE" } };
                        }
                    }
                }
                // If click is outside the toggle button, then select the spline widget
                return { widget: widget, output: { type: "SPLINE WIDGET" } };
            }
        }
    }
    return slot;
}

export function getSlotMenuOptions(slot, event) {
    // Check if the slot is specifically for the DRIVEN_TOGGLE
    if (slot?.output?.type === "DRIVEN_TOGGLE") {
        // Get position from canvas - LiteGraph stores the last pointer position
        const canvas = app.canvas;

        // Try multiple ways to get the screen position
        let x = 100;
        let y = 100;

        // Option 1: Try to get from last_mouse_position (canvas screen coords)
        if (canvas.last_mouse_position) {
            x = canvas.last_mouse_position[0];
            y = canvas.last_mouse_position[1];
        }
        // Option 2: Try canvas_mouse (might be available)
        else if (canvas.canvas_mouse) {
            x = canvas.canvas_mouse[0];
            y = canvas.canvas_mouse[1];
        }
        // Option 3: Convert graph coordinates to screen coordinates
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

        console.log("Menu position calculated:", {x, y});

        // Use a slight delay to ensure the menu shows after the event completes
        setTimeout(() => {
            showCustomDrivenToggleMenu(event, slot.widget, { x, y });
        }, 10);

        // Return false to prevent LiteGraph from showing its default menu
        return false;
    }

    if (slot?.widget?.name?.startsWith("spline_")) {
        const widget = slot.widget;
        const index = this.widgets.indexOf(widget);
        const splineWidgets = this.widgets.filter(w => w.name?.startsWith("spline_"));
        const splineIndex = splineWidgets.indexOf(widget);
        const canMoveUp = splineIndex > 0;
        const canMoveDown = splineIndex < splineWidgets.length - 1;

        const menuItems = [
            {
                content: `✏️ Rename`,
                callback: () => {
                    const canvas = app.canvas;
                    canvas.prompt("Spline Name", widget.value.name || "Spline", (v) => {
                        const newName = v || "Spline";
                        const otherSplineWidgets = this.widgets.filter(w => w !== widget && w.name?.startsWith("spline_"));
                        const existingNames = otherSplineWidgets.map(w => w.value.name);
                        widget.value.name = this.generateUniqueName(newName, existingNames);
                        this.setDirtyCanvas(true, true);
                    });
                },
            },
            null,
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
                    const otherIndex = this.widgets.indexOf(splineWidgets[splineIndex - 1]);
                    const temp = this.widgets[otherIndex];
                    this.widgets[otherIndex] = widget;
                    this.widgets[index] = temp;
                    this.setDirtyCanvas(true, true);
                },
            },
            {
                content: `⬇️ Move Down`,
                disabled: !canMoveDown,
                callback: () => {
                    const otherIndex = this.widgets.indexOf(splineWidgets[splineIndex + 1]);
                    const temp = this.widgets[otherIndex];
                    this.widgets[otherIndex] = widget;
                    this.widgets[index] = temp;
                    this.setDirtyCanvas(true, true);
                },
            },
            {
                content: `🗑️ Remove`,
                callback: () => {
                    if (this.widgets.filter(w => w instanceof PowerSplineWidget).length > 1) {
                        this.layerManager.removeSpline(widget);
                    } else {
                        console.log("Cannot remove the last spline layer.");
                    }
                },
            },
        ];

        return menuItems;
    }
    return LGraphNode.prototype.getSlotMenuOptions?.call(this, slot);
}
