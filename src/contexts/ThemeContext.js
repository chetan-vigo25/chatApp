import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance } from 'react-native';

const ThemeContext = createContext();

// Brand color — WhatsApp's modern in-app accent green (#00A884): the same teal-green
// WhatsApp uses for its FAB, send button, links, active tabs and read context.
// Single source of truth for the primary/accent color across modes. It is also the
// default `chatColor`, so outgoing message bubbles are WhatsApp-green out of the box.
const BRAND = '#00A884';

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

// Light theme
const lightTheme = {
  colors: {
    background: '#ffffff',
    primaryTextColor: '#0B141A',
    secondaryTextColor: '#667781',
    textWhite: '#ffffff',
    themeColor: BRAND,
    placeHolderTextColor: '#a9a9a9',
    borderColor: '#e6e6e6',
    border: '#e6e6e6',
    menuBackground: '#f5f5f5',
    cardBackground: '#ffffff',
    surface: '#f5f6f6',
    headerBackground: '#ffffff',
    iconColor: '#54656f',
    danger: '#e53935',
    success: BRAND,
  },
  fonts,
};

// Dark theme — same design as light, with dark-appropriate values per token
// so contrast holds (no light borders/surfaces bleeding onto a dark background).
const darkTheme = {
  colors: {
    background: '#0B141A',
    primaryTextColor: '#ffffff',
    secondaryTextColor: '#8696a0',
    textWhite: '#ffffff',
    themeColor: BRAND,
    placeHolderTextColor: '#8696a0',
    borderColor: '#2A3942',
    border: '#2A3942',
    menuBackground: '#16222C',
    cardBackground: '#16222C',
    surface: '#1F2C33',
    headerBackground: '#1F2C33',
    iconColor: '#aebac1',
    danger: '#ff6b6b',
    success: BRAND,
  },
  fonts,
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
        console.log('System theme changed to:', colorScheme);
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
      console.log('Theme toggled to:', newTheme ? 'dark' : 'light');
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
      console.log('Theme set to:', isDark ? 'dark' : 'light');
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
      console.log('Theme reset to system:', systemScheme);
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