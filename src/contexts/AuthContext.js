import React, { createContext, useState, useContext, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import {
  initSocket, disconnectSocket, setupAppStateListener,
  emitLogoutCurrentDevice, clearLocalStorageAndDisconnect,
} from '../Redux/Services/Socket/socket';
import { isAppLockSuspended } from '../services/appLockGuard';
import { clearDirectoryCache } from '../Redux/Services/Contact/Directory.Services';
import { setCurrentUser, setCurrentUserId } from '../services/currentUser';
import { getAccessToken, setAccessToken, setRefreshToken } from '../services/secureTokenStore';
import { subscribeUserChanged } from '../services/sessionEvents';

const AuthContext = createContext({});
export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  const appState = useRef(AppState.currentState);
  // True only once the app has REALLY been to the background since the last
  // foreground. Lets us ignore transient `inactive` blips — a permission /
  // contacts / image-picker prompt fires background→inactive→active without the
  // user leaving the app, and we must NOT treat that as a fresh foreground.
  const wasBackgrounded = useRef(false);
  const navigationRef = useRef(null);
  // Unsubscribe for setupAppStateListener — torn down on logout and re-registered
  // exactly once (previously discarded → leaked/duplicate listeners reconnecting
  // the socket after logout).
  const appStateCleanupRef = useRef(null);
  // Latest auth state for the user-changed subscription below (registered once).
  const userRef = useRef(null);
  const authedRef = useRef(false);
  useEffect(() => { userRef.current = user; }, [user]);
  useEffect(() => { authedRef.current = isAuthenticated; }, [isAuthenticated]);

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
        getAccessToken(),
        AsyncStorage.getItem('deviceId'),
      ]);

      const rawUser = userInfo || userData;
      if (rawUser && accessToken && deviceId) {
        const parsedUser = JSON.parse(rawUser);
        // Publish BEFORE anything else in the session starts ingesting: every
        // "is this message mine?" check reads this store synchronously, and a
        // message that lands while it is still empty renders on the wrong side.
        setCurrentUser(parsedUser);
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
      // Secrets go to the encrypted store. setRefreshToken writes both
      // `refreshToken` and `refreshTokenHash`; the old code here wrote only the
      // former, which left getStoredSession (it prefers the *Hash name) reading
      // a stale value from a previous session after a login through this path.
      if (tokens.accessToken) await setAccessToken(tokens.accessToken);
      if (tokens.refreshToken) await setRefreshToken(tokens.refreshToken);
      if (tokens.deviceId) await AsyncStorage.setItem('deviceId', tokens.deviceId);

      setCurrentUser(userData);
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
      // 3b) Directory search results are privacy-resolved FOR THIS VIEWER (saved
      //     names, numbers hidden from strangers), so they must never survive
      //     into the next account signed in on this device.
      try { clearDirectoryCache(); } catch (_) { /* ignore */ }
    } catch (error) {
      console.log('Logout error:', error);
    } finally {
      // 4) ALWAYS clear React auth state so every isAuthenticated-gated subscription
      //    unmounts and the user can never receive call events after logout.
      setCurrentUserId(null);
      setUser(null);
      setIsAuthenticated(false);
    }
  };

  useEffect(() => {
    checkLoginStatus();
  }, []);

  // A FRESH sign-in (OTP / email) never calls login() above — those screens
  // persist the session through sessionManager.saveAuthSession and navigate on.
  // So isAuthenticated stayed FALSE for the whole first session after logging
  // in, and everything gated on it stayed off. Worst hit: CallProvider never
  // connected its engine to the media server (and its logout-teardown kept it
  // shut down), so the device was UNCALLABLE until the app was restarted —
  // callers got "callee offline on media server" and the call ended. Verified
  // live on both phones: login succeeded, chat worked, AuthContext read
  // isAuthenticated:false / user:null and the engine had no SDK at all.
  //
  // saveAuthSession announces the new user AFTER every token is written, so
  // adopting it here is safe (no tokenless request can race ahead of it).
  // The SAME user is ignored: sessionManager re-announces on every boot and on
  // token refresh, and re-setting `user` would churn every consumer for nothing.
  // A null userId (performSessionReset) is left to logout(), which owns teardown.
  useEffect(() => subscribeUserChanged(({ userId, userInfo } = {}) => {
    if (!userId || !userInfo) return;
    const cur = userRef.current;
    const curId = cur ? String(cur._id || cur.id || '') : '';
    if (authedRef.current && curId === String(userId)) return;
    userRef.current = userInfo;
    authedRef.current = true;
    setCurrentUser(userInfo);
    setUser(userInfo);
    setIsAuthenticated(true);
    setIsLoading(false);
    // Same foreground socket-recovery listener a restored session gets in
    // checkLoginStatus — without it the chat socket isn't re-established on
    // return from background until the next app launch.
    if (!appStateCleanupRef.current) {
      appStateCleanupRef.current = setupAppStateListener(navigationRef.current);
    }
  }), []);

  // Foreground → quick re-check & socket recovery.
  //
  // IMPORTANT: only act on a GENUINE background→active trip. Previously this
  // fired on every `inactive`→`active` too, so opening the contacts permission
  // dialog / picker (which backgrounds the app for a moment) re-ran the full
  // checkLoginStatus() → setUser(new object) + initSocket() on EVERY contact
  // fetch/refresh. That heavy re-init on a trivial excursion is what made the
  // app churn/flash back to the Splash on returning. We now:
  //   • record `wasBackgrounded` only on a real `background` transition,
  //   • ignore the bare `inactive`→`active` round-trip, and
  //   • skip entirely when the app lock is suspended (an intentional in-app
  //     excursion like the contacts/image picker — same guard AppLockGate uses).
  useEffect(() => {
    const subscription = AppState.addEventListener('change', async (nextAppState) => {
      if (nextAppState === 'background') {
        wasBackgrounded.current = true;
        appState.current = nextAppState;
        return;
      }

      if (nextAppState === 'active' && wasBackgrounded.current) {
        wasBackgrounded.current = false;
        appState.current = nextAppState;

        // Intentional in-app excursion (contacts/image/document picker, camera):
        // the return trip is not a real foreground — don't re-init anything.
        if (isAppLockSuspended()) return;

        console.log('App returned to foreground');
        const accessToken = await getAccessToken();
        if (accessToken) {
          await checkLoginStatus(); // will also re-init socket if needed
        }
        return;
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