import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, Animated, Dimensions, AppState } from 'react-native';
import LottieView from 'lottie-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../contexts/ThemeContext';
import { APP_TAG_NAME } from '@env';
import { initSocket, getSocket, isSocketConnected, reconnectSocket } from '../Redux/Services/Socket/socket';
import { useDeviceInfo } from '../contexts/DeviceInfoContext';
import { bootstrapSession, getStoredSession } from '../services/sessionManager';
 
const { width } = Dimensions.get('window');
 
export default function Splash({ navigation }) {
    const { theme } = useTheme();
    const deviceInfo = useDeviceInfo();
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const [isChecking, setIsChecking] = useState(true);
    const appState = useRef(AppState.currentState);
 
    // Handle app state changes (background/foreground)
    useEffect(() => {
        const subscription = AppState.addEventListener('change', handleAppStateChange);
        return () => subscription.remove();
    }, []);
 
    const handleAppStateChange = async (nextAppState) => {
        if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
            console.log('📱 App came to foreground - checking socket');
           
            const session = await getStoredSession();
           
            if (session?.userInfo && session?.accessToken) {
                // Check socket connection
                if (!isSocketConnected()) {
                    console.log('🔄 Reconnecting socket...');
                    await reconnectSocket(navigation);
                } else {
                    console.log('✅ Socket already connected');
                    // Validate token
                    const socket = getSocket();
                    if (socket) {
                        socket.emit('token:validate', { token: session.accessToken });
                    }
                }
            }
        }
        appState.current = nextAppState;
    };
 
    useEffect(() => {
        checkAuthAndNavigate();
       
        // Fade in animation
        Animated.timing(fadeAnim, {
            toValue: 1,
            duration: 400,
            useNativeDriver: true,
        }).start();
 
        return () => {
            // Cleanup
        };
    }, []);
 
    const checkAuthAndNavigate = async () => {
        try {
            console.log('🔐 Checking authentication status...');

            const sessionCheck = await bootstrapSession();
            const isLoggedIn = !!sessionCheck?.authenticated;
           
            console.log('📊 Auth status:', {
                isLoggedIn,
                refreshed: !!sessionCheck?.refreshed,
                hasUserInfo: !!sessionCheck?.session?.userInfo,
                hasToken: !!sessionCheck?.session?.accessToken,
                hasDeviceId: !!sessionCheck?.session?.deviceId
            });
 
            // Wait for animation to complete
            setTimeout(async () => {
                if (isLoggedIn) {
                    console.log('✅ User logged in - going to ChatList');
                   
                    // Initialize socket if not already connected
                    if (!isSocketConnected() && deviceInfo) {
                        console.log('🔌 Initializing socket.....');
                        await initSocket(deviceInfo, navigation);
                    }
                   
                    // Navigate to ChatList with reset (clears history)
                    navigation.reset({
                        index: 0,
                        routes: [{ name: 'ChatList' }],
                    });
                } else {
                    console.log('📝 No user found - going to UserAgree');
                   
                    // Navigate to UserAgree with reset
                    navigation.reset({
                        index: 0,
                        routes: [{ name: 'UserAgree' }],
                    });
                }
                setIsChecking(false);
            }, 3500); // Wait for animation to complete
 
        } catch (error) {
            console.error('❌ Auth check failed:', error);
           
            // On error, go to UserAgree
            setTimeout(() => {
                navigation.reset({
                    index: 0,
                    routes: [{ name: 'UserAgree' }],
                });
                setIsChecking(false);
            }, 3500);
        }
    };
 
    return (
        <SafeAreaView style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.colors.background}}>
            <Animated.View style={{ opacity: fadeAnim, alignItems: 'center' }}>
                <LottieView
                    style={{ width: 220, height: 220 }}
                    source={require('../../assets/lottie/Chat.json')}
                    autoPlay
                    loop
                />
            </Animated.View>
           
            <View style={styles.versionContainer}>
                <Text style={{ fontFamily: 'Poppins-Medium', fontSize: 12, color: theme.colors.primaryTextColor, textAlign: 'center'}}> © 2026 {APP_TAG_NAME}</Text>
            </View>
        </SafeAreaView>
    );
}
 
const styles = StyleSheet.create({
    versionContainer: {
        position: 'absolute',
        bottom: 30,
        left: '50%',
        right: '50%',
        transform: [{ translateX: -width * 0.25 }],
        width: width * 0.5,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
 