import { io } from 'socket.io-client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SOCKET_URL } from '@env';
import { AppState } from 'react-native';
import { performSessionReset, saveAuthSession } from '../../../services/sessionManager';

const STORAGE_KEYS = {
  ACCESS_TOKEN: 'accessToken',
  REFRESH_TOKEN_HASH: 'refreshTokenHash',
  REFRESH_TOKEN_LEGACY: 'refreshToken',
  DEVICE_ID: 'deviceId',
  SESSION_ID: 'sessionId',
};

const TOKEN_ERROR_REGEX = /(token expired|invalid token|jwt expired|authentication failed|unauthorized|not authorized|invalid credentials)/i;
const REAUTH_TIMEOUT_MS = 15000;
const REAUTH_CONNECT_TIMEOUT_MS = 8000;
const REAUTH_MAX_ATTEMPTS = 3;
const REAUTH_RETRY_BASE_DELAY_MS = 800;

let socket = null;
let sessionId = '';
let deviceId = '';
let accessTokenCache = '';
let appState = AppState.currentState;
let socketListenersBound = false;
let reauthPromise = null;
let isReauthenticating = false;
let currentNavigation = null;
let currentDeviceInfo = null;

const socketStateSubscribers = new Set();
const pendingEmitQueue = [];
const MAX_PENDING_EMIT = 200;

const socketState = {
  status: 'idle',
  connected: false,
  reconnectAttempts: 0,
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  lastError: null,
};

const notifySocketStateSubscribers = () => {
  const snapshot = { ...socketState };
  socketStateSubscribers.forEach((callback) => {
    try {
      callback(snapshot);
    } catch (error) {
      console.warn('socket state subscriber callback error', error);
    }
  });
};

const updateSocketState = (partial = {}) => {
  Object.assign(socketState, partial);
  notifySocketStateSubscribers();
};

const getDeviceInfoPayload = (deviceData) => ({
  platform: deviceData?.osName || 'unknown',
  version: deviceData?.appVersion || '1.0.0',
  model: deviceData?.brand || 'unknown',
});

const flushPendingEmitQueue = () => {
  if (!socket || !socket.connected || reauthPromise || pendingEmitQueue.length === 0) return;

  while (pendingEmitQueue.length > 0) {
    const queued = pendingEmitQueue.shift();
    if (!queued?.event) continue;
    socket.emit(queued.event, queued.payload, queued.ack);
  }
};

const isTokenErrorPayload = (payload = {}) => {
  const message = String(payload?.message || payload?.error || payload?.reason || '');
  return TOKEN_ERROR_REGEX.test(message);
};

const isAuthConnectError = (error) => {
  const message = String(error?.message || error?.description || error || '');
  return TOKEN_ERROR_REGEX.test(message);
};

const isTemporaryReauthError = (error) => {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('network') ||
    message.includes('connect') ||
    message.includes('disconnected') ||
    message.includes('transport') ||
    message.includes('temporary')
  );
};

const createAuthRejectedError = (message = 'Reauthentication rejected by server') => {
  const error = new Error(message);
  error.code = 'REAUTH_REJECTED';
  error.isAuthRejected = true;
  return error;
};

const getAuthStorage = async () => {
  try {
    const values = await AsyncStorage.multiGet([
      STORAGE_KEYS.ACCESS_TOKEN,
      STORAGE_KEYS.REFRESH_TOKEN_HASH,
      STORAGE_KEYS.REFRESH_TOKEN_LEGACY,
      STORAGE_KEYS.DEVICE_ID,
      STORAGE_KEYS.SESSION_ID,
    ]);

    const map = Object.fromEntries(values);
    return {
      accessToken: map[STORAGE_KEYS.ACCESS_TOKEN] || null,
      refreshTokenHash:
        map[STORAGE_KEYS.REFRESH_TOKEN_HASH] || map[STORAGE_KEYS.REFRESH_TOKEN_LEGACY] || null,
      deviceId: map[STORAGE_KEYS.DEVICE_ID] || null,
      sessionId: map[STORAGE_KEYS.SESSION_ID] || null,
    };
  } catch (error) {
    console.error('❌ Error reading auth storage:', error);
    return { accessToken: null, refreshTokenHash: null, deviceId: null, sessionId: null };
  }
};

