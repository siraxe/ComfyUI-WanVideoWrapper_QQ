/**
 * Background Image Manager Module
 * Handles background image updates, overlays, and display management
 */

import {
  darkenImage,
  scaleImageToRefDimensions,
  processBgImage,
  createImageOverlayForConfigure
} from '../image_overlay.js';
import { clearBackgroundVideo, updateVideoBrightness, hasBackgroundVideo } from '../canvas/canvas_video_background.js';
import {
  loadImageAsBase64,
  getCachedRefImage,
  safeSetSessionItem,
  blobToBase64,
  getImageDimensions,
  loadImageAndExtractBase64
} from './image-cache.js';

/**
 * Create background image manager instance for a node
 * @param {Object} node - The PowerSplineEditor node instance
 * @returns {Object} - Manager with methods for handling background images
 */
export function createBackgroundImageManager(node) {
  return {
    /**
     * Update background image with current opacity
     */
    async updateBackgroundImage() {
      console.log('[updateBackgroundImage] Called');

      // Get opacity value
      const bgOpacityWidget = node.widgets?.find(w => w.name === "bg_opacity");
      const opacity = bgOpacityWidget ? bgOpacityWidget.value : 1.0;

      // Check if we have a video background instead of an image
      if (node.editor && hasBackgroundVideo(node.editor)) {
        console.log('[updateBackgroundImage] Video detected, updating video brightness');
        updateVideoBrightness(node.editor, opacity);
        return; // Don't process image when video is active
      }

      // No video, proceed with image processing
      // Load reference image with opacity applied
      await this._loadReferenceImageWithOpacity(opacity);
    },

    /**
     * Load reference image and apply opacity (darkening)
     */
    async _loadReferenceImageWithOpacity(opacity) {
      try {
        // Try to get the reference image from various sources
        let refImageData = null;

        if (node.originalRefImageData?.base64) {
          // Use original ref image if available (from refresh button)
          const imgType = node.originalRefImageData.type || 'image/jpeg';
          refImageData = {
            base64: node.originalRefImageData.base64,
            type: imgType
          };
        } else {
          // Try to load cached ref image
          const cachedImageUrl = await this._loadCorrectCachedRefImage();
          if (cachedImageUrl) {
            // Convert URL to base64
            refImageData = await this._urlToBase64(cachedImageUrl);
          }
        }

        if (refImageData) {
          // Apply opacity to the reference image
          await this._applyOpacityToImage(refImageData.base64, refImageData.type, opacity);
        } else {
          console.warn('[_loadReferenceImageWithOpacity] No reference image found');
        }
      } catch (error) {
        console.error('Error loading reference image with opacity:', error);
      }
    },

    /**
     * Apply opacity to base64 image (0.0 = black, 1.0 = full brightness)
     */
    async _applyOpacityToImage(base64Data, imageType, opacity) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');

          // Draw the image with the specified opacity
          ctx.globalAlpha = opacity;
          ctx.drawImage(img, 0, 0);
          ctx.globalAlpha = 1.0; // Reset

          const processedDataUrl = canvas.toDataURL('image/jpeg');
          node.imgData = {
            name: 'bg_image.png',
            base64: processedDataUrl.split(',')[1],
            type: 'image/jpeg'
          };

          node.editor?.refreshBackgroundImage?.();
          resolve();
        };
        img.onerror = () => {
          console.error('Error loading image for opacity adjustment');
          reject(new Error('Failed to load image'));
        };
        img.src = `data:${imageType};base64,${base64Data}`;
      });
    },

    /**
     * Convert image URL to base64
     */
    async _urlToBase64(imageUrl) {
      return new Promise(async (resolve, reject) => {
        try {
          const response = await fetch(imageUrl);
          if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.status}`);
          }
          const blob = await response.blob();
          const reader = new FileReader();
          reader.onloadend = () => {
            const dataUrl = reader.result;
            const base64 = dataUrl.split(',')[1];
            const type = blob.type || 'image/jpeg';
            resolve({ base64, type });
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        } catch (error) {
          reject(error);
        }
      });
    },

    /**
     * Load the correct cached ref image based on PrepareRefs connection
     */
    async _loadCorrectCachedRefImage() {
      const isConnectedToPrepareRefs =
        node.checkIfConnectedToPrepareRefs?.() || false;

      if (isConnectedToPrepareRefs) {
        // Load bg_image_cl.png from ref folder
        try {
          const timestamp = Date.now();
          const refImageUrl = new URL(
            `../ref/bg_image_cl.png?t=${timestamp}`,
            import.meta.url
          ).href;
          const response = await fetch(refImageUrl);
          if (response.ok) {
            const blob = await response.blob();
            return new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
          }
        } catch (e) {
          console.error('Failed to load bg_image_cl.png from ref folder:', e);
        }
        return null;
      } else {
        // Load bg_image.png from bg folder (standard behavior)
        return await this._loadCachedRefImageAsBase64();
      }
    },

    /**
     * Load cached ref_image as base64 (local implementation)
     */
    async _loadCachedRefImageAsBase64() {
      try {
        // First try to load from actual file in bg folder
        const timestamp = Date.now();
        const refImageUrl = new URL(
          `../bg/bg_image.png?t=${timestamp}`,
          import.meta.url
        ).href;
        const response = await fetch(refImageUrl);
        if (response.ok) {
          const blob = await response.blob();
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }

        // If file doesn't exist, try to load from sessionStorage cache
        const cachedData = await getCachedRefImage();
        if (cachedData) {
          return `data:${cachedData.type};base64,${cachedData.base64}`;
        }

        return null;
      } catch (e) {
        console.error('Failed to load cached ref image as base64:', e);
        try {
          const cachedData = await getCachedRefImage();
          return cachedData
            ? `data:${cachedData.type};base64,${cachedData.base64}`
            : null;
        } catch (fallbackError) {
          console.error('Fallback cache also failed:', fallbackError);
          return null;
        }
      }
    },


    /**
     * Load background image from URL with optional scaling
     */
    loadBackgroundImageFromUrl(imageUrl, imageName, targetWidth, targetHeight) {
      loadImageAsBase64(imageUrl).then(dataUrl => {
        if (!dataUrl) {
          console.error(`Failed to load image from ${imageUrl}`);
          return;
        }

        // Get current opacity from widget
        const bgOpacityWidget = node.widgets?.find(w => w.name === "bg_opacity");
        const opacity = bgOpacityWidget ? bgOpacityWidget.value : 1.0;

        // If we have target dimensions, load and scale the image
        if (targetWidth && targetHeight) {
          // First, create an image to get the original dimensions
          const img = new Image();
          img.onload = () => {
            // Scale the image to match the target dimensions
            const canvas = document.createElement('canvas');
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            const ctx = canvas.getContext('2d');

            // Apply opacity while drawing
            ctx.globalAlpha = opacity;
            // Draw the original image scaled to the target dimensions
            ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
            ctx.globalAlpha = 1.0; // Reset

            // Convert back to base64
            const scaledDataUrl = canvas.toDataURL('image/jpeg');
            node.imgData = {
              name: imageName,
              base64: scaledDataUrl.split(',')[1],
              type: 'image/jpeg'
            };
            node.editor?.refreshBackgroundImage?.();

            // Update the widget values to match the new dimensions
            // unless user has their own dims
            const widthWidget = node.widgets?.find(
              w => w.name === 'mask_width'
            );
            const heightWidget = node.widgets?.find(
              w => w.name === 'mask_height'
            );
            const userDimsJson = node.uuid
              ? sessionStorage.getItem(`spline-editor-user-dims-${node.uuid}`)
              : null;
            const hasUserDims =
              node.properties?.userAdjustedDims || !!userDimsJson;

            if (!hasUserDims) {
              if (widthWidget) widthWidget.value = targetWidth;
              if (heightWidget) heightWidget.value = targetHeight;
            }

            // Update editor dimensions (respect user dims if set)
            if (node.editor) {
              const newW = hasUserDims && widthWidget
                ? Number(widthWidget.value)
                : targetWidth;
              const newH = hasUserDims && heightWidget
                ? Number(heightWidget.value)
                : targetHeight;

              node.editor.width = newW;
              node.editor.height = newH;

              if (node.editor.vis) {
                node.editor.vis.width(newW);
                node.editor.vis.height(newH);
                node.editor.vis.render();
              }

              // Refresh the active layer to ensure proper rendering
              if (node.layerManager?.activeWidget) {
                node.editor.onActiveLayerChanged?.();
              }

              // Trigger a full refresh of the editor
              if (node.editor.layerRenderer) {
                node.editor.layerRenderer.render();
              }
            }
          };
          img.onerror = () => {
            // If scaling fails, apply opacity to the original image
            const img2 = new Image();
            img2.onload = () => {
              const canvas = document.createElement('canvas');
              canvas.width = img2.width;
              canvas.height = img2.height;
              const ctx = canvas.getContext('2d');
              ctx.globalAlpha = opacity;
              ctx.drawImage(img2, 0, 0);
              ctx.globalAlpha = 1.0;
              const processedDataUrl = canvas.toDataURL('image/jpeg');
              node.imgData = {
                name: imageName,
                base64: processedDataUrl.split(',')[1],
                type: 'image/jpeg'
              };
              node.editor?.refreshBackgroundImage?.();
            };
            img2.src = dataUrl;
          };
          img.src = dataUrl;
        } else {
          // No target dimensions, apply opacity to the original image
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.globalAlpha = opacity;
            ctx.drawImage(img, 0, 0);
            ctx.globalAlpha = 1.0;
            const processedDataUrl = canvas.toDataURL('image/jpeg');
            node.imgData = {
              name: imageName,
              base64: processedDataUrl.split(',')[1],
              type: 'image/jpeg'
            };
            node.editor?.refreshBackgroundImage?.();
          };
          img.src = dataUrl;
        }
      });
    },

    /**
     * Initialize background image on first load
     */
    async initializeBackgroundImage() {
      try {
        // Load initial image with default opacity
        await this.updateBackgroundImage();
      } catch (error) {
        console.error('Error initializing background image:', error);
      }
    }
  };
}