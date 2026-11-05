# Native Incoming-Call UI: Porting Guide (Android CallStyle + iOS CallKit)

How TalksTry rings like a phone call when the app is in the background, killed, or the
device is locked, and how to add the same behaviour to another React Native app.

- **Android:** a native full-screen `CallStyle` notification (green Answer, red Decline)
  that appears over the lock screen with the ringtone, posted by native code within
  ~100–200 ms of the FCM push, before the JS runtime has started.
- **iOS:** the system CallKit screen, raised by an APNs **VoIP (PushKit)** push. It works
  when the app is killed and the phone is locked.

This guide covers only the **ring, answer, and decline layer**. Your own call engine
(WebRTC, mediasoup, Agora…) and signalling are separate. Section 7 describes the
small event contract that joins the two.

> **Assumed stack:** Expo SDK 54 with prebuild (CNG), React Native 0.81, New Architecture,
> `@react-native-firebase/messaging`, `react-native-callkeep`,
> `react-native-voip-push-notification`, `react-native-webrtc`. On bare React Native, apply the
> config-plugin edits to the native files by hand.

---

## Contents

1. [What you get: behaviour matrix](#1-what-you-get-behaviour-matrix)
2. [Architecture](#2-architecture)
3. [Dependencies](#3-dependencies)
4. [Backend contract (do this first)](#4-backend-contract-do-this-first)
5. [Android implementation](#5-android-implementation)
6. [iOS implementation](#6-ios-implementation)
7. [Wiring into your call layer (JS)](#7-wiring-into-your-call-layer-js)
8. [Staleness, duplicate and session guards](#8-staleness-duplicate-and-session-guards)
9. [Test checklist](#9-test-checklist)
10. [Pitfalls we hit (read before debugging)](#10-pitfalls-we-hit-read-before-debugging)
11. [File copy and rename checklist](#11-file-copy-and-rename-checklist)

---

## 1. What you get: behaviour matrix

| Callee state | Android | iOS |
|---|---|---|
| App open | In-app ring screen (socket event) | In-app ring screen (socket); CallKit also rings if a VoIP push arrives |
| App backgrounded | Heads-up `CallStyle` notification, ringtone, Answer/Decline | CallKit banner |
| App killed (swiped away) | Native FCM service posts `CallStyle` + full-screen intent | VoIP push → AppDelegate → CallKit full screen |
| Phone locked | Full-screen intent launches the activity **over the keyguard** | CallKit lock-screen call UI |
| Do Not Disturb | Rings (channel has `setBypassDnd(true)`) | CallKit follows the system DND/Focus rules |
| Caller hangs up while ringing | `call_cancel` FCM → native `cancelIncoming` dismisses the ring at once | `call_cancel` (FCM/socket) → `reportEndCallWithUUID(…, 2)` |
| Decline while JS is dead | Persisted natively, sent to the server on next boot | CallKit buffers the End; replayed to JS via `didLoadWithEvents` |
| Answer while JS is dead | Answer opens the app; the launch intent carries `action:"accept"` | CallKit buffers the Answer; replayed to JS via `didLoadWithEvents` |
| Active call, app swiped away | Call continues (foreground service, `stopWithTask=false`) | Call continues while CallKit holds it (force-quit ends it) |

---

## 2. Architecture

### Android

```
FCM data push {type:"call", …}  (HIGH priority, no "notification" block)
        │
        ▼
CallMessagingService  (native, extends ReactNativeFirebaseMessagingService)
   ├─ type=call_cancel → ExpoCallUiModule.cancelIncoming(callId)        ← dismiss now
   └─ type=call → isFreshCallPush(ts) && shouldRingFor(recipientId)
                    └─ ExpoCallUiModule.renderIncoming(data)
                          ├─ NotificationManager.notify(callId.hashCode(), CallStyle)
                          └─ CallForegroundService.startForIncoming()   ← keeps the ring alive
        │
        │ (independently, RN-firebase also wakes JS)
        ▼
JS setBackgroundMessageHandler (index.js) → displayIncomingCall() → same id → refresh only

User taps:
  Answer       → PendingIntent.getActivity(launchIntent action="accept")   → MainActivity
  Full-screen  → PendingIntent.getActivity(launchIntent action="incoming") → MainActivity
  Decline      → PendingIntent.getBroadcast → CallActionReceiver
                    ├─ JS listening → emit "onCallAction" {action:"decline"}
                    └─ JS dead      → persistPendingDecline() (SharedPreferences)

MainActivity (singleTask, showWhenLocked, turnScreenOn)
   cold start → JS calls getInitialCallAction() → reads the launch intent extras
   warm       → OnNewIntent → CallUiBus.dispatch() → "onCallAction" event (parked if JS isn't listening)
```

### iOS

```
APNs VoIP push (apns-push-type: voip, topic: <bundleId>.voip)
        │
        ▼
AppDelegate.pushRegistry(didReceiveIncomingPushWith:)     ← runs even when killed
   ├─ ensure CallKit provider exists (seed settings + RNCallKeep() early init)
   ├─ cancel-type / wrong-user / duplicate → report a throwaway call and end it
   └─ RNCallKeep.reportNewIncomingCall(uuid, …)  SYNCHRONOUSLY  ← Apple rule
   └─ RNVoipPushNotificationManager.didReceiveIncomingPush → JS 'notification'
        │
        ▼
JS voipPushService → DeviceEventEmitter "call:push:incoming" {…, _voip:true}
JS nativeCallService.registerEvents
   ├─ didLoadWithEvents  (answer/end that happened BEFORE JS loaded)
   ├─ answerCall / endCall / didPerformSetMutedCallAction
   └─ didActivateAudioSession → start WebRTC audio now (manual audio)
```

---

## 3. Dependencies

```jsonc
// package.json
"@react-native-firebase/app": "^23.x",
"@react-native-firebase/messaging": "^23.x",
"@notifee/react-native": "^9.x",                  // optional Android fallback only
"react-native-callkeep": "^4.3.16",
"react-native-voip-push-notification": "^3.3.3",
"react-native-webrtc": "^124.x",                  // if your engine is native WebRTC
"expo-secure-store": "...",                       // iOS session marker (Keychain)
"expo-application": "...",                        // iOS: detect the APNs environment
"uuid": "...", "react-native-get-random-values": "..." // RFC4122 uuids for CallKit
```

`postinstall` must re-apply the `node_modules` patches (see §6.3 and §6.6):

```json
"postinstall": "node plugins/withCallKeepAndroidInteropFix.js && node plugins/withWebrtcCallKitAudioFix.js"
```

`app.json` plugin order used here:

```json
"plugins": [
  "@react-native-firebase/app",
  "@react-native-firebase/messaging",
  "./plugins/withCallFullScreen",
  "./plugins/withCallFcmService",
  "./plugins/withCallOnNewIntent",
  "./plugins/withIosVoip",
  "./plugins/withCallKeepAndroidInteropFix",
  "./plugins/withWebrtcCallKitAudioFix"
]
```

iOS `infoPlist`:

```json
"UIBackgroundModes": ["remote-notification", "audio", "voip"],
"NSUserActivityTypes": ["INStartCallIntent", "INStartAudioCallIntent", "INStartVideoCallIntent"]
```

Android `permissions` (the local module's manifest adds the rest):

```json
"android.permission.USE_FULL_SCREEN_INTENT",
"android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
"android.permission.FOREGROUND_SERVICE",
"android.permission.RECORD_AUDIO",
"android.permission.CAMERA"
```

---

## 4. Backend contract (do this first)

None of the client code can work around a wrong push. Most "it doesn't ring when the app
is killed" reports come from the backend payload.

### 4.1 Android: FCM, data-only, HIGH priority

> ❌ **Never put a `notification` block in a call push.** With the app in the background or
> killed, Android sends a `notification` message straight to the tray and
> **never calls `onMessageReceived`**. You get no full-screen screen and no ringtone.

```js
// firebase-admin
await admin.messaging().send({
  token: fcmToken,
  android: { priority: 'high', ttl: 45_000, directBootOk: true },
  data: {                                 // ALL values must be strings
    type: 'call',
    callId: String(call.callId),
    callerId: String(call.callerId),
    callerName: call.callerName || 'Incoming call',
    callerImage: call.callerImage || '',
    callType: call.media === 'video' ? 'video' : 'audio',
    ts: String(Date.now()),               // sent-at, epoch ms: stale-drop guard
    recipientId: String(call.calleeId),   // optional: wrong-account guard (§8)
    // group calls only: isGroup:'true', groupId, groupName, isConference:'true'
  },
});
```

Cancel (caller hung up or ring timed out). Send this to every callee device:

```js
data: { type: 'call_cancel', callId: String(call.callId) }   // same HIGH priority, ttl 30s
```

Optional missed-call push: `type: 'call-missed'` with the same fields plus `chatId`.

### 4.2 iOS: APNs VoIP (PushKit)

The app sends a **separate** VoIP token (not the FCM/APNs alert token). Store both per device.

| Header / field | Value |
|---|---|
| Path | `POST /3/device/{voipToken}` |
| Host | `api.sandbox.push.apple.com` for **Debug** builds; `api.push.apple.com` for TestFlight/App Store |
| `apns-topic` | `<bundleId>.voip` (the `.voip` suffix is required) |
| `apns-push-type` | `voip` |
| `apns-priority` | `10` |
| `apns-expiration` | `0` |
| Auth | `.p8` token key (JWT) or a VoIP Services certificate |

```jsonc
// body: NO "aps" dictionary, custom keys only
{
  "uuid": "E621E1F8-C36C-495A-93FC-0C247A3E6E5F", // REQUIRED, valid RFC4122, one per call
  "callId": "sig_<callerId>_<ms>",
  "callerId": "…", "callerName": "…", "callerImage": "https://…",
  "callType": "audio",                             // or "video"
  "ts": 1783072628459,                             // REQUIRED: sent-at epoch ms
  "recipientId": "…"                               // optional wrong-account guard
}
```

Rules that will break you if ignored:

- **`uuid` must be a real RFC4122 UUID.** CallKit rejects anything else, and iOS kills the
  app for not reporting a call. Do not reuse your `sig_…` call id. Mint a uuid per call
  and keep `uuid ↔ callId` on the server so cancels can carry it.
- **Environment must match the build.** A Debug (sandbox) token sent to the production
  host returns `400 BadDeviceToken` and nothing rings. The client reports which environment
  it is on (§6.5) so the server can choose the host.
- **Do not send cancels over VoIP.** Every VoIP push must ring CallKit. Send cancels over
  FCM data or the socket. The AppDelegate still handles a cancel-type VoIP push safely
  in case one arrives.

### 4.3 Token registration

The client sends tokens over the socket on every connect:

```
"notification:device:register" { deviceId, pushProvider: "fcm"|"apns", pushToken, voipToken?, voipEnv?, deviceInfo }
```

Clear the tokens on logout. Prune tokens that FCM or APNs report as unregistered.

---

## 5. Android implementation

### 5.1 The local native module `modules/expo-call-ui`

Copy the whole folder. It is an Expo local module (Android-only) with this layout:

```
modules/expo-call-ui/
├─ expo-module.config.json        { "platforms": ["android"], "android": { "modules": ["expo.modules.callui.ExpoCallUiModule"] } }
├─ package.json                   (name "expo-call-ui", main "index.ts")
├─ index.ts                       JS bridge (requireOptionalNativeModule → null-safe everywhere)
└─ android/
   ├─ build.gradle                needs androidx.core:core-ktx ≥ 1.9 (CallStyle); uses 1.13.1
   └─ src/main/
      ├─ AndroidManifest.xml      permissions + receiver + service (merged into the app)
      └─ java/expo/modules/callui/
         ├─ ExpoCallUiModule.kt   the notification, channel, intents, cold-start, keyguard, guards
         ├─ CallForegroundService.kt  ring FGS + ongoing-call FGS
         └─ CallActionReceiver.kt     Decline / Hang up taps
```

Add it to `package.json` as `"expo-call-ui": "file:./modules/expo-call-ui"` (or let Expo
autolink `modules/`).

> Delete `modules/expo-call-ui/android/.gradle/` if you copy it. That folder is build cache.
> `ExpoCallUiModule.kt` also contains a `shareFile` function that is not call-related. Drop
> it if you don't need it.

### 5.2 Module manifest

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_CAMERA" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_PHONE_CALL" />
<uses-permission android:name="android.permission.MANAGE_OWN_CALLS" />
<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />

<application>
  <receiver android:name=".CallActionReceiver" android:exported="false" />
  <service
    android:name=".CallForegroundService"
    android:exported="false"
    android:stopWithTask="false"
    android:foregroundServiceType="microphone|camera|phoneCall|shortService" />
</application>
```

`stopWithTask="false"` lets an active call survive the user swiping the app out of
Recents. **Do not remove** the microphone/camera FGS permissions. If the Play Console warns
about them, fill in the foreground-service declaration; no code change is needed.

### 5.3 The notification channel

Notification channels are **immutable once created**. To change the sound or DND behaviour,
create a new channel id (this is why ours is `_v2`).

```kotlin
const val CHANNEL_ID = "calls_fullscreen_v2"

val channel = NotificationChannel(CHANNEL_ID, "Incoming Calls", NotificationManager.IMPORTANCE_HIGH).apply {
  setShowBadge(false)
  enableVibration(true)
  vibrationPattern = longArrayOf(0, 900, 700, 900)
  lockscreenVisibility = Notification.VISIBILITY_PUBLIC
  setBypassDnd(true)
  setSound(
    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
    AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)   // loud and looping, like a phone
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()
  )
}
```

### 5.4 The CallStyle notification (the core)

`ExpoCallUiModule.buildIncomingNotification(...)`, simplified:

```kotlin
val person = Person.Builder().setName(callerName).setImportant(true).build()

// Answer = getActivity (NOT a broadcast that then calls startActivity: Android 10+ blocks
// background activity starts, so the Answer button would not open the app).
val answer = PendingIntent.getActivity(ctx, (callId + "answer").hashCode(),
  launchIntent(ctx, "accept", callId, …), FLAG_UPDATE_CURRENT or FLAG_IMMUTABLE)

// Decline = broadcast. It doesn't open the app.
val decline = PendingIntent.getBroadcast(ctx, (callId + "decline").hashCode(),
  Intent(ctx, CallActionReceiver::class.java).setAction(ACTION_DECLINE).putExtra(…), flags)

// Full-screen / body tap = getActivity with action "incoming" (shows your ring screen).
val fsi = PendingIntent.getActivity(ctx, (callId + "fsi").hashCode(),
  launchIntent(ctx, "incoming", callId, …), flags)

NotificationCompat.Builder(ctx, CHANNEL_ID)
  .setSmallIcon(notificationIcon)
  .setContentTitle(callerName)
  .setContentText(if (isVideo) "Incoming video call" else "Incoming voice call")
  .setCategory(NotificationCompat.CATEGORY_CALL)
  .setPriority(NotificationCompat.PRIORITY_MAX)
  .setOngoing(true).setAutoCancel(false)
  .setTimeoutAfter(60_000L)          // hard cap if the cancel push never arrives
  .setContentIntent(fsi)
  .setFullScreenIntent(fsi, true)
  .setStyle(NotificationCompat.CallStyle.forIncomingCall(person, decline, answer).setIsVideo(isVideo))
  .build()
```

`launchIntent` is the app's launch intent with the call extras plus a timestamp:

```kotlin
ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)!!.apply {
  addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
  putExtra("callAction", action)      // "accept" | "incoming" | "ongoing"
  putExtra("callId", callId); putExtra("callerId", …); putExtra("callerName", …)
  putExtra("callerImage", …); putExtra("callType", …)
  putExtra("callLaunchTs", System.currentTimeMillis())   // used by the keyguard backstop
}
```

**The notification id is always `callId.hashCode()`.** The native FCM path and the JS path
therefore post the *same* notification, so a JS re-post refreshes it and never shows a
second one.

`render()` posts the notification **and** hands it to the foreground service (§5.5). It
first checks the "recently cancelled" memory so a dead call is never re-rung:

```kotlin
fun render(ctx, callId, …) {
  if (wasCancelled(callId)) return
  NotificationManagerCompat.from(ctx).notify(callId.hashCode(), notification)
  postedIncomingIds.add(callId.hashCode())
  CallForegroundService.startForIncoming(ctx, callId, …, fullScreen = true)
}
```

### 5.5 Foreground service: ring vs ongoing (FGS type rules)

A plain notification gets **dropped by the OS** when the app leaves the foreground. The
user pressed Home and the ring disappeared. So the service takes ownership of the ring
notification under the **same id**.

The FGS type matters, and getting it wrong causes silent calls:

| Phase | Started from | Type to use | Why |
|---|---|---|---|
| Ringing | background (push, screen off) | API 34+: `SHORT_SERVICE` first, then `PHONE_CALL`; older: `PHONE_CALL` | A background-started FGS **cannot** use microphone/camera; `phoneCall` needs a default dialer / self-managed ConnectionService |
| Answered / ongoing | foreground (user tapped Answer) | `MICROPHONE` (+ `CAMERA` for video) | Needed so capture keeps working while backgrounded |

Two traps in `CallForegroundService.kt`, both already handled:

1. **Android 14 will not convert `SHORT_SERVICE` into `MICROPHONE`** on the same instance.
   Before claiming the microphone, call `stopForeground(STOP_FOREGROUND_REMOVE)` and then
   `startForeground(…, MICROPHONE)` (`demoteShortServiceIfNeeded()`). Without this, every
   answered call ran as a shortService with no mic access, so the call connected but had no
   audio.
2. **Stopping before `startForeground()` has run crashes the app**
   (`ForegroundServiceDidNotStartInTimeException`). `stop()` is deferred while a start is
   pending (`pendingStarts` counter + `deferredStopPending`), and the service calls
   `stopSelf(startId)`, never a plain `stopSelf()`.

If promotion fails entirely, the service stops itself. A started service that never
becomes foreground would get the whole app killed by the 5 s watchdog.

The ongoing-call notification (`CallStyle.forOngoingCall`, Hang up, live chronometer) uses a
separate `IMPORTANCE_LOW` channel `calls_ongoing` and the fixed id `424242`. States:
`ringing` ("Calling…"), `connecting` ("Connecting…", no timer), and `ongoing` (chronometer
starting at `startedAt`).

### 5.6 Decline receiver and pending declines

```kotlin
class CallActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val callId = intent.getStringExtra(EXTRA_CALL_ID) ?: return
    when (intent.action) {
      ACTION_DECLINE -> {
        ExpoCallUiModule.cancelIncoming(context, callId)          // stop ring + FGS, remember cancel
        if (CallUiBus.isObserving()) CallUiBus.dispatch(mapOf("action" to "decline", "callId" to callId, …))
        else ExpoCallUiModule.persistPendingDecline(context, callId, callerId)  // commit(), sync
      }
      ACTION_HANGUP -> { CallForegroundService.stop(context); CallUiBus.dispatch(mapOf("action" to "hangup", "callId" to callId)) }
    }
  }
}
```

The receiver does not call the reject API itself because the access token is in
SecureStore, which native code cannot read. JS sends the reject after auth instead (§7.3).

### 5.7 Native FCM service: `plugins/withCallFcmService.js`

This makes a killed phone ring instantly. Without it, the ring waits for the React Native
cold start (several seconds under Doze), and the caller's ring often times out first.

The plugin does three things:

1. **Writes** `CallMessagingService.kt` into the app package:

```kotlin
class CallMessagingService : ReactNativeFirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    try {
      val data = remoteMessage.data
      if (data["type"] == "call_cancel") { ExpoCallUiModule.cancelIncoming(applicationContext, data["callId"]); return }
      if (data["type"] == "call") {
        val ts = data["ts"]?.toLongOrNull() ?: 0L
        if (ExpoCallUiModule.isFreshCallPush(applicationContext, ts) &&
            ExpoCallUiModule.shouldRingFor(applicationContext, data["recipientId"])) {
          ExpoCallUiModule.renderIncoming(applicationContext, data)
        }
        return   // RN-firebase still delivers to the JS handler via its own receiver
      }
    } catch (_: Throwable) { /* never swallow a normal message */ }
    super.onMessageReceived(remoteMessage)
  }
}
```

2. **Registers** it in the manifest with `<intent-filter android:priority="1">` on
   `com.google.firebase.MESSAGING_EVENT`, which is higher than RN-firebase's default.
   Because it is a *subclass*, token refresh and message delivery are inherited.
3. **Adds** `firebase-bom` + `firebase-messaging` to `app/build.gradle`. RN-firebase pulls
   them in as `implementation`, so the app cannot see `FirebaseMessagingService` without
   this. Keep the BoM version aligned with your RN-firebase version.

### 5.8 Lock screen and intents: `withCallFullScreen.js`, `withCallOnNewIntent.js`

- `withCallFullScreen` adds `USE_FULL_SCREEN_INTENT` and sets
  `android:showWhenLocked="true"` and `android:turnScreenOn="true"` on `.MainActivity`.
  Without these, the full-screen intent cannot draw over the keyguard.
- `withCallOnNewIntent` adds this to `MainActivity.kt`:

```kotlin
override fun onNewIntent(intent: Intent) {
  setIntent(intent)          // ReactActivity never does this
  super.onNewIntent(intent)
}
```

`MainActivity` is `singleTask`, so an Answer tap on a running app arrives in `onNewIntent`.
Without `setIntent`, `getIntent()` keeps returning the *original* launch intent. The module
would then replay an old call action and miss the one being answered.

### 5.9 Delivering actions to JS (cold start vs warm)

The module keeps a process-wide `CallUiBus`:

```kotlin
object CallUiBus {
  @Volatile var module: ExpoCallUiModule? = null
  @Volatile var pending: Map<String, Any?>? = null
  fun dispatch(payload: Map<String, Any?>) {
    val m = module
    if (m != null && m.isObservingActions) m.emit(payload) else pending = payload   // park, don't drop
  }
}
```

- `OnStartObserving("onCallAction")` sets `isObservingActions = true` and flushes `pending`.
- `OnNewIntent` → `readCallIntent(intent)` → `CallUiBus.dispatch`. This is the warm app
  path. The event is parked if JS isn't listening yet, which happens when the user taps
  Answer while the full-screen intent is still booting the app.
- `getInitialCallAction()` returns `pending`, or else the launch intent's extras. It
  **consumes** them by removing the `callAction` extra so they can't replay, and cancels
  the notification.
- `peekInitialCallLaunch()` is the same read without consuming. Use it to paint a
  "cold-start cover" call screen from the very first frame.

### 5.10 Keyguard backstop (no app content over the lock screen)

`showWhenLocked` is on in the manifest, so **any** resume would draw the app over the lock
screen. The module bounces the activity behind the keyguard unless a call justifies it:

```kotlin
OnActivityEntersForeground {
  if (callActive) return                                 // JS sets this via setCallActive(true)
  if (isFreshCallLaunch(activity.intent)) return         // cold-start call launch, JS not up yet (≤90s)
  if (!km.isKeyguardLocked) return
  if (km.isDeviceLocked) { activity.moveTaskToBack(true); return }
  // keyguard still animating out after an unlock → recheck in 700 ms, don't bounce a just-unlocked app
  decorView.postDelayed({ if (!callActive && km.isKeyguardLocked) activity.moveTaskToBack(true) }, 700)
}
```

JS also calls `setShowWhenLocked(inCall)` at runtime and `returnToLockScreen()` when a call
that started on a locked device ends.

### 5.11 JS: background handler and the fallback chain

`index.js`. These must be registered at module top level, before `registerRootComponent`:

```js
import { registerBackgroundHandler } from './src/firebase/fcmService';
import { registerNotifeeBackground } from './src/firebase/callNotifee';
registerBackgroundHandler();
registerNotifeeBackground();   // only needed for the notifee fallback
```

Inside `setBackgroundMessageHandler`:

```js
if (!(await hasActiveSession())) return;                    // logged out → never ring
if (data.type === 'call_cancel') return dismissIncomingCallNotification(data.callId, data.uuid);
if (data.type === 'call-missed') return displayMissedCallNotification(data);
if (data.type === 'call') {
  if (await isStaleCallPushSkewAware(data)) return;         // §8
  const shown = await displayIncomingCallNotifee(data);     // 1) ExpoCallUi CallStyle  2) notifee FSI
  if (!shown) await presentIncomingCallNotification(data);  // 3) expo-notifications heads-up
  postRingingAck(data.callId);                              // tell the caller "Ringing…"
}
```

The native service has usually already rung by this point. The JS call refreshes the same
notification id with a better caller name (resolved against the local contacts DB). Before
posting, `displayIncomingCallNotifee` checks `ExpoCallUi.wasIncomingCancelled(callId)`
because the caller may have hung up during the JS cold start.

### 5.12 OEM and permission reliability

Killed-app delivery fails on many OEM skins (MIUI, FuntouchOS, ColorOS…) unless the user
grants exemptions. The module provides:

| JS function | Purpose |
|---|---|
| `isIgnoringBatteryOptimizations()` / `requestDisableBatteryOptimization()` | Doze exemption |
| `openAutoStartSettings()` / `getManufacturer()` | Jump to the OEM "Autostart" screen (Xiaomi, Vivo, Oppo, OnePlus, Huawei…) |
| `canUseFullScreenIntent()` / `openFullScreenIntentSettings()` | Android 14+ can revoke the FSI permission; without it a locked phone only shows a heads-up |
| `areNotificationsEnabled()` / `isCallChannelEnabled()` | Nothing rings if these are off |

Show this as a one-time onboarding (ours is `CallReliabilityGate`). Also request
`POST_NOTIFICATIONS` on Android 13+.

---

## 6. iOS implementation

> Requires a **physical iPhone** and a dev/release build. PushKit and CallKit do nothing
> in the simulator or Expo Go.

### 6.1 Capabilities: `plugins/withIosVoip.js`

1. **Entitlement** `aps-environment = $(APS_ENVIRONMENT)`, with the build setting
   `APS_ENVIRONMENT` set per configuration on the **main app target only**: Debug →
   `development`, Release → `production`. An Xcode Archive then ships `production`
   automatically.
   Find the target by its `.entitlements` path, **not by app name**. A name match silently
   broke after an app rename and shipped an empty entitlement, so the FCM token was null
   and VoIP registration failed.
2. **Background modes:** `voip`, `audio`, `remote-notification`.
3. **AppDelegate patches** (below), plus `RNVoipPushNotificationManager.voipRegistration()`
   in `didFinishLaunchingWithOptions` and `PKPushRegistryDelegate` conformance.
4. **Recents call-back:** forward `continue userActivity` to `RNCallKeep.application(...)`.

In the Apple developer portal, enable **Push Notifications** for the App ID. Create a
`.p8` APNs key (works for both VoIP and alerts) for the backend.

### 6.2 AppDelegate PushKit handler (merged, recommended version)

> In this repo the plugin (`withIosVoip.js`) and the on-disk
> `ios/TalksTry/AppDelegate.swift` have **drifted**. The plugin has the session guard,
> cancel-type handling and invalidation note. The on-disk file has the early
> `RNCallKeep()` init and the `CXCallObserver` duplicate logic. **Use this merged
> version in the new app, and put it in the plugin** so prebuild cannot lose it.

```swift
import PushKit
import CallKit
import RNCallKeep
import RNVoipPushNotification
import Security

public class AppDelegate: ExpoAppDelegate, PKPushRegistryDelegate {
  // … template code …
  // in didFinishLaunchingWithOptions, before `return super.application(...)`:
  //   RNVoipPushNotificationManager.voipRegistration()

  // MARK: - PushKit (VoIP)

  private static var voipReported: [(uuid: String, at: Date)] = []
  private static let voipCallObserver = CXCallObserver()

  private static let sessionMarkerKey = "callSessionUserId"   // written by JS via expo-secure-store
  private static let sessionMarkerSignedOut = "none"
  private static let voipInvalidatedKey = "voipTokenInvalidatedAt"
  private static let voipCancelTypes: Set<String> = [
    "call_cancel", "call-cancel", "call_cancelled", "call-cancelled", "cancel",
    "call_ended", "call-ended", "call-missed", "call_missed"
  ]

  // expo-secure-store layout: generic password, service "app:no-auth" (legacy "app"),
  // account + generic attribute = key bytes.
  private static func keychainQuery(service: String, key: String) -> [String: Any] {
    let k = Data(key.utf8)
    return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrGeneric as String: k, kSecAttrAccount as String: k]
  }
  private static func readKeychainString(key: String) -> String? {
    for service in ["app:no-auth", "app"] {
      var q = keychainQuery(service: service, key: key)
      q[kSecReturnData as String] = true
      q[kSecMatchLimit as String] = kSecMatchLimitOne
      var item: CFTypeRef?
      if SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess,
         let d = item as? Data, let s = String(data: d, encoding: .utf8) { return s }
    }
    return nil
  }
  private static func writeKeychainString(_ value: String, key: String) {
    let base = keychainQuery(service: "app:no-auth", key: key)
    let upd: [String: Any] = [kSecValueData as String: Data(value.utf8)]
    if SecItemUpdate(base as CFDictionary, upd as CFDictionary) == errSecItemNotFound {
      var add = base
      add[kSecValueData as String] = Data(value.utf8)
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock   // readable when locked
      SecItemAdd(add as CFDictionary, nil)
    }
  }
  private static func shouldRejectForSession(recipientId: String?) -> Bool {
    guard let rid = recipientId?.trimmingCharacters(in: .whitespacesAndNewlines), !rid.isEmpty else { return false }
    guard let m = readKeychainString(key: sessionMarkerKey)?.trimmingCharacters(in: .whitespacesAndNewlines), !m.isEmpty else { return false }
    return m == sessionMarkerSignedOut || m != rid
  }

  // CallKit must have a provider AND a delegate before we report. On a killed app the JS
  // bundle loads seconds later; with no delegate, an early Answer is DROPPED and CallKit
  // sits on "Connecting…" forever.
  private static func ensureCallKitProvider() {
    if UserDefaults.standard.dictionary(forKey: "RNCallKeepSettings") == nil {
      // Fresh install / restore: JS setup() has never run. Same values JS uses.
      RNCallKeep.setup(["appName": "YourApp", "supportsVideo": true,
                        "maximumCallGroups": "1", "maximumCallsPerCallGroup": "1"])
    }
    _ = RNCallKeep()   // singleton: builds the provider + sets itself as delegate; RN reuses it
  }

  // Apple rule: every VoIP push must report a call. For pushes that must not ring,
  // report a throwaway call and end it. Reasons: 1 failed, 2 remoteEnded, 3 unanswered.
  private static func reportThenEnd(reason: Int32, completion: @escaping () -> Void) {
    let throwaway = UUID().uuidString
    RNCallKeep.reportNewIncomingCall(throwaway, handle: "YourApp", handleType: "generic",
      hasVideo: false, localizedCallerName: "YourApp", supportsHolding: false, supportsDTMF: false,
      supportsGrouping: false, supportsUngrouping: false, fromPushKit: true, payload: nil,
      withCompletionHandler: { RNCallKeep.endCall(withUUID: throwaway, reason: reason); completion() })
  }

  public func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    RNVoipPushNotificationManager.didUpdate(pushCredentials, forType: type.rawValue)
  }

  public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    AppDelegate.writeKeychainString(String(Int(Date().timeIntervalSince1970 * 1000)), key: AppDelegate.voipInvalidatedKey)
  }

  public func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload,
                           for type: PKPushType, completion: @escaping () -> Void) {
    let dict = payload.dictionaryPayload
    AppDelegate.ensureCallKitProvider()

    // RFC4122 or bust: a malformed uuid reaching CallKit gets the app killed.
    let uuid = UUID(uuidString: (dict["uuid"] as? String) ?? "")?.uuidString
      ?? UUID(uuidString: (dict["callId"] as? String) ?? "")?.uuidString
      ?? UUID().uuidString

    // 1) Cancel-type push: end the matching call, satisfy the rule, do NOT forward to JS.
    let pType = ((dict["type"] as? String) ?? "").lowercased()
    if AppDelegate.voipCancelTypes.contains(pType) {
      if RNCallKeep.isCallActive(uuid) { RNCallKeep.endCall(withUUID: uuid, reason: 2) }
      AppDelegate.reportThenEnd(reason: 2, completion: completion)
      return
    }

    // 2) Signed out / different account: never ring.
    let rid = (dict["recipientId"] as? String) ?? (dict["recipientId"] as? NSNumber)?.stringValue
    if AppDelegate.shouldRejectForSession(recipientId: rid) {
      AppDelegate.reportThenEnd(reason: 3, completion: completion)
      return
    }

    let callerName = (dict["callerName"] as? String) ?? "Incoming call"
    let hasVideo = ((dict["callType"] as? String) ?? "audio") == "video"

    // 3) Duplicate delivery (APNs double delivery / backend retry):
    //    still held or reported <5 s ago → re-report SAME uuid (CallKit rejects it, no 2nd ring)
    //    already ended → report under a FRESH uuid and end it at once (no ghost ring)
    let previous = AppDelegate.voipReported.first(where: { $0.uuid == uuid })
    let stillHeld = AppDelegate.voipCallObserver.calls.contains {
      $0.uuid.uuidString.caseInsensitiveCompare(uuid) == .orderedSame && !$0.hasEnded
    }
    let inFlight = previous.map { Date().timeIntervalSince($0.at) < 5 } ?? false
    let endedDuplicate = previous != nil && !stillHeld && !inFlight
    let reportUuid = endedDuplicate ? UUID().uuidString : uuid
    if previous == nil {
      AppDelegate.voipReported.append((uuid: uuid, at: Date()))
      if AppDelegate.voipReported.count > 8 { AppDelegate.voipReported.removeFirst() }
    }

    // 4) Report SYNCHRONOUSLY (iOS 13+ kills the app otherwise). No hold/DTMF unless your
    //    engine really supports them, or CallKit shows buttons that do nothing.
    RNCallKeep.reportNewIncomingCall(reportUuid, handle: callerName, handleType: "generic",
      hasVideo: hasVideo, localizedCallerName: callerName, supportsHolding: false, supportsDTMF: false,
      supportsGrouping: false, supportsUngrouping: false, fromPushKit: true, payload: dict,
      withCompletionHandler: {
        if endedDuplicate { RNCallKeep.endCall(withUUID: reportUuid, reason: 2) }
        completion()
      })

    // 5) Forward the WHOLE payload to JS (ts, group fields… everything).
    RNVoipPushNotificationManager.didReceiveIncomingPush(with: payload, forType: type.rawValue)
  }
}
```

Do **not** add manual `@objc(...)` selector annotations to these methods. Declaring
`PKPushRegistryDelegate` conformance makes Swift emit the right selectors. Hand-written
ones crashed with `doesNotRecognizeSelector` (SIGABRT).

### 6.3 Patches to `react-native-callkeep` (`plugins/withCallKeepAndroidInteropFix.js`)

These patch `node_modules`, so `npm install` reverts them. `postinstall` re-applies them.

| File | Patch | Symptom without it |
|---|---|---|
| `RNCallKeepModule.java` | Remove `@ReactMethod` from the 3-arg `displayIncomingCall` / `startCall` overloads | New arch: "Module exports two methods with the same name" → `require('react-native-callkeep')` fails on Android |
| `RNCallKeep.m` route change | `if (!_hasListeners) return;` before `sendEventWithName:RNCallKeepDidChangeAudioRoute` | With the early `RNCallKeep()` init, a route change before JS loads throws and kills the app mid-ring |
| `RNCallKeep.m` init | `removeObserver` before `addObserver` for route change | Every route change reached JS 3–4 times |
| `RNCallKeep.m` `performAnswerCallAction` | Replace `[self configureAudioSession]` (which calls `setActive:YES`) with `setActive:NO` + `setCategory:PlayAndRecord` only | Killed iPhone answered on the lock screen → `'!pri'` → session reset to AmbientSound → CallKit can't activate → **no mic for the whole call** |

Apple's rule: **never activate the audio session yourself inside a CallKit action.**
CallKit activates it and tells you via `didActivateAudioSession`.

### 6.4 JS CallKit bridge (`src/calls/services/nativeCallService.js`)

Copy this file and replace `'TalksTry'`. What it gets right:

- **`isAvailable()`** checks `Platform.OS === 'ios' && NativeModules.RNCallKeep`, not only
  that the JS package resolves. The JS package can load while the native pod is missing.
  Android does **not** use CallKeep's ConnectionService UI here; it has its own CallStyle.
- **`setup()`**: `handleType: ['generic','number']`, `includesCallsInRecents: true`,
  `maximumCallGroups: '1'`, `maximumCallsPerCallGroup: '1'`. With more than one, iOS offers
  "Hold & Accept", which a single-call engine cannot handle.
- **uuid ↔ callId map**. `registerCallUuid(callId, pushUuid)` binds your call id to the
  exact uuid the AppDelegate reported. If the id was already bound to another uuid (for
  example, the socket rang first), it ends the stale CallKit call. Otherwise you get
  two CallKit calls and a ghost that holds the audio session.
- **`displayIncomingCall`** dedupes (45 s) and never stacks a second incoming CallKit call.
- **`answerIncomingCall(callId)`** for an in-app accept. It files `CXAnswerCallAction`
  once per uuid, which dismisses the CallKit ring **and activates the audio session**.
- **`endCall(callId, reason)`**: reason > 0 uses `reportEndCallWithUUID`
  (2 remoteEnded, 3 unanswered…) so iOS shows the right outcome. It only ends uuids that
  CallKit knows.
- **Self-ended echo filter.** Every `endCall` you file comes back 1–2 s later as an
  `endCall` event. `markSelfEnded`/`wasSelfEnded` (15 s TTL) drop those echoes so they
  don't decline the *next* ring.
- **`registerEvents`** attaches `didLoadWithEvents` **first**. On a killed app, the
  Answer/End the user tapped before JS loaded is only delivered there, and you must call
  `RNCallKeep.clearInitialEvents()` afterwards or old events replay onto the next ring.
  Map `RNCallKeepPerformAnswerCallAction`, `RNCallKeepPerformEndCallAction`,
  `RNCallKeepDidActivateAudioSession` and so on onto the same handlers as the live
  listeners.
- **Outgoing calls:** do **not** call `startCall` at dial time. iOS times out the
  unfulfilled `CXStartCallAction` and ends your call after about two rings. Instead, report
  the call once it **connects** (`reportOutgoingConnected`), wait for
  `didReceiveStartCallAction`, then `reportConnectedOutgoingCallWithUUID`. This gives the
  caller the green pill / Dynamic Island timer.

### 6.5 JS VoIP token and push bridge (`src/calls/services/voipPushService.js`)

```js
VoipPush.addEventListener('register', (token) => setVoipToken(token));         // → socket register
VoipPush.addEventListener('notification', (p) => emit(INCOMING, toCallData(p)));
VoipPush.addEventListener('didLoadWithEvents', (events) => { /* replay token + push from cold launch */ });
VoipPush.registerVoipToken();
resolveVoipEnv();   // expo-application aps-environment → 'development' | 'production' (sent to server)
```

`toCallData()` passes **every** payload field through (`ts`, `isGroup`, `groupId`,
`isConference`, `recipientId`, `uuid`…) and sets `_voip: true`. That tells your call layer
that CallKit already shows this call, so it must not call `displayIncomingCall` again.

Call `registerVoipPush()` **at JS boot, not after auth**, so the push that cold-launched
the app replays into listeners that are already attached.

### 6.6 Audio: CallKit + react-native-webrtc (manual audio)

The problem: on a killed and locked phone, WebRTC creates its audio unit about 1.5 s after
the answer, before CallKit activates the session. The unit fails and nothing restarts it,
so the call is silent both ways.

The fix (`plugins/withWebrtcCallKitAudioFix.js` + `webrtcGlobals.js`) adds two sync methods
to `WebRTCModule`:

```objc
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(setManualAudio : (BOOL)manual) {
  [RTCAudioSession sharedInstance].useManualAudio = manual; return nil; }
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(setAudioEnabled : (BOOL)enabled) {
  [RTCAudioSession sharedInstance].isAudioEnabled = enabled; return nil; }
```

Drive them from JS:

```js
// once, before registerEvents (iOS):
NativeModules.WebRTCModule.setManualAudio(true);
// onAudioSessionActivated (CallKit didActivateAudioSession):
RTCAudioSession.audioSessionDidActivate();
WebRTCModule.setAudioEnabled(false); WebRTCModule.setAudioEnabled(true);   // fresh edge → (re)start unit
// onAudioSessionDeactivated:
RTCAudioSession.audioSessionDidDeactivate();
WebRTCModule.setAudioEnabled(false);
```

Add a safety net: when a call connects and no activation has arrived, enable audio anyway
(`ensureManualAudioEnabled`). If you skip `audioSessionDidDeactivate`, the *next* call is
silent.

> WebView-based engines (WKWebView WebRTC) **cannot** share CallKit's audio session.
> Answering on CallKit cuts all audio. Use native `react-native-webrtc` on iOS if you use
> CallKit.

### 6.7 Session marker (both platforms)

`src/calls/services/callSessionMarker.js` writes the signed-in user id (or `"none"` on
logout) where native code can read it before JS runs:

- iOS: `SecureStore.setItemAsync('callSessionUserId', id, { keychainAccessible: AFTER_FIRST_UNLOCK })`
- Android: `ExpoCallUi.setSessionMarker(id)` → SharedPreferences

Call it on login, bootstrap and logout. This stores **a user id, never a token**.

---

## 7. Wiring into your call layer (JS)

All push and notification sources are normalised to five `DeviceEventEmitter` events
(`src/firebase/callEvents.js`):

```js
export const CALL_PUSH_EVENTS = {
  INCOMING: 'call:push:incoming', // build ringing state (no auto-answer)
  ACCEPT:   'call:push:accept',   // user answered from the OS UI
  REJECT:   'call:push:reject',   // user declined from the OS UI
  HANGUP:   'call:push:hangup',   // Hang up on the ongoing notification
  RESUME:   'call:push:resume',   // body tap on the ongoing notification
};
```

Sources: the FCM foreground `onMessage`, `getInitialNotification`/`onNotificationOpenedApp`,
`ExpoCallUi.addCallActionListener` (`accept`, `decline`, `incoming`, `hangup`, `ongoing`),
`getInitialCallAction()`, the VoIP `notification` event, and the notifee fallback.

### 7.1 Listener timing

```js
// NOT auth-gated: attach immediately at mount, or a cold boot's event is lost.
useEffect(() => {
  const subs = [
    DeviceEventEmitter.addListener(CALL_PUSH_EVENTS.INCOMING, onPushIncoming),
    DeviceEventEmitter.addListener(CALL_PUSH_EVENTS.ACCEPT,   onPushAccept),
    DeviceEventEmitter.addListener(CALL_PUSH_EVENTS.REJECT,   onPushReject),
    DeviceEventEmitter.addListener(CALL_PUSH_EVENTS.HANGUP,   onPushHangup),
    DeviceEventEmitter.addListener(CALL_PUSH_EVENTS.RESUME,   onPushResume),
  ];
  return () => subs.forEach((s) => s.remove());
}, [...]);

useEffect(() => { const u = registerVoipPush(); return u; }, []);          // NOT auth-gated
useEffect(() => { nativeCall.setup(); return nativeCall.registerEvents(handlers); }, []);

// Auth-gated: these need the token / socket.
useEffect(() => { if (isAuthenticated) consumeInitialNotifeeCall(); }, [isAuthenticated]); // getInitialCallAction
useEffect(() => { if (isAuthenticated) replayPendingDeclines(); }, [isAuthenticated]);    // §7.3
```

### 7.2 The deferred accept (most important race)

On a cold start, the Answer (Android launch intent, or CallKit `didLoadWithEvents`) usually
arrives **before** the ringing state exists. A bare `accept()` against IDLE does nothing
and the call is lost: the user answered and the call still dropped.

```js
onAnswer: () => {
  const s = stateRef.current;
  if (s.status === INCOMING && !s.accepted) return accept();
  if (s.status === IDLE) {
    pushAcceptPendingRef.current = true;            // flush when INCOMING commits
    // keep pulling the server's pending-calls list every 2 s for ~40 s; if nothing
    // commits, nativeCall.endAllCalls() so CallKit isn't stuck on "Connecting…"
  }
  // ACCEPTED / ACTIVE → it's the echo of our own answerIncomingCall: ignore
},

// flush must be an EFFECT on state, not a callback:
useEffect(() => {
  if (state.status !== INCOMING || state.accepted) return;
  if (nativeEndPendingRef.current && Date.now() - nativeEndPendingRef.current < 45000) { reject(); return; }
  if (pushAcceptPendingRef.current) { pushAcceptPendingRef.current = false; accept(); }
}, [state.status, state.accepted]);
```

The same applies to End: a CallKit End on IDLE sets `nativeEndPendingRef = Date.now()`, so
the recovered ring is declined instead of ringing again.

`onEnd(callId)` rules:

- An id that is not the current call's → ignore (echo of the previous call's teardown).
- INCOMING and not accepted → `reject()`.
- INCOMING and accepted (still connecting) → `hangup()`, never `reject`.
- ENDED → ignore (our own echo).
- ACTIVE or OUTGOING → `hangup()`.

### 7.3 Pending declines (Android)

```js
const pending = getPendingDeclines();                 // persisted by CallActionReceiver
const { send } = selectDeclinesToSend(pending, { now: Date.now() });  // drop > ring window
send.forEach(({ callId, callerId }) => rejectCallSignal({ callId, callerId }));
clearPendingDeclines();
```

### 7.4 What your call layer must call back into native

| When | Android (`expo-call-ui`) | iOS (`nativeCallService`) |
|---|---|---|
| Ring shown in-app while foreground | `cancelAllIncomingCalls()` (one ring UI at a time) | — |
| User accepts in-app | `cancelAllIncomingCalls()` | `answerIncomingCall(callId)` |
| Answered, media connecting | `startOngoingCall({state:'connecting'})` | — |
| Media connected | `startOngoingCall({startedAt: connectedAt})` | `reportOutgoingConnected` (caller side only) |
| Mute toggled in-app | — | `setMuted(callId, muted)` (drop the echo for 3 s) |
| Call ringing, connecting or active | `setCallActive(true)`, `setShowWhenLocked(true)` | — |
| Call over | `stopOngoingCall()`, `setCallActive(false)`, `setShowWhenLocked(false)`; `returnToLockScreen()` if it started locked | `endCall(id, reason)` for each id, then `endAllCalls()` |
| Login / logout | `setSessionMarker(userId / 'none')` | `writeCallSessionMarker(userId / null)`; `resetAll()` on logout |
| Live socket ring received | `setServerClockOffset(serverTs − Date.now())` | (JS-only offset) |
| VoIP push with `uuid` | — | `registerCallUuid(callId, uuid)` |

---

## 8. Staleness, duplicate and session guards

FCM and APNs **buffer** high-priority pushes under Doze, offline or force-stop, then deliver
them in a burst. Without guards, opening the app rings every call from the last hour. The
same rules are implemented three times; keep them in step:
`src/calls/callPushGuards.js` (JS, unit-tested), `ExpoCallUiModule.kt`, and `AppDelegate.swift`.

| Rule | Value |
|---|---|
| Fresh | age ≤ **12 s** → ring immediately |
| Aged | 12–60 s → verify against the server's pending-calls list before ringing |
| Stale | > **60 s** → drop |
| Unknown clock offset | only drop if > **10 min** (a fast device clock must not silence live calls) |
| Age source | backend `ts`; fallback = the epoch at the end of `sig_<callerId>_<ms>`; group/conference: `ts` only (one call id for the whole call), and fail open |
| Cancel memory | a cancelled call id is remembered **120 s** natively; no render path re-rings it |
| Group re-invite | allowed after a cancel only if the invite's `ts` is later than the cancel time (+1 s margin with a learned offset, +5 s without) |
| Session | no `recipientId` or no marker → ring; marker `none` or a different user → don't ring (iOS: report and end) |
| Notification timeout | `setTimeoutAfter(60_000)` in case no cancel ever arrives |

Server clock offset: learn it from a live socket ring (`serverTs − receivedAt`) and push it
to native with `setServerClockOffset`. Native `isFreshCallPush` then judges by server time.

---

## 9. Test checklist

Test on **real devices**. On iOS, test cold answers on a **Release** build, because a Debug
cold start through Metro takes 20–40 s and distorts every timing.

**Android** (also test on one Xiaomi/Vivo/Oppo device):

- [ ] App swiped away, screen locked → full-screen call within ~1 s, ringtone, vibration
- [ ] Same with DND on → still rings
- [ ] Answer from the lock screen → app opens on the call screen, call connects, **audio both ways**
- [ ] Decline while killed → caller stops ringing right away, or at least once the callee app starts
- [ ] Caller hangs up while ringing → notification disappears immediately
- [ ] Press Home while ringing → notification stays in the tray
- [ ] Answered call longer than 3 minutes → still running (shortService → microphone demotion works)
- [ ] Swipe app from Recents during a call → call continues; Hang up from the notification works
- [ ] Phone offline for 5 minutes during a call attempt, then back online → **no** ghost ring
- [ ] Reboot, never open the app, receive a call → rings (`directBootOk`, battery/autostart granted)
- [ ] `adb shell dumpsys activity services <pkg>` during a call → `types=` includes microphone (0x80)

**iOS:**

- [ ] Killed + locked → CallKit full screen; Answer → **audio both ways** from the first second
- [ ] Answer within 1 s of the ring on a killed app → doesn't stick on "Connecting…" (early `RNCallKeep()` works)
- [ ] Decline on CallKit while killed → caller sees declined, and the next call is not auto-declined
- [ ] Caller cancels → CallKit ring disappears ("remote ended")
- [ ] Two calls back to back → the second call has audio (deactivation handled)
- [ ] Log out, then call that account → device does **not** ring
- [ ] Phone app Recents → tap the entry → dials back
- [ ] Release/TestFlight build with production APNs host → rings (check the server for `BadDeviceToken`)

---

## 10. Pitfalls we hit (read before debugging)

1. **FCM `notification` block** → no `onMessageReceived` when backgrounded, so no full screen. Data-only, HIGH priority.
2. **Answer as a broadcast trampoline** → Android 10+ blocks the activity start. Answer must be `PendingIntent.getActivity`.
3. **`singleTask` without `setIntent`** → stale launch extras replay an old call.
4. **Emitting to JS before it subscribes** → event silently lost. Park it (`CallUiBus.pending`) and flush on `OnStartObserving`.
5. **Ring FGS with microphone type** → refused from the background, so the ring disappears. Use `shortService`/`phoneCall` for ringing.
6. **shortService never upgraded to microphone** → answered calls silent and cut at 3 minutes. Demote first.
7. **`stopService` before `startForeground`** → app crash. Defer stops while a start is pending.
8. **Plain notification without an FGS** → dropped when the user presses Home while ringing.
9. **Changing an existing channel's sound** → no effect. Create a new channel id.
10. **Keyguard backstop bouncing the very first cold-start call** → allow fresh call-launch intents (≤90 s).
11. **Bounce during unlock animation** → the app closes right after the user unlocks. Check `isDeviceLocked` and recheck after 700 ms.
12. **JS re-post after the caller already cancelled** → stuck undismissable ring. Check the native cancel memory on every render.
13. **VoIP push without a synchronous CallKit report** → iOS kills the app and later stops delivering VoIP pushes. Report even for duplicates, cancels and wrong-user pushes.
14. **Invalid uuid** (for example the `sig_…` id) → app killed. Validate with `UUID(uuidString:)`.
15. **No CallKit delegate on a cold VoIP wake** → early Answer dropped, stuck on "Connecting…". `_ = RNCallKeep()` in the push handler.
16. **`setActive:YES` inside `performAnswerCallAction`** → `'!pri'`, AmbientSound, no mic. Set the category only; CallKit activates the session.
17. **WebRTC audio unit started before CallKit activation** → silent call. Use manual audio and re-edge on `didActivateAudioSession`.
18. **Not handling `didLoadWithEvents`** / not calling `clearInitialEvents()` → the cold Answer is lost, or an old End declines the next call.
19. **Echo of your own `endCall`** → declines the next ring. Filter self-ended uuids.
20. **CallKit `startCall` at dial time** → iOS ends the call after about two rings. Report outgoing calls only once connected.
21. **APNs environment mismatch** → `BadDeviceToken`, silent failure. Debug = sandbox, Release = production.
22. **Entitlement plugin matching by app name** → breaks on rename; empty `aps-environment`.
23. **`npm install` reverts `node_modules` patches** → keep them in `postinstall`.
24. **Native edits only in `android/` / `ios/`** → lost on `expo prebuild --clean`. Every native change must live in a config plugin.

---

## 11. File copy and rename checklist

Copy from this repo (`chatApp`) to the new app:

| From | Notes |
|---|---|
| `modules/expo-call-ui/` | Whole folder, without `android/.gradle/` |
| `plugins/withCallFullScreen.js` | As is |
| `plugins/withCallFcmService.js` | Check the `firebase-bom` version matches your RN-firebase |
| `plugins/withCallOnNewIntent.js` | Requires a Kotlin `MainActivity` |
| `plugins/withIosVoip.js` | **Replace its `PUSHKIT_METHODS` with the merged Swift from §6.2**; rename `TalksTry` |
| `plugins/withCallKeepAndroidInteropFix.js` | Patches both Android and iOS CallKeep; re-check anchors if the CallKeep version differs from 4.3.16 |
| `plugins/withWebrtcCallKitAudioFix.js` | Only if you use `react-native-webrtc` |
| `src/firebase/callEvents.js` | Event names and stale window |
| `src/calls/callPushGuards.js` (+ `__tests__/callPushGuards.test.js`) | Pure rules |
| `src/calls/services/nativeCallService.js` | Rename `TalksTry`; replace `markCallEvent` and `kv` with your own logger/storage |
| `src/calls/services/voipPushService.js` | Replace `setVoipToken`/`setVoipEnv`/`clearVoipToken` with your socket/token layer |
| `src/calls/services/callSessionMarker.js` | As is |
| `src/utils/voipEnv.js` | As is |
| `src/calls/native-engine/webrtcGlobals.js` (manual-audio part) | If you use `react-native-webrtc` |
| Call parts of `src/firebase/fcmService.js` and `src/firebase/callNotifee.js` | Take `registerBackgroundHandler`, `dismissIncomingCallNotification`, `displayIncomingCallNotifee`, `consumeInitialNotifeeCall`, `emitCallAction`; drop the chat/message parts |

Rename in the new app:

| Item | Where |
|---|---|
| App display name `TalksTry` | `withIosVoip.js` (`appName`, throwaway handle), `nativeCallService.js` setup, callNotifee strings |
| iOS bundle id → VoIP topic `<bundleId>.voip` | Backend APNs config |
| Android package | Automatic (plugins read `android.package`) |
| Notification icon | Drawable named `notification_icon` (falls back to `sym_action_call`) |
| Channel ids `calls_fullscreen_v2`, `calls_ongoing` | Keep, or rename once before the first release |

Build steps:

```bash
npm install                        # postinstall applies the node_modules patches
npx expo prebuild --clean          # generates android/ + ios/ with every plugin applied
cd ios && pod install && cd ..
# build a dev/release binary (Xcode / gradlew / EAS). An OTA/JS update can't ship any of this.
```

Then go through §9 on real devices.