const persistAuthStorage = async ({ accessToken, refreshTokenHash, deviceId, sessionId }) => {
  const writes = [];

  if (accessToken || refreshTokenHash || deviceId) {
    await saveAuthSession({
      accessToken,
      refreshToken: refreshTokenHash,
      deviceId,
    });
  }

  if (refreshTokenHash) {
    writes.push([STORAGE_KEYS.REFRESH_TOKEN_HASH, String(refreshTokenHash)]);
    writes.push([STORAGE_KEYS.REFRESH_TOKEN_LEGACY, String(refreshTokenHash)]);
  }

  if (sessionId) {
    writes.push([STORAGE_KEYS.SESSION_ID, String(sessionId)]);
  }

  if (writes.length > 0) {
    await AsyncStorage.multiSet(writes);
  }

  console.log('🗄️ token storage update', {
    hasAccessToken: !!accessToken,
    hasRefreshTokenHash: !!refreshTokenHash,
    hasDeviceId: !!deviceId,
    hasSessionId: !!sessionId,
  });
};

const safeDisconnectSocket = () => {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  socketListenersBound = false;
};

const handleLogout = async (navigation = currentNavigation) => {
  try {
    console.warn('🚪 Logging out due to authentication/session failure');
    safeDisconnectSocket();
    updateSocketState({
      status: 'logged_out',
      connected: false,
      lastDisconnectedAt: Date.now(),
    });

    sessionId = '';
    deviceId = '';
    accessTokenCache = '';
    pendingEmitQueue.length = 0;

    await performSessionReset({
      reason: 'socket_logout',
      resetNavigation: false,
      clearAllStorage: true,
    });

    if (navigation) {
      navigation.reset({
        index: 0,
        routes: [{ name: 'Login' }],
      });
    }
  } catch (error) {
    console.error('❌ Error during logout:', error);
  }
};

const emitDeviceEvents = () => {
  if (!socket || !socket.connected) return;
  socket.emit('device:sessions', {}, (response) => {
    if (response) {
      console.log('📱 device:sessions response', {
        status: response?.status,
        message: response?.message,
      });
    }
  });
};

const reconnectSocketWithFreshToken = async ({ accessToken, deviceId }) => {
  if (!socket) return;

  socket.auth = {
    ...(socket.auth || {}),
    token: accessToken,
    deviceId,
    deviceInfo: getDeviceInfoPayload(currentDeviceInfo),
  };

  updateSocketState({ status: 'reconnecting_after_refresh', connected: false });
  console.log('🔁 socket reconnect triggered', {
    hasAccessToken: !!accessToken,
    hasDeviceId: !!deviceId,
  });

  await new Promise((resolve) => {
    let settled = false;

    const finalize = () => {
      if (settled) return;
      settled = true;
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
      resolve();
    };

    const onConnect = () => {
      console.log('✅ socket reconnect after refresh success');
      socket.emit('user:sync');
      finalize();
    };

    const onError = (error) => {
      console.error('❌ socket reconnect after refresh failed:', error?.message || error);
      finalize();
    };

    socket.once('connect', onConnect);
    socket.once('connect_error', onError);

    if (socket.connected) {
      socket.disconnect();
    }

    socket.connect();
    setTimeout(finalize, 10000);
  });
};

const completeReauthentication = async (response) => {
  if (!response?.status) {
    throw new Error(response?.message || 'Reauthentication failed');
  }

  const nextAccessToken = response?.data?.accessToken;
  const nextRefreshTokenHash = response?.data?.refreshTokenHash;
  const nextSessionId = response?.data?.sessionId || sessionId;
  const nextDeviceId = response?.data?.deviceId || deviceId;

  if (!nextAccessToken || !nextRefreshTokenHash || !nextDeviceId) {
    throw new Error('Reauthentication response missing required auth fields');
  }

  sessionId = String(nextSessionId || '');
  deviceId = String(nextDeviceId || '');
  accessTokenCache = String(nextAccessToken);

  await persistAuthStorage({
    accessToken: nextAccessToken,
    refreshTokenHash: nextRefreshTokenHash,
    deviceId: nextDeviceId,
    sessionId: nextSessionId,
  });

  console.log('✅ reauthenticated success', {
    userId: response?.data?.userId,
    sessionId,
    deviceId,
  });

  await reconnectSocketWithFreshToken({
    accessToken: nextAccessToken,
    deviceId: nextDeviceId,
  });
};

