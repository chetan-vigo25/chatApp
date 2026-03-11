import { getSocket, isSocketConnected } from '../../Redux/Services/Socket/socket';

const DEFAULT_TIMEOUT = 8000;

const emitWithAck = (event, payload = {}) => {
  return new Promise((resolve, reject) => {
    const socket = getSocket();
    if (!socket || !isSocketConnected()) {
      reject(new Error('Socket not connected'));
      return;
    }

    socket.emit(event, payload, (response) => {
      resolve(response);
    });
  });
};

const emitWithAckOrResponse = (event, payload = {}, responseEvent, matcher = null, timeout = DEFAULT_TIMEOUT) => {
  return new Promise((resolve, reject) => {
    const socket = getSocket();
    if (!socket || !isSocketConnected()) {
      reject(new Error('Socket not connected'));
      return;
    }

    let settled = false;
    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (responseEvent) {
        socket.off(responseEvent, onResponseEvent);
      }
    };

    const finish = (value, isError = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (isError) reject(value);
      else resolve(value);
    };

    const onResponseEvent = (responsePayload) => {
      if (typeof matcher === 'function' && !matcher(responsePayload)) {
        return;
      }
      finish(responsePayload);
    };

    if (responseEvent) {
      socket.on(responseEvent, onResponseEvent);
    }

    timeoutId = setTimeout(() => {
      finish(new Error(`${event} timed out`), true);
    }, timeout);

    socket.emit(event, payload, (ackResponse) => {
      if (ackResponse !== undefined && ackResponse !== null) {
        finish(ackResponse);
      }
    });
  });
};

const on = (event, callback) => {
  let detached = false;
  let attachedSocket = null;
  let pollId = null;

  const attachIfAvailable = () => {
    if (detached) return;
    const socket = getSocket();
    if (!socket) return;

    if (attachedSocket === socket) return;
    if (attachedSocket) {
      attachedSocket.off(event, callback);
    }

    socket.on(event, callback);
    attachedSocket = socket;

    if (pollId) {
      clearInterval(pollId);
      pollId = null;
    }
  };

  attachIfAvailable();

  if (!attachedSocket) {
    pollId = setInterval(attachIfAvailable, 500);
  }

  return () => {
    detached = true;
    if (pollId) clearInterval(pollId);
    if (attachedSocket) attachedSocket.off(event, callback);
  };
};

export const emitPresenceUpdate = (status, customStatus, expiresAt) => emitWithAck('presence:update', { status, customStatus, expiresAt });
export const emitManualStatus = (status, customStatus, duration, expiresAt) => emitWithAck('presence:manual', { status, customStatus, duration, expiresAt });
export const emitCustomStatus = (status, emoji, expiresAt) => emitWithAck('presence:status:custom', { status, emoji, expiresAt });
export const emitClearStatus = () => emitWithAck('presence:status:clear');
export const emitInvisibleMode = (enabled, duration) => emitWithAck('presence:invisible', { enabled, duration });
export const emitAway = (message, duration) => emitWithAck('presence:away', { message, duration });
export const emitBack = () => emitWithAck('presence:back');
export const emitFetchPresence = (userIds, detailed = true) =>
  emitWithAckOrResponse('presence:fetch', { userIds, detailed }, 'presence:fetch:response');
export const emitGetPresence = (userId) =>
  emitWithAckOrResponse(
    'presence:get',
    { userId },
    'presence:get:response',
    (payload) => {
      const source = payload?.data || payload;
      const candidate = source?.presence || source?.userPresence || source?.presenceData || source;
      const responseUserId = source?.userId || candidate?.userId || candidate?.id;
      return !userId || !responseUserId || String(responseUserId) === String(userId);
    }
  );
export const emitGetContactsPresence = () =>
  emitWithAckOrResponse('presence:contacts', {}, 'presence:contacts:response');
export const emitGetLastSeen = (userId) =>
  emitWithAckOrResponse('presence:lastseen', { userId }, 'presence:lastseen:response');
export const emitSubscribe = (targetUserId, userIds) =>
  emitWithAckOrResponse('presence:subscribe', { targetUserId, userIds }, 'presence:subscribe:response');
export const emitUnsubscribe = (targetUserId, userIds) =>
  emitWithAckOrResponse('presence:unsubscribe', { targetUserId, userIds }, 'presence:unsubscribe:response');
