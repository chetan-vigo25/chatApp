import { useEffect, useState } from 'react';
import { DeviceEventEmitter } from 'react-native';
import { getSocket, subscribeSocketState } from '../../Redux/Services/Socket/socket';

/**
 * Unseen missed-call badge for the Calls tab (APP-9).
 *
 * A tiny, self-contained counter kept in module scope so it survives screen
 * unmounts (the Calls tab is lazily mounted in the swipe pager). Two independent
 * sources bump it — de-duped per call id so the same missed call is only ever
 * counted once:
 *   1. `call:log:update`  DeviceEvent — a call ended on THIS device (fired by
 *      CallProvider.finalizeEnd); we count an incoming call whose outcome is
 *      'missed'.
 *   2. `call:log:new`     socket event — the backend pushes a recorded/updated
 *      call row to every device of this user (incl. rows created while this
 *      device was offline that arrive on reconnect); we count outcome 'missed'.
 *
 * Cleared when the user opens the Calls tab (CallsScreen focus).
 */

const BADGE_EVENT = 'missedCallBadge:change';

let count = 0;
const seenIds = new Set();

const emitChange = () => {
  DeviceEventEmitter.emit(BADGE_EVENT, count);
};

export const getMissedCount = () => count;

// Increment for a NEW missed call. De-duped by call id so the same call counted
// by both sources (or replayed) never double-counts. A missing id still counts
// (best-effort) but can't be de-duped.
export const bumpMissed = (callId) => {
  const key = callId != null ? String(callId) : null;
  if (key) {
    if (seenIds.has(key)) return;
    seenIds.add(key);
  }
  count += 1;
  emitChange();
};

export const clearMissed = () => {
  if (count === 0 && seenIds.size === 0) return;
  count = 0;
  seenIds.clear();
  emitChange();
};

// React hook: current unseen missed-call count, updated live.
export const useMissedCallBadge = () => {
  const [n, setN] = useState(count);
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(BADGE_EVENT, setN);
    setN(count); // sync in case it changed before the listener attached
    return () => sub.remove();
  }, []);
  return n;
};

const isMissedIncoming = (row) => {
  if (!row) return false;
  const outcome = row.outcome || row.status;
  const direction = row.direction;
  return outcome === 'missed' && direction === 'incoming';
};

/**
 * Start listening for missed calls and bumping the badge. Registers the
 * same-device DeviceEvent + the cross-device socket event (re-attaching on socket
 * reconnect). Returns an unsubscribe. Call once from a long-lived component (the
 * bottom tab bar).
 */
export const startMissedCallTracking = () => {
  const onLogUpdate = (row) => { if (isMissedIncoming(row)) bumpMissed(row.callId); };
  const deviceSub = DeviceEventEmitter.addListener('call:log:update', onLogUpdate);

  const attachSocket = () => {
    const socket = getSocket();
    if (!socket) return () => {};
    const onNew = (payload) => {
      const item = payload?.item || payload;
      if (isMissedIncoming(item)) bumpMissed(item.callId);
    };
    socket.on('call:log:new', onNew);
    return () => { try { socket.off('call:log:new', onNew); } catch (_) { /* */ } };
  };

  let detachSocket = attachSocket();
  let wasConnected = false;
  const unsubState = subscribeSocketState((s) => {
    const connected = !!s.connected;
    if (connected && !wasConnected) {
      detachSocket();
      detachSocket = attachSocket();
    }
    wasConnected = connected;
  });

  return () => {
    deviceSub.remove();
    detachSocket();
    unsubState();
  };
};
