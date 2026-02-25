import React, { createContext, useContext, useState } from "react";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";
import { Platform, Alert } from "react-native";

const ImageContext = createContext();

export const ImageProvider = ({ children }) => {
  const [image, setImage] = useState(null);

  // ---------------------------
  // PERMISSIONS HANDLER
  // ---------------------------
  const requestPermissions = async () => {
    if (Platform.OS === "android") {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission Required", "Storage access is required!");
        return false;
      }
      return true;
    }

    if (Platform.OS === "ios") {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted" && status !== "limited") {
        Alert.alert("Permission Required", "Photo library access is required!");
        return false;
      }
      return true;
    }

    return true;
  };

  // ---------------------------
  // MEDIA PICKER
  // ---------------------------
  const pickMedia = async (mediaType = "image") => {
    try {
      // 1️⃣ Document
      if (mediaType === "document") {
        const result = await DocumentPicker.getDocumentAsync({
          type: "*/*",
          copyToCacheDirectory: false,
        });
        if (result.type === "cancel") return null;

        const file = {
          uri: result.uri,
          name: result.name || `file_${Date.now()}`,
          type: result.mimeType || "application/octet-stream",
          size: result.size || 0,
        };
        setImage(file);
        return file;
      }

      // 2️⃣ Image/Video
      const hasPermission = await requestPermissions();
      if (!hasPermission) return null;

      const mediaOptions = {
        mediaTypes:
          mediaType === "video"
            ? ImagePicker.MediaTypeOptions.Videos
            : ImagePicker.MediaTypeOptions.Images,
        quality: 1,
        allowsEditing: false,
      };

      const result = await ImagePicker.launchImageLibraryAsync(mediaOptions);
      const cancelled = result.canceled ?? result.cancelled;
      if (cancelled) return null;

      const asset = result.assets?.[0] ?? {};
      let uri = asset.uri ?? result.uri;
      if (!uri) return null;

      const segments = uri.split("/");
      const name = asset.fileName || segments[segments.length - 1] || `media_${Date.now()}`;
      const type =
        asset.type
          ? `${asset.type}/${name.split(".").pop() || "jpg"}`
          : asset.mimeType || (mediaType === "video" ? "video/mp4" : "image/jpeg");

      let finalUri = uri;

      // ---------------------------
      // iOS: resolve ph:// URIs
      // ---------------------------
      if (Platform.OS === "ios" && finalUri.startsWith("ph://")) {
        try {
          const assetId = finalUri.replace("ph://", "");
          const mediaAsset = await MediaLibrary.getAssetAsync(assetId);
          const assetInfo = await MediaLibrary.getAssetInfoAsync(mediaAsset);
          if (assetInfo?.localUri) {
            finalUri = assetInfo.localUri;
          } else if (assetInfo?.uri) {
            // fallback: copy to cache
            const tempUri = `${FileSystem.cacheDirectory}${name}`;
            await FileSystem.copyAsync({ from: assetInfo.uri, to: tempUri });
            finalUri = tempUri;
          } else {
            console.warn("iOS ph:// URI could not be resolved.");
            return null;
          }
        } catch (err) {
          console.warn("iOS ph:// URI resolution failed", err);
          return null;
        }
      }

      // ---------------------------
      // Android: copy content:// URIs to cache
      // ---------------------------
      if (Platform.OS === "android" && finalUri.startsWith("content://")) {
        try {
          const dest = `${FileSystem.cacheDirectory}${name}`;
          const downloadRes = await FileSystem.downloadAsync(finalUri, dest);
          if (downloadRes?.uri) finalUri = downloadRes.uri;
        } catch (err) {
          console.warn("Failed to copy content:// URI to cache, using original", err);
        }
      }

      const file = { uri: finalUri, name, type, size: asset.fileSize || 0 };
      setImage(file);
      return file;
    } catch (error) {
      console.error("Media Picker Error:", error);
      return null;
    }
  };

  // Backward compatible simple image picker
  const requestAndPickImage = async () => pickMedia("image");

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