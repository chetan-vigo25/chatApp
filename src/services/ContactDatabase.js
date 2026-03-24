import * as SQLite from 'expo-sqlite';

const DB_NAME = 'vibeconnect_contacts.db';
const DB_VERSION = 1;

let _db = null;
let _dbInitPromise = null; // prevents race conditions — only one init at a time

// ─── DATABASE INIT ──────────────────────────────────────

const getDB = async () => {
  // Fast path: DB already open and healthy
  if (_db) {
    try {
      // Heartbeat check: verify native connection is still alive
      await _db.getFirstAsync('SELECT 1');
      return _db;
    } catch {
      // Native connection is dead (app backgrounded, Android killed it)
      console.warn('[ContactDB] Stale DB connection detected, reconnecting...');
      _db = null;
      _dbInitPromise = null;
    }
  }

  // Prevent concurrent init: if already initializing, wait for it
  if (_dbInitPromise) {
    return _dbInitPromise;
  }

  _dbInitPromise = (async () => {
    try {
      _db = await SQLite.openDatabaseAsync(DB_NAME);
      await _db.execAsync('PRAGMA journal_mode = WAL;');
      await _db.execAsync('PRAGMA synchronous = NORMAL;');
      await runMigrations(_db);
      return _db;
    } catch (err) {
      console.error('[ContactDB] getDB error:', err);
      _db = null;
      // Retry once
      try {
        _db = await SQLite.openDatabaseAsync(DB_NAME);
        await _db.execAsync('PRAGMA journal_mode = WAL;');
        await runMigrations(_db);
        return _db;
      } catch (retryErr) {
        console.error('[ContactDB] getDB retry failed:', retryErr);
        _db = null;
        throw retryErr;
      }
    } finally {
      _dbInitPromise = null;
    }
  })();

  return _dbInitPromise;
};

/**
 * Safe wrapper: gets DB, runs a callback, handles stale connection errors with one retry.
 */
const withDB = async (fn) => {
  let db;
  try {
    db = await getDB();
    return await fn(db);
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    const isNativeError = msg.includes('nullpointerexception') ||
      msg.includes('nativedatabase') ||
      msg.includes('has been rejected') ||
      msg.includes('database is closed') ||
      msg.includes('prepareasync');

    if (isNativeError) {
      // Force reconnect and retry once
      console.warn('[ContactDB] Native DB error, forcing reconnect:', msg);
      _db = null;
      _dbInitPromise = null;
      try {
        db = await getDB();
        return await fn(db);
      } catch (retryErr) {
        console.error('[ContactDB] Retry after reconnect failed:', retryErr?.message);
        throw retryErr;
      }
    }
    throw err;
  }
};

