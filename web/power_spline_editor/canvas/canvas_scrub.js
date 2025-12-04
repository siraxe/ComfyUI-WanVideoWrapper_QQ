/**
 * Canvas Timeline Scrubbing Module for PowerSplineEditor
 *
 * Handles synchronized timeline scrubbing for box layers with support for
 * both image and video backgrounds. Provides unified scrubbing behavior
 * regardless of background type.
 */

import { hasBackgroundVideo, syncVideoToFrame } from './canvas_video_background.js';

/**
 * Initialize scrubbing state for editor
 * @param {Object} editor - The SplineEditor2 instance
 */
export function initializeScrubState(editor) {
    // Box-layer timeline scrubbing state (shift + left-drag on empty canvas)
    editor._boxCanvasScrubActive = false;
    editor._boxCanvasScrubStartX = 0;
    editor._boxCanvasScrubStartFrame = 1;
    editor._boxCanvasScrubWidget = null;  // Legacy: keep for backward compatibility
    editor._boxCanvasScrubWidgets = [];  // Array of {widget, startFrame} for synchronized scrubbing
    editor._boxCanvasScrubStepPx = 1;
}

/**
 * Ensure video element isn't blocking pointer events
 * @param {Object} editor - The SplineEditor2 instance
 */
function ensureVideoNotBlockingEvents(editor) {
    if (editor.videoElement) {
        // Force pointer-events none on video element
        if (editor.videoElement.style.pointerEvents !== 'none') {
            editor.videoElement.style.pointerEvents = 'none';
        }
        // Also set attribute for additional browser compatibility
        if (editor.videoElement.getAttribute('pointer-events') !== 'none') {
            editor.videoElement.setAttribute('pointer-events', 'none');
        }
    }
}

/**
 * Start synchronized timeline scrubbing for all box layers
 * @param {Object} editor - The SplineEditor2 instance
 * @param {Object} activeWidget - The currently active box layer widget
 * @param {number} mouseX - Mouse X coordinate
 * @param {number} mouseY - Mouse Y coordinate
 */
export function startBoxCanvasScrub(editor, activeWidget, mouseX, mouseY) {
    // Ensure video isn't blocking events
    ensureVideoNotBlockingEvents(editor);

    const maxFrames = Math.max(1, editor._getMaxFrames());
    editor._boxCanvasScrubActive = true;

    // Get the current selected layer's timeline point
    const activeTimelinePoint = Math.max(1, Math.min(maxFrames, Math.round(activeWidget.value?.box_timeline_point || 1)));

    // Get ALL box layer widgets for synchronized scrubbing
    const allWidgets = editor.node?.layerManager?.getSplineWidgets?.() || [];
    const allBoxWidgets = allWidgets.filter(w =>
        editor._isBoxLayerWidget(w) && w?.value?.on !== false
    );

    // Sync all other box layers to the active layer's current timeline point
    allBoxWidgets.forEach((w, index) => {
        if (w !== activeWidget) {  // Don't update the active widget (it's already at the right frame)
            try {
                applyBoxTimelineFrame(editor, w, activeTimelinePoint);
            } catch (e) {
                // Silently handle sync errors
            }
        }
    });

    // Store all widgets with the SAME starting frame (now synchronized)
    editor._boxCanvasScrubWidgets = allBoxWidgets.map(w => ({
        widget: w,
        startFrame: activeTimelinePoint  // All start at the same frame now
    }));

    // Legacy single-widget support (use active widget as reference)
    editor._boxCanvasScrubWidget = activeWidget;
    editor._boxCanvasScrubStartX = mouseX;
    editor._boxCanvasScrubStartFrame = activeTimelinePoint;

    // Pixels per frame step; keep a reasonable minimum so small drags still move
    editor._boxCanvasScrubStepPx = Math.max(4, editor.width / Math.max(1, maxFrames - 1));

    // Set up event listeners for scrubbing
    const endScrub = () => {
        document.removeEventListener('mousemove', moveScrub, true);
        document.removeEventListener('mouseup', endScrub, true);
        editor._boxCanvasScrubActive = false;
        editor._boxCanvasScrubWidget = null;
        editor._boxCanvasScrubWidgets = [];
    };

    const moveScrub = (ev) => {
        if (!editor._boxCanvasScrubActive) return;

        // Re-ensure video isn't blocking during scrub (defensive)
        ensureVideoNotBlockingEvents(editor);

        const coords = editor._getPointerCoords(ev);
        const deltaX = (coords?.x ?? mouseX) - editor._boxCanvasScrubStartX;
        const deltaFrames = Math.round(deltaX / editor._boxCanvasScrubStepPx);

        // Update ALL box layer timelines synchronously
        if (editor._boxCanvasScrubWidgets && editor._boxCanvasScrubWidgets.length > 0) {
            editor._boxCanvasScrubWidgets.forEach(({ widget, startFrame }) => {
                const targetFrame = Math.max(
                    1,
                    Math.min(maxFrames, startFrame + deltaFrames)
                );
                try {
                    applyBoxTimelineFrame(editor, widget, targetFrame);
                } catch (e) {
                    // Silently handle frame application errors
                }
            });
        } else {
            // Fallback to single widget (legacy behavior)
            const targetFrame = Math.max(
                1,
                Math.min(maxFrames, editor._boxCanvasScrubStartFrame + deltaFrames)
            );
            applyBoxTimelineFrame(editor, editor._boxCanvasScrubWidget, targetFrame);
        }
    };

    document.addEventListener('mousemove', moveScrub, true);
    document.addEventListener('mouseup', endScrub, true);
}

