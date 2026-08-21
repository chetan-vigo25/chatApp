import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance } from 'react-native';

const ThemeContext = createContext();

// Brand color — the product logo teal (#03b0a2), used everywhere WhatsApp uses its
// accent green: FAB, send button, links, active tabs and read context.
// Single source of truth for the primary/accent color across modes. It is also the
// default `chatColor`, so outgoing message bubbles are brand-teal out of the box.
const BRAND = '#03b0a2';

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

// Perceived-luminance check so text painted ON a user-chosen accent
// (chatColor) stays readable — light accents get dark ink, dark accents white.
export const isLightColor = (hex) => {
  if (typeof hex !== 'string') return false;
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (full.length < 6) return false;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 160;
};
export const onColorFor = (hex) => (isLightColor(hex) ? '#0B141A' : '#E9EDEF');
// Secondary/meta ink (timestamps, ticks, labels) on an accent-colored bubble.
export const metaOnColorFor = (hex) =>
  isLightColor(hex) ? 'rgba(11,20,26,0.62)' : 'rgba(255,255,255,0.65)';
// Outgoing bubble background: user-customised chatColor wins; the default
// accent maps to WhatsApp's dark outgoing green, not the bright brand teal.
export const sentBubbleBgFor = (chatColor, theme) =>
  chatColor && chatColor !== BRAND ? chatColor : theme.colors.bubbleSent;

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
    placeHolderTextColor: '#a9a9a9',
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
    readReceipt: '#53BDEB',
    // Message bubbles (WhatsApp-parity; sent bg is overridden by chatColor)
    bubbleSent: '#03574f',
    bubbleSentText: '#E9EDEF',
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
    borderColor: '#2A3942',
    border: '#2A3942',
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
    readReceipt: '#53BDEB',
    bubbleSent: '#03574f',
    bubbleSentText: '#E9EDEF',
    bubbleReceived: '#202C33',
    bubbleDeleted: '#182229',
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

export const ThemeProvider = ({ children }) => {
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [chatColor, setChatColor] = useState(BRAND);
  const [hasManualTheme, setHasManualTheme] = useState(false);

  // 1️⃣ Load saved theme and chat color on mount
  useEffect(() => {
    const initializeTheme = async () => {
      try {
        const savedTheme = await AsyncStorage.getItem('theme');
        const savedChatColor = await AsyncStorage.getItem('selectedColor');
        
        if (savedChatColor !== null) {
          setChatColor(savedChatColor);
        }

        if (savedTheme !== null) {
          // User has manually set a theme
          setIsDarkMode(savedTheme === 'dark');
          setHasManualTheme(true);
        } else {
          // No saved theme, use system theme
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
      setIsDarkMode(newTheme);
      setHasManualTheme(true);
      await AsyncStorage.setItem('theme', newTheme ? 'dark' : 'light');
    } catch (error) {
      console.error('Error saving theme:', error);
    }
  };

  // Set theme manually (dark or light)
  const setTheme = async (isDark) => {
    try {
      setIsDarkMode(isDark);
      setHasManualTheme(true);
      await AsyncStorage.setItem('theme', isDark ? 'dark' : 'light');
    } catch (error) {
      console.error('Error saving theme:', error);
    }
  };

  // Reset to system theme
  const resetThemeToSystem = async () => {
    try {
      setHasManualTheme(false);
      const systemScheme = Appearance.getColorScheme();
      setIsDarkMode(systemScheme === 'dark');
      await AsyncStorage.removeItem('theme');
    } catch (error) {
      console.error('Error resetting theme:', error);
    }
  };

  // 4️⃣ Chat color functions
  const updateChatColor = async (color) => {
    try {
      setChatColor(color);
      await AsyncStorage.setItem('selectedColor', color);
    } catch (error) {
      console.error('Error saving chat color:', error);
    }
  };

  const resetChatColor = async () => {
    try {
      await AsyncStorage.removeItem('selectedColor');
      setChatColor(lightTheme.colors.themeColor);
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