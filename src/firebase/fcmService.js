import * as Notifications from 'expo-notifications';
import { Platform, PermissionsAndroid, DeviceEventEmitter, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isGroupInactive } from '../utils/inactiveGroups';
import { setPushToken } from '../Redux/Services/Socket/socket';
import { navigateToChat, getCurrentRouteSnapshot, getActiveChatFromRoute } from '../Redux/Services/navigationService';
import { CALL_PUSH_EVENTS, isStaleCallPush } from './callEvents';
import { displayIncomingCallNotifee, cancelIncomingCallNotifee, isNotifeeCallAvailable, displayMissedCallNotification } from './callNotifee';
import { isAvailable as isNativeCallKitAvailable } from '../calls/services/nativeCallService';
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
// onTokenRefresh must be bound exactly once across all getFCMToken() calls.
let _refreshListenerBound = false;
// Single AppState listener that re-drives token acquisition once the app is
// truly foregrounded (see ensureFcmTokenOnForeground).
let _fgTokenSub = null;
const getMessaging = () => {
  if (_messagingResolved) return _messaging;
  _messagingResolved = true;
  try {
    // Make sure the [DEFAULT] app is initialized BEFORE messaging is resolved
    // — resolving reaches into the default app and throws if it doesn't exist.
    ensureFirebaseApp();
    // eslint-disable-next-line global-require
    const mod = require('@react-native-firebase/messaging');
    if (typeof mod.getMessaging === 'function') {
      // v22+ modular API. RNFirebase deprecated the namespaced surface
      // (calling `messaging()` / its methods logs a deprecation warning on
      // every boot and it's removed in the next major). Wrap the modular
      // functions in a shim with the familiar namespaced method names so all
      // existing `m().xyz()` call sites work unchanged, warning-free.
      const inst = mod.getMessaging();
      const shim = {
        hasPermission: () => mod.hasPermission(inst),
        requestPermission: () => mod.requestPermission(inst),
        onTokenRefresh: (listener) => mod.onTokenRefresh(inst, listener),
        get isDeviceRegisteredForRemoteMessages() {
          return mod.isDeviceRegisteredForRemoteMessages(inst);
        },
        registerDeviceForRemoteMessages: () => mod.registerDeviceForRemoteMessages(inst),
        getAPNSToken: () => mod.getAPNSToken(inst),
        getToken: () => mod.getToken(inst),
        setBackgroundMessageHandler: (handler) => mod.setBackgroundMessageHandler(inst, handler),
        onMessage: (listener) => mod.onMessage(inst, listener),
        onNotificationOpenedApp: (listener) => mod.onNotificationOpenedApp(inst, listener),
        getInitialNotification: () => mod.getInitialNotification(inst),
      };
      _messaging = () => shim;
      // Statics read off the accessor itself (m.AuthorizationStatus).
      _messaging.AuthorizationStatus = mod.AuthorizationStatus;
    } else {
      // Older RNFirebase without the modular API — keep the namespaced factory.
      const factory = mod && (mod.default || mod);
      _messaging = typeof factory === 'function' ? factory : null;
    }
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
const MISSED_CALL_CHANNEL_ID = 'missed_calls';

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
      lightColor: '#03b0a2',
      enableLights: true,
      enableVibrate: true,
      showBadge: false,
      bypassDnd: true,
    });

    // Dismissible "Missed call" channel (DEFAULT importance — informational, not a
    // ringing channel). Used by the expo fallback path of displayMissedCallNotification
    // and must match the backend `call-missed` push channelId ('missed_calls').
    await Notifications.setNotificationChannelAsync(MISSED_CALL_CHANNEL_ID, {
      name: 'Missed Calls',
      description: 'Missed voice and video calls',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 250],
      lightColor: '#03b0a2',
      enableLights: true,
      enableVibrate: true,
      showBadge: true,
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
  // iOS: skip this heads-up ONLY when CallKit is actually the ring UI (a VoIP push
  // already drew the native CallKit screen) — otherwise this expo-notifications
  // banner is a DUPLICATE sitting under the CallKit UI. But when CallKit is
  // DISABLED (IOS_CALLKIT_ENABLED=false, e.g. because of the WebView-WebRTC audio
  // conflict), this heads-up is the ONLY iOS incoming ring, so it MUST show —
  // tapping it opens the app and the in-app UI + WebView audio take over.
  // Gate on the live CallKit availability, not a blanket Platform check.
  if (Platform.OS === 'ios' && isNativeCallKitAvailable()) return;
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

// Dismiss the incoming-call notification on BOTH backends: the Android CallStyle
// (ExpoCallUi / notifee, via cancelIncomingCallNotifee) AND the iOS expo-
// notifications heads-up (which cancelIncomingCallNotifee does NOT cover, since
// iOS presents the call via scheduleNotificationAsync, not notifee). Used by the
// `call_cancel` push so the caller hanging up clears the callee's notification on
// both platforms.
const dismissIncomingCallNotification = async (callId) => {
  try { await cancelIncomingCallNotifee(callId); } catch (_) { /* android backend */ }
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    await Promise.all((presented || [])
      .filter((n) => {
        const d = n?.request?.content?.data || {};
        return d.type === 'call' && (!callId || String(d.callId) === String(callId));
      })
      .map((n) => Notifications.dismissNotificationAsync(n.request.identifier).catch(() => {})));
  } catch (_) { /* expo-notifications backend (iOS heads-up) */ }
};

