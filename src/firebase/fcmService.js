import * as Notifications from 'expo-notifications';
import { Platform, PermissionsAndroid, DeviceEventEmitter } from 'react-native';

// Cross-module events the call layer (CallProvider) listens to. A call push,
// once received/tapped, is routed into the live call flow through these.
export const CALL_PUSH_EVENTS = {
  INCOMING: 'call:push:incoming', // show the ringing UI (foreground / tap)
  ACCEPT: 'call:push:accept',     // Accept action / tap → answer
  REJECT: 'call:push:reject',     // Decline action → reject
};
// Notification category that carries the Accept / Decline buttons (WhatsApp-style).
const CALL_CATEGORY_ID = 'incoming_call';

// ─── LAZY, CRASH-SAFE FIREBASE MESSAGING ───
// `@react-native-firebase/messaging` binds to the native RNFBApp module at
// import time. If the current build doesn't include the native module (e.g. an
// older dev build made before Firebase was added, or Expo Go), even importing it
// throws "Native module RNFBAppModule not found" and takes the whole app down.
// So we require it lazily inside try/catch and expose a single accessor that
// returns null when unavailable — every caller then no-ops gracefully and push
// simply stays off until the app is rebuilt with the native module.
let _messaging = null;
let _messagingResolved = false;
const getMessaging = () => {
  if (_messagingResolved) return _messaging;
  _messagingResolved = true;
  try {
    // eslint-disable-next-line global-require
    const mod = require('@react-native-firebase/messaging');
    const factory = mod && (mod.default || mod);
    _messaging = typeof factory === 'function' ? factory : null;
  } catch (err) {
    console.warn('[FCM] native module unavailable — push disabled until rebuild:', err?.message);
    _messaging = null;
  }
  return _messaging;
};
export const isPushAvailable = () => !!getMessaging();

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

// Incoming-call channel — kept stable ('calls') to match the backend push.
const CALL_CHANNEL_ID = 'calls';

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

    // Dedicated high-importance channel for incoming calls. Must match the
    // backend call push `android.notification.channelId` ('calls'). MAX
    // importance + default ringtone-style sound makes the device actually ring.
    await Notifications.setNotificationChannelAsync(CALL_CHANNEL_ID, {
      name: 'Calls',
      description: 'Incoming voice and video calls',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 900, 700, 900],
      sound: 'default',
      lightColor: '#00A884',
      enableLights: true,
      enableVibrate: true,
      showBadge: false,
      bypassDnd: true,
    });
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

// WhatsApp-style incoming-call notification category: Accept (opens the app and
// answers) + Decline (rejects). Registered on BOTH platforms — Android shows the
// buttons on the heads-up we present locally; iOS maps `aps.category` to these.
// Idempotent, so it's safe to call at every boot / foreground.
export const setupCallNotificationCategory = async () => {
  try {
    await Notifications.setNotificationCategoryAsync(CALL_CATEGORY_ID, [
      {
        identifier: 'accept',
        buttonTitle: 'Accept',
        options: { opensAppToForeground: true },
      },
      {
        identifier: 'decline',
        buttonTitle: 'Decline',
        options: { opensAppToForeground: false, isDestructive: true },
      },
    ]);
  } catch (err) {
    console.warn('[FCM] call category setup skipped:', err?.message);
  }
};

