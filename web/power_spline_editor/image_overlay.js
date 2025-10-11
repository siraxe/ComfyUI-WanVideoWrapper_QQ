/**
 * Functions for image overlay operations in the power spline editor.
 * Handles darkening of reference images and overlaying A, B, or C images.
 */

/**
 * Darkens an image by overlaying a semi-transparent black layer.
 * @param {Object} imageData - Object containing base64 and type of the image
 * @param {number} opacity - Opacity of the black overlay (0-1)
 * @returns {Promise<Object>} Promise that resolves to the darkened image data
 */
function darkenImage(imageData, opacity = 0.6) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');

            ctx.drawImage(img, 0, 0);
            ctx.fillStyle = `rgba(0, 0, 0, ${opacity})`;
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            resolve({
                base64: canvas.toDataURL(imageData.type).split(',')[1],
                type: imageData.type
            });
        };
        img.onerror = reject;
        img.src = `data:${imageData.type};base64,${imageData.base64}`;
    });
}

/**
 * Scales an image to match the dimensions of the reference image.
 * @param {string} bgImageBase64 - Base64 string of the background image
 * @param {string} bgImageType - MIME type of the background image
 * @param {string} refImageBase64 - Base64 string of the reference image
 * @returns {Promise<Object>} Promise that resolves to scaled image data
 */
function scaleImageToRefDimensions(bgImageBase64, bgImageType, refImageBase64) {
    return new Promise((resolve, reject) => {
        // First, get the dimensions of the reference image by creating an image object
        const refImg = new Image();
        refImg.onload = () => {
            const refWidth = refImg.width;
            const refHeight = refImg.height;
            
            // Create an image object from the background image base64
            const bgImg = new Image();
            bgImg.onload = () => {
                // Create a canvas to scale the background image to match the reference image dimensions
                const canvas = document.createElement('canvas');
                canvas.width = refWidth;
                canvas.height = refHeight;
                const ctx = canvas.getContext('2d');
                
                // Draw the background image scaled to the reference dimensions
                ctx.drawImage(bgImg, 0, 0, refWidth, refHeight);
                
                // Convert the scaled image back to base64
                const scaledBase64 = canvas.toDataURL(bgImageType).split(',')[1];
                
                resolve({
                    base64: scaledBase64,
                    type: bgImageType
                });
            };
            bgImg.onerror = (error) => {
                console.error(`scaleImageToRefDimensions: Failed to load BG image:`, error);
                reject(error);
            };
            bgImg.src = `data:${bgImageType};base64,${bgImageBase64}`;
        };
        refImg.onerror = (error) => {
            console.error(`scaleImageToRefDimensions: Failed to load ref image:`, error);
            reject(error);
        };
        refImg.src = `data:image/png;base64,${refImageBase64}`;
    });
}

/**
 * Processes the background image based on the bg_img selection.
 * @param {string} refImageBase64 - Base64 string of the reference image
 * @param {string} bg_img - Selected background image ("None", "A", "B", or "C")
 * @param {string} bgImgUrl - URL to the selected background image
 * @param {function} finishExecution - Callback function to complete execution with processed image
 */
async function processBgImage(refImageBase64, bg_img, bgImgUrl, finishExecution) {
    if (bg_img === "None") {
        // Use the existing behavior - darken the ref_image
        const originalImgData = { name: "ref_image", base64: refImageBase64, type: 'image/png' };
        darkenImage(originalImgData, 0.6).then(darkenedImgData => {
            finishExecution({ ...originalImgData, ...darkenedImgData });
        });
    } else {
        // Load the selected background image (A, B, or C) from the bg folder
        try {
            // Add cache-busting parameter to the URL
            const urlObj = new URL(bgImgUrl, window.location.href);
            urlObj.searchParams.set('t', Date.now());
            const cacheBustedUrl = urlObj.toString();
            
            const response = await fetch(cacheBustedUrl);
            if (!response.ok) {
                throw new Error(`Failed to load ${bg_img}.jpg, status: ${response.status}`);
            }
            
            // Convert the image response to base64
            const blob = await response.blob();
            const reader = new FileReader();
            reader.onload = function() {
                const bgImageBase64 = reader.result.split(',')[1]; // Extract base64 part
                const bgImageType = reader.result.split(';')[0].split(':')[1]; // Extract MIME type
                
                // Now we need to scale the bg image to match the ref image dimensions
                scaleImageToRefDimensions(bgImageBase64, bgImageType, refImageBase64).then(scaledImageData => {
                    if (scaledImageData) {
                        // Create an overlay using the selected background image instead of black
                        // We need to use the ref_image as the base and apply the selected image as overlay
                        const refImg = new Image();
                        const bgImg = new Image();
                        
                        let refImageLoaded = false;
                        let bgImageLoaded = false;
                        
                        refImg.onload = () => {
                            refImageLoaded = true;
                            createOverlayWhenBothLoaded();
                        };
                        bgImg.onload = () => {
                            bgImageLoaded = true;
                            createOverlayWhenBothLoaded();
                        };
                        
                        refImg.src = `data:image/png;base64,${refImageBase64}`;
                        // For background image from base64, we can't add cache-busting parameters
                        // but it's already updated via the base64 data
                        bgImg.src = `data:${bgImageType};base64,${scaledImageData.base64}`;
                        
                        const createOverlayWhenBothLoaded = () => {
                            if (refImageLoaded && bgImageLoaded) {
                                const canvas = document.createElement('canvas');
                                canvas.width = refImg.width;
                                canvas.height = refImg.height;
                                const ctx = canvas.getContext('2d');
                                
                                // Draw the original ref_image first
                                ctx.drawImage(refImg, 0, 0);
                                
                                // Then draw the background image as an overlay with 40% opacity
                                ctx.globalAlpha = 0.4;
                                ctx.drawImage(bgImg, 0, 0);
                                ctx.globalAlpha = 1.0; // Reset to default
                                
                                // Convert the combined image to data URL
                                const combinedDataUrl = canvas.toDataURL('image/jpeg');
                                
                                const overlayImgData = {
                                    name: `${bg_img}.jpg`,
                                    base64: combinedDataUrl.split(',')[1],
                                    type: 'image/jpeg'
                                };
                                
                                finishExecution(overlayImgData);
                            }
                        };
                    } else {
                        // Fallback: use the original darkened ref image if scaling fails
                        const originalImgData = { name: "ref_image", base64: refImageBase64, type: 'image/png' };
                        darkenImage(originalImgData, 0.6).then(darkenedImgData => {
                            finishExecution({ ...originalImgData, ...darkenedImgData });
                        });
                    }
                });
            };
            reader.onerror = function() {
                // Fallback: use the original darkened ref image if loading fails
                const originalImgData = { name: "ref_image", base64: refImageBase64, type: 'image/png' };
                darkenImage(originalImgData, 0.6).then(darkenedImgData => {
                    finishExecution({ ...originalImgData, ...darkenedImgData });
                });
            };
            reader.readAsDataURL(blob);
        } catch (error) {
            console.error(`Failed to load background image ${bg_img}.jpg:`, error);
            // Fallback: use the original darkened ref image if loading fails
            const originalImgData = { name: "ref_image", base64: refImageBase64, type: 'image/png' };
            darkenImage(originalImgData, 0.6).then(darkenedImgData => {
                finishExecution({ ...originalImgData, ...darkenedImgData });
            });
        }
    }
}

