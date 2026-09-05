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
 * The ONLY rule — every surface must go through here:
 *   1. The peer HIDES their contact details → their "@handle".
 *   2. Else, the peer is in MY device contacts → my saved name for them.
 *   3. Otherwise                          → their phone number, formatted.
 *   4. Group contexts additionally show their self-set profile name as a
 *      secondary "~push name" line (never as the primary identity) — and that
 *      line is suppressed entirely for a hidden peer, since a "~name" beside a
 *      withheld number re-attaches the identity they asked to hide.
 *   5. The server's profile name (`fullName` on any payload) is ONLY a push
 *      name. It is never the primary label for an unsaved peer — that is the
 *      exact bug this store exists to prevent (a chat row showing "Chetan"
 *      when the user never saved that number).
 *
 * Rule 1 sits ABOVE rule 2 by policy: `hideContact` means "hide me from
 * everyone", saved contacts included. See the POLICY SWITCH note on
 * resolveDisplayName for how to flip that back to WhatsApp parity.
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
  _peerIdentity.clear();
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

// ── Live peer identity overrides ──────────────────────────────────────────
//
// A `contact:updated` tells us a peer's handle / privacy flag / name / number
// changed RIGHT NOW. Most surfaces (status list, status viewers, likers, call
// logs, call info, forward picker, message info) render rows fetched from the
// server earlier, so those rows carry the state as it was AT FETCH TIME. Having
// each screen subscribe and patch its own list would mean the same fix written
// a dozen times, and a thirteenth screen would silently miss it.
//
// Instead the change is recorded once here, and every resolver consults it —
// so one socket event corrects every mounted surface at once. Bumping the
// version re-renders them (screens already depend on it for saved-name changes).
//
// Session-scoped by design: it is a freshness overlay on server rows, not a
// cache. The next fetch already carries the new values.
const _peerIdentity = new Map();   // userId → { userName, hideContact, fullName, mobileNumber }

/**
 * Record a peer's current identity/privacy state and re-render every subscriber.
 * Only defined keys are merged, so a partial event never blanks a known field.
 */
export const setPeerIdentity = (userId, patch = {}) => {
  const uid = userId != null ? String(userId) : '';
  if (!uid || !patch || typeof patch !== 'object') return;
  const prev = _peerIdentity.get(uid) || {};
  const next = { ...prev };
  for (const k of ['userName', 'hideContact', 'fullName', 'mobileNumber']) {
    if (patch[k] !== undefined) next[k] = k === 'hideContact' ? Boolean(patch[k]) : patch[k];
  }
  _peerIdentity.set(uid, next);
  _version += 1;
  notify();
};

