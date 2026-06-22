import * as Notifications from 'expo-notifications';
import { Platform, PermissionsAndroid, DeviceEventEmitter } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isGroupInactive } from '../utils/inactiveGroups';
import { setPushToken } from '../Redux/Services/Socket/socket';
import { navigateToChat } from '../Redux/Services/navigationService';
import { CALL_PUSH_EVENTS } from './callEvents';
import { displayIncomingCallNotifee, isNotifeeCallAvailable } from './callNotifee';
import { displayGroupedMessage, isMessageGroupingAvailable, clearMessageNotification } from './messageNotification';
import { buildNotificationModel } from './notificationModel';
import { claimNotification } from './notificationDedupe';
// Guarantees the Firebase [DEFAULT] app exists before any messaging() call.
// Without this, a build whose native auto-init didn't run throws
// "No Firebase App '[DEFAULT]' has been created" on the first messaging() use.
import { ensureFirebaseApp } from './config';

// Cross-module events the call layer (CallProvider) listens to. Defined in
// ./callEvents and re-exported here for back-compat with existing importers.
export { CALL_PUSH_EVENTS };
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
    // Make sure the [DEFAULT] app is initialized BEFORE messaging() is resolved
    // — messaging() reaches into the default app and throws if it doesn't exist.
    ensureFirebaseApp();
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

    // console.log(`Notification channel "${CHANNEL_ID}" created with sound: ${CUSTOM_SOUND_ANDROID}`);

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
    // console.log('[FCM] requestNotificationPermission start, platform:', Platform.OS, 'version:', Platform.Version);

    if (Platform.OS === 'android' && Platform.Version >= 33) {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
      );
      // console.log('[FCM] POST_NOTIFICATIONS result:', granted);
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
    // console.log('[FCM] messaging.requestPermission authStatus:', authStatus);
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
  // console.log('[FCM] getFCMToken called');
  const m = getMessaging();
  if (!m) {
    console.warn('[FCM] getFCMToken skipped — native module unavailable');
    return null;
  }
  const hasPermission = await requestNotificationPermission();
  // console.log('[FCM] hasPermission:', hasPermission);
  if (!hasPermission) return null;

  try {
    if (Platform.OS === 'ios') {
      const isRegistered = m().isDeviceRegisteredForRemoteMessages;
      // console.log('[FCM] iOS isDeviceRegisteredForRemoteMessages:', isRegistered);
      if (!isRegistered) {
        await m().registerDeviceForRemoteMessages();
        // console.log('[FCM] iOS registerDeviceForRemoteMessages done');
      }
      const apns = await m().getAPNSToken();
      // console.log('[FCM] APNs token:', apns);
    }

    // console.log('[FCM] calling messaging().getToken()...');
    const token = await m().getToken();
    // console.log('[FCM] Token:', token);

    // A rotated token (new install, app data clear, FCM refresh) must be pushed
    // to the backend or call/message notifications go to a dead token and never
    // arrive. Re-register it over the socket + persist it. (A fresh build install
    // ALSO rotates the token — the most common reason background calls stop
    // notifying after `expo run:android` until the device re-registers/relogs.)
    m().onTokenRefresh((newToken) => {
      // console.log('[FCM] Token refreshed → re-registering:', newToken);
      try { setPushToken(newToken); } catch (_) {}
      AsyncStorage.setItem('fcmToken', newToken).catch(() => {});
    });

    return token;
  } catch (error) {
    console.error('[FCM] Error getting FCM token:', error?.message, error?.code, error);
    return null;
  }
};

