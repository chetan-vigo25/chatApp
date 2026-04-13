import React, { useState, useEffect, useRef } from "react";
import { StyleSheet, View, Text, TouchableOpacity, Animated, Alert, Platform, ToastAndroid, ActivityIndicator, Modal } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../contexts/ThemeContext";
import { OtpInput } from "react-native-otp-entry";
import { useDeviceInfo } from "../contexts/DeviceInfoContext";
import { useDispatch, useSelector } from "react-redux";
import { otpVerify, resendOtp } from "../Redux/Reducer/Auth/Auth.reducer";
import { initSocket, getSocket } from "../Redux/Services/Socket/socket";
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { performSessionReset, saveAuthSession } from "../services/sessionManager";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { APP_TAG_NAME } from '@env';
import * as Clipboard from 'expo-clipboard';

function showToast(message) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    Alert.alert('', message);
  }
}

export default function Otp({ navigation, route }) {
    const deviceInfo = useDeviceInfo();
    const { selectedCountry, phoneNumber, location, address, generatedOtp: initialOtp } = route.params;
    const dispatch = useDispatch();
    const { isLoading, otpMessage, otpData, error } = useSelector((state) => state.authentication);
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const otpInputRef = useRef(null);
    const { theme, isDarkMode } = useTheme();
    const [otp, setOtp] = useState("");
    const [seconds, setSeconds] = useState(60);
    const [isActive, setIsActive] = useState(true);
    const [fcmToken, setFcmToken] = useState(null);

    // OTP Banner state
    const [otpBannerVisible, setOtpBannerVisible] = useState(false);
    const [bannerOtp, setBannerOtp] = useState('');
    const bannerSlideAnim = useRef(new Animated.Value(-200)).current;
    const bannerOpacity = useRef(new Animated.Value(0)).current;

    // Show OTP banner when screen opens with a generated OTP
    useEffect(() => {
      if (initialOtp) {
        setBannerOtp(String(initialOtp));
        setOtpBannerVisible(true);
        bannerSlideAnim.setValue(-200);
        bannerOpacity.setValue(0);
        // Small delay so the screen renders first
        setTimeout(() => {
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
        }, 300);
      }
    }, [initialOtp]);

    const dismissBanner = () => {
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
        setOtpBannerVisible(false);
      });
    };

    const handleCopyOtp = async () => {
      await Clipboard.setStringAsync(bannerOtp);
      if (Platform.OS === 'android') {
        ToastAndroid.show('OTP copied to clipboard', ToastAndroid.SHORT);
      }
      dismissBanner();
    };

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
              console.log("Existing user, going to ChatList");
              navigation.reset({
                index: 0,
                routes: [{ name: "ChatList" }],
              });
            }
            otpInputRef.current?.clear();
            setOtp("");
          } catch (error) {
            console.error("OTP Verification Failed:", error);
            showToast(typeof error === 'string' ? error : error?.message || 'Verification failed');
            otpInputRef.current?.clear();
            setOtp("");
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
          <Text style={{ textAlign: 'center', fontFamily: 'Roboto-Medium', fontSize: 14, color: theme.colors.placeHolderTextColor, marginVertical:10 }} >Enter OTP</Text>
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

          {/* OTP Notification Banner */}
          <Modal
            visible={otpBannerVisible}
            transparent={true}
            animationType="none"
            onRequestClose={dismissBanner}
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

                <View style={styles.bannerBody}>
                  <Text style={[styles.bannerMessage, { color: theme.colors.placeHolderTextColor }]}>
                    Your verification code is{' '}
                    <Text style={[styles.bannerOtpCode, { color: theme.colors.themeColor }]}>
                      {bannerOtp}
                    </Text>
                    . Do not share this code with anyone.
                  </Text>
                </View>

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
                    onPress={dismissBanner}
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
    marginTop: 40,
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