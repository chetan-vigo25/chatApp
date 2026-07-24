import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Animated,
  StyleSheet, ActivityIndicator,
} from 'react-native';
import { FontAwesome6, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme } from '../../contexts/ThemeContext';
import { getUserSettings, readAppLockScope } from '../../Redux/Services/Profile/Settings.Services';

export default function ChatPrivacy({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(16)).current;

  const [loading, setLoading] = useState(true);
  const [hasPassword, setHasPassword] = useState(false);
  const [twoStepEnabled, setTwoStepEnabled] = useState(false);
  const [hasTwoStepPwd, setHasTwoStepPwd] = useState(false);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 350, useNativeDriver: true }),
      Animated.spring(slideAnim, { toValue: 0, friction: 9, tension: 60, useNativeDriver: true }),
    ]).start();
  }, []);

  // Re-fetch each time the screen regains focus so the row reflects any
  // change made on the DeletedChatsPassword screen.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        try {
          const settings = await getUserSettings();
          if (!alive) return;
          const chat = settings?.chat || {};
          const flag =
            typeof chat.hasDeletedPassword === 'boolean'
              ? chat.hasDeletedPassword
              : !!chat.deletedPassword;
          setHasPassword(flag);
          // This device's app lock only — the website carries its own.
          const two = readAppLockScope(settings);
          setTwoStepEnabled(two.enabled);
          setHasTwoStepPwd(two.hasPassword);
        } catch {
          /* keep last state */
        } finally {
          if (alive) setLoading(false);
        }
      })();
      return () => { alive = false; };
    }, [])
  );

  const themeColor = theme.colors.themeColor;
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const pageBg = theme.colors.background;
  const cardBg = theme.colors.background;
  const borderClr = isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(15,30,50,0.06)';

  const renderHeader = () => (
    <View style={styles.header}>
      <TouchableOpacity
        onPress={() => navigation.goBack()}
        activeOpacity={0.6}
        style={[styles.headerBackBtn, { backgroundColor: cardBg }]}
      >
        <FontAwesome6 name="arrow-left" size={18} color={primaryText} />
      </TouchableOpacity>
      <View style={styles.flex}>
        <Text style={[styles.headerTitle, { color: primaryText }]}>Chat Privacy</Text>
      </View>
    </View>
  );

  const renderHero = () => (
    <Animated.View
      style={[
        styles.heroWrap,
        { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
      ]}
    >
      <View pointerEvents="none" style={[styles.heroHalo, { backgroundColor: themeColor + '22' }]} />
      <View pointerEvents="none" style={[styles.heroHalo2, { backgroundColor: themeColor + '10' }]} />
      <View style={[styles.heroCard, { backgroundColor: cardBg, shadowColor: isDarkMode ? 'transparent' : '#0B141A' }]}>
        <View style={[styles.heroBadge, { backgroundColor: themeColor + '1A' }]}>
          <Ionicons name="shield-checkmark" size={26} color={themeColor} />
        </View>
        <Text style={[styles.heroTitle, { color: primaryText }]}>
          Privacy controls for your chats
        </Text>
        <Text style={[styles.heroBody, { color: subText }]}>
          Manage who can access deleted messages and other sensitive areas.
          All credentials are encrypted server-side.
        </Text>
      </View>
    </Animated.View>
  );

  const renderRows = () => (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: subText }]}>SECURITY</Text>
      <View style={[
        styles.sectionCard,
        { backgroundColor: cardBg, shadowColor: isDarkMode ? 'transparent' : '#0B141A' },
      ]}>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => navigation.navigate('DeletedChatsPassword')}
          style={[styles.row, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: borderClr }]}
        >
          <View style={[styles.rowIconWrap, { backgroundColor: themeColor + '1A' }]}>
            <Ionicons
              name={hasPassword ? 'lock-closed' : 'lock-open-outline'}
              size={20}
              color={themeColor}
            />
          </View>
          <View style={styles.rowTextWrap}>
            <View style={styles.flex}>
              <Text style={[styles.rowLabel, { color: primaryText }]}>
                Chat delete password
              </Text>
              <Text style={[styles.rowSub, { color: subText }]}>
                {loading
                  ? 'Loading…'
                  : hasPassword
                  ? 'Active — tap to update or reset'
                  : 'Not set — tap to enable'}
              </Text>
            </View>
            {loading ? (
              <ActivityIndicator size="small" color={subText} />
            ) : (
              <View style={styles.trailing}>
                <View style={[styles.statusDot, {
                  backgroundColor: hasPassword ? '#00B894' : '#FFA500',
                }]} />
                <Ionicons name="chevron-forward" size={17} color={subText} />
              </View>
            )}
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => navigation.navigate('TwoStepPassword')}
          style={styles.row}
        >
          <View style={[styles.rowIconWrap, { backgroundColor: themeColor + '1A' }]}>
            <MaterialCommunityIcons
              name={twoStepEnabled && hasTwoStepPwd ? 'shield-key' : 'shield-key-outline'}
              size={20}
              color={themeColor}
            />
          </View>
          <View style={styles.rowTextWrap}>
            <View style={styles.flex}>
              <Text style={[styles.rowLabel, { color: primaryText }]}>
                App lock password
              </Text>
              <Text style={[styles.rowSub, { color: subText }]}>
                {loading
                  ? 'Loading…'
                  : twoStepEnabled
                  ? (hasTwoStepPwd
                      ? 'Active — required to open the app'
                      : 'Enabled — set a password to arm it')
                  : 'Off — tap to enable'}
              </Text>
            </View>
            {loading ? (
              <ActivityIndicator size="small" color={subText} />
            ) : (
              <View style={styles.trailing}>
                <View style={[styles.statusDot, {
                  backgroundColor: twoStepEnabled && hasTwoStepPwd ? '#00B894' : '#FFA500',
                }]} />
                <Ionicons name="chevron-forward" size={17} color={subText} />
              </View>
            )}
          </View>
        </TouchableOpacity>
      </View>

    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: pageBg }]}>
      {renderHeader()}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {renderRows()}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
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
  scrollContent: { paddingHorizontal: 12, paddingBottom: 40 },

  heroWrap: { position: 'relative', marginTop: 4, marginBottom: 22 },
  heroHalo: {
    position: 'absolute',
    top: -40, right: -40,
    width: 200, height: 200, borderRadius: 100,
  },
  heroHalo2: {
    position: 'absolute',
    bottom: -30, left: -40,
    width: 160, height: 160, borderRadius: 80,
  },
  heroCard: {
    borderRadius: 22,
    padding: 22,
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 12 },
    shadowRadius: 22,
    elevation: 4,
  },
  heroBadge: {
    width: 56, height: 56, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 14,
  },
  heroTitle: {
    fontFamily: 'Roboto-Bold',
    fontSize: 18,
    marginBottom: 6,
  },
  heroBody: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    lineHeight: 19,
  },

  section: { marginBottom: 18 },
  sectionTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 11,
    letterSpacing: 1.2,
    marginBottom: 10,
    marginLeft: 8,
  },
  sectionCard: {
    borderRadius: 18,
    overflow: 'hidden',
    shadowOpacity: 0.04,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 10,
    elevation: 2,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 14,
    gap: 14,
  },
  rowIconWrap: {
    width: 42, height: 42, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  rowTextWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingRight: 12,
    gap: 10,
  },
  rowLabel: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 15,
    lineHeight: 20,
  },
  rowSub: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 2,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },

  footerHint: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 17,
    paddingHorizontal: 24,
    marginTop: 14,
  },
});
