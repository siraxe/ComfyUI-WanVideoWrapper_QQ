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
    videoElement.style.zIndex = '1';  // Behind canvas (canvas is z-index: 2) but above container
    videoElement.style.display = 'none';  // Hidden initially
    videoElement.muted = true;  // Always muted
    videoElement.preload = 'auto';  // Preload for smooth scrubbing
    videoElement.playsInline = true;  // Required for iOS

    // Store reference in editor
    editor.videoElement = videoElement;
    editor.videoMetadata = null;
    editor.videoReady = false;

    // Insert video element into parentEl container (before canvas element)
    try {
        const canvasElement = editor.vis?.canvas?.();
        if (!canvasElement) {
            console.warn('[VideoBackground] Canvas not ready yet');
            return;
        }

        // Get the actual parent div (canvas() returns a span)
        const parentEl = canvasElement.parentElement;
        if (parentEl) {
            parentEl.insertBefore(videoElement, canvasElement);
            console.log('[VideoBackground] Video element inserted into DOM:', {
                parentId: parentEl.id,
                videoId: videoElement.id
            });
        } else {
            console.warn('[VideoBackground] Parent element not found');
        }
    } catch (e) {
        console.error('[VideoBackground] Could not insert video element:', e);
    }

    // Set up event listeners
    videoElement.addEventListener('loadedmetadata', () => {
        console.log('[VideoBackground] Video metadata loaded');
        editor.videoReady = true;
        // Recenter video when metadata is loaded
        if (editor.videoMetadata) {
            recenterBackgroundVideo(editor);
        }
    });

    videoElement.addEventListener('canplay', () => {
        console.log('[VideoBackground] Video can play');
        editor.videoReady = true;
    });

    videoElement.addEventListener('error', (e) => {
        console.error('[VideoBackground] Video error:', e, videoElement.error);
        console.error('[VideoBackground DEBUG] Video element error details:', {
            src: videoElement.src,
            networkState: videoElement.networkState,
            readyState: videoElement.readyState,
            error: videoElement.error
        });
        editor.videoReady = false;
    });

    videoElement.addEventListener('seeked', () => {
        // Seeked event fired when seeking completes
        // Useful for debugging or showing loading states
    });
}

/**
 * Load background video from metadata
 * @param {Object} editor - The SplineEditor2 instance
 * @param {Object} videoMetadata - Video metadata from backend
 */
export function loadBackgroundVideo(editor, videoMetadata) {
    console.log('[VideoBackground DEBUG] loadBackgroundVideo called with metadata:', videoMetadata);
    if (!videoMetadata || !videoMetadata.path) {
        console.error('[VideoBackground] Error: loadBackgroundVideo called with invalid or missing video path.', videoMetadata);
        clearBackgroundVideo(editor);
        return;
    }

    if (!editor.videoElement) {
        console.warn('[VideoBackground] Video element not initialized');
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

    console.log('[VideoBackground DEBUG] Path construction details:', {
        importMetaUrl: import.meta.url,
        originalPath: videoMetadata.path,
        cleanPath: cleanPath,
        finalVideoPath: videoPath
    });

    console.log('[VideoBackground] Loading video:', videoPath, videoMetadata);

    // Ensure video element is in DOM (in case it wasn't inserted during init)
    try {
        const canvasElement = editor.vis?.canvas?.();

        console.log('[VideoBackground DEBUG] DOM elements:', {
            hasCanvas: !!canvasElement,
            videoElementInDOM: !!editor.videoElement.parentElement,
            videoElementId: editor.videoElement.id
        });

        if (canvasElement && !editor.videoElement.parentElement) {
            // Get the actual parent div (canvas() returns a span)
            const parentEl = canvasElement.parentElement;
            if (parentEl) {
                parentEl.insertBefore(editor.videoElement, canvasElement);
                console.log('[VideoBackground] Video element re-inserted into DOM');
            }
        }
    } catch (e) {
        console.error('[VideoBackground] Could not insert video element during load:', e);
    }

    // ✅ ADD EVENT LISTENER TO SET SCALE BEFORE UPDATING LAYERS
    const onMetadataLoaded = () => {
        console.log('[VideoBackground] Metadata loaded, setting scale...');

        // NOW set the proper scale and offset
        recenterBackgroundVideo(editor);

        // ✅ THEN reload layer coordinates with correct scale
        if (editor.node && editor.updateLayerCoordinatesAfterScaleChange) {
            console.log('[VideoBackground] Updating layer coordinates with correct scale');
            editor.updateLayerCoordinatesAfterScaleChange();
        } else if (editor.refreshActiveLayerCoordinates) {
            console.log('[VideoBackground] Refreshing active layer coordinates');
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

    console.log('[VideoBackground DEBUG] Video element src set:', editor.videoElement.src);

    // Show video element
    editor.videoElement.style.display = 'block';

    // Hide static background image if it exists
    if (editor.backgroundImage) {
        editor.backgroundImage.visible(false);
    }

    // Clear imgData from node when loading video
    if (editor.node) {
        editor.node.imgData = null;
    }

    // Make canvas background transparent so video shows through
    if (editor.vis) {
        editor.vis.fillStyle('rgba(0, 0, 0, 0)'); // Transparent
        editor.vis.render();
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
    editor.scale = scale;  // ADD THIS LINE - Ensure coordinate system consistency
    editor.videoOffsetX = offsetX;
    editor.offsetX = offsetX;  // ADD THIS LINE - Ensure coordinate system consistency
    editor.videoOffsetY = offsetY;
    editor.offsetY = offsetY;  // ADD THIS LINE - Ensure coordinate system consistency
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

    console.log('[VideoBackground] Video centered:', {
        scale,
        width: newWidth,
        height: newHeight,
        offsetX,
        offsetY
    });

    // Debug: Check video element state
    console.log('[VideoBackground] Video element state:', {
        src: editor.videoElement.src,
        display: editor.videoElement.style.display,
        left: editor.videoElement.style.left,
        top: editor.videoElement.style.top,
        width: editor.videoElement.style.width,
        height: editor.videoElement.style.height,
        zIndex: editor.videoElement.style.zIndex,
        position: editor.videoElement.style.position,
        inDOM: document.body.contains(editor.videoElement),
        parentElement: editor.videoElement.parentElement?.tagName,
        parentElementId: editor.videoElement.parentElement?.id,
        nextSibling: editor.videoElement.nextSibling?.tagName,
        previousSibling: editor.videoElement.previousSibling?.tagName
    });
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

    // Clear metadata
    editor.videoMetadata = null;
    editor.videoReady = false;

    // Clear positioning data
    editor.videoScale = null;
    editor.scale = null;  // ADD THIS - Clear main scale
    editor.videoOffsetX = null;
    editor.offsetX = null;  // ADD THIS - Clear main offset
    editor.videoOffsetY = null;
    editor.offsetY = null;  // ADD THIS - Clear main offset
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

    console.log('[VideoBackground] Video cleared');
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
    if (editor.videoMetadata && editor.videoScale !== undefined && editor.videoScale !== null) {
        return editor.videoScale;
    }
    return 1; // Default to no scaling
}