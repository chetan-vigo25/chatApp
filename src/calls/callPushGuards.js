// Pure, dependency-free decision helpers for the CALL-PUSH path (Phase 2 of the
// Oct-15 push audit: P-C-02/04/06/12/16/20). CommonJS on purpose so
// `node --test __tests__/callPushGuards.test.js` can load it without React
// Native. Nothing here touches the bridge, storage or the clock on its own:
// every function takes `now` / offsets as arguments.
//
// The Kotlin side (CallMessagingService / ExpoCallUiModule) and the Swift side
// (AppDelegate PushKit handler) mirror the SAME rules in their own language —
// keep the three in step when changing a rule here.

// ── 1. Session / recipient guard (P-C-02, P-C-04) ───────────────────────────
// What the native marker stores when the user is explicitly signed OUT (as
// opposed to "never written" = unknown). Mirrored in AppDelegate.swift and
// ExpoCallUiModule.kt.
const SESSION_MARKER_SIGNED_OUT = 'none';

const idOrNull = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

/**
 * Should this device ring for a call push addressed to `recipientId`?
 *
 *  - `recipientId`  : callee user id the backend put in the payload (additive;
 *                     absent on an old server → we can't judge → ring, as before).
 *  - `signedInUserId`: the live JS session's user id, when JS is running.
 *  - `marker`       : the native-readable marker (a user id, 'none' when signed
 *                     out, or null/'' when never written / unknown).
 *
 * Returns { action: 'ring' | 'reject', reason }. 'reject' means: do NOT ring.
 * On iOS the AppDelegate must still REPORT the call to CallKit and end it at
 * once (Apple rule); on Android the notification is simply not rendered.
 */
const decideSessionGuard = ({ recipientId, signedInUserId, marker } = {}) => {
  const rid = idOrNull(recipientId);
  if (!rid) return { action: 'ring', reason: 'no_recipient_id' };

  const live = idOrNull(signedInUserId);
  if (live) {
    return live === rid
      ? { action: 'ring', reason: 'match' }
      : { action: 'reject', reason: 'recipient_mismatch' };
  }

  const m = idOrNull(marker);
  if (!m) return { action: 'ring', reason: 'unknown_session' };
  if (m === SESSION_MARKER_SIGNED_OUT) return { action: 'reject', reason: 'signed_out' };
  return m === rid
    ? { action: 'ring', reason: 'match' }
    : { action: 'reject', reason: 'recipient_mismatch' };
};

// ── 2. Staleness with a skewed device clock (P-C-16) ────────────────────────
const STALE_CALL_PUSH_MS = 60 * 1000;
const AGED_CALL_PUSH_MS = 12 * 1000;
const AGED_MULTI_PARTY_PUSH_MS = 25 * 1000;
// When the server clock offset is UNKNOWN the device clock may be minutes off,
// so a "stale by the device clock" push is only DROPPED past this much older
// age; between STALE and this it is downgraded to 'aged' (verify with the
// server's pending list instead of trusting a possibly-wrong clock).
const UNKNOWN_OFFSET_HARD_STALE_MS = 10 * 60 * 1000;
// A learned offset beyond this is not a clock skew, it is garbage.
const MAX_PLAUSIBLE_OFFSET_MS = 24 * 60 * 60 * 1000;
// Two samples further apart than this mean the device clock itself moved
// (NTP step, user changed it) → adopt the new sample instead of max-ing.
const OFFSET_RESET_MS = 30 * 1000;

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

const callIdDialTime = (callId) => {
  const m = /_(\d{11,})$/.exec(String(callId || ''));
  return m ? Number(m[1]) : NaN;
};

// Moment the push was MINTED by the sender, epoch ms of the SENDER's clock
// (backend `ts`); falls back to the dial time inside the signalling id for a
// 1:1 replay that carries no ts. NaN when unknowable (fail open).
const mintedAt = (data) => {
  const ts = Number(data && data.ts);
  if (Number.isFinite(ts) && ts > 0) return { t: ts, server: true };
  if (data && (truthy(data.isConference) || truthy(data.isGroup))) return { t: NaN, server: false };
  const dial = callIdDialTime(data && data.callId);
  // The dial epoch is the CALLER DEVICE's clock, not the server's: it is only
  // comparable to our own clock, never to a learned server offset.
  return { t: Number.isFinite(dial) && dial > 0 ? dial : NaN, server: false };
};

/**
 * Fold a new (serverMs, receivedAtMs) pair into the running server-minus-device
 * offset. `serverMs` is a backend `ts` carried by something that arrived LIVE
 * (socket ring), so serverMs - receivedAtMs is the skew minus the network
 * latency; latency only ever makes a sample too LOW, hence "keep the max"
 * within a stable clock.
 */
const learnServerOffset = (prevOffsetMs, serverMs, receivedAtMs) => {
  const s = Number(serverMs);
  const r = Number(receivedAtMs);
  if (!Number.isFinite(s) || !Number.isFinite(r) || s <= 0 || r <= 0) return prevOffsetMs;
  const sample = s - r;
  if (!Number.isFinite(sample) || Math.abs(sample) > MAX_PLAUSIBLE_OFFSET_MS) return prevOffsetMs;
  if (!Number.isFinite(prevOffsetMs)) return sample;
  if (Math.abs(sample - prevOffsetMs) > OFFSET_RESET_MS) return sample;
  return Math.max(prevOffsetMs, sample);
};

/**
 * Age of a call push in ms, or NaN when unknowable.
 * `offsetMs` = server minus device (null/undefined/NaN when never learned).
 */
const callPushAge = (data, now, offsetMs) => {
  const { t, server } = mintedAt(data);
  if (!Number.isFinite(t)) return NaN;
  const off = server && Number.isFinite(offsetMs) ? offsetMs : 0;
  return (now + off) - t;
};

