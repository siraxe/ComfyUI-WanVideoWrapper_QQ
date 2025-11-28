import {
  loadBackgroundVideo,
  clearBackgroundVideo,
  hasBackgroundVideo,
  updateVideoPosition
} from './canvas_video_background.js';

export function attachBackgroundHandlers(editor) {
  editor.recenterBackgroundImage = () => {
    // Update video position if video is loaded
    if (hasBackgroundVideo(editor)) {
      updateVideoPosition(editor);
      return;
    }

    // Otherwise handle static image
    if (editor.originalImageWidth && editor.originalImageHeight) {
      const margin = 80;
      const targetWidth = editor.width - margin * 2;
      const targetHeight = editor.height - margin * 2;
      const scale = Math.min(targetWidth / editor.originalImageWidth, targetHeight / editor.originalImageHeight, 1.0);
      editor.scale = scale;
      const newWidth = editor.originalImageWidth * editor.scale;
      const newHeight = editor.originalImageHeight * editor.scale;
      editor.offsetX = (editor.width - newWidth) / 2;
      editor.offsetY = (editor.height - newHeight) / 2;

      editor.backgroundImage
        .width(newWidth)
        .height(newHeight)
        .left(editor.offsetX)
        .top(editor.offsetY)
        .visible(true);
      editor.vis.render();
    }
  };

  editor.handleImageLoad = (img, file, base64String) => {
    editor.drawRuler = false;
    editor.originalImageWidth = img.width;
    editor.originalImageHeight = img.height;

    const imageUrl = file ? URL.createObjectURL(file) : `data:${editor.node.imgData.type};base64,${base64String}`;

    editor.backgroundImage.url(imageUrl);
    editor.recenterBackgroundImage();

    const activeWidget = editor.getActiveWidget();
    if (activeWidget && activeWidget.value.points_store) {
      try {
        const storedPoints = JSON.parse(activeWidget.value.points_store);
        // ✅ IMPORTANT: Check if points are already denormalized (canvas space)
        // If they are, don't denormalize again
        const arePointsDenormalized = editor.arePointsDenormalized?.(storedPoints);
        if (!arePointsDenormalized) {
          // Points are normalized [0,1], safe to denormalize
          editor.points = editor.denormalizePoints(storedPoints);
          console.log('[handleImageLoad] Points were normalized, denormalized with editor.scale:', editor.scale);
        } else {
          // Points are already in canvas space, use as-is
          console.log('[handleImageLoad] Points already denormalized, using as-is');
          editor.points = storedPoints;
        }
      } catch (e) {
        console.error("Error parsing points from active widget during image load:", e);
      }
    }

    editor.updatePath();

    if (editor.vis) {
      editor.vis.render();
    }

    if (editor.layerRenderer) {
      editor.layerRenderer.render();
    }
  };

  editor.processImage = (img, file) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    const width = img.width;
    const height = img.height;

    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(img, 0, 0, width, height);

    const base64String = canvas.toDataURL('image/jpeg', 0.5).replace('data:', '').replace(/^.+,/, '');

    editor.node.imgData = {
      name: file.name,
      lastModified: file.lastModified,
      size: file.size,
      type: file.type,
      base64: base64String
    };
    try {
      sessionStorage.setItem(`spline-editor-img-${editor.node.uuid}`, JSON.stringify(editor.node.imgData));
    } catch (e) {
      console.error("Spline Editor: Could not save image to session storage", e);
    }
    editor.handleImageLoad(img, file, base64String);
  };

  editor.handleImageFile = (file) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const img = new Image();
      img.src = reader.result;
      img.onload = () => editor.processImage(img, file);
    };
    reader.readAsDataURL(file);

    const imageUrl = URL.createObjectURL(file);
    const img = new Image();
    img.src = imageUrl;
    img.onload = () => editor.handleImageLoad(img, file, null);
  };

  editor.refreshBackgroundImage = () => {
    return new Promise((resolve, reject) => {
      // Check for video data first
      if (editor.node.videoData && editor.node.videoData.path) {
        // Load video instead of image
        loadBackgroundVideo(editor, editor.node.videoData);
        resolve();
        return;
      }

      // Otherwise load static image
      if (editor.node.imgData && editor.node.imgData.base64) {
        const base64String = editor.node.imgData.base64;
        const imageUrl = `data:${editor.node.imgData.type};base64,${base64String}`;
        const img = new Image();
        img.src = imageUrl;
        img.onload = () => {
          editor.handleImageLoad(img, null, base64String);
          editor.renderPreviousSplines();
          editor.layerRenderer.render();
          resolve();
        };
        img.onerror = (error) => {
          console.error(`refreshBackgroundImage: Failed to load image:`, error);
          reject(error);
        };
      } else {
        // No image or video data available, resolve immediately
        resolve();
      }
    });
  };

  /**
   * Handle Python UI updates for background video
   * Called when Python backend sends bg_video metadata
   */
  editor.handlePythonUpdate = (uiData) => {
    console.log('[handlePythonUpdate] Called with uiData:', uiData);

    // Check for video data in UI updates
    if (uiData.bg_video && uiData.bg_video.length > 0) {
      const videoInfo = uiData.bg_video[0];
      console.log('[handlePythonUpdate] Found video info:', videoInfo);
      editor.node.videoData = videoInfo;
      console.log('[handlePythonUpdate] Calling loadBackgroundVideo...');
      loadBackgroundVideo(editor, videoInfo);
      console.log('[handlePythonUpdate] Video loading initiated');
      return true;  // Video loaded
    }
    console.log('[handlePythonUpdate] No bg_video found in uiData');
    return false;  // No video
  };

  /**
   * Helper method to update layer coordinates after scale change
   * Called when video scale is set to re-denormalize all layer coordinates
   */
  editor.updateLayerCoordinatesAfterScaleChange = () => {
    // Get all layer widgets and re-denormalize their coordinates
    const widgets = editor.getSplineWidgets?.() || [];

    for (const widget of widgets) {
      if (widget.value?.points_store) {
        try {
          const storedPoints = JSON.parse(widget.value.points_store);
          // Check if points are already denormalized (canvas space)
          const arePointsDenormalized = editor.arePointsDenormalized?.(storedPoints);
          if (!arePointsDenormalized) {
            // Points are normalized [0,1], safe to denormalize with new scale
            const denormalizedPoints = editor.denormalizePoints(storedPoints);
            editor.points = denormalizedPoints;
            console.log('[updateLayerCoordinatesAfterScaleChange] Points were normalized, re-denormalized with new editor.scale:', editor.scale);
          } else {
            // Points are already in canvas space, no need to re-denormalize
            console.log('[updateLayerCoordinatesAfterScaleChange] Points already denormalized, using as-is');
            editor.points = storedPoints;
          }

          if (editor.layerRenderer) {
            editor.layerRenderer.render();
          }
        } catch (e) {
          console.error('Error re-denormalizing points after scale change:', e);
        }
      }
    }
  };

  /**
   * Helper method to refresh active layer coordinates
   * Called when video scale is set to re-denormalize active layer coordinates
   */
  editor.refreshActiveLayerCoordinates = () => {
    const activeWidget = editor.getActiveWidget?.();
    if (activeWidget && activeWidget.value?.points_store) {
      try {
        const storedPoints = JSON.parse(activeWidget.value.points_store);
        // Check if points are already denormalized (canvas space)
        const arePointsDenormalized = editor.arePointsDenormalized?.(storedPoints);
        if (!arePointsDenormalized) {
          // Points are normalized [0,1], safe to denormalize
          editor.points = editor.denormalizePoints(storedPoints);
          console.log('[refreshActiveLayerCoordinates] Points were normalized, denormalized with editor.scale:', editor.scale);
        } else {
          // Points are already in canvas space, use as-is
          console.log('[refreshActiveLayerCoordinates] Points already denormalized, using as-is');
          editor.points = storedPoints;
        }

        if (editor.layerRenderer) {
          editor.layerRenderer.render();
        }
      } catch (e) {
        console.error('Error refreshing active layer coordinates:', e);
      }
    }
  };

  /**
   * Helper method to detect if points are already denormalized
   * Normalized points should be in [0, 1] range
   * Denormalized points should be in canvas range (0 to width/height)
   */
  editor.arePointsDenormalized = (points) => {
    if (!points || points.length === 0) return false;

    // Normalized points should be in [0, 1] range
    // Denormalized points should be in canvas range (0 to width/height)
    for (const point of points) {
      if (point.x !== undefined && point.y !== undefined) {
        // If any point is outside [0,1], assume it's denormalized
        if (point.x < -0.1 || point.x > 1.1 || point.y < -0.1 || point.y > 1.1) {
          return true;
        }
      }
    }
    return false;
  };
}