// Request permission for notifications.
//
// The interactive prompts (`PermissionsAndroid.request` and
// `messaging().requestPermission()`) require a foreground Activity. When this
// runs from a background/headless context — a background FCM message, a boot
// task, or simply before the Activity has attached — Android throws
// `IllegalStateException: Tried to use permissions API while not attached to an
// Activity.` So we:
//   1) read the CURRENT status non-interactively (never needs an Activity), and
//      short-circuit as granted if it already is; then
//   2) only fire the interactive prompt when the app is actually in the
//      foreground. Off-foreground we return the current status instead of
//      throwing, and the next foreground boot re-runs this and prompts.
export const requestNotificationPermission = async () => {
  try {
    // console.log('[FCM] requestNotificationPermission start, platform:', Platform.OS, 'version:', Platform.Version);
    const m = getMessaging();
    if (!m) {
      console.warn('[FCM] requestNotificationPermission skipped — native module unavailable');
      return false;
    }

    // An interactive prompt is only safe while an Activity is attached, i.e. the
    // app is in the foreground.
    const isForeground = AppState.currentState === 'active';

    // ── Android 13+ POST_NOTIFICATIONS ──
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      // check() is passive — safe from any context.
      const alreadyGranted = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
      );
      if (!alreadyGranted) {
        // Can't prompt without an Activity — defer to the next foreground boot.
        if (!isForeground) {
          console.warn('[FCM] POST_NOTIFICATIONS not granted; deferring prompt (no foreground Activity)');
          return false;
        }
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
        );
        // console.log('[FCM] POST_NOTIFICATIONS result:', granted);
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          console.warn('[FCM] POST_NOTIFICATIONS permission denied');
          return false;
        }
      }
    }

    // ── Firebase messaging auth status ──
    // hasPermission() is passive; use it to avoid the interactive prompt when
    // we're already authorized (or can't prompt).
    const current = await m().hasPermission();
    const isEnabled = (status) =>
      status === m.AuthorizationStatus.AUTHORIZED ||
      status === m.AuthorizationStatus.PROVISIONAL;

    if (isEnabled(current)) return true;

    // NOT_DETERMINED (or denied) and we can't safely prompt off-foreground.
    if (!isForeground) {
      console.warn('[FCM] messaging permission not yet granted; deferring prompt (no foreground Activity)');
      return false;
    }

    const authStatus = await m().requestPermission();
    // console.log('[FCM] messaging.requestPermission authStatus:', authStatus);
    const enabled = isEnabled(authStatus);
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
  // Ask for display permission, but NEVER let a missing/denied permission block
  // TOKEN registration: getToken() doesn't need POST_NOTIFICATIONS — that
  // permission only gates DISPLAYING banners. Bailing out here left the backend
  // with no token at all for this device (push lookup finds devices:0 → messages
  // AND call wakes dead), and it stayed dead even after the user later granted
  // the permission in Settings. Fetching + registering anyway means data pushes
  // (call wake, sync) keep arriving, and banners light up the moment the
  // permission is granted — no re-login needed.
  const hasPermission = await requestNotificationPermission();
  if (!hasPermission) {
    console.warn('[FCM] notification permission not granted — fetching token anyway (banners hidden until granted)');
  }

  // Register the refresh listener UP FRONT — before the (retryable) getToken
  // call. A rotated token (new install, app data clear, FCM refresh) must be
  // pushed to the backend or call/message notifications go to a dead token and
  // never arrive. Wiring it here (not after getToken succeeds) means that even if
  // the initial getToken fails transiently, the moment Play Services recovers and
  // FCM hands us a token via refresh, we still capture + re-register it.
  // (A fresh build install ALSO rotates the token — the most common reason
  // background calls stop notifying after `expo run:android` until re-register.)
  // Bind the refresh listener only ONCE. getFCMToken can now be re-invoked
  // (e.g. by the foreground re-trigger below when the first boot deferred the
  // permission prompt), and stacking a fresh onTokenRefresh handler on every
  // call would multi-register + multi-persist the same token.
  if (!_refreshListenerBound) {
    try {
      m().onTokenRefresh((newToken) => {
        // console.log('[FCM] Token refreshed → re-registering:', newToken);
        _persistToken(newToken);
        // If recovery was running and FCM finally delivered a token via refresh,
        // we no longer need to poll.
        if (newToken) _stopTokenRecovery();
      });
      _refreshListenerBound = true;
    } catch (_) {}
  }

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

    // getToken() commonly throws a TRANSIENT `SERVICE_NOT_AVAILABLE` /
    // `messaging/unknown` IOException right after a fresh install or on a flaky
    // network (esp. MIUI/Xiaomi, where Play Services takes a moment to register
    // the new app with FCM). It succeeds on a short retry. Without this loop the
    // first failure returned null → push stayed dead until the next login.
    const token = await _getTokenWithRetry(m);
    // console.log('[FCM] Token:', token);
    if (token) {
      _persistToken(token);
      _stopTokenRecovery(); // a previous failed boot may have left it running
    }
    return token;
  } catch (error) {
    console.error('[FCM] Error getting FCM token:', error?.message, error?.code, error);
    // The boot-time retries (~11s) weren't enough for Play Services to come up
    // on this device. Keep trying in the background — on a timer, on app
    // foreground, and on network reconnect — until FCM finally hands us a token,
    // then register it with the backend. Without this, a token-less boot stays
    // token-less (and SERVICE_NOT_AVAILABLE also suppresses onTokenRefresh, so
    // nothing else recaptures it) until the next manual restart/login.
    if (_isTransientFcmError(error)) _startTokenRecovery(m);
    return null;
  }
};

