/**
 * Expo config plugin: stop react-native-callkeep from failing to load on Android
 * under the New Architecture.
 *
 * THE BUG (react-native-callkeep 4.3.16, RN 0.81.5, newArchEnabled=true):
 *
 *   TurboModuleInteropUtils$ParsingException: Unable to parse @ReactMethod
 *   annotations from native module: RNCallKeep. Details: Module exports two
 *   methods to JavaScript with the same name: "displayIncomingCall
 *
 * The new-arch interop layer builds one JS method per @ReactMethod NAME, so it
 * rejects Java overloads. RNCallKeepModule annotates BOTH the 3-arg and the
 * 4-arg overloads of `displayIncomingCall` and `startCall`. When the parse
 * throws, `require('react-native-callkeep')` fails, so nativeCallService falls
 * back to null and the native call UI is lost.
 *
 * THE FIX: remove @ReactMethod from the 3-arg overloads. The library's own
 * Android JS (index.js) only ever calls the 4-arg forms
 * (uuid, handle, name, hasVideo), so nothing that JS can reach is removed.
 *
 * WHY PATCH node_modules: the conflict is in the library's Java source, which is
 * compiled straight out of node_modules. It is idempotent and safe to run
 * repeatedly. NOTE: `npm install` restores the pristine file, so re-run
 * `node plugins/withCallKeepAndroidInteropFix.js` after reinstalling
 * dependencies, then rebuild the Android app.
 */
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MODULE_REL = path.join(
  'node_modules',
  'react-native-callkeep',
  'android',
  'src',
  'main',
  'java',
  'io',
  'wazo',
  'callkeep',
  'RNCallKeepModule.java',
);

const PATCH_MARKER = 'patched by plugins/withCallKeepAndroidInteropFix.js';

const INCOMING_FROM = `    @ReactMethod
    public void displayIncomingCall(String uuid, String number, String callerName) {`;

const INCOMING_TO = `    // ${PATCH_MARKER}: not a @ReactMethod — the new-arch interop rejects
    // overloaded names; JS only calls the 4-arg form.
    public void displayIncomingCall(String uuid, String number, String callerName) {`;

const START_FROM = `    @ReactMethod
    public void startCall(String uuid, String number, String callerName) {`;

const START_TO = `    // ${PATCH_MARKER}: not a @ReactMethod — the new-arch interop rejects
    // overloaded names; JS only calls the 4-arg form.
    public void startCall(String uuid, String number, String callerName) {`;

const REPLACEMENTS = [
  ['displayIncomingCall overload', INCOMING_FROM, INCOMING_TO],
  ['startCall overload', START_FROM, START_TO],
];

// ── iOS: RNCallKeep.m ──────────────────────────────────────────────────────
// The AppDelegate now creates RNCallKeep on a VoIP push BEFORE React Native is
// up (so CallKit has a delegate and an early Answer is not dropped — see
// AppDelegate.swift). Its init registers an AVAudioSession route-change
// observer that calls sendEventWithName: DIRECTLY; with no JS attached yet that
// throws "RCTCallableJSModules is not set" and kills the app mid-ring
// (reproduced 2026-09-24: "provider crashed", ring gone / call auto-ended).
// A route event before JS listens is meaningless — drop it.
const IOS_MODULE_REL = path.join(
  'node_modules', 'react-native-callkeep', 'ios', 'RNCallKeep', 'RNCallKeep.m',
);
const IOS_ROUTE_FROM = `    if (output == nil) {
        return;
    }

    [self sendEventWithName:RNCallKeepDidChangeAudioRoute body:@{`;
const IOS_ROUTE_TO = `    if (output == nil) {
        return;
    }
    // ${PATCH_MARKER}: no JS listener yet (VoIP-woken app) → sending would throw.
    if (!_hasListeners) {
        return;
    }

    [self sendEventWithName:RNCallKeepDidChangeAudioRoute body:@{`;

