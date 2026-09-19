# Messaging pipeline — backend contract (REQUIRED)

**Audience:** backend / server team. No app-repo access needed — every contract
below is stated in full.

**Why this doc exists:** the mobile client's entire duplicate-prevention,
ordering and unread model is written on the assumption that the server provides
the guarantees below. Those assumptions appear in **40+ source comments** but
have never been verified against the server. Where the server does not provide
them, the client **cannot** compensate — the information simply does not exist
on the device.

Related, already-written specs (not superseded by this doc):
`CALL_PUSH_BACKEND_SPEC.md`, `CALL_RELIABILITY_BACKEND_SPEC.md`,
`MESSAGE_PUSH_BACKEND_SPEC.md`, `BACKEND_HANDOFF_iOS_CALL_PUSH.md`.

---

## Priority summary

| # | Item | Priority | Blocks launch? |
|---|---|---|---|
| 1 | `(chatId, clientMessageId)` hard idempotency | **P0** | ✅ Yes |
| 2 | Echo `clientMessageId` in every send response | **P0** | ✅ Yes |
| 3 | `seq` on every message + in send ack | **P0** | ✅ Yes |
| 4 | Server-authoritative `unreadCount` | P1 | No |
| 5 | Presence TTL / heartbeat cadence | P2 | No — **read the ⚠️ first** |
| 6 | Per-user read watermark + `deletedFor` | P1 | No |
| 7 | Media content-hash dedup + chunk resume | P1 | No |

---

# 1. `(chatId, clientMessageId)` hard idempotency — **P0**

## The problem

The client sends **the same message over two transports** as a reliability net:

1. **Socket fast path** — `message:send` (or `message:reply` / `message:quote` /
   `group:message:send`) fires immediately.
2. **Durable outbox** — the same message is written to a local SQLite `outbox`
   table with `notBefore = now + 4s` (being raised to 20s). A background worker
   drains it over **REST `POST user/chat/message/send`** if no socket ack
   arrived.

Both carry the **same `clientMessageId`**. On socket ack the client deletes the
outbox row, so on the happy path only one send leaves the device.

**But on a slow network the two WILL race.** Socket emit goes out, the server
stores the message, the ack takes 5s to come back — the outbox worker has
already re-sent it over REST. The server now has two inserts for one logical
message.

Same class of failure on REST alone: `axios` timeout is 15s. If the server
processed the request but the response was lost, the worker retries. The client
**cannot** know whether the first attempt was stored.

## Required

Create a unique partial index:

```js
db.messages.createIndex(
  { chatId: 1, clientMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientMessageId: { $type: 'string' } },
    name: 'uniq_chat_client_message_id',
  }
);
```

Apply idempotent insert on **every** send path:

| Transport | Event / route |
|---|---|
| Socket | `message:send` |
| Socket | `message:reply` |
| Socket | `message:quote` |
| Socket | `group:message:send` |
| REST | `POST user/chat/message/send` |

Pseudocode:

```js
const existing = await Messages.findOne({ chatId, clientMessageId });
if (existing) {
  return ack({
    status: true,
    duplicate: true,
    data: {
      messageId: existing.messageId,
      _id: existing._id,
      clientMessageId,          // see §2 — MUST be echoed
      seq: existing.seq,        // see §3
      createdAt: existing.createdAt,
      status: existing.status,
    },
  });
}
// else: insert, then ack with the same shape (duplicate: false)
```

## ⚠️ Critical detail — a duplicate is NOT an error

Return **`status: true`** with the existing document.

If you return `status: false` / an error, the client's ack handler
(`sendMessageViaSocket → onAck`) marks the bubble **`failed`** and shows the user
a red retry icon — for a message the server successfully stored and already
delivered to the peer. That is worse than the duplicate.

## Also required

- Client-generated ids look like `temp_1718...` and `msg_1718..._a1b2c3`.
  Treat them as **opaque strings**. Do not validate format, do not regenerate.
- The client also sends `clientId` and `tempId` as **aliases of the same value**
  (legacy wire names). Accept any of the three; `clientMessageId` is canonical.