// Persist + re-register a freshly obtained token. Shared by the boot path,
// onTokenRefresh, and the background recovery loop so they all converge on the
// same "store it + tell the backend" behaviour.
const _persistToken = (token) => {
  if (!token) return;
  // ── TEMPORARY (production push debugging) — REMOVE AFTER VERIFICATION ──
  // Deliberately NOT __DEV__-gated: prints the full FCM token in RELEASE
  // builds so it can be grabbed from `adb logcat -s ReactNativeJS:I | grep
  // FCM-TOKEN` and pasted into Firebase Console → Messaging → "Send test
  // message" to prove the app/Firebase side end-to-end. The token is not a
  // secret (it's device-addressing data), but this log is still noise —
  // delete this block once production push is confirmed working.
  console.log('══════════ [FCM-TOKEN] ══════════');
  console.log('[FCM-TOKEN]', token);
  console.log('═════════════════════════════════');
  try { setPushToken(token); } catch (_) {}
  AsyncStorage.setItem('fcmToken', token).catch(() => {});
};

// ─── FOREGROUND RE-TRIGGER ───
// The very first getFCMToken() runs from App.js's mount effect. On a cold start
// the Android Activity may not be attached yet, so AppState.currentState isn't
// 'active' — requestNotificationPermission() then DEFERS the interactive prompt
// (it can't legally show without a foreground Activity) and returns false, so no
// permission dialog appears and the token stays null with nothing to retry it.
//
// This installs a single AppState listener that re-drives getFCMToken() the
// moment the app is genuinely foregrounded — which is exactly when the OS lets
// us show the POST_NOTIFICATIONS / messaging permission prompt. It self-removes
// as soon as a token is obtained (or if push is unavailable). Idempotent: only
// one listener is ever registered.
export const ensureFcmTokenOnForeground = () => {
  if (_fgTokenSub) return; // already watching
  if (!getMessaging()) return; // native module absent → nothing to retry

  const tryAcquire = async () => {
    // Already have one from a previous attempt/login? Stop watching.
    const existing = await AsyncStorage.getItem('fcmToken').catch(() => null);
    if (existing) { _teardownFgTokenWatch(); return; }
    const token = await getFCMToken();
    if (token) _teardownFgTokenWatch();
  };

  try {
    _fgTokenSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') tryAcquire();
    });
  } catch (_) { _fgTokenSub = null; return; }

  // If we're already in the foreground right now, don't wait for the next
  // transition — attempt immediately (the boot deferral means the prompt never
  // fired, but the Activity is attached now).
  if (AppState.currentState === 'active') tryAcquire();
};

