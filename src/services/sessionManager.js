import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import { BACKEND_URL } from '@env';
import store from '../Redux/Store';
import { resetAppState } from '../Redux/RootReducers';
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

export const getStoredSession = async () => {
  const [accessToken, refreshTokenHash, refreshTokenLegacy, userRaw, deviceId, sessionId] = await Promise.all([
    AsyncStorage.getItem(AUTH_KEYS.accessToken),
    AsyncStorage.getItem(AUTH_KEYS.refreshTokenHash),
    AsyncStorage.getItem(AUTH_KEYS.refreshToken),
    AsyncStorage.getItem(AUTH_KEYS.userInfo),
    AsyncStorage.getItem(AUTH_KEYS.deviceId),
    AsyncStorage.getItem(AUTH_KEYS.sessionId),
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
  };
};

export const isTokenExpired = (token, skewSeconds = 30) => {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return payload.exp <= nowSec + skewSeconds;
};

export const saveAuthSession = async ({ userInfo, accessToken, refreshToken, refreshTokenHash, deviceId, sessionId }) => {
  const writes = [];
  const resolvedRefreshToken = refreshTokenHash || refreshToken;

  if (userInfo) {
    writes.push(AsyncStorage.setItem(AUTH_KEYS.userInfo, JSON.stringify(userInfo)));
    emitUserChanged({ userId: String(userInfo?._id || userInfo?.id || '') || null, userInfo });
  }

  if (accessToken) writes.push(AsyncStorage.setItem(AUTH_KEYS.accessToken, String(accessToken)));
  if (resolvedRefreshToken) {
    writes.push(AsyncStorage.setItem(AUTH_KEYS.refreshToken, String(resolvedRefreshToken)));
    writes.push(AsyncStorage.setItem(AUTH_KEYS.refreshTokenHash, String(resolvedRefreshToken)));
  }
  if (deviceId) writes.push(AsyncStorage.setItem(AUTH_KEYS.deviceId, String(deviceId)));
  if (sessionId) writes.push(AsyncStorage.setItem(AUTH_KEYS.sessionId, String(sessionId)));
  
  await Promise.all(writes);
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
  store.dispatch(resetAppState());
  emitSessionReset({ reason: 'runtime_reset' });
};

export const performSessionReset = async ({
  reason = 'logout',
  resetNavigation = true,
  clearAllStorage = true,
} = {}) => {
  await clearAllSessionData({ clearAllStorage });

  // Clear SQLite database (messages, chats, sync_meta)
  try {
    await ChatDatabase.clearSyncData();
    await ChatDatabase.closeDB();
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
    }
  }

  throw lastError || new Error('Unable to refresh token');
};

export const refreshAccessToken = async ({ force = false } = {}) => {
  if (!force && refreshPromise) {
    return refreshPromise;
  }

  const session = await getStoredSession();
  if (!session.refreshToken || !session.deviceId) {
    throw new Error('Missing refresh token or device ID');
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
    emitUserChanged({ userId: session.userId, userInfo: session.userInfo, reason: 'bootstrap' });
    return { authenticated: true, refreshed: false, session };
  }

  if (!session.refreshToken) {
    return { authenticated: false, refreshed: false, session };
  }

  try {
    const refreshed = await refreshAccessToken({ force: true });
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