/** The override for a peer, or null. */
export const getPeerIdentity = (userId) => {
  const uid = userId != null ? String(userId) : '';
  return (uid && _peerIdentity.get(uid)) || null;
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
 * Pretty-print a number for display: "+917742470999".
 *
 * NO separator at all — not a space, not a dash. The country code runs straight
 * into the national number (user rule). libphonenumber's `formatInternational()`
 * returns "+91 77424 70999", which read as a typo everywhere a number is shown
 * (chat list, chat header, profile screen and modal), and both separators that
 * were tried after it looked wrong too.
 *
 * A number that arrives already spaced or dashed is re-formatted rather than
 * passed through, since that grouping is exactly what we are removing.
 */
export const formatPhoneNumber = (raw) => {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';

  const compact = s.replace(/[\s()\-]/g, '');
  const e164 = e164ForMatch(compact) || (compact.startsWith('+') ? compact : null);
  if (!e164) return compact || s;

  try {
    // libphonenumber knows where the country code ends — a hand-rolled
    // `\+\d{1,3}` split is greedy and mangles "+917742470999" into
    // "+917 74247 0999".
    const parsed = parsePhoneNumberFromString(e164);
    if (parsed?.countryCallingCode && parsed?.nationalNumber) {
      return `+${parsed.countryCallingCode}${parsed.nationalNumber}`;
    }
  } catch { /* fall through to the raw E.164 */ }
  return e164;
};

/**
 * Is `raw` actually a phone number we may show as someone's identity?
 *
 * `formatPhoneNumber` is deliberately forgiving — it echoes back whatever it
 * was handed so a profile screen can print an odd-looking number rather than a
 * blank. The NAME resolver cannot be that forgiving: an account created from a
 * @handle carries a stub number ("404", "" or a couple of digits), and echoing
 * that back made the chat header read "404" for a peer whose handle is
 * "@error404". A string only counts as a number here if it canonicalises to
 * E.164 (libphonenumber's isPossible() is enough, so test/simulator numbers
 * still show).
 */
export const isDisplayablePhone = (raw) => {
  if (!raw) return false;
  const compact = String(raw).trim().replace(/[\s()\-]/g, '');
  if (!compact) return false;
  return Boolean(e164ForMatch(compact));
};

/** "error404" / "@error404" → "@error404"; anything empty → null. */
const handleOf = (username) => {
  const h = String(username || '').trim().replace(/^@+/, '');
  return h ? `@${h}` : null;
};

/**
 * The peer's handle when a FRESH server payload has redacted their name.
 *
 * `serializePublicUser` substitutes "@handle" into the name fields only for a
 * peer who hides their contact details, and a real profile name never starts
 * with "@" — so an "@handle" on a payload minted right now (a ring push, a
 * search response) IS the privacy flag, even when the payload forgot to ship
 * `callerHideContact` / `hideContact` beside it.
 *
 * Feed the result to `resolveDisplayName`'s `username` and its `isSelfRedacted`
 * branch does the rest. Use it ONLY on payloads that are fresh: a CACHED row's
 * "@handle" can be a leftover from before the peer turned the toggle back off,
 * which is what the stale-redaction guard below exists to discard.
 */
export const handleFromRedactedName = (pushName) => {
  const s = String(pushName || '').trim();
  return /^@[^@\s]+$/.test(s) ? s.slice(1) : null;
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
  username = null,
  hideContact = false,
  fallback = 'Unknown',
} = {}) => {
  // A live `contact:updated` outranks whatever the caller's row was fetched
  // with — that row may be minutes old (status list, call logs, forward picker).
  const live = getPeerIdentity(userId);
  if (live) {
    if (live.hideContact !== undefined) hideContact = live.hideContact;
    // A nullish handle in the overlay means "this event said nothing about the
    // handle", not "this peer has no handle" — it must not erase one the caller
    // passed in. Assigning it blind turned a partial `contact:updated` into an
    // app-wide identity wipe: no handle, and (with hideContact set) no number
    // either, so every surface fell through to the peer's raw account name.
    if (live.userName) username = live.userName;
    // A number the peer has since hidden must not be rendered from a stale row.
    if (live.hideContact) phone = null;
    else if (live.mobileNumber) phone = live.mobileNumber;
    if (live.fullName) pushName = live.fullName;
  }

  // ── Contact privacy — FIRST, by policy ───────────────────────────────────
  // The peer hides their contact details → show their public handle, and show
  // it even to someone who has them saved in this device's phonebook. The
  // saved-name check below is deliberately AFTER this one: the toggle means
  // "hide my name and number from everyone", so a local address-book entry must
  // not defeat it. The server sends the same "@handle" as `displayName`; this
  // branch is what stops the LOCAL saved name from overriding it.
  //
  // POLICY SWITCH: moving these lines back BELOW the saved check restores
  // WhatsApp parity ("saved contacts keep seeing the number") — and must be
  // done in all three resolvers at once, including
  // chat-backend/src/helpers/serializePublicUser.helper.js.
  // The caller's row may not carry `hideContact` at all — `chat:create`'s
  // peerUser, the directory-search row and the AddNewContact payload all omit
  // it. But a row whose NAME is exactly the peer's own "@handle" is the server
  // telling us the same thing: `serializePublicUser` writes that substitution
  // only for a peer who hides their details. Reading it as the privacy flag is
  // what keeps a handle-created account ("@test4422441", number withheld or a
  // stub) from opening as a phone number or a phonebook nickname.
  //
  // Requiring the handle to be present on the SAME row is what separates this
  // from the stale-redaction case below: a cached row that outlived the peer's
  // toggle carries the old "@handle" name but not the matching `userName`.
  const ownHandle = handleOf(username);
  const isSelfRedacted = Boolean(ownHandle)
    && String(pushName || '').trim().toLowerCase() === ownHandle.toLowerCase();
  if (isSelfRedacted) hideContact = true;

  if (hideContact && username) return ownHandle || fallback;

  const saved = getSavedName({ userId, phone });
  if (saved) return saved;

  // Self-healing guard for a STALE redacted name.
  //
  // While the peer had the toggle ON, the server substituted "@handle" into the
  // name fields — and the clients cached that value (SQLite rows, status
  // snapshots, call-log entries). When the peer turns the toggle back OFF those
  // caches still hold "@handle", so without this the handle would keep showing
  // on every surface that reads a cached name until the row was refetched.
  //
  // A real profile name never starts with "@", so an "@…" push name while
  // `hideContact` is false can only be that leftover. Drop it and fall through
  // to the number, exactly as before the feature existed.
  const isHandlePush = /^@/.test(String(pushName || '').trim());
  const cleanPush = !hideContact && isHandlePush ? null : pushName;

  // Only a REAL number may outrank the peer's own identity. A stub like "404"
  // is not a number, it is what a handle-created account has instead of one.
  if (isDisplayablePhone(phone)) {
    const formatted = formatPhoneNumber(phone);
    if (formatted) return formatted;
  }

  // No number known — handle-created accounts, half-hydrated rows. The peer's
  // PUBLIC HANDLE is their identity here and outranks the push name: a handle
  // is chosen once and unique, while `fullName` is a self-set label the peer can
  // change to anything (that is the whole reason it never outranks a number).
  if (ownHandle) return ownHandle;

  // No number, no handle. Only here may the server's profile name surface.
  const push = String(cleanPush || '').trim();
  if (push) return push;

  // Last chance before "Unknown": the push name we just discarded as a stale
  // redaction is all we have. That happens when a caller forgot to pass the
  // peer's privacy bits — the peer really does hide their details, so the
  // server sent "@handle" and no number, and dropping it left nothing. A handle
  // is a correct label; "Unknown" never is.
  if (isHandlePush) return String(pushName).trim();

  return fallback;
};

