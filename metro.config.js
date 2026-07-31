// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// react-native-webrtc imports "event-target-shim/index", but that package's
// "exports" map (enforced by default on Expo SDK 54 / RN 0.81's Metro) does not
// list the "./index" subpath — so Metro logs a noisy "not listed in exports …
// falling back to file-based resolution" warning on every bundle. Redirect that
// exact subpath to the package's main entry (its "." export, which resolves
// cleanly) so the exports lookup — and its warning — is skipped. All other
// packages keep normal package-exports resolution.
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'event-target-shim/index') {
    return context.resolveRequest(context, 'event-target-shim', platform);
  }
  return (defaultResolveRequest || context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
