/**
 * StatusFeedRow
 * Horizontal scrollable ring-avatar row for the top of ChatList / StatusList.
 *
 * Ring colours:
 *   • Unseen  → purple (#8B5CF6) border  (install expo-linear-gradient for true gradient)
 *   • Viewed  → muted gray (#94A3B8) border
 *   • Own     → green (#03b0a2) border when has status, plain when none
 *
 * Usage:
 *   <StatusFeedRow navigation={navigation} />
 */
import { useCallback, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Image,
  StyleSheet,
  Platform,
} from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import { Ionicons } from '@expo/vector-icons';
import {
  fetchMyStatuses, fetchStatusFeed,
  hydrateViewedStatusIds,
} from '../Redux/Reducer/Status/Status.reducer';
import { useTheme } from '../contexts/ThemeContext';
import { ensureStatusSocketListeners } from '../services/statusSocketWiring';
import useContactDirectory from '../hooks/useContactDirectory';

// ── Helpers ───────────────────────────────────────────────────────────────────

const RING_UNSEEN   = '#8B5CF6'; // purple
const RING_VIEWED   = '#94A3B8'; // muted gray
const RING_OWN      = '#03b0a2'; // green
const AVATAR_SIZE   = 54;
const RING_WIDTH    = 2.5;
const ITEM_WIDTH    = 72;

/** Ring avatar with a proper fallback — initial letter (or person glyph) on a
 *  teal disc when there's no profile image. NEVER the app logo. */
const RingAvatar = ({ uri, name }) => {
  if (uri) return <Image source={{ uri }} style={styles.avatar} />;
  const trimmed = String(name || '').trim();
  const letter  = /^[a-z]/i.test(trimmed) ? trimmed.charAt(0).toUpperCase() : null;
  return (
    <View style={[styles.avatar, styles.avatarFallback]}>
      {letter
        ? <Text style={styles.avatarFallbackLetter}>{letter}</Text>
        : <Ionicons name="person" size={22} color="rgba(255,255,255,0.9)" />}
    </View>
  );
};

