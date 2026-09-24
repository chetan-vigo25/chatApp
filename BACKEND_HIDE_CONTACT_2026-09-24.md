# Backend: "hide contact" privacy (2026-09-24)

**Rule:** when a user turns on *hide contact details*, every other user sees only
their `@username`. No other user may receive their phone number or their
profile name. This applies to everyone, including people who have them saved in
their phonebook.

The app now enforces this on every screen, but it can only hide what the server
tells it is hidden. Below is what the server still has to change. Everything was
measured live on 2026-09-24 with a test pair: viewer `69a5185acf2a2ed928da5ffd`,
and `6a72cf2d26d07447d7a146a0` (`@jangid`, hideContact **on**).

| # | Change | Priority |
|---|--------|----------|
| 1 | Call logs return the caller's GPS location and IP to the other person | **Urgent** (privacy leak) |
| 2 | `contact:sync` / `contact:refresh` rows: add `hideContact` + `userName` | **Required** |
| 3 | `call:incoming` must not send `mobile` for a hidden caller | Required (already in `BACKEND_PENDING_2026-09-23.md` §1) |
| 4 | Send `contact:updated` to phonebook contacts too, not only chat peers | Required |
| 5 | `GET user/blocked` items: add `hideContact` + `userName`, drop the number when hidden | Small |

---

## 1. Call logs leak the caller's location and IP (**urgent**)

`GET user/call/logs` returns, **to the receiver**, the caller's exact position
and network identity. This is the receiver's own incoming row
(`ownerId` = the receiver, `direction: "incoming"`):

```json
{
  "ownerId": "69a5185acf2a2ed928da5ffd",
  "direction": "incoming",
  "chatId": "u_69a5185acf2a2ed928da5ffd_6a72cf2d26d07447d7a146a0",
  "callerDevice":   { "deviceId": "439d3a93…", "ip": "103.59.75.121", "platform": "iOS" },
  "callerLocation": { "latitude": 26.92227659425289, "longitude": 75.7397207160479, "accuracy": 5.1 }
}
```

The caller here is a user who hides their contact details, and the receiver
still gets their location to within about 5 metres. This is unrelated to the
toggle: **no user should ever receive another user's location, IP or device ID.**

**Change:** strip `callerLocation`, `callerDevice` (and any callee equivalents,
plus `networkInfo`) from the call-log response. Keep them server-side for
analytics if needed. The app does not read any of these fields.

---

## 2. Contact sync rows need `hideContact` and `userName` (**required**)

**Today** a matched row from `contact:refresh:response` looks like this:

```json
{ "phoneNumber": "+914422441441", "fullName": "4422localtest",
  "matchedUserId": "6a72cf2d26d07447d7a146a0", "isDeleted": false,
  "email": null, "mobile": null, "mobileFormatted": null }
```

Nothing on it says this user hides their details. So on the screens built from
the phonebook (Select Contact, New call, create group / add members, add people
to a conference call) the app shows the saved name and the number. The app
works around this only for users it has already seen in the chat list or in a
directory search.

**Change:** for every row with a registered match, in both
`contact:sync:response` and `contact:refresh:response`, add:

```json
{ …, "userId": "6a72cf2d26d07447d7a146a0", "userName": "jangid", "hideContact": true }
```

- Send `hideContact` as a real boolean for matched rows (`true` / `false`). The
  app treats a **missing** field as "unknown" and keeps its previous value, so
  omitting it never un-hides anyone.
- Send `userId` as well as `matchedUserId`. The app reads `userId`.
- Use the same values as `serializePublicUser`.
- Do not strip `phoneNumber` from these rows: the number came from the viewer's
  own phonebook and is the sync key. The app hides it on screen itself.

**App side: already done.** The app reads both fields, stores them in its
contacts table (new columns, DB v5), and uses them on every screen. When this
ships, the next contact refresh fixes those screens. No app release is needed
beyond the build that has this change.

---

## 3. `call:incoming` sends the hidden caller's number

This is already written up in `BACKEND_PENDING_2026-09-23.md` §1, point 3.
Emit A of `call:incoming` carries `"mobile": "+914422441441"` for `@jangid`,
who hides their details. For a hidden caller, `mobile` must be `null` on every
emit (socket and FCM push).

The same rule applies to every payload that describes another user: socket
events, REST responses and push data. When `hideContact` is true, send
`mobile` / `mobileNumber` / `phone` as `null` and use `@username` in the name
fields.

---

## 4. `contact:updated` must reach phonebook contacts, not only chat peers

When a user turns the toggle on or off, the app updates every screen live from
the `contact:updated` socket event. Please confirm it goes to **every** user who
has them as a matched contact, not only to users who share a chat with them.
Otherwise someone who has them saved but never messaged them keeps the old
state until the next contact sync.

Payload the app expects:
`{ userId, userName, hideContact, fullName?, mobileNumber? }`. For a hidden user,
send `mobileNumber: null` and omit `fullName`.

---

## 5. Blocked list

`GET user/blocked` items: add `userName` and `hideContact`, and send the number
as `null` when `hideContact` is true. The app already hides the number when it
knows the flag. This makes the list correct without depending on other screens.

---

## Already correct (no change needed)

These were checked live on 2026-09-24:

- **REST chat list:** sends `userName`, `hideContact: true`,
  `mobileNumber: ""` and `chatName: "@jangid"`. The app bug here (it dropped
  these fields) is fixed.
- **`user/directory/search`:** the hidden user comes back as `@handle` with no number.
- **Message socket events / message push:** `senderName` is already `@handle`
  for a hidden sender.
- **FCM call push:** `callerHideContact` arrives as `"true"`, fixed on 2026-09-23.

## How to verify

With `@jangid` hidden, on the other phone:

1. Contacts → Select Contact, and Calls → New call: the row shows `@jangid` with
   no number, even though it is a saved contact.
2. Toggle `@jangid` off, then on again. Both screens flip within a few seconds
   without an app restart (this checks item 4).
3. `GET user/call/logs`: no `callerLocation`, `callerDevice` or `networkInfo` on any row.
4. Ring from `@jangid`: every `call:incoming` emit has `mobile: null`.
