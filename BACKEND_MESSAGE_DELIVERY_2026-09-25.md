# Backend: message delivery changes needed (2026-09-25)

**Scope:** 1:1 messages to Android/iOS, socket server `talkstrysocket.tresting.com`.
**Evidence:** measured on two real devices.
- Android (Nothing A063, user `69a5185acf2a2ed928da5ffd`)
- iPhone 14 Pro (user `6a72cf2d26d07447d7a146a0`)

The server event capture comes from the client's socket.io hooks. Every item below was reproduced; nothing is a guess unless it says so.

| # | Item | Priority |
|---|------|----------|
| 1 | Message sent while the receiver is going to background: no push, no delivery, no tick | **High** |
| 2 | WebSocket upgrade is rejected (`400`) for every request that carries an `Origin` header | **High** |
| 3 | First socket session after a push-started cold launch is closed by the server within ~1 s | Medium |
| 4 | `replyTo` carries the Mongo `_id` instead of the message UUID | Low |
| 5 | `chat:list` takes **27 s** to answer | Medium |

The client already ships workarounds for 1, 2 and 4, and they are described under each item. They reduce the damage but cannot replace the server fix.

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
