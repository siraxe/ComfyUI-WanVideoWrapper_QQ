/**
 * Power Load Video - DOM-based video display with custom timeline
 *
 * Creates a video display using addDOMWidget (like Power Spline Editor)
 * with an integrated scrubbable timeline below the video.
 */

import { app } from '../../../scripts/app.js';
import { RgthreeBaseWidget } from './power_spline_editor/drawing_utils.js';
import { api } from '../../../scripts/api.js';

/**
 * Timeline Widget for video playback control
 * Styled to match Power Spline Editor's timeline aesthetic
 */
class PowerLoadVideoTimelineWidget extends RgthreeBaseWidget {
    constructor(name = "PowerLoadVideoTimeline") {
        super(name);
        this.type = "custom";
        this.options = { serialize: false };
        this.value = {
            isPlaying: false,  // Changed to false - no auto-playback
            currentFrame: 1,
            totalFrames: 1,
            fps: 24
        };

        // Animation state
        this.animationId = null;
        this.lastUpdateTime = 0;

        // Fix #1 & #2: Initialize hitAreas and mouseDowned to prevent runtime errors
        this.hitAreas = {};
        this.mouseDowned = false;

        // Fix #7: Initialize showTimeline to true by default (timeline should always be visible)
        this.showTimeline = true;

        // Create persistent hit area objects (don't recreate on every draw!)
        // This ensures object identity is preserved between pointerdown and pointermove events
        this.hitAreas.timeline = {
            bounds: [0, 0, 0, 0],
            onClick: null,
            onMove: null
        };
        this.hitAreas.timelinePlay = {
            bounds: [0, 0, 0, 0],
            onClick: null
        };

    }

    /**
     * Update the total frame count for this node's timeline
     */
    setTotalFrames(node, totalFrames) {
        if (totalFrames && totalFrames > 0) {
            this.value.totalFrames = totalFrames;
            // Clamp current frame to new range
            this.value.currentFrame = Math.max(1, Math.min(this.value.currentFrame, totalFrames));
            node.setDirtyCanvas(true, true);
        }
    }

    /**
     * Update FPS for playback speed control
     */
    setFPS(node, fps) {
        if (fps && fps > 0) {
            this.value.fps = fps;
        }
    }

    /**
     * Set the video element reference for direct control
     */
    setVideoElement(videoElement) {
        this.videoElement = videoElement;
    }

    /**
     * Main draw function for the timeline widget
     */
    draw(ctx, node) {
        const padding = 16;
        const detailRowHeight = this.computeSize(node.size[0])[1];
        const playSize = Math.min(22, detailRowHeight - 4);

        ctx.save();

        // Calculate layout (full width timeline)
        const detailX = padding;
        const canvasToTimelineOffset = 8; // Offset between video canvas and timeline
        const detailY = this.y + canvasToTimelineOffset;
        const detailWidth = node.size[0] - padding * 2;

        // === UNIFIED CONTAINER WITH ROUNDED BORDER ===
        const containerBorderRadius = 6; // Rounded corners for container border
        const containerPadding = 8; // Padding inside the container

        // Container spans from play button area to frame counter
        const containerX = detailX + padding;
        const containerY = detailY + 2; // Small top offset
        const containerWidth = detailWidth - padding * 2;
        const containerHeight = detailRowHeight - 4;
        const containerMidY = containerY + containerHeight / 2;

        const playActive = this.value.isPlaying;
        const playPressed = this._isButtonPressed('timelinePlay');

        ctx.save();

        // Draw unified rounded container (like Power Spline Editor style)
        ctx.fillStyle = '#1a1a1a'; // Dark background for container
        ctx.strokeStyle = '#555'; // Border color
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(containerX, containerY, containerWidth, containerHeight, [containerBorderRadius]);
        } else {
            // Fallback for rounded rectangle
            const r = containerBorderRadius;
            ctx.moveTo(containerX + r, containerY);
            ctx.lineTo(containerX + containerWidth - r, containerY);
            ctx.arc(containerX + containerWidth - r, containerY + r, r, Math.PI * 1.5, Math.PI * 2);
            ctx.lineTo(containerX + containerWidth, containerHeight - r);
            ctx.arc(containerX + containerWidth - r, containerHeight - r, r, 0, Math.PI * 0.5);
            ctx.lineTo(containerX + r, containerHeight);
            ctx.arc(containerX + r, containerHeight - r, r, Math.PI * 0.5, Math.PI);
            ctx.lineTo(containerX, containerY + r);
            ctx.arc(containerX + r, containerY + r, r, Math.PI, Math.PI * 1.5);
        }
        ctx.fill();
        ctx.stroke();

