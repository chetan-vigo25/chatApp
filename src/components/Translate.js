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
