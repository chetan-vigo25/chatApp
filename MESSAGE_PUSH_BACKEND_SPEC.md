# Message push — backend spec

For a new message to show a notification when the recipient's app is
**backgrounded, closed, or the phone is locked**, the backend must send a
**high-priority FCM message** to the recipient's CURRENT device token(s) at the
moment the message is created and the recipient is **not connected via socket**.

A closed app has no socket and no running code — the in-app banner only works
while the app is open. The FCM push is the ONLY way to notify a closed app.
(Calls already work this way; messages just need the same treatment.)

## Where to trigger it

In the existing **message-create / send handler** on the server — the same place
that emits `message:new` to online recipients. If the recipient has no active
socket session, also send the FCM push below. (Presence/socket-session lookup is
already used for delivery; reuse it.)

## Required payload

A **data message** (most reliable for the app's background handler) — optionally
with a `notification` block for the OS to draw it directly. `data` values are
strings.

```jsonc
{
  "token": "<recipient's CURRENT FCM token>",
  "android": { "priority": "high" },
  "apns": {
    "headers": { "apns-priority": "10" },
    "payload": { "aps": {
      "alert": { "title": "<sender name>", "body": "<message preview>" },
      "sound": "default"
    } }
  },
  "data": {
    "type": "message",                 // anything EXCEPT "call"
    "messageId": "<server message id>",  // for de-dupe
    "chatId": "<chat/room id>",
    "senderId": "<sender user id>",
    "senderName": "<sender display name>",
    "body": "<message text or 'Photo'/'Video'/'Document'…>",
    "chatType": "private",             // or "group"
    "groupId": "<group id>",           // groups only
    "groupName": "<group name>"        // groups only
  }
}
```

### What the client reads (already implemented in `showLocalNotification`)

| `data` key | Used for |
|---|---|
| `type` | Must NOT be `"call"`. Routes to the normal message notification. |
| `messageId` / `_id` | De-dupe (drops repeats within 10s). |
| `senderName` / `title` / `name` / `chatName` | Notification title. |
| `body` / `message` / `text` / `content` | Notification body. |
| `chatId`, `senderId`, `chatType`, `groupId`, `groupName` | Tap-to-open routing. |

The client drops the push (shows nothing) only if BOTH title and body are empty,
or it's a duplicate, or the group is one the user left — so always include a
title and body.

## Critical notes

- **Token freshness:** push to the recipient's CURRENT token. A fresh install /
  `expo run:android` rotates the token; the app re-registers it via the
  `notification:device:register` socket event and on login (`device.fcmToken`).
  Push to the latest token, not a stale one, or delivery silently fails.
- **`type` must not be `"call"`** — that value is reserved for the call
  full-screen flow.
- **Priority high** (Android) / `apns-priority 10` so it wakes a dozing device.
- **Don't push when the recipient is actively connected** (has a live socket) —
  the in-app banner already covers that case; pushing too would double-notify.
- **DATA-ONLY is REQUIRED for multi-message grouping.** The app renders a
  WhatsApp-style MessagingStyle notification (one thread per chat listing the
  recent messages). That only works when the app's handler draws the
  notification — i.e. the push is data-only. If you send a `notification` block,
  the OS draws its own single notification and **each new message replaces the
  last (only the newest shows)** — the app cannot group or stack them. So: send
  `data` only, and do **NOT** set `collapse_key` or `android.notification.tag`
  (those also make the OS collapse messages into one).

## Client status (already implemented — no app change needed)

- Foreground (app open) → in-app banner via `AppBannerHost` (socket `message:new`).
- Background / closed / locked → `fcmService` background + foreground handlers
  call `showLocalNotification`, which renders any non-`call` FCM message on the
  `chat_messages_v2` channel. It just needs the push above to arrive.
