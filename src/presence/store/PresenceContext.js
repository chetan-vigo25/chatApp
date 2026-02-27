import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  HEARTBEAT_INTERVAL,
  PRESENCE_STORAGE_KEYS,
  STATUS_TYPES,
} from '../constants';
import * as socketService from '../services/presenceSocket.service';
import * as cacheService from '../services/presenceCache.service';

const initialState = {
  myPresence: {
    status: STATUS_TYPES.ONLINE,
    customStatus: null,
    customStatusEmoji: null,
    customStatusExpiresAt: null,
    isInvisible: false,
    invisibleExpiresAt: null,
    manualOverride: false,
    manualStatus: null,
    manualExpiresAt: null,
    lastUpdated: null,
    lastSeen: null,
    activeDevices: 1,
    currentDevice: {
      deviceId: null,
      deviceType: 'mobile',
      sessionName: 'This Device',
    },
  },
  contactsPresence: {},
  typingIndicators: {},
  sessions: {
    currentSessionId: null,
    sessions: [],
    isLoading: false,
  },
  settings: {
    showLastSeen: true,
    showOnlineStatus: true,
    autoAway: true,
    autoAwayTimeout: 5,
    invisibleMode: false,
    customStatusEnabled: true,
    privacyLevel: 'contacts',
    readReceipts: true,
    typingIndicators: true,
  },
  ui: {
    isInitialized: false,
    isRefreshing: false,
    lastSyncTimestamp: null,
    pendingUpdates: 0,
    hasMoreHistory: false,
    onlineContactsCount: 0,
    totalContactsCount: 0,
  },
  error: null,
};

const PresenceContext = createContext(null);

const normalizeStatusValue = (status) => {
  if (!status || typeof status !== 'string') return STATUS_TYPES.OFFLINE;
  const normalized = status.toLowerCase();
  if (normalized === STATUS_TYPES.ONLINE) return STATUS_TYPES.ONLINE;
  if (normalized === STATUS_TYPES.AWAY) return STATUS_TYPES.AWAY;
  if (normalized === STATUS_TYPES.BUSY) return STATUS_TYPES.BUSY;
  return STATUS_TYPES.OFFLINE;
};

const normalizePresencePayload = (payload = {}) => {
  const source = payload?.data || payload;
  const candidate =
    source?.presence ||
    source?.user ||
    source?.userPresence ||
    source?.presenceData ||
    source;

  return {
    userId:
      payload?.userId ||
      source?.userId ||
      candidate?.userId ||
      candidate?.id ||
      null,
    presence: candidate,
  };
};

const withDefaults = (presence = {}) => ({
  status: normalizeStatusValue(
    presence.status ||
    presence.presenceStatus ||
    presence.effectiveStatus ||
    presence.manualStatus ||
    STATUS_TYPES.OFFLINE
  ),
  customStatus: presence.customStatus || presence.manualCustomStatus || null,
  customStatusEmoji: presence.customStatusEmoji || null,
  lastSeen: presence.lastSeen || presence.last_seen || null,
  lastUpdated: presence.lastUpdated || presence.updatedAt || Date.now(),
  isTyping: presence.isTyping || {},
  isTypingInGroup: presence.isTypingInGroup || {},
  deviceType: presence.deviceType || presence.platform || null,
  subscription: presence.subscription || {
    isSubscribed: false,
    subscribedAt: null,
  },
});

const aggregateOnlineCount = (contactsPresence) => {
  const values = Object.values(contactsPresence || {});
  return values.filter((presence) => presence.status === STATUS_TYPES.ONLINE).length;
};

function reducer(state, action) {
  switch (action.type) {
    case 'HYDRATE': {
      return {
        ...state,
        ...action.payload,
        ui: {
          ...state.ui,
          ...action.payload.ui,
          isInitialized: true,
        },
      };
    }
    case 'SET_ERROR':
      return { ...state, error: action.payload };
    case 'SET_MY_PRESENCE': {
      return {
        ...state,
        myPresence: {
          ...state.myPresence,
          ...action.payload,
          lastUpdated: Date.now(),
        },
      };
    }
    case 'SET_CONTACTS_PRESENCE': {
      const normalizedPayload = {};
      Object.keys(action.payload || {}).forEach((userId) => {
        normalizedPayload[userId] = withDefaults(action.payload[userId]);
      });

      const next = { ...state.contactsPresence, ...normalizedPayload };
      return {
        ...state,
        contactsPresence: next,
        ui: {
          ...state.ui,
          onlineContactsCount: aggregateOnlineCount(next),
          totalContactsCount: Object.keys(next).length,
          lastSyncTimestamp: Date.now(),
        },
      };
    }
    case 'UPSERT_CONTACT_PRESENCE': {
      const { userId, presence } = action.payload;
      if (!userId) return state;
      const nextPresence = withDefaults({
        ...state.contactsPresence[userId],
        ...presence,
      });
      const next = {
        ...state.contactsPresence,
        [userId]: nextPresence,
      };
      return {
        ...state,
        contactsPresence: next,
        ui: {
          ...state.ui,
          onlineContactsCount: aggregateOnlineCount(next),
          totalContactsCount: Object.keys(next).length,
        },
      };
    }
    case 'SET_TYPING': {
      const { chatId, userId, isTyping, messageType } = action.payload;
      const byChat = state.typingIndicators[chatId] || {};
      const nextByChat = {
        ...byChat,
        [userId]: {
          isTyping,
          messageType: messageType || null,
          startedAt: Date.now(),
        },
      };
      return {
        ...state,
        typingIndicators: {
          ...state.typingIndicators,
          [chatId]: nextByChat,
        },
      };
    }
    case 'SET_GROUP_TYPING': {
      const { groupId, users } = action.payload;
      return {
        ...state,
        typingIndicators: {
          ...state.typingIndicators,
          [groupId]: {
            typingUsers: users,
            startedAt: Date.now(),
          },
        },
      };
    }
    case 'SET_SESSIONS':
      return {
        ...state,
        sessions: {
          ...state.sessions,
          sessions: action.payload,
          isLoading: false,
        },
      };
    case 'SET_SESSIONS_LOADING':
      return {
        ...state,
        sessions: {
          ...state.sessions,
          isLoading: action.payload,
        },
      };
    case 'SET_SETTINGS':
      return {
        ...state,
        settings: {
          ...state.settings,
          ...action.payload,
        },
      };
    default:
      return state;
  }
}

