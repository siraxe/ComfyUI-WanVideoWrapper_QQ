/**
 * Graph Query Utilities for ComfyUI
 * Allows querying node connections and extracting image data from connected nodes
 */

import { app } from '../../../scripts/app.js';
import { applyResizeParams } from './image_resize.js';

/**
 * Find the source node connected to a specific input of the current node
 * @param {Object} currentNode - The current node object
 * @param {string} inputName - Name of the input to find connection for (e.g., "ref_image")
 * @returns {Object|null} The source node connected to the input, or null if not connected
 */
function findConnectedSourceNode(currentNode, inputName) {
    try {
        // Look for connections where this node is the target
        const graph = app.graph;
        if (!graph || !graph.links) {
            return null;
        }

        // Find input index for the given input name
        let inputIndex = -1;
        let allInputNames = [];

        if (currentNode.inputs) {
            for (let i = 0; i < currentNode.inputs.length; i++) {
                const input = currentNode.inputs[i];
                if (input && input.name) {
                    allInputNames.push(input.name);
                    if (input.name === inputName) {
                        inputIndex = i;
                        break;
                    }
                }
            }
        } else {
            // Try to get inputs from the node configuration
            if (currentNode.constructor?.nodeData?.input) {
                const allInputs = {
                    ...currentNode.constructor?.nodeData?.input?.required,
                    ...currentNode.constructor?.nodeData?.input?.optional
                };
                
                // Find which position the input is in
                let index = 0;
                for (const [inputNameDef] of Object.entries(allInputs)) {
                    allInputNames.push(inputNameDef);
                    if (inputNameDef === inputName) {
                        inputIndex = index;
                        break;
                    }
                    index++;
                }
            }
        }
        
        // DO NOT fallback from ref_image to ref_images - they serve different purposes
        // ref_image is for background canvas, ref_images is for box layer references
        // Fallback removed to prevent ref_images[0] from overwriting bg_image.png

        if (inputIndex === -1) {
            return null;
        }

        // Find the link connected to this input (graph.links is a Map, not an array)
        let link = null;
        if (graph.links && graph.links instanceof Map) {
            for (const [linkId, linkObj] of graph.links) {
                if (!linkObj) continue;

                if (linkObj.target_id === currentNode.id && linkObj.target_slot === inputIndex) {
                    link = linkObj;
                    break;
                }
            }
        } else if (Array.isArray(graph.links)) {
            // Fallback if links is an array (older format)
            link = graph.links.find(linkObj => {
                if (!linkObj) return false;
                return linkObj.target_id === currentNode.id && linkObj.target_slot === inputIndex;
            });
        } else {
            return null;
        }

        if (!link) {
            // Check what inputs are connected - iterate through the Map
            const connectedLinks = [];
            if (graph.links instanceof Map) {
                for (const [linkId, linkObj] of graph.links) {
                    if (linkObj && linkObj.target_id === currentNode.id) {
                        connectedLinks.push(linkObj);
                    }
                }
            } else if (Array.isArray(graph.links)) {
                // Fallback for array format
                for (const linkObj of graph.links) {
                    if (linkObj && linkObj.target_id === currentNode.id) {
                        connectedLinks.push(linkObj);
                    }
                }
            }

            // Alternative approach: try to find any connection that might be the ref_image
            if (connectedLinks.length > 0) {
                // If we find connected links, try to match based on common patterns
                // ref_image is typically an IMAGE type input
                for (const connectedLink of connectedLinks) {
                    const sourceNode = graph._nodes?.find(node => node.id === connectedLink.origin_id);
                    if (sourceNode) {
                        // Check if this is likely an image source by checking the source's output type
                        const sourceOutput = sourceNode.outputs?.[connectedLink.origin_slot];
                        if (sourceOutput && (sourceOutput.type === 'IMAGE' || (sourceOutput.name && sourceOutput.name.includes('image')))) {
                            // Return this connection as a possibility
                            return {
                                node: sourceNode,
                                origin_slot: connectedLink.origin_slot,
                                target_slot: connectedLink.target_slot
                            };
                        }
                    }
                }

                // If we still can't find it by output type, just return the first connection as a fallback
                // as it might be connected but the type matching isn't working
                const firstConnectedLink = connectedLinks[0];
                const firstSourceNode = graph._nodes?.find(node => node.id === firstConnectedLink.origin_id);
                if (firstSourceNode) {
                    return {
                        node: firstSourceNode,
                        origin_slot: firstConnectedLink.origin_slot,
                        target_slot: firstConnectedLink.target_slot
                    };
                }
            }
            return null;
        } else {
            // The direct match was successful
            // Find the source node based on the link
            const sourceNode = graph._nodes?.find(node => node.id === link.origin_id);

            if (!sourceNode) {
                return null;
            }

            // If the directly connected source node is not an image node, try the deep search approach
            if (!isImageNode(sourceNode)) {
                const deepResult = findDeepSourceNode(currentNode, inputName);
                if (deepResult) {
                    return deepResult;
                }
            }

            return {
                node: sourceNode,
                origin_slot: link.origin_slot,
                target_slot: link.target_slot
            };
        }

        // Find the source node based on the link
        const sourceNode = graph._nodes?.find(node => node.id === link.origin_id);
        
        if (!sourceNode) {
            console.error(`Source node with id ${link.origin_id} not found`);
            return null;
        }

        return {
            node: sourceNode,
            origin_slot: link.origin_slot,
            target_slot: link.target_slot
        };
    } catch (error) {
        console.error(`Error finding connected source node for "${inputName}":`, error);
        console.error(`Stack:`, error.stack);
        return null;
    }
}

