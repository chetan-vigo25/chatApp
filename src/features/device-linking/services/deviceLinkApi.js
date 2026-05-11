/**
 * REST API service for device linking.
 *
 * Endpoints:
 *  POST /user/device-link/link    → { device, webToken, userId, sessionId }
 *  GET  /user/device-link/devices → { devices: [...], count }
 *  POST /user/device-link/unlink  → { deviceId }
 *
 * Uses the project's shared axios instance from Config/Https.js which
 * automatically attaches the Bearer token and handles 401 refresh.
 */
import { apiCall } from '../../../Config/Https';
import { ENDPOINTS, LINK_TIMEOUT_MS } from '../constants';

/**
 * Link a new device.
 * @param {{ sessionId: string, deviceInfo: object, signature: string }} payload
 * @returns {Promise<{ data: object, token: { accessToken, refreshToken }, _socketMeta: object }>}
 */
export async function linkDevice({ sessionId, deviceInfo, signature }) {
  const response = await apiCall('POST', ENDPOINTS.LINK, {
    sessionId,
    deviceInfo,
    signature,
  }, { timeout: LINK_TIMEOUT_MS });

  // apiCall returns the full JSON body: { data, token, _socketMeta }
  // Return the full response so the hook can handle tokens and session meta.
  return response;
}

/**
 * Get all linked devices for the current user.
 * Backend returns: { devices: [...], count: N }
 * @returns {Promise<{ devices: Array, count: number }>}
 */
export async function getLinkedDevices() {
  const response = await apiCall('GET', ENDPOINTS.DEVICES);
  return response?.data ?? response;
}

/**
 * Unlink (remove) a linked device.
 * Backend returns: { deviceId }
 * @param {string} deviceId
 * @returns {Promise<{ deviceId: string }>}
 */
export async function unlinkDevice(deviceId) {
  const response = await apiCall('POST', ENDPOINTS.UNLINK, { deviceId });
  return response?.data ?? response;
}