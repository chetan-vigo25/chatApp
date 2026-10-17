import React from 'react';
import { Ionicons } from '@expo/vector-icons';

// Media-type glyph for message previews (chat list, archived list, reply and
// quote cards). The chat-list summary string carries the type as an emoji
// (📷 📹 …, see MESSAGE_TYPE_ICON_MAP in RealtimeChatContext); this maps that
// marker onto the Ionicons set already used for ticks so icon, tick and text
// share one size, alignment and ink. Pure visual: the summary text is unchanged
// apart from the emoji being drawn as a vector icon instead.
export const PREVIEW_ICON_SIZE = 15;

const EMOJI_TO_ICON = {
  '📷': 'image-outline',
  '📹': 'videocam-outline',
  '🎵': 'musical-notes-outline',
  '📎': 'document-outline',
  '📍': 'location-outline',
  '👤': 'person-outline',
  '✨': 'sparkles-outline',
  '🎞️': 'film-outline',
  '🖼️': 'images-outline',
  '📞': 'call-outline',
};

// Message `type` strings (reply / quote cards) -> icon name.
const TYPE_TO_ICON = {
  image: 'image-outline',
  photo: 'image-outline',
  video: 'videocam-outline',
  audio: 'musical-notes-outline',
  voice: 'mic-outline',
  file: 'document-outline',
  document: 'document-outline',
  location: 'location-outline',
  contact: 'person-outline',
  sticker: 'sparkles-outline',
  gif: 'film-outline',
  album: 'images-outline',
};

export const iconNameForEmoji = (emoji, body) => {
  if (!emoji) return null;
  if (emoji === '🎵' && /voice/i.test(body || '')) return 'mic-outline';
  return EMOJI_TO_ICON[emoji] || null;
};
export const iconNameForType = (type) => TYPE_TO_ICON[String(type || '').toLowerCase()] || null;

// Removes the first occurrence of the emoji marker (and its trailing space).
export const stripPreviewEmoji = (text, emoji) => {
  if (!emoji || typeof text !== 'string') return text;
  return text.replace(`${emoji} `, '').replace(emoji, '');
};

const MessageTypeIcon = ({ name, color, size = PREVIEW_ICON_SIZE, style }) => {
  if (!name) return null;
  return <Ionicons name={name} size={size} color={color} style={style} />;
};

export default MessageTypeIcon;
