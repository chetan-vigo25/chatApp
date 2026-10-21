# Business chats in the app — implementation guide

**Status (2026-10-21):** backend, web app **and the mobile app code** are done. The app was *not* run on a device or
emulator — only Babel-parsed and unit-tested (`node --test __tests__/` → 84/84) — so run the §4 checklist on a real
phone before shipping. **§0 below is the exact, directory-by-directory list of what was changed in `src/`** — hand that
to the developer porting this into another copy of the app.

> Read this top to bottom before changing code. Line numbers below are from 2026-10-21 and will drift —
> search for the quoted identifiers, not the numbers. Follow `.claude/CLAUDE.md` (StyleSheet only, no
> `console.log`, expo-video, no hooks in `renderItem`, SQLite is the source of truth, ids as strings).
> **Do not add a dependency without asking** (see "PDF viewing" — it needs a decision).

---

## 0. What was implemented in `src/` (directory by directory)

No new dependency was added (everything used is already in `package.json`: `expo-image`, `expo-video`,
`react-native-webview`, `expo-intent-launcher`, `expo-file-system/legacy`, `@likashefqet/react-native-image-zoom`,
`react-native-gesture-handler`, `expo-media-library`). No SQLite schema change / migration. No new Redux slice.

### `src/utils/` — NEW
| File | What it is |
|---|---|
| `businessChat.js` | CommonJS (so `node --test` can load it). Exports `isBusinessChat(chat)` (false for group / broadcast; true when `chat.isBusinessSender ?? chat.peerUser?.isBusinessSender`), `BUSINESS_SUBTITLE` = "Business account", `BUSINESS_COMPOSER_NOTICE`. The answer is always derived from the row — never stored as a second flag. |
| `businessPeerProbe.js` | **Fallback for servers that do not send `isBusinessSender` yet** (e.g. a staging backend that is not redeployed). `probeBusinessPeer(peerId)` calls `profileServices.profileDetails` once per peer per session (cached, de-duplicated) and decides via `looksLikeBusinessSender(profile)`: `profile.business` or `profile.isSenderProfile`, **or** `userType === 'organization'` with no phone number. Exports `knownBusinessPeer`, `looksLikeBusinessSender`. Once the new backend is live the flag arrives on the row and the probe is just a harmless extra request. |

### `src/components/` — NEW
| File | What it is |
|---|---|
| `BusinessMessageCard.jsx` | One message drawn like its template: `[bold headerText] [media] [body, links tappable] [small footer] [time]`, fixed width `min(88% of screen, 360)`. Exports helpers `businessParts(msg)` (uses `templateParts`, else `text` minus a bare file name) and `formatBytes`. **Image:** `expo-image`, 4:3, no blur gate; tap → full-screen viewer with **pinch / double-tap zoom** (`ImageZoom`, 1×–5×, double-tap 3×) and a **Save (download) icon** that writes to the gallery through `saveFileToMediaLibrary`. **Video:** `expo-video`, 16:9, native controls. **Document:** tile coloured by extension + name + `"<size> • <EXT>"` (size omitted when unknown) + **eye** icon — no download icon, no "tap to download". If the media URL fails once, it retries through the file endpoint (§2.3); second failure → "This file is no longer available." Files are fetched with `fetchThroughEndpoint`: first `GET <BACKEND_URL>user/chat/message/:id/api-media` with the Bearer token, and if that fails (older server without the endpoint) the message's own `mediaUrl`. Cached in `cacheDirectory/business-docs/`, files older than 1 h are swept when a new one opens. **PDF viewing:** iOS → in-app `WebView` (copy deleted on close); Android → system viewer via `IntentLauncher ACTION_VIEW` (WebView cannot render PDFs; needs a PDF app on the phone). Other document types → system viewer (Android) / message "can only be viewed on the web" (iOS). |
| `BusinessDetailsCard.jsx` | The "About / description / Business details" block of Contact info: Category, Website (+ green **Verified** chip from `business.websiteVerified`, tap opens browser), Email (mailto), Phone (tel), Address, "On TalksTry since <MMMM YYYY>". A row only when it has a value; "This business has not shared more details." when none. |

