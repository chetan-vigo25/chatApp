/**
 * Cryptography utilities for device linking.
 *
 * Uses crypto-js for HMAC-SHA256 signing and expo-secure-store
 * for secure key pair persistence.
 *
 * Avoids native crypto.getRandomValues() dependency by generating
 * randomness via CryptoJS's built-in Math.random fallback and
 * timestamp-based entropy.
 */
import CryptoJS from 'crypto-js';
import * as SecureStore from 'expo-secure-store';
import { KEYPAIR_STORAGE_KEY } from '../constants';
import { SALT_SECRET } from '@env';

const SIGNING_SECRET = SALT_SECRET || 'device-link-signing-key';

/**
 * Generate a random hex string without needing native crypto.getRandomValues.
 * Uses timestamp + Math.random entropy, sufficient for key identifiers.
 * @param {number} length - Number of hex characters
 * @returns {string}
 */
function randomHex(length) {
  let result = '';
  const chars = '0123456789abcdef';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Generate a v4-style UUID without native crypto dependency.
 * @returns {string}
 */
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Generate a key pair for device linking.
 * Returns a unique public/private key identifier pair.
 * @returns {{ publicKey: string, privateKey: string }}
 */
export function generateKeyPair() {
  const privateKey = generateUUID() + '-' + randomHex(64) + '-' + Date.now().toString(36);
  const publicKey = CryptoJS.SHA256(privateKey).toString();
  return {
    publicKey: `-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`,
    privateKey,
  };
}

/**
 * Sign data using HMAC-SHA256.
 * @param {string} data - The string data to sign (e.g. sessionId)
 * @param {string} privateKey - The private key to use for signing
 * @returns {string} Base64-encoded signature
 */
export function signData(data, privateKey) {
  const hmac = CryptoJS.HmacSHA256(data, privateKey + SIGNING_SECRET);
  return CryptoJS.enc.Base64.stringify(hmac);
}

/**
 * Store a key pair securely using expo-secure-store.
 * @param {{ publicKey: string, privateKey: string }} keyPair
 */
export async function storeKeyPair(keyPair) {
  await SecureStore.setItemAsync(
    KEYPAIR_STORAGE_KEY,
    JSON.stringify(keyPair)
  );
}

/**
 * Retrieve the stored key pair from secure storage.
 * @returns {Promise<{ publicKey: string, privateKey: string } | null>}
 */
export async function getStoredKeyPair() {
  const raw = await SecureStore.getItemAsync(KEYPAIR_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Delete the stored key pair.
 */
export async function deleteStoredKeyPair() {
  await SecureStore.deleteItemAsync(KEYPAIR_STORAGE_KEY);
}