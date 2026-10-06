/**
 * WhatsApp-style media folders (Android).
 *
 *   Android/media/com.chat.baatCheet/TalksTry/Media/
 *     TalksTry Images/          IMG-20261006-TT0001.jpg   (gallery)
 *     TalksTry Images/Sent/     (.nomedia — not in the gallery)
 *     TalksTry Video/  (+ Sent/)
 *     TalksTry Audio/  TalksTry Voice Notes/
 *     TalksTry Documents/  (+ Sent/)
 *
 * The chat and the gallery share ONE file (no private copy + gallery copy), so
 * deleting it in the gallery removes it from the chat — the bubble then goes
 * back to the blurred "download" state (see ChatScreen goneMedia).
 * iOS / builds without the native module keep the old app-private storage.
 */
import { Platform } from 'react-native';
import MediaStore from 'expo-media-store';

const FOLDER = {
  image: 'TalksTry Images',
  video: 'TalksTry Video',
  audio: 'TalksTry Audio',
  voice: 'TalksTry Voice Notes',
  file: 'TalksTry Documents',
};
const PREFIX = { image: 'IMG', video: 'VID', audio: 'AUD', voice: 'PTT' };

const kindOf = (type, name = '') => {
  const t = String(type || '').toLowerCase();
  if (t === 'image' || t === 'photo' || t === 'gif' || t === 'sticker') return 'image';
  if (t === 'video') return 'video';
  if (t === 'voice' || t === 'ptt') return 'voice';
  if (t === 'audio') return 'audio';
  if (t === 'file' || t === 'document') return 'file';
  const ext = String(name).split('.').pop().toLowerCase();
  if (['jpg', 'jpeg', 'png', 'webp', 'heic', 'gif'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'mkv', '3gp', 'webm'].includes(ext)) return 'video';
  if (['m4a', 'mp3', 'aac', 'wav', 'ogg', 'opus', 'amr'].includes(ext)) return 'audio';
  return 'file';
};

const baseName = (uri) => {
  const raw = String(uri || '').split('?')[0].split('/').pop() || '';
  try { return decodeURIComponent(raw); } catch { return raw; }
};

const ymd = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

// IMG-20261006-TT1234.jpg — WhatsApp's IMG-YYYYMMDD-WA0001.jpg shape.
const waName = (kind, original) => {
  if (kind === 'file') return original || `document-${Date.now()}`;
  const ext = (original.includes('.') ? original.split('.').pop() : '') || (kind === 'video' ? 'mp4' : kind === 'image' ? 'jpg' : 'm4a');
  const seq = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return `${PREFIX[kind] || 'MED'}-${ymd()}-TT${seq}.${ext}`;
};

export const isWhatsappMediaStorageAvailable = () => Platform.OS === 'android' && MediaStore.isAvailable();

/** Root path of the WhatsApp-style folder, or null (iOS / no native module). */
export const whatsappMediaRoot = () => (isWhatsappMediaStorageAvailable() ? MediaStore.getMediaRoot() : null);

/** True when `uri` lives in the shared (gallery-visible) media folder. */
export const isInWhatsappMediaFolder = (uri) => {
  const root = whatsappMediaRoot();
  if (!root || !uri) return false;
  let path = String(uri);
  try { path = decodeURIComponent(path); } catch { /* keep */ }
  return path.replace(/^file:\/\//, '').startsWith(root);
};

/**
 * Move a just-downloaded (received) file into its WhatsApp folder and make it
 * gallery-visible. Returns the new file:// URI, or the original on failure.
 */
export const moveReceivedToWhatsappFolder = async (localUri, messageType) => {
  if (!isWhatsappMediaStorageAvailable() || !localUri || isInWhatsappMediaFolder(localUri)) return localUri;
  try {
    const original = baseName(localUri);
    const kind = kindOf(messageType, original);
    const out = await MediaStore.saveToMedia(localUri, FOLDER[kind], waName(kind, original), { scan: true, move: true });
    return out || localUri;
  } catch (err) {
    console.warn('[MEDIA:WA_FOLDER] move failed', err?.message);
    return localUri;
  }
};

/**
 * Copy an outgoing file into <Folder>/Sent (hidden from the gallery by
 * .nomedia, like WhatsApp). Returns the new file:// URI or null.
 */
export const moveSentToWhatsappFolder = async (localUri, messageTypeOrName = null) => {
  if (!isWhatsappMediaStorageAvailable() || !localUri || isInWhatsappMediaFolder(localUri)) return null;
  try {
    const original = baseName(localUri);
    const kind = kindOf(messageTypeOrName, original);
    return await MediaStore.saveToMedia(localUri, `${FOLDER[kind]}/Sent`, waName(kind, original), { scan: false, move: true });
  } catch (err) {
    console.warn('[MEDIA:WA_FOLDER] sent move failed', err?.message);
    return null;
  }
};

/** Synchronous existence check for files in the shared folder. */
export const whatsappMediaFileExists = (uri) => (isWhatsappMediaStorageAvailable() ? MediaStore.fileExists(uri) : true);
