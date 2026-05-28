import messaging from '@react-native-firebase/messaging';
import * as Notifications from 'expo-notifications';
import { Platform, PermissionsAndroid } from 'react-native';

// ─── NOTIFICATION SOUND CONFIG ───
// Android: file must be at android/app/src/main/res/raw/notification_sound.wav
// iOS: file must be bundled via app.json expo-notifications plugin
const CUSTOM_SOUND_ANDROID = 'notification_sound'; // filename WITH extension for expo-notifications
const CUSTOM_SOUND_IOS = 'notification_sound.wav';

// ─── ANDROID NOTIFICATION CHANNEL (Required for Android 8+) ───
// IMPORTANT: When you change the sound file, bump the version number below.
// Android NEVER updates sound on an existing channel — only delete + recreate works.
// Channel ID must match AndroidManifest.xml default_notification_channel_id
const CHANNEL_VERSION = 2;
const CHANNEL_ID = `chat_messages_v${CHANNEL_VERSION}`;

// All previous channel IDs that should be cleaned up
const OLD_CHANNEL_IDS = [
  'chat_messages',
  'chat_messages_v1',
  'default',
  'fcm_fallback_notification_channel',
  'miscellaneous',
];

const setupNotificationChannel = async () => {
  if (Platform.OS === 'android') {
    // Delete ALL old channels so Android doesn't reuse cached sound settings
    for (const oldId of OLD_CHANNEL_IDS) {
      await Notifications.deleteNotificationChannelAsync(oldId).catch(() => {});
    }

    // Also delete current channel to force recreation with correct sound
    // (handles case where FCM created it with default sound before our code ran)
    await Notifications.deleteNotificationChannelAsync(CHANNEL_ID).catch(() => {});

    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Chat Messages',
      description: 'Notifications for new chat messages',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      sound: CUSTOM_SOUND_ANDROID,
      lightColor: '#34B7F1',
      enableLights: true,
      enableVibrate: true,
      showBadge: true,
    });

    console.log(`Notification channel "${CHANNEL_ID}" created with sound: ${CUSTOM_SOUND_ANDROID}`);
  }
};

// Create channel immediately on import
setupNotificationChannel();

// Configure foreground notifications — tells expo-notifications to show alerts in foreground
// SDK 54+ deprecated `shouldShowAlert`; iOS requires shouldShowBanner + shouldShowList to display.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

// Setup iOS notification categories (for reply buttons, etc.)
export const setupNotificationCategory = async () => {
  if (Platform.OS === 'ios') {
    await Notifications.setNotificationCategoryAsync('chat-message', [
      {
        identifier: 'reply',
        buttonTitle: 'Reply',
        options: { opensAppToForeground: true },
        textInput: {
          submitButtonTitle: 'Send',
          placeholder: 'Type your reply...',
        },
      },
    ]);
  }
};

// Request permission for notifications
export const requestNotificationPermission = async () => {
  try {
    console.log('[FCM] requestNotificationPermission start, platform:', Platform.OS, 'version:', Platform.Version);

    if (Platform.OS === 'android' && Platform.Version >= 33) {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
      );
      console.log('[FCM] POST_NOTIFICATIONS result:', granted);
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        console.warn('[FCM] POST_NOTIFICATIONS permission denied');
        return false;
      }
    }

    const authStatus = await messaging().requestPermission();
    console.log('[FCM] messaging.requestPermission authStatus:', authStatus);
    const enabled =
      authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
      authStatus === messaging.AuthorizationStatus.PROVISIONAL;

    if (!enabled) {
      console.warn('[FCM] permission not granted, status:', authStatus);
    }

    return enabled;
  } catch (error) {
    console.error('[FCM] Permission request error:', error);
    return false;
  }
};

// Get FCM token
export const getFCMToken = async () => {
  console.log('[FCM] getFCMToken called');
  const hasPermission = await requestNotificationPermission();
  console.log('[FCM] hasPermission:', hasPermission);
  if (!hasPermission) return null;

  try {
    if (Platform.OS === 'ios') {
      const isRegistered = messaging().isDeviceRegisteredForRemoteMessages;
      console.log('[FCM] iOS isDeviceRegisteredForRemoteMessages:', isRegistered);
      if (!isRegistered) {
        await messaging().registerDeviceForRemoteMessages();
        console.log('[FCM] iOS registerDeviceForRemoteMessages done');
      }
      const apns = await messaging().getAPNSToken();
      console.log('[FCM] APNs token:', apns);
    }

    console.log('[FCM] calling messaging().getToken()...');
    const token = await messaging().getToken();
    console.log('[FCM] Token:', token);

    messaging().onTokenRefresh(newToken => {
      console.log('[FCM] Token refreshed:', newToken);
    });

    return token;
  } catch (error) {
    console.error('[FCM] Error getting FCM token:', error?.message, error?.code, error);
    return null;
  }
};

