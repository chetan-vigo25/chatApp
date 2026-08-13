import AsyncStorage from "@react-native-async-storage/async-storage";
import { apiCall } from '../../../Config/Https';
import { Alert, ToastAndroid, Platform } from "react-native";


function showToast(message) {
    if (Platform.OS === 'android') {
      ToastAndroid.show(message, ToastAndroid.SHORT);
    } else {
      Alert.alert('', message);
    }
  }
// Login function (existing)
async function generateOtp(phoneNumber) {
    try {
        // Making API call to generate OTP
        const response = await apiCall("POST", "user/auth/send-otp", {
            userName: `${phoneNumber}`,
        });
        if (response && response.message && typeof response.message === 'string') {
            if (response.statusCode === 200) {
                showToast(response.message);
                return { otpMessage: response.message, otpData: response.data };
            } else {
                showToast(response.message)
                console.error("[OTP:SEND] Unexpected response message:", response.message);
                return Promise.reject(response.message);
            }
        } else {
            return Promise.reject("Invalid JSON response or missing message");
        }
    } catch (error) {
        // Surface the most useful fields so we can tell "never sent" (network)
        // from "server rejected" (has status/message).
        console.error("[OTP:SEND] FAILED", {
            code: error?.code,
            status: error?.response?.status,
            url: error?.url || error?.config?.url,
            message: error?.message || error,
        });
        return Promise.reject(error);
    }
}

 export async function verifyOtpService(payload) {
  // console.log("payload",payload)
   try {
     const response = await apiCall("POST", "user/auth/login", payload);
  
     if (response && response.message && typeof response.message === 'string') {
       if (response.statusCode === 200) {
        //  return { otpMessage: response };
        return response;
       } else {
         showToast(response.message);
         return Promise.reject(response.message);
       }
     } else {
       return Promise.reject("Invalid response from server");
     }
   } catch (error) {
     console.error("OTP verification error:", error);
     return Promise.reject(error.message || "Error verifying OTP");
   }
 }

export async function resendOtpService(fullPhoneNumber) {
  
    // console.log("payload resend OTP",fullPhoneNumber)
    try {
    const response = await apiCall("POST", "user/auth/resend-otp", {
        userName: `${fullPhoneNumber}`,
      });
  
      if (response && response.message && typeof response.message === 'string') {
        if (response.statusCode === 200) {
          console.log("new OTP",response.data);
          // return response;
          return { otpMessage: response.message, otpData: response.data };
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
      console.error("Error resending OTP:", error);
      return Promise.reject(new Error(error.message || "Error resending OTP"));
    }
}
export async function activeSession() {
  
    try {
    const response = await apiCall("POST", "user/auth/sessions", );
  
      if (response && response.message && typeof response.message === 'string') {
        if (response.statusCode === 200) {
          // console.log("Active session data",response.data);
          // console.log("Active session data",response.data);
          return response;
        } else {
          // showToast(response.message)
          return Promise.reject(response.message);
        }
      } else {
        showToast(response.message)
        console.error("Invalid response structure:", response);
        return Promise.reject("Invalid response or missing message");
      }
    } catch (error) {
      console.error("Error auth/sessions:", error);
      return Promise.reject(new Error(error.message || "Error auth/sessions api"));
    }
}
export async function deactiveSession(deviceId) {
  // console.log("selectedDeviceId",deviceId)
    try {
    const response = await apiCall("POST", "user/auth/sessions-terminate", { sessionId: deviceId } );
  
      if (response && response.message && typeof response.message === 'string') {
        if (response.statusCode === 200) {
          console.log("DeActive session data",response.data);
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
      console.error("device sessions-terminate:", error);
      return Promise.reject(new Error(error.message || "Error sessions-terminate api"));
    }
}

export async function emailLoginService(payload) {
    try {
        const response = await apiCall("POST", "user/auth/login", payload);

        if (response && response.message && typeof response.message === 'string') {
            if (response.statusCode === 200) {
                return response;
            } else {
                showToast(response.message);
                return Promise.reject(response.message);
            }
        } else {
            return Promise.reject("Invalid response from server");
        }
    } catch (error) {
        console.error("Email login error:", error);
        return Promise.reject(error.message || "Error during email login");
    }
}

// ── Org two-step verification (in-app OTP over the Talkstry system channel) ──
// The login call returns { data: { requiresTwoStepVerification, challengeToken } }
// instead of tokens; these two endpoints complete / refresh that challenge.
// Errors carry body.errorCode: OTP_INVALID | OTP_EXPIRED | OTP_ATTEMPTS_EXCEEDED |
// CHALLENGE_EXPIRED | RESEND_COOLDOWN | RESEND_LIMIT | NO_REACHABLE_SESSION.
export async function verify2svService(payload) {
    try {
        const response = await apiCall("POST", "user/auth/2sv/verify", payload);
        if (response?.statusCode === 200) return response;
        return Promise.reject(response || { message: "Verification failed" });
    } catch (error) {
        return Promise.reject(error?.response?.data || { message: error.message || "Verification failed" });
    }
}

export async function resend2svService(payload) {
    try {
        const response = await apiCall("POST", "user/auth/2sv/resend", payload);
        if (response?.statusCode === 200) return response;
        return Promise.reject(response || { message: "Could not resend code" });
    } catch (error) {
        return Promise.reject(error?.response?.data || { message: error.message || "Could not resend code" });
    }
}

export const authServices = {
    generateOtp,
    verifyOtpService,
    resendOtpService,
    activeSession,
    deactiveSession,
    emailLoginService,
};