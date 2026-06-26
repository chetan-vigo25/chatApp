import { Platform, DeviceEventEmitter } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { CALL_PUSH_EVENTS } from './callEvents';

/**
 * WhatsApp-style incoming-call notification for Android (background / killed /
 * locked). Two possible native backends, picked in this order:
 *
 *   1. ExpoCallUi (modules/expo-call-ui) — a native Android `CallStyle`
 *      notification: green Answer / red Decline buttons + full-screen intent over
 *      the lock screen. Preferred. Its Answer/Decline run in a native
 *      BroadcastReceiver, so they work even when JS is killed.
 *   2. notifee — full-screen-intent notification with plain text Accept/Decline
 *      (fallback when the CallStyle module isn't in the build).
 *
 * iOS is handled by expo-notifications in fcmService (Apple requires CallKit for
 * lock-screen call UI). Everything here is crash-safe: each backend is resolved
 * lazily and no-ops when its native module isn't present.
 *
 * Whichever backend is used, user actions are normalised onto the shared
 * CALL_PUSH_EVENTS that CallProvider already listens to.
 */

const CALL_CHANNEL_ID = 'calls_fullscreen';
const MISSED_CALL_CHANNEL_ID = 'missed_calls';
const notifId = (callId) => `call-${callId || 'incoming'}`;
const missedNotifId = (callId) => `missed-${callId || 'call'}`;

// Call ids we've ALREADY posted a "missed call" notification for. Two independent
// sources can try to post the same one — the live app (CallProvider.finalizeEnd,
// when the call rang then went unanswered) AND a backend `type:'call-missed'` FCM
// push (the source of truth when the app was killed/offline). When the app is
// alive both run in the same JS runtime, so this set de-dupes them to ONE
// notification (WhatsApp shows exactly one).
const missedShownIds = new Set();

// Ids we've ACTUALLY displayed a call notification for. The call state later
// settles on a WebRTC id that can differ from the signaling id the notification
// was posted with, so cancelling by the live state id can miss. Tracking the
// shown id lets us dismiss reliably on answer/end. Only one incoming call exists
// at a time, so clearing the whole set is safe.
const shownCallIds = new Set();

// ---- backend 1: ExpoCallUi (native CallStyle) ----
let _callUi;
let _callUiResolved = false;
const getCallUi = () => {
  if (_callUiResolved) return _callUi;
  _callUiResolved = true;
  try { _callUi = requireOptionalNativeModule('ExpoCallUi'); } catch (_) { _callUi = null; }
  return _callUi;
};
const isCallUi = () => Platform.OS === 'android' && !!getCallUi();

// ---- backend 2: notifee ----
let _notifee = null;
let _consts = null;
let _notifeeResolved = false;
const getNotifee = () => {
  if (_notifeeResolved) return _notifee;
  _notifeeResolved = true;
  try {
    // eslint-disable-next-line global-require
    const mod = require('@notifee/react-native');
    _notifee = mod.default || mod;
    _consts = mod;
  } catch (err) {
    console.warn('[callNotif] notifee unavailable:', err?.message);
    _notifee = null;
  }
  return _notifee;
};

// ---- expo-notifications (iOS missed-call + Android fallback when notifee absent) ----
let _expoNotifications = null;
let _expoResolved = false;
const getExpoNotifications = () => {
  if (_expoResolved) return _expoNotifications;
  _expoResolved = true;
  try { _expoNotifications = require('expo-notifications'); } catch (_) { _expoNotifications = null; }
  return _expoNotifications;
};

// A full-screen call notifier exists on Android if EITHER backend is present.
export const isNotifeeCallAvailable = () => Platform.OS === 'android' && (isCallUi() || !!getNotifee());

