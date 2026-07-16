import { apiCall } from '../../../Config/Https';

// The app lock is scoped per platform on the backend: this client owns the
// `app` node under settings.chat.twoStep, the website owns `web`. Sending this
// on every write/verify is what keeps the two locks independent — locking the
// website must never lock the phone, and the passwords can differ.
export const APP_LOCK_PLATFORM = 'app';

// Pull this device's app-lock state out of a settings payload. Falls back to the
// legacy flat shape only when the platform node is absent (old backend).
export function readAppLockScope(settings) {
  const two = settings?.chat?.twoStep || {};
  const scope = two[APP_LOCK_PLATFORM];
  if (scope && typeof scope === 'object') {
    return { enabled: !!scope.enabled, hasPassword: !!scope.hasPassword };
  }
  return { enabled: !!two.enabled, hasPassword: !!two.hasPassword };
}

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

// PATCH the app-lock (2-step) settings for THIS platform only. Always go through
// this instead of hand-rolling a `{ chat: { twoStep: … } }` payload — a payload
// without `platform` is treated as a pre-split client and writes the website's
// lock too.
export function updateAppLock({ enabled, password }) {
  const twoStep = { platform: APP_LOCK_PLATFORM };
  if (enabled !== undefined) twoStep.enabled = enabled;
  if (password !== undefined) twoStep.password = password;
  return updateUserSettings({ chat: { twoStep } });
}

// POST /api/user/settings/verify-two-step-password { password, platform } → { valid }
export async function verifyTwoStepPassword(password) {
  try {
    const response = await apiCall(
      'POST',
      'user/settings/verify-two-step-password',
      { password, platform: APP_LOCK_PLATFORM },
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
  updateAppLock,
  readAppLockScope,
  verifyDeletedPassword,
  verifyTwoStepPassword,
};
