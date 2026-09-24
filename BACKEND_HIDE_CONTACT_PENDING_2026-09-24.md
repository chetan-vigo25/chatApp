# Backend: "hide contact" — what is still pending (2026-09-24, re-checked)

Follow-up to `BACKEND_HIDE_CONTACT_2026-09-24.md`, re-checked live against the
server after your deploy.

**Rule (unchanged):** when a user turns on *hide contact details*, every other
user sees only their `@username`. No other user may receive their phone number
or profile name. This includes people who have them saved in their phonebook.

Test pair used: viewer `69a5185acf2a2ed928da5ffd`, and
`6a72cf2d26d07447d7a146a0` (`@jangid`, hideContact **on**).

| # | Change | Status |
|---|--------|--------|
| 1 | Call logs: stop returning caller location / IP | ✅ **Done, verified** |
| 2 | Contact sync rows: add `hideContact`, `userName`, `userId` | ✅ **Done, verified 2026-09-24** (`contact:refresh`, full and incremental) |
| 3 | `call:incoming`: `mobile: null` for a hidden caller | ❓ Please confirm, with a sample payload |
| 4 | `contact:updated` sent to phonebook contacts, not only chat peers | ❓ Please confirm |
| 5 | `GET user/blocked`: add `hideContact` + `userName`, null number when hidden | ❓ Please confirm, with a sample payload |

---

## ✅ 1. Call logs — done

`GET user/call/logs` was checked across 100 rows. None of them contains
`callerLocation`, `callerDevice`, `networkInfo`, `calleeLocation` or
`calleeDevice`. Thank you, no further action.

---

## ✅ 2. Contact sync rows — done (re-checked 2026-09-24)

Verified: all 8 matched rows now carry `userId`, `userName` and a boolean
`hideContact` (`@jangid` and `@ahmed` → `true`, the rest → `false`), and the app
stores them. The original request is kept below for reference.

### Original request

A `contact:refresh` with `incremental: false`, sent after the deploy, returned
263 rows, 8 of them registered matches. **None of the 8** has `hideContact`,
`userName` or `userId`. The row for `@jangid` is unchanged:

```json
{ "phoneNumber": "+914422441441", "fullName": "4422localtest",
  "matchedUserId": "6a72cf2d26d07447d7a146a0", "isDeleted": false,
  "email": null, "mobile": null, "mobileFormatted": null }
```

**Required.** Every row with a registered match, in **both** events below:

- `contact:sync:response` (full sync)
- `contact:refresh:response` (the app runs this one far more often: on app
  open, on the contacts screen, and on pull-to-refresh)

must look like this:

```json
{ "phoneNumber": "+914422441441", "fullName": "4422localtest",
  "matchedUserId": "6a72cf2d26d07447d7a146a0",
  "userId": "6a72cf2d26d07447d7a146a0",
  "userName": "jangid",
  "hideContact": true,
  "isDeleted": false, "email": null, "mobile": null, "mobileFormatted": null }
```

- **Compute the values when you respond.** If `contact:refresh` answers from the
  snapshot stored at the last full sync, the new fields will be missing, or
  stale after a user flips the toggle. That may be why this change is not
  showing up.
- **Send `hideContact` as a real boolean (`true` / `false`)** on every matched
  row. The app reads a missing field as "unknown" and keeps its old value, so
  leaving it out never un-hides anyone.
- **Take the values from `serializePublicUser`,** so they match what the chat
  list and directory search already send.
- **Keep `phoneNumber` as it is.** It is the viewer's own phonebook number and
  the sync key; the app hides it on screen.
- Unregistered rows (`matchedUserId: null`) need nothing new.

**Why it matters:** the Select Contact, New call, create-group / add-members and
conference "add people" screens are built from these rows. Without the flag, a
saved contact who hides their details shows up there with their saved name and
number. The only exception is a contact the app has already seen in the chat
list or a directory search.

**App side:** already shipped. The app reads these three fields, stores them in
its contacts table and applies them everywhere. The next refresh after this
change fixes those screens; no app release is needed.

---

## ❓ 3. `call:incoming` — please confirm

Also tracked in `BACKEND_PENDING_2026-09-23.md` §1. For a caller who hides their
details, `from.mobile` must be `null` on **every** emit, and in the FCM call
push data as well.

Before the deploy, emit A carried `"mobile": "+914422441441"` for `@jangid`.
Please send one captured `call:incoming` payload from a hidden caller after the
deploy. We will also verify it with a live call.

General rule for any payload that describes another user (socket, REST, push):
when `hideContact` is true, send `mobile` / `mobileNumber` / `phone` as `null`
and use `@username` in every name field.

---

## ❓ 4. `contact:updated` audience — please confirm

When a user turns the toggle on or off, send `contact:updated` to **every user
who has them as a matched contact**, not only to users who share a chat with
them. Otherwise someone who has them saved but never messaged them keeps the
old state until their next contact refresh.

Payload the app expects:

```json
{ "userId": "6a72cf2d26d07447d7a146a0", "userName": "jangid", "hideContact": true, "mobileNumber": null }
```

For a hidden user, send `mobileNumber: null` and omit `fullName`.

---

## ❓ 5. Blocked list — please confirm

`GET user/blocked`: each item should carry `userName` and `hideContact`, and the
number should be `null` when `hideContact` is true. We could not check this
live because the test account's blocked list is empty. Please share a sample
item for a hidden user.

---

## How we will verify

On the viewer's phone, with `@jangid` hidden:

1. **Item 2:** a `contact:refresh` returns `hideContact: true`,
   `userName: "jangid"` and `userId` on `@jangid`'s row. Select Contact and
   New call then show `@jangid` with no number.
2. **Item 4:** toggle `@jangid` off, then on again. Both screens flip within a
   few seconds with no app restart.
3. **Item 3:** a call from `@jangid` gives `mobile: null` on every
   `call:incoming` emit.
4. **Item 5:** block `@jangid`. The blocked-list item has no number.
