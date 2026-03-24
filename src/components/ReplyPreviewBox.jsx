import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

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

const ReplyPreviewBox = React.memo(function ReplyPreviewBox({
  replyTarget,
  currentUserId,
  onClose,
  theme,
  chatColor,
  isDarkMode,
}) {
  if (!replyTarget) return null;

  const isMe = replyTarget.senderId && String(replyTarget.senderId) === String(currentUserId);
  const senderLabel = isMe ? 'You' : (replyTarget.senderName || 'Unknown');
  const msgType = (replyTarget.type || 'text').toLowerCase();
  const isMedia = msgType !== 'text' && msgType !== 'system';
  const previewText = replyTarget.isDeleted
    ? 'This message was deleted'
    : isMedia
      ? (MEDIA_LABELS[msgType] || replyTarget.text || 'Media')
      : (replyTarget.text || '');

  const accentColor = isMe ? (chatColor || '#25D366') : '#6B8AFF';
  const bgColor = isDarkMode ? '#1E2D36' : '#E8EDF2';
  const textColor = isDarkMode ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)';

  return (
    <View style={[styles.container, { backgroundColor: bgColor }]}>
      <View style={[styles.accentBar, { backgroundColor: accentColor }]} />
      <View style={styles.content}>
        <Text
          style={[styles.senderName, { color: accentColor }]}
          numberOfLines={1}
        >
          {senderLabel}
        </Text>
        <Text
          style={[styles.previewText, {
            color: textColor,
            fontStyle: replyTarget.isDeleted ? 'italic' : 'normal',
          }]}
          numberOfLines={1}
        >
          {previewText}
        </Text>
      </View>
      <TouchableOpacity
        onPress={onClose}
        style={styles.closeBtn}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Ionicons name="close" size={20} color={isDarkMode ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)'} />
      </TouchableOpacity>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 10,
    marginBottom: 0,
    borderRadius: 10,
    overflow: 'hidden',
  },
  accentBar: {
    width: 4,
    alignSelf: 'stretch',
    minHeight: 42,
  },
  content: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  senderName: {
    fontSize: 14,
    fontFamily: 'Roboto-SemiBold',
    marginBottom: 1,
  },
  previewText: {
    fontSize: 14,
    fontFamily: 'Roboto-Regular',
  },
  closeBtn: {
    padding: 10,
    marginRight: 2,
  },
});

export default ReplyPreviewBox;