- Call-log messages use `clientMessageId = "call_<callId>"`. Same index, same
  rule — this is what stops the call entry appearing twice in a thread.

## Acceptance test

1. Send one message with `clientMessageId = "test_dup_1"` over socket.
2. Send the **identical** payload over `POST user/chat/message/send`.
3. Assert: `db.messages.countDocuments({ chatId, clientMessageId: 'test_dup_1' }) === 1`
4. Assert: second call returned `status: true, duplicate: true` with the **same**
   `messageId` as the first.
5. Assert: the peer received exactly **one** `message:new`.

---

# 2. Echo `clientMessageId` in every send response — **P0**

## The problem

The client sends a message optimistically and paints the bubble with a local id.
When the server's response arrives it must map that response back to the correct
bubble. The **only** durable handle is `clientMessageId`.

`message:sent:ack` and `group:message:sent` mostly do echo it today.
**`message:reply:response` and `message:quote:response` do not** — they carry
only `messageId`.

Because of that the client keeps a **single-variable workaround**
(`pendingReplyTempIdRef`) that stores "the last reply I sent". With two replies
sent in quick succession:

```
User sends R1  → pendingRef = tempR1
User sends R2  → pendingRef = tempR2   (tempR1 overwritten, lost forever)
R1's response arrives, has no clientMessageId
   → client uses pendingRef  → applies R1's serverMessageId to R2's bubble
```

Result: **R1 stays on the "sending" clock forever**, and **R2 now carries R1's
server id** — so every later reply / react / edit / delete on R2 targets the
wrong message on the server.

## Required

Include `clientMessageId` in the payload of **all** of these:

| Event | Currently echoes? |
|---|---|
| `message:sent:ack` | partial — make it guaranteed |
| `group:message:sent` | partial — make it guaranteed |
| `group:message:sent:ack` | partial — make it guaranteed |
| `message:reply:response` | ❌ **missing — this is the bug** |
| `message:quote:response` | ❌ **missing — this is the bug** |
| `message:forward:response` | ❌ missing |
| `message:forward:multiple:response` | ❌ missing (per forwarded item) |

Canonical response shape for every send:

```jsonc
{
  "status": true,
  "data": {
    "messageId":       "<canonical uuid>",
    "_id":             "<mongo ObjectId>",
    "clientMessageId": "<exactly what the client sent>",
    "seq":             12345,
    "createdAt":       "2026-09-18T10:22:31.004Z",
    "chatId":          "<chatId>",
    "status":          "sent",
    "duplicate":       false
  }
}
```

`tempId` may be included as a legacy alias of `clientMessageId`. Do not send one
without the other.

## Also required — echo it on fan-out too

`message:new`, `message:received`, `group:message:new` should carry
`clientMessageId` when the message has one. The sender's **other devices** use it
to reconcile their own copy, and it is the client's most reliable dedupe key on
reconnect replays.

## Acceptance test

1. Send two replies ~200ms apart in the same chat.
2. Assert both `message:reply:response` payloads contain the correct, distinct
   `clientMessageId`.
3. On device: both bubbles show a single tick. Neither is stuck on the clock.

---

# 3. `seq` on every message + in the send ack — **P0**

## The problem

Message ordering on screen is currently driven by **`timestamp`**, and for a
message the user just sent that timestamp is `Date.now()` on **the sending
device**.

A user whose phone clock is 10 minutes fast (manual time, wrong timezone, clock
reset after a dead battery — common) sees their own messages pinned above the
peer's newer messages until a server sync rewrites the row.

The client **cannot** fix this. It has no trustworthy clock and no global order.
Ordering must be server-assigned.

The `seq` column, the `idx_messages_chat_seq` index, and the seq-based
reconnect-catchup cursor **already exist on the client** — the value just isn't
reliably supplied.

## Required

### 3.1 Allocate a monotonic per-chat `seq` on every message

```js
// Redis (preferred — atomic, fast)
const seq = await redis.incr(`chat:seq:${chatId}`);

// or Mongo counter doc
const { value } = await Counters.findOneAndUpdate(
  { _id: `chat:${chatId}` },
  { $inc: { seq: 1 } },
  { upsert: true, returnDocument: 'after' }
);
```

