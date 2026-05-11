import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  Animated,
  Image,
  Platform,
  ToastAndroid,
  Alert,
} from 'react-native';
import { FontAwesome6, Entypo } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme } from '../../../contexts/ThemeContext';
import useDeviceLinking from '../hooks/useDeviceLinking';
import DeviceListItem from '../components/DeviceListItem';
import EmptyDevices from '../components/EmptyDevices';

function showToast(message) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    Alert.alert('', message);
  }
}

function SkeletonItem({ theme }) {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, []);

  const bg = theme.colors.borderColor;

  return (
    <Animated.View style={[styles.skeletonRow, { opacity }]}>
      <View style={[styles.skeletonCircle, { backgroundColor: bg }]} />
      <View style={styles.skeletonLines}>
        <View style={[styles.skeletonLine, { backgroundColor: bg, width: '60%' }]} />
        <View style={[styles.skeletonLine, { backgroundColor: bg, width: '80%', height: 10 }]} />
        <View style={[styles.skeletonLine, { backgroundColor: bg, width: '45%', height: 8 }]} />
      </View>
    </Animated.View>
  );
}

export default function LinkedDevicesScreen({ navigation }) {
  const { theme } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const [initialLoad, setInitialLoad] = useState(true);

  const {
    linkedDevices,
    fetchDevices,
    isFetching,
    unlinkDevice,
    error,
    clearError,
  } = useDeviceLinking();

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 400,
      useNativeDriver: true,
    }).start();
  }, []);

  // Fetch on mount
  useEffect(() => {
    fetchDevices().finally(() => setInitialLoad(false));
  }, [fetchDevices]);

  // Re-fetch when screen comes back into focus (e.g. after linking a device)
  useFocusEffect(
    useCallback(() => {
      if (!initialLoad) {
        fetchDevices();
      }
    }, [fetchDevices, initialLoad])
  );

  const handleDevicePress = useCallback((device) => {
    const info = device.deviceInfo || device;
    const name = info.deviceName || device.deviceName || 'Unknown Device';
    const deviceId = device.deviceId || device._id;

    Alert.alert(
      'Unlink this device?',
      `This device will no longer have access to your chats. The web session will be terminated immediately.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unlink',
          style: 'destructive',
          onPress: async () => {
            const success = await unlinkDevice(deviceId);
            if (success) {
              showToast('Device unlinked. Web session terminated.');
              fetchDevices();
            } else {
              showToast(error || 'Failed to unlink device');
            }
          },
        },
      ]
    );
  }, [unlinkDevice, fetchDevices, error]);

  const renderDevice = useCallback(({ item }) => (
    <DeviceListItem device={item} onPress={() => handleDevicePress(item)} />
  ), [handleDevicePress]);

  const keyExtractor = useCallback(
    (item) => item.deviceId || item._id || item.sessionId || String(Math.random()),
    []
  );

  const renderSkeleton = () => (
    <View>
      {[0, 1, 2].map((i) => (
        <SkeletonItem key={i} theme={theme} />
      ))}
    </View>
  );

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: theme.colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: theme.colors.borderColor }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <FontAwesome6 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.primaryTextColor }]}>
          Linked Devices
        </Text>
      </View>

      <FlatList
        data={linkedDevices}
        renderItem={renderDevice}
        keyExtractor={keyExtractor}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isFetching && !initialLoad}
            onRefresh={fetchDevices}
            colors={[theme.colors.themeColor]}
            tintColor={theme.colors.themeColor}
          />
        }
        ListHeaderComponent={
          <View>
            {/* Banner image */}
            <View style={styles.bannerContainer}>
              <Image
                source={require('../../../../assets/images/devicelink.png')}
                style={styles.bannerImage}
              />
            </View>

            {/* Link button */}
            <TouchableOpacity
              onPress={() => navigation.navigate('QRScanner')}
              activeOpacity={0.9}
              style={[styles.linkBtn, { backgroundColor: theme.colors.themeColor }]}
            >
              <Entypo name="plus" size={20} color={theme.colors.textWhite} />
              <Text style={[styles.linkBtnText, { color: theme.colors.textWhite }]}>
                Link a New Device
              </Text>
            </TouchableOpacity>

            {/* Section label */}
            <View style={styles.sectionLabel}>
              <Text style={[styles.sectionTitle, { color: theme.colors.placeHolderTextColor }]}>
                Linked Devices
              </Text>
              <Text style={[styles.sectionSubtitle, { color: theme.colors.placeHolderTextColor }]}>
                Tap a device to unlink it
              </Text>
            </View>
          </View>
        }
        ListEmptyComponent={
          initialLoad ? renderSkeleton() : <EmptyDevices />
        }
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    gap: 10,
    borderBottomWidth: 1,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 16,
    textTransform: 'capitalize',
  },
  listContent: {
    paddingHorizontal: 14,
    paddingBottom: 30,
  },
  bannerContainer: {
    width: '100%',
    height: 250,
  },
  bannerImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'contain',
  },
  linkBtn: {
    width: '100%',
    height: 48,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 40,
    marginVertical: 10,
  },
  linkBtnText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 16,
  },
  sectionLabel: {
    marginTop: 10,
    marginBottom: 6,
  },
  sectionTitle: {
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
  },
  sectionSubtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 2,
  },
  // Skeleton
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
    gap: 12,
  },
  skeletonCircle: {
    width: 50,
    height: 50,
    borderRadius: 25,
  },
  skeletonLines: {
    flex: 1,
    gap: 6,
  },
  skeletonLine: {
    height: 12,
    borderRadius: 4,
  },
});