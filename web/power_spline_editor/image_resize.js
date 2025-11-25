/**
 * Image Resize Utilities
 * JavaScript implementation of ImageResizeKJv2 logic for client-side image processing
 */

/**
 * Apply ImageResizeKJv2 resize parameters to an image
 * @param {HTMLImageElement} image - The source image
 * @param {Object} params - Resize parameters from ImageResizeKJv2 node
 * @returns {Promise<{canvas: HTMLCanvasElement, width: number, height: number}>}
 */
export async function applyResizeParams(image, params) {
    const {
        width: targetWidth,
        height: targetHeight,
        keep_proportion = 'crop',
        upscale_method = 'lanczos',
        divisible_by = 2,
        pad_color = '0, 0, 0',
        crop_position = 'center'
    } = params;

    const originalWidth = image.width;
    const originalHeight = image.height;

    // Calculate dimensions based on keep_proportion mode
    let resizeWidth = targetWidth;
    let resizeHeight = targetHeight;
    let padLeft = 0, padRight = 0, padTop = 0, padBottom = 0;

    if (keep_proportion === 'resize' || keep_proportion.startsWith('pad')) {
        // Calculate new dimensions maintaining aspect ratio
        const ratio = Math.min(targetWidth / originalWidth, targetHeight / originalHeight);
        resizeWidth = Math.round(originalWidth * ratio);
        resizeHeight = Math.round(originalHeight * ratio);

        // Calculate padding if needed
        if (keep_proportion.startsWith('pad')) {
            if (crop_position === 'center') {
                padLeft = Math.floor((targetWidth - resizeWidth) / 2);
                padRight = targetWidth - resizeWidth - padLeft;
                padTop = Math.floor((targetHeight - resizeHeight) / 2);
                padBottom = targetHeight - resizeHeight - padTop;
            } else if (crop_position === 'top') {
                padLeft = Math.floor((targetWidth - resizeWidth) / 2);
                padRight = targetWidth - resizeWidth - padLeft;
                padTop = 0;
                padBottom = targetHeight - resizeHeight;
            } else if (crop_position === 'bottom') {
                padLeft = Math.floor((targetWidth - resizeWidth) / 2);
                padRight = targetWidth - resizeWidth - padLeft;
                padTop = targetHeight - resizeHeight;
                padBottom = 0;
            } else if (crop_position === 'left') {
                padLeft = 0;
                padRight = targetWidth - resizeWidth;
                padTop = Math.floor((targetHeight - resizeHeight) / 2);
                padBottom = targetHeight - resizeHeight - padTop;
            } else if (crop_position === 'right') {
                padLeft = targetWidth - resizeWidth;
                padRight = 0;
                padTop = Math.floor((targetHeight - resizeHeight) / 2);
                padBottom = targetHeight - resizeHeight - padTop;
            }
        }
    } else if (keep_proportion === 'crop') {
        // For crop mode, we'll first calculate what to crop, then resize
        // This is handled in the drawing phase
    } else if (keep_proportion === 'stretch') {
        // Use target dimensions as-is
        resizeWidth = targetWidth;
        resizeHeight = targetHeight;
    }

    // Apply divisible_by constraint
    if (divisible_by > 1) {
        resizeWidth = resizeWidth - (resizeWidth % divisible_by);
        resizeHeight = resizeHeight - (resizeHeight % divisible_by);
    }

    // Create canvas for resizing
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // Handle crop mode
    if (keep_proportion === 'crop') {
        const oldAspect = originalWidth / originalHeight;
        const newAspect = targetWidth / targetHeight;

        let cropW, cropH, cropX, cropY;

        if (oldAspect > newAspect) {
            cropW = Math.round(originalHeight * newAspect);
            cropH = originalHeight;
        } else {
            cropW = originalWidth;
            cropH = Math.round(originalWidth / newAspect);
        }

        // Calculate crop position
        if (crop_position === 'center') {
            cropX = Math.floor((originalWidth - cropW) / 2);
            cropY = Math.floor((originalHeight - cropH) / 2);
        } else if (crop_position === 'top') {
            cropX = Math.floor((originalWidth - cropW) / 2);
            cropY = 0;
        } else if (crop_position === 'bottom') {
            cropX = Math.floor((originalWidth - cropW) / 2);
            cropY = originalHeight - cropH;
        } else if (crop_position === 'left') {
            cropX = 0;
            cropY = Math.floor((originalHeight - cropH) / 2);
        } else if (crop_position === 'right') {
            cropX = originalWidth - cropW;
            cropY = Math.floor((originalHeight - cropH) / 2);
        }

        // Set canvas to target size
        canvas.width = targetWidth;
        canvas.height = targetHeight;

        // Set image smoothing based on upscale method
        setImageSmoothing(ctx, upscale_method);

        // Draw cropped and resized image
        ctx.drawImage(
            image,
            cropX, cropY, cropW, cropH,  // Source crop
            0, 0, targetWidth, targetHeight  // Destination
        );

    } else if (keep_proportion.startsWith('pad')) {
        // Resize mode with padding
        const paddedWidth = resizeWidth + padLeft + padRight;
        const paddedHeight = resizeHeight + padTop + padBottom;

        canvas.width = paddedWidth;
        canvas.height = paddedHeight;

        // Parse pad color
        const [r, g, b] = pad_color.split(',').map(s => parseInt(s.trim()));
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(0, 0, paddedWidth, paddedHeight);

        // Set image smoothing
        setImageSmoothing(ctx, upscale_method);

        // Draw resized image with padding offset
        ctx.drawImage(image, padLeft, padTop, resizeWidth, resizeHeight);

    } else {
        // Simple resize (stretch or resize mode without padding)
        canvas.width = resizeWidth;
        canvas.height = resizeHeight;

        setImageSmoothing(ctx, upscale_method);

        ctx.drawImage(image, 0, 0, resizeWidth, resizeHeight);
    }

    return {
        canvas,
        width: canvas.width,
        height: canvas.height
    };
}

/**
 * Set canvas image smoothing based on upscale method
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {string} method - Upscale method name
 */
function setImageSmoothing(ctx, method) {
    // Map upscale methods to canvas image smoothing
    const smoothingMap = {
        'nearest-exact': false,
        'bilinear': true,
        'area': true,
        'bicubic': true,
        'lanczos': true  // Canvas doesn't have lanczos, use high-quality
    };

    const shouldSmooth = smoothingMap[method] !== undefined ? smoothingMap[method] : true;
    ctx.imageSmoothingEnabled = shouldSmooth;

    if (shouldSmooth) {
        // Use high-quality smoothing for bicubic/lanczos
        if (method === 'bicubic' || method === 'lanczos') {
            ctx.imageSmoothingQuality = 'high';
        } else if (method === 'bilinear') {
            ctx.imageSmoothingQuality = 'medium';
        } else {
            ctx.imageSmoothingQuality = 'low';
        }
    }
}
