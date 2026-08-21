# App Language / Translation — Complete Implementation Guide

Ye file **self-contained** hai. Isme jo code hai use as-it-is copy karke kisi bhi
dusre React Native / Expo project me same feature bana sakte ho — koi aur file
dekhne ki zaroorat nahi.

Feature: app ka **static UI text** runtime pe Google Translate se translate hota
hai. Koi i18n JSON file nahi banani padti — ek screen sirf **ek import line**
badal ke opt-in karti hai.

Entry point (is project me): **Settings → App language**.

---

## 1. Kaise kaam karta hai

```
User language choose karta hai
          │
          ▼
AsyncStorage "app.language" = "th"   +   LanguageProvider ka state update
          │
          ▼
Jitne bhi screens custom <Text> use karte hain, sab turant re-render
          │
          ▼
Har string pehle CACHE me dhoondhi jaati hai
    ├── mil gayi  → 0 network call, turant render
    └── nahi mili → ek baar Google se fetch → cache → render
```

**Sabse bada fayda:** screens ka JSX bilkul nahi badalta. Sirf import line badalti hai:

```js
// pehle
import { Text } from 'react-native';
// baad me
import { Text } from '../../components/Translate';
```

**Language change pe app restart nahi chahiye** — context update hote hi pura app
re-render ho jata hai.

---

## 2. Install

```bash
npm install translate
npx expo install @react-native-async-storage/async-storage   # agar pehle se nahi hai
```

Bare React Native (non-Expo) me AsyncStorage ke baad iOS pe:

```bash
cd ios && pod install && cd ..
```

`translate` **native module nahi hai** — sirf JS + fetch. Isliye:
* koi prebuild / native rebuild nahi chahiye
* Expo Go me bhi chalega
* Metro reload (`r`) se hi feature live ho jata hai

Is project me installed version: **`translate@3.1.0`**.

---

## 3. ⚠️ Package ke baare me 2 zaroori baatein (verify ki hui)

### (a) Google API key ki ZAROORAT NAHI hai

`translate` package ka `google` engine ye endpoint call karta hai:

```
https://translate.googleapis.com/translate_a/single?client=gtx
```

Ye Google ka **free, undocumented** endpoint hai.

* **Koi API key nahi, koi Cloud project nahi, koi billing nahi.**
* `translate.key = "..."` set karne se `google` engine pe **kuch nahi hota** —
  key sirf `yandex`, `deepl`, `libre` engines padhte hain.
* Agar kisi guide me likha ho "Cloud Translation API enable karo + billing lagao"
  — **is package ke liye wo step apply nahi hota**.

**Trade-off (production ke liye important):** endpoint unofficial hai aur IP ke
hisaab se rate-limited hai. Kabhi bhi error dena shuru kar sakta hai. Har failure
pe code English text hi dikhata hai (UI kabhi nahi tootta), lekin production app
ke liye behtar hai ki:
* apne backend se official Cloud Translation API proxy karo, **ya**
* engine badal do (niche wala `.env` section).

### (b) `translate@1.4.1` mat use karna (RN me tootega)

`1.4.1` `node-fetch` pe depend karta hai, jo Metro bundle me Node ke core modules
(`http`, `https`, `zlib`, `stream`) kheench leta hai → bundling error.

**`translate@3.x` use karo** — zero dependencies, React Native ka global `fetch`
use karta hai, aur API same hai: `translate(text, 'hi')`.

### Engine badalna ho to (optional)

`.env` me:

```
TRANSLATE_ENGINE=libre
TRANSLATE_KEY=your_key_here      # deepl / yandex ko chahiye; libre ko aksar nahi
```

Code me kuch change nahi karna — `Translate.js` khud padh leta hai.

---

## 4. FILE 1 — `src/components/Translate.js`

Ye feature ka **dil** hai. Poori file as-it-is copy karo.