/**
 * Normalize a widget value into a URL/data URL we can fetch.
 */
function normalizeImageValue(value, fallbackType = 'temp') {
    if (!value) return null;
    if (typeof value === 'string') {
        if (value.startsWith('data:') || value.startsWith('http')) return value;
        return `/view?filename=${encodeURIComponent(value)}&type=${fallbackType}`;
    }
    if (typeof value === 'object') {
        if (value.filename) return `/view?filename=${encodeURIComponent(value.filename)}&type=${fallbackType}`;
        if (value.file) return `/view?filename=${encodeURIComponent(value.file)}&type=${fallbackType}`;
        if (value.url) return value.url;
    }
    return null;
}

/**
 * Extract image data from a source node that may contain image previews (single best-effort).
 * @param {Object} sourceNodeObj - Object containing the source node and connection info
 * @returns {string|null} Base64 image data or URL, or null if no image found
 */
async function extractImageFromSourceNode(sourceNodeObj) {
    const images = await extractImagesFromSourceNode(sourceNodeObj, true);
    return images && images.length ? images[0] : null;
}

/**
 * Extract one or many image data URLs/base64 strings from a source node.
 * @param {Object} sourceNodeObj
 * @param {boolean} includeDomFallback whether to also scan DOM for a single preview
 * @returns {Promise<string[]>}
 */
