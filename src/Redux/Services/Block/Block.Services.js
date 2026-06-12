import { apiCall } from '../../../Config/Https';

/**
 * Block / Unblock service — WhatsApp-style user-to-user blocking.
 * Backend contract (mounted at /api/v2/user):
 *   POST /block                 { userId, platform }
 *   POST /unblock               { userId, platform }
 *   GET  /blocked?search&page&limit
 *   GET  /block-status/:userId
 */

export async function blockUserApi(userId) {
  const response = await apiCall('POST', 'user/block', { userId, platform: 'mobile' });
  if (response?.statusCode === 200) return response.data;
  return Promise.reject(response?.message || 'Failed to block user');
}

export async function unblockUserApi(userId) {
  const response = await apiCall('POST', 'user/unblock', { userId, platform: 'mobile' });
  if (response?.statusCode === 200) return response.data;
  return Promise.reject(response?.message || 'Failed to unblock user');
}

export async function fetchBlockedContactsApi({ search = '', page = 1, limit = 50 } = {}) {
  const qs = new URLSearchParams({ search: search || '', page: String(page), limit: String(limit) }).toString();
  const response = await apiCall('GET', `user/blocked?${qs}`, null, { silent: true, retryOnNetwork: true });
  if (response?.statusCode === 200) return response.data;
  return Promise.reject(response?.message || 'Failed to load blocked contacts');
}

export async function fetchBlockStatusApi(userId) {
  const response = await apiCall('GET', `user/block-status/${userId}`, null, { silent: true, retryOnNetwork: true });
  if (response?.statusCode === 200) return response.data;
  return Promise.reject(response?.message || 'Failed to load block status');
}

export const blockServices = {
  blockUserApi,
  unblockUserApi,
  fetchBlockedContactsApi,
  fetchBlockStatusApi,
};
