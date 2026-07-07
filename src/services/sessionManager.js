import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import { BACKEND_URL } from '@env';
import { resetToLogin } from '../Redux/Services/navigationService';
import { emitSessionReset, emitUserChanged } from './sessionEvents';
import ChatDatabase from './ChatDatabase';

export const AUTH_KEYS = {
  accessToken: 'accessToken',
  refreshTokenHash: 'refreshTokenHash',
  refreshToken: 'refreshToken',
  userInfo: 'userInfo',
  deviceId: 'deviceId',
  sessionId: 'sessionId',
  // How the current user signed in: 'mobile' (OTP) or 'username' (password).
  loginMethod: 'loginMethod',
};

const REFRESH_ENDPOINTS = [
  'user/auth/refresh-token',
  'user/auth/refresh',
  'auth/refresh-token',
  'auth/refresh',
];

let refreshPromise = null;

const buildUrl = (endpoint) => {
  if (!endpoint) return null;
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  if (!BACKEND_URL || !BACKEND_URL.trim()) return null;
  return `${BACKEND_URL.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}`;
};

const parseJSONSafely = (raw, fallback = null) => {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const decodeJwtPayload = (token) => {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const normalized = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`;
    if (typeof global?.atob === 'function') {
      return JSON.parse(global.atob(normalized));
    }

    if (typeof Buffer !== 'undefined') {
      return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
    }

    return null;
  } catch {
    return null;
  }
};

const clearMmkvIfAvailable = async () => {
  try {
    const mmkvModule = require('react-native-mmkv');
    if (mmkvModule?.MMKV) {
      const storage = new mmkvModule.MMKV();
      storage.clearAll();
    }
  } catch {
    // Optional dependency, ignore if not installed.
  }
};

const clearPersistStorage = async () => {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const persistKeys = allKeys.filter((key) => key.startsWith('persist:'));
    if (persistKeys.length > 0) {
      await AsyncStorage.multiRemove(persistKeys);
    }
  } catch (error) {
    console.warn('Unable to clear redux persist storage', error);
  }
};

const extractTokens = (responseData = {}) => {
  const tokenRoot = responseData?.token || responseData?.data?.token || {};

  const accessToken =
    responseData?.accessToken ||
    responseData?.data?.accessToken ||
    tokenRoot?.accessToken ||
    null;

  const refreshToken =
    responseData?.refreshToken ||
    responseData?.data?.refreshToken ||
    tokenRoot?.refreshToken ||
    responseData?.refreshTokenHash ||
    responseData?.data?.refreshTokenHash ||
    tokenRoot?.refreshTokenHash ||
    null;

  return {
    accessToken: accessToken ? String(accessToken) : null,
    refreshToken: refreshToken ? String(refreshToken) : null,
  };
};

// Pull the backend-issued deviceId out of a login / OTP-verify response.
// The device id is created server-side (the app never sends one at login), so
// it can only ever be a value the backend actually returned — we probe every
// shape the backend might use but NEVER fabricate one, because refresh must
// send back the SAME id the server associated with this session (a made-up id
// would just be rejected). Returns null only when the response truly carries no
// device id — which is a backend contract problem, not something the app can fix.
const extractDeviceId = (responseData = {}) => {
  const d = responseData?.data || {};
  const device = d?.device || responseData?.device || {};
  const candidate =
    d?.deviceId ||
    device?.deviceId ||
    device?._id ||
    device?.id ||
    d?.deviceInfo?.deviceId ||
    d?.session?.deviceId ||
    responseData?.deviceId ||
    responseData?.token?.deviceId ||
    null;
  return candidate ? String(candidate) : null;
};

// Single robust entry point for login screens: resolves accessToken,
// refreshToken and deviceId from a login response regardless of nesting.
export const extractLoginSession = (responseData = {}) => {
  const tokens = extractTokens(responseData);
  const deviceId = extractDeviceId(responseData);
  if (!tokens.refreshToken || !deviceId) {
    // Loud, actionable signal: if either is missing at login, token refresh is
    // GUARANTEED to fail later (sessionManager throws before hitting the server)
    // and the user will be auto-logged-out on the first access-token expiry.
    console.warn(
      '[auth] login response missing session field(s) — refresh will fail → auto-logout.',
      { hasRefreshToken: !!tokens.refreshToken, hasDeviceId: !!deviceId }
    );
  }
  return { ...tokens, deviceId };
};

export const getStoredSession = async () => {
  const [accessToken, refreshTokenHash, refreshTokenLegacy, userRaw, deviceId, sessionId, loginMethod] = await Promise.all([
    AsyncStorage.getItem(AUTH_KEYS.accessToken),
    AsyncStorage.getItem(AUTH_KEYS.refreshTokenHash),
    AsyncStorage.getItem(AUTH_KEYS.refreshToken),
    AsyncStorage.getItem(AUTH_KEYS.userInfo),
    AsyncStorage.getItem(AUTH_KEYS.deviceId),
    AsyncStorage.getItem(AUTH_KEYS.sessionId),
    AsyncStorage.getItem(AUTH_KEYS.loginMethod),
  ]);

  const userInfo = parseJSONSafely(userRaw, null);
  const userId = userInfo?._id || userInfo?.id || null;

  return {
    accessToken,
    refreshToken: refreshTokenHash || refreshTokenLegacy,
    refreshTokenHash: refreshTokenHash || refreshTokenLegacy,
    userInfo,
    userId: userId ? String(userId) : null,
    deviceId,
    sessionId,
    loginMethod,
  };
};

export const isTokenExpired = (token, skewSeconds = 30) => {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return payload.exp <= nowSec + skewSeconds;
};

export const saveAuthSession = async ({ userInfo, accessToken, refreshToken, refreshTokenHash, deviceId, sessionId, loginMethod }) => {
  const writes = [];
  const resolvedRefreshToken = refreshTokenHash || refreshToken;

  if (userInfo) writes.push(AsyncStorage.setItem(AUTH_KEYS.userInfo, JSON.stringify(userInfo)));
  if (accessToken) writes.push(AsyncStorage.setItem(AUTH_KEYS.accessToken, String(accessToken)));
  if (resolvedRefreshToken) {
    writes.push(AsyncStorage.setItem(AUTH_KEYS.refreshToken, String(resolvedRefreshToken)));
    writes.push(AsyncStorage.setItem(AUTH_KEYS.refreshTokenHash, String(resolvedRefreshToken)));
  }
  if (deviceId) writes.push(AsyncStorage.setItem(AUTH_KEYS.deviceId, String(deviceId)));
  if (sessionId) writes.push(AsyncStorage.setItem(AUTH_KEYS.sessionId, String(sessionId)));
  if (loginMethod) writes.push(AsyncStorage.setItem(AUTH_KEYS.loginMethod, String(loginMethod)));

  // Persist EVERYTHING (token included) BEFORE announcing the user change.
  // Listeners that react to user-changed often fire authenticated requests, and
  // emitting first would let them race ahead of the token write → the request
  // goes out tokenless and the server replies 401 "No token provided".
  await Promise.all(writes);

  const resolvedUserId = String(userInfo?._id || userInfo?.id || '') || null;

  // Tag the local cache with its owner so a later session reset can tell a
  // same-account re-login (keep cache) from a different user (wipe). Fire-and-
  // forget + best-effort: a DB hiccup must never break login. Runs AFTER any
  // performSessionReset (login does reset→save), so it stamps the NEW owner.
  if (resolvedUserId) {
    try {
      const { Platform } = require('react-native');
      if (Platform.OS !== 'web') { ChatDatabase.setDBOwner(resolvedUserId); }
    } catch {}
  }

  if (userInfo) {
    emitUserChanged({ userId: resolvedUserId, userInfo });
  }
};

// Stamp the local-cache owner on an authenticated app relaunch. Backfills the
// tag for installs that logged in before it existed, so the FIRST different
// user to take over the device afterwards is correctly wiped.
const stampCacheOwnerForBootstrap = (userId) => {
  if (!userId) return;
  try {
    const { Platform } = require('react-native');
    if (Platform.OS !== 'web') { ChatDatabase.setDBOwner(String(userId)); }
  } catch {}
};

export const clearAllSessionData = async ({ clearAllStorage = true } = {}) => {
  if (clearAllStorage) {
    await AsyncStorage.clear();
  } else {
    await AsyncStorage.multiRemove(Object.values(AUTH_KEYS));

    const keys = await AsyncStorage.getAllKeys();
    const chatKeys = keys.filter((key) =>
      key.startsWith('chat_messages_') ||
      key.startsWith('chat_deleted_tombstones_') ||
      key.startsWith('media_status_update_queue_') ||
      key.startsWith('presence_manual_queue')
    );

    if (chatKeys.length > 0) {
      await AsyncStorage.multiRemove(chatKeys);
    }
  }

  await clearPersistStorage();
  await clearMmkvIfAvailable();
};

export const resetRuntimeState = () => {
  // Lazy require to break the static require cycle:
  //   sessionManager → Store → RootReducers → Auth.reducer → Auth.Services
  //   → Https → sessionManager
  // By the time this runs (a logout/session reset), all modules are fully
  // initialized, so the require returns the ready store + action.
  const store = require('../Redux/Store').default;
  const { resetAppState } = require('../Redux/RootReducers');
  store.dispatch(resetAppState());
  emitSessionReset({ reason: 'runtime_reset' });
};

// Reasons that ALWAYS destroy the local SQLite cache regardless of who owns it.
// Account deletion/removal means the data must not survive — everything else
// (ordinary logout, token-refresh failure, account temporarily inactive) keeps
// the cache so a same-account return is instant and local-first.
const REASONS_THAT_WIPE = new Set(['account_deleted']);

export const performSessionReset = async ({
  reason = 'logout',
  resetNavigation = true,
  clearAllStorage = true,
  // userId about to sign in (login flows pass this); null on a pure logout.
  nextUserId = null,
  // Force-destroy the local cache no matter the owner (account deletion).
  wipeLocalDB = false,
} = {}) => {
  // ── Decide the fate of the local SQLite cache BEFORE clearing AsyncStorage ──
  // We must read the previous owner while it's still available. A same-account
  // re-login keeps the cache (no full server refetch); a different user — or an
  // explicit account deletion — wipes it so messages never leak across accounts.
  let shouldWipeLocalDB = wipeLocalDB || REASONS_THAT_WIPE.has(reason);
  let isWeb = false;
  try {
    isWeb = require('react-native').Platform.OS === 'web';
  } catch {}

  if (!shouldWipeLocalDB && !isWeb && nextUserId) {
    try {
      // Who the cache currently belongs to: the durable owner tag, falling back
      // to the still-present stored session (covers installs predating the tag).
      const owner = await ChatDatabase.getDBOwner();
      const prevStoredUserId = owner ? null : ((await getStoredSession())?.userId || null);
      const known = owner || prevStoredUserId;
      // Wipe ONLY when we can prove the cache belongs to a different user. If we
      // can't tell (no owner, no prior session — e.g. a previous logout already
      // cleared storage), preserve it: the owner tag is re-stamped on every login
      // so the next switch is protected.
      shouldWipeLocalDB = Boolean(known) && String(known) !== String(nextUserId);
    } catch {}
  }

  await clearAllSessionData({ clearAllStorage });

  // Apply the SQLite decision — skip on web (no SQLite there)
  try {
    if (!isWeb) {
      if (shouldWipeLocalDB) {
        await ChatDatabase.clearSyncData();
      }
      await ChatDatabase.closeDB();
    }
  } catch {}

  resetRuntimeState();

  if (resetNavigation) {
    resetToLogin();
  }

  emitUserChanged({ userId: null, userInfo: null, reason });
};

const tryRefreshEndpoint = async ({ endpoint, refreshToken, deviceId }) => {
  const url = buildUrl(endpoint);
  if (!url) throw new Error('BACKEND_URL is not configured');

  const response = await axios.post(
    url,
    { refreshToken, refreshTokenHash: refreshToken, deviceId },
    {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${refreshToken}`,
      },
    }
  );

  return response?.data;
};

