// utils/mediaService.js
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import { Platform, Alert, Linking } from 'react-native';
import { apiCall } from '../Config/Https';

// Define all directories - using FileSystem.documentDirectory for compatibility
export const APP_FOLDER = 'baatCheet';
export const SENT_DIR = `${FileSystem.documentDirectory}${APP_FOLDER}/Sent/`;
export const RECEIVED_DIR = `${FileSystem.documentDirectory}${APP_FOLDER}/Received/`;
export const THUMBNAIL_DIR = `${FileSystem.documentDirectory}${APP_FOLDER}/Thumbnails/`;
export const MEDIA_DIR = `${FileSystem.documentDirectory}${APP_FOLDER}/media/`;

// Media type subdirectories
export const IMAGE_SENT_DIR = `${SENT_DIR}Images/`;
export const VIDEO_SENT_DIR = `${SENT_DIR}Videos/`;
export const DOCUMENT_SENT_DIR = `${SENT_DIR}Documents/`;

export const IMAGE_RECEIVED_DIR = `${RECEIVED_DIR}Images/`;
export const VIDEO_RECEIVED_DIR = `${RECEIVED_DIR}Videos/`;
export const DOCUMENT_RECEIVED_DIR = `${RECEIVED_DIR}Documents/`;

// Track initialization status
let directoriesInitialized = false;
let initializationPromise = null;

// Normalize URI for consistency
export const normalizeUri = (uri) => {
  if (!uri) return uri;
  if (uri.startsWith('file://')) return uri;
  if (uri.startsWith('/')) return `file://${uri}`;
  if (uri.startsWith('content://')) return uri;
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  return uri;
};

// Initialize all app directories (export this function)
export const initializeAppDirectories = async () => {
  // Return existing promise if already initializing
  if (initializationPromise) {
    return initializationPromise;
  }

  // Return immediately if already initialized
  if (directoriesInitialized) {
    return true;
  }

  initializationPromise = (async () => {
    try {
      console.log('📁 Initializing app directories...');
      
      // Create main app folder
      const appDir = `${FileSystem.documentDirectory}${APP_FOLDER}`;
      const appDirInfo = await FileSystem.getInfoAsync(appDir);
      if (!appDirInfo.exists) {
        await FileSystem.makeDirectoryAsync(appDir, { intermediates: true });
        console.log('📁 Created app directory:', appDir);
      }

      // Create all required subdirectories
      const dirs = [
        SENT_DIR,
        RECEIVED_DIR,
        THUMBNAIL_DIR,
        MEDIA_DIR,
        IMAGE_SENT_DIR,
        VIDEO_SENT_DIR,
        DOCUMENT_SENT_DIR,
        IMAGE_RECEIVED_DIR,
        VIDEO_RECEIVED_DIR,
        DOCUMENT_RECEIVED_DIR,
      ];

      for (const dir of dirs) {
        try {
          const dirInfo = await FileSystem.getInfoAsync(dir);
          if (!dirInfo.exists) {
            await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
            console.log(`📁 Created directory: ${dir}`);
          }
        } catch (err) {
          console.warn(`⚠️ Failed to create directory ${dir}:`, err);
        }
      }

      directoriesInitialized = true;
      console.log('✅ All app directories initialized successfully');
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize directories:', error);
      directoriesInitialized = false;
      return false;
    } finally {
      initializationPromise = null;
    }
  })();

  return initializationPromise;
};

// Alias for backward compatibility
export const ensureAppFoldersExist = initializeAppDirectories;

// Request permissions
export const requestStoragePermission = async () => {
  if (Platform.OS === 'android') {
    const { status } = await MediaLibrary.requestPermissionsAsync();
    return status === 'granted';
  } else if (Platform.OS === 'ios') {
    const { status } = await MediaLibrary.requestPermissionsAsync();
    return status === 'granted' || status === 'limited';
  }
  return true;
};

// Ensure a specific directory exists
export const ensureDirExists = async (dir) => {
  try {
    const dirInfo = await FileSystem.getInfoAsync(dir);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
    return true;
  } catch (err) {
    console.error('❌ ensureDirExists error:', err);
    return false;
  }
};

// Get appropriate directory based on media type and direction
const getDestinationDir = (type, isOutgoing) => {
  const baseDir = isOutgoing ? SENT_DIR : RECEIVED_DIR;
  
  switch (type?.toLowerCase()) {
    case 'image':
    case 'photo':
      return isOutgoing ? IMAGE_SENT_DIR : IMAGE_RECEIVED_DIR;
    case 'video':
      return isOutgoing ? VIDEO_SENT_DIR : VIDEO_RECEIVED_DIR;
    case 'document':
    case 'file':
      return isOutgoing ? DOCUMENT_SENT_DIR : DOCUMENT_RECEIVED_DIR;
    default:
      return baseDir;
  }
};

