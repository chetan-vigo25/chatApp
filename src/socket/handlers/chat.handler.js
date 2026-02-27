const DEFAULT_TIMEOUT = 12000;

const ERROR_CATEGORIES = {
  AUTH: 'auth',
  VALIDATION: 'validation',
  SYSTEM: 'system',
  DATABASE: 'database',
  RATE_LIMIT: 'rate_limit',
};

const nowUnix = () => Date.now();

const MESSAGE_EVENTS = new Set([
  'message:send',
  'message:quick',
  'message:schedule',
  'message:cancel:scheduled',
  'message:delivered',
  'message:read',
  'message:read:bulk',
  'message:read:all',
  'message:seen',
  'message:edit',
  'message:delete',
  'message:delete:everyone',
  'message:delete:me',
  'message:clear:history',
  'message:reaction:add',
  'message:reaction:remove',
  'message:reaction:list',
  'message:sync',
  'message:fetch',
  'message:fetch:unread',
  'message:search',
  'message:search:media',
  'message:forward',
  'message:forward:multiple',
  'message:reply',
  'message:quote',
]);

const REQUIRED_FIELDS = {
  'message:send': ['receiverId', 'text'],
  'message:quick': ['receiverId', 'text'],
  'message:schedule': ['receiverId', 'text', 'scheduleTime'],
  'message:cancel:scheduled': ['messageId'],
  'message:delivered': ['messageId', 'chatId', 'senderId'],
  'message:read': ['messageId', 'chatId', 'senderId'],
  'message:read:bulk': ['messageIds', 'chatId', 'senderId'],
  'message:read:all': ['chatId', 'senderId'],
  'message:seen': ['messageId', 'chatId'],
  'message:edit': ['messageId', 'chatId'],
  'message:delete': ['messageId', 'chatId'],
  'message:delete:everyone': ['messageId', 'chatId'],
  'message:delete:me': ['messageId', 'chatId'],
  'message:clear:history': ['chatId'],
  'message:reaction:add': ['messageId', 'chatId', 'emoji'],
  'message:reaction:remove': ['messageId', 'chatId', 'emoji'],
  'message:reaction:list': ['messageId'],
  'message:sync': ['chatId'],
  'message:fetch': ['chatId'],
  'message:fetch:unread': ['chatId'],
  'message:search': ['chatId', 'query'],
  'message:search:media': ['chatId', 'mediaType'],
  'message:forward': ['messageId', 'receiverIds'],
  'message:forward:multiple': ['messageIds', 'receiverIds'],
  'message:reply': ['receiverId', 'text', 'replyToMessageId'],
  'message:quote': ['receiverId', 'text', 'quotedMessageId'],
  'chat:create': ['userId'],
  'chat:info': ['chatId'],
  'chat:pin': ['chatId'],
  'chat:unpin': ['chatId'],
  'chat:mute': ['chatId'],
  'chat:unmute': ['chatId'],
  'chat:archive': ['chatId'],
  'chat:unarchive': ['chatId'],
  'typing:start': ['chatId', 'receiverId'],
  'typing:stop': ['chatId', 'receiverId'],
  'typing:recording': ['chatId', 'receiverId', 'isRecording'],
  'user:search:mobile': ['mobileNumber'],
  'user:search:mobile:bulk': ['mobileNumbers'],
  'user:search:mobile:exists': ['mobileNumber'],
};

const createSuccessResponse = (event, data = {}) => ({
  status: true,
  message: 'success',
  event,
  data,
  timestamp: nowUnix(),
});

const createErrorData = (error = {}) => ({
  code: error.code || 'SYSTEM_ERROR',
  message: error.message || 'Unexpected error',
  category: error.category || ERROR_CATEGORIES.SYSTEM,
  details: error.details || {},
  retryable: Boolean(error.retryable),
});

const createErrorResponse = (event, error = {}) => ({
  status: false,
  message: 'error',
  event,
  data: createErrorData(error),
  timestamp: nowUnix(),
});

const hasEmptyValue = (value) => {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
};

const validatePayload = (event, payload = {}) => {
  const required = REQUIRED_FIELDS[event] || [];
  if (required.length === 0) return null;

  const missing = required.filter((field) => hasEmptyValue(payload[field]));
  if (missing.length === 0) return null;

  return createErrorResponse(event, {
    code: 'VALIDATION_ERROR',
    message: `Missing required fields: ${missing.join(', ')}`,
    category: ERROR_CATEGORIES.VALIDATION,
    details: { missingFields: missing },
    retryable: false,
  });
};

