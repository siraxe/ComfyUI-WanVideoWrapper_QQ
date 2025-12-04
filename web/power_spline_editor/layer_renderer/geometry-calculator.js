/**
 * Geometry Calculator Module
 *
 * Pure geometric calculations and coordinate transformations for the layer renderer.
 * All functions are pure (no side effects) and take state/context as parameters.
 *
 * This module handles:
 * - Point and box scaling calculations
 * - Canvas scaling and transformations
 * - Box rotation geometry
 * - Reference image attachment management
 * - Data validation and sanitization
 * - Distance calculations for hit detection
 */

import { BOX_BASE_RADIUS } from '../spline_utils.js';

/**
 * Clamps a scale value to the valid range [0.2, 3.0]
 * @param {number} value - The scale value to clamp
 * @returns {number} Clamped scale value or 1 if invalid
 */
export function clampPointScale(value) {
    return (typeof value === 'number' && !Number.isNaN(value))
        ? Math.max(0.2, Math.min(3.0, value))
        : 1;
}

/**
 * Gets the scale factor for a point (box or regular point)
 * @param {Object} point - The point object
 * @param {boolean} forBox - Whether to get box scale (true) or point scale (false)
 * @returns {number} The clamped scale value
 */
export function getPointScale(point, forBox = false) {
    if (!point) return 1;
    if (forBox && typeof point.boxScale === 'number') return clampPointScale(point.boxScale);
    if (!forBox && typeof point.pointScale === 'number') return clampPointScale(point.pointScale);
    if (typeof point.scale === 'number') return clampPointScale(point.scale);
    return 1;
}

/**
 * Gets the canvas scaling factor from the spline editor
 * @param {Object} splineEditor - The spline editor instance
 * @returns {number} Canvas scale factor
 */
export function getCanvasScale(splineEditor) {
    if (splineEditor.videoMetadata && splineEditor.videoScale !== undefined && splineEditor.videoScale !== null) {
        return splineEditor.videoScale;
    }

    // Fallback to image scaling
    return (splineEditor.originalImageWidth && splineEditor.originalImageHeight && splineEditor.scale > 0)
        ? splineEditor.scale
        : 1;
}

/**
 * Calculates the scaled radius for a box point
 * Combines canvas scale with individual box scale
 * @param {Object} point - The point object
 * @param {Object} splineEditor - The spline editor instance
 * @returns {number} Scaled box radius
 */
export function getScaledBoxRadius(point, splineEditor) {
    const pointScale = getPointScale(point, true);
    const canvasScale = getCanvasScale(splineEditor);
    return BOX_BASE_RADIUS * pointScale * canvasScale;
}

/**
 * Extracts the rotation value from a box point
 * @param {Object} point - The point object
 * @returns {number} Rotation value in radians
 */
export function getBoxRotationValue(point) {
    if (!point) return 0;
    if (typeof point.boxRotation === 'number' && !Number.isNaN(point.boxRotation)) return point.boxRotation;
    if (typeof point.rotation === 'number' && !Number.isNaN(point.rotation)) return point.rotation;
    return 0;
}

/**
 * Computes the geometry for a box rotation handle
 * @param {Object} point - The box point
 * @param {Object} splineEditor - The spline editor instance
 * @returns {Object|null} Object with {base, tip} coordinates, or null if invalid
 */
export function computeBoxHandleGeometry(point, splineEditor) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;

    const rotation = getBoxRotationValue(point);
    let radius = getScaledBoxRadius(point, splineEditor);
    if (!Number.isFinite(radius)) return null;

    const canvasScale = getCanvasScale(splineEditor);
    if (canvasScale > 0) {
        radius /= canvasScale;
    }

    const extra = Math.max(18 / (canvasScale || 1), radius * 0.5);
    const rotatePoint = (px, py) => ({
        x: point.x + px * Math.cos(rotation) - py * Math.sin(rotation),
        y: point.y + px * Math.sin(rotation) + py * Math.cos(rotation),
    });

    return {
        base: rotatePoint(0, -radius),
        tip: rotatePoint(0, -radius - extra),
    };
}

/**
 * Gets the selected reference attachment from a widget
 * @param {Object} widget - The widget object
 * @returns {Object|null} The selected attachment or null
 */
export function getSelectedRefAttachment(widget) {
    const ref = widget?.value?.ref_attachment;
    const selection = widget?.value?.ref_selection || 'no_ref';

    if (!ref || selection === 'no_ref') {
        return null;
    }

    // New multi-entry format
    if (Array.isArray(ref.entries)) {
        const parts = selection.split('_');
        const idx = parts.length > 1 ? parseInt(parts[1], 10) : 1;
        const arrayIndex = Number.isFinite(idx) ? Math.max(0, idx - 1) : 0;
        return ref.entries[arrayIndex] || null;
    }

    // Legacy single entry
    if (ref.base64) {
        return ref;
    }
    return null;
}

/**
 * Generates a URL for a reference image with caching support
 * @param {Object} widget - The widget object
 * @param {Object} attachment - The attachment object
 * @param {Map} refImageCache - Cache map for URLs
 * @param {number} cacheBustCounter - Cache busting counter
 * @returns {string|null} The image URL or null
 */
