import { BACKEND_URL } from '@env';

/** API prefix for device-linking endpoints */
export const API_PREFIX = 'user/device-link';

/** Full endpoint paths */
export const ENDPOINTS = {
  LINK: `${API_PREFIX}/link`,
  UNLINK: `${API_PREFIX}/unlink`,
  DEVICES: `${API_PREFIX}/devices`,
};

/** Socket events */
export const SOCKET_EVENTS = {
  LINK_REQUEST: 'device:link:request',
  LINK_SUCCESS: 'device:link:success',
  SOCKET_ERROR: 'socket:error',
};

/** Backend error codes */
export const ERROR_CODES = {
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_INVALID_STATUS: 'SESSION_INVALID_STATUS',
  USER_INACTIVE: 'USER_INACTIVE',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  MAX_DEVICES_REACHED: 'MAX_DEVICES_REACHED',
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
};

/** Human-readable error messages keyed by error code */
export const ERROR_MESSAGES = {
  [ERROR_CODES.SESSION_NOT_FOUND]: 'This QR code has expired. Please ask the other device to generate a new QR code.',
  [ERROR_CODES.SESSION_EXPIRED]: 'This QR code has expired. Please ask the other device to generate a new QR code.',
  [ERROR_CODES.SESSION_INVALID_STATUS]: 'This QR code has already been used.',
  [ERROR_CODES.USER_INACTIVE]: 'Your account is inactive or blocked. Please contact support.',
  [ERROR_CODES.INVALID_SIGNATURE]: 'Device verification failed. Please try again.',
  [ERROR_CODES.MAX_DEVICES_REACHED]: 'You have reached the maximum of 5 linked devices. Please unlink a device first.',
  [ERROR_CODES.DEVICE_NOT_FOUND]: 'Device not found. It may have already been unlinked.',
};

/** Linking request timeout in ms */
export const LINK_TIMEOUT_MS = 10_000;

/** Expected backend base URL for QR validation */
export const EXPECTED_SERVER_URL = BACKEND_URL;

/** AsyncStorage key for stored key pair */
export const KEYPAIR_STORAGE_KEY = 'device_link_keypair';

/** Max number of QR scan retry delay in ms */
export const SCAN_RETRY_DELAY_MS = 2000;