Rules:
- Strictly increasing per `chatId`. Gaps are fine. **Reuse is not.**
- Assigned **at insert**, never mutated afterwards.
- Applies to **every** message type: text, media, album, system, **and `call`**.
- Backfill existing rows: `seq` ordered by `createdAt` per chat, one pass.

### 3.2 Include `seq` in every response that carries a message

- `message:sent:ack`, `group:message:sent` (**this is the new part**)
- `message:new`, `message:received`, `group:message:new`
- `message:fetch:response`, `message:sync:response`, `group:message:sync:response`
- `message:sync:catchup:response` → inside each `chats[].newMessages[]`
- the history page response
- `chat:list` / `chat:list:update` → on the `lastMessage` object

### 3.3 Index it

```js
db.messages.createIndex({ chatId: 1, seq: 1 }, { name: 'chat_seq' });
```

The client's reconnect catchup sends `{ chatId, lastSeq }` per chat and expects
every message with `seq > lastSeq`. Without this index that is a collection scan
per chat per reconnect.

## Why `createdAt` alone is not enough

Two messages in the same millisecond have no defined order. `seq` is the
tiebreak, and it is also the client's sync cursor — a timestamp cursor is
ambiguous at page boundaries and is what the keyset pagination was built to
avoid.

## Acceptance test

1. Two users send simultaneously in the same chat.
2. Assert both messages have distinct `seq`, and `seq` order matches server
   insert order.
3. Assert `message:sent:ack` carried `seq`.
4. On device: both users see the **same** order.

---

# 4. Server-authoritative `unreadCount` — **P1**

## The problem

The client maintains unread locally with a blind `+1` per incoming message, and
its in-memory dedupe set is **capped at 1000 ids**. On a reconnect replay of an
evicted id the counter increments again.

Worse: on `chat:list` hydration the client currently **prefers its own local
value** over the server's. So once the count drifts it **never** self-corrects —
a permanent phantom badge.

The client is being fixed to accept the server value (see the client task list).
For that to work the server value must be correct and always present.

## Required

### 4.1 Derive unread from the read watermark

```js
unreadCount = await Messages.countDocuments({
  chatId,
  seq:      { $gt: user.readUpToSeq[chatId] || 0 },
  senderId: { $ne: userId },
  deletedFor: { $ne: userId },
});
```

Cache it per (user, chat) and invalidate on new message / read-watermark
advance. Do not compute it with a live `countDocuments` on the hot path at
scale.

### 4.2 Send it in both places

- `chat:list` → per chat
- `chat:list:update` → per chat, on **every** update

The client already treats `chat:list:update`'s value as authoritative; it will
be made to treat `chat:list`'s the same way.

### 4.3 Call entries must not badge

A `type: 'call'` message with `payload.outcome` of `completed` / `rejected`
**must not** count toward unread. Only `missed` and `cancelled` do. The client
has this rule locally (`isNonBadgingCall`); mirror it server-side so the two
agree.

## Acceptance test

1. Peer sends 3 messages. Assert `chat:list` reports `unreadCount: 3`.
2. Force a duplicate `message:new` fan-out for one of them.
3. Assert `chat:list` still reports **3**, not 4.
4. Open the chat (client emits `message:read:all`). Assert next `chat:list`
   reports **0**.

---

# 5. Presence TTL / heartbeat cadence — **P2**

> ## ⚠️ READ THIS BEFORE CHANGING ANYTHING
>
> **Do NOT raise the presence TTL until §5.1 is confirmed and fixed.**
> Doing it first will make incoming calls *worse*, not better.

## 5.1 PREREQUISITE — call ringing must not be gated on presence

`CALL_PUSH_BACKEND_SPEC.md` already states this, verbatim:

> *"do NOT gate on the callee looking **online/offline**. When the user
> swipe-kills the app, the server-side socket can look connected for another
> 30–60s (stale, not yet timed out). Gating on presence routes the ring to that
> dead socket and skips the push → the callee's phone shows nothing... This is
> the classic 'first call after killing the app doesn't ring' bug."*

