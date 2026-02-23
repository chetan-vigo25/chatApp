import AsyncStorage from "@react-native-async-storage/async-storage";
import { apiCall, apiCallForm } from '../../../Config/Https';
import { Alert, ToastAndroid, Platform } from "react-native";

function showToast(message) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    Alert.alert('', message);
  }
}

// ============================================
// 📡 CHAT LIST API
// ============================================
export async function chatListData(search) {
  // console.log("selectedDeviceId",deviceId)
    try {
    const response = await apiCall("POST", "user/chat/list", { search: search, isPagination: true } );
      if (response && response.message && typeof response.message === 'string') {
        if (response.statusCode === 200) {
          // console.log("service chat list data",response.data);
          return response;
          // return { otpMessage: response.message };
        } else {
          showToast(response.message)
          return Promise.reject(response.message);
        }
      } else {
        showToast(response.message)
        console.error("Invalid response structure:", response);
        return Promise.reject("Invalid response or missing message");
      }
    } catch (error) {
      console.error("sessions-terminate:", error);
      return Promise.reject(new Error(error.message || "Error user-chat-list api"));
    }
}
export async function sendMessage(payload) {
  // console.log("payload data test",payload)
    try {
    const response = await apiCall("POST", "user/chat/message/send",  payload  );
      if (response && response.message && typeof response.message === 'string') {
        if (response.statusCode === 200) {
          // console.log("payload chat list data",response.data);
          return response;
          // return { otpMessage: response.message };
        } else {
          showToast(response.message)
          return Promise.reject(response.message);
        }
      } else {
        showToast(response.message)
        console.error("Invalid response structure:", response);
        return Promise.reject("Invalid response or missing message");
      }
    } catch (error) {
      console.error("send-message:", error);
      return Promise.reject(new Error(error.message || "Error user/chat/message/send api"));
    }
}

// ============================================
// 💬 CHAT MESSAGE LIST API (with pagination & search)
// ============================================
export async function chatMessageList({ chatId, search = '', page = 1, limit = 50 }) {
  try {
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📡 FETCHING CHAT MESSAGES");
    console.log("   Chat ID:", chatId);
    console.log("   Search:", search);
    console.log("   Page:", page);
    console.log("   Limit:", limit);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // Build query parameters
    const queryParams = new URLSearchParams({
      page: page.toString(),
      limit: limit.toString(),
    });

    // Add search if provided
    if (search && search.trim()) {
      queryParams.append('search', search.trim());
    }

    const payload = {
      chatId: chatId
    };

    const endpoint = `user/chat/message/list?${queryParams.toString()}`;

    console.log("📍 API Endpoint:", endpoint);
    console.log("📦 Payload:", payload);

    const response = await apiCall("POST", endpoint, payload);
    
    if (response && response.message && typeof response.message === 'string') {
      if (response.statusCode === 200) {
        console.log("✅ Chat messages fetched successfully");
        console.log("   Messages count:", response.data?.docs?.length || 0);
        console.log("   Current page:", response.data?.page);
        console.log("   Total pages:", response.data?.totalPages);
        console.log("   Total documents:", response.data?.totalDocs);
        return response;
      } else {
        showToast(response.message);
        return Promise.reject(response.message);
      }
    } else {
      showToast(response.message || "Failed to fetch messages");
      console.error("❌ Invalid response structure:", response);
      return Promise.reject("Invalid response or chat messages");
    }
  } catch (error) {
    console.error("❌ Chat message list error:", error);
    showToast("Failed to fetch chat messages");
    return Promise.reject(new Error(error.message || "Error user/chat/message/list api"));
  }
}

export async function mediaUpload(formData) {
    console.log("user/media/upload services",formData)
    try {
      const response = await apiCallForm("POST","user/media/upload", formData);
  
      if (response?.statusCode === 200) {
        return response;
      } else {
        showToast(response?.message || "Something went wrong");
        console.error("user/media/upload:", response);
        console.log("user/media/upload:", response);
        return Promise.reject(response?.message);
      }
    } catch (error) {
      console.error("user/media/upload error:", error);
      return Promise.reject(error);
    }
  }

export async function downloadMedia(formData) {
    console.log("user/media/downloadMedia services-----",formData)
    try {
      const response = await apiCall("POST","user/media/download", formData);
  
      if (response?.statusCode === 200) {
        return response;
      } else {
        showToast(response?.message || "Something went wrong");
        console.error("user/media/downloadMedia result:", response);
        return Promise.reject(response?.message);
      }
    } catch (error) {
      console.error("user/media/downloadMedia error:", error);
      return Promise.reject(error);
    }
  }

// Export as chatServices object
export const chatServices = {
  chatListData,
  sendMessage,
  chatMessageList,
  mediaUpload,
  downloadMedia,
};

export default chatServices;