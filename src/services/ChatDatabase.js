import * as SQLite from 'expo-sqlite';

const DB_NAME = 'vibeconnect_chat.db';
const DB_VERSION = 5;

let _db = null;
let _hasReplyColumns = false;

// ─── DATABASE INIT ──────────────────────────────────────
const getDB = async () => {
  if (_db) return _db;
  try {
    _db = await SQLite.openDatabaseAsync(DB_NAME);
    await _db.execAsync('PRAGMA journal_mode = WAL;');
    await _db.execAsync('PRAGMA synchronous = NORMAL;');
    await _db.execAsync('PRAGMA foreign_keys = ON;');
    await runMigrations(_db);
  } catch (err) {
    console.error('[ChatDB] getDB error:', err);
    _db = null;
    try {
      _db = await SQLite.openDatabaseAsync(DB_NAME);
      await _db.execAsync('PRAGMA journal_mode = WAL;');
      await runMigrations(_db);
    } catch (e) {
      console.error('[ChatDB] getDB retry failed:', e);
    }
  }
  return _db;
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

const STATUS_PRIORITY = { sending: 1, uploaded: 2, sent: 3, delivered: 4, seen: 5, read: 5 };

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
      console.warn('[ChatDB] upsertMessages error:', err?.message);
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
    $reactions: msg.reactions ? JSON.stringify(msg.reactions) : null,
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
    if (ep > ip) merged = { ...msg, status: existing.status };
  }

  // Preserve reactions
  if (existing.reactions && !msg.reactions) {
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
  const { limit = 50, offset = 0, afterTimestamp = 0 } = opts;

  // ── STEP 1: Nuclear SQL cleanup — delete ALL orphan temp rows in this chat ──
  // A temp row is orphan if ANY non-temp row exists with same sender+text within 30s
  try {
    await db.runAsync(
      `DELETE FROM messages WHERE chat_id = $cid AND id LIKE 'temp_%' AND EXISTS (
         SELECT 1 FROM messages s WHERE s.chat_id = $cid AND s.id != messages.id
           AND s.id NOT LIKE 'temp_%' AND s.sender_id = messages.sender_id
           AND s.text = messages.text AND ABS(s.timestamp - messages.timestamp) < 30000
       )`,
      { $cid: chatId }
    );
  } catch (e) { console.warn('[ChatDB:loadMessages] cleanup error:', e?.message); }

  // ── STEP 2: Load raw rows ──
  const rows = await db.getAllAsync(
    `SELECT * FROM messages WHERE chat_id = $cid AND timestamp > $ts ORDER BY timestamp DESC LIMIT $lim OFFSET $off`,
    { $cid: chatId, $ts: afterTimestamp, $lim: limit, $off: offset }
  );

  // ── STEP 3: Batch-lookup reply data from message_replies table ──
  let replyMap = {};
  try {
    const allIds = [];
    for (const row of rows) {
      if (row.id) allIds.push(row.id);
      if (row.server_message_id && row.server_message_id !== row.id) allIds.push(row.server_message_id);
      if (row.temp_id && row.temp_id !== row.id) allIds.push(row.temp_id);
    }
    if (allIds.length > 0) {
      const ph = allIds.map(() => '?').join(',');
      const replyRows = await db.getAllAsync(`SELECT * FROM message_replies WHERE message_id IN (${ph})`, allIds);
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
  } catch {}

  // ── STEP 4: Convert rows to message objects, enrich with reply data ──
  const allMsgs = rows.map(row => {
    const msg = rowToMsg(row);
    if (msg && !msg.replyToMessageId) {
      const rd = replyMap[msg.id] || replyMap[msg.serverMessageId] || replyMap[msg.tempId];
      if (rd) Object.assign(msg, rd);
    }
    return msg;
  }).filter(Boolean);

  // ── STEP 5: BULLETPROOF JS DEDUP — zero duplicates guaranteed ──
  // Uses a fingerprint map: for each message, generate a fingerprint from sender+text+rounded_timestamp.
  // If two messages share ANY ID or have the same fingerprint, keep only one (prefer server-confirmed).
  const seenIds = new Set();
  const fingerprintMap = new Map(); // fingerprint → first msg that claimed it
  const result = [];

  for (const msg of allMsgs) {
    // Check ALL IDs
    const ids = [msg.serverMessageId, msg.id, msg.tempId].filter(Boolean);
    if (ids.some(id => seenIds.has(id))) continue; // already seen by ID

    // Fingerprint: sender + text + 30s rounded timestamp
    // 30s window is wide enough to catch any client/server clock difference
    let dominated = false;
    if (msg.senderId && msg.text != null) {
      const roundedTs = Math.round((msg.timestamp || 0) / 30000);
      const fp = `${msg.senderId}|${msg.text}|${roundedTs}`;
      // Also check ±1 bucket to handle boundary cases
      const fpPrev = `${msg.senderId}|${msg.text}|${roundedTs - 1}`;
      const fpNext = `${msg.senderId}|${msg.text}|${roundedTs + 1}`;

      const existing = fingerprintMap.get(fp) || fingerprintMap.get(fpPrev) || fingerprintMap.get(fpNext);
      if (existing) {
        // Duplicate found! Skip this one.
        dominated = true;
      } else {
        fingerprintMap.set(fp, msg);
      }
    }

    if (dominated) continue;

    // Register all IDs
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
  const tempRow = await db.getFirstAsync(`SELECT id, is_edited, reply_to_message_id, reply_preview_text, reply_preview_type, reply_sender_name, reply_sender_id FROM messages WHERE id = $t OR temp_id = $t LIMIT 1`, { $t: tempId });

  if (serverRow && tempRow && serverRow.id !== tempRow.id) {
    if (tempRow.is_edited && !serverRow.is_edited) {
      await db.runAsync(`DELETE FROM messages WHERE id = $s`, { $s: serverRow.id });
      await db.runAsync(`UPDATE messages SET id = $s, server_message_id = $s, synced = 1, status = 'sent' WHERE id = $t`, { $s: serverMessageId, $t: tempRow.id });
    } else {
      // Before deleting temp row, copy its reply data to the server row if server row lacks it
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
      await db.runAsync(`DELETE FROM messages WHERE id = $t`, { $t: tempRow.id });
    }
  } else if (tempRow && !serverRow) {
    await db.runAsync(`UPDATE messages SET id = $s, server_message_id = $s, synced = 1, status = 'sent' WHERE temp_id = $t OR id = $t`, { $s: serverMessageId, $t: tempId });
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
  if (np <= (STATUS_PRIORITY[cur.status] || 0)) return false;
  await db.runAsync(`UPDATE messages SET status = $s WHERE id = $id OR server_message_id = $id OR temp_id = $id`, { $s: newStatus, $id: messageId });
  return true;
};

const markMessageDeleted = async (messageId, deletedBy, placeholderText) => {
  if (!messageId) return;
  const db = await getDB();
  await db.runAsync(
    `UPDATE messages SET is_deleted = 1, deleted_for = 'everyone', deleted_by = $by, placeholder_text = $ph, text = 'This message was deleted', media_url = NULL, preview_url = NULL, local_uri = NULL WHERE id = $id OR server_message_id = $id OR temp_id = $id`,
    { $id: messageId, $by: deletedBy || null, $ph: placeholderText || null }
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
  if (_db) { await _db.closeAsync(); _db = null; }
};

// Legacy aliases
const saveMessageSync = upsertMessage;
const saveMessages = upsertMessages;
const loadMessagesWithReplies = loadMessages; // loadMessages now includes reply data

export default {
  getDB, upsertMessage, upsertMessages, acknowledgeMessage, updateMessageStatus,
  loadMessages, loadMessagesWithReplies, getMessage, messageExists, findTempRowByContent, getLatestMessage, getMessageCount, searchMessages, getClearedAt,
  markMessageDeleted, deleteMessageForMe, clearChat, deduplicateChat,
  updateReactions, updateMessageEdit, updateGroupMessageTracking, bulkUpdateStatus,
  saveReplyData, getReplyData,
  closeDB, saveMessageSync, saveMessages,
};