```js
/**
 * Google-Translate powered <Text> / <TextInput>.
 *
 * A screen opts in by changing ONE import line:
 *
 *   import { Text, TextInput } from 'react-native';
 *   →
 *   import { Text, TextInput } from '../../components/Translate';
 *
 * The JSX stays exactly the same. Every string child is translated into the
 * language saved in AsyncStorage, cached on disk, and re-rendered in place.
 *
 * ── What actually talks to Google ────────────────────────────────────────────
 * The `translate` package's "google" engine calls
 * https://translate.googleapis.com/translate_a/single?client=gtx — the FREE,
 * undocumented endpoint. It needs no API key and no billing (setting
 * `translate.key` is a no-op for this engine; only yandex/deepl/libre use it).
 * The trade-off is that it is rate-limited per IP and unofficial, so it can
 * start returning errors at any time. Every failure falls back to the original
 * English text, so the UI never breaks — but see the notes in
 * docs/APP_LANGUAGE_GUIDE.md before shipping this to production.
 *
 * Switch engine without touching code by adding to .env:
 *   TRANSLATE_ENGINE=libre        (or deepl / yandex)
 *   TRANSLATE_KEY=xxxxxxxx        (required by deepl / yandex)
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Text as RNText, TextInput as RNTextInput } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import translate from 'translate';
import { TRANSLATE_ENGINE, TRANSLATE_KEY } from '@env';

export const LANGUAGE_STORAGE_KEY = 'app.language';
const CACHE_KEY = 'translation.cache.v1';
/** Source language of every hard-coded string in this app. */
export const SOURCE_LANGUAGE = 'en';
/** Disk cache ceiling — keeps AsyncStorage from growing without bound. */
const MAX_CACHE_ENTRIES = 3000;
/** The free endpoint 429s if hammered; keep a few requests in flight, not 50. */
const MAX_CONCURRENT = 4;

translate.engine = TRANSLATE_ENGINE || 'google';
translate.from = SOURCE_LANGUAGE;
if (TRANSLATE_KEY) translate.key = TRANSLATE_KEY;

/* ────────────────────────────── cache ────────────────────────────── */

let memoryCache = {};           // { "hi::Submit": "जमा करें" }
let cacheLoaded = false;
let loadPromise = null;
let saveTimer = null;

function loadCache() {
  if (cacheLoaded) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = AsyncStorage.getItem(CACHE_KEY)
      .then((raw) => {
        const parsed = raw ? JSON.parse(raw) : {};
        memoryCache = parsed && typeof parsed === 'object' ? parsed : {};
      })
      .catch(() => { memoryCache = {}; })
      .finally(() => { cacheLoaded = true; });
  }
  return loadPromise;
}

function persistCache() {
  // Debounced: a screen mounting 30 labels writes to disk once, not 30 times.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const keys = Object.keys(memoryCache);
    if (keys.length > MAX_CACHE_ENTRIES) {
      // Object key order is insertion order — drop the oldest overflow.
      keys.slice(0, keys.length - MAX_CACHE_ENTRIES).forEach((k) => delete memoryCache[k]);
    }
    AsyncStorage.setItem(CACHE_KEY, JSON.stringify(memoryCache)).catch(() => {});
  }, 800);
}

/** Wipe every cached translation (Settings → clear, or after a bad run). */
export async function clearTranslationCache() {
  memoryCache = {};
  clearTimeout(saveTimer);
  try { await AsyncStorage.removeItem(CACHE_KEY); } catch {}
}

/* ─────────────────────── request queue + dedupe ─────────────────────── */

const inflight = new Map();     // cacheKey → Promise<string>
let active = 0;
const waiting = [];

function pump() {
  while (active < MAX_CONCURRENT && waiting.length) {
    const job = waiting.shift();
    active += 1;
    job().finally(() => {
      active -= 1;
      pump();
    });
  }
}

function enqueue(job) {
  return new Promise((resolve) => {
    waiting.push(() => job().then(resolve, resolve));
    pump();
  });
}

/* ─────────────────────────── translate entry ─────────────────────────── */

/**
 * Translate one string. Always resolves — on any failure it resolves with the
 * original text, so no caller ever needs a try/catch.
 */
export async function t(text, language) {
  if (typeof text !== 'string' || !text.trim()) return text;
  if (!language || language === SOURCE_LANGUAGE) return text;   // no call for English

  await loadCache();
  const key = `${language}::${text}`;
  if (memoryCache[key] != null) return memoryCache[key];         // cache hit — 0 requests

  const pending = inflight.get(key);
  if (pending) return pending;                                   // same string twice on one screen

  const request = enqueue(() =>
    translate(text, language)
      .then((result) => {
        const value = typeof result === 'string' && result.trim() ? result : text;
        memoryCache[key] = value;
        persistCache();
        return value;
      })
      .catch((error) => {
        if (__DEV__) console.warn('[translate] failed:', error?.message || error);
        return text;                                             // English fallback
      }),
  ).finally(() => inflight.delete(key));

  inflight.set(key, request);
  return request;
}

/* ───────────────────────── language context ───────────────────────── */

const LanguageContext = createContext({
  language: SOURCE_LANGUAGE,
  setLanguage: async () => {},
  ready: false,
});

export function LanguageProvider({ children }) {
  const [language, setLang] = useState(SOURCE_LANGUAGE);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY);
        if (alive && saved) setLang(saved);
        await loadCache();
      } catch {
        /* keep English */
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => { alive = false; };
  }, []);

  const setLanguage = useCallback(async (code) => {
    if (!code) return;
    setLang(code);                       // every <Text> re-renders — no app restart
    try {
      await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, code);
    } catch (error) {
      if (__DEV__) console.warn('[translate] could not save language', error);
    }
  }, []);

  const value = useMemo(() => ({ language, setLanguage, ready }), [language, setLanguage, ready]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export const useLanguage = () => useContext(LanguageContext);

/** Translate a string inside any component: `const label = useT('Submit');` */
export function useT(text) {
  const { language } = useLanguage();
  const [value, setValue] = useState(text);

  useEffect(() => {
    let alive = true;
    if (typeof text !== 'string' || language === SOURCE_LANGUAGE) {
      setValue(text);
      return undefined;
    }
    t(text, language).then((result) => { if (alive) setValue(result); });
    return () => { alive = false; };
  }, [text, language]);

  return value;
}

/* ─────────────────────── translated components ─────────────────────── */

/**
 * Drop-in <Text>. Pass `ignore` for anything that must NOT be translated:
 * user names, messages, phone numbers, amounts, IDs, brand names.
 *
 * Only a plain string child is translated. `<Text>Hi {name}</Text>` compiles to
 * an ARRAY of children, and translating that would send the user's name to
 * Google — so arrays are rendered untouched. Split them instead:
 *   <Text>Hello</Text><Text ignore> {name}</Text>
 */
function TText({ ignore, children, ...rest }) {
  const { language } = useLanguage();
  const source = typeof children === 'string' ? children : null;
  const [text, setText] = useState(children);

  useEffect(() => {
    let alive = true;
    if (ignore || source === null || language === SOURCE_LANGUAGE) {
      setText(children);
      return undefined;
    }
    // Render the English immediately, swap in the translation when it lands.
    setText(children);
    t(source, language).then((result) => { if (alive) setText(result); });
    return () => { alive = false; };
  }, [source, children, language, ignore]);

  return <RNText {...rest}>{text}</RNText>;
}

/** Drop-in <TextInput>. Translates `placeholder` only — never the typed value. */
function TTextInput({ placeholder, ...rest }) {
  const { language } = useLanguage();
  const [hint, setHint] = useState(placeholder);

  useEffect(() => {
    let alive = true;
    if (typeof placeholder !== 'string' || language === SOURCE_LANGUAGE) {
      setHint(placeholder);
      return undefined;
    }
    setHint(placeholder);
    t(placeholder, language).then((result) => { if (alive) setHint(result); });
    return () => { alive = false; };
  }, [placeholder, language]);

  return <RNTextInput {...rest} placeholder={hint} />;
}

export { TText as Text, TTextInput as TextInput };
```