// ─── DE-DUPLICATION ───
// The same chat message can reach us twice: e.g. a notification+data message
// the OS renders itself plus a data twin, or a listener firing more than once.
// Track recently-shown message keys and drop repeats within a short window.
const recentlyShownNotifications = new Map();
const NOTIF_DEDUPE_WINDOW_MS = 10000;

const isDuplicateNotification = (key) => {
  if (!key) return false;
  const now = Date.now();
  for (const [k, ts] of recentlyShownNotifications) {
    if (now - ts > NOTIF_DEDUPE_WINDOW_MS) recentlyShownNotifications.delete(k);
  }
  if (recentlyShownNotifications.has(key)) return true;
  recentlyShownNotifications.set(key, now);
  return false;
};

// ─── SHOW LOCAL NOTIFICATION ───
// Used for foreground messages and data-only background messages
const showLocalNotification = async (remoteMessage) => {
  if (!remoteMessage) return;

  const { notification, data } = remoteMessage;

  // Resolve real content: notification payload first, then the common data keys
  // the backend may use. Without this, a content-bearing data message renders as
  // a generic "New Message".
  const title =
    notification?.title || data?.title || data?.senderName ||
    data?.senderFullName || data?.fullName || data?.name || data?.chatName || '';
  const body =
    notification?.body || data?.body || data?.message || data?.text ||
    data?.messageText || data?.content || '';

  // Contentless payloads (routing-only data) must NOT produce a notification —
  // that is the spurious generic "New Message" duplicate. The real message is
  // shown either by the OS (notification payload) or by a content-bearing one.
  if (!title && !body) return;

  // Drop duplicates of the same message.
  const dedupeKey = String(
    data?.messageId || data?._id || data?.serverMessageId ||
    notification?.tag || (data?.chatId ? `${data.chatId}:${body}` : '')
  );
  if (isDuplicateNotification(dedupeKey)) return;

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: title || 'New Message',
        body,
        data: data || {},
        sound: Platform.OS === 'ios' ? CUSTOM_SOUND_IOS : true,
        ...(Platform.OS === 'android' && { channelId: CHANNEL_ID }),
      },
      trigger: null, // show immediately
    });
  } catch (err) {
    console.error('Error showing local notification:', err);
  }
};

// ─── BACKGROUND MESSAGE HANDLER ───
// MUST be called at top-level (index.js), NOT inside a React component
export const registerBackgroundHandler = () => {
  messaging().setBackgroundMessageHandler(async (remoteMessage) => {
    console.log('Background message received:', JSON.stringify(remoteMessage));

    // If the message is data-only (no "notification" key), we must show it manually
    if (remoteMessage.data && !remoteMessage.notification) {
      await showLocalNotification(remoteMessage);
    }
    // If it has a "notification" key, Android system tray handles it automatically
  });
};

// ─── FOREGROUND LISTENERS ───
// Called inside a React component (App.js) for cleanup on unmount
export const initializeNotifications = () => {
  // Foreground messages — system won't show these automatically, so we do it
  const unsubscribeOnMessage = messaging().onMessage(async (remoteMessage) => {
    console.log('Foreground message received:', JSON.stringify(remoteMessage));
    await showLocalNotification(remoteMessage);
  });

  // App opened from a background notification tap
  const unsubscribeOnOpen = messaging().onNotificationOpenedApp((remoteMessage) => {
    console.log('Notification opened app from background:', remoteMessage?.data);
    // Navigate to chat screen based on remoteMessage.data if needed
  });

  // Check if app was opened from a killed state by a notification
  messaging()
    .getInitialNotification()
    .then((remoteMessage) => {
      if (remoteMessage) {
        console.log('App opened from quit state by notification:', remoteMessage?.data);
        // Navigate to chat screen based on remoteMessage.data if needed
      }
    });

  // iOS action buttons (like Reply)
  const responseListener = Notifications.addNotificationResponseReceivedListener(
    (response) => {
      if (response.actionIdentifier === 'reply') {
        console.log('Reply tapped!', response.notification.request.content.data);
      }
    }
  );

  return () => {
    unsubscribeOnMessage();
    unsubscribeOnOpen();
    responseListener.remove();
  };
};