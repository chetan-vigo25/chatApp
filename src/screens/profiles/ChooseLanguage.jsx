import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Keyboard,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '../../contexts/ThemeContext';
import {
  Text, TextInput, useLanguage,
  SOURCE_LANGUAGE, getDownloadedLanguages, getSupportedLanguages,
  isTranslationAvailable, needsSystemFont,
} from '../../components/Translate';
import { LANGUAGES, NO_TRANSLATION, NO_TRANSLATION_OPTION } from '../../constant/languages';

/**
 * Choose language.
 *
 * Tapping a language saves it to AsyncStorage and updates the LanguageProvider,
 * so incoming messages switch language immediately — no app restart, no
 * navigation reset.
 *
 * The picker's OWN labels (and the rest of the app's chrome) stay English: the
 * setting translates the messages you RECEIVE, not the interface. See
 * TRANSLATE_APP_UI in components/Translate.
 *
 * The language NAMES carry `ignore` — "हिन्दी" must never be fed back through
 * the translator. The search box uses the translated TextInput, which localises
 * the placeholder but never the text the user types.
 */
export default function ChooseLanguage({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const { language, setLanguage, ready } = useLanguage();
  const [query, setQuery] = useState('');
  // Which languages already have their ~30MB on-device model.
  const [downloaded, setDownloaded] = useState([]);
  // The row currently fetching a model, so only it shows a spinner.
  const [busyCode, setBusyCode] = useState(null);
  const [failedCode, setFailedCode] = useState(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const refreshDownloaded = useCallback(async () => {
    try {
      const models = await getDownloadedLanguages();
      if (aliveRef.current) setDownloaded(models || []);
    } catch {
      /* listing is a nicety; the picker still works without it */
    }
  }, []);

  useEffect(() => { refreshDownloaded(); }, [refreshDownloaded]);

  const nativeReady = isTranslationAvailable();

  // Which pick is the current one. Rows stay tappable during a download, so a
  // slow first download must not clear the spinner (or post a failure) for a
  // language the user picked afterwards.
  const pickSeqRef = useRef(0);

  const onPick = useCallback(async (code) => {
    setFailedCode(null);
    // Neither English (the app's own language) nor "Don't translate" needs a
    // model — both apply the instant they are tapped, with nothing to download
    // and nothing that can fail.
    if (code === SOURCE_LANGUAGE || code === NO_TRANSLATION) { setLanguage(code); return; }

    pickSeqRef.current += 1;
    const seq = pickSeqRef.current;
    setBusyCode(code);
    // requireWifi false: the user tapped this row and the size is on screen.
    const ok = await setLanguage(code, { requireWifi: false });
    if (!aliveRef.current || pickSeqRef.current !== seq) return;
    setBusyCode(null);
    if (!ok) setFailedCode(code);
    refreshDownloaded();
  }, [setLanguage, refreshDownloaded]);

  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const themeColor = theme.colors.themeColor;
  const divider = isDarkMode ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
  const searchBg = isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.045)';

  // Matches the English name ("Thai"), the endonym ("ไทย") and the code ("th"),
  // so the list is reachable whichever script the user is thinking in.
  // Only offer what the installed ML Kit build can actually translate — an
  // entry it does not know would be selectable and then silently do nothing.
  // When the native module is missing (Expo Go) the list is left intact so the
  // screen still renders rather than coming up empty.
  const offered = useMemo(() => {
    const supported = getSupportedLanguages();
    const base = (!supported || supported.length === 0)
      ? LANGUAGES
      : LANGUAGES.filter(({ code }) => {
        const allowed = new Set(supported);
        return code === SOURCE_LANGUAGE || allowed.has(code);
      });
    // "Don't translate" is always first and always present: it needs no model,
    // so the ML Kit support filter must never be able to hide it. It is the
    // only row that still works in Expo Go.
    return [NO_TRANSLATION_OPTION, ...base];
  }, []);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return offered;
    return offered.filter(({ english, label, code }) =>
      english.toLowerCase().includes(needle)
      || label.toLowerCase().includes(needle)
      || code.toLowerCase() === needle,
    );
  }, [query, offered]);

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
            Messages you receive are translated into the language you pick
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
              const isBusy = busyCode === item.code;
              const isOffRow = item.code === NO_TRANSLATION;
              // English is the app's own language — nothing to download. Nor is
              // there anything to download for "Don't translate".
              const needsModel =
                !isOffRow
                && item.code !== SOURCE_LANGUAGE
                && !downloaded.includes(item.code);

              return (
                <TouchableOpacity
                  key={item.code}
                  activeOpacity={0.6}
                  onPress={() => onPick(item.code)}
                  // Only the row that is downloading is locked. Disabling the
                  // WHOLE list meant one stuck download made the screen dead —
                  // the user could not even pick a different language.
                  disabled={isBusy}
                  style={[
                    styles.row,
                    { borderBottomColor: divider },
                    // A different KIND of choice, not one more language — the
                    // heavier rule stops the list reading as if "Don't
                    // translate" were another language.
                    isOffRow && { borderBottomWidth: 8, borderBottomColor: divider },
                  ]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected, busy: isBusy }}
                >
                  <Text ignore style={styles.flag}>{item.flag}</Text>
                  <View style={styles.flex}>
                    {/* `ignore`: these are already in their own language. */}
                    <Text
                      ignore
                      style={[
                        styles.rowLabel,
                        { color: primaryText },
                        // The endonym is written in its own script — the very
                        // thing the bundled font lacks. Hand those to the OS.
                        needsSystemFont(item.label) && { fontFamily: undefined },
                      ]}
                    >
                      {item.label}
                    </Text>
                    {/* The English name and the model's state share this line —
                        a 30MB download should be visible BEFORE the tap. */}
                    {isBusy ? (
                      <Text style={[styles.rowSub, { color: themeColor }]}>Downloading language…</Text>
                    ) : failedCode === item.code ? (
                      <Text style={[styles.rowSub, { color: theme.colors.danger || '#E5484D' }]}>
                        Download failed — tap to retry
                      </Text>
                    ) : needsModel ? (
                      <View style={styles.rowSubLine}>
                        <Text ignore style={[styles.rowSub, { color: subText }]}>{item.english}</Text>
                        <Text style={[styles.rowSub, { color: subText }]}> · 30 MB download</Text>
                      </View>
                    ) : (
                      <Text ignore style={[styles.rowSub, { color: subText }]}>{item.english}</Text>
                    )}
                  </View>
                  {isBusy ? (
                    <ActivityIndicator size="small" color={themeColor} />
                  ) : selected ? (
                    <Ionicons name="checkmark-circle" size={22} color={themeColor} />
                  ) : needsModel ? (
                    <Ionicons name="cloud-download-outline" size={21} color={divider} />
                  ) : (
                    <Ionicons name="ellipse-outline" size={22} color={divider} />
                  )}
                </TouchableOpacity>
              );
            })
          )}

          {results.length > 0 && (
            <Text style={[styles.footnote, { color: subText }]}>
              Translation happens on your device — your messages are never sent to a
              server. Each language downloads once, then works offline. Contact names
              are never translated.
            </Text>
          )}

          {!nativeReady && (
            <Text style={[styles.footnote, { color: theme.colors.danger || '#E5484D' }]}>
              On-device translation is unavailable in this build. Rebuild the app
              (npx expo prebuild, then run:android / run:ios) to enable it.
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
  rowSubLine: { flexDirection: 'row', alignItems: 'center' },

  empty: { alignItems: 'center', paddingTop: 60, gap: 10 },
  emptyText: { fontFamily: 'Roboto-Regular', fontSize: 14 },

  footnote: {
    fontFamily: 'Roboto-Regular', fontSize: 12,
    paddingHorizontal: 22, paddingTop: 18, lineHeight: 17,
  },
  loader: { marginTop: 32 },
});