// performAnswerCallAction ran configureAudioSession, which ends with
// setActive:TRUE. Apple: never activate the session yourself in a CallKit
// action — CallKit activates it (didActivateAudioSession). From a locked /
// background app the self-activation is refused ('!pri') and audiomxd
// interrupts our session ("Stop Now"); on 2026-09-24 22:22 CallKit's own
// activation then came 8s late and the call was silent. Set the category
// only; didActivateAudioSession still runs the full configureAudioSession.
const IOS_ANSWER_FROM = `    [self configureAudioSession];
    [self sendEventWithNameWrapper:RNCallKeepPerformAnswerCallAction body:`;
const IOS_ANSWER_TO = `    // ${PATCH_MARKER}: category only — never setActive here; CallKit activates
    // the session itself and didActivateAudioSession configures it fully.
    [[AVAudioSession sharedInstance] setCategory:AVAudioSessionCategoryPlayAndRecord withOptions:AVAudioSessionCategoryOptionAllowBluetooth error:nil];
    [self sendEventWithNameWrapper:RNCallKeepPerformAnswerCallAction body:`;

const IOS_REPLACEMENTS = [
  ['route event guard', IOS_ROUTE_FROM, IOS_ROUTE_TO],
  ['answer without setActive', IOS_ANSWER_FROM, IOS_ANSWER_TO],
];

function patchCallKeepIos(projectRoot) {
  const target = path.join(projectRoot, IOS_MODULE_REL);
  if (!fs.existsSync(target)) {
    console.warn(`[withCallKeepAndroidInteropFix] not found, skipping: ${IOS_MODULE_REL}`);
    return false;
  }
  const original = fs.readFileSync(target, 'utf8');
  let patched = original;
  const applied = [];
  IOS_REPLACEMENTS.forEach(([label, from, to]) => {
    if (patched.includes(to)) return;
    if (!patched.includes(from)) {
      console.warn(`[withCallKeepAndroidInteropFix] iOS anchor not found (${label}) — RNCallKeep.m `
        + 'changed; re-check it before shipping.');
      return;
    }
    patched = patched.replace(from, to);
    applied.push(label);
  });
  if (patched === original) return false;
  fs.writeFileSync(target, patched);
  console.log(`[withCallKeepAndroidInteropFix] patched RNCallKeep.m (${applied.join(', ')})`);
  return true;
}

function patchCallKeepModule(projectRoot) {
  const target = path.join(projectRoot, MODULE_REL);

  if (!fs.existsSync(target)) {
    console.warn(`[withCallKeepAndroidInteropFix] not found, skipping: ${MODULE_REL}`);
    return false;
  }

  const original = fs.readFileSync(target, 'utf8');

  let patched = original;
  const applied = [];
  const missing = [];
  REPLACEMENTS.forEach(([label, from, to]) => {
    if (patched.includes(to)) return;
    if (!patched.includes(from)) {
      missing.push(label);
      return;
    }
    patched = patched.replace(from, to);
    applied.push(label);
  });

  if (missing.length) {
    console.warn(
      `[withCallKeepAndroidInteropFix] anchor(s) not found: ${missing.join(', ')} — ` +
        'react-native-callkeep source changed; re-check RNCallKeepModule.java for ' +
        'overloaded @ReactMethod names before shipping.',
    );
  }

  if (patched === original) return false;

  fs.writeFileSync(target, patched);
  console.log(
    `[withCallKeepAndroidInteropFix] patched RNCallKeepModule.java (${applied.join(', ')})`,
  );
  return true;
}

const withCallKeepAndroidInteropFix = (config) => {
  const withAndroid = withDangerousMod(config, [
    'android',
    (cfg) => {
      patchCallKeepModule(cfg.modRequest.projectRoot);
      return cfg;
    },
  ]);
  return withDangerousMod(withAndroid, [
    'ios',
    (cfg) => {
      patchCallKeepIos(cfg.modRequest.projectRoot);
      return cfg;
    },
  ]);
};

module.exports = withCallKeepAndroidInteropFix;
module.exports.patchCallKeepModule = patchCallKeepModule;
module.exports.patchCallKeepIos = patchCallKeepIos;

// Allow re-applying after `npm install` without a full prebuild:
//   node plugins/withCallKeepAndroidInteropFix.js
if (require.main === module) {
  patchCallKeepModule(path.join(__dirname, '..'));
  patchCallKeepIos(path.join(__dirname, '..'));
}
