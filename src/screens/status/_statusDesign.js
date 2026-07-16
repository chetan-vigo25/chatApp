/**
 * Shared design tokens for the Status feature — keep all three screens
 * (StatusList, StatusPreview, StatusViewer) visually coherent.
 *
 * Editorial dark / warm restraint:
 *  - real on-device serif for display (no font download)
 *  - hairline rules + small-caps section labels
 *  - The brand teal stays the primary action; coral is the single accent
 *    used for the heart + unseen pulse so attention pops
 */
import { Platform } from 'react-native';

export const STATUS_ACCENT = '#FF6B5B';      // warm coral — likes, unseen dot
export const STATUS_INK    = '#0E1416';      // near-black ink for dark surfaces
export const STATUS_PAPER  = '#FAFAF7';      // off-white paper for light surfaces

export const STATUS_FONT = {
  display: Platform.select({ ios: 'Georgia', android: 'serif', default: 'serif' }),
  body:    Platform.select({ ios: 'System',  android: 'sans-serif', default: 'System' }),
  mono:    Platform.select({ ios: 'Menlo',   android: 'monospace',  default: 'monospace' }),
};

export const STATUS_TYPE = {
  display: { fontFamily: STATUS_FONT.display, fontSize: 34, lineHeight: 40, letterSpacing: -0.5 },
  title:   { fontFamily: STATUS_FONT.display, fontSize: 22, lineHeight: 28, letterSpacing: -0.3 },
  body:    { fontFamily: STATUS_FONT.body,    fontSize: 15, lineHeight: 22 },
  meta:    { fontFamily: STATUS_FONT.body,    fontSize: 12, lineHeight: 16, letterSpacing: 0.2 },
  // Small-caps look approximated with uppercase + tracking — gives editorial feel.
  caps:    { fontFamily: STATUS_FONT.body,    fontSize: 11, lineHeight: 14, letterSpacing: 1.8, textTransform: 'uppercase', fontWeight: '700' },
  italic:  { fontFamily: STATUS_FONT.display, fontStyle: 'italic' },
};

export const STATUS_SPACE = {
  hairline: 0.5,
  xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28, gutter: 24,
};

export const STATUS_RADIUS = {
  sm: 8, md: 12, lg: 18, xl: 26, pill: 999,
};

export const STATUS_SHADOW_SOFT = {
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 8 },
  shadowOpacity: 0.18,
  shadowRadius: 18,
  elevation: 6,
};
