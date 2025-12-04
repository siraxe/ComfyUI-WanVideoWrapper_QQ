/**
 * Animation System Module
 *
 * Manages dash animations and visual effects for spline layers.
 * Handles animated dash patterns for both inactive and active layers.
 *
 * This module handles:
 * - Dash animation timing and updates
 * - Path categorization by color (purple/orange)
 * - Animated dash pattern generation with easing
 * - SVG DOM manipulation for animation effects
 *
 * Animation State Structure:
 * {
 *   dashAnimOffset: number,      // Current animation offset (0-1000, wraps)
 *   lastDashUpdateMs: number,    // Timestamp of last update for throttling
 *   inactiveLayerMetadata: Array // Metadata for inactive layers
 * }
 */

/**
 * Updates the dash animation for inactive layers
 * @param {Object} state - Animation state object
 * @param {SVGElement} svg - The SVG container
 * @param {Object} splineEditor - The spline editor instance
 */
export function updateInactiveDash(state, svg, splineEditor) {
    if (!splineEditor || !svg) return;

    // If disabled, clean up and return
    if (splineEditor._inactiveFlowEnabled === false) {
        removeDashStyling(svg);
        return;
    }

    // Throttle updates
    const now = Date.now();
    const minInterval = splineEditor._handdrawActive ? 120 : 60;
    const needsInitial = needsInitialDashApply(svg);

    if (!needsInitial && (now - state.lastDashUpdateMs < minInterval)) return;
    state.lastDashUpdateMs = now;

    applyDashAnimation(state, svg);
}

/**
 * Updates the dash animation for active handdraw layers
 * @param {Object} state - Animation state object
 * @param {SVGElement} svg - The SVG container
 * @param {Object} splineEditor - The spline editor instance
 * @param {Object} node - The node containing layer manager
 */
export function updateActiveHanddrawDash(state, svg, splineEditor, node) {
    if (!splineEditor || splineEditor._inactiveFlowEnabled === false) return;

    const now = Date.now();
    const minInterval = splineEditor._handdrawActive ? 120 : 60;
    if ((state.lastDashUpdateMs || 0) && (now - state.lastDashUpdateMs < minInterval)) return;
    state.lastDashUpdateMs = now;

    if (!svg) return;

    const active = node?.layerManager?.getActiveWidget?.();
    if (!active || active.value?.type !== 'handdraw') return;

    const easingMode = active.value?.easing || 'linear';
    const phase = ((state.dashAnimOffset % 200) / 200);
    const paths = svg.getElementsByTagName('path');
    const norm = s => (s || '').replace(/\s+/g, '').toLowerCase();

    for (const p of paths) {
        const stroke = norm(p.getAttribute('stroke'));
        if (stroke !== '#d7c400') continue;

        const pathLength = (typeof p.getTotalLength === 'function') ? p.getTotalLength() : 0;
        const pattern = generateActiveHanddrawPattern(pathLength, phase, easingMode);

        p.setAttribute('stroke-dasharray', pattern.join(' '));
        p.setAttribute('stroke-dashoffset', String(-phase * (pathLength || 1)));
    }
}

/**
 * Applies dash animation to categorized paths
 * @param {Object} state - Animation state object
 * @param {SVGElement} svg - The SVG container
 */
export function applyDashAnimation(state, svg) {
    const paths = Array.from(svg.getElementsByTagName('path'));
    const phase = ((state.dashAnimOffset % 200) / 200);

    const { purple: purplePaths, orange: orangePaths } = categorizePaths(paths);
    const purpleMetas = state.inactiveLayerMetadata.filter(d => d?.widget?.value?.type === 'handdraw');
    const orangeMetas = state.inactiveLayerMetadata.filter(d => {
        const interp = d?.widget?.value?.interpolation || 'linear';
        const layerType = d?.widget?.value?.type || d?.widget?.type || '';
        // Never dash box layers or points-mode layers
        if (layerType === 'box_layer' || layerType === 'box') return false;
        return layerType !== 'handdraw' && interp !== 'points' && interp !== 'box';
    });

    applyDashForPaths(purplePaths, purpleMetas, phase);
    applyDashForPaths(orangeMetas, orangeMetas, phase);
}

/**
 * Categorizes SVG paths by stroke color (purple vs orange)
 * @param {Array<SVGPathElement>} paths - Array of path elements
 * @returns {Object} Object with {purple: Array, orange: Array}
 */
export function categorizePaths(paths) {
    const purple = [], orange = [];
    const norm = s => (s || '').replace(/\s+/g, '').toLowerCase();

    for (const p of paths) {
        if (!isInactiveTargetPath(p)) continue;

        const stroke = norm(p.getAttribute('stroke'));
        const isPurple = stroke.includes('120,70,180') || stroke.includes('#7846b4');
        const len = (typeof p.getTotalLength === 'function') ? p.getTotalLength() : 0;

        (isPurple ? purple : orange).push({ p, len });
    }

    return { purple, orange };
}

/**
 * Removes all dash styling from SVG paths
 * @param {SVGElement} svg - The SVG container
 */
export function removeDashStyling(svg) {
    const paths = svg.getElementsByTagName('path');
    for (const p of paths) {
        p.removeAttribute('stroke-dasharray');
        p.removeAttribute('stroke-dashoffset');
        if (p.dataset) delete p.dataset.dashOffset;
    }
}

/**
 * Checks if initial dash styling needs to be applied
 * @param {SVGElement} svg - The SVG container
 * @returns {boolean} True if initial application is needed
 */
