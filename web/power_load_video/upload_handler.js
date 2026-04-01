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
    // Get the LiteGraph constructor for PowerLoadVideo node
    const nodeClass = app.graphConstructor.nodeTypes.PowerLoadVideo;
    if (!nodeClass) {
        console.error('[PowerLoadVideo] Node type not registered yet!');
        return null;
    }

    const node = new nodeClass();
    node.pos = [pos[0], pos[1]];

    // Set the video filename as the first widget value
    node.widgets_values = [filename];

    app.graph.add(node);
    node.configure({ id: app.graph.getNodeId(), widgets_values: [filename] });

    return node;
}