**Confirm, in code:** does any of the following consult presence / "has an active
session" / "is online"?

- the decision to send the **iOS VoIP push** on `call:ring`
- the decision to send the **Android FCM data push** on `call:ring`
- the `call:unavailable` rejection path

If **yes** → fix that first. Ring and push **unconditionally** on every
`call:ring`; the client de-dupes the socket event against the push on `callId`.

**Why this ordering matters:** the client heartbeats every **4s** today, so a
force-killed app lapses offline in ~9–12s. That short window is currently
masking the presence-gating bug. Raise the TTL to 30–60s while gating is still
in place and the dead-ring window grows from ~10s to ~60s — a 6× regression on
"first call after killing the app doesn't ring".

## 5.2 Then: raise the TTL

Current: client emits `presence:heartbeat` every **4s** because
`PRESENCE_CONN_TTL_SECONDS` is short. The client comment states the constraint
explicitly: *"MUST stay <= server PRESENCE_CONN_TTL_SECONDS"*.

At scale: 100M concurrent users × 0.25 Hz = **~25M ops/sec** on presence alone.
This is not survivable and it is not a client-tunable number.

Target:
- `PRESENCE_CONN_TTL_SECONDS` → **60**
- client heartbeat → **25–30s** (client change, gated on this one)
- Better: derive liveness **passively** from socket connect/disconnect +
  `app:state` events, and use the heartbeat only as a slow keepalive.

`presence:update` / `presence:bulk` / `presence:fetch:response` payloads stay
unchanged — only cadence and TTL move.

## Acceptance test

1. Swipe-kill the callee's app. Immediately call them.
2. Assert the VoIP (iOS) / FCM data (Android) push **was sent**.
3. Assert the phone rings.
4. Repeat at 5s, 20s, and 45s after the kill. All three must ring.

---

# 6. Per-user read watermark + `deletedFor` — **P1**

## The problem

Two pieces of per-user state live **only on the device today**:

- **read position** — there is no per-user watermark the server can hand to a
  second device
- **delete-for-me** — stored in the device's local key-value store. Delete a
  message for yourself on phone A and it is still there on tablet B, forever.

Neither is fixable client-side: a device cannot learn what another device did
unless the server tells it.

## Required

### 6.1 Store `readUpToSeq` per (user, chat)

```jsonc
// chatMembers / chatParticipants
{
  "chatId": "...",
  "userId": "...",
  "readUpToSeq":      1204,   // advanced by message:read:all / message:read:upto
  "deliveredUpToSeq": 1230
}
```

- Advance **monotonically only** — never move it backwards.
- Advanced by `message:read:all`, `group:message:read:all`, `message:read:upto`.
- Return it in `chat:list` and in `message:sync:catchup:response` per chat
  (the client already reads `peerReadUpToSeq` from catchup and persists it).
- This is also the input to §4's unread derivation.

### 6.2 `deletedFor` must be consistent across every read path

The field exists. The gap is that it is not consistently present everywhere the
client reads messages. It must appear in:

- `message:sync:response` → `mutatedMessages[]`
- `message:sync:catchup:response` → `chats[].mutatedMessages[]`
- `message:fetch:response`
- the history page response

The client applies `deletedFor` idempotently as an absolute value
(`_applyMutatedDoc`) and advances a per-chat `mutatedSince` cursor, so replays
are safe. It just needs the field to actually be there.

### 6.3 `mutatedSince` must work

The client sends `{ chatId, lastSeq, mutatedSince }` in
`message:sync:catchup`. The server must return every message whose
`updatedAt > mutatedSince` in `mutatedMessages[]`, plus `latestMutationAt` so the
cursor advances. This is how edits and deletes made while the device was offline
land.

## Acceptance test

1. Device A: delete-for-me a message.
2. Device B: reconnect.
3. Assert `message:sync:catchup:response` carried that message in
   `mutatedMessages[]` with `deletedFor` containing the user id.
4. Assert it disappears on device B.

---

# 7. Media content-hash dedup + chunk resume — **P1**

## The problem