// Generate safe filename
const generateFilename = (originalUri, prefix = 'file', customExt = null) => {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  
  if (customExt) {
    return `${prefix}_${timestamp}_${random}.${customExt.replace('.', '')}`;
  }
  
  // Extract extension from URI
  const uriParts = originalUri.split('.');
  const ext = uriParts.length > 1 ? uriParts.pop().split('?')[0].split('#')[0] : 'bin';
  return `${prefix}_${timestamp}_${random}.${ext}`;
};

// Copy file to app folder
export const copyToAppFolder = async (inputUri, suggestedName = null, destDir = SENT_DIR, onProgress = null) => {
  try {
    if (!inputUri) return null;

    // Ensure directories exist first
    await initializeAppDirectories();

    // Backward compatibility: some call sites pass onProgress in 4th arg
    if (typeof destDir === 'function' && onProgress == null) {
      onProgress = destDir;
      destDir = SENT_DIR;
    }

    const normalizedUri = normalizeUri(inputUri);
    
    // Determine destination directory based on file type if not specified
    if (destDir === SENT_DIR && suggestedName) {
      // Try to determine type from suggestedName or extension
      const ext = suggestedName.split('.').pop()?.toLowerCase();
      if (ext) {
        if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
          destDir = IMAGE_SENT_DIR;
        } else if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) {
          destDir = VIDEO_SENT_DIR;
        } else if (['pdf', 'doc', 'docx', 'txt'].includes(ext)) {
          destDir = DOCUMENT_SENT_DIR;
        }
      }
    }

    await ensureDirExists(destDir);

    // Generate filename
    const uriWithoutQuery = normalizedUri.split('?')[0];
    const extMatch = uriWithoutQuery.match(/\.(\w+)$/);
    const ext = extMatch ? extMatch[1] : '';
    
    const filename = suggestedName
      ? suggestedName.endsWith(ext) ? suggestedName : `${suggestedName}.${ext}`
      : generateFilename(normalizedUri, 'sent');

    const destination = `${destDir}${filename}`;

    console.log('📋 Copying file:', {
      from: normalizedUri.substring(0, 50) + '...',
      to: destination,
      type: destDir.includes('Images') ? 'image' : destDir.includes('Videos') ? 'video' : 'document'
    });

    // Handle remote URLs
    if (/^https?:\/\//i.test(normalizedUri)) {
      const downloadResumable = FileSystem.createDownloadResumable(
        normalizedUri,
        destination,
        {},
        (downloadProgress) => {
          if (onProgress && downloadProgress.totalBytesExpectedToWrite > 0) {
            onProgress(downloadProgress.totalBytesWritten / downloadProgress.totalBytesExpectedToWrite);
          }
        }
      );

      const result = await downloadResumable.downloadAsync();
      return normalizeUri(result.uri);
    }

    // Handle local files
    if (/^file:\/\//i.test(normalizedUri) || normalizedUri.startsWith('/')) {
      await FileSystem.copyAsync({ from: normalizedUri, to: destination });
      return normalizeUri(destination);
    }

    // Handle content URIs
    if (/^content:\/\//i.test(normalizedUri)) {
      try {
        const asset = await MediaLibrary.createAssetAsync(normalizedUri);
        if (asset && asset.uri) {
          await FileSystem.copyAsync({ from: asset.uri, to: destination });
          return normalizeUri(destination);
        }
      } catch (err) {
        console.warn('Content URI copy failed, using original:', err);
        return normalizedUri;
      }
    }

    return normalizedUri;
  } catch (err) {
    console.warn('copyToAppFolder error:', err);
    return inputUri; // Return original as fallback
  }
};

