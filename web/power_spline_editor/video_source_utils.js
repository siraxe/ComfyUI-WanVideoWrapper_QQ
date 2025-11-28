import { app } from '../../../scripts/app.js'; // Ensure app is imported
import { findConnectedSourceNode } from './graph_query.js'; // graph_query.js is in the same directory


/**
 * Helper to recursively determine if a node is a video source or processes video.
 *
 * @param {Object} nodeToCheck - The LiteGraph node instance to check.
 * @param {Set<number>} [visitedNodes=new Set()] - Set of node IDs already visited to prevent infinite loops.
 * @returns {boolean} True if the node or its upstream input is a video source or video processing node.
 */
export function isNodeVideoOrVideoProcessing(nodeToCheck, visitedNodes = new Set()) {
    if (!nodeToCheck || !nodeToCheck.type) {
        return false;
    }

    // Prevent infinite loops in case of circular dependencies
    if (visitedNodes.has(nodeToCheck.id)) {
        return false;
    }
    visitedNodes.add(nodeToCheck.id);

    // Direct video source types
    if (nodeToCheck.type === 'LoadVideo' || nodeToCheck.type === 'VHS_LoadVideo') {
        return true;
    }

    // ImageResizeKJv2 processes its input. Check its input.
    if (nodeToCheck.type === 'ImageResizeKJv2') {
        // Assuming 'image' is the input name for ImageResizeKJv2
        // We need to pass the graph instance to findConnectedSourceNode
        // For simplicity, let's assume `app.graph` is globally available or passed down
        // If findConnectedSourceNode already handles `nodeToCheck` as the context, then it's fine.
        // Let's modify findConnectedSourceNode to accept graph as argument.
        // For now, let's assume it can find it.
        const inputNode = findConnectedSourceNode(nodeToCheck, 'image'); // findConnectedSourceNode needs graph context
        if (inputNode && inputNode.node) {
            return isNodeVideoOrVideoProcessing(inputNode.node, visitedNodes); // Recurse
        }
    }
    // Add other image processing nodes that can pass through video frames if necessary
    // For example, if there's a Crop node that takes frames and passes them.

    return false;
}
