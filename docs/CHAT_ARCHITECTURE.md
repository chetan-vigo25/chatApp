# Chat & Group Chat Architecture

How messaging works in this app: how messages are **sent**, **received**, **saved**, and **re-shown on the UI**, and how **chats** and **group chats** are managed.

This is a description of the *actual* code in this repo, with file references you can click.

---

## 1. The big picture

The app uses a **local-first, 3-layer architecture**. The UI never waits on the network — it reads from memory, falls back to a local database, and the network syncs in the background.

```
┌─────────────────────────────────────────────────────────────┐
│  UI  (ChatScreen.jsx, ChatList.jsx, GroupInfo.jsx)           │
│       renders from React state                               │
└───────────────▲─────────────────────────────────────────────┘
                │ state updates
┌───────────────┴─────────────────────────────────────────────┐
│  Logic  (useChatLogic.js  +  RealtimeChatContext.js)         │
│   - useChatLogic: per-open-chat state, send/load/paginate    │
│   - RealtimeChatContext: app-wide socket + chat-list state   │
└───────▲─────────────────────────▲───────────────────────────┘
        │ instant read/write       │ persist / query
┌───────┴───────────┐   ┌──────────┴──────────────────────────┐
│ ChatCache.js      │   │ ChatDatabase.js (SQLite, TalksTry.db)│
│ in-memory, sync   │   │ source of truth, indexed, queryable  │
│ 50 msgs/chat,     │   │ written through SqliteWriter (queue) │
│ 20 chats, LRU     │   └─────────────────────────────────────┘
└───────────────────┘
                │ network
┌───────────────┴─────────────────────────────────────────────┐
│  Socket.IO  (socket.js)  +  REST fallback (OutboxWorker.js)  │
└─────────────────────────────────────────────────────────────┘
```

**The three storage tiers:**

| Tier | File | Role | Speed |
|---|---|---|---|
| Memory cache | [ChatCache.js](../src/services/ChatCache.js) | Instant render; 50 msgs/chat, 20 chats, LRU eviction | Synchronous |
| SQLite | [ChatDatabase.js](../src/services/ChatDatabase.js) | Persistent source of truth, indexed, paginated | Async |
| Network | [socket.js](../src/Redux/Services/Socket/socket.js) | Realtime sync + acks | Async |

Media (images/audio/files) is tracked separately: metadata in AsyncStorage via [LocalStorageService.js](../src/services/LocalStorageService.js), actual files on disk via `expo-file-system`, downloads orchestrated by [MediaDownloadManager.js](../src/services/MediaDownloadManager.js).

---

## 2. How messages are saved (persistence)

### 2.1 Storage engine

- **SQLite** (`expo-sqlite`), DB file **`TalksTry.db`**, schema **version 10** with sequential migrations in [ChatDatabase.js](../src/services/ChatDatabase.js) `runMigrations()`.
- **AsyncStorage** is used only for **media metadata** (download status, local paths, thumbnails), not for chat text.

### 2.2 Key tables

| Table | Purpose | Notable columns |
|---|---|---|
| `messages` | every message | `id` (PK), `server_message_id`, `temp_id`, `client_message_id`, `chat_id`, `group_id`, `sender_id`, `text`, `type`, `status`, `timestamp`, `seq`, `reactions` (JSON), `delivered_to`/`read_by`/`seen_by` (JSON), `reply_*`, `media_*`, `is_edited`, `is_deleted`, `payload` (JSON) |
| `message_replies` | permanent copy of reply previews (survives row overwrites) | `message_id` (PK), `reply_to_message_id`, `reply_preview_text`, … |
| `chats` | the chat list | `chat_id` (PK), `chat_type`, `peer_user`/`group_data` (JSON), `last_message_*`, `unread_count`, `is_pinned`/`is_muted`/`is_archived`, `members`, `read_up_to_seq`, `delivered_up_to_seq` |
| `outbox` | durable pending-send queue with retry/backoff | `client_message_id` (PK), `payload`, `attempts`, `next_retry_at` |
| `reactions_v2` | per-user-per-message reactions | `(message_id, user_id)` PK |
| `sync_meta` | sync progress flags (e.g. `INITIAL_SYNC_COMPLETE`) | `key` (PK), `value` |

Indexes that matter: `idx_messages_chat_timestamp (chat_id, timestamp DESC)` powers pagination; unique partial indexes on `server_message_id` and `client_message_id` prevent duplicates.

