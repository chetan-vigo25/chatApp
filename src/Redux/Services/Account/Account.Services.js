import { apiCall } from '../../../Config/Https';

// Predefined deletion reasons shown on the first step of the Delete Account
// flow. Mirrors ACCOUNT_DELETE_REASONS on the backend. "Other" reveals a
// free-text field whose value is sent as `customReason`.
export const DELETE_REASONS = [
  'Privacy concerns',
  'Switching to another account',
  'Too many notifications',
  'Technical issues',
  'Temporary break',
  'Security concerns',
  'Other',
];

// POST /user/account/delete — request soft-deletion of the logged-in account.
// On success the server has already logged this device out everywhere; the
// caller is responsible for wiping local state and returning to the auth screen.
export async function deleteAccount({ reason, customReason } = {}) {
  const response = await apiCall(
    'POST',
    'user/account/delete',
    { reason, customReason: customReason || '', confirm: true },
    { silent: true },
  );
  if (response?.statusCode === 200) return response;
  return Promise.reject(response?.message || 'Failed to delete account.');
}

// POST /user/account/cancel-delete — cancel an in-progress deletion.
export async function cancelDeleteAccount() {
  const response = await apiCall('POST', 'user/account/cancel-delete', {}, { silent: true });
  if (response?.statusCode === 200) return response;
  return Promise.reject(response?.message || 'Failed to cancel deletion.');
}
