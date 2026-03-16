/**
 * Scale Configuration for Box Layers
 * Centralized configuration for h_scale and v_scale defaults and ranges
 */

export const SCALE_CONFIG = {
  /**
   * Horizontal Scale (h_scale)
   * Range: -1.0 to 1.0
   * - 1.0 = normal width (100%, no flip)
   * - 0.0 = collapsed (0 width)
   * - -1.0 = flipped horizontally + 100% width
   * - -0.5 = flipped horizontally + 50% width
   * - 0.5 = 50% width (no flip)
   */
  h_scale: {
    DEFAULT: 1.0,
    MIN: -1.0,
    MAX: 1.0,
  },

  /**
   * Vertical Scale (v_scale)
   * Range: 0.0 to 1.0
   * - 1.0 = full height (100%, bottom-anchored)
   * - 0.5 = 50% height (bottom-anchored)
   * - 0.0 = collapsed (0 height)
   */
  v_scale: {
    DEFAULT: 1.0,
    MIN: 0.0,
    MAX: 1.0,
  },

  /**
   * Slider positions for UI (0.0 to 1.0 range)
   */
  slider: {
    DEFAULT: 0.5,  // Middle position = no scaling
    MIN: 0.0,
    MAX: 1.0,
  },
};

/**
 * Convert h_scale (-1.0 to 1.0) to topSliderPos (0.0 to 1.0)
 * @param {number} hScale - Horizontal scale value (-1.0 to 1.0)
 * @returns {number} Slider position (0.0 to 1.0)
 */
export function hScaleToTopSliderPos(hScale) {
  if (typeof hScale !== 'number' || Number.isNaN(hScale)) {
    return SCALE_CONFIG.slider.DEFAULT;
  }
  // Map [-1, 1] to [0, 1]: (hScale + 1) / 2
  return (hScale + 1) / 2;
}

/**
 * Convert topSliderPos (0.0 to 1.0) to h_scale (-1.0 to 1.0)
 * @param {number} sliderPos - Slider position (0.0 to 1.0)
 * @returns {number} Horizontal scale value (-1.0 to 1.0)
 */
export function topSliderPosToHScale(sliderPos) {
  if (typeof sliderPos !== 'number' || Number.isNaN(sliderPos)) {
    return SCALE_CONFIG.h_scale.DEFAULT;
  }
  // Map [0, 1] to [-1, 1]: sliderPos * 2 - 1
  return (sliderPos * 2) - 1;
}

/**
 * Convert v_scale (0.0 to 1.0) to rightSliderPos (0.0 to 1.0)
 * @param {number} vScale - Vertical scale value (0.0 to 1.0)
 * @returns {number} Slider position (0.0 to 1.0)
 */
export function vScaleToRightSliderPos(vScale) {
  if (typeof vScale !== 'number' || Number.isNaN(vScale)) {
    return SCALE_CONFIG.slider.MAX;  // v_scale 1.0 = slider at top
  }
  return vScale;
}

/**
 * Convert rightSliderPos (0.0 to 1.0) to v_scale (0.0 to 1.0)
 * @param {number} sliderPos - Slider position (0.0 to 1.0)
 * @returns {number} Vertical scale value (0.0 to 1.0)
 */
export function rightSliderPosToVScale(sliderPos) {
  if (typeof sliderPos !== 'number' || Number.isNaN(sliderPos)) {
    return SCALE_CONFIG.v_scale.DEFAULT;
  }
  return sliderPos;
}

/**
 * Clamp h_scale to valid range [-1.0, 1.0]
 * @param {number} value - Value to clamp
 * @returns {number} Clamped h_scale value
 */
export function clampHScale(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return SCALE_CONFIG.h_scale.DEFAULT;
  }
  return Math.max(SCALE_CONFIG.h_scale.MIN, Math.min(SCALE_CONFIG.h_scale.MAX, value));
}

/**
 * Clamp v_scale to valid range [0.0, 1.0]
 * @param {number} value - Value to clamp
 * @returns {number} Clamped v_scale value
 */
export function clampVScale(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return SCALE_CONFIG.v_scale.DEFAULT;
  }
  return Math.max(SCALE_CONFIG.v_scale.MIN, Math.min(SCALE_CONFIG.v_scale.MAX, value));
}
