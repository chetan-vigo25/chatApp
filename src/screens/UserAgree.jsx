import React, { useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  Image,
  Animated,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

import { APP_TAG_NAME } from '@env';

import { useContacts } from '../contexts/ContactContext';

export default function UserAgree({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const [isAgreed, setIsAgreed] = useState(false);

  const { askPermissionAndLoadContacts } = useContacts();

  useEffect(() => {
    const timer = setTimeout(() => {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }).start();
    }, 800);

    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    askPermissionAndLoadContacts();
  }, []);

  const colors = theme.colors;

  return (
    <Animated.View style={[styles.root, { opacity: fadeAnim, backgroundColor: colors.background }]}>
      {/* Top section with image */}
      <View style={styles.topSection}>
        <View style={[styles.imageWrapper, { shadowColor: colors.themeColor }]}>
          <Image resizeMode="cover" source={require('../../assets/images/sticker.png')} style={styles.image}/>
        </View>
      </View>

      {/* Bottom card */}
      <View style={[ styles.bottomCard,{ backgroundColor: colors.cardBackground, shadowColor: isDarkMode ? '#000' : '#999', }, ]} >
        <Text style={[styles.welcomeTitle, { color: colors.primaryTextColor }]}>
          Welcome to {APP_TAG_NAME}
        </Text>

        <Text style={[styles.subtitle, { color: colors.placeHolderTextColor }]}>
          Connect with friends and family instantly
        </Text>

        {/* Agreement checkbox */}
        <TouchableOpacity activeOpacity={0.7} onPress={() => setIsAgreed((prev) => !prev)}style={styles.checkboxRow} >
          <View style={[styles.checkbox, { borderColor: isAgreed ? colors.themeColor : colors.borderColor, backgroundColor: isAgreed ? colors.themeColor : 'transparent', }, ]} >
            {isAgreed && <Ionicons name="checkmark" size={16} color="#fff" />}
          </View>
          <Text style={[styles.checkboxLabel, { color: colors.placeHolderTextColor }]}>
            I have read and agree to the{' '}
            <Text onPress={() => navigation.navigate('Privacy')} style={{ color: colors.themeColor, fontFamily: 'Roboto-SemiBold' }} > Privacy Policy </Text>
            {' '}and{' '}
            <Text onPress={() => navigation.navigate('Term')} style={{ color: colors.themeColor, fontFamily: 'Roboto-SemiBold' }} >Terms of Service </Text>
          </Text>
        </TouchableOpacity>

        {/* Login buttons */}
        <View style={styles.buttonGroup}>
          <TouchableOpacity activeOpacity={0.8} disabled={!isAgreed} onPress={() => navigation.navigate('LoginEmail')}
            style={[ styles.button, { backgroundColor: isAgreed ? colors.themeColor : colors.borderColor, }, ]}>
            <Ionicons name="mail-outline" size={20} color={isAgreed ? '#fff' : '#999'} style={styles.buttonIcon}/>
            <Text style={[ styles.buttonText, { color: isAgreed ? colors.textWhite : '#999' },]} >
              Login with Email
            </Text>
          </TouchableOpacity>

          <TouchableOpacity activeOpacity={0.8} disabled={!isAgreed} onPress={() => navigation.navigate('Login')}
            style={[ styles.buttonOutline, { borderColor: isAgreed ? colors.themeColor : colors.borderColor, }, ]} >
            <Ionicons name="call-outline" size={20} color={isAgreed ? colors.themeColor : '#999'} style={styles.buttonIcon} />
            <Text style={[styles.buttonText,
                { color: isAgreed ? colors.themeColor : '#999' } ]} >
              Login with Number
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  topSection: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageWrapper: {
    width: 250,
    height: 250,
    borderRadius: 110,
    // elevation: 8,
    // shadowOffset: { width: 0, height: 4 },
    // shadowOpacity: 0.25,
    // shadowRadius: 12,
  },
  image: {
    width: '100%',
    height: '100%',
    borderRadius: 110,
  },
  bottomCard: {
    paddingHorizontal: 24,
    paddingTop: 32,
    paddingBottom: 40,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    // elevation: 12,
    // shadowOffset: { width: 0, height: -4 },
    // shadowOpacity: 0.1,
    // shadowRadius: 16,
  },
  welcomeTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 24,
    textAlign: 'center',
  },
  subtitle: {
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 28,
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 28,
    paddingHorizontal: 4,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    marginTop: 1,
  },
  checkboxLabel: {
    flex: 1,
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
    lineHeight: 21,
  },
  buttonGroup: {
    gap: 12,
  },
  button: {
    height: 50,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonOutline: {
    height: 50,
    borderRadius: 12,
    borderWidth: 1.5,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  buttonIcon: {
    marginRight: 8,
  },
  buttonText: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 15,
  },
});
