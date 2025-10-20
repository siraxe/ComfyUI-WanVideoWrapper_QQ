import { app } from "../../../scripts/app.js";
import { rgthree } from "../rgthree/common/rgthree.js";
import { rgthreeApi as wanvidApi } from "./rgthree_api.js";
import { RgthreeBetterButtonWidget, RgthreeDividerWidget, StrengthCopyWidget, PowerLoraLoaderHeaderWidget, PowerLoraLoaderWidget } from "./widgets.js";
import { LoraPickerDialog } from "./lora_picker_dialog.js";
import { getLoraSlotInPosition, getLoraSlotMenuOptions } from "./lora_context_menu.js";

let lorasCache = null;
// Clear cache to ensure new format is used
localStorage.removeItem("powerLoraLoaderV2.lorasCache");

const MINIMUM_NODE_WIDTH = 480;

async function getLoras(forceRefresh = false) {
    // Check if we have cached data in localStorage
    const cachedData = localStorage.getItem("powerLoraLoaderV2.lorasCache");
    if (cachedData && lorasCache && !forceRefresh) {
        return lorasCache;
    }
    
    // Clear cache if force refresh is requested
    if (forceRefresh) {
        lorasCache = null;
        localStorage.removeItem("powerLoraLoaderV2.lorasCache");
    }
    
    try {
        // Use rgthreeApi with forceRefresh parameter
        const lorasData = await wanvidApi.getLoras(forceRefresh);
        // Convert rgthreeApi format to our expected format
        lorasCache = lorasData.map(lora => {
            if (typeof lora === 'string') {
                return { name: lora, mtime: 0 };
            }
            return {
                name: lora.name || lora.filename || lora.file || JSON.stringify(lora),
                mtime: lora.mtime || lora.modified || lora.modified_time || 0
            };
        });
        
        // Cache the data in localStorage
        localStorage.setItem("powerLoraLoaderV2.lorasCache", JSON.stringify(lorasCache));
        
        return lorasCache;
    }
    catch (error) {
        console.error("Failed to fetch loras:", error);
        return [];
    }
}

// Functions to persist favorites
function saveFavorites(favorites) {
    localStorage.setItem("powerLoraLoaderV2.favorites", JSON.stringify(favorites));
}

function loadFavorites() {
    const favorites = localStorage.getItem("powerLoraLoaderV2.favorites");
    return favorites !== null ? JSON.parse(favorites) : [];
}

// Functions to persist UI state
function saveFoldersVisible(foldersVisible) {
    localStorage.setItem("powerLoraLoaderV2.foldersVisible", JSON.stringify(foldersVisible));
}

function loadFoldersVisible() {
    const foldersVisible = localStorage.getItem("powerLoraLoaderV2.foldersVisible");
    return foldersVisible !== null ? JSON.parse(foldersVisible) : false;
}

function saveSelectedFolder(selectedFolder) {
    localStorage.setItem("powerLoraLoaderV2.selectedFolder", JSON.stringify(selectedFolder));
}

function loadSelectedFolder() {
    const selectedFolder = localStorage.getItem("powerLoraLoaderV2.selectedFolder");
    return selectedFolder !== null ? JSON.parse(selectedFolder) : null;
}

function saveEyeRefreshState(eyeRefreshState) {
    localStorage.setItem("powerLoraLoaderV2.eyeRefreshState", JSON.stringify(eyeRefreshState));
}

function loadEyeRefreshState() {
    const eyeRefreshState = localStorage.getItem("powerLoraLoaderV2.eyeRefreshState");
    return eyeRefreshState !== null ? JSON.parse(eyeRefreshState) : false;
}

function showLoraPicker(event, callback, node = null) {
    getLoras().then(loras => {
        const savedFavorites = loadFavorites();

        // Load UI state from localStorage or node properties
        let foldersVisible = loadFoldersVisible();
        let eyeRefreshState = loadEyeRefreshState();
        let selectedFolder = loadSelectedFolder();

        if (node && node.widgets) {
            const uiStateWidget = node.widgets.find(w => w.name === "ui_state");
            if (uiStateWidget && uiStateWidget.value) {
                try {
                    const uiState = JSON.parse(uiStateWidget.value);
                    if (uiState.foldersVisible !== undefined) foldersVisible = uiState.foldersVisible;
                    if (uiState.eyeRefreshState !== undefined) eyeRefreshState = uiState.eyeRefreshState;
                    if (uiState.selectedFolder !== undefined) selectedFolder = uiState.selectedFolder;
                } catch (e) {
                    console.warn("[PowerLoraLoaderV2] Failed to parse UI state from widget:", e);
                }
            }
        }

        const dialog = new LoraPickerDialog(loras, {
            parentNode: node,
            callback: callback,
            sort: "Latest",
            favorites: savedFavorites,
            favoritesOnly: false,
            onFavoriteToggle: (loraName) => {
                const index = savedFavorites.indexOf(loraName);
                if (index !== -1) {
                    // Remove from favorites
                    savedFavorites.splice(index, 1);
                } else {
                    // Add to favorites
                    savedFavorites.push(loraName);
                }
                // Save to localStorage
                saveFavorites(savedFavorites);
                // Update dialog's favorites
                dialog.options.favorites = savedFavorites;
                // Re-render the list to update star colors
                dialog.renderList();
            },
            foldersVisible: foldersVisible,
            refreshCallback: () => {
                // Bulk refresh removed - refresh individual LoRAs through their dialogs instead
                console.log('[PowerLoraLoaderV2] Individual LoRA refresh available in LoRA info dialog');
            }
        });

        // Initialize dialog's UI state
        dialog.eyeRefreshState = eyeRefreshState;
        dialog.selectedFolder = selectedFolder;

        dialog.show();
    });
}

