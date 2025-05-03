import { app } from '../../../scripts/app.js';
import { makeUUID, loadScript, create_documentation_stylesheet, chainCallback, hideWidgetForGood, RgthreeBaseWidget, DimensionsWidget, PowerSplineWidget, PowerSplineHeaderWidget, NodeSizeManager } from './spline_utils.js';
import SplineEditor2 from './spline_canvas.js';
import { getSlotInPosition, getSlotMenuOptions, showCustomDrivenToggleMenu } from './context_menu.js';

loadScript('/kjweb_async/svg-path-properties.min.js').catch((e) => {
    console.log(e)
})
loadScript('/kjweb_async/protovis.min.js').catch((e) => {
  console.log(e)
})
create_documentation_stylesheet()

async function loadImageAsBase64(url) {
    try {
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
    } catch (e) {
        console.error(`Failed to load image from ${url}:`, e);
        return null;
    }
}

function darkenImage(imageData, opacity = 0.6) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');

            ctx.drawImage(img, 0, 0);
            ctx.fillStyle = `rgba(0, 0, 0, ${opacity})`;
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            resolve({
                base64: canvas.toDataURL(imageData.type).split(',')[1],
                type: imageData.type
            });
        };
        img.onerror = reject;
        img.src = `data:${imageData.type};base64,${imageData.base64}`;
    });
}

