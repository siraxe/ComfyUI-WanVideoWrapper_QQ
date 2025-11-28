/**
 * Video Background Manager Module
 * Handles video loading, processing, and metadata management
 */

import {
  loadBackgroundVideo,
  clearBackgroundVideo,
  recenterBackgroundVideo
} from '../canvas/canvas_video_background.js';
import { safeSetSessionItem } from './image-cache.js';

/**
 * Create video background manager instance
 * @param {Object} node - The PowerSplineEditor node instance
 * @returns {Object} - Manager with methods for handling video backgrounds
 */
export function createVideoBackgroundManager(node) {
  return {
    /**
     * Load video from path
     */
    async loadVideo(videoPath) {
      console.log('[VideoManager] Loading video from path:', videoPath);

      // Clear existing video metadata to force reload
      if (node.editor) {
        node.editor.videoMetadata = null;
      }

      // Store video data
      node.videoData = videoPath;

      // Clear any existing background image when loading video
      node.imgData = null;

      // Save to session storage for persistence
      try {
        safeSetSessionItem(
          `spline-editor-video-${node.uuid}`,
          JSON.stringify(videoPath)
        );
      } catch (e) {
        console.warn('[VideoManager] Could not save video data to session storage:', e);
      }

      // Load the video in the editor
      if (node.editor && loadBackgroundVideo) {
        loadBackgroundVideo(node.editor, videoPath);
      }

      return { success: true, videoPath };
    },

    /**
     * Clear video background
     */
    async clearVideo() {
      console.log('[VideoManager] Clearing video background');

      if (node.editor) {
        if (node.editor.videoMetadata && clearBackgroundVideo) {
          clearBackgroundVideo(node.editor);
        }

        // Clear video metadata
        node.editor.videoMetadata = null;

        if (node.editor.videoElement) {
          node.editor.videoElement.pause();
          node.editor.videoElement.style.display = 'none';
        }
      }

      // Clear stored video data
      node.videoData = null;

      // Clear from session storage
      try {
        if (node.uuid) {
          sessionStorage.removeItem(`spline-editor-video-${node.uuid}`);
        }
      } catch {}
    },

    /**
     * Process video file from LoadVideo node
     */
    async processVideoFile(videoFilename) {
      console.log('[VideoManager] Processing video file:', videoFilename);

      const payload = {
        video_filename: videoFilename,
        mask_width:
          node.widgets?.find(w => w.name === 'mask_width')?.value || 640,
        mask_height:
          node.widgets?.find(w => w.name === 'mask_height')?.value || 480
      };

      try {
        console.log('[DEBUG] Sending request to /wanvideowrapper_qq/process_video_file');
        const response = await fetch('/wanvideowrapper_qq/process_video_file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        console.log('[DEBUG] Response status:', response.status);
        const result = await response.json();
        console.log('[DEBUG] Response result:', result);

        if (result.success && result.paths?.bg_video) {
          console.log('[VideoManager] Video processed successfully');
          return await this.loadVideo(result.paths.bg_video);
        } else {
          throw new Error(result.error || 'Unknown error');
        }
      } catch (error) {
        console.error('[VideoManager] Error processing video file:', error);
        throw error;
      }
    },

    /**
     * Process video frames
     */
    async processVideoFrames(videoFrames) {
      console.log(
        '[VideoManager] Processing video frames through backend...',
        videoFrames.length,
        'frames'
      );

      const payload = {
        bg_image: videoFrames,
        ref_layer_data: [],
        mask_width:
          node.widgets?.find(w => w.name === 'mask_width')?.value || 640,
        mask_height:
          node.widgets?.find(w => w.name === 'mask_height')?.value || 480
      };

      try {
        const response = await fetch('/wanvideowrapper_qq/trigger_prepare_refs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (result.success && result.paths?.bg_video) {
          console.log('[VideoManager] Video created successfully');
          return await this.loadVideo(result.paths.bg_video);
        } else {
          throw new Error(result.error || 'Unknown error');
        }
      } catch (error) {
        console.error('[VideoManager] Error processing video:', error);
        throw error;
      }
    },

    /**
     * Handle video metadata from Python execution
     */
    async handleVideoFromExecution(videoInfo) {
      console.log('[VideoManager] Video metadata received from execution:', videoInfo);

      // Store video data
      node.videoData = videoInfo;

      // Clear any existing background image
      node.imgData = null;

      // Save to session storage
      try {
        safeSetSessionItem(
          `spline-editor-video-${node.uuid}`,
          JSON.stringify(videoInfo)
        );
      } catch (e) {
        console.warn('[VideoManager] Could not save video data to session storage:', e);
      }

      // Initialize editor if needed
      if (!node.editor) {
        const SplineEditor2 = (await import('../canvas/canvas_main.js')).default;
        node.editor = new SplineEditor2(node);
      }

      // Load the video
      if (node.editor && loadBackgroundVideo) {
        console.log('[VideoManager] Calling loadBackgroundVideo');
        loadBackgroundVideo(node.editor, videoInfo);
      }

      return { success: true };
    },

    /**
     * Restore video from session storage
     */
    async restoreFromSession() {
      try {
        if (!node.uuid) return null;

        const sessionVideoData = sessionStorage.getItem(
          `spline-editor-video-${node.uuid}`
        );
        if (sessionVideoData) {
          const videoData = JSON.parse(sessionVideoData);
          console.log(
            '[VideoManager] Restored video data from session:',
            videoData
          );
          return videoData;
        }
      } catch (error) {
        console.error('[VideoManager] Error restoring video from session:', error);
      }

      return null;
    },

    /**
     * Recenter video background if video is loaded
     */
    recenterVideo() {
      if (
        node.editor &&
        node.editor.videoElement &&
        node.editor.videoMetadata
      ) {
        try {
          recenterBackgroundVideo(node.editor);
          console.log('[VideoManager] Video recentered');
        } catch (error) {
          console.error('[VideoManager] Error recentering video:', error);
        }
      }
    },

    /**
     * Check if video is currently loaded
     */
    isVideoLoaded() {
      return !!(node.editor?.videoMetadata && node.videoData);
    },

    /**
     * Get current video metadata
     */
    getVideoMetadata() {
      return node.editor?.videoMetadata || null;
    },

    /**
     * Get current video data
     */
    getVideoData() {
      return node.videoData || null;
    },

    /**
     * Handle video frame update during playback
     */
    onVideoFrameUpdate(frameIndex) {
      // Placeholder for frame-specific logic
      console.log('[VideoManager] Video frame update:', frameIndex);
    }
  };
}