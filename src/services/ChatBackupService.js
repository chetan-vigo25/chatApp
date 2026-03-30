import {
  StorageAccessFramework,
  documentDirectory,
  writeAsStringAsync,
  makeDirectoryAsync,
  getInfoAsync,
  EncodingType,
} from 'expo-file-system/legacy';
import { Platform, ToastAndroid } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ChatDatabase from './ChatDatabase';

const APP_FOLDER_NAME = 'VibeConnect';
const SAF_URI_KEY = '@backup_saf_directory_uri';

/**
 * WhatsApp-style AUTOMATIC backup to device storage.
 *
 * First time:  Shows folder picker pre-selected at "VibeConnect" folder
 *              → User taps "Use this folder" ONCE
 * After that:  Saves directly — NO picker, NO share sheet, fully automatic
 *
 * Result on device (visible in file manager):
 *   VibeConnect/
 *   ├── Databases/
 *   │   ├── msgstore.db.backup
 *   │   └── msgstore-2026-03-24.db.backup
 *   └── Media/
 */
const createAndShareBackup = async (onProgress) => {

  onProgress?.('Reading messages...');

  // ─── Read ALL data from SQLite ───
  const db = await ChatDatabase.getDB();
  const messages = await db.getAllAsync(
    'SELECT * FROM messages ORDER BY chat_id, timestamp ASC'
  );

  onProgress?.(`Found ${messages.length} messages`);

  let replies = [];
  try { replies = await db.getAllAsync('SELECT * FROM message_replies'); } catch {}

  let chatMeta = [];
  try { chatMeta = await db.getAllAsync('SELECT * FROM chat_meta'); } catch {}

  // Group by chat_id
  const chatMap = {};
  for (const msg of messages) {
    const cid = msg.chat_id || 'unknown';
    if (!chatMap[cid]) chatMap[cid] = [];
    chatMap[cid].push(msg);
  }

  // Build backup JSON
  const backup = {
    version: 1,
    appName: APP_FOLDER_NAME,
    createdAt: new Date().toISOString(),
    timestamp: Date.now(),
    stats: {
      totalMessages: messages.length,
      totalChats: Object.keys(chatMap).length,
      totalReplies: replies.length,
    },
    chats: chatMap,
    replies,
    chatMeta,
  };

  const backupJSON = JSON.stringify(backup);
  const sizeBytes = backupJSON.length;
  const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);

  onProgress?.('Saving to device...');

  if (Platform.OS === 'android') {
    return await saveToAndroid(backupJSON, sizeMB, messages.length, Object.keys(chatMap).length, onProgress);
  }

  // iOS fallback
  return await saveToAppDocuments(backupJSON, sizeMB, messages.length, Object.keys(chatMap).length, onProgress);
};

// ─── ANDROID: Auto-save like WhatsApp ───────────────────

const saveToAndroid = async (backupJSON, sizeMB, messageCount, chatCount, onProgress) => {
  // Check if we already have permission from a previous backup
  let directoryUri = await AsyncStorage.getItem(SAF_URI_KEY);

  if (directoryUri) {
    // Try using cached permission — fully automatic, no picker
    try {
      const result = await writeBackupToSAF(directoryUri, backupJSON, sizeMB, messageCount, chatCount, onProgress);
      return result;
    } catch (err) {
      // Permission expired or folder deleted — need to re-request
      console.warn('[Backup] Cached SAF URI failed, re-requesting:', err?.message);
      await AsyncStorage.removeItem(SAF_URI_KEY);
      directoryUri = null;
    }
  }

  // First time: open folder picker pre-selected at "VibeConnect"
  // This creates the folder automatically if it doesn't exist
  const suggestedUri = StorageAccessFramework.getUriForDirectoryInRoot(APP_FOLDER_NAME);

  const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync(suggestedUri);

  if (!permission.granted) {
    throw new Error('Storage permission denied. Please allow access to save backup.');
  }

  directoryUri = permission.directoryUri;

  // Save permission for future auto-backups
  await AsyncStorage.setItem(SAF_URI_KEY, directoryUri);

  return await writeBackupToSAF(directoryUri, backupJSON, sizeMB, messageCount, chatCount, onProgress);
};

