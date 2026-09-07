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

// A MULTI-PARTY call (conference OR group) keeps ONE callId for the WHOLE life
// of the call, so the epoch embedded in `sig_<hostId>_<ms>` is when the call
// STARTED — not when this particular invite was minted. A member who left and is
// re-added ten minutes in gets a genuinely live ring whose callId "looks" ten
// minutes old, and the dial-time fallback below then declared it stale (or merely
// aged, which routes through a server verify that a cold boot can lose). JS
// therefore never built the INCOMING state, while iOS had ALREADY put the CallKit
// screen up from the VoIP push — the user saw the incoming call, answered it, and
// nothing joined ("audio connecting…" forever).
//
// This carve-out originally covered `isConference` only. Group calls hit exactly
// the same reused-id re-invite path (they are the same multi-party call — see
// isMultiParty in callMachine), so a re-invited GROUP member's push was still
// being swallowed. For either, only the backend `ts` is meaningful; with no `ts`
// we fail OPEN (ring) rather than swallow a live invite.
const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';
const isMultiPartyPush = (data) => !!data && (truthy(data.isConference) || truthy(data.isGroup));

// The moment this push was MINTED, in epoch ms — NaN when unknowable.
// Prefer the backend sent-at stamp (`data.ts`); when it's missing/garbled —
// notably on the notification-tap REPLAY path — fall back to the dial time
// embedded in the signaling callId, except for a multi-party call (see above).
const callPushMintedAt = (data) => {
  const ts = Number(data && data.ts);
  if (Number.isFinite(ts) && ts > 0) return ts;
  if (isMultiPartyPush(data)) return NaN;
  const dialTs = callIdDialTime(data && data.callId);
  return (Number.isFinite(dialTs) && dialTs > 0) ? dialTs : NaN;
};

// True when a call push is older than the staleness window. When the mint time is
// unknowable we fail open (ring rather than silently swallow a call from an older
// client/payload).
export const isStaleCallPush = (data) => {
  const t = callPushMintedAt(data);
  return Number.isFinite(t) ? Date.now() - t > STALE_CALL_PUSH_MS : false;
};

// A push older than this but not yet STALE is "AGED": it sat queued in
// FCM/APNs while the device was offline/airplane/Doze. The call it announces
// may already be cancelled — and the cancel push can arrive out of order — so
// an aged push is VERIFIED against the server's pending list before ringing
// (CallProvider.onPushIncoming) instead of trusted blindly. Fresh pushes
// (the normal live path) ring instantly, well under this threshold.
export const AGED_CALL_PUSH_MS = 12 * 1000;

// Age of a call push in ms — NaN when the mint time is unknowable (fail-open:
// treat as fresh, ring rather than swallow).
export const callPushAgeMs = (data) => {
  const t = callPushMintedAt(data);
  return Number.isFinite(t) ? Date.now() - t : NaN;
};

export default CALL_PUSH_EVENTS;
