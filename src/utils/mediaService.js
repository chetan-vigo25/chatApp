import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";
import { Alert, Linking, Platform } from "react-native";

export const APP_FOLDER = "baatCheet";
export const SENT_DIR = `${FileSystem.documentDirectory}${APP_FOLDER}/Sent/`;
export const RECEIVED_DIR = `${FileSystem.documentDirectory}${APP_FOLDER}/Received/`;

// Normalize URI for consistency
export const normalizeUri = (uri) => {
  if (!uri) return uri;
  if (/^(file|content|https?):\/\//i.test(uri)) return uri;
  return uri.startsWith("/") ? `file://${uri}` : uri;
};

// ---------------------------
// FOLDER MANAGEMENT
// ---------------------------
export const ensureAppFoldersExist = async () => {
  try {
    const baseDir = `${FileSystem.documentDirectory}${APP_FOLDER}`;
    if (!(await FileSystem.getInfoAsync(baseDir)).exists) {
      await FileSystem.makeDirectoryAsync(baseDir, { intermediates: true });
    }
    if (!(await FileSystem.getInfoAsync(SENT_DIR)).exists) {
      await FileSystem.makeDirectoryAsync(SENT_DIR, { intermediates: true });
    }
    if (!(await FileSystem.getInfoAsync(RECEIVED_DIR)).exists) {
      await FileSystem.makeDirectoryAsync(RECEIVED_DIR, { intermediates: true });
    }
    return true;
  } catch (err) {
    console.warn("❌ ensureAppFoldersExist error:", err);
    return false;
  }
};

export const ensureDirExists = async (dir) => {
  try {
    if (!(await FileSystem.getInfoAsync(dir)).exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
    return true;
  } catch (err) {
    console.error("❌ ensureDirExists error:", err);
    return false;
  }
};

// ---------------------------
// PERMISSIONS
// ---------------------------
let _hasPhotoPermission = null;

export async function requestStoragePermission() {
  if (_hasPhotoPermission !== null) return _hasPhotoPermission;

  if (Platform.OS === "android") {
    const { status } = await MediaLibrary.requestPermissionsAsync();
    _hasPhotoPermission = status === "granted";
    if (!_hasPhotoPermission) {
      throw new Error("Storage permission is required");
    }
    return _hasPhotoPermission;
  }

  if (Platform.OS === "ios") {
    const { status } = await MediaLibrary.requestPermissionsAsync({ writeOnly: false });
    _hasPhotoPermission = status === "granted";
    if (status === "limited") {
      console.log("iOS: limited photo access, consider prompting user for full access in settings");
      _hasPhotoPermission = true; // still allow saving, iOS handles limited access
    }
    if (!_hasPhotoPermission) {
      throw new Error("Photo library permission is required");
    }
    return _hasPhotoPermission;
  }

  return true;
}

// ---------------------------
// SAVE TO GALLERY
// ---------------------------
export async function saveFileToMediaLibrary(localUri, albumName = APP_FOLDER) {
  try {
    if (!localUri) return null;
    await requestStoragePermission();
    const normalized = normalizeUri(localUri);
    const asset = await MediaLibrary.createAssetAsync(normalized);
    try {
      await MediaLibrary.createAlbumAsync(albumName, asset, false);
    } catch (_) {} // album may already exist
    return asset;
  } catch (err) {
    console.warn("saveFileToMediaLibrary failed", err);
    return null;
  }
}

// ---------------------------
// COPY FILE TO APP FOLDER
// ---------------------------
export async function copyToAppFolder(inputUri, suggestedName = null, destDir = SENT_DIR, saveToLibrary = true, onProgress = null) {
  try {
    if (!inputUri) return null;
    await ensureDirExists(destDir);

    const uriWithoutQuery = inputUri.split("?")[0];
    const extMatch = uriWithoutQuery.match(/\.(\w+)$/);
    const ext = extMatch ? `.${extMatch[1]}` : "";

    // Avoid double extension
    const filename = suggestedName
      ? suggestedName.endsWith(ext) ? suggestedName : suggestedName + ext
      : `file_${Date.now()}${ext}`;

    const dest = `${destDir}${filename}`;

    // Remote URL
    if (/^https?:\/\//i.test(inputUri)) {
      const downloadResumable = FileSystem.createDownloadResumable(
        inputUri,
        dest,
        {},
        (d) => {
          if (onProgress && d.totalBytesExpectedToWrite > 0) {
            onProgress(d.totalBytesWritten / d.totalBytesExpectedToWrite);
          }
        }
      );
      const result = await downloadResumable.downloadAsync();
      const finalUri = normalizeUri(result.uri);
      if (saveToLibrary) await saveFileToMediaLibrary(finalUri);
      return finalUri;
    }

    // Local file
    if (/^file:\/\//i.test(inputUri) || inputUri.startsWith("/")) {
      await FileSystem.copyAsync({ from: inputUri, to: dest });
      const finalUri = normalizeUri(dest);
      if (saveToLibrary) await saveFileToMediaLibrary(finalUri);
      return finalUri;
    }

    // Content URI
    if (/^content:\/\//i.test(inputUri)) {
      const asset = await MediaLibrary.createAssetAsync(inputUri);
      if (asset && asset.uri) {
        await FileSystem.copyAsync({ from: asset.uri, to: dest });
        const finalUri = normalizeUri(dest);
        if (saveToLibrary) await saveFileToMediaLibrary(finalUri);
        return finalUri;
      }
    }

    return inputUri;
  } catch (err) {
    console.warn("copyToAppFolder error", err);
    return inputUri;
  }
}

// ---------------------------
// DOWNLOAD REMOTE FILE
// ---------------------------
export async function downloadRemoteToReceived(remoteUrl, filename, onProgress = null, saveToLibrary = true) {
  try {
    if (!remoteUrl) return null;
    await ensureDirExists(RECEIVED_DIR);

    const urlForExt = remoteUrl.split("?")[0];
    const extMatch = urlForExt.match(/\.(\w+)$/);
    const ext = extMatch ? `.${extMatch[1]}` : "";
    const safeFilename = filename.endsWith(ext) ? filename : filename + ext;

    const dest = `${RECEIVED_DIR}${safeFilename}`;

    const downloadResumable = FileSystem.createDownloadResumable(
      remoteUrl,
      dest,
      {},
      (d) => {
        if (onProgress && d.totalBytesExpectedToWrite > 0) {
          onProgress(d.totalBytesWritten / d.totalBytesExpectedToWrite);
        }
      }
    );

    const result = await downloadResumable.downloadAsync();
    const finalUri = normalizeUri(result.uri);
    if (saveToLibrary) await saveFileToMediaLibrary(finalUri);
    return finalUri;
  } catch (err) {
    console.warn("downloadRemoteToReceived failed", err);
    return null;
  }
}

// ---------------------------
// UPLOAD MEDIA
// ---------------------------
export async function uploadMediaFile({ file, chatId, dispatch, mediaUploadAction }) {
  try {
    if (!file || !dispatch || !mediaUploadAction) {
      throw new Error("Missing params for uploadMediaFile");
    }

    const formData = new FormData();
    formData.append("file", {
      uri: normalizeUri(file.uri),
      name: file.name || `file_${Date.now()}.jpg`,
      type: file.type || "image/jpeg",
    });

    if (chatId) formData.append("chatId", chatId);

    const action = await dispatch(mediaUploadAction(formData));
    return action;
  } catch (err) {
    console.error("❌ uploadMediaFile failed:", err);
    throw err;
  }
}

// ---------------------------
// DOWNLOAD & OPEN MEDIA
// ---------------------------
export async function downloadAndOpenMedia({ msg, dispatch, downloadAction, onProgress = null, openAfterDownload = false, saveToLibrary = true }) {
  try {
    if (!msg) throw new Error("Invalid message");

    if (msg.localUri) {
      const local = normalizeUri(msg.localUri);
      if (openAfterDownload && (await Linking.canOpenURL(local))) {
        await Linking.openURL(local);
      }
      return local;
    }

    let remoteUrl = msg.mediaUrl || msg.previewUrl || msg.url || null;
    if (!remoteUrl && downloadAction && dispatch) {
      const mediaId = msg.serverMessageId || msg.id;
      if (!mediaId) throw new Error("No media id");
      const action = await dispatch(downloadAction({ mediaId }));
      remoteUrl = action?.payload?.data?.url || action?.payload?.url || null;
    }
    if (!remoteUrl) throw new Error("No remote URL to download");

    const filename = `${msg.serverMessageId || msg.id || Date.now()}`;
    const localUri = await downloadRemoteToReceived(remoteUrl, filename, onProgress, saveToLibrary);
    if (!localUri) throw new Error("Download failed");

    if (openAfterDownload && (await Linking.canOpenURL(localUri))) {
      await Linking.openURL(localUri);
    }

    return localUri;
  } catch (err) {
    console.error("downloadAndOpenMedia error", err);
    Alert.alert("Download failed", err?.message || "Unable to download media");
    return null;
  }
}