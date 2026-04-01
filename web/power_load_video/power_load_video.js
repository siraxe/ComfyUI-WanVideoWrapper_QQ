/**
 * Power Load Video - DOM-based video display with custom timeline
 *
 * Creates a video display using addDOMWidget (like Power Spline Editor)
 * with an integrated scrubbable timeline below the video.
 *
 * Entry point for the modular power_load_video package.
 */

import { app } from '../../../scripts/app.js';
import { api } from '../../../scripts/api.js';
import { uploadVideoFile, createPowerLoadVideoNodeAt } from './upload_handler.js';
import { createOnNodeCreatedWrapper } from './node_setup.js';

app.registerExtension({
    name: 'PowerLoadVideo',

    /**
     * Intercept canvas-level drag-and-drop to create Power Load Video nodes
     * instead of default Load Video nodes
     */
    async setup() {
        // Get the canvas element - try multiple approaches
        let canvas = null;

        // Method 1: Try to find litegraph canvas directly
        const liteGraphCanvas = document.querySelector('canvas.litegraph');
        if (liteGraphCanvas) {
            canvas = liteGraphCanvas;
        }

        // Method 2: Try to find any canvas with id containing 'graph'
        if (!canvas) {
            const graphCanvas = document.querySelector('canvas[id*="graph"]');
            if (graphCanvas) {
                canvas = graphCanvas;
            }
        }

        // Method 3: Try to find the first canvas element
        if (!canvas) {
            canvas = document.querySelector('canvas');
            if (canvas) {
            }
        }

        if (!canvas) {
            console.warn('[PowerLoadVideo] Canvas not found yet, will retry on node creation');
            return;
        }


        // Track if we're handling a drop to prevent double-processing
        let isHandlingDrop = false;
        let droppedFile = null;

        const handleDragOver = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };

        /**
         * Extract embedded ComfyUI workflow from PNG metadata
         */
        const extractWorkflowFromPng = (arrayBuffer) => {
            try {
                const dataView = new DataView(arrayBuffer);

                // Verify PNG signature
                if (dataView.getUint32(0) !== 0x89504e47) return null;

                let offset = 8;

                while (offset < dataView.byteLength - 11) {
                    const chunkLength = dataView.getUint32(offset);
                    const chunkType = String.fromCharCode(
                        dataView.getUint8(offset + 4),
                        dataView.getUint8(offset + 5),
                        dataView.getUint8(offset + 6),
                        dataView.getUint8(offset + 7)
                    );

                    // Check for tEXt chunks (text metadata)
                    if (chunkType === 'tEXt' && chunkLength > 0) {
                        let keywordStart = offset + 8;
                        let keyword = '';
                        while (keywordStart < offset + 8 + chunkLength && dataView.getUint8(keywordStart) !== 0) {
                            keyword += String.fromCharCode(dataView.getUint8(keywordStart));
                            keywordStart++;
                        }

                        // Check for workflow-related keywords (ComfyUI uses 'workflow')
                        if (keyword === 'workflow' || keyword === 'ExtraForUi') {
                            let textStart = keywordStart + 1; // skip null terminator
                            const textEnd = offset + 8 + chunkLength;
                            let text = '';
                            while (textStart < textEnd) {
                                text += String.fromCharCode(dataView.getUint8(textStart));
                                textStart++;
                            }

                            try {
                                return JSON.parse(text);
                            } catch (e) {
                                // Failed to parse, continue searching
                            }
                        }
                    }

                    offset += 12 + chunkLength; // length(4) + type(4) + data + crc(4)
                }
            } catch (err) {
                // Silently fail - not a valid PNG or no workflow found
            }
            return null;
        };

        const handleDrop = async (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Prevent double-processing
            if (isHandlingDrop) return;

            const file = e.dataTransfer?.files[0];
            if (!file) return;

            // Check if it's a JSON workflow file first
            if (file.name.endsWith('.json') || file.type === 'application/json') {
                try {
                    const text = await file.text();
                    const workflow = JSON.parse(text);

                    // Load the workflow using ComfyUI's built-in function
                    if (app.loadGraphData) {
                        app.loadGraphData(workflow);
                    } else {
                        console.error('[PowerLoadVideo] app.loadGraphData not available!');
                    }
                } catch (err) {
                    console.error('[PowerLoadVideo] Failed to load JSON workflow:', err);
                }
                return;
            }

            // Check if it's a PNG image with embedded workflow
            if (file.type === 'image/png') {
                try {
                    const arrayBuffer = await file.arrayBuffer();
                    const workflow = extractWorkflowFromPng(arrayBuffer);

                    if (workflow && app.loadGraphData) {
                        app.loadGraphData(workflow);
                        return;
                    }
                } catch (err) {
                    // Silently fail - not a PNG with embedded workflow
                }
            }

            // Check if it's a video file
            if (!file.type.startsWith('video/')) {
                return;
            }

            isHandlingDrop = true;
            droppedFile = file;

            // Convert client coordinates to canvas coordinates
            const rect = canvas.getBoundingClientRect();
            const canvasX = e.clientX - rect.left;
            const canvasY = e.clientY - rect.top;

            try {
                // Upload the video file
                const filename = await uploadVideoFile(file);

                if (filename) {

                    // Wait a moment for node types to be registered
                    await new Promise(resolve => setTimeout(resolve, 100));

                    // Create Power Load Video node at drop position
                    const node = await createPowerLoadVideoNodeAt([canvasX, canvasY], filename);

                    if (node) {
                        // Focus/select the new node
                        app.canvas.selectNodes([node]);
                    }
                } else {
                    console.error('[PowerLoadVideo] Upload failed!');
                }
            } finally {
                isHandlingDrop = false;
                droppedFile = null;
            }
        };

        // Attach event listeners to canvas with capture phase to intercept before default handlers
        canvas.addEventListener('dragover', handleDragOver, { capture: true });
        canvas.addEventListener('drop', handleDrop, { capture: true });

    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name === 'PowerLoadVideo') {
            if (nodeData.input) {
                // Check both 'required' and 'optional' sections in input
                const allInputs = {...nodeData.input.required, ...nodeData.input.optional};
                for (const [key, value] of Object.entries(allInputs)) {
                if (value && typeof value === 'object' && value.video_upload === true) {
                        delete value.video_upload;
                    } else if (value && Array.isArray(value) && value.length > 1 && typeof value[1] === 'object') {
                        // Handle array format [type, options]
                        if (value[1].video_upload === true) {
                                delete value[1].video_upload;
                        }
                    }
                }
            }

            // Store original onNodeCreated FIRST before wrapping
            const originalOnNodeCreated = nodeType.prototype.onNodeCreated;

            // Wrap onNodeCreated to add custom video display and timeline widget
            nodeType.prototype.onNodeCreated = createOnNodeCreatedWrapper(originalOnNodeCreated, nodeData);

            // Store original onExecuted and wrap it to update native FPS from output
            const originalOnExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function(message) {
                if (originalOnExecuted) {
                    originalOnExecuted.apply(this, arguments);
                }

                if (message && message.outputs) {
                    // Get native FPS from output[2]
                    const nativeFPS = message.outputs[2];
                    if (nativeFPS) {
                        this.timelineWidget?.setNativeFPS(this, nativeFPS);
                        // Update top row default to match native FPS on first load
                        if (this.topRowWidget && this.topRowWidget.fpsValue === 24) {
                            this.topRowWidget.fpsValue = Math.round(nativeFPS);
                            this.timelineWidget.setFPS(this, Math.round(nativeFPS));
                        }
                    }
                }

                // Recalculate total frames with accurate native FPS + duration
                if (this.timelineWidget && this.videoElement && this.videoElement.duration && isFinite(this.videoElement.duration)) {
                    // Use ceiling to ensure full video playback without truncation at the end
                    const accurateFrames = Math.ceil(this.videoElement.duration * this.timelineWidget.nativeFPS);
                    if (accurateFrames > 0) {
                        this.timelineWidget.setTotalFrames(this, accurateFrames);
                        this.timelineWidget.setStartFrame(1, this);
                        this.timelineWidget.setEndFrame(accurateFrames, this);
                    }
                }
            };

            // Store original onConfigure and wrap it
            const originalOnConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function(info) {
                if (originalOnConfigure) {
                    originalOnConfigure.apply(this, arguments);
                }

                // Try to get frame count from saved widget values if available
                if (info?.widgets_values && info.widgets_values.length > 1) {
                    const frameCount = info.widgets_values[1];
                    if (frameCount && frameCount > 0) {
                        this.timelineWidget?.setTotalFrames(this, frameCount);
                    }
                }
            };

            // Store original onRemoved and wrap it
            const originalOnRemoved = nodeType.prototype.onRemoved;
            nodeType.prototype.onRemoved = function() {
                // Clean up timeline widget
                if (this.timelineWidget) {
                    this.timelineWidget.onRemove(this);
                }

                // Clean up drag-and-drop handlers
                if (this.dragHandlers) {
                    const container = document.getElementById(`power-load-video-${this.id}`);
                    if (container) {
                        container.removeEventListener('dragover', this.dragHandlers.handleDragOver);
                        container.removeEventListener('dragleave', this.dragHandlers.handleDragLeave);
                        container.removeEventListener('drop', this.dragHandlers.handleDrop);
                    }
                    this.dragHandlers = null;
                }

                // Clean up hover audio
                if (this._stopHoverAudio) {
                    this._stopHoverAudio();
                    this._stopHoverAudio = null;
                    this._loadHoverAudio = null;
                }

                // Clear VFR frame cache on node removal
                if (this.clearVFRFrames) {
                    this.clearVFRFrames();
                }

                // Clean up keyboard shortcut handler
                if (this.handlePlayPauseShortcut) {
                    document.removeEventListener('keydown', this.handlePlayPauseShortcut);
                    this.handlePlayPauseShortcut = null;
                }

                // Clean up MutationObserver if exists
                if (this.vhsObserver) {
                    this.vhsObserver.disconnect();
                    this.vhsObserver = null;
                }

                // Remove inline styles
                const styleEl = document.getElementById(`power-load-video-styles-${this.id}`);
                if (styleEl) {
                    styleEl.remove();
                }

                if (originalOnRemoved) {
                    originalOnRemoved.apply(this, arguments);
                }
            };
        }
    },
});
