import { Platform, DeviceEventEmitter } from 'react-native';
import { CALL_PUSH_EVENTS } from '../../firebase/callEvents';
import { setVoipToken } from '../../Redux/Services/Socket/socket';

/**
 * iOS PushKit (VoIP) bridge. Works with the AppDelegate PushKit handler added by
 * `plugins/withIosVoip.js`:
 *
 *   APNs VoIP push ──► AppDelegate.didReceiveIncomingPush
 *                        ├─ RNCallKeep.reportNewIncomingCall  (native CallKit UI — rings even when killed/locked)
 *                        └─ RNVoipPushNotificationManager      (emits the JS 'notification' event handled below)
 *
 * Here we:
 *   1. Register the VoIP token and hand it to the socket layer (setVoipToken) so
 *      the backend can target this device with call pushes.
 *   2. On an incoming VoIP push, fire CALL_PUSH_EVENTS.INCOMING so CallProvider
 *      wakes the WebRTC (WebView) engine and reconciles call state. The CallKit
 *      UI itself is driven natively + by react-native-callkeep's answer/end
 *      events (wired in nativeCallService → CallProvider), so we do NOT show the
 *      in-app ring as the primary UI on iOS — CallKit is.
 *
 * Everything is gated: no-op on Android and on builds without the native module
 * (Expo Go), so importing this is always safe.
 */

let VoipPush = null;
try {
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  VoipPush = require('react-native-voip-push-notification').default
    || require('react-native-voip-push-notification');
} catch (_) {
  VoipPush = null;
}

export const isVoipAvailable = () => Platform.OS === 'ios' && !!VoipPush;

// Normalise a VoIP push payload → the FCM-style `data` shape CallProvider's push
// handlers expect.
const toCallData = (payload = {}) => ({
  type: 'call',
  callId: payload.callId || null,
  callerId: payload.callerId || null,
  callerName: payload.callerName || null,
  callerImage: payload.callerImage || null,
  callType: payload.callType || payload.media || 'audio',
  uuid: payload.uuid || null, // the CallKit UUID the AppDelegate reported with
  _fullScreen: true, // came in while backgrounded/killed → full-screen on accept
  // The AppDelegate PushKit handler ALREADY reported this call to CallKit. The
  // flag tells CallProvider to skip a second nativeCall.displayIncomingCall so we
  // don't show two CallKit calls.
  _voip: true,
});

/**
 * Start listening for the VoIP token + incoming VoIP pushes. Returns an
 * unsubscribe function. Safe no-op unless iOS + the native module is present.
 */
export const registerVoipPush = () => {
  if (!isVoipAvailable()) return () => {};

  const onIncoming = (payload) => {
    if (!payload) return;
    DeviceEventEmitter.emit(CALL_PUSH_EVENTS.INCOMING, toCallData(payload));
  };

  try {
    VoipPush.addEventListener('register', (token) => {
      if (token) setVoipToken(token);
    });

    VoipPush.addEventListener('notification', (payload) => {
      onIncoming(payload);
    });

    // Replays any token/notification events that fired before JS attached the
    // listeners (e.g. a cold launch from a VoIP push). Required by the library.
    VoipPush.addEventListener('didLoadWithEvents', (events) => {
      if (!Array.isArray(events)) return;
      events.forEach((event) => {
        if (!event || !event.name) return;
        if (event.name === 'RNVoipPushRemoteNotificationsRegisteredEvent' && event.data) {
          setVoipToken(event.data);
        } else if (event.name === 'RNVoipPushRemoteNotificationReceivedEvent' && event.data) {
          onIncoming(event.data);
        }
      });
    });

    // Kick off APNs VoIP registration → fires the 'register' event with a token.
    VoipPush.registerVoipToken();
  } catch (err) {
    if (__DEV__) console.log('[VOIP] register failed', err?.message);
    return () => {};
  }

  return () => {
    try {
      VoipPush.removeEventListener('register');
      VoipPush.removeEventListener('notification');
      VoipPush.removeEventListener('didLoadWithEvents');
    } catch (_) { /* no-op */ }
  };
};

export default { isVoipAvailable, registerVoipPush };
