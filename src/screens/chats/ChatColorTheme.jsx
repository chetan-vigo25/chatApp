import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Animated,
  StyleSheet, Dimensions,
} from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FontAwesome6, Ionicons } from '@expo/vector-icons';
import { updateUserSettings } from '../../Redux/Services/Profile/Settings.Services';

const { width: SCREEN_W } = Dimensions.get('window');
// Swipeable accent-colour cards
const COLOR_CARD_W = 88;
const COLOR_CARD_GAP = 12;

// Curated, cohesive palette. #00A884 (the WhatsApp brand green) leads as the
// default so the out-of-the-box selection always resolves to a swatch.
// Row 1-2: bold/vivid accents. Row 3: soft, muted tones (gentler accents that
// still keep white text legible on sent bubbles & buttons).
const DEFAULT_ACCENT = '#00A884';
const ACCENT_COLORS = [
  // Bold
  '#00A884', '#128C7E', '#075E54', '#25D366',
  '#0099A8', '#34B7F1', '#0084FF', '#6C5CE7',
  '#9B59B6', '#E84393', '#FF6B6B', '#F2994A',
  // Soft / muted
  '#4DB6AC', '#64B5F6', '#7986CB', '#9575CD',
  '#F06292', '#FF8A65',
];

const THEME_OPTIONS = [
  {
    key: 'system',
    label: 'System default',
    description: "Match your device's theme",
    icon: 'phone-portrait-outline',
  },
  {
    key: 'light',
    label: 'Light',
    description: 'Bright and crisp',
    icon: 'sunny-outline',
  },
  {
    key: 'dark',
    label: 'Dark',
    description: 'Easy on the eyes',
    icon: 'moon-outline',
  },
];