### Isme kya-kya hai

| Export | Kaam |
|---|---|
| `Text` | RN `<Text>` ka drop-in replacement. String child ko translate karta hai. |
| `TextInput` | Sirf `placeholder` translate karta hai — user ka typed text kabhi nahi. |
| `LanguageProvider` | Selected language + disk cache app-wide provide karta hai. |
| `useLanguage()` | `{ language, setLanguage, ready }` deta hai. |
| `useT(text)` | Kisi bhi component me ek string translate karne wala hook. |
| `t(text, lang)` | Imperative version — `Alert.alert()` jaisi jagah ke liye. |
| `clearTranslationCache()` | Poora cache saaf karne ke liye. |
| `ignore` prop | Us `<Text>` ko translate **nahi** karega. |

---

## 5. FILE 2 — `src/constant/languages.js`

```js
/**
 * Languages offered by the "Choose language" screen.
 *
 * `code` must be a valid ISO 639-1 tag — the `translate` package validates it
 * and throws for anything else. Adding a language is a one-line change here;
 * nothing else in the app needs to know about it.
 */
export const LANGUAGES = [
  { code: 'en', label: 'English',    english: 'English',    flag: '🇬🇧' },
  { code: 'hi', label: 'हिन्दी',      english: 'Hindi',      flag: '🇮🇳' },
  { code: 'bn', label: 'বাংলা',       english: 'Bengali',    flag: '🇮🇳' },
  { code: 'mr', label: 'मराठी',       english: 'Marathi',    flag: '🇮🇳' },
  { code: 'gu', label: 'ગુજરાતી',     english: 'Gujarati',   flag: '🇮🇳' },
  { code: 'pa', label: 'ਪੰਜਾਬੀ',      english: 'Punjabi',    flag: '🇮🇳' },
  { code: 'ta', label: 'தமிழ்',       english: 'Tamil',      flag: '🇮🇳' },
  { code: 'te', label: 'తెలుగు',      english: 'Telugu',     flag: '🇮🇳' },
  { code: 'kn', label: 'ಕನ್ನಡ',       english: 'Kannada',    flag: '🇮🇳' },
  { code: 'ml', label: 'മലയാളം',     english: 'Malayalam',  flag: '🇮🇳' },
  { code: 'ur', label: 'اردو',        english: 'Urdu',       flag: '🇵🇰' },
  { code: 'ar', label: 'العربية',      english: 'Arabic',     flag: '🇸🇦' },
  { code: 'fr', label: 'Français',    english: 'French',     flag: '🇫🇷' },
  { code: 'es', label: 'Español',     english: 'Spanish',    flag: '🇪🇸' },
  { code: 'de', label: 'Deutsch',     english: 'German',     flag: '🇩🇪' },
  { code: 'pt', label: 'Português',   english: 'Portuguese', flag: '🇵🇹' },
  { code: 'ru', label: 'Русский',     english: 'Russian',    flag: '🇷🇺' },
  { code: 'zh', label: '中文',         english: 'Chinese',    flag: '🇨🇳' },
  { code: 'ja', label: '日本語',       english: 'Japanese',   flag: '🇯🇵' },
  { code: 'th', label: 'ไทย',         english: 'Thai',       flag: '🇹🇭' },
];

export const getLanguage = (code) =>
  LANGUAGES.find((language) => language.code === code) || LANGUAGES[0];
```

