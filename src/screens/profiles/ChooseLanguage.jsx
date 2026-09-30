import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  View, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Keyboard, AppState,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '../../contexts/ThemeContext';
import { useNetwork } from '../../contexts/NetworkContext';
import {
  Text, useLanguage,
  SOURCE_LANGUAGE, getDownloadedLanguages, getSupportedLanguages,
  isTranslationAvailable, needsSystemFont,
  getLanguageDownloadStatus, subscribeLanguageDownloads, clearFailedLanguageDownloads,
} from '../../components/Translate';
import { LANGUAGES, NO_TRANSLATION, NO_TRANSLATION_OPTION } from '../../constant/languages';
import AppSearchBar from '../../components/AppSearchBar';

// Estimated-progress tuning (see progressFor below).
const PROGRESS_CEILING = 0.92;   // never claim "done" before the native side says so
const PROGRESS_TAU_S = 25;       // seconds to reach ~63%
const PROGRESS_SETTLE_MS = 350;  // how long the full bar is shown before the tick

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
 * the translator. The search box is the shared AppSearchBar.
 */
export default function ChooseLanguage({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const { language, setLanguage, ready } = useLanguage();
  // Offline, ML Kit does not fail a download — it parks it and carries on when
  // the network returns. Say so instead of letting the estimate climb.
  const { isConnected } = useNetwork();
  const [query, setQuery] = useState('');
  // Which languages already have their ~30MB on-device model.
  const [downloaded, setDownloaded] = useState([]);
  // Which row is downloading / failed is NOT kept here — it lives in
  // Translate's module-level store, so it survives this screen being left and
  // re-opened mid-download. This screen only re-renders when it changes.
  const [, bumpStatus] = useReducer((n) => n + 1, 0);
  // The row that just finished, held at 100% for a beat before the tick.
  const [settlingCode, setSettlingCode] = useState(null);
  // Clock for the estimated progress. ML Kit's downloadModelIfNeeded reports
  // completion only (no byte counts on either platform), so progress is an
  // ESTIMATE from the download's start time: it climbs quickly at first, slows
  // as it nears the ceiling, and snaps to 100% the moment the native promise
  // settles. Using the store's startedAt (not this screen's mount time) means
  // coming back to the screen continues the bar instead of restarting it.
  const [now, setNow] = useState(() => Date.now());
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

  // Follow downloads started anywhere (this screen before it was left, the
  // launch/foreground resume) and re-read the on-disk list whenever one ends.
  useEffect(() => subscribeLanguageDownloads(() => {
    if (!aliveRef.current) return;
    bumpStatus();
    refreshDownloaded();
  }), [refreshDownloaded]);

  // A download can finish while the app is in the background.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshDownloaded();
    });
    return () => sub.remove();
  }, [refreshDownloaded]);

  const nativeReady = isTranslationAvailable();

  // Which pick is the current one, so a slow earlier pick finishing cannot run
  // the 100% settle for a row the user has since moved away from.
  const pickSeqRef = useRef(0);

  const anyDownloading = LANGUAGES.some(({ code }) => getLanguageDownloadStatus(code)?.state === 'downloading');
  // Tick while anything is downloading. τ ≈ 25s: a 30MB model on an ordinary
  // connection lands around there, so most real downloads finish while the bar
  // is still visibly moving rather than parked at the ceiling.
  useEffect(() => {
    if (!anyDownloading) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [anyDownloading]);

  const progressFor = (code) => {
    if (settlingCode === code) return 1;
    const startedAt = getLanguageDownloadStatus(code)?.startedAt;
    if (!startedAt) return 0;
    const t = Math.max(0, now - startedAt) / 1000;
    return Math.min(PROGRESS_CEILING, 1 - Math.exp(-t / PROGRESS_TAU_S));
  };

  const onPick = useCallback(async (code) => {
    // A new pick replaces any old "failed" rows (a running download is kept).
    clearFailedLanguageDownloads();
    // Neither English (the app's own language) nor "Don't translate" needs a
    // model — both apply the instant they are tapped, with nothing to download
    // and nothing that can fail.
    if (code === SOURCE_LANGUAGE || code === NO_TRANSLATION) { setLanguage(code); return; }

    // A model that is already on the device needs no download — apply it at
    // once. The list state is checked first for an instant answer, then the
    // native side for the case where the listing failed or is stale.
    let onDevice = downloaded.includes(code);
    if (!onDevice) {
      try {
        const models = await getDownloadedLanguages();
        onDevice = Array.isArray(models) && models.includes(code);
        if (onDevice && aliveRef.current) setDownloaded(models);
      } catch { /* fall through to the download path */ }
    }
    if (onDevice) { setLanguage(code, { requireWifi: false }); return; }

    pickSeqRef.current += 1;
    const seq = pickSeqRef.current;
    // requireWifi false: the user tapped this row and the size is on screen.
    // The busy/failed state is published by the store, so leaving the screen
    // now loses nothing — the download carries on and is shown on return.
    const ok = await setLanguage(code, { requireWifi: false });
    if (!aliveRef.current || pickSeqRef.current !== seq) return;
    if (ok) {
      // Let the bar visibly reach 100% before the row flips to "selected" —
      // a jump from 60% straight to a tick reads as if something was skipped.
      setSettlingCode(code);
      await new Promise((r) => setTimeout(r, PROGRESS_SETTLE_MS));
      if (!aliveRef.current) return;
      setSettlingCode((current) => (current === code ? null : current));
    }
    refreshDownloaded();
  }, [setLanguage, refreshDownloaded, downloaded]);

  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const themeColor = theme.colors.themeColor;
  const divider = isDarkMode ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';

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
      <AppSearchBar
        value={query}
        onChangeText={setQuery}
        placeholder="Search language"
        autoCapitalize="none"
        returnKeyType="search"
        onSubmitEditing={Keyboard.dismiss}
        style={styles.searchBox}
      />

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
              const isOffRow = item.code === NO_TRANSLATION;
              const status = getLanguageDownloadStatus(item.code);
              const onDisk = downloaded.includes(item.code);
              const isBusy = settlingCode === item.code || status?.state === 'downloading';
              // A model that is on disk is never "failed" — it may have landed
              // after the timeout gave up on it.
              const isFailed = !isBusy && status?.state === 'failed' && !onDisk;
              const progress = isBusy ? progressFor(item.code) : 0;
              // English is the app's own language — nothing to download. Nor is
              // there anything to download for "Don't translate".
              const needsModel =
                !isOffRow
                && item.code !== SOURCE_LANGUAGE
                && !onDisk;

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
                      <View>
                        <View style={styles.rowSubLine}>
                          {isConnected || progress >= 1 ? (
                            <>
                              <Text style={[styles.rowSub, { color: themeColor }]}>Downloading language…</Text>
                              <Text ignore style={[styles.rowSub, styles.rowPct, { color: themeColor }]}>
                                {` ${Math.round(progress * 100)}%`}
                              </Text>
                            </>
                          ) : (
                            <Text style={[styles.rowSub, { color: subText }]}>
                              Waiting for internet — download resumes automatically
                            </Text>
                          )}
                        </View>
                        <View
                          style={[styles.track, { backgroundColor: divider }]}
                          accessibilityRole="progressbar"
                          accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
                        >
                          <View
                            style={[
                              styles.fill,
                              { backgroundColor: themeColor, width: `${Math.max(2, progress * 100)}%` },
                            ]}
                          />
                        </View>
                      </View>
                    ) : isFailed ? (
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
                    progress >= 1
                      ? <Ionicons name="checkmark-circle" size={22} color={themeColor} />
                      : <ActivityIndicator size="small" color={themeColor} />
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

  searchBox: { marginHorizontal: 12, marginTop: 4, marginBottom: 10 },

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
  rowPct: { fontFamily: 'Roboto-Medium', fontVariant: ['tabular-nums'] },
  track: { height: 4, borderRadius: 2, overflow: 'hidden', marginTop: 7, marginRight: 4 },
  fill: { height: '100%', borderRadius: 2 },

  empty: { alignItems: 'center', paddingTop: 60, gap: 10 },
  emptyText: { fontFamily: 'Roboto-Regular', fontSize: 14 },

  footnote: {
    fontFamily: 'Roboto-Regular', fontSize: 12,
    paddingHorizontal: 22, paddingTop: 18, lineHeight: 17,
  },
  loader: { marginTop: 32 },
});
