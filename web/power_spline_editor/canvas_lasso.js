import { app } from '../../../scripts/app.js';

// Lasso drawing tool for PrepareRefs canvas
// Allows drawing semi-transparent filled shapes on each ref layer

/**
 * Simplify path by removing points that are too close together
 * @param {Array<{x: number, y: number}>} points - Array of points
 * @param {number} threshold - Distance threshold (default 6px)
 * @returns {Array<{x: number, y: number}>} Simplified points
 */
function simplifyPath(points, threshold = 6) {
  if (points.length <= 2) return points;

  const thresholdSq = threshold * threshold;
  const simplified = [points[0]];

  for (let i = 1; i < points.length - 1; i++) {
    const prev = simplified[simplified.length - 1];
    const curr = points[i];
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const distSq = dx * dx + dy * dy;

    if (distSq >= thresholdSq) {
      simplified.push(curr);
    }
  }

  // Always include last point
  simplified.push(points[points.length - 1]);
  return simplified;
}

/**
 * Normalize points to 0-1 range based on canvas dimensions
 * @param {Array<{x: number, y: number}>} points - Array of canvas coordinate points
 * @param {number} w - Canvas width
 * @param {number} h - Canvas height
 * @returns {Array<{x: number, y: number}>} Normalized points
 */
function normalizePoints(points, w, h) {
  if (!w || !h) return points;
  return points.map(p => ({
    x: p.x / w,
    y: p.y / h
  }));
}

/**
 * Denormalize points from 0-1 range to canvas coordinates
 * @param {Array<{x: number, y: number}>} points - Array of normalized points
 * @param {number} w - Canvas width
 * @param {number} h - Canvas height
 * @returns {Array<{x: number, y: number}>} Canvas coordinate points
 */
function denormalizePoints(points, w, h) {
  if (!w || !h) return points;
  return points.map(p => ({
    x: Math.round(p.x * w),
    y: Math.round(p.y * h)
  }));
}

/**
 * Extract contours from canvas image data using Moore-Neighbor tracing
 * Returns array of paths (each path is array of {x, y} points)
 * Handles multiple separate regions
 */
function extractContours(imageData, w, h) {
  const data = imageData.data;
  const visited = new Uint8Array(w * h);
  const contours = [];

  // Helper to check if pixel is opaque
  function isOpaque(x, y) {
    if (x < 0 || x >= w || y < 0 || y >= h) return false;
    const idx = (y * w + x) * 4;
    return data[idx + 3] > 32; // Alpha > 32 (more permissive to prevent shrinking)
  }

  // Moore-Neighbor boundary tracing
  function traceBoundary(startX, startY) {
    const boundary = [];
    const directions = [
      [1, 0], [1, 1], [0, 1], [-1, 1],
      [-1, 0], [-1, -1], [0, -1], [1, -1]
    ];

    let x = startX;
    let y = startY;
    let dir = 7; // Start looking from right-up
    let startDir = -1;

    do {
      boundary.push({ x, y });

      // Mark region as visited
      const idx = y * w + x;
      visited[idx] = 1;

      // Search for next boundary pixel
      let found = false;
      for (let i = 0; i < 8; i++) {
        const checkDir = (dir + i) % 8;
        const nx = x + directions[checkDir][0];
        const ny = y + directions[checkDir][1];

        if (isOpaque(nx, ny)) {
          x = nx;
          y = ny;
          dir = (checkDir + 5) % 8; // Turn left
          found = true;

          if (startDir === -1) startDir = checkDir;
          break;
        }
      }

      if (!found) break;

      // Stop if we're back at start
      if (x === startX && y === startY && boundary.length > 2) {
        break;
      }

      // Safety limit
      if (boundary.length > w * h) break;

    } while (true);

    return boundary;
  }

  // Mark all pixels in a region as visited using flood fill
  function markRegion(startX, startY) {
    const queue = [[startX, startY]];
    const regionVisited = new Set();

    while (queue.length > 0) {
      const [x, y] = queue.shift();
      const key = `${x},${y}`;

      if (regionVisited.has(key)) continue;
      if (!isOpaque(x, y)) continue;

      regionVisited.add(key);
      const idx = y * w + x;
      visited[idx] = 1;

      // Add 8-connected neighbors
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            const nkey = `${nx},${ny}`;
            if (!regionVisited.has(nkey) && isOpaque(nx, ny)) {
              queue.push([nx, ny]);
            }
          }
        }
      }
    }
  }

  // Find all separate regions
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!visited[idx] && isOpaque(x, y)) {
        // Check if this is a boundary pixel (has at least one transparent neighbor)
        let isBoundary = false;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!isOpaque(x + dx, y + dy)) {
              isBoundary = true;
              break;
            }
          }
          if (isBoundary) break;
        }

        if (isBoundary) {
          // Trace the boundary
          const contour = traceBoundary(x, y);

          // Mark the entire region as visited
          markRegion(x, y);

          if (contour.length > 3) {
            // Simplify the contour
            const simplified = simplifyPath(contour, 4);
            contours.push(simplified);
          }
        } else {
          // Interior pixel, mark region as visited
          markRegion(x, y);
        }
      }
    }
  }

  return contours;
}