> `code` **ISO 639-1** hona chahiye — `translate` package validate karta hai aur
> galat code pe error throw karta hai. Nayi language add karni ho to bas is array
> me ek line add karo; aur kahin kuch nahi badalna.

---

## 6. FILE 3 — `src/screens/profiles/ChooseLanguage.jsx`

Search box + language list wali screen.

```jsx
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
```

**Screen ki khaas baatein:**
* **Search** — English name (`thai`), native name (`ไทย`) aur code (`th`) — teeno se dhoondh sakte ho.
* Language ke naam pe `ignore` — "हिन्दी" ko dobara translate karna galat hoga.
* `keyboardShouldPersistTaps="handled"` — keyboard khula ho tab bhi pehle tap pe selection ho jaye.
* Select karne pe screen band nahi hoti — apni aankhon ke saamne labels translate
  hote dikhte hain, isliye turant pata chal jata hai ki feature live hai.

---

## 7. WIRING — 3 jagah change

### 7.1 `App.js` — provider lagao

```jsx
import { LanguageProvider } from './src/components/Translate';

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        {/* Language provider — navigation ke bahar aur upar */}
        <LanguageProvider>
          <NavigationContainer>
            {/* ...tumhara pura navigation... */}
          </NavigationContainer>
        </LanguageProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
```

### 7.2 Navigator — route register karo

```jsx
import ChooseLanguage from "../screens/profiles/ChooseLanguage";

// Stack ke andar
<Stack.Screen name="ChooseLanguage" component={ChooseLanguage} />
```

### 7.3 Settings screen — entry point

Import:

```jsx
// Text ko react-native se HATAO, custom wala import karo
import { View, Image, TouchableOpacity, ScrollView } from "react-native";
import { Text, useLanguage } from "../../components/Translate";
import { getLanguage } from "../../constant/languages";
```

Component ke andar:

