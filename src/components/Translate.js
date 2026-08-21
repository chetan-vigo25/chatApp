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
export function useT(text, from = SOURCE_LANGUAGE) {
  const { language } = useLanguage();
  const [value, setValue] = useState(text);

  useEffect(() => {
    let alive = true;
    // `from="auto"` must still run when the reader's language is English —
    // a Hindi message has to become English for them.
    if (typeof text !== 'string' || (from !== 'auto' && language === SOURCE_LANGUAGE)) {
      setValue(text);
      return undefined;
    }
    setValue(text);                                   // show the original first
    t(text, language, from).then((result) => { if (alive) setValue(result); });
    return () => { alive = false; };
  }, [text, language, from]);

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
 * English.
 *
 * NOTE for long-form text (chat messages): prefer the `useT(text, 'auto')` hook
 * over this component. A nested <Text> that swaps its string asynchronously
 * does NOT re-measure its parent on Android — the bubble keeps the width it
 * measured from the ORIGINAL string, so a slightly wider translation wraps
 * mid-sentence ("क्या हुआ" breaking into "क्या" / "हुआ"). The hook translates
 * BEFORE the text is rendered, so the whole subtree lays out with the final
 * string. See docs/APP_LANGUAGE_GUIDE.md Section 9.2.
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
