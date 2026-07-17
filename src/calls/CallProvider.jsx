import React, {
  useContext, useReducer, useRef, useCallback, useEffect, useState,
} from 'react';
import {
  Vibration, Alert, StyleSheet, View, DeviceEventEmitter, Linking, Platform,
  Animated, Pressable, TouchableOpacity, AppState, Keyboard,
} from 'react-native';
import Constants from 'expo-constants';
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import { useCameraPermissions } from 'expo-camera';
import * as ScreenCapture from 'expo-screen-capture';
import { MaterialIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { useAuth } from '../contexts/AuthContext';
import { CallContext } from './CallContext';
import CallEngineWebView from './engine/CallEngineWebView';
import { isNativeCallEngine } from './engineSelector';
import nativeEngine from './native-engine/NativeCallEngine';
import { audioSessionDidActivate, audioSessionDidDeactivate } from './native-engine/webrtcGlobals';
import NativeVideoStage from './native-engine/NativeVideoStage';
import CallOverlay from './screens/CallOverlay';
// In-app incoming-call banner temporarily disabled (OS notification handles
// incoming calls). Re-enable this import + the <IncomingCallBanner /> render below.
// import IncomingCallBanner from './components/IncomingCallBanner';
import PrivacyOverlay from '../components/PrivacyOverlay';
import CallTimer from './components/CallTimer';
import useDraggablePip from './components/useDraggablePip';
import { CMD, buildCmdInjection } from './engine/protocol';
import {
  callReducer, initialCallState, CALL_STATUS, ACT, deriveOutcome, MAX_PARTICIPANTS,
} from './state/callMachine';
import { CALL_RING_DURATION_SECONDS } from '@env';
import { getCallToken, clearCachedCallToken, getServerRingDurationSec, getServerRecordingConfig } from './services/callTokenService';
import { recordCall } from './services/callLogService';
import { uploadRecordingChunk, finalizeRecording } from './services/callRecordingService';
import { playRingtone, playRingback, stopRingtone } from './services/ringtoneService';
import nativeCall from './services/nativeCallService';
import { registerVoipPush } from './services/voipPushService';
import {
  ringCall, cancelCall, acceptCallSignal, rejectCallSignal, endCallSignal,
  registerCallSignalListeners, pullPendingCalls,
} from './services/callSignalService';
import { subscribeSocketState } from '../Redux/Services/Socket/socket';
// CALL_PUSH_EVENTS lives in its own dep-free module; callNotifee resolves its
// native backends lazily (requireOptionalNativeModule + try/catch require), so
// these imports are safe even in Expo Go — the functions simply no-op when no
// native call-UI / notifee module is present. They become live in a dev/EAS
// build (required for the ExpoCallUi CallStyle notification anyway), enabling
// cold-start Answer replay (consumeInitialNotifeeCall) and dismissing the
// incoming-call notification once answered/ended (cancelIncomingCallNotifee).
import { CALL_PUSH_EVENTS, isStaleCallPush, callPushAgeMs, AGED_CALL_PUSH_MS } from '../firebase/callEvents';
import {
  cancelAllIncomingCallNotifee, consumeInitialNotifeeCall, displayIncomingCallNotifee,
  startOngoingCallNotification, stopOngoingCallNotification,
  isDeviceLockedNow, returnToLockScreen, addDeviceLockListener,
  setShowWhenLockedNative, displayMissedCallNotification, setCallActiveNative,
  peekInitialCallLaunch, hideCallLaunchCover,
} from '../firebase/callNotifee';
import { notifyIncomingCall } from './services/callNotifyService';
import ColdStartCallCover from './components/ColdStartCallCover';
import CallReliabilityGate from './components/CallReliabilityGate';

// CallContext now lives in its own leaf module (./CallContext) to break the
// useCall ↔ CallProvider require cycle. Re-exported here for backward compat.
export { CallContext };
export const useCall = () => useContext(CallContext) || {};

// Expo Go cannot do getUserMedia inside a WebView — needs a dev/EAS build.
const IS_EXPO_GO = false
//  Constants.appOwnership === 'expo'
//   || Constants.executionEnvironment === 'storeClient';

// How long a call may ring (unanswered) before the app gives up on its own.
// Configured via .env (for both audio AND video): the backend `.env`
// CALL_RING_DURATION_SECONDS is delivered through the token endpoint and takes
// precedence so both ends ring for the same window; the app `.env`
// CALL_RING_DURATION_SECONDS is the local fallback. Clamped 10–180s, default 35.
// Note: the hosted calling service enforces its OWN ring window too — this
// client timer only governs when *the app* stops ringing; it can't extend it.
const ENV_RING_SEC = (() => {
  const n = parseInt(CALL_RING_DURATION_SECONDS, 10);
  return Number.isFinite(n) ? n : 35;
})();
const clampRingSec = (s) => Math.min(Math.max(Number(s) || 0, 10), 180);
const getRingTimeoutMs = () => clampRingSec(getServerRingDurationSec() || ENV_RING_SEC) * 1000;

// After a call is ANSWERED, how long to wait for remote media to actually
// connect (status → ACTIVE) before giving up. This guards the holes the ring
// timeout doesn't: a callee who tapped Accept before the WebRTC `incoming`
// reconciled a callId (so CMD.ACCEPT never fires), or a call where local media
// is captured but the remote stream never arrives. Without it either case sits
// on "Connecting…" forever. 30s ≈ WhatsApp's "couldn't connect" window.
const CONNECT_TIMEOUT_MS = 30000;

// After the media layer drops mid-call (network blip / ICE failed), how long to
// wait for it to recover (auto ICE-restart + the SDK's own reconnect) before
// giving up and ending the call as "Connection lost". 45s: strictly LONGER than
// the media server's 40s reconnect grace (RECONNECT_GRACE_MS), so the client
// never abandons a call the server was still holding for resume — giving up at
// 30s wasted the last 10s of every recoverable drop.
const RECONNECT_TIMEOUT_MS = 45000;

// When a call ends with a reason the user needs to READ (busy / unavailable /
// blocked-by-admin / declined / failed), keep the end screen up at least this
// long before auto-returning to chat. A plain hang-up resets fast.
const END_MESSAGE_LINGER_MS = 3000;

// AsyncStorage key recording that the user has granted call media permission
// (value = highest level granted: 'audio' or 'video'). The OS is the real source
// of truth (we always confirm via getPermissionsAsync), but this persists the
// grant explicitly so later calls reuse it without re-prompting.
const MEDIA_PERM_KEY = '@call/mediaPermGranted';

// Floating video PiP dimensions (WhatsApp-style portrait card).
const PIP_W = 116;
const PIP_H = 170;

const deriveChatId = (a, b) => {
  if (!a || !b) return null;
  return `u_${[String(a), String(b)].sort().join('_')}`;
};

// Contact-block relation for a 1:1 peer, read straight off the Redux block slice
// (same source the composer guard uses). Required so a call can't be placed when
// either side blocked the other — the backend ring gate is the authority, this is
// the matching client-side gate so the UI never even rings.
//   iBlocked  — I blocked this peer
//   blockedMe — this peer blocked me
export const getBlockRelation = (peerId) => {
  try {
    if (!peerId) return { iBlocked: false, blockedMe: false };
    const mod = require('../Redux/Store');
    const store = mod.store || mod.default || mod;
    const st = store?.getState?.() || {};
    const id = String(peerId);
    return {
      iBlocked: (st?.block?.blockedIds || []).map(String).includes(id),
      blockedMe: (st?.block?.blockedByIds || []).map(String).includes(id),
    };
  } catch (e) {
    return { iBlocked: false, blockedMe: false };
  }
};

export const CallProvider = ({ children }) => {
  const { user, isAuthenticated } = useAuth();
  const myId = user?._id ? String(user._id) : null;
  const myName = user?.fullName || user?.name || '';

  const [state, dispatch] = useReducer(callReducer, initialCallState);
  const [engineReady, setEngineReady] = useState(false);
  const [presenceMap, setPresenceMap] = useState({}); // { userId: bool }
  // Whether the platform supports app-controlled audio output routing (Android
  // WebView); false on iOS WKWebView where the OS routes speaker/earpiece.
  const [audioRouteSupported, setAudioRouteSupported] = useState(true);
  // expo-camera 17 exposes camera permission ONLY via this hook (the standalone
  // get/requestCameraPermissionsAsync functions are not exported). camPermission
  // is the current status ({ granted, canAskAgain } | null); requestCamPermission
  // prompts (idempotent — no dialog once granted). Used for video-call camera.
  const [camPermission, requestCamPermission] = useCameraPermissions();

  const webRef = useRef(null);
  const stateRef = useRef(state);
  const engineReadyRef = useRef(false);
  const endedRef = useRef(false);
  const connectingRef = useRef(false);
  const htmlReadyRef = useRef(false);      // engine WebView HTML/SDK loaded
  const pendingConnectRef = useRef(null);  // { token, url } queued before HTML was ready
  const resetTimerRef = useRef(null);
  const ringTimeoutRef = useRef(null); // auto-end an unanswered ringing call
  const mediaWatchdogRef = useRef(null); // detect a hung getUserMedia (no localstream)
  const connectWatchdogRef = useRef(null); // detect an answered call that never reaches ACTIVE (no remote media)
  const reconnectWatchdogRef = useRef(null); // mid-call media-drop recovery watchdog (APP-6)
  const audioRouteAppliedRef = useRef(false); // did the user toggle Speaker this call? (so we reset routing on end)
  const initialRouteAppliedRef = useRef(false); // initial earpiece/speaker route applied for THIS call (once, at connect)
  const presenceWaiters = useRef({}); // ref -> resolve
  const pingWaiters = useRef({});     // ref -> resolve (engine liveness probe)
  const readyWaiters = useRef([]);    // [resolve]
  // Mid-call "Add participant" rings, keyed on their own fresh signaling ids —
  // [{ sigId, ids }] — so call-end can cancel any invite still ringing.
  const inviteSignalsRef = useRef([]);
  // Group ring-window sweep: when the ring window closes on a CONNECTED group
  // call, members who never answered are dropped from the roster (no eternal
  // "Ringing…/Connecting…" tiles).
  const groupRingSweepRef = useRef(null);
  // Ids of the call that JUST ended — the engine's offline-redial/re-invite loop
  // can deliver a late 'incoming' for it; auto-decline instead of ghost-re-ringing.
  const recentEndedRef = useRef({ ids: [], ts: 0 });
  const pushAcceptPendingRef = useRef(false); // Accept tapped on a call push → answer once INCOMING is committed
  // CallKit End tapped BEFORE the ring state committed (cold boot: decline on
  // the lock-screen CallKit UI while the VoIP replay / pending pull is still in
  // flight). Timestamp (not bool) so the flush effect only honors a FRESH
  // decline — a stale flag must never kill a future unrelated call.
  const nativeEndPendingRef = useRef(0);
  // Always-current handle to onEngineEvent for the native engine's one-time
  // subscription (same latest-render pattern as actionsRef below).
  const onEngineEventRef = useRef(() => {});
  // Last time the iOS AVAudioSession was (re)configured — debounces the churn
  // that kept killing the WKWebView mic (see configureIOSAudioSession).
  const iosAudioSessionAppliedAtRef = useRef(0);
  // Latest action handles, read by the native (CallKit/ConnectionService) event
  // listeners so they never close over stale callbacks.
  const actionsRef = useRef({});
  // On-device recording (admin "Listen Live"): only the CALLER records. We pin
  // the recorded callId to the app signaling id so it persists across the state
  // reset at hang-up, and guard against double-start.
  const recordingOnRef = useRef(false);
  const recordingCallIdRef = useRef(null);
  // Lock-screen security: true when the current call ARRIVED / is being exited on
  // a locked device → back/end returns to the lock screen instead of exposing app.
  const lockedCallRef = useRef(false);
  const [lockedCall, setLockedCall] = useState(false);
  // Opaque privacy overlay shown when the app is backgrounded/locked with no call,
  // so chat content is never visible over the lock screen / in the app switcher.
  // Initialize SYNCHRONOUSLY from the live keyguard state: a terminated app
  // cold-started OVER the lock screen (the full-screen-intent launch targets the
  // single MainActivity, which carries showWhenLocked) would otherwise paint
  // ChatList for the frames before the lock effect runs. Fail CLOSED — cover from
  // the first render whenever the device is locked. No-op (false) on iOS / when the
  // native module isn't present, so a normal unlocked launch never flashes it.
  const [privacyMask, setPrivacyMask] = useState(
    () => Platform.OS === 'android' && isDeviceLockedNow(),
  );

  // Cold-start call cover (APP-14). When the app was KILLED and launched by a
  // call full-screen intent (killed+locked incoming ring), the first frames would
  // otherwise paint Splash/ChatList before the JS call state mounts. Peek the
  // launch intent SYNCHRONOUSLY (non-consuming — getInitialCallAction still drives
  // the real accept/incoming action) and paint an instant "Incoming call" cover
  // until the live call UI takes over. No-op on iOS / normal launches (peek → null).
  const [coldStartCall, setColdStartCall] = useState(() => {
    if (Platform.OS !== 'android') return null;
    try { return peekInitialCallLaunch(); } catch (_) { return null; }
  });

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { engineReadyRef.current = engineReady; }, [engineReady]);

  // This device's id — used to ignore a `call:cancelled-elsewhere` whose
  // `winnerDeviceId` is US (a stale duplicate socket of the winning device can
  // still receive the sibling-dismiss broadcast; it must not end the call we
  // just answered).
  const deviceIdRef = useRef(null);
  useEffect(() => {
    AsyncStorage.getItem('deviceId')
      .then((v) => { if (v) deviceIdRef.current = String(v); })
      .catch(() => {});
  }, []);

  // Close the soft keyboard the moment a call leaves IDLE (incoming ring,
  // outgoing dial, or active). Otherwise an open keyboard from the chat input
  // stays up underneath the call banner / full-screen call UI.
  useEffect(() => {
    if (state.status && state.status !== CALL_STATUS.IDLE && state.status !== CALL_STATUS.ENDED) {
      Keyboard.dismiss();
    }
  }, [state.status]);

  // ---- active-call ongoing foreground service (Android) ----
  // While a call is ANSWERED and still live, run the WhatsApp-style persistent
  // notification (caller name + live duration + Hang up) backed by a foreground
  // service so the OS keeps the call's mic/camera alive when the app is
  // backgrounded. No-op off Android / without the native module (the orchestrator
  // gates it).
  //
  // CRITICAL — start at ANSWER, not at ACTIVE. Android 12+ forbids STARTING a
  // microphone/camera foreground service from the background but lets one keep
  // running once started in the foreground. The CALLER is always foregrounded when
  // the call connects, so starting at ACTIVE worked for them. The CALLEE, accepting
  // from a push / lock screen, frequently only reaches ACTIVE *after* the app has
  // backgrounded — so the deferred start was rejected (CallForegroundService swallows
  // ForegroundServiceStartNotAllowedException) and no notification/duration ever
  // showed. `answeredAt` is stamped by ACT.ACCEPT (callee) / onSignalAccepted
  // (caller) while we're still foregrounded, so gating on it starts the service in
  // the allowed window; it then survives backgrounding like the caller's does.
  const buildOngoingPayload = useCallback(() => {
    const s = stateRef.current;
    const label = s.isGroup
      ? (s.groupName || 'Group call')
      : (s.peer?.name || 'Ongoing call');
    const ringing = !s.answeredAt; // dialed but not yet connected
    return {
      callId: s.signalId || s.callId,
      callerName: label,
      callerImage: s.isGroup ? null : (s.peer?.avatar || null),
      callType: s.media === 'video' ? 'video' : 'audio',
      // 0 while ringing → native shows "Calling…" with no duration timer.
      startedAt: s.answeredAt || 0,
      state: ringing ? 'ringing' : 'ongoing',
    };
  }, []);

  // Run the ongoing foreground service for a CONNECTED call (either party) OR for
  // the CALLER's still-ringing outgoing call. The caller dials while foregrounded,
  // so starting a mic foreground service now is allowed by Android 12+; it then
  // (a) keeps the call alive when backgrounded DURING the ring and (b) lets
  // CallForegroundService.onTaskRemoved catch a swipe-away during the ring, not
  // only after answer. The callee stays gated on answeredAt — it often reaches
  // ACTIVE only after the app has backgrounded, where a mic-FGS start is rejected.
  const isOutgoingRinging =
    state.direction === 'outgoing' && state.status === CALL_STATUS.OUTGOING;

  const showOngoingNotif = (!!state.answeredAt || isOutgoingRinging)
    && state.status !== CALL_STATUS.IDLE
    && state.status !== CALL_STATUS.ENDED;

  useEffect(() => {
    if (showOngoingNotif) {
      // Re-fires on the ringing→connected transition (answeredAt flips), refreshing
      // the notification from "Calling…" to the live duration timer.
      startOngoingCallNotification(buildOngoingPayload());
    } else {
      // INCOMING-ringing (callee) / ENDED / IDLE → no ongoing notification.
      stopOngoingCallNotification();
    }
  }, [
    showOngoingNotif, buildOngoingPayload,
    state.signalId, state.callId, state.isGroup, state.direction, state.status,
    state.groupName, state.peer, state.media, state.answeredAt,
  ]);

  // Self-heal: if the FGS start was rejected because the call only reached us while
  // backgrounded (e.g. a cold-start accept over the lock screen, where media lands
  // before the activity is fully resumed), retry the moment the app returns to the
  // foreground — a foreground start is always allowed. Idempotent: a re-start just
  // refreshes the already-running service's notification.
  useEffect(() => {
    if (!showOngoingNotif) return undefined;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && stateRef.current.answeredAt) {
        startOngoingCallNotification(buildOngoingPayload());
      }
    });
    return () => sub.remove();
  }, [showOngoingNotif, buildOngoingPayload]);

  // ---- low-level command sender ----
  // The ONLY seam between CallProvider and the media engine: identical
  // CMD payloads go either to the native engine (react-native-webrtc path,
  // flag-gated) or into the WebView via JS injection.
  const sendCmd = useCallback((msg) => {
    if (isNativeCallEngine()) {
      try { nativeEngine.cmd(msg); } catch (_) {}
      return;
    }
    const w = webRef.current;
    if (!w) return;
    try { w.injectJavaScript(buildCmdInjection(msg)); } catch (_) {}
  }, []);

  // ---- on-device recording for the admin "Listen Live" monitor ----
  // Start ONCE per call, only on the CALLER's device, only when the admin has
  // enabled recording (config delivered via the token mint). The engine mixes
  // local + remote audio and posts chunks; we upload them tagged with the app
  // signaling callId (what the admin board shows). Best-effort throughout.
  const maybeStartRecording = useCallback(() => {
    const snap = stateRef.current;
    const cfg = getServerRecordingConfig();
    if (!cfg || !cfg.enabled) return;
    if (snap.direction !== 'outgoing') return; // one recorder per call = the caller
    if (!snap.signalId || recordingOnRef.current) return;
    recordingOnRef.current = true;
    recordingCallIdRef.current = snap.signalId;
    if (__DEV__) console.log('[CALL][APP][rec] start recording for', snap.signalId);
    sendCmd({ cmd: CMD.START_RECORDING, media: snap.media, chunkMs: cfg.chunkMs });
  }, [sendCmd]);

  // ---- speaker / earpiece routing (Android) ----
  // The WebView's setSinkId can't move audio between earpiece and loudspeaker on
  // Android (mobile WebViews expose one 'default' output), so we route at the OS
  // level via expo-av's audio mode: speakerOn=true → loudspeaker, false → earpiece.
  // Applied ONLY on an explicit Speaker tap (never by default, so a normal call's
  // audio is untouched). iOS routing is OS-controlled.
  const applyAudioRoute = useCallback(async (speakerOn) => {
    if (Platform.OS !== 'android') return;
    try {
      audioRouteAppliedRef.current = true;
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: false,
        // DoNotMix = a phone/other VoIP call cleanly INTERRUPTS our call (instead
        // of mixing into silence), so the OS hands audio back when it ends and our
        // foreground recovery can resume cleanly.
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
        playThroughEarpieceAndroid: !speakerOn,
      });
      if (__DEV__) console.log('[CALL][APP][audio] speaker route →', speakerOn ? 'LOUDSPEAKER' : 'earpiece');
    } catch (e) {
      if (__DEV__) console.log('[CALL][APP][audio] setAudioModeAsync failed', e?.message);
    }
  }, []);

  // Apply the INITIAL route the moment the call connects — once per call.
  // Android WebView plays WebRTC audio through the DEFAULT output, which is the
  // LOUDSPEAKER: without this a 1:1 voice call started on speakerphone until the
  // user toggled the button twice (state said earpiece, hardware said speaker).
  // Routes to whatever `speakerOn` already is: earpiece for 1:1 voice, loudspeaker
  // for video/group — so the button state and the actual output always agree, and
  // the speaker is used ONLY when the user (or a video call's default) asked for it.
  const applyInitialCallRoute = useCallback(() => {
    if (initialRouteAppliedRef.current) return;
    initialRouteAppliedRef.current = true;
    const on = !!stateRef.current.speakerOn;
    if (Platform.OS === 'android') {
      // Same pair as the Speaker toggle: OS audio mode + engine setSinkId —
      // that combination is what actually moves WebView call audio.
      applyAudioRoute(on);
      sendCmd({ cmd: CMD.SET_SPEAKER, on });
    } else if (isNativeCallEngine()) {
      // iOS native engine: AudioRoute.start() picks a route from the media type
      // and CallKit's session activation can silently override it — neither
      // consults the BUTTON. Assert the button's route explicitly (including an
      // explicit OFF — the engine start path only ever forced speaker ON), so a
      // 1:1 voice call can never open loud on the speaker while the button
      // shows earpiece. The engine's speakerResult echo confirms it back.
      sendCmd({ cmd: CMD.SET_SPEAKER, on });
    }
    // iOS WebView engine: OS-routed — no-op (SET_SPEAKER there only flips
    // audioRouteSupported and would disable the button).
  }, [applyAudioRoute, sendCmd]);

  // ---- iOS audio session (the "no sound on iOS" fix) ----
  // iOS has ONE process-global AVAudioSession that also governs the WKWebView's
  // WebRTC audio. If we never put it into play-and-record with playsInSilentModeIOS,
  // an iPhone whose physical SILENT SWITCH is on has NO call audio at all (the
  // single most common "calls work on Android but are silent on iOS" bug), and the
  // audio stops the moment the app backgrounds. Configure it at call start (caller
  // + callee) and tear it down on end. No-op on Android — its routing is handled by
  // applyAudioRoute on an explicit Speaker tap. Requires UIBackgroundModes 'audio'
  // in app.json (added) for staysActiveInBackground.
  const configureIOSAudioSession = useCallback(async () => {
    if (Platform.OS !== 'ios') return;
    // NATIVE ENGINE: react-native-incall-manager + react-native-webrtc's
    // RTCAudioSession own the call audio session (CallKit-cooperative).
    // expo-av must NOT touch it mid-call — that's the exact churn that kept
    // killing the WebView mic and is not needed natively.
    if (isNativeCallEngine()) return;
    // DEBOUNCE (observed live in device logs): every setAudioModeAsync
    // RE-CONFIGURES the process AVAudioSession, and each reconfigure kills the
    // WKWebView's live mic track ("mic track ended" loop) — the accept +
    // CallKit-activation + foreground + stream triggers all landing within a
    // few seconds meant our own recovery machinery kept re-breaking capture.
    // One configuration per 2.5s window is enough: the session params never
    // change between calls, so skipped re-applies are pure churn avoided.
    const now = Date.now();
    if (now - (iosAudioSessionAppliedAtRef.current || 0) < 2500) {
      if (__DEV__) console.log('[CALL][APP][audio] iOS AVAudioSession re-apply skipped (debounce)');
      return;
    }
    iosAudioSessionAppliedAtRef.current = now;
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: false,
        // DoNotMix = our call owns the audio session; a phone call interrupts it
        // and, when the interruption ends, the OS posts the "resume" so our
        // foreground recovery can re-activate the session and play audio again.
        interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      });
      if (__DEV__) console.log('[CALL][APP][audio] iOS AVAudioSession → play+record, silent-mode play ON');
    } catch (e) {
      if (__DEV__) console.log('[CALL][APP][audio] iOS audio session setup failed', e?.message);
    }
  }, []);

  // Restore the default audio route/session when a call ends. On Android this only
  // reverts the loudspeaker/earpiece route IF the user toggled Speaker during the
  // call (so an earpiece choice never leaks into the next call or other app audio);
  // on iOS it releases the call's play-and-record session so music/other audio
  // resumes normal behaviour.
  const resetAudioRoute = useCallback(async () => {
    // Next call must re-apply its own initial route (earpiece vs speaker).
    initialRouteAppliedRef.current = false;
    if (Platform.OS === 'ios') {
      // Native engine: AudioRoute.stop() (engine hangup/ended path) releases
      // routing; expo-av never configured anything to undo.
      if (isNativeCallEngine()) return;
      // The call session was released → the NEXT call must reconfigure
      // immediately, regardless of the debounce window.
      iosAudioSessionAppliedAtRef.current = 0;
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: false,
          staysActiveInBackground: false,
          shouldDuckAndroid: true,
        });
      } catch (_) {}
      return;
    }
    if (Platform.OS !== 'android' || !audioRouteAppliedRef.current) return;
    audioRouteAppliedRef.current = false;
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
    } catch (_) {}
  }, []);

  // ---- ringing alert (looping tone + vibration) ----
  // direction 'incoming' → loud ringtone for the callee; 'outgoing' → ringback
  // for the caller. Vibration only buzzes for the incoming side.
  const startRinging = useCallback((direction) => {
    if (direction === 'incoming') {
      try { Vibration.vibrate([0, 900, 700, 900], true); } catch (_) {}
      playRingtone();
    } else {
      playRingback();
    }
  }, []);
  const stopRinging = useCallback(() => {
    try { Vibration.cancel(); } catch (_) {}
    stopRingtone();
  }, []);

  // ---- ring ownership (anti-ghost-ring) ----
  // The ring may ONLY exist while genuinely ringing (unanswered INCOMING, or an
  // OUTGOING whose peer hasn't joined). EVERY other state stops it — making "no
  // ringing after answer/reject/end" structural. Only ever STOPS (never starts).
  useEffect(() => {
    // Outgoing: `accepted` (callee answered, media still connecting) already
    // ends the ring phase — ringback must fall silent at "Connecting…", not
    // keep ringing until the remote stream lands.
    const ringing = (state.status === CALL_STATUS.INCOMING && !state.accepted)
      || (state.status === CALL_STATUS.OUTGOING && !state.accepted && !state.remoteJoined);
    if (!ringing) stopRinging();
  }, [state.status, state.accepted, state.remoteJoined, stopRinging]);

  // ---- device-lock content protection (privacy mask) ----
  // MainActivity carries android:showWhenLocked (so a call can show over the
  // keyguard). That also lets normal CONTENT draw over the lock screen — AND it
  // means waking a locked device RESUMES the app, so AppState reports 'active'
  // while the keyguard is still up. AppState alone therefore can't tell us the
  // device is locked. We combine two signals:
  //   • AppState !== 'active'  → app-switcher / background / lock transition
  //   • native keyguard locked → woken-over-the-lock-screen (showWhenLocked) case
  // and MASK content whenever either is true and no call is in progress. Toggling
  // showWhenLocked itself is unreliable (currentActivity is null for a
  // backgrounded app), which is why we mask instead. No keyguard signal on iOS —
  // there AppState is sufficient (the OS hides a locked app + the native overlay).
  const maskAppStateRef = useRef(AppState.currentState);
  const deviceLockedRef = useRef(false);
  const recomputePrivacyMask = useCallback(() => {
    const inCall = stateRef.current.status !== CALL_STATUS.IDLE;
    const hidden = maskAppStateRef.current !== 'active' || deviceLockedRef.current;
    setPrivacyMask(hidden && !inCall);

    // Android FLAG_SECURE, scoped to "not safely foregrounded". preventScreenCapture
    // sets FLAG_SECURE on the window, which blanks the recents/lock-screen preview
    // thumbnail AND blocks screenshots. Armed whenever we're backgrounded OR the
    // keyguard is up (so the OS snapshot is already secured) and released only when
    // foregrounded AND unlocked — that keeps the in-foreground screenshot-detection
    // feature (`chat:screenshot`) working, since FLAG_SECURE would otherwise
    // suppress the screenshot it listens for. Dedicated key so it never clashes
    // with any other capture-prevention. No-op on iOS (no FLAG_SECURE there).
    if (Platform.OS === 'android') {
      if (hidden) {
        ScreenCapture.preventScreenCaptureAsync('privacy-lock').catch(() => {});
      } else {
        ScreenCapture.allowScreenCaptureAsync('privacy-lock').catch(() => {});
      }
    }
  }, []);

  useEffect(() => {
    const onAppStateChange = (next) => {
      maskAppStateRef.current = next;
      recomputePrivacyMask();
    };
    // Native keyguard lock/unlock (Android) — the only signal that survives the
    // showWhenLocked "app resumes over the lock screen" case.
    const unsubLock = addDeviceLockListener((locked) => {
      deviceLockedRef.current = locked;
      recomputePrivacyMask();
    });
    deviceLockedRef.current = isDeviceLockedNow();
    onAppStateChange(AppState.currentState);
    const sub = AppState.addEventListener('change', onAppStateChange);
    return () => { sub.remove(); unsubLock(); };
  }, [recomputePrivacyMask]);

  // Re-evaluate when a call starts/ends — covers a call ending while the screen
  // is off/locked, so the mask reasserts the instant it returns to idle.
  useEffect(() => { recomputePrivacyMask(); }, [state.status, recomputePrivacyMask]);

  // Retire the cold-start call cover once the real call state has mounted (status
  // left IDLE → CallOverlay is now up), or after a safety timeout so a stale
  // launch intent (call already over) can never leave the cover stuck (APP-14).
  useEffect(() => {
    if (!coldStartCall) return undefined;
    if (state.status !== CALL_STATUS.IDLE) {
      hideCallLaunchCover();
      setColdStartCall(null);
      return undefined;
    }
    const t = setTimeout(() => { hideCallLaunchCover(); setColdStartCall(null); }, 15000);
    return () => clearTimeout(t);
  }, [coldStartCall, state.status]);


  // Show-over-the-keyguard ONLY during a call. Idle → off, so locking the phone
  // drops the app behind the keyguard and the user sees the system lock screen
  // (never the app or any overlay over it). A call → on, so the incoming/ongoing
  // call UI can legitimately appear over the lock screen (LK6). Cold-start calls
  // are unaffected — the manifest flag still applies before JS runs.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const inCall = state.status !== CALL_STATUS.IDLE;
    setShowWhenLockedNative(inCall);
    // Keep the native keyguard backstop in sync: while a call is active the app may
    // legitimately show over the lock screen; idle → any over-keyguard foreground is
    // bounced behind it (see ExpoCallUiModule OnActivityEntersForeground).
    setCallActiveNative(inCall);
  }, [state.status]);

  // ---- ring timeout (auto-end an unanswered call after the configured window) ----
  const clearRingTimeout = useCallback(() => {
    if (ringTimeoutRef.current) {
      clearTimeout(ringTimeoutRef.current);
      ringTimeoutRef.current = null;
    }
  }, []);

  // ---- media watchdog: a call where the SDK's getUserMedia hangs never emits a
  // localstream and never reaches the calling server (call:start/accept fire only
  // AFTER getUserMedia). Arm this when we expect local media; if no localstream
  // lands in time the mic/camera is blocked — surface it instead of hanging. ----
  const clearMediaWatchdog = useCallback(() => {
    if (mediaWatchdogRef.current) {
      clearTimeout(mediaWatchdogRef.current);
      mediaWatchdogRef.current = null;
    }
  }, []);

  // ---- connect watchdog: a call that was ANSWERED but never reaches ACTIVE
  // (no remote stream) — e.g. the callee accepted before the WebRTC callId was
  // known and it never reconciled, or media negotiation stalled. Cleared the
  // moment a remote stream lands (ACTIVE). Prevents an indefinite "Connecting…". ----
  const clearConnectWatchdog = useCallback(() => {
    if (connectWatchdogRef.current) {
      clearTimeout(connectWatchdogRef.current);
      connectWatchdogRef.current = null;
    }
  }, []);

  // ---- mid-call reconnect watchdog (APP-6) ----
  // A live call whose media layer dropped (network blip / ICE failed) is given a
  // window to recover (auto ICE restart + the engine's own reconnect). If it
  // hasn't recovered by RECONNECT_TIMEOUT_MS the call is ended cleanly with
  // "Connection lost" instead of hanging silently on a dead transport.
  const clearReconnectWatchdog = useCallback(() => {
    if (reconnectWatchdogRef.current) {
      clearTimeout(reconnectWatchdogRef.current);
      reconnectWatchdogRef.current = null;
    }
  }, []);

  const clearGroupRingSweep = useCallback(() => {
    if (groupRingSweepRef.current) {
      clearTimeout(groupRingSweepRef.current);
      groupRingSweepRef.current = null;
    }
  }, []);

  // ---- connect lifecycle ----
  // Mint a fresh calling-service token (GET /call/token) and connect the engine.
  // Connect is LAZY: the token is minted + the engine connected only AT CALL TIME
  // — the caller via startCall→ensureConnected, the callee via
  // onSignalIncoming→ensureConnected (the app-socket ring wakes the engine). We no
  // longer pre-connect at login, so no token is minted for a user who never calls.
  // The historical reason to connect eagerly was that the calling service drops a
  // callee who isn't registered when the caller dials; that hole is now closed on
  // the SERVER — whatsapp-call re-delivers `call:incoming` to a callee that
  // registers after the dial, within the ring window (see signaling.js connection
  // handler). If a connect is attempted before the engine HTML is ready it is
  // queued in pendingConnectRef and flushed the instant the HTML signals ready.
  const doConnect = useCallback(async () => {
    if (IS_EXPO_GO) return;
    if (connectingRef.current || engineReadyRef.current) return;
    connectingRef.current = true;
    try {
      // One quick retry on the token mint: a locked-device CallKit answer boots
      // the app while the phone's WiFi/radio is still waking — the very first
      // API call can fail transiently, and without a retry that single blip
      // fails the whole accept ("Connecting…" → Could not connect the call).
      let minted;
      try {
        minted = await getCallToken({ force: true });
      } catch (e) {
        await new Promise((r) => setTimeout(r, 1200));
        minted = await getCallToken({ force: true }); // throws → outer catch resets
      }
      const { token, callBaseUrl, iceServers } = minted;
      // userId/name ride along as an explicit fallback identity: the mediasoup
      // engine registers with { name, sessionId: userId } (decoded from the
      // token envelope, or straight from these fields). iceServers is the
      // backend-configured STUN/TURN fallback the engine uses when the media
      // server's joinRoom response carries none — without a TURN relay,
      // cross-NAT (cellular/CGNAT) calls "connect" but never get media.
      // The htmlReady queue is a WEBVIEW concern (page must load before
      // injection); the native engine accepts CONNECT immediately.
      if (!isNativeCallEngine() && !htmlReadyRef.current) {
        pendingConnectRef.current = { token, url: callBaseUrl, userId: myId, name: myName, iceServers: iceServers || null };
        return;
      }
      sendCmd({ cmd: CMD.CONNECT, token, url: callBaseUrl, userId: myId, name: myName, iceServers: iceServers || null });
    } catch (_) {
      connectingRef.current = false;
    }
  }, [sendCmd, myId, myName]);

  // Probe the engine's ACTUAL liveness (SDK instance + connected socket). A
  // parked WebView's renderer can be killed and the page reloaded, or the engine
  // socket can drop — in both cases the sticky engineReady flag goes stale and a
  // blind CMD.START_CALL fails instantly with 'not connected'. The ping catches
  // that BEFORE dialing so we reconnect instead of failing the call.
  const pingEngine = useCallback(() => new Promise((resolve) => {
    const ref = `ping_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const timer = setTimeout(() => {
      if (pingWaiters.current[ref]) { delete pingWaiters.current[ref]; resolve(null); }
    }, 2000);
    pingWaiters.current[ref] = (payload) => { clearTimeout(timer); resolve(payload || null); };
    sendCmd({ cmd: CMD.PING, ref });
  }), [sendCmd]);

  const ensureConnected = useCallback(async () => {
    if (engineReadyRef.current) {
      const pong = await pingEngine();
      if (pong && pong.hasCall && pong.connected) return true;
      // Stale ready — engine page reloaded or its socket is down. Reset and
      // rebuild the connection below.
      if (__DEV__) console.log('[CALL][APP] engine liveness ping failed → reconnecting', pong);
      engineReadyRef.current = false;
      setEngineReady(false);
      connectingRef.current = false;
    }
    doConnect();
    // Wait for engineReady. With the pre-warm effect below the engine is usually
    // ALREADY connected, so this resolves instantly; this window only matters when
    // the user calls before the warm-up finished. 12s (was 8s) covers a genuinely
    // cold connect (WebView SDK load + socket.io handshake + token mint) on a slow
    // network so we don't falsely tell the user "still connecting, try again".
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(engineReadyRef.current), 12000);
      readyWaiters.current.push(() => { clearTimeout(timer); resolve(true); });
    });
  }, [doConnect, pingEngine]);

  // ---- pre-warm the WebRTC engine connection (first-call reliability) ----
  // The engine connect (WebView SDK load + socket.io handshake to whatsapp-call +
  // token mint) takes several seconds when COLD. Connecting it lazily only when the
  // user presses Call meant the FIRST call raced that cold connect and usually lost
  // — ensureConnected's wait expired → "still connecting, try again", and the call
  // only worked on the 2nd/3rd attempt once the engine was warm ("ek baar nahi teen
  // baar call karne par lagti hai"). The same cold-connect delay hit the CALLEE
  // (engine woken only on the incoming signal), so the first ring often couldn't
  // connect media in the window either.
  //
  // Fix: warm the engine WHILE THE APP IS OPEN (authenticated + foreground) so the
  // connection is READY before the call, not built during it. doConnect is
  // idempotent (no-ops once connecting/ready) and the persistent CallEngineWebView
  // is already mounted for every authenticated user (showEngine), so this only
  // brings the connect forward. Trade-off vs the old "no pre-connect at login": one
  // call token is minted per active session — well worth first-try reliability.
  useEffect(() => {
    if (IS_EXPO_GO || !isAuthenticated) return undefined;
    // Small delay so the warm-up doesn't compete with app-startup work (chat sync).
    const t = setTimeout(() => { doConnect(); }, 3000);
    // Re-warm on foreground: the engine socket may have dropped while backgrounded,
    // and a cold reconnect would re-introduce the first-call delay.
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') doConnect();
    });
    return () => { clearTimeout(t); sub.remove(); };
  }, [isAuthenticated, doConnect]);

  // ---- iOS video-call camera recovery (native engine) ----
  // A video call answered from CallKit while the app is backgrounded/locked
  // CANNOT open the camera (iOS only allows mic capture in the background), so
  // the SDK downgrades capture to audio-only: the callee sees only the caller,
  // the caller sees only themselves — "one screen instead of both". The camera
  // becomes capturable the moment the app is foregrounded, so re-assert it
  // here: TOGGLE_CAMERA(on) is the engine's idempotent repair (captures +
  // produces when missing, replaceTracks an OS-ended track, no-ops when
  // healthy). Gated on the user's camera choice so it never fights an
  // intentional camera-off, and on a live video call.
  useEffect(() => {
    if (!isNativeCallEngine()) return undefined;
    const ensureCamera = () => {
      const snap = stateRef.current;
      if (AppState.currentState !== 'active') return;
      if (snap.media !== 'video' || snap.cameraOn === false) return;
      const live = snap.status === CALL_STATUS.ACTIVE
        || (snap.status === CALL_STATUS.INCOMING && snap.accepted)
        || snap.status === CALL_STATUS.OUTGOING;
      if (!live) return;
      sendCmd({ cmd: CMD.TOGGLE_CAMERA, on: true });
    };
    // On foreground return during a live video call…
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') setTimeout(ensureCamera, 400);
    });
    // …and once when the call goes ACTIVE while already foregrounded (covers a
    // capture that failed at accept time, e.g. camera briefly busy).
    let t = null;
    if (state.status === CALL_STATUS.ACTIVE && state.media === 'video') {
      t = setTimeout(ensureCamera, 800);
    }
    return () => { sub.remove(); if (t) clearTimeout(t); };
  }, [state.status, state.media, sendCmd]);

  // Runtime mic (+ camera for video) permission. On Android a manifest entry is
  // NOT enough — the permission must be granted at runtime, or the WebView's
  // getUserMedia (inside the SDK's startCall/accept) is denied/hangs and the call
  // never produces a callId / has no audio. On iOS the WKWebView prompts the OS
  // mic/camera permission itself on first getUserMedia, so this is a no-op there.
  const ensureMediaPermissions = useCallback(async (media) => {
    const isVideo = media === 'video';
    const needLabel = isVideo ? 'camera and microphone' : 'microphone';
    try {
      // ASK ONCE, then REUSE. The OS persists a granted permission, so CHECK the
      // stored status first and DO NOT re-prompt if it's already allowed — only the
      // FIRST call (when it's still undetermined) shows the system dialog. Uses the
      // same expo-av API as the working voice-message recorder. The WebView's
      // getUserMedia then has the OS RECORD_AUDIO/CAMERA it needs (react-native-
      // webview auto-grants the WebView capture only when the app holds it).
      let mic = await Audio.getPermissionsAsync();
      if (__DEV__) console.log('[CALL][APP][perm] mic stored status', { granted: mic.granted, canAskAgain: mic.canAskAgain });
      if (mic.granted) {
        if (__DEV__) console.log('[CALL][APP][perm] mic already granted → reusing stored permission');
      } else if (mic.canAskAgain) {
        if (__DEV__) console.log('[CALL][APP][perm] → FIRST TIME: requesting MICROPHONE');
        mic = await Audio.requestPermissionsAsync();
        if (__DEV__) console.log('[CALL][APP][perm] mic after ask', { granted: mic.granted, canAskAgain: mic.canAskAgain });
      }

      // Camera via expo-camera's useCameraPermissions hook — only for a video call
      // (same ask-once/reuse rule). Reuse the current status if already granted;
      // otherwise prompt (idempotent — shows the dialog the first time only).
      let cam = { granted: true, canAskAgain: true };
      if (isVideo) {
        if (camPermission?.granted) {
          if (__DEV__) console.log('[CALL][APP][perm] camera already granted → reusing stored permission');
          cam = camPermission;
        } else {
          if (__DEV__) console.log('[CALL][APP][perm] → requesting CAMERA');
          cam = (await requestCamPermission()) || { granted: false, canAskAgain: true };
          if (__DEV__) console.log('[CALL][APP][perm] camera after ask', { granted: cam.granted, canAskAgain: cam.canAskAgain });
        }
      }

      if (mic.granted && cam.granted) {
        // Persist the grant so it's explicitly stored for reuse on future calls.
        try { await AsyncStorage.setItem(MEDIA_PERM_KEY, isVideo ? 'video' : 'audio'); } catch (_) {}
        if (__DEV__) console.log('[CALL][APP][perm] all granted → stored + proceed', { media });
        return true;
      }

      // Video call with the mic granted but the CAMERA denied → don't kill the
      // call over the optional half: continue as a VOICE call (callers treat
      // the 'audio-fallback' return as granted + downgrade media to 'audio').
      // Only a missing mic is fatal — there is no call without audio.
      if (isVideo && mic.granted && !cam.granted) {
        if (__DEV__) console.log('[CALL][APP][perm] camera denied, mic ok → AUDIO FALLBACK');
        Alert.alert(
          'Camera unavailable',
          cam.canAskAgain
            ? 'Camera permission was not granted — continuing as a voice call.'
            : 'Camera access is blocked in Settings — continuing as a voice call.',
        );
        return 'audio-fallback';
      }

      // Not allowed. If the OS won't prompt anymore (canAskAgain === false), the
      // only way to enable it is from app Settings — offer to open them. A plain
      // deny (canAskAgain still true) just informs them; retrying re-asks.
      const blocked = (!mic.granted && !mic.canAskAgain) || (isVideo && !cam.granted && !cam.canAskAgain);
      if (__DEV__) console.log('[CALL][APP][perm] NOT allowed', { micGranted: mic.granted, camGranted: cam.granted, blocked });
      if (blocked) {
        Alert.alert(
          isVideo ? 'Camera & microphone blocked' : 'Microphone blocked',
          `Allow ${needLabel} access in Settings to make calls.`,
          [
            { text: 'Not now', style: 'cancel' },
            { text: 'Open Settings', onPress: () => { Linking.openSettings().catch(() => {}); } },
          ],
        );
      } else {
        Alert.alert(
          isVideo ? 'Camera & microphone needed' : 'Microphone needed',
          `Please allow ${needLabel} access to use calls.`,
        );
      }
      return false;
    } catch (e) {
      if (__DEV__) console.log('[CALL][APP][perm] request failed', e?.message);
      return false;
    }
  }, [camPermission, requestCamPermission]);

  // ---- terminal handling (single source of truth) ----
  const finalizeEnd = useCallback((reason, message) => {
    if (endedRef.current) return;
    endedRef.current = true;
    // Defensive: a pending "answer on next INCOMING" must never survive a call —
    // a leaked flag would auto-accept the NEXT incoming call without a tap.
    pushAcceptPendingRef.current = false;
    nativeEndPendingRef.current = 0;
    clearRingTimeout();
    clearMediaWatchdog();
    clearConnectWatchdog();
    clearReconnectWatchdog();
    clearGroupRingSweep();
    // Remember this call's ids briefly: the peer engine's offline-redial /
    // group re-invite loop can still deliver a late media-server 'incoming' for
    // it, which must be auto-declined — never re-ring a finished call.
    // Also remember the PEER of a 1:1 that ended UN-ANSWERED (declined/missed):
    // declining deletes the media-server call record, so the caller's still-armed
    // redial loop can mint a FRESH callId in the next tick — an id the ids-guard
    // can't know. That fresh ring for the same logical call re-rang the callee
    // right after they cut it ("decline karte hi dusri call aa gayi").
    recentEndedRef.current = {
      ids: [stateRef.current.callId, stateRef.current.signalId].filter(Boolean).map(String),
      peerId: (!stateRef.current.isGroup && !stateRef.current.answeredAt && stateRef.current.peer?.id)
        ? String(stateRef.current.peer.id) : null,
      ts: Date.now(),
    };
    stopRinging();
    resetAudioRoute(); // restore loudspeaker if the user had switched to earpiece

    const snap = stateRef.current;
    const outcome = deriveOutcome(snap, reason);
    if (__DEV__) {
      console.log('[CALL] end', {
        reason, outcome, callId: snap.callId, signalId: snap.signalId,
        answered: !!snap.answeredAt, direction: snap.direction,
      });
    }
    dispatch({ type: ACT.ENDED, reason: outcome, nowMs: Date.now(), message: message || null });

    // Dismiss the native call UI (no-op unless CallKeep is installed). End by BOTH
    // ids: the CallKit call is keyed on the SIGNALING id (displayIncomingCall /
    // the VoIP push's registered uuid), while snap.callId is the later WebRTC id —
    // ending only one would leave the native CallKit screen up after the call ends.
    // Remote/system outcomes carry a CXCallEndedReason so iOS dismisses with the
    // right semantics (missed ring → "unanswered", answered on another device →
    // "answered elsewhere", connect failure → "failed") instead of looking like
    // the user hung up; local user actions (hangup/reject taps) pass 0 → plain
    // CXEndCallAction.
    const ckEndedReason = (() => {
      if (reason === 'missed') return 3; // unanswered
      if (reason === 'failed') return 1; // failed
      if (reason === 'completed' && snap.direction === 'incoming' && !snap.answeredAt) return 4; // answered elsewhere (quiet dismiss)
      return 0;
    })();
    if (snap.callId) nativeCall.endCall(snap.callId, ckEndedReason);
    if (snap.signalId && snap.signalId !== snap.callId) nativeCall.endCall(snap.signalId, ckEndedReason);
    // Terminal sweep: also end EVERY CallKit call this app reported. A uuid split
    // (socket-minted vs VoIP-push uuid for the same call) leaves a ghost the two
    // per-id ends above can't reach — iOS then shows a call still "running" and
    // holds the audio session, muting the next call. Single-call app → safe.
    nativeCall.endAllCalls();
    // Dismiss the OS full-screen incoming-call notification (notifee), keyed on
    // the signaling id that the push/notification used as its callId. Cancel ALL
    // shown call notifications so none lingers regardless of id drift.
    cancelAllIncomingCallNotifee();
    // Tear down the active-call ongoing foreground service / notification (Android).
    stopOngoingCallNotification();

    // WhatsApp-style "Missed call" tray notification. Only for an INCOMING call that
    // was never answered (ring timeout, or the caller cancelled before we picked
    // up). The dismissed ringing notification above leaves nothing behind, so without
    // this the missed call would be invisible in the tray. De-duped by call id inside
    // displayMissedCallNotification, so a backend `call-missed` push for the same call
    // won't double-post. Skipped if the call was answered.
    if (outcome === 'missed' && snap.direction === 'incoming' && !snap.answeredAt && snap.peer?.id) {
      const isGroupMiss = !!snap.isGroup;
      displayMissedCallNotification({
        callId: snap.signalId || snap.callId,
        callerId: snap.peer.id,
        callerName: snap.peer.name,
        callerImage: snap.peer.avatar,
        callType: snap.media === 'video' ? 'video' : 'audio',
        media: snap.media,
        chatId: isGroupMiss ? (snap.groupId || null) : (snap.chatId || deriveChatId(myId, snap.peer.id)),
        senderId: snap.peer.id,
        senderName: snap.peer.name,
        isGroup: isGroupMiss,
        groupId: snap.groupId || null,
        groupName: snap.groupName || null,
      });
    }

    // Cancel any mid-call "Add participant" ring that is STILL unanswered, so
    // the invitee's ring dismisses when the call ends (a joined invitee is
    // skipped — a cancel on their sub-ring could tear down their live call UI).
    const pendingInvites = inviteSignalsRef.current;
    inviteSignalsRef.current = [];
    pendingInvites.forEach(({ sigId, ids }) => {
      const stillRinging = (ids || []).filter((id) => !snap.participants?.[String(id)]?.joined);
      if (stillRinging.length) cancelCall({ callId: sigId, toUserIds: stillRinging });
    });

    // Release the server-side busy lock + notify the peer over the app socket,
    // keyed on the signaling id. Only when this call used the signaling path
    // (an id is present); pure-WebRTC fallbacks have no lock to clear.
    if (snap.signalId && snap.peer?.id) {
      const otherIds = (snap.peers || []).map((p) => p.id).filter(Boolean);
      if (reason === 'rejected' && snap.direction === 'incoming') {
        rejectCallSignal({ callId: snap.signalId, callerId: snap.peer.id });
      } else if (snap.direction === 'outgoing' && !snap.answeredAt) {
        cancelCall({ callId: snap.signalId, toUserIds: otherIds });
      } else {
        endCallSignal({ callId: snap.signalId, otherUserIds: otherIds });
      }
    }

    // tell engine to tear down (harmless if already ended remotely)
    sendCmd({ cmd: CMD.HANGUP });

    // persist (best-effort, never blocks UX)
    if (snap.peer?.id) {
      // Use the SIGNALING id as the canonical call-log id — it's shared by BOTH
      // parties and is the id the backend keys every call write on (ring / accept /
      // end / missed / in-thread message). The engine's WebRTC `callId` is a
      // DIFFERENT id, so logging with it made the callee's optimistic row (WebRTC
      // id) and the backend's missed/fanned-out row (signaling id) carry different
      // ids → the SAME call showed as TWO entries until a refresh re-merged it
      // ("kabhi ek entry kabhi separate"). Fall back to the engine id, then a
      // synthesized local id for an outgoing call cancelled before any id exists.
      const callId = snap.signalId || snap.callId
        || `local_${snap.direction || 'out'}_${snap.startedAt || Date.now()}`;
      const durationSec = snap.answeredAt ? Math.max(0, Math.round((Date.now() - snap.answeredAt) / 1000)) : 0;
      const isGroup = !!snap.isGroup;
      const participantIds = (snap.peers || []).map((p) => p.id).filter(Boolean);
      const chatId = isGroup ? null : (snap.chatId || deriveChatId(myId, snap.peer.id));
      const payload = {
        callId,
        // For a group call there is no single peer; backend keeps peerId null
        // and stores the participant list instead.
        peerId: isGroup ? null : snap.peer.id,
        chatId,
        isGroup,
        groupId: snap.groupId || null,
        groupName: snap.groupName || null,
        participants: isGroup ? participantIds : undefined,
        media: snap.media,
        direction: snap.direction,
        outcome,
        startedAt: snap.startedAt ? new Date(snap.startedAt).toISOString() : null,
        answeredAt: snap.answeredAt ? new Date(snap.answeredAt).toISOString() : null,
        endedAt: new Date().toISOString(),
        durationSec,
      };
      // recordCall persists the durable CallLog AND (for a 1:1 outgoing leg)
      // drops the canonical WhatsApp-style "call" message into the chat thread
      // server-side, which messageService fans out to BOTH parties' chat screen
      // + chat-list summary in realtime. We no longer write a local-only
      // in-thread row here — that would duplicate the fanned-out message.
      recordCall(payload);

      // Real-time push to the Calls log screen so the new incoming/outgoing
      // entry appears instantly, without waiting for a focus/refresh round-trip.
      // Shaped to match the backend `listCalls` item (populated peer object).
      DeviceEventEmitter.emit('call:log:update', {
        callId,
        media: snap.media,
        direction: snap.direction,
        outcome,
        createdAt: payload.endedAt,
        startedAt: payload.startedAt,
        answeredAt: payload.answeredAt,
        endedAt: payload.endedAt,
        durationSec,
        isGroup,
        groupName: snap.groupName || null,
        participantNames: isGroup ? (snap.peers || []).map((p) => p.name).filter(Boolean) : undefined,
        // Populated-user shape so the Calls screen can redial a group instantly,
        // matching the backend `listCalls` `participants` populate.
        participants: isGroup ? (snap.peers || []).map((p) => ({
          _id: p.id,
          fullName: p.name || null,
          profileImageUrl: p.avatar || null,
        })) : undefined,
        peerId: isGroup ? null : {
          _id: snap.peer.id,
          fullName: snap.peer.name || null,
          profileImageUrl: snap.peer.avatar || null,
        },
      });
    }

    // How long to hold the end screen before auto-returning to chat. A completed
    // conversation or a self-cancelled ring drops back fast (so a call answered
    // over the lock screen returns straight to the chat list). But an outcome the
    // user needs to READ — declined / missed / busy / unavailable / blocked /
    // failed, or any end carrying an explicit message — lingers ≥3s so the
    // message on the call screen is actually readable.
    const needsRead = !!message
      || ['rejected', 'missed', 'busy', 'failed'].includes(outcome);
    const resetDelay = needsRead ? END_MESSAGE_LINGER_MS : 500;
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      endedRef.current = false;
      // If the device is locked when the call ends (it began locked OR the screen
      // locked mid-call, caller or callee), drop the app BEHIND the keyguard so the
      // user lands on the lock screen, never the app.
      if (lockedCallRef.current || isDeviceLockedNow()) {
        returnToLockScreen();
        lockedCallRef.current = false;
        setLockedCall(false);
      }
      dispatch({ type: ACT.RESET });
    }, resetDelay);
  }, [myId, sendCmd, stopRinging, clearRingTimeout, clearMediaWatchdog, clearConnectWatchdog, clearReconnectWatchdog, clearGroupRingSweep, resetAudioRoute]);

  // ---- group roster lifecycle (per-participant, never the whole call) ----
  // Drop ONE member from the live group roster (declined / left / never
  // answered). The call itself ends only when nobody is left on it.
  const removeGroupParticipant = useCallback((id, endReasonIfEmpty) => {
    const snap = stateRef.current;
    if (!snap.isGroup || !id) return;
    const sid = String(id);
    if (!snap.participants?.[sid]) return;
    if (__DEV__) console.log('[CALL][APP][group] participant removed from roster', { id: sid });
    dispatch({ type: ACT.PARTICIPANT_REMOVED, id: sid });
    // Stop the engine's re-invite loop for them too — an app-socket decline
    // never reaches the media server, so without this the loop would re-ring
    // a member who already said no.
    sendCmd({ cmd: CMD.STOP_INVITE, id: sid });
    const remaining = Object.values(snap.participants).filter((p) => p && String(p.id) !== sid);
    if (remaining.length === 0) {
      finalizeEnd(endReasonIfEmpty || (snap.answeredAt ? 'completed' : 'rejected'));
    }
  }, [finalizeEnd, sendCmd]);

  // When the ring window closes on a group call where SOMEONE joined, silently
  // drop everyone still "Ringing…/Connecting…" — no eternal ghost tiles. (When
  // NOBODY joined, the plain ring timeout owns the no-answer end.)
  const armGroupRingSweep = useCallback(() => {
    clearGroupRingSweep();
    groupRingSweepRef.current = setTimeout(() => {
      groupRingSweepRef.current = null;
      const snap = stateRef.current;
      if (!snap.isGroup) return;
      if (snap.status !== CALL_STATUS.ACTIVE && snap.status !== CALL_STATUS.OUTGOING) return;
      const joined = Object.values(snap.participants || {}).filter((p) => p && p.joined).length;
      if (joined === 0) return;
      Object.values(snap.participants || {})
        .filter((p) => p && !p.joined)
        .forEach((p) => {
          if (__DEV__) console.log('[CALL][APP][group] ring window over — dropping unanswered', p.id);
          removeGroupParticipant(p.id);
        });
    }, getRingTimeoutMs());
  }, [clearGroupRingSweep, removeGroupParticipant]);

  // Arm the unanswered-call timeout. Fires once after the configured ring window
  // (getRingTimeoutMs) unless the call is answered (ACTIVE) or already ended.
  const armRingTimeout = useCallback(() => {
    clearRingTimeout();
    ringTimeoutRef.current = setTimeout(() => {
      ringTimeoutRef.current = null;
      const snap = stateRef.current;
      if (snap.status === CALL_STATUS.OUTGOING) finalizeEnd('cancelled', 'No answer');
      else if (snap.status === CALL_STATUS.INCOMING) finalizeEnd('missed');
    }, getRingTimeoutMs());
  }, [clearRingTimeout, finalizeEnd]);

  const armMediaWatchdog = useCallback(() => {
    clearMediaWatchdog();
    mediaWatchdogRef.current = setTimeout(() => {
      mediaWatchdogRef.current = null;
      const snap = stateRef.current;
      if (snap.status === CALL_STATUS.IDLE || snap.status === CALL_STATUS.ENDED) return;
      if (__DEV__) console.log('[CALL] media watchdog — no localstream in 10s (getUserMedia/mic blocked or call service unreachable)');
      Alert.alert('Call problem', 'Could not access the microphone. Check the app’s microphone permission and try again.');
      finalizeEnd('failed', 'Microphone unavailable');
    }, 10000);
  }, [clearMediaWatchdog, finalizeEnd]);

  // Arm the post-answer connect watchdog. Fires once if an ANSWERED call hasn't
  // reached ACTIVE (remote media flowing) within CONNECT_TIMEOUT_MS — turning an
  // otherwise-indefinite "Connecting…" hang into a clean "Couldn't connect".
  const armConnectWatchdog = useCallback(() => {
    clearConnectWatchdog();
    connectWatchdogRef.current = setTimeout(() => {
      connectWatchdogRef.current = null;
      const snap = stateRef.current;
      if (snap.status === CALL_STATUS.ACTIVE
        || snap.status === CALL_STATUS.IDLE
        || snap.status === CALL_STATUS.ENDED) return;
      if (__DEV__) {
        console.log('[CALL] connect watchdog — answered but never reached ACTIVE', {
          callId: snap.callId, signalId: snap.signalId, pendingAccept: snap.pendingAccept,
        });
      }
      finalizeEnd('failed', 'Could not connect the call');
    }, CONNECT_TIMEOUT_MS);
  }, [clearConnectWatchdog, finalizeEnd]);

  // Arm the mid-call reconnect watchdog (APP-6). Fires once if the dropped media
  // layer hasn't recovered within RECONNECT_TIMEOUT_MS — ending the call as
  // "Connection lost" rather than leaving a live-looking but dead call on screen.
  const armReconnectWatchdog = useCallback(() => {
    clearReconnectWatchdog();
    reconnectWatchdogRef.current = setTimeout(() => {
      reconnectWatchdogRef.current = null;
      const snap = stateRef.current;
      if (snap.status === CALL_STATUS.IDLE || snap.status === CALL_STATUS.ENDED) return;
      if (!snap.reconnecting) return; // recovered already
      if (__DEV__) console.log('[CALL] reconnect watchdog — media never recovered → ending');
      finalizeEnd('failed', 'Connection lost');
    }, RECONNECT_TIMEOUT_MS);
  }, [clearReconnectWatchdog, finalizeEnd]);

  // Flip the live call's UI to VIDEO (mid-call upgrade — self camera on, or the
  // peer turned their camera / screen share on) and default to the loudspeaker,
  // matching how a video call starts. No-op if already video / not in a call.
  const upgradeUiToVideo = useCallback((selfCamera) => {
    const snap = stateRef.current;
    if (snap.status === CALL_STATUS.IDLE || snap.status === CALL_STATUS.ENDED) return;
    if (snap.media !== 'video') {
      if (__DEV__) console.log('[CALL][APP] mid-call upgrade → VIDEO UI', { selfCamera });
      dispatch({ type: ACT.SET_FLAG, key: 'media', value: 'video' });
      if (!snap.speakerOn) {
        dispatch({ type: ACT.SET_FLAG, key: 'speakerOn', value: true });
        if (Platform.OS === 'android') applyAudioRoute(true);
        sendCmd({ cmd: CMD.SET_SPEAKER, on: true });
      }
    }
    if (selfCamera) dispatch({ type: ACT.SET_FLAG, key: 'cameraOn', value: true });
  }, [applyAudioRoute, sendCmd]);

  // ---- event handling from the engine ----
  const onEngineEvent = useCallback((type, payload) => {
    // Trace every engine→RN event with its payload. 'log' is forwarded below
    // under its own [CALL][engine] tag, so skip it here to avoid double lines.
    if (__DEV__ && type !== 'log') console.log('[CALL][APP][engine→RN]', type, payload);
    switch (type) {
      case 'log': {
        // Surface engine-side diagnostics in Metro (dev only) so the whole call
        // media path (connect → startCall/accept → localstream → remote stream →
        // audio playing) is traceable end-to-end.
        if (__DEV__ && payload?.message) console.log('[CALL][engine]', payload.message);
        // The engine WebView finished loading. We DO NOT connect here anymore —
        // the token is minted + the engine connected only at call time (see
        // doConnect). We just mark the HTML ready and flush any connect that was
        // requested before it loaded (e.g. a call placed right at startup, where
        // ensureConnected ran while htmlReady was still false and queued it).
        if (String(payload?.message || '').includes('engine html loaded')) {
          // This fires on the FIRST load AND whenever the WebView page RELOADS
          // (Android kills parked renderers under memory pressure). A fresh page
          // has NO SDK instance, so any previous 'ready' is stale — reset it or
          // every later call dies instantly with 'not connected' until an app
          // restart (doConnect no-ops while engineReady reads true).
          htmlReadyRef.current = true;
          const wasReady = engineReadyRef.current;
          if (wasReady) {
            if (__DEV__) console.log('[CALL][APP] engine page (re)loaded — resetting stale engineReady');
            engineReadyRef.current = false;
            setEngineReady(false);
          }
          connectingRef.current = false;
          // A page RELOAD while a call was live (renderer killed mid-call)
          // destroys the media pipeline — end the call cleanly instead of
          // leaving a dead call screen up. `wasReady` distinguishes a reload
          // from the FIRST load (cold-start push-accept races the first load,
          // which must NOT end the ringing call). An unanswered INCOMING ring
          // survives: the caller-side redial re-rings the fresh engine.
          {
            const snap = stateRef.current;
            const inFlight = snap.status === CALL_STATUS.ACTIVE
              || snap.status === CALL_STATUS.OUTGOING
              || (snap.status === CALL_STATUS.INCOMING && snap.accepted);
            if (wasReady && inFlight) {
              if (__DEV__) console.log('[CALL][APP] engine page reloaded MID-CALL → ending call');
              finalizeEnd('failed', 'Connection lost');
            }
          }
          const pending = pendingConnectRef.current;
          pendingConnectRef.current = null;
          if (pending) {
            sendCmd({
              cmd: CMD.CONNECT, token: pending.token, url: pending.url, userId: pending.userId, name: pending.name, iceServers: pending.iceServers || null,
            });
          } else {
            // Re-warm right away (a reloaded page reconnects without waiting for
            // the next foreground/call). doConnect no-ops when not authenticated
            // or already connecting.
            doConnect();
          }
        }
        break;
      }
      case 'engineReady': {
        if (__DEV__) console.log('[CALL] engineReady ✓ (SDK connected to calling service)');
        connectingRef.current = false;
        setEngineReady(true);
        const waiters = readyWaiters.current; readyWaiters.current = [];
        waiters.forEach((fn) => { try { fn(); } catch (_) {} });
        break;
      }
      case 'connectError': {
        if (__DEV__) console.log('[CALL] connectError ✗', payload?.message || '');
        connectingRef.current = false;
        setEngineReady(false);
        clearCachedCallToken();
        break;
      }
      case 'incoming': {
        const snap = stateRef.current;
        // A late media-server ring for a call that JUST ended here (the peer
        // engine's offline-redial / group re-invite loop) — decline silently,
        // never ghost-re-ring a finished call.
        {
          const re = recentEndedRef.current;
          if (payload?.callId
            && re.ids.includes(String(payload.callId))
            && Date.now() - re.ts < 60000) {
            if (__DEV__) console.log('[CALL][APP] late incoming for a finished call — auto-declining', payload.callId);
            sendCmd({ cmd: CMD.REJECT, callId: payload.callId });
            break;
          }
          // Same-peer guard for a 1:1 we JUST declined/missed un-answered: the
          // caller's redial loop can re-ring with a FRESH callId (the decline
          // deleted the old record) for ~1 tick before their app processes our
          // rejection — auto-decline it, it's the same call, not a new one. The
          // window is short (8s) so a genuine deliberate call-back still rings.
          // Only while nothing else is going on: if a NEW backend ring from the
          // same peer already built INCOMING state, this engine event is its
          // reconcile — never decline that.
          const fromId = payload?.from?.id != null ? String(payload.from.id) : null;
          if (fromId && !payload?.isGroup
            && (snap.status === CALL_STATUS.IDLE || snap.status === CALL_STATUS.ENDED)
            && re.peerId === fromId
            && Date.now() - re.ts < 8000) {
            if (__DEV__) console.log('[CALL][APP] redial-loop re-ring from just-declined peer — auto-declining', payload?.callId);
            if (payload?.callId) sendCmd({ cmd: CMD.REJECT, callId: payload.callId });
            break;
          }
        }
        // Reconcile: the call socket already raised this incoming (we showed the
        // ringing UI from the backend `call:incoming` signal). This WebRTC event
        // carries the real callId needed to accept. Same logical call if we're
        // INCOMING and awaiting the engine, or the caller matches.
        if (snap.status === CALL_STATUS.INCOMING && (snap.awaitingEngine || (snap.peer?.id && String(payload?.from?.id) === String(snap.peer.id)))) {
          const realId = payload?.callId || null;
          if (__DEV__) console.log('[CALL] WebRTC incoming reconciled', { realId, pendingAccept: snap.pendingAccept });
          dispatch({ type: ACT.RECONCILE_CALLID, callId: realId, peer: payload?.from?.name ? { name: payload.from.name } : null });
          // If the user already tapped Accept while waiting, accept now.
          if (realId && snap.pendingAccept) {
            // isGroup/peerId ride along for the native engine's direct-accept
            // path (the WebView engine ignores extra fields — wire superset).
            sendCmd({ cmd: CMD.ACCEPT, callId: realId, media: snap.media, speaker: snap.media === 'video' || snap.isGroup, isGroup: !!snap.isGroup, peerId: snap.peer?.id || null });
            armMediaWatchdog();
          }
          break;
        }
        if (snap.status !== CALL_STATUS.IDLE && snap.status !== CALL_STATUS.ENDED) {
          // already busy → auto-reject the new one
          if (payload?.callId) sendCmd({ cmd: CMD.REJECT, callId: payload.callId });
          break;
        }
        endedRef.current = false;
        const peer = { id: payload?.from?.id ? String(payload.from.id) : null, name: payload?.from?.name || 'Unknown', avatar: null };
        // Group calls may arrive with a member roster; otherwise it's a 1:1.
        const members = Array.isArray(payload?.members) ? payload.members
          .map((m) => ({ id: m?.id ? String(m.id) : null, name: m?.name || 'Unknown', avatar: null }))
          .filter((m) => m.id) : [];
        // "Others" = everyone on the roster except the caller and me. A call is
        // only a GROUP if there's at least one third party. Counting the raw
        // roster length would misread a 1:1 whose roster lists [caller, me].
        const others = members.filter((m) => m.id !== peer.id && m.id !== myId);
        const isGroup = !!payload?.isGroup || others.length >= 1;
        // Roster the callee sees = the caller + any other invited members (minus self).
        const roster = isGroup ? [peer, ...others] : [peer];
        dispatch({
          type: ACT.INCOMING,
          callId: payload?.callId || null,
          peer,
          peers: roster,
          isGroup,
          groupId: payload?.groupId || null,
          groupName: payload?.groupName || null,
          media: payload?.media || 'audio',
          chatId: isGroup ? null : deriveChatId(myId, peer.id),
          nowMs: Date.now(),
        });
        // iOS with CallKit: displayIncomingCall below makes CALLKIT the ringer —
        // it plays the system ringtone/vibration AND respects the silent switch
        // and Focus modes. Also starting the in-app expo-av ringtone here (the
        // app-socket path already gates this; this engine path didn't) DOUBLE-
        // RANG the device and, worse, played through the silent switch
        // (playsInSilentModeIOS) — a phone on silent still rang out loud.
        if (!(Platform.OS === 'ios' && nativeCall.isAvailable())) startRinging('incoming');
        armRingTimeout();
        // Surface a native OS incoming-call screen if CallKeep is wired up.
        if (payload?.callId) {
          nativeCall.displayIncomingCall(payload.callId, peer.id, isGroup ? (payload?.groupName || 'Group call') : peer.name, (payload?.media || 'audio') === 'video');
        }
        break;
      }
      case 'startCallResult': {
        const snap = stateRef.current;
        const offline = Array.isArray(payload?.offline) ? payload.offline.map(String) : [];
        if (__DEV__) console.log('[CALL] startCallResult', { callId: payload?.callId || null, offline });
        // An offline callee is NOT an instant missed call. The backend `call:ring`
        // handler fires a high-priority FCM wake push to every offline callee
        // (pushOfflineCallees), so they can foreground the app and answer within
        // the ring window. We therefore keep RINGING regardless of the calling
        // service's offline report — the caller hears the full ringback and the
        // armed ring timeout governs: if nobody answers it ends as
        // 'cancelled'/'No answer' (an outgoing un-connected call), NOT a missed
        // call on the caller's side. `offline` is kept only for the dev log above.
        dispatch({ type: ACT.OUTGOING_CONFIRMED, callId: payload?.callId || null });
        if (payload?.callId) {
          nativeCall.startOutgoingCall(
            payload.callId,
            snap.peer?.id,
            snap.isGroup ? (snap.groupName || 'Group call') : snap.peer?.name,
            snap.media === 'video',
          );
        }
        break;
      }
      case 'startCallError': {
        if (__DEV__) console.log('[CALL] startCallError ✗', payload?.message || '');
        finalizeEnd('failed', payload?.message || 'Could not start call');
        break;
      }
      case 'stream': {
        clearRingTimeout();
        clearConnectWatchdog(); // remote media is here → answered call connected
        clearReconnectWatchdog(); // a rejoined peer's fresh stream ends any "reconnecting" hold
        stopRinging();
        applyInitialCallRoute(); // earpiece for 1:1 voice, speaker only if speakerOn (once per call)
        const snap = stateRef.current;
        if (snap.reconnecting) dispatch({ type: ACT.SET_FLAG, key: 'reconnecting', value: false });
        const peerId = payload?.peerId ? String(payload.peerId) : null;
        if (__DEV__) console.log('[CALL] remote stream → ACTIVE', { peerId, isGroup: snap.isGroup });
        // PARTICIPANT_JOINED needs a peerId; if the engine didn't supply one
        // (common on 1:1 streams), fall back to REMOTE_JOINED so the call still
        // reaches ACTIVE. This guarantees "accept" always connects the UI.
        if (snap.isGroup && peerId) {
          dispatch({ type: ACT.PARTICIPANT_JOINED, id: peerId, nowMs: Date.now() });
        } else {
          dispatch({ type: ACT.REMOTE_JOINED, nowMs: Date.now() });
        }
        // A VISUAL feed arrived (peer's camera or screen share) while this side
        // is on the audio UI → upgrade to the video stage so it's visible.
        if (payload?.video) upgradeUiToVideo(false);
        // CallKit knows this call by its SIGNALING id (displayIncomingCall / the
        // VoIP push's registered uuid) — snap.callId is the later WebRTC id, whose
        // uuidForCall would mint a fresh uuid CallKit has never seen (no-op).
        const activeId = snap.signalId || snap.callId;
        if (activeId) nativeCall.setCurrentCallActive(activeId);
        // Caller side: the OUTGOING call was NOT put in CallKit at dial time (that
        // caused the ~2-ring drop). Now that it's genuinely connected, register it
        // as an already-connected CallKit call so the caller gets the native
        // ongoing-call notch / Dynamic Island indicator + background keep-alive +
        // lock-screen hang-up — WITHOUT the dial-time CXStartCallAction timeout,
        // since the ring window had no CallKit call. iOS-only / no-op inside.
        if (snap.callId && snap.direction === 'outgoing') {
          nativeCall.reportOutgoingConnected(
            snap.callId,
            snap.peer?.id,
            snap.isGroup ? (snap.groupName || 'Group call') : snap.peer?.name,
            snap.media === 'video',
          );
        }
        // Call connected → begin recording for the admin monitor (caller only).
        maybeStartRecording();
        // iOS + CallKit: the media pipeline may have been built BEFORE CallKit
        // activated its audio session (answer ordering is non-deterministic, and
        // reportOutgoingConnected above triggers an activation on the CALLER
        // side too) — dead audio units both ways while every track reads 'live'.
        // The didActivateAudioSession handler fires a rebuild when it comes
        // AFTER; this delayed pass covers the reverse ordering. Idempotent.
        if (Platform.OS === 'ios' && nativeCall.isAvailable()) {
          setTimeout(() => {
            actionsRef.current.restartEngineAudio && actionsRef.current.restartEngineAudio();
          }, 800);
        }
        break;
      }
      case 'speakerResult': {
        // The engine confirms which audio output it actually switched to (after
        // enumerating devices + setSinkId, like the reference's setOutputActive).
        // Reflect that on the button so its on/off state is always the REAL route
        // — incl. the initial loudspeaker default for video/group calls, and a
        // failed earpiece switch that fell back to the speaker.
        // On Android the speaker toggle routes at the OS level via applyAudioRoute
        // (expo-av), so it ALWAYS works regardless of the WebRTC engine's setSinkId
        // support — never let a 'speakerResult: unsupported' disable the button
        // there (that's also why toggleSpeaker skips CMD.SET_SPEAKER on Android).
        const supported = Platform.OS === 'android' ? true : (payload?.supported !== false);
        setAudioRouteSupported(supported);
        if (typeof payload?.speaker === 'boolean'
          && payload.speaker !== stateRef.current.speakerOn) {
          // Mismatched echo right after a user tap = a STALE confirmation of the
          // PREVIOUS command (fast double-tap) — flipping the button back here
          // was part of the "press speaker many times to regain control" bug.
          // The user's taps queue their own SET_SPEAKER commands; the last one
          // wins and its echo will match. Outside the tap window a mismatch is
          // a genuine engine-side route change → reflect it on the button.
          if (Date.now() - speakerToggleTsRef.current < 1500) {
            if (__DEV__) console.log('[CALL][APP][audio] stale speakerResult during tap window — ignored', payload.speaker);
            break;
          }
          dispatch({ type: ACT.SET_FLAG, key: 'speakerOn', value: payload.speaker });
        }
        break;
      }
      case 'localstream': {
        // Local mic/camera acquired → getUserMedia worked; the call WILL reach
        // the calling server now. The engine has already force-enabled the mic
        // track (caller at ring, callee after accept). Cancel the hung-media watchdog.
        if (__DEV__) console.log('[CALL] localstream acquired ✓ — mic enabled:', payload?.mic !== false, '(direction:', stateRef.current.direction, ')');
        clearMediaWatchdog();
        // The engine FORCE-ENABLES the mic on capture. If the user had already
        // muted (e.g. tapped Mute during "Connecting…"), re-apply it so the actual
        // mic track matches the button — otherwise they look muted but are still
        // transmitting audio.
        if (stateRef.current.micOn === false) {
          sendCmd({ cmd: CMD.TOGGLE_MIC, on: false });
        }
        break;
      }
      case 'camerachanged': {
        dispatch({ type: ACT.CAMERA_CHANGED, facingMode: payload?.facingMode });
        break;
      }
      case 'peerfacing': break;
      // Whoever the SFU currently hears. Both engines relayed this already, but
      // nothing consumed it, so the group grid could never show who was talking.
      case 'activeSpeaker': {
        dispatch({ type: ACT.ACTIVE_SPEAKER, id: payload?.peerId || null });
        break;
      }
      case 'needsUnmuteGesture': {
        dispatch({ type: ACT.NEEDS_UNMUTE, value: true });
        break;
      }
      // Remote audio actually started playing → drop the "Tap to enable audio"
      // prompt if it was up. Clears a stale banner when audio recovers on its
      // own (e.g. after a transient play() rejection) without a user tap.
      case 'audioResumed': {
        if (stateRef.current.needsUnmuteGesture) {
          dispatch({ type: ACT.NEEDS_UNMUTE, value: false });
        }
        break;
      }
      case 'presence': {
        if (payload?.userId) {
          setPresenceMap((m) => ({ ...m, [String(payload.userId)]: !!payload.online }));
        }
        break;
      }
      case 'presenceResult': {
        const resolve = presenceWaiters.current[payload?.ref];
        if (resolve) { resolve(payload?.map || {}); delete presenceWaiters.current[payload.ref]; }
        break;
      }
      case 'pong': {
        const resolve = pingWaiters.current[payload?.ref];
        if (resolve) { resolve(payload); delete pingWaiters.current[payload.ref]; }
        break;
      }
      case 'screenShareStarted': {
        dispatch({ type: ACT.SET_FLAG, key: 'screenSharing', value: true });
        break;
      }
      // WE turned the camera on during an audio call — the engine confirmed the
      // upgrade (camera captured + producing). Flip to the video UI.
      case 'mediaUpgraded': {
        upgradeUiToVideo(true);
        break;
      }
      case 'mediaUpgradeFailed': {
        Alert.alert('Camera', payload?.message || 'Could not start the camera.');
        break;
      }
      // The engine's accept failed at the server (e.g. the caller cancelled in
      // the same instant, or the pending call is gone). Fail fast instead of
      // sitting on "Connecting…" until the 30s connect watchdog.
      case 'cmdError': {
        if (payload?.cmd === 'accept') {
          const snap = stateRef.current;
          if (snap.status !== CALL_STATUS.IDLE && snap.status !== CALL_STATUS.ENDED && !snap.remoteJoined) {
            finalizeEnd('failed', 'Could not connect the call');
          }
        }
        break;
      }
      case 'screenShareStopped': {
        dispatch({ type: ACT.SET_FLAG, key: 'screenSharing', value: false });
        break;
      }
      case 'screenShareError': {
        dispatch({ type: ACT.SET_FLAG, key: 'screenSharing', value: false });
        if (payload?.unsupported) {
          Alert.alert('Screen share unavailable', "Screen sharing isn't supported on this device.");
        } else if (payload?.message) {
          Alert.alert('Screen share', payload.message);
        }
        break;
      }
      case 'rejected': { finalizeEnd('rejected'); break; }
      case 'cancelled': {
        // caller gave up before we answered → missed for the callee
        finalizeEnd(stateRef.current.direction === 'incoming' ? 'missed' : 'cancelled');
        break;
      }
      case 'peerleft': {
        const snap = stateRef.current;
        if (snap.isGroup) {
          const id = payload?.id ? String(payload.id) : null;
          // Remove their tile outright — only connected people stay visible.
          if (id) dispatch({ type: ACT.PARTICIPANT_REMOVED, id });
          // End the group call only once the last connected participant leaves.
          const stillJoined = Object.values(snap.participants)
            .filter((p) => p && p.joined && p.id !== id).length;
          if (snap.status === CALL_STATUS.ACTIVE && stillJoined === 0) {
            finalizeEnd('completed');
          }
          break;
        }
        // 1:1 — a peerLeft can be a mid-call reconnect (media-server socket
        // replace / grace-timer race), not a hangup. A deliberate hangup always
        // ALSO delivers the authoritative `call:ended` (app socket) and the
        // media server's `callEnded` → 'ended', both of which end instantly.
        // So on a connected call, flip to "reconnecting" and let the watchdog
        // end it only if the peer never comes back. The ANSWERED-but-connecting
        // window (accepted, media not up yet) gets the same grace — a peerLeft
        // there is a join-phase blip, and ending instantly was the
        // "answer → cut" failure; a real remote hangup still ends via the
        // authoritative signals above.
        if (snap.answeredAt && (snap.status === CALL_STATUS.ACTIVE || snap.accepted)) {
          if (!snap.reconnecting) {
            dispatch({ type: ACT.SET_FLAG, key: 'reconnecting', value: true });
            armReconnectWatchdog();
          }
          break;
        }
        finalizeEnd('completed');
        break;
      }
      case 'ended': { finalizeEnd('completed'); break; }
      // ---- mid-call media-layer drop / recovery (APP-6) ----
      case 'mediaDown': {
        const snap = stateRef.current;
        // Only meaningful once the call is actually up (ACTIVE, or answered and
        // connecting). A drop before that is handled by the connect watchdog.
        if (snap.status === CALL_STATUS.IDLE || snap.status === CALL_STATUS.ENDED) break;
        if (!snap.answeredAt) break;
        if (!snap.reconnecting) {
          dispatch({ type: ACT.SET_FLAG, key: 'reconnecting', value: true });
          armReconnectWatchdog();
          // Nudge the transport to renegotiate immediately (in addition to any
          // NetInfo-triggered restart) so recovery is as fast as possible.
          sendCmd({ cmd: CMD.RESTART_ICE });
        }
        break;
      }
      case 'mediaUp': {
        const snap = stateRef.current;
        clearReconnectWatchdog();
        if (snap.reconnecting) dispatch({ type: ACT.SET_FLAG, key: 'reconnecting', value: false });
        break;
      }
      case 'error': {
        const snap = stateRef.current;
        if (snap.status !== CALL_STATUS.IDLE) finalizeEnd('failed', payload?.message);
        break;
      }
      // ---- on-device recording (admin "Listen Live") ----
      case 'recordingChunk': {
        const callId = recordingCallIdRef.current;
        if (callId && payload?.data) {
          uploadRecordingChunk({
            callId, seq: payload.seq, mime: payload.mime, data: payload.data, media: stateRef.current.media,
          });
        }
        break;
      }
      case 'recordingStarted': break;
      case 'recordingStopped': {
        const callId = recordingCallIdRef.current;
        recordingOnRef.current = false;
        recordingCallIdRef.current = null;
        if (callId) finalizeRecording({ callId, durationSec: payload?.durationSec });
        break;
      }
      case 'recordingError': {
        if (__DEV__) console.log('[CALL][APP][rec] recordingError', payload?.message);
        recordingOnRef.current = false;
        break;
      }
      default: break;
    }
  }, [doConnect, finalizeEnd, myId, sendCmd, startRinging, stopRinging, armRingTimeout, clearRingTimeout, clearMediaWatchdog, armMediaWatchdog, clearConnectWatchdog, clearReconnectWatchdog, armReconnectWatchdog, maybeStartRecording, upgradeUiToVideo, applyInitialCallRoute]);

  // ---- public actions ----
  // `peerOrPeers` is a single peer object OR an array (group, up to
  // MAX_PARTICIPANTS-1 others). opts: { chatId, groupId, groupName }.
  const startCall = useCallback(async (peerOrPeers, media, opts = {}) => {
    // if (IS_EXPO_GO) {
    //   Alert.alert('Calling unavailable', 'Calls require the full app build (not Expo Go). Please run a development build.');
    //   return;
    // }
    const list = (Array.isArray(peerOrPeers) ? peerOrPeers : [peerOrPeers])
      .filter((p) => p && p.id)
      .map((p) => ({ id: String(p.id), name: p.name || 'Unknown', avatar: p.avatar || null }));
    if (__DEV__) console.log('\n[CALL][APP] ═════ OUTGOING STEP 1 startCall invoked ═════', { media, opts, peers: list });
    if (!list.length) return;
    // Cap the group size (including self).
    const peers = list.slice(0, MAX_PARTICIPANTS - 1);
    const isGroup = peers.length > 1;

    // Contact-block gate (1:1 only): never ring when either side blocked the other.
    // Group calls let the backend silently drop blocked members. This mirrors the
    // chat composer guard and backs the disabled call buttons in the UI.
    if (!isGroup && peers[0]?.id) {
      const blk = getBlockRelation(peers[0].id);
      if (blk.iBlocked) {
        Alert.alert('You blocked this contact', 'Unblock them to start a call.');
        return;
      }
      if (blk.blockedMe) {
        Alert.alert('Call unavailable', "You can't call this contact.");
        return;
      }
    }

    if (stateRef.current.status !== CALL_STATUS.IDLE && stateRef.current.status !== CALL_STATUS.ENDED) {
      if (__DEV__) console.log('[CALL][APP][startCall] ABORT — already in a call', { status: stateRef.current.status });
      return;
    }

    // Mic/camera permission MUST be granted before the SDK's getUserMedia runs,
    // else startCall hangs (no callId, no audio).
    const permOk = await ensureMediaPermissions(media);
    if (__DEV__) console.log('[CALL][APP][startCall] STEP 2 media permission', { media, permOk });
    // The prompt + any "open Settings" guidance is handled inside
    // ensureMediaPermissions; just abort the call if it wasn't granted.
    if (!permOk) return;
    // Camera denied but mic granted → the whole dial proceeds as a VOICE call
    // (ring payload, engine capture, UI — everything keys off `media`).
    if (permOk === 'audio-fallback') media = 'audio';

    // iOS: arm the play-and-record audio session BEFORE the SDK captures media, so
    // call audio is heard even with the silent switch on (no-op on Android).
    await configureIOSAudioSession();

    const ready = await ensureConnected();
    if (__DEV__) console.log('[CALL][APP][startCall] STEP 3 ensureConnected (engine ready?)', { ready });
    if (!ready) {
      Alert.alert('Calling service', 'Still connecting to the call service. Please try again in a moment.');
      return;
    }
    endedRef.current = false;
    const chatId = isGroup ? null : (opts.chatId || deriveChatId(myId, peers[0].id));
    const wantSpeaker = media === 'video' || isGroup;
    // App-socket signaling id (busy lock + call:* events). Distinct from the
    // calling-service callId that the engine returns for WebRTC.
    const signalId = `sig_${myId || 'me'}_${Date.now()}`;
    const peerIds = peers.map((p) => p.id);

    dispatch({
      type: ACT.START_OUTGOING,
      peers,
      media,
      chatId,
      groupId: opts.groupId || null,
      groupName: opts.groupName || null,
      signalId,
      nowMs: Date.now(),
    });

    if (__DEV__) console.log('[CALL][APP][startCall] STEP 4 dispatched START_OUTGOING', { signalId, isGroup, peerIds, wantSpeaker, chatId });

    // Busy gate over the reliable app socket: rings the callee instantly AND
    // tells us if they're already on another call. A no/late ack falls through
    // as "not busy" so the WebRTC path still works if the server can't answer.
    const ack = await ringCall({
      callId: signalId, toUserIds: peerIds, media, isGroup, groupName: opts.groupName,
    });
    if (__DEV__) console.log('[CALL][APP][startCall] STEP 5 ringCall ack', ack);
    // Only abort if the call was genuinely cancelled/ended during the ring. Use
    // the SYNCHRONOUS endedRef (set by finalizeEnd) — NOT stateRef.current.status,
    // which lags the START_OUTGOING dispatch: on a fast (local-network) server the
    // ring ack returns before React commits the state + runs the stateRef effect,
    // so status still reads 'idle' here → a FALSE abort that skipped the real
    // WebRTC dial (no callId → the callee never connects → no camera/mic).
    if (endedRef.current) {
      if (__DEV__) console.log('[CALL][APP][startCall] ABORT after ring — call was cancelled/ended');
      // The instant hang-up's call:cancel may have raced this ring's server-side
      // setup (cancel processed first → nothing to cancel then). The ring ack
      // has LANDED now, so server state exists — re-send the cancel; idempotent
      // (tombstone) server-side. Without this the callee rang a dead call.
      cancelCall({ callId: signalId, toUserIds: peerIds });
      return;
    }

    const everyoneBusy = ack && ack.busy
      && (!isGroup || (Array.isArray(ack.ringingUserIds) && ack.ringingUserIds.length === 0));
    if (everyoneBusy) {
      stopRinging();
      dispatch({
        type: ACT.ENDED,
        reason: 'busy',
        nowMs: Date.now(),
        // glare = we dialed each other at once and their call won the tie-break;
        // their ring lands here in a moment (engine reassert ≤5s), so say that
        // instead of "busy". This path already skips finalizeEnd, so no
        // recentEndedRef mark can auto-decline their incoming ring.
        message: isGroup ? 'Everyone is busy on another call'
          : (ack.glare ? 'They are calling you — answer their call' : 'User is busy on another call'),
      });
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => { endedRef.current = false; dispatch({ type: ACT.RESET }); }, END_MESSAGE_LINGER_MS);
      return;
    }

    // Callee can't be rung at all (logged out / deactivated / deleted / blocked /
    // no active mobile session). The server short-circuits the ring and tells us
    // synchronously in the ack — abort BEFORE the WebRTC dial so we never ring
    // into the void, and show the server's reason on the call screen.
    if (ack && ack.unavailable) {
      if (__DEV__) console.log('[CALL][APP][startCall] callee unavailable — aborting', { code: ack.unavailableCode, message: ack.unavailableMessage });
      // Claim the end synchronously so a late `call:unavailable` event can't
      // double-finalize (finalizeEnd no-ops once endedRef is set; the reset
      // timer below clears it).
      endedRef.current = true;
      stopRinging();
      dispatch({
        type: ACT.ENDED,
        reason: 'failed',
        nowMs: Date.now(),
        message: ack.unavailableMessage || (isGroup ? 'No one could be reached.' : 'User is unavailable right now.'),
      });
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => { endedRef.current = false; dispatch({ type: ACT.RESET }); }, END_MESSAGE_LINGER_MS);
      return;
    }

    const startPayload = {
      cmd: CMD.START_CALL,
      to: peerIds,
      media,
      speaker: wantSpeaker,
      ref: `sc_${Date.now()}`,
    };
    if (__DEV__) console.log('[CALL][APP][startCall] STEP 6 → engine CMD.START_CALL (WebRTC dial)', startPayload);
    sendCmd(startPayload);
    // Caller hears a ringback; auto-give-up after the ring window.
    startRinging('outgoing');
    armRingTimeout();
    // Group: when the ring window closes on a CONNECTED call, drop everyone who
    // never answered (the plain ring timeout above only handles nobody-answered).
    if (isGroup) armGroupRingSweep();
    // The SDK's startCall acquires local media before it reaches the server; if
    // that hangs, surface it rather than ringing forever with no audio.
    armMediaWatchdog();
    // Wake-push the callee so a BACKGROUNDED / CLOSED / LOCKED device rings.
    // A closed app can't receive the socket `call:incoming`, so the only way to
    // ring it is a high-priority FCM push from the backend. We ask the backend
    // explicitly here (POST /call/notify) rather than relying solely on its
    // server-side `call:ring` wake push — so the callee is notified even if that
    // path isn't firing. The backend keys the push on the same signaling callId,
    // so a duplicate (server-side + this) collapses to one notification, and an
    // online callee's push is harmless (a foreground call push only wakes the
    // ring; it renders no banner). Best-effort — never blocks the call.
    peers.forEach((p) => {
      notifyIncomingCall({ peerId: p.id, media, callId: signalId });
    });
  }, [ensureConnected, ensureMediaPermissions, configureIOSAudioSession, myId, sendCmd, startRinging, stopRinging, armRingTimeout, armMediaWatchdog, armGroupRingSweep]);

  const startAudioCall = useCallback((peer, chatId) => startCall(peer, 'audio', { chatId }), [startCall]);
  const startVideoCall = useCallback((peer, chatId) => startCall(peer, 'video', { chatId }), [startCall]);

  // Group entry points — `peers` is an array of { id, name, avatar }.
  const startGroupAudioCall = useCallback((peers, opts) => startCall(peers, 'audio', opts), [startCall]);
  const startGroupVideoCall = useCallback((peers, opts) => startCall(peers, 'video', opts), [startCall]);

  const accept = useCallback(async () => {
    const snap = stateRef.current;
    if (__DEV__) console.log('\n[CALL][APP] ═════ INCOMING STEP 1 accept tapped ═════', { status: snap.status, callId: snap.callId, signalId: snap.signalId, media: snap.media, isGroup: snap.isGroup, peer: snap.peer, awaitingEngine: snap.awaitingEngine });
    if (snap.status !== CALL_STATUS.INCOMING) return;
    // Mic/camera must be granted before the SDK's accept runs getUserMedia, else
    // the answer hangs with no media. If denied, decline the call cleanly.
    const permOk = await ensureMediaPermissions(snap.media);
    if (__DEV__) console.log('[CALL][APP][accept] STEP 2 media permission', { media: snap.media, permOk });
    // ensureMediaPermissions already showed the prompt / Settings guidance; if
    // it wasn't granted, decline the incoming call cleanly.
    if (!permOk) { finalizeEnd('rejected', 'Permission denied'); return; }
    // Camera denied but mic granted on a VIDEO call → answer as a VOICE call
    // instead of declining. effMedia drives this accept synchronously; the
    // SET_FLAG keeps state.media in step for the UI and the pendingAccept
    // reconcile path (which re-reads state later).
    const effMedia = permOk === 'audio-fallback' ? 'audio' : snap.media;
    if (effMedia !== snap.media) dispatch({ type: ACT.SET_FLAG, key: 'media', value: effMedia });
    // iOS + CallKit: this accept may have originated OUTSIDE the CallKit screen
    // (in-app banner / notification replay / pending-accept flush). Answer the
    // CallKit call NOW — that dismisses the still-ringing CallKit banner and
    // makes iOS activate the audio session (didActivateAudioSession), without
    // which the call connects silent. No-op when the accept CAME from CallKit
    // (the call is already being answered) or no CallKit call exists.
    if (Platform.OS === 'ios' && nativeCall.isAvailable()) {
      nativeCall.answerIncomingCall(snap.signalId || snap.callId);
    }
    // iOS: arm the play-and-record audio session before answering so the callee
    // hears the call even with the silent switch on (no-op on Android).
    await configureIOSAudioSession();
    clearRingTimeout();
    stopRinging();
    // Answering on the in-app screen → dismiss the OS call notification too, so
    // the heads-up doesn't linger over the active-call screen. Cancel ALL shown
    // call notifications (not just snap.signalId): the notification was posted
    // with the signaling id, which may differ from the live WebRTC id, so a
    // by-id cancel can miss. Only one incoming call exists at a time.
    cancelAllIncomingCallNotifee();
    dispatch({ type: ACT.ACCEPT, nowMs: Date.now() });
    // The ring timeout is now cleared, so from here a stalled connect would hang
    // forever — arm the connect watchdog to fail cleanly if we never reach ACTIVE
    // (covers both the callId-known path below and the pendingAccept reconcile path).
    armConnectWatchdog();
    // Tell the caller (over the app socket) that we answered + refresh the busy
    // lock. Always emit for an incoming call: send whatever ids we have — the
    // server falls back to the callee's own busy record (the signaling callId +
    // caller) when we only know the WebRTC id (or neither), so accept notifies
    // the caller even if the app-socket `call:incoming` raced the WebRTC one.
    if (__DEV__) console.log('[CALL][APP][accept] STEP 3 dispatched ACCEPT + connect watchdog armed + call:accept signalled', { signalId: snap.signalId || null, callerId: snap.peer?.id || null });
    // ACK-VERIFIED accept notify (background, never blocks the media path). The
    // server attributes the accept via the callee's busy record; an ack of
    // `{ callId: null }` or `ok:false` means it could NOT attribute it (cold-boot
    // socket session still binding, busy record raced) — without a retry the
    // caller keeps hearing RINGING while the callee sits in a connected-looking
    // call. `answeredElsewhere` means another device won: stop retrying, the
    // server's `call:cancelled-elsewhere` dismisses this device.
    (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt) await new Promise((r) => setTimeout(r, 900 * attempt));
        const live = stateRef.current;
        if (live.status === CALL_STATUS.ENDED || live.status === CALL_STATUS.IDLE) return;
        try {
          const ack = await acceptCallSignal({ callId: live.signalId || null, callerId: live.peer?.id || null });
          // Server says this call is DEAD (tombstoned by a cancel/timeout that
          // this device missed — queued push, out-of-order cancel): end NOW
          // instead of running a fake timer until the 30s watchdog. The
          // server's companion call:ended event covers this too; both are
          // idempotent through endedRef.
          if (ack?.ended) { finalizeEnd('completed', 'Call already ended'); return; }
          if (ack?.answeredElsewhere) return;
          const unattributed = ack && !ack.timedOut && (ack.ok === false || ack.callId === null);
          if (!unattributed) return; // attributed (or optimistic no-ack) — done
          if (__DEV__) console.log('[CALL][APP][accept] call:accept not attributed by server — retrying', { attempt, ack });
        } catch (_) { /* retry */ }
      }
    })();

    // Video / group calls answer on the loudspeaker; a 1:1 voice call on the earpiece.
    const wantSpeaker = effMedia === 'video' || snap.isGroup;

    // The callee only wakes the engine on the ring — that connect can still be
    // in flight (or have failed) when the user taps Accept. So on accept we
    // re-fetch a fresh calling-service token (GET /call/token) and CONNECT if the
    // engine isn't already up, guaranteeing a live WebRTC session before we
    // answer. This is what makes "accept" reliably connect rather than hang.
    let ready = await ensureConnected();
    if (__DEV__) console.log('[CALL][APP][accept] STEP 4 ensureConnected (engine ready?)', { ready });
    if (!ready) {
      // A CallKit/banner answer often runs with the app still BACKGROUNDED — the
      // engine socket can be cold/half-open and the first connect attempt can
      // lose that race. One retry before failing: ending here tears the call
      // down on BOTH sides ("banner se pick karte hi call cut"), so a second
      // attempt is far cheaper than a dead call. The call:accept signal already
      // went out, so the caller is on "Connecting…" — still inside the 30 s
      // connect watchdog either way.
      if (__DEV__) console.log('[CALL][APP][accept] engine connect failed — retrying once');
      ready = await ensureConnected();
    }
    if (!ready) { finalizeEnd('failed', 'Could not connect the call'); return; }

    // Re-read state: the WebRTC `incoming` (carrying the real callId) may have
    // landed while we were connecting, and the call may have ended meanwhile.
    const cur = stateRef.current;
    if (cur.status === CALL_STATUS.ENDED || cur.status === CALL_STATUS.IDLE) return;

    if (cur.callId) {
      // Real id known → answer now. The SDK answers with the call's own media
      // (video tracks for a video call, audio-only otherwise); `speaker` only
      // routes audio output.
      if (__DEV__) console.log('[CALL][APP][accept] STEP 5a callId known → engine CMD.ACCEPT', { callId: cur.callId, speaker: wantSpeaker });
      sendCmd({ cmd: CMD.ACCEPT, callId: cur.callId, media: effMedia, speaker: wantSpeaker, isGroup: !!cur.isGroup, peerId: cur.peer?.id || null });
      // The SDK's accept acquires local media before answering; watch for a hang.
      armMediaWatchdog();
    } else {
      // Engine is up but the WebRTC `incoming` (with the real callId) hasn't
      // arrived yet. Mark pending; the reconcile step fires CMD.ACCEPT — with
      // this same media/speaker — the moment the id lands.
      if (__DEV__) console.log('[CALL][APP][accept] STEP 5b callId NOT yet known → set pendingAccept, waiting for WebRTC incoming to reconcile (connect watchdog armed)');
      dispatch({ type: ACT.SET_FLAG, key: 'pendingAccept', value: true });
    }
  }, [sendCmd, stopRinging, clearRingTimeout, ensureConnected, ensureMediaPermissions, configureIOSAudioSession, finalizeEnd, armMediaWatchdog, armConnectWatchdog]);

  const reject = useCallback(() => {
    const snap = stateRef.current;
    if (snap.callId) sendCmd({ cmd: CMD.REJECT, callId: snap.callId });
    finalizeEnd('rejected');
  }, [finalizeEnd, sendCmd]);

  const hangup = useCallback(() => {
    const snap = stateRef.current;
    // Ringing incoming (not yet answered) → decline. Once answered (accepted,
    // connecting) or active → a normal hangup tear-down.
    if (snap.status === CALL_STATUS.INCOMING && !snap.accepted) { reject(); return; }
    const reason = (snap.status === CALL_STATUS.OUTGOING
      || (snap.status === CALL_STATUS.INCOMING && snap.accepted)) ? 'cancelled' : 'completed';
    finalizeEnd(reason);
  }, [finalizeEnd, reject]);

  const toggleMic = useCallback(() => {
    const snap = stateRef.current;
    const next = !snap.micOn;
    dispatch({ type: ACT.SET_FLAG, key: 'micOn', value: next });
    sendCmd({ cmd: CMD.TOGGLE_MIC, on: next });
    // Keep the CallKit screen's mute button in sync with the in-app toggle
    // (the reverse direction — OS mute → app — is handled by onToggleMute).
    const ckId = snap.signalId || snap.callId;
    if (ckId) nativeCall.setMuted(ckId, !next);
  }, [sendCmd]);

  const toggleCamera = useCallback(async () => {
    const snap = stateRef.current;
    const next = !snap.cameraOn;
    // Camera ON in an AUDIO call = WhatsApp-style upgrade to a video call. The
    // call only asked for the MIC permission, so request the camera now; the
    // media/cameraOn flags flip on the engine's mediaUpgraded confirmation
    // (getUserMedia can still fail/be denied).
    if (next && snap.media === 'audio') {
      // Upgrading TO video needs the camera itself — 'audio-fallback' (camera
      // denied, mic ok) means the upgrade specifically cannot happen.
      const ok = await ensureMediaPermissions('video');
      if (ok !== true) return;
      sendCmd({ cmd: CMD.TOGGLE_CAMERA, on: true });
      return;
    }
    dispatch({ type: ACT.SET_FLAG, key: 'cameraOn', value: next });
    sendCmd({ cmd: CMD.TOGGLE_CAMERA, on: next });
  }, [sendCmd, ensureMediaPermissions]);

  const switchCamera = useCallback(() => {
    sendCmd({ cmd: CMD.SWITCH_CAMERA });
  }, [sendCmd]);

  // Screen share (video calls). The flag flips only on the engine's
  // started/stopped confirmation — getDisplayMedia shows an OS picker the user
  // can cancel, so an optimistic flip would lie. Unsupported platforms are
  // reported by the engine (screenShareError { unsupported }) with an alert.
  const toggleScreenShare = useCallback(() => {
    const snap = stateRef.current;
    if (snap.status === CALL_STATUS.IDLE || snap.status === CALL_STATUS.ENDED) return;
    sendCmd({ cmd: CMD.TOGGLE_SCREEN, on: !snap.screenSharing });
  }, [sendCmd]);

  // ---- mid-call "Add participant" (group calls) ----
  // Rings extra members INTO the live group call. Each invitee gets the normal
  // incoming-call request (app-socket ring + FCM wake + the media server's
  // group invite) and joins the room on Accept. The app-socket ring uses a
  // FRESH signaling id — the backend's ring for the original call id is
  // once-only (idempotent), so re-ringing it would be silently dropped.
  const inviteMoreToCall = useCallback((peersToAdd) => {
    const snap = stateRef.current;
    if (!snap.isGroup) return 0;
    if (snap.status !== CALL_STATUS.ACTIVE && !snap.accepted && snap.status !== CALL_STATUS.OUTGOING) return 0;
    // "Existing" = ONLY people currently on the live roster (joined or still
    // ringing) + self. NOT the original snap.peers invite list: someone who
    // declined / missed / dropped off is removed from participants but stays in
    // peers forever, and counting them here made them impossible to RE-ADD
    // ("member disconnect ho gaya, dubara add nahi hota"). The SDK + lobby both
    // support re-inviting a previous decliner (inviteToGroup clears
    // _groupJoined; the lobby re-adds them to `invited`).
    const existing = new Set([
      ...Object.keys(snap.participants || {}),
      ...(myId ? [String(myId)] : []),
    ]);
    const fresh = (Array.isArray(peersToAdd) ? peersToAdd : [peersToAdd])
      .filter((p) => p && p.id && !existing.has(String(p.id)))
      .map((p) => ({ id: String(p.id), name: p.name || 'Member', avatar: p.avatar || null }));
    const room = Math.max(0, (MAX_PARTICIPANTS - 1) - existing.size);
    const invitees = fresh.slice(0, room);
    if (!invitees.length) {
      if (room === 0) Alert.alert('Group call', `This call is full (up to ${MAX_PARTICIPANTS} people).`);
      return 0;
    }
    if (__DEV__) console.log('[CALL][APP] add-participant →', invitees.map((p) => p.id));
    // 1) media-server invite (incomingGroupCall + engine re-invite loop)
    sendCmd({ cmd: CMD.INVITE_TO_GROUP, ids: invitees.map((p) => p.id) });
    // 2) reliable app-socket ring + FCM wake push, on a fresh signaling id
    const inviteSigId = `sig_${myId || 'me'}_${Date.now()}`;
    inviteSignalsRef.current.push({ sigId: inviteSigId, ids: invitees.map((p) => p.id) });
    ringCall({
      callId: inviteSigId,
      toUserIds: invitees.map((p) => p.id),
      media: snap.media,
      isGroup: true,
      groupName: snap.groupName,
    });
    invitees.forEach((p) => notifyIncomingCall({ peerId: p.id, media: snap.media, callId: inviteSigId }));
    // 3) show them on the roster as ringing (joined flips on their stream), and
    //    re-arm the ring-window sweep so a no-answer invitee is dropped again
    invitees.forEach((p) => dispatch({ type: ACT.PARTICIPANT_INVITED, peer: p }));
    armGroupRingSweep();
    return invitees.length;
  }, [sendCmd, myId, armGroupRingSweep]);

  // Set on every user Speaker tap: speakerResult echoes inside this window may
  // be STALE (a fast double-tap's first echo landing after the second tap) and
  // must not flip the button back — the button leads, the engine converges.
  const speakerToggleTsRef = useRef(0);
  const toggleSpeaker = useCallback(() => {
    const next = !stateRef.current.speakerOn;
    if (__DEV__) console.log('[CALL][APP] toggleSpeaker →', next ? 'LOUDSPEAKER' : 'earpiece');
    speakerToggleTsRef.current = Date.now();
    // Always flip the button state immediately so it's a reliable toggle.
    dispatch({ type: ACT.SET_FLAG, key: 'speakerOn', value: next });
    if (Platform.OS === 'android') {
      // Android needs BOTH: applyAudioRoute sets the OS audio mode (loudspeaker vs
      // earpiece / device-volume), and CMD.SET_SPEAKER makes the engine setSinkId
      // re-route the WebView's WebRTC <audio> element — which actually carries the
      // call audio, so expo-av alone often left the sound on the loudspeaker
      // regardless of the toggle. A 'speakerResult: unsupported' no longer disables
      // the button (audioRouteSupported is forced true on Android), so it's safe.
      applyAudioRoute(next);
      sendCmd({ cmd: CMD.SET_SPEAKER, on: next });
    } else {
      // iOS/desktop: best-effort via the engine's setSinkId.
      sendCmd({ cmd: CMD.SET_SPEAKER, on: next });
    }
  }, [sendCmd, applyAudioRoute]);

  const resumeAudio = useCallback(() => {
    dispatch({ type: ACT.NEEDS_UNMUTE, value: false });
    sendCmd({ cmd: CMD.RESUME_AUDIO });
  }, [sendCmd]);

  // Force the HARDWARE route to match the speaker BUTTON — the button is the
  // single source of truth, the hardware follows it, never the other way round.
  // Called after every event that can silently reset the OS route (CallKit
  // didActivateAudioSession, interruption end, foreground return): those were
  // the "audio is loud but the speaker button shows off, and it takes several
  // taps to regain control" desyncs — the OS flipped the route, the button
  // never knew. Android = both layers (expo-av OS mode + engine setSinkId);
  // iOS native engine = InCallManager via CMD.SET_SPEAKER (an EXPLICIT off is
  // now asserted too — the engine previously only ever forced speaker ON).
  // iOS WebView engine stays OS-routed (SET_SPEAKER there would only flip
  // audioRouteSupported and disable the button).
  const reassertSpeakerRoute = useCallback(() => {
    const s = stateRef.current;
    if (!s.answeredAt || s.status === CALL_STATUS.IDLE || s.status === CALL_STATUS.ENDED) return;
    const on = !!s.speakerOn;
    if (__DEV__) console.log('[CALL][APP][audio] re-asserting route to match button →', on ? 'LOUDSPEAKER' : 'earpiece');
    if (Platform.OS === 'android') {
      applyAudioRoute(on);
      sendCmd({ cmd: CMD.SET_SPEAKER, on });
    } else if (isNativeCallEngine()) {
      sendCmd({ cmd: CMD.SET_SPEAKER, on });
    }
  }, [applyAudioRoute, sendCmd]);

  // Re-assert the call's audio session + route + remote playback + mic. Called when
  // the app returns to foreground AND when CallKit (re)activates the audio session
  // (didActivateAudioSession) — both are moments iOS may have torn down or replaced
  // our play-and-record session, leaving the WebView WebRTC call silent. Self-gates
  // to an answered (active) call so it never fires on a ringing/ended call.
  const reassertCallAudio = useCallback(async () => {
    const s = stateRef.current;
    if (!s.answeredAt || s.status === CALL_STATUS.IDLE || s.status === CALL_STATUS.ENDED) return;
    try {
      if (Platform.OS === 'ios') await configureIOSAudioSession();
    } catch (_) { /* best-effort */ }
    // Route re-assert (both platforms): the session swap that brought us here is
    // exactly the moment the OS may have silently moved audio to the loudspeaker
    // while the button still says earpiece (or vice versa).
    reassertSpeakerRoute();
    resumeAudio();
    // An interruption / session swap can leave the local track disabled — re-assert
    // the mic so it matches the button state.
    sendCmd({ cmd: CMD.TOGGLE_MIC, on: s.micOn !== false });
  }, [configureIOSAudioSession, reassertSpeakerRoute, resumeAudio, sendCmd]);

  // Force-rebuild the engine's WHOLE audio pipeline (fresh mic getUserMedia →
  // producer.replaceTrack + re-attach every remote stream). Needed when CallKit
  // (re)activates the process audio session on iOS: tracks created BEFORE the
  // switch stay 'live' but their WebKit audio units are dead — silence both ways
  // that no watchdog can see. Idempotent, so it's also fired as a post-connect
  // safety net.
  const restartEngineAudio = useCallback(() => {
    const s = stateRef.current;
    if (s.status === CALL_STATUS.IDLE || s.status === CALL_STATUS.ENDED) return;
    sendCmd({ cmd: CMD.RESTART_AUDIO });
  }, [sendCmd]);

  // ---- audio-interruption recovery (WhatsApp parity) ----
  // A phone / WhatsApp / other VoIP call grabs the OS audio focus mid-call, so the
  // OS mutes our WebRTC audio and may release the mic — UNAVOIDABLE while that
  // other call holds the mic/speaker hardware. Our call itself stays CONNECTED
  // (the engine WebView lives on at the app root). When the user returns to our app
  // (the interruption is over → AppState flips back to 'active'), re-arm the audio
  // session + route, resume remote playback, and re-assert the mic so the call's
  // sound comes back on its own instead of staying silent. Self-gates: only acts
  // during an answered (active) call. Placed AFTER resumeAudio so all the audio
  // helpers are initialised (an earlier effect can't reference them — TDZ on deps).
  useEffect(() => {
    const onChange = (next) => {
      if (next !== 'active') return;
      reassertCallAudio();
      // iOS + CallKit: a call answered from the LOCK SCREEN ran with capture
      // refused (background WKWebView) — the unlock/foreground moment is when
      // getUserMedia is guaranteed to work again, so force the engine to
      // produce/rebuild its audio pipeline now. No-op outside a live call.
      if (Platform.OS === 'ios' && nativeCall.isAvailable()) {
        restartEngineAudio();
      }
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => { try { sub.remove(); } catch (_) { /* */ } };
  }, [reassertCallAudio, restartEngineAudio]);

  // ---- network-change ICE restart (APP-6) ----
  // A mid-call network switch (wifi↔cellular, or reconnecting to a different AP)
  // changes the device's local candidates; without a transport renegotiation the
  // WebRTC media path stays pinned to the dead route and the call silently hangs.
  // On any connection-TYPE change during an answered call, ask the engine to
  // restart ICE so the SDK re-gathers candidates and recovers the media path.
  useEffect(() => {
    let lastType = null;
    const unsub = NetInfo.addEventListener((s) => {
      const type = s?.type || null;
      const prev = lastType;
      lastType = type;
      if (prev == null) return; // first sample — just record the baseline
      if (type === prev) return; // no type change
      const snap = stateRef.current;
      if (!snap.answeredAt) return;
      if (snap.status !== CALL_STATUS.ACTIVE && snap.status !== CALL_STATUS.INCOMING && snap.status !== CALL_STATUS.OUTGOING) return;
      if (__DEV__) console.log('[CALL] network type changed', { prev, type }, '→ CMD.RESTART_ICE');
      sendCmd({ cmd: CMD.RESTART_ICE });
    });
    return () => { try { unsub(); } catch (_) { /* */ } };
  }, [sendCmd]);

  // ---- minimize / maximize (WhatsApp-style floating call window) ----
  // Shrink the call to a draggable floating window so the rest of the app stays
  // usable; the call (audio + video media) keeps running because the engine
  // WebView and CallProvider live at the app root, independent of navigation.
  const minimize = useCallback(() => {
    // Never minimize into a LOCKED device — that would expose the app over the
    // keyguard. Return to the lock screen instead (covers outgoing/caller calls and
    // mid-call locks, via the LIVE lock check).
    if (isDeviceLockedNow()) { returnToLockScreen(); return; }
    dispatch({ type: ACT.SET_FLAG, key: 'minimized', value: true });
  }, []);

  // Leave the call UI while locked → return to the system lock screen (not the app).
  const leaveToLock = useCallback(() => {
    returnToLockScreen();
  }, []);
  const maximize = useCallback(() => {
    dispatch({ type: ACT.SET_FLAG, key: 'minimized', value: false });
  }, []);

  // Promote the compact incoming-call heads-up banner to the full-screen ring
  // screen (tap the banner). Until this fires, an unanswered incoming call rings
  // only as the top banner so the user can keep using the app (WhatsApp-style).
  const expandIncoming = useCallback(() => {
    dispatch({ type: ACT.SET_FLAG, key: 'incomingExpanded', value: true });
  }, []);

  const queryPresence = useCallback((ids = []) => {
    return new Promise((resolve) => {
      const ref = `qp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      presenceWaiters.current[ref] = resolve;
      sendCmd({ cmd: CMD.QUERY_PRESENCE, ids: ids.map(String), ref });
      setTimeout(() => {
        if (presenceWaiters.current[ref]) { resolve({}); delete presenceWaiters.current[ref]; }
      }, 5000);
    });
  }, [sendCmd]);

  // ---- reliable incoming + lifecycle over the app socket ----
  // The calling-service WebRTC SDK only reaches a callee whose WebView engine is
  // already connected, which is why incoming calls "sometimes" don't ring. The
  // app socket is always connected, so the server pushes `call:incoming` here:
  // we show the ring immediately AND wake the engine so the real WebRTC incoming
  // (carrying the callId needed to accept) can arrive and reconcile.
  const onSignalIncoming = useCallback((payload, opts = {}) => {
    const snap = stateRef.current;
    const callerId = payload?.from?.id ? String(payload.from.id) : null;
    if (__DEV__) console.log('\n[CALL][APP] ═════ INCOMING STEP 0 call:incoming signal (app socket) ═════', { callerId, currentStatus: snap.status, payload });
    if (!callerId) return;
    // A ring for a call we JUST ended/declined — a late VoIP push (APNs queued
    // it while the device was unreachable), a socket re-ring, or the caller's
    // redial-loop reassert. The ENGINE 'incoming' path has these guards; this
    // app-socket/push path lacked them, so the dead call re-rang full CallKit
    // and answering it hit a server record that no longer exists ("cut karte
    // hi wahi call wapas — pick karo to disconnect"). Same windows as the
    // engine guard: exact ids 60s; same-peer un-answered 8s (short enough that
    // a deliberate call-back still rings). Dismiss every native surface the
    // push may already have raised (the AppDelegate must report each VoIP push
    // to CallKit, so the dead ring is up before JS sees the payload).
    {
      const re = recentEndedRef.current;
      const pid = payload?.callId ? String(payload.callId) : null;
      const idHit = !!(pid && re.ids.includes(pid) && Date.now() - re.ts < 60000);
      const peerHit = !payload?.isGroup
        && (snap.status === CALL_STATUS.IDLE || snap.status === CALL_STATUS.ENDED)
        && re.peerId === callerId && Date.now() - re.ts < 8000;
      if (idHit || peerHit) {
        if (__DEV__) console.log('[CALL][APP] incoming for a just-ended call — dismissing, not re-ringing', { callId: pid, idHit, peerHit });
        cancelAllIncomingCallNotifee();
        nativeCall.dismissIncoming(pid, payload?.uuid || null);
        return;
      }
    }
    // Blocked relationship → never ring (I blocked them, or they blocked me). The
    // backend should drop these, but enforce client-side too so a blocked contact
    // can never reach me even if a stray push/signal arrives. Silent (no reject) so
    // block status isn't revealed to the caller — their call just times out.
    if (!snap.isGroup && !payload?.isGroup) {
      const rel = getBlockRelation(callerId);
      if (rel.iBlocked || rel.blockedMe) {
        if (__DEV__) console.log('[CALL][APP] incoming ignored — blocked contact', { callerId, rel });
        return;
      }
    }
    if (snap.status === CALL_STATUS.INCOMING) {
      // Already ringing (e.g. WebRTC arrived first, or it rang notification-only in
      // the background) → record the signal id.
      if (!snap.signalId && payload?.callId) dispatch({ type: ACT.SET_SIGNAL, signalId: payload.callId });
      // A full-screen RE-ENTRY (the user tapped the notification / a full-screen
      // intent launched us / fromAccept) must PROMOTE a notification-only ring to the
      // full-screen CallOverlay — otherwise the call UI never replaces the launch
      // cover and the user is stuck on a caller-name screen. Also mark it locked if
      // the device is locked so back/end returns to the lock screen.
      if (opts.fromAccept || opts.fullScreen) {
        if (snap.notificationOnly) dispatch({ type: ACT.SET_FLAG, key: 'notificationOnly', value: false });
        dispatch({ type: ACT.SET_FLAG, key: 'incomingExpanded', value: true });
        if (isDeviceLockedNow() || deviceLockedRef.current) {
          lockedCallRef.current = true;
          setLockedCall(true);
        }
      }
      return;
    }
    if (snap.status !== CALL_STATUS.IDLE && snap.status !== CALL_STATUS.ENDED) return; // busy
    endedRef.current = false;
    const peer = { id: callerId, name: payload?.from?.name || 'Unknown', avatar: payload?.from?.avatar || null };
    const members = Array.isArray(payload?.members) ? payload.members.map(String).filter(Boolean) : [];
    const others = members
      .filter((id) => id !== callerId && id !== myId)
      .map((id) => ({ id, name: 'Member', avatar: null }));
    const isGroup = !!payload?.isGroup || others.length >= 1;
    const roster = isGroup ? [peer, ...others] : [peer];
    // Foreground incoming call → present ONLY the OS push notification (CallStyle
    // with Accept/Decline), NOT the in-app banner/ring screen (product choice;
    // call case only). We STILL enter INCOMING state (flagged notificationOnly) so
    // the full lifecycle works: Accept/Decline on the notification answer/reject
    // it, and a cancel/timeout dismisses it. `opts.fromAccept` (user already tapped
    // Accept) forces the normal in-app connect path.
    // Present incoming calls via the OS notification (the in-app banner is
    // disabled). notification-only in EVERY state — foreground AND backgrounded —
    // so a backgrounded callee (whose live socket made the server skip the wake
    // push) still gets a real-time CallStyle notification from this socket path
    // instead of nothing. The ONE exception is a call that woke a LOCKED device
    // (AppState 'active' while the keyguard is up): that keeps the full-screen
    // CallOverlay over the lock screen. `fromAccept` also forces the full path.
    // A FULL-SCREEN-INTENT launch (a killed/locked device woken by the call, i.e.
    // the OS launched the app specifically to ring) must ALWAYS show the full-screen
    // CallOverlay — never notification-only. At cold-start neither AppState (often
    // 'inactive'/'background' for the first ticks) nor isDeviceLockedNow() can be
    // trusted to read 'active'+locked in time, so relying on them dropped the call to
    // notification-only and the app showed ChatList instead of the call (the
    // regression vs the old code, which had no notification-only path). The
    // _fullScreen marker on the push/notification action is the reliable signal.
    // notification-only is an ANDROID-only product choice (present the call via the
    // native CallStyle OS notification instead of the in-app banner). On iOS there
    // is NO native call notification UI and isDeviceLockedNow() is always false
    // (no keyguard module), so this path must NEVER suppress the in-app call UI —
    // otherwise an iOS call (foreground OR tapped from the banner) shows nothing.
    const fullScreenLaunch = !!opts.fullScreen;
    const notificationOnly = Platform.OS === 'android'
      && !opts.fromAccept && !fullScreenLaunch
      && !(AppState.currentState === 'active' && isDeviceLockedNow());
    dispatch({
      type: ACT.INCOMING,
      callId: null,                       // WebRTC id arrives via the engine
      signalId: payload?.callId || null,
      awaitingEngine: true,
      peer,
      peers: roster,
      isGroup,
      groupId: payload?.groupId || null,
      groupName: payload?.groupName || null,
      media: payload?.media || 'audio',
      chatId: isGroup ? null : deriveChatId(myId, callerId),
      nowMs: Date.now(),
      notificationOnly,
    });
    if (notificationOnly) {
      // Show / refresh the OS notification (the native FCM service usually posted
      // it already; this covers a socket-first race). Both key the notification on
      // callId.hashCode(), so this is a refresh — never a duplicate. No in-app
      // ringtone: the call notification channel rings. Engine is warmed so a quick
      // Accept connects fast; the ring timeout still auto-misses if unanswered.
      displayIncomingCallNotifee({
        callId: payload?.callId,
        callerId,
        callerName: isGroup ? (payload?.groupName || 'Group call') : (peer?.name || 'Unknown'),
        callerImage: peer?.avatar || null,
        callType: payload?.media || 'audio',
      });
      armRingTimeout();
      ensureConnected();
      return;
    }
    // iOS with CallKit: the native call screen (reported below, or by the VoIP
    // push's AppDelegate handler on a killed/locked device) IS the ring UI and
    // plays the system ringtone — so don't also play the in-app expo-av ringtone
    // or expand the in-app ring overlay, which would double-ring and stack a
    // second screen under CallKit. The in-app CallOverlay takes over once the user
    // answers on the CallKit screen (accepted → overlay un-collapses). Every other
    // case (Android, or an iOS build without the CallKit native module) keeps the
    // in-app ring exactly as before.
    const useCallKit = Platform.OS === 'ios' && nativeCall.isAvailable();
    if (!useCallKit) startRinging('incoming');
    armRingTimeout();
    // Record whether the device was locked when this call arrived → back/end will
    // return to the lock screen instead of exposing the app. Use BOTH the live
    // keyguard check AND the native lock-receiver value (deviceLockedRef, driven by
    // SCREEN_OFF/USER_PRESENT) so a cold-start where one signal isn't ready yet still
    // treats a locked-screen call as locked — preventing navigation off the call.
    const locked = isDeviceLockedNow() || deviceLockedRef.current;
    lockedCallRef.current = locked;
    setLockedCall(locked);
    ensureConnected(); // wake the WebRTC engine so its `incoming` can land
    // Show the WhatsApp-style FULL-SCREEN incoming screen (rather than the
    // compact top banner) when the ring comes up while the app isn't in the
    // foreground — i.e. woken from background / over the lock screen. When the
    // app is actively in use, keep the non-intrusive banner. Callers may force
    // this via opts.expand (e.g. a full-screen-intent launch).
    // iOS: ALWAYS take over full-screen for an incoming call, even when the app is
    // foreground on another screen — iOS has no native call UI, so an incoming call
    // must cover whatever screen the user is on (WhatsApp behaviour), not just show
    // a top banner.
    const shouldExpand = useCallKit
      ? false // CallKit is the ring UI; the overlay un-collapses on answer.
      : (Platform.OS === 'ios'
        ? true
        : (opts.expand !== undefined ? opts.expand : AppState.currentState !== 'active'));
    if (shouldExpand) {
      dispatch({ type: ACT.SET_FLAG, key: 'incomingExpanded', value: true });
    }
    // The in-app ring (ringtone + UI) is now up — dismiss EVERY OS call
    // notification so its looping ringtone doesn't double with ours and the
    // heads-up doesn't sit on top of the in-app ringing screen (one UI at a
    // time). cancel-all avoids missing it when the posted id differs from the
    // live state id.
    cancelAllIncomingCallNotifee();
    // CRITICAL de-dup: converge on the SAME CallKit UUID the native iOS VoIP push
    // uses. The backend mints one RFC4122 `uuid` per call; the AppDelegate reports
    // CallKit with THAT uuid, while this JS socket path would otherwise mint its
    // OWN uuid for the `sig_..._<ms>` callId → CallKit sees TWO distinct calls for
    // one logical call (the duplicate incoming banner, and a leftover CallKit call
    // that lingers during/after an answered call). Binding callId→uuid HERE, before
    // we report, makes both paths share one UUID so CallKit collapses them into a
    // single call — and end/decline dismisses the exact call the native side put up.
    // No-op when the payload carries no uuid (older backend) → zero behaviour change.
    const backendCallUuid = payload?.uuid || payload?.callUuid || payload?.callKitUuid || null;
    if (backendCallUuid && payload?.callId) {
      nativeCall.registerCallUuid(payload.callId, backendCallUuid);
    }
    // iOS CallKit: report the incoming call so the native call screen rings (also
    // when foreground). Skipped when a VoIP push already reported it (opts.skip
    // NativeUi) to avoid a duplicate CallKit call. No-op on Android (CallKeep is
    // iOS-gated; Android rings via expo-call-ui CallStyle instead).
    if (!opts.skipNativeUi) {
      nativeCall.displayIncomingCall(
        payload?.callId, callerId,
        isGroup ? (payload?.groupName || 'Group call') : peer.name,
        (payload?.media || 'audio') === 'video',
      );
    }
  }, [myId, startRinging, armRingTimeout, ensureConnected]);

  // Match an inbound lifecycle signal to the current call (by signalId if known).
  const matchesCurrent = (payload) => {
    const snap = stateRef.current;
    if (snap.status === CALL_STATUS.IDLE) return false;
    const pid = payload?.callId ? String(payload.callId) : null;
    if (!pid) {
      // No id on the event. Every current backend terminal emit carries a
      // callId, so an id-less frame is legacy/stale — let it dismiss a ringing
      // (not yet answered) call for compatibility, but never end a call the
      // user has already answered.
      return !snap.answeredAt && snap.status !== CALL_STATUS.ACTIVE;
    }
    // signalId and the WebRTC callId can differ + reconcile late. A terminal event
    // keyed on EITHER must be honoured — dropping it on a signalId-only mismatch was
    // a cause of one-sided ending / ghost ringing.
    const ids = [snap.signalId, snap.callId].filter(Boolean).map(String);
    if (ids.length === 0) return true;
    return ids.includes(pid);
  };
  // Terminal signal for a call whose JS state never built (or already reset) —
  // but the NATIVE ring can still be up: the iOS AppDelegate reports every VoIP
  // push to CallKit before JS stages INCOMING, and the Android CallStyle
  // notification rings on its own. matchesCurrent() returning false used to
  // drop these signals entirely, leaving the device RINGING/VIBRATING with no
  // call UI anywhere ("device vibrate but call ui not show"). Silence the
  // native surfaces and remember the id so a late push can't re-ring it.
  // Guarded to IDLE/ENDED so a mismatched id can never touch a LIVE call.
  const dismissGhostRing = useCallback((payload) => {
    const pid = payload?.callId ? String(payload.callId) : null;
    if (!pid) return;
    const st = stateRef.current.status;
    if (st !== CALL_STATUS.IDLE && st !== CALL_STATUS.ENDED) return;
    if (__DEV__) console.log('[CALL][APP] terminal signal for un-staged call — dismissing native ring', { callId: pid });
    cancelAllIncomingCallNotifee();
    nativeCall.dismissIncoming(pid, payload?.uuid || null);
    const re = recentEndedRef.current;
    recentEndedRef.current = (Date.now() - re.ts < 60000)
      // Fresh guard window: merge the id, KEEP the earlier ts (extending it
      // would stretch the same-peer 8s window and could eat a genuine redial).
      ? { ...re, ids: [...re.ids, pid].slice(-6) }
      : { ids: [pid], peerId: null, ts: Date.now() };
  }, []);
  const onSignalCancelled = useCallback((payload) => {
    if (!matchesCurrent(payload)) { dismissGhostRing(payload); return; }
    finalizeEnd(stateRef.current.direction === 'incoming' ? 'missed' : 'cancelled');
  }, [finalizeEnd, dismissGhostRing]);
  const onSignalRejected = useCallback((payload) => {
    if (!matchesCurrent(payload)) return;
    const snap = stateRef.current;
    if (snap.isGroup) {
      // ONE member declining must never end the group call — drop only them;
      // the call ends when nobody is left on the roster.
      const by = payload?.by != null ? String(payload.by) : null;
      if (by) removeGroupParticipant(by, 'rejected');
      return;
    }
    finalizeEnd('rejected');
  }, [finalizeEnd, removeGroupParticipant]);
  const onSignalEnded = useCallback((payload) => {
    if (!matchesCurrent(payload)) { dismissGhostRing(payload); return; }
    const snap = stateRef.current;
    if (snap.isGroup) {
      const by = payload?.by != null ? String(payload.by) : null;
      // The HOST hanging up before we joined the media room cancels the whole
      // thing for us (nothing to connect to); once we're connected the media
      // layer ('ended'/peerLeft) is authoritative for a host exit.
      if (by && by === String(snap.peer?.id || '') && snap.direction === 'incoming' && !snap.remoteJoined) {
        finalizeEnd('completed');
        return;
      }
      // A member leaving ends only THEIR tile, not the call.
      if (by) removeGroupParticipant(by, 'completed');
      return;
    }
    finalizeEnd('completed');
  }, [finalizeEnd, removeGroupParticipant, dismissGhostRing]);
  // Caller-only safety net: the server says the callee is unreachable (logged
  // out / deactivated / deleted / blocked / no active session). The ring ack
  // usually catches this first; this covers the case where the event lands after
  // the dial already started. Ends the outgoing call with the server's message.
  const onSignalUnavailable = useCallback((payload) => {
    if (!matchesCurrent(payload)) return;
    if (stateRef.current.direction !== 'outgoing') return;
    finalizeEnd('failed', payload?.message || 'User is unavailable right now.');
  }, [finalizeEnd]);
  // Only the CALLER receives this: the callee answered over the app socket.
  // Stop the "no answer" ring timeout so a slow WebRTC media stream can't trip a
  // false "missed", and reflect "Connecting…" until the `stream` flips to ACTIVE.
  const onSignalAccepted = useCallback((payload) => {
    if (!matchesCurrent(payload)) return;
    const snap = stateRef.current;
    if (snap.direction !== 'outgoing') return;
    clearRingTimeout();
    if (snap.status === CALL_STATUS.OUTGOING && !snap.accepted) {
      dispatch({ type: ACT.SET_FLAG, key: 'accepted', value: true });
      // Start the caller's timer the moment the callee answers (preserved into
      // ACTIVE when media connects, so it counts from answer like WhatsApp).
      if (!snap.answeredAt) dispatch({ type: ACT.SET_FLAG, key: 'answeredAt', value: Date.now() });
      // The ring timeout is cleared now; guard against the media never connecting
      // after the answer (otherwise the caller hangs on "Connecting…" too).
      armConnectWatchdog();
    }
  }, [clearRingTimeout, armConnectWatchdog]);

  // Server-authoritative end-of-ring (XR-1 / APP-4). The backend ring timer fired
  // before either side hung up. Previously the caller's end-of-ring depended ONLY
  // on the local timer (armRingTimeout) — clock skew between server and device
  // could double-end or ring past the server's window. Honour the server signal:
  // an outgoing call ends as "No answer"; an un-accepted incoming becomes missed.
  const onSignalTimeout = useCallback((payload) => {
    if (!matchesCurrent(payload)) { dismissGhostRing(payload); return; }
    const snap = stateRef.current;
    // Group call where someone already JOINED: the server ring window closing
    // only clears the still-unanswered members — the live call continues.
    if (snap.isGroup && snap.answeredAt) {
      Object.values(snap.participants || {})
        .filter((p) => p && !p.joined)
        .forEach((p) => removeGroupParticipant(p.id));
      return;
    }
    if (snap.direction === 'outgoing') finalizeEnd('cancelled', 'No answer');
    else if (snap.direction === 'incoming' && !snap.answeredAt) finalizeEnd('missed');
  }, [finalizeEnd, removeGroupParticipant, dismissGhostRing]);

  // Multi-device dismissal (XR-1 / APP-4). Another device on THIS account handled
  // the call, or the caller cancelled — dismiss the ring on THIS device. finalizeEnd
  // tears down the ring UI / ringtone / notifee / CallKit by callId. Map the reason:
  // answered elsewhere → 'completed' (quiet dismiss, no "missed" notification);
  // anything else → 'missed' for an un-answered incoming, else 'cancelled'.
  const onSignalCancelledElsewhere = useCallback((payload) => {
    if (!matchesCurrent(payload)) return;
    const snap = stateRef.current;
    const reason = String(payload?.reason || '');
    if (reason === 'answered_elsewhere' || reason === 'accepted_elsewhere') {
      // WE are the winning device → this is a stray sibling-dismiss that leaked
      // to a duplicate socket of our own device (the server carries the winner's
      // deviceId in the payload). It must not end the call we just answered.
      const winnerDevice = payload?.winnerDeviceId ? String(payload.winnerDeviceId) : null;
      if (winnerDevice && deviceIdRef.current && winnerDevice === deviceIdRef.current) return;
      // Same defense without a deviceId: once OUR answer produced a connected
      // call (remote media flowing), an "answered elsewhere" dismissal can only
      // be stale — the answer-lock would have blocked our accept otherwise.
      if (snap.status === CALL_STATUS.ACTIVE && snap.remoteJoined) return;
      finalizeEnd('completed');
      return;
    }
    if (snap.direction === 'incoming' && !snap.answeredAt) finalizeEnd('missed');
    else finalizeEnd('cancelled');
  }, [finalizeEnd]);

  // Recovery pull (XR-2 / APP-5). On socket (re)connect (incl. cold start) while
  // we're IDLE, ask the server for any invite that is STILL ringing for us — a
  // push-woken / just-reconnected callee whose live `call:incoming` was missed
  // (CallStyle notif timed out, socket was down) recovers the ring here.
  const pullStillRingingInvites = useCallback(async () => {
    if (stateRef.current.status !== CALL_STATUS.IDLE) return;
    try {
      // RETRY (observed live): the pull fires the instant the socket connects,
      // but the backend may not have finished binding this socket's session yet —
      // the ACK comes back `{ok:false, error:'not authenticated'}` even though
      // the very same socket receives user-targeted events (call:incoming)
      // moments later. Without a retry, a cold-started app silently loses its
      // one chance to recover a still-ringing invite. Retry a couple of times
      // with backoff; a no-ack timeout resolves ok:true and stops the loop.
      let ack = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt) {
          await new Promise((r) => setTimeout(r, 1200 * attempt));
          if (stateRef.current.status !== CALL_STATUS.IDLE) return; // a real ring landed meanwhile
        }
        ack = await pullPendingCalls();
        if (ack?.ok !== false) break; // success (or optimistic timeout) — done
      }
      const calls = Array.isArray(ack?.calls) ? ack.calls : [];
      if (!calls.length) {
        // Sweep ONLY on an AUTHORITATIVE empty answer. A session-bind failure
        // (ok:false after retries) or a no-ack timeout is a GUESS, not server
        // truth — sweeping on it killed the CallKit call the user had JUST
        // answered on a cold boot (app opened to nothing, caller kept ringing).
        if (ack?.ok === false || ack?.timedOut) return;
        // Server-truth reconcile: NOTHING is ringing for us. Any CallKit call
        // iOS is still showing is a GHOST — a VoIP-rung call whose cancel never
        // reached the killed/locked app (Apple forbids a VoIP cancel push), or a
        // call orphaned by a JS crash/reload — and it holds the audio session +
        // an ongoing-call UI the user can't control. Sweep it. The 1500ms delay
        // lets a VoIP push racing this pull commit its INCOMING state first; the
        // IDLE re-check guarantees a live/ringing call is never touched.
        setTimeout(() => {
          if (stateRef.current.status === CALL_STATUS.IDLE) nativeCall.endAllCalls();
        }, 1500);
        return;
      }
      if (stateRef.current.status !== CALL_STATUS.IDLE) return; // a real ring landed meanwhile
      // Take the freshest still-ringing invite and render it through the normal
      // incoming path (shows ring + wakes the WebRTC engine to reconcile callId).
      const inv = calls[0] || {};
      const from = inv.from || {};
      onSignalIncoming({
        from: {
          id: (from.id != null ? String(from.id) : (inv.callerId != null ? String(inv.callerId) : null)),
          name: from.name || inv.callerName || 'Unknown',
          avatar: from.avatar || inv.callerImage || null,
        },
        callId: inv.callId || null,
        media: inv.media || inv.callType || 'audio',
        members: Array.isArray(inv.members) ? inv.members : [],
        isGroup: !!inv.isGroup,
        groupId: inv.groupId || null,
        groupName: inv.groupName || null,
      });
    } catch (_) { /* best-effort recovery */ }
  }, [onSignalIncoming]);

  // Attach the server→client call listeners, re-attaching whenever the socket
  // (re)connects so a fresh underlying instance keeps them.
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    const handlers = {
      onIncoming: onSignalIncoming,
      onCancelled: onSignalCancelled,
      onAccepted: onSignalAccepted,
      onRejected: onSignalRejected,
      onEnded: onSignalEnded,
      onUnavailable: onSignalUnavailable,
      onTimeout: onSignalTimeout,
      onCancelledElsewhere: onSignalCancelledElsewhere,
    };
    let unsub = () => {};
    let wasConnected = false;
    const unsubState = subscribeSocketState((s) => {
      const connected = !!s.connected;
      if (connected && !wasConnected) {
        unsub();
        unsub = registerCallSignalListeners(handlers);
        // On every (re)connect while IDLE, recover any still-ringing invite the
        // device may have missed while offline / killed (XR-2 / APP-5).
        pullStillRingingInvites();
      }
      wasConnected = connected;
    });
    return () => { unsub(); unsubState(); };
  }, [isAuthenticated, onSignalIncoming, onSignalCancelled, onSignalAccepted, onSignalRejected, onSignalEnded, onSignalUnavailable, onSignalTimeout, onSignalCancelledElsewhere, pullStillRingingInvites]);

  // ---- incoming call from an FCM PUSH (callee offline / app backgrounded) ----
  // The push wakes the device; we reuse onSignalIncoming (which shows the ring +
  // wakes the WebRTC engine so its `incoming` can reconcile the real callId). The
  // push's callId is the app-socket signaling id (set as signalId).
  const mapPushToIncoming = useCallback((data) => ({
    from: {
      id: data?.callerId ? String(data.callerId) : null,
      name: data?.callerName || 'Unknown',
      avatar: data?.callerImage || null,
    },
    callId: data?.callId || null, // signaling id → onSignalIncoming stores as signalId
    media: data?.callType || data?.media || 'audio',
    members: [],
    isGroup: false,
    groupId: null,
    groupName: null,
  }), []);

  const onPushIncoming = useCallback((data) => {
    if (!data?.callerId) return;
    // Drop a buffered/late-flushed call push. Doze / a force-stopped OEM can hold
    // the high-priority push and then deliver a BURST when the app is reopened —
    // which rang every long-over call at once. `data.ts` (backend sent-at) lets us
    // suppress anything older than the ring window so only a genuinely live call
    // rings. (The FCM bg handler drops these before display too; this guards the
    // foreground / cold-launch / notification-tap emit paths.)
    //
    // The most common trigger is opening the app by tapping a call notification
    // that LINGERED after the call already ended (its cancel/missed push never
    // arrived while the device was locked/killed): that replay carries no backend
    // `ts`, but isStaleCallPush falls back to the dial time embedded in the
    // signaling callId. Dismiss the dead notification so it can't ring again.
    if (isStaleCallPush(data)) {
      if (__DEV__) console.log('[CALL][APP] stale incoming push/tap dropped — call is over', { callId: data?.callId });
      cancelAllIncomingCallNotifee();
      // iOS: the AppDelegate ALREADY reported this dead call to CallKit (Apple
      // requires reporting every VoIP push). Dismiss that ring NOW with
      // remote-ended instead of letting a call that's long over ring the
      // full-screen CallKit UI until its timeout.
      if (data?._voip) nativeCall.dismissIncoming(data?.callId, data?.uuid);
      return;
    }
    // iOS VoIP push: the AppDelegate already reported this call to CallKit with
    // the backend-supplied `uuid`. Bind that uuid to our signaling callId so a
    // later end/decline (finalizeEnd → nativeCall.endCall(signalId)) dismisses the
    // exact CallKit call the native side put up, instead of a mismatched uuid that
    // would leave the CallKit screen lingering after the call is over.
    if (data?._voip && data?.uuid && data?.callId) {
      nativeCall.registerCallUuid(data.callId, data.uuid);
    }
    // AGED (but not stale) push: it sat queued in FCM/APNs while the device was
    // offline/airplane — the call may ALREADY be cancelled, and its cancel push
    // can arrive out of order behind it (FCM guarantees no cross-message
    // ordering). Don't ring a maybe-dead call: ask the SERVER instead — the
    // pending pull is authoritative (every terminal path removes the record).
    // A genuinely live invite re-rings via the pull's call:incoming within a
    // round trip; a dead one stays silent, and the pull's authoritative-empty
    // sweep dismisses the CallKit ring the AppDelegate already reported (the
    // uuid was just bound above). This is what stops "B airplane se wapas aaya
    // to A ki kati hui purani call bajne lagi" — while a fresh push (the live
    // path, seconds old) still rings instantly.
    {
      const age = callPushAgeMs(data);
      if (Number.isFinite(age) && age > AGED_CALL_PUSH_MS) {
        if (__DEV__) console.log('[CALL][APP] aged call push — verifying with server before ringing', { callId: data?.callId, ageSec: Math.round(age / 1000) });
        cancelAllIncomingCallNotifee();
        pullStillRingingInvites();
        return;
      }
    }
    // A push-driven ring means the app wasn't foreground (or it's a full-screen
    // intent launch) → bring up the full-screen incoming screen.
    const expand = !!data?._fullScreen || AppState.currentState !== 'active';
    // A VoIP push (iOS) is already reported to CallKit by the AppDelegate; don't
    // report it a second time from JS.
    // `fullScreen` forces the full-screen CallOverlay (never notification-only) for a
    // notification/full-screen-intent launch — the killed/locked wake case the user
    // expects to ring full-screen over the lock screen.
    onSignalIncoming(mapPushToIncoming(data), {
      expand,
      fullScreen: !!data?._fullScreen,
      skipNativeUi: !!data?._voip,
    });
  }, [onSignalIncoming, mapPushToIncoming]);

  // Accept tapped on the notification (or a plain tap): make sure the ringing
  // state exists (cold start from a killed app), then answer once it commits.
  const onPushAccept = useCallback((data) => {
    if (!data?.callerId) return;
    // Accept tapped on a call notification that lingered after the call already
    // ended → don't build a ghost ringing state that hangs 30s on the connect
    // watchdog. Same staleness test as onPushIncoming (dial time embedded in the
    // signaling callId when the replay carries no backend `ts`); clear the notif.
    if (isStaleCallPush(data)) {
      if (__DEV__) console.log('[CALL][APP] stale accept-tap dropped — call is over', { callId: data?.callId });
      cancelAllIncomingCallNotifee();
      // Same fast-dismiss as onPushIncoming: the CallKit ring for this dead
      // call is already up — drop it rather than ring to timeout.
      if (data?._voip) nativeCall.dismissIncoming(data?.callId, data?.uuid);
      return;
    }
    const snap = stateRef.current;
    // Already ringing this call (e.g. a foreground notification-only call whose
    // INCOMING state was built on ARRIVAL) → answer NOW. The pending-accept effect
    // below only re-runs when status/accepted CHANGE, and here status is already
    // INCOMING, so it would never fire — leaving the first call un-answered AND a
    // stale pendingAccept flag that auto-accepted the NEXT call. Accept directly
    // instead and never arm the flag.
    if (snap.status === CALL_STATUS.INCOMING && !snap.accepted) {
      accept();
      return;
    }
    // Cold start / killed: build the ringing state first, then the pending-accept
    // effect fires accept() the moment status flips to INCOMING. fromAccept forces
    // the full in-app connect path (not the notification-only path).
    onSignalIncoming(mapPushToIncoming(data), { expand: true, fromAccept: true });
    pushAcceptPendingRef.current = true;
  }, [accept, onSignalIncoming, mapPushToIncoming]);

  // Decline from the notification: reject if we're ringing, else tell the caller
  // over the app socket directly (best-effort — needs the socket connected).
  const onPushReject = useCallback((data) => {
    const snap = stateRef.current;
    if (snap.status === CALL_STATUS.INCOMING) { reject(); return; }
    rejectCallSignal({ callId: data?.callId || null, callerId: data?.callerId || null });
  }, [reject]);

  // End tapped on the active-call ongoing notification → hang up the live call.
  const onPushHangup = useCallback(() => {
    const snap = stateRef.current;
    if (snap.status === CALL_STATUS.IDLE || snap.status === CALL_STATUS.ENDED) return;
    if (snap.status === CALL_STATUS.INCOMING) reject(); else hangup();
  }, [reject, hangup]);

  // Body tap on the active-call ongoing notification → bring the call forward
  // (un-minimize so CallOverlay shows full-screen once the app is foregrounded).
  const onPushResume = useCallback(() => {
    const snap = stateRef.current;
    if (snap.status === CALL_STATUS.IDLE) return;
    maximize();
  }, [maximize]);

  // NOT auth-gated: the iOS VoIP replay (voipPushService didLoadWithEvents) and
  // Android FCM emits fire the instant their registration runs — attaching these
  // listeners only after auth restore silently dropped a cold boot's incoming
  // event, adding seconds (or a total loss) before the ring state existed. The
  // ring state is local; everything that needs auth (accept → token mint →
  // engine connect) still waits for it downstream.
  useEffect(() => {
    const subs = [
      DeviceEventEmitter.addListener(CALL_PUSH_EVENTS.INCOMING, onPushIncoming),
      DeviceEventEmitter.addListener(CALL_PUSH_EVENTS.ACCEPT, onPushAccept),
      DeviceEventEmitter.addListener(CALL_PUSH_EVENTS.REJECT, onPushReject),
      DeviceEventEmitter.addListener(CALL_PUSH_EVENTS.HANGUP, onPushHangup),
      DeviceEventEmitter.addListener(CALL_PUSH_EVENTS.RESUME, onPushResume),
    ];
    return () => subs.forEach((s) => { try { s.remove(); } catch (_) {} });
  }, [onPushIncoming, onPushAccept, onPushReject, onPushHangup, onPushResume]);

  // Cold start: replay the notification that launched the app (Accept tap /
  // full-screen / body) ONLY once the user is authenticated — the replay builds
  // ring state that immediately drives accept(), which needs the authenticated
  // token mint; consuming it pre-auth would burn the one-shot launch action.
  // This is the single source of truth for the initial action (App.js no longer
  // does it).
  useEffect(() => {
    if (!isAuthenticated) return;
    consumeInitialNotifeeCall();
  }, [isAuthenticated]);

  // Fire the deferred Accept (from a call-push / CallKit Answer that landed
  // before the ringing state committed) — or the deferred Decline (CallKit End
  // on a cold boot) — the moment the ringing state is committed. accept()
  // itself no-ops unless status is INCOMING.
  useEffect(() => {
    if (state.status !== CALL_STATUS.INCOMING || state.accepted) return;
    // A CallKit End that fired before INCOMING committed (lock-screen decline
    // during cold boot) declines the recovered ring — otherwise the pending
    // pull would ring the phone AGAIN for a call the user already dismissed.
    // Honored only briefly so a stale flag can never kill a future call.
    if (nativeEndPendingRef.current) {
      const fresh = Date.now() - nativeEndPendingRef.current < 45000;
      nativeEndPendingRef.current = 0;
      if (fresh) {
        pushAcceptPendingRef.current = false;
        reject();
        return;
      }
    }
    if (pushAcceptPendingRef.current) {
      pushAcceptPendingRef.current = false;
      accept();
    }
  }, [state.status, state.accepted, accept, reject]);

  // Enforce "one incoming-call UI at a time" (FCM heads-up OR in-app banner — not
  // both). While the app is foreground the in-app ringing screen is the single
  // UI, so dismiss the OS call notification. Re-checks on every foreground so a
  // notification shown while backgrounded is cleared the moment the user opens
  // the app (or the full-screen intent launches it) mid-ring. Backgrounded rings
  // keep their notification (this effect only fires while status is INCOMING and
  // the app is active).
  useEffect(() => {
    if (state.status !== CALL_STATUS.INCOMING) return undefined;
    // notificationOnly (foreground call) deliberately shows ONLY the OS
    // notification, so do NOT dismiss it here — that's the whole UI for this call.
    if (state.notificationOnly) return undefined;
    if (AppState.currentState === 'active') cancelAllIncomingCallNotifee();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') cancelAllIncomingCallNotifee();
    });
    return () => { try { sub.remove(); } catch (_) { /* */ } };
  }, [state.status, state.notificationOnly]);

  // Keep the latest action handles available to the native OS-call listeners.
  actionsRef.current = {
    accept, reject, hangup, toggleMic, reassertCallAudio, restartEngineAudio, pullStillRingingInvites,
    reassertSpeakerRoute,
  };
  onEngineEventRef.current = onEngineEvent;

  // Native engine events ride the SAME handler the WebView's postMessage path
  // feeds — the two engines are interchangeable behind the protocol.js surface.
  useEffect(() => {
    if (!isNativeCallEngine()) return undefined;
    return nativeEngine.subscribe((type, payload) => onEngineEventRef.current(type, payload));
  }, []);

  // mount/teardown engine with auth
  useEffect(() => {
    if (!isAuthenticated) {
      setEngineReady(false);
      connectingRef.current = false;
      // The engine WebView unmounts on logout and reloads on re-login, so the
      // loaded-HTML guard + any queued connect must reset (a stale `true` would
      // make doConnect inject CONNECT into a not-yet-loaded WebView).
      htmlReadyRef.current = false;
      pendingConnectRef.current = null;
      clearCachedCallToken();
      clearRingTimeout();
      stopRinging();
      // Logout: end any CallKit call and drop ALL uuid bookkeeping — a mapping
      // leaked across logout→login in the same JS runtime could dismiss or
      // dedupe against the wrong call for the next account.
      nativeCall.resetAll();
      // Native engine: drop the SFU socket too (the WebView equivalent unmounts
      // with showEngine; the native engine has no mount to unmount).
      if (isNativeCallEngine()) nativeEngine.shutdown();
    }
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      clearRingTimeout();
    };
  }, [isAuthenticated, clearRingTimeout, stopRinging]);

  // Native call UI (CallKit / ConnectionService) — inert no-op unless
  // react-native-callkeep is installed and the app rebuilt. Maps OS actions
  // (answer/end/mute from the lock screen) onto our call actions.
  // NOT auth-gated: on a cold boot from a killed app the user's Answer/End on
  // the CallKit screen is buffered by RNCallKeep and replayed the moment these
  // listeners attach (didLoadWithEvents). Gating on isAuthenticated delayed
  // that attach behind auth restore — on a slow restore the buffered Answer sat
  // unprocessed while the backend ring window elapsed, so the just-accepted
  // call died ("black screen, caller keeps ringing"). The handlers themselves
  // only defer flags / no-op safely pre-auth; accept() still waits for the
  // authenticated engine connect.
  useEffect(() => {
    if (!nativeCall.isAvailable()) return undefined;
    nativeCall.setup();
    const unsub = nativeCall.registerEvents({
      onAnswer: () => {
        const snap = stateRef.current;
        // Ring state already committed (VoIP push / socket built INCOMING) →
        // answer now. On a cold launch from a killed device the CallKit answer can
        // fire BEFORE the push's INCOMING state lands; defer via the same
        // pending-accept flag so accept() runs the moment INCOMING commits (a bare
        // accept() would no-op against a not-yet-INCOMING state and be lost).
        if (snap.status === CALL_STATUS.INCOMING && !snap.accepted) {
          actionsRef.current.accept && actionsRef.current.accept();
        } else if (snap.status === CALL_STATUS.IDLE) {
          // Cold boot: the ring state hasn't committed yet — flag the answer so
          // the flush effect accepts the moment INCOMING lands.
          pushAcceptPendingRef.current = true;
          // The ring state depends on auth + socket + the connect-time pending
          // pull — which fires ONCE and can lose the cold-boot race (session
          // still binding after its retries). The user has ALREADY answered on
          // CallKit, so keep pulling until the ring commits. If nothing commits
          // within the window, clear the stuck CallKit call instead of leaving
          // a dead "connected" call the app never joined.
          let tries = 0;
          const iv = setInterval(() => {
            tries += 1;
            const cur = stateRef.current;
            if (cur.status !== CALL_STATUS.IDLE || !pushAcceptPendingRef.current) { clearInterval(iv); return; }
            if (tries > 10) {
              clearInterval(iv);
              pushAcceptPendingRef.current = false;
              nativeCall.endAllCalls();
              return;
            }
            actionsRef.current.pullStillRingingInvites && actionsRef.current.pullStillRingingInvites();
          }, 2000);
        }
        // Accepted / active / ended → this is the ECHO of our own
        // answerIncomingCall (in-app accept), or a stale replay. Arming the
        // pending flag here would auto-accept the NEXT incoming call.
      },
      onEnd: () => {
        const snap = stateRef.current;
        if (snap.status === CALL_STATUS.INCOMING) { actionsRef.current.reject && actionsRef.current.reject(); return; }
        // ENDED = the echo of OUR OWN teardown: finalizeEnd's endCall/endAllCalls
        // file CXEndCallActions whose 'endCall' events bounce back here after the
        // mappings are already forgotten. Ignore — arming the decline flag here
        // would silently reject the NEXT incoming call.
        if (snap.status === CALL_STATUS.ENDED) return;
        if (snap.status === CALL_STATUS.IDLE) {
          // Cold boot: End tapped on the CallKit screen before the ring state
          // committed. Flag it (timestamped) so the flush effect declines the
          // recovered ring instead of ringing the phone again — and make sure
          // a buffered Answer from the same replay can't win over the End.
          nativeEndPendingRef.current = Date.now();
          pushAcceptPendingRef.current = false;
          return;
        }
        actionsRef.current.hangup && actionsRef.current.hangup();
      },
      onToggleMute: (callId, muted) => {
        const snap = stateRef.current;
        // Sync our mic flag with the OS toggle if they diverge.
        if (snap.micOn === muted) actionsRef.current.toggleMic && actionsRef.current.toggleMic();
      },
      // CallKit activated its own AVAudioSession (call answered from killed/locked,
      // or an interruption ended). This is the moment WebRTC audio can start in the
      // background — re-assert our play-and-record session AND force the engine to
      // rebuild its audio pipeline: tracks created before the session switch stay
      // 'live' but their WebKit audio units are dead (silence both ways). A short
      // second pass catches producers that finish setup just after this event.
      onAudioSessionActivated: () => {
        // NATIVE engine: hand the CallKit-activated session to WebRTC FIRST —
        // react-native-webrtc never learns about CallKit on its own, and its
        // audio unit (re)starts only against a session it knows is live. This
        // is deliberately NOT gated on call state: during a cold-start replay
        // the activation can arrive before the ring state is flushed, and the
        // sync is harmless when idle.
        if (isNativeCallEngine()) audioSessionDidActivate();
        actionsRef.current.reassertCallAudio && actionsRef.current.reassertCallAudio();
        actionsRef.current.restartEngineAudio && actionsRef.current.restartEngineAudio();
        setTimeout(() => {
          actionsRef.current.restartEngineAudio && actionsRef.current.restartEngineAudio();
          // CallKit's activation can override the output route AFTER our first
          // re-assert (reassertCallAudio above) — assert the button's route once
          // more when the rebuilt audio pipeline has settled.
          actionsRef.current.reassertSpeakerRoute && actionsRef.current.reassertSpeakerRoute();
        }, 1200);
      },
      // CallKit released the session (call ended / interruption began). Without
      // this, react-native-webrtc's RTCAudioSession stays marked active and the
      // NEXT call's audio unit starts against a dead session — the classic
      // "second call is silent" pattern.
      onAudioSessionDeactivated: () => {
        if (isNativeCallEngine()) audioSessionDidDeactivate();
      },
    });
    return () => { unsub(); };
  }, []);

  // iOS PushKit: register the VoIP token + listen for incoming VoIP pushes so a
  // terminated/locked app rings via CallKit (the AppDelegate PushKit → CallKit
  // path). This is INDEPENDENT of nativeCall.isAvailable() / IOS_CALLKIT_ENABLED:
  // that switch only gates the in-call CallKit flow, whereas the native incoming
  // path works regardless and needs the VoIP token to have been registered with
  // the backend. registerVoipPush() itself no-ops on Android / Expo Go.
  // NOT auth-gated: registering at JS boot means (a) the buffered VoIP push
  // that COLD-LAUNCHED the app replays into the (already-attached) listeners
  // immediately — the ring state exists seconds before auth restore finishes —
  // and (b) the PushKit token lands in the socket layer's cache, which
  // re-registers it with the backend on every socket connect. No-op on
  // Android / Expo Go.
  useEffect(() => {
    const unsubVoip = registerVoipPush();
    return () => { unsubVoip(); };
  }, []);

  const value = {
    call: state,
    engineReady,
    isExpoGo: IS_EXPO_GO,
    presenceMap,
    audioRouteSupported,
    maxParticipants: MAX_PARTICIPANTS,
    // True while ANY call is in flight (dialing out, ringing in, connecting, or
    // active) — used to disable the audio/video call buttons everywhere so a
    // second call can't be started over a live one. ENDED is included because
    // the call is still tearing down and the start path is still blocked.
    callBusy: state.status !== CALL_STATUS.IDLE,
    startAudioCall,
    startVideoCall,
    startGroupAudioCall,
    startGroupVideoCall,
    accept,
    reject,
    hangup,
    toggleMic,
    toggleCamera,
    switchCamera,
    toggleScreenShare,
    inviteMoreToCall,
    toggleSpeaker,
    resumeAudio,
    minimize,
    maximize,
    expandIncoming,
    queryPresence,
    lockedCall,
    leaveToLock,
  };

  // Both engines share the SAME host container (full-screen video stage /
  // draggable PiP): the WebView engine renders the WebView (it IS the video
  // surface), the native engine renders RTCView tiles via NativeVideoStage.
  const showEngine = isAuthenticated && !IS_EXPO_GO;
  const videoActive = state.media === 'video'
    && (state.status === CALL_STATUS.ACTIVE || state.status === CALL_STATUS.OUTGOING || state.status === CALL_STATUS.INCOMING);
  // Video call minimized → the engine WebView itself becomes the draggable PiP
  // (it IS the video surface), like WhatsApp's floating video window. A voice
  // call minimizes to the CallMiniBanner top bar in CallOverlay instead.
  const videoPip = videoActive && state.minimized;
  const { pan: pipPan, panHandlers: pipPanHandlers } = useDraggablePip({
    width: PIP_W, height: PIP_H, enabled: videoPip, initial: 'top-right',
  });

  // The engine host is ALWAYS the same Animated.View wrapping the SAME WebView
  // instance — only its style/handlers change between parked / full-screen /
  // PiP. Never swap the wrapper element type or the WebView would remount and
  // drop the live call.
  let hostStyle = styles.engineHostParked;
  if (videoPip) hostStyle = styles.enginePip;
  else if (videoActive) hostStyle = styles.engineHostVisible;

  return (
    <CallContext.Provider value={value}>
      {children}
      {showEngine && (
        <Animated.View
          collapsable={false}
          pointerEvents={videoActive ? 'auto' : 'none'}
          style={[hostStyle, videoPip ? { transform: pipPan.getTranslateTransform() } : null]}
          {...(videoPip ? pipPanHandlers : {})}
        >
          {isNativeCallEngine() ? (
            <NativeVideoStage />
          ) : (
            <CallEngineWebView
              ref={webRef}
              onEvent={onEngineEvent}
              style={styles.engineFill}
            />
          )}
          {videoPip ? (
            <>
              {/* Tap the PiP (anywhere not a button) to restore the full call screen. */}
              <Pressable style={StyleSheet.absoluteFill} onPress={maximize} />
              <View style={styles.pipTopRow} pointerEvents="box-none">
                <CallTimer startMs={state.answeredAt} style={styles.pipTimer} />
              </View>
              <View style={styles.pipBottomRow} pointerEvents="box-none">
                <TouchableOpacity onPress={hangup} activeOpacity={0.85} style={styles.pipEnd}>
                  <MaterialIcons name="call-end" size={16} color="#fff" />
                </TouchableOpacity>
              </View>
            </>
          ) : null}
        </Animated.View>
      )}
      <CallOverlay />
      {/* One-time "let calls ring when the app is closed / after restart"
          onboarding — jumps the user to battery-optimization + OEM Autostart
          toggles. Self-gates (Android + not-yet-granted + not dismissed) and only
          while idle, so it never covers a live call. */}
      {state.status === CALL_STATUS.IDLE ? <CallReliabilityGate /> : null}
      {/* Cold-start incoming-call cover (APP-14): painted instantly over
          Splash/ChatList on a killed+locked call launch, retired the moment the
          live call state mounts (CallOverlay takes over) or on the safety timeout. */}
      {coldStartCall && state.status === CALL_STATUS.IDLE ? (
        <ColdStartCallCover call={coldStartCall} />
      ) : null}
      {/* In-app incoming-call banner temporarily DISABLED — incoming calls are
          surfaced via the OS push/CallStyle notification instead. Re-enable by
          uncommenting when the in-app banner is wanted again. */}
      {/* <IncomingCallBanner /> */}
      {privacyMask && state.status === CALL_STATUS.IDLE ? (
        // Opaque, branded overlay over ALL content whenever the app is not in the
        // foreground and no call is in progress — hides chats during the lock
        // transition, over the keyguard (Android MainActivity has showWhenLocked),
        // and in the OS app-switcher / recents snapshot. Cross-platform on purpose:
        // iOS has no FLAG_SECURE, so this overlay is the snapshot protection there.
        // Suppressed while a call is in progress so the call UI may legitimately
        // show over the lock screen (LK6).
        <PrivacyOverlay />
      ) : null}
    </CallContext.Provider>
  );
};