### 2.3 Message identity & ordering

A message can be referenced by any of three IDs, checked in this precedence:

```
serverMessageId  >  id  >  tempId
```

- **`tempId`** (`temp_…`) — generated on the device the moment you hit send.
- **`serverMessageId`** — assigned by the backend; becomes the canonical `id` after acknowledgement.
- **`client_message_id`** — idempotency key so the same send is never stored twice.

**Ordering** is by `timestamp DESC` (milliseconds since epoch; higher = newer). The chat list orders by `is_pinned DESC, last_message_at DESC`.

### 2.4 Writes are serialized

All writes go through [SqliteWriter.js](../src/services/SqliteWriter.js), a FIFO queue with a single drainer. This prevents "database is locked" errors when bursts of realtime events (receipts, reactions, edits) hit at once. Callers can `await` for ordering or fire-and-forget.

### 2.5 Status lifecycle (and anti-downgrade)

Status priority (higher never overwritten by lower) — see `STATUS_PRIORITY` in [ChatDatabase.js](../src/services/ChatDatabase.js):

```
scheduled/processing/cancelled (0) < sending (1) < uploaded (2)
   < sent (3) < delivered (4) < seen/read (5)
```

`updateMessageStatus()` refuses to downgrade. For our own outgoing ticks against a peer, we also store **watermarks** (`read_up_to_seq`, `delivered_up_to_seq`) per chat so ticks render correctly even without per-message events.

### 2.6 Preserving local state on sync

When the server echoes a stale copy of a message, `_preserveLocalState()` keeps the local truth: a local **edit** isn't reverted, a local **delete** isn't un-deleted, a downloaded **local_uri** is kept, **reactions** prefer local, and status never downgrades.

---

## 3. How messages show on the UI again (rehydration)

When you open (or reopen) a chat, [useChatLogic.js](../src/contexts/useChatLogic.js) runs `loadMessagesFromLocal()`:

1. **Instant paint from memory** — if `ChatCache.hasMessages(chatId)`, render those immediately (zero async wait).
2. **One-time migration** — if SQLite has 0 messages for this chat but legacy AsyncStorage has some, import them into SQLite once.
3. **Load from SQLite** — `refreshMessagesFromDB()` calls `ChatDatabase.loadMessages(chatId, { limit: 50, offset })`, enriches reply data, splits out scheduled messages, and **merges** any in-flight optimistic messages that aren't in the DB yet.
4. **Sort newest-first** and write the enriched result back into `ChatCache`.

So reopening a chat is effectively free: memory → SQLite → (background) network. Nothing is lost because SQLite is the source of truth and `ChatCache` mirrors it.

### 3.1 Rendering (ChatScreen)

[ChatScreen.jsx](../src/screens/chats/ChatScreen.jsx) renders an **inverted `FlatList`** (newest at the bottom):

- `keyExtractor` → `getMessageKey()` (serverMessageId → id → tempId → …).
- `renderChatsItem()` branches by type: **text** (`renderRichMessageText`), **image/video/audio/file**, **location**, **contact**, **call** (`CallMessageBubble`), **system** (centered), **deleted** ("This message was deleted"), plus **reply quote** (`ReplyBubble`) and **status reply** previews.
- Performance: `initialNumToRender=15`, `maxToRenderPerBatch=10`, `windowSize=11`, `removeClippedSubviews` on Android, `maintainVisibleContentPosition` to avoid jumps when older pages load.
- **Pagination**: `onEndReached` → `loadMoreMessages()` loads the next 50 from SQLite first; only hits the network when local history is exhausted.

### 3.2 Date headers & ticks

- **Date separators** ("TODAY", "YESTERDAY", "25 JUNE 2026") are computed per message; a **floating sticky date badge** updates from `onViewableItemsChanged` while scrolling.
- **Read-receipt ticks** on your own messages: single ✓ (sent), double ✓✓ grey (delivered), double ✓✓ blue `#53BDEB` (seen), alert (failed → tap to resend).

---

## 4. How chats are handled (realtime)

App-wide realtime lives in [RealtimeChatContext.js](../src/contexts/RealtimeChatContext.js) (provider mounted near the app root), backed by the socket in [socket.js](../src/Redux/Services/Socket/socket.js).

### 4.1 Connection

