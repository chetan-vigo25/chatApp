import React, { useState, useEffect, useRef } from "react";
import { View, Text, TouchableOpacity, Animated, Alert, Platform, ToastAndroid, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../contexts/ThemeContext";
import { OtpInput } from "react-native-otp-entry";
import { useDeviceInfo } from "../contexts/DeviceInfoContext";
import { useDispatch, useSelector } from "react-redux";
import { otpVerify, resendOtp } from "../Redux/Reducer/Auth/Auth.reducer";
import { initSocket, getSocket, emitLogoutCurrentDevice } from "../Redux/Services/Socket/socket";
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { performSessionReset, saveAuthSession } from "../services/sessionManager";
import AsyncStorage from "@react-native-async-storage/async-storage";

function showToast(message) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    Alert.alert('', message);
  }
}

export default function Otp({ navigation, route }) {
    const deviceInfo = useDeviceInfo();
    const { selectedCountry, phoneNumber, location, address } = route.params || {};
    const dispatch = useDispatch();
    const { isLoading, otpMessage, otpData, error } = useSelector((state) => state.authentication);
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const otpInputRef = useRef(null);
    const { theme } = useTheme();
    const [otp, setOtp] = useState("");
    const [otpError, setOtpError] = useState("");
    const [seconds, setSeconds] = useState(60);
    const [isActive, setIsActive] = useState(true);
    const [fcmToken, setFcmToken] = useState(null);
    const verifyingRef = useRef(false);

    useEffect(() => {
        const loadToken = async () => {
          try {
            const storedToken = await AsyncStorage.getItem('fcmToken');
            console.log('fcmToken----------:', storedToken);
            setFcmToken(storedToken);
          } catch (error) {
            console.log('Error getting FCM token:', error);
          }
        };
      
        loadToken();
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
        
        const handleVerifyOtp = async (codeArg) => {
          const code = typeof codeArg === 'string' ? codeArg : otp;
          if (code.length !== 6) {
            setOtpError("Enter the 6-digit code");
            return;
          }
          if (verifyingRef.current || isLoading) return;
          verifyingRef.current = true;
          setOtpError("");

          const payload = {
            mobileCode: selectedCountry.code,
            userName: phoneNumber,
            otp: code,
            device: {
              deviceName: deviceInfo.brand,
              deviceType: deviceInfo.deviceType,
              os: deviceInfo.osName,
              appVersion: deviceInfo.appVersion,
              fcmToken: fcmToken || '',
              "location": {
              "lat": location?.coords?.latitude || 0,
              "lng": location?.coords?.longitude || 0,
              "street": address?.[0]?.street || "",
              "city": address?.[0]?.city || "",
              "state": address?.[0]?.state || "",
              "country": address?.[0]?.country || "",
              "zipCode": address?.[0]?.postalCode || "",
              "timezone": address?.[0]?.timezone || ""
             }
            },
          };
        
          try {
            const loginData = await dispatch(otpVerify(payload)).unwrap();

            console.log("OTP Verified successfully, saving session...");
            // M6 — mobile is single-account: force-logout the PREVIOUS account
            // before switching. Best-effort server-side logout (terminates the
            // old device session if its socket is still live) then the local
            // wipe below removes all on-device state for the old account.
            try { await emitLogoutCurrentDevice(); } catch (_) {}
            await performSessionReset({
              reason: 'user_switch_login',
              resetNavigation: false,
              clearAllStorage: true,
            });

            await saveAuthSession({
              userInfo: loginData.data,
              accessToken: loginData?.token?.accessToken,
              refreshToken: loginData?.token?.refreshToken,
              deviceId: loginData?.data?.deviceId,
              loginMethod: 'mobile',
            });
            console.log("Session saved, navigating...");

            showToast(loginData.message);
            try {
              if (deviceInfo) {
                initSocket(deviceInfo, navigation);
              }
            } catch (socketErr) {
              console.warn("Socket init failed (non-fatal):", socketErr.message);
            }

            if (loginData?.data?.isNewUser) {
              console.log("New user, going to EditProfile");
              navigation.reset({
                index: 0,
                routes: [{ name: "EditProfile", params:{ selectedCountry, phoneNumber }}],
              });
            } else {
              // Returning user: route through SyncScreen so their existing chats
              // + messages are restored into the local DB on first login (it
              // self-gates via isInitialSyncDone and exits instantly if there's
              // nothing to sync). Matches the email-login flow.
              console.log("Existing user, going to SyncScreen");
              navigation.reset({
                index: 0,
                routes: [{ name: "SyncScreen", params: { navigateTarget: "ChatList" } }],
              });
            }
            otpInputRef.current?.clear();
            setOtp("");
          } catch (error) {
            console.error("OTP Verification Failed:", error);
            const msg = typeof error === 'string' ? error : error?.message || 'Invalid OTP. Please try again.';
            setOtpError(msg);
            showToast(msg);
            otpInputRef.current?.clear();
            setOtp("");
          } finally {
            verifyingRef.current = false;
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
            .then((payload) => {
              const otpMessage = payload?.otpMessage ?? payload;
              startOtpTimer(60);
              console.log("OTP Resend:", otpMessage);
              showToast(otpMessage);
              otpInputRef.current?.clear();
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
            <Text style={{ textAlign: 'center', fontFamily: 'Roboto-Medium', fontSize: 18, color: theme.colors.themeColor, paddingVertical:10 }} >Verify {selectedCountry?.code} {phoneNumber}</Text>
          </View>
          <View>
            <Text style={{ textAlign: 'center', fontFamily: 'Roboto-Medium', fontSize: 14, color: theme.colors.placeHolderTextColor, }} >Waiting for OTP to be sent {selectedCountry?.code} {phoneNumber}.</Text>
            <Text onPress={() => navigation.navigate('Login')} style={{ textAlign: 'center', fontFamily: 'Roboto-Medium', fontSize: 14, color: theme.colors.themeColor, }} >Wrong number?</Text>
          </View>
          <View style={{ width:'50%', justifyContent:'center', alignItems:'center', alignSelf:'center', marginTop:50,}} >
           <OtpInput
             ref={otpInputRef}
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
            onTextChange={(text) => {
              setOtp(text);
              if (otpError) setOtpError("");
            }}
            onFilled={(text) => handleVerifyOtp(text)}
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
                borderBottomColor: otpError ? '#E5484D' : theme.colors.themeColor,
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
          <Text style={{ textAlign: 'center', fontFamily: 'Roboto-Medium', fontSize: 14, color: otpError ? '#E5484D' : theme.colors.placeHolderTextColor, marginVertical:10 }} >{otpError || 'Enter OTP'}</Text>
          <View style={{ width:'100%', flexDirection:'row', borderBottomWidth:1, borderColor: theme.colors.borderColor, paddingHorizontal:10 }} >
             <View style={{ width:40, height:40, justifyContent:'center', alignItems:'flex-start', }} >
               <MaterialCommunityIcons name="message-processing" size={24} color={theme.colors.placeHolderTextColor} />
             </View>
             <TouchableOpacity onPress={() => {
                  if (seconds <= 0) { handleResendOtp();}}} disabled={seconds > 0} 
                  style={{ flex:1, justifyContent:'center', alignItems:'flex-start',}} >
                <Text style={{ fontFamily: 'Roboto-Medium', fontSize: 14, color: seconds > 0 ? theme.colors.placeHolderTextColor : theme.colors.themeColor, paddingBottom:5 }} >Resend SMS ?</Text>
             </TouchableOpacity>
             <View style={{ flex:1, justifyContent:'center', alignItems:'flex-end',}} >
                <Text style={{ fontFamily: 'Roboto-Medium', fontSize: 14, color: seconds > 0 ? theme.colors.themeColor : theme.colors.placeHolderTextColor, }} >{formatTime(seconds)}</Text>
             </View>
          </View>
          <TouchableOpacity onPress={handleVerifyOtp} disabled={isLoading || otp.length !== 6} style={{ width:'50%', height:45, backgroundColor:(otp.length === 6) ? theme.colors.themeColor : '#f1f1f1', justifyContent:'center', alignItems:'center', alignSelf:'center', marginTop:20, borderRadius:5, position:'absolute', bottom:40,  }} >
            {
              isLoading ? <ActivityIndicator size="small" color={theme.colors.textWhite} /> :
              <Text style={{ fontFamily: 'Roboto-Medium', fontSize: 16, color:(otp.length === 6 && !isLoading)? theme.colors.textWhite : '#999', }} >Verify OTP</Text>
            }
          </TouchableOpacity>
        </View>
    </Animated.View>
  );
}