const normalizePayload = (event, payload = {}) => {
  if (event === 'user:search:mobile' || event === 'user:search:mobile:exists') {
    return {
      countryCode: payload.countryCode || '+91',
      ...payload,
    };
  }

  if (event === 'user:search:mobile:bulk') {
    return {
      ...payload,
      countryCodes: Array.isArray(payload.countryCodes) && payload.countryCodes.length > 0 ? payload.countryCodes : ['+91'],
    };
  }

  return payload;
};

const ensureWrappedSuccess = (event, payload) => {
  if (payload?.status === true) {
    const wrapped = {
      ...payload,
      event: payload.event || event,
      timestamp: payload.timestamp || nowUnix(),
    };

    if (MESSAGE_EVENTS.has(event)) {
      wrapped.data = {
        ...(wrapped.data || {}),
        viaKafka: wrapped.data?.viaKafka ?? true,
      };
    }

    return wrapped;
  }

  if (payload && typeof payload === 'object' && 'data' in payload) {
    return createSuccessResponse(event, payload.data);
  }

  return createSuccessResponse(event, payload || {});
};

const ensureWrappedError = (event, payload) => {
  if (payload?.status === false && payload?.data) {
    return {
      ...payload,
      event: payload.event || event,
      timestamp: payload.timestamp || nowUnix(),
      data: createErrorData(payload.data),
    };
  }

  return createErrorResponse(event, {
    code: payload?.code,
    message: payload?.message,
    category: payload?.category,
    details: payload?.details,
    retryable: payload?.retryable,
  });
};

const shouldHandleErrorEvent = (errorPayload, event) => {
  if (!errorPayload || typeof errorPayload !== 'object') return false;
  if (!errorPayload.event) return true;
  return errorPayload.event === event;
};

const emitWithWrappedResponse = (socket, event, payload = {}, options = {}) =>
  new Promise((resolve, reject) => {
    const normalizedPayload = normalizePayload(event, payload);
    const validationError = validatePayload(event, normalizedPayload);
    if (validationError) {
      reject(validationError);
      return;
    }

    if (!socket || !socket.connected) {
      reject(
        createErrorResponse(event, {
          code: 'SOCKET_NOT_CONNECTED',
          message: 'Socket not connected',
          category: ERROR_CATEGORIES.AUTH,
          details: { event },
          retryable: true,
        })
      );
      return;
    }

    const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT;
    const responseEvent = `${event}:response`;
    let finished = false;
    let timeoutId = null;

    const cleanup = () => {
      socket.off(responseEvent, onResponse);
      socket.off('error', onError);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };

    const done = (handler, value) => {
      if (finished) return;
      finished = true;
      cleanup();
      handler(value);
    };

    const onResponse = (responsePayload) => {
      if (responsePayload?.status === false) {
        done(reject, ensureWrappedError(event, responsePayload));
        return;
      }
      done(resolve, ensureWrappedSuccess(event, responsePayload));
    };

    const onError = (errorPayload) => {
      if (!shouldHandleErrorEvent(errorPayload, event)) return;
      done(reject, ensureWrappedError(event, errorPayload));
    };

    timeoutId = setTimeout(() => {
      done(
        reject,
        createErrorResponse(event, {
          code: 'REQUEST_TIMEOUT',
          message: `${event} timed out`,
          category: ERROR_CATEGORIES.SYSTEM,
          details: { timeoutMs },
          retryable: true,
        })
      );
    }, timeoutMs);

    socket.on(responseEvent, onResponse);
    socket.on('error', onError);

    socket.emit(event, normalizedPayload, (ackPayload) => {
      if (ackPayload === undefined || ackPayload === null || finished) return;

      if (ackPayload.status === false) {
        done(reject, ensureWrappedError(event, ackPayload));
        return;
      }

      done(resolve, ensureWrappedSuccess(event, ackPayload));
    });
  });

const createEmitter = (event) => (socket, payload = {}, options = {}) =>
  emitWithWrappedResponse(socket, event, payload, options);