const refreshAccessTokenInternal = async ({ refreshToken, deviceId }) => {
  let lastError = null;
  let sawAuthRejection = false;

  for (const endpoint of REFRESH_ENDPOINTS) {
    try {
      const payload = await tryRefreshEndpoint({ endpoint, refreshToken, deviceId });
      const tokens = extractTokens(payload);

      if (tokens.accessToken) {
        await AsyncStorage.setItem(AUTH_KEYS.accessToken, tokens.accessToken);
        if (tokens.refreshToken) {
          await AsyncStorage.setItem(AUTH_KEYS.refreshToken, tokens.refreshToken);
          await AsyncStorage.setItem(AUTH_KEYS.refreshTokenHash, tokens.refreshToken);
        }

        return {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken || refreshToken,
          raw: payload,
        };
      }
    } catch (error) {
      lastError = error;
      // A 401/403 from the refresh endpoint means the server EXPLICITLY rejected
      // the refresh token → the session is genuinely dead. Anything else
      // (no response / timeout / 5xx / a 404 wrong-path) is transient or a
      // config blip and must NOT be treated as a real expiry — otherwise a flaky
      // connection would log the user out on the very next request.
      const status = error?.response?.status;
      if (status === 401 || status === 403) {
        sawAuthRejection = true;
      }
    }
  }

  const err = lastError || new Error('Unable to refresh token');
  err.isAuthRejection = sawAuthRejection;
  err.isTransient = !sawAuthRejection;
  throw err;
};

