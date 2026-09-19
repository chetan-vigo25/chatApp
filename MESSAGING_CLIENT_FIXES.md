# Messaging pipeline — client fixes (REQUIRED)

**Audience:** the React Native app team working in this repo.

Companion doc: `MESSAGING_BACKEND_SPEC.md` (server-side work). A few items here
are **blocked on** that doc and are marked ⛓️.

Every item below cites an exact file and line. Line numbers are as of commit
`9e0124d`.

---

## Priority summary

| # | Item | Severity | File |
|---|---|---|---|
| 1 | `deduplicateChat` rule #4 deletes real messages | **CRITICAL** | `src/services/ChatDatabase.js:2619` |
| 2 | Secrets committed to a public repo | **CRITICAL** | `credentials.json`, `.env` |
| 3 | Reply-ack single-slot race | **HIGH** | `src/contexts/useChatLogic.js:680` |
| 4 | Debug logging on in production | **HIGH** | 3 files |
| 5 | Outbox 4s grace causes duplicate sends | **HIGH** | `src/contexts/useChatLogic.js:7111` |
| 6 | Fingerprint gate misses edits + reaction counts | **HIGH** | `src/contexts/useChatLogic.js:1716` |
| 7 | Unbounded display window → O(N) work per event | **HIGH** | `src/contexts/useChatLogic.js:3169` |
| 8 | Non-transitive sort comparator | **HIGH** | `src/contexts/useChatLogic.js:7973` |
| 9 | One SQLite connection opened per message | **HIGH** | `src/services/ChatDatabase.js:1293` |
| 10 | No `busy_timeout` on the transaction handle | **HIGH** | `src/services/ChatDatabase.js:1303` |
| 11 | Tokens in plaintext AsyncStorage | **HIGH** | `socket.js`, `Https.js` |
| 12 | Accept server `unreadCount` on hydrate | MEDIUM ⛓️ | `src/contexts/RealtimeChatContext.js:918` |
| 13 | `messageExists`/`getMessage` full-scan | MEDIUM | `src/services/ChatDatabase.js:1943` |
| 14 | Catch-up does 2 async ops per chat | MEDIUM | `src/contexts/RealtimeChatContext.js:3885` |
| 15 | Message row not memoized | MEDIUM | `src/screens/chats/ChatScreen.jsx:8234` |
| 16 | Stale closure in `refreshMessagesFromDB` | MEDIUM | `src/contexts/useChatLogic.js:3135` |
| 17 | `handledMsgIds` Set unbounded | MEDIUM | `src/contexts/useChatLogic.js:5079` |
| 18 | `_preserveLocalState` content-agnostic delete | MEDIUM | `src/services/ChatDatabase.js:1770` |
| 19 | No test suite | MEDIUM | — |
| 20 | Local DB unencrypted | MEDIUM | `src/services/ChatDatabase.js` |

---

# P0 — Launch blockers

## 1. `deduplicateChat` rule #4 permanently deletes genuine messages

**CRITICAL — this is happening to real users today.**

**Location:** `src/services/ChatDatabase.js:2619-2627`

```sql
-- 4. Remove any remaining content duplicates (same sender + text within 30s)
DELETE FROM messages WHERE chat_id = $c AND type = 'text' AND rowid NOT IN (
  SELECT MAX(rowid) FROM messages WHERE chat_id = $c AND type = 'text'
  GROUP BY sender_id, text, CAST(timestamp / 30000 AS INTEGER)
)
```

**What it does:** groups on *sender + exact text + 30-second bucket* and keeps
only `MAX(rowid)`. Two **genuine** messages — "ok" at 10:00:05 and "ok" at
10:00:20 — land in the same bucket, so **one is permanently deleted from
SQLite**.

**Why it's live:** `deduplicateChat()` runs on **every chat open**
(`src/contexts/useChatLogic.js:2344`). Repeating "ok" / "hi" / "haan" / "?" /
"👍" is normal conversation.

**Why it's unrecoverable:** the message still exists on the server, but the
`seq` sync cursor has already advanced past it, so no delta sync will bring it
back. Silent, permanent, daily.

