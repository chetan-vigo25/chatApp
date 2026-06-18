import { useEffect, useMemo, useState } from 'react';
import ChatDatabase from '../../services/ChatDatabase';
import { formatLastSeen, getStatusColor } from '../services/lastSeenFormatter.service';
import { STATUS_TYPES } from '../constants';
import useUserPresence from './useUserPresence';

// SQLite-backed presence hook. Hydrates from the on-device presence_cache so the
// UI renders last-known status instantly (even while offline), then layers the
// live socket presence (via useUserPresence) on top once it arrives. The live
// values are persisted back to SQLite by the socket layer (persistPresenceEvent),
// so this hook only needs to read the cache for cold start.
//
// Mirrors the chat-website usePresence API: { status, lastSeen, isOnline, ... }.
export default function usePresence(userId) {
  const [cached, setCached] = useState(null);
  const live = useUserPresence(userId);

  useEffect(() => {
    let active = true;
    if (!userId) {
      setCached(null);
      return undefined;
    }
    ChatDatabase.getPresenceCache(String(userId))
      .then((row) => {
        if (active && row) setCached(row);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [userId]);

  return useMemo(() => {
    // Prefer the live value when present; fall back to the SQLite cache.
    const liveStatus = live?.presence?.status || null;
    const status = liveStatus || cached?.status || STATUS_TYPES.OFFLINE;
    const lastSeen = live?.presence?.lastSeen ?? cached?.lastSeen ?? null;

    return {
      status,
      lastSeen,
      isOnline: status === STATUS_TYPES.ONLINE,
      lastSeenFormatted: formatLastSeen(lastSeen, status),
      statusColor: getStatusColor(status),
      isLoading: live?.isLoading && !cached,
      fromCache: !liveStatus && !!cached,
      refresh: live?.refresh,
    };
  }, [live, cached]);
}
