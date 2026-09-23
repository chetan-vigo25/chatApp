# Backend fixes — calls & message ticks (measured 2026-09-23)

> **Status update, same day, re-measured on device:**
> §1 (`callerHideContact` on the push) and §3 (delivered receipts) are **FIXED and
> verified live** — see the ✅ notes on each. §6 below is a **new** issue found
> while verifying them.

Everything below was captured on real devices (Android 15 + iPhone 14 Pro, both on
**staging**: `talkstrybackend.tresting.com` / `talkstrysocket.tresting.com`) by
tracing the app's own logs during live calls and messages. Each item states what
was observed, why it breaks the app, and the exact change required.

Related existing specs: `CALL_PUSH_BACKEND_SPEC.md`, `MESSAGE_PUSH_BACKEND_SPEC.md`,
`CALL_RELIABILITY_BACKEND_SPEC.md`.

---

## 1. `callerHideContact` is EMPTY on the incoming-call FCM push — ✅ **FIXED, verified**

> **Verified fixed on device.** The push now arrives as
> `in_hideContact: "true"`, `in_callerName: "@jangid"`, and the ring resolves to
> `@jangid` — matching the in-app UI. No further action.

### What was measured

One single incoming call, resolved by the app from its two sources. Both lines are
verbatim from the app's `[CALL][notif] posting call notification` trace:

```
src "notificationOnly" (socket):
    callerName "@jangid"        callerUserName "jangid"   callerHideContact "true"   callerMobile "+914422441441"

src "fcm-push":
    callerName "4422localtest"  callerUserName "jangid"   callerHideContact ""       callerMobile "+91 4422441441"
    callerPushName "Chetan"
```

The push carries `callerUserName` and `callerPushName` correctly. Only
**`callerHideContact` arrives as an empty string.**

### Why it breaks the app

FCM delivers every data value as a **string**, so the client compares it as text:

```js
const callerHidesContact = String(data?.callerHideContact ?? '') === 'true';
```

An empty string is not `"true"`, so the push path concludes *"this caller does not
hide their details"* and the name resolver falls through to the saved contact name
or the phone number instead of the peer's `@handle`.

Result, reported by the user with screenshots: the **lock-screen / home-screen
incoming-call banner says "4422localtest"**, and the moment the app is opened the
same call says **"@jangid"**. When the app is killed the push is the *only* source,
so the banner is exactly the surface that gets it wrong.

### Required change

On the incoming-call push (and the missed/cancelled push), always send:

| Field | Type | Value |
|---|---|---|
| `callerHideContact` | string | `"true"` or `"false"` — **never empty, never omitted** |
| `callerUserName` | string | the caller's handle **without** the `@` (already correct) |
| `callerPushName` | string | the caller's own profile name (already correct) |
| `callerMobile` | string | E.164, see §2 |

The value must be the caller's **current** privacy flag, i.e. the same value the
socket `call:incoming` payload carries for that user.

### How to verify

Place a call to an Android device, then read the app log line
`[CALL][notif] posting call notification`. The `src: "fcm-push"` entry must show
`in_hideContact: "true"` (or `"false"`) — not `""` — and its `resolved` name must
equal the `src: "notificationOnly"` entry's `resolved` name.

---

## 2. `callerMobile` is formatted differently on the push

### What was measured

Same call, same caller:

```
socket : "+914422441441"
push   : "+91 4422441441"     ← space after the country code
```

### Why it matters

The client matches a caller against the device address book by E.164 and by the
last 10 digits. A space breaks the E.164 comparison, so the saved-contact lookup
can miss and the ring falls back to a less specific label.

### Required change

Send the same canonical **E.164 with no spaces or separators** on the push that the
socket payload already sends.

---

## 3. Delivered receipts are never generated server-side — ✅ **FIXED, verified**

> **Verified fixed on device.** With the receiver's socket disconnected, the
> sender's message reached `delivered` in **under 10 seconds** and stayed there
> (previously still `sent` after 70s). No further action.

### What was measured

Same chat, same sender, two runs:

| Receiver's app | Sender's message status |
|---|---|
| **Open** (socket connected, chat not even focused) | reaches `delivered` within a few seconds ✅ |
| **Closed** (socket disconnected) | still `sent` after **70 seconds**, then jumps straight to `read` when the receiver finally opens the chat ❌ |

### Why it breaks the app

