import * as SQLite from 'expo-sqlite';

const DB_NAME = 'TalksTry_contacts.db';
// v2: contact matching switched from hashed → PLAINTEXT E.164. The primary key is
// now `phone_number` (E.164); hash/salt/encrypt columns are gone. The local DB is
// a re-syncable cache, so the migration simply drops the old table and clears the
// sync markers — the next open triggers a fresh full sync that repopulates it.
const DB_VERSION = 2;

let _db = null;
let _dbInitPromise = null; // prevents race conditions — only one init at a time

// Serialize every multi-statement write on the single SQLite connection. expo-sqlite
// shares ONE native connection, so two concurrent `BEGIN TRANSACTION`s (e.g. a sync
// upsert overlapping a contact:registered upsert) collide with
// "cannot start a transaction within a transaction". This promise-chain mutex makes
// each write wait its turn. Reads don't need it. Mirrors ChatDatabase.runExclusive.
let _writeChain = Promise.resolve();
const runExclusive = (fn) => {
  const run = _writeChain.then(fn, fn); // run regardless of the prior task's outcome
  _writeChain = run.catch(() => {});    // keep the chain alive; don't poison it on error
  return run;
};

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

  // Try to open the DB and run init queries with up to `attempts` retries.
  // Native expo-sqlite on Android occasionally rejects the first execAsync after
  // a fresh openDatabaseAsync (NullPointerException) — usually clears on a retry
  // with a small back-off plus a fresh handle. We also tolerate PRAGMA failures
  // since journal_mode/synchronous are optimizations, not correctness.
  const tryOpen = async () => {
    const db = await SQLite.openDatabaseAsync(DB_NAME);
    // Settle tick: avoids the Android NullPointerException race between
    // openDatabaseAsync resolving and the native handle being fully ready.
    await new Promise((r) => setTimeout(r, 50));
    try { await db.execAsync('PRAGMA journal_mode = WAL;'); } catch (e) {
      console.warn('[ContactDB] PRAGMA journal_mode failed (non-fatal):', e?.message);
    }
    try { await db.execAsync('PRAGMA synchronous = NORMAL;'); } catch (e) {
      console.warn('[ContactDB] PRAGMA synchronous failed (non-fatal):', e?.message);
    }
    await runMigrations(db);
    return db;
  };

  const safeClose = async () => {
    if (!_db) return;
    try { await _db.closeAsync(); } catch {}
    _db = null;
  };

  _dbInitPromise = (async () => {
    const MAX_ATTEMPTS = 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        _db = await tryOpen();
        return _db;
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || '').toLowerCase();
        const isNative = msg.includes('nullpointerexception')
          || msg.includes('nativedatabase')
          || msg.includes('has been rejected')
          || msg.includes('database is closed');
        if (attempt < MAX_ATTEMPTS) {
          console.warn(`[ContactDB] getDB attempt ${attempt} failed${isNative ? ' (native)' : ''}: ${err?.message}; retrying...`);
          await safeClose();
          // Small back-off — gives Android time to release the native handle
          await new Promise((res) => setTimeout(res, 150 * attempt));
        }
      }
    }
    console.error('[ContactDB] getDB error (all retries exhausted):', lastErr);
    _db = null;
    throw lastErr;
  })().finally(() => {
    _dbInitPromise = null;
  });

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

  // v2 replaced the hashed schema. Drop any legacy hashed `contacts` table so we
  // don't mix hash-keyed and E.164-keyed rows, and clear the sync markers so the
  // next open runs a fresh full sync. (No data loss — it re-syncs from backend.)
  if (currentVersion < 2) {
    await db.execAsync('DROP TABLE IF EXISTS contacts;').catch(() => {});
    // Clear sync markers if the meta table already exists (fresh installs skip this).
    await db.execAsync(
      "DELETE FROM contact_sync_meta WHERE key IN ('initial_sync_done','sync_session_id','sync_metadata','last_sync_time','contacts_hash');"
    ).catch(() => {});
  }

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS contacts (
      phone_number TEXT PRIMARY KEY NOT NULL,
      original_id TEXT,
      user_id TEXT,
      type TEXT DEFAULT 'unregistered',
      full_name TEXT,
      email TEXT,
      phone TEXT,
      mobile_code TEXT,
      mobile_number TEXT,
      profile_image TEXT,
      about TEXT,
      is_active INTEGER DEFAULT 0,
      last_login TEXT,
      can_message INTEGER DEFAULT 0,
      is_blocked INTEGER DEFAULT 0,
      is_favorite INTEGER DEFAULT 0,
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
    CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);

    CREATE TABLE IF NOT EXISTS contact_sync_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT
    );
  `);

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

// The canonical key is the plaintext E.164 number (`c.phoneNumber`). The device's
// original display-formatted string is kept separately in `phone` for the UI.
const contactToRow = (c, now) => {
  const e164 = c.phoneNumber || c.normalizedPhone || null;
  return {
    $phone_number: e164,
    $original_id: c.originalId || null,
    $user_id: c.userId || null,
    $type: c.type || (c.userId ? 'registered' : 'unregistered'),
    $full_name: c.fullName || c.name || null,
    $email: c.email || null,
    $phone: c.originalPhone || c.phone || c.mobileFormatted || (c.mobile?.number) || e164 || null,
    $mobile_code: c.mobile?.code || null,
    $mobile_number: c.mobile?.number || null,
    $profile_image: c.profileImage || c.profilePicture || null,
    $about: c.about || null,
    $is_active: c.isActive ? 1 : 0,
    $last_login: c.lastLogin || null,
    $can_message: c.canMessage ? 1 : 0,
    $is_blocked: c.isBlocked ? 1 : 0,
    $is_favorite: c.isFavorite ? 1 : 0,
    $last_contacted: c.lastContacted || null,
    $joined_at: c.joinedWhatsAppAt || null,
    $is_new_until: c.isNewUntil || null,
    $updated_highlight_until: c.updatedHighlightUntil || null,
    $synced_at: now,
    $updated_at: now,
  };
};

const rowToContact = (row) => {
  if (!row) return null;
  return {
    phoneNumber: row.phone_number,
    // Back-compat alias: some UI code still reads `.hash` as the contact key.
    hash: row.phone_number,
    originalId: row.original_id,
    userId: row.user_id,
    type: row.type || 'unregistered',
    fullName: row.full_name || '',
    name: row.full_name || '',
    email: row.email,
    originalPhone: row.phone || row.phone_number,
    normalizedPhone: row.phone_number,
    phone: row.phone || row.phone_number,
    number: row.phone || row.phone_number,
    mobile: { code: row.mobile_code, number: row.mobile_number || row.phone },
    mobileFormatted: row.phone || row.phone_number || '',
    profileImage: row.profile_image || '',
    profilePicture: row.profile_image || '',
    about: row.about || '',
    isActive: Boolean(row.is_active),
    lastLogin: row.last_login,
    canMessage: Boolean(row.can_message),
    isBlocked: Boolean(row.is_blocked),
    isFavorite: Boolean(row.is_favorite),
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
  phone_number, original_id, user_id, type, full_name, email, phone,
  mobile_code, mobile_number, profile_image, about,
  is_active, last_login, can_message, is_blocked, is_favorite,
  last_contacted, joined_at,
  is_new_until, updated_highlight_until, synced_at, updated_at
) VALUES (
  $phone_number, $original_id, $user_id, $type, $full_name, $email, $phone,
  $mobile_code, $mobile_number, $profile_image, $about,
  $is_active, $last_login, $can_message, $is_blocked, $is_favorite,
  $last_contacted, $joined_at,
  $is_new_until, $updated_highlight_until, $synced_at, $updated_at
) ON CONFLICT(phone_number) DO UPDATE SET
  original_id = COALESCE($original_id, original_id),
  user_id = COALESCE($user_id, user_id),
  type = $type,
  full_name = COALESCE($full_name, full_name),
  email = COALESCE($email, email),
  phone = COALESCE($phone, phone),
  mobile_code = COALESCE($mobile_code, mobile_code),
  mobile_number = COALESCE($mobile_number, mobile_number),
  profile_image = COALESCE($profile_image, profile_image),
  about = COALESCE($about, about),
  is_active = $is_active,
  last_login = COALESCE($last_login, last_login),
  can_message = $can_message,
  is_blocked = $is_blocked,
  is_favorite = MAX(is_favorite, $is_favorite),
  last_contacted = COALESCE($last_contacted, last_contacted),
  joined_at = COALESCE($joined_at, joined_at),
  is_new_until = COALESCE($is_new_until, is_new_until),
  updated_highlight_until = COALESCE($updated_highlight_until, updated_highlight_until),
  synced_at = $synced_at,
  updated_at = $updated_at`;

