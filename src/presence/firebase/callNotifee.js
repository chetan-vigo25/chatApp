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
const notifId = (callId) => `call-${callId || 'incoming'}`;

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
    DeviceEventEmitter.emit(CALL_PUSH_EVENTS.INCOMING, payload);
    DeviceEventEmitter.emit(CALL_PUSH_EVENTS.ACCEPT, payload);
  } else { // 'incoming' (full-screen / body tap)
    DeviceEventEmitter.emit(CALL_PUSH_EVENTS.INCOMING, payload);
  }
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
  if (!call.callId) return;

  // Preferred: native CallStyle (green Answer / red Decline).
  if (isCallUi()) {
    try { getCallUi().displayIncomingCall(call); return; } catch (err) {
      console.warn('[callNotif] CallStyle display failed, trying notifee:', err?.message);
    }
  }

  // Fallback: notifee full-screen intent.
  const notifee = getNotifee();
  if (!notifee) return;
  try {
    const channelId = await ensureCallChannel();
    const { AndroidImportance, AndroidVisibility, AndroidCategory } = _consts;
    const isVideo = call.callType === 'video';
    await notifee.displayNotification({
      id: notifId(call.callId),
      title: call.callerName || 'Incoming call',
      body: isVideo ? 'Incoming video call' : 'Incoming voice call',
      data: { ...(data || {}), type: 'call' },
      android: {
        channelId,
        smallIcon: 'notification_icon',
        color: '#00A884',
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
          { title: 'Decline', pressAction: { id: 'decline' } },
          { title: 'Accept', pressAction: { id: 'accept', launchActivity: 'default' } },
        ],
      },
    });
  } catch (err) {
    console.warn('[callNotif] notifee display failed:', err?.message);
  }
};

export const cancelIncomingCallNotifee = async (callId) => {
  if (!callId) return; // never cancel-all — would clear chat notifications too
  if (isCallUi()) {
    try { getCallUi().cancelIncomingCall(String(callId)); } catch (_) { /* */ }
  }
  const notifee = getNotifee();
  if (notifee) {
    try { await notifee.cancelNotification(notifId(callId)); } catch (_) { /* best-effort */ }
  }
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
  // CallStyle backend handles background actions natively (BroadcastReceiver) —
  // nothing to register in JS.
  if (isCallUi()) return;
  const notifee = getNotifee();
  if (!notifee) return;
  try {
    notifee.onBackgroundEvent(async ({ type, detail }) => {
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
        setTimeout(() => emitCallAction(action.action, action), 800);
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
    setTimeout(() => routeNotifeeEvent(type, detail, { launched: true }), 800);
  } catch (err) {
    console.warn('[callNotif] consume initial notification skipped:', err?.message);
  }
};

// notifee event → CALL_PUSH_EVENTS (only used by the notifee fallback).
const routeNotifeeEvent = (eventType, detail, { launched } = {}) => {
  if (!_consts) return null;
  const { EventType } = _consts;
  const data = detail?.notification?.data || {};
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
