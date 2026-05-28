import { useCallback, useState, useEffect, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Image, StyleSheet,
  RefreshControl, Platform, Animated, Easing,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useDispatch, useSelector } from 'react-redux';
import { useTheme } from '../../contexts/ThemeContext';
import { fetchMyStatuses, fetchStatusFeed, addNewStatusFromSocket, removeStatusFromSocket, hydrateViewedStatusIds } from '../../Redux/Reducer/Status/Status.reducer';
import { getSocket } from '../../Redux/Services/Socket/socket';
import { Ionicons, MaterialCommunityIcons, Feather } from '@expo/vector-icons';
import SegmentedRing from '../../components/SegmentedRing';
import { STATUS_ACCENT } from './_statusDesign';
import useContactDirectory from '../../hooks/useContactDirectory';

const IS_IPAD = Platform.OS === 'ios' && Platform.isPad;

// ── Status thumbnail (image / video / text / link) ──────────────────────────
// Renders the latest status content as an avatar-sized tile. This sits inside
// the ring in place of the user's profile photo — matches WhatsApp's pattern
// where the ring previews the actual story content.
function StatusThumb({ status, style }) {
  if (!status) return <View style={[style, styles.thumbNeutral]} />;
  const firstItem  = status.mediaItems?.[0];
  const statusType = firstItem?.mediaType ?? (status.textContent ? 'text' : null);

  if ((statusType === 'image' || statusType === 'video') && (firstItem?.thumbnailUrl || firstItem?.mediaUrl)) {
    return <Image source={{ uri: firstItem.thumbnailUrl || firstItem.mediaUrl }} style={[style, styles.thumbCover]} />;
  }
  if (statusType === 'text') {
    return (
      <View style={[style, styles.thumbText, { backgroundColor: status.bgColor || '#075e54' }]}>
        <Text style={styles.thumbTextBody} numberOfLines={3}>
          {status.textContent}
        </Text>
      </View>
    );
  }
  if (statusType === 'link') {
    const ogImage = status.ogMetadata?.image;
    if (ogImage) return <Image source={{ uri: ogImage }} style={[style, styles.thumbCover]} />;
    return (
      <View style={[style, styles.thumbLink]}>
        <Feather name="link" size={16} color="#cbd5e1" />
      </View>
    );
  }
  return <View style={[style, styles.thumbNeutral]} />;
}

// ── Time helpers ─────────────────────────────────────────────────────────────
const timeAgo = (date) => {
  if (!date) return '';
  const diff = Date.now() - new Date(date).getTime();
  if (diff < 60_000)    return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) {
    const hrs = Math.floor(diff / 3_600_000);
    return `${hrs} hour${hrs > 1 ? 's' : ''} ago`;
  }
  return 'yesterday';
};

// ── Unseen pulse dot ─────────────────────────────────────────────────────────
function UnseenPulse({ visible }) {
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!visible) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.4, duration: 900, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1,   duration: 900, easing: Easing.in(Easing.quad),  useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [visible, scale]);
  if (!visible) return null;
  return (
    <View style={styles.pulseWrap} pointerEvents="none">
      <Animated.View style={[styles.pulseHalo, { transform: [{ scale }] }]} />
      <View style={styles.pulseDot} />
    </View>
  );
}

