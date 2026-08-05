# Share Target (Incoming Share) — Production Implementation Guide

Make **TalksTry** appear in the native Android/iOS share sheet so users can share
images, videos, PDFs, documents, text and multiple files **into** the app from
Gallery, Files, Chrome, Drive, Photos, etc. — then pick a chat and send.

> This guide is written for **this repo specifically**: Expo bare workflow
> (committed `android/` + `ios/`, custom config plugins in `plugins/`,
> `expo run:android|ios` / EAS builds), bundle id `com.chat.baatCheet`, an
> existing iOS App Group (`group.com.chat.baatCheet.notifications`), and the
> existing `sendMedia(mediaObj, options)` + `ChatScreen` + `ForwardMessageScreen`
> chat-picker pattern.

---

## 0. Key concept — "Share Target" ≠ "Share"

| Direction | What it means | Libraries |
| --- | --- | --- |
| **Outgoing** share | *Your* app pushes content out to other apps | `react-native-share`, `expo-sharing` |
| **Incoming** share (**what you want**) | Other apps push content **into** your app; your app shows in the OS share sheet | `expo-share-intent`, `react-native-receive-sharing-intent`, custom native |

**`react-native-share` and `expo-sharing` do NOT solve this.** They are the wrong
tool — they share *out*. Do not reach for them here.

---

## 1. Library comparison & recommendation

| Option | Incoming? | Expo config plugin | iOS Share Extension automated | Multiple files | Maintenance | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **`expo-share-intent`** | ✅ | ✅ | ✅ (generates target + App Group) | ✅ | Active | **✅ Recommended** |
| `react-native-receive-sharing-intent` | ✅ | ❌ (manual native) | ❌ (hand-build extension) | ✅ | Sporadic | Works, more manual |
| `react-native-share` | ❌ outgoing | – | – | – | Active | ❌ Wrong direction |
| `expo-sharing` | ❌ outgoing | – | – | – | Active (Expo) | ❌ Wrong direction |
| Custom native | ✅ | write your own plugin | build it yourself | ✅ | You own it | Only if you need full control (see Appendix) |

### Recommendation: `expo-share-intent`

Because this project already uses **config plugins** (`plugins/*`) and
**prebuild/EAS**, `expo-share-intent` fits natively: one plugin entry generates
the Android intent-filters, the iOS Share Extension target, the App Group wiring,
and gives you a `useShareIntent()` hook. It removes ~90% of the fragile native
work below (which is documented in the Appendix if you ever need it).

---

## 2. Install

```bash
npm install expo-share-intent
# peer deps used by the iOS extension bridge (already present in most Expo apps):
#   expo-linking is used internally; ensure it's installed
npx expo install expo-linking
```

Then **rebuild native** (the plugin only takes effect at prebuild time):

```bash
# committed native folders → regenerate them from config
npx expo prebuild --clean
# your existing custom plugins in plugins/* re-apply automatically (they're in app.json)

npx expo run:android      # or: eas build -p android --profile development
npx expo run:ios          # or: eas build -p ios  --profile development
```

> ⚠️ `prebuild --clean` **regenerates** `android/` and `ios/`. That is fine here
> because every native modification in this repo is expressed as a config plugin
> in `plugins/` (withCallFullScreen, withIosVoip, withNotificationServiceExtension,
> …) and re-runs automatically. If you ever hand-edited native files *outside* a
> plugin, move that edit into a plugin first, or you will lose it.

---

## 3. `app.json` configuration

Add `expo-share-intent` to the `plugins` array. Place it **after** your existing
plugins so its manifest/Info.plist merges apply last.

```jsonc
// app.json → expo.plugins  (append this entry)
[
  "expo-share-intent",
  {
    // iOS: what the Share Extension accepts. Counts cap multi-select.
    "iosActivationRules": {
      "NSExtensionActivationSupportsText": true,
      "NSExtensionActivationSupportsWebURLWithMaxCount": 1,
      "NSExtensionActivationSupportsImageWithMaxCount": 10,
      "NSExtensionActivationSupportsMovieWithMaxCount": 5,
      "NSExtensionActivationSupportsFileWithMaxCount": 10
    },
    // Android: single-share MIME types (ACTION_SEND)
    "androidIntentFilters": [
      "text/*",
      "image/*",
      "video/*",
      "audio/*",
      "application/pdf",
      "*/*"
    ],
    // Android: multi-share MIME types (ACTION_SEND_MULTIPLE)
    "androidMultiIntentFilters": ["image/*", "video/*", "*/*"],
    // Reuse the App Group family you already own so the extension can hand files
    // to the app. The plugin will add group.<bundle>.share-ext if omitted; keeping
    // an explicit, stable value avoids provisioning-profile churn.
    "iosAppGroupIdentifier": "group.com.chat.baatCheet.share"
  }
]
```

