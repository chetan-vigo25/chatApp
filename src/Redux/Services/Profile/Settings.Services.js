import { apiCall } from '../../../Config/Https';

// GET /api/user/settings — returns { settings: { chat: { ... } } }
export async function getUserSettings() {
  try {
    const response = await apiCall('GET', 'user/settings', {}, { silent: true });
    if (response?.statusCode === 200) return response.data?.settings || {};
    return Promise.reject(response?.message || 'Failed to fetch settings');
  } catch (error) {
    return Promise.reject(error);
  }
}

// PATCH /api/user/settings — partial update. payload shape: { chat: { ... } }
// deletedPassword is sent plaintext; backend encrypts before persisting and
// never echoes it back.
export async function updateUserSettings(payload) {
  try {
    const response = await apiCall('PATCH', 'user/settings', payload, { silent: true });
    if (response?.statusCode === 200) return response.data?.settings || {};
    return Promise.reject(response?.message || 'Failed to update settings');
  } catch (error) {
    return Promise.reject(error);
  }
}

// POST /api/user/settings/verify-deleted-password { password } → { valid }
// Returns boolean. Network/HTTP errors resolve to `false` so callers can fall
// through to the normal flow instead of crashing the gate.
export async function verifyDeletedPassword(password) {
  try {
    const response = await apiCall(
      'POST',
      'user/settings/verify-deleted-password',
      { password },
      { silent: true }
    );
    if (response?.statusCode === 200) return !!response.data?.valid;
    return false;
  } catch {
    return false;
  }
}

// POST /api/user/settings/verify-two-step-password { password } → { valid }
export async function verifyTwoStepPassword(password) {
  try {
    const response = await apiCall(
      'POST',
      'user/settings/verify-two-step-password',
      { password },
      { silent: true }
    );
    if (response?.statusCode === 200) return !!response.data?.valid;
    return false;
  } catch {
    return false;
  }
}

export const settingsServices = {
  getUserSettings,
  updateUserSettings,
  verifyDeletedPassword,
  verifyTwoStepPassword,
};
