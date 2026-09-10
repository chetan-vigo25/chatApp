# Message push — backend spec

For a new message to show a notification when the recipient's app is
**backgrounded, closed, or the phone is locked**, the backend must send a
**high-priority push** to the recipient's CURRENT device token(s) at the moment
the message is created.

A closed app has no socket and no running code — the in-app banner only works
while the app is open. The push is the ONLY way to notify a closed app.
(Calls already work this way; messages just need the same treatment.)

> **iOS status (2026-09-10).** Testing two consecutive messages to a
> force-quit iPhone showed the 1st notification never arriving and the 2nd
> arriving late. The two causes that produce exactly that are both in this
> document: sending iOS a **data-only** push (§ "iOS: data-only can never notify
> a closed app") and **skipping the push because a socket looked connected**
> (§ "When to push"). The client side of both was re-verified and hardened; see
> § "Client status".

## Where to trigger it

In the existing **message-create / send handler** on the server — the same place
that emits `message:new` to online recipients.

## When to push — the rule that decides whether a notification is ever sent

Push **unless the recipient is provably in the FOREGROUND right now**, i.e.:

- their last `presence:heartbeat` was **< 10 s** ago (the app sends one every
  ~4 s while foreground), **and**
- their last `app:state` was `foreground` (the app emits
  `app:state {state:'background'}` + `presence:away` the moment it is minimized
  or the screen locks).

**Do NOT gate on "has a connected socket".** That is the check most likely to
have eaten the first message in the report above: when iOS suspends or kills an
app, the TCP connection is not closed politely — the server keeps seeing a
*connected* socket until socket.io's ping timeout (tens of seconds) and so
decides "recipient is online, no push needed". The message is then delivered to
a socket nobody is listening on, and the user is never notified. The heartbeat
above is the liveness signal that expires on its own.

**When in doubt, push.** A duplicate cannot reach the user: the app claims each
`messageId` in ONE shared store (`src/firebase/notificationDedupe.js`) before
rendering either the in-app banner or the OS notification, so whichever arrives
first wins and the other is dropped. A missed push, by contrast, is
unrecoverable.

One push per `messageId` per device. Never re-push the same `messageId`.

## Required payload

FCM, HTTP v1. **The `apns` block is not optional** — without it iOS gets a
silent push (see the next section). `data` values must all be strings.

```jsonc
{
  "token": "<recipient's CURRENT FCM token>",

  // ── Android: data-only, so the app can draw a MessagingStyle thread ──
  "android": { "priority": "high" },

  // ── iOS: a REAL ALERT push — this is what the OS displays when the app is
  //        closed. Headers included explicitly; do not rely on defaults. ──
  "apns": {
    "headers": {
      "apns-push-type": "alert",     // NOT "background"
      "apns-priority": "10",         // deliver now, don't batch
      "apns-expiration": "<unix seconds, e.g. now + 3600>"
      // NO "apns-collapse-id" — see "Consecutive messages" below
    },
    "payload": { "aps": {
      "alert": { "title": "<sender name>", "body": "<message preview>" },
      "sound": "default",
      "mutable-content": 1,          // REQUIRED — runs the app's extension
      "thread-id": "<chat/room id>", // groups a chat's notifications
      "badge": <unread count>        // optional
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
    "groupName": "<group name>",       // groups only
    "profileImage": "<sender avatar URL>"  // see "Sender avatar on iOS"
  }
}
```

Do **not** set the platform-independent top-level `notification` key. It would
make Android draw its own single notification (breaking the app's message
grouping — see "Android grouping"). The `apns.payload.aps.alert` above is what
iOS needs, and it does not affect Android.

## iOS: data-only can never notify a closed app

If the push carries no `aps.alert`, FCM sends it to APNs as
`apns-push-type: background`, `apns-priority: 5`, `content-available: 1`. For
iOS that is a *silent/background* push, and:

- **iOS never displays it.** Something has to draw it — and the only thing that
  could is the app's JS, which is not running.
- **A force-quit app is not launched for it.** Swiped out of the app switcher,
  the app gets no background pushes at all. Nothing runs, nothing shows, and
  nothing is queued for later. (This is the "no notification when terminated"
  symptom, by design on Apple's side — only an `alert` push, or PushKit for
  calls, reaches a force-quit app.)
- **They are rate-limited and deferred.** iOS coalesces and delays background
  pushes at its own discretion — minutes is normal, and it drops them under low
  power. A push that does arrive therefore arrives *late*, which is the other
  half of the reported symptom.

So on iOS the notification must be drawn **by the OS from the payload**, which
requires `aps.alert` + `apns-push-type: alert` + `apns-priority: 10`. The app's
Notification Service Extension then upgrades it (avatar, threading) before it
appears — that is what `mutable-content: 1` is for.

`content-available: 1` may be added *alongside* the alert if the app should also
be woken to sync, but it is never a substitute for the alert.

## Consecutive messages (two messages, two notifications)

- **Send one push per message.** Nothing about the second message's push may
  reference or replace the first.
- **Never reuse `apns-collapse-id`.** APNs keeps only the LAST notification per
  collapse id and replaces any earlier one — a constant value (or one keyed per
  chat/user) makes the 2nd message's notification silently swallow the 1st,
  which looks exactly like "the first notification was dropped". Omit the header
  entirely, or make it unique per `messageId`.
- Grouping is `thread-id`'s job, not collapsing's: the same `thread-id`
  (the chatId) stacks a conversation's notifications in the tray **without**
  hiding any of them.
- **Android:** do not set `collapse_key` or `android.notification.tag` either,
  for the same reason.
- Only the **most recent** notification per token survives if the device is
  unreachable (APNs stores one). That is another reason not to delay the send:
  push at message-create time, not on a timer or batch.

## Android grouping

The Android app renders a WhatsApp-style MessagingStyle notification (one thread
per chat listing the recent messages). That only works when the **app** draws
the notification — i.e. the push must be data-only on Android. If a
`notification` block is sent, the OS draws its own and each new message replaces
the last. Hence: `android.priority = high` + `data` only, no `notification` key,
no `collapse_key`, no `android.notification.tag`.

This is the one place the two platforms genuinely differ: **Android needs
data-only; iOS needs an alert.** One FCM message satisfies both — `data` at the
top level for Android, the `apns` override for iOS.

## Sender avatar on iOS (`profileImage` + `mutable-content`)

iOS renders these as **communication notifications** (WhatsApp-style: the
sender's photo on the left, the app icon only as a small corner badge). That is
done by the app's Notification Service Extension
(`ios/NotificationServiceExtension/NotificationService.swift`), which is already
shipped and needs **no app change** — but it depends on two things the backend
must send:

1. **`aps["mutable-content"] = 1`** — without it iOS never runs the extension, so
   there is no avatar and no per-chat threading at all; the push renders as a
   plain notification showing only the app icon.
2. **`data.profileImage`** — the sender's avatar URL. The extension reads exactly
   this key (falling back to no image when absent, which is what makes the app
   icon show in the avatar's place).

Requirements for the URL:

- **Publicly fetchable over http(s), no auth.** The extension does a bare
  `URLSession` GET — it cannot attach a bearer token, so a URL that needs one
  yields no avatar. Non-http(s) URLs are skipped outright.
- **Fast.** The fetch is capped at **4 s** (and the whole extension at 5 s) —
  a slower URL costs the avatar, not the notification. Before that cap, a slow
  avatar host held the notification back by up to ~30 s and could lose it
  entirely; do not rely on the cap being generous.
- **Under 512 KB.** Larger responses are ignored (the extension has a small
  memory budget and an over-large decode kills it).
- **Any common image format.** The extension re-encodes to JPEG, so `.webp`
  renditions now work, but a small JPEG/PNG is still the cheapest.

For a group message send the GROUP's avatar as `profileImage` (with
`chatType: "group"` + `groupName`), so the tray shows the group's photo the way
the app's own group rows do.

### What the client reads

| `data` key | Used for |
|---|---|
| `type` | Must NOT be `"call"`. Routes to the normal message notification. |
| `messageId` / `_id` | De-dupe (shared with the in-app banner). |
| `senderName` / `title` / `name` / `chatName` | Notification title (Android-drawn path). |
| `body` / `message` / `text` / `content` | Notification body (Android-drawn path). |
| `chatId`, `senderId`, `chatType`, `groupId`, `groupName` | Tap-to-open routing + iOS threading. |
| `profileImage` | iOS — sender/group avatar in the communication notification. |

On the app-drawn path the push is dropped (shows nothing) only if BOTH title and
body are empty, or it's a duplicate, or the group is one the user left — so
always include a title and body. On iOS the OS draws `aps.alert`, so that must
be populated too; `data.body` alone is not displayable when the app is closed.

## Token hygiene

- **Push to the recipient's CURRENT token.** A fresh install / `expo run:*`
  rotates it; the app re-registers via the `notification:device:register` socket
  event and on login (`device.fcmToken`). A stale token fails silently.
- **Push to ALL of the user's current tokens**, not just one row.
- **Prune dead tokens.** An APNs `410 Unregistered` / FCM
  `UNREGISTERED` / `InvalidRegistration` means delete that row — otherwise a
  `{devices: 2, sent: 1}` result hides the fact that the live device got nothing.
- **Log the per-token APNs/FCM response** for message pushes the way
  `/call/notify` does. "Was a push even sent for messageId X, to which tokens,
  and what did APNs say" is the first question when a notification goes missing,
  and right now it cannot be answered from the server logs.
- **`type` must not be `"call"`** — that value is reserved for the call
  full-screen flow.

## Client status (already implemented — no app change needed)

- Foreground (app open) → in-app banner via `AppBannerHost` (socket `message:new`).
  An iOS alert push that lands while the app is open is left to the OS, so the app
  never double-draws it.
- Background / closed / locked, **iOS** → the OS draws `aps.alert`, upgraded by
  the Notification Service Extension (avatar + per-chat thread). No JS involved,
  which is why the alert payload is mandatory.
- Background / closed / locked, **Android** → `fcmService`'s background handler
  draws a MessagingStyle notification on the `chat_messages_v2` channel.
- De-dupe across both surfaces by `messageId`, so pushing a message the user may
  also receive over the socket is safe.
