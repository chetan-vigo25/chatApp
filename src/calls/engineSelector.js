import { Platform } from 'react-native';

/**
 * Call-engine selector — the migration kill-switch.
 *
 * false (default): the proven WebView engine runs everywhere. ZERO behavior
 *                  change; the native-engine module is never even required.
 * true:            iOS routes CMD/EVT through src/calls/native-engine/
 *                  (react-native-webrtc + mediasoup-client, no WebView).
 *
 * iOS-ONLY by design: Android stays on its current known-good path until the
 * iOS rollout soaks (see docs/native-call-migration/PHASE_2_ARCHITECTURE.md §7).
 * Flipping this is the ENTIRE rollback story — both engines implement the same
 * protocol.js surface, and this constant ships in the JS bundle (OTA-able).
 */
export const CALL_NATIVE_ENGINE_IOS = true;

// Android on the native engine (react-native-webrtc). OFF by default — Android
// stays on the proven WebView engine until this is deliberately flipped. What
// flipping gains on Android: real SCREEN SHARE (Android System WebView has no
// getDisplayMedia, so the WebView engine can never share; react-native-webrtc
// captures natively via MediaProjection + its bundled foreground service —
// needs the FOREGROUND_SERVICE_MEDIA_PROJECTION permission already added to
// app.json, i.e. a prebuild). Same protocol.js surface — flipping back is the
// entire rollback story, OTA-able.
//
// FLIPPED ON for the EARPIECE bug: on the WebView engine an Android call can
// only ever play on the LOUDSPEAKER. The System WebView renders WebRTC audio on
// the MEDIA path (USAGE_MEDIA), which does not follow the call audio route —
// InCallManager's MODE_IN_COMMUNICATION + setSpeakerphoneOn(false) has no effect
// on it, and the engine's setSinkId fallback finds no earpiece device to select
// in a WebView (enumerateDevices returns 'default' only), so it lands back on
// the loudspeaker. Proven on device: the in-call Speaker button moved nothing,
// in BOTH directions. react-native-webrtc plays call audio through the voice
// path instead, so AudioRoute finally governs it — the same migration that
// fixed iOS (see iOS_CALL_AUDIO_ISSUE_SUMMARY.md). Both native deps are already
// autolinked into the Android build, so this is a JS-only flip.
export const CALL_NATIVE_ENGINE_ANDROID = true;

export const isNativeCallEngine = () => (
  (CALL_NATIVE_ENGINE_IOS && Platform.OS === 'ios')
  || (CALL_NATIVE_ENGINE_ANDROID && Platform.OS === 'android')
);