```jsx
const { language } = useLanguage();
const currentLanguage = getLanguage(language);
```

Menu item (jahan tumhare baaki rows hain):

```jsx
{
  icon: 'language-outline',
  label: 'App language',
  // Ye already apni script me hai — isliye ignore
  subtitle: `${currentLanguage.flag}  ${currentLanguage.label}`,
  ignoreSubtitle: true,
  onPress: () => navigation.navigate('ChooseLanguage'),
},
```

Row render karte waqt subtitle pe `ignore` pass karo:

```jsx
<Text ignore={item.ignoreSubtitle} numberOfLines={1} style={styles.menuSubtitle}>
  {item.subtitle}
</Text>
```

Agar `menuSections` `useMemo` me bana hai to dependency array me `currentLanguage`
add karna mat bhoolna — warna language badalne pe subtitle purana hi dikhega:

```jsx
]), [isDarkMode, currentLanguage]);
```

Aur profile card jaisi jagah jahan **user ka apna data** hai, wahan `ignore`:

```jsx
<Text ignore style={styles.profileName}>{profileData?.fullName || 'User'}</Text>
<Text ignore style={styles.profileSub}>{profileData?.about || profileData?.email}</Text>
```

---

## 8. Kisi bhi screen ko translate karna

**Step 1 — import badlo:**

```js
// PEHLE
import { View, Text, TextInput } from 'react-native';

// BAAD ME
import { View } from 'react-native';
import { Text, TextInput } from '../../components/Translate';
```

**Step 2 — jo translate nahi hona chahiye uspe `ignore` lagao:**

```jsx
<Text>Your balance</Text>            {/* static label → translate hoga   */}
<Text ignore>{profile.name}</Text>   {/* user data    → waisa hi rahega  */}
<Text ignore>₹ {amount}</Text>       {/* numbers      → waisa hi rahega  */}
```

### `ignore` kab lagana hai

| Content | `ignore`? |
|---|---|
| Static English label ("Submit", "Settings", "Chat privacy") | ❌ nahi |
| API se aaya data — naam, bio, room name, **messages** | ✅ **haan** |
| Numbers, currency, date, OTP, ID, phone number | ✅ **haan** |
| Text jo pehle se dusri language me hai ("हिन्दी") | ✅ **haan** |
| Brand / app ka naam | ✅ **haan** |

### Interpolation wali strings

`<Text>Hello {name}</Text>` ka children ek **array** banta hai, string nahi.
Wrapper array ko **jaan-bujh kar chhod deta hai** (warna user ka naam Google ko
chala jata). Aise cases todo:

```jsx
<Text>Hello</Text><Text ignore> {name}</Text>
```

### Alert / non-component strings

`Alert.alert()` strings leta hai, components nahi — isliye wrapper wahan kaam
nahi karta. Imperative helper use karo:

```js
import { t, useLanguage } from '../../components/Translate';

const { language } = useLanguage();
const [title, body] = await Promise.all([
  t('Log out', language),
  t('Are you sure you want to log out?', language),
]);
Alert.alert(title, body, [ /* buttons */ ]);
```

---

## 9. 🚨 Chat app ke liye SABSE ZAROORI warning

**Chat screens ko kabhi opt-in mat karna** — `ChatScreen`, `ChatList`, message
bubbles, notification text, contact names.

Wo screens users ki **private baatcheet** render karti hain. Wahan import badla to
har message Google ke server pe chala jayega. Chat text hamesha `react-native`
wale `Text` me hi rakho.

Ye feature sirf **app ke apne static labels** ke liye hai.

---

## 10. Cache, cost aur limits

* **Do layer cache**: memory + `AsyncStorage` (`translation.cache.v1`), key =
  `"<lang>::<English text>"`. Ek string **poore app-life me ek hi baar** fetch hoti hai.
* **English = 0 network call** — `t()` turant return kar deta hai.
* Ek hi screen pe same string 20 baar? → **ek hi request** (in-flight dedupe).
* Ek time pe max **4 requests** — free endpoint ko hammer nahi karta (429 se bachne ke liye).
* Disk cache **3000 entries** pe capped; purani entries drop ho jaati hain.
* Offline / rate-limited → English fallback, aur wo result cache **nahi** hota
  (agli baar dobara try karega).

---

## 11. Known limitations

