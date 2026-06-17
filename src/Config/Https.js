import axios from "axios";
import { ToastAndroid, Alert, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { BACKEND_URL } from "@env";
import { performSessionReset, refreshAccessToken } from "../services/sessionManager";

// In-memory throttle so we never spam multiple alerts in a row.
// Apple flags blocking modals from background fetches under 2.1.0
// (App Completeness), so on iOS we only show a toast-style alert if
// the user hasn't seen one in the last few seconds.
let lastToastAt = 0;
let lastToastMessage = '';
const TOAST_THROTTLE_MS = 4000;

function showToast(message) {
  if (!message) return;
  const text = String(message);
  const now = Date.now();
  if (text === lastToastMessage && now - lastToastAt < TOAST_THROTTLE_MS) {
    return;
  }
  lastToastAt = now;
  lastToastMessage = text;
  if (Platform.OS === 'android') {
    ToastAndroid.show(text, ToastAndroid.SHORT);
  } else if (Platform.OS === 'ios') {
    // Avoid blocking Alert popups on iOS for transient API failures;
    // a console warning is enough — caller renders inline state instead.
    console.warn('[API]', text);
  } else {
    Alert.alert('', text);
  }
}

const api = axios.create({
  baseURL: BACKEND_URL,
  timeout: 15000,
});

let isRefreshing = false;
let failedQueue = [];

const processQueue = (error, token = null) => {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) {
      reject(error);
      return;
    }
    resolve(token);
  });
  failedQueue = [];
};

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

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error?.config;
    const status = error?.response?.status;

    // One-shot retry for transient iOS network drops.
    // ERR_NETWORK on RN/iOS often means the underlying request was aborted
    // (component unmount, app backgrounding, brief connectivity blip).
    // We also retry POSTs flagged as safe to retry (idempotent reads like
    // user/auth/view, profile fetches, etc.) — the caller opts in via
    // { retryOnNetwork: true } in apiCall config.
    if (
      originalRequest &&
      !originalRequest._netRetry &&
      (error?.code === 'ERR_NETWORK' || /Network Error|timeout/i.test(error?.message || ''))
    ) {
      const method = (originalRequest.method || 'get').toLowerCase();
      const safeRetry = method === 'get' || originalRequest._retryOnNetwork;
      if (safeRetry) {
        originalRequest._netRetry = true;
        await new Promise(r => setTimeout(r, 600));
        return api(originalRequest);
      }
    }

    if (!originalRequest || status !== 401 || originalRequest._retry) {
      return Promise.reject(error);
    }

    if ((originalRequest.url || '').includes('/refresh')) {
      return Promise.reject(error);
    }

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        failedQueue.push({ resolve, reject });
      }).then((newAccessToken) => {
        originalRequest.headers = originalRequest.headers || {};
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        return api(originalRequest);
      });
    }

    originalRequest._retry = true;
    isRefreshing = true;

    try {
      const refreshed = await refreshAccessToken({ force: true });
      console.log("Token refreshed successfully ------------------", { refreshed });
      const newAccessToken = refreshed?.accessToken;

      if (!newAccessToken) {
        throw new Error('Token refresh response missing access token');
      }

      processQueue(null, newAccessToken);
      originalRequest.headers = originalRequest.headers || {};
      originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
      return api(originalRequest);
    } catch (refreshError) {
      processQueue(refreshError, null);
      await performSessionReset({
        reason: 'session_expired',
        resetNavigation: true,
        clearAllStorage: true,
      });
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  }
);

