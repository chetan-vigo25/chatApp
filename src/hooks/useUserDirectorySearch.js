import { useEffect, useMemo, useRef, useState } from 'react';
import {
  searchDirectory,
  isSearchableQuery,
  normalizeQuery,
  peekDirectoryCache,
} from '../Redux/Services/Contact/Directory.Services';

/**
 * Debounced directory lookup for the contact / member pickers.
 *
 * Returns registered users matching the query by @username or mobile number —
 * people who are NOT in the device phonebook and therefore never appeared in a
 * picker before. Pass `excludeIds` for everyone the local list already offers so
 * nobody is shown twice.
 *
 * What keeps this cheap while someone types:
 *   • ONE request per typing pause (debounce), never per keystroke.
 *   • The effect is keyed on the NORMALIZED query, so "@Raj" → "raj" and
 *     "+91 774 247" → "91774247" don't each buy their own round trip.
 *   • A cached answer (30s) paints during render — no request, no flicker.
 *   • A stale response can never overwrite a newer one (sequence guard).
 *   • Results are HELD while the next query is in flight, so the list doesn't
 *     blank out between two keystroke pauses.
 *
 * @param {string} query   raw search text
 * @param {object} opts    { enabled, excludeIds, delayMs }
 * @returns {{ results: Array, loading: boolean, searchable: boolean }}
 */
export default function useUserDirectorySearch(query, { enabled = true, excludeIds, delayMs = 350 } = {}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  // Which normalized query the current `rows` answer. Lets callers tell
  // "no results yet" (debounce still pending) apart from "no results".
  const [settledKey, setSettledKey] = useState('');
  const searchable = isSearchableQuery(query);
  const key = normalizeQuery(query);

  // The caller rebuilds its exclude set every render; holding it in a ref keeps
  // that from re-firing the request on each keystroke.
  const excludeRef = useRef(excludeIds);
  useEffect(() => { excludeRef.current = excludeIds; }, [excludeIds]);

  // Monotonic request id: only the newest lookup may write state, so a slow
  // answer for "ra" cannot land on top of the answer for "rahul".
  const seqRef = useRef(0);

  // Synchronous cache read: a query typed before (or already answered for this
  // very keystroke) renders its rows in the FIRST frame, with no request at all.
  const cached = (enabled && searchable) ? peekDirectoryCache(query) : null;

  useEffect(() => {
    if (!enabled || !searchable) return undefined;
    if (cached) { setRows(cached); setLoading(false); return undefined; }

    const seq = seqRef.current + 1;
    seqRef.current = seq;
    let alive = true;
    const timer = setTimeout(() => {
      // The spinner arms inside the debounce, not before it: flipping it on
      // every keystroke made the section flicker while no request was in flight.
      setLoading(true);
      searchDirectory(query)
        .then((users) => {
          if (!alive || seqRef.current !== seq) return;
          setRows(users);
          setSettledKey(key);
        })
        .catch(() => { if (alive && seqRef.current === seq) setSettledKey(key); })
        .finally(() => { if (alive && seqRef.current === seq) setLoading(false); });
    }, delayMs);
    return () => { alive = false; clearTimeout(timer); };
    // `key`, not `query`: re-typing the same lookup in a different shape is not
    // a new search. `cached` is read at effect time, deliberately not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, searchable, delayMs]);

  const source = cached || rows;
  const results = useMemo(() => {
    if (!enabled || !searchable) return [];
    const ex = excludeRef.current;
    const skip = ex instanceof Set ? ex : new Set((ex || []).map(String));
    return source.filter((u) => !skip.has(String(u.userId)));
    // excludeIds is read through the ref but listed so a changed set re-filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, enabled, searchable, excludeIds]);

  // DERIVED, not written from the effect: a query that just became too short
  // shows nothing on the same render, with no extra pass.
  const active = enabled && searchable;
  const settled = active && (Boolean(cached) || settledKey === key);
  return { results, loading: active && loading && !cached, searchable, settled };
}
