import { app } from '../../../scripts/app.js';
import { makeUUID, NodeSizeManager, TopRowWidget } from './spline_utils.js';
import { chainCallback, hideWidgetForGood } from './general_utils.js';
import { getReferenceImageFromConnectedNode } from './graph_query.js';
import { RefLayerWidget } from './layer_type_ref.js';
import { attachLassoHelpers } from './canvas_lasso.js';
import RefCanvas from './canvas_main_ref.js';

// ===================================================================
// Session Storage Helpers
// ===================================================================
function safeSetSessionItem(key, value) {
  try { sessionStorage.setItem(key, value); } catch (e) { /* ignore */ }
}

function safeGetSessionItem(key) {
  try { return sessionStorage.getItem(key); } catch (e) { return null; }
}

// ===================================================================
// Image Loading Utilities
// ===================================================================
async function loadImageFromUrl(url, canvasEditor) {
  console.log('[loadImageFromUrl] Loading:', url);
  const timestampedUrl = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      canvasEditor.loadBackgroundImage(img);
      resolve(img);
    };
    img.onerror = (err) => {
      console.error('[loadImageFromUrl] Failed to load image:', url, err);
      reject(err);
    };
    img.src = timestampedUrl;
  });
}

async function loadRefImagesFromPaths(paths, node) {
  if (!Array.isArray(paths) || paths.length === 0) return [];

  const images = [];
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    try {
      const url = new URL(path, import.meta.url).href + `?t=${Date.now()}`;
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = url;
      });
      images.push(img);
    } catch (err) {
      console.error(`[loadRefImagesFromPaths] Failed to load ref image ${i}:`, path, err);
    }
  }
  return images;
}

