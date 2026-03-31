import * as SQLite from 'expo-sqlite';

const DB_NAME = 'vibeconnect_chat.db';
const DB_VERSION = 6;

let _db = null;
let _hasReplyColumns = false;

// ─── DATABASE INIT ──────────────────────────────────────
let _dbInitPromise = null;

const getDB = async () => {
  if (_db) {
    // Verify connection is still alive
    try {
      await _db.getFirstAsync('SELECT 1');
      return _db;
    } catch {
      _db = null;
      _dbInitPromise = null;
    }
  }
  // Prevent concurrent init attempts
  if (_dbInitPromise) return _dbInitPromise;
  _dbInitPromise = _initDB();
  try {
    return await _dbInitPromise;
  } finally {
    _dbInitPromise = null;
  }
};

const _initDB = async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      _db = await SQLite.openDatabaseAsync(DB_NAME);
      await _db.execAsync('PRAGMA journal_mode = WAL;');
      await _db.execAsync('PRAGMA synchronous = NORMAL;');
      await _db.execAsync('PRAGMA foreign_keys = ON;');
      await runMigrations(_db);
      return _db;
    } catch (err) {
      console.error(`[ChatDB] getDB attempt ${attempt + 1} failed:`, err?.message);
      _db = null;
      if (attempt < 2) await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  console.error('[ChatDB] All DB init attempts failed');
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

const STATUS_PRIORITY = { scheduled: 0, cancelled: 0, processing: 0, sending: 1, uploaded: 2, sent: 3, delivered: 4, seen: 5, read: 5 };

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

const saveReplyData = async (messageId, data) => {
  if (!messageId || !data?.replyToMessageId) return;
  const db = await getDB();
  const params = { $mid: messageId, $rid: data.replyToMessageId, $text: data.replyPreviewText || null, $type: data.replyPreviewType || null, $name: data.replySenderName || null, $sid: data.replySenderId || null };
  const sql = `INSERT OR IGNORE INTO message_replies (message_id, reply_to_message_id, reply_preview_text, reply_preview_type, reply_sender_name, reply_sender_id) VALUES ($mid, $rid, $text, $type, $name, $sid)`;
  try {
    await db.runAsync(sql, params);
    console.log('[DEBUG:SAVE_REPLY] Saved reply for', messageId, '→', data.replyToMessageId);
  } catch (err) {
    console.log('[DEBUG:SAVE_REPLY] FAILED for', messageId, err?.message);
    try {
      await db.execAsync(`CREATE TABLE IF NOT EXISTS message_replies (message_id TEXT PRIMARY KEY NOT NULL, reply_to_message_id TEXT NOT NULL, reply_preview_text TEXT, reply_preview_type TEXT, reply_sender_name TEXT, reply_sender_id TEXT);`);
      await db.runAsync(sql, params);
      console.log('[DEBUG:SAVE_REPLY] Retry OK for', messageId);
    } catch (e2) {
      console.log('[DEBUG:SAVE_REPLY] Retry FAILED', e2?.message);
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

const upsertMessage = async (msg) => {
  if (!msg) return;
  const db = await getDB();

  // STEP 1: Read existing reply data BEFORE any cleanup
  // Recover if replyToMessageId is missing entirely, OR if it's set but preview data is missing
  let replyData = null;
  const needsReplyRecovery = !msg.replyToMessageId || (msg.replyToMessageId && !msg.replyPreviewText);
  if (needsReplyRecovery) {
    const msgId = msg.serverMessageId || msg.id || msg.tempId;
    if (msgId) {
      // Check reply table first (permanent)
      replyData = await getReplyData(msgId);
      // Fallback: check message row payload
      if (!replyData) {
        try {
          const ex = await db.getFirstAsync(`SELECT payload FROM messages WHERE id = $id OR server_message_id = $id OR temp_id = $id LIMIT 1`, { $id: msgId });
          if (ex?.payload) {
            const p = JSON.parse(ex.payload);
            if (p?._replyToMessageId) {
              replyData = { replyToMessageId: p._replyToMessageId, replyPreviewText: p._replyPreviewText, replyPreviewType: p._replyPreviewType, replySenderName: p._replySenderName, replySenderId: p._replySenderId };
            }
          }
        } catch {}
      }
    }
  }

  // Merge: incoming msg fields take priority, but fill in missing reply preview from recovered data
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

  // STEP 2: Clean duplicates
  await cleanBeforeUpsert(db, finalMsg);

  // STEP 3: Preserve edits/deletes/reactions
  const merged = await _preserveLocalState(db, finalMsg);
  const writeMsg = merged || finalMsg;

  // STEP 4: Write to messages table
  await _runInsert(db, writeMsg);

  // STEP 5: Save reply data to permanent table under ALL possible IDs
  if (writeMsg.replyToMessageId) {
    const ids = [writeMsg.serverMessageId, writeMsg.id, writeMsg.tempId].filter(Boolean);
    for (const rid of ids) {
      saveReplyData(rid, writeMsg).catch(() => {});
    }
  }
};

const upsertMessages = async (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) return;
  const db = await getDB();

  // Wrap in transaction for atomic batch writes — 10-50x faster for bulk inserts
  await db.execAsync('BEGIN TRANSACTION');
  try {
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
          for (const rid of ids) saveReplyData(rid, writeMsg).catch(() => {});
        }
      } catch (err) {
        console.warn('[ChatDB] upsertMessages row error:', err?.message);
      }
    }
    await db.execAsync('COMMIT');
  } catch (err) {
    await db.execAsync('ROLLBACK').catch(() => {});
    console.warn('[ChatDB] upsertMessages transaction error:', err?.message);
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
  };

  const baseParams = {
    $id: id,
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
      id, server_message_id, temp_id, chat_id, group_id,
      sender_id, sender_name, sender_type, receiver_id,
      text, type, status, timestamp, created_at, synced,
      is_deleted, deleted_for, deleted_by, placeholder_text,
      is_edited, edited_at, media_url, media_type, preview_url,
      local_uri, media_id, reactions, delivered_to, read_by, payload, extra,
      reply_to_message_id, reply_preview_text, reply_preview_type, reply_sender_name, reply_sender_id
    ) VALUES (
      $id, $server_message_id, $temp_id, $chat_id, $group_id,
      $sender_id, $sender_name, $sender_type, $receiver_id,
      $text, $type, $status, $timestamp, $created_at, $synced,
      $is_deleted, $deleted_for, $deleted_by, $placeholder_text,
      $is_edited, $edited_at, $media_url, $media_type, $preview_url,
      $local_uri, $media_id, $reactions, $delivered_to, $read_by, $payload, $extra,
      $reply_to_message_id, $reply_preview_text, $reply_preview_type, $reply_sender_name, $reply_sender_id
    ) ON CONFLICT(id) DO UPDATE SET
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
      id, server_message_id, temp_id, chat_id, group_id,
      sender_id, sender_name, sender_type, receiver_id,
      text, type, status, timestamp, created_at, synced,
      is_deleted, deleted_for, deleted_by, placeholder_text,
      is_edited, edited_at, media_url, media_type, preview_url,
      local_uri, media_id, reactions, delivered_to, read_by, payload, extra
    ) VALUES (
      $id, $server_message_id, $temp_id, $chat_id, $group_id,
      $sender_id, $sender_name, $sender_type, $receiver_id,
      $text, $type, $status, $timestamp, $created_at, $synced,
      $is_deleted, $deleted_for, $deleted_by, $placeholder_text,
      $is_edited, $edited_at, $media_url, $media_type, $preview_url,
      $local_uri, $media_id, $reactions, $delivered_to, $read_by, $payload, $extra
    ) ON CONFLICT(id) DO UPDATE SET
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
  const db = await getDB();
  const { limit = 50, offset = 0, afterTimestamp = 0, skipCleanup = false } = opts;

  // ── STEP 1: Lightweight cleanup — only run on first load (not every refresh) ──
  if (!skipCleanup) {
    try {
      await db.runAsync(
        `DELETE FROM messages WHERE chat_id = $cid AND id LIKE 'temp_%' AND server_message_id IS NOT NULL`,
        { $cid: chatId }
      );
    } catch {}
  }

  // ── STEP 2: Load raw rows using indexed query ──
  const rows = afterTimestamp > 0
    ? await db.getAllAsync(
        `SELECT * FROM messages WHERE chat_id = $cid AND timestamp > $ts ORDER BY timestamp DESC LIMIT $lim OFFSET $off`,
        { $cid: chatId, $ts: afterTimestamp, $lim: limit, $off: offset }
      )
    : await db.getAllAsync(
        `SELECT * FROM messages WHERE chat_id = $cid ORDER BY timestamp DESC LIMIT $lim OFFSET $off`,
        { $cid: chatId, $lim: limit, $off: offset }
      );

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
        const replyRows = await db.getAllAsync(`SELECT * FROM message_replies WHERE message_id IN (${ph})`, batch);
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
  const db = await getDB();

  const serverRow = await db.getFirstAsync(`SELECT id, is_edited FROM messages WHERE id = $s OR server_message_id = $s LIMIT 1`, { $s: serverMessageId });
  const tempRow = await db.getFirstAsync(`SELECT id, is_edited, status, payload, reply_to_message_id, reply_preview_text, reply_preview_type, reply_sender_name, reply_sender_id FROM messages WHERE id = $t OR temp_id = $t LIMIT 1`, { $t: tempId });

  // Preserve 'scheduled'/'processing' status — don't overwrite it with 'sent' during acknowledge
  const tempPayload = tempRow ? parseJSON(tempRow.payload) : null;
  const isScheduledMsg = tempRow?.status === 'scheduled' || tempRow?.status === 'processing' || tempPayload?.isScheduled;
  const ackStatus = isScheduledMsg ? (tempRow?.status || 'scheduled') : 'sent';

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
};