The only thing that ever emits `message:delivered` is the **receiver's running
app** (`emitDeliveryReceipt` in the client's realtime layer). A killed app cannot
emit it, and the client cannot be made to — iOS in particular cannot run code for a
force-quit app. So the sender sits on one tick until the recipient opens the app.

WhatsApp's second tick comes from the server the moment the message is accepted for
the recipient's device, which is why theirs appears while the recipient's app is
closed.

### Required change

The server must mark a message **delivered** and emit `message:delivered` to the
sender when it has handed the message to the recipient — i.e. at the earliest of:

1. the message being written to the recipient's queue / stored for an offline
   recipient, **or**
2. the push (FCM / APNs) being accepted by the push provider.

Payload: the same shape the client already handles —
`{ messageId, chatId, userId (recipient), deliveredAt }`.

Do **not** ask the client to solve this by optimistically promoting to `delivered`
on send: that was tried before and produced a fake double tick for messages the
receiver never got.

### How to verify

Close the receiver's app completely. Send a message. The sender must show two ticks
within a few seconds, without the receiver opening anything.

---

## 4. Group / conference calls have no server-side conference record

Carried over from earlier work and **not re-measured on 2026-09-23** — please
confirm on your side before acting.

A group ring reuses one `callId`/`groupId` for the life of the group, and the
backend appears to hold **no conference record** for it, so the client cannot trust
a negative answer to "is this a conference?". Calls with 3+ participants are not
reliable today.

Please confirm whether a conference/room record is created when a group call rings,
and if not, create one keyed by the ring's `callId` so participants can be
enumerated and re-invited.

---

## 5. iOS VoIP push — confirm it is actually being sent

Also carried over, please confirm. An iPhone with the app **killed or locked** can
only ring through an **APNs VoIP (PushKit)** push:

- topic `com.chat.baatCheet.voip`
- a valid **RFC 4122** UUID as the call uuid (CallKit rejects anything else)
- the correct APNs environment for the build (a development build needs the
  sandbox endpoint)
- sent on **every** ring — do not skip it because the callee's socket looks
  connected; a swipe-killed app's socket can look alive for 30–60 seconds

See `CALL_PUSH_BACKEND_SPEC.md` § PushKit for the full contract.

---

## 6. `call:incoming` is emitted TWICE per call, and the second one loses the caller's privacy flag — **NEW**

### What was measured

Four consecutive calls, all identical. The app receives `call:incoming` **twice**
for one call, ~550ms apart, and the two payloads disagree:

```
1st emit:  from.userName "jangid"   hideContact true     → app resolves "@jangid"
2nd emit:  from.userName null       hideContact false    → app resolves "@jangid" only by
                                                            inferring the handle from
                                                            from.name === "@jangid"
```

The second emit's `from` carries `name`, `pushName` and `avatar` but **drops
`userName` and sets `hideContact: false`**.

### Why it matters

Today it still resolves correctly, but only because the app can infer the privacy
flag from a name that happens to start with `@`. For a caller who does **not** hide
their details there is no such hint, so the second (wrong) emit is simply the last
word — the same class of bug as §1, just moved one layer in. It also makes the
client re-post the ring notification a second time (the client now de-duplicates
identical re-posts, but that is a workaround, not a fix).

### Required change

1. Emit `call:incoming` **once** per ring, or make every emit idempotent and
   identical.
2. Whatever is emitted must carry the **same** `from` object every time —
   `userName` and `hideContact` included, with the caller's real current values.

### How to verify

One incoming call must produce exactly one `[CALL][APP] INCOMING STEP 0` line, and
if more than one is emitted, every one must show the same `userName` /
`hideContact`.

---

## Not a backend problem — checked and ruled out

- **`callerImage` pointing at `backend.talkstry.com` while the app is on staging.**
  The app's own chat rows carry avatars from four hosts at once
  (`backend.talkstry.com`, `whatback.tresting.com`, an S3 bucket,
  `chatback.vigorousit.com`). The host is simply whatever was current when that
  profile picture was uploaded, so this is historical data, not a push defect.
- **The Android incoming-call banner "disappearing by itself."** Traced on device:
  in one call the banner lived the full 40-second ring window and ended as
  `missed`; in the other the caller's iPhone called `hangup()` from a **button
  press** (the stack ends in React Native's `Touchable` internals, and `hangup` is
  wired to exactly one thing — the red End button). The banner is a symptom, not
  the bug.

## Being fixed on the client (for reference, no backend work)

- The incoming ring was posted up to **4 times** for one call, which makes Android
  silence the ringtone (`NotifAttentionHelper: Muting recently noisy`). Now
  de-duplicated.
- iOS incoming calls had no audio-recovery retry ladder (the caller side had one),
  which can leave an answered call silent both ways.
- Android's ring foreground service runs as `SHORT_SERVICE`, which Android refuses
  microphone access to (`can not have location/camera/microphone access`). Being
  addressed natively.
