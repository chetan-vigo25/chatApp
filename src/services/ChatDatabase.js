import * as SQLite from 'expo-sqlite';

const DB_NAME = 'vibeconnect_chat.db';
const DB_VERSION = 1;

let _db = null;

// ─── DATABASE INIT ──────────────────────────────────────
const getDB = async () => {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync(DB_NAME);
  await _db.execAsync('PRAGMA journal_mode = WAL;');
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

// ─── MESSAGE HELPERS ────────────────────────────────────

const msgToRow = (msg) => {
  const id = msg.serverMessageId || msg.id || msg.tempId || `unknown_${Date.now()}`;
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
    $text: msg.text || null,
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
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

// ─── PUBLIC API ─────────────────────────────────────────

/**
 * Save/upsert an array of messages for a chat.
 * Uses INSERT OR REPLACE for deduplication by primary key.
 */
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
 * Remove duplicate rows before inserting — handles temp→server ID transition.
 * Deletes any existing row where temp_id or server_message_id matches the new message.
 */
const removeDuplicateRows = async (db, msg) => {
  const id = msg.serverMessageId || msg.id || msg.tempId;
  const tempId = msg.tempId;
  const serverId = msg.serverMessageId;

  // If we have a server ID, delete any old temp row for this message
  if (serverId && tempId && serverId !== tempId) {
    await db.runAsync(
      `DELETE FROM messages WHERE id = $tempId AND id != $serverId`,
      { $tempId: tempId, $serverId: serverId }
    );
  }
  // Also clean up if temp_id column matches but id is different
  if (tempId) {
    await db.runAsync(
      `DELETE FROM messages WHERE temp_id = $tempId AND id != $id`,
      { $tempId: tempId, $id: id }
    );
  }
  if (serverId) {
    await db.runAsync(
      `DELETE FROM messages WHERE server_message_id = $sid AND id != $id`,
      { $sid: serverId, $id: id }
    );
  }
};

/**
 * Save a single message instantly (for send — no batching).
 */
const saveMessageSync = async (msg) => {
  if (!msg) return;
  const db = await getDB();
  await removeDuplicateRows(db, msg);
  const row = msgToRow(msg);
  await db.runAsync(UPSERT_SQL, row);
};

/**
 * Save/upsert an array of messages for a chat.
 * Uses a single transaction with runAsync for speed.
 */
const saveMessages = async (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) return;
  const db = await getDB();

  const BATCH_SIZE = 100;
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    await db.withTransactionAsync(async () => {
      for (const msg of batch) {
        await removeDuplicateRows(db, msg);
        await db.runAsync(UPSERT_SQL, msgToRow(msg));
      }
    });
  }
};

/**
 * Load messages for a chatId, sorted by timestamp DESC, with optional limit/offset.
 */
