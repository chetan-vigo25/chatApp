# WhatsApp-style message notifications (Android)

How chat-message notifications are grouped and rendered so the tray looks like
WhatsApp: one threaded notification per chat, a single group summary
("**N messages from M chats**"), conversation + per-sender avatars, and correct
group titles. All in `src/firebase/messageNotification.js` (notifee MessagingStyle).

---

## What WhatsApp does (and we now match)

- **One notification per chat**, not one per message — each new message updates the
  same notification and lists the recent messages (a conversation thread).
- **A single group summary** when 2+ chats are unread: the collapsed header reads
  `TalksTry • 3 messages from 2 chats • now`.
- **Conversation avatar** (round) — group photo for a group, sender photo for a 1-1.
- **Per-sender avatars + "Sender: message"** lines inside a group thread.
- **Group title = group name** (not the sender).

---

## Architecture

```
FCM data message ─► fcmService.showLocalNotification
                      │  buildNotificationModel (title/body/avatar/isGroup/groupName)
                      ▼
              displayGroupedMessage(model)           ← src/firebase/messageNotification.js
                ├─ accumulate recent lines per chat   (AsyncStorage @msgnotif/<chatId>)
                ├─ bump unread count per chat          (AsyncStorage @msgnotif/__counts)
                ├─ resolve group name (payload → local chat list fallback)
                ├─ notifee.displayNotification id=`msg-<chatId>`  (MessagingStyle, stable id → threads)
                │     • largeIcon = conversation avatar (circular)
                │     • style.title = group name (group only)
                │     • style.messages[].person = { name, id, icon: senderAvatar }
                └─ ensureGroupSummary(... summaryText(counts))     (groupSummary, subText = "N messages from M chats")
```