The client already does the expensive half: it computes a **SHA-256 of the final
upload bytes** (up to 64MB) before every media send and calls
`user/media/exists`. If the server does not honour that, every retry and every
re-send of the same file is a full re-upload — on mobile data.

Chunked uploads have the same issue: the client supports resume-from-offset, but
only if the server reports how many bytes it already holds.

## Required

### 7.1 `user/media/exists` — real content-hash lookup

```
POST user/media/exists
  { "sha256": "<hex>", "byteSize": 12345, "fileCategory": "image" }
→ { "exists": true,  "mediaId": "...", "mediaUrl": "...", "mediaThumbnailUrl": "..." }
→ { "exists": false }
```

On `exists: true` the client skips the upload entirely and sends the message
with the returned `mediaId`.

- Index the hash column.
- Scope the lookup so it cannot leak another user's private media: match on
  `(sha256, byteSize)` **and** verify the requester is allowed a reference, or
  store per-user references to a shared blob.

### 7.2 Chunk session status must report `receivedBytes`

```
GET  user/media/chunk/session/:sessionId
→ { "sessionId": "...", "receivedBytes": 4194304, "totalBytes": 10485760, "expired": false }
```

The client resumes from `receivedBytes`. If this is missing or wrong it restarts
at 0.

- Keep sessions alive **at least 24h** — the client deliberately preserves a
  cancelled upload's chunk session so the user can resume later.
- Return `expired: true` rather than 404 so the client can cleanly restart.

### 7.3 Reject early, not late

If a file type is blocked, reject it at **upload time** with a clear code — not
at `message:send` time. A late rejection leaves an orphaned "sending" bubble on
the sender's screen that only a client-side reconciler can clean up.

## Acceptance test

1. Upload a file. Note `mediaId`.
2. Call `user/media/exists` with the same sha256. Assert `exists: true` and the
   same `mediaId`.
3. Start a chunked upload, kill it at 40%, restart.
4. Assert the session reports `receivedBytes` ≈ 40% and the upload resumes
   rather than restarting.

---

# What is NOT in scope of this document

These are **messaging-pipeline** changes. They do **not** affect voice/video call
quality, call connection time, call drops, ring reliability, or conference
roster sync — those run on a **separate SFU** with its own transport, token and
ICE/TURN servers.

The only call-adjacent effect here is on the **call-log message inside a chat
thread** (§1 removes its duplicate bubble, §3 fixes its position, §4 fixes its
badge).

For actual call reliability work, see — all of these have **open backend items**:

| Doc | Open backend items |
|---|---|
| `CALL_RELIABILITY_BACKEND_SPEC.md` | authoritative call record; relay terminal events to **all** participants; **`call:sync` reconcile endpoint**; missed-vs-rejected reason correctness |
| `CALL_PUSH_BACKEND_SPEC.md` | VoIP/FCM push on every ring (ungated); deregister `pushToken` + `voipToken` on logout |

> **`call:sync` is the highest-value quick win.** The client side is already
> implemented and already emits it on every reconnect and every foreground while
> a call is live — only the server handler is missing. Adding it fixes stuck
> "Calling…" screens and ghost rings after a network blip, background, or app
> kill.

Separately, and not covered by any spec: **TURN server capacity and geographic
distribution**. Roughly 15–20% of cellular-to-cellular calls fall back to a TURN
relay. Under-provisioned or distant TURN is the single most common cause of real
call-quality complaints.

---

# Rollout order

```
P0 (launch blockers, ship together)
 ├── 1. (chatId, clientMessageId) unique index + idempotent insert on all 5 paths
 ├── 2. clientMessageId echoed in every send response + fan-out
 └── 3. seq allocated on every message, returned everywhere, indexed

P1 (immediately after launch)
 ├── 6. readUpToSeq + deletedFor consistency   ← do before 4, it is the input
 ├── 4. server-authoritative unreadCount
 └── 7. media hash dedup + chunk resume

P2 (scale work)
 ├── 5.1 confirm + remove presence gating from call ring/push   ← MUST be first
 └── 5.2 then raise PRESENCE_CONN_TTL_SECONDS to 60
```

**Item 3 (`seq`) needs a backfill migration.** Plan it before the P0 ship.