const createOnEvent = (socket, event, callback) => {
  if (!socket || typeof callback !== 'function') {
    return () => {};
  }

  socket.on(event, callback);
  return () => socket.off(event, callback);
};

export const chatEventEmitters = {
  messageSend: createEmitter('message:send'),
  messageQuick: createEmitter('message:quick'),
  messageSchedule: createEmitter('message:schedule'),
  messageCancelScheduled: createEmitter('message:cancel:scheduled'),
  messageDelivered: createEmitter('message:delivered'),
  messageRead: createEmitter('message:read'),
  messageReadBulk: createEmitter('message:read:bulk'),
  messageReadAll: createEmitter('message:read:all'),
  messageSeen: createEmitter('message:seen'),
  messageEdit: createEmitter('message:edit'),
  messageDelete: createEmitter('message:delete'),
  messageDeleteEveryone: createEmitter('message:delete:everyone'),
  messageDeleteMe: createEmitter('message:delete:me'),
  messageClearHistory: createEmitter('message:clear:history'),
  messageReactionAdd: createEmitter('message:reaction:add'),
  messageReactionRemove: createEmitter('message:reaction:remove'),
  messageReactionList: createEmitter('message:reaction:list'),
  messageSync: createEmitter('message:sync'),
  messageFetch: createEmitter('message:fetch'),
  messageFetchUnread: createEmitter('message:fetch:unread'),
  messageSearch: createEmitter('message:search'),
  messageSearchMedia: createEmitter('message:search:media'),
  messageForward: createEmitter('message:forward'),
  messageForwardMultiple: createEmitter('message:forward:multiple'),
  messageReply: createEmitter('message:reply'),
  messageQuote: createEmitter('message:quote'),

  chatCreate: createEmitter('chat:create'),
  chatList: createEmitter('chat:list'),
  chatInfo: createEmitter('chat:info'),
  chatPin: createEmitter('chat:pin'),
  chatUnpin: createEmitter('chat:unpin'),
  chatMute: createEmitter('chat:mute'),
  chatUnmute: createEmitter('chat:unmute'),
  chatArchive: createEmitter('chat:archive'),
  chatUnarchive: createEmitter('chat:unarchive'),

  typingStart: createEmitter('typing:start'),
  typingStop: createEmitter('typing:stop'),
  typingRecording: createEmitter('typing:recording'),

  userSearchMobile: createEmitter('user:search:mobile'),
  userSearchMobileBulk: createEmitter('user:search:mobile:bulk'),
  userSearchMobileExists: createEmitter('user:search:mobile:exists'),
};

export const chatServerEvents = {
  onMessageSentAck: (socket, cb) => createOnEvent(socket, 'message:sent:ack', cb),
  onMessageQuickAck: (socket, cb) => createOnEvent(socket, 'message:quick:ack', cb),
  onMessageReceived: (socket, cb) => createOnEvent(socket, 'message:received', cb),
  onQuickMessageReceived: (socket, cb) => createOnEvent(socket, 'message:quick:received', cb),
  onMessageDelivered: (socket, cb) => createOnEvent(socket, 'message:delivered', cb),
  onMessageRead: (socket, cb) => createOnEvent(socket, 'message:read', cb),
  onMessageReadBulkAck: (socket, cb) => createOnEvent(socket, 'message:read:bulk:ack', cb),
  onMessageReadAllAck: (socket, cb) => createOnEvent(socket, 'message:read:all:ack', cb),
  onReactionAdded: (socket, cb) => createOnEvent(socket, 'message:reaction:added', cb),
  onReactionRemoved: (socket, cb) => createOnEvent(socket, 'message:reaction:removed', cb),
  onNotificationStatusUpdate: (socket, cb) => createOnEvent(socket, 'notification:status:update', cb),
  onNotificationTypingUpdate: (socket, cb) => createOnEvent(socket, 'notification:typing:update', cb),
  onChatListUpdate: (socket, cb) => createOnEvent(socket, 'chat:list:update', cb),
};

export const chatSocketResponse = {
  success: createSuccessResponse,
  error: createErrorResponse,
};

export const chatErrorCategories = ERROR_CATEGORIES;

export default {
  emitters: chatEventEmitters,
  on: chatServerEvents,
  response: chatSocketResponse,
  categories: chatErrorCategories,
};