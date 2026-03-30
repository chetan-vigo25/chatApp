import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
} from 'react-native';
import LottieView from 'lottie-react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';

export default function SuccessScreen({ navigation, route }) {
  const { theme } = useTheme();
  const device = route.params?.device;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 500,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 500,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Animated.View
        style={[
          styles.content,
          { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
        ]}
      >
        {/* Success animation */}
        <View style={styles.animationContainer}>
          <View style={[styles.checkCircle, { backgroundColor: '#25D366' }]}>
            <FontAwesome6 name="check" size={48} color="#fff" />
          </View>
        </View>

        <Text style={[styles.title, { color: theme.colors.primaryTextColor }]}>
          Device Linked
        </Text>

        <Text style={[styles.subtitle, { color: theme.colors.placeHolderTextColor }]}>
          Your web session has been linked successfully. You can now use the app on your browser.
        </Text>

        {/* Device info card */}
        {device && (
          <View style={[styles.deviceCard, { backgroundColor: theme.colors.cardBackground, borderColor: theme.colors.borderColor }]}>
            <View style={styles.deviceRow}>
              <FontAwesome6 name="desktop" size={16} color={theme.colors.themeColor} />
              <Text style={[styles.deviceLabel, { color: theme.colors.placeHolderTextColor }]}>
                Device
              </Text>
              <Text style={[styles.deviceValue, { color: theme.colors.primaryTextColor }]}>
                {device.deviceName}
              </Text>
            </View>
            <View style={[styles.divider, { backgroundColor: theme.colors.borderColor }]} />
            <View style={styles.deviceRow}>
              <FontAwesome6 name="mobile-screen" size={16} color={theme.colors.themeColor} />
              <Text style={[styles.deviceLabel, { color: theme.colors.placeHolderTextColor }]}>
                Platform
              </Text>
              <Text style={[styles.deviceValue, { color: theme.colors.primaryTextColor }]}>
                {device.platform}
              </Text>
            </View>
            <View style={[styles.divider, { backgroundColor: theme.colors.borderColor }]} />
            <View style={styles.deviceRow}>
              <FontAwesome6 name="clock" size={16} color={theme.colors.themeColor} />
              <Text style={[styles.deviceLabel, { color: theme.colors.placeHolderTextColor }]}>
                Linked
              </Text>
              <Text style={[styles.deviceValue, { color: theme.colors.primaryTextColor }]}>
                Just now
              </Text>
            </View>
          </View>
        )}

        {/* Done button */}
        <TouchableOpacity
          onPress={() => navigation.navigate('LinkDevice')}
          style={[styles.doneBtn, { backgroundColor: theme.colors.themeColor }]}
          activeOpacity={0.8}
        >
          <Text style={[styles.doneBtnText, { color: theme.colors.textWhite }]}>
            Done
          </Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 30,
  },
  animationContainer: {
    marginBottom: 30,
  },
  checkCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 24,
    textAlign: 'center',
  },
  subtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 10,
    lineHeight: 20,
  },
  deviceCard: {
    width: '100%',
    marginTop: 30,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  deviceLabel: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    width: 70,
  },
  deviceValue: {
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
    flex: 1,
  },
  divider: {
    height: 1,
    width: '100%',
  },
  doneBtn: {
    width: '100%',
    height: 48,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 40,
  },
  doneBtnText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 16,
  },
});