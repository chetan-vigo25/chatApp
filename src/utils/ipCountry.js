import countryCodes from '../jsonFile/countryCodes.json';

// Resolve the country the user's CURRENT network/IP is in. Unlike the SIM/locale
// or the registered phone number, this FOLLOWS A VPN — connecting to a US VPN
// server makes it resolve to the United States. Matches the resolved country
// against the bundled countryCodes catalogue (by name first, then calling code);
// returns null when it can't resolve or the country isn't in the catalogue.
//
// Result is cached for the app session after the first successful lookup (so we
// don't hit the geo API on every screen). Changing VPN mid-session therefore
// needs an app restart to re-detect.

let _cached = null;
let _inflight = null;

const normDial = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.startsWith('+') ? s : `+${s}`;
};

const matchCountry = ({ callingCode, countryName }) => {
  // Name match is the most precise (avoids +1 → US/Canada ambiguity).
  if (countryName) {
    const n = String(countryName).trim().toLowerCase();
    const byName = countryCodes.find((c) => c.name.toLowerCase() === n);
    if (byName) return byName;
  }
  const dial = normDial(callingCode);
  if (dial) {
    const byDial = countryCodes.find((c) => c.code === dial);
    if (byDial) return byDial;
  }
  return null;
};

// Two free, key-less, HTTPS geo-IP providers — the second is a fallback if the
// first is rate-limited or blocked on the current network.
const PROVIDERS = [
  { url: 'https://ipapi.co/json/', parse: (d) => ({ callingCode: d?.country_calling_code, countryName: d?.country_name }) },
  { url: 'https://ipwho.is/',      parse: (d) => ({ callingCode: d?.calling_code,          countryName: d?.country }) },
];

const fetchJsonWithTimeout = async (url, ms = 6000) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

export const detectIpCountry = async () => {
  if (_cached) return _cached;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    for (const p of PROVIDERS) {
      try {
        const data = await fetchJsonWithTimeout(p.url);
        const match = matchCountry(p.parse(data));
        if (match) { _cached = match; return match; }
      } catch (_) { /* try the next provider */ }
    }
    return null;
  })();
  try {
    return await _inflight;
  } finally {
    _inflight = null;
  }
};

// Synchronous read of an already-resolved country (or null) — lets a screen seed
// its initial state without waiting when the lookup already ran this session.
export const getCachedIpCountry = () => _cached;
