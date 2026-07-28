import * as ImageManipulator from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';

// One in-flight/settled promise per video uri — pickers, sendMedia and
// sendMediaGroup can all ask for the same poster without re-decoding.
const videoThumbPromises = new Map();

/**
 * Extract a local poster frame (JPEG file uri) from a video file/content uri.
 * Frame is taken at 1s (frame 0 is often black), falling back to 0 for
 * clips shorter than a second. Returns null on any failure — callers treat
 * a missing poster as "no thumbnail yet", never as an error.
 */
export const generateLocalVideoThumbnail = async (uri) => {
  if (!uri) return null;
  if (videoThumbPromises.has(uri)) return videoThumbPromises.get(uri);
  const task = (async () => {
    try {
      const { uri: thumbUri } = await VideoThumbnails.getThumbnailAsync(uri, {
        time: 1000,
        quality: 0.6,
      });
      return thumbUri || null;
    } catch {
      try {
        const { uri: thumbUri } = await VideoThumbnails.getThumbnailAsync(uri, {
          time: 0,
          quality: 0.6,
        });
        return thumbUri || null;
      } catch {
        return null;
      }
    }
  })();
  videoThumbPromises.set(uri, task);
  const result = await task;
  if (!result) videoThumbPromises.delete(uri); // allow a later retry
  return result;
};

export const generateThumbnail = async ({ file, messageType }) => {
  if (!file?.uri) return null;

  try {
    if (messageType === 'image') {
      const thumb = await ImageManipulator.manipulateAsync(
        file.uri,
        [{ resize: { width: 280 } }],
        {
          compress: 0.55,
          format: ImageManipulator.SaveFormat.WEBP,
        }
      );
      return thumb.uri;
    }

    if (messageType === 'video') {
      return file.thumbnailUri || file.previewUri
        || (await generateLocalVideoThumbnail(file.uri));
    }

    return null;
  } catch (error) {
    console.warn('thumbnail generation failed', error);
    return null;
  }
};
