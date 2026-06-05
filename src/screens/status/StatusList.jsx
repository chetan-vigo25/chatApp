import { useCallback, useState, useEffect, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Image, StyleSheet,
  RefreshControl, Platform, Animated, Easing,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useDispatch, useSelector } from 'react-redux';
import { useTheme } from '../../contexts/ThemeContext';
import { fetchMyStatuses, fetchStatusFeed, addNewStatusFromSocket, removeStatusFromSocket, hydrateViewedStatusIds, fetchBroadcasts, hydrateBroadcasts, removeBroadcastFromSocket } from '../../Redux/Reducer/Status/Status.reducer';
import { getSocket } from '../../Redux/Services/Socket/socket';
import { Ionicons, MaterialCommunityIcons, Feather } from '@expo/vector-icons';
import SegmentedRing from '../../components/SegmentedRing';
import { STATUS_ACCENT } from './_statusDesign';
import useContactDirectory from '../../hooks/useContactDirectory';
import { toSecureMediaUri } from '../../utils/mediaService';

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
    return <Image source={{ uri: toSecureMediaUri(firstItem.thumbnailUrl || firstItem.mediaUrl) }} style={[style, styles.thumbCover]} />;
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
    if (ogImage) return <Image source={{ uri: toSecureMediaUri(ogImage) }} style={[style, styles.thumbCover]} />;
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
  const { theme, isDarkMode } = useTheme();
  const dispatch = useDispatch();
  const { myStatuses, contactStatuses, viewedStatusIds, broadcasts, isLoading } = useSelector(state => state.status);
  const { user } = useSelector(state => state.authentication);
  const [refreshing, setRefreshing] = useState(false);
  const socketListenerRef = useRef(null);
  const { resolveName, refresh: refreshContacts } = useContactDirectory();

  const loadData = useCallback(() => {
    dispatch(fetchMyStatuses());
    dispatch(fetchStatusFeed());
    dispatch(fetchBroadcasts());
  }, [dispatch]);

  // Rehydrate the persisted viewed-set + cached broadcasts ONCE on mount so the
  // rings and the Official Updates section render with correct state on cold
  // open, before the network calls resolve.
  useEffect(() => {
    dispatch(hydrateViewedStatusIds());
    dispatch(hydrateBroadcasts());
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
      dispatch(fetchBroadcasts()),
      refreshContacts?.(),
    ]);
    setRefreshing(false);
  }, [dispatch, refreshContacts]);

  // ── Socket: real-time status:new / status:deleted ──────────────────────────
  useEffect(() => {
    const attachListeners = () => {
      const socket = getSocket?.();
      if (!socket || socketListenerRef.current === socket) return;

      const onStatusNew = (payload) => {
        // Admin broadcasts arrive on the same `status:new` channel but flagged.
        if (payload?.isBroadcast || payload?.isOfficial || payload?.isAdminBroadcast) {
          dispatch(fetchBroadcasts());
          return;
        }
        dispatch(addNewStatusFromSocket(payload));
      };
      const onStatusDeleted = (payload) => dispatch(removeStatusFromSocket(payload));

      // Dedicated official-broadcast channels
      const onBroadcastNew = () => dispatch(fetchBroadcasts());
      const onBroadcastUpdated = () => dispatch(fetchBroadcasts());
      const onBroadcastDeleted = (payload) => dispatch(removeBroadcastFromSocket(payload));

      socket.on('status:new', onStatusNew);
      socket.on('status:deleted', onStatusDeleted);
      socket.on('broadcast:new', onBroadcastNew);
      socket.on('broadcast:updated', onBroadcastUpdated);
      socket.on('broadcast:deleted', onBroadcastDeleted);
      socketListenerRef.current = socket;

      return () => {
        socket.off('status:new', onStatusNew);
        socket.off('status:deleted', onStatusDeleted);
        socket.off('broadcast:new', onBroadcastNew);
        socket.off('broadcast:updated', onBroadcastUpdated);
        socket.off('broadcast:deleted', onBroadcastDeleted);
      };
    };

    const cleanup = attachListeners();
    const interval = setInterval(() => { if (!socketListenerRef.current) attachListeners(); }, 2000);
    return () => { clearInterval(interval); if (cleanup) cleanup(); socketListenerRef.current = null; };
  }, [dispatch]);
  // ──────────────────────────────────────────────────────────────────────────

  const hasMyStatus = myStatuses && myStatuses.length > 0;

  // ── Official Updates (admin broadcast) → a status entry in the list ─────────
  // The official application broadcasts are grouped into a single "channel"-style
  // entry (branding name + logo, verified badge — never the admin identity) that
  // flows through the SAME Recent/Viewed sections as contact statuses, exactly
  // like WhatsApp. It moves to "Viewed updates" once every broadcast is seen.
  const liveBroadcasts = broadcasts || [];
  const broadcastSeen = (b) => b.isViewed || viewedStatusIds.includes(String(b._id));
  const broadcastGroup = liveBroadcasts.length
    ? {
        userId:     'official-broadcast',
        isOfficial: true,
        name:       liveBroadcasts.find(b => b.brandingName)?.brandingName || 'Official Updates',
        avatar:     liveBroadcasts.find(b => b.brandingLogo)?.brandingLogo || null,
        statuses:   liveBroadcasts,
        count:      liveBroadcasts.length,
        latestAt:   liveBroadcasts[0]?.publishedAt || liveBroadcasts[0]?.createdAt,
        allViewed:  liveBroadcasts.every(broadcastSeen),
      }
    : null;

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
                  size={56}
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
              {hasMyStatus ? 'My status' : 'Add status'}
            </Text>
            <Text style={[styles.rowMeta, { color: theme.colors.placeHolderTextColor }]} numberOfLines={1}>
              {hasMyStatus
                ? `${timeAgo(myStatuses[0]?.createdAt) || 'recently'}${myStatuses.length > 1 ? `  ·  ${myStatuses.length} updates` : ''}`
                : 'Disappears after 24 hours'}
            </Text>
          </View>
        </View>
      </PressScale>
    );
  };

  // ── Status row — works for both contacts and the official broadcast entry ───
  const renderContactStatus = ({ item }) => {
    const isOfficial   = !!item.isOfficial;
    const statusCount  = item.count || item.statuses?.length || 0;
    // Prefer the locally-saved contact name; fall back to phone number when
    // the contact is not saved on this device, then to the server-side name.
    const serverName   = item.name || item.fullName;
    const phone        = item.phone || item.number || item.mobile?.number || item.mobileNumber;
    const displayName  = isOfficial ? item.name : resolveName(item.userId, serverName, phone);
    const viewedCount  = (item.statuses || []).filter(
      s => (isOfficial && s.isViewed) || viewedStatusIds.includes(String(s._id))
    ).length;
    const allSeen      = viewedCount >= statusCount;

    const onOpen = () => navigation.navigate('StatusViewer', {
      statuses:    item.statuses || [],
      startIndex:  0,
      isMine:      false,
      isBroadcast: isOfficial,
      userName:    displayName,
      userImage:   item.avatar || item.profileImage,
      userId:      item.userId,
    });

    const timeLabel = timeAgo(item.latestAt) || 'recently';

    return (
      <PressScale onPress={onOpen} style={styles.rowWrap}>
        <View style={styles.row}>
          <View style={styles.rowAvatar}>
            <SegmentedRing count={statusCount} viewedCount={viewedCount} size={56} strokeWidth={2.5} />
            {/* Avatar slot previews the latest update (WhatsApp pattern). The
                official entry shows the brand logo when one is configured. */}
            {isOfficial && item.avatar ? (
              <Image source={{ uri: toSecureMediaUri(item.avatar) }} style={styles.rowAvatarImg} />
            ) : (
              <StatusThumb status={(item.statuses || [])[0]} style={styles.rowAvatarImg} />
            )}
            {isOfficial ? (
              <View style={[styles.verifiedBadge, { backgroundColor: theme.colors.themeColor, borderColor: theme.colors.background }]}>
                <Ionicons name="checkmark" size={9} color="#fff" />
              </View>
            ) : (
              <UnseenPulse visible={!allSeen} />
            )}
          </View>

          <View style={styles.rowText}>
            <View style={styles.nameRow}>
              <Text style={[styles.rowName, { color: theme.colors.primaryTextColor }]} numberOfLines={1}>
                {displayName}
              </Text>
              {isOfficial && (
                <Ionicons name="checkmark-circle" size={15} color={theme.colors.themeColor} style={styles.nameVerified} />
              )}
            </View>
            <Text style={[styles.rowMeta, { color: theme.colors.placeHolderTextColor }]} numberOfLines={1}>
              {isOfficial ? 'Official' : timeLabel}
              {statusCount > 1 ? `  ·  ${statusCount} updates` : (isOfficial ? `  ·  ${timeLabel}` : '')}
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

  // ── Build a WhatsApp-style sectioned list ──────────────────────────────────
  // My status, then "Recent updates" (unseen) and "Viewed updates" (seen). The
  // official broadcast entry is merged in with contacts and flows through the
  // same two sections — appearing under "Viewed updates" once it has been seen.
  const isAllViewed = (c) => c.isOfficial
    ? c.allViewed
    : (c.allViewed || (c.statuses || []).every(s => viewedStatusIds.includes(String(s._id))));

  const groups = (broadcastGroup ? [broadcastGroup, ...(contactStatuses || [])] : (contactStatuses || []))
    .slice()
    .sort((a, b) => new Date(b.latestAt) - new Date(a.latestAt));
  const recent = groups.filter(c => !isAllViewed(c));
  const viewed = groups.filter(c => isAllViewed(c));

  const rows = [
    { _t: 'statusHeader', key: 'statusHeader' },
    { _t: 'mystatus', key: 'mystatus' },
  ];
  if (recent.length) {
    rows.push({ _t: 'label', key: 'l-recent', label: 'Recent updates' });
    recent.forEach(c => rows.push({ _t: 'contact', key: `r-${c.userId || c._id}`, item: c }));
  }
  if (viewed.length) {
    rows.push({ _t: 'label', key: 'l-viewed', label: 'Viewed updates' });
    viewed.forEach(c => rows.push({ _t: 'contact', key: `v-${c.userId || c._id}`, item: c }));
  }
  if (!recent.length && !viewed.length && !isLoading) {
    rows.push({ _t: 'empty', key: 'empty' });
  }

  const renderRow = ({ item }) => {
    switch (item._t) {
      case 'statusHeader':
        return <Text style={[styles.statusHeader, { color: theme.colors.primaryTextColor }]}>Status</Text>;
      case 'mystatus':
        return renderMyStatus();
      case 'label':
        return renderSectionLabel(item.label);
      case 'contact':
        return renderContactStatus({ item: item.item });
      case 'empty':
        return hasMyStatus ? (
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
          </View>
        );
      default:
        return null;
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Large title — WhatsApp "Updates" page */}
      <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: theme.colors.primaryTextColor }]}>Updates</Text>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(item) => item.key}
        renderItem={renderRow}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.colors.themeColor}
          />
        }
        contentContainerStyle={styles.listContent}
      />

      {/* Floating compose — WhatsApp-style dual FAB (text + camera) */}
      <View style={styles.fabStack} pointerEvents="box-none">
        {/* Secondary — text status */}
        <TouchableOpacity
          style={[
            styles.fabMini,
            {
              backgroundColor: isDarkMode ? theme.colors.surface : '#FFFFFF',
              borderColor: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
            },
          ]}
          activeOpacity={0.85}
          onPress={() => navigation.navigate('StatusCreate', { type: 'text' })}
          accessibilityLabel="New text status"
        >
          <MaterialCommunityIcons name="pencil" size={20} color={theme.colors.themeColor} />
        </TouchableOpacity>

        {/* Primary — camera status */}
        <TouchableOpacity
          style={[styles.fab, { backgroundColor: theme.colors.themeColor }]}
          activeOpacity={0.85}
          onPress={() => navigation.navigate('StatusCreate')}
          accessibilityLabel="New status"
        >
          <Ionicons name="camera" size={22} color="#fff" />
        </TouchableOpacity>
      </View>
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
  headerTitle: { fontSize: 22, fontFamily: 'Roboto-Bold', letterSpacing: -0.2 },

  // List body
  listContent: {
    paddingBottom: 100,
    ...(IS_IPAD ? { maxWidth: 680, width: '100%', alignSelf: 'center' } : null),
  },

  // Section label
  sectionLabel: {
    fontSize: 13, fontFamily: 'Roboto-SemiBold',
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
  rowAvatar:    { width: 56, height: 56, alignItems: 'center', justifyContent: 'center', position: 'relative' },
  rowAvatarImg: { width: 46, height: 46, borderRadius: 23, position: 'absolute', overflow: 'hidden' },
  rowAvatarFallback: { alignItems: 'center', justifyContent: 'center' },
  nameRow:      { flexDirection: 'row', alignItems: 'center' },
  nameVerified: { marginLeft: 4 },
  rowAddDot: {
    position: 'absolute', bottom: 0, right: 0,
    width: 18, height: 18, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2,
  },
  rowText:      { flex: 1, minWidth: 0 },
  rowName:      { fontSize: 15, fontFamily: 'Roboto-SemiBold', marginBottom: 2 },
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
  emptyTitle:   { fontSize: 17, fontFamily: 'Roboto-Bold', marginBottom: 8 },
  emptySubText: { fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 22, maxWidth: 320 },
  emptyCta: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 999,
    paddingVertical: 11, paddingHorizontal: 22,
  },
  emptyCtaText: { color: '#fff', fontSize: 14, fontFamily: 'Roboto-Bold' },
  noRecentWrap: { paddingHorizontal: 30, paddingTop: 40, alignItems: 'center' },
  noRecentText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },

  // Bold "Status" section title above the My status row (WhatsApp Updates page)
  statusHeader: {
    fontSize: 18, fontFamily: 'Roboto-Bold', letterSpacing: -0.2,
    paddingHorizontal: 18, paddingTop: 4, paddingBottom: 6,
  },

  // ── FAB ──────────────────────────────────────────────────────────────────
  fabStack: {
    position: 'absolute',
    bottom: 24, right: 18,
    alignItems: 'center',
    gap: 14,
  },
  fab: {
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 10,
    elevation: 6,
  },
  fabMini: {
    width: 46, height: 46, borderRadius: 23,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.18, shadowRadius: 6,
    elevation: 4,
  },

  // ── Official (broadcast) verified badge ──────────────────────────────────
  verifiedBadge: {
    position: 'absolute', bottom: 0, right: 0,
    width: 18, height: 18, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2,
  },

  // ── Status thumbnail fallbacks ───────────────────────────────────────────
  thumbCover:    { resizeMode: 'cover' },
  thumbNeutral:  { backgroundColor: '#2A3942' },
  thumbText:     { justifyContent: 'center', alignItems: 'center', padding: 3 },
  thumbTextBody: { color: '#fff', fontSize: 7, textAlign: 'center', lineHeight: 9 },
  thumbLink:     { backgroundColor: '#1a3a5c', alignItems: 'center', justifyContent: 'center' },
});
