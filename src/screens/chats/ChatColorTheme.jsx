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
const SWATCH_GAP = 12;
const SWATCHES_PER_ROW = 5;
const SWATCH_SIZE = (SCREEN_W - 32 - 28 - SWATCH_GAP * (SWATCHES_PER_ROW - 1)) / SWATCHES_PER_ROW;

const ACCENT_COLORS = [
  '#25D366', '#128C7E', '#075E54',
  '#34B7F1', '#0984E3', '#6C5CE7',
  '#833AB4', '#E84393', '#FF5A5F',
  '#F56040', '#FDCB6E', '#00B894',
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
  const slideAnim = useRef(new Animated.Value(16)).current;
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
      Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
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
  const subText = theme.colors.placeHolderTextColor;
  const pageBg = theme.colors.background;
  const cardBg = theme.colors.menuBackground;
  const borderClr = isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(15,30,50,0.06)';

  // ─── Chat preview (large, top) ───
  const renderPreview = () => (
    <Animated.View
      style={[
        styles.previewWrap,
        { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
      ]}
    >
      <View pointerEvents="none" style={[styles.previewHalo, { backgroundColor: accent + '20' }]} />
      <View pointerEvents="none" style={[styles.previewHalo2, { backgroundColor: accent + '10' }]} />

      <View style={[styles.previewCard, { backgroundColor: cardBg, shadowColor: isDarkMode ? 'transparent' : '#0B141A' }]}>
        {/* Phone notch */}
        <View style={styles.previewTopBar}>
          <View style={[styles.previewAvatar, { backgroundColor: accent + '30' }]}>
            <Text style={[styles.previewAvatarText, { color: accent }]}>J</Text>
          </View>
          <View style={styles.flex}>
            <Text style={[styles.previewName, { color: primaryText }]}>Jordan</Text>
            <Text style={[styles.previewStatus, { color: subText }]}>online</Text>
          </View>
          <Ionicons name="videocam-outline" size={20} color={subText} />
          <Ionicons name="call-outline" size={18} color={subText} style={styles.gap10} />
        </View>

        <View style={[styles.previewDivider, { backgroundColor: borderClr }]} />

        <View style={styles.previewChat}>
          <View style={styles.previewRowLeft}>
            <View style={[styles.bubbleReceived, { backgroundColor: pageBg }]}>
              <Text style={[styles.bubbleText, { color: primaryText }]}>Hey! How's the new design coming along?</Text>
              <Text style={[styles.bubbleTime, { color: subText }]}>10:30 AM</Text>
            </View>
          </View>

          <View style={styles.previewRowRight}>
            <View style={[styles.bubbleSent, { backgroundColor: accent }]}>
              <Text style={styles.bubbleSentText}>Almost done — looks great in {isDarkMode ? 'dark' : 'light'} mode ✨</Text>
              <View style={styles.bubbleSentMeta}>
                <Text style={styles.bubbleSentTime}>10:31 AM</Text>
                <Ionicons name="checkmark-done" size={13} color="rgba(255,255,255,0.85)" style={styles.gap4} />
              </View>
            </View>
          </View>

          <View style={styles.previewRowLeft}>
            <View style={[styles.bubbleReceived, { backgroundColor: pageBg }]}>
              <Text style={[styles.bubbleText, { color: primaryText }]}>Can't wait to see it 🎉</Text>
              <Text style={[styles.bubbleTime, { color: subText }]}>10:32 AM</Text>
            </View>
          </View>
        </View>

        {/* Composer mock */}
        <View style={[styles.composer, { backgroundColor: pageBg }]}>
          <View style={[styles.composerInput, { backgroundColor: cardBg }]}>
            <Text style={[styles.composerText, { color: subText }]}>Message</Text>
          </View>
          <View style={[styles.composerSend, { backgroundColor: accent }]}>
            <Ionicons name="mic" size={16} color="#fff" />
          </View>
        </View>
      </View>
    </Animated.View>
  );

  // ─── Theme picker (WhatsApp style radio cards) ───
  const renderThemePicker = () => (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: subText }]}>THEME</Text>
      <View style={[styles.sectionCard, { backgroundColor: cardBg, shadowColor: isDarkMode ? 'transparent' : '#0B141A' }]}>
        {THEME_OPTIONS.map((opt, i) => {
          const active = activeThemeKey === opt.key;
          const isLast = i === THEME_OPTIONS.length - 1;
          return (
            <TouchableOpacity
              key={opt.key}
              activeOpacity={0.7}
              onPress={() => handleThemeSelect(opt.key)}
              style={styles.themeRow}
            >
              <View style={[
                styles.themeIconWrap,
                {
                  backgroundColor: active ? accent + '18' : (isDarkMode ? '#243340' : '#F2F4F8'),
                  borderColor: active ? accent + '50' : 'transparent',
                },
              ]}>
                <Ionicons name={opt.icon} size={20} color={active ? accent : subText} />
              </View>

              <View style={[
                styles.themeTextWrap,
                !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: borderClr },
              ]}>
                <View style={styles.flex}>
                  <Text style={[styles.themeLabel, { color: primaryText }]}>{opt.label}</Text>
                  <Text style={[styles.themeDesc, { color: subText }]}>{opt.description}</Text>
                </View>
                <View style={[
                  styles.radioOuter,
                  { borderColor: active ? accent : (isDarkMode ? '#3A4A56' : '#C8CFD8') },
                ]}>
                  {active && <View style={[styles.radioInner, { backgroundColor: accent }]} />}
                </View>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );

  // ─── Accent color picker ───
  const renderColorGrid = () => (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: subText }]}>CHAT ACCENT</Text>
      <View style={[styles.sectionCard, styles.colorCard, { backgroundColor: cardBg, shadowColor: isDarkMode ? 'transparent' : '#0B141A' }]}>
        <View style={styles.colorGrid}>
          {ACCENT_COLORS.map((color) => {
            const isSel = selectedColor === color;
            return (
              <Animated.View
                key={color}
                style={[styles.swatchOuter, { transform: [{ scale: scaleAnims[color] }] }]}
              >
                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={() => handleColorSelect(color)}
                  style={[styles.swatchRing, { borderColor: isSel ? color : 'transparent' }]}
                >
                  <View style={[styles.swatchBtn, { backgroundColor: color }]}>
                    {isSel && <Ionicons name="checkmark" size={18} color="#fff" />}
                  </View>
                </TouchableOpacity>
              </Animated.View>
            );
          })}
        </View>
      </View>

      <Text style={[styles.footerHint, { color: subText }]}>
        Accent applies to your sent messages, buttons, and highlights.
      </Text>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: pageBg }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          activeOpacity={0.6}
          style={[styles.headerBackBtn, { backgroundColor: cardBg }]}
        >
          <FontAwesome6 name="arrow-left" size={18} color={primaryText} />
        </TouchableOpacity>
        <View style={styles.flex}>
          <Text style={[styles.headerTitle, { color: primaryText }]}>Appearance</Text>
          <Text style={[styles.headerSubtitle, { color: subText }]}>Theme & chat accent</Text>
        </View>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {renderPreview()}
        {renderThemePicker()}
        {renderColorGrid()}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  gap4: { marginLeft: 4 },
  gap10: { marginLeft: 14 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 12,
  },
  headerBackBtn: {
    width: 40, height: 40, borderRadius: 12,
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
  scrollContent: { paddingHorizontal: 16, paddingBottom: 40 },

  // Preview
  previewWrap: {
    position: 'relative',
    marginTop: 4,
    marginBottom: 22,
  },
  previewHalo: {
    position: 'absolute',
    top: -40, right: -40,
    width: 220, height: 220, borderRadius: 110,
  },
  previewHalo2: {
    position: 'absolute',
    bottom: -30, left: -50,
    width: 180, height: 180, borderRadius: 90,
  },
  previewCard: {
    borderRadius: 22,
    overflow: 'hidden',
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 12 },
    shadowRadius: 24,
    elevation: 4,
  },
  previewTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
  previewAvatar: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
  },
  previewAvatarText: {
    fontFamily: 'Roboto-Bold',
    fontSize: 16,
  },
  previewName: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 15,
  },
  previewStatus: {
    fontFamily: 'Roboto-Regular',
    fontSize: 11,
    marginTop: 1,
  },
  previewDivider: { height: StyleSheet.hairlineWidth },

  previewChat: {
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 16,
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
    maxWidth: '80%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
    borderBottomLeftRadius: 4,
  },
  bubbleSent: {
    maxWidth: '80%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
    borderBottomRightRadius: 4,
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
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  composerText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
  },
  composerSend: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },

  // Sections
  section: { marginBottom: 18 },
  sectionTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 11, letterSpacing: 1.2,
    marginBottom: 10, marginLeft: 8,
  },
  sectionCard: {
    borderRadius: 18,
    overflow: 'hidden',
    shadowOpacity: 0.04,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 10,
    elevation: 2,
  },

  // Theme rows
  themeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 14,
    gap: 14,
  },
  themeIconWrap: {
    width: 42, height: 42, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
  },
  themeTextWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingRight: 16,
    gap: 10,
  },
  themeLabel: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 15,
    lineHeight: 20,
  },
  themeDesc: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
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

  // Color grid
  colorCard: { padding: 14 },
  colorGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SWATCH_GAP,
    rowGap: SWATCH_GAP + 2,
  },
  swatchOuter: {
    width: SWATCH_SIZE,
    height: SWATCH_SIZE,
    alignItems: 'center', justifyContent: 'center',
  },
  swatchRing: {
    width: SWATCH_SIZE,
    height: SWATCH_SIZE,
    borderRadius: SWATCH_SIZE / 2,
    borderWidth: 2,
    padding: 3,
    alignItems: 'center', justifyContent: 'center',
  },
  swatchBtn: {
    flex: 1,
    width: '100%',
    borderRadius: (SWATCH_SIZE - 10) / 2,
    alignItems: 'center', justifyContent: 'center',
  },

  footerHint: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 17,
    paddingHorizontal: 24,
    marginTop: 14,
  },
});
