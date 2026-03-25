import React from 'react';
import { View, Text, TouchableOpacity, Animated, StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';

const ReactionBar = React.memo(({
  reactions,
  currentUserId,
  isMyMessage,
  isDarkMode,
  themeColor,
  onToggleReaction,
  onShowDetail,
  scaleAnims,
}) => {
  if (!reactions || Object.keys(reactions).length === 0) return null;

  const entries = Object.entries(reactions).filter(([, data]) => data?.count > 0);
  if (entries.length === 0) return null;

  const totalCount = entries.reduce((sum, [, d]) => sum + d.count, 0);
  const iReactedAny = entries.some(([, d]) => d.users?.includes(currentUserId));

  // Get or create a single scale anim for the whole pill
  const scaleKey = '__pill__';
  if (scaleAnims && !scaleAnims[scaleKey]) {
    scaleAnims[scaleKey] = new Animated.Value(1);
  }
  const scaleVal = scaleAnims?.[scaleKey];

  return (
    <Animated.View style={[
      styles.wrapper,
      {
        alignSelf: isMyMessage ? 'flex-end' : 'flex-start',
        marginRight: isMyMessage ? 8 : 0,
        marginLeft: isMyMessage ? 0 : 8,
      },
      scaleVal ? { transform: [{ scale: scaleVal }] } : undefined,
    ]}>
      <TouchableOpacity
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          if (scaleVal) {
            Animated.sequence([
              Animated.timing(scaleVal, { toValue: 1.2, duration: 100, useNativeDriver: true }),
              Animated.spring(scaleVal, { toValue: 1, friction: 4, useNativeDriver: true }),
            ]).start();
          }
          // Tap toggles the first emoji (quick toggle) — same as WhatsApp
          if (entries.length === 1) {
            onToggleReaction?.(entries[0][0]);
          } else {
            // Multiple emojis → open detail sheet
            onShowDetail?.(entries[0][0]);
          }
        }}
        onLongPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onShowDetail?.(entries[0][0]);
        }}
        delayLongPress={300}
        activeOpacity={0.7}
        style={[
          styles.pill,
          {
            backgroundColor: isDarkMode ? '#1B2B34' : '#FFFFFF',
            borderColor: isDarkMode ? '#2A3A44' : '#E2E2E2',
          },
        ]}
        accessibilityLabel={`${entries.map(([e]) => e).join(' ')} reactions, ${totalCount} total`}
        accessibilityRole="button"
      >
        {entries.map(([emoji]) => (
          <Text key={emoji} style={styles.emoji}>{emoji}</Text>
        ))}
        {totalCount > 1 && (
          <Text style={[
            styles.count,
            { color: isDarkMode ? '#8696A0' : '#6B7B85' },
          ]}>
            {totalCount}
          </Text>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  wrapper: {
    marginBottom: -15,
    zIndex: 1,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  emoji: {
    fontSize: 16,
    marginHorizontal: 1,
  },
  count: {
    fontSize: 12,
    marginLeft: 2,
    fontFamily: 'Roboto-Medium',
  },
});

ReactionBar.displayName = 'ReactionBar';
export default ReactionBar;
