import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, Animated, Dimensions, AppState, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../contexts/ThemeContext';
import { APP_TAG_NAME } from '@env';
import { initSocket, getSocket, isSocketConnected, reconnectSocket } from '../Redux/Services/Socket/socket';
import { useDeviceInfo } from '../contexts/DeviceInfoContext';
import { bootstrapSession, getStoredSession } from '../services/sessionManager';
import ChatDatabase from '../services/ChatDatabase';
import { shouldShowPermissionIntro } from '../features/permissions';

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
 
    // Single exit point from Splash.
    //
    // Every destination Splash can resolve (ChatList, SyncScreen, UserAgree) passes
    // through here so the one-time permission introduction can be inserted directly
    // after the splash, exactly once, without duplicating the reset logic. When the
    // intro is not needed — returning user, or everything already granted — this is a
    // straight reset to the original target and the flow is byte-for-byte what it was
    // before. The gate itself fails safe (skips) on any error.
    const goTo = async (target) => {
        let showPermissions = false;
        try {
            showPermissions = await shouldShowPermissionIntro();
        } catch (err) {
            console.warn('⚠️ Permission gate check failed:', err?.message);
        }

        const route = showPermissions
            ? { name: 'Permissions', params: { nextRoute: target } }
            : target;

        navigation.reset({ index: 0, routes: [route] });
    };

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
                    console.log('✅ User logged in');

                    // Initialize socket if not already connected
                    if (!isSocketConnected() && deviceInfo) {
                        console.log('🔌 Initializing socket.....');
                        await initSocket(deviceInfo, navigation);
                    }

                    // Check if initial sync is done — if not, route through SyncScreen
                    const userId = sessionCheck?.session?.userInfo?._id || sessionCheck?.session?.userInfo?.id;
                    let syncDone = false;
                    try {
                        const { Platform } = require('react-native');
                        syncDone = Platform.OS === 'web' ? true : (userId ? await ChatDatabase.isInitialSyncDone(userId) : false);
                    } catch { syncDone = false; }

                    if (syncDone) {
                        // The app-lock overlay (components/AppLockGate) is the
                        // single gate for BOTH the 2-step and deleted-chats
                        // passwords. It arms itself on launch when either is set,
                        // so Splash always lands straight on the chat list.
                        await goTo({ name: 'ChatList' });
                    } else {
                        // First time on this device — sync chats + messages from API
                        await goTo({ name: 'SyncScreen', params: { navigateTarget: 'ChatList' } });
                    }
                } else {
                    console.log('📝 No user found - going to UserAgree');

                    // Navigate to UserAgree with reset
                    await goTo({ name: 'UserAgree' });
                }
                setIsChecking(false);
            }, 500); // Wait for animation to complete
 
        } catch (error) {
            console.error('❌ Auth check failed:', error);
           
            // On error, go to UserAgree
            setTimeout(async () => {
                await goTo({ name: 'UserAgree' });
                setIsChecking(false);
            }, 500);
        }
    };
 
    return (
        <SafeAreaView style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#ffffff'}}>
            <Animated.View style={{ opacity: fadeAnim, alignItems: 'center' }}>
                {/* <LottieView
                    style={{ width: 220, height: 220 }}
                    source={require('../../assets/lottie/Chat.json')}
                    autoPlay
                    loop
                /> */}
                <View style={{ width: 220, height: 220 }}>
                    <Image source={require('../../assets/icon0.png')} resizeMode='contain' style={{ width:'100%', height:"100%" }} />
                </View>
            </Animated.View>
           
            <View style={styles.versionContainer}>
                <Text style={{ fontFamily: 'Roboto-Medium', fontSize: 12, color: theme.colors.primaryTextColor, textAlign: 'center'}}> © 2026 {APP_TAG_NAME}</Text>
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
 