/**
 * Compute bounding box for a path with margin
 */
function getPathBoundingBox(path, margin = 20) {
  if (!path || path.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of path) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  return {
    minX: minX - margin,
    minY: minY - margin,
    maxX: maxX + margin,
    maxY: maxY + margin
  };
}

/**
 * Check if a path intersects with a bounding box
 */
function pathIntersectsBBox(path, bbox) {
  if (!path || !bbox) return false;

  // Check if any point is within the bbox
  for (const p of path) {
    if (p.x >= bbox.minX && p.x <= bbox.maxX &&
        p.y >= bbox.minY && p.y <= bbox.maxY) {
      return true;
    }
  }
  return false;
}

/**
 * Compute final merged shape from current paths and new path
 * Uses raster method with smart vertex snapping to preserve old points
 */
function computeMergedShape(currentShape, newPath, isSubtractive, node) {
  // Get canvas editor for coordinate transformations
  const editor = node.refCanvasEditor;
  if (!editor) {
    console.error('RefCanvas editor not available');
    return [];
  }

  // Get dimensions from RefCanvas
  const w = editor.originalImageWidth || editor.width;
  const h = editor.originalImageHeight || editor.height;

  // Collect all old points for snapping later (denormalized to image pixel space)
  const oldPoints = [];
  if (currentShape.additivePaths) {
    currentShape.additivePaths.forEach(path => {
      const denormalized = editor.denormalizePoints(path);
      oldPoints.push(...denormalized);
    });
  }
  // Also include new path points (already in canvas space, will be normalized correctly)
  oldPoints.push(...newPath);

  // Create off-screen canvas at image resolution
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  // Disable anti-aliasing to prevent edge erosion during contour extraction
  ctx.imageSmoothingEnabled = false;

  // Render current additive paths
  ctx.globalCompositeOperation = 'source-over';
  if (currentShape.additivePaths) {
    currentShape.additivePaths.forEach(path => {
      // Denormalize to get actual pixel coordinates on the image
      const imageCoords = path.map(p => ({
        x: p.x * w,
        y: p.y * h
      }));
      if (imageCoords.length < 3) return;

      ctx.fillStyle = 'rgba(255, 255, 255, 1)';
      ctx.beginPath();
      ctx.moveTo(imageCoords[0].x, imageCoords[0].y);
      for (let i = 1; i < imageCoords.length; i++) {
        ctx.lineTo(imageCoords[i].x, imageCoords[i].y);
      }
      ctx.closePath();
      ctx.fill();
    });
  }

  // Normalize new path to get image pixel coordinates
  const newPathNormalized = editor.normalizePoints(newPath);
  const newPathImageCoords = newPathNormalized.map(p => ({
    x: p.x * w,
    y: p.y * h
  }));

  // Apply new path
  if (isSubtractive) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, 1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(255, 255, 255, 1)';
  }

  ctx.beginPath();
  ctx.moveTo(newPathImageCoords[0].x, newPathImageCoords[0].y);
  for (let i = 1; i < newPathImageCoords.length; i++) {
    ctx.lineTo(newPathImageCoords[i].x, newPathImageCoords[i].y);
  }
  ctx.closePath();
  ctx.fill();

  // Extract contours from result
  const imageData = ctx.getImageData(0, 0, w, h);
  const extractedContours = extractContours(imageData, w, h);

  // SMART SNAPPING: For each extracted point, try to snap to closest old point
  const snappedContours = extractedContours.map(contour => {
    return contour.map(point => {
      // Find closest old point within snapping distance
      let closestOldPoint = null;
      let minDistance = 5; // Snap threshold in pixels

      for (const oldPoint of oldPoints) {
        const dx = point.x - oldPoint.x;
        const dy = point.y - oldPoint.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < minDistance) {
          minDistance = distance;
          closestOldPoint = oldPoint;
        }
      }

      // If we found a close old point, use it (preserves exact coordinates)
      if (closestOldPoint) {
        return { x: closestOldPoint.x, y: closestOldPoint.y };
      }

      // Otherwise use the extracted point
      return point;
    });
  });

  // Normalize and return (convert image pixel coords to 0-1 range)
  return snappedContours.map(contour => contour.map(p => ({
    x: p.x / w,
    y: p.y / h
  })));
}

