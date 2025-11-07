/**
 * Graph Query Utilities for ComfyUI
 * Allows querying node connections and extracting image data from connected nodes
 */

import { app } from '../../../scripts/app.js';

/**
 * Find the source node connected to a specific input of the current node
 * @param {Object} currentNode - The current node object
 * @param {string} inputName - Name of the input to find connection for (e.g., "ref_image")
 * @returns {Object|null} The source node connected to the input, or null if not connected
 */
function findConnectedSourceNode(currentNode, inputName) {
    try {
        console.log('Looking for connections for node:', {
            id: currentNode.id,
            type: currentNode.type,
            inputs: currentNode.inputs
        });

        // Look for connections where this node is the target
        const graph = app.graph;
        if (!graph || !graph.links) {
            console.error('ComfyUI graph or links not available');
            return null;
        }

        // Debug: log all links in the graph
        console.log('All graph links:', graph.links);

        // Find input index for the given input name
        let inputIndex = -1;
        let allInputNames = [];
        
        if (currentNode.inputs) {
            console.log('Node inputs found:', currentNode.inputs);
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
            console.log('No inputs property found on current node');
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
        
        console.log(`All input names:`, allInputNames);
        console.log(`Looking for input "${inputName}", found index:`, inputIndex);

        console.log(`Input "${inputName}" index:`, inputIndex);

        if (inputIndex === -1) {
            console.log(`Input "${inputName}" not found on node ${currentNode.type}`);
            return null;
        }

        // Find the link connected to this input (graph.links is a Map, not an array)
        let link = null;
        if (graph.links && graph.links instanceof Map) {
            for (const [linkId, linkObj] of graph.links) {
                if (!linkObj) continue;
                
                console.log('Checking link:', {
                    id: linkId,
                    origin_id: linkObj.origin_id,
                    origin_slot: linkObj.origin_slot,
                    target_id: linkObj.target_id,
                    target_slot: linkObj.target_slot
                });
                
                if (linkObj.target_id === currentNode.id && linkObj.target_slot === inputIndex) {
                    link = linkObj;
                    break;
                }
            }
        } else if (Array.isArray(graph.links)) {
            // Fallback if links is an array (older format)
            link = graph.links.find(linkObj => {
                if (!linkObj) return false;
                
                console.log('Checking link:', {
                    origin_id: linkObj.origin_id,
                    origin_slot: linkObj.origin_slot,
                    target_id: linkObj.target_id,
                    target_slot: linkObj.target_slot
                });
                
                return linkObj.target_id === currentNode.id && linkObj.target_slot === inputIndex;
            });
        } else {
            console.error('Graph links is not a Map or Array:', typeof graph.links);
            return null;
        }

        if (!link) {
            console.log(`No direct connection found for input "${inputName}" (index: ${inputIndex}) on node ${currentNode.id}`);
            // Debug: Check what inputs are connected - iterate through the Map
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
            
            console.log(`All connected links to this node:`, connectedLinks);
            
            // Alternative approach: try to find any connection that might be the ref_image
            if (connectedLinks.length > 0) {
                console.log('Found connected links, attempting to match by type or position...');
                // If we find connected links, try to match based on common patterns
                // ref_image is typically an IMAGE type input
                for (const connectedLink of connectedLinks) {
                    const sourceNode = graph._nodes?.find(node => node.id === connectedLink.origin_id);
                    if (sourceNode) {
                        // Check if this is likely an image source by checking the source's output type
                        const sourceOutput = sourceNode.outputs?.[connectedLink.origin_slot];
                        if (sourceOutput && (sourceOutput.type === 'IMAGE' || (sourceOutput.name && sourceOutput.name.includes('image')))) {
                            console.log(`Found possible image source at slot ${connectedLink.target_slot} from node ${sourceNode.type}`);
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
                    console.log(`Using fallback: found connection from node ${firstSourceNode.type} at slot ${firstConnectedLink.target_slot}`);
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
                console.error(`Source node with id ${link.origin_id} not found`);
                return null;
            }

            console.log(`Found connected source node:`, {
                sourceNodeId: sourceNode.id,
                sourceNodeType: sourceNode.type,
                sourceNodeWidgetValues: sourceNode.widgets ? sourceNode.widgets.map(w => ({name: w.name, type: w.type, value: w.value})) : [],
                origin_slot: link.origin_slot,
                target_slot: link.target_slot
            });

            // If the directly connected source node is not an image node, try the deep search approach
            if (!isImageNode(sourceNode)) {
                console.log('Direct source node is not an image node, trying deep search...');
                const deepResult = findDeepSourceNode(currentNode, inputName);
                if (deepResult) {
                    console.log('Deep search found an image node:', {
                        sourceNodeId: deepResult.node.id,
                        sourceNodeType: deepResult.node.type
                    });
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

        console.log(`Found connected source node:`, {
            sourceNodeId: sourceNode.id,
            sourceNodeType: sourceNode.type,
            sourceNodeWidgetValues: sourceNode.widgets ? sourceNode.widgets.map(w => ({name: w.name, type: w.type, value: w.value})) : [],
            origin_slot: link.origin_slot,
            target_slot: link.target_slot
        });

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
 * Extract image data from a source node that may contain image previews
 * @param {Object} sourceNodeObj - Object containing the source node and connection info
 * @returns {string|null} Base64 image data or URL, or null if no image found
 */
async function extractImageFromSourceNode(sourceNodeObj) {
    if (!sourceNodeObj || !sourceNodeObj.node) {
        console.error('Invalid source node object');
        return null;
    }

    const sourceNode = sourceNodeObj.node;
    try {
        // Different node types store image data differently
        switch (sourceNode.type) {
            case 'LoadImage':
            case 'LoadImageUpload':
                // These nodes typically store image info in widgets or properties
                if (sourceNode.widgets) {
                    for (const widget of sourceNode.widgets) {
                        if (widget.name === 'image' && widget.value) {
                            console.log('Found image in LoadImage widget:', widget.value);
                            // Handle different formats that LoadImage might use
                            if (typeof widget.value === 'string') {
                                // If it's already a URL or data URL, return it
                                if (widget.value.startsWith('data:') || widget.value.startsWith('http')) {
                                    return widget.value;
                                }
                                // If it's a filename, try to construct a full URL
                                return `/view?filename=${encodeURIComponent(widget.value)}&type=input`;
                            } else if (typeof widget.value === 'object' && widget.value.filename) {
                                // Object format with filename property
                                return `/view?filename=${encodeURIComponent(widget.value.filename)}&type=input`;
                            }
                        }
                    }
                }
                
                // Check properties as fallback
                if (sourceNode.properties?.value) {
                    const propValue = sourceNode.properties.value;
                    if (typeof propValue === 'string') {
                        if (propValue.startsWith('data:') || propValue.startsWith('http')) {
                            return propValue;
                        }
                        return `/view?filename=${encodeURIComponent(propValue)}&type=input`;
                    }
                }
                break;

            case 'VAEDecode':
            case 'PreviewImage':
            case 'SaveImage':
                // These nodes display images on the canvas as image widgets
                if (sourceNode.widgets) {
                    for (const widget of sourceNode.widgets) {
                        // Look for image widgets that contain image data
                        if (widget.type === 'image') {
                            if (widget.value) {
                                if (typeof widget.value === 'string') {
                                    if (widget.value.startsWith('data:') || widget.value.startsWith('http')) {
                                        console.log('Found image in PreviewImage widget:', widget.value);
                                        return widget.value;
                                    }
                                    return `/view?filename=${encodeURIComponent(widget.value)}&type=temp`;
                                } else if (typeof widget.value === 'object' && widget.value.filename) {
                                    console.log('Found image object in PreviewImage widget:', widget.value);
                                    return `/view?filename=${encodeURIComponent(widget.value.filename)}&type=temp`;
                                }
                            }
                        }
                    }
                }
                
                // Look for DOM elements that might contain image data
                // Find image elements in the node's DOM representation
                const nodeElements = document.querySelectorAll(`.graphcanvas .node[data-node-id="${sourceNode.id}"] img`);
                if (nodeElements.length > 0) {
                    const imgElement = nodeElements[0];
                    const src = imgElement.src;
                    if (src && (src.startsWith('data:') || src.startsWith('http'))) {
                        console.log('Found image in DOM element:', src);
                        return src;
                    }
                }
                break;

            case 'ImageResizeKJv2':  // Handle image processing nodes
            case 'ImageScale':
            case 'ImageScaleBy':
            case 'ImageUpscale':
            case 'ImageCrop':
                // These nodes might pass through image data from their inputs
                // Look for image widgets that might contain processed image data
                if (sourceNode.widgets) {
                    for (const widget of sourceNode.widgets) {
                        if ((widget.type === 'image' || widget.name?.includes('image')) && widget.value) {
                            console.log(`Found image in ${sourceNode.type} widget:`, widget.value);
                            
                            if (typeof widget.value === 'string') {
                                if (widget.value.startsWith('data:') || widget.value.startsWith('http')) {
                                    return widget.value;
                                }
                                return `/view?filename=${encodeURIComponent(widget.value)}&type=temp`;
                            } else if (typeof widget.value === 'object') {
                                if (widget.value.filename) {
                                    return `/view?filename=${encodeURIComponent(widget.value.filename)}&type=temp`;
                                }
                            }
                        }
                    }
                }
                // Even if no direct image found in widgets, the node might still be connected 
                // to image data that can be accessed through other means
                break;

            default:
                // For other node types, try to find image-related widgets or properties
                if (sourceNode.widgets) {
                    for (const widget of sourceNode.widgets) {
                        if ((widget.type === 'image' || widget.name?.includes('image') || 
                             widget.type === 'img' || widget.type === 'file') && widget.value) {
                            console.log(`Found potential image in ${sourceNode.type} widget:`, widget.value);
                            
                            if (typeof widget.value === 'string') {
                                if (widget.value.startsWith('data:') || widget.value.startsWith('http')) {
                                    return widget.value;
                                }
                                // Try to construct a URL for ComfyUI image endpoints
                                return `/view?filename=${encodeURIComponent(widget.value)}&type=temp`;
                            } else if (typeof widget.value === 'object') {
                                if (widget.value.filename) {
                                    return `/view?filename=${encodeURIComponent(widget.value.filename)}&type=temp`;
                                }
                            }
                        }
                    }
                }
                break;
        }

        // If no image found in widgets, try to look for image elements in the DOM
        // This is a more general approach for nodes that display images directly
        const canvasContainer = document.querySelector('.graphcanvas') || document.querySelector('#graph-canvas') || document.querySelector('.comfyui-body');
        if (canvasContainer) {
            // Look for any image associated with the source node
            const nodeElement = canvasContainer.querySelector(`[data-node-id="${sourceNode.id}"]`);
            if (nodeElement) {
                const imgElements = nodeElement.querySelectorAll('img');
                for (const img of imgElements) {
                    if (img.src && (img.src.startsWith('data:') || img.src.startsWith('http'))) {
                        console.log('Found image in node DOM element:', img.src);
                        return img.src;
                    }
                }
            }
        }

        return null;
    } catch (error) {
        console.error(`Error extracting image from source node ${sourceNode.type}:`, error);
        return null;
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
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('Error loading image as base64:', error);
        return null;
    }
}

/**
 * Main function to get reference image from connected node
 * @param {Object} currentNode - The Power Spline Editor node
 * @returns {Promise<string|null>} Promise that resolves to base64 image data or null
 */
async function getReferenceImageFromConnectedNode(currentNode) {
    console.log('Starting reference image query for node:', currentNode);

    // Step 1: Find the connected source node for ref_image input
    let sourceNodeObj = findConnectedSourceNode(currentNode, 'ref_image');
    if (!sourceNodeObj) {
        console.log('No source node found for ref_image input, trying deep search...');
        // Try deep search as fallback
        sourceNodeObj = findDeepSourceNode(currentNode, 'ref_image');
        if (sourceNodeObj) {
            console.log('Deep search found a potential image source node:', {
                sourceNodeId: sourceNodeObj.node.id,
                sourceNodeType: sourceNodeObj.node.type
            });
        }
    }
    
    if (!sourceNodeObj) {
        console.log('No source node found for ref_image input after deep search');
        return null;
    }

    // Step 2: Extract image data from the source node
    let imageDataUrl = await extractImageFromSourceNode(sourceNodeObj);
    if (!imageDataUrl) {
        console.log('No image data found in source node, trying deep search for original image source...');
        // If we couldn't extract image from the found source node, try to find the original image source via deep search
        const deepSourceNodeObj = findDeepSourceNode(currentNode, 'ref_image');
        if (deepSourceNodeObj && deepSourceNodeObj.node.id !== sourceNodeObj.node.id) {
            console.log('Deep search found alternative source node:', {
                sourceNodeId: deepSourceNodeObj.node.id,
                sourceNodeType: deepSourceNodeObj.node.type
            });
            imageDataUrl = await extractImageFromSourceNode(deepSourceNodeObj);
            if (imageDataUrl) {
                sourceNodeObj = deepSourceNodeObj; // Update the source node for potential logging
            }
        }
    }

    if (!imageDataUrl) {
        console.log('No image data found in source node after trying alternatives');
        return null;
    }

    // Step 3: Load the image as base64
    const base64Image = await loadImageAsBase64(imageDataUrl);
    if (!base64Image) {
        console.error('Failed to load image as base64');
        return null;
    }

    console.log('Successfully retrieved reference image from connected node');
    return base64Image;
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
        'ImageFlip', 'ImageOnlyCheckpointLoader', 'ImageApplyProcessing'
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
export { findConnectedSourceNode, findDeepSourceNode, extractImageFromSourceNode, loadImageAsBase64, getReferenceImageFromConnectedNode };