// Normalise a backend call payload → the FCM-style `data` shape CallProvider's
// push handlers expect, then fire the right CALL_PUSH_EVENT.
const emitCallAction = (action, data) => {
  const payload = {
    type: 'call',
    callId: data?.callId || null,
    callerId: data?.callerId || null,
    callerName: data?.callerName || null,
    callerImage: data?.callerImage || null,
    callType: data?.callType || data?.media || 'audio',
    _fullScreen: true,
  };
  if (action === 'decline') {
    DeviceEventEmitter.emit(CALL_PUSH_EVENTS.REJECT, payload);
  } else if (action === 'accept') {
    // ONLY ACCEPT — do NOT also emit INCOMING. onPushAccept builds the ringing
    // state itself (fromAccept → full connect path, NOT notification-only). The
    // old extra INCOMING raced ahead and, on a foreground cold-start (app killed,
    // tapped Answer), created a notification-only state that swallowed the accept
    // — the call never connected and the call screen didn't open.
    DeviceEventEmitter.emit(CALL_PUSH_EVENTS.ACCEPT, payload);
  } else if (action === 'hangup') { // End on the active-call ongoing notification
    DeviceEventEmitter.emit(CALL_PUSH_EVENTS.HANGUP, payload);
  } else if (action === 'ongoing') { // body tap on the active-call notification
    DeviceEventEmitter.emit(CALL_PUSH_EVENTS.RESUME, payload);
  } else { // 'incoming' (full-screen / body tap on the ringing notification)
    DeviceEventEmitter.emit(CALL_PUSH_EVENTS.INCOMING, payload);
  }
};

// ===== active-call ongoing foreground service (Android, CallStyle backend) =====
// A persistent call notification with a live duration timer + Hang up action,
// shown for the whole CONNECTED call. CallStyle.forOngoingCall is only available
// via the native ExpoCallUi backend; notifee can't render it, so this no-ops when
// the native module is absent (the in-app CallOverlay still shows everything).
export const startOngoingCallNotification = (call) => {
  if (!isCallUi() || !call?.callId) return;
  try {
    getCallUi().startOngoingCall({
      callId: String(call.callId),
      callerName: call.callerName || 'Ongoing call',
      callerImage: call.callerImage || null,
      callType: call.callType === 'video' ? 'video' : 'audio',
      startedAt: call.startedAt || 0,
    });
  } catch (err) {
    console.warn('[callNotif] startOngoingCall failed:', err?.message);
  }
};

export const stopOngoingCallNotification = () => {
  if (!isCallUi()) return;
  try { getCallUi().stopOngoingCall(); } catch (_) { /* best-effort */ }
};

// ===== lock-screen security (Android) =====
// Is the device locked right now? Recorded when a call arrives so we only apply
// locked-call restrictions to calls that began on a locked device.
export const isDeviceLockedNow = () => {
  if (!isCallUi()) return false;
  try { return !!getCallUi().isDeviceLocked(); } catch (_) { return false; }
};

// Subscribe to native keyguard lock/unlock transitions. `cb(locked: boolean)`
// fires on screen-off (locked), screen-on-while-locked (locked) and user-present
// (unlocked). This is the only reliable lock signal: because MainActivity has
// showWhenLocked, waking a locked device resumes the app and AppState reports
// 'active' while the keyguard is still up — so the privacy overlay must key off
// THIS, not AppState alone. Returns an unsubscribe fn; no-op off Android.
export const addDeviceLockListener = (cb) => {
  if (!isCallUi()) return () => {};
  try {
    const sub = getCallUi().addListener('onLockStateChange', (e) => cb(!!e?.locked));
    return () => { try { sub?.remove(); } catch (_) { /* */ } };
  } catch (_) {
    return () => {};
  }
};

// Send the app behind the keyguard (revoke show-when-locked + move task to back)
// so the system lock screen reasserts. No-op off Android / without the module.
export const returnToLockScreen = () => {
  if (!isCallUi()) return;
  try { getCallUi().returnToLockScreen(); } catch (_) { /* best-effort */ }
};

