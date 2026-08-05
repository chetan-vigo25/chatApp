import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

import { PermissionStatus, fromExpoResponse } from '../../domain/permissionTypes';
import { releaseNotificationPrompt } from '../../notificationPromptGate';

/**
 * Notifications adapter.
 *
 * Android 13+ (API 33) → POST_NOTIFICATIONS runtime permission. expo-notifications
 * requests exactly that permission under the hood via the modern Activity Result
 * API, so no manual `PermissionsAndroid` plumbing (or Activity juggling) is needed.
 * Android 8–12 → notifications are granted at install time; nothing to ask for.
 *
 * iOS → UNUserNotificationCenter alert/badge/sound authorization.
 *
 * After a grant we re-drive the FCM bootstrap: the boot path in App.js may have run
 * before the permission existed, so the token needs to be (re)fetched and pushed to
 * the backend or message/call pushes silently go nowhere.
 */
const notificationsAdapter = {
  id: 'notifications',

  isSupported() {
    // Android below 13 has no runtime notification permission at all.
    if (Platform.OS === 'android' && Number(Platform.Version) < 33) return false;
    return true;
  },

  async check() {
    const response = await Notifications.getPermissionsAsync();
    return normalize(response);
  },

  async request() {
    // The permission screen owns the prompt from here on — let the FCM boot path
    // resume its normal behaviour on subsequent launches.
    releaseNotificationPrompt();

    const response = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
      },
    });

    const status = normalize(response);

    if (status === PermissionStatus.GRANTED || status === PermissionStatus.LIMITED) {
      await refreshPushRegistration();
    }

    return status;
  },
};

/**
 * iOS can authorize notifications *provisionally* (quiet delivery, no prompt).
 * Banners are limited but messages do arrive, so it counts as granted rather than
 * leaving the user stuck on a permission the OS will never prompt for again.
 */
function normalize(response) {
  const provisional = Notifications.IosAuthorizationStatus?.PROVISIONAL;
  if (provisional != null && response?.ios?.status === provisional) {
    return PermissionStatus.GRANTED;
  }
  return fromExpoResponse(response);
}

/**
 * Fetch + re-register the FCM token now that banners are allowed.
 * Lazily required so this module stays importable from anywhere without dragging
 * the whole Firebase/socket graph in (and without an import cycle through
 * fcmService → notificationPromptGate).
 * Best-effort: a failure here must never block the permission flow.
 */
async function refreshPushRegistration() {
  try {
    const { getFCMToken } = require('../../../../firebase/fcmService');
    const { setPushToken } = require('../../../../Redux/Services/Socket/socket');
    const token = await getFCMToken();
    if (token && typeof setPushToken === 'function') setPushToken(token);
  } catch (error) {
    console.warn('[permissions] push re-registration skipped:', error?.message);
  }
}

export default notificationsAdapter;
