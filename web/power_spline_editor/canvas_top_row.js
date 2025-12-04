// canvas_top_row.js
import {
    drawWidgetButton,
    drawNumberWidgetPart,
    RgthreeBaseWidget
} from './drawing_utils.js';
import { app } from '../../../scripts/app.js';


// == SHARED UTILITIES


/**
 * Check if node is connected to PrepareRefs node
 */
export async function checkIfConnectedToPrepareRefs(node, inputName = 'ref_images') {
  try {
    const { findConnectedSourceNode } = await import('./graph_query.js');
    const sourceNodeObj = findConnectedSourceNode(node, inputName);
    
    if (sourceNodeObj?.node?.type === 'PrepareRefs') {
      return sourceNodeObj.node;
    }
  } catch (e) {
    console.warn('[checkIfConnectedToPrepareRefs] Error:', e);
  }
  return null;
}

/**
 * Load images from ref folder (used by PrepareRefs and PowerSplineEditor)
 */
export async function loadImagesFromRefFolder(node, backendPaths = null) {
  console.log("[loadImagesFromRefFolder] Starting", { backendPaths });
  const { loadImageAsBase64, findConnectedSourceNode } = await import('./graph_query.js');
  const timestamp = Date.now();

  // Check if bg_image is connected to something OTHER than PrepareRefs
  const bgImageSourceNode = findConnectedSourceNode(node, 'bg_image');
  const bgImageIsConnectedExternally = bgImageSourceNode?.node &&
    bgImageSourceNode.node.type !== 'PrepareRefs';

  // 1. Load bg_image_cl.png only if bg_image is NOT connected to external source
  if (!bgImageIsConnectedExternally) {
    try {
      const bgImageUrl = new URL(`ref/bg_image_cl.png?t=${timestamp}`, import.meta.url).href;
      console.log("[loadImagesFromRefFolder] Loading bg_image_cl.png from:", bgImageUrl);
      const bgImageData = await loadImageAsBase64(bgImageUrl);

      if (bgImageData) {
        console.log("[loadImagesFromRefFolder] bg_image_cl.png loaded successfully");
        node.originalRefImageData = {
          name: 'bg_image_cl.png',
          base64: bgImageData.split(',')[1],
          type: 'image/png'
        };

        if (node.bgImageManager?.updateBackgroundImage) {
          await node.bgImageManager.updateBackgroundImage();
          console.log("[loadImagesFromRefFolder] Background image updated");
        }
      }
    } catch (e) {
      console.warn('[loadImagesFromRefFolder] Failed to load bg_image_cl.png:', e);
    }
  } else {
    console.log("[loadImagesFromRefFolder] bg_image connected to external source, skipping bg_image_cl.png");
  }

  // 2. Prepare ref images from backend paths (NO loading)
  let refImages = [];

  if (backendPaths?.ref_images && Array.isArray(backendPaths.ref_images)) {
    console.log("[loadImagesFromRefFolder] Using backend ref_images:", backendPaths.ref_images);

    // Backend returns: ['ref/ref_1.png', 'ref/ref_2.png', 'ref/ref_3.png']
    // or objects with {filename, width, height}
    refImages = backendPaths.ref_images.map((item) => {
      if (typeof item === 'string') {
        // Extract filename from path like 'ref/ref_1.png'
        const filename = item.split('/').pop();
        return {
          path: `power_spline_editor/ref/${filename}`, // Use full path that won't trigger /view endpoint
          width: 768,
          height: 768
        };
      } else {
        // Object format
        const filename = item.path?.split('/').pop() || item.filename;
        return {
          path: `power_spline_editor/ref/${filename}`, // Use full path that won't trigger /view endpoint
          width: item.width || 768,
          height: item.height || 768
        };
      }
    });
  }

  console.log("[loadImagesFromRefFolder] Total refs prepared:", refImages.length);

  // 3. Update box layer refs
  if (refImages.length > 0 && node.layerManager) {
    const activeWidget = node.layerManager.getActiveWidget?.();
    if (!activeWidget || activeWidget.value?.type !== 'box_layer') {
      await updateAllBoxLayersFromRefFolder(node, refImages);
    } else {
      await updateBoxLayerWithRefImages(node, activeWidget, refImages);
    }
  }

  // Force final render
  if (node.editor?.layerRenderer) {
    console.log("[loadImagesFromRefFolder] Forcing final render");
    node.editor.layerRenderer.render();
  }

  console.log("[loadImagesFromRefFolder] Finished");
}

