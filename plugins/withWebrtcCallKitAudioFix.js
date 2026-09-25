/**
 * Expo config plugin: let JS drive WebRTC's "manual audio" mode on iOS, so the
 * call's audio unit starts only once CallKit has handed us the audio session.
 *
 * THE BUG (reproduced 2026-09-24 22:22 from the iPhone's unified log): iPhone
 * locked for a long time, app killed, call answered on the lock screen → the
 * CallKit timer ran but the call was SILENT BOTH WAYS for its whole length.
 *   - answer at +0s; WebRTC's AURemoteIO was created at +1.5s and stopped
 *     immediately (no CallKit-activated session yet — the app is locked);
 *   - CallKit's didActivateAudioSession arrived only at +8s;
 *   - the audio unit was never started again. In react-native-webrtc's default
 *     (non-manual) mode `audioSessionDidActivate` only bumps the session's
 *     activation count — nothing restarts an audio unit that already failed.
 *
 * THE FIX: react-native-webrtc exports no way to reach RTCAudioSession's
 * `useManualAudio` / `isAudioEnabled`, the switch WebRTC provides for exactly
 * this CallKit case (the audio unit stays uninitialised until audio is enabled,
 * and every disabled→enabled edge (re)initialises + starts it). This adds two
 * synchronous methods to WebRTCModule; src/calls/native-engine/webrtcGlobals.js
 * drives them from the CallKit activation events.
 *
 * WHY PATCH node_modules: the module is compiled straight out of node_modules.
 * Idempotent. `npm install` restores the pristine file — the package.json
 * postinstall re-runs `node plugins/withWebrtcCallKitAudioFix.js`. JS feature-
 * detects the methods, so an unpatched build simply keeps the old behaviour.
 */
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MODULE_REL = path.join(
  'node_modules', 'react-native-webrtc', 'ios', 'RCTWebRTC', 'WebRTCModule+RTCAudioSession.m',
);

const PATCH_MARKER = 'patched by plugins/withWebrtcCallKitAudioFix.js';

const ANCHOR = `RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(audioSessionDidDeactivate) {
    [[RTCAudioSession sharedInstance] audioSessionDidDeactivate:[AVAudioSession sharedInstance]];
    return nil;
}
`;

const ADDITION = `${ANCHOR}
// ${PATCH_MARKER}: CallKit-driven manual audio.
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(setManualAudio : (BOOL)manual) {
    [RTCAudioSession sharedInstance].useManualAudio = manual;
    return nil;
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(setAudioEnabled : (BOOL)enabled) {
    [RTCAudioSession sharedInstance].isAudioEnabled = enabled;
    return nil;
}
`;

function patchWebrtcAudioSession(projectRoot) {
  const target = path.join(projectRoot, MODULE_REL);
  if (!fs.existsSync(target)) {
    console.warn(`[withWebrtcCallKitAudioFix] not found, skipping: ${MODULE_REL}`);
    return false;
  }
  const original = fs.readFileSync(target, 'utf8');
  if (original.includes(PATCH_MARKER)) return false;
  if (!original.includes(ANCHOR)) {
    console.warn('[withWebrtcCallKitAudioFix] anchor not found — react-native-webrtc changed; '
      + 're-check WebRTCModule+RTCAudioSession.m before shipping.');
    return false;
  }
  fs.writeFileSync(target, original.replace(ANCHOR, ADDITION));
  console.log('[withWebrtcCallKitAudioFix] patched WebRTCModule+RTCAudioSession.m (manual audio)');
  return true;
}

const withWebrtcCallKitAudioFix = (config) => withDangerousMod(config, [
  'ios',
  (cfg) => {
    patchWebrtcAudioSession(cfg.modRequest.projectRoot);
    return cfg;
  },
]);

module.exports = withWebrtcCallKitAudioFix;
module.exports.patchWebrtcAudioSession = patchWebrtcAudioSession;

// Re-apply after `npm install` without a prebuild:
//   node plugins/withWebrtcCallKitAudioFix.js
if (require.main === module) {
  patchWebrtcAudioSession(path.join(__dirname, '..'));
}
