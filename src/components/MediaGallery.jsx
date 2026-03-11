import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import useMediaGallery from '../hooks/useMediaGallery';

const CATEGORIES = [
  { label: 'All', value: null },
  { label: 'Images', value: 'image' },
  { label: 'Videos', value: 'video' },
  { label: 'Docs', value: 'document' },
];

export default function MediaGallery({ chatId, onOpenMedia }) {
  const [category, setCategory] = useState(null);
  const { items, loading, refreshing, error, hasMore, loadInitial, refresh, loadMore } = useMediaGallery({
    chatId,
    category,
    limit: 24,
  });

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  const grouped = useMemo(() => items, [items]);

  return (
    <View style={styles.container}>
      <View style={styles.tabs}>
        {CATEGORIES.map((tab) => {
          const active = category === tab.value;
          return (
            <Pressable key={tab.label} onPress={() => setCategory(tab.value)} style={[styles.tab, active && styles.tabActive]}>
              <Text style={[styles.tabText, active && styles.tabTextActive]}>{tab.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {error ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <FlatList
        data={grouped}
        keyExtractor={(item, index) => String(item?.mediaId || item?.id || index)}
        numColumns={3}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (hasMore && !loading) loadMore();
        }}
        renderItem={({ item }) => {
          const type = (item?.messageType || item?.fileCategory || '').toLowerCase();
          const uri = item?.thumbnailUrl || item?.previewUrl || item?.localPath || item?.serverUrl;
          const isVideo = type === 'video';
          const isDoc = type === 'document' || type === 'file';
          return (
            <Pressable style={styles.cell} onPress={() => onOpenMedia?.(item)}>
              {uri ? (
                <Image source={{ uri }} style={styles.image} />
              ) : (
                <View style={[styles.image, styles.placeholder]}>
                  <Ionicons name={isDoc ? 'document-text' : 'image-outline'} size={24} color="#fff" />
                </View>
              )}
              {isVideo ? (
                <View style={styles.videoBadge}>
                  <Ionicons name="play" size={14} color="#fff" />
                </View>
              ) : null}
            </Pressable>
          );
        }}
        ListEmptyComponent={
          loading ? (
            <View style={styles.emptyWrap}><Text style={styles.emptyText}>Loading media…</Text></View>
          ) : (
            <View style={styles.emptyWrap}><Text style={styles.emptyText}>No media found</Text></View>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111' },
  tabs: { flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 10, gap: 8 },
  tab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: '#222',
  },
  tabActive: { backgroundColor: '#25D366' },
  tabText: { color: '#bbb', fontSize: 12 },
  tabTextActive: { color: '#fff', fontWeight: '700' },
  cell: { width: '33.33%', aspectRatio: 1, padding: 1 },
  image: { width: '100%', height: '100%', backgroundColor: '#222' },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
  videoBadge: {
    position: 'absolute',
    right: 5,
    bottom: 5,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 40 },
  emptyText: { color: '#aaa' },
  errorWrap: { paddingHorizontal: 12, paddingBottom: 8 },
  errorText: { color: '#ffb4b4' },
});