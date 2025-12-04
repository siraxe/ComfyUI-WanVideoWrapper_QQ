/**
 * Video Background Module for PowerSplineEditor
 *
 * Handles video loading, positioning, and timeline synchronization
 * for background video playback in spline editor widget.
 */

/**
 * Initialize video background system for editor
 * @param {Object} editor - The SplineEditor2 instance
 */
export function initializeVideoBackground(editor) {
    // Create HTML5 video element
    const videoElement = document.createElement('video');
    videoElement.id = `spline-editor-video-${editor.node.id}`;
    videoElement.style.position = 'absolute';
    videoElement.style.pointerEvents = 'none';  // Don't intercept mouse events
    videoElement.style.userSelect = 'none';     // Prevent selection
    videoElement.style.touchAction = 'none';    // Prevent touch events
    videoElement.setAttribute('pointer-events', 'none');  // SVG-style attribute as backup
    videoElement.style.zIndex = '-1';  // BEHIND everything - negative z-index
    videoElement.style.display = 'none';  // Hidden initially
    videoElement.muted = true;  // Always muted
    videoElement.preload = 'auto';  // Preload for smooth scrubbing
    videoElement.playsInline = true;  // Required for iOS

    // Additional properties to ensure it never blocks events
    videoElement.style.cursor = 'default';
    videoElement.tabIndex = -1;  // Not focusable
    videoElement.setAttribute('aria-hidden', 'true');  // Screen reader hidden

    // Store reference in editor
    editor.videoElement = videoElement;
    editor.videoMetadata = null;
    editor.videoReady = false;

    // Insert video element into parentEl container (before canvas element)
    try {
        const canvasElement = editor.vis?.canvas?.();
        if (!canvasElement) {
            return;
        }

        // Get the actual parent div (canvas() returns a span)
        const parentEl = canvasElement.parentElement;
        if (parentEl) {
            // Insert video as first child (before all other children including canvas)
            // This ensures canvas is always on top in DOM order
            if (parentEl.firstChild) {
                parentEl.insertBefore(videoElement, parentEl.firstChild);
            } else {
                parentEl.appendChild(videoElement);
            }
        }
    } catch (e) {
        // Silently handle insertion errors
    }

    // Set up event listeners
    videoElement.addEventListener('loadedmetadata', () => {
        editor.videoReady = true;
        // Recenter video when metadata is loaded
        if (editor.videoMetadata) {
            recenterBackgroundVideo(editor);
        }
    });

    videoElement.addEventListener('canplay', () => {
        editor.videoReady = true;
    });

    videoElement.addEventListener('error', (e) => {
        editor.videoReady = false;
    });
}

/**
 * Load background video from metadata
 * @param {Object} editor - The SplineEditor2 instance
 * @param {Object} videoMetadata - Video metadata from backend
 */
