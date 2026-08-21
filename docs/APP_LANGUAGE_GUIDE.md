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
const CACHE_KEY = 'translation.cache.v2';
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

/* ─────────────────── auto source language (chat messages) ─────────────────── */

/**
 * The same free endpoint the package's google engine uses, called directly for
 * ONE case the package cannot express: `sl=auto`.
 *
 * `translate()` validates the source against ISO 639-1 and "auto" is not a
 * language, so it throws. Chat messages need auto-detection — the sender's
 * language is unknown, and forcing `sl=en` means a Hindi message would never
 * translate back to English for the other side.
 */
const GOOGLE_FREE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

async function translateAuto(text, to, sl = 'auto') {
  const url =
    `${GOOGLE_FREE_ENDPOINT}?client=gtx&sl=${sl}&tl=${encodeURIComponent(to)}` +
    `&dt=t&q=${encodeURIComponent(text)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  const chunks = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : null;
  if (!chunks) throw new Error('Unexpected response shape');
  return chunks.map((chunk) => (chunk && chunk[0]) || '').join('');
}

/** Scripts, keyed by the languages this app offers. */
const SCRIPT_OF = {
  hi: /[\u0900-\u097F]/, mr: /[\u0900-\u097F]/,
  bn: /[\u0980-\u09FF]/, gu: /[\u0A80-\u0AFF]/, pa: /[\u0A00-\u0A7F]/,
  ta: /[\u0B80-\u0BFF]/, te: /[\u0C00-\u0C7F]/,
  kn: /[\u0C80-\u0CFF]/, ml: /[\u0D00-\u0D7F]/,
  ur: /[\u0600-\u06FF]/, ar: /[\u0600-\u06FF]/,
  ru: /[\u0400-\u04FF]/, th: /[\u0E00-\u0E7F]/,
  ja: /[\u3040-\u30FF\u4E00-\u9FFF]/, zh: /[\u4E00-\u9FFF]/,
};
const NON_LATIN_SCRIPT =
  /[\u0400-\u04FF\u0590-\u06FF\u0900-\u0DFF\u0E00-\u0E7F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7A3]/;

/**
 * "Is this text already readable by someone using `language`?"
 *
 * A cheap SCRIPT check, not language detection. Its only job is to avoid a
 * network round-trip per chat message: an English reader looking at English
 * messages, or a Thai reader looking at Thai messages, costs zero requests.
 *
 * For a Latin-script target it can only tell that the text is Latin, so a
 * French message shown to an English reader is left untranslated — an accepted
 * trade-off (see the guide).
 */
function looksAlreadyReadable(text, language) {
  const script = SCRIPT_OF[language];
  if (script) return script.test(text);
  return !NON_LATIN_SCRIPT.test(text);
}

/**
 * Which source language to ask for.
 *
 * `auto` is right for text written in its own script (Devanagari, Thai, Arabic…).
 * It is WRONG for romanized text — "Kya kru", "Ab btao", "Tum kha ja rhe ho" are
 * Hindi typed in Latin letters, and Google detects them as `hi`. With a Hindi
 * reader that makes source == target, so the endpoint returns the message
 * unchanged and nothing appears to translate.
 *
 * So: Latin-script message + non-Latin-script reader → force `sl=en`. Google
 * then actually converts it ("Ab btao" → "अब बताओ"), and genuinely English
 * messages are unaffected because English IS the forced source.
 */
function sourceFor(text, language) {
  const readerUsesOwnScript = Boolean(SCRIPT_OF[language]);
  const messageIsLatin = !NON_LATIN_SCRIPT.test(text);
  return readerUsesOwnScript && messageIsLatin ? 'en' : 'auto';
}

/* ─────────────────────────── translate entry ─────────────────────────── */

/**
 * Translate one string. Always resolves — on any failure it resolves with the
 * original text, so no caller ever needs a try/catch.
 */
export async function t(text, language, from = SOURCE_LANGUAGE) {
  if (typeof text !== 'string' || !text.trim()) return text;
  if (!language) return text;

  // 'auto' only works through the endpoint directly; any other engine falls
  // back to treating the text as English.
  const auto = from === 'auto' && translate.engine === 'google';
  const source = from === 'auto' ? (auto ? 'auto' : SOURCE_LANGUAGE) : from;

  if (source !== 'auto' && language === source) return text;     // en → en: nothing to do
  if (source === 'auto' && looksAlreadyReadable(text, language)) return text;

  // Romanized text needs an explicit source — see sourceFor().
  const sl = auto ? sourceFor(text, language) : source;

  await loadCache();
  const key = `${sl}::${language}::${text}`;
  if (memoryCache[key] != null) return memoryCache[key];         // cache hit — 0 requests

  const pending = inflight.get(key);
  if (pending) return pending;                                   // same string twice on one screen

  const request = enqueue(() =>
    (auto ? translateAuto(text, language, sl) : translate(text, language))
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
 *
 * `from="auto"` makes the source language auto-detected instead of assumed
 * English. That is what chat messages use — the sender's language is unknown
 * and translation has to work in both directions.
 */
function TText({ ignore, from, children, ...rest }) {
  const { language } = useLanguage();
  const source = typeof children === 'string' ? children : null;
  const [text, setText] = useState(children);

  useEffect(() => {
    let alive = true;
    // `from="auto"` (chat messages) must still run when the reader's language
    // is English — a Hindi message has to become English for them.
    const nothingToDo =
      ignore || source === null || (from !== 'auto' && language === SOURCE_LANGUAGE);
    if (nothingToDo) {
      setText(children);
      return undefined;
    }
    // Render the original immediately, swap in the translation when it lands.
    setText(children);
    t(source, language, from).then((result) => { if (alive) setText(result); });
    return () => { alive = false; };
  }, [source, children, language, ignore, from]);

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
  { code: 'th', label: 'ไทย',         english: 'Thai',       flag: '🇹🇭' },
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

## 7. WIRING — kahan-kahan change karna hai

> Is section ka saara code **is project ki asli files se nikala gaya hai** —
> jaisa chal raha hai, waisa hi yahan hai.

### 7.1 `App.js` — provider lagao

```jsx
import { LanguageProvider } from './src/components/Translate';
```

Provider ko navigation ke **bahar aur upar** rakho (yahan theme ke andar hai):

```jsx
       <ThemeProvider>
        {/* Selected app language + the on-disk translation cache. Sits high so
            every screen using the translated <Text> re-renders the moment the
            user picks a different language — no app restart needed. */}
        <LanguageProvider>
         <NetworkProvider>
          <PaperProvider>
           <DeviceInfoProvider>
            <AuthProvider>
              <ContactProvider>
               <ImageProvider>
                <DeviceLocationProvider>
                 <PresenceProvider>
                  <RealtimeChatProvider>
                    <CallProvider>
                      <CallContentInset>
                        <AppContent />
                        <AppLockGate />
                      </CallContentInset>
                    </CallProvider>
                  </RealtimeChatProvider>
                 </PresenceProvider>
                </DeviceLocationProvider>
               </ImageProvider>
              </ContactProvider>
            </AuthProvider>
           </DeviceInfoProvider>
          </PaperProvider>
         </NetworkProvider>
        </LanguageProvider>
       </ThemeProvider>
```

### 7.2 Navigator — route register karo

```jsx
import ChooseLanguage from "../screens/profiles/ChooseLanguage";
```

```jsx
// Stack.Navigator ke andar
<Stack.Screen name="ChooseLanguage" component={ChooseLanguage} />
```

### 7.3 Settings screen — entry point

Imports:

```jsx
import {
  View, Image, Animated, TouchableOpacity, ScrollView,
  Alert, StyleSheet, ActivityIndicator, Platform, Text
} from "react-native";
// Translated <Text>: static labels go through Google Translate; anything marked
// `ignore` (the user's own name, bio, e-mail) is rendered exactly as stored.
import { useLanguage } from "../../components/Translate";
import { getLanguage } from "../../constant/languages";
import { useTheme } from "../../contexts/ThemeContext";
```

> Dhyaan do: yahan `Text` **react-native** se hi aa raha hai, kyunki is project
> me sirf chat messages translate karne hain (Section 9). Agar poori Settings
> screen translate karni ho to `Text` ko `../../components/Translate` se import
> karo — baaki code same rahega.

Component ke andar:

```jsx
  const { language } = useLanguage();
  const currentLanguage = getLanguage(language);
```

Menu item (jahan baaki rows hain):

```jsx
{
          icon: 'language-outline',
          label: 'App language',
          // Already in its own script — renderMenuItem marks it `ignore`.
          subtitle: `${currentLanguage.flag}  ${currentLanguage.label}`,
          ignoreSubtitle: true,
          onPress: () => navigation.navigate('ChooseLanguage'),
},
```

`useMemo` dependency array me `currentLanguage` **zaroori** hai — warna language
badalne pe subtitle purana dikhega:

```jsx
]), [isDarkMode, isBackingUp, backupStatus, currentLanguage]);
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