const updateMessageStatus = async (messageId, newStatus) => {
  if (!messageId || !newStatus) return false;
  const db = await getDB();
  const np = STATUS_PRIORITY[newStatus] || 0;
  const cur = await db.getFirstAsync(`SELECT status FROM messages WHERE id = $id OR server_message_id = $id OR temp_id = $id LIMIT 1`, { $id: messageId });
  if (!cur) return false;
  // Protect scheduled/cancelled/failed from being overwritten by delivery/read/seen events
  // Only clearScheduleData() should transition these statuses
  const PROTECTED = new Set(['scheduled', 'processing', 'cancelled', 'failed']);
  if (PROTECTED.has(cur.status) && !PROTECTED.has(newStatus)) return false;
  if (np <= (STATUS_PRIORITY[cur.status] || 0)) return false;
  await db.runAsync(`UPDATE messages SET status = $s WHERE id = $id OR server_message_id = $id OR temp_id = $id`, { $s: newStatus, $id: messageId });
  return true;
};

// Clear schedule data from payload when a scheduled message is delivered
const clearScheduleData = async (messageId, newStatus = 'sent') => {
  if (!messageId) return;
  const db = await getDB();
  try {
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
  } catch (err) {
    console.warn('[ChatDB] clearScheduleData error:', err);
  }
};