/**
 * The WhatsApp "~push name" secondary label for GROUP contexts.
 * Returns null when the peer is saved (their saved name is the whole identity)
 * or when the server name adds nothing over what is already shown.
 */
export const resolvePushNameLabel = ({
  userId = null, phone = null, pushName = null, hideContact = false,
} = {}) => {
  // A live `contact:updated` outranks the caller's row here too, so a member
  // who hides mid-session loses the "~name" line without a refetch.
  const live = getPeerIdentity(userId);
  if (live && live.hideContact !== undefined) hideContact = live.hideContact;

  const push = String(pushName || '').trim();
  if (!push) return null;
  if (getSavedName({ userId, phone })) return null;      // saved → no ~name
  // A "~account name" printed beside a hidden number re-attaches an identity the
  // peer just asked to withhold, so the secondary label is suppressed entirely.
  if (hideContact) return null;
  if (onlyDigits(push) && onlyDigits(push) === onlyDigits(phone)) return null; // it IS the number
  return `~${push}`;
};

export default {
  loadContactNames,
  invalidateContactNames,
  subscribeContactNames,
  getContactNamesVersion,
  setPeerIdentity,
  getPeerIdentity,
  isContactIndexReady,
  getSavedName,
  getSavedAvatar,
  isSavedContact,
  formatPhoneNumber,
  isDisplayablePhone,
  handleFromRedactedName,
  resolveDisplayName,
  resolvePushNameLabel,
};
