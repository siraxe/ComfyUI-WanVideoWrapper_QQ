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
import { clearBackgroundVideo } from '../canvas/canvas_video_background.js';
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
     * Update background image based on bg_img selection
     * Handles "None", "A", "B", "C" selections
     */
    async updateBackgroundImage(bg_img) {
      console.log('[updateBackgroundImage] Called with bg_img:', bg_img);

      // Clear video when updating background image
      if (node.editor && node.editor.videoMetadata) {
        console.log('[updateBackgroundImage] Clearing video background');
        if (clearBackgroundVideo) {
          clearBackgroundVideo(node.editor);
        }
      }
      node.videoData = null;

      // Get target dimensions from saved state or properties
      let targetWidth, targetHeight;
      const savedDims = sessionStorage.getItem(
        `spline-editor-dims-${node.uuid}`
      );
      if (savedDims) {
        const dims = JSON.parse(savedDims);
        targetWidth = dims.width;
        targetHeight = dims.height;
      } else if (node.properties?.bgImageDims) {
        // Fallback to dimensions stored in properties
        targetWidth = node.properties.bgImageDims.width;
        targetHeight = node.properties.bgImageDims.height;
      }

      // Determine which image to load based on the bg_img selection
      if (bg_img === 'None') {
        await this._handleNoneSelection(targetWidth, targetHeight);
      } else {
        await this._handleImageSelection(bg_img, targetWidth, targetHeight);
      }
    },

    /**
     * Handle "None" background selection with darkening effect
     */
    async _handleNoneSelection(targetWidth, targetHeight) {
      try {
        // For "None" selection, use the original reference image with darkening
        if (node.originalRefImageData?.base64) {
          await this._applyDarkeningEffect(
            node.originalRefImageData.base64,
            'image/jpeg'
          );
        } else {
          // Try to load cached bg_image first
          const cachedImageUrl = await this._loadCorrectCachedRefImage();
          if (cachedImageUrl) {
            await this._applyDarkeningEffectFromUrl(cachedImageUrl);
          } else {
            // Final fallback to default A.jpg with darkening
            const timestamp = Date.now();
            const defaultImageUrl = new URL(
              `bg/A.jpg?t=${timestamp}`,
              import.meta.url
            ).href;
            await this._applyDarkeningEffectFromUrl(defaultImageUrl);
          }
        }
      } catch (error) {
        console.error('Error handling None selection:', error);
        const timestamp = Date.now();
        const defaultImageUrl = new URL(
          `../bg/A.jpg?t=${timestamp}`,
          import.meta.url
        ).href;
        this.loadBackgroundImageFromUrl(
          defaultImageUrl,
          'A.jpg',
          targetWidth,
          targetHeight
        );
      }
    },

    /**
     * Handle "A", "B", "C" background selections with overlay
     */
    async _handleImageSelection(bg_img, targetWidth, targetHeight) {
      try {
        const timestamp = Date.now();
        const imageUrl = new URL(
          `../bg/${bg_img}.jpg?t=${timestamp}`,
          import.meta.url
        ).href;

        // Prioritize original reference image (from refresh) over cached
        let refImageForOverlay = null;

        if (node.originalRefImageData?.base64) {
          // Use original ref image if available (from refresh button)
          const imgType = node.originalRefImageData.type || 'image/jpeg';
          refImageForOverlay = `data:${imgType};base64,${node.originalRefImageData.base64}`;
        } else {
          // Try to load cached ref image
          const cachedImageUrl = await this._loadCorrectCachedRefImage();
          if (cachedImageUrl) {
            refImageForOverlay = cachedImageUrl;
          }
        }

        if (refImageForOverlay) {
          // Create overlay with the reference image
          await this.createScaledImageOverlay(
            refImageForOverlay,
            bg_img,
            imageUrl
          );
        } else {
          // Fallback: load background image directly
          this.loadBackgroundImageFromUrl(
            imageUrl,
            `${bg_img}.jpg`,
            targetWidth,
            targetHeight
          );
        }
      } catch (error) {
        console.error(`Error handling ${bg_img} selection:`, error);
        // Fallback: load default image directly
        const timestamp = Date.now();
        const defaultImageUrl = new URL(
          `bg/A.jpg?t=${timestamp}`,
          import.meta.url
        ).href;
        this.loadBackgroundImageFromUrl(
          defaultImageUrl,
          'A.jpg',
          targetWidth,
          targetHeight
        );
      }
    },

    /**
     * Apply darkening effect to base64 image
     */
    async _applyDarkeningEffect(base64Data, imageType) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');

          ctx.drawImage(img, 0, 0);
          ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          const darkenedDataUrl = canvas.toDataURL('image/jpeg');
          node.imgData = {
            name: 'bg_image.png',
            base64: darkenedDataUrl.split(',')[1],
            type: 'image/jpeg'
          };

          node.editor?.refreshBackgroundImage?.();
          resolve();
        };
        img.onerror = () => {
          console.error('Error loading image for darkening');
          reject(new Error('Failed to load image for darkening'));
        };
        img.src = `data:${imageType};base64,${base64Data}`;
      });
    },

    /**
     * Apply darkening effect to image from URL
     */
    async _applyDarkeningEffectFromUrl(imageUrl) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');

          ctx.drawImage(img, 0, 0);
          ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          const darkenedDataUrl = canvas.toDataURL('image/jpeg');
          node.imgData = {
            name: 'bg_image.png',
            base64: darkenedDataUrl.split(',')[1],
            type: 'image/jpeg'
          };

          node.editor?.refreshBackgroundImage?.();
          resolve();
        };
        img.onerror = () => {
          console.error('Error loading image from URL for darkening');
          reject(new Error('Failed to load image from URL'));
        };
        img.src = imageUrl;
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
     * Create scaled overlay of reference and background image
     */
    async createScaledImageOverlay(refImageUrl, bg_img, bgImageUrl) {
      try {
        // Load both images
        const [refResponse, bgResponse] = await Promise.all([
          fetch(refImageUrl),
          fetch(bgImageUrl)
        ]);

        if (!refResponse.ok || !bgResponse.ok) {
          throw new Error(
            `Failed to load images: ref=${refResponse.status}, bg=${bgResponse.status}`
          );
        }

        const [refBlob, bgBlob] = await Promise.all([
          refResponse.blob(),
          bgResponse.blob()
        ]);

        // Convert to base64
        const [refBase64, bgBase64] = await Promise.all([
          blobToBase64(refBlob),
          blobToBase64(bgBlob)
        ]);

        // Scale the bg image to match the ref image dimensions
        const scaledBgImageData = await scaleImageToRefDimensions(
          bgBase64,
          'image/jpeg', // Assuming JPEG for background images
          refBase64
        );

        // Create the overlay with the scaled images
        await this._createOverlay(refBase64, scaledBgImageData.base64, bg_img);
      } catch (error) {
        console.error(
          `Error creating scaled image overlay for ${bg_img}:`,
          error
        );
        // Fallback to loading the background image directly
        this.loadBackgroundImageFromUrl(bgImageUrl, `${bg_img}.jpg`, null, null);
      }
    },

    /**
     * Create overlay by combining ref and background images
     */
    async _createOverlay(refBase64, scaledBgBase64, bg_img) {
      return new Promise((resolve, reject) => {
        const refImg = new Image();
        const scaledBgImg = new Image();

        let refImageLoaded = false;
        let scaledBgImageLoaded = false;

        // Function to create overlay when both images are loaded
        const createOverlayWhenBothLoaded = () => {
          if (refImageLoaded && scaledBgImageLoaded) {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = refImg.width;
              canvas.height = refImg.height;
              const ctx = canvas.getContext('2d');

              // Draw the original ref_image first
              ctx.drawImage(refImg, 0, 0);

              // Then draw the scaled background image as an overlay with 40% opacity
              ctx.globalAlpha = 0.4;
              ctx.drawImage(scaledBgImg, 0, 0);
              ctx.globalAlpha = 1.0; // Reset to default

              // Convert the combined image to data URL
              const combinedDataUrl = canvas.toDataURL('image/jpeg');

              node.imgData = {
                name: `${bg_img}.jpg`,
                base64: combinedDataUrl.split(',')[1],
                type: 'image/jpeg'
              };

              // Refresh the background image
              node.editor?.refreshBackgroundImage?.();
              resolve();
            } catch (error) {
              reject(error);
            }
          }
        };

        refImg.onload = () => {
          refImageLoaded = true;
          createOverlayWhenBothLoaded();
        };
        scaledBgImg.onload = () => {
          scaledBgImageLoaded = true;
          createOverlayWhenBothLoaded();
        };

        refImg.onerror = () => {
          console.error(`Failed to load ref_image for scaled overlay`);
          reject(new Error('Failed to load ref image'));
        };
        scaledBgImg.onerror = () => {
          console.error(`Failed to load scaled background image for overlay`);
          reject(new Error('Failed to load scaled background image'));
        };

        // Load images
        refImg.src = `data:image/jpeg;base64,${refBase64}`;
        scaledBgImg.src = `data:image/jpeg;base64,${scaledBgBase64}`;
      });
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

            // Draw the original image scaled to the target dimensions
            ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

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
            // If scaling fails, just use the original image
            node.imgData = {
              name: imageName,
              base64: dataUrl.split(',')[1],
              type: 'image/jpeg'
            };
            node.editor?.refreshBackgroundImage?.();
          };
          img.src = dataUrl;
        } else {
          // No target dimensions, just use the original image
          node.imgData = {
            name: imageName,
            base64: dataUrl.split(',')[1],
            type: 'image/jpeg'
          };
          node.editor?.refreshBackgroundImage?.();
        }
      });
    },

    /**
     * Initialize background image on first load
     */
    async initializeBackgroundImage() {
      try {
        const bgImgWidget = node.widgets?.find(w => w.name === 'bg_img');
        const bg_img = bgImgWidget?.value || 'None';

        // Load initial image
        await this.updateBackgroundImage(bg_img);
      } catch (error) {
        console.error('Error initializing background image:', error);
      }
    }
  };
}