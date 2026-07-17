// Cross-module DeviceEventEmitter event names the call layer (CallProvider)
// listens to. A call push/notification, once received or actioned, is routed
// into the live call flow through these. Kept in its own module so both
// fcmService (FCM pushes) and callNotifee (notifee full-screen notifications)
// can import them without a require cycle.
export const CALL_PUSH_EVENTS = {
  INCOMING: 'call:push:incoming', // show the ringing UI (foreground / tap / wake)
  ACCEPT: 'call:push:accept',     // Accept action / tap → answer
  REJECT: 'call:push:reject',     // Decline action → reject
  HANGUP: 'call:push:hangup',     // End tapped on the active-call ongoing notif → hangup
  RESUME: 'call:push:resume',     // Body tap on the active-call ongoing notif → restore/open
};

// How old a call push may be before we treat it as dead. A high-priority data
// push can sit BUFFERED under Doze / on a force-stopped OEM and then arrive in a
// BURST the moment the app is reopened — ringing many long-over calls at once
// ("app open karte hi saare call ek saath baj jaate hain"). Ring windows are
// ~30–45s, so a push older than this is for a call that's certainly over.
export const STALE_CALL_PUSH_MS = 60 * 1000;

// The signaling call id is minted by the caller as `sig_<callerId>_<dialEpochMs>`
// (see CallProvider.startCall), so it embeds the dial time. Pull that trailing
// epoch out — it's the ONLY timing signal a REPLAYED notification tap carries: the
// native CallStyle / notifee tap payload (emitCallAction) has no backend `ts`, so
// a call notification that lingered in the tray (its cancel/missed push never
// arrived while the app was dead/locked) would otherwise ring a ghost call when
// the user opens the app by tapping it. The callerId is a hex Mongo id (letters),
// so the trailing all-digit group is unambiguously the timestamp. NaN when the id
// isn't in that shape (e.g. a raw WebRTC id).
const callIdDialTime = (callId) => {
  const m = /_(\d{11,})$/.exec(String(callId || ''));
  return m ? Number(m[1]) : NaN;
};

// True when a call push is older than the staleness window. Prefer the backend
// sent-at stamp (`data.ts`, epoch ms); when it's missing/garbled — notably on the
// notification-tap REPLAY path — fall back to the dial time embedded in the
// signaling callId. Only when NEITHER is available do we fail open (ring rather
// than silently swallow a call from an older client/payload).
export const isStaleCallPush = (data) => {
  const now = Date.now();
  const ts = Number(data && data.ts);
  if (Number.isFinite(ts) && ts > 0) return now - ts > STALE_CALL_PUSH_MS;
  const dialTs = callIdDialTime(data && data.callId);
  if (Number.isFinite(dialTs) && dialTs > 0) return now - dialTs > STALE_CALL_PUSH_MS;
  return false;
};

// A push older than this but not yet STALE is "AGED": it sat queued in
// FCM/APNs while the device was offline/airplane/Doze. The call it announces
// may already be cancelled — and the cancel push can arrive out of order — so
// an aged push is VERIFIED against the server's pending list before ringing
// (CallProvider.onPushIncoming) instead of trusted blindly. Fresh pushes
// (the normal live path) ring instantly, well under this threshold.
export const AGED_CALL_PUSH_MS = 12 * 1000;

// Age of a call push in ms — backend sent-at `ts`, else the dial time embedded
// in the signaling callId; NaN when neither is available (fail-open: treat as
// fresh, ring rather than swallow).
export const callPushAgeMs = (data) => {
  const now = Date.now();
  const ts = Number(data && data.ts);
  if (Number.isFinite(ts) && ts > 0) return now - ts;
  const dialTs = callIdDialTime(data && data.callId);
  if (Number.isFinite(dialTs) && dialTs > 0) return now - dialTs;
  return NaN;
};

export default CALL_PUSH_EVENTS;
