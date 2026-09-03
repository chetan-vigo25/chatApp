import React, { memo, useRef } from 'react';
import { useSelector } from 'react-redux';
import { Animated, Image, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import SegmentedRing from './SegmentedRing';
import { useTranslatedText, needsSystemFont } from './Translate';
import useDisplayName from '../hooks/useDisplayName';
import { isSelfChat, selfChatLabel, selfIdentityOf } from '../utils/selfChat';

const AVATAR_SIZE = 47; // smaller chat-list avatar (was 52 → 48 → 44)
const RING_SIZE   = 53; // outer ring diameter — leaves a small gap around the avatar
const RING_STROKE = 2;
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
  // Canonical name resolution — the row re-renders by itself when the address
  // book changes (contact synced / saved / deleted).
  const { resolveName } = useDisplayName();
  // Only the self-chat row reads this — my own handle/privacy toggle, which no
  // chat row carries. Selecting the slice object keeps the subscription cheap
  // (stable reference until the profile itself changes).
  const myProfile = useSelector((state) => state.profile?.profileData);

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

  // ── Translated summary ────────────────────────────────────────────────────
  //
  // The row shows the same sentence the chat itself will show. buildLastMessageDisplay
  // already split the parts, so only the sender's own words are translated: the
  // "You: " marker, the media icon and a group member's NAME are all in
  // prefixText and never reach the translator.
  //
  // The FULL body is translated and getPreviewText truncates afterwards.
  // Truncating first would hand the translator half a sentence plus a trailing
  // "...", which reads worse and — being a different string — would also miss
  // the cache entry the open chat already created for the whole message.
  const display = item?.lastMessageDisplay;
  const translatedBody = useTranslatedText(display?.body, {
    isOwn: display?.isOwn,
    // Media labels, call summaries and system notices are OUR words, not the
    // sender's. Typing and deleted rows are placeholders. None get translated.
    enabled: Boolean(display?.translatable) && !isTyping && !isLastMsgDeleted,
  });
  const summaryText = translatedBody
    ? `${display?.prefixText || ''}${translatedBody}${display?.suffixText || ''}`.trim()
    : getLastMessageText(item);
  const isBroadcast = Boolean(item?.chatType === 'broadcast' || item?.isBroadcast);
  const isGroup = Boolean(item?.chatType === 'group' || item?.isGroup);
  // Self chat ("Message yourself"): rendered as "<my number> (You)" so it is
  // never confused with a contact row. Detected from the chatId shape, so a
  // half-hydrated row (no peerUser yet) still labels correctly.
  const isSelf = isSelfChat(item);
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
  // 1-1 rows follow the ONE display rule: my saved contact name → the peer's
  // phone number → (only when no number exists at all) whatever name the server
  // shipped. `peerUser.fullName` is the peer's SELF-SET profile name — a push
  // name — so it must never win over the number for someone I never saved.
  const peerName = isBroadcast
    ? (item?.chatName || item?.broadcastChannel?.name || 'Channel')
    : isSelf
    ? selfChatLabel({
        mobileNumber: peerMobile,
        name: item?.peerUser?.fullName || item?.chatName || item?.peerUser?.userName,
        // My OWN privacy toggle — read live off the profile slice, not off the
        // row (the server ships no `hideContact` on a self-chat peerUser).
        ...selfIdentityOf(myProfile),
      })
    : isGroup
      ? (item?.chatName || item?.group?.name || item?.groupName || 'Group')
      : resolveName({
          userId: item?.peerUser?._id || item?.peerUser?.userId || item?.peerUserId,
          phone: peerMobile,
          pushName: item?.peerUser?.fullName || item?.chatName || item?.peerUser?.userName,
          // Contact privacy — chat-list row is surface #1.
          username: item?.peerUser?.userName || null,
          hideContact: Boolean(item?.peerUser?.hideContact ?? item?.hideContact),
          fallback: 'Unknown',
        });
  // Broadcast channels render their logo just like a group avatar.
  const groupAvatarUri = isGroup || isBroadcast
    ? (item?.chatAvatar || item?.group?.avatar || item?.groupAvatar)
    : null;
  // 1-1 avatar: peerUser.profileImage when hydrated, else the server's
  // chatAvatar (the chat-list REST rows carry ONLY chatAvatar — without this
  // fallback a row whose peerUser wasn't hydrated yet rendered the default
  // person icon even though the URL was right there).
  const peerAvatarUri = !isGroup && !isBroadcast
    ? (item?.peerUser?.profileImage || item?.chatAvatar || null)
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
                    <Ionicons name={isBroadcast ? 'megaphone' : 'people'} size={18} color="#fff" />
                  </View>
                )
              ) : peerAvatarUri ? (
                <Image
                  resizeMode="cover"
                  source={{ uri: peerAvatarUri }}
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
                  <Ionicons name="person" size={24} color={DEFAULT_AVATAR_ICON} />
                </View>
              )}
              {/* Online indicator (not for groups / channels) */}
              {!isGroup && !isBroadcast && !isSelf && item?.peerUser?.isOnline && (
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
                    // Roboto-Regular carries 922 codepoints — Latin, Greek and
                    // Cyrillic. A preview translated into Hindi, Thai, Tamil,
                    // Arabic or CJK has NO glyphs in it and renders as boxes.
                    // Hand those to the OS font. See docs/APP_LANGUAGE_GUIDE.md
                    // Section 7 — every new place foreign script can appear
                    // needs this, and the chat list is now one of them.
                    needsSystemFont(summaryText) && { fontFamily: undefined },
                  ]}
                >
                  {isTyping
                    ? (item?.lastMessageDisplay?.text || 'Typing...')
                    : getPreviewText(summaryText, 38)}
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
    paddingHorizontal: 12,
    // 44px avatar + 2×10 padding = 64 → tighter rows. MUST stay in sync with
    // the list's getItemLayout row height in ChatList.jsx, or scroll math drifts.
    paddingVertical: 10,
  },

  // Avatar — fixed 44px slot so row height (and getItemLayout) is unchanged
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
    marginLeft: 12,
    justifyContent: 'center',
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  nameWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 10,
  },
  nameText: {
    // Chat-list title: slightly bold, matches the Settings screen name
    // (Roboto-SemiBold). Original case preserved, no extra letter-spacing.
    fontSize: 15.5,
    fontFamily: 'Roboto-SemiBold',
    flexShrink: 1,
    letterSpacing: 0,
  },
  verifiedBadge: {
    marginLeft: 4,
  },
  timeText: {
    // WhatsApp timestamp: ~12sp REGULAR weight (lighter than the name), no
    // letter-spacing. Colour is applied inline (green when unread).
    fontSize: 12,
    fontFamily: 'Roboto-Regular',
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
    lineHeight: 22,
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