### `src/contexts/`
| File | Change |
|---|---|
| `useChatLogic.js` | (1) **`chatData` now carries the flag.** The private-chat `chatData` used to be rebuilt from `{peerUser, chatId, chatType}` only, which silently dropped `isBusinessSender` — this was why the first version of the app showed no change. It is now taken from `item`, `knownChatRow`, `peerUser`, `rowPeer` **or the probe** and written onto `chatData` and `chatData.peerUser`. (2) State `probedBusinessPeer` + effect calling `probeBusinessPeer(probePeerId)` (private chats only), included in the `chatData` memo deps. (3) `normalizeIncomingMessage` copies `templateParts` (object or `null`). |
| `RealtimeChatContext.js` | (1) `buildStorageChatList` writes `isBusinessSender: true` so it is persisted in the chat row's `raw_data`. (2) The chat-list normaliser builds `peerUser.isBusinessSender` from the flat row and **never overwrites a `true` with a missing value** (item and peer are kept in step). (3) The two realtime message normalisers (the `source?.` one and the `data?.` one) keep `templateParts`. |

### `src/services/`
| File | Change |
|---|---|
| `ChatDatabase.js` | `templateParts` is stored **inside the message `payload` JSON** (next to `mediaMeta`) on write and restored on read — no column. |

### `src/presence/components/`
| File | Change |
|---|---|
| `ChatHeaderPresence.js` | New prop `isBusiness`: status line = `BUSINESS_SUBTITLE`; presence subscription is skipped (`useUserPresence(null)`). |

### `src/screens/chats/`
| File | Change |
|---|---|
| `ChatScreen.jsx` | Imports `isBusinessChat`, `BUSINESS_COMPOSER_NOTICE`, `BusinessMessageCard`. `const isBusiness = isBusinessChat(chatData)` next to `isBroadcastChat`. **Header:** `isBusiness` passed to `ChatHeaderPresence`; `CallButtons` not rendered. **Composer:** a first branch `isBusiness ? <notice bar> : isBroadcastChat ? …` (new `businessStyles` StyleSheet) — no text box / attach / camera / mic / emoji. **Rows:** in `renderChatsItemBodyImpl`, before the system-message branch, a received, non-deleted, non-album message in a business chat renders `<BusinessMessageCard>` (it keeps the row ref for the long-press menu anchor and the selection/highlight state). **Actions:** `messageActionCaps` returns `canReply / canForward / canReact / canEdit / canInfo = false` for business (Copy, Report, Delete-for-me remain; deps include `isBusiness`). **Selection toolbar:** Reply and Forward icons hidden. **Swipe-to-reply:** disabled. |
| `ForwardMessageScreen.jsx` | Business chats are filtered out of the destination list (`if (isBusinessChat(chat)) return false`). |

### `src/screens/profiles/`
| File | Change |
|---|---|
| `UserB.jsx` (Contact info) | `isBusinessPeer = looksLikeBusinessSender(peerProfile) || peer.isBusinessSender || isBusinessChat(routeItem)`. For a business: subtitle "Business account"; the Message / Audio / Video card, Mobile row, Email/Username card and "groups in common" are hidden; `BusinessDetailsCard` shown (data = `peerProfile.business`); Mute / Media / Block kept; "Report {name}" → **"Report business"**. |

### `__tests__/` (app root) — NEW
`businessChat.test.js` (5 tests: flag on item, on `peerUser`, missing/false, group & broadcast never business, subtitle). Run: `node --test __tests__/`.