export function needsInitialDashApply(svg) {
    const paths = svg.getElementsByTagName('path');
    for (const el of paths) {
        const stroke = (el.getAttribute('stroke') || '').toLowerCase();
        const sw = Number(el.getAttribute('stroke-width') || '0');
        if (isInactiveStroke(stroke) && sw > 1 && !el.hasAttribute('stroke-dasharray')) {
            return true;
        }
    }
    return false;
}

/**
 * Checks if a stroke color is an inactive layer color
 * @param {string} stroke - The stroke color string
 * @returns {boolean} True if it's an inactive color
 */
export function isInactiveStroke(stroke) {
    return stroke.includes('120,70,180') || stroke.includes('#7846b4') ||
           stroke.includes('255,127,14') || stroke.includes('#ff7f0e');
}

/**
 * Checks if a path is a valid target for inactive dash animation
 * @param {SVGPathElement} p - The path element
 * @returns {boolean} True if it's a valid target
 */
export function isInactiveTargetPath(p) {
    const norm = s => (s || '').replace(/\s+/g, '').toLowerCase();
    const stroke = norm(p.getAttribute('stroke'));

    // Exclude active colors
    if (stroke === '#1f77b4' || stroke === '#d7c400') return false;

    const isOrange = stroke.includes('255,127,14') || stroke.includes('#ff7f0e') ||
                    stroke.includes('rgba(255,127,14') || stroke.includes('rgb(255,127,14)');
    const isPurple = stroke.includes('120,70,180') || stroke.includes('#7846b4');

    if (!(isOrange || isPurple)) return false;

    // Exclude thin orange lines (points mode)
    const sw = Number(p.getAttribute('stroke-width') || '0');
    return !(isOrange && sw <= 1.01);
}

/**
 * Applies dash styling to a set of paths with corresponding metadata
 * @param {Array} pairs - Array of {p: SVGPathElement, len: number}
 * @param {Array} metas - Array of layer metadata
 * @param {number} phase - Current animation phase (0-1)
 */
export function applyDashForPaths(pairs, metas, phase) {
    const count = Math.min(pairs.length, metas.length);

    for (let idx = 0; idx < count; idx++) {
        const { p, len: pathLength } = pairs[idx];
        const easingMode = metas[idx]?.widget?.value?.easing || 'linear';
        const pattern = generateDashPattern(pathLength, phase, easingMode);

        p.setAttribute('stroke-dasharray', pattern.join(' '));
        p.setAttribute('stroke-dashoffset', String(-phase * (pathLength || 1)));
    }
}

/**
 * Generates an animated dash pattern for inactive layers
 * @param {number} pathLength - Total length of the path
 * @param {number} phase - Current animation phase (0-1)
 * @param {string} easingMode - Easing mode ('linear', 'in', 'out', 'in_out', 'out_in')
 * @returns {Array<number>} Dash pattern array
 */
export function generateDashPattern(pathLength, phase, easingMode) {
    const segments = Math.max(14, Math.min(100, Math.round(pathLength / 36)));
    const baseDash = 10, baseGap = 6;
    const minFactor = 0.25, maxFactor = 1.6;
    const pattern = [];
    let sum = 0;

    for (let i = 0; i < segments; i++) {
        const t = (i / segments + phase) % 1;
        const f = easeValue(t, easingMode);
        const dash = Math.max(2, baseDash * (minFactor + (maxFactor - minFactor) * f));
        const gap = Math.max(2, baseGap * (1.0 - 0.2 * f));
        pattern.push(dash, gap);
        sum += dash + gap;
    }

    // Scale to fit path length
    if (sum > 0 && pathLength > 0) {
        const scale = pathLength / sum;
        for (let k = 0; k < pattern.length; k++) {
            pattern[k] = Math.max(1, pattern[k] * scale);
        }
    }

    return pattern;
}

/**
 * Generates an animated dash pattern for active handdraw layers
 * @param {number} pathLength - Total length of the path
 * @param {number} phase - Current animation phase (0-1)
 * @param {string} easingMode - Easing mode
 * @returns {Array<number>} Dash pattern array
 */
export function generateActiveHanddrawPattern(pathLength, phase, easingMode) {
    const segments = Math.max(14, Math.min(100, Math.round(pathLength / 36)));
    const baseDash = 10, baseGap = 6;
    const minFactor = 0.35, maxFactor = 1.45;
    const pattern = [];
    let sum = 0;

    for (let i = 0; i < segments; i++) {
        const t = (i / segments + phase) % 1;
        const f = easeValue(t, easingMode);
        const dash = Math.max(2, baseDash * (minFactor + (maxFactor - minFactor) * f));
        pattern.push(dash, baseGap);
        sum += dash + baseGap;
    }

    if (sum > 0 && pathLength > 0) {
        const scale = pathLength / sum;
        for (let k = 0; k < pattern.length; k++) {
            pattern[k] = Math.max(1, pattern[k] * scale);
        }
    }

    return pattern;
}

/**
 * Applies easing function to a value
 * @param {number} t - Input value (0-1)
 * @param {string} mode - Easing mode ('in', 'out', 'in_out', 'out_in', 'linear')
 * @returns {number} Eased value (0-1)
 */
export function easeValue(t, mode) {
    t = Math.max(0, Math.min(1, t));
    switch (mode) {
        case 'in': return t;
        case 'out': return 1 - t;
        case 'in_out': return Math.sin(Math.PI * t);
        case 'out_in': return 1 - Math.sin(Math.PI * t);
        default: return 1;
    }
}
