# Conference Call — Server & Media-Server (mediasoup) Changes

**Scope:** conference (multi-party) voice + video incoming calls on iOS.
**Not in scope:** 1-to-1 voice/video. Nothing in this document changes 1:1
behaviour, and every client change that accompanies it is gated on
`isConference` / `isGroup`.

**Status of the client:** all app-side fixes are already implemented (see
§10 for the file list). Everything below is what the **backend** and the
**mediasoup media server** still have to do for those fixes to be effective.

---

## 1. Current flow (as the client implements it today)

### 1.1 The two ids, and why they are the whole problem

| id | minted by | shape | lifetime |
|---|---|---|---|
| signaling `callId` | caller app | `sig_<callerId>_<dialEpochMs>` | **the entire conference** |
| engine group key | media server | `groupId` | **the entire conference** |
| CallKit `uuid` | backend | RFC 4122 UUID | per VoIP push |

A 1:1 call mints a **new** `callId` for every dial. A conference does **not** —
it keeps one `callId` and one `groupId` from the first invite until the call
ends. Every "is this a new call or a stale re-delivery?" check in the client was
originally written against the 1:1 assumption, which is why a member who leaves
(or declines) and is re-invited was silently blocked in four different places.

### 1.2 Invite path (host → invitee)

```
Host taps "Add people"
  ├─ engine  : inviteToGroupCall { groupId, inviteeIds }      → media server
  │              → invitee's SDK receives `incomingGroupCall`
  └─ backend : call:conference:invite { callId, invitedUserIds, operationId }
                 → server rings + pushes each invitee
                 → invitee receives `call:incoming` (socket) and/or a push
                 → server broadcasts call:conference:roster to everyone
```

Both arms must fire. The socket/push arm is what rings a **backgrounded or
terminated** device; the engine arm only reaches a device whose media socket is
already connected.

### 1.3 Answer path (invitee)

```
call:incoming / VoIP push  →  CallProvider.onSignalIncoming  →  state INCOMING
                              (CallKit reports the ring on iOS)
User taps Accept
  ├─ backend : call:accept                { callId, callerId }        (1:1 vocabulary)
  ├─ backend : call:conference:accept     { callId, operationId }     ← NEW (client now emits)
  └─ engine  : accept(groupId)  → joins the mediasoup room
```

### 1.4 Leave path

```
├─ backend : call:end               { callId, otherUserIds }   (1:1 vocabulary)
├─ backend : call:conference:leave  { callId }                 ← NEW (client now emits)
└─ engine  : leaveGroupCall { groupId }  → leaves the mediasoup room
```

---

## 2. Root causes found