export const emitGetSubscriptions = () =>
  emitWithAckOrResponse('presence:subscriptions', {}, 'presence:subscriptions:response');
export const emitTypingStart = (chatId, receiverId, messageType) => emitWithAck('typing:start', { chatId, receiverId, messageType });
export const emitTypingStop = (chatId, receiverId) => emitWithAck('typing:stop', { chatId, receiverId });
export const emitGroupTypingStart = (groupId, messageType) => emitWithAck('typing:group:start', { groupId, messageType });
export const emitGroupTypingStop = (groupId) => emitWithAck('typing:group:stop', { groupId });
export const emitTypingStatus = (chatId) => emitWithAck('typing:status', { chatId });
export const emitListSessions = () => emitWithAck('session:list');
export const emitSessionInfo = (socketId) => emitWithAck('session:info', { socketId });
export const emitTerminateSession = (socketId) => emitWithAck('session:terminate', { socketId });
export const emitRenameSession = (name) => emitWithAck('session:rename', { name });
export const emitDeviceInfo = () => emitWithAck('device:info');
export const emitDeviceUpdate = (deviceInfo) => emitWithAck('device:update', deviceInfo);
export const emitBatchUpdate = (updates) => emitWithAck('presence:batch:update', { updates });
export const emitBatchFetch = (userIds, detailed = true) => emitWithAck('presence:batch:fetch', { userIds, detailed });
export const emitGetSettings = () => emitWithAck('presence:settings:get');
export const emitUpdateSettings = (settings) => emitWithAck('presence:settings:update', settings);
export const emitPong = () => emitWithAck('pong');

export const onPresenceConnected = (cb) => on('presence:connected', cb);
export const onPresenceUpdateResponse = (cb) => on('presence:update:response', cb);
export const onPresenceUpdate = (cb) => on('presence:update', cb);
export const onPresenceSubscribedUpdate = (cb) => on('presence:subscribed:update', cb);
export const onManualResponse = (cb) => on('presence:manual:response', cb);
export const onCustomStatusUpdated = (cb) => on('presence:status:custom:updated', cb);
export const onStatusCleared = (cb) => on('presence:status:cleared', cb);
export const onInvisibleUpdated = (cb) => on('presence:invisible:updated', cb);
export const onAwaySet = (cb) => on('presence:away:set', cb);
export const onBackSet = (cb) => on('presence:back:set', cb);
export const onFetchResponse = (cb) => on('presence:fetch:response', cb);
export const onGetResponse = (cb) => on('presence:get:response', cb);
export const onContactsResponse = (cb) => on('presence:contacts:response', cb);
export const onHistoryResponse = (cb) => on('presence:history:response', cb);
export const onLastSeenResponse = (cb) => on('presence:lastseen:response', cb);
export const onSubscribeResponse = (cb) => on('presence:subscribe:response', cb);
export const onUnsubscribeResponse = (cb) => on('presence:unsubscribe:response', cb);
export const onSubscriptionsResponse = (cb) => on('presence:subscriptions:response', cb);
export const onTypingStart = (cb) => on('typing:start', cb);
export const onTypingStop = (cb) => on('typing:stop', cb);
export const onGroupTypingStarted = (cb) => on('typing:group:started', cb);
export const onGroupTypingStopped = (cb) => on('typing:group:stopped', cb);
export const onTypingStatusResponse = (cb) => on('typing:status:response', cb);
export const onSessionList = (cb) => on('session:list', cb);
export const onSessionInfoResponse = (cb) => on('session:info:response', cb);
export const onSessionTerminated = (cb) => on('session:terminated', cb);
export const onSessionRenamed = (cb) => on('session:renamed', cb);
export const onDeviceInfoResponse = (cb) => on('device:info:response', cb);
export const onDeviceUpdated = (cb) => on('device:updated', cb);
export const onBatchUpdateResponse = (cb) => on('presence:batch:update:response', cb);
export const onBatchFetchResponse = (cb) => on('presence:batch:fetch:response', cb);
export const onSettings = (cb) => on('presence:settings', cb);
export const onSettingsUpdated = (cb) => on('presence:settings:updated', cb);
export const onHeartbeat = (cb) => on('heartbeat', cb);
export const onError = (cb) => on('error', cb);