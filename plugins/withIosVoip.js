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
import RNVoipPushNotification
import Security`;
 
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

  // Signed-in-user marker. JS (src/calls/services/callSessionMarker.js) writes the
  // current user id through expo-secure-store (Keychain, AfterFirstUnlock so it is
  // readable on a locked phone): a user id when signed in, "none" when signed
  // out, absent when never written. NEVER a token. The native layer cannot see JS
  // auth, so this is how a VoIP push for a logged-out / other-account device is
  // recognised (P-C-04). expo-secure-store layout: generic password, service
  // "app:no-auth" (legacy "app"), account and generic attribute = key as Data.
  private static let sessionMarkerKey = "callSessionUserId"
  private static let sessionMarkerSignedOut = "none"
  // Written by pushRegistry(didInvalidatePushTokenFor:), consumed by JS.
  private static let voipInvalidatedKey = "voipTokenInvalidatedAt"

  // Payload types that are NOT a ring. The backend currently sends only rings over
  // VoIP (cancels travel by FCM / socket), but iOS counts EVERY VoIP push, so an
  // unexpected cancel-type push must still be reported to CallKit and ended.
  private static let voipCancelTypes: Set<String> = [
    "call_cancel", "call-cancel", "call_cancelled", "call-cancelled", "cancel",
    "call_ended", "call-ended", "call-missed", "call_missed"
  ]

  private static func keychainQuery(service: String, key: String) -> [String: Any] {
    let keyData = Data(key.utf8)
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrGeneric as String: keyData,
      kSecAttrAccount as String: keyData
    ]
  }

  private static func readKeychainString(key: String) -> String? {
    for service in ["app:no-auth", "app"] {
      var query = keychainQuery(service: service, key: key)
      query[kSecReturnData as String] = true
      query[kSecMatchLimit as String] = kSecMatchLimitOne
      var item: CFTypeRef?
      if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
         let data = item as? Data,
         let value = String(data: data, encoding: .utf8) {
        return value
      }
    }
    return nil
  }

  private static func writeKeychainString(_ value: String, key: String) {
    let base = keychainQuery(service: "app:no-auth", key: key)
    let update: [String: Any] = [kSecValueData as String: Data(value.utf8)]
    if SecItemUpdate(base as CFDictionary, update as CFDictionary) == errSecItemNotFound {
      var add = base
      add[kSecValueData as String] = Data(value.utf8)
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
      SecItemAdd(add as CFDictionary, nil)
    }
  }

  // True when this device must NOT ring for a call addressed to recipientId:
  // explicitly signed out, or signed in as a different user. No recipientId (old
  // server) or no marker (never written / unknown) -> ring exactly as before.
  private static func shouldRejectForSession(recipientId: String?) -> Bool {
    guard let rid = recipientId?.trimmingCharacters(in: .whitespacesAndNewlines), !rid.isEmpty else { return false }
    guard let marker = readKeychainString(key: sessionMarkerKey)?.trimmingCharacters(in: .whitespacesAndNewlines), !marker.isEmpty else { return false }
    return marker == sessionMarkerSignedOut || marker != rid
  }

  private static func payloadFlag(_ value: Any?) -> Bool {
    if let b = value as? Bool { return b }
    if let s = value as? String { return s == "true" || s == "1" }
    if let n = value as? NSNumber { return n.boolValue }
    return false
  }

  // P-C-03: RNCallKeep builds its CXProvider only when "RNCallKeepSettings" is in
  // NSUserDefaults, which JS setup() writes. A VoIP push that arrives before JS
  // has EVER run (fresh install / restore) would report nothing and the app would
  // be killed. Seed the provider natively with the same defaults JS uses; once
  // settings exist this is a no-op and JS keeps owning them.
  private static func ensureCallKitProvider() {
    if UserDefaults.standard.dictionary(forKey: "RNCallKeepSettings") == nil {
      let defaults: [String: Any] = [
        "appName": "TalksTry",
        "supportsVideo": true,
        "maximumCallGroups": "1",
        "maximumCallsPerCallGroup": "1"
      ]
      RNCallKeep.setup(defaults)
    }
  }

  // Apple rule: EVERY VoIP push must report a call before completion(). When the
  // push must not ring (duplicate, logged out, wrong account, cancel-type) report
  // a throwaway call under a FRESH uuid and end it as soon as CallKit accepted
  // it. Reason: 1 failed, 2 remote ended, 3 unanswered.
  private static func reportThenEnd(reason: Int32, completion: @escaping () -> Void) {
    let throwaway = UUID().uuidString
    RNCallKeep.reportNewIncomingCall(
      throwaway,
      handle: "TalksTry",
      handleType: "generic",
      hasVideo: false,
      localizedCallerName: "TalksTry",
      supportsHolding: false,
      supportsDTMF: false,
      supportsGrouping: false,
      supportsUngrouping: false,
      fromPushKit: true,
      payload: nil,
      withCompletionHandler: {
        RNCallKeep.endCall(withUUID: throwaway, reason: reason)
        completion()
      }
    )
  }

  public func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    RNVoipPushNotificationManager.didUpdate(pushCredentials, forType: type.rawValue)
  }

  public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    // P-C-18: the token is no longer valid. PushKit delivers a replacement via
    // didUpdate when one exists; meanwhile leave a Keychain note JS picks up
    // (src/calls/services/voipPushService.js) so it stops re-sending the dead
    // token to the backend on every reconnect.
    AppDelegate.writeKeychainString(String(Int(Date().timeIntervalSince1970 * 1000)), key: AppDelegate.voipInvalidatedKey)
  }

  public func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
    let dict = payload.dictionaryPayload
    // EVERY path below reports a call to CallKit before completion() runs.
    AppDelegate.ensureCallKitProvider()

    // CallKit requires an RFC4122 UUID — reporting anything else gets the app
    // KILLED by iOS. The backend sends a dedicated 'uuid' field; VALIDATE it
    // (and any callId fallback, which is normally 'sig_..._<ms>' and NOT a
    // UUID) through UUID(uuidString:) so a malformed value can never reach
    // reportNewIncomingCall — worst case we ring under a fresh UUID.
    let uuid = UUID(uuidString: (dict["uuid"] as? String) ?? "")?.uuidString
      ?? UUID(uuidString: (dict["callId"] as? String) ?? "")?.uuidString
      ?? UUID().uuidString

    // Cancel-type push (not a ring): end the matching call if CallKit still has
    // it, and satisfy the report rule with a throwaway call. Never forwarded to JS
    // (JS would turn it into a ring).
    let payloadType = ((dict["type"] as? String) ?? "").lowercased()
    if AppDelegate.voipCancelTypes.contains(payloadType) {
      if RNCallKeep.isCallActive(uuid) {
        RNCallKeep.endCall(withUUID: uuid, reason: 2)
      }
      AppDelegate.reportThenEnd(reason: 2, completion: completion)
      return
    }

    // P-C-04: signed out / signed in as someone else -> never ring. Report then
    // end at once (Apple rule). Not forwarded to JS. recipientId is additive; an
    // old server omits it and the push rings as before.
    let recipientId = (dict["recipientId"] as? String) ?? (dict["recipientId"] as? NSNumber)?.stringValue
    if AppDelegate.shouldRejectForSession(recipientId: recipientId) {
      AppDelegate.reportThenEnd(reason: 3, completion: completion)
      return
    }

    // P-C-15: a group / conference ring is labelled with the group, like JS does.
    let isConference = AppDelegate.payloadFlag(dict["isConference"])
    let isGroup = isConference || AppDelegate.payloadFlag(dict["isGroup"])
    let groupName = ((dict["groupName"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let plainName = (dict["callerName"] as? String) ?? "Incoming call"
    let callerName = isGroup ? (groupName.isEmpty ? "Group call" : groupName) : plainName
    let hasVideo = ((dict["callType"] as? String) ?? "audio") == "video"

    // Duplicate delivery of a call CallKit already knows (APNs double delivery,
    // backend retry, same uuid after the call ended): a second report on the same
    // UUID only errors, but the push STILL has to report a call — so report a
    // throwaway call under a fresh uuid and end it. Still forward to JS so its
    // state can reconcile. (A payload with a malformed / missing uuid falls
    // through on a fresh random UUID and is never deduped.)
    if AppDelegate.voipReportedUuids.contains(uuid) {
      AppDelegate.reportThenEnd(reason: 1, completion: completion)
      RNVoipPushNotificationManager.didReceiveIncomingPush(with: payload, forType: type.rawValue)
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