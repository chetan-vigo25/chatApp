import React, { useCallback, useEffect, useState, useRef } from 'react';
import { useSelector } from 'react-redux';
import { Animated, Easing, Image, ScrollView, Text, TouchableOpacity, View, StyleSheet, Platform } from 'react-native';
import { FontAwesome6, Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import useUserPresence from '../hooks/useUserPresence';
import { formatLastSeen } from '../services/lastSeenFormatter.service';
import { useRealtimeChatSlice } from '../../contexts/RealtimeChatContext';
import ContactDatabase from '../../services/ContactDatabase';
import { getSocket } from '../../Redux/Services/Socket/socket';
import useDisplayName from '../../hooks/useDisplayName';
import { isSelfChatId, selfChatLabel, selfIdentityOf } from '../../utils/selfChat';

// Marquee for one-line header text: static while it fits; when it overflows
// the available width it auto-scrolls right→left in a seamless loop (second
// copy trails GAP px behind), pausing briefly at the start of each pass.
const MARQUEE_GAP = 48;
const MARQUEE_SPEED = 40; // px per second

function MarqueeText({ text, style }) {
  const [containerW, setContainerW] = useState(0);
  const [textW, setTextW] = useState(0);
  const scrollX = useRef(new Animated.Value(0)).current;
  const overflow = containerW > 0 && textW > containerW + 2;

  useEffect(() => {
    scrollX.setValue(0);
    if (!overflow) return undefined;
    const distance = textW + MARQUEE_GAP;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.delay(1500),
        Animated.timing(scrollX, {
          toValue: -distance,
          duration: (distance / MARQUEE_SPEED) * 1000,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        // Snap back instantly — the trailing copy is already in place, so the
        // jump is invisible and the loop restarts from the pause.
        Animated.timing(scrollX, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overflow, textW, containerW, text]);

  // Shrink-to-fit once the natural text width is known. With a plain flex:1
  // the clip always ate the WHOLE text column, so anything rendered beside the
  // marquee — the verified badge — was shoved to the far right of the header,
  // sitting against the video-call button instead of next to the name. Giving
  // the clip an explicit width of the text and letting flexShrink cap it at
  // the space available keeps the marquee behaviour (a long name still
  // overflows and scrolls) while short names hug their badge.
  const clipStyle = textW > 0
    ? { flexGrow: 0, flexShrink: 1, flexBasis: 'auto', width: textW }
    : { flex: 1 };

  return (
    // Horizontal ScrollView (scrolling disabled) = an UNBOUNDED-width content
    // box, so the text lays out at its natural width and onLayout reports the
    // TRUE width. Measuring a numberOfLines-clipped Text inside a plain View
    // always reported textW <= containerW, so overflow never triggered — that
    // is why the marquee "didn't run".
    <ScrollView
      horizontal
      scrollEnabled={false}
      showsHorizontalScrollIndicator={false}
      style={[styles.marqueeClip, clipStyle]}
      onLayout={(e) => setContainerW(Math.floor(e.nativeEvent.layout.width))}
      pointerEvents="none"
    >
      <Animated.View style={[styles.marqueeRow, { transform: [{ translateX: scrollX }] }]}>
        <Text
          numberOfLines={1}
          style={style}
          onLayout={(e) => setTextW(Math.ceil(e.nativeEvent.layout.width))}
        >
          {text}
        </Text>
        {overflow && (
          <Text numberOfLines={1} style={[style, { marginLeft: MARQUEE_GAP }]}>
            {text}
          </Text>
        )}
      </Animated.View>
    </ScrollView>
  );
}

export default function ChatHeaderPresence({
  user,
  chatId,
  isPeerTyping,
  fallbackStatusText,
  onBack,
  onPressProfile,
  onPressAvatar,
  rightActions,
  getUserColor,
  isGroup,
  isBroadcast,
  isVerified,
  groupName,
  groupAvatar,
  memberCount,
  // Selection toolbar: when > 0 the header drops the avatar/name/status block
  // and renders WhatsApp's compact "back + count + actions" bar instead. With
  // the name column still mounted the action icons had no room and the last
  // one or two were pushed off the screen edge.
  selectionCount = 0,
}) {
  const { theme, isDarkMode } = useTheme();
  // Self-chat header only — my own handle + contact-privacy toggle.
  const myProfile = useSelector((state) => state.profile?.profileData);
  const { presence, lastSeenFormatted } = useUserPresence(isGroup ? null : user?._id);
  const realtimePresence = useRealtimeChatSlice(
    useCallback((s) => ((!isGroup && user?._id) ? s?.presenceByUser?.[user._id] : null), [isGroup, user?._id]),
  );
  const realtimeTyping = useRealtimeChatSlice(
    useCallback((s) => (chatId ? s?.typingStates?.[chatId] : null), [chatId]),
  );

  // `namesVersion` changes whenever the address book changes, so saving the
  // contact while this chat is OPEN flips the header name immediately — no
  // re-navigation, no restart (the old effect keyed on user._id alone never
  // re-ran and left a stale number/name on screen).
  const { resolveName, namesVersion } = useDisplayName();

  const [localContact, setLocalContact] = useState(null);
  useEffect(() => {
    if (isGroup || !user?._id) { setLocalContact(null); return; }
    let cancelled = false;
    ContactDatabase.getContactByUserId(String(user._id))
      .then((row) => { if (!cancelled) setLocalContact(row); })
      .catch(() => { if (!cancelled) setLocalContact(null); });
    return () => { cancelled = true; };
  }, [isGroup, user?._id, namesVersion]);

  // Live profile-photo override: reflect the peer's photo change in realtime
  // without leaving the chat. Resets when the peer changes.
  const [liveProfileImage, setLiveProfileImage] = useState(null);
  // Live override for the peer's handle + contact-privacy flag, pushed by
  // `contact:updated`. Null until the peer actually changes something, so the
  // chat's own cached peerUser stays authoritative until then.
  const [livePrivacy, setLivePrivacy] = useState(null);
  useEffect(() => {
    setLiveProfileImage(null);
    if (isGroup || !user?._id) return undefined;
    let socket = null;
    const onContactUpdated = (payload) => {
      const data = payload?.data || payload || {};
      const updatedId = String(data?.contactUserId || data?.userId || data?._id || '');
      if (!updatedId || updatedId !== String(user._id)) return;
      const image = data?.profileImage ?? data?.profilePicture;
      if (image !== undefined) setLiveProfileImage(image);
      // Contact privacy: the header shows the peer's NUMBER for an unsaved
      // contact, so it has to re-resolve the moment they hide it.
      if (data?.userName !== undefined || data?.hideContact !== undefined) {
        setLivePrivacy({
          userName: data?.userName ?? null,
          hideContact: Boolean(data?.hideContact),
        });
      }
    };
    const attach = () => {
      const s = getSocket?.();
      if (!s || socket === s) return;
      socket = s;
      s.on('contact:updated', onContactUpdated);
    };
    attach();
    const interval = setInterval(attach, 2000);
    return () => {
      clearInterval(interval);
      if (socket) socket.off('contact:updated', onContactUpdated);
    };
  }, [isGroup, user?._id]);

  const isRealtimeTyping = Boolean(
    realtimeTyping?.isTyping &&
    !isGroup &&
    user?._id &&
    String(realtimeTyping?.userId) === String(user?._id)
  );

  const effectivePresence = realtimePresence || presence || {};
  const normalizedStatus = (effectivePresence?.status || '').toLowerCase();

  // Offline text: prefer whichever source actually carries a lastSeen
  // timestamp (realtime update vs presence:get snapshot) so an offline peer
  // shows "last seen …" instead of a bare "offline".
  const effectiveLastSeen = effectivePresence?.lastSeen || presence?.lastSeen || null;
  const offlineText = effectiveLastSeen
    ? formatLastSeen(effectiveLastSeen)
    : (lastSeenFormatted && lastSeenFormatted !== 'offline' ? lastSeenFormatted : 'offline');

  // ChatScreen's legacy renderStatusText() returns the literal 'offline' when
  // ITS presence source has no lastSeen — that must not mask our lastSeen-aware
  // offlineText, so treat it as "no information".
  const effectiveFallback = (fallbackStatusText && fallbackStatusText !== 'offline')
    ? fallbackStatusText
    : null;

  const peerStatusText = (isPeerTyping || isRealtimeTyping)
    ? 'typing...'
    : (
      effectivePresence?.customStatus ||
      (normalizedStatus === 'online' ? 'online' : null) ||
      (normalizedStatus === 'away' ? 'away' : null) ||
      (normalizedStatus === 'busy' ? 'busy' : null) ||
      effectiveFallback ||
      offlineText
    );

  const groupStatusText = isPeerTyping
    ? 'typing...'
    : (memberCount ? `${memberCount} members` : 'tap here for group info');

  // Self chat ("Message yourself"): there is no peer to be online, typing or last
  // seen — the header shows the same one-line hint WhatsApp uses instead.
  const isSelf = isSelfChatId(chatId);

  const statusText = isBroadcast
    ? 'tap here for channel info'
    : isSelf ? 'Message yourself'
    : isGroup ? groupStatusText : peerStatusText;
  // ONE rule: my saved contact name → the peer's number → (only when no number
  // is known) the server profile name. `user.fullName` is the peer's OWN
  // account name — a push name — and must never outrank the number here.
  const peerPhone =
    localContact?.normalizedPhone
    || user?.mobileNumber
    || (user?.mobile?.number ? `${user.mobile.code || ''}${user.mobile.number}` : null)
    || user?.phone
    || null;
  const peerDisplayName = isGroup
    ? null
    : resolveName({
        userId: user?._id,
        phone: peerPhone,
        pushName: user?.fullName || user?.name,
        // Contact privacy — the header is surface #2; without these the peer's
        // number keeps showing after they hide it.
        // Both spellings — a peer built from a directory search row carries
        // `username`, a server peerUser carries `userName`.
        username: livePrivacy
          ? livePrivacy.userName
          : (user?.userName || user?.username || user?.publicUsername || null),
        hideContact: livePrivacy
          ? livePrivacy.hideContact
          : Boolean(user?.hideContact ?? user?.privacySettings?.hideContact),
        fallback: 'Unknown User',
      });
  // Prefer the live server photo (realtime override → chat's peerUser) so a
  // profile-picture change shows immediately; the locally-saved contact image
  // is only a stale snapshot, used last. Saved-contact NAME still wins above.
  const peerAvatar =
    liveProfileImage ||
    user?.profileImage ||
    user?.profilePicture ||
    localContact?.profileImage ||
    null;
  const displayName = isGroup
    ? (groupName || 'Group')
    : isSelf
      // Self chat: the "peer" is me, so my own privacy toggle decides the
      // label. `user` here is the row's peer snapshot and carries no
      // `hideContact`, so the profile slice is the source.
      ? selfChatLabel({
          mobileNumber: peerPhone,
          name: user?.fullName || user?.name,
          ...selfIdentityOf(myProfile),
        })
      : peerDisplayName;

  const isPeerOnline = !isGroup && normalizedStatus === 'online';
  const isTyping = isPeerTyping || isRealtimeTyping;
  const themeColor = theme.colors.themeColor;
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const bg = theme.colors.background;
  const borderColor = isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(15,30,50,0.08)';
  const ringColor = isPeerOnline ? theme.colors.themeColor :(themeColor + '30');

  const statusColor = isTyping
    ? themeColor
    : isPeerOnline ? theme.colors.themeColor :subText;

  if (selectionCount > 0) {
    return (
      <View style={[styles.root, { backgroundColor: bg, borderBottomColor: borderColor }]}>
        <TouchableOpacity onPress={onBack} activeOpacity={0.6} style={styles.backBtn}>
          <FontAwesome6 name="arrow-left" size={19} color={primaryText} />
        </TouchableOpacity>
        <Text style={[styles.selectionCount, { color: primaryText }]} numberOfLines={1}>
          {selectionCount}
        </Text>
        <View style={styles.selectionSpacer} />
        <View style={styles.selectionActions}>{rightActions}</View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: bg, borderBottomColor: borderColor }]}>
      <TouchableOpacity onPress={onBack} activeOpacity={0.6} style={styles.backBtn}>
        <FontAwesome6 name="arrow-left" size={19} color={primaryText} />
      </TouchableOpacity>

      <TouchableOpacity
        onPress={onPressAvatar || onPressProfile}
        activeOpacity={0.85}
        style={[styles.avatarRing, { borderColor: ringColor }]}
      >
        {isGroup ? (
          groupAvatar ? (
            <Image source={{ uri: groupAvatar }} style={styles.avatarImg} />
          ) : (
            <View style={[styles.avatarFallback, { backgroundColor: getUserColor?.(groupName || 'Group') || '#6C5CE7' }]}>
              <Ionicons name={isBroadcast ? 'megaphone' : 'people'} size={20} color="#fff" />
            </View>
          )
        ) : peerAvatar ? (
          <Image source={{ uri: peerAvatar }} style={styles.avatarImg} />
        ) : (
          <View style={[styles.avatarFallback, { backgroundColor: getUserColor?.(user?._id || '') || '#888' }]}>
            <Text style={styles.avatarLetter}>
              {displayName?.charAt(0)?.toUpperCase() || '?'}
            </Text>
          </View>
        )}
        {isPeerOnline && !isGroup && !isSelf && (
          <View style={[styles.onlineDot, { borderColor: bg }]} />
        )}
      </TouchableOpacity>

      <TouchableOpacity onPress={onPressProfile} activeOpacity={0.7} style={styles.textWrap}>
        <View style={styles.nameRow}>
          {/* Marquee, not a clipped Text. The header's text column is narrow
              (back + avatar on one side, video/call/menu on the other), so a
              long name — or an international number like +971 444 4 44… —
              was permanently truncated with no way to read the rest. The
              status line already scrolled; the name now does too, and both
              sit still when they fit. */}
          <MarqueeText
            text={displayName}
            style={[styles.nameText, { color: primaryText }]}
          />
          {isVerified && (
            <Ionicons name="checkmark-circle" size={15} color={themeColor} style={styles.verifiedBadge} />
          )}
        </View>
        <View style={styles.statusRow}>
          {isTyping && <View style={[styles.typingDot, { backgroundColor: themeColor }]} />}
          <MarqueeText
            text={statusText}
            style={[
              styles.statusText,
              {
                color: statusColor,
                fontStyle: isTyping ? 'italic' : 'normal',
              },
            ]}
          />
        </View>
      </TouchableOpacity>

      {rightActions}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: Platform.OS === 'ios' ? 8 : 10,
    // Tightened from 8/8/46 — every dp saved here goes to the name + last-seen
    // column, which is the part that was being cut off.
    gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 34, height: 40,
    justifyContent: 'center', alignItems: 'center',
    borderRadius: 12,
  },
  avatarRing: {
    width: 40, height: 40, borderRadius: 20,
    borderWidth: 2, padding: 1.5,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarImg: {
    width: '100%', height: '100%', borderRadius: 18,
  },
  avatarFallback: {
    width: '100%', height: '100%', borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarLetter: {
    color: '#fff',
    fontFamily: 'Roboto-Bold',
    fontSize: 17,
  },
  onlineDot: {
    position: 'absolute',
    bottom: 0, right: 0,
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: '#03b0a2',
    borderWidth: 2,
  },
  textWrap: {
    flex: 1,
    minWidth: 0,
    paddingLeft: 4,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // Never let the badge be the thing that gives up width when a long name
  // shrinks the marquee — it stays glued to the end of the name.
  verifiedBadge: {
    marginLeft: 4,
    flexShrink: 0,
  },
  nameText: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 16,
    letterSpacing: -0.1,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 2,
  },
  typingDot: {
    width: 5, height: 5, borderRadius: 2.5,
  },
  statusText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 12,
  },
  selectionCount: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 18,
    marginLeft: 2,
    minWidth: 18,
  },
  selectionSpacer: { flex: 1, minWidth: 4 },
  selectionActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
  },
  marqueeClip: {
    overflow: 'hidden',
  },
  marqueeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
});
