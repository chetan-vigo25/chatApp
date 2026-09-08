import { DeviceEventEmitter } from 'react-native';
import nativeEngine from './native-engine/NativeCallEngine';
import { isNativeCallEngine } from './engineSelector';
import { CMD, EVT } from './engine/protocol';
import { CALL_STATUS } from './state/callMachine';
import { CALL_PUSH_EVENTS } from '../firebase/callEvents';
import { stopOngoingCallNotification, setCallActiveNative } from '../firebase/callNotifee';
import { endCallSignal } from './services/callSignalService';

/**
 * Call session keeper — the seam that makes the CALL lifecycle independent of
 * the APP UI lifecycle.
 *
 * Why this exists (Android): swiping the app out of Recents destroys the
 * Activity. React Native reacts by unloading its surface (ReactDelegate
 * .onHostDestroy → unloadApp), which unmounts the ENTIRE React tree — CallProvider
 * included. What it does NOT destroy is the process: the active-call foreground
 * service keeps it (and the JS runtime) alive, and everything the call actually
 * runs on lives in module singletons that never unmount — NativeCallEngine, its
 * mediasoup/WebRTC transports, the app socket, the mic/camera capture. So the
 * media keeps flowing perfectly well with nobody listening to it.
 *
 * This module is that listener. It is the ONLY subscriber to the engine, so the
 * subscription outlives any React tree, and it:
 *
 *   • forwards engine events straight to the mounted CallProvider (the normal
 *     case — a plain pass-through, no behaviour change),
 *   • BUFFERS them while no provider is mounted, and replays them on re-attach
 *     so the call's history lands through the provider's real handlers (call
 *     log, timers, teardown) rather than a duplicated shadow implementation,
 *   • holds the last live call state so a freshly mounted provider can re-adopt
 *     the running session instead of booting into IDLE,
 *   • and handles the two things that CANNOT wait for a provider that may never
 *     come back: a terminal engine event, and a Hang up tap on the ongoing-call
 *     notification. Both must release the mic and clear the notification even if
 *     the user never re-opens the app.
 *
 * iOS never reaches the detached state (killing the app terminates the process,
 * which ends the call by definition), so there the keeper is a pass-through.
 */

// Engine events kept while detached. A call generates a handful of events per
// minute, so this is minutes of headroom; past it the oldest are dropped (the
// replay is a courtesy, the snapshot + the server reconcile are the truth).
const MAX_BUFFERED_EVENTS = 200;

// How long a session that ENDED while detached stays replayable. Re-open within
// this window and the provider finalizes it normally (end screen, call log);
// past it the session is discarded silently rather than surfacing a stale
// "call ended" screen for something that finished long ago.
const TERMINAL_REPLAY_WINDOW_MS = 10 * 60 * 1000;

// An UNANSWERED call (the caller's outgoing ring) that is left detached gets
// this long to be answered before the keeper ends it. Only an answered call is
// worth keeping alive without a UI: the ring timeout that would normally give up
// lives in the provider, so without this bound, swiping the app away mid-dial
// would leave the app ringing a callee who never picks up, forever, behind a
// notification. Comfortably longer than the server's ~30-45s ring window, so in
// practice the server's own timeout ends the call first and this never fires.
const DETACHED_RING_GUARD_MS = 90 * 1000;

let snapshot = null;        // last LIVE call state published by the provider
let terminatedAt = 0;       // when the detached session went terminal (0 = live)
let handler = null;         // mounted provider's engine-event handler
let buffered = [];          // engine events received while detached
let wired = false;          // module-level listeners installed
let ringGuard = null;       // bounds an unanswered call left with no UI

const clearRingGuard = () => {
  if (ringGuard) { clearTimeout(ringGuard); ringGuard = null; }
};

const isLive = (s) => !!s
  && s.status !== CALL_STATUS.IDLE
  && s.status !== CALL_STATUS.ENDED;

// The session a mounting provider may adopt, or null. A LIVE session always
// qualifies. A session that went terminal while detached qualifies only while we
// still hold the `ended` event that will finalize it (log, end screen, reset) —
// restoring one without that would resurrect a dead call as an active one, with
// nothing left to end it. Bounded in time either way, so a call that finished
// long ago never reappears when the app is finally re-opened.
const restorableSession = () => {
  if (!snapshot) return null;
  if (!terminatedAt) return snapshot;
  if (Date.now() - terminatedAt > TERMINAL_REPLAY_WINDOW_MS) return null;
  return buffered.some(([type]) => type === EVT.ENDED) ? snapshot : null;
};

const clearSession = () => {
  clearRingGuard();
  snapshot = null;
  terminatedAt = 0;
  buffered = [];
};

