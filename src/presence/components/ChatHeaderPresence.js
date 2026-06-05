import React, { useEffect, useState } from 'react';
import { Image, Text, TouchableOpacity, View, StyleSheet, Platform } from 'react-native';
import { FontAwesome6, Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import useUserPresence from '../hooks/useUserPresence';
import { useRealtimeChat } from '../../contexts/RealtimeChatContext';
import ContactDatabase from '../../services/ContactDatabase';
import { getSocket } from '../../Redux/Services/Socket/socket';

export default function ChatHeaderPresence({
  user,
  chatId,
  isPeerTyping,
  fallbackStatusText,
  onBack,
  onPressProfile,
  rightActions,
  getUserColor,
  isGroup,
  groupName,
  groupAvatar,
  memberCount,
}) {
  const { theme, isDarkMode } = useTheme();
  const { presence, lastSeenFormatted } = useUserPresence(isGroup ? null : user?._id);
  const { state } = useRealtimeChat();

  const [localContact, setLocalContact] = useState(null);
  useEffect(() => {
    if (isGroup || !user?._id) { setLocalContact(null); return; }
    let cancelled = false;
    ContactDatabase.getContactByUserId(String(user._id))
      .then((row) => { if (!cancelled) setLocalContact(row); })
      .catch(() => { if (!cancelled) setLocalContact(null); });
    return () => { cancelled = true; };
  }, [isGroup, user?._id]);

  // Live profile-photo override: reflect the peer's photo change in realtime
  // without leaving the chat. Resets when the peer changes.
  const [liveProfileImage, setLiveProfileImage] = useState(null);
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

  const realtimePresence = (!isGroup && user?._id) ? state?.presenceByUser?.[user._id] : null;
  const realtimeTyping = chatId ? state?.typingStates?.[chatId] : null;
  const isRealtimeTyping = Boolean(
    realtimeTyping?.isTyping &&
    !isGroup &&
    user?._id &&
    String(realtimeTyping?.userId) === String(user?._id)
  );

  const effectivePresence = realtimePresence || presence || {};
  const normalizedStatus = (effectivePresence?.status || '').toLowerCase();

  const peerStatusText = (isPeerTyping || isRealtimeTyping)
    ? 'typing...'
    : (
      effectivePresence?.customStatus ||
      (normalizedStatus === 'online' ? 'online' : null) ||
      (normalizedStatus === 'away' ? 'away' : null) ||
      (normalizedStatus === 'busy' ? 'busy' : null) ||
      fallbackStatusText ||
      (effectivePresence?.lastSeen ? `last seen ${lastSeenFormatted?.replace('last seen ', '')}` : null) ||
      lastSeenFormatted ||
      (normalizedStatus === 'offline' ? 'offline' : null) ||
      'offline'
    );

  const groupStatusText = isPeerTyping
    ? 'typing...'
    : (memberCount ? `${memberCount} members` : 'tap here for group info');

  const statusText = isGroup ? groupStatusText : peerStatusText;
  const peerDisplayName =
    localContact?.fullName ||
    user?.fullName ||
    user?.name ||
    'Unknown User';
  // Prefer the live server photo (realtime override → chat's peerUser) so a
  // profile-picture change shows immediately; the locally-saved contact image
  // is only a stale snapshot, used last. Saved-contact NAME still wins above.
  const peerAvatar =
    liveProfileImage ||
    user?.profileImage ||
    user?.profilePicture ||
    localContact?.profileImage ||
    null;
  const displayName = isGroup ? (groupName || 'Group') : peerDisplayName;

  const isPeerOnline = !isGroup && normalizedStatus === 'online';
  const isTyping = isPeerTyping || isRealtimeTyping;
  const themeColor = theme.colors.themeColor;
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const bg = theme.colors.background;
  const borderColor = isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(15,30,50,0.08)';
  const ringColor = isPeerOnline ? '#25D366' : (themeColor + '30');

  const statusColor = isTyping
    ? themeColor
    : isPeerOnline ? '#25D366' : subText;

  return (
    <View style={[styles.root, { backgroundColor: bg, borderBottomColor: borderColor }]}>
      <TouchableOpacity onPress={onBack} activeOpacity={0.6} style={styles.backBtn}>
        <FontAwesome6 name="arrow-left" size={19} color={primaryText} />
      </TouchableOpacity>

      <TouchableOpacity
        onPress={onPressProfile}
        activeOpacity={0.85}
        style={[styles.avatarRing, { borderColor: ringColor }]}
      >
        {isGroup ? (
          groupAvatar ? (
            <Image source={{ uri: groupAvatar }} style={styles.avatarImg} />
          ) : (
            <View style={[styles.avatarFallback, { backgroundColor: getUserColor?.(groupName || 'Group') || '#6C5CE7' }]}>
              <Ionicons name="people" size={20} color="#fff" />
            </View>
          )
        ) : peerAvatar ? (
          <Image source={{ uri: peerAvatar }} style={styles.avatarImg} />
        ) : (
          <View style={[styles.avatarFallback, { backgroundColor: getUserColor?.(user?._id || '') || '#888' }]}>
            <Text style={styles.avatarLetter}>
              {peerDisplayName?.charAt(0).toUpperCase() || '?'}
            </Text>
          </View>
        )}
        {isPeerOnline && !isGroup && (
          <View style={[styles.onlineDot, { borderColor: bg }]} />
        )}
      </TouchableOpacity>

      <TouchableOpacity onPress={onPressProfile} activeOpacity={0.7} style={styles.textWrap}>
        <Text
          numberOfLines={1}
          style={[styles.nameText, { color: primaryText }]}
        >
          {displayName}
        </Text>
        <View style={styles.statusRow}>
          {isTyping && <View style={[styles.typingDot, { backgroundColor: themeColor }]} />}
          <Text
            numberOfLines={1}
            style={[
              styles.statusText,
              {
                color: statusColor,
                fontStyle: isTyping ? 'italic' : 'normal',
              },
            ]}
          >
            {statusText}
          </Text>
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
    paddingHorizontal: 8,
    paddingVertical: Platform.OS === 'ios' ? 8 : 10,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 40, height: 40,
    justifyContent: 'center', alignItems: 'center',
    borderRadius: 12,
  },
  avatarRing: {
    width: 46, height: 46, borderRadius: 23,
    borderWidth: 2, padding: 1.5,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarImg: {
    width: '100%', height: '100%', borderRadius: 21,
  },
  avatarFallback: {
    width: '100%', height: '100%', borderRadius: 21,
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
    backgroundColor: '#25D366',
    borderWidth: 2,
  },
  textWrap: {
    flex: 1,
    paddingLeft: 4,
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
});