const _teardownFgTokenWatch = () => {
  try { _fgTokenSub?.remove?.(); } catch (_) {}
  _fgTokenSub = null;
};

// ─── PERSISTENT TOKEN RECOVERY ───
// Boot-time _getTokenWithRetry only covers ~11s. On devices where Play Services
// takes longer to complete FCM/FIS registration (MIUI, Nothing OS, fresh
// installs, flaky networks) that window expires and getToken stays null. This
// loop keeps retrying past boot until success: a capped-backoff timer PLUS
// event triggers (app returns to foreground, network reconnects) that often
// coincide with Play Services recovering. Idempotent + self-terminating.
let _recoveryActive = false;
let _recoveryTimer = null;
let _recoveryAttempts = 0;
let _recoveryAppStateSub = null;
let _recoveryNetUnsub = null;
let _recoveryInFlight = false;
// Backoff schedule (ms), capped — then repeats at the last value. ~15s→30s→60s
// then every 2min. Stop after enough tries (~20min) to avoid an endless loop on
// a device that will never register (e.g. no Google account / Play Services).
const _RECOVERY_DELAYS = [15000, 30000, 60000, 120000];
const _RECOVERY_MAX_ATTEMPTS = 15;

const _stopTokenRecovery = () => {
  _recoveryActive = false;
  if (_recoveryTimer) { clearTimeout(_recoveryTimer); _recoveryTimer = null; }
  try { _recoveryAppStateSub?.remove?.(); } catch (_) {}
  _recoveryAppStateSub = null;
  try { _recoveryNetUnsub?.(); } catch (_) {}
  _recoveryNetUnsub = null;
};

const _attemptRecovery = async (m, fromTrigger = false) => {
  if (!_recoveryActive || _recoveryInFlight) return;
  _recoveryInFlight = true;
  try {
    const token = await m().getToken();
    if (token) {
      // console.log('[FCM] recovery succeeded — token captured');
      _persistToken(token);
      _stopTokenRecovery();
      return;
    }
  } catch (err) {
    if (!_isTransientFcmError(err)) {
      // A non-transient error (e.g. AUTHENTICATION_FAILED) won't fix itself by
      // retrying — stop rather than spin forever.
      console.warn('[FCM] recovery stopped on non-transient error:', err?.code || err?.message);
      _stopTokenRecovery();
      return;
    }
    // transient → fall through and let the timer schedule the next attempt
  } finally {
    _recoveryInFlight = false;
  }
  // An event-triggered attempt (foreground/reconnect) doesn't consume the timer
  // budget — only the scheduled ticks count toward the cap.
  if (!fromTrigger) _scheduleRecovery(m);
};

