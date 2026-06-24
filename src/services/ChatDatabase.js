import * as SQLite from 'expo-sqlite';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

const DB_NAME = 'TalksTry.db';
const DB_VERSION = 13;

// Where the destructive recreate stashes pending unsent messages, and where the
// last init outcome is recorded for telemetry. See _deleteCorruptDB / _recordOutcome.
const OUTBOX_BACKUP_KEY = '@chatdb/outboxBackup';
const DB_OUTCOME_KEY = '@chatdb/lastInitOutcome';

let _db = null;
let _hasReplyColumns = false;

// Dedicated READ-ONLY connection. The single shared `_db` connection serialized
// every read behind the writer's cold-start/post-login catch-up storm (BEGIN
// EXCLUSIVE batches), so a chat-open's first-paint SELECT waited for the storm
// to drain — WAL's "1 writer + N concurrent readers" only applies across
// SEPARATE connections. Routing the hot read path (loadMessages / counts /
// clearedAt) through this second connection lets first paint read the last
// committed snapshot immediately while writes keep draining on `_db`. It is a
// pure optimization: any failure falls back to `_db` (prior behavior).
let _readDb = null;
let _readDbInitPromise = null;
// Set if a dedicated reader connection can't be opened on this device/build, so
// we stop re-attempting on every read and just use the primary connection. Reset
// on a full DB teardown (_closeReadDB) so a later recreate gets a fresh try.
let _readerUnavailable = false;

// ─── DATABASE INIT ──────────────────────────────────────
let _dbInitPromise = null;

const getDB = async () => {
  if (_db) {
    // Verify connection is still alive
    try {
      await _db.getFirstAsync('SELECT 1');
      return _db;
    } catch {
      try { await _db.closeAsync(); } catch {}
      _db = null;
      _dbInitPromise = null;
      // Primary handle died → drop the reader too so it re-opens cleanly.
      await _closeReadDB();
    }
  }
  // Prevent concurrent init attempts
  if (_dbInitPromise) return _dbInitPromise;
  _dbInitPromise = _initDB();
  try {
    const db = await _dbInitPromise;
    // Crucial: never return null. Callers (saveMessagesToLocal, etc.) immediately
    // call methods on the result; null would crash them with "Cannot read property
    // X of null". Surface a real error instead so the caller's try/catch handles it.
    if (!db) throw new Error('ChatDB unavailable: all init attempts failed');
    return db;
  } finally {
    _dbInitPromise = null;
  }
};

const _closeReadDB = async () => {
  const r = _readDb;
  _readDb = null;
  _readDbInitPromise = null;
  _readerUnavailable = false;
  if (r) { try { await r.closeAsync(); } catch {} }
};

const _safeClose = async () => {
  // The reader points at the same file; tear it down with the primary so a
  // recreate/recovery never leaves a stale reader handle on a deleted DB.
  await _closeReadDB();
  if (!_db) return;
  try { await _db.closeAsync(); } catch {}
  _db = null;
};

// Open (once) a second connection to the same DB file for read-only queries.
// `getDB()` runs first so the file + schema/migrations already exist, then we
// open an independent handle. Defensive throughout: on ANY failure we resolve to
// the primary connection so reads always work.
const getReadDB = async () => {
  if (_readDb) return _readDb;
  if (_readerUnavailable) return getDB(); // already known to be unsupported here
  if (_readDbInitPromise) return _readDbInitPromise;
  _readDbInitPromise = (async () => {
    const primary = await getDB(); // ensures file exists + migrations have run
    try {
      const handle = typeof SQLite.openDatabaseSync === 'function'
        ? SQLite.openDatabaseSync(DB_NAME)
        : await SQLite.openDatabaseAsync(DB_NAME);
      // Probe + best-effort pragmas. query_only hard-guards against accidental
      // writes on this connection; busy_timeout mirrors the writer.
      await handle.getFirstAsync('SELECT 1');
      try { await handle.execAsync('PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;'); } catch {}
      _readDb = handle;
      return handle;
    } catch (e) {
      // Could not open a dedicated reader (e.g. native handle issue) — fall back
      // to the shared primary connection. Reads still work, just without the
      // concurrency win. Mark unavailable so we don't re-attempt on every read.
      _readDb = null;
      _readerUnavailable = true;
      return primary;
    } finally {
      _readDbInitPromise = null;
    }
  })();
  return _readDbInitPromise;
};

// Run a read-only query through the dedicated reader. If the reader handle is
// dead/missing, reset it and transparently retry on the primary connection.
const _readQuery = async (fn) => {
  try {
    const rdb = await getReadDB();
    return await fn(rdb);
  } catch (e) {
    await _closeReadDB();
    const db = await getDB();
    return await fn(db);
  }
};

const MAX_INIT_ATTEMPTS = 6;

// Fire-and-forget telemetry: record the outcome of EACH init so recurrence of
// the corruption/native-mismatch failure is visible (queryable from AsyncStorage
// / a debug screen) instead of guessed. Intentionally NOT awaited — it must never
// gate or slow the init hot path.
const _recordOutcome = (outcome, extra = {}) => {
  AsyncStorage.setItem(
    DB_OUTCOME_KEY,
    JSON.stringify({ outcome, at: Date.now(), ...extra }),
  ).catch(() => {});
};

// Build a file:// URI for a DB sidecar (-wal / -shm) in SQLite's own directory.
const _sidecarUri = (suffix) => {
  let dir = SQLite.defaultDatabaseDirectory || '';
  if (!dir) return null;
  if (!dir.startsWith('file://')) dir = `file://${dir}`;
  if (!dir.endsWith('/')) dir += '/';
  return `${dir}${DB_NAME}${suffix}`;
};

// `deleteDatabaseAsync` SHOULD remove the -wal/-shm sidecars too, but that is not
// contractually guaranteed across expo-sqlite versions/platforms — and a
// truncated/leftover WAL is ITSELF a primary cause of the corrupt-open NPE. So we
// also unlink the sidecars explicitly (idempotent: missing files don't throw) to
// guarantee the recreate starts from a truly clean slate.
const _deleteSidecars = async () => {
  for (const suffix of ['-wal', '-shm']) {
    const uri = _sidecarUri(suffix);
    if (!uri) continue;
    try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch {}
  }
};

// Best-effort: read the durable `outbox` (pending, not-yet-acked outbound
// messages) BEFORE the wipe and stash it in AsyncStorage. The local DB is a
// re-syncable cache for RECEIVED messages, but the outbox is the ONLY record of
// locally-composed sends the server hasn't confirmed — deleting it loses real
// user messages. If the file is too corrupt to read the outbox, we cannot save
// it; warn loudly so the loss is visible in telemetry, never silent.
const _backupOutboxBeforeNuke = async () => {
  let probeDb = null;
  try {
    probeDb = SQLite.openDatabaseSync(DB_NAME);
    await probeDb.getFirstAsync('SELECT 1');
    const rows = await probeDb.getAllAsync('SELECT * FROM outbox');
    if (Array.isArray(rows) && rows.length) {
      await AsyncStorage.setItem(OUTBOX_BACKUP_KEY, JSON.stringify(rows));
      console.warn(`[ChatDB] preserved ${rows.length} pending outbox message(s) before DB wipe; restoring after recreate`);
    }
  } catch (e) {
    const m = String(e?.message || '').toLowerCase();
    // "no such table: outbox" → pre-V8 DB with nothing to preserve (not a loss).
    if (!m.includes('no such table')) {
      console.warn('[ChatDB] could not preserve outbox before DB wipe — pending unsent messages may be lost:', e?.message);
      _recordOutcome('outbox_preserve_failed', { error: e?.message });
    }
  } finally {
    if (probeDb) { try { await probeDb.closeAsync(); } catch {} }
  }
};

// Re-insert any outbox rows preserved before the wipe into the freshly recreated
// (migrated) DB, set next_retry_at=0 so the worker drains them immediately, then
// clear the backup. Behaviour-preserving: mirrors the columns outboxEnqueue uses.
const _restoreOutboxBackup = async (db) => {
  let raw = null;
  try { raw = await AsyncStorage.getItem(OUTBOX_BACKUP_KEY); } catch {}
  if (!raw) return;
  let rows = [];
  try { rows = JSON.parse(raw) || []; } catch { rows = []; }
  let restored = 0;
  for (const r of rows) {
    if (!r?.client_message_id || !r?.chat_id) continue;
    try {
      await db.runAsync(
        `INSERT OR REPLACE INTO outbox
           (client_message_id, chat_id, payload, attempts, max_attempts, next_retry_at, last_error, created_at, updated_at)
         VALUES ($c,$cid,$p,$a,$m,0,$e,$ca,$ua)`,
        {
          $c: r.client_message_id,
          $cid: r.chat_id,
          $p: typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload || {}),
          $a: r.attempts || 0,
          $m: r.max_attempts || 6,
          $e: r.last_error || null,
          $ca: r.created_at || Date.now(),
          $ua: Date.now(),
        },
      );
      restored++;
    } catch {}
  }
  try { await AsyncStorage.removeItem(OUTBOX_BACKUP_KEY); } catch {}
  if (restored) console.warn(`[ChatDB] restored ${restored} pending outbox message(s); they will retry on next drain`);
};

// Delete the on-disk database (and its -wal/-shm sidecars) as a LAST-RESORT
// recovery. A corrupted or locked DB file makes the native open return a
// half-initialized handle whose internal pointer is null, so EVERY subsequent
// prepareAsync rejects with a bare NullPointerException no matter how we reopen
// the SAME file — the plain retry loop can never escape that. The local DB is a
// cache (the backend is the sync source of truth: messages re-sync on next
// connect), so recreating it empty is far better than a permanently dead chat —
// EXCEPT the outbox, which we preserve first (see _backupOutboxBeforeNuke).
let _didNukeThisRun = false;        // sticky across the process (drives the final cause-A log)
let _deletedThisSequence = false;   // reset per _initDB run (prevents re-nuking attempts 5/6)
const _deleteCorruptDB = async () => {
  await _safeClose();
  // 1. Save pending sends BEFORE anything is destroyed.
  await _backupOutboxBeforeNuke();
  // 2. Delete the main DB file...
  try {
    if (typeof SQLite.deleteDatabaseAsync === 'function') {
      await SQLite.deleteDatabaseAsync(DB_NAME);
    } else if (typeof SQLite.deleteDatabaseSync === 'function') {
      SQLite.deleteDatabaseSync(DB_NAME);
    }
  } catch (e) {
    console.warn('[ChatDB] could not delete corrupt database (non-fatal):', e?.message);
  }
  // 3. ...and its WAL/SHM sidecars, so the recreate is from a truly clean slate.
  await _deleteSidecars();
  _didNukeThisRun = true;
  _deletedThisSequence = true;
  console.warn('[ChatDB] deleted corrupt database + WAL/SHM sidecars; recreating empty (received messages re-sync from server)');
};

// Open a fresh native handle. The strategy ESCALATES per attempt:
//   1      → async open                      (fast path)
//   2, 3   → sync open                       (dodges the async close→reopen race;
//                                             the sync opener doesn't hit it)
//   4, 5, 6→ DELETE the file, then sync open  (self-heal a corrupt/locked DB —
//                                             the only thing that breaks the
//                                             "reopen the same dead file" loop)
// Anti-loop guard: the destructive delete runs AT MOST ONCE per init sequence
// (_deletedThisSequence). Attempts 5/6 then just reopen the already-recreated
// empty file — re-deleting would clobber the outbox backup with the empty DB.
const _openHandle = async (attempt) => {
  if (attempt >= 4 && !_deletedThisSequence) {
    await _deleteCorruptDB();
  }
  if (attempt >= 2 && typeof SQLite.openDatabaseSync === 'function') {
    return SQLite.openDatabaseSync(DB_NAME);
  }
  return await SQLite.openDatabaseAsync(DB_NAME);
};

const _initDB = async () => {
  // Reset the per-sequence delete guard so THIS init run can self-heal once if
  // needed (without re-nuking on attempts 5/6). _didNukeThisRun stays sticky.
  _deletedThisSequence = false;
  // Each attempt opens a FRESH handle (closing the previous one) and PROBES it
  // with a trivial query before doing any real work. The Android NPE surfaces on
  // that probe for a dead handle, so it retries with a new (eventually sync)
  // handle instead of limping into runMigrations and failing there.
  for (let attempt = 1; attempt <= MAX_INIT_ATTEMPTS; attempt++) {
    try {
      await _safeClose();
      _db = await _openHandle(attempt);

      // Small tick lets the native side finish wiring up the handle before the
      // first call; a touch longer on retries.
      await new Promise((r) => setTimeout(r, attempt === 1 ? 50 : 150));

      // Probe FIRST: if the handle is dead this throws the NPE and drops us into
      // the catch → retry, rather than silently warning through every PRAGMA and
      // only blowing up inside runMigrations.
      await _db.getFirstAsync('SELECT 1');

      // PRAGMAs are best-effort optimizations — log and continue on failure
      // rather than tearing down a handle that already passed the probe.
      for (const pragma of [
        'PRAGMA journal_mode = WAL;',
        'PRAGMA synchronous = NORMAL;',
        'PRAGMA foreign_keys = ON;',
        // busy_timeout makes SQLite block up to 5s for a write lock instead of
        // failing immediately with "database is locked" — critical for the
        // upsertMessages path where many batches contend on the WAL writer.
        'PRAGMA busy_timeout = 5000;',
      ]) {
        try { await _db.execAsync(pragma); }
        catch (e) { console.warn(`[ChatDB] ${pragma} failed (non-fatal):`, e?.message); }
      }

      await runMigrations(_db);
      // Recreated this run → restore any preserved pending sends, then record the
      // healed outcome (cause B). A clean open just records success.
      if (_deletedThisSequence) {
        await _restoreOutboxBackup(_db);
        _recordOutcome('recovered_via_recreate', { attempt });
        console.warn('[ChatDB] recovered via delete-and-recreate (cause B: corrupt/locked DB, healed)');
      } else {
        _recordOutcome(attempt === 1 ? 'ok' : 'recovered_after_retry', { attempt });
      }
      return _db;
    } catch (err) {
      console.warn(`[ChatDB] init attempt ${attempt}/${MAX_INIT_ATTEMPTS} failed: ${err?.message}; will retry`);
      await _safeClose();
      if (attempt < MAX_INIT_ATTEMPTS) await new Promise(r => setTimeout(r, 250 * attempt));
    }
  }
  // If we got here we even tried DELETING and recreating the file and it STILL
  // can't prepare a statement. That is no longer a corrupt-file problem — the
  // native expo-sqlite module is returning null handles, which almost always
  // means the installed native build is out of sync with JS expo-sqlite
  // (New Architecture enabled / deps bumped without a clean prebuild). No JS
  // retry can fix that — the app must be rebuilt:
  //   npx expo install expo-sqlite
  //   npx expo prebuild --clean -p android
  //   npx expo run:android        (or rebuild the dev client / EAS build)
  _recordOutcome(
    _didNukeThisRun ? 'failed_after_recreate_native_rebuild_required' : 'failed_all_attempts',
  );
  console.error(
    _didNukeThisRun
      ? '[ChatDB] All DB init attempts failed AFTER deleting the file → native expo-sqlite build is stale/mismatched (cause A). Rebuild the app: `npx expo install expo-sqlite` then `npx expo prebuild --clean -p android` then `npx expo run:android`.'
      : '[ChatDB] All DB init attempts failed.'
  );
  return null;
};

