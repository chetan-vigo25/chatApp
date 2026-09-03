/**
 * usernameRules
 * ─────────────
 * Client-side mirror of the server's public-username rules
 * (chat-backend/src/helpers/userName.helper.js).
 *
 * This exists ONLY to give instant feedback while typing. The server revalidates
 * everything and is authoritative — a build that drifts from this file gets
 * rejected there, it does not sneak a bad handle through.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;

const RESERVED = new Set([
  'admin', 'administrator', 'support', 'official', 'official_system',
  'talkstry', 'baatcheet', 'system', 'sys',
  'me', 'you', 'null', 'undefined', 'root', 'help',
]);

/** trim + lowercase — the stored form. */
export const normalizeUsername = (raw) => String(raw ?? '').trim().toLowerCase();

/**
 * @returns {{ ok: boolean, message: string|null, value: string|null }}
 */
export const validateUsername = (raw) => {
  const value = normalizeUsername(raw);
  if (!value) return { ok: false, message: 'Username is required.', value: null };
  if (value.length < USERNAME_MIN || value.length > USERNAME_MAX) {
    return { ok: false, message: `Must be ${USERNAME_MIN}-${USERNAME_MAX} characters.`, value: null };
  }
  if (!/^[a-z0-9._]+$/.test(value)) {
    return { ok: false, message: 'Only letters, numbers, underscores and periods.', value: null };
  }
  if (value.startsWith('.') || value.endsWith('.')) {
    return { ok: false, message: 'Cannot start or end with a period.', value: null };
  }
  if (value.includes('..')) {
    return { ok: false, message: 'Cannot contain consecutive periods.', value: null };
  }
  if (/^[0-9]+$/.test(value)) {
    return { ok: false, message: 'Cannot be only numbers.', value: null };
  }
  if (RESERVED.has(value)) {
    return { ok: false, message: 'This username is not available.', value: null };
  }
  return { ok: true, message: null, value };
};