Notes specific to this repo:

- You already declare `group.com.chat.baatCheet.notifications` in
  `ios/TalksTry/TalksTry.entitlements`. App Groups capability is therefore
  **already enabled** on the App ID — you only need to **add** the new
  `group.com.chat.baatCheet.share` group in the Apple Developer portal for the
  App ID *and* let the plugin add it to the extension. (Two groups can coexist.)
- Keep `*/*` last in the Android list — it is the catch‑all for arbitrary
  documents (Drive, File Manager). More specific types above it give better
  labels/icons in the chooser.

---

## 4. React Native integration (TypeScript)

### 4.1 Provider at the app root

Wrap the tree with `ShareIntentProvider` **outside** navigation so the intent is
captured on cold start before the first screen mounts.

`App.js` — add the provider high in the tree (above `AppContent`):

```tsx
import { ShareIntentProvider } from "expo-share-intent";

// ...
<SafeAreaProvider>
  <ShareIntentProvider>
    <KeyboardProvider /* ...existing */>
      {/* ...existing providers... */}
    </KeyboardProvider>
  </ShareIntentProvider>
</SafeAreaProvider>
```

### 4.2 A single consumer that routes the share

Create `src/share/ShareIntentGate.tsx`. Mount it **inside** the
`NavigationContainer` (so it has `navigation`), e.g. rendered by `RootNavigator`
next to the stack. It waits for auth, then routes to a chat-picker.

```tsx
// src/share/ShareIntentGate.tsx
import { useEffect, useRef } from "react";
import { useShareIntent } from "expo-share-intent";
import { navigationRef } from "../Redux/Services/navigationService";
import { getStoredSession } from "../services/sessionManager";
import { normalizeShare } from "./ShareManager";

/**
 * Watches for an incoming OS share and routes it into the app:
 *   share detected → auth check → ShareInbox (chat picker) → ChatScreen (send)
 * Auth-gated: an unauthenticated user is sent to login; the share is dropped
 * (or you may persist it and replay post-login — see Production notes).
 */
export default function ShareIntentGate() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();
  const handledRef = useRef(false);

  useEffect(() => {
    if (!hasShareIntent || handledRef.current) return;
    handledRef.current = true;

    (async () => {
      const session = await getStoredSession();
      const authed = !!(session?.userInfo && session?.accessToken);

      const payload = normalizeShare(shareIntent); // → { files:[...], text }

      if (!authed) {
        // Not logged in: send to onboarding. (Optionally stash `payload`
        // and replay after login.)
        navigationRef.current?.navigate("UserAgree");
        resetShareIntent();
        handledRef.current = false;
        return;
      }

      navigationRef.current?.navigate("ShareInbox", { share: payload });
      resetShareIntent();
      handledRef.current = false;
    })();
  }, [hasShareIntent, shareIntent, resetShareIntent]);

  return null;
}
```

### 4.3 Normalizer — one shape for both platforms