/**
 * Update a specific box layer with ref images
 */
export async function updateBoxLayerWithRefImages(node, boxWidget, refImages) {
  const attachments = refImages.map((imgObj, i) => ({
    path: imgObj.path,
    type: 'image/png',
    width: imgObj.width || 768,
    height: imgObj.height || 768,
    name: `ref_${i + 1}.png`
  }));

  boxWidget.value.ref_attachment = { entries: attachments };

  const currentSelection = boxWidget.value.ref_selection;
  if (attachments.length > 0) {
    boxWidget.value.ref_selection = currentSelection === 'no_ref' ? 'ref_1' : currentSelection;
  } else {
    boxWidget.value.ref_selection = 'no_ref';
  }

  if (node.editor?.layerRenderer?.clearRefImageCache) {
    node.editor.layerRenderer.clearRefImageCache();
  }

  node.setDirtyCanvas(true, true);
}

/**
 * Update all box layers with ref images
 */
export async function updateAllBoxLayersFromRefFolder(node, refImages) {
  const widgets = node.layerManager?.getSplineWidgets?.() || [];
  const boxWidgets = widgets.filter(w => w?.value?.type === 'box_layer');

  if (!boxWidgets.length) {
    console.log('[updateAllBoxLayersFromRefFolder] No box layers found');
    return;
  }

  for (const boxWidget of boxWidgets) {
    await updateBoxLayerWithRefImages(node, boxWidget, refImages);
  }

  console.log(`[updateAllBoxLayersFromRefFolder] Updated ${boxWidgets.length} box layer(s)`);
}
 
// == BUTTON HANDLERS


/**
 * Handler for PrepareRefs "Refresh" button
 */
export async function handlePrepareRefsRefresh(node) {
  console.log("[handlePrepareRefsRefresh] Refresh button clicked");

  try {
    // Try to get image from connected node (ImageResizeKJv2 or LoadImage)
    const { findConnectedSourceNode, getReferenceImageFromConnectedNode } =
      await import('./graph_query.js');

    let imageData = null;

    // Check for connected source on bg_image input
    const sourceNodeObj = findConnectedSourceNode(node, 'bg_image');

    if (sourceNodeObj?.node) {
      console.log("[handlePrepareRefsRefresh] Found connected node:", sourceNodeObj.node.type);

      // Get image from connected node
      imageData = await getReferenceImageFromConnectedNode(node, 'bg_image');

      if (imageData) {
        console.log("[handlePrepareRefsRefresh] Successfully loaded image from connected node");

        // Load the image to the canvas
        const img = await new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => {
            node.refCanvasEditor.loadBackgroundImage(image);
            resolve(image);
          };
          image.onerror = reject;
          image.src = imageData;
        });

        // Store for persistence
        node.loadedBgImage = img;

        // Save via backend
        try {
          await fetch('/wanvideowrapper_qq/save_prepare_refs_images', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bg_image: imageData, ref_images: [] })
          })
          .then(r => r.json())
          .then(res => {
            if (res.success && res.paths?.bg_image_path) {
              node.properties.bg_image_path = res.paths.bg_image_path;
              try {
                sessionStorage.setItem(
                  `prepare-refs-bg-${node.uuid}`,
                  res.paths.bg_image_path
                );
              } catch (e) { /* ignore */ }
            }
          })
          .catch(console.error);
        } catch (e) {
          console.warn('[handlePrepareRefsRefresh] Failed to save image to backend:', e);
        }

        // Refresh canvas display
        node.forceCanvasRefresh();
        return;
      }
    }

    console.log("[handlePrepareRefsRefresh] No connected image node found");

  } catch (e) {
    console.error('[handlePrepareRefsRefresh] Error:', e);
  }

  // Always force refresh at the end
  if (node.forceCanvasRefresh) {
    node.forceCanvasRefresh();
  }
}

