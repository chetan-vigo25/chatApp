/**
 * Expo config plugin: resolve the Firebase notification meta-data merge conflict.
 *
 * expo-notifications writes the FCM default notification icon/color meta-data
 * into the app manifest:
 *   com.google.firebase.messaging.default_notification_color → @color/notification_icon_color
 *   com.google.firebase.messaging.default_notification_icon  → @drawable/notification_icon
 * but the `com.google.firebase:firebase-messaging` AAR ALSO declares the same
 * two meta-data with its own default resource. The Android manifest merger can't
 * pick a winner and fails:
 *
 *   > Manifest merger failed : Attribute
 *     meta-data#com.google.firebase.messaging.default_notification_color@resource ...
 *     Suggestion: add 'tools:replace="android:resource"' to <meta-data> element.
 *
 * This plugin adds `tools:replace="android:resource"` to those two meta-data
 * entries (and ensures the manifest declares the tools namespace) so OUR values
 * win. Runs on every prebuild, so the fix survives `expo prebuild --clean`.
 */
const { withAndroidManifest, AndroidConfig } = require('@expo/config-plugins');

const FIREBASE_META = [
  'com.google.firebase.messaging.default_notification_color',
  'com.google.firebase.messaging.default_notification_icon',
];

const withFirebaseNotificationMeta = (config) =>
  withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;

    // Ensure xmlns:tools is declared so tools:replace is valid.
    manifest.$ = manifest.$ || {};
    if (!manifest.$['xmlns:tools']) {
      manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    for (const meta of application['meta-data'] || []) {
      if (meta.$ && FIREBASE_META.includes(meta.$['android:name'])) {
        meta.$['tools:replace'] = 'android:resource';
      }
    }

    return cfg;
  });

module.exports = withFirebaseNotificationMeta;