const markMessageDeleted = async (messageId, deletedBy, placeholderText) => {
  if (!messageId) return;
  const db = await getDB();
  await db.runAsync(
    `UPDATE messages SET is_deleted = 1, deleted_for = 'everyone', deleted_by = $by, placeholder_text = $ph, text = $ph, type = 'system', media_url = NULL, media_type = NULL, preview_url = NULL, local_uri = NULL WHERE id = $id OR server_message_id = $id OR temp_id = $id`,
    { $id: messageId, $by: deletedBy || null, $ph: placeholderText || 'This message was deleted' }
  );
};

const deleteMessageForMe = async (messageId) => {
  if (!messageId) return;
  const db = await getDB();
  await db.runAsync(`DELETE FROM messages WHERE id = $id OR server_message_id = $id OR temp_id = $id`, { $id: messageId });
};

const updateReactions = async (messageId, reactions) => {
  if (!messageId) return;
  const db = await getDB();
  await db.runAsync(`UPDATE messages SET reactions = $r WHERE id = $id OR server_message_id = $id OR temp_id = $id`, { $id: messageId, $r: reactions ? JSON.stringify(reactions) : null });
};

const updateMessageEdit = async (messageId, newText, editedAt) => {
  if (!messageId || !newText) return;
  const db = await getDB();
  try {
    await db.runAsync(`UPDATE messages SET text = $t, is_edited = 1, edited_at = $e WHERE id = $id OR server_message_id = $id OR temp_id = $id`, { $id: messageId, $t: newText, $e: editedAt || new Date().toISOString() });
  } catch (err) { console.warn('[ChatDB] updateMessageEdit error:', err); }
};

