/**
 * Power Load Video - DOM-based video display with custom timeline
 *
 * Creates a video display using addDOMWidget (like Power Spline Editor)
 * with an integrated scrubbable timeline below the video.
 */

import { app } from '../../../scripts/app.js';
import { RgthreeBaseWidget, drawWidgetButton, drawNumberWidgetPart } from './power_spline_editor/drawing_utils.js';
import { api } from '../../../scripts/api.js';

/**
 * Top Row Widget for Power Load Video
 * Similar to Power Spline Editor's top row with Refresh button and text inputs
 */
class PowerLoadVideoTopRowWidget extends RgthreeBaseWidget {
    constructor(name = "PowerLoadVideoTopRow") {
        super(name);
        this.type = "custom";
        this.options = { serialize: false };
        this.value = {};
        this.haveMouseMovedValue = false;
        this.refreshButtonMouseDown = false;

        // Default values
        this.fpsValue = 24;
        this.sizeValue = "?x?";
        this.frameCountValue = "?f";

        this.hitAreas = {
            refreshButton: { bounds: [0, 0], onClick: null, onDown: null, onUp: null },
            fpsDec: { bounds: [0, 0], onClick: null },
            fpsVal: { bounds: [0, 0], onClick: null },
            fpsInc: { bounds: [0, 0], onClick: null },
            fpsAny: { bounds: [0, 0], onMove: null },
            sizeInput: { bounds: [0, 0], onClick: null },
            uploadButton: { bounds: [0, 0], onClick: null, onDown: null, onUp: null },
        };
        this.uploadButtonMouseDown = false;
    }

    draw(ctx, node, w, posY, height) {
        const margin = 15;
        const spacing = 10;
        const midY = posY + height * 0.5;

        ctx.save();

        const assignBounds = (name, bounds) => {
            const area = this.hitAreas[name];
            if (!area) return;
            area.bounds = bounds;
            area.onClick = null;
            area.onDown = null;
            area.onUp = null;
            area.onMove = null;
        };

        // Calculate available width (leaving room for upload button on the right)
        const uploadButtonWidth = 100;
        const availableWidth = node.size[0] - margin * 2 - spacing * 3 - uploadButtonWidth;

        // Calculate component widths
        const refreshButtonWidth = availableWidth * 0.35;
        const fpsControlWidth = availableWidth * 0.25;
        const sizeInputWidth = availableWidth - (refreshButtonWidth + fpsControlWidth) - spacing * 2;

        const startX = margin;
        let posX = startX;

        // Draw Refresh button
        drawWidgetButton(
            ctx,
            { size: [refreshButtonWidth, height], pos: [posX, posY] },
            "🔄 Refresh",
            this.refreshButtonMouseDown
        );
        assignBounds("refreshButton", [posX, refreshButtonWidth]);
        posX += refreshButtonWidth + spacing;

        // Draw FPS control
        const fpsLabelWidth = 35;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.fillText("fps:", posX, midY);

        const fpsControlX = posX + fpsLabelWidth;
        const [fpsLeftArrow, fpsText, fpsRightArrow] = drawNumberWidgetPart(ctx, {
            posX: fpsControlX,
            posY,
            height,
            value: this.fpsValue,
            direction: 1,
        });

        assignBounds("fpsDec", fpsLeftArrow);
        assignBounds("fpsVal", fpsText);
        assignBounds("fpsInc", fpsRightArrow);
        assignBounds("fpsAny", [fpsLeftArrow[0], fpsRightArrow[0] + fpsRightArrow[1] - fpsLeftArrow[0]]);
        posX += fpsLabelWidth + drawNumberWidgetPart.WIDTH_TOTAL + spacing;

        // Draw size input (text field style)
        const sizeLabelWidth = 35;
        ctx.fillText("size:", posX, midY);

        const sizeInputX = posX + sizeLabelWidth;
        const sizeTextWidth = sizeInputWidth - sizeLabelWidth;

        // Draw text input background
        ctx.fillStyle = LiteGraph.WIDGET_BGCOLOR;
        ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
        ctx.beginPath();
        ctx.roundRect(sizeInputX, posY, sizeTextWidth, height, [height * 0.5]);
        ctx.fill();
        ctx.stroke();

        // Draw size text
        ctx.textAlign = "left";
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.fillText(this.sizeValue, sizeInputX + 8, midY);

        assignBounds("sizeInput", [sizeInputX, sizeTextWidth]);

        // Draw frame count text (read-only, between size and Upload button)
        ctx.textAlign = "left";
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        posX = sizeInputX + sizeTextWidth + spacing;
        ctx.fillText(this.frameCountValue, posX, midY);

        // Draw Upload button on the right side
        const uploadButtonX = node.size[0] - margin - uploadButtonWidth;
        drawWidgetButton(
            ctx,
            { size: [uploadButtonWidth, height], pos: [uploadButtonX, posY] },
            "📤 Upload",
            this.uploadButtonMouseDown
        );
        assignBounds("uploadButton", [uploadButtonX, uploadButtonWidth]);

        // Setup event handlers
        this.hitAreas.refreshButton.onClick = async () => {
            if (node.timelineWidget) {
                // Stop current playback, reset to frame 1
                node.timelineWidget.stopPlayback();
                node.timelineWidget.value.isPlaying = false;
                node.timelineWidget.value.currentFrame = 1;
                // Apply new FPS as playback rate
                node.timelineWidget.applyPlaybackRate();
            }
            if (node.videoElement) {
                // Reset video to start
                node.videoElement.currentTime = 0;
            }
            // Restart playback at the new FPS
            if (node.timelineWidget) {
                node.timelineWidget.startPlayback(node);
                node.timelineWidget.value.isPlaying = true;
            }
            node.setDirtyCanvas(true, true);
        };
        this.hitAreas.refreshButton.onDown = () => {
            this.refreshButtonMouseDown = true;
            node.setDirtyCanvas(true, false);
        };
        this.hitAreas.refreshButton.onUp = () => {
            this.refreshButtonMouseDown = false;
            node.setDirtyCanvas(true, false);
        };

        // Upload button handlers
        this.hitAreas.uploadButton.onClick = async () => {
            console.log("[PowerLoadVideo] Upload button clicked");
            await this.handleUploadClick(node);
        };
        this.hitAreas.uploadButton.onDown = () => {
            this.uploadButtonMouseDown = true;
            node.setDirtyCanvas(true, false);
        };
        this.hitAreas.uploadButton.onUp = () => {
            this.uploadButtonMouseDown = false;
            node.setDirtyCanvas(true, false);
        };

        // FPS handlers
        this.hitAreas.fpsDec.onClick = () => this.stepFps(node, -1);
        this.hitAreas.fpsInc.onClick = () => this.stepFps(node, 1);
        this.hitAreas.fpsVal.onClick = () => this.promptFps(node);
        this.hitAreas.fpsAny.onMove = (event) => this.dragFps(node, event);

        // Size input handler
        this.hitAreas.sizeInput.onClick = () => this.promptSize(node);

        ctx.restore();
    }

