/**
* Expo config plugin: wire iOS VoIP (PushKit) + CallKit so an incoming call
* shows the native iPhone call screen in foreground, background, terminated, and
* locked — like WhatsApp/Telegram/Messenger.
*
* `ios/` is git-ignored (Continuous Native Generation), so the native AppDelegate
* + entitlement changes MUST live in a config plugin to survive
* `expo prebuild` / EAS builds.
*
* This plugin:
*   1. Adds the `aps-environment` entitlement (required to receive APNs/PushKit).
*   2. Ensures UIBackgroundModes has `voip` + `audio` (already set in app.json,
*      re-asserted here so the plugin is self-contained).
*   3. Patches AppDelegate.swift to:
*        - register for VoIP pushes (RNVoipPushNotificationManager.voipRegistration)
*        - implement the PKPushRegistryDelegate methods. On an incoming VoIP push
*          it reports the call to CallKit SYNCHRONOUSLY via RNCallKeep — iOS 13+
*          terminates the app (and throttles future pushes) if a VoIP push does
*          not report a call in the same run loop — then forwards the push to JS.
*
* Companion JS lives in:
*   - src/calls/services/nativeCallService.js  (CallKit UI via react-native-callkeep)
*   - src/calls/services/voipPushService.js    (token registration + push→ring)
*
* Requires a dev/EAS build (react-native-callkeep + react-native-voip-push-
* notification are native modules — they do nothing in Expo Go).
*
* NOTE: the AppDelegate Swift below calls into two Objective-C pods. Under
* `useFrameworks: "static"` they import as modules. If a clean Xcode build can't
* resolve `RNCallKeep` / `RNVoipPushNotification` or a bridged selector name,
* adjust the import lines / call sites — the logic is otherwise complete.
*/
const {
  withEntitlementsPlist,
  withInfoPlist,
  withAppDelegate,
  withXcodeProject,
} = require('@expo/config-plugins');

// The `aps-environment` entitlement MUST match the APNs environment the build
// actually talks to, or push/VoIP tokens fail with BadDeviceToken:
//   - App Store / TestFlight archive (Release) → 'production' (api.push.apple.com)
//   - local run / dev testing (Debug)          → 'development' (sandbox)
//
// This project is built by ARCHIVING IN XCODE (not EAS), and Debug + Release
// share ONE entitlements file — so we can't pick a value at prebuild time. Instead
// the entitlement value is the Xcode build-setting variable `$(APS_ENVIRONMENT)`,
// and we set that variable PER BUILD CONFIGURATION on the app target below. Result:
// a plain Xcode "Archive" (Release) automatically ships `production`, while a
// local Debug run stays `development` — zero manual toggling, no way to
// accidentally ship a sandbox build to the App Store.
const APS_ENVIRONMENT_BY_CONFIG = { Debug: 'development', Release: 'production' };

// ---- 1a. entitlement → resolve from the build-setting variable ----
const withApsEntitlement = (config) =>
  withEntitlementsPlist(config, (cfg) => {
    cfg.modResults['aps-environment'] = '$(APS_ENVIRONMENT)';
    return cfg;
  });

// ---- 1b. define APS_ENVIRONMENT per configuration on the app target only ----
const withApsBuildSetting = (config) =>
  withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const buildConfigs = project.pbxXCBuildConfigurationSection();
    Object.keys(buildConfigs).forEach((key) => {
      const bc = buildConfigs[key];
      if (!bc || typeof bc !== 'object' || !bc.buildSettings) return;
      const ent = bc.buildSettings.CODE_SIGN_ENTITLEMENTS;
      // Identify the MAIN APP target by its entitlements path — skip the
      // NotificationServiceExtension and Pods targets (they must not get this).
      // NOTE: match by the ".entitlements" suffix (excluding the extension) rather
      // than a hard-coded app name — the app has been renamed before (VibeConnect →
      // TalksTry) and a name-specific check silently stopped setting APS_ENVIRONMENT,
      // which shipped an EMPTY aps-environment entitlement and killed APNs/VoIP
      // registration ("no valid aps-environment entitlement string found").
      if (
        ent &&
        String(ent).endsWith('.entitlements') &&
        !String(ent).includes('NotificationServiceExtension')
      ) {
        bc.buildSettings.APS_ENVIRONMENT = APS_ENVIRONMENT_BY_CONFIG[bc.name] || 'development';
      }
    });
    return cfg;
  });
 
// ---- 2. background modes ----
const withVoipBackgroundModes = (config) =>
  withInfoPlist(config, (cfg) => {
    const modes = new Set(cfg.modResults.UIBackgroundModes || []);
    modes.add('voip');
    modes.add('audio');
    modes.add('remote-notification');
    cfg.modResults.UIBackgroundModes = Array.from(modes);
    return cfg;
  });
 
// ---- 3. AppDelegate.swift ----
const IMPORTS = `import PushKit
import RNCallKeep
import RNVoipPushNotification`;
 
const REGISTER_CALL = '    RNVoipPushNotificationManager.voipRegistration()';
 