const runMigrations = async (db) => {
  const result = await db.getFirstAsync('PRAGMA user_version;');
  const currentVersion = result?.user_version ?? 0;
  if (currentVersion >= DB_VERSION) return;

  if (currentVersion < 1) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS contacts (
        hash TEXT PRIMARY KEY NOT NULL,
        original_id TEXT,
        user_id TEXT,
        type TEXT DEFAULT 'unregistered',
        full_name TEXT,
        email TEXT,
        phone TEXT,
        phone_normalized TEXT,
        encrypt_number TEXT,
        mobile_code TEXT,
        mobile_number TEXT,
        profile_image TEXT,
        about TEXT,
        is_active INTEGER DEFAULT 0,
        last_login TEXT,
        can_message INTEGER DEFAULT 0,
        is_blocked INTEGER DEFAULT 0,
        is_favorite INTEGER DEFAULT 0,
        hash_algorithm TEXT,
        hash_salt TEXT,
        last_contacted TEXT,
        joined_at INTEGER,
        is_new_until INTEGER,
        updated_highlight_until INTEGER,
        synced_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
      CREATE INDEX IF NOT EXISTS idx_contacts_original_id ON contacts(original_id);
      CREATE INDEX IF NOT EXISTS idx_contacts_type ON contacts(type);
      CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_normalized);

      CREATE TABLE IF NOT EXISTS contact_sync_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT
      );
    `);
  }

  await db.execAsync(`PRAGMA user_version = ${DB_VERSION};`);
};

// ─── META HELPERS ───────────────────────────────────────

const getMeta = async (key) => {
  return withDB(async (db) => {
    const row = await db.getFirstAsync('SELECT value FROM contact_sync_meta WHERE key = $k', { $k: key });
    return row?.value ?? null;
  });
};

const setMeta = async (key, value) => {
  return withDB(async (db) => {
    await db.runAsync(
      'INSERT OR REPLACE INTO contact_sync_meta (key, value) VALUES ($k, $v)',
      { $k: key, $v: value == null ? null : String(value) }
    );
  });
};

const getMetaJSON = async (key) => {
  const raw = await getMeta(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

const setMetaJSON = async (key, obj) => {
  await setMeta(key, JSON.stringify(obj));
};

// ─── PUBLIC META API ────────────────────────────────────

const isInitialSyncDone = async () => {
  const val = await getMeta('initial_sync_done');
  return val === 'true';
};

const markInitialSyncDone = async () => {
  await setMeta('initial_sync_done', 'true');
};

const getSyncSessionId = async () => getMeta('sync_session_id');
const setSyncSessionId = async (id) => setMeta('sync_session_id', id);

const getSyncMetadata = async () => getMetaJSON('sync_metadata');
const setSyncMetadata = async (metadata) => setMetaJSON('sync_metadata', metadata);

const getLastSyncTime = async () => {
  const val = await getMeta('last_sync_time');
  return val ? Number(val) : null;
};
const setLastSyncTime = async (ts) => setMeta('last_sync_time', String(ts));

// ─── CONTACT ROW MAPPING ────────────────────────────────

const contactToRow = (c, now) => ({
  $hash: c.hash,
  $original_id: c.originalId || null,
  $user_id: c.userId || null,
  $type: c.type || (c.userId ? 'registered' : 'unregistered'),
  $full_name: c.fullName || c.name || null,
  $email: c.email || null,
  $phone: c.originalPhone || c.phone || c.mobileFormatted || (c.mobile?.number) || null,
  $phone_normalized: c.normalizedPhone || null,
  $encrypt_number: c.encryptNumber || null,
  $mobile_code: c.mobile?.code || null,
  $mobile_number: c.mobile?.number || null,
  $profile_image: c.profileImage || c.profilePicture || null,
  $about: c.about || null,
  $is_active: c.isActive ? 1 : 0,
  $last_login: c.lastLogin || null,
  $can_message: c.canMessage ? 1 : 0,
  $is_blocked: c.isBlocked ? 1 : 0,
  $is_favorite: c.isFavorite ? 1 : 0,
  $hash_algorithm: c.hashDetails?.algorithm || c.algorithm || null,
  $hash_salt: c.hashDetails?.salt || c.salt || null,
  $last_contacted: c.lastContacted || null,
  $joined_at: c.joinedWhatsAppAt || null,
  $is_new_until: c.isNewUntil || null,
  $updated_highlight_until: c.updatedHighlightUntil || null,
  $synced_at: now,
  $updated_at: now,
});

const rowToContact = (row) => {
  if (!row) return null;
  return {
    hash: row.hash,
    originalId: row.original_id,
    userId: row.user_id,
    type: row.type || 'unregistered',
    fullName: row.full_name || '',
    name: row.full_name || '',
    email: row.email,
    originalPhone: row.phone,
    normalizedPhone: row.phone_normalized,
    phone: row.phone,
    number: row.phone,
    encryptNumber: row.encrypt_number,
    mobile: { code: row.mobile_code, number: row.mobile_number || row.phone },
    mobileFormatted: row.phone || '',
    profileImage: row.profile_image || '',
    profilePicture: row.profile_image || '',
    about: row.about || '',
    isActive: Boolean(row.is_active),
    lastLogin: row.last_login,
    canMessage: Boolean(row.can_message),
    isBlocked: Boolean(row.is_blocked),
    isFavorite: Boolean(row.is_favorite),
    hashDetails: { algorithm: row.hash_algorithm, salt: row.hash_salt },
    lastContacted: row.last_contacted,
    joinedWhatsAppAt: row.joined_at,
    isNewUntil: row.is_new_until,
    updatedHighlightUntil: row.updated_highlight_until,
    _syncedAt: row.synced_at,
    _updatedAt: row.updated_at,
  };
};

// ─── CRUD OPERATIONS ────────────────────────────────────

const UPSERT_SQL = `INSERT INTO contacts (
  hash, original_id, user_id, type, full_name, email, phone, phone_normalized,
  encrypt_number, mobile_code, mobile_number, profile_image, about,
  is_active, last_login, can_message, is_blocked, is_favorite,
  hash_algorithm, hash_salt, last_contacted, joined_at,
  is_new_until, updated_highlight_until, synced_at, updated_at
) VALUES (
  $hash, $original_id, $user_id, $type, $full_name, $email, $phone, $phone_normalized,
  $encrypt_number, $mobile_code, $mobile_number, $profile_image, $about,
  $is_active, $last_login, $can_message, $is_blocked, $is_favorite,
  $hash_algorithm, $hash_salt, $last_contacted, $joined_at,
  $is_new_until, $updated_highlight_until, $synced_at, $updated_at
) ON CONFLICT(hash) DO UPDATE SET
  original_id = COALESCE($original_id, original_id),
  user_id = COALESCE($user_id, user_id),
  type = $type,
  full_name = COALESCE($full_name, full_name),
  email = COALESCE($email, email),
  phone = COALESCE($phone, phone),
  phone_normalized = COALESCE($phone_normalized, phone_normalized),
  encrypt_number = COALESCE($encrypt_number, encrypt_number),
  mobile_code = COALESCE($mobile_code, mobile_code),
  mobile_number = COALESCE($mobile_number, mobile_number),
  profile_image = COALESCE($profile_image, profile_image),
  about = COALESCE($about, about),
  is_active = $is_active,
  last_login = COALESCE($last_login, last_login),
  can_message = $can_message,
  is_blocked = $is_blocked,
  is_favorite = MAX(is_favorite, $is_favorite),
  hash_algorithm = COALESCE($hash_algorithm, hash_algorithm),
  hash_salt = COALESCE($hash_salt, hash_salt),
  last_contacted = COALESCE($last_contacted, last_contacted),
  joined_at = COALESCE($joined_at, joined_at),
  is_new_until = COALESCE($is_new_until, is_new_until),
  updated_highlight_until = COALESCE($updated_highlight_until, updated_highlight_until),
  synced_at = $synced_at,
  updated_at = $updated_at`;

const upsertContacts = async (contacts) => {
  if (!Array.isArray(contacts) || contacts.length === 0) return;

  return withDB(async (db) => {
    const now = Date.now();
    // Batch in chunks of 50 inside a transaction for performance + safety
    const BATCH_SIZE = 50;
    for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
      const chunk = contacts.slice(i, i + BATCH_SIZE);
      try {
        await db.execAsync('BEGIN TRANSACTION');
        for (const c of chunk) {
          if (!c?.hash) continue;
          await db.runAsync(UPSERT_SQL, contactToRow(c, now));
        }
        await db.execAsync('COMMIT');
      } catch (err) {
        try { await db.execAsync('ROLLBACK'); } catch {}
        console.warn('[ContactDB] upsert batch error:', err?.message);
        // Fallback: try one-by-one for this chunk
        for (const c of chunk) {
          if (!c?.hash) continue;
          try {
            await db.runAsync(UPSERT_SQL, contactToRow(c, now));
          } catch (singleErr) {
            console.warn('[ContactDB] upsert single error for', c.hash, singleErr?.message);
          }
        }
      }
    }
  });
};

const loadAllContacts = async () => {
  return withDB(async (db) => {
    const rows = await db.getAllAsync(
      'SELECT * FROM contacts ORDER BY type ASC, full_name ASC'
    );
    return rows.map(rowToContact);
  });
};

const loadRegisteredContacts = async () => {
  return withDB(async (db) => {
    const rows = await db.getAllAsync(
      "SELECT * FROM contacts WHERE type = 'registered' OR user_id IS NOT NULL ORDER BY full_name ASC"
    );
    return rows.map(rowToContact);
  });
};

const loadUnregisteredContacts = async () => {
  return withDB(async (db) => {
    const rows = await db.getAllAsync(
      "SELECT * FROM contacts WHERE type != 'registered' AND user_id IS NULL ORDER BY full_name ASC"
    );
    return rows.map(rowToContact);
  });
};

const getContactCount = async () => {
  return withDB(async (db) => {
    const row = await db.getFirstAsync('SELECT COUNT(*) as count FROM contacts');
    return row?.count || 0;
  });
};

const getContactByHash = async (hash) => {
  if (!hash) return null;
  return withDB(async (db) => {
    const row = await db.getFirstAsync('SELECT * FROM contacts WHERE hash = $h', { $h: hash });
    return rowToContact(row);
  });
};

const getContactByUserId = async (userId) => {
  if (!userId) return null;
  return withDB(async (db) => {
    const row = await db.getFirstAsync('SELECT * FROM contacts WHERE user_id = $u', { $u: userId });
    return rowToContact(row);
  });
};

const removeContacts = async (hashes) => {
  if (!Array.isArray(hashes) || hashes.length === 0) return;
  return withDB(async (db) => {
    const ph = hashes.map(() => '?').join(',');
    await db.runAsync(`DELETE FROM contacts WHERE hash IN (${ph})`, hashes);
  });
};

const getExistingHashes = async () => {
  return withDB(async (db) => {
    const rows = await db.getAllAsync('SELECT hash FROM contacts');
    return new Set(rows.map(r => r.hash));
  });
};

const clearAllContacts = async () => {
  return withDB(async (db) => {
    await db.execAsync('DELETE FROM contacts; DELETE FROM contact_sync_meta;');
  });
};

const searchContacts = async (query, limit = 50) => {
  if (!query) return [];
  return withDB(async (db) => {
    const rows = await db.getAllAsync(
      'SELECT * FROM contacts WHERE full_name LIKE $q OR phone LIKE $q OR phone_normalized LIKE $q ORDER BY type ASC, full_name ASC LIMIT $l',
      { $q: `%${query}%`, $l: limit }
    );
    return rows.map(rowToContact);
  });
};

// ─── DIFF / INCREMENTAL SYNC HELPERS ────────────────────

const findNewContacts = async (incomingHashes) => {
  if (!Array.isArray(incomingHashes) || incomingHashes.length === 0) return [];
  const existing = await getExistingHashes();
  return incomingHashes.filter(h => !existing.has(h));
};

const getStats = async () => {
  return withDB(async (db) => {
    const total = await db.getFirstAsync('SELECT COUNT(*) as c FROM contacts');
    const registered = await db.getFirstAsync("SELECT COUNT(*) as c FROM contacts WHERE type = 'registered' OR user_id IS NOT NULL");
    const blocked = await db.getFirstAsync('SELECT COUNT(*) as c FROM contacts WHERE is_blocked = 1');
    return {
      totalContacts: total?.c || 0,
      registeredCount: registered?.c || 0,
      unregisteredCount: (total?.c || 0) - (registered?.c || 0),
      blockedCount: blocked?.c || 0,
    };
  });
};

export default {
  getDB,
  // Meta
  isInitialSyncDone,
  markInitialSyncDone,
  getSyncSessionId,
  setSyncSessionId,
  getSyncMetadata,
  setSyncMetadata,
  getLastSyncTime,
  setLastSyncTime,
  // CRUD
  upsertContacts,
  loadAllContacts,
  loadRegisteredContacts,
  loadUnregisteredContacts,
  getContactCount,
  getContactByHash,
  getContactByUserId,
  removeContacts,
  getExistingHashes,
  clearAllContacts,
  searchContacts,
  // Helpers
  findNewContacts,
  getStats,
};
