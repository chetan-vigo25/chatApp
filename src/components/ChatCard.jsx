import React, { memo, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { Animated, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import SegmentedRing from './SegmentedRing';
import { useTranslatedText, needsSystemFont } from './Translate';
import useDisplayName from '../hooks/useDisplayName';
import { isSelfChat, selfChatLabel, selfIdentityOf } from '../utils/selfChat';
import { usePeerProfileName } from '../services/peerProfileNameStore';
import { useChatDraft } from '../services/chatDraftStore';
import MessageTypeIcon, { iconNameForEmoji, stripPreviewEmoji } from './MessageTypeIcon';
import AppImage from './AppImage';
import { avatarNameSource, getAvatarColor, getAvatarInitial, shouldShowAvatarInitial } from '../utils/avatarIdentity';

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
  const { resolveName, savedNameOf } = useDisplayName();
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
  // Unsent composer text (WhatsApp-style). Replaces the last-message preview
  // until it is sent or erased; "typing…" from the peer still wins.
  const draftText = useChatDraft(item?.chatId || item?._id);
  const showDraft = Boolean(draftText) && !isTyping;

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
  // Media-type icon: drawn as a vector icon between the tick and the text; the
  // emoji marker is stripped from the string so it is not drawn twice.
  const typeIconName = (!isTyping && !showDraft && !isLastMsgDeleted)
    ? iconNameForEmoji(display?.icon, display?.body || display?.text)
    : null;
  const previewSource = typeIconName ? stripPreviewEmoji(summaryText, display?.icon) : summaryText;
  const isMissed = Boolean(display?.isMissedCall);
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
  const peerUserId = item?.peerUser?._id || item?.peerUser?.userId || item?.peerUserId;
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
          userId: peerUserId,
          phone: peerMobile,
          pushName: item?.peerUser?.fullName || item?.chatName || item?.peerUser?.userName,
          // Contact privacy — chat-list row is surface #1.
          username: item?.peerUser?.userName || item?.userName || null,
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
  const rawPeerAvatarUri = !isGroup && !isBroadcast
    ? (item?.peerUser?.profileImage || item?.chatAvatar || null)
    : null;
  // A photo URL that fails to load (removed DP, expired link) rendered an
  // empty circle — fall back to the no-photo avatar instead.
  const [failedAvatarUri, setFailedAvatarUri] = useState(null);
  useEffect(() => { setFailedAvatarUri(null); }, [rawPeerAvatarUri]);
  const peerAvatarUri = rawPeerAvatarUri && rawPeerAvatarUri !== failedAvatarUri ? rawPeerAvatarUri : null;
  // No photo: first letter of my saved name for them, else of their own profile
  // name — even while the row shows their number or @username. No name at all
  // and a number label → person icon. See utils/avatarIdentity.
  // Profile name comes from the profile API (peerProfileNameStore) — the row's
  // own peerUser.fullName / chatName is the server's per-viewer label (a number
  // or a stale contact name), not what the peer set on their profile.
  const peerSavedName = isGroup || isBroadcast || isSelf ? null : savedNameOf({ userId: peerUserId, phone: peerMobile });
  const peerProfileName = usePeerProfileName(
    peerUserId,
    !isGroup && !isBroadcast && !isSelf && !rawPeerAvatarUri,
  );
  const peerInitialSource = avatarNameSource({
    savedName: peerSavedName,
    profileName: peerProfileName,
    displayName: peerName,
  });
  const showPeerInitial = !isGroup && !isBroadcast && !isSelf && !peerAvatarUri
    && shouldShowAvatarInitial(peerInitialSource);
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
          accessibilityRole="button"
          accessibilityLabel={`${peerName}${hasUnread ? `, ${Number(item.unreadCount)} unread` : ''}`}
        >
          {/* Avatar */}
          <TouchableOpacity
            onPress={onAvatarPress || onPress}
            activeOpacity={0.85}
            style={styles.avatarTouch}
            accessibilityRole="button"
            accessibilityLabel={`${peerName} profile picture`}
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
                  <AppImage resizeMode="cover" source={{ uri: groupAvatarUri }} style={[styles.avatarImage, { borderColor: theme.colors.border }]} />
                ) : (
                  <View style={[styles.avatarFallback, { backgroundColor: getAvatarColor(peerName), borderColor: theme.colors.border }]}>
                    <Ionicons name={isBroadcast ? 'megaphone' : 'people'} size={18} color="#fff" />
                  </View>
                )
              ) : peerAvatarUri ? (
                <AppImage
                  resizeMode="cover"
                  source={{ uri: peerAvatarUri }}
                  onError={() => setFailedAvatarUri(peerAvatarUri)}
                  style={[styles.avatarImage, { borderColor: theme.colors.border }]}
                />
              ) : showPeerInitial ? (
                <View style={[styles.avatarFallback, { backgroundColor: getAvatarColor(peerUserId || peerName), borderColor: theme.colors.border }]}>
                  <Text style={styles.avatarInitial}>{getAvatarInitial(peerInitialSource)}</Text>
                </View>
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
                  maxFontSizeMultiplier={1.3}
                  style={[styles.nameText, { color: theme.colors.primaryTextColor }, needsSystemFont(peerName) && styles.systemFontTitle]}
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
              <Text maxFontSizeMultiplier={1.2} style={[
                styles.timeText,
                // link (not the brand fill) for unread: brand teal is 2.7:1 on white.
                { color: hasUnread ? theme.colors.link : theme.colors.secondaryTextColor, fontFamily: hasUnread ? 'Roboto-Medium' : 'Roboto-Regular' }
              ]}>
                {getRelativeTime(item?.lastMessageAt || item?.timestamp)}
              </Text>
            </View>

            {/* Row 2: Preview + Meta */}
            <View style={styles.bottomRow}>
              <View style={styles.previewWrap}>
                {!isTyping && !showDraft && !isLastMsgDeleted && renderMessageStatus(item)}
                {typeIconName ? (
                  <MessageTypeIcon
                    name={typeIconName}
                    color={isMissed ? theme.colors.dangerText : theme.colors.secondaryTextColor}
                  />
                ) : null}
                {showDraft ? (
                  <Text
                    numberOfLines={1}
                    maxFontSizeMultiplier={1.2}
                    style={[
                      styles.previewText,
                      { color: theme.colors.secondaryTextColor },
                      needsSystemFont(draftText) && [styles.systemFont, { lineHeight: 22 }],
                    ]}
                  >
                    <Text style={[styles.draftLabel, { color: theme.colors.link }]}>Draft: </Text>
                    {getPreviewText(draftText.replace(/\s+/g, ' ').trim(), 38)}
                  </Text>
                ) : (
                <Text
                  numberOfLines={1}
                  maxFontSizeMultiplier={1.2}
                  style={[
                    styles.previewText,
                    {
                      color: isTyping
                        ? theme.colors.link
                        : (item?.lastMessageDisplay?.isMissedCall
                          ? theme.colors.dangerText
                          : theme.colors.secondaryTextColor),
                      fontStyle: (isTyping || isLastMsgDeleted) ? 'italic' : 'normal',
                      fontFamily: hasUnread ? 'Roboto-Medium' : 'Roboto-Regular',
                    },
                    // Roboto-Regular carries 922 codepoints — Latin, Greek and
                    // Cyrillic. A preview translated into Hindi, Thai, Tamil,
                    // Arabic or CJK has NO glyphs in it and renders as boxes.
                    // Hand those to the OS font. See docs/APP_LANGUAGE_GUIDE.md
                    // Section 7 — every new place foreign script can appear
                    // needs this, and the chat list is now one of them.
                    needsSystemFont(summaryText) && { fontFamily: undefined, lineHeight: 22 },
                  ]}
                >
                  {isTyping
                    ? (item?.lastMessageDisplay?.text || 'Typing...')
                    : getPreviewText(previewSource, 38)}
                </Text>
                )}
              </View>

              <View style={styles.metaWrap}>
                {item?.isPinned && (
                  <MaterialCommunityIcons name="pin" size={14} color={theme.colors.secondaryTextColor} style={{ marginRight: 4 }} />
                )}
                {item?.isMuted && (
                  <Ionicons name="volume-mute" size={14} color={theme.colors.secondaryTextColor} style={{ marginRight: hasUnread ? 4 : 0 }} />
                )}
                {hasUnread && (
                  <View style={[styles.unreadBadge, { backgroundColor: theme.colors.themeColor }]}>
                    <Text style={styles.unreadText} maxFontSizeMultiplier={1.2}>
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
    // Type scale: title 16 semibold, preview 14, time 12, badge 12.
    fontSize: 16,
    lineHeight: 22,
    fontFamily: 'Roboto-SemiBold',
    flexShrink: 1,
    letterSpacing: 0,
  },
  // Foreign scripts (Devanagari etc.) have no glyphs in Roboto — OS font.
  systemFontTitle: {
    fontFamily: undefined,
    fontWeight: '600',
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
    gap: 5,
  },
  previewText: {
    fontSize: 14,
    flexShrink: 1,
    lineHeight: 20,
    fontFamily: 'Roboto-Regular',
  },
  draftLabel: {
    fontFamily: 'Roboto-Medium',
  },
  systemFont: {
    fontFamily: undefined,
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
    fontSize: 12,
    fontFamily: 'Roboto-Bold',
    color: '#fff',
    letterSpacing: 0.1,
  },

});

export default memo(ChatCard);