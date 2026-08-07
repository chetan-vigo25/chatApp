/**
 * Expo config plugin: stop expo-share-intent from crashing the app on Android
 * when something is shared INTO TalksTry.
 *
 * THE BUG (reproduced 2026-08-05 on Android 15, expo-share-intent 5.1.1 — still
 * present upstream in 8.0.1, so upgrading does NOT fix it):
 *
 *   android.database.CursorIndexOutOfBoundsException: Index 0 requested, with a size of 0
 *     at ExpoShareIntentModule$Companion.getFileInfo(ExpoShareIntentModule.kt:71)
 *     at ExpoShareIntentModule$Companion.handleShareIntent(ExpoShareIntentModule.kt:145)
 *     at MainActivity.onNewIntent(MainActivity.kt:39)
 *
 * `getFileInfo` calls `queryResult.moveToFirst()` and throws the Boolean away,
 * then reads column 0. Under Android 13+ partial media access ("Select photos
 * only", i.e. READ_MEDIA_VISUAL_USER_SELECTED) a MediaStore query for an item the
 * user has not granted returns an EMPTY cursor rather than an error — so the read
 * throws on the main thread and the process is killed the instant a share arrives.
 * iOS is unaffected: the share extension hands over a real file:// path inside the
 * App Group container, so no ContentResolver query happens.
 *
 * Three more unguarded main-thread crashes in the same function are fixed here
 * too, since they fail on exactly the same "provider gave us less than expected"
 * inputs: `resolver.query(...)!!` (NPE when the provider returns null),
 * `resolver.getType(uri)!!` (NPE for a provider with no type), and the
 * BitmapFactory / MediaMetadataRetriever reads (SecurityException /
 * FileNotFoundException / IllegalArgumentException on an unreadable stream).
 * Missing metadata now degrades to null and the JS layer falls back to the
 * content:// uri instead of taking the app down.
 *
 * WHY PATCH node_modules: the crash is in the library's own Kotlin source, which
 * is compiled straight out of node_modules — there is no JS seam to intercept it.
 * Re-applied on every prebuild; it is idempotent and safe to run repeatedly.
 * NOTE: `npm install` restores the pristine file, so run a prebuild (or
 * `node plugins/withShareIntentAndroidFix.js`) after reinstalling dependencies.
 */
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MODULE_REL = path.join(
  'node_modules',
  'expo-share-intent',
  'android',
  'src',
  'main',
  'java',
  'expo',
  'modules',
  'shareintent',
  'ExpoShareIntentModule.kt',
);

const PATCH_MARKER = 'patched by plugins/withShareIntentAndroidFix.js';

// ── 1) The crash: unguarded cursor read + non-null-asserted query/getType ──
const CURSOR_FROM = `            val queryResult: Cursor = resolver.query(uri, null, null, null, null)!!
            queryResult.moveToFirst()
            val fileName = queryResult.getString(queryResult.getColumnIndex(OpenableColumns.DISPLAY_NAME))
            val fileSize = queryResult.getString(queryResult.getColumnIndex(OpenableColumns.SIZE))
            queryResult.close()

            val mimeType = resolver.getType(uri)!!`;

const CURSOR_TO = `            // ── ${PATCH_MARKER} ──
            // Under Android 13+ partial media access a query for a non-granted
            // item returns an EMPTY cursor; the original unguarded moveToFirst()
            // + getString() threw CursorIndexOutOfBoundsException on the main
            // thread and killed the app on every incoming share.
            var fileName: String? = null
            var fileSize: String? = null
            val queryResult: Cursor? = try {
                resolver.query(uri, null, null, null, null)
            } catch (e: Exception) {
                null
            }
            if (queryResult != null) {
                if (queryResult.moveToFirst()) {
                    val nameIndex = queryResult.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (nameIndex >= 0) fileName = queryResult.getString(nameIndex)
                    val sizeIndex = queryResult.getColumnIndex(OpenableColumns.SIZE)
                    if (sizeIndex >= 0) fileSize = queryResult.getString(sizeIndex)
                }
                queryResult.close()
            }

            val mimeType = resolver.getType(uri) ?: "application/octet-stream"`;

// ── 2) Image dimension probe: openInputStream can throw on an unreadable uri ──
const BITMAP_FROM = `                BitmapFactory.decodeStream(resolver.openInputStream(uri), null, options)`;

const BITMAP_TO = `                try {
                    BitmapFactory.decodeStream(resolver.openInputStream(uri), null, options)
                } catch (e: Exception) {
                    // ${PATCH_MARKER}: unreadable stream — dimensions stay null.
                }`;

