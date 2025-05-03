/**
 * NodeSizeManager - Unified size management for PowerSplineEditor node
 * Handles both width and height calculations, user adjustments, and auto-sizing
 */
export class NodeSizeManager {
    constructor(node, options = {}) {
        this.node = node;

        // Default configuration
        this.config = {
            canvasWidth: options.canvasWidth || 504,
            canvasHeight: options.canvasHeight || 480,
            canvasExtraWidth: options.canvasExtraWidth || 45,
            minNodeWidth: options.minNodeWidth || 504,
            minNodeHeight: options.minNodeHeight || 480,
            titleHeight: options.titleHeight || 100,
            widgetHeight: options.widgetHeight || LiteGraph.NODE_WIDGET_HEIGHT,
            headerWidgetHeight: options.headerWidgetHeight || LiteGraph.NODE_WIDGET_HEIGHT,
            splineWidgetHeight: options.splineWidgetHeight || LiteGraph.NODE_WIDGET_HEIGHT,
            padding: options.padding || 0,
            // Canvas dimension constraints (for mask_width/mask_height widgets)
            minCanvasWidth: options.minCanvasWidth || 504,
            maxCanvasWidth: options.maxCanvasWidth || 8192,
            minCanvasHeight: options.minCanvasHeight || 480,
            maxCanvasHeight: options.maxCanvasHeight || 8192,
        };

        // Initialize properties for tracking user adjustments
        this.node.properties = this.node.properties || {};
        if (this.node.properties.userAdjustedSize === undefined) {
            this.node.properties.userAdjustedSize = false;
        }

        // Store the last calculated size to detect user changes
        this._lastAutoSize = null;
    }

    /**
     * Calculate the total height of all non-canvas widgets
     * @returns {number}
     * @private
     */
    _getWidgetHeightsTotal() {
        const widgets = this.node.widgets || [];
        const splineWidgets = widgets.filter(w => w.name?.startsWith("spline_"));

        const titleHeight = this.config.titleHeight;
        const dimensionsWidgetHeight = this.config.widgetHeight; // DimensionsWidget always shows
        const headerWidgetHeight = splineWidgets.length > 0 ? this.config.headerWidgetHeight : 0; // Header only when splines exist
        const splineWidgetsHeight = splineWidgets.length * this.config.splineWidgetHeight;
        const addButtonHeight = this.config.widgetHeight; // "Add Spline" button
        const padding = this.config.padding;

        return titleHeight + dimensionsWidgetHeight +
            headerWidgetHeight + splineWidgetsHeight + addButtonHeight + padding;
    }

    /**
     * Calculate required node size based on current widgets and canvas
     * @returns {Array} [width, height]
     */
    calculateSize() {
        const widgets = this.node.widgets || [];

        // Get current canvas dimensions from widgets (dynamic values)
        const widthWidget = widgets.find(w => w.name === "mask_width");
        const heightWidget = widgets.find(w => w.name === "mask_height");
        const currentCanvasWidth = widthWidget ? widthWidget.value : this.config.canvasWidth;
        const currentCanvasHeight = heightWidget ? heightWidget.value : this.config.canvasHeight;

        // Calculate width (canvas + extra width for controls)
        const calculatedWidth = Math.max(
            currentCanvasWidth + this.config.canvasExtraWidth,
            this.config.minNodeWidth
        );

        // Calculate total widget heights (everything except canvas)
        const widgetHeightsTotal = this._getWidgetHeightsTotal();

        // Calculate minimum node height dynamically (minCanvasHeight + all widgets)
        const minCalculatedHeight = this.config.minCanvasHeight + widgetHeightsTotal;

        // Calculate actual height (canvas + widgets, but never below minimum)
        const calculatedHeight = Math.max(
            currentCanvasHeight + widgetHeightsTotal,
            minCalculatedHeight,
            this.config.minNodeHeight // Absolute floor (for edge cases)
        );

        return [calculatedWidth, calculatedHeight];
    }

    /**
     * Update the node size (respects user adjustments)
     * @param {boolean} force - Force update even if user has adjusted size
     */
    updateSize(force = false) {
        // If user has manually adjusted size, don't auto-update unless forced
        if (this.node.properties.userAdjustedSize && !force) {
            return;
        }

        const [width, height] = this.calculateSize();
        this.node.setSize([width, height]);

        // Store last auto size for comparison
        this._lastAutoSize = [width, height];
    }

