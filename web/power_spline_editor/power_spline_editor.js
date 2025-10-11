import { app } from '../../../scripts/app.js';
import { makeUUID, loadScript, create_documentation_stylesheet, RgthreeBaseWidget, DimensionsWidget, TopRowWidget, PowerSplineWidget, PowerSplineHeaderWidget, NodeSizeManager, drawWidgetButton } from './spline_utils.js';
import { chainCallback, hideWidgetForGood } from './widget_utils.js';
import SplineEditor2 from './spline_canvas.js';
import { getSlotInPosition, getSlotMenuOptions, showCustomDrivenToggleMenu } from './context_menu.js';
import { drawDriverLines } from './driver_line_renderer.js';
import { darkenImage, scaleImageToRefDimensions, processBgImage, createImageOverlayForConfigure } from './image_overlay.js';
import { getReferenceImageFromConnectedNode } from './graph_query.js';

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

// Function to save ref_image to bg folder as ref_image.jpg
async function saveRefImageToCache(base64Data) {
    try {
        // Create a cache key to track the current ref_image
        const currentHash = await simpleHash(base64Data);
        sessionStorage.setItem('spline-editor-ref-image-hash', currentHash);
        
        // Try to save the file to the bg folder via the backend API
        try {
            const formData = new FormData();
            formData.append('image', `data:image/png;base64,${base64Data}`);
            
            const response = await fetch('/wanvideowrapper_qq/save_ref_image', {
                method: 'POST',
                body: formData
            });
            
            if (response.ok) {
                const result = await response.json();
                if (result.success) {
                 
                    // Save to sessionStorage as backup
                    sessionStorage.setItem('spline-editor-cached-ref-image', JSON.stringify({
                        base64: base64Data,
                        type: 'image/png',
                        name: 'ref_image.jpg',
                        hash: currentHash,
                        timestamp: Date.now()
                    }));
                    
                    return true;
                } else {
                    console.error('Backend error saving ref image:', result.error);
                    // Fallback to sessionStorage only
                    sessionStorage.setItem('spline-editor-cached-ref-image', JSON.stringify({
                        base64: base64Data,
                        type: 'image/png',
                        name: 'ref_image.jpg',
                        hash: currentHash,
                        timestamp: Date.now()
                    }));
                    return false;
                }
            } else {
                console.error('Failed to save ref image via API:', response.status);
                // Fallback to sessionStorage only
                sessionStorage.setItem('spline-editor-cached-ref-image', JSON.stringify({
                    base64: base64Data,
                    type: 'image/png',
                    name: 'ref_image.jpg',
                    hash: currentHash,
                    timestamp: Date.now()
                }));
                return false;
            }
        } catch (error) {
            console.warn('API save failed, using sessionStorage fallback:', error);
            
            // Fallback to sessionStorage if API fails
            sessionStorage.setItem('spline-editor-cached-ref-image', JSON.stringify({
                base64: base64Data,
                type: 'image/png',
                name: 'ref_image.jpg',
                hash: currentHash,
                timestamp: Date.now()
            }));
            
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
        
        // If current base64 is provided, check if it's different from cached
        if (currentBase64) {
            const currentHash = await simpleHash(currentBase64);
            if (currentHash === parsed.hash) {
                // Same image, no need to update
                return parsed;
            } else {
                // Different image, update cache
                await saveRefImageToCache(currentBase64);
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
        const refImageUrl = new URL(`bg/ref_image.jpg?t=${timestamp}`, import.meta.url).href;
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
    }

    setActiveWidget(widget) {
        if (this.activeWidget === widget) return;
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
        return this.node.widgets.filter(w => w instanceof PowerSplineWidget);
    }

    addNewSpline(name) {
        this.node.splineWidgetsCounter++;
        const widget = new PowerSplineWidget("spline_" + this.node.splineWidgetsCounter);

        const baseName = name || `Spline ${this.node.splineWidgetsCounter}`;
        const existingNames = this.getSplineWidgets().map(w => w.value.name);
        widget.value.name = this.node.generateUniqueName(baseName, existingNames);
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
        // This ensures order: canvas → button_bar → header → splines
        const headerIndex = this.node.widgets.findIndex(w => w.name === "spline_header");
        if (headerIndex !== -1) {
            // Find the last spline widget after the header
            let insertIndex = headerIndex + 1;
            for (let i = headerIndex + 1; i < this.node.widgets.length; i++) {
                if (this.node.widgets[i] instanceof PowerSplineWidget) {
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

    removeSpline(widget) {
        const index = this.node.widgets.indexOf(widget);
        if (index > -1) {
            // Get all spline widgets before removal
            const allSplines = this.getSplineWidgets();

            // Check if the widget being removed is the active widget
            if (this.activeWidget === widget) {
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

                // Set the new active widget
                this.activeWidget = newActiveWidget;

                // Notify the editor to sync its state (points, interpolation, etc.)
                if (this.node.editor && this.activeWidget) {
                    this.node.editor.onActiveLayerChanged();
                } else if (this.node.editor && !this.activeWidget) {
                    // No splines left - clear the editor's points
                    this.node.editor.points = [];
                    if (this.node.editor.layerRenderer) {
                        this.node.editor.layerRenderer.render();
                    }
                }
            }

            // Now remove the widget
            this.node.widgets.splice(index, 1);
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
    }

    duplicateSpline(sourceWidget) {
        if (!sourceWidget) return;

        this.node.splineWidgetsCounter++;
        const newWidget = new PowerSplineWidget("spline_" + this.node.splineWidgetsCounter);

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
                    if (this.node.widgets[i] instanceof PowerSplineWidget) {
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
        this.node.widgets = this.node.widgets.filter(w => !(w instanceof PowerSplineWidget));

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
            const widget = new PowerSplineWidget("spline_" + this.node.splineWidgetsCounter);

            // Explicitly assign each field to ensure complete isolation
            // No spread operators that might share references
            widget.value = {
                on: widgetValue.on !== undefined ? widgetValue.on : true,
                name: widgetValue.name,
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

            // Insert spline widgets AFTER the header (same as addNewSpline logic)
            const headerIndex = this.node.widgets.findIndex(w => w.name === "spline_header");
            if (headerIndex !== -1) {
                // Find the last spline widget after the header
                let insertIndex = headerIndex + 1;
                for (let i = headerIndex + 1; i < this.node.widgets.length; i++) {
                    if (this.node.widgets[i] instanceof PowerSplineWidget) {
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
              return this.widgets && this.widgets.some(w => w instanceof PowerSplineWidget);
            };

            this.allSplinesState = function() {
              const splineWidgets = this.widgets.filter(w => w instanceof PowerSplineWidget);
              if (!splineWidgets.length) return false;
              return splineWidgets.every(w => w.value.on);
            };

            this.toggleAllSplines = function() {
              const splineWidgets = this.widgets.filter(w => w instanceof PowerSplineWidget);
              const newState = !this.allSplinesState();
              splineWidgets.forEach(w => w.value.on = newState);
              this.setDirtyCanvas(true, true);
            };

            this.updateNodeHeight = function() {
              // Size manager now handles all spacing internally - no need to add extra padding
              this.sizeManager.updateSize(true);
            };

            // Try to update reference image from connected node when node is first created
            // This ensures we get the latest connected image instead of falling back to cached/default
            setTimeout(() => {
                if (this.widgets && this.widgets.find(w => w.name === "ref_image")) {
                    this.updateReferenceImageFromConnectedNode();
                }
            }, 100); // Small delay to ensure everything is initialized

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
                                
                                // Update the widget values to match the new dimensions
                                const widthWidget = this.widgets.find(w => w.name === "mask_width");
                                const heightWidget = this.widgets.find(w => w.name === "mask_height");
                                
                                if (widthWidget) widthWidget.value = targetWidth;
                                if (heightWidget) heightWidget.value = targetHeight;
                                
                                // Update editor dimensions
                                if (this.editor) {
                                    this.editor.width = targetWidth;
                                    this.editor.height = targetHeight;
                                    if (this.editor.vis) {
                                        this.editor.vis.width(targetWidth);
                                        this.editor.vis.height(targetHeight);
                                        this.editor.vis.render();
                                    }
                                    
                                    // Normalize the spline points to the new dimensions if there are any splines
                                    const splineWidgets = this.widgets.filter(w => w instanceof PowerSplineWidget);
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
                                name: 'ref_image.jpg',
                                base64: darkenedDataUrl.split(',')[1],
                                type: 'image/jpeg'
                            };
                            this.editor.refreshBackgroundImage();
                        };
                        img.onerror = () => {
                            // Fallback: try to load cached ref_image first, then default A.jpg
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
                                            name: 'ref_image.jpg',
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
                                    // Final fallback to A.jpg
                                    const timestamp = Date.now();
                                    const defaultImageUrl = new URL(`bg/A.jpg?t=${timestamp}`, import.meta.url).href;
                                    this.loadBackgroundImageFromUrl(defaultImageUrl, 'A.jpg', targetWidth, targetHeight);
                                }
                            });
                        };
                        // Use the original ref image data to create a data URL
                        img.src = `data:image/jpeg;base64,${this.originalRefImageData.base64}`;
                    } else {
                        // If no original ref image data, try to load cached ref_image first, then fallback to default
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
                                        name: 'ref_image.jpg',
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
                    // Get reference image from connected node
                    const base64Image = await getReferenceImageFromConnectedNode(this);
                    if (!base64Image) {
                        console.warn('Could not retrieve reference image from connected node');
                        // Optionally show a message to the user
                        alert('Could not retrieve reference image from connected node. Make sure an image node is connected to the ref_image input.');
                        return;
                    }

                    console.log('Successfully retrieved reference image from connected node, updating...');
                    
                    // Store the original reference image separately to use as base for overlays
                    this.originalRefImageData = {
                        name: 'ref_image_from_connection.jpg',
                        base64: base64Image.split(',')[1], // Extract base64 part
                        type: 'image/jpeg' // Default to jpeg, might need adjustment
                    };

                    // Cache the ref image for future use
                    await saveRefImageToCache(this.originalRefImageData.base64);
                    
                    // Clear session storage cache for this node's image to force refresh
                    if (this.uuid) {
                        sessionStorage.removeItem(`spline-editor-img-${this.uuid}`);
                    }
                    
                    // Get current bg_img selection to update background accordingly
                    const bgImgWidget = this.widgets.find(w => w.name === "bg_img");
                    const bg_img = bgImgWidget ? bgImgWidget.value : "None";
                    
                    // Update background based on current bg_img selection
                    this.updateBackgroundImage(bg_img);
                    
                    // Additionally, force refresh the editor's background image directly
                    if (this.editor && this.editor.refreshBackgroundImage) {
                        this.editor.refreshBackgroundImage();
                    }
                    
                    console.log('Reference image updated successfully from connected node');
                } catch (error) {
                    console.error('Error updating reference image from connected node:', error);
                    alert('Error updating reference image: ' + error.message);
                }
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
              createMenuItem(1, "Delete spline"),
              createMenuItem(2, "Background image"),
              createMenuItem(3, "Clear Image"),
              createMenuItem(4, "Delete all splines"),
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
                // If no image is loaded from session, first try to load cached ref_image, then fallback to A.jpg
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

                // Try to load cached ref_image first
                loadCachedRefImageAsBase64().then(cachedImageUrl => {
                    if (cachedImageUrl) {
                        this.loadBackgroundImageFromUrl(cachedImageUrl, 'ref_image.jpg', targetWidth, targetHeight);
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
            buttonBarWidget.duplicateMouseDown = false;

            buttonBarWidget.computeSize = function(width) {
                return [width, LiteGraph.NODE_WIDGET_HEIGHT];
            };

            buttonBarWidget.draw = function(ctx, node, width, posY, height) {
                const margin = 15;
                const gap = 5;
                const addSplineWidth = (width - margin * 2 - gap) * 0.70;
                const duplicateWidth = (width - margin * 2 - gap) * 0.30;

                // Draw Add Spline button (70% width)
                drawWidgetButton(
                    ctx,
                    { size: [addSplineWidth, height], pos: [margin, posY] },
                    "➕ Add Spline",
                    this.addSplineMouseDown
                );

                // Draw Duplicate button (30% width)
                drawWidgetButton(
                    ctx,
                    { size: [duplicateWidth, height], pos: [margin + addSplineWidth + gap, posY] },
                    "Duplicate",
                    this.duplicateMouseDown
                );
            };

            buttonBarWidget.mouse = function(event, pos, node) {
                if (event.type === "pointerdown" || event.type === "mousedown") {
                    const margin = 15;
                    const gap = 5;
                    const width = node.size[0];
                    const addSplineWidth = (width - margin * 2 - gap) * 0.70;
                    const duplicateWidth = (width - margin * 2 - gap) * 0.30;

                    // Check if click is on Add Spline button
                    if (pos[0] >= margin && pos[0] <= margin + addSplineWidth) {
                        this.addSplineMouseDown = true;
                        node.setDirtyCanvas(true, false);
                        return true;
                    }
                    // Check if click is on Duplicate button
                    else if (pos[0] >= margin + addSplineWidth + gap &&
                             pos[0] <= margin + addSplineWidth + gap + duplicateWidth) {
                        this.duplicateMouseDown = true;
                        node.setDirtyCanvas(true, false);
                        return true;
                    }
                }
                else if (event.type === "pointerup" || event.type === "mouseup") {
                    const margin = 15;
                    const gap = 5;
                    const width = node.size[0];
                    const addSplineWidth = (width - margin * 2 - gap) * 0.70;
                    const duplicateWidth = (width - margin * 2 - gap) * 0.30;

                    // Handle Add Spline button click
                    if (this.addSplineMouseDown && pos[0] >= margin && pos[0] <= margin + addSplineWidth) {
                        node.layerManager.addNewSpline();
                    }
                    // Handle Duplicate button click
                    else if (this.duplicateMouseDown &&
                             pos[0] >= margin + addSplineWidth + gap &&
                             pos[0] <= margin + addSplineWidth + gap + duplicateWidth) {
                        const activeWidget = node.layerManager.getActiveWidget();
                        if (activeWidget) {
                            node.layerManager.duplicateSpline(activeWidget);
                        }
                    }

                    this.addSplineMouseDown = false;
                    this.duplicateMouseDown = false;
                    node.setDirtyCanvas(true, false);
                    return true;
                }
                return false;
            };

            this.addCustomWidget(buttonBarWidget);

            // Add header widget AFTER button bar
            this.addCustomWidget(new PowerSplineHeaderWidget("spline_header"));

            // Initialize double-click tracking for layer rename
            this.lastClickTime = 0;
            this.lastClickPos = null;
            this.doubleClickDelay = 300; // ms

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

          // Override onMouseDown to detect double-clicks on layer names
          const originalOnMouseDown = nodeType.prototype.onMouseDown;
          nodeType.prototype.onMouseDown = function (e, localPos, graphcanvas) {
              const currentTime = Date.now();
              const timeSinceLastClick = currentTime - this.lastClickTime;

              // Check if this is a double-click (within delay and similar position)
              let isDoubleClick = false;
              if (timeSinceLastClick < this.doubleClickDelay && this.lastClickPos) {
                  const dx = Math.abs(localPos[0] - this.lastClickPos[0]);
                  const dy = Math.abs(localPos[1] - this.lastClickPos[1]);
                  isDoubleClick = (dx < 5 && dy < 5); // Within 5 pixel tolerance
              }

              if (isDoubleClick) {
                  // Check if double-click was on a name area
                  const relativeX = localPos[0];
                  const relativeY = localPos[1];

                  for (const widget of this.layerManager.getSplineWidgets()) {
                      if (widget.hitAreas && widget.hitAreas.name) {
                          const nameBounds = widget.hitAreas.name.bounds;

                          // widget.last_y is the Y position of the widget relative to the node
                          const widgetYStart = widget.last_y;
                          const widgetYEnd = widgetYStart + LiteGraph.NODE_WIDGET_HEIGHT;

                          // nameBounds format: [x, width] or [x, y, width, height]
                          const nameXStart = nameBounds[0];
                          const nameXEnd = nameXStart + (nameBounds.length > 2 ? nameBounds[2] : nameBounds[1]);

                          // Check if the click is within the name area bounds
                          if (relativeX >= nameXStart && relativeX <= nameXEnd &&
                              relativeY >= widgetYStart && relativeY <= widgetYEnd) {
                              // Double-click detected on name area - show rename prompt
                              const canvas = app.canvas;
                              canvas.prompt("Spline Name", widget.value.name || "Spline", (v) => {
                                  widget.value.name = v || "Spline";
                                  this.setDirtyCanvas(true, true);
                              });

                              // Reset click tracking to prevent triple-click
                              this.lastClickTime = 0;
                              this.lastClickPos = null;
                              return true; // Handled, prevent default
                          }
                      }
                  }

                  // Reset for next potential double-click
                  this.lastClickTime = 0;
                  this.lastClickPos = null;
              } else {
                  // Store this click for potential double-click detection
                  this.lastClickTime = currentTime;
                  this.lastClickPos = [localPos[0], localPos[1]];
              }

              // Call original handler
              return originalOnMouseDown?.apply(this, arguments);
          };

          chainCallback(this, "onDrawForeground", function(ctx) {
            if (!this.flags.collapsed) {
                drawDriverLines(ctx, this);
            }
          });

          chainCallback(this, "onConfigure", function (info) {
            if (!this.widgets || !this.updateNodeHeight) {
              return;
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

                if (widthWidget && widthWidget.value !== dims.width) {
                  widthWidget.value = dims.width;
                }
                if (heightWidget && heightWidget.value !== dims.height) {
                  heightWidget.value = dims.height;
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
                const canvasWidth = (dims && !this.properties.userAdjustedDims) ? dims.width : (this.properties.bgImageDims?.width || this.editor.widthWidget.value);
                const canvasHeight = (dims && !this.properties.userAdjustedDims) ? dims.height : (this.properties.bgImageDims?.height || this.editor.heightWidget.value);
                
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
                      // Try to load cached ref_image first, then fallback to default
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
                                    name: 'ref_image.jpg',
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
                      sessionStorage.setItem(`spline-editor-dims-${this.uuid}`, JSON.stringify({
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
                        if (size < 600 * 480) { // 1MB limit
                            sessionStorage.setItem(`spline-editor-img-${this.uuid}`, JSON.stringify(this.imgData));
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
              saveRefImageToCache(ref_image).then(success => {
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
                const splineWidgets = this.widgets.filter(w => w instanceof PowerSplineWidget);
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
