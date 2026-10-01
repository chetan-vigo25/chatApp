/**
 * One avatar identity for a person, used by every surface that draws one
 * (chat-list row, profile popup, action sheet, image viewer, UserB profile), so
 * the same peer never shows a different colour or letter from screen to screen.
 *
 * Rule for a 1-1 peer with no profile photo: the LETTER always comes from the
 * name the peer set on their OWN profile — even when the row's label is my
 * saved name for them, their number, or their @username (user's rule,
 * 2026-09-30). Only when no profile name is known: my saved name, else the
 * label; a bare phone number then gets the neutral person icon.
 * A photo that fails to load falls back to the same rule — never a blank circle.
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

// True when a display label is a phone number ("+91 44224 41441", "044-224…"),
// i.e. there is no name to take a letter from.
export const isPhoneLikeName = (name) => {
  const str = String(name || '').trim();
  if (!str) return true;
  return /^[+\d][\d\s\-().]*$/.test(str) && (str.match(/\d/g) || []).length >= 5;
};

// The name an avatar letter is taken from (see the rule above). `profileName`
// is the peer's self-set profile name; a self-redacted "@handle" or a number
// there is not a name.
export const avatarNameSource = ({ savedName, profileName, displayName } = {}) => {
  const profile = String(profileName || '').trim();
  if (profile && !profile.startsWith('@') && !isPhoneLikeName(profile)) return profile;
  const saved = String(savedName || '').trim();
  if (saved) return saved;
  return String(displayName || '').trim();
};

// "Letter or person icon?" for a 1-1 peer without a photo — pass the
// avatarNameSource() result.
export const shouldShowAvatarInitial = (sourceName) => !isPhoneLikeName(sourceName);