const requestSocketReauthentication = async (reason = 'unknown', navigation = currentNavigation) => {
  if (reauthPromise) {
    console.log('⏳ reauthentication already in progress, waiting for active request');
    return reauthPromise;
  }

  isReauthenticating = true;
  reauthPromise = (async () => {
    updateSocketState({ status: 'reauthenticating', connected: !!socket?.connected });

    const auth = await getAuthStorage();
    if (!auth?.refreshTokenHash || !auth?.deviceId) {
      console.error('❌ Missing refreshTokenHash/deviceId for socket reauth');
      await handleLogout(navigation);
      throw new Error('Missing refresh credentials');
    }

    const reauthPayload = {
      refreshTokenHash: String(auth.refreshTokenHash),
      deviceId: String(auth.deviceId),
    };

    const socketRef = socket;
    if (!socketRef) {
      await handleLogout(navigation);
      throw new Error('Socket not initialized for reauthentication');
    }

    let lastError = null;

    for (let attempt = 1; attempt <= REAUTH_MAX_ATTEMPTS; attempt += 1) {
      try {
        await new Promise((resolve, reject) => {
          let settled = false;
          let timeoutHandle = null;
          let connectTimeoutHandle = null;

          const cleanup = () => {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
              timeoutHandle = null;
            }
            if (connectTimeoutHandle) {
              clearTimeout(connectTimeoutHandle);
              connectTimeoutHandle = null;
            }
            socketRef.off('reauthenticated', onReauthenticated);
            socketRef.off('connect', onConnect);
            socketRef.off('connect_error', onConnectError);
          };

          const finalize = (error = null) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve();
          };

          const onReauthenticated = (response) => {
            console.log('📥 reauthenticated response received', {
              status: response?.status,
              message: response?.message,
              attempt,
            });

            if (response?.status !== true) {
              finalize(createAuthRejectedError(response?.message || 'Reauthentication rejected by server'));
              return;
            }

            completeReauthentication(response)
              .then(() => finalize())
              .catch((err) => finalize(err));
          };

          const onConnectError = (error) => {
            finalize(new Error(error?.message || 'Socket connect_error during reauthentication'));
          };

          const emitReauth = () => {
            console.log('📤 reauthenticate request sent', {
              reason,
              attempt,
              deviceId: reauthPayload.deviceId,
              hasRefreshTokenHash: !!reauthPayload.refreshTokenHash,
            });
            socketRef.emit('reauthenticate', reauthPayload);
          };

          const onConnect = () => {
            if (connectTimeoutHandle) {
              clearTimeout(connectTimeoutHandle);
              connectTimeoutHandle = null;
            }
            emitReauth();
          };

          // Use .once() to avoid listener leaks across retry attempts.
          socketRef.once('reauthenticated', onReauthenticated);
          socketRef.once('connect_error', onConnectError);

          timeoutHandle = setTimeout(() => {
            console.error('⏱️ reauthentication timeout occurred', {
              timeoutMs: REAUTH_TIMEOUT_MS,
              attempt,
              socketConnected: socketRef.connected,
            });
            finalize(new Error('reauthentication timeout'));
          }, REAUTH_TIMEOUT_MS);

          if (socketRef.connected) {
            emitReauth();
            return;
          }

          // Separate timeout for the connection phase
          connectTimeoutHandle = setTimeout(() => {
            console.error('⏱️ reauthentication connect timeout', {
              timeoutMs: REAUTH_CONNECT_TIMEOUT_MS,
              attempt,
            });
            finalize(new Error('reauthentication timeout'));
          }, REAUTH_CONNECT_TIMEOUT_MS);

          socketRef.once('connect', onConnect);
          socketRef.connect();
        });

        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const maybeTemporary = isTemporaryReauthError(error);
        const canRetry = maybeTemporary && attempt < REAUTH_MAX_ATTEMPTS;

        console.warn('⚠️ socket reauthentication attempt failed', {
          reason,
          attempt,
          canRetry,
          message: error?.message || String(error),
        });

        if (!canRetry) {
          throw error;
        }

        const retryDelay = REAUTH_RETRY_BASE_DELAY_MS * attempt;
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }

    if (lastError) {
      throw lastError;
    }

    updateSocketState({
      status: socket?.connected ? 'connected' : 'disconnected',
      connected: !!socket?.connected,
      lastError: null,
    });
    flushPendingEmitQueue();
  })()
    .catch(async (error) => {
      console.error('❌ socket reauthentication failed:', error?.message || error);
      console.log('❌ reauthenticated failure');

      if (error?.isAuthRejected || error?.code === 'REAUTH_REJECTED' || error?.message === 'Missing refresh credentials') {
        await handleLogout(navigation);
      } else {
        updateSocketState({
          status: 'reauth_temporary_failure',
          connected: !!socket?.connected,
          lastError: error?.message || 'reauth_temporary_failure',
        });
      }

      throw error;
    })
    .finally(() => {
      reauthPromise = null;
      isReauthenticating = false;
    });

  return reauthPromise;
};

