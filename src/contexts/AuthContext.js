import React, { createContext, useState, useContext, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import {
  initSocket, disconnectSocket, setupAppStateListener,
  emitLogoutCurrentDevice, clearLocalStorageAndDisconnect,
} from '../Redux/Services/Socket/socket';

const AuthContext = createContext({});
export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  const appState = useRef(AppState.currentState);
  const navigationRef = useRef(null);
  // Unsubscribe for setupAppStateListener — torn down on logout and re-registered
  // exactly once (previously discarded → leaked/duplicate listeners reconnecting
  // the socket after logout).
  const appStateCleanupRef = useRef(null);

  const getDeviceInfo = async () => {
    try {
      // This app uses expo-device / expo-application (NOT react-native-device-info,
      // which was never installed — the old `DeviceInfo.*` calls threw
      // "Property 'DeviceInfo' doesn't exist" on every launch + foreground).
      return {
        osName: Device.osName || (Platform.OS === 'ios' ? 'iOS' : 'Android'),
        appVersion: Application.nativeApplicationVersion || '1.0.0',
        brand: Device.brand || Device.manufacturer || 'unknown',
      };
    } catch (error) {
      console.log('Error getting device info:', error);
      return { osName: 'unknown', appVersion: '1.0.0', brand: 'unknown' };
    }
  };

  const checkLoginStatus = async () => {
    try {
      const [userData, userInfo, accessToken, deviceId] = await Promise.all([
        AsyncStorage.getItem('userData'),
        AsyncStorage.getItem('userInfo'),
        AsyncStorage.getItem('accessToken'),
        AsyncStorage.getItem('deviceId'),
      ]);

      const rawUser = userInfo || userData;
      if (rawUser && accessToken && deviceId) {
        const parsedUser = JSON.parse(rawUser);
        setUser(parsedUser);
        setIsAuthenticated(true);

        const deviceInfo = await getDeviceInfo();
        await initSocket(deviceInfo, navigationRef.current);
        if (appStateCleanupRef.current) appStateCleanupRef.current();
        appStateCleanupRef.current = setupAppStateListener(navigationRef.current);
      } else {
        setUser(null);
        setIsAuthenticated(false);
      }
    } catch (error) {
      console.log('Auth restore error:', error);
      setUser(null);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (userData, tokens = {}) => {
    try {
      await AsyncStorage.setItem('userData', JSON.stringify(userData));
      await AsyncStorage.setItem('userInfo', JSON.stringify(userData));
      if (tokens.accessToken) await AsyncStorage.setItem('accessToken', tokens.accessToken);
      if (tokens.refreshToken) await AsyncStorage.setItem('refreshToken', tokens.refreshToken);
      if (tokens.deviceId) await AsyncStorage.setItem('deviceId', tokens.deviceId);

      setUser(userData);
      setIsAuthenticated(true);

      const deviceInfo = await getDeviceInfo();
      await initSocket(deviceInfo, navigationRef.current);

      return true;
    } catch (error) {
      console.log('Login error:', error);
      return false;
    }
  };

  // SINGLE source of truth for logout — every entry point must funnel here so the
  // teardown is consistent (otherwise isAuthenticated can stay true and call/message
  // listeners keep running → "logged out but still gets calls").
  const logout = async () => {
    try {
      // 1) Notify the server so it deactivates this device's push/voip token + session.
      try { await emitLogoutCurrentDevice(); } catch (_) { /* ignore */ }
      // 2) Stop the app-state listener so it can't reconnect the socket post-logout.
      if (appStateCleanupRef.current) {
        try { appStateCleanupRef.current(); } catch (_) { /* ignore */ }
        appStateCleanupRef.current = null;
      }
      // 3) Clear ALL local storage + disconnect the socket (no token → can't re-auth).
      await clearLocalStorageAndDisconnect();
    } catch (error) {
      console.log('Logout error:', error);
    } finally {
      // 4) ALWAYS clear React auth state so every isAuthenticated-gated subscription
      //    unmounts and the user can never receive call events after logout.
      setUser(null);
      setIsAuthenticated(false);
    }
  };

  useEffect(() => {
    checkLoginStatus();
  }, []);

  // Foreground → quick re-check & socket recovery
  useEffect(() => {
    const subscription = AppState.addEventListener('change', async (nextAppState) => {
      if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
        console.log('App returned to foreground');
        const accessToken = await AsyncStorage.getItem('accessToken');
        if (accessToken) {
          await checkLoginStatus(); // will also re-init socket if needed
        }
      }
      appState.current = nextAppState;
    });

    return () => subscription.remove();
  }, []);

  const setNavigationRef = (ref) => {
    navigationRef.current = ref;
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated,
        login,
        logout,
        checkLoginStatus,
        setNavigationRef,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};