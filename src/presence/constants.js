export const STATUS_TYPES = {
  ONLINE: 'online',
  AWAY: 'away',
  BUSY: 'busy',
  OFFLINE: 'offline',
};

export const STATUS_COLORS = {
  online: '#4CAF50',
  away: '#FFC107',
  busy: '#F44336',
  offline: '#9E9E9E',
};

export const STATUS_ICONS = {
  online: 'circle',
  away: 'clock',
  busy: 'minus-circle',
  offline: 'circle-outline',
};

export const TYPING_TIMEOUT = 10000;
export const AWAY_TIMEOUT = 300000;
export const HEARTBEAT_INTERVAL = 30000;
export const MAX_BATCH_FETCH = 200;
export const MAX_BATCH_UPDATE = 50;

export const PRESENCE_CACHE_TTL = 2 * 60 * 1000;
export const PRESENCE_STORAGE_KEYS = {
  MY_PRESENCE: 'presence:my',
  CONTACTS: 'presence:contacts',
  SETTINGS: 'presence:settings',
  SESSIONS: 'presence:sessions',
  LAST_SYNC: 'presence:lastSync',
};

export const PRESENCE_ERRORS = {
  NOT_AUTHENTICATED: 'You must be authenticated',
  INVALID_STATUS: 'Invalid status value provided',
  INVALID_USER_IDS: 'Invalid user IDs provided',
  USER_ID_REQUIRED: 'User ID is required',
  TARGET_REQUIRED: 'Target user ID is required',
  CUSTOM_STATUS_ERROR: 'Failed to set custom status',
  CLEAR_STATUS_ERROR: 'Failed to clear status',
  INVISIBLE_MODE_ERROR: 'Failed to toggle invisible mode',
  PRESENCE_HISTORY_ERROR: 'Failed to fetch presence history',
  CHAT_ID_REQUIRED: 'Chat ID is required',
  SESSION_LIST_ERROR: 'Failed to list sessions',
  SOCKET_ID_REQUIRED: 'Socket ID is required',
  SESSION_NOT_FOUND: 'Session not found',
  SESSION_TERMINATE_ERROR: 'Failed to terminate session',
  BATCH_UPDATE_ERROR: 'Batch update failed',
  BATCH_FETCH_ERROR: 'Batch fetch failed',
  SETTINGS_UPDATE_ERROR: 'Failed to update settings',
};
