# Backend Handoff — iOS incoming call not ringing when app is killed / locked

**To:** Backend developer
**From:** Mobile app side
**Priority:** High — this is the only remaining blocker for WhatsApp-style incoming calls on iOS.

---

## TL;DR

When an iPhone is **locked** and the app is **killed / not running in background**, the
incoming call must ring **full-screen instantly** (like WhatsApp).

- ✅ **The app side is 100% done.** No app changes are needed or will be made.
- 🔴 **The backend must send an APNs VoIP (PushKit) push** the moment a call rings.
  Right now the backend is **not** sending this push, so a killed/locked iPhone
  never rings.

A killed app **cannot** receive the socket `call:incoming` event — it is not
running. The **only** way iOS lets us wake a killed app and show a native call
screen is an **APNs VoIP push**. This can only be sent by your server.

Please implement the 3 backend tasks below. Everything the server needs (the
device's VoIP token) is already being sent to you by the app.

---

## What the app already does (for your context — no action needed)

1. On login/boot, the iOS app registers a **PushKit VoIP token** and sends it to
   you over the existing socket event `notification:device:register` (see payload
   below).
2. When a VoIP push arrives, the app **natively** reports the call to CallKit in
   the same run-loop (iOS 13+ requirement) → the native full-screen call screen
   shows over the lock screen even if the app was killed.
3. When the caller places a call, the app calls
   `POST /api/v2/user/call/notify { peerId, media, callId }` asking you to push
   each callee.

So the whole receive-side is wired. The missing piece is entirely: **your server
sending the VoIP push.**

---

## Backend Task 1 — Persist the `voipToken`

On iOS, `notification:device:register` now includes an extra field `voipToken`
(distinct from the normal APNs/FCM `pushToken`):

```jsonc
{
  "deviceId": "…",
  "pushToken": "<APNs/FCM token>",     // existing — alerts / data
  "pushProvider": "apns",
  "voipToken": "<PushKit VoIP token>", // ← NEW: store this per device
  "deviceInfo": { … }
}
```

- **Store `voipToken` per device** (it is per-device, and it rotates — always keep
  the latest one the device registers).
- Android devices send **no** `voipToken` — keep using their FCM token as today.

## Backend Task 2 — Send the VoIP push when a call rings

On call ring (either the socket `call:ring` handler / your `pushOfflineCallees`,
**or** the `POST /api/v2/user/call/notify` endpoint — doing it in one place is
enough), for each **iOS** callee device, send an **APNs VoIP push** to its stored
`voipToken`.

**APNs request headers (all REQUIRED):**

| Header | Value |
|---|---|
| `apns-push-type` | `voip` |
| `apns-topic` | `com.chat.baatCheet.voip` ← **bundle id + `.voip`** suffix, NOT the plain bundle id |
| `apns-priority` | `10` |
| Auth | Your APNs `.p8` key (or VoIP Services cert) for this app |

**APNs payload** (no `aps.alert` — CallKit builds the UI from these fields):

```jsonc
{
  "uuid": "<RFC4122 UUID generated per call>",
  "callId": "<the same signalId used in call:* socket events>",
  "callerId": "<caller user _id>",
  "callerName": "<caller display name>",
  "callerImage": "<caller avatar url>",   // optional
  "callType": "audio"                      // "audio" | "video"
}
```

| key | Req | Purpose |
|---|---|---|
| `uuid` | ✅ | The CallKit call id. **Must be a valid RFC4122 UUID** (e.g. `550e8400-e29b-41d4-a716-446655440000`). If you omit it, the app falls back to `callId` — which would then itself have to be a valid UUID. |
| `callId` | ✅ | App signaling id (same one as the `call:*` events). Ties CallKit "Accept" → WebRTC reconnect + caller notify. |
| `callerId` | ✅ | Without it the app ignores the push. |
| `callerName` | ✅ | Shown on the CallKit screen. |
| `callType` | ✅ | `audio` / `video`. |
| `callerImage` | – | Optional avatar. |

## Backend Task 3 — Stop pushing to logged-out devices

When a device logs out the app emits socket `logout { deviceId, logoutAll:false }`.
On that event, **deactivate/remove that device's `voipToken` (and `pushToken`)** so
it stops receiving call pushes. Re-activate only when the same device logs back in
and re-registers.

> This matters extra for VoIP: a VoIP push is handled by iOS **natively before any
> app-side auth check**, so a logged-out phone would still ring if you keep pushing
> to its old `voipToken`. The app cannot suppress it — only the backend can, by not
> sending it.

---

## Copy-paste example (HTTP/2 APNs with a `.p8` token)

```bash
# $AUTH_JWT = APNs provider JWT signed with your .p8 key (ES256; iss=teamId, kid=keyId)
# $VOIP_TOKEN = the device's stored voipToken (hex)

curl -v --http2 \
  --header "apns-push-type: voip" \
  --header "apns-topic: com.chat.baatCheet.voip" \
  --header "apns-priority: 10" \
  --header "authorization: bearer $AUTH_JWT" \
  --data '{
    "uuid": "550e8400-e29b-41d4-a716-446655440000",
    "callId": "sig_abc_1720000000000",
    "callerId": "665f0a…",
    "callerName": "Rahul",
    "callerImage": "https://…/avatar.jpg",
    "callType": "audio"
  }' \
  "https://api.sandbox.push.apple.com/3/device/$VOIP_TOKEN"
```

- **Development / TestFlight-sandbox builds** → host `api.sandbox.push.apple.com`.
- **App Store / production builds** → host `api.push.apple.com`.
  (Pick the host that matches the build's `aps-environment`. If unsure which build
  you're testing, ask the mobile side — but for now we are on a **development**
  build, so use the **sandbox** host.)

---

## Common mistakes that make it silently NOT ring

- ❌ Wrong `apns-topic` — it must be `com.chat.baatCheet.voip`, **not**
  `com.chat.baatCheet`. Wrong topic → Apple silently drops the push.
- ❌ `uuid` is not a real RFC4122 UUID (e.g. sending the `sig_…_ms` signalId as the
  uuid). CallKit rejects it → nothing rings.
- ❌ Using a normal alert push / `apns-push-type: alert` for iOS calls — an alert
  push **cannot** wake a killed app or show a call screen. It **must** be `voip`.
- ❌ Pushing to a stale `voipToken`. The token rotates; always use the latest one
  the device registered.
- ❌ Sending to the wrong APNs host (sandbox vs production mismatch) → `BadDeviceToken`.
- ❌ Sending a VoIP push for anything other than a **real incoming call**. Apple
  throttles/disables VoIP for an app that receives VoIP pushes without reporting a
  call. For call **cancel/timeout**, use the socket `call:cancel` (or the Android
  data push) — **never** another VoIP push.

---

## Android note (already working — for completeness)

Android does **not** use VoIP. For Android callees, keep sending the existing
**high-priority FCM data-only message** (`data.type = "call"`, same `callId`) to
the device's FCM token. On `call:ring`, branch by platform:

- **iOS device** → APNs **VoIP** push (this document).
- **Android device** → FCM **data** push (unchanged).

Both carry the same `callId` so the foreground socket path and the push de-dupe on it.

---

## Definition of done / how to test

1. iOS test phone: log in, then **force-kill the app** and **lock the phone**.
2. From another account, place a call to that phone.
3. ✅ Expected: the iPhone rings **full-screen (native CallKit)** within ~1–2s,
   even though the app was killed and locked.
4. Tapping **Accept** should open the app into the live call.

Debugging checklist if it doesn't ring:
- Confirm the callee device's `voipToken` is stored in your DB (from
  `notification:device:register`).
- Confirm your `call:ring` / `/call/notify` path actually fired the APNs VoIP
  request and APNs returned **200** (not `BadDeviceToken` / `TopicDisallowed`).
- Verify `apns-topic = com.chat.baatCheet.voip` and `apns-push-type = voip`.
- Verify the payload `uuid` is a valid RFC4122 UUID.

Once a killed + locked iPhone rings full-screen, this is done. Ping the mobile
side if you need the current `voipToken` of a test device or a sample of the
`notification:device:register` payload as it arrives.