const _scheduleRecovery = (m) => {
  if (!_recoveryActive) return;
  if (_recoveryAttempts >= _RECOVERY_MAX_ATTEMPTS) {
    console.warn('[FCM] token recovery gave up after max attempts — Play Services never registered this device');
    _stopTokenRecovery();
    return;
  }
  const delay = _RECOVERY_DELAYS[Math.min(_recoveryAttempts, _RECOVERY_DELAYS.length - 1)];
  _recoveryAttempts += 1;
  if (_recoveryTimer) clearTimeout(_recoveryTimer);
  _recoveryTimer = setTimeout(() => { _attemptRecovery(m, false); }, delay);
};

const _startTokenRecovery = (m) => {
  if (_recoveryActive || !m) return;
  _recoveryActive = true;
  _recoveryAttempts = 0;
  console.warn('[FCM] starting background token recovery (Play Services not ready at boot)');

  // Trigger 1: app returns to the foreground — Play Services often recovers
  // while the user is away, and a foreground transition is a cheap moment to retry.
  try {
    _recoveryAppStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') _attemptRecovery(m, true);
    });
  } catch (_) {}

  // Trigger 2: network regained — SERVICE_NOT_AVAILABLE is frequently a
  // check-in/connectivity gap, so a reconnect is a strong signal to retry now.
  try {
    // eslint-disable-next-line global-require
    const NetInfo = require('@react-native-community/netinfo').default;
    _recoveryNetUnsub = NetInfo.addEventListener((s) => {
      if (s?.isConnected) _attemptRecovery(m, true);
    });
  } catch (_) { /* netinfo optional */ }

  // Kick off the first scheduled attempt.
  _scheduleRecovery(m);
};

// Transient FCM backend errors that clear on retry. `messaging/unknown` wraps a
// java IOException (SERVICE_NOT_AVAILABLE / TIMEOUT) from Play Services; a bare
// AUTHENTICATION_FAILED is NOT transient, so it's deliberately excluded.
const _isTransientFcmError = (err) => {
  const s = `${err?.code || ''} ${err?.message || ''}`.toUpperCase();
  return (
    s.includes('SERVICE_NOT_AVAILABLE') ||
    s.includes('MESSAGING/UNKNOWN') ||
    s.includes('TIMEOUT') ||
    s.includes('IOEXCEPTION') ||
    s.includes('UNAVAILABLE')
  );
};