// Runtime override of MainActivity's show-when-locked flag (kept for completeness;
// the content-protection path uses the privacy overlay rather than toggling this).
export const setShowWhenLockedNative = (show) => {
  if (!isCallUi()) return;
  try { getCallUi().setShowWhenLocked(!!show); } catch (_) { /* best-effort */ }
};

// Tell the native keyguard backstop a call is ringing/connecting/active (true) or
// fully idle (false). While active, the app is allowed to show over the lock screen
// (the call UI); while idle, any foreground-over-keyguard is bounced behind it.
export const setCallActiveNative = (active) => {
  if (!isCallUi()) return;
  try { getCallUi().setCallActive(!!active); } catch (_) { /* best-effort */ }
};

// Synchronous, NON-consuming peek: was the app cold-started by a call full-screen
// intent? Returns { action, callId, callerId, callerName, callerImage, callType } or
// null. Lets the UI paint the full-screen call screen from the first frame (no
// Splash/ChatList flash). null on iOS / no module / normal launch.
export const peekInitialCallLaunch = () => {
  if (!isCallUi()) return null;
  try { return getCallUi().peekInitialCallLaunch?.() || null; } catch (_) { return null; }
};

// Remove the NATIVE instant-call cover (drawn over MainActivity the moment it was
// launched/resumed for a call) once the real React-Native call overlay is up.
export const hideCallLaunchCover = () => {
  if (!isCallUi()) return;
  try { getCallUi().hideCallLaunchCover?.(); } catch (_) { /* best-effort */ }
};

// ===== notifee channel (only used by the notifee fallback) =====
export const ensureCallChannel = async () => {
  if (isCallUi()) return CALL_CHANNEL_ID; // native module creates its own channel
  const notifee = getNotifee();
  if (!notifee) return CALL_CHANNEL_ID;
  const { AndroidImportance, AndroidVisibility } = _consts;
  await notifee.createChannel({
    id: CALL_CHANNEL_ID,
    name: 'Incoming Calls',
    description: 'Full-screen incoming voice and video calls',
    importance: AndroidImportance.HIGH,
    sound: 'default',
    vibration: true,
    vibrationPattern: [300, 600, 300, 600],
    bypassDnd: true,
    visibility: AndroidVisibility.PUBLIC,
  });
  return CALL_CHANNEL_ID;
};

// ===== display =====
export const displayIncomingCallNotifee = async (data) => {
  const call = {
    callId: data?.callId,
    callerId: data?.callerId,
    callerName: data?.callerName || data?.title,
    callerImage: data?.callerImage || null,
    callType: (data?.callType || data?.media) === 'video' ? 'video' : 'audio',
  };
  if (!call.callId) return false;
  shownCallIds.add(String(call.callId));

  // Preferred: native CallStyle (green Answer / red Decline).
  if (isCallUi()) {
    try { getCallUi().displayIncomingCall(call); return true; } catch (err) {
      console.warn('[callNotif] CallStyle display failed, trying notifee:', err?.message);
    }
  }

  // Fallback: notifee full-screen intent. Returns false so the FCM handler can
  // fall back again to the expo-notifications heads-up — a killed-app call must
  // NEVER end up showing nothing because one backend silently failed.
  const notifee = getNotifee();
  if (!notifee) return false;
  try {
    const channelId = await ensureCallChannel();
    const { AndroidImportance, AndroidVisibility, AndroidCategory } = _consts;
    const isVideo = call.callType === 'video';
    // WhatsApp-style heads-up: round caller avatar + brand-green accent. The
    // true CallStyle layout (split green Answer / red Decline) is only available
    // via the native ExpoCallUi backend above; notifee can't render CallStyle, so
    // this is the closest visual the library allows. Coloured emoji prefixes give
    // the plain action buttons a green/red affordance across OEM skins.
    await notifee.displayNotification({
      id: notifId(call.callId),
      title: call.callerName || 'Incoming call',
      body: isVideo ? '📹 Incoming video call' : '📞 Incoming voice call',
      data: { ...(data || {}), type: 'call' },
      android: {
        channelId,
        smallIcon: 'notification_icon',
        color: '#00A884',
        // Round caller photo, like WhatsApp. Falls back to no avatar when the
        // sender has no image — notifee ignores an undefined largeIcon.
        ...(call.callerImage ? { largeIcon: call.callerImage, circularLargeIcon: true } : {}),
        category: AndroidCategory.CALL,
        importance: AndroidImportance.HIGH,
        visibility: AndroidVisibility.PUBLIC,
        ongoing: true,
        autoCancel: false,
        loopSound: true,
        timeoutAfter: 45000,
        fullScreenAction: { id: 'default', launchActivity: 'default' },
        pressAction: { id: 'default', launchActivity: 'default' },
        actions: [
          { title: '❌ Decline', pressAction: { id: 'decline' } },
          { title: '📞 Accept', pressAction: { id: 'accept', launchActivity: 'default' } },
        ],
      },
    });
    return true;
  } catch (err) {
    console.warn('[callNotif] notifee display failed:', err?.message);
    return false;
  }
};

