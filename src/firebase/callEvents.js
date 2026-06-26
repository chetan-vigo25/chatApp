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

// True when a call push's sent-at stamp (`data.ts`, epoch ms set by the backend)
// is older than the staleness window. Missing/garbled ts → NOT stale (fail-open:
// an older client/payload must still ring rather than silently swallow a call).
export const isStaleCallPush = (data) => {
  const ts = Number(data && data.ts);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return Date.now() - ts > STALE_CALL_PUSH_MS;
};

export default CALL_PUSH_EVENTS;
