/**
 * Collects device information for the device-link request.
 *
 * Note: When linking a web client, deviceType and platform are always "web"
 * because the mobile app acts as the authenticator for the web session.
 */
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * Build the deviceInfo payload for the link request.
 * @param {string} publicKey - PEM-encoded public key to include
 * @returns {object} Device info object matching the backend schema
 */
export function getDeviceInfo(publicKey) {
  const osVersion = `${Platform.OS === 'ios' ? 'iOS' : 'Android'} ${Device.osVersion || Platform.Version}`;
  const deviceName = Device.modelName || Device.deviceName || Device.brand || 'Unknown Device';

  return {
    deviceName,
    deviceType: 'web',
    platform: 'web',
    browser: 'Mobile Authenticator',
    os: osVersion,
    publicKey,
  };
}

/**
 * Get a human-readable label for the current mobile device (for local display).
 * @returns {string}
 */
export function getMobileDeviceLabel() {
  return Device.modelName || Device.brand || 'This Device';
}