async function extractImagesFromSourceNode(sourceNodeObj, includeDomFallback = false) {
    if (!sourceNodeObj || !sourceNodeObj.node) {
        console.error('Invalid source node object');
        return [];
    }

    const sourceNode = sourceNodeObj.node;
    const collected = [];
    const graph = app.graph;

    const collectFromWidgets = async (widgets, fallbackType = 'temp') => {
        if (!widgets) return;
        for (const widget of widgets) {
            if ((widget.type === 'image' || widget.name?.toLowerCase?.().includes('image')) && widget.value) {
                // If widget value is an array (batch), gather all
                if (Array.isArray(widget.value)) {
                    for (const v of widget.value) {
                        const normalized = normalizeImageValue(v, fallbackType);
                        if (normalized) {
                            const data = await loadImageAsBase64(normalized);
                            if (data) collected.push(data);
                        }
                    }
                } else {
                    const normalized = normalizeImageValue(widget.value, fallbackType);
                    if (normalized) {
                        const data = await loadImageAsBase64(normalized);
                        if (data) collected.push(data);
                    }
                }
            }
        }
    };

    const collectFromUpstream = async (node, visited = new Set()) => {
        if (!graph || !graph.links || !node || visited.has(node.id)) return;
        visited.add(node.id);
        const inputs = node.inputs || [];
        for (let i = 0; i < inputs.length; i++) {
            const linkId = node.inputs[i]?.link;
            if (!linkId) continue;
            const link = graph.links.get ? graph.links.get(linkId) : graph.links?.[linkId];
            if (!link) continue;
            const upstream = graph._nodes?.find((n) => n.id === link.origin_id);
            if (upstream) {
                const nested = await extractImagesFromSourceNode({ node: upstream, origin_slot: link.origin_slot, target_slot: link.target_slot }, false);
                nested.forEach((img) => collected.push(img));
                await collectFromUpstream(upstream, visited);
            }
        }
    };

    try {
        // Different node types store image data differently
        switch (sourceNode.type) {
            case 'LoadImage':
            case 'LoadImageUpload': {
                await collectFromWidgets(sourceNode.widgets, 'input');
                if (collected.length) break;
                if (sourceNode.properties?.value) {
                    const normalized = normalizeImageValue(sourceNode.properties.value, 'input');
                    if (normalized) {
                        const data = await loadImageAsBase64(normalized);
                        if (data) collected.push(data);
                    }
                }
                break;
            }

            case 'VAEDecode':
            case 'PreviewImage':
            case 'SaveImage': {
                await collectFromWidgets(sourceNode.widgets, 'temp');
                break;
            }

            case 'ImageResizeKJv2':  // Handle image processing nodes
            case 'ImageScale':
            case 'ImageScaleBy':
            case 'ImageUpscale':
            case 'ImageCrop': {
                await collectFromWidgets(sourceNode.widgets, 'temp');
                break;
            }

            // Batching/list helpers: expect widgets to hold arrays of images
            case 'ImageBatch':
            case 'CreateImageList':
            case 'ImpactMakeImageList':
            case 'ImpactMakeAnyList': {
                await collectFromWidgets(sourceNode.widgets, 'temp');
                // If widgets didn't yield images, try upstream inputs (they may carry batches)
                if (!collected.length) {
                    await collectFromUpstream(sourceNode);
                }
                break;
            }

            default: {
                await collectFromWidgets(sourceNode.widgets, 'temp');
                break;
            }
        }

        if (collected.length) return collected;

        if (includeDomFallback) {
            // If no image found in widgets, try to look for image elements in the DOM
            const canvasContainer = document.querySelector('.graphcanvas') || document.querySelector('#graph-canvas') || document.querySelector('.comfyui-body');
            if (canvasContainer) {
                // Look for any image associated with the source node
                const nodeElement = canvasContainer.querySelector(`[data-node-id="${sourceNode.id}"]`);
                if (nodeElement) {
                    const imgElements = nodeElement.querySelectorAll('img');
                    for (const img of imgElements) {
                        if (img.src && (img.src.startsWith('data:') || img.src.startsWith('http'))) {
                            collected.push(img.src);
                            break;
                        }
                    }
                }
            }
        }

        return collected;
    } catch (error) {
        console.error(`Error extracting image(s) from source node ${sourceNode.type}:`, error);
        return collected;
    }
}

/**
 * Load image from URL as base64
 * @param {string} imageUrl - URL of the image to load
 * @returns {Promise<string|null>} Promise that resolves to base64 image data or null
 */
async function loadImageAsBase64(imageUrl) {
    try {
        if (!imageUrl) {
            return null;
        }

        // Handle data URLs directly
        if (imageUrl.startsWith('data:')) {
            return imageUrl;
        }

        // Add cache-busting parameter to ensure fresh image
        let urlToUse = imageUrl;
        if (imageUrl.includes('?')) {
            urlToUse = `${imageUrl}&t=${Date.now()}`;
        } else {
            urlToUse = `${imageUrl}?t=${Date.now()}`;
        }

        const response = await fetch(urlToUse);
        if (!response.ok) {
            // Suppress 404 errors as they're expected when checking for ref images
            if (response.status !== 404) {
                console.error(`Error loading image (${response.status}):`, urlToUse);
            }
            return null;
        }

        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        // Only log unexpected errors (not 404s)
        if (!error.message?.includes('404')) {
            console.error('Error loading image as base64:', error);
        }
        return null;
    }
}

