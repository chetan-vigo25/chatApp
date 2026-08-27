# Server-Side Prompt — "Incoming-Call Banner Must Always Come Back"

> **How to use this file:** paste the whole thing to Claude (or give it to the
> backend developer) in the **backend repository**. It is written as a standalone
> brief: it states the product requirement, the exact client architecture that is
> already shipped, the wire contract the client depends on, and the concrete
> server work + acceptance tests. Nothing in here asks for client changes — the
> client side is done.

---

## 0. One-paragraph summary for the backend

Our React Native app shows a WhatsApp-style **in-app incoming-call banner** at the
top of every screen while a call is ringing. The user may swipe it away, background
the app, or force-kill the app. **In every one of those cases, if the call is still
ringing, the banner must be on screen again the moment the app is opened.** The app
already handles this while its process is alive (in-memory state). The one case the
app *cannot* solve alone is **process death / socket gap**: after a force-kill or a
network drop, the app has no idea a call is ringing until the **server tells it
again**. That recovery path is `call:pending:pull` + a re-emitted `call:incoming`,
and it is what this document asks you to guarantee, plus three defects we have
already observed in production logs.

---

## 1. Product requirement (verbatim, from the product owner)

> For all call types — **Voice Call, Video Call, and Conference Call** — the active
> call state must persist even if the user dismisses the incoming-call banner.
> The banner must be displayed **every time the app is opened**, no matter how many
> times the user opens and closes the app, as long as the call is still ringing.
> It must stop appearing the moment the call ends, is rejected, is cancelled, or
> times out.

---

## 2. Client architecture (already implemented — for your context only)

### 2.1 Two independent planes

| Plane | Transport | Owns |
|---|---|---|
| **Signaling** | app socket.io (`call:*` events) + REST | who is ringing whom, ring lifecycle, conference roster |
| **Media** | mediasoup server (`mediacall.vigorousit.com`) | audio/video transport, its own `callId` / `groupId` |

The two use **different ids**. The signaling id (`callId` on `call:*` events, e.g.
`sig_<userId>_<epochMs>`) is the one this document is about. The media server's
`call_<ts>_<n>` id is irrelevant here.

### 2.2 Ring presentation surfaces on the client

1. **OS surface** — Android CallStyle notification (`setOngoing(true)`, undismissable)
   / iOS CallKit. Raised from FCM data push or APNs VoIP push when the app is
   backgrounded or killed.
2. **In-app banner** — a 54dp strip pinned under the status bar, above every
   screen. This is the surface this document is about.
3. **Full-screen call UI** — opened by tapping either of the above.

### 2.3 Client state machine, relevant flags

```
status:            idle | incoming | outgoing | active | ended
accepted:          bool
incomingExpanded:  bool   // false → banner, true → full-screen ring
bannerDismissed:   bool   // user swiped the banner away
notificationOnly:  bool   // the ring is currently presented by the OS
```

The banner renders when:
`status === 'incoming' && !accepted && !incomingExpanded && !bannerDismissed`

`bannerDismissed` is **deliberately temporary**. The client clears it on:
- any observed `AppState` transition (event **and** a 500ms poll of
  `AppState.currentState`, so a dropped/coalesced event cannot lose the banner);
- **any re-assertion of the ring by the server** — i.e. a repeated `call:incoming`
  for a call we are already ringing clears `bannerDismissed` and puts the banner
  back. See `src/calls/CallProvider.jsx` → `onSignalIncoming`.

### 2.4 The recovery path the client relies on from you

```
socket (re)connect  ──►  client emits  call:pending:pull   (ack callback, 4s timeout)
                          │                  ├─ retried up to 3× with backoff
                          │                  │   (we observed ok:false "not authenticated"
                          │                  │    on the very first connect)
                          ▼
                    server replies  { ok: true, calls: [ <ring payload>, ... ] }
                    AND/OR re-emits call:incoming  { ..., resumed: true }
                          │
                          ▼
                    client re-renders the ring → banner is back on screen
```

Client code: `src/calls/services/callSignalService.js` → `pullPendingCalls()`,
`src/calls/CallProvider.jsx` → `pullStillRingingInvites()`.

**Critical client rule you should know about:** the client only *sweeps* (kills) a
locally-known ring on an **authoritative empty** answer (`ok: true, calls: []`).
`ok: false` or a timeout is treated as "no information" and the ring is left alone.
So a broken/500ing pull endpoint will not kill live calls — but it *will* break the
banner-comes-back requirement.

---

## 3. What the server MUST guarantee (the actual work)

### R1 — Server-side pending-ring registry (blocking)

Every outgoing ring must be persisted server-side, keyed by callee, for the
duration of the ring window.

```
key:    pendingCall:<calleeUserId>:<callId>
value:  the FULL call:incoming payload (see §4)
TTL:    ringDurationSec (currently 40s, served by GET /api/v2/user/call/token)
```

- **Created** when the ring is dispatched (`call:ring` handler), for **each** callee
  in `toUserIds` — including every conference invitee.
- **Deleted** on **every** terminal transition for that callee:
  `call:accept`, `call:reject`, `call:end`, `call:cancel`, caller disconnect,
  ring-timeout expiry, conference "member removed".
