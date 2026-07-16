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

export const isNativeCallEngine = () => CALL_NATIVE_ENGINE_IOS && Platform.OS === 'ios';