### Why the pieces matter
| Piece | Purpose |
|---|---|
| Stable id `msg-<chatId>` | All messages for a chat update ONE notification → threading (not a stack). |
| `groupId: ANDROID_GROUP_KEY` on every chat + a `groupSummary` notification | Android coalesces multiple chats under one header (WhatsApp's "N messages from M chats"). |
| Per-chat unread `counts` map (separate from the capped line list) | Accurate total for the summary even though only the last `MAX_LINES` lines are kept. |
| `subText` on the summary | The collapsed header text slot WhatsApp uses for "N messages from M chats". |
| `largeIcon` + `circularLargeIcon` | Round conversation avatar. |
| `style.messages[].person.icon` | Per-sender avatars on each line in a group. |
| `style.title` (group) + `style.group:true` | Group name as the conversation title + "Sender: msg" lines. |

---

## Key code

### Unread counts → summary header
```js
const COUNTS_KEY = `${STORE_PREFIX}__counts`;
const bumpCount  = async (chatId) => { const c = await loadCounts(); c[chatId] = (c[chatId]||0)+1; await saveCounts(c); return c; };
const clearCount = async (chatId) => { const c = await loadCounts(); delete c[chatId]; await saveCounts(c); };

const summaryText = (counts) => {
  const chats = Object.keys(counts).filter((id) => counts[id] > 0);
  const total = chats.reduce((s, id) => s + counts[id], 0);
  const msgs  = `${total} message${total === 1 ? '' : 's'}`;
  return chats.length <= 1 ? msgs : `${msgs} from ${chats.length} chats`;
};
```

### Conversation + per-sender avatars
```js
const convoAvatar = isGroup ? (data.groupAvatar || data.chatAvatar) : senderAvatar;
// android:
...(convoAvatar ? { largeIcon: convoAvatar, circularLargeIcon: true } : {}),
// style.messages[]:
person: { name, id, ...(m.avatar ? { icon: m.avatar } : {}) }
```

### Summary notification
```js
await notifee.displayNotification({
  id: GROUP_SUMMARY_ID,
  body: headerText,                 // "3 messages from 2 chats"
  android: { groupId: ANDROID_GROUP_KEY, groupSummary: true, subText: headerText, ... },
});
```

### Reset on read
`clearMessageNotification(chatId)` cancels `msg-<chatId>`, clears its stored lines,
and `clearCount(chatId)` so the summary tally drops that chat. When no `msg-*`
notifications remain, the summary is cancelled too.

---

## Hard requirements

1. **Backend MUST send message pushes DATA-ONLY** (no `notification` block). A
   `notification` block is drawn by the OS directly — it bypasses this grouping/
   threading/dedupe entirely and produces the **un-grouped duplicate** (sender-titled
   notifications next to the threaded ones). Put title/body/avatar/group fields under
   `data`.
2. **Group payloads should include `groupName`** (and `chatType:'group'` / `isGroup`).
   The client falls back to the local chat list (`ChatDatabase.getChatById`) if it's
   missing, but the payload is the reliable source.
3. **Avatars must be http(s) URLs** — notifee loads remote `largeIcon` / person
   `icon` on Android. Local/asset paths won't load in the headless handler.

---

## Edge cases
- **Single chat, many messages** → summary reads "5 messages" (no "from N chats").
  Android only shows the summary once 2+ children share the group anyway.
- **Avatar URL missing** → falls back to no avatar (notifee ignores undefined icon).
- **Group not in local cache + no `groupName`** → title falls back to sender (rare).
- **Stale lines (>6h)** are trimmed from the thread; the count is reset on read.
- **Killed/background handler** → all storage is AsyncStorage, SQLite import is lazy
  + crash-safe, so grouping works headless.

---

## Fixes log (must-keep)

### 1. Summary count uses `title`, NOT `subText`
**notifee has no `subText`/`subtitle` field** — setting it is silently ignored, so
"N messages from M chats" never rendered. The count now goes in the group summary's
**`title`** (which the COLLAPSED group header renders) plus an `InboxStyle.summary`
echo. Collapsed header → `TalksTry • 6 messages from 2 chats`.
> Limitation: the *expanded* group header can't show the count with notifee (that
> needs native `setSubText`, which notifee doesn't expose). Collapsed is correct.

```js
title: headerText,                       // "6 messages from 2 chats"
...(headerText && _consts?.AndroidStyle
  ? { style: { type: _consts.AndroidStyle.INBOX, lines: [headerText], summary: headerText } } : {}),
```

### 2. Group message also showing as a 1-to-1 → STABLE thread key
A group conversation was **fragmenting** into a second, sender-named notification
because the same message was keyed under different `chatId`s across pushes. Fix:
groups ALWAYS thread under their **`groupId`**:
```js
const threadKey = String(isGroup ? (data.groupId || chatId) : chatId);
// used for: loadMessages / saveMessages / bumpCount / notifee id `msg-${threadKey}`
```
Because the notification id is now the group id (not the caller's chatId),
`clearMessageNotification(id)` was made robust — it cancels `msg-<id>` AND any
displayed `msg-*` whose stored `data.chatId`/`data.groupId` matches, so opening the
chat still clears it.

> If a group message ALSO arrives as a genuinely separate push with a different
> `groupId` (or no group context at all), the client cannot know they're the same —
> that's a **backend duplicate-push** bug: a group message must be sent ONCE, with
> consistent `groupId`, and never also as a 1-to-1 push.

## Testing
1. Receive 2 messages in **chat A** + 1 in **chat B** (app backgrounded) → tray shows
   ONE summary "TalksTry • 3 messages from 2 chats", expandable to two threaded
   notifications.
2. Group message → title = **group name**, lines = **"Sender: message"** with sender
   avatars; conversation shows the group photo.
3. 1-1 message → title = **sender**, round sender avatar, no "Sender:" prefix.
4. Open chat A → its notification + count clear; summary updates to "1 message".
5. Confirm **no duplicate** un-threaded notification (verify the backend is data-only).

**JS-only — Metro reload, no rebuild.**