/**
 * Handler for PowerSplineEditor "Canvas" button
 */
export async function handleCanvasRefresh(node) {
  console.log("[handleCanvasRefresh] Canvas button clicked");

  try {
    // Check if connected to PrepareRefs
    const prepareRefsNode = await checkIfConnectedToPrepareRefs(node, 'ref_images');

    if (prepareRefsNode) {
      console.log("[handleCanvasRefresh] PrepareRefs connection detected");
      
      try {
        const { triggerPrepareRefsBackend } = await import('./trigger_ref_refresh.js');
        const result = await triggerPrepareRefsBackend(prepareRefsNode);
        console.log("[handleCanvasRefresh] triggerPrepareRefsBackend result:", result);

        if (result.success) {
          console.log("[handleCanvasRefresh] Backend processing successful");

          // Load newly generated images using backend paths
          await loadImagesFromRefFolder(node, result.paths);

          // Check if video was generated
          if (result.paths?.bg_video) {
            console.log('[handleCanvasRefresh] Video generated, loading:', result.paths.bg_video);
            const { loadBackgroundVideo } = await import('./canvas/canvas_video_background.js');
            if (node.editor && loadBackgroundVideo) {
              loadBackgroundVideo(node.editor, result.paths.bg_video);
            }
          }
        } else {
          console.error('[handleCanvasRefresh] Backend processing failed:', result.error);
        }
      } catch (e) {
        console.error('[handleCanvasRefresh] Backend trigger error:', e);
      }
    } else {
      console.log("[handleCanvasRefresh] PrepareRefs NOT connected, using original behavior");
      
      // Original behavior: update from connected nodes
      if (node.refImageManager?.updateAllBoxLayerRefs) {
        try {
          await node.refImageManager.updateAllBoxLayerRefs();
        } catch (e) {
          console.warn('[handleCanvasRefresh] Failed to update box layer refs:', e);
        }
      }

      if (node.refImageManager?.updateReferenceImageFromConnectedNode) {
        try {
          await node.refImageManager.updateReferenceImageFromConnectedNode(true);

          // Create the editor if it doesn't exist
          if (!node.editor) {
            const SplineEditor2 = (await import('./canvas/canvas_main.js')).default;
            node.editor = new SplineEditor2(node);
          }

          // Refresh the background image to trigger canvas render
          if (node.editor?.refreshBackgroundImage) {
            await node.editor.refreshBackgroundImage();
          } else if (node.editor?.vis) {
            // Fallback: Force canvas render if refreshBackgroundImage not available
            node.editor.vis.render();
          }

          if (node.editor?.layerRenderer) {
            node.editor.layerRenderer.render();
          }
        } catch (e) {
          console.warn('[handleCanvasRefresh] Failed to update reference image:', e);
        }
      }
    }

    // Handle frames refresh
    if (node.handleFramesRefresh) {
      node.handleFramesRefresh();
    }
  } catch (e) {
    console.error('[handleCanvasRefresh] Error:', e);
  }
}

/**
 * Handler for "Frames" button (refresh keyframes)
 */
export async function handleFramesRefresh(node) {
  console.log("[handleFramesRefresh] Frames button clicked");
  
  if (node.handleFramesRefresh) {
    try {
      node.handleFramesRefresh();
    } catch (e) {
      console.error('[handleFramesRefresh] Error:', e);
    }
  }
}

// == TOP ROW WIDGET


