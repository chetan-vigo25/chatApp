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

// Emit `call:accept` and resolve with the server ack. The ack matters: the
// server attributes the accept to the real signaling call via the callee's busy
// record — an ack of `{ callId: null }` (or `ok:false`) means the server could
// NOT attribute it (busy record not written yet / socket session still binding
// on a cold boot), so the caller would keep hearing RINGING even though the
// callee answered. Callers use this to retry. A no-ack timeout resolves
// optimistically so an old server can never block the call.
const ACCEPT_ACK_TIMEOUT_MS = 4000;
export const acceptCallSignal = ({ callId, callerId }) => new Promise((resolve) => {
  let settled = false;
  const done = (res) => { if (!settled) { settled = true; resolve(res || { ok: true, timedOut: true }); } };
  if (__DEV__) console.log('[CALL][APP][signal] → emit call:accept', { callId, callerId });
  emitSocketEvent('call:accept', { callId, callerId }, (res) => {
    if (__DEV__) console.log('[CALL][APP][signal] ← call:accept ACK', res);
    done(res);
  });
  setTimeout(() => done({ ok: true, timedOut: true }), ACCEPT_ACK_TIMEOUT_MS);
});

export const rejectCallSignal = ({ callId, callerId }) => {
  if (__DEV__) console.log('[CALL][APP][signal] → emit call:reject', { callId, callerId });
  return emitSocketEvent('call:reject', { callId, callerId });
};

export const endCallSignal = ({ callId, otherUserIds }) => {
  if (__DEV__) console.log('[CALL][APP][signal] → emit call:end', { callId, otherUserIds });
  return emitSocketEvent('call:end', { callId, otherUserIds });
};

// Recovery pull (XR-2 / APP-5). A push-woken / cold-started / just-reconnected
// device may have MISSED the live `call:incoming` (e.g. its CallStyle notif timed
// out, or the socket was down when the caller rang). On (re)connect while IDLE we
// ask the server for any invite that is STILL ringing for us and re-render it.
// Resolves with the server ack `{ ok, calls: [...] }` (or an empty list on a
// no/late ack) so a missing handler never blocks anything.
const PENDING_PULL_ACK_TIMEOUT_MS = 4000;
export const pullPendingCalls = () => new Promise((resolve) => {
  let settled = false;
  const done = (res) => { if (!settled) { settled = true; resolve(res || { ok: true, calls: [] }); } };
  if (__DEV__) console.log('[CALL][APP][signal] → emit call:pending:pull');
  emitSocketEvent('call:pending:pull', {}, (res) => {
    if (__DEV__) console.log('[CALL][APP][signal] ← call:pending:pull ACK', res);
    done(res);
  });
  setTimeout(() => done({ ok: true, calls: [], timedOut: true }), PENDING_PULL_ACK_TIMEOUT_MS);
});

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
    // Caller-only: the server refused to ring an unreachable callee (logged out /
    // deactivated / deleted / blocked / no active session). Carries a human
    // `message` for the call screen.
    'call:unavailable': wrap('call:unavailable', handlers.onUnavailable),
    // Server-authoritative end-of-ring (XR-1). The backend's ring timer fired
    // before either side hung up — the caller should stop ringing with "No
    // answer", an un-accepted callee should mark it missed. Covers clock skew
    // where the local ring timer would otherwise disagree with the server.
    'call:timeout': wrap('call:timeout', handlers.onTimeout),
    // Multi-device dismissal (XR-1). Another device on THIS account handled the
    // call (answered / declined elsewhere), or the caller cancelled — this device
    // must stop ringing and dismiss its ring UI. Payload carries a `reason`
    // (e.g. 'answered_elsewhere' | 'declined_elsewhere' | 'cancelled').
    'call:cancelled-elsewhere': wrap('call:cancelled-elsewhere', handlers.onCancelledElsewhere),
  };
  if (__DEV__) console.log('[CALL][APP][signal] registered call:* listeners on socket', socket.id || '(no id yet)');
  Object.keys(map).forEach((evt) => socket.on(evt, map[evt]));
  return () => {
    Object.keys(map).forEach((evt) => socket.off(evt, map[evt]));
  };
};
