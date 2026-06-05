/**
 * Expo config plugin: enable a WhatsApp-style full-screen incoming-call screen
 * over the lock screen on Android.
 *
 * `android/` is git-ignored (Continuous Native Generation), so these native
 * AndroidManifest changes must live in a config plugin to survive
 * `expo prebuild` / EAS builds:
 *   1. USE_FULL_SCREEN_INTENT — lets a notification launch a full-screen activity
 *      (required on Android 10+; auto-granted for CALL-category notifications).
 *   2. MainActivity android:showWhenLocked + android:turnScreenOn — lets the
 *      activity draw over the keyguard and wake the screen when the full-screen
 *      intent fires, so the call UI appears even on a locked device.
 *
 * iOS is unaffected (Apple requires CallKit for lock-screen call UI — out of
 * scope here; iOS keeps the heads-up notification path).
 */
const { withAndroidManifest, AndroidConfig } = require('@expo/config-plugins');

const FULL_SCREEN_PERMISSION = 'android.permission.USE_FULL_SCREEN_INTENT';

const withCallFullScreen = (config) =>
  withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;

    // 1) Ensure the USE_FULL_SCREEN_INTENT permission is declared once.
    const perms = manifest.manifest['uses-permission'] || [];
    const hasPerm = perms.some(
      (p) => p.$ && p.$['android:name'] === FULL_SCREEN_PERMISSION,
    );
    if (!hasPerm) {
      perms.push({ $: { 'android:name': FULL_SCREEN_PERMISSION } });
      manifest.manifest['uses-permission'] = perms;
    }

    // 2) Flag MainActivity so it can show over the lock screen + turn the screen
    // on when launched by the call's full-screen intent.
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    const activities = application.activity || [];
    const mainActivity = activities.find(
      (a) => a.$ && a.$['android:name'] === '.MainActivity',
    );
    if (mainActivity) {
      mainActivity.$['android:showWhenLocked'] = 'true';
      mainActivity.$['android:turnScreenOn'] = 'true';
    }

    return cfg;
  });

module.exports = withCallFullScreen;
