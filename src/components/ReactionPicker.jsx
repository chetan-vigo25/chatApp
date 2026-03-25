import React, { useCallback, useState } from 'react';
import {
  View, Text, TouchableOpacity, Modal, Pressable, StyleSheet,
  Dimensions, KeyboardAvoidingView, Platform,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import EmojiSelector, { Categories } from 'react-native-emoji-selector';

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const { height: SCREEN_H } = Dimensions.get('window');

const ReactionPicker = React.memo(({
  visible,
  onSelect,
  onClose,
  isMyMessage,
  isDarkMode,
  themeColor,
  currentReactions,
  currentUserId,
}) => {
  const [showFullKeyboard, setShowFullKeyboard] = useState(false);

  const handleSelect = useCallback((emoji) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSelect?.(emoji);
  }, [onSelect]);

  const handleFullSelect = useCallback((emoji) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShowFullKeyboard(false);
    onSelect?.(emoji);
  }, [onSelect]);

  if (!visible) return null;

  // Check which emojis the current user has reacted with
  const userReactedEmojis = new Set();
  if (currentReactions) {
    for (const [emoji, data] of Object.entries(currentReactions)) {
      if (data?.users?.includes(currentUserId)) userReactedEmojis.add(emoji);
    }
  }

  return (
    <>
      {/* Quick picker bar */}
      <View
        style={[
          styles.pickerContainer,
          {
            alignSelf: isMyMessage ? 'flex-end' : 'flex-start',
            backgroundColor: isDarkMode ? '#1F2C34' : '#FFFFFF',
          },
        ]}
      >
        {QUICK_EMOJIS.map((emoji) => {
          const hasReacted = userReactedEmojis.has(emoji);
          return (
            <TouchableOpacity
              key={emoji}
              onPress={() => handleSelect(emoji)}
              style={[
                styles.emojiButton,
                hasReacted && { backgroundColor: (themeColor || '#03b0a2') + '20' },
              ]}
              activeOpacity={0.6}
            >
              <Text style={styles.emojiText}>{emoji}</Text>
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setShowFullKeyboard(true);
          }}
          style={[
            styles.plusButton,
            { backgroundColor: isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' },
          ]}
          activeOpacity={0.6}
        >
          <Ionicons name="add" size={20} color={isDarkMode ? '#8696A0' : '#999'} />
        </TouchableOpacity>
      </View>

      {/* Full emoji keyboard modal */}
      <Modal
        visible={showFullKeyboard}
        transparent
        animationType="slide"
        onRequestClose={() => setShowFullKeyboard(false)}
      >
        <Pressable
          style={styles.fullOverlay}
          onPress={() => setShowFullKeyboard(false)}
        >
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.fullKeyboardWrap}
          >
            <Pressable
              onPress={() => {}}
              style={[
                styles.fullKeyboardContainer,
                { backgroundColor: isDarkMode ? '#1F2C34' : '#FFFFFF' },
              ]}
            >
              <View style={styles.dragHandle}>
                <View style={[
                  styles.dragBar,
                  { backgroundColor: isDarkMode ? '#3A4A54' : '#D0D0D0' },
                ]} />
              </View>
              <EmojiSelector
                onEmojiSelected={handleFullSelect}
                showSearchBar={true}
                showTabs={true}
                showHistory={true}
                showSectionTitles={true}
                category={Categories.emotion}
                columns={8}
                placeholder="Search emoji..."
                theme={isDarkMode ? '#8696A0' : '#666'}
              />
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>
    </>
  );
});

const styles = StyleSheet.create({
  pickerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 28,
    paddingHorizontal: 4,
    paddingVertical: 2,
    marginTop: 6,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
  },
  emojiButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiText: {
    fontSize: 24,
  },
  plusButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 2,
  },
  fullOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  fullKeyboardWrap: {
    justifyContent: 'flex-end',
  },
  fullKeyboardContainer: {
    height: SCREEN_H * 0.5,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: 'hidden',
  },
  dragHandle: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 6,
  },
  dragBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
  },
});

ReactionPicker.displayName = 'ReactionPicker';
export default ReactionPicker;
