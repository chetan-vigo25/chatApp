# Call reliability — backend contract (server authority + reconcile)

The client now has two safety nets (ring-ownership guard + id-tolerant event
matching). They reduce ghost ringing and one-sided ending, but the **durable**
fix — eliminating stuck "Calling…"/ghost rings after a network blip, background,
or app kill — requires the **server to be authoritative** and the client to
**reconcile on (re)connect and foreground**. That part lives in the backend repo.

## Root cause this fixes

Terminal signals (`call:end`/`call:reject`/`call:cancel`) are delivered once over
the socket. If the ender's socket is briefly down, OR the peer is mid-reconnect /
backgrounded at that instant, the peer **never receives `call:ended`** and stays
ringing/“Calling…” until the local 35s ring timeout (or forever if the call was
already ACTIVE). There is no source of truth to correct it.

## 1. Authoritative call record (server-side)

Keep one record per call (Redis/DB), updated on every transition:

```jsonc
{
  "callId": "<signaling id>",       // the app socket id used by call:* events
  "status": "ringing | active | ended",
  "callerId": "<user _id>",
  "calleeIds": ["<user _id>", ...],
  "answeredBy": "<user _id|null>",
  "endedBy": "<user _id|null>",
  "endReason": "completed|rejected|cancelled|missed|failed|null",
  "startedAt": 0, "answeredAt": 0, "endedAt": 0,
  "version": 1                       // increment on every change
}
```

## 2. Relay terminal events to ALL participants, keyed on every id

When any participant ends/rejects/cancels, the server MUST:
- set the record to `ended` (idempotent — first writer wins, ignore later writers),
- emit `call:ended` to **every** participant (caller AND all callees), including
  the sender (so the sender's UI also closes deterministically),
- include BOTH ids the clients might hold:
  ```jsonc
  { "callId": "<signalId>", "endedBy": "<user _id>", "endReason": "completed", "version": 3 }
  ```

> The client's `matchesCurrent` now accepts an event matching either its `signalId`
> or its WebRTC `callId`, so include whichever id(s) you have.

## 3. `call:sync` — the reconcile endpoint (THE key addition)

Add a request/ack the client calls to learn the authoritative state:

```
client → call:sync   { callId }
server → (ack)        { status, endedBy, endReason, answeredBy, version }
```

Behaviour:
- If no such call / already `ended` → return `{ status: "ended", ... }`.
- If `active`/`ringing` → return the live status so a reconnecting client can
  resume or keep ringing correctly.

## 4. When the client calls `call:sync` (client work, ready to wire)

The client should emit `call:sync` for the live call on:
- every socket **(re)connect** (`connect` event), and
- every **foreground** (`AppState` → active) while a call is in progress.

On a `{ status: "ended" }` response → run the existing `finalizeEnd(reason)`; this
instantly clears a stuck "Calling…"/ghost ring that resulted from a missed event.

> Ask the app owner to wire this once the backend supports `call:sync` — it's ~15
> lines in `CallProvider` (a `call:sync` emit with an ack that calls `finalizeEnd`
> when `status === "ended"`).

## 5. Acks + retry for terminal signals (optional client hardening)

Make `call:end`/`reject`/`cancel` request an ack; if none in ~2s, re-emit; on
reconnect, re-send any unacked terminal intent (persist it so it survives a quick
app kill). This narrows the window further, but **#3 (reconcile) is what makes it
self-healing** — even a totally lost terminal event is corrected on the next
connect/foreground.

## 6. Missed-call correctness

When the server sets `ended` with `endReason: "missed"` (ring timeout with no
answer) or `cancelled` (caller hung up pre-answer), relay `call:ended` with that
reason so both sides log the same outcome (prevents "rejected vs missed" mismatch).

---

## Summary of the layered fix

| Layer | Where | Fixes | Status |
|---|---|---|---|
| Ring-ownership guard | client (`CallProvider`) | ringing after answer/end | ✅ done |
| id-tolerant `matchesCurrent` | client (`CallProvider`) | dropped terminal events → one-sided ending | ✅ done |
| Authoritative record + relay-to-all | **backend** | both sides end together; consistent reason | ⬜ backend |
| `call:sync` reconcile on reconnect/foreground | **backend** + ~15 lines client | stuck "Calling…", ghost ring after blip/background/kill | ⬜ backend then client |
| Acks + retry on terminal signals | client | narrows the lost-event window | ⬜ optional |