export class TopRowWidget extends RgthreeBaseWidget {
  constructor(name = "TopRowWidget", visibility = {}, handlers = {}) {
    super(name);
    this.type = "custom";
    this.options = { serialize: false };
    this.value = {};
    this.haveMouseMovedValue = false;
    this.canvasButtonMouseDown = false;
    this.framesButtonMouseDown = false;
    this.visibility = {
      refreshCanvasButton: true,
      refreshFramesButton: true,
      bgOpacityControl: true,
      animToggleButton: true,
      widthControl: true,
      heightControl: true,
      ...visibility,
    };
    // Store custom handlers
    this.handlers = {
      onRefreshCanvas: handlers.onRefreshCanvas || null,
      onRefreshFrames: handlers.onRefreshFrames || null,
      ...handlers
    };
    this.hitAreas = {
      refreshCanvasButton: { bounds: [0, 0], onClick: null },
      refreshFramesButton: { bounds: [0, 0], onClick: null },
      bgOpacityDec: { bounds: [0, 0], onClick: null },
      bgOpacityVal: { bounds: [0, 0], onClick: null },
      bgOpacityInc: { bounds: [0, 0], onClick: null },
      bgOpacityAny: { bounds: [0, 0], onMove: null },
      widthDec: { bounds: [0, 0], onClick: null },
      widthVal: { bounds: [0, 0], onClick: null },
      widthInc: { bounds: [0, 0], onClick: null },
      widthAny: { bounds: [0, 0], onMove: null },
      heightDec: { bounds: [0, 0], onClick: null },
      heightVal: { bounds: [0, 0], onClick: null },
      heightInc: { bounds: [0, 0], onClick: null },
      heightAny: { bounds: [0, 0], onMove: null },
    };
  }