        // === DRAW PLAY/PAUSE ICON (inside container) ===
        const playX = containerX + containerPadding;
        const playY = containerMidY - playSize / 2;

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = playActive ? '#2cc6ff' : LiteGraph.WIDGET_TEXT_COLOR; // Cyan when playing
        ctx.font = `${Math.max(14, playSize * 0.8)}px Sans-Serif`;
        const icon = playActive ? '⏸' : '▶';
        ctx.fillText(icon, playX + playSize / 2, playY + playSize / 2 + (playPressed ? 1 : 0));

        // Update persistent hit area bounds only (don't recreate object!)
        this.hitAreas.timelinePlay.bounds = [playX, playY, playSize, playSize];
        if (!this.hitAreas.timelinePlay.onClick) {
            this.hitAreas.timelinePlay.onClick = (e, pos, n) => this.togglePlay(n);
        }

        // === DRAW TIMELINE TRACK (inside container) ===
        const spacer = 10;

        const sliderSteps = this.value.totalFrames || 1;
        const sliderValue = this.value.currentFrame;
        const sliderProgress = sliderSteps > 1 ? (sliderValue - 1) / (sliderSteps - 1) : 0;

        // Measure frame counter text width using fixed font and always assume 3 digits (999/999)
        // This prevents the timeline from scaling when frames go from 2 to 3 digits
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = `${Math.max(14, playSize * 0.8)}px Sans-Serif`;
        const frameCounterWidth = ctx.measureText('999/999').width + 8; // Always reserve space for 6 digits + separator

        // Calculate timeline dimensions based on available space minus frame counter
        const timelineX = playX + playSize + spacer;
        const timelineHeight = 16; // Timeline track height
        const timelineY = containerMidY - timelineHeight / 2;
        const timelineMidY = containerMidY;
        const timelineWidth = Math.max(10, containerWidth - containerPadding * 2 - playSize - spacer * 2 - frameCounterWidth);
        const timelineEnd = timelineX + timelineWidth;
        const stepWidth = sliderSteps > 1 ? timelineWidth / (sliderSteps - 1) : 0;

        // Timeline track line (inside the container)
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(timelineX, timelineMidY);
        ctx.lineTo(timelineEnd, timelineMidY);
        ctx.stroke();

        // Frame markers (dots evenly distributed for visual reference)
        ctx.fillStyle = '#777';
        const maxMarkers = 100; // Limit markers for performance
        const actualMarkerCount = Math.min(sliderSteps, maxMarkers);
        const markerStep = sliderSteps > 1 ? sliderSteps / (actualMarkerCount - 1) : 1;
        for (let i = 0; i < actualMarkerCount; i++) {
            const frameIndex = Math.round(i * markerStep);
            const x = timelineX + stepWidth * frameIndex;
            // Draw larger dot every ~5 markers for better visual reference
            const isMajorMarker = i % 5 === 0;
            ctx.beginPath();
            ctx.arc(x, timelineMidY, isMajorMarker ? 2 : 1, 0, Math.PI * 2);
            ctx.fill();
        }

        // === DRAW SLIDER HANDLE (styled like Power Spline Editor) ===
        ctx.fillStyle = '#2cc6ff'; // Cyan color matching PSE
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;

        const sliderHalfWidth = Math.max(3, detailRowHeight * 0.12);
        const sliderHalfHeight = Math.max(8, detailRowHeight * 0.35);
        const sliderPosX = timelineX + sliderProgress * timelineWidth;
        ctx.beginPath();
        ctx.rect(sliderPosX - sliderHalfWidth, timelineMidY - sliderHalfHeight, sliderHalfWidth * 2, sliderHalfHeight * 2);
        ctx.fill();
        ctx.stroke();

        // Frame counter label (inside container on the right)
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        const frameCounterX = timelineEnd + spacer;
        ctx.fillText(`${sliderValue}/${sliderSteps}`, frameCounterX, timelineMidY);

        ctx.restore();

