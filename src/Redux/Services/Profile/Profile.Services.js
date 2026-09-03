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
// Profile fetch — safe to retry on transient network errors and silent
// on failure (caller renders an inline empty/error state instead of an
// Alert popup). This avoids the App Store reviewer seeing a blocking
// modal on the Settings screen during a transient connectivity blip.
export async function profileDetails(id) {
    try {
      const payload = id ? { _id: id } : {};

      const response = await apiCall(
        "POST",
        "user/auth/view",
        payload,
        { silent: true, retryOnNetwork: true }
      );

      if (response?.statusCode === 200) {
        return response;
      }
      return Promise.reject(response?.message || "Something went wrong");
    } catch (error) {
      console.log("[profileDetails] failed silently:", error?.message || error);
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
// ── Public username + contact privacy ───────────────────────────────────────
// These have their own endpoints rather than riding `updateProfile` above: the
// generic profile update writes whatever body it is given, so a username claim
// sent that way would bypass the reserved-word list, the change rate limit and
// the atomic uniqueness claim. The backend strips both fields from that route.
//
// All three are ONLINE-ONLY. They are deliberately never queued through the
// outbox: uniqueness cannot be honoured from a replay queue, and a replayed
// claim could resurrect a handle someone else has since legitimately taken.

/**
 * Live availability check for the username field. ADVISORY — a "free" answer is
 * not a reservation, so `setUsername` below can still come back USERNAME_TAKEN
 * and the caller must handle that.
 *
 * Silent: this fires on every debounced keystroke, so a transient failure must
 * not raise a toast. Resolves to null when the check could not be made.
 */
export async function checkUsernameAvailability(username) {
  try {
    const response = await apiCall(
      'GET',
      `user/profile/username/availability?u=${encodeURIComponent(username)}`,
      {},
      { silent: true }
    );
    return response?.statusCode === 200 ? (response?.data || null) : null;
  } catch (error) {
    return null; // network blip → the UI just shows no hint yet
  }
}

/**
 * Claim or change the public username.
 * Rejects with { code, message } so the caller can branch on the code
 * (USERNAME_TAKEN, USERNAME_RATE_LIMITED, …) rather than parsing prose.
 */
export async function setUsername(username) {
  try {
    const response = await apiCall('POST', 'user/profile/username', { username }, { silent: true });
    if (response?.statusCode === 200) return response;
    return Promise.reject({
      code: response?.data?.code || 'UNKNOWN',
      message: response?.message || 'Something went wrong',
      retryAfterMs: response?.data?.retryAfterMs || 0,
    });
  } catch (error) {
    return Promise.reject({
      code: error?.data?.code || 'NETWORK',
      message: error?.message || 'Could not reach the server. Please try again.',
    });
  }
}

/** Turn the "hide my phone number and email" toggle on or off. */
export async function setHideContact(enabled) {
  try {
    const response = await apiCall(
      'POST',
      'user/profile/privacy/hide-contact',
      { enabled: Boolean(enabled) },
      { silent: true }
    );
    if (response?.statusCode === 200) return response;
    return Promise.reject({
      code: response?.data?.code || 'UNKNOWN',
      message: response?.message || 'Something went wrong',
    });
  } catch (error) {
    return Promise.reject({
      code: error?.data?.code || 'NETWORK',
      message: error?.message || 'Could not reach the server. Please try again.',
    });
  }
}
