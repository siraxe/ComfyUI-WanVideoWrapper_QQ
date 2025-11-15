import { app } from '../../../scripts/app.js';
import { LayerRenderer } from './layer_renderer.js';
import { BOX_BASE_RADIUS, BOX_BORDER_BAND } from './spline_utils.js';

export default class SplineEditor2 {
  constructor(context, reset = false) {
    this.node = context;
    this.reset = reset;
    const self = this;



    // Store original image details
    this.originalImageWidth = null;
    this.originalImageHeight = null;
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;

    // Store previous spline data from coord_in
    this.previousSplineData = null;
    this.previousSplinesLayer = null;

    this.node.pasteFile = (file) => {
      if (file.type.startsWith("image/")) {
        this.handleImageFile(file);
        return true;
      }
      return false;
    };

    this.node.onDragOver = function (e) {
      if (e.dataTransfer && e.dataTransfer.items) {
        return [...e.dataTransfer.items].some(f => f.kind === "file" && f.type.startsWith("image/"));
      }
      return false;
    };

    // On drop upload files
    this.node.onDragDrop = (e) => {
      let handled = false;
      for (const file of e.dataTransfer.files) {
        if (file.type.startsWith("image/")) {
          this.handleImageFile(file);
          handled = true;
        }
      }
      return handled;
    };

    // context menu
    this.createContextMenu();

    if (reset && context.splineEditor2.parentEl) {
      context.splineEditor2.parentEl.innerHTML = ''; // Clear the container
    }
    this.coordWidget = context.widgets.find(w => w.name === "coordinates");
    this.widthWidget = context.widgets.find(w => w.name === "mask_width");
    this.heightWidget = context.widgets.find(w => w.name === "mask_height");

    // Get interpolation from active widget
    this.interpolation = 'linear';
    // Handdraw modes: 'off' | 'create' | 'edit'
    this._handdrawMode = 'off';
    this._handdrawActive = false; // legacy flag used by renderer
    this._handdrawEditWidget = null;
    this._handdrawPath = [];
    // Global toggle for inactive flow animation (default ON)
    this._inactiveFlowEnabled = true;
    this.enterHanddrawMode = (mode = 'create', widget = null) => {
      this._handdrawMode = mode;
      this._handdrawEditWidget = mode === 'edit' ? widget : null;
      this._handdrawActive = true;
      this._handdrawPath = [];

      // Install right-click handler to exit edit mode reliably
      if (this._teardownHanddrawListeners) {
        try { this._teardownHanddrawListeners(); } catch {}
        this._teardownHanddrawListeners = null;
      }
      const canvasEl = this.vis?.canvas?.();
      if ((mode === 'edit' || mode === 'create') && canvasEl) {
        const onMouseDown = (ev) => {
          // Middle click exits handdraw modes (edit/create), preserving current curve
          if (ev && ev.button === 1) {
            ev.preventDefault?.(); ev.stopPropagation?.();
            try { this.exitHanddrawMode(false); } catch {}
            try { this.layerRenderer?.render(); } catch {}
            try { this.node?.setDirtyCanvas?.(true, true); } catch {}
          }
        };
        canvasEl.addEventListener('mousedown', onMouseDown, true);
        this._teardownHanddrawListeners = () => {
          canvasEl.removeEventListener('mousedown', onMouseDown, true);
        };
      }
    };
    this.exitHanddrawMode = (commit = false) => {
      // Only cancel UI state; no commit normalization here (handled in mousedown/mouseup flow)
      this._handdrawMode = 'off';
      this._handdrawEditWidget = null;
      this._handdrawActive = false;
      this._handdrawPath = [];
      // Remove temporary listeners
      if (this._teardownHanddrawListeners) {
        try { this._teardownHanddrawListeners(); } catch {}
        this._teardownHanddrawListeners = null;
      }
      // Re-render to update any UI state
      try { this.layerRenderer?.render(); } catch {}
    };
    this._teardownHanddrawListeners = null;

    // Use widget values instead of hardcoded dimensions
    this.width = this.widthWidget.value;
    this.height = this.heightWidget.value;
    this.pointsLayer = null;

    // Helper methods for multi-layer support
    this.getActiveWidget = () => {
      const widget = this.node.layerManager.getActiveWidget();
      return widget;
    };

    this.getActivePoints = () => {
      const activeWidget = this.getActiveWidget();
      if (!activeWidget) {
        return [];
      }
      try {
        const points = JSON.parse(activeWidget.value.points_store || '[]');
        const denorm = this.denormalizePoints(points);
        this.ensurePointScaleFields(denorm);
        this.ensurePointUids(denorm);
        return denorm.map(point => ({
          ...point,
          scale: (typeof point.scale === 'number' ? point.scale : 1.0),
          uid: point.uid
        }));
      } catch (e) {
        console.error("[SplineEditor] getActivePoints: failed to parse points_store", e);
        return [];
      }
    };

    this.setActivePoints = (points) => {
      const activeWidget = this.getActiveWidget();
      if (!activeWidget) {
        console.warn("[SplineEditor] setActivePoints: no active widget");
        return;
      }
      this.ensurePointUids(points);
      activeWidget.value.points_store = JSON.stringify(this.normalizePoints(points));
      // Only call updatePath if vis is already created
      if (this.vis) {
        this.updatePath();
      }
    };

    this.onActiveLayerChanged = () => {
      const activeWidget = this.getActiveWidget();
      if (activeWidget) {
        this.interpolation = activeWidget.value.interpolation || 'linear';
        this.points = this.getActivePoints();
      } else {
        this.points = [];
      }
      if (this.vis) {
        this.layerRenderer.render();
      }
    };

    this.updateAllPaths = () => {
      // Build widget array for backend (backend expects array of widget objects)
      const allWidgets = this.node.layerManager.getSplineWidgets();
      const allSplineData = [];

      for (const widget of allWidgets) {
          if (!widget.value.on) continue;

          let widgetCoordinates;
          try {
              widgetCoordinates = JSON.parse(widget.value.points_store || '[]');
          } catch (e) {
              console.error(`Error parsing points_store for ${widget.value.name}:`, e);
              widgetCoordinates = [];
          }

          const isHanddraw = widget?.value?.type === 'handdraw';
          const outInterpolation = isHanddraw ? 'linear' : (widget.value.interpolation || 'linear');

          allSplineData.push({
              on: widget.value.on,
              name: widget.value.name,
              interpolation: outInterpolation,
              repeat: widget.value.repeat || 1,
              points_store: widget.value.points_store,
              // Embed array directly; do not stringify so downstream sees points
              coordinates: widgetCoordinates
          });
      }

      if (this.coordWidget) {
        this.coordWidget.value = JSON.stringify(allSplineData);
      }
    };

    // Preserve existing callback (which may set userAdjustedDims flag)
    const originalWidthCallback = this.widthWidget.callback;
    this.widthWidget.callback = (value) => {
      // Call the existing callback first (preserves userAdjustedDims logic)
      if (originalWidthCallback) {
        originalWidthCallback.call(this.widthWidget, value);
      }

      this.width = this.widthWidget.value;

      // Update canvas dimensions
      this.vis.width(this.width);

      // Force size manager update when canvas width changes (force=true overrides userAdjustedSize)
      if (context.sizeManager) {
        context.sizeManager.updateSize(true);
      }

      // Recenter background image if it exists
      if (this.originalImageWidth && this.originalImageHeight) {
        this.recenterBackgroundImage();
      }

      // Reload points from active widget
      this.points = this.getActivePoints();

      this.updatePath();
      
      // Ensure canvas is rendered with new dimensions
      this.vis.render();
    }
    // Preserve existing callback (which may set userAdjustedDims flag)
    const originalHeightCallback = this.heightWidget.callback;
    this.heightWidget.callback = (value) => {
      // Call the existing callback first (preserves userAdjustedDims logic)
      if (originalHeightCallback) {
        originalHeightCallback.call(this.heightWidget, value);
      }

      this.height = this.heightWidget.value;

      // Update canvas dimensions
      this.vis.height(this.height);

      // Force size manager update when canvas height changes (force=true overrides userAdjustedSize)
      if (context.sizeManager) {
        context.sizeManager.updateSize(true);
      }

      // Recenter background image if it exists
      if (this.originalImageWidth && this.originalImageHeight) {
        this.recenterBackgroundImage();
      }

      // Reload points from active widget
      this.points = this.getActivePoints();

      this.updatePath();
      
      // Ensure canvas is rendered with new dimensions
      this.vis.render();
    }

    this.nextPointUid = 1;
    this.ensurePointUids = (points) => {
      if (!Array.isArray(points)) return;
      let nextUid = this.nextPointUid || 1;
      for (const point of points) {
        if (!point) continue;
        const rawUid = Number(point.uid);
        const hasUid = (point.uid !== undefined && point.uid !== null && !Number.isNaN(rawUid));
        if (hasUid) {
          const candidate = Math.max(nextUid, rawUid + 1);
          nextUid = candidate;
        } else {
          point.uid = nextUid;
          nextUid += 1;
        }
      }
      this.nextPointUid = nextUid;
    };

    this.clampScaleValue = (value) => {
      if (typeof value !== 'number' || Number.isNaN(value)) return 1;
      return Math.max(0.2, Math.min(3.0, value));
    };

    this.ensurePointScaleFields = (points) => {
      if (!Array.isArray(points)) return;
      for (const point of points) {
        if (!point) continue;
        const boxRaw = (typeof point.boxScale === 'number' && !Number.isNaN(point.boxScale))
          ? point.boxScale
          : ((typeof point.scale === 'number' && !Number.isNaN(point.scale)) ? point.scale : 1);
        point.boxScale = this.clampScaleValue(boxRaw);

        const pointRaw = (typeof point.pointScale === 'number' && !Number.isNaN(point.pointScale))
          ? point.pointScale
          : 1;
        point.pointScale = this.clampScaleValue(pointRaw);

        if (typeof point.scale !== 'number' || Number.isNaN(point.scale)) {
          point.scale = point.boxScale;
        } else {
          point.scale = this.clampScaleValue(point.scale);
        }
      }
    };

    this.getPointScaleForMode = (point, forBox = true) => {
      if (!point) return 1;
      const candidate = (() => {
        if (forBox && typeof point.boxScale === 'number' && !Number.isNaN(point.boxScale)) {
          return point.boxScale;
        }
        if (!forBox && typeof point.pointScale === 'number' && !Number.isNaN(point.pointScale)) {
          return point.pointScale;
        }
        if (typeof point.scale === 'number' && !Number.isNaN(point.scale)) {
          return point.scale;
        }
        return 1;
      })();
      return this.clampScaleValue(candidate);
    };

    // Initialize or reset points array
    this.drawRuler = true;
    this.hoverIndex = -1;
    this.isDragging = false;
    this.isDraggingAll = false; // Flag for Alt+middle-drag (translation)
    this.isScalingAll = false; // Flag for Alt+right-drag (scaling)
    this.isScalingPoint = false; // Flag for Alt+right-drag when box mode (point scale)
    this.scalingPointIndex = -1;
    this.scalingPointBaseScale = 1.0;
    this.scalingPointInitialDistance = 0;
    this.isRotatingAll = false; // Flag for Alt+left-drag (rotation)
    this.dragStartPos = null; // Store initial drag position
    this.initialXDistance = 0; // Store initial X distance for horizontal scaling
    this.initialRotationAngle = 0; // Store initial angle from anchor to mouse for rotation
    this.anchorPoint = null; // Store locked anchor point position during scaling/rotation
    this.anchorIndex = -1; // Store index of anchor point for rotation/scaling
    this.originalPoints = null; // Store original points before scaling/rotation
    this.dragOffset = null; // Store offset between mouse and point center during drag
    this.i = -1; // Initialize i, will be set during drag/add

    // Double-click tracking for layer switching
    this.lastCanvasClickTime = 0;
    this.lastCanvasClickPos = null;
    this.doubleClickDelay = 300; // ms

    // Load points from active widget
    this.points = this.getActivePoints();

    // If no points exist, initialize with defaults
    if (!this.points || this.points.length === 0) {
      if (reset) {
        // Two points: center and 40px right
        const centerX = this.width / 2;
        const centerY = this.height / 2;
      this.points = [
          { x: centerX, y: centerY, highlighted: false, scale: 1.0, boxScale: 1.0, pointScale: 1.0 },
          { x: centerX + 40, y: centerY, highlighted: false, scale: 1.0, boxScale: 1.0, pointScale: 1.0 }
        ];
      this.ensurePointUids(this.points);
      } else {
        // Default initial points (bottom-left, top-right)
        this.points = [
          { x: 0, y: this.height, highlighted: false, scale: 1.0, boxScale: 1.0, pointScale: 1.0 },
          { x: this.width, y: 0, highlighted: false, scale: 1.0, boxScale: 1.0, pointScale: 1.0 }
        ];
      this.ensurePointUids(this.points);
      }
      this.setActivePoints(this.points);
    }

    // Get interpolation from active widget
    const activeWidget = this.getActiveWidget();
    if (activeWidget) {
      this.interpolation = activeWidget.value.interpolation || 'linear';
    }

    this.vis = new pv.Panel()
      .width(this.width)
      .height(this.height)
      .fillStyle("#222")
      .strokeStyle("gray")
      .lineWidth(2)
      .antialias(false)
      .event("mousedown", (e) => {
        // Get mouse position (scaled for canvas)
        const mouseX = this.vis.mouse().x / app.canvas.ds.scale;
        const mouseY = this.vis.mouse().y / app.canvas.ds.scale;
        if (this._handdrawActive) {
          // Start capturing freehand path until mouseup on document
          this._handdrawPath = [{ x: mouseX, y: mouseY }];
          // Preview on active layer while drawing
          this.points = this._handdrawPath;
          this.layerRenderer.render();
          const canvasEl = this.vis.canvas();
          let lastAddX = mouseX, lastAddY = mouseY;
          const move = (ev) => {
            const rect = canvasEl.getBoundingClientRect();
            const mx = (ev.clientX - rect.left) / app.canvas.ds.scale;
            const my = (ev.clientY - rect.top) / app.canvas.ds.scale;
            // Only add if moved enough to reduce point density
            const dx = mx - lastAddX;
            const dy = my - lastAddY;
            if ((dx*dx + dy*dy) >= 36) { // 6px threshold
              this._handdrawPath.push({ x: mx, y: my });
              lastAddX = mx; lastAddY = my;
            }
            // Live preview
            this.points = this._handdrawPath;
            this.layerRenderer.render();
          };
          const up = (ev) => {
            ev.preventDefault?.();
            document.removeEventListener('mousemove', move, true);
            document.removeEventListener('mouseup', up, true);
            // Post-simplify to further reduce density (keep points ~6px apart)
            const minDist2 = 36; // 6px squared
            const simplified = [];
            for (let i = 0; i < this._handdrawPath.length; i++) {
              const p = this._handdrawPath[i];
              if (simplified.length === 0) { simplified.push(p); continue; }
              const lp = simplified[simplified.length - 1];
              const dx = p.x - lp.x; const dy = p.y - lp.y;
              if ((dx*dx + dy*dy) >= minDist2) simplified.push(p);
            }
            if (simplified.length > 1) {
              // ensure last point included
              const last = this._handdrawPath[this._handdrawPath.length - 1];
              const lp = simplified[simplified.length - 1];
              const dx = last.x - lp.x; const dy = last.y - lp.y;
              if ((dx*dx + dy*dy) >= 1) simplified.push(last);
            }
            // Normalize and commit
            const norm = this.normalizePoints(simplified);
            try { this.node?.commitHanddraw?.(norm); } catch {}
            // After committing, remain in current mode; clear temporary path
            this._handdrawPath = [];
            this._handdrawActive = (this._handdrawMode !== 'off');
            // Reload active points from widget and re-render
            this.points = this.getActivePoints();
            this.layerRenderer.render();
          };
          document.addEventListener('mousemove', move, true);
          document.addEventListener('mouseup', up, true);
          return this;
        }

        // Check for double-click on canvas
        const currentTime = Date.now();
        const timeSinceLastClick = currentTime - this.lastCanvasClickTime;
        let isDoubleClick = false;

        if (timeSinceLastClick < this.doubleClickDelay && this.lastCanvasClickPos) {
          const dx = Math.abs(mouseX - this.lastCanvasClickPos.x);
          const dy = Math.abs(mouseY - this.lastCanvasClickPos.y);
          isDoubleClick = (dx < 5 && dy < 5); // Within 5 pixel tolerance
        }

        if (isDoubleClick && !pv.event.shiftKey && !pv.event.ctrlKey && pv.event.button === 0) {
          // Double-click detected - check if we clicked on an inactive layer
          const clickedWidget = this.layerRenderer.findInactiveLayerAtPosition(mouseX, mouseY);

          if (clickedWidget) {
            // Switch to the clicked layer
            this.node.layerManager.setActiveWidget(clickedWidget);

            // Reset click tracking
            this.lastCanvasClickTime = 0;
            this.lastCanvasClickPos = null;
            return this;
          }
        }

        // Store this click for potential double-click detection
        this.lastCanvasClickTime = currentTime;
        this.lastCanvasClickPos = { x: mouseX, y: mouseY };

        // Existing mousedown handlers
        if (pv.event.shiftKey && pv.event.button === 0) { // Use pv.event to access the event object
          let scaledMouse = {
            x: mouseX,
            y: mouseY,
            highlighted: false,
            scale: 1.0,
            boxScale: 1.0,
            pointScale: 1.0,
            uid: this.nextPointUid++
          };
          this.i = this.points.push(scaledMouse) - 1;
          this.updatePath();
          return this;
        }
        else if (pv.event.ctrlKey) {
          // Capture the clicked location
          let clickedPoint = {
            x: mouseX,
            y: mouseY
          };

          // Find the two closest points to the clicked location
          let { point1Index, point2Index } = this.findClosestPoints(this.points, clickedPoint);

          // Calculate the midpoint between the two closest points
          let midpoint = {
            x: (this.points[point1Index].x + this.points[point2Index].x) / 2,
            y: (this.points[point1Index].y + this.points[point2Index].y) / 2,
            highlighted: false,
            scale: 1.0,
            boxScale: 1.0,
            pointScale: 1.0,
            uid: this.nextPointUid++
          };

          // Insert the midpoint into the array
          this.points.splice(point2Index, 0, midpoint);
          this.i = point2Index;
          this.updatePath();
        }
        else if (pv.event.button === 2) {
          // Right-click behavior: open custom canvas context menu and suppress native one
          try { pv.event.preventDefault?.(); pv.event.stopPropagation?.(); } catch {}

          const menuEl = this.node.contextMenu;
          // Update first menu item label based on active layer type
          try {
            const activeWidget = this.getActiveWidget?.();
            const isHanddraw = !!(activeWidget && activeWidget.value && activeWidget.value.type === 'handdraw');
            const firstItem = this.node.menuItems && this.node.menuItems[0];
            const smoothItem = this.node.menuItems && this.node.menuItems[1];
            if (firstItem) {
              firstItem.textContent = isHanddraw ? 'Edit' : 'Invert point order';
            }
            if (smoothItem) {
              smoothItem.style.display = isHanddraw ? 'block' : 'none';
            }
          } catch {}
          menuEl.style.display = 'block';
          menuEl.style.left = `${pv.event.clientX}px`;
          menuEl.style.top = `${pv.event.clientY}px`;
          menuEl.oncontextmenu = (evt) => { evt.preventDefault(); evt.stopPropagation(); };

          // Handlers to close menu and suppress browser menu while open
          const hideOnOutside = (ev) => {
            const target = ev && ev.target;
            // Ignore clicks inside LiteGraph dialogs/prompts
            const withinDialog = target && (target.closest?.('.litegraph .dialog') || target.closest?.('.litegraph.liteprompt') || target.closest?.('.litedialog'));
            if (withinDialog) return;
            if (!menuEl.contains(target)) {
              menuEl.style.display = 'none';
              cleanup();
            }
          };
          const preventBrowserMenu = (ev) => { ev.preventDefault(); };
          const onEsc = (ev) => { if (ev.key === 'Escape') { menuEl.style.display = 'none'; cleanup(); } };
          const cleanup = () => {
            document.removeEventListener('mousedown', hideOnOutside, true);
            document.removeEventListener('contextmenu', hideOnOutside, true);
            document.removeEventListener('contextmenu', preventBrowserMenu, true);
            document.removeEventListener('keydown', onEsc, true);
          };

          // Delay to avoid catching the opening event
          setTimeout(() => {
            document.addEventListener('mousedown', hideOnOutside, true);
            document.addEventListener('contextmenu', hideOnOutside, true);
            document.addEventListener('contextmenu', preventBrowserMenu, true);
            document.addEventListener('keydown', onEsc, true);
          }, 0);
        }
        // Middle click: exit any handdraw mode (edit/create) and keep current edits
        else if (pv.event.button === 1) {
          try { this.exitHanddrawMode(false); } catch {}
          try { this.layerRenderer?.render(); } catch {}
          try { this.node?.setDirtyCanvas?.(true, true); } catch {}
          return this;
        }
      })
      .event("mousemove", (e) => {
        const coords = this._getPointerCoords(pv.event || e);
        this.updateBoxCursor(coords);
      })
      .event("mouseout", () => {
        const canvasEl = this.vis?.canvas?.();
        if (canvasEl) canvasEl.style.cursor = 'default';
      })

    this.getBoxPointRadius = (point) => {
      const boxScale = this.getPointScaleForMode(point, true);
      return BOX_BASE_RADIUS * boxScale;
    };

    this.pickBoxPointFromCoords = (coords) => {
      if (!coords || !Array.isArray(this.points)) return null;
      const bandWidth = BOX_BORDER_BAND;
      let best = null;
      let bestEdgeDist = Infinity;
      for (let idx = 0; idx < this.points.length; idx++) {
        const point = this.points[idx];
        if (!point) continue;
        const dx = Math.abs(coords.x - (point.x ?? 0));
        const dy = Math.abs(coords.y - (point.y ?? 0));
        const maxDist = Math.max(dx, dy); // square border distance
        const radius = this.getBoxPointRadius(point);
        const inner = Math.max(radius - bandWidth, 0);
        if (maxDist < inner || maxDist > radius) {
          continue;
        }
        const edgeDist = Math.abs(radius - maxDist);
        if (
          edgeDist < bestEdgeDist ||
          (Math.abs(edgeDist - bestEdgeDist) < 1e-3 && radius < (best?.radius ?? Infinity))
        ) {
          bestEdgeDist = edgeDist;
          best = { point, index: idx, radius };
        }
      }
      return best;
    };

    this.resolvePointIndex = (dot) => {
      if (!Array.isArray(this.points) || !dot) {
        return -1;
      }
      const dotUid = dot?.uid;
      if (dotUid !== undefined && dotUid !== null) {
        for (let idx = 0; idx < this.points.length; idx++) {
          const p = this.points[idx];
          if (p && (p.uid === dotUid)) {
            return idx;
          }
        }
      }
      const directIdx = this.points.indexOf(dot);
      if (directIdx !== -1) {
        return directIdx;
      }
      let fallbackIdx = -1;
      let bestDist = Infinity;
      const dxDot = dot.x ?? 0;
      const dyDot = dot.y ?? 0;
      for (let idx = 0; idx < this.points.length; idx++) {
        const p = this.points[idx];
        if (!p) continue;
        const dx = (p.x ?? 0) - dxDot;
        const dy = (p.y ?? 0) - dyDot;
        const dist = dx * dx + dy * dy;
        if (dist <= 1e-4) {
          return idx;
        }
        if (dist < bestDist) {
          bestDist = dist;
          fallbackIdx = idx;
        }
      }
      return fallbackIdx;
    };

    this._getPointerCoords = (event) => {
      const canvasEl = this.vis?.canvas?.();
      if (!canvasEl || !event) {
        return { x: 0, y: 0 };
      }
      const e = (event.touches && event.touches.length > 0) ? event.touches[0] : event;
      const rect = canvasEl.getBoundingClientRect();
      const scale = app.canvas.ds.scale || 1;
      return {
        x: (e.clientX - rect.left) / scale,
        y: (e.clientY - rect.top) / scale
      };
    };

    this.updateBoxCursor = (coords) => {
      const canvasEl = this.vis?.canvas?.();
      if (!canvasEl) return;
      const activeInterp = this.getActiveWidget()?.value?.interpolation || this.interpolation;
      let desired = 'default';
      if (activeInterp === 'box' && coords) {
        const picked = this.pickBoxPointFromCoords(coords);
        if (picked) {
          desired = 'move';
        }
      }
      if (canvasEl.style.cursor !== desired) {
        canvasEl.style.cursor = desired;
      }
    };

    this.handlePointPointerDown = (dot, pvEvent) => {
      const event = pvEvent || window.event;
      if (!event) return;
      const { x, y } = this._getPointerCoords(event);
      const activeInterp = this.getActiveWidget()?.value?.interpolation || this.interpolation;
      let dragDot = dot;
      if (activeInterp === 'box') {
        const picked = this.pickBoxPointFromCoords({ x, y });
        if (!picked) {
          return;
        }
        dragDot = picked.point;
      }
      event.preventDefault?.();
      event.stopPropagation?.();
      this.dragStartHandler(dragDot, x, y, event);
      const dragTarget = dragDot;
      const needsTracking = this.isDragging || this.isDraggingAll || this.isScalingAll || this.isRotatingAll;
      if (!needsTracking) return;
      const usePointer = typeof PointerEvent !== 'undefined';
      const move = (evt) => {
        evt.preventDefault?.();
        const coords = this._getPointerCoords(evt);
        this.dragHandler(dragTarget, coords.x, coords.y);
      };
      const end = (evt) => {
        cleanup();
        this.dragEndHandler(evt);
      };
      const cleanup = () => {
        if (usePointer) {
          document.removeEventListener('pointermove', move, true);
          document.removeEventListener('pointerup', end, true);
          document.removeEventListener('pointercancel', end, true);
        } else {
          document.removeEventListener('mousemove', move, true);
          document.removeEventListener('mouseup', end, true);
        }
      };
      if (usePointer) {
        document.addEventListener('pointermove', move, true);
        document.addEventListener('pointerup', end, true);
        document.addEventListener('pointercancel', end, true);
      } else {
        document.addEventListener('mousemove', move, true);
        document.addEventListener('mouseup', end, true);
      }
    };

    this.dragStartHandler = (d, mouseX, mouseY, rawEvent) => {
        const dot = d;
        this.i = this.resolvePointIndex(dot);
        this.hoverIndex = this.i;
        if (this.i === -1 || !this.points[this.i]) {
          console.warn("[SplineEditor] dragStartHandler: unable to resolve point for drag", dot);
          return;
        }

        let localX = mouseX;
        let localY = mouseY;
        if (typeof localX !== 'number' || typeof localY !== 'number') {
          const coords = this._getPointerCoords(rawEvent || pv.event);
          localX = coords.x;
          localY = coords.y;
        }
        const pointX = this.points[this.i].x;
        const pointY = this.points[this.i].y;
        this.dragOffset = { x: pointX - localX, y: pointY - localY };

        // Shift+Middle-Click: Toggle highlighted state on points (except first point)
        if ((rawEvent?.shiftKey) && (rawEvent?.button === 1)) {
          if (this.i !== 0 && this.i !== -1) {
            this.points[this.i].highlighted = !this.points[this.i].highlighted;
            this.layerRenderer.render();
            this.updatePath();
          }
          return;
        }

        // Alt+Left-Click: Rotation around clicked point (any point)
        if ((rawEvent?.altKey) && (rawEvent?.button === 0)) {
          this.isRotatingAll = true;
          this.originalPoints = this.points.map(p => ({ ...p }));
          this.anchorPoint = { ...this.points[this.i] }; // Use clicked point as anchor
          this.anchorIndex = this.i; // Store anchor index
          this.initialRotationAngle = Math.atan2(localY - this.anchorPoint.y, localX - this.anchorPoint.x);
          this.isDragging = true;
          return;
        }

        // Alt + Middle-Click: Translation (any point)
        if ((rawEvent?.altKey) && (rawEvent?.button === 1)) {
          this.isDraggingAll = true;
          this.dragStartPos = { x: localX, y: localY };
          // Snapshot original positions to keep a rigid translation anchored at clicked point
          this.translateAllSnapshot = {
            points: this.points.map(p => ({ ...p })),
            pivotIndex: this.i,
            pivotX: this.points[this.i].x,
            pivotY: this.points[this.i].y,
            offsetX: this.dragOffset ? this.dragOffset.x : 0,
            offsetY: this.dragOffset ? this.dragOffset.y : 0,
          };
          // Provide a neutral fix object so Protovis drag doesn't apply extra offsets
          try { if (dot && typeof dot === 'object') { dot.fix = { x: 0, y: 0 }; } } catch {}
          this.isDragging = true;
          return;
        }

        // Alt+Right-Click: Scaling relative to clicked point (any point)
        if ((rawEvent?.altKey) && (rawEvent?.button === 2)) {
          const activeInterp = this.getActiveWidget()?.value?.interpolation || this.interpolation;
          if (activeInterp === 'box') {
            this.isScalingPoint = true;
            this.scalingPointIndex = this.i;
            const targetPoint = this.points[this.i];
            if (!targetPoint) {
              this.isScalingPoint = false;
              return;
            }
            this.scalingPointBaseScale = (targetPoint.scale || 1.0);
            this.scalingPointInitialDistance = localX - targetPoint.x;
            if (Math.abs(this.scalingPointInitialDistance) < 10) {
              this.scalingPointInitialDistance = this.scalingPointInitialDistance >= 0 ? 10 : -10;
            }
            this.isDragging = true;
            return;
          }
          this.isScalingAll = true;
          this.originalPoints = this.points.map(p => ({ ...p }));
          this.anchorPoint = { ...this.points[this.i] }; // Use clicked point as anchor
          this.anchorIndex = this.i; // Store anchor index
          this.initialXDistance = localX - this.anchorPoint.x;
          if (Math.abs(this.initialXDistance) < 10) {
            this.initialXDistance = this.initialXDistance >= 0 ? 10 : -10;
          }
          this.isDragging = true;
          return;
        }

        // Regular drag or delete
        this.isDragging = true;
        if ((rawEvent?.button === 2) && this.i !== 0 && this.i !== this.points.length - 1) {
          this.points.splice(this.i--, 1);
          this._forceRebuildNextRender = true;
          this.layerRenderer.render();
        }
    };

    this.dragEndHandler = () => {
        if (this.isScalingAll || this.isRotatingAll) {
          this.setActivePoints(this.points);
        }
        if (this.pathElements !== null) {
          this.updatePath();
        }
        // Clear any protovis drag fix offsets left on data objects
        try { if (Array.isArray(this.points)) { for (const p of this.points) { if (p && p.fix !== undefined) delete p.fix; } } } catch {}
        this.translateAllSnapshot = null;
        this.dragOffset = null;
        this.isDragging = false;
        this.isDraggingAll = false;
        this.isScalingAll = false;
        this.isScalingPoint = false;
        this.scalingPointIndex = -1;
        this.scalingPointBaseScale = 1.0;
        this.scalingPointInitialDistance = 0;
        this.isRotatingAll = false;
        this.dragStartPos = null;
        this.initialXDistance = 0;
        this.initialRotationAngle = 0;
        this.anchorPoint = null;
        this.anchorIndex = -1;
        this.originalPoints = null;
    };

    this.dragHandler = (d, mouseX, mouseY) => {
        let adjustedX = (typeof mouseX === 'number') ? mouseX : (this.vis.mouse().x / app.canvas.ds.scale);
        let adjustedY = (typeof mouseY === 'number') ? mouseY : (this.vis.mouse().y / app.canvas.ds.scale);

        if (this.isRotatingAll && this.anchorPoint && this.originalPoints) {
            const currentAngle = Math.atan2(adjustedY - this.anchorPoint.y, adjustedX - this.anchorPoint.x);
          const rotationAngle = currentAngle - this.initialRotationAngle;
          const cos = Math.cos(rotationAngle);
          const sin = Math.sin(rotationAngle);

          // Rotate all points around the anchor point
          for (let j = 0; j < this.originalPoints.length; j++) {
            const originalPoint = this.originalPoints[j];
            if (j === this.anchorIndex) {
              // Keep anchor point fixed
              this.points[j].x = this.anchorPoint.x;
              this.points[j].y = this.anchorPoint.y;
              this.points[j].highlighted = !!originalPoint.highlighted;
            } else {
              const vecX = originalPoint.x - this.anchorPoint.x;
              const vecY = originalPoint.y - this.anchorPoint.y;
              const rotatedX = vecX * cos - vecY * sin;
              const rotatedY = vecX * sin + vecY * cos;
              this.points[j].x = this.anchorPoint.x + rotatedX;
              this.points[j].y = this.anchorPoint.y + rotatedY;
              this.points[j].highlighted = !!originalPoint.highlighted;
            }
          }
          this.layerRenderer.render();
          return;
        }

        if (this.isDraggingAll && this.dragStartPos) {
          // Rigid translation anchored at originally clicked point using snapshot
          const snap = this.translateAllSnapshot;
          const desiredX = adjustedX + (snap ? snap.offsetX : (this.dragOffset ? this.dragOffset.x : 0));
          const desiredY = adjustedY + (snap ? snap.offsetY : (this.dragOffset ? this.dragOffset.y : 0));
          const basePivotX = snap ? snap.pivotX : this.dragStartPos.x;
          const basePivotY = snap ? snap.pivotY : this.dragStartPos.y;
          const deltaX = desiredX - basePivotX;
          const deltaY = desiredY - basePivotY;
          try { if (d && typeof d === 'object') { d.fix = { x: 0, y: 0 }; } } catch {}
          const basePoints = snap ? snap.points : this.points;
          for (let j = 0; j < this.points.length; j++) {
            const bp = basePoints[j] || this.points[j];
            this.points[j].x = bp.x + deltaX;
            this.points[j].y = bp.y + deltaY;
            this.points[j].highlighted = !!this.points[j].highlighted;
          }
          this.layerRenderer.render();
          return;
        }

        if (this.isScalingPoint && this.scalingPointIndex >= 0 && this.scalingPointInitialDistance !== 0) {
          const point = this.points[this.scalingPointIndex];
          if (point) {
            const currentXDistance = adjustedX - point.x;
            const scaleFactor = currentXDistance / this.scalingPointInitialDistance;
            const dampingFactor = 0.1;
            const dampedFactor = 1.0 + (scaleFactor - 1.0) * dampingFactor;
            const newScale = Math.max(0.2, Math.min(3.0, this.scalingPointBaseScale * dampedFactor));
            point.boxScale = newScale;
            point.scale = newScale;
            this.layerRenderer.render();
          }
          return;
        }

        if (this.isScalingAll && this.anchorPoint && this.originalPoints && this.initialXDistance !== 0) {
            const currentXDistance = adjustedX - this.anchorPoint.x;
            const scaleFactor = currentXDistance / this.initialXDistance;
          const dampingFactor = 0.1;
          const dampedScaleFactor = 1.0 + (scaleFactor - 1.0) * dampingFactor;
          const clampedScaleFactor = Math.max(0.1, Math.min(10, dampedScaleFactor));

          // Scale all points relative to the anchor point
          for (let j = 0; j < this.originalPoints.length; j++) {
            const originalPoint = this.originalPoints[j];
            if (j === this.anchorIndex) {
              // Keep anchor point fixed
              this.points[j].x = this.anchorPoint.x;
              this.points[j].y = this.anchorPoint.y;
              this.points[j].highlighted = !!originalPoint.highlighted;
            } else {
              const vecX = originalPoint.x - this.anchorPoint.x;
              const vecY = originalPoint.y - this.anchorPoint.y;
              this.points[j].x = this.anchorPoint.x + vecX * clampedScaleFactor;
              this.points[j].y = this.anchorPoint.y + vecY * clampedScaleFactor;
              this.points[j].highlighted = !!originalPoint.highlighted;
            }
          }
          this.layerRenderer.render();
          return;
        }

        if (!this.isDraggingAll && !this.isScalingAll && !this.isRotatingAll) {
          if (this.dragOffset && this.i >= 0 && this.points[this.i]) {
            this.points[this.i].x = adjustedX + this.dragOffset.x;
            this.points[this.i].y = adjustedY + this.dragOffset.y;
            this.points[this.i].highlighted = !!this.points[this.i].highlighted;
          }
          this.layerRenderer.render();
        }
    };

    this.mouseOverHandler = (d) => {
        this.hoverIndex = this.resolvePointIndex(d);
        // Avoid rebuilding the scene on hover; a simple re-render is sufficient
        if (this.layerRenderer?.vis) this.layerRenderer.vis.render();
    };

    this.mouseOutHandler = () => {
        if (!this.isDragging) {
            this.hoverIndex = -1;
        }
        // Avoid rebuilding the scene on hover out
        if (this.layerRenderer?.vis) this.layerRenderer.vis.render();
    };
      
    this.backgroundImage = this.vis.add(pv.Image).visible(false)

    this.vis.add(pv.Rule)
      .data(pv.range(0, this.height, 64))
      .bottom(d => d)
      .strokeStyle("gray")
      .lineWidth(3)
      .visible(() => this.drawRuler)

    // Helper to get render points with duplicates at highlighted positions
    // This forces hard corners while keeping the curve continuous
    this.getRenderPoints = () => {
      if (this.interpolation === 'linear' || this.interpolation === 'points' || this.interpolation === 'box') {
        return this.points;
      }

      // Check if any points are highlighted
      const hasAnyHighlighted = this.points.some(p => p.highlighted);
      if (!hasAnyHighlighted) {
        return this.points;
      }

      // Insert duplicate points at highlighted positions to force linear segments
      const renderPoints = [];
      for (let i = 0; i < this.points.length; i++) {
        const point = this.points[i];

        if (point.highlighted) {
          // Add a point slightly before (for incoming linear segment)
          if (i > 0) {
            const prevPoint = this.points[i - 1];
            const dx = point.x - prevPoint.x;
            const dy = point.y - prevPoint.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const offset = Math.min(0.01, 1 / dist); // Very small offset
            renderPoints.push({
              x: prevPoint.x + dx * (1 - offset),
              y: prevPoint.y + dy * (1 - offset),
              _helper: true
            });
          }

          // Add the highlighted point itself
          renderPoints.push(point);

          // Add a point slightly after (for outgoing linear segment)
          if (i < this.points.length - 1) {
            const nextPoint = this.points[i + 1];
            const dx = nextPoint.x - point.x;
            const dy = nextPoint.y - point.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const offset = Math.min(0.01, 1 / dist); // Very small offset
            renderPoints.push({
              x: point.x + dx * offset,
              y: point.y + dy * offset,
              _helper: true
            });
          }
        } else {
          renderPoints.push(point);
        }
      }

      return renderPoints;
    };

    this.layerRenderer = new LayerRenderer(this, this.vis);

    if (this.points.length != 0) {
      this.vis.render();
    }
    var svgElement = this.vis.canvas();
    svgElement.style['zIndex'] = "2"
    svgElement.style['position'] = "relative"
    svgElement.style['display'] = "block"
    this.node.splineEditor2.parentEl.appendChild(svgElement);
    // Let the size manager handle height - don't set explicit height here
    this.pathElements = svgElement.getElementsByTagName('path'); // Get all path elements

    // Update node size to match current dimensions
    if (context.sizeManager) {
      context.sizeManager.updateSize(true);
    }

    this.updatePath();
    this.refreshBackgroundImage();
  }