**Note:** the equivalent in-memory guard was already fixed correctly — see the
`fpMap` logic at `src/contexts/useChatLogic.js:1696`, which only suppresses a
clash when one side is optimistic or the timestamps are identical. This SQL rule
was missed.

**Fix:** delete rule #4 entirely. Rules #2 (`temp_id` link) and #5
(`client_message_id` bridge) already dedupe on exact idempotency keys — the
content heuristic is not needed. If it must be kept, scope it so it can never
touch a confirmed row:

```sql
DELETE FROM messages
 WHERE chat_id = $c AND type = 'text'
   AND server_message_id IS NULL          -- unconfirmed only
   AND client_message_id IS NOT NULL      -- must have a real idempotency key
   AND rowid NOT IN (
     SELECT MAX(rowid) FROM messages
      WHERE chat_id = $c AND type = 'text' AND client_message_id IS NOT NULL
      GROUP BY sender_id, client_message_id     -- exact key, not content
   )
```

**Also fix the same class at `src/services/ChatDatabase.js:1091-1098`**
(`cleanBeforeUpsert` rule #4) — the 30s content match there can delete a second
genuine offline-composed message when the first one syncs. Recoverable via the
outbox, but it causes a visible disappear-then-reappear flicker and an ordering
change.

**Regression test to add:** send two identical texts 8s apart, close and reopen
the chat, assert both still render.

---

## 2. Secrets committed to a public repo

**CRITICAL.**

**Location:** `credentials.json`, `.env` — both tracked by git.
Remote: `https://github.com/chetan-vigo25/chatApp.git`

```
credentials.json → android.keystore.{keystorePath, keystorePassword,
                                     keyAlias, keyPassword}
.env            → SALT_SECRET, CONTACT_SALT, BACKEND_URL, SOCKET_URL,
                  REACT_APP_FIREBASE_PROJECT_ID, REACT_APP_FIREBASE_APP_ID
```

`.gitignore:34` only covers `.env*.local`, not plain `.env`.

**Impact:** the Android release keystore password is exposed. `CONTACT_SALT` is
the secret behind `hashPhoneForMatch` — leaking it makes the contact-matching
hashes reversible, which is a user-privacy breach, not just a build concern.

**Fix — all four steps, in order:**

1. **Rotate everything.** Treat the keystore and both salts as compromised. If
   the app is not yet published, generate a new keystore now. If it is,
   follow Play Console key-rotation.
2. **Purge from history** — deleting the file is not enough:
   ```
   git filter-repo --path credentials.json --path .env --invert-paths
   ```
   (or make the repo private and start a fresh history)
3. **Add to `.gitignore`:**
   ```
   .env
   credentials.json
   ```
4. **Move to EAS Secrets / CI environment variables.**

---

## 3. Reply-ack single-slot race

**HIGH.**

**Location:**
- `src/contexts/useChatLogic.js:680` — `const pendingReplyTempIdRef = useRef(null);`
- `src/contexts/useChatLogic.js:6804` — set on send
- `src/contexts/useChatLogic.js:4812-4813` — consumed on response

```js
// send:
if (sendEvent === 'message:reply' || sendEvent === 'message:quote') {
  pendingReplyTempIdRef.current = tempId;        // single slot — overwrites
}
// response:
const tempId = source?.tempId || pendingReplyTempIdRef.current;
if (tempId) pendingReplyTempIdRef.current = null;
```

**Failure:** two replies sent ~200ms apart. `pendingRef` holds `tempR1`, then is
overwritten with `tempR2`. R1's response arrives carrying no `clientMessageId`
(the code comment at `:4811` confirms: *"Server responses for reply/quote don't
include tempId"*), so the client applies **R1's serverMessageId to R2's bubble**.

Consequences:
- R1 stays on the "sending" clock forever
- R2 now carries R1's server id → every later reply / react / edit / delete on
  R2 targets the wrong message server-side

**Fix (client, do now):** replace the single ref with a FIFO queue so responses
match sends in emit order:

```js
const pendingReplyTempIdsRef = useRef([]);
// send:    pendingReplyTempIdsRef.current.push(tempId);
// response: const tempId = source?.clientMessageId || source?.tempId
//                        || pendingReplyTempIdsRef.current.shift();
```

**Permanent fix ⛓️:** `MESSAGING_BACKEND_SPEC.md` §2 — server echoes
`clientMessageId` in `message:reply:response` and `message:quote:response`. Once
that ships, drop the ref entirely.

---

## 4. Debug logging enabled in production

**HIGH.**

**Location:**
- `src/contexts/useChatLogic.js:123` — `const DEBUG_CHAT_SOURCE = true;`
- `src/contexts/RealtimeChatContext.js:119` — `const DEBUG_MSG_STORE = true;`
- `src/screens/chats/ChatList.jsx:67` — `const DEBUG_CHAT_SOURCE = true;`

`RealtimeChatContext.js:2884` logs the **full payload including message text** on
every incoming message:

```js
dlog('⬇️ new message from server', { rawPayload: payload, ..., text: source?.text });
```

Plus 60 raw `console.log` in `useChatLogic.js` and 17 in
`RealtimeChatContext.js`.

**Impact:** message content written to logcat on every message; plus JS-bridge
serialization cost per message on the hot path.

**Fix:**
```js
const DEBUG_MSG_STORE = __DEV__ && false;
```
and add `babel-plugin-transform-remove-console` to the production preset in
`babel.config.js`.

---

## 5. Outbox 4-second grace causes duplicate sends

**HIGH.**

**Location:** `src/contexts/useChatLogic.js:7111`

```js
ChatDatabase.outboxEnqueue({
  clientMessageId: tempId,
  chatId: chatIdRef.current,
  payload: outboxPayload,
  notBefore: Date.now() + 4000,      // ← too short
});
```

**Failure:** the socket ack timeout is **12s**
(`src/services/OutboxWorker.js:39` — `SOCKET_ACK_TIMEOUT_MS = 12000`), but the
outbox fires a REST re-send at **4s**. On a congested network the server
receives the same message twice.

**Fix:** `notBefore: Date.now() + 20000` — the grace must exceed the socket ack
timeout.

**Note ⛓️:** this narrows the window; it does not close it. A network timeout on
REST is indistinguishable from a rejection on the client. The real fix is
`MESSAGING_BACKEND_SPEC.md` §1 (server-side idempotency).

---

## 6. Fingerprint gate misses edits and reaction counts

**HIGH.**

**Location:** `src/contexts/useChatLogic.js:1716` and the gate at `:1726-1728`

```js
const base = `${m.serverMessageId||m.id||m.tempId}:${m.status}:${m.isEdited?1:0}`
           + `:${m.isDeleted?1:0}:${m.reactions?Object.keys(m.reactions).join(','):''}${voFp}`;
...
if (fingerprint === lastMessagesFingerprintRef.current
  && paintedMessagesLenRef.current === deduped.length) return;   // setMessages SKIPPED
```

Two gaps:

1. **`text` is not in the fingerprint.** The first edit flips `isEdited` 0→1 so
   it repaints. A **second edit** of the same message leaves `isEdited` at 1 and
   only changes text → identical fingerprint → `setMessages` skipped → **the UI
   keeps showing the old text** while SQLite holds the new one.

2. **Reactions are fingerprinted by key only.** The shape is
   `{ '👍': { count, users } }`. When another user adds the **same** emoji the
   key set is unchanged → identical fingerprint → **the count never updates on
   screen**.

**Fix:**
```js
const rx = m.reactions
  ? Object.entries(m.reactions)
      .map(([k, v]) => `${k}${v?.count ?? 0}`)
      .sort()
      .join(',')
  : '';
const base = `${m.serverMessageId||m.id||m.tempId}:${m.status}`
           + `:${m.isEdited?1:0}:${m.isDeleted?1:0}:${rx}`
           + `:${(m.text||'').length}:${m.editedAt||''}${voFp}`;
```

---

# P1 — Immediately after launch

## 7. Unbounded display window → O(N) work on every realtime event

**HIGH — the single biggest performance problem.**

**Location:**
- `src/contexts/useChatLogic.js:10860` — the window only ever grows:
  ```js
  loadedLimitRef.current = Math.max(loadedLimitRef.current || 0, merged.length);
  ```
- `src/contexts/useChatLogic.js:3169-3175` — every refresh re-reads the whole
  window:
  ```js
  const fullLimit = Math.max(INITIAL_PAGE_SIZE,
                             loadedLimitRef.current || 0,
                             allMessagesRef.current?.length || 0);
  ```

`refreshMessagesFromDB` has **30+ call sites**: every incoming message, every
delivery receipt, every seen receipt, every reaction, every edit, plus the
`chat:thread:update` bridge at `:3655`.

**Failure:** the user scrolls back 40 pages → 2000 messages loaded. Now **every
single incoming message** triggers:

1. `SELECT * ... ORDER BY timestamp DESC LIMIT 2000`
2. 2000 × `rowToMsg()` + `JSON.parse(payload)`
3. ~30 batched `message_replies` IN-queries (6000 ids / 200 per batch)
4. 2000-element enrichment `.map()`
5. `setAllMessages` → 2000-element Map build + merge + sort
6. display effect → filter + `dropAlternateIdTwins` + dedup + 2000-element
   fingerprint string join
7. `ChatCache.mergeMessages` → another 2000-element map

In a busy group (5 msg/sec) this saturates the JS thread. On mid-range Android
the app freezes.

**Fix — two parts:**

**(a) Cap the window.** `src/contexts/useChatLogic.js:3169`:
```js
const MAX_WINDOW = 300;
const fullLimit = Math.min(
  MAX_WINDOW,
  Math.max(INITIAL_PAGE_SIZE, loadedLimitRef.current || 0, allMessagesRef.current?.length || 0),
);
```
Trim `allMessages` to the cap when scrolling back down. WhatsApp does exactly
this — the window shrinks once you return to the bottom.

**(b) Add a tail-only refresh mode.** Realtime events must not re-read the whole
window. Add `refreshMessagesFromDB(immediate, { tailOnly: true })` that reads
only `afterTimestamp = newest_displayed_timestamp` and prepends. Reserve the
full re-read for chat-open and explicit reconcile.

---

## 8. Non-transitive sort comparator

**HIGH.**

**Location:** `src/contexts/useChatLogic.js:7973-7979`

```js
merged.sort((a, b) => {
  const aSeq = typeof a.seq === 'number' ? a.seq : null;
  const bSeq = typeof b.seq === 'number' ? b.seq : null;
  if (aSeq != null && bSeq != null) return bSeq - aSeq;
  return (b.timestamp || 0) - (a.timestamp || 0);
});
```

When the list mixes seq'd and non-seq'd rows (optimistic sends have no `seq`;
legacy rows have none), the comparator is **not transitive**:

```
A(seq=5, ts=100)   B(seq=null, ts=200)   C(seq=3, ts=300)
A vs C → seq → A before C
B vs A → ts  → B before A
C vs B → ts  → C before B
⇒ B < A < C < B      (cycle)
```

An inconsistent comparator gives TimSort **undefined** output that can vary
between runs.

Today the final render is saved only because the display effect at
`src/contexts/useChatLogic.js:1664` re-sorts by pure timestamp — i.e. **`seq` is
not used for display order at all**, which is its own problem (see below).

**Fix — make it transitive:**
```js
merged.sort((a, b) => {
  const sa = typeof a.seq === 'number' ? a.seq : null;
  const sb = typeof b.seq === 'number' ? b.seq : null;
  if (sa != null && sb != null) return sb - sa;
  if (sa != null) return -1;       // seq'd rows rank ahead, consistently
  if (sb != null) return 1;
  return (b.timestamp || 0) - (a.timestamp || 0);
});
```

**Then ⛓️ (after `MESSAGING_BACKEND_SPEC.md` §3):** make the display sort at
`:1664` seq-primary too. Ordering currently depends on the sending **device's
clock** — a phone 10 minutes fast pins its own messages above the peer's newer
ones. Also make `acknowledgeMessage` (`src/services/ChatDatabase.js:2012`) write
the server's `createdAt`/`seq` onto the row; today it only updates `id`,
`server_message_id`, `synced` and `status`.

---

## 9. One native SQLite connection opened per message

**HIGH.**

**Location:** `src/services/ChatDatabase.js:1293` (`upsertMessages`) →
`withExclusiveTransactionAsync`

Verified against `node_modules/expo-sqlite/build/SQLiteDatabase.js:510-516`:

```js
class Transaction extends SQLiteDatabase {
  static async createAsync(db) {
    const options = { ...db.options, useNewConnection: true };
    const nativeDatabase = new ExpoSQLite.NativeDatabase(db.databasePath, ...);
    await nativeDatabase.initAsync();     // ← a NEW native connection, every call
```

Because `upsertMessage(msg)` delegates to `upsertMessages([msg])`, **every single
realtime message opens, BEGINs, writes, COMMITs and closes its own native SQLite
connection.** At 20 msg/sec in a busy group that is 20 connection open/close
cycles per second.

**Two code comments are also factually wrong** and should be corrected:
`src/services/ChatDatabase.js:1240` and `:1305` both claim
`withExclusiveTransactionAsync` *"queues all other DB access for the
transaction's duration"*. It does not — it runs on a separate connection. The
actual protection comes from the `runExclusive` FIFO mutex, which is fine, but
the stated rationale is incorrect.

**Fix:** coalesce realtime writes in `src/services/SqliteWriter.js` — collect
`upsertMessage` jobs over a ~100ms window and flush them as a single
`upsertMessages(batch)`. The FIFO queue is already there; only batching is
missing.

---

## 10. No `busy_timeout` on the transaction handle

**HIGH.**

**Location:** `src/services/ChatDatabase.js:1303`

All PRAGMAs are applied in `_initDB` (`src/services/ChatDatabase.js:394-408`) —
i.e. on `_db` only. The `Transaction` connection created per batch opens with the
SQLite default `busy_timeout = 0`, so any contention returns `SQLITE_BUSY`
**immediately**.

This is why the codebase is full of retry loops, `isTransientLockError`,
exponential backoff and "database is locked" warnings.

**Fix:**
```js
await db.withExclusiveTransactionAsync(async (tx) => {
  try { await tx.execAsync('PRAGMA busy_timeout = 10000;'); } catch {}
  await _runUpsertBatch(tx, messages);
});
```

---

## 11. Tokens stored in plaintext AsyncStorage

**HIGH.**

**Location:**
- `src/Redux/Services/Socket/socket.js:48-54` — `STORAGE_KEYS`
- `src/Config/Https.js:72` — `await AsyncStorage.getItem("accessToken")`

`accessToken` and `refreshToken` live in AsyncStorage, which is unencrypted.

**Fix:** move both to `expo-secure-store` (already a dependency —
`package.json:52`; Keychain on iOS, Keystore on Android). Add the new keys to
`src/utils/freshInstallSweep.js` so a reinstall clears them.

---

## 12. Accept the server's `unreadCount` on hydrate ⛓️

**MEDIUM — blocked on `MESSAGING_BACKEND_SPEC.md` §4.**

**Location:** `src/contexts/RealtimeChatContext.js:918-919`, in `HYDRATE_CHATS`:

```js
const prevUnread = state.unreadByChat[chatId];
const unreadCount = typeof prevUnread === 'number'
  ? prevUnread                          // ← local always wins
  : Number(chat?.unreadCount || 0);
```

Combined with the blind `+1` at `:1357` and the 1000-entry dedupe cap
(`handledPrivateMsgIdsRef`, `:3030`), a duplicate `message:new` after a reconnect
replay inflates the count — and because hydrate prefers the local value, it
**never self-corrects**. Permanent phantom badge.

**Fix (once the server sends a trustworthy value):** prefer the server value in
`HYDRATE_CHATS`, exactly as `CHAT_LIST_UPDATE` already does at `:1826-1827`. Keep
the local `+1` as optimistic UI only, replaced on the next server value.

---

## 13. `messageExists` / `getMessage` do a full table scan

**MEDIUM.**

**Location:** `src/services/ChatDatabase.js:1943` and `:2005`

```sql
WHERE id = $id OR server_message_id = $id OR temp_id = $id
```

SQLite rarely applies multi-index optimization to an OR across three columns, so
this usually degrades to a full scan. Both are called **per incoming message**
inside `handleReceivedMessage` (`src/contexts/useChatLogic.js:7720`), and the
`sentTempIdsRef` loop above it calls `messageExists` once **per pending temp
id**.

**Fix:**
```sql
SELECT * FROM messages WHERE id = $id
UNION ALL SELECT * FROM messages WHERE server_message_id = $id
UNION ALL SELECT * FROM messages WHERE temp_id = $id
LIMIT 1
```
Each branch then uses its own index.

---

## 14. Reconnect catch-up does two async ops per chat

**MEDIUM.**

**Location:** `src/contexts/RealtimeChatContext.js:3885-3893`

```js
const entries = await Promise.all(knownChatIds.map(async (chatId) => {
  const lastSeq = await ChatDatabase.getLatestSeq(chatId);   // SQLite MAX(seq)
  const mutatedSince = await _getMutationCursor(chatId);     // AsyncStorage read
  ...
}));
```

With 1000 chats: **1000 SQLite queries + 1000 AsyncStorage reads**, on every
reconnect *and* every background→foreground transition. Flaky connectivity turns
this into a repeating storm.

**Fix:**
```js
// one query instead of N
SELECT chat_id, MAX(seq) AS last_seq
  FROM messages WHERE seq IS NOT NULL GROUP BY chat_id
```
and store all mutation cursors in **one** AsyncStorage key as a JSON map instead
of `chat_mutation_cursor_<chatId>` per chat
(`src/contexts/RealtimeChatContext.js:36`).

---

## 15. Message row is not a memoized component

**MEDIUM.**

**Location:** `src/screens/chats/ChatScreen.jsx:8234` (`renderItem={renderChatsItem}`)

The code's own comment at `:8253-8258` states the problem:

> *"renderChatsItem builds a message bubble inline (media tiles, reply quote,
> reactions, status ticks) rather than rendering a memoized row component, so
> each row is expensive and the initial batch is rendered SYNCHRONOUSLY."*

That is why `initialNumToRender` had to be lowered from 15 to 8. Combined with
item 7, this is the main source of scroll jank.

**Fix:** extract the body into `const MessageRow = React.memo(function MessageRow({...}) {...})`.
The pattern is already correct in `src/screens/chats/ChatList.jsx:308`
(`ChatListRow = memo(...)`) — mirror it.

---

## 16. Stale closure in `refreshMessagesFromDB`

**MEDIUM.**

**Location:** `src/contexts/useChatLogic.js:3135` — `useCallback(..., [])`

The body reads `chatData?.peerUser?.fullName`, `isGroupChat`,
`groupMembersMapRef`, `markMediaFailed` and `queuedMediaUploadsRef`, but the
dependency array is empty. `chatData` and `isGroupChat` are frozen at first
render.

**Impact:** if the peer/group name resolves *after* init (the background
`viewGroup` fetch at `:2114`), reply-preview sender names stay blank.

**Fix:** mirror those values into refs (the file already does this for
`currentUserIdRef`, `currentUserNameRef`, `amNotGroupMemberRef`).

---

## 17. `handledMsgIds` Set is unbounded

**MEDIUM.**

**Location:** `src/contexts/useChatLogic.js:5079` — `const handledMsgIds = new Set();`

Created inside `setupSocketListeners`, never pruned. Every message id seen while
the chat is open accumulates for the lifetime of the listener set.

The equivalents in `RealtimeChatContext.js` are capped (`handledPrivateMsgIdsRef`
at 1000, `handledGroupMsgIdsRef` and `deliveredEmittedRef` at 2000). This one
isn't.

**Fix:** apply the same cap-and-evict pattern.

---

## 18. `_preserveLocalState` content-agnostic delete

**MEDIUM.**

**Location:** `src/services/ChatDatabase.js:1770-1782`

```sql
SELECT * FROM messages
 WHERE chat_id = $cid AND sender_id = $sid AND id LIKE 'temp_%'
   AND type = 'text' AND ABS(timestamp - $ts) < 5000
 ORDER BY is_edited DESC LIMIT 1
-- then: DELETE FROM messages WHERE id = existing.id
```

There is **no content match** — only sender + a ±5s window, and `ORDER BY
is_edited DESC` is not deterministic across the rest of the columns. Two
different offline-composed texts 3s apart can be matched to each other, and the
wrong one is deleted.

The outbox re-sends it, so this is recoverable — but it produces a visible
disappear-then-reappear flicker and an ordering change.

**Fix:** add `AND text = $text`, or gate the whole fallback on
`msg.clientMessageId` being present and matching.

---

# P2 — Quality and scale

## 19. No test suite

125k lines, 13 layered dedup rules across two files, 30+ refresh triggers, zero
tests.

**Minimum to add:**
- `ChatDatabase` dedup rules — **including** "two genuine same-text messages
  survive `deduplicateChat`", which fails today (item 1)
- `acknowledgeMessage` temp→server transition, including the
  already-delivered-status case
- the display-effect dedup + fingerprint gate (items 6 and 8)
- outbox drain + ack + removal

## 20. Local database is unencrypted

`TalksTry.db` stores all message content in plaintext. Move to a
SQLCipher-backed build with the key held in `expo-secure-store`.

## 21. Smaller items

| Item | Location | Fix |
|---|---|---|
| Legacy AsyncStorage restore runs on every chat open | `src/contexts/useChatLogic.js:2295-2330` | One-time flag in `sync_meta`, then delete the key |
| `deduplicateChat` rule #1 is dead code | `src/services/ChatDatabase.js:2600` | `GROUP BY id` on a PRIMARY KEY can never find a duplicate — remove |
| `findPendingRowByMediaId` can't use an index | `src/services/ChatDatabase.js:1984` | `ORDER BY ABS(timestamp - $ts)` — add a `(chat_id, media_id)` composite index |
| `globalActiveMediaUploads` leak blocks retry forever | `src/contexts/useChatLogic.js:162` | Module-level `Set`; if an upload dies without cleanup the tempId is "active" permanently. Store timestamps + sweep on a TTL |
| No out-of-order stash for reactions/deletes | `src/contexts/useChatLogic.js:5508` | `registerPendingEdit` exists for edits only. A reaction arriving before its message is dropped silently — apply the same pattern |
| `chat:thread:update` causes a triple refresh | `src/contexts/useChatLogic.js:3655` | One incoming message fires ≥3 refresh triggers; 50ms debounce coalesces them but each still does a full window read. Tag the event with its origin and dedupe by source |
| `handleSendText` has an unused dependency | `src/contexts/useChatLogic.js:7128` | `refreshMessagesFromDB` is in the deps but not used in the body |
| `ChatCache` caps messages at 50 | `src/services/ChatCache.js:19` | Reopening a chat after paging resets the window to 50. Derive the cap from the last displayed window |

---

# Rollout order

```
P0 — before launch
 ├── 1. remove deduplicateChat rule #4              (data loss, live today)
 ├── 2. rotate secrets + purge git history
 ├── 3. reply-ack FIFO queue
 ├── 4. turn off debug logging
 ├── 5. outbox grace 4s → 20s
 └── 6. fingerprint: add text + reaction counts

P1 — immediately after
 ├── 7.  cap the display window + tail-only refresh   (biggest perf win)
 ├── 8.  fix the sort comparator
 ├── 9.  batch realtime SQLite writes
 ├── 10. busy_timeout on the transaction handle
 ├── 11. tokens → expo-secure-store
 └── 12. accept server unreadCount              ⛓️ needs backend §4

P2 — quality / scale
 └── 13-21
```

## Items blocked on the backend ⛓️

| Client item | Needs |
|---|---|
| 3 — drop the reply-ack workaround entirely | `MESSAGING_BACKEND_SPEC.md` §2 |
| 5 — real duplicate-send safety | `MESSAGING_BACKEND_SPEC.md` §1 |
| 8 — seq-primary display ordering | `MESSAGING_BACKEND_SPEC.md` §3 |
| 12 — server-authoritative unread | `MESSAGING_BACKEND_SPEC.md` §4 |

## Not in scope

Nothing here affects voice/video call quality, connection time, drops or ring
reliability — calls run on a separate SFU with its own transport and ICE/TURN
servers. See `CALL_RELIABILITY_BACKEND_SPEC.md` and `CALL_PUSH_BACKEND_SPEC.md`
for that work.

One call-side client item **is** already done and waiting on the server:
`syncCallState` / `call:sync` is fully implemented in
`src/calls/services/callSignalService.js` and already fires on every reconnect
and foreground during a live call. Only the server handler is missing.
