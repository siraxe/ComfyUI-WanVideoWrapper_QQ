import { app } from '../../../../scripts/app.js';
import { LayerRenderer } from '../layer_renderer.js';
import { attachStateHelpers } from './canvas_state.js';
import { attachBoxTimelineHelpers } from './canvas_box_timeline.js';
import { attachBackgroundHandlers } from './canvas_background.js';
import { attachContextMenuHandlers } from './canvas_context_menu.js';
import { attachPathHelpers } from './canvas_paths.js';
import { attachPreviousSplineHelpers } from './canvas_previous_splines.js';
import { attachInteractionHandlers } from './canvas_interactions.js';
import { attachHanddrawHelpers } from './canvas_handdraw.js';

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

    this._teardownHanddrawListeners = null;
    attachHanddrawHelpers(this);
    attachStateHelpers(this);
    attachBoxTimelineHelpers(this);
    attachPathHelpers(this);
    attachBackgroundHandlers(this);
    attachContextMenuHandlers(this);
    attachPreviousSplineHelpers(this);
    attachInteractionHandlers(this);

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
    this._boxPreviewState = null;
    // Global toggle for inactive flow animation (default OFF)
    this._inactiveFlowEnabled = false;

    this._shortcutKeys = { s: false };
    this._boxPlayModeStartedAt = 0;
    this._boxRefOnlyMode = false;
    this._boxPlayStopGuardMs = 120;
    const handleShortcutKeyDown = (ev) => {
      const key = ev?.key?.toLowerCase?.();
      if (!key) return;
      if (ev.shiftKey && key === ' ') {
        const widgets = this.node?.layerManager?.getSplineWidgets?.() || [];
        const boxWidgets = widgets.filter(w => w?.value?.type === 'box_layer');
        if (!boxWidgets.length) return;

        // Update ref attachments for all box layers from connected ref_images before preview
        (async () => {
          try {
            await this.updateAllBoxLayerRefs?.();
          } catch (e) {
            console.warn('Failed to update box layer refs:', e);
          }

          // Enable ref-only mode if any box layer has a selected ref entry
          this._boxRefOnlyMode = boxWidgets.some((w) => {
            const ref = w?.value?.ref_attachment;
            const selection = w?.value?.ref_selection || 'no_ref';
            if (!ref || selection === 'no_ref') return false;
            if (Array.isArray(ref.entries)) {
              const parts = selection.split('_');
              const idx = parts.length > 1 ? parseInt(parts[1], 10) : 1;
              const arrayIndex = Number.isFinite(idx) ? Math.max(0, idx - 1) : 0;
              return !!ref.entries[arrayIndex];
            }
            return !!ref.base64;
          });
          this.layerRenderer?.setBoxRefOnlyMode?.(this._boxRefOnlyMode);

          // Hide splines/points and show box manipulators
          this._boxPlayModeActive = true;
          this._boxPlayModeStartedAt = performance.now();
          this.layerRenderer?.setBoxPlayVisibility?.(true);

          // Reset timelines to frame 1 and start playback in sync
          boxWidgets.forEach(w => {
            try { w.stopBoxPlayback?.(this.node); } catch {}
            try { this.applyBoxTimelineFrame?.(w, 1); } catch {}
            try { w.startBoxPlayback?.(this.node); } catch {}
          });

          this.layerRenderer?.render?.();
        })();
        return;
      }
      // Stop preview with plain spacebar when already in play mode
      if (key === ' ' && !ev.shiftKey && this._boxPlayModeActive) {
        const elapsed = performance.now() - this._boxPlayModeStartedAt;
        if (elapsed < this._boxPlayStopGuardMs) {
          return;
        }
        this.exitBoxPlayMode?.();
        return;
      }
      if (key === 's') {
        this._shortcutKeys.s = true;
      }
    };
    const handleShortcutKeyUp = (ev) => {
      const key = ev?.key?.toLowerCase?.();
      if (!key) return;
      if (key === 's') {
        this._shortcutKeys.s = false;
      }
      if (key === ' ' && !ev.shiftKey && this._boxPlayModeActive) {
        const elapsed = performance.now() - this._boxPlayModeStartedAt;
        if (elapsed >= this._boxPlayStopGuardMs) {
          this.exitBoxPlayMode?.();
        }
      }
    };
    const handleShortcutBlur = () => {
      this._shortcutKeys.s = false;
    };
    window.addEventListener('keydown', handleShortcutKeyDown, true);
    window.addEventListener('keyup', handleShortcutKeyUp, true);
    window.addEventListener('blur', handleShortcutBlur, true);
    this._teardownShortcutHandlers = () => {
      window.removeEventListener('keydown', handleShortcutKeyDown, true);
      window.removeEventListener('keyup', handleShortcutKeyUp, true);
      window.removeEventListener('blur', handleShortcutBlur, true);
    };

    // Use widget values instead of hardcoded dimensions
    this.width = this.widthWidget.value;
    this.height = this.heightWidget.value;
    this.pointsLayer = null;

    this.onActiveLayerChanged = () => {
      const activeWidget = this.getActiveWidget();
      if (activeWidget) {
        this.interpolation = activeWidget.value.interpolation || 'linear';
        this.points = this.getActivePoints();
        // Box layers should always start with a single centered box point.
        if (activeWidget.value?.type === 'box_layer' && (!this.points || this.points.length === 0)) {
          const centerPoint = {
            x: this.width * 0.5,
            y: this.height * 0.5,
            highlighted: false,
            scale: 1.0,
            boxScale: 1.0,
            pointScale: 1.0,
            rotation: 0,
          };
          this.setActivePoints([centerPoint]);
          this.points = this.getActivePoints();
        }
      } else {
        this.points = [];
      }
      if (this.vis) {
        this.layerRenderer.render();
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

    // Stop any box-layer playback (Play button) across all layers
    this.stopAllBoxLayerPlayback = () => {
      const widgets = this.node?.layerManager?.getSplineWidgets?.() || [];
      widgets.forEach(w => w?.stopBoxPlayback?.(this.node));
    };

    this.exitBoxPlayMode = () => {
      this.stopAllBoxLayerPlayback();
      this.layerRenderer?.setBoxPlayVisibility?.(false);
      this._boxRefOnlyMode = false;
      this.layerRenderer?.setBoxRefOnlyMode?.(false);
      this._boxPlayModeActive = false;
      this.layerRenderer?.render?.();
    };

    // Box-layer timeline scrubbing state (shift + left-drag on empty canvas)
    this._boxCanvasScrubActive = false;
    this._boxCanvasScrubStartX = 0;
    this._boxCanvasScrubStartFrame = 1;
    this._boxCanvasScrubWidget = null;
    this._boxCanvasScrubStepPx = 1;

    // Double-click tracking for layer switching
    this.lastCanvasClickTime = 0;
    this.lastCanvasClickPos = null;
    this.doubleClickDelay = 300; // ms

    // Load points from active widget
    const initialActive = this.getActiveWidget();
    this.points = this.getActivePoints();

    // If no points exist, initialize with defaults (box layers get a single centered box)
    if (!this.points || this.points.length === 0) {
      const centerX = this.width / 2;
      const centerY = this.height / 2;
      if (initialActive && initialActive.value?.type === 'box_layer') {
        this.points = [
          { x: centerX, y: centerY, highlighted: false, scale: 1.0, boxScale: 1.0, pointScale: 1.0, rotation: 0 },
        ];
        this.ensurePointUids(this.points);
        this.setActivePoints(this.points);
      } else {
        if (reset) {
          // Two points: center and 40px right
          this.points = [
            { x: centerX, y: centerY, highlighted: false, scale: 1.0, boxScale: 1.0, pointScale: 1.0, rotation: 0 },
            { x: centerX + 40, y: centerY, highlighted: false, scale: 1.0, boxScale: 1.0, pointScale: 1.0, rotation: 0 }
          ];
          this.ensurePointUids(this.points);
        } else {
          // Default initial points (bottom-left, top-right)
          this.points = [
            { x: 0, y: this.height, highlighted: false, scale: 1.0, boxScale: 1.0, pointScale: 1.0, rotation: 0 },
            { x: this.width, y: 0, highlighted: false, scale: 1.0, boxScale: 1.0, pointScale: 1.0, rotation: 0 }
          ];
          this.ensurePointUids(this.points);
        }
        this.setActivePoints(this.points);
      }
    }

    // Get interpolation from active widget
    const activeWidget = this.getActiveWidget();
    if (activeWidget) {
      this.interpolation = activeWidget.value.interpolation || 'linear';
      if (activeWidget.value?.type === 'box_layer' && (!this.points || this.points.length === 0)) {
        const centerPoint = {
          x: this.width * 0.5,
          y: this.height * 0.5,
          highlighted: false,
          scale: 1.0,
          boxScale: 1.0,
          pointScale: 1.0,
          rotation: 0,
        };
        this.setActivePoints([centerPoint]);
        this.points = this.getActivePoints();
      }
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
        this.stopAllBoxLayerPlayback?.();
        if (this._boxPlayModeActive) {
          this.exitBoxPlayMode?.();
        }
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

        const shortcutWidget = this.getActiveWidget();
        if (pv.event.button === 0 && this.isShortcutActive('s') && this._isBoxLayerWidget(shortcutWidget)) {
          pv.event.preventDefault?.();
          pv.event.stopPropagation?.();
          if (this._handleBoxCanvasShortcut(shortcutWidget, { x: mouseX, y: mouseY })) {
            return this;
          }
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
          const activeWidget = this.getActiveWidget();
          if (this._isBoxLayerWidget(activeWidget)) {
            // Only scrub when clicking empty space (avoid grabbing the box itself)
            const hit = this.pickBoxPointFromCoords({ x: mouseX, y: mouseY });
            if (!hit) {
              const maxFrames = Math.max(1, this._getMaxFrames());
              this._boxCanvasScrubActive = true;
              this._boxCanvasScrubWidget = activeWidget;
              this._boxCanvasScrubStartX = mouseX;
              this._boxCanvasScrubStartFrame = Math.max(1, Math.min(maxFrames, Math.round(activeWidget.value?.box_timeline_point || 1)));
              // Pixels per frame step; keep a reasonable minimum so small drags still move
              this._boxCanvasScrubStepPx = Math.max(4, this.width / Math.max(1, maxFrames - 1));
              const endScrub = () => {
                document.removeEventListener('mousemove', moveScrub, true);
                document.removeEventListener('mouseup', endScrub, true);
                this._boxCanvasScrubActive = false;
                this._boxCanvasScrubWidget = null;
              };
              const moveScrub = (ev) => {
                if (!this._boxCanvasScrubActive || !this._boxCanvasScrubWidget) return;
                const coords = this._getPointerCoords(ev);
                const deltaX = (coords?.x ?? mouseX) - this._boxCanvasScrubStartX;
                const deltaFrames = Math.round(deltaX / this._boxCanvasScrubStepPx);
                const targetFrame = Math.max(
                  1,
                  Math.min(maxFrames, this._boxCanvasScrubStartFrame + deltaFrames)
                );
                this.applyBoxTimelineFrame?.(this._boxCanvasScrubWidget, targetFrame);
              };
              document.addEventListener('mousemove', moveScrub, true);
              document.addEventListener('mouseup', endScrub, true);
              return this;
            }
            return this;
          }

          let scaledMouse = {
            x: mouseX,
            y: mouseY,
            highlighted: false,
            scale: 1.0,
            boxScale: 1.0,
            pointScale: 1.0,
            uid: this.nextPointUid++,
            rotation: 0,
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
            uid: this.nextPointUid++,
            rotation: 0,
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
}