    stepFps(node, step) {
        this.fpsValue = Math.max(1, Math.min(60, this.fpsValue + step));
        if (node.timelineWidget) {
            node.timelineWidget.setFPS(node, this.fpsValue);
        }
        node.setDirtyCanvas(true, true);
    }

    promptFps(node) {
        if (this.haveMouseMovedValue) return;
        const canvas = app.canvas;
        canvas.prompt("FPS", this.fpsValue, (v) => {
            const newValue = Math.max(1, Math.min(60, Number(v)));
            this.fpsValue = isNaN(newValue) ? this.fpsValue : newValue;
            if (node.timelineWidget) {
                node.timelineWidget.setFPS(node, this.fpsValue);
            }
        });
    }

    dragFps(node, event) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            const delta = Math.sign(event.deltaX);
            this.fpsValue = Math.max(1, Math.min(60, this.fpsValue + delta));
            if (node.timelineWidget) {
                node.timelineWidget.setFPS(node, this.fpsValue);
            }
            node.setDirtyCanvas(true, true);
        }
    }

    promptSize(node) {
        if (this.haveMouseMovedValue) return;
        const canvas = app.canvas;
        canvas.prompt("Size (WxH)", this.sizeValue, (v) => {
            this.sizeValue = String(v).trim() || "?x?";
            node.setDirtyCanvas(true, true);
        });
    }

    onMouseUp(event, pos, node) {
        super.onMouseUp(event, pos, node);
        this.haveMouseMovedValue = false;
        this.refreshButtonMouseDown = false;
        this.uploadButtonMouseDown = false;
    }

    /**
     * Handle upload button click - opens file picker and uploads video
     */
    async handleUploadClick(node) {
        // Create a hidden file input element
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'video/*';
        fileInput.style.display = 'none';

        fileInput.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file || !file.type.startsWith('video/')) {
                return;
            }

            // Upload the file via ComfyUI's API
            try {
                const formData = new FormData();
                formData.append('image', file);
                formData.append('type', 'input');

                const resp = await api.fetchApi('/upload/image', { method: 'POST', body: formData });

                if (resp.ok || resp.status === 200) {
                    const data = await resp.json();
                    const uploadedName = data.name || data.filename || file.name;

                    // Store the video filename on the node for execution
                    node.videoFilename = uploadedName;

                    // Update the hidden combo widget value so ComfyUI serializes it to the backend
                    const comboWidget = node.widgets.find(w => w.type === 'combo');
                    if (comboWidget) {
                        comboWidget.value = uploadedName;
                    }
                    // Also update widgets_values so serialization picks it up
                    if (!node.widgets_values || node.widgets_values.length === 0) {
                        node.widgets_values = [uploadedName];
                    } else {
                        node.widgets_values[0] = uploadedName;
                    }

                    // Load the video into the display if loadVideoIntoDisplay is available
                    if (node.loadVideoIntoDisplay && typeof node.loadVideoIntoDisplay === 'function') {
                        node.loadVideoIntoDisplay(uploadedName);
                    }

                    console.log('[PowerLoadVideo] Video uploaded:', uploadedName);
                } else {
                    console.error('[PowerLoadVideo] Upload failed:', resp.status, resp.statusText);
                }
            } catch (err) {
                console.error('[PowerLoadVideo] Upload error:', err);
            }
        };

        document.body.appendChild(fileInput);
        fileInput.click();
        document.body.removeChild(fileInput);
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    }
}

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

        // Native FPS of the loaded video (detected from backend)
        this.nativeFPS = 24;

        // Animation state
        this.animationId = null;
        this.lastUpdateTime = 0;

        // Fix #1 & #2: Initialize hitAreas and mouseDowned to prevent runtime errors
        this.hitAreas = {};
        this.mouseDowned = false;

        // Fix #7: Initialize showTimeline to true by default (timeline should always be visible)
        this.showTimeline = true;

        // Frame bounds markers - start and end frame indicators
        this.startFrameMarker = 1;     // [ marker position (start bound)
        this.endFrameMarker = 1;       // ] marker position (end bound) - defaults to frame 1, updated on video load
        this.markerSize = 16;          // Size of the bracket symbols
        this.draggingStartMarker = false;
        this.draggingEndMarker = false;

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
        // Hit areas for frame bound markers
        this.hitAreas.startMarker = {
            bounds: [0, 0, 0, 0],
            onClick: null,
            onMove: null
        };
        this.hitAreas.endMarker = {
            bounds: [0, 0, 0, 0],
            onClick: null,
            onMove: null
        };

    }

    /**
     * Ensure value is properly initialized as an object
     */
    ensureValueInitialized() {
        if (typeof this.value !== 'object' || this.value === null || Array.isArray(this.value)) {
            console.warn('[PowerLoadVideoTimelineWidget] Value was corrupted, reinitializing');
            this.value = {
                isPlaying: false,
                currentFrame: 1,
                totalFrames: 1,
                fps: 24
            };
        }
    }

    /**
     * Update the total frame count for this node's timeline
     */
    setTotalFrames(node, totalFrames) {
        this.ensureValueInitialized();
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
        this.ensureValueInitialized();
        if (fps && fps > 0) {
            this.value.fps = fps;
            // Apply playback rate to video element
            this.applyPlaybackRate();
        }
    }

    /**
     * Set the native FPS of the loaded video
     */
    setNativeFPS(node, fps) {
        if (fps && fps > 0) {
            this.nativeFPS = fps;
            // Recalculate total frames if we have duration
            if (this.videoElement && this.videoElement.duration && isFinite(this.videoElement.duration)) {
                const totalFrames = Math.round(this.videoElement.duration * this.nativeFPS);
                this.setTotalFrames(node, totalFrames);
            }
            // Re-apply playback rate with new native FPS
            this.applyPlaybackRate();
        }
    }

    /**
     * Apply playback rate based on user FPS vs native FPS
     */
    applyPlaybackRate() {
        if (this.videoElement) {
            const rate = this.value.fps / this.nativeFPS;
            this.videoElement.playbackRate = rate;
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
        // Ensure value is properly initialized (defensive against serialization issues)
        this.ensureValueInitialized();

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

        // === DRAW FRAME BOUND MARKERS [ and ] ===
        // Red bracket symbols that mark start/end bounds on the timeline
        const markerFont = `${this.markerSize}px monospace`;
        ctx.font = markerFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Calculate positions for markers based on frame numbers
        const getMarkerX = (frameNum) => {
            if (!frameNum || frameNum < 1) return timelineX;
            const progress = Math.max(0, Math.min((frameNum - 1) / (Math.max(1, sliderSteps - 1)), 1));
            return timelineX + progress * timelineWidth;
        };

        // Draw start marker [ in red
        if (this.startFrameMarker >= 1) {
            const startX = getMarkerX(this.startFrameMarker);
            ctx.fillStyle = '#ff0000'; // Red color for markers
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1;

            // Draw bracket with slight shadow/outline for visibility
            ctx.save();
            ctx.translate(startX, timelineMidY);
            ctx.fillText('[', 0, 0);
            ctx.restore();
        }

        // Draw end marker ] in red (only if set)
        if (this.endFrameMarker !== null && this.endFrameMarker >= 1) {
            const endX = getMarkerX(this.endFrameMarker);
            ctx.fillStyle = '#ff0000'; // Red color for markers
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1;

            // Draw bracket with slight shadow/outline for visibility
            ctx.save();
            ctx.translate(endX, timelineMidY);
            ctx.fillText(']', 0, 0);
            ctx.restore();
        }

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

        // Hit areas for frame bound markers [ and ]
        const markerHitRadius = this.markerSize / 2;

        // Start marker hit area
        if (this.startFrameMarker >= 1) {
            const startX = getMarkerX(this.startFrameMarker);
            this.hitAreas.startMarker.bounds = [
                startX - markerHitRadius,
                timelineMidY - markerHitRadius,
                markerHitRadius * 2,
                markerHitRadius * 2
            ];
            // Use onDown for immediate response on pointerdown (before drag starts)
            if (!this.hitAreas.startMarker.onDown) {
                this.hitAreas.startMarker.onDown = (e, pos, n) => this.onMarkerClick('start', e, pos, n);
            }
            if (!this.hitAreas.startMarker.onMove) {
                this.hitAreas.startMarker.onMove = (e, pos, n) => this.onMarkerDrag('start', e, pos, n);
            }
        }

        // End marker hit area
        if (this.endFrameMarker !== null && this.endFrameMarker >= 1) {
            const endX = getMarkerX(this.endFrameMarker);
            this.hitAreas.endMarker.bounds = [
                endX - markerHitRadius,
                timelineMidY - markerHitRadius,
                markerHitRadius * 2,
                markerHitRadius * 2
            ];
            // Use onDown for immediate response on pointerdown (before drag starts)
            if (!this.hitAreas.endMarker.onDown) {
                this.hitAreas.endMarker.onDown = (e, pos, n) => this.onMarkerClick('end', e, pos, n);
            }
            if (!this.hitAreas.endMarker.onMove) {
                this.hitAreas.endMarker.onMove = (e, pos, n) => this.onMarkerDrag('end', e, pos, n);
            }
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
            // Only start hover audio if mouse is currently over the video
            if (node._isHovering && node._startHoverAudio) node._startHoverAudio();
        } else {
            this.stopPlayback();
            // Stop hover audio
            if (node._stopHoverAudio) node._stopHoverAudio();
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
        const nativeFPS = this.nativeFPS || 24;

        const animate = () => {
            const now = performance.now();

            if (now - this.lastUpdateTime >= frameInterval) {
                // Check if we're about to loop
                const wasAtEnd = this.value.currentFrame >= this.value.totalFrames;

                this.value.currentFrame++;

                // Loop at end
                if (this.value.currentFrame > this.value.totalFrames) {
                    this.value.currentFrame = 1;
                    // Restart hover audio on loop if still hovering and playing
                    if (wasAtEnd && node._isHovering && node._restartHoverAudioOnLoop) {
                        node._restartHoverAudioOnLoop();
                    }
                }

                // Update video element time using native FPS for correct mapping
                if (this.videoElement && this.videoElement.duration) {
                    const newTime = (this.value.currentFrame - 1) / nativeFPS;
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
        this.ensureValueInitialized();
        const timelineX = this.hitAreas.timeline.bounds[0];
        const timelineWidth = this.hitAreas.timeline.bounds[2];

        const relativeX = Math.max(0, Math.min(timelineWidth, pos[0] - timelineX));
        const ratio = timelineWidth > 0 ? relativeX / timelineWidth : 0;

        const newFrame = Math.max(1, Math.round(ratio * (this.value.totalFrames - 1)) + 1);
        this.value.currentFrame = newFrame;

        // Update video element time if available
        if (this.videoElement && this.videoElement.duration) {
            const nativeFPS = this.nativeFPS || 24;
            const newTime = (newFrame - 1) / nativeFPS;
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
        this.ensureValueInitialized();
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

            // Update video element time using native FPS
            if (this.videoElement && this.videoElement.duration) {
                const nativeFPS = this.nativeFPS || 24;
                const newTime = (newFrame - 1) / nativeFPS;
                this.videoElement.currentTime = Math.min(newTime, this.videoElement.duration);
            }

            node.setDirtyCanvas(true, true);
        }
    }

    /**
     * Calculate distance from click position to a marker's center
     * Used to determine which marker was actually clicked when they are close together
     */
    getDistanceToMarkerCenter(pos, markerFrame) {
        const timelineX = this.hitAreas.timeline.bounds[0];
        const timelineWidth = this.hitAreas.timeline.bounds[2];
        const sliderSteps = this.value.totalFrames || 1;

        // Calculate the X position of this marker
        const progress = Math.max(0, Math.min((markerFrame - 1) / (Math.max(1, sliderSteps - 1)), 1));
        const markerX = timelineX + progress * timelineWidth;

        // Get timeline mid Y from the hit area bounds
        const timelineY = this.hitAreas.timeline.bounds[1];
        const timelineHeight = this.hitAreas.timeline.bounds[3];
        const timelineMidY = timelineY + timelineHeight / 2;

        // Calculate Euclidean distance
        const dx = pos[0] - markerX;
        const dy = pos[1] - timelineMidY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * Handle click on frame bound markers [ or ]
     * Start dragging if Shift key is held, otherwise just select the marker
     * When markers are close together, only the closest one to the click position will be dragged
     */
    onMarkerClick(markerType, event, pos, node) {
        // Check if Shift key is held down for dragging
        const shiftHeld = event.shiftKey;

        if (shiftHeld) {
            // When both markers exist and are close together, determine which one was actually clicked
            // by calculating distance to each marker's center
            if (this.startFrameMarker >= 1 && this.endFrameMarker !== null && this.endFrameMarker >= 1) {
                const distToStart = this.getDistanceToMarkerCenter(pos, this.startFrameMarker);
                const distToEnd = this.getDistanceToMarkerCenter(pos, this.endFrameMarker);

                // Only start dragging if this marker is closer to the click than the other
                if (markerType === 'start') {
                    if (distToStart <= distToEnd) {
                        this.draggingStartMarker = true;
                    }
                } else {
                    if (distToEnd < distToStart) {
                        this.draggingEndMarker = true;
                    }
                }
            } else {
                // Only one marker exists, drag it directly
                if (markerType === 'start') {
                    this.draggingStartMarker = true;
                } else {
                    this.draggingEndMarker = true;
                }
            }
        }
        // Without Shift, we could add other interactions later (like snapping playback head to marker)
    }

    /**
     * Handle drag on frame bound markers [ or ]
     * Only allows dragging when Shift key is held down AND the specific marker was clicked
     * Markers are constrained not to cross each other
     */
    onMarkerDrag(markerType, event, pos, node) {
        // Check if Shift key is held down - required for dragging markers
        const shiftHeld = event.shiftKey;

        if (!shiftHeld) {
            return; // Don't allow dragging without Shift
        }

        // Only drag the specific marker that was clicked (not both when they're close)
        if (markerType === 'start' && !this.draggingStartMarker) {
            return;
        }
        if (markerType === 'end' && !this.draggingEndMarker) {
            return;
        }

        const timelineX = this.hitAreas.timeline.bounds[0];
        const timelineWidth = this.hitAreas.timeline.bounds[2];
        const totalFrames = this.value.totalFrames || 1;

        // Calculate frame from absolute position
        const relativeX = Math.max(0, Math.min(timelineWidth, pos[0] - timelineX));
        const ratio = timelineWidth > 0 ? relativeX / timelineWidth : 0;
        let newFrame = Math.max(1, Math.round(ratio * (totalFrames - 1)) + 1);

        // Apply constraints based on marker type
        if (markerType === 'start') {
            // Start marker [ cannot go past end marker ]
            if (this.endFrameMarker !== null && this.endFrameMarker >= 1) {
                newFrame = Math.min(newFrame, this.endFrameMarker);
            }

            if (newFrame !== this.startFrameMarker) {
                this.startFrameMarker = newFrame;
                // Sync to hidden widget so backend receives the value
                const w = node.widgets.find(w => w.name === 'start_frame');
                if (w) w.value = newFrame;
                this.updateFrameCountDisplay(node);
                node.setDirtyCanvas(true, true);
            }
        } else if (markerType === 'end') {
            // End marker ] cannot go past start marker [
            if (this.startFrameMarker >= 1) {
                newFrame = Math.max(newFrame, this.startFrameMarker);
            }

            if (newFrame !== this.endFrameMarker) {
                this.endFrameMarker = newFrame;
                // Sync to hidden widget so backend receives the value
                const w = node.widgets.find(w => w.name === 'end_frame');
                if (w) w.value = newFrame;
                this.updateFrameCountDisplay(node);
                node.setDirtyCanvas(true, true);
            }
        }
    }

    /**
     * Handle mouse up - reset dragging flags for markers
     */
    onMouseUp(event, pos, node) {
        // Reset marker dragging flags when mouse is released
        this.draggingStartMarker = false;
        this.draggingEndMarker = false;
    }

    /**
     * Set the start frame marker position [
     */
    setStartFrame(frame, node) {
        this.startFrameMarker = Math.max(1, frame || 1);
        // Sync to hidden widget so backend receives the value
        if (node) {
            const w = node.widgets.find(w => w.name === 'start_frame');
            if (w) w.value = this.startFrameMarker;
        }
        this.updateFrameCountDisplay(node);
    }

    /**
     * Set the end frame marker position ]
     */
    setEndFrame(frame, node) {
        this.endFrameMarker = frame !== null && frame !== undefined ? Math.max(1, frame) : null;
        // Sync to hidden widget so backend receives the value
        if (node && this.endFrameMarker !== null) {
            const w = node.widgets.find(w => w.name === 'end_frame');
            if (w) w.value = this.endFrameMarker;
        }
        this.updateFrameCountDisplay(node);
    }

    /**
     * Update the top row frame count display (?f -> "123f")
     */
    updateFrameCountDisplay(node) {
        if (node && node.topRowWidget) {
            const start = this.startFrameMarker || 1;
            const end = this.endFrameMarker || this.value.totalFrames || 1;
            const count = Math.max(0, end - start + 1);
            node.topRowWidget.frameCountValue = count + "f";
        }
    }

    /**
     * Get current start frame marker value
     */
    getStartFrame() {
        return this.startFrameMarker;
    }

    /**
     * Get current end frame marker value
     */
    getEndFrame() {
        return this.endFrameMarker;
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

                // Enforce minimum width
                if (this.size[0] < 400) {
                    this.size[0] = 400;
                }

                // Enforce minimum width on resize
                this.onResize = function(size) {
                    if (size[0] < 400) {
                        size[0] = 400;
                    }
                };

                // Fix #5: Ensure widgets array exists before manipulation
                this.widgets = this.widgets || [];
                // Remove built-in widgets except 'video' - we need to keep the video combo widget
                // in the widgets array so ComfyUI serializes its value to the backend on execute.
                // It gets hidden visually below (computeSize = [0,0]).
                const widgetsToRemove = ['timeline', 'frame_rate', 'looping'];
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
                    height: 380px;
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

                            // Update the hidden combo widget value so ComfyUI serializes it to the backend
                            const comboWidget = this.widgets.find(w => w.type === 'combo');
                            if (comboWidget) {
                                comboWidget.value = uploadedName;
                            }
                            // Also update widgets_values so serialization picks it up
                            if (!this.widgets_values || this.widgets_values.length === 0) {
                                this.widgets_values = [uploadedName];
                            } else {
                                this.widgets_values[0] = uploadedName;
                            }

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

                // Audio playback on hover - uses Web Audio API independently from video element
                // so it doesn't interfere with timeline's manual frame-by-frame seeking
                let audioCtx = null;
                let audioBuffer = null;
                let audioSource = null;
                let audioLoadPromise = null;

                const loadAudio = (videoFilename) => {
                    // Fetch audio from the same video file via /view endpoint
                    const audioUrl = `/view?filename=${encodeURIComponent(videoFilename)}&type=input`;
                    audioLoadPromise = fetch(audioUrl)
                        .then(r => r.arrayBuffer())
                        .then(data => {
                            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                            return audioCtx.decodeAudioData(data);
                        })
                        .then(buf => { audioBuffer = buf; })
                        .catch(() => { audioBuffer = null; });
                };

                const startAudio = () => {
                    if (!audioBuffer || !audioCtx) return;
                    // Resume AudioContext if suspended (browser autoplay policy)
                    if (audioCtx.state === 'suspended') audioCtx.resume();
                    stopAudio();
                    audioSource = audioCtx.createBufferSource();
                    audioSource.buffer = audioBuffer;
                    audioSource.connect(audioCtx.destination);

                    // Sync to current timeline frame position
                    const nativeFPS = this.timelineWidget?.nativeFPS || 24;
                    const playbackFPS = this.timelineWidget?.value?.fps || nativeFPS;
                    const currentFrame = this.timelineWidget?.value?.currentFrame || 1;
                    const startOffset = (currentFrame - 1) / nativeFPS;
                    // Clamp to marker range end
                    const endMarker = this.timelineWidget?.endFrameMarker;
                    const totalFrames = this.timelineWidget?.value?.totalFrames || audioBuffer.duration * nativeFPS;
                    const endMarkerFrame = endMarker || totalFrames;
                    const endTime = (endMarkerFrame - 1) / nativeFPS;
                    const remaining = Math.max(0, endTime - startOffset);

                    // Adjust playback rate to sync audio speed with video FPS
                    const playbackRate = playbackFPS / nativeFPS;
                    audioSource.playbackRate.value = playbackRate;

                    audioSource.start(0, startOffset, remaining);
                    audioSource.onended = () => { audioSource = null; };
                };

                const stopAudio = () => {
                    if (audioSource) {
                        try { audioSource.stop(); } catch(e) {}
                        audioSource = null;
                    }
                };

                // Track hover state on the node to ensure audio only plays when BOTH conditions are true
                videoContainer.addEventListener('mouseenter', () => {
                    this._isHovering = true;
                    // Only start audio if currently playing AND now hovering
                    if (this.timelineWidget?.value?.isPlaying && this._startHoverAudio) this._startHoverAudio();
                });
                videoContainer.addEventListener('mouseleave', () => {
                    this._isHovering = false;
                    stopAudio();
                });

                // Keyboard shortcut: Shift+Spacebar to toggle playback
                this.handlePlayPauseShortcut = (e) => {
                    if ((e.key === ' ' || e.code === 'Space') && e.shiftKey) {
                        if (!e.target.matches('input, textarea')) {
                            e.preventDefault();
                            e.stopPropagation();
                            this.timelineWidget?.togglePlay(this);
                        }
                    }
                };
                document.addEventListener('keydown', this.handlePlayPauseShortcut, true);

                // Expose loadAudio so it can be called when a new video is loaded
                this._loadHoverAudio = loadAudio;
                this._stopHoverAudio = stopAudio;
                this._startHoverAudio = () => {
                    if (!this.timelineWidget?.value?.isPlaying) return;  // Read fresh state, not stale closure
                    if (audioLoadPromise) {
                        audioLoadPromise.then(() => { if (this.timelineWidget?.value?.isPlaying) startAudio(); });
                    } else if (audioBuffer) {
                        startAudio();
                    }
                };
                // Restart audio from beginning when video loops
                this._restartHoverAudioOnLoop = () => {
                    if (!this.timelineWidget?.value?.isPlaying) return;
                    if (audioLoadPromise) {
                        audioLoadPromise.then(() => { if (this.timelineWidget?.value?.isPlaying) startAudio(); });
                    } else if (audioBuffer) {
                        startAudio();
                    }
                };

                // Store handlers for cleanup on node removal
                this.dragHandlers = { handleDragOver, handleDragLeave, handleDrop };

                // === CREATE WIDGETS IN ORDER: Top Row -> Video Display -> Timeline ===

                // 1. Create and add the top row widget FIRST (appears above video)
                if (!this.topRowWidget) {
                    this.topRowWidget = new PowerLoadVideoTopRowWidget();
                    this.addCustomWidget(this.topRowWidget);
                }

                // 2. Add video display as DOM widget
                this.videoDisplayWidget = this.addDOMWidget(nodeData.name, 'VideoDisplay', videoContainer, {
                    serialize: false,
                    hideOnZoom: false
                });

                // Set computeSize for proper layout
                this.videoDisplayWidget.computeSize = function(width) {
                    return [width, 380];
                };

                // 3. Create and add the timeline widget LAST (appears below video)
                if (!this.timelineWidget) {
                    this.timelineWidget = new PowerLoadVideoTimelineWidget();
                    this.addCustomWidget(this.timelineWidget);
                }

                // Set the video element reference on the timeline widget
                this.timelineWidget.setVideoElement(videoElement);

                // === HIDE THE COMBO WIDGET ("choose file to upload") AND frame range widgets ===
                setTimeout(() => {
                    const comboWidget = this.widgets.find(w => w.type === 'combo');
                    if (comboWidget) {
                        comboWidget.computeSize = () => [0, 0]; // Make it zero height
                        comboWidget.hidden = true; // Mark as hidden
                    }
                    // Hide start_frame and end_frame number widgets (created from Python INPUT_TYPES)
                    for (const name of ['start_frame', 'end_frame']) {
                        const w = this.widgets.find(w => w.name === name);
                        if (w) {
                            w.computeSize = () => [0, 0];
                            w.hidden = true;
                        }
                    }
                }, 0);

                // Function to load video into custom display
                const loadVideoIntoDisplay = (videoFilename) => {
                    if (!videoFilename || String(videoElement.src).includes(videoFilename)) {
                        return;
                    }

                    // Preload audio for hover playback
                    if (this._loadHoverAudio) this._loadHoverAudio(videoFilename);

                    // Hide placeholder text
                    if (placeholderText) {
                        placeholderText.style.display = 'none';
                    }

                    // Update video source - use type=input for input directory files (ComfyUI's convention)
                    const videoSrc = `/view?filename=${encodeURIComponent(videoFilename)}&type=input`;
                    videoElement.src = videoSrc;

                    // Set up one-time listeners for this load
                    const onMetadataLoaded = async () => {

                        // Update size display immediately
                        if (this.topRowWidget) {
                            this.topRowWidget.sizeValue = `${videoElement.videoWidth}x${videoElement.videoHeight}`;
                        }

                        // Fetch native FPS from server
                        try {
                            const resp = await api.fetchApi(`/wanvideowrapper_qq/video_metadata?filename=${encodeURIComponent(videoFilename)}`);
                            if (resp.ok) {
                                const meta = await resp.json();
                                if (meta.success && meta.fps) {
                                    const detectedFPS = Math.round(meta.fps);
                                    // Set native FPS on timeline
                                    this.timelineWidget.nativeFPS = meta.fps;
                                    // Update UI spinner to match native FPS
                                    this.topRowWidget.fpsValue = detectedFPS;
                                    this.timelineWidget.setFPS(this, detectedFPS);

                                    // Use accurate frame count from server
                                    const totalFrames = meta.frame_count > 0 ? meta.frame_count : Math.round(videoElement.duration * meta.fps);
                                    this.timelineWidget.setTotalFrames(this, totalFrames);
                                    this.timelineWidget.setStartFrame(1, this);
                                    this.timelineWidget.setEndFrame(totalFrames, this);
                                    this.timelineWidget.applyPlaybackRate();
                                    this.setDirtyCanvas(true, true);
                                    return;
                                }
                            }
                        } catch (e) {
                            console.warn('[PowerLoadVideo] Could not fetch video metadata, estimating:', e);
                        }

                        // Fallback: estimate with current FPS
                        const nativeFPS = this.timelineWidget.nativeFPS || this.timelineWidget.value.fps || 24;
                        const totalFrames = Math.round(videoElement.duration * nativeFPS);
                        this.timelineWidget.setTotalFrames(this, totalFrames);
                        this.timelineWidget.setStartFrame(1, this);
                        this.timelineWidget.setEndFrame(totalFrames, this);
                        this.timelineWidget.applyPlaybackRate();

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

                    // Get the video filename from various sources
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

                    // Or try to get from node.videoFilename (set by Upload button)
                    if (!videoFilename) {
                        videoFilename = this.videoFilename;
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

                    // Recalculate total frames with accurate native FPS + duration
                    if (this.timelineWidget && this.videoElement && this.videoElement.duration && isFinite(this.videoElement.duration)) {
                        const accurateFrames = Math.round(this.videoElement.duration * this.timelineWidget.nativeFPS);
                        if (accurateFrames > 0) {
                            this.timelineWidget.setTotalFrames(this, accurateFrames);
                            this.timelineWidget.setStartFrame(1, this);
                            this.timelineWidget.setEndFrame(accurateFrames, this);
                        }
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
    }
});

export { PowerLoadVideoTimelineWidget };