// The call is over and no UI is mounted to notice. Release everything the OS
// still holds on the call's behalf. The engine has already run its own teardown
// (NativeCallEngine._teardownCallState → AudioRoute.stop) by the time it posts
// ENDED, so this only has to clear the persistent notification + foreground
// service and drop the native "a call is active" flag.
const releaseDetachedCall = () => {
  clearRingGuard();
  terminatedAt = Date.now();
  try { stopOngoingCallNotification(); } catch (_) { /* */ }
  try { setCallActiveNative(false); } catch (_) { /* */ }
};

// Hang up tapped on the ongoing-call notification while no provider is mounted.
// CallActionReceiver has already stopped the foreground service natively; what
// is left is the part that lives in JS — actually ending the media (otherwise
// the mic stays hot and the peer keeps hearing a room nobody is in) and telling
// the backend, so the other side does not sit on a dead call waiting for the
// server's disconnect grace.
const hangupDetached = () => {
  const snap = snapshot;
  try { nativeEngine.cmd({ cmd: CMD.HANGUP }); } catch (_) { /* */ }
  if (snap) {
    const otherUserIds = (snap.peers || [])
      .map((p) => (p && p.id ? String(p.id) : null))
      .filter(Boolean);
    try {
      endCallSignal({ callId: snap.signalId || snap.callId, otherUserIds });
    } catch (_) { /* best-effort — the server's disconnect grace is the backstop */ }
  }
  releaseDetachedCall();
  // WE ended this call, and a local CMD.HANGUP posts no `ended` event — so there
  // is nothing left to replay and nothing to restore. Drop the session outright:
  // keeping it would have the next mount rehydrate a call that is already dead,
  // leaving the app stuck "in" a call the server has long since closed.
  clearSession();
};

const onEngineEvent = (type, payload) => {
  if (handler) {
    // Normal path: a provider is mounted, hand the event straight over.
    try { handler(type, payload); } catch (_) { /* */ }
    return;
  }
  if (buffered.length >= MAX_BUFFERED_EVENTS) buffered.shift();
  buffered.push([type, payload]);
  // Remote media arrived while detached — the call is up, so the unanswered-ring
  // bound no longer applies (the snapshot still says "ringing": there is no
  // mounted provider to publish a fresher one).
  if (type === EVT.STREAM) clearRingGuard();
  if (type === EVT.ENDED) releaseDetachedCall();
};

// Installed ONCE, never removed — that permanence is the whole point. Scoped to
// the native engine: on the (rolled-back) WebView engine the media dies with the
// WebView, so there is no session to keep and nothing here should act.
const wire = () => {
  if (wired || !isNativeCallEngine()) return;
  wired = true;
  nativeEngine.subscribe(onEngineEvent);
  // Notification actions are emitted by callNotifee's native onCallAction
  // bridge. While a provider is mounted it owns these (its own listeners run
  // too), so act only when detached.
  DeviceEventEmitter.addListener(CALL_PUSH_EVENTS.HANGUP, () => {
    if (handler || !snapshot) return;
    hangupDetached();
  });
};

/**
 * Publish the provider's current state. Called on every state change so the
 * snapshot left behind by an unmount is always the last committed one.
 */
export const publish = (state) => {
  wire();
  if (!wired) return; // WebView engine — no session can outlive the UI
  if (isLive(state)) {
    snapshot = { ...state };
    terminatedAt = 0;
  } else {
    // A call that ended with the UI mounted was fully handled there.
    clearSession();
  }
};

/**
 * Mount-time hand-off: route engine events to the newly mounted provider, and
 * hand back the ones that arrived while nothing was mounted, for it to replay.
 * The session state itself is read separately by peekSession() — the provider
 * needs it during render, before this effect runs.
 */
export const attach = (fn) => {
  wire();
  clearRingGuard();
  const adopted = restorableSession();
  handler = fn;
  if (!adopted) {
    // Nothing worth restoring — drop the session rather than replaying history
    // for a call the provider did not (and will not) adopt.
    clearSession();
    return [];
  }
  const events = buffered;
  buffered = [];
  return events;
};

/** Unmount-time hand-back: the keeper owns the session again. */
export const detach = () => {
  handler = null;
  clearRingGuard();
  // Only an ANSWERED call is worth keeping alive with no UI — see the constant.
  if (snapshot && !terminatedAt && !snapshot.answeredAt) {
    ringGuard = setTimeout(() => { ringGuard = null; hangupDetached(); }, DETACHED_RING_GUARD_MS);
  }
};

/**
 * Read the session without attaching — for the provider's reducer initializer,
 * so the very first render already has the live call (and stateRef with it).
 */
export const peekSession = () => restorableSession();
