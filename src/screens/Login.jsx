import React, { useEffect, useState, useRef } from 'react';
import { StyleSheet, View, Text, ActivityIndicator, Animated, TouchableOpacity, TextInput, Alert, Platform, ToastAndroid } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { useContacts } from '../contexts/ContactContext';
import { useDeviceInfo } from '../contexts/DeviceInfoContext';
import CountryCodeSelector from '../components/CountryCodeSelector';
import countryCodes from '../jsonFile/countryCodes.json';
import { useDispatch, useSelector } from "react-redux";
import { generateOtpAction } from '../Redux/Reducer/Auth/Auth.reducer';
import { useDeviceLocation } from '../contexts/DeviceLoc';
import { APP_TAG_NAME } from '@env';

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

  const handleCountrySelect = (country) => {
    setSelectedCountry(country);
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
      // Navigate directly to OTP screen, pass the generated OTP for banner display there
      navigation.navigate('Otp', {
        selectedCountry,
        phoneNumber,
        location,
        address,
        generatedOtp: otp,
      });
      setPhoneNumber('');
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

      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({});