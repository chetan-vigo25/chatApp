import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePresenceStore } from '../store/PresenceContext';
import * as socketService from '../services/presenceSocket.service';
import { formatLastSeen, getStatusColor, getStatusIcon } from '../services/lastSeenFormatter.service';
import { STATUS_TYPES } from '../constants';

const normalizePresenceResponse = (response = {}) => {
  const source = response?.data || response;
  const candidate =
    source?.presence ||
    source?.user ||
    source?.userPresence ||
    source?.presenceData ||
    source;

  const status =
    (candidate?.status || candidate?.presenceStatus || candidate?.effectiveStatus || candidate?.manualStatus || STATUS_TYPES.OFFLINE)
      ?.toString()
      .toLowerCase();

  return {
    ...candidate,
    status,
    customStatus: candidate?.customStatus || candidate?.manualCustomStatus || null,
    lastSeen: candidate?.lastSeen || candidate?.last_seen || null,
  };
};

export default function useUserPresence(userId) {
  const { state, actions } = usePresenceStore();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!userId) return null;
    setIsLoading(true);
    setError(null);
    try {
      const response = await socketService.emitGetPresence(userId);
      const data = normalizePresenceResponse(response);
      actions.updateContactPresence(userId, data);
      return response;
    } catch (err) {
      setError(err);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [userId, actions]);

  const subscribe = useCallback(async () => {
    if (!userId) return;
    await socketService.emitSubscribe(userId);
    actions.updateContactPresence(userId, {
      subscription: { isSubscribed: true, subscribedAt: Date.now() },
    });
  }, [userId, actions]);

  const unsubscribe = useCallback(async () => {
    if (!userId) return;
    await socketService.emitUnsubscribe(userId);
    actions.updateContactPresence(userId, {
      subscription: { isSubscribed: false, subscribedAt: null },
    });
  }, [userId, actions]);

  useEffect(() => {
    let unsubscribePresenceConnected = () => {};

    if (userId) {
      subscribe();
      refresh();
      unsubscribePresenceConnected = socketService.onPresenceConnected(() => {
        subscribe();
        refresh();
      });
    }

    return () => {
      unsubscribePresenceConnected();
      if (userId) {
        unsubscribe();
      }
    };
  }, [userId, refresh, subscribe, unsubscribe]);

  const presence = state.contactsPresence[userId] || {
    status: null,
    customStatus: null,
    lastSeen: null,
    isTyping: {},
  };

  return useMemo(() => ({
    presence,
    isLoading,
    error,
    refresh,
    isOnline: presence.status === STATUS_TYPES.ONLINE,
    lastSeenFormatted: formatLastSeen(presence.lastSeen, state.settings.privacyLevel),
    statusColor: getStatusColor(presence.status),
    statusIcon: getStatusIcon(presence.status),
    subscribe,
    unsubscribe,
  }), [presence, isLoading, error, refresh, subscribe, unsubscribe, state.settings.privacyLevel]);
}
