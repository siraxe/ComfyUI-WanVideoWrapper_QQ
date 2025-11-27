/**
 * Simplified canvas for PrepareRefs that reuses PowerSplineEditor's coordinate transformation logic
 * This ensures lasso shapes use the same coordinate system as spline drawing
 */

export default class RefCanvas {
  constructor(canvasElement, node) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.node = node;

    // Store original image details (same as PowerSplineEditor)
    this.originalImageWidth = null;
    this.originalImageHeight = null;
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;

    // Canvas dimensions
    this.width = canvasElement.width;
    this.height = canvasElement.height;

    // Background image
    this.backgroundImage = null;
  }

  /**
   * Recenter background image - EXACT same logic as PowerSplineEditor canvas_background.js
   */
  recenterBackgroundImage() {
    if (this.originalImageWidth && this.originalImageHeight) {
      // Same padding as PowerSplineEditor (40px on each side = 80px total)
      const targetWidth = this.width - 80;
      const targetHeight = this.height - 80;
      const scale = Math.min(targetWidth / this.originalImageWidth, targetHeight / this.originalImageHeight);
      this.scale = scale;
      const newWidth = this.originalImageWidth * this.scale;
      const newHeight = this.originalImageHeight * this.scale;
      this.offsetX = (this.width - newWidth) / 2;
      this.offsetY = (this.height - newHeight) / 2;
    }
  }

  /**
   * Load background image and setup coordinate system
   */
  loadBackgroundImage(img) {
    this.backgroundImage = img;
    this.originalImageWidth = img.naturalWidth || img.width;
    this.originalImageHeight = img.naturalHeight || img.height;
    this.recenterBackgroundImage();
    this.render();
  }

  /**
   * Update canvas dimensions
   */
  setSize(width, height) {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    if (this.originalImageWidth && this.originalImageHeight) {
      this.recenterBackgroundImage();
    }
    this.render();
  }

  /**
   * Normalize points - EXACT same logic as PowerSplineEditor canvas_state.js
   * Converts canvas coordinates to 0-1 normalized coordinates relative to original image
   */
  normalizePoints(points) {
    return points.map(p => {
      const { x, y } = p;
      let nx, ny;
      if (this.originalImageWidth && this.originalImageHeight && this.scale > 0) {
        // Remove canvas offset to get image-relative coords
        const relX = x - this.offsetX;
        const relY = y - this.offsetY;
        // Divide by scale to get original image pixel coords
        const origX = relX / this.scale;
        const origY = relY / this.scale;
        // Normalize to 0-1 range based on original image dimensions
        nx = origX / this.originalImageWidth;
        ny = origY / this.originalImageHeight;
      } else {
        // Fallback: normalize to canvas dimensions
        nx = x / this.width;
        ny = y / this.height;
      }
      return { ...p, x: nx, y: ny };
    });
  }

  /**
   * Denormalize points - EXACT same logic as PowerSplineEditor canvas_state.js
   * Converts 0-1 normalized coordinates to canvas coordinates
   */
  denormalizePoints(points) {
    // Check if points are already in canvas coords (not normalized)
    const isNormalized = points.every(p => Math.abs(p.x) < 10 && Math.abs(p.y) < 10);
    if (!isNormalized) {
      return points;
    }

    const result = points.map(p => {
      const { x: nx, y: ny } = p;
      let x, y;
      if (this.originalImageWidth && this.originalImageHeight && this.scale > 0) {
        // Convert normalized (0-1) to original image pixel coords
        const origX = nx * this.originalImageWidth;
        const origY = ny * this.originalImageHeight;
        // Scale and add offset to get canvas coords
        x = (origX * this.scale) + this.offsetX;
        y = (origY * this.scale) + this.offsetY;
      } else {
        // Fallback: denormalize to canvas dimensions
        x = nx * this.width;
        y = ny * this.height;
      }
      return { ...p, x, y };
    });

    return result;
  }

  /**
   * Render canvas background
   */
  render() {
    this.ctx.clearRect(0, 0, this.width, this.height);

    // Draw background
    this.ctx.fillStyle = '#222';
    this.ctx.fillRect(0, 0, this.width, this.height);

    // Draw image if loaded
    if (this.backgroundImage && this.originalImageWidth && this.originalImageHeight) {
      const drawW = this.originalImageWidth * this.scale;
      const drawH = this.originalImageHeight * this.scale;
      this.ctx.drawImage(this.backgroundImage, this.offsetX, this.offsetY, drawW, drawH);
    }
  }

  /**
   * Convert mouse event coordinates to canvas coordinates
   */
  getCanvasCoords(event) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY
    };
  }
}
