import { useEffect, useState, useCallback, useRef } from 'react';
import ContactDatabase from '../services/ContactDatabase';
import { onlyDigits } from '../utils/savedContactName';
import {
  resolveDisplayName as resolveCanonicalName,
  subscribeContactNames,
  loadContactNames,
  invalidateContactNames,
  getContactNamesVersion,
} from '../services/contactNameStore';

/**
 * useContactDirectory
 * ───────────────────
 * Builds a userId → saved-contact map from the local ContactDatabase and
 * exposes a `resolveName(userId, fallbackName, phone)` helper that returns
 * the locally-saved name when available, otherwise the phone number, and
 * finally falls back to the supplied `fallbackName`.
 *
 *   const { resolveName } = useContactDirectory();
 *   const label = resolveName(item.userId, item.name, item.phone);
 *
 * The directory is loaded once on mount and refreshed when the screen is
 * focused again (caller can invoke `refresh()` to force re-read).
 *
 * The map is also cached on the module level so multiple consumers don't
 * re-hit SQLite for every render.
 */

let _cachedDirectory = null;       // userId → contact row
let _cachedAt        = 0;
const CACHE_TTL_MS   = 30_000;     // 30s — fine for status list / chat use

const buildDirectory = (rows) => {
  const map = {};
  for (const c of rows || []) {
    if (!c) continue;
    const uid = c.userId ? String(c.userId) : null;
    if (uid) map[uid] = c;
    // Index by the contact HASH — the canonical join key. Lets us match a
    // sender/member by re-hashing their phone number even when the saved
    // contact row never got a user_id from the backend.
    if (c.hash) map[`h:${String(c.hash).toLowerCase()}`] = c;
    // Also index by normalized phone so we can resolve when only a number
    // is available (e.g. status snapshot with no userId on the link).
    const phone = c.normalizedPhone || c.phone || c.number;
    if (phone) map[`p:${onlyDigits(phone)}`] = c;
  }
  return map;
};

const loadDirectory = async (force = false) => {
  if (!force && _cachedDirectory && (Date.now() - _cachedAt) < CACHE_TTL_MS) {
    return _cachedDirectory;
  }
  try {
    const rows = await ContactDatabase.loadAllContacts();
    _cachedDirectory = buildDirectory(rows);
    _cachedAt = Date.now();
  } catch {
    _cachedDirectory = _cachedDirectory || {};
  }
  return _cachedDirectory;
};

/**
 * Resolve a display label for a user.
 *
 * Thin adapter over the canonical resolver in services/contactNameStore.js so
 * every existing call site (status, calls, group sender lines) obeys the ONE
 * rule: saved contact name → phone number → (only if no number exists) the
 * server profile name. `fallbackName` is a server-provided name, i.e. a PUSH
 * name — it must never outrank the number.
 *
 * `directory` is accepted for signature compatibility; the canonical store owns
 * the lookup index now.
 */
export const resolveDisplayName = (directory, userId, fallbackName, phone) =>
  resolveCanonicalName({ userId, phone, pushName: fallbackName });

export default function useContactDirectory() {
  const [directory, setDirectory] = useState(_cachedDirectory || {});
  // Bumped by the canonical store whenever the address book changes, so screens
  // holding `resolveName` re-render with the new names (no restart / re-open).
  const [namesVersion, setNamesVersion] = useState(getContactNamesVersion());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    loadDirectory().then((d) => {
      if (mountedRef.current) setDirectory(d);
    });
    loadContactNames();
    const unsubscribe = subscribeContactNames((v) => {
      if (!mountedRef.current) return;
      setNamesVersion(v);
      // Keep the legacy `directory` map (still read by GroupInfo) in step.
      loadDirectory(true).then((d) => { if (mountedRef.current) setDirectory(d); });
    });
    return () => { mountedRef.current = false; unsubscribe(); };
  }, []);

  const refresh = useCallback(async () => {
    const d = await loadDirectory(true);
    await invalidateContactNames();
    if (mountedRef.current) setDirectory(d);
    return d;
  }, []);

  const resolveName = useCallback(
    (userId, fallbackName, phone) =>
      resolveDisplayName(directory, userId, fallbackName, phone),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [namesVersion]
  );

  return { directory, resolveName, refresh, namesVersion };
}
