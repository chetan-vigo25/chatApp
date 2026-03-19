import React, { useEffect, useState, useRef } from 'react';
import { StyleSheet, View, Text, ActivityIndicator, Image, Animated, Pressable, TouchableOpacity, TextInput, Alert, Platform, ToastAndroid, Modal } from 'react-native';
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
  };

  const handleCloseAlert = () => {
    setOtpAlertVisible(false);
    // Set flag to navigate after alert closes
    if (generatedOtp) {
      setShouldNavigate(true);
    }
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
      setOtpAlertVisible(true); // Show custom modal alert
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

        {/* Custom OTP Alert Modal */}
        <Modal
          visible={otpAlertVisible}
          transparent={true}
          animationType="fade"
          onRequestClose={handleCloseAlert}
        >
          <Pressable 
            style={styles.modalOverlay}
          >
            <Pressable 
              style={[styles.modalContent, { backgroundColor: theme.colors.background }]}
              onPress={(e) => e.stopPropagation()} // Prevent closing when tapping inside
            >
              <Text style={[styles.modalTitle, { color: theme.colors.themeColor }]}>
                Your OTP Code
              </Text>
              
              <Text style={[styles.otpText, { color: theme.colors.primaryTextColor }]}>
                {generatedOtp}
              </Text>

              <View style={styles.modalButtons}>
                <TouchableOpacity
                  style={[styles.modalButton, { backgroundColor: theme.colors.themeColor }]}
                  onPress={() => {
                    handleCopyOtp();
                    handleCloseAlert();
                  }}
                >
                  <Text style={[styles.modalButtonText, { color: theme.colors.textWhite }]}>
                    Copy OTP
                  </Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: '80%',
    borderRadius: 10,
    padding: 20,
    alignItems: 'center',
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
  },
  modalTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 18,
    marginBottom: 15,
  },
  otpText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 24,
    letterSpacing: 3,
    marginBottom: 20,
    padding: 10,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 5,
    width: '100%',
    textAlign: 'center',
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    width: '100%',
    gap: 10,
  },
  modalButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 5,
    alignItems: 'center',
  },
  modalButtonText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
  },
});