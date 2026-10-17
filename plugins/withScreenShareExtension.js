/**
 * Expo config plugin: iOS screen sharing in calls.
 *
 * react-native-webrtc's getDisplayMedia on iOS does not capture anything by
 * itself: it opens a Unix socket in an App Group container and expects a
 * ReplayKit Broadcast Upload Extension to stream the screen into it. This
 * plugin (re)creates that extension target — `TalksTryScreenShare` — and the
 * Info.plist keys react-native-webrtc reads:
 *   RTCAppGroupIdentifier      → the shared App Group (socket location)
 *   RTCScreenSharingExtension  → the extension bundle id (picker preselection)
 *
 * The extension's Swift sources live in plugins/ios-screen-share/ (tracked —
 * `ios/` is git-ignored). Edit them there and copy into ios/TalksTryScreenShare.
 * The picker itself is opened by modules/expo-screen-broadcast.
 *
 * The App Group is the existing share-extension group, so no new group has to
 * be registered in the Apple Developer portal.
 */
const {
  withInfoPlist,
  withEntitlementsPlist,
  withXcodeProject,
  withDangerousMod,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const TARGET = 'TalksTryScreenShare';
const SOURCES = ['SampleHandler.swift', 'SampleUploader.swift', 'SocketConnection.swift', 'Atomic.swift'];
const SOURCE_DIR = path.join(__dirname, 'ios-screen-share');
const DEPLOYMENT_TARGET = '15.5';

const appGroupFor = (bundleId) => `group.${bundleId}.share`;
const extBundleIdFor = (bundleId) => `${bundleId}.ScreenShare`;

const entitlements = (appGroup) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>${appGroup}</string>
  </array>
</dict>
</plist>
`;

const withMainApp = (config, appGroup, extBundleId) => {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.RTCAppGroupIdentifier = appGroup;
    cfg.modResults.RTCScreenSharingExtension = extBundleId;
    return cfg;
  });
  return withEntitlementsPlist(config, (cfg) => {
    const key = 'com.apple.security.application-groups';
    const groups = cfg.modResults[key] || [];
    if (!groups.includes(appGroup)) groups.push(appGroup);
    cfg.modResults[key] = groups;
    return cfg;
  });
};

const withExtensionFiles = (config, appGroup) =>
  withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, TARGET);
      fs.mkdirSync(dir, { recursive: true });
      for (const f of [...SOURCES, 'Info.plist']) {
        fs.copyFileSync(path.join(SOURCE_DIR, f), path.join(dir, f));
      }
      fs.writeFileSync(path.join(dir, `${TARGET}.entitlements`), entitlements(appGroup));
      return cfg;
    },
  ]);

const withExtensionTarget = (config, extBundleId) =>
  withXcodeProject(config, (cfg) => {
    const proj = cfg.modResults;
    if (proj.pbxTargetByName(TARGET)) return cfg;

    const groupKey = proj.pbxCreateGroup(TARGET, TARGET);
    const target = proj.addTarget(TARGET, 'app_extension', TARGET, extBundleId);
    proj.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
    proj.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
    proj.addBuildPhase(['ReplayKit.framework'], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
    for (const f of SOURCES) {
      proj.addSourceFile(`${TARGET}/${f}`, { target: target.uuid }, groupKey);
    }

    const configurations = proj.pbxXCBuildConfigurationSection();
    for (const key in configurations) {
      const bs = configurations[key].buildSettings;
      if (!bs || bs.PRODUCT_NAME !== `"${TARGET}"`) continue;
      bs.PRODUCT_BUNDLE_IDENTIFIER = `"${extBundleId}"`;
      bs.INFOPLIST_FILE = `"${TARGET}/Info.plist"`;
      bs.CODE_SIGN_ENTITLEMENTS = `"${TARGET}/${TARGET}.entitlements"`;
      bs.IPHONEOS_DEPLOYMENT_TARGET = DEPLOYMENT_TARGET;
      bs.TARGETED_DEVICE_FAMILY = '"1,2"';
      bs.SWIFT_VERSION = '5.0';
      bs.CODE_SIGN_STYLE = 'Automatic';
      bs.APPLICATION_EXTENSION_API_ONLY = 'YES';
      // The extension must carry the app's version or App Store validation fails.
      bs.MARKETING_VERSION = cfg.version || '1.0';
      bs.CURRENT_PROJECT_VERSION = (cfg.ios && cfg.ios.buildNumber) || '1';
    }

    // addTarget() already embeds an app_extension into the app's PlugIns copy
    // phase; only the dependency is added (see withNotificationServiceExtension).
    proj.addTargetDependency(proj.getFirstTarget().uuid, [target.uuid]);
    return cfg;
  });

const withScreenShareExtension = (config) => {
  const bundleId = (config.ios && config.ios.bundleIdentifier) || 'com.chat.baatCheet';
  const appGroup = appGroupFor(bundleId);
  const extBundleId = extBundleIdFor(bundleId);
  config = withMainApp(config, appGroup, extBundleId);
  config = withExtensionFiles(config, appGroup);
  config = withExtensionTarget(config, extBundleId);
  return config;
};

module.exports = withScreenShareExtension;
