/**
 * @class LayerRenderer
 * Handles rendering of active and inactive spline layers on the Protovis canvas.
 *
 * This is a wrapper class that coordinates multiple specialized modules:
 * - geometry-calculator: Pure geometric calculations
 * - animation-system: Dash animations and visual effects
 * - svg-renderer: Direct SVG DOM manipulation
 * - style-manager: Styling rules and layer type detection
 * - layer-drawer: Layer rendering orchestration
 * - hit-detection: Mouse-based layer selection
 */

import { BOX_BASE_RADIUS, POINT_BASE_RADIUS, transformVideoToCanvasSpace } from './spline_utils.js';
import { BOX_TIMELINE_MAX_POINTS } from './canvas/canvas_constants.js';

// Import all modules
import * as GeometryCalc from './layer_renderer/geometry-calculator.js';
import * as AnimationSys from './layer_renderer/animation-system.js';
import * as SVGRenderer from './layer_renderer/svg-renderer.js';
import * as StyleManager from './layer_renderer/style-manager.js';
import * as LayerDrawer from './layer_renderer/layer-drawer.js';
import * as HitDetection from './layer_renderer/hit-detection.js';

export class LayerRenderer {
    constructor(splineEditor, vis) {
        this.splineEditor = splineEditor;
        this.vis = vis;
        this.node = splineEditor.node;

        this.inactiveLayerPanels = [];
        this.activeLayerPanel = this.vis.add(pv.Panel);
        this.inactiveLayerMetadata = [];

        // Render counter to force Protovis re-evaluation
        this._renderCounter = 0;

        // Direct SVG groups for bypass Protovis caching
        this.svgGroups = {
            activeDots: null,
            inactiveDots: null
        };

        // Dash animation state
        this._dashAnimOffset = 0;
        this._lastDashUpdateMs = 0;
        this._dashTimer = setInterval(() => {
            this._dashAnimOffset = (this._dashAnimOffset + 2) % 1000;
            try { this.updateInactiveDash(); } catch {}
        }, 80);

        // Storage for custom SVG shapes to render after vis.render()
        this._pendingShapes = {
            activeLines: [],
            activeDots: [],
            inactiveDots: [],
            activeBoxDots: [],
            inactiveBoxDots: [],
            activeBoxImages: [],
            inactiveBoxImages: []
        };

        // Storage for rendered SVG groups (to re-attach after vis.render())
        this._renderedGroups = {
            activeLines: null,
            activeDots: null,
            inactiveDots: null,
            activeBoxDots: null,
            inactiveBoxDots: null,
            activeBoxImages: null,
            inactiveBoxImages: null
        };

        // Guard to prevent multiple requestAnimationFrame calls
        this._renderPending = false;

        // Helpers to temporarily hide spline visuals and keep box manipulators visible
        this._boxPlayVisibility = false;
        this._boxRefOnlyMode = false;

        // Cache for ref image URLs to prevent blinking during timeline scrub
        this._refImageCache = new Map();
        // Global cache bust counter - incremented when cache is cleared to force new URLs
        this._cacheBustCounter = Date.now();
    }

    // === PUBLIC UTILITY METHODS ===