  normalizePoints(points) {
    return points.map(p => {
      const { x, y } = p;
      let nx, ny;
      if (this.originalImageWidth && this.originalImageHeight && this.scale > 0) {
        const relX = x - this.offsetX;
        const relY = y - this.offsetY;
        const origX = relX / this.scale;
        const origY = relY / this.scale;
        nx = origX / this.originalImageWidth;
        ny = origY / this.originalImageHeight;
      } else {
        nx = x / this.width;
        ny = y / this.height;
      }
      return { ...p, x: nx, y: ny };
    });
  }

  denormalizePoints(points) {
    // Backward compatibility check - allow points outside 0-1 range (negative zone or >1)
    // Normalized values should be small (typically -10 to 10), old pixel coords are large (640+)
    const isNormalized = points.every(p => Math.abs(p.x) < 10 && Math.abs(p.y) < 10);
    if (!isNormalized) {
        // Old format, just use it as is.
        return points;
    }

    return points.map(p => {
      const { x: nx, y: ny } = p;
      let x, y;
      if (this.originalImageWidth && this.originalImageHeight && this.scale > 0) {
        const origX = nx * this.originalImageWidth;
        const origY = ny * this.originalImageHeight;
        x = (origX * this.scale) + this.offsetX;
        y = (origY * this.scale) + this.offsetY;
      } else {
        x = nx * this.width;
        y = ny * this.height;
      }
      return { ...p, x, y };
    });
  }

