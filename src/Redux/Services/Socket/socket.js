import { io } from "socket.io-client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SOCKET_URL } from "@env";
import { AppState } from "react-native";

// ============================================
// 🔧 SOCKET CONFIGURATION & STATE
// ============================================
let socket = null;
let sessionId = '';
let deviceId = '';
let isAuthenticating = false;
let appState = AppState.currentState;
let navigationRef = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let isInitialized = false;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 2000;

// ============================================
// 📱 DEVICE INFO HELPERS
// ============================================
const getDeviceInfo = (deviceData) => ({
  platform: deviceData.osName || 'unknown',
  version: deviceData.appVersion || '1.0.0',
  model: deviceData.brand || 'unknown',
});

// ============================================
// 🔐 TOKEN & STORAGE HELPERS
// ============================================
const getAccessToken = async () => {
  try {
    return await AsyncStorage.getItem("accessToken");
  } catch (error) {
    console.error("❌ Error getting access token:", error);
    return null;
  }
};

const getRefreshToken = async () => {
  try {
    return await AsyncStorage.getItem("refreshToken");
  } catch (error) {
    console.error("❌ Error getting refresh token:", error);
    return null;
  }
};

const getDeviceId = async () => {
  try {
    return await AsyncStorage.getItem("deviceId");
  } catch (error) {
    console.error("❌ Error getting device ID:", error);
    return null;
  }
};

const getUserData = async () => {
  try {
    const userData = await AsyncStorage.getItem("userData");
    return userData ? JSON.parse(userData) : null;
  } catch (error) {
    console.error("❌ Error getting user data:", error);
    return null;
  }
};

const saveTokens = async (accessToken, refreshTokenHash) => {
  try {
    if (accessToken) {
      await AsyncStorage.setItem("accessToken", accessToken);
    }
    if (refreshTokenHash) {
      await AsyncStorage.setItem("refreshToken", refreshTokenHash);
    }
    console.log("✅ Tokens saved successfully");
  } catch (error) {
    console.error("❌ Error saving tokens:", error);
  }
};

// ============================================
// 🚪 LOGOUT HANDLER
// ============================================
const handleLogout = async () => {
  try {
    console.log("🚪 Logging out user...");
    
    // Clear reconnect timer
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    
    // Clear all auth data
    await AsyncStorage.multiRemove([
      "accessToken",
      "refreshToken",
      "userInfo",
      "userData",
      "sessionId"
    ]);
    
    // Disconnect socket
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }
    
    sessionId = '';
    deviceId = '';
    reconnectAttempts = 0;
    isInitialized = false;
    
    console.log("✅ Logout completed");
    
    // Navigate to login
    if (navigationRef) {
      navigationRef.reset({
        index: 0,
        routes: [{ name: "Login" }],
      });
    }
  } catch (error) {
    console.error("❌ Error during logout:", error);
  }
};

// ============================================
// 📡 DEVICE EVENTS EMITTER
// ============================================
const emitDeviceEvents = () => {
  if (!socket || !socket.connected) {
    console.warn("⚠️ Cannot emit device events - socket not connected");
    return;
  }

  console.log("📡 Emitting device:sessions...");
  socket.emit('device:sessions', {}, (response) => {
    if (response) {
      console.log("✅ Device session response:", {
        status: response.status,
        message: response.message
      });
    }
  });
};

// ============================================
// 🔄 RE-AUTHENTICATION LOGIC
// ============================================
const reauthenticateSocket = async (deviceInfo = null) => {
  // Clear any existing reconnect timer
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (isAuthenticating) {
    console.log("⏳ Already re-authenticating, skipping...");
    return;
  }

  isAuthenticating = true;
  console.log("🔄 Starting re-authentication process...");

  try {
    const accessToken = await getAccessToken();
    const refreshToken = await getRefreshToken();
    const currentDeviceId = await getDeviceId();
    const userData = await getUserData();

    console.log("🔑 Re-auth check:", {
      hasAccessToken: !!accessToken,
      hasRefreshToken: !!refreshToken,
      hasDeviceId: !!currentDeviceId,
      hasUserData: !!userData
    });

    // If no valid session, don't proceed
    if (!userData || !currentDeviceId || (!accessToken && !refreshToken)) {
      console.log("ℹ️ No valid session found for re-authentication");
      isAuthenticating = false;
      return;
    }

    deviceId = currentDeviceId;

    // If socket doesn't exist, initialize it first
    if (!socket) {
      console.log("🔧 Socket doesn't exist, initializing before re-authentication");
      
      // Get device info from params or create basic device info
      const deviceData = deviceInfo || {
        osName: Platform.OS,
        appVersion: '1.0.0',
        brand: 'unknown'
      };
      
      // Initialize socket with current tokens
      await initializeSocketWithTokens(deviceData, navigationRef, {
        accessToken,
        refreshToken,
        deviceId: currentDeviceId,
        userData
      });
      
      console.log("✅ Socket initialized for re-authentication");
      isAuthenticating = false;
      return;
    }

    // Use refresh token if available, otherwise use access token
    const tokenToUse = refreshToken || accessToken;
    
    console.log("🔑 Re-authenticating with token");
    
    // Update socket auth
    socket.auth = { 
      token: tokenToUse, 
      deviceId: currentDeviceId,
      userData
    };

    // Reconnect socket if disconnected
    if (!socket.connected) {
      console.log("🔄 Socket disconnected, connecting...");
      socket.connect();
    }

    // Wait for connection or emit directly if already connected
    if (socket.connected) {
      console.log("📤 Socket already connected, emitting reauthenticate...");
      socket.emit("reauthenticate", { 
        refreshTokenHash: refreshToken || accessToken, 
        deviceId: currentDeviceId,
        userId: userData?._id || userData?.userId
      });
    } else {
      // Set up one-time connect listener
      const connectHandler = () => {
        console.log("🚀 Socket reconnected:", socket.id);
        console.log("📤 Emitting reauthenticate event...");
        
        socket.emit("reauthenticate", { 
          refreshTokenHash: refreshToken || accessToken, 
          deviceId: currentDeviceId,
          userId: userData?._id || userData?.userId
        });
        
        socket.off("connect", connectHandler);
      };
      
      socket.once("connect", connectHandler);
    }

  } catch (error) {
    console.error("❌ Error during re-authentication:", error);
  } finally {
    isAuthenticating = false;
  }
};