const writeBackupToSAF = async (directoryUri, backupJSON, sizeMB, messageCount, chatCount, onProgress) => {
  // Create Databases subfolder
  let dbFolderUri = directoryUri;
  try {
    dbFolderUri = await StorageAccessFramework.makeDirectoryAsync(directoryUri, 'Databases');
  } catch {
    // Folder might exist — find it
    try {
      const contents = await StorageAccessFramework.readDirectoryAsync(directoryUri);
      const existing = contents.find(uri =>
        decodeURIComponent(uri).toLowerCase().includes('databases')
      );
      if (existing) dbFolderUri = existing;
    } catch {}
  }

  // Create Media subfolder (for future use)
  try {
    await StorageAccessFramework.makeDirectoryAsync(directoryUri, 'Media');
  } catch {} // ignore if exists

  // Write main backup: msgstore.db.backup
  const mainFileUri = await StorageAccessFramework.createFileAsync(
    dbFolderUri,
    'msgstore.db.backup',
    'application/octet-stream'
  );
  await writeAsStringAsync(mainFileUri, backupJSON, { encoding: EncodingType.UTF8 });

  // Write timestamped backup: msgstore-2026-03-24.db.backup
  const dateStr = new Date().toISOString().slice(0, 10);
  try {
    const tsFileUri = await StorageAccessFramework.createFileAsync(
      dbFolderUri,
      `msgstore-${dateStr}.db.backup`,
      'application/octet-stream'
    );
    await writeAsStringAsync(tsFileUri, backupJSON, { encoding: EncodingType.UTF8 });
  } catch {} // non-critical

  onProgress?.(`Saved (${sizeMB} MB)`);
  ToastAndroid.show(`Backup saved to ${APP_FOLDER_NAME}/Databases/ (${sizeMB} MB)`, ToastAndroid.LONG);

  return {
    fileName: 'msgstore.db.backup',
    path: `${APP_FOLDER_NAME}/Databases/msgstore.db.backup`,
    sizeMB,
    messageCount,
    chatCount,
  };
};

// ─── iOS / FALLBACK ─────────────────────────────────────

const saveToAppDocuments = async (backupJSON, sizeMB, messageCount, chatCount, onProgress) => {
  const baseDir = documentDirectory + APP_FOLDER_NAME + '/';
  const dbDir = baseDir + 'Databases/';
  const mediaDir = baseDir + 'Media/';

  for (const dir of [baseDir, dbDir, mediaDir]) {
    const info = await getInfoAsync(dir);
    if (!info.exists) await makeDirectoryAsync(dir, { intermediates: true });
  }

  await writeAsStringAsync(dbDir + 'msgstore.db.backup', backupJSON, { encoding: EncodingType.UTF8 });

  const dateStr = new Date().toISOString().slice(0, 10);
  await writeAsStringAsync(dbDir + `msgstore-${dateStr}.db.backup`, backupJSON, { encoding: EncodingType.UTF8 });

  onProgress?.(`Saved (${sizeMB} MB)`);

  if (Platform.OS === 'ios') {
    try {
      const Sharing = require('expo-sharing');
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(dbDir + 'msgstore.db.backup', {
          mimeType: 'application/octet-stream',
          dialogTitle: `Save ${APP_FOLDER_NAME} Backup`,
        });
      }
    } catch {}
  }

  return {
    fileName: 'msgstore.db.backup',
    path: `${APP_FOLDER_NAME}/Databases/msgstore.db.backup`,
    sizeMB,
    messageCount,
    chatCount,
  };
};

export default { createAndShareBackup };