// ─── DE-DUPLICATION ───
// Dedupe is now CROSS-PATH (shared with the in-app banner) and keyed on
// messageId — see firebase/notificationDedupe.js. The old per-file 10s map only
// deduped this OS path against itself, so a message that arrived as BOTH a socket
// banner and a push double-notified. `claimNotification` is the shared guard.

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

  // Suppress message notifications for groups the user has left or been removed
  // from — an ex-member must not keep getting pinged. Checks groupId (and chatId,
  // which equals the group id for group chats) against the inactive registry.
  const notifGroupId = data?.groupId || (data?.chatType === 'group' ? data?.chatId : null);
  if (notifGroupId && (await isGroupInactive(notifGroupId))) return;

  // Resolve content through the SHARED notification builder so the OS push and
  // the in-app banner derive title/body/preview from one source (identical text).
  const model = buildNotificationModel(remoteMessage);

  // Contentless / routing-only payloads (no chat to attribute, or no preview)
  // must NOT produce a notification — that is the spurious generic "New Message"
  // duplicate. The real message is shown either by the OS (notification payload)
  // or by a content-bearing one.
  if (!model || (!model.title && !model.body)) return;

  // Drop duplicates of the same message — SHARED with the in-app banner, so a
  // message delivered over both the socket and a push notifies the user once.
  // Prefer the stable messageId; fall back to a content key only when absent.
  const dedupeKey = String(
    model.messageId || data?.serverMessageId ||
    notification?.tag || (model.chatId ? `${model.chatId}:${model.body}` : '')
  );
  if (!claimNotification(dedupeKey)) return;

  // Android: render a WhatsApp-style MessagingStyle notification that ACCUMULATES
  // the recent messages per chat into one conversation thread (instead of each
  // message replacing the last). Needs a chatId. Falls through to the plain expo
  // notification if grouping isn't available or has no chatId.
  if (isMessageGroupingAvailable() && model.chatId) {
    // console.log('[FCM][msg] grouping message via MessagingStyle', { chatId: model.chatId });
    const shown = await displayGroupedMessage(model);
    if (shown) return;
  }

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: model.title || 'New Message',
        body: model.body,
        data: data || {},
        sound: Platform.OS === 'ios' ? CUSTOM_SOUND_IOS : true,
        // iOS: group this chat's notifications in the tray (WhatsApp-style). The
        // backend sets the same `thread-id` on the APNs alert for background/
        // killed pushes; this covers the foreground/expo-rendered path.
        ...(Platform.OS === 'ios' && model.threadId
          ? { threadIdentifier: String(model.threadId) }
          : {}),
        ...(Platform.OS === 'android' && { channelId: CHANNEL_ID }),
      },
      trigger: null, // show immediately
    });
  } catch (err) {
    console.error('Error showing local notification:', err);
  }
};

// ─── CLEAR A CHAT'S NOTIFICATIONS ON READ ───
// Called when the user opens/reads a chat so its notifications disappear from the
// shade (WhatsApp-style). Android: cancel the per-chat MessagingStyle notification
// + its accumulated thread (and the group summary if it was the last one). iOS:
// dismiss any presented notifications belonging to this chat (matched by data
// chatId or the per-chat threadIdentifier).
export const clearChatNotifications = async (chatId) => {
  if (!chatId) return;
  try { await clearMessageNotification(chatId); } catch (_) { /* */ }
  if (Platform.OS === 'ios') {
    try {
      const presented = await Notifications.getPresentedNotificationsAsync();
      for (const n of presented || []) {
        const content = n?.request?.content || {};
        const d = content?.data || {};
        const tid = content?.threadIdentifier;
        if (String(d.chatId || '') === String(chatId) || String(tid || '') === String(chatId)) {
          await Notifications.dismissNotificationAsync(n.request.identifier).catch(() => {});
        }
      }
    } catch (_) { /* */ }
  }
};

// ─── BACKGROUND MESSAGE HANDLER ───
// MUST be called at top-level (index.js), NOT inside a React component
// True only when a user session exists in storage. Logout runs AsyncStorage.clear()
// (removing accessToken + deviceId), so this flips to false the instant the user
// logs out — letting the push handlers DROP any call/message push that still
// arrives (e.g. before the backend deregisters this device's token), so a
// logged-out device never rings for a call or shows a chat notification.
const hasActiveSession = async () => {
  try {
    const [accessToken, deviceId] = await Promise.all([
      AsyncStorage.getItem('accessToken'),
      AsyncStorage.getItem('deviceId'),
    ]);
    return !!(accessToken && deviceId);
  } catch (_) {
    return false;
  }
};