// Helper function to initialize socket with tokens
const initializeSocketWithTokens = async (deviceInfo, navigation, tokens) => {
  try {
    const deviceData = getDeviceInfo(deviceInfo);
    const tokenToUse = tokens.refreshToken || tokens.accessToken;

    if (!tokenToUse) {
      console.error("❌ No token found for socket initialization");
      return null;
    }

    // Clean up existing socket
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }

    // Initialize new socket
    socket = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
      auth: {
        token: tokenToUse,
        deviceId: tokens.deviceId,
        deviceInfo: deviceData,
        userId: tokens.userData?._id || tokens.userData?.userId
      },
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
      autoConnect: true,
      forceNew: true
    });

    setupSocketListeners(socket, tokenToUse, tokens.deviceId, deviceData, tokens.userData);
    
    return socket;
  } catch (error) {
    console.error("❌ Error initializing socket with tokens:", error);
    return null;
  }
};

// Setup socket listeners
const setupSocketListeners = (socketInstance, token, deviceId, deviceData, userData) => {
  socketInstance.on("connect", () => {
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🚀 SOCKET CONNECTED");
    console.log("   Socket ID:", socketInstance.id);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    socketInstance.emit("authenticate", {
      token: token,
      deviceId: deviceId,
      deviceInfo: deviceData,
      userId: userData?._id || userData?.userId
    });

    socketInstance.emit('token:validate', { token }, (response) => {
      console.log("✅ Token validation response:", response);
    });

    reconnectAttempts = 0;
  });

  socketInstance.once("authenticated", (response) => {
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📥 AUTHENTICATED EVENT RECEIVED");
    console.log("   Status:", response.status);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    if (response.status === true) {
      console.log("✅ Authentication successful!");
      sessionId = response.data?.sessionId || '';
      console.log("   Session ID:", sessionId);
      emitDeviceEvents();
    } else {
      console.log("❌ Authentication failed:", response.message);
      if (response.message === "Token expired" || response.message === "Invalid token") {
        console.log("🔄 Token issue detected, re-authenticating...");
        reauthenticateSocket(deviceData);
      }
    }
  });

  socketInstance.once("reauthenticated", async (response) => {
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📥 RE-AUTHENTICATED EVENT RECEIVED");
    console.log("   Status:", response.status);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    if (response.status === true) {
      console.log("✅ Re-authentication successful!");
      if (response.data?.accessToken && response.data?.refreshTokenHash) {
        await saveTokens(response.data.accessToken, response.data.refreshTokenHash);
        sessionId = response.data?.sessionId || sessionId;
      }
      emitDeviceEvents();
    } else {
      console.log("❌ Re-authentication failed:", response.message);
    }
  });

  socketInstance.on("disconnect", async (reason) => {
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🔌 SOCKET DISCONNECTED");
    console.log("   Reason:", reason);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const userData = await getUserData();
    const deviceId = await getDeviceId();

    if (!userData || !deviceId) {
      console.log("ℹ️ User is logged out, cleaning up");
      handleLogout();
      return;
    }

    if (reason === "io server disconnect") {
      console.log("🔄 Server requested disconnect. Re-authenticating...");
      reauthenticateSocket();
    }
  });

  socketInstance.on("connect_error", (err) => {
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("❌ SOCKET CONNECTION ERROR");
    console.log("   Message:", err.message);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  });

  socketInstance.on("token:validation:result", (response) => {
    console.log("📥 TOKEN VALIDATION RESULT:", response);
    if (!response.status) {
      console.log("🔄 Token invalid, attempting refresh...");
      reauthenticateSocket();
    }
  });

  socketInstance.on("logout", () => {
    console.log("📥 LOGOUT EVENT RECEIVED");
    handleLogout();
  });
};