## 9. Chat messages translate karna (message-only integration)

Chat app me **poori screen ko opt-in karna galat hai** — sender ka naam, time,
ticks, menu sab translate ho jayenge, aur har cheez Google ko jayegi.

Sahi tareeka: sirf **message ka text** custom component se render karo.

### 9.1 Import (alias CAPITAL letter se shuru hona chahiye)

`ChatScreen.jsx` ke asli imports:

```jsx
// Message-body text only. Everything else on this screen keeps React
// Native's <Text>: names, timestamps, ticks, menus and system rows must
// never be sent to a translation API.
// NOTE: the alias MUST start with a capital letter — JSX treats a lowercase
// element name (<myText>) as a native host component, not a React component.
import { Text as MyText, useLanguage } from "../../components/Translate";
```

> ⚠️ **`Text as myText` mat likhna.** JSX me chhote akshar se shuru hone wala
> element (`<myText>`) React component nahi, **native host component** samjha
> jata hai — app crash karegi. Alias hamesha capital: `MyText`.

`react-native` wala `Text` waisa ka waisa import rehta hai — screen ke baaki
116 `<Text>` usko hi use karte hain.

Component ke andar (taaki language badalte hi bubbles re-render ho):

```jsx
const { language } = useLanguage();
```

...aur `renderChatsItem` ke `useCallback` dependency array me `language` add karo.