  draw(ctx, node, w, posY, height) {
    const margin = 15;
    const spacing = 10;
    const midY = posY + height * 0.5;

    ctx.save();

    const assignBounds = (name, bounds) => {
      const area = this.hitAreas[name];
      if (!area) return;
      area.bounds = bounds;
      area.onClick = null;
      area.onDown = null;
      area.onUp = null;
      area.onMove = null;
      area.onRightDown = null;
    };

    // Get widget values
    const widthWidget = node.widgets?.find(w => w.name === "mask_width");
    const widthValue = widthWidget ? widthWidget.value : 512;
    const heightWidget = node.widgets?.find(w => w.name === "mask_height");
    const heightValue = heightWidget ? heightWidget.value : 512;
    const bgOpacityWidget = node.widgets?.find(w => w.name === "bg_opacity");
    const bgOpacityValue = bgOpacityWidget ? Math.round(bgOpacityWidget.value * 100) : 100;

    // Calculate available width
    const availableWidth = node.size[0] - margin * 2 - spacing * 4;

    // Calculate component widths
    const refreshCanvasWidth = availableWidth * 0.12;
    const refreshFramesWidth = availableWidth * 0.12;
    const bgOpacityControlWidth = availableWidth * 0.18;
    const iconButtonWidth = Math.max(20, Math.min(28, availableWidth * 0.05));
    const dimensionsAreaWidth = availableWidth - (
      refreshCanvasWidth + spacing +
      refreshFramesWidth + spacing +
      bgOpacityControlWidth + spacing +
      iconButtonWidth
    );

    const startX = margin;
    let posX = startX;

    // Draw Refresh Canvas button
    if (this.visibility.refreshCanvasButton) {
      drawWidgetButton(
        ctx,
        { size: [refreshCanvasWidth, height], pos: [posX, posY] },
        "🔄 Refresh",
        this.canvasButtonMouseDown
      );
    }
    assignBounds("refreshCanvasButton", [posX, refreshCanvasWidth]);
    posX += refreshCanvasWidth + spacing;

    // Draw Refresh Frames button
    if (this.visibility.refreshFramesButton) {
      drawWidgetButton(
        ctx,
        { size: [refreshFramesWidth, height], pos: [posX, posY] },
        "🕞 Frames",
        this.framesButtonMouseDown
      );
    }
    assignBounds("refreshFramesButton", [posX, refreshFramesWidth]);
    posX += refreshFramesWidth + spacing;

    // Draw bg_opacity control
    const bgOpacityLabelWidth = 30;

    if (this.visibility.bgOpacityControl) {
      // Draw background
      ctx.fillStyle = LiteGraph.WIDGET_BGCOLOR;
      ctx.fillRect(posX, posY, bgOpacityControlWidth, height);
      ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
      ctx.strokeRect(posX, posY, bgOpacityControlWidth, height);

      // Draw label
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
      ctx.fillText("BG:", posX + 5, midY);
    }

    const bgOpacityControlX = posX + bgOpacityLabelWidth;
    const [bgOpLeftArrow, bgOpText, bgOpRightArrow] = drawNumberWidgetPart(ctx, {
      posX: bgOpacityControlX,
      posY,
      height,
      value: bgOpacityValue,
      direction: 1,
      textColor: this.visibility.bgOpacityControl ? undefined : "transparent",
    });

    assignBounds("bgOpacityDec", bgOpLeftArrow);
    assignBounds("bgOpacityVal", bgOpText);
    assignBounds("bgOpacityInc", bgOpRightArrow);
    assignBounds("bgOpacityAny", [bgOpLeftArrow[0], bgOpRightArrow[0] + bgOpRightArrow[1] - bgOpLeftArrow[0]]);
    posX += bgOpacityControlWidth + spacing;

    // Animation toggle icon
    const isAnimOn = !!(node?.editor?._inactiveFlowEnabled ?? false);
    if (this.visibility.animToggleButton) {
      drawWidgetButton(
        ctx,
        { size: [iconButtonWidth, height], pos: [posX, posY] },
        "~",
        isAnimOn
      );
      if (isAnimOn) {
        const pad = 0.5;
        ctx.save();
        ctx.strokeStyle = '#2cc6ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(posX + pad, posY + pad, iconButtonWidth - pad * 2, height - pad * 2, [4]);
        ctx.stroke();
        ctx.restore();
      }
      this.hitAreas.animToggleButton = {
        bounds: [posX, iconButtonWidth],
        onClick: (e, p, n) => {
          if (n?.editor) {
            n.editor._inactiveFlowEnabled = !n.editor._inactiveFlowEnabled;
            try { n.editor.layerRenderer?.updateInactiveDash?.(); } catch {}
            n.setDirtyCanvas(true, true);
          }
          return true;
        }
      };
    } else {
      assignBounds("animToggleButton", [posX, iconButtonWidth]);
    }
    posX += iconButtonWidth + spacing;

    // Draw width/height controls
    const roundedAreaX = posX;
    const roundedAreaY = posY;
    const roundedAreaWidth = dimensionsAreaWidth;
    const roundedAreaHeight = height;

    ctx.fillStyle = LiteGraph.WIDGET_BGCOLOR;
    ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
    ctx.beginPath();
    ctx.roundRect(roundedAreaX, roundedAreaY, roundedAreaWidth, roundedAreaHeight, [roundedAreaHeight * 0.5]);
    ctx.fill();
    ctx.stroke();

    const controlSpacing = 20;
    const numberControlWidth = drawNumberWidgetPart.WIDTH_TOTAL;
    const labelWidth = 40;
    const totalControlWidth = labelWidth + numberControlWidth + controlSpacing + labelWidth + numberControlWidth;

    const controlsStartX = roundedAreaX + (roundedAreaWidth - totalControlWidth) / 2;

    // Width control
    const widthLabel = "width:";
    const widthControlX = controlsStartX;

    if (this.visibility.widthControl) {
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
      ctx.fillText(widthLabel, widthControlX, midY);
    }

    const widthControlStartX = widthControlX + labelWidth;
    const [wLeftArrow, wText, wRightArrow] = drawNumberWidgetPart(ctx, {
      posX: widthControlStartX,
      posY,
      height,
      value: widthValue,
      direction: 1,
      textColor: this.visibility.widthControl ? undefined : "transparent",
    });

    assignBounds("widthDec", wLeftArrow);
    assignBounds("widthVal", wText);
    assignBounds("widthInc", wRightArrow);
    assignBounds("widthAny", [wLeftArrow[0], wRightArrow[0] + wRightArrow[1] - wLeftArrow[0]]);
    if (this.visibility.widthControl) {
      this.hitAreas.widthDec.onClick = () => this.stepWidth(node, -16);
      this.hitAreas.widthInc.onClick = () => this.stepWidth(node, 16);
      this.hitAreas.widthVal.onClick = () => this.promptWidth(node);
      this.hitAreas.widthAny.onMove = (event) => this.dragWidth(node, event);
    }

    // Height control
    const heightControlX = widthControlStartX + numberControlWidth + controlSpacing;
    const heightLabel = "height:";

    if (this.visibility.heightControl) {
      ctx.textBaseline = "middle";
      ctx.fillText(heightLabel, heightControlX, midY);
    }

    const heightControlStartX = heightControlX + labelWidth;
    const [hLeftArrow, hText, hRightArrow] = drawNumberWidgetPart(ctx, {
      posX: heightControlStartX,
      posY,
      height,
      value: heightValue,
      direction: 1,
      textColor: this.visibility.heightControl ? undefined : "transparent",
    });

    assignBounds("heightDec", hLeftArrow);
    assignBounds("heightVal", hText);
    assignBounds("heightInc", hRightArrow);
    assignBounds("heightAny", [hLeftArrow[0], hRightArrow[0] + hRightArrow[1] - hLeftArrow[0]]);
    if (this.visibility.heightControl) {
      this.hitAreas.heightDec.onClick = () => this.stepHeight(node, -16);
      this.hitAreas.heightInc.onClick = () => this.stepHeight(node, 16);
      this.hitAreas.heightVal.onClick = () => this.promptHeight(node);
      this.hitAreas.heightAny.onMove = (event) => this.dragHeight(node, event);
    }

    // Setup event handlers for refresh button
    if (this.visibility.refreshCanvasButton) {
      this.hitAreas.refreshCanvasButton.onClick = async () => {
        if (this.handlers.onRefreshCanvas) {
          await this.handlers.onRefreshCanvas(node);
        }
      };
      this.hitAreas.refreshCanvasButton.onDown = () => {
        this.canvasButtonMouseDown = true;
        node.setDirtyCanvas(true, false);
      };
      this.hitAreas.refreshCanvasButton.onUp = () => {
        this.canvasButtonMouseDown = false;
        node.setDirtyCanvas(true, false);
      };
    }

    if (this.visibility.refreshFramesButton) {
      this.hitAreas.refreshFramesButton.onClick = async () => {
        if (this.handlers.onRefreshFrames) {
          await this.handlers.onRefreshFrames(node);
        }
      };
      this.hitAreas.refreshFramesButton.onDown = () => {
        this.framesButtonMouseDown = true;
        node.setDirtyCanvas(true, false);
      };
      this.hitAreas.refreshFramesButton.onUp = () => {
        this.framesButtonMouseDown = false;
        node.setDirtyCanvas(true, false);
      };
    }

    // Setup bg_opacity control handlers
    if (this.visibility.bgOpacityControl) {
      this.hitAreas.bgOpacityDec.onClick = () => this.stepBgOpacity(node, -5);
      this.hitAreas.bgOpacityInc.onClick = () => this.stepBgOpacity(node, 5);
      this.hitAreas.bgOpacityVal.onClick = () => this.promptBgOpacity(node);
      this.hitAreas.bgOpacityAny.onMove = (event) => this.dragBgOpacity(node, event);
    }

    ctx.restore();
  }