/**
 * 'fresh' | 'aged' | 'stale' for a call push.
 *  - stale: certainly dead → drop (and on iOS dismiss the CallKit ring).
 *  - aged : maybe dead → ask the server (pending pull) instead of ringing blind.
 *  - fresh: ring now.
 * Unknowable age fails OPEN (fresh).
 */
const classifyCallPush = (data, now, offsetMs) => {
  const age = callPushAge(data, now, offsetMs);
  if (!Number.isFinite(age)) return 'fresh';
  const { server } = mintedAt(data);
  const multi = !!data && (truthy(data.isConference) || truthy(data.isGroup));
  const agedWindow = multi ? AGED_MULTI_PARTY_PUSH_MS : AGED_CALL_PUSH_MS;
  const clockTrusted = !server || Number.isFinite(offsetMs);
  if (age > STALE_CALL_PUSH_MS) {
    if (clockTrusted) return 'stale';
    // A server ts judged by an unverified device clock: do not drop on that
    // alone — a phone whose clock runs fast would lose every live call.
    return age > UNKNOWN_OFFSET_HARD_STALE_MS ? 'stale' : 'aged';
  }
  if (age > agedWindow) return 'aged';
  return 'fresh';
};

// ── 3. Pending native Decline replay (P-C-06) ───────────────────────────────
// The Android receiver persists {callId, callerId, ts} on a Decline tap that JS
// could not observe. On the next JS start we send the reject for entries that
// are still plausibly live; anything older is a dead call (rejecting it is
// pointless and the old code replayed it forever).
const PENDING_DECLINE_MAX_AGE_MS = 90 * 1000;

/**
 * @param {Array<{callId, callerId, ts}>} entries persisted by the receiver
 *        (`ts` = DEVICE clock at the tap).
 * @param {{now:number, alreadySent?:Set<string>|string[], maxAgeMs?:number}} opts
 * @returns {{send:Array, drop:Array}} send = reject over the socket now;
 *          drop = expired/duplicate, just clear.
 */
const selectDeclinesToSend = (entries, { now, alreadySent, maxAgeMs = PENDING_DECLINE_MAX_AGE_MS } = {}) => {
  const sent = new Set(Array.from(alreadySent || []).map(String));
  const send = [];
  const drop = [];
  (Array.isArray(entries) ? entries : []).forEach((e) => {
    const callId = idOrNull(e && e.callId);
    if (!callId) { drop.push(e); return; }
    const ts = Number(e.ts);
    const age = Number.isFinite(ts) && ts > 0 ? now - ts : 0;
    // age < 0 (clock moved back) counts as fresh; a missing ts is treated as
    // fresh too (older native build) — the server ignores a reject for a dead call.
    if (age > maxAgeMs || sent.has(callId)) { drop.push(e); return; }
    sent.add(callId);
    send.push({ callId, callerId: idOrNull(e.callerId), ts: Number.isFinite(ts) ? ts : null });
  });
  return { send, drop };
};

// ── 4. Which call does a payload belong to? (P-C-20, P-C-05) ────────────────
/**
 * True only when we can PROVE the payload is for a different call than the one
 * currently held in `snap` ({signalId, callId}). Unknown ids ⇒ false (act as
 * before). Same semantics as CallProvider.isForeignCallAction.
 */
const isDifferentCall = (snap, payloadCallId) => {
  const pid = idOrNull(payloadCallId);
  if (!pid) return false;
  const signalId = idOrNull(snap && snap.signalId);
  if (!signalId) return false;
  const ids = [signalId, idOrNull(snap && snap.callId)].filter(Boolean);
  return !ids.includes(pid);
};

// ── 5. Re-invite after a native "cancelled" memory (P-C-12 / P-C-20) ────────
/**
 * The Android native layer remembers a cancelled callId for 120 s and refuses
 * to render a ring for it. A GROUP/CONFERENCE keeps one callId for its whole
 * life, so a genuine re-invite must be allowed through — but only when the
 * invite was minted AFTER the cancel (a stale re-delivery of the OLD ring was
 * minted before it and must stay blocked).
 *
 * @param {{cancelledAtDeviceMs:number, inviteTs:number, offsetMs?:number,
 *          isMultiParty:boolean, marginMs?:number}} p
 *   inviteTs is the SENDER's clock; offsetMs (server - device) maps it onto
 *   the device clock the cancel was recorded with. With no offset learned the
 *   comparison is only trusted when the invite is clearly newer (margin).
 */
const canReInviteAfterCancel = ({ cancelledAtDeviceMs, inviteTs, offsetMs, isMultiParty, marginMs = 1000 } = {}) => {
  if (!isMultiParty) return false;
  const cancelled = Number(cancelledAtDeviceMs);
  const ts = Number(inviteTs);
  if (!Number.isFinite(cancelled) || !Number.isFinite(ts) || ts <= 0) return false;
  const off = Number.isFinite(offsetMs) ? offsetMs : 0;
  const inviteOnDeviceClock = ts - off;
  const margin = Number.isFinite(offsetMs) ? marginMs : Math.max(marginMs, 5000);
  return inviteOnDeviceClock > cancelled + margin;
};

module.exports = {
  SESSION_MARKER_SIGNED_OUT,
  STALE_CALL_PUSH_MS,
  AGED_CALL_PUSH_MS,
  AGED_MULTI_PARTY_PUSH_MS,
  UNKNOWN_OFFSET_HARD_STALE_MS,
  PENDING_DECLINE_MAX_AGE_MS,
  decideSessionGuard,
  learnServerOffset,
  callPushAge,
  classifyCallPush,
  selectDeclinesToSend,
  isDifferentCall,
  canReInviteAfterCancel,
};
