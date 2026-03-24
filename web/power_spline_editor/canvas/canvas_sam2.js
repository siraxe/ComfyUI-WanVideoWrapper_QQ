/**
 * SAM2 Point-Click Masking Helpers
 *
 * This module provides SAM2 (Segment Anything Model 2) point-click masking
 * functionality for the RefCanvasEditor. It allows users to create masks by
 * clicking on objects instead of drawing them manually.
 *
 * Main features:
 * - Mode management (enter/exit SAM2 mode)
 * - Point management (add/remove SAM2 click points)
 * - API integration (debounced prediction requests)
 * - Visual feedback (points rendering and mask preview)
 * - Auto-commit on mode switch
 */

/**
 * Attach SAM2 helpers to a RefCanvasEditor instance
 * @param {Object} editor - The RefCanvasEditor instance to extend
 */
export function attachSam2Helpers(editor) {
  // SAM2 mode state
  editor._sam2Mode = false;
  editor._sam2Points = [];
  editor._sam2MaskPath = null;
  editor._sam2DebounceTimer = null;
  editor._sam2RenderCallbacks = []; // Store render callbacks

  /**
   * Toggle SAM2 mode on/off
   */
  editor.toggleSam2Mode = () => {
    if (editor._sam2Mode) {
      editor.exitSam2Mode();
    } else {
      editor.enterSam2Mode();
    }
  };

  /**
   * Enter SAM2 mode - exit pencil mode first
   */
  editor.enterSam2Mode = () => {
    // Exit pencil mode if active
    if (editor._lassoDrawingActive) {
      editor.exitLassoMode?.();
      // Clear pencil masks
      editor.clearLayerMasks?.();
    }

    editor._sam2Mode = true;
    editor._sam2Points = [];
    editor._sam2MaskPath = null;

    // Set the active layer (same as lasso mode)
    editor._sam2ActiveLayer = editor.selectedRefLayer;

    editor.updateMagicWandButton(true);
    editor.forceCanvasRefresh?.();
  };

  /**
   * Exit SAM2 mode - bake mask to pencil mode and clean up
   */
  editor.exitSam2Mode = () => {
    // Step 1: Bake SAM2 mask to pencil mode (convert to lasso format)
    if (editor._sam2MaskPath && editor._sam2Points.length > 0) {
      editor.bakeSam2MaskToLasso();
    }

    // Step 2: Update wand button to deselected state (BEFORE clearing layer reference)
    editor.updateMagicWandButton(false);

    // Step 3: Clear all SAM2 state
    editor._sam2Mode = false;
    editor._sam2ActiveLayer = null;
    editor._sam2Points = [];
    editor._sam2MaskPath = null;

    // Step 4: Clear SAM2 visuals from canvas
    editor.clearSam2Visuals();
    editor.forceCanvasRefresh?.();
  };

  /**
   * Update magic wand button visual state
   * @param {boolean} active - Whether the button should be active
   */
  editor.updateMagicWandButton = (active) => {
    if (!editor._sam2ActiveLayer || !editor._sam2ActiveLayer.magicWandButton) return;

    const btn = editor._sam2ActiveLayer.magicWandButton;
    if (btn) {
      if (active) {
        btn.classList.add('active');
        btn.style.background = '#4CAF50';
        btn.style.color = 'white';
      } else {
        btn.classList.remove('active');
        btn.style.background = 'transparent';
        btn.style.color = '#888';
      }
    }
  };

  /**
   * Add SAM2 point and trigger prediction
   * @param {number} x - X coordinate in video space
   * @param {number} y - Y coordinate in video space
   * @param {boolean} isNegative - Whether this is a negative point (default: false)
   */
  editor.addSam2Point = (x, y, isNegative = false) => {
    const point = {
      x: x,
      y: y,
      label: isNegative ? 0 : 1,  // 0 = negative/background, 1 = positive/foreground
      uid: Date.now() + Math.random()
    };
    editor._sam2Points.push(point);

    // Render immediately to show the point
    editor.renderSam2PointsImmediate();

    editor.requestSam2Prediction();
  };

  /**
   * Render SAM2 points immediately (for instant visual feedback)
   */
  editor.renderSam2PointsImmediate = () => {
    if (!editor.refCanvasEditor || !editor.refCanvasEditor.ctx) return;

    const ctx = editor.refCanvasEditor.ctx;
    const lastPoint = editor._sam2Points[editor._sam2Points.length - 1];
    if (!lastPoint) return;

    // SAM2 points are stored in video space, need to convert to canvas space
    const canvasPos = editor.refCanvasEditor.transformToCanvasSpace?.(lastPoint.x, lastPoint.y) || lastPoint;
    const index = editor._sam2Points.length - 1;

    ctx.save();

    // Choose color based on label (positive=green, negative=red)
    const isNegative = lastPoint.label === 0;
    const pointColor = isNegative ? '#f44336' : '#4CAF50';  // Red for negative, green for positive

    // Draw circle with white border
    ctx.beginPath();
    ctx.arc(canvasPos.x, canvasPos.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = pointColor;
    ctx.fill();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Draw point number
    ctx.fillStyle = 'white';
    ctx.font = 'bold 10px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(index + 1, canvasPos.x, canvasPos.y);

    ctx.restore();
  };

  /**
   * Remove SAM2 point by UID
   * @param {number} uid - Unique identifier of the point to remove
   */
  editor.removeSam2Point = (uid) => {
    editor._sam2Points = editor._sam2Points.filter(p => p.uid !== uid);
    editor.refreshCanvas?.();

    // Rerun prediction if there are still points left
    if (editor._sam2Points.length > 0) {
      editor.requestSam2Prediction();
    } else {
      // Clear mask if no points left
      editor.clearSam2MaskPreview();
    }
  };

  /**
   * Find SAM2 point at canvas coordinates
   * @param {number} canvasX - X coordinate in canvas space
   * @param {number} canvasY - Y coordinate in canvas space
   * @param {number} threshold - Distance threshold for finding points (default: 10)
   * @returns {Object|null} The found point or null
   */
  editor.findSam2PointAt = (canvasX, canvasY, threshold = 10) => {
    if (!editor.refCanvasEditor) return null;

    for (const point of editor._sam2Points) {
      // SAM2 points are stored in video space, need to convert to canvas space
      const canvasPos = editor.refCanvasEditor.transformToCanvasSpace?.(point.x, point.y) || point;

      const dist = Math.sqrt(
        Math.pow(canvasPos.x - canvasX, 2) +
        Math.pow(canvasPos.y - canvasY, 2)
      );
      if (dist < threshold) {
        return point;
      }
    }
    return null;
  };

  /**
   * Request SAM2 prediction (debounced)
   * Debounces API calls to avoid excessive requests
   */
  editor.requestSam2Prediction = () => {
    // Clear existing timer
    if (editor._sam2DebounceTimer) {
      clearTimeout(editor._sam2DebounceTimer);
    }

    // Debounce API call
    editor._sam2DebounceTimer = setTimeout(async () => {
      if (editor._sam2Points.length === 0) {
        editor.clearSam2MaskPreview();
        return;
      }

      await editor.performSam2Prediction();
    }, 500); // 500ms debounce
  };

  /**
   * Perform SAM2 prediction via API
   */
  editor.performSam2Prediction = async () => {
    try {
      // Get current canvas image as base64
      const imageData = editor.getCanvasImageAsBase64();
      if (!imageData) {
        console.error("[SAM2] Failed to get canvas image");
        return;
      }

      // Prepare API request
      const response = await fetch('/wanvideowrapper_qq/sam2_predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: imageData,
          points: editor._sam2Points.map(p => ({
            x: p.x,
            y: p.y,
            label: p.label  // Use actual label from point (0=negative, 1=positive)
          }))
        })
      });

      if (!response.ok) {
        const error = await response.json();
        console.error("[SAM2] API error:", error);
        return;
      }

      const result = await response.json();
      if (result.success && result.path) {
        editor._sam2MaskPath = result.path;
        editor.renderSam2MaskPreview(result.path);
        editor.refreshCanvas?.(); // Trigger canvas refresh to show the mask
      }

    } catch (error) {
      console.error("[SAM2] Prediction failed:", error);
    }
  };

  /**
   * Clear SAM2 visuals (points and mask preview)
   */
  editor.clearSam2Visuals = () => {
    // Visuals will be cleared naturally by not rendering them
  };

  /**
   * Render SAM2 mask preview
   * @param {Array} path - Array of {x, y} normalized coordinates
   */
  editor.renderSam2MaskPreview = (path) => {
    if (!editor.refCanvasEditor) return;

    const ctx = editor.refCanvasEditor.ctx;
    if (!ctx || !path || path.length === 0) return;

    // Store the path for rendering
    editor._sam2MaskPath = path;
    editor.forceCanvasRefresh?.();
  };

  /**
   * Render SAM2 visuals (points and mask preview) on canvas
   * This function is called during canvas refresh
   * @param {CanvasRenderingContext2D} ctx - Canvas context
   * @param {number} width - Canvas width
   * @param {number} height - Canvas height
   */
  editor.renderSam2Visuals = (ctx, width, height) => {
    if (!editor._sam2Mode) return;

    // Render mask preview if available
    if (editor._sam2MaskPath && editor._sam2MaskPath.length > 0) {
      ctx.save();

      // Convert normalized path to canvas coordinates
      const canvasPath = editor._sam2MaskPath.map(pt => {
        // Path points are normalized (0-1), need to convert to canvas space
        const canvasPos = editor.refCanvasEditor.denormalizePoint(pt);
        return { x: canvasPos.x, y: canvasPos.y };
      });

      // Draw filled path with green transparency
      if (canvasPath.length > 2) {
        ctx.beginPath();
        ctx.moveTo(canvasPath[0].x, canvasPath[0].y);
        for (let i = 1; i < canvasPath.length; i++) {
          ctx.lineTo(canvasPath[i].x, canvasPath[i].y);
        }
        ctx.closePath();

        // Fill with green transparency
        ctx.fillStyle = 'rgba(76, 175, 80, 0.3)';
        ctx.fill();

        // Draw dashed green border
        ctx.strokeStyle = '#4CAF50';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]); // Dashed line
        ctx.stroke();
      }

      ctx.restore();
    }

    // Render SAM2 points
    if (editor._sam2Points.length > 0) {
      ctx.save();

      editor._sam2Points.forEach((point, index) => {
        // SAM2 points are stored in video space, need to convert to canvas space
        const canvasPos = editor.refCanvasEditor.transformToCanvasSpace?.(point.x, point.y) || point;

        // Choose color based on label (positive=green, negative=red)
        const isNegative = point.label === 0;
        const pointColor = isNegative ? '#f44336' : '#4CAF50';  // Red for negative, green for positive

        // Draw circle with white border (larger for visibility)
        ctx.beginPath();
        ctx.arc(canvasPos.x, canvasPos.y, 8, 0, Math.PI * 2);
        ctx.fillStyle = pointColor;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 3;
        ctx.stroke();

        // Draw point number for better visibility
        ctx.fillStyle = 'white';
        ctx.font = 'bold 10px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(index + 1, canvasPos.x, canvasPos.y);
      });

      ctx.restore();
    }
  };

  /**
   * Clear SAM2 mask preview only
   */
  editor.clearSam2MaskPreview = () => {
    editor._sam2MaskPath = null;
    editor.refreshCanvas?.(); // Trigger canvas refresh to clear the mask
  };

  /**
   * Get current canvas image as base64
   * @returns {string|null} Base64 encoded image or null
   */
  editor.getCanvasImageAsBase64 = () => {
    try {
      // Get the background image from the canvas editor
      if (editor.refCanvasEditor && editor.refCanvasEditor.backgroundImage) {
        // Create canvas to draw image
        const canvas = document.createElement('canvas');
        canvas.width = editor.refCanvasEditor.originalImageWidth || editor.refCanvasEditor.width;
        canvas.height = editor.refCanvasEditor.originalImageHeight || editor.refCanvasEditor.height;
        const ctx = canvas.getContext('2d');

        // Draw background image at original resolution
        ctx.drawImage(editor.refCanvasEditor.backgroundImage, 0, 0, canvas.width, canvas.height);

        // Convert to RGB by creating a temporary canvas and drawing without alpha
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = canvas.width;
        tempCanvas.height = canvas.height;
        const tempCtx = tempCanvas.getContext('2d');

        // Draw the image (this automatically handles RGBA to RGB conversion)
        tempCtx.drawImage(canvas, 0, 0);

        // Return as base64 JPEG (forces RGB conversion, no alpha channel)
        return tempCanvas.toDataURL('image/jpeg', 0.95);
      }
      return null;
    } catch (error) {
      console.error("[SAM2] Failed to get canvas image:", error);
      return null;
    }
  };

  /**
   * Bake SAM2 mask to lasso format for pencil mode editing
   * Converts the current SAM2 mask to lasso format and adds it to the layer
   */
  editor.bakeSam2MaskToLasso = () => {
    if (!editor._sam2MaskPath || editor._sam2MaskPath.length === 0) {
      return;
    }

    if (!editor._sam2ActiveLayer) {
      return;
    }

    // Get current layer data
    const layerData = editor._sam2ActiveLayer.value;

    // Initialize lassoShape if needed
    if (!layerData.lassoShape) {
      layerData.lassoShape = {
        additivePaths: [],
        subtractivePaths: []
      };
    }

    // Add SAM2 mask as additive path
    layerData.lassoShape.additivePaths.push(editor._sam2MaskPath);

    // Mark that this layer now has lasso data for pencil mode
    editor._sam2ActiveLayer.hasLassoData = true;
  };

  /**
   * Bake SAM2 mask to lasso format AND merge with existing shapes
   * This is called when switching from magic wand to lasso mode
   * It merges the SAM2 mask with existing lasso shapes if they overlap
   */
  editor.bakeAndMergeSam2MaskToLasso = () => {
    if (!editor._sam2MaskPath || editor._sam2MaskPath.length === 0) {
      return;
    }

    if (!editor._sam2ActiveLayer) {
      return;
    }

    const layerData = editor._sam2ActiveLayer.value;

    // Initialize lassoShape if needed
    if (!layerData.lassoShape) {
      layerData.lassoShape = {
        additivePaths: [],
        subtractivePaths: []
      };
    }

    // Check if there are existing paths that need merging
    const existingPaths = layerData.lassoShape.additivePaths || [];

    if (existingPaths.length > 0 && editor.computeMergedShape) {
      // Need to merge SAM2 mask with existing paths
      try {
        // Get the canvas dimensions for coordinate transformation
        const baseW = editor.refCanvasEditor?.originalImageWidth || editor.refCanvasEditor?.width || 640;
        const baseH = editor.refCanvasEditor?.originalImageHeight || editor.refCanvasEditor?.height || 480;

        // Convert normalized SAM2 path to canvas coordinates for merging
        const sam2PathCanvasCoords = editor._sam2MaskPath.map(p => ({
          x: p.x * baseW,
          y: p.y * baseH
        }));

        // Create a temporary shape object for merging
        const tempShape = {
          additivePaths: [...existingPaths],
          subtractivePaths: []
        };

        // Use the node's computeMergedShape function to merge overlapping paths
        const mergedContours = editor.computeMergedShape(
          tempShape,
          sam2PathCanvasCoords,
          false // isSubtractive
        );

        // Replace with merged result
        layerData.lassoShape.additivePaths = mergedContours;

        console.log('[bakeAndMergeSam2MaskToLasso] Merged SAM2 mask with', existingPaths.length, 'existing paths');
      } catch (error) {
        console.error('[bakeAndMergeSam2MaskToLasso] Merge failed, appending instead:', error);
        layerData.lassoShape.additivePaths.push(editor._sam2MaskPath);
      }
    } else {
      // No existing paths or merge function not available, just add the SAM2 mask
      layerData.lassoShape.additivePaths.push(editor._sam2MaskPath);
    }

    // Mark that this layer now has lasso data for pencil mode
    editor._sam2ActiveLayer.hasLassoData = true;

    // Update the ref data widget to persist changes
    if (editor.updateRefDataWidget) {
      editor.updateRefDataWidget();
    }
  };
}
