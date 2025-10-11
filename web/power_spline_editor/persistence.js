import { app } from '../../../scripts/app.js';

// == DEFAULTS ---
const DRIVEN_DEFAULTS = { driver: "", rotate: 0, d_scale: 1.0 };
const EASING_DEFAULTS = { path: "each", strength: 1.0 };
const SCALE_DEFAULT = 1.00;


// == DRIVEN CONFIG PERSISTENCE ---

/**
 * Initializes the DRIVEN configuration on a widget's value object.
 * Handles migration and ensures the persistent `_drivenConfig` is the source of truth.
 * @param {object} widgetValue The widget.value object to initialize.
 * @param {object} loadedValue The raw `v` object from the widget's `set value(v)` setter.
 */
export function initializeDrivenConfig(widgetValue, loadedValue = null) {
    // Handle migration from old format where `driven` was the config object
    if (typeof widgetValue.driven === 'object' && widgetValue.driven !== null) {
        widgetValue._drivenConfig = { ...DRIVEN_DEFAULTS, ...widgetValue.driven };
    }

    // Ensure _drivenConfig exists, using loaded data or defaults
    const loadedConfig = loadedValue?._drivenConfig;
    widgetValue._drivenConfig = { ...DRIVEN_DEFAULTS, ...(loadedConfig || widgetValue._drivenConfig || {}) };
    
    // After migration, if d_scale was from an old workflow and is 0, 
    // but the user wants it to default to 1.0, we can set a minimum value.
    // However, for backward compatibility we should be careful.
    // Let's ensure d_scale is at least the default value if it's invalid
    if (typeof widgetValue._drivenConfig.d_scale !== 'number' || isNaN(widgetValue._drivenConfig.d_scale)) {
        widgetValue._drivenConfig.d_scale = DRIVEN_DEFAULTS.d_scale;
    }
    
    // Correct old 'smooth' property to 'd_scale'
    if (widgetValue._drivenConfig.smooth !== undefined) {
        if (widgetValue._drivenConfig.d_scale === 1.0) { // Only overwrite if d_scale is default
            // Don't migrate old smooth=0 values to d_scale, since we want d_scale to default to 1.0
            // Only migrate if the smooth value is not the old default of 0
            if (widgetValue._drivenConfig.smooth !== 0) {
                widgetValue._drivenConfig.d_scale = widgetValue._drivenConfig.smooth;
            }
        }
        delete widgetValue._drivenConfig.smooth;
    }

    // Sync live `driven` object if it's active
    if (widgetValue.driven) {
        widgetValue.driven = { ...widgetValue._drivenConfig };
    }
}

/**
 * Updates a property in the DRIVEN configuration.
 * @param {object} widget The widget instance.
 * @param {string} property The property to update.
 * @param {*} value The new value.
 */
export function updateDrivenConfigValue(widget, property, value) {
    // Always update the persistent config
    if (!widget.value._drivenConfig) {
        widget.value._drivenConfig = { ...DRIVEN_DEFAULTS };
    }
    widget.value._drivenConfig[property] = value;

    // If the driven toggle is on (i.e., `driven` is an object), update it too.
    if (widget.value.driven && typeof widget.value.driven === 'object') {
        widget.value.driven[property] = value;
    }

    if (app.graph) {
        app.graph.setDirtyCanvas(true, true);
    }
}

/**
 * Toggles the driven state for a widget.
 * When turning on, it copies the internal `_drivenConfig` to the live `driven` property.
 * When turning off, it sets `driven` to false.
 * @param {object} widget The widget instance.
 */
export function toggleDrivenState(widget) {
    // Ensure the internal config is initialized before toggling.
    if (!widget.value._drivenConfig) {
        widget.value._drivenConfig = { ...DRIVEN_DEFAULTS };
    }

    if (widget.value.driven && typeof widget.value.driven === 'object') {
        // State is ON -> Turn OFF
        widget.value.driven = false;
    } else {
        // State is OFF -> Turn ON
        // The live `driven` object becomes a copy of the persistent internal config.
        widget.value.driven = { ...widget.value._drivenConfig };
    }

    if (app.graph) {
        app.graph.setDirtyCanvas(true, true);
    }
}

/**
 * Prepares the driven config before its menu is displayed.
 * Ensures the internal `_drivenConfig` is up-to-date with the live `driven` value if it's active.
 * @param {object} widget The widget instance.
 */
export function prepareDrivenMenu(widget) {
    if (!widget.value.driven) {
        // If driven is off, ensure the internal config exists for the menu to read from.
        if (!widget.value._drivenConfig || typeof widget.value._drivenConfig !== 'object') {
            widget.value._drivenConfig = { ...DRIVEN_DEFAULTS };
        }
    } else if (typeof widget.value.driven === 'object') {
        // If driven is on, sync the latest values from the live object to the internal one.
        widget.value._drivenConfig = { ...widget.value.driven };
    }
}


// == EASING CONFIG PERSISTENCE

/**
 * Initializes the EASING configuration on a widget's value object.
 * Since easing is always active, we use `easingConfig` as the single source of truth.
 * @param {object} widgetValue The widget.value object to initialize.
 */
export function initializeEasingConfig(widgetValue, loadedValue = null) {
    // Ensure the easingConfig object exists and apply defaults over the loaded data.
    // Handle case where easingConfig might not exist at all (new layers)
    if (!widgetValue.easingConfig || typeof widgetValue.easingConfig !== 'object') {
        widgetValue.easingConfig = { path: "each", strength: 1.0 };
    }
    
    const loadedConfig = widgetValue.easingConfig;
    
    // Apply defaults over the loaded data
    widgetValue.easingConfig = { ...EASING_DEFAULTS, ...(loadedConfig || {}) };
}

/**
 * Updates a property in the EASING configuration.
 * @param {object} widget The widget instance.
 * @param {string} property The property to update ('path' or 'strength').
 * @param {*} value The new value.
 */
export function updateEasingConfigValue(widget, property, value) {
    // Ensure the easingConfig object exists before updating.
    if (!widget.value.easingConfig || typeof widget.value.easingConfig !== 'object') {
        widget.value.easingConfig = { ...EASING_DEFAULTS };
    }
    // Update the property on the single source of truth.
    widget.value.easingConfig[property] = value;

    if (app.graph) {
        app.graph.setDirtyCanvas(true, true);
    }
}

// == SCALE CONFIG PERSISTENCE

/**
 * Initializes the SCALE configuration on a widget's value object.
 * @param {object} widgetValue The widget.value object to initialize.
 * @param {object} loadedValue The raw `v` object from the widget's `set value(v)` setter.
 */
export function initializeScaleConfig(widgetValue, loadedValue = null) {
    // Ensure scale exists and is a valid number, using loaded data or default
    if (typeof widgetValue.scale !== 'number' || isNaN(widgetValue.scale)) {
        widgetValue.scale = loadedValue?.scale !== undefined ? loadedValue.scale : SCALE_DEFAULT;
    }
    
    // Ensure scale is within valid bounds
    widgetValue.scale = Math.max(0.01, Math.min(8.00, widgetValue.scale));
}

/**
 * Updates the scale value for a widget.
 * @param {object} widget The widget instance.
 * @param {number} value The new scale value.
 */
export function updateScaleValue(widget, value) {
    // Ensure the value is a valid number
    if (typeof value !== 'number' || isNaN(value)) {
        value = SCALE_DEFAULT;
    }
    
    // Clamp to valid range
    value = Math.max(0.01, Math.min(8.00, value));
    
    // Update the widget value
    widget.value.scale = value;

    if (app.graph) {
        app.graph.setDirtyCanvas(true, true);
    }
}
