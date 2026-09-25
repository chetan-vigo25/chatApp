/**
 * AppSearchBar — the ONE search field used across the app.
 *
 * Pixel-for-pixel the ChatList search bar: 40px rounded pill, filled
 * background (#1F2C3380 dark / #f0f2f5 light), 17px search glyph, 14px
 * Roboto input and a small circular clear button. Every screen with a search
 * box renders this so they all read identically in both themes.
 *
 * Props: value, onChangeText, placeholder, onClear (defaults to clearing via
 * onChangeText('')), style (outer pill overrides, e.g. margins), inputRef and
 * any other TextInput props (autoFocus, onSubmitEditing, returnKeyType…).
 */
import React from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../contexts/ThemeContext';

export const SEARCH_BAR_BG_DARK = '#1F2C3380';
export const SEARCH_BAR_BG_LIGHT = '#f0f2f5';

export default function AppSearchBar({
  value,
  onChangeText,
  placeholder = 'Search',
  onClear,
  style,
  inputStyle,
  inputRef,
  showClear = true,
  ...inputProps
}) {
  const { theme, isDarkMode } = useTheme();
  const muted = theme.colors.placeHolderTextColor;
  const hasText = typeof value === 'string' && value.length > 0;

  const handleClear = () => {
    if (onClear) onClear();
    else onChangeText?.('');
  };

  return (
    <View
      style={[
        styles.bar,
        { backgroundColor: isDarkMode ? SEARCH_BAR_BG_DARK : SEARCH_BAR_BG_LIGHT },
        style,
      ]}
    >
      <Ionicons name="search" size={17} color={theme.colors.iconColor} />
      <TextInput
        ref={inputRef}
        keyboardAppearance={isDarkMode ? 'dark' : 'light'}
        placeholder={placeholder}
        // Darker/higher-contrast placeholder than the default muted grey.
        placeholderTextColor={isDarkMode ? '#9AA9B2' : '#54656F'}
        value={value}
        onChangeText={onChangeText}
        autoCorrect={false}
        style={[styles.input, { color: theme.colors.primaryTextColor }, inputStyle]}
        {...inputProps}
      />
      {showClear && hasText && (
        <TouchableOpacity onPress={handleClear} activeOpacity={0.6} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <View style={[styles.clearCircle, { backgroundColor: muted + '28' }]}>
            <Ionicons name="close" size={12} color={muted} />
          </View>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
    paddingHorizontal: 14,
    height: 40,
    gap: 10,
  },
  input: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Roboto-Regular',
    paddingVertical: 0,
    height: '100%',
    letterSpacing: 0.1,
  },
  clearCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
