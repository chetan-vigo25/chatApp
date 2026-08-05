/**
 * Tiny color helper for the permission UI.
 *
 * The accent colors in the catalog are opaque brand-ish hues; the icon chips behind
 * them need the same hue at low opacity. Doing it with an 8-digit hex keeps the
 * chips flat (no nested translucent Views) and works identically on both platforms.
 */
export function withAlpha(hex, alpha) {
  if (typeof hex !== 'string') return hex;

  let normalized = hex.trim().replace('#', '');
  if (normalized.length === 3) {
    normalized = normalized
      .split('')
      .map((char) => char + char)
      .join('');
  }
  if (normalized.length !== 6) return hex;

  const clamped = Math.max(0, Math.min(1, alpha));
  const suffix = Math.round(clamped * 255)
    .toString(16)
    .padStart(2, '0');

  return `#${normalized}${suffix}`;
}
