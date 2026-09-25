# Backend: message delivery changes needed (2026-09-25)

**Scope:** 1:1 messages to Android/iOS, socket server `talkstrysocket.tresting.com`.
**Evidence:** measured on two real devices.
- Android (Nothing A063, user `69a5185acf2a2ed928da5ffd`)
- iPhone 14 Pro (user `6a72cf2d26d07447d7a146a0`)

The server event capture comes from the client's socket.io hooks. Every item below was reproduced; nothing is a guess unless it says so.

| # | Item | Priority | Status (re-tested 2026-09-25, 16:38–16:42 IST) |
|---|------|----------|------|
| 1 | Message sent while the receiver is going to background: no push, no delivery, no tick | **High** | ✅ Passing (3/3 again: network drop ×2, away 9 s). |
| 2 | WebSocket upgrade is rejected (`400`) for every request that carries an `Origin` header | **High** | ✅ Fixed. |
| 3 | First socket session after a push-started cold launch is closed by the server within ~1 s | Medium | ✅ Looks fixed. 2/2 clean runs (it was 4/5 failing). |
| 4 | `replyTo` carries the Mongo `_id` instead of the message UUID | Low | ✅ Fixed. |
| 5 | `chat:list` is slow | Medium | ⚠️ **Much better, not done.** 8 runs: 1.1, 1.3, 1.4, 1.4, 1.7, 2.1 s typical (median ~1.4 s), but **spikes of 4.8 s and 5.9 s**. For reference over the same socket: `mute:sync` 0.2 s, `catchup` 0.6–0.8 s. Target: always under 1 s, **no spikes**. |
| 6 | On reconnect, missed messages are replayed **before** the session is re-authenticated | Medium | ✅ **Fixed.** Order is now `connect → authenticated`; missed messages arrive after auth and reach `delivered` (2/2 network-drop runs, with a notification). |
| 7 | Group chats: seq-range fetch | **High** | ✅ Server part done. |
| 8 | iOS receivers get the push while away | **High** | ✅ Confirmed manually on the iPhone. |

**Remaining for the backend: item 5 only** (`chat:list` under 1 s).

The client already ships workarounds for 1, 2, 4 and 6, and they are described under each item. They reduce the damage but cannot replace the server fix.

---

## 1. Message sent while the receiver is going to background gets no push and is never delivered live — **HIGH**

### What happened (real user report, 12:05 IST)

| Time (IST) | Event |
|---|---|
| 12:05:01 | Android app goes to background (user pressed Home). The client emits `app:state {state:'background'}` and `presence:away`. |
| 12:05:08 | iPhone sends "Huuuuu" (seq 800). The server acks it. |
| 12:05:11 | Android OS **freezes** the app process (normal Android behaviour, ~10 s after backgrounding). |
| after | Android never receives it. No `message:new` is processed and **no FCM push is sent**. The sender stays on a single tick (`sent`) permanently. |

The server does have the message: `message:sync {sinceSeq:0}` returns seq 800 "Huuuuu".

### Why

At 12:05:08 the Android socket still looked connected, so the server treated the receiver as **online**:
- it emitted `message:new` on the socket only;
- it did **not** send the FCM push.

The frozen process never read that frame. The connection later died (ping timeout), and the message was lost from the live path.

For comparison, the same send made while the app was already frozen works: the server replied `ack {delivered:false, offline:true}`, then `message:delivered {reason:"push_accepted"}`, and the FCM push woke the app. **The gap is only the few seconds between `presence:away` and the socket actually dying.**

### What the server should do (either one is enough; both is best)

1. **Push while away.** After a socket has sent `presence:away` / `app:state background`, a new message to that user must **also** go out as an FCM/APNs push, not only as a socket emit. This lasts until the same socket sends `presence:active` / `app:state foreground`.
2. **Push when the delivery ack doesn't come.** If a message was emitted on the receiver's socket but no `message:delivered` came back from that device within ~5 s, send the FCM push. (The client emits `message:delivered` within about 100 ms of receiving a message while it is running.)

Both keep the current fast path for foreground users, who ack within ~100 ms, unchanged.

### Same bug, network-drop variant (reproduced 13:03 IST)

