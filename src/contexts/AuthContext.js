import React, { createContext, useState, useContext, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { initSocket, disconnectSocket, setupAppStateListener } from '../Redux/Services/Socket/socket';

const AuthContext = createContext({});
export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  const appState = useRef(AppState.currentState);
  const navigationRef = useRef(null);

  const getDeviceInfo = async () => {
    try {
      const [osName, appVersion, brand] = await Promise.all([
        DeviceInfo.getSystemName(),
        DeviceInfo.getVersion(),
        DeviceInfo.getBrand(),
      ]);
      return { osName, appVersion, brand };
    } catch (error) {
      console.log('Error getting device info:', error);
      return { osName: 'unknown', appVersion: '1.0.0', brand: 'unknown' };
    }
  };

  const checkLoginStatus = async () => {
    try {
      const [userData, accessToken, deviceId] = await Promise.all([
        AsyncStorage.getItem('userData'),
        AsyncStorage.getItem('accessToken'),
        AsyncStorage.getItem('deviceId'),
      ]);

      if (userData && accessToken && deviceId) {
        const parsedUser = JSON.parse(userData);
        setUser(parsedUser);
        setIsAuthenticated(true);

        const deviceInfo = await getDeviceInfo();
        await initSocket(deviceInfo, navigationRef.current);
        setupAppStateListener(navigationRef.current);
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

  const logout = async () => {
    try {
      await AsyncStorage.multiRemove([
        'userData',
        'accessToken',
        'refreshToken',
        'deviceId',
      ]);

      disconnectSocket();

      setUser(null);
      setIsAuthenticated(false);
    } catch (error) {
      console.log('Logout error:', error);
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