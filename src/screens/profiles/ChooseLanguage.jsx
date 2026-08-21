import React, { useMemo, useState } from 'react';
import {
  View, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Keyboard,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '../../contexts/ThemeContext';
import { Text, TextInput, useLanguage } from '../../components/Translate';
import { LANGUAGES } from '../../constant/languages';

/**
 * Choose language.
 *
 * Tapping a language saves it to AsyncStorage and updates the LanguageProvider,
 * so every screen using the translated <Text> re-renders immediately — no app
 * restart, no navigation reset. The screen stays open on purpose: its own
 * labels translate in front of you, which is the quickest way to confirm the
 * feature is live.
 *
 * The language NAMES carry `ignore` — "हिन्दी" must never be fed back through
 * the translator. The search box uses the translated TextInput, which localises
 * the placeholder but never the text the user types.
 */
export default function ChooseLanguage({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const { language, setLanguage, ready } = useLanguage();
  const [query, setQuery] = useState('');

  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const themeColor = theme.colors.themeColor;
  const divider = isDarkMode ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
  const searchBg = isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.045)';

  // Matches the English name ("Thai"), the endonym ("ไทย") and the code ("th"),
  // so the list is reachable whichever script the user is thinking in.
  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return LANGUAGES;
    return LANGUAGES.filter(({ english, label, code }) =>
      english.toLowerCase().includes(needle)
      || label.toLowerCase().includes(needle)
      || code.toLowerCase() === needle,
    );
  }, [query]);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={styles.appBar}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.appBarBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="arrow-back" size={24} color={primaryText} />
        </TouchableOpacity>
        <View style={styles.flex}>
          <Text style={[styles.appBarTitle, { color: primaryText }]}>Choose your language</Text>
          <Text style={[styles.appBarSub, { color: subText }]}>
            The app translates itself into the language you pick
          </Text>
        </View>
      </View>

      {/* Search */}
      <View style={[styles.searchBox, { backgroundColor: searchBg }]}>
        <Ionicons name="search" size={18} color={subText} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search language"
          placeholderTextColor={subText}
          style={[styles.searchInput, { color: primaryText }]}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          onSubmitEditing={Keyboard.dismiss}
        />
        {query.length > 0 && (
          <TouchableOpacity onPress={() => setQuery('')} hitSlop={8} accessibilityRole="button">
            <Ionicons name="close-circle" size={18} color={subText} />
          </TouchableOpacity>
        )}
      </View>

      {!ready ? (
        <ActivityIndicator style={styles.loader} color={themeColor} />
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {results.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="search-outline" size={34} color={divider} />
              <Text style={[styles.emptyText, { color: subText }]}>No language found</Text>
            </View>
          ) : (
            results.map((item) => {
              const selected = item.code === language;
              return (
                <TouchableOpacity
                  key={item.code}
                  activeOpacity={0.6}
                  onPress={() => setLanguage(item.code)}
                  style={[styles.row, { borderBottomColor: divider }]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                >
                  <Text ignore style={styles.flag}>{item.flag}</Text>
                  <View style={styles.flex}>
                    {/* `ignore`: these are already in their own language. */}
                    <Text ignore style={[styles.rowLabel, { color: primaryText }]}>{item.label}</Text>
                    <Text style={[styles.rowSub, { color: subText }]}>{item.english}</Text>
                  </View>
                  {selected ? (
                    <Ionicons name="checkmark-circle" size={22} color={themeColor} />
                  ) : (
                    <Ionicons name="ellipse-outline" size={22} color={divider} />
                  )}
                </TouchableOpacity>
              );
            })
          )}

          {results.length > 0 && (
            <Text style={[styles.footnote, { color: subText }]}>
              Your chats and contact names are never translated.
            </Text>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },

  appBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 8, paddingVertical: 8, gap: 8,
  },
  appBarBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  appBarTitle: { fontFamily: 'Roboto-Medium', fontSize: 20 },
  appBarSub: { fontFamily: 'Roboto-Regular', fontSize: 12, marginTop: 1 },

  searchBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 16, marginTop: 4, marginBottom: 10,
    paddingHorizontal: 12, height: 44, borderRadius: 22,
  },
  searchInput: {
    flex: 1, padding: 0,
    fontFamily: 'Roboto-Regular', fontSize: 15,
  },

  scroll: { paddingBottom: 40 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 15, paddingHorizontal: 22, gap: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  flag: { fontSize: 26 },
  rowLabel: { fontFamily: 'Roboto-Medium', fontSize: 16 },
  rowSub: { fontFamily: 'Roboto-Regular', fontSize: 12.5, marginTop: 2 },

  empty: { alignItems: 'center', paddingTop: 60, gap: 10 },
  emptyText: { fontFamily: 'Roboto-Regular', fontSize: 14 },

  footnote: {
    fontFamily: 'Roboto-Regular', fontSize: 12,
    paddingHorizontal: 22, paddingTop: 18, lineHeight: 17,
  },
  loader: { marginTop: 32 },
});
