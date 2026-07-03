import { Platform } from 'react-native';

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

// Lightweight RFC4122-v4 UUID (not crypto-grade; only needs to be unique per
// call for CallKeep bookkeeping). Avoids pulling in a uuid dependency.
const uuidv4 = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  // Derive pseudo-randomness from time + a counter so we don't use Math.random
  // in a way that breaks (it's fine here, but keep it cheap and unique-enough).
  const r = (Date.now() + Math.floor(Math.random() * 1e6)) % 16;
  const v = c === 'x' ? r : (r % 4) + 8;
  return v.toString(16);
});

// MASTER SWITCH for the in-app CallKit integration (incoming CallKit screen +
// answer/end/mute listeners + active-call reporting). ON: required for the iOS
// killed/locked full-screen native call screen — a VoIP (PushKit) push has the
// AppDelegate report the call to CallKit natively, and this JS side then handles
// the user's Answer/End on that screen and connects the WebRTC call.
//
// Requires a PHYSICAL iPhone + a dev/EAS build (never Expo Go / simulator) AND the
// backend actually sending the APNs VoIP push — without that push the CallKit
// screen never appears (the AppDelegate path stays inert).
const IOS_CALLKIT_ENABLED = true;

// CallKit is scoped to the INCOMING ring only. We deliberately do NOT report
// OUTGOING calls to CallKit: RNCallKeep.startCall files a CXStartCallAction that
// iOS expects the app to fulfil by reporting the outgoing call's
// startedConnecting/connectedAt lifecycle. This app runs calls on WebRTC, not
// CallKit's lifecycle, so that action was never fulfilled — iOS then timed it out
// and fired `endCall`, tearing down the live WebRTC call "after ~2 rings" (the
// regression that had CallKit disabled). The caller is never on a locked screen
// needing the native UI, so the in-app CallOverlay is the right (and only) caller
// UI; leaving CallKit out of the outgoing path removes the drop entirely.
const REPORT_OUTGOING_TO_CALLKIT = false;

// iOS-ONLY even when enabled. Android keeps its own incoming UI (expo-call-ui
// CallStyle) + the active-call foreground service, so we must NOT let
// react-native-callkeep's Android ConnectionService UI activate and double up.
export const isAvailable = () => IOS_CALLKIT_ENABLED && !!RNCallKeep && Platform.OS === 'ios';

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
  // Intentionally NOT reported to CallKit — see REPORT_OUTGOING_TO_CALLKIT above
  // (unfulfilled CXStartCallAction → CallKit ends the WebRTC call mid-connect).
  if (!isAvailable() || !REPORT_OUTGOING_TO_CALLKIT) return;
  try {
    RNCallKeep.startCall(uuidForCall(callId), String(handle || name || 'call'), name || 'Call', 'generic', !!hasVideo);
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
 *   onAnswer(callId), onEnd(callId), onToggleMute(callId, muted)
 * Returns an unsubscribe function. Safe no-op when the native module is absent.
 */
export const registerEvents = (handlers = {}) => {
  if (!isAvailable()) return () => {};
  const answer = ({ callUUID }) => handlers.onAnswer && handlers.onAnswer(callIdForUuid(callUUID));
  const end = ({ callUUID }) => handlers.onEnd && handlers.onEnd(callIdForUuid(callUUID));
  const mute = ({ callUUID, muted }) => handlers.onToggleMute && handlers.onToggleMute(callIdForUuid(callUUID), muted);
  try {
    RNCallKeep.addEventListener('answerCall', answer);
    RNCallKeep.addEventListener('endCall', end);
    RNCallKeep.addEventListener('didPerformSetMutedCallAction', mute);
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
  setCurrentCallActive,
  setMuted,
  endCall,
  registerEvents,
};
