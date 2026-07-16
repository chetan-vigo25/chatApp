import React, { memo, useRef } from 'react';
import { Animated, Image, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import SegmentedRing from './SegmentedRing';

const AVATAR_SIZE = 52;
const RING_SIZE   = 58; // outer ring diameter — leaves a small gap around the avatar
const RING_STROKE = 2.5;
// Default (no-photo) avatar: muted person icon.
const DEFAULT_AVATAR_ICON   = '#8696A0';
// Thinnest device hairline around every chat-list avatar. The COLOR is taken from
// the theme's `border` token (light: subtle grey #e6e6e6, dark: faintly-lit slate
// #2A3942) so dark mode gets a dark, only-slightly-highlighted ring — not a bright
// light-grey one bleeding onto the dark background.
const AVATAR_BORDER_WIDTH   = StyleSheet.hairlineWidth;

const ChatCard = ({
  item,
  theme,
  onPress,
  onLongPress,
  onAvatarPress,
  getUserColor,
  getPreviewText,
  getRelativeTime,
  getLastMessageText,
  renderMessageStatus,
  isSelected = false,
  statusInfo = null,
}) => {
  const scale = useRef(new Animated.Value(1)).current;

  const animateTo = (value) => {
    Animated.spring(scale, {
      toValue: value,
      useNativeDriver: true,
      friction: 9,
      tension: 80,
    }).start();
  };

  const hasUnread = Number(item?.unreadCount || 0) > 0;
  const isTyping = item?.realtime?.typing?.isTyping;
  const isLastMsgDeleted = item?.lastMessageDisplay?.isDeleted || item?.lastMessage?.isDeleted;
  const isBroadcast = Boolean(item?.chatType === 'broadcast' || item?.isBroadcast);
  const isGroup = Boolean(item?.chatType === 'group' || item?.isGroup);
  // Verified badge: broadcast channels + admin-verified peer users. `isVerified`
  // rides at the top level (REST getChatList / realtime buildChatListItem); we
  // also fall back to peerUser.isVerified in case a normalization path kept it
  // nested. Groups never carry the flag.
  const isVerified = Boolean(item?.isVerified || item?.peerUser?.isVerified);
  // Half-hydrated rows (peerUser seeded with just an _id before the resolved
  // chat:list:update lands) must degrade to the peer's number / flat chatName —
  // never to the literal "Unknown" — per the display rule saved-name > number >
  // profile name. `mobile` may be an object ({code, number}) or a flat string.
  const peerMobile =
    item?.mobileNumber
    || item?.peerUser?.mobileNumber
    || (item?.peerUser?.mobile?.number
      ? `${item.peerUser.mobile.code || ''}${item.peerUser.mobile.number}`
      : (typeof item?.peerUser?.mobile === 'string' ? item.peerUser.mobile : ''));
  const peerName = isBroadcast
    ? (item?.chatName || item?.broadcastChannel?.name || 'Channel')
    : isGroup
      ? (item?.chatName || item?.group?.name || item?.groupName || 'Group')
      : (item?.peerUser?.fullName || item?.chatName || peerMobile || item?.peerUser?.userName || 'Unknown');
  // Broadcast channels render their logo just like a group avatar.
  const groupAvatarUri = isGroup || isBroadcast
    ? (item?.chatAvatar || item?.group?.avatar || item?.groupAvatar)
    : null;
  // WhatsApp-style status ring: only for 1-1 chats whose peer has live statuses.
  const hasStatusRing = !isGroup && statusInfo && statusInfo.count > 0;

  return (
    <Animated.View style={[styles.cardOuter, { backgroundColor: isSelected ? theme.colors.themeColor + '33' : theme.colors.background, transform: [{ scale }] }]}>
        <TouchableOpacity
          onPress={onPress}
          onLongPress={onLongPress}
          delayLongPress={260}
          onPressIn={() => animateTo(0.98)}
          onPressOut={() => animateTo(1)}
          activeOpacity={1}
          style={styles.card}
        >
          {/* Avatar */}
          <TouchableOpacity
            onPress={onAvatarPress || onPress}
            activeOpacity={0.85}
            style={styles.avatarTouch}
          >
            {/* Status ring (segmented for multiple statuses): unseen = green,
                viewed = grey. Sits outside the avatar with a small gap. */}
            {hasStatusRing && (
              <View style={styles.ringOverlay} pointerEvents="none">
                <SegmentedRing
                  count={statusInfo.count}
                  viewedCount={statusInfo.viewedCount}
                  size={RING_SIZE}
                  strokeWidth={RING_STROKE}
                />
              </View>
            )}

            <View style={styles.avatarInner}>
              {(isGroup || isBroadcast) ? (
                groupAvatarUri ? (
                  <Image resizeMode="cover" source={{ uri: groupAvatarUri }} style={[styles.avatarImage, { borderColor: theme.colors.border }]} />
                ) : (
                  <View style={[styles.avatarFallback, { backgroundColor: getUserColor(peerName), borderColor: theme.colors.border }]}>
                    <Ionicons name={isBroadcast ? 'megaphone' : 'people'} size={22} color="#fff" />
                  </View>
                )
              ) : item?.peerUser?.profileImage ? (
                <Image
                  resizeMode="cover"
                  source={{ uri: item.peerUser.profileImage }}
                  style={[styles.avatarImage, { borderColor: theme.colors.border }]}
                />
              ) : (
                // No profile picture → default person avatar with a subtle theme border.
                <View
                  style={[
                    styles.avatarDefault,
                    { backgroundColor: theme.colors.cardBackground || 'transparent', borderColor: theme.colors.border },
                  ]}
                >
                  <Ionicons name="person" size={28} color={DEFAULT_AVATAR_ICON} />
                </View>
              )}
              {/* Online indicator (not for groups / channels) */}
              {!isGroup && !isBroadcast && item?.peerUser?.isOnline && (
                <View style={[styles.onlineDot, { borderColor: theme.colors.background }]} />
              )}
            </View>
          </TouchableOpacity>

          {/* Content */}
          <View style={styles.contentWrap}>
            {/* Row 1: Name + Time */}
            <View style={styles.topRow}>
              <View style={styles.nameWrap}>
                <Text
                  numberOfLines={1}
                  style={[styles.nameText, { color: theme.colors.primaryTextColor }]}
                >
                  {peerName}
                </Text>
                {isVerified && (
                  <Ionicons
                    name="checkmark-circle"
                    size={15}
                    color={theme.colors.themeColor}
                    style={styles.verifiedBadge}
                  />
                )}
              </View>
              <Text style={[
                styles.timeText,
                { color: hasUnread ? theme.colors.themeColor : theme.colors.placeHolderTextColor }
              ]}>
                {getRelativeTime(item?.lastMessageAt || item?.timestamp)}
              </Text>
            </View>

            {/* Row 2: Preview + Meta */}
            <View style={styles.bottomRow}>
              <View style={styles.previewWrap}>
                {!isTyping && !isLastMsgDeleted && renderMessageStatus(item)}
                <Text
                  numberOfLines={1}
                  style={[
                    styles.previewText,
                    {
                      color: isTyping
                        ? theme.colors.themeColor
                        : (item?.lastMessageDisplay?.isMissedCall
                          ? theme.colors.danger
                          : theme.colors.placeHolderTextColor),
                      fontStyle: (isTyping || isLastMsgDeleted) ? 'italic' : 'normal',
                      fontFamily: hasUnread ? 'Roboto-Medium' : 'Roboto-Regular',
                    },
                  ]}
                >
                  {isTyping
                    ? (item?.lastMessageDisplay?.text || 'Typing...')
                    : getPreviewText(getLastMessageText(item), 38)}
                </Text>
              </View>

              <View style={styles.metaWrap}>
                {item?.isPinned && (
                  <MaterialCommunityIcons name="pin" size={13} color={theme.colors.placeHolderTextColor} style={{ marginRight: 4 }} />
                )}
                {item?.isMuted && (
                  <Ionicons name="volume-mute" size={13} color={theme.colors.placeHolderTextColor} style={{ marginRight: hasUnread ? 4 : 0 }} />
                )}
                {hasUnread && (
                  <View style={[styles.unreadBadge, { backgroundColor: theme.colors.themeColor }]}>
                    <Text style={styles.unreadText}>
                      {Number(item.unreadCount) > 99 ? '99+' : Number(item.unreadCount)}
                    </Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        </TouchableOpacity>
      </Animated.View>
  );
};

const styles = StyleSheet.create({
  cardOuter: {},
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 11,
  },

  // Avatar — fixed 52px slot so row height (and getItemLayout) is unchanged
  // whether or not the peer has a status. The ring draws as an absolute overlay
  // that overflows ~3px into the row padding, so it never grows the row.
  avatarTouch: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringOverlay: {
    position: 'absolute',
    top: (AVATAR_SIZE - RING_SIZE) / 2,
    left: (AVATAR_SIZE - RING_SIZE) / 2,
    width: RING_SIZE,
    height: RING_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInner: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarImage: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    // Hairline circle around every avatar; color is applied inline from theme.colors.border.
    borderWidth: AVATAR_BORDER_WIDTH,
  },
  avatarFallback: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: AVATAR_BORDER_WIDTH,
  },
  // Default person avatar shown when the peer has no profile picture.
  avatarDefault: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: AVATAR_BORDER_WIDTH,
  },
  avatarInitial: {
    fontSize: 22,
    fontFamily: 'Roboto-Bold',
    color: '#fff',
    letterSpacing: -0.5,
  },
  onlineDot: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#03b0a2',
    borderWidth: 2.5,
  },

  // Content
  contentWrap: {
    flex: 1,
    marginLeft: 13,
    justifyContent: 'center',
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 3,
  },
  nameWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 10,
  },
  nameText: {
    fontSize: 16.5,
    fontFamily: 'Roboto-Medium',
    textTransform: 'capitalize',
    flexShrink: 1,
    letterSpacing: 0,
  },
  verifiedBadge: {
    marginLeft: 4,
  },
  timeText: {
    fontSize: 12,
    fontFamily: 'Roboto-Medium',
    letterSpacing: 0.2,
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  previewWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 10,
    gap: 4,
  },
  previewText: {
    fontSize: 14,
    flexShrink: 1,
    lineHeight: 19,
    fontFamily: 'Roboto-Regular',
  },
  metaWrap: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  unreadBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  unreadText: {
    fontSize: 11,
    fontFamily: 'Roboto-Bold',
    color: '#fff',
    letterSpacing: 0.1,
  },

});

export default memo(ChatCard);