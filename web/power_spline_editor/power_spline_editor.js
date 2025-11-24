import { app } from '../../../scripts/app.js';
import { makeUUID, loadScript, create_documentation_stylesheet, RgthreeBaseWidget, DimensionsWidget, TopRowWidget, PowerSplineWidget, PowerSplineHeaderWidget, NodeSizeManager, drawWidgetButton } from './spline_utils.js';
import { HandDrawLayerWidget, commitHanddrawPath } from './handdraw_layer.js';
import { BoxLayerWidget } from './box_layer.js';
import { chainCallback, hideWidgetForGood } from './widget_utils.js';
import SplineEditor2 from './canvas/canvas_main.js';
import { getSlotInPosition, getSlotMenuOptions, showCustomDrivenToggleMenu } from './context_menu.js';
import { drawDriverLines } from './driver_line_renderer.js';
import { darkenImage, scaleImageToRefDimensions, processBgImage, createImageOverlayForConfigure } from './image_overlay.js';
import { getReferenceImageFromConnectedNode, getReferenceImagesFromConnectedNode } from './graph_query.js';

loadScript('/kjweb_async/svg-path-properties.min.js').catch((e) => {
    console.log(e)
})
loadScript('/kjweb_async/protovis.min.js').catch((e) => {
  console.log(e)
})
create_documentation_stylesheet()

async function loadImageAsBase64(url) {
    try {
        // Check if it's a data URL (starts with 'data:')
        if (url.startsWith('data:')) {
            // For data URLs, no cache-busting is needed, just process directly
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            // Ensure initial overlay selection is applied on page load (handles None/A/B/C)
            try {
                const initBgWidget = this.widgets && this.widgets.find(w => w.name === "bg_img");
                const initBg = initBgWidget ? initBgWidget.value : "None";
                // Defer slightly to allow editor and size to settle
                setTimeout(() => this.updateBackgroundImage(initBg), 50);
            } catch {}
            const blob = await response.blob();
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        } else {
            // For regular URLs, add cache-busting parameter
            const urlObj = new URL(url, window.location.href);
            urlObj.searchParams.set('t', Date.now());
            const cacheBustedUrl = urlObj.toString();
            
            const response = await fetch(cacheBustedUrl);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const blob = await response.blob();
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        }
    } catch (e) {
        console.error(`Failed to load image from ${url}:`, e);
        return null;
    }
}

// Function to save ref_image to cache; default name is ref_image.png (background saves pass an explicit name)
// options.skipSessionCache avoids writing to the shared session key used for bg overlays
async function saveRefImageToCache(base64Data, name = 'ref_image.png', options = {}) {
    try {
        // Create a cache key to track the current ref_image
        const currentHash = await simpleHash(base64Data);
        if (!options.skipSessionCache) {
            safeSetSessionItem('spline-editor-ref-image-hash', currentHash);
        }
        
        // Try to save the file to the bg folder via the backend API
        try {
            const formData = new FormData();
            formData.append('image', `data:image/png;base64,${base64Data}`);
            formData.append('name', name);
            
            const response = await fetch('/wanvideowrapper_qq/save_ref_image', {
                method: 'POST',
                body: formData
            });
            
            if (response.ok) {
                const result = await response.json();
                if (result.success) {
                 
                    // Save to sessionStorage as backup (unless skipped)
                    if (!options.skipSessionCache) {
                        safeSetSessionItem('spline-editor-cached-ref-image', JSON.stringify({
                            base64: base64Data,
                            type: 'image/png',
                            name,
                            hash: currentHash,
                            timestamp: Date.now()
                        }));
                    }
                    
                    return true;
                } else {
                    console.error('Backend error saving ref image:', result.error);
                    // Fallback to sessionStorage only
                    if (!options.skipSessionCache) {
                        safeSetSessionItem('spline-editor-cached-ref-image', JSON.stringify({
                            base64: base64Data,
                            type: 'image/png',
                            name,
                            hash: currentHash,
                            timestamp: Date.now()
                        }));
                    }
                    return false;
                }
            } else {
                console.error('Failed to save ref image via API:', response.status);
                // Fallback to sessionStorage only
                if (!options.skipSessionCache) {
                    safeSetSessionItem('spline-editor-cached-ref-image', JSON.stringify({
                        base64: base64Data,
                        type: 'image/png',
                        name,
                        hash: currentHash,
                        timestamp: Date.now()
                    }));
                }
                return false;
            }
        } catch (error) {
            console.warn('API save failed, using sessionStorage fallback:', error);
            
            // Fallback to sessionStorage if API fails
            if (!options.skipSessionCache) {
                safeSetSessionItem('spline-editor-cached-ref-image', JSON.stringify({
                    base64: base64Data,
                    type: 'image/png',
                    name,
                    hash: currentHash,
                    timestamp: Date.now()
                }));
            }
            
            return true;
        }
    } catch (e) {
        console.error('Failed to cache ref image:', e);
        return false;
    }
}

// Simple hash function to compare images
async function simpleHash(str) {
    // Convert input to string if it's not already
    if (typeof str !== 'string') {
        str = String(str);
    }
    
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString();
}

// Function to check if cached ref_image exists and is different from current
async function getCachedRefImage(currentBase64 = null) {
    try {
        const cachedData = sessionStorage.getItem('spline-editor-cached-ref-image');
        if (!cachedData) {
            return null;
        }
        
        const parsed = JSON.parse(cachedData);
        // Guard: only honor caches explicitly saved for bg image overlays
        if (parsed?.name && parsed.name !== 'bg_image.png') {
            return null;
        }
        
        // If current base64 is provided, check if it's different from cached
        if (currentBase64) {
            const currentHash = await simpleHash(currentBase64);
            if (currentHash === parsed.hash) {
                // Same image, no need to update
                return parsed;
            } else {
                // Different image, update cache
                await saveRefImageToCache(currentBase64, 'bg_image.png');
                return JSON.parse(sessionStorage.getItem('spline-editor-cached-ref-image'));
            }
        }
        
        return parsed;
    } catch (e) {
        console.error('Failed to get cached ref image:', e);
        return null;
    }
}

// Function to load cached ref_image as base64
async function loadCachedRefImageAsBase64() {
    try {
        // First try to load from actual file in bg folder
        const timestamp = Date.now();
        const refImageUrl = new URL(`bg/bg_image.png?t=${timestamp}`, import.meta.url).href;
        const response = await fetch(refImageUrl);
        if (response.ok) {
            const blob = await response.blob();
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        }
        
        // If file doesn't exist, try to load from sessionStorage cache
        const cachedData = await getCachedRefImage();
        if (cachedData) {
            return `data:${cachedData.type};base64,${cachedData.base64}`;
        }
        
        return null;
    } catch (e) {
        console.error('Failed to load cached ref image as base64:', e);
        // Fallback to sessionStorage cache
        try {
            const cachedData = await getCachedRefImage();
            if (cachedData) {
                return `data:${cachedData.type};base64,${cachedData.base64}`;
            }
        } catch (fallbackError) {
            console.error('Fallback cache also failed:', fallbackError);
        }
        return null;
    }
}



// == SPLINE LAYER MANAGER

class SplineLayerManager {
    constructor(node) {
        this.node = node;
        this.activeWidget = null;
        this.node.splineWidgetsCounter = 0;
        this._noActiveSelection = false;
    }

    setActiveWidget(widget) {
        if (this.activeWidget === widget) {
            return;
        }
        // Track explicit "no selection" state
        this._noActiveSelection = (widget == null);
        // If the editor is in handdraw create/edit mode, disarm it when switching layers
        // Exception: when switch is initiated by handdraw commit flow, one-shot suppress exit
        try {
            const ed = this.node?.editor;
            const suppressOnce = !!ed?._suppressHanddrawExitOnce;
            if (ed) ed._suppressHanddrawExitOnce = false; // always reset flag
            if (ed && ed._handdrawMode && ed._handdrawMode !== 'off' && !suppressOnce) {
                ed.exitHanddrawMode?.(false);
            }
        } catch {}
        this.activeWidget = widget;
        if (this.node.editor) {
            this.node.editor.onActiveLayerChanged(); // Notify canvas
        }
        this.node.setDirtyCanvas(true, true);
    }

    getActiveWidget() {
        if (this.activeWidget && !this.node.widgets.includes(this.activeWidget)) {
            this.activeWidget = null;
        }
        if (!this.activeWidget) {
            if (this._noActiveSelection) return null;
            const splines = this.getSplineWidgets();
            if (splines.length > 0) {
                // Find the first visible/active spline widget, not just any spline
                const visibleSpline = splines.find(w => w.value.on);
                if (visibleSpline) {
                    this.activeWidget = visibleSpline;
                } else {
                    // If no visible splines, we should not set an active widget
                    // This prevents trying to work with hidden layers
                    this.activeWidget = null;
                }
            }
        }
        return this.activeWidget;
    }

    getSplineWidgets() {
        return this.node.widgets.filter(w =>
            (w instanceof PowerSplineWidget) ||
            (w instanceof HandDrawLayerWidget) ||
            (w instanceof BoxLayerWidget)
        );
    }

    addNewSpline(name) {
        try {
            this.node?.editor?.exitHanddrawMode?.(false);
        } catch {}
        this.node.splineWidgetsCounter++;
        const widget = new PowerSplineWidget("spline_" + this.node.splineWidgetsCounter);

        const baseName = name || `Spline ${this.node.splineWidgetsCounter}`;
        const existingNames = this.getSplineWidgets().map(w => w.value.name);
        widget.value.name = this.node.generateUniqueName(baseName, existingNames);
        widget.value.type = 'spline';
        widget.value.offset = 0;
        widget.value.a_pause = 0;
        widget.value.z_pause = 0;
        widget.value.easing = 'in_out'; // Start with in_out as default (using simple naming)
        widget.value.easingConfig = { path: "full", strength: 1.0 }; // Start with full path and strength 1.0
        widget.value.driven = false; // Start with driven off
        widget.value._drivenConfig = { driver: "", rotate: 0, d_scale: 1.0 }; // Preserved config

        // Initialize with two points in normalized coordinates (center and slightly right)
        // Two points prevent rendering issues and provide proper direction
        const widthWidget = this.node.widgets.find(w => w.name === "mask_width");
        const heightWidget = this.node.widgets.find(w => w.name === "mask_height");
        const width = widthWidget ? widthWidget.value : 512;
        const height = heightWidget ? heightWidget.value : 512;
        const newPoints = [
            { x: Math.random() * 0.3 + 0.1, y: Math.random() * 0.8 + 0.1, highlighted: false },
            { x: Math.random() * 0.3 + 0.6, y: Math.random() * 0.8 + 0.1, highlighted: false }
        ];
        widget.value.points_store = JSON.stringify(newPoints);

        // Insert spline widgets AFTER the header (not before button_bar)
        // This ensures order: canvas ? button_bar ? header ? splines
        const headerIndex = this.node.widgets.findIndex(w => w.name === "spline_header");
        if (headerIndex !== -1) {
            // Find the last layer widget (spline or handdraw) after the header
            let insertIndex = headerIndex + 1;
            for (let i = headerIndex + 1; i < this.node.widgets.length; i++) {
                const wi = this.node.widgets[i];
                if (wi instanceof PowerSplineWidget || wi instanceof HandDrawLayerWidget || wi instanceof BoxLayerWidget) {
                    insertIndex = i + 1;
                } else {
                    break;
                }
            }
            this.node.widgets.splice(insertIndex, 0, widget);
            widget.parent = this.node;
        } else {
            this.node.addCustomWidget(widget);
        }

        this.node.updateNodeHeight();
        this.setActiveWidget(widget);
        // Force canvas to update after node height change
        if (this.node.editor && this.node.editor.vis) {
            this.node.editor.vis.render();
        }
        this.node.setDirtyCanvas(true, true);
        return widget;
    }

    addNewHanddraw(name, activate = true) {
        this.node.splineWidgetsCounter++;
        const widget = new HandDrawLayerWidget("spline_" + this.node.splineWidgetsCounter);

        const baseName = name || `Handdraw ${this.node.splineWidgetsCounter}`;
        const existingNames = this.getSplineWidgets().map(w => w.value.name);
        widget.value.name = this.node.generateUniqueName(baseName, existingNames);

        const headerIndex = this.node.widgets.findIndex(w => w.name === "spline_header");
        if (headerIndex !== -1) {
            let insertIndex = headerIndex + 1;
            for (let i = headerIndex + 1; i < this.node.widgets.length; i++) {
                const wi = this.node.widgets[i];
                if (wi instanceof PowerSplineWidget || wi instanceof HandDrawLayerWidget || wi instanceof BoxLayerWidget) {
                    insertIndex = i + 1;
                } else {
                    break;
                }
            }
            this.node.widgets.splice(insertIndex, 0, widget);
            widget.parent = this.node;
        } else {
            this.node.addCustomWidget(widget);
        }

        this.node.updateNodeHeight();
        if (activate) {
            this.setActiveWidget(widget);
            if (this.node.editor && this.node.editor.vis) {
                this.node.editor.vis.render();
            }
            this.node.setDirtyCanvas(true, true);
        }
        return widget;
    }

