/**
 * Reference Image Manager Module
 * Handles reference image loading, attachment, and box layer ref management
 */

import {
  getReferenceImageFromConnectedNode,
  getReferenceImagesFromConnectedNode,
  findConnectedSourceNode,
  extractImagesFromSourceNode
} from '../graph_query.js';
import { saveRefImageToCache, safeSetSessionItem } from './image-cache.js';
import { app } from '../../../../scripts/app.js';

/**
 * Create ref image manager instance for a node
 * @param {Object} node - The PowerSplineEditor node instance
 * @returns {Object} - Manager with methods for handling reference images
 */
export function createRefImageManager(node) {
  return {
    /**
     * Update reference image from connected node (bg_image input)
     * Handles both static images and video frames
     */
    async updateReferenceImageFromConnectedNode(forceUpdate = false) {
      console.log(
        'Attempting to update reference image from connected node...',
        forceUpdate ? '(forced)' : ''
      );

      // First, check what's connected to bg_image input
      const sourceNode = findConnectedSourceNode(node, 'bg_image');

      let isVideoSource = false;
      if (sourceNode?.node) {
        isVideoSource = this._isNodeVideoOrVideoProcessing(sourceNode.node);
      }

      // Check if we have video loaded - if so, skip (unless forced)
      if (!forceUpdate && node.editor?.videoMetadata) {
        return;
      }

      // Check if videoData exists (video might be pending) - skip unless forced
      if (!forceUpdate && node.videoData) {
        return;
      }

      // Determine if we need to clear the existing video background
      const shouldClearExistingVideo =
        node.editor?.videoMetadata &&
        (!isVideoSource || !sourceNode);

      if (shouldClearExistingVideo) {
        if (node.editor) {
          const { clearBackgroundVideo } = await import(
            '../canvas/canvas_video_background.js'
          );
          if (clearBackgroundVideo) {
            clearBackgroundVideo(node.editor);
          }
        }
        node.videoData = null;
      }

      try {
        // Check if we're connected to PrepareRefs node
        const isConnectedToPrepareRefs = this.checkIfConnectedToPrepareRefs();
        console.log('[DEBUG] Connected to PrepareRefs:', isConnectedToPrepareRefs);

        if (isConnectedToPrepareRefs) {
          return await this._handlePrepareRefsConnection();
        }

        // --- Handle video from direct or indirect video loaders ---
        let videoFrames = null;
        let videoFilename = null;
        let isSourceNodeDirectVideoLoader = false;

        if (sourceNode) {
          isSourceNodeDirectVideoLoader =
            sourceNode.node.type === 'LoadVideo' ||
            sourceNode.node.type === 'VHS_LoadVideo';

          if (isSourceNodeDirectVideoLoader) {
            console.log('[Canvas] Detected direct LoadVideo node');
            const videoWidget = sourceNode.node.widgets?.find(
              w => w.name === 'video'
            );

            if (videoWidget?.value) {
              videoFilename = videoWidget.value;
              console.log('[Canvas] Found video filename:', videoFilename);
            }
          } else if (isVideoSource) {
            const images = await extractImagesFromSourceNode(sourceNode, false);
            if (images?.length > 1) {
              videoFrames = images;
              console.log(`[Canvas] Got ${images.length} frames from bg_image`);
            }
          }
        }

        // Process video filename if found
        if (videoFilename) {
          return await this._processVideoFile(videoFilename);
        }

        // Process video frames if found
        if (videoFrames?.length > 1) {
          return await this._processVideoFrames(videoFrames);
        }

        // --- Fallback for static image ---
        const base64Image = await getReferenceImageFromConnectedNode(
          node,
          'bg_image'
        );
        if (!base64Image) {
          console.log('Could not retrieve reference image from connected node');
          return;
        }

        // Store the fetched image
        node.originalRefImageData = {
          name: 'ref_image_from_connection.jpg',
          base64: base64Image.split(',')[1],
          type: 'image/jpeg'
        };

        // Cache the ref image
        await saveRefImageToCache(node.originalRefImageData.base64, 'bg_image.png');

        // Clear session storage cache
        if (node.uuid) {
          sessionStorage.removeItem(`spline-editor-img-${node.uuid}`);
        }

        // Get current bg_img selection
        const bgImgWidget = node.widgets?.find(w => w.name === 'bg_img');
        const bg_img = bgImgWidget?.value || 'None';

        // Update background
        if (node.bgImageManager) {
          await node.bgImageManager.updateBackgroundImage(bg_img);
        }

        // Wait for processing
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        console.error('Error updating reference image from connected node:', error);
        alert('Error updating reference image: ' + error.message);
      }
    },

    /**
     * Handle PrepareRefs connection
     */
    async _handlePrepareRefsConnection() {
      try {
        const timestamp = Date.now();
        const refImageUrl = new URL(
          `../ref/bg_image_cl.png?t=${timestamp}`,
          import.meta.url
        ).href;

        const response = await fetch(refImageUrl);
        if (!response.ok) {
          console.error('Failed to load bg_image_cl.png from ref folder');
          alert('Could not load bg_image_cl.png from ref folder.');
          return;
        }

        const blob = await response.blob();
        const base64Data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });

        node.originalRefImageData = {
          name: 'bg_image_cl.png',
          base64: base64Data,
          type: 'image/png'
        };

        // Clear session storage cache
        if (node.uuid) {
          sessionStorage.removeItem(`spline-editor-img-${node.uuid}`);
        }

        // Get current bg_img selection
        const bgImgWidget = node.widgets?.find(w => w.name === 'bg_img');
        const bg_img = bgImgWidget?.value || 'None';

        // Update background
        if (node.bgImageManager) {
          await node.bgImageManager.updateBackgroundImage(bg_img);
        }

        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        console.error('Error loading bg_image_cl.png:', error);
        alert('Error loading bg_image_cl.png: ' + error.message);
      }
    },

    /**
     * Process video file from LoadVideo node
     */
    async _processVideoFile(videoFilename) {
      console.log('[Canvas] Processing LoadVideo file:', videoFilename);

      const payload = {
        video_filename: videoFilename,
        mask_width:
          node.widgets?.find(w => w.name === 'mask_width')?.value || 640,
        mask_height:
          node.widgets?.find(w => w.name === 'mask_height')?.value || 480
      };

      try {
        console.log('[DEBUG] Sending request to /wanvideowrapper_qq/process_video_file');
        const response = await fetch('/wanvideowrapper_qq/process_video_file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        console.log('[DEBUG] Response status:', response.status);
        const result = await response.json();
        console.log('[DEBUG] Response result:', result);

        if (result.success && result.paths?.bg_video) {
          console.log('[Canvas] Video processed successfully:', result.paths.bg_video);
          if (node.videoManager) {
            await node.videoManager.loadVideo(result.paths.bg_video);
          }
          return;
        } else {
          throw new Error(result.error || 'Unknown error');
        }
      } catch (error) {
        console.error('[Canvas] Error processing video file:', error);
        alert('Failed to process video file: ' + error.message);
      }
    },

    /**
     * Process video frames
     */
    async _processVideoFrames(videoFrames) {
      console.log('[Canvas] Processing video frames through backend...');

      const payload = {
        bg_image: videoFrames,
        ref_layer_data: [],
        mask_width:
          node.widgets?.find(w => w.name === 'mask_width')?.value || 640,
        mask_height:
          node.widgets?.find(w => w.name === 'mask_height')?.value || 480
      };

      try {
        const response = await fetch('/wanvideowrapper_qq/trigger_prepare_refs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (result.success && result.paths?.bg_video) {
          console.log('[Canvas] Video created successfully:', result.paths.bg_video);
          if (node.videoManager) {
            await node.videoManager.loadVideo(result.paths.bg_video);
          }
          return;
        } else {
          throw new Error(result.error || 'Unknown error');
        }
      } catch (error) {
        console.error('[Canvas] Error processing video:', error);
      }
    },

    /**
     * Attach reference images to active box layer
     */
    async attachRefImageToActiveBoxLayer(desiredSelection = 'ref_1') {
      const activeWidget = node.layerManager?.getActiveWidget?.();
      if (!activeWidget || activeWidget.value?.type !== 'box_layer') {
        alert('Activate a box layer first to attach a ref image.');
        return;
      }

      const isConnectedToPrepareRefs = this.checkIfConnectedToPrepareRefs();

      if (isConnectedToPrepareRefs) {
        await this.loadRefImagesFromRefFolder(activeWidget, desiredSelection);
        return;
      }

      // Fetch images from ref_images input
      const images = await getReferenceImagesFromConnectedNode(node);
      if (!images || images.length === 0) {
        alert('No ref_images input found. Connect an IMAGE or IMAGE batch to ref_images.');
        return;
      }

      const attachments = await this._processImageAttachments(images);

      if (attachments.length === 0) {
        console.warn('No attachments created');
        return;
      }

      // Set attachments on widget
      activeWidget.value.ref_attachment = { entries: attachments };

      // Set selection
      const availableOptions = activeWidget._getRefOptions
        ? activeWidget._getRefOptions()
        : ['no_ref', 'ref_1', 'ref_2', 'ref_3', 'ref_4', 'ref_5'];
      const desiredIdx =
        desiredSelection && availableOptions.includes(desiredSelection)
          ? Math.max(0, (parseInt(desiredSelection.split('_')[1], 10) || 1) - 1)
          : 0;

      if (attachments.length === 0 || desiredIdx >= attachments.length) {
        activeWidget.value.ref_selection = 'no_ref';
      } else {
        const clampedIndex = Math.min(attachments.length - 1, desiredIdx);
        activeWidget.value.ref_selection = `ref_${clampedIndex + 1}`;
      }

      // Persist to session
      this._persistBoxRefToSession(activeWidget);

      // Clear global ref cache
      try {
        sessionStorage.removeItem('spline-editor-cached-ref-image');
      } catch {}

      // Save all frames to disk
      for (let i = 0; i < images.length; i++) {
        const imgData = images[i];
        const b64 = imgData.startsWith('data:') ? imgData.split(',')[1] : imgData;
        await saveRefImageToCache(b64, `ref_image_${i}.png`, {
          skipSessionCache: true
        });
      }

      // Refresh canvas
      node.setDirtyCanvas(true, true);
      node.editor?.refreshBackgroundImage?.();
    },

    /**
     * Process image attachments
     */
    async _processImageAttachments(images) {
      const attachments = [];
      const maxRefs = 5;

      for (let i = 0; i < Math.min(images.length, maxRefs); i++) {
        const imgData = images[i];
        const base64Data = imgData.startsWith('data:')
          ? imgData.split(',')[1]
          : imgData;
        const dataUrl = imgData.startsWith('data:')
          ? imgData
          : `data:image/png;base64,${base64Data}`;

        // Get dimensions
        const dims = await new Promise(resolve => {
          const img = new Image();
          img.onload = () =>
            resolve({ width: img.width, height: img.height });
          img.onerror = () => resolve({ width: 1, height: 1 });
          img.src = dataUrl;
        });

        // Save to cache
        const filename = `ref_image_${i}.png`;
        await saveRefImageToCache(base64Data, filename);

        attachments.push({
          path: `power_spline_editor/bg/${filename}`,
          type: 'image/png',
          width: dims.width,
          height: dims.height,
          name: filename
        });
      }

      return attachments;
    },

    /**
     * Clear reference image from active box layer
     */
    clearRefImageFromActiveBoxLayer() {
      const activeWidget = node.layerManager?.getActiveWidget?.();
      if (activeWidget && activeWidget.value?.type === 'box_layer') {
        activeWidget.value.ref_attachment = null;
        activeWidget.value.ref_selection = 'no_ref';

        try {
          const keyId = node.id ?? node.uuid;
          const key = keyId
            ? `spline-editor-boxref-${keyId}-${
                activeWidget.value.name || activeWidget.name || 'box'
              }`
            : null;
          if (key) sessionStorage.removeItem(key);
        } catch {}

        node.setDirtyCanvas(true, true);
      }
    },

    /**
     * Update reference images for all box layers
     */
    async updateAllBoxLayerRefs() {
      const widgets = node.layerManager?.getSplineWidgets?.() || [];
      const boxWidgets = widgets.filter(w => w?.value?.type === 'box_layer');

      if (!boxWidgets.length) return;

      // Clear ref image cache
      if (node.layerRenderer?.clearRefImageCache) {
        node.layerRenderer.clearRefImageCache();
      }

      const isConnectedToPrepareRefs = this.checkIfConnectedToPrepareRefs();

      if (isConnectedToPrepareRefs) {
        for (const boxWidget of boxWidgets) {
          await this.loadRefImagesFromRefFolder(
            boxWidget,
            boxWidget.value.ref_selection || 'ref_1'
          );
        }
        return;
      }

      // Fetch images from ref_images input
      const images = await getReferenceImagesFromConnectedNode(node);
      if (!images || images.length === 0) {
        console.warn('No ref_images input found for updating box layer refs.');
        return;
      }

      const attachments = await this._processImageAttachments(images);

      // Update all box widgets
      boxWidgets.forEach(boxWidget => {
        const currentSelection = boxWidget.value.ref_selection || 'no_ref';
        boxWidget.value.ref_attachment = { entries: attachments };

        // Keep current selection if valid
        if (currentSelection !== 'no_ref') {
          const parts = currentSelection.split('_');
          const idx = parts.length > 1 ? parseInt(parts[1], 10) : 1;
          const arrayIndex = Number.isFinite(idx) ? Math.max(0, idx - 1) : 0;
          if (arrayIndex >= attachments.length) {
            boxWidget.value.ref_selection = 'no_ref';
          }
        }

        // Persist to session
        this._persistBoxRefToSession(boxWidget);
      });

      // Clear global ref cache
      try {
        sessionStorage.removeItem('spline-editor-cached-ref-image');
      } catch {}

      // Save all frames to disk
      for (let i = 0; i < images.length; i++) {
        const imgData = images[i];
        const b64 = imgData.startsWith('data:') ? imgData.split(',')[1] : imgData;
        await saveRefImageToCache(b64, `ref_image_${i}.png`, {
          skipSessionCache: true
        });
      }

      // Clear cache again and refresh
      node.editor?.layerRenderer?.clearRefImageCache?.();
      node.setDirtyCanvas(true, true);
    },

    /**
     * Persist box ref attachment to session storage
     */
    _persistBoxRefToSession(boxWidget) {
      try {
        const keyId = node.id ?? node.uuid;
        const key = keyId
          ? `spline-editor-boxref-${keyId}-${
              boxWidget.value.name || boxWidget.name || 'box'
            }`
          : null;
        if (key) {
          safeSetSessionItem(
            key,
            JSON.stringify({
              attachment: boxWidget.value.ref_attachment,
              selection: boxWidget.value.ref_selection
            })
          );
        }
      } catch (e) {
        console.warn('Failed to persist box ref attachment to session:', e);
      }
    },

    /**
     * Load reference images from ref folder
     */
    async loadRefImagesFromRefFolder(boxWidget, desiredSelection = 'ref_1') {
      try {
        const attachments = [];
        const maxRefs = 5;
        const timestamp = Date.now();

        for (let i = 1; i <= maxRefs; i++) {
          try {
            const refImageUrl = new URL(
              `../ref/ref_${i}.png?t=${timestamp}`,
              import.meta.url
            ).href;
            const response = await fetch(refImageUrl);

            if (!response.ok) {
              console.log(`ref_${i}.png not found in ref folder, skipping`);
              continue;
            }

            const blob = await response.blob();
            const base64Data = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result.split(',')[1]);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });

            // Get dimensions
            const dims = await new Promise(resolve => {
              const img = new Image();
              img.onload = () =>
                resolve({ width: img.width, height: img.height });
              img.onerror = () => resolve({ width: 1, height: 1 });
              img.src = `data:image/png;base64,${base64Data}`;
            });

            // Save to cache
            const filename = `ref_${i}.png`;
            await saveRefImageToCache(base64Data, filename);

            attachments.push({
              path: `../ref/${filename}`,
              type: 'image/png',
              width: dims.width,
              height: dims.height,
              name: filename
            });

            console.log(`Successfully loaded ref_${i}.png from ref folder`);
          } catch (error) {
            console.error(`Error loading ref_${i}.png:`, error);
          }
        }

        if (attachments.length === 0) {
          console.error('No ref images found in ref folder');
          return;
        }

        // Set attachments
        boxWidget.value.ref_attachment = { entries: attachments };

        // Set selection
        const availableOptions = boxWidget._getRefOptions
          ? boxWidget._getRefOptions()
          : ['no_ref', 'ref_1', 'ref_2', 'ref_3', 'ref_4', 'ref_5'];
        const desiredIdx =
          desiredSelection && availableOptions.includes(desiredSelection)
            ? Math.max(0, (parseInt(desiredSelection.split('_')[1], 10) || 1) - 1)
            : 0;

        if (desiredIdx >= attachments.length) {
          boxWidget.value.ref_selection = 'no_ref';
        } else {
          const clampedIndex = Math.min(attachments.length - 1, desiredIdx);
          boxWidget.value.ref_selection = `ref_${clampedIndex + 1}`;
        }

        // Persist to session
        this._persistBoxRefToSession(boxWidget);

        // Clear cache and refresh
        if (node.layerRenderer?.clearRefImageCache) {
          node.layerRenderer.clearRefImageCache();
        }

        console.log(
          `Successfully loaded ${attachments.length} ref images from ref folder`
        );
      } catch (error) {
        console.error('Error loading ref images from ref folder:', error);
      }
    },

    /**
     * Check if connected to PrepareRefs node
     */
    checkIfConnectedToPrepareRefs() {
      const graph = app.graph;
      if (!graph || !graph.links || !node.inputs) {
        return false;
      }

      for (let i = 0; i < node.inputs.length; i++) {
        const input = node.inputs[i];
        if (!input || !input.name) continue;

        let link = null;
        if (graph.links instanceof Map) {
          for (const [linkId, linkObj] of graph.links) {
            if (
              linkObj &&
              linkObj.target_id === node.id &&
              linkObj.target_slot === i
            ) {
              link = linkObj;
              break;
            }
          }
        } else if (Array.isArray(graph.links)) {
          link = graph.links.find(
            linkObj =>
              linkObj &&
              linkObj.target_id === node.id &&
              linkObj.target_slot === i
          );
        }

        if (link) {
          const sourceNode = graph._nodes?.find(n => n.id === link.origin_id);
          if (sourceNode && sourceNode.type === 'PrepareRefs') {
            return true;
          }
        }
      }
      return false;
    },

    /**
     * Check if node is a video source or video processing node
     */
    _isNodeVideoOrVideoProcessing(nodeToCheck) {
      if (!nodeToCheck) return false;

      // Direct video loaders
      if (
        nodeToCheck.type === 'LoadVideo' ||
        nodeToCheck.type === 'VHS_LoadVideo'
      ) {
        return true;
      }

      // Video processing nodes that output multiple frames
      const videoProcessingTypes = [
        'ImageResizeKJv2',
        'ImageScale',
        'ImageUpscaleWithModel',
        'VideoCapture'
      ];

      if (videoProcessingTypes.includes(nodeToCheck.type)) {
        return true;
      }

      return false;
    }
  };
}