import { Platform, NativeModules } from 'react-native';
// Strong RFC4122-v4 UUID via the `uuid` package (backed by the
// react-native-get-random-values polyfill imported at the app root). CallKit
// rejects a malformed uuid, so the previous time-seeded hand-rolled generator
// (weak, collision-prone) is replaced with this. expo-crypto is not installed;
// `uuid` + the crypto polyfill is the strongest option available in the build.
import { v4 as uuidGen } from 'uuid';

/**
 * Native phone-call UI bridge (CallKit on iOS / ConnectionService on Android)
 * via `react-native-callkeep`. This gives a real OS incoming-call screen that
 * rings/answers even when the app is killed, plus correct audio-session routing.
 *
 * IMPORTANT — this module is GATED. `react-native-callkeep` is a native module
 * that requires a fresh dev/EAS build and is OPTIONAL: until it is installed and
 * the app rebuilt, every method here is a safe no-op (`isAvailable()` → false),
 * so the JS bundle keeps working unchanged. See docs/CALLKIT_SETUP.md for the
 * exact install + config steps that switch it on.
 *
 * We lazy-require the package inside try/catch so a missing native module can
 * never crash the bundle or Metro.
 */

let RNCallKeep = null;
try {
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  RNCallKeep = require('react-native-callkeep').default || require('react-native-callkeep');
} catch (_) {
  RNCallKeep = null;
}

let setupDone = false;
// Map our string callId <-> the RFC4122 UUID CallKeep requires.
const idToUuid = {};
const uuidToId = {};
// callIds already registered with CallKit as connected outgoing calls — guards
// against a repeated `stream` event (ICE restart / renegotiation) re-filing
// startCall on a UUID CallKit already knows (which would error).
const outgoingReported = new Set();

// Strong RFC4122-v4 UUID for CallKit bookkeeping. Falls back to a cheap
// hand-rolled generator only if the uuid package/crypto polyfill somehow throws,
// so this never crashes the call flow.
const uuidv4 = () => {
  try { return uuidGen(); } catch (_) {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Date.now() + Math.floor(Math.random() * 1e6)) % 16;
      const v = c === 'x' ? r : (r % 4) + 8;
      return v.toString(16);
    });
  }
};

// MASTER SWITCH for the in-app CallKit integration (incoming CallKit screen +
// answer/end/mute listeners + active-call reporting). ON: required for the iOS
// killed/locked full-screen native call screen — a VoIP (PushKit) push has the
// AppDelegate report the call to CallKit natively, and this JS side then handles
// the user's Answer/End on that screen and connects the WebRTC call.
//
// Requires a PHYSICAL iPhone + a dev/EAS build (never Expo Go / simulator) AND the
// backend actually sending the APNs VoIP push — without that push the CallKit
// screen never appears (the AppDelegate path stays inert).
// ENABLED — 2026-07-06, the user's DELIBERATE, INFORMED choice: they want the
// native iOS full-screen + banner ring (over the lock screen / when the app is
// killed) back, and ACCEPT that answering breaks call audio until the native-WebRTC
// migration lands. KNOWN TRADEOFF (not a bug to "fix" by flipping this): CallKit +
// the WKWebView WebRTC engine fight over the process-global AVAudioSession, so
// answering a CallKit call cuts ALL audio (in + out, voice + video) — expo-av's
// reassertCallAudio canNOT restart WebKit's internal audio unit. The permanent fix
// is CALL_NATIVE_WEBRTC_MIGRATION_PLAN.md (react-native-webrtc owns RTCAudioSession
// and CAN share CallKit's session). Requires the backend to send the iOS VoIP push
// (see CALL_PUSH_BACKEND_SPEC.md). Do NOT "fix the silent audio" by disabling this
// without asking the user — they knowingly picked the native ring over audio.
const IOS_CALLKIT_ENABLED = true;

// CallKit is scoped to the INCOMING ring only. We deliberately do NOT report
// OUTGOING calls to CallKit AT DIAL TIME: RNCallKeep.startCall files a
// CXStartCallAction that iOS expects the app to fulfil by reporting the outgoing
// call's startedConnecting/connectedAt lifecycle. This app runs calls on WebRTC,
// not CallKit's lifecycle, so during the RINGING window that action sat unfulfilled
// — iOS timed it out and fired `endCall`, tearing down the live WebRTC call "after
// ~2 rings" (the regression that had CallKit disabled). So `startOutgoingCall`
// (dial time) stays a no-op.
const REPORT_OUTGOING_TO_CALLKIT = false;