/**
 * Apply timeline frame with fallback for video backgrounds
 * Handles cases where video isn't ready yet
 *
 * THIS IS THE SINGLE SOURCE OF TRUTH FOR TIMELINE FRAME APPLICATION
 * All other modules should use this function via editor.applyBoxTimelineFrame()
 *
 * @param {Object} editor - The SplineEditor2 instance
 * @param {Object} widget - The box layer widget to update
 * @param {number} frame - Target frame number
 */
export function applyBoxTimelineFrame(editor, widget, frame) {
    if (!editor._isBoxLayerWidget(widget)) {
        return;
    }

    const clampedFrame = Math.max(1, Math.min(editor._getMaxFrames(), Math.round(frame || 1)));

    // Update widget timeline point
    widget.value.box_timeline_point = clampedFrame;

    // Clear preview state if exists
    if (editor._boxPreviewState && editor._boxPreviewState.widget === widget) {
        editor._boxPreviewState = null;
    }

    // Compute and apply box layer position
    const targetPoint = editor._computeBoxLayerPosition(widget, clampedFrame);

    editor._applyBoxLayerPoint(widget, targetPoint);

    // Sync video to frame with fallback
    const hasVideo = hasBackgroundVideo(editor);

    if (hasVideo) {
        const synced = syncVideoToFrameWithRetry(editor, clampedFrame);
        // Video sync may be skipped if not ready yet, but timeline is still updated
    }
}

/**
 * Sync video to frame with retry logic
 * @param {Object} editor - The SplineEditor2 instance
 * @param {number} frame - Target frame number
 * @returns {boolean} True if sync succeeded, false if video not ready
 */
function syncVideoToFrameWithRetry(editor, frame) {
    // Check if video is ready
    if (!editor.videoElement || !editor.videoMetadata || !editor.videoReady) {
        // Video not ready yet - this is expected during initial load
        // Return false to indicate sync was skipped
        return false;
    }

    // Video is ready, perform sync
    try {
        syncVideoToFrame(editor, frame);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Check if scrubbing should be initiated
 * @param {Object} editor - The SplineEditor2 instance
 * @param {Object} activeWidget - The currently active widget
 * @param {Object} coords - Mouse coordinates {x, y}
 * @returns {boolean} True if scrubbing should start
 */
export function shouldStartScrubbing(editor, activeWidget, coords) {
    // Only scrub box layers
    if (!editor._isBoxLayerWidget(activeWidget)) {
        return false;
    }

    // Only scrub when clicking empty space (avoid grabbing the box itself)
    const hit = editor.pickBoxPointFromCoords(coords);
    return !hit;
}