    /**
     * Set canvas dimensions and recalculate node size
     * @param {number} width - Canvas width
     * @param {number} height - Canvas height
     */
    setCanvasSize(width, height) {
        if (width !== undefined) {
            this.config.canvasWidth = width;
        }
        if (height !== undefined) {
            this.config.canvasHeight = height;
        }

        this.updateSize();
    }

    /**
     * Reset to auto-sizing mode
     */
    resetToAuto() {
        this.node.properties.userAdjustedSize = false;
        this.updateSize(true); // Force update
    }

    /**
     * Handle node resize events (detect manual resizing)
     * Call this from node's onResize callback
     * @param {Array} newSize - [width, height]
     * @returns {Array} Constrained size [width, height]
     */
    onNodeResized(newSize) {
        // Calculate minimum required height based on widgets + min canvas height
        const widgetHeightsTotal = this._getWidgetHeightsTotal();
        const minRequiredHeight = widgetHeightsTotal + this.config.minCanvasHeight;

        // Enforce minimum constraints, ensuring node is tall enough for widgets and min canvas
        const constrainedSize = [
            Math.max(newSize[0], this.config.minNodeWidth),
            Math.max(newSize[1], minRequiredHeight, this.config.minNodeHeight)
        ];

        // Check if this was a user adjustment (not an auto-update)
        if (this._lastAutoSize) {
            const isAutoSize = (
                Math.abs(constrainedSize[0] - this._lastAutoSize[0]) < 1 &&
                Math.abs(constrainedSize[1] - this._lastAutoSize[1]) < 1
            );

            if (!isAutoSize) {
                // User manually resized
                this.node.properties.userAdjustedSize = true;
            }
        } else {
            // First resize, likely user-initiated
            const [autoWidth, autoHeight] = this.calculateSize();
            const isAutoSize = (
                Math.abs(constrainedSize[0] - autoWidth) < 1 &&
                Math.abs(constrainedSize[1] - autoHeight) < 1
            );

            if (!isAutoSize) {
                this.node.properties.userAdjustedSize = true;
            }
        }

        return constrainedSize;
    }

    /**
     * Handle node configuration restore (loading from saved workflow)
     * Call this from onConfigure
     * @param {Array} savedSize - The size from the saved workflow [width, height]
     */
    onConfigure(savedSize) {
        if (this.node.properties.userAdjustedSize) {
            // User had manually adjusted - restore their exact size
            this.node.setSize([
                Math.max(savedSize[0], this.config.minNodeWidth),
                Math.max(savedSize[1], this.config.minNodeHeight)
            ]);
        } else {
            // Auto-managed - recalculate based on current widgets
            this.updateSize(true);

            // But respect if saved size was larger (for backwards compatibility)
            const [autoWidth, autoHeight] = this._lastAutoSize;
            if (savedSize[0] > autoWidth || savedSize[1] > autoHeight) {
                this.node.setSize([
                    Math.max(savedSize[0], autoWidth),
                    Math.max(savedSize[1], autoHeight)
                ]);
            }
        }
    }

    /**
     * Get current configuration
     * @returns {Object} Current config object
     */
    getConfig() {
        return { ...this.config };
    }

    /**
     * Update configuration
     * @param {Object} newConfig - Partial config to merge
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        this.updateSize();
    }

    /**
     * Check if size is currently user-adjusted
     * @returns {boolean}
     */
    isUserAdjusted() {
        return this.node.properties.userAdjustedSize === true;
    }

    /**
     * Constrain canvas width to configured limits
     * @param {number} value - Canvas width value
     * @returns {number} Constrained value
     */
    constrainCanvasWidth(value) {
        return Math.max(this.config.minCanvasWidth, Math.min(this.config.maxCanvasWidth, value));
    }

    /**
     * Constrain canvas height to configured limits
     * @param {number} value - Canvas height value
     * @returns {number} Constrained value
     */
    constrainCanvasHeight(value) {
        return Math.max(this.config.minCanvasHeight, Math.min(this.config.maxCanvasHeight, value));
    }

    /**
     * Get minimum canvas width
     * @returns {number}
     */
    getMinCanvasWidth() {
        return this.config.minCanvasWidth;
    }

    /**
     * Get minimum canvas height
     * @returns {number}
     */
    getMinCanvasHeight() {
        return this.config.minCanvasHeight;
    }

    /**
     * Get maximum canvas width
     * @returns {number}
     */
    getMaxCanvasWidth() {
        return this.config.maxCanvasWidth;
    }

    /**
     * Get maximum canvas height
     * @returns {number}
     */
    getMaxCanvasHeight() {
        return this.config.maxCanvasHeight;
    }
}
