import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";
import { Alert, Linking, Platform } from "react-native";

export const APP_FOLDER = "baatCheet";
export const SENT_DIR = `${FileSystem.documentDirectory}${APP_FOLDER}/Sent/`;
export const RECEIVED_DIR = `${FileSystem.documentDirectory}${APP_FOLDER}/Received/`;

export const normalizeUri = (uri) => {
  if (!uri) return uri;
  if (/^(file|content|https?):\/\//i.test(uri)) return uri;
  return uri.startsWith("/") ? `file://${uri}` : uri;
};

async function requestStoragePermission() {
  if (Platform.OS === 'android') {
    const { status } = await MediaLibrary.requestPermissionsAsync();
    if (status !== 'granted') {
      throw new Error('Storage permission is required');
    }
  }
}

export const ensureAppFoldersExist = async () => {
  try {
    const baseDir = `${FileSystem.documentDirectory}${APP_FOLDER}`;
    const baseInfo = await FileSystem.getInfoAsync(baseDir);
    if (!baseInfo.exists) {
      await FileSystem.makeDirectoryAsync(baseDir, { intermediates: true });
    }

    const sentInfo = await FileSystem.getInfoAsync(SENT_DIR);
    if (!sentInfo.exists) {
      await FileSystem.makeDirectoryAsync(SENT_DIR, { intermediates: true });
    }

    const recvInfo = await FileSystem.getInfoAsync(RECEIVED_DIR);
    if (!recvInfo.exists) {
      await FileSystem.makeDirectoryAsync(RECEIVED_DIR, { intermediates: true });
    }

    return true;
  } catch (err) {
    console.warn('❌ ensureAppFoldersExist error:', err);
    return false;
  }
};

export const ensureDirExists = async (dir) => {
  try {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
    return true;
  } catch (err) {
    console.error("❌ ensureDirExists error:", err);
    return false;
  }
};

export async function copyToAppFolder(inputUri, suggestedName = null, destDir = SENT_DIR, onProgress = null) {
  try {
    if (!inputUri) return null;
    await ensureDirExists(destDir);

    if (/^https?:\/\//i.test(inputUri)) {
      const urlForExt = inputUri.split("?")[0];
      const extMatch = urlForExt.match(/\.(\w+)$/);
      const ext = extMatch ? `.${extMatch[1]}` : "";
      const filename = (suggestedName || `file_${Date.now()}`) + ext;
      const dest = `${destDir}${filename}`;
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
      return result?.uri ? normalizeUri(result.uri) : null;
    }

    if (/^file:\/\//i.test(inputUri) || inputUri.startsWith("/")) {
      const extMatch = inputUri.split('?')[0].match(/\.(\w+)$/);
      const ext = extMatch ? `.${extMatch[1]}` : "";
      const filename = (suggestedName || `file_${Date.now()}`) + ext;
      const dest = `${destDir}${filename}`;
      await FileSystem.copyAsync({ from: inputUri, to: dest });
      return normalizeUri(dest);
    }

    if (/^content:\/\//i.test(inputUri)) {
      const asset = await MediaLibrary.createAssetAsync(inputUri);
      if (asset && asset.uri) {
        const extMatch = (asset.filename || "").match(/\.(\w+)$/);
        const ext = extMatch ? `.${extMatch[1]}` : "";
        const filename = (suggestedName || `file_${Date.now()}`) + ext;
        const dest = `${destDir}${filename}`;
        await FileSystem.copyAsync({ from: asset.uri, to: dest });
        return normalizeUri(dest);
      }
    }

    return inputUri;
  } catch (err) {
    console.warn("copyToAppFolder error", err);
    return inputUri;
  }
}

export async function saveFileToMediaLibrary(localUri, albumName = APP_FOLDER) {
  try {
    if (!localUri) return null;
    const normalized = normalizeUri(localUri);
    const { status } = await MediaLibrary.requestPermissionsAsync();
    if (status !== "granted" && status !== "limited") return null;
    const asset = await MediaLibrary.createAssetAsync(normalized);
    try {
      await MediaLibrary.createAlbumAsync(albumName, asset, false);
    } catch (e) {}
    return asset;
  } catch (err) {
    console.warn("saveFileToMediaLibrary failed", err);
    return null;
  }
}

export async function downloadRemoteToReceived(remoteUrl, filename, onProgress = null) {
  try {
    if (!remoteUrl) return null;
    await ensureDirExists(RECEIVED_DIR);
    const urlForExt = remoteUrl.split("?")[0];
    const extMatch = urlForExt.match(/\.(\w+)$/);
    const ext = extMatch ? `.${extMatch[1]}` : "";
    const safeFilename = (filename || `recv_${Date.now()}`) + ext;
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
    return result?.uri ? normalizeUri(result.uri) : null;
  } catch (err) {
    console.warn("downloadRemoteToReceived failed", err);
    return null;
  }
}

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
    
    if (chatId) {
      formData.append("chatId", chatId);
    }

    const action = await dispatch(mediaUploadAction(formData));
    return action;
  } catch (err) {
    console.error("❌ uploadMediaFile failed:", err);
    throw err;
  }
}

export async function downloadAndOpenMedia({ msg, dispatch, downloadAction, onProgress = null, openAfterDownload = false, saveToLibrary = true }) {
  try {
    if (!msg) throw new Error("Invalid message");

    if (msg.localUri) {
      const local = normalizeUri(msg.localUri);
      if (openAfterDownload) {
        const can = await Linking.canOpenURL(local);
        if (can) await Linking.openURL(local);
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
    const localUri = await downloadRemoteToReceived(remoteUrl, filename, onProgress);
    if (!localUri) throw new Error("Download failed");

    if (saveToLibrary) {
      try { await saveFileToMediaLibrary(localUri, APP_FOLDER); } catch (_) {}
    }

    if (openAfterDownload) {
      const supported = await Linking.canOpenURL(localUri);
      if (supported) await Linking.openURL(localUri);
    }

    return localUri;
  } catch (err) {
    console.error("downloadAndOpenMedia error", err);
    Alert.alert("Download failed", err?.message || "Unable to download media");
    return null;
  }
}