import { NativeModules, Platform } from 'react-native';
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

// ---- CallKit-driven manual audio (iOS) ----
// 2026-09-24 22:22 (iPhone unified log): killed + locked app, answered on the
// lock screen, silent BOTH ways for the whole call. WebRTC's audio unit started
// 1.5s after the answer, before CallKit had activated the session, failed, and
// was never started again; CallKit's activation came 8s late. In default mode
// audioSessionDidActivate can't restart a failed unit.
// Manual audio keeps the unit uninitialised until `isAudioEnabled`, and every
// disabled→enabled edge (re)initialises and starts it. So: enabled only while
// CallKit's session is live, re-edged on each activation. Needs the native
// methods added by plugins/withWebrtcCallKitAudioFix.js — feature-detected, so
// an unpatched build keeps the old behaviour.
const manualAudio = { on: false, enabled: false, callKitActive: false };

const webrtcNative = () => {
  if (Platform.OS !== 'ios') return null;
  const m = NativeModules.WebRTCModule;
  return m && typeof m.setManualAudio === 'function' && typeof m.setAudioEnabled === 'function' ? m : null;
};

const setAudioEnabled = (m, enabled) => {
  try { m.setAudioEnabled(!!enabled); manualAudio.enabled = !!enabled; return true; } catch (_) { return false; }
};

/** Switch WebRTC to CallKit-driven manual audio. Call once, before any call's media is built. */
export const enableCallKitManualAudio = () => {
  if (manualAudio.on) return true;
  const m = webrtcNative();
  if (!m) return false;
  try { m.setManualAudio(true); } catch (_) { return false; }
  manualAudio.on = true;
  // An activation that landed before this (cold-start replay) must not be lost.
  setAudioEnabled(m, manualAudio.callKitActive);
  return true;
};

/** CallKit activated the session: (re)start the audio unit against it. */
export const manualAudioActivated = () => {
  manualAudio.callKitActive = true;
  const m = manualAudio.on && webrtcNative();
  if (!m) return false;
  // Always a fresh disabled→enabled edge: a unit that started (and failed)
  // before this activation is torn down and rebuilt on the live session.
  setAudioEnabled(m, false);
  return setAudioEnabled(m, true);
};

/** CallKit released the session: park the audio unit until the next activation. */
export const manualAudioDeactivated = () => {
  manualAudio.callKitActive = false;
  const m = manualAudio.on && webrtcNative();
  if (m) setAudioEnabled(m, false);
};

/**
 * Safety net for a connected call that never got a CallKit activation (e.g. an
 * outgoing call CallKit didn't activate): enable anyway so it can't stay silent.
 * A later activation still re-edges it. No-op when already enabled.
 */
export const ensureManualAudioEnabled = () => {
  const m = manualAudio.on && webrtcNative();
  if (!m || manualAudio.enabled) return false;
  return setAudioEnabled(m, true);
};

/** Call over without a CallKit deactivation: back to "enabled only while CallKit is live". */
export const resetManualAudio = () => {
  const m = manualAudio.on && webrtcNative();
  if (m && manualAudio.enabled !== manualAudio.callKitActive) setAudioEnabled(m, manualAudio.callKitActive);
};
