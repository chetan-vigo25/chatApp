import { useMemo, useState } from 'react';
import { usePresenceStore } from '../store/PresenceContext';
import * as socketService from '../services/presenceSocket.service';
import { STATUS_TYPES } from '../constants';

export default function useMyPresence() {
  const { state, actions } = usePresenceStore();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const safeAction = async (fn) => {
    setIsLoading(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      const message = err?.message || 'Presence action failed';
      setError(message);
      actions.setError(message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const setStatus = (status) => safeAction(async () => {
    const res = await socketService.emitPresenceUpdate(status);
    actions.setMyPresence({ status, manualOverride: true });
    return res;
  });

  const setCustomStatus = (status, emoji, expiresAt) => safeAction(async () => {
    const res = await socketService.emitCustomStatus(status, emoji, expiresAt);
    actions.setMyPresence({ customStatus: status, customStatusEmoji: emoji || null, customStatusExpiresAt: expiresAt || null });
    return res;
  });

  const clearCustomStatus = () => safeAction(async () => {
    const res = await socketService.emitClearStatus();
    actions.setMyPresence({ customStatus: null, customStatusEmoji: null, customStatusExpiresAt: null });
    return res;
  });

  const setAway = (message, duration) => safeAction(async () => {
    const res = await socketService.emitAway(message, duration);
    actions.setMyPresence({ status: STATUS_TYPES.AWAY, customStatus: message || state.myPresence.customStatus });
    return res;
  });

  const setBack = () => safeAction(async () => {
    const res = await socketService.emitBack();
    actions.setMyPresence({ status: STATUS_TYPES.ONLINE });
    return res;
  });

  const setInvisible = (enabled, duration) => safeAction(async () => {
    const res = await socketService.emitInvisibleMode(enabled, duration);
    actions.setMyPresence({ isInvisible: enabled, invisibleExpiresAt: duration ? Date.now() + duration * 60 * 1000 : null });
    return res;
  });

  const setManual = (status, customStatus, duration, expiresAt) => safeAction(async () => {
    const res = await socketService.emitManualStatus(status, customStatus, duration, expiresAt);
    actions.setMyPresence({
      manualOverride: true,
      manualStatus: status,
      manualExpiresAt: expiresAt || (duration ? Date.now() + duration * 60 * 1000 : null),
      status,
      customStatus: customStatus || null,
    });
    return res;
  });

  const presence = state.myPresence;
  const customStatusExpiresIn = presence.customStatusExpiresAt
    ? Math.max(0, Math.floor((Number(presence.customStatusExpiresAt) - Date.now()) / 1000))
    : null;

  return useMemo(() => ({
    presence,
    isLoading,
    error,
    setStatus,
    setCustomStatus,
    clearCustomStatus,
    setAway,
    setBack,
    setInvisible,
    setManual,
    isOnline: presence.status === STATUS_TYPES.ONLINE,
    isAway: presence.status === STATUS_TYPES.AWAY,
    isBusy: presence.status === STATUS_TYPES.BUSY,
    isOffline: presence.status === STATUS_TYPES.OFFLINE,
    isInvisible: presence.isInvisible,
    customStatusExpiresIn,
  }), [presence, isLoading, error, customStatusExpiresIn]);
}