// Centralized error handling
async function handleApiError(error) {
  console.log("API Error in HTTPS Config:", {
    platform: Platform.OS,
    status: error?.response?.status,
    data: error?.response?.data,
    url: error?.config?.url,
    method: error?.config?.method,
    timeout: error?.config?.timeout,
    code: error?.code,
    name: error?.name,
    message: error?.message,
    isAxiosTimeout: error?.code === 'ECONNABORTED',
    hasRequest: !!error?.request,
    hasResponse: !!error?.response,
  });

  // If response exists, use its message
  if (error.response) {
    const msg = error.response.data?.message || error.response.statusText || "API Error";
    showToast(msg);
    return Promise.reject(error.response.data || error);
  }

  // Request was sent but no response — distinguish timeout from network failure
  if (error.request) {
    const isTimeout = error?.code === 'ECONNABORTED' || /timeout/i.test(error?.message || '');
    const msg = isTimeout ? 'Request timed out' : 'No response received from server';
    showToast(msg);
    const wrapped = new Error(msg);
    wrapped.code = error?.code || (isTimeout ? 'ECONNABORTED' : 'ERR_NETWORK');
    wrapped.url = error?.config?.url;
    return Promise.reject(wrapped);
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
// Pass { silent: true } in config to suppress error toasts (e.g., expected 404s)
// Pass { retryOnNetwork: true } to retry POSTs on transient ERR_NETWORK / timeout
export const apiCall = async (method, endpoint, data = {}, config = {}) => {
  const { silent, retryOnNetwork, ...restConfig } = config;
  try {
    const url = buildUrl(endpoint);
    if (!url) {
      const msg = 'BACKEND_URL is not configured. Set BACKEND_URL in your .env';
      console.error(msg);
      if (!silent) showToast(msg);
      return Promise.reject(new Error(msg));
    }

    // Bodyless methods (GET/HEAD) must NOT carry a request body. Sending one
    // (axios serializes `data` even on GET) makes iOS NSURLSession reject the
    // response with CFNetwork -1103 "resource exceeds maximum size" → surfaces
    // as ERR_NETWORK. curl/Safari work because they send GETs with no body.
    const m = String(method || 'get').toLowerCase();
    const hasBody = m !== 'get' && m !== 'head';

    const response = await api({
      method,
      url,
      ...(hasBody ? { data } : {}),
      ...restConfig,
      _retryOnNetwork: retryOnNetwork,
    });
    return response.data;
  } catch (error) {
    if (silent) {
      // Log but don't toast — caller handles the error. Include the FULLY
      // BUILT url + axios error code so a network failure (ERR_NETWORK / no
      // response) is distinguishable from an HTTP status error, and we can
      // see the exact host the request actually targeted.
      console.log('[API:silent]', {
        status: error?.response?.status,
        code: error?.code,
        message: error?.message,
        url: buildUrl(endpoint),
        baseURL: BACKEND_URL,
      });
      return Promise.reject(error?.response?.data || error);
    }
    return handleApiError(error);
  }
};

// API call for FormData (file uploads)
// Important: Do NOT manually set a Content-Type with a boundary here — let axios set it for FormData.
//
// Supported config:
//   timeout         — ms before the request aborts (default 30000)
//   signal          — caller-supplied AbortSignal for cancel (back nav, retry, etc.)
//   onUploadProgress— if provided, switches to XHR so byte-level progress works
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
    let token = await AsyncStorage.getItem('accessToken');
    const headers = { ...(config.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    // Do NOT set Content-Type for FormData; fetch will handle it.

    // Compose an AbortController that fires on timeout OR on caller-supplied signal
    const controller = new AbortController();
    const timeoutMs = config.timeout || 30000;
    const timeoutId = setTimeout(() => controller.abort('timeout'), timeoutMs);

    let externalAbortHandler;
    if (config.signal) {
      if (config.signal.aborted) {
        clearTimeout(timeoutId);
        controller.abort('caller_aborted');
      } else {
        externalAbortHandler = () => controller.abort('caller_aborted');
        config.signal.addEventListener('abort', externalAbortHandler);
      }
    }

    // XHR path — only when caller wants real byte-level progress.
    if (typeof config.onUploadProgress === 'function') {
      clearTimeout(timeoutId);
      if (config.signal && externalAbortHandler) {
        config.signal.removeEventListener('abort', externalAbortHandler);
      }
      return xhrUpload({ method, url, headers, formData, config });
    }

    const fetchOptions = {
      method: method || 'POST',
      headers,
      body: formData,
      signal: controller.signal,
    };

    let response;
    try {
      response = await fetch(url, fetchOptions);
    } finally {
      clearTimeout(timeoutId);
      if (config.signal && externalAbortHandler) {
        config.signal.removeEventListener('abort', externalAbortHandler);
      }
    }

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = text; }

    if (response.status === 401 && !config._retry) {
      try {
        const refreshed = await refreshAccessToken({ force: true });
        token = refreshed?.accessToken;

        if (!token) {
          throw new Error('Session expired');
        }

        return apiCallForm(method, endpoint, formData, {
          ...config,
          _retry: true,
          headers: {
            ...(config.headers || {}),
            Authorization: `Bearer ${token}`,
          },
        });
      } catch (refreshError) {
        await performSessionReset({
          reason: 'session_expired_upload',
          resetNavigation: true,
          clearAllStorage: true,
        });
        throw refreshError;
      }
    }

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

/**
 * XHR-based upload — used when the caller passes `onUploadProgress`.
 * Returns the parsed JSON body on 2xx, rejects with an Error otherwise.
 * Honours `config.signal` for cancellation and `config.timeout` for hard
 * timeout. Does NOT auto-refresh on 401 (matches fetch path's behaviour
 * pre-refresh; the caller will see the 401 and can retry).
 */
function xhrUpload({ method, url, headers, formData, config }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const timeoutMs = config.timeout || 30000;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { xhr.abort(); } catch {}
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      if (config.signal && abortHandler) {
        config.signal.removeEventListener('abort', abortHandler);
      }
    };

    const abortHandler = () => {
      try { xhr.abort(); } catch {}
    };

    if (config.signal) {
      if (config.signal.aborted) {
        cleanup();
        return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }
      config.signal.addEventListener('abort', abortHandler);
    }

    xhr.open(method || 'POST', url, true);
    Object.keys(headers || {}).forEach(k => {
      try { xhr.setRequestHeader(k, headers[k]); } catch {}
    });

    if (xhr.upload && typeof config.onUploadProgress === 'function') {
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        try { config.onUploadProgress({ loaded: e.loaded, total: e.total }); } catch {}
      };
    }

    xhr.onload = () => {
      cleanup();
      const text = xhr.responseText;
      let data = null;
      try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      const msg = data?.message || xhr.statusText || 'Upload failed';
      showToast(msg);
      const err = new Error(msg);
      err.response = { data, status: xhr.status, statusText: xhr.statusText, url };
      reject(err);
    };

    xhr.onerror = () => {
      cleanup();
      const msg = timedOut ? 'Request timed out' : 'Network error';
      showToast(msg);
      reject(Object.assign(new Error(msg), { name: timedOut ? 'AbortError' : 'NetworkError' }));
    };

    xhr.onabort = () => {
      cleanup();
      reject(Object.assign(new Error(timedOut ? 'Request timed out' : 'aborted'), {
        name: 'AbortError',
      }));
    };

    xhr.send(formData);
  });
}

export default api;