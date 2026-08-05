const { withEntitlementsPlist } = require('@expo/config-plugins');

// expo-share-intent's withIosAppEntitlements ASSIGNS
// `com.apple.security.application-groups` (`modResults[key] = [shareGroup]`)
// instead of appending, so it drops the notifications group that
// withNotificationServiceExtension added earlier — which would cut the NSE off
// from its shared UserDefaults suite. Re-union both groups here.
//
// This must stay LAST in app.json's plugins array: withEntitlementsPlist mods
// run in registration order, so only a later mod can undo the overwrite.
const appGroupsFor = (bundleId) => [
  `group.${bundleId}.notifications`,
  `group.${bundleId}.share`,
];

const withMergedAppGroups = (config) => {
  const bundleId = (config.ios && config.ios.bundleIdentifier) || 'com.chat.baatCheet';
  const required = appGroupsFor(bundleId);

  return withEntitlementsPlist(config, (cfg) => {
    const groups = cfg.modResults['com.apple.security.application-groups'] || [];
    required.forEach((group) => {
      if (!groups.includes(group)) groups.push(group);
    });
    cfg.modResults['com.apple.security.application-groups'] = groups;
    return cfg;
  });
};

module.exports = withMergedAppGroups;
