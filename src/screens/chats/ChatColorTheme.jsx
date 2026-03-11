import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Animated,
  StyleSheet,
  Dimensions,
  Switch,
} from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FontAwesome6, Ionicons } from '@expo/vector-icons';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const SWATCH_GAP = 10;
const SWATCHES_PER_ROW = 5;
const SWATCH_SIZE = (SCREEN_WIDTH - 40 - SWATCH_GAP * (SWATCHES_PER_ROW - 1)) / SWATCHES_PER_ROW;

export default function ChatColorTheme({ navigation }) {
  const { theme, updateChatColor, toggleTheme, isDarkMode, hasManualTheme, setTheme, resetThemeToSystem } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const [selectedColor, setSelectedColor] = useState(null);
  const scaleAnims = useRef({}).current;

  useEffect(() => {
    const loadSavedColor = async () => {
      try {
        const savedColor = await AsyncStorage.getItem('selectedColor');
        if (savedColor) {
          setSelectedColor(savedColor);
          updateChatColor(savedColor);
        } else {
          setSelectedColor(theme.colors.themeColor);
          updateChatColor(theme.colors.themeColor);
        }
      } catch (error) {
        console.error('Error loading saved color:', error);
        setSelectedColor(theme.colors.themeColor);
        updateChatColor(theme.colors.themeColor);
      }
    };

    loadSavedColor();
  }, []);

  const colors = [
    "#34B7F1", "#128C7E", "#075E54",
    "#833AB4", "#777737", "#F56040", "#FF5A5F",
    "#3A3A3A", "#FF0000", "#484848", "#767676",
  ];

  // Initialize scale anims for each color
  colors.forEach((color) => {
    if (!scaleAnims[color]) {
      scaleAnims[color] = new Animated.Value(1);
    }
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }).start();
    }, 400);
    return () => clearTimeout(timer);
  }, []);

  const handleColorSelect = async (color) => {
    // Bounce animation on the selected swatch
    if (scaleAnims[color]) {
      Animated.sequence([
        Animated.timing(scaleAnims[color], { toValue: 0.85, duration: 100, useNativeDriver: true }),
        Animated.spring(scaleAnims[color], { toValue: 1, tension: 200, friction: 8, useNativeDriver: true }),
      ]).start();
    }

    setSelectedColor(color);

    try {
      await AsyncStorage.setItem('selectedColor', color);
      updateChatColor(color);
    } catch (error) {
      console.error("Error saving color to AsyncStorage:", error);
    }
  };

  const activeColor = selectedColor || theme.colors.themeColor;

  // ─── CHAT PREVIEW ───
  const renderChatPreview = () => (
    <View style={[styles.previewCard, { backgroundColor: theme.colors.menuBackground }]}>
      <Text style={[styles.previewLabel, { color: theme.colors.placeHolderTextColor }]}>Preview</Text>
      <View style={styles.previewChat}>
        {/* Received bubble */}
        <View style={styles.previewRowLeft}>
          <View style={[styles.previewAvatar, { backgroundColor: theme.colors.placeHolderTextColor + '30' }]}>
            <Text style={[styles.previewAvatarText, { color: theme.colors.placeHolderTextColor }]}>J</Text>
          </View>
          <View style={[styles.bubbleReceived, { backgroundColor: theme.colors.cardBackground || theme.colors.background }]}>
            <Text style={[styles.bubbleText, { color: theme.colors.primaryTextColor }]}>Hey! How are you?</Text>
            <Text style={[styles.bubbleTime, { color: theme.colors.placeHolderTextColor }]}>10:30 AM</Text>
          </View>
        </View>
        {/* Sent bubble */}
        <View style={styles.previewRowRight}>
          <View style={[styles.bubbleSent, { backgroundColor: activeColor }]}>
            <Text style={[styles.bubbleText, { color: '#fff' }]}>I'm great, thanks!</Text>
            <View style={styles.bubbleSentMeta}>
              <Text style={[styles.bubbleTime, { color: 'rgba(255,255,255,0.7)' }]}>10:31 AM</Text>
              <Ionicons name="checkmark-done" size={14} color="rgba(255,255,255,0.7)" style={{ marginLeft: 4 }} />
            </View>
          </View>
        </View>
        {/* Received bubble 2 */}
        <View style={styles.previewRowLeft}>
          <View style={{ width: 28 }} />
          <View style={[styles.bubbleReceived, { backgroundColor: theme.colors.cardBackground || theme.colors.background }]}>
            <Text style={[styles.bubbleText, { color: theme.colors.primaryTextColor }]}>That's awesome! 🎉</Text>
            <Text style={[styles.bubbleTime, { color: theme.colors.placeHolderTextColor }]}>10:32 AM</Text>
          </View>
        </View>
      </View>
    </View>
  );

  // ─── SETTINGS SECTION ───
  const renderSettingsSection = () => (
    <View style={[styles.settingsCard, { backgroundColor: theme.colors.menuBackground }]}>
      <Text style={[styles.sectionTitle, { color: theme.colors.placeHolderTextColor }]}>Display</Text>

      {/* Theme toggle */}
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={toggleTheme}
        style={styles.settingRow}
      >
        <View style={[styles.settingIcon, { backgroundColor: isDarkMode ? '#6C5CE7' : '#FDCB6E' }]}>
          <Ionicons name={isDarkMode ? 'moon' : 'sunny'} size={18} color="#fff" />
        </View>
        <View style={styles.settingTextWrap}>
          <Text style={[styles.settingLabel, { color: theme.colors.primaryTextColor }]}>Dark Mode</Text>
          <Text style={[styles.settingValue, { color: theme.colors.placeHolderTextColor }]}>
            {isDarkMode ? 'On' : 'Off'}
          </Text>
        </View>
        <Switch
          value={isDarkMode && hasManualTheme}
          onValueChange={toggleTheme}
          trackColor={{ false: theme.colors.borderColor, true: activeColor + '60' }}
          thumbColor={isDarkMode && hasManualTheme ? activeColor : theme.colors.placeHolderTextColor}
        />
      </TouchableOpacity>

      <View style={[styles.settingDivider, { backgroundColor: theme.colors.borderColor }]} />

      {/* System theme */}
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={hasManualTheme ? resetThemeToSystem : undefined}
        style={styles.settingRow}
      >
        <View style={[styles.settingIcon, { backgroundColor: '#0984E3' }]}>
          <Ionicons name="phone-portrait-outline" size={18} color="#fff" />
        </View>
        <View style={styles.settingTextWrap}>
          <Text style={[styles.settingLabel, { color: theme.colors.primaryTextColor }]}>System Theme</Text>
          <Text style={[styles.settingValue, { color: theme.colors.placeHolderTextColor }]}>
            Follow device settings
          </Text>
        </View>
        <Switch
          value={!hasManualTheme}
          onValueChange={() => hasManualTheme ? resetThemeToSystem() : toggleTheme()}
          trackColor={{ false: theme.colors.borderColor, true: activeColor + '60' }}
          thumbColor={!hasManualTheme ? activeColor : theme.colors.placeHolderTextColor}
        />
      </TouchableOpacity>
    </View>
  );

  // ─── COLOR GRID ───
  const renderColorGrid = () => (
    <View style={styles.colorSection}>
      <Text style={[styles.sectionTitle, { color: theme.colors.placeHolderTextColor, paddingHorizontal: 0 }]}>
        Chat Accent Color
      </Text>
      <View style={styles.colorGrid}>
        {colors.map((color) => {
          const isSelected = selectedColor === color;
          const animScale = scaleAnims[color] || new Animated.Value(1);

          return (
            <Animated.View
              key={color}
              style={[
                styles.swatchOuter,
                { transform: [{ scale: animScale }] },
              ]}
            >
              <TouchableOpacity
                activeOpacity={0.75}
                onPress={() => handleColorSelect(color)}
                style={[
                  styles.swatchBtn,
                  {
                    backgroundColor: color,
                    borderColor: isSelected ? theme.colors.primaryTextColor : 'transparent',
                    borderWidth: isSelected ? 2.5 : 0,
                  },
                ]}
              >
                {/* Mini chat bubble inside swatch */}
                <View style={styles.swatchBubbleLeft}>
                  <View style={[styles.swatchMiniBar, { backgroundColor: 'rgba(255,255,255,0.3)', width: 18 }]} />
                </View>
                <View style={styles.swatchBubbleRight}>
                  <View style={[styles.swatchMiniBar, { backgroundColor: 'rgba(255,255,255,0.55)', width: 22 }]} />
                </View>

                {/* Selected check */}
                {isSelected && (
                  <View style={styles.swatchCheck}>
                    <Ionicons name="checkmark-circle" size={22} color="#fff" />
                  </View>
                )}
              </TouchableOpacity>

              {/* Active dot indicator */}
              {isSelected && (
                <View style={[styles.swatchDot, { backgroundColor: color }]} />
              )}
            </Animated.View>
          );
        })}
      </View>
    </View>
  );

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: theme.colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: theme.colors.background }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.6} style={styles.headerBackBtn}>
          <FontAwesome6 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.primaryTextColor }]}>
          Appearance
        </Text>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {renderChatPreview()}
        {renderSettingsSection()}
        {renderColorGrid()}

        {/* Footer hint */}
        <Text style={[styles.footerHint, { color: theme.colors.placeHolderTextColor }]}>
          Accent color applies to your sent messages, buttons, and highlights across the app.
        </Text>
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },

  // ─── HEADER ───
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 12,
    gap: 6,
  },
  headerBackBtn: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 21,
  },
  headerTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: 18,
    letterSpacing: 0.2,
  },

  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },

  // ─── SECTION TITLE ───
  sectionTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: 13,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 12,
    paddingHorizontal: 4,
  },

  // ─── CHAT PREVIEW ───
  previewCard: {
    borderRadius: 16,
    padding: 14,
    marginBottom: 20,
  },
  previewLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 10,
    textAlign: 'center',
  },
  previewChat: {
    gap: 6,
  },
  previewRowLeft: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
  },
  previewRowRight: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  previewAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewAvatarText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: 12,
  },
  bubbleReceived: {
    maxWidth: '70%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    borderBottomLeftRadius: 4,
  },
  bubbleSent: {
    maxWidth: '70%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    borderBottomRightRadius: 4,
  },
  bubbleText: {
    fontFamily: 'Poppins-Regular',
    fontSize: 13,
    lineHeight: 19,
  },
  bubbleTime: {
    fontFamily: 'Poppins-Regular',
    fontSize: 10,
    marginTop: 2,
    alignSelf: 'flex-end',
  },
  bubbleSentMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    marginTop: 2,
  },

  // ─── SETTINGS ───
  settingsCard: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 6,
  },
  settingIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingTextWrap: {
    flex: 1,
  },
  settingLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: 14,
    lineHeight: 20,
  },
  settingValue: {
    fontFamily: 'Poppins-Regular',
    fontSize: 12,
    marginTop: -1,
  },
  settingDivider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 8,
    marginLeft: 48,
  },

  // ─── COLOR GRID ───
  colorSection: {
    marginBottom: 20,
  },
  colorGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SWATCH_GAP,
  },
  swatchOuter: {
    width: SWATCH_SIZE,
    alignItems: 'center',
  },
  swatchBtn: {
    width: SWATCH_SIZE,
    height: SWATCH_SIZE * 1.2,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 4,
    overflow: 'hidden',
  },
  swatchBubbleLeft: {
    alignSelf: 'flex-start',
    marginLeft: 8,
  },
  swatchBubbleRight: {
    alignSelf: 'flex-end',
    marginRight: 8,
  },
  swatchMiniBar: {
    height: 6,
    borderRadius: 3,
  },
  swatchCheck: {
    position: 'absolute',
    bottom: 4,
    right: 4,
  },
  swatchDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 6,
  },

  // ─── FOOTER ───
  footerHint: {
    fontFamily: 'Poppins-Regular',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: 20,
    marginTop: 4,
  },
});