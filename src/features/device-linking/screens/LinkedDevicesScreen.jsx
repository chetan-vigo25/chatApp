import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  RefreshControl,
  Animated,
  Platform,
  ToastAndroid,
  Alert,
} from 'react-native';
import { FontAwesome6, Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme } from '../../../contexts/ThemeContext';
import useDeviceLinking from '../hooks/useDeviceLinking';
import DeviceListItem from '../components/DeviceListItem';
import DeviceLinkArt from '../components/DeviceLinkArt';

function showToast(message) {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else Alert.alert('', message);
}

function SkeletonRow({ theme }) {
  const opacity = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const a = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ])
    );
    a.start();
    return () => a.stop();
  }, []);
  const bg = theme.colors.borderColor;
  return (
    <Animated.View style={[styles.skelRow, { opacity }]}>
      <View style={[styles.skelCircle, { backgroundColor: bg }]} />
      <View style={styles.skelLines}>
        <View style={[styles.skelLine, { backgroundColor: bg, width: '55%' }]} />
        <View style={[styles.skelLine, { backgroundColor: bg, width: '72%', height: 10 }]} />
      </View>
    </Animated.View>
  );
}

export default function LinkedDevicesScreen({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const [initialLoad, setInitialLoad] = useState(true);

  const { linkedDevices, fetchDevices, isFetching, unlinkDevice, error } = useDeviceLinking();

  const pageBg = isDarkMode ? '#0B141A' : '#FFFFFF';
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.secondaryTextColor;
  const dividerClr = isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(15,30,50,0.08)';
  const linkBlue = isDarkMode ? '#53BDEB' : '#027EB5';
  // Brand palette — drives the button, illustration, and accents.
  const brand = theme.colors.themeColor;
  const brandDark = isDarkMode ? '#0C8C77' : '#017A68';

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 380, useNativeDriver: true }).start();
  }, []);

  useEffect(() => {
    fetchDevices().finally(() => setInitialLoad(false));
  }, [fetchDevices]);

  useFocusEffect(
    useCallback(() => {
      if (!initialLoad) fetchDevices();
    }, [fetchDevices, initialLoad])
  );

  const handleDevicePress = useCallback((device) => {
    const info = device.deviceInfo || device;
    const name = info.deviceName || device.deviceName || 'this device';
    const deviceId = device.deviceId || device._id;
    Alert.alert(
      name,
      'Log this device out? It will lose access to your chats immediately.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Log out',
          style: 'destructive',
          onPress: async () => {
            const ok = await unlinkDevice(deviceId);
            if (ok) { showToast('Device logged out.'); fetchDevices(); }
            else showToast(error || 'Failed to log out device');
          },
        },
      ]
    );
  }, [unlinkDevice, fetchDevices, error]);

  const renderDevice = useCallback(({ item }) => (
    <DeviceListItem device={item} onPress={() => handleDevicePress(item)} />
  ), [handleDevicePress]);

  const keyExtractor = useCallback(
    (item, i) => item.deviceId || item._id || item.sessionId || `dev-${i}`,
    []
  );

  const count = linkedDevices?.length || 0;

  const ListHeader = (
    <View>
      {/* Illustration */}
      <View style={styles.heroWrap}>
        <DeviceLinkArt size={236} accent={brand} accentDark={brandDark} dark={isDarkMode} />
      </View>

      {/* Caption + Learn more */}
      <Text style={[styles.caption, { color: subText }]}>
        You can link other devices to this account.
      </Text>
      <TouchableOpacity activeOpacity={0.6} onPress={() => navigation.navigate('Privacy')}>
        <Text style={[styles.learnMore, { color: linkBlue }]}>Learn more</Text>
      </TouchableOpacity>

      {/* Link a device button */}
      <TouchableOpacity
        onPress={() => navigation.navigate('QRScanner')}
        activeOpacity={0.85}
        style={[styles.linkBtn, { backgroundColor: brand }]}
      >
        <Text style={[styles.linkBtnText, { color: theme.colors.textWhite }]}>Link a device</Text>
      </TouchableOpacity>

      {/* Divider */}
      <View style={[styles.divider, { backgroundColor: dividerClr }]} />

      {/* Section */}
      <Text style={[styles.sectionLabel, { color: subText }]}>DEVICE STATUS</Text>
      <Text style={[styles.sectionHint, { color: subText }]}>
        {count > 0 ? 'Tap a device to log it out.' : 'No devices are currently linked.'}
      </Text>

      {initialLoad && (
        <View style={styles.skelGroup}>
          {[0, 1].map((i) => <SkeletonRow key={i} theme={theme} />)}
        </View>
      )}
    </View>
  );

  const ListFooter = (
    <View style={styles.footer}>
      <Ionicons name="lock-closed" size={15} color={subText} style={styles.footerLock} />
      <Text style={[styles.footerText, { color: subText }]}>
        Your personal messages are{' '}
        <Text style={{ color: brand, fontFamily: 'Roboto-Medium' }}>end-to-end encrypted</Text>
        {' '}on all your devices.
      </Text>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: pageBg }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: dividerClr }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.6} style={styles.backBtn}>
          <FontAwesome6 name="arrow-left" size={20} color={primaryText} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: primaryText }]}>Linked devices</Text>
      </View>

      <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
        <FlatList
          data={initialLoad ? [] : linkedDevices}
          renderItem={renderDevice}
          keyExtractor={keyExtractor}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={isFetching && !initialLoad}
              onRefresh={fetchDevices}
              colors={[brand]}
              tintColor={brand}
            />
          }
          ListHeaderComponent={ListHeader}
          ListFooterComponent={ListFooter}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { width: 32, height: 36, alignItems: 'flex-start', justifyContent: 'center' },
  headerTitle: { fontFamily: 'Roboto-Medium', fontSize: 21, letterSpacing: -0.2 },

  listContent: { paddingHorizontal: 22, paddingBottom: 40 },

  heroWrap: { alignItems: 'center', marginTop: 18, marginBottom: 18 },

  caption: {
    fontFamily: 'Roboto-Regular',
    fontSize: 15.5,
    textAlign: 'center',
    lineHeight: 22,
  },
  learnMore: {
    fontFamily: 'Roboto-Medium',
    fontSize: 15.5,
    textAlign: 'center',
    marginTop: 4,
  },

  linkBtn: {
    marginTop: 26,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkBtnText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 16.5,
    color: '#0B141A',
    letterSpacing: 0.2,
  },

  divider: {
    height: StyleSheet.hairlineWidth,
    marginTop: 28,
    marginBottom: 22,
  },

  sectionLabel: {
    fontFamily: 'Roboto-Medium',
    fontSize: 13,
    letterSpacing: 0.8,
  },
  sectionHint: {
    fontFamily: 'Roboto-Regular',
    fontSize: 15,
    marginTop: 6,
    marginBottom: 6,
  },

  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'flex-start',
    marginTop: 26,
    paddingHorizontal: 8,
  },
  footerLock: { marginTop: 2, marginRight: 7 },
  footerText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13.5,
    textAlign: 'center',
    lineHeight: 20,
    flexShrink: 1,
  },

  // skeleton
  skelGroup: { marginTop: 6 },
  skelRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 18 },
  skelCircle: { width: 50, height: 50, borderRadius: 25 },
  skelLines: { flex: 1, gap: 8 },
  skelLine: { height: 13, borderRadius: 5 },
});
