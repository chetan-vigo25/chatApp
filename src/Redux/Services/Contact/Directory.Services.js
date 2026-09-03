import { apiCall } from '../../../Config/Https';

/**
 * User directory search — find a REGISTERED user by their public handle
 * (`@username`) or by mobile number.
 *
 * Group membership used to be reachable only through the device phonebook, so
 * someone whose number was never saved could not be added to a group at all.
 * This is the second key: the identifier people actually share.
 *
 * Every rule lives on the server (minimum query length, exact-ish matching,
 * blocks in both directions, and the hideContact privacy substitution), so the
 * rows come back ready to render.
 */

// Below this the server refuses the query — don't spend a round trip.
export const MIN_DIRECTORY_QUERY = 3;

/**
 * Canonical form of a query, so the same LOOKUP is recognised as the same:
 * "@Raj", "raj" and "  RAJ " all key to `raj`, and a number keeps only its
 * digits. Used for the cache and for the "did the query really change?" test
 * that keeps a debounced hook from re-fetching what it just fetched.
 */
export const normalizeQuery = (text) => {
  const raw = String(text || '').trim();
  if (/^[+\d][\d\s()+-]*$/.test(raw)) return raw.replace(/\D/g, '');
  return raw.replace(/^@+/, '').replace(/\s+/g, ' ').toLowerCase();
};

// ── Client-side result cache ────────────────────────────────────────────────
// Typing is a loop of type → backspace → retype, so the same query comes round
// again seconds later. A short TTL keeps the list feeling instant AND spares
// the server the repeat; the cap keeps a long session from growing unbounded.
const CACHE_TTL_MS = 30 * 1000;
const CACHE_MAX_KEYS = 50;
const resultCache = new Map();

/** Cached rows for a query, or null. Exported so a hook can paint on frame 1. */
export const peekDirectoryCache = (query) => {
  const key = normalizeQuery(query);
  const hit = resultCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { resultCache.delete(key); return null; }
  return hit.users;
};

const cacheResult = (query, users) => {
  const key = normalizeQuery(query);
  resultCache.delete(key);
  resultCache.set(key, { users, expires: Date.now() + CACHE_TTL_MS });
  while (resultCache.size > CACHE_MAX_KEYS) {
    resultCache.delete(resultCache.keys().next().value);
  }
};

/** Drop everything — e.g. on logout, so results never cross accounts. */
export const clearDirectoryCache = () => resultCache.clear();

/** True when `text` is long enough for the server to accept it. */
export const isSearchableQuery = (text) => {
  const raw = String(text || '').trim();
  const handle = raw.replace(/^@+/, '').trim();
  const digits = raw.replace(/\D/g, '');
  return handle.length >= MIN_DIRECTORY_QUERY || digits.length >= MIN_DIRECTORY_QUERY;
};

/**
 * @returns {Promise<Array<{userId,name,userName,mobileNumber,avatar,isVerified,isSavedContact}>>}
 *          Empty array on any failure — this runs on debounced keystrokes, so a
 *          transient error must read as "no results", never as an error state.
 *          `silent` keeps the shared toast handler quiet for the same reason.
 */
export async function searchDirectory(query, { limit = 10, useCache = true } = {}) {
  if (!isSearchableQuery(query)) return [];
  if (useCache) {
    const cached = peekDirectoryCache(query);
    if (cached) return cached;
  }
  try {
    const res = await apiCall(
      'POST',
      'user/directory/search',
      { query: String(query).trim(), limit },
      { silent: true },
    );
    const users = res?.data?.users || res?.users || [];
    const rows = Array.isArray(users) ? users : [];
    cacheResult(query, rows);
    return rows;
  } catch {
    return [];
  }
}