export const refreshAccessToken = async ({ force = false } = {}) => {
  if (!force && refreshPromise) {
    return refreshPromise;
  }

  const session = await getStoredSession();
  if (!session.refreshToken || !session.deviceId) {
    // No credentials to refresh with → this can never recover on its own, so it
    // IS a genuine end-of-session (unlike a transient network failure). Tag it
    // so the caller cleanly signs the user out instead of looping on errors.
    const err = new Error('Missing refresh token or device ID');
    err.isAuthRejection = true;
    throw err;
  }

  refreshPromise = refreshAccessTokenInternal({
    refreshToken: session.refreshToken,
    deviceId: session.deviceId,
  })
    .finally(() => {
      refreshPromise = null;
    });

  return refreshPromise;
};

export const bootstrapSession = async () => {
  const session = await getStoredSession();

  if (!session.userInfo || !session.deviceId) {
    return { authenticated: false, refreshed: false, session };
  }

  if (!session.accessToken && !session.refreshToken) {
    return { authenticated: false, refreshed: false, session };
  }

  if (session.accessToken && !isTokenExpired(session.accessToken)) {
    stampCacheOwnerForBootstrap(session.userId);
    emitUserChanged({ userId: session.userId, userInfo: session.userInfo, reason: 'bootstrap' });
    return { authenticated: true, refreshed: false, session };
  }

  if (!session.refreshToken) {
    return { authenticated: false, refreshed: false, session };
  }

  try {
    const refreshed = await refreshAccessToken({ force: true });
    stampCacheOwnerForBootstrap(session.userId);
    emitUserChanged({ userId: session.userId, userInfo: session.userInfo, reason: 'bootstrap_refresh' });
    return {
      authenticated: true,
      refreshed: true,
      session: {
        ...session,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
      },
    };
  } catch (error) {
    return { authenticated: false, refreshed: false, session, error };
  }
};

export default {
  getStoredSession,
  isTokenExpired,
  saveAuthSession,
  clearAllSessionData,
  resetRuntimeState,
  performSessionReset,
  refreshAccessToken,
  bootstrapSession,
};