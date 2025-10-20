/**
 * Image and Video Processing Utilities for WanVideoWrapper QQ
 * Handles image extraction, scaling, and preview generation for LoRA files
 */

import { rgthreeApi } from "./rgthree_api.js";

/**
 * Image Utils class containing all image/video processing functionality
 */
export class ImageUtils {

    /**
     * Extract middle frame from a video URL
     * @param {string} videoUrl - URL of the video
     * @param {number} maxWidth - Maximum width for the extracted frame
     * @returns {Promise<Blob>} - Blob containing the extracted frame
     */
    static async extractFrameFromVideo(videoUrl, maxWidth = 250) {
        return new Promise((resolve, reject) => {
            const video = document.createElement('video');
            video.crossOrigin = 'anonymous';
            video.src = videoUrl;

            video.addEventListener('loadeddata', () => {
                // Seek to the middle frame instead of the first frame
                video.currentTime = video.duration / 2;
            });

            video.addEventListener('seeked', () => {
                try {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');

                    // Calculate dimensions maintaining aspect ratio
                    const aspectRatio = video.videoWidth / video.videoHeight;
                    const width = Math.min(maxWidth, video.videoWidth);
                    const height = width / aspectRatio;

                    canvas.width = width;
                    canvas.height = height;

                    // Draw the video frame to canvas
                    ctx.drawImage(video, 0, 0, width, height);

                    // Convert to blob as JPEG
                    canvas.toBlob((blob) => {
                        if (blob) {
                            resolve(blob);
                        } else {
                            reject(new Error('Failed to convert canvas to blob'));
                        }
                    }, 'image/jpeg', 0.9);

                } catch (error) {
                    reject(error);
                }
            });

            video.addEventListener('error', () => {
                reject(new Error(`Failed to load video: ${videoUrl}`));
            });
        });
    }

    /**
     * Scale an image maintaining aspect ratio
     * @param {string} imageUrl - URL of the image
     * @param {number} maxHeight - Maximum height for the scaled image
     * @returns {Promise<Blob>} - Blob containing the scaled image
     */
    static async scaleImage(imageUrl, maxHeight = 250) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = imageUrl;

            img.addEventListener('load', () => {
                try {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');

                    // Calculate dimensions maintaining aspect ratio
                    const aspectRatio = img.width / img.height;
                    const height = Math.min(maxHeight, img.height);
                    const width = height * aspectRatio;

                    canvas.width = width;
                    canvas.height = height;

                    // Draw and scale the image
                    ctx.drawImage(img, 0, 0, width, height);

                    // Convert to blob as JPEG
                    canvas.toBlob((blob) => {
                        if (blob) {
                            resolve(blob);
                        } else {
                            reject(new Error('Failed to convert canvas to blob'));
                        }
                    }, 'image/jpeg', 0.9);

                } catch (error) {
                    reject(error);
                }
            });