// Download remote file to received folder
export const downloadRemoteToReceived = async (remoteUrl, filename, onProgress = null, saveToLibrary = true) => {
  try {
    if (!remoteUrl) return null;

    // Ensure directories exist
    await initializeAppDirectories();

    // Determine file type from URL or filename
    const urlExt = remoteUrl.split('?')[0].split('.').pop()?.toLowerCase();
    const nameExt = filename.split('.').pop()?.toLowerCase();
    const ext = urlExt || nameExt || 'bin';
    
    let destDir = RECEIVED_DIR;
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
      destDir = IMAGE_RECEIVED_DIR;
    } else if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) {
      destDir = VIDEO_RECEIVED_DIR;
    } else if (['pdf', 'doc', 'docx', 'txt', 'zip'].includes(ext)) {
      destDir = DOCUMENT_RECEIVED_DIR;
    }

    await ensureDirExists(destDir);

    const safeFilename = filename.endsWith(ext) ? filename : `${filename}.${ext}`;
    const destination = `${destDir}${safeFilename}`;

    console.log('📥 Downloading to:', destination);

    // Check if already exists
    const fileInfo = await FileSystem.getInfoAsync(destination);
    if (fileInfo.exists) {
      console.log('✅ File already exists:', destination);
      return normalizeUri(destination);
    }

    const downloadResumable = FileSystem.createDownloadResumable(
      remoteUrl,
      destination,
      {},
      (downloadProgress) => {
        if (onProgress && downloadProgress.totalBytesExpectedToWrite > 0) {
          onProgress(downloadProgress.totalBytesWritten / downloadProgress.totalBytesExpectedToWrite);
        }
      }
    );

    const result = await downloadResumable.downloadAsync();
    const finalUri = normalizeUri(result.uri);

    if (saveToLibrary) {
      try {
        await saveFileToMediaLibrary(finalUri, APP_FOLDER);
      } catch (err) {
        console.warn('Save to library failed:', err);
      }
    }

    return finalUri;
  } catch (err) {
    console.warn('downloadRemoteToReceived failed:', err);
    return null;
  }
};

// Save file to media library
export const saveFileToMediaLibrary = async (localUri, albumName = APP_FOLDER) => {
  try {
    if (!localUri) return null;
    
    const hasPermission = await requestStoragePermission();
    if (!hasPermission) {
      console.log('⚠️ No media library permission');
      return null;
    }

    const normalized = normalizeUri(localUri);
    const asset = await MediaLibrary.createAssetAsync(normalized);
    
    try {
      const album = await MediaLibrary.getAlbumAsync(albumName);
      if (album) {
        await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
      } else {
        await MediaLibrary.createAlbumAsync(albumName, asset, false);
      }
    } catch (albumErr) {
      console.warn('Album creation failed:', albumErr);
    }
    
    return asset;
  } catch (err) {
    console.warn('saveFileToMediaLibrary failed:', err);
    return null;
  }
};

// Upload media file
export const uploadMediaFile = async ({ file, chatId, dispatch, mediaUploadAction }) => {
  try {
    if (!file || !dispatch || !mediaUploadAction) {
      throw new Error('Missing params for uploadMediaFile');
    }

    // Ensure file is in app folder first
    const persistentUri = await copyToAppFolder(file.uri, file.name, SENT_DIR);
    if (!persistentUri || typeof persistentUri !== 'string') {
      throw new Error('Invalid local file URI for upload');
    }

    if (!persistentUri.startsWith('file://') && !persistentUri.startsWith('content://')) {
      throw new Error(`Unsupported upload URI format: ${persistentUri}`);
    }

    const formData = new FormData();
    formData.append('file', {
      uri: persistentUri,
      name: file.name || `file_${Date.now()}.jpg`,
      type: file.type || 'image/jpeg',
    });

    if (chatId) formData.append('chatId', chatId);

    const action = await dispatch(mediaUploadAction(formData));
    
    // Return both server response and local URI
    return {
      ...action,
      localUri: persistentUri
    };
  } catch (err) {
    const message = String(err?.message || err || 'upload failed');
    console.error('❌ uploadMediaFile failed:', {
      message,
      fileUri: file?.uri,
      fileType: file?.type,
      fileName: file?.name,
      chatId,
      hints: [
        'Check BACKEND_URL host reachability (avoid localhost on physical device).',
        'Verify internet permission and active connection.',
        'Confirm multipart file URI uses file:// or content:// format.',
        'Confirm server SSL certificate and endpoint availability.',
      ],
    });
    throw err;
  }
};

