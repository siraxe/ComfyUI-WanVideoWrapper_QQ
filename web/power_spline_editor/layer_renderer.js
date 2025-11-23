import { BOX_BASE_RADIUS, POINT_BASE_RADIUS } from './spline_utils.js';
import { BOX_TIMELINE_MAX_POINTS } from './canvas/canvas_constants.js';

/**
 * @class LayerRenderer
 * Handles rendering of active and inactive spline layers on the Protovis canvas.
 */
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
            activeDots: [],
            inactiveDots: [],
            activeBoxDots: [],
            inactiveBoxDots: [],
            boxImages: []
        };

        // Storage for rendered SVG groups (to re-attach after vis.render())
        this._renderedGroups = {
            activeDots: null,
            inactiveDots: null,
            activeBoxDots: null,
            inactiveBoxDots: null,
            boxImages: null
        };

        // Guard to prevent multiple requestAnimationFrame calls
        this._renderPending = false;

        // Helpers to temporarily hide spline visuals and keep box manipulators visible
        this._boxPlayVisibility = false;
        this._boxRefOnlyMode = false;

        // Cache for ref image URLs to prevent blinking during timeline scrub
        // Key format: "widgetName_refSelection" -> cached URL with timestamp
        this._refImageCache = new Map();
        // Global cache bust counter - incremented when cache is cleared to force new URLs
        this._cacheBustCounter = Date.now();
    }

    setBoxPlayVisibility(enabled) {
        this._boxPlayVisibility = !!enabled;
        const svg = this.vis?.canvas?.();
        if (!svg) return;

        // Hide/show green box squares, rotation controls, and rotation text during playback
        const boxSquares = svg.querySelectorAll('g#active-box-dots-direct > path, g#inactive-box-dots-direct > path');
        const rotationTexts = svg.querySelectorAll('g#active-box-dots-direct > g[data-rotation-text], g#inactive-box-dots-direct > g[data-rotation-text]');

        if (enabled) {
            // Hide green boxes and rotation text during playback
            boxSquares.forEach(el => {
                el.dataset.prevDisplay = el.style.display || '';
                el.style.display = 'none';
            });
            rotationTexts.forEach(el => {
                el.dataset.prevDisplay = el.style.display || '';
                el.style.display = 'none';
            });
        } else {
            // Restore visibility when not in playback
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

        // Hide other spline elements including rotation handles (circles and paths)
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
        // Hide all paths except box squares and box images
        applyToggle(Array.from(svg.querySelectorAll('path:not(#active-box-dots-direct > path):not(#inactive-box-dots-direct > path):not(#active-box-images > *)')));
        // Hide all circles (this includes rotation handle tips)
        applyToggle(Array.from(svg.querySelectorAll('circle')));
        // Hide dots from direct groups
        applyToggle(Array.from(svg.querySelectorAll('g#active-dots-direct g path, g#inactive-dots-direct g path, g#active-dots-direct g circle, g#inactive-dots-direct g circle')));
    }

    setBoxRefOnlyMode(enabled) {
        this._boxRefOnlyMode = !!enabled;
    }

    // === DIRECT SVG MANIPULATION HELPERS ===

    _updateActiveDotPositions() {
        // Fast path: update positions of existing SVG elements during drag
        if (!this._renderedGroups.activeDots && !this._renderedGroups.activeBoxDots) return;

        const currentPoints = this.splineEditor.points || [];
        const validPoints = currentPoints.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));

        // Get active widget to determine layer type
        const activeWidget = this.node.layerManager.getActiveWidget();
        const layerType = this._getLayerType(activeWidget);
        const interpolation = activeWidget?.value?.interpolation || 'linear';

        // Update active dots (circles/triangles)
        if (this._renderedGroups.activeDots) {
            const children = Array.from(this._renderedGroups.activeDots.children);
            children.forEach((element, idx) => {
                if (idx >= validPoints.length) return;
                const point = validPoints[idx];

                if (element.tagName === 'circle') {
                    element.setAttribute('cx', point.x);
                    element.setAttribute('cy', point.y);
                } else if (element.tagName === 'path') {
                    // For paths (triangles), recalculate rotation for first point
                    let rotationDeg = 0;
                    if (idx === 0 && validPoints.length > 1 && layerType === 'normal' && interpolation !== 'points') {
                        const dx = validPoints[1].x - validPoints[0].x;
                        const dy = validPoints[1].y - validPoints[0].y;
                        const rotationRad = (dx !== 0 || dy !== 0) ? (Math.atan2(dy, dx) - Math.PI / 2 + Math.PI + 2 * Math.PI) % (2 * Math.PI) : 0;
                        rotationDeg = rotationRad * (180 / Math.PI);
                    }
                    element.setAttribute('transform', `translate(${point.x},${point.y}) rotate(${rotationDeg})`);
                }
            });
        }

        // Update active box dots (squares) and rotation text
        if (this._renderedGroups.activeBoxDots) {
            const children = Array.from(this._renderedGroups.activeBoxDots.children);
            const activeWidget = this.node.layerManager.getActiveWidget();
            const radius = validPoints.length > 0 ? BOX_BASE_RADIUS * this.getPointScale(validPoints[0], true) : BOX_BASE_RADIUS;

            children.forEach((element, idx) => {
                if (element.tagName === 'path' && idx < validPoints.length) {
                    const point = validPoints[idx];
                    const rotationRad = this._getBoxRotationValue(point);
                    const rotationDeg = rotationRad * (180 / Math.PI);
                    element.setAttribute('transform', `translate(${point.x},${point.y}) rotate(${rotationDeg})`);
                } else if (element.tagName === 'g' && element.hasAttribute('data-rotation-text') && validPoints.length > 0) {
                    // Update rotation text group
                    const point = validPoints[0];
                    const rotationRad = this._getBoxRotationValue(point);
                    const rotationDeg = rotationRad * (180 / Math.PI);

                    // Update group position
                    element.setAttribute('transform', `translate(${point.x},${point.y})`);

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
        if (this._renderedGroups.boxImages) {
            const images = Array.from(this._renderedGroups.boxImages.children);
            if (validPoints.length > 0 && images.length > 0) {
                const point = validPoints[0];
                const rotationDeg = this._getBoxRotationValue(point) * (180 / Math.PI);
                images.forEach((imgEl) => {
                    imgEl.setAttribute('transform', `translate(${point.x},${point.y}) rotate(${rotationDeg})`);
                });
            }
        }
    }

    _renderCustomSVGShapes() {
        const canvas = this.vis.canvas();
        if (!canvas) return;

        const svg = canvas.tagName === 'svg' ? canvas : canvas.querySelector('svg');
        if (!svg) return;

        const hasPendingShapes = this._pendingShapes.activeDots.length > 0 ||
                                 this._pendingShapes.inactiveDots.length > 0 ||
                                 this._pendingShapes.activeBoxDots.length > 0 ||
                                 this._pendingShapes.inactiveBoxDots.length > 0 ||
                                 this._pendingShapes.boxImages.length > 0;

        // If we have pending shapes, create new groups
        if (hasPendingShapes) {
            // Create active dots group
            if (this._pendingShapes.activeDots.length > 0) {
                // Remove old group if it exists
                if (this._renderedGroups.activeDots && this._renderedGroups.activeDots.parentNode) {
                    this._renderedGroups.activeDots.parentNode.removeChild(this._renderedGroups.activeDots);
                }
                const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                group.setAttribute('id', 'active-dots-direct');
                this._pendingShapes.activeDots.forEach(shape => group.appendChild(shape));
                this._renderedGroups.activeDots = group;
            }

            // Create inactive dots group
            if (this._pendingShapes.inactiveDots.length > 0) {
                // Remove old group if it exists
                if (this._renderedGroups.inactiveDots && this._renderedGroups.inactiveDots.parentNode) {
                    this._renderedGroups.inactiveDots.parentNode.removeChild(this._renderedGroups.inactiveDots);
                }
                const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                group.setAttribute('id', 'inactive-dots-direct');
                this._pendingShapes.inactiveDots.forEach(shape => group.appendChild(shape));
                this._renderedGroups.inactiveDots = group;
            }

            // Create active box dots group
            if (this._pendingShapes.activeBoxDots.length > 0) {
                // Remove old group if it exists
                if (this._renderedGroups.activeBoxDots && this._renderedGroups.activeBoxDots.parentNode) {
                    this._renderedGroups.activeBoxDots.parentNode.removeChild(this._renderedGroups.activeBoxDots);
                }
                const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                group.setAttribute('id', 'active-box-dots-direct');
                this._pendingShapes.activeBoxDots.forEach(shape => group.appendChild(shape));
                this._renderedGroups.activeBoxDots = group;
            }

            // Create inactive box dots group
            if (this._pendingShapes.inactiveBoxDots.length > 0) {
                // Remove old group if it exists
                if (this._renderedGroups.inactiveBoxDots && this._renderedGroups.inactiveBoxDots.parentNode) {
                    this._renderedGroups.inactiveBoxDots.parentNode.removeChild(this._renderedGroups.inactiveBoxDots);
                }
                const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                group.setAttribute('id', 'inactive-box-dots-direct');
                this._pendingShapes.inactiveBoxDots.forEach(shape => group.appendChild(shape));
                this._renderedGroups.inactiveBoxDots = group;
            }

            // Create box images group
            if (this._pendingShapes.boxImages.length > 0) {
                if (this._renderedGroups.boxImages && this._renderedGroups.boxImages.parentNode) {
                    this._renderedGroups.boxImages.parentNode.removeChild(this._renderedGroups.boxImages);
                }
                const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                group.setAttribute('id', 'active-box-images');
                this._pendingShapes.boxImages.forEach(shape => group.appendChild(shape));
                this._renderedGroups.boxImages = group;
            }

            // Clear pending shapes
            this._pendingShapes = {
                activeDots: [],
                inactiveDots: [],
                activeBoxDots: [],
                inactiveBoxDots: [],
                boxImages: []
            };
        }

        // ALWAYS re-attach rendered groups to SVG to ensure they're on top
        // We need to remove and re-append even if they're already in the SVG
        // to ensure they render above Protovis elements
        if (this._renderedGroups.inactiveDots) {
            if (this._renderedGroups.inactiveDots.parentNode) {
                this._renderedGroups.inactiveDots.parentNode.removeChild(this._renderedGroups.inactiveDots);
            }
            svg.appendChild(this._renderedGroups.inactiveDots);
        }
        if (this._renderedGroups.inactiveBoxDots) {
            if (this._renderedGroups.inactiveBoxDots.parentNode) {
                this._renderedGroups.inactiveBoxDots.parentNode.removeChild(this._renderedGroups.inactiveBoxDots);
            }
            svg.appendChild(this._renderedGroups.inactiveBoxDots);
        }
        if (this._renderedGroups.activeDots) {
            if (this._renderedGroups.activeDots.parentNode) {
                this._renderedGroups.activeDots.parentNode.removeChild(this._renderedGroups.activeDots);
            }
            svg.appendChild(this._renderedGroups.activeDots);
        }
        if (this._renderedGroups.activeBoxDots) {
            if (this._renderedGroups.activeBoxDots.parentNode) {
                this._renderedGroups.activeBoxDots.parentNode.removeChild(this._renderedGroups.activeBoxDots);
            }
            svg.appendChild(this._renderedGroups.activeBoxDots);
        }
        if (this._renderedGroups.boxImages) {
            if (this._renderedGroups.boxImages.parentNode) {
                this._renderedGroups.boxImages.parentNode.removeChild(this._renderedGroups.boxImages);
            }
            svg.appendChild(this._renderedGroups.boxImages);
        }
    }

    _getOrCreateSVGGroup(groupId) {
        let canvas = this.vis.canvas();

        if (!canvas) {
            console.warn('[WARN] Canvas not found for group:', groupId);
            return null;
        }

        // Protovis returns a SPAN that contains the SVG, not the SVG itself
        let svg = canvas.tagName === 'svg' ? canvas : canvas.querySelector('svg');
        if (!svg) {
            console.warn('[WARN] SVG element not found in canvas for group:', groupId);
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

    _createSVGPath(shapeType, point, styles, rotation = 0) {
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
        path.setAttribute('transform', `translate(${point.x},${point.y}) rotate(${rotationDeg})`);
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

    _createSVGCircle(point, styles) {
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', point.x);
        circle.setAttribute('cy', point.y);
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

    // === SCALE & GEOMETRY HELPERS ===
    _getLayerType(widget) {
        const type = widget?.value?.type;
        const result = type === 'handdraw' ? 'handdraw' : (type === 'box_layer' ? 'box' : 'normal');
        return result;
    }

    _normalizeInterpolation(interpolation, layerType) {
        const raw = interpolation || 'linear';
        if (layerType !== 'box' && raw === 'box') return 'points';
        return raw;
    }

    _getLayerStyles(layerType, state, isPointMode = false, isOff = false) {
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

    _getSelectedRefAttachment(widget) {
        const ref = widget?.value?.ref_attachment;
        const selection = widget?.value?.ref_selection || 'no_ref';
        if (!ref || selection === 'no_ref') return null;

        // New multi-entry format
        if (Array.isArray(ref.entries)) {
            const parts = selection.split('_');
            const idx = parts.length > 1 ? parseInt(parts[1], 10) : 1;
            const arrayIndex = Number.isFinite(idx) ? Math.max(0, idx - 1) : 0;
            return ref.entries[arrayIndex] || null;
        }

        // Legacy single entry
        if (ref.base64) return ref;
        return null;
    }

    _getRefImageUrl(widget, attachment) {
        if (!attachment) return null;

        // For base64, return directly (no caching needed)
        if (attachment.base64) {
            return `data:${attachment.type || 'image/png'};base64,${attachment.base64}`;
        }

        // For path-based images, use cache to prevent blinking during timeline scrub
        if (attachment.path) {
            const widgetName = widget?.value?.name || widget?.name || 'unknown';
            const selection = widget?.value?.ref_selection || 'no_ref';
            // Include attachment name/path in cache key to differentiate between different ref images
            const attachmentId = attachment.name || attachment.path;
            const cacheKey = `${widgetName}_${selection}_${attachmentId}`;

            // Check if we have a cached URL for this widget+selection+attachment
            if (!this._refImageCache.has(cacheKey)) {
                // Create new URL with cache bust counter to force browser refresh when cache is cleared
                // Using cacheBustCounter ensures all URLs get new timestamps when clearRefImageCache() is called
                const url = new URL(`${attachment.path}?v=${this._cacheBustCounter}`, import.meta.url).href;
                this._refImageCache.set(cacheKey, url);
            }

            return this._refImageCache.get(cacheKey);
        }

        return null;
    }

    clearRefImageCache() {
        this._refImageCache.clear();
        // Update cache bust counter to ensure new URLs are generated with fresh timestamps
        // Add random component to make it even more unique and bypass aggressive browser caching
        this._cacheBustCounter = Date.now() + Math.random().toString(36).substring(2, 9);
    }

    clampPointScale(value) {
        return (typeof value === 'number' && !Number.isNaN(value)) 
            ? Math.max(0.2, Math.min(3.0, value)) 
            : 1;
    }

    getPointScale(point, forBox = false) {
        if (!point) return 1;
        if (forBox && typeof point.boxScale === 'number') return this.clampPointScale(point.boxScale);
        if (!forBox && typeof point.pointScale === 'number') return this.clampPointScale(point.pointScale);
        if (typeof point.scale === 'number') return this.clampPointScale(point.scale);
        return 1;
    }

    _getBoxRotationValue(point) {
        if (!point) return 0;
        if (typeof point.boxRotation === 'number' && !Number.isNaN(point.boxRotation)) return point.boxRotation;
        if (typeof point.rotation === 'number' && !Number.isNaN(point.rotation)) return point.rotation;
        return 0;
    }

    _computeBoxHandleGeometry(point) {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
        
        const rotation = this._getBoxRotationValue(point);
        const radius = BOX_BASE_RADIUS * this.getPointScale(point, true);
        if (!Number.isFinite(radius)) return null;
        
        const extra = Math.max(18, radius * 0.5);
        const rotatePoint = (px, py) => ({
            x: point.x + px * Math.cos(rotation) - py * Math.sin(rotation),
            y: point.y + px * Math.sin(rotation) + py * Math.cos(rotation),
        });
        
        return {
            base: rotatePoint(0, -radius),
            tip: rotatePoint(0, -radius - extra),
        };
    }

    // === DASH ANIMATION ===

    updateInactiveDash() {
        if (!this.splineEditor) return;
        const svg = this.vis?.canvas?.();
        if (!svg) return;

        // If disabled, clean up and return
        if (this.splineEditor._inactiveFlowEnabled === false) {
            this._removeDashStyling(svg);
            return;
        }

        // Throttle updates
        const now = Date.now();
        const minInterval = this.splineEditor._handdrawActive ? 120 : 60;
        const needsInitialApply = this._needsInitialDashApply(svg);
        
        if (!needsInitialApply && (now - this._lastDashUpdateMs < minInterval)) return;
        this._lastDashUpdateMs = now;

        this._applyDashAnimation(svg);
    }

    _removeDashStyling(svg) {
        const paths = svg.getElementsByTagName('path');
        for (const p of paths) {
            p.removeAttribute('stroke-dasharray');
            p.removeAttribute('stroke-dashoffset');
            if (p.dataset) delete p.dataset.dashOffset;
        }
    }

    _needsInitialDashApply(svg) {
        const paths = svg.getElementsByTagName('path');
        for (const el of paths) {
            const stroke = (el.getAttribute('stroke') || '').toLowerCase();
            const sw = Number(el.getAttribute('stroke-width') || '0');
            if (this._isInactiveStroke(stroke) && sw > 1 && !el.hasAttribute('stroke-dasharray')) {
                return true;
            }
        }
        return false;
    }

    _isInactiveStroke(stroke) {
        return stroke.includes('120,70,180') || stroke.includes('#7846b4') || 
               stroke.includes('255,127,14') || stroke.includes('#ff7f0e');
    }

    _applyDashAnimation(svg) {
        const paths = Array.from(svg.getElementsByTagName('path'));
        const phase = ((this._dashAnimOffset % 200) / 200);

        const { purple: purplePaths, orange: orangePaths } = this._categorizePaths(paths);
        const purpleMetas = this.inactiveLayerMetadata.filter(d => d?.widget?.value?.type === 'handdraw');
        const orangeMetas = this.inactiveLayerMetadata.filter(d => {
            const interp = d?.widget?.value?.interpolation || 'linear';
            const layerType = d?.widget?.value?.type || d?.widget?.type || '';
            // Never dash box layers or points-mode layers
            if (layerType === 'box_layer' || layerType === 'box') return false;
            return layerType !== 'handdraw' && interp !== 'points' && interp !== 'box';
        });

        this._applyDashForPaths(purplePaths, purpleMetas, phase);
        this._applyDashForPaths(orangePaths, orangeMetas, phase);
    }

    _categorizePaths(paths) {
        const purple = [], orange = [];
        const norm = s => (s || '').replace(/\s+/g, '').toLowerCase();

        for (const p of paths) {
            if (!this._isInactiveTargetPath(p)) continue;
            
            const stroke = norm(p.getAttribute('stroke'));
            const isPurple = stroke.includes('120,70,180') || stroke.includes('#7846b4');
            const len = (typeof p.getTotalLength === 'function') ? p.getTotalLength() : 0;
            
            (isPurple ? purple : orange).push({ p, len });
        }
        
        return { purple, orange };
    }

    _isInactiveTargetPath(p) {
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

    _applyDashForPaths(pairs, metas, phase) {
        const count = Math.min(pairs.length, metas.length);
        
        for (let idx = 0; idx < count; idx++) {
            const { p, len: pathLength } = pairs[idx];
            const easingMode = metas[idx]?.widget?.value?.easing || 'linear';
            const pattern = this._generateDashPattern(pathLength, phase, easingMode);
            
            p.setAttribute('stroke-dasharray', pattern.join(' '));
            p.setAttribute('stroke-dashoffset', String(-phase * (pathLength || 1)));
        }
    }

    _generateDashPattern(pathLength, phase, easingMode) {
        const segments = Math.max(14, Math.min(100, Math.round(pathLength / 36)));
        const baseDash = 10, baseGap = 6;
        const minFactor = 0.25, maxFactor = 1.6;
        const pattern = [];
        let sum = 0;

        for (let i = 0; i < segments; i++) {
            const t = (i / segments + phase) % 1;
            const f = this._easeValue(t, easingMode);
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

    _easeValue(t, mode) {
        t = Math.max(0, Math.min(1, t));
        switch (mode) {
            case 'in': return t;
            case 'out': return 1 - t;
            case 'in_out': return Math.sin(Math.PI * t);
            case 'out_in': return 1 - Math.sin(Math.PI * t);
            default: return 1;
        }
    }

    updateActiveHanddrawDash() {
        if (!this.splineEditor || this.splineEditor._inactiveFlowEnabled === false) return;

        const now = Date.now();
        const minInterval = this.splineEditor._handdrawActive ? 120 : 60;
        if ((this._lastDashUpdateMs || 0) && (now - this._lastDashUpdateMs < minInterval)) return;
        this._lastDashUpdateMs = now;

        const svg = this.vis?.canvas?.();
        if (!svg) return;

        const active = this.node?.layerManager?.getActiveWidget?.();
        if (!active || active.value?.type !== 'handdraw') return;

        const easingMode = active.value?.easing || 'linear';
        const phase = ((this._dashAnimOffset % 200) / 200);
        const paths = svg.getElementsByTagName('path');
        const norm = s => (s || '').replace(/\s+/g, '').toLowerCase();

        for (const p of paths) {
            const stroke = norm(p.getAttribute('stroke'));
            if (stroke !== '#d7c400') continue;

            const pathLength = (typeof p.getTotalLength === 'function') ? p.getTotalLength() : 0;
            const pattern = this._generateActiveHanddrawPattern(pathLength, phase, easingMode);
            
            p.setAttribute('stroke-dasharray', pattern.join(' '));
            p.setAttribute('stroke-dashoffset', String(-phase * (pathLength || 1)));
        }
    }

    _generateActiveHanddrawPattern(pathLength, phase, easingMode) {
        const segments = Math.max(14, Math.min(100, Math.round(pathLength / 36)));
        const baseDash = 10, baseGap = 6;
        const minFactor = 0.35, maxFactor = 1.45;
        const pattern = [];
        let sum = 0;

        for (let i = 0; i < segments; i++) {
            const t = (i / segments + phase) % 1;
            const f = this._easeValue(t, easingMode);
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

    // === MAIN RENDER ===

    render() {
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
            activeDots: [],
            inactiveDots: [],
            activeBoxDots: [],
            inactiveBoxDots: [],
            boxImages: []
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
            const boxWidgets = allWidgets.filter(w => w?.value?.type === 'box_layer' && w?.value?.on !== false);
            boxWidgets.forEach(w => this._queueBoxManipulator(w));

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
        allWidgets.forEach(widget => {
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

        // NOTE: We no longer need to clear cached paths since we're using direct SVG manipulation
        // Our custom SVG groups handle their own clearing in each draw function

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

        const svg = this.vis.canvas();
        if (svg) {
            const paths = svg.querySelectorAll('path[transform]');
            const circles = svg.querySelectorAll('circle');
            const customGroups = svg.querySelectorAll('g[id$="-direct"]');
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
        // Note: This is safe because clearLayers() is only called during full rebuilds,
        // not during drag operations (which use the fast path in render())
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
            activeDots: null,
            inactiveDots: null,
            activeBoxDots: null,
            inactiveBoxDots: null
        };
    }

    // === ACTIVE LAYER DRAWING ===

    drawActiveLayer(widget) {
        const points = Array.isArray(this.splineEditor.points) ? this.splineEditor.points : [];
        const hasPoints = points.length > 0;
        const layerType = this._getLayerType(widget);
        const isBoxLayer = layerType === 'box';
        const safePoints = hasPoints
            ? points.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))
            : [];

        // For non-box layers, we need points to render anything
        if (!safePoints.length && !isBoxLayer) return;

        // Strictly determine interpolation based on widget type to prevent bleeding
        const interpolation = isBoxLayer
            ? (widget.value.interpolation || 'linear')
            : this._normalizeInterpolation(widget.value.interpolation, layerType);

        const isPointMode = layerType === 'box' ? true : interpolation === 'points';
        const styles = this._getLayerStyles(layerType, 'active', isPointMode);

        // Draw lines and dots for regular spline layers (not box layers)
        if (hasPoints && !isBoxLayer) {
            this._drawActiveLine(interpolation, isPointMode, layerType, styles);
            this._drawActiveDots(interpolation, isPointMode, layerType, styles, points);
        }

        if (isBoxLayer) {
            // First: Draw the current interpolated box visualization
            // We pass the widget, but we WON'T pass safePoints anymore.
            // The function will fetch them fresh.
            this._drawCurrentBoxVisualization(widget);
            
            // Second: Draw the box layer keyframe timeline visualization (red dots and connecting lines)
            this._drawBoxKeyPath(this.activeLayerPanel, widget, true);
            
            // Third: Get the actual keyframe points from box_keys for rotation handles and green center dots
            const sortedKeys = this._sanitizeBoxKeys(widget);
            if (sortedKeys.length > 0) {
                const keyframeNormPoints = sortedKeys.map(k => ({ x: k.x, y: k.y }));
                const keyframeDenormPoints = this._safeDenormalizePoints(keyframeNormPoints);
                
                if (keyframeDenormPoints && keyframeDenormPoints.length > 0) {
                    const validKeyframePoints = keyframeDenormPoints.filter(p => 
                        p && Number.isFinite(p.x) && Number.isFinite(p.y)
                    );
                    
                    if (validKeyframePoints.length > 0) {
                        // Temporarily removed rotation handles for all keyframes to avoid visual duplication
                        // with orange keyframe indicators. Will be added back with hover-based display.
                        // this._drawBoxRotationHandles(this.activeLayerPanel, validKeyframePoints, sortedKeys);
                        // Note: Removed duplicate green center dots as they conflict with orange keyframe indicators
                    }
                }
            }
            
            // Fourth: Draw the preview hover state
            this._drawBoxPreview(widget);
        }
    }

    _drawCurrentBoxVisualization(widget) {
        const styles = this._getLayerStyles('box', 'active', true, false);

        // HELPER: Fetch fresh points directly from the source
        const getFreshBoxPoints = () => {
            const rawPoints = this.splineEditor.points || [];
            return rawPoints.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
        };

        const pts = getFreshBoxPoints();
        const sortedPoints = [...pts].sort((a, b) =>
            this.splineEditor.getBoxPointRadius(b) - this.splineEditor.getBoxPointRadius(a)
        );

        // 1. Queue the GREEN SQUARES
        const attachment = this._getSelectedRefAttachment(widget);

        // During preview mode (_boxRefOnlyMode), don't render green boxes or rotation controls
        if (!this._boxRefOnlyMode) {
            sortedPoints.forEach((dot, index) => {
                const radius = BOX_BASE_RADIUS * this.getPointScale(dot, true);
                const rotation = this._getBoxRotationValue(dot);

                const svgStyles = {
                    radius: radius,
                    stroke: styles.pointStroke || "#139613",
                    strokeWidth: styles.lineWidth || 2,
                    fill: styles.pointFill || "rgba(19, 150, 19, 0.1)",
                    cursor: "default"
                };

                const element = this._createSVGPath('square', dot, svgStyles, rotation);
                if (element) {
                    // Add event handlers
                    element.addEventListener('mousedown', (e) => {
                        if (this.splineEditor.handlePointPointerDown) {
                            this.splineEditor.handlePointPointerDown(dot, e);
                        }
                    });
                    element.addEventListener('mouseover', (e) => {
                        if (this.splineEditor.mouseOverHandler) {
                            this.splineEditor.mouseOverHandler.call(dot);
                        }
                    });
                    element.addEventListener('mouseout', (e) => {
                        if (this.splineEditor.mouseOutHandler) {
                            this.splineEditor.mouseOutHandler.call(dot);
                        }
                    });
                    // Queue for rendering after vis.render()
                    this._pendingShapes.activeBoxDots.push(element);
                }

                // Add rotation text display (green with 60% opacity) - only for first box
                if (index === 0) {
                    const rotationRad = this._getBoxRotationValue(dot);
                    const rotationDeg = rotationRad * (180 / Math.PI);

                    // Create a group to hold the text so we can position it correctly
                    const textGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                    textGroup.setAttribute('data-rotation-text', 'true');

                    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                    // Position at top-left corner of the box (relative to box center)
                    const offsetX = -radius;
                    const offsetY = -radius - 5;
                    text.setAttribute('x', offsetX);
                    text.setAttribute('y', offsetY);
                    text.setAttribute('fill', 'rgba(19, 150, 19, 0.6)'); // Green with 60% opacity
                    text.setAttribute('font-size', '14');
                    text.setAttribute('font-family', 'monospace');
                    text.setAttribute('font-weight', 'bold');
                    text.setAttribute('text-anchor', 'start');
                    text.setAttribute('pointer-events', 'none');
                    text.textContent = `${rotationDeg.toFixed(1)}°`;

                    textGroup.appendChild(text);
                    textGroup.setAttribute('transform', `translate(${dot.x},${dot.y})`);
                    textGroup.style.pointerEvents = 'none';

                    this._pendingShapes.activeBoxDots.push(textGroup);
                }
            });

            // Draw rotation handle and center dot when not in ref-only mode
            this._drawCurrentBoxRotationHandle(() => {
                const pts = getFreshBoxPoints();
                return pts.length > 0 ? pts[0] : null;
            }, styles);

            this._drawCurrentBoxCenterDot(() => {
                const pts = getFreshBoxPoints();
                return pts.length > 0 ? pts[0] : null;
            }, styles);
        }

        // Queue attached reference image (fit inside box, preserve aspect)
        if (attachment && (attachment.base64 || attachment.path) && sortedPoints.length > 0) {
            const point = sortedPoints[0];
            const boxRadius = BOX_BASE_RADIUS * this.getPointScale(point, true);
            const boxSize = boxRadius * 2;
            const imgW = Math.max(1, attachment.width || boxSize);
            const imgH = Math.max(1, attachment.height || boxSize);
            const scale = Math.min(boxSize / imgW, boxSize / imgH);
            const renderW = imgW * scale;
            const renderH = imgH * scale;
            const rotationDeg = this._getBoxRotationValue(point) * (180 / Math.PI);

            const image = document.createElementNS('http://www.w3.org/2000/svg', 'image');
            // Use cached URL to prevent blinking during timeline scrub
            const imageHref = this._getRefImageUrl(widget, attachment);
            if (!imageHref) return; // Skip if no valid image source

            // Force image reload by setting href to empty first, then to actual URL
            // This prevents browser from using stale cached image data
            image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '');
            image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', imageHref);

            image.setAttribute('width', renderW);
            image.setAttribute('height', renderH);
            image.setAttribute('x', -renderW / 2);
            image.setAttribute('y', -renderH / 2);
            image.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            image.setAttribute('transform', `translate(${point.x},${point.y}) rotate(${rotationDeg})`);
            image.style.pointerEvents = 'none';
            image.style.opacity = '0.6';
            // Store cache bust version to track if image needs updating
            image.dataset.cacheBustVersion = this._cacheBustCounter;

            this._pendingShapes.boxImages.push(image);
        }
    }

    _drawCurrentBoxRotationHandle(pointGetter, styles = {}) {
        // 1. Draw handle line (Stem)
        this.activeLayerPanel.add(pv.Line)
            .data(() => {
                // Only render if current layer is still a box layer
                const activeWidget = this.node.layerManager.getActiveWidget();
                if (this._getLayerType(activeWidget) !== 'box') return [];

                const point = pointGetter(); // <--- Dynamic lookup
                const geom = this._computeBoxHandleGeometry(point);
                return geom ? [geom.base, geom.tip] : [];
            })
            .left(d => d.x)
            .top(d => d.y)
            .strokeStyle(styles.pointStroke || '#2df26d')
            .lineWidth(styles.lineWidth || 2);

        // 2. Draw handle tip (Circle)
        this.activeLayerPanel.add(pv.Dot)
            .data(() => {
                // Only render if current layer is still a box layer
                const activeWidget = this.node.layerManager.getActiveWidget();
                if (this._getLayerType(activeWidget) !== 'box') return [];

                const point = pointGetter(); // <--- Dynamic lookup
                const geom = this._computeBoxHandleGeometry(point);
                return geom ? [{ point, tip: geom.tip }] : [];
            })
            .left(d => d.tip.x)
            .top(d => d.tip.y)
            .shape('circle')
            .radius(5)
            .fillStyle(styles.pointFill || 'rgba(45, 242, 109, 0.9)')
            .strokeStyle(styles.pointStroke || '#064f1c')
            .lineWidth(1.5)
            .cursor('grab')
            .event("mousedown", (d) => {
                const idx = this.splineEditor.resolvePointIndex?.(d.point) ?? this.splineEditor.points.indexOf(d.point);
                if (idx >= 0 && this.splineEditor.startBoxRotationDrag) {
                    this.splineEditor.startBoxRotationDrag(idx, pv.event);
                }
            });
    }

    _drawCurrentBoxCenterDot(pointGetter, styles = {}) {
        this.activeLayerPanel.add(pv.Dot)
            .data(() => {
                // Only render if current layer is still a box layer
                const activeWidget = this.node.layerManager.getActiveWidget();
                if (this._getLayerType(activeWidget) !== 'box') return [];

                const point = pointGetter(); // <--- Dynamic lookup
                return point ? [point] : [];
            })
            .left(d => d.x)
            .top(d => d.y)
            .shape('circle')
            .radius(3)
            .fillStyle(styles.pointFill || '#2df26d')
            .strokeStyle(styles.pointStroke || '#064f1c')
            .lineWidth(1)
            .events('none');
    }

    _queueBoxManipulator(widget) {
        if (!widget || widget?.value?.type !== 'box_layer') return;
        const editor = this.splineEditor;
        const maxFrames = editor?._getMaxFrames ? editor._getMaxFrames() : BOX_TIMELINE_MAX_POINTS;
        const frame = Math.max(1, Math.min(maxFrames, Math.round(widget.value?.box_timeline_point || 1)));
        const normalized = editor?._computeBoxLayerPosition
            ? editor._computeBoxLayerPosition(widget, frame)
            : { x: 0.5, y: 0.5, scale: 1, rotation: 0 };
        const denorm = editor?.denormalizePoints
            ? editor.denormalizePoints([{ x: normalized.x ?? 0.5, y: normalized.y ?? 0.5 }])
            : [{ x: 0, y: 0 }];
        const point = denorm[0] || { x: 0, y: 0 };
        point.boxScale = this.clampPointScale(normalized.scale ?? 1);
        point.scale = point.boxScale;
        point.boxRotation = (typeof normalized.rotation === 'number' && !Number.isNaN(normalized.rotation)) ? normalized.rotation : 0;

        const styles = this._getLayerStyles('box', 'active', true, false);
        const radius = BOX_BASE_RADIUS * this.getPointScale(point, true);
        const svgStyles = {
            radius,
            stroke: styles.pointStroke || "#139613",
            strokeWidth: styles.lineWidth || 2,
            fill: styles.pointFill || "rgba(19, 150, 19, 0.1)",
            cursor: "default"
        };
        const attachment = this._getSelectedRefAttachment(widget);

        // During preview mode (_boxRefOnlyMode), don't render green boxes or rotation text
        if (!this._boxRefOnlyMode) {
            const element = this._createSVGPath('square', point, svgStyles, this._getBoxRotationValue(point));
            if (element) {
                element.style.pointerEvents = 'none';
                this._pendingShapes.activeBoxDots.push(element);
            }

            // Add rotation text display (green with 60% opacity)
            const rotationRad = this._getBoxRotationValue(point);
            const rotationDeg = rotationRad * (180 / Math.PI);

            // Create a group to hold the text so we can position it correctly
            const textGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            textGroup.setAttribute('data-rotation-text', 'true');

            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            // Position at top-left corner of the box (relative to box center)
            const offsetX = -radius;
            const offsetY = -radius - 5;
            text.setAttribute('x', offsetX);
            text.setAttribute('y', offsetY);
            text.setAttribute('fill', 'rgba(19, 150, 19, 0.6)'); // Green with 60% opacity
            text.setAttribute('font-size', '14');
            text.setAttribute('font-family', 'monospace');
            text.setAttribute('font-weight', 'bold');
            text.setAttribute('text-anchor', 'start');
            text.setAttribute('pointer-events', 'none');
            text.textContent = `${rotationDeg.toFixed(1)}°`;

            textGroup.appendChild(text);
            textGroup.setAttribute('transform', `translate(${point.x},${point.y})`);
            textGroup.style.pointerEvents = 'none';

            this._pendingShapes.activeBoxDots.push(textGroup);
        }

        // Render attached reference image if it exists
        if (attachment && (attachment.base64 || attachment.path)) {
            const boxSize = radius * 2;
            const imgW = Math.max(1, attachment.width || boxSize);
            const imgH = Math.max(1, attachment.height || boxSize);
            const scale = Math.min(boxSize / imgW, boxSize / imgH);
            const renderW = imgW * scale;
            const renderH = imgH * scale;
            const rotationDeg = this._getBoxRotationValue(point) * (180 / Math.PI);

            const image = document.createElementNS('http://www.w3.org/2000/svg', 'image');
            // Use cached URL to prevent blinking during timeline scrub
            const imageHref = this._getRefImageUrl(widget, attachment);
            if (!imageHref) return; // Skip if no valid image source

            // Force image reload by setting href to empty first, then to actual URL
            // This prevents browser from using stale cached image data
            image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '');
            image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', imageHref);

            image.setAttribute('width', renderW);
            image.setAttribute('height', renderH);
            image.setAttribute('x', -renderW / 2);
            image.setAttribute('y', -renderH / 2);
            image.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            image.setAttribute('transform', `translate(${point.x},${point.y}) rotate(${rotationDeg})`);
            image.style.pointerEvents = 'none';
            image.style.opacity = '0.6';
            // Store cache bust version to track if image needs updating
            image.dataset.cacheBustVersion = this._cacheBustCounter;

            this._pendingShapes.boxImages.push(image);
        }
    }

    _drawActiveLine(interpolation, isPointMode, layerType, styles) {
        if (layerType === 'box') return; // Box layers render via box helpers only
        // We ignore the passed 'safePoints' and fetch fresh ones inside .data()
        this.activeLayerPanel.add(pv.Line)
            .data(() => {
                const currentPoints = this.splineEditor.points || [];
                const validPoints = currentPoints.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));

                // If we don't have points, or if this is actually a box layer
                // (but the renderer got confused), return empty to hide the line.
                const activeWidget = this.node.layerManager.getActiveWidget();
                const activeType = this._getLayerType(activeWidget);
                if (activeType === 'box') return [];

                return this._prepareLineData(validPoints, interpolation, isPointMode);
            })
            .left(d => d.x)
            .top(d => d.y)
            .interpolate(() => isPointMode ? 'linear' : interpolation)
            .strokeStyle(() => styles.lineStroke)
            .lineWidth(() => styles.lineWidth);
    }

    _prepareLineData(safePoints, interpolation, isPointMode) {
        if (isPointMode || interpolation === 'linear') return safePoints;

        const hasHighlighted = safePoints.some(p => p.highlighted);
        if (!hasHighlighted) return safePoints;

        // Insert helper points around highlighted points for linear segments
        const result = [];
        for (let i = 0; i < safePoints.length; i++) {
            const point = safePoints[i];
            
            if (point.highlighted) {
                if (i > 0) {
                    const prev = safePoints[i - 1];
                    const dx = point.x - prev.x, dy = point.y - prev.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    const offset = Math.min(0.01, 1 / dist);
                    result.push({ x: prev.x + dx * (1 - offset), y: prev.y + dy * (1 - offset) });
                }
                
                result.push(point);
                
                if (i < safePoints.length - 1) {
                    const next = safePoints[i + 1];
                    const dx = next.x - point.x, dy = next.y - point.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    const offset = Math.min(0.01, 1 / dist);
                    result.push({ x: point.x + dx * offset, y: point.y + dy * offset });
                }
            } else {
                result.push(point);
            }
        }
        return result;
    }

    _drawActiveDots(interpolation, isPointMode, layerType, styles, allPoints) {
        if (layerType === 'box') return; // Box layers use box-specific drawing

        // Get current points
        const currentPoints = this.splineEditor.points || [];
        const validPoints = currentPoints.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));

        // Queue SVG elements for each point (will be rendered after vis.render())
        validPoints.forEach((point, idx) => {
            const shape = this._getDotShape(point, interpolation, layerType, idx);
            const strokeStyle = this._getDotStrokeStyle(point, interpolation, isPointMode, layerType, styles, validPoints);
            const fillStyle = this._getDotFillStyle(point, interpolation, isPointMode, layerType, styles, validPoints);

            const svgStyles = {
                radius: styles.pointRadius || 6,
                stroke: strokeStyle,
                strokeWidth: styles.strokeWidth || styles.lineWidth || 3,
                fill: fillStyle || 'none',
                cursor: isPointMode ? 'default' : 'move'
            };

            let element;
            if (shape === 'circle') {
                element = this._createSVGCircle(point, svgStyles);
            } else if (shape === 'triangle' || shape === 'square') {
                const rotation = this._getDotAngle(point, interpolation, layerType);
                element = this._createSVGPath(shape, point, svgStyles, rotation);
            }

            if (element) {
                // Add event handlers
                element.addEventListener('mousedown', (e) => {
                    if (this.splineEditor.handlePointPointerDown) {
                        this.splineEditor.handlePointPointerDown(point, e);
                    }
                });
                element.addEventListener('mouseover', (e) => {
                    if (this.splineEditor.mouseOverHandler) {
                        this.splineEditor.mouseOverHandler.call(this.splineEditor, point);
                    }
                });
                element.addEventListener('mouseout', (e) => {
                    if (this.splineEditor.mouseOutHandler) {
                        this.splineEditor.mouseOutHandler.call(this.splineEditor, point);
                    }
                });

                // Queue for rendering after vis.render()
                this._pendingShapes.activeDots.push(element);
            }
        });
    }

    _getDotRadius(dot, interpolation, layerType, styles) {
        if (layerType === 'handdraw') return styles.pointRadius || 2;
        if (interpolation === 'points') return POINT_BASE_RADIUS;
        if (layerType === 'box') return 6; // Explicit radius for box layers
        return styles.pointRadius || 5; // Slightly smaller default for normal layers
    }

    _getDotShape(dot, interpolation, layerType) {
        // Complete separation for each layer type
        if (layerType === 'box') {
            return 'square'; // Box layers always use squares
        }
        if (layerType === 'handdraw') {
            return 'circle'; // Handdraw layers always use circles
        }
        if (layerType === 'normal' && interpolation !== 'points') {
            // Normal splines use triangle for first point
            const allPoints = this.splineEditor.points || [];
            const idx = this.splineEditor.resolvePointIndex?.(dot) ?? allPoints.indexOf(dot);
            const shape = idx === 0 ? 'triangle' : 'circle';
            return shape;
        }
        return 'circle'; // Default fallback
    }

    _getDotAngle(dot, interpolation, layerType) {
        // Complete separation for each layer type
        if (layerType === 'box') {
            return this._getBoxRotationValue(dot); // Box layers use rotation
        }
        if (layerType === 'handdraw') {
            return 0; // Handdraw layers don't use rotation
        }
        if (layerType === 'normal' && interpolation !== 'points') {
            // Normal splines use rotation for first point
            const allPoints = this.splineEditor.points || [];
            const idx = this.splineEditor.resolvePointIndex?.(dot) ?? allPoints.indexOf(dot);
            if (idx !== 0 || allPoints.length <= 1) return 0;

            const dx = allPoints[1].x - allPoints[0].x;
            const dy = allPoints[1].y - allPoints[0].y;
            return (dx !== 0 || dy !== 0) ? (Math.atan2(dy, dx) - Math.PI / 2 + Math.PI + 2 * Math.PI) % (2 * Math.PI) : 0;
        }
        return 0; // Default fallback
    }

    _getDotStrokeStyle(dot, interpolation, isPointMode, layerType, styles, allPoints) {
        const idx = this.splineEditor.resolvePointIndex?.(dot) ?? allPoints.indexOf(dot);

        // Complete separation for each layer type
        if (layerType === 'handdraw') return styles.pointStroke;
        if (layerType === 'box') return styles.pointStroke || '#139613'; // Box layer specific
        if (layerType === 'normal') {
            if (isPointMode && styles.pointStrokePoint) return styles.pointStrokePoint;
            return styles.pointStroke;
        }
        return styles.pointStroke; // Default fallback
    }

    _getDotFillStyle(dot, interpolation, isPointMode, layerType, styles, allPoints) {
        const idx = this.splineEditor.resolvePointIndex?.(dot) ?? allPoints.indexOf(dot);

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

    _drawBoxPreview(widget) {
        const previewState = this.splineEditor._boxPreviewState;
        if (!previewState || previewState.widget !== widget ||
            !Number.isFinite(previewState.x) || !Number.isFinite(previewState.y)) return;

        this.activeLayerPanel.add(pv.Dot)
            .data(() => {
                // Only render if current layer is still a box layer
                const activeWidget = this.node.layerManager.getActiveWidget();
                if (this._getLayerType(activeWidget) !== 'box') return [];
                return [previewState];
            })
            .left(d => d.x)
            .top(d => d.y)
            .radius(() => POINT_BASE_RADIUS)
            .fillStyle('rgba(44, 198, 255, 0.85)')
            .strokeStyle('#0b3b4b')
            .lineWidth(1.5)
            .events('none');
    }

    // === INACTIVE LAYER DRAWING ===

    drawInactiveLayer(widget) {
        const layerType = this._getLayerType(widget);
        const isOff = !widget.value.on;
        const isBoxLayer = layerType === 'box';

        let points;
        try {
            points = isBoxLayer ? this._getBoxLayerPoints(widget) : this._getRegularLayerPoints(widget);
        } catch (e) {
            console.error("Error parsing points for inactive layer:", e);
            return;
        }

        if (!points?.length) return;

        const layerPanel = this.vis.add(pv.Panel).events("none");
        this.inactiveLayerPanels.push(layerPanel);
        this.inactiveLayerMetadata.push({ widget, points, panel: layerPanel });

        if (isBoxLayer) {
            const boxStyles = this._getLayerStyles('box', 'inactive', true, isOff);
            this._drawInactiveBoxLayer(layerPanel, points, widget, boxStyles);
            return;
        }

        const interpolation = this._normalizeInterpolation(widget.value.interpolation, layerType);
        const isPointMode = (interpolation === 'points');
        const styles = this._getLayerStyles(layerType, 'inactive', isPointMode, isOff);

        this._drawInactiveLine(layerPanel, points, interpolation, isPointMode, styles);

        if (layerType !== 'handdraw') {
            this._drawInactiveDots(layerPanel, points, interpolation, isPointMode, styles, layerType);
        }
    }

    _getBoxLayerPoints(widget) {
        const boxKeys = Array.isArray(widget.value.box_keys) ? widget.value.box_keys : [];
        if (!boxKeys.length) return null;

        const sortedKeys = boxKeys
            .filter(k => typeof k?.x === 'number' && typeof k?.y === 'number')
            .slice()
            .sort((a, b) => (a.frame || 0) - (b.frame || 0));
        
        if (!sortedKeys.length) return null;

        const interpolationMode = widget.value.box_interpolation || 'linear';
        let curvePoints;
        
        if (interpolationMode === 'basis' && sortedKeys.length >= 3) {
            curvePoints = this._generateBasisCurvePoints(sortedKeys);
        } else {
            curvePoints = sortedKeys.map(k => ({ x: k.x, y: k.y }));
        }

        return this.splineEditor.denormalizePoints(curvePoints);
    }

    _getRegularLayerPoints(widget) {
        const storedPoints = JSON.parse(widget.value.points_store || '[]');
        return this.splineEditor.denormalizePoints(storedPoints);
    }

    _drawInactiveLine(layerPanel, points, interpolation, isPointMode, styles) {
        const renderPoints = this._prepareLineData(points, interpolation, isPointMode);
        const lineWidth = styles.lineWidth ?? (isPointMode ? 1 : 3);

        layerPanel.add(pv.Line).events("none")
            .data(renderPoints)
            .left(d => d.x)
            .top(d => d.y)
            .interpolate(isPointMode ? 'linear' : interpolation)
            .strokeStyle(styles.lineStroke)
            .lineWidth(lineWidth);
    }

    _drawInactiveDots(layerPanel, points, interpolation, isPointMode, styles, layerType) {
        if (layerType === 'box') return;
        // Create deep copy to prevent sharing with active layers
        const orderedDots = [...points].map(p => ({...p})).sort((a, b) =>
            this.splineEditor.getBoxPointRadius ? this.splineEditor.getBoxPointRadius(b) - this.splineEditor.getBoxPointRadius(a) : 0
        );

        const firstPointOriginal = points.length > 0 ? points[0] : null;

        orderedDots.forEach((dot) => {
            let shape = 'circle';
            let isFirstPoint = false;

            // Determine shape based on layer type and position
            if (layerType === 'normal' && !isPointMode) {
                // Check if this dot is the first point by comparing coordinates
                if (firstPointOriginal &&
                    Math.abs(dot.x - firstPointOriginal.x) < 0.001 &&
                    Math.abs(dot.y - firstPointOriginal.y) < 0.001) {
                    shape = 'triangle';
                    isFirstPoint = true;
                } else {
                    shape = 'circle';
                }
            } else if (layerType === 'handdraw') {
                shape = 'circle';
            }

            const pointRadius = isPointMode ? POINT_BASE_RADIUS * 0.6 : 4.5;
            const svgStyles = {
                radius: pointRadius,
                stroke: styles.pointStroke || 'rgb(31,119,180)',
                strokeWidth: styles.strokeWidth || 3,
                fill: styles.pointFill || 'none',
                cursor: 'default'
            };

            let element;
            if (shape === 'circle') {
                element = this._createSVGCircle(dot, svgStyles);
            } else if (shape === 'triangle') {
                // Calculate rotation for the first point triangle
                let rotationRad = 0;
                if (isFirstPoint && points.length > 1) {
                    const dx = points[1].x - points[0].x;
                    const dy = points[1].y - points[0].y;
                    rotationRad = (dx !== 0 || dy !== 0) ? (Math.atan2(dy, dx) - Math.PI / 2 + Math.PI + 2 * Math.PI) % (2 * Math.PI) : 0;
                }
                element = this._createSVGPath(shape, dot, svgStyles, rotationRad);
            }

            if (element) {
                // Inactive dots don't need event handlers
                element.style.pointerEvents = 'none';
                // Queue for rendering after vis.render()
                this._pendingShapes.inactiveDots.push(element);
            }
        });

        return; // Disable old Protovis code
    }

    // === INACTIVE BOX LAYER HELPERS ===

    _drawInactiveBoxLayer(layerPanel, points, widget, styles) {
        if (!points || !points.length) return;

        // Only use the main keyframe points for the inactive circles
        const sanitizedKeys = this._sanitizeBoxKeys(widget);
        const keyframeNormPoints = sanitizedKeys.map(k => ({ x: k.x, y: k.y }));
        const keyframeDenormPoints = this._safeDenormalizePoints(keyframeNormPoints) || [];
        const orderedDots = [...keyframeDenormPoints].map(p => ({ ...p })).sort((a, b) =>
            this.splineEditor.getBoxPointRadius ? this.splineEditor.getBoxPointRadius(b) - this.splineEditor.getBoxPointRadius(a) : 0
        );

        this._drawInactiveLine(layerPanel, points, 'linear', true, styles);

        // Draw small red circles for inactive box layers instead of squares
        orderedDots.forEach((dot) => {
            const svgStyles = {
                radius: 4, // Small radius for inactive box points
                stroke: '#f04d3a', // Red to indicate inactive state
                strokeWidth: 2,
                fill: 'rgba(240, 77, 58, 0.25)', // Light red fill
                cursor: 'default'
            };

            const element = this._createSVGCircle(dot, svgStyles);
            if (element) {
                element.style.pointerEvents = 'none';
                // Queue for rendering after vis.render()
                this._pendingShapes.inactiveBoxDots.push(element);
            }
        });

        // Keyframe markers (uses Protovis)
        this._drawBoxKeyPath(layerPanel, widget, false);
    }

    // === BOX LAYER HELPERS ===

    _sanitizeBoxKeys(widget) {
        if (!widget?.value) return [];
        
        const rawKeys = Array.isArray(widget.value.box_keys) ? widget.value.box_keys : [];
        const editorWidth = Math.max(1, Number(this.splineEditor?.width) || 1);
        const editorHeight = Math.max(1, Number(this.splineEditor?.height) || 1);

        return rawKeys
            .map(key => {
                if (!key) return null;
                
                const frameVal = Number(key.frame);
                const rawX = (typeof key.x === 'number' && !Number.isNaN(key.x)) ? key.x : 0.5;
                const rawY = (typeof key.y === 'number' && !Number.isNaN(key.y)) ? key.y : 0.5;
                
                // Normalize if needed
                const normX = Math.abs(rawX) > 1 ? rawX / editorWidth : rawX;
                const normY = Math.abs(rawY) > 1 ? rawY / editorHeight : rawY;
                
                const clampedX = Math.max(0, Math.min(1, normX));
                const clampedY = Math.max(0, Math.min(1, normY));
                
                const scaleVal = (typeof key.scale === 'number' && !Number.isNaN(key.scale)) ? key.scale : 1;
                const rotationVal = (typeof key.rotation === 'number' && !Number.isNaN(key.rotation)) ? key.rotation : 0;

                return {
                    frame: Number.isFinite(frameVal) ? Math.round(frameVal) : 1,
                    x: clampedX,
                    y: clampedY,
                    scale: this.splineEditor.clampScaleValue?.(scaleVal) ?? Math.max(0.2, Math.min(3, scaleVal)),
                    rotation: rotationVal,
                };
            })
            .filter(Boolean)
            .sort((a, b) => (a.frame || 0) - (b.frame || 0));
    }

    _safeDenormalizePoints(points) {
        if (!points?.length) return null;
        try {
            return this.splineEditor.denormalizePoints(points);
        } catch {
            return null;
        }
    }

    _drawBoxKeyPath(panel, widget, isActive) {
        const sortedKeys = this._sanitizeBoxKeys(widget);
        if (!sortedKeys.length) return;

        // Check if we're currently manipulating box keyframes
        const isManipulating = this.splineEditor._boxKeyframePoints &&
                               this.splineEditor._manipulatingBoxKeyframe &&
                               this.splineEditor._manipulatingBoxKeyframe.widget === widget;

        let keyframeDenormPoints;
        let keyframeNormPoints;

        if (isManipulating) {
            // Use the working points being manipulated for real-time updates
            keyframeDenormPoints = this.splineEditor._boxKeyframePoints.filter(p =>
                p && Number.isFinite(p.x) && Number.isFinite(p.y)
            );
            // Also create normalized points for path generation
            keyframeNormPoints = this.splineEditor.normalizePoints ?
                this.splineEditor.normalizePoints(keyframeDenormPoints) :
                sortedKeys.map(k => ({ x: k.x, y: k.y }));
        } else {
            // Use the stored box_keys
            keyframeNormPoints = sortedKeys.map(k => ({ x: k.x, y: k.y }));
            keyframeDenormPoints = this._safeDenormalizePoints(keyframeNormPoints);
        }

        if (!keyframeDenormPoints || !keyframeDenormPoints.length) return;

        const interpolationMode = widget.value.box_interpolation || 'linear';

        // Validate denormalized points to prevent drawing artifacts
        const validKeyframeDenormPoints = keyframeDenormPoints.filter(p => 
            p && Number.isFinite(p.x) && Number.isFinite(p.y) &&
            p.x >= 0 && p.y >= 0 && 
            p.x <= (this.splineEditor?.width || 1000) && 
            p.y <= (this.splineEditor?.height || 1000)
        );
        
        if (!validKeyframeDenormPoints.length) return;

        // Generate path points for connecting line
        let pathNormPoints = keyframeNormPoints;
        if (interpolationMode === 'basis' && sortedKeys.length >= 3) {
            pathNormPoints = this._generateBasisCurvePoints(sortedKeys);
        }
        
        let pathDenormPoints = validKeyframeDenormPoints;
        if (pathNormPoints !== keyframeNormPoints) {
            const tempPath = this._safeDenormalizePoints(pathNormPoints);
            if (tempPath && tempPath.length >= 2) {
                pathDenormPoints = tempPath;
            }
        }

        const activeColor = '#2df26d';
        const inactiveColor = '#f04d3a';
        const color = isActive ? activeColor : inactiveColor;
        const fillColor = isActive ? 'rgba(45, 242, 109, 0.3)' : 'rgba(240,77,58,0.25)';

        // Draw connecting path (only if we have 2+ keys)
        if (sortedKeys.length >= 2 && pathDenormPoints.length >= 2) {
            panel.add(pv.Line).events("none")
                .data(() => {
                    // Only render if current layer is still a box layer
                    const activeWidget = this.node.layerManager.getActiveWidget();
                    if (this._getLayerType(activeWidget) !== 'box') return [];

                    // Use working points during manipulation for real-time updates
                    const currentManipulating = this.splineEditor._boxKeyframePoints &&
                                               this.splineEditor._manipulatingBoxKeyframe &&
                                               this.splineEditor._manipulatingBoxKeyframe.widget === widget;

                    if (currentManipulating) {
                        // Generate path from working points
                        const workingPoints = this.splineEditor._boxKeyframePoints.filter(p =>
                            p && Number.isFinite(p.x) && Number.isFinite(p.y)
                        );
                        return workingPoints;
                    }

                    return pathDenormPoints;
                })
                .left(d => d.x)
                .top(d => d.y)
                .interpolate('linear')
                .strokeStyle(color)
                .lineWidth(isActive ? 2 : 1.5);
        }

        // Draw keyframe indicator circles with interaction support
        // These show where keyframes exist on the timeline and can be manipulated
        validKeyframeDenormPoints.forEach((point, index) => {
            // Add frame info to the point so we can identify which keyframe it belongs to
            const keyframeData = {
                ...point,
                frame: sortedKeys[index]?.frame,
                isBoxKeyframe: true,  // Mark this as a box keyframe for special handling
                boxKeyIndex: index,
                widget: widget
            };

            if (isActive) {
                // Active layer: make keyframes interactive with dynamic positioning
                panel.add(pv.Dot)
                    .data(() => {
                        // Get real-time position during manipulation
                        const currentManipulating = this.splineEditor._boxKeyframePoints &&
                                                   this.splineEditor._manipulatingBoxKeyframe &&
                                                   this.splineEditor._manipulatingBoxKeyframe.widget === widget;

                        if (currentManipulating && this.splineEditor._boxKeyframePoints[index]) {
                            // Use working point position
                            return [{
                                ...keyframeData,
                                x: this.splineEditor._boxKeyframePoints[index].x,
                                y: this.splineEditor._boxKeyframePoints[index].y
                            }];
                        }
                        // Use original position
                        return [keyframeData];
                    })
                    .left(d => d.x)
                    .top(d => d.y)
                .shape('circle')
                .radius(4)
                .strokeStyle(color)
                .lineWidth(2)
                .fillStyle(fillColor)  // Semi-transparent fill for better visibility
                .event("mousedown", (d) => {
                    if (this.splineEditor.handleBoxKeyframePointerDown) {
                        this.splineEditor.handleBoxKeyframePointerDown(d, pv.event);
                    }
                })
                    .event("mouseover", (d) => {
                        if (this.splineEditor.mouseOverHandler) {
                            this.splineEditor.mouseOverHandler(d);
                        }
                    })
                    .event("mouseout", (d) => {
                        if (this.splineEditor.mouseOutHandler) {
                            this.splineEditor.mouseOutHandler();
                        }
                    });
            } else {
                // Inactive layer: non-interactive
                panel.add(pv.Dot).events("none")
                    .data([keyframeData])
                    .left(d => d.x)
                    .top(d => d.y)
                    .shape('circle')
                    .radius(3)
                    .strokeStyle(color)
                    .lineWidth(2)
                    .fillStyle(fillColor);
            }
        });
    }

    _generateBasisCurvePoints(sortedKeys) {
        if (sortedKeys.length < 3) {
            return sortedKeys.map(k => ({ x: k.x, y: k.y }));
        }

        const points = [];
        const stepsPerSegment = 20;

        const basisInterpolate = (p0, p1, p2, p3, t) => {
            const t2 = t * t, t3 = t2 * t;
            const b0 = (1 - t3 + 3 * t2 - 3 * t) / 6;
            const b1 = (4 - 6 * t2 + 3 * t3) / 6;
            const b2 = (1 + 3 * t + 3 * t2 - 3 * t3) / 6;
            const b3 = t3 / 6;
            return {
                x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
                y: b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y
            };
        };

        for (let i = 0; i < sortedKeys.length - 1; i++) {
            const p0 = sortedKeys[Math.max(0, i - 1)];
            const p1 = sortedKeys[i];
            const p2 = sortedKeys[i + 1];
            const p3 = sortedKeys[Math.min(sortedKeys.length - 1, i + 2)];

            if (i === 0) points.push({ x: p1.x, y: p1.y });

            for (let step = 1; step < stepsPerSegment; step++) {
                const t = step / stepsPerSegment;
                points.push(basisInterpolate(p0, p1, p2, p3, t));
            }

            if (i === sortedKeys.length - 2) points.push({ x: p2.x, y: p2.y });
        }

        return points;
    }

    // === HIT DETECTION ===

    findInactiveLayerAtPosition(mouseX, mouseY, threshold = 15) {
        const firstPointThreshold = Math.max(threshold, 22);
        let closestWidget = null;
        let closestDistance = threshold;

        for (const layerData of this.inactiveLayerMetadata) {
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
                const distance = this.distanceToLineSegment(mouseX, mouseY, p1.x, p1.y, p2.x, p2.y);

                if (distance < closestDistance) {
                    closestDistance = distance;
                    closestWidget = layerData.widget;
                }
            }
        }

        return closestWidget;
    }

    distanceToLineSegment(px, py, x1, y1, x2, y2) {
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
}
