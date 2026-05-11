import React, { useCallback, useState, useMemo, useRef } from 'react';
import {
  View, Text, TouchableOpacity, Modal, Pressable, StyleSheet,
  Dimensions, KeyboardAvoidingView, Platform, SectionList,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const windowDimensions = Dimensions.get('window') || {};
const SCREEN_H = windowDimensions.height || 640;
const SCREEN_W = windowDimensions.width || 360;

// Organized emoji sections like WhatsApp
const EMOJI_SECTIONS = [
  {
    title: 'Recent',
    data: [], // Will be populated with recent emojis
    icon: 'time-outline',
  },
  {
    title: 'Smileys & People',
    data: [
      '😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇',
      '🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚',
      '😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🤩',
      '🥳','😏','😒','😞','😔','😟','😕','🙁','☹️','😣',
      '😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬',
      '🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗',
      '🤔','🤭','🤫','🤥','😶','😐','😑','😬','🙄','😯',
      '😦','😧','😮','😲','🥱','😴','🤤','😪','😵','🤐',
      '🥴','🤢','🤮','🤧','😷','🤒','🤕','🤑','🤠','😈',
      '👿','👹','👺','🤡','💩','👻','💀','☠️','👽','👾',
      '🤖','🎃','😺','😸','😹','😻','😼','😽','🙀','😿','😾',
      '🙈','🙉','🙊'
    ],
    icon: 'happy-outline',
  },
  {
    title: 'Gestures & Body',
    data: [
      '👍','👎','👌','✌️','🤞','🤟','🤘','🤙','👈','👉',
      '👆','🖕','👇','☝️','👋','🤚','🖐️','✋','🖖',
      '👏','🙌','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾',
      '🦿','🦵','🦶','👂','🦻','👃','🧠','🫀','🫁','🦷',
      '🦴','👀','👁️','👅','👄','💋','🩸'
    ],
    icon: 'body-outline',
  },
  {
    title: 'Hearts & Emotions',
    data: [
      '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎',
      '💔','❤️‍🔥','❤️‍🩹','💕','💞','💓','💗','💖','💘','💝','💟',
      '💨','💦','💫','⭐','🌟','✨','⚡','🔥','💥','💢'
    ],
    icon: 'heart-outline',
  },
  {
    title: 'Symbols',
    data: [
      '☮️','✝️','☪️','🕉️','☸️','✡️','🔯','🕎','☯️','☦️',
      '🛐','⛎','♈️','♉️','♊️','♋️','♌️','♍️','♎️','♏️',
      '♐️','♑️','♒️','♓️','⚛️','☢️','☣️','📴','📳','🆔',
      '🉑','🈶','🈚️','🈸','🈺','🈷️','✴️','❇️','™️','®️',
      '©️','0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣',
      '8️⃣','9️⃣','🔟','💯','🔠','🔡','🔢','🔣','🔤','🅰️',
      '🆎','🅱️','🆑','🆒','🆓','ℹ️','Ⓜ️','🆕','🆖','🅾️',
      '🆗','🅿️','🆘','🆙','🆚','‼️','⁉️','❓','❔','❕','❗',
      '💟','☮️','✡️','🔯','🕎','♻️','⚜️','🔱','📛','🔰'
    ],
    icon: 'bulb-outline',
  },
  {
    title: 'Shapes & Colors',
    data: [
      '🔴','🟠','🟡','🟢','🔵','🟣','🟤','⚫','⚪','🟥',
      '🟧','🟨','🟩','🟦','🟪','🟫','⬛','⬜','🔶','🔷',
      '🔸','🔹','🔺','🔻','💠','🔘','🔳','🔲','▪️','▫️',
      '◼️','◻️','◀️','▶️','🔼','🔽','⏫','⏬'
    ],
    icon: 'apps-outline',
  },
  {
    title: 'Flags',
    data: [
      '🏁','🚩','🎌','🏴','🏳️','🏳️‍🌈','🏳️‍⚧️','🏴‍☠️','🇮🇳','🇺🇸',
      '🇬🇧','🇨🇦','🇦🇺','🇯🇵','🇩🇪','🇫🇷','🇮🇹','🇪🇸','🇧🇷','🇲🇽',
      '🇰🇷','🇷🇺','🇨🇳','🇿🇦','🇳🇬','🇦🇪','🇸🇦','🇹🇷','🇳🇱','🇨🇭'
    ],
    icon: 'flag-outline',
  },
];

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
  const [recentEmojis, setRecentEmojis] = useState(['👍', '❤️', '😂', '😮', '🙏']);
  const sectionListRef = useRef(null);

  const NUM_COLUMNS = 8;

  // Chunk emojis into rows of NUM_COLUMNS for grid layout (SectionList doesn't support numColumns)
  const chunkArray = useCallback((arr) => {
    const rows = [];
    for (let i = 0; i < arr.length; i += NUM_COLUMNS) {
      rows.push(arr.slice(i, i + NUM_COLUMNS));
    }
    return rows;
  }, []);

  // Prepare sections with recent emojis, data chunked into rows
  const sections = useMemo(() => {
    const recentSection = { ...EMOJI_SECTIONS[0], data: chunkArray([...recentEmojis]) };
    const otherSections = EMOJI_SECTIONS.slice(1).map(s => ({
      ...s,
      data: chunkArray(s.data),
    }));

    if (recentEmojis.length === 0) {
      return otherSections;
    }
    return [recentSection, ...otherSections];
  }, [recentEmojis, chunkArray]);

  const handleSelect = useCallback((emoji) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSelect?.(emoji);
  }, [onSelect]);

  const handleFullSelect = useCallback((emoji) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShowFullKeyboard(false);
    // Add to recent emojis (keep last 20)
    setRecentEmojis(prev => {
      const filtered = prev.filter(e => e !== emoji);
      return [emoji, ...filtered].slice(0, 20);
    });
    onSelect?.(emoji);
  }, [onSelect]);

  const renderSectionHeader = useCallback(({ section: { title, icon } }) => (
    <View style={[
      styles.sectionHeader,
      { backgroundColor: isDarkMode ? '#1F2C34' : '#FFFFFF' }
    ]}>
      <Ionicons 
        name={icon} 
        size={16} 
        color={isDarkMode ? '#8696A0' : '#667781'} 
        style={styles.sectionIcon}
      />
      <Text style={[
        styles.sectionTitle,
        { color: isDarkMode ? '#8696A0' : '#667781' }
      ]}>
        {title}
      </Text>
    </View>
  ), [isDarkMode]);

  const renderEmojiRow = useCallback(({ item: row }) => {
    return (
      <View style={styles.emojiRow}>
        {row.map((emoji, i) => {
          const hasReacted = currentReactions?.[emoji]?.users?.includes(currentUserId);
          return (
            <TouchableOpacity
              key={`${emoji}_${i}`}
              onPress={() => handleFullSelect(emoji)}
              style={[
                styles.emojiItem,
                hasReacted && { backgroundColor: (themeColor || '#03b0a2') + '20', borderRadius: 8 }
              ]}
              activeOpacity={0.6}
            >
              <Text style={styles.emojiItemText}>{emoji}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    );
  }, [handleFullSelect, currentReactions, currentUserId, themeColor]);

  if (!visible) return null;

  // Check which emojis the current user has reacted with for quick picker
  const userReactedEmojis = new Set();
  if (currentReactions) {
    for (const [emoji, data] of Object.entries(currentReactions)) {
      if (data?.users?.includes(currentUserId)) userReactedEmojis.add(emoji);
    }
  }

  return (
    <>
      {/* Quick picker bar - WhatsApp style */}
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
                hasReacted && { 
                  backgroundColor: (themeColor || '#03b0a2') + '20',
                  borderRadius: 20,
                },
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
          <Ionicons 
            name="add" 
            size={20} 
            color={isDarkMode ? '#8696A0' : '#667781'} 
          />
        </TouchableOpacity>
      </View>

      {/* Full emoji keyboard modal - WhatsApp style */}
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
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={styles.fullKeyboardWrap}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
          >
            <Pressable
              onPress={() => {}}
              style={[
                styles.fullKeyboardContainer,
                {
                  backgroundColor: isDarkMode ? '#1F2C34' : '#FFFFFF',
                  maxHeight: SCREEN_H * 0.65,
                },
              ]}
            >
              {/* Drag handle */}
              <View style={styles.dragHandle}>
                <View style={[
                  styles.dragBar,
                  { backgroundColor: isDarkMode ? '#3A4A54' : '#D0D0D0' },
                ]} />
              </View>

              {/* Header with search icon (like WhatsApp) */}
              <View style={styles.modalHeader}>
                <Text style={[
                  styles.modalTitle,
                  { color: isDarkMode ? '#E9EDEF' : '#111B21' }
                ]}>
                  Emojis
                </Text>
                <TouchableOpacity
                  onPress={() => setShowFullKeyboard(false)}
                  style={styles.closeButton}
                >
                  <Ionicons 
                    name="close" 
                    size={24} 
                    color={isDarkMode ? '#E9EDEF' : '#111B21'} 
                  />
                </TouchableOpacity>
              </View>

              {/* SectionList for categorized emojis */}
              <SectionList
                ref={sectionListRef}
                sections={sections}
                keyExtractor={(item, index) => `row_${index}`}
                renderItem={renderEmojiRow}
                renderSectionHeader={renderSectionHeader}
                stickySectionHeadersEnabled={true}
                initialNumToRender={20}
                maxToRenderPerBatch={20}
                windowSize={10}
                contentContainerStyle={styles.emojiList}
                showsVerticalScrollIndicator={true}
                keyboardShouldPersistTaps="handled"
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
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(0,0,0,0.1)',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  closeButton: {
    padding: 4,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#FFFFFF',
  },
  sectionIcon: {
    marginRight: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '500',
    textTransform: 'uppercase',
  },
  emojiList: {
    paddingHorizontal: 8,
    paddingBottom: 20,
  },
  emojiRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
  },
  emojiItem: {
    width: (SCREEN_W - 16) / 8,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 2,
  },
  emojiItemText: {
    fontSize: 28,
  },
});

ReactionPicker.displayName = 'ReactionPicker';
export default ReactionPicker;