export const cancelIncomingCallNotifee = async (callId) => {
  if (!callId) return; // never cancel-all — would clear chat notifications too
  shownCallIds.delete(String(callId));
  if (isCallUi()) {
    try { getCallUi().cancelIncomingCall(String(callId)); } catch (_) { /* */ }
  }
  const notifee = getNotifee();
  if (notifee) {
    try { await notifee.cancelNotification(notifId(callId)); } catch (_) { /* best-effort */ }
  }
};

/**
 * Dismiss EVERY incoming-call notification we've shown. Use this on answer/end —
 * it doesn't depend on the live call state's id matching the id the notification
 * was posted with, so the heads-up never lingers over the active-call screen.
 * Scoped to call notifications only (tracked ids / native call channel), so chat
 * notifications are untouched.
 */
export const cancelAllIncomingCallNotifee = async () => {
  if (isCallUi()) {
    try { getCallUi().cancelAllIncomingCalls?.(); } catch (_) { /* */ }
  }
  const ids = Array.from(shownCallIds);
  shownCallIds.clear();
  const notifee = getNotifee();
  for (const id of ids) {
    if (isCallUi()) {
      try { getCallUi().cancelIncomingCall(String(id)); } catch (_) { /* */ }
    }
    if (notifee) {
      try { await notifee.cancelNotification(notifId(id)); } catch (_) { /* best-effort */ }
    }
  }
};

// ===== missed-call notification (WhatsApp-style "Missed voice/video call") =====
// A normal, DISMISSIBLE notification (not CallStyle / not full-screen) left in the
// tray when an incoming call is never answered — ring timeout, caller cancelled,
// or the device was offline/killed. Tapping it opens the caller's chat (routed by
// the existing `type !== 'call'` + chatId branch in routeNotifeeEvent / fcmService).
const ensureMissedCallChannel = async () => {
  const notifee = getNotifee();
  if (!notifee || Platform.OS !== 'android' || !_consts) return MISSED_CALL_CHANNEL_ID;
  const { AndroidImportance, AndroidVisibility } = _consts;
  await notifee.createChannel({
    id: MISSED_CALL_CHANNEL_ID,
    name: 'Missed Calls',
    description: 'Missed voice and video calls',
    importance: AndroidImportance.DEFAULT, // dismissible; NOT a ringing channel
    visibility: AndroidVisibility.PUBLIC,
    vibration: true,
  });
  return MISSED_CALL_CHANNEL_ID;
};

/**
 * Show ONE "Missed {voice|video} call from {name}" notification. Cross-platform:
 * notifee on Android (round caller avatar + dedicated channel), expo-notifications
 * on iOS / when notifee isn't in the build. De-duped per call id so the live-app
 * path and the backend `call-missed` push never produce two.
 *
 * `data`: { callId|signalId, callerId, callerName, callerImage, callType|media,
 * chatId, senderId, senderName, groupId, groupName, isGroup }.
 */
