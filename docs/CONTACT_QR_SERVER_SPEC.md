# Contact QR — Server Spec

The mobile app now has a "My QR code" screen (Settings → QR button on the profile
card) and a contact scanner (Chat list → scan icon). Scanning someone's code shows a
small **contact card** — never their full profile — with up to two buttons:
**Save contact** (writes the person into the phone book and creates the 1:1
connection) and **Chat** (opens the 1:1 chat; works without a number).

**Status:** implemented on both sides. Backend (chat-backend) serves all three
endpoints plus the `canSave` / `canChat` flags below; the app gates its buttons on
those flags. Not yet verified end-to-end against a live server.

---

## 1. Why a token (and not the user's data in the QR)

The QR carries only an opaque, random token:

```
talkstry://u/<token>
```

The app also accepts `https://<any-host>/u/<token>`, so a hosted link can be
introduced later without an app update (see §6).

Putting `{ userId, name, phone }` straight into the QR would let anyone forge a
code with a fake name, would leak the phone number forever through screenshots,
would bypass the `hideContact` privacy setting, and could never be revoked. A
server-side token fixes all four.

---

## 2. Data model

One active token per user.

```
contact_qr_tokens
  userId      ObjectId   unique index   — owner
  token       string     unique index   — 128-bit random, base64url (22 chars)
  createdAt   Date
  revokedAt   Date|null                  — optional; or simply delete the old row
```

Token rules:

- Generate with a CSPRNG (`crypto.randomBytes(16).toString('base64url')`).
  Never derive it from the userId, phone, or a timestamp.
- The app validates the shape as `^[A-Za-z0-9_-]{16,128}$` — keep tokens inside it.
- A token has no expiry by default (people print or share their code). Reset is
  the owner's way to kill it.

---

## 3. Endpoints

All are authenticated (existing `Authorization: Bearer <accessToken>`), `POST`, and
use the standard envelope the app already reads:

```json
{ "statusCode": 200, "message": "OK", "data": { ... } }
```

Errors must put a machine-readable code in `data.code` — the app branches on it.

### 3.1 `POST user/qr/token` — get my QR token

Returns the caller's token, creating one on first call. **Idempotent** — the same
token comes back until it is reset.

Request body: `{}`

Response `data`:

```json
{ "token": "q3Zr0n8vT1a2Kx9mB4cW7g", "createdAt": "2026-09-14T10:00:00.000Z" }
```

### 3.2 `POST user/qr/reset` — revoke and rotate

Invalidates the current token immediately and returns a new one. Old codes must
resolve as `QR_INVALID` from this moment on.

Request body: `{}`

Response `data`: same shape as 3.1.

Rate limit: e.g. 10 resets / hour per user → `429` with `data.code = "RATE_LIMITED"`.

### 3.3 `POST user/qr/resolve` — who does this code belong to?

Request body:

```json
{ "token": "q3Zr0n8vT1a2Kx9mB4cW7g" }
```

Response `data` — a **limited public card**, nothing more:

```json
{
  "userId": "66e1c0b2f1a2b3c4d5e6f7a8",
  "fullName": "Rahul Sharma",
  "userName": "rahul",
  "profileImage": "https://cdn.../avatar.jpg",
  "isVerified": false,
  "hideContact": false,
  "mobile": { "code": "+91", "number": "9876543210" },
  "isSelf": false,
  "isBlocked": false,
  "chatId": "66e1c0b2f1a2b3c4d5e6f7b9",
  "canSave": true,
  "canChat": true
}
```

| Field | Rule |
|---|---|
| `userId`, `userName`, `profileImage`, `isVerified` | Always returned. |
| `hideContact` | The owner's `privacySettings.hideContact`. |
| `mobile` | **`null` when `hideContact` is true.** Otherwise the owner's number. The app disables "Save contact" when `mobile` is null — a phone contact can't be saved without a number. |
| `fullName` | When `hideContact` is true, return the `@userName` (same substitution the directory search already applies), not the account name. |
| `isSelf` | `true` when the caller scanned their own code. App shows "This is your QR code". |
| `isBlocked` | `true` when **the caller** has blocked the owner. App shows the card without a Save button. |
| `chatId` | Existing 1:1 chat between caller and owner, or `null`. The app skips `chat:create` when present. |
| `canChat` | `true` unless `isSelf` or `isBlocked`. App shows **Chat** only when true. |
| `canSave` | `canChat` AND `mobile` is not `null`. App shows **Save contact** only when true — hidden, not disabled. |

