import { app } from "../../../../scripts/app.js";
import { moveArrayItem, removeArrayItem } from "./widgets.js";

// Function to display custom HTML context menu for LoRA widget actions
export function showCustomLoraMenu(event, widget, node, position) {
    console.log("showCustomLoraMenu called.");
    // Remove any existing custom menu to prevent duplicates
    const existingMenu = document.getElementById('custom-lora-menu');
    if (existingMenu) {
        existingMenu.remove();
    }

    const menu = document.createElement('div');
    menu.id = 'custom-lora-menu';
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
        min-width: 140px !important;
        display: block !important;
        font-family: Arial, sans-serif !important;
        font-size: 11px !important;
    `;

    const loraWidgets = node.widgets.filter(w => w.name?.startsWith("lora_"));
    const loraIndex = loraWidgets.indexOf(widget);
    const canMoveUp = loraIndex > 0;
    const canMoveDown = loraIndex < loraWidgets.length - 1;

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
    menu.appendChild(createMenuItem('ℹ️', 'Show Info', () => {
        // For the main LoRA widget context menu, always show the high variant info
        widget.showLoraInfoDialog('high');
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

    menu.appendChild(createSeparator());

    menu.appendChild(createMenuItem('⬆️', 'Move Up', () => {
        const index = node.widgets.indexOf(widget);
        const otherIndex = node.widgets.indexOf(loraWidgets[loraIndex - 1]);
        const temp = node.widgets[otherIndex];
        node.widgets[otherIndex] = widget;
        node.widgets[index] = temp;
        node.setDirtyCanvas(true, true);
    }, !canMoveUp));

    menu.appendChild(createMenuItem('⬇️', 'Move Down', () => {
        const index = node.widgets.indexOf(widget);
        const otherIndex = node.widgets.indexOf(loraWidgets[loraIndex + 1]);
        const temp = node.widgets[otherIndex];
        node.widgets[otherIndex] = widget;
        node.widgets[index] = temp;
        node.setDirtyCanvas(true, true);
    }, !canMoveDown));

    menu.appendChild(createMenuItem('🗑️', 'Remove', () => {
        removeArrayItem(node.widgets, widget);
        const computed = node.computeSize();
        node.size[1] = Math.max(node._tempHeight || 15, computed[1]);    
        node.setDirtyCanvas(true, true);
    }));

    document.body.appendChild(menu);
    console.log("LoRA menu appended to body, position:", position);

    // Prevent menu close when interacting with menu
    menu.onclick = (e) => e.stopPropagation();
    menu.onmousedown = (e) => e.stopPropagation();

    // Hide menu when clicking outside
    const hideMenu = (e) => {
        if (menu && !menu.contains(e.target)) {
            console.log("Hiding LoRA menu");
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

export function getLoraSlotInPosition(canvasX, canvasY) {
    const slot = LGraphNode.prototype.getSlotInPosition?.call(this, canvasX, canvasY);
    if (!slot) {
        // Check if click is on a LoRA widget
        for (const widget of this.widgets || []) {
            if (!widget.last_y) continue;

            // Check if click Y is within this widget's bounds
            const widgetTop = this.pos[1] + widget.last_y;
            const widgetBottom = widgetTop + LiteGraph.NODE_WIDGET_HEIGHT;

            if (canvasY >= widgetTop && canvasY <= widgetBottom) {
                // Found the widget at this position
                if (widget.name?.startsWith("lora_")) {
                    // Check if click is on the low variant icon (green dot)
                    if (widget.hitAreas && widget.hitAreas.low_variant_icon) {
                        const iconBounds = widget.hitAreas.low_variant_icon.bounds;
                        // iconBounds is [posX, width, height?]
                        const iconAbsXStart = this.pos[0] + iconBounds[0];
                        const iconAbsXEnd = iconAbsXStart + (iconBounds[1] || 20);
                        const iconAbsYStart = widgetTop;
                        const iconAbsYEnd = widgetBottom;

                        if (canvasX >= iconAbsXStart && canvasX <= iconAbsXEnd &&
                            canvasY >= iconAbsYStart && canvasY <= iconAbsYEnd) {
                            // Check if this widget has a low variant
                            if (widget.value.is_low && widget.value.low_variant_name) {
                                return { widget: widget, output: { type: "LOW_VARIANT_ICON" } };
                            }
                        }
                    }
                    // If click is on a LoRA widget, return it
                    return { widget: widget, output: { type: "LORA_WIDGET" } };
                }
            }
        }
    }
    return slot;
}

export function getLoraSlotMenuOptions(slot, event) {
    // Check if the slot is specifically for the LOW_VARIANT_ICON
    if (slot?.output?.type === "LOW_VARIANT_ICON") {
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

        console.log("Low variant menu position calculated:", {x, y});

        // Use a slight delay to ensure the menu shows after the event completes
        setTimeout(() => {
            showLowVariantMenu(event, slot.widget, { x, y });
        }, 10);

        // Return false to prevent LiteGraph from showing its default menu
        return false;
    }

    // Check if the slot is for a LoRA widget (layer right-click)
    if (slot?.output?.type === "LORA_WIDGET" || slot?.widget?.name?.startsWith("lora_")) {
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

        console.log("LoRA menu position calculated:", {x, y});

        // Use a slight delay to ensure the menu shows after the event completes
        setTimeout(() => {
            showCustomLoraMenu(event, slot.widget, this, { x, y });
        }, 10);

        // Return false to prevent LiteGraph from showing its default menu
        return false;
    }

    return LGraphNode.prototype.getSlotMenuOptions?.call(this, slot);
}

// Function to display a simple context menu for low variant information
function showLowVariantMenu(event, widget, position) {
    console.log("showLowVariantMenu called.");
    // Remove any existing menu to prevent duplicates
    const existingMenu = document.getElementById('low-variant-menu');
    if (existingMenu) {
        existingMenu.remove();
    }

    // Extract just the filename from the full path
    const fullPath = widget.value.low_variant_name;
    const fileName = fullPath.includes('/') || fullPath.includes('\\')
        ? fullPath.split(/[\/\\]/).pop()
        : fullPath;

    const menu = document.createElement('div');
    menu.id = 'low-variant-menu';
    menu.className = 'litegraph litecontextmenu litemenubar-panel';
    menu.style.cssText = `
        position: absolute !important;
        left: ${position.x}px !important;
        top: ${position.y + 60}px !important;
        background-color: #1a1a1a !important;
        border: 1px solid #000 !important;
        box-shadow: 0 2px 6px rgba(0,0,0,0.8) !important;
        z-index: 10000 !important;
        padding: 4px !important;
        border-radius: 0px !important;
        min-width: 200px !important;
        display: block !important;
        font-family: Arial, sans-serif !important;
        font-size: 11px !important;
    `;

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

    // Add menu item showing the low variant name
    const nameItem = document.createElement('div');
    nameItem.style.cssText = `
        padding: 4px 8px !important;
        cursor: default !important;
        color: #ddd !important;
        background-color: #1a1a1a !important;
        user-select: none !important;
        display: flex !important;
        align-items: center !important;
    `;

    const textSpan = document.createElement('span');
    textSpan.textContent = fileName;

    nameItem.appendChild(textSpan);
    menu.appendChild(nameItem);

    // Add separator
    menu.appendChild(createSeparator());

    // Add Show Info option
    menu.appendChild(createMenuItem('ℹ️', 'Show Info', () => {
        // Show info for the low variant LoRA
        widget.showLoraInfoDialog('low');
    }));

    document.body.appendChild(menu);
    console.log("Low variant menu appended to body, position:", position);

    // Prevent menu close when interacting with menu
    menu.onclick = (e) => e.stopPropagation();
    menu.onmousedown = (e) => e.stopPropagation();

    // Hide menu when clicking outside
    const hideMenu = (e) => {
        if (menu && !menu.contains(e.target)) {
            console.log("Hiding low variant menu");
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