```ts
// src/share/ShareManager.ts
export type SharedFile = {
  uri: string;          // file:// path RN can read/upload
  name: string;
  mimeType: string;
  size?: number;
  kind: "image" | "video" | "audio" | "document" | "text";
};

export type SharePayload = { files: SharedFile[]; text?: string };

const kindFromMime = (m = ""): SharedFile["kind"] => {
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("text/")) return "text";
  return "document";
};

// expo-share-intent gives { text, webUrl, files:[{ path, mimeType, fileName, size }] }
export function normalizeShare(intent: any): SharePayload {
  const rawFiles = Array.isArray(intent?.files) ? intent.files : [];
  const files: SharedFile[] = rawFiles.map((f: any) => {
    const uri = f.path?.startsWith("file://") ? f.path : `file://${f.path}`;
    const mimeType = f.mimeType || "application/octet-stream";
    return {
      uri,
      name: f.fileName || uri.split("/").pop() || `shared_${Date.now()}`,
      mimeType,
      size: f.size,
      kind: kindFromMime(mimeType),
    };
  });
  const text = intent?.text || intent?.webUrl || undefined;
  return { files, text };
}
```

### 4.4 Chat-picker screen (reuse the Forward pattern)

`ForwardMessageScreen` already lists chats from `useRealtimeChat().chatList` and
lets the user select receivers. Clone it as `ShareInboxScreen` — the only
difference is: on selecting **one** chat, navigate to `ChatScreen` with a
`pendingShare` param instead of forwarding message ids.

```tsx
// src/screens/chats/ShareInboxScreen.jsx  (model on ForwardMessageScreen.jsx)
// ...same chat list + search UI as ForwardMessageScreen...

const onSelectChat = (chat) => {
  navigation.replace("ChatScreen", {
    user: {
      _id: chat.userId, userId: chat.userId, id: chat.userId,
      name: chat.name, fullName: chat.name,
      profilePicture: chat.profilePicture || "",
    },
    chatId: chat.chatId ?? null,
    hasExistingChat: !!chat.chatId,
    // NEW: the payload ShareIntentGate produced
    pendingShare: route.params?.share,   // { files:[...], text }
  });
};
```

> For **multi-select** send (share to N chats at once) you can keep the
> `selectedReceivers` array from ForwardMessageScreen and loop `sendMedia` per
> chat headlessly — but the single-chat → open-thread flow above matches
> WhatsApp/Telegram UX and reuses ChatScreen's optimistic UI + upload queue.

### 4.5 Consume it in `ChatScreen` (reuse existing `sendMedia`)

`sendMedia(mediaObj, options)` (from `useChatLogic` via `useRealtimeChat`) already
does optimistic bubbles, compression, chunked upload, and OutboxWorker retry. So
the share flow **must not** re-implement sending — it just feeds files in.

```tsx
// inside ChatScreen, after sendMedia is available
const consumedShareRef = useRef(false);

useEffect(() => {
  const share = route.params?.pendingShare;
  if (!share || consumedShareRef.current) return;
  consumedShareRef.current = true;

  (async () => {
    for (const f of share.files || []) {
      await sendMedia(
        {
          file: {
            uri: f.uri,
            name: f.name,
            type: f.mimeType,
            size: f.size || 0,
          },
          type: f.kind === "document" ? "file" : f.kind, // map to your media types
        },
        {}, // options
      );
    }
    if (share.text) {
      // if only text/URL was shared, prefill the composer instead of sending
      setInputText?.((prev) => (prev ? prev + " " : "") + share.text);
    }
    // clear the param so a screen re-focus doesn't resend
    navigation.setParams({ pendingShare: undefined });
  })();
}, [route.params?.pendingShare, sendMedia]);
```

### 4.6 Register the screen + gate

```jsx
// src/navigations/RootNavigator.js
import ShareInboxScreen from "../screens/chats/ShareInboxScreen";
import ShareIntentGate from "../share/ShareIntentGate";

// inside <NavigationContainer> ... </NavigationContainer>, next to the stack:
<>
  <Stack.Navigator /* ...existing... */>
    {/* ...existing screens... */}
    <Stack.Screen name="ShareInbox" component={ShareInboxScreen} />
  </Stack.Navigator>
  <ShareIntentGate />
</>
```

---

## 5. Recommended project structure

```
src/
 ├── share/
 │    ├── ShareManager.ts        # normalizeShare(): OS payload → SharedFile[]
 │    ├── ShareIntentGate.tsx    # watch intent → auth → route to ShareInbox
 │    └── shareReplay.ts         # (optional) persist + replay after login
 ├── screens/chats/
 │    ├── ShareInboxScreen.jsx   # chat picker (cloned from ForwardMessageScreen)
 │    └── ChatScreen.jsx         # consumes route.params.pendingShare → sendMedia
 ├── navigations/RootNavigator.js
 └── services/                   # (existing) sessionManager, OutboxWorker, ...

