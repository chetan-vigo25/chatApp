# Share Target (Incoming Share) — Battle-Tested Implementation Guide

Make the app appear in the **native Android + iOS share sheet** so users can share
images, videos, PDFs, documents, text and URLs **into** it from Gallery, Files,
Chrome, WhatsApp, Drive, Photos — then pick a chat and send.

> **This is not a design doc — it is a record of what actually shipped.**
> Verified end-to-end on real devices (Android 15, iPhone 14 Pro / iOS 26.5.2)
> with **12 consecutive passing shares**: cold start ×3, warm app ×9, 1/2/3 files,
> JPEG + PNG, `SEND` + `SEND_MULTIPLE`, and 5 text/URL shares.
>
> Proven on **Expo SDK 54**, RN 0.81 new architecture, `expo-share-intent@5.1.1`,
> bundle id `com.chat.baatCheet`, CNG (`ios/` and `android/` are **generated and
> gitignored**).

---

## 0. Read this first — the two things that waste the most time

1. **`expo-share-intent` has real bugs still unfixed upstream in 8.0.1.**
   Upgrading does not help — I unpacked the 8.0.1 tarball and the crashing code is
   byte-for-byte identical to 5.1.1. You must patch its Kotlin locally (§3).

2. **Working on one platform tells you nothing about the other.** iOS gets a real
   `file://` path from the App Group container; Android gets a `content://` uri
   through ContentResolver. Every Android bug in §7 was invisible on iOS, and the
   missing-share-extension bug was invisible on Android.

---

## 0.5 File inventory — everything the feature touches

Verified against the working tree. Copy the **NEW** files as-is; apply the edits to
the **EDIT** files.

| File | Kind | What it carries |
|---|---|---|
| `plugins/withShareIntentAndroidFix.js` | NEW | The 4 Kotlin patches (§3). Without it Android crashes or drops shares. |
| `plugins/withMergedAppGroups.js` | NEW | Stops iOS App Group clobbering (§4.2). Register **last**. |
| `src/share/ShareIntentGate.jsx` | NEW | Routes the share. The 3 rules in §5.2 live here. |
| `src/share/ShareManager.js` | NEW | `normalizeShare()` — uri/mime/name normalization (§5.3). |
| `src/screens/chats/ShareInboxScreen.jsx` | NEW | Chat picker (§5.4). |
| `app.json` | EDIT | Plugin block + both local plugins (§2). |
| `App.js` | EDIT | `<ShareIntentProvider options={{ debug: __DEV__ }}>` (§5.1). |
| `src/navigations/RootNavigator.js` | EDIT | `ShareInbox` screen + `<ShareIntentGate />` (§5.6). |
| `src/screens/chats/ChatScreen.jsx` | EDIT | `pendingShare` effect incl. `setText(share.text)` (§5.5). |
| `src/contexts/useChatLogic.js` | EDIT | `markMediaFailed`, permanent-rejection handling, orphan reconciliation (§5.8). |
| `src/utils/mediaService.js` | EDIT | `content://` branch in `copyToAppFolder` (§5.7). |

Sanity check after wiring it up — every count must be > 0:

```bash
grep -c "shareKey\|unmountedRef\|BOOTING_ROUTES" src/share/ShareIntentGate.jsx
grep -c "isContentUri\|mimeFromName\|EXT_MIME"   src/share/ShareManager.js
grep -c "markMediaFailed\|isPermanentRejection"  src/contexts/useChatLogic.js
grep -c "setText(share.text)"                    src/screens/chats/ChatScreen.jsx
grep -c "Content URI copyAsync failed"           src/utils/mediaService.js
grep -c "patched by plugins/withShareIntentAndroidFix.js" \
  node_modules/expo-share-intent/android/src/main/java/expo/modules/shareintent/ExpoShareIntentModule.kt  # must be 4
```

---

## 1. Concept — "Share Target" ≠ "Share"

| Direction | Meaning | Libraries |
|---|---|---|
| **Outgoing** share | *Your* app pushes content out | `react-native-share`, `expo-sharing` |
| **Incoming** share (**this doc**) | Other apps push content **into** you; you appear in the OS share sheet | `expo-share-intent` |

`react-native-share` and `expo-sharing` do **not** solve this. Wrong direction.

---

## 2. Install + `app.json`

```bash
npm install expo-share-intent
npx expo install expo-linking      # used internally by the library
```

