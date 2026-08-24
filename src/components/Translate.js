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
import { AppState, Text as RNText, TextInput as RNTextInput } from 'react-native';
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
/**
 * Hard ceiling on a single request.
 *
 * React Native's fetch has NO default timeout on Android, and the queue above
 * only frees a slot in `.finally`. Four sockets left hanging on a flaky mobile
 * network would therefore wedge the queue for the rest of the app's life and
 * every later translation would silently never run.
 */
const REQUEST_TIMEOUT_MS = 12000;
/** 429 backoff schedule. Escalates while it keeps refusing, resets on success. */
const COOLDOWN_STEPS_MS = [30000, 60000, 120000, 300000];

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

function writeCacheNow() {
  const keys = Object.keys(memoryCache);
  if (keys.length > MAX_CACHE_ENTRIES) {
    // Object key order is insertion order — drop the oldest overflow.
    keys.slice(0, keys.length - MAX_CACHE_ENTRIES).forEach((k) => delete memoryCache[k]);
  }
  return AsyncStorage.setItem(CACHE_KEY, JSON.stringify(memoryCache)).catch(() => {});
}

function persistCache() {
  // Debounced: a screen mounting 30 labels writes to disk once, not 30 times.
  // Kept SHORT — this cache is what makes a reopened chat paint its previous
  // translation instantly and offline. A long window meant a reload right after
  // translating lost the write, and the messages came back in English.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeCacheNow, 250);
}

/** Force the pending cache write to disk right now (app backgrounding, etc). */
export function flushTranslationCache() {
  clearTimeout(saveTimer);
  return writeCacheNow();
}

// A reload/kill loses whatever is still sitting in the debounce window, so land
// it the moment the app stops being foregrounded.
AppState.addEventListener('change', (state) => {
  if (state !== 'active') flushTranslationCache();
});

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

/**
 * Rate-limit cooldown.
 *
 * The free endpoint does not throttle politely — once it starts answering 429
 * it keeps doing so for a while, and hammering it extends the block. So the
 * FIRST 429 parks every caller for a growing window instead of letting each
 * message burn another rejected request.
 */
let rateLimitedUntil = 0;
let cooldownStep = 0;

function enterCooldown() {
  const wait = COOLDOWN_STEPS_MS[Math.min(cooldownStep, COOLDOWN_STEPS_MS.length - 1)];
  cooldownStep += 1;
  rateLimitedUntil = Date.now() + wait;
  if (__DEV__) console.warn(`[translate] rate limited — pausing ${wait / 1000}s`);
}

function leaveCooldown() {
  cooldownStep = 0;
  rateLimitedUntil = 0;
}

/**
 * How long until it is worth asking again, in ms (0 = right now).
 *
 * Callers that hold retryable work poll this to schedule themselves, which is
 * what makes a chat heal on its own once the block expires.
 */
export function getRetryDelay() {
  return Math.max(0, rateLimitedUntil - Date.now());
}

