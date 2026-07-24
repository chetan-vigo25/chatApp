// services/autoDownloadSettings.js
// WhatsApp-style media auto-download matrix, persisted in AsyncStorage:
//   network type (wifi | cellular) × media type (image | video | audio | document)
//
// Defaults: on Wi-Fi everything except documents; on cellular images only.
// TODO(settings-ui): expose these toggles on a "Storage and data" settings
// screen — until then the defaults apply and the service is the single source
// of truth (getSettings / setSetting).
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';

const STORAGE_KEY = 'auto_download_settings_v1';

// MASTER SWITCH — auto-download is DISABLED product-wide: media downloads may
// ONLY start from an explicit user tap. Every auto path (open-chat receive in
// useChatLogic, background receive in RealtimeChatContext) checks this — flip
// to true here to re-enable the matrix later in ONE place. User-initiated
// downloads interrupted mid-flight still resume via hydratePending (they were
// explicitly started); only automatic starts of NEW downloads are banned.
export const AUTO_DOWNLOAD_ENABLED = false;

export const AUTO_DOWNLOAD_MEDIA_TYPES = ['image', 'video', 'audio', 'document'];

// All false — even if the master switch is re-enabled, nothing auto-downloads
// until the user opts in per type/network.
export const DEFAULT_AUTO_DOWNLOAD_SETTINGS = {
  wifi: { image: false, video: false, audio: false, document: false },
  cellular: { image: false, video: false, audio: false, document: false },
};

let cached = null;
let loadPromise = null;

const mergeWithDefaults = (raw = {}) => ({
  wifi: { ...DEFAULT_AUTO_DOWNLOAD_SETTINGS.wifi, ...(raw?.wifi || {}) },
  cellular: { ...DEFAULT_AUTO_DOWNLOAD_SETTINGS.cellular, ...(raw?.cellular || {}) },
});

export const getAutoDownloadSettings = async () => {
  if (cached) return cached;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      cached = mergeWithDefaults(raw ? JSON.parse(raw) : {});
    } catch {
      cached = mergeWithDefaults({});
    } finally {
      loadPromise = null;
    }
    return cached;
  })();
  return loadPromise;
};

export const setAutoDownloadSetting = async (networkKind, mediaType, enabled) => {
  const settings = await getAutoDownloadSettings();
  const network = networkKind === 'wifi' ? 'wifi' : 'cellular';
  if (!AUTO_DOWNLOAD_MEDIA_TYPES.includes(mediaType)) return settings;
  cached = {
    ...settings,
    [network]: { ...settings[network], [mediaType]: Boolean(enabled) },
  };
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch { /* keep in-memory value */ }
  return cached;
};

// Map the app's message types onto the 4 settings buckets.
const normalizeMediaType = (messageType) => {
  const type = String(messageType || '').toLowerCase();
  if (type === 'image' || type === 'photo') return 'image';
  if (type === 'video') return 'video';
  if (type === 'audio' || type === 'voice' || type === 'ptt') return 'audio';
  if (type === 'document' || type === 'file') return 'document';
  return null;
};

// NetInfo types other than wifi/ethernet count as metered (cellular bucket).
const normalizeNetworkKind = (networkType) => {
  const net = String(networkType || '').toLowerCase();
  if (net === 'wifi' || net === 'ethernet') return 'wifi';
  return 'cellular';
};

/**
 * Should this incoming media message auto-download on the current network?
 */
export const shouldAutoDownload = async (networkType, messageType) => {
  if (!AUTO_DOWNLOAD_ENABLED) return false; // master switch — tap-only downloads
  const mediaType = normalizeMediaType(messageType);
  if (!mediaType) return false;
  const settings = await getAutoDownloadSettings();
  const network = normalizeNetworkKind(networkType);
  return Boolean(settings?.[network]?.[mediaType]);
};

/**
 * Same check but resolves the CURRENT network itself (for callers without a
 * NetworkContext handle, e.g. the background receive path).
 */
export const shouldAutoDownloadNow = async (messageType) => {
  if (!AUTO_DOWNLOAD_ENABLED) return false; // master switch — tap-only downloads
  try {
    const state = await NetInfo.fetch();
    if (!state?.isConnected) return false;
    return shouldAutoDownload(state?.type, messageType);
  } catch {
    return false;
  }
};

export default {
  getAutoDownloadSettings,
  setAutoDownloadSetting,
  shouldAutoDownload,
  shouldAutoDownloadNow,
  AUTO_DOWNLOAD_ENABLED,
  DEFAULT_AUTO_DOWNLOAD_SETTINGS,
  AUTO_DOWNLOAD_MEDIA_TYPES,
};