android/  ios/                   # generated by prebuild + expo-share-intent plugin
```

---

## 6. Testing

### Android
- **Real device** (recommended) and **emulator** both work.
- Gallery → pick image → **Share** → *TalksTry* appears → tap → ShareInbox → send.
- File Manager / **Files by Google** → PDF → Share → TalksTry.
- Chrome → Share → text/URL → composer prefilled.
- Multi-select in Gallery → Share → several images → ACTION_SEND_MULTIPLE path →
  all appear in the picked chat.
- Verify **Android 12+**: the app launches from cold start via the intent (test
  with the app swiped away).

### iOS
- Photos → select → Share → *TalksTry* extension → pick chat → send.
- **Files** app → PDF/document → Share → TalksTry.
- Safari → Share → URL/text.
- Multi-photo select → Share (respects the `MaxCount` caps in `iosActivationRules`).
- **App Group check**: if files arrive empty, the extension and app are not on the
  same App Group — see Production notes.
- The Share Extension is a **separate process**: test it with the main app both
  **running** and **killed**.

---

## 7. Production considerations

- **App lifecycle / cold start** — `ShareIntentProvider` captures the intent
  before first render; `ShareIntentGate` runs the auth check once (`handledRef`)
  to avoid double-routing on re-render.
- **Background / re-entry** — reset the intent (`resetShareIntent()`) after
  routing so returning to the app later does not re-trigger the old share.
- **Authentication state** — gate on `getStoredSession()` (same check Splash
  uses). Two policies: (a) drop share + go to login, or (b) persist the payload
  (`src/share/shareReplay.ts` → AsyncStorage) and replay after successful login.
  Prefer (b) for UX.
- **Large files** — iOS Share Extensions have a **tight memory budget (~120 MB)**.
  Do **not** load a video into memory in Swift; copy the file into the App Group
  container and pass only the path (the `expo-share-intent` extension does this).
  On the RN side, your existing **chunked upload** (`utils/chunkedUpload.js`) and
  **OutboxWorker** handle big files + retries — reuse them, don't bypass.
- **Upload queue** — because you funnel through `sendMedia`, shares inherit
  optimistic bubbles + OutboxWorker retry automatically. Don't add a parallel
  uploader.
- **App-lock interaction** — a share opens the app from outside; your
  `AppLockGate` will re-lock. Wrap the share-open path the same way pickers are
  wrapped (`suspendAppLock()` / `resumeAppLock()` — see `services/appLockGuard.js`)
  if you want the lock to survive the hop, or intentionally require unlock first.
- **Security** — validate MIME/size before upload; treat shared URIs as
  untrusted; copy out of the OS temp/container promptly (both OSes may revoke the
  URI). Never execute or trust shared file contents.
- **Permissions** — receiving a share needs **no runtime permission** on either
  OS (the OS hands you the file). This is unrelated to your onboarding permission
  gate — do not add anything to `features/permissions` for this.
- **Play Store** — declared intent filters are fine; no policy form needed for
  being a share target.
- **App Store** — the Share Extension is reviewed as part of the app; give it the
  same bundle-id prefix (`com.chat.baatCheet.ShareExtension`) and keep its
  `NSExtensionActivationRule` honest (only the types you actually handle).

---

## Appendix — Custom native (only if you drop the library)

Use this **only** if you need full control and are willing to own the native
code + a config plugin to keep it prebuild-safe. Otherwise Section 2–4 is the
production path.

### A. Android — intent filters (`AndroidManifest.xml` on the main Activity)

```xml
<activity android:name=".MainActivity" android:exported="true" ... >
  <!-- single item -->
  <intent-filter>
    <action android:name="android.intent.action.SEND" />
    <category android:name="android.intent.category.DEFAULT" />
    <data android:mimeType="image/*" />
    <data android:mimeType="video/*" />
    <data android:mimeType="audio/*" />
    <data android:mimeType="application/pdf" />
    <data android:mimeType="text/plain" />
    <data android:mimeType="*/*" />
  </intent-filter>
  <!-- multiple items -->
  <intent-filter>
    <action android:name="android.intent.action.SEND_MULTIPLE" />
    <category android:name="android.intent.category.DEFAULT" />
    <data android:mimeType="image/*" />
    <data android:mimeType="video/*" />
    <data android:mimeType="*/*" />
  </intent-filter>