    setBoxPlayVisibility(enabled) {
        this._boxPlayVisibility = !!enabled;
        const svg = this.vis?.canvas?.();
        if (!svg) return;

        // Hide/show green box squares, rotation controls, and rotation text during playback
        const boxSquares = svg.querySelectorAll('g#active-box-dots-direct > path, g#inactive-box-dots-direct > path');
        const rotationTexts = svg.querySelectorAll('g#active-box-dots-direct > g[data-rotation-text], g#inactive-box-dots-direct > g[data-rotation-text]');

        if (enabled) {
            boxSquares.forEach(el => {
                el.dataset.prevDisplay = el.style.display || '';
                el.style.display = 'none';
            });
            rotationTexts.forEach(el => {
                el.dataset.prevDisplay = el.style.display || '';
                el.style.display = 'none';
            });
        } else {
            boxSquares.forEach(el => {
                if (el.dataset.prevDisplay !== undefined) {
                    el.style.display = el.dataset.prevDisplay;
                    delete el.dataset.prevDisplay;
                }
            });
            rotationTexts.forEach(el => {
                if (el.dataset.prevDisplay !== undefined) {
                    el.style.display = el.dataset.prevDisplay;
                    delete el.dataset.prevDisplay;
                }
            });
        }

        // Hide other spline elements including rotation handles
        const applyToggle = (elements) => {
            elements.forEach(el => {
                if (enabled) {
                    el.dataset.prevDisplay = el.style.display || '';
                    el.style.display = 'none';
                } else if (el.dataset.prevDisplay !== undefined) {
                    el.style.display = el.dataset.prevDisplay;
                    delete el.dataset.prevDisplay;
                }
            });
        };
        applyToggle(Array.from(svg.querySelectorAll('path:not(#active-box-dots-direct > path):not(#inactive-box-dots-direct > path):not(#active-box-images > *)')));
        applyToggle(Array.from(svg.querySelectorAll('circle')));
        applyToggle(Array.from(svg.querySelectorAll('g#active-dots-direct g path, g#inactive-dots-direct g path, g#active-dots-direct g circle, g#inactive-dots-direct g circle')));
    }

    setBoxRefOnlyMode(enabled) {
        this._boxRefOnlyMode = !!enabled;
    }

    clearRefImageCache() {
        this._cacheBustCounter = GeometryCalc.clearRefImageCache(this._refImageCache);
    }

    // === GEOMETRY CALCULATION METHODS (delegated to geometry-calculator) ===

    clampPointScale(value) {
        return GeometryCalc.clampPointScale(value);
    }

    getPointScale(point, forBox = false) {
        return GeometryCalc.getPointScale(point, forBox);
    }

    getCanvasScale() {
        return GeometryCalc.getCanvasScale(this.splineEditor);
    }

    getScaledBoxRadius(point) {
        return GeometryCalc.getScaledBoxRadius(point, this.splineEditor);
    }

    _getBoxRotationValue(point) {
        return GeometryCalc.getBoxRotationValue(point);
    }

    _computeBoxHandleGeometry(point) {
        return GeometryCalc.computeBoxHandleGeometry(point, this.splineEditor);
    }

    _getSelectedRefAttachment(widget) {
        return GeometryCalc.getSelectedRefAttachment(widget);
    }

    _getRefImageUrl(widget, attachment) {
        return GeometryCalc.getRefImageUrl(widget, attachment, this._refImageCache, this._cacheBustCounter);
    }

    _sanitizeBoxKeys(widget) {
        return GeometryCalc.sanitizeBoxKeys(widget, this.splineEditor);
    }

    _safeDenormalizePoints(points) {
        return GeometryCalc.safeDenormalizePoints(points, this.splineEditor);
    }

    distanceToLineSegment(px, py, x1, y1, x2, y2) {
        return GeometryCalc.distanceToLineSegment(px, py, x1, y1, x2, y2);
    }

    // === STYLE MANAGEMENT METHODS (delegated to style-manager) ===

    _getLayerType(widget) {
        return StyleManager.getLayerType(widget);
    }

    _normalizeInterpolation(interpolation, layerType) {
        return StyleManager.normalizeInterpolation(interpolation, layerType);
    }

    _getLayerStyles(layerType, state, isPointMode = false, isOff = false) {
        return StyleManager.getLayerStyles(layerType, state, isPointMode, isOff);
    }

    _getDotShape(dot, interpolation, layerType) {
        const allPoints = this.splineEditor.points || [];
        const resolvePointIndex = this.splineEditor.resolvePointIndex?.bind(this.splineEditor);
        return StyleManager.getDotShape(dot, interpolation, layerType, allPoints, resolvePointIndex);
    }

    _getDotAngle(dot, interpolation, layerType) {
        const allPoints = this.splineEditor.points || [];
        const resolvePointIndex = this.splineEditor.resolvePointIndex?.bind(this.splineEditor);
        return StyleManager.getDotAngle(dot, interpolation, layerType, allPoints, resolvePointIndex);
    }

