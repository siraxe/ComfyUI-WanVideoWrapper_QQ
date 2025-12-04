/**
 * Style Manager Module
 *
 * Handles style rules, layer type detection, and appearance configuration.
 * Centralizes all styling logic for different layer types and states.
 *
 * This module handles:
 * - Layer type classification (normal, handdraw, box)
 * - Interpolation mode normalization
 * - Style dictionaries for lines and points
 * - Dot appearance (shape, size, color, rotation)
 */

import { POINT_BASE_RADIUS } from '../spline_utils.js';
import { getBoxRotationValue } from './geometry-calculator.js';

/**
 * Determines the layer type from a widget
 * @param {Object} widget - The widget object
 * @returns {string} Layer type: 'handdraw', 'box', or 'normal'
 */
export function getLayerType(widget) {
    const type = widget?.value?.type;
    const result = type === 'handdraw' ? 'handdraw' : (type === 'box_layer' ? 'box' : 'normal');
    return result;
}

/**
 * Normalizes interpolation mode based on layer type
 * @param {string} interpolation - Raw interpolation mode
 * @param {string} layerType - Layer type
 * @returns {string} Normalized interpolation mode
 */
export function normalizeInterpolation(interpolation, layerType) {
    const raw = interpolation || 'linear';
    if (layerType !== 'box' && raw === 'box') return 'points';
    return raw;
}

/**
 * Gets the style dictionary for a layer
 * @param {string} layerType - Layer type ('normal', 'handdraw', 'box')
 * @param {string} state - Layer state ('active' or 'inactive')
 * @param {boolean} isPointMode - Whether in points-only mode
 * @param {boolean} isOff - Whether layer is turned off
 * @returns {Object} Style object with line and point styles
 */
export function getLayerStyles(layerType, state, isPointMode = false, isOff = false) {
    if (isOff) {
        return {
            lineStroke: "rgba(255, 255, 255, 0.1)",
            lineWidth: isPointMode ? 1 : 2,
            pointStroke: "rgba(255, 255, 255, 0.1)",
            pointFill: "rgba(255, 255, 255, 0.1)",
        };
    }

    if (layerType === 'handdraw') {
        if (state === 'active') {
            return {
                lineStroke: '#d7c400',
                lineWidth: 3,
                pointStroke: '#d7c400',
                pointFill: 'rgba(215, 196, 0, 0.45)',
                pointRadius: 2,
            };
        }
        return {
            lineStroke: "rgba(120, 70, 180, 0.85)",
            lineWidth: 3,
            pointStroke: "rgba(120, 70, 180, 0.85)",
            pointFill: "rgba(120, 70, 180, 0.6)",
        };
    }

    if (layerType === 'box') {
        if (state === 'active') {
            return {
                lineStroke: '#139613',
                lineWidth: 2,
                pointStroke: '#139613',
                pointFill: 'rgba(19, 150, 19, 0.1)',
            };
        }
        return {
            lineStroke: '#f04d3a',
            lineWidth: 2,
            pointStroke: '#f04d3a',
            pointFill: 'rgba(240, 77, 58, 0.2)',
        };
    }

    // normal layers
    if (state === 'active') {
        const base = {
            lineStroke: '#1f77b4',
            lineWidth: isPointMode ? 1 : 2,
            pointStroke: '#1f77b4',
            pointFill: 'rgba(100, 100, 100, 0.5)',
            pointStrokePoint: '#1f77b4',
            pointFillPoint: 'rgba(100, 100, 100, 0.5)',
            pointRadius: 5,
            firstFill: 'rgba(100, 100, 100, 0.5)',
        };
        if (isPointMode) {
            const pointStroke = 'rgba(45, 242, 109, 0.5)';
            const pointFill = 'rgba(45, 242, 109, 0.5)';
            return {
                ...base,
                pointStroke,
                pointFill,
                pointStrokePoint: pointStroke,
                pointFillPoint: pointFill,
                strokeWidth: 2,
            };
        }
        return base;
    }

    const baseStroke = isPointMode ? 'rgba(255, 127, 14, 0.2)' : 'rgba(255, 127, 14, 0.5)';
    if (isPointMode) {
        return {
            lineStroke: baseStroke,
            lineWidth: 1,
            pointStroke: 'rgba(45, 242, 109, 0.5)',
            pointFill: 'rgba(45, 242, 109, 0.5)',
            pointRadius: 4,
            strokeWidth: 1.5,
        };
    }
    return {
        lineStroke: baseStroke,
        lineWidth: isPointMode ? 1 : 2,
        pointStroke: baseStroke,
        pointFill: isPointMode ? 'rgba(255, 127, 14, 0.2)' : 'rgba(255, 127, 14, 0.4)',
        pointRadius: 4,
    };
}

