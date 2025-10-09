import { app } from '../../../scripts/app.js';
import { LayerRenderer } from './layer_renderer.js';

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
      console.log("onDragDrop called");
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

    // Use widget values instead of hardcoded dimensions
    this.width = this.widthWidget.value;
    this.height = this.heightWidget.value;
    this.pointsLayer = null;

    // Helper methods for multi-layer support
    this.getActiveWidget = () => {
      return this.node.layerManager.getActiveWidget();
    };

    this.getActivePoints = () => {
      const activeWidget = this.getActiveWidget();
      if (!activeWidget) return [];
      try {
        const points = JSON.parse(activeWidget.value.points_store || '[]');
        return this.denormalizePoints(points);
      } catch (e) {
        return [];
      }
    };

    this.setActivePoints = (points) => {
      const activeWidget = this.getActiveWidget();
      if (!activeWidget) return;
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

          allSplineData.push({
              on: widget.value.on,
              name: widget.value.name,
              interpolation: widget.value.interpolation || 'linear',
              repeat: widget.value.repeat || 1,
              points_store: widget.value.points_store,
              coordinates: JSON.stringify(widgetCoordinates)
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
    }

    // Initialize or reset points array
    this.drawRuler = true;
    this.hoverIndex = -1;
    this.isDragging = false;
    this.isDraggingAll = false; // Flag for Alt+middle-drag (translation)
    this.isScalingAll = false; // Flag for Alt+right-drag (scaling)
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
          { x: centerX, y: centerY, highlighted: false },
          { x: centerX + 40, y: centerY, highlighted: false }
        ];
      } else {
        // Default initial points (bottom-left, top-right)
        this.points = [
          { x: 0, y: this.height, highlighted: false },
          { x: this.width, y: 0, highlighted: false }
        ];
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
      .margin(10)
      .event("mousedown", (e) => {
        // Get mouse position (scaled for canvas)
        const mouseX = this.vis.mouse().x / app.canvas.ds.scale;
        const mouseY = this.vis.mouse().y / app.canvas.ds.scale;

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
            console.log(`Switched to layer: ${clickedWidget.value.name}`);

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
            highlighted: false
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
            highlighted: false
          };

          // Insert the midpoint into the array
          this.points.splice(point2Index, 0, midpoint);
          this.i = point2Index;
          this.updatePath();
        }
        else if (pv.event.button === 2) {
          this.node.contextMenu.style.display = 'block';
          this.node.contextMenu.style.left = `${pv.event.clientX}px`;
          this.node.contextMenu.style.top = `${pv.event.clientY}px`;
        }
      })
      
    this.dragStartHandler = (d) => {
        const dot = d;
        this.i = this.points.indexOf(dot);
        this.hoverIndex = this.i;

        const mouseX = this.vis.mouse().x / app.canvas.ds.scale;
        const mouseY = this.vis.mouse().y / app.canvas.ds.scale;
        const pointX = this.points[this.i].x;
        const pointY = this.points[this.i].y;
        this.dragOffset = { x: pointX - mouseX, y: pointY - mouseY };

        // Shift+Middle-Click: Toggle highlighted state on points (except first point)
        if (pv.event.shiftKey && pv.event.button === 1) {
          if (this.i !== 0 && this.i !== -1) {
            this.points[this.i].highlighted = !this.points[this.i].highlighted;
            this.layerRenderer.render();
            this.updatePath();
          }
          return;
        }

        // Alt+Left-Click: Rotation around clicked point (any point)
        if (pv.event.altKey && pv.event.button === 0) {
          this.isRotatingAll = true;
          this.originalPoints = this.points.map(p => ({ ...p }));
          this.anchorPoint = { ...this.points[this.i] }; // Use clicked point as anchor
          this.anchorIndex = this.i; // Store anchor index
          this.initialRotationAngle = Math.atan2(mouseY - this.anchorPoint.y, mouseX - this.anchorPoint.x);
          this.isDragging = true;
          return;
        }

        // Alt+Middle-Click: Translation (any point)
        if (pv.event.altKey && pv.event.button === 1) {
          this.isDraggingAll = true;
          this.dragStartPos = { x: mouseX, y: mouseY };
          this.isDragging = true;
          return;
        }

        // Alt+Right-Click: Scaling relative to clicked point (any point)
        if (pv.event.altKey && pv.event.button === 2) {
          this.isScalingAll = true;
          this.originalPoints = this.points.map(p => ({ ...p }));
          this.anchorPoint = { ...this.points[this.i] }; // Use clicked point as anchor
          this.anchorIndex = this.i; // Store anchor index
          this.initialXDistance = mouseX - this.anchorPoint.x;
          if (Math.abs(this.initialXDistance) < 10) {
            this.initialXDistance = this.initialXDistance >= 0 ? 10 : -10;
          }
          this.isDragging = true;
          return;
        }

        // Regular drag or delete
        this.isDragging = true;
        if (pv.event.button === 2 && this.i !== 0 && this.i !== this.points.length - 1) {
          this.points.splice(this.i--, 1);
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
        this.dragOffset = null;
        this.isDragging = false;
        this.isDraggingAll = false;
        this.isScalingAll = false;
        this.isRotatingAll = false;
        this.dragStartPos = null;
        this.initialXDistance = 0;
        this.initialRotationAngle = 0;
        this.anchorPoint = null;
        this.anchorIndex = -1;
        this.originalPoints = null;
    };

    this.dragHandler = (d) => {
        let adjustedX = this.vis.mouse().x / app.canvas.ds.scale;
        let adjustedY = this.vis.mouse().y / app.canvas.ds.scale;

        if (this.isRotatingAll && this.anchorPoint && this.originalPoints) {
          const currentAngle = Math.atan2(adjustedY - this.anchorPoint.y, adjustedX - this.anchorPoint.x);
          const rotationAngle = currentAngle - this.initialRotationAngle;
          const cos = Math.cos(rotationAngle);
          const sin = Math.sin(rotationAngle);

          // Rotate all points around the anchor point
          for (let j = 0; j < this.originalPoints.length; j++) {
            if (j === this.anchorIndex) {
              // Keep anchor point fixed
              this.points[j] = { ...this.anchorPoint };
            } else {
              const originalPoint = this.originalPoints[j];
              const vecX = originalPoint.x - this.anchorPoint.x;
              const vecY = originalPoint.y - this.anchorPoint.y;
              const rotatedX = vecX * cos - vecY * sin;
              const rotatedY = vecX * sin + vecY * cos;
              this.points[j] = {
                x: this.anchorPoint.x + rotatedX,
                y: this.anchorPoint.y + rotatedY,
                highlighted: originalPoint.highlighted || false
              };
            }
          }
          this.layerRenderer.render();
          return;
        }

        if (this.isDraggingAll && this.dragStartPos) {
          const deltaX = adjustedX - this.dragStartPos.x;
          const deltaY = adjustedY - this.dragStartPos.y;
          this.points = this.points.map(point => ({
            x: point.x + deltaX,
            y: point.y + deltaY,
            highlighted: point.highlighted || false
          }));
          this.dragStartPos.x = adjustedX;
          this.dragStartPos.y = adjustedY;
          this.layerRenderer.render();
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
            if (j === this.anchorIndex) {
              // Keep anchor point fixed
              this.points[j] = { ...this.anchorPoint };
            } else {
              const originalPoint = this.originalPoints[j];
              const vecX = originalPoint.x - this.anchorPoint.x;
              const vecY = originalPoint.y - this.anchorPoint.y;
              this.points[j] = {
                x: this.anchorPoint.x + vecX * clampedScaleFactor,
                y: this.anchorPoint.y + vecY * clampedScaleFactor,
                highlighted: originalPoint.highlighted || false
              };
            }
          }
          this.layerRenderer.render();
          return;
        }

        if (!this.isDraggingAll && !this.isScalingAll && !this.isRotatingAll) {
          if (this.dragOffset) {
            this.points[this.i] = {
              x: adjustedX + this.dragOffset.x,
              y: adjustedY + this.dragOffset.y,
              highlighted: this.points[this.i].highlighted || false
            };
          }
          this.layerRenderer.render();
        }
    };

    this.mouseOverHandler = (d) => {
        this.hoverIndex = this.points.indexOf(d);
        this.layerRenderer.render();
    };

    this.mouseOutHandler = () => {
        if (!this.isDragging) {
            this.hoverIndex = -1;
        }
        this.layerRenderer.render();
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
      if (this.interpolation === 'linear' || this.interpolation === 'points') {
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
    this.node.splineEditor2.parentEl.appendChild(svgElement);
    // Set explicit height to ensure proper space is reserved
    this.node.splineEditor2.parentEl.style.height = `${this.height + 20}px`; // +20 for padding
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

  updatePath = () => {
    if (!this.points || this.points.length === 0) {
      console.log("no points");
      return;
    }

    // Return early if vis isn't created yet
    if (!this.vis) {
      return;
    }

    // Save current points to active widget
    const activeWidget = this.getActiveWidget();
    if (activeWidget) {
      activeWidget.value.points_store = JSON.stringify(this.normalizePoints(this.points));
    }

    // Re-render previous splines to ensure they persist
    this.renderPreviousSplines();

    // Render active and inactive layers
    this.layerRenderer.render();

    // Update container height to match canvas height
    if (this.node.splineEditor2 && this.node.splineEditor2.parentEl) {
      this.node.splineEditor2.parentEl.style.height = `${this.height + 20}px`;
    }

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
    const splinePaths = Array.from(pathElements).filter(p => {
        const stroke = p.getAttribute('stroke');
        return stroke !== 'rgba(255, 255, 255, 0.5)' && stroke !== '#ff7f0e';
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

        if (widget.value.interpolation === 'points' || !usePathSampling) {
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

        allSplineData.push({
            on: widget.value.on,
            name: widget.value.name,
            interpolation: widget.value.interpolation || 'linear',
            repeat: widget.value.repeat || 1,
            points_store: widget.value.points_store, // Always store the raw control points
            coordinates: JSON.stringify(normalizedCoords)
        });
    }

    // Output widget array to backend
    if (this.coordWidget) {
        const coordString = JSON.stringify(allSplineData);
        this.coordWidget.value = coordString;
    } else {
        console.log(`[updatePath] WARNING: coordWidget is null/undefined!`);
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
    }

    // Call updatePath after image details are set and rendered
    this.updatePath();
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
    }
  };

  createContextMenu = () => {
    document.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    document.addEventListener('click', () => {
      document.querySelectorAll('.spline-editor-context-menu').forEach(menu => {
        menu.style.display = 'none';
      });
    });

    this.node.menuItems.forEach((menuItem, index) => {
      menuItem.addEventListener('click', (e) => {
        e.preventDefault();
        switch (index) {
          case 0:
            // Invert point order
            e.preventDefault();
            this.points.reverse();
            this.updatePath();
            this.node.contextMenu.style.display = 'none';
            break;
          case 1:
            // Delete spline
            e.preventDefault();
            const activeWidget = this.getActiveWidget();
            if (activeWidget) {
              this.node.layerManager.removeSpline(activeWidget);
            }
            this.node.contextMenu.style.display = 'none';
            break;
          case 2:
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
          case 3:
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
          case 4:
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
      console.log("Clearing existing previousSplinesLayer");
      this.vis.children = this.vis.children.filter(child => child !== this.previousSplinesLayer);
      this.previousSplinesLayer = null;
    }

    // Only render if we have any previous data (coordinates or p_coordinates)
    if ((!this.previousSplineData || this.previousSplineData.length === 0) &&
        (!this.previousPCoordinates || this.previousPCoordinates.length === 0)) {
      console.log("No previous data to render");
      return;
    }

    console.log("Creating new layer for previous data");

    // Create a new layer for previous splines
    this.previousSplinesLayer = this.vis.add(pv.Panel);

    // Render coordinates (animated paths) as lines
    if (this.previousSplineData && this.previousSplineData.length > 0) {
      console.log("Adding lines for", this.previousSplineData.length, "coordinate splines");
      this.previousSplineData.forEach((splineCoords, idx) => {
        console.log(`Adding line ${idx} with ${splineCoords.length} points`);
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
      console.log("Finished adding coordinate lines to previousSplinesLayer");
    }

    // Render p_coordinates (static points) as dots
    if (this.previousPCoordinates && this.previousPCoordinates.length > 0) {
      console.log("Adding dots for", this.previousPCoordinates.length, "p_coordinate lists");
      this.previousPCoordinates.forEach((pointList, idx) => {
        console.log(`Adding ${pointList.length} dots from p_coordinates list ${idx}`);
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
          .radius(6)
          .shape("circle")
          .strokeStyle("rgba(255, 255, 255, 0.5)")
          .fillStyle("rgba(255, 255, 255, 0.3)");
      });
      console.log("Finished adding p_coordinate dots to previousSplinesLayer");
    }
  };

  drawPreviousSpline = (coord_in) => {
    console.log("drawPreviousSpline called with:", coord_in);
    try {
      const coordInData = JSON.parse(coord_in);
      let previousSplinePoints = [];
      let previousPPoints = [];

      // Parse the incoming coordinate data
      if (Array.isArray(coordInData)) {
        console.log("coordInData is array, wrapping in single spline");
        previousSplinePoints = [coordInData];
      } else if (typeof coordInData === 'object' && coordInData !== null) {
        // Extract coordinates (animated paths)
        if ('coordinates' in coordInData) {
          if (Array.isArray(coordInData.coordinates) && coordInData.coordinates.length > 0 && !Array.isArray(coordInData.coordinates[0])) {
              // single spline
              console.log("Single spline detected from coordinates property");
              previousSplinePoints = [coordInData.coordinates];
          } else {
              // multiple splines
              console.log("Multiple splines detected from coordinates property");
              previousSplinePoints = coordInData.coordinates;
          }
        }

        // Extract p_coordinates (static points)
        if ('p_coordinates' in coordInData) {
          if (Array.isArray(coordInData.p_coordinates) && coordInData.p_coordinates.length > 0 && !Array.isArray(coordInData.p_coordinates[0])) {
              // single list of points
              console.log("Single p_coordinates list detected");
              previousPPoints = [coordInData.p_coordinates];
          } else {
              // multiple lists
              console.log("Multiple p_coordinates lists detected");
              previousPPoints = coordInData.p_coordinates;
          }
        }
      }

      console.log("previousSplinePoints:", previousSplinePoints);
      console.log("Number of coordinate splines:", previousSplinePoints.length);
      console.log("previousPPoints:", previousPPoints);
      console.log("Number of p_coordinate lists:", previousPPoints.length);
      if (previousSplinePoints.length > 0) {
        console.log("First spline has", previousSplinePoints[0].length, "points");
        console.log("First few points:", previousSplinePoints[0].slice(0, 5));
      }

      // Store the parsed data separately
      this.previousSplineData = previousSplinePoints;
      this.previousPCoordinates = previousPPoints;

      // Render the previous splines
      this.renderPreviousSplines();
      console.log("About to render vis");
      this.vis.render();
      console.log("Rendered vis");

    } catch (e) {
      console.error("Error parsing coord_in:", e);
      this.previousSplineData = null;
      this.previousPCoordinates = null;
    }
  }
}