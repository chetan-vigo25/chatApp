import { Platform } from 'react-native';
import * as Location from 'expo-location';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import NetInfo from '@react-native-community/netinfo';
import { emitSocketEvent, getSocket } from '../../Redux/Services/Socket/socket';
import { getLastKnownLocation, setLastKnownLocation } from '../../utils/lastKnownLocation';

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

// ── Caller dial-time location — ZERO impact on the call path ────────────────
// The ring must NEVER wait on GPS, permissions, or geocoding. So:
//   • `call:ring` goes out IMMEDIATELY, carrying whatever coordinate is already
//     in the warm in-app cache (fed by earlier call-time fixes) — a pure
//     synchronous memory read, no async work on the ring path at all.
//   • In PARALLEL (fire-and-forget, fully detached from the call flow) we grab
//     an EXACT fresh GPS fix and send it via a separate lightweight
//     `call:location` event; the server updates the call-log row whenever it
//     lands. Any failure here is swallowed silently — it can never touch the
//     ring, the ack, or any call state.
//   • No permission prompt is ever raised from the call path (a dialog popping
//     mid-dial would wreck the experience) — permission is already asked at
//     onboarding; if it's missing we simply send nothing.
const instantCallLocation = () => {
  try {
    const cached = getLastKnownLocation();
    if (!cached) return null;
    return { latitude: cached.latitude, longitude: cached.longitude, accuracy: cached.accuracy };
  } catch {
    return null;
  }
};

// Caller's device telemetry sent alongside the exact fix. All best-effort —
// the server pairs this with the deviceId + IP it already knows from the
// authenticated socket (those are never taken from the client).
export const buildCallDeviceInfo = async () => {
  const info = {
    platform: Platform.OS,
    model: Device.modelName || null,
    osVersion: Device.osVersion || String(Platform.Version || '') || null,
    appVersion:
      Constants?.expoConfig?.version
      || Constants?.manifest2?.extra?.expoClient?.version
      || null,
    networkType: null,
    carrier: null,
  };
  try {
    const net = await NetInfo.fetch();
    info.networkType = net?.type || null;
    info.carrier = net?.details?.carrier || null;
  } catch {
    // network info is best-effort
  }
  return info;
};

const sendExactCallLocation = async (callId) => {
  try {
    // Device telemetry goes even when location is unavailable/denied.
    const deviceInfo = await buildCallDeviceInfo().catch(() => null);

    let location = null;
    const perm = await Location.getForegroundPermissionsAsync().catch(() => null);
    if (perm?.status === 'granted') {
      // Highest accuracy = a real GPS fix — this is the "exact" coordinate the
      // call log wants. However long it takes, it's off the call path entirely.
      // With the continuous location stream removed, this one-shot capture is
      // the ONLY call-time location source: fresh GPS fix first, and if that
      // fails/times out, the OS's own cached last-known position (instant, no
      // GPS spin-up) so the call still gets a coordinate.
      const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest }).catch(() => null)
        || await Location.getLastKnownPositionAsync({ maxAge: 10 * 60 * 1000 }).catch(() => null);
      const { latitude, longitude, accuracy } = fix?.coords || {};
      if (latitude != null && longitude != null) {
        setLastKnownLocation({ latitude, longitude, accuracy });
        location = { latitude, longitude, accuracy: accuracy != null ? Number(accuracy) : null };
        // Reverse-geocode on the DEVICE (OS geocoder — free, no Google
        // Geocoding API usage) so the server can store a readable address in
        // the call log / tracking ledger. Best-effort.
        try {
          const geo = await Location.reverseGeocodeAsync({ latitude, longitude });
          const g = geo?.[0];
          if (g) {
            location.address = {
              street: [g.name, g.street].filter(Boolean).join(' ').trim() || null,
              city: g.city || g.subregion || null,
              state: g.region || null,
              country: g.country || null,
              zipCode: g.postalCode || null,
              timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } })(),
            };
          }
        } catch {
          // address is optional — coordinates alone are still sent
        }
      }
    }

    if (!location && !deviceInfo) return;
    if (__DEV__) console.log('[CALL][APP][signal] → emit call:location (exact fix + device)', { callId, location, deviceInfo });
    emitSocketEvent('call:location', { callId, location, deviceInfo });
  } catch {
    // best-effort only — never surfaces anywhere near the call
  }
};

