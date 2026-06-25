# WhatsApp-style Missed-Call Architecture

App-managed VoIP missed-call handling — a custom **"Missed voice/video call from
{name}"** tray notification, an in-app call-log entry, and a server source-of-truth
timeout — **without** Android `TelecomManager`/`ConnectionService`, the system Phone
app's call log, or iOS CallKit Phone-app missed entries.

> The call **transport** (WebRTC-in-WebView + Socket.IO signaling) and the call
> **state machine** already exist and work. This document covers only the
> **missed-call notification + workflow** layered on top. See
> [IOS_VOICE_VIDEO_CALL_FIX.md](IOS_VOICE_VIDEO_CALL_FIX.md) and
> [ANDROID_LOCKSCREEN_CALL_SECURITY.md](ANDROID_LOCKSCREEN_CALL_SECURITY.md) for the
> live-call path.

---

## Why this avoids the system call log (the "Critical Requirement")

Everything here uses **app notifications only**:

- **Android** → `notifee` (`AndroidImportance.DEFAULT`, channel `missed_calls`) or
  `expo-notifications` fallback. No `CallStyle.forIncomingCall`, no
  `TelecomManager.addNewIncomingCall`, no `ConnectionService` — so Android never
  writes a system call-log row or draws the Phone app's missed-call icon.
- **iOS** → `expo-notifications` local notification. **CallKit is never invoked for
  missed calls**, so no entry appears in the iOS Phone app's Recents.

The missed-call record lives **only** in our own DB (`CallLog`) and our own tray
notification. That is exactly WhatsApp/Signal/Telegram behaviour.

---

## Call states (already implemented)

`deriveOutcome()` in [src/calls/state/callMachine.js](../src/calls/state/callMachine.js)
maps every terminal call to one outcome:

| Outcome | Meaning |
|---|---|
| `answered`/`completed` | connected, then hung up |
| `rejected` | callee declined |
| `cancelled` | **outgoing** never answered (caller hung up / ring timeout) |
| `missed` | **incoming** never answered (ring timeout / caller cancelled / offline) |
| `failed` | technical error |
| `busy` | callee already on another call |

`cancelled` vs `missed` is **directional**: one unanswered call is `cancelled` in the
caller's log and `missed` in the callee's log — WhatsApp-correct, not a duplicate.

---

## The two trigger paths (both end at ONE notification)

A missed call must surface a notification whether or not our JS was alive when it
happened. There are two independent sources, **de-duped by `callId`**:

```
                 ┌─────────────────────────── App ALIVE (fg/bg) ───────────────────────────┐
incoming call ──►│ rings → ring-timeout OR caller cancel → finalizeEnd('missed')            │
                 │   → displayMissedCallNotification(...)  (CallProvider.jsx)               │
                 └──────────────────────────────────────────────────────────────────────────┘
                 ┌─────────────────── App KILLED / OFFLINE / never rang ───────────────────┐
                 │ backend timeout fires → FCM data push  { type: 'call-missed', ... }      │
                 │   → fcmService background/foreground handler                              │
                 │   → displayMissedCallNotification(...)                                    │
                 └──────────────────────────────────────────────────────────────────────────┘
                                              │
                                              ▼
                    missedShownIds Set (keyed by callId) ⇒ exactly ONE notification
```

- If the app **was alive** and the call rang, the local path posts it instantly.
- If the app was **killed/offline** (call never rang here), only the backend
  `call-missed` push fires it.
- If **both** fire (app backgrounded-but-alive), they share one JS runtime →
  `missedShownIds` collapses them to one. (`displayMissedCallNotification` in
  [src/firebase/callNotifee.js](../src/firebase/callNotifee.js).)

---

## Client implementation

### 1. `displayMissedCallNotification(data)` — [src/firebase/callNotifee.js](../src/firebase/callNotifee.js)
Cross-platform, idempotent per `callId`:
- **Android** → `notifee` on channel `missed_calls`, round caller `largeIcon`,
  `autoCancel`, green accent. Notification id `missed-<callId>`.
