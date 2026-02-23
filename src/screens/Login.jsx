import React, { useEffect, useState, useRef } from 'react';
import { StyleSheet, View, Text, ActivityIndicator, Image, Animated, Pressable, TouchableOpacity, TextInput, Alert, Platform, ToastAndroid } from 'react-native';
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
  const { otpMessage, isLoading, error } = useSelector(state => state.authentication);
  const [selectedCountry, setSelectedCountry] = useState(countryCodes[0]);
  const [phoneNumber, setPhoneNumber] = useState('');

  useEffect(() => {
    requestLocationPermission();
    // askPermissionAndLoadContacts();
    // if (contacts.length > 0) {
    //   // console.log('📞 Contacts:', contacts);
    // }
    // console.log('📱 Device Info:', deviceInfo);
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
      navigation.navigate('Otp', {
        selectedCountry,
        phoneNumber,
        location,
        address,
      });
      setPhoneNumber('');
    } else {
      console.log("Error", result.payload);
    }
  };

  return (
    <Animated.View style={{ flex: 1, opacity: fadeAnim,}}>
      <View style={{ flex: 1, backgroundColor: theme.colors.background, }}>
        <Text style={{ textAlign: 'center', fontFamily: 'Poppins-SemiBold', fontSize: 20, color: theme.colors.themeColor, paddingVertical:10 }} >Enter your phone number</Text>
        <View style={{ width:'100%', alignItems:'center', paddingHorizontal:20 }} >
          <Text style={{ fontFamily: 'Poppins-Medium', fontSize: 14, color: theme.colors.placeHolderTextColor, }} >{APP_TAG_NAME} need to verify your phone number .</Text>
          <Text style={{ fontFamily: 'Poppins-Medium', fontSize: 14, color: theme.colors.themeColor, }} >Whats my number ?</Text>
        </View>
        <CountryCodeSelector
            selectedCountry={selectedCountry}
            onCountrySelect={handleCountrySelect}
            showFlag={true}
            showCode={true}
            showName={false}
          />
        <View style={{ width:'50%', gap:10, flexDirection:'row', justifyContent:'space-between', alignSelf:'center', marginVertical:10, }} >
          <View style={{ width:50, height:40, borderBottomWidth:1.5, borderColor:theme.colors.themeColor, alignItems:'center', justifyContent:'center', }} >
            <Text style={{ fontFamily: 'Poppins-SemiBold', fontSize: 16, color: theme.colors.placeHolderTextColor, }} >{selectedCountry?.code}</Text>
          </View>
          <View style={{ flex:1, justifyContent:'center', alignItems:'flex-start', borderBottomWidth:1.5, borderColor:theme.colors.themeColor, }} >
            <TextInput
              style={{ letterSpacing:2, fontFamily: 'Poppins-SemiBold', fontSize: 14, color: theme.colors.placeHolderTextColor, paddingVertical:0, }}
              placeholder="Phone Number"
              value={phoneNumber}
              onChangeText={setPhoneNumber}
              placeholderTextColor={theme.colors.placeHolderTextColor}
              keyboardType="phone-pad"
              maxLength={10}
            />
          </View>
        </View>
        {/* <TouchableOpacity onPress={() =>navigation.navigate('Otp', {selectedCountry: selectedCountry, phoneNumber: phoneNumber,})} style={{ width:'50%', height:40, backgroundColor:theme.colors.themeColor, justifyContent:'center', alignItems:'center', alignSelf:'center', marginTop:20, borderRadius:5, position:'absolute', bottom:40 }} >
          <Text style={{ fontFamily: 'Poppins-Medium', fontSize: 16, color: theme.colors.textWhite, }} >NEXT</Text>
        </TouchableOpacity> */}
        <TouchableOpacity onPress={handleGenerateOtp} disabled={isLoading} style={{ width:'50%', height:40, backgroundColor:theme.colors.themeColor, justifyContent:'center', alignItems:'center', alignSelf:'center', marginTop:20, borderRadius:5, position:'absolute', bottom:40 }} >
          {
            isLoading ? (
              <ActivityIndicator size="small" color={theme.colors.textWhite} />
            ):(
              <Text style={{ fontFamily: 'Poppins-Medium', fontSize: 16, color: theme.colors.textWhite, }} >NEXT</Text>
            )
          }
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}
