import { io } from 'socket.io-client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SOCKET_URL } from '@env';
import { Alert, AppState, Platform } from 'react-native';
import { performSessionReset, saveAuthSession } from '../../../services/sessionManager';
import { resetToLogin, resetToAccountStatus } from '../navigationService';
import ChatDatabase from '../../../services/ChatDatabase';

// Presence heartbeat: while the app is foregrounded we refresh the server's
// liveness key on this cadence. Stopped on background/disconnect so a suspended
// app stops being counted as live (the server's conn-key TTL then expires).
// Short (~4s) so presence is snappy — a force-killed app lapses offline within
// ~9-12s (server conn TTL + sweeper). MUST stay <= server PRESENCE_CONN_TTL_SECONDS.
const PRESENCE_HEARTBEAT_MS = 4000;
let presenceHeartbeatTimer = null;

const startPresenceHeartbeat = () => {
  if (presenceHeartbeatTimer) return;
  const tick = () => {
    if (socket && socket.connected) socket.emit('presence:heartbeat');
  };
  tick();
  presenceHeartbeatTimer = setInterval(tick, PRESENCE_HEARTBEAT_MS);
};

const stopPresenceHeartbeat = () => {
  if (presenceHeartbeatTimer) {
    clearInterval(presenceHeartbeatTimer);
    presenceHeartbeatTimer = null;
  }
};

// Mirror inbound presence into SQLite so the UI can cold-render last-known state.
const persistPresenceEvent = (raw) => {
  try {
    const data = raw?.data || raw || {};
    const userId = data.userId || data?.presence?.userId;
    if (!userId) return;
    const presence = data.presence || data;
    ChatDatabase.upsertPresenceCache(String(userId), {
      status: presence.status,
      lastSeen: presence.lastSeen,
    });
  } catch {
    // best-effort cache write
  }
};

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
// Device push (FCM/APNs) token. Registered with the backend session via
// `notification:device:register` so the server can target this device with push
// notifications (new messages AND incoming-call wake pushes). Without this the
// session has no token and `sendPushToUser` reaches 0 devices.
let pushToken = '';
// iOS PushKit (VoIP) token — used to wake a terminated/locked app for incoming
// calls and report them to CallKit. Separate from the APNs/FCM `pushToken` used
// for message/data notifications.
let voipToken = '';

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

const AUTH_TOKEN_ERROR_CODES = new Set(['AUTH_TOKEN_EXPIRED', 'AUTH_TOKEN_INVALID']);

const isTokenErrorPayload = (payload = {}) => {
  const message = String(payload?.message || payload?.error || payload?.reason || '');
  // The backend now tags auth failures with an explicit code (and `expired`),
  // which is more reliable than message-sniffing. Honour both.
  const code = String(payload?.code || payload?.data?.code || '');
  if (AUTH_TOKEN_ERROR_CODES.has(code)) return true;
  if (payload?.expired === true || payload?.data?.expired === true) return true;
  if (payload?.data?.valid === false) return true;
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

const handleLogout = async (navigation = currentNavigation, alertMessage = null) => {
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

    // Teardown is best-effort — it must NEVER block the redirect to Login.
    try {
      await performSessionReset({
        reason: 'socket_logout',
        resetNavigation: false,
        clearAllStorage: true,
      });
    } catch (e) {
      console.error('❌ session reset failed during logout (continuing):', e?.message);
    }
  } catch (error) {
    console.error('❌ Error during logout:', error);
  } finally {
    // ALWAYS redirect via the ROOT navigation container ref (retries until
    // ready). The passed `navigation` prop can be stale/null or scoped to a
    // nested navigator, which is why a forced logout sometimes failed to leave
    // the current screen.
    resetToLogin();

    // Surface why the user was logged out (e.g. admin deactivated the account).
    if (alertMessage) {
      Alert.alert('Logged out', alertMessage);
    }
  }
};