// Present the WhatsApp-style heads-up for an incoming call (used for background/
// data-only call pushes). High-importance 'calls' channel + the Accept/Decline
// category so the user can answer right from the notification.
const presentIncomingCallNotification = async (data) => {
  try {
    await setupCallNotificationCategory();
    const isVideo = (data?.callType || data?.media) === 'video';
    const name = data?.callerName || data?.title || 'Incoming call';
    await Notifications.scheduleNotificationAsync({
      content: {
        title: name,
        body: isVideo ? 'Incoming video call' : 'Incoming voice call',
        data: { ...(data || {}), type: 'call' },
        categoryIdentifier: CALL_CATEGORY_ID,
        sound: Platform.OS === 'ios' ? 'default' : true,
        ...(Platform.OS === 'android' && { channelId: CALL_CHANNEL_ID }),
        priority: Notifications.AndroidNotificationPriority?.MAX,
      },
      trigger: null,
    });
  } catch (err) {
    console.warn('[FCM] present incoming-call notification failed:', err?.message);
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

    const m = getMessaging();
    if (!m) {
      console.warn('[FCM] requestNotificationPermission skipped — native module unavailable');
      return false;
    }
    const authStatus = await m().requestPermission();
    console.log('[FCM] messaging.requestPermission authStatus:', authStatus);
    const enabled =
      authStatus === m.AuthorizationStatus.AUTHORIZED ||
      authStatus === m.AuthorizationStatus.PROVISIONAL;

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
  const m = getMessaging();
  if (!m) {
    console.warn('[FCM] getFCMToken skipped — native module unavailable');
    return null;
  }
  const hasPermission = await requestNotificationPermission();
  console.log('[FCM] hasPermission:', hasPermission);
  if (!hasPermission) return null;

  try {
    if (Platform.OS === 'ios') {
      const isRegistered = m().isDeviceRegisteredForRemoteMessages;
      console.log('[FCM] iOS isDeviceRegisteredForRemoteMessages:', isRegistered);
      if (!isRegistered) {
        await m().registerDeviceForRemoteMessages();
        console.log('[FCM] iOS registerDeviceForRemoteMessages done');
      }
      const apns = await m().getAPNSToken();
      console.log('[FCM] APNs token:', apns);
    }

    console.log('[FCM] calling messaging().getToken()...');
    const token = await m().getToken();
    console.log('[FCM] Token:', token);

    m().onTokenRefresh(newToken => {
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

  // Incoming-call pushes are handled separately and must NOT render as a generic
  // chat banner: in the foreground the live call overlay + ringtone take over,
  // and when backgrounded the OS already shows the push on the dedicated 'calls'
  // channel (the backend sends a notification block with channelId 'calls').
  // Presenting another notification here would double-ring and use the wrong
  // channel.
  if (data?.type === 'call') return;

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
  // Guard: this runs at app boot. If the native Firebase module isn't available
  // (e.g. older dev build / Expo Go), never let it crash startup.
  const m = getMessaging();
  if (!m) return;
  try {
    m().setBackgroundMessageHandler(async (remoteMessage) => {
      console.log('Background message received:', JSON.stringify(remoteMessage));

      // Incoming call (data-only, high priority): present our OWN heads-up with
      // Accept / Decline action buttons on the 'calls' channel — WhatsApp-style.
      if (remoteMessage?.data?.type === 'call') {
        await presentIncomingCallNotification(remoteMessage.data);
        return;
      }

      // If the message is data-only (no "notification" key), we must show it manually
      if (remoteMessage.data && !remoteMessage.notification) {
        await showLocalNotification(remoteMessage);
      }
      // If it has a "notification" key, Android system tray handles it automatically
    });
  } catch (err) {
    console.warn('[FCM] registerBackgroundHandler skipped:', err?.message);
  }
};

// ─── FOREGROUND LISTENERS ───
// Called inside a React component (App.js) for cleanup on unmount
export const initializeNotifications = () => {
  // Guard against a missing/misconfigured native Firebase module so the app
  // boot effect can never throw; degrade to a no-op cleanup.
  let unsubscribeOnMessage = () => {};
  let unsubscribeOnOpen = () => {};
  let responseListener = { remove: () => {} };
  const m = getMessaging();
  try {
  if (!m) throw new Error('native module unavailable');
  // Foreground messages — system won't show these automatically, so we do it
  unsubscribeOnMessage = m().onMessage(async (remoteMessage) => {
    console.log('Foreground message received:', JSON.stringify(remoteMessage));
    // A call push in the foreground → drive the live ringing overlay directly
    // (the always-connected app socket usually beats it; this is the wake-up
    // fallback). Never render a banner for it.
    if (remoteMessage?.data?.type === 'call') {
      DeviceEventEmitter.emit(CALL_PUSH_EVENTS.INCOMING, remoteMessage.data);
      return;
    }
    await showLocalNotification(remoteMessage);
  });

  // App opened from a background notification tap (FCM-displayed, e.g. iOS alert)
  unsubscribeOnOpen = m().onNotificationOpenedApp((remoteMessage) => {
    console.log('Notification opened app from background:', remoteMessage?.data);
    if (remoteMessage?.data?.type === 'call') {
      DeviceEventEmitter.emit(CALL_PUSH_EVENTS.INCOMING, remoteMessage.data);
    }
  });

  // Check if app was opened from a killed state by a notification
  m()
    .getInitialNotification()
    .then((remoteMessage) => {
      if (remoteMessage) {
        console.log('App opened from quit state by notification:', remoteMessage?.data);
        if (remoteMessage?.data?.type === 'call') {
          // Give the providers a beat to mount before showing the ring.
          setTimeout(() => DeviceEventEmitter.emit(CALL_PUSH_EVENTS.INCOMING, remoteMessage.data), 400);
        }
      }
    });

  // Notification responses: the Accept / Decline buttons on the call heads-up,
  // plus the iOS chat Reply action. The call notification is one we present
  // locally (Android) or the OS shows from `aps.category` (iOS) — either way the
  // response lands here.
  responseListener = Notifications.addNotificationResponseReceivedListener(
    (response) => {
      const data = response?.notification?.request?.content?.data || {};
      const action = response.actionIdentifier;
      if (data?.type === 'call') {
        if (action === 'decline') {
          DeviceEventEmitter.emit(CALL_PUSH_EVENTS.REJECT, data);
        } else {
          // 'accept' button OR a plain tap on the notification → answer/show.
          DeviceEventEmitter.emit(CALL_PUSH_EVENTS.ACCEPT, data);
        }
        Notifications.dismissNotificationAsync(response.notification.request.identifier).catch(() => {});
        return;
      }
      if (action === 'reply') {
        console.log('Reply tapped!', data);
      }
    }
  );
  } catch (err) {
    console.warn('[FCM] initializeNotifications skipped:', err?.message);
  }

  return () => {
    try { unsubscribeOnMessage(); } catch (_) {}
    try { unsubscribeOnOpen(); } catch (_) {}
    try { responseListener.remove(); } catch (_) {}
  };
};