  smoothActiveHanddraw(tolerancePx, relaxStrength = 0.15, relaxIterations = 1) {
    const activeWidget = this.getActiveWidget?.();
    if (!activeWidget || activeWidget.value?.type !== 'handdraw') {
      return false;
    }

    let storedPoints = [];
    try {
      storedPoints = JSON.parse(activeWidget.value.points_store || '[]');
    } catch (e) {
      console.error("[SplineEditor] smoothActiveHanddraw: failed to parse points_store", e);
      return false;
    }
    if (!Array.isArray(storedPoints) || storedPoints.length < 3) {
      return false;
    }

    const denorm = this.denormalizePoints(storedPoints);
    if (!Array.isArray(denorm) || denorm.length < 3) {
      return false;
    }

    const desiredCount = Math.max(2, Math.round(denorm.length * 0.7));
    const maxReduction = Math.max(2, denorm.length - 1);
    let targetCount = Math.min(desiredCount, maxReduction);
    if (targetCount >= denorm.length && denorm.length > 2) {
      targetCount = denorm.length - 1;
    }
    targetCount = Math.max(2, Math.min(targetCount, denorm.length));

    const resampled = this.resampleStroke(denorm, targetCount);
    const relaxed = this.relaxStrokePoints(resampled, relaxIterations, relaxStrength);
    if (!relaxed || relaxed.length < 2) {
      return false;
    }

    this.points = relaxed;
    this.setActivePoints(relaxed);
    try { this.layerRenderer?.render(); } catch {}
    try { this.node?.setDirtyCanvas?.(true, true); } catch {}
    return true;
  }

