import React, { useMemo } from 'react';
import { Text } from 'react-native';

// ── MentionText ──
// Renders message text with highlighted @mentions.
//
// Props:
//   text: string         — the raw message text
//   mentions: Array      — [{ userId, displayName, startIndex, length }]
//   baseColor: string    — default text color
//   mentionColor: string — highlight color for mentions
//   style: object        — additional text styles
//   onMentionPress: fn   — optional callback(userId, displayName)

const MENTION_HIGHLIGHT_COLOR = '#1DA1F2';

const MentionText = React.memo(function MentionText({
  text,
  mentions,
  baseColor,
  mentionColor,
  style,
  onMentionPress,
  isMyMessage,
}) {
  const segments = useMemo(() => {
    if (!text) return [];
    if (!mentions || mentions.length === 0) {
      return [{ type: 'text', content: text }];
    }

    // Sort mentions by startIndex
    const sorted = [...mentions].sort((a, b) => a.startIndex - b.startIndex);
    const result = [];
    let cursor = 0;

    for (const mention of sorted) {
      const start = mention.startIndex;
      const end = start + mention.length;

      // Validate bounds
      if (start < cursor || start < 0 || end > text.length) continue;

      // Add text before this mention
      if (start > cursor) {
        result.push({ type: 'text', content: text.slice(cursor, start) });
      }

      // Add the mention segment
      result.push({
        type: 'mention',
        content: text.slice(start, end),
        userId: mention.userId,
        displayName: mention.displayName,
      });

      cursor = end;
    }

    // Add remaining text after last mention
    if (cursor < text.length) {
      result.push({ type: 'text', content: text.slice(cursor) });
    }

    return result;
  }, [text, mentions]);

  const effectiveMentionColor = mentionColor || (isMyMessage ? '#D8ECFF' : MENTION_HIGHLIGHT_COLOR);

  if (segments.length === 0) {
    return (
      <Text style={[{ color: baseColor }, style]}>
        {text}
      </Text>
    );
  }

  return (
    <Text style={[{ color: baseColor }, style]}>
      {segments.map((seg, idx) => {
        if (seg.type === 'mention') {
          return (
            <Text
              key={`mention_${idx}`}
              onPress={onMentionPress ? () => onMentionPress(seg.userId, seg.displayName) : undefined}
              style={{
                color: effectiveMentionColor,
                fontFamily: 'Roboto-SemiBold',
              }}
            >
              {seg.content}
            </Text>
          );
        }
        return (
          <Text key={`text_${idx}`} style={{ color: baseColor }}>
            {seg.content}
          </Text>
        );
      })}
    </Text>
  );
});

export default MentionText;