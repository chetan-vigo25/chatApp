/**
 * secureTokenStore — the ONE place auth tokens are read, written and cleared.
 *
 * WHY
 * ---
 * `accessToken` / `refreshToken` / `refreshTokenHash` used to live in
 * AsyncStorage, which is a plaintext file in the app sandbox: readable by any
 * process with filesystem access (a rooted/jailbroken device, an ADB backup, a
 * forensic image). They now live in expo-secure-store — Keychain on iOS,
 * EncryptedSharedPreferences/AndroidKeyStore on Android.
 *
 * Every reader and writer in the app funnels through here. That is not just
 * tidiness: the in-memory cache below is only coherent while nothing writes
 * these keys behind its back, so a direct `AsyncStorage.setItem('accessToken')`
 * anywhere else is a bug.
 *
 * FOUR THINGS THIS FILE HAS TO GET RIGHT
 * --------------------------------------
 * 1. MIGRATION. An existing install already has tokens sitting in AsyncStorage.
 *    A read that misses SecureStore falls back to the legacy key, promotes the
 *    value, and deletes the plaintext copy. Users are never signed out by the
 *    upgrade, and the plaintext copy does not linger.
 *
 * 2. BACKGROUND READABILITY. `AFTER_FIRST_UNLOCK`, not the `WHEN_UNLOCKED`
 *    default. The FCM background handler and the CallKit/VoIP wake path both
 *    read the access token while the phone is LOCKED; under `WHEN_UNLOCKED`
 *    those reads fail and the device silently stops ringing for calls and
 *    showing message notifications.
 *
 * 3. NEVER BRICK AUTH. If SecureStore is unavailable on a device (OEM keystore
 *    bugs are real), a hard failure here would log everyone out with no way
 *    back. Writes fall back to AsyncStorage and the store reports itself
 *    unhealthy, so the app keeps working and callers that need to fail OPEN
 *    (see `hasAccessToken`) can.
 *
 * 4. SPEED. The axios request interceptor reads the access token on EVERY API
 *    call. A Keychain round-trip per request is not free, so reads are served
 *    from an in-memory cache after the first hit and concurrent reads of the
 *    same key share one in-flight promise.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

// The three secrets. `refreshToken` and `refreshTokenHash` hold the SAME value
// (see sessionManager.saveAuthSession) — the pair is kept because different
// readers historically looked for different names.
export const TOKEN_KEYS = {
  accessToken: 'accessToken',
  refreshToken: 'refreshToken',
  refreshTokenHash: 'refreshTokenHash',
};

/** Every key this module owns. freshInstallSweep imports this. */
export const SECURE_TOKEN_KEYS = Object.freeze([
  TOKEN_KEYS.accessToken,
  TOKEN_KEYS.refreshToken,
  TOKEN_KEYS.refreshTokenHash,
]);

// See note 2 above. This MUST stay AFTER_FIRST_UNLOCK.
const SECURE_OPTIONS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

// expo-secure-store only WARNS above this today ("may not be stored
// successfully") and documents that a future SDK will throw. A silent failure
// on an oversized JWT would sign the user out on next launch with no error, so
// oversized writes are read back and verified.
const VALUE_BYTES_LIMIT = 2048;

// key -> string | null. `null` is a real cached answer ("known absent"), which
// is why this is a Map with `.has()` checks rather than truthiness tests.
const _cache = new Map();
// key -> Promise<string|null>, so a boot that reads the access token from six
// call sites at once does one Keychain hit, not six.
const _inFlight = new Map();

// Flipped the first time SecureStore throws. Callers that must fail open read
// it via `isSecureStorageHealthy()`.
let _secureStoreHealthy = true;
let _warnedUnhealthy = false;

const markUnhealthy = (op, error) => {
  _secureStoreHealthy = false;
  if (_warnedUnhealthy) return;
  _warnedUnhealthy = true;
  // warn, not log: this survives the production console strip, and it is the
  // only signal that a device fell back to plaintext token storage.
  console.warn(
    `[secureTokenStore] SecureStore ${op} failed — falling back to AsyncStorage `
    + 'for auth tokens on this device. Tokens are NOT encrypted at rest here.',
    error?.message || error,
  );
};

const byteLength = (value) => {
  // No TextEncoder guarantee on Hermes; this is the same UTF-8 count
  // expo-secure-store's own byteCounter performs.
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i += 1; }
    else bytes += 3;
  }
  return bytes;
};

/**
 * Read one key: memory cache → SecureStore → legacy AsyncStorage (migrating).
 * Never throws; an unreadable key resolves to null and marks the store
 * unhealthy so fail-open callers can tell "no token" from "cannot tell".
 */
const readKey = async (key) => {
  if (_cache.has(key)) return _cache.get(key);
  if (_inFlight.has(key)) return _inFlight.get(key);

  const job = (async () => {
    let value = null;

    try {
      value = await SecureStore.getItemAsync(key, SECURE_OPTIONS);
    } catch (error) {
      markUnhealthy('read', error);
    }

    if (value == null) {
      // Either a pre-upgrade install, or a device where the write fell back.
      let legacy = null;
      try { legacy = await AsyncStorage.getItem(key); } catch { /* best-effort */ }

      if (legacy != null) {
        value = legacy;
        // Promote it, then drop the plaintext copy. If the promotion fails the
        // legacy value is LEFT IN PLACE on purpose — losing it would sign the
        // user out, which is far worse than a delayed migration.
        try {
          await SecureStore.setItemAsync(key, legacy, SECURE_OPTIONS);
          await AsyncStorage.removeItem(key).catch(() => {});
        } catch (error) {
          markUnhealthy('migrate', error);
        }
      }
    }

    _cache.set(key, value);
    return value;
  })().finally(() => { _inFlight.delete(key); });

  _inFlight.set(key, job);
  return job;
};

