import React, { createContext, useContext, useState } from "react";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';

const ImageContext = createContext();

export const ImageProvider = ({ children }) => {
  const [image, setImage] = useState(null); // use null as initial state

  // Unified picker: supports 'image', 'video', 'document'
  const pickMedia = async (mediaType = 'image') => {
    try {
      if (mediaType === 'document') {
        // pick document
        const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: false });
        if (result.type === 'cancel') return null;
        const file = {
          uri: result.uri,
          name: result.name || `file_${Date.now()}`,
          type: result.mimeType || 'application/octet-stream',
          size: result.size || 0,
        };
        setImage(file);
        return file;
      }

      // Request permission for media library (images/videos)
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        alert('Permission to access gallery is required!');
        return null;
      }

      const mediaOptions = {
        mediaTypes: mediaType === 'video' ? ImagePicker.MediaTypeOptions.Videos : ImagePicker.MediaTypeOptions.Images,
        quality: 1,
        allowsEditing: false,
      };

      const result = await ImagePicker.launchImageLibraryAsync(mediaOptions);
      const cancelled = result.canceled ?? result.cancelled;
      if (cancelled) return null;
      const asset = result.assets?.[0] ?? {};
      const uri = asset.uri ?? result.uri;
      if (!uri) return null;
      // Try to derive filename and type
      const segments = uri.split('/');
      const name = asset.fileName || segments[segments.length - 1] || `media_${Date.now()}`;
      const type = asset.type ? `${asset.type}/${(name.split('.').pop() || 'jpg')}` : (asset.mimeType || (mediaType === 'video' ? 'video/mp4' : 'image/jpeg'));

      // Normalize URI for different platforms (ph:// iOS, content:// Android)
      let finalUri = uri;

      // iOS: resolve ph:// URIs to a file:// localUri using MediaLibrary
      if (Platform.OS === 'ios' && finalUri.startsWith('ph://')) {
        try {
          const assetId = finalUri.replace('ph://', '');
          const assetInfo = await MediaLibrary.getAssetInfoAsync(assetId);
          if (assetInfo?.localUri) finalUri = assetInfo.localUri;
        } catch (err) {
          // ignore and keep original uri
          console.warn('Failed to resolve ph:// uri, using original', err);
        }
      }

      // Android: copy content:// URIs to cache directory so Image can load them
      if (Platform.OS === 'android' && finalUri.startsWith('content://')) {
        try {
          const dest = `${FileSystem.cacheDirectory}${name}`;
          // downloadAsync works for content:// as well
          const downloadRes = await FileSystem.downloadAsync(finalUri, dest);
          if (downloadRes?.uri) finalUri = downloadRes.uri;
        } catch (err) {
          console.warn('Failed to copy content:// uri to cache, using original', err);
        }
      }

      const file = { uri: finalUri, name, type, size: asset.fileSize || 0 };
      setImage(file);
      return file;
    } catch (error) {
      console.error('Media Picker Error:', error);
      return null;
    }
  };

  const requestAndPickImage = async () => {
    // backward compatible: pick image
    return pickMedia('image');
  };

  return (
    <ImageContext.Provider value={{ image, requestAndPickImage, pickMedia, setImage }}>
      {children}
    </ImageContext.Provider>
  );
};

export const useImage = () => {
  const context = useContext(ImageContext);
  if (!context) throw new Error("useImage must be used inside ImageProvider");
  return context;
};