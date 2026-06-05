import contactHasher from '../Redux/Services/Contact/ContactHasher';

/**
 * savedContactName
 * ────────────────
 * Helpers for matching a registered app user (sender / receiver / group member)
 * to a locally-saved device contact.
 *
 * The canonical join key is the phone-number HASH. The contact-sync pipeline
 * (`useContactSync` → `ContactHasher.hashContactList`) stores every device
 * contact under `hash = SHA256(normalizedPhone + SALT_SECRET)`. Because the
 * salt is global and the normalization is identical, we can re-hash a user's
 * phone number at render time and look it up against the stored contact hashes.
 *
 * Matching by hash is more reliable than matching by `user_id` (which the
 * backend doesn't always populate on the saved contact row) or by raw phone
 * digits (which break on country-code / formatting differences, e.g. a member
 * number stored as "98765 43210" vs the synced "+919876543210").
 */

// Memoized: this runs once per distinct phone number during list rendering.
const _hashMemo = new Map();

/** Deterministic phone → contact hash (lowercase hex), or null on failure. */
export const hashPhoneForMatch = (phone) => {
  if (!phone) return null;
  const key = String(phone);
  if (_hashMemo.has(key)) return _hashMemo.get(key);
  let h = null;
  try { h = contactHasher.hashPhoneNumber(key)?.hash || null; } catch { h = null; }
  if (h) h = h.toLowerCase();
  _hashMemo.set(key, h);
  return h;
};

export const onlyDigits = (value) => String(value || '').replace(/\D/g, '');
