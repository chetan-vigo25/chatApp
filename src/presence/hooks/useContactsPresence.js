import { useMemo, useState } from 'react';
import { usePresenceStore } from '../store/PresenceContext';
import * as socketService from '../services/presenceSocket.service';
import { getStatusPriority } from '../services/lastSeenFormatter.service';

export default function useContactsPresence() {
  const { state, actions } = usePresenceStore();
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [sortCriteria, setSortCriteria] = useState('status');

  const refresh = async () => {
    setIsRefreshing(true);
    try {
      const response = await socketService.emitGetContactsPresence();
      const rows = response?.data?.users || response?.data || response?.users || [];
      const map = {};

      if (Array.isArray(rows)) {
        rows.forEach((row) => {
          const source = row?.presence || row?.userPresence || row;
          const userId = row?.userId || row?.id || source?.userId || source?.id;
          if (!userId) return;
          map[userId] = {
            ...source,
            status: (source?.status || source?.presenceStatus || source?.effectiveStatus || source?.manualStatus || 'offline')
              .toString()
              .toLowerCase(),
            customStatus: source?.customStatus || source?.manualCustomStatus || null,
            lastSeen: source?.lastSeen || source?.last_seen || null,
          };
        });
      }

      actions.setContactsPresence(map);
      return response;
    } finally {
      setIsRefreshing(false);
    }
  };

  const contacts = useMemo(() => {
    const entries = Object.keys(state.contactsPresence).map((userId) => ({
      userId,
      presence: state.contactsPresence[userId],
    }));

    const sorted = [...entries].sort((a, b) => {
      if (sortCriteria === 'status') {
        return getStatusPriority(a.presence.status) - getStatusPriority(b.presence.status);
      }
      if (sortCriteria === 'lastSeen') {
        return Number(b.presence.lastSeen || 0) - Number(a.presence.lastSeen || 0);
      }
      return String(a.userId).localeCompare(String(b.userId));
    });

    return sorted;
  }, [state.contactsPresence, sortCriteria]);

  const getByStatus = (status) => contacts.filter((item) => item.presence.status === status);
  const search = (query) => contacts.filter((item) => String(item.userId).toLowerCase().includes(query.toLowerCase()));
  const sortBy = (criteria) => setSortCriteria(criteria);

  return {
    contacts,
    onlineCount: state.ui.onlineContactsCount,
    awayCount: getByStatus('away').length,
    busyCount: getByStatus('busy').length,
    offlineCount: getByStatus('offline').length,
    totalCount: state.ui.totalContactsCount,
    isLoading,
    isRefreshing,
    refresh,
    getByStatus,
    search,
    sortBy,
  };
}
