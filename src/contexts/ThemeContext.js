import React, { createContext, useContext, useState, useEffect } from 'react';
import { kv, deviceKv } from '../services/kvStorage';
import { Appearance } from 'react-native';

const ThemeContext = createContext();

// Brand color — the product logo teal (#03b0a2), used everywhere WhatsApp uses its
// accent green: FAB, send button, links, active tabs and read context.
// Single source of truth for the primary/accent color across modes. It is also the
// default `chatColor`, so outgoing message bubbles are brand-teal out of the box.
const BRAND = '#03b0a2';

// Out-of-the-box chat accent (outgoing bubbles + chat preview) on a fresh
// install, until the user picks another one in Chat theme. Separate from BRAND
// so the app's own accent (FAB, buttons, links) stays the logo teal.
export const DEFAULT_CHAT_COLOR = '#026158';

// Roboto is the app-wide font family (matches the bottom tab bar and the
// overwhelming majority of screens). Exposed so any component reading
// theme.fonts gets Roboto instead of the OS "System" font.
const fonts = {
  thin: 'Roboto-Light',
  light: 'Roboto-Light',
  regular: 'Roboto-Regular',
  medium: 'Roboto-Medium',
  semibold: 'Roboto-SemiBold',
  bold: 'Roboto-Bold',
};

// Type scale — the app previously used 14+ ad-hoc sizes; new code must pick
// from this scale (closest step) instead of a raw number.
const fontSizes = {
  caption: 11,
  small: 12,
  body: 14,
  subtitle: 15,
  title: 16,
  heading: 18,
  large: 22,
};

const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
const radii = { sm: 6, md: 10, lg: 16, pill: 999 };

// Surfaces that are dark in BOTH themes by design (media viewers, status
// viewer/editor, in-call video). Named so the decision is visible (never
// flatten these into the mode-dependent tokens).
export const alwaysDark = {
  background: '#000000',
  surface: '#1F2C34',
  text: '#ffffff',
  textMuted: 'rgba(255,255,255,0.7)',
  scrim: 'rgba(0,0,0,0.5)',
};

// ---------------------------------------------------------------------------
// Contrast helpers (WCAG 2.x). Everything painted ON the user's outgoing
// bubble (text, time, ticks, links) is derived from the bubble colour, so any
// accent swatch stays readable. Results are memoised (pure functions of hex).
// ---------------------------------------------------------------------------
const INK_DARK = '#0B141A';
const INK_LIGHT = '#FFFFFF';

const hexToRgb = (hex) => {
  if (typeof hex !== 'string') return null;
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (full.length < 6) return null;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return [r, g, b].some(Number.isNaN) ? null : [r, g, b];
};
const rgbToHex = (rgb) =>
  '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
const relLuminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrastRatio = (a, b) => {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return 1;
  const la = relLuminance(ra);
  const lb = relLuminance(rb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const blend = (fg, bg, alpha) => {
  const f = hexToRgb(fg);
  const b = hexToRgb(bg);
  return rgbToHex(f.map((v, i) => v * alpha + b[i] * (1 - alpha)));
};

// '#RRGGBB' + alpha -> 'rgba(r,g,b,a)' (washes/tints derived from an ink colour).
export const withAlpha = (hex, alpha) => {
  const rgb = hexToRgb(hex);
  return rgb ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})` : hex;
};

// Kept for existing imports; the luma heuristic is no longer used for ink.
export const isLightColor = (hex) => {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 160;
};
// Ink for text painted ON `hex`: whichever of #0B141A / #FFFFFF has the higher
// WCAG contrast (T-01: the old luma>160 test left 11/18 swatches unreadable).
export const onColorFor = (hex) =>
  (contrastRatio(hex, INK_DARK) >= contrastRatio(hex, INK_LIGHT) ? INK_DARK : INK_LIGHT);
// Secondary/meta ink (timestamps, labels) on an accent-coloured bubble: the ink
// faded toward the bubble just far enough to keep >= 4.5:1.
const _metaCache = new Map();
export const metaOnColorFor = (hex) => {
  if (_metaCache.has(hex)) return _metaCache.get(hex);
  const ink = onColorFor(hex);
  let out = ink;
  if (hexToRgb(hex)) {
    for (let a = 0.7; a <= 1.0001; a += 0.05) {
      const c = blend(ink, hex, Math.min(a, 1));
      if (contrastRatio(c, hex) >= 4.5) { out = c; break; }
    }
  }
  _metaCache.set(hex, out);
  return out;
};
const rgbDistance = (a, b) => {
  const ra = hexToRgb(a); const rb = hexToRgb(b);
  if (!ra || !rb) return 0;
  return Math.hypot(ra[0] - rb[0], ra[1] - rb[1], ra[2] - rb[2]);
};
// Like pickReadable, but the colour must ALSO look different from `apart`
// (the neutral meta/sent tick), so read-blue never collapses into the grey.
const pickDistinct = (candidates, bg, apart, min, minDist) => {
  const scored = candidates.map((c) => ({ c, r: contrastRatio(c, bg), d: rgbDistance(c, apart) }));
  const best = (list) => list.reduce((a, b) => (b.r > a.r ? b : a), list[0]);
  const good = scored.filter((x) => x.r >= min && x.d >= minDist);
  if (good.length) return good[0].c;
  const icon = scored.filter((x) => x.r >= 3 && x.d >= minDist);
  if (icon.length) return best(icon).c;
  const any = scored.filter((x) => x.r >= 3);
  return best(any.length ? any : scored).c;
};
const pickReadable = (candidates, bg, min) => {
  let best = candidates[0];
  let bestRatio = 0;
  for (const c of candidates) {
    const r = contrastRatio(c, bg);
    if (r >= min) return c;
    if (r > bestRatio) { best = c; bestRatio = r; }
  }
  return best;
};

// Outgoing bubble background: user-customised chatColor wins; the default
// accent maps to the theme's outgoing token (pale teal light / deep teal dark).
export const sentBubbleBgFor = (chatColor, theme) =>
  chatColor && chatColor !== BRAND ? chatColor : theme.colors.bubbleSent;

// Everything painted on the outgoing bubble. The default bubble uses the
// hand-tuned theme tokens; a custom accent derives every colour from the bubble
// via onColorFor so ink/meta/tick/link always clear their contrast floors.
const _outCache = new Map();
export const outgoingPaletteFor = (bg, theme) => {
  const key = `${bg}|${theme.colors.bubbleSent}`;
  if (_outCache.has(key)) return _outCache.get(key);
  const c = theme.colors;
  let out;
  if (bg === c.bubbleSent) {
    out = {
      bg, text: c.bubbleSentText, meta: c.bubbleSentMeta,
      link: c.link, tick: c.tick,
    };
  } else {
    const text = onColorFor(bg);
    const meta = metaOnColorFor(bg);
    out = {
      bg, text, meta,
      link: pickReadable(['#00695C', '#1565C0', '#5EEAD9', '#7DD3FF', INK_DARK, INK_LIGHT], bg, 4.5),
      tick: {
        pending: meta, sent: meta, delivered: meta,
        // Blue / red stay recognisable on custom accents: take the first
        // candidate that clears 4.5:1, else the best of the extended set (icons
        // only need 3:1; mid-tone accents cap out near 4.0 for any hue).
        read: pickDistinct(['#1565C0', '#62CDFF', '#0D47A1', '#BBE5FF', '#0A2A6B', '#E1F3FF'], bg, meta, 4.5, 90),
        failed: pickReadable(['#C62828', '#FFB4AB', '#7F0000', '#FFD7D2', '#4A0000'], bg, 4.5),
        mediaNeutral: c.tick.mediaNeutral, mediaRead: c.tick.mediaRead, mediaFailed: c.tick.mediaFailed,
      },
    };
  }
  _outCache.set(key, out);
  return out;
};

// Group sender-name colours, theme-aware. Generated + validated by script:
// light list >= 5.0:1 on #FFFFFF (and >= 4.5 on #D5F3F0); dark list >= 5.5:1 on
// #202C33 (and >= 4.5 on #05564F). No yellow-green / Spotify-green hues.
const SENDER_COLORS_LIGHT = ['#CC2A24', '#A9511E', '#8B6118', '#157568', '#187486', '#1F70AD', '#2656D9', '#3E26D9', '#8526D9', '#B223C7', '#C32293', '#CC245C'];
const SENDER_COLORS_DARK = ['#F5AAA8', '#F2AF88', '#ECB351', '#30E8D0', '#3ECDEA', '#88C4F2', '#A8BCF5', '#BEB6F7', '#D4ACF6', '#EAA3F5', '#F5A3DC', '#F5A8C2'];
export const senderNameColorFor = (key, isDark) => {
  const list = isDark ? SENDER_COLORS_DARK : SENDER_COLORS_LIGHT;
  const str = key == null ? '' : String(key);
  if (!str) return list[0];
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return list[Math.abs(hash) % list.length];
};

// Light theme
const lightTheme = {
  colors: {
    background: '#ffffff',
    primaryTextColor: '#0B141A',
    textColor: '#0B141A', // alias — several call sites read this name
    secondaryTextColor: '#667781',
    muted: '#667781',
    textWhite: '#ffffff',
    themeColor: BRAND,
    primary: BRAND, // alias — several call sites read this name
    onAccent: '#ffffff',
    // Was #a9a9a9 (2.35:1 on white). This token is the generic secondary/placeholder
    // ink in ~200 places, so it must clear 4.5:1 itself.
    placeHolderTextColor: '#667781',
    // Disabled controls (fill + label). Prefer these over dimming a brand fill.
    disabledSurface: '#E3E7E9',
    disabledText: '#667781',
    borderColor: '#e6e6e6',
    border: '#e6e6e6',
    divider: 'rgba(0,0,0,0.06)',
    menuBackground: '#f5f5f5',
    cardBackground: '#ffffff',
    surface: '#f5f6f6',
    headerBackground: '#ffffff',
    iconColor: '#54656f',
    danger: '#e53935',
    success: BRAND,
    warning: '#B26A00',
    info: '#0277BD',
    scrim: 'rgba(0,0,0,0.5)',
    shadow: '#000000',
    readReceipt: '#1565C0',
    // Message bubbles (sent bg is overridden by chatColor; ink/meta/ticks/links
    // then derive from it via outgoingPaletteFor).
    bubbleSent: '#D5F3F0',
    bubbleSentText: '#111B21',
    bubbleSentMeta: '#4F6A66', // 4.99:1 on bubbleSent
    bubbleReceivedText: '#111B21',
    // Delivery ticks. sent/delivered/pending = neutral grey (glyph tells single
    // vs double), read = clearly BLUE, failed = red. On bubbleSent (#D5F3F0):
    // grey 4.71, read 4.90, failed 4.79. media* sit on the dark media scrim.
    tick: {
      pending: '#5B6B75', sent: '#5B6B75', delivered: '#5B6B75',
      read: '#1565C0', failed: '#C62828',
      mediaNeutral: '#E6ECEF', mediaRead: '#62CDFF', mediaFailed: '#FFB4AB',
    },
    // Links / @mentions (6.61 on white, 5.64 on bubbleSent)
    link: '#00695C',
    // Error ink for text/icons on surfaces (danger stays the fill colour)
    dangerText: '#C62828',
    // System notice + date separator pill (5.40-6.06:1)
    systemBg: 'rgba(255,255,255,0.92)',
    systemText: '#54656F',
    systemBorder: 'rgba(0,0,0,0.06)',
    dateChipBg: '#F0F2F5',
    // Composer
    composerBg: '#FFFFFF',
    composerText: '#111B21',
    composerPlaceholder: '#667781', // 4.65 on composerBg
    replyBarBg: '#E8EDF2',
    // ONE surface for every popover / action card / sheet in the chat
    menuSurface: '#FFFFFF',
    // Ground the chat thread sits on (wallpaper doodles are drawn over it).
    // Deliberately NOT pure white: an off-white lets the white incoming
    // bubbles read as bubbles instead of dissolving into the background, and
    // the warm cast matches the doodle ink. Dark mode uses #0B141A.
    chatBackground: '#F6F3EE',
    bubbleReceived: '#ffffff',
    bubbleDeleted: '#f5f5f5',
    bubbleMeta: '#5B6B75',
    replyHighlight: '#D19D00',
    disabledOpacity: 0.4,
  },
  fonts,
  fontSizes,
  spacing,
  radii,
};

// Dark theme — same design as light, with dark-appropriate values per token
// so contrast holds (no light borders/surfaces bleeding onto a dark background).
const darkTheme = {
  colors: {
    background: '#000000',
    primaryTextColor: '#ffffff',
    textColor: '#ffffff',
    secondaryTextColor: '#8696a0',
    muted: '#8696a0',
    textWhite: '#ffffff',
    themeColor: BRAND,
    primary: BRAND,
    onAccent: '#ffffff',
    placeHolderTextColor: '#8696a0',
    disabledSurface: '#1F2C33',
    disabledText: '#8696a0',
    borderColor: '#2C2F2F',
    border: '#2C2F2F',
    divider: 'rgba(255,255,255,0.08)',
    menuBackground: '#16222C',
    cardBackground: '#16222C',
    surface: '#1F2C33',
    headerBackground: '#1F2C33',
    iconColor: '#aebac1',
    danger: '#ff6b6b',
    success: BRAND,
    warning: '#FFC107',
    info: '#53BDEB',
    scrim: 'rgba(0,0,0,0.5)',
    // Shadows are invisible on #000 — dark mode separates elevated surfaces
    // with `divider` borders instead; keep shadow transparent so light-mode
    // shadow styles don't paint mud.
    shadow: 'transparent',
    readReceipt: '#62CDFF',
    bubbleSent: '#05564F',
    bubbleSentText: '#E9EDEF', // 7.27 on bubbleSent
    bubbleSentMeta: '#B7D4D0', // 5.44
    bubbleReceivedText: '#E9EDEF', // 12.13 on bubbleReceived
    // On bubbleSent (#05564F): grey 5.2, read 4.77, failed 5.05.
    tick: {
      pending: '#C0CBD0', sent: '#C0CBD0', delivered: '#C0CBD0',
      read: '#62CDFF', failed: '#FFB4AB',
      mediaNeutral: '#E6ECEF', mediaRead: '#62CDFF', mediaFailed: '#FFB4AB',
    },
    link: '#5EEAD9', // 9.70 on bubbleReceived, 5.81 on bubbleSent
    dangerText: '#FF8A80',
    systemBg: '#1A1C1C',
    systemText: '#8696A0', // 5.30
    systemBorder: 'rgba(233,237,239,0.10)',
    dateChipBg: '#1A1C1C',
    composerBg: '#2C2F2F',
    composerText: '#E9EDEF',
    composerPlaceholder: '#9AA8B1', // 4.89 on composerBg (was #8696a0 = 3.91)
    replyBarBg: '#2C2F2F',
    menuSurface: '#202323',
    // Chat ground is plain black (neutral, no blue cast) with the doodle art over it;
    // incoming bubbles are #232626 so they separate from it.
    chatBackground: '#000000',
    bubbleReceived: '#232626',
    bubbleDeleted: '#1A1C1C',
    bubbleMeta: '#8696a0',
    replyHighlight: '#FFC107',
    disabledOpacity: 0.55,
  },
  fonts,
  fontSizes,
  spacing,
  radii,
};

// Default fallback
export const defaultTheme = lightTheme;

// The in-app Light/Dark choice must reach NATIVE chrome too (dialogs, modal
// windows, nav bar, keyboard, ripples), which otherwise follow the OS. `null`
// hands control back to the OS ("System").
const applyNativeScheme = (mode) => {
  try { Appearance.setColorScheme(mode); } catch { /* older runtimes */ }
};

export const ThemeProvider = ({ children }) => {
  // Boot values read SYNCHRONOUSLY from MMKV. They are only trusted once the
  // one-time AsyncStorage→MMKV sweep has run (so "absent" really means absent);
  // until then (first launch after the update, or no native MMKV) the async
  // read below decides, exactly as before, and the first frame still waits.
  const [boot] = useState(() => {
    const ready = deviceKv.isAvailable() && deviceKv.isMigratedSync()
      && (!kv.isAvailable() || kv.isMigratedSync());
    if (!ready) return { ready: false };
    const savedTheme = deviceKv.getStringSync('theme');
    const savedColor = kv.getStringSync('selectedColor');
    return {
      ready: true,
      manual: savedTheme === 'dark' || savedTheme === 'light',
      dark: savedTheme === 'dark',
      color: savedColor || null,
    };
  });
  const [isDarkMode, setIsDarkMode] = useState(
    boot.ready ? (boot.manual ? boot.dark : Appearance.getColorScheme() === 'dark') : false,
  );
  const [isLoading, setIsLoading] = useState(!boot.ready);
  const [chatColor, setChatColor] = useState((boot.ready && boot.color) || DEFAULT_CHAT_COLOR);
  const [hasManualTheme, setHasManualTheme] = useState(boot.ready ? boot.manual : false);

  // 1️⃣ Load saved theme and chat color on mount
  useEffect(() => {
    const initializeTheme = async () => {
      try {
        const savedTheme = await deviceKv.getItem('theme');
        const savedChatColor = await kv.getItem('selectedColor');
        
        if (savedChatColor !== null) {
          setChatColor(savedChatColor);
        }

        if (savedTheme !== null) {
          // User has manually set a theme
          applyNativeScheme(savedTheme === 'dark' ? 'dark' : 'light');
          setIsDarkMode(savedTheme === 'dark');
          setHasManualTheme(true);
        } else {
          // No saved theme, use system theme
          applyNativeScheme(null);
          const systemScheme = Appearance.getColorScheme();
          setIsDarkMode(systemScheme === 'dark');
          setHasManualTheme(false);
        }
      } catch (error) {
        console.error('Error loading theme:', error);
        // Fallback to system theme on error
        const systemScheme = Appearance.getColorScheme();
        setIsDarkMode(systemScheme === 'dark');
      } finally {
        setIsLoading(false);
      }
    };

    initializeTheme();
  }, []);

  // 2️⃣ Listen to system theme changes (only when no manual theme is set)
  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      if (!hasManualTheme) {
        setIsDarkMode(colorScheme === 'dark');
      }
    });

    return () => subscription.remove();
  }, [hasManualTheme]);

  // 3️⃣ Toggle theme manually
  const toggleTheme = async () => {
    try {
      const newTheme = !isDarkMode;
      applyNativeScheme(newTheme ? 'dark' : 'light');
      setIsDarkMode(newTheme);
      setHasManualTheme(true);
      await deviceKv.setItem('theme', newTheme ? 'dark' : 'light');
    } catch (error) {
      console.error('Error saving theme:', error);
    }
  };

  // Set theme manually (dark or light)
  const setTheme = async (isDark) => {
    try {
      applyNativeScheme(isDark ? 'dark' : 'light');
      setIsDarkMode(isDark);
      setHasManualTheme(true);
      await deviceKv.setItem('theme', isDark ? 'dark' : 'light');
    } catch (error) {
      console.error('Error saving theme:', error);
    }
  };

  // Reset to system theme
  const resetThemeToSystem = async () => {
    try {
      setHasManualTheme(false);
      applyNativeScheme(null); // hand native chrome back to the OS BEFORE reading it
      const systemScheme = Appearance.getColorScheme();
      setIsDarkMode(systemScheme === 'dark');
      await deviceKv.removeItem('theme');
    } catch (error) {
      console.error('Error resetting theme:', error);
    }
  };

  // 4️⃣ Chat color functions
  const updateChatColor = async (color) => {
    try {
      setChatColor(color);
      await kv.setItem('selectedColor', color);
    } catch (error) {
      console.error('Error saving chat color:', error);
    }
  };

  const resetChatColor = async () => {
    try {
      await kv.removeItem('selectedColor');
      setChatColor(DEFAULT_CHAT_COLOR);
    } catch (error) {
      console.error("Error resetting chat color:", error);
    }
  };

  const theme = isDarkMode ? darkTheme : lightTheme;

  const value = {
    theme: {
      ...theme,
      colors: { ...theme.colors, chatColor: chatColor || theme.colors.themeColor },
    },
    isDarkMode,
    toggleTheme,
    setTheme,
    resetThemeToSystem,
    updateChatColor,
    resetChatColor,
    chatColor,
    isLoading,
    hasManualTheme, // Expose this so you can show "System" vs "Manual" in settings
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    return {
      theme: defaultTheme,
      isDarkMode: false,
      toggleTheme: () => {},
      setTheme: () => {},
      resetThemeToSystem: () => {},
      isLoading: false,
      hasManualTheme: false,
    };
  }
  return context;
};

export default ThemeContext;