/** True if every status in a contact group has been viewed */
const isGroupFullyViewed = (group, viewedSet) => {
  const statuses = group.statuses || [];
  return statuses.length > 0 && statuses.every(s => viewedSet.has(String(s._id)));
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function StatusFeedRow({ navigation, style }) {
  const { theme } = useTheme();
  const dispatch = useDispatch();

  const { myStatuses, contactStatuses, viewedStatusIds } = useSelector(s => s.status);
  const { user } = useSelector(s => s.authentication);
  const { resolveName } = useContactDirectory();

  const viewedSet = new Set(viewedStatusIds.map(String));
  const hasMyStatus = myStatuses && myStatuses.length > 0;

  // ── Load feed on mount ─────────────────────────────────────────────────────
  useEffect(() => {
    // Rehydrate persisted viewed-set FIRST so rings render with the correct
    // colour on cold open, before /feed resolves.
    dispatch(hydrateViewedStatusIds());
    dispatch(fetchMyStatuses());
    dispatch(fetchStatusFeed());
  }, [dispatch]);

  // ── Socket listeners (shared, refcounted — one set app-wide) ──────────────
  useEffect(() => {
    return ensureStatusSocketListeners(dispatch);
  }, [dispatch]);

  // ── Navigation handlers ────────────────────────────────────────────────────
  const openMyStatus = useCallback(() => {
    if (hasMyStatus) {
      navigation.navigate('StatusViewer', {
        statuses: myStatuses,
        startIndex: 0,
        isMine: true,
      });
    } else {
      navigation.navigate('StatusCreate');
    }
  }, [hasMyStatus, myStatuses, navigation]);

  const openContactStatus = useCallback((group) => {
    const serverName = group.name || group.fullName || group.userName;
    const phone      = group.phone || group.number || group.mobile?.number || group.mobileNumber;
    const label      = resolveName(group.userId, serverName, phone);
    navigation.navigate('StatusViewer', {
      statuses:  group.statuses || [],
      startIndex: 0,
      isMine:    false,
      userName:  label,
      userImage: group.avatar || group.profileImage || group.userAvatar,
      userId:    group.userId,
    });
  }, [navigation, resolveName]);

  // Don't render if there's nothing to show
  if (!hasMyStatus && (!contactStatuses || contactStatuses.length === 0)) {
    return (
      <View style={[styles.emptyRow, { backgroundColor: theme.colors.background }, style]}>
        <TouchableOpacity style={styles.emptyOwn} onPress={() => navigation.navigate('StatusCreate')}>
          <View style={[styles.ownRingEmpty, { borderColor: RING_OWN }]}>
            <RingAvatar uri={user?.profileImage} name={user?.fullName} />
            <View style={[styles.addBadge, { backgroundColor: theme.colors.themeColor }]}>
              <Ionicons name="add" size={12} color="#fff" />
            </View>
          </View>
          <Text style={[styles.label, { color: theme.colors.placeHolderTextColor }]} numberOfLines={1}>
            My Status
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <View style={[styles.wrapper, { backgroundColor: theme.colors.background }, style]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {/* ── Own avatar (always first) ── */}
        <TouchableOpacity style={styles.item} onPress={openMyStatus} activeOpacity={0.75}>
          <View style={styles.ringWrap}>
            {/* Gradient ring approximation via two concentric views */}
            {hasMyStatus ? (
              <View style={[styles.gradientRing, styles.unseenRing]}>
                <View style={styles.ringInner}>
                  <RingAvatar uri={user?.profileImage} name={user?.fullName} />
                </View>
              </View>
            ) : (
              <View style={[styles.gradientRing, { borderColor: 'transparent' }]}>
                <View style={styles.ringInner}>
                  <RingAvatar uri={user?.profileImage} name={user?.fullName} />
                </View>
              </View>
            )}

            {/* Thumbnail preview or + badge */}
            {hasMyStatus && myStatuses[0]?.mediaItems?.[0]?.thumbnailUrl ? (
              <View style={styles.thumbnailBadge}>
                <Image source={{ uri: myStatuses[0].mediaItems[0].thumbnailUrl }} style={styles.thumbnailImg} />
              </View>
            ) : (
              <View style={[styles.addBadge, { backgroundColor: theme.colors.themeColor }]}>
                <Ionicons name={hasMyStatus ? 'checkmark' : 'add'} size={12} color="#fff" />
              </View>
            )}
          </View>
          <Text style={[styles.label, { color: theme.colors.primaryTextColor }]} numberOfLines={1}>
            My Status
          </Text>
        </TouchableOpacity>

        {/* ── Contact groups ── */}
        {(contactStatuses || []).map((group) => {
          const viewed   = group.allViewed || isGroupFullyViewed(group, viewedSet);
          const ringColor = viewed ? RING_VIEWED : RING_UNSEEN;
          const avatarUri = group.avatar || group.profileImage || group.userAvatar;
          // Small status-thumbnail badge (exactly like "My Status"). Media fields
          // are nested under mediaItems[0] for some payloads and at the top level
          // for others — resolve from both, preferring the small thumbnailUrl.
          const firstSt  = (group.statuses || [])[0];
          const stItem   = firstSt?.mediaItems?.[0] || null;
          const stType   = stItem?.mediaType || firstSt?.mediaType || null;
          // Video: never fall back to the full mediaUrl (black box + full
          // video download for a ring badge); images may as a legacy fallback.
          const stThumb  = stItem?.thumbnailUrl || firstSt?.thumbnailUrl
            || (stType !== 'video' ? (stItem?.mediaUrl || firstSt?.mediaUrl) : null) || null;
          const serverName = group.name || group.fullName || group.userName;
          const phone      = group.phone || group.number || group.mobile?.number || group.mobileNumber;
          // Saved contact name → phone number → server-provided name.
          const name       = resolveName(group.userId, serverName, phone);

          return (
            <TouchableOpacity
              key={String(group.userId || group._id)}
              style={styles.item}
              onPress={() => openContactStatus(group)}
              activeOpacity={0.75}
            >
              <View style={styles.ringWrap}>
                <View
                  style={[
                    styles.gradientRing,
                    viewed ? styles.viewedRing : styles.unseenRing,
                    { borderColor: ringColor },
                  ]}
                >
                  <View style={styles.ringInner}>
                    <RingAvatar uri={avatarUri} name={name} />
                  </View>
                </View>
                {/* Status-thumbnail badge — same corner preview as "My Status". */}
                {stThumb ? (
                  <View style={styles.thumbnailBadge}>
                    <Image source={{ uri: stThumb }} style={styles.thumbnailImg} />
                  </View>
                ) : null}
                {/* Unseen count badge */}
                {!viewed && group.unseenCount > 0 && (
                  <View style={[styles.unseenBadge, { backgroundColor: RING_UNSEEN }]}>
                    <Text style={styles.unseenBadgeText}>{group.unseenCount > 9 ? '9+' : group.unseenCount}</Text>
                  </View>
                )}
              </View>
              <Text style={[styles.label, { color: theme.colors.primaryTextColor }]} numberOfLines={1}>
                {name}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  wrapper: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.08)',
  },
  emptyRow: {
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  emptyOwn: {
    alignItems: 'center',
    width: ITEM_WIDTH,
  },
  scrollContent: {
    paddingHorizontal: 12,
    gap: 6,
  },
  item: {
    alignItems: 'center',
    width: ITEM_WIDTH,
  },
  ringWrap: {
    position: 'relative',
    marginBottom: 5,
  },
  gradientRing: {
    width: AVATAR_SIZE + RING_WIDTH * 2 + 4,
    height: AVATAR_SIZE + RING_WIDTH * 2 + 4,
    borderRadius: (AVATAR_SIZE + RING_WIDTH * 2 + 4) / 2,
    borderWidth: RING_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 2,
  },
  unseenRing: {
    borderColor: RING_UNSEEN,
    // Approximate gradient via shadow on iOS
    ...Platform.select({
      ios: { shadowColor: '#EC4899', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.5, shadowRadius: 4 },
      android: { elevation: 2 },
    }),
  },
  viewedRing: {
    borderColor: RING_VIEWED,
  },
  ringInner: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    overflow: 'hidden',
    backgroundColor: '#ccc',
  },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
  },
  avatarFallback: {
    backgroundColor: '#03b0a2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarFallbackLetter: {
    color: '#fff',
    fontSize: 20,
    fontFamily: 'Roboto-SemiBold',
    fontWeight: '600',
  },
  addBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#fff',
  },
  thumbnailBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 22,
    height: 22,
    borderRadius: 11,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: '#fff',
  },
  thumbnailImg: {
    width: '100%',
    height: '100%',
  },
  unseenBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
    borderWidth: 1.5,
    borderColor: '#fff',
  },
  unseenBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontFamily: 'Roboto-Bold',
  },
  label: {
    fontSize: 11,
    fontFamily: 'Roboto-Medium',
    maxWidth: ITEM_WIDTH - 4,
    textAlign: 'center',
  },
  ownRingEmpty: {
    width: AVATAR_SIZE + RING_WIDTH * 2 + 4,
    height: AVATAR_SIZE + RING_WIDTH * 2 + 4,
    borderRadius: (AVATAR_SIZE + RING_WIDTH * 2 + 4) / 2,
    borderWidth: RING_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 2,
    marginBottom: 5,
  },
});
