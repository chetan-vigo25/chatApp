# Group Call — In-Thread "Call" Message (Server Changes)

**Scope:** making the WhatsApp-style call bubble ("Voice call", "Cancelled
call", "Missed voice call" …) appear inside a **GROUP** chat thread, exactly as
it already does in a 1:1 thread.

**Not in scope:** 1-to-1 call messages (already working — do not change them),
and the separate conference-record change in
[`CONFERENCE_CALL_SERVER_CHANGES.md`](./CONFERENCE_CALL_SERVER_CHANGES.md),
which unlocks host kick / "end for everyone" / live roster. The two are
**independent**: this document alone makes the bubbles appear.

**Status of the client:** already done. The app renders, labels and re-dials
group call bubbles today, and now sends the group's `chatId` so the server has a
thread to write to. **No app release is needed** for this change — the moment
the server creates and fans out the message, the bubble appears.

---

## 1. Why the bubble never appears in a group today

The bubbles are **not** written by the app. `src/calls/services/inThreadCallService.js`
exports `appendCallEntry`, but it has **zero callers** — the entry is a real chat
message created **server-side** from the call-log write, then fanned out over the
normal message socket.

That creation is gated to 1:1. From the client source
(`src/calls/CallProvider.jsx`, `finalizeEnd`):

> `recordCall` persists the durable CallLog AND **(for a 1:1 outgoing leg)**
> drops the canonical WhatsApp-style "call" message into the chat thread
> server-side, which `messageService` fans out to BOTH parties' chat screen +
> chat-list summary in realtime.

So for a group call the server stores the `CallLog` row and stops. Nothing is
ever created, and the app has nothing to display.

> **`isGroup: true` is NOT the missing piece.** The client has always sent it
> (`call:ring` carries `isGroup: true`, and the call-log payload stores
> `isGroup` / `groupId` / `groupName`). Flipping or setting that flag changes
> nothing. The missing piece is the **message-creation code path**.

---

## 2. What the client sends

`POST /api/v2/user/call/log`, once per device, when the call ends:

```jsonc
{
  "callId":    "sig_<hostId>_<dialEpochMs>",  // ONE id for the whole call
  "isGroup":   true,
  "groupId":   "6a7ac21426d07447d75a4448",
  "groupName": "Travel 🧳",
  "chatId":    "<the group's chat id>",   // ← NEWLY SENT (was null before)
  "peerId":    null,                      // a group call has no single peer
  "participants": ["<userId>", "<userId>", "…"],

  "media":      "audio" | "video",
  "direction":  "outgoing" | "incoming",  // this DEVICE's leg
  "outcome":    "completed" | "missed" | "rejected" | "cancelled" | "failed",
  "startedAt":  "2026-09-08T07:21:23.962Z",
  "answeredAt": "2026-09-08T07:21:26.001Z",   // null if never answered
  "endedAt":    "2026-09-08T07:21:27.798Z",
  "durationSec": 42,

  // optional telemetry, unchanged
  "mediaServer": { … }, "qualityMetrics": { … },
  "deviceInfo":  { … }, "networkInfo": { … }
}
```

`chatId` is new. It used to be hard-`null` for group calls, so even a willing
server had no thread to post into. If it ever arrives `null` (a call started
from a surface that doesn't know the thread — Group Info, the call log, the
profile preview), **resolve the chat from `groupId`**.

---

## 3. REQUIRED — create the message for group calls

In the `/call/log` handler, when `isGroup: true`, create the same
`messageType: "call"` message you already create for 1:1, addressed to the
**group thread**, and fan it out on the **normal group-message path**.

### 3.1 The 1:1 message you create today

Captured verbatim from a device log, for reference:

```jsonc
{
  "messageId":       "38b52c7a-0b9c-486c-9721-4f03d0187c94",
  "clientMessageId": "call_sig_6a72cf2d26d07447d7a146a0_1788852083962",
  "chatId":          "u_69a51896cf2a2ed928da6025_6a72cf2d26d07447d7a146a0",
  "chatType":        "private",
  "groupId":         null,
  "senderId":        "6a72cf2d26d07447d7a146a0",
  "receiverId":      "69a51896cf2a2ed928da6025",
  "messageType":     "call",
  "type":            "call",
  "callDetails": {
    "callId": "sig_…", "media": "audio", "outcome": "cancelled",
    "durationSec": 0, "startedAt": "…", "answeredAt": null, "endedAt": "…"
  },
  "payload": {
    "kind": "call", "callId": "sig_…",
    "media": "audio", "outcome": "cancelled", "durationSec": 0
  },
  "status": "sent",
  "seq": 19
}
```

### 3.2 The group version — the delta

Same message, five fields differ:

| Field | 1:1 | **Group** |
|---|---|---|
| `chatId` | `u_<a>_<b>` | **the group's chat id** (payload `chatId`, else resolve from `groupId`) |
| `chatType` | `"private"` | **`"group"`** |
| `groupId` | `null` | **the group id** |
| `receiverId` | the callee | **`null`** — group messages have no receiver |
| `senderId` | the caller | **the caller** (unchanged: the call's initiator) |

`messageType`, `type`, `callDetails`, `payload`, `status` and `seq` follow the
1:1 shape exactly. `seq` must be the next sequence number **in the group chat**.

Then fan out over the same socket event as any other group message, and update
the group's **chat-list preview** so the row reads as a call.

---

## 4. Three rules that decide whether this works

### 4.1 ONE message per call — from the caller's leg only

**Every participant's device POSTs its own `/call/log`.** Your 1:1 code already
gates message creation on the outgoing leg; keep exactly that gate for groups.

Without it a 5-person call writes **5 identical bubbles** into the thread.

Belt and braces: `clientMessageId` is `call_<callId>`, and `callId` is one
immortal id for the whole call — so an idempotent upsert on
`(chatId, clientMessageId)` collapses duplicates even if several legs race.

### 4.2 NEVER put `direction` in `payload`

The bubble derives direction **per viewer**
(`src/calls/components/CallMessageBubble.jsx`):

```js
const direction = payload.direction
  || (msg?.senderType === 'self' ? 'outgoing' : 'incoming');
```

and the normalizer in `src/contexts/useChatLogic.js` says so explicitly:

> Direction is derived per-viewer from senderType, so it is intentionally NOT
> stored.

One canonical message therefore reads correctly for **everyone**: right-aligned
green for the caller, left-aligned for every other member. Storing a `direction`
pins it to one viewer's perspective and shows the wrong side to the other four.
Your 1:1 message already omits it — keep it omitted.

### 4.3 `outcome` is group-wide, not per-member

A member who didn't pick up must not turn the group's single bubble into
"Missed" for everybody. Recommended rule:

```
outcome = anyone_joined ? "completed"
                        : (caller_cancelled ? "cancelled" : "missed")
```

`durationSec` should likewise be the **call's** duration (first join → last
leave), not one member's leg.

---

## 5. What the client does with it — no app work needed

1. `useChatLogic` normalizes any `messageType: "call"` row — it reads
   `callDetails` (REST/sync) or `payload` (realtime) into
   `{ kind, media, outcome, durationSec }`. Not gated on chat type.
2. `ChatScreen` renders it: `isCall = msg.type === 'call' || msg.messageType === 'call'`.
   Never was 1:1-only.
3. `CallMessageBubble` labels a group call **"Group voice call" / "Group video
   call"**, and tapping it re-dials the whole group.

---

## 6. Acceptance tests

**A — the happy path.** 3-person group, caller places a voice call, one member
answers, call ends after ~40s.

- exactly **one** `messageType: "call"` message exists in the group thread
- caller sees it **right-aligned**, "Group voice call", with the duration
- both other members see the **same** message **left-aligned**
- tapping it re-dials the whole group
- the chat list shows the call as the group's last message

**B — nobody answers.** Caller cancels a group call before anyone picks up.
One message, `outcome: "cancelled"`, and it does **not** read as "Missed" for
the caller.

**C — no duplicates.** 5-person group, 3 answer. Still exactly **one** message
in the thread after every device has posted its own `/call/log`.

**D — 1:1 unchanged.** A 1:1 call still produces exactly the message it does
today, byte-for-byte in shape.

---

## 7. Relationship to the other server document

Independent, and can ship in either order:

| Change | Doc | Unlocks |
|---|---|---|
| Call message in the group thread | **this document** | the in-thread call bubbles |
| Conference record on `call:ring { isGroup: true }` | `CONFERENCE_CALL_SERVER_CHANGES.md` | "End for everyone", host kick, live roster, per-member mute/camera |

---

## 8. Client files involved (for reference — already done)

| File | Role |
|---|---|
| `src/calls/CallProvider.jsx` | builds + POSTs the `/call/log` payload; now sends the group's `chatId` |
| `src/calls/components/CallMessageBubble.jsx` | renders the bubble; group labels + group re-dial |
| `src/screens/chats/ChatScreen.jsx` | renders `type: 'call'` rows; supplies the group re-dial roster |
| `src/contexts/useChatLogic.js` | normalizes `callDetails` → `payload` for the bubble |
| `src/calls/services/inThreadCallService.js` | legacy local-write path, **unused** (zero callers) |
