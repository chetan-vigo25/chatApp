/**
 * One avatar identity for a person, used by every surface that draws one
 * (chat-list row, profile popup, action sheet, image viewer, UserB profile), so
 * the same peer never shows a different colour or letter from screen to screen.
 *
 * Rule for a 1-1 peer with no profile photo:
 *   • saved in my address book → first letter of the displayed name on a colour
 *   • not saved                → neutral person icon (their number is the label,
 *                                and "+" or a digit makes a meaningless letter)
 *
 * The colour is keyed by the peer's USER ID, not the name — the name flips
 * between number / saved name / @handle as contacts sync, and the colour must
 * not flip with it.
 */

const AVATAR_COLORS = ['#6C5CE7', '#00B894', '#E17055', '#0984E3', '#E84393', '#00CEC9', '#D63031', '#A29BFE'];

// Background behind the person icon when an unsaved peer has no photo.
export const UNSAVED_AVATAR_BG = '#8696A0';

export const getAvatarColor = (key) => {
  const str = key == null ? '' : String(key);
  if (!str) return AVATAR_COLORS[0];
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

// First real character of a name — skips the "@" of a handle, a leading "+",
// brackets and spaces. Array.from keeps a non-Latin first letter (or emoji) whole.
export const getAvatarInitial = (name) => {
  const chars = Array.from(String(name || '').trim());
  const first = chars.find((ch) => !/[\s+@#~_\-.()[\]'"]/.test(ch));
  return first ? first.toUpperCase() : '?';
};
