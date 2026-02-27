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
    console.error("�� Error getting access token:", error);
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

const saveTokens = async (accessToken, refreshTokenHash) => {
  try {
    await AsyncStorage.setItem("accessToken", accessToken);
    await AsyncStorage.setItem("refreshToken", refreshTokenHash);
    console.log("✅ Tokens saved successfully");
  } catch (error) {
    console.error("❌ Error saving tokens:", error);
  }
};

// ============================================
// 🚪 LOGOUT HANDLER
// ============================================
const handleLogout = async (navigation) => {
  try {
    console.log("🚪 Logging out user...");
    
    // Clear all auth data
    await AsyncStorage.multiRemove([
      "accessToken",
      "refreshToken",
      "userInfo",
      "sessionId"
    ]);
    
    // Disconnect socket
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    
    sessionId = '';
    deviceId = '';
    
    console.log("✅ Logout completed");
    
    // Navigate to login
    if (navigation) {
      navigation.reset({
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
        data: response.data,
        message: response.message
      });
    }
  });
};

// ============================================
// 🔄 RE-AUTHENTICATION LOGIC
// ============================================
const reauthenticateSocket = async (navigation) => {
  if (isAuthenticating) {
    console.log("⏳ Already re-authenticating, skipping...");
    return;
  }

  isAuthenticating = true;
  console.log("🔄 Starting re-authentication process...");

  try {
    const refreshToken = await getRefreshToken();
    const currentDeviceId = await getDeviceId();

    if (!refreshToken || !currentDeviceId) {
      console.error("❌ No refresh token or device ID found");
      await handleLogout(navigation);
      return;
    }

    deviceId = currentDeviceId;

    console.log("🔑 Re-authenticating with refresh token");
    
    // Update socket auth
    socket.auth = { 
      token: refreshToken, 
      deviceId: currentDeviceId 
    };

    // Reconnect socket
    socket.connect();

    // Wait for connection
    socket.once("connect", () => {
      console.log("🚀 Socket reconnected:", socket.id);
      console.log("📤 Emitting reauthenticate event...");
      
      socket.emit("reauthenticate", { 
        refreshTokenHash: refreshToken, 
        deviceId: currentDeviceId 
      });
    });

  } catch (error) {
    console.error("❌ Error during re-authentication:", error);
    await handleLogout(navigation);
  } finally {
    isAuthenticating = false;
  }
};

// ============================================
// 🎯 SOCKET INITIALIZATION
// ============================================
export const initSocket = async (deviceInfo, navigation) => {
  try {
    console.log("🔧 Initializing socket connection...");
    console.log("📍 Socket URL:", SOCKET_URL);

    // Get stored credentials
    const token = await getAccessToken();
    const storedDeviceId = await getDeviceId();
    const deviceData = getDeviceInfo(deviceInfo);

    if (!token || !storedDeviceId) {
      console.error("❌ Missing token or device ID");
      await handleLogout(navigation);
      return;
    }

    deviceId = storedDeviceId;

    console.log("🔐 Auth data:", {
      hasToken: !!token,
      deviceId: storedDeviceId,
      deviceInfo: deviceData
    });

    // Initialize socket
    socket = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
      auth: {
        token: token,
        deviceId: storedDeviceId,
        deviceInfo: deviceData,
      },
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
      autoConnect: true,
    });

    // ============================================
    // 📥 SOCKET EVENT LISTENERS
    // ============================================

    // ✅ Connection established
    socket.on("connect", () => {
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      // console.log("🚀 SOCKET CONNECTED");
      // console.log("   Socket ID:", socket.id);
      // console.log("   Transport:", socket.io.engine.transport.name);
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

      // Emit authentication
      console.log("📤 Emitting authenticate event...");
      socket.emit("authenticate", {
        token: token,
        deviceId: storedDeviceId,
        deviceInfo: deviceData,
      });

      // Validate token
      console.log("📤 Emitting token:validate...");
      socket.emit('token:validate', { token: token }, (response) => {
        console.log("✅ Token validation response:", response);
      });
    });

    // ✅ Authentication successful
    socket.once("authenticated", (response) => {
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      // console.log("📥 AUTHENTICATED EVENT RECEIVED");
      // console.log("   Status:", response.status);
      // console.log("   Message:", response.message);
      // console.log("   Data:", JSON.stringify(response.data, null, 2));
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

      if (response.status === true) {
        console.log("✅ Authentication successful!");
        sessionId = response.data?.sessionId || '';
        console.log("   Session ID:", sessionId);
        
        // Emit device events after successful auth
        emitDeviceEvents();
      } else {
        console.log("❌ Authentication failed:", response.message);
        
        if (response.message === "Token expired" || response.message === "Invalid token") {
          console.log("🔄 Token issue detected, re-authenticating...");
          reauthenticateSocket(navigation);
        }
      }
    });

    // ✅ Re-authentication successful
    socket.once("reauthenticated", async (response) => {
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      // console.log("📥 RE-AUTHENTICATED EVENT RECEIVED");
      // console.log("   Status:", response.status);
      // console.log("   Message:", response.message);
      // console.log("   Data:", JSON.stringify(response.data, null, 2));
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

      if (response.status === true) {
        console.log("✅ Re-authentication successful!");
        
        // Save new tokens
        if (response.data?.accessToken && response.data?.refreshTokenHash) {
          await saveTokens(response.data.accessToken, response.data.refreshTokenHash);
          sessionId = response.data?.sessionId || sessionId;
          console.log("   New Session ID:", sessionId);
        }
        
        // Emit device events
        emitDeviceEvents();
      } else {
        console.log("❌ Re-authentication failed:", response.message);
        await handleLogout(navigation);
      }
    });

    // 🔌 Socket disconnected
    socket.on("disconnect", async (reason) => {
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      // console.log("🔌 SOCKET DISCONNECTED");
      // console.log("   Reason:", reason);
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

      if (reason === "io server disconnect") {
        console.log("🔄 Server requested disconnect. Re-authenticating...");
        await reauthenticateSocket(navigation);
      } else if (reason === "transport close" || reason === "ping timeout") {
        console.log("⏳ Connection lost. Will auto-reconnect...");
      }
    });

    // ❌ Connection error
    socket.on("connect_error", (err) => {
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      // console.log("❌ SOCKET CONNECTION ERROR");
      // console.log("   Message:", err.message);
      // console.log("   Description:", err.description);
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    });

    // 🔄 Reconnection attempt
    socket.on("reconnect_attempt", (attemptNumber) => {
      console.log(`🔄 Reconnection attempt #${attemptNumber}...`);
    });

    // ✅ Reconnection successful
    socket.on("reconnect", (attemptNumber) => {
      console.log(`✅ Reconnected successfully after ${attemptNumber} attempts`);
    });

    // ❌ Reconnection failed
    socket.on("reconnect_failed", () => {
      console.log("❌ Reconnection failed after all attempts");
    });

    // 📨 Token validation result
    socket.on("token:validation:result", (response) => {
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      // console.log("📥 TOKEN VALIDATION RESULT");
      // console.log("   Status:", response.status);
      // console.log("   Message:", response.message);
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    });

    // 📱 Device sessions list
    socket.on("device:sessions:list", (response) => {
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      // console.log("📥 DEVICE SESSIONS LIST");
      // console.log("   Status:", response.status);
      // console.log("   Data:", JSON.stringify(response.data, null, 2));
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    });

    // 🚫 Device terminated
    socket.on("device:terminated", (response) => {
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      // console.log("📥 DEVICE TERMINATED");
      // console.log("   Status:", response.status);
      // console.log("   Message:", response.message);
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    });

    // 💬 Quick message acknowledgment
    socket.on('message:quick:ack', (payload, callback) => {
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      // console.log("📥 MESSAGE QUICK ACK");
      // console.log("   Payload:", JSON.stringify(payload, null, 2));
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

      const response = { 
        status: true, 
        message: 'Message received successfully',
        timestamp: new Date().toISOString()
      };

      if (callback && typeof callback === 'function') {
        callback(response);
        console.log("✅ Callback response sent:", response);
      }
    });

    // 🚪 Logout event
    socket.on("logout", (data) => {
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      // console.log("📥 LOGOUT EVENT RECEIVED");
      // console.log("   Data:", JSON.stringify(data, null, 2));
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      handleLogout(navigation);
    });

    console.log("✅ Socket initialization completed");

  } catch (error) {
    // console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    // console.error("❌ ERROR INITIALIZING SOCKET");
    // console.error("   Error:", error.message);
    // console.error("   Stack:", error.stack);
    // console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  }
};

