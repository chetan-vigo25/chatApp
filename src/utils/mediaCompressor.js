import * as ImageManipulator from 'expo-image-manipulator';

export const getMessageTypeFromMime = (mimeType = '') => {
  const type = String(mimeType).toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.includes('pdf') || type.includes('msword') || type.includes('officedocument')) return 'document';
  return 'file';
};

export const validateMediaFile = ({ size = 0, type = '' }) => {
  const messageType = getMessageTypeFromMime(type);
  const limitByType = {
    image: 15 * 1024 * 1024,
    video: 150 * 1024 * 1024,
    document: 50 * 1024 * 1024,
    file: 50 * 1024 * 1024,
  };
  const maxSize = limitByType[messageType] || limitByType.file;
  if (size > maxSize) {
    return {
      valid: false,
      message: `File exceeds ${Math.round(maxSize / 1024 / 1024)}MB limit`,
      messageType,
    };
  }
  return { valid: true, messageType };
};

export const compressImage = async (file, options = {}) => {
  const quality = Number(options?.quality ?? 0.72);
  const maxWidth = Number(options?.maxWidth ?? 1600);
  const maxHeight = Number(options?.maxHeight ?? 1600);

  const originalWidth = Number(file?.width || 0);
  const originalHeight = Number(file?.height || 0);

  const resize =
    originalWidth > 0 && originalHeight > 0
      ? { width: Math.min(maxWidth, originalWidth), height: Math.min(maxHeight, originalHeight) }
      : { width: maxWidth };

  const result = await ImageManipulator.manipulateAsync(
    file.uri,
    [{ resize }],
    {
      compress: quality,
      format: ImageManipulator.SaveFormat.JPEG,
    }
  );

  return {
    ...file,
    uri: result.uri,
    width: result.width,
    height: result.height,
    type: 'image/jpeg',
  };
};

export const compressMedia = async (file, messageType) => {
  if (!file?.uri) return file;
  if (messageType === 'image') {
    return compressImage(file);
  }
  return file;
};
