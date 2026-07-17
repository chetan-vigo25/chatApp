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
export const CALL_NATIVE_ENGINE_ANDROID = false;

export const isNativeCallEngine = () => (
  (CALL_NATIVE_ENGINE_IOS && Platform.OS === 'ios')
  || (CALL_NATIVE_ENGINE_ANDROID && Platform.OS === 'android')
);
