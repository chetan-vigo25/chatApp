import * as ImageManipulator from 'expo-image-manipulator';

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
      return file.thumbnailUri || file.previewUri || null;
    }

    return null;
  } catch (error) {
    console.warn('thumbnail generation failed', error);
    return null;
  }
};