    _getDotRadius(dot, interpolation, layerType, styles) {
        return StyleManager.getDotRadius(dot, interpolation, layerType, styles);
    }

    _getDotStrokeStyle(dot, interpolation, isPointMode, layerType, styles, allPoints) {
        const resolvePointIndex = this.splineEditor.resolvePointIndex?.bind(this.splineEditor);
        return StyleManager.getDotStrokeStyle(dot, interpolation, isPointMode, layerType, styles, allPoints, resolvePointIndex);
    }

    _getDotFillStyle(dot, interpolation, isPointMode, layerType, styles, allPoints) {
        const resolvePointIndex = this.splineEditor.resolvePointIndex?.bind(this.splineEditor);
        return StyleManager.getDotFillStyle(dot, interpolation, isPointMode, layerType, styles, allPoints, resolvePointIndex);
    }

    // === ANIMATION METHODS (delegated to animation-system) ===

    updateInactiveDash() {
        const svg = this.vis?.canvas?.();
        if (!svg) return;
        const state = {
            dashAnimOffset: this._dashAnimOffset,
            lastDashUpdateMs: this._lastDashUpdateMs,
            inactiveLayerMetadata: this.inactiveLayerMetadata
        };
        AnimationSys.updateInactiveDash(state, svg, this.splineEditor);
        this._lastDashUpdateMs = state.lastDashUpdateMs;
    }

    updateActiveHanddrawDash() {
        const svg = this.vis?.canvas?.();
        if (!svg) return;
        const state = {
            dashAnimOffset: this._dashAnimOffset,
            lastDashUpdateMs: this._lastDashUpdateMs
        };
        AnimationSys.updateActiveHanddrawDash(state, svg, this.splineEditor, this.node);
        this._lastDashUpdateMs = state.lastDashUpdateMs;
    }

    // === SVG RENDERING METHODS (delegated to svg-renderer) ===

    _getOrCreateSVGGroup(groupId) {
        const canvas = this.vis.canvas();
        if (!canvas) return null;
        const svg = canvas.tagName === 'svg' ? canvas : canvas.querySelector('svg');
        return SVGRenderer.getOrCreateSVGGroup(svg, groupId);
    }

    _createSVGPath(shapeType, point, styles, rotation = 0) {
        return SVGRenderer.createSVGPath(shapeType, point, styles, rotation, this.splineEditor);
    }

    _createSVGCircle(point, styles) {
        return SVGRenderer.createSVGCircle(point, styles, this.splineEditor);
    }

    _renderCustomSVGShapes() {
        const canvas = this.vis.canvas();
        if (!canvas) return;
        const svg = canvas.tagName === 'svg' ? canvas : canvas.querySelector('svg');
        if (!svg) return;

        const state = {
            pendingShapes: this._pendingShapes,
            renderedGroups: this._renderedGroups
        };
        SVGRenderer.renderCustomSVGShapes(state, svg);
        this._pendingShapes = state.pendingShapes;
        this._renderedGroups = state.renderedGroups;
    }

    _updateActiveDotPositions() {
        const points = this.splineEditor.points || [];
        const activeWidget = this.node.layerManager.getActiveWidget();
        const layerType = this._getLayerType(activeWidget);
        const interpolation = activeWidget?.value?.interpolation || 'linear';

        const state = {
            renderedGroups: this._renderedGroups
        };
        const layerInfo = { layerType, interpolation };
        SVGRenderer.updateActiveDotPositions(state, points, this.splineEditor, layerInfo);
    }

    // === HIT DETECTION METHODS (delegated to hit-detection) ===

    findInactiveLayerAtPosition(mouseX, mouseY, threshold = 15) {
        return HitDetection.findInactiveLayerAtPosition(this.inactiveLayerMetadata, mouseX, mouseY, threshold);
    }

    // === LAYER DRAWING METHODS (delegated to layer-drawer) ===

    drawActiveLayer(widget) {
        const context = this._getDrawingContext();
        LayerDrawer.drawActiveLayer(context, widget);
    }

    drawInactiveLayer(widget) {
        const context = this._getDrawingContext();
        LayerDrawer.drawInactiveLayer(context, widget);
    }

