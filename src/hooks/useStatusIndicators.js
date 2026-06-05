/**
 * useStatusIndicators
 *
 * Single source of truth for the Chat List status rings. It:
 *   1. Hydrates the persisted viewed-set + cached feed from SQLite (instant,
 *      offline cold-render) and then refreshes from the network (/status/feed,
 *      itself Redis-cached server-side) — i.e. data priority SQLite → Redis →
 *      MongoDB, exactly as required.
 *   2. Attaches the realtime status socket listeners (status:new / deleted /
 *      expired) so rings appear/disappear with no manual refresh.
 *   3. Exposes a memoised `userId → indicator` map derived from Redux state, so
 *      every consumer (ChatCard rings, avatar-tap routing) reads one consistent
 *      shape that updates instantly when a status is posted, viewed or expires.
 *
 * Indicator shape (per contact userId):
 *   {
 *     group,         // the full feed group (passed to the StatusViewer)
 *     count,         // total live statuses        → ring segment count
 *     viewedCount,   // how many the user has seen  → grey segments
 *     hasUnseen,     // ≥1 unseen                   → colour the ring
 *     allViewed,     // every status seen           → fully grey ring
 *   }
 */
import { useEffect, useMemo, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  fetchStatusFeed,
  hydrateStatusFeed,
  hydrateViewedStatusIds,
  addNewStatusFromSocket,
  removeStatusFromSocket,
} from '../Redux/Reducer/Status/Status.reducer';
import { getSocket } from '../Redux/Services/Socket/socket';

export default function useStatusIndicators() {
  const dispatch = useDispatch();
  const { contactStatuses, viewedStatusIds } = useSelector((s) => s.status);
  const socketRef = useRef(null);

  // ── Load: SQLite first (instant), then network refresh ──────────────────────
  useEffect(() => {
    dispatch(hydrateViewedStatusIds());
    dispatch(hydrateStatusFeed());
    dispatch(fetchStatusFeed());
  }, [dispatch]);

  // ── Realtime: keep the feed live even when the Status tab isn't mounted ──────
  useEffect(() => {
    const attach = () => {
      const socket = getSocket?.();
      if (!socket || socketRef.current === socket) return undefined;

      const onNew = (p) => dispatch(addNewStatusFromSocket(p));
      const onGone = (p) => dispatch(removeStatusFromSocket(p));

      // Canonical events use a colon; underscore variants are legacy aliases.
      socket.on('status:new', onNew);
      socket.on('new_status', onNew);
      socket.on('status:deleted', onGone);
      socket.on('status_deleted', onGone);
      socket.on('status_expired', onGone);
      socketRef.current = socket;

      return () => {
        socket.off('status:new', onNew);
        socket.off('new_status', onNew);
        socket.off('status:deleted', onGone);
        socket.off('status_deleted', onGone);
        socket.off('status_expired', onGone);
      };
    };

    const cleanup = attach();
    // The socket may connect slightly after this screen mounts — retry until set.
    const interval = setInterval(() => { if (!socketRef.current) attach(); }, 2000);
    return () => {
      clearInterval(interval);
      cleanup?.();
      socketRef.current = null;
    };
  }, [dispatch]);

  // ── Derive the userId → indicator map ───────────────────────────────────────
  const statusByUserId = useMemo(() => {
    const viewedSet = new Set((viewedStatusIds || []).map(String));
    const map = {};
    for (const group of contactStatuses || []) {
      const statuses = group?.statuses || [];
      const uid = String(group?.userId || group?._id || '');
      if (!uid || statuses.length === 0) continue;

      const viewedCount = statuses.filter((s) => viewedSet.has(String(s._id))).length;
      const count = statuses.length;
      map[uid] = {
        group,
        count,
        viewedCount,
        hasUnseen: viewedCount < count,
        allViewed: viewedCount >= count,
      };
    }
    return map;
  }, [contactStatuses, viewedStatusIds]);

  return statusByUserId;
}