const styles = StyleSheet.create({
  // Full-screen (behind the overlay) only during a video call.
  engineHostVisible: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: '#000',
    zIndex: 998,
  },
  // Parked: pushed OFF-SCREEN with a real (tiny) size — NOT zero-size. A 0x0
  // WebView suspends its media pipeline on Android/iOS, which silences the remote
  // audio of a voice call (the host is always parked for audio calls). Giving it a
  // real surface off-screen keeps audio flowing while staying invisible and out of
  // layout, so the engine being mounted can't shift the visible screen.
  engineHostParked: {
    position: 'absolute',
    left: -10000, top: -10000,
    width: 2, height: 2,
    overflow: 'hidden',
    opacity: 0,
  },
  // Minimized video call: a small floating, draggable, rounded video card that
  // sits above the app so the user can keep using it while the call continues.
  enginePip: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: PIP_W,
    height: PIP_H,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#000',
    zIndex: 1000,
    elevation: 1000,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.45,
    shadowRadius: 8,
  },
  pipTopRow: {
    position: 'absolute',
    top: 6,
    left: 6,
    right: 6,
    flexDirection: 'row',
    justifyContent: 'flex-start',
  },
  pipTimer: {
    fontSize: 11,
    fontFamily: 'Roboto-Medium',
    color: '#fff',
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    overflow: 'hidden',
  },
  pipBottomRow: {
    position: 'absolute',
    bottom: 8,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  pipEnd: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#EA0038',
    alignItems: 'center',
    justifyContent: 'center',
  },
  engineFill: {
    flex: 1,
    backgroundColor: 'transparent',
  },
});

export default CallProvider;
