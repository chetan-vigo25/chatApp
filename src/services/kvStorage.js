/**
 * kvStorage — synchronous-capable key/value storage on MMKV, with an
 * AsyncStorage-compatible async API so call sites only change their import.
 *
 * TWO STORES
 *   deviceKv — device-level keys (theme, language, translation cache,
 *              auto-download matrix). Survives logout and account switch.
 *   kv       — ACCOUNT keys (drafts, chat colour, media maps). One MMKV
 *              instance per owner (`talkstry.acct.<userId>`), wiped by
 *              clearAccount() on logout / account switch — the same lifetime
 *              AsyncStorage.clear() gave them before. Another account never
 *              opens this instance.
 *
 * MIGRATION (no data loss, idempotent, safe to kill at any point)
 *   Reads are READ-THROUGH: a key missing in MMKV is read from AsyncStorage,
 *   copied into MMKV, and returned. The AsyncStorage copy is LEFT IN PLACE for
 *   one release as the fallback/rollback copy (removeItem deletes both so a
 *   deleted key is never resurrected). runMigrationSweep() copies the known keys
 *   eagerly and stamps `kv.migrated.v1` LAST; the stamp only lets boot code
 *   trust "absent in MMKV = absent", correctness never depends on it.
 *
 * FALLBACK ENGINE
 *   If the native MMKV module is missing (a dev client built before the
 *   dependency was added) or USE_MMKV is false, every call delegates to
 *   AsyncStorage — the app behaves exactly as it did before.
 *
 * NEVER put tokens or secrets here — those stay in expo-secure-store
 * (services/secureTokenStore.js). MMKV is unencrypted.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCurrentUserId, primeCurrentUser, subscribeCurrentUser } from './currentUser';

// ROLLBACK SWITCH: false → everything goes straight to AsyncStorage.
export const USE_MMKV = true;

const DEVICE_ID = 'talkstry.device';
const ACCOUNT_ID_PREFIX = 'talkstry.acct.';
const OWNER_KEY = 'kv.owner';
const MIGRATED_KEY = 'kv.migrated.v1';

export const DEVICE_KEYS = ['theme', 'app.language', 'translation.cache.v3', 'auto_download_settings_v1'];
export const ACCOUNT_KEYS = [
  'selectedColor',
  'chat_drafts_v1',
  'media_v2:media_files',
  'media_v2:thumbnails_cache',
  'media_v2:download_queue',
  'media_v2:pending_uploads',
];

let MMKVCtor = null;
if (USE_MMKV) {
  try {
    // eslint-disable-next-line global-require
    MMKVCtor = require('react-native-mmkv').MMKV || null;
  } catch {
    MMKVCtor = null;
  }
}

const open = (id) => {
  if (!MMKVCtor) return null;
  try { return new MMKVCtor({ id }); } catch { return null; }
};

const deviceInst = open(DEVICE_ID);
const accountInstances = new Map();

const accountInstFor = (ownerId) => {
  if (!deviceInst || !ownerId) return null;
  const id = `${ACCOUNT_ID_PREFIX}${ownerId}`;
  if (!accountInstances.has(id)) accountInstances.set(id, open(id));
  return accountInstances.get(id);
};

const persistedOwner = () => {
  try { return deviceInst?.getString(OWNER_KEY) || null; } catch { return null; }
};

// Account instance for the current owner. The persisted owner makes it
// resolvable synchronously at boot, before the auth provider has run.
const currentAccountInst = () => accountInstFor(getCurrentUserId() || persistedOwner());

// Keep the persisted owner in step with the signed-in user. When it CHANGES
// without a logout wipe having run (account switch), the previous owner's
// instance is wiped so account B can never open account A's data.
const adoptOwner = (id) => {
  if (!deviceInst || !id) return;
  const prev = persistedOwner();
  if (prev && prev !== String(id)) {
    try { accountInstFor(prev)?.clearAll(); } catch { /* best effort */ }
  }
  try { deviceInst.set(OWNER_KEY, String(id)); } catch { /* best effort */ }
};
if (deviceInst) {
  const already = getCurrentUserId();
  if (already) adoptOwner(already);
  subscribeCurrentUser((id) => { if (id) adoptOwner(id); });
}