// =========================
// SPLINE LAYER MANAGER
// =========================
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
        widget.value.driven = false; // Start with driven off
        widget.value._drivenConfig = { driver: "", rotate: 0, smooth: 0.0 }; // Preserved config

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

        const buttonIndex = this.node.widgets.findIndex(w => w.name === "button_bar");
        if (buttonIndex !== -1) {
            this.node.widgets.splice(buttonIndex, 0, widget);
            widget.parent = this.node;
        } else {
            this.node.addCustomWidget(widget);
        }

        this.node.updateNodeHeight();
        this.setActiveWidget(widget);
        this.node.setDirtyCanvas(true, true);
        return widget;
    }

    removeSpline(widget) {
        const index = this.node.widgets.indexOf(widget);
        if (index > -1) {
            // Check if the widget being removed is the active widget
            if (this.activeWidget === widget) {
                this.activeWidget = null;
            }
            this.node.widgets.splice(index, 1);
            this.node.updateNodeHeight();
            // Trigger re-render of all layers
            if (this.node.editor && this.node.editor.layerRenderer) {
                this.node.editor.layerRenderer.render();
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
            const buttonIndex = this.node.widgets.findIndex(w => w.name === "button_bar");
            if (buttonIndex !== -1) {
                this.node.widgets.splice(buttonIndex, 0, newWidget);
                newWidget.parent = this.node;
            } else {
                this.node.addCustomWidget(newWidget);
            }
        }

        this.node.updateNodeHeight();
        this.setActiveWidget(newWidget);
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
                driven: widgetValue.driven || false,
                _drivenConfig: widgetValue._drivenConfig || (typeof widgetValue.driven === 'object' ? {...widgetValue.driven} : { driver: "", rotate: 0, smooth: 0.0 }),
                points_store: widgetValue.points_store || "[]",
                coordinates: widgetValue.coordinates || "[]"
            };

            const buttonIndex = this.node.widgets.findIndex(w => w.name === "button_bar");
            if (buttonIndex !== -1) {
                this.node.widgets.splice(buttonIndex, 0, widget);
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
                console.log(`User adjusted width to ${value}`);
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
                console.log(`User adjusted height to ${value}`);
              };
              hideWidgetForGood(this, heightWidget);
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

            // Hide interpolation, offset, repeat, driver_rotation, and driver_smooth widgets
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
            const driverSmoothWidget = this.widgets.find(w => w.name === "driver_smooth");
            if (driverSmoothWidget) {
              hideWidgetForGood(this, driverSmoothWidget);
              driverSmoothWidget.draw = () => {};
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

            // Add the custom DimensionsWidget (shared for all splines)
            this.addCustomWidget(new DimensionsWidget("dimensions_display"));

            this.splineEditor2 = this.addDOMWidget(nodeData.name, "SplineEditor2Widget", element, {
            serialize: false,
            hideOnZoom: false,
            });

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
              this.sizeManager.updateSize(true);
              if (this.size) {
                this.size[1] += 4; // Add some padding to the bottom of the node
              }
            };

            // Add header widget
            this.addCustomWidget(new PowerSplineHeaderWidget("spline_header"));

            // Create a container for the buttons
            const buttonContainer = document.createElement("div");
            buttonContainer.style.display = "flex";
            buttonContainer.style.alignItems = "center";
            buttonContainer.style.width = "100%";
            buttonContainer.style.padding = "2px 5px";
            buttonContainer.style.boxSizing = "border-box";

            // Create Add Spline button
            const addSplineButton = document.createElement("button");
            addSplineButton.textContent = "➕ Add Spline";
            addSplineButton.style.width = "70%";
            addSplineButton.style.padding = "2px";
            addSplineButton.style.marginRight = "5px"; // Space between buttons
            addSplineButton.onclick = () => {
                this.layerManager.addNewSpline();
            };

            // Create Duplicate button
            const duplicateButton = document.createElement("button");
            duplicateButton.textContent = "Duplicate";
            duplicateButton.style.width = "30%";
            duplicateButton.style.padding = "2px";
            duplicateButton.onclick = () => {
                const activeWidget = this.layerManager.getActiveWidget();
                if (activeWidget) {
                    this.layerManager.duplicateSpline(activeWidget);
                }
            };

            buttonContainer.appendChild(addSplineButton);
            buttonContainer.appendChild(duplicateButton);

            const buttonBarWidget = this.addDOMWidget("button_bar", "BUTTON_BAR", buttonContainer, {
                serialize: false,
                hideOnZoom: false,
            });
            buttonBarWidget.computeSize = function(width) {
                return [width, 26];
            }

            // Set initial node size
            this.updateNodeHeight();

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
              createMenuItem(1, "Background image"),
              createMenuItem(2, "Clear Image"),
              createMenuItem(3, "Remove all splines"),
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
            this.splineEditor2.parentEl.id = `spline-editor-${this.uuid}`
            element.appendChild(this.splineEditor2.parentEl);

            this.editor = new SplineEditor2(this);

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
                  console.log("Double-click detected at:", localPos);

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

                          console.log(`  Checking widget ${widget.value.name}: Y[${widgetYStart}, ${widgetYEnd}], X[${nameXStart}, ${nameXEnd}]`);

                          // Check if the click is within the name area bounds
                          if (relativeX >= nameXStart && relativeX <= nameXEnd &&
                              relativeY >= widgetYStart && relativeY <= widgetYEnd) {
                              console.log("  HIT! Opening rename dialog");
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

                  console.log("  No hit on any name area");
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
              // IMPORTANT: This must happen BEFORE sizeManager.onConfigure() so it uses correct widget values
              if (this.properties && this.properties.bgImageDims && !this.properties.userAdjustedDims) {
                const dims = this.properties.bgImageDims;
                const widthWidget = this.widgets.find(w => w.name === "mask_width");
                const heightWidget = this.widgets.find(w => w.name === "mask_height");

                if (widthWidget && widthWidget.value !== dims.width) {
                  widthWidget.value = dims.width;
                  console.log(`Restored mask_width from properties: ${dims.width}`);
                }
                if (heightWidget && heightWidget.value !== dims.height) {
                  heightWidget.value = dims.height;
                  console.log(`Restored mask_height from properties: ${dims.height}`);
                }
              }

              // Now restore node size using size manager (with correct widget values)
              this.sizeManager.onConfigure(savedSize);

              // Update canvas dimensions if editor exists
              if (this.editor && this.editor.vis) {
                this.editor.width = this.properties.bgImageDims?.width || this.editor.widthWidget.value;
                this.editor.height = this.properties.bgImageDims?.height || this.editor.heightWidget.value;
                this.editor.vis.width(this.editor.width);
                this.editor.vis.height(this.editor.height);
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
                  // If no image is loaded from session, load the default bg.jpg
                  const defaultImageUrl = new URL('bg.jpg', import.meta.url).href;
                  loadImageAsBase64(defaultImageUrl).then(dataUrl => {
                      if (dataUrl) {
                          this.imgData = {
                              name: 'bg.jpg',
                              base64: dataUrl.split(',')[1],
                              type: 'image/jpeg'
                          };
                          this.editor.refreshBackgroundImage();
                      }
                  });
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
            let bg_image = message["bg_image"];
            let coord_in = message["coord_in"];
            let bg_image_dims = message["bg_image_dims"];

            // Store background image dimensions for reference (don't modify UI widget values)
            // BUT only if user hasn't manually adjusted dimensions
            if (bg_image_dims && Array.isArray(bg_image_dims) && bg_image_dims.length > 0) {
              const dims = bg_image_dims[0];
              if (dims.width && dims.height) {
                this.properties = this.properties || {};
                // Only update bgImageDims if user hasn't manually adjusted dimensions
                if (!this.properties.userAdjustedDims) {
                  this.properties.bgImageDims = { width: dims.width, height: dims.height };
                  console.log(`Stored bg_image dimensions: ${dims.width}x${dims.height} (not modifying UI widgets)`);
                } else {
                  console.log(`Skipped storing bg_image dimensions (user has manually adjusted dimensions)`);
                }
              }
            }

            const finishExecution = (imgData) => {
                if (imgData) {
                    this.imgData = imgData;
                    try {
                        const size = JSON.stringify(this.imgData).length;
                        if (size < 504 * 480) { // 1MB limit
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
                }

                // Initialize editor if it doesn't exist yet
                if (!this.editor) {
                    this.editor = new SplineEditor2(this, false);
                }

                if (coord_in) {
                    const coord_in_str = Array.isArray(coord_in) ? coord_in.join('') : coord_in;
                    this.editor.drawPreviousSpline(coord_in_str);
                }

                // Refresh background image if we have image data
                if (this.editor && this.imgData) {
                    this.editor.refreshBackgroundImage();
                } else if (this.editor) {
                    // Even without an image, ensure the canvas is rendered with correct dimensions
                    this.editor.vis.render();
                }
            };

            // If a new background image is provided, darken it and then finish execution.
            if (bg_image) {
              const originalImgData = { name: "bg_image", base64: bg_image, type: 'image/png' };
              darkenImage(originalImgData, 0.6).then(darkenedImgData => {
                  finishExecution({ ...originalImgData, ...darkenedImgData });
              });
            } else {
              // Otherwise, just run the rest of the logic with existing image data (if any).
              finishExecution(this.imgData);
            }
          }); // End onExecuted callback

          }); // End onNodeCreated callback

          // Override onContextMenu to handle driven toggle right-click
          const originalOnContextMenu = nodeType.prototype.onContextMenu;
          nodeType.prototype.onContextMenu = function (x, y, menu, node) {
              console.log("onContextMenu called for PowerSplineEditor. Click at: (", x, ", ", y, ")");

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

                      console.log(`  Checking widget ${widget.value.name}: Node pos (${this.pos[0]}, ${this.pos[1]}), Widget last_y ${widget.last_y}`);
                      console.log(`  Driven Toggle Bounds (relative): [${drivenToggleBounds[0]}, ${drivenToggleBounds[1]}]`);
                      console.log(`  Driven Toggle Bounds (absolute): X [${toggleAbsXStart}, ${toggleAbsXEnd}], Y [${toggleAbsYStart}, ${toggleAbsYEnd}]`);

                      if (x >= toggleAbsXStart && x <= toggleAbsXEnd &&
                          y >= toggleAbsYStart && y <= toggleAbsYEnd) {
                          console.log("  HIT: Right-click detected on Driven Toggle for widget:", widget.value.name);

                          console.log("  Calling showCustomDrivenToggleMenu for widget:", widget.value.name);
                          // Use the custom menu display function
                          showCustomDrivenToggleMenu(null, widget, { x: x, y: y });
                          return false; // Prevent default LiteGraph context menu
                      }
                  }
              }

              console.log("  NO HIT on Driven Toggle. Calling original onContextMenu.");
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
