// Lightweight, self-contained link-preview (Open Graph) fetcher for chat
// messages. WhatsApp-style: when a message contains a URL we fetch the page's
// <head>, parse its og:/twitter:/<title> tags, and render a small card.
//
// Design notes:
//  - Pure client-side (no backend endpoint exists). Best-effort: if a site
//    blocks non-browser fetches, needs JS, or times out, we simply show no card.
//  - Module-level cache keyed by URL so a given link is fetched ONCE across every
//    message/render (the chat list re-renders rows constantly). A `null` cache
//    entry means "resolved, but no preview" — so we never refetch a dead link.
//  - In-flight de-dup so two messages with the same URL share one request.

const CACHE = new Map();     // url -> previewObject | null (null = no preview)
const INFLIGHT = new Map();  // url -> Promise<previewObject|null>
const MAX_CACHE = 300;
const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 300 * 1024; // the <head> is all we need — cap huge pages

// Matches the FIRST http(s)://, www., or bare-domain URL in a string. Kept close
// to the in-chat linkifier so the preview targets the same link the user taps.
const URL_RE = /(https?:\/\/[^\s]+|www\.[^\s]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|org|net|in|io|co|info|biz|app|dev|me|ai|xyz|online|site|tech|store|link|live|news|blog|shop|gov|edu)(?:\/[^\s]*)?)/i;

export const extractFirstLink = (text) => {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(URL_RE);
  if (!m) return null;
  // Trim trailing punctuation that commonly abuts a URL in prose.
  let raw = m[0].replace(/[)\]}.,;!?'"]+$/, '');
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^www\./i.test(raw)) return `https://${raw}`;
  return `https://${raw}`; // bare domain → default to https
};

const decodeEntities = (s = '') => String(s)
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
  .replace(/&nbsp;/g, ' ');

// Pull the first matching group across a list of alternative meta-tag patterns
// (attribute order varies wildly between sites, so we try both orders).
const firstMatch = (html, patterns) => {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      const val = decodeEntities(m[1].trim());
      if (val) return val;
    }
  }
  return '';
};

// Resolve a possibly-relative image URL against the page URL, without depending
// on a URL polyfill being present.
const absolutize = (maybeUrl, base) => {
  if (!maybeUrl) return '';
  if (/^https?:\/\//i.test(maybeUrl)) return maybeUrl;
  if (maybeUrl.startsWith('//')) return `https:${maybeUrl}`;
  const m = String(base || '').match(/^(https?:\/\/[^/]+)/i);
  const origin = m ? m[1] : '';
  if (!origin) return maybeUrl;
  return maybeUrl.startsWith('/') ? origin + maybeUrl : `${origin}/${maybeUrl}`;
};

const parseHtml = (html, finalUrl) => {
  const title = firstMatch(html, [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']*)["']/i,
    /<title[^>]*>([^<]+)<\/title>/i,
  ]);
  const description = firstMatch(html, [
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']*)["']/i,
  ]);
  let image = firstMatch(html, [
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']*)["']/i,
  ]);
  const siteName = firstMatch(html, [
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i,
  ]);
  image = absolutize(image, finalUrl);
  if (!title && !image) return null; // nothing worth showing
  return { url: finalUrl, title, description, image, siteName };
};

const setCache = (url, val) => {
  if (CACHE.size >= MAX_CACHE) {
    const first = CACHE.keys().next().value;
    if (first != null) CACHE.delete(first);
  }
  CACHE.set(url, val);
};

// Synchronous cache peek: returns the preview object, `null` (resolved-no-preview)
// or `undefined` (never fetched). Lets the card render instantly when cached.
export const getCachedLinkPreview = (url) => (url && CACHE.has(url) ? CACHE.get(url) : undefined);

export const fetchLinkPreview = (url) => {
  if (!url) return Promise.resolve(null);
  if (CACHE.has(url)) return Promise.resolve(CACHE.get(url));
  if (INFLIGHT.has(url)) return INFLIGHT.get(url);

  const p = (async () => {
    let timer = null;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          // A browser-ish UA — some sites serve no OG tags to unknown agents.
          'User-Agent': 'Mozilla/5.0 (compatible; TalksTryLinkPreview/1.0)',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: controller.signal,
      });
      const ct = res.headers?.get?.('content-type') || '';
      if (!res.ok || (ct && !/text\/html|application\/xhtml|text\/plain/i.test(ct))) {
        setCache(url, null);
        return null;
      }
      let html = await res.text();
      if (html.length > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES);
      const data = parseHtml(html, res.url || url);
      setCache(url, data);
      return data;
    } catch (_e) {
      setCache(url, null); // cache the failure so we don't hammer a dead link
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      INFLIGHT.delete(url);
    }
  })();

  INFLIGHT.set(url, p);
  return p;
};