| # | Root cause | Side |
|---|---|---|
| 1 | iOS VoIP push carries no `ts`, so staleness falls back to the epoch inside `callId` — which for a conference is when the conference **started**. Every re-invite into a >60s-old conference was judged stale and dropped. CallKit had already rung (Apple requires reporting every VoIP push), so the user saw a full-screen call that could not be answered. | client ✅ fixed + **server must send `ts`** |
| 2 | VoIP payload dropped `isConference` / `isGroup` / `groupName` / `members` on the way into JS. | client ✅ fixed |
| 3 | Push→ring mapper hardcoded the group fields empty, so a conference rang as a 1:1 (host's name, earpiece, no grid, 1:1 redial guard eligible). | client ✅ fixed |
| 4 | The recovery pull sent no `ts`, so the conference-reinvite exception could never fire on that path. | client ✅ fixed |
| 5 | The socket ring path did not derive `isGroup` from `isConference`. | client ✅ fixed |
| 6 | The media SDK auto-declines a group ring for 15s after a decline, keyed on the (permanent) `groupId` — swallowing genuine re-invites **inside the engine**, with no event the app could see. | client ✅ fixed |
| 7 | `conferenceAccept` / `conferenceReject` / `conferenceLeave` were defined in the client but **never called** — accept/decline/leave went out only as the 1:1 `call:accept` / `call:reject` / `call:end`. | client ✅ fixed (additive) + **server must implement handlers** |

Root cause 7 is the one that needs a backend decision: the client now emits the
conference events **in addition to** the 1:1 ones. See §5.

---

## 3. REQUIRED — push / VoIP payload changes

### 3.1 iOS VoIP (PushKit) payload

Full contract in [`IOS_VOIP_BACKEND_SPEC.md`](./IOS_VOIP_BACKEND_SPEC.md). The
conference-relevant additions:

```jsonc
{
  "uuid":        "E621E1F8-C36C-495A-93FC-0C247A3E6E5F",  // RFC 4122, required
  "callId":      "sig_<hostId>_<conferenceStartMs>",
  "callerId":    "<host user id>",
  "callerName":  "Design team",       // conference display name
  "callType":    "audio",             // "audio" | "video"

  "ts":          1783072628459,       // ⚠️ REQUIRED — epoch ms at SEND time
  "isConference": true,               // ⚠️ REQUIRED on every conference invite
  "isGroup":      true,
  "groupId":      "68f0...c31",       // null for an ad-hoc conference
  "groupName":    "Design team",
  "members":      ["68f0...a11", "68f0...b22"],
  "conferenceHost": "<host user id>",
  "operationId":  "inv_<hostId>_1783072628459"   // which invite this ring settles
}
```

**`ts` is the single most important field.** It must be the moment **this push**
was sent, never the conference start time. Without it the client falls back to
the epoch inside `callId` and a re-invite into a long-running conference is
indistinguishable from a push that sat buffered in APNs for ten minutes.

Booleans may be real JSON booleans (a VoIP payload is not flattened). The client
accepts `true`, `1`, `"1"`, `"true"`.

### 3.2 Android FCM data push

Same fields. FCM flattens everything to strings, so send `"isConference": "1"`,
`"ts": "1783072628459"`, and `members` as a JSON array string or a CSV — the
client parses all three shapes.
[`ANDROID_CALL_PUSH_BACKEND_SPEC.md`](./ANDROID_CALL_PUSH_BACKEND_SPEC.md) needs
the same conference block added.

### 3.3 A re-invite MUST send a push

A member who left the conference is, from the push layer's point of view, an
offline callee again. If `call:conference:invite` only emits the socket event and
skips the wake push, a terminated/backgrounded device never rings at all.

---

## 4. REQUIRED — socket event payloads

### 4.1 `call:incoming` (server → invitee)

Must carry the same conference block:

```jsonc
{
  "callId": "sig_<hostId>_<conferenceStartMs>",
  "from":   { "id": "<hostId>", "name": "Host Name", "avatar": "https://..." },
  "media":  "audio",
  "ts":     1783072628459,          // ⚠️ REQUIRED — emit time
  "isConference": true,             // ⚠️ REQUIRED
  "isGroup": true,
  "groupId": "68f0...c31",
  "groupName": "Design team",
  "members": ["<id>", "<id>"],
  "conferenceHost": "<hostId>",
  "operationId": "inv_<hostId>_1783072628459"
}
```

Why `ts` matters here too: the client blacklists the ids of the call it just
ended for 60 seconds. A conference reuses its `callId`, so a re-invite lands on
that blacklist. The **only** thing that distinguishes a genuine re-invite from a
stale re-delivery is `isConference === true && ts > <local end time>`.

### 4.2 `call:pending:pull` ack (recovery path)

Each entry in `calls[]` must include `isConference`, `isGroup`, `groupId`,
`groupName`, `members`, `conferenceHost`, `operationId`. This is the path a
cold-booted device uses after a CallKit answer, so a conference invite missing
these fields is recovered in the wrong shape.

Also: the pull must **return a still-pending conference invite for a member who
previously left**. If leaving deletes their pending-invite record and the
re-invite does not create a new one, the pull comes back authoritative-empty and
the client ends the CallKit call the user just answered.

---

## 5. REQUIRED — conference signaling handlers

The client now emits these. They are **additive** — the 1:1 events still go out
unchanged — so a backend that ignores them is no worse off than today. But
without them, conference roster state stays wrong.

| Event | Payload | Server must do |
|---|---|---|
| `call:conference:accept` | `{ callId, operationId }` | Settle that invite; add the user to the roster; broadcast `call:conference:roster`; clear their busy lock's "ringing" state. **Must work when the user has no busy record** (a re-invited member who left has none). |
| `call:conference:reject` | `{ callId }` | Settle the invite as declined; stop the ring window for that member; broadcast the roster. |
| `call:conference:leave` | `{ callId }` | Remove the user from the roster; broadcast; release their busy lock; migrate host if they were host. |

### 5.1 Idempotency — mandatory

The client sends both vocabularies for the same user action:

```
accept  → call:accept            + call:conference:accept
decline → call:reject            + call:conference:reject
leave   → call:end               + call:conference:leave
```

So each of these must be **idempotent and safe to receive twice** for one logical
action. Specifically:

- `call:end` on a conference `callId` from a **non-host** must mean "this
  participant left", **not** "end the conference for everyone". Only
  `call:conference:end` from the host ends it for all.
- `call:accept` and `call:conference:accept` for the same `(callId, userId)`
  must produce exactly one roster addition and one roster broadcast.
- The host's "End for everyone" sends `call:conference:end` and then
  `call:conference:leave` — the leave after an end must be a no-op, not an error.

### 5.2 Busy lock

Leaving a conference **must release the member's busy lock**. If it does not,
`call:conference:invite` returns them in `busyUserIds` and the host sees
"<name> is currently on another call" instead of ringing them.

---

## 6. REQUIRED — mediasoup / media-server changes

The signaling backend and the media server are separate; both need work.

### 6.1 Re-join with the same `groupId`

When a peer calls `leaveGroupCall { groupId }` and is later re-invited, the
media server must:

1. **Fully remove the peer from the room** on leave — close their transports,
   producers, consumers, and drop them from the room's peer list. A ghost peer
   makes the re-join look like a duplicate and leaves a frozen tile for everyone.
2. **Accept a fresh `joinRoom` for the same `groupId`** from the same user with a
   new socket/transport set. The room must not be keyed to the peer's old
   transport ids.
3. **Re-emit `groupParticipantJoined`** to the existing peers so their rosters
   and tiles update. Without this, the re-joined member is invisible to the
   people already in the call.

### 6.2 `inviteToGroupCall` must re-ring a member who left

The host's engine runs a re-invite retry loop
(`NativeCallingSDK._reinviteGroup`) that calls
`inviteToGroupCall { groupId, inviteeIds }` for everyone not yet joined. If the
media server treats a user who was **once** in the room as permanently joined, it
will never re-send `incomingGroupCall` to them. It must be membership-**current**,
not membership-**ever**.

### 6.3 `declineGroupCall` must not permanently blacklist

The client sends `declineGroupCall { groupId }` when a group ring is declined,
and — because the client now clears its own 15s swallow window — may send it
again for the same `groupId` later in the same conference. The media server must
treat a decline as settling **that invite**, not as "this user refuses this
group", so a subsequent `inviteToGroupCall` still rings them.

### 6.4 Room lifetime

The room must survive **all** members leaving if the conference is still live
server-side (e.g. the host is re-inviting people back). If the room is destroyed
on the last leave, a re-invite creates a *new* `groupId` — which is fine for the
media path but breaks the client's assumption that the conference key is stable.
If you do mint a new `groupId`, the signaling `call:incoming` must still carry
the **original** `callId` and `isConference: true`.

### 6.5 `groupId` ↔ `callId` mapping (nice to have)

Today the client cannot map the backend conference `callId` to the media
server's `groupId`, so when it clears its stale group-decline memory it clears
**all** of them rather than the one. Exposing the mapping (either as `groupId` on
`call:incoming`, or as the conference `callId` on `incomingGroupCall`) lets that
be tightened to a single key. Not blocking; correctness is unaffected.

---

## 7. Client / server contract summary

| Client emits | When | Server must |
|---|---|---|
| `call:conference:invite` `{ callId, invitedUserIds, operationId }` | host adds people | ring + push each invitee, arm ring windows, broadcast roster, return `busyUserIds` |
| `call:conference:accept` `{ callId, operationId }` | invitee accepts | add to roster, settle invite, broadcast |
| `call:conference:reject` `{ callId }` | invitee declines | settle invite as declined, broadcast |
| `call:conference:leave` `{ callId }` | participant leaves | remove from roster, release busy, migrate host, broadcast |
| `call:conference:end` `{ callId }` | **host** ends for all | end conference, notify all, release all busy locks |
| `call:conference:remove` `{ callId, targetUserId }` | **host** kicks | remove, send `call:conference:removed` to target, broadcast |
| `call:conference:media` `{ callId, audioEnabled, videoEnabled }` | mute/camera toggle | update roster entry, broadcast |
| `call:conference:state` `{ callId }` | reconnect | reply `{ active, roster }` |

| Server emits | Client expects |
|---|---|
| `call:incoming` | conference block of §4.1, **including `ts` and `isConference`** |
| `call:conference:roster` | `{ callId, participants: [...] }` — full authoritative list; the client renders exactly this |
| `call:conference:converted` | same shape as roster |
| `call:conference:participant:left` | `{ callId, userId }` |
| `call:conference:host:changed` | `{ callId, hostId }` |
| `call:conference:ended` | `{ callId }` |
| `call:conference:removed` | `{ callId }` — sent only to the kicked user |

---

## 8. Backward compatibility & migration

- **No migration required.** Every field added here is additive and optional on
  the wire; the client already tolerates its absence (it just degrades to the
  behaviour described in §2).
- **Old client + new server:** harmless. The extra fields are ignored.
- **New client + old server:** the conference events are emitted, the acks time
  out after 4s, and `emitWithAck` resolves optimistically. The 1:1 events still
  carry the call. No user-visible regression — but the conference bugs in §2
  (items 1, 7) remain, because they need `ts` and the roster handlers.
- **1-to-1 calls are untouched** on both sides. No 1:1 payload, event, or handler
  changes anywhere in this document.

---

## 9. Validation / acceptance criteria

Server-side is done when all of these hold:

1. Every conference push (APNs VoIP + FCM) contains `ts` = send time, and
   `isConference: true`.
2. `call:incoming` for a conference contains `ts`, `isConference`, `isGroup`,
   `groupName`, `members`, `conferenceHost`, `operationId`.
3. `call:pending:pull` returns a still-ringing conference invite with the same
   fields, including for a member who left and was re-invited.
4. A member who leaves is removed from the roster within one broadcast, and their
   busy lock is released (a re-invite does **not** return them in `busyUserIds`).
5. A member re-invited after leaving receives both the socket ring **and** a push,
   and can be accepted from a terminated app.
6. A member re-invited within 15s of declining still rings.
7. `call:end` from a non-host on a conference `callId` does not end the call for
   anyone else.
8. Sending `call:accept` and `call:conference:accept` for the same user produces
   exactly one roster addition.
9. mediasoup: leave → re-join on the same `groupId` works, and existing peers get
   `groupParticipantJoined` for the re-joined member.
10. 1-to-1 voice and video regression suite passes unchanged.

---

## 10. Client-side changes already made (for reference)

| File | Change |
|---|---|
| `src/firebase/callEvents.js` | conference-aware push mint time — never fall back to the `callId` epoch for a conference |
| `src/calls/services/voipPushService.js` | pass the whole VoIP payload through (`ts`, `isConference`, `isGroup`, `groupId`, `groupName`, `members`, `conferenceHost`, `operationId`) |
| `src/calls/CallProvider.jsx` | `mapPushToIncoming` carries the real group shape; `onSignalIncoming` derives `isGroup` from `isConference` and exempts conferences from the 1:1 redial guard; pull stamps `ts` + `operationId`; emits `call:conference:accept` / `:reject` / `:leave`; clears the engine's group-decline window on an authoritative ring |
| `src/calls/engine/protocol.js` | new `CMD.CLEAR_GROUP_DECLINE` |
| `src/calls/native-engine/NativeCallEngine.js` | handles `CLEAR_GROUP_DECLINE` |
| `src/calls/native-engine/NativeCallingSDK.js` | new `clearGroupDecline(groupId?)` — group-scoped, 1:1 decline memory untouched |
| `docs/IOS_VOIP_BACKEND_SPEC.md` | payload contract updated with `ts` + the conference block |

---

## 11. Known platform limits (not fixable server-side)

- **Conference VIDEO answered from a terminated/locked app:** iOS does not allow
  `AVCaptureSession` to start in the background. The call joins with **audio
  only**; the camera can start only once the user brings the app to the
  foreground. Expected product behaviour: join with video off, enable it on
  foreground. This is an iOS constraint, not a bug in either side's code.
- **Answering on the CallKit screen does not foreground the app.** iOS shows its
  own in-call UI; the user must tap the app icon there to reach the in-app
  conference screen. Audio joins in the background regardless.
- **Apple forbids a "cancel" VoIP push.** A conference invite that is withdrawn
  while the device is terminated cannot have its CallKit ring dismissed by a
  push; the client dismisses it via the pending-pull sweep once it boots.
