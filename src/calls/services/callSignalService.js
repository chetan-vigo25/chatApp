import { emitSocketEvent, getSocket } from '../../Redux/Services/Socket/socket';

/**
 * Call SIGNALING over the app's own (always-connected) backend socket. This is
 * the RELIABLE notify path that complements the calling-service WebRTC SDK:
 *  - `ringCall` lets the server (a) busy-gate the call and (b) push a
 *    `call:incoming` to the callee instantly, even if their WebView call engine
 *    isn't connected yet.
 *  - the cancel/accept/reject/end emits keep the server's Redis "busy" lock in
 *    sync so a third user gets "User is busy on another call" only while a call
 *    is actually live.
 *
 * Everything is best-effort: a missing/zero ack must never block the WebRTC call.
 */

const RING_ACK_TIMEOUT_MS = 4000;

// Emit `call:ring` and resolve with the server ack:
//   { ok, busy, busyUserIds, ringingUserIds }
// If the server doesn't ack within the timeout (older server / offline), resolve
// optimistically as "not busy" so the call still proceeds via WebRTC.
export const ringCall = ({ callId, toUserIds, media, isGroup, groupName }) => new Promise((resolve) => {
  let settled = false;
  const done = (res) => { if (!settled) { settled = true; resolve(res || { ok: true, busy: false }); } };
  const payload = { callId, toUserIds, media, isGroup: !!isGroup, groupName: groupName || null };
  if (__DEV__) console.log('[CALL][APP][signal] → emit call:ring', payload);
  emitSocketEvent('call:ring', payload, (res) => {
    if (__DEV__) console.log('[CALL][APP][signal] ← call:ring ACK', res);
    done(res);
  });
  setTimeout(() => done({ ok: true, busy: false, timedOut: true }), RING_ACK_TIMEOUT_MS);
});

export const cancelCall = ({ callId, toUserIds }) => {
  if (__DEV__) console.log('[CALL][APP][signal] → emit call:cancel', { callId, toUserIds });
  return emitSocketEvent('call:cancel', { callId, toUserIds });
};

export const acceptCallSignal = ({ callId, callerId }) => {
  if (__DEV__) console.log('[CALL][APP][signal] → emit call:accept', { callId, callerId });
  return emitSocketEvent('call:accept', { callId, callerId });
};

export const rejectCallSignal = ({ callId, callerId }) => {
  if (__DEV__) console.log('[CALL][APP][signal] → emit call:reject', { callId, callerId });
  return emitSocketEvent('call:reject', { callId, callerId });
};

export const endCallSignal = ({ callId, otherUserIds }) => {
  if (__DEV__) console.log('[CALL][APP][signal] → emit call:end', { callId, otherUserIds });
  return emitSocketEvent('call:end', { callId, otherUserIds });
};

/**
 * Attach the server→client call event listeners to the CURRENT socket instance.
 * Returns an unsubscribe. Re-call this whenever the socket (re)connects so a new
 * underlying instance keeps the listeners.
 */
export const registerCallSignalListeners = (handlers = {}) => {
  const socket = getSocket();
  if (!socket) return () => {};
  // Wrap each handler so every inbound server→client call event is logged with
  // its payload before the provider acts on it.
  const wrap = (evt, fn) => (payload) => {
    if (__DEV__) console.log(`[CALL][APP][signal] ← ${evt}`, payload);
    if (fn) fn(payload);
  };
  const map = {
    'call:incoming': wrap('call:incoming', handlers.onIncoming),
    'call:cancelled': wrap('call:cancelled', handlers.onCancelled),
    'call:accepted': wrap('call:accepted', handlers.onAccepted),
    'call:rejected': wrap('call:rejected', handlers.onRejected),
    'call:ended': wrap('call:ended', handlers.onEnded),
  };
  if (__DEV__) console.log('[CALL][APP][signal] registered call:* listeners on socket', socket.id || '(no id yet)');
  Object.keys(map).forEach((evt) => socket.on(evt, map[evt]));
  return () => {
    Object.keys(map).forEach((evt) => socket.off(evt, map[evt]));
  };
};