// NOTE: no manual @objc(...) selector annotations here. AppDelegate is declared
// to conform to PKPushRegistryDelegate (see step d below), so Swift emits these
// protocol methods with the exact ObjC selectors PushKit calls. The earlier
// hand-written @objc(...) annotations on methods taking the Swift `PKPushType`
// struct failed to register, so PushKit hit doesNotRecognizeSelector → SIGABRT.
const PUSHKIT_METHODS = `
  // MARK: - PushKit (VoIP) — added by withIosVoip config plugin

  // UUIDs already reported to CallKit this process — dedupes an APNs double
  // delivery / backend retry of the SAME call (the backend mints one stable
  // uuid per callId), which would otherwise hit reportNewIncomingCall twice
  // and error inside CallKit. Small ring buffer; process-lifetime only.
  private static var voipReportedUuids: [String] = []

  public func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    RNVoipPushNotificationManager.didUpdate(pushCredentials, forType: type.rawValue)
  }

  public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    // No-op: a new token is delivered via didUpdate when one becomes available.
  }

  public func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
    let dict = payload.dictionaryPayload
    // CallKit requires an RFC4122 UUID — reporting anything else gets the app
    // KILLED by iOS. The backend sends a dedicated 'uuid' field; VALIDATE it
    // (and any callId fallback, which is normally 'sig_..._<ms>' and NOT a
    // UUID) through UUID(uuidString:) so a malformed value can never reach
    // reportNewIncomingCall — worst case we ring under a fresh UUID.
    let uuid = UUID(uuidString: (dict["uuid"] as? String) ?? "")?.uuidString
      ?? UUID(uuidString: (dict["callId"] as? String) ?? "")?.uuidString
      ?? UUID().uuidString
    let callerName = (dict["callerName"] as? String) ?? "Incoming call"
    let hasVideo = ((dict["callType"] as? String) ?? "audio") == "video"

    // Duplicate delivery of a call CallKit is already ringing → complete and
    // bail; a second reportNewIncomingCall on the same UUID only errors. Still
    // forward to JS so its state can reconcile. (A payload with a malformed /
    // missing uuid falls through on a fresh random UUID and is never deduped.)
    if AppDelegate.voipReportedUuids.contains(uuid) {
      RNVoipPushNotificationManager.didReceiveIncomingPush(with: payload, forType: type.rawValue)
      completion()
      return
    }
    AppDelegate.voipReportedUuids.append(uuid)
    if AppDelegate.voipReportedUuids.count > 8 {
      AppDelegate.voipReportedUuids.removeFirst()
    }

    // MUST report to CallKit synchronously here (iOS 13+), or the app is killed.
    // Holding/DTMF are OFF: the WebView engine has no hold or keypad path, so
    // advertising them puts dead buttons on the CallKit screen (and a Hold from
    // the OS would silently break the call's audio session).
    RNCallKeep.reportNewIncomingCall(
      uuid,
      handle: callerName,
      handleType: "generic",
      hasVideo: hasVideo,
      localizedCallerName: callerName,
      supportsHolding: false,
      supportsDTMF: false,
      supportsGrouping: false,
      supportsUngrouping: false,
      fromPushKit: true,
      payload: dict,
      withCompletionHandler: completion
    )
    // Forward to JS so CallProvider can wake the WebRTC engine / reconcile state.
    RNVoipPushNotificationManager.didReceiveIncomingPush(with: payload, forType: type.rawValue)
  }
`;
 
const withVoipAppDelegate = (config) =>
  withAppDelegate(config, (cfg) => {
    let src = cfg.modResults.contents;
 
    // a) imports (idempotent)
    if (!src.includes('import PushKit')) {
      src = src.replace(
        /import ReactAppDependencyProvider\n/,
        `import ReactAppDependencyProvider\n${IMPORTS}\n`,
      );
    }
 
    // a2) Conform AppDelegate to PKPushRegistryDelegate so the delegate methods
    //     below bridge with the correct ObjC selectors (fixes the SIGABRT /
    //     doesNotRecognizeSelector crash on VoIP token registration).
    if (!src.includes('PKPushRegistryDelegate')) {
      src = src.replace(
        /public class AppDelegate: ExpoAppDelegate \{/,
        'public class AppDelegate: ExpoAppDelegate, PKPushRegistryDelegate {',
      );
    }
 
    // b) VoIP registration inside didFinishLaunchingWithOptions
    if (!src.includes('RNVoipPushNotificationManager.voipRegistration()')) {
      src = src.replace(
        /(\n\s*return super\.application\(application, didFinishLaunchingWithOptions: launchOptions\))/,
        `\n${REGISTER_CALL}\n$1`,
      );
    }
 
    // c) PKPushRegistryDelegate methods — insert before the AppDelegate class
    //    closing brace (immediately preceding `class ReactNativeDelegate`).
    if (!src.includes('didReceiveIncomingPushWith payload')) {
      src = src.replace(
        /\n}\n\nclass ReactNativeDelegate/,
        `\n${PUSHKIT_METHODS}}\n\nclass ReactNativeDelegate`,
      );
    }
 
    cfg.modResults.contents = src;
    return cfg;
  });
 
module.exports = (config) =>
  withVoipAppDelegate(
    withVoipBackgroundModes(withApsBuildSetting(withApsEntitlement(config))),
  );