  // Width controls
  stepWidth(node, step) {
    const widthWidget = node.widgets?.find(w => w.name === "mask_width");
    if (widthWidget) {
      const newValue = widthWidget.value + step;
      widthWidget.value = node.sizeManager
        ? node.sizeManager.constrainCanvasWidth(newValue)
        : Math.max(64, newValue);
      if (widthWidget.callback) {
        widthWidget.callback(widthWidget.value);
      }
      node.setDirtyCanvas(true, true);
    }
  }

  promptWidth(node) {
    if (this.haveMouseMovedValue) return;
    const widthWidget = node.widgets?.find(w => w.name === "mask_width");
    if (widthWidget) {
      const canvas = app.canvas;
      canvas.prompt("Width", widthWidget.value, (v) => {
        const newValue = Number(v);
        widthWidget.value = node.sizeManager
          ? node.sizeManager.constrainCanvasWidth(newValue)
          : Math.max(64, newValue);
        if (widthWidget.callback) {
          widthWidget.callback(widthWidget.value);
        }
      });
    }
  }

  dragWidth(node, event) {
    if (event.deltaX) {
      this.haveMouseMovedValue = true;
      const widthWidget = node.widgets?.find(w => w.name === "mask_width");
      if (widthWidget) {
        const newValue = widthWidget.value + event.deltaX * 2;
        widthWidget.value = node.sizeManager
          ? node.sizeManager.constrainCanvasWidth(newValue)
          : Math.max(64, newValue);
        if (widthWidget.callback) {
          widthWidget.callback(widthWidget.value);
        }
        node.setDirtyCanvas(true, true);
      }
    }
  }