const attachCoreSocketListeners = (navigation) => {
  if (!socket || socketListenersBound) return;
  socketListenersBound = true;

  socket.on('connect', () => {
    console.log('✅ socket connected', { socketId: socket?.id });
    updateSocketState({
      status: 'connected',
      connected: true,
      reconnectAttempts: 0,
      lastConnectedAt: Date.now(),
      lastError: null,
    });

    const authToken = accessTokenCache;
    socket.emit('authenticate', {
      token: authToken,
      deviceId,
      deviceInfo: getDeviceInfoPayload(currentDeviceInfo),
    });

    if (authToken) {
      socket.emit('token:validate', { token: authToken });
    }

    if (!reauthPromise) {
      emitDeviceEvents();
      flushPendingEmitQueue();
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('🔌 socket disconnected', { reason });
    updateSocketState({
      status: 'disconnected',
      connected: false,
      lastDisconnectedAt: Date.now(),
    });

    if (reason === 'io server disconnect') {
      requestSocketReauthentication('server_disconnect', navigation).catch(() => {});
    }
  });

  socket.on('connect_error', (error) => {
    console.error('❌ socket connect_error:', error?.message || error);
    updateSocketState({
      status: 'connect_error',
      connected: false,
      lastError: error?.message || 'connect_error',
    });

    if (isAuthConnectError(error)) {
      requestSocketReauthentication('connect_error_auth', navigation).catch(() => {});
    }
  });

  socket.on('reconnect_attempt', (attemptNumber) => {
    updateSocketState({ status: 'reconnecting', connected: false, reconnectAttempts: attemptNumber || 0 });
  });

  socket.on('reconnect', (attemptNumber) => {
    updateSocketState({
      status: 'connected',
      connected: true,
      reconnectAttempts: attemptNumber || 0,
      lastConnectedAt: Date.now(),
      lastError: null,
    });
    flushPendingEmitQueue();
  });

  socket.on('reconnect_failed', () => {
    updateSocketState({ status: 'reconnect_failed', connected: false });
  });

  socket.on('authenticated', (response) => {
    if (response?.status === true) {
      sessionId = String(response?.data?.sessionId || sessionId || '');
      if (sessionId) {
        AsyncStorage.setItem(STORAGE_KEYS.SESSION_ID, sessionId).catch(() => {});
      }
      emitDeviceEvents();
      return;
    }

    if (isTokenErrorPayload(response)) {
      requestSocketReauthentication('authenticated_failed_token', navigation).catch(() => {});
    }
  });

  socket.on('token:validation:result', (response) => {
    if (response?.status === false && isTokenErrorPayload(response)) {
      requestSocketReauthentication('token_validation_result', navigation).catch(() => {});
    }
  });

  const tokenFailureEvents = [
    'token:invalid',
    'token:expired',
    'auth:token:invalid',
    'auth:token:expired',
  ];

  tokenFailureEvents.forEach((eventName) => {
    socket.on(eventName, () => {
      requestSocketReauthentication(eventName, navigation).catch(() => {});
    });
  });

  socket.on('reauthenticated', async (response) => {
    if (isReauthenticating) {
      return;
    }

    if (response?.status === true) {
      console.log('ℹ️ unsolicited reauthenticated response received');
      return;
    }

    if (response?.status === false) {
      console.log('❌ reauthenticated failure', { message: response?.message });
      await handleLogout(navigation);
    }
  });

  socket.on('device:terminated', (response) => {
    if (response?.status === true || response?.message) {
      handleLogout(navigation);
    }
  });

  socket.on('logout', () => {
    handleLogout(navigation);
  });
};

export const getSocketStateSnapshot = () => ({ ...socketState });

export const subscribeSocketState = (callback) => {
  if (typeof callback !== 'function') return () => {};
  socketStateSubscribers.add(callback);
  callback({ ...socketState });
  return () => socketStateSubscribers.delete(callback);
};

export const emitSocketEvent = (event, payload = {}, ack = undefined, { queueIfOffline = true } = {}) => {
  if (socket && socket.connected && !reauthPromise) {
    socket.emit(event, payload, ack);
    return true;
  }

  if (queueIfOffline) {
    if (pendingEmitQueue.length >= MAX_PENDING_EMIT) {
      pendingEmitQueue.shift();
    }
    pendingEmitQueue.push({ event, payload, ack });
  }

  return false;
};

export const initSocket = async (deviceInfo, navigation) => {
  try {
    currentNavigation = navigation || currentNavigation;
    currentDeviceInfo = deviceInfo || currentDeviceInfo;

    const auth = await getAuthStorage();

    if (!auth?.accessToken || !auth?.deviceId) {
      await handleLogout(navigation);
      return null;
    }

    accessTokenCache = String(auth.accessToken);
    deviceId = String(auth.deviceId);
    sessionId = String(auth.sessionId || sessionId || '');

    const authPayload = {
      token: accessTokenCache,
      deviceId,
      deviceInfo: getDeviceInfoPayload(currentDeviceInfo),
    };

    if (socket) {
      socket.auth = authPayload;
      attachCoreSocketListeners(navigation);
      if (!socket.connected) {
        updateSocketState({ status: 'reconnecting', connected: false });
        socket.connect();
      }
      return socket;
    }

    updateSocketState({ status: 'connecting', connected: false, lastError: null });
    socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      auth: authPayload,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 7000,
      timeout: 12000,
      autoConnect: true,
    });

    attachCoreSocketListeners(navigation);
    return socket;
  } catch (error) {
    console.error('❌ initSocket error:', error);
    return null;
  }
};