  simplifyStrokePoints(points, tolerancePx = 10) {
    if (!Array.isArray(points) || points.length <= 2) {
      return Array.isArray(points) ? points.slice() : [];
    }
    const len = points.length;
    const sqTolerance = Math.max(4, tolerancePx) ** 2;
    const markers = new Uint8Array(len);
    const stack = [[0, len - 1]];
    markers[0] = 1;
    markers[len - 1] = 1;

    while (stack.length) {
      const [first, last] = stack.pop();
      if (last <= first + 1) {
        continue;
      }
      let maxSqDist = 0;
      let index = -1;
      for (let i = first + 1; i < last; i++) {
        const sqDist = this.pointSegmentDistanceSq(points[i], points[first], points[last]);
        if (sqDist > maxSqDist) {
          index = i;
          maxSqDist = sqDist;
        }
      }
      if (maxSqDist > sqTolerance && index !== -1) {
        markers[index] = 1;
        stack.push([first, index], [index, last]);
      }
    }

    const simplified = [];
    for (let i = 0; i < len; i++) {
      if (markers[i]) {
        simplified.push({ ...points[i], highlighted: false });
      }
    }

    // Ensure the final point is included exactly once
    if (simplified.length === 0) {
      simplified.push({ ...points[0], highlighted: false });
      if (len > 1) {
        simplified.push({ ...points[len - 1], highlighted: false });
      }
    } else if (simplified[simplified.length - 1] !== points[len - 1]) {
      simplified[simplified.length - 1] = { ...points[len - 1], highlighted: false };
    }

    // Secondary pass to enforce minimum spacing so we actually reduce point count
    const spacing = Math.max(1, Math.max(baseTolerance, tolerancePx || baseTolerance) * 0.2);
    const spacingSq = spacing * spacing;
    const filtered = [];
    for (let i = 0; i < simplified.length; i++) {
      const pt = simplified[i];
      if (i === 0) {
        filtered.push(pt);
        continue;
      }
      if (i === simplified.length - 1) {
        filtered.push(pt);
        continue;
      }
      const last = filtered[filtered.length - 1];
      const dx = pt.x - last.x;
      const dy = pt.y - last.y;
      if ((dx * dx + dy * dy) >= spacingSq) {
        filtered.push(pt);
      }
    }
    if (filtered.length < 2) {
      filtered.length = 0;
      filtered.push({ ...points[0], highlighted: false });
      filtered.push({ ...points[len - 1], highlighted: false });
    } else {
      filtered[filtered.length - 1] = { ...points[len - 1], highlighted: false };
    }

    return filtered;
  }

