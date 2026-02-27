import React, { useState, useEffect, useRef } from "react";
import { StyleSheet, View, Text, TouchableOpacity, Animated, Alert, Platform, ToastAndroid, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useTheme } from "../contexts/ThemeContext";
import { OtpInput } from "react-native-otp-entry";
import { useDeviceInfo } from "../contexts/DeviceInfoContext";
import { useDispatch, useSelector } from "react-redux";
import { otpVerify, resendOtp } from "../Redux/Reducer/Auth/Auth.reducer";
import { initSocket, getSocket } from "../Redux/Services/Socket/socket";
import { MaterialCommunityIcons } from '@expo/vector-icons';

function showToast(message) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    Alert.alert('', message);
  }
}

export default function Otp({ navigation, route }) {
    const deviceInfo = useDeviceInfo();
    const { selectedCountry, phoneNumber, location, address } = route.params;
    const dispatch = useDispatch();
    const { isLoading, otpMessage, error } = useSelector((state) => state.authentication);
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const { theme, isDarkMode, toggleTheme } = useTheme();
    const [otp, setOtp] = useState("");
    const [seconds, setSeconds] = useState(60);
    const [isActive, setIsActive] = useState(true);

    useEffect(() => {
      if (!isActive) return;
      const timer = setInterval(() => {
        setSeconds((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            setIsActive(false);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    }, [isActive]);
  
      const formatTime = (secs) => {
        const minutes = Math.floor(secs / 60);
        const remainingSeconds = secs % 60;
        return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
      };

        useEffect(() => {
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

        const startOtpTimer = (duration = 60) => {
          if (!duration || duration <= 0) return;
          setSeconds(duration);
          setIsActive(true);
        };
        
        const handleVerifyOtp = async () => {
          if (otp.length !== 6) {
            showToast("Enter Valid OTP");
            return;
          }
        
          const payload = {
            mobileCode: selectedCountry.code,
            userName: phoneNumber,
            otp: otp,
            device: {
              deviceName: deviceInfo.brand,
              deviceType: deviceInfo.deviceType,
              os: deviceInfo.osName,
              appVersion: deviceInfo.appVersion,
              fcmToken: 'test fcmtoken',
              "location": {
              "lat": location.coords.latitude,
              "lng": location.coords.longitude,
              "street": address[0].street,
              "city": address[0].city,
              "state": address[0].state,
              "country": address[0].country,
              "zipCode": address[0].postalCode,
              "timezone": address[0].timezone
             }
            },
          };
        
          try {
            const loginData = await dispatch(otpVerify(payload)).unwrap();
        
            // console.log("OTP Verified with login data:", loginData);
            await AsyncStorage.setItem("userInfo", JSON.stringify(loginData.data));
            await AsyncStorage.setItem("accessToken", loginData.token.accessToken );
            await AsyncStorage.setItem("refreshToken",loginData.token.refreshToken);
            await AsyncStorage.setItem("deviceId", loginData.data.deviceId);
            showToast(loginData.message);
            if (deviceInfo) {
              initSocket(deviceInfo);  // Pass both deviceInfo and deviceId
            }
            if (loginData?.data?.isNewUser) {
              navigation.reset({
                index: 0,
                routes: [{ name: "EditProfile", params:{ selectedCountry, phoneNumber }}],
              });
              // navigation.navigate("Profile");
            } else {
              navigation.reset({
                index: 0, 
                routes: [{ name: "ChatList" }], 
              });
              // navigation.navigate("ChatList");
            }
            setOtp("");
          } catch (error) {
            console.error("OTP Verification Failed:", error);
            showToast(error);
          }
        };

        const handleResendOtp = () => {
          if (!phoneNumber || !selectedCountry?.code) {
            showToast("Phone number does not exist");
            return;
          }
        
          const fullPhoneNumber = `${selectedCountry.code}${phoneNumber}`;
        
          dispatch(resendOtp({ fullPhoneNumber }))
            .unwrap()
            .then((otpMessage) => {
              startOtpTimer(60);
              console.log("OTP Resend:", otpMessage);
              showToast(otpMessage);
              setOtp("");
            })
            .catch((error) => {
              console.error("OTP Resend Failed:", error);
              showToast(error);
            });
        };
        
  return (
    <Animated.View style={{ flex: 1, opacity: fadeAnim,}}>
         <View style={{ flex: 1, }}>
          <View>
            <Text style={{ textAlign: 'center', fontFamily: 'Poppins-Medium', fontSize: 18, color: theme.colors.themeColor, paddingVertical:10 }} >Verify {selectedCountry?.code} {phoneNumber}</Text>
          </View>
          <View>
            <Text style={{ textAlign: 'center', fontFamily: 'Poppins-Medium', fontSize: 14, color: theme.colors.placeHolderTextColor, }} >Waiting for OTP to be sent {selectedCountry?.code} {phoneNumber}.</Text>
            <Text onPress={() => navigation.navigate('Login')} style={{ textAlign: 'center', fontFamily: 'Poppins-Medium', fontSize: 14, color: theme.colors.themeColor, }} >Wrong number?</Text>
          </View>
          <View style={{ width:'50%', justifyContent:'center', alignItems:'center', alignSelf:'center', marginTop:50,}} >
           <OtpInput
             numberOfDigits={6}
            focusColor={ theme.colors.themeColor }
            autoFocus={false}
            hideStick={false}
            placeholder="------"
            blurOnFilled={true}
            disabled={false}
            type="numeric"
            secureTextEntry={false}
            focusStickBlinkingDuration={500}
            onFocus={() => console.log("Focused")}
            onBlur={() => console.log("Blurred")}
            onTextChange={(text) => setOtp(text)}
            onFilled={(text) => console.log(`OTP is ${text}`)}
            textInputProps={{
              accessibilityLabel: "One-Time Password",
              keyboardType: 'number-pad',
            }}
            textProps={{
              accessibilityRole: "text",
              accessibilityLabel: "OTP digit",
              allowFontScaling: false,
            }}
            theme={{
              containerStyle: {
                width: '100%',        
                flexDirection: 'row',
                justifyContent: 'space-between',
                backgroundColor: 'transparent',
                gap:0
              },
              pinCodeContainerStyle: {
                backgroundColor: 'transparent',
                borderWidth: 0,  
                borderBottomWidth: 2,
                borderBottomColor: theme.colors.themeColor,
                borderRadius: 0,
                height: 40,
                width: 210 / 6 - 0,
                justifyContent: 'center',
                alignItems: 'center',
              },
              pinCodeTextStyle: {
                color: theme.colors.primaryTextColor,
                fontSize: 15,
              },
              focusStickStyle: {
                backgroundColor: theme.colors.themeColor,
                width: 2,
                height: 22,
                borderRadius: 1,
              },
              focusedPinCodeContainerStyle: {
                borderBottomColor: theme.colors.themeColor,
              },
              placeholderTextStyle: {
                color: theme.colors.placeHolderTextColor,
                fontSize: 30,
              },
              filledPinCodeContainerStyle: {
                borderColor: theme.colors.themeColor,
              },
              disabledPinCodeContainerStyle: {
                backgroundColor: theme.colors.borderColor,
              },
             }}
           />
          </View>
          <Text style={{ textAlign: 'center', fontFamily: 'Poppins-Medium', fontSize: 14, color: theme.colors.placeHolderTextColor, marginVertical:10 }} >Enter OTP</Text>
          <View style={{ width:'100%', flexDirection:'row', borderBottomWidth:1, borderColor: theme.colors.borderColor, paddingHorizontal:10 }} >
             <View style={{ width:40, height:40, justifyContent:'center', alignItems:'flex-start', }} >
               <MaterialCommunityIcons name="message-processing" size={24} color={theme.colors.placeHolderTextColor} />
             </View>
             <TouchableOpacity onPress={() => {
                  if (seconds <= 0) { handleResendOtp();}}} disabled={seconds > 0} 
                  style={{ flex:1, justifyContent:'center', alignItems:'flex-start',}} >
                <Text style={{ fontFamily: 'Poppins-Medium', fontSize: 14, color: seconds > 0 ? theme.colors.placeHolderTextColor : theme.colors.themeColor, paddingBottom:5 }} >Resend SMS ?</Text>
             </TouchableOpacity>
             <View style={{ flex:1, justifyContent:'center', alignItems:'flex-end',}} >
                <Text style={{ fontFamily: 'Poppins-Medium', fontSize: 14, color: seconds > 0 ? theme.colors.themeColor : theme.colors.placeHolderTextColor, }} >{formatTime(seconds)}</Text>
             </View>
          </View>
          <TouchableOpacity onPress={handleVerifyOtp} disabled={seconds <= 0} style={{ width:'50%', height:40, backgroundColor:seconds > 0 ? theme.colors.themeColor : theme.colors.placeHolderTextColor, justifyContent:'center', alignItems:'center', alignSelf:'center', marginTop:20, borderRadius:5, position:'absolute', bottom:40 }} >
            {
              isLoading ? <ActivityIndicator size="small" color={theme.colors.textWhite} /> :
              <Text style={{ fontFamily: 'Poppins-Medium', fontSize: 16, color: theme.colors.textWhite, }} >Verify OTP</Text>
            }
          </TouchableOpacity>
        </View>
    </Animated.View>
  );
}

 