const _getTokenWithRetry = async (m, attempts = 4) => {
  let lastErr = null;
  // Backoff: ~1s, 3s, 7s — gives Play Services time to come up after a fresh install.
  const delays = [1000, 3000, 7000];
  for (let i = 0; i < attempts; i++) {
    try {
      return await m().getToken();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1 && _isTransientFcmError(err)) {
        console.warn(`[FCM] getToken transient failure (${err?.code || err?.message}); retry ${i + 1}/${attempts - 1}`);
        await new Promise((r) => setTimeout(r, delays[Math.min(i, delays.length - 1)]));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
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

  // Never raise an OS notification for the chat the user is actively viewing.
  // The in-app banner has this guard (AppBannerHost.shouldSuppressForActiveRoute);
  // this path relied on losing the shared-dedupe race to it — timing-dependent,
  // so a push processed first showed a heads-up over the very chat being read.
  // Foreground only: in the background the route snapshot is stale and the user
  // can't be "viewing" anything.
  try {
    if (AppState.currentState === 'active') {
      const active = getActiveChatFromRoute(getCurrentRouteSnapshot());
      if (active?.routeName === 'ChatScreen') {
        const ac = active.chatId ? String(active.chatId) : '';
        const itemChatId = model.chatId ? String(model.chatId) : (data?.chatId ? String(data.chatId) : '');
        const itemGroupId = data?.groupId ? String(data.groupId) : '';
        const itemSenderId = data?.senderId ? String(data.senderId) : '';
        if (
          (ac && itemChatId && ac === itemChatId) ||
          (ac && itemGroupId && ac === itemGroupId) ||
          (!ac && active.peerUserId && itemSenderId && String(active.peerUserId) === itemSenderId)
        ) {
          return;
        }
      }
    }
  } catch {}

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
    // accessToken is the single source of truth for "logged in" (logout's
    // AsyncStorage.clear() removes it). Do NOT also require deviceId — the backend
    // login response doesn't always store one, so requiring it would wrongly drop
    // real calls/messages while logged in (screen wakes but no call UI shows).
    const accessToken = await AsyncStorage.getItem('accessToken');
    return !!accessToken;
  } catch (_) {
    // Fail OPEN for calls/messages — better to show a call than to miss one.
    return true;
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
      // Caller hung up / ring timed out → dismiss the incoming-call notification
      // (a killed/backgrounded callee never got the call:cancelled socket event,
      // so without this the ringing notification lingers / arrives for a dead call).
      if (remoteMessage?.data?.type === 'call_cancel') {
        await dismissIncomingCallNotification(remoteMessage.data.callId);
        return;
      }

      // Missed-call push (server source-of-truth: caller cancelled / ring timed out
      // / callee offline-or-killed). Leave a dismissible "Missed call" notification.
      // De-duped per call id inside displayMissedCallNotification, so if the live app
      // already posted one (call rang then went unanswered), this is a no-op.
      if (remoteMessage?.data?.type === 'call-missed') {
        try { await displayMissedCallNotification(remoteMessage.data); } catch (_) {}
        return;
      }

      if (remoteMessage?.data?.type === 'call') {
        // console.log('[FCM][bg] incoming-call push received', JSON.stringify(remoteMessage.data));
        // Drop a buffered/late-flushed call push (Doze / force-stopped OEM holds
        // the high-priority message, then delivers a burst when the device wakes).
        // The call is long over — showing it would ring a ghost and a backlog
        // would ring many at once.
        if (isStaleCallPush(remoteMessage.data)) {
          return;
        }
        try {
          // displayIncomingCallNotifee returns false when BOTH the native
          // CallStyle and the notifee paths failed/were unavailable (it swallows
          // their errors internally), so a falsy return — not just a throw — must
          // trigger the expo heads-up fallback. Otherwise a silent notifee
          // failure left the killed app showing nothing ("notification nahi aaya").
          const shown = isNotifeeCallAvailable()
            ? await displayIncomingCallNotifee(remoteMessage.data)
            : false;
          if (!shown) {
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
    // Caller hung up / timed out → dismiss the incoming-call notification.
    if (remoteMessage?.data?.type === 'call_cancel') {
      dismissIncomingCallNotification(remoteMessage.data.callId).catch(() => {});
      return;
    }
    // A call push in the foreground → drive the live ringing overlay directly
    // (the always-connected app socket usually beats it; this is the wake-up
    // fallback). Never render a banner for it.
    if (remoteMessage?.data?.type === 'call') {
      DeviceEventEmitter.emit(CALL_PUSH_EVENTS.INCOMING, remoteMessage.data);
      return;
    }
    // Missed-call push while foreground. The live call layer usually already
    // classified + notified locally (deduped), but if this call never rang on this
    // device the push is the only signal — surface the missed notification.
    if (remoteMessage?.data?.type === 'call-missed') {
      await displayMissedCallNotification(remoteMessage.data);
      return;
    }
    await showLocalNotification(remoteMessage);
  });

  // App opened from a background notification tap (FCM-displayed, e.g. iOS alert)
  unsubscribeOnOpen = m().onNotificationOpenedApp((remoteMessage) => {
    // console.log('Notification opened app from background:', remoteMessage?.data);
    const data = remoteMessage?.data || {};
    if (data.type === 'call') {
      DeviceEventEmitter.emit(CALL_PUSH_EVENTS.INCOMING, { ...data, _fullScreen: true });
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
          setTimeout(() => DeviceEventEmitter.emit(CALL_PUSH_EVENTS.INCOMING, { ...data, _fullScreen: true }), 400);
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
        } else if (action === 'accept') {
          // Explicit Accept button → answer.
          DeviceEventEmitter.emit(CALL_PUSH_EVENTS.ACCEPT, data);
        } else {
          // Plain body tap (iOS heads-up) → OPEN the app to the full-screen
          // incoming-call (ringing) screen so the user Accepts/Declines THERE. A
          // plain tap must NOT auto-answer (that raced the connect path and showed
          // nothing). `_fullScreen` forces the in-app call UI.
          DeviceEventEmitter.emit(CALL_PUSH_EVENTS.INCOMING, { ...data, _fullScreen: true });
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