    addNewBox(name, activate = true) {
        this.node.splineWidgetsCounter++;
        const widget = new BoxLayerWidget("box_" + this.node.splineWidgetsCounter);

        const baseName = name || `Box ${this.node.splineWidgetsCounter}`;
        const existingNames = this.getSplineWidgets().map(w => w.value.name);
        widget.value.name = this.node.generateUniqueName(baseName, existingNames);
        widget.value.points_store = JSON.stringify([{
            x: 0.5,
            y: 0.5,
            highlighted: false,
            boxScale: 1,
            pointScale: 1,
            scale: 1,
            rotation: 0,
            boxRotation: 0,
        }]);
        widget.value.box_keys = [];
        widget.value.box_timeline_point = 1;
        widget.value.interpolation = 'box';

        const headerIndex = this.node.widgets.findIndex(w => w.name === "spline_header");
        if (headerIndex !== -1) {
            let insertIndex = headerIndex + 1;
            for (let i = headerIndex + 1; i < this.node.widgets.length; i++) {
                const wi = this.node.widgets[i];
                if (wi instanceof PowerSplineWidget || wi instanceof HandDrawLayerWidget || wi instanceof BoxLayerWidget) {
                    insertIndex = i + 1;
                } else {
                    break;
                }
            }
            this.node.widgets.splice(insertIndex, 0, widget);
            widget.parent = this.node;
        } else {
            this.node.addCustomWidget(widget);
        }

        this.node.updateNodeHeight();
        if (activate) {
            this.setActiveWidget(widget);
            if (this.node.editor && this.node.editor.vis) {
                this.node.editor.vis.render();
            }
            this.node.setDirtyCanvas(true, true);
        }
        return widget;
    }

    removeSpline(widget) {
        const index = this.node.widgets.indexOf(widget);
        if (index > -1) {
            // Get all spline widgets before removal
            const allSplines = this.getSplineWidgets();
            console.log("[SplineLayerManager] removeSpline: removing", widget?.value?.name, "total splines:", allSplines.length);

            // Check if the widget being removed is the active widget
            const removingActiveWidget = (this.activeWidget === widget);
            if (removingActiveWidget) {
                console.log("[SplineLayerManager] removeSpline: target is active widget");
                // Select a new active widget BEFORE removing the current one
                let newActiveWidget = null;

                // Try to find a replacement widget
                if (allSplines.length > 1) {
                    // Prefer the next visible spline, or previous if this is the last one
                    const currentIndex = allSplines.indexOf(widget);

                    // Try next visible spline
                    for (let i = currentIndex + 1; i < allSplines.length; i++) {
                        if (allSplines[i].value.on) {
                            newActiveWidget = allSplines[i];
                            break;
                        }
                    }

                    // If no visible spline found after current, try before
                    if (!newActiveWidget) {
                        for (let i = currentIndex - 1; i >= 0; i--) {
                            if (allSplines[i].value.on) {
                                newActiveWidget = allSplines[i];
                                break;
                            }
                        }
                    }

                    // If still no visible spline, just take the next one (or previous)
                    if (!newActiveWidget) {
                        if (currentIndex + 1 < allSplines.length) {
                            newActiveWidget = allSplines[currentIndex + 1];
                        } else if (currentIndex - 1 >= 0) {
                            newActiveWidget = allSplines[currentIndex - 1];
                        }
                    }
                }

                // Set the new active widget (triggers editor sync)
                this.setActiveWidget(newActiveWidget);
                console.log("[SplineLayerManager] removeSpline: new active widget", newActiveWidget?.value?.name);

                // If no active widget remains, clear the editor state
                if (this.node.editor && !this.activeWidget) {
                    // No splines left - clear the editor's points
                    console.log("[SplineLayerManager] removeSpline: no active widget, clearing editor points");
                    this.node.editor.points = [];
                    if (this.node.editor.layerRenderer) {
                        this.node.editor.layerRenderer.render();
                    }
                }
            }

            // Now remove the widget
            this.node.widgets.splice(index, 1);
            this.node.updateNodeHeight();

            const editor = this.node.editor;
            if (editor) {
                console.log("[SplineLayerManager] removeSpline: refresh editor state. Active widget:", this.activeWidget?.value?.name);
                if (this.activeWidget) {
                    // Refresh editor state based on newly active widget
                    if (typeof editor.onActiveLayerChanged === "function") {
                        console.log("[SplineLayerManager] removeSpline: calling editor.onActiveLayerChanged()");
                        editor.onActiveLayerChanged();
                    }
                    editor.points = editor.getActivePoints();
                    if (editor.layerRenderer) {
                        console.log("[SplineLayerManager] removeSpline: re-rendering layers");
                        editor.layerRenderer.render();
                    }
                    console.log("[SplineLayerManager] removeSpline: updating path");
                    editor.updatePath();
                } else {
                    // No active spline remains
                    editor.points = [];
                    if (editor.layerRenderer) {
                        console.log("[SplineLayerManager] removeSpline: no layers left, rendering empty");
                        editor.layerRenderer.render();
                    }
                }
                if (editor.vis) {
                    console.log("[SplineLayerManager] removeSpline: rendering editor vis");
                    editor.vis.render();
                }
            }

            this.node.setDirtyCanvas(true, true);
        }
    }

    duplicateSpline(sourceWidget) {
        if (!sourceWidget) return;

        try {
            this.node?.editor?.exitHanddrawMode?.(false);
        } catch {}
        this.node.splineWidgetsCounter++;
        const isHand = sourceWidget instanceof HandDrawLayerWidget;
        const isBox = sourceWidget instanceof BoxLayerWidget;
        const WidgetClass = isHand ? HandDrawLayerWidget : (isBox ? BoxLayerWidget : PowerSplineWidget);
        const widgetIdPrefix = isBox ? "box_" : "spline_";
        const newWidget = new WidgetClass(widgetIdPrefix + this.node.splineWidgetsCounter);

        // Deep copy of value.
        const sourceValue = sourceWidget.value;
        const newValue = JSON.parse(JSON.stringify(sourceValue));

        // Generate a unique name
        const existingNames = this.getSplineWidgets().map(w => w.value.name);
        newValue.name = this.node.generateUniqueName(sourceValue.name, existingNames);
        
        newWidget.value = newValue;

        // Insert it after the source widget
        const sourceIndex = this.node.widgets.indexOf(sourceWidget);
        if (sourceIndex !== -1) {
            this.node.widgets.splice(sourceIndex + 1, 0, newWidget);
            newWidget.parent = this.node;
        } else {
            // Fallback, should not happen if sourceWidget is valid
            // Insert after header (same logic as addNewSpline)
            const headerIndex = this.node.widgets.findIndex(w => w.name === "spline_header");
            if (headerIndex !== -1) {
                let insertIndex = headerIndex + 1;
                for (let i = headerIndex + 1; i < this.node.widgets.length; i++) {
                    const wi = this.node.widgets[i];
                    if (wi instanceof PowerSplineWidget || wi instanceof HandDrawLayerWidget || wi instanceof BoxLayerWidget) {
                        insertIndex = i + 1;
                    } else {
                        break;
                    }
                }
                this.node.widgets.splice(insertIndex, 0, newWidget);
                newWidget.parent = this.node;
            } else {
                this.node.addCustomWidget(newWidget);
            }
        }

        this.node.updateNodeHeight();
        this.setActiveWidget(newWidget);
        // Force canvas to update after node height change
        if (this.node.editor && this.node.editor.vis) {
            this.node.editor.vis.render();
        }
        this.node.setDirtyCanvas(true, true);
        return newWidget;
    }

    removeAllSplines() {
        // Remove all spline widgets
        const splineWidgets = this.getSplineWidgets();
        splineWidgets.forEach(widget => {
            const index = this.node.widgets.indexOf(widget);
            if (index > -1) {
                this.node.widgets.splice(index, 1);
            }
        });

        // Clear active widget reference
        this.activeWidget = null;

        // Update node height
        this.node.updateNodeHeight();

        // Trigger re-render of all layers
        if (this.node.editor && this.node.editor.layerRenderer) {
            this.node.editor.layerRenderer.render();
        }
        // Force canvas to update after node height change
        if (this.node.editor && this.node.editor.vis) {
            this.node.editor.vis.render();
        }

        this.node.setDirtyCanvas(true, true);
    }

    recreateSplinesFromData(widgets_values) {
        this.node.widgets = this.node.widgets.filter(w =>
            !(w instanceof PowerSplineWidget) &&
            !(w instanceof HandDrawLayerWidget) &&
            !(w instanceof BoxLayerWidget));

        // Create a map of widget data by name for safe, unambiguous lookup
        // This prevents any cross-contamination between widget values
        const widgetDataByName = new Map();
        for (const widgetValue of widgets_values || []) {
            if (widgetValue?.name && widgetValue.interpolation !== undefined) {
                widgetDataByName.set(widgetValue.name, widgetValue);
            }
        }

        // Recreate widgets using name-based lookup with explicit field assignment
        for (const [name, widgetValue] of widgetDataByName.entries()) {
            this.node.splineWidgetsCounter++;
            const isHand = widgetValue.type === 'handdraw';
            const isBox = widgetValue.type === 'box_layer';
            const widgetIdPrefix = isBox ? "box_" : "spline_";
            const widget = isHand
                ? new HandDrawLayerWidget("spline_" + this.node.splineWidgetsCounter)
                : (isBox ? new BoxLayerWidget(widgetIdPrefix + this.node.splineWidgetsCounter)
                         : new PowerSplineWidget("spline_" + this.node.splineWidgetsCounter));

            // Explicitly assign each field to ensure complete isolation
            // No spread operators that might share references
            widget.value = {
                on: widgetValue.on !== undefined ? widgetValue.on : true,
                name: widgetValue.name,
                type: isBox ? 'box_layer' : (isHand ? 'handdraw' : 'spline'),
                interpolation: widgetValue.interpolation,
                repeat: widgetValue.repeat || 1,
                offset: widgetValue.offset || 0,
                a_pause: widgetValue.a_pause || 0,
                z_pause: widgetValue.z_pause || 0,
                easing: widgetValue.easing || 'linear',
                easingConfig: widgetValue.easingConfig || { path: "full", strength: 1.0 },
                driven: widgetValue.driven || false,
                _drivenConfig: widgetValue._drivenConfig || (typeof widgetValue.driven === 'object' ? {...widgetValue.driven} : { driver: "", rotate: 0, d_scale: 1.0 }),
                scale: widgetValue.scale !== undefined ? widgetValue.scale : 1.00,
                points_store: widgetValue.points_store || "[]",
                coordinates: widgetValue.coordinates || "[]"
            };
            if (isBox) {
                widget.value.box_keys = widgetValue.box_keys || [];
                widget.value.box_timeline_point = widgetValue.box_timeline_point || 1;
                widget.value.box_interpolation = widgetValue.box_interpolation || 'linear'; // Restore box interpolation
            }

            // Insert spline widgets AFTER the header (same as addNewSpline logic)
            const headerIndex = this.node.widgets.findIndex(w => w.name === "spline_header");
            if (headerIndex !== -1) {
                // Find the last layer widget after the header
                let insertIndex = headerIndex + 1;
                for (let i = headerIndex + 1; i < this.node.widgets.length; i++) {
                    const wi = this.node.widgets[i];
                    if (wi instanceof PowerSplineWidget || wi instanceof HandDrawLayerWidget || wi instanceof BoxLayerWidget) {
                        insertIndex = i + 1;
                    } else {
                        break;
                    }
                }
                this.node.widgets.splice(insertIndex, 0, widget);
                widget.parent = this.node;
            } else {
                this.node.widgets.push(widget);
                widget.parent = this.node;
            }
        }

        // Reset active widget since all spline widgets are being recreated
        // This is critical to prevent stale references after node restoration
        const oldActiveWidget = this.activeWidget;
        this.activeWidget = null;
        
        // If there were widgets before recreation, we should try to set a new active widget
        if (this.node.widgets.length > 0) {
            const splineWidgets = this.getSplineWidgets();
            if (splineWidgets.length > 0) {
                // Find the first visible spline as the new active widget
                const visibleSpline = splineWidgets.find(w => w.value.on);
                if (visibleSpline) {
                    this.activeWidget = visibleSpline;
                } else {
                    // If no visible splines, select the first one (even if hidden)
                    this.activeWidget = splineWidgets[0];
                }
            }
        }
    }
}