const upsertContacts = async (contacts) => {
  if (!Array.isArray(contacts) || contacts.length === 0) return;

  // Serialized so no two upserts (or another write) open a transaction at once.
  return runExclusive(() => withDB(async (db) => {
    const now = Date.now();
    // Batch in chunks of 50, each wrapped in expo-sqlite's own transaction helper
    // (handles BEGIN/COMMIT/ROLLBACK internally — no manual, un-nestable BEGIN).
    const BATCH_SIZE = 50;
    for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
      const chunk = contacts.slice(i, i + BATCH_SIZE);
      try {
        await db.withTransactionAsync(async () => {
          for (const c of chunk) {
            if (!c?.phoneNumber && !c?.normalizedPhone) continue;
            await db.runAsync(UPSERT_SQL, contactToRow(c, now));
          }
        });
      } catch (err) {
        console.warn('[ContactDB] upsert batch error:', err?.message);
        // Fallback: one-by-one, no transaction (also covers older expo-sqlite
        // builds without withTransactionAsync).
        for (const c of chunk) {
          if (!c?.phoneNumber && !c?.normalizedPhone) continue;
          try {
            await db.runAsync(UPSERT_SQL, contactToRow(c, now));
          } catch (singleErr) {
            console.warn('[ContactDB] upsert single error for', c.phoneNumber, singleErr?.message);
          }
        }
      }
    }
  }));
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