            img.addEventListener('error', () => {
                reject(new Error(`Failed to load image: ${imageUrl}`));
            });
        });
    }

    /**
     * Process image or video to generate preview
     * @param {Object} mediaInfo - Media object containing url and type
     * @param {number} maxSize - Maximum size (width for video, height for image)
     * @returns {Promise<Blob>} - Processed image blob
     */
    static async processMediaForPreview(mediaInfo, maxSize = 250) {
        if (!mediaInfo || !mediaInfo.url) {
            throw new Error('Invalid media info provided');
        }

        if (mediaInfo.type === 'video') {
            // Extract middle frame from video for better preview representation
            return this.extractFrameFromVideo(mediaInfo.url, maxSize);
        } else {
            return this.scaleImage(mediaInfo.url, maxSize);
        }
    }

    /**
     * Convert blob to data URL for preview/ debugging
     * @param {Blob} blob - Image blob
     * @returns {Promise<string>} - Data URL
     */
    static async blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    /**
     * Save preview image through the backend API
     * @param {string} loraName - Name of the LoRA file (without extension)
     * @param {Blob} imageBlob - Processed image blob
     * @param {string} loraPath - Optional relative path within loras directory
     * @param {string} suffix - Optional suffix for filename (e.g., '_01', '_02')
     * @param {string} type - Type of item ('loras' or 'checkpoints')
     * @returns {Promise<Object>} - API response
     */
    static async savePreviewImage(loraName, imageBlob, loraPath = '', suffix = '', type = 'loras') {
        const formData = new FormData();

        // Create a unique filename with optional suffix
        const filename = `${loraName}${suffix}.jpg`;

        formData.append('image', imageBlob, filename);
        if (type === 'checkpoints') {
            formData.append('model_name', loraName);
            formData.append('model_path', loraPath);
            // Also include lora_name for compatibility
            formData.append('lora_name', loraName);
            formData.append('lora_path', loraPath);
        } else {
            formData.append('lora_name', loraName);
            formData.append('lora_path', loraPath);
        }
        formData.append('suffix', suffix);
        formData.append('is_model', type === 'checkpoints' ? 'true' : 'false');

        try {
            const response = await fetch('/wanvid/api/lora/preview-image', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('Failed to save preview image:', error);
            throw error;
        }
    }

    /**
     * Complete workflow: extract/scale media and save as preview
     * @param {Object} mediaInfo - Media object from dialog info
     * @param {string} loraName - Name of the LoRA
     * @param {string} loraPath - Optional relative path within loras directory
     * @param {string} type - Type of item ('loras' or 'checkpoints')
     * @returns {Promise<Object>} - Result of the operation
     */
    static async generateAndSavePreview(mediaInfo, loraName, loraPath = '', type = 'loras') {
        try {
            const frameInfo = mediaInfo.type === 'video' ? 'middle frame' : 'image';
            console.log(`[ImageUtils] Generating preview for ${loraName} (${type}) from ${mediaInfo.type} (${frameInfo})`);

            // Validate inputs
            if (!mediaInfo || !mediaInfo.url) {
                throw new Error('Invalid media info: missing URL');
            }
            if (!loraName || loraName.trim() === '') {
                throw new Error('Invalid LoRA name: empty or undefined');
            }

            // Process the media (extract frame from video or scale image)
            const imageBlob = await this.processMediaForPreview(mediaInfo);

            console.log(`[ImageUtils] Media processed, blob size: ${imageBlob.size} bytes`);

            if (imageBlob.size === 0) {
                throw new Error('Generated image blob is empty');
            }

            // Save through backend API
            const result = await this.savePreviewImage(loraName, imageBlob, loraPath, '', type);

            console.log(`[ImageUtils] Preview saved successfully for ${loraName} (${type}):`, result);
            return result;

        } catch (error) {
            console.error(`[ImageUtils] Failed to generate preview for ${loraName} (${type}):`, error);
            throw error;
        }
    }

    /**
     * Generate and save multiple preview images from available examples
     * @param {Object} info - Dialog info object containing images array
     * @param {string} loraName - Name of the LoRA
     * @param {string} loraPath - Optional relative path within loras directory
     * @param {number} maxImages - Maximum number of preview images to generate
     * @param {string} type - Type of item ('loras' or 'checkpoints')
     * @returns {Promise<Array>} - Array of results for each generated preview
     */
    static async generateMultiplePreviews(info, loraName, loraPath = '', maxImages = 3, type = 'loras') {
        try {
            if (!info || !info.images || !info.images.length) {
                throw new Error('No images available in info data');
            }

            console.log(`[ImageUtils] Generating up to ${maxImages} previews for ${loraName}`);

            const results = [];
            const imagesToProcess = Math.min(maxImages, info.images.length);

            for (let i = 0; i < imagesToProcess; i++) {
                const mediaInfo = info.images[i];
                const suffix = `_${String(i + 1).padStart(2, '0')}`; // _01, _02, _03

                try {
                    console.log(`[ImageUtils] Processing preview ${suffix} for ${loraName}`);

                    // Validate media info
                    if (!mediaInfo || !mediaInfo.url) {
                        console.warn(`[ImageUtils] Skipping ${suffix}: invalid media info`);
                        continue;
                    }

                    // Process the media
                    const imageBlob = await this.processMediaForPreview(mediaInfo);

                    if (imageBlob.size === 0) {
                        console.warn(`[ImageUtils] Skipping ${suffix}: empty blob generated`);
                        continue;
                    }

                    // Save with suffix
                    const result = await this.savePreviewImage(loraName, imageBlob, loraPath, suffix, type);
                    result.suffix = suffix;
                    results.push(result);

                    console.log(`[ImageUtils] Preview ${suffix} saved successfully:`, result);

                } catch (error) {
                    console.error(`[ImageUtils] Failed to generate preview ${suffix} for ${loraName}:`, error);
                    // Continue processing other images even if one fails
                }
            }

            if (results.length === 0) {
                throw new Error('Failed to generate any preview images');
            }

            console.log(`[ImageUtils] Successfully generated ${results.length} previews for ${loraName}`);
            return results;

        } catch (error) {
            console.error(`[ImageUtils] Failed to generate multiple previews for ${loraName}:`, error);
            throw error;
        }
    }
}

/**
 * Convenience function to generate multiple previews from available media in info
 * @param {Object} info - Dialog info object containing images array
 * @param {string} loraName - Name of the LoRA
 * @param {string} loraPath - Optional relative path within loras directory
 * @param {string} type - Type of item ('loras' or 'checkpoints')
 * @returns {Promise<Object>} - Result of the operation
 */
export async function generatePreviewFromFirstImage(info, loraName, loraPath = '', type = 'loras') {
    if (!info || !info.images || !info.images.length) {
        throw new Error('No images available in info data');
    }

    return ImageUtils.generateMultiplePreviews(info, loraName, loraPath, 3, type);
}

/**
 * Test function to manually trigger preview generation
 * @param {Object} info - Dialog info object containing images array
 * @param {string} loraName - Name of the LoRA
 * @param {string} loraPath - Optional relative path within loras directory
 * @returns {Promise<Object>} - Result of the operation
 */
export async function testPreviewGeneration(info, loraName, loraPath = '') {
    console.log(`[ImageUtils] Manual test: Starting preview generation for ${loraName}`);

    try {
        const result = await generatePreviewFromFirstImage(info, loraName, loraPath);
        console.log(`[ImageUtils] Manual test: Preview generation successful`, result);
        return result;
    } catch (error) {
        console.error(`[ImageUtils] Manual test: Preview generation failed`, error);
        throw error;
    }
}

/**
 * Debug function to validate image info structure
 * @param {Object} info - Dialog info object
 * @returns {boolean} - True if structure is valid
 */
export function validateImageInfo(info) {
    if (!info) {
        console.error('[ImageUtils] Invalid info: null or undefined');
        return false;
    }

    if (!info.images || !Array.isArray(info.images)) {
        console.error('[ImageUtils] Invalid info: images array missing or not an array');
        return false;
    }

    if (info.images.length === 0) {
        console.warn('[ImageUtils] Warning: No images in info array');
        return false;
    }

    const firstImage = info.images[0];
    if (!firstImage || !firstImage.url) {
        console.error('[ImageUtils] Invalid first image: missing URL');
        return false;
    }

    if (!firstImage.type || !['image', 'video'].includes(firstImage.type)) {
        console.error('[ImageUtils] Invalid first image: missing or invalid type');
        return false;
    }

    console.log(`[ImageUtils] Image info validation passed: ${firstImage.type} - ${firstImage.url}`);
    return true;
}

export default ImageUtils;