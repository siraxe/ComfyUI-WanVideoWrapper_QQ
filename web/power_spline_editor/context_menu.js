import { app } from '../../../scripts/app.js';
import { PowerSplineWidget } from './spline_utils.js';
import { updateDrivenConfigValue, updateEasingConfigValue } from './persistence.js';

// Helper to create interactive number input with arrows and drag support
// For driven config (syncs to both driven and _drivenConfig)
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
        updateDrivenConfigValue(widget, field, newValue);
        numberDisplay.textContent = newValue.toFixed(precision);
    };

    // Number display (draggable and clickable)
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
    let hasDragged = false;
    let startX = 0;
    let startValue = 0;

    const onMouseMove = (e) => {
        if (isDragging) {
            e.stopPropagation();
            e.preventDefault();
            const deltaX = e.clientX - startX;
            // Only mark as dragged if movement exceeds threshold
            if (Math.abs(deltaX) > 3) {
                hasDragged = true;
            }
            const delta = Math.round(deltaX / 5) * step;
            const newValue = Math.max(min, Math.min(max, startValue + delta));
            updateDrivenConfigValue(widget, field, newValue);
            numberDisplay.textContent = newValue.toFixed(precision);
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
            hasDragged = false;
            startX = e.clientX;
            startValue = configObj[field];
            numberDisplay.style.cursor = 'ew-resize';
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        }
    };

    numberDisplay.onclick = (e) => {
        e.stopPropagation();
        // Only show prompt if user didn't drag
        if (!hasDragged) {
            const fieldLabel = field === 'd_scale' ? 'D Scale' : field.charAt(0).toUpperCase() + field.slice(1);
            app.canvas.prompt(fieldLabel, configObj[field], (v) => {
                const newValue = Math.max(min, Math.min(max, Number(v)));
                updateDrivenConfigValue(widget, field, newValue);
                numberDisplay.textContent = newValue.toFixed(precision);
            });
        }
        hasDragged = false;
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
        updateDrivenConfigValue(widget, field, newValue);
        numberDisplay.textContent = newValue.toFixed(precision);
    };

    container.appendChild(leftArrow);
    container.appendChild(numberDisplay);
    container.appendChild(rightArrow);

    return container;
}

