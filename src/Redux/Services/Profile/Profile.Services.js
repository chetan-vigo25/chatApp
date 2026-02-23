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
// Chat
export async function profileDetails(id) {
    // console.log("selected profile id",id)
    try {
      const payload = id ? { _id: id } : {}; // ✅ handle both cases
  
      const response = await apiCall("POST","user/auth/view", payload);
  
      if (response?.statusCode === 200) {
        return response;
      } else {
        showToast(response?.message || "Something went wrong");
        return Promise.reject(response?.message);
      }
    } catch (error) {
      console.error("profileDetails error:", error);
      return Promise.reject(error);
    }
  }

export async function updateProfile(payload) {
    // console.log("edit profile data services",payload)
    try {
      const response = await apiCall("POST","user/auth/update", payload);
  
      if (response?.statusCode === 200) {
        return response;
      } else {
        showToast(response?.message || "Something went wrong");
        return Promise.reject(response?.message);
      }
    } catch (error) {
      console.error("profile update error:", error);
      return Promise.reject(error);
    }
  }
export async function updateImage(formData) {
    console.log("update image data services",formData)
    try {
      const response = await apiCallForm("POST","user/profile/picture", formData);
  
      if (response?.statusCode === 200) {
        return response;
      } else {
        showToast(response?.message || "Something went wrong");
        console.error("update image error response:", response);
        console.log("update image error response message????:", response);
        return Promise.reject(response?.message);
      }
    } catch (error) {
      console.error("update Image error:", error);
      return Promise.reject(error);
    }
  }
export async function removeDp() {
    console.log("update image data services",)
    try {
      const response = await apiCallForm("POST","user/profile/picture/remove",);
  
      if (response?.statusCode === 200) {
        return response;
      } else {
        showToast(response?.message || "Something went wrong");
        console.error("update image error response:", response);
        console.log("update image error response message????:", response);
        return Promise.reject(response?.message);
      }
    } catch (error) {
      console.error("update Image error:", error);
      return Promise.reject(error);
    }
  }


export const profileServices = {
    profileDetails,
    updateProfile,
    updateImage,
    removeDp,
};