**Must NOT be returned:** about, last seen / online, email, status, groups,
contacts, settings, or anything else from the full profile.

Errors:

| HTTP | `data.code` | When |
|---|---|---|
| 404 | `QR_INVALID` | Token unknown, revoked, **or the owner has blocked the caller**, or the owner's account is deleted / suspended. Use one code for all of these so a block can't be detected. |
| 400 | `QR_INVALID` | Token missing or malformed. |
| 429 | `RATE_LIMITED` | Too many resolves (see §4). |

---

## 4. Abuse protection

- **Rate-limit `resolve`**: e.g. 30 / minute and 300 / day per user, plus a per-IP
  limit. This is what stops token guessing / scraping.
- Log failed resolves per user; repeated `QR_INVALID` bursts are a scraping signal.
- Never echo the token back in logs at info level.

As built: `resolve` 30 / minute and `reset` 10 / hour per user (`express-rate-limit`,
in-memory). **Gap:** the 300 / day resolve cap and the per-IP limit are not
implemented — they need a Redis-backed limiter to survive restarts and multiple
instances.

---

## 5. Connection — "Save contact" and "Chat"

No new endpoint for either. Both use the **existing** socket event:

```
socket.emit('chat:create', { userId })
```

`chat:create` is confirmed **find-or-create** on the backend
(`chat.handler.js#handleCreateChat`, `$setOnInsert` upserts on the unique
`(userId, chatId)` index), so scanning the same code twice — or from two devices —
lands on one chat.

**Save contact** (only when `canSave`): the app writes the phone contact, then
emits `chat:create` in the background only when `resolve` returned `chatId: null`
and no chat with that user is in its list. The scanner stays open. The app then
runs its normal `contact:sync` and chat-list reload, so the new contact shows up
without a manual refresh.

**Chat** (when `canChat`, with or without a number): no phone-book write. If a chat
already exists the app opens it; otherwise it emits `chat:create`, waits for
`chat:create:response`, and only then navigates to the thread. Repeat taps are
ignored while one is in flight.

---

## 6. Optional / later

- **Scan with the phone's own camera app.** For a code scanned outside the app to
  open TalksTry, switch the QR to an `https://` link (e.g.
  `https://talkstry.app/u/<token>`) and host `/.well-known/apple-app-site-association`
  and `/.well-known/assetlinks.json` on that domain, plus a fallback web page
  ("Open in TalksTry / Get the app"). The app already parses that URL shape; the
  in-app deep-link routing would be a small app-side follow-up.
- **"Someone added you" notification** to the owner after a save — only if product
  wants it; it reveals who scanned.
- **Connection requests (accept / decline)** — only if "connection" should become
  something more than a 1:1 chat. Today it is exactly `chat:create`.

---

## 7. Test checklist

- [ ] `token` returns the same value on repeated calls.
- [ ] `reset` returns a new value; the old token now resolves `404 QR_INVALID`.
- [ ] Owner with `hideContact: true` → `mobile: null`, `fullName` is the handle.
- [ ] Owner blocked the caller → `404 QR_INVALID` (indistinguishable from bad token).
- [ ] Caller blocked the owner → `200` with `isBlocked: true`.
- [ ] Caller scans own code → `200` with `isSelf: true`.
- [ ] Deleted / suspended owner → `404 QR_INVALID`.
- [ ] Response contains none of the fields listed under "Must NOT be returned".
- [ ] Resolve rate limit returns `429 RATE_LIMITED`.
- [ ] `chat:create` twice for the same pair returns the same chat.
