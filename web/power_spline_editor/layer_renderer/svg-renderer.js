/**
 * SVG Renderer Module
 *
 * Handles direct SVG DOM manipulation and element creation.
 * This module bypasses Protovis for certain operations to achieve better performance
 * and avoid caching issues during drag operations.
 *
 * This module handles:
 * - SVG group creation and management
 * - SVG element factories (paths, circles, images)
 * - Canvas layer ordering (z-index management)
 * - Fast position updates during drag operations
 * - Custom SVG shape rendering
 */

import { transformVideoToCanvasSpace } from '../spline_utils.js';
import * as GeomCalc from './geometry-calculator.js';

/**
 * Gets or creates an SVG group element by ID
 * @param {SVGElement} svg - The SVG container
 * @param {string} groupId - The group ID
 * @returns {SVGGElement|null} The group element or null if failed
 */
export function getOrCreateSVGGroup(svg, groupId) {
    if (!svg) {
        console.warn('[WARN] SVG not found for group:', groupId);
        return null;
    }

    let group = svg.querySelector(`#${groupId}`);
    if (!group) {
        group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('id', groupId);
        svg.appendChild(group);
    }
    return group;
}

/**
 * Creates an SVG path element (triangle or square)
 * @param {string} shapeType - 'triangle' or 'square'
 * @param {Object} point - Point with {x, y} coordinates
 * @param {Object} styles - Style object {radius, stroke, strokeWidth, fill, cursor}
 * @param {number} rotation - Rotation in radians
 * @param {Object} splineEditor - The spline editor instance
 * @returns {SVGPathElement|null} The created path or null
 */
export function createSVGPath(shapeType, point, styles, rotation, splineEditor) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');

    let d, radius;
    switch (shapeType) {
        case 'square':
            radius = styles.radius || 40;
            d = `M-${radius},-${radius}L${radius},-${radius} ${radius},${radius} -${radius},${radius}Z`;
            break;
        case 'triangle':
            radius = styles.radius || 6;
            const side = radius * 2;
            const triHeight = side * Math.sqrt(3) / 2; // equilateral triangle
            const halfWidth = side / 2;
            d = `M0,-${triHeight / 2} L${halfWidth},${triHeight / 2} -${halfWidth},${triHeight / 2}Z`;
            break;
        default:
            return null;
    }

    path.setAttribute('d', d);
    // Convert rotation from radians to degrees for SVG
    const rotationDeg = rotation * (180 / Math.PI);
    const transformedPoint = transformVideoToCanvasSpace(splineEditor, point.x, point.y);

    path.setAttribute('transform', `translate(${transformedPoint.x},${transformedPoint.y}) rotate(${rotationDeg})`);
    path.setAttribute('stroke', styles.stroke || 'rgb(31,119,180)');
    path.setAttribute('stroke-width', styles.strokeWidth || 3);
    path.setAttribute('fill', styles.fill || 'none');
    path.setAttribute('cursor', styles.cursor || 'move');

    // Ensure visibility
    path.style.pointerEvents = 'auto';
    path.style.visibility = 'visible';
    path.style.opacity = '1';

    return path;
}

/**
 * Creates an SVG circle element
 * @param {Object} point - Point with {x, y} coordinates
 * @param {Object} styles - Style object {radius, stroke, strokeWidth, fill, cursor}
 * @param {Object} splineEditor - The spline editor instance
 * @returns {SVGCircleElement} The created circle
 */
export function createSVGCircle(point, styles, splineEditor) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');

    const transformedPoint = transformVideoToCanvasSpace(splineEditor, point.x, point.y);

    circle.setAttribute('cx', transformedPoint.x);
    circle.setAttribute('cy', transformedPoint.y);
    circle.setAttribute('r', styles.radius || 6);
    circle.setAttribute('stroke', styles.stroke || 'rgb(31,119,180)');
    circle.setAttribute('stroke-width', styles.strokeWidth || 3);
    circle.setAttribute('fill', styles.fill || 'none');
    circle.setAttribute('cursor', styles.cursor || 'move');

    // Ensure visibility
    circle.style.pointerEvents = 'auto';
    circle.style.visibility = 'visible';
    circle.style.opacity = '1';

    return circle;
}