export const setupAppStateListener = (navigation) => {
  const handleAppStateChange = async (nextAppState) => {
    if (appState.match(/inactive|background/) && nextAppState === 'active') {
      if (!socket || !socket.connected) {
        await reconnectSocket(navigation);
      } else if (accessTokenCache) {
        socket.emit('token:validate', { token: accessTokenCache });
      }
    }
    appState = nextAppState;
  };

  const subscription = AppState.addEventListener('change', handleAppStateChange);
  return () => subscription.remove();
};

export const emitLogoutCurrentDevice = async () => {
  try {
    const auth = await getAuthStorage();
    const payload = {
      deviceId: String(auth?.deviceId || deviceId || ''),
      logoutAll: false,
    };

    if (socket && socket.connected) {
      socket.emit('logout', payload);
      console.log('📤 Emitted logout event:', payload);
    }

    return payload;
  } catch (error) {
    console.error('❌ emitLogoutCurrentDevice error:', error);
    return { deviceId: '', logoutAll: false };
  }
};

export const clearLocalStorageAndDisconnect = async () => {
  safeDisconnectSocket();
  updateSocketState({
    status: 'disconnected',
    connected: false,
    lastDisconnectedAt: Date.now(),
  });
  sessionId = '';
  deviceId = '';
  accessTokenCache = '';

  try {
    await performSessionReset({
      reason: 'manual_logout',
      resetNavigation: false,
      clearAllStorage: true,
    });
  } catch (error) {
    console.error('❌ Failed clearing session state:', error);
  }
};

export const emitDeviceTerminate = (targetSessionId = null) => {
  if (!socket || !socket.connected) return;
  const effectiveSessionId = targetSessionId || sessionId;
  if (!effectiveSessionId) return;

  socket.emit('device:terminate', {
    socketId: socket.id,
    sessionId: effectiveSessionId,
    deviceId,
  });
};

export const getSocket = () => socket;

export const getSessionId = () => sessionId;

export const isSocketConnected = () => !!(socket && socket.connected);

export const disconnectSocket = () => {
  safeDisconnectSocket();
  sessionId = '';
  updateSocketState({
    status: 'disconnected',
    connected: false,
    lastDisconnectedAt: Date.now(),
  });
};

export const reconnectSocket = async (navigation) => {
  if (reauthPromise) {
    return reauthPromise;
  }

  if (!socket) {
    return initSocket(currentDeviceInfo, navigation);
  }

  if (socket.connected) {
    return socket;
  }

  // Try simple reconnect first before full reauthentication
  try {
    updateSocketState({ status: 'reconnecting', connected: false });
    socket.connect();
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.off('connect', onOk);
          socket.off('connect_error', onErr);
          reject(new Error('reconnect timeout'));
        }
      }, 8000);
      const onOk = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off('connect_error', onErr);
        resolve();
      };
      const onErr = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off('connect', onOk);
        reject(err);
      };
      socket.once('connect', onOk);
      socket.once('connect_error', onErr);
    });
    return socket;
  } catch (_err) {
    // Simple reconnect failed, try full reauthentication
    return requestSocketReauthentication('manual_reconnect', navigation);
  }
};

export const reauthenticateSocket = async (navigation) => {
  return requestSocketReauthentication('manual_reauthenticate', navigation);
};

export default {
  initSocket,
  setupAppStateListener,
  emitDeviceTerminate,
  emitLogoutCurrentDevice,
  clearLocalStorageAndDisconnect,
  getSocket,
  getSocketStateSnapshot,
  subscribeSocketState,
  emitSocketEvent,
  getSessionId,
  isSocketConnected,
  disconnectSocket,
  reconnectSocket,
  reauthenticateSocket,
};