// Download and open media
export const downloadAndOpenMedia = async ({ msg, dispatch, downloadAction, onProgress = null, openAfterDownload = false, saveToLibrary = true }) => {
  try {
    if (!msg) throw new Error('Invalid message');

    // Check if already downloaded
    if (msg.localUri) {
      const fileInfo = await FileSystem.getInfoAsync(msg.localUri);
      if (fileInfo.exists) {
        if (openAfterDownload) {
          await Linking.openURL(msg.localUri);
        }
        return msg.localUri;
      }
    }

    // Get download URL
    let remoteUrl = msg.mediaUrl || msg.previewUrl || msg.url || null;
    
    if (!remoteUrl && downloadAction && dispatch) {
      const mediaId = msg.serverMessageId || msg.id;
      if (!mediaId) throw new Error('No media id');
      
      const action = await dispatch(downloadAction({ mediaId }));
      remoteUrl = action?.payload?.data?.downloadUrl || 
                  action?.payload?.downloadUrl || 
                  action?.payload?.url || 
                  null;
    }

    if (!remoteUrl) throw new Error('No remote URL to download');

    // Generate filename from message ID
    const filename = `${msg.serverMessageId || msg.id || Date.now()}`;
    
    // Download file
    const localUri = await downloadRemoteToReceived(remoteUrl, filename, onProgress, saveToLibrary);
    
    if (!localUri) throw new Error('Download failed');

    if (openAfterDownload) {
      await Linking.openURL(localUri);
    }

    return localUri;
  } catch (err) {
    console.error('downloadAndOpenMedia error:', err);
    Alert.alert('Download failed', err?.message || 'Unable to download media');
    return null;
  }
};

// Media API functions
export async function mediaAllFiles({ category = null, chatId = null, page = 1, limit = 20, groupByCategory = false } = {}) {
  return apiCall('POST', 'user/media/all/files', {
    category,
    chatId,
    page,
    limit,
    groupByCategory,
  });
}

export async function mediaView(id) {
  return apiCall('POST', 'user/media/view', { id });
}

export async function mediaDelete(id) {
  return apiCall('POST', 'user/media/delete', { id });
}

export async function mediaDownloadSigned(mediaId) {
  return apiCall('POST', 'user/media/download', { mediaId });
}

export async function persistDownloadedMedia({ mediaId, chatId, sourceUrl, fileName, messageType = 'file', onProgress = null }) {
  if (!mediaId) throw new Error('mediaId required');
  if (!sourceUrl) throw new Error('sourceUrl required');

  await initializeAppDirectories();

  const type = String(messageType || 'file').toLowerCase();
  let baseDir = MEDIA_DIR;
  
  if (type === 'image' || type === 'photo') {
    baseDir = IMAGE_RECEIVED_DIR;
  } else if (type === 'video') {
    baseDir = VIDEO_RECEIVED_DIR;
  } else {
    baseDir = DOCUMENT_RECEIVED_DIR;
  }

  await ensureDirExists(baseDir);

  const ext = sourceUrl.split('.').pop()?.split('?')[0] || 'bin';
  const safeFileName = fileName || `${mediaId}.${ext}`;
  const destination = `${baseDir}${safeFileName}`;

  // Check if already exists
  const fileInfo = await FileSystem.getInfoAsync(destination);
  if (fileInfo.exists) {
    console.log('✅ File already exists:', destination);
    return normalizeUri(destination);
  }

  console.log('[MEDIA:DOWNLOAD:START]', mediaId);
  
  const resumable = FileSystem.createDownloadResumable(
    sourceUrl,
    destination,
    {},
    (event) => {
      const progress = event?.totalBytesExpectedToWrite
        ? event.totalBytesWritten / event.totalBytesExpectedToWrite
        : 0;
      if (typeof onProgress === 'function') onProgress(progress);
    }
  );

  const result = await resumable.downloadAsync();
  const localUri = normalizeUri(result?.uri || destination);
  console.log('[MEDIA:DOWNLOAD:COMPLETE]', localUri);
  
  return localUri;
}

// Clean up old temp files
export const cleanupTempFiles = async (maxAge = 24 * 60 * 60 * 1000) => { // 24 hours
  try {
    const tempDir = THUMBNAIL_DIR;
    const dirInfo = await FileSystem.getInfoAsync(tempDir);
    
    if (!dirInfo.exists) return;

    const files = await FileSystem.readDirectoryAsync(tempDir);
    const now = Date.now();

    for (const file of files) {
      const filePath = `${tempDir}${file}`;
      const fileInfo = await FileSystem.getInfoAsync(filePath);
      
      if (fileInfo.exists && fileInfo.modificationTime) {
        const fileAge = now - (fileInfo.modificationTime * 1000);
        if (fileAge > maxAge) {
          await FileSystem.deleteAsync(filePath);
          console.log('🗑️ Deleted old temp file:', file);
        }
      }
    }
  } catch (error) {
    console.error('❌ Cleanup failed:', error);
  }
};

// Get file info
export const getFileInfo = async (uri) => {
  try {
    const normalized = normalizeUri(uri);
    const info = await FileSystem.getInfoAsync(normalized);
    
    if (!info.exists) {
      return null;
    }

    return {
      uri: normalized,
      size: info.size,
      exists: true,
      modificationTime: info.modificationTime
    };
  } catch (error) {
    console.error('❌ Get file info failed:', error);
    return null;
  }
};