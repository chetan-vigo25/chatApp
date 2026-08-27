# Call Backend — Verification Prompt

Paste everything below the line into an AI agent running **in the backend repo**
(or hand it to the backend developer). It is an **audit**, not a change request:
the goal is to find out what the server actually does today, with file:line
evidence, before anyone writes code.

The client side has already been audited and hardened (see
[§ Client state](#client-state) at the end). Every remaining call defect we can
identify is now either server-side or a contract mismatch.

Related existing specs in this repo — the auditor should read them, they define
what SHOULD exist:
`docs/CONFERENCE_CALL_SERVER_CHANGES.md`, `docs/ANDROID_CALL_PUSH_BACKEND_SPEC.md`,
`docs/IOS_VOIP_BACKEND_SPEC.md`.

---

# PROMPT — Call signaling backend audit

You are auditing the call signaling backend of a WhatsApp-style chat app. **Make
no code changes.** Read the code, answer every check below with
`PASS` / `FAIL` / `UNKNOWN`, and cite `file:line` for every answer. Where you
answer FAIL, describe the current behaviour — do not fix it yet.

## 0. Architecture you are auditing

The mobile client runs a call over **two independent planes**:

1. **App socket (this backend)** — `socket.io`, events named `call:*`. Owns the
   ring, the busy lock, the conference roster and the call log.
2. **Media server (mediasoup, separate service)** — owns rooms, producers,
   consumers. Has its own ids and its own `incomingCall` / `incomingGroupCall`
   ring.

The two planes use **different ids for the same call**:

| id | shape | minted by | used for |
|---|---|---|---|
| `signalId` (a.k.a. `callId` in every `call:*` event) | `sig_<callerUserId>_<epochMs>` | the caller's client | busy lock, `call:*` events, call log, push payloads |
| engine `callId` / `groupId` | `call_<epochMs>_<n>` / a group key | the media server | mediasoup room join/accept |

**The single most important fact:** a CONFERENCE keeps **one `signalId` for its
entire life** — from the moment it is created until the last participant leaves.
It is not re-minted per invite, per member, or per re-invite. Every "a new call
means a new id" assumption is wrong for a conference, on both sides.

The client is the *only* consumer of this API. Its contract is defined by
`src/calls/services/callSignalService.js` (client repo) — that file is the
authority for event names and payload shapes.

---

## 1. BLOCKING CHECKS — do these three first

### Check A — Does every conference ring carry `isConference` and `ts`?

**Why it matters.** The client uses these two fields to decide whether a ring is
real. Without them a *live* conference invite is classified as a **stale, already
finished call and silently swallowed** — the phone never rings, or it rings and
Accept does nothing.

Concretely, with no `isConference` on the payload the client:
- decodes the age of the call from the epoch inside `sig_<hostId>_<epochMs>` —
  which for a conference is when the **conference started**, so a member invited
  ten minutes in looks ten minutes stale and the ring is dropped;
- builds the call as a **1:1** instead of a group, which then makes every
  1:1 terminal rule apply (see Check C);
- loses the re-invite exception that lets a member who left be re-invited.

`ts` (server send time, epoch ms) is what distinguishes a genuine re-invite from
a stale re-delivery of an old ring for the same immortal id.

**Verify.** For EVERY path that can ring a user, confirm the payload contains
`isConference: true`, a fresh `ts`, and a `members` list where available:

1. socket `call:incoming` — the live ring
2. the `call:pending:pull` ack — the recovery path a reconnecting device uses
3. Android FCM data push (all values are strings there — `"true"` is fine)
4. iOS APNs **VoIP** push (real JSON types; must also carry a valid RFC4122
   `uuid`)
5. the ring emitted by a **mid-call invite** (`call:conference:invite`)
6. the ring emitted by a **re-invite of someone who already left** ← most often
   missed

```
grep -rn "call:incoming" --include=*.js --include=*.ts
grep -rn "isConference" --include=*.js --include=*.ts
grep -rn "pending:pull\|pendingPull" --include=*.js --include=*.ts
```

**PASS** = all six paths set `isConference` and a fresh `ts`.
**FAIL** = any path omits either. State which.

---

### Check B — What does `call:conference:state` mean by `active`?

**Why it matters.** On every socket (re)connect during a conference the client
asks `call:conference:state` and, if the ack says `active: false`, **it ends the
call**. A reconnect happens exactly when a push-woken device comes back — i.e.
while an invite may still be settling.

The client has been hardened to only honour `active: false` once it has already
answered, but the semantics still must be pinned down.

**Verify.** Find the `call:conference:state` handler and answer precisely:

- What is `active` computed from — does the **conference exist and is live**, or
  does the **requesting user belong to it**?
- What does it return for a user who has been **invited but has not joined yet**?
- What does it return for a user who **left and was re-invited**, before they
  re-accept?
- What does it return for a conference that is live but whose roster this user is
  not yet written into (the invite is mid-flight)?
- What is the exact ack shape? The client expects `{ active: boolean, roster: [...] }`
  and treats a missing/late ack as "no information" (safe).

**PASS** = `active` means "the conference is live", is independent of the
caller's membership, and is never `false` for a live conference.
**FAIL** = `active` is false for any live conference, for any requester.

---

### Check C — Can one member's `call:end` / `call:reject` kill the whole conference?

**Why it matters.** The client emits the 1:1 vocabulary on the **shared
conference `callId`**, in addition to the conference-specific events:

| client action in a conference | events emitted (both, always) |
|---|---|
| declines an invite | `call:reject` **and** `call:conference:reject` |
| leaves an answered call | `call:end` **and** `call:conference:leave` |
| ring times out un-answered | `call:end` only |
| host ends for everyone | `call:end`, `call:conference:end` **and** `call:conference:leave` |

So the server receives `call:end` with a conference `callId` from members who are
merely **leaving** — and from members who simply **never answered**.

**Verify.** In the `call:end` and `call:reject` handlers:

- Do they check whether `callId` belongs to a **conference** before acting?
- For a conference, does `call:end` from a non-host **terminate the call** (and
  broadcast `call:ended` to everyone), or only remove that participant?
- Does `call:reject` from one invitee cancel the ring for the **other** invitees?
- Which users does the resulting `call:ended` / `call:cancelled` /
  `call:rejected` broadcast reach — the whole conference, or only the affected
  parties?
- Is `call:conference:end` (host-only, end-for-everyone) properly
  **host-gated**, and does it return `FORBIDDEN` for a non-host?

```
grep -rn "'call:end'\|\"call:end\"" --include=*.js --include=*.ts
grep -rn "'call:reject'\|\"call:reject\"" --include=*.js --include=*.ts
grep -rn "call:ended\|call:cancelled\|call:rejected" --include=*.js --include=*.ts
```

**PASS** = in a conference, `call:end`/`call:reject` from a non-host affect only
that user; the conference ends only on `call:conference:end` by the host, or when
the roster empties.
**FAIL** = anything that broadcasts a terminal event to the whole conference
because one member left, declined, or missed the ring.

---

## 2. Required fields on server → client events

The client's group/conference carve-outs are keyed on these fields. A missing
field does not degrade gracefully — it makes the client take the **1:1** branch,
which ends the call.

| event | required fields | what the client does without them |
|---|---|---|
| `call:incoming` | `callId`, `from{id,name,avatar}`, `media`, `ts`, `isGroup`/`isConference`, `members[]`, `groupId`, `groupName`, `operationId` (conference invite), `uuid` (when a VoIP push was sent for the same call) | builds a 1:1 on an immortal id; wrong ring UI; earpiece instead of speaker; ring can be suppressed entirely |
| `call:ended` | `callId`, **`by`** (who ended) | cannot tell "a member left" from "the call ended" → ends the call for everyone |
| `call:rejected` | `callId`, **`by`** | same — one decline ends the whole call |
| `call:cancelled` | `callId`, **`by`** | same |
| `call:timeout` | `callId` | — |
| `call:cancelled-elsewhere` | `callId`, `reason` (`answered_elsewhere` / `declined_elsewhere` / `cancelled`), **`winnerDeviceId`** | the winning device cannot recognise its own echo and dismisses the call it just answered |
| `call:unavailable` | `callId`, `message` (human readable) | generic error text |
| `call:conference:roster` | full authoritative participant list | grid goes stale |
| `call:conference:removed` | `callId` | a kicked user's client cannot tear down |

**Verify** each event's emit site and list which fields are actually sent.

---

## 3. Ack shapes the client depends on

The client blocks or retries on these acks. Confirm each handler acks, and with
what shape. A **missing ack is treated as optimistic success** by the client — so
a silently-unhandled event looks like it worked and fails later.

| client emit | expected ack | consequence of a wrong ack |
|---|---|---|
| `call:ring` | `{ ok, busy, busyUserIds[], ringingUserIds[], unavailable?, unavailableMessage?, glare? }` | caller rings into the void, or a live callee is reported busy |
| `call:accept` | `{ ok, callId, ended?, answeredElsewhere? }` — `callId: null` or `ok:false` means **the server could not attribute the accept** | the client retries 3× then gives up; caller keeps hearing RINGING while the callee sits in a connected-looking call |
| `call:conference:accept` | `{ ok }` — must settle **this specific invite** (`operationId`) and add the member to the roster, even when no busy record exists (a re-invited member has none) | a re-invited member is never added to the roster |
| `call:conference:state` | `{ active, roster }` | see Check B |
| `call:pending:pull` | `{ ok, calls: [ …same shape as `call:incoming`… ] }` | a push-woken device that missed the live ring never recovers it |
| `call:conference:remove` / `:end` | `{ ok }` or `{ error: 'FORBIDDEN' }` for a non-host | host-only actions are not enforced |

**Also verify idempotency.** The client legitimately sends duplicates (retries, a
re-connected socket, two planes racing). Confirm each of `call:accept`,
`call:reject`, `call:end`, `call:conference:accept`, `call:conference:leave` is
safe to receive **twice for the same call from the same user** and that the
second one does not emit a terminal broadcast.

---

## 4. Push delivery

Observed in a real device log during a 1:1 call:

```
POST /api/v2/user/call/notify → { data: { devices: 0, duplicate: true, sent: 0 } }
```

`devices: 0` means the server held **no push tokens for the callee**, so no wake
push went out at all. On a backgrounded or killed device that is the difference
between ringing and silence.

**Verify:**

- Why was `devices: 0` — no token registered, a token bound to a different
  device/session row, or a stale token pruned?
- What does `duplicate: true` suppress, and can it suppress the **only** push
  (e.g. the server-side `call:ring` push failed, then `/call/notify` is
  de-duplicated against that failed attempt)?
- Are iOS **VoIP** (PushKit, topic `…​.voip`) and Android FCM data pushes chosen
  correctly per platform, and does the VoIP payload carry a valid RFC4122 `uuid`?
- Does a **conference re-invite** send a push at all? (A member who left is
  frequently backgrounded by then.)
- Are pushes sent with high priority / `content-available`, and is the FCM
  payload a **data** message (not `notification`)?

---

## 5. Reproducible tests — run these against the server and read its logs

For each, report what the server did, which events it emitted, and to whom.

1. **Back-to-back 1:1.** A calls B, connect, end. Within 5–10 s A calls B again;
   B answers. → Confirm the second call gets a **new** `signalId`, that no
   terminal event from call #1 is delivered after call #2 starts, and that
   `call:accept` for call #2 is attributed (ack carries a non-null `callId`).
2. **Conference invite.** Host creates a conference, invites C. → Confirm C's
   ring carries `isConference`, a fresh `ts`, `members[]` and an `operationId`.
3. **Leave and re-invite.** C joins, leaves, host re-invites C within 60 s. →
   Confirm a **new push and a new ring with a new `ts`** are sent on the **same**
   `signalId`, and that C's `call:conference:accept` re-adds them to the roster.
4. **One member leaves a 3-party conference.** → Confirm the other two receive a
   participant-left/roster update and **no** `call:ended`.
5. **One invitee never answers.** → Confirm their ring timeout does **not**
   terminate the conference for those already connected.
6. **Reconnect mid-conference.** Kill and restore the socket of a joined member.
   → Confirm `call:conference:state` returns `active: true` plus the roster.
7. **Two devices, same account.** Answer on device 1. → Confirm device 2 receives
   `call:cancelled-elsewhere` with `reason: 'answered_elsewhere'` **and**
   `winnerDeviceId` set to device 1.

---

## 6. Report back in this format

| # | Check | Verdict | Evidence (file:line) | Current behaviour if FAIL |
|---|---|---|---|---|
| A | conference ring carries `isConference` + `ts` (6 paths) | | | |
| B | `call:conference:state.active` semantics | | | |
| C | `call:end`/`call:reject` scoping in a conference | | | |
| 2 | `by` on ended/rejected/cancelled | | | |
| 2 | `winnerDeviceId` on cancelled-elsewhere | | | |
| 3 | accept ack attribution | | | |
| 3 | idempotency of accept/reject/end | | | |
| 4 | push tokens / `devices: 0` | | | |
| 4 | re-invite sends a push | | | |
| 5 | tests 1–7 | | | |

Then, and only then, propose the changes — smallest diff first, each one tied to
the check it fixes.

---

<a name="client-state"></a>
## Client state (context for the auditor — no action needed)

The client has been audited and hardened. It now:

- id-scopes every OS/notification call action, so a stale Accept/Decline/End from
  a finished call cannot land on the next one;
- swallows the echo of CallKit ends it filed itself;
- never rejects a call that has already been accepted;
- never declines its own group/conference re-ring;
- merges (instead of dropping) a duplicate group/conference ring, so the media
  server's id is not lost;
- keeps a group call alive through `call:cancelled` / `call:cancelled-elsewhere`
  once it has been answered;
- only honours `call:conference:state → active:false` after it has joined;
- and no longer leaves a mediasoup session running after the UI has ended the
  call.

Because of this the client now **fails safe** on most contract gaps — but failing
safe means the ring silently does nothing rather than doing the right thing. The
checks above are what make it work correctly rather than merely not crash.
