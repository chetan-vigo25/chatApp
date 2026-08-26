/**
 * ML Kit powered <Text> / <TextInput>.
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
 * ── What actually does the translating ───────────────────────────────────────
 * Google ML Kit's ON-DEVICE translation, through the local `expo-mlkit-translate`
 * native module. Nothing leaves the phone: no API key, no billing, no rate
 * limit, and it works with the network off.
 *
 * This replaced translate.googleapis.com/translate_a/single — Google's
 * undocumented free endpoint — which rate-limited a single IP after a handful
 * of requests and left every message untranslated.
 *
 * The trade-offs that come with on-device:
 *   • each language needs a ~30MB model, downloaded when the user picks it;
 *   • ML Kit covers fewer languages than the cloud API (no Malayalam/Punjabi);
 *   • quality is below the cloud model, especially for romanized text.
 * See docs/APP_LANGUAGE_GUIDE.md before changing any of this.
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
import MlkitTranslate from '../../modules/expo-mlkit-translate';
import { lookupUiString } from '../constant/uiStrings';
import { hinglishToEnglish } from '../constant/hinglish';

export const LANGUAGE_STORAGE_KEY = 'app.language';
/**
 * v3: the key scheme changed with the ML Kit switch (the source language is no
 * longer baked into the key), so v2's cloud-era entries would never be hit.
 */
const CACHE_KEY = 'translation.cache.v3';
/** Source language of every hard-coded string in this app. */
export const SOURCE_LANGUAGE = 'en';
/** Disk cache ceiling — keeps AsyncStorage from growing without bound. */
const MAX_CACHE_ENTRIES = 3000;
/**
 * On-device work is CPU- and RAM-bound rather than network-bound, and a live
 * ML Kit translator holds 30–150MB. Two at a time keeps the JS thread and the
 * heap calm while still overlapping work.
 */
const MAX_CONCURRENT = 2;
/** A local call should never take this long; guards against a wedged model. */
const REQUEST_TIMEOUT_MS = 15000;
/** How long to wait before re-asking once a model turned out to be missing. */
const MODEL_RETRY_MS = 4000;
/**
 * Ceiling on a model download, enforced here so BOTH platforms are covered by
 * one rule.
 *
 * A download that never settles would leave the language picker's spinner up
 * for good. The native side has its own guard too — this one also catches a
 * bridge that simply never answers.
 */
const MODEL_DOWNLOAD_TIMEOUT_MS = 200000;

/* ────────────────────────────── cache ────────────────────────────── */

let memoryCache = {};           // { "auto::hi::Good Morning": "सुप्रभात" }
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
  // translation instantly. A long window meant a reload right after translating
  // lost the write, and the messages came back in English.
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

const inflight = new Map();     // cacheKey → Promise<{text, status}>
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

/** Rejects if the underlying call outlives REQUEST_TIMEOUT_MS. */
function withTimeout(promise) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), REQUEST_TIMEOUT_MS);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/* ───────────────────────── on-device models ───────────────────────── */

/** True when the native module is in this build (false in Expo Go). */
export const isTranslationAvailable = () => MlkitTranslate.isAvailable();

/** ML Kit's own list — the picker filters against this. */
export const getSupportedLanguages = () => MlkitTranslate.getSupportedLanguages();

/**
 * When a model turned out to be absent, hold off briefly instead of asking on
 * every render. ChatScreen reads this to schedule its own retry, so a chat
 * translates itself the moment the download finishes.
 */
let modelRetryUntil = 0;
export function getRetryDelay() {
  return Math.max(0, modelRetryUntil - Date.now());
}

const downloading = new Map();  // language → Promise<boolean>

/**
 * Make a language usable, downloading its ~30MB model if needed.
 *
 * ML Kit pivots every pair through English, so the English model is fetched
 * alongside the requested one — without it a hi→th translation cannot run.
 *
 * Resolves true when the language is ready. Never throws: a failed download
 * just means translations stay in the original text.
 */
export function ensureLanguageReady(language, { requireWifi = true } = {}) {
  if (!language || language === SOURCE_LANGUAGE) return prepare(SOURCE_LANGUAGE, requireWifi);
  return Promise.all([
    prepare(SOURCE_LANGUAGE, requireWifi),
    prepare(language, requireWifi),
  ]).then(([en, target]) => en && target);
}

/**
 * Resolve to `fallback` if `promise` has not settled in time.
 *
 * Deliberately resolves rather than rejects: a download that stalls is a "not
 * ready", not an error the caller has to handle. What matters is that whoever
 * is waiting — the picker, with its spinner up — is always released.
 */
