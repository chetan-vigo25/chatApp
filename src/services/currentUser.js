import AsyncStorage from '@react-native-async-storage/async-storage';
import { subscribeSessionReset, subscribeUserChanged } from './sessionEvents';

/**
 * THE authenticated user's identity, readable SYNCHRONOUSLY from anywhere.
 *
 * Why this exists: every "is this message mine?" decision needs the logged-in
 * user id, and the id used to live only behind an `await AsyncStorage.getItem`
 * or inside a provider's state. Both resolve AFTER the first messages are
 * already painted (the chat screen seeds bubbles from ChatCache synchronously,
 * and the global socket ingest writes rows the moment they land). Callers that
 * asked "is senderId === me?" during that window got `false` for EVERY message,
 * because `me` was still null — which is how an entire thread ends up rendered
 * on the received side.
 *
 * The store is module-level, so it is warm for the whole session after a single
 * read, and it is cleared on logout / account switch so the next session can
 * never inherit the previous user's id.
 */

let _userId = null;
let _user = null;
let _primePromise = null;
const listeners = new Set();

/**
 * Ids reach us as raw strings, Mongo ObjectId wrappers (`{ $oid }`), and whole
 * populated user documents, depending on which transport delivered them. Every
 * comparison in the app must go through this so the same user never looks like
 * two different people.
 */
export const normalizeUserId = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    const candidate = value._id || value.id || value.userId || value.$oid || null;
    return candidate == null ? null : normalizeUserId(candidate);
  }
  return null;
};

const notify = () => {
  listeners.forEach((cb) => {
    try { cb(_userId, _user); } catch (err) { console.warn('[currentUser] listener error', err); }
  });
};

/** Synchronous read. Returns null only before the first prime/set of a session. */
export const getCurrentUserId = () => _userId;

/** The cached `userInfo` document, when one has been loaded. */
export const getCurrentUser = () => _user;

export const setCurrentUserId = (value) => {
  const next = normalizeUserId(value);
  if (next === _userId) return _userId;
  _userId = next;
  notify();
  return _userId;
};

export const setCurrentUser = (user) => {
  if (user && typeof user === 'object') _user = user;
  return setCurrentUserId(user);
};

/**
 * Load the id from storage. Safe to call from many places concurrently — the
 * in-flight promise is shared, so the disk is read once. Resolves to the id.
 */
export const primeCurrentUser = async () => {
  if (_userId) return _userId;
  if (_primePromise) return _primePromise;
  _primePromise = (async () => {
    try {
      // `userInfo` is what AuthContext.login writes; `userData` is the older
      // key it still mirrors to, and is the fallback for sessions that were
      // established before the rename.
      const raw = (await AsyncStorage.getItem('userInfo'))
        || (await AsyncStorage.getItem('userData'));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return setCurrentUser(parsed);
    } catch {
      return null;
    } finally {
      _primePromise = null;
    }
  })();
  return _primePromise;
};

/**
 * Fires whenever the id becomes known or changes. Returns an unsubscribe.
 * Callers that cache a viewer-relative value (a rendered bubble side, a
 * derived senderType) must re-derive it here — that is what makes alignment
 * independent of whether the id or the message arrived first.
 */
export const subscribeCurrentUser = (callback) => {
  if (typeof callback !== 'function') return () => {};
  listeners.add(callback);
  return () => { listeners.delete(callback); };
};

const clear = () => {
  _user = null;
  _primePromise = null;
  setCurrentUserId(null);
};

subscribeSessionReset(clear);
subscribeUserChanged((payload) => {
  _user = null;
  _primePromise = null;
  setCurrentUserId(payload?.userId || null);
});

export default {
  normalizeUserId,
  getCurrentUserId,
  getCurrentUser,
  setCurrentUserId,
  setCurrentUser,
  primeCurrentUser,
  subscribeCurrentUser,
};
