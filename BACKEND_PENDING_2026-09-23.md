# Backend — what is still pending (2026-09-23, re-measured)

Two items from `BACKEND_FIXES_2026-09-23.md` are **done and verified on device**:

- ✅ `callerHideContact` on the incoming-call FCM push — now arrives as `"true"`.
- ✅ Delivered receipts — a message to a receiver whose socket is disconnected now
  reaches `delivered` in under 10 seconds (it used to sit on `sent` indefinitely).

This file is what is **left**. Item 1 is new, found while verifying the two above.

---

## 1. `call:incoming` is emitted twice, and one of the two carries a reduced `from` — **NEW, highest priority**

### What was measured

Four consecutive calls, all identical, captured **after** the push fix shipped. The
client receives `call:incoming` **twice** for one ring, ~550 ms apart, and the two
`from` objects have different shapes:

**Emit A — complete:**
```json
"from": {
  "id": "6a72cf2d26d07447d7a146a0",
  "name": "+914422441441",
  "pushName": "Chetan",
  "userName": "jangid",
  "hideContact": true,
  "mobile": "+914422441441"
}
```

**Emit B — reduced (the fields that decide the displayed name are gone):**
```json
"from": {
  "id": "6a72cf2d26d07447d7a146a0",
  "name": "@jangid",
  "pushName": "Chetan",
  "mobile": null,
  "avatar": "https://…"
}
```
No `userName`. No `hideContact`.

The client's own resolution log for the two, same call, 550 ms apart:

```
after emit A:  in_userName "jangid"   in_hideContact "true"    → resolved "@jangid"   ✅
after emit B:  in_userName null       in_hideContact "false"   → resolved "@jangid"   ⚠️ by luck
```

### Why it matters

An absent `hideContact` is read as **false** — emit B actively tells the client
*"this caller does not hide their details"*, contradicting emit A.

It still displays correctly today only because emit B's `name` happens to be
`"@jangid"`, and the client infers the privacy flag from a name that starts with
`@`. **A caller who has NOT enabled the privacy toggle gives the client no such
hint**, so emit B — the later one — becomes the last word, and the ring falls back
to the saved contact name or the number. That is the same bug as the (now fixed)
push issue, arriving over the socket instead.

Emitting twice also makes the client re-post the OS ring notification. The client
now de-duplicates identical re-posts, but that is a workaround, not a fix: Android
silences a notification that is re-posted repeatedly
(`NotifAttentionHelper: Muting recently noisy`).

### Required change

1. **Emit `call:incoming` once per ring.** If more than one emit is required (a
   pending-call replay, a reconnect catch-up), every emit must be **byte-identical**.
2. **Every emit's `from` must be the complete object** — `userName` and
   `hideContact` included, with the caller's real current values. Use the same
   serializer for all of them.
3. `mobile` should also be consistent: emit A sent `"+914422441441"`, emit B sent
   `null`. For a caller who hides their details, `null` is correct — then emit A
   should not be sending the number either.

### How to verify

One incoming call must produce exactly **one** `[CALL][APP] INCOMING STEP 0` line
in the client log. If more than one is emitted, every one must show the same
`userName` and `hideContact` values.

---

## 2. `callerMobile` formatting on the push

Lower priority, and it may already be moot: after the privacy fix the push now
sends an **empty** `callerMobile` for a caller who hides their details, which is
correct. Please confirm that for a caller who does **not** hide, the push sends
canonical **E.164 with no spaces** (`+914422441441`, not `+91 4422441441`) — the
client matches against the device address book by E.164, and a space breaks it.

---

## 3. Group / conference calls have no server-side conference record

Carried over — **not re-measured**, please confirm on your side.

A group ring reuses one `callId`/`groupId` for the life of the group, and the
backend appears to hold no conference record for it, so the client cannot trust a
negative answer to "is this a conference?". Calls with 3+ participants are not
reliable today.

Please confirm whether a conference/room record is created when a group call rings,
and if not, create one keyed by the ring's `callId` so participants can be
enumerated and re-invited.

---

## 4. iOS VoIP push — confirm it is being sent

Carried over, please confirm. An iPhone with the app **killed or locked** can only
ring through an **APNs VoIP (PushKit)** push:

- topic `com.chat.baatCheet.voip`
- a valid **RFC 4122** UUID as the call uuid (CallKit rejects anything else)
- the correct APNs environment for the build (a development build needs the
  sandbox endpoint)
- sent on **every** ring — do not skip it because the callee's socket looks
  connected; a swipe-killed app's socket can look alive for 30–60 seconds

See `CALL_PUSH_BACKEND_SPEC.md` § PushKit for the full contract.

---

## Being worked on client-side — no backend action

- **Answered Android calls run silent.** Proven on a live connected call: the
  foreground service carrying the call is still the RING service
  (`types=0x00000800` = `SHORT_SERVICE`), and Android refuses microphone access to
  it (`can not have location/camera/microphone access`). The microphone-typed
  ongoing service is never started after the user answers. Native fix in progress.
- Ring notification was posted up to 4× per call (now de-duplicated).
- iOS incoming calls had no audio-recovery retry ladder (the caller side had one).