Steps and result:
1. The Android app is in the background and mobile data + Wi-Fi are turned off (`svc data/wifi disable`).
2. The iPhone sends "offtest2" (seq 809) 4 s later.
3. Data is turned back on after 8 s.
4. Result: **no FCM push for 2+ minutes** and the sender stays on `sent`. The message arrived only when the app was opened by hand.

The client's TCP connection died without a close, so the server still counted the socket as connected for up to `pingInterval + pingTimeout` (25 s + 30 s), emitted into it, and never pushed. **Once the server declares that socket dead, any message it emitted there without a `message:delivered` should be pushed.** Fix (2) above covers this too.

In a later identical run the server *did* push within 1 s of the network returning. The outcome depends on whether the server had noticed the dead socket.

### Client side (already shipped)

The client now repairs **seq gaps**.
- When a live message arrives with `seq > localMax + 1`, it calls `message:fetch {chatId, fromSeq, toSeq}` for the missing range.
- On every reconnect or foreground it looks for holes in the recent seqs of each chat and fetches them once per session.

The lost message therefore appears **the next time a message arrives or the app opens**, and the sender then gets the delivered tick. Without a server change there is still **no notification** at the time the message is sent.

---

## 2. WebSocket upgrade is rejected when the request has an `Origin` header — **HIGH**

### Reproduce (curl, any machine)

```bash
H=talkstrysocket.tresting.com
# no Origin → 101 Switching Protocols
curl -s -o /dev/null -w "%{http_code}\n" --http1.1 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "https://$H/socket.io/?EIO=4&transport=websocket"
# with ANY Origin → 400 {"code":3,"message":"Bad request"}
curl -s -o /dev/null -w "%{http_code}\n" --http1.1 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Origin: https://$H" \
  "https://$H/socket.io/?EIO=4&transport=websocket"
```

The same happens for polling: `Origin: https://x.com` returns `400 {"code":3,"message":"Bad request"}`.

| Origin sent | Result |
|---|---|
| none | 101 / 200 |
| `""` (empty) | 101 |
| `https://talkstrysocket.tresting.com` | **400** |
| `https://talkstrybackend.tresting.com` | **400** |
| `http://localhost:8081`, `https://example.com`, `null` | **400** |

`{"code":3,"message":"Bad request"}` is engine.io's own rejection, which points to the socket.io `cors` / `allowRequest` configuration.

### Why it matters

React Native's WebSocket **always** adds `Origin: https://<host>`. As a result, on **both Android and iOS** the websocket upgrade failed on every connection (`probe error: websocket error`), and the app has been running on HTTP long-polling the whole time. That means higher latency and more battery use. A failed probe also caused the server to close the session (see item 3).

### Fix

Allow requests without an Origin and requests from the app's hosts in the socket.io server config. For example, remove the Origin restriction for native clients, or add the domains to `cors.origin`. Native apps are not browsers, so an Origin check does not protect anything for them.

### Client side (already shipped)

The client now sends an explicit empty `Origin` (`extraHeaders: {origin: ''}`). Both devices are confirmed on `transport: websocket`. Please still fix the server: any other client (web, a future SDK) will hit the same `400`.

---

## 3. First session after a push-started cold launch is closed by the server within ~1 s — **MEDIUM**

### Measured (Android, app killed, launched by tapping a message notification)

```
11:44:12.806  socket connected (polling)            sid vRt7jhG67tsOSy6LAAKC
11:44:13.782  websocket probe error, ws closed 1006
11:44:13.787  engine close: "transport close", desc "transport closed by the server" (transport: polling)
11:44:15.861  socket connected (2nd session)        → upgraded to websocket, stable
```

- **Frequency:** seen in 4 of 5 push-started cold launches; not seen in 4 launcher cold launches.
- **What it costs:** the first `authenticate` is lost, so `authenticated` arrives about 3.2 s after the first attempt. The first message sync after a notification tap is therefore delayed by about 2–3 s.
- In one run the probe websocket was closed by the server with **no close code**; Android reported `Code 1005 is reserved`, i.e. the server sent an empty close frame.

### Ask

Check server logs for these session ids (times in IST, 2026-09-25). Why did the server close the polling transport of a freshly connected, authenticating session right after its websocket probe failed?

Possible causes, **unverified**:
- a duplicate-device session check;
- auth middleware timing;
- the probe failure tearing down the session.

---

## 4. `replyTo` is the Mongo `_id`, not the message UUID — **LOW**

A reply's `message:new` carries:

