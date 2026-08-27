import ContactDatabase from './ContactDatabase';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { e164ForMatch, onlyDigits } from '../utils/savedContactName';
import { subscribeSessionReset } from './sessionEvents';
import { subscribeContactsChanged } from './contactEvents';

/**
 * contactNameStore
 * ────────────────
 * THE single source of truth for "what name do we show for this user?".
 *
 * WhatsApp rule (the ONLY rule — every surface must go through here):
 *   1. The peer is in MY device contacts  → my saved name for them.
 *   2. Otherwise                          → their phone number, formatted.
 *   3. Group contexts additionally show their self-set profile name as a
 *      secondary "~push name" line (never as the primary identity).
 *   4. The server's profile name (`fullName` on any payload) is ONLY a push
 *      name. It is never the primary label for an unsaved peer — that is the
 *      exact bug this store exists to prevent (a chat row showing "Chetan"
 *      when the user never saved that number).
 *
 * Why a module-level store and not just a hook: names are rendered from pure
 * render paths (memoized list rows, notification composition, the headless
 * push handler) that cannot await SQLite. The store keeps a synchronous
 * in-memory index and notifies subscribers whenever the underlying contacts
 * change, so every mounted screen re-resolves without a restart, a
 * re-navigation, or new message traffic.
 */

// E.164 / digits / userId → saved contact row.
let _index = null;          // null = never loaded
let _loading = null;        // in-flight load promise (dedupe concurrent callers)
let _version = 0;           // bumped on every successful (re)load
const _subscribers = new Set();

// Any write to the contacts table (sync upsert, remove, stale sweep, wipe)
// re-reads the index and notifies every mounted screen. This is what makes a
// contact saved/edited/deleted while the app is running flip names instantly.
subscribeContactsChanged(() => { loadContactNames(true); });

subscribeSessionReset(() => {
  _index = null;
  _loading = null;
  _version += 1;
  notify();
});

function notify() {
  for (const fn of _subscribers) {
    try { fn(_version); } catch { /* a bad subscriber must not break the rest */ }
  }
}

const buildIndex = (rows) => {
  const byUserId = new Map();
  const byE164 = new Map();
  const byDigits = new Map();
  for (const c of rows || []) {
    if (!c) continue;
    const name = String(c.fullName || c.name || '').trim();
    if (!name) continue; // a row without a device name tells us nothing
    const entry = { name, profileImage: c.profileImage || c.profilePicture || null };

    if (c.userId) byUserId.set(String(c.userId), entry);

    const numbers = [c.normalizedPhone, c.phoneNumber, c.hash, c.phone, c.number, c.originalPhone];
    for (const raw of numbers) {
      if (!raw) continue;
      const e164 = e164ForMatch(raw);
      if (e164 && !byE164.has(e164)) byE164.set(e164, entry);
      // Last-10-digit key absorbs country-code / formatting variance between
      // what the device stored and what the server reports.
      const digits = onlyDigits(raw);
      if (digits.length >= 7) {
        const tail = digits.slice(-10);
        if (!byDigits.has(tail)) byDigits.set(tail, entry);
      }
    }
  }
  return { byUserId, byE164, byDigits };
};

/** Load (or reload) the index from SQLite. Safe to call often — concurrent
 *  callers share one read. */
export const loadContactNames = async (force = false) => {
  if (_index && !force) return _index;
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      const rows = await ContactDatabase.loadAllContacts();
      _index = buildIndex(rows);
      _version += 1;
      notify();
    } catch {
      _index = _index || buildIndex([]);
    } finally {
      _loading = null;
    }
    return _index;
  })();
  return _loading;
};

/**
 * Tell every mounted surface that the address book changed (contact sync
 * finished, a contact was saved from a chat, a peer became registered).
 * Re-reads SQLite and re-renders all subscribers — this is what makes names
 * flip live without an app restart.
 */
export const invalidateContactNames = () => loadContactNames(true);

/** Subscribe to contact-name changes. Returns an unsubscribe function. */
export const subscribeContactNames = (fn) => {
  if (typeof fn !== 'function') return () => {};
  _subscribers.add(fn);
  // Kick off the first load for whoever subscribes first.
  if (!_index && !_loading) loadContactNames();
  return () => { _subscribers.delete(fn); };
};