    // Helper to build context object for layer drawer
    _getDrawingContext() {
        return {
            splineEditor: this.splineEditor,
            vis: this.vis,
            node: this.node,
            activeLayerPanel: this.activeLayerPanel,
            inactiveLayerPanels: this.inactiveLayerPanels,
            inactiveLayerMetadata: this.inactiveLayerMetadata,
            _pendingShapes: this._pendingShapes,
            _renderedGroups: this._renderedGroups,
            _boxRefOnlyMode: this._boxRefOnlyMode,
            _refImageCache: this._refImageCache,
            _cacheBustCounter: this._cacheBustCounter,
            // Provide bound methods for module functions
            _getLayerType: (w) => this._getLayerType(w),
            _normalizeInterpolation: (i, t) => this._normalizeInterpolation(i, t),
            _getLayerStyles: (t, s, p, o) => this._getLayerStyles(t, s, p, o),
            _safeDenormalizePoints: (p) => this._safeDenormalizePoints(p),
            _getDotShape: (d, i, t) => this._getDotShape(d, i, t),
            _getDotAngle: (d, i, t) => this._getDotAngle(d, i, t),
            _getDotRadius: (d, i, t, s) => this._getDotRadius(d, i, t, s),
            _getDotStrokeStyle: (d, i, p, t, s, a) => this._getDotStrokeStyle(d, i, p, t, s, a),
            _getDotFillStyle: (d, i, p, t, s, a) => this._getDotFillStyle(d, i, p, t, s, a),
            getScaledBoxRadius: (p) => this.getScaledBoxRadius(p),
            _getBoxRotationValue: (p) => this._getBoxRotationValue(p),
            _computeBoxHandleGeometry: (p) => this._computeBoxHandleGeometry(p),
            _getSelectedRefAttachment: (w) => this._getSelectedRefAttachment(w),
            _getRefImageUrl: (w, a) => this._getRefImageUrl(w, a),
            _sanitizeBoxKeys: (w) => this._sanitizeBoxKeys(w),
            _createSVGPath: (t, p, s, r) => this._createSVGPath(t, p, s, r),
            _createSVGCircle: (p, s) => this._createSVGCircle(p, s)
        };
    }

    // === MAIN RENDER ===