  relaxStrokePoints(points, iterations = 2, strength = 0.45) {
    if (!Array.isArray(points) || points.length <= 2) {
      return Array.isArray(points) ? points.slice() : [];
    }
    const clampedStrength = Math.max(0, Math.min(1, strength));
    let current = points.map(p => ({ ...p, highlighted: false }));
    for (let iter = 0; iter < Math.max(1, iterations); iter++) {
      const next = current.map((p, idx) => {
        if (idx === 0) {
          return { ...points[0], highlighted: false };
        }
        if (idx === current.length - 1) {
          return { ...points[points.length - 1], highlighted: false };
        }
        const prev = current[idx - 1];
        const after = current[idx + 1];
        return {
          ...p,
          x: p.x * (1 - clampedStrength) + ((prev.x + after.x) * 0.5) * clampedStrength,
          y: p.y * (1 - clampedStrength) + ((prev.y + after.y) * 0.5) * clampedStrength,
          highlighted: false
        };
      });
      current = next;
    }
    return current;
  }

  pointSegmentDistanceSq(point, start, end) {
    let x = start.x;
    let y = start.y;
    let dx = end.x - start.x;
    let dy = end.y - start.y;

    if (dx !== 0 || dy !== 0) {
      const t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy);
      if (t > 1) {
        x = end.x;
        y = end.y;
      } else if (t > 0) {
        x += dx * t;
        y += dy * t;
      }
    }