// Safe sessionStorage setter to avoid quota errors
function safeSetSessionItem(key, value) {
    try { sessionStorage.setItem(key, value); } catch (e) { /* ignore quota/unsupported */ }
}

app.registerExtension({
    name: 'WanVideoWrapper_QQ.PowerSplineEditor',

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name === 'PowerSplineEditor') {
          chainCallback(nodeType.prototype, "onNodeCreated", function () {
            this.serialize_widgets = true; // Enable widget serialization for persistence
            this.resizable = false;

            this.sizeManager = new NodeSizeManager(this);
            this.layerManager = new SplineLayerManager(this);

            // Set up onResize to use size manager
            this.onResize = function(size) {
              const constrainedSize = this.sizeManager.onNodeResized(size);
              size[0] = constrainedSize[0];
              size[1] = constrainedSize[1];
            };

            const coordinatesWidget = this.widgets.find(w => w.name === "coordinates");
            hideWidgetForGood(this, coordinatesWidget); // Hide first
            coordinatesWidget.value = "[]"; // Set default value *after* finding it

            var element = document.createElement("div");
            this.uuid = makeUUID()
            element.id = `spline-editor-${this.uuid}`
            element.style.margin = "0";
            element.style.padding = "0";
            element.style.display = "block";

            // Add a debug message when the node is initialized or pasted
            console.log("PowerSplineEditor node initialized/pasted with data:", this.properties);
            
            // fake image widget to allow copy/paste (set value to null and override draw to prevent "image null" text)
            const fakeimagewidget = this.addWidget("COMBO", "image", null, () => { }, { values: [] });
            hideWidgetForGood(this, fakeimagewidget)
            fakeimagewidget.draw = () => {}

            // Hide internal widgets that don't need visual display
            const pointsStoreWidget = this.widgets.find(w => w.name === "points_store");

            if (pointsStoreWidget) {
              hideWidgetForGood(this, pointsStoreWidget);
            }

            // Hide original width/height widgets and add custom dimensions widget BEFORE the canvas
            const widthWidget = this.widgets.find(w => w.name === "mask_width");
            const heightWidget = this.widgets.find(w => w.name === "mask_height");

            if (widthWidget) {
              // Add callback to track user adjustments
              const originalWidthCallback = widthWidget.callback;
              widthWidget.callback = (value) => {
                if (originalWidthCallback) originalWidthCallback.call(widthWidget, value);
                // Mark as user-adjusted and store dimensions
                this.properties = this.properties || {};
                this.properties.userAdjustedDims = true;
                this.properties.bgImageDims = this.properties.bgImageDims || {};
                this.properties.bgImageDims.width = value;
                try {
                  const hWidget = this.widgets.find(w => w.name === "mask_height");
                  const userDims = { width: Number(value), height: Number(hWidget ? hWidget.value : this.properties.bgImageDims.height || 0) };
                  if (this.uuid) sessionStorage.setItem(`spline-editor-user-dims-${this.uuid}`, JSON.stringify(userDims));
                } catch {}
              };
              hideWidgetForGood(this, widthWidget);
            }
            if (heightWidget) {
              // Add callback to track user adjustments
              const originalHeightCallback = heightWidget.callback;
              heightWidget.callback = (value) => {
                if (originalHeightCallback) originalHeightCallback.call(heightWidget, value);
                // Mark as user-adjusted and store dimensions
                this.properties = this.properties || {};
                this.properties.userAdjustedDims = true;
                this.properties.bgImageDims = this.properties.bgImageDims || {};
                this.properties.bgImageDims.height = value;
                try {
                  const wWidget = this.widgets.find(w => w.name === "mask_width");
                  const userDims = { width: Number(wWidget ? wWidget.value : this.properties.bgImageDims.width || 0), height: Number(value) };
                  if (this.uuid) sessionStorage.setItem(`spline-editor-user-dims-${this.uuid}`, JSON.stringify(userDims));
                } catch {}
              };
              hideWidgetForGood(this, heightWidget);
            }

            // Hide bg_img widget but add callback to update background image immediately
            const bgImgWidget = this.widgets.find(w => w.name === "bg_img");
            if (bgImgWidget) {
              hideWidgetForGood(this, bgImgWidget);
              
              // Add callback to update background image immediately when bg_img value changes
              const originalCallback = bgImgWidget.callback;
              bgImgWidget.callback = (value) => {
                if (originalCallback) {
                  originalCallback(value);
                }
                
                // Update background image based on the new selection
                this.updateBackgroundImage(value);
                
                return value;
              };
            }

            // Hide start_pause, end_pause widgets
            const startPauseWidget = this.widgets.find(w => w.name === "start_pause");
            if (startPauseWidget) {
              hideWidgetForGood(this, startPauseWidget);
              startPauseWidget.draw = () => {};
            }
            const endPauseWidget = this.widgets.find(w => w.name === "end_pause");
            if (endPauseWidget) {
              hideWidgetForGood(this, endPauseWidget);
              endPauseWidget.draw = () => {};
            }

            // Hide interpolation, offset, repeat, driver_rotation, and driver_d_scale widgets
            const interpolationWidget = this.widgets.find(w => w.name === "interpolation");
            if (interpolationWidget) {
              hideWidgetForGood(this, interpolationWidget);
              interpolationWidget.draw = () => {};
            }
            const offsetWidget = this.widgets.find(w => w.name === "offset");
            if (offsetWidget) {
              hideWidgetForGood(this, offsetWidget);
              offsetWidget.draw = () => {};
            }
            const repeatWidget = this.widgets.find(w => w.name === "repeat");
            if (repeatWidget) {
              hideWidgetForGood(this, repeatWidget);
              repeatWidget.draw = () => {};
            }
            const driverRotationWidget = this.widgets.find(w => w.name === "driver_rotation");
            if (driverRotationWidget) {
              hideWidgetForGood(this, driverRotationWidget);
              driverRotationWidget.draw = () => {};
            }
            const driverDScaleWidget = this.widgets.find(w => w.name === "driver_d_scale");
            if (driverDScaleWidget) {
              hideWidgetForGood(this, driverDScaleWidget);
              driverDScaleWidget.draw = () => {};
            }

            // Add custom widget method if it doesn't exist
            if (!this.addCustomWidget) {
              this.addCustomWidget = function(widget) {
                widget.parent = this;
                this.widgets = this.widgets || [];
                this.widgets.push(widget);

                // Ensure proper ComfyUI integration
                const originalMouse = widget.mouse;
                widget.mouse = function(event, pos, node) {
                  // Convert global pos to local widget pos
                  const localPos = [pos[0], pos[1] - (widget.last_y || 0)];
                  return originalMouse?.call(this, event, localPos, node);
                };

                return widget;
              };
            }

            // Add the new combined TopRowWidget that contains refresh button, bg_img dropdown, and width/height controls
            this.addCustomWidget(new TopRowWidget("top_row_display"));

            this.splineEditor2 = this.addDOMWidget(nodeData.name, "SplineEditor2Widget", element, {
            serialize: false,
            hideOnZoom: false,
            });

            // CRITICAL: DOM widget must report its height to LiteGraph's widget layout system
            // This ensures the canvas takes up the correct vertical space and other widgets appear below it
            this.splineEditor2.computeSize = function(width) {
                // Get current canvas height from widget (or use default)
                const heightWidget = this.node?.widgets?.find(w => w.name === "mask_height");
                const canvasHeight = heightWidget ? heightWidget.value : 480;
                // Include spacingAfterCanvas to ensure proper positioning of subsequent widgets
                const spacingAfterCanvas = this.node?.sizeManager?.config?.spacingAfterCanvas || 60;
                // Return canvas height + spacing so LiteGraph positions subsequent widgets correctly
                return [width, canvasHeight + spacingAfterCanvas];
            }.bind(this.splineEditor2);

            this.generateUniqueName = function(baseName, existingNames) {
              if (!existingNames.includes(baseName)) return baseName;
              const regex = /_(\d+)$/;
              let nameToCheck = baseName;
              let counter = 1;
              const match = baseName.match(regex);
              if (match) {
                nameToCheck = baseName.substring(0, match.index);
                counter = parseInt(match[1], 10) + 1;
              }
              let newName = `${nameToCheck}_${counter}`;
              while (existingNames.includes(newName)) {
                counter++;
                newName = `${nameToCheck}_${counter}`;
              }
              return newName;
            }

            this.hasSplineWidgets = function() {
              return this.widgets && this.widgets.some(w =>
                (w instanceof PowerSplineWidget) || (w instanceof HandDrawLayerWidget) || (w instanceof BoxLayerWidget));
            };

            this.allSplinesState = function() {
              const layerWidgets = this.widgets.filter(w =>
                (w instanceof PowerSplineWidget) || (w instanceof HandDrawLayerWidget) || (w instanceof BoxLayerWidget));
              if (!layerWidgets.length) return false;
              return layerWidgets.every(w => w.value.on);
            };

            this.toggleAllSplines = function() {
              const layerWidgets = this.widgets.filter(w =>
                (w instanceof PowerSplineWidget) || (w instanceof HandDrawLayerWidget) || (w instanceof BoxLayerWidget));
              const newState = !this.allSplinesState();
              layerWidgets.forEach(w => w.value.on = newState);
              this.setDirtyCanvas(true, true);
            };

            this.updateNodeHeight = function() {
              // Size manager now handles all spacing internally - no need to add extra padding
              this.sizeManager.updateSize(true);
            };

            // Silent auto-refresh overlay on init (mimics ? Refresh without alerts)
            this.initOverlayRefresh = async function() {
                try {
                    const bgImgWidget = this.widgets && this.widgets.find(w => w.name === "bg_img");
                    const bg_img = bgImgWidget ? bgImgWidget.value : "None";

                    // Try to pull a fresh ref image from connected node silently
                    const base64Image = await getReferenceImageFromConnectedNode(this);
                    if (base64Image) {
                        this.originalRefImageData = {
                            name: 'ref_image_from_connection.jpg',
                            base64: base64Image.split(',')[1],
                            type: 'image/jpeg'
                        };
                        try { await saveRefImageToCache(this.originalRefImageData.base64, 'bg_image.png'); } catch {}
                        if (this.uuid) {
                            sessionStorage.removeItem(`spline-editor-img-${this.uuid}`);
                        }
                        this.updateBackgroundImage(bg_img);
                        this.editor?.refreshBackgroundImage?.();
                        return;
                    }
                } catch {}
                // Fallback: just apply current selection to force overlay/cached handling
                try {
                    const bgImgWidget = this.widgets && this.widgets.find(w => w.name === "bg_img");
                    const bg_img = bgImgWidget ? bgImgWidget.value : "None";
                    this.updateBackgroundImage(bg_img);
                    this.editor?.refreshBackgroundImage?.();
                } catch {}
            }.bind(this);

            // Trigger the auto-refresh a couple of times during init to catch late readiness
            setTimeout(() => { this.initOverlayRefresh(); }, 150);
            setTimeout(() => { this.initOverlayRefresh(); }, 700);

            // Helper method to load background image from URL with optional scaling
            this.loadBackgroundImageFromUrl = function(imageUrl, imageName, targetWidth, targetHeight) {
                loadImageAsBase64(imageUrl).then(dataUrl => {
                    if (dataUrl) {
                        // If we have target dimensions, load and scale the image
                        if (targetWidth && targetHeight) {
                            // First, create an image to get the original dimensions
                            const img = new Image();
                            img.onload = () => {
                                // Scale the image to match the target dimensions
                                const canvas = document.createElement('canvas');
                                canvas.width = targetWidth;
                                canvas.height = targetHeight;
                                const ctx = canvas.getContext('2d');
                                
                                // Draw the original image scaled to the target dimensions
                                ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
                                
                                // Convert back to base64
                                const scaledDataUrl = canvas.toDataURL('image/jpeg');
                                this.imgData = {
                                    name: imageName,
                                    base64: scaledDataUrl.split(',')[1],
                                    type: 'image/jpeg'
                                };
                                this.editor.refreshBackgroundImage();
                                
                                // Update the widget values to match the new dimensions unless user has their own dims
                                const widthWidget = this.widgets.find(w => w.name === "mask_width");
                                const heightWidget = this.widgets.find(w => w.name === "mask_height");
                                const userDimsJson = this.uuid ? sessionStorage.getItem(`spline-editor-user-dims-${this.uuid}`) : null;
                                const hasUserDims = this.properties.userAdjustedDims || !!userDimsJson;
                                if (!hasUserDims) {
                                    if (widthWidget) widthWidget.value = targetWidth;
                                    if (heightWidget) heightWidget.value = targetHeight;
                                }

                                // Update editor dimensions (respect user dims if set)
                                if (this.editor) {
                                    const newW = hasUserDims && widthWidget ? Number(widthWidget.value) : targetWidth;
                                    const newH = hasUserDims && heightWidget ? Number(heightWidget.value) : targetHeight;
                                    this.editor.width = newW;
                                    this.editor.height = newH;
                                    if (this.editor.vis) {
                                        this.editor.vis.width(newW);
                                        this.editor.vis.height(newH);
                                        this.editor.vis.render();
                                    }
                                    
                                    // Normalize the spline points to the new dimensions if there are any splines
                                    const splineWidgets = this.widgets.filter(w =>
                                        (w instanceof PowerSplineWidget) || (w instanceof HandDrawLayerWidget) || (w instanceof BoxLayerWidget));
                                    splineWidgets.forEach(widget => {
                                        if (widget.value.points_store) {
                                            try {
                                                let points = JSON.parse(widget.value.points_store);
                                                // If points are in normalized coordinates (0-1 range), they don't need re-normalization
                                                // But if the canvas size changed significantly, we may need to update the editor's internal state
                                                this.editor.width = targetWidth;
                                                this.editor.height = targetHeight;
                                                
                                                // Refresh the active layer to ensure it uses the new dimensions
                                                if (this.layerManager && this.layerManager.activeWidget) {
                                                    // Update the editor's points with the new canvas dimensions
                                                    this.editor.onActiveLayerChanged();
                                                }
                                            } catch (e) {
                                                console.error("Error updating spline points for new dimensions:", e);
                                            }
                                        }
                                    });
                                    
                                    // Trigger a full refresh of the editor to apply the new dimensions properly
                                    if (this.editor.layerRenderer) {
                                        this.editor.layerRenderer.render();
                                    }
                                }
                            };
                            img.onerror = () => {
                                // If scaling fails, just use the original image
                                this.imgData = {
                                    name: imageName,
                                    base64: dataUrl.split(',')[1],
                                    type: 'image/jpeg'
                                };
                                this.editor.refreshBackgroundImage();
                            };
                            img.src = dataUrl;
                        } else {
                            // No target dimensions, just use the original image
                            this.imgData = {
                                name: imageName,
                                base64: dataUrl.split(',')[1],
                                type: 'image/jpeg'
                            };
                            this.editor.refreshBackgroundImage();
                        }
                    }
                });
            }.bind(this);

            // Set initial node size
            this.updateNodeHeight();

            // Add method to update background image immediately based on bg_img selection
            this.updateBackgroundImage = async function(bg_img) {
                // First check if we have saved dimensions to maintain proportions
                let targetWidth, targetHeight;
                const savedDims = sessionStorage.getItem(`spline-editor-dims-${this.uuid}`);
                if (savedDims) {
                    const dims = JSON.parse(savedDims);
                    targetWidth = dims.width;
                    targetHeight = dims.height;
                } else if (this.properties.bgImageDims) {
                    // Fallback to dimensions stored in properties
                    targetWidth = this.properties.bgImageDims.width;
                    targetHeight = this.properties.bgImageDims.height;
                }

                // Determine which image to load based on the bg_img selection
                if (bg_img === "None") {
                    // For "None" selection, we want to use the original reference image 
                    // instead of any previously processed image, so that updates from the refresh button take effect
                    // and to prevent stacking of darkening effects
                    if (this.originalRefImageData && this.originalRefImageData.base64) {
                        // We have original ref image data from the refresh button, apply darkening effect directly
                        const img = new Image();
                        img.onload = () => {
                            const canvas = document.createElement('canvas');
                            canvas.width = img.width;
                            canvas.height = img.height;
                            const ctx = canvas.getContext('2d');

                            ctx.drawImage(img, 0, 0);
                            ctx.fillStyle = `rgba(0, 0, 0, 0.6)`; // Same opacity as in onExecuted
                            ctx.fillRect(0, 0, canvas.width, canvas.height);

                            // Convert the darkened image to data URL
                            const darkenedDataUrl = canvas.toDataURL('image/jpeg');
                            this.imgData = {
                                name: 'bg_image.png',
                                base64: darkenedDataUrl.split(',')[1],
                                type: 'image/jpeg'
                            };
                            this.editor.refreshBackgroundImage();
                        };
                        img.onerror = () => {
                            // Fallback: try to load cached bg_image first, then default A.jpg
                            loadCachedRefImageAsBase64().then(cachedImageUrl => {
                                if (cachedImageUrl) {
                                    const fallbackImg = new Image();
                                    fallbackImg.onload = () => {
                                        const canvas = document.createElement('canvas');
                                        canvas.width = fallbackImg.width;
                                        canvas.height = fallbackImg.height;
                                        const ctx = canvas.getContext('2d');

                                        ctx.drawImage(fallbackImg, 0, 0);
                                        ctx.fillStyle = `rgba(0, 0, 0, 0.6)`;
                                        ctx.fillRect(0, 0, canvas.width, canvas.height);

                                        const darkenedDataUrl = canvas.toDataURL('image/jpeg');
                                        this.imgData = {
                                            name: 'bg_image.png',
                                            base64: darkenedDataUrl.split(',')[1],
                                            type: 'image/jpeg'
                                        };
                                        this.editor.refreshBackgroundImage();
                                    };
                                    fallbackImg.onerror = () => {
                                        // Final fallback to A.jpg
                                        const timestamp = Date.now();
                                        const defaultImageUrl = new URL(`bg/A.jpg?t=${timestamp}`, import.meta.url).href;
                                        this.loadBackgroundImageFromUrl(defaultImageUrl, 'A.jpg', targetWidth, targetHeight);
                                    };
                                    fallbackImg.src = cachedImageUrl;
                                } else {
                                    // Final fallback to A.jpg with dark overlay
                                    const timestamp = Date.now();
                                    const defaultImageUrl = new URL(`bg/A.jpg?t=${timestamp}`, import.meta.url).href;
                                    const img2 = new Image();
                                    img2.onload = () => {
                                        const canvas2 = document.createElement('canvas');
                                        canvas2.width = img2.width;
                                        canvas2.height = img2.height;
                                        const ctx2 = canvas2.getContext('2d');
                                        ctx2.drawImage(img2, 0, 0);
                                        ctx2.fillStyle = 'rgba(0,0,0,0.6)';
                                        ctx2.fillRect(0, 0, canvas2.width, canvas2.height);
                                        const darkUrl = canvas2.toDataURL('image/jpeg');
                                        this.imgData = { name: 'A.jpg', base64: darkUrl.split(',')[1], type: 'image/jpeg' };
                                        this.editor.refreshBackgroundImage();
                                    };
                                    img2.onerror = () => {
                                        this.loadBackgroundImageFromUrl(defaultImageUrl, 'A.jpg', targetWidth, targetHeight);
                                    };
                                    img2.src = defaultImageUrl;
                                }
                            });
                        };
                        // Use the original ref image data to create a data URL
                        img.src = `data:image/jpeg;base64,${this.originalRefImageData.base64}`;
                    } else {
                        // If no original ref image data, try to load cached bg_image first, then fallback to default
                        loadCachedRefImageAsBase64().then(cachedImageUrl => {
                            if (cachedImageUrl) {
                                const img = new Image();
                                img.onload = () => {
                                    const canvas = document.createElement('canvas');
                                    canvas.width = img.width;
                                    canvas.height = img.height;
                                    const ctx = canvas.getContext('2d');

                                    ctx.drawImage(img, 0, 0);
                                    ctx.fillStyle = `rgba(0, 0, 0, 0.6)`; // Same opacity as in onExecuted
                                    ctx.fillRect(0, 0, canvas.width, canvas.height);

                                    // Convert the darkened image to data URL
                                    const darkenedDataUrl = canvas.toDataURL('image/jpeg');
                                    this.imgData = {
                                        name: 'bg_image.png',
                                        base64: darkenedDataUrl.split(',')[1],
                                        type: 'image/jpeg'
                                    };
                                    this.editor.refreshBackgroundImage();
                                };
                                img.onerror = () => {
                                    // Fallback to loading default A.jpg if ref_image doesn't exist
                                    const timestamp = Date.now();
                                    const defaultImageUrl = new URL(`bg/A.jpg?t=${timestamp}`, import.meta.url).href;
                                    this.loadBackgroundImageFromUrl(defaultImageUrl, 'A.jpg', targetWidth, targetHeight);
                                };
                                img.src = cachedImageUrl;
                            } else {
                                // Fallback to default A.jpg with dark overlay
                                const timestamp = Date.now();
                                const defaultImageUrl = new URL(`bg/A.jpg?t=${timestamp}`, import.meta.url).href;
                                const img2 = new Image();
                                img2.onload = () => {
                                    const canvas2 = document.createElement('canvas');
                                    canvas2.width = img2.width;
                                    canvas2.height = img2.height;
                                    const ctx2 = canvas2.getContext('2d');
                                    ctx2.drawImage(img2, 0, 0);
                                    ctx2.fillStyle = 'rgba(0,0,0,0.6)';
                                    ctx2.fillRect(0, 0, canvas2.width, canvas2.height);
                                    const darkUrl = canvas2.toDataURL('image/jpeg');
                                    this.imgData = { name: 'A.jpg', base64: darkUrl.split(',')[1], type: 'image/jpeg' };
                                    this.editor.refreshBackgroundImage();
                                };
                                img2.onerror = () => {
                                    this.loadBackgroundImageFromUrl(defaultImageUrl, 'A.jpg', targetWidth, targetHeight);
                                };
                                img2.src = defaultImageUrl;
                            }
                        });
                    }
                } else {
                    // Load the selected background image (A, B, or C) from the bg folder
                    const timestamp = Date.now();
                    const imageUrl = new URL(`bg/${bg_img}.jpg?t=${timestamp}`, import.meta.url).href;
                    
                    // Use the overlay function from image_overlay.js with proper scaling
                    // Prioritize original reference image (from refresh) over cached, to prevent stacking
                    let refImageForOverlay = null;
                    
                    if (this.originalRefImageData && this.originalRefImageData.base64) {
                        // Use original ref image if available (from refresh button)
                        refImageForOverlay = `data:image/jpeg;base64,${this.originalRefImageData.base64}`;
                    } else {
                        // Otherwise, load from cached
                        loadCachedRefImageAsBase64().then(cachedImageUrl => {
                            if (cachedImageUrl) {
                                // Create a properly scaled overlay using the original cached ref image
                                this.createScaledImageOverlay(cachedImageUrl, bg_img, imageUrl);
                            } else {
                                // Fallback to loading the background image directly if no ref image
                                this.loadBackgroundImageFromUrl(imageUrl, `${bg_img}.jpg`, targetWidth, targetHeight);
                            }
                        }).catch(error => {
                            console.error(`Error loading ref image for immediate overlay with ${bg_img}.jpg:`, error);
                            // Fallback to loading the background image directly
                            this.loadBackgroundImageFromUrl(imageUrl, `${bg_img}.jpg`, targetWidth, targetHeight);
                        });
                        return; // Return early to avoid duplicate processing
                    }
                    
                    if (refImageForOverlay) {
                        // Create a properly scaled overlay with the original ref image
                        this.createScaledImageOverlay(refImageForOverlay, bg_img, imageUrl);
                    } else {
                        // Fallback to loading the background image directly if no ref image
                        this.loadBackgroundImageFromUrl(imageUrl, `${bg_img}.jpg`, targetWidth, targetHeight);
                    }
                }
            }.bind(this);

            // Add method to update reference image from connected node
            this.updateReferenceImageFromConnectedNode = async function() {
                console.log('Attempting to update reference image from connected node...');

                try {
                    // Preserve the original canvas dimensions before refresh
                    const preservedWidth = this.editor?.originalImageWidth;
                    const preservedHeight = this.editor?.originalImageHeight;
                    const preservedScale = this.editor?.scale;

                    // Get reference image from connected bg_image input
                    const base64Image = await getReferenceImageFromConnectedNode(this, 'bg_image');
                    if (!base64Image) {
                        console.warn('Could not retrieve reference image from connected node');
                        // Optionally show a message to the user
                        alert('Could not retrieve reference image from connected node. Make sure an image node is connected to the bg_image input.');
                        return;
                    }

                    // We need to resize the fetched image to match the original canvas dimensions
                    // to maintain consistent scaling for the green boxes
                    if (preservedWidth && preservedHeight) {
                        const tempImg = new Image();
                        const resizedImageData = await new Promise((resolve, reject) => {
                            tempImg.onload = () => {
                                // Create a canvas to resize the image
                                const resizeCanvas = document.createElement('canvas');
                                resizeCanvas.width = preservedWidth;
                                resizeCanvas.height = preservedHeight;
                                const resizeCtx = resizeCanvas.getContext('2d');

                                // Draw the image scaled to the preserved dimensions
                                resizeCtx.drawImage(tempImg, 0, 0, preservedWidth, preservedHeight);

                                // Get the resized image as base64
                                const resizedDataUrl = resizeCanvas.toDataURL('image/jpeg', 0.95);
                                const resizedBase64 = resizedDataUrl.split(',')[1];

                                resolve(resizedBase64);
                            };
                            tempImg.onerror = reject;
                            tempImg.src = base64Image;
                        });

                        // Store the resized reference image
                        this.originalRefImageData = {
                            name: 'ref_image_from_connection.jpg',
                            base64: resizedImageData,
                            type: 'image/jpeg'
                        };
                    } else {
                        // No preserved dimensions, use the image as-is
                        this.originalRefImageData = {
                            name: 'ref_image_from_connection.jpg',
                            base64: base64Image.split(',')[1],
                            type: 'image/jpeg'
                        };
                    }

                    // Cache the ref image for future use
                    await saveRefImageToCache(this.originalRefImageData.base64, 'bg_image.png');

                    // Clear session storage cache for this node's image to force refresh
                    if (this.uuid) {
                        sessionStorage.removeItem(`spline-editor-img-${this.uuid}`);
                    }

                    // Get current bg_img selection to update background accordingly
                    const bgImgWidget = this.widgets.find(w => w.name === "bg_img");
                    const bg_img = bgImgWidget ? bgImgWidget.value : "None";

                    // Update background based on current bg_img selection
                    this.updateBackgroundImage(bg_img);

                    // Wait for the image processing to complete
                    await new Promise(resolve => setTimeout(resolve, 200));

                    // Restore the preserved dimensions and scale if they changed
                    if (preservedWidth && preservedHeight && this.editor) {
                        if (this.editor.originalImageWidth !== preservedWidth || this.editor.originalImageHeight !== preservedHeight) {
                            this.editor.originalImageWidth = preservedWidth;
                            this.editor.originalImageHeight = preservedHeight;
                            this.editor.scale = preservedScale;
                            this.editor.recenterBackgroundImage();
                        }
                    }

                } catch (error) {
                    console.error('Error updating reference image from connected node:', error);
                    alert('Error updating reference image: ' + error.message);
                }
            }.bind(this);

            // Attach ref_images input to the active box layer (Ref selection)
            this.attachRefImageToActiveBoxLayer = async function(desiredSelection = 'ref_1') {
                const activeWidget = this.layerManager?.getActiveWidget?.();
                if (!activeWidget || activeWidget.value?.type !== 'box_layer') {
                    alert('Activate a box layer first to attach a ref image.');
                    return;
                }

                // Fetch images from ref_images input (first frame used)
                const images = await getReferenceImagesFromConnectedNode(this);
                if (!images || images.length === 0) {
                    alert('No ref_images input found. Connect an IMAGE or IMAGE batch to ref_images.');
                    return;
                }

                const attachments = [];
                const maxRefs = 5;
                for (let i = 0; i < Math.min(images.length, maxRefs); i++) {
                    const imgData = images[i];
                    const base64Data = imgData.startsWith('data:')
                        ? imgData.split(',')[1]
                        : imgData;
                    const dataUrl = imgData.startsWith('data:')
                        ? imgData
                        : `data:image/png;base64,${base64Data}`;

                    // Load dimensions to fit the box without stretching
                    // eslint-disable-next-line no-await-in-loop
                    const dims = await new Promise((resolve) => {
                        const img = new Image();
                        img.onload = () => resolve({ width: img.width, height: img.height });
                        img.onerror = () => resolve({ width: 1, height: 1 });
                        img.src = dataUrl;
                    });

                    // Save image to disk and store path instead of base64
                    const filename = `ref_image_${i}.png`;
                    // eslint-disable-next-line no-await-in-loop
                    await saveRefImageToCache(base64Data, filename);

                    attachments.push({
                        path: `bg/${filename}`,  // Store file path instead of base64
                        type: 'image/png',
                        width: dims.width,
                        height: dims.height,
                        name: filename
                    });
                }

                activeWidget.value.ref_attachment = { entries: attachments };

                // Clear ref image cache when new attachments are loaded to prevent stale images
                if (this.layerRenderer && this.layerRenderer.clearRefImageCache) {
                    this.layerRenderer.clearRefImageCache();
                    // Force render to update displayed reference image with new timestamp
                    this.layerRenderer.render();
                }

                const availableOptions = activeWidget._getRefOptions ? activeWidget._getRefOptions() : ['no_ref', 'ref_1', 'ref_2', 'ref_3', 'ref_4', 'ref_5'];
                const desiredIdx = desiredSelection && availableOptions.includes(desiredSelection)
                    ? Math.max(0, (parseInt(desiredSelection.split('_')[1], 10) || 1) - 1)
                    : 0;
                if (attachments.length === 0 || desiredIdx >= attachments.length) {
                    activeWidget.value.ref_selection = 'no_ref';
                } else {
                    const clampedIndex = Math.min(attachments.length - 1, desiredIdx);
                    activeWidget.value.ref_selection = `ref_${clampedIndex + 1}`;
                }

                // Persist per-layer in sessionStorage for reloads (store attachment + selection)
                try {
                    const keyId = this.id ?? this.uuid;
                    const key = keyId ? `spline-editor-boxref-${keyId}-${activeWidget.value.name || activeWidget.name || 'box'}` : null;
                    if (key) {
                        sessionStorage.setItem(key, JSON.stringify({
                            attachment: activeWidget.value.ref_attachment,
                            selection: activeWidget.value.ref_selection,
                        }));
                    }
                } catch (e) {
                    console.warn('Failed to persist box ref attachment to session:', e);
                }

                // Clear global ref cache so background overlay does not use ref_images batch
                try { sessionStorage.removeItem('spline-editor-cached-ref-image'); } catch {}

                // Save all frames (first + any extras) to disk as numbered PNGs
                for (let i = 0; i < images.length; i++) {
                    const imgData = images[i];
                    const b64 = imgData.startsWith('data:') ? imgData.split(',')[1] : imgData;
                    await saveRefImageToCache(b64, `ref_image_${i}.png`, { skipSessionCache: true });
                }

                // Refresh canvas
                this.setDirtyCanvas(true, true);
                this.editor?.refreshBackgroundImage?.();
            }.bind(this);

            // Clear ref attachment from active box layer
            this.clearRefImageFromActiveBoxLayer = function() {
                const activeWidget = this.layerManager?.getActiveWidget?.();
                if (activeWidget && activeWidget.value?.type === 'box_layer') {
                    activeWidget.value.ref_attachment = null;
                    activeWidget.value.ref_selection = 'no_ref';
                    try {
                        const keyId = this.id ?? this.uuid;
                        const key = keyId ? `spline-editor-boxref-${keyId}-${activeWidget.value.name || activeWidget.name || 'box'}` : null;
                        if (key) sessionStorage.removeItem(key);
                    } catch {}
                    this.setDirtyCanvas(true, true);
                }
            }.bind(this);

            // Update ref attachments for all box layers from connected ref_images
            this.updateAllBoxLayerRefs = async function() {
                const widgets = this.layerManager?.getSplineWidgets?.() || [];
                const boxWidgets = widgets.filter(w => w?.value?.type === 'box_layer');
                if (!boxWidgets.length) return;

                // Clear ref image cache to force reload of all images
                if (this.layerRenderer && this.layerRenderer.clearRefImageCache) {
                    this.layerRenderer.clearRefImageCache();
                }

                // Fetch images from ref_images input (first frame used)
                const images = await getReferenceImagesFromConnectedNode(this);
                if (!images || images.length === 0) {
                    console.warn('No ref_images input found for updating box layer refs.');
                    return;
                }

                const attachments = [];
                const maxRefs = 5;
                for (let i = 0; i < Math.min(images.length, maxRefs); i++) {
                    const imgData = images[i];
                    const base64Data = imgData.startsWith('data:')
                        ? imgData.split(',')[1]
                        : imgData;
                    const dataUrl = imgData.startsWith('data:')
                        ? imgData
                        : `data:image/png;base64,${base64Data}`;

                    // Load dimensions to fit the box without stretching
                    // eslint-disable-next-line no-await-in-loop
                    const dims = await new Promise((resolve) => {
                        const img = new Image();
                        img.onload = () => resolve({ width: img.width, height: img.height });
                        img.onerror = () => resolve({ width: 1, height: 1 });
                        img.src = dataUrl;
                    });

                    // Save image to disk and store path instead of base64
                    const filename = `ref_image_${i}.png`;
                    // eslint-disable-next-line no-await-in-loop
                    await saveRefImageToCache(base64Data, filename);

                    attachments.push({
                        path: `bg/${filename}`,
                        type: 'image/png',
                        width: dims.width,
                        height: dims.height,
                        name: filename
                    });
                }

                // Update all box layers with the new attachments
                boxWidgets.forEach(boxWidget => {
                    const currentSelection = boxWidget.value.ref_selection || 'no_ref';
                    boxWidget.value.ref_attachment = { entries: attachments };

                    // Keep current selection if it's still valid, otherwise set to no_ref
                    if (currentSelection !== 'no_ref') {
                        const parts = currentSelection.split('_');
                        const idx = parts.length > 1 ? parseInt(parts[1], 10) : 1;
                        const arrayIndex = Number.isFinite(idx) ? Math.max(0, idx - 1) : 0;
                        if (arrayIndex >= attachments.length) {
                            boxWidget.value.ref_selection = 'no_ref';
                        }
                        // Otherwise keep the existing selection
                    }

                    // Persist to sessionStorage
                    try {
                        const keyId = this.id ?? this.uuid;
                        const key = keyId ? `spline-editor-boxref-${keyId}-${boxWidget.value.name || boxWidget.name || 'box'}` : null;
                        if (key) {
                            sessionStorage.setItem(key, JSON.stringify({
                                attachment: boxWidget.value.ref_attachment,
                                selection: boxWidget.value.ref_selection,
                            }));
                        }
                    } catch (e) {
                        console.warn('Failed to persist box ref attachment to session:', e);
                    }
                });

                // Clear global ref cache
                try { sessionStorage.removeItem('spline-editor-cached-ref-image'); } catch {}

                // Save all frames to disk
                for (let i = 0; i < images.length; i++) {
                    const imgData = images[i];
                    const b64 = imgData.startsWith('data:') ? imgData.split(',')[1] : imgData;
                    await saveRefImageToCache(b64, `ref_image_${i}.png`, { skipSessionCache: true });
                }

                // Clear ref image cache again after all images saved to force reload with new images
                this.editor?.layerRenderer?.clearRefImageCache?.();

                // Refresh canvas
                this.setDirtyCanvas(true, true);
            }.bind(this);

            // Add method to handle frames input refresh and box layer keyframe scaling
            this.handleFramesRefresh = function() {
                console.log('Handling frames refresh...');

                try {
                    // Step 1: Find all box type layers in the layer manager
                    const boxLayers = [];
                    if (this.widgets) {
                        for (const widget of this.widgets) {
                            if (widget.value && widget.value.type === 'box_layer') {
                                boxLayers.push(widget);
                            }
                        }
                    }

                    if (boxLayers.length === 0) {
                        console.log('No box type layers found');
                        return;
                    }

                    console.log(`Found ${boxLayers.length} box layer(s)`);

                    // Step 2: Check which box layers have keyframes set
                    const boxLayersWithKeys = boxLayers.filter(layer => {
                        return layer.value.box_keys && Array.isArray(layer.value.box_keys) && layer.value.box_keys.length > 0;
                    });

                    if (boxLayersWithKeys.length === 0) {
                        console.log('No box layers with keyframes found');
                    } else {
                        console.log(`Found ${boxLayersWithKeys.length} box layer(s) with keyframes`);
                    }

                    // Step 3: Determine target frames (must come from frames input/property)
                    const framesInputValue = this.getInputOrProperty('frames');
                    const hasFramesInput = typeof framesInputValue === 'number' && !Number.isNaN(framesInputValue) && framesInputValue > 0;
                    if (!hasFramesInput) {
                        console.log('No frames input connected or invalid value; aborting frames refresh.');
                        return;
                    }
                    const targetFrames = Math.max(1, Math.round(framesInputValue));
                    console.log('Frames input value:', targetFrames);

                    // Step 4: Get current max frames from timeline (import from canvas_constants.js)
                    // We need to dynamically import or access the constant
                    import('./canvas/canvas_constants.js').then(module => {
                        const currentMaxFrames = (this.editor?._getMaxFrames?.()) || module.BOX_TIMELINE_MAX_POINTS || 50;
                        console.log(`Current max frames: ${currentMaxFrames}, Target frames: ${targetFrames}`);

                        const persistMaxFrames = (frames) => {
                            if (this.editor) {
                                this.editor._maxFrames = frames;
                            }
                            // Persist in both properties (serialized) and session (fast reload)
                            this.properties = this.properties || {};
                            this.properties.box_max_frames = frames;
                            if (this.uuid) {
                                safeSetSessionItem(`spline-editor-maxframes-${this.uuid}`, String(frames));
                            }
                        };

                        // Determine last keyframe across box layers (if any)
                        const lastKeyFrame = boxLayersWithKeys.length > 0
                            ? Math.max(...boxLayersWithKeys.map(layer => Math.max(...layer.value.box_keys.map(k => Math.max(1, Number(k.frame) || 1)))))
                            : 0;

                        // Step 5: Decide scaling behavior based on target vs current max
                        if (targetFrames > currentMaxFrames) {
                            console.log('Extending timeline to target frames; preserving keyframe positions.');
                            persistMaxFrames(targetFrames);
                        } else {
                            if (lastKeyFrame <= targetFrames) {
                                console.log('Last keyframe within target; shrinking timeline without scaling.');
                                persistMaxFrames(targetFrames);
                            } else {
                                const scaleRatio = targetFrames / currentMaxFrames;
                                console.log(`Last keyframe exceeds target; scaling keyframes with ratio ${scaleRatio}.`);
                                if (boxLayersWithKeys.length > 0) {
                                    for (const layer of boxLayersWithKeys) {
                                        const originalKeys = layer.value.box_keys;
                                        const scaledKeys = originalKeys.map(key => {
                                            const newFrame = Math.max(1, Math.min(targetFrames, Math.round(key.frame * scaleRatio)));
                                            return { ...key, frame: newFrame };
                                        });

                                        // Remove duplicate frames (keep last one for each frame)
                                        const keysByFrame = new Map();
                                        for (const key of scaledKeys) {
                                            keysByFrame.set(key.frame, key);
                                        }
                                        layer.value.box_keys = Array.from(keysByFrame.values()).sort((a, b) => a.frame - b.frame);

                                        console.log(`Scaled ${originalKeys.length} keys for layer "${layer.value.name}"`);
                                    }
                                }
                                persistMaxFrames(targetFrames);
                            }
                        }

                        // Step 8: Force refresh the editor to show the changes
                        if (this.editor && this.editor.redraw) {
                            this.editor.redraw();
                        }

                        this.setDirtyCanvas(true, true);

                        console.log('Frames refresh completed successfully');
                    }).catch(err => {
                        console.error('Error importing canvas_constants:', err);
                    });

                } catch (error) {
                    console.error('Error handling frames refresh:', error);
                }
            }.bind(this);

            // Helper method to get input value or property
            this.getInputOrProperty = function(name) {
                const coerceNumber = (val) => {
                    if (val === null || val === undefined) return val;
                    const num = Number(val);
                    return Number.isNaN(num) ? val : num;
                };

                // First try to get from connected input
                if (this.inputs) {
                    const inputIndex = this.inputs.findIndex(i => i.name === name);
                    if (inputIndex >= 0 && this.inputs[inputIndex].link != null) {
                        // Get the link
                        const link = app.graph.links.get(this.inputs[inputIndex].link);
                        // Prefer explicit link data if available
                        if (link && link.data !== undefined) {
                            return coerceNumber(link.data);
                        }
                        if (link) {
                            // Get the source node
                            const sourceNode = app.graph._nodes.find(n => n.id === link.origin_id);
                            if (sourceNode && sourceNode.outputs && sourceNode.outputs[link.origin_slot]) {
                                // Try to get the value from the source node's widget
                                const outputName = sourceNode.outputs[link.origin_slot].name;
                                const widget = sourceNode.widgets?.find(w => w.name === outputName || w.name === name);
                                if (widget) {
                                    return coerceNumber(widget.value);
                                }
                                // Fallback to output value on the source node
                                const outputVal = sourceNode.outputs[link.origin_slot].value;
                                if (outputVal !== undefined) {
                                    return coerceNumber(outputVal);
                                }
                                // Fallback: first numeric widget on source node
                                const firstNumericWidget = sourceNode.widgets?.find(w => {
                                    const num = coerceNumber(w.value);
                                    return typeof num === 'number' && !Number.isNaN(num);
                                });
                                if (firstNumericWidget) {
                                    return coerceNumber(firstNumericWidget.value);
                                }
                                // Fallback: first numeric property on source node
                                const firstNumericProp = (() => {
                                    if (!sourceNode.properties) return null;
                                    for (const val of Object.values(sourceNode.properties)) {
                                        const num = coerceNumber(val);
                                        if (typeof num === 'number' && !Number.isNaN(num)) return num;
                                    }
                                    return null;
                                })();
                                if (firstNumericProp !== null) {
                                    return firstNumericProp;
                                }
                            }
                        }
                        // Fallback to direct input value if present
                        const directInputVal = this.inputs[inputIndex].value;
                        if (directInputVal !== undefined) {
                            return coerceNumber(directInputVal);
                        }
                    }
                }

                // Fallback to property
                if (this.properties && this.properties[name] !== undefined) {
                    return coerceNumber(this.properties[name]);
                }

                // Fallback to widget
                const widget = this.widgets?.find(w => w.name === name);
                if (widget) {
                    return coerceNumber(widget.value);
                }

                return null;
            }.bind(this);

            // Add method to create scaled overlay for immediate background updates
            this.createScaledImageOverlay = async function(refImageUrl, bg_img, bgImageUrl) {
                try {
                    // Load both images
                    const [refResponse, bgResponse] = await Promise.all([
                        fetch(refImageUrl),
                        fetch(bgImageUrl)
                    ]);
                    
                    if (!refResponse.ok || !bgResponse.ok) {
                        throw new Error(`Failed to load images: ref=${refResponse.status}, bg=${bgResponse.status}`);
                    }
                    
                    const [refBlob, bgBlob] = await Promise.all([
                        refResponse.blob(),
                        bgResponse.blob()
                    ]);
                    
                    // Convert to base64
                    const [refBase64, bgBase64] = await Promise.all([
                        new Promise(resolve => {
                            const reader = new FileReader();
                            reader.onload = () => resolve(reader.result.split(',')[1]);
                            reader.readAsDataURL(refBlob);
                        }),
                        new Promise(resolve => {
                            const reader = new FileReader();
                            reader.onload = () => resolve(reader.result.split(',')[1]);
                            reader.readAsDataURL(bgBlob);
                        })
                    ]);

                    // Scale the bg image to match the ref image dimensions
                    const scaledBgImageData = await scaleImageToRefDimensions(
                        bgBase64,
                        'image/jpeg', // Assuming JPEG for background images
                        refBase64
                    );
                    
                    // Create the overlay with the scaled image
                    const refImg = new Image();
                    const scaledBgImg = new Image();
                    
                    let refImageLoaded = false;
                    let scaledBgImageLoaded = false;
                    
                    // Function to create overlay when both images are loaded
                    const createOverlayWhenBothLoaded = () => {
                        if (refImageLoaded && scaledBgImageLoaded) {
                            const canvas = document.createElement('canvas');
                            canvas.width = refImg.width;
                            canvas.height = refImg.height;
                            const ctx = canvas.getContext('2d');
                            
                            // Draw the original ref_image first
                            ctx.drawImage(refImg, 0, 0);
                            
                            // Then draw the scaled background image as an overlay with 40% opacity
                            ctx.globalAlpha = 0.4;
                            ctx.drawImage(scaledBgImg, 0, 0);
                            ctx.globalAlpha = 1.0; // Reset to default
                            
                            // Convert the combined image to data URL
                            const combinedDataUrl = canvas.toDataURL('image/jpeg');
                            
                            const overlayImgData = {
                                name: `${bg_img}.jpg`,
                                base64: combinedDataUrl.split(',')[1],
                                type: 'image/jpeg'
                            };
                            
                            // Update the imgData property with the overlay data
                            this.imgData = overlayImgData;
                            
                            // Refresh the background image
                            this.editor.refreshBackgroundImage();
                        }
                    };
                    
                    refImg.onload = () => {
                        refImageLoaded = true;
                        createOverlayWhenBothLoaded();
                    };
                    scaledBgImg.onload = () => {
                        scaledBgImageLoaded = true;
                        createOverlayWhenBothLoaded();
                    };
                    
                    refImg.onerror = () => {
                        console.error(`Failed to load ref_image for scaled overlay with ${bg_img}.jpg`);
                        // Fallback: load the background image directly without overlay
                        this.loadBackgroundImageFromUrl(bgImageUrl, `${bg_img}.jpg`, null, null);
                    };
                    scaledBgImg.onerror = () => {
                        console.error(`Failed to load scaled background image for overlay with ${bg_img}.jpg`);
                        // Fallback: load the background image directly without overlay
                        this.loadBackgroundImageFromUrl(bgImageUrl, `${bg_img}.jpg`, null, null);
                    };
                    
                    // Load images
                    refImg.src = refImageUrl;
                    scaledBgImg.src = `data:image/jpeg;base64,${scaledBgImageData.base64}`;
                    
                } catch (error) {
                    console.error(`Error creating scaled image overlay for ${bg_img}.jpg:`, error);
                    // Fallback to loading the background image directly
                    this.loadBackgroundImageFromUrl(bgImageUrl, `${bg_img}.jpg`, null, null);
                }
            }.bind(this);

            // context menu
            this.contextMenu = document.createElement("div");
            this.contextMenu.className = 'spline-editor-context-menu';
            this.contextMenu.id = "context-menu";
            this.contextMenu.style.display = "none";
            this.contextMenu.style.position = "absolute";
            this.contextMenu.style.backgroundColor = "#202020";
            this.contextMenu.style.minWidth = "100px";
            this.contextMenu.style.boxShadow = "0px 8px 16px 0px rgba(0,0,0,0.2)";
            this.contextMenu.style.zIndex = "100";
            this.contextMenu.style.padding = "5px";

            function styleMenuItem(menuItem) {
              menuItem.style.display = "block";
              menuItem.style.padding = "5px";
              menuItem.style.color = "#FFF";
              menuItem.style.fontFamily = "Arial, sans-serif";
              menuItem.style.fontSize = "16px";
              menuItem.style.textDecoration = "none";
              menuItem.style.marginBottom = "5px";
            }
            function createMenuItem(id, textContent) {
              let menuItem = document.createElement("a");
              menuItem.href = "#";
              menuItem.id = `menu-item-${id}`;
              menuItem.textContent = textContent;
              styleMenuItem(menuItem);
              return menuItem;
            }
            
            // Create an array of menu items using the createMenuItem function
            this.menuItems = [
              createMenuItem(0, "Invert point order"),
              createMenuItem(1, "Smooth"),
              createMenuItem(2, "Delete spline"),
              createMenuItem(3, "Background image"),
              createMenuItem(4, "Clear Image"),
              createMenuItem(5, "Delete all splines"),
            ];
            
            // Add mouseover and mouseout event listeners to each menu item for styling
            this.menuItems.forEach(menuItem => {
              menuItem.addEventListener('mouseover', function() {
                this.style.backgroundColor = "gray";
              });
            
              menuItem.addEventListener('mouseout', function() {
                this.style.backgroundColor = "#202020";
              });
            });
            
            // Append each menu item to the context menu
            this.menuItems.forEach(menuItem => {
              this.contextMenu.appendChild(menuItem);
            });

            document.body.appendChild(this.contextMenu);

            this.splineEditor2.parentEl = document.createElement("div");
            this.splineEditor2.parentEl.className = "spline-editor";
            this.splineEditor2.parentEl.id = `spline-editor-${this.uuid}`;
            this.splineEditor2.parentEl.style.display = "block";
            this.splineEditor2.parentEl.style.margin = "0";
            this.splineEditor2.parentEl.style.padding = "0";
            element.appendChild(this.splineEditor2.parentEl);

            this.editor = new SplineEditor2(this);
            // Restore persisted max frames for box timelines if available
            const propMaxFrames = Number(this.properties?.box_max_frames);
            if (!Number.isNaN(propMaxFrames) && propMaxFrames > 0) {
                this.editor._maxFrames = propMaxFrames;
                if (this.uuid) {
                    safeSetSessionItem(`spline-editor-maxframes-${this.uuid}`, String(propMaxFrames));
                }
            } else if (this.uuid) {
                const savedMaxFrames = Number(sessionStorage.getItem(`spline-editor-maxframes-${this.uuid}`));
                if (!Number.isNaN(savedMaxFrames) && savedMaxFrames > 0) {
                    this.editor._maxFrames = savedMaxFrames;
                }
            }
            // Expose commit handler for handdraw to the editor/node
            this.commitHanddraw = (points) => {
                try { commitHanddrawPath(this, points); } catch (e) { console.error('commitHanddraw failed', e); }
            };

            // Try to load image from session storage for persistence across reloads
            if (this.uuid) {
              const sessionImgData = sessionStorage.getItem(`spline-editor-img-${this.uuid}`);
              if (sessionImgData) {
                this.imgData = JSON.parse(sessionImgData);
              } else if (this.properties.imgData) {
                // Migrate from old property if it exists
                this.imgData = this.properties.imgData;
                delete this.properties.imgData;
              }
            }

            // Ensure the background image is refreshed after editor creation
            if (this.editor && this.imgData) {
                 this.editor.refreshBackgroundImage();
            } else if (this.editor) {
                // If no image is loaded from session, first try to load cached bg_image, then fallback to A.jpg
                // First check if we have saved dimensions to maintain proportions
                let targetWidth, targetHeight;
                const savedDims = sessionStorage.getItem(`spline-editor-dims-${this.uuid}`);
                if (savedDims) {
                    const dims = JSON.parse(savedDims);
                    targetWidth = dims.width;
                    targetHeight = dims.height;
                } else if (this.properties.bgImageDims) {
                    // Fallback to dimensions stored in properties
                    targetWidth = this.properties.bgImageDims.width;
                    targetHeight = this.properties.bgImageDims.height;
                }

                // Try to load cached bg_image first
                loadCachedRefImageAsBase64().then(cachedImageUrl => {
                    if (cachedImageUrl) {
                        this.loadBackgroundImageFromUrl(cachedImageUrl, 'bg_image.png', targetWidth, targetHeight);
                    } else {
                        // Fallback to default A.jpg
                        const timestamp = Date.now();
                        const defaultImageUrl = new URL(`bg/A.jpg?t=${timestamp}`, import.meta.url).href;
                        this.loadBackgroundImageFromUrl(defaultImageUrl, 'A.jpg', targetWidth, targetHeight);
                    }
                });
            }

            // Add button bar widget AFTER canvas - positioned between canvas and layers
            const buttonBarWidget = new RgthreeBaseWidget("button_bar");
            buttonBarWidget.type = "custom";
            buttonBarWidget.serialize = false;

            // Track mouse state for button hover effects
            buttonBarWidget.addSplineMouseDown = false;
            buttonBarWidget.addBoxMouseDown = false;
            buttonBarWidget.drawMouseDown = false;
            buttonBarWidget.duplicateMouseDown = false;

            buttonBarWidget.computeSize = function(width) {
                return [width, LiteGraph.NODE_WIDGET_HEIGHT];
            };

            buttonBarWidget.draw = function(ctx, node, width, posY, height) {
                const margin = 15;
                const gap = 5;
                const totalWidth = width - margin * 2 - gap * 3;
                const addSplineWidth = totalWidth * 0.30;
                const addBoxWidth = totalWidth * 0.30;
                const drawWidth = totalWidth * 0.20;
                const duplicateWidth = totalWidth * 0.20;
                const addSplineX = margin;
                const addBoxX = addSplineX + addSplineWidth + gap;
                const drawX = addBoxX + addBoxWidth + gap;
                const duplicateX = drawX + drawWidth + gap;

                // Draw Add Spline button (30% width)
                drawWidgetButton(
                    ctx,
                    { size: [addSplineWidth, height], pos: [addSplineX, posY] },
                    "➕ Add Spline",
                    this.addSplineMouseDown
                );

                // Draw Add Box button (30% width)
                drawWidgetButton(
                    ctx,
                    { size: [addBoxWidth, height], pos: [addBoxX, posY] },
                    "🎥 Add Keyframes",
                    this.addBoxMouseDown
                );

                // Draw button (20% width)
                drawWidgetButton(
                    ctx,
                    { size: [drawWidth, height], pos: [drawX, posY] },
                    "✏️ Draw",
                    this.drawMouseDown || (node?.editor?._handdrawMode === 'create')
                );

                // Draw Duplicate button (20% width)
                drawWidgetButton(
                    ctx,
                    { size: [duplicateWidth, height], pos: [duplicateX, posY] },
                    "🧬 Duplicate",
                    this.duplicateMouseDown
                );
            };

            buttonBarWidget.mouse = function(event, pos, node) {
                if (event.type === "pointerdown" || event.type === "mousedown") {
                    const margin = 15;
                    const gap = 5;
                    const width = node.size[0];
                    const totalWidth = width - margin * 2 - gap * 3;
                    const addSplineWidth = totalWidth * 0.30;
                    const addBoxWidth = totalWidth * 0.30;
                    const drawWidth = totalWidth * 0.20;
                    const duplicateWidth = totalWidth * 0.20;
                    const addSplineLeft = margin;
                    const addSplineRight = addSplineLeft + addSplineWidth;
                    const addBoxLeft = addSplineRight + gap;
                    const addBoxRight = addBoxLeft + addBoxWidth;
                    const drawLeft = addBoxRight + gap;
                    const drawRight = drawLeft + drawWidth;
                    const duplicateLeft = drawRight + gap;
                    const duplicateRight = duplicateLeft + duplicateWidth;

                    if (pos[0] >= addSplineLeft && pos[0] <= addSplineRight) {
                        this.addSplineMouseDown = true;
                        node.setDirtyCanvas(true, false);
                        return true;
                    }
                    else if (pos[0] >= addBoxLeft && pos[0] <= addBoxRight) {
                        this.addBoxMouseDown = true;
                        node.setDirtyCanvas(true, false);
                        return true;
                    }
                    else if (pos[0] >= drawLeft && pos[0] <= drawRight) {
                        this.drawMouseDown = true;
                        node.setDirtyCanvas(true, false);
                        return true;
                    }
                    else if (pos[0] >= duplicateLeft &&
                             pos[0] <= duplicateRight) {
                        this.duplicateMouseDown = true;
                        node.setDirtyCanvas(true, false);
                        return true;
                    }
                }
                else if (event.type === "pointerup" || event.type === "mouseup") {
                    const margin = 15;
                    const gap = 5;
                    const width = node.size[0];
                    const totalWidth = width - margin * 2 - gap * 3;
                    const addSplineWidth = totalWidth * 0.30;
                    const addBoxWidth = totalWidth * 0.30;
                    const drawWidth = totalWidth * 0.20;
                    const duplicateWidth = totalWidth * 0.20;
                    const addSplineLeft = margin;
                    const addSplineRight = addSplineLeft + addSplineWidth;
                    const addBoxLeft = addSplineRight + gap;
                    const addBoxRight = addBoxLeft + addBoxWidth;
                    const drawLeft = addBoxRight + gap;
                    const drawRight = drawLeft + drawWidth;
                    const duplicateLeft = drawRight + gap;
                    const duplicateRight = duplicateLeft + duplicateWidth;

                    if (this.addSplineMouseDown &&
                        pos[0] >= addSplineLeft && pos[0] <= addSplineRight) {
                        if (node?.editor && node.editor._handdrawMode === 'create') {
                            node.editor.exitHanddrawMode?.(false);
                        }
                        node.layerManager.addNewSpline();
                    }
                    else if (this.addBoxMouseDown &&
                        pos[0] >= addBoxLeft && pos[0] <= addBoxRight) {
                        if (node?.editor && node.editor._handdrawMode === 'create') {
                            node.editor.exitHanddrawMode?.(false);
                        }
                        if (node.layerManager?.addNewBox) {
                            node.layerManager.addNewBox();
                        }
                    }
                    else if (this.drawMouseDown &&
                        pos[0] >= drawLeft && pos[0] <= drawRight) {
                        if (node?.editor) {
                            if (node.editor._handdrawMode === 'create') {
                                node.editor.exitHanddrawMode?.(false);
                            } else {
                                node.editor.enterHanddrawMode?.('create');
                            }
                            node.setDirtyCanvas(true, true);
                        }
                    }
                    else if (this.duplicateMouseDown &&
                        pos[0] >= duplicateLeft && pos[0] <= duplicateRight) {
                        if (node?.editor && node.editor._handdrawMode === 'create') {
                            node.editor.exitHanddrawMode?.(false);
                        }
                        const activeWidget = node.layerManager.getActiveWidget();
                        if (activeWidget) {
                            node.layerManager.duplicateSpline(activeWidget);
                        }
                    }

                    this.addSplineMouseDown = false;
                    this.addBoxMouseDown = false;
                    this.drawMouseDown = false;
                    this.duplicateMouseDown = false;
                    node.setDirtyCanvas(true, false);
                    return true;
                }
                return false;
            };

            this.addCustomWidget(buttonBarWidget);

            // Add header widget AFTER button bar
            this.addCustomWidget(new PowerSplineHeaderWidget("spline_header"));

            // Removed double-click rename behavior (no longer used)

          // Override onNodeContextMenu to handle driven toggle right-click
          const originalOnNodeContextMenu = nodeType.prototype.onNodeContextMenu;
          nodeType.prototype.onNodeContextMenu = function (x, y, node) {
              // Iterate through spline widgets to find if the click was on a driven toggle
              for (const widget of this.layerManager.getSplineWidgets()) {
                  if (widget.hitAreas && widget.hitAreas.drivenToggle) {
                      const toggleBounds = widget.hitAreas.drivenToggle.bounds;

                      // Calculate absolute bounds of the toggle on the canvas
                      const widgetAbsX = node.pos[0];
                      const widgetAbsY = node.pos[1] + widget.last_y;

                      const toggleAbsXStart = widgetAbsX + toggleBounds[0];
                      const toggleAbsXEnd = toggleAbsXStart + toggleBounds[1];
                      const toggleAbsYStart = widgetAbsY;
                      const toggleAbsYEnd = widgetAbsY + LiteGraph.NODE_WIDGET_HEIGHT;

                      if (x >= toggleAbsXStart && x <= toggleAbsXEnd &&
                          y >= toggleAbsYStart && y <= toggleAbsYEnd) {

                          // Use the custom grid-based menu instead of LiteGraph's default menu
                          showCustomDrivenToggleMenu(null, widget, { x: x, y: y });
                          return false; // Prevent default context menu
                      }
                  }
              }

              // If no driven toggle was hit, call the original context menu handler
              return originalOnNodeContextMenu?.apply(this, arguments);
          };

          // Removed onMouseDown override for double-click rename

          chainCallback(this, "onDrawForeground", function(ctx) {
            if (!this.flags.collapsed) {
                drawDriverLines(ctx, this);
            }
          });

          chainCallback(this, "onConfigure", function (info) {
            if (!this.widgets || !this.updateNodeHeight) {
              return;
            }

            // Restore persisted max frames for box timelines from properties
            if (this.editor && this.properties?.box_max_frames) {
              const propMaxFrames = Number(this.properties.box_max_frames);
              if (!Number.isNaN(propMaxFrames) && propMaxFrames > 0) {
                this.editor._maxFrames = propMaxFrames;
                if (this.uuid) {
                  safeSetSessionItem(`spline-editor-maxframes-${this.uuid}`, String(propMaxFrames));
                }
              }
            }

            const savedSize = [this.size[0], this.size[1]];
            this.layerManager.recreateSplinesFromData(info.widgets_values);

            // Ensure coordWidget has a default value
            const coordWidget = this.widgets.find(w => w.name === "coordinates");
            if (coordWidget && !coordWidget.value) {
              coordWidget.value = "[]";
            }

            try {
              // Restore background image dimensions from properties if available
              // BUT only if user hasn't manually adjusted dimensions
              // Check sessionStorage first for more recent dimensions from the last session
              let dims = null;
              const sessionDims = sessionStorage.getItem(`spline-editor-dims-${this.uuid}`);
              if (sessionDims) {
                  dims = JSON.parse(sessionDims);
              } else if (this.properties && this.properties.bgImageDims && !this.properties.userAdjustedDims) {
                  dims = this.properties.bgImageDims;
              }

              // Apply dimensions if we found them and user hasn't manually adjusted
              if (dims && !this.properties.userAdjustedDims) {
                const widthWidget = this.widgets.find(w => w.name === "mask_width");
                const heightWidget = this.widgets.find(w => w.name === "mask_height");

                const userDimsJson = this.uuid ? sessionStorage.getItem(`spline-editor-user-dims-${this.uuid}`) : null;
                const hasUserDims = this.properties.userAdjustedDims || !!userDimsJson;
                if (!hasUserDims) {
                  const widgetDiffers = (
                    (widthWidget && dims && typeof widthWidget.value === 'number' && widthWidget.value !== dims.width) ||
                    (heightWidget && dims && typeof heightWidget.value === 'number' && heightWidget.value !== dims.height)
                  );
                  if (widgetDiffers) {
                    // Treat saved widget values as user preference; persist flag for this session
                    this.properties.userAdjustedDims = true;
                    try {
                      const stored = { width: Number(widthWidget ? widthWidget.value : dims.width), height: Number(heightWidget ? heightWidget.value : dims.height) };
                      if (this.uuid) sessionStorage.setItem(`spline-editor-user-dims-${this.uuid}`, JSON.stringify(stored));
                    } catch {}
                  } else {
                    if (widthWidget && widthWidget.value !== dims.width) {
                      widthWidget.value = dims.width;
                    }
                    if (heightWidget && heightWidget.value !== dims.height) {
                      heightWidget.value = dims.height;
                    }
                  }
                }
                else if (userDimsJson) {
                  try {
                    const userDims = JSON.parse(userDimsJson);
                    if (widthWidget && typeof userDims.width === 'number') widthWidget.value = userDims.width;
                    if (heightWidget && typeof userDims.height === 'number') heightWidget.value = userDims.height;
                  } catch {}
                }
                
                // Store the dimensions back to properties to ensure consistency
                if (!this.properties.userAdjustedDims) {
                    this.properties.bgImageDims = dims;
                }
              }

              // Now restore node size using size manager (with correct widget values)
              this.sizeManager.onConfigure(savedSize);

              // Update canvas dimensions if editor exists
              if (this.editor && this.editor.vis) {
                const userDimsJson2 = this.uuid ? sessionStorage.getItem(`spline-editor-user-dims-${this.uuid}`) : null;
                const hasUserDims2 = this.properties.userAdjustedDims || !!userDimsJson2;
                const canvasWidth = (dims && !hasUserDims2) ? dims.width : (this.properties.bgImageDims?.width || this.editor.widthWidget.value);
                const canvasHeight = (dims && !hasUserDims2) ? dims.height : (this.properties.bgImageDims?.height || this.editor.heightWidget.value);
                
                this.editor.width = canvasWidth;
                this.editor.height = canvasHeight;
                this.editor.vis.width(canvasWidth);
                this.editor.vis.height(canvasHeight);
                this.editor.vis.render();
                // Render all spline layers after canvas resize
                if (this.editor.layerRenderer) {
                  this.editor.layerRenderer.render();
                }
              }

              // Try to load image from session storage for persistence across reloads
              if (this.uuid) {
                const sessionImgData = sessionStorage.getItem(`spline-editor-img-${this.uuid}`);
                if (sessionImgData) {
                  this.imgData = JSON.parse(sessionImgData);
                } else if (this.properties.imgData) {
                  // Migrate from old property if it exists
                  this.imgData = this.properties.imgData;
                  delete this.properties.imgData;
                }
              }

              // Create the editor instance if it doesn't exist yet
              if (!this.editor) {
                 this.editor = new SplineEditor2(this);
              }
              // Ensure the background image is refreshed after configuration/editor creation
              if (this.editor && this.imgData) {
                   this.editor.refreshBackgroundImage();
              } else if (this.editor) {
                  // Get the bg_img value from the widget to determine which image to load
                  const bgImgWidget = this.widgets.find(w => w.name === "bg_img");
                  const bg_img = bgImgWidget ? bgImgWidget.value : "None";
                  
                  // If no image is loaded from session, load the appropriate background based on bg_img selection
                  // First check if we have saved dimensions to maintain proportions
                  let targetWidth, targetHeight;
                  const savedDims = sessionStorage.getItem(`spline-editor-dims-${this.uuid}`);
                  if (savedDims) {
                      const dims = JSON.parse(savedDims);
                      targetWidth = dims.width;
                      targetHeight = dims.height;
                  } else if (this.properties.bgImageDims) {
                      // Fallback to dimensions stored in properties
                      targetWidth = this.properties.bgImageDims.width;
                      targetHeight = this.properties.bgImageDims.height;
                  }
                  
                  // Determine which image to load based on the bg_img selection
                  if (bg_img === "None") {
                      // Try to load cached bg_image first, then fallback to default
                      loadCachedRefImageAsBase64().then(cachedImageUrl => {
                          if (cachedImageUrl) {
                              // Apply darkening effect to match onExecuted behavior
                              const img = new Image();
                              img.onload = () => {
                                const canvas = document.createElement('canvas');
                                canvas.width = img.width;
                                canvas.height = img.height;
                                const ctx = canvas.getContext('2d');

                                ctx.drawImage(img, 0, 0);
                                ctx.fillStyle = `rgba(0, 0, 0, 0.6)`; // Same opacity as in onExecuted
                                ctx.fillRect(0, 0, canvas.width, canvas.height);

                                // Convert the darkened image to data URL
                                const darkenedDataUrl = canvas.toDataURL('image/jpeg');
                                this.imgData = {
                                    name: 'bg_image.png',
                                    base64: darkenedDataUrl.split(',')[1],
                                    type: 'image/jpeg'
                                };
                                this.editor.refreshBackgroundImage();
                              };
                              img.onerror = () => {
                                // Fallback to loading default A.jpg if ref_image doesn't exist
                                const timestamp = Date.now();
                                const defaultImageUrl = new URL(`bg/A.jpg?t=${timestamp}`, import.meta.url).href;
                                this.loadBackgroundImageFromUrl(defaultImageUrl, 'A.jpg', targetWidth, targetHeight);
                              };
                              img.src = cachedImageUrl;
                          } else {
                              // Fallback to default A.jpg
                              const timestamp = Date.now();
                              const defaultImageUrl = new URL(`bg/A.jpg?t=${timestamp}`, import.meta.url).href;
                              this.loadBackgroundImageFromUrl(defaultImageUrl, 'A.jpg', targetWidth, targetHeight);
                          }
                      });
                  } else {
                      // Load the selected background image (A, B, or C) from the bg folder
                      const timestamp = Date.now();
                      const imageUrl = new URL(`bg/${bg_img}.jpg?t=${timestamp}`, import.meta.url).href;
                      
                      // Use the overlay function from image_overlay.js
                      loadCachedRefImageAsBase64().then(cachedImageUrl => {
                          if (cachedImageUrl) {
                              createImageOverlayForConfigure(
                                  cachedImageUrl,
                                  bg_img,
                                  imageUrl,
                                  this.loadBackgroundImageFromUrl.bind(this),
                                  () => {
                                      // After creating overlay, refresh the background image
                                      if (this.editor) {
                                          this.editor.refreshBackgroundImage();
                                      }
                                  },
                                  this.imgData
                              );
                          } else {
                              // If no cached ref image, fallback to loading the background image directly
                              this.loadBackgroundImageFromUrl(imageUrl, `${bg_img}.jpg`, targetWidth, targetHeight);
                          }
                      }).catch(error => {
                          console.error(`Error loading ref image for overlay with ${bg_img}.jpg:`, error);
                          // Fallback to loading the background image directly
                          this.loadBackgroundImageFromUrl(imageUrl, `${bg_img}.jpg`, targetWidth, targetHeight);
                      });
                  }
              }

              // After recreating splines, the first layer might not render correctly on refresh.
              // Force an update of the active layer to ensure it's drawn properly.
              if (this.editor) {
                const activeWidget = this.layerManager.getActiveWidget(); // Ensure active widget is set
                if (activeWidget) {
                    // Clear the active widget reference before setting it to avoid potential issues
                    this.layerManager.activeWidget = null; // Force a reset to trigger the update
                    this.layerManager.setActiveWidget(activeWidget); // Notify canvas to redraw the active layer
                }
              }
            } catch (error) {
              console.error("An error occurred while configuring the editor:", error);
            }
          });
          chainCallback(this, "onExecuted", function (message) {
            let ref_image = message["ref_image"];
            let coord_in = message["coord_in"];
            let ref_image_dims = message["ref_image_dims"];
            let bg_img = message["bg_img"] ? message["bg_img"][0] : "None"; // Get the bg_img value from the message

            // Store background image dimensions for reference (don't modify UI widget values)
            // BUT only if user hasn't manually adjusted dimensions
            if (ref_image_dims && Array.isArray(ref_image_dims) && ref_image_dims.length > 0) {
              const dims = ref_image_dims[0];
              if (dims.width && dims.height) {
                this.properties = this.properties || {};
                // Only update bgImageDims if user hasn't manually adjusted dimensions
                if (!this.properties.userAdjustedDims) {
                  this.properties.bgImageDims = { width: dims.width, height: dims.height };
                  
                  // Also save dimensions to sessionStorage for persistence across page refreshes
                  try {
                      safeSetSessionItem(`spline-editor-dims-${this.uuid}`, JSON.stringify({
                          width: dims.width,
                          height: dims.height
                      }));
                  } catch (e) {
                      console.error("Spline Editor: Could not save dimensions to session storage", e);
                  }
                } else {
                  console.log(`Skipped storing ref_image dimensions (user has manually adjusted dimensions)`);
                }
              }
            }

            const finishExecution = (imgData) => {
                if (imgData) {
                    this.imgData = imgData;
                    try {
                        const size = JSON.stringify(this.imgData).length;
                        if (size < 640 * 480) { // 1MB limit
                            safeSetSessionItem(`spline-editor-img-${this.uuid}`, JSON.stringify(this.imgData));
                        } else {
                            console.warn("Spline Editor: Image not saved to session storage because it is too large.", size);
                        }
                    } catch (e) {
                        console.error("Spline Editor: Could not save image to session storage", e);
                    }
                    // Clear old property if it exists to migrate old workflows
                    if (this.properties.imgData) {
                        delete this.properties.imgData;
                    }
                } else {
                }

                // Initialize editor if it doesn't exist yet
                if (!this.editor) {
                    this.editor = new SplineEditor2(this, false);
                }

                if (coord_in) {
                    const coord_in_str = Array.isArray(coord_in) ? coord_in.join('') : coord_in;
                    this.editor.drawPreviousSpline(coord_in_str);
                }

                if (this.editor && this.imgData) {
                    this.editor.refreshBackgroundImage();
                } else if (this.editor) {
                    this.editor.vis.render();
                }
            };





            // If a new background image is provided, cache it and then finish execution.
            if (ref_image) {
              // Cache the ref_image for future use
            saveRefImageToCache(ref_image, 'bg_image.png').then(success => {
                if (success) {
                  console.log('Ref image cached successfully for future use');
                } else {
                  console.warn('Failed to cache ref image');
                }
              });

              const timestamp = Date.now();
              const bgImageUrl = new URL(`bg/${bg_img}.jpg?t=${timestamp}`, import.meta.url).href;
              processBgImage(ref_image, bg_img, bgImageUrl, finishExecution);
            } else {
              // Otherwise, just run the rest of the logic with existing image data (if any).
              finishExecution(this.imgData);
            }
          }); // End onExecuted callback

          }); // End onNodeCreated callback

          // Override onContextMenu to handle driven toggle right-click
          const originalOnContextMenu = nodeType.prototype.onContextMenu;
          nodeType.prototype.onContextMenu = function (x, y, menu, node) {

              // Iterate through spline widgets to find if the click was on a driven toggle
              for (const widget of this.layerManager.getSplineWidgets()) {
                  if (widget.hitAreas && widget.hitAreas.drivenToggle) {
                      const drivenToggleBounds = widget.hitAreas.drivenToggle.bounds;

                      // Calculate absolute bounds of the toggle on the canvas
                      const widgetAbsX = this.pos[0];
                      const widgetAbsY = this.pos[1] + widget.last_y;

                      const toggleAbsXStart = widgetAbsX + drivenToggleBounds[0];
                      const toggleAbsXEnd = toggleAbsXStart + drivenToggleBounds[1];
                      const toggleAbsYStart = widgetAbsY;
                      const toggleAbsYEnd = widgetAbsY + LiteGraph.NODE_WIDGET_HEIGHT;

                      if (x >= toggleAbsXStart && x <= toggleAbsXEnd &&
                          y >= toggleAbsYStart && y <= toggleAbsYEnd) {

                          // Use the custom menu display function
                          showCustomDrivenToggleMenu(null, widget, { x: x, y: y });
                          return false; // Prevent default LiteGraph context menu
                      }
                  }
              }

              // If no driven toggle was hit, call the original context menu handler
              return originalOnContextMenu?.apply(this, arguments);
          };

          // Serialize all the spline widget values into the hidden 'coordinates' widget for the backend.
          const onSerialize = nodeType.prototype.onSerialize;
          nodeType.prototype.onSerialize = function(o) {
            const coordinatesWidget = this.widgets.find(w => w.name === "coordinates");
            if (coordinatesWidget) {
                const splineWidgets = this.widgets.filter(w =>
                    (w instanceof PowerSplineWidget) || (w instanceof HandDrawLayerWidget) || (w instanceof BoxLayerWidget));
                const values = splineWidgets.map(w => w.value);
                coordinatesWidget.value = JSON.stringify(values);
            }
            onSerialize?.apply(this, arguments);
          };

          // Add context menu methods for right-click on spline widgets
          nodeType.prototype.getSlotInPosition = getSlotInPosition;
          nodeType.prototype.getSlotMenuOptions = getSlotMenuOptions;

        }//node created
      } //before register
})//register