```jsonc
"plugins": [
  // … your other plugins …
  [
    "expo-share-intent",
    {
      "iosActivationRules": {
        "NSExtensionActivationSupportsText": true,
        "NSExtensionActivationSupportsWebURLWithMaxCount": 1,
        "NSExtensionActivationSupportsImageWithMaxCount": 10,
        "NSExtensionActivationSupportsMovieWithMaxCount": 5,
        "NSExtensionActivationSupportsFileWithMaxCount": 10
      },
      "iosShareExtensionName": "TalksTry Share",
      "iosAppGroupIdentifier": "group.com.chat.baatCheet.share",
      "androidIntentFilters": ["text/*", "image/*", "video/*", "audio/*", "application/pdf", "*/*"],
      "androidMultiIntentFilters": ["image/*", "video/*", "*/*"]
    }
  ],
  "./plugins/withShareIntentAndroidFix",   // §3 — MUST be present
  "./plugins/withMergedAppGroups"          // §4.2 — MUST be LAST
]
```

`iosShareExtensionName` is stripped of non-alphanumerics → target `TalksTryShare`.
Extension bundle id derives as `<bundleId>.share-extension`.

**Android needs `launchMode="singleTask"` on MainActivity** (Expo sets this by
default) — §3 depends on it.

---

## 3. Android — the native patch (`plugins/withShareIntentAndroidFix.js`)

**Copy that file verbatim into the new project.** It patches
`node_modules/expo-share-intent/android/.../ExpoShareIntentModule.kt` at prebuild
time (same pattern as `withFmtConstevalFix`). Four separate crashes/drops:

| # | Upstream code | What went wrong |
|---|---|---|
| 1 | `queryResult.moveToFirst()` — Boolean discarded, then `getString(0)` | **App hard-crash**: `CursorIndexOutOfBoundsException: Index 0 requested, with a size of 0`. Android 13+ partial media access returns an **empty cursor**, not an error. |
| 2 | `resolver.query(...)!!`, `resolver.getType(uri)!!` | NPE when a provider returns null |
| 3 | `BitmapFactory.decodeStream(...)`, `retriever.setDataSource(getAbsolutePath(uri))` | SecurityException / FileNotFoundException / IllegalArgumentException — `getAbsolutePath()` is null for most `content://` uris under scoped storage |
| 4 | `if (!activity.isTaskRoot) { startActivity(copy); finish(); return }` | **The intermittent killer** — re-launches itself and returns **without notifying JS** |

### Why #4 is the one that makes you lose your mind

Symptom: *"kabhi Send-to screen aati hai, kabhi seedha chat list."*

```kotlin
val activity = instance?.currentActivity
if (activity != null && !activity.isTaskRoot) {
    activity.startActivity(Intent(intent).apply { addFlags(FLAG_ACTIVITY_NEW_TASK) })
    activity.finish()
    return                        // ← JS is never told
}
```

The intent survives only in `ExpoShareIntentSingleton`, and the JS hook refreshes
**on mount** and **on AppState change** — an in-place activity swap fires
**neither**. So the share evaporates.

Intermittent because `isTaskRoot` is false only on some launch paths — notably
after an `expo-dev-client` deep-link launch.

**The fix deletes the re-launch entirely.** `MainActivity` is `singleTask`, so
Android already routes the share to the one existing task instance; the re-launch
bought nothing and only created the drop.

**How to identify #4 instantly** — compare the `ActivityTaskManager: START` lines:

```
FAIL:  START … SEND … from uid <app-uid>    pid <app-pid>   ← the app re-launching ITSELF
PASS:  START … SEND … from uid <sharer-uid> pid -1          ← the sharing app
```

### The exact Kotlin anchors (rebuild the patch if the library version differs)

All four live in `ExpoShareIntentModule.kt`. Each is a literal find → replace; the
plugin warns by name if an anchor stops matching.

**#1 + #2 — cursor guard and the two `!!`** (`getFileInfo`), find:

```kotlin
val queryResult: Cursor = resolver.query(uri, null, null, null, null)!!
queryResult.moveToFirst()
val fileName = queryResult.getString(queryResult.getColumnIndex(OpenableColumns.DISPLAY_NAME))
val fileSize = queryResult.getString(queryResult.getColumnIndex(OpenableColumns.SIZE))
queryResult.close()

val mimeType = resolver.getType(uri)!!
```

replace with a nullable `Cursor?` in a `try`, a **checked** `moveToFirst()`, index
guards (`if (nameIndex >= 0)`), and `resolver.getType(uri) ?: "application/octet-stream"`.