/**
 * Renders custom SVG shapes from pending queues
 * @param {Object} state - State object containing pendingShapes and renderedGroups
 * @param {SVGElement} svg - The SVG container
 */
export function renderCustomSVGShapes(state, svg) {
    if (!svg) return;

    const hasPendingShapes = state.pendingShapes.activeLines.length > 0 ||
                             state.pendingShapes.activeDots.length > 0 ||
                             state.pendingShapes.inactiveDots.length > 0 ||
                             state.pendingShapes.activeBoxDots.length > 0 ||
                             state.pendingShapes.inactiveBoxDots.length > 0 ||
                             state.pendingShapes.activeBoxImages.length > 0 ||
                             state.pendingShapes.inactiveBoxImages.length > 0;

    // If we have pending shapes, create new groups
    if (hasPendingShapes) {
        // Create active lines group (z-index: 48, below dots)
        if (state.pendingShapes.activeLines.length > 0) {
            if (state.renderedGroups.activeLines && state.renderedGroups.activeLines.parentNode) {
                state.renderedGroups.activeLines.parentNode.removeChild(state.renderedGroups.activeLines);
            }
            const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            group.setAttribute('id', 'active-lines-direct');
            group.style.zIndex = '48';
            state.pendingShapes.activeLines.forEach(shape => group.appendChild(shape));
            state.renderedGroups.activeLines = group;
        }

        // Create active dots group (z-index: 50)
        if (state.pendingShapes.activeDots.length > 0) {
            // Remove old group if it exists
            if (state.renderedGroups.activeDots && state.renderedGroups.activeDots.parentNode) {
                state.renderedGroups.activeDots.parentNode.removeChild(state.renderedGroups.activeDots);
            }
            const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            group.setAttribute('id', 'active-dots-direct');
            group.style.zIndex = '50';
            state.pendingShapes.activeDots.forEach(shape => group.appendChild(shape));
            state.renderedGroups.activeDots = group;
        }

        // Create inactive dots group (z-index: 49)
        if (state.pendingShapes.inactiveDots.length > 0) {
            // Remove old group if it exists
            if (state.renderedGroups.inactiveDots && state.renderedGroups.inactiveDots.parentNode) {
                state.renderedGroups.inactiveDots.parentNode.removeChild(state.renderedGroups.inactiveDots);
            }
            const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            group.setAttribute('id', 'inactive-dots-direct');
            group.style.zIndex = '49';
            state.pendingShapes.inactiveDots.forEach(shape => group.appendChild(shape));
            state.renderedGroups.inactiveDots = group;
        }

        // Create active box dots group (z-index: 100 - on top of everything)
        if (state.pendingShapes.activeBoxDots.length > 0) {
            // Remove old group if it exists
            if (state.renderedGroups.activeBoxDots && state.renderedGroups.activeBoxDots.parentNode) {
                state.renderedGroups.activeBoxDots.parentNode.removeChild(state.renderedGroups.activeBoxDots);
            }
            const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            group.setAttribute('id', 'active-box-dots-direct');
            group.style.zIndex = '100';
            state.pendingShapes.activeBoxDots.forEach(shape => group.appendChild(shape));
            state.renderedGroups.activeBoxDots = group;
        }

        // Create inactive box dots group (z-index: 99)
        if (state.pendingShapes.inactiveBoxDots.length > 0) {
            // Remove old group if it exists
            if (state.renderedGroups.inactiveBoxDots && state.renderedGroups.inactiveBoxDots.parentNode) {
                state.renderedGroups.inactiveBoxDots.parentNode.removeChild(state.renderedGroups.inactiveBoxDots);
            }
            const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            group.setAttribute('id', 'inactive-box-dots-direct');
            group.style.zIndex = '99';
            state.pendingShapes.inactiveBoxDots.forEach(shape => group.appendChild(shape));
            state.renderedGroups.inactiveBoxDots = group;
        }

        // Create inactive box images group (z-index: 1 - at the bottom)
        if (state.pendingShapes.inactiveBoxImages.length > 0) {
            if (state.renderedGroups.inactiveBoxImages && state.renderedGroups.inactiveBoxImages.parentNode) {
                state.renderedGroups.inactiveBoxImages.parentNode.removeChild(state.renderedGroups.inactiveBoxImages);
            }
            const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            group.setAttribute('id', 'inactive-box-images');
            group.style.zIndex = '1';
            state.pendingShapes.inactiveBoxImages.forEach(shape => group.appendChild(shape));
            state.renderedGroups.inactiveBoxImages = group;
        }
        // If no pending shapes but we have an existing group, keep it (during drag operations)
        // This prevents inactive box images from disappearing when dragging the active box

        // Create active box images group (z-index: 2)
        if (state.pendingShapes.activeBoxImages.length > 0) {
            if (state.renderedGroups.activeBoxImages && state.renderedGroups.activeBoxImages.parentNode) {
                state.renderedGroups.activeBoxImages.parentNode.removeChild(state.renderedGroups.activeBoxImages);
            }
            const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            group.setAttribute('id', 'active-box-images');
            group.style.zIndex = '2';
            state.pendingShapes.activeBoxImages.forEach(shape => group.appendChild(shape));
            state.renderedGroups.activeBoxImages = group;
        }

        // Clear pending shapes
        state.pendingShapes = {
            activeLines: [],
            activeDots: [],
            inactiveDots: [],
            activeBoxDots: [],
            inactiveBoxDots: [],
            activeBoxImages: [],
            inactiveBoxImages: []
        };
    }

    // Apply the canvas layer ordering system
    applyCanvasLayerOrder(state, svg);
}