  // Height controls
  stepHeight(node, step) {
    const heightWidget = node.widgets?.find(w => w.name === "mask_height");
    if (heightWidget) {
      const newValue = heightWidget.value + step;
      heightWidget.value = node.sizeManager
        ? node.sizeManager.constrainCanvasHeight(newValue)
        : Math.max(64, newValue);
      if (heightWidget.callback) {
        heightWidget.callback(heightWidget.value);
      }
      node.setDirtyCanvas(true, true);
    }
  }

  promptHeight(node) {
    if (this.haveMouseMovedValue) return;
    const heightWidget = node.widgets?.find(w => w.name === "mask_height");
    if (heightWidget) {
      const canvas = app.canvas;
      canvas.prompt("Height", heightWidget.value, (v) => {
        const newValue = Number(v);
        heightWidget.value = node.sizeManager
          ? node.sizeManager.constrainCanvasHeight(newValue)
          : Math.max(64, newValue);
        if (heightWidget.callback) {
          heightWidget.callback(heightWidget.value);
        }
      });
    }
  }

  dragHeight(node, event) {
    if (event.deltaX) {
      this.haveMouseMovedValue = true;
      const heightWidget = node.widgets?.find(w => w.name === "mask_height");
      if (heightWidget) {
        const newValue = heightWidget.value + event.deltaX * 2;
        heightWidget.value = node.sizeManager
          ? node.sizeManager.constrainCanvasHeight(newValue)
          : Math.max(64, newValue);
        if (heightWidget.callback) {
          heightWidget.callback(heightWidget.value);
        }
        node.setDirtyCanvas(true, true);
      }
    }
  }

  // BG opacity controls
  stepBgOpacity(node, step) {
    const bgOpacityWidget = node.widgets?.find(w => w.name === "bg_opacity");
    if (bgOpacityWidget) {
      const newValue = Math.max(0, Math.min(100, Math.round(bgOpacityWidget.value * 100) + step)) / 100;
      bgOpacityWidget.value = newValue;
      if (bgOpacityWidget.callback) {
        bgOpacityWidget.callback(newValue);
      }
      node.setDirtyCanvas(true, true);
    }
  }

  promptBgOpacity(node) {
    if (this.haveMouseMovedValue) return;
    const bgOpacityWidget = node.widgets?.find(w => w.name === "bg_opacity");
    if (bgOpacityWidget) {
      const canvas = app.canvas;
      canvas.prompt("Background Opacity (0-100)", Math.round(bgOpacityWidget.value * 100), (v) => {
        const newValue = Math.max(0, Math.min(100, Number(v))) / 100;
        bgOpacityWidget.value = newValue;
        if (bgOpacityWidget.callback) {
          bgOpacityWidget.callback(newValue);
        }
      });
    }
  }

  dragBgOpacity(node, event) {
    if (event.deltaX) {
      this.haveMouseMovedValue = true;
      const bgOpacityWidget = node.widgets?.find(w => w.name === "bg_opacity");
      if (bgOpacityWidget) {
        const newValue = Math.max(0, Math.min(100, Math.round(bgOpacityWidget.value * 100) + event.deltaX)) / 100;
        bgOpacityWidget.value = newValue;
        if (bgOpacityWidget.callback) {
          bgOpacityWidget.callback(newValue);
        }
        node.setDirtyCanvas(true, true);
      }
    }
  }

  // Mouse event handlers
  mouse(event, pos, node) {
    return super.mouse(event, pos, node);
  }

  onMouseUp(event, pos, node) {
    super.onMouseUp(event, pos, node);
    this.haveMouseMovedValue = false;
    this.canvasButtonMouseDown = false;
    this.framesButtonMouseDown = false;
  }

  computeSize(width) {
    return [width, LiteGraph.NODE_WIDGET_HEIGHT];
  }
}