| Limitation | Detail |
|---|---|
| Machine translation quality | Chhote UI labels bina context ke kabhi-kabhi galat translate hote hain ("Home" → ghar). Ship karne se pehle har language me important screens check karo. |
| Pehla paint English | String pehli baar English dikhti hai, phir translation aata hai. Cached string same frame me aa jati hai — flicker sirf ek baar per string per language. |
| RTL layout | Arabic / Urdu ka text translate hota hai par layout mirror nahi hota. Uske liye `I18nManager.forceRTL(true)` + app restart chahiye (app-wide change). |
| Fonts | Devanagari / Bengali / Tamil / Thai glyphs tumhare custom font me hone chahiye, warna ▯▯▯ boxes dikhenge. |
| Layout | German aur Tamil strings English se kaafi lambi hoti hain — buttons aur single-line rows check karo. |
| Thai | Words ke beech space nahi hota aur tone marks upar-niche lagte hain — row ki `lineHeight` thodi badhani pad sakti hai. |

---

## 12. Dusre project me le jaate waqt (adaptation)

Upar ka code in cheezon pe depend karta hai. Naye project me inhe adjust karo:

| Dependency | Kya karna hai |
|---|---|
| `@env` (`react-native-dotenv`) | Naye project me nahi hai? To `Translate.js` se `import { TRANSLATE_ENGINE, TRANSLATE_KEY } from '@env';` line **hata do**, aur usi jagah `translate.engine = 'google';` rehne do (jo `TRANSLATE_ENGINE ||` hai use hata do). Bas. |
| `useTheme()` (ThemeContext) | `ChooseLanguage.jsx` me colors isi se aate hain. Apne theme ka use karo ya colors hardcode kar do. |
| `Roboto-Medium` / `Roboto-Regular` | Apne project ke font names daalo, warna styles se `fontFamily` hata do. |
| `@expo/vector-icons` | Icons ke liye. Na ho to `react-native-vector-icons` use karo ya icons hata do. |
| React Navigation | `navigation.navigate('ChooseLanguage')` assume kiya gaya hai. |

`Translate.js` ko sirf `react`, `react-native`, `translate` aur `AsyncStorage`
chahiye — baaki sab optional hai.

---

## 13. Checklist (naye project ke liye)

```
[ ] npm install translate
[ ] npx expo install @react-native-async-storage/async-storage
[ ] src/components/Translate.js         copy karo (Section 4)
[ ] src/constant/languages.js           copy karo (Section 5)
[ ] src/screens/.../ChooseLanguage.jsx  copy karo (Section 6)
[ ] @env import hata do agar react-native-dotenv nahi hai
[ ] App.js ko <LanguageProvider> se wrap karo
[ ] Navigator me ChooseLanguage route add karo
[ ] Settings me "App language" row add karo (+ useMemo deps me currentLanguage)
[ ] Jis screen ko translate karna hai uska import badlo
[ ] User data / numbers / messages pe `ignore` lagao
[ ] Chat screens ko HAATH MAT LAGAO
[ ] Har language me test karo — layout, fonts, lambe strings
```

---

## 14. Troubleshooting

| Problem | Wajah / Fix |
|---|---|
| Text translate nahi ho raha | Us screen ne abhi bhi `react-native` ka `Text` import kiya hua hai. Import badlo. |
| `<Text>` pe kuch nahi dikh raha / translate nahi hua | Children string nahi hai (array/number). Wrapper array chhod deta hai — split karo. |
| App restart ke baad language reset ho gayi | `LanguageProvider` App.js me wrap nahi hua, ya AsyncStorage write fail hua. |
| Sab kuch English hi hai | Selected language `en` hai — us case me jaan-bujh kar koi API call nahi jaati. |
| `The language "xx" is not part of the ISO 639-1` | `languages.js` me galat code hai. Valid ISO 639-1 tag daalo. |
| Kuch der baad translate band ho gaya | Free endpoint ne rate-limit kar diya (429). Thodi der baad chalega; production ke liye Section 3 padho. |
| Metro error: `Unable to resolve http` | `translate@1.4.1` install ho gaya hai. `npm install translate@^3` karo. |
| Language ka naam khud translate ho gaya | Us `<Text>` pe `ignore` lagana bhool gaye. |
| Language badalne pe subtitle purana dikh raha | `useMemo` deps me `currentLanguage` add karo. |
