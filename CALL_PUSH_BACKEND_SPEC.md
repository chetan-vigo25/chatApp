# Incoming-call push — backend spec

For an incoming call to ring when the callee's app is **backgrounded, on another
app, or killed**, the backend must send a high-priority push to the callee's
CURRENT device token(s) the moment a call rings. A closed app cannot receive the
socket `call:incoming`, so this push is the ONLY way to ring it.

> ## 🚨🚨 CURRENT DECISION (2026-07-06) — iOS = send the VoIP push (native CallKit ring)
>
> The app has **CallKit ENABLED** (`IOS_CALLKIT_ENABLED=true`). The user wants the
> native iOS full-screen + banner ring over the lock screen / when the app is
> killed, and has accepted that call audio is broken on answer until the
> native-WebRTC migration (CALL_NATIVE_WEBRTC_MIGRATION_PLAN.md) lands. So for now:
>
> **iOS incoming call → send the VoIP push ONLY** (see §"iOS incoming call —
> PushKit"). It rings the native CallKit screen even killed/locked. Do **NOT** also
> send the FCM/APNs **alert** push for an incoming call to iOS — that adds a
> DUPLICATE "Incoming voice call" banner under the CallKit UI. On iOS the alert
> push is for **missed/cancelled** only (`type:"call-missed"`).
>
> **Android incoming call → send the FCM data push below** (CallStyle/notifee
> full-screen intent is its ring UI).
>
> | Callee platform | Incoming ring | Missed / cancelled |
> |---|---|---|
> | **iOS** (`apns`) | **VoIP push only** (§ PushKit), NO alert push | alert push, `type:"call-missed"` |
> | **Android** (`fcm`) | **FCM data push** (below) | data push, `type:"call-missed"` |
>
> ⚠️ Send the iOS VoIP push on EVERY ring — do NOT gate on the callee looking
> "online" (a swipe-killed app's socket looks connected 30-60s; gating skips the
> push and the phone shows nothing). And use the correct APNs environment
> (dev build = sandbox endpoint) + topic `com.chat.baatCheet.voip`.

> ## ⚠️ Deregister tokens on logout (REQUIRED — prevents "logged-out device still rings")
>
> When this device logs out, the client emits **`logout { deviceId, logoutAll:false }`**
> over the socket (see `AuthContext.logout` → `emitLogoutCurrentDevice`). On that
> event the backend **MUST deactivate/remove this device's `pushToken` AND
> `voipToken`** so it stops receiving call/message pushes immediately.
>
> - Without this, a logged-out (or even reinstalled) device keeps getting call
>   pushes because the backend still holds its token. The client has a backstop
>   (`hasActiveSession` drops pushes when no `accessToken` is stored), but the
>   backend should not be sending them at all — it wastes pushes and is the true
>   root cause of "logged out but still receives calls".
> - Re-activate the token only when the SAME device logs back in and re-registers
>   via `notification:device:register` (the client does this on every login/boot).
> - On iOS, also stop sending **VoIP** pushes to a logged-out `voipToken` — a VoIP
>   push is handled natively before any JS auth check, so the client cannot
>   suppress it.

## Two trigger points (handle at least one; both is fine — de-dupe on `callId`)

1. **Server-side on `call:ring`** (socket) — the handler that already receives the
   ring (e.g. `pushOfflineCallees`) sends the push to offline callees.
2. **Explicit REST trigger** — the caller's app calls, for each callee on every
   outgoing call:
   `POST /api/v2/user/call/notify  { peerId, media, callId }`
   The backend MUST respond by sending the FCM call push (below) to `peerId`'s
   device tokens. **If this endpoint 404s or doesn't push, closed-app callees are
   never notified** — the most common cause of "no call notification when the app
   is closed."

## Required FCM payload (data-only, priority high)

`type` MUST be the string `"call"`. All `data` values are strings.

```jsonc
{
  "token": "<callee's CURRENT FCM token>",
  "android": { "priority": "high" }, 
  "apns": {
    "headers": { "apns-priority": "10", "apns-push-type": "alert" },
    "payload": { "aps": {
      "alert": { "title": "<caller name>", "body": "Incoming voice call" },
      "category": "incoming_call", "sound": "default",
      "content-available": 1, "mutable-content": 1
    } }
  },
  "data": {
    "type": "call",                    // REQUIRED — handlers key off this
    "callId": "<app-socket signalId>", // same id used for call:* events
    "callerId": "<caller user _id>",
    "callerName": "<caller display name>",
    "callerImage": "<caller avatar url>",   // optional
    "callType": "audio"                // "audio" | "video"  (alias: "media")
  }
}
```

| `data` key | Req | Used for |
|---|---|---|
| `type` | ✅ | Must be `"call"`. Routes into the call flow. |
| `callId` | ✅ | Stored as `signalId`; lets Accept notify the caller + reconcile WebRTC. |
| `callerId` | ✅ | Without it the client ignores the push. |
| `callerName` | ✅ | Notification title / caller name. |
| `callType` | ✅ | `audio`/`video` icon + "voice/video call" text. |
| `callerImage` | – | Caller avatar. |

## Critical notes

- **Token freshness:** push to the device's CURRENT token. A fresh install /
  `expo run:android` ROTATES the token; the app re-registers it via the
  `notification:device:register` socket event (and on login under
  `device.fcmToken`). Push to the latest registered token, NOT a stale login-time
  one — otherwise delivery silently fails while the foreground socket path still
  works (looks like "foreground rings, background doesn't").
- **Data-only, not notification-only.** A `notification`-block-only message is
  shown by the OS on a default channel and the app's background handler never
  runs (no full-screen, no Accept/Decline). Put the fields under `data`.
- **Priority high** (Android) / `apns-priority 10` so it wakes a dozing device.

---

# iOS incoming call — PushKit (VoIP) + CallKit  ⟵ NEW

Android uses the FCM data push above. **iOS must use a separate APNs VoIP
(PushKit) push** to ring a backgrounded/terminated/locked device with the native
CallKit screen. A normal APNs alert push **cannot** show a call screen or run
code on a killed app; only a VoIP push can, and iOS 13+ **requires** the app to
report the call to CallKit in the same run loop (the app already does this
natively — see client status).

## Device token registration (already wired client-side)

On iOS the app registers a **PushKit VoIP token** (distinct from the APNs/FCM
token) via the existing `notification:device:register` socket event, now with an
extra field:

```jsonc
{
  "deviceId": "...",
  "pushToken": "<APNs token>",      // existing — alerts / data
  "pushProvider": "apns",
  "voipToken": "<PushKit VoIP token>", // NEW — iOS call pushes go here
  "deviceInfo": { ... }
}
```

Backend must **persist `voipToken`** per device and target it for call pushes on
iOS. (Android devices send no `voipToken`; keep using their FCM token.)

## Sending the iOS VoIP push

Send to APNs with these headers (HTTP/2 APNs or a provider SDK):

- `apns-push-type: voip`  (REQUIRED)
- `apns-topic: com.chat.baatCheet.voip`  ⟵ the **bundle id + `.voip`** suffix
- `apns-priority: 10`
- Auth: your APNs key/cert for the app.

Payload (no `aps.alert`; CallKit renders the UI from these fields):

```jsonc
{
  "uuid": "<RFC4122 UUID for this call>",   // CallKit call id — generate per call
  "callId": "<app-socket signalId>",         // same id as the Android push / call:* events
  "callerId": "<caller user _id>",
  "callerName": "<caller display name>",
  "callerImage": "<caller avatar url>",      // optional
  "callType": "audio"                         // "audio" | "video"
}
```

| key | Req | Used for |
|---|---|---|
| `uuid` | ✅ | The CallKit call UUID (RFC4122). If omitted the client falls back to `callId`, which must then itself be a UUID. |
| `callId` | ✅ | App signaling id — stored as `signalId`; ties CallKit accept → WebRTC reconcile + caller notify. |
| `callerId` | ✅ | Without it the client ignores the push. |
| `callerName` | ✅ | Shown on the CallKit screen. |
| `callType` | ✅ | Audio/video CallKit call. |
| `callerImage` | – | Optional. |

## Critical iOS notes

- **`apns-topic` MUST be `<bundleId>.voip`** (here `com.chat.baatCheet.voip`),
  not the plain bundle id — a VoIP push to the wrong topic is silently dropped.
- **Every VoIP push must result in a reported call.** Don't send a VoIP push for
  anything except a real incoming call (Apple throttles / can disable VoIP pushes
  for an app that receives them without reporting a call). For call **cancel**,
  use the socket `call:cancel` / the Android-style data push — NOT another VoIP
  push.
- Use **`apns-priority: 10`** and the **`voip` push type**.
- The VoIP token rotates; always push to the latest `voipToken` the device
  registered (same freshness rule as the FCM token).

## Recommended ring flow (both platforms)

On `call:ring`, branch by device platform:
- **iOS device** → send the **VoIP push** above to its `voipToken` — **on EVERY
  ring, do NOT gate on the callee looking "online/offline"**. When the user
  swipe-kills the app, the server-side socket can look connected for another
  30–60s (stale, not yet timed out). Gating on presence routes the ring to that
  dead socket and skips the push → the callee's phone shows nothing and only the
  missed-call alert arrives later. This is the classic "first call after killing
  the app doesn't ring; it rings again after the user reopens the app" bug.
  Always-send is safe: if the app happens to be alive, CallKit is the intended
  ring UI on iOS anyway (WhatsApp behaves the same) and the app de-dupes the
  socket event against the push on `callId`.
- **Android device** → send the **FCM data push** (top of this doc) to its FCM
  token (also best sent on every ring for the same stale-socket reason; the app
  de-dupes).

## APNs environment (sandbox vs production) — silent-drop trap

The `voipToken` a device registers is bound to the APNs environment of its build:
- **Debug / dev build (Xcode run)** → `aps-environment: development` → push via
  **`api.sandbox.push.apple.com`**.
- **TestFlight / App Store archive** → `production` → **`api.push.apple.com`**.

Sending a sandbox token to the production endpoint (or vice-versa) returns
`BadDeviceToken` and the push silently never arrives — while message alert
pushes may still work if they ride FCM. If dev-build testing never rings when
killed, check the backend is hitting the **sandbox** APNs endpoint for that
token (or log the APNs HTTP response; don't fire-and-forget).

---

## Client status

**Android (already implemented):**
- notifee / native `CallStyle` **full-screen intent** → app's full-screen call UI
  over the lock screen (`src/firebase/callNotifee.js`, `modules/expo-call-ui`).
- **Active-call ongoing foreground service** (duration timer + Hang up) — NEW.

**iOS (implemented this change — requires a dev/EAS rebuild):**
- `react-native-callkeep` (CallKit) + `react-native-voip-push-notification`
  (PushKit) wired via `plugins/withIosVoip.js` (entitlement + AppDelegate) and
  `src/calls/services/{nativeCallService,voipPushService}.js`.
- The AppDelegate PushKit handler reports the call to CallKit synchronously, then
  forwards to JS to wake the WebRTC (WebView) engine.
- **Does nothing in Expo Go** — native modules require a custom dev/EAS build.