const makeStore = (resolveInst, { awaitOwner = false } = {}) => {
  const inst = async () => {
    let i = resolveInst();
    if (!i && awaitOwner && deviceInst) {
      await primeCurrentUser().catch(() => null);
      i = resolveInst();
    }
    return i;
  };

  const getItem = async (key) => {
    const i = await inst();
    if (!i) return AsyncStorage.getItem(key);
    const hit = i.getString(key);
    if (hit !== undefined) return hit;
    const legacy = await AsyncStorage.getItem(key);
    if (legacy != null) {
      try { i.set(key, legacy); } catch { /* keep legacy copy as the source */ }
    }
    return legacy;
  };

  const setItem = async (key, value) => {
    const i = await inst();
    if (!i) return AsyncStorage.setItem(key, value);
    i.set(key, String(value));
    return undefined;
  };

  const removeItem = async (key) => {
    const i = await inst();
    if (i) { try { i.delete(key); } catch { /* noop */ } }
    return AsyncStorage.removeItem(key);
  };

  return {
    getItem,
    setItem,
    removeItem,
    multiGet: async (keys) => Promise.all(keys.map(async (k) => [k, await getItem(k)])),
    multiSet: async (pairs) => { for (const [k, v] of pairs) await setItem(k, v); },
    multiRemove: async (keys) => { for (const k of keys) await removeItem(k); },
    getAllKeys: async () => {
      const i = await inst();
      const legacy = await AsyncStorage.getAllKeys();
      return i ? [...new Set([...i.getAllKeys(), ...legacy])] : legacy;
    },
    /** Synchronous read for boot paths. undefined = not in MMKV (may exist in legacy storage). */
    getStringSync: (key) => {
      const i = resolveInst();
      if (!i) return undefined;
      try { return i.getString(key); } catch { return undefined; }
    },
    /** True once the one-time sweep ran, i.e. "absent in MMKV" is authoritative. */
    isMigratedSync: () => {
      const i = resolveInst();
      try { return !!i && i.getBoolean(MIGRATED_KEY) === true; } catch { return false; }
    },
    isAvailable: () => !!resolveInst(),
    _inst: resolveInst,
  };
};

export const deviceKv = makeStore(() => deviceInst);
export const kv = makeStore(currentAccountInst, { awaitOwner: true });

/**
 * Account keys that describe FILES still on this device (which media is downloaded,
 * and where). They are not secrets and are useless to any other account, so a plain
 * logout of an account whose local database is kept (same-user return) keeps them —
 * otherwise album tiles / shared-mediaId copies show the download button again after
 * logout → login although every file is still on disk. They are wiped whenever the
 * local database is wiped (different user, account deletion).
 */
export const MEDIA_RECORD_KEYS = ['media_v2:media_files'];

/**
 * Wipe the signed-in owner's account instance (logout / account switch). Device
 * keys are untouched. Also forgets the owner so account reads fall straight
 * through to AsyncStorage while nobody is signed in.
 * `preserve` = keys to carry across the wipe (see MEDIA_RECORD_KEYS).
 */
export const clearAccount = ({ preserve = [] } = {}) => {
  if (!deviceInst) return;
  const owner = getCurrentUserId() || persistedOwner();
  try {
    const inst = accountInstFor(owner);
    if (inst) {
      const kept = preserve
        .map((key) => [key, inst.getString(key)])
        .filter(([, value]) => value !== undefined);
      inst.clearAll();
      kept.forEach(([key, value]) => inst.set(key, value));
    }
  } catch { /* best effort */ }
  try { deviceInst.delete(OWNER_KEY); } catch { /* best effort */ }
};

const sweep = async (store, keys) => {
  const i = store._inst();
  if (!i || i.getBoolean(MIGRATED_KEY) === true) return;
  for (const key of keys) {
    if (i.getString(key) !== undefined) continue;
    const legacy = await AsyncStorage.getItem(key);
    if (legacy != null) i.set(key, legacy);
  }
  i.set(MIGRATED_KEY, true); // LAST: a kill before this point just re-runs the loop
};

/** Idempotent. Call once after first paint; safe to call every launch. */
export const runMigrationSweep = async () => {
  try {
    await sweep(deviceKv, DEVICE_KEYS);
    await primeCurrentUser().catch(() => null);
    if (getCurrentUserId() || persistedOwner()) await sweep(kv, ACCOUNT_KEYS);
  } catch { /* read-through still covers every key */ }
};

export default { kv, deviceKv, clearAccount, runMigrationSweep, USE_MMKV, MEDIA_RECORD_KEYS };