// ============================================
// 🎯 SOCKET INITIALIZATION
// ============================================
export const initSocket = async (deviceInfo, navigation) => {
  try {
    console.log("🔧 Initializing socket connection...");
    console.log("📍 Socket URL:", SOCKET_URL);

    // Store navigation reference
    navigationRef = navigation;

    // Get stored credentials
    const accessToken = await getAccessToken();
    const refreshToken = await getRefreshToken();
    const storedDeviceId = await getDeviceId();
    const userData = await getUserData();
    const deviceData = getDeviceInfo(deviceInfo);

    // Check if user is logged in
    if (!userData || !storedDeviceId) {
      console.log("ℹ️ User not logged in, skipping socket initialization");
      return;
    }

    // Use refresh token if available, otherwise use access token
    const tokenToUse = refreshToken || accessToken;

    if (!tokenToUse) {
      console.error("❌ No token found for socket initialization");
      return;
    }

    deviceId = storedDeviceId;
    isInitialized = true;

    console.log("🔐 Auth data:", {
      hasToken: !!tokenToUse,
      deviceId: storedDeviceId,
      deviceInfo: deviceData,
      userId: userData?._id || userData?.userId
    });

    // Initialize socket with tokens
    await initializeSocketWithTokens(deviceInfo, navigation, {
      accessToken,
      refreshToken,
      deviceId: storedDeviceId,
      userData
    });

    console.log("✅ Socket initialization completed");

  } catch (error) {
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.error("❌ ERROR INITIALIZING SOCKET");
    console.error("   Error:", error.message);
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  }
};

// ============================================
// 📱 APP STATE CHANGE HANDLER
// ============================================
export const setupAppStateListener = (navigation) => {
  // Store navigation reference
  navigationRef = navigation;

  const handleAppStateChange = async (nextAppState) => {
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📱 APP STATE CHANGED");
    console.log("   From:", appState);
    console.log("   To:", nextAppState);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // App came to foreground from background
    if (appState.match(/inactive|background/) && nextAppState === 'active') {
      console.log("✅ App returned to foreground");
      
      // Check if user is still logged in
      const userData = await getUserData();
      const deviceId = await getDeviceId();
      
      if (!userData || !deviceId) {
        console.log("ℹ️ User not logged in, skipping socket operations");
        return;
      }

      // Check socket connection
      if (socket && !socket.connected) {
        console.log("🔄 Socket disconnected, reconnecting...");
        socket.connect();
      } else if (!socket) {
        console.log("🔧 Socket not initialized, will be initialized by chat");
      }
    }

    appState = nextAppState;
  };

  const subscription = AppState.addEventListener('change', handleAppStateChange);
  
  return () => {
    subscription.remove();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    console.log("🔇 App state listener removed");
  };
};

// ============================================
// 📤 EMIT DEVICE TERMINATE
// ============================================
export const emitDeviceTerminate = (targetSessionId = null) => {
  if (!socket || !socket.connected) {
    console.warn("⚠️ Cannot emit device:terminate - socket not connected");
    return;
  }

  if (!sessionId && !targetSessionId) {
    console.warn("⚠️ Cannot emit device:terminate - no session ID available");
    return;
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📤 EMITTING DEVICE TERMINATE");
  console.log("   Session ID:", targetSessionId || sessionId);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  socket.emit('device:terminate', { 
    socketId: socket.id, 
    sessionId: targetSessionId || sessionId, 
    deviceId 
  }, (response) => {
    console.log("✅ Device terminate response:", {
      status: response?.status,
      message: response?.message
    });
  });
};

// ============================================
// 🔧 UTILITY FUNCTIONS
// ============================================
export const getSocket = () => {
  return socket;
};

export const getSessionId = () => {
  return sessionId;
};

export const isSocketConnected = () => {
  return socket && socket.connected;
};

export const disconnectSocket = () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  if (socket) {
    console.log("🔌 Manually disconnecting socket...");
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
    sessionId = '';
    isInitialized = false;
    console.log("✅ Socket disconnected");
  }
};

export const reconnectSocket = async (deviceInfo = null) => {
  console.log("🔄 Manual reconnection requested...");
  
  // Check if user is logged in
  const userData = await getUserData();
  const deviceId = await getDeviceId();
  
  if (!userData || !deviceId) {
    console.log("ℹ️ User not logged in, skipping reconnection");
    return;
  }
  
  await reauthenticateSocket(deviceInfo);
};

export const setNavigationRef = (navigation) => {
  navigationRef = navigation;
};

export const resetReconnectAttempts = () => {
  reconnectAttempts = 0;
};

export const checkUserLoginStatus = async () => {
  try {
    const [userData, accessToken, deviceId] = await Promise.all([
      AsyncStorage.getItem('userData'),
      AsyncStorage.getItem('accessToken'),
      AsyncStorage.getItem('deviceId')
    ]);
    
    return !!(userData && accessToken && deviceId);
  } catch (error) {
    console.error('❌ Error checking login status:', error);
    return false;
  }
};

export default {
  initSocket,
  setupAppStateListener,
  emitDeviceTerminate,
  getSocket,
  getSessionId,
  isSocketConnected,
  disconnectSocket,
  reconnectSocket,
  setNavigationRef,
  resetReconnectAttempts,
  checkUserLoginStatus
};