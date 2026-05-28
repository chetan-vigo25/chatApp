import { apiCall, apiCallForm } from '../../../Config/Https';
import { Alert } from 'react-native';

const showToast = (msg) => { if (msg) Alert.alert('', msg); };
const BASE = 'user/status';

export const statusServices = {
  // ── CRUD ───────────────────────────────────────────────────────────────────

  async createStatus(data) {
    const response = await apiCall('POST', `${BASE}/create`, data);
    if (response?.statusCode === 200) return response;
    showToast(response?.message || 'Failed to create status');
    return Promise.reject(response?.message);
  },

  async getMyStatuses() {
    try {
      const response = await apiCall('POST', `${BASE}/my`, {}, { silent: true });
      if (response?.statusCode === 200) return response;
      return { data: [] };
    } catch (err) {
      console.log('[getMyStatuses] silent failure:', err?.code || err?.message);
      return { data: [] };
    }
  },

  /** Feed — contacts, grouped, Redis-cached 60 s.
   * Silent on error: background fetch, no user-facing alert on transient network failures. */
  async getStatusFeed() {
    try {
      const response = await apiCall('GET', `${BASE}/feed`, {}, { timeout: 30000, silent: true });
      if (response?.statusCode === 200) return response;
      return { data: [] };
    } catch (err) {
      console.log('[getStatusFeed] silent failure:', err?.code || err?.message);
      return { data: [] };
    }
  },

  async getContactStatuses() {
    return this.getStatusFeed();
  },

  async getStatusById(statusId) {
    try {
      const response = await apiCall('GET', `${BASE}/${statusId}`, {}, { silent: true });
      if (response?.statusCode === 200) return response;
      return null;
    } catch (err) {
      console.log('[getStatusById] silent failure:', err?.code || err?.message);
      return null;
    }
  },

  async deleteStatus(statusId) {
    const response = await apiCall('POST', `${BASE}/delete`, { statusId });
    if (response?.statusCode === 200) return response;
    showToast(response?.message || 'Failed to delete');
    return Promise.reject(response?.message);
  },

  // ── Link preview (server-side OG scrape) ──────────────────────────────────
  /**
   * Server-side OG fetch. Backend always responds 200 with a fallback
   * `{ title: url, ... }` even on failure, so this never rejects on UX paths.
   */
  async fetchLinkPreview(url) {
    try {
      const response = await apiCall(
        'GET',
        `${BASE}/link-preview?url=${encodeURIComponent(url)}`,
        {},
        { silent: true, timeout: 12000 }
      );
      if (response?.statusCode === 200) return response?.data || null;
      return null;
    } catch {
      return null;
    }
  },

  // ── Settings (public read-only) ────────────────────────────────────────────

  /**
   * Fetch the public status settings (driven by the admin DB row).
   * Backend always responds with sane defaults — never null fields.
   * Silent: this runs on boot and must not toast.
   */
  async getStatusSettings() {
    try {
      const response = await apiCall('GET', `${BASE}/settings`, {}, { silent: true });
      if (response?.statusCode === 200) return response;
      return null;
    } catch (err) {
      return null;
    }
  },

  // ── Media upload (batch) ───────────────────────────────────────────────────

  /**
   * Upload 1–10 files. Accepts a FormData with field name 'files' or 'file'.
   * Optional `{ signal, onProgress, timeoutMs }` for cancellation, byte-level
   * progress, and overriding the default upload timeout (300s — videos can be
   * large and slow to upload on mobile networks).
   */
  async uploadStatusMedia(formData, opts = {}) {
    const { signal, onProgress, timeoutMs = 300000 } = opts;
    const response = await apiCallForm('POST', `${BASE}/upload-media`, formData, {
      timeout: timeoutMs,
      signal,
      onUploadProgress: typeof onProgress === 'function'
        ? (evt) => {
            if (!evt || !evt.total) return;
            const percent = Math.min(100, Math.round((evt.loaded / evt.total) * 100));
            try { onProgress(percent, evt.loaded, evt.total); } catch {}
          }
        : undefined,
    });
    if (response?.statusCode === 200) return response;
    return Promise.reject(response?.message || 'Upload failed');
  },

  // ── Interactions ──────────────────────────────────────────────────────────

  async viewStatus(statusId) {
    try {
      const response = await apiCall('POST', `${BASE}/${statusId}/view`, {}, { silent: true });
      if (response?.statusCode === 200) return response;
      return Promise.reject(response?.message);
    } catch (err) {
      console.log('[viewStatus] silent failure:', err?.code || err?.message);
      return Promise.reject(err);
    }
  },

  async reactToStatus(statusId, reactionType) {
    try {
      const response = await apiCall('POST', `${BASE}/${statusId}/react`, { reactionType }, { silent: true });
      if (response?.statusCode === 200) return response;
      return Promise.reject(response?.message);
    } catch (err) {
      console.log('[reactToStatus] silent failure:', err?.code || err?.message);
      return Promise.reject(err);
    }
  },

  async replyToStatus(statusId, message) {
    const response = await apiCall('POST', `${BASE}/${statusId}/reply`, { message });
    if (response?.statusCode === 200) return response;
    showToast(response?.message || 'Failed to send reply');
    return Promise.reject(response?.message);
  },

  async reportStatus(statusId, reason, details = '') {
    const response = await apiCall('POST', `${BASE}/${statusId}/report`, { reason, details });
    if (response?.statusCode === 200) return response;
    return Promise.reject(response?.message);
  },

  async hideStatus(statusId) {
    const response = await apiCall('POST', `${BASE}/${statusId}/hide`);
    if (response?.statusCode === 200) return response;
    return Promise.reject(response?.message);
  },

  async downloadStatus(statusId) {
    const response = await apiCall('GET', `${BASE}/${statusId}/download`);
    if (response?.statusCode === 200) return response;
    return Promise.reject(response?.message);
  },

  async shareStatus(statusId, targetChatIds) {
    const response = await apiCall('POST', `${BASE}/${statusId}/share`, { targetChatIds });
    if (response?.statusCode === 200) return response;
    return Promise.reject(response?.message);
  },

  // ── Viewers (owner only) ───────────────────────────────────────────────────

  async getStatusViewers(statusId) {
    try {
      const response = await apiCall('POST', `${BASE}/viewers`, { statusId }, { silent: true });
      if (response?.statusCode === 200) return response;
      return { data: { viewCount: 0, viewers: [] } };
    } catch (err) {
      console.log('[getStatusViewers] silent failure:', err?.code || err?.message);
      return { data: { viewCount: 0, viewers: [] } };
    }
  },

  // ── Likers (owner only) ────────────────────────────────────────────────────

  async getStatusLikers(statusId) {
    try {
      const response = await apiCall('GET', `${BASE}/${statusId}/likes`, {}, { silent: true });
      if (response?.statusCode === 200) return response;
      return { data: { likedBy: [], total: 0 } };
    } catch (err) {
      console.log('[getStatusLikers] silent failure:', err?.code || err?.message);
      return { data: { likedBy: [], total: 0 } };
    }
  },
};
