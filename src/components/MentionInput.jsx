import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  Image,
  Animated,
  Keyboard,
  Platform,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// ── Mention data structures ──
// A mention in the message:
//   { userId: string, displayName: string, startIndex: number, length: number }
//
// The final message payload contains:
//   text: "Hey @John check this"
//   mentions: [{ userId: "abc123", displayName: "John", startIndex: 4, length: 5 }]

const MENTION_TRIGGER = '@';
const MAX_SUGGESTIONS = 20;
const SUGGESTION_ITEM_HEIGHT = 52;
const MAX_DROPDOWN_HEIGHT = SUGGESTION_ITEM_HEIGHT * 4.5;

// ── Suggestion Item ──
const MentionSuggestionItem = React.memo(function MentionSuggestionItem({
  member,
  onSelect,
  theme,
  isDarkMode,
}) {
  return (
    <TouchableOpacity
      onPress={() => onSelect(member)}
      activeOpacity={0.7}
      style={[
        styles.suggestionItem,
        { borderBottomColor: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' },
      ]}
    >
      {member.profileImage ? (
        <Image source={{ uri: member.profileImage }} style={styles.avatar} />
      ) : (
        <View style={[styles.avatarFallback, { backgroundColor: member.color || '#128C7E' }]}>
          <Text style={styles.avatarInitial}>
            {(member.displayName || '?')[0].toUpperCase()}
          </Text>
        </View>
      )}
      <View style={styles.suggestionTextContainer}>
        <Text
          style={[styles.suggestionName, { color: isDarkMode ? '#F2F8FC' : '#111' }]}
          numberOfLines={1}
        >
          {member.displayName}
        </Text>
        {member.role && member.role !== 'member' && (
          <Text style={[styles.suggestionRole, { color: isDarkMode ? 'rgba(212,229,240,0.5)' : '#888' }]}>
            {member.role}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
});

// ── Mention Suggestions Dropdown ──
const MentionSuggestions = React.memo(function MentionSuggestions({
  suggestions,
  onSelect,
  theme,
  isDarkMode,
  visible,
}) {
  const slideAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(slideAnim, {
      toValue: visible ? 1 : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [visible, slideAnim]);

  if (!visible || suggestions.length === 0) return null;

  return (
    <Animated.View
      style={[
        styles.suggestionsContainer,
        {
          backgroundColor: isDarkMode ? '#1E2A32' : '#FFFFFF',
          borderColor: isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
          opacity: slideAnim,
          transform: [
            {
              translateY: slideAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [10, 0],
              }),
            },
          ],
        },
      ]}
    >
      <FlatList
        data={suggestions}
        keyExtractor={(item) => item.userId}
        renderItem={({ item }) => (
          <MentionSuggestionItem
            member={item}
            onSelect={onSelect}
            theme={theme}
            isDarkMode={isDarkMode}
          />
        )}
        style={{ maxHeight: MAX_DROPDOWN_HEIGHT }}
        keyboardShouldPersistTaps="always"
        showsVerticalScrollIndicator={false}
        getItemLayout={(_, index) => ({
          length: SUGGESTION_ITEM_HEIGHT,
          offset: SUGGESTION_ITEM_HEIGHT * index,
          index,
        })}
      />
    </Animated.View>
  );
});

// ── Helper: extract mention query from text at cursor ──
function getMentionQuery(text, cursorPosition) {
  if (!text || cursorPosition <= 0) return null;

  // Walk backward from cursor to find the @ trigger
  const beforeCursor = text.slice(0, cursorPosition);
  const atIndex = beforeCursor.lastIndexOf(MENTION_TRIGGER);

  if (atIndex === -1) return null;

  // @ must be at start or preceded by whitespace
  if (atIndex > 0 && !/\s/.test(beforeCursor[atIndex - 1])) return null;

  const query = beforeCursor.slice(atIndex + 1);

  // If there's a space in the query, the mention is "closed"
  // Allow spaces in names (e.g., "John Doe") but limit to 30 chars
  if (query.length > 30) return null;

  return { query, atIndex };
}

// ── Helper: build mentions array from text ──
export function extractMentionsFromText(text, mentionsMap) {
  // mentionsMap: Map<displayName, { userId, displayName }>
  const mentions = [];
  if (!text || !mentionsMap || mentionsMap.size === 0) return mentions;

  const regex = /@(\S+(?:\s\S+)*)/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const matchText = match[1];
    // Try progressively shorter substrings to match display names
    for (const [name, data] of mentionsMap) {
      if (matchText.startsWith(name) || matchText === name) {
        mentions.push({
          userId: data.userId,
          displayName: data.displayName,
          startIndex: match.index,
          length: name.length + 1, // +1 for @
        });
        break;
      }
    }
  }

  return mentions;
}

// ── Hook: useMentions ──
export function useMentions(groupMembers, currentUserId) {
  const [mentionsMap, setMentionsMap] = useState(new Map());
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [mentionQuery, setMentionQuery] = useState(null);
  const cursorPositionRef = useRef(0);

  // Build members list from groupMembersMap (excluding current user)
  const membersList = useMemo(() => {
    if (!groupMembers) return [];
    const avatarColors = ['#25D366', '#128C7E', '#0EA5FF', '#F43F5E', '#8B5CF6', '#F97316', '#06B6D4', '#EC4899'];
    return Object.entries(groupMembers)
      .filter(([id]) => id !== currentUserId)
      .map(([id, info], idx) => ({
        userId: id,
        displayName: info.fullName || 'Unknown',
        profileImage: info.profileImage || null,
        role: info.role || 'member',
        color: avatarColors[idx % avatarColors.length],
      }));
  }, [groupMembers, currentUserId]);

  const handleSelectionChange = useCallback((event) => {
    cursorPositionRef.current = event?.nativeEvent?.selection?.start ?? 0;
  }, []);

  const handleTextChangeForMentions = useCallback((newText) => {
    const cursor = cursorPositionRef.current;
    // Use text length as cursor approximation when typing (cursor position updates async)
    const effectiveCursor = Math.min(cursor, newText.length) || newText.length;
    const result = getMentionQuery(newText, effectiveCursor);

    if (result && membersList.length > 0) {
      const query = result.query.toLowerCase();
      const filtered = membersList
        .filter((m) => m.displayName.toLowerCase().includes(query))
        .slice(0, MAX_SUGGESTIONS);

      if (filtered.length > 0) {
        setSuggestions(filtered);
        setMentionQuery(result);
        setShowSuggestions(true);
        return;
      }
    }

    setShowSuggestions(false);
    setSuggestions([]);
    setMentionQuery(null);
  }, [membersList]);

  const handleSelectMention = useCallback((member, currentText, setText) => {
    if (!mentionQuery) return;

    const { atIndex } = mentionQuery;
    const before = currentText.slice(0, atIndex);
    const cursorPos = cursorPositionRef.current || currentText.length;
    const after = currentText.slice(cursorPos);

    const mentionText = `@${member.displayName} `;
    const newText = before + mentionText + after;

    // Track this mention
    setMentionsMap((prev) => {
      const next = new Map(prev);
      next.set(member.displayName, {
        userId: member.userId,
        displayName: member.displayName,
      });
      return next;
    });

    setShowSuggestions(false);
    setSuggestions([]);
    setMentionQuery(null);

    setText(newText);
    // Update cursor position after mention
    cursorPositionRef.current = before.length + mentionText.length;
  }, [mentionQuery]);

  const getMentionsPayload = useCallback((text) => {
    return extractMentionsFromText(text, mentionsMap);
  }, [mentionsMap]);

  const resetMentions = useCallback(() => {
    setMentionsMap(new Map());
    setShowSuggestions(false);
    setSuggestions([]);
    setMentionQuery(null);
  }, []);

  return {
    showSuggestions,
    suggestions,
    mentionsMap,
    handleTextChangeForMentions,
    handleSelectionChange,
    handleSelectMention,
    getMentionsPayload,
    resetMentions,
    membersList,
  };
}

// ── Styles ──
const styles = StyleSheet.create({
  suggestionsContainer: {
    position: 'absolute',
    bottom: '100%',
    left: 10,
    right: 10,
    borderRadius: 12,
    borderWidth: 0.5,
    overflow: 'hidden',
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    zIndex: 100,
    marginBottom: 4,
  },
  suggestionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    height: SUGGESTION_ITEM_HEIGHT,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  avatarFallback: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    color: '#FFFFFF',
    fontSize: 15,
    fontFamily: 'Roboto-SemiBold',
  },
  suggestionTextContainer: {
    marginLeft: 12,
    flex: 1,
  },
  suggestionName: {
    fontSize: 15,
    fontFamily: 'Roboto-Medium',
  },
  suggestionRole: {
    fontSize: 12,
    fontFamily: 'Roboto-Regular',
    marginTop: 1,
    textTransform: 'capitalize',
  },
});

export { MentionSuggestions };
export default MentionSuggestions;