/**
 * Gets the shape type for a dot
 * @param {Object} dot - The dot/point object
 * @param {string} interpolation - Interpolation mode
 * @param {string} layerType - Layer type
 * @param {Array} allPoints - All points in the layer
 * @param {Function} resolvePointIndex - Function to resolve point index
 * @returns {string} Shape type: 'circle', 'triangle', or 'square'
 */
export function getDotShape(dot, interpolation, layerType, allPoints, resolvePointIndex) {
    // Complete separation for each layer type
    if (layerType === 'box') {
        return 'square'; // Box layers always use squares
    }
    if (layerType === 'handdraw') {
        return 'circle'; // Handdraw layers always use circles
    }
    if (layerType === 'normal' && interpolation !== 'points') {
        // Normal splines use triangle for first point
        const idx = resolvePointIndex?.(dot) ?? allPoints.indexOf(dot);
        const shape = idx === 0 ? 'triangle' : 'circle';
        return shape;
    }
    return 'circle'; // Default fallback
}

/**
 * Gets the rotation angle for a dot
 * @param {Object} dot - The dot/point object
 * @param {string} interpolation - Interpolation mode
 * @param {string} layerType - Layer type
 * @param {Array} allPoints - All points in the layer
 * @param {Function} resolvePointIndex - Function to resolve point index
 * @returns {number} Rotation angle in radians
 */
export function getDotAngle(dot, interpolation, layerType, allPoints, resolvePointIndex) {
    // Complete separation for each layer type
    if (layerType === 'box') {
        return getBoxRotationValue(dot); // Box layers use rotation
    }
    if (layerType === 'handdraw') {
        return 0; // Handdraw layers don't use rotation
    }
    if (layerType === 'normal' && interpolation !== 'points') {
        // Normal splines use rotation for first point
        const idx = resolvePointIndex?.(dot) ?? allPoints.indexOf(dot);
        if (idx !== 0 || allPoints.length <= 1) return 0;

        const dx = allPoints[1].x - allPoints[0].x;
        const dy = allPoints[1].y - allPoints[0].y;
        return (dx !== 0 || dy !== 0) ? (Math.atan2(dy, dx) - Math.PI / 2 + Math.PI + 2 * Math.PI) % (2 * Math.PI) : 0;
    }
    return 0; // Default fallback
}

/**
 * Gets the radius for a dot
 * @param {Object} dot - The dot/point object
 * @param {string} interpolation - Interpolation mode
 * @param {string} layerType - Layer type
 * @param {Object} styles - Style object
 * @returns {number} Dot radius
 */
export function getDotRadius(dot, interpolation, layerType, styles) {
    if (layerType === 'handdraw') return styles.pointRadius || 2;
    if (interpolation === 'points') return POINT_BASE_RADIUS;
    if (layerType === 'box') return 6; // Explicit radius for box layers
    return styles.pointRadius || 5; // Slightly smaller default for normal layers
}

/**
 * Gets the stroke style for a dot
 * @param {Object} dot - The dot/point object
 * @param {string} interpolation - Interpolation mode
 * @param {boolean} isPointMode - Whether in points-only mode
 * @param {string} layerType - Layer type
 * @param {Object} styles - Style object
 * @param {Array} allPoints - All points in the layer
 * @param {Function} resolvePointIndex - Function to resolve point index
 * @returns {string} Stroke color
 */
export function getDotStrokeStyle(dot, interpolation, isPointMode, layerType, styles, allPoints, resolvePointIndex) {
    const idx = resolvePointIndex?.(dot) ?? allPoints.indexOf(dot);

    // Complete separation for each layer type
    if (layerType === 'handdraw') return styles.pointStroke;
    if (layerType === 'box') return styles.pointStroke || '#139613'; // Box layer specific
    if (layerType === 'normal') {
        if (isPointMode && styles.pointStrokePoint) return styles.pointStrokePoint;
        return styles.pointStroke;
    }
    return styles.pointStroke; // Default fallback
}

/**
 * Gets the fill style for a dot
 * @param {Object} dot - The dot/point object
 * @param {string} interpolation - Interpolation mode
 * @param {boolean} isPointMode - Whether in points-only mode
 * @param {string} layerType - Layer type
 * @param {Object} styles - Style object
 * @param {Array} allPoints - All points in the layer
 * @param {Function} resolvePointIndex - Function to resolve point index
 * @returns {string} Fill color
 */
export function getDotFillStyle(dot, interpolation, isPointMode, layerType, styles, allPoints, resolvePointIndex) {
    const idx = resolvePointIndex?.(dot) ?? allPoints.indexOf(dot);

    // Complete separation for each layer type
    if (layerType === 'handdraw') return styles.pointFill;
    if (layerType === 'box') return styles.pointFill || 'rgba(19, 150, 19, 0.1)'; // Box layer specific
    if (layerType === 'normal') {
        if (!isPointMode && idx === 0 && styles.firstFill) return styles.firstFill;
        if (isPointMode && styles.pointFillPoint) return styles.pointFillPoint;
        return styles.pointFill;
    }
    return styles.pointFill; // Default fallback
}