// ── Press scale micro-interaction ────────────────────────────────────────────
function PressScale({ children, onPress, style, scale = 0.985 }) {
  const v = useRef(new Animated.Value(1)).current;
  const to = useCallback((t) =>
    Animated.timing(v, { toValue: t, duration: 90, useNativeDriver: true }).start(), [v]);
  return (
    <Animated.View style={[{ transform: [{ scale: v }] }, style]}>
      <TouchableOpacity activeOpacity={1} onPress={onPress} onPressIn={() => to(scale)} onPressOut={() => to(1)}>
        {children}
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
export default function StatusList({ navigation }) {
  const { theme } = useTheme();
  const dispatch = useDispatch();
  const { myStatuses, contactStatuses, viewedStatusIds, isLoading } = useSelector(state => state.status);
  const { user } = useSelector(state => state.authentication);
  const [refreshing, setRefreshing] = useState(false);
  const socketListenerRef = useRef(null);
  const { resolveName, refresh: refreshContacts } = useContactDirectory();

  const loadData = useCallback(() => {
    dispatch(fetchMyStatuses());
    dispatch(fetchStatusFeed());
  }, [dispatch]);

  // Rehydrate the persisted viewed-set ONCE on mount so rings render with the
  // correct read/unread state immediately on cold open, before /feed resolves.
  useEffect(() => {
    dispatch(hydrateViewedStatusIds());
  }, [dispatch]);

  useFocusEffect(useCallback(() => {
    loadData();
    // Refresh contact directory on focus so newly-saved contact names appear
    // in the status list without needing an app restart.
    refreshContacts?.();
  }, [loadData, refreshContacts]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      dispatch(fetchMyStatuses()),
      dispatch(fetchStatusFeed()),
      refreshContacts?.(),
    ]);
    setRefreshing(false);
  }, [dispatch, refreshContacts]);

  // ── Socket: real-time status:new / status:deleted ──────────────────────────
  useEffect(() => {
    const attachListeners = () => {
      const socket = getSocket?.();
      if (!socket || socketListenerRef.current === socket) return;

      const onStatusNew = (payload) => dispatch(addNewStatusFromSocket(payload));
      const onStatusDeleted = (payload) => dispatch(removeStatusFromSocket(payload));

      socket.on('status:new', onStatusNew);
      socket.on('status:deleted', onStatusDeleted);
      socketListenerRef.current = socket;

      return () => {
        socket.off('status:new', onStatusNew);
        socket.off('status:deleted', onStatusDeleted);
      };
    };

    const cleanup = attachListeners();
    const interval = setInterval(() => { if (!socketListenerRef.current) attachListeners(); }, 2000);
    return () => { clearInterval(interval); if (cleanup) cleanup(); socketListenerRef.current = null; };
  }, [dispatch]);
  // ──────────────────────────────────────────────────────────────────────────

  const hasMyStatus = myStatuses && myStatuses.length > 0;

  // ── My Status row ──────────────────────────────────────────────────────────
  const renderMyStatus = () => {
    const onOpen = () => hasMyStatus
      ? navigation.navigate('StatusViewer', { statuses: myStatuses, startIndex: 0, isMine: true })
      : navigation.navigate('StatusCreate');

    return (
      <PressScale onPress={onOpen} style={styles.rowWrap}>
        <View style={styles.row}>
          <View style={styles.rowAvatar}>
            {hasMyStatus ? (
              <>
                <SegmentedRing
                  count={myStatuses.length}
                  viewedCount={myStatuses.length /* own ring treated as viewed */}
                  size={54}
                  strokeWidth={2.5}
                />
                {/* When user has a status, the ring previews the latest one
                    (image/video thumbnail, text tile, or link card) — matches
                    WhatsApp's pattern instead of showing a static avatar. */}
                <StatusThumb status={myStatuses[0]} style={styles.rowAvatarImg} />
              </>
            ) : (
              <>
                {/* Empty state — profile photo with a + badge */}
                {user?.profileImage ? (
                  <Image source={{ uri: user.profileImage }} style={styles.rowAvatarImg} />
                ) : (
                  <View style={[styles.rowAvatarImg, styles.rowAvatarFallback, { backgroundColor: theme.colors.themeColor }]}>
                    <Ionicons name="person" size={20} color="#fff" />
                  </View>
                )}
                <View style={[styles.rowAddDot, { backgroundColor: theme.colors.themeColor, borderColor: theme.colors.background }]}>
                  <Ionicons name="add" size={11} color="#fff" />
                </View>
              </>
            )}
          </View>

          <View style={styles.rowText}>
            <Text style={[styles.rowName, { color: theme.colors.primaryTextColor }]} numberOfLines={1}>
              My status
            </Text>
            <Text style={[styles.rowMeta, { color: theme.colors.placeHolderTextColor }]} numberOfLines={1}>
              {hasMyStatus
                ? `${timeAgo(myStatuses[0]?.createdAt) || 'recently'}${myStatuses.length > 1 ? `  ·  ${myStatuses.length} updates` : ''}`
                : 'Tap to add status update'}
            </Text>
          </View>
        </View>
      </PressScale>
    );
  };

  // ── Contact row — status thumbnail inside the ring ─────────────────────────
  const renderContactStatus = ({ item }) => {
    const statusCount  = item.count || item.statuses?.length || 0;
    // Prefer the locally-saved contact name; fall back to phone number when
    // the contact is not saved on this device, then to the server-side name.
    const serverName   = item.name || item.fullName;
    const phone        = item.phone || item.number || item.mobile?.number || item.mobileNumber;
    const displayName  = resolveName(item.userId, serverName, phone);
    const viewedCount  = (item.statuses || []).filter(s => viewedStatusIds.includes(String(s._id))).length;
    const allSeen      = viewedCount >= statusCount;

    const onOpen = () => navigation.navigate('StatusViewer', {
      statuses:  item.statuses || [],
      startIndex: 0,
      isMine:    false,
      userName:  displayName,
      userImage: item.avatar || item.profileImage,
      userId:    item.userId,
    });

    return (
      <PressScale onPress={onOpen} style={styles.rowWrap}>
        <View style={styles.row}>
          <View style={styles.rowAvatar}>
            <SegmentedRing count={statusCount} viewedCount={viewedCount} size={54} strokeWidth={2.5} />
            {/* Avatar slot is the LATEST STATUS PREVIEW, not the profile photo.
                Matches WhatsApp. */}
            <StatusThumb status={(item.statuses || [])[0]} style={styles.rowAvatarImg} />
            <UnseenPulse visible={!allSeen} />
          </View>

          <View style={styles.rowText}>
            <Text style={[styles.rowName, { color: theme.colors.primaryTextColor }]} numberOfLines={1}>
              {displayName}
            </Text>
            <Text style={[styles.rowMeta, { color: theme.colors.placeHolderTextColor }]} numberOfLines={1}>
              {timeAgo(item.latestAt) || 'recently'}
              {statusCount > 1 ? `  ·  ${statusCount} updates` : ''}
            </Text>
          </View>
        </View>
      </PressScale>
    );
  };

  // ── Section label above contacts ────────────────────────────────────────────
  const renderSectionLabel = (label) => (
    <Text style={[styles.sectionLabel, { color: theme.colors.placeHolderTextColor }]}>
      {label}
    </Text>
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Simple title row — WhatsApp style */}
      <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: theme.colors.primaryTextColor }]}>Status</Text>
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
            {(contactStatuses || []).length > 0 && renderSectionLabel('Recent updates')}
          </View>
        )}
        renderItem={renderContactStatus}
        ListEmptyComponent={() => (
          !isLoading && (
            hasMyStatus ? (
              <View style={styles.noRecentWrap}>
                <Text style={[styles.noRecentText, { color: theme.colors.placeHolderTextColor }]}>
                  No recent updates from your contacts yet.
                </Text>
              </View>
            ) : (
              <View style={styles.emptyContainer}>
                <View style={[styles.emptyIcon, { backgroundColor: `${theme.colors.themeColor}22` }]}>
                  <MaterialCommunityIcons name="message-image-outline" size={42} color={theme.colors.themeColor} />
                </View>
                <Text style={[styles.emptyTitle, { color: theme.colors.primaryTextColor }]}>
                  No status updates
                </Text>
                <Text style={[styles.emptySubText, { color: theme.colors.placeHolderTextColor }]}>
                  Status updates from your contacts will appear here and disappear after 24 hours.
                </Text>
                <TouchableOpacity
                  style={[styles.emptyCta, { backgroundColor: theme.colors.themeColor }]}
                  activeOpacity={0.85}
                  onPress={() => navigation.navigate('StatusCreate')}
                >
                  <Ionicons name="camera" size={16} color="#fff" />
                  <Text style={styles.emptyCtaText}>Add status</Text>
                </TouchableOpacity>
              </View>
            )
          )
        )}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.colors.themeColor}
          />
        }
        contentContainerStyle={styles.listContent}
      />

      {/* Floating compose — WhatsApp-style FAB (camera) */}
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: theme.colors.themeColor }]}
        activeOpacity={0.85}
        onPress={() => navigation.navigate('StatusCreate')}
        accessibilityLabel="New status"
      >
        <Ionicons name="camera" size={22} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1 },

  // Header — clean WhatsApp title
  header: {
    paddingHorizontal: 18,
    paddingTop: 6,
    paddingBottom: 12,
  },
  headerTitle: { fontSize: 22, fontWeight: '700', letterSpacing: -0.2 },

  // List body
  listContent: {
    paddingBottom: 100,
    ...(IS_IPAD ? { maxWidth: 680, width: '100%', alignSelf: 'center' } : null),
  },

  // Section label
  sectionLabel: {
    fontSize: 13, fontWeight: '600',
    paddingHorizontal: 18,
    paddingTop: 14, paddingBottom: 6,
    letterSpacing: 0.2,
  },

  // ── Row ──────────────────────────────────────────────────────────────────
  rowWrap: { paddingHorizontal: 18 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10,
    gap: 14,
  },
  rowAvatar:    { width: 54, height: 54, alignItems: 'center', justifyContent: 'center', position: 'relative' },
  rowAvatarImg: { width: 44, height: 44, borderRadius: 22, position: 'absolute', overflow: 'hidden' },
  rowAvatarFallback: { alignItems: 'center', justifyContent: 'center' },
  rowAddDot: {
    position: 'absolute', bottom: 0, right: 0,
    width: 18, height: 18, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2,
  },
  rowText:      { flex: 1, minWidth: 0 },
  rowName:      { fontSize: 15, fontWeight: '600', marginBottom: 2 },
  rowMeta:      { fontSize: 13 },

  // Pulse for unseen
  pulseWrap: {
    position: 'absolute', top: -2, right: -2,
    width: 14, height: 14, alignItems: 'center', justifyContent: 'center',
  },
  pulseHalo: {
    position: 'absolute', width: 14, height: 14, borderRadius: 7,
    backgroundColor: STATUS_ACCENT, opacity: 0.35,
  },
  pulseDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: STATUS_ACCENT,
    borderWidth: 1.5, borderColor: '#fff',
  },

  // ── Empty state ──────────────────────────────────────────────────────────
  emptyContainer: {
    paddingHorizontal: 30, paddingTop: 80,
    alignItems: 'center',
  },
  emptyIcon: {
    width: 84, height: 84, borderRadius: 42,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 20,
  },
  emptyTitle:   { fontSize: 17, fontWeight: '700', marginBottom: 8 },
  emptySubText: { fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 22, maxWidth: 320 },
  emptyCta: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 999,
    paddingVertical: 11, paddingHorizontal: 22,
  },
  emptyCtaText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  noRecentWrap: { paddingHorizontal: 30, paddingTop: 40, alignItems: 'center' },
  noRecentText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },

  // ── FAB ──────────────────────────────────────────────────────────────────
  fab: {
    position: 'absolute',
    bottom: 24, right: 18,
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 10,
    elevation: 6,
  },

  // ── Status thumbnail fallbacks ───────────────────────────────────────────
  thumbCover:    { resizeMode: 'cover' },
  thumbNeutral:  { backgroundColor: '#2A3942' },
  thumbText:     { justifyContent: 'center', alignItems: 'center', padding: 3 },
  thumbTextBody: { color: '#fff', fontSize: 7, textAlign: 'center', lineHeight: 9 },
  thumbLink:     { backgroundColor: '#1a3a5c', alignItems: 'center', justifyContent: 'center' },
});