/** Monotonic counter — use as a render key / effect dep to re-resolve names. */
export const getContactNamesVersion = () => _version;

/** Have we read the contacts table at least once this session? */
export const isContactIndexReady = () => _index !== null;

/**
 * My saved name for this peer, or null. Synchronous: reads the in-memory index
 * only (returns null before the first load — callers then fall back to the
 * number, never to a server name).
 */
export const getSavedName = ({ userId, phone } = {}) => {
  if (!_index) return null;
  if (userId) {
    const hit = _index.byUserId.get(String(userId));
    if (hit) return hit.name;
  }
  if (phone) {
    const e164 = e164ForMatch(phone);
    if (e164) {
      const hit = _index.byE164.get(e164);
      if (hit) return hit.name;
    }
    const digits = onlyDigits(phone);
    if (digits.length >= 7) {
      const hit = _index.byDigits.get(digits.slice(-10));
      if (hit) return hit.name;
    }
  }
  return null;
};

/** The locally-saved profile image for a peer, or null. */
export const getSavedAvatar = ({ userId, phone } = {}) => {
  if (!_index) return null;
  if (userId) {
    const hit = _index.byUserId.get(String(userId));
    if (hit?.profileImage) return hit.profileImage;
  }
  if (phone) {
    const e164 = e164ForMatch(phone);
    const hit = (e164 && _index.byE164.get(e164))
      || _index.byDigits.get(onlyDigits(phone).slice(-10));
    if (hit?.profileImage) return hit.profileImage;
  }
  return null;
};

/** Is this peer in my address book? */
export const isSavedContact = ({ userId, phone } = {}) =>
  Boolean(getSavedName({ userId, phone }));

/**
 * Pretty-print a number for display: "+91 77424 70999".
 * Anything already carrying separators is returned untouched.
 */
export const formatPhoneNumber = (raw) => {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';
  if (/[\s()\-]/.test(s)) return s;          // already grouped by the source
  const e164 = e164ForMatch(s) || (s.startsWith('+') ? s : null);
  if (!e164) return s;
  try {
    // libphonenumber knows where the country code ends — a hand-rolled
    // `\+\d{1,3}` split is greedy and mangles "+917742470999" into
    // "+917 74247 0999".
    const parsed = parsePhoneNumberFromString(e164);
    const pretty = parsed?.formatInternational?.();
    if (pretty) return pretty;
  } catch { /* fall through to the raw E.164 */ }
  return e164;
};

/**
 * THE resolver. Every display surface calls this.
 *
 *   resolveDisplayName({ userId, phone, pushName })
 *
 * @param userId    the peer's registered user id (may be null)
 * @param phone     any known number for them (E.164, local, {code,number} joined)
 * @param pushName  their SERVER profile name — used ONLY as a last resort when
 *                  no number is known at all, never ahead of the number
 * @param fallback  literal to return when nothing at all is known
 */
export const resolveDisplayName = ({
  userId = null,
  phone = null,
  pushName = null,
  fallback = 'Unknown',
} = {}) => {
  const saved = getSavedName({ userId, phone });
  if (saved) return saved;

  const formatted = formatPhoneNumber(phone);
  if (formatted) return formatted;

  // No number known (username-created accounts, half-hydrated rows). Only here
  // may the server's profile name surface.
  const push = String(pushName || '').trim();
  if (push) return push;

  return fallback;
};

/**
 * The WhatsApp "~push name" secondary label for GROUP contexts.
 * Returns null when the peer is saved (their saved name is the whole identity)
 * or when the server name adds nothing over what is already shown.
 */
export const resolvePushNameLabel = ({ userId = null, phone = null, pushName = null } = {}) => {
  const push = String(pushName || '').trim();
  if (!push) return null;
  if (getSavedName({ userId, phone })) return null;      // saved → no ~name
  if (onlyDigits(push) && onlyDigits(push) === onlyDigits(phone)) return null; // it IS the number
  return `~${push}`;
};

export default {
  loadContactNames,
  invalidateContactNames,
  subscribeContactNames,
  getContactNamesVersion,
  isContactIndexReady,
  getSavedName,
  getSavedAvatar,
  isSavedContact,
  formatPhoneNumber,
  resolveDisplayName,
  resolvePushNameLabel,
};
