import React from 'react';
import { Image, Text, TouchableOpacity, View } from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import useUserPresence from '../hooks/useUserPresence';
import { useRealtimeChat } from '../../contexts/RealtimeChatContext';

export default function ChatHeaderPresence({
  user,
  chatId,
  isPeerTyping,
  fallbackStatusText,
  onBack,
  onPressProfile,
  rightActions,
  getUserColor,
}) {
  const { theme } = useTheme();
  const { presence, lastSeenFormatted } = useUserPresence(user?._id);
  const { state } = useRealtimeChat();

  const realtimePresence = user?._id ? state?.presenceByUser?.[user._id] : null;
  const realtimeTyping = chatId ? state?.typingStates?.[chatId] : null;
  const isRealtimeTyping = Boolean(
    realtimeTyping?.isTyping &&
    user?._id &&
    String(realtimeTyping?.userId) === String(user?._id)
  );

  const effectivePresence = realtimePresence || presence || {};

  const normalizedStatus = (effectivePresence?.status || '').toLowerCase();
  const statusText = (isPeerTyping || isRealtimeTyping)
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

  const borderColor = normalizedStatus === 'online' ? '#2CC84D' : '#ececec';

  return (
    <View style={{ width: '100%', flexDirection: 'row', alignItems: 'center', padding: 10, gap: 10, backgroundColor: theme.colors.background,
        // borderBottomWidth: 1,
        borderBottomColor: theme.colors.borderColor,}} >
      <TouchableOpacity onPress={onBack} style={{ width: 40, height: 40, justifyContent: 'center', alignItems: 'center' }}>
        <FontAwesome6 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
      </TouchableOpacity>

      <TouchableOpacity onPress={onPressProfile} style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor }}>
        {user?.profileImage ? (
          <Image source={{ uri: user.profileImage }} style={{ width: '100%', height: '100%', borderRadius: 24 }} />
        ) : (
          <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: getUserColor?.(user?._id || '') || '#888' }}>
            <Text style={{ color: theme.colors.textWhite, fontFamily: 'Poppins-Medium', fontSize: 18 }}>
              {user?.fullName?.charAt(0).toUpperCase() || '?'}
            </Text>
          </View>
        )}
      </TouchableOpacity>

      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.colors.primaryTextColor, fontFamily: 'Poppins-Medium', fontSize: 16 }}>
          {user?.fullName || 'Unknown User'}
        </Text>
        <Text
          style={{
            color: (isPeerTyping || isRealtimeTyping) ? theme.colors.themeColor : theme.colors.placeHolderTextColor,
            fontFamily: 'Poppins-Medium',
            fontSize: 12,
            fontStyle: (isPeerTyping || isRealtimeTyping) ? 'italic' : 'normal',
          }}
        >
          {statusText}
        </Text>
      </View>

      {rightActions}
    </View>
  );
}