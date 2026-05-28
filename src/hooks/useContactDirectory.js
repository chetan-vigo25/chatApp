import { useEffect, useState, useCallback, useRef } from 'react';
import ContactDatabase from '../services/ContactDatabase';

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
    // Also index by normalized phone so we can resolve when only a number
    // is available (e.g. status snapshot with no userId on the link).
    const phone = c.normalizedPhone || c.phone || c.number;
    if (phone) map[`p:${String(phone).replace(/\D/g, '')}`] = c;
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

/** Format a raw phone string for display ("+91 98765 43210"). */
const formatPhone = (raw) => {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';
  // Already formatted (contains spaces or starts with +) → use as-is
  if (/[\s()-]/.test(s)) return s;
  if (s.startsWith('+')) {
    // Try to split country code (1-3 digits after +) and rest
    const m = s.match(/^(\+\d{1,3})(\d+)$/);
    if (m) {
      const rest = m[2].replace(/(\d{5})(\d+)/, '$1 $2'); // crude split
      return `${m[1]} ${rest}`;
    }
  }
  return s;
};

/**
 * Resolve a display label for a user.
 *  • Saved contact   → fullName
 *  • Unsaved + phone → formatted phone number
 *  • Otherwise       → fallbackName (server-provided name, profile name, etc.)
 */
export const resolveDisplayName = (directory, userId, fallbackName, phone) => {
  if (directory && userId) {
    const c = directory[String(userId)];
    if (c?.fullName && c.fullName.trim()) return c.fullName.trim();
  }
  if (directory && phone) {
    const key = `p:${String(phone).replace(/\D/g, '')}`;
    const c = directory[key];
    if (c?.fullName && c.fullName.trim()) return c.fullName.trim();
  }
  // No saved name — prefer the phone number over any server-side display name
  // because the user asked for "number shown if not saved".
  const formatted = formatPhone(phone);
  if (formatted) return formatted;
  if (fallbackName && String(fallbackName).trim()) return String(fallbackName).trim();
  return 'Unknown';
};

export default function useContactDirectory() {
  const [directory, setDirectory] = useState(_cachedDirectory || {});
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    loadDirectory().then((d) => {
      if (mountedRef.current) setDirectory(d);
    });
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    const d = await loadDirectory(true);
    if (mountedRef.current) setDirectory(d);
    return d;
  }, []);

  const resolveName = useCallback(
    (userId, fallbackName, phone) =>
      resolveDisplayName(directory, userId, fallbackName, phone),
    [directory]
  );

  return { directory, resolveName, refresh };
}
