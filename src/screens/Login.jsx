import React, { useEffect, useState, useRef } from 'react';
import { StyleSheet, View, Text, ActivityIndicator, Image, Animated, Pressable, TouchableOpacity, TextInput, Alert, Platform, ToastAndroid, Modal, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../contexts/ThemeContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useContacts } from '../contexts/ContactContext';
import { useDeviceInfo } from '../contexts/DeviceInfoContext';
import CountryCodeSelector from '../components/CountryCodeSelector';
import countryCodes from '../jsonFile/countryCodes.json';
import { useDispatch, useSelector } from "react-redux";
import { generateOtpAction } from '../Redux/Reducer/Auth/Auth.reducer';
import { useDeviceLocation } from '../contexts/DeviceLoc';
import { APP_TAG_NAME } from '@env';
import * as Clipboard from 'expo-clipboard';

function showToast(message) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    Alert.alert('', message);
  }
}

export default function Login({ navigation }) {
  const { theme, isDarkMode, toggleTheme } = useTheme();
  const { askPermissionAndLoadContacts, permissionStatus, contacts } = useContacts();
  const { location, address, errorMsg, requestLocationPermission } = useDeviceLocation();
  const deviceInfo = useDeviceInfo();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const dispatch = useDispatch();
  const { otpData, isLoading, error } = useSelector(state => state.authentication);
  const [selectedCountry, setSelectedCountry] = useState(countryCodes[0]);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [otpAlertVisible, setOtpAlertVisible] = useState(false);
  const [generatedOtp, setGeneratedOtp] = useState('');
  const [shouldNavigate, setShouldNavigate] = useState(false);
  const navigationRef = useRef(false);
  const bannerSlideAnim = useRef(new Animated.Value(-200)).current;
  const bannerOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    requestLocationPermission();
    
    const timer = setTimeout(() => {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }).start();
    }, 400);

    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    // Handle navigation after OTP is generated and alert is dismissed
    if (shouldNavigate && !otpAlertVisible && generatedOtp) {
      performNavigation();
    }
  }, [shouldNavigate, otpAlertVisible, generatedOtp]);

  const handleCountrySelect = (country) => {
    setSelectedCountry(country);
  };

  const handleCopyOtp = async () => {
    await Clipboard.setStringAsync(generatedOtp);
    if (Platform.OS === 'android') {
      ToastAndroid.show('OTP copied to clipboard', ToastAndroid.SHORT);
    }
    handleCloseAlert(true);
  };

  const showBanner = () => {
    setOtpAlertVisible(true);
    bannerSlideAnim.setValue(-200);
    bannerOpacity.setValue(0);
    Animated.parallel([
      Animated.spring(bannerSlideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 60,
        friction: 9,
      }),
      Animated.timing(bannerOpacity, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }),
    ]).start();
  };

  const handleCloseAlert = (shouldNav = false) => {
    Animated.parallel([
      Animated.timing(bannerSlideAnim, {
        toValue: -200,
        duration: 250,
        useNativeDriver: true,
      }),
      Animated.timing(bannerOpacity, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setOtpAlertVisible(false);
      if (shouldNav && generatedOtp) {
        setShouldNavigate(true);
      } else {
        setShouldNavigate(false);
        setGeneratedOtp('');
      }
    });
  };

  const performNavigation = () => {
    navigation.navigate('Otp', {
      selectedCountry,
      phoneNumber,
      location,
      address,
    });
    setPhoneNumber('');
    setGeneratedOtp('');
    setShouldNavigate(false);
    navigationRef.current = false;
  };

  const handleGenerateOtp = async () => {
    if (phoneNumber.trim().length < 10) {
      showToast('Fill correct mobile no.');
      return;
    }
  
    const fullPhoneNumber = `${selectedCountry.code}${phoneNumber}`;
    const result = await dispatch(generateOtpAction(fullPhoneNumber));
    
    if (generateOtpAction.fulfilled.match(result)) {
      console.log("OTP Sent");
      const data = result.payload?.otpData;
      const otp = data?.otp || data?.code || data;
      setGeneratedOtp(otp);
      showBanner();
    } else {
      console.log("Error", result.payload);
      showToast('Failed to generate OTP. Please try again.');
    }
  };

  return (
    <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <Text style={{ textAlign: 'center', fontFamily: 'Roboto-SemiBold', fontSize: 20, color: theme.colors.themeColor, paddingVertical: 10 }}>
          Enter your phone number
        </Text>
        <View style={{ width: '100%', alignItems: 'center', paddingHorizontal: 20 }}>
          <Text style={{ fontFamily: 'Roboto-Medium', fontSize: 14, color: theme.colors.placeHolderTextColor }}>
            {APP_TAG_NAME} need to verify your phone number.
          </Text>
          <Text style={{ fontFamily: 'Roboto-Medium', fontSize: 14, color: theme.colors.themeColor }}>
            Whats my number ?
          </Text>
        </View>
        
        <CountryCodeSelector
          selectedCountry={selectedCountry}
          onCountrySelect={handleCountrySelect}
          showFlag={true}
          showCode={true}
          showName={false}
        />
        
        <View style={{ width: '50%', gap: 10, flexDirection: 'row', justifyContent: 'space-between', alignSelf: 'center', marginVertical: 10 }}>
          <View style={{ width: 50, height: 40, borderBottomWidth: 1.5, borderColor: theme.colors.themeColor, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontFamily: 'Roboto-SemiBold', fontSize: 16, color: theme.colors.placeHolderTextColor }}>
              {selectedCountry?.code}
            </Text>
          </View>
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'flex-start', borderBottomWidth: 1.5, borderColor: theme.colors.themeColor }}>
            <TextInput
              style={{ width: '100%', letterSpacing: 2, fontFamily: 'Roboto-Medium', fontSize: 14, color: theme.colors.placeHolderTextColor, paddingVertical: 0 }}
              placeholder="Number"
              value={phoneNumber}
              onChangeText={setPhoneNumber}
              placeholderTextColor={theme.colors.placeHolderTextColor}
              keyboardType="phone-pad"
              maxLength={10}
            />
          </View>
        </View>

        <TouchableOpacity 
          onPress={handleGenerateOtp} 
          disabled={isLoading} 
          style={{ width: '50%', height: 40, backgroundColor: theme.colors.themeColor, justifyContent: 'center', alignItems: 'center', alignSelf: 'center', marginTop: 20, borderRadius: 5, position: 'absolute', bottom: 40 }}
        >
          {isLoading ? (
            <ActivityIndicator size="small" color={theme.colors.textWhite} />
          ) : (
            <Text style={{ fontFamily: 'Roboto-Medium', fontSize: 16, color: theme.colors.textWhite }}>
              NEXT
            </Text>
          )}
        </TouchableOpacity>

        {/* OTP Notification Banner */}
        <Modal
          visible={otpAlertVisible}
          transparent={true}
          animationType="none"
          onRequestClose={() => {}}
        >
          <View style={styles.bannerOverlay}>
            <Animated.View
              style={[
                styles.bannerContainer,
                {
                  backgroundColor: isDarkMode ? '#1E1E2E' : '#FFFFFF',
                  transform: [{ translateY: bannerSlideAnim }],
                  opacity: bannerOpacity,
                },
              ]}
            >
              {/* Banner Header */}
              <View style={styles.bannerHeader}>
                <View style={styles.bannerAppInfo}>
                  <View style={[styles.bannerIconWrap, { backgroundColor: theme.colors.themeColor }]}>
                    <Ionicons name="chatbubble-ellipses" size={16} color="#fff" />
                  </View>
                  <Text style={[styles.bannerAppName, { color: theme.colors.placeHolderTextColor }]}>
                    {APP_TAG_NAME}
                  </Text>
                  <Text style={[styles.bannerTime, { color: theme.colors.placeHolderTextColor }]}>
                    now
                  </Text>
                </View>
              </View>

              {/* Banner Body */}
              <View style={styles.bannerBody}>
                {/* <Text style={[styles.bannerSender, { color: theme.colors.primaryTextColor }]}>
                  {selectedCountry?.code} {phoneNumber}
                </Text> */}
                <Text style={[styles.bannerMessage, { color: theme.colors.placeHolderTextColor }]}>
                  Your verification code is{' '}
                  <Text style={[styles.bannerOtpCode, { color: theme.colors.themeColor }]}>
                    {generatedOtp}
                  </Text>
                  . Do not share this code with anyone.
                </Text>
              </View>

              {/* Banner Actions */}
              <View style={[styles.bannerActions, { borderTopColor: isDarkMode ? '#333' : '#E8E8E8' }]}>
                <TouchableOpacity
                  style={styles.bannerActionBtn}
                  onPress={handleCopyOtp}
                  activeOpacity={0.7}
                >
                  <Ionicons name="copy-outline" size={18} color={theme.colors.themeColor} />
                  <Text style={[styles.bannerActionText, { color: theme.colors.themeColor }]}>
                    Copy OTP
                  </Text>
                </TouchableOpacity>

                <View style={[styles.bannerDivider, { backgroundColor: isDarkMode ? '#333' : '#E8E8E8' }]} />

                <TouchableOpacity
                  style={styles.bannerActionBtn}
                  onPress={() => {
                    setShouldNavigate(false);
                    setGeneratedOtp('');
                    Animated.parallel([
                      Animated.timing(bannerSlideAnim, {
                        toValue: -200,
                        duration: 250,
                        useNativeDriver: true,
                      }),
                      Animated.timing(bannerOpacity, {
                        toValue: 0,
                        duration: 250,
                        useNativeDriver: true,
                      }),
                    ]).start(() => {
                      setOtpAlertVisible(false);
                    });
                  }}
                  activeOpacity={0.7}
                >
                  <Ionicons name="close-circle-outline" size={18} color={theme.colors.placeHolderTextColor} />
                  <Text style={[styles.bannerActionText, { color: theme.colors.placeHolderTextColor }]}>
                    Dismiss
                  </Text>
                </TouchableOpacity>
              </View>
            </Animated.View>
          </View>
        </Modal>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bannerOverlay: {
    flex: 1,
    justifyContent: 'flex-start',
    paddingTop: Platform.OS === 'ios' ? 50 : 10,
    paddingHorizontal: 10,
  },
  bannerContainer: {
    borderRadius: 16,
    overflow: 'hidden',
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    marginTop:40
  },
  bannerHeader: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 4,
  },
  bannerAppInfo: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  bannerIconWrap: {
    width: 24,
    height: 24,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  bannerAppName: {
    fontFamily: 'Roboto-Medium',
    fontSize: 13,
    marginLeft: 8,
    flex: 1,
  },
  bannerTime: {
    fontFamily: 'Roboto-Medium',
    fontSize: 12,
  },
  bannerBody: {
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  bannerSender: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 15,
    marginBottom: 3,
  },
  bannerMessage: {
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
    lineHeight: 20,
  },
  bannerOtpCode: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 16,
    letterSpacing: 2,
  },
  bannerActions: {
    flexDirection: 'row',
    borderTopWidth: 0.8,
    marginTop: 4,
  },
  bannerActionBtn: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 11,
    gap: 6,
  },
  bannerActionText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
  },
  bannerDivider: {
    width: 0.8,
    alignSelf: 'stretch',
  },
});