- Must survive the callee's socket disconnecting and reconnecting.
- Must be per-callee: if A rings B and C, and B rejects, C's record stays.

> Without this, a force-killed app has nothing to recover from and the requirement
> is unimplementable. **Confirm whether this registry exists today.**

### R2 — `call:pending:pull` must be authoritative and idempotent (blocking)

```
client → server:  'call:pending:pull'   payload {}   (ack callback)
server  → ack:    { ok: true, calls: [ <full call:incoming payload>, ... ] }
```

Requirements:

1. **Scope** = every ring currently pending *for the authenticated user as callee*.
   Never include calls where they are the caller. Never include ended calls.
2. **Payload parity** — each entry must be a **complete** `call:incoming` payload
   (§4), not a trimmed summary. The client renders the banner directly from it;
   a missing `media` shows the wrong icon, a missing `isConference` renders a
   conference as a 1:1 call, a missing `from.name`/`from.avatar` renders "Unknown".
3. **Idempotent** — pulling does not consume, mutate, or extend the ring. The user
   may open and close the app 20 times in one 40s ring; every pull returns the same
   record until a terminal event removes it.
4. **Also re-emit `call:incoming`** to the requesting socket for each pending call,
   with `resumed: true`. (Our logs show this already happens — keep it. It is the
   path that clears a swiped-away banner, per §2.3.)
5. **Ack reliability** — must ack within 4s, always. `ok: false` is treated as "no
   information" by the client, so a session-not-yet-bound reply is survivable but
   the banner will not come back on that attempt.
   **Known defect:** the first `call:pending:pull` on a fresh socket frequently
   acks `{ ok: false, error: 'not authenticated' }` even though the same socket
   receives user-targeted `call:incoming` events moments later. Bind the socket's
   auth/session **before** registering the `call:*` handlers so this cannot happen.
6. **Never** ack `{ ok: true, calls: [] }` unless you have genuinely checked and
   there is nothing pending — a false empty is the one answer that can kill a live
   call on the client.

### R3 — Auto-push pending rings on socket connect (recommended)

Do not wait for the pull. On successful socket authentication, if the user has any
pending ring, emit `call:incoming` (with `resumed: true`) immediately. This removes
a full round-trip from the "app opened → banner visible" path and is the single
biggest perceived-latency win for this feature.

### R4 — Push tokens: `/call/notify` returns `devices: 0` (blocking, observed)

Every single call in our device logs:

```
POST /api/v2/user/call/notify
→ { statusCode: 200, message: "Call notification dispatched",
    data: { devices: 0, duplicate: true, sent: 0 } }
```

`devices: 0, sent: 0` means **the server has no push token registered for the
callee**, so no FCM/VoIP push is ever delivered. Consequences:

- App force-killed → the device never rings at all.
- The app never gets woken, so it never connects its socket, so it never pulls, so
  the banner cannot come back. **This alone defeats the requirement.**

Please verify and report:
- Where are device push tokens stored, and is the token-registration endpoint
  actually being hit and persisted for these users?
- What does `duplicate: true` mean here — is a dedupe key suppressing the send?
- Confirm Android FCM data pushes use channel id `chat_messages_v2` for messages
  and the call channel for calls, and that call pushes are `data`-only (never
  `notification`), high priority.
- Confirm iOS VoIP pushes go to the `.voip` APNs topic with a valid RFC4122 uuid
  in `uuid`.

### R5 — Confirm `call:incoming` is not fanned out to the caller (verify)

Our device logs interleave two handsets on one Metro session, so we cannot prove
this from the client side — please check it on yours. Requirement:

- `call:incoming` must be delivered to the **callees only**, never to the socket /
  user that emitted `call:ring`.
- `call:pending:pull` must never list a call where the requesting user is the
  **caller** — only rings where they are a callee.

The client tolerates a self-echo (it de-dupes on `callId`), but a caller who
receives their own ring can transiently be pushed into an `incoming` state,
because the outgoing state has not committed yet when the echo lands. Confirm the
fan-out excludes the caller and report the code path.

### R6 — Terminal events must clear the registry AND be scoped correctly

- `call:end` / `call:reject` / `call:cancel` must remove the pending record for the
  affected callee(s) **only**, and must be emitted to the affected parties only.
- **Conference-specific:** a conference reuses **one** `callId` for its entire life.
  A single member leaving must **not** clear other members' pending records, and
  must **not** emit a call-wide `call:ended`. Use a per-participant event
  (`call:conference:participant:left`) instead.
- A ring that times out server-side must remove the record and emit
  `call:ring:timeout` / `call:cancelled` so the client stops showing the banner.
  **The banner must stop coming back the instant the call is over — a stale
  pending record is as bad as a missing one.**

### R7 — Ring payload completeness on **every** path (blocking)

There are multiple code paths that produce a ring (initial `call:ring`, conference
invite, conference re-invite, redial, `pending:pull` replay, push payload). **All of
them** must emit the identical, complete payload of §4. We have already been bitten
by conference re-invites arriving without `isConference` and without `ts`.

