// src/contexts/AuthContext.js
import React, { createContext, useState, useContext, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { getSocket, isSocketConnected } from '../Redux/Services/Socket/socket';

const AuthContext = createContext({});

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshTime, setLastRefreshTime] = useState(0);
  const appState = useRef(AppState.currentState);
  const refreshTimeoutRef = useRef(null);
  const refreshAttemptsRef = useRef(0);
  const MAX_REFRESH_ATTEMPTS = 3;
  const REFRESH_COOLDOWN = 60000; // 1 minute cooldown between refresh attempts

  useEffect(() => {
    checkLoginStatus();

    // Handle app state changes
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
        console.log('📱 Auth: App came to foreground, checking login status');
        checkLoginStatus();
        
        // Also check token validity when app comes to foreground
        if (isAuthenticated) {
          verifyAuthentication();
        }
      }
      appState.current = nextAppState;
    });

    return () => {
      subscription.remove();
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
      }
    };
  }, [isAuthenticated]);

  // Function to check if token is expired (local check)
  const isTokenExpired = (token) => {
    try {
      if (!token) return true;
      
      // JWT tokens are in format: header.payload.signature
      const parts = token.split('.');
      if (parts.length !== 3) return true;
      
      const payload = JSON.parse(atob(parts[1]));
      const exp = payload.exp * 1000; // Convert to milliseconds
      
      return Date.now() >= exp;
    } catch (error) {
      console.log('❌ Error checking token expiration:', error);
      return true;
    }
  };

  // Function to refresh access token via socket
  const refreshAccessToken = async () => {
    // Check cooldown
    const now = Date.now();
    if (now - lastRefreshTime < REFRESH_COOLDOWN) {
      console.log('⏳ Refresh cooldown active, skipping');
      return false;
    }

    if (refreshAttemptsRef.current >= MAX_REFRESH_ATTEMPTS) {
      console.log('❌ Max refresh attempts reached, logging out');
      await logout();
      return false;
    }

    if (isRefreshing) {
      console.log('🔄 Already refreshing token');
      return false;
    }

    setIsRefreshing(true);
    refreshAttemptsRef.current += 1;

    try {
      const refreshToken = await AsyncStorage.getItem('refreshToken');
      const deviceId = await AsyncStorage.getItem('deviceId');
      const userData = await AsyncStorage.getItem('userData');

      if (!refreshToken || !deviceId || !userData) {
        console.log('❌ Missing refresh token, device ID, or user data');
        await logout();
        return false;
      }

      console.log('🔄 Attempting to refresh access token...');

      const socket = getSocket();
      if (!socket || !isSocketConnected()) {
        console.log('🔌 Socket not connected, cannot refresh token');
        return false;
      }

      return new Promise((resolve) => {
        socket.emit('token:refresh', { 
          refreshToken, 
          deviceId,
          userId: JSON.parse(userData)?._id || JSON.parse(userData)?.userId
        }, async (response) => {
          console.log('🔄 Token refresh response:', response);

          if (response && response.status === true && response.data) {
            // Save new tokens
            const { accessToken, refreshToken: newRefreshToken } = response.data;
            
            if (accessToken) {
              await AsyncStorage.setItem('accessToken', accessToken);
            }
            
            if (newRefreshToken) {
              await AsyncStorage.setItem('refreshToken', newRefreshToken);
            }

            setLastRefreshTime(Date.now());
            refreshAttemptsRef.current = 0;
            console.log('✅ Token refreshed successfully');
            
            // Re-authenticate socket with new token
            if (socket && socket.connected) {
              socket.emit('authenticate', { 
                token: accessToken, 
                deviceId,
                userId: JSON.parse(userData)?._id || JSON.parse(userData)?.userId
              });
            }
            
            resolve(true);
          } else {
            console.log('❌ Token refresh failed:', response?.message);
            
            if (refreshAttemptsRef.current >= MAX_REFRESH_ATTEMPTS) {
              console.log('❌ Max refresh attempts reached, logging out');
              await logout();
            }
            
            resolve(false);
          }
        });
      });
    } catch (error) {
      console.log('❌ Refresh token error:', error);
      
      if (refreshAttemptsRef.current >= MAX_REFRESH_ATTEMPTS) {
        await logout();
      }
      
      return false;
    } finally {
      setIsRefreshing(false);
    }
  };

  // Function to validate token with server
  const validateTokenWithServer = async () => {
    try {
      const socket = getSocket();
      if (!socket || !isSocketConnected()) {
        console.log('🔌 Socket not connected, cannot validate token');
        return false;
      }

      const accessToken = await AsyncStorage.getItem('accessToken');
      if (!accessToken) {
        console.log('❌ No access token found');
        return false;
      }

      return new Promise((resolve) => {
        socket.emit('token:validate', { token: accessToken }, async (response) => {
          console.log('🔐 Token validation response:', response);
          
          if (response && response.status === true) {
            console.log('✅ Token is valid');
            resolve(true);
          } else {
            console.log('❌ Token is invalid or expired, attempting refresh...');
            const refreshed = await refreshAccessToken();
            resolve(refreshed);
          }
        });
      });
    } catch (error) {
      console.log('❌ Token validation error:', error);
      return false;
    }
  };

  // Function to verify full authentication status
  const verifyAuthentication = async () => {
    if (!isAuthenticated) return false;
    
    try {
      const accessToken = await AsyncStorage.getItem('accessToken');
      const refreshToken = await AsyncStorage.getItem('refreshToken');
      const deviceId = await AsyncStorage.getItem('deviceId');
      const userData = await AsyncStorage.getItem('userData');

      // Check if we have all required data
      if (!userData || !deviceId) {
        console.log('❌ Missing user data or device ID');
        await logout();
        return false;
      }

      // If we have no tokens at all, logout
      if (!accessToken && !refreshToken) {
        console.log('❌ No tokens found');
        await logout();
        return false;
      }

      // If we have access token, check if it's expired locally
      if (accessToken) {
        if (isTokenExpired(accessToken)) {
          console.log('⚠️ Access token expired locally');
          
          // If we have refresh token, try to refresh
          if (refreshToken) {
            console.log('🔄 Attempting refresh with refresh token');
            return await refreshAccessToken();
          } else {
            console.log('❌ No refresh token available');
            await logout();
            return false;
          }
        } else {
          // Token not expired locally, validate with server
          console.log('✅ Access token valid locally, verifying with server');
          return await validateTokenWithServer();
        }
      } else if (refreshToken) {
        // No access token but have refresh token
        console.log('🔄 No access token, attempting refresh with refresh token');
        return await refreshAccessToken();
      }

      return false;
    } catch (error) {
      console.log('❌ Authentication verification error:', error);
      return false;
    }
  };

  // Enhanced login function with token refresh capability
  const login = async (userData, tokens = {}) => {
    try {
      console.log('🔐 Logging in user:', userData?.userId || userData?._id);
      
      // Save user data
      await AsyncStorage.setItem('userData', JSON.stringify(userData));
      
      // Save tokens if provided
      if (tokens.accessToken) {
        await AsyncStorage.setItem('accessToken', tokens.accessToken);
      }
      
      if (tokens.refreshToken) {
        await AsyncStorage.setItem('refreshToken', tokens.refreshToken);
      }
      
      if (tokens.deviceId) {
        await AsyncStorage.setItem('deviceId', tokens.deviceId);
      }
      
      setUser(userData);
      setIsAuthenticated(true);
      refreshAttemptsRef.current = 0;
      
      return true;
    } catch (error) {
      console.log('❌ Login error:', error);
      return false;
    }
  };

  // Enhanced logout with cleanup
  const logout = async () => {
    try {
      console.log('🚪 Logging out user');
      
      // Notify server about logout
      const socket = getSocket();
      if (socket && isSocketConnected()) {
        const currentUser = user || JSON.parse(await AsyncStorage.getItem('userData') || 'null');
        socket.emit('logout', { 
          userId: currentUser?._id || currentUser?.userId,
          deviceId: await AsyncStorage.getItem('deviceId')
        });
      }
      
      // Clear all auth data
      await AsyncStorage.multiRemove([
        'userData',
        'accessToken',
        'refreshToken',
        'deviceId',
        'userInfo',
        'sessionId'
      ]);
      
      setUser(null);
      setIsAuthenticated(false);
      refreshAttemptsRef.current = 0;
      setLastRefreshTime(0);
      
    } catch (error) {
      console.log('❌ Logout error:', error);
    }
  };

  // Schedule periodic token refresh
  const scheduleTokenRefresh = useRef(() => {
    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current);
    }

    // Refresh token every 45 minutes (2700000 ms)
    refreshTimeoutRef.current = setTimeout(async () => {
      if (isAuthenticated) {
        console.log('🔄 Scheduled token refresh');
        await refreshAccessToken();
        scheduleTokenRefresh.current();
      }
    }, 45 * 60 * 1000);
  }).current;

  // Start scheduled refresh when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      scheduleTokenRefresh();
    }
    return () => {
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
      }
    };
  }, [isAuthenticated, scheduleTokenRefresh]);

  // Enhanced checkLoginStatus with token validation
  const checkLoginStatus = async () => {
    try {
      console.log('🔍 Checking login status...');
      const [userData, accessToken, refreshToken, deviceId] = await Promise.all([
        AsyncStorage.getItem('userData'),
        AsyncStorage.getItem('accessToken'),
        AsyncStorage.getItem('refreshToken'),
        AsyncStorage.getItem('deviceId')
      ]);

      // Check if we have a valid session (user data and device ID required)
      const hasValidSession = !!(userData && deviceId);
      
      console.log('📊 Login status check:', {
        hasUserData: !!userData,
        hasAccessToken: !!accessToken,
        hasRefreshToken: !!refreshToken,
        hasDeviceId: !!deviceId,
        isValid: hasValidSession
      });

      if (hasValidSession) {
        setUser(JSON.parse(userData));
        setIsAuthenticated(true);
        
        // If we have no access token but have refresh token, try to refresh
        if (!accessToken && refreshToken) {
          console.log('🔄 No access token but refresh token exists, attempting refresh...');
          await refreshAccessToken();
        } else if (accessToken && isTokenExpired(accessToken) && refreshToken) {
          console.log('🔄 Access token expired, attempting refresh...');
          await refreshAccessToken();
        } else if (accessToken && !isTokenExpired(accessToken)) {
          // Token is valid locally, verify with server if socket connected
          const socket = getSocket();
          if (socket && isSocketConnected()) {
            validateTokenWithServer();
          }
        }
        
      } else {
        // Clear any partial data
        if (userData || accessToken || refreshToken || deviceId) {
          console.log('🧹 Clearing partial session data');
          await AsyncStorage.multiRemove([
            'userData',
            'accessToken',
            'refreshToken',
            'deviceId',
            'userInfo',
            'sessionId'
          ]);
        }
        setUser(null);
        setIsAuthenticated(false);
      }
    } catch (error) {
      console.log('❌ Auth check error:', error);
      setUser(null);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthContext.Provider value={{
      user,
      isLoading,
      isAuthenticated,
      isRefreshing,
      login,
      logout,
      checkLoginStatus,
      refreshAccessToken,
      verifyAuthentication,
      validateTokenWithServer
    }}>
      {children}
    </AuthContext.Provider>
  );
};