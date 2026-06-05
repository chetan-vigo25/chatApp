# Incoming-call push — backend spec

For an incoming call to ring when the callee's app is **backgrounded, on another
app, or killed**, the backend must send a **high-priority FCM data message** to
the callee's CURRENT device token(s) the moment a call rings. A closed app cannot
receive the socket `call:incoming`, so this push is the ONLY way to ring it.

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

## Client status (already implemented — no app change needed)

- Android: notifee **full-screen intent** → launches the app's full-screen call
  UI over the lock screen (`src/firebase/callNotifee.js`).
- iOS: expo-notifications heads-up with Accept/Decline.
- Background/foreground/cold-launch handlers + token re-registration are wired.
  Requires the app rebuilt with the notifee native module.