---

## 4. Wire contract — `call:incoming` payload

Every field below must be present on **every** ring path (initial, resumed,
re-invite, push).

| Field | Type | Required | Notes |
|---|---|---|---|
| `callId` | string | ✅ | signaling id. Stable for a conference's entire life. |
| `from.id` | string | ✅ | caller user id |
| `from.name` | string | ✅ | banner title |
| `from.avatar` | string\|null | ✅ | absolute URL |
| `media` | `"audio"` \| `"video"` | ✅ | banner icon + subtitle |
| `isGroup` | bool | ✅ | |
| `isConference` | bool | ✅ | **must be `true` on every conference path**, incl. re-invites |
| `groupId` | string\|null | ✅ | |
| `groupName` | string\|null | ✅ | banner title for group/conference |
| `members` | string[] | ✅ | user ids invited |
| `conferenceHost` | string\|null | ✅ | |
| `ts` | number (ms) | ✅ | **server** emit time. The client uses it to tell a genuine conference re-invite from a stale re-delivery of a ring it just ended. A missing `ts` makes a re-invited member's phone not ring at all. |
| `uuid` | string (RFC4122) | ✅ | must be the **same** uuid as the iOS VoIP push for this call, or CallKit holds two calls for one call and answering one kills the other |
| `operationId` | string\|null | ➖ | |
| `resumed` | bool | ➖ | `true` on a `pending:pull` replay / connect auto-push |

Ack shape for `call:ring`:

```json
{ "ok": true, "ringingUserIds": ["..."], "busy": false, "busyUserIds": [] }
```

---

## 5. Acceptance tests — run these and paste the results

For each: **P** = the ringing device, **C** = the caller.

| # | Scenario | Expected |
|---|---|---|
| T1 | C calls P (voice). P swipes the in-app banner away, presses Home, reopens the app. | Banner is back on screen within ~1s. Call still ringing. |
| T2 | Same as T1 but repeated **5 times in one ring**. | Banner returns all 5 times. Nothing is consumed. |
| T3 | Same as T1 with a **video** call. | Banner returns, shows the video-call subtitle. |
| T4 | Same as T1 with a **conference** invite. | Banner returns, titled with the group/conference name, `isConference: true`. |
| T5 | C calls P. P **force-kills** the app, then relaunches it from the launcher (not from the notification). | Push woke the device (`devices > 0`), socket connects, `call:pending:pull` returns the ring, banner shows. |
| T6 | C calls P. P puts the phone in airplane mode for 10s, then back on. | On reconnect the ring is re-delivered and the banner shows (if still inside the 40s window). |
| T7 | C calls P, then C **cancels**. P opens the app. | **No banner.** Pending record was deleted. |
| T8 | C calls P. P **rejects**. P reopens the app 3×. | **No banner** any of the 3 times. |
| T9 | C calls P. Nobody answers; ring times out (40s). P opens the app. | **No banner**; a missed-call entry instead. |
| T10 | C rings P **and** Q (conference). Q rejects. P opens the app. | P still sees the banner. Q sees nothing. |
| T11 | Conference with P joined; another member leaves. | P's call is untouched — no `call:ended` on P, no pending record change. |
| T12 | C places a call. | C's own device receives **no** `call:incoming` (R5). |
| T13 | Any call. | `POST /call/notify` returns `devices >= 1` and `sent >= 1` (R4). |

---

## 6. Report back in this format

```
R1  pending-ring registry ......... PASS / FAIL / NOT IMPLEMENTED
    storage: ______  key: ______  TTL: ______
    cleared on: accept[ ] reject[ ] end[ ] cancel[ ] timeout[ ] caller-disconnect[ ]
R2  call:pending:pull ............. PASS / FAIL
    scope correct[ ]  full payload[ ]  idempotent[ ]  re-emits call:incoming[ ]
    "not authenticated" on first connect: FIXED / STILL HAPPENS
R3  auto-push on connect .......... IMPLEMENTED / NOT IMPLEMENTED
R4  /call/notify devices:0 ........ ROOT CAUSE: ______   FIXED: yes/no
R5  caller excluded from fan-out .. CONFIRMED / FIXED / STILL ECHOES
R6  terminal-event scoping ........ PASS / FAIL   (conference per-member: ___)
R7  payload parity on all paths ... PASS / FAIL   (paths audited: ______)

T1..T13: __ / 13 passing.  Failures + logs below.
```

---

## 7. Related documents already shared

- `docs/CALL_BACKEND_AUDIT_PROMPT.md` — the broader call-correctness audit
  (conference terminal-event scoping, `call:conference:state.active` semantics).
- `docs/CONFERENCE_CALL_SERVER_CHANGES.md` — conference signalling contract.
- `docs/ANDROID_CALL_PUSH_BACKEND_SPEC.md` — FCM data-push contract.
- `docs/IOS_VOIP_BACKEND_SPEC.md` — APNs VoIP/PushKit contract.

**R4 (push tokens) is the highest-priority item in this document.** Without a
delivered push, a killed app never learns a call is ringing, and no amount of
client work can make the banner appear.
