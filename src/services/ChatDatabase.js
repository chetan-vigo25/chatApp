import * as SQLite from 'expo-sqlite';

const DB_NAME = 'vibeconnect_chat.db';
const DB_VERSION = 1;

let _db = null;

// ─── DATABASE INIT ──────────────────────────────────────
const getDB = async () => {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync(DB_NAME);
  await _db.execAsync('PRAGMA journal_mode = WAL;');
  await _db.execAsync('PRAGMA synchronous = NORMAL;');
  await _db.execAsync('PRAGMA foreign_keys = ON;');
  await runMigrations(_db);
  return _db;
};

const runMigrations = async (db) => {
  const result = await db.getFirstAsync('PRAGMA user_version;');
  const currentVersion = result?.user_version ?? 0;
  if (currentVersion >= DB_VERSION) return;

  await db.execAsync('BEGIN TRANSACTION;');
  try {
    if (currentVersion < 1) {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY NOT NULL,
          server_message_id TEXT,
          temp_id TEXT,
          chat_id TEXT NOT NULL,
          group_id TEXT,
          sender_id TEXT,
          sender_name TEXT,
          sender_type TEXT,
          receiver_id TEXT,
          text TEXT,
          type TEXT DEFAULT 'text',
          status TEXT DEFAULT 'sent',
          timestamp INTEGER NOT NULL,
          created_at TEXT,
          synced INTEGER DEFAULT 0,
          is_deleted INTEGER DEFAULT 0,
          deleted_for TEXT,
          deleted_by TEXT,
          placeholder_text TEXT,
          is_edited INTEGER DEFAULT 0,
          edited_at TEXT,
          media_url TEXT,
          media_type TEXT,
          preview_url TEXT,
          local_uri TEXT,
          media_id TEXT,
          reactions TEXT,
          delivered_to TEXT,
          read_by TEXT,
          payload TEXT,
          extra TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
        CREATE INDEX IF NOT EXISTS idx_messages_server_id ON messages(server_message_id);
        CREATE INDEX IF NOT EXISTS idx_messages_temp_id ON messages(temp_id);
        CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp ON messages(chat_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
        CREATE INDEX IF NOT EXISTS idx_messages_media ON messages(media_id);

        CREATE TABLE IF NOT EXISTS message_status (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'sent',
          updated_at INTEGER,
          UNIQUE(message_id, user_id)
        );

        CREATE INDEX IF NOT EXISTS idx_status_message ON message_status(message_id);

        CREATE TABLE IF NOT EXISTS reactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          emoji TEXT NOT NULL,
          created_at INTEGER,
          UNIQUE(message_id, user_id, emoji)
        );

        CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);

        CREATE TABLE IF NOT EXISTS chat_meta (
          chat_id TEXT PRIMARY KEY NOT NULL,
          cleared_at INTEGER DEFAULT 0,
          last_message_at INTEGER DEFAULT 0,
          updated_at INTEGER DEFAULT 0
        );
      `);
    }
    await db.execAsync(`PRAGMA user_version = ${DB_VERSION};`);
    await db.execAsync('COMMIT;');
  } catch (err) {
    await db.execAsync('ROLLBACK;');
    console.error('[ChatDB] Migration failed:', err);
    throw err;
  }
};

// ─── HELPERS ────────────────────────────────────────────

const formatTime = (ts, createdAt) => {
  if (!ts && !createdAt) return null;
  const d = ts ? new Date(ts) : new Date(createdAt);
  if (isNaN(d.getTime())) return null;
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${m} ${ampm}`;
};

const formatDate = (ts, createdAt) => {
  if (!ts && !createdAt) return null;
  const d = ts ? new Date(ts) : new Date(createdAt);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
};

const STATUS_PRIORITY = { sending: 1, uploaded: 2, sent: 3, delivered: 4, seen: 5, read: 5 };

const msgToRow = (msg) => {
  const id = msg.serverMessageId || msg.id || msg.tempId || `unknown_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  return {
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
    $payload: msg.payload ? JSON.stringify(msg.payload) : null,
    $extra: null,
  };
};

const rowToMsg = (row) => {
  if (!row) return null;
  const parseJSON = (val) => {
    if (!val) return null;
    try { return JSON.parse(val); } catch { return val; }
  };

  const ts = row.timestamp;
  const ca = row.created_at;

  return {
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
    payload: parseJSON(row.payload),
  };
};

// ─── UPSERT SQL ─────────────────────────────────────────

const UPSERT_SQL = `INSERT OR REPLACE INTO messages (
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
)`;

/**
 * Clean up old temp/server rows before insert to prevent duplicates.
 * This is the KEY to zero-duplicate architecture.
 * Handles: tempId→serverId transition, re-inserts, and content-based duplicates.
 */
const cleanBeforeUpsert = async (db, msg) => {
  const id = msg.serverMessageId || msg.id || msg.tempId;
  const tempId = msg.tempId;
  const serverId = msg.serverMessageId;

  // If server confirmed: delete old temp row
  if (serverId && tempId && serverId !== tempId) {
    await db.runAsync(
      `DELETE FROM messages WHERE (id = $tempId OR temp_id = $tempId) AND id != $serverId`,
      { $tempId: tempId, $serverId: serverId }
    );
  }
  // Clean up any other row with same temp_id but different primary id
  if (tempId && tempId !== id) {
    await db.runAsync(
      `DELETE FROM messages WHERE temp_id = $tempId AND id != $id`,
      { $tempId: tempId, $id: id }
    );
  }
  // Clean up any other row with same server_message_id but different primary id
  if (serverId) {
    await db.runAsync(
      `DELETE FROM messages WHERE server_message_id = $sid AND id != $id`,
      { $sid: serverId, $id: id }
    );
  }
  // Content-based cleanup: if this is a server-confirmed message, delete any temp row
  // from the same sender with matching content within 5 seconds (covers missing tempId linkage)
  if (serverId && msg.senderId && msg.timestamp) {
    const ts = Number(msg.timestamp || 0);
    if (ts > 0) {
      const msgType = (msg.type || 'text').toLowerCase();
      const isMedia = msgType !== 'text' && msgType !== 'system';

      if (isMedia) {
        // For media messages: match by type + (mediaId OR mediaUrl) + sender + time
        // This prevents accidentally deleting a different media message sent at the same time
        const mediaId = msg.mediaId || null;
        const mediaUrl = msg.mediaUrl || null;
        if (mediaId) {
          await db.runAsync(
            `DELETE FROM messages
             WHERE chat_id = $chatId AND sender_id = $senderId AND id != $id AND id LIKE 'temp_%'
               AND type = $type AND media_id = $mediaId AND ABS(timestamp - $ts) < 5000`,
            { $chatId: msg.chatId, $senderId: msg.senderId, $id: id, $type: msgType, $mediaId: mediaId, $ts: ts }
          );
        } else if (mediaUrl) {
          await db.runAsync(
            `DELETE FROM messages
             WHERE chat_id = $chatId AND sender_id = $senderId AND id != $id AND id LIKE 'temp_%'
               AND type = $type AND media_url = $mediaUrl AND ABS(timestamp - $ts) < 5000`,
            { $chatId: msg.chatId, $senderId: msg.senderId, $id: id, $type: msgType, $mediaUrl: mediaUrl, $ts: ts }
          );
        } else {
          // Fallback for media without mediaId/mediaUrl: match by type + sender + time
          await db.runAsync(
            `DELETE FROM messages
             WHERE chat_id = $chatId AND sender_id = $senderId AND id != $id AND id LIKE 'temp_%'
               AND type = $type AND ABS(timestamp - $ts) < 3000`,
            { $chatId: msg.chatId, $senderId: msg.senderId, $id: id, $type: msgType, $ts: ts }
          );
        }
      } else {
        // For text messages: match by text content + sender + time
        await db.runAsync(
          `DELETE FROM messages
           WHERE chat_id = $chatId AND sender_id = $senderId AND id != $id AND id LIKE 'temp_%'
             AND text = $text AND ABS(timestamp - $ts) < 5000`,
          { $chatId: msg.chatId, $senderId: msg.senderId, $id: id, $text: msg.text || '', $ts: ts }
        );
      }
    }
  }
};

// ─── PUBLIC API ─────────────────────────────────────────

/**
 * Check if existing row should be preserved (locally edited/deleted state).
 * Also finds temp rows by sender+timestamp that might be the same message (pre-ACK).
 * Returns the merged message if existing should be preserved, or null to allow overwrite.
 */
const preserveLocalEdits = async (db, msg) => {
  const id = msg.serverMessageId || msg.id || msg.tempId;
  if (!id) return null;

  // Find existing row by any ID — include reactions column
  let existing = await db.getFirstAsync(
    `SELECT id, text, is_edited, is_deleted, deleted_for, status, local_uri, temp_id, reactions FROM messages
     WHERE id = $id OR server_message_id = $id OR temp_id = $id LIMIT 1`,
    { $id: id }
  );

  // If no direct ID match, search for a temp row from the same sender at the same time
  if (!existing && msg.senderId && msg.timestamp) {
    const ts = Number(msg.timestamp || 0);
    if (ts > 0) {
      existing = await db.getFirstAsync(
        `SELECT id, text, is_edited, is_deleted, deleted_for, status, local_uri, temp_id, reactions FROM messages
         WHERE chat_id = $chatId AND sender_id = $senderId AND id LIKE 'temp_%'
           AND ABS(timestamp - $ts) < 5000
         ORDER BY is_edited DESC LIMIT 1`,
        { $chatId: msg.chatId, $senderId: msg.senderId, $ts: ts }
      );
      if (existing && existing.id) {
        await db.runAsync(`DELETE FROM messages WHERE id = $tempId`, { $tempId: existing.id });
      }
    }
  }

  if (!existing) return null;

  // Parse existing reactions from JSON
  let existingReactions = null;
  if (existing.reactions) {
    try { existingReactions = JSON.parse(existing.reactions); } catch { existingReactions = null; }
  }

  let merged = null;

  // If existing was locally edited but incoming is NOT edited — preserve local edit
  if (existing.is_edited && !msg.isEdited && !msg.editedAt) {
    merged = { ...msg, text: existing.text, isEdited: true, editedAt: new Date().toISOString() };
  }

  // If existing was locally deleted but incoming is NOT deleted — preserve delete
  if (!merged && existing.is_deleted && !msg.isDeleted) {
    merged = {
      ...msg,
      text: 'This message was deleted',
      isDeleted: true,
      deletedFor: existing.deleted_for,
      mediaUrl: null, previewUrl: null, localUri: null,
    };
  }

  // Preserve localUri if existing has it and incoming doesn't
  if (!merged && existing.local_uri && !msg.localUri) {
    merged = { ...msg, localUri: existing.local_uri, previewUrl: msg.previewUrl || existing.local_uri };
  }

  // Preserve higher status (don't regress from 'delivered' to 'sent')
  if (!merged) {
    const incomingPriority = STATUS_PRIORITY[msg.status] || 0;
    const existingPriority = STATUS_PRIORITY[existing.status] || 0;
    if (existingPriority > incomingPriority) {
      merged = { ...msg, status: existing.status };
    }
  }

  // Always preserve local reactions if incoming has none
  // Reactions are local state that the server sync response often doesn't include
  if (existingReactions && Object.keys(existingReactions).length > 0 && !msg.reactions) {
    if (merged) {
      merged.reactions = existingReactions;
    } else {
      merged = { ...msg, reactions: existingReactions };
    }
  }

  return merged;
};

/**
 * Upsert a single message — IMMEDIATE, not batched.
 * Preserves locally edited/deleted state if server sends stale data.
 */
const upsertMessage = async (msg) => {
  if (!msg) return;
  const db = await getDB();
  await cleanBeforeUpsert(db, msg);
  const merged = await preserveLocalEdits(db, msg);
  await db.runAsync(UPSERT_SQL, msgToRow(merged || msg));
};

/**
 * Upsert an array of messages in a single transaction.
 * Used for sync responses and batch imports.
 */
const upsertMessages = async (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) return;
  const db = await getDB();

  const BATCH_SIZE = 100;
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    await db.withTransactionAsync(async () => {
      for (const msg of batch) {
        await cleanBeforeUpsert(db, msg);
        const merged = await preserveLocalEdits(db, msg);
        await db.runAsync(UPSERT_SQL, msgToRow(merged || msg));
      }
    });
  }
};

/**
 * Load messages for a chatId, sorted by timestamp DESC.
 * This is the ONLY way UI should get messages — single source of truth.
 */
const loadMessages = async (chatId, { limit = 50, offset = 0, afterTimestamp = 0 } = {}) => {
  if (!chatId) return [];
  const db = await getDB();

  const rows = await db.getAllAsync(
    `SELECT * FROM messages
     WHERE chat_id = $chatId AND timestamp > $afterTs
     ORDER BY timestamp DESC
     LIMIT $limit OFFSET $offset`,
    { $chatId: chatId, $afterTs: afterTimestamp, $limit: limit, $offset: offset }
  );

  return rows.map(rowToMsg);
};

/**
 * Get a single message by any of its IDs.
 */
const getMessage = async (messageId) => {
  if (!messageId) return null;
  const db = await getDB();
  const row = await db.getFirstAsync(
    `SELECT * FROM messages
     WHERE id = $id OR server_message_id = $id OR temp_id = $id
     LIMIT 1`,
    { $id: messageId }
  );
  return rowToMsg(row);
};

/**
 * Check if a message exists by any of its IDs.
 */
const messageExists = async (messageId) => {
  if (!messageId) return false;
  const db = await getDB();
  const row = await db.getFirstAsync(
    `SELECT 1 FROM messages WHERE id = $id OR server_message_id = $id OR temp_id = $id LIMIT 1`,
    { $id: messageId }
  );
  return Boolean(row);
};

/**
 * ACK: transition tempId → serverMessageId.
 * Updates the existing temp row in place — no duplicate created.
 * Preserves edited state if the message was edited before ACK arrived.
 */
const acknowledgeMessage = async (tempId, serverMessageId) => {
  if (!tempId || !serverMessageId) return;
  const db = await getDB();

  // Check if a server row already exists (from sync response arriving before ACK)
  const serverRow = await db.getFirstAsync(
    `SELECT id, is_edited, text FROM messages WHERE id = $serverId OR server_message_id = $serverId LIMIT 1`,
    { $serverId: serverMessageId }
  );
  // Check the temp row
  const tempRow = await db.getFirstAsync(
    `SELECT id, is_edited, text FROM messages WHERE id = $tempId OR temp_id = $tempId LIMIT 1`,
    { $tempId: tempId }
  );

  if (serverRow && tempRow && serverRow.id !== tempRow.id) {
    // Both rows exist — keep the one with the latest edit state
    const keepTemp = tempRow.is_edited && !serverRow.is_edited;
    if (keepTemp) {
      // Temp row has edits that server row doesn't — delete server row, upgrade temp row
      await db.runAsync(`DELETE FROM messages WHERE id = $serverId`, { $serverId: serverRow.id });
      await db.runAsync(
        `UPDATE messages SET id = $serverId, server_message_id = $serverId, synced = 1, status = 'sent'
         WHERE id = $tempId`,
        { $serverId: serverMessageId, $tempId: tempRow.id }
      );
    } else {
      // Server row is up to date — delete temp row
      await db.runAsync(`DELETE FROM messages WHERE id = $tempId`, { $tempId: tempRow.id });
    }
  } else if (tempRow && !serverRow) {
    // Only temp row exists — just upgrade it
    await db.runAsync(
      `UPDATE messages SET id = $serverId, server_message_id = $serverId, synced = 1, status = 'sent'
       WHERE temp_id = $tempId OR id = $tempId`,
      { $serverId: serverMessageId, $tempId: tempId }
    );
  }
  // If only serverRow exists (no temp), nothing to do — already acknowledged
};

/**
 * Update message status. Only advances, never regresses.
 * Returns true if status changed.
 */
const updateMessageStatus = async (messageId, newStatus) => {
  if (!messageId || !newStatus) return false;
  const db = await getDB();

  const newPriority = STATUS_PRIORITY[newStatus] || 0;
  const current = await db.getFirstAsync(
    `SELECT status FROM messages WHERE id = $id OR server_message_id = $id OR temp_id = $id LIMIT 1`,
    { $id: messageId }
  );
  if (!current) return false;
  const currentPriority = STATUS_PRIORITY[current.status] || 0;
  if (newPriority <= currentPriority) return false;

  await db.runAsync(
    `UPDATE messages SET status = $status
     WHERE id = $id OR server_message_id = $id OR temp_id = $id`,
    { $status: newStatus, $id: messageId }
  );
  return true;
};

/**
 * Mark a message as deleted for everyone.
 */
const markMessageDeleted = async (messageId, deletedBy, placeholderText) => {
  if (!messageId) return;
  const db = await getDB();
  await db.runAsync(
    `UPDATE messages SET
       is_deleted = 1,
       deleted_for = 'everyone',
       deleted_by = $deletedBy,
       placeholder_text = $placeholder,
       text = 'This message was deleted',
       media_url = NULL,
       preview_url = NULL,
       local_uri = NULL
     WHERE id = $id OR server_message_id = $id OR temp_id = $id`,
    { $id: messageId, $deletedBy: deletedBy || null, $placeholder: placeholderText || null }
  );
};

/**
 * Delete a message locally (delete for me — removes row entirely).
 */
const deleteMessageForMe = async (messageId) => {
  if (!messageId) return;
  const db = await getDB();
  await db.runAsync(
    `DELETE FROM messages WHERE id = $id OR server_message_id = $id OR temp_id = $id`,
    { $id: messageId }
  );
};

/**
 * Update reactions JSON for a message.
 */
const updateReactions = async (messageId, reactions) => {
  if (!messageId) return;
  const db = await getDB();
  await db.runAsync(
    `UPDATE messages SET reactions = $reactions
     WHERE id = $id OR server_message_id = $id OR temp_id = $id`,
    { $id: messageId, $reactions: reactions ? JSON.stringify(reactions) : null }
  );
};

/**
 * Update edit state for a message.
 */
const updateMessageEdit = async (messageId, newText, editedAt) => {
  if (!messageId || !newText) return;
  const db = await getDB();

  try {
    // Update the message text in ALL matching rows
    await db.runAsync(
      `UPDATE messages SET text = $text, is_edited = 1, edited_at = $editedAt
       WHERE id = $id OR server_message_id = $id OR temp_id = $id`,
      { $id: messageId, $text: newText, $editedAt: editedAt || new Date().toISOString() }
    );

    // Clean up duplicate rows after edit
    const row = await db.getFirstAsync(
      `SELECT chat_id, sender_id, timestamp FROM messages
       WHERE id = $id OR server_message_id = $id OR temp_id = $id LIMIT 1`,
      { $id: messageId }
    );

    if (row) {
      // Delete temp duplicates that have the same edited text
      await db.runAsync(
        `DELETE FROM messages
         WHERE chat_id = $chatId AND sender_id = $senderId AND text = $text
           AND ABS(timestamp - $ts) < 5000 AND id LIKE 'temp_%'
           AND EXISTS (
             SELECT 1 FROM messages s
             WHERE s.chat_id = $chatId AND s.id NOT LIKE 'temp_%'
               AND s.sender_id = $senderId AND s.text = $text
               AND ABS(s.timestamp - $ts) < 5000
           )`,
        { $chatId: row.chat_id, $senderId: row.sender_id, $text: newText, $ts: row.timestamp }
      );
    }
  } catch (err) {
    console.warn('[ChatDB] updateMessageEdit error:', err);
  }
};

/**
 * Clear all messages for a chat.
 */
const clearChat = async (chatId, clearedAtTimestamp = null) => {
  if (!chatId) return;
  const db = await getDB();
  if (clearedAtTimestamp) {
    await db.runAsync(
      `DELETE FROM messages WHERE chat_id = $chatId AND timestamp <= $ts`,
      { $chatId: chatId, $ts: clearedAtTimestamp }
    );
  } else {
    await db.runAsync(`DELETE FROM messages WHERE chat_id = $chatId`, { $chatId: chatId });
  }
  await db.runAsync(
    `INSERT OR REPLACE INTO chat_meta (chat_id, cleared_at, updated_at)
     VALUES ($chatId, $ts, $now)`,
    { $chatId: chatId, $ts: clearedAtTimestamp || Date.now(), $now: Date.now() }
  );
};

const getClearedAt = async (chatId) => {
  if (!chatId) return 0;
  const db = await getDB();
  const row = await db.getFirstAsync(
    `SELECT cleared_at FROM chat_meta WHERE chat_id = $chatId`,
    { $chatId: chatId }
  );
  return row?.cleared_at || 0;
};

const getMessageCount = async (chatId) => {
  if (!chatId) return 0;
  const db = await getDB();
  const row = await db.getFirstAsync(
    `SELECT COUNT(*) as count FROM messages WHERE chat_id = $chatId`,
    { $chatId: chatId }
  );
  return row?.count || 0;
};

const updateGroupMessageTracking = async (messageId, { deliveredTo, readBy } = {}) => {
  if (!messageId) return;
  const db = await getDB();
  const updates = [];
  const params = { $id: messageId };
  if (deliveredTo) { updates.push('delivered_to = $dt'); params.$dt = JSON.stringify(deliveredTo); }
  if (readBy) { updates.push('read_by = $rb'); params.$rb = JSON.stringify(readBy); }
  if (updates.length === 0) return;
  await db.runAsync(
    `UPDATE messages SET ${updates.join(', ')}
     WHERE id = $id OR server_message_id = $id OR temp_id = $id`,
    params
  );
};

const searchMessages = async (chatId, query, limit = 50) => {
  if (!chatId || !query) return [];
  const db = await getDB();
  const rows = await db.getAllAsync(
    `SELECT * FROM messages
     WHERE chat_id = $chatId AND text LIKE $query AND is_deleted = 0
     ORDER BY timestamp DESC LIMIT $limit`,
    { $chatId: chatId, $query: `%${query}%`, $limit: limit }
  );
  return rows.map(rowToMsg);
};

const getLatestMessage = async (chatId) => {
  if (!chatId) return null;
  const db = await getDB();
  const row = await db.getFirstAsync(
    `SELECT * FROM messages WHERE chat_id = $chatId ORDER BY timestamp DESC LIMIT 1`,
    { $chatId: chatId }
  );
  return rowToMsg(row);
};

/**
 * Run dedup cleanup on a chat — idempotent safety net.
 * Runs on chat open to clean up any accumulated duplicates from race conditions.
 */
const deduplicateChat = async (chatId) => {
  if (!chatId) return;
  const db = await getDB();

  // 1. Remove exact primary key duplicates (shouldn't happen but safety net)
  await db.runAsync(`
    DELETE FROM messages WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM messages
      WHERE chat_id = $chatId
      GROUP BY id
    ) AND chat_id = $chatId
  `, { $chatId: chatId });

  // 2. Remove temp rows that have a corresponding server-confirmed row (by temp_id link)
  await db.runAsync(`
    DELETE FROM messages WHERE chat_id = $chatId
      AND server_message_id IS NULL
      AND temp_id IS NOT NULL
      AND temp_id IN (
        SELECT temp_id FROM messages WHERE chat_id = $chatId AND server_message_id IS NOT NULL
      )
  `, { $chatId: chatId });

  // 3. Remove temp TEXT rows that have a matching server-confirmed row
  await db.runAsync(`
    DELETE FROM messages WHERE chat_id = $chatId
      AND id LIKE 'temp_%'
      AND (type = 'text' OR type IS NULL)
      AND EXISTS (
        SELECT 1 FROM messages s
        WHERE s.chat_id = $chatId
          AND s.id NOT LIKE 'temp_%'
          AND s.sender_id = messages.sender_id
          AND s.text = messages.text
          AND ABS(s.timestamp - messages.timestamp) < 5000
      )
  `, { $chatId: chatId });

  // 4. Remove temp MEDIA rows that have a matching server-confirmed row (by media_id or media_url)
  await db.runAsync(`
    DELETE FROM messages WHERE chat_id = $chatId
      AND id LIKE 'temp_%'
      AND type NOT IN ('text', 'system')
      AND EXISTS (
        SELECT 1 FROM messages s
        WHERE s.chat_id = $chatId
          AND s.id NOT LIKE 'temp_%'
          AND s.sender_id = messages.sender_id
          AND s.type = messages.type
          AND ABS(s.timestamp - messages.timestamp) < 5000
          AND (
            (s.media_id IS NOT NULL AND s.media_id = messages.media_id)
            OR (s.media_url IS NOT NULL AND s.media_url = messages.media_url)
            OR (s.media_id IS NULL AND s.media_url IS NULL)
          )
      )
  `, { $chatId: chatId });
};

/**
 * Bulk update status for multiple messages (e.g., mark all as read).
 */
const bulkUpdateStatus = async (chatId, newStatus, options = {}) => {
  if (!chatId || !newStatus) return;
  const db = await getDB();
  const { senderIdNot = null } = options;

  if (senderIdNot) {
    // Only update messages NOT sent by this user (incoming messages)
    const currentStatuses = Object.entries(STATUS_PRIORITY)
      .filter(([, p]) => p < (STATUS_PRIORITY[newStatus] || 0))
      .map(([s]) => `'${s}'`)
      .join(',');
    if (!currentStatuses) return;
    await db.runAsync(
      `UPDATE messages SET status = $status
       WHERE chat_id = $chatId AND sender_id != $senderId AND status IN (${currentStatuses})`,
      { $status: newStatus, $chatId: chatId, $senderId: senderIdNot }
    );
  } else {
    await db.runAsync(
      `UPDATE messages SET status = $status WHERE chat_id = $chatId`,
      { $status: newStatus, $chatId: chatId }
    );
  }
};

const closeDB = async () => {
  if (_db) {
    await _db.closeAsync();
    _db = null;
  }
};

// Legacy aliases for backward compatibility
const saveMessageSync = upsertMessage;
const saveMessages = upsertMessages;

export default {
  getDB,
  // Primary write operations
  upsertMessage,
  upsertMessages,
  acknowledgeMessage,
  updateMessageStatus,
  // Read operations
  loadMessages,
  getMessage,
  messageExists,
  getLatestMessage,
  getMessageCount,
  searchMessages,
  getClearedAt,
  // Delete operations
  markMessageDeleted,
  deleteMessageForMe,
  clearChat,
  deduplicateChat,
  // Update operations
  updateReactions,
  updateMessageEdit,
  updateGroupMessageTracking,
  bulkUpdateStatus,
  // Lifecycle
  closeDB,
  // Legacy aliases
  saveMessageSync,
  saveMessages,
};