export function loadBackgroundVideo(editor, videoMetadata) {
    if (!videoMetadata || !videoMetadata.path) {
        clearBackgroundVideo(editor);
        return;
    }

    if (!editor.videoElement) {
        return;
    }

    // Clear any existing video
    clearBackgroundVideo(editor);

    // Store metadata
    editor.videoMetadata = videoMetadata;
    editor.videoReady = false;

    // Construct video path - use direct extension path like reference images
    // Add cache-busting timestamp to force reload when video changes
    const timestamp = Date.now();

    // Remove duplicate power_spline_editor from path if it exists
    let cleanPath = videoMetadata.path;
    if (cleanPath.startsWith('power_spline_editor/')) {
        cleanPath = cleanPath.replace('power_spline_editor/', '');
    }

    const baseVideoPath = new URL(`../${cleanPath}`, import.meta.url).href;
    const videoPath = `${baseVideoPath}?t=${timestamp}`;

    // Ensure video element is in DOM and positioned correctly
    try {
        const canvasElement = editor.vis?.canvas?.();

        if (canvasElement) {
            const parentEl = canvasElement.parentElement;
            if (parentEl && !editor.videoElement.parentElement) {
                // Only insert if not already in DOM
                if (parentEl.firstChild) {
                    parentEl.insertBefore(editor.videoElement, parentEl.firstChild);
                } else {
                    parentEl.appendChild(editor.videoElement);
                }
            } else if (parentEl && editor.videoElement.parentElement === parentEl) {
                // Already in correct parent - ensure it's first child for proper z-order
                if (parentEl.firstChild !== editor.videoElement) {
                    parentEl.insertBefore(editor.videoElement, parentEl.firstChild);
                }
            }
        }
    } catch (e) {
        // Silently handle insertion errors during load
    }

    // Add event listener to set scale before updating layers
    const onMetadataLoaded = () => {
        // Set the proper scale and offset
        recenterBackgroundVideo(editor);

        // Reload layer coordinates with correct scale
        if (editor.node && editor.updateLayerCoordinatesAfterScaleChange) {
            editor.updateLayerCoordinatesAfterScaleChange();
        } else if (editor.refreshActiveLayerCoordinates) {
            editor.refreshActiveLayerCoordinates();
        }

        // Remove listener to avoid duplicate calls
        editor.videoElement.removeEventListener('loadedmetadata', onMetadataLoaded);
    };

    // Attach listener BEFORE setting src
    editor.videoElement.addEventListener('loadedmetadata', onMetadataLoaded);

    // Load video
    editor.videoElement.src = videoPath;
    editor.videoElement.load();

    // Show video element
    editor.videoElement.style.display = 'block';

    // Apply initial brightness from bg_opacity widget
    if (editor.node && editor.node.widgets) {
        const bgOpacityWidget = editor.node.widgets.find(w => w.name === 'bg_opacity');
        if (bgOpacityWidget) {
            const opacity = bgOpacityWidget.value || 1.0;
            const brightnessPercent = Math.max(0, Math.min(100, opacity * 100));
            editor.videoElement.style.filter = `brightness(${brightnessPercent}%)`;
        }
    }

    // Ensure video element never blocks pointer events
    editor.videoElement.style.pointerEvents = 'none';
    editor.videoElement.setAttribute('pointer-events', 'none');

    // Hide static background image if it exists
    if (editor.backgroundImage) {
        editor.backgroundImage.visible(false);
    }

    // Clear imgData from node when loading video
    if (editor.node) {
        editor.node.imgData = null;
    }

    // Make canvas background transparent so video shows through
    // BUT keep it clickable by using a nearly-transparent fill
    if (editor.vis) {
        editor.vis.fillStyle('rgba(0, 0, 0, 0.01)'); // Nearly transparent but still captures events
        editor.vis.render();
    }

    // Ensure the SVG canvas can receive pointer events (for scrubbing and interaction)
    const svgElement = editor.vis?.canvas?.();
    if (svgElement) {
        // Ensure the SVG itself can receive events
        svgElement.style.pointerEvents = 'all';

        // Find the background rect and make sure it can capture events
        const rects = svgElement.querySelectorAll('rect');
        rects.forEach(rect => {
            // Enable pointer events on SVG rects so canvas interactions work
            rect.style.pointerEvents = 'all';
            // Add a nearly-invisible fill if rect has no fill (needed for event capture)
            if (!rect.getAttribute('fill') || rect.getAttribute('fill') === 'none') {
                rect.setAttribute('fill', 'rgba(0,0,0,0.01)');
            }
        });
    }

    // Trigger render to update display
    if (editor.layerRenderer) {
        editor.layerRenderer.render();
    }
}

/**
 * Scale and position video to fit canvas with margin
 * Similar to recenterBackgroundImage()
 * @param {Object} editor - The SplineEditor2 instance
 */
export function recenterBackgroundVideo(editor) {
    if (!editor.videoElement || !editor.videoMetadata) {
        return;
    }

    const videoWidth = editor.videoMetadata.width;
    const videoHeight = editor.videoMetadata.height;
    const canvasWidth = editor.width;
    const canvasHeight = editor.height;

    // Calculate scale to fit video within canvas minus margin
    const margin = 80;
    const availableWidth = canvasWidth - margin * 2;
    const availableHeight = canvasHeight - margin * 2;

    const scaleX = availableWidth / videoWidth;
    const scaleY = availableHeight / videoHeight;
    const scale = Math.min(scaleX, scaleY, 1.0);  // Don't upscale

    // Calculate dimensions
    const newWidth = videoWidth * scale;
    const newHeight = videoHeight * scale;

    // Calculate offsets to center
    const offsetX = (canvasWidth - newWidth) / 2;
    const offsetY = (canvasHeight - newHeight) / 2;

    // Store for coordinate transformations (matching image background)
    editor.videoScale = scale;
    editor.scale = scale;  // Ensure coordinate system consistency
    editor.videoOffsetX = offsetX;
    editor.offsetX = offsetX;  // Ensure coordinate system consistency
    editor.videoOffsetY = offsetY;
    editor.offsetY = offsetY;  // Ensure coordinate system consistency
    editor.originalVideoWidth = videoWidth;
    editor.originalImageWidth = videoWidth;  // Keep consistency
    editor.originalVideoHeight = videoHeight;
    editor.originalImageHeight = videoHeight;  // Keep consistency

    // Apply positioning to video element
    // Video and canvas are siblings in parentEl - use offsets directly
    editor.videoElement.style.left = `${offsetX}px`;
    editor.videoElement.style.top = `${offsetY}px`;
    editor.videoElement.style.width = `${newWidth}px`;
    editor.videoElement.style.height = `${newHeight}px`;
}