        // === SETUP HIT AREAS ===
        // Use the timeline track area for seek interaction
        // Expand hit area vertically to cover entire widget height for easier scrubbing
        const expandedTimelineHeight = detailRowHeight; // Full widget height for hit detection

        // Update persistent hit area bounds only (don't recreate object!)
        this.hitAreas.timeline.bounds = [timelineX, detailY, timelineWidth, expandedTimelineHeight];
        if (!this.hitAreas.timeline.onClick) {
            this.hitAreas.timeline.onClick = (e, pos, n) => this.seekToPosition(e, pos, n);
        }
        if (!this.hitAreas.timeline.onMove) {
            this.hitAreas.timeline.onMove = (e, pos, n) => this.dragSeek(e, pos, n);
        }

        ctx.restore();
    }

    /**
     * Draw button background matching Power Spline Editor style
     */
    _drawButtonBackground(ctx, x, y, width, height, active) {
        ctx.save();
        ctx.fillStyle = active ? '#0d3b4a' : LiteGraph.WIDGET_BGCOLOR;
        ctx.strokeStyle = active ? '#2cc6ff' : LiteGraph.WIDGET_OUTLINE_COLOR;
        ctx.lineWidth = active ? 2 : 1;
        ctx.beginPath();
        
        // Fix #4: Use fallback for roundRect compatibility with older browsers
        if (ctx.roundRect) {
            ctx.roundRect(x, y, width, height, [6]);
        } else {
            // Fallback: draw rounded rectangle using arcTo
            const r = 6;
            ctx.moveTo(x + r, y);
            ctx.lineTo(x + width - r, y);
            ctx.arcTo(x + width, y, x + width, y + r, r);
            ctx.lineTo(x + width, y + height - r);
            ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
            ctx.lineTo(x + r, y + height);
            ctx.arcTo(x, y + height, x, y + height - r, r);
            ctx.lineTo(x, y + r);
            ctx.arcTo(x, y, x + r, y, r);
            ctx.closePath();
        }
        
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    /**
     * Check if a button is currently pressed
     */
    _isButtonPressed(buttonName) {
        const hitArea = this.hitAreas[buttonName];
        return hitArea?.wasMouseClickedAndIsOver || false;
    }

    /**
     * Toggle play/pause state
     */
    togglePlay(node) {
        this.value.isPlaying = !this.value.isPlaying;

        if (this.value.isPlaying) {
            this.startPlayback(node);
        } else {
            this.stopPlayback();
        }

        node.setDirtyCanvas(true, true);
    }

    /**
     * Start video playback animation
     */
    startPlayback(node) {
        // Fix #3: Cancel any existing animation first for safety against memory leaks
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }

        const fps = this.value.fps || 24;
        const frameInterval = 1000 / fps;

        const animate = () => {
            const now = performance.now();

            if (now - this.lastUpdateTime >= frameInterval) {
                this.value.currentFrame++;

                // Loop at end
                if (this.value.currentFrame > this.value.totalFrames) {
                    this.value.currentFrame = 1;
                }

                // Update video element time if available
                if (this.videoElement && this.videoElement.duration) {
                    const newTime = (this.value.currentFrame - 1) / fps;
                    this.videoElement.currentTime = Math.min(newTime, this.videoElement.duration);
                }

                this.lastUpdateTime = now;
                node.setDirtyCanvas(true, true);
            }

            this.animationId = requestAnimationFrame(animate);
        };

        this.lastUpdateTime = performance.now();
        this.animationId = requestAnimationFrame(animate);
    }

    /**
     * Stop video playback animation
     */
    stopPlayback() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    /**
     * Seek to a specific position on click
     */
    seekToPosition(event, pos, node) {
        const timelineX = this.hitAreas.timeline.bounds[0];
        const timelineWidth = this.hitAreas.timeline.bounds[2];

        const relativeX = Math.max(0, Math.min(timelineWidth, pos[0] - timelineX));
        const ratio = timelineWidth > 0 ? relativeX / timelineWidth : 0;

        const newFrame = Math.max(1, Math.round(ratio * (this.value.totalFrames - 1)) + 1);
        this.value.currentFrame = newFrame;

        // Update video element time if available
        if (this.videoElement && this.videoElement.duration) {
            const fps = this.value.fps || 24;
            const newTime = (newFrame - 1) / fps;
            this.videoElement.currentTime = Math.min(newTime, this.videoElement.duration);
        }

        node.setDirtyCanvas(true, true);
    }

    /**
     * Drag to seek along timeline
     * Called by base class RgthreeBaseWidget when mouse is dragged over hit area
     * Uses direct position calculation for smooth real-time scrubbing
     */
    dragSeek(event, pos, node) {
        // Use the current mouse position directly for real-time scrubbing
        const timelineX = this.hitAreas.timeline.bounds[0];
        const timelineWidth = this.hitAreas.timeline.bounds[2];
        const totalFrames = this.value.totalFrames || 1;

        // Calculate frame from absolute position (same as seekToPosition)
        const relativeX = Math.max(0, Math.min(timelineWidth, pos[0] - timelineX));
        const ratio = timelineWidth > 0 ? relativeX / timelineWidth : 0;
        const newFrame = Math.max(1, Math.round(ratio * (totalFrames - 1)) + 1);

        if (newFrame !== this.value.currentFrame) {
            this.value.currentFrame = newFrame;

            // Update video element time if available
            if (this.videoElement && this.videoElement.duration) {
                const fps = this.value.fps || 24;
                const newTime = (newFrame - 1) / fps;
                this.videoElement.currentTime = Math.min(newTime, this.videoElement.duration);
            }

            node.setDirtyCanvas(true, true);
        }
    }

    /**
     * Cleanup when node is removed
     */
    onRemove(node) {
        this.stopPlayback();
    }

    /**
     * Set whether the timeline should be visible
     * Similar to Power Spline Editor's box layer behavior when "Add Keyframes" is pressed
     */
    setShowTimeline(show) {
        this.showTimeline = !!show;
    }

    /**
     * Compute widget size - returns 0 height when hidden, 36px when visible
     * Similar to Power Spline Editor's box layer behavior
     */
    computeSize(width) {
        const result = this.showTimeline ? [width, 36] : [width, 0];
        return result;
    }
}