// Helper to create interactive number input for easing config (syncs to easingConfig)
function createEasingNumberInput(widget, configObj, field, min, max, step, precision = 0) {
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
        updateEasingConfigValue(widget, field, newValue);
        numberDisplay.textContent = newValue.toFixed(precision);
    };

    // Number display (draggable and clickable)
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
    let hasDragged = false;
    let startX = 0;
    let startValue = 0;

    const onMouseMove = (e) => {
        if (isDragging) {
            e.stopPropagation();
            e.preventDefault();
            const deltaX = e.clientX - startX;
            // Only mark as dragged if movement exceeds threshold
            if (Math.abs(deltaX) > 3) {
                hasDragged = true;
            }
            const delta = Math.round(deltaX / 5) * step;
            const newValue = Math.max(min, Math.min(max, startValue + delta));
            updateEasingConfigValue(widget, field, newValue);
            numberDisplay.textContent = newValue.toFixed(precision);
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
            hasDragged = false;
            startX = e.clientX;
            startValue = configObj[field];
            numberDisplay.style.cursor = 'ew-resize';
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        }
    };

    numberDisplay.onclick = (e) => {
        e.stopPropagation();
        // Only show prompt if user didn't drag
        if (!hasDragged) {
            const fieldLabel = field.charAt(0).toUpperCase() + field.slice(1);
            app.canvas.prompt(fieldLabel, configObj[field], (v) => {
                const newValue = Math.max(min, Math.min(max, Number(v)));
                updateEasingConfigValue(widget, field, newValue);
                numberDisplay.textContent = newValue.toFixed(precision);
            });
        }
        hasDragged = false;
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
        updateEasingConfigValue(widget, field, newValue);
        numberDisplay.textContent = newValue.toFixed(precision);
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
        // Use the centralized update function to ensure data is saved correctly
        updateDrivenConfigValue(widget, field, input.value);
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
            widget.value._drivenConfig = { driver: "", rotate: 0, d_scale: 1.0 };
        }
        configObj = widget.value._drivenConfig;
    }

    // Ensure all fields exist
    if (!configObj.driver) configObj.driver = "";
    if (typeof configObj.rotate !== 'number') configObj.rotate = 0;
    if (typeof configObj.d_scale !== 'number') configObj.d_scale = 1.0;

    const menu = document.createElement('div');
    menu.id = 'custom-driven-toggle-menu';
    menu.className = 'litegraph litecontextmenu litemenubar-panel';
    menu.style.cssText = `
        position: absolute !important;
        left: ${position.x}px !important;
        top: ${position.y + 40}px !important;
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
    container.appendChild(createHeader('D_Scale:'));

    // Row 2: Interactive inputs
    const driverOptions = ["None", ...widget.parent.layerManager.getSplineWidgets()
        .map(w => w.value.name)
        .filter(name => name !== widget.value.name)];
    container.appendChild(createDropdown(driverOptions, configObj.driver || "None", widget, 'driver', updateDrivenConfigValue));
    container.appendChild(createNumberInput(widget, configObj, 'rotate', -360, 360, 1, 0));
    container.appendChild(createNumberInput(widget, configObj, 'd_scale', 0.0, 1.0, 0.01, 2));

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

// Helper to create a dropdown select element
function createDropdown(options, selectedValue, widget, field, updateCallback) {
    const select = document.createElement('select');
    select.style.cssText = `
        width: 100% !important;
        padding: 2px 3px !important;
        background-color: #1a1a1a !important;
        border: 1px solid #333 !important;
        color: #ddd !important;
        font-family: Arial, sans-serif !important;
        font-size: 11px !important;
        outline: none !important;
        cursor: pointer !important;
    `;
    select.onfocus = () => {
        select.style.borderColor = '#555';
        select.style.backgroundColor = '#222';
    };
    select.onblur = () => {
        select.style.borderColor = '#333';
        select.style.backgroundColor = '#1a1a1a';
    };
    select.onclick = (e) => e.stopPropagation();
    select.onmousedown = (e) => e.stopPropagation();
    select.onchange = (e) => {
        e.stopPropagation();
        if (updateCallback) {
            updateCallback(widget, field, select.value);
        }
    };

    options.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt;
        option.textContent = opt;
        if (opt === selectedValue) {
            option.selected = true;
        }
        select.appendChild(option);
    });

    return select;
}

// Helper to create static number display (non-interactive for UI-only)
function createStaticNumberDisplay(value, min, max, precision = 1) {
    const container = document.createElement('div');
    container.style.cssText = `
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        padding: 2px 3px !important;
        background-color: #1a1a1a !important;
        border: 1px solid #333 !important;
        color: #ddd !important;
        font-family: Arial, sans-serif !important;
        font-size: 11px !important;
        text-align: center !important;
    `;
    container.textContent = value.toFixed(precision);
    return container;
}

// Function to display a custom HTML context menu for easing configuration
export function showCustomEasingMenu(event, widget, position) {
    console.log("showCustomEasingMenu called.");
    // Remove any existing custom menu to prevent duplicates
    const existingMenu = document.getElementById('custom-easing-menu');
    if (existingMenu) {
        existingMenu.remove();
    }

    // Initialization is now handled by the widget's value setter.
    // We can rely on widget.value.easingConfig existing.
    const configObj = widget.value.easingConfig;

    // Ensure fields exist as a fallback.
    if (!configObj.path) configObj.path = "each";
    if (typeof configObj.strength !== 'number') configObj.strength = 1.0;

    const menu = document.createElement('div');
    menu.id = 'custom-easing-menu';
    menu.className = 'litegraph litecontextmenu litemenubar-panel';
    menu.style.cssText = `
        position: absolute !important;
        left: ${position.x}px !important;
        top: ${position.y + 40}px !important;
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

    // Create grid container (2 columns: Path | Strength)
    const container = document.createElement('div');
    container.style.cssText = `
        display: grid !important;
        grid-template-columns: 1fr 1fr !important;
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
    container.appendChild(createHeader('Path:'));
    container.appendChild(createHeader('Strength:'));

    // Row 2: Controls
    container.appendChild(createDropdown(['each', 'full'], configObj.path, widget, 'path', updateEasingConfigValue));
    container.appendChild(createEasingNumberInput(widget, configObj, 'strength', 0.0, 2.0, 0.1, 1));

    menu.appendChild(container);
    document.body.appendChild(menu);
    console.log("Easing menu appended to body, position:", position);

    // Prevent menu close when interacting with inputs
    menu.onclick = (e) => e.stopPropagation();
    menu.onmousedown = (e) => e.stopPropagation();

    // Hide menu when clicking outside
    const hideMenu = (e) => {
        if (menu && !menu.contains(e.target)) {
            console.log("Hiding easing menu");
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

                    // Check for easing area (same pattern as driven toggle)
                    if (widget.hitAreas && widget.hitAreas.easingVal) {
                        const easingBounds = widget.hitAreas.easingVal.bounds;
                        // easingBounds is [posX, width] relative to the widget's draw area

                        const easingAbsXStart = this.pos[0] + easingBounds[0];
                        const easingAbsXEnd = easingAbsXStart + easingBounds[1];
                        const easingAbsYStart = widgetTop;
                        const easingAbsYEnd = widgetBottom;

                        if (canvasX >= easingAbsXStart && canvasX <= easingAbsXEnd &&
                            canvasY >= easingAbsYStart && canvasY <= easingAbsYEnd) {
                            return { widget: widget, output: { type: "EASING_AREA" } };
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

// Function to display custom HTML context menu for layer actions
export function showCustomLayerMenu(event, widget, node, position) {
    console.log("showCustomLayerMenu called.");
    // Remove any existing custom menu to prevent duplicates
    const existingMenu = document.getElementById('custom-layer-menu');
    if (existingMenu) {
        existingMenu.remove();
    }

    const menu = document.createElement('div');
    menu.id = 'custom-layer-menu';
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
        min-width: 120px !important;
        display: block !important;
        font-family: Arial, sans-serif !important;
        font-size: 11px !important;
    `;

    const splineWidgets = node.widgets.filter(w => w.name?.startsWith("spline_"));
    const splineIndex = splineWidgets.indexOf(widget);
    const canMoveUp = splineIndex > 0;
    const canMoveDown = splineIndex < splineWidgets.length - 1;

    // Helper to create menu item
    const createMenuItem = (icon, text, onClick, disabled = false) => {
        const item = document.createElement('div');
        item.style.cssText = `
            padding: 4px 8px !important;
            cursor: ${disabled ? 'default' : 'pointer'} !important;
            color: ${disabled ? '#555' : '#ddd'} !important;
            background-color: #1a1a1a !important;
            user-select: none !important;
            display: flex !important;
            align-items: center !important;
            gap: 6px !important;
        `;

        if (!disabled) {
            item.onmouseover = () => {
                item.style.backgroundColor = '#2a2a2a';
            };
            item.onmouseout = () => {
                item.style.backgroundColor = '#1a1a1a';
            };
            item.onclick = (e) => {
                e.stopPropagation();
                onClick();
                menu.remove();
                document.removeEventListener('click', hideMenu);
                document.removeEventListener('contextmenu', hideMenu);
                document.removeEventListener('mousedown', hideMenu);
            };
        }

        const iconSpan = document.createElement('span');
        iconSpan.textContent = icon;
        iconSpan.style.cssText = `
            font-size: 12px !important;
            width: 16px !important;
            text-align: center !important;
        `;

        const textSpan = document.createElement('span');
        textSpan.textContent = text;

        item.appendChild(iconSpan);
        item.appendChild(textSpan);

        return item;
    };

    // Helper to create separator
    const createSeparator = () => {
        const separator = document.createElement('div');
        separator.style.cssText = `
            height: 1px !important;
            background-color: #333 !important;
            margin: 2px 0 !important;
        `;
        return separator;
    };

    // Add menu items
    menu.appendChild(createMenuItem('✏️', 'Rename', () => {
        const canvas = app.canvas;
        canvas.prompt("Spline Name", widget.value.name || "Spline", (v) => {
            const newName = v || "Spline";
            const otherSplineWidgets = node.widgets.filter(w => w !== widget && w.name?.startsWith("spline_"));
            const existingNames = otherSplineWidgets.map(w => w.value.name);
            widget.value.name = node.generateUniqueName(newName, existingNames);
            node.setDirtyCanvas(true, true);
        });
    }));

    menu.appendChild(createSeparator());

    menu.appendChild(createMenuItem(
        widget.value.on ? '⚫' : '🟢',
        widget.value.on ? 'Toggle Off' : 'Toggle On',
        () => {
            widget.value.on = !widget.value.on;
            node.setDirtyCanvas(true, true);
        }
    ));

    menu.appendChild(createMenuItem('⬆️', 'Move Up', () => {
        const index = node.widgets.indexOf(widget);
        const otherIndex = node.widgets.indexOf(splineWidgets[splineIndex - 1]);
        const temp = node.widgets[otherIndex];
        node.widgets[otherIndex] = widget;
        node.widgets[index] = temp;
        node.setDirtyCanvas(true, true);
    }, !canMoveUp));

    menu.appendChild(createMenuItem('⬇️', 'Move Down', () => {
        const index = node.widgets.indexOf(widget);
        const otherIndex = node.widgets.indexOf(splineWidgets[splineIndex + 1]);
        const temp = node.widgets[otherIndex];
        node.widgets[otherIndex] = widget;
        node.widgets[index] = temp;
        node.setDirtyCanvas(true, true);
    }, !canMoveDown));

    menu.appendChild(createMenuItem('🗑️', 'Remove', () => {
        if (node.widgets.filter(w => w instanceof PowerSplineWidget).length > 1) {
            node.layerManager.removeSpline(widget);
        } else {
            console.log("Cannot remove the last spline layer.");
        }
    }));

    document.body.appendChild(menu);
    console.log("Layer menu appended to body, position:", position);

    // Prevent menu close when interacting with menu
    menu.onclick = (e) => e.stopPropagation();
    menu.onmousedown = (e) => e.stopPropagation();

    // Hide menu when clicking outside
    const hideMenu = (e) => {
        if (menu && !menu.contains(e.target)) {
            console.log("Hiding layer menu");
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

    // Check if the slot is specifically for the EASING_AREA
    if (slot?.output?.type === "EASING_AREA") {
        // Get position from canvas - same logic as driven toggle
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

        console.log("Easing menu position calculated:", {x, y});

        // Use a slight delay to ensure the menu shows after the event completes
        setTimeout(() => {
            showCustomEasingMenu(event, slot.widget, { x, y });
        }, 10);

        // Return false to prevent LiteGraph from showing its default menu
        return false;
    }

    // Check if the slot is for a spline widget (layer right-click)
    if (slot?.widget?.name?.startsWith("spline_")) {
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

        console.log("Layer menu position calculated:", {x, y});

        // Use a slight delay to ensure the menu shows after the event completes
        setTimeout(() => {
            showCustomLayerMenu(event, slot.widget, this, { x, y });
        }, 10);

        // Return false to prevent LiteGraph from showing its default menu
        return false;
    }

    return LGraphNode.prototype.getSlotMenuOptions?.call(this, slot);
}