const loadMessages = async (chatId, { limit = 300, offset = 0, afterTimestamp = 0 } = {}) => {
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
 * Update message status (sent/delivered/seen).
 * Only advances status, never regresses.
 */
const updateMessageStatus = async (messageId, newStatus) => {
  if (!messageId || !newStatus) return;
  const db = await getDB();

  const priorities = { sending: 1, uploaded: 2, sent: 3, delivered: 4, seen: 5, read: 5 };
  const newPriority = priorities[newStatus] || 0;

  // Read current status to prevent regression
  const current = await db.getFirstAsync(
    `SELECT status FROM messages WHERE id = $id OR server_message_id = $id OR temp_id = $id LIMIT 1`,
    { $id: messageId }
  );
  const currentPriority = priorities[current?.status] || 0;
  if (newPriority <= currentPriority) return;

  await db.runAsync(
    `UPDATE messages SET status = $status
     WHERE id = $id OR server_message_id = $id OR temp_id = $id`,
    { $status: newStatus, $id: messageId }
  );
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
 * Update message after server ACK (set serverMessageId, status to sent).
 */
const acknowledgeMessage = async (tempId, serverMessageId) => {
  if (!tempId || !serverMessageId) return;
  const db = await getDB();
  // Delete any existing row with the server ID to prevent duplicates
  await db.runAsync(
    `DELETE FROM messages WHERE id = $serverId AND temp_id != $tempId`,
    { $serverId: serverMessageId, $tempId: tempId }
  );
  // Update the temp row to use the server ID
  await db.runAsync(
    `UPDATE messages SET
       server_message_id = $serverId, id = $serverId, synced = 1, status = 'sent'
     WHERE temp_id = $tempId OR id = $tempId`,
    { $serverId: serverMessageId, $tempId: tempId }
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
  if (!messageId) return;
  const db = await getDB();
  await db.runAsync(
    `UPDATE messages SET text = $text, is_edited = 1, edited_at = $editedAt
     WHERE id = $id OR server_message_id = $id OR temp_id = $id`,
    { $id: messageId, $text: newText, $editedAt: editedAt || new Date().toISOString() }
  );
};

/**
 * Clear all messages for a chat (with optional timestamp filter).
 */
const clearChat = async (chatId, clearedAtTimestamp = null) => {
  if (!chatId) return;
  const db = await getDB();
  if (clearedAtTimestamp) {
    await db.runAsync(
      `DELETE FROM messages WHERE chat_id = $chatId AND timestamp <= $ts`,
      { $chatId: chatId, $ts: clearedAtTimestamp }
    );
    await db.runAsync(
      `INSERT OR REPLACE INTO chat_meta (chat_id, cleared_at, updated_at)
       VALUES ($chatId, $ts, $now)`,
      { $chatId: chatId, $ts: clearedAtTimestamp, $now: Date.now() }
    );
  } else {
    await db.runAsync(`DELETE FROM messages WHERE chat_id = $chatId`, { $chatId: chatId });
    await db.runAsync(
      `INSERT OR REPLACE INTO chat_meta (chat_id, cleared_at, updated_at)
       VALUES ($chatId, $ts, $now)`,
      { $chatId: chatId, $ts: Date.now(), $now: Date.now() }
    );
  }
};

/**
 * Get the cleared_at timestamp for a chat.
 */
const getClearedAt = async (chatId) => {
  if (!chatId) return 0;
  const db = await getDB();
  const row = await db.getFirstAsync(
    `SELECT cleared_at FROM chat_meta WHERE chat_id = $chatId`,
    { $chatId: chatId }
  );
  return row?.cleared_at || 0;
};

/**
 * Get message count for a chat.
 */
const getMessageCount = async (chatId) => {
  if (!chatId) return 0;
  const db = await getDB();
  const row = await db.getFirstAsync(
    `SELECT COUNT(*) as count FROM messages WHERE chat_id = $chatId`,
    { $chatId: chatId }
  );
  return row?.count || 0;
};

/**
 * Update deliveredTo/readBy maps for group messages.
 */
const updateGroupMessageTracking = async (messageId, { deliveredTo, readBy } = {}) => {
  if (!messageId) return;
  const db = await getDB();
  const updates = [];
  const params = { $id: messageId };
  if (deliveredTo) {
    updates.push('delivered_to = $dt');
    params.$dt = JSON.stringify(deliveredTo);
  }
  if (readBy) {
    updates.push('read_by = $rb');
    params.$rb = JSON.stringify(readBy);
  }
  if (updates.length === 0) return;
  await db.runAsync(
    `UPDATE messages SET ${updates.join(', ')}
     WHERE id = $id OR server_message_id = $id OR temp_id = $id`,
    params
  );
};

/**
 * Search messages in a chat by text.
 */
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

/**
 * Get the latest message for a chat (for chat list preview).
 */
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
 * Remove duplicate messages in a chat — keeps the one with server_message_id.
 * Run once on chat open to clean up any accumulated duplicates.
 */
const deduplicateChat = async (chatId) => {
  if (!chatId) return;
  const db = await getDB();
  // Only remove rows that have the EXACT same primary id (true duplicates)
  // Keep the row with server_message_id if both exist
  await db.runAsync(`
    DELETE FROM messages WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM messages
      WHERE chat_id = $chatId
      GROUP BY id
    ) AND chat_id = $chatId
  `, { $chatId: chatId });
  // Also remove temp rows that have a corresponding server row
  await db.runAsync(`
    DELETE FROM messages WHERE chat_id = $chatId
      AND server_message_id IS NULL
      AND temp_id IS NOT NULL
      AND temp_id IN (
        SELECT temp_id FROM messages WHERE chat_id = $chatId AND server_message_id IS NOT NULL
      )
  `, { $chatId: chatId });
};

/**
 * Close the database connection.
 */
const closeDB = async () => {
  if (_db) {
    await _db.closeAsync();
    _db = null;
  }
};

export default {
  getDB,
  saveMessageSync,
  saveMessages,
  loadMessages,
  getMessage,
  updateMessageStatus,
  markMessageDeleted,
  deleteMessageForMe,
  acknowledgeMessage,
  updateReactions,
  updateMessageEdit,
  clearChat,
  getClearedAt,
  getMessageCount,
  updateGroupMessageTracking,
  searchMessages,
  getLatestMessage,
  deduplicateChat,
  closeDB,
};