// …but once the caller's call is genuinely CONNECTED (remote media arrived) we DO
// register it with CallKit — see reportOutgoingConnected(). Reporting at
// connect-time (not dial-time) is regression-proof: the ringing window has NO
// CallKit call at all, so there is no CXStartCallAction for iOS to time out and
// kill. We create the call and immediately report it connected in the same tick,
// so it goes straight to the active/ongoing state — giving the caller the same
// green status-bar notch / Dynamic Island ongoing-call indicator as the callee,
// plus lets the caller hang up from the notch/lock screen. iOS only.
const REPORT_OUTGOING_CONNECTED_TO_CALLKIT = true;

// iOS-ONLY even when enabled. Android keeps its own incoming UI (expo-call-ui
// CallStyle) + the active-call foreground service, so we must NOT let
// react-native-callkeep's Android ConnectionService UI activate and double up.
// The lazy `require('react-native-callkeep')` above can SUCCEED (the JS package
// is in node_modules) even when the underlying native pod was never compiled
// into the build — the checked-in ios/ project is stale (APP-1). In that state
// RNCallKeep's methods throw / no-op, but isAvailable() would still return true,
// so CallProvider skips its in-app foreground ring UI and the iOS call shows
// NOTHING. Gate on the actual native module being registered (NativeModules
// .RNCallKeep) so isAvailable() is only true when CallKit can really work — the
// in-app foreground incoming UI is used otherwise.
export const isAvailable = () => IOS_CALLKIT_ENABLED
  && Platform.OS === 'ios'
  && !!RNCallKeep
  && !!NativeModules.RNCallKeep;

export const uuidForCall = (callId) => {
  const key = String(callId || '');
  if (!key) return uuidv4();
  if (!idToUuid[key]) {
    const u = uuidv4();
    idToUuid[key] = u;
    uuidToId[u] = key;
  }
  return idToUuid[key];
};

// Bind our callId to the EXACT CallKit UUID an incoming VoIP push already reported
// with (the AppDelegate calls reportNewIncomingCall using the backend-supplied
// `uuid`). Without this the JS uuid map would mint a DIFFERENT uuid for the same
// call, so endCall(callId) couldn't dismiss the CallKit screen the native side
// put up — it would linger after the call ended. Idempotent; no-op on empty args.
export const registerCallUuid = (callId, uuid) => {
  const key = String(callId || '');
  const u = String(uuid || '');
  if (!key || !u) return;
  idToUuid[key] = u;
  uuidToId[u] = key;
};

const callIdForUuid = (uuid) => uuidToId[String(uuid || '')] || null;

const forget = (callId) => {
  const key = String(callId || '');
  const u = idToUuid[key];
  if (u) { delete uuidToId[u]; }
  delete idToUuid[key];
  outgoingReported.delete(key);
};

export const setup = async () => {
  if (!isAvailable() || setupDone) return isAvailable();
  try {
    await RNCallKeep.setup({
      ios: {
        appName: 'BaatCheet',
        supportsVideo: true,
        maximumCallGroups: '1',
        maximumCallsPerCallGroup: '4',
      },
      android: {
        alertTitle: 'Permissions required',
        alertDescription: 'BaatCheet needs access to display incoming calls',
        cancelButton: 'Cancel',
        okButton: 'OK',
        foregroundService: {
          channelId: 'calls',
          channelName: 'Calls',
          notificationTitle: 'BaatCheet is running call services',
        },
        // Self-managed connection service (we draw our own in-call UI overlay).
        selfManaged: true,
      },
    });
    RNCallKeep.setAvailable(true);
    setupDone = true;
  } catch (_) {
    setupDone = false;
  }
  return isAvailable();
};

export const displayIncomingCall = (callId, handle, name, hasVideo = false) => {
  if (!isAvailable()) return;
  try {
    RNCallKeep.displayIncomingCall(uuidForCall(callId), String(handle || name || 'call'), name || 'Incoming call', 'generic', !!hasVideo);
  } catch (_) { /* no-op */ }
};

export const startOutgoingCall = (callId, handle, name, hasVideo = false) => {
  // Intentionally NOT reported to CallKit at DIAL time — see
  // REPORT_OUTGOING_TO_CALLKIT above (unfulfilled CXStartCallAction during the ring
  // → CallKit ends the WebRTC call mid-connect). The connected call is registered
  // later via reportOutgoingConnected().
  if (!isAvailable() || !REPORT_OUTGOING_TO_CALLKIT) return;
  try {
    RNCallKeep.startCall(uuidForCall(callId), String(handle || name || 'call'), name || 'Call', 'generic', !!hasVideo);
  } catch (_) { /* no-op */ }
};

/**
 * Register an OUTGOING call with CallKit ONCE IT HAS CONNECTED (remote media
 * arrived). Gives the caller the native ongoing-call presence — green status-bar
 * notch / Dynamic Island indicator, background keep-alive, and hang-up from the
 * lock screen — WITHOUT the dial-time CXStartCallAction-timeout drop, because the
 * whole ringing window had no CallKit call. We create the call and report it
 * connected+active in the same tick so it never sits in an unfulfilled
 * "connecting" state. iOS only; idempotent per callId (startCall on an existing
 * uuid is a no-op on the native side); safe no-op when CallKit is unavailable.
 */
