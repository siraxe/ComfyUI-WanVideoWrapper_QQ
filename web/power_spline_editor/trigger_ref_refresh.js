/**
 * Frontend trigger for PrepareRefs backend processing
 *
 * This module provides functionality to trigger PrepareRefs processing
 * from the frontend without running the full ComfyUI workflow.
 */

import { getReferenceImageFromConnectedNode } from './graph_query.js';

/**
 * Trigger PrepareRefs processing in the backend
 *
 * Sends lasso layer data and bg_image to backend for processing.
 * All ref images are exported as 768x768 PNG with alpha channel.
 *
 * @param {Object} node - The PrepareRefs node instance
 * @returns {Promise<Object>} Response with success status and file paths
 */
export async function triggerPrepareRefsBackend(node) {
    try {
        console.log('[triggerPrepareRefsBackend] Starting backend trigger...');

        // 1. Get current bg_image from connected node or canvas
        let bgImageBase64 = null;

        // Try to get from connected node first
        bgImageBase64 = await getReferenceImageFromConnectedNode(node, 'bg_image');

        // Fallback: get from canvas if available
        if (!bgImageBase64 && node.refCanvasEditor?.backgroundImage) {
            const canvas = document.createElement('canvas');
            const img = node.refCanvasEditor.backgroundImage;
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            bgImageBase64 = canvas.toDataURL('image/png');
            console.log('[triggerPrepareRefsBackend] Using bg_image from canvas');
        }

        if (!bgImageBase64) {
            console.warn('[triggerPrepareRefsBackend] No bg_image found');
            return { success: false, error: 'No background image available' };
        }

        // 2. Get ref_layer_data from node
        const refLayerData = node.getRefLayerData?.() || [];

        if (refLayerData.length === 0) {
            console.warn('[triggerPrepareRefsBackend] No ref layers with shapes found');
            return { success: false, error: 'No ref layers with shapes to process' };
        }

        console.log('[triggerPrepareRefsBackend] Found', refLayerData.length, 'layers with shapes');

        // 3. Get dimensions
        const widthWidget = node.widgets?.find(w => w.name === 'mask_width');
        const heightWidget = node.widgets?.find(w => w.name === 'mask_height');
        const maskWidth = widthWidget?.value || 640;
        const maskHeight = heightWidget?.value || 480;

        console.log('[triggerPrepareRefsBackend] Dimensions:', maskWidth, 'x', maskHeight);

        // 4. Prepare payload
        const payload = {
            bg_image: bgImageBase64,
            ref_layer_data: refLayerData,
            mask_width: maskWidth,
            mask_height: maskHeight
        };

        console.log('[triggerPrepareRefsBackend] Sending request with', refLayerData.length, 'layers');

        // 5. Call backend endpoint
        const response = await fetch('/wanvideowrapper_qq/trigger_prepare_refs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (!result.success) {
            throw new Error(result.error || 'Backend processing failed');
        }

        console.log('[triggerPrepareRefsBackend] Success:', result.message);
        console.log('[triggerPrepareRefsBackend] Generated files:', result.paths);

        return result;

    } catch (error) {
        console.error('[triggerPrepareRefsBackend] Error:', error);
        return {
            success: false,
            error: error.message || 'Unknown error during backend trigger'
        };
    }
}
