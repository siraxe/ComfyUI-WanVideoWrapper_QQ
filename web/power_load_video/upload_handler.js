/**
 * Upload Handler - Helper functions for video upload and node creation
 */
import { api } from '../../../scripts/api.js';
import { app } from '../../../scripts/app.js';

/**
 * Upload a video file to ComfyUI's input directory
 */
export async function uploadVideoFile(file) {
    const formData = new FormData();
    formData.append('image', file);
    formData.append('type', 'input');

    try {
        const resp = await api.fetchApi('/upload/image', { method: 'POST', body: formData });
        if (resp.ok || resp.status === 200) {
            const data = await resp.json();
            return data.name || data.filename || file.name;
        }
    } catch (err) {
        console.error('[PowerLoadVideo] Upload error:', err);
    }
    return null;
}

/**
 * Create a Power Load Video node at the given position with the uploaded video
 */
export async function createPowerLoadVideoNodeAt(pos, filename) {
    // Use LiteGraph.createNode - the standard way to create nodes in ComfyUI
    const node = LiteGraph.createNode('PowerLoadVideo');

    if (!node) {
        console.error('[PowerLoadVideo] Failed to create node!');
        return null;
    }

    // Set position
    node.pos = [pos[0], pos[1]];

    // Add node to graph (this auto-assigns ID and creates widgets)
    app.canvas.graph.add(node);

    // Wait for widgets and custom methods to be created
    await new Promise(resolve => setTimeout(resolve, 50));

    // Store the video filename on the node for execution (same as drag-to-node does)
    node.videoFilename = filename;

    // Update the hidden combo widget value so ComfyUI serializes it to the backend
    const comboWidget = node.widgets.find(w => w.type === 'combo');
    if (comboWidget) {
        comboWidget.value = filename;
    }

    // Also update widgets_values so serialization picks it up
    if (!node.widgets_values || node.widgets_values.length === 0) {
        node.widgets_values = [filename];
    } else {
        node.widgets_values[0] = filename;
    }

    // Directly load the video into our custom display using node method (same as drag-to-node)
    if (typeof node.loadVideoIntoDisplay === 'function') {
        node.loadVideoIntoDisplay(filename);
    } else {
        console.error('[PowerLoadVideo] loadVideoIntoDisplay not available yet, will retry');
        // Retry after a short delay
        setTimeout(() => {
            if (typeof node.loadVideoIntoDisplay === 'function') {
                node.loadVideoIntoDisplay(filename);
            }
        }, 50);
    }

    return node;
}