/**
 * Upload a video file to ComfyUI's input directory
 */
async function uploadVideoFile(file) {
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
async function createPowerLoadVideoNodeAt(pos, filename) {
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

/**
 * Register the custom node with ComfyUI using app.registerExtension
 */
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

        const handleDrop = async (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Prevent double-processing
            if (isHandlingDrop) return;

            const file = e.dataTransfer?.files[0];
            if (!file) return;

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
            nodeType.prototype.onNodeCreated = function() {

                // Call original first
                if (originalOnNodeCreated) {
                    originalOnNodeCreated.apply(this, arguments);
                }
                // Fix #5: Ensure widgets array exists before manipulation
                this.widgets = this.widgets || [];
                // Remove ALL built-in video-related widgets (video, timeline, playback controls)
                // This ensures we only show our custom DOM-based display
                const widgetsToRemove = ['video', 'timeline', 'frame_rate', 'looping'];
                let removedCount = 0;
                for (const widgetName of widgetsToRemove) {
                    let index;
                    while ((index = this.widgets.findIndex(w => w.name === widgetName)) >= 0) {
                        this.widgets.splice(index, 1);
                        removedCount++;
                    }
                }
                // ALSO hide any remaining video DOM elements that might be rendered by ComfyUI's video upload
                const hideBuiltInElements = () => {
                    const nodeContainer = document.getElementById(`node-${this.id}`);
                    if (nodeContainer) {
                        // Find and hide any video/canvas elements - be more aggressive with selector
                        const builtInElements = nodeContainer.querySelectorAll('video, canvas:not([id*="litegraph"]), .vhs-video-container');
                        builtInElements.forEach(el => {
                            el.style.display = 'none';
                        });
                    }
                };

                // Try multiple times to ensure we catch dynamically added elements
                hideBuiltInElements();
                setTimeout(hideBuiltInElements, 50);
                setTimeout(hideBuiltInElements, 100);

                // Use MutationObserver to continuously hide any built-in elements that get added dynamically
                const observer = new MutationObserver(() => {
                    hideBuiltInElements();
                });

                // Store reference on node for cleanup
                this.vhsObserver = observer;

                // Observe the node container for changes once it exists
                setTimeout(() => {
                    const nodeContainer = document.getElementById(`node-${this.id}`);
                    if (nodeContainer) {
                        observer.observe(nodeContainer, { childList: true, subtree: true });

                        // Add inline style to hide built-in elements at the container level
                        const styleEl = document.createElement('style');
                        styleEl.id = `power-load-video-styles-${this.id}`;
                        styleEl.textContent = `
                            #node-${this.id} video:not([id*="power-load-video"]),
                            #node-${this.id} canvas.vhs-canvas,
                            #node-${this.id} .vhs-video-container,
                            #node-${this.id} [class*="vhs"] {
                                display: none !important;
                            }
                        `;
                        document.head.appendChild(styleEl);
                    }
                }, 100);

                // Add addCustomWidget polyfill if not present (same as PowerSplineEditor)
                if (!this.addCustomWidget) {
                    this.addCustomWidget = function (widget) {
                        widget.parent = this;
                        this.widgets = this.widgets || [];
                        this.widgets.push(widget);

                        const originalMouse = widget.mouse;
                        widget.mouse = function (event, pos, node) {
                            const localPos = [pos[0], pos[1] - (widget.last_y || 0)];
                            return originalMouse?.call(this, event, localPos, node);
                        };

                        return widget;
                    };
                }

                // Create DOM container for video display with drag-and-drop support
                const videoContainer = document.createElement('div');
                videoContainer.id = `power-load-video-${this.id}`;
                videoContainer.style.cssText = `
                    width: 100%;
                    height: 280px;
                    background-color: #000;
                    position: relative;
                    overflow: hidden;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                `;

                // Add placeholder text
                const placeholderText = document.createElement('div');
                placeholderText.id = `power-load-video-placeholder-${this.id}`;
                placeholderText.textContent = 'Drop video here';
                placeholderText.style.cssText = `
                    position: absolute;
                    color: #888;
                    font-size: 14px;
                    pointer-events: none;
                    user-select: none;
                `;

                // Create HTML5 video element
                const videoElement = document.createElement('video');
                videoElement.id = `power-load-video-element-${this.id}`;
                videoElement.style.cssText = `
                    max-width: 100%;
                    max-height: 100%;
                    display: block;
                `;
                videoElement.muted = true;
                videoElement.preload = 'auto';
                videoElement.playsInline = true;

                // Store reference on node for later access
                this.videoElement = videoElement;

                // Append elements to container
                videoContainer.appendChild(videoElement);
                videoContainer.appendChild(placeholderText);


                // Add drag-and-drop support directly to the video container element
                let draggedFile = null;

                const handleDragOver = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    videoContainer.style.backgroundColor = '#1a3a4a';
                    placeholderText.style.opacity = '1';
                };

                const handleDragLeave = (e) => {
                    // Only reset if leaving the container entirely (not entering a child)
                    if (!videoContainer.contains(e.relatedTarget)) {
                        e.preventDefault();
                        e.stopPropagation();
                        videoContainer.style.backgroundColor = '#000';
                    }
                };

                const handleDrop = async (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    videoContainer.style.backgroundColor = '#000';

                    const file = e.dataTransfer.files[0];

                    if (!file) {
                        return;
                    }

                    if (!file.type.startsWith('video/')) {
                        return;
                    }

                    draggedFile = file;

                    // Upload the file via ComfyUI's API
                    try {
                        const formData = new FormData();
                        formData.append('image', file);
                        formData.append('type', 'input');

                        const resp = await api.fetchApi('/upload/image', { method: 'POST', body: formData });

                        if (resp.ok || resp.status === 200) {
                            const data = await resp.json();

                            // Get the uploaded filename from response
                            let uploadedName = data.name || data.filename || file.name;

                            // Store the video filename on the node for execution
                            this.videoFilename = uploadedName;

                            // Directly load the video into our custom display (bypassing combo widget)
                            // The loadVideoIntoDisplay function is defined later in onNodeCreated
                            if (typeof loadVideoIntoDisplay === 'function') {
                                loadVideoIntoDisplay(uploadedName);
                            } else {
                                console.error('[PowerLoadVideo] loadVideoIntoDisplay not available yet, will retry');
                                // Retry after a short delay
                                setTimeout(() => {
                                    if (typeof loadVideoIntoDisplay === 'function') {
                                        loadVideoIntoDisplay(uploadedName);
                                    }
                                }, 50);
                            }
                        } else {
                            console.error('[PowerLoadVideo] Upload failed:', resp.status, resp.statusText);
                        }
                    } catch (err) {
                        console.error('[PowerLoadVideo] Upload error:', err);
                    }
                };

                // Attach drag handlers directly to the video container element
                videoContainer.addEventListener('dragover', handleDragOver);
                videoContainer.addEventListener('dragleave', handleDragLeave);
                videoContainer.addEventListener('drop', handleDrop);

                // Store handlers for cleanup on node removal
                this.dragHandlers = { handleDragOver, handleDragLeave, handleDrop };

                // Add as DOM widget (like PSE does)
                this.videoDisplayWidget = this.addDOMWidget(nodeData.name, 'VideoDisplay', videoContainer, {
                    serialize: false,
                    hideOnZoom: false
                });

                // Set computeSize for proper layout
                this.videoDisplayWidget.computeSize = function(width) {
                    return [width, 280];
                };

                // Create and add the timeline widget using ComfyUI's custom widget system
                if (!this.timelineWidget) {
                    this.timelineWidget = new PowerLoadVideoTimelineWidget();

                    // Register as a proper custom widget that draws on canvas
                    this.addCustomWidget(this.timelineWidget);
                }

                // Set the video element reference on the timeline widget
                this.timelineWidget.setVideoElement(videoElement);

                // Function to load video into custom display
                const loadVideoIntoDisplay = (videoFilename) => {
                    if (!videoFilename || String(videoElement.src).includes(videoFilename)) {
                        return;
                    }


                    // Hide placeholder text
                    if (placeholderText) {
                        placeholderText.style.display = 'none';
                    }

                    // Update video source - use type=input for input directory files (ComfyUI's convention)
                    const videoSrc = `/view?filename=${encodeURIComponent(videoFilename)}&type=input`;
                    videoElement.src = videoSrc;

                    // Set up one-time listeners for this load
                    const onMetadataLoaded = () => {

                        // Fix #6: Use configurable FPS from timeline widget (default 24)
                        // Note: HTML5 video doesn't expose native FPS, so we use the configured value
                        const fps = this.timelineWidget.value.fps || 24;
                        const totalFrames = Math.round(videoElement.duration * fps);


                        // Update timeline widget with frame count
                        this.timelineWidget.setTotalFrames(this, totalFrames);
                        this.timelineWidget.setFPS(this, fps);

                        // Force redraw
                        this.setDirtyCanvas(true, true);
                    };

                    const onError = (e) => {
                        console.error('[PowerLoadVideo] Video load error:', e);
                    };

                    videoElement.addEventListener('loadedmetadata', onMetadataLoaded, { once: true });
                    videoElement.addEventListener('error', onError, { once: true });
                };

                // Override execute to load video into our custom display
                const originalExecute = this.execute;
                this.execute = async function() {
                    if (originalExecute) {
                        await originalExecute.apply(this, arguments);
                    }

                    // Get the video filename from widgets_values or widget value
                    let videoFilename = null;

                    // Try to get from widgets_values first (set during node creation)
                    if (this.widgets_values && this.widgets_values.length > 0) {
                        videoFilename = this.widgets_values[0];
                    }

                    // Or try to find a widget with the video filename
                    if (!videoFilename) {
                        const videoWidget = this.widgets.find(w => w.type === 'combo' || (w.options && w.options.video_upload));
                        if (videoWidget) {
                            videoFilename = videoWidget.value;
                        }
                    }

                    loadVideoIntoDisplay(videoFilename);
                }.bind(this);

                // Watch for drag-drop changes on the combo widget (before execute)
                setTimeout(() => {
                    const videoWidget = this.widgets.find(w => w.type === 'combo');
                    if (videoWidget) {
                        // Store original callback if any
                        const originalCallback = videoWidget.callback;
                        videoWidget.callback = function(value) {
                            loadVideoIntoDisplay(value);
                            if (originalCallback) {
                                originalCallback.apply(this, arguments);
                            }
                        };
                    }
                }, 100);
            };

            // Store original onExecuted and wrap it to update frame count from output
            const originalOnExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function(message) {
                if (originalOnExecuted) {
                    originalOnExecuted.apply(this, arguments);
                }

                // Get frame count from output
                if (message && message.outputs && message.outputs[1]) {
                    const frameCount = message.outputs[1];
                    this.timelineWidget?.setTotalFrames(this, frameCount);
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
    }
});

export { PowerLoadVideoTimelineWidget };