const clearChat = async (chatId, clearedAt = null) => {
  if (!chatId) return;
  const db = await getDB();
  if (clearedAt) {
    await db.runAsync(`DELETE FROM messages WHERE chat_id = $c AND timestamp <= $t`, { $c: chatId, $t: clearedAt });
  } else {
    await db.runAsync(`DELETE FROM messages WHERE chat_id = $c`, { $c: chatId });
  }
  await db.runAsync(`INSERT OR REPLACE INTO chat_meta (chat_id, cleared_at, updated_at) VALUES ($c, $t, $n)`, { $c: chatId, $t: clearedAt || Date.now(), $n: Date.now() });
};

const getClearedAt = async (chatId) => {
  if (!chatId) return 0;
  const db = await getDB();
  const r = await db.getFirstAsync(`SELECT cleared_at FROM chat_meta WHERE chat_id = $c`, { $c: chatId });
  return r?.cleared_at || 0;
};

const getMessageCount = async (chatId) => {
  if (!chatId) return 0;
  const db = await getDB();
  const r = await db.getFirstAsync(`SELECT COUNT(*) as count FROM messages WHERE chat_id = $c`, { $c: chatId });
  return r?.count || 0;
};

const updateGroupMessageTracking = async (messageId, { deliveredTo, readBy } = {}) => {
  if (!messageId) return;
  const db = await getDB();
  const u = []; const p = { $id: messageId };
  if (deliveredTo) { u.push('delivered_to = $dt'); p.$dt = JSON.stringify(deliveredTo); }
  if (readBy) { u.push('read_by = $rb'); p.$rb = JSON.stringify(readBy); }
  if (u.length === 0) return;
  await db.runAsync(`UPDATE messages SET ${u.join(', ')} WHERE id = $id OR server_message_id = $id OR temp_id = $id`, p);
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

const deduplicateChat = async (chatId) => {
  if (!chatId) return;
  const db = await getDB();
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
};

const bulkUpdateStatus = async (chatId, newStatus, opts = {}) => {
  if (!chatId || !newStatus) return;
  const db = await getDB();
  if (opts.senderIdNot) {
    const cs = Object.entries(STATUS_PRIORITY).filter(([, p]) => p < (STATUS_PRIORITY[newStatus] || 0)).map(([s]) => `'${s}'`).join(',');
    if (!cs) return;
    await db.runAsync(`UPDATE messages SET status = $s WHERE chat_id = $c AND sender_id != $sid AND status IN (${cs})`, { $s: newStatus, $c: chatId, $sid: opts.senderIdNot });
  } else {
    await db.runAsync(`UPDATE messages SET status = $s WHERE chat_id = $c`, { $s: newStatus, $c: chatId });
  }
};

const closeDB = async () => {
  _dbInitPromise = null;
  if (_db) {
    try { await _db.closeAsync(); } catch {}
    _db = null;
  }
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
  const db = await getDB();
  await db.runAsync(UPSERT_CHAT_SQL, params);
};

const upsertChats = async (chats) => {
  if (!Array.isArray(chats) || chats.length === 0) return;
  const db = await getDB();
  for (const chat of chats) {
    const params = _chatToRow(chat);
    if (!params) continue;
    try { await db.runAsync(UPSERT_CHAT_SQL, params); } catch {}
  }
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

const updateChatLastMessage = async (chatId, lm) => {
  if (!chatId || !lm) return;
  const db = await getDB();
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
      $status: lm.status || null,
      $at: lm.createdAt || lm.lastMessageAt || null,
      $id: lm.serverMessageId || lm.messageId || null,
      $edited: lm.isEdited ? 1 : 0,
      $deleted: lm.isDeleted ? 1 : 0,
      $now: Date.now(),
    }
  );
};