**#3a — image probe**, find:

```kotlin
BitmapFactory.decodeStream(resolver.openInputStream(uri), null, options)
```

wrap in `try { … } catch (e: Exception) { }`.

**#3b — video probe**, find:

```kotlin
val retriever = MediaMetadataRetriever()
retriever.setDataSource(instance?.getAbsolutePath(uri))
```

replace so a null path falls back to `retriever.setDataSource(instance?.context, uri)`,
all inside `try/catch`.

**#4 — the task-root drop**, find:

```kotlin
fun handleShareIntent(intent: Intent) {
    val activity = instance?.currentActivity
    if (activity != null && !activity.isTaskRoot) {
        val newIntent = Intent(intent).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(newIntent)
        activity.finish()
        return
    }
    if (intent.type == null) return
```

replace with just `fun handleShareIntent(intent: Intent) { … if (intent.type == null) return`
— i.e. **delete the whole `isTaskRoot` block** (see the reasoning above).

### Plugin invariants you must preserve when copying

- **Per-replacement idempotency.** An earlier version used one global
  `PATCH_MARKER` early-return — adding a *new* fix to an already-patched tree then
  silently did nothing. Check each replacement's `to` string individually and log
  which ones applied.
- **Warn loudly on a missing anchor.** A silent no-op means the app still crashes.
- **`npm install` restores the pristine file.** Re-apply and rebuild:
  ```bash
  node plugins/withShareIntentAndroidFix.js
  ```
  The file is directly runnable (`require.main === module`) exactly for this.

---

## 4. iOS — Share Extension + App Groups

### 4.1 The extension only exists after a prebuild

`ios/` is generated, and `expo run:ios` **skips prebuild when `ios/` already
exists** — so adding the plugin does nothing until you force it:

```bash
npx expo prebuild -p ios
cd ios && pod install
```

Verify:

```bash
grep -c "TalksTryShare" ios/<App>.xcodeproj/project.pbxproj      # > 0
ls "<DerivedData>/Build/Products/Debug-iphoneos/<App>.app/PlugIns"
#   NotificationServiceExtension.appex
#   TalksTryShare.appex          ← this one must be there
```

> Symptom if skipped: **app missing from the iOS share sheet while Android works.**
> On iOS a Share Extension target is the *only* mechanism that puts an app there.

### 4.2 `expo-share-intent` CLOBBERS your other App Groups

`withIosAppEntitlements` does a plain **assignment**, not an append:

```js
config.modResults["com.apple.security.application-groups"] = [ shareGroup ];
```