/**
 * Canvas Layer Ordering System
 *
 * Manages the z-order (bottom to top) of all SVG elements in the canvas.
 * IMPORTANT: In SVG, z-index CSS property does NOT work. Layer order is determined
 * by the order of elements in the DOM tree. Elements that appear later render on top.
 *
 * Desired Layer Order (bottom to top):
 * Layer 0: Background (bg_image) - Darkened canvas background created by Protovis
 * Layer 1: Protovis SVG Lines - All the spline/curve lines drawn by Protovis panels
 * Layer 2: Reference Images (ref_1, ref_2, etc.) - Box layer reference images
 * Layer 3: SVG Dots/Points - Interactive control points on top of everything
 *
 * @param {Object} state - State object containing renderedGroups
 * @param {SVGElement} svg - The SVG container
 */
export function applyCanvasLayerOrder(state, svg) {
    // console.log('[Canvas Layer Order] Starting layer reorganization...');

    // Step 1: Remove all custom groups to prevent duplicates
    const customGroupIds = [
        'active-lines-direct',
        'inactive-box-images',  // Layer 2 - Inactive reference images
        'active-box-images',    // Layer 2 - Active reference images
        'inactive-dots-direct', // Layer 3 - Inactive regular dots
        'active-dots-direct',   // Layer 3 - Active regular dots
        'inactive-box-dots-direct', // Layer 3 - Inactive box dots
        'active-box-dots-direct'    // Layer 3 - Active box dots
    ];

    customGroupIds.forEach(id => {
        const existing = svg.querySelector(`#${id}`);
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing);
        }
    });

    // Step 2: Handle background rects - Keep first, hide duplicates
    // Layer 0: Background (bg_image)
    let firstBackgroundRectIndex = -1;

    for (let i = 0; i < svg.children.length; i++) {
        const child = svg.children[i];
        // Identify background rect: tagName='rect', no id, has width attribute
        if (child.tagName === 'rect' && !child.id && child.getAttribute('width')) {
            if (firstBackgroundRectIndex === -1) {
                // Keep the first background rect visible at position 0
                firstBackgroundRectIndex = i;
                child.style.display = '';
                // console.log(`[Canvas Layer Order] Layer 0: Background rect at position ${i} (kept visible)`);
            } else {
                // Hide all duplicate background rects (Protovis creates multiple)
                child.style.display = 'none';
                // console.log(`[Canvas Layer Order] Layer 0: Duplicate background rect at position ${i} (hidden)`);
            }
        }
    }

    // Step 3: Find insertion point for reference images
    // Reference images must go AFTER all Protovis 'g' groups but BEFORE dots
    // We find the LAST Protovis 'g' element and insert after it
    let lastProtovisGroupIndex = -1;

    for (let i = 0; i < svg.children.length; i++) {
        const child = svg.children[i];
        // Protovis groups are 'g' elements without our custom IDs
        if (child.tagName === 'g' && !customGroupIds.includes(child.id)) {
            lastProtovisGroupIndex = i;
        }
    }

    let refImageInsertPoint = null;
    if (lastProtovisGroupIndex >= 0 && lastProtovisGroupIndex + 1 < svg.children.length) {
        refImageInsertPoint = svg.children[lastProtovisGroupIndex + 1];
    }
    // Step 3.5: Insert active lines group (just after Protovis lines)
    if (state.renderedGroups.activeLines) {
        if (refImageInsertPoint && refImageInsertPoint.parentNode === svg) {
            svg.insertBefore(state.renderedGroups.activeLines, refImageInsertPoint);
        } else {
            svg.appendChild(state.renderedGroups.activeLines);
        }
    }

    // Step 4: Insert reference images (Layer 2)
    // Render order within Layer 2: inactive → active (active appears on top)
    const refImageGroups = [
        { group: state.renderedGroups.inactiveBoxImages, name: 'inactive-box-images' },
        { group: state.renderedGroups.activeBoxImages, name: 'active-box-images' }
    ];

    refImageGroups.forEach(({ group, name }) => {
        if (group) {
            if (refImageInsertPoint && refImageInsertPoint.parentNode === svg) {
                svg.insertBefore(group, refImageInsertPoint);
                // console.log(`[Canvas Layer Order] Layer 2: Inserted ${name}`);
            } else {
                svg.appendChild(group);
                // console.log(`[Canvas Layer Order] Layer 2: Appended ${name} (no insert point)`);
            }
        }
    });

    // Step 5: Append dots at the very end (Layer 3)
    // Render order within Layer 3: inactive → active, regular → box
    // This ensures box dots appear on top of regular dots, and active on top of inactive
    const dotGroups = [
        { group: state.renderedGroups.inactiveDots, name: 'inactive-dots-direct' },      // Bottom of Layer 3
        { group: state.renderedGroups.activeDots, name: 'active-dots-direct' },          // Above inactive dots
        { group: state.renderedGroups.inactiveBoxDots, name: 'inactive-box-dots-direct' }, // Above regular dots
        { group: state.renderedGroups.activeBoxDots, name: 'active-box-dots-direct' }     // Top of Layer 3
    ];

    dotGroups.forEach(({ group, name }) => {
        if (group) {
            svg.appendChild(group);
            // console.log(`[Canvas Layer Order] Layer 3: Appended ${name}`);
        }
    });

    // Step 6: Log final DOM structure for debugging
    const children = Array.from(svg.children);
    // console.log('[Canvas Layer Order] Final SVG structure (bottom to top):');
    children.forEach((child, i) => {
        const id = child.id || child.tagName;
        const childCount = child.children?.length || 0;
        const width = child.getAttribute?.('width');
        const display = child.style.display;
        const isVisible = display !== 'none';
        // console.log(`  Position ${i}: ${id} (${childCount} children, width: ${width || 'N/A'}, visible: ${isVisible})`);
    });




}

