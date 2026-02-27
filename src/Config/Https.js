import axios from "axios";
import { ToastAndroid, Alert, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { BACKEND_URL } from "@env";

function showToast(message) {
  if (!message) return;
  if (Platform.OS === 'android') {
    ToastAndroid.show(String(message), ToastAndroid.SHORT);
  } else {
    Alert.alert('', String(message));
  }
}

const api = axios.create({
  baseURL: BACKEND_URL,
  timeout: 15000,
});

// Helper to detect FormData in different environments (expo/react-native)
const isFormData = (data) => {
  if (!data) return false;
  try {
    if (typeof FormData !== 'undefined' && data instanceof FormData) return true;
  } catch (e) {
    // instanceof can throw in some environments, fall back to duck-typing
  }
  return typeof data === 'object' && ('_parts' in data || (data.constructor && data.constructor.name === 'FormData'));
};

// Attach token automatically to all requests
api.interceptors.request.use(
  async (config) => {
    try {
      const token = await AsyncStorage.getItem("accessToken");
      if (token) {
        config.headers = config.headers || {};
        config.headers.Authorization = `Bearer ${token}`;
      }

      // Default Content-Type for JSON (don't force for FormData requests)
      config.headers = config.headers || {};
      if (!config.headers['Content-Type'] && !isFormData(config.data)) {
        config.headers['Content-Type'] = "application/json";
      }

      return config;
    } catch (err) {
      return Promise.reject(err);
    }
  },
  (error) => Promise.reject(error)
);

// Centralized error handling
async function handleApiError(error) {
  console.log("API Error in HTTPS Config:", {
    status: error?.response?.status,
    data: error?.response?.data,
    url: error?.config?.url,
    method: error?.config?.method,
    message: error.message,
  });

  // If response exists, use its message
  if (error.response) {
    const msg = error.response.data?.message || error.response.statusText || "API Error";
    showToast(msg);
    return Promise.reject(error.response.data || error);
  }

  // If request was sent but no response
  if (error.request) {
    showToast("No response received from server");
    return Promise.reject(new Error("No response received from server"));
  }

  // Other errors
  return Promise.reject(error);
}

// Build full URL safely using BACKEND_URL if needed
const buildUrl = (endpoint) => {
  if (!endpoint) return null;
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  if (BACKEND_URL && BACKEND_URL.trim()) {
    return `${BACKEND_URL.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}`;
  }
  return null;
};

// Generic API call for JSON
export const apiCall = async (method, endpoint, data = {}, config = {}) => {
  try {
    const url = buildUrl(endpoint);
    if (!url) {
      const msg = 'BACKEND_URL is not configured. Set BACKEND_URL in your .env';
      console.error(msg);
      showToast(msg);
      return Promise.reject(new Error(msg));
    }

    const response = await api({ method, url, data, ...config });
    return response.data;
  } catch (error) {
    return handleApiError(error);
  }
};

// API call for FormData (file uploads)
// Important: Do NOT manually set a Content-Type with a boundary here — let axios set it for FormData.
export const apiCallForm = async (method, endpoint, formData, config = {}) => {
  try {
    const url = buildUrl(endpoint);
    if (!url) {
      const msg = 'BACKEND_URL is not configured. Set BACKEND_URL in your .env';
      console.error(msg);
      showToast(msg);
      return Promise.reject(new Error(msg));
    }

    // Prepare headers and token
    const token = await AsyncStorage.getItem('accessToken');
    const headers = { ...(config.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    // Do NOT set Content-Type for FormData; fetch will handle it.

    // Use fetch with timeout (AbortController) because RN axios/FormData is sometimes unreliable
    const controller = new AbortController();
    const timeoutMs = config.timeout || 30000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const fetchOptions = {
      method: method || 'POST',
      headers,
      body: formData,
      signal: controller.signal,
    };

    const response = await fetch(url, fetchOptions);
    clearTimeout(timeoutId);

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = text; }

    if (!response.ok) {
      const msg = data?.message || response.statusText || 'Upload failed';
      showToast(msg);
      const err = new Error(msg);
      err.response = { data, status: response.status, statusText: response.statusText, url };
      return Promise.reject(err);
    }

    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      const msg = 'Request timed out';
      console.error('apiCallForm timeout', { endpoint, timeout: config.timeout });
      showToast(msg);
      return Promise.reject(new Error(msg));
    }
    console.error('apiCallForm fetch error:', error);
    return handleApiError(error);
  }
};

export default api;