// Register this device's push token on the active backend session so the server
// can push to it. Safe to call repeatedly (idempotent upsert server-side).
const emitDeviceRegister = () => {
  // Send as soon as we have EITHER a regular push token or a VoIP token — the
  // VoIP token is what powers incoming-call CallKit pushes and must reach the
  // backend even if the standard APNs/FCM token hasn't arrived yet.
  if (!socket || !socket.connected || !deviceId || (!pushToken && !voipToken)) {
    // Dev visibility: a silent skip here means the backend never learns this
    // device's push/VoIP token → killed-app calls can NEVER ring. Log why.
    if (__DEV__) {
      console.log('📲 device register SKIPPED', {
        socketConnected: !!(socket && socket.connected),
        hasDeviceId: !!deviceId,
        hasPushToken: !!pushToken,
        hasVoipToken: !!voipToken,
      });
    }
    return;
  }
  if (__DEV__) {
    console.log('📲 → notification:device:register', {
      hasPushToken: !!pushToken,
      hasVoipToken: !!voipToken,
      voipTokenLen: voipToken ? voipToken.length : 0,
    });
  }
  socket.emit('notification:device:register', {
    deviceId,
    ...(pushToken ? { pushToken } : {}),
    pushProvider: Platform.OS === 'ios' ? 'apns' : 'fcm',
    // iOS-only PushKit token for incoming-call VoIP pushes (CallKit). Omitted on
    // Android, where call pushes ride the existing FCM data-message path.
    ...(voipToken ? { voipToken } : {}),
    deviceInfo: getDeviceInfoPayload(currentDeviceInfo),
  }, (response) => {
    if (response) {
      console.log('📲 notification:device:register response', {
        status: response?.status,
        message: response?.message,
      });
    }
  });
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
  // Push token registration rides along with the device events on (re)connect.
  emitDeviceRegister();
};

// Called by the app once it has acquired an FCM/APNs token (and on refresh).
// Stores it and immediately (re)registers if the socket is already connected.
export const setPushToken = (token) => {
  const next = token ? String(token) : '';
  if (next === pushToken) return;
  pushToken = next;
  emitDeviceRegister();
};