export default function ChatColorTheme({ navigation }) {
  const {
    theme,
    updateChatColor,
    isDarkMode,
    hasManualTheme,
    setTheme,
    resetThemeToSystem,
  } = useTheme();

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(14)).current;
  const scaleAnims = useRef({}).current;
  const [selectedColor, setSelectedColor] = useState(null);

  useEffect(() => {
    AsyncStorage.getItem('selectedColor').then((saved) => {
      const initial = saved || theme.colors.themeColor;
      setSelectedColor(initial);
      updateChatColor(initial);
    }).catch(() => {
      setSelectedColor(theme.colors.themeColor);
      updateChatColor(theme.colors.themeColor);
    });

    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 380, useNativeDriver: true }),
      Animated.spring(slideAnim, { toValue: 0, friction: 9, tension: 60, useNativeDriver: true }),
    ]).start();
  }, []);

  ACCENT_COLORS.forEach((c) => {
    if (!scaleAnims[c]) scaleAnims[c] = new Animated.Value(1);
  });

  const handleColorSelect = async (color) => {
    Animated.sequence([
      Animated.timing(scaleAnims[color], { toValue: 0.86, duration: 90, useNativeDriver: true }),
      Animated.spring(scaleAnims[color], { toValue: 1, tension: 200, friction: 7, useNativeDriver: true }),
    ]).start();
    setSelectedColor(color);
    try {
      await AsyncStorage.setItem('selectedColor', color);
      updateChatColor(color);
    } catch (e) {}
  };

  const handleThemeSelect = (key) => {
    if (key === 'system') {
      resetThemeToSystem();
    } else if (key === 'light') {
      setTheme(false);
    } else if (key === 'dark') {
      setTheme(true);
    }
    // Persist to the user profile so the choice follows them across devices.
    // Fire-and-forget — local state already updated, no need to block the UI.
    updateUserSettings({ chat: { theme: key } }).catch(() => {});
  };

  const activeThemeKey = !hasManualTheme ? 'system' : isDarkMode ? 'dark' : 'light';
  const accent = selectedColor || theme.colors.themeColor;

  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.secondaryTextColor;
  const iconColor = theme.colors.iconColor;
  const pageBg = theme.colors.background;
  const cardBg = theme.colors.background;
  const bubbleRecvBg = isDarkMode ? '#202C33' : '#FFFFFF';
  const previewBg = isDarkMode ? '#0B141A' : '#ECE5DD';
  const sepClr = isDarkMode ? 'rgba(255,255,255,0.07)' : 'rgba(15,30,50,0.07)';

  // ─── Chat preview (WhatsApp wallpaper-style) ───
  const renderPreview = () => (
    <View style={styles.previewWrap}>
      <View style={[styles.previewCard, { backgroundColor: cardBg }]}>
        {/* Chat header */}
        <View style={[styles.previewTopBar, { backgroundColor: accent }]}>
          <Ionicons name="arrow-back" size={20} color="#fff" />
          <View style={styles.previewAvatar}>
            <Text style={styles.previewAvatarText}>J</Text>
          </View>
          <View style={styles.flex}>
            <Text style={styles.previewName}>Jordan</Text>
            <Text style={styles.previewStatus}>online</Text>
          </View>
          <Ionicons name="videocam" size={19} color="#fff" />
          <Ionicons name="call" size={17} color="#fff" style={styles.gap14} />
        </View>

        {/* Conversation over wallpaper */}
        <View style={[styles.previewChat, { backgroundColor: previewBg }]}>
          {/* Date chip */}
          <View style={styles.previewCenterRow}>
            <View style={[styles.previewDatePill, {
              backgroundColor: isDarkMode ? 'rgba(31,44,51,0.92)' : 'rgba(255,255,255,0.92)',
            }]}>
              <Text style={[styles.previewDateText, { color: subText }]}>TODAY</Text>
            </View>
          </View>

          <View style={styles.previewRowLeft}>
            <View style={[styles.bubbleReceived, { backgroundColor: bubbleRecvBg }]}>
              <Text style={[styles.bubbleText, { color: primaryText }]}>Hey! How's the new design coming along?</Text>
              <Text style={[styles.bubbleTime, { color: subText }]}>10:30 AM</Text>
            </View>
          </View>

          <View style={styles.previewRowRight}>
            <View style={[styles.bubbleSent, { backgroundColor: accent }]}>
              <Text style={styles.bubbleSentText}>Almost done — looks great ✨</Text>
              <View style={styles.bubbleSentMeta}>
                <Text style={styles.bubbleSentTime}>10:31 AM</Text>
                <Ionicons name="checkmark-done" size={14} color="rgba(255,255,255,0.9)" style={styles.gap4} />
              </View>
            </View>
          </View>
        </View>

        {/* Composer mock */}
        <View style={[styles.composer, { backgroundColor: cardBg }]}>
          <View style={[styles.composerInput, { backgroundColor: previewBg }]}>
            <Text style={[styles.composerText, { color: subText }]}>Message</Text>
          </View>
          <View style={[styles.composerSend, { backgroundColor: accent }]}>
            <Ionicons name="mic" size={17} color="#fff" />
          </View>
        </View>
      </View>
    </View>
  );

  // ─── Theme picker — single row of 3 selectable cards ───
  const renderThemePicker = () => (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: subText }]}>Theme</Text>
      <View style={styles.themeRowWrap}>
        {THEME_OPTIONS.map((opt) => {
          const active = activeThemeKey === opt.key;
          return (
            <TouchableOpacity
              key={opt.key}
              activeOpacity={0.75}
              onPress={() => handleThemeSelect(opt.key)}
              style={[
                styles.themeCard,
                {
                  backgroundColor: active ? accent + '14' : cardBg,
                  borderColor: active ? accent : (isDarkMode ? '#2A3942' : '#E2E7EC'),
                },
              ]}
            >
              <Ionicons name={opt.icon} size={22} color={active ? accent : iconColor} />
              <Text
                style={[styles.themeCardLabel, { color: active ? accent : primaryText }]}
                numberOfLines={1}
              >
                {opt.key === 'system' ? 'System' : opt.label}
              </Text>
              {active && (
                <View style={[styles.themeCheck, { backgroundColor: accent }]}>
                  <Ionicons name="checkmark" size={11} color="#fff" />
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );

  // ─── Accent color picker — swipeable cards ───
  const renderColorCards = () => {
    const current = (selectedColor || accent || '').toUpperCase();
    const isDefault = current === DEFAULT_ACCENT.toUpperCase();
    return (
      <View style={styles.section}>
        <View style={styles.colorHeaderRow}>
          <Text style={[styles.sectionTitleInline, { color: subText }]}>Chat accent</Text>
          {!isDefault && (
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => handleColorSelect(DEFAULT_ACCENT)}
              style={styles.resetInline}
            >
              <Ionicons name="refresh" size={13} color={accent} />
              <Text style={[styles.resetBtnText, { color: accent }]}>Reset</Text>
            </TouchableOpacity>
          )}
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          decelerationRate="fast"
          snapToInterval={COLOR_CARD_W + COLOR_CARD_GAP}
          snapToAlignment="start"
          contentContainerStyle={styles.colorCardsRow}
        >
          {ACCENT_COLORS.map((color) => {
            const isSel = (selectedColor || '').toUpperCase() === color.toUpperCase();
            return (
              <Animated.View key={color} style={{ transform: [{ scale: scaleAnims[color] }] }}>
                <TouchableOpacity
                  activeOpacity={0.85}
                  onPress={() => handleColorSelect(color)}
                  style={[
                    styles.colorCard,
                    { borderColor: isSel ? color : (isDarkMode ? '#2A3942' : '#E6EBEF') },
                  ]}
                >
                  <View style={[styles.colorCardSwatch, { backgroundColor: color }]}>
                    {isSel && <Ionicons name="checkmark" size={24} color="#fff" />}
                  </View>
                  <Text
                    style={[styles.colorCardHex, { color: isSel ? color : subText }]}
                    numberOfLines={1}
                  >
                    {color.toUpperCase()}
                  </Text>
                </TouchableOpacity>
              </Animated.View>
            );
          })}
        </ScrollView>

        <Text style={[styles.footerHint, { color: subText }]}>
          Swipe and tap a card to apply the accent to your sent messages, buttons, and highlights.
        </Text>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: pageBg }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          activeOpacity={0.6}
          style={styles.headerBackBtn}
        >
          <FontAwesome6 name="arrow-left" size={19} color={primaryText} />
        </TouchableOpacity>
        <View style={styles.flex}>
          <Text style={[styles.headerTitle, { color: primaryText }]}>Appearance</Text>
          <Text style={[styles.headerSubtitle, { color: subText }]}>Theme & chat accent</Text>
        </View>
      </View>

      <Animated.View style={{ flex: 1, opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
        >
          {renderPreview()}
          {renderThemePicker()}
          {renderColorCards()}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  gap4: { marginLeft: 4 },
  gap14: { marginLeft: 16 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 8,
    gap: 6,
  },
  headerBackBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: {
    fontFamily: 'Roboto-Bold',
    fontSize: 22,
    letterSpacing: -0.3,
  },
  headerSubtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 1,
  },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 40, paddingTop: 4 },

  // Preview
  previewWrap: {
    marginTop: 2,
    marginBottom: 18,
  },
  previewCard: {
    borderRadius: 18,
    overflow: 'hidden',
    shadowColor: '#0B141A',
    shadowOpacity: 0.06,
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 14,
    elevation: 3,
  },
  previewTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 11,
    gap: 11,
  },
  previewAvatar: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center', justifyContent: 'center',
  },
  previewAvatarText: {
    fontFamily: 'Roboto-Bold',
    fontSize: 16,
    color: '#fff',
  },
  previewName: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 15,
    color: '#fff',
  },
  previewStatus: {
    fontFamily: 'Roboto-Regular',
    fontSize: 11,
    color: 'rgba(255,255,255,0.85)',
    marginTop: 1,
  },

  previewChat: {
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  previewCenterRow: {
    alignItems: 'center',
    marginBottom: 2,
  },
  previewDatePill: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 8,
  },
  previewDateText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 10,
    letterSpacing: 0.5,
  },
  previewEncPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    maxWidth: '90%',
  },
  previewEncText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 9.5,
    textAlign: 'center',
  },
  previewRowLeft: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  previewRowRight: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  bubbleReceived: {
    maxWidth: '82%',
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 12,
    borderTopLeftRadius: 4,
    shadowColor: '#0B141A',
    shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 1.5,
    elevation: 1,
  },
  bubbleSent: {
    maxWidth: '82%',
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 12,
    borderTopRightRadius: 4,
    shadowColor: '#0B141A',
    shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 1.5,
    elevation: 1,
  },
  bubbleText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    lineHeight: 18,
  },
  bubbleSentText: {
    color: '#fff',
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    lineHeight: 18,
  },
  bubbleTime: {
    fontFamily: 'Roboto-Regular',
    fontSize: 10,
    marginTop: 3,
    alignSelf: 'flex-end',
  },
  bubbleSentTime: {
    color: 'rgba(255,255,255,0.85)',
    fontFamily: 'Roboto-Regular',
    fontSize: 10,
  },
  bubbleSentMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    marginTop: 3,
  },

  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  composerInput: {
    flex: 1,
    height: 38,
    borderRadius: 19,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  composerText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
  },
  composerSend: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
  },

  // Sections
  section: { marginBottom: 22 },
  sectionTitle: {
    fontFamily: 'Roboto-Medium',
    fontSize: 13, letterSpacing: 0.2,
    marginBottom: 8, marginLeft: 14,
  },
  sectionCard: {
    borderRadius: 14,
    overflow: 'hidden',
  },
  sectionTitleInline: {
    fontFamily: 'Roboto-Medium',
    fontSize: 13,
    letterSpacing: 0.2,
  },

  // Theme — single row of cards
  themeRowWrap: {
    flexDirection: 'row',
    gap: 10,
  },
  themeCard: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1.5,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
  },
  themeCardLabel: {
    fontFamily: 'Roboto-Medium',
    fontSize: 13.5,
  },
  themeCheck: {
    position: 'absolute',
    top: 7,
    right: 7,
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Accent — swipeable cards
  colorHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginLeft: 14,
    marginRight: 8,
    marginBottom: 12,
  },
  resetInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  colorCardsRow: {
    paddingHorizontal: 14,
    gap: COLOR_CARD_GAP,
    paddingVertical: 2,
  },
  colorCard: {
    width: COLOR_CARD_W,
    borderRadius: 16,
    borderWidth: 2.5,
    paddingHorizontal: 6,
    paddingTop: 6,
    paddingBottom: 9,
    alignItems: 'center',
    gap: 8,
  },
  colorCardSwatch: {
    width: '100%',
    height: COLOR_CARD_W - 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  colorCardHex: {
    fontFamily: 'Roboto-Medium',
    fontSize: 11,
    letterSpacing: 0.4,
  },

  // Theme rows
  themeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 16,
    minHeight: 60,
  },
  themeIconWrap: {
    width: 24, height: 24,
    alignItems: 'center', justifyContent: 'center',
  },
  themeLabel: {
    fontFamily: 'Roboto-Regular',
    fontSize: 16,
    lineHeight: 21,
  },
  themeDesc: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    marginTop: 2,
  },
  radioOuter: {
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  radioInner: {
    width: 12, height: 12, borderRadius: 6,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 56,
  },

  // Accent selection header
  accentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 14,
  },
  accentCurrentDot: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  accentCurrentLabel: {
    fontFamily: 'Roboto-Medium',
    fontSize: 15,
  },
  accentCurrentSub: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12.5,
    marginTop: 2,
    letterSpacing: 0.5,
  },
  resetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: 1,
  },
  resetBtnText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 13,
  },

  footerHint: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: 24,
    marginTop: 14,
  },
});