</activity>
```

- **`android:exported="true"`** is mandatory on Android 12+ (API 31) for any
  activity with an intent-filter.
- Express this as a **config plugin** (`plugins/withShareIntentFilters.js` using
  `withAndroidManifest`) so `prebuild` doesn't wipe it — matching how the other
  plugins in `plugins/` work.

### B. Android — read the intent (Kotlin, `MainActivity`/module)

```kotlin
// Read ACTION_SEND / ACTION_SEND_MULTIPLE, copy content:// URIs to app cache,
// emit file paths to JS via a DeviceEventEmitter / Expo module.
private fun handleSendIntent(intent: Intent) {
  val uris: List<Uri> = when (intent.action) {
    Intent.ACTION_SEND ->
      (intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))?.let { listOf(it) } ?: emptyList()
    Intent.ACTION_SEND_MULTIPLE ->
      intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: emptyList()
    else -> emptyList()
  }
  val copied = uris.map { copyToCache(it) }   // content:// → file:// (see below)
  // send `copied` (+ intent.getStringExtra(Intent.EXTRA_TEXT)) to JS
}

private fun copyToCache(uri: Uri): String {
  val name = queryDisplayName(uri) ?: "shared_${System.currentTimeMillis()}"
  val out = File(cacheDir, name)
  contentResolver.openInputStream(uri)!!.use { input ->
    out.outputStream().use { input.copyTo(it) }
  }
  return "file://${out.absolutePath}"
}
```

Content URIs (`content://…`) are not directly readable by RN — you **must** copy
them into your own cache and hand JS a `file://` path.

### C. iOS — Share Extension target

1. Xcode → File → New → Target → **Share Extension**
   (`ShareExtension`, bundle id `com.chat.baatCheet.ShareExtension`).
2. Add both the app **and** the extension to the **same App Group**
   (`group.com.chat.baatCheet.share`).
3. Extension `Info.plist`:

```xml
<key>NSExtension</key>
<dict>
  <key>NSExtensionPointIdentifier</key>
  <string>com.apple.share-services</string>
  <key>NSExtensionAttributes</key>
  <dict>
    <key>NSExtensionActivationRule</key>
    <dict>
      <key>NSExtensionActivationSupportsImageWithMaxCount</key><integer>10</integer>
      <key>NSExtensionActivationSupportsMovieWithMaxCount</key><integer>5</integer>
      <key>NSExtensionActivationSupportsFileWithMaxCount</key><integer>10</integer>
      <key>NSExtensionActivationSupportsText</key><true/>
      <key>NSExtensionActivationSupportsWebURLWithMaxCount</key><integer>1</integer>
    </dict>
  </dict>
</dict>
```

### D. iOS — extension → app handoff (Swift)

```swift
// ShareViewController: extract attachments, copy each into the App Group
// container, write a manifest to the shared UserDefaults, then open the host app.
let groupId = "group.com.chat.baatCheet.share"
let defaults = UserDefaults(suiteName: groupId)!
let container = FileManager.default
  .containerURL(forSecurityApplicationGroupIdentifier: groupId)!

func persist(_ url: URL) -> String {
  let dest = container.appendingPathComponent(url.lastPathComponent)
  try? FileManager.default.copyItem(at: url, to: dest)   // never load into memory
  return dest.path
}
// defaults.set(pathsAndTypes, forKey: "SharedItems")
// open the host app via its URL scheme (talkstry://share) to wake RN
```

The RN side then reads the App Group `UserDefaults`/container on launch. This is
exactly the plumbing `expo-share-intent` generates for you — which is why the
library is the recommended path.

---

## TL;DR

1. `npm install expo-share-intent` → add the plugin block (Section 3) →
   `npx expo prebuild --clean` → rebuild.
2. `ShareIntentProvider` in `App.js`; `ShareIntentGate` inside NavigationContainer.
3. `normalizeShare()` → `ShareInboxScreen` (clone of ForwardMessageScreen) →
   `ChatScreen` consumes `pendingShare` → your existing `sendMedia`.
4. Reuse `chunkedUpload` + `OutboxWorker`; add nothing to `features/permissions`.
```