/**
 * Check if ImageResizeKJv2 is in the node chain and extract its parameters
 * @param {Object} startNode - The starting node
 * @param {string} inputName - The input name to trace
 * @returns {Object|null} Resize node parameters or null if not found
 */
function findResizeNodeInChain(startNode, inputName) {
    const graph = app.graph;
    if (!graph || !graph.links) return null;

    const visited = new Set();
    const toVisit = [{ node: startNode, input: inputName }];

    while (toVisit.length > 0) {
        const { node, input } = toVisit.shift();

        if (visited.has(node.id)) continue;
        visited.add(node.id);

        // Check if this node is ImageResizeKJv2
        if (node.type === 'ImageResizeKJv2') {
            // Extract parameters from the node's widgets
            const params = {};
            if (node.widgets) {
                for (const widget of node.widgets) {
                    params[widget.name] = widget.value;
                }
            }

            // Check if width/height are connected from other nodes
            if (node.inputs) {
                for (let i = 0; i < node.inputs.length; i++) {
                    const nodeInput = node.inputs[i];
                    const inputName = nodeInput.name;

                    // Find if this input has a connection
                    let link = null;
                    if (graph.links instanceof Map) {
                        for (const [linkId, linkObj] of graph.links) {
                            if (linkObj && linkObj.target_id === node.id && linkObj.target_slot === i) {
                                link = linkObj;
                                break;
                            }
                        }
                    } else if (Array.isArray(graph.links)) {
                        link = graph.links.find(linkObj =>
                            linkObj && linkObj.target_id === node.id && linkObj.target_slot === i
                        );
                    }

                    if (link) {
                        // Found a connection for this input
                        const sourceNode = graph._nodes?.find(n => n.id === link.origin_id);
                        if (sourceNode) {
                            // Try to get the value from the source node's output
                            const outputSlot = link.origin_slot;

                            // Check if source node has widgets_values or properties
                            if (sourceNode.widgets_values && sourceNode.widgets_values.length > outputSlot) {
                                params[inputName] = sourceNode.widgets_values[outputSlot];
                            } else if (sourceNode.widgets && sourceNode.widgets[outputSlot]) {
                                params[inputName] = sourceNode.widgets[outputSlot].value;
                            } else {
                                // Try to find matching output name
                                const outputInfo = sourceNode.outputs?.[outputSlot];
                                if (outputInfo) {
                                    // If it's a primitive or value node, try to get its value
                                    if (sourceNode.widgets && sourceNode.widgets.length > 0) {
                                        const widget = sourceNode.widgets.find(w => w.name === outputInfo.name || w.name === 'value');
                                        if (widget) {
                                            params[inputName] = widget.value;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            return params;
        }

        // Continue traversing upstream
        if (node.inputs) {
            for (const nodeInput of node.inputs) {
                const inputIndex = node.inputs.indexOf(nodeInput);

                // Find link connected to this input
                let link = null;
                if (graph.links instanceof Map) {
                    for (const [linkId, linkObj] of graph.links) {
                        if (linkObj && linkObj.target_id === node.id && linkObj.target_slot === inputIndex) {
                            link = linkObj;
                            break;
                        }
                    }
                } else if (Array.isArray(graph.links)) {
                    link = graph.links.find(linkObj =>
                        linkObj && linkObj.target_id === node.id && linkObj.target_slot === inputIndex
                    );
                }

                if (link) {
                    const sourceNode = graph._nodes?.find(n => n.id === link.origin_id);
                    if (sourceNode) {
                        toVisit.push({ node: sourceNode, input: nodeInput.name });
                    }
                }
            }
        }
    }

    return null;
}

/**
 * Main function to get reference image from connected node
 * @param {Object} currentNode - The Power Spline Editor node
 * @returns {Promise<string|null>} Promise that resolves to base64 image data or null
 */
async function getReferenceImageFromConnectedNode(currentNode, inputName = 'ref_image') {
    // Step 1: Find the connected source node for ref_image input
    let sourceNodeObj = findConnectedSourceNode(currentNode, inputName);
    if (!sourceNodeObj) {
        // Try deep search as fallback
        sourceNodeObj = findDeepSourceNode(currentNode, inputName);
    }

    if (!sourceNodeObj) {
        return null;
    }

    // Check if ImageResizeKJv2 is in the chain and get its parameters
    const resizeParams = findResizeNodeInChain(currentNode, inputName);

    // Step 2: Extract image data from the source node
    let imageDataUrl = await extractImageFromSourceNode(sourceNodeObj);
    if (!imageDataUrl) {
        // If we couldn't extract image from the found source node, try to find the original image source via deep search
        const deepSourceNodeObj = findDeepSourceNode(currentNode, inputName);
        if (deepSourceNodeObj && deepSourceNodeObj.node.id !== sourceNodeObj.node.id) {
            imageDataUrl = await extractImageFromSourceNode(deepSourceNodeObj);
            if (imageDataUrl) {
                sourceNodeObj = deepSourceNodeObj; // Update the source node for potential logging
            }
        }
    }

    if (!imageDataUrl) {
        return null;
    }

    // Step 3: Load the image as base64
    let base64Image = await loadImageAsBase64(imageDataUrl);
    if (!base64Image) {
        console.error('Failed to load image as base64');
        return null;
    }

    // Step 4: Apply resize parameters if ImageResizeKJv2 was detected
    if (resizeParams) {
        try {
            // Load image to apply resize
            const img = new Image();
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                img.src = base64Image;
            });

            // Apply resize transformation
            const { canvas } = await applyResizeParams(img, resizeParams);

            // Convert back to base64
            base64Image = canvas.toDataURL('image/jpeg', 0.95);
        } catch (error) {
            console.error('Error applying resize parameters:', error);
            // Continue with original image if resize fails
        }
    }

    return base64Image;
}

/**
 * Wrapper to fetch one or more reference images (first frame chosen) from the ref_images input.
 * Currently returns at most one image because ComfyUI previews expose only a single frame.
 * @param {Object} currentNode
 * @returns {Promise<string[]>} array of base64 data URLs (may be empty)
 */
async function getReferenceImagesFromConnectedNode(currentNode) {
    let sourceNodeObj = findConnectedSourceNode(currentNode, 'ref_images');
    if (!sourceNodeObj) {
        sourceNodeObj = findDeepSourceNode(currentNode, 'ref_images');
    }

    let images = [];
    if (sourceNodeObj) {
        images = await extractImagesFromSourceNode(sourceNodeObj, true);
    }

    if ((!images || images.length === 0) && sourceNodeObj) {
        const deep = findDeepSourceNode(currentNode, 'ref_images');
        if (deep && deep.node.id !== sourceNodeObj.node.id) {
            images = await extractImagesFromSourceNode(deep, true);
        }
    }

    // Fallback to single-image path
    if (!images || images.length === 0) {
        const single = await getReferenceImageFromConnectedNode(currentNode, 'ref_images');
        if (single) return [single];
        return [];
    }

    return images;
}

/**
 * Recursively find the original source node connected to a specific input
 * @param {Object} currentNode - The node to start from
 * @param {string} inputName - Name of the input to trace (e.g., "ref_image")
 * @param {Set<number>} visited - Internal set to prevent infinite loops
 * @returns {Object|null} The ultimate source node or null
 */
function findDeepSourceNode(currentNode, inputName, visited = new Set()) {
    const graph = app.graph;
    if (!graph || !graph.links) return null;

    if (visited.has(currentNode.id)) return null;
    visited.add(currentNode.id);

    // Get the link object for the input
    const inputIndex = currentNode.inputs?.findIndex(i => i.name === inputName) ?? -1;
    if (inputIndex < 0) return null;

    let link = null;
    // Find the link connected to this input (graph.links is a Map, not an array)
    if (graph.links && graph.links instanceof Map) {
        for (const [linkId, linkObj] of graph.links) {
            if (!linkObj) continue;
            if (linkObj.target_id === currentNode.id && linkObj.target_slot === inputIndex) {
                link = linkObj;
                break;
            }
        }
    } else if (Array.isArray(graph.links)) {
        // Fallback if links is an array (older format)
        link = graph.links.find(linkObj => {
            if (!linkObj) return false;
            return linkObj.target_id === currentNode.id && linkObj.target_slot === inputIndex;
        });
    }

    if (!link) return null;

    const sourceNode = graph._nodes?.find(node => node.id === link.origin_id);
    if (!sourceNode) return null;

    // Check if the source node contains image data
    if (isImageNode(sourceNode)) {
        // Prioritize true image loaders over processors
        const imageLoaderTypes = ['LoadImage', 'LoadImageUpload'];
        if (imageLoaderTypes.some(type => sourceNode.type?.includes(type))) {
            return {
                node: sourceNode,
                origin_slot: link.origin_slot,
                target_slot: link.target_slot
            };
        }

        // If this is an image processor, continue looking upstream for the original source
        if (sourceNode.inputs) {
            for (const input of sourceNode.inputs) {
                const deeper = findDeepSourceNode(sourceNode, input.name, new Set(visited)); // Use a copy of visited set for each branch
                if (deeper) {
                    return deeper; // Return the original source found upstream
                }
            }
        }
        
        // If no original source found upstream, return this processor as fallback
        return {
            node: sourceNode,
            origin_slot: link.origin_slot,
            target_slot: link.target_slot
        };
    }

    // If not an image node, recursively check each input of the source node for possible image connections
    if (sourceNode.inputs) {
        for (const input of sourceNode.inputs) {
            const deeper = findDeepSourceNode(sourceNode, input.name, new Set(visited)); // Use a copy of visited set for each branch
            if (deeper) return deeper;
        }
    }

    return null;
}

/**
 * Check if a node is likely to contain image data
 * @param {Object} node - The node to check
 * @returns {boolean} Whether the node is likely to contain image data
 */
function isImageNode(node) {
    // Check node type for common image-related nodes
    const imageNodeTypes = [
        'LoadImage', 'LoadImageUpload', 'VAEDecode', 'PreviewImage', 'SaveImage',
        'ImageScale', 'ImageScaleBy', 'ImageResizeKJv2', 'ImageUpscale', 'ImageCrop',
        'ImagePadForOutpaint', 'ImageBatch', 'ImageBlend', 'ImageBlur', 'ImageColorToBW',
        'ImageFlip', 'ImageOnlyCheckpointLoader', 'ImageApplyProcessing',
        // Additional list/batch helpers that produce image lists
        'CreateImageList', 'ImpactMakeImageList', 'ImpactMakeAnyList'
    ];
    if (imageNodeTypes.some(type => node.type && node.type.includes(type))) {
        return true;
    }

    // Check if node has IMAGE type outputs
    if (node.outputs) {
        for (const output of node.outputs) {
            if (output.type === 'IMAGE' || (output.name && (output.name.includes('IMAGE') || output.name.toLowerCase().includes('image')))) {
                return true;
            }
        }
    }

    // Check if node has image-related widgets
    if (node.widgets) {
        for (const widget of node.widgets) {
            if (widget.type === 'image' || (widget.name && widget.name.toLowerCase().includes('image'))) {
                return true;
            }
        }
    }

    return false;
}

// Export functions for use in other modules
export { findConnectedSourceNode, findDeepSourceNode, extractImageFromSourceNode, extractImagesFromSourceNode, loadImageAsBase64, getReferenceImageFromConnectedNode, getReferenceImagesFromConnectedNode };
