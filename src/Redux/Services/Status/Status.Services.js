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

  // ── Media upload (batch) ───────────────────────────────────────────────────

  /** Upload 1–10 files.  Accepts a FormData with field name 'files' or 'file'. */
  async uploadStatusMedia(formData) {
    const response = await apiCallForm('POST', `${BASE}/upload-media`, formData);
    if (response?.statusCode === 200) return response;
    return Promise.reject(response?.message);
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