export const reportOutgoingConnected = (callId, handle, name, hasVideo = false) => {
  if (!isAvailable() || !REPORT_OUTGOING_CONNECTED_TO_CALLKIT || Platform.OS !== 'ios') return;
  const key = String(callId || '');
  if (!key || outgoingReported.has(key)) return; // once per call — repeated stream events no-op
  outgoingReported.add(key);
  const uuid = uuidForCall(callId);
  try {
    RNCallKeep.startCall(uuid, String(handle || name || 'call'), name || 'Call', 'generic', !!hasVideo);
    if (typeof RNCallKeep.reportConnectingOutgoingCallWithUUID === 'function') {
      RNCallKeep.reportConnectingOutgoingCallWithUUID(uuid);
    }
    if (typeof RNCallKeep.reportConnectedOutgoingCallWithUUID === 'function') {
      RNCallKeep.reportConnectedOutgoingCallWithUUID(uuid);
    }
    RNCallKeep.setCurrentCallActive(uuid);
  } catch (_) { /* no-op */ }
};

export const setCurrentCallActive = (callId) => {
  if (!isAvailable()) return;
  try { RNCallKeep.setCurrentCallActive(uuidForCall(callId)); } catch (_) { /* no-op */ }
};

export const setMuted = (callId, muted) => {
  if (!isAvailable()) return;
  try { RNCallKeep.setMutedCall(uuidForCall(callId), !!muted); } catch (_) { /* no-op */ }
};

export const endCall = (callId) => {
  if (!isAvailable()) return;
  try { RNCallKeep.endCall(uuidForCall(callId)); } catch (_) { /* no-op */ }
  forget(callId);
};

/**
 * Register the OS-action listeners. `handlers` may include:
 *   onAnswer(callId), onEnd(callId), onToggleMute(callId, muted),
 *   onAudioSessionActivated(), onAudioSessionDeactivated()
 * Returns an unsubscribe function. Safe no-op when the native module is absent.
 */
export const registerEvents = (handlers = {}) => {
  if (!isAvailable()) return () => {};
  const answer = ({ callUUID }) => handlers.onAnswer && handlers.onAnswer(callIdForUuid(callUUID));
  const end = ({ callUUID }) => handlers.onEnd && handlers.onEnd(callIdForUuid(callUUID));
  const mute = ({ callUUID, muted }) => handlers.onToggleMute && handlers.onToggleMute(callIdForUuid(callUUID), muted);
  // CallKit owns the process-global AVAudioSession. When a call is answered from a
  // KILLED/LOCKED state, iOS DEACTIVATES whatever session we set up and activates
  // its OWN, firing `didActivateAudioSession` — the ONLY moment WebRTC audio inside
  // the WKWebView engine can legally start in the background. If we don't re-assert
  // our play-and-record session here, a CallKit-answered call can connect SILENT
  // (no in/out audio) until the app is foregrounded. These events carry no callUUID.
  const audioOn = () => handlers.onAudioSessionActivated && handlers.onAudioSessionActivated();
  const audioOff = () => handlers.onAudioSessionDeactivated && handlers.onAudioSessionDeactivated();
  try {
    RNCallKeep.addEventListener('answerCall', answer);
    RNCallKeep.addEventListener('endCall', end);
    RNCallKeep.addEventListener('didPerformSetMutedCallAction', mute);
    RNCallKeep.addEventListener('didActivateAudioSession', audioOn);
    RNCallKeep.addEventListener('didDeactivateAudioSession', audioOff);
    // Android: the user accepted from the native UI before JS came up.
    if (Platform.OS === 'android') {
      RNCallKeep.addEventListener('showIncomingCallUi', () => {});
    }
  } catch (_) { /* no-op */ }
  return () => {
    try {
      RNCallKeep.removeEventListener('answerCall');
      RNCallKeep.removeEventListener('endCall');
      RNCallKeep.removeEventListener('didPerformSetMutedCallAction');
      RNCallKeep.removeEventListener('didActivateAudioSession');
      RNCallKeep.removeEventListener('didDeactivateAudioSession');
      if (Platform.OS === 'android') RNCallKeep.removeEventListener('showIncomingCallUi');
    } catch (_) { /* no-op */ }
  };
};

export default {
  isAvailable,
  setup,
  uuidForCall,
  registerCallUuid,
  displayIncomingCall,
  startOutgoingCall,
  reportOutgoingConnected,
  setCurrentCallActive,
  setMuted,
  endCall,
  registerEvents,
};