app.registerExtension({
    name: "WanVideo.PowerLoraLoaderV2",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "PowerLoraLoaderV2") {
            nodeType.prototype.lorasCache = [];

            nodeType.prototype.addCustomWidget = function(widget) {
                if (!this.widgets) {
                    this.widgets = [];
                }
                widget.parent = this;
                this.widgets.push(widget);
                return widget;
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                onNodeCreated?.apply(this, arguments);
                this.serialize_widgets = true;
                this.loraWidgetsCounter = 0;
                this.hasClip = false; // Initialize clip connection state
                this.properties = this.properties || {};
                this.properties['Show Strengths'] = "Single Strength";
                this.addNonLoraWidgets();
                
                
                // Ensure minimum size
                const computed = this.computeSize();
                this.size = this.size || [0, 0];
                this.size[0] = Math.max(MINIMUM_NODE_WIDTH, this.size[0], computed[0]);
                this.size[1] = Math.max(this.size[1], computed[1]);
            };

            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (info) {
                onConfigure?.apply(this, arguments);
                this.loraWidgetsCounter = 0;

                // Restore hasClip state if it exists
                if (info.hasClip !== undefined) {
                    this.hasClip = info.hasClip;
                }

                if (this.widgets) {
                    const widgets_to_remove = [...this.widgets];
                    for (const widget of widgets_to_remove) {
                        this.removeWidget(widget);
                    }
                }

                this.addNonLoraWidgets();

                if (info.widgets_values) {
                    for (const widgetValue of info.widgets_values) {
                        if (widgetValue && widgetValue.lora !== undefined) {
                            const widget = this.addNewLoraWidget();
                            widget.value = { ...widgetValue };
                        }
                    }
                }
                getLoras().then((loras) => {
                    this.lorasCache = loras;
                    for (const widget of this.widgets) {
                        if (widget.name?.startsWith("lora_")) {
                            widget.checkLowLoraVariant(widget.value.lora);
                        }
                    }
                });

                // Restore UI state from widget if it exists
                if (this.properties.uiState) {
                    const uiStateWidget = this.widgets.find(w => w.name === "ui_state");
                    if (uiStateWidget) {
                        uiStateWidget.value = this.properties.uiState;
                    }
                }
                // Also check if there's a ui_state value directly in the widget_values
                if (info.widgets_values) {
                    // Look for the ui_state value in the widgets_values
                    for (let i = 0; i < info.widgets_values.length; i++) {
                        const widgetValue = info.widgets_values[i];
                        if (widgetValue && typeof widgetValue === 'string') {
                            try {
                                const parsed = JSON.parse(widgetValue);
                                if (parsed && typeof parsed === 'object' && !parsed.lora) {
                                    // This looks like UI state data, update the widget
                                    const uiStateWidget = this.widgets.find(w => w.name === "ui_state");
                                    if (uiStateWidget) {
                                        uiStateWidget.value = widgetValue;
                                    }
                                    break;
                                }
                            } catch (e) {
                                // Not valid JSON, skip
                            }
                        }
                    }
                }
            };

            nodeType.prototype.addNewLoraWidget = function () {
                this.loraWidgetsCounter++;
                const widget = new PowerLoraLoaderWidget("lora_" + this.loraWidgetsCounter, showLoraPicker);
                this.addCustomWidget(widget);
                if (this.widgetButtonSpacer) {
                    const index = this.widgets.indexOf(this.widgetButtonSpacer);
                    this.widgets.splice(index, 0, this.widgets.pop());
                }
                return widget;
            };

            nodeType.prototype.addNonLoraWidgets = function () {
                // Only use StrengthCopyWidget for PowerLoraLoaderV2
                this.addCustomWidget(new StrengthCopyWidget());
                this.addCustomWidget(new RgthreeDividerWidget({ marginTop: 4, marginBottom: 0, thickness: 0 }));
                this.addCustomWidget(new PowerLoraLoaderHeaderWidget());
                this.widgetButtonSpacer = this.addCustomWidget(new RgthreeDividerWidget({ marginTop: 4, marginBottom: 0, thickness: 0 }));
                this.addCustomWidget(new RgthreeBetterButtonWidget("➕ Add Lora", (event, pos, node) => {
                    showLoraPicker(event, (lora) => {
                        if (lora) {
                            this.addNewLoraWidget().setLora(lora);
                        }
                    }, node);
                }));

                // Add hidden widget for UI state persistence
                const uiStateWidget = this.addWidget("string", "ui_state", "{}", () => {},
                    { serialize: true });
                uiStateWidget.type = "hidden";
                // Keep serialize: true to ensure UI state is saved in workflow JSON
            };

            nodeType.prototype.allLorasState = function() {
                let allOn = true;
                let allOff = true;
                for (const widget of this.widgets) {
                    if (widget.name?.startsWith("lora_")) {
                        const on = widget.value?.on;
                        allOn = allOn && on === true;
                        allOff = allOff && on === false;
                        if (!allOn && !allOff) {
                            return null;
                        }
                    }
                }
                return allOn ? true : (allOff ? false : null);
            };

            nodeType.prototype.toggleAllLoras = function() {
                const allOn = this.allLorasState();
                const toggledTo = !allOn;
                for (const widget of this.widgets) {
                    if (widget.name?.startsWith("lora_") && widget.value?.on != null) {
                        widget.value.on = toggledTo;
                    }
                }
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

            nodeType.prototype.getSlotInPosition = getLoraSlotInPosition;
            nodeType.prototype.getSlotMenuOptions = getLoraSlotMenuOptions;
            
            // Store clip connection state for Python code to check
            const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
            nodeType.prototype.onConnectionsChange = function(type, slotIndex, isConnected, link_info, ioSlot) {
                originalOnConnectionsChange?.apply(this, arguments);
                
                // Store the clip connection state
                if (type === LiteGraph.INPUT && slotIndex === 2) { // clip is at index 2
                    this.hasClip = isConnected;
                    this.setDirtyCanvas(true, true);
                }
            };
            
            // Override serialize to include hasClip state
            const originalOnSerialize = nodeType.prototype.serialize;
            nodeType.prototype.serialize = function() {
                const data = originalOnSerialize?.apply(this, arguments) || {};
                data.hasClip = this.hasClip;
                return data;
            };

            // Add onSerialize method to persist UI state
            const onSerialize = nodeType.prototype.onSerialize;
            nodeType.prototype.onSerialize = function(o) {
                onSerialize?.apply(this, arguments);

                let uiState = null;
                const uiStateWidget = this.widgets.find(w => w.name === "ui_state");

                if (uiStateWidget && uiStateWidget.value) {
                    try {
                        uiState = JSON.parse(uiStateWidget.value);
                    } catch (e) {
                        console.warn("[PowerLoraLoaderV2] Failed to parse existing widget value:", e);
                    }
                }

                if (!uiState) {
                    // Try to get from localStorage with correct keys for V2
                    const foldersVisible = localStorage.getItem("powerLoraLoaderV2.foldersVisible");
                    const eyeRefreshState = localStorage.getItem("powerLoraLoaderV2.eyeRefreshState");
                    const selectedFolder = localStorage.getItem("powerLoraLoaderV2.selectedFolder");

                    uiState = {
                        foldersVisible: foldersVisible ? JSON.parse(foldersVisible) : false,
                        eyeRefreshState: eyeRefreshState ? JSON.parse(eyeRefreshState) : false,
                        selectedFolder: selectedFolder ? JSON.parse(selectedFolder) : null,
                    };
                }

                this.properties.uiState = JSON.stringify(uiState);

                if (uiStateWidget) {
                    uiStateWidget.value = JSON.stringify(uiState);
                }
            };

            // Pre-load loras
            getLoras().then(loras => {
                nodeType.prototype.lorasCache = loras;
            });
            
            // Add refreshComboInNode method to handle R key press for reloading definitions
            nodeType.prototype.refreshComboInNode = function(defs) {
                // Use wanvidApi to refresh the LoRA list
                // Bulk refresh removed - just clear cache and refresh list
                lorasCache = null;
                localStorage.removeItem("powerLoraLoaderV2.lorasCache");

                                  // Fetch fresh loras and update cache
                getLoras(true).then((lorasDetails) => {
                    nodeType.prototype.lorasCache = lorasDetails;

                    // Update all nodes of this type
                    app.graph._nodes.forEach(node => {
                        if (node.type === "PowerLoraLoaderV2") {
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
                                            console.log(`[PowerLoraLoaderV2] Low variant status changed for '${widget.value.lora}': ` +
                                                      `${oldIsLow} -> ${widget.value.is_low}, ` +
                                                      `variant: '${oldVariantName}' -> '${widget.value.low_variant_name}'`);
                                        }
                                    }

                                    // Trigger a value change to update the UI
                                    widget.callback(widget.value);
                                }
                            }

                            // Trigger a redraw to update the green low icons
                            node.setDirtyCanvas(true, true);
                        }
                    });

                    console.log('[PowerLoraLoaderV2] LoRA definitions refreshed - individual LoRA info available in dialogs');
                }).catch(error => {
                    console.error('[PowerLoraLoaderV2] Error refreshing LoRA list:', error);
                });
            };
        }
    },
});