// ===================================================================
// Node Lifecycle: PrepareRefs
// ===================================================================
app.registerExtension({
  name: 'WanVideoWrapper_QQ.PrepareRefs',

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== 'PrepareRefs') return;

    // =================================================================
    // onNodeCreated – Main Setup
    // =================================================================
    chainCallback(nodeType.prototype, 'onNodeCreated', function () {
      this.serialize_widgets = true;
      this.resizable = false;
      this.properties = this.properties || {};
      this.properties.userAdjustedDims = this.properties.userAdjustedDims || false;

      // Restore UUID from properties if available (for persistence), otherwise create new one
      this.uuid = this.properties.uuid || this.uuid || makeUUID();
      console.log('[PrepareRefs onNodeCreated] Using UUID:', this.uuid);

      // Hide widgets that shouldn't be visible in UI
      const widthWidget = this.widgets.find(w => w.name === 'mask_width');
      const heightWidget = this.widgets.find(w => w.name === 'mask_height');
      const internalStateWidget = this.widgets.find(w => w.name === 'internal_state');
      const exportFilenameWidget = this.widgets.find(w => w.name === 'export_filename');
      const refLayerDataWidget = this.widgets.find(w => w.name === 'ref_layer_data');

      const markUserAdjusted = () => { this.properties.userAdjustedDims = true; };

      [widthWidget, heightWidget].forEach(w => {
        if (w) {
          const orig = w.callback;
          w.callback = (v) => { orig?.call(w, v); markUserAdjusted(); this.updateCanvasSizeFromWidgets?.(); };
          hideWidgetForGood(this, w);
        }
      });

      // Hide the persistence widgets (they're managed by the node, not user-editable)
      [internalStateWidget, exportFilenameWidget, refLayerDataWidget].forEach(w => {
        if (w) hideWidgetForGood(this, w);
      });

      // Size manager for consistent canvas/node sizing
      this.sizeManager = new NodeSizeManager(this, {
        spacingAfterCanvas: 36,
        canvasWidth: widthWidget?.value ?? 640,
        canvasHeight: heightWidget?.value ?? 480,
        minNodeWidth: 640,
        minNodeHeight: 480,
      });

      this.onResize = (size) => {
        const constrained = this.sizeManager.onNodeResized(size);
        size[0] = constrained[0];
        size[1] = constrained[1];
      };

      // Top row controls
      this.addCustomWidget(new TopRowWidget('prepare_refs_top_row', {
        refreshCanvasButton: true,
        refreshFramesButton: false,
        bgImgControl: false,
        animToggleButton: false,
      }));

      this.setupUI();
      this.setupCanvas();
      this.setupRefLayers();
      this.restoreSessionImages();
    });

    // =================================================================
    // UI Construction
    // =================================================================
    nodeType.prototype.setupUI = function () {
      const container = this.createMainContainer();
      this.domWidget = this.addDOMWidget('PrepareRefs', 'PrepareRefsCanvas', container, {
        serialize: false,
        hideOnZoom: false,
      });

      this.domWidget.computeSize = () => {
        const h = this.widgets.find(w => w.name === 'mask_height')?.value ?? 480;
        return [0, h];
      };
    };

    nodeType.prototype.createMainContainer = function () {
      const container = document.createElement('div');
      container.id = `prepare-refs-${this.uuid}`;
      container.style.cssText = `
        display: flex;
        flex-direction: column;
        margin: 0; padding: 0; gap: 0;
      `;

      const row = document.createElement('div');
      row.style.cssText = `
        display: flex; gap: 8px; align-items: stretch;
      `;
      container.appendChild(row);

      this.sidebar = this.createSidebar();
      row.appendChild(this.sidebar);

      this.canvasWrap = this.createCanvasWrapper();
      row.appendChild(this.canvasWrap);

      return container;
    };

    nodeType.prototype.createSidebar = function () {
      const sidebar = document.createElement('div');
      sidebar.style.cssText = `
        width: 120px; flex: 0 0 120px; display: flex; flex-direction: column;
        gap: 8px; padding: 8px; background: transparent; border: 1px solid #3a3a3a;
        color: #b5b5b5; font-size: 12px; box-sizing: border-box;
      `;

      const addBtn = this.createAddRefButton();
      sidebar.appendChild(addBtn);

      this.refLayersContainer = document.createElement('div');
      this.refLayersContainer.style.cssText = `
        flex: 1; display: flex; flex-direction: column; gap: 4px;
        overflow-y: auto; margin-top: 4px;
      `;
      sidebar.appendChild(this.refLayersContainer);

      return sidebar;
    };

    nodeType.prototype.createAddRefButton = function () {
      const btn = document.createElement('button');
      btn.textContent = '+ Add ref';
      btn.style.cssText = `
        padding: 8px 12px; background: #1e1e1e; color: #ddd; border: 0.75px solid #00000044;
        border-radius: 4px; font-size: 12px; font-weight: 500; cursor: pointer;
        box-shadow: 0 1px 0 #000000aa, inset 0 0.75px 0 #ffffff22;
        transition: all 0.05s ease;
      `;
      ['mousedown', 'mouseleave', 'mouseup'].forEach(ev => {
        btn.addEventListener(ev, () => {
          btn.style.background = ev === 'mousedown' ? '#444' : '#1e1e1e';
          btn.style.transform = ev === 'mousedown' ? 'translateY(1px)' : 'translateY(0)';
        });
      });
      btn.onclick = () => this.addRefLayer();
      return btn;
    };

    nodeType.prototype.createCanvasWrapper = function () {
      const wrap = document.createElement('div');
      wrap.style.cssText = `
        flex: 1; display: flex; align-items: center; justify-content: center;
        overflow: hidden; padding-top: 0; box-sizing: border-box;
      `;

      this.refsCanvas = document.createElement('canvas');
      this.refsCanvas.style.cssText = `
        background: #222; border: 1px solid gray; max-width: 100%; max-height: 100%;
        display: block; border-radius: 0;
      `;
      wrap.appendChild(this.refsCanvas);

      return wrap;
    };

    // =================================================================
    // Canvas & RefCanvas Setup
    // =================================================================
    nodeType.prototype.setupCanvas = function () {
      this.refCanvasEditor = new RefCanvas(this.refsCanvas, this);
      attachLassoHelpers(this);

      this.refreshCanvas = () => {
        this.refCanvasEditor.render();

        const ctx = this.refsCanvas.getContext('2d');
        const { width, height } = this.refsCanvas;
        ctx.strokeStyle = 'gray';
        ctx.lineWidth = 1;
        ctx.strokeRect(0, 0, width, height);

        if (!this.refCanvasEditor.backgroundImage) {
          ctx.fillStyle = '#787878';
          ctx.font = '12px sans-serif';
          ctx.fillText('PrepareRefs canvas', 20, 26);
        }

        this.refLayers?.forEach(layer => {
          if (layer.value.lassoShape) {
            const isSelected = this.selectedRefLayer === layer;
            this.renderLayerLassoShapes?.(ctx, layer.value.lassoShape, width, height, isSelected, this.refCanvasEditor);
          }
        });

        this.renderLassoPreview?.();
      };

      this.forceCanvasRefresh = () => {
        this.refreshCanvas();
        this.setDirtyCanvas(true, true);
      };
    };

    // =================================================================
    // Ref Layer Management
    // =================================================================
    nodeType.prototype.setupRefLayers = function () {
      this.refLayers = [];
      this.selectedRefLayer = null;

      // ref_layer_data widget is now created by Python INPUT_TYPES, not here
      // Just ensure its callback updates the layer data
      const refDataWidget = this.widgets?.find(w => w.name === 'ref_layer_data');
      if (refDataWidget) {
        const origCallback = refDataWidget.callback;
        refDataWidget.callback = () => {
          origCallback?.call(refDataWidget);
          this.updateRefDataWidget();
        };
      }
    };

    nodeType.prototype.getRefLayerData = function () {
      return (this.refLayers || [])
        .map(l => ({ ...l.value }));
    };

    nodeType.prototype.restoreRefLayers = function (layerDataArray) {
      if (!Array.isArray(layerDataArray) || layerDataArray.length === 0) return;

      console.log('[PrepareRefs] Restoring', layerDataArray.length, 'layers from saved data');

      // Clear existing layers
      this.refLayers.forEach(layer => {
        if (layer.domElement?.parentNode) {
          layer.domElement.parentNode.removeChild(layer.domElement);
        }
      });
      this.refLayers = [];
      this.selectedRefLayer = null;

      // Recreate layers from saved data
      layerDataArray.forEach((layerData, index) => {
        const layer = new RefLayerWidget(layerData.name || `ref_${index + 1}`);
        layer.value = { ...layerData };
        layer.node = this;
        this.refLayers.push(layer);

        const el = this.createRefLayerElement(layer);
        this.refLayersContainer.appendChild(el);
        layer.domElement = el;
      });

      // Save to session storage for quick restore
      try {
        const sessionKey = `prepare-refs-layers-${this.uuid}`;
        safeSetSessionItem(sessionKey, JSON.stringify(layerDataArray));
      } catch (e) {
        console.warn('[PrepareRefs] Failed to save layers to session:', e);
      }

      this.forceCanvasRefresh();
    };

    nodeType.prototype.addRefLayer = function () {
      const nextNum = (this.refLayers.reduce((m, l) => {
        const n = parseInt(l.value.name.match(/ref_(\d+)/)?.[1] || 0);
        return Math.max(m, n);
      }, 0)) + 1;

      const layer = new RefLayerWidget(`ref_${nextNum}`);
      layer.value = { on: true, name: `ref_${nextNum}` };
      layer.node = this;
      this.refLayers.push(layer);

      const el = this.createRefLayerElement(layer);
      this.refLayersContainer.appendChild(el);
      layer.domElement = el;

      this.selectRefLayer(layer);
      this.enterLassoMode?.(layer);
      this.updateRefDataWidget();
      this.forceCanvasRefresh();
    };

    nodeType.prototype.createRefLayerElement = function (layer) {
      const el = document.createElement('div');
      el.style.cssText = `
        display: flex; align-items: center; padding: 4px 6px; background: #262626;
        border: 1px solid #3a3a3a; border-radius: 3px; font-size: 11px; color: #e0e0e0;
        cursor: pointer; user-select: none; transition: background 0.1s ease;
      `;

      const name = document.createElement('span');
      name.textContent = layer.value.name;
      name.style.flex = '1';
      el.appendChild(name);

      const editBtn = this.createIconButton('Edit', '✎', () => {
        this.selectRefLayer(layer);
        if (this._lassoDrawingActive && this._lassoActiveLayer === layer) {
          this.exitLassoMode?.();
        } else {
          this.enterLassoMode?.(layer);
        }
      });
      el.appendChild(editBtn);
      
      // Store reference to edit button for color updates
      layer.editButton = editBtn;

      const delBtn = this.createIconButton('Delete', '✕', () => this.removeRefLayer(layer));
      el.appendChild(delBtn);

      el.onclick = (e) => {
        if (e.target.tagName === 'BUTTON') return;
        if (this.selectedRefLayer === layer) {
          this.deselectRefLayer();
        } else {
          this.selectRefLayer(layer);
        }
      };

      return el;
    };

    nodeType.prototype.createIconButton = function (title, symbol, callback) {
      const btn = document.createElement('button');
      btn.innerHTML = symbol;
      btn.title = title;
      btn.style.cssText = `
        width: 18px; height: 18px; padding: 0; background: transparent;
        border: none; color: #888; cursor: pointer; font-size: 12px;
        display: flex; align-items: center; justify-content: center;
      `;
      btn.onmousedown = (e) => { e.stopPropagation(); btn.style.color = '#fff'; };
      btn.onmouseleave = () => {
        // Only reset to gray if not in edit mode
        const isInEditMode = this._lassoDrawingActive && this._lassoActiveLayer &&
                           this._lassoActiveLayer.editButton === btn;
        if (!isInEditMode) {
          btn.style.color = '#888';
        }
      };
      btn.onmouseup = () => {
        // Only reset to gray if not in edit mode
        const isInEditMode = this._lassoDrawingActive && this._lassoActiveLayer &&
                           this._lassoActiveLayer.editButton === btn;
        if (!isInEditMode) {
          btn.style.color = '#888';
        }
      };
      btn.onclick = (e) => { e.stopPropagation(); callback(); };
      return btn;
    };

    nodeType.prototype.selectRefLayer = function (layer) {
      if (this.selectedRefLayer?.domElement) {
        this.selectedRefLayer.domElement.style.background = '#262626';
      }
      this.selectedRefLayer = layer;
      if (layer.domElement) layer.domElement.style.background = '#0c0c0c';
      this.exitLassoMode?.();
      this.updateLayerButtonStates();
      this.forceCanvasRefresh();
    };

    nodeType.prototype.deselectRefLayer = function () {
      if (this.selectedRefLayer?.domElement) {
        this.selectedRefLayer.domElement.style.background = '#262626';
      }
      this.selectedRefLayer = null;
      this.exitLassoMode?.();
      this.updateLayerButtonStates();
      this.forceCanvasRefresh();
    };

    nodeType.prototype.removeRefLayer = function (layer) {
      const idx = this.refLayers.indexOf(layer);
      if (idx === -1) return;

      if (this.selectedRefLayer === layer) this.selectedRefLayer = null;
      this.refLayers.splice(idx, 1);
      if (layer.domElement?.parentNode) layer.domElement.parentNode.removeChild(layer.domElement);

      this.renumberRefLayers();
      this.updateRefDataWidget();
      this.forceCanvasRefresh();
    };

    nodeType.prototype.renumberRefLayers = function () {
      this.refLayers.forEach((l, i) => {
        l.value.name = `ref_${i + 1}`;
        if (l.domElement) l.domElement.querySelector('span').textContent = l.value.name;
      });
    };

    nodeType.prototype.updateRefDataWidget = function () {
      console.log('[PrepareRefs updateRefDataWidget] Called');
      const w = this.widgets.find(w => w.name === "ref_layer_data");
      console.log('[PrepareRefs updateRefDataWidget] Widget found:', w);
      if (w) {
        const layerData = this.getRefLayerData();
        console.log('[PrepareRefs updateRefDataWidget] Layer data from getRefLayerData():', layerData);

        // Widget is STRING type in Python, so serialize to JSON
        w.value = JSON.stringify(layerData);

        // Also save to sessionStorage for quick restore on page refresh
        try {
          const sessionKey = `prepare-refs-layers-${this.uuid}`;
          console.log('[PrepareRefs updateRefDataWidget] Saving to session storage with key:', sessionKey);
          safeSetSessionItem(sessionKey, JSON.stringify(layerData));
          console.log('[PrepareRefs updateRefDataWidget] Saved to session storage successfully');
        } catch (e) {
          console.warn('[PrepareRefs] Failed to save layers to session:', e);
        }
      } else {
        console.warn('[PrepareRefs updateRefDataWidget] Widget not found!');
      }
    };
    
    nodeType.prototype.updateLayerButtonStates = function () {
      this.refLayers?.forEach(layer => {
        if (layer.editButton) {
          // Make pen icon green if this layer is in edit mode
          const isInEditMode = this._lassoDrawingActive && this._lassoActiveLayer === layer;
          layer.editButton.style.color = isInEditMode ? '#4CAF50' : '#888';
        }
      });
    };

    // =================================================================
    // Dimension & Canvas Size Helpers
    // =================================================================
    nodeType.prototype.updateCanvasSizeFromWidgets = function () {
      const w = this.widgets.find(w => w.name === 'mask_width')?.value ?? 640;
      const h = this.widgets.find(w => w.name === 'mask_height')?.value ?? 480;

      this.refCanvasEditor.setSize(w, h);
      this.refsCanvas.style.width = this.refsCanvas.style.height = '';
      this.sizeManager.setCanvasSize(w, h);
      this.refreshCanvas();
      this.sizeManager.updateSize(true);
    };

    // =================================================================
    // Image Refresh & Persistence
    // =================================================================
    nodeType.prototype.updateReferenceImageFromConnectedNode = async function () {
      try {
        const base64 = await getReferenceImageFromConnectedNode(this, 'bg_image');
        if (!base64) return this.forceCanvasRefresh();

        const img = await new Promise((resolve, reject) => {
          const i = new Image();
          i.onload = () => { this.refCanvasEditor.loadBackgroundImage(i); resolve(i); };
          i.onerror = reject;
          i.src = base64;
        });

        this.loadedBgImage = img;

        // Save via backend
        await fetch('/wanvideowrapper_qq/save_prepare_refs_images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bg_image: base64, ref_images: [] })
        })
        .then(r => r.json())
        .then(res => {
          if (res.success && res.paths?.bg_image_path) {
            this.properties.bg_image_path = res.paths.bg_image_path;
            safeSetSessionItem(`prepare-refs-bg-${this.uuid}`, res.paths.bg_image_path);
          }
        })
        .catch(console.error);

        this.forceCanvasRefresh();
      } catch (err) {
        console.error('[PrepareRefs] Failed to refresh background:', err);
        this.forceCanvasRefresh();
      }
    };

    nodeType.prototype.updateExtraRefsFromConnectedNode = async function () {
      try {
        // Safety check: only run if we have the required functions
        if (typeof findConnectedSourceNode !== 'function' || typeof extractImagesFromSourceNode !== 'function') {
          console.warn('[PrepareRefs] Graph query functions not available, skipping extra refs update');
          return;
        }

        // Fetch images from extra_refs connection (e.g., CreateImageList)
        // Use lower-level functions since getReferenceImagesFromConnectedNode is hardcoded to 'ref_images'
        let sourceNodeObj = findConnectedSourceNode(this, 'extra_refs');
        if (!sourceNodeObj) {
          sourceNodeObj = findDeepSourceNode(this, 'extra_refs');
        }

        let extraRefImages = [];
        if (sourceNodeObj) {
          extraRefImages = await extractImagesFromSourceNode(sourceNodeObj, true);
        }

        if (extraRefImages && extraRefImages.length > 0) {
          console.log(`[PrepareRefs] Found ${extraRefImages.length} extra ref images from connected node`);
          this.loadedExtraRefImages = extraRefImages;

          // Store in properties for persistence
          this.properties.extra_ref_count = extraRefImages.length;
        } else {
          // No extra refs - this is normal, don't log as error
          this.loadedExtraRefImages = null;
          this.properties.extra_ref_count = 0;
        }
      } catch (err) {
        // Silently handle errors - extra refs are optional
        console.warn('[PrepareRefs] Could not fetch extra refs:', err.message);
        this.loadedExtraRefImages = null;
        this.properties.extra_ref_count = 0;
      }
    };

    // =================================================================
    // Session Restore on Load
    // =================================================================
    nodeType.prototype.restoreSessionImages = function () {
      // Restore layers from sessionStorage
      const sessionLayers = safeGetSessionItem(`prepare-refs-layers-${this.uuid}`);
      if (sessionLayers) {
        try {
          const layerData = JSON.parse(sessionLayers);
          if (Array.isArray(layerData) && layerData.length > 0) {
            this.restoreRefLayers(layerData);
            console.log('[PrepareRefs] Restored', layerData.length, 'layers from session');
          }
        } catch (e) {
          console.warn('[PrepareRefs] Failed to restore layers from session:', e);
        }
      }

      const bgPath = safeGetSessionItem(`prepare-refs-bg-${this.uuid}`);
      const refPathsJson = safeGetSessionItem(`prepare-refs-images-${this.uuid}`);

      if (bgPath) {
        try {
          // CRITICAL: Resolve relative path correctly using import.meta.url
          const url = new URL(bgPath, import.meta.url).href;
          loadImageFromUrl(url, this.refCanvasEditor)
            .then(() => {
              console.log('[PrepareRefs] Restored bg_image from session:', bgPath);
              this.forceCanvasRefresh();
            })
            .catch(err => console.error('[PrepareRefs] Failed to restore bg_image:', err));
        } catch (e) {
          console.error('[PrepareRefs] Invalid bg_image path in session:', bgPath, e);
        }
      }

      if (refPathsJson) {
        try {
          const paths = JSON.parse(refPathsJson);
          if (Array.isArray(paths) && paths.length > 0) {
            const resolvedPaths = paths.map(p => new URL(p, import.meta.url).href);
            loadRefImagesFromPaths(resolvedPaths, this).then(imgs => {
              this.loadedRefImages = imgs;
              this.forceCanvasRefresh();
            });
          }
        } catch (e) {
          console.error('[PrepareRefs] Failed to parse/restore ref images from session:', e);
        }
      }

      this.updateCanvasSizeFromWidgets();
    };

    // =================================================================
    // Lifecycle Callbacks
    // =================================================================
    chainCallback(nodeType.prototype, 'onExecuted', async function (message) {
      // Auto-size from incoming image if user hasn't manually adjusted
      if (!this.properties.userAdjustedDims && message?.ui?.bg_image_dims?.[0]) {
        const { width, height } = message.ui.bg_image_dims[0];
        this.setDimensionValue?.('mask_width', Math.round(width));
        this.setDimensionValue?.('mask_height', Math.round(height));
        this.updateCanvasSizeFromWidgets();
      }

      // Refresh canvas with connected bg_image
      await this.updateReferenceImageFromConnectedNode();

      // Fetch extra refs from connected node (e.g., CreateImageList)
      // TEMPORARILY DISABLED FOR DEBUGGING
      /*
      if (this.updateExtraRefsFromConnectedNode) {
        try {
          await this.updateExtraRefsFromConnectedNode();
        } catch (err) {
          console.warn('[PrepareRefs] Error in updateExtraRefsFromConnectedNode:', err);
        }
      }
      */

      // Restore bg/ref images from execution message
      if (message?.ui?.bg_image_path?.[0]) {
        const path = message.ui.bg_image_path[0];
        this.properties.bg_image_path = path;
        safeSetSessionItem(`prepare-refs-bg-${this.uuid}`, path);
        const url = new URL(path, import.meta.url).href;
        await loadImageFromUrl(url, this.refCanvasEditor);
      }

      if (message?.ui?.ref_images_paths?.length) {
        const paths = message.ui.ref_images_paths;
        this.properties.ref_images_paths = paths;
        safeSetSessionItem(`prepare-refs-images-${this.uuid}`, JSON.stringify(paths));
        const resolvedPaths = paths.map(p => new URL(p, import.meta.url).href);
        this.loadedRefImages = await loadRefImagesFromPaths(resolvedPaths, this);
      }

      this.forceCanvasRefresh();
    });

    chainCallback(nodeType.prototype, 'onConfigure', async function (info) {
      console.log('[PrepareRefs onConfigure] Starting configuration restore');
      console.log('[PrepareRefs onConfigure] Current UUID:', this.uuid);
      console.log('[PrepareRefs onConfigure] Properties UUID:', this.properties?.uuid);
      console.log('[PrepareRefs onConfigure] Info object:', info);
      console.log('[PrepareRefs onConfigure] All widgets:', this.widgets?.map(w => ({name: w.name, value: w.value})));

      // CRITICAL: Restore UUID from properties if available
      // onConfigure runs AFTER onNodeCreated, so we need to update UUID here
      if (this.properties?.uuid && this.properties.uuid !== this.uuid) {
        console.log('[PrepareRefs onConfigure] Restoring UUID from properties:', this.properties.uuid);
        this.uuid = this.properties.uuid;
      }

      // Find the ref_layer_data widget
      const refDataWidget = this.widgets?.find(w => w.name === 'ref_layer_data');
      console.log('[PrepareRefs onConfigure] ref_layer_data widget found:', !!refDataWidget);

      // ComfyUI's configure applies widget values from widgets_values array to widgets BEFORE onConfigure runs
      // The widget value is a JSON string (STRING type in Python), so parse it
      let layerData = null;
      if (refDataWidget && refDataWidget.value) {
        try {
          // Parse JSON string to get layer data array
          layerData = typeof refDataWidget.value === 'string' ? JSON.parse(refDataWidget.value) : refDataWidget.value;
          console.log('[PrepareRefs onConfigure] Parsed layer data from widget:', layerData);
        } catch (e) {
          console.warn('[PrepareRefs onConfigure] Failed to parse ref_layer_data:', e);
          layerData = [];
        }
      }
      console.log('[PrepareRefs onConfigure] Layer data:', layerData);

      // If we have layer data from the workflow (even empty array), use it and DON'T restore from session
      // This ensures loading a workflow with no layers doesn't restore old session data
      if (layerData !== null && layerData !== undefined && Array.isArray(layerData)) {
        if (layerData.length > 0) {
          console.log('[PrepareRefs onConfigure] Restoring from workflow data:', layerData.length, 'layers');
          this.restoreRefLayers(layerData);
        } else {
          console.log('[PrepareRefs onConfigure] Workflow has empty layer array - clearing existing layers');
          // Clear existing layers since the workflow has none
          this.refLayers?.forEach(layer => {
            if (layer.domElement?.parentNode) {
              layer.domElement.parentNode.removeChild(layer.domElement);
            }
          });
          this.refLayers = [];
          this.selectedRefLayer = null;
        }
      } else {
        // Only restore from session if no workflow data exists (undefined/null)
        console.log('[PrepareRefs onConfigure] No workflow layer data, trying session storage...');
        const sessionLayers = safeGetSessionItem(`prepare-refs-layers-${this.uuid}`);
        console.log('[PrepareRefs onConfigure] Session storage data:', sessionLayers);
        if (sessionLayers) {
          try {
            const parsedData = JSON.parse(sessionLayers);
            console.log('[PrepareRefs onConfigure] Parsed session data:', parsedData);
            if (Array.isArray(parsedData) && parsedData.length > 0) {
              console.log('[PrepareRefs onConfigure] Restoring from session:', parsedData.length, 'layers');
              this.restoreRefLayers(parsedData);
            }
          } catch (e) {
            console.warn('[onConfigure] Failed to restore layers from session:', e);
          }
        } else {
          console.log('[PrepareRefs onConfigure] No session storage data found');
        }
      }

      const savedBgPath = this.properties.bg_image_path;
      const savedRefPaths = this.properties.ref_images_paths;

      const sessionBgPath = safeGetSessionItem(`prepare-refs-bg-${this.uuid}`);
      const sessionRefPaths = safeGetSessionItem(`prepare-refs-images-${this.uuid}`);

      const finalBgPath = savedBgPath || sessionBgPath;
      const finalRefPaths = savedRefPaths || (sessionRefPaths ? JSON.parse(sessionRefPaths) : null);

      if (finalBgPath) {
        try {
          const url = new URL(finalBgPath, import.meta.url).href;
          await loadImageFromUrl(url, this.refCanvasEditor);
          console.log('[onConfigure] Restored background image:', finalBgPath);
        } catch (e) {
          console.error('[onConfigure] Failed to load bg_image:', finalBgPath, e);
        }
      }

      if (finalRefPaths && Array.isArray(finalRefPaths) && finalRefPaths.length > 0) {
        try {
          const urls = finalRefPaths.map(p => new URL(p, import.meta.url).href);
          this.loadedRefImages = await loadRefImagesFromPaths(urls, this);
          console.log('[onConfigure] Restored', this.loadedRefImages.length, 'ref images');
        } catch (e) {
          console.error('[onConfigure] Failed to restore ref images:', e);
        }
      }

      this.forceCanvasRefresh();
    });

    // Ensure ref data and paths are serialized
    const origSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function (o) {
      const refWidget = this.widgets?.find(w => w.name === "ref_layer_data");
      if (refWidget) {
        const layerData = this.getRefLayerData();
        console.log('[PrepareRefs onSerialize] Saving layers:', layerData);
        // Widget is STRING type in Python, so serialize to JSON
        refWidget.value = JSON.stringify(layerData);
      }

      o.properties = o.properties || {};
      o.properties.uuid = this.uuid; // Save UUID for session storage persistence
      if (this.properties.bg_image_path) o.properties.bg_image_path = this.properties.bg_image_path;
      if (this.properties.ref_images_paths) o.properties.ref_images_paths = this.properties.ref_images_paths;

      console.log('[PrepareRefs onSerialize] Serialized widget values:', this.widgets?.map(w => ({name: w.name, value: w.value})));
      console.log('[PrepareRefs onSerialize] Saved UUID:', this.uuid);

      origSerialize?.call(this, o);
    };
  },
});