```json
"replyToMessageId": "e47e1c95-99c5-4f46-a166-19456f251d36",   // UUID ✅
"replyTo":          "6ab612be39599581392cd485",               // Mongo _id ❌
"replyPreview":     { "messageId": "e47e1c95-…", "mediaThumbnailUrl": "…", … }
```

Clients key every stored message by the **UUID `messageId`**. Some payload shapes arrive without `replyToMessageId` (sync docs, echoes). When a client falls back to `replyTo`, the quote points at an id no device has stored, and the reply bubble loses its quoted image.

**Ask:** send `replyTo` as the UUID as well, or always include `replyToMessageId` and `replyPreview.messageId` in every shape: `message:new`, `message:sync`, `message:fetch`, catch-up and REST history.

### Client side (already shipped)

The client now prefers `replyToMessageId`, then `replyPreview.messageId`, and never overwrites a stored UUID with a Mongo id.

---

## 5. `chat:list` takes 27 s to answer — **MEDIUM**

Measured from the Android client at 12:59 IST on a healthy connection, same socket, one after the other:

| Emit | Answered after |
|---|---|
| `message:sync:catchup` | **0.8 s** (ack and event) |
| `chat:list` | **27.4 s** (ack), 27.8 s (`chat:list:response`) |

The client used to wait for `chat:list` (20 s timeout) before its message catch-up, so a message missed during a network drop showed up ~26 s after reconnect. The client no longer waits; the two now run in parallel. The chat list itself (new chats, unread counts, last-message previews) still refreshes 27 s late on every reconnect.

**Ask:** profile `chat:list`, which is probably one query per chat or an unindexed lookup. Target under 1 s.

### Re-measured 15:50 IST (after the first server change): still 5.7–7.7 s

| Call | Same data | Time |
|---|---|---|
| socket `chat:list` | 48 chats, 57 KB response | **5.7 s, 6.4 s, 7.7 s** |
| REST `POST /api/v2/user/chat/list` | the same chat list | **0.8–0.9 s** (one outlier 3.2 s) |
| socket `message:sync:catchup` | for comparison | 0.6–0.9 s |

The response is small: 57 KB, no presigned URLs, no member arrays. The time is therefore spent **building** it, not sending it. Each chat row carries fields that look computed per chat: `unreadCount`, `participantPresence`, `participantLastSeen`, `isSavedContact`, `isMuted`, `peerUser`, `lastMessage*`. At 48 chats, ~120–160 ms per chat is exactly an N+1 pattern: several queries or Redis calls per chat, run one after another.

**Concrete fixes (any combination):**
1. **Reuse the REST handler's query.** REST builds the same list in under 1 s, so the socket handler should call the same service function instead of its own per-chat loop.
2. **Batch the per-chat lookups:**
   - unread counts in one aggregation (`$group` by chatId);
   - presence/last-seen for all peers in one Redis `MGET` or pipeline;
   - saved-contact and mute flags in one `$in` query each;
   - last messages from the chat documents' denormalized fields, or one `$in` on message ids.
3. **Run what can't be batched in parallel** (`Promise.all`), not sequentially.
4. **Indexes:** confirm there are indexes on `messages(chatId, seq)`, on the unread query's filter (e.g. `chatId + receiverId + status`), and on the chat-membership lookup.

**Verify:** `socket.emit('chat:list', {}, ack)` returns in under 1 s for a 48-chat user, measured 3 times.

### Re-measured 16:40 IST (after the second server change)

| Run | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| `chat:list` (s) | 1.73 | 2.06 | 1.38 | 1.42 | **4.82** | **5.95** | 1.08 | 1.31 |

The same socket round-trips `mute:sync` in 0.2 s, so the network is not the cause. The typical case is now close to the target. What remains:
1. **Spikes (4.8–6 s)** in 2 of 8 runs. Something sometimes stays sequential or uncached: a cold cache, a lock, or a slow per-chat call that sometimes waits. Please log the handler's own timings per step for one slow call.
2. **The typical 1.1–2.1 s** is still about 1 s over REST's 0.8 s. Check whether a sub-step (presence, unread counts) is still sequential.

---

## 6. Missed messages are replayed before re-authentication; early receipts are dropped — **MEDIUM**

### Measured (Android, 13:12 IST, network off → iPhone sends "offtest4" → network on)