/**
 * Updates positions of existing active dot SVG elements during drag (fast path)
 * @param {Object} state - State object containing renderedGroups
 * @param {Array} points - Current points array
 * @param {Object} splineEditor - The spline editor instance
 * @param {Object} layerInfo - Layer information {layerType, interpolation}
 */
export function updateActiveDotPositions(state, points, splineEditor, layerInfo) {
    // Fast path: update positions of existing SVG elements during drag
    if (!state.renderedGroups.activeDots && !state.renderedGroups.activeBoxDots) return;

    const validPoints = points.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));

    // Update active dots (circles/triangles)
    if (state.renderedGroups.activeDots) {
        const children = Array.from(state.renderedGroups.activeDots.children);
        children.forEach((element, idx) => {
            if (idx >= validPoints.length) return;
            const point = validPoints[idx];
            const transformedPoint = transformVideoToCanvasSpace(splineEditor, point.x, point.y);

            if (element.tagName === 'circle') {
                element.setAttribute('cx', transformedPoint.x);
                element.setAttribute('cy', transformedPoint.y);
            } else if (element.tagName === 'path') {
                // For paths (triangles), recalculate rotation for first point
                let rotationDeg = 0;
                if (idx === 0 && validPoints.length > 1 && layerInfo.layerType === 'normal' && layerInfo.interpolation !== 'points') {
                    const dx = validPoints[1].x - validPoints[0].x;
                    const dy = validPoints[1].y - validPoints[0].y;
                    const rotationRad = (dx !== 0 || dy !== 0) ? (Math.atan2(dy, dx) - Math.PI / 2 + Math.PI + 2 * Math.PI) % (2 * Math.PI) : 0;
                    rotationDeg = rotationRad * (180 / Math.PI);
                }
                element.setAttribute('transform', `translate(${transformedPoint.x},${transformedPoint.y}) rotate(${rotationDeg})`);
            }
        });
    }

    // Update active box dots (squares) and rotation text
    if (state.renderedGroups.activeBoxDots) {
        const children = Array.from(state.renderedGroups.activeBoxDots.children);
        const radius = validPoints.length > 0 ? GeomCalc.getScaledBoxRadius(validPoints[0], splineEditor) : (40 * GeomCalc.getCanvasScale(splineEditor));

        children.forEach((element, idx) => {
            if (element.tagName === 'path' && idx < validPoints.length) {
                const point = validPoints[idx];
                const rotationRad = GeomCalc.getBoxRotationValue(point);
                const rotationDeg = rotationRad * (180 / Math.PI);
                const transformedPoint = transformVideoToCanvasSpace(splineEditor, point.x, point.y);

                element.setAttribute('transform', `translate(${transformedPoint.x},${transformedPoint.y}) rotate(${rotationDeg})`);
            } else if (element.tagName === 'g' && element.hasAttribute('data-rotation-text') && validPoints.length > 0) {
                // Update rotation text group
                const point = validPoints[0];
                const rotationRad = GeomCalc.getBoxRotationValue(point);
                const rotationDeg = rotationRad * (180 / Math.PI);

                // Update group position
                const transformedPoint = transformVideoToCanvasSpace(splineEditor, point.x, point.y);
                element.setAttribute('transform', `translate(${transformedPoint.x},${transformedPoint.y})`);

                // Update text content
                const textElement = element.querySelector('text');
                if (textElement) {
                    const offsetX = -radius;
                    const offsetY = -radius - 5;
                    textElement.setAttribute('x', offsetX);
                    textElement.setAttribute('y', offsetY);
                    textElement.textContent = `${rotationDeg.toFixed(1)}°`;
                }
            }
        });
    }

    // Update attached box images
    if (state.renderedGroups.activeBoxImages) {
        const images = Array.from(state.renderedGroups.activeBoxImages.children);
        if (validPoints.length > 0 && images.length > 0) {
            const point = validPoints[0];
            const rotationDeg = GeomCalc.getBoxRotationValue(point) * (180 / Math.PI);
            images.forEach((imgEl) => {
                const transformedPoint = transformVideoToCanvasSpace(splineEditor, point.x, point.y);
                imgEl.setAttribute('transform', `translate(${transformedPoint.x},${transformedPoint.y}) rotate(${rotationDeg})`);
            });
        }
    }
}