    render() {
        const editor = this.splineEditor;
        const points = editor.points || [];

        const forceRebuild = !!this.splineEditor._forceRebuildNextRender;
        if (forceRebuild) this.splineEditor._forceRebuildNextRender = false;

        // Don't rebuild during drag operations
        if (!forceRebuild && (this.splineEditor.isDragging || this.splineEditor.isDraggingAll ||
                              this.splineEditor.isScalingAll || this.splineEditor.isRotatingAll)) {
            this.vis.render();
            // Fast path: just update positions of existing SVG elements
            if (!this._renderPending) {
                this._renderPending = true;
                requestAnimationFrame(() => {
                    this._renderPending = false;
                    this._updateActiveDotPositions();
                    // Re-attach custom SVG groups if needed
                    this._renderCustomSVGShapes();
                });
            }
            return;
        }

        this.clearLayers();

        // Clear any pending shapes from previous render cycle
        this._pendingShapes = {
            activeLines: [],
            activeDots: [],
            inactiveDots: [],
            activeBoxDots: [],
            inactiveBoxDots: [],
            activeBoxImages: [],
            inactiveBoxImages: []
        };

        // Increment render counter to force Protovis callbacks to re-evaluate
        this._renderCounter++;

        const activeWidget = this.node.layerManager.getActiveWidget();
        const allWidgets = this.node.layerManager.getSplineWidgets();
        const isDrawing = !!this.splineEditor._handdrawActive;
        const handdrawMode = this.splineEditor._handdrawMode || 'off';
        const boxPlayMode = !!this._boxPlayVisibility;

        if (boxPlayMode) {
            // Only render box layers that are visible (on === true)
            // Render in reverse order so top layers in list draw on top
            const boxWidgets = allWidgets.filter(w => w?.value?.type === 'box_layer' && w?.value?.on !== false);
            const context = this._getDrawingContext();
            [...boxWidgets].reverse().forEach(w => LayerDrawer.queueBoxManipulator(context, w));

            this._ensureActivePanelOnTop();
            this.vis.render();

            if (!this._renderPending) {
                this._renderPending = true;
                requestAnimationFrame(() => {
                    this._renderPending = false;
                    this._renderCustomSVGShapes();
                });
            }
            return;
        }

        // Render inactive layers
        // Render inactive layers in reverse order so top layers in list draw on top
        [...allWidgets].reverse().forEach(widget => {
            const treatActiveAsInactive = isDrawing && handdrawMode === 'create' && widget === activeWidget;
            if (widget !== activeWidget || treatActiveAsInactive) {
                this.drawInactiveLayer(widget);
            }
        });

        // Render active layer
        if (activeWidget && !(isDrawing && handdrawMode === 'create')) {
            this.drawActiveLayer(activeWidget);
        }

        if (this.splineEditor._handdrawActive && this.splineEditor.points?.length > 0) {
            const pseudoWidget = { value: { interpolation: 'linear', type: 'handdraw' } };
            this.drawActiveLayer(pseudoWidget);
        }

        // Ensure active panel renders on top
        this._ensureActivePanelOnTop();

        this.vis.render();

        // IMPORTANT: Render custom SVG shapes AFTER vis.render() to prevent them from being wiped
        // Use requestAnimationFrame to ensure Protovis rendering is complete
        if (!this._renderPending) {
            this._renderPending = true;
            requestAnimationFrame(() => {
                this._renderPending = false;
                this._renderCustomSVGShapes();
            });
        }

        if (!this.splineEditor._handdrawActive) {
            this.updateInactiveDash();
            this.updateActiveHanddrawDash();
        } else {
            this.updateActiveHanddrawDash();
        }
    }

    _ensureActivePanelOnTop() {
        const idx = this.vis.children.indexOf(this.activeLayerPanel);
        if (idx > -1) {
            this.vis.children.splice(idx, 1);
            this.vis.children.push(this.activeLayerPanel);
        }
    }

    clearLayers() {
        this.inactiveLayerPanels.forEach(panel => {
            const idx = this.vis.children.indexOf(panel);
            if (idx > -1) this.vis.children.splice(idx, 1);
        });

        this.inactiveLayerPanels = [];
        this.inactiveLayerMetadata = [];

        // Remove and recreate activeLayerPanel to clear Protovis cache
        const idx = this.vis.children.indexOf(this.activeLayerPanel);
        if (idx > -1) {
            this.vis.children.splice(idx, 1);
            // Force removal of associated SVG elements
            if (this.activeLayerPanel.$) {
                this.activeLayerPanel.$.remove();
            }
        }
        this.activeLayerPanel = this.vis.add(pv.Panel);

        // Clear rendered SVG groups so they can be recreated for the new layer
        if (this._renderedGroups.activeDots && this._renderedGroups.activeDots.parentNode) {
            this._renderedGroups.activeDots.parentNode.removeChild(this._renderedGroups.activeDots);
        }
        if (this._renderedGroups.activeBoxDots && this._renderedGroups.activeBoxDots.parentNode) {
            this._renderedGroups.activeBoxDots.parentNode.removeChild(this._renderedGroups.activeBoxDots);
        }
        if (this._renderedGroups.inactiveDots && this._renderedGroups.inactiveDots.parentNode) {
            this._renderedGroups.inactiveDots.parentNode.removeChild(this._renderedGroups.inactiveDots);
        }
        if (this._renderedGroups.inactiveBoxDots && this._renderedGroups.inactiveBoxDots.parentNode) {
            this._renderedGroups.inactiveBoxDots.parentNode.removeChild(this._renderedGroups.inactiveBoxDots);
        }

        // Reset the groups so new ones will be created
        this._renderedGroups = {
            activeLines: null,
            activeDots: null,
            inactiveDots: null,
            activeBoxDots: null,
            inactiveBoxDots: null,
            activeBoxImages: null,
            inactiveBoxImages: null
        };
    }
}