### 9.2 Sirf message body pe `MyText` — asli code

Ye poora token renderer hai. Dekho kya `MyText` hai aur kya `Text` (RN) rehta hai:

```jsx
            if (token.type === 'link') {
              return (
                <Text
                  key={key}
                  onPress={() => handleOpenLink(token.href)}
                  style={{
                    color: linkColor,
                    textDecorationLine: 'underline',
                    fontFamily: 'Roboto-Medium',
                  }}
                >
                  {token.text}
                </Text>
              );
            }
            if (token.type === 'code') {
              return (
                <Text
                  key={key}
                  style={{
                    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                    backgroundColor: isMyMessage ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.09)',
                    color: baseColor,
                  }}
                >
                  {token.text}
                </Text>
              );
            }
            if (token.type === 'bold') {
              return (
                <MyText from="auto" key={key} style={{ fontFamily: 'Roboto-SemiBold', color: baseColor }}>
                  {token.text}
                </MyText>
              );
            }
            if (token.type === 'italic') {
              return (
                <MyText from="auto" key={key} style={{ fontFamily: 'Roboto-Regular', fontStyle: 'italic', color: baseColor }}>
                  {token.text}
                </MyText>
              );
            }
            if (token.type === 'underline') {
              return (
                <MyText from="auto" key={key} style={{ textDecorationLine: 'underline', color: baseColor }}>
                  {token.text}
                </MyText>
              );
            }
            // The message body itself. With mentions the children become an
            // ARRAY, which MyText renders untouched — so @names are never sent
            // anywhere; only a plain string is translated.
            return (
              <MyText from="auto" key={key} style={{ color: baseColor }}>
                {msgMentions ? renderTextWithMentions(token.text, msgMentions, baseColor, mentionColor, key) : token.text}
              </MyText>
            );
```

### 9.3 Kya translate hota hai, kya nahi

| Chat ka hissa | Component | Wajah |
|---|---|---|
| Message ka text (plain / bold / italic / underline) | `MyText from="auto"` | Yahi translate karna hai |
| Inline code aur code block | `Text` (RN) | Code kabhi translate nahi hona chahiye |
| Link / URL | `Text` (RN) | URL toot jayega |
| @mentions | apne aap safe | Children array ban jate hain, wrapper array chhod deta hai |
| Sender ka naam, time, ticks | `Text` (RN) | User data — bhejna hi nahi hai |
| Menu, header, system rows | `Text` (RN) | Chhua hi nahi |

### 9.4 Source language kaise choose hoti hai (Hinglish wala fix)

Ye sabse important logic hai. `sourceFor()` decide karta hai ki Google ko kaunsi
source language batani hai:

| Message ka script | Reader ki language | Source bheji jati hai |
|---|---|---|
| Devanagari / Thai / Arabic / CJK (apni script) | koi bhi | `sl=auto` |
| Latin letters | non-Latin reader (hi, th, ta, ar, ru, ja, zh…) | **`sl=en`** |

**`sl=en` forced kyun?** Kyunki **Hinglish** (Hindi Latin letters me likhi hui)
`auto` ke saath tootti hai:

```
"Kya kru"      + sl=auto + tl=hi   →   "Kya kru"        ← Google detect: hi
"Ab btao"      + sl=auto + tl=hi   →   "Ab btao"        ← source == target
```

Google in messages ko **pehle hi Hindi** maan leta hai, aur reader ki language
bhi Hindi hai — to source aur target same ho gaye, aur endpoint message **jaisa
ka waisa** wapas kar deta hai. Isliye lagta hai ki translation kaam nahi kar raha
(jabki koi error bhi nahi aata).

`sl=en` force karte hi sahi kaam hota hai:

```
"Kya kru"                            →  क्या हुआ
"Ab btao"                            →  अब बताओ
"Kya kah rhe hoo"                    →  क्या कह रहे हो
"Tum kha ja rhe ho"                  →  तुम खा जा रहे हो
"Thoda bhot kam lunga denge aap ka"  →  थोड़ा बहुत कम लूंगा देंगे आप का
"How are you?"                       →  आप कैसे हैं?     ← asli English bhi theek
```