`initSocket()` connects Socket.IO with `auth: { token, deviceId, deviceInfo }`, auto-reconnect (10 attempts, backoff). On token expiry it emits `reauthenticate` and reconnects with a fresh token. Connection status is observable via `subscribeSocketState()`.

### 4.2 Sending a message (optimistic)

`handleSendText()` → `sendMessageViaSocket()` in [useChatLogic.js](../src/contexts/useChatLogic.js):

```
1. Make a tempId, build the message object
2. Show it instantly  → ChatCache.addMessage() + setAllMessages()
3. Update chat-list preview  → OUTGOING_MESSAGE dispatch
4. Persist to SQLite (background)
5. Mark status 'sent' optimistically (WhatsApp-style)
6. Emit the right event:
      message:send        (1:1)
      message:reply / message:quote   (with reply context)
      group:message:send  (group)
7. On server ACK { data: { messageId, clientMessageId } }:
      reconcile tempId → serverMessageId
      ChatDatabase.acknowledgeMessage(tempId, serverMessageId)
```

If the socket is **offline**, the emit is queued (short-term `pendingEmitQueue`, max 200) and/or persisted to the **`outbox`** table; [OutboxWorker.js](../src/services/OutboxWorker.js) retries via REST with exponential backoff (2s → 30m).

### 4.3 Receiving a message

On `message:new` / `message:received` (and `group:message:new`), `RealtimeChatContext` normalizes the payload, then:

```
- Persist: ChatDatabase.upsertMessage() (+ saveReplyData, updateChatLastMessage, incrementChatUnread)
- Update Redux chat-list state (INCOMING_MESSAGE / INCOMING_GROUP_MESSAGE)
- Emit a delivery receipt — app-wide, even if the chat screen isn't open
- If the chat is open, useChatLogic re-reads from the DB (debounced) and the UI updates
```

Delivery receipts are **deduped** (`deliveredEmittedRef`) so each message is acked once.

### 4.4 Receipts: delivered vs seen

- **Delivered** (✓✓ grey): emitted automatically when a message reaches the device (`message:delivered` / `group:message:delivered`).
- **Seen** (✓✓ blue): emitted when messages are actually **visible** on screen. `onViewableItemsChanged` feeds `markVisibleIncomingAsRead()` (500 ms debounce) which emits `message:read`/`message:seen` (or `group:message:read`) and locally upgrades status to `seen`. Opening a chat also clears unread via `message:read:all` / `group:message:read:all`.

### 4.5 The chat list stays in sync

The backend pushes a single multiplexed event **`chat:list:update`** with a `reason` (`message.created`, `message.edited`, `message.deleted`, `message.read`, `chat.pinned`, `typing.started`, `presence.changed`, …). `RealtimeChatContext` normalizes the reason → type and applies it. Updates are **batched in a ~90 ms window** to avoid render storms, **except the active chat**, which flushes instantly.

The list itself is built in [ChatList.jsx](../src/screens/chats/ChatList.jsx) from the realtime list (deduped by peer), showing last-message preview, unread badge, typing state, and pin/mute/archive flags.

### 4.6 Other realtime features

- **Typing**: `typing:start`/`stop` (and `group:typing:*`), auto-cleared after a 10s TTL.
- **Presence**: `presence:subscribe`/`presence:fetch` → `presence:update` / `user:online` / `user:offline`.
- **Edit**: `message:edit` → broadcast `message:edited`; sets `is_edited`, shows "(edited)".
- **Delete**: `message:delete:me` (local only) or `message:delete:everyone` (broadcast `…:deleted`); deleted rows become a system placeholder.
- **Reactions**: `message:reaction:add`/`remove` (and `group:message:reaction`); stored as `{ emoji: { count, users[] } }`, one reaction per user, optimistic + server-authoritative on ack.
- **Scheduled messages**: `message:schedule` / `message:cancel:scheduled` (+ group variants).

---

## 5. Group chats

Groups reuse all of the above; the differences:

### 5.1 Identity & sending

- A group chat has `chatType === 'group'` (and a `groupId`).
- Group sends use `group:message:send` with `groupId` set and `receiverId: null`; 1:1 sends use `message:send` with `receiverId`.
- Each message carries `senderId`/`senderName`; the UI resolves the display name (saved contact → backend name) and gives each sender a **distinct color**, shown above their bubbles.

