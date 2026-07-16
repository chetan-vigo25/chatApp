/**
 * react-native-webrtc bootstrap for the native call engine.
 *
 * `registerGlobals()` puts RTCPeerConnection / RTCSessionDescription /
 * mediaDevices / MediaStream on `global`, which is what lets mediasoup-client
 * auto-detect its ReactNative (unified-plan) device handler — the same code
 * path the WebView engine exercised via the browser's own globals.
 *
 * Lazy + guarded (same pattern as nativeCallService): the package is a native
 * module, so requiring it in a build whose pods were never compiled must not
 * crash the bundle. `ensureWebrtcGlobals()` returns false in that case and the
 * engine reports a clean connectError instead of throwing.
 */
let registered = false;
let available = null; // null = not probed yet

export const ensureWebrtcGlobals = () => {
  if (registered) return true;
  if (available === false) return false;
  try {
    // eslint-disable-next-line global-require
    const webrtc = require('react-native-webrtc');
    if (!webrtc || typeof webrtc.registerGlobals !== 'function') {
      available = false;
      return false;
    }
    webrtc.registerGlobals();
    registered = true;
    available = true;
    return true;
  } catch (_) {
    available = false;
    return false;
  }
};

// Direct handles for engine modules that prefer explicit imports over globals.
export const getWebrtc = () => {
  if (!ensureWebrtcGlobals()) return null;
  // eslint-disable-next-line global-require
  return require('react-native-webrtc');
};

// ---- CallKit ↔ WebRTC audio-session handshake (iOS) ----
// react-native-webrtc does NOT hook CallKit by itself: when CXProvider
// activates the process AVAudioSession (didActivateAudioSession), WebRTC's
// RTCAudioSession must be told explicitly or its voice-processing audio unit
// keeps running against the pre-CallKit session — every track reads 'live',
// the call shows connected, and there is silence both ways. The reverse call
// at deactivation resets that state so the NEXT call's audio unit starts
// clean. Both are iOS-only no-ops inside react-native-webrtc.
export const audioSessionDidActivate = () => {
  const webrtc = getWebrtc();
  if (!webrtc || !webrtc.RTCAudioSession) return false;
  try { webrtc.RTCAudioSession.audioSessionDidActivate(); return true; } catch (_) { return false; }
};

export const audioSessionDidDeactivate = () => {
  const webrtc = getWebrtc();
  if (!webrtc || !webrtc.RTCAudioSession) return false;
  try { webrtc.RTCAudioSession.audioSessionDidDeactivate(); return true; } catch (_) { return false; }
};