```
13:12:40.434  client emits message:delivered {messageId: 682ddd8a…}   ← replayed message:new already processed
13:12:40.438  'connect' fires on the client (same sid Pluz_… — session recovered)
…             client emits authenticate → server replies 'authenticated'
result:       sender stays on single tick ("sent") permanently
```

After a network drop the server recovers the session (same socket id) and re-emits the missed `message:new` **immediately**, before this connection has been authenticated. The client acknowledges it at once. That `message:delivered` reaches the server before the new session is bound to a user, so it is rejected as NOT_AUTHENTICATED and **no error comes back to the client**. The receipt is lost for good.

### Ask (any one)

1. Replay recovered packets only **after** the session is re-authenticated.
2. Or accept `message:delivered` / `message:read` on a recovered session (the recovered socket was already authenticated before the drop).
3. At minimum, answer a rejected emit with an ack or error event, so the client knows to retry.

### Client side (already shipped)

All delivery receipts now go through a queue that holds them until the server's `authenticated` event, then sends them. The fix was verified: "offtest6" in the same scenario reached `delivered` without the app being opened.

---

## 7. Group chats: the same guarantees as 1:1 — **HIGH**

Everything above was measured on a **1:1** chat. Groups use different events (`group:message:new`, `group:message:sync`, `group:message:delivered`), so each fix must be applied to that path too:

| 1:1 fix | Group equivalent needed |
|---|---|
| Item 1: push while away / when no delivery ack arrives within ~5 s / after a dead socket | The same for every group member whose socket is away, dead or unacknowledged. |
| Item 5: fast `chat:list` | The same list covers groups. |
| Item 6: no replay before re-auth; don't drop early `group:message:delivered` | The same. |
| Seq-range fetch: `message:fetch {chatId, fromSeq, toSeq}` (works, ~50 ms) | **New:** `group:message:fetch {groupId, fromSeq, toSeq}`, with a per-group `seq` on every group message. Without it the client cannot repair a missed group message (see item 1, "Client side"). Group sync is keyed on `lastMessageId`, and that cannot express a hole below the newest message. |

**Ask:** confirm each row, or tell us the group payload shape (does every group message carry a monotonic per-group `seq`?) so the client can add group gap repair.

---

## 8. Item 1 must also cover iOS receivers — **HIGH**

iOS suspends a backgrounded app within seconds, and its socket goes silent without closing, just like the Android freeze in item 1. For an iPhone receiver:
- While its socket has sent `presence:away` / `app:state background`, or is unacknowledged or dead, a new message must go out as an **APNs alert push**. That means the FCM `notification` block or APNs `alert`, **not** data-only: a data-only push does not wake a suspended iOS app to show anything.
- The push's `messageId` must be the UUID, so the client's notification dedupe matches the socket copy and doesn't show it twice.

**Verify:** iPhone app in background (Home), lock the screen, wait 10 s, send it a message from Android. A notification appears within ~2 s, and the Android sender reaches `delivered` without the iPhone being unlocked.

---

## How to verify after the fix

1. **Item 1:**
   - Put the Android app in the background (Home) and, within 3–8 s, send it a message.
   - Expected: an FCM notification arrives, and the sender reaches `delivered` without the Android app being opened.
   - Repeat 5 times.
2. **Item 2:** the curl command with `-H "Origin: https://talkstrysocket.tresting.com"` returns `101`.
3. **Item 3:**
   - Kill the Android app, send it a message, then tap the notification.
   - Expected: the first `socket connected` is not followed by `transport closed by the server`.
4. **Item 4:** the `replyTo` field of a reply `message:new` equals `replyToMessageId`.
5. **Item 5:** `socket.emit('chat:list', {}, ack)` returns in under 1 s for a user with ~40 chats. It measured 22–27 s on 2026-09-25.
6. **Item 6:** turn the receiver's data off, send it a message, and turn data back on. The sender reaches `delivered` within ~3 s of the network returning (client builds from before 2026-09-25 included).
7. **Item 7:** repeat the item 1 and item 6 tests in a **group** chat. `group:message:fetch {groupId, fromSeq, toSeq}` returns the requested range.
8. **Item 8:** see the item 8 "Verify" step (iPhone as receiver).

When all of the above pass, send / delivered / notification work for: app open, background, killed, locked, network drop + return, 1:1 and group, Android and iOS.