/** Rejects if the underlying request outlives REQUEST_TIMEOUT_MS. */
function withTimeout(promise, controller) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (controller) { try { controller.abort(); } catch {} }
      reject(new Error('timeout'));
    }, REQUEST_TIMEOUT_MS);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function translateAuto(text, to, sl = 'auto') {
  const url =
    `${GOOGLE_FREE_ENDPOINT}?client=gtx&sl=${sl}&tl=${encodeURIComponent(to)}` +
    `&dt=t&q=${encodeURIComponent(text)}`;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const response = await withTimeout(
    fetch(url, controller ? { signal: controller.signal } : undefined),
    controller,
  );
  if (response.status === 429) {
    enterCooldown();
    throw new Error('HTTP 429');
  }
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
 * Translate one string and report WHAT happened.
 *
 *   { text, status }
 *     'skipped'    — nothing to do (empty, same language, already readable).
 *                    The caller can stop asking about this string.
 *     'translated' — real translation (fresh or from cache).
 *     'unchanged'  — the engine answered, but with the same string back.
 *     'failed'     — the request errored. `text` is the original, and the
 *                    caller MAY retry later; nothing was cached.
 *     'deferred'   — the engine is in its rate-limit cooldown, so NOTHING was
 *                    tried. Callers must retry after `getRetryDelay()` and must
 *                    NOT count this against a retry budget: no attempt was made.
 *
 * Callers that only want the string use `t()` below. Callers that must retry
 * transient failures (chat bubbles) need this distinction — without it a failed
 * request looks exactly like "no translation needed" and is never retried.
 */
function resolveRequest(text, language, from) {
  if (typeof text !== 'string' || !text.trim()) return { skip: true };
  if (!language) return { skip: true };

  // 'auto' only works through the endpoint directly; any other engine falls
  // back to treating the text as English.
  const auto = from === 'auto' && translate.engine === 'google';
  const source = from === 'auto' ? (auto ? 'auto' : SOURCE_LANGUAGE) : from;

  if (source !== 'auto' && language === source) return { skip: true };
  if (source === 'auto' && looksAlreadyReadable(text, language)) return { skip: true };

  // Romanized text needs an explicit source — see sourceFor().
  const sl = auto ? sourceFor(text, language) : source;
  return { skip: false, auto, sl, key: `${sl}::${language}::${text}` };
}

/** Resolves once the on-disk cache has been read into memory. */
export function ensureTranslationCacheReady() {
  return loadCache();
}

/**
 * SYNCHRONOUS cache lookup — no request, ever. Returns the stored translation
 * or null.
 *
 * This is what lets a reopened chat paint its previous translation in the FIRST
 * frame, with no network and no per-message promise. Call
 * `ensureTranslationCacheReady()` once before relying on it, otherwise the disk
 * cache may not be in memory yet and every lookup misses.
 */
export function peekTranslation(text, language, from = SOURCE_LANGUAGE) {
  const plan = resolveRequest(text, language, from);
  if (plan.skip) return null;
  const hit = memoryCache[plan.key];
  return typeof hit === 'string' && hit !== text ? hit : null;
}

export async function translateDetailed(text, language, from = SOURCE_LANGUAGE) {
  const plan = resolveRequest(text, language, from);
  if (plan.skip) return { text, status: 'skipped' };
  const { auto, sl, key } = plan;

  await loadCache();
  if (memoryCache[key] != null) {                                // cache hit — 0 requests
    const hit = memoryCache[key];
    return { text: hit, status: hit === text ? 'unchanged' : 'translated' };
  }

  const pending = inflight.get(key);
  if (pending) return pending;                                   // same string twice on one screen

  // Cooling down after a 429: answer without touching the network. Spending the
  // request would only prolong the block, and the caller reschedules itself.
  if (getRetryDelay() > 0) return { text, status: 'deferred' };

  const request = enqueue(() =>
    (auto
      ? translateAuto(text, language, sl)
      : withTimeout(Promise.resolve(translate(text, language))))
      .then((result) => {
        const value = typeof result === 'string' && result.trim() ? result : text;
        leaveCooldown();                        // the endpoint is answering again
        memoryCache[key] = value;
        persistCache();
        return { text: value, status: value === text ? 'unchanged' : 'translated' };
      })
      .catch((error) => {
        if (__DEV__) console.warn('[translate] failed:', error?.message || error);
        // NOT cached: a transient failure must stay retryable.
        return { text, status: 'failed' };
      }),
  ).finally(() => inflight.delete(key));

  inflight.set(key, request);
  return request;
}

/** String-only wrapper: always resolves with something renderable. */
export async function t(text, language, from = SOURCE_LANGUAGE) {
  const { text: value } = await translateDetailed(text, language, from);
  return value;
}

/* ───────────────────────── language context ───────────────────────── */

/**
 * The persisted choice, hoisted to MODULE scope.
 *
 * The provider used to start every mount at SOURCE_LANGUAGE and swap to the
 * stored value once AsyncStorage answered. That made English a real, published
 * state — not just a default — so anything that acts on its first render (the
 * chat screen fills its list from SQLite synchronously and immediately starts
 * translating) ran a whole pass under the wrong language.
 *
 * Reading starts at import time and the result is remembered here, so the very
 * first render after hydration already has the saved language and any later
 * remount is synchronous. English is now used ONLY when storage genuinely holds
 * no preference.
 */
let cachedLanguage = null;
let languageLoadPromise = null;

function loadLanguage() {
  if (cachedLanguage != null) return Promise.resolve(cachedLanguage);
  if (!languageLoadPromise) {
    languageLoadPromise = AsyncStorage.getItem(LANGUAGE_STORAGE_KEY)
      .then((saved) => {
        cachedLanguage = saved || SOURCE_LANGUAGE;
        return cachedLanguage;
      })
      .catch(() => {
        cachedLanguage = SOURCE_LANGUAGE;   // unreadable storage → documented fallback
        return cachedLanguage;
      });
  }
  return languageLoadPromise;
}

// Kick the read off as early as the bundle allows, not on the provider's first
// effect — it shortens the window where nothing knows the language yet.
loadLanguage();

const LanguageContext = createContext({
  language: SOURCE_LANGUAGE,
  setLanguage: async () => {},
  ready: false,
});

export function LanguageProvider({ children }) {
  // Lazy initialisers: a remount after hydration starts on the saved language
  // and is `ready` in its first render — no English frame, no re-fetch.
  const [language, setLang] = useState(() => cachedLanguage || SOURCE_LANGUAGE);
  const [ready, setReady] = useState(() => cachedLanguage != null);

  useEffect(() => {
    if (ready) return undefined;
    let alive = true;
    (async () => {
      try {
        const saved = await loadLanguage();
        if (alive) setLang(saved);
        await loadCache();
      } catch {
        /* keep English */
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => { alive = false; };
  }, [ready]);

  const setLanguage = useCallback(async (code) => {
    if (!code) return;
    cachedLanguage = code;               // remounts read this, not AsyncStorage
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
