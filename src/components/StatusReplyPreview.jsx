import React from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/**
 * StatusReplyPreview
 * ──────────────────
 * Compact quote card rendered above a chat bubble when the message was sent
 * as a reply to (or share of) a Status. Visual grammar matches the existing
 * ReplyBubble (4px accent stripe + tinted overlay + 13px semibold header +
 * muted 13px body) so the two read as siblings inside the same bubble.
 *
 * WhatsApp-specific touches:
 *  • Tiny reply-arrow glyph beside the header
 *  • Right-aligned 48×48 thumbnail (4px radius) flush to the card edge
 *  • Play badge overlay for video statuses
 *  • Colored swatch with the first letter for text-only statuses
 *  • Inline camera / video glyph in the subtitle for media types
 */

// Accent palette mirrors ReplyBubble — green for self, soft blue-violet for
// others. Status replies always read as "green-ish" in WhatsApp because the
// brand colour is the visual anchor for the Status feature.
const SELF_ACCENT  = '#25D366';
const OTHER_ACCENT = '#53BDEB'; // WhatsApp's secondary accent (light teal)

const StatusReplyPreview = React.memo(function StatusReplyPreview({
  statusRef,
  statusPreview,
  isMyMessage,
  chatColor,
  theme,
  onPress,
}) {
  if (!statusRef || !statusPreview) return null;

  const mediaType = String(statusPreview.mediaType || 'text').toLowerCase();
  const isImage   = mediaType === 'image';
  const isVideo   = mediaType === 'video';
  const isLink    = mediaType === 'link';
  const isText    = !isImage && !isVideo && !isLink;

  const thumb = statusPreview.thumbnailUrl || statusPreview.mediaUrl || null;

  // Accent colour: green when the bubble is mine, light-teal otherwise.
  // chatColor is honoured if the user has customised the theme.
  const accent = isMyMessage
    ? (chatColor || SELF_ACCENT)
    : OTHER_ACCENT;

  // Card background — sits one layer "deeper" than the bubble so the quote
  // feels recessed. The numeric values mirror ReplyBubble exactly so both
  // cards have the same visual weight when stacked.
  const isDark = !!theme?.colors?.isDark;
  const cardBg = isMyMessage
    ? 'rgba(0,0,0,0.13)'
    : (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.045)');

  // Subtitle palette
  const subtitleColor = isMyMessage
    ? 'rgba(255,255,255,0.82)'
    : (theme?.colors?.secondaryTextColor
        || theme?.colors?.placeHolderTextColor
        || '#667781');

  // Subtitle text — WhatsApp shows the caption when present, otherwise a
  // typed label ("Photo" / "Video" / "Text status").
  const subtitleText = (statusPreview.text && String(statusPreview.text).trim())
    || (isVideo ? 'Video status' : isImage ? 'Photo status' : isLink ? 'Link' : 'Text status');

  // First glyph for text statuses — WhatsApp shows a capitalised initial on
  // the swatch, falling back to a quote mark when the body is empty.
  const swatchLetter = (() => {
    const t = (statusPreview.text || '').trim();
    if (!t) return '“';
    return t.charAt(0).toUpperCase();
  })();

  // Inline icon shown before the subtitle for media types — WhatsApp pattern.
  const inlineIcon = isImage
    ? <Ionicons name="camera"      size={12} color={subtitleColor} style={styles.inlineIcon} />
    : isVideo
      ? <Ionicons name="videocam"  size={12} color={subtitleColor} style={styles.inlineIcon} />
      : isLink
        ? <Ionicons name="link"    size={12} color={subtitleColor} style={styles.inlineIcon} />
        : null;

  return (
    <TouchableOpacity
      onPress={() => onPress?.(statusRef, statusPreview)}
      activeOpacity={0.72}
      style={[styles.container, { backgroundColor: cardBg }]}
    >
      {/* 4px vertical accent — same width/rule as ReplyBubble */}
      <View style={[styles.accentBar, { backgroundColor: accent }]} />

      {/* Body */}
      <View style={styles.body}>
        <View style={styles.headerRow}>
          <Ionicons
            name="arrow-undo"
            size={11}
            color={accent}
            style={styles.headerIcon}
          />
          <Text
            style={[styles.headerText, { color: accent }]}
            numberOfLines={1}
          >
            {statusPreview.ownerName
              ? `${statusPreview.ownerName}’s status`
              : 'Status'}
          </Text>
        </View>

        <View style={styles.subtitleRow}>
          {inlineIcon}
          <Text
            style={[styles.subtitle, { color: subtitleColor }]}
            numberOfLines={1}
          >
            {subtitleText}
          </Text>
        </View>
      </View>

      {/* Thumbnail */}
      <View style={styles.thumbWrap}>
        {(isImage || isVideo) && thumb ? (
          <>
            <Image
              source={{ uri: thumb }}
              style={styles.thumbImage}
              resizeMode="cover"
            />
            {isVideo && (
              <View style={styles.playBadge}>
                <Ionicons name="play" size={12} color="#fff" />
              </View>
            )}
          </>
        ) : (
          // Text / link status — render a coloured swatch with the first
          // letter of the caption, mirroring WhatsApp's text-status card.
          <View
            style={[
              styles.textSwatch,
              { backgroundColor: statusPreview.backgroundColor || '#075E54' },
            ]}
          >
            <Text style={styles.textSwatchGlyph} numberOfLines={1}>
              {swatchLetter}
            </Text>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
});

const THUMB_SIZE = 44;

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: 7.5,
    marginBottom: 4,
    marginTop: 1,
    overflow: 'hidden',
    minWidth: 190,
    maxWidth: 280,
    minHeight: THUMB_SIZE + 8,
  },
  accentBar: {
    width: 4,
    alignSelf: 'stretch',
  },
  body: {
    flex: 1,
    paddingVertical: 6,
    paddingHorizontal: 9,
    paddingRight: 8,
    justifyContent: 'center',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  headerIcon: {
    marginRight: 4,
    marginTop: 1,
  },
  headerText: {
    fontSize: 13,
    fontFamily: 'Roboto-SemiBold',
    fontWeight: '600',
    letterSpacing: 0.1,
    flexShrink: 1,
  },
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  inlineIcon: {
    marginRight: 4,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: 'Roboto-Regular',
    lineHeight: 17,
    flexShrink: 1,
  },
  thumbWrap: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: 4,
    marginVertical: 4,
    marginRight: 4,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.06)',
    alignSelf: 'center',
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  playBadge: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.32)',
  },
  textSwatch: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  textSwatchGlyph: {
    color: '#FFFFFF',
    fontSize: 20,
    fontFamily: 'Roboto-SemiBold',
    fontWeight: '600',
    lineHeight: 22,
  },
});

export default StatusReplyPreview;
