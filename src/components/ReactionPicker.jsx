import { useTheme } from '../contexts/ThemeContext';
import React, { useCallback, useState, useMemo, useRef } from 'react';
import {
  View, Text, TouchableOpacity, Modal, Pressable, StyleSheet,
  Dimensions, KeyboardAvoidingView, Platform, SectionList,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheetSectionList } from '@gorhom/bottom-sheet';
import AppSheet, { USE_GORHOM } from './AppSheet';

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
  // Controlled full-emoji sheet. The quick bar now lives INSIDE MenuPopover's
  // Modal; opening the full sheet from there would nest a Modal in a Modal, so
  // the host closes the popover and drives the sheet from the screen root
  // instead. Left uncontrolled (props omitted) the picker behaves as before.
  fullKeyboardVisible,
  onOpenFullKeyboard,
  onCloseFullKeyboard,
  style,
}) => {
  const { theme } = useTheme();
  const [showFullKeyboard, setShowFullKeyboard] = useState(false);
  const fullControlled = fullKeyboardVisible !== undefined;
  const fullOpen = fullControlled ? !!fullKeyboardVisible : showFullKeyboard;
  const closeFull = useCallback(() => {
    if (fullControlled) onCloseFullKeyboard?.();
    else setShowFullKeyboard(false);
  }, [fullControlled, onCloseFullKeyboard]);
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
    closeFull();
    // Add to recent emojis (keep last 20)
    setRecentEmojis(prev => {
      const filtered = prev.filter(e => e !== emoji);
      return [emoji, ...filtered].slice(0, 20);
    });
    onSelect?.(emoji);
  }, [onSelect, closeFull]);

  const renderSectionHeader = useCallback(({ section: { title, icon } }) => (
    <View style={[
      styles.sectionHeader,
      { backgroundColor: theme.colors.menuSurface }
    ]}>
      <Ionicons 
        name={icon} 
        size={16} 
        color={theme.colors.secondaryTextColor} 
        style={styles.sectionIcon}
      />
      <Text style={[
        styles.sectionTitle,
        { color: theme.colors.secondaryTextColor }
      ]}>
        {title}
      </Text>
    </View>
  ), [isDarkMode, theme]);

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

  // `visible` gates only the quick bar — the full sheet can outlive it when the
  // host drives it (popover closes, sheet opens at the screen root).
  if (!visible && !fullOpen) return null;

  // Check which emojis the current user has reacted with for quick picker
  const userReactedEmojis = new Set();
  if (currentReactions) {
    for (const [emoji, data] of Object.entries(currentReactions)) {
      if (data?.users?.includes(currentUserId)) userReactedEmojis.add(emoji);
    }
  }

  // Same content for both the gorhom sheet and the legacy Modal; only the list
  // component differs (the sheet needs its own SectionList so scroll and drag
  // cooperate).
  const renderFullInner = (ListComp) => (
    <>
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
          { color: theme.colors.bubbleReceivedText }
        ]}>
          Emojis
        </Text>
        <TouchableOpacity
          onPress={closeFull}
          style={styles.closeButton}
          accessibilityRole="button"
          accessibilityLabel="Close emoji picker"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons 
            name="close" 
            size={24} 
            color={theme.colors.bubbleReceivedText} 
          />
        </TouchableOpacity>
      </View>

      {/* SectionList for categorized emojis */}
      <ListComp
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
    </>
  );

  return (
    <>
      {/* Quick picker bar - WhatsApp style */}
      {visible && (
      <View
        style={[
          styles.pickerContainer,
          {
            alignSelf: isMyMessage ? 'flex-end' : 'flex-start',
            backgroundColor: theme.colors.menuSurface,
          },
          style,
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
            if (onOpenFullKeyboard) onOpenFullKeyboard();
            else setShowFullKeyboard(true);
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
            color={theme.colors.secondaryTextColor} 
          />
        </TouchableOpacity>
      </View>
      )}

      {/* Full emoji picker: gorhom sheet, or the previous Modal when USE_GORHOM is false */}
      {USE_GORHOM ? (
        <AppSheet
          visible={fullOpen}
          onClose={closeFull}
          snapPoints={[SCREEN_H * 0.65]}
          backgroundColor={theme.colors.menuSurface}
        >
          {renderFullInner(BottomSheetSectionList)}
        </AppSheet>
      ) : (
        <Modal
          visible={fullOpen}
          transparent
          animationType="slide"
          onRequestClose={closeFull}
          statusBarTranslucent
        >
          <Pressable
            style={styles.fullOverlay}
            onPress={closeFull}
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
                    backgroundColor: theme.colors.menuSurface,
                    maxHeight: SCREEN_H * 0.65,
                  },
                ]}
              >
                {renderFullInner(SectionList)}
              </Pressable>
            </KeyboardAvoidingView>
          </Pressable>
        </Modal>
      )}
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
    fontFamily: 'Roboto-SemiBold',
  },
  closeButton: {
    padding: 4,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    // bg comes from the themed inline override — a static color here paints
    // a white band inside the dark sheet.
  },
  sectionIcon: {
    marginRight: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: 'Roboto-Medium',
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