### 5.2 Membership & roles

Data model: a group has `name`, `avatar`, `description`, and `members[]` with roles (`owner` / `admin` / `member`), capped at 100 members.

- **Create**: [CreateGroup.jsx](../src/screens/group/CreateGroup.jsx) (pick members → name/description) → `createGroup` thunk → `POST user/group/create`.
- **View / sync**: [GroupInfo.jsx](../src/screens/group/GroupInfo.jsx) → `viewGroup({ groupId })`; re-fetches on member/profile/contact change.
- **Add / remove**: `group:member:add` / `group:member:remove` (and `removeMember` thunk). Owner can't be removed.
- **Promote / demote / mute**: `group:member:promote` / `…:demote` / `…:muted`.
- **Transfer ownership**: `transferOwnership({ groupId, newOwnerId })` → `POST user/group/transfer-owner` (owner only).
- **Send restrictions**: if admins-only messaging is on, non-admins are blocked in the composer.

### 5.3 Group realtime events

Membership: `group:member:joined|left|added|removed|promoted|demoted|muted|unmuted`.
Lifecycle: `group:joined`, `group:left`, `group:removed` (kicked → `GROUP_MEMBERSHIP_ENDED`, blocks send/receive), `group:deleted`.
Metadata: `group:name:updated`, `group:avatar:updated`, `group:description:updated`, `group:settings:updated`.
Prefs: `group:muted|unmuted|pinned|unpinned|archived|unarchived:success`.

### 5.4 Mentions

`@username` is handled by [MentionInput.jsx](../src/components/MentionInput.jsx): typing `@` opens a suggestion list from group members; selection records `{ userId, displayName, startIndex, length }`; on send the `mentions[]` array is attached to the payload; in the bubble, mentions are color-highlighted.

---

## 6. End-to-end flows (quick reference)

**Send (you):**
```
type → tempId → optimistic UI + cache → SQLite → emit (socket) →
  online:  ACK → reconcile tempId→serverId → acknowledgeMessage()
  offline: pendingEmitQueue / outbox → OutboxWorker retries via REST
```

**Receive (peer):**
```
socket message:new → normalize → upsertMessage() + updateChatLastMessage()
  → INCOMING_MESSAGE (chat list) → emit delivered (app-wide)
  → if chat open: re-read DB → UI updates → on-screen → emit seen
```

**Open a chat:**
```
ChatCache (instant) → SQLite loadMessages(50) → merge optimistic → render
  → scroll up → loadMoreMessages() (SQLite first, then network)
```

---

## 7. File map

| Area | File |
|---|---|
| Per-chat logic, send/load/paginate, reactions, edit/delete, read receipts | [src/contexts/useChatLogic.js](../src/contexts/useChatLogic.js) |
| App-wide socket, chat-list state, incoming messages, receipts, presence | [src/contexts/RealtimeChatContext.js](../src/contexts/RealtimeChatContext.js) |
| Socket connection / auth / reconnect / offline queue | [src/Redux/Services/Socket/socket.js](../src/Redux/Services/Socket/socket.js) |
| SQLite schema, migrations, all message/chat CRUD | [src/services/ChatDatabase.js](../src/services/ChatDatabase.js) |
| In-memory cache (instant render) | [src/services/ChatCache.js](../src/services/ChatCache.js) |
| Serialized write queue | [src/services/SqliteWriter.js](../src/services/SqliteWriter.js) |
| Durable send-retry queue (REST) | [src/services/OutboxWorker.js](../src/services/OutboxWorker.js) |
| Media metadata + files | [src/services/LocalStorageService.js](../src/services/LocalStorageService.js) |
| Media download orchestration | [src/services/MediaDownloadManager.js](../src/services/MediaDownloadManager.js) |
| Chat UI (message list, bubbles, ticks, dates) | [src/screens/chats/ChatScreen.jsx](../src/screens/chats/ChatScreen.jsx) |
| Conversation list | [src/screens/chats/ChatList.jsx](../src/screens/chats/ChatList.jsx) |
| Group create / info / members | [src/screens/group/](../src/screens/group/) |
| Mentions | [src/components/MentionInput.jsx](../src/components/MentionInput.jsx) |

> Note: socket **event names** and a few payload shapes are inferred from the client emitters/listeners. If you also own the backend, treat the client as the contract and keep both sides in sync.