/**
 * Write one key to SecureStore, removing any legacy plaintext copy.
 * Falls back to AsyncStorage rather than letting the write fail — a dropped
 * token write means the user is signed out on next launch.
 */
const writeKey = async (key, rawValue) => {
  const value = String(rawValue);
  // Cache first: the value is authoritative from this moment on regardless of
  // which backend ends up holding it.
  _cache.set(key, value);

  try {
    await SecureStore.setItemAsync(key, value, SECURE_OPTIONS);

    // Oversized values are only WARNED about by expo-secure-store today, so
    // verify rather than trust. A failed read-back falls through to the
    // AsyncStorage fallback below via the throw.
    if (byteLength(value) > VALUE_BYTES_LIMIT) {
      const check = await SecureStore.getItemAsync(key, SECURE_OPTIONS);
      if (check !== value) {
        throw new Error(`value exceeds ${VALUE_BYTES_LIMIT} bytes and was not persisted`);
      }
    }

    // Only once the secure write is confirmed may the plaintext copy go.
    await AsyncStorage.removeItem(key).catch(() => {});
    return;
  } catch (error) {
    markUnhealthy('write', error);
  }

  try {
    await AsyncStorage.setItem(key, value);
  } catch (error) {
    // Both backends refused. The in-memory cache still has it, so the current
    // session survives until the process dies.
    console.warn('[secureTokenStore] token write failed in BOTH stores:', error?.message || error);
  }
};

const deleteKey = async (key) => {
  _cache.set(key, null);
  try { await SecureStore.deleteItemAsync(key, SECURE_OPTIONS); } catch { /* best-effort */ }
  try { await AsyncStorage.removeItem(key); } catch { /* best-effort */ }
};

// ─── Public API ──────────────────────────────────────────────────────────────

export const getAccessToken = () => readKey(TOKEN_KEYS.accessToken);

/** The refresh token, under either name. Mirrors getStoredSession's precedence. */
export const getRefreshToken = async () => {
  const [hash, legacy] = await Promise.all([
    readKey(TOKEN_KEYS.refreshTokenHash),
    readKey(TOKEN_KEYS.refreshToken),
  ]);
  return hash || legacy || null;
};

export const setAccessToken = (value) => (
  value ? writeKey(TOKEN_KEYS.accessToken, value) : deleteKey(TOKEN_KEYS.accessToken)
);

/**
 * Write the refresh token under BOTH names, which is what
 * sessionManager.saveAuthSession has always done — readers disagree about
 * which name to look for, and writing one alone leaves the other stale.
 */
export const setRefreshToken = async (value) => {
  if (!value) {
    await Promise.all([
      deleteKey(TOKEN_KEYS.refreshToken),
      deleteKey(TOKEN_KEYS.refreshTokenHash),
    ]);
    return;
  }
  await Promise.all([
    writeKey(TOKEN_KEYS.refreshToken, value),
    writeKey(TOKEN_KEYS.refreshTokenHash, value),
  ]);
};

/** Read every token in one pass (one Keychain hit per key, then cached). */
export const getTokens = async () => {
  const [accessToken, refreshTokenHash, refreshTokenLegacy] = await Promise.all([
    readKey(TOKEN_KEYS.accessToken),
    readKey(TOKEN_KEYS.refreshTokenHash),
    readKey(TOKEN_KEYS.refreshToken),
  ]);
  const refreshToken = refreshTokenHash || refreshTokenLegacy || null;
  return { accessToken, refreshToken, refreshTokenHash: refreshToken };
};

/**
 * Cheap "is there a session?" probe that FAILS OPEN.
 *
 * The FCM background handler gates call and message pushes on this. Returning
 * false when the answer is really "the keystore wouldn't answer" would make a
 * locked device stop ringing — so an unhealthy store reports `true` and lets
 * the push through, which is the same policy the old AsyncStorage version had
 * in its catch block.
 */
export const hasAccessToken = async () => {
  const token = await getAccessToken();
  if (token) return true;
  return !_secureStoreHealthy;
};

/**
 * Remove every token from BOTH backends.
 *
 * This is load-bearing for logout. `clearAllSessionData` wipes AsyncStorage,
 * which no longer touches SecureStore — without this call the tokens would
 * OUTLIVE the logout.
 */
export const clearTokens = async () => {
  _cache.clear();
  _inFlight.clear();
  SECURE_TOKEN_KEYS.forEach((key) => _cache.set(key, null));

  await Promise.all(
    SECURE_TOKEN_KEYS.map((key) => SecureStore.deleteItemAsync(key, SECURE_OPTIONS).catch(() => {})),
  );
  await AsyncStorage.multiRemove([...SECURE_TOKEN_KEYS]).catch(() => {});
};

/**
 * Drop the in-memory copy without touching storage. For the account-switch
 * path, where the next read must re-hydrate from disk rather than serve the
 * previous session's value.
 */
export const invalidateTokenCache = () => {
  _cache.clear();
  _inFlight.clear();
};

/** False once any SecureStore operation has failed on this device. */
export const isSecureStorageHealthy = () => _secureStoreHealthy;

export default {
  TOKEN_KEYS,
  SECURE_TOKEN_KEYS,
  getAccessToken,
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
  getTokens,
  hasAccessToken,
  clearTokens,
  invalidateTokenCache,
  isSecureStorageHealthy,
};
