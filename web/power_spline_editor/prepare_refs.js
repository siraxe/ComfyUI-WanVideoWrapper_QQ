import { app } from '../../../scripts/app.js';
import { makeUUID, NodeSizeManager, TopRowWidget } from './spline_utils.js';
import { chainCallback, hideWidgetForGood } from './general_utils.js';
import { getReferenceImageFromConnectedNode } from './graph_query.js';
import { RefLayerWidget } from './layer_type_ref.js';
import { attachLassoHelpers } from './canvas_lasso.js';
import RefCanvas from './canvas_main_ref.js';

app.registerExtension({
  name: 'WanVideoWrapper_QQ.PrepareRefs',

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== 'PrepareRefs') return;

    chainCallback(nodeType.prototype, 'onNodeCreated', function () {
      this.serialize_widgets = true;
      this.resizable = false;
      this.properties = this.properties || {};
      this.properties.userAdjustedDims = this.properties.userAdjustedDims || false;

      const widthWidget = this.widgets.find((w) => w.name === 'mask_width');
      const heightWidget = this.widgets.find((w) => w.name === 'mask_height');

      const setUserAdjusted = () => {
        this.properties.userAdjustedDims = true;
      };

      if (!this.addCustomWidget) {
        this.addCustomWidget = function (widget) {
          widget.parent = this;
          this.widgets = this.widgets || [];
          this.widgets.push(widget);
          const originalMouse = widget.mouse;
          widget.mouse = function (event, pos, node) {
            const localPos = [pos[0], pos[1] - (widget.last_y || 0)];
            return originalMouse?.call(this, event, localPos, node);
          };
          return widget;
        };
      }

      if (widthWidget) {
        const original = widthWidget.callback;
        widthWidget.callback = (value) => {
          original?.call(widthWidget, value);
          setUserAdjusted();
          this.updateCanvasSizeFromWidgets?.();
          return value;
        };
        hideWidgetForGood(this, widthWidget);
      }

      if (heightWidget) {
        const original = heightWidget.callback;
        heightWidget.callback = (value) => {
          original?.call(heightWidget, value);
          setUserAdjusted();
          this.updateCanvasSizeFromWidgets?.();
          return value;
        };
        hideWidgetForGood(this, heightWidget);
      }

      this.sizeManager = new NodeSizeManager(this, {
        spacingAfterCanvas: 36,
        canvasWidth: widthWidget ? widthWidget.value : 640,
        canvasHeight: heightWidget ? heightWidget.value : 480,
        minNodeWidth: 640,
        minNodeHeight: 480,
      });

      this.onResize = function (size) {
      const constrained = this.sizeManager.onNodeResized(size);
      size[0] = constrained[0];
      size[1] = constrained[1];
    };

      // Reuse the existing top row widget (refresh + width/height controls)
      const topRow = new TopRowWidget('prepare_refs_top_row', {
        refreshCanvasButton: true,
        refreshFramesButton: false,
        bgImgControl: false,
        animToggleButton: false,
      });
      this.addCustomWidget(topRow);

      const container = document.createElement('div');
      this.uuid = this.uuid || makeUUID();
      container.id = `prepare-refs-${this.uuid}`;
      container.style.margin = '0';
      container.style.padding = '0';
      container.style.display = 'flex';
      container.style.flexDirection = 'column';
      container.style.gap = '0px';

      // Two-column layout: sidebar + canvas
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.flexDirection = 'row';
      row.style.flexWrap = 'nowrap';
      row.style.gap = '8px';
      row.style.alignItems = 'stretch';
      container.appendChild(row);

      const sidebar = document.createElement('div');
      sidebar.style.width = '120px';
      sidebar.style.minWidth = '120px';
      sidebar.style.maxWidth = '120px';
      sidebar.style.flex = '0 0 120px';
      sidebar.style.display = 'flex';
      sidebar.style.flexDirection = 'column';
      sidebar.style.alignItems = 'stretch';
      sidebar.style.justifyContent = 'flex-start';
      sidebar.style.gap = '8px';
      sidebar.style.padding = '8px';
      sidebar.style.color = '#b5b5b5';
      sidebar.style.fontSize = '12px';
      sidebar.style.border = '1px solid #3a3a3a';
      sidebar.style.background = 'transparent';
      sidebar.style.overflow = 'hidden';
      sidebar.style.boxSizing = 'border-box';

      const addRefBtn = document.createElement('button');
      addRefBtn.textContent = '+ Add ref';
      addRefBtn.style.cursor = 'pointer';
      addRefBtn.style.padding = '8px 12px';
      addRefBtn.style.border = '0.75px solid #00000044';
      addRefBtn.style.background = '#1e1e1e';
      addRefBtn.style.color = '#ddd';
      addRefBtn.style.borderRadius = '4px';
      addRefBtn.style.fontSize = '12px';
      addRefBtn.style.fontWeight = '500';
      addRefBtn.style.textAlign = 'center';
      addRefBtn.style.position = 'relative';
      addRefBtn.style.boxShadow = '0 1px 0 #000000aa, inset 0 0.75px 0 #ffffff22, inset 0.75px 0 0 #ffffff11, inset -0.75px 0 0 #00000044';
      addRefBtn.style.transition = 'all 0.05s ease';
      addRefBtn.onmousedown = () => {
        addRefBtn.style.background = '#444';
        addRefBtn.style.transform = 'translateY(1px)';
        addRefBtn.style.boxShadow = 'inset 0 0.75px 0 #00000088';
        addRefBtn.style.border = '0.75px solid #00000088';
      };
      addRefBtn.onmouseup = () => {
        addRefBtn.style.background = '#1e1e1e';
        addRefBtn.style.transform = 'translateY(0)';
        addRefBtn.style.boxShadow = '0 1px 0 #000000aa, inset 0 0.75px 0 #ffffff22, inset 0.75px 0 0 #ffffff11, inset -0.75px 0 0 #00000044';
        addRefBtn.style.border = '0.75px solid #00000044';
      };
      addRefBtn.onmouseleave = () => {
        addRefBtn.style.background = '#1e1e1e';
        addRefBtn.style.transform = 'translateY(0)';
        addRefBtn.style.boxShadow = '0 1px 0 #000000aa, inset 0 0.75px 0 #ffffff22, inset 0.75px 0 0 #ffffff11, inset -0.75px 0 0 #00000044';
        addRefBtn.style.border = '0.75px solid #00000044';
      };
      addRefBtn.onclick = () => this.addRefLayer?.();
      sidebar.appendChild(addRefBtn);

      // Container for ref layers
      const refLayersContainer = document.createElement('div');
      refLayersContainer.style.display = 'flex';
      refLayersContainer.style.flexDirection = 'column';
      refLayersContainer.style.gap = '4px';
      refLayersContainer.style.marginTop = '4px';
      refLayersContainer.style.overflowY = 'auto';
      refLayersContainer.style.flex = '1';
      sidebar.appendChild(refLayersContainer);

      // Initialize ref layer management
      this.refLayers = [];
      this.refLayerCount = 0;
      this.refLayersContainer = refLayersContainer;
      this.sidebar = sidebar;
      this.selectedRefLayer = null;

      row.appendChild(sidebar);

      const canvasWrap = document.createElement('div');
      canvasWrap.style.flex = '1 1 0';
      canvasWrap.style.minWidth = '0';
      canvasWrap.style.display = 'flex';
      canvasWrap.style.alignItems = 'center';
      canvasWrap.style.justifyContent = 'center';
      canvasWrap.style.paddingTop = '0';
      canvasWrap.style.overflow = 'hidden';
      canvasWrap.style.boxSizing = 'border-box';
      row.appendChild(canvasWrap);

      const canvas = document.createElement('canvas');
      canvas.style.borderRadius = '0px';
      canvas.style.background = '#222';
      canvas.style.border = '1px solid gray';
      canvas.style.boxShadow = 'none';
      canvas.style.display = 'block';
      canvas.style.maxWidth = '100%';
      canvas.style.maxHeight = '100%';
      canvas.style.width = 'auto';
      canvas.style.height = 'auto';
      canvasWrap.appendChild(canvas);

      this.refsCanvas = canvas;
      this.canvasWrap = canvasWrap;

      // Initialize RefCanvas (uses PowerSplineEditor coordinate system)
      this.refCanvasEditor = new RefCanvas(canvas, this);

      // Attach lasso drawing helpers
      attachLassoHelpers(this);

      this.refreshCanvas = () => {
        if (!this.refCanvasEditor) return;

        // Render the canvas (background + grid)
        this.refCanvasEditor.render();

        // Add border
        const ctx = this.refsCanvas.getContext('2d');
        const { width, height } = this.refsCanvas;
        ctx.strokeStyle = 'gray';
        ctx.lineWidth = 1;
        ctx.strokeRect(0, 0, width, height);

        // Draw placeholder if no bg_image
        if (!this.refCanvasEditor.backgroundImage) {
          ctx.fillStyle = '#787878';
          ctx.font = '12px sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText('PrepareRefs canvas', 12 + 8, 18 + 8);
        }

        // Render lasso shapes for each layer using refCanvasEditor's coordinate system
        if (this.refLayers && this.renderLayerLassoShapes) {
          this.refLayers.forEach(refLayer => {
            if (refLayer.value.lassoShape) {
              // Show green only for selected layer, gray for others
              const isSelected = this.selectedRefLayer === refLayer;
              this.renderLayerLassoShapes(ctx, refLayer.value.lassoShape, width, height, isSelected, this.refCanvasEditor);
            }
          });
        }

        // Render preview if currently drawing
        if (this.renderLassoPreview) {
          this.renderLassoPreview();
        }
      };

      this.setDimensionValue = (widgetName, value) => {
        const widget = this.widgets.find((w) => w.name === widgetName);
        if (!widget) return;
        const clamp =
          widgetName === 'mask_width'
            ? this.sizeManager?.constrainCanvasWidth?.bind(this.sizeManager)
            : this.sizeManager?.constrainCanvasHeight?.bind(this.sizeManager);
        const clamped = clamp ? clamp(Math.round(value)) : Math.round(value);
        widget.value = clamped;
        widget.callback?.call(widget, clamped);
        this.setDirtyCanvas(true, true);
      };

      this.adjustDimension = (widgetName, delta) => {
        const widget = this.widgets.find((w) => w.name === widgetName);
        if (!widget) return;
        const next = Number(widget.value || 0) + delta;
        this.setDimensionValue(widgetName, next);
        this.updateCanvasSizeFromWidgets();
      };

      this.promptDimension = (widgetName, label) => {
        const widget = this.widgets.find((w) => w.name === widgetName);
        if (!widget) return;
        const next = prompt(`Set ${label}`, widget.value);
        if (next === null) return;
        const parsed = parseInt(next, 10);
        if (Number.isNaN(parsed)) return;
        this.setDimensionValue(widgetName, parsed);
        this.updateCanvasSizeFromWidgets();
        this.properties.userAdjustedDims = true;
      };

      this.forceCanvasRefresh = () => {
        this.refreshCanvas();
        this.setDirtyCanvas(true, true);
      };

      // Wire the TopRow refresh button to pull the connected bg_image and paint it
      this.updateReferenceImageFromConnectedNode = async () => {
        try {
          const base64 = await getReferenceImageFromConnectedNode(this, 'bg_image');
          if (!base64) {
            console.warn('PrepareRefs: no bg_image found on refresh');
            this.forceCanvasRefresh();
            return;
          }

          await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              // Use RefCanvas to load bg_image (sets up coordinate system automatically)
              this.refCanvasEditor.loadBackgroundImage(img);
              this.loadedBgImage = img;
              // Keep user-selected canvas size, only refresh the visual preview
              this.forceCanvasRefresh();
              resolve();
            };
            img.onerror = reject;
            img.src = base64;
          });
        } catch (e) {
          console.error('PrepareRefs: failed to refresh bg_image', e);
          this.forceCanvasRefresh();
        }
      };
      this.handleFramesRefresh = () => {
        this.forceCanvasRefresh();
      };

      this.updateCanvasSizeFromWidgets = () => {
        const width = widthWidget ? widthWidget.value : 640;
        const height = heightWidget ? heightWidget.value : 480;
        // Use RefCanvas to update size (handles canvas resize and image recentering)
        this.refCanvasEditor.setSize(width, height);
        // Remove CSS dimensions - let it scale naturally
        this.refsCanvas.style.width = '';
        this.refsCanvas.style.height = '';
        this.sizeManager.setCanvasSize(width, height);
        this.refreshCanvas();
        this.sizeManager.updateSize(true);
      };

      // Add a method to get ref layer data for serialization
      this.getRefLayerData = () => {
        if (!this.refLayers || !Array.isArray(this.refLayers)) {
            return [];
        }

        // Filter and return only layers that have shapes (non-empty additivePaths)
        return this.refLayers
          .filter(layer => {
            // Check if the layer has lasso shapes with actual paths
            const lassoShape = layer.value?.lassoShape;
            const additivePaths = lassoShape?.additivePaths;
            return lassoShape && additivePaths && Array.isArray(additivePaths) && additivePaths.length > 0;
          })
          .map(layer => ({ ...layer.value }));
      };

      // Add the ref layer data widget early in the process
      if (!this.widgets) this.widgets = [];
      const refDataWidget = {
        type: "custom",
        name: "ref_layer_data",
        value: this.getRefLayerData(),
        callback: (value) => {
          // Update the value when needed
          this.widgets.find(w => w.name === "ref_layer_data").value = this.getRefLayerData();
        }
      };
      // Mark this widget for serialization
      refDataWidget.serialize = true;
      this.widgets.push(refDataWidget);

      this.domWidget = this.addDOMWidget(nodeData.name, 'PrepareRefsCanvas', container, {
        serialize: false,
        hideOnZoom: false,
      });

      this.domWidget.computeSize = function (width) {
        const heightWidget = this.node?.widgets?.find((w) => w.name === 'mask_height');
        const canvasHeight = heightWidget ? heightWidget.value : 480;
        return [width, canvasHeight];
      }.bind(this.domWidget);

      this.updateCanvasSizeFromWidgets();

      // Add ref layer methods
      this.addRefLayer = () => {
        // Find the highest existing ref number
        let maxNum = 0;
        this.refLayers.forEach(layer => {
          const match = layer.value.name.match(/ref_(\d+)/);
          if (match) {
            const num = parseInt(match[1], 10);
            if (num > maxNum) maxNum = num;
          }
        });
        const nextNum = maxNum + 1;

        const refWidget = new RefLayerWidget(`ref_${nextNum}`);
        refWidget.value = { on: true, name: `ref_${nextNum}` };
        refWidget.node = this;
        this.refLayers.push(refWidget);

        // Create DOM element for the ref layer
        const refElement = document.createElement('div');
        refElement.style.display = 'flex';
        refElement.style.alignItems = 'center';
        refElement.style.padding = '4px 6px';
        refElement.style.background = '#262626';
        refElement.style.border = '1px solid #3a3a3a';
        refElement.style.borderRadius = '3px';
        refElement.style.fontSize = '11px';
        refElement.style.color = '#e0e0e0';
        refElement.style.cursor = 'pointer';
        refElement.style.userSelect = 'none';
        refElement.style.transition = 'background 0.1s ease';

        // Layer name
        const nameSpan = document.createElement('span');
        nameSpan.textContent = refWidget.value.name;
        nameSpan.style.flex = '1';
        refElement.appendChild(nameSpan);

        // Edit button
        const editBtn = document.createElement('button');
        editBtn.textContent = '✎';
        editBtn.style.width = '18px';
        editBtn.style.height = '18px';
        editBtn.style.padding = '0';
        editBtn.style.border = 'none';
        editBtn.style.background = 'transparent';
        editBtn.style.color = '#888888';
        editBtn.style.cursor = 'pointer';
        editBtn.style.fontSize = '12px';
        editBtn.style.transition = 'color 0.1s ease';
        editBtn.onmousedown = (e) => {
          e.stopPropagation();
          editBtn.style.color = '#ffffff';
        };
        editBtn.onmouseup = () => {
          editBtn.style.color = '#888888';
        };
        editBtn.onmouseleave = () => {
          editBtn.style.color = '#888888';
        };
        editBtn.onclick = (e) => {
          e.stopPropagation();
          // Select this layer when edit is clicked
          if (this.selectedRefLayer && this.selectedRefLayer.domElement) {
            this.selectedRefLayer.domElement.style.background = '#262626';
          }
          this.selectedRefLayer = refWidget;
          refElement.style.background = '#0c0c0c';

          // Toggle lasso mode
          if (this._lassoDrawingActive && this._lassoActiveLayer === refWidget) {
            this.exitLassoMode?.();
          } else {
            this.enterLassoMode?.(refWidget);
          }

          this.setDirtyCanvas(true, true);
        };
        refElement.appendChild(editBtn);

        // Delete button (X)
        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = '✕';
        deleteBtn.style.width = '18px';
        deleteBtn.style.height = '18px';
        deleteBtn.style.padding = '0';
        deleteBtn.style.border = 'none';
        deleteBtn.style.background = 'transparent';
        deleteBtn.style.color = '#888888';
        deleteBtn.style.cursor = 'pointer';
        deleteBtn.style.fontSize = '12px';
        deleteBtn.style.transition = 'color 0.1s ease';
        deleteBtn.onmousedown = (e) => {
          e.stopPropagation();
          deleteBtn.style.color = '#ffffff';
        };
        deleteBtn.onmouseup = () => {
          deleteBtn.style.color = '#888888';
        };
        deleteBtn.onmouseleave = () => {
          deleteBtn.style.color = '#888888';
        };
        deleteBtn.onclick = (e) => {
          e.stopPropagation();
          this.removeRefLayer(refWidget, refElement);
        };
        refElement.appendChild(deleteBtn);

        // Store reference to element on widget
        refWidget.domElement = refElement;

        // Click handler to select/deselect layer
        refElement.onclick = () => {
          // If clicking on already selected layer, deselect it
          if (this.selectedRefLayer === refWidget) {
            this.selectedRefLayer = null;
            refElement.style.background = '#262626';
            // Exit lasso mode when deselecting
            if (this._lassoDrawingActive) {
              this.exitLassoMode?.();
            }
            this.refreshCanvas();
            this.setDirtyCanvas(true, true);
            return;
          }
          // Deselect previous layer
          if (this.selectedRefLayer && this.selectedRefLayer.domElement) {
            this.selectedRefLayer.domElement.style.background = '#262626';
          }
          // Exit lasso mode when switching layers
          if (this._lassoDrawingActive) {
            this.exitLassoMode?.();
          }
          // Select this layer
          this.selectedRefLayer = refWidget;
          refElement.style.background = '#0c0c0c';
          this.refreshCanvas();
          this.setDirtyCanvas(true, true);
        };

        this.refLayersContainer.appendChild(refElement);

        // Auto-select the newly added layer
        if (this.selectedRefLayer && this.selectedRefLayer.domElement) {
          this.selectedRefLayer.domElement.style.background = '#262626';
        }
        this.selectedRefLayer = refWidget;
        refElement.style.background = '#0c0c0c';

        // Auto-enter lasso mode for the new layer
        if (this.enterLassoMode) {
          this.enterLassoMode(refWidget);
        }

        // Update the serialized ref layer data widget
        const refDataWidget = this.widgets.find(w => w.name === "ref_layer_data");
        if (refDataWidget) {
          refDataWidget.value = this.getRefLayerData();
        }

        this.refreshCanvas();
        this.setDirtyCanvas(true, true);
      };

      this.removeRefLayer = (refWidget, refElement) => {
        const idx = this.refLayers.indexOf(refWidget);
        if (idx > -1) {
          // Clear selection if this was the selected layer
          if (this.selectedRefLayer === refWidget) {
            this.selectedRefLayer = null;
          }

          this.refLayers.splice(idx, 1);
          // Remove from widgets
          const widgetIdx = this.widgets.indexOf(refWidget);
          if (widgetIdx > -1) {
            this.widgets.splice(widgetIdx, 1);
          }
          // Remove from DOM
          if (refElement && refElement.parentNode) {
            refElement.parentNode.removeChild(refElement);
          } else if (refWidget.domElement && refWidget.domElement.parentNode) {
            refWidget.domElement.parentNode.removeChild(refWidget.domElement);
          }
          // Renumber remaining layers
          this.refLayers.forEach((layer, i) => {
            layer.value.name = `ref_${i + 1}`;
            if (layer.domElement) {
              layer.domElement.querySelector('span').textContent = `ref_${i + 1}`;
            }
          });

          // Update the serialized ref layer data widget
          const refDataWidget = this.widgets.find(w => w.name === "ref_layer_data");
          if (refDataWidget) {
            refDataWidget.value = this.getRefLayerData();
          }

          this.refreshCanvas();
          this.setDirtyCanvas(true, true);
        }
      };
    });

    chainCallback(nodeType.prototype, 'onExecuted', function (message) {
      const dims = message?.ui?.bg_image_dims;
      if (!this.properties.userAdjustedDims && Array.isArray(dims) && dims.length > 0) {
        const first = dims[0];
        if (first?.width && first?.height) {
          this.setDimensionValue('mask_width', Math.round(first.width));
          this.setDimensionValue('mask_height', Math.round(first.height));
          this.updateCanvasSizeFromWidgets();
        }
      }
      this.setDirtyCanvas(true, true);
    });

    // Update the ref layer data widget when node is serialized
    const originalOnSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function (o) {
      // Update the ref layer data widget before serialization
      const refDataWidget = this.widgets?.find(w => w.name === "ref_layer_data");
      if (refDataWidget) {
        refDataWidget.value = this.getRefLayerData?.() || [];
      }
      originalOnSerialize?.apply(this, arguments);
    };
  },
});
