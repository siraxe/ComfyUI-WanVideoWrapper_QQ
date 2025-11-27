/**
 * Frontend trigger for PrepareRefs backend processing
 *
 * This module provides functionality to trigger PrepareRefs processing
 * from the frontend without running the full ComfyUI workflow.
 */

import { getReferenceImageFromConnectedNode, findConnectedSourceNode, extractImagesFromSourceNode } from './graph_query.js';

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
        }

        if (!bgImageBase64) {
            console.warn('[triggerPrepareRefsBackend] No bg_image found');
            return { success: false, error: 'No background image available' };
        }

        // 2. Get ref_layer_data from node
        const refLayerData = node.getRefLayerData?.() || [];

        // 3. Check for extra_refs from connected Create Image List node
        let extraRefsBase64 = [];
        try {
            const extraRefsSourceNode = findConnectedSourceNode(node, 'extra_refs');
            if (extraRefsSourceNode) {
                const extraImages = await extractImagesFromSourceNode(extraRefsSourceNode, false);
                if (extraImages && extraImages.length > 0) {
                    extraRefsBase64 = extraImages;
                }
            }
        } catch (error) {
            console.warn('[triggerPrepareRefsBackend] Error extracting extra_refs:', error);
            // Continue without extra_refs if there's an error
        }

        // Validate that we have at least one source of refs (lasso layers OR extra_refs)
        if (refLayerData.length === 0 && extraRefsBase64.length === 0) {
            console.warn('[triggerPrepareRefsBackend] No ref layers or extra_refs found');
            return { success: false, error: 'No ref layers or extra_refs to process' };
        }

        // 4. Get dimensions
        const widthWidget = node.widgets?.find(w => w.name === 'mask_width');
        const heightWidget = node.widgets?.find(w => w.name === 'mask_height');
        const maskWidth = widthWidget?.value || 640;
        const maskHeight = heightWidget?.value || 480;

        // 5. Prepare payload
        const payload = {
            bg_image: bgImageBase64,
            ref_layer_data: refLayerData,
            mask_width: maskWidth,
            mask_height: maskHeight
        };

        // Add extra_refs if available
        if (extraRefsBase64.length > 0) {
            payload.extra_refs = extraRefsBase64;
        }

        // 6. Call backend endpoint
        const response = await fetch('/wanvideowrapper_qq/trigger_prepare_refs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (!result.success) {
            throw new Error(result.error || 'Backend processing failed');
        }

        return result;

    } catch (error) {
        console.error('[triggerPrepareRefsBackend] Error:', error);
        return {
            success: false,
            error: error.message || 'Unknown error during backend trigger'
        };
    }
}
