import { Platform, DeviceEventEmitter, AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { CALL_PUSH_EVENTS } from '../../firebase/callEvents';
import { setVoipToken, setVoipEnv, clearVoipToken } from '../../Redux/Services/Socket/socket';
import { deriveVoipEnv } from '../../utils/voipEnv';

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

// P-C-11: which APNs environment this build's VoIP token belongs to. Read from
// the embedded provisioning profile via expo-application (aps-environment;
// App Store builds carry no profile and are 'production'). Anything that cannot
// be derived reliably stays null and the field is simply not sent.
const resolveVoipEnv = async () => {
  try {
    const Application = require('expo-application');
    const [apsEnvironment, releaseType] = await Promise.all([
      Application.getIosPushNotificationServiceEnvironmentAsync(),
      Application.getIosApplicationReleaseTypeAsync(),
    ]);
    setVoipEnv(deriveVoipEnv({ apsEnvironment, releaseType }));
  } catch (_) { /* leave unset - backend falls back to its own env guess */ }
};

// P-C-18: the AppDelegate writes this Keychain note (epoch ms) from
// pushRegistry(didInvalidatePushTokenFor:). Same key as withIosVoip.js.
const VOIP_INVALIDATED_KEY = 'voipTokenInvalidatedAt';
const SECURE_OPTIONS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };
let lastTokenAt = 0;

const consumeInvalidationNote = async () => {
  try {
    const raw = await SecureStore.getItemAsync(VOIP_INVALIDATED_KEY, SECURE_OPTIONS);
    if (!raw) return;
    await SecureStore.deleteItemAsync(VOIP_INVALIDATED_KEY, SECURE_OPTIONS);
    // Only a token received BEFORE the invalidation is dead; a replacement that
    // already arrived must survive.
    if (Number(raw) > lastTokenAt) clearVoipToken();
  } catch (_) { /* no-op */ }
};

// Normalise a VoIP push payload → the FCM-style `data` shape CallProvider's push
// handlers expect.
//
// The AppDelegate forwards the WHOLE PushKit dictionary, so everything the
// backend sent is available here — this used to keep only the six 1:1 fields and
// DROP the rest, which broke conference calls outright:
//   • `ts` (backend sent-at) — without it the staleness/aged guards fall back to
//     the epoch inside the callId, which for a conference is when the conference
//     STARTED. A member re-invited minutes later was judged stale, JS never rang,
//     and the CallKit screen iOS had already raised could not be answered.
//   • `isConference` — gates BOTH the conference-reinvite exception in the
//     recent-ended guard and the `ts` fallback above.
//   • `isGroup` / `groupId` / `groupName` / `members` — without them a group ring
//     is built as a 1:1 (wrong title, earpiece instead of speaker on answer, and
//     the same-peer redial guard applies where it must not).
// Pass them ALL through; each stays optional, so a backend that only sends the
// original six behaves exactly as before.
const toCallData = (payload = {}) => ({
  type: 'call',
  callId: payload.callId || null,
  callerId: payload.callerId || null,
  callerName: payload.callerName || null,
  // The caller's OWN account name + number. Optional and additive: they let the
  // client resolve the ring label against this device's address book (saved
  // name → number → account name) instead of trusting a server-composed name.
  callerPushName: payload.callerPushName || null,
  callerMobile: payload.callerMobile || null,
  // Privacy bits — the backend adds them to the VoIP payload as of 2026-09-23.
  // Without them a killed-app iOS ring re-resolved a hidden caller to my saved
  // contact name / their number instead of the "@handle". The flag stays
  // undefined when absent so an older server never reads as "not hidden".
  callerUserName: payload.callerUserName || null,
  callerHideContact: payload.callerHideContact != null && payload.callerHideContact !== ''
    ? String(payload.callerHideContact)
    : undefined,
  callerImage: payload.callerImage || null,
  callType: payload.callType || payload.media || 'audio',
  // Callee user id (additive, P-C-02/04): lets CallProvider refuse a push that is
  // addressed to a different account than the one signed in here.
  recipientId: payload.recipientId != null && payload.recipientId !== '' ? String(payload.recipientId) : null,
  uuid: payload.uuid || null, // the CallKit UUID the AppDelegate reported with
  ts: payload.ts != null ? Number(payload.ts) : undefined,
  isConference: payload.isConference,
  // Which conference INVITE this ring is for — echoed back on accept/reject so
  // the server settles that exact invite instead of guessing.
  operationId: payload.operationId || payload.inviteId || null,
  conferenceHost: payload.conferenceHost || null,
  isGroup: payload.isGroup,
  groupId: payload.groupId || null,
  groupName: payload.groupName || null,
  members: payload.members,
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
      if (token) { lastTokenAt = Date.now(); setVoipToken(token); }
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
          lastTokenAt = Date.now();
          setVoipToken(event.data);
        } else if (event.name === 'RNVoipPushRemoteNotificationReceivedEvent' && event.data) {
          onIncoming(event.data);
        }
      });
    });

    // Kick off APNs VoIP registration → fires the 'register' event with a token.
    VoipPush.registerVoipToken();
    resolveVoipEnv();
    consumeInvalidationNote();
  } catch (err) {
    if (__DEV__) console.log('[VOIP] register failed', err?.message);
    return () => {};
  }

  // Event-driven (no timer): re-check the invalidation note on foreground.
  const appStateSub = AppState.addEventListener('change', (next) => {
    if (next === 'active') consumeInvalidationNote();
  });

  return () => {
    try { appStateSub.remove(); } catch (_) { /* no-op */ }
    try {
      VoipPush.removeEventListener('register');
      VoipPush.removeEventListener('notification');
      VoipPush.removeEventListener('didLoadWithEvents');
    } catch (_) { /* no-op */ }
  };
};

export default { isVoipAvailable, registerVoipPush };
