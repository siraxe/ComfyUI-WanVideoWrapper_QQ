/**
 * Hit Detection Module
 *
 * Handles mouse-based layer selection and interaction detection.
 * Finds the closest inactive layer to a mouse position.
 *
 * This module handles:
 * - Point-to-point distance calculations
 * - Point-to-line segment distance calculations
 * - Layer selection by proximity
 */

import { distanceToLineSegment } from './geometry-calculator.js';

/**
 * Finds the inactive layer closest to a mouse position
 * @param {Array} inactiveLayerMetadata - Array of inactive layer metadata
 * @param {number} mouseX - Mouse X coordinate
 * @param {number} mouseY - Mouse Y coordinate
 * @param {number} threshold - Maximum distance threshold (default: 15)
 * @returns {Object|null} The closest widget or null if none within threshold
 */
export function findInactiveLayerAtPosition(inactiveLayerMetadata, mouseX, mouseY, threshold = 15) {
    const firstPointThreshold = Math.max(threshold, 22);
    let closestWidget = null;
    let closestDistance = threshold;

    for (const layerData of inactiveLayerMetadata) {
        const points = layerData.points;

        // Check distance to points
        for (let idx = 0; idx < points.length; idx++) {
            const point = points[idx];
            const dx = mouseX - point.x;
            const dy = mouseY - point.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const localThreshold = idx === 0 ? firstPointThreshold : threshold;

            if (distance < Math.min(closestDistance, localThreshold)) {
                closestDistance = distance;
                closestWidget = layerData.widget;
            }
        }

        // Check distance to line segments
        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i];
            const p2 = points[i + 1];
            const distance = distanceToLineSegment(mouseX, mouseY, p1.x, p1.y, p2.x, p2.y);

            if (distance < closestDistance) {
                closestDistance = distance;
                closestWidget = layerData.widget;
            }
        }
    }

    return closestWidget;
}