const runMigrations = async (db) => {
  const result = await db.getFirstAsync('PRAGMA user_version;');
  const currentVersion = result?.user_version ?? 0;
  if (currentVersion >= DB_VERSION) {
    await _detectReplyColumns(db);
    return;
  }

  try {
    if (currentVersion < 1) {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY NOT NULL,
          server_message_id TEXT, temp_id TEXT, chat_id TEXT NOT NULL, group_id TEXT,
          sender_id TEXT, sender_name TEXT, sender_type TEXT, receiver_id TEXT,
          text TEXT, type TEXT DEFAULT 'text', status TEXT DEFAULT 'sent',
          timestamp INTEGER NOT NULL, created_at TEXT, synced INTEGER DEFAULT 0,
          is_deleted INTEGER DEFAULT 0, deleted_for TEXT, deleted_by TEXT, placeholder_text TEXT,
          is_edited INTEGER DEFAULT 0, edited_at TEXT,
          media_url TEXT, media_type TEXT, preview_url TEXT, local_uri TEXT, media_id TEXT,
          reactions TEXT, delivered_to TEXT, read_by TEXT, payload TEXT, extra TEXT,
          reply_to_message_id TEXT, reply_preview_text TEXT, reply_preview_type TEXT,
          reply_sender_name TEXT, reply_sender_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
        CREATE INDEX IF NOT EXISTS idx_messages_server_id ON messages(server_message_id);
        CREATE INDEX IF NOT EXISTS idx_messages_temp_id ON messages(temp_id);
        CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp ON messages(chat_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
        CREATE INDEX IF NOT EXISTS idx_messages_media ON messages(media_id);

        CREATE TABLE IF NOT EXISTS message_status (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL, user_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'sent', updated_at INTEGER,
          UNIQUE(message_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_status_message ON message_status(message_id);

        CREATE TABLE IF NOT EXISTS reactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL, user_id TEXT NOT NULL, emoji TEXT NOT NULL,
          created_at INTEGER, UNIQUE(message_id, user_id, emoji)
        );
        CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);

        CREATE TABLE IF NOT EXISTS chat_meta (
          chat_id TEXT PRIMARY KEY NOT NULL,
          cleared_at INTEGER DEFAULT 0, last_message_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS message_replies (
          message_id TEXT PRIMARY KEY NOT NULL,
          reply_to_message_id TEXT NOT NULL,
          reply_preview_text TEXT, reply_preview_type TEXT,
          reply_sender_name TEXT, reply_sender_id TEXT
        );
      `);
    }

    // Add reply columns to existing databases
    if (currentVersion >= 1 && currentVersion < 4) {
      const cols = [
        'reply_to_message_id TEXT', 'reply_preview_text TEXT', 'reply_preview_type TEXT',
        'reply_sender_name TEXT', 'reply_sender_id TEXT',
      ];
      for (const col of cols) {
        try { await db.execAsync(`ALTER TABLE messages ADD COLUMN ${col};`); } catch {}
      }
      try {
        await db.execAsync(`
          CREATE TABLE IF NOT EXISTS message_replies (
            message_id TEXT PRIMARY KEY NOT NULL,
            reply_to_message_id TEXT NOT NULL,
            reply_preview_text TEXT, reply_preview_type TEXT,
            reply_sender_name TEXT, reply_sender_id TEXT
          );
        `);
      } catch {}
    }

    // V5: Add unique index on server_message_id to prevent duplicate rows
    if (currentVersion < 5) {
      try {
        // Step 1: Remove duplicate rows that share the same server_message_id (keep the one with reply data, or the newest)
        await db.execAsync(`
          DELETE FROM messages WHERE server_message_id IS NOT NULL AND rowid NOT IN (
            SELECT MAX(rowid) FROM messages WHERE server_message_id IS NOT NULL
            GROUP BY server_message_id
          );
        `);
        // Step 2: Remove temp rows that have a content-matching server-confirmed row
        await db.execAsync(`
          DELETE FROM messages WHERE id LIKE 'temp_%' AND EXISTS (
            SELECT 1 FROM messages s WHERE s.id NOT LIKE 'temp_%'
            AND s.sender_id = messages.sender_id AND s.text = messages.text
            AND s.chat_id = messages.chat_id
            AND ABS(s.timestamp - messages.timestamp) < 5000
          );
        `);
        // Step 3: Add unique index (nullable — only enforced for non-NULL values)
        await db.execAsync(`
          DROP INDEX IF EXISTS idx_messages_server_id;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_server_id ON messages(server_message_id) WHERE server_message_id IS NOT NULL;
        `);
      } catch (e) {
        console.warn('[ChatDB] V5 migration warning:', e?.message);
      }
    }

    // V6: Add chats table (chatlist in SQLite) + sync_meta table
    if (currentVersion < 6) {
      try {
        await db.execAsync(`
          CREATE TABLE IF NOT EXISTS chats (
            chat_id TEXT PRIMARY KEY NOT NULL,
            chat_type TEXT DEFAULT 'private',
            is_group INTEGER DEFAULT 0,
            peer_user TEXT,
            group_data TEXT,
            group_id TEXT,
            chat_name TEXT,
            chat_avatar TEXT,
            last_message_text TEXT,
            last_message_type TEXT DEFAULT 'text',
            last_message_sender_id TEXT,
            last_message_sender_name TEXT,
            last_message_status TEXT,
            last_message_at TEXT,
            last_message_id TEXT,
            last_message_is_edited INTEGER DEFAULT 0,
            last_message_is_deleted INTEGER DEFAULT 0,
            unread_count INTEGER DEFAULT 0,
            is_pinned INTEGER DEFAULT 0,
            pinned_at TEXT,
            is_muted INTEGER DEFAULT 0,
            mute_until TEXT,
            is_archived INTEGER DEFAULT 0,
            members TEXT,
            member_count INTEGER DEFAULT 0,
            created_at TEXT,
            updated_at INTEGER DEFAULT 0,
            raw_data TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_chats_last_message_at ON chats(last_message_at DESC);
          CREATE INDEX IF NOT EXISTS idx_chats_pinned ON chats(is_pinned);
          CREATE INDEX IF NOT EXISTS idx_chats_archived ON chats(is_archived);
          CREATE INDEX IF NOT EXISTS idx_chats_group_id ON chats(group_id);

          CREATE TABLE IF NOT EXISTS sync_meta (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT,
            updated_at INTEGER DEFAULT 0
          );
        `);
      } catch (e) {
        console.warn('[ChatDB] V6 migration warning:', e?.message);
      }
    }

    // V7: Status-reply preview is stored inside the `payload` JSON column
    // (keys `statusRef` + `statusPreview`), mirroring how forwardedFrom and
    // isScheduled are persisted. No schema change is required; the bump is
    // here so older clients re-read payload on next sync.

    // V8: Realtime pipeline upgrade
    //  - `messages.client_message_id` — client-generated UUID, idempotency key.
    //  - `messages.seq`               — server-allocated monotonic seq (per chat).
    //  - `messages.seen_by`           — JSON array, mirrors Mongo `seenBy`.
    //  - `messages.status_ref` + `messages.status_preview` — promoted out of payload JSON.
    //  - `messages.reply_preview_*`   — sender/text/type already existed; add media fields.
    //  - `chats.cleared_at`           — mirrors server ChatSummary.clearedAt.
    //  - `chats.read_up_to_seq` / `delivered_up_to_seq` — peer's watermark for our ticks.
    //  - `outbox`                     — durable pending-send queue with retry.
    //  - `reactions_v2`               — reaction store (single row per user-per-message).
    if (currentVersion < 8) {
      const addCol = async (table, col) => {
        try { await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${col};`); } catch {}
      };
      await addCol('messages', 'client_message_id TEXT');
      await addCol('messages', 'seq INTEGER');
      await addCol('messages', 'seen_by TEXT');
      await addCol('messages', 'status_ref TEXT');
      await addCol('messages', 'status_preview TEXT');
      await addCol('messages', 'forwarded_from TEXT');
      await addCol('messages', 'forwarded_count INTEGER DEFAULT 0');
      await addCol('messages', 'reaction_counts TEXT');
      await addCol('chats',    'cleared_at INTEGER DEFAULT 0');
      await addCol('chats',    'read_up_to_seq INTEGER DEFAULT 0');
      await addCol('chats',    'delivered_up_to_seq INTEGER DEFAULT 0');

      try {
        await db.execAsync(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_uuid
            ON messages(client_message_id) WHERE client_message_id IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_messages_chat_seq
            ON messages(chat_id, seq);

          CREATE TABLE IF NOT EXISTS outbox (
            client_message_id TEXT PRIMARY KEY NOT NULL,
            chat_id TEXT NOT NULL,
            payload TEXT NOT NULL,
            attempts INTEGER DEFAULT 0,
            max_attempts INTEGER DEFAULT 6,
            next_retry_at INTEGER DEFAULT 0,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_outbox_next_retry ON outbox(next_retry_at);
          CREATE INDEX IF NOT EXISTS idx_outbox_chat       ON outbox(chat_id);

          CREATE TABLE IF NOT EXISTS reactions_v2 (
            message_id TEXT NOT NULL,
            chat_id    TEXT NOT NULL,
            user_id    TEXT NOT NULL,
            emoji      TEXT NOT NULL,
            skin_tone  TEXT,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (message_id, user_id)
          );
          CREATE INDEX IF NOT EXISTS idx_reactions_v2_message ON reactions_v2(message_id);
        `);
      } catch (e) {
        console.warn('[ChatDB] V8 migration warning:', e?.message);
      }
    }

    // V9: Official application broadcast statuses cache (offline cold-render)
    if (currentVersion < 9) {
      try {
        await db.execAsync(`
          CREATE TABLE IF NOT EXISTS broadcasts (
            id TEXT PRIMARY KEY NOT NULL,
            data TEXT NOT NULL,
            published_at INTEGER DEFAULT 0,
            expires_at INTEGER DEFAULT 0,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_broadcasts_published ON broadcasts(published_at DESC);
          CREATE INDEX IF NOT EXISTS idx_broadcasts_expires   ON broadcasts(expires_at);
        `);
      } catch (e) {
        console.warn('[ChatDB] V9 migration warning:', e?.message);
      }
    }

    // V10: Contact status-feed cache (chat-list status rings, offline cold-render)
    if (currentVersion < 10) {
      try {
        await db.execAsync(`
          CREATE TABLE IF NOT EXISTS status_feed (
            user_id TEXT PRIMARY KEY NOT NULL,
            data TEXT NOT NULL,
            latest_at INTEGER DEFAULT 0,
            has_unseen INTEGER DEFAULT 0,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_status_feed_latest ON status_feed(latest_at DESC);
        `);
      } catch (e) {
        console.warn('[ChatDB] V10 migration warning:', e?.message);
      }
    }

    // V11: WhatsApp-style media albums — one message carries N attachments.
    //  - `messages.media_group_id` — shared id for the album.
    //  - `messages.media_items`    — JSON array of attachment descriptors
    //    [{ mediaId, fileCategory, mediaUrl, mediaThumbnailUrl, localUri,
    //       mediaMeta, uploadStatus, uploadProgress }].
    if (currentVersion < 11) {
      try {
        await db.execAsync(`ALTER TABLE messages ADD COLUMN media_group_id TEXT;`);
      } catch {}
      try {
        await db.execAsync(`ALTER TABLE messages ADD COLUMN media_items TEXT;`);
      } catch {}
      try {
        await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_messages_media_group ON messages(media_group_id);`);
      } catch (e) {
        console.warn('[ChatDB] V11 migration warning:', e?.message);
      }
    }

    // V12 — user-to-user blocked contacts cache (offline cold render + sync).
    if (currentVersion < 12) {
      try {
        await db.execAsync(`
          CREATE TABLE IF NOT EXISTS blocked_contacts (
            user_id TEXT PRIMARY KEY NOT NULL,
            full_name TEXT,
            phone TEXT,
            profile_image TEXT,
            blocked_at INTEGER DEFAULT 0
          );
        `);
        await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_blocked_at ON blocked_contacts(blocked_at DESC);`);
      } catch (e) {
        console.warn('[ChatDB] V12 migration warning:', e?.message);
      }
    }

    if (currentVersion < 13) {
      try {
        // V13: presence cache — last-known online/away/offline + lastSeen per user
        // so the UI can render presence instantly (incl. while offline) and
        // reconcile once the socket reconnects. Mirrors backend presence:update.
        await db.execAsync(`
          CREATE TABLE IF NOT EXISTS presence_cache (
            user_id TEXT PRIMARY KEY NOT NULL,
            status TEXT,
            last_seen INTEGER,
            updated_at INTEGER NOT NULL
          );
        `);
      } catch (e) {
        console.warn('[ChatDB] V13 migration warning:', e?.message);
      }
    }

    await db.execAsync(`PRAGMA user_version = ${DB_VERSION};`);
  } catch (err) {
    console.error('[ChatDB] Migration error:', err);
  }

  await _detectReplyColumns(db);
};

const _detectReplyColumns = async (db) => {
  try {
    const info = await db.getAllAsync('PRAGMA table_info(messages);');
    _hasReplyColumns = info.some(c => c.name === 'reply_to_message_id');
  } catch {
    _hasReplyColumns = false;
  }
  // Always ensure message_replies table exists
  try {
    await db.execAsync(`CREATE TABLE IF NOT EXISTS message_replies (message_id TEXT PRIMARY KEY NOT NULL, reply_to_message_id TEXT NOT NULL, reply_preview_text TEXT, reply_preview_type TEXT, reply_sender_name TEXT, reply_sender_id TEXT);`);
  } catch {}
};

// ─── HELPERS ────────────────────────────────────────────

const formatTime = (ts, ca) => {
  if (!ts && !ca) return null;
  const d = ts ? new Date(ts) : new Date(ca);
  if (isNaN(d.getTime())) return null;
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${m} ${ampm}`;
};

const formatDate = (ts, ca) => {
  if (!ts && !ca) return null;
  const d = ts ? new Date(ts) : new Date(ca);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// `queued` is the local-first contract's name for the optimistic pre-ack state
// (MESSAGING_CONTRACT.md §3); it is an alias of `sending` and shares its rank so
// it never beats an acked status and is never downgraded onto an in-flight row.
const STATUS_PRIORITY = { scheduled: 0, cancelled: 0, processing: 0, queued: 1, sending: 1, uploaded: 2, sent: 3, delivered: 4, seen: 5, read: 5 };

const parseJSON = (val) => {
  if (!val) return null;
  try { return JSON.parse(val); } catch { return val; }
};

const rowToMsg = (row) => {
  if (!row) return null;
  const ts = row.timestamp;
  const ca = row.created_at;
  const pp = parseJSON(row.payload);

  const msg = {
    id: row.id,
    seq: row.seq != null ? Number(row.seq) : null,
    serverMessageId: row.server_message_id,
    tempId: row.temp_id,
    chatId: row.chat_id,
    groupId: row.group_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderType: row.sender_type,
    receiverId: row.receiver_id,
    text: row.text,
    type: row.type,
    status: row.status,
    timestamp: ts,
    createdAt: ca,
    time: formatTime(ts, ca),
    date: formatDate(ts, ca),
    synced: Boolean(row.synced),
    isDeleted: Boolean(row.is_deleted),
    deletedFor: parseJSON(row.deleted_for),
    deletedBy: row.deleted_by,
    placeholderText: row.placeholder_text,
    isEdited: Boolean(row.is_edited),
    editedAt: row.edited_at,
    mediaUrl: row.media_url,
    mediaType: row.media_type,
    previewUrl: row.preview_url,
    localUri: row.local_uri,
    mediaId: row.media_id,
    // Album (multi-attachment) fields — persisted in payload JSON (same
    // pattern as mediaMeta); V11 columns kept as fallback for older writers.
    mediaGroupId: pp?.mediaGroupId || row.media_group_id || null,
    mediaItems: (Array.isArray(pp?.mediaItems) && pp.mediaItems.length ? pp.mediaItems : parseJSON(row.media_items)) || null,
    reactions: parseJSON(row.reactions),
    deliveredTo: parseJSON(row.delivered_to),
    readBy: parseJSON(row.read_by),
    payload: pp,
    // Restore mediaMeta from payload (not stored as a column)
    mediaMeta: pp?.mediaMeta || pp?.contact || null,
    // Restore forwarded flag from payload (not a column)
    isForwarded: Boolean(pp?.isForwarded || pp?._isForwarded || pp?.forwarded || pp?.forwardedMessage),
    forwardedFrom: pp?.forwardedFrom || pp?._forwardedFrom || pp?.originalMessageId || null,
    // Restore scheduled message data from payload
    isScheduled: Boolean(pp?.isScheduled),
    scheduleTime: pp?.scheduleTime || null,
    scheduleTimeLabel: pp?.scheduleTimeLabel || null,
    // Status reply / share — snapshot persisted in payload
    statusRef: pp?.statusRef || null,
    statusPreview: pp?.statusPreview || null,
    // Reply: check column first, then payload fallback
    replyToMessageId: row.reply_to_message_id || pp?._replyToMessageId || null,
    replyPreviewText: row.reply_preview_text || pp?._replyPreviewText || null,
    replyPreviewType: row.reply_preview_type || pp?._replyPreviewType || null,
    replySenderName: row.reply_sender_name || pp?._replySenderName || null,
    replySenderId: row.reply_sender_id || pp?._replySenderId || null,
  };
  // Fix corrupted replyToMessageId stored as stringified object e.g. "{_id=abc, senderId=x, text=Hi}"
  if (msg.replyToMessageId && typeof msg.replyToMessageId === 'string' && msg.replyToMessageId.startsWith('{') && msg.replyToMessageId.includes('_id=')) {
    const idMatch = msg.replyToMessageId.match(/_id=([a-f0-9]+)/);
    const textMatch = msg.replyToMessageId.match(/text=([^,}]*)/);
    const senderMatch = msg.replyToMessageId.match(/senderId=([a-f0-9]+)/);
    if (idMatch) msg.replyToMessageId = idMatch[1];
    if (textMatch && !msg.replyPreviewText) msg.replyPreviewText = textMatch[1].trim();
    if (senderMatch && !msg.replySenderId) msg.replySenderId = senderMatch[1];
  }
  return msg;
};

// ─── REPLY TABLE (permanent, never overwritten) ────────

// `dbOverride` lets callers (notably the upsertMessages transaction) pass in
// the already-resolved handle so this function does NOT call getDB() again.
// getDB()'s heartbeat can swap `_db` if it thinks the connection is stale,
// which would orphan the in-flight transaction onto the old handle — exactly
// the kind of state that produces "database is locked" on finalizeAsync.
const saveReplyData = async (messageId, data, dbOverride = null) => {
  if (!messageId || !data?.replyToMessageId) return;
  const db = dbOverride || await getDB();
  const params = { $mid: messageId, $rid: data.replyToMessageId, $text: data.replyPreviewText || null, $type: data.replyPreviewType || null, $name: data.replySenderName || null, $sid: data.replySenderId || null };
  const sql = `INSERT OR IGNORE INTO message_replies (message_id, reply_to_message_id, reply_preview_text, reply_preview_type, reply_sender_name, reply_sender_id) VALUES ($mid, $rid, $text, $type, $name, $sid)`;
  try {
    await db.runAsync(sql, params);
  } catch (err) {
    // Don't re-create the table inside a transaction (would itself try a write
    // and can deadlock). Just swallow — the table is created in migrations.
    if (!dbOverride) {
      try {
        await db.execAsync(`CREATE TABLE IF NOT EXISTS message_replies (message_id TEXT PRIMARY KEY NOT NULL, reply_to_message_id TEXT NOT NULL, reply_preview_text TEXT, reply_preview_type TEXT, reply_sender_name TEXT, reply_sender_id TEXT);`);
        await db.runAsync(sql, params);
      } catch {}
    }
  }
};

const getReplyData = async (messageId) => {
  if (!messageId) return null;
  const db = await getDB();
  try {
    const r = await db.getFirstAsync(`SELECT * FROM message_replies WHERE message_id = $id LIMIT 1`, { $id: messageId });
    if (!r) return null;
    return { replyToMessageId: r.reply_to_message_id, replyPreviewText: r.reply_preview_text, replyPreviewType: r.reply_preview_type, replySenderName: r.reply_sender_name, replySenderId: r.reply_sender_id };
  } catch { return null; }
};

// ─── UPSERT ─────────────────────────────────────────────

const cleanBeforeUpsert = async (db, msg) => {
  const id = msg.serverMessageId || msg.id || msg.tempId;
  const tempId = msg.tempId;
  const serverId = msg.serverMessageId;

  // Rescue reactions from any row that's about to be deleted so the incoming msg preserves them
  if (!msg.reactions || (typeof msg.reactions === 'object' && Object.keys(msg.reactions).length === 0)) {
    try {
      const lookupIds = [tempId, serverId, id].filter(Boolean);
      for (const lid of lookupIds) {
        const existing = await db.getFirstAsync(
          `SELECT reactions FROM messages WHERE (id = $lid OR server_message_id = $lid OR temp_id = $lid) AND reactions IS NOT NULL AND reactions != 'null' AND reactions != '{}' LIMIT 1`,
          { $lid: lid }
        );
        if (existing?.reactions) {
          const parsed = parseJSON(existing.reactions);
          if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
            msg.reactions = parsed;
            break;
          }
        }
      }
    } catch {}
  }

  // 1. If we know the tempId→serverId link, remove the temp row
  if (serverId && tempId && serverId !== tempId) {
    await db.runAsync(`DELETE FROM messages WHERE (id = $t OR temp_id = $t) AND id != $s`, { $t: tempId, $s: serverId });
  }
  // 2. Remove stale rows sharing the same temp_id
  if (tempId && tempId !== id) {
    await db.runAsync(`DELETE FROM messages WHERE temp_id = $t AND id != $id`, { $t: tempId, $id: id });
  }
  // 3. Remove other rows sharing the same server_message_id
  if (serverId) {
    await db.runAsync(`DELETE FROM messages WHERE server_message_id = $s AND id != $id`, { $s: serverId, $id: id });
  }
  // 4. Content-based: delete temp/unconfirmed rows from same sender with same text within 30s
  if (msg.senderId && msg.timestamp) {
    const ts = Number(msg.timestamp || 0);
    if (ts > 0) {
      await db.runAsync(
        `DELETE FROM messages WHERE chat_id = $cid AND sender_id = $sid AND id != $id AND text = $text AND ABS(timestamp - $ts) < 30000 AND (id LIKE 'temp_%' OR server_message_id IS NULL${serverId ? ' OR server_message_id = $serverId' : ''})`,
        { $cid: msg.chatId, $sid: msg.senderId, $id: id, $text: msg.text || '', $ts: ts, ...(serverId ? { $serverId: serverId } : {}) }
      );
    }
  }
  // 5. Also search by server_message_id in temp_id field (acknowledgeMessage stores it there)
  if (serverId) {
    await db.runAsync(`DELETE FROM messages WHERE temp_id = $s AND id != $id AND id LIKE 'temp_%'`, { $s: serverId, $id: id });
  }
};

// Single-message upsert. Delegates to the batch path so it runs through the
// SAME global write mutex (`runExclusive`) + transaction (`withTransactionAsync`)
// as every other write batch.
//
// Why: the old implementation ran its multi-statement DELETE…+INSERT sequence
// BARE on the shared connection — no mutex, no transaction. When it fired
// concurrently with a batch (`upsertMessages`, which DOES hold a transaction),
// the two contended for the single WAL writer lock and rejected with
// "database is locked" on finalizeAsync. That is exactly the `handleSendText`
// optimistic-write failure: the user sends a message (single upsert) while an
// incoming-message sync batch is mid-commit. `_runUpsertBatch` performs the
// identical 5-step flow (reply-recovery → clean dupes → preserve local state →
// insert → save reply rows), so delegating is behaviour-preserving and removes
// the race entirely.
const upsertMessage = async (msg) => {
  if (!msg) return;
  return upsertMessages([msg]);
};

// Global write mutex — serializes ALL multi-statement write batches on the
// single SQLite connection (upsertMessages, saveStatusFeed, saveBroadcasts, …).
// Two batches running concurrently contend for the WAL writer lock and reject
// with "database is locked" on finalizeAsync — and parallel BEGIN TRANSACTIONs
// also throw "cannot start a transaction within a transaction". Chaining every
// batch onto one promise guarantees serial, conflict-free execution per process.
// True for the transient SQLite contention errors that resolve once the
// contending writer drains its statement: a plain "database is locked"/"busy",
// OR the generic expo-sqlite "NativeStatement.finalizeAsync has been rejected →
// Error code" that a WAL writer-lock conflict surfaces as (no "locked" text).
// These are safe to retry/skip — the row is re-upserted on the next sync/ack.
const isTransientLockError = (err) => {
  const m = String(err?.message || '').toLowerCase();
  return m.includes('locked') || m.includes('busy') || m.includes('finalizeasync');
};

let _writeChain = Promise.resolve();
// Global write mutex — STRICT FIFO. Every write (single-statement AND batch)
// chains here, so no two writes ever overlap on EITHER connection: the shared
// main connection used by single statements, or the dedicated BEGIN EXCLUSIVE
// connection that `withExclusiveTransactionAsync` opens for batches.
//
// WHY NOT re-entrant/inline: a previous version returned
// `Promise.resolve().then(task)` whenever another write was mid-flight, so a
// re-entrant write would run inline instead of deadlocking. But that let a
// single-statement write (e.g. upsertPresenceCache) run OUTSIDE chain order —
// the inlined write could still be executing on the MAIN connection when the
// NEXT batch grabbed BEGIN EXCLUSIVE on the DEDICATED connection, and the two
// connections then collided → recurring "database is locked" (SQLITE_BUSY) on
// finalizeAsync. Strict serialization removes that entire class.
//
// Trade-off: a writer must NEVER be called from INSIDE another writer's task
// (that would deadlock) — batch internals write through the passed tx/db handle
// instead (as _runUpsertBatch / saveReplyData already do). No such nested call
// exists in this module, so strict FIFO is safe here.
const runExclusive = (task) => {
  const next = _writeChain.then(task, task);
  _writeChain = next.catch(() => {}); // swallow so a failure never breaks the chain
  return next;
};

// Heavy DEDICATED-CONNECTION batch writers (upsertMessages, saveStatusFeed,
// saveBroadcasts, deduplicateChat, clearSyncData, saveBlockedContacts — all via
// `withExclusiveTransactionAsync`) share the SAME chain. Now identical to
// runExclusive; kept as a named alias for call-site clarity.
const runExclusiveBatch = runExclusive;

// Run a multi-statement cache write as ONE atomic transaction, retrying on a
// transient "database is locked".
//
// `withExclusiveTransactionAsync` (NOT `withTransactionAsync`) is the key: it
// runs on a dedicated connection and queues *all* other DB access for the
// transaction's duration, so the high-frequency single-statement writers
// (receipts / message-status / unread) can't interleave into our DELETE+INSERT
// batch. The retry then absorbs the brief window where one of those writers
// already holds the WAL writer lock when our transaction starts. The task
// MUST use the handle it is passed (`tx`), never the outer `db`.
const _runCacheWrite = async (label, task, attempts = 4) => {
  for (let i = 1; i <= attempts; i++) {
    try {
      const db = await getDB();
      if (!db) return;
      if (typeof db.withExclusiveTransactionAsync === 'function') {
        await db.withExclusiveTransactionAsync(async (tx) => { await task(tx); });
      } else if (typeof db.withTransactionAsync === 'function') {
        await db.withTransactionAsync(async () => { await task(db); });
      } else {
        await task(db);
      }
      return;
    } catch (e) {
      const m = String(e?.message || '').toLowerCase();
      if (m.includes('locked') && i < attempts) {
        await new Promise((r) => setTimeout(r, 60 * i));
        continue;
      }
      console.warn(`[ChatDB] ${label} failed:`, e?.message);
      return;
    }
  }
};

const upsertMessages = async (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) return;

  const run = async () => {
    const db = await getDB();

    // Prefer the EXCLUSIVE transaction wrapper: it runs on a dedicated connection
    // and queues all other DB access for the transaction's duration, so the
    // high-frequency single-statement writers (delivery receipts / message-status
    // / unread — now app-wide) can't interleave into this batch and reject a
    // statement with "NativeStatement.finalizeAsync … Error code" (a WAL
    // writer-lock conflict). Retry a few times to absorb the brief window where
    // one of those writers already holds the writer lock when we start. Falls back
    // to the plain transaction wrapper, then manual BEGIN/COMMIT, on older SDKs.
    if (typeof db.withExclusiveTransactionAsync === 'function') {
      for (let i = 1; i <= 4; i++) {
        try {
          await db.withExclusiveTransactionAsync(async (tx) => {
            await _runUpsertBatch(tx, messages);
          });
          return;
        } catch (err) {
          if (isTransientLockError(err) && i < 4) {
            await new Promise((r) => setTimeout(r, 60 * i));
            continue;
          }
          console.warn('[ChatDB] upsertMessages transaction error:', err?.message);
          return;
        }
      }
      return;
    }

    if (typeof db.withTransactionAsync === 'function') {
      try {
        await db.withTransactionAsync(async () => {
          await _runUpsertBatch(db, messages);
        });
      } catch (err) {
        console.warn('[ChatDB] upsertMessages transaction error:', err?.message);
      }
      return;
    }

    // Fallback for older expo-sqlite: manual BEGIN/COMMIT
    await db.execAsync('BEGIN TRANSACTION');
    try {
      await _runUpsertBatch(db, messages);
      await db.execAsync('COMMIT');
    } catch (err) {
      await db.execAsync('ROLLBACK').catch(() => {});
      console.warn('[ChatDB] upsertMessages transaction error:', err?.message);
    }
  };

  // Serialize against every other write batch (status feed, broadcasts, …) too,
  // not just other upsertMessages calls. Uses the dedicated-connection batch
  // path so no single-statement writer can inline onto the main connection while
  // this exclusive transaction holds the writer lock.
  return runExclusiveBatch(run);
};

const _runUpsertBatch = async (db, messages) => {
  for (const msg of messages) {
    try {
        // Same 5-step flow as upsertMessage
        let replyData = null;
        const needsRecovery = !msg.replyToMessageId || (msg.replyToMessageId && !msg.replyPreviewText);
        if (needsRecovery) {
          const msgId = msg.serverMessageId || msg.id || msg.tempId;
          if (msgId) {
            replyData = await getReplyData(msgId);
            if (!replyData) {
              try {
                const ex = await db.getFirstAsync(`SELECT payload FROM messages WHERE id = $id OR server_message_id = $id OR temp_id = $id LIMIT 1`, { $id: msgId });
                if (ex?.payload) {
                  const p = JSON.parse(ex.payload);
                  if (p?._replyToMessageId) replyData = { replyToMessageId: p._replyToMessageId, replyPreviewText: p._replyPreviewText, replyPreviewType: p._replyPreviewType, replySenderName: p._replySenderName, replySenderId: p._replySenderId };
                }
              } catch {}
            }
          }
        }
        const finalMsg = replyData
          ? {
              ...msg,
              replyToMessageId: msg.replyToMessageId || replyData.replyToMessageId,
              replyPreviewText: msg.replyPreviewText || replyData.replyPreviewText,
              replyPreviewType: msg.replyPreviewType || replyData.replyPreviewType,
              replySenderName: msg.replySenderName || replyData.replySenderName,
              replySenderId: msg.replySenderId || replyData.replySenderId,
            }
          : msg;
        await cleanBeforeUpsert(db, finalMsg);
        const merged = await _preserveLocalState(db, finalMsg);
        const writeMsg = merged || finalMsg;
        await _runInsert(db, writeMsg);
        if (writeMsg.replyToMessageId) {
          const ids = [writeMsg.serverMessageId, writeMsg.id, writeMsg.tempId].filter(Boolean);
          // Pass db explicitly so saveReplyData stays on the same handle as
          // the open transaction — see saveReplyData() docstring.
          for (const rid of ids) {
            try { await saveReplyData(rid, writeMsg, db); } catch {}
          }
        }
    } catch (err) {
      // A transient lock/busy/finalize rejection mid-transaction is recoverable
      // once the contending statement drains; downgrade to a quiet yield-and-skip
      // so it stops surfacing as a red warning (the message is re-upserted on the
      // next sync/ack anyway). Only genuinely unexpected errors are warned.
      if (isTransientLockError(err)) {
        // brief yield gives the busy writer time to finalize before we move on
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      console.warn('[ChatDB] upsertMessages row error:', err?.message);
    }
  }
};

/**
 * Actually run the INSERT SQL. Uses reply columns if available, falls back to base.
 */
const _runInsert = async (db, msg, _retried = false) => {
  let id = msg.serverMessageId || msg.id || msg.tempId || `unknown_${Date.now()}`;

  // CRITICAL: If we're about to insert a temp row, check if a server-confirmed version
  // already exists with matching content. If so, redirect the insert to update THAT row
  // instead. This prevents duplicates when saveMessagesToLocal writes stale state back.
  if (id.startsWith('temp_') && !msg.serverMessageId && msg.senderId && msg.timestamp) {
    const ts = Number(msg.timestamp || 0);
    if (ts > 0) {
      try {
        const serverRow = await db.getFirstAsync(
          `SELECT id FROM messages WHERE chat_id = $cid AND sender_id = $sid AND text = $text AND ABS(timestamp - $ts) < 30000 AND server_message_id IS NOT NULL AND id NOT LIKE 'temp_%' LIMIT 1`,
          { $cid: msg.chatId, $sid: msg.senderId, $text: msg.text || '', $ts: ts }
        );
        if (serverRow) {
          // Server version exists — update it instead of creating a temp duplicate
          id = serverRow.id;
        }
      } catch {}
    }
  }

  // Read existing payload to carry forward _reply* fields that might be lost
  let existingReplyInPayload = null;
  if (!msg.replyToMessageId) {
    try {
      const ex = await db.getFirstAsync(`SELECT payload FROM messages WHERE id = $id LIMIT 1`, { $id: id });
      if (ex?.payload) {
        const ep = JSON.parse(ex.payload);
        if (ep?._replyToMessageId) existingReplyInPayload = ep;
      }
    } catch {}
  }

  // Build payload — merge existing fields if incoming doesn't have them
  const payloadObj = {
    ...(msg.payload && typeof msg.payload === 'object' ? msg.payload : {}),
    // Preserve mediaMeta (location, contact data) in payload so it survives SQLite round-trip
    ...(msg.mediaMeta && typeof msg.mediaMeta === 'object' && !msg.payload?.mediaMeta ? { mediaMeta: msg.mediaMeta } : {}),
    // WhatsApp-style album: persist the attachments array + group id so the
    // grid bubble survives the SQLite round-trip.
    ...(Array.isArray(msg.mediaItems) && msg.mediaItems.length ? { mediaItems: msg.mediaItems } : {}),
    ...(msg.mediaGroupId ? { mediaGroupId: String(msg.mediaGroupId) } : {}),
    // Preserve forwarded flag in payload so it survives SQLite round-trip
    ...(msg.isForwarded ? { isForwarded: true, _isForwarded: true } : {}),
    ...(msg.forwardedFrom ? { forwardedFrom: msg.forwardedFrom, _forwardedFrom: msg.forwardedFrom } : {}),
    // Preserve scheduled message data in payload
    ...(msg.isScheduled ? { isScheduled: true, scheduleTime: msg.scheduleTime, scheduleTimeLabel: msg.scheduleTimeLabel } : {}),
    // Carry forward existing reply data from old payload
    ...(existingReplyInPayload ? {
      _replyToMessageId: existingReplyInPayload._replyToMessageId,
      _replyPreviewText: existingReplyInPayload._replyPreviewText || null,
      _replyPreviewType: existingReplyInPayload._replyPreviewType || null,
      _replySenderName: existingReplyInPayload._replySenderName || null,
      _replySenderId: existingReplyInPayload._replySenderId || null,
    } : {}),
    // Override with current reply data if present
    ...(msg.replyToMessageId ? {
      _replyToMessageId: msg.replyToMessageId,
      _replyPreviewText: msg.replyPreviewText || null,
      _replyPreviewType: msg.replyPreviewType || null,
      _replySenderName: msg.replySenderName || null,
      _replySenderId: msg.replySenderId || null,
    } : {}),
    // Status reply / share — snapshot kept so the preview survives status expiry
    ...(msg.statusRef ? { statusRef: String(msg.statusRef) } : {}),
    ...(msg.statusPreview && typeof msg.statusPreview === 'object'
      ? { statusPreview: msg.statusPreview }
      : {}),
  };

  const baseParams = {
    $id: id,
    // Server-allocated monotonic per-chat seq. Persisting it is what makes the
    // reconnect catch-up (`message:sync:catchup` keyed on getLatestSeq) actually
    // work — without it getLatestSeq is always 0 and messages that arrived while
    // the app was killed are never backfilled into the thread.
    $seq: (msg.seq != null && !Number.isNaN(Number(msg.seq))) ? Number(msg.seq) : null,
    $server_message_id: msg.serverMessageId || null,
    $temp_id: msg.tempId || null,
    $chat_id: msg.chatId || null,
    $group_id: msg.groupId || null,
    $sender_id: msg.senderId || null,
    $sender_name: msg.senderName || null,
    $sender_type: msg.senderType || null,
    $receiver_id: msg.receiverId || null,
    $text: msg.text ?? null,
    $type: msg.type || 'text',
    $status: msg.status || 'sent',
    $timestamp: Number(msg.timestamp || new Date(msg.createdAt || 0).getTime() || 0),
    $created_at: msg.createdAt || null,
    $synced: msg.synced ? 1 : 0,
    $is_deleted: msg.isDeleted ? 1 : 0,
    $deleted_for: typeof msg.deletedFor === 'string' ? msg.deletedFor : (msg.deletedFor ? JSON.stringify(msg.deletedFor) : null),
    $deleted_by: msg.deletedBy || null,
    $placeholder_text: msg.placeholderText || null,
    $is_edited: (msg.isEdited || msg.editedAt) ? 1 : 0,
    $edited_at: msg.editedAt || null,
    $media_url: msg.mediaUrl || null,
    $media_type: msg.mediaType || null,
    $preview_url: msg.previewUrl || null,
    $local_uri: msg.localUri || null,
    $media_id: msg.mediaId || null,
    $reactions: (msg.reactions && typeof msg.reactions === 'object' && Object.keys(msg.reactions).length > 0) ? JSON.stringify(msg.reactions) : null,
    $delivered_to: msg.deliveredTo ? JSON.stringify(msg.deliveredTo) : null,
    $read_by: msg.readBy ? JSON.stringify(msg.readBy) : null,
    $payload: JSON.stringify(payloadObj),
    $extra: null,
  };

  const runSQL = async () => {
  if (_hasReplyColumns) {
    // Use full SQL with reply columns
    await db.runAsync(`INSERT INTO messages (
      id, seq, server_message_id, temp_id, chat_id, group_id,
      sender_id, sender_name, sender_type, receiver_id,
      text, type, status, timestamp, created_at, synced,
      is_deleted, deleted_for, deleted_by, placeholder_text,
      is_edited, edited_at, media_url, media_type, preview_url,
      local_uri, media_id, reactions, delivered_to, read_by, payload, extra,
      reply_to_message_id, reply_preview_text, reply_preview_type, reply_sender_name, reply_sender_id
    ) VALUES (
      $id, $seq, $server_message_id, $temp_id, $chat_id, $group_id,
      $sender_id, $sender_name, $sender_type, $receiver_id,
      $text, $type, $status, $timestamp, $created_at, $synced,
      $is_deleted, $deleted_for, $deleted_by, $placeholder_text,
      $is_edited, $edited_at, $media_url, $media_type, $preview_url,
      $local_uri, $media_id, $reactions, $delivered_to, $read_by, $payload, $extra,
      $reply_to_message_id, $reply_preview_text, $reply_preview_type, $reply_sender_name, $reply_sender_id
    ) ON CONFLICT(id) DO UPDATE SET
      seq = COALESCE($seq, seq),
      server_message_id = COALESCE($server_message_id, server_message_id),
      temp_id = COALESCE($temp_id, temp_id),
      chat_id = COALESCE($chat_id, chat_id),
      group_id = COALESCE($group_id, group_id),
      sender_id = COALESCE($sender_id, sender_id),
      sender_name = COALESCE($sender_name, sender_name),
      sender_type = COALESCE($sender_type, sender_type),
      receiver_id = COALESCE($receiver_id, receiver_id),
      text = CASE WHEN $is_deleted = 1 THEN $text WHEN is_edited = 1 AND $is_edited = 0 THEN text ELSE $text END,
      type = COALESCE($type, type),
      status = CASE
        WHEN $status IN ('seen','read') THEN $status
        WHEN $status = 'delivered' AND status NOT IN ('seen','read') THEN $status
        WHEN $status = 'sent' AND status NOT IN ('seen','read','delivered') THEN $status
        ELSE COALESCE($status, status) END,
      timestamp = COALESCE($timestamp, timestamp),
      created_at = COALESCE($created_at, created_at),
      synced = MAX(synced, $synced),
      is_deleted = MAX(is_deleted, $is_deleted),
      deleted_for = COALESCE($deleted_for, deleted_for),
      deleted_by = COALESCE($deleted_by, deleted_by),
      placeholder_text = COALESCE($placeholder_text, placeholder_text),
      is_edited = MAX(is_edited, $is_edited),
      edited_at = COALESCE($edited_at, edited_at),
      media_url = COALESCE($media_url, media_url),
      media_type = COALESCE($media_type, media_type),
      preview_url = COALESCE($preview_url, preview_url),
      local_uri = COALESCE($local_uri, local_uri),
      media_id = COALESCE($media_id, media_id),
      reactions = COALESCE($reactions, reactions),
      delivered_to = COALESCE($delivered_to, delivered_to),
      read_by = COALESCE($read_by, read_by),
      payload = COALESCE($payload, payload),
      extra = COALESCE($extra, extra),
      reply_to_message_id = COALESCE($reply_to_message_id, reply_to_message_id),
      reply_preview_text = COALESCE($reply_preview_text, reply_preview_text),
      reply_preview_type = COALESCE($reply_preview_type, reply_preview_type),
      reply_sender_name = COALESCE($reply_sender_name, reply_sender_name),
      reply_sender_id = COALESCE($reply_sender_id, reply_sender_id)`,
    { ...baseParams,
      $reply_to_message_id: msg.replyToMessageId || null,
      $reply_preview_text: msg.replyPreviewText || null,
      $reply_preview_type: msg.replyPreviewType || null,
      $reply_sender_name: msg.replySenderName || null,
      $reply_sender_id: msg.replySenderId || null,
    });
  } else {
    // Fallback: reply data only in payload JSON
    await db.runAsync(`INSERT INTO messages (
      id, seq, server_message_id, temp_id, chat_id, group_id,
      sender_id, sender_name, sender_type, receiver_id,
      text, type, status, timestamp, created_at, synced,
      is_deleted, deleted_for, deleted_by, placeholder_text,
      is_edited, edited_at, media_url, media_type, preview_url,
      local_uri, media_id, reactions, delivered_to, read_by, payload, extra
    ) VALUES (
      $id, $seq, $server_message_id, $temp_id, $chat_id, $group_id,
      $sender_id, $sender_name, $sender_type, $receiver_id,
      $text, $type, $status, $timestamp, $created_at, $synced,
      $is_deleted, $deleted_for, $deleted_by, $placeholder_text,
      $is_edited, $edited_at, $media_url, $media_type, $preview_url,
      $local_uri, $media_id, $reactions, $delivered_to, $read_by, $payload, $extra
    ) ON CONFLICT(id) DO UPDATE SET
      seq = COALESCE($seq, seq),
      server_message_id = COALESCE($server_message_id, server_message_id),
      temp_id = COALESCE($temp_id, temp_id),
      chat_id = COALESCE($chat_id, chat_id),
      group_id = COALESCE($group_id, group_id),
      sender_id = COALESCE($sender_id, sender_id),
      sender_name = COALESCE($sender_name, sender_name),
      sender_type = COALESCE($sender_type, sender_type),
      receiver_id = COALESCE($receiver_id, receiver_id),
      text = CASE WHEN $is_deleted = 1 THEN $text WHEN is_edited = 1 AND $is_edited = 0 THEN text ELSE $text END,
      type = COALESCE($type, type),
      status = CASE
        WHEN $status IN ('seen','read') THEN $status
        WHEN $status = 'delivered' AND status NOT IN ('seen','read') THEN $status
        WHEN $status = 'sent' AND status NOT IN ('seen','read','delivered') THEN $status
        ELSE COALESCE($status, status) END,
      timestamp = COALESCE($timestamp, timestamp),
      created_at = COALESCE($created_at, created_at),
      synced = MAX(synced, $synced),
      is_deleted = MAX(is_deleted, $is_deleted),
      deleted_for = COALESCE($deleted_for, deleted_for),
      deleted_by = COALESCE($deleted_by, deleted_by),
      placeholder_text = COALESCE($placeholder_text, placeholder_text),
      is_edited = MAX(is_edited, $is_edited),
      edited_at = COALESCE($edited_at, edited_at),
      media_url = COALESCE($media_url, media_url),
      media_type = COALESCE($media_type, media_type),
      preview_url = COALESCE($preview_url, preview_url),
      local_uri = COALESCE($local_uri, local_uri),
      media_id = COALESCE($media_id, media_id),
      reactions = COALESCE($reactions, reactions),
      delivered_to = COALESCE($delivered_to, delivered_to),
      read_by = COALESCE($read_by, read_by),
      payload = COALESCE($payload, payload),
      extra = COALESCE($extra, extra)`,
    baseParams);
  }
  }; // end runSQL

  try {
    await runSQL();
  } catch (err) {
    // Handle unique constraint violation on server_message_id:
    // Another row with the same server_message_id but different id exists
    if (!_retried && err?.message?.includes('UNIQUE') && msg.serverMessageId) {
      await db.runAsync(`DELETE FROM messages WHERE server_message_id = $s AND id != $id`, { $s: msg.serverMessageId, $id: id });
      return _runInsert(db, msg, true);
    }
    throw err;
  }
};

/**
 * Preserve locally edited/deleted state when server sends stale data.
 */
const _preserveLocalState = async (db, msg) => {
  const id = msg.serverMessageId || msg.id || msg.tempId;
  if (!id) return null;

  let existing = null;
  try {
    existing = await db.getFirstAsync(`SELECT * FROM messages WHERE id = $id OR server_message_id = $id OR temp_id = $id LIMIT 1`, { $id: id });
  } catch {}

  if (!existing && msg.senderId && msg.timestamp) {
    const ts = Number(msg.timestamp || 0);
    if (ts > 0) {
      try {
        existing = await db.getFirstAsync(
          `SELECT * FROM messages WHERE chat_id = $cid AND sender_id = $sid AND id LIKE 'temp_%' AND ABS(timestamp - $ts) < 5000 ORDER BY is_edited DESC LIMIT 1`,
          { $cid: msg.chatId, $sid: msg.senderId, $ts: ts }
        );
        if (existing?.id) await db.runAsync(`DELETE FROM messages WHERE id = $id`, { $id: existing.id });
      } catch {}
    }
  }

  if (!existing) return null;

  let merged = null;
  if (existing.is_edited && !msg.isEdited && !msg.editedAt) merged = { ...msg, text: existing.text, isEdited: true, editedAt: new Date().toISOString() };
  if (!merged && existing.is_deleted && !msg.isDeleted) merged = { ...msg, text: 'This message was deleted', isDeleted: true, deletedFor: existing.deleted_for, mediaUrl: null, previewUrl: null, localUri: null };
  if (!merged && existing.local_uri && !msg.localUri) merged = { ...msg, localUri: existing.local_uri, previewUrl: msg.previewUrl || existing.local_uri };

  if (!merged) {
    const ip = STATUS_PRIORITY[msg.status] || 0;
    const ep = STATUS_PRIORITY[existing.status] || 0;
    // Don't override an explicitly-set 'scheduled'/'processing' status with a higher-priority one
    if (ep > ip && msg.status !== 'scheduled' && msg.status !== 'processing') merged = { ...msg, status: existing.status };
    // Protect existing 'scheduled'/'processing' status from being overwritten by server sync data
    // Only clearScheduleData() or updateMessageStatus() should transition scheduled → sent
    if ((existing.status === 'scheduled' || existing.status === 'processing') && msg.status !== 'scheduled' && msg.status !== 'processing') {
      const existPayload = parseJSON(existing.payload);
      if (existPayload?.isScheduled) {
        merged = { ...msg, status: existing.status, isScheduled: true, scheduleTime: existPayload.scheduleTime, scheduleTimeLabel: existPayload.scheduleTimeLabel };
      }
    }
  }

  // Preserve reactions — don't let server sync overwrite local reactions with empty/null
  const incomingHasReactions = msg.reactions && typeof msg.reactions === 'object' && Object.keys(msg.reactions).length > 0;
  if (existing.reactions && !incomingHasReactions) {
    try {
      const r = JSON.parse(existing.reactions);
      if (r && Object.keys(r).length > 0) {
        if (merged) merged.reactions = r; else merged = { ...msg, reactions: r };
      }
    } catch {}
  }

  return merged;
};

// ─── LOAD ───────────────────────────────────────────────

const loadMessages = async (chatId, opts = {}) => {
  if (!chatId) return [];
  const { limit = 50, offset = 0, afterTimestamp = 0, beforeTimestamp = 0, skipCleanup = false } = opts;

  // ── STEP 1: Lightweight cleanup — only run on first load (not every refresh) ──
  // This is a WRITE on the read path; route it through the write mutex so it can't
  // race the exclusive-transaction batch writers (was a silent SQLITE_BUSY source).
  if (!skipCleanup) {
    try {
      await runExclusive(async () => {
        const wdb = await getDB();
        await wdb.runAsync(
          `DELETE FROM messages WHERE chat_id = $cid AND id LIKE 'temp_%' AND server_message_id IS NOT NULL`,
          { $cid: chatId }
        );
      });
    } catch {}
  }

  // ── STEP 2: Load raw rows using indexed query ──
  // `beforeTimestamp` is the OLDER-history pagination cursor: it loads the page of
  // messages strictly older than the oldest one currently shown. Cursor-based
  // paging is immune to the offset drift that happens when the displayed list
  // count (after dedup + optimistic/scheduled rows) diverges from the SQLite row
  // count — the old `offset` paging could skip rows or get stuck and never reveal
  // older history on a cold-start scroll-up.
  //
  // Run on the dedicated READER connection so this first-paint query reads the
  // last committed snapshot immediately instead of queueing behind the writer
  // storm on the shared connection.
  const rows = await _readQuery(async (db) => {
    if (beforeTimestamp > 0) {
      return db.getAllAsync(
        `SELECT * FROM messages WHERE chat_id = $cid AND timestamp < $bts ORDER BY timestamp DESC LIMIT $lim`,
        { $cid: chatId, $bts: beforeTimestamp, $lim: limit }
      );
    }
    if (afterTimestamp > 0) {
      return db.getAllAsync(
        `SELECT * FROM messages WHERE chat_id = $cid AND timestamp > $ts ORDER BY timestamp DESC LIMIT $lim OFFSET $off`,
        { $cid: chatId, $ts: afterTimestamp, $lim: limit, $off: offset }
      );
    }
    return db.getAllAsync(
      `SELECT * FROM messages WHERE chat_id = $cid ORDER BY timestamp DESC LIMIT $lim OFFSET $off`,
      { $cid: chatId, $lim: limit, $off: offset }
    );
  });

  if (rows.length === 0) return [];

  // ── STEP 3: Batch-lookup reply data ──
  let replyMap = {};
  try {
    const allIds = [];
    for (const row of rows) {
      if (row.id) allIds.push(row.id);
      if (row.server_message_id && row.server_message_id !== row.id) allIds.push(row.server_message_id);
      if (row.temp_id && row.temp_id !== row.id) allIds.push(row.temp_id);
    }
    if (allIds.length > 0) {
      const BATCH = 200;
      for (let i = 0; i < allIds.length; i += BATCH) {
        const batch = allIds.slice(i, i + BATCH);
        const ph = batch.map(() => '?').join(',');
        const replyRows = await _readQuery((db) => db.getAllAsync(`SELECT * FROM message_replies WHERE message_id IN (${ph})`, batch));
        for (const r of replyRows) {
          replyMap[r.message_id] = {
            replyToMessageId: r.reply_to_message_id,
            replyPreviewText: r.reply_preview_text,
            replyPreviewType: r.reply_preview_type,
            replySenderName: r.reply_sender_name,
            replySenderId: r.reply_sender_id,
          };
        }
      }
    }
  } catch {}

  // ── STEP 4: Convert rows + enrich with reply data ──
  const allMsgs = [];
  for (const row of rows) {
    const msg = rowToMsg(row);
    if (!msg) continue;
    if (!msg.replyToMessageId) {
      const rd = replyMap[msg.id] || replyMap[msg.serverMessageId] || replyMap[msg.tempId];
      if (rd) Object.assign(msg, rd);
    }
    allMsgs.push(msg);
  }

  // ── STEP 5: Fast ID-based dedup (fingerprint only needed for temp rows) ──
  const seenIds = new Set();
  const result = [];

  for (const msg of allMsgs) {
    const ids = [msg.serverMessageId, msg.id, msg.tempId].filter(Boolean);
    if (ids.some(id => seenIds.has(id))) continue;

    // Only fingerprint-check temp rows — server-confirmed rows are unique by ID
    if (msg.id && String(msg.id).startsWith('temp_') && msg.senderId && msg.text != null) {
      const roundedTs = Math.round((msg.timestamp || 0) / 30000);
      const fp = `${msg.senderId}|${msg.text}|${roundedTs}`;
      if (seenIds.has(fp) || seenIds.has(`${msg.senderId}|${msg.text}|${roundedTs - 1}`) || seenIds.has(`${msg.senderId}|${msg.text}|${roundedTs + 1}`)) continue;
      seenIds.add(fp);
    }

    for (const id of ids) seenIds.add(id);
    result.push(msg);
  }

  return result;
};

const getMessage = async (messageId) => {
  if (!messageId) return null;
  const db = await getDB();
  const row = await db.getFirstAsync(`SELECT * FROM messages WHERE id = $id OR server_message_id = $id OR temp_id = $id LIMIT 1`, { $id: messageId });
  return rowToMsg(row);
};

const findTempRowByContent = async (chatId, senderId, text, timestamp) => {
  if (!chatId || !senderId) return null;
  const db = await getDB();
  try {
    const row = await db.getFirstAsync(
      `SELECT * FROM messages WHERE chat_id = $cid AND sender_id = $sid AND id LIKE 'temp_%' AND text = $text AND ABS(timestamp - $ts) < 10000 LIMIT 1`,
      { $cid: chatId, $sid: senderId, $text: text || '', $ts: timestamp || 0 }
    );
    return row ? rowToMsg(row) : null;
  } catch { return null; }
};

const messageExists = async (messageId) => {
  if (!messageId) return false;
  const db = await getDB();
  const r = await db.getFirstAsync(`SELECT 1 FROM messages WHERE id = $id OR server_message_id = $id OR temp_id = $id LIMIT 1`, { $id: messageId });
  return Boolean(r);
};

const acknowledgeMessage = async (tempId, serverMessageId) => {
  if (!tempId || !serverMessageId) return;
  return runExclusive(async () => {
  const db = await getDB();

  const serverRow = await db.getFirstAsync(`SELECT id, is_edited, status FROM messages WHERE id = $s OR server_message_id = $s LIMIT 1`, { $s: serverMessageId });
  const tempRow = await db.getFirstAsync(`SELECT id, is_edited, status, payload, reply_to_message_id, reply_preview_text, reply_preview_type, reply_sender_name, reply_sender_id FROM messages WHERE id = $t OR temp_id = $t LIMIT 1`, { $t: tempId });

  // Preserve 'scheduled'/'processing' status — don't overwrite it with 'sent' during acknowledge.
  // Also preserve any HIGHER status (delivered/seen/read) that may already be on the temp OR
  // server row from prior status events — without this, re-acknowledging an already-delivered
  // message on chat re-open silently downgrades the bubble back to single tick.
  const tempPayload = tempRow ? parseJSON(tempRow.payload) : null;
  const isScheduledMsg = tempRow?.status === 'scheduled' || tempRow?.status === 'processing' || tempPayload?.isScheduled;
  const pickHigher = (a, b) => ((STATUS_PRIORITY[a] || 0) >= (STATUS_PRIORITY[b] || 0) ? a : b);
  const ackStatus = isScheduledMsg
    ? (tempRow?.status || 'scheduled')
    : pickHigher(pickHigher(tempRow?.status || 'sent', serverRow?.status || 'sent'), 'sent');

  if (serverRow && tempRow && serverRow.id !== tempRow.id) {
    // Rescue reactions from temp row before it gets deleted
    let tempReactions = null;
    try {
      const tempFull = await db.getFirstAsync(`SELECT reactions FROM messages WHERE id = $t LIMIT 1`, { $t: tempRow.id });
      if (tempFull?.reactions) tempReactions = tempFull.reactions;
    } catch {}

    if (tempRow.is_edited && !serverRow.is_edited) {
      await db.runAsync(`DELETE FROM messages WHERE id = $s`, { $s: serverRow.id });
      await db.runAsync(`UPDATE messages SET id = $s, server_message_id = $s, synced = 1, status = $st WHERE id = $t`, { $s: serverMessageId, $t: tempRow.id, $st: ackStatus });
    } else {
      // Before deleting temp row, copy its reply data and reactions to the server row
      if (_hasReplyColumns && tempRow.reply_to_message_id) {
        await db.runAsync(
          `UPDATE messages SET
            reply_to_message_id = COALESCE(reply_to_message_id, $rid),
            reply_preview_text = COALESCE(reply_preview_text, $rtext),
            reply_preview_type = COALESCE(reply_preview_type, $rtype),
            reply_sender_name = COALESCE(reply_sender_name, $rname),
            reply_sender_id = COALESCE(reply_sender_id, $rsid),
            temp_id = COALESCE(temp_id, $tempId)
          WHERE id = $s`,
          {
            $s: serverRow.id,
            $rid: tempRow.reply_to_message_id,
            $rtext: tempRow.reply_preview_text || null,
            $rtype: tempRow.reply_preview_type || null,
            $rname: tempRow.reply_sender_name || null,
            $rsid: tempRow.reply_sender_id || null,
            $tempId: tempId,
          }
        );
      }
      // Copy reactions from temp row to server row if server row has none
      if (tempReactions) {
        await db.runAsync(
          `UPDATE messages SET reactions = COALESCE(reactions, $r), temp_id = COALESCE(temp_id, $tempId) WHERE id = $s`,
          { $s: serverRow.id, $r: tempReactions, $tempId: tempId }
        );
      }
      await db.runAsync(`DELETE FROM messages WHERE id = $t`, { $t: tempRow.id });
    }
  } else if (tempRow && !serverRow) {
    await db.runAsync(`UPDATE messages SET id = $s, server_message_id = $s, synced = 1, status = $st WHERE temp_id = $t OR id = $t`, { $s: serverMessageId, $t: tempId, $st: ackStatus });
  }

  // Copy reply data to serverId in permanent table
  const rd = await getReplyData(tempId);
  if (rd) saveReplyData(serverMessageId, rd).catch(() => {});

  // NUCLEAR CLEANUP: after acknowledge, delete ALL remaining temp rows that could
  // be orphans of this same message (matched by sender + text + timestamp).
  // This catches stale temp rows re-created by saveMessagesToLocal race conditions.
  try {
    const finalRow = await db.getFirstAsync(`SELECT chat_id, sender_id, text, timestamp FROM messages WHERE id = $s OR server_message_id = $s LIMIT 1`, { $s: serverMessageId });
    if (finalRow && finalRow.sender_id && finalRow.timestamp) {
      await db.runAsync(
        `DELETE FROM messages WHERE chat_id = $cid AND sender_id = $sid AND id LIKE 'temp_%' AND text = $text AND ABS(timestamp - $ts) < 30000`,
        { $cid: finalRow.chat_id, $sid: finalRow.sender_id, $text: finalRow.text || '', $ts: finalRow.timestamp }
      );
    }
  } catch {}
  });
};

// ── Coalesced message-status writer ──────────────────────────────────────
// Delivery/read receipts arrive PER-MESSAGE in bursts; writing each as its own
// UPDATE was the dominant SQLITE_BUSY source (each raced the exclusive-transaction
// batch writers for the WAL lock). We buffer status changes for a short window and
// flush them as ONE multi-row UPDATE per target status — through `runExclusive`, so
// they serialize with every other writer. Monotonic by construction: a row is only
// advanced from a strictly-lower standard status (priority > 0 and < target), so
// out-of-order/replayed events never downgrade, and protected statuses
// (scheduled/cancelled/processing/failed = priority 0) are never overwritten.
const STATUS_COALESCE_MS = 150;
let _statusBuffer = new Map();      // messageId -> highest-rank target status
let _statusFlushTimer = null;
let _statusFlushPromise = null;
let _statusFlushResolve = null;

const _flushStatusBuffer = async () => {
  _statusFlushTimer = null;
  const resolveFlush = _statusFlushResolve;
  _statusFlushResolve = null;
  _statusFlushPromise = null;
  if (_statusBuffer.size === 0) { if (resolveFlush) resolveFlush(); return; }

  const buf = _statusBuffer;
  _statusBuffer = new Map();

  // Group ids by target status so each status is one UPDATE … WHERE id IN (…).
  const byStatus = new Map();
  for (const [id, status] of buf) {
    if (!byStatus.has(status)) byStatus.set(status, []);
    byStatus.get(status).push(String(id));
  }

  try {
    await runExclusive(async () => {
      const db = await getDB();
      for (const [status, ids] of byStatus) {
        const tp = STATUS_PRIORITY[status] || 0;
        // Only standard statuses strictly below the target (excludes the
        // priority-0 protected set automatically).
        const lower = Object.entries(STATUS_PRIORITY)
          .filter(([, p]) => p > 0 && p < tp)
          .map(([s]) => s);
        if (!lower.length) continue;
        const CHUNK = 200; // keep bound SQLite variable count sane
        for (let i = 0; i < ids.length; i += CHUNK) {
          const slice = ids.slice(i, i + CHUNK);
          const idPh = slice.map(() => '?').join(',');
          const stPh = lower.map(() => '?').join(',');
          await db.runAsync(
            `UPDATE messages SET status = ?
             WHERE (id IN (${idPh}) OR server_message_id IN (${idPh}) OR temp_id IN (${idPh}))
               AND status IN (${stPh})`,
            [status, ...slice, ...slice, ...slice, ...lower]
          );
        }
      }
    });
  } catch (err) {
    console.warn('[ChatDB] status flush error:', err?.message);
  } finally {
    if (resolveFlush) resolveFlush();
  }
};

// Public API unchanged: callers still call updateMessageStatus(id, status) and may
// await the returned promise (resolves when the coalesced flush lands).
const updateMessageStatus = async (messageId, newStatus) => {
  if (!messageId || !newStatus) return false;
  const np = STATUS_PRIORITY[newStatus] || 0;

  // Protected / unknown target (scheduled/cancelled/processing/failed → priority 0):
  // not part of the monotonic forward chain, so write it directly (serialized),
  // bypassing the coalescer. Rare path (e.g. marking a send failed).
  if (np <= 0) {
    return runExclusive(async () => {
      const db = await getDB();
      await db.runAsync(
        `UPDATE messages SET status = $s WHERE id = $id OR server_message_id = $id OR temp_id = $id`,
        { $s: newStatus, $id: String(messageId) }
      );
      return true;
    }).catch((err) => { console.warn('[ChatDB] updateMessageStatus(direct) error:', err?.message); return false; });
  }

  const key = String(messageId);
  const prev = _statusBuffer.get(key);
  if (!prev || (STATUS_PRIORITY[prev] || 0) < np) {
    _statusBuffer.set(key, newStatus); // keep only the highest-rank target
  }
  // Big burst → flush now rather than waiting out the window.
  if (_statusBuffer.size >= 200) {
    if (_statusFlushTimer) { clearTimeout(_statusFlushTimer); _statusFlushTimer = null; }
    _flushStatusBuffer().catch(() => {});
  } else if (!_statusFlushTimer) {
    _statusFlushTimer = setTimeout(() => { _flushStatusBuffer().catch(() => {}); }, STATUS_COALESCE_MS);
  }
  // Resolve immediately: callers are fire-and-forget and the UI reads live state
  // from Redux, not this cache. The buffered row lands within the coalesce window.
  // (Returning the flush promise here would block SqliteWriter._drain ~150ms per
  // op and defeat coalescing.)
  return true;
};

// Bulk-mark all outgoing (sent/delivered) messages in a chat as 'seen' (blue tick)
// Called when the peer reads everything — e.g. message:read:all:ack arrives.
const updateAllSentMessagesInChatToSeen = async (chatId, myUserId) => {
  if (!chatId || !myUserId) return 0;
  // Serialize through the global write mutex. This is a high-frequency single
  // statement writer (fires on every message:read:all:ack); run bare it raced the
  // exclusive-transaction batch writers (upsertMessages / status feed / presence)
  // for the WAL writer lock and threw "database is locked". runExclusive queues it
  // behind any in-flight batch instead of competing for the lock.
  try {
    return await runExclusive(async () => {
      const db = await getDB();
      const result = await db.runAsync(
        `UPDATE messages SET status = 'seen'
         WHERE chat_id = $cid
           AND sender_id = $uid
           AND status IN ('sent', 'delivered')
           AND (is_deleted = 0 OR is_deleted IS NULL)`,
        { $cid: chatId, $uid: myUserId }
      );
      return result?.changes || 0;
    });
  } catch (err) {
    console.warn('[ChatDB] updateAllSentMessagesInChatToSeen error:', err?.message);
    return 0;
  }
};

// Update the last_message_status column in the chats table (chat list tick)
const updateChatLastMessageStatus = async (chatId, newStatus) => {
  if (!chatId || !newStatus) return;
  try {
    await runExclusive(async () => {
      const db = await getDB();
      await db.runAsync(
        `UPDATE chats SET last_message_status = $s, updated_at = $n WHERE chat_id = $id`,
        { $s: newStatus, $n: Date.now(), $id: chatId }
      );
    });
  } catch (err) {
    console.warn('[ChatDB] updateChatLastMessageStatus error:', err?.message);
  }
};

// Clear schedule data from payload when a scheduled message is delivered
const clearScheduleData = async (messageId, newStatus = 'sent') => {
  if (!messageId) return;
  try {
    await runExclusive(async () => {
      const db = await getDB();
      const row = await db.getFirstAsync(
        `SELECT id, payload FROM messages WHERE id = $id OR server_message_id = $id OR temp_id = $id LIMIT 1`,
        { $id: messageId }
      );
      if (!row) return;
      const payload = parseJSON(row.payload);
      if (payload) {
        delete payload.isScheduled;
        delete payload.scheduleTime;
        // Keep scheduleTimeLabel for visual indicator on delivered scheduled messages
        payload.wasScheduled = true;
        await db.runAsync(
          `UPDATE messages SET status = $s, payload = $p WHERE id = $rid`,
          { $s: newStatus, $p: JSON.stringify(payload), $rid: row.id }
        );
      } else {
        await db.runAsync(
          `UPDATE messages SET status = $s WHERE id = $rid`,
          { $s: newStatus, $rid: row.id }
        );
      }
    });
  } catch (err) {
    console.warn('[ChatDB] clearScheduleData error:', err);
  }
};

const markMessageDeleted = async (messageId, deletedBy, placeholderText) => {
  if (!messageId) return;
  await runExclusive(async () => {
    const db = await getDB();
    await db.runAsync(
      `UPDATE messages SET is_deleted = 1, deleted_for = 'everyone', deleted_by = $by, placeholder_text = $ph, text = $ph, type = 'system', media_url = NULL, media_type = NULL, preview_url = NULL, local_uri = NULL WHERE id = $id OR server_message_id = $id OR temp_id = $id`,
      { $id: messageId, $by: deletedBy || null, $ph: placeholderText || 'This message was deleted' }
    );
  });
};

const deleteMessageForMe = async (messageId) => {
  if (!messageId) return;
  await runExclusive(async () => {
    const db = await getDB();
    await db.runAsync(`DELETE FROM messages WHERE id = $id OR server_message_id = $id OR temp_id = $id`, { $id: messageId });
  });
};

const updateReactions = async (messageId, reactions) => {
  if (!messageId) return;
  await runExclusive(async () => {
    const db = await getDB();
    await db.runAsync(`UPDATE messages SET reactions = $r WHERE id = $id OR server_message_id = $id OR temp_id = $id`, { $id: messageId, $r: reactions ? JSON.stringify(reactions) : null });
  });
};

const updateMessageEdit = async (messageId, newText, editedAt) => {
  if (!messageId || !newText) return;
  try {
    await runExclusive(async () => {
      const db = await getDB();
      await db.runAsync(`UPDATE messages SET text = $t, is_edited = 1, edited_at = $e WHERE id = $id OR server_message_id = $id OR temp_id = $id`, { $id: messageId, $t: newText, $e: editedAt || new Date().toISOString() });
    });
  } catch (err) { console.warn('[ChatDB] updateMessageEdit error:', err); }
};

const clearChat = async (chatId, clearedAt = null) => {
  if (!chatId) return;
  await runExclusive(async () => {
    const db = await getDB();
    if (clearedAt) {
      await db.runAsync(`DELETE FROM messages WHERE chat_id = $c AND timestamp <= $t`, { $c: chatId, $t: clearedAt });
    } else {
      await db.runAsync(`DELETE FROM messages WHERE chat_id = $c`, { $c: chatId });
    }
    await db.runAsync(`INSERT OR REPLACE INTO chat_meta (chat_id, cleared_at, updated_at) VALUES ($c, $t, $n)`, { $c: chatId, $t: clearedAt || Date.now(), $n: Date.now() });
  });
};

const getClearedAt = async (chatId) => {
  if (!chatId) return 0;
  const r = await _readQuery((db) => db.getFirstAsync(`SELECT cleared_at FROM chat_meta WHERE chat_id = $c`, { $c: chatId }));
  return r?.cleared_at || 0;
};

const getMessageCount = async (chatId) => {
  if (!chatId) return 0;
  const r = await _readQuery((db) => db.getFirstAsync(`SELECT COUNT(*) as count FROM messages WHERE chat_id = $c`, { $c: chatId }));
  return r?.count || 0;
};

const updateGroupMessageTracking = async (messageId, { deliveredTo, readBy } = {}) => {
  if (!messageId) return;
  const u = []; const p = { $id: messageId };
  if (deliveredTo) { u.push('delivered_to = $dt'); p.$dt = JSON.stringify(deliveredTo); }
  if (readBy) { u.push('read_by = $rb'); p.$rb = JSON.stringify(readBy); }
  if (u.length === 0) return;
  await runExclusive(async () => {
    const db = await getDB();
    await db.runAsync(`UPDATE messages SET ${u.join(', ')} WHERE id = $id OR server_message_id = $id OR temp_id = $id`, p);
  });
};

const searchMessages = async (chatId, query, limit = 50) => {
  if (!chatId || !query) return [];
  const db = await getDB();
  const rows = await db.getAllAsync(`SELECT * FROM messages WHERE chat_id = $c AND text LIKE $q AND is_deleted = 0 ORDER BY timestamp DESC LIMIT $l`, { $c: chatId, $q: `%${query}%`, $l: limit });
  return rows.map(rowToMsg);
};

const getLatestMessage = async (chatId) => {
  if (!chatId) return null;
  const db = await getDB();
  const r = await db.getFirstAsync(`SELECT * FROM messages WHERE chat_id = $c ORDER BY timestamp DESC LIMIT 1`, { $c: chatId });
  return rowToMsg(r);
};

/**
 * Highest server-assigned `seq` known locally for a chat. Used by the
 * reconnect catchup path — the client sends this value, the server
 * returns every message with seq > this. Robust against soft-deletes:
 * a deleted-for-me message still has its seq, so the cursor never gets
 * "stuck" on a missing row the way lastMessageId-based sync did.
 */
const getLatestSeq = async (chatId) => {
  if (!chatId) return 0;
  const db = await getDB();
  const r = await db.getFirstAsync(
    `SELECT MAX(seq) as max_seq FROM messages WHERE chat_id = $c AND seq IS NOT NULL`,
    { $c: chatId }
  );
  return Number(r?.max_seq || 0);
};

/**
 * Lowest server-assigned `seq` known locally for a chat — the OLDER-history
 * backfill cursor. The client asks the server for messages with seq < this.
 * Derived live (MIN(seq)) rather than stored, so it always reflects exactly
 * what is persisted: after each backfilled chunk lands the floor moves down on
 * its own, which makes a kill-mid-backfill resume automatic (no progress column
 * to keep in sync). Returns 0 when the chat has no seq'd messages locally, which
 * the caller sends as "no cursor" → the server returns the NEWEST page.
 */
const getOldestSeq = async (chatId) => {
  if (!chatId) return 0;
  const db = await getDB();
  const r = await db.getFirstAsync(
    `SELECT MIN(seq) as min_seq FROM messages WHERE chat_id = $c AND seq IS NOT NULL`,
    { $c: chatId }
  );
  return Number(r?.min_seq || 0);
};

// Per-chat "reached the first message — stop asking the server" flag. Stored in
// sync_meta (serialized KV) so no schema migration is needed. Set once the
// history endpoint reports hasMore=false; checked before every network backfill.
const _historyDoneKey = (chatId) => `hist_done:${chatId}`;
const isHistoryFullyLoaded = async (chatId) => {
  if (!chatId) return false;
  try { return (await getSyncMeta(_historyDoneKey(chatId))) === '1'; }
  catch { return false; }
};
const setHistoryFullyLoaded = async (chatId, done = true) => {
  if (!chatId) return;
  try { await setSyncMeta(_historyDoneKey(chatId), done ? '1' : '0'); }
  catch (e) { console.warn('[ChatDB] setHistoryFullyLoaded failed:', e?.message); }
};

// Every distinct chat_id this device has any local message for. Used by the
// reconnect catch-up to ask the server for missed messages PER chat: it reads
// from the persistent DB (available immediately on cold start) rather than the
// in-memory chat list, which loads asynchronously and is often empty/partial at
// the moment the socket first connects — the gap that left some missed messages
// unfetched on reopen.
const getAllChatIds = async () => {
  try {
    const db = await getDB();
    const rows = await db.getAllAsync(
      `SELECT DISTINCT chat_id FROM messages WHERE chat_id IS NOT NULL AND chat_id != ''`
    );
    return (rows || []).map((r) => r.chat_id).filter(Boolean);
  } catch (_) {
    return [];
  }
};

const deduplicateChat = async (chatId) => {
  if (!chatId) return;
  // Serialize the 4 maintenance DELETEs through the global write mutex + a
  // transaction so they neither interleave with a concurrent send/sync batch
  // (→ "database is locked") nor leave the chat half-deduped if interrupted.
  return runExclusiveBatch(() =>
    _runCacheWrite('deduplicateChat', async (db) => {
      // 1. Remove exact primary key duplicates (shouldn't happen but safety net)
      await db.runAsync(`DELETE FROM messages WHERE rowid NOT IN (SELECT MIN(rowid) FROM messages WHERE chat_id = $c GROUP BY id) AND chat_id = $c`, { $c: chatId });
      // 2. Remove temp rows that have a server-confirmed version (by temp_id link)
      await db.runAsync(`DELETE FROM messages WHERE chat_id = $c AND server_message_id IS NULL AND temp_id IS NOT NULL AND temp_id IN (SELECT temp_id FROM messages WHERE chat_id = $c AND server_message_id IS NOT NULL)`, { $c: chatId });
      // 3. Remove temp rows with a content-matching server row (30s window)
      await db.runAsync(`DELETE FROM messages WHERE chat_id = $c AND id LIKE 'temp_%' AND EXISTS (SELECT 1 FROM messages s WHERE s.chat_id = $c AND s.id NOT LIKE 'temp_%' AND s.sender_id = messages.sender_id AND s.text = messages.text AND ABS(s.timestamp - messages.timestamp) < 30000)`, { $c: chatId });
      // 4. Remove any remaining content duplicates (same sender + text within 30s), keep newest
      await db.runAsync(`
        DELETE FROM messages WHERE chat_id = $c AND rowid NOT IN (
          SELECT MAX(rowid) FROM messages WHERE chat_id = $c
          GROUP BY sender_id, text, CAST(timestamp / 30000 AS INTEGER)
        )
      `, { $c: chatId });
    }),
  );
};

const bulkUpdateStatus = async (chatId, newStatus, opts = {}) => {
  if (!chatId || !newStatus) return;
  await runExclusive(async () => {
    const db = await getDB();
    if (opts.senderIdNot) {
      // Only advance from a strictly-lower standard status (priority > 0), so
      // protected statuses (scheduled/cancelled/processing, priority 0) survive.
      const cs = Object.entries(STATUS_PRIORITY).filter(([, p]) => p > 0 && p < (STATUS_PRIORITY[newStatus] || 0)).map(([s]) => `'${s}'`).join(',');
      if (!cs) return;
      await db.runAsync(`UPDATE messages SET status = $s WHERE chat_id = $c AND sender_id != $sid AND status IN (${cs})`, { $s: newStatus, $c: chatId, $sid: opts.senderIdNot });
    } else {
      await db.runAsync(`UPDATE messages SET status = $s WHERE chat_id = $c`, { $s: newStatus, $c: chatId });
    }
  });
};

const closeDB = async () => {
  _dbInitPromise = null;
  await _closeReadDB();
  if (_db) {
    try { await _db.closeAsync(); } catch {}
    _db = null;
  }
};

// Clean-close path. We open in WAL mode intentionally (PRAGMA journal_mode = WAL
// in _initDB) for concurrent read/write throughput, but a process kill mid-write
// can leave a partial WAL that bricks the next open (the cause-B corruption that
// the delete-and-recreate self-heal exists to recover from). Checkpointing the
// WAL back into the main DB and TRUNCATEing it on a graceful exit makes that far
// less likely. Call from an AppState 'background'/'inactive' handler and on
// logout/session-reset. Best-effort: never throws.
const closeCleanly = async () => {
  _dbInitPromise = null;
  // Close the reader first so the checkpoint/truncate on the primary isn't held
  // back by an open read connection on the same WAL.
  await _closeReadDB();
  if (!_db) return;
  try { await _db.execAsync('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
  try { await _db.closeAsync(); } catch {}
  _db = null;
};

// ─── CHATLIST (chats table) ──────────────────────────────

const _chatToRow = (chat) => {
  if (!chat) return null;
  const chatId = chat.chatId || chat._id;
  if (!chatId) return null;
  const isGroup = chat.chatType === 'group' || Boolean(chat.isGroup);
  const lm = chat.lastMessage || {};
  // Handle peerUser from flat API format (peerUserId + chatName + chatAvatar)
  const peerUserObj = isGroup ? null : (chat.peerUser || chat.otherUser || (chat.peerUserId ? { _id: chat.peerUserId, fullName: chat.chatName, profileImage: chat.chatAvatar } : null));
  return {
    $chatId: String(chatId),
    $chatType: chat.chatType || (isGroup ? 'group' : 'private'),
    $isGroup: isGroup ? 1 : 0,
    $peerUser: isGroup ? null : JSON.stringify(peerUserObj),
    $groupData: isGroup ? JSON.stringify(chat.group || (chat.groupId ? { _id: chat.groupId, name: chat.chatName, avatar: chat.chatAvatar } : null)) : null,
    $groupId: chat.groupId || chat.group?._id || (isGroup ? chatId : null),
    $chatName: chat.chatName || chat.groupName || chat.group?.name || peerUserObj?.fullName || null,
    $chatAvatar: chat.chatAvatar || chat.groupAvatar || chat.group?.avatar || peerUserObj?.profileImage || null,
    $lmText: lm.text || null,
    $lmType: lm.type || lm.messageType || 'text',
    $lmSenderId: lm.senderId || null,
    $lmSenderName: lm.senderName || null,
    $lmStatus: lm.status || null,
    $lmAt: chat.lastMessageAt || lm.createdAt || null,
    $lmId: lm.serverMessageId || lm.messageId || lm.id || null,
    $lmEdited: lm.isEdited ? 1 : 0,
    $lmDeleted: lm.isDeleted ? 1 : 0,
    $unread: Number(chat.unreadCount || 0),
    $pinned: chat.isPinned ? 1 : 0,
    $pinnedAt: chat.pinnedAt || null,
    $muted: chat.isMuted ? 1 : 0,
    $muteUntil: chat.muteUntil || null,
    $archived: (chat.isArchived || chat.archived) ? 1 : 0,
    $members: isGroup && Array.isArray(chat.members) ? JSON.stringify(chat.members) : null,
    $memberCount: chat.memberCount || chat.members?.length || 0,
    $createdAt: chat.createdAt || null,
    $updatedAt: Date.now(),
    $rawData: JSON.stringify(chat),
  };
};

const _rowToChat = (row) => {
  if (!row) return null;
  const peerUser = parseJSON(row.peer_user);
  const group = parseJSON(row.group_data);
  const members = parseJSON(row.members);
  const raw = parseJSON(row.raw_data) || {};
  const isGroup = Boolean(row.is_group);
  return {
    ...raw,
    chatId: row.chat_id,
    _id: row.chat_id,
    chatType: row.chat_type || 'private',
    isGroup,
    peerUser: isGroup ? null : (peerUser || null),
    otherUser: isGroup ? null : (peerUser || null),
    group: group || null,
    groupId: row.group_id || null,
    chatName: row.chat_name || null,
    chatAvatar: row.chat_avatar || null,
    groupName: row.chat_name || null,
    groupAvatar: row.chat_avatar || null,
    lastMessage: {
      text: row.last_message_text || '',
      type: row.last_message_type || 'text',
      senderId: row.last_message_sender_id || null,
      senderName: row.last_message_sender_name || null,
      status: row.last_message_status || null,
      createdAt: row.last_message_at || null,
      serverMessageId: row.last_message_id || null,
      messageId: row.last_message_id || null,
      isEdited: Boolean(row.last_message_is_edited),
      isDeleted: Boolean(row.last_message_is_deleted),
    },
    lastMessageAt: row.last_message_at || null,
    unreadCount: Number(row.unread_count || 0),
    isPinned: Boolean(row.is_pinned),
    pinnedAt: row.pinned_at || null,
    isMuted: Boolean(row.is_muted),
    muteUntil: row.mute_until || null,
    isArchived: Boolean(row.is_archived),
    members: Array.isArray(members) ? members : [],
    memberCount: Number(row.member_count || 0),
    createdAt: row.created_at || null,
  };
};

const UPSERT_CHAT_SQL = `INSERT INTO chats (
  chat_id, chat_type, is_group, peer_user, group_data, group_id,
  chat_name, chat_avatar,
  last_message_text, last_message_type, last_message_sender_id, last_message_sender_name,
  last_message_status, last_message_at, last_message_id,
  last_message_is_edited, last_message_is_deleted,
  unread_count, is_pinned, pinned_at, is_muted, mute_until, is_archived,
  members, member_count, created_at, updated_at, raw_data
) VALUES (
  $chatId, $chatType, $isGroup, $peerUser, $groupData, $groupId,
  $chatName, $chatAvatar,
  $lmText, $lmType, $lmSenderId, $lmSenderName,
  $lmStatus, $lmAt, $lmId,
  $lmEdited, $lmDeleted,
  $unread, $pinned, $pinnedAt, $muted, $muteUntil, $archived,
  $members, $memberCount, $createdAt, $updatedAt, $rawData
) ON CONFLICT(chat_id) DO UPDATE SET
  chat_type = $chatType, is_group = $isGroup,
  peer_user = COALESCE($peerUser, peer_user),
  group_data = COALESCE($groupData, group_data),
  group_id = COALESCE($groupId, group_id),
  chat_name = COALESCE($chatName, chat_name),
  chat_avatar = COALESCE($chatAvatar, chat_avatar),
  last_message_text = $lmText, last_message_type = $lmType,
  last_message_sender_id = $lmSenderId, last_message_sender_name = $lmSenderName,
  last_message_status = $lmStatus, last_message_at = $lmAt, last_message_id = $lmId,
  last_message_is_edited = $lmEdited, last_message_is_deleted = $lmDeleted,
  unread_count = $unread, is_pinned = $pinned, pinned_at = $pinnedAt,
  is_muted = $muted, mute_until = $muteUntil, is_archived = $archived,
  members = COALESCE($members, members),
  member_count = CASE WHEN $memberCount > 0 THEN $memberCount ELSE member_count END,
  updated_at = $updatedAt, raw_data = $rawData`;

const upsertChat = async (chat) => {
  const params = _chatToRow(chat);
  if (!params) return;
  await runExclusive(async () => {
    const db = await getDB();
    await db.runAsync(UPSERT_CHAT_SQL, params);
  });
};

const upsertChats = async (chats) => {
  if (!Array.isArray(chats) || chats.length === 0) return;
  await runExclusive(async () => {
    const db = await getDB();
    for (const chat of chats) {
      const params = _chatToRow(chat);
      if (!params) continue;
      try { await db.runAsync(UPSERT_CHAT_SQL, params); } catch {}
    }
  });
};

const loadChatList = async (opts = {}) => {
  const db = await getDB();
  const { includeArchived = false } = opts;
  const sql = includeArchived
    ? `SELECT * FROM chats ORDER BY is_pinned DESC, last_message_at DESC`
    : `SELECT * FROM chats WHERE is_archived = 0 ORDER BY is_pinned DESC, last_message_at DESC`;
  const rows = await db.getAllAsync(sql);
  return rows.map(_rowToChat).filter(Boolean);
};

const loadArchivedChats = async () => {
  const db = await getDB();
  const rows = await db.getAllAsync(`SELECT * FROM chats WHERE is_archived = 1 ORDER BY last_message_at DESC`);
  return rows.map(_rowToChat).filter(Boolean);
};

const getChatById = async (chatId) => {
  if (!chatId) return null;
  const db = await getDB();
  const row = await db.getFirstAsync(`SELECT * FROM chats WHERE chat_id = $id OR group_id = $id LIMIT 1`, { $id: chatId });
  return _rowToChat(row);
};

// Anti-downgrade map for the chat-list status column. Mirrors STATUS_PRIORITY
// but rounded to the three states the chat list cares about.
const CHAT_STATUS_PRIORITY = { sent: 1, delivered: 2, seen: 3, read: 3 };

const updateChatLastMessage = async (chatId, lm, opts = {}) => {
  if (!chatId || !lm) return;
  return runExclusive(async () => {
  const db = await getDB();
  const now = Date.now();

  // Ensure a row exists so realtime updates aren't no-ops for chats that haven't
  // been hydrated from the API yet (e.g. a brand-new conversation, or a group
  // the user deleted locally that just received a new message). For groups we
  // seed the correct chat_type + name/image/group_data so the restored row is
  // never a blank "private" placeholder. INSERT OR IGNORE only seeds when the
  // row is genuinely missing; existing rows are left untouched.
  const isGroup = Boolean(opts.isGroup);
  await db.runAsync(
    `INSERT OR IGNORE INTO chats (chat_id, chat_type, is_group, group_id, chat_name, chat_avatar, group_data, unread_count, created_at, updated_at)
     VALUES ($chatId, $chatType, $isGroup, $groupId, $chatName, $chatAvatar, $groupData, 0, $now, $now)`,
    {
      $chatId: chatId,
      $chatType: isGroup ? 'group' : 'private',
      $isGroup: isGroup ? 1 : 0,
      $groupId: isGroup ? (opts.groupId || chatId) : null,
      $chatName: opts.chatName || null,
      $chatAvatar: opts.chatAvatar || null,
      $groupData: isGroup
        ? JSON.stringify(opts.group || { _id: opts.groupId || chatId, name: opts.chatName || null, avatar: opts.chatAvatar || null })
        : null,
      $now: now,
    }
  );

  // Anti-downgrade: don't let a stale 'sent' overwrite an existing 'delivered'/'read'
  // for the SAME message. Different message id always wins (it's a new last-message).
  const existing = await db.getFirstAsync(
    `SELECT last_message_id, last_message_status FROM chats WHERE chat_id = $cid LIMIT 1`,
    { $cid: chatId }
  );
  const incomingMsgId = lm.serverMessageId || lm.messageId || lm.id || null;
  const sameMessage = existing?.last_message_id && incomingMsgId
    && String(existing.last_message_id) === String(incomingMsgId);
  const incomingPri = CHAT_STATUS_PRIORITY[lm.status] || 0;
  const existingPri = CHAT_STATUS_PRIORITY[existing?.last_message_status] || 0;
  const keepExistingStatus = sameMessage && incomingPri < existingPri;
  const resolvedStatus = keepExistingStatus ? existing.last_message_status : (lm.status || null);

  await db.runAsync(
    `UPDATE chats SET
      last_message_text = $text, last_message_type = $type,
      last_message_sender_id = $senderId, last_message_sender_name = $senderName,
      last_message_status = $status, last_message_at = $at, last_message_id = $id,
      last_message_is_edited = $edited, last_message_is_deleted = $deleted,
      updated_at = $now
    WHERE chat_id = $chatId`,
    {
      $chatId: chatId,
      $text: lm.text || null,
      $type: lm.type || 'text',
      $senderId: lm.senderId || null,
      $senderName: lm.senderName || null,
      $status: resolvedStatus,
      $at: lm.createdAt || lm.lastMessageAt || now,
      $id: incomingMsgId,
      $edited: lm.isEdited ? 1 : 0,
      $deleted: lm.isDeleted ? 1 : 0,
      $now: now,
    }
  );
  });
};

// Bump only the status column for a chat's last message — used by delivered/read
// socket acks. Anti-downgrade and tied to messageId so an ack for an older
// message can't overwrite the current last-message's status.
const updateChatLastMessageStatusById = async (chatId, messageId, newStatus) => {
  if (!chatId || !messageId || !newStatus) return false;
  return runExclusive(async () => {
    const db = await getDB();
    const row = await db.getFirstAsync(
      `SELECT last_message_id, last_message_status FROM chats WHERE chat_id = $cid LIMIT 1`,
      { $cid: chatId }
    );
    if (!row || String(row.last_message_id) !== String(messageId)) return false;
    const cur = CHAT_STATUS_PRIORITY[row.last_message_status] || 0;
    const nxt = CHAT_STATUS_PRIORITY[newStatus] || 0;
    if (nxt <= cur) return false;
    await db.runAsync(
      `UPDATE chats SET last_message_status = $s, updated_at = $n WHERE chat_id = $cid`,
      { $s: newStatus, $n: Date.now(), $cid: chatId }
    );
    return true;
  });
};

const updateChatUnread = async (chatId, count) => {
  if (!chatId) return;
  await runExclusive(async () => {
    const db = await getDB();
    await db.runAsync(`UPDATE chats SET unread_count = $c, updated_at = $n WHERE chat_id = $id`, { $c: count, $n: Date.now(), $id: chatId });
  });
};

const incrementChatUnread = async (chatId) => {
  if (!chatId) return;
  await runExclusive(async () => {
    const db = await getDB();
    await db.runAsync(`UPDATE chats SET unread_count = unread_count + 1, updated_at = $n WHERE chat_id = $id`, { $n: Date.now(), $id: chatId });
  });
};

const updateChatPin = async (chatId, isPinned, pinnedAt) => {
  if (!chatId) return;
  await runExclusive(async () => {
    const db = await getDB();
    await db.runAsync(`UPDATE chats SET is_pinned = $p, pinned_at = $at, updated_at = $n WHERE chat_id = $id`, { $p: isPinned ? 1 : 0, $at: pinnedAt || null, $n: Date.now(), $id: chatId });
  });
};

const updateChatMute = async (chatId, isMuted, muteUntil) => {
  if (!chatId) return;
  await runExclusive(async () => {
    const db = await getDB();
    await db.runAsync(`UPDATE chats SET is_muted = $m, mute_until = $u, updated_at = $n WHERE chat_id = $id`, { $m: isMuted ? 1 : 0, $u: muteUntil || null, $n: Date.now(), $id: chatId });
  });
};

const updateChatArchive = async (chatId, isArchived) => {
  if (!chatId) return;
  await runExclusive(async () => {
    const db = await getDB();
    await db.runAsync(`UPDATE chats SET is_archived = $a, updated_at = $n WHERE chat_id = $id`, { $a: isArchived ? 1 : 0, $n: Date.now(), $id: chatId });
  });
};

// Targeted update of a group chat's name / avatar / description without
// touching last-message or unread fields. COALESCE keeps existing values when
// a field isn't part of this change. group_data JSON is merged so the chat
// header/list reflect realtime group:name/avatar/description:updated events
// and survive an app restart.
const updateChatGroupMeta = async (chatId, { name, avatar, description } = {}) => {
  if (!chatId) return;
  await runExclusive(async () => {
    const db = await getDB();
    const existing = await db.getFirstAsync(
      `SELECT group_data FROM chats WHERE chat_id = $id LIMIT 1`, { $id: chatId }
    );
    if (!existing) return; // only patch an existing row
    let group = {};
    try { group = existing.group_data ? (JSON.parse(existing.group_data) || {}) : {}; } catch { group = {}; }
    if (name != null) group.name = name;
    if (avatar != null) group.avatar = avatar;
    if (description != null) group.description = description;
    await db.runAsync(
      `UPDATE chats SET
         chat_name = COALESCE($name, chat_name),
         chat_avatar = COALESCE($avatar, chat_avatar),
         group_data = $group,
         updated_at = $n
       WHERE chat_id = $id`,
      {
        $name: name != null ? name : null,
        $avatar: avatar != null ? avatar : null,
        $group: JSON.stringify(group),
        $n: Date.now(),
        $id: chatId,
      }
    );
  });
};

const deleteChatRow = async (chatId) => {
  if (!chatId) return;
  await runExclusive(async () => {
    const db = await getDB();
    await db.runAsync(`DELETE FROM chats WHERE chat_id = $id`, { $id: chatId });
  });
};

const getChatCount = async () => {
  const db = await getDB();
  const r = await db.getFirstAsync(`SELECT COUNT(*) as cnt FROM chats`);
  return r?.cnt || 0;
};

// ─── OUTBOX ─────────────────────────────────────────────
// Durable pending-send queue. A row is INSERTed when a message is composed,
// REMOVEd after the server acks. Survives app kills. The retry worker
// (src/services/OutboxWorker.js) drains it with exponential backoff.

const outboxEnqueue = async ({ clientMessageId, chatId, payload }) => {
  if (!clientMessageId || !chatId) return;
  await runExclusive(async () => {
    const db = await getDB();
    const now = Date.now();
    await db.runAsync(
      `INSERT OR REPLACE INTO outbox
         (client_message_id, chat_id, payload, attempts, next_retry_at, created_at, updated_at)
       VALUES ($c, $cid, $p, 0, 0, $n, $n)`,
      { $c: clientMessageId, $cid: chatId, $p: JSON.stringify(payload), $n: now }
    );
  });
};

const outboxRemove = async (clientMessageId) => {
  if (!clientMessageId) return;
  await runExclusive(async () => {
    const db = await getDB();
    await db.runAsync(`DELETE FROM outbox WHERE client_message_id = $c`, { $c: clientMessageId });
  });
};

const outboxRecordFailure = async (clientMessageId, errMessage) => {
  if (!clientMessageId) return;
  // Read-modify-write under the mutex so a concurrent retry can't lose an attempt.
  return runExclusive(async () => {
    const db = await getDB();
    // Exponential backoff: 2s, 8s, 32s, 2m, 8m, 30m — capped.
    const row = await db.getFirstAsync(
      `SELECT attempts, max_attempts FROM outbox WHERE client_message_id = $c`,
      { $c: clientMessageId }
    );
    const attempts = (row?.attempts || 0) + 1;
    const max = row?.max_attempts || 6;
    const delays = [2_000, 8_000, 32_000, 120_000, 480_000, 1_800_000];
    const delay = delays[Math.min(attempts - 1, delays.length - 1)];
    await db.runAsync(
      `UPDATE outbox
         SET attempts = $a, last_error = $e, next_retry_at = $r, updated_at = $n
       WHERE client_message_id = $c`,
      {
        $a: attempts,
        $e: String(errMessage || '').slice(0, 500),
        $r: Date.now() + delay,
        $n: Date.now(),
        $c: clientMessageId,
      }
    );
    return { attempts, exhausted: attempts >= max };
  });
};

const outboxDrainDue = async (limit = 20) => {
  const db = await getDB();
  const rows = await db.getAllAsync(
    `SELECT * FROM outbox WHERE next_retry_at <= $now ORDER BY created_at ASC LIMIT $l`,
    { $now: Date.now(), $l: limit }
  );
  return rows.map((r) => ({
    ...r,
    payload: r.payload ? safeParse(r.payload) : null,
  }));
};

const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

const outboxCount = async () => {
  const db = await getDB();
  const r = await db.getFirstAsync(`SELECT COUNT(*) as cnt FROM outbox`);
  return r?.cnt || 0;
};

// ─── READ / DELIVERED WATERMARKS (peer-side, drives our outgoing ticks) ───

const setPeerReadWatermark = async (chatId, readUpToSeq, deliveredUpToSeq) => {
  if (!chatId) return;
  await runExclusive(async () => {
    const db = await getDB();
    // Use MAX to never regress the watermark.
    await db.runAsync(
      `UPDATE chats
         SET read_up_to_seq      = MAX(COALESCE(read_up_to_seq, 0),      COALESCE($r, 0)),
             delivered_up_to_seq = MAX(COALESCE(delivered_up_to_seq, 0), COALESCE($d, 0)),
             updated_at = $n
       WHERE chat_id = $cid`,
      {
        $r:  typeof readUpToSeq === 'number'      ? readUpToSeq      : 0,
        $d:  typeof deliveredUpToSeq === 'number' ? deliveredUpToSeq : 0,
        $n:  Date.now(),
        $cid: chatId,
      }
    );
  });
};

const getPeerReadWatermark = async (chatId) => {
  if (!chatId) return { readUpToSeq: 0, deliveredUpToSeq: 0 };
  const db = await getDB();
  const r = await db.getFirstAsync(
    `SELECT read_up_to_seq, delivered_up_to_seq FROM chats WHERE chat_id = $c`,
    { $c: chatId }
  );
  return {
    readUpToSeq:      r?.read_up_to_seq      || 0,
    deliveredUpToSeq: r?.delivered_up_to_seq || 0,
  };
};

// ─── SYNC META ──────────────────────────────────────────

const getSyncMeta = async (key) => {
  if (!key) return null;
  const db = await getDB();
  const r = await db.getFirstAsync(`SELECT value FROM sync_meta WHERE key = $k`, { $k: key });
  return r?.value || null;
};

const setSyncMeta = async (key, value) => {
  if (!key) return;
  // Fires during the initial-sync batch storm — serialize so it can't race the
  // exclusive-transaction sync batches for the writer lock.
  await runExclusive(async () => {
    const db = await getDB();
    await db.runAsync(
      `INSERT INTO sync_meta (key, value, updated_at) VALUES ($k, $v, $n) ON CONFLICT(key) DO UPDATE SET value = $v, updated_at = $n`,
      { $k: key, $v: String(value), $n: Date.now() }
    );
  });
};

const isInitialSyncDone = async (userId) => {
  if (!userId) return false;
  const val = await getSyncMeta('INITIAL_SYNC_COMPLETE');
  return val === String(userId);
};

const clearSyncData = async () => {
  // Full wipe — run as one exclusive, atomic transaction on the batch path so it
  // neither interleaves with a concurrent send/sync batch nor leaves the cache
  // half-cleared if interrupted.
  return runExclusiveBatch(() =>
    _runCacheWrite('clearSyncData', async (db) => {
      await db.runAsync(`DELETE FROM chats`);
      await db.runAsync(`DELETE FROM messages`);
      await db.runAsync(`DELETE FROM message_status`);
      await db.runAsync(`DELETE FROM reactions`);
      await db.runAsync(`DELETE FROM chat_meta`);
      await db.runAsync(`DELETE FROM message_replies`);
      await db.runAsync(`DELETE FROM sync_meta`);
    }),
  );
};

// ── Broadcast status cache (official application updates) ─────────────────────

/** Replace the cached broadcast set with the latest live list. */
const saveBroadcasts = async (broadcasts = []) => runExclusiveBatch(() =>
  // Snapshot is small (<=50) and fully authoritative — clear then insert as one
  // exclusive, atomic transaction (`h` is the transaction handle).
  _runCacheWrite('saveBroadcasts', async (h) => {
    const now = Date.now();
    await h.runAsync('DELETE FROM broadcasts;');
    for (const b of broadcasts) {
      if (!b || !b._id) continue;
      await h.runAsync(
        'INSERT OR REPLACE INTO broadcasts (id, data, published_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?);',
        [
          String(b._id),
          JSON.stringify(b),
          b.publishedAt ? new Date(b.publishedAt).getTime() : (b.createdAt ? new Date(b.createdAt).getTime() : now),
          b.expiresAt ? new Date(b.expiresAt).getTime() : 0,
          now,
        ],
      );
    }
  }),
);

/** Load cached, non-expired broadcasts (newest first) for offline cold-render. */
const loadBroadcasts = async () => {
  try {
    const db = await getDB();
    const now = Date.now();
    const rows = await db.getAllAsync(
      'SELECT data FROM broadcasts WHERE expires_at = 0 OR expires_at > ? ORDER BY published_at DESC;',
      [now],
    );
    return (rows || []).map((r) => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
  } catch (e) {
    console.warn('[ChatDB] loadBroadcasts failed:', e?.message);
    return [];
  }
};

/** Remove a single broadcast from cache (expired / deleted). */
const removeBroadcast = async (statusId) => {
  try {
    await runExclusive(async () => {
      const db = await getDB();
      await db.runAsync('DELETE FROM broadcasts WHERE id = ?;', [String(statusId)]);
    });
  } catch (e) {
    console.warn('[ChatDB] removeBroadcast failed:', e?.message);
  }
};

// ── Contact status-feed cache (V10) ─────────────────────────────────────────
// Caches the grouped contact-status feed so the Chat List avatar rings render
// instantly on cold boot / offline, before /status/feed resolves. The full
// authoritative snapshot replaces the cache on every successful fetch.

/** Replace the cached contact status feed with the latest grouped list. */
const saveStatusFeed = async (groups = []) => runExclusiveBatch(() =>
  // Authoritative snapshot — clear + insert as one exclusive, atomic
  // transaction so concurrent receipt / message writes can't interleave and
  // lock it (`h` is the transaction handle).
  _runCacheWrite('saveStatusFeed', async (h) => {
    const now = Date.now();
    await h.runAsync('DELETE FROM status_feed;');
    for (const g of groups) {
      const uid = String(g?.userId || g?._id || '');
      if (!uid || !(g.statuses && g.statuses.length)) continue;
      await h.runAsync(
        'INSERT OR REPLACE INTO status_feed (user_id, data, latest_at, has_unseen, updated_at) VALUES (?, ?, ?, ?, ?);',
        [
          uid,
          JSON.stringify(g),
          g.latestAt ? new Date(g.latestAt).getTime() : now,
          (g.hasUnseenStatus ?? (Number(g.unseenCount) > 0)) ? 1 : 0,
          now,
        ],
      );
    }
  }),
);

/** Load the cached contact status feed (unseen-first, newest-first) for cold render. */
const loadStatusFeed = async () => {
  try {
    const db = await getDB();
    const rows = await db.getAllAsync(
      'SELECT data FROM status_feed ORDER BY has_unseen DESC, latest_at DESC;',
    );
    return (rows || []).map((r) => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
  } catch (e) {
    console.warn('[ChatDB] loadStatusFeed failed:', e?.message);
    return [];
  }
};

// ── Blocked contacts cache (V12) ─────────────────────────────────────────────
const saveBlockedContacts = async (contacts = []) => {
  // Authoritative snapshot — clear + insert as one exclusive, atomic transaction
  // so concurrent receipt / message writes can't interleave and lock it
  // (`h` is the transaction handle).
  return runExclusiveBatch(() =>
    _runCacheWrite('saveBlockedContacts', async (h) => {
      await h.runAsync('DELETE FROM blocked_contacts;');
      for (const c of contacts) {
        const blockedAt = c.blockedAt ? new Date(c.blockedAt).getTime() : Date.now();
        await h.runAsync(
          'INSERT OR REPLACE INTO blocked_contacts (user_id, full_name, phone, profile_image, blocked_at) VALUES (?, ?, ?, ?, ?);',
          [String(c.userId), c.fullName || null, c.phone || null, c.profileImage || null, blockedAt],
        );
      }
    }),
  );
};

const loadBlockedContacts = async () => {
  try {
    const db = await getDB();
    const rows = await db.getAllAsync('SELECT * FROM blocked_contacts ORDER BY blocked_at DESC;');
    return (rows || []).map((r) => ({
      userId: r.user_id,
      fullName: r.full_name,
      phone: r.phone,
      profileImage: r.profile_image,
      blockedAt: r.blocked_at,
    }));
  } catch (e) {
    console.warn('[ChatDB] loadBlockedContacts failed:', e?.message);
    return [];
  }
};

// ─── PRESENCE CACHE (V13) ──────────────────────────────────────
// Last-known presence per user. Written on every presence:update so the UI can
// cold-render online/last-seen instantly and reconcile on reconnect.
const upsertPresenceCache = async (userId, { status, lastSeen } = {}) => {
  if (!userId) return;
  // Serialize through the global write mutex like every other writer — presence
  // updates arrive at high frequency and were racing batch writes, throwing
  // "database is locked" under WAL contention.
  try {
    await runExclusive(async () => {
      const db = await getDB();
      await db.runAsync(
        'INSERT OR REPLACE INTO presence_cache (user_id, status, last_seen, updated_at) VALUES (?, ?, ?, ?);',
        [String(userId), status || null, lastSeen ? Number(lastSeen) : null, Date.now()],
      );
    });
  } catch (e) {
    console.warn('[ChatDB] upsertPresenceCache failed:', e?.message);
  }
};

const getPresenceCache = async (userId) => {
  if (!userId) return null;
  try {
    const db = await getDB();
    const r = await db.getFirstAsync('SELECT * FROM presence_cache WHERE user_id = ?;', [String(userId)]);
    if (!r) return null;
    return { userId: r.user_id, status: r.status, lastSeen: r.last_seen, updatedAt: r.updated_at };
  } catch (e) {
    console.warn('[ChatDB] getPresenceCache failed:', e?.message);
    return null;
  }
};

const getPresenceCacheMany = async (userIds = []) => {
  const ids = (userIds || []).map(String).filter(Boolean);
  if (!ids.length) return {};
  try {
    const db = await getDB();
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.getAllAsync(
      `SELECT * FROM presence_cache WHERE user_id IN (${placeholders});`,
      ids,
    );
    return (rows || []).reduce((acc, r) => {
      acc[r.user_id] = { userId: r.user_id, status: r.status, lastSeen: r.last_seen, updatedAt: r.updated_at };
      return acc;
    }, {});
  } catch (e) {
    console.warn('[ChatDB] getPresenceCacheMany failed:', e?.message);
    return {};
  }
};

// Legacy aliases
const saveMessageSync = upsertMessage;
const saveMessages = upsertMessages;
const loadMessagesWithReplies = loadMessages; // loadMessages now includes reply data

export default {
  getDB, upsertMessage, upsertMessages, acknowledgeMessage, updateMessageStatus, clearScheduleData,
  loadMessages, loadMessagesWithReplies, getMessage, messageExists, findTempRowByContent, getLatestMessage, getLatestSeq, getOldestSeq, isHistoryFullyLoaded, setHistoryFullyLoaded, getAllChatIds, getMessageCount, searchMessages, getClearedAt,
  markMessageDeleted, deleteMessageForMe, clearChat, deduplicateChat,
  updateReactions, updateMessageEdit, updateGroupMessageTracking, bulkUpdateStatus,
  saveReplyData, getReplyData,
  closeDB, closeCleanly, saveMessageSync, saveMessages,
  // Chatlist
  upsertChat, upsertChats, loadChatList, loadArchivedChats, getChatById,
  updateChatLastMessage, updateChatLastMessageStatusById, updateChatUnread, incrementChatUnread,
  updateChatLastMessageStatus, updateAllSentMessagesInChatToSeen,
  updateChatPin, updateChatMute, updateChatArchive, updateChatGroupMeta, deleteChatRow, getChatCount,
  // Sync meta
  getSyncMeta, setSyncMeta, isInitialSyncDone, clearSyncData,
  // Outbox + watermarks (V8)
  outboxEnqueue, outboxRemove, outboxRecordFailure, outboxDrainDue, outboxCount,
  setPeerReadWatermark, getPeerReadWatermark,
  // Broadcast status cache (V9)
  saveBroadcasts, loadBroadcasts, removeBroadcast,
  // Contact status-feed cache (V10)
  saveStatusFeed, loadStatusFeed,
  // Blocked contacts cache (V12)
  saveBlockedContacts, loadBlockedContacts,
  // Presence cache (V13)
  upsertPresenceCache, getPresenceCache, getPresenceCacheMany,
};