/**
 * Render lasso shapes for a layer using boolean operations
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {Object} shape - Shape object with additivePaths and subtractivePaths
 * @param {number} w - Canvas width
 * @param {number} h - Canvas height
 * @param {boolean} isActive - Whether the layer is active (on)
 * @param {Object} refCanvasEditor - RefCanvas instance with coordinate transformation methods
 */
function renderLayerLassoShapes(ctx, shape, w, h, isActive = true, refCanvasEditor = null) {
  if (!shape || !shape.additivePaths?.length) return;

  console.log('[renderLayerLassoShapes] Rendering:', {
    pathCount: shape.additivePaths.length,
    hasRefCanvas: !!refCanvasEditor,
    canvasSize: `${w}×${h}`
  });

  // Choose colors based on active state
  const fillColor = isActive ? 'rgba(0, 255, 0, 0.3)' : 'rgba(128, 128, 128, 0.3)';
  const strokeColor = isActive ? 'rgba(0, 255, 0, 0.8)' : 'rgba(128, 128, 128, 0.8)';

  // Create off-screen canvas for boolean operations
  const offscreen = document.createElement('canvas');
  offscreen.width = w;
  offscreen.height = h;
  const offCtx = offscreen.getContext('2d');

  // Render all paths (already merged, may be multiple separate regions)
  offCtx.globalCompositeOperation = 'source-over';
  offCtx.fillStyle = fillColor;
  if (shape.additivePaths && shape.additivePaths.length > 0) {
    shape.additivePaths.forEach((path, idx) => {
      console.log(`[renderLayerLassoShapes] Path ${idx}: ${path.length} points, using ${refCanvasEditor ? 'RefCanvas' : 'fallback'}`);
      // Use RefCanvas's denormalize method (handles coordinate transform automatically)
      const canvasCoords = refCanvasEditor ? refCanvasEditor.denormalizePoints(path) : denormalizePoints(path, w, h);
      if (canvasCoords.length < 3) return;

      offCtx.beginPath();
      offCtx.moveTo(canvasCoords[0].x, canvasCoords[0].y);
      for (let i = 1; i < canvasCoords.length; i++) {
        offCtx.lineTo(canvasCoords[i].x, canvasCoords[i].y);
      }
      offCtx.closePath();
      offCtx.fill();
    });
  }

  // Draw off-screen canvas to main canvas
  ctx.drawImage(offscreen, 0, 0);

  // Draw outlines for all regions
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2;
  if (shape.additivePaths && shape.additivePaths.length > 0) {
    shape.additivePaths.forEach(path => {
      // Use RefCanvas's denormalize method (handles coordinate transform automatically)
      const canvasCoords = refCanvasEditor ? refCanvasEditor.denormalizePoints(path) : denormalizePoints(path, w, h);
      if (canvasCoords.length < 3) return;

      ctx.beginPath();
      ctx.moveTo(canvasCoords[0].x, canvasCoords[0].y);
      for (let i = 1; i < canvasCoords.length; i++) {
        ctx.lineTo(canvasCoords[i].x, canvasCoords[i].y);
      }
      ctx.closePath();
      ctx.stroke();
    });
  }
}

/**
 * Render live preview of current drawing path
 * @param {Object} node - The PrepareRefs node
 */
