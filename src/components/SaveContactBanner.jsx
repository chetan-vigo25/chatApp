import React, { useRef, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Animated,
  StyleSheet,
  Alert,
  Linking,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../contexts/ThemeContext';

/**
 * WhatsApp-style banner shown at the top of the message list when chatting
 * with a TalksTry user who is NOT saved in device contacts.
 *
 * Props:
 *   peerName       {string}   Display name of the peer
 *   isSaving       {boolean}
 *   isSyncing      {boolean}
 *   savedSuccessfully {boolean}
 *   saveError      {string|null}  'permission_denied' or generic message
 *   onSave         {function}  Called when user taps "Save"
 */
const SaveContactBanner = ({
  peerName,
  isSaving,
  isSyncing,
  savedSuccessfully,
  saveError,
  onSave,
}) => {
  const { theme, isDarkMode } = useTheme();
  const slideAnim = useRef(new Animated.Value(-80)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, tension: 60, friction: 8 }),
      Animated.timing(opacityAnim, { toValue: 1, duration: 250, useNativeDriver: true }),
    ]).start();
  }, []);

  const handleSave = () => {
    if (saveError === 'permission_denied') {
      Alert.alert(
        'Permission Required',
        'TalksTry needs access to your contacts to save this number. Please allow it in Settings.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Open Settings',
            onPress: () => {
              if (Platform.OS === 'ios') {
                Linking.openURL('app-settings:');
              } else {
                Linking.openSettings();
              }
            },
          },
        ],
      );
      return;
    }
    onSave?.();
  };

  const bg = isDarkMode ? '#1A2B3C' : '#F0F9FF';
  const border = isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,122,255,0.15)';
  const iconColor = '#3B82F6';
  const textColor = isDarkMode ? '#C8D8E4' : '#374151';
  const subColor = isDarkMode ? 'rgba(200,216,228,0.55)' : '#6B7280';

  if (savedSuccessfully) {
    return (
      <Animated.View style={[styles.banner, { backgroundColor: isDarkMode ? '#0D2B1A' : '#F0FDF4', borderColor: isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(34,197,94,0.2)', opacity: opacityAnim, transform: [{ translateY: slideAnim }] }]}>
        <Ionicons name="checkmark-circle" size={18} color="#22C55E" style={styles.icon} />
        <Text style={[styles.savedText, { color: isDarkMode ? '#86EFAC' : '#15803D' }]}>
          Contact saved successfully
        </Text>
      </Animated.View>
    );
  }

  return (
    <Animated.View style={[styles.banner, { backgroundColor: bg, borderColor: border, opacity: opacityAnim, transform: [{ translateY: slideAnim }] }]}>
      <Ionicons name="person-circle-outline" size={18} color={iconColor} style={styles.icon} />

      {/* <View style={styles.textBlock}>
        <Text style={[styles.mainText, { color: textColor }]} numberOfLines={1}>
          {peerName ? `${peerName} is on TalksTry` : 'This contact is on TalksTry'}
        </Text>
        <Text style={[styles.subText, { color: subColor }]}>
          {saveError && saveError !== 'permission_denied'
            ? saveError
            : 'Not saved in your phone contacts'}
        </Text>
      </View> */}

      <TouchableOpacity
        onPress={handleSave}
        disabled={isSaving || isSyncing}
        style={[styles.saveBtn, { backgroundColor: iconColor + (isSaving || isSyncing ? '80' : 'FF') }]}
        activeOpacity={0.75}
      >
        {isSaving || isSyncing ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text style={styles.saveBtnText}>
            {saveError === 'permission_denied' ? 'Allow' : 'Save'}
          </Text>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 10,
    marginTop: 8,
    marginBottom: 4,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  icon: {
    marginRight: 8,
    flexShrink: 0,
  },
  textBlock: {
    flex: 1,
    marginRight: 10,
  },
  mainText: {
    fontSize: 13,
    fontFamily: 'Roboto-Medium',
    lineHeight: 18,
  },
  subText: {
    fontSize: 11,
    fontFamily: 'Roboto-Regular',
    marginTop: 1,
  },
  saveBtn: {
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
    minWidth: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnText: {
    color: '#fff',
    fontSize: 13,
    fontFamily: 'Roboto-SemiBold',
  },
  savedText: {
    fontSize: 13,
    fontFamily: 'Roboto-Medium',
  },
});

export default React.memo(SaveContactBanner);