- **iOS / no notifee** → `expo-notifications` local notification.
- Title = caller (or group) name; body = `Missed voice call` / `Missed video call`.
- Tap payload `{ type: 'call-missed', chatId, senderId, ... }` → opens the chat.

### 2. Channel — [src/firebase/fcmService.js](../src/firebase/fcmService.js)
`missed_calls` channel created at `DEFAULT` importance (dismissible, **not** a
ringing channel) in `setupNotificationChannel()`.

### 3. FCM push handling — [src/firebase/fcmService.js](../src/firebase/fcmService.js)
`type: 'call-missed'` is branched in BOTH the background handler and the foreground
`onMessage` listener → `displayMissedCallNotification(data)` then `return` (never
falls through to the generic chat banner).

### 4. Live-app path — [src/calls/CallProvider.jsx](../src/calls/CallProvider.jsx)
In `finalizeEnd`, after the ringing notification is dismissed:
```js
if (outcome === 'missed' && snap.direction === 'incoming' && !snap.answeredAt && snap.peer?.id) {
  displayMissedCallNotification({ callId: snap.signalId || snap.callId, callerId: snap.peer.id,
    callerName: snap.peer.name, callerImage: snap.peer.avatar,
    callType: snap.media === 'video' ? 'video' : 'audio',
    chatId: ..., senderId: snap.peer.id, isGroup, groupId, groupName });
}
```

### 5. Tap navigation (already wired, no new code)
`type: 'call-missed'` is `!== 'call'` and carries `chatId`, so it routes through the
EXISTING notification-tap branches → `navigateToChat(data)`:
- iOS FCM: `onNotificationOpenedApp` + `getInitialNotification`.
- Android notifee: foreground `onForegroundEvent`, background `onBackgroundEvent`
  (`routeNotifeeEvent`), and cold-start `notifee.getInitialNotification()`.

### 6. In-app call log (already implemented)
`finalizeEnd` calls `recordCall(payload)` with `outcome: 'missed'`; the Calls screen
updates in realtime via `DeviceEventEmitter('call:log:update')` and renders the red
`call-missed` icon ([src/screens/calls/CallsScreen.jsx](../src/screens/calls/CallsScreen.jsx)).

---

## Backend contract (server = source of truth)

The server owns the **ring-timeout** and the **missed-call push** — the client can't
be trusted to fire a missed-call when it's killed.

### Call lifecycle
1. `call:ring` (A→server) → server creates a `CallSession` (`status: 'ringing'`,
   `expiresAt = now + RING_WINDOW_MS`) and pushes/relays the incoming call to B.
2. B answers (`call:accept` → `status: 'answered'`) or rejects
   (`call:reject` → `status: 'rejected'`).
3. A cancels before answer (`call:cancel` → `status: 'cancelled'`).
4. **Timeout sweep:** a timer/cron marks any `ringing` session past `expiresAt` as
   `missed`.
5. On transition to `missed` (timeout **or** caller-cancel-before-answer), the server:
   - writes the **callee's** `CallLog` row with `outcome: 'missed'`,
   - sends a **`call-missed` FCM/APNs data push to every callee device** that didn't
     answer,
   - relays `call:missed` over the socket to any connected callee device (so live
     devices reconcile without waiting for the push).

### `call-missed` FCM payload (data-only)
```jsonc
{
  "data": {
    "type": "call-missed",
    "callId": "<same id as the call:ring/incoming>",   // REQUIRED — dedupe key
    "callerId": "<userId>",
    "callerName": "John",
    "callerImage": "https://.../john.jpg",
    "callType": "audio",                                 // or "video"
    "chatId": "<1:1 chatId>",                            // for tap → open chat
    "senderId": "<callerId>",
    "isGroup": "false",
    "groupId": "",                                       // set for group calls
    "groupName": ""                                      // set for group calls
  },
  "android": { "priority": "high" },
  "apns": { "headers": { "apns-priority": "10" },
            "payload": { "aps": { "content-available": 1 } } }
}
```
**Rules**
- **Data-only** (no `notification` block) — otherwise the OS draws it on the wrong
  channel and bypasses the client dedupe, producing a duplicate.
