import React, { useEffect, useState } from 'react';
import { Image, Text, TouchableOpacity, View } from 'react-native';
import { FontAwesome6, Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import useUserPresence from '../hooks/useUserPresence';
import { useRealtimeChat } from '../../contexts/RealtimeChatContext';
import ContactDatabase from '../../services/ContactDatabase';

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
  const { theme } = useTheme();
  const { presence, lastSeenFormatted } = useUserPresence(isGroup ? null : user?._id);
  const { state } = useRealtimeChat();

  // Look up the device-saved (SQLite) contact by userId. If present, use the
  // locally-saved name/image so the header always matches the user's phonebook.
  const [localContact, setLocalContact] = useState(null);
  useEffect(() => {
    if (isGroup || !user?._id) { setLocalContact(null); return; }
    let cancelled = false;
    ContactDatabase.getContactByUserId(String(user._id))
      .then((row) => { if (!cancelled) setLocalContact(row); })
      .catch(() => { if (!cancelled) setLocalContact(null); });
    return () => { cancelled = true; };
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

  // Status text for 1:1 chats
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

  // For groups: show member count or typing indicator
  const groupStatusText = isPeerTyping
    ? 'typing...'
    : (memberCount ? `${memberCount} members` : 'tap here for group info');

  const statusText = isGroup ? groupStatusText : peerStatusText;
  // Display name priority for 1:1 chats:
  //   1. Local device contact name (SQLite)
  //   2. peerUser fullName passed via route
  //   3. Fallback
  const peerDisplayName =
    localContact?.fullName ||
    user?.fullName ||
    user?.name ||
    'Unknown User';
  const peerAvatar =
    localContact?.profileImage ||
    user?.profileImage ||
    user?.profilePicture ||
    null;
  const displayName = isGroup ? (groupName || 'Group') : peerDisplayName;

  const isPeerOnline = !isGroup && normalizedStatus === 'online';
  const borderColor = isGroup ? '#ececec' : (isPeerOnline ? '#2CC84D' : '#ececec');

  return (
    <View style={{ width: '100%', flexDirection: 'row', alignItems: 'center', padding: 10, gap: 10, backgroundColor: theme.colors.background,
        borderBottomColor: theme.colors.borderColor,}} >
      <TouchableOpacity onPress={onBack} style={{ width: 40, height: 40, justifyContent: 'center', alignItems: 'center' }}>
        <FontAwesome6 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
      </TouchableOpacity>

      <TouchableOpacity onPress={onPressProfile} style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor }}>
        {isGroup ? (
          groupAvatar ? (
            <Image source={{ uri: groupAvatar }} style={{ width: '100%', height: '100%', borderRadius: 24 }} />
          ) : (
            <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: getUserColor?.(groupName || 'Group') || '#6C5CE7' }}>
              <Ionicons name="people" size={20} color="#fff" />
            </View>
          )
        ) : peerAvatar ? (
          <Image source={{ uri: peerAvatar }} style={{ width: '100%', height: '100%', borderRadius: 24 }} />
        ) : (
          <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: getUserColor?.(user?._id || '') || '#888' }}>
            <Text style={{ color: theme.colors.textWhite, fontFamily: 'Roboto-Medium', fontSize: 18 }}>
              {peerDisplayName?.charAt(0).toUpperCase() || '?'}
            </Text>
          </View>
        )}
      </TouchableOpacity>

      <TouchableOpacity onPress={onPressProfile} activeOpacity={0.7} style={{ flex: 1 }}>
        <Text style={{ color: theme.colors.primaryTextColor, fontFamily: 'Roboto-Medium', fontSize: 16 }} numberOfLines={1}>
          {displayName}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            color: (isPeerTyping || isRealtimeTyping)
              ? theme.colors.themeColor
              : (isPeerOnline ? '#2CC84D' : theme.colors.placeHolderTextColor),
            fontFamily: 'Roboto-Medium',
            fontSize: 12,
            fontStyle: (isPeerTyping || isRealtimeTyping) ? 'italic' : 'normal',
          }}
        >
          {statusText}
        </Text>
      </TouchableOpacity>

      {rightActions}
    </View>
  );
}