    dx = point.x - x;
    dy = point.y - y;
    return dx * dx + dy * dy;
  }

  resampleStroke(points, targetCount) {
    if (!Array.isArray(points) || points.length === 0) {
      return [];
    }
    if (points.length === 1) {
      return [{ ...points[0], highlighted: false }];
    }
    const sanitizedCount = Math.max(2, Math.min(targetCount, points.length));
    const cumulative = new Array(points.length).fill(0);
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const dx = (curr.x ?? 0) - (prev.x ?? 0);
      const dy = (curr.y ?? 0) - (prev.y ?? 0);
      cumulative[i] = cumulative[i - 1] + Math.hypot(dx, dy);
    }
    const totalLength = cumulative[cumulative.length - 1];
    const result = [];
    for (let i = 0; i < sanitizedCount; i++) {
      const t = sanitizedCount === 1 ? 0 : i / (sanitizedCount - 1);
      const targetLen = totalLength * t;
      let segmentIndex = 0;
      while (segmentIndex < cumulative.length - 1 && cumulative[segmentIndex + 1] < targetLen) {
        segmentIndex++;
      }
      if (segmentIndex >= points.length - 1) {
        segmentIndex = points.length - 2;
      }
      const segStart = points[segmentIndex];
      const segEnd = points[segmentIndex + 1] || segStart;
      const startLen = cumulative[segmentIndex];
      const segLen = (cumulative[segmentIndex + 1] ?? startLen) - startLen;
      const localLen = targetLen - startLen;
      const ratio = segLen <= 0 ? 0 : Math.max(0, Math.min(1, localLen / segLen));
      result.push({
        x: segStart.x + (segEnd.x - segStart.x) * ratio,
        y: segStart.y + (segEnd.y - segStart.y) * ratio,
        highlighted: false
      });
    }
    if (result.length) {
      result[0] = { ...points[0], highlighted: false };
      result[result.length - 1] = { ...points[points.length - 1], highlighted: false };
    }
    return result;
  }

  updatePath = () => {
    if (!this.points || this.points.length === 0) {
      return;
    }

    // Return early if vis isn't created yet
    if (!this.vis) {
      console.warn("[SplineEditor] updatePath: vis not ready");
      return;
    }

    // Save current points to active widget
    const activeWidget = this.getActiveWidget();
    if (activeWidget) {
      activeWidget.value.points_store = JSON.stringify(this.normalizePoints(this.points));
    }

    // Re-render previous splines to ensure they persist
    this.renderPreviousSplines();

    // Render active and inactive layers; ensure active panel is on top for hit testing
    this.layerRenderer.render();

    // Let the size manager handle container height
    // Don't set explicit height here - it will be managed by the size manager

    if (this.pointsLayer) {
      // Clear any previously drawn sample points if the layer exists
      this.pointsLayer.data([]);
    }

    // Build widget array for backend (backend expects array of widget objects)
    const allWidgets = this.node.layerManager.getSplineWidgets();
    const onWidgets = allWidgets.filter(w => w.value.on);
    const allSplineData = [];
    

    // Assumption: layer_renderer renders paths in the same order as onWidgets.
    // We filter out known non-spline paths.
    const pathElements = this.vis.canvas().getElementsByTagName('path');
    const normalizeStroke = (stroke) => (stroke || '').replace(/\s+/g, '').toLowerCase();
    const EXCLUDED_STROKES = new Set([
        'rgba(255,255,255,0.5)', // previous splines overlay
        'rgb(255,255,255)',
        '#ffffff',
        'rgba(255,127,14,0.5)', // inactive layers
        'rgb(255,127,14)',
        '#ff7f0e',
        'rgb(0,128,0)' // first-point marker
    ]);

    const splinePaths = Array.from(pathElements).filter(p => {
        const stroke = normalizeStroke(p.getAttribute('stroke'));
        return !EXCLUDED_STROKES.has(stroke);
    });

    const usePathSampling = splinePaths.length === onWidgets.length;
    if (!usePathSampling) {
        console.warn(`Spline path/widget count mismatch. Paths: ${splinePaths.length}, Widgets: ${onWidgets.length}. Falling back to control points.`);
    }

    let pathIndex = 0;
    for (const widget of onWidgets) {
        const pathElement = usePathSampling ? splinePaths[pathIndex++] : null;
        let sampledCoords;

        // Get control points for the current widget
        let controlPoints;
        const activeWidget = this.getActiveWidget();
        if (widget === activeWidget) {
            controlPoints = this.points; // Live points
        } else {
            try {
                controlPoints = this.denormalizePoints(JSON.parse(widget.value.points_store || '[]'));
            } catch (e) {
                controlPoints = [];
            }
        }

        if (widget.value.interpolation === 'points' || widget.value.interpolation === 'box' || !usePathSampling) {
            sampledCoords = controlPoints;
        } else if (pathElement) {
            sampledCoords = [];
            const pathLength = pathElement.getTotalLength();
            if (pathLength > 0) {
                const numSamples = Math.max(100, controlPoints.length * 20);
                for (let j = 0; j < numSamples; j++) {
                    const distance = (pathLength / (numSamples - 1)) * j;
                    const point = pathElement.getPointAtLength(distance);
                    sampledCoords.push(point);
                }
            } else {
                sampledCoords = controlPoints; // Fallback for zero-length paths
            }
        } else {
            sampledCoords = controlPoints; // Fallback if path not found
        }

        const normalizedCoords = this.normalizePoints(sampledCoords);
        

        // Compute driver-offset inheritance for driven POINTS layers
        const isHanddraw = widget?.value?.type === 'handdraw';
        const interp = widget.value.interpolation || 'linear';
        const outInterpolation = isHanddraw ? 'linear' : interp;
        const isDrivenOn = !!widget.value.driven;
        const driverName = widget.value._drivenConfig?.driver;
        let driver_offset_inherit = 0;
        if (isDrivenOn && driverName && driverName !== 'None') {
          // Find the driver widget by its name among all widgets
          const driverWidget = onWidgets.find(w => (w?.value?.name) === driverName) 
                              || allWidgets.find(w => (w?.value?.name) === driverName);
          if (driverWidget && driverWidget.value) {
            const dOff = Number(driverWidget.value.offset || 0) || 0;
            const dAPause = Number(driverWidget.value.a_pause || 0) || 0;
            const dZPause = Number(driverWidget.value.z_pause || 0) || 0;
            // Offset can delay (positive) or start early (negative). Pauses only delay.
            // Inherit driver's offset directly and add driver's A/Z pauses.
            driver_offset_inherit = dOff + dAPause + dZPause;
          }
        }

        allSplineData.push({
            on: widget.value.on,
            name: widget.value.name,
            interpolation: outInterpolation,
            type: widget.value.type || 'spline',
            repeat: widget.value.repeat || 1,
            offset: widget.value.offset || 0,
            a_pause: widget.value.a_pause || 0,
            z_pause: widget.value.z_pause || 0,
            driven: !!widget.value.driven,
            driver: driverName || "",
            driver_offset_inherit,
            points_store: widget.value.points_store, // Always store the raw control points
            coordinates: normalizedCoords
        });
    }

    // Output widget array to backend
    if (this.coordWidget) {
        const coordString = JSON.stringify(allSplineData);
        this.coordWidget.value = coordString;
        
    } else {
        console.warn(`[updatePath] WARNING: coordWidget is null/undefined!`);
    }
  };
  recenterBackgroundImage = () => {
    if (this.originalImageWidth && this.originalImageHeight) {
      const targetWidth = this.width - 80; // 40px border on each side
      const targetHeight = this.height - 80;
      const scale = Math.min(targetWidth / this.originalImageWidth, targetHeight / this.originalImageHeight);
      this.scale = scale;
      const newWidth = this.originalImageWidth * this.scale;
      const newHeight = this.originalImageHeight * this.scale;
      this.offsetX = (this.width - newWidth) / 2;
      this.offsetY = (this.height - newHeight) / 2;

      this.backgroundImage
        .width(newWidth)
        .height(newHeight)
        .left(this.offsetX)
        .top(this.offsetY)
        .visible(true)
        .root.render();
    }
  };

  handleImageLoad = (img, file, base64String) => {

    // Image dimensions are used for scaling, not resizing the panel
    this.drawRuler = false;

    // Store new original dimensions
    this.originalImageWidth = img.width;
    this.originalImageHeight = img.height;


    const imageUrl = file ? URL.createObjectURL(file) : `data:${this.node.imgData.type};base64,${base64String}`;

    this.backgroundImage.url(imageUrl);


    // Calculate new scale and offsets
    this.recenterBackgroundImage();

    // Reload and denormalize points from active widget to fit the new image
    const activeWidget = this.getActiveWidget();
    if (activeWidget && activeWidget.value.points_store) {

        try {
            let storedPoints = JSON.parse(activeWidget.value.points_store);
            this.points = this.denormalizePoints(storedPoints);

        } catch (e) {
            console.error("Error parsing points from active widget during image load:", e);
        }
    } else {

    }

    // Call updatePath after image details are set and rendered

    this.updatePath();
    
    // Force a canvas render to ensure the image is displayed
    if (this.vis) {
      this.vis.render();
    }
    
    // Force layer renderer to ensure all layers are displayed
    if (this.layerRenderer) {
      this.layerRenderer.render();
    }
    
  };

  processImage = (img, file) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // Use original dimensions for Base64 generation, scaling happens on display
    let width = img.width;
    let height = img.height;

    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(img, 0, 0, width, height); // Draw original image

    // Get the compressed image data as a Base64 string
    const base64String = canvas.toDataURL('image/jpeg', 0.5).replace('data:', '').replace(/^.+,/, ''); // 0.5 is the quality from 0 to 1

    this.node.imgData = {
      name: file.name,
      lastModified: file.lastModified,
      size: file.size,
      type: file.type,
      base64: base64String
    };
    try {
      sessionStorage.setItem(`spline-editor-img-${this.node.uuid}`, JSON.stringify(this.node.imgData));
    } catch (e) {
      console.error("Spline Editor: Could not save image to session storage", e);
    }
    handleImageLoad(img, file, base64String);
  };

  handleImageFile = (file) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const img = new Image();
      img.src = reader.result;
      img.onload = () => processImage(img, file);
    };
    reader.readAsDataURL(file);

    const imageUrl = URL.createObjectURL(file);
    const img = new Image();
    img.src = imageUrl;
    img.onload = () => this.handleImageLoad(img, file, null);
  };

  refreshBackgroundImage = () => {
    if (this.node.imgData && this.node.imgData.base64) {
      const base64String = this.node.imgData.base64;
      const imageUrl = `data:${this.node.imgData.type};base64,${base64String}`;
      const img = new Image();
      img.src = imageUrl;
      img.onload = () => {
        this.handleImageLoad(img, null, base64String);
        // Re-render previous splines with updated transformations
        this.renderPreviousSplines();
        this.layerRenderer.render();
      };
      img.onerror = (error) => {
        console.error(`refreshBackgroundImage: Failed to load image:`, error);
      };
    } else {
    }
  };

  createContextMenu = () => {
    // Avoid global handlers that interfere with dialogs/prompts.

    this.node.menuItems.forEach((menuItem, index) => {
      menuItem.addEventListener('click', (e) => {
        e.preventDefault();
        // Scoped handlers to hide menus; ignore clicks inside LiteGraph dialogs/prompts
        const hideOpenMenus = (ev) => {
          const target = ev && ev.target;
          const withinDialog = target && (target.closest?.('.litegraph .dialog') || target.closest?.('.litegraph.liteprompt') || target.closest?.('.litedialog'));
          if (withinDialog) return;
          document.querySelectorAll('.spline-editor-context-menu').forEach(menu => {
            menu.style.display = 'none';
          });
          document.removeEventListener('click', hideOpenMenus, true);
          document.removeEventListener('contextmenu', hideOpenMenus, true);
        };
        document.addEventListener('click', hideOpenMenus, true);
        document.addEventListener('contextmenu', hideOpenMenus, true);
        switch (index) {
          case 0:
            // Context action depends on active layer type
            e.preventDefault();
            const aw = this.getActiveWidget?.();
            const isHand = !!(aw && aw.value && aw.value.type === 'handdraw');
            if (isHand) {
              // Enter edit mode for the active handdraw layer
              try { this.enterHanddrawMode('edit', aw); } catch {}
              try { this.layerRenderer?.render(); } catch {}
            } else {
              // Invert point order for non-handdraw layers
              this.points.reverse();
              this.updatePath();
            }
            this.node.contextMenu.style.display = 'none';
            break;
          case 1:
            // Smooth active handdraw layer (hidden for non-handdraw layers)
            e.preventDefault();
            this.smoothActiveHanddraw?.();
            this.node.contextMenu.style.display = 'none';
            break;
          case 2:
            // Delete spline
            e.preventDefault();
            const activeWidget = this.getActiveWidget();
            if (activeWidget) {
              this.node.layerManager.removeSpline(activeWidget);
            }
            this.node.contextMenu.style.display = 'none';
            break;
          case 3:
            // Background image
            // Create file input element
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*'; // Accept only image files

            // Listen for file selection
            fileInput.addEventListener('change', (event) => {
              const file = event.target.files[0]; // Get the selected file

              if (file) {
                const imageUrl = URL.createObjectURL(file);
                let img = new Image();
                img.src = imageUrl;
                img.onload = () => this.handleImageLoad(img, file, null);
              }
            });

            fileInput.click();

            this.node.contextMenu.style.display = 'none';
            break;
          case 4:
            // Clear Image
            this.backgroundImage.visible(false); // Hide image
            this.layerRenderer.render(); // Re-render to show changes
            // Reset stored image details
            this.originalImageWidth = null;
            this.originalImageHeight = null;
            this.scale = 1;
            this.offsetX = 0;
            this.offsetY = 0;
            this.node.imgData = null;
            sessionStorage.removeItem(`spline-editor-img-${this.node.uuid}`);
            this.node.contextMenu.style.display = 'none';
            this.updatePath(); // Update coordinates after clearing image
            break;
          case 5:
            // Remove all splines
            e.preventDefault();
            this.node.layerManager.removeAllSplines();
            this.node.contextMenu.style.display = 'none';
            break;
        }
      });
    });
  }

  samplePoints(svgPathElement, numSamples, samplingMethod, width) {
    var svgWidth = width; // Fixed width of the SVG element
    var pathLength = svgPathElement.getTotalLength();
    var points = [];

    for (var i = 0; i < numSamples; i++) {
      if (samplingMethod === "time") {
        // Calculate the x-coordinate for the current sample based on the SVG's width
        var x = (svgWidth / (numSamples - 1)) * i;
        // Find the point on the path that intersects the vertical line at the calculated x-coordinate
        var point = this.findPointAtX(svgPathElement, x, pathLength);
      }
      else if (samplingMethod === "path") {
        // Calculate the distance along the path for the current sample
        var distance = (pathLength / (numSamples - 1)) * i;
        // Get the point at the current distance
        var point = svgPathElement.getPointAtLength(distance);
      }

      // Add the point to the array of points
      points.push({ x: point.x, y: point.y });
    }
    return points;
  }

  findClosestPoints(points, clickedPoint) {
    // Calculate distances from clickedPoint to each point in the array
    let distances = points.map(point => {
      let dx = clickedPoint.x - point.x;
      let dy = clickedPoint.y - point.y;
      return Math.sqrt(dx * dx + dy * dy);
    });

    // Find the index of the minimum distance
    let minIndex = distances.indexOf(Math.min(...distances));

    // Find the second minimum distance
    let secondMin = Infinity;
    let secondMinIndex = -1;
    for (let i = 0; i < distances.length; i++) {
      if (i !== minIndex && distances[i] < secondMin) {
        secondMin = distances[i];
        secondMinIndex = i;
      }
    }

    // Return the indices of the two closest points
    return { point1Index: minIndex, point2Index: secondMinIndex };
  }

  renderPreviousSplines = () => {
    // Clear previous spline layer if it exists
    if (this.previousSplinesLayer) {
      this.vis.children = this.vis.children.filter(child => child !== this.previousSplinesLayer);
      this.previousSplinesLayer = null;
    }

    // Only render if we have any previous data (coordinates or p_coordinates)
    if ((!this.previousSplineData || this.previousSplineData.length === 0) &&
        (!this.previousPCoordinates || this.previousPCoordinates.length === 0)) {
      return;
    }

    this.previousSplinesLayer = this.vis.add(pv.Panel).events("none");

    // Render coordinates (animated paths) as lines
    if (this.previousSplineData && this.previousSplineData.length > 0) {
      this.previousSplineData.forEach((splineCoords, idx) => {
        this.previousSplinesLayer.add(pv.Line)
          .data(splineCoords)
          .left(d => {
            // Transform coordinates based on whether background image exists
            if (this.originalImageWidth && this.originalImageHeight && this.scale > 0) {
              // coord_in is in original image coordinates, scale it to canvas
              return (d.x * this.scale) + this.offsetX;
            }
            // No image, use coordinates directly
            return d.x;
          })
          .top(d => {
            if (this.originalImageWidth && this.originalImageHeight && this.scale > 0) {
              return (d.y * this.scale) + this.offsetY;
            }
            return d.y;
          })
          .events("none")
          .strokeStyle("rgba(255, 255, 255, 0.5)")
          .lineWidth(3)
          .interpolate("linear");

        // Add a dot at 50% of the curve length
        const midIndex = Math.floor(splineCoords.length / 2);
        if (splineCoords.length > 0) {
          const midPoint = splineCoords[midIndex];
          this.previousSplinesLayer.add(pv.Dot)
            .data([midPoint])
            .left(d => {
              if (this.originalImageWidth && this.originalImageHeight && this.scale > 0) {
                return (d.x * this.scale) + this.offsetX;
              }
              return d.x;
            })
            .top(d => {
              if (this.originalImageWidth && this.originalImageHeight && this.scale > 0) {
                return (d.y * this.scale) + this.offsetY;
              }
              return d.y;
            })
            .radius(6)
            .shape("circle")
            .strokeStyle("rgba(255, 255, 255, 0.5)")
            .fillStyle("rgba(255, 255, 255, 0.3)");
        }
      });
    }

    // Render p_coordinates (static points) as dots
    if (this.previousPCoordinates && this.previousPCoordinates.length > 0) {
      this.previousPCoordinates.forEach((pointList, idx) => {
        this.previousSplinesLayer.add(pv.Dot)
          .data(pointList)
          .left(d => {
            if (this.originalImageWidth && this.originalImageHeight && this.scale > 0) {
              return (d.x * this.scale) + this.offsetX;
            }
            return d.x;
          })
          .top(d => {
            if (this.originalImageWidth && this.originalImageHeight && this.scale > 0) {
              return (d.y * this.scale) + this.offsetY;
            }
            return d.y;
          })
          .events("none")
          .radius(6)
          .shape("circle")
          .strokeStyle("rgba(255, 255, 255, 0.5)")
          .fillStyle("rgba(255, 255, 255, 0.3)");
      });
    }
  };

  drawPreviousSpline = (coord_in) => {
    try {
      const coordInData = JSON.parse(coord_in);
      let previousSplinePoints = [];
      let previousPPoints = [];

      // Parse the incoming coordinate data
      if (Array.isArray(coordInData)) {
        previousSplinePoints = [coordInData];
      } else if (typeof coordInData === 'object' && coordInData !== null) {
        // Extract coordinates (animated paths)
        if ('coordinates' in coordInData) {
          if (Array.isArray(coordInData.coordinates) && coordInData.coordinates.length > 0 && !Array.isArray(coordInData.coordinates[0])) {
              // single spline
              previousSplinePoints = [coordInData.coordinates];
          } else {
              // multiple splines
              previousSplinePoints = coordInData.coordinates;
          }
        }

        // Extract p_coordinates (static points)
        if ('p_coordinates' in coordInData) {
          if (Array.isArray(coordInData.p_coordinates) && coordInData.p_coordinates.length > 0 && !Array.isArray(coordInData.p_coordinates[0])) {
              // single list of points
              previousPPoints = [coordInData.p_coordinates];
          } else {
              // multiple lists
              previousPPoints = coordInData.p_coordinates;
          }
        }
      }

      // Store the parsed data separately
      this.previousSplineData = previousSplinePoints;
      this.previousPCoordinates = previousPPoints;

      // Render the previous splines
      this.renderPreviousSplines();
      this.vis.render();

    } catch (e) {
      console.error("Error parsing coord_in:", e);
      this.previousSplineData = null;
      this.previousPCoordinates = null;
    }
  }
}
