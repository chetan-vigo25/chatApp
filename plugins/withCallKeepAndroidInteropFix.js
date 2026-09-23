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

const withCallKeepAndroidInteropFix = (config) =>
  withDangerousMod(config, [
    'android',
    (cfg) => {
      patchCallKeepModule(cfg.modRequest.projectRoot);
      return cfg;
    },
  ]);

module.exports = withCallKeepAndroidInteropFix;
module.exports.patchCallKeepModule = patchCallKeepModule;

// Allow re-applying after `npm install` without a full prebuild:
//   node plugins/withCallKeepAndroidInteropFix.js
if (require.main === module) {
  patchCallKeepModule(path.join(__dirname, '..'));
}
