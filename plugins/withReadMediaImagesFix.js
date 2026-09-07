/**
 * Keeps READ_MEDIA_IMAGES alive on Android 14+.
 *
 * expo-screen-capture ships this in its own AndroidManifest:
 *
 *   <uses-permission android:name="android.permission.READ_MEDIA_IMAGES"
 *                    android:minSdkVersion="33" android:maxSdkVersion="33"/>
 *
 * The manifest merger folds those two attributes onto the app's own plain
 * declaration, so the built APK ends up with the permission capped at SDK 33.
 * On Android 14 (34) and 15 (35) the platform then drops it entirely — it does
 * not even appear in `dumpsys package <pkg>` under "requested permissions", the
 * OS never offers it in a permission dialog, and every MediaStore image query
 * comes back empty. The symptom is a gallery picker that shows nothing at all
 * while album *names* still list (those come back via READ_MEDIA_AUDIO), which
 * is what components/AttachmentSheet hit.
 *
 * `tools:remove` strips the merged attributes back off so the app's own
 * uncapped declaration survives. It has to be an explicit override: the merger
 * has no notion of "the app meant every SDK level" without one.
 *
 * This lives as a plugin rather than a hand edit to android/ because prebuild
 * regenerates that manifest from app.json and would silently undo it — and the
 * failure it causes is entirely invisible until someone opens a picker on a
 * 14+ device.
 */
const { withAndroidManifest } = require('expo/config-plugins');

const PERMISSION = 'android.permission.READ_MEDIA_IMAGES';
const TOOLS_NS = 'http://schemas.android.com/tools';

const withReadMediaImagesFix = (config) => withAndroidManifest(config, (cfg) => {
  const manifest = cfg.modResults.manifest;

  // `tools:` is not in the default namespace set of a generated manifest.
  manifest.$ = manifest.$ || {};
  if (!manifest.$['xmlns:tools']) manifest.$['xmlns:tools'] = TOOLS_NS;

  manifest['uses-permission'] = manifest['uses-permission'] || [];

  let entry = manifest['uses-permission'].find(
    (p) => p?.$?.['android:name'] === PERMISSION,
  );

  if (!entry) {
    entry = { $: { 'android:name': PERMISSION } };
    manifest['uses-permission'].push(entry);
  }

  // Drop any cap this app declared itself, and tell the merger to drop the
  // ones libraries try to merge in.
  delete entry.$['android:maxSdkVersion'];
  delete entry.$['android:minSdkVersion'];
  entry.$['tools:remove'] = 'android:maxSdkVersion,android:minSdkVersion';

  return cfg;
});

module.exports = withReadMediaImagesFix;