// ── 3) Video probe: getAbsolutePath() is null for most content:// uris, and
//       setDataSource(null) throws IllegalArgumentException. Fall back to the
//       uri-based overload and never let metadata failure kill the share. ──
const VIDEO_FROM = `                val retriever = MediaMetadataRetriever()
                retriever.setDataSource(instance?.getAbsolutePath(uri))`;

const VIDEO_TO = `                val retriever = MediaMetadataRetriever()
                // ${PATCH_MARKER}: getAbsolutePath() is null for most content://
                // uris under scoped storage; setDataSource(null) would throw.
                try {
                    val videoPath = instance?.getAbsolutePath(uri)
                    if (videoPath != null) {
                        retriever.setDataSource(videoPath)
                    } else {
                        retriever.setDataSource(instance?.context, uri)
                    }
                } catch (e: Exception) {
                    notifyError("Cannot read video metadata (getFileInfo)")
                }`;

// ── 4) The silent drop: a share arriving while the activity is not task root
//       was re-launched and then ABANDONED without ever reaching JS. ──
const TASKROOT_FROM = `        fun handleShareIntent(intent: Intent) {
            val activity = instance?.currentActivity
            if (activity != null && !activity.isTaskRoot) {
                val newIntent = Intent(intent).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                activity.startActivity(newIntent)
                activity.finish()
                return
            }
            if (intent.type == null) return`;

const TASKROOT_TO = `        fun handleShareIntent(intent: Intent) {
            // ── ${PATCH_MARKER} ──
            // UPSTREAM BUG: when the activity was not task root, the library
            // re-launched itself (startActivity + finish) and RETURNED WITHOUT
            // NOTIFYING JS, leaving the intent only in ExpoShareIntentSingleton.
            // Nothing reliably drains it — the JS hook refreshes on mount and on
            // AppState change, and an in-place activity swap fires NEITHER — so
            // the share was lost and the user just landed on the chat list.
            // Intermittent, because isTaskRoot is false only on some launch
            // paths (notably the expo-dev-client deep link).
            //
            // MainActivity is launchMode="singleTask", so Android already routes
            // a share to the one existing task instance. The re-launch buys
            // nothing here and only creates the drop — handle the intent inline.
            if (intent.type == null) return`;

const REPLACEMENTS = [
  ['cursor guard', CURSOR_FROM, CURSOR_TO],
  ['bitmap guard', BITMAP_FROM, BITMAP_TO],
  ['video guard', VIDEO_FROM, VIDEO_TO],
  ['task-root drop', TASKROOT_FROM, TASKROOT_TO],
];

function patchShareIntentModule(projectRoot) {
  const target = path.join(projectRoot, MODULE_REL);

  if (!fs.existsSync(target)) {
    console.warn(`[withShareIntentAndroidFix] not found, skipping: ${MODULE_REL}`);
    return false;
  }

  const original = fs.readFileSync(target, 'utf8');

  // Idempotency is checked PER replacement, not via one global marker: a single
  // marker meant that adding a new fix to this list silently did nothing on an
  // already-patched tree (the whole file was skipped).
  let patched = original;
  const applied = [];
  const missing = [];
  REPLACEMENTS.forEach(([label, from, to]) => {
    if (patched.includes(to)) return; // this specific fix is already in place
    if (!patched.includes(from)) {
      missing.push(label);
      return;
    }
    patched = patched.replace(from, to);
    applied.push(label);
  });

  // Fail loudly: a silent no-op here means the app still crashes or drops shares.
  if (missing.length) {
    console.warn(
      `[withShareIntentAndroidFix] anchor(s) not found: ${missing.join(', ')} — ` +
        'expo-share-intent source changed; re-check the patch against ' +
        'ExpoShareIntentModule.kt before shipping.',
    );
  }

  if (patched === original) return false;

  fs.writeFileSync(target, patched);
  console.log(
    `[withShareIntentAndroidFix] patched ExpoShareIntentModule.kt (${applied.join(', ')})`,
  );
  return true;
}

const withShareIntentAndroidFix = (config) =>
  withDangerousMod(config, [
    'android',
    (cfg) => {
      patchShareIntentModule(cfg.modRequest.projectRoot);
      return cfg;
    },
  ]);

module.exports = withShareIntentAndroidFix;
module.exports.patchShareIntentModule = patchShareIntentModule;

// Allow re-applying after `npm install` without a full prebuild:
//   node plugins/withShareIntentAndroidFix.js
if (require.main === module) {
  patchShareIntentModule(path.join(__dirname, '..'));
}
