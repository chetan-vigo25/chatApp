import React from 'react';
import { View, Text } from 'react-native';

export default function Test() {
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Text style={{ fontSize: 24, fontWeight: 'bold', color:'#fff' }} >Test Screen</Text>
    </View>
  );
}
// import { io } from "socket.io-client";
// import AsyncStorage from "@react-native-async-storage/async-storage";
// import { SOCKET_URL } from "@env";

// // Socket and session management object
// let socket;
// let sessionId = '';
// let deviceId = '';

// // Get device info function
// const getDeviceInfo = (deviceData) => ({
//   platform: deviceData.osName,
//   version: deviceData.appVersion,
//   model: deviceData.brand,
// });

// // Simulate token refresh
// const refreshToken = async () => await AsyncStorage.getItem("refreshToken");

// Re-authenticate function
// const reauthenticate = async (navigation) => {
//   console.log("🔑 Re-authenticating...");
//   const newToken = await refreshToken();
//   if (newToken) {
//     // await AsyncStorage.setItem("accessToken", newToken);
//     socket.emit("reauthenticate", { refreshTokenHash: newToken, deviceId: deviceId });
//     console.log("reauthenticate", { refreshTokenHash: newToken, deviceId: deviceId });
    
//     socket.once("reauthenticated", (response) => {
//       console.log("Re-authenticated event received:", response);
//       if (response.status === true) {
//         console.log("✅ Re-authenticated successfully!");
//       } else {
//         console.log("❌ Re-authentication failed:", response.message);
//         handleLogout(navigation);
//       }
//     });
//   } else {
//     console.log("Your session has expired. Please log in again.");
//     handleLogout(navigation);
//   }
// };

// Logout and clear session
// const handleLogout = async (navigation) => {
//   await AsyncStorage.removeItem("accessToken");
//   socket.disconnect();
//   alert("Session expired. Please log in again.");
//   // navigation.navigate("Login");
//   navigation.reset({
//     index: 0,
//     routes: [{ name: "Login" }],
//   });
// };

// Socket Initialization
// export const initSocket = async (deviceInfo, navigation) => {
//   try {
//     const token = await AsyncStorage.getItem("accessToken");
//     deviceId = await AsyncStorage.getItem("deviceId");
//     const deviceData = getDeviceInfo(deviceInfo);

//     socket = io(SOCKET_URL, {
//       transports: ["websocket", "polling"],
//       auth: {
//         token: token || "",
//         deviceId: deviceId,
//         deviceInfo: deviceData,
//       },
//       reconnection: true,
//       reconnectionAttempts: 5,
//       reconnectionDelay: 1000,
//       timeout: 10000,
//     });

//     socket.on("connect", () => {
//       console.log("🚀 Socket connected:", socket.id);
//       socket.emit("authenticate", {
//         token: token || "",
//         deviceId: deviceId,
//         deviceInfo: deviceData,
//       });

//       socket.emit('token:validate', { token: token }, (response) => {
//         console.log("Token validation response: ", response);
//       });
//     });

//     socket.once("authenticated", async (response) => {
//       console.log("Authenticated event received:", response.data);
//       if (response.status === true) {
//         console.log("✅ Authenticated successfully!");
//         sessionId = response.data.sessionId;
//         // await AsyncStorage.setItem("sessionId", sessionId);
//         // console.log("Session ID:", sessionId);
//         emitDeviceEvents();  // Emit device events after authentication
//       } else {
//         console.log("❌ Authentication failed:", response);
//         if (response.message === "Token expired" || response.message === "Invalid token") {
//           // reauthenticate(navigation);
//           socket.once("reauthenticated", (response) => {
//             console.log("Re-authenticated event received:", response);
//             if (response.status === true) {
//               console.log("✅ Re-authenticated successfully!");
//             } else {
//               console.log("❌ Re-authentication failed:", response.message);
//               handleLogout(navigation);
//             }
//           });
//         }
//       }

//     });

//     // Function to emit device-related events
//     const emitDeviceEvents = () => {
//       socket.emit('device:sessions', {}, (response) => {
//         console.log("Device session response: ", response.status);
//       });

//       // socket.emit('device:terminate', { 
//       //   socketId: socket.id, 
//       //   sessionId: sessionId, 
//       //   deviceId: deviceId 
//       // }, (response) => {
//       //   console.log("Device terminate response: ", response.status);
//       // });
//       // console.log('device:terminate;;;;;;', { 
//       //   socketId: socket.id, 
//       //   sessionId: sessionId, 
//       //   deviceId: deviceId 
//       // }, (response) => {
//       //   console.log("Device terminate response: ", response.status);
//       // });
//     };

//     socket.on("token:validation:result", (response) => {
//       console.log("Token validation response: ", response.status);
//       if (response.status === true) {
//         console.log("✅ Token is valid!");
//       } else {
//         console.log("❌ Token is invalid:", response.message);
//       }
//     });
    
//     socket.on("device:sessions:list", (response) => {
//       console.log("device:session response: ", response.status);
//       if (response.status === true) {
//         console.log("✅ fetch device:session");
//       } else {
//         console.log("❌ device:session error:", response.message);
//       }
//     });

//     socket.on("device:terminated", (response) => {
//       console.log("device:terminated response: ", response.status);
//       if (response.status === true) {
//         console.log("✅ fetch device:terminated");
//       } else {
//         console.log("❌ device:terminated error:", response.message);
//       }
//     });

//     // Handle logout events
//     socket.on("logout", (data) => {
//       if (data.logoutAll) {
//         console.log("User logged out from all devices.");
//       } else {
//         console.log("User logged out from this device:", data.deviceId);
//       }
//       handleLogout(navigation);
//     });

//     socket.on("disconnect", async (reason) => {
//       console.log("🔌 Socket disconnected:", reason);
//       if (reason === "io server disconnect") {
//         console.log("Server requested disconnect. Reconnecting...");
//         // reauthenticate(navigation);
//         // const refreshToken = async () => await AsyncStorage.getItem("refreshToken");
//         const newToken = await refreshToken();
//         if (newToken) {
//           socket.emit("reauthenticate", { refreshTokenHash: newToken, deviceId: deviceId });
//           console.log("reauthenticate", { refreshTokenHash: newToken, deviceId: deviceId });
//         }
//       }
//     });

//     socket.on("connect_error", (err) => {
//       console.log("❌ Socket connect_error:", err.message);
      
//     });

//     socket.once("reauthenticated", (response) => {
//       console.log("Re-authenticated event received:", response);
//       if (response.status === true) {
//         console.log("✅ Re-authenticated successfully!");
//       } else {
//         console.log("❌ Re-authentication failed:", response.message);
//         handleLogout(navigation);
//       }
//     });

//     // socket.on("reconnect_failed", () => {
//     //   console.log("❌ Socket reconnect failed");
//     // });
//   } catch (error) {
//     console.error("⚠️ Error initializing socket:", error);
//   }
// };

// // Emit device:terminate after authentication
// export const emitDeviceTerminate = () => {
//   if (socket && socket.connected && sessionId) {
//     socket.emit('device:terminate', { 
//       socketId: socket.id, 
//       sessionId: sessionId, 
//       deviceId: deviceId 
//     }, (response) => {
//       console.log("Device terminate response: ", response.status);
//     });
//   } else {
//     console.log("❌ Cannot emit device:terminate - socket not ready");
//   }
// };

// export const getSocket = () => socket;
// export const getSessionId = () => sessionId;