- `callId` MUST equal the original call's id so the client `missedShownIds` dedupe
  works across the live path and the push.
- Send to **all** of the callee's registered device tokens **except** one that sent
  `call:accept` (multi-device: answered elsewhere ⇒ no missed-call on the others).
- Do **not** send `call-missed` to the **caller** — the caller gets a `cancelled`
  log entry, not a missed-call notification.

### Suggested `CallSession` / `CallLog` (Mongo)
```js
CallSession { _id, callId, callerId, calleeIds:[], isGroup, groupId,
  media:'audio'|'video', status:'ringing'|'answered'|'rejected'|'cancelled'|'missed'|'ended'|'failed',
  answeredBy, ringAt, expiresAt, endedAt }

CallLog { _id, ownerId, callId, peerId, isGroup, groupId, groupName, media, direction:'in'|'out',
  outcome:'completed'|'rejected'|'cancelled'|'missed'|'failed'|'busy',
  startedAt, answeredAt, endedAt, durationSec }   // one row per participant (owner-scoped)
```

`RING_WINDOW_MS` should match the client (default ~35 s; the client clamps
10–180 s and reads it from the call token).

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| **App foreground**, didn't answer | live path posts the missed notification; log row added; push is deduped. |
| **App background (alive)** | same as foreground (background handler + live path share the runtime → one notification). |
| **App killed** | only the backend `call-missed` push fires it; tap cold-starts → chat. |
| **Device offline during ring** | FCM queues the `call-missed` push; delivered on reconnect (still one notification). |
| **Answered on another device** | server skips `call-missed` to the answering device's siblings; no false missed-call. |
| **Caller cancels before answer** | server marks `missed` for callee → push; caller logs `cancelled`. |
| **Network disconnect mid-ring** | server timeout still fires `missed` server-side → push. |
| **Tapped hours later** | `autoCancel` notification; tap navigates to the caller's chat (call log persists in DB). |
| **Duplicate pushes** (FCM retry) | `missedShownIds` + stable `missed-<callId>` id ⇒ one notification. |
| **Race: socket `call:missed` + FCM push** | both call `displayMissedCallNotification`; deduped by `callId`. |
| **Group call missed** | title = group name, tap opens the group; one notification per missed group call. |
| **Reboot / token refresh** | next `call-missed` uses the refreshed token; nothing client-side to restore. |

---

## Test checklist

- [ ] **Foreground, ignore the ring** → after ring window, tray shows
      "Missed voice call from {name}"; Calls tab shows red missed entry.
- [ ] **Background (alive)** → same, exactly **one** notification (no duplicate).
- [ ] **Killed app** → backend `call-missed` push shows the notification; tap opens
      the caller's chat.
- [ ] **Caller cancels before pickup** → callee gets a missed-call notification +
      log; caller's log shows `cancelled` (no missed-call notification on caller).
- [ ] **Video call** → body reads "Missed video call".
- [ ] **Group call missed** → title = group name; tap opens the group.
- [ ] **Answer on device A** with B also logged in → B gets **no** missed-call.
- [ ] **Android**: no entry in the system Phone app call log; **iOS**: no entry in
      Phone Recents.
- [ ] Tap a missed-call notification → lands in the correct chat (fg / bg / cold).

---

## Files changed (JS-only — Metro reload, no native rebuild)

- [src/firebase/callNotifee.js](../src/firebase/callNotifee.js) —
  `displayMissedCallNotification()`, `missed_calls` channel (notifee),
  `missedShownIds` dedupe, expo fallback, `forgetMissedCall()`.
- [src/firebase/fcmService.js](../src/firebase/fcmService.js) — `missed_calls` expo
  channel; `type:'call-missed'` branch in the background + foreground handlers.
- [src/calls/CallProvider.jsx](../src/calls/CallProvider.jsx) — post the missed-call
  notification from `finalizeEnd` for unanswered incoming calls.

**Backend work (separate repo):** ring-timeout sweep, mark `missed`, send the
data-only `call-missed` push to non-answering callee devices, relay `call:missed`
over the socket. See the **Backend contract** section above.