// Register the iOS PushKit (VoIP) token. Re-registers the device so the backend
// can target incoming-call VoIP pushes at this device. Safe to call repeatedly.
export const setVoipToken = (token) => {
  const next = token ? String(token) : '';
  if (next === voipToken) return;
  voipToken = next;
  if (__DEV__) console.log('📞 VoIP (PushKit) token received', { len: next.length });
  emitDeviceRegister();
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
      // Transient network failure — log-level so LogBox stays quiet; we retry.
      console.log('🔁 socket reconnect after refresh failed (will retry):', error?.message || error);
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
      // Do NOT log out here — storage can be transiently unreadable and the
      // existing access token may still be valid. Treat as a temporary failure
      // so we retry later instead of wiping a live session.
      console.warn('⚠️ Missing refreshTokenHash/deviceId for socket reauth (will retry, no logout)');
      throw new Error('reauthentication temporary failure: missing refresh credentials');
    }

    const reauthPayload = {
      refreshTokenHash: String(auth.refreshTokenHash),
      deviceId: String(auth.deviceId),
    };

    const socketRef = socket;
    if (!socketRef) {
      // Transient: socket not built yet. Retry later, never log out.
      throw new Error('reauthentication temporary failure: socket not initialized');
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
            socketRef.off('reauthentication_failed', onReauthFailed);
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
              // Treat as a temporary/retryable failure — never a logout. The
              // in-loop retry runs, and if exhausted the session is preserved.
              finalize(new Error(`reauthentication temporary failure: ${response?.message || 'reauth rejected'}`));
              return;
            }

            completeReauthentication(response)
              .then(() => finalize())
              .catch((err) => finalize(err));
          };

          // The server replies to a REJECTED reauth with a dedicated
          // `reauthentication_failed` event (not on `reauthenticated`).
          // POLICY: a reauth failure must NEVER log the user out on its own. A
          // logged-in session stays logged in until the user explicitly logs out
          // (or the server sends an explicit terminal event — force_logout /
          // device:terminated / logout / account deleted-or-blocked). So we treat
          // EVERY reauth failure as a temporary/retryable condition: the loop
          // retries, and if it exhausts, the session is preserved and the next
          // connect / foreground / token-failure event tries again.
          const onReauthFailed = (response) => {
            const data = response?.data || {};
            const code = String(data.code || '');
            const serverMessage = data.message || response?.message || 'Reauthentication temporarily failed';
            console.warn('📥 reauthentication_failed received (will retry, no logout)', { code, attempt });
            finalize(new Error(`reauthentication temporary failure: ${serverMessage}`));
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
          socketRef.once('reauthentication_failed', onReauthFailed);
          socketRef.once('connect_error', onConnectError);

          timeoutHandle = setTimeout(() => {
            console.log('⏱️ reauthentication timeout occurred (will retry)', {
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
            console.log('⏱️ reauthentication connect timeout (will retry)', {
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
      // POLICY: a reauth failure NEVER logs the user out. Whatever went wrong
      // (rejected token, timeout, network, missing creds) is treated as a
      // recoverable/temporary state — the session is preserved locally and the
      // next connect / foreground / token-failure event retries reauth. Only an
      // explicit terminal server event (force_logout / device:terminated /
      // logout / account deleted-or-blocked) or the user's own logout button
      // ends the session. Log-level keeps LogBox from flagging a routine miss.
      console.log('❌ socket reauthentication failed (kept logged in, will retry):', error?.message || error);

      updateSocketState({
        status: 'reauth_temporary_failure',
        connected: !!socket?.connected,
        lastError: error?.message || 'reauth_temporary_failure',
      });

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

    // We're live and (re)authenticating → announce active + start heartbeat. Only
    // do so when foregrounded; a background reconnect should not resurrect us.
    if (AppState.currentState === 'active') {
      socket.emit('presence:active');
      startPresenceHeartbeat();
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('🔌 socket disconnected', { reason });
    stopPresenceHeartbeat();
    updateSocketState({
      status: 'disconnected',
      connected: false,
      lastDisconnectedAt: Date.now(),
    });

    if (reason === 'io server disconnect') {
      requestSocketReauthentication('server_disconnect', navigation).catch(() => {});
    }
  });

  // Persist presence broadcasts to SQLite for instant cold-render.
  socket.on('presence:update', persistPresenceEvent);
  socket.on('presence:subscribed:update', persistPresenceEvent);
  socket.on('presence:bulk', (raw) => {
    const entries = raw?.data?.entries || raw?.entries || [];
    entries.forEach((e) => persistPresenceEvent({ data: e }));
  });

  socket.on('connect_error', (error) => {
    // Routine: fires whenever the network drops or the OS suspends the socket
    // (screen off, Wi-Fi/data toggle). Logged at log-level — NOT console.error —
    // so React Native's LogBox doesn't surface a red "websocket error" overlay
    // for an expected, self-healing event. The reconnect logic recovers silently.
    console.log('🔌 socket connect_error (will retry):', error?.message || error);
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
    // Refresh the handshake auth token before each reconnect. socket.io reuses the
    // token set at init for auto-reconnects, so after a long background (common on
    // iOS, which suspends sockets aggressively) the old token may have expired and
    // the handshake would fail — delaying or dropping incoming-call delivery. Using
    // the freshest cached access token keeps the reconnect handshake valid.
    if (socket && accessTokenCache) {
      socket.auth = { ...(socket.auth || {}), token: accessTokenCache };
    }
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
      // Sync admin-block state on EVERY connect so the composer locks even when
      // the user was blocked while offline and just relaunched (the live
      // user:blocked event only fires while connected). Silent — no Alert here;
      // applyBlockState handles the interactive block/unblock transitions.
      try {
        const isBlocked = !!response?.data?.isBlocked;
        const mod = require('../../Store');
        const store = mod.store || mod.default || mod;
        const pr = require('../../Reducer/Profile/Profile.reducer');
        const setBlocked = pr.setBlocked || (pr.actions && pr.actions.setBlocked);
        if (store?.dispatch && setBlocked) store.dispatch(setBlocked(isBlocked));
      } catch (e) {}
      emitDeviceEvents();
      return;
    }

    if (isTokenErrorPayload(response)) {
      requestSocketReauthentication('authenticated_failed_token', navigation).catch(() => {});
    }
  });

  socket.on('token:validation:result', (response) => {
    // The result can come back as a failure envelope (status:false) OR as a
    // success envelope carrying { valid:false, expired } — treat both as a
    // signal to silently refresh rather than waiting for a hard disconnect.
    const invalid = response?.status === false || response?.data?.valid === false;
    if (invalid && isTokenErrorPayload(response)) {
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
      // Do NOT log out on a stray/unsolicited reauth-failure frame — attempt a
      // fresh reauth instead. A live session must never be ended by anything
      // other than the user's own logout or an explicit terminal event.
      console.log('❌ unsolicited reauthenticated failure — retrying reauth (no logout)', { message: response?.message });
      requestSocketReauthentication('unsolicited_reauth_failure', navigation).catch(() => {});
    }
  });

  socket.on('device:terminated', (response) => {
    if (response?.status === true || response?.message) {
      handleLogout(navigation);
    }
  });

  socket.on('logout', (payload) => {
    handleLogout(
      navigation,
      payload?.message || 'Your account has been temporarily logged out by the admin.',
    );
  });

  // Single-device login: this device's session was hard-deleted because the same
  // account just logged in on another device. The server kicks our socket with
  // `force_logout` — wipe the local session and return to the login screen
  // immediately (don't wait for the next REST 401).
  socket.on('force_logout', (payload) => {
    handleLogout(
      navigation,
      payload?.message || 'You have been logged out because your account was used on another device.',
    );
  });

  // SM2 — typed account-state denial on the 'error' channel (server emits this
  // then disconnects when a blocked/inactive/deleted account tries to use or
  // (re)open a socket). Route to the AccountStatus screen + wipe. Other 'error'
  // payloads (category !== 'account') are left to the existing token/connect
  // handlers, so this is purely additive.
  socket.on('error', (payload) => {
    const info = payload?.data || payload || {};
    const state = ACCOUNT_STATE_BY_CODE[info.code];
    if (info.category === 'account' || state) {
      handleAccountStateError(state || 'blocked', info.message).catch(() => {});
    }

    // Send-failure correlation: the server now echoes clientMessageId/tempId
    // on send errors. Flip the optimistic row to 'failed' (retry affordance)
    // instead of leaving it on the clock icon forever — but only for
    // NON-retryable failures on send events; transient ones stay with the
    // durable outbox's backoff cycle.
    const failedClientId = info.clientMessageId || info.tempId;
    const failedEvent = payload?.event || info.event || '';
    const SEND_EVENTS = ['message:send', 'message:reply', 'message:quote', 'group:message:send'];
    if (failedClientId && SEND_EVENTS.includes(failedEvent) && info.retryable !== true) {
      try {
        const ChatDatabase = require('../../../services/ChatDatabase').default
          || require('../../../services/ChatDatabase');
        ChatDatabase.updateMessageStatus(failedClientId, 'failed').catch(() => {});
        ChatDatabase.outboxRemove(failedClientId).catch(() => {});
      } catch (e) {}
      try {
        const { DeviceEventEmitter } = require('react-native');
        DeviceEventEmitter.emit('chat:send:failed', {
          clientMessageId: failedClientId,
          code: info.code || null,
          message: info.message || null,
          chatId: info.chatId || null,
        });
        // Nudge any open thread to re-read from SQLite so the bubble updates.
        if (info.chatId) DeviceEventEmitter.emit('chat:thread:update', { chatId: info.chatId });
      } catch (e) {}
    }
  });

  // Admin blocked/unblocked this account. A blocked user is NOT logged out —
  // the session stays alive and they can still browse and receive, but the
  // server rejects any send (1:1 / group message / status). We flip the Redux
  // flag so the composer locks, and inform the user.
  const applyBlockState = (blocked, payload) => {
    try {
      const mod = require('../../Store');
      const store = mod.store || mod.default || mod;
      const pr = require('../../Reducer/Profile/Profile.reducer');
      const setBlocked = pr.setBlocked || (pr.actions && pr.actions.setBlocked);
      if (store?.dispatch && setBlocked) store.dispatch(setBlocked(blocked));
    } catch (e) {}
    try {
      const { Alert } = require('react-native');
      Alert.alert(
        blocked ? 'Account blocked' : 'Account unblocked',
        payload?.message ||
          (blocked
            ? 'An admin has blocked your account. You can view your chats but cannot send messages.'
            : 'Your account has been unblocked. You can send messages again.'),
      );
    } catch (e) {}
  };

  socket.on('user:blocked', (payload) => applyBlockState(true, payload));
  socket.on('user:unblocked', (payload) => applyBlockState(false, payload));

  // User-to-user (contact) block realtime sync. Distinct from the admin
  // account-block above: these keep the `block` slice in step across this
  // user's devices and reflect when someone blocks/unblocks THIS user.
  const dispatchBlock = (actionName, payload) => {
    try {
      const mod = require('../../Store');
      const store = mod.store || mod.default || mod;
      const br = require('../../Reducer/Block/Block.reducer');
      const action = br[actionName];
      if (store?.dispatch && action) store.dispatch(action(payload));
    } catch (e) {}
  };

  // My device blocked someone → sync to my other devices.
  socket.on('contact:blocked', (payload) => dispatchBlock('contactBlocked', { userId: String(payload?.userId || '') }));
  socket.on('contact:unblocked', (payload) => dispatchBlock('contactUnblocked', { userId: String(payload?.userId || '') }));
  // Someone blocked / unblocked ME → disable my composer toward them.
  socket.on('block:status:changed', (payload) =>
    dispatchBlock('blockedByChanged', { byUserId: String(payload?.byUserId || ''), blocked: !!payload?.blocked }),
  );

  // INITIAL block-list load for this session. Without it `block.blockedIds` is empty
  // on a cold start, so a blocked 1-1 chat wrongly shows the composer (instead of
  // "You blocked this contact") AND the outgoing-call block guard (getBlockRelation)
  // never fires — both read this list. Hydrate from the on-device SQLite cache for
  // INSTANT correct state, then refresh from the server. Mirrors the Blocked
  // Contacts screen's load; runs once per socket setup (i.e. per login/app start).
  (async () => {
    try {
      const mod = require('../../Store');
      const store = mod.store || mod.default || mod;
      if (!store?.dispatch) return;
      const br = require('../../Reducer/Block/Block.reducer');
      let ChatDB = null;
      try { const cm = require('../../../services/ChatDatabase'); ChatDB = cm.default || cm; } catch (e) {}
      try {
        const cached = ChatDB ? await ChatDB.loadBlockedContacts() : null;
        if (cached && cached.length) store.dispatch(br.hydrateBlocked(cached));
      } catch (e) {}
      const res = await store.dispatch(br.fetchBlockedContacts({ search: '', page: 1, limit: 100 }));
      if (br.fetchBlockedContacts.fulfilled.match(res) && ChatDB) {
        try { await ChatDB.saveBlockedContacts(res.payload?.items || []); } catch (e) {}
      }
    } catch (e) { /* best-effort — never block socket setup */ }
  })();

  // Account-deletion lifecycle. When the server tears the account down it
  // force-logs-out every device — wipe local state and return to auth so the
  // app behaves like a fresh install (the regular 'logout' handler covers the
  // base case; these add a clearer, deletion-specific message).
  socket.on('account:logout:all:devices', (payload) => {
    handleLogout(navigation, payload?.message || 'You have been logged out from all devices.');
  });
  socket.on('account:permanently:deleted', (payload) => {
    handleLogout(navigation, payload?.message || 'Your account has been permanently deleted.');
  });
};

// Map the backend's typed account-state error codes (SM2) to the AccountStatus
// screen `state` param. These are NOT recoverable by a token refresh — the
// account itself is blocked/inactive/deleted — so we wipe the local session and
// route to the dedicated explainer screen instead of looping on reauth.
// Admin BLOCK is intentionally absent — a blocked user is NOT logged out (they
// stay logged in with a locked composer; see applyBlockState). Only deactivate
// and delete route to the account-state screen + wipe.
const ACCOUNT_STATE_BY_CODE = {
  ACCOUNT_INACTIVE: 'inactive',
  ACCOUNT_DELETED: 'deleted',
  ACCOUNT_NOT_FOUND: 'deleted',
};

const handleAccountStateError = async (state, message) => {
  try {
    safeDisconnectSocket();
    updateSocketState({ status: 'logged_out', connected: false, lastDisconnectedAt: Date.now() });
    sessionId = '';
    deviceId = '';
    accessTokenCache = '';
    pendingEmitQueue.length = 0;
    try {
      await performSessionReset({ reason: `account_${state}`, resetNavigation: false, clearAllStorage: true });
    } catch (e) {
      console.error('❌ session reset failed during account-state handling (continuing):', e?.message);
    }
  } finally {
    resetToAccountStatus(state, message || null);
  }
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
      // Do NOT log out here — a transient storage-read miss (racing a concurrent
      // write) must not wipe a live session. Just skip socket init; a later
      // foreground/checkLoginStatus retries, and AuthContext's own token check
      // governs whether the login screen is actually shown.
      console.warn('⚠️ initSocket: missing accessToken/deviceId — skipping init (no logout)');
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

// Whether the screen is currently locked (Android keyguard). A locked phone is
// "not foreground" for presence even though AppState reports 'active' (because
// MainActivity is showWhenLocked). Tracked so the AppState + lock listeners stay
// in agreement and we don't double-emit.
let deviceLocked = false;

// Tell the server we've left the foreground (app backgrounded OR screen locked):
// announce away + stop the heartbeat. The server holds a short grace then
// finalizes offline. Idempotent — stopping an already-stopped heartbeat is a
// no-op, and a second presence:away inside the grace just resets the same timer.
const emitGoingBackground = () => {
  stopPresenceHeartbeat();
  if (socket && socket.connected) {
    socket.emit('app:state', { state: 'background' });
    socket.emit('presence:away', {});
  }
};

// Tell the server we're foreground & active again: announce active + resume the
// heartbeat (which refreshes the server's liveness key). Only call when the app
// is genuinely usable — foregrounded AND unlocked.
const emitBackToForeground = () => {
  emitSocketEvent('app:state', { state: 'foreground' });
  emitSocketEvent('presence:active');
  startPresenceHeartbeat();
};

export const setupAppStateListener = (navigation) => {
  const handleAppStateChange = async (nextAppState) => {
    const goingBackground = nextAppState.match(/inactive|background/);
    const goingForeground = appState.match(/inactive|background/) && nextAppState === 'active';

    if (goingForeground) {
      if (!socket || !socket.connected) {
        await reconnectSocket(navigation);
      } else if (accessTokenCache) {
        socket.emit('token:validate', { token: accessTokenCache });
      }
      // Foregrounded — but if the device is still locked (showWhenLocked resumes
      // the app over the keyguard), we are NOT really active yet. Stay "away"
      // until the unlock event fires.
      if (!deviceLocked) emitBackToForeground();
    } else if (goingBackground && appState === 'active') {
      // App minimized / removed from recents → announce away + stop heartbeat.
      emitGoingBackground();
    }

    appState = nextAppState;
  };

  const subscription = AppState.addEventListener('change', handleAppStateChange);
  // The screen-lock listener is part of the same foreground-tracking lifecycle,
  // so register it here and fold its teardown into the returned cleanup — every
  // existing caller (AuthContext) then gets lock-aware presence for free.
  const unsubLock = setupDeviceLockPresence();
  return () => {
    subscription.remove();
    try { unsubLock(); } catch (_) { /* */ }
  };
};

// Device screen lock/unlock → presence. This is the fix for "device locked but
// app was open → still online": because MainActivity is showWhenLocked, locking
// the screen does NOT background the app (AppState stays 'active'), so the
// heartbeat would otherwise keep the user falsely online. We key off the native
// keyguard signal instead: lock → away + stop heartbeat; unlock → active +
// resume (only if the app is also foregrounded). No-op off Android.
export const setupDeviceLockPresence = () => {
  let unsub = () => {};
  try {
    // Lazy require to avoid pulling the native call-UI module into modules that
    // never need it (and to keep this crash-safe when the module isn't built).
    const { addDeviceLockListener, isDeviceLockedNow } = require('../../../firebase/callNotifee');
    deviceLocked = !!isDeviceLockedNow?.();
    unsub = addDeviceLockListener((locked) => {
      if (locked === deviceLocked) return;
      deviceLocked = locked;
      if (locked) {
        emitGoingBackground();
      } else if (AppState.currentState === 'active') {
        // Unlocked AND foregrounded → genuinely active again.
        emitBackToForeground();
      }
    });
  } catch (e) {
    console.warn('device lock presence wiring skipped (non-fatal):', e?.message);
  }
  return () => { try { unsub(); } catch (_) { /* */ } };
};

export const emitLogoutCurrentDevice = async () => {
  try {
    const auth = await getAuthStorage();
    const payload = {
      deviceId: String(auth?.deviceId || deviceId || ''),
      logoutAll: false,
    };

    if (socket && socket.connected) {
      // Explicitly deregister this device's FCM push token BEFORE logout so push
      // stops immediately (G2). The backend also nulls the token when it
      // terminates the session, but emitting this first closes the window where a
      // message/call push could still fire between logout and session cleanup.
      // Best-effort: if it doesn't reach the server, session termination + the
      // FCM dead-token feedback path still clear the token.
      try {
        socket.emit('notification:device:unregister', { deviceId: payload.deviceId });
      } catch (e) {
        console.warn('device unregister emit failed (non-fatal):', e?.message);
      }
      // Final authoritative presence-offline + last-seen BEFORE we tear the
      // socket down (O1). Without this the user lingers "online" until the
      // server's heartbeat sweeper catches up.
      try {
        socket.emit('presence:offline', {});
      } catch (e) {
        console.warn('presence:offline emit failed (non-fatal):', e?.message);
      }
      socket.emit('logout', payload);
      console.log('📤 Emitted logout event:', payload);
    }

    return payload;
  } catch (error) {
    console.error('❌ emitLogoutCurrentDevice error:', error);
    return { deviceId: '', logoutAll: false };
  }
};

// `wipeLocalDB` force-destroys the on-device SQLite cache. An ordinary logout
// PRESERVES it (so a same-account return is instant + local-first); account
// deletion passes `wipeLocalDB: true` so the data does not survive.
export const clearLocalStorageAndDisconnect = async ({ wipeLocalDB = false } = {}) => {
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
      reason: wipeLocalDB ? 'account_deleted' : 'manual_logout',
      resetNavigation: false,
      clearAllStorage: true,
      wipeLocalDB,
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
  setPushToken,
  setVoipToken,
};