// Look up a contact by its canonical E.164 number.
const getContactByPhone = async (phoneNumber) => {
  if (!phoneNumber) return null;
  return withDB(async (db) => {
    const row = await db.getFirstAsync('SELECT * FROM contacts WHERE phone_number = $p', { $p: String(phoneNumber) });
    return rowToContact(row);
  });
};
// Back-compat alias — the key is now the E.164 number, not a hash.
const getContactByHash = getContactByPhone;

const getContactByUserId = async (userId) => {
  if (!userId) return null;
  return withDB(async (db) => {
    const row = await db.getFirstAsync('SELECT * FROM contacts WHERE user_id = $u', { $u: userId });
    return rowToContact(row);
  });
};

// Resolve the display identity for a sender as THIS DEVICE knows them —
// saved-contact name first (by userId, then by phone digits), nothing else.
// Used by the notification layer so the banner name always matches the chat
// list (which resolves through the same contacts table). Returns
// { fullName, profileImage } or null when the sender isn't a saved contact.
const getContactDisplay = async ({ userId = null, phone = null } = {}) => {
  if (!userId && !phone) return null;
  return withDB(async (db) => {
    let row = null;
    if (userId) {
      row = await db.getFirstAsync(
        "SELECT full_name, profile_image FROM contacts WHERE user_id = $u AND full_name IS NOT NULL AND TRIM(full_name) != '' LIMIT 1",
        { $u: String(userId) }
      );
    }
    if (!row && phone) {
      const digits = String(phone).replace(/\D/g, '');
      if (digits) {
        // Match the last 10 digits against the E.164 key (handles country-code
        // variance — "+91XXXXXXXXXX" vs a bare 10-digit number).
        if (digits.length >= 10) {
          row = await db.getFirstAsync(
            "SELECT full_name, profile_image FROM contacts WHERE phone_number LIKE $p AND full_name IS NOT NULL AND TRIM(full_name) != '' LIMIT 1",
            { $p: `%${digits.slice(-10)}` }
          );
        }
        if (!row) {
          row = await db.getFirstAsync(
            "SELECT full_name, profile_image FROM contacts WHERE phone_number = $p AND full_name IS NOT NULL AND TRIM(full_name) != '' LIMIT 1",
            { $p: `+${digits}` }
          );
        }
      }
    }
    if (!row) return null;
    return { fullName: row.full_name?.trim() || null, profileImage: row.profile_image || null };
  });
};