// ============================================
// 📱 APP STATE CHANGE HANDLER
// ============================================
export const setupAppStateListener = (navigation) => {
  const handleAppStateChange = async (nextAppState) => {
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    // console.log("📱 APP STATE CHANGED");
    // console.log("   From:", appState);
    // console.log("   To:", nextAppState);
    // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // App came to foreground from background
    if (appState.match(/inactive|background/) && nextAppState === 'active') {
      console.log("✅ App returned to foreground");
      
      // Check if socket is connected
      if (socket && !socket.connected) {
        console.log("🔄 Socket disconnected, re-authenticating...");
        await reauthenticateSocket(navigation);
      } else if (socket && socket.connected) {
        console.log("✅ Socket already connected");
        
        // Validate token
        const token = await getAccessToken();
        if (token) {
          socket.emit('token:validate', { token }, (response) => {
            console.log("✅ Token re-validated on foreground:", response);
            
            if (!response.status) {
              console.log("❌ Token invalid, re-authenticating...");
              reauthenticateSocket(navigation);
            }
          });
        }
      }
    }

    // App went to background
    if (appState === 'active' && nextAppState.match(/inactive|background/)) {
      console.log("⏸️ App moved to background");
    }

    appState = nextAppState;
  };

  const subscription = AppState.addEventListener('change', handleAppStateChange);
  
  return () => {
    subscription.remove();
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

  // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  // console.log("📤 EMITTING DEVICE TERMINATE");
  // console.log("   Socket ID:", socket.id);
  // console.log("   Session ID:", targetSessionId || sessionId);
  // console.log("   Device ID:", deviceId);
  // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  socket.emit('device:terminate', { 
    socketId: socket.id, 
    sessionId: targetSessionId || sessionId, 
    deviceId 
  }, (response) => {
    // console.log("✅ Device terminate response:", {
    //   status: response.status,
    //   message: response.message,
    //   data: response.data
    // });
  });
};

// ============================================
// 🔧 UTILITY FUNCTIONS
// ============================================
export const getSocket = () => {
  if (!socket) {
    console.warn("⚠️ Socket not initialized");
  }
  return socket;
};

export const getSessionId = () => {
  if (!sessionId) {
    console.warn("⚠️ No session ID available");
  }
  return sessionId;
};

export const isSocketConnected = () => {
  return socket && socket.connected;
};

export const disconnectSocket = () => {
  if (socket) {
    console.log("🔌 Manually disconnecting socket...");
    socket.disconnect();
    socket = null;
    sessionId = '';
    console.log("✅ Socket disconnected");
  }
};

export const reconnectSocket = async (navigation) => {
  console.log("🔄 Manual reconnection requested...");
  await reauthenticateSocket(navigation);
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
};