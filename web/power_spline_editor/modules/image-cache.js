/**
 * Image Cache Module
 * Handles image loading, caching, base64 conversion, and session storage
 */

/**
 * Load image from URL as base64 data URL
 * Handles both data URLs and regular URLs with cache-busting
 */
export async function loadImageAsBase64(url) {
  try {
    // Check if it's a data URL (starts with 'data:')
    if (url.startsWith('data:')) {
      // For data URLs, no cache-busting is needed, just process directly
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const blob = await response.blob();
      return blobToDataUrl(blob);
    } else {
      // For regular URLs, add cache-busting parameter
      const urlObj = new URL(url, window.location.href);
      urlObj.searchParams.set('t', Date.now());
      const cacheBustedUrl = urlObj.toString();

      const response = await fetch(cacheBustedUrl);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const blob = await response.blob();
      return blobToDataUrl(blob);
    }
  } catch (e) {
    console.error(`Failed to load image from ${url}:`, e);
    return null;
  }
}

/**
 * Convert blob to data URL
 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Convert blob to base64 string (without data URL prefix)
 */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Simple hash function to compare images
 * Used to detect if an image has changed
 */
export async function simpleHash(str) {
  // Convert input to string if it's not already
  if (typeof str !== 'string') {
    str = String(str);
  }

  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString();
}

/**
 * Save ref_image to cache with fallback to sessionStorage
 * @param {string} base64Data - Base64 encoded image data
 * @param {string} name - Filename for the image (default: 'ref_image.png')
 * @param {Object} options - Configuration options
 * @param {boolean} options.skipSessionCache - Skip writing to shared session key
 * @returns {Promise<boolean>} - Success status
 */
export async function saveRefImageToCache(
  base64Data,
  name = 'ref_image.png',
  options = {}
) {
  try {
    // Create a cache key to track the current ref_image
    const currentHash = await simpleHash(base64Data);
    if (!options.skipSessionCache) {
      safeSetSessionItem('spline-editor-ref-image-hash', currentHash);
    }

    // Try to save the file to the bg folder via the backend API
    try {
      const formData = new FormData();
      formData.append('image', `data:image/png;base64,${base64Data}`);
      formData.append('name', name);

      const response = await fetch('/wanvideowrapper_qq/save_ref_image', {
        method: 'POST',
        body: formData
      });

      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          // Save to sessionStorage as backup (unless skipped)
          if (!options.skipSessionCache) {
            safeSetSessionItem(
              'spline-editor-cached-ref-image',
              JSON.stringify({
                base64: base64Data,
                type: 'image/png',
                name,
                hash: currentHash,
                timestamp: Date.now()
              })
            );
          }

          return true;
        } else {
          console.error('Backend error saving ref image:', result.error);
          // Fallback to sessionStorage only
          if (!options.skipSessionCache) {
            safeSetSessionItem(
              'spline-editor-cached-ref-image',
              JSON.stringify({
                base64: base64Data,
                type: 'image/png',
                name,
                hash: currentHash,
                timestamp: Date.now()
              })
            );
          }
          return false;
        }
      } else {
        console.error('Failed to save ref image via API:', response.status);
        // Fallback to sessionStorage only
        if (!options.skipSessionCache) {
          safeSetSessionItem(
            'spline-editor-cached-ref-image',
            JSON.stringify({
              base64: base64Data,
              type: 'image/png',
              name,
              hash: currentHash,
              timestamp: Date.now()
            })
          );
        }
        return false;
      }
    } catch (error) {
      console.warn('API save failed, using sessionStorage fallback:', error);

      // Fallback to sessionStorage if API fails
      if (!options.skipSessionCache) {
        safeSetSessionItem(
          'spline-editor-cached-ref-image',
          JSON.stringify({
            base64: base64Data,
            type: 'image/png',
            name,
            hash: currentHash,
            timestamp: Date.now()
          })
        );
      }

      return true;
    }
  } catch (e) {
    console.error('Failed to cache ref image:', e);
    return false;
  }
}

/**
 * Check if cached ref_image exists and is different from current
 * @param {string|null} currentBase64 - Current base64 image data
 * @returns {Promise<Object|null>} - Cached image object or null
 */
export async function getCachedRefImage(currentBase64 = null) {
  try {
    const cachedData = sessionStorage.getItem('spline-editor-cached-ref-image');
    if (!cachedData) {
      return null;
    }

    const parsed = JSON.parse(cachedData);
    // Guard: only honor caches explicitly saved for bg image overlays
    if (parsed?.name && parsed.name !== 'bg_image.png') {
      return null;
    }

    // If current base64 is provided, check if it's different from cached
    if (currentBase64) {
      const currentHash = await simpleHash(currentBase64);
      if (currentHash === parsed.hash) {
        // Same image, no need to update
        return parsed;
      } else {
        // Different image, update cache
        await saveRefImageToCache(currentBase64, 'bg_image.png');
        return JSON.parse(
          sessionStorage.getItem('spline-editor-cached-ref-image')
        );
      }
    }

    return parsed;
  } catch (e) {
    console.error('Failed to get cached ref image:', e);
    return null;
  }
}

/**
 * Load cached ref_image as base64 data URL
 * Tries file system first, then falls back to sessionStorage
 * @returns {Promise<string|null>} - Data URL or null if not found
 */
export async function loadCachedRefImageAsBase64() {
  try {
    // First try to load from actual file in bg folder
    const timestamp = Date.now();
    const refImageUrl = new URL(
      `../bg/bg_image.png?t=${timestamp}`,
      import.meta.url
    ).href;
    const response = await fetch(refImageUrl);
    if (response.ok) {
      const blob = await response.blob();
      return blobToDataUrl(blob);
    }

    // If file doesn't exist, try to load from sessionStorage cache
    const cachedData = await getCachedRefImage();
    if (cachedData) {
      return `data:${cachedData.type};base64,${cachedData.base64}`;
    }

    return null;
  } catch (e) {
    console.error('Failed to load cached ref image as base64:', e);
    // Fallback to sessionStorage cache
    try {
      const cachedData = await getCachedRefImage();
      if (cachedData) {
        return `data:${cachedData.type};base64,${cachedData.base64}`;
      }
    } catch (fallbackError) {
      console.error('Fallback cache also failed:', fallbackError);
    }
    return null;
  }
}

/**
 * Safe sessionStorage setter to avoid quota errors
 * Silently fails if quota exceeded or not available
 */
export function safeSetSessionItem(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch (e) {
    // Silently ignore quota exceeded or unsupported errors
  }
}

/**
 * Load and save image data from a source
 * Returns both data URL and base64 separately
 */
export async function loadImageAndExtractBase64(imageUrl) {
  try {
    const dataUrl = await loadImageAsBase64(imageUrl);
    if (!dataUrl) {
      return { dataUrl: null, base64: null };
    }

    const base64 = dataUrl.startsWith('data:')
      ? dataUrl.split(',')[1]
      : dataUrl;
    return { dataUrl, base64 };
  } catch (e) {
    console.error('Error loading and extracting image:', e);
    return { dataUrl: null, base64: null };
  }
}

/**
 * Retrieve image dimensions from data URL
 */
export async function getImageDimensions(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = () => resolve({ width: 1, height: 1 });
    img.src = dataUrl;
  });
}