const removeContacts = async (numbers) => {
  if (!Array.isArray(numbers) || numbers.length === 0) return;
  return runExclusive(() => withDB(async (db) => {
    const ph = numbers.map(() => '?').join(',');
    await db.runAsync(`DELETE FROM contacts WHERE phone_number IN (${ph})`, numbers);
  }));
};

const getExistingNumbers = async () => {
  return withDB(async (db) => {
    const rows = await db.getAllAsync('SELECT phone_number FROM contacts');
    return new Set(rows.map(r => r.phone_number));
  });
};

const clearAllContacts = async () => {
  return runExclusive(() => withDB(async (db) => {
    await db.execAsync('DELETE FROM contacts; DELETE FROM contact_sync_meta;');
  }));
};

/**
 * Remove contacts from SQLite whose E.164 numbers are NOT in the given set of
 * current device numbers. Cleans up contacts deleted from the device or SIM.
 * Returns the number of rows removed.
 */
const removeStaleContacts = async (currentNumbers) => {
  if (!currentNumbers || currentNumbers.size === 0) return 0;
  return runExclusive(() => withDB(async (db) => {
    const allRows = await db.getAllAsync('SELECT phone_number FROM contacts');
    const stale = allRows
      .map((r) => r.phone_number)
      .filter((n) => !currentNumbers.has(n));
    if (stale.length === 0) return 0;

    const BATCH = 100;
    let removed = 0;
    for (let i = 0; i < stale.length; i += BATCH) {
      const chunk = stale.slice(i, i + BATCH);
      const ph = chunk.map(() => '?').join(',');
      const result = await db.runAsync(`DELETE FROM contacts WHERE phone_number IN (${ph})`, chunk);
      removed += result?.changes || chunk.length;
    }
    console.log(`[ContactDB] removeStaleContacts: removed ${removed} stale records`);
    return removed;
  }));
};

const searchContacts = async (query, limit = 50) => {
  if (!query) return [];
  return withDB(async (db) => {
    const rows = await db.getAllAsync(
      'SELECT * FROM contacts WHERE full_name LIKE $q OR phone LIKE $q OR phone_number LIKE $q ORDER BY type ASC, full_name ASC LIMIT $l',
      { $q: `%${query}%`, $l: limit }
    );
    return rows.map(rowToContact);
  });
};

// ─── DIFF / INCREMENTAL SYNC HELPERS ────────────────────

const findNewContacts = async (incomingNumbers) => {
  if (!Array.isArray(incomingNumbers) || incomingNumbers.length === 0) return [];
  const existing = await getExistingNumbers();
  return incomingNumbers.filter(n => !existing.has(n));
};

// ─── DELTA CONTENT-HASH (skip unchanged syncs) ──────────
// The SHA-256 of the sorted E.164 set at the last successful sync. If the device
// phonebook produces the same hash, the client sends NO network request at all.
const getContactsHash = async () => getMeta('contacts_hash');
const setContactsHash = async (hash) => setMeta('contacts_hash', hash);

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
  getContactsHash,
  setContactsHash,
  // CRUD
  upsertContacts,
  loadAllContacts,
  loadRegisteredContacts,
  loadUnregisteredContacts,
  getContactCount,
  getContactByPhone,
  getContactByHash, // alias of getContactByPhone (back-compat)
  getContactByUserId,
  getContactDisplay,
  removeContacts,
  getExistingNumbers,
  clearAllContacts,
  removeStaleContacts,
  searchContacts,
  // Helpers
  findNewContacts,
  getStats,
};