function renderLassoPreview(node) {
  if (!node._lassoCurrentPath || node._lassoCurrentPath.length < 2) return;

  const canvas = node.refsCanvas;
  if (!canvas) return;

  const ctx = canvas.getContext('2d');

  // Current path is already in canvas coordinates (like PowerSplineEditor)
  // No transformation needed for display!

  // Choose colors based on mode
  const isSubtractive = node._lassoIsCtrlHeld;
  const fillColor = isSubtractive ? 'rgba(255, 0, 0, 0.2)' : 'rgba(0, 255, 0, 0.2)';
  const strokeColor = isSubtractive ? 'rgba(255, 0, 0, 0.6)' : 'rgba(0, 255, 0, 0.6)';

  // Draw preview path with fill
  ctx.beginPath();
  ctx.moveTo(node._lassoCurrentPath[0].x, node._lassoCurrentPath[0].y);
  for (let i = 1; i < node._lassoCurrentPath.length; i++) {
    ctx.lineTo(node._lassoCurrentPath[i].x, node._lassoCurrentPath[i].y);
  }
  // Close the path to the first point for fill
  ctx.closePath();

  // Fill the shape
  ctx.fillStyle = fillColor;
  ctx.fill();

  // Stroke the outline
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2;
  ctx.stroke();
}

/**
 * Enter lasso drawing mode for a specific ref layer
 * @param {Object} node - The PrepareRefs node
 * @param {Object} refLayer - The ref layer widget to draw on
 */
function enterLassoMode(node, refLayer) {
  // Exit any existing mode first
  if (node._lassoDrawingActive) {
    exitLassoMode(node);
  }

  node._lassoDrawingActive = true;
  node._lassoActiveLayer = refLayer;

  // Change cursor to crosshair
  const canvas = node.refsCanvas;
  if (canvas) {
    canvas.style.cursor = 'crosshair';
  }

  console.log(`Lasso mode activated for ${refLayer.value.name}`);
}

/**
 * Exit lasso drawing mode
 * @param {Object} node - The PrepareRefs node
 */
function exitLassoMode(node) {
  node._lassoDrawingActive = false;
  node._lassoActiveLayer = null;
  node._lassoCurrentPath = [];

  // Cleanup any active listeners
  if (node._lassoTeardownListeners) {
    node._lassoTeardownListeners();
    node._lassoTeardownListeners = null;
  }

  // Reset cursor
  const canvas = node.refsCanvas;
  if (canvas) {
    canvas.style.cursor = 'default';
  }

  console.log('Lasso mode deactivated');
}

/**
 * Handle canvas mousedown - start drawing
 */
function handleCanvasMouseDown(node, e) {
  if (!node._lassoDrawingActive || !node._lassoActiveLayer) return;

  // Use RefCanvas to get canvas coordinates (same as PowerSplineEditor)
  const coords = node.refCanvasEditor.getCanvasCoords(e);
  const x = coords.x;
  const y = coords.y;

  // Ensure coordinates are within the canvas bounds
  if (x < 0 || x > node.refsCanvas.width || y < 0 || y > node.refsCanvas.height) {
    return; // Ignore events outside the canvas
  }

  // Capture modifier state at mousedown
  node._lassoIsShiftHeld = e.shiftKey;
  node._lassoIsCtrlHeld = e.ctrlKey;

  // Clear previous shapes if no modifiers held
  if (!node._lassoIsShiftHeld && !node._lassoIsCtrlHeld) {
    if (!node._lassoActiveLayer.value.lassoShape) {
      node._lassoActiveLayer.value.lassoShape = { additivePaths: [], subtractivePaths: [] };
    }
    node._lassoActiveLayer.value.lassoShape.additivePaths = [];
    node._lassoActiveLayer.value.lassoShape.subtractivePaths = [];
  }

  // Initialize drawing path in canvas coordinates (like PowerSplineEditor)
  node._lassoCurrentPath = [{ x, y }];
  node._lassoLastAddedPoint = { x, y };

  // Attach document-level listeners
  const onMouseMove = (e) => handleDocumentMouseMove(node, e);
  const onMouseUp = (e) => handleDocumentMouseUp(node, e, onMouseMove, onMouseUp);

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  // Store cleanup function
  node._lassoTeardownListeners = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };

  e.preventDefault();
  e.stopPropagation();
}

/**
 * Handle document mousemove - draw path
 */
function handleDocumentMouseMove(node, e) {
  if (!node._lassoCurrentPath) return;

  // Use RefCanvas to get canvas coordinates (same as PowerSplineEditor)
  const coords = node.refCanvasEditor.getCanvasCoords(e);
  const x = coords.x;
  const y = coords.y;

  // Ensure coordinates are within the canvas bounds before adding to path
  if (x < 0 || x > node.refsCanvas.width || y < 0 || y > node.refsCanvas.height) {
    return; // Skip points outside the canvas
  }

  // Check distance threshold (6px squared = 36) in canvas space
  const dx = x - node._lassoLastAddedPoint.x;
  const dy = y - node._lassoLastAddedPoint.y;
  const distSq = dx * dx + dy * dy;

  if (distSq >= 36) {
    node._lassoCurrentPath.push({ x, y });
    node._lassoLastAddedPoint = { x, y };

    // Trigger canvas refresh for preview
    if (node.refreshCanvas) {
      node.refreshCanvas();
    }
  }

  e.preventDefault();
}