function settleWithin(promise, ms, fallback) {
  let timer;
  const guard = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function prepare(language, requireWifi) {
  if (!MlkitTranslate.isAvailable()) return Promise.resolve(false);
  const existing = downloading.get(language);
  if (existing) return existing;

  const download = MlkitTranslate.isModelDownloaded(language)
    .then((ready) => {
      if (ready) return true;
      return MlkitTranslate.downloadModel({ language, requireWifi })
        .then(() => { modelRetryUntil = 0; return true; })
        .catch((error) => {
          if (__DEV__) console.warn(`[translate] model download failed (${language})`, error?.message || error);
          return false;
        });
    })
    .catch(() => false);

  const job = settleWithin(download, MODEL_DOWNLOAD_TIMEOUT_MS, false)
    .finally(() => { downloading.delete(language); });

  downloading.set(language, job);
  return job;
}

/** Which languages already have their model on disk. */
export const getDownloadedLanguages = () => MlkitTranslate.getDownloadedModels();

/** Free the disk a language's model occupies. */
export const removeLanguageModel = (language) => MlkitTranslate.deleteModel(language);

/* ─────────────────── source language (chat messages) ─────────────────── */

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
 * Scripts this app's bundled font cannot draw.
 *
 * Roboto-Regular.ttf carries 922 codepoints \u2014 Latin, Greek and Cyrillic. Twelve
 * of the languages the picker offers (Devanagari, Bengali, Gujarati, Tamil,
 * Telugu, Kannada, Arabic, Thai, CJK, \u2026) have NO glyphs in it. Both platforms
 * normally cascade to a system font, but that fallback is not guaranteed and
 * mixes metrics; forcing `fontFamily` on text the family cannot render is how
 * you end up looking at \u25AF\u25AF\u25AF.
 *
 * Cyrillic is deliberately excluded here \u2014 Roboto covers it, so Russian keeps
 * the app's own typeface.
 */
const UNSUPPORTED_BY_APP_FONT =
  /[\u0590-\u05FF\u0600-\u08FF\u0900-\u0DFF\u0E00-\u0E7F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7A3]/;

/**
 * True when `text` must be drawn with the platform font instead of the app's.
 *
 * Callers pass `fontFamily: needsSystemFont(t) ? undefined : 'Roboto-Regular'`
 * so the OS picks a face that actually has the glyphs.
 */
export function needsSystemFont(text) {
  return typeof text === 'string' && UNSUPPORTED_BY_APP_FONT.test(text);
}

/**
 * "Is this text already readable by someone using `language`?"
 *
 * A cheap SCRIPT check, not language detection. Its only job is to skip work:
 * an English reader looking at English messages, or a Thai reader looking at
 * Thai messages, costs nothing.
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
 * Decide the source language, or refuse.
 *
 * Returns a language tag, or `null` meaning "leave this message alone".
 *
 * ── The Hinglish problem, and why this refuses ───────────────────────────────
 * "Ab btao", "kya kr rha h" is Hindi typed in Latin letters. ML Kit's detector
 * correctly calls it `hi`, but its models translate BETWEEN SCRIPTS: the hi→x
 * model expects Devanagari, and the en→x model expects real English. Feeding
 * romanized Hindi to en→hi makes the model copy the tokens it does not know, so
 * the output is sometimes the input verbatim and sometimes half-mangled — the
 * "kabhi kabhi" behaviour users reported.
 *
 * Guessing English (what this used to do unconditionally) is therefore wrong.
 * Latin text is only treated as English when the DETECTOR agrees it is English;
 * otherwise the message is left exactly as the sender typed it. That trades
 * "occasionally mangled" for "always predictable".
 *
 * Making Hinglish actually translate needs a model trained on romanized input —
 * i.e. the cloud API. See docs/APP_LANGUAGE_GUIDE.md.
 */
async function detectSource(text, language) {
  const readerUsesOwnScript = Boolean(SCRIPT_OF[language]);
  const messageIsLatin = !NON_LATIN_SCRIPT.test(text);

  let detected = null;
  try {
    const raw = await MlkitTranslate.identifyLanguage(text);
    // ML Kit returns BCP-47 with regions ("zh-Hant"); models are keyed on the
    // base tag.
    if (raw && raw !== 'und') detected = String(raw).split('-')[0];
  } catch {
    detected = null;
  }

  if (messageIsLatin && readerUsesOwnScript) {
    // Undetermined is usually a very short string ("ok", "yes"); English is the
    // safe read there. Anything the detector names as non-English in Latin
    // letters is romanized text ML Kit cannot handle — refuse rather than mangle.
    const source = (detected == null || detected === SOURCE_LANGUAGE) ? SOURCE_LANGUAGE : null;
    // Romanized input is the one case where the outcome surprises people
    // ("why is my Hinglish not translating?"), so say exactly what was decided.
    if (__DEV__) {
      console.log(
        `[translate] latin "${text.slice(0, 40)}" → detector:${detected ?? 'und'} `
        + `→ ${source
          ? `translate ${source}→${language}`
          : 'romanized → phrase pack, else shown as-is'}`,
      );
    }
    return source;
  }

  // Text in its own script: trust the detector, fall back to English.
  return detected ?? SOURCE_LANGUAGE;
}

/* ─────────────────────────── translate entry ─────────────────────────── */

/**
 * Plan a translation without doing it.
 *
 * The cache key intentionally stores 'auto' rather than the resolved source:
 * resolving needs the detector, which is async, and `peekTranslation` has to
 * stay synchronous so a reopened chat can repaint in its first frame.
 */
function resolveRequest(text, language, from) {
  if (typeof text !== 'string' || !text.trim()) return { skip: true };
  if (!language) return { skip: true };

  const auto = from === 'auto';
  const source = auto ? 'auto' : from;

  if (!auto && language === source) return { skip: true };
  if (auto && looksAlreadyReadable(text, language)) return { skip: true };

  return { skip: false, auto, source, key: `${source}::${language}::${text}` };
}

/** Resolves once the on-disk cache has been read into memory. */
export function ensureTranslationCacheReady() {
  return loadCache();
}

/**
 * SYNCHRONOUS cache lookup — no work, ever. Returns the stored translation or
 * null.
 *
 * This is what lets a reopened chat paint its previous translation in the FIRST
 * frame. Call `ensureTranslationCacheReady()` once before relying on it,
 * otherwise the disk cache may not be in memory yet and every lookup misses.
 */
export function peekTranslation(text, language, from = SOURCE_LANGUAGE) {
  const plan = resolveRequest(text, language, from);
  if (plan.skip) return null;
  const hit = memoryCache[plan.key];
  return typeof hit === 'string' && hit !== text ? hit : null;
}

/**
 * Translate one string and report WHAT happened.
 *
 *   { text, status }
 *     'skipped'    — nothing to do (empty, same language, already readable).
 *                    The caller can stop asking about this string.
 *     'translated' — real translation (fresh or from cache).
 *     'unchanged'  — the engine answered with the same string back.
 *     'deferred'   — the on-device model is not downloaded yet, so NOTHING was
 *                    attempted. Retry after `getRetryDelay()`; do NOT count it
 *                    against a retry budget.
 *     'failed'     — the call errored. `text` is the original, the caller MAY
 *                    retry, and nothing was cached.
 *
 * Callers that only want the string use `t()`. Callers that must retry
 * transient failures (chat bubbles) need this distinction — without it a failed
 * call looks exactly like "no translation needed" and is never retried.
 */
export async function translateDetailed(text, language, from = SOURCE_LANGUAGE) {
  const plan = resolveRequest(text, language, from);
  if (plan.skip) return { text, status: 'skipped' };
  const { auto, key } = plan;

  // Curated UI labels win over the model. "Save", "Call", "View once" and the
  // brand name are precisely what machine translation gets wrong, and they are
  // a fixed list that can just be translated properly once. A miss falls
  // through and ML Kit handles it as before.
  const curated = lookupUiString(text, language);
  if (curated != null) {
    return { text: curated, status: curated === text ? 'unchanged' : 'translated' };
  }

  await loadCache();
  if (memoryCache[key] != null) {                          // cache hit — no work
    const hit = memoryCache[key];
    return { text: hit, status: hit === text ? 'unchanged' : 'translated' };
  }

  const pending = inflight.get(key);
  if (pending) return pending;                             // same string twice on one screen

  if (!MlkitTranslate.isAvailable()) return { text, status: 'failed' };

  const request = enqueue(async () => {
    try {
      const source = auto ? await detectSource(text, language) : plan.source;
      // null = romanized text ("chale chalo") that no on-device model can read.
      // This is the ONLY path that leaves the device: the cloud model handles
      // romanized input, ML Kit cannot. A null answer — route not deployed,
      // offline, backed off — means the message stays as the sender typed it,
      // which is the behaviour from before the fallback existed.
      if (source == null) {
        // Romanized Hindi ("chale chalo"): no on-device model can read it, so
        // the bundled phrase pack turns the common ones into English and ML Kit
        // carries that English to ANY target language — all on the device.
        //
        // There is deliberately NO cloud fallback here. This app translates
        // for free or not at all; a phrase the pack does not know is shown
        // exactly as the sender typed it. The way to cover more is to add
        // entries to src/constant/hinglish.js, not to call a paid API.
        const asEnglish = hinglishToEnglish(text);
        if (asEnglish) {
          if (language === SOURCE_LANGUAGE) {
            memoryCache[key] = asEnglish;
            persistCache();
            return { text: asEnglish, status: 'translated' };
          }
          try {
            const out = await withTimeout(MlkitTranslate.translate({
              text: asEnglish, source: SOURCE_LANGUAGE, target: language,
            }));
            if (typeof out === 'string' && out.trim()) {
              memoryCache[key] = out;
              persistCache();
              return { text: out, status: 'translated' };
            }
          } catch {
            // Model missing or wedged — show the original rather than a
            // half-translated string. NOT cached, so it retries later.
          }
        }
        return { text, status: 'skipped' };
      }
      if (source === language) return { text, status: 'skipped' };

      const result = await withTimeout(
        MlkitTranslate.translate({ text, source, target: language }),
      );
      const value = typeof result === 'string' && result.trim() ? result : text;
      memoryCache[key] = value;
      persistCache();
      return { text: value, status: value === text ? 'unchanged' : 'translated' };
    } catch (error) {
      if (error?.code === 'ERR_MLKIT_MODEL_MISSING') {
        // Not a failure — the model just is not here yet. Nudge the download and
        // tell the caller to come back, without burning its retry budget.
        modelRetryUntil = Date.now() + MODEL_RETRY_MS;
        ensureLanguageReady(language);
        return { text, status: 'deferred' };
      }
      if (error?.code === 'ERR_MLKIT_UNSUPPORTED_LANGUAGE') {
        // Permanent for this pair — stop asking.
        return { text, status: 'skipped' };
      }
      if (__DEV__) console.warn('[translate] failed:', error?.message || error);
      // NOT cached: a transient failure must stay retryable.
      return { text, status: 'failed' };
    }
  }).finally(() => inflight.delete(key));

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
 * remount is synchronous. English is used ONLY when storage genuinely holds no
 * preference.
 */
let cachedLanguage = null;
/**
 * Has the user ever CHOSEN a language?
 *
 * Distinct from `cachedLanguage === 'en'` on purpose. A user who never opened
 * the picker has no preference, and their messages must be shown exactly as
 * sent — a Hindi message stays Hindi. A user who deliberately picked English
 * DOES have a preference, so that same message is translated for them.
 * Collapsing the two would auto-translate every chat for people who never
 * asked for translation at all.
 */
let cachedHasPreference = null;
let languageLoadPromise = null;

function loadLanguage() {
  if (cachedLanguage != null) return Promise.resolve(cachedLanguage);
  if (!languageLoadPromise) {
    languageLoadPromise = AsyncStorage.getItem(LANGUAGE_STORAGE_KEY)
      .then((saved) => {
        cachedHasPreference = Boolean(saved);
        cachedLanguage = saved || SOURCE_LANGUAGE;
        return cachedLanguage;
      })
      .catch(() => {
        cachedHasPreference = false;
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
  const [hasPreference, setHasPreference] = useState(() => cachedHasPreference === true);

  useEffect(() => {
    if (ready) return undefined;
    let alive = true;
    (async () => {
      try {
        const saved = await loadLanguage();
        if (alive) {
          setLang(saved);
          setHasPreference(cachedHasPreference === true);
        }
        await loadCache();
      } catch {
        /* keep English */
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => { alive = false; };
  }, [ready]);

  // Make sure the restored language can actually be translated into. A model
  // deleted by the OS to reclaim space would otherwise leave the app silently
  // untranslated until the user re-picked the language.
  useEffect(() => {
    if (!ready || language === SOURCE_LANGUAGE) return;
    ensureLanguageReady(language);
  }, [ready, language]);

  /**
   * `requireWifi` defaults to true for background callers. The picker passes
   * false: the user tapped the language themselves and the screen shows the
   * download size, so it is an informed choice rather than a surprise 30MB on
   * someone's data plan.
   */
  const setLanguage = useCallback(async (code, { requireWifi = true } = {}) => {
    if (!code) return;
    cachedLanguage = code;               // remounts read this, not AsyncStorage
    cachedHasPreference = true;          // an explicit pick, even if it is English
    setHasPreference(true);
    setLang(code);                       // every <Text> re-renders — no app restart
    try {
      await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, code);
    } catch (error) {
      if (__DEV__) console.warn('[translate] could not save language', error);
    }
    // Picking a language IS the user asking for its model; start the download.
    return ensureLanguageReady(code, { requireWifi });
  }, []);

  const value = useMemo(
    () => ({ language, setLanguage, ready, hasPreference }),
    [language, setLanguage, ready, hasPreference],
  );
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
 * an ARRAY of children, and translating that would mangle the interpolated
 * value — so arrays are rendered untouched. Split them instead:
 *   <Text>Hello</Text><Text ignore> {name}</Text>
 *
 * `from="auto"` makes the source language detected instead of assumed English.
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