export const displayMissedCallNotification = async (data = {}) => {
  const callId = data.callId || data.signalId || null;
  if (callId) {
    const key = String(callId);
    if (missedShownIds.has(key)) return; // already posted for this call
    missedShownIds.add(key);
  }
  const isGroup = !!(data.isGroup || data.groupId);
  const name = isGroup
    ? (data.groupName || data.callerName || 'Group call')
    : (data.callerName || data.senderName || data.title || 'Someone');
  const isVideo = (data.callType || data.media) === 'video';
  const title = name;
  const body = isVideo ? 'Missed video call' : 'Missed voice call';
  // Tap payload → open the caller's / group's chat. type:'call-missed' so it's
  // never mistaken for a live incoming-call push by the routers.
  const tapData = {
    ...data,
    type: 'call-missed',
    chatId: data.chatId || (isGroup ? data.groupId : null) || null,
    senderId: data.senderId || data.callerId || null,
    senderName: data.senderName || (isGroup ? null : name) || null,
  };

  // Android: notifee (richer — avatar + dedicated dismissible channel).
  if (Platform.OS === 'android' && getNotifee() && _consts) {
    try {
      const notifee = getNotifee();
      const channelId = await ensureMissedCallChannel();
      const { AndroidImportance, AndroidVisibility } = _consts;
      await notifee.displayNotification({
        id: missedNotifId(callId),
        title,
        body,
        data: tapData,
        android: {
          channelId,
          smallIcon: 'notification_icon',
          color: '#00A884',
          ...(data.callerImage ? { largeIcon: data.callerImage, circularLargeIcon: true } : {}),
          importance: AndroidImportance.DEFAULT,
          visibility: AndroidVisibility.PUBLIC,
          autoCancel: true,
          showTimestamp: true,
          pressAction: { id: 'default', launchActivity: 'default' },
        },
      });
      return;
    } catch (err) {
      console.warn('[callNotif] missed-call notifee failed, trying expo:', err?.message);
    }
  }

  // iOS / fallback: expo-notifications.
  const Notifications = getExpoNotifications();
  if (!Notifications) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data: tapData,
        sound: Platform.OS === 'ios' ? 'default' : true,
        ...(Platform.OS === 'android' && { channelId: MISSED_CALL_CHANNEL_ID }),
      },
      trigger: null,
    });
  } catch (err) {
    console.warn('[callNotif] missed-call expo display failed:', err?.message);
  }
};

// Forget a call id so a later genuine missed-call for the SAME id can notify again.
export const forgetMissedCall = (callId) => {
  if (callId) missedShownIds.delete(String(callId));
};

// ===== foreground events (app open) =====
export const registerNotifeeForeground = () => {
  // CallStyle backend: listen to the native module's action events.
  if (isCallUi()) {
    try {
      const sub = getCallUi().addListener('onCallAction', (e) => {
        if (e?.action) emitCallAction(e.action, e);
      });
      return () => { try { sub?.remove(); } catch (_) { /* */ } };
    } catch (err) {
      console.warn('[callNotif] CallUi listener failed:', err?.message);
      return () => {};
    }
  }
  // notifee backend.
  const notifee = getNotifee();
  if (!notifee) return () => {};
  try {
    return notifee.onForegroundEvent(({ type, detail }) => routeNotifeeEvent(type, detail));
  } catch (err) {
    console.warn('[callNotif] notifee foreground registration skipped:', err?.message);
    return () => {};
  }
};

