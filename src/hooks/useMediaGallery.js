import { useCallback, useMemo, useState } from 'react';
import localStorageService from '../services/LocalStorageService';
import mediaService from '../services/MediaService';

export default function useMediaGallery({ chatId, category = null, limit = 20 }) {
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(true);

  const mergeByMediaId = (existing, incoming) => {
    const map = new Map();
    [...existing, ...incoming].forEach((item) => {
      // Always use _id.$oid if present
      const key = item?._id?.$oid ? String(item._id.$oid) : String(item?.mediaId || item?.id || Math.random());
      const previous = map.get(key) || {};
      map.set(key, { ...previous, ...item, mediaId: key });
    });
    return Array.from(map.values()).sort((a, b) => Number(b?.createdAtTs || b?.createdAt || 0) - Number(a?.createdAtTs || a?.createdAt || 0));
  };

  const loadFromLocal = useCallback(async () => {
    const local = await localStorageService.getMediaFilesByChat(chatId);
    const filtered = category
      ? local.filter((item) => String(item?.messageType || item?.fileCategory) === String(category))
      : local;
    setItems(filtered);
    return filtered;
  }, [chatId, category]);

  const syncFromServer = useCallback(async (nextPage = 1, replace = false) => {
    const response = await mediaService.fetchAllFiles({
      category,
      chatId,
      page: nextPage,
      limit,
      groupByCategory: false,
    });

    const list = response?.data?.docs || response?.data || [];
    const normalized = (Array.isArray(list) ? list : []).map((entry) => ({
      ...entry,
      mediaId: entry?._id?.$oid ? String(entry._id.$oid) : String(entry?.mediaId || entry?._id || entry?.id),
      messageType: entry?.fileCategory || entry?.messageType,
      createdAtTs: new Date(entry?.createdAt || Date.now()).getTime(),
      _id: entry._id,
    }));

    for (const item of normalized) {
      await localStorageService.upsertMediaFile(item);
    }

    setItems((prev) => (replace ? normalized : mergeByMediaId(prev, normalized)));
    setHasMore(normalized.length >= limit);
    setPage(nextPage);
  }, [category, chatId, limit]);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError(null);
    console.log('[MEDIA:GALLERY:LOAD]', { chatId, category, source: 'local+api' });
    try {
      await loadFromLocal();
      await syncFromServer(1, true);
    } catch (err) {
      setError(err?.message || 'Failed to load gallery');
    } finally {
      setLoading(false);
    }
  }, [chatId, category, loadFromLocal, syncFromServer]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      await syncFromServer(1, true);
    } catch (err) {
      setError(err?.message || 'Failed to refresh gallery');
    } finally {
      setRefreshing(false);
    }
  }, [syncFromServer]);

  const loadMore = useCallback(async () => {
    if (loading || refreshing || !hasMore) return;
    try {
      await syncFromServer(page + 1, false);
    } catch (err) {
      setError(err?.message || 'Failed to load more');
    }
  }, [hasMore, loading, page, refreshing, syncFromServer]);

  return useMemo(() => ({
    items,
    loading,
    refreshing,
    error,
    page,
    hasMore,
    loadInitial,
    loadFromLocal,
    refresh,
    loadMore,
  }), [items, loading, refreshing, error, page, hasMore, loadInitial, loadFromLocal, refresh, loadMore]);
}
