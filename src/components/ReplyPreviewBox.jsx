import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import MessageTypeIcon, { iconNameForType } from './MessageTypeIcon';
import { senderNameColorFor } from '../contexts/ThemeContext';
import AppImage from './AppImage';

const MEDIA_LABELS = {
  image: '📷 Photo',
  photo: '📷 Photo',
  video: '📹 Video',
  audio: '🎵 Audio',
  file: '📎 Document',
  document: '📎 Document',
  location: '📍 Location',
  contact: '👤 Contact',
  album: '🖼 Album',
};

// A video FILE fed into <AppImage> paints black — only real posters qualify.
const isVideoFileUrl = (u) =>
  /\.(mp4|mov|m4v|webm|mkv|avi|3gp)(\?|$)/i.test(String(u || '')) ||
  /\/uploads\/chat\/video\//i.test(String(u || ''));

// Small media thumb for the strip. This runs on the SENDER'S device, so
// local file:// uris are fine for images; videos need a poster URL.
const resolveThumb = (target) => {
  const type = (target?.type || target?.mediaType || 'text').toLowerCase();
  const first = Array.isArray(target?.mediaItems) && target.mediaItems.length
    ? target.mediaItems[0]
    : null;
  const candidates = first
    ? [first.mediaThumbnailUrl, first.localUri, first.mediaUrl]
    : [target?.mediaThumbnailUrl, target?.localUri, target?.previewUrl, target?.mediaUrl];
  if (!['image', 'photo', 'video', 'album'].includes(type)) return null;
  return candidates.find((u) => u && !isVideoFileUrl(u)) || null;
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
  const typeIcon = (!replyTarget.isDeleted && isMedia) ? iconNameForType(msgType) : null;
  const rawPreview = replyTarget.isDeleted
    ? 'This message was deleted'
    : isMedia
      ? (MEDIA_LABELS[msgType] || replyTarget.text || 'Media')
      : (replyTarget.text || '');
  const previewText = typeIcon ? rawPreview.replace(/^[^\p{L}\p{N}]+/u, '') : rawPreview;
  const thumbUri = replyTarget.isDeleted ? null : resolveThumb(replyTarget);

  // Theme tokens (link = 6.6:1 light / 9.7 dark; sender palette is contrast-validated).
  const accentColor = isMe ? theme.colors.link : senderNameColorFor(replyTarget.senderId || replyTarget.senderName, isDarkMode);
  const bgColor = theme.colors.replyBarBg;
  const textColor = theme.colors.bubbleMeta;

  return (
    <View style={[styles.container, { backgroundColor: bgColor }]}>
      <View style={[styles.accentBar, { backgroundColor: accentColor }]} />
      <View style={styles.content}>
        <Text
          maxFontSizeMultiplier={1.5}
          style={[styles.senderName, { color: accentColor }]}
          numberOfLines={1}
        >
          {senderLabel}
        </Text>
        <View style={styles.previewRow}>
          {typeIcon ? <MessageTypeIcon name={typeIcon} size={14} color={textColor} style={styles.previewIcon} /> : null}
          <Text
          maxFontSizeMultiplier={1.5}
          style={[styles.previewText, {
            color: textColor,
            fontStyle: replyTarget.isDeleted ? 'italic' : 'normal',
          }]}
          numberOfLines={1}
        >
          {previewText}
        </Text>
        </View>
      </View>
      {thumbUri ? (
        <AppImage source={{ uri: thumbUri }} style={styles.thumb} resizeMode="cover" />
      ) : null}
      <TouchableOpacity
        onPress={onClose}
        style={styles.closeBtn}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        accessibilityRole="button"
        accessibilityLabel="Cancel reply"
      >
        <Ionicons name="close" size={20} color={theme.colors.iconColor} />
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
  previewRow: { flexDirection: 'row', alignItems: 'center' },
  previewIcon: { marginRight: 4 },
  previewText: {
    flexShrink: 1,
    fontSize: 14,
    fontFamily: 'Roboto-Regular',
  },
  thumb: {
    width: 42,
    height: 42,
    borderRadius: 6,
    marginRight: 4,
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  closeBtn: {
    padding: 10,
    marginRight: 2,
  },
});

export default ReplyPreviewBox;