/**
 * Sync video to specific timeline frame
 * @param {Object} editor - The SplineEditor2 instance
 * @param {number} frame - Timeline frame (1-based, 1 to BOX_TIMELINE_MAX_POINTS)
 */
export function syncVideoToFrame(editor, frame) {
    if (!editor.videoElement || !editor.videoMetadata || !editor.videoReady) {
        return;
    }

    // Map frame to video time
    const time = frameToTime(frame, editor.videoMetadata.num_frames, editor.videoMetadata.duration);

    // Clamp time to valid range
    const clampedTime = Math.max(0, Math.min(time, editor.videoMetadata.duration));

    // Set video current time
    if (editor.videoElement.currentTime !== clampedTime) {
        editor.videoElement.currentTime = clampedTime;
    }

    // Ensure video is paused (we're scrubbing, not playing)
    if (!editor.videoElement.paused) {
        editor.videoElement.pause();
    }
}

/**
 * Map timeline frame to video time
 * @param {number} frame - Timeline frame (1-based)
 * @param {number} numFrames - Total number of frames in video
 * @param {number} duration - Video duration in seconds
 * @returns {number} Time in seconds
 */
function frameToTime(frame, numFrames, duration) {
    // frame is 1-based (1 to numFrames)
    // Normalize to 0-1 range
    const ratio = (frame - 1) / Math.max(1, numFrames - 1);

    // Calculate time
    return ratio * duration;
}

/**
 * Clear background video
 * @param {Object} editor - The SplineEditor2 instance
 */
export function clearBackgroundVideo(editor) {
    if (!editor.videoElement) {
        return;
    }

    // Stop and clear video
    editor.videoElement.pause();
    editor.videoElement.src = '';
    editor.videoElement.load();
    editor.videoElement.style.display = 'none';
    editor.videoElement.style.filter = ''; // Clear brightness filter

    // Clear metadata
    editor.videoMetadata = null;
    editor.videoReady = false;

    // Clear positioning data
    editor.videoScale = null;
    editor.scale = null;
    editor.videoOffsetX = null;
    editor.offsetX = null;
    editor.videoOffsetY = null;
    editor.offsetY = null;
    editor.originalVideoWidth = null;
    editor.originalVideoHeight = null;

    // Restore canvas background color
    if (editor.vis) {
        editor.vis.fillStyle('#222'); // Restore original dark gray
        editor.vis.render();
    }

    // Show static background image if it exists
    if (editor.backgroundImage) {
        editor.backgroundImage.visible(true);
    }

    // Trigger refresh of background image if it exists on node
    if (editor.node && editor.node.imgData) {
        editor.node.editor?.refreshBackgroundImage?.();
    }
}

/**
 * Check if video is loaded
 * @param {Object} editor - The SplineEditor2 instance
 * @returns {boolean} True if video is loaded and ready
 */
export function hasBackgroundVideo(editor) {
    return editor.videoElement && editor.videoMetadata && editor.videoReady;
}

/**
 * Update video position when canvas is resized or repositioned
 * @param {Object} editor - The SplineEditor2 instance
 */
export function updateVideoPosition(editor) {
    if (hasBackgroundVideo(editor)) {
        recenterBackgroundVideo(editor);
    }
}

/**
 * Hook into editor dimension changes to update video positioning
 * @param {Object} editor - The SplineEditor2 instance
 */
export function onEditorDimensionsChanged(editor) {
    if (hasBackgroundVideo(editor)) {
        recenterBackgroundVideo(editor);
    }
}

/**
 * Get video scale for layer renderer
 * @param {Object} editor - The SplineEditor2 instance
 * @returns {number} Video scale factor
 */
export function getVideoScale(editor) {
    if (
        editor.videoMetadata &&
        editor.videoScale !== undefined &&
        editor.videoScale !== null
    ) {
        return editor.videoScale;
    }
    return 1; // Default to no scaling
}

/**
 * Update video brightness based on opacity value
 * @param {Object} editor - The SplineEditor2 instance
 * @param {number} opacity - Opacity value (0.0 = black, 1.0 = full brightness)
 */
export function updateVideoBrightness(editor, opacity) {
    if (!editor.videoElement) {
        return;
    }

    // Apply brightness filter to video element
    // opacity 1.0 = brightness(100%), opacity 0.0 = brightness(0%)
    const brightnessPercent = Math.max(0, Math.min(100, opacity * 100));
    editor.videoElement.style.filter = `brightness(${brightnessPercent}%)`;

    // Ensure pointer-events remains none (defensive programming)
    editor.videoElement.style.pointerEvents = 'none';
    editor.videoElement.setAttribute('pointer-events', 'none');
}