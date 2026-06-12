import React, { createContext, useContext, useState } from "react";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import { suspendAppLock, resumeAppLock } from '../services/appLockGuard';

const ImageContext = createContext();

// WhatsApp caps gallery multi-select at 30 per send; albums beyond this go
// out as multiple messages.
export const MEDIA_MULTI_SELECT_LIMIT = 30;

// Normalize one picker asset to the app's { uri, name, type, size } shape,
// resolving iOS ph:// and Android content:// URIs to readable file:// paths.
const normalizePickedAsset = async (asset, mediaType) => {
  const uri = asset?.uri;
  if (!uri) return null;

  const segments = uri.split('/');
  const name = asset.fileName || segments[segments.length - 1] || `media_${Date.now()}`;
  const type = asset.mimeType
    || (asset.type ? `${asset.type}/${(name.split('.').pop() || 'jpg')}` : (mediaType === 'video' ? 'video/mp4' : 'image/jpeg'));

  let finalUri = uri;

  if (Platform.OS === 'ios' && finalUri.startsWith('ph://')) {
    try {
      const assetId = finalUri.replace('ph://', '');
      const assetInfo = await MediaLibrary.getAssetInfoAsync(assetId);
      if (assetInfo?.localUri) finalUri = assetInfo.localUri;
    } catch (err) {
      console.warn('Failed to resolve ph:// uri, using original', err);
    }
  }

  if (Platform.OS === 'android' && finalUri.startsWith('content://')) {
    try {
      const dest = `${FileSystem.cacheDirectory}${Date.now()}_${name}`;
      const downloadRes = await FileSystem.downloadAsync(finalUri, dest);
      if (downloadRes?.uri) finalUri = downloadRes.uri;
    } catch (err) {
      console.warn('Failed to copy content:// uri to cache, using original', err);
    }
  }

  return { uri: finalUri, name, type, size: asset.fileSize || asset.size || 0 };
};

export const ImageProvider = ({ children }) => {
  const [image, setImage] = useState(null); // use null as initial state

  // Unified picker: supports 'image', 'video', 'document'
  const pickMedia = async (mediaType = 'image') => {
    // Opening a system picker backgrounds the app; suspend the app lock so the
    // return trip is not treated as a re-lock trigger (see services/appLockGuard).
    suspendAppLock();
    try {
      if (mediaType === 'document') {
        // pick document
        const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
        if (result.canceled) return null;
        const asset = result.assets?.[0];
        if (!asset?.uri) return null;

        let finalUri = asset.uri;

        // Android: copy content:// URIs to cache so upload can read them
        if (Platform.OS === 'android' && finalUri.startsWith('content://')) {
          try {
            const destName = asset.name || `file_${Date.now()}`;
            const dest = `${FileSystem.cacheDirectory}${destName}`;
            const downloadRes = await FileSystem.downloadAsync(finalUri, dest);
            if (downloadRes?.uri) finalUri = downloadRes.uri;
          } catch (err) {
            console.warn('Failed to copy content:// uri to cache for document', err);
          }
        }

        const file = {
          uri: finalUri,
          name: asset.name || `file_${Date.now()}`,
          type: asset.mimeType || 'application/octet-stream',
          size: asset.size || 0,
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
    } finally {
      resumeAppLock();
    }
  };

  const requestAndPickImage = async () => {
    // backward compatible: pick image
    return pickMedia('image');
  };

  // Multi-select picker for WhatsApp-style albums. Returns an ARRAY of
  // normalized files (possibly length 1), or null when cancelled.
  const pickMediaMultiple = async (mediaType = 'image', limit = MEDIA_MULTI_SELECT_LIMIT) => {
    suspendAppLock();
    try {
      if (mediaType === 'document') {
        const result = await DocumentPicker.getDocumentAsync({
          type: '*/*',
          copyToCacheDirectory: true,
          multiple: true,
        });
        if (result.canceled) return null;
        const assets = (result.assets || []).slice(0, limit);
        const files = [];
        for (const asset of assets) {
          const file = await normalizePickedAsset(asset, 'document');
          if (file) files.push({ ...file, type: asset.mimeType || 'application/octet-stream' });
        }
        return files.length ? files : null;
      }

      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        alert('Permission to access gallery is required!');
        return null;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: mediaType === 'video'
          ? ImagePicker.MediaTypeOptions.Videos
          : mediaType === 'all'
            ? ImagePicker.MediaTypeOptions.All
            : ImagePicker.MediaTypeOptions.Images,
        quality: 0.8, // light client-side compression; backend re-optimizes
        allowsEditing: false,
        allowsMultipleSelection: true,
        selectionLimit: limit,
        orderedSelection: true,
      });
      const cancelled = result.canceled ?? result.cancelled;
      if (cancelled) return null;

      const assets = (result.assets || []).slice(0, limit);
      const files = [];
      for (const asset of assets) {
        const file = await normalizePickedAsset(asset, asset.type === 'video' ? 'video' : mediaType);
        if (file) files.push(file);
      }
      return files.length ? files : null;
    } catch (error) {
      console.error('Multi Media Picker Error:', error);
      return null;
    } finally {
      resumeAppLock();
    }
  };

  return (
    <ImageContext.Provider value={{ image, requestAndPickImage, pickMedia, pickMediaMultiple, setImage }}>
      {children}
    </ImageContext.Provider>
  );
};

export const useImage = () => {
  const context = useContext(ImageContext);
  if (!context) throw new Error("useImage must be used inside ImageProvider");
  return context;
};