/**
 * Creates an overlay image by combining a reference image with a background image at specified opacity.
 * Used for the onConfigure scenario where A, B, or C images are overlaid on the ref_image.
 * 
 * @param {string} cachedImageUrl - URL of the cached reference image
 * @param {string} bg_img - Name of the background image (A, B, C)
 * @param {string} imageUrl - URL to the selected background image
 * @param {function} loadBackgroundImageFromUrl - Function to load background image directly if overlay fails
 * @param {function} refreshBackgroundImage - Function to refresh the background image after creating overlay
 * @param {object} imgDataProperty - Reference to the imgData property to update with new overlay data
 */
async function createImageOverlayForConfigure(cachedImageUrl, bg_img, imageUrl, loadBackgroundImageFromUrl, refreshBackgroundImage, imgDataProperty) {
    // First, we need to get the ref_image to use as the base
    if (cachedImageUrl) {
        // We have the ref_image, so create an overlay with the selected background
        const refImg = new Image();
        const bgImg = new Image();

        let refImageLoaded = false;
        let bgImageLoaded = false;

        refImg.onload = () => {
            refImageLoaded = true;
            createOverlayWhenBothLoaded();
        };
        bgImg.onload = () => {
            bgImageLoaded = true;
            createOverlayWhenBothLoaded();
        };

        refImg.onerror = () => {
            console.error(`Failed to load ref_image for overlay with ${bg_img}.jpg`);
            // Fallback: load the background image directly without overlay
            if (loadBackgroundImageFromUrl) {
                loadBackgroundImageFromUrl(imageUrl, `${bg_img}.jpg`, null, null);
            }
        };

        bgImg.onerror = () => {
            console.error(`Failed to load ${bg_img}.jpg for overlay`);
            // Fallback: load the background image directly without overlay
            if (loadBackgroundImageFromUrl) {
                loadBackgroundImageFromUrl(imageUrl, `${bg_img}.jpg`, null, null);
            }
        };

        // Extract base64 from cachedImageUrl
        const refImageBase64 = cachedImageUrl.split(',')[1];
        refImg.src = cachedImageUrl;
        // Add cache-busting parameter to the image URL
        const urlObj = new URL(imageUrl, window.location.href);
        urlObj.searchParams.set('t', Date.now());
        const cacheBustedImageUrl = urlObj.toString();
        bgImg.src = cacheBustedImageUrl;

        const createOverlayWhenBothLoaded = () => {
            if (refImageLoaded && bgImageLoaded) {
                const canvas = document.createElement('canvas');
                canvas.width = refImg.width;
                canvas.height = refImg.height;
                const ctx = canvas.getContext('2d');

                // Draw the original ref_image first
                ctx.drawImage(refImg, 0, 0);

                // Then draw the background image as an overlay with 40% opacity
                ctx.globalAlpha = 0.4;
                ctx.drawImage(bgImg, 0, 0);
                ctx.globalAlpha = 1.0; // Reset to default

                // Convert the combined image to data URL
                const combinedDataUrl = canvas.toDataURL('image/jpeg');

                const overlayImgData = {
                    name: `${bg_img}.jpg`,
                    base64: combinedDataUrl.split(',')[1],
                    type: 'image/jpeg'
                };

                // Update the imgData property with the overlay data
                if (imgDataProperty) {
                    // Update the imgData property with the overlay data
                    imgDataProperty.name = overlayImgData.name;
                    imgDataProperty.base64 = overlayImgData.base64;
                    imgDataProperty.type = overlayImgData.type;
                }

                // Refresh the background image
                if (refreshBackgroundImage) {
                    refreshBackgroundImage();
                }
            }
        };
    } else {
        // If we can't get ref_image, just load the background image directly as before
        if (loadBackgroundImageFromUrl) {
            loadBackgroundImageFromUrl(imageUrl, `${bg_img}.jpg`, null, null);
        }
    }
}

// Export the functions for use in other modules
export { darkenImage, scaleImageToRefDimensions, processBgImage, createImageOverlayForConfigure };