import contactHasher from '../Redux/Services/Contact/ContactHasher';

/**
 * savedContactName
 * ────────────────
 * Helpers for matching a registered app user (sender / receiver / group member)
 * to a locally-saved device contact.
 *
 * The canonical join key is the PLAINTEXT E.164 number (matching switched from
 * hashed → plaintext). The contact-sync pipeline stores every device contact
 * under `phone_number = E.164`. Because both sides normalize with libphonenumber-js
 * to the same string, we can re-normalize a user's phone at render time and look
 * it up against the stored contact numbers.
 *
 * Matching by E.164 is more reliable than by `user_id` (not always populated on
 * the saved row) or by raw digits (which break on country-code/formatting).
 */

// Memoized: this runs once per distinct phone number during list rendering.
const _e164Memo = new Map();

/** Deterministic phone → canonical E.164, or null on failure. */
export const e164ForMatch = (phone) => {
  if (!phone) return null;
  const key = String(phone);
  if (_e164Memo.has(key)) return _e164Memo.get(key);
  let e164 = null;
  try { e164 = contactHasher.toE164(key) || null; } catch { e164 = null; }
  _e164Memo.set(key, e164);
  return e164;
};

// Back-compat alias — the match key is now the E.164 number, not a hash. Callers
// that pass the result to ContactDatabase.getContactByHash (aliased to
// getContactByPhone) or compare against a contact's `.hash` (now the E.164) keep
// working unchanged.
export const hashPhoneForMatch = e164ForMatch;

export const onlyDigits = (value) => String(value || '').replace(/\D/g, '');