// ===== background events (killed/backgrounded) =====
export const registerNotifeeBackground = () => {
  // notifee REQUIRES a background event handler to be registered at the top level
  // whenever the library is in the build — otherwise it logs "no background event
  // handler has been set" the first time ANY notifee notification (incl. the
  // grouped MessagingStyle message notifications) raises a background event. So we
  // register unconditionally when notifee is present, even when the native
  // CallStyle (ExpoCallUi) backend handles call actions itself via a
  // BroadcastReceiver: in that case the call branch below simply never matches and
  // the handler is a harmless no-op for calls while still satisfying notifee.
  const notifee = getNotifee();
  if (!notifee) return;
  try {
    notifee.onBackgroundEvent(async ({ type, detail }) => {
      // Message-notification taps must navigate regardless of the call backend,
      // so route them BEFORE the CallStyle early-return below.
      const data = detail?.notification?.data || {};
      if (data?.type !== 'call') {
        routeNotifeeEvent(type, detail);
        return;
      }
      // CallStyle handles its own Answer/Decline natively; only route call
      // actions here when notifee is the active call backend.
      if (isCallUi()) return;
      const action = routeNotifeeEvent(type, detail);
      if (action === 'decline' || action === 'accept') {
        await cancelIncomingCallNotifee(detail?.notification?.data?.callId);
      }
    });
  } catch (err) {
    console.warn('[callNotif] notifee background registration skipped:', err?.message);
  }
};

// ===== cold-start replay =====
export const consumeInitialNotifeeCall = async () => {
  // CallStyle backend: the launching action (Answer tap / full-screen / body).
  if (isCallUi()) {
    try {
      const action = getCallUi().getInitialCallAction();
      if (action?.action) {
        // Fire on the next tick (not +800ms). CallProvider only calls this once
        // its listeners are attached and auth is restored, so the long defer just
        // made the full-screen call UI appear 1-2s LATE (chat list flashed first
        // on a killed/locked launch). 0ms = as instant as a cold start allows.
        setTimeout(() => emitCallAction(action.action, action), 0);
      }
    } catch (err) {
      console.warn('[callNotif] CallUi initial action skipped:', err?.message);
    }
    return;
  }
  // notifee backend.
  const notifee = getNotifee();
  if (!notifee || !_consts) return;
  try {
    const initial = await notifee.getInitialNotification();
    if (!initial || initial?.notification?.data?.type !== 'call') return;
    const { EventType } = _consts;
    const actionId = initial?.pressAction?.id;
    const detail = { notification: initial.notification, pressAction: initial.pressAction };
    const type = actionId && actionId !== 'default' ? EventType.ACTION_PRESS : EventType.PRESS;
    setTimeout(() => routeNotifeeEvent(type, detail, { launched: true }), 0);
  } catch (err) {
    console.warn('[callNotif] consume initial notification skipped:', err?.message);
  }
};

// notifee event → CALL_PUSH_EVENTS (only used by the notifee fallback).
const routeNotifeeEvent = (eventType, detail, { launched } = {}) => {
  if (!_consts) return null;
  const { EventType } = _consts;
  const data = detail?.notification?.data || {};

  // Message notification tapped (body press) → open the chat thread. Covers
  // foreground, background, and cold-start (launched) for Android notifee
  // MessagingStyle notifications. Lazy require avoids an import cycle.
  if (data?.type !== 'call' && (data?.chatId || data?.groupId)
      && (eventType === EventType.PRESS || launched)) {
    try { require('../Redux/Services/navigationService').navigateToChat(data); } catch (_) { /* */ }
    return 'message-press';
  }

  if (data?.type !== 'call') return null;
  const actionId = detail?.pressAction?.id;
  if (eventType === EventType.ACTION_PRESS && actionId === 'decline') {
    cancelIncomingCallNotifee(data.callId);
    emitCallAction('decline', data);
    return 'decline';
  }
  if (eventType === EventType.ACTION_PRESS && actionId === 'accept') {
    emitCallAction('accept', data);
    cancelIncomingCallNotifee(data.callId);
    return 'accept';
  }
  if (eventType === EventType.PRESS || launched) {
    emitCallAction('incoming', data);
    return 'press';
  }
  return null;
};

export { CALL_PUSH_EVENTS };
