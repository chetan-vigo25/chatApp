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

// MASTER SWITCH for the in-app CallKit call-flow integration (outgoing/active/end
// + the answer/end event listeners). Currently OFF: wiring CallKit into the live
// call flow let CallKit's `endCall` (fired during the connecting phase) terminate
// the WebRTC call right after the callee answered — a call dropping "after ~2
// rings". With this off, calls run on the proven WebRTC path exactly as before.
//
// NOTE: this does NOT disable the PushKit→CallKit incoming path in AppDelegate
// (that only acts on a real VoIP push, which the backend isn't sending yet, so
// it stays inert). Flip to true to re-enable + debug CallKit on a PHYSICAL device.
const IOS_CALLKIT_ENABLED = false;

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
  if (!isAvailable()) return;
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
  displayIncomingCall,
  startOutgoingCall,
  setCurrentCallActive,
  setMuted,
  endCall,
  registerEvents,
};
