import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

const MEDIA_LABELS = {
  image: '📷 Photo',
  photo: '📷 Photo',
  video: '📹 Video',
  audio: '🎵 Audio',
  file: '📎 Document',
  document: '📎 Document',
  location: '📍 Location',
  contact: '👤 Contact',
};

const ReplyBubble = React.memo(function ReplyBubble({
  replyToMessageId,
  replyPreviewText,
  replyPreviewType,
  replySenderName,
  replySenderId,
  currentUserId,
  isMyMessage,
  onPress,
  chatColor,
  theme,
}) {
  if (!replyToMessageId) return null;

  const isRepliedToMe = replySenderId && String(replySenderId) === String(currentUserId);
  const senderLabel = isRepliedToMe ? 'You' : (replySenderName || 'Unknown');
  const msgType = (replyPreviewType || 'text').toLowerCase();
  const isMedia = msgType !== 'text' && msgType !== 'system';
  const isDeleted = replyPreviewText === 'This message was deleted';
  const displayText = isDeleted
    ? 'This message was deleted'
    : isMedia
      ? (MEDIA_LABELS[msgType] || replyPreviewText || 'Media')
      : (replyPreviewText || 'Message');

  // WhatsApp style: sender-specific accent color
  const accentColor = isRepliedToMe
    ? (chatColor || '#25D366')
    : '#6B8AFF';

  return (
    <TouchableOpacity
      onPress={() => onPress?.(replyToMessageId)}
      activeOpacity={0.7}
      style={[
        styles.container,
        {
          backgroundColor: isMyMessage
            ? 'rgba(0,0,0,0.15)'
            : (theme.colors.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)'),
        },
      ]}
    >
      <View style={[styles.accentBar, { backgroundColor: accentColor }]} />
      <View style={styles.content}>
        <Text
          style={[styles.senderName, { color: accentColor }]}
          numberOfLines={1}
        >
          {senderLabel}
        </Text>
        <Text
          style={[
            styles.previewText,
            {
              color: isMyMessage
                ? 'rgba(255,255,255,0.75)'
                : (theme.colors.secondaryTextColor || theme.colors.placeHolderTextColor),
              fontStyle: isDeleted ? 'italic' : 'normal',
            },
          ]}
          numberOfLines={2}
        >
          {displayText}
        </Text>
      </View>
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    borderRadius: 8,
    marginBottom: 4,
    marginTop: 2,
    overflow: 'hidden',
    minWidth: 150,
  },
  accentBar: {
    width: 4,
    alignSelf: 'stretch',
  },
  content: {
    flex: 1,
    paddingVertical: 6,
    paddingHorizontal: 10,
    paddingRight: 12,
  },
  senderName: {
    fontSize: 13,
    fontFamily: 'Roboto-SemiBold',
    marginBottom: 2,
  },
  previewText: {
    fontSize: 13,
    fontFamily: 'Roboto-Regular',
    lineHeight: 17,
  },
});

export default ReplyBubble;