export function getRefImageUrl(widget, attachment, refImageCache, cacheBustCounter) {
    if (!attachment) {
        return null;
    }

    // For base64, return directly (no caching needed)
    if (attachment.base64) {
        return `data:${attachment.type || 'image/png'};base64,${attachment.base64}`;
    }

    // First check sessionStorage for the data
    if (attachment.sessionKey) {
        try {
            const dataUrl = sessionStorage.getItem(attachment.sessionKey);
            if (dataUrl) {
                return dataUrl;
            }
        } catch (e) {
            console.warn(`[getRefImageUrl] Failed to load from sessionStorage:`, e);
        }
    }

    // For path-based images, use cache to prevent blinking during timeline scrub
    if (attachment.path) {
        const widgetName = widget?.value?.name || widget?.name || 'unknown';
        const selection = widget?.value?.ref_selection || 'no_ref';
        // Include attachment name/path in cache key to differentiate between different ref images
        const attachmentId = attachment.name || attachment.path;
        const cacheKey = `${widgetName}_${selection}_${attachmentId}`;

        // Check if we have a cached URL for this widget+selection+attachment
        if (!refImageCache.has(cacheKey)) {
            let url;
            if (attachment.path.startsWith('ref/')) {
                // This is an output file from PrepareRefs, use /view endpoint
                const pathParts = attachment.path.split('/');
                const filename = pathParts.pop();
                const subfolder = pathParts.join('/');

                const urlObj = new URL('/view', window.location.origin);
                urlObj.searchParams.set('filename', filename);
                if (subfolder) {
                    urlObj.searchParams.set('subfolder', subfolder);
                }
                urlObj.searchParams.set('type', 'output');
                urlObj.searchParams.set('t', cacheBustCounter);
                url = urlObj.href;
            } else {
                // This is a file inside the extension's web folder (e.g., bg/....)
                url = new URL(`/extensions/ComfyUI-WanVideoWrapper_QQ/${attachment.path}?v=${cacheBustCounter}`, window.location.origin).href;
            }
            refImageCache.set(cacheKey, url);
        }

        return refImageCache.get(cacheKey);
    }

    return null;
}

/**
 * Clears the reference image cache and updates the cache bust counter
 * @param {Map} refImageCache - The cache map to clear
 * @returns {number} New cache bust counter value
 */
export function clearRefImageCache(refImageCache) {
    refImageCache.clear();
    // Update cache bust counter to ensure new URLs are generated with fresh timestamps
    // Add random component to make it even more unique and bypass aggressive browser caching
    return Date.now() + Math.random().toString(36).substring(2, 9);
}

/**
 * Sanitizes and normalizes box keyframe data
 * @param {Object} widget - The widget containing box_keys
 * @param {Object} splineEditor - The spline editor instance
 * @returns {Array} Sorted array of sanitized keyframe objects
 */
export function sanitizeBoxKeys(widget, splineEditor) {
    if (!widget?.value) return [];

    const rawKeys = Array.isArray(widget.value.box_keys) ? widget.value.box_keys : [];
    const editorWidth = Math.max(1, Number(splineEditor?.width) || 1);
    const editorHeight = Math.max(1, Number(splineEditor?.height) || 1);

    return rawKeys
        .map(key => {
            if (!key) return null;

            const frameVal = Number(key.frame);
            const rawX = (typeof key.x === 'number' && !Number.isNaN(key.x)) ? key.x : 0.5;
            const rawY = (typeof key.y === 'number' && !Number.isNaN(key.y)) ? key.y : 0.5;

            // Normalize if needed (values >= 10 are assumed to be pixel coordinates)
            const normX = Math.abs(rawX) >= 10 ? rawX / editorWidth : rawX;
            const normY = Math.abs(rawY) >= 10 ? rawY / editorHeight : rawY;

            const scaleVal = (typeof key.scale === 'number' && !Number.isNaN(key.scale)) ? key.scale : 1;
            const rotationVal = (typeof key.rotation === 'number' && !Number.isNaN(key.rotation)) ? key.rotation : 0;

            return {
                frame: Number.isFinite(frameVal) ? Math.round(frameVal) : 1,
                x: normX,
                y: normY,
                scale: splineEditor.clampScaleValue?.(scaleVal) ?? Math.max(0.2, Math.min(3, scaleVal)),
                rotation: rotationVal,
            };
        })
        .filter(Boolean)
        .sort((a, b) => (a.frame || 0) - (b.frame || 0));
}

/**
 * Safely denormalizes points using the spline editor
 * @param {Array} points - Normalized points to denormalize
 * @param {Object} splineEditor - The spline editor instance
 * @returns {Array|null} Denormalized points or null if failed
 */
export function safeDenormalizePoints(points, splineEditor) {
    if (!points?.length) return null;
    try {
        return splineEditor.denormalizePoints(points);
    } catch {
        return null;
    }
}

/**
 * Calculates the distance from a point to a line segment
 * @param {number} px - Point x coordinate
 * @param {number} py - Point y coordinate
 * @param {number} x1 - Line segment start x
 * @param {number} y1 - Line segment start y
 * @param {number} x2 - Line segment end x
 * @param {number} y2 - Line segment end y
 * @returns {number} Distance from point to line segment
 */
export function distanceToLineSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared === 0) {
        const dpx = px - x1;
        const dpy = py - y1;
        return Math.sqrt(dpx * dpx + dpy * dpy);
    }

    let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));

    const closestX = x1 + t * dx;
    const closestY = y1 + t * dy;
    const distX = px - closestX;
    const distY = py - closestY;

    return Math.sqrt(distX * distX + distY * distY);
}