Any other group (e.g. your Notification Service Extension's) is silently wiped —
the NSE loses its shared `UserDefaults` suite and nothing visibly fails until push
payloads stop working.

**Fix — `plugins/withMergedAppGroups.js`, registered LAST** (`withEntitlementsPlist`
mods run in registration order, so only a later mod can undo the overwrite):

```js
const { withEntitlementsPlist } = require('@expo/config-plugins');

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
```

### 4.3 `expo run:ios` cannot register the new App ID / App Group

It does **not** pass `-allowProvisioningUpdates`, so automatic signing dies with:

```
error: Provisioning profile "iOS Team Provisioning Profile: com.chat.baatCheet"
       doesn't support the group.com.chat.baatCheet.share App Group.
error: Provisioning profile "iOS Team Provisioning Profile: *"
       doesn't include the App Groups capability. (in target 'TalksTryShare')
```

Build **once** with the flag — Xcode then creates both identifiers, no Developer
portal work:

```bash
xcodebuild -workspace ios/<App>.xcworkspace -scheme <App> \
  -configuration Debug -destination "id=<device-udid>" \
  -allowProvisioningUpdates build
```

Afterwards `expo run:ios` works normally. Needs the signed-in Apple ID to have
**Admin / Account Holder** role on the team.

---

## 5. JS layer

```
src/share/ShareIntentGate.jsx            # routes the share (the tricky one)
src/share/ShareManager.js                # normalizes the payload
src/screens/chats/ShareInboxScreen.jsx   # chat picker (clone of ForwardMessageScreen)
src/screens/chats/ChatScreen.jsx         # consumes `pendingShare`
```

### 5.1 Provider at the app root — `App.js`

```jsx
<ShareIntentProvider options={{ debug: __DEV__ }}>
  {/* everything else */}
</ShareIntentProvider>
```

**Keep `debug` on in dev.** It is the only way to see which stage swallowed a
share, and it is what localized bug #9. Free in production — `__DEV__` is false
and `babel.config.js` strips `console.*` when `NODE_ENV=production`.

### 5.2 `ShareIntentGate` — three non-obvious rules

Mounted once **inside** `NavigationContainer` (so `navigationRef` is ready);
renders `null`. Full source: [`src/share/ShareIntentGate.jsx`](../src/share/ShareIntentGate.jsx).

**Rule 1 — NEVER put the library's context values in the effect deps.**

`resetShareIntent` is a plain inline function in the hook body
(`useShareIntent.js:24`, no `useCallback`) and the provider's `value={{…}}` is a
fresh object literal (`ShareIntentProvider.js:16`). **Both change identity every
render.** As deps they re-run the effect constantly; the cleanup cancels the
in-flight async handler while an `handlingRef` guard blocks a fresh attempt. On
Android's cold-start render storm the share is cancelled forever.

```jsx
const shareIntentRef = useRef(shareIntent);           shareIntentRef.current = shareIntent;
const resetShareIntentRef = useRef(resetShareIntent); resetShareIntentRef.current = resetShareIntent;

// Cancel in-flight work on UNMOUNT ONLY — never on a re-render.
useEffect(() => () => { unmountedRef.current = true; }, []);
```

**Rule 2 — the dep must be a CONTENT-derived key, not `hasShareIntent` alone.**

`hasShareIntent` stays `true` across back-to-back shares, so a second share never
re-runs the effect. Worse: any path returning without `resetShareIntent()` pins it
`true` forever and **every later share is dead until app restart**.

```jsx
const shareKey = shareIntent
  ? [
      ...(shareIntent.files || []).map((f) => f?.path || f?.contentUri || f?.fileName || ''),
      shareIntent.text || '',
      shareIntent.webUrl || '',
    ].join('|')
  : '';

}, [hasShareIntent, shareKey]);   // primitives ONLY
```

Call `resetShareIntent()` on **every** exit path, including the give-up one.

**Rule 3 — wait for the boot chain, not just `navigationRef.isReady()`.**

`isReady()` flips true the moment the container mounts, while Splash is still
resolving auth. Every startup screen ends in `navigation.reset()`, which
**replaces the whole stack** — pushing `ShareInbox` before that lands makes the
picker flash for one frame and vanish into the chat list.

```jsx
const BOOTING_ROUTES = new Set(['Splash', 'Permissions', 'SyncScreen']);
```

In this repo those resets live at [`Splash.jsx:86`](../src/screens/Splash.jsx#L86),
[`PermissionsGate.jsx:57`](../src/features/permissions/screens/PermissionsGate.jsx#L57),
[`SyncScreen.jsx:303`](../src/screens/SyncScreen.jsx#L303).
**In a new project, `grep -rn "navigation.reset(" src/screens` and list every boot
screen here.**

Warm shares settle on the first check (300–600ms measured). A 19s wait observed
once was a **slow/unreachable LAN backend** stalling `bootstrapSession()` +
`initSocket()` — not the share code. On a healthy backend it dropped to 300ms.

### 5.3 `ShareManager.normalizeShare` — two Android traps

Full source: [`src/share/ShareManager.js`](../src/share/ShareManager.js).

```js
// TRAP 1: Android returns a content:// uri whenever the library can't resolve an
// absolute path. Blindly prefixing produced `file://content://…` — malformed, and
// every upload failed with a bogus NetworkError.
const isContentUri = rawPath.startsWith('content://');
const uri = (isContentUri || rawPath.startsWith('file://')) ? rawPath : `file://${rawPath}`;

// TRAP 2: the last path segment of a content:// uri is a MediaStore row id
// ("1234"), NOT a filename — and fileName is null when the provider withheld
// metadata. Synthesize one with a real extension.
const name = f.fileName || (isContentUri ? fallbackName : (uri.split('/').pop() || fallbackName));
```

`extFromMime` maps `jpeg→jpg`, `quicktime→mov`, `svgxml→svg`, and returns `''` for
`octetstream` (a `.octetstream` extension is worse than none — it also confuses
destination-folder routing in `copyToAppFolder`).

`text` is returned **only when `files` is empty**, so the two are mutually exclusive.

### 5.4 `ShareInboxScreen` — the picker

Clone of `ForwardMessageScreen`. Reads the **already-loaded** chat list (Redux
`chatsData` + `RealtimeChatContext`) — no network call. On select it hands the
payload to the thread and never uploads anything itself:

```jsx
navigation.replace('ChatScreen', { item: chat, pendingShare: share });
```

### 5.5 `ChatScreen` — consume `pendingShare`

```jsx
const consumedShareRef = useRef(false);
useEffect(() => {
  const share = route?.params?.pendingShare;
  if (!share || consumedShareRef.current) return;
  consumedShareRef.current = true;

  (async () => {
    try {
      for (const item of share.files || []) {
        if (!item?.file?.uri) continue;
        await sendMedia({ file: item.file, type: item.type }).catch(() => {});
      }

      // A text/URL share carries NO files. Without this branch the loop found
      // nothing, the param was cleared, and the link was silently dropped —
      // the user never learned it hadn't arrived.
      if (share.text) {
        setText(share.text);      // prefill the composer; do NOT auto-send
      }
    } finally {
      navigation.setParams({ pendingShare: undefined });
    }
  })();
}, [route?.params?.pendingShare, sendMedia, setText, navigation]);
```

`setText` (not `handleTextChange`) so a prefill doesn't emit a typing indicator.
It is exported from `useChatLogic` — make sure the screen actually destructures it.

### 5.6 Register the screen + gate — `RootNavigator`

```jsx
<Stack.Screen name="ShareInbox" component={ShareInboxScreen} options={{ gestureEnabled: false }} />
{/* … inside NavigationContainer, outside Stack.Navigator … */}
<ShareIntentGate />
```

### 5.7 Upload path — `content://` support in `copyToAppFolder`

`MediaLibrary.createAssetAsync` needs media permission and **refuses non-media
types**, so every PDF/Drive share died there. Try `FileSystem.copyAsync` first —
it reads `content://` through the ContentResolver and works for any provider:

```js
if (/^content:\/\//i.test(normalizedUri)) {
  try {
    await FileSystem.copyAsync({ from: normalizedUri, to: destination });
    return normalizeUri(destination);
  } catch (copyErr) { /* fall through to MediaLibrary */ }
  try {
    const asset = await MediaLibrary.createAssetAsync(normalizedUri);
    if (asset?.uri) {
      await FileSystem.copyAsync({ from: asset.uri, to: destination });
      return normalizeUri(destination);
    }
  } catch (err) { return normalizedUri; }
}
```

### 5.8 Failure UX — a rejected upload must LOOK rejected

Two rules, both learned the hard way when the backend started rejecting `.docx`:

**1. Mark failure in all three layers.** The failed-bubble UI renders off the
*persisted* status. Updating only React state leaves `'sending'` in SQLite and in
`ChatCache`, so reopening the chat repaints a spinner for an upload that was
permanently rejected — forever.

```js
const markMediaFailed = useCallback((tempId) => {
  setAllMessages((prev) => prev.map((m) => (m.tempId === tempId ? { ...m, status: 'failed' } : m)));
  setUploadProgress((prev) => ({ ...prev, [tempId]: 0 }));
  ChatCache.updateMessage(chatIdRef.current, tempId, { status: 'failed' });      // reopen paint
  SqliteWriter.enqueue('updateMessageStatus', { id: tempId, status: 'failed' }); // persisted truth
}, []);
```

Use it at **every** media failure site (single, album, payload-validation, both
catch blocks) — they all had the same incomplete two-line pattern duplicated.

**2. Reconcile orphaned rows on the chat read path.** Rows stranded by an app kill
or by an older build will never self-heal. A row may stay `'sending'` **only**
while something can still finish it:

```js
if (activeMediaUploadTempIdsRef.current.has(id)) continue;  // uploading now
if (globalActiveMediaUploads.has(id)) continue;             // uploading in another mount
if (queuedIds.has(id)) continue;                            // queued for retry
if (isUploadPaused(id) || isUploadCancelled(id)) continue;  // user parked it
markMediaFailed(id);                                        // otherwise: orphaned
```

Sender-only — a peer's row is never yours to judge.

---

## 6. Does any of this need backend work? **No.**

| Stage | Server? |
|---|---|
| OS share sheet → appex/intent → `ShareIntentGate` → `ShareInbox` | ❌ pure client + OS |
| Chat picker (Redux + realtime list already in memory) | ❌ |
| `sendMedia` → `user/media/exists` → `user/media/upload` → `socket.emit(sendEvent, …)` | ✅ but **existing** endpoints, unchanged |

Share is only an OS-integration + navigation layer funnelling into the pipeline you
already have. No new API, no new socket event, no schema change.

Two caveats: your upload endpoint now receives types it never saw before (`*/*` on
Android), and if a provider withholds metadata `size` arrives as `0`, so a large
video takes the multipart path instead of chunked.

### The one thing the client genuinely cannot fix: the upload whitelist

```
ERROR apiCallForm fetch error: [Error: This file type is blocked for security reasons]
API Error: { status: 400, hasResponse: true,
             data: { message: "This file type is blocked for security reasons" } }
```

`status: 400` + `hasResponse: true` means the request **reached the server and the
server refused it**. Grep the client for the message — it isn't there. Only the
backend can widen `user/media/upload`'s allow-list.

Two distinct causes, and you must tell them apart before asking backend for anything:

1. **The client sent a useless MIME.** Chrome's download provider and several file
   managers label every document `application/octet-stream`, and a whitelist that
   keys off MIME rejects generic binary. **Fixed client-side** — `normalizeShare`
   now recovers the real type from the filename extension (§5.3). Retest before
   escalating.
2. **The backend blocks that type on purpose.** Then no client change helps. To
   match WhatsApp's behaviour the server allow-list needs at least:
   `pdf, doc, docx, xls, xlsx, ppt, pptx, txt, csv, rtf, zip, rar, 7z`
   plus the image/audio/video types you already accept.

**`.apk` is a deliberate policy decision, not a bug.** WhatsApp does allow it, but
many backends block executable payloads on purpose. Don't "fix" it without the
backend owner agreeing — and if they do allow it, serve it with
`Content-Disposition: attachment` and never a guessable public URL.

---

## 7. Bug ledger — symptom → cause → fix

Any one of these alone makes the feature look broken.

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | App missing from **iOS** share sheet, Android fine | `ios/` generated before the plugin was added; `expo run:ios` skips prebuild | §4.1 |
| 2 | NSE silently loses its shared UserDefaults | `expo-share-intent` **assigns** app-groups instead of appending | §4.2 |
| 3 | iOS build fails on provisioning | `expo run:ios` omits `-allowProvisioningUpdates` | §4.3 |
| 4 | **App hard-crashes** the instant anything is shared (Android) | unguarded `moveToFirst()` + empty cursor under partial media access | §3 patch #1 |
| 5 | Crashes on odd providers / videos | `!!` NPEs, unguarded Bitmap/MediaMetadataRetriever | §3 patch #2, #3 |
| 6 | Android **never** opens the picker; iOS fine | library context identity unstable → effect cancelled every render | §5.2 Rule 1 |
| 7 | Picker flashes one frame, then chat list | boot-chain `navigation.reset()` wipes the stack | §5.2 Rule 3 |
| 8 | First share works, **second does nothing** | `hasShareIntent` stays true; no content dep; give-up path never reset | §5.2 Rule 2 |
| 9 | **Intermittent** — sometimes picker, sometimes chat list | `isTaskRoot` re-launch returns without notifying JS | §3 patch #4 |
| 10 | Every upload fails with `NetworkError` | `file://content://…` malformed uri | §5.3 |
| 11 | PDFs / Drive docs never upload | `MediaLibrary.createAssetAsync` refuses non-media | §5.7 |
| 12 | Shared **link** does nothing after picking a chat | `ChatScreen` only looped `share.files` | §5.5 |
| 13 | `400 "This file type is blocked for security reasons"` on documents | provider labels documents `application/octet-stream`; backend whitelist rejects generic binary | §5.3 mime recovery — **and possibly a backend change, see §6** |
| 14 | A rejected upload **retries forever** and re-hits the server | only network failures were classified; the kill-safe queue row was never dropped on a 4xx | treat 4xx (except 401/408/429) as terminal; remove the queue row |
| 15 | Failed upload shows a **stuck "sending" spinner**, survives reopen | failure marked in React state only — SQLite + `ChatCache` kept `'sending'` | `markMediaFailed()` writes all three layers; reconcile orphaned rows on chat open (§5.8) |

---

## 8. Debugging playbook

**The Expo terminal never shows native crashes.** Always keep this open:

```bash
adb logcat -s ReactNativeJS:V                                     # JS console
adb logcat | grep -E "FATAL EXCEPTION|expo.modules.shareintent"   # native
```

Trace a share end-to-end:

```bash
adb logcat -c
adb logcat | grep -E "\[SHARE\]|useShareIntent\[|act=android.intent.action.SEND|FATAL EXCEPTION"
```

A healthy share looks exactly like this:

```
START … act=android.intent.action.SEND … from uid <sharer> pid -1
useShareIntent[onChange]   → raw native payload
useShareIntent[parsed]     → normalized files[]
[SHARE] intent received    { platform: 'android', files: 1, firstUri: 'file:///…/cache/…' }
[SHARE] navigation settled { waitedMs: 450, route: 'ChatListTab' }
[SHARE] → ShareInbox       { files: 1 }
📋 Copying file → …/files/<App>/Sent/Images/….jpg
user/media/upload services
```

Where it stops tells you which bug you have:

| Last line seen | Bug |
|---|---|
| only `START …` | native drop — #4/#9; check for `from uid <app-uid>` |
| `[onChange]` but no `[SHARE] intent received` | gate never ran — #6 or #8 |
| `intent received` then nothing | effect cancelled mid-wait — #6 |
| `dropped: navigation never settled` | boot chain stuck — #7, or backend hanging |
| `→ ShareInbox` then `NetworkError` | uri/upload — #10 or #11 |

Confirm the picker really appeared:

```bash
adb shell screencap -p /sdcard/s.png && adb pull /sdcard/s.png .
```

### Do NOT test with synthetic `adb` intents

```bash
# Looks right. Is a TRAP.
adb shell am start -a android.intent.action.SEND -t image/jpeg \
  --eu android.intent.extra.STREAM content://media/external/images/media/107 \
  -n <pkg>/.MainActivity --grant-read-uri-permission
```

`adb` **cannot delegate a MediaStore grant**, so you get
`SecurityException: <pkg> has no access to content://…` and a bogus `NetworkError`
that is entirely your test's fault. Worse, the failed upload is **persisted into
the real outbox** and retries forever, polluting the logs.

Only a real Gallery/Files share carries the uri grant. Test by hand.

> If a bogus row does get stuck: the **only** clean removal is deleting the failed
> message bubble in the UI — that path cancels the registry entry and re-persists
> the queue. Editing `RKStorage` via `adb` is both risky (the app holds the SQLite
> file open) and useless (in-memory state just re-persists it).

---

## 9. Verification matrix

Run all of these. Bug #9 in particular only appears in some.

- [ ] Cold start (app force-stopped) → share 1 image
- [ ] **Warm app on chat list** → share 1 image ← catches #9
- [ ] **App in background** → share 1 image ← catches #9
- [ ] Share 2 images (`SEND_MULTIPLE`)
- [ ] Share 3 images
- [ ] Share a PDF / Drive document ← catches #11
- [ ] Share a URL from a browser ← catches #12
- [ ] Share text from another app
- [ ] Share **twice in a row** without restarting ← catches #8
- [ ] Repeat the two most fragile ones on iOS

For each: picker opens, chat selectable, media lands in the chat with a sent tick.

---

## 10. Maintenance gotchas

- **`npm install` wipes the Kotlin patch.** Re-run
  `node plugins/withShareIntentAndroidFix.js`, then rebuild Android.
- **Adding a new fix to the plugin?** Idempotency is per-replacement. Never
  reintroduce a single global marker.
- **Any iOS-side change** needs `npx expo prebuild -p ios` + `pod install`.
  `expo run:ios` alone will not pick it up.
- **`.env` is inlined at build time** (`react-native-dotenv`). Switching backends
  needs `npx expo start -c`, not just a reload. Auth tokens are **not** namespaced
  per backend, so switching envs requires a fresh login.
- **Don't let a second Metro squat on 8081.** `expo run:android` will build,
  install, launch, then **exit** — leaving no log stream and a bare shell prompt.

---

## 11. Known-open (deliberately not fixed)

- **A permission dialog appears on every share** when the device is in Android 13+
  *"Select photos only"* mode (`READ_MEDIA_VISUAL_USER_SELECTED` granted,
  `READ_MEDIA_IMAGES`/`VIDEO` denied). The share still completes; UX wart only.
- **Upstream payload-shape bug** (harmless): for single-file `ACTION_SEND` the
  library emits `"files": [ {…}, ["type","file"] ]` — the `"type" to "file"` pair
  is nested *inside* `arrayOf(...)` by mistake. `parseShareIntent` drops entries
  without a `path`, so the parsed result is correct.

---

## Appendix — Custom native (only if you drop the library)

Use **only** if you need full control and will own the native code plus a config
plugin to keep it prebuild-safe.

### A. Android — intent filters (`AndroidManifest.xml`)

```xml
<activity android:name=".MainActivity" android:exported="true"
          android:launchMode="singleTask" ... >
  <intent-filter>
    <action android:name="android.intent.action.SEND" />
    <category android:name="android.intent.category.DEFAULT" />
    <data android:mimeType="image/*" />
    <data android:mimeType="video/*" />
    <data android:mimeType="*/*" />
  </intent-filter>
  <intent-filter>
    <action android:name="android.intent.action.SEND_MULTIPLE" />
    <category android:name="android.intent.category.DEFAULT" />
    <data android:mimeType="image/*" />
    <data android:mimeType="*/*" />
  </intent-filter>
</activity>
```

`android:exported="true"` is mandatory on API 31+. Express it as a config plugin
(`withAndroidManifest`) so prebuild doesn't wipe it.

### B. Android — read the intent, copy `content://` → cache

```kotlin
private fun handleSendIntent(intent: Intent) {
  val uris: List<Uri> = when (intent.action) {
    Intent.ACTION_SEND -> intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let { listOf(it) } ?: emptyList()
    Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: emptyList()
    else -> emptyList()
  }
  val copied = uris.map { copyToCache(it) }
  // emit `copied` (+ intent.getStringExtra(Intent.EXTRA_TEXT)) to JS
}

private fun copyToCache(uri: Uri): String {
  val name = queryDisplayName(uri) ?: "shared_${System.currentTimeMillis()}"
  val out = File(cacheDir, name)
  contentResolver.openInputStream(uri)!!.use { input -> out.outputStream().use { input.copyTo(it) } }
  return "file://${out.absolutePath}"
}
```

RN cannot read `content://` directly — you **must** copy into your own cache and
hand JS a `file://` path. Guard every cursor read (see §3 #1).

### C. iOS — Share Extension target

Xcode → New Target → **Share Extension**; put the app **and** the extension in the
same App Group; set `NSExtensionPointIdentifier = com.apple.share-services` and an
honest `NSExtensionActivationRule`.

### D. iOS — extension → app handoff

```swift
let groupId = "group.com.chat.baatCheet.share"
let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupId)!
// copy each attachment into `container`, write a manifest to the shared
// UserDefaults, then open the host app via its URL scheme (talkstry://) to wake RN.
```

This is exactly the plumbing `expo-share-intent` generates — which is why the
library plus §3's patch is the recommended path.

---

## TL;DR — replicate in a new project

Do them in this order; each step's verification is in the linked section.

1. `npm install expo-share-intent` → add the plugin block (§2)
2. Copy `plugins/withShareIntentAndroidFix.js` + `plugins/withMergedAppGroups.js`;
   register both, merged-app-groups **last**
3. Run `node plugins/withShareIntentAndroidFix.js` → must print 4 applied fixes (§3)
4. `npx expo prebuild -p ios && cd ios && pod install` → verify `TalksTryShare.appex` (§4.1)
5. One `xcodebuild … -allowProvisioningUpdates build` (§4.3)
6. Copy `src/share/*` + `ShareInboxScreen`; wire `ShareIntentProvider`,
   `ShareIntentGate`, the `ShareInbox` route, and the `pendingShare` effect (§5)
7. **Update `BOOTING_ROUTES` to YOUR boot screens** — `grep -rn "navigation.reset(" src/screens` (§5.2)
8. **Update `appGroupsFor()`** in `withMergedAppGroups` to your real groups (§4.2)
9. Patch `copyToAppFolder`'s `content://` branch (§5.7)
10. Add `markMediaFailed` + orphan reconciliation (§5.8)
11. Run the §0.5 sanity greps, then the §9 matrix — especially **"warm app"** and
    **"twice in a row"**

### The three things most likely to bite you in a new codebase

1. **`BOOTING_ROUTES` is project-specific.** Copy it blindly and the picker will
   flash and vanish on cold start, because *your* boot screens differ.
2. **`withMergedAppGroups` hardcodes group names.** If you have no NSE, or a
   different group, edit `appGroupsFor()` — otherwise you'll request an App Group
   that was never provisioned and iOS signing fails.
3. **`markMediaFailed` must be declared before the chat read path uses it.** In
   this repo it sits right after `setUploadProgress` (~line 682), *not* next to
   `sendMedia` (~8200), because the orphan reconciliation runs far earlier.

### Verified state of this repo (2026-08-06)

- All 10 touched files parse clean under `babel-preset-expo`
- Kotlin patch: 4/4 markers present; re-running the plugin is a no-op (idempotent)
- Both local plugins registered in `app.json`, merged-app-groups last
- 12/12 real-device shares passed (§9 matrix)