// Emit `call:ring` and resolve with the server ack:
//   { ok, busy, busyUserIds, ringingUserIds }
// If the server doesn't ack within the timeout (older server / offline), resolve
// optimistically as "not busy" so the call still proceeds via WebRTC.
export const ringCall = ({ callId, toUserIds, media, isGroup, groupName }) => new Promise((resolve) => {
  let settled = false;
  const done = (res) => { if (!settled) { settled = true; resolve(res || { ok: true, busy: false }); } };
  const payload = {
    callId, toUserIds, media, isGroup: !!isGroup, groupName: groupName || null,
    // Instant, synchronous cache read — zero added latency on the ring.
    location: instantCallLocation(),
  };
  if (__DEV__) console.log('[CALL][APP][signal] → emit call:ring', payload);
  emitSocketEvent('call:ring', payload, (res) => {
    if (__DEV__) console.log('[CALL][APP][signal] ← call:ring ACK', res);
    done(res);
  });
  setTimeout(() => done({ ok: true, busy: false, timedOut: true }), RING_ACK_TIMEOUT_MS);
  // Detached exact-GPS follow-up — updates the call log via `call:location`.
  sendExactCallLocation(callId);
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

// ── Conference (multi-party) signaling ──────────────────────────────────────
// Same callId as the live call; the backend converts the 1:1 into a conference
// on the first invite and becomes the authoritative roster source.
const CONF_ACK_TIMEOUT_MS = 4000;
const emitWithAck = (event, payload, timeoutMs = CONF_ACK_TIMEOUT_MS) => new Promise((resolve) => {
  let settled = false;
  const done = (res) => { if (!settled) { settled = true; resolve(res || { ok: true, timedOut: true }); } };
  if (__DEV__) console.log(`[CALL][APP][signal] → emit ${event}`, payload);
  emitSocketEvent(event, payload, (res) => {
    if (__DEV__) console.log(`[CALL][APP][signal] ← ${event} ACK`, res);
    done(res);
  });
  setTimeout(() => done({ ok: true, timedOut: true }), timeoutMs);
});

export const conferenceInvite = ({ callId, invitedUserIds, operationId }) =>
  emitWithAck('call:conference:invite', { callId, invitedUserIds, operationId });

export const conferenceCancelInvite = ({ callId, userId }) =>
  emitWithAck('call:conference:cancel', { callId, userId });

export const conferenceAccept = ({ callId, operationId }) =>
  emitWithAck('call:conference:accept', { callId, operationId });

export const conferenceReject = ({ callId }) =>
  emitWithAck('call:conference:reject', { callId });

export const conferenceLeave = ({ callId }) =>
  emitWithAck('call:conference:leave', { callId });

export const conferenceMedia = ({ callId, audioEnabled, videoEnabled }) =>
  emitWithAck('call:conference:media', { callId, audioEnabled, videoEnabled });

export const conferenceState = ({ callId }) =>
  emitWithAck('call:conference:state', { callId });

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
    // ── Conference (server-authoritative roster) ─────────────────────────────
    // The 1:1 just became a conference — both original parties flip UI mode.
    'call:conference:converted': wrap('call:conference:converted', handlers.onConferenceConverted),
    // Full authoritative participant list — clients render EXACTLY this.
    'call:conference:roster': wrap('call:conference:roster', handlers.onConferenceRoster),
    'call:conference:participant:joined': wrap('call:conference:participant:joined', handlers.onConferenceParticipantJoined),
    'call:conference:participant:left': wrap('call:conference:participant:left', handlers.onConferenceParticipantLeft),
    'call:conference:participant:updated': wrap('call:conference:participant:updated', handlers.onConferenceParticipantUpdated),
    'call:conference:host:changed': wrap('call:conference:host:changed', handlers.onConferenceHostChanged),
    'call:conference:ended': wrap('call:conference:ended', handlers.onConferenceEnded),
  };
  if (__DEV__) console.log('[CALL][APP][signal] registered call:* listeners on socket', socket.id || '(no id yet)');
  Object.keys(map).forEach((evt) => socket.on(evt, map[evt]));
  return () => {
    Object.keys(map).forEach((evt) => socket.off(evt, map[evt]));
  };
};
