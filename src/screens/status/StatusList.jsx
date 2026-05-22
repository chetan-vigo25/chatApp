import { useCallback, useState, useEffect, useRef } from 'react';
import { View, Text, FlatList, TouchableOpacity, Image, StyleSheet, RefreshControl, Platform } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useDispatch, useSelector } from 'react-redux';
import { useTheme } from '../../contexts/ThemeContext';
import { fetchMyStatuses, fetchStatusFeed, addNewStatusFromSocket, removeStatusFromSocket } from '../../Redux/Reducer/Status/Status.reducer';
import { getSocket } from '../../Redux/Services/Socket/socket';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import SegmentedRing from '../../components/SegmentedRing';

const IS_IPAD = Platform.OS === 'ios' && Platform.isPad;

/**
 * Shows the first status's content as a small square thumbnail.
 * - image / video  → shows mediaUrl / thumbnailUrl
 * - text           → bgColor background + truncated text
 * - link           → OG image if available, else link icon bg
 * Falls back to a neutral dark tile when there's nothing to show.
 */
function StatusThumb({ status, style }) {
  if (!status) return <View style={[style, { backgroundColor: '#2A3942' }]} />;

  const firstItem  = status.mediaItems?.[0];
  const statusType = firstItem?.mediaType ?? (status.textContent ? 'text' : null);

  if (statusType === 'image' || statusType === 'video') {
    const uri = firstItem?.thumbnailUrl || firstItem?.mediaUrl;
    if (uri) {
      return (
        <Image source={{ uri }} style={[style, { resizeMode: 'cover' }]} />
      );
    }
  }

  if (statusType === 'text') {
    return (
      <View style={[style, { backgroundColor: status.bgColor || '#075e54', justifyContent: 'center', alignItems: 'center', overflow: 'hidden', padding: 3 }]}>
        <Text style={{ color: '#fff', fontSize: 8, textAlign: 'center', lineHeight: 10 }} numberOfLines={3}>
          {status.textContent}
        </Text>
      </View>
    );
  }

  if (statusType === 'link') {
    const ogImage = status.ogMetadata?.image;
    if (ogImage) return <Image source={{ uri: ogImage }} style={[style, { resizeMode: 'cover' }]} />;
    return (
      <View style={[style, { backgroundColor: '#1a3a5c', justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ fontSize: 16 }}>🔗</Text>
      </View>
    );
  }

  return <View style={[style, { backgroundColor: '#2A3942' }]} />;
}

const timeAgo = (date) => {
  if (!date) return '';
  const diff = Date.now() - new Date(date).getTime();
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return 'Yesterday';
};

export default function StatusList({ navigation }) {
  const { theme } = useTheme();
  const dispatch = useDispatch();
  const { myStatuses, contactStatuses, viewedStatusIds, isLoading } = useSelector(state => state.status);
  const { user } = useSelector(state => state.authentication);
  const [refreshing, setRefreshing] = useState(false);
  const socketListenerRef = useRef(null);

  const loadData = useCallback(() => {
    dispatch(fetchMyStatuses());
    dispatch(fetchStatusFeed());
  }, [dispatch]);

  useFocusEffect(useCallback(() => { loadData(); }, [loadData]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([dispatch(fetchMyStatuses()), dispatch(fetchStatusFeed())]);
    setRefreshing(false);
  }, [dispatch]);

  // ── Socket: real-time status:new / status:deleted ──────────────────────────
  useEffect(() => {
    const attachListeners = () => {
      const socket = getSocket?.();
      if (!socket || socketListenerRef.current === socket) return;

      const onStatusNew = (payload) => {
        dispatch(addNewStatusFromSocket(payload));
      };
      const onStatusDeleted = (payload) => {
        dispatch(removeStatusFromSocket(payload));
      };

      socket.on('status:new', onStatusNew);
      socket.on('status:deleted', onStatusDeleted);

      socketListenerRef.current = socket;

      return () => {
        socket.off('status:new', onStatusNew);
        socket.off('status:deleted', onStatusDeleted);
      };
    };

    const cleanup = attachListeners();

    // Retry attachment every 2s until socket is available
    const interval = setInterval(() => {
      if (!socketListenerRef.current) attachListeners();
    }, 2000);

    return () => {
      clearInterval(interval);
      if (cleanup) cleanup();
      socketListenerRef.current = null;
    };
  }, [dispatch]);
  // ──────────────────────────────────────────────────────────────────────────

  const hasMyStatus = myStatuses && myStatuses.length > 0;

  const renderMyStatus = () => (
    <TouchableOpacity
      style={[styles.statusItem, { backgroundColor: theme.colors.cardBackground }]}
      onPress={() => hasMyStatus
        ? navigation.navigate('StatusViewer', { statuses: myStatuses, startIndex: 0, isMine: true })
        : navigation.navigate('StatusCreate')
      }
    >
      <View style={styles.avatarContainer}>
        {hasMyStatus ? (
          <View style={styles.ringWrap}>
            <SegmentedRing
              count={myStatuses.length}
              viewedCount={0}
              size={58}
              strokeWidth={2.5}
            />
            <StatusThumb status={myStatuses[0]} style={[styles.avatar, styles.avatarAbsolute]} />
          </View>
        ) : (
          <View style={styles.ringWrap}>
            <Image
              source={user?.profileImage ? { uri: user.profileImage } : require('../../../assets/icon.png')}
              style={styles.avatar}
            />
            <View style={[styles.addButton, { backgroundColor: theme.colors.themeColor }]}>
              <Ionicons name="add" size={16} color="#fff" />
            </View>
          </View>
        )}
      </View>
      <View style={styles.textContainer}>
        <Text style={[styles.name, { color: theme.colors.primaryTextColor }]}>My Status</Text>
        <Text style={[styles.time, { color: theme.colors.placeHolderTextColor }]}>
          {hasMyStatus
            ? `${myStatuses.length} status${myStatuses.length > 1 ? 'es' : ''} • ${timeAgo(myStatuses[0]?.createdAt)}`
            : 'Tap to add status update'}
        </Text>
      </View>
      {hasMyStatus && (
        <TouchableOpacity style={styles.cameraBtn} onPress={() => navigation.navigate('StatusCreate')}>
          <Ionicons name="camera" size={22} color={theme.colors.themeColor} />
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );

  const renderContactStatus = ({ item }) => {
    const statusCount  = item.count || item.statuses?.length || 0;
    // Backend returns `name` and `avatar`; fall back to legacy aliases just in case
    const displayName  = item.name || item.fullName || 'Unknown';
    const displayImage = item.avatar || item.profileImage;

    return (
      <TouchableOpacity
        style={[styles.statusItem, { backgroundColor: theme.colors.cardBackground }]}
        onPress={() => navigation.navigate('StatusViewer', {
          statuses:  item.statuses || [],
          startIndex: 0,
          isMine:    false,
          userName:  displayName,
          userImage: displayImage,
          userId:    item.userId,
        })}
      >
        <View style={styles.avatarContainer}>
          <View style={styles.ringWrap}>
            <SegmentedRing
              count={statusCount}
              viewedCount={(item.statuses || []).filter(s => viewedStatusIds.includes(String(s._id))).length}
              size={58}
              strokeWidth={2.5}
            />
            <StatusThumb status={(item.statuses || [])[0]} style={[styles.avatar, styles.avatarAbsolute]} />
          </View>
        </View>
        <View style={styles.textContainer}>
          <Text style={[styles.name, { color: theme.colors.primaryTextColor }]}>{displayName}</Text>
          <Text style={[styles.time, { color: theme.colors.placeHolderTextColor }]}>
            {timeAgo(item.latestAt)}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: '#fff' }]}>Status</Text>
      </View>

      <FlatList
        data={(contactStatuses || []).slice().sort((a, b) => {
          const aViewed = a.allViewed || (a.statuses || []).every(s => viewedStatusIds.includes(String(s._id)));
          const bViewed = b.allViewed || (b.statuses || []).every(s => viewedStatusIds.includes(String(s._id)));
          if (aViewed !== bViewed) return aViewed ? 1 : -1;
          return new Date(b.latestAt) - new Date(a.latestAt);
        })}
        keyExtractor={(item) => String(item.userId || item._id)}
        ListHeaderComponent={() => (
          <View>
            {renderMyStatus()}
            {(contactStatuses || []).length > 0 && (
              <Text style={[styles.sectionTitle, { color: theme.colors.placeHolderTextColor }]}>Recent updates</Text>
            )}
          </View>
        )}
        renderItem={renderContactStatus}
        ListEmptyComponent={() => (
          !isLoading && (
            <View style={styles.emptyContainer}>
              <View style={[styles.emptyIconCircle, { backgroundColor: theme.colors.themeColor + '22' }]}>
                <MaterialCommunityIcons name="message-image-outline" size={48} color={theme.colors.themeColor} />
              </View>
              <Text style={[styles.emptyText, { color: theme.colors.primaryTextColor }]}>
                No status updates yet
              </Text>
              <Text style={[styles.emptySubText, { color: theme.colors.placeHolderTextColor }]}>
                When your contacts share photos, videos, or text updates, they'll appear here for 24 hours.
              </Text>
              <TouchableOpacity
                style={[styles.emptyCta, { backgroundColor: theme.colors.themeColor }]}
                onPress={() => navigation.navigate('StatusCreate')}
              >
                <Ionicons name="camera" size={18} color="#fff" />
                <Text style={styles.emptyCtaText}>Share your first status</Text>
              </TouchableOpacity>
            </View>
          )
        )}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.themeColor} />}
        contentContainerStyle={styles.listContent}
      />

      {/* FAB */}
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: theme.colors.themeColor }]}
        onPress={() => navigation.navigate('StatusCreate')}
      >
        <Ionicons name="camera" size={24} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingTop: 0, paddingBottom: 16, paddingHorizontal: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerTitle: { fontSize: 20, fontWeight: '700' },
  headerActions: { flexDirection: 'row', gap: 16 },
  headerBtn: { padding: 4 },
  listContent: {
    paddingBottom: 80,
    ...(IS_IPAD ? { maxWidth: 640, width: '100%', alignSelf: 'center' } : null),
  },
  statusItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, minHeight: 72 },
  avatarContainer: { marginRight: 16 },
  avatar: { width: 50, height: 50, borderRadius: 25 },
  ringWrap: { width: 58, height: 58, alignItems: 'center', justifyContent: 'center', position: 'relative' },
  avatarAbsolute: { position: 'absolute', width: 50, height: 50, borderRadius: 25 },
  statusRingOuter: { width: 56, height: 56, borderRadius: 28, borderWidth: 2.5, padding: 2, alignItems: 'center', justifyContent: 'center' },
  statusRing: { position: 'absolute', bottom: -2, right: -2, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' },
  statusCount: { fontSize: 10, fontWeight: '700', color: '#fff' },
  addButton: { position: 'absolute', bottom: -2, right: -2, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' },
  textContainer: { flex: 1 },
  name: { fontSize: 15, fontWeight: '600', marginBottom: 3 },
  time: { fontSize: 13 },
  rowTimestamp: { fontSize: 12, alignSelf: 'flex-start', paddingTop: 2 },
  cameraBtn: { padding: 8 },
  sectionTitle: { fontSize: 13, fontWeight: '600', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  emptyContainer: { alignItems: 'center', paddingTop: 80, paddingHorizontal: 40, maxWidth: 420, alignSelf: 'center' },
  emptyIconCircle: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  emptyText: { fontSize: 18, fontWeight: '700', marginTop: 4 },
  emptySubText: { fontSize: 14, marginTop: 8, textAlign: 'center', lineHeight: 20 },
  emptyCta: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 24, marginTop: 24 },
  emptyCtaText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  fab: { position: 'absolute', bottom: 24, right: 20, width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', elevation: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6 },
});