/**
 * Handle document mouseup - finalize shape
 */
function handleDocumentMouseUp(node, e, onMouseMove, onMouseUp) {
  if (!node._lassoCurrentPath || node._lassoCurrentPath.length < 3) {
    // Not enough points for a shape
    node._lassoCurrentPath = [];
    node._lassoTeardownListeners = null;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    return;
  }

  const canvas = node.refsCanvas;
  if (!canvas) return;

  // Simplify path (in canvas coordinates)
  const simplified = simplifyPath(node._lassoCurrentPath, 6);

  // Ensure shape structure exists
  if (!node._lassoActiveLayer.value.lassoShape) {
    node._lassoActiveLayer.value.lassoShape = { additivePaths: [], subtractivePaths: [] };
  }

  // Normalize using RefCanvas (applies proper coordinate transform automatically)
  const normalizedPath = node.refCanvasEditor.normalizePoints(simplified);

  // Different behaviors based on modifier keys
  if (node._lassoIsShiftHeld || node._lassoIsCtrlHeld) {
    // Shift or Ctrl held - do boolean merge with smart preservation
    const mergedContours = computeMergedShape(
      node._lassoActiveLayer.value.lassoShape,
      simplified,
      node._lassoIsCtrlHeld, // isSubtractive
      node // Pass node to access refCanvasEditor
    );

    // Replace shape with computed result (already normalized in computeMergedShape)
    node._lassoActiveLayer.value.lassoShape = {
      additivePaths: mergedContours,
      subtractivePaths: []
    };

    const mode = node._lassoIsCtrlHeld ? 'Subtractive' : 'Additive';
    console.log(`${mode} merge for ${node._lassoActiveLayer.value.name}:`,
      `${mergedContours.length} region(s), unaffected paths preserved`);
  } else {
    // No modifier - replace all paths with new one
    node._lassoActiveLayer.value.lassoShape = {
      additivePaths: [normalizedPath],
      subtractivePaths: []
    };
    console.log(`Replaced paths for ${node._lassoActiveLayer.value.name}`);
  }

  // Update the serialized ref layer data widget
  const refDataWidget = node.widgets?.find(w => w.name === "ref_layer_data");
  if (refDataWidget) {
    refDataWidget.value = node.getRefLayerData?.() || [];
  }

  // Cleanup
  node._lassoCurrentPath = [];
  node._lassoTeardownListeners = null;
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);

  // Refresh canvas to show final shape
  if (node.refreshCanvas) {
    node.refreshCanvas();
  }

  e.preventDefault();
}

/**
 * Main attachment function - adds lasso helpers to PrepareRefs node
 * @param {Object} node - The PrepareRefs node instance
 */
export function attachLassoHelpers(node) {
  // Initialize lasso state properties
  node._lassoDrawingActive = false;
  node._lassoActiveLayer = null;
  node._lassoCurrentPath = [];
  node._lassoLastAddedPoint = null;
  node._lassoIsShiftHeld = false;
  node._lassoIsCtrlHeld = false;
  node._lassoTeardownListeners = null;
  node._lassoCanvasTeardown = null;

  // Attach mode control functions
  node.enterLassoMode = (refLayer) => enterLassoMode(node, refLayer);
  node.exitLassoMode = () => exitLassoMode(node);

  // Attach rendering functions
  node.renderLayerLassoShapes = (ctx, shape, w, h, isActive, refCanvasEditor) => renderLayerLassoShapes(ctx, shape, w, h, isActive, refCanvasEditor);
  node.renderLassoPreview = () => renderLassoPreview(node);

  // Attach canvas mousedown listener
  const canvas = node.refsCanvas;
  if (canvas) {
    const onMouseDown = (e) => handleCanvasMouseDown(node, e);
    canvas.addEventListener('mousedown', onMouseDown);

    node._lassoCanvasTeardown = () => {
      canvas.removeEventListener('mousedown', onMouseDown);
    };
  }

  console.log('Lasso helpers attached to PrepareRefs node');
}