### 9.5 Request kab jati hai (cost control)

Ek sasta **script check** — network call tabhi jati hai jab message padhne layak
na ho:

| Message → Reader | Action |
|---|---|
| English msg → English reader | SKIP (0 request) |
| Devanagari msg → Hindi reader | SKIP (0 request) |
| Thai msg → Thai reader | SKIP (0 request) |
| Hinglish msg → Hindi reader | TRANSLATE (`sl=en`) |
| English msg → Hindi reader | TRANSLATE (`sl=en`) |
| Devanagari msg → English reader | TRANSLATE (`sl=auto`) |
| Thai msg → Hindi reader | TRANSLATE (`sl=auto`) |

**Limitations:**
* Latin script aapas me alag nahi ho sakti — French message English reader ko
  waisa hi dikhega (skip).
* Hinglish message **English reader** ko translate nahi hoga (dono Latin hain →
  skip). Sirf non-Latin reader ke liye convert hota hai.
* Hinglish message **Thai/Arabic** reader ko phonetic garbage de sakta hai
  (`"Ab btao"` → `"แอบบีเทา"`), kyunki use English maan ke padha jata hai.

### 9.6 Zaroori baatein

* Har message **unique** hota hai, isliye cache kaam nahi aata — har naye message
  pe ek request. Free endpoint rate-limited hai, to busy chat me 429 aa sakta
  hai. Fail hone pe original message dikhta hai (kuch tootta nahi).
* **Privacy:** message ka text Google ke server pe jata hai. Agar app privacy
  promise karti hai to ya to users ko batao, ya on-device translation
  (ML Kit) use karo.
* Message **DB me original hi save rehta hai** — translation sirf display ke
  waqt hoti hai, kuch overwrite nahi hota.
* Apne bheje hue messages bhi translate honge (agar script alag hai). Apne
  messages chhodne hain to `isMyMessage` check karke `from` prop mat bhejo.

---

## 10. Cache, cost aur limits

* **Do layer cache**: memory + `AsyncStorage` (`translation.cache.v2`), key =
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
| Hinglish | Roman Hindi ("Kya kru") ko non-Latin reader ke liye `sl=en` force karke convert kiya jata hai (Section 9.4). English reader ke liye ye convert nahi hoti. |
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
[ ] Chat me sirf message body pe MyText from="auto" (Section 9)
[ ] Har language me test karo — layout, fonts, lambe strings
```

---

## 14. Poori change list (cross-check)

Feature ke liye **exactly** ye files chhui gayi hain — isse zyada kuch nahi:

### Nayi files (3)

| File | Kya hai | Guide me |
|---|---|---|
| `src/components/Translate.js` | Core wrapper + cache + provider + auto-detect | Section 4 (poora code) |
| `src/constant/languages.js` | 20 languages ki list | Section 5 (poora code) |
| `src/screens/profiles/ChooseLanguage.jsx` | Search wali picker screen | Section 6 (poora code) |

### Modified files (5)

| File | Change | Guide me |
|---|---|---|
| `package.json` | `"translate": "^3.1.0"` add | Section 2 |
| `App.js` | `LanguageProvider` import + tree me wrap | Section 7.1 |
| `src/navigations/RootNavigator.js` | `ChooseLanguage` import + `<Stack.Screen>` | Section 7.2 |
| `src/screens/profiles/Setting.jsx` | `useLanguage` + `getLanguage` import, `currentLanguage`, "App language" row, `useMemo` deps | Section 7.3 |
| `src/screens/chats/ChatScreen.jsx` | `MyText` import, `useLanguage()`, 4 prose tokens → `MyText from="auto"`, deps me `language` | Section 9.1 / 9.2 |

### Jo NAHI chhua gaya

* Koi native code nahi (`android/`, `ios/`, koi config plugin nahi) — `translate` pure JS hai.
* Backend / API / database me **koi change nahi** — message original hi save hota hai.
* Baaki saari screens (ChatList, Profile, Status, Calls, group screens) **jaisi thi waisi hai**.
* Chat ka baaki UI — sender name, time, ticks, reply preview, menu — sab RN `Text` pe hi hai.

---

## 15. Troubleshooting

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
| `<myText>` pe crash / "Unimplemented component" | Alias capital letter se shuru karo: `Text as MyText`. |
| Message translate nahi ho raha | `from="auto"` lagana bhool gaye, ya message aur reader ki script same hai (jaan-bujh kar skip hota hai — Section 9.5). |
| Hinglish message waisa ka waisa aa raha | Google use pehle hi Hindi detect kar leta hai; `sourceFor()` `sl=en` force karta hai. Section 9.4 dekho. |