export const registerBackgroundHandler = () => {
  // Guard: this runs at app boot. If the native Firebase module isn't available
  // (e.g. older dev build / Expo Go), never let it crash startup.
  const m = getMessaging();
  if (!m) return;
  try {
    m().setBackgroundMessageHandler(async (remoteMessage) => {
      // console.log('Background message received:', JSON.stringify(remoteMessage));

      // Logged out → never ring or notify. Drops calls + messages that arrive
      // before the backend deregisters this device's push/voip token.
      if (!(await hasActiveSession())) return;

      // Incoming call (data-only, high priority). On Android show a notifee
      // FULL-SCREEN-INTENT notification → launches the app's full-screen call UI
      // over the lock screen (WhatsApp-style). On iOS (no full-screen intent)
      // fall back to the expo-notifications heads-up with Accept/Decline. If the
      // notifee path errors for any reason, fall back to the proven expo heads-up
      // so the user ALWAYS gets a ringing notification.
      if (remoteMessage?.data?.type === 'call') {
        // console.log('[FCM][bg] incoming-call push received', JSON.stringify(remoteMessage.data));
        try {
          if (isNotifeeCallAvailable()) {
            await displayIncomingCallNotifee(remoteMessage.data);
          } else {
            await presentIncomingCallNotification(remoteMessage.data);
          }
        } catch (err) {
          console.warn('[FCM][bg] full-screen call notif failed — falling back to heads-up:', err?.message);
          try { await presentIncomingCallNotification(remoteMessage.data); } catch (_) {}
        }
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
  let notifeeForegroundUnsub = () => {};
  const m = getMessaging();
  try {
  if (!m) throw new Error('native module unavailable');
  // Foreground messages — system won't show these automatically, so we do it
  unsubscribeOnMessage = m().onMessage(async (remoteMessage) => {
    // console.log('Foreground message received:', JSON.stringify(remoteMessage));
    // Logged out → ignore any push that still lands (calls + messages).
    if (!(await hasActiveSession())) return;
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
    // console.log('Notification opened app from background:', remoteMessage?.data);
    const data = remoteMessage?.data || {};
    if (data.type === 'call') {
      DeviceEventEmitter.emit(CALL_PUSH_EVENTS.INCOMING, data);
    } else if (data.chatId || data.groupId) {
      // Message notification tapped → open that chat's thread.
      navigateToChat(data);
    }
  });

  // Check if app was opened from a killed state by a notification
  m()
    .getInitialNotification()
    .then((remoteMessage) => {
      if (remoteMessage) {
        // console.log('App opened from quit state by notification:', remoteMessage?.data);
        const data = remoteMessage?.data || {};
        if (data.type === 'call') {
          // Give the providers a beat to mount before showing the ring.
          setTimeout(() => DeviceEventEmitter.emit(CALL_PUSH_EVENTS.INCOMING, data), 400);
        } else if (data.chatId || data.groupId) {
          // Cold launch from a message-notification tap → open the chat once the
          // nav container is ready (navigateToChat retries until then).
          navigateToChat(data);
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
        // console.log('Reply tapped!', data);
        return;
      }
      // Any other tap (the default body tap) on a message notification → open
      // the chat thread.
      if (data?.chatId || data?.groupId) {
        navigateToChat(data);
      }
    }
  );

  // Android notifee MessagingStyle taps: FOREGROUND + COLD-START. (Background
  // taps go through callNotifee's single onBackgroundEvent.) These are needed
  // because notifee-displayed notifications report via notifee's own event +
  // getInitialNotification, NOT the expo/FCM listeners above.
  try {
    const notifeeMod = require('@notifee/react-native');
    const notifee = notifeeMod.default || notifeeMod;
    const EventType = notifeeMod.EventType;
    if (notifee && EventType) {
      notifeeForegroundUnsub = notifee.onForegroundEvent(({ type, detail }) => {
        const d = detail?.notification?.data || {};
        if (type === EventType.PRESS && d.type !== 'call' && (d.chatId || d.groupId)) {
          navigateToChat(d);
        }
      });
      // Cold launch from a notifee message notification (data-only push → FCM's
      // getInitialNotification won't carry it; notifee's does).
      notifee.getInitialNotification().then((initial) => {
        const d = initial?.notification?.data || {};
        if (d && d.type !== 'call' && (d.chatId || d.groupId)) navigateToChat(d);
      }).catch(() => {});
    }
  } catch (_) { /* notifee not in build */ }
  } catch (err) {
    console.warn('[FCM] initializeNotifications skipped:', err?.message);
  }

  return () => {
    try { unsubscribeOnMessage(); } catch (_) {}
    try { unsubscribeOnOpen(); } catch (_) {}
    try { responseListener.remove(); } catch (_) {}
    try { notifeeForegroundUnsub(); } catch (_) {}
  };
};