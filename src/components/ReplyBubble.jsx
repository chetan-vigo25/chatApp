import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { cachedImageSource } from '../utils/imageSource';
import MessageTypeIcon, { iconNameForType } from './MessageTypeIcon';
import { outgoingPaletteFor, sentBubbleBgFor, senderNameColorFor, withAlpha } from '../contexts/ThemeContext';

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

const ReplyBubble = React.memo(function ReplyBubble({
  replyToMessageId,
  replyPreviewText,
  replyPreviewType,
  replySenderName,
  replySenderId,
  replyThumbnailUrl,
  currentUserId,
  isMyMessage,
  onPress,
  chatColor,
  theme,
  isDarkMode = false,
}) {
  if (!replyToMessageId) return null;

  const isRepliedToMe = replySenderId && String(replySenderId) === String(currentUserId);
  const senderLabel = isRepliedToMe ? 'You' : (replySenderName || 'Unknown');
  const msgType = (replyPreviewType || 'text').toLowerCase();
  const isMedia = msgType !== 'text' && msgType !== 'system';
  const isDeleted = replyPreviewText === 'This message was deleted';
  // Small thumbnail only for visual quotes that actually have a URL.
  const showThumb = !isDeleted
    && (msgType === 'image' || msgType === 'photo' || msgType === 'video' || msgType === 'album')
    && Boolean(replyThumbnailUrl);
  // Media type is drawn as a vector icon (same set/size as the chat list);
  // the emoji in the label is dropped so it is not shown twice.
  const typeIcon = (!isDeleted && isMedia) ? iconNameForType(msgType) : null;
  const rawDisplay = isDeleted
    ? 'This message was deleted'
    : isMedia
      ? (MEDIA_LABELS[msgType] || replyPreviewText || 'Media')
      : (replyPreviewText || 'Message');
  const displayText = typeIcon ? rawDisplay.replace(/^[^\p{L}\p{N}]+/u, '') : rawDisplay;

  // Quote bar + name colour. Inside an OUTGOING bubble they derive from the
  // bubble (contrast-checked for any accent swatch — the old chatColor bar
  // vanished when quoting yourself on an accent-coloured bubble, T-07).
  // Inside an incoming bubble: link token for "you", validated sender palette
  // for the other person.
  const out = isMyMessage ? outgoingPaletteFor(sentBubbleBgFor(chatColor, theme), theme) : null;
  const accentColor = isMyMessage
    ? out.link
    : (isRepliedToMe ? theme.colors.link : senderNameColorFor(replySenderId || replySenderName, isDarkMode));

  return (
    <TouchableOpacity
      onPress={() => onPress?.(replyToMessageId)}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`Quoted message from ${senderLabel}: ${displayText}`}
      accessibilityHint="Jumps to the original message"
      style={[
        styles.container,
        {
          backgroundColor: isMyMessage
            ? withAlpha(out.text, 0.10)
            // `theme.colors.isDark` never existed — ThemeContext exposes
            // `isDarkMode` on the provider, not inside `colors` — so this
            // ALWAYS took the light branch and painted a dark wash on a dark
            // bubble: the reply card was practically invisible in dark mode.
            : (isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)'),
        },
      ]}
    >
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
          {typeIcon ? (
            <MessageTypeIcon
              name={typeIcon}
              size={14}
              color={isMyMessage ? out.meta : (theme.colors.bubbleMeta || theme.colors.secondaryTextColor)}
              style={styles.previewIcon}
            />
          ) : null}
          <Text
            maxFontSizeMultiplier={1.5}
            style={[
              styles.previewText,
            {
              color: isMyMessage
                ? out.meta
                : (theme.colors.bubbleMeta || theme.colors.secondaryTextColor),
              fontStyle: isDeleted ? 'italic' : 'normal',
            },
          ]}
          numberOfLines={2}
        >
          {displayText}
        </Text>
        </View>
      </View>
      {showThumb && (
        <Image source={cachedImageSource(replyThumbnailUrl)} style={styles.thumb} contentFit="cover" cachePolicy="memory-disk" />
      )}
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
  previewRow: { flexDirection: 'row', alignItems: 'center' },
  previewIcon: { marginRight: 4 },
  previewText: {
    flexShrink: 1,
    fontSize: 13,
    fontFamily: 'Roboto-Regular',
    lineHeight: 17,
  },
  thumb: {
    width: 38,
    height: 38,
    borderRadius: 4,
    alignSelf: 'center',
    marginRight: 6,
    marginLeft: 2,
    backgroundColor: 'rgba(0,0,0,0.1)',
  },
});

export default ReplyBubble;