const updateChatUnread = async (chatId, count) => {
  if (!chatId) return;
  const db = await getDB();
  await db.runAsync(`UPDATE chats SET unread_count = $c, updated_at = $n WHERE chat_id = $id`, { $c: count, $n: Date.now(), $id: chatId });
};

const incrementChatUnread = async (chatId) => {
  if (!chatId) return;
  const db = await getDB();
  await db.runAsync(`UPDATE chats SET unread_count = unread_count + 1, updated_at = $n WHERE chat_id = $id`, { $n: Date.now(), $id: chatId });
};

const updateChatPin = async (chatId, isPinned, pinnedAt) => {
  if (!chatId) return;
  const db = await getDB();
  await db.runAsync(`UPDATE chats SET is_pinned = $p, pinned_at = $at, updated_at = $n WHERE chat_id = $id`, { $p: isPinned ? 1 : 0, $at: pinnedAt || null, $n: Date.now(), $id: chatId });
};

const updateChatMute = async (chatId, isMuted, muteUntil) => {
  if (!chatId) return;
  const db = await getDB();
  await db.runAsync(`UPDATE chats SET is_muted = $m, mute_until = $u, updated_at = $n WHERE chat_id = $id`, { $m: isMuted ? 1 : 0, $u: muteUntil || null, $n: Date.now(), $id: chatId });
};

const updateChatArchive = async (chatId, isArchived) => {
  if (!chatId) return;
  const db = await getDB();
  await db.runAsync(`UPDATE chats SET is_archived = $a, updated_at = $n WHERE chat_id = $id`, { $a: isArchived ? 1 : 0, $n: Date.now(), $id: chatId });
};

const deleteChatRow = async (chatId) => {
  if (!chatId) return;
  const db = await getDB();
  await db.runAsync(`DELETE FROM chats WHERE chat_id = $id`, { $id: chatId });
};

const getChatCount = async () => {
  const db = await getDB();
  const r = await db.getFirstAsync(`SELECT COUNT(*) as cnt FROM chats`);
  return r?.cnt || 0;
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
  const db = await getDB();
  await db.runAsync(
    `INSERT INTO sync_meta (key, value, updated_at) VALUES ($k, $v, $n) ON CONFLICT(key) DO UPDATE SET value = $v, updated_at = $n`,
    { $k: key, $v: String(value), $n: Date.now() }
  );
};

const isInitialSyncDone = async (userId) => {
  if (!userId) return false;
  const val = await getSyncMeta('INITIAL_SYNC_COMPLETE');
  return val === String(userId);
};

const clearSyncData = async () => {
  const db = await getDB();
  await db.runAsync(`DELETE FROM chats`);
  await db.runAsync(`DELETE FROM messages`);
  await db.runAsync(`DELETE FROM message_status`);
  await db.runAsync(`DELETE FROM reactions`);
  await db.runAsync(`DELETE FROM chat_meta`);
  await db.runAsync(`DELETE FROM message_replies`);
  await db.runAsync(`DELETE FROM sync_meta`);
};

// Legacy aliases
const saveMessageSync = upsertMessage;
const saveMessages = upsertMessages;
const loadMessagesWithReplies = loadMessages; // loadMessages now includes reply data

export default {
  getDB, upsertMessage, upsertMessages, acknowledgeMessage, updateMessageStatus, clearScheduleData,
  loadMessages, loadMessagesWithReplies, getMessage, messageExists, findTempRowByContent, getLatestMessage, getMessageCount, searchMessages, getClearedAt,
  markMessageDeleted, deleteMessageForMe, clearChat, deduplicateChat,
  updateReactions, updateMessageEdit, updateGroupMessageTracking, bulkUpdateStatus,
  saveReplyData, getReplyData,
  closeDB, saveMessageSync, saveMessages,
  // Chatlist
  upsertChat, upsertChats, loadChatList, loadArchivedChats, getChatById,
  updateChatLastMessage, updateChatUnread, incrementChatUnread,
  updateChatPin, updateChatMute, updateChatArchive, deleteChatRow, getChatCount,
  // Sync meta
  getSyncMeta, setSyncMeta, isInitialSyncDone, clearSyncData,
};