### Behaviour against an OLD (not yet redeployed) backend
Works: no call icons, "Business account" header, no composer, no reply/forward/react, no download icons / blur gate,
images view + zoom + save, documents open from the file's own link, Contact info without Message/calls.
Does **not** (needs the new backend): template layout (header / body / footer as separate parts — the whole text is shown as the body), real file size (omitted), the `business` details (Category, Verified website, etc. — the card shows "This business has not shared more details."), the server-side call refusal.

### Not done
- "Call back" is still offered on a business call-log row (the server refuses the call; button not hidden).
- Android has no in-app PDF renderer (a native dependency such as `react-native-pdf` would need approval + a rebuild).
- Not run on a device/emulator.

---

## 1. What a "business chat" is

A business that buys the TalksTry Business API sends messages through the API. Those messages come from a
**sender-profile account** — a real user row (`isSenderProfile: true`) that **nobody signs in as**. To the
customer it looks like a chat with the business ("Juber Fashion Store").

It is **not a normal chat. It is a read-only connection** — an inbox of updates:

| In a business chat | Behaviour |
|---|---|
| Calling (voice / video) | **removed** — nobody would answer |
| Typing / sending / attaching | **removed** — composer is replaced by a notice |
| Reply (swipe or menu), React, Forward, Select, Edit | **removed** |
| Download icons / "tap to download" / blur gate / "Paused • Resume" | **removed** — media shows in the chat by itself |
| Viewing files | PDF/documents open in a viewer on the same screen; images/videos play inline; the image viewer zooms and has a Save-to-gallery icon |
| Message layout | drawn like the **template** the business used (header, media, body, footer, time), one fixed width |
| What stays | Copy, Report, Delete for me, Mute / Block / Clear / Delete chat, search |

Everything above is **per chat**, decided from one flag the server sends (`isBusinessSender`). Normal chats,
groups, channels and the self chat must behave exactly as before.

---

## 2. What the backend already provides (no backend work for the app)

Deployed with the 2026-10-21 changes. **Verified live** (backend `test/live/businessChat.live.mjs` 14/14, unit tests).

### 2.1 The flag — `isBusinessSender`
Present, for **private** chats only, on:
- the socket chat list (`chat:list` ack) — item and `peerUser`
- the REST list `POST /api/v2/user/chat/list` — item
- the "create chat" response — `peerUser`

```jsonc
{ "chatId": "u_<me>_<sender>", "chatType": "private", "peerUserId": "<sender>",
  "isBusinessSender": true,
  "peerUser": { "_id": "<sender>", "fullName": "Juber Fashion Store", "isBusinessSender": true } }
```
`false` (REST) / absent (some realtime paths) for everything else — treat missing as `false`.

**Caveat:** the *first* `chat:list:update` for a brand-new chat is deliberately lean (`{chatId, lastMessage, …,
type:'new_message'}`) — no peer identity, so no flag. The flag arrives with the list / REST fetch that
hydrates the new row. **Do not clear the flag when a lean update merges into an existing row.**

### 2.2 Message fields (additive)
Present on `message:new` (realtime), history REST, and sync:

```jsonc
{
  "messageType": "document",            // text | image | video | document
  "text": "Hi Asha, your invoice is attached.\n\nThank you for shopping",   // whole composed message (unchanged)
  "mediaUrl": "http://…/uploads/profile/apimedia_<uuid>.pdf",              // or …/media/avatar/profile/apimedia_… (S3)
  "mediaMeta": { "fileName": "invoice-1042.pdf", "mimeType": "application/pdf",
                 "fileSize": 193, "contentHash": "<sha256>" },             // fileSize/contentHash only for POST /v1/media uploads
  "mediaId": null,                      // API messages have NO media record — this is the root of the old download bug
  "templateParts": { "headerText": null, "body": "Hi Asha, your invoice is attached.", "footer": "Thank you for shopping" }
}
```
- `templateParts` exists only on messages built from a template. Free-form API text has none → draw `text` as the body.
- `headerText` is set only for a text-header template (media-header templates have no header text).
- Old messages have no `templateParts` / `fileSize` → fall back to `text`; show the size only if known.

### 2.3 The file endpoint — use this instead of `mediaId`
```
GET /api/v2/user/chat/message/:messageId/api-media
Authorization: Bearer <access token>        (same auth as the other /user/chat routes)
Range: bytes=0-1023                          (optional)
```
- `200` / `206` with `Content-Type` = the file's type, `Content-Disposition: inline; filename*=UTF-8''…`,
  `Accept-Ranges: bytes` (local storage). `404` for "no such message / not yours / not an API file" (one answer on
  purpose), `404 {errorCode:'not_proxyable'}` if the stored link is not one of the platform's own files
  (e.g. a business supplied its own https link — then use `mediaUrl` directly), `401` without a token.
- Only the **recipient** of the message may call it. Use the message's **server id** (`messageId`, not `temp_…`).
- It works regardless of S3 CORS, redirects, or frame headers — that is why it exists.

### 2.4 Calls are refused by the server
`call:ring` to a sender-profile account is acked:
```json
{ "ok": true, "unavailable": true, "unavailableCode": "business_sender",
  "unavailableMessage": "This business account does not take calls." }
```
(and a `call:unavailable` event). This is the safety net; the app should simply never offer the call.

### 2.5 The business's own details (Contact info panel) — added 2026-10-21
`POST /api/v2/user/auth/view` with `{ "_id": "<sender account id>" }` (the same call the app's profile sheet already makes)
now carries a `business` object **for a sender-profile account only** (absent for everyone else):

```jsonc
{ "_id": "<sender>", "fullName": "Juber Fashion Store", "isSenderProfile": true,
  "business": {
    "name": "Juber Fashion Store", "logoUrl": "https://…",
    "about": "Order updates",                          // the one-liner
    "category": "Fashion & apparel", "description": "Clothes and accessories, made in Pune.",
    "address": "12 MG Road, Pune 411001", "email": "help@juber.com", "phone": "+91 98765 43210",
    "website": "https://www.juber.com/shop",           // declared, or the verified domain when none was declared
    "websiteVerified": true,                           // TalksTry checked the business controls this site
    "verifiedDomain": "juber.com", "verifiedLevel": "strong",
    "memberSince": "2026-01-05T…Z" } }
```
- Every field except `name` may be an empty string — **show a row only when it has a value.**
- `websiteVerified` is computed by the server from the business's *proved* domain. Never derive a "Verified" mark on the client.
- It contains only what the business published plus the verified domain and account age. The legal name, registration
  numbers and login email of the organisation are **never** included — do not try to show them from anywhere else.
- `ownerOrganizationId` / `ownerProjectId` are no longer returned for a sender account.

---

## 3. What to build in the app

### 3.1 One helper — `src/utils/businessChat.js` (new)
Mirror of the web's `chat-website/src/utils/businessChat.js`:
```js
export const isBusinessChat = (chat) => {
  if (!chat) return false;
  if (chat.chatType === 'group' || chat.chatType === 'broadcast' || chat.isBroadcast) return false;
  return Boolean(chat.isBusinessSender ?? chat.peerUser?.isBusinessSender);
};
export const BUSINESS_SUBTITLE = 'Business account';
```
Derive it from the chat row every time — **never store a second flag** that can drift.

### 3.2 Carry the data through (so nothing drops it)
| Where | Search for | Do |
|---|---|---|
| Chat list normalisation | `src/contexts/RealtimeChatContext.js` — the places that build `peerUser` from flat fields (~l.774, ~l.799, ~l.921) and the merge helpers that already special-case `isVerified` (~l.1253–1292, ~l.1725) | pass `isBusinessSender` on the item **and** `peerUser`; a merge must not overwrite `true` with `undefined` |
| Chat rows in SQLite | `src/services/ChatDatabase.js` — chat rows keep their raw JSON (see `updatePeerVerified` ~l.3859 which edits `raw`) | no schema change needed if `isBusinessSender` is on the item/`peerUser`; verify it survives a restart |
| Incoming messages | `src/contexts/useChatLogic.js` / `ChatSocketProvider.js` message normaliser (where `mediaMeta`, `replyTo`, `forwardedFrom` are copied) | copy `templateParts` (object or `null`); keep `mediaMeta.fileSize` / `contentHash` |
| Messages in SQLite | `src/services/ChatDatabase.js` message payload builder (~l.1640–1650, "Preserve mediaMeta … in payload") and the restore (~l.953–961) | persist `templateParts` **inside the `payload` JSON** (like `mediaMeta`) — no new column, no migration |

### 3.3 ChatScreen (`src/screens/chats/ChatScreen.jsx`) — all of it is gated on `isBusiness`
Define once near `isBroadcastChat` (~l.7934): `const isBusiness = isBusinessChat(chatData);`

1. **Header** — `CallButtons` is rendered at ~l.8509–8530: add `|| isBusiness` to the condition that hides it
   (it already hides for broadcast and self chat). Header subtitle: show `BUSINESS_SUBTITLE` instead of
   presence / "last seen" (the header already takes `isBroadcast` to suppress last-seen, ~l.8340 — add an
   equivalent for business). Do not subscribe to presence for these chats if it is cheap to skip.
2. **Composer** — the chain at ~l.9035 (`isBroadcastChat ? <read-only banner> : contactBlockedHide ? … : <ChatInputBar/>`):
   add a branch `isBusiness ? <banner> :` right after the broadcast one, same styling:
   *"This is a business account. It sends you updates here — you can't reply."*
   This removes the text box, attach, camera, mic, emoji and the reply preview bar. Also guard any entry that
   injects into the composer from outside (share-intent / paste / "forward to chat" at ~l.2846 and ~l.4837 must
   not target a business chat — see §3.6).
3. **Message actions** — `messageActionCaps` (~l.8066–8095) returns `canReply / canForward / canReact / canEdit /
   canInfo`. For a business chat set **all of them `false`**; keep `canCopy` (text) and `canReport`, and Delete for me.
   The menu list (`menuActions`, ~l.8107+) is built from those caps, so nothing else is needed there — but check
   the selection-mode toolbar (~l.8414 "Reply" and its siblings): hide Reply/Forward there, or do not allow
   entering selection mode in a business chat.
4. **Swipe-to-reply** — `SwipeReplyRow` is used at ~l.7270 with a `disabled` prop: pass `disabled={… || isBusiness}`.
5. **Reactions** — hide the reaction bar / picker entry for business messages (`ReactionBar`, `ReactionPicker`).
6. **Rows** — in `renderChatsItem`, the type branches start at ~l.7010 (`isImage`, `isVideo`, `isFile`…).
   Add `const isBusinessMessage = isBusiness && !isMyMessage && !isDeletedMessage && !isViewOnce;` and, when true,
   render `<BusinessMessageCard …/>` **instead of** the image/video/file/text branches (and skip the separate
   meta row — the card draws its own time). Rule 3: no hooks in `renderItem` — `BusinessMessageCard` is a
   component, hooks live inside it. If a row also passes through `rowCtx` (~l.7762 memo deps), include `isBusiness`.
7. **Bubble width** — every business bubble is the same width (web uses `min(100%, 24rem)`; on a phone use
   ~`min(88% of screen, 360)`), so the list does not jump while media loads. Media blocks have a fixed aspect
   (image 4:3, video 16:9) before their bytes arrive.

### 3.4 `src/components/BusinessMessageCard.jsx` (new)
`StyleSheet.create` only. Props: `{ msg, timeLabel, theme, isDarkMode }`. Layout (top to bottom):
```
headerText   (bold)          only if templateParts.headerText
media        image | video | document card        only if the message has media
body         templateParts.body, else msg.text (skip if it equals the file name)
footer       templateParts.footer — small, muted
                                                         time
```
- **Image:** `expo-image` `<Image source={{uri: mediaUrl}}>`, aspect 4:3, `contentFit="cover"`, no `BlurGateImage`
  (that component is the *download gate* — do not use it here). `onError` → retry once through the file
  endpoint (§2.3) saved to cache; second failure → "This file is no longer available." Tap → full-screen viewer with pinch / double-tap zoom and a Save-to-gallery icon.
- **Video:** `expo-video` (`useVideoPlayer` + `VideoView`, native controls, `nativeControls`), aspect 16:9.
  Same one-retry-through-the-endpoint rule. Remember `player.addListener(...)` + `sub.remove()` cleanup.
- **Document card:** tile (colour by extension — PDF `#E53935`, DOC/DOCX `#1565C0`, XLS/XLSX/CSV `#2E7D32`,
  PPT/PPTX `#E65100`, default `#03b0a2`), file name (2 lines), subline `"<size> • <EXT>"` — **omit the size if
  `mediaMeta.fileSize` is missing; never print "Size unknown"** — and an **eye** icon on the right.
  **No download icon, no ring, no "Tap to download".** Tap → viewer (§3.5).
- Body text: reuse the existing rich text renderer used for normal bubbles (links tappable).
- Long-press opens the (reduced) actions menu from §3.3 — Copy / Report / Delete for me only.

### 3.5 PDF / document viewing — **needs your decision**
The viewer must show the file on the same screen and offer nothing to save/forward. Fetch the bytes with the
file endpoint (§2.3) using the access token from `src/services/secureTokenStore.js` (`getAccessToken`, the same
call `MediaService.js` uses at ~l.154/~l.346) into the app cache.

| Platform | Recommended without a new dependency |
|---|---|
| **iOS** | `react-native-webview` (already in `package.json`) pointed at the cached `file://` URI — WKWebView renders PDFs |
| **Android** | WebView does **not** render PDFs. Options: **(a)** open the cached file with `expo-intent-launcher` (`ACTION_VIEW`, needs a content URI) — leaves the app; **(b)** add a PDF renderer (e.g. `react-native-pdf`) — **new native dependency, requires a rebuild and your approval**; **(c)** a Google-Docs-viewer URL in the WebView — **do not**: it sends the customer's private document to a third party |
Pick (a) now or (b) after approval; document the choice at the top of `BusinessMessageCard.jsx`. For non-PDF
documents (Word/Excel) hand the cached file to the OS viewer (same as (a)) — the app cannot render them.
Delete the cached copy when the viewer closes / on `unmount` (nothing here is a "download").

### 3.6 Entry points that must not reach a business chat
- Contact-info / profile screens: hide the **Voice / Video** call actions for a business peer
  (`src/calls/components/CallButtons.jsx` is the shared component — gating it at the call sites is fine).
- `ForwardMessageScreen`, share-inbox (`ShareInboxScreen`) and any "send to…" picker: **exclude business chats**
  from the destination list (you cannot send into them).
- Call log rows: do not offer "call back" for a business peer.
- Group member sheets: a sender-profile account is never a group member; no change needed.

### 3.7 Contact info / profile screen for a business
Find the 1:1 profile screen the header avatar opens (the same one that shows "About" and the phone number; search for
the profile sheet that calls the `view` endpoint). For a business (`isBusinessChat(chat)` or `profile.business`):

1. Header block: name, subtitle **"Business account"** (no number, no presence), the logo as the avatar.
2. Quick actions: **only Mute**. Remove **Message** and the call actions.
3. Replace the "About" + "Contact details" (username / phone / email) block with:
   - **About** (`business.about`) and, below it, the **description** — only if present.
   - **Business details** card, one row per non-empty value: Category, Website (**tap opens it in the browser**; show a
     green **Verified** chip when `websiteVerified`), Email (tap → mail app), Phone (tap → dialer), Address, and
     **"On TalksTry since <Month YYYY>"** from `memberSince`.
   - If nothing at all: "This business has not shared more details."
4. Hide **"N groups in common"**. Keep **Media, links and docs**, **Clear chat**, **Block**.
5. Relabel **"Report contact" → "Report business"**.
6. Persist nothing extra: `business` is read when the screen opens; do not copy it into the SQLite message/chat rows.

Reference: `chat-website/src/components/ChatInfoDrawer.jsx` — search `BusinessDetails` and `isBusinessPeer`.

---

## 4. Acceptance checklist (do it on a real phone, against dev or staging)

Set up: in the developer console create a project + sender profile, make four templates (text with header+footer,
PDF, image, video), send each to a registered test number, open the app as that number.

- [ ] Chat list shows the business chat normally (name, preview, unread). Opening it works offline from SQLite.
- [ ] Header: **no** call icons; subtitle says "Business account" (never "last seen"/"online").
- [ ] Text template: bold header, body, small footer, time inside the card.
- [ ] PDF: card with name and real size ("193 B • PDF"), **no** download icon; body + footer under it; tap opens the viewer on the same screen.
- [ ] Image shows by itself (sharp, no blur gate); tap opens it larger. Video plays with controls.
- [ ] All business bubbles have the same width; nothing jumps while media loads.
- [ ] **No composer** — the notice bar instead. No attach / camera / mic / emoji.
- [ ] Long-press menu: Copy, Report, Delete for me only. No Reply / React / Forward / Select / Edit / Download / Info. Swipe does not start a reply.
- [ ] Same media with the media host blocked (airplane-mode the host, or point `mediaUrl` somewhere dead): the file still shows via the API endpoint.
- [ ] Old messages (sent before this feature) still show; a PDF without a size shows just "PDF".
- [ ] Contact info of a business: "Business account", no Message / call actions, Business details rows (only non-empty ones),
      Verified chip on a verified website, website/email/phone are tappable, "On TalksTry since …", no groups-in-common, "Report business".
- [ ] A **normal** 1:1 chat, a group, a channel and the self chat are unchanged (calls, composer, reply, forward all still there).
- [ ] Force-quit and reopen: flag and `templateParts` survive the SQLite round trip; the chat still looks like a business chat.
- [ ] Try to call the business from any other screen: you cannot; if you force it, the call screen says "This business account does not take calls."

## 5. Tests to add (app side)
- Unit: `isBusinessChat` (flag on item, flag on `peerUser`, missing → false, group/broadcast → false).
- Unit: the message normaliser keeps `templateParts` / `mediaMeta.fileSize`, and a lean chat update does not clear the flag.
- Unit: `messageActionCaps` for a business message → only `canCopy` / `canReport`.
- Component: `BusinessMessageCard` renders header / body / footer from `templateParts`, hides the size when unknown, shows no download affordance.

## 6. Parity with the web (reference implementation)
Read these if something is unclear — they are the working version of every point above:
- `chat-website/src/utils/businessChat.js`
- `chat-website/src/components/media/BusinessMessage.jsx` (card + viewer)
- `chat-website/src/components/ChatLayout.jsx` — search `isBusiness` (header, composer notice, menus, bubble width)
- `chat-backend/src/controllers/chat/apiMedia.controller.js` (the file endpoint) and `chat-backend/test/live/businessChat.live.mjs`

## 7. Out of scope / known limits
- Customers can still reply **from an app that has not shipped this change** (the backend does not block it); once this
  ships, replying from either client is impossible. The business-side reply webhook (`message.inbound`) therefore
  fires only for customers who write first from an older app or another channel.
- Video thumbnails are not generated server-side; `expo-video` shows the first frame once metadata loads.
- A business that supplies its **own** `https` link for a template header keeps that link; the file endpoint answers
  `not_proxyable` for it and the app uses the link directly.
- Do not "fix" the web/app difference in PDF viewing by building a download flow — read-only is the product decision.
