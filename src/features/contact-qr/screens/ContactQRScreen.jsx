/**
 * "QR code" — WhatsApp-style two-tab screen: MY CODE | SCAN CODE.
 *
 * Opened from the QR icon in the chat-list header and the QR button on the
 * Settings profile card (routes `MyQR` / `ContactQRScanner`). Both land on
 * My code unless `route.params.initialTab === 'scan'`. Tabs switch by tap or
 * swipe; the header's share icon and ⋮ → Reset act on My code from either tab.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  ActivityIndicator,
  Modal,
  Pressable,
  Platform,
  StatusBar,
  useWindowDimensions,
} from 'react-native';
import { useSelector } from 'react-redux';
import { useIsFocused } from '@react-navigation/native';
import { FontAwesome6, Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../../contexts/ThemeContext';
import useMyContactQr from '../hooks/useMyContactQr';
import MyCodeTab from '../components/MyCodeTab';
import ScanCodeTab from '../components/ScanCodeTab';

const TABS = ['MY CODE', 'SCAN CODE'];
const SCAN_TAB = 1;

export default function ContactQRScreen({ navigation, route }) {
  const { theme, isDarkMode } = useTheme();
  const { width } = useWindowDimensions();
  const isFocused = useIsFocused();
  const { profileData } = useSelector((state) => state.profile);
  const userId = profileData?._id ? String(profileData._id) : null;

  const qr = useMyContactQr(userId);
  const shareCardRef = useRef(null);

  const initialIndex = route?.params?.initialTab === 'scan' ? SCAN_TAB : 0;
  const [index, setIndex] = useState(initialIndex);
  const indexRef = useRef(initialIndex);
  const scrollX = useRef(new Animated.Value(initialIndex * width)).current;
  const pagerRef = useRef(null);
  // A tab tap scrolls programmatically; the scroll events on the way must not
  // flip the index back mid-flight (that would mount/unmount the camera).
  const programmaticUntilRef = useRef(0);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    if (!initialIndex) return;
    requestAnimationFrame(() => pagerRef.current?.scrollTo({ x: initialIndex * width, animated: false }));
    // Mount-only: later width changes are handled by onLayout below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goToTab = useCallback((i) => {
    if (sheetOpen) return;
    programmaticUntilRef.current = Date.now() + 450;
    indexRef.current = i;
    setIndex(i);
    pagerRef.current?.scrollTo({ x: i * width, animated: true });
  }, [width, sheetOpen]);

  const onScroll = useMemo(() => Animated.event(
    [{ nativeEvent: { contentOffset: { x: scrollX } } }],
    {
      useNativeDriver: true,
      listener: (e) => {
        if (Date.now() < programmaticUntilRef.current) return;
        const i = Math.round(e.nativeEvent.contentOffset.x / width);
        if ((i === 0 || i === SCAN_TAB) && i !== indexRef.current) {
          indexRef.current = i;
          setIndex(i);
        }
      },
    },
  ), [scrollX, width]);

  // Rotation / split-screen: keep the current page in view.
  const onPagerLayout = useCallback(() => {
    pagerRef.current?.scrollTo({ x: indexRef.current * width, animated: false });
  }, [width]);

  // ── ⋮ menu ──
  const menuBtnRef = useRef(null);
  const [menuPos, setMenuPos] = useState(null);
  const openMenu = useCallback(() => {
    const node = menuBtnRef.current;
    if (!node?.measureInWindow) { setMenuPos({ top: 56, right: 8 }); return; }
    node.measureInWindow((x, y, w, h) => {
      // The Modal is statusBarTranslucent — add the status bar back on Android.
      const statusBarOffset = Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 0;
      setMenuPos({ top: y + h + 2 + statusBarOffset, right: Math.max(8, width - (x + w)) });
    });
  }, [width]);
  const closeMenu = useCallback(() => setMenuPos(null), []);
  const onReset = useCallback(() => {
    closeMenu();
    qr.confirmReset();
  }, [closeMenu, qr]);

  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.secondaryTextColor;
  const accent = theme.colors.themeColor;
  const headerBg = theme.colors.headerBackground;
  const canAct = Boolean(qr.token) && !qr.busy;

  const tabWidth = width / TABS.length;
  const underlineX = scrollX.interpolate({
    inputRange: [0, width],
    outputRange: [0, tabWidth],
    extrapolate: 'clamp',
  });

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { backgroundColor: headerBg }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn} activeOpacity={0.6}>
          <FontAwesome6 name="arrow-left" size={19} color={primaryText} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: primaryText }]} numberOfLines={1}>QR code</Text>
        <TouchableOpacity
          onPress={() => qr.share(shareCardRef)}
          disabled={!canAct}
          style={[styles.headerBtn, { opacity: qr.token ? 1 : 0.4 }]}
          activeOpacity={0.6}
        >
          {qr.busy === 'share'
            ? <ActivityIndicator size="small" color={primaryText} />
            : <Ionicons name="share-social-outline" size={22} color={primaryText} />}
        </TouchableOpacity>
        <TouchableOpacity ref={menuBtnRef} onPress={openMenu} style={styles.headerBtn} activeOpacity={0.6}>
          <Ionicons name="ellipsis-vertical" size={20} color={primaryText} />
        </TouchableOpacity>
      </View>

      <View
        style={[
          styles.tabBar,
          { backgroundColor: headerBg, borderBottomColor: isDarkMode ? 'rgba(255,255,255,0.06)' : theme.colors.borderColor },
        ]}
      >
        {TABS.map((label, i) => (
          <TouchableOpacity key={label} onPress={() => goToTab(i)} style={styles.tab} activeOpacity={0.7}>
            <Text style={[styles.tabText, { color: index === i ? primaryText : subText }]}>{label}</Text>
          </TouchableOpacity>
        ))}
        <Animated.View
          style={[
            styles.underline,
            { width: tabWidth, backgroundColor: accent, transform: [{ translateX: underlineX }] },
          ]}
        />
      </View>

      <Animated.ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        bounces={false}
        overScrollMode="never"
        showsHorizontalScrollIndicator={false}
        scrollEnabled={!sheetOpen}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        onScroll={onScroll}
        onLayout={onPagerLayout}
        style={styles.pager}
      >
        <View style={{ width }}>
          <MyCodeTab qr={qr} profileData={profileData} captureRef={shareCardRef} />
        </View>
        <View style={{ width }}>
          <ScanCodeTab
            active={isFocused && index === SCAN_TAB}
            navigation={navigation}
            routeKey={route.key}
            onSheetOpenChange={setSheetOpen}
          />
        </View>
      </Animated.ScrollView>

      <Modal visible={Boolean(menuPos)} transparent animationType="fade" statusBarTranslucent onRequestClose={closeMenu}>
        <Pressable style={StyleSheet.absoluteFill} onPress={closeMenu} />
        <View
          style={[
            styles.menu,
            { top: menuPos?.top ?? 0, right: menuPos?.right ?? 8, backgroundColor: theme.colors.menuBackground },
          ]}
        >
          <TouchableOpacity onPress={onReset} disabled={!canAct} style={styles.menuItem} activeOpacity={0.6}>
            <Text style={[styles.menuText, { color: canAct ? primaryText : subText }]}>Reset QR code</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingTop: 6,
    paddingBottom: 6,
    gap: 2,
  },
  headerBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, fontFamily: 'Roboto-Medium', fontSize: 21, marginLeft: 8, letterSpacing: -0.2 },

  tabBar: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 14 },
  tabText: { fontFamily: 'Roboto-Medium', fontSize: 15, letterSpacing: 0.4 },
  underline: { position: 'absolute', left: 0, bottom: 0, height: 3, borderTopLeftRadius: 3, borderTopRightRadius: 3 },

  pager: { flex: 1 },

  menu: {
    position: 'absolute',
    minWidth: 190,
    borderRadius: 12,
    paddingVertical: 6,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  menuItem: { paddingHorizontal: 18, paddingVertical: 13 },
  menuText: { fontFamily: 'Roboto-Regular', fontSize: 15.5 },
});