export function PresenceProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const hydrate = useCallback(async () => {
    try {
      const [myRaw, contactsRaw, settingsRaw, sessionsRaw, lastSyncRaw] = await Promise.all([
        AsyncStorage.getItem(PRESENCE_STORAGE_KEYS.MY_PRESENCE),
        AsyncStorage.getItem(PRESENCE_STORAGE_KEYS.CONTACTS),
        AsyncStorage.getItem(PRESENCE_STORAGE_KEYS.SETTINGS),
        AsyncStorage.getItem(PRESENCE_STORAGE_KEYS.SESSIONS),
        AsyncStorage.getItem(PRESENCE_STORAGE_KEYS.LAST_SYNC),
      ]);

      const parse = (raw, fallback) => {
        try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
      };

      const contactsWrapped = parse(contactsRaw, {});
      const contactsPresence = {};
      Object.keys(contactsWrapped).forEach((userId) => {
        const wrapped = contactsWrapped[userId];
        contactsPresence[userId] = wrapped?.value ? withDefaults(wrapped.value) : withDefaults(wrapped);
      });

      dispatch({
        type: 'HYDRATE',
        payload: {
          myPresence: parse(myRaw, initialState.myPresence),
          contactsPresence,
          settings: parse(settingsRaw, initialState.settings),
          sessions: {
            ...initialState.sessions,
            sessions: parse(sessionsRaw, []),
          },
          ui: {
            ...initialState.ui,
            lastSyncTimestamp: lastSyncRaw ? Number(lastSyncRaw) : null,
          },
        },
      });
    } catch (error) {
      dispatch({ type: 'SET_ERROR', payload: error?.message || 'Failed to initialize presence' });
      dispatch({ type: 'HYDRATE', payload: {} });
    }
  }, []);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!state.ui.isInitialized) return;
    AsyncStorage.setItem(PRESENCE_STORAGE_KEYS.MY_PRESENCE, JSON.stringify(state.myPresence));
  }, [state.myPresence, state.ui.isInitialized]);

  useEffect(() => {
    if (!state.ui.isInitialized) return;
    AsyncStorage.setItem(PRESENCE_STORAGE_KEYS.SETTINGS, JSON.stringify(state.settings));
  }, [state.settings, state.ui.isInitialized]);

  useEffect(() => {
    if (!state.ui.isInitialized) return;
    AsyncStorage.setItem(PRESENCE_STORAGE_KEYS.SESSIONS, JSON.stringify(state.sessions.sessions));
  }, [state.sessions.sessions, state.ui.isInitialized]);

  useEffect(() => {
    if (!state.ui.isInitialized) return;
    cacheService.cacheMultiplePresence(state.contactsPresence);
    cacheService.setLastSyncTimestamp(Date.now());
  }, [state.contactsPresence, state.ui.isInitialized]);

  useEffect(() => {
    const unsubscribers = [
      socketService.onPresenceConnected((payload) => {
        dispatch({ type: 'SET_MY_PRESENCE', payload: payload?.data || payload });
      }),
      socketService.onPresenceUpdate((payload) => {
        const { userId, presence } = normalizePresencePayload(payload);
        if (!userId) return;
        dispatch({ type: 'UPSERT_CONTACT_PRESENCE', payload: { userId, presence } });
      }),
      socketService.onPresenceSubscribedUpdate((payload) => {
        const { userId, presence } = normalizePresencePayload(payload);
        if (!userId) return;
        dispatch({ type: 'UPSERT_CONTACT_PRESENCE', payload: { userId, presence } });
      }),
      socketService.onGetResponse((payload) => {
        const { userId, presence } = normalizePresencePayload(payload);
        if (!userId) return;
        dispatch({ type: 'UPSERT_CONTACT_PRESENCE', payload: { userId, presence } });
      }),
      socketService.onFetchResponse((payload) => {
        const source = payload?.data || payload;
        const rows = source?.users || source?.presence || source?.list || source || [];
        const map = {};

        if (Array.isArray(rows)) {
          rows.forEach((entry) => {
            const normalized = normalizePresencePayload(entry);
            if (normalized.userId) {
              map[normalized.userId] = normalized.presence;
            }
          });
        }

        if (Object.keys(map).length > 0) {
          dispatch({ type: 'SET_CONTACTS_PRESENCE', payload: map });
        }
      }),
      socketService.onContactsResponse((payload) => {
        const source = payload?.data || payload;
        const rows = source?.users || source?.contacts || source || [];
        const map = {};

        if (Array.isArray(rows)) {
          rows.forEach((entry) => {
            const normalized = normalizePresencePayload(entry);
            if (normalized.userId) {
              map[normalized.userId] = normalized.presence;
            }
          });
        }

        if (Object.keys(map).length > 0) {
          dispatch({ type: 'SET_CONTACTS_PRESENCE', payload: map });
        }
      }),
      socketService.onTypingStart((payload) => {
        dispatch({
          type: 'SET_TYPING',
          payload: {
            chatId: payload.chatId,
            userId: payload.senderId || payload.userId,
            isTyping: true,
            messageType: payload.messageType || null,
          },
        });
      }),
      socketService.onTypingStop((payload) => {
        dispatch({
          type: 'SET_TYPING',
          payload: {
            chatId: payload.chatId,
            userId: payload.senderId || payload.userId,
            isTyping: false,
            messageType: null,
          },
        });
      }),
      socketService.onGroupTypingStarted((payload) => {
        dispatch({
          type: 'SET_GROUP_TYPING',
          payload: {
            groupId: payload.groupId,
            users: payload.typingUsers || [],
          },
        });
      }),
      socketService.onGroupTypingStopped((payload) => {
        dispatch({
          type: 'SET_GROUP_TYPING',
          payload: {
            groupId: payload.groupId,
            users: payload.typingUsers || [],
          },
        });
      }),
      socketService.onSettings((payload) => {
        dispatch({ type: 'SET_SETTINGS', payload: payload?.data || payload || {} });
      }),
      socketService.onSettingsUpdated((payload) => {
        dispatch({ type: 'SET_SETTINGS', payload: payload?.data || payload || {} });
      }),
      socketService.onSessionList((payload) => {
        dispatch({ type: 'SET_SESSIONS', payload: payload?.data || payload || [] });
      }),
      socketService.onSessionTerminated(() => {
        actions.listSessions();
      }),
      socketService.onHeartbeat(() => {
        socketService.emitPong().catch(() => {});
      }),
      socketService.onError((errorPayload) => {
        dispatch({ type: 'SET_ERROR', payload: errorPayload?.message || 'Presence socket error' });
      }),
    ];

    return () => {
      unsubscribers.forEach((unsubscribe) => {
        if (typeof unsubscribe === 'function') unsubscribe();
      });
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      socketService.emitPong().catch(() => {});
    }, HEARTBEAT_INTERVAL);
    return () => clearInterval(id);
  }, []);

  const actions = useMemo(() => ({
    setMyPresence: (presence) => {
      dispatch({ type: 'SET_MY_PRESENCE', payload: presence });
    },
    updateContactPresence: (userId, presence) => {
      dispatch({ type: 'UPSERT_CONTACT_PRESENCE', payload: { userId, presence } });
    },
    setContactsPresence: (map) => {
      dispatch({ type: 'SET_CONTACTS_PRESENCE', payload: map });
    },
    setTyping: (chatId, userId, isTyping, messageType) => {
      dispatch({ type: 'SET_TYPING', payload: { chatId, userId, isTyping, messageType } });
    },
    setGroupTyping: (groupId, users) => {
      dispatch({ type: 'SET_GROUP_TYPING', payload: { groupId, users } });
    },
    setSettings: (settings) => {
      dispatch({ type: 'SET_SETTINGS', payload: settings });
    },
    setError: (message) => {
      dispatch({ type: 'SET_ERROR', payload: message });
    },
    setSessionsLoading: (isLoading) => {
      dispatch({ type: 'SET_SESSIONS_LOADING', payload: isLoading });
    },
    setSessions: (sessions) => {
      dispatch({ type: 'SET_SESSIONS', payload: sessions });
    },
    listSessions: async () => {
      dispatch({ type: 'SET_SESSIONS_LOADING', payload: true });
      const response = await socketService.emitListSessions();
      dispatch({ type: 'SET_SESSIONS', payload: response?.data || [] });
      return response;
    },
  }), []);

  const value = useMemo(() => ({ state, actions }), [state, actions]);

  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}

export const usePresenceStore = () => {
  const context = useContext(PresenceContext);
  if (!context) {
    throw new Error('usePresenceStore must be used within PresenceProvider');
  }
  return context;
};
