import React, {
  createContext, useContext, useReducer, useRef, useCallback, useEffect, useState,
} from 'react';
import {
  Vibration, Alert, StyleSheet, View, DeviceEventEmitter, Linking, Platform,
  Animated, Pressable, TouchableOpacity,
} from 'react-native';
import Constants from 'expo-constants';
import { Audio } from 'expo-av';
import { useCameraPermissions } from 'expo-camera';
import { MaterialIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../contexts/AuthContext';
import CallEngineWebView from './engine/CallEngineWebView';
import CallOverlay from './screens/CallOverlay';
import IncomingCallBanner from './components/IncomingCallBanner';
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
import {
  ringCall, cancelCall, acceptCallSignal, rejectCallSignal, endCallSignal,
  registerCallSignalListeners,
} from './services/callSignalService';
import { subscribeSocketState } from '../Redux/Services/Socket/socket';
import { CALL_PUSH_EVENTS } from '../firebase/fcmService';

export const CallContext = createContext(null);
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
  const audioRouteAppliedRef = useRef(false); // did the user toggle Speaker this call? (so we reset routing on end)
  const presenceWaiters = useRef({}); // ref -> resolve
  const readyWaiters = useRef([]);    // [resolve]
  const pushAcceptPendingRef = useRef(false); // Accept tapped on a call push → answer once INCOMING is committed
  // Latest action handles, read by the native (CallKit/ConnectionService) event
  // listeners so they never close over stale callbacks.
  const actionsRef = useRef({});
  // On-device recording (admin "Listen Live"): only the CALLER records. We pin
  // the recorded callId to the app signaling id so it persists across the state
  // reset at hang-up, and guard against double-start.
  const recordingOnRef = useRef(false);
  const recordingCallIdRef = useRef(null);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { engineReadyRef.current = engineReady; }, [engineReady]);

  // ---- low-level command sender ----
  const sendCmd = useCallback((msg) => {
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
        playThroughEarpieceAndroid: !speakerOn,
      });
      if (__DEV__) console.log('[CALL][APP][audio] speaker route →', speakerOn ? 'LOUDSPEAKER' : 'earpiece');
    } catch (e) {
      if (__DEV__) console.log('[CALL][APP][audio] setAudioModeAsync failed', e?.message);
    }
  }, []);

  // Restore the default loudspeaker route when a call ends — ONLY if the user
  // toggled Speaker during it — so an earpiece choice never leaks into the next
  // call or other app audio.
  const resetAudioRoute = useCallback(async () => {
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

  // ---- connect lifecycle ----
  // Mint a fresh calling-service token (GET /call/token) and connect the engine.
  // Connect is EAGER: it fires the moment the engine WebView HTML loads (see the
  // 'engine html loaded' log case below) and the SDK stays connected. This is
  // REQUIRED — the calling service only routes a call's WebRTC media to peers
  // ALREADY registered on it, so a lazily-connected callee is unreachable when
  // the caller dials (rings over the app socket but no audio). Do not make this
  // lazy again. If a connect is attempted before the HTML is ready it is queued
  // in pendingConnectRef and flushed the instant the HTML signals ready.
  const doConnect = useCallback(async () => {
    if (IS_EXPO_GO) return;
    if (connectingRef.current || engineReadyRef.current) return;
    connectingRef.current = true;
    try {
      const { token, callBaseUrl } = await getCallToken({ force: true });
      if (!htmlReadyRef.current) {
        pendingConnectRef.current = { token, url: callBaseUrl };
        return;
      }
      sendCmd({ cmd: CMD.CONNECT, token, url: callBaseUrl });
    } catch (_) {
      connectingRef.current = false;
    }
  }, [sendCmd]);

  const ensureConnected = useCallback(async () => {
    if (engineReadyRef.current) return true;
    doConnect();
    // wait up to 8s for engineReady
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(engineReadyRef.current), 8000);
      readyWaiters.current.push(() => { clearTimeout(timer); resolve(true); });
    });
  }, [doConnect]);

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
    clearRingTimeout();
    clearMediaWatchdog();
    clearConnectWatchdog();
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

    // Dismiss the native call UI (no-op unless CallKeep is installed).
    if (snap.callId) nativeCall.endCall(snap.callId);

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
      // An outgoing call cancelled during "Calling…" (before the engine returns
      // a callId) still deserves a log row — synthesize a stable local id so it
      // records and de-dupes correctly. Incoming calls always carry a callId.
      const callId = snap.callId || `local_${snap.direction || 'out'}_${snap.startedAt || Date.now()}`;
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

    // return to chat shortly after showing the end state
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      endedRef.current = false;
      dispatch({ type: ACT.RESET });
    }, 1200);
  }, [myId, sendCmd, stopRinging, clearRingTimeout, clearMediaWatchdog, clearConnectWatchdog, resetAudioRoute]);

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
        // The engine WebView finished loading. Connect to the calling service NOW
        // (at login), and keep it connected — the SDK only routes a call's WebRTC
        // media to peers that are ALREADY registered on the service, so both the
        // caller and callee must be connected BEFORE a call starts. This mirrors
        // the working reference (call/frontend/app.js connects in login()). A lazy
        // connect leaves the callee unregistered when the caller dials, so the
        // call rings over the app socket but never transfers audio.
        if (String(payload?.message || '').includes('engine html loaded')) {
          htmlReadyRef.current = true;
          const pending = pendingConnectRef.current;
          pendingConnectRef.current = null;
          if (pending) sendCmd({ cmd: CMD.CONNECT, token: pending.token, url: pending.url });
          else doConnect();
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
            sendCmd({ cmd: CMD.ACCEPT, callId: realId, media: snap.media, speaker: snap.media === 'video' || snap.isGroup });
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
        startRinging('incoming');
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
        stopRinging();
        const snap = stateRef.current;
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
        if (snap.callId) nativeCall.setCurrentCallActive(snap.callId);
        // Call connected → begin recording for the admin monitor (caller only).
        maybeStartRecording();
        break;
      }
      case 'speakerResult': {
        // The engine confirms which audio output it actually switched to (after
        // enumerating devices + setSinkId, like the reference's setOutputActive).
        // Reflect that on the button so its on/off state is always the REAL route
        // — incl. the initial loudspeaker default for video/group calls, and a
        // failed earpiece switch that fell back to the speaker.
        const supported = payload?.supported !== false;
        setAudioRouteSupported(supported);
        if (typeof payload?.speaker === 'boolean') {
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
        break;
      }
      case 'camerachanged': {
        dispatch({ type: ACT.CAMERA_CHANGED, facingMode: payload?.facingMode });
        break;
      }
      case 'peerfacing': break;
      case 'needsUnmuteGesture': {
        dispatch({ type: ACT.NEEDS_UNMUTE, value: true });
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
          dispatch({ type: ACT.PARTICIPANT_LEFT, id });
          // End the group call only once the last connected participant leaves.
          const stillJoined = Object.values(snap.participants)
            .filter((p) => p && p.joined && p.id !== id).length;
          if (snap.status === CALL_STATUS.ACTIVE && stillJoined === 0) {
            finalizeEnd('completed');
          }
          break;
        }
        finalizeEnd('completed');
        break;
      }
      case 'ended': { finalizeEnd('completed'); break; }
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
  }, [doConnect, finalizeEnd, myId, sendCmd, startRinging, stopRinging, armRingTimeout, clearRingTimeout, clearMediaWatchdog, armMediaWatchdog, clearConnectWatchdog, maybeStartRecording]);

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
        message: isGroup ? 'Everyone is busy on another call' : 'User is busy on another call',
      });
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => { endedRef.current = false; dispatch({ type: ACT.RESET }); }, 1800);
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
    // The SDK's startCall acquires local media before it reaches the server; if
    // that hangs, surface it rather than ringing forever with no audio.
    armMediaWatchdog();
    // NOTE: the offline-callee wake push is now sent SERVER-SIDE from the
    // `call:ring` handler (presence-gated, with the real signaling callId +
    // caller identity), so the app no longer fires a blind per-peer /call/notify
    // here — that double-pushed offline users and needlessly pushed online ones.
  }, [ensureConnected, ensureMediaPermissions, myId, sendCmd, startRinging, stopRinging, armRingTimeout, armMediaWatchdog]);

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
    clearRingTimeout();
    stopRinging();
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
    acceptCallSignal({ callId: snap.signalId || null, callerId: snap.peer?.id || null });

    // Video / group calls answer on the loudspeaker; a 1:1 voice call on the earpiece.
    const wantSpeaker = snap.media === 'video' || snap.isGroup;

    // The callee only wakes the engine on the ring — that connect can still be
    // in flight (or have failed) when the user taps Accept. So on accept we
    // re-fetch a fresh calling-service token (GET /call/token) and CONNECT if the
    // engine isn't already up, guaranteeing a live WebRTC session before we
    // answer. This is what makes "accept" reliably connect rather than hang.
    const ready = await ensureConnected();
    if (__DEV__) console.log('[CALL][APP][accept] STEP 4 ensureConnected (engine ready?)', { ready });
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
      sendCmd({ cmd: CMD.ACCEPT, callId: cur.callId, media: cur.media, speaker: wantSpeaker });
      // The SDK's accept acquires local media before answering; watch for a hang.
      armMediaWatchdog();
    } else {
      // Engine is up but the WebRTC `incoming` (with the real callId) hasn't
      // arrived yet. Mark pending; the reconcile step fires CMD.ACCEPT — with
      // this same media/speaker — the moment the id lands.
      if (__DEV__) console.log('[CALL][APP][accept] STEP 5b callId NOT yet known → set pendingAccept, waiting for WebRTC incoming to reconcile (connect watchdog armed)');
      dispatch({ type: ACT.SET_FLAG, key: 'pendingAccept', value: true });
    }
  }, [sendCmd, stopRinging, clearRingTimeout, ensureConnected, ensureMediaPermissions, finalizeEnd, armMediaWatchdog, armConnectWatchdog]);

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
    const next = !stateRef.current.micOn;
    dispatch({ type: ACT.SET_FLAG, key: 'micOn', value: next });
    sendCmd({ cmd: CMD.TOGGLE_MIC, on: next });
  }, [sendCmd]);

  const toggleCamera = useCallback(() => {
    const next = !stateRef.current.cameraOn;
    dispatch({ type: ACT.SET_FLAG, key: 'cameraOn', value: next });
    sendCmd({ cmd: CMD.TOGGLE_CAMERA, on: next });
  }, [sendCmd]);

  const switchCamera = useCallback(() => {
    sendCmd({ cmd: CMD.SWITCH_CAMERA });
  }, [sendCmd]);

  const toggleSpeaker = useCallback(() => {
    const next = !stateRef.current.speakerOn;
    if (__DEV__) console.log('[CALL][APP] toggleSpeaker →', next ? 'LOUDSPEAKER' : 'earpiece');
    // Always flip the button state immediately so it's a reliable toggle.
    dispatch({ type: ACT.SET_FLAG, key: 'speakerOn', value: next });
    if (Platform.OS === 'android') {
      // Real OS-level routing; do NOT send CMD.SET_SPEAKER (its setSinkId can
      // report "unsupported" and wrongly disable the button).
      applyAudioRoute(next);
    } else {
      // iOS/desktop: best-effort via the engine's setSinkId.
      sendCmd({ cmd: CMD.SET_SPEAKER, on: next });
    }
  }, [sendCmd, applyAudioRoute]);

  const resumeAudio = useCallback(() => {
    dispatch({ type: ACT.NEEDS_UNMUTE, value: false });
    sendCmd({ cmd: CMD.RESUME_AUDIO });
  }, [sendCmd]);

  // ---- minimize / maximize (WhatsApp-style floating call window) ----
  // Shrink the call to a draggable floating window so the rest of the app stays
  // usable; the call (audio + video media) keeps running because the engine
  // WebView and CallProvider live at the app root, independent of navigation.
  const minimize = useCallback(() => {
    dispatch({ type: ACT.SET_FLAG, key: 'minimized', value: true });
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
  const onSignalIncoming = useCallback((payload) => {
    const snap = stateRef.current;
    const callerId = payload?.from?.id ? String(payload.from.id) : null;
    if (__DEV__) console.log('\n[CALL][APP] ═════ INCOMING STEP 0 call:incoming signal (app socket) ═════', { callerId, currentStatus: snap.status, payload });
    if (!callerId) return;
    if (snap.status === CALL_STATUS.INCOMING) {
      // Already ringing (e.g. WebRTC arrived first) → just record the signal id.
      if (!snap.signalId && payload?.callId) dispatch({ type: ACT.SET_SIGNAL, signalId: payload.callId });
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
    });
    startRinging('incoming');
    armRingTimeout();
    ensureConnected(); // wake the WebRTC engine so its `incoming` can land
    nativeCall.displayIncomingCall(
      payload?.callId, callerId,
      isGroup ? (payload?.groupName || 'Group call') : peer.name,
      (payload?.media || 'audio') === 'video',
    );
  }, [myId, startRinging, armRingTimeout, ensureConnected]);

  // Match an inbound lifecycle signal to the current call (by signalId if known).
  const matchesCurrent = (payload) => {
    const snap = stateRef.current;
    if (snap.status === CALL_STATUS.IDLE) return false;
    if (snap.signalId && payload?.callId && String(snap.signalId) !== String(payload.callId)) return false;
    return true;
  };
  const onSignalCancelled = useCallback((payload) => {
    if (!matchesCurrent(payload)) return;
    finalizeEnd(stateRef.current.direction === 'incoming' ? 'missed' : 'cancelled');
  }, [finalizeEnd]);
  const onSignalRejected = useCallback((payload) => {
    if (!matchesCurrent(payload)) return;
    finalizeEnd('rejected');
  }, [finalizeEnd]);
  const onSignalEnded = useCallback((payload) => {
    if (!matchesCurrent(payload)) return;
    finalizeEnd('completed');
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
    };
    let unsub = () => {};
    let wasConnected = false;
    const unsubState = subscribeSocketState((s) => {
      const connected = !!s.connected;
      if (connected && !wasConnected) {
        unsub();
        unsub = registerCallSignalListeners(handlers);
      }
      wasConnected = connected;
    });
    return () => { unsub(); unsubState(); };
  }, [isAuthenticated, onSignalIncoming, onSignalCancelled, onSignalAccepted, onSignalRejected, onSignalEnded]);

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
    onSignalIncoming(mapPushToIncoming(data));
  }, [onSignalIncoming, mapPushToIncoming]);

  // Accept tapped on the notification (or a plain tap): make sure the ringing
  // state exists (cold start from a killed app), then answer once it commits.
  const onPushAccept = useCallback((data) => {
    if (!data?.callerId) return;
    onSignalIncoming(mapPushToIncoming(data));
    pushAcceptPendingRef.current = true;
  }, [onSignalIncoming, mapPushToIncoming]);

  // Decline from the notification: reject if we're ringing, else tell the caller
  // over the app socket directly (best-effort — needs the socket connected).
  const onPushReject = useCallback((data) => {
    const snap = stateRef.current;
    if (snap.status === CALL_STATUS.INCOMING) { reject(); return; }
    rejectCallSignal({ callId: data?.callId || null, callerId: data?.callerId || null });
  }, [reject]);

  useEffect(() => {
    if (!isAuthenticated) return undefined;
    const subs = [
      DeviceEventEmitter.addListener(CALL_PUSH_EVENTS.INCOMING, onPushIncoming),
      DeviceEventEmitter.addListener(CALL_PUSH_EVENTS.ACCEPT, onPushAccept),
      DeviceEventEmitter.addListener(CALL_PUSH_EVENTS.REJECT, onPushReject),
    ];
    return () => subs.forEach((s) => { try { s.remove(); } catch (_) {} });
  }, [isAuthenticated, onPushIncoming, onPushAccept, onPushReject]);

  // Fire the deferred Accept (from a call-push Accept tap) the moment the ringing
  // state is committed — accept() itself no-ops unless status is INCOMING.
  useEffect(() => {
    if (pushAcceptPendingRef.current && state.status === CALL_STATUS.INCOMING && !state.accepted) {
      pushAcceptPendingRef.current = false;
      accept();
    }
  }, [state.status, state.accepted, accept]);

  // Keep the latest action handles available to the native OS-call listeners.
  actionsRef.current = { accept, reject, hangup, toggleMic };

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
    }
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      clearRingTimeout();
    };
  }, [isAuthenticated, clearRingTimeout, stopRinging]);

  // Native call UI (CallKit / ConnectionService) — inert no-op unless
  // react-native-callkeep is installed and the app rebuilt. Maps OS actions
  // (answer/end/mute from the lock screen) onto our call actions.
  useEffect(() => {
    if (!isAuthenticated || !nativeCall.isAvailable()) return undefined;
    nativeCall.setup();
    const unsub = nativeCall.registerEvents({
      onAnswer: () => { actionsRef.current.accept && actionsRef.current.accept(); },
      onEnd: () => {
        const snap = stateRef.current;
        if (snap.status === CALL_STATUS.INCOMING) actionsRef.current.reject && actionsRef.current.reject();
        else actionsRef.current.hangup && actionsRef.current.hangup();
      },
      onToggleMute: (callId, muted) => {
        const snap = stateRef.current;
        // Sync our mic flag with the OS toggle if they diverge.
        if (snap.micOn === muted) actionsRef.current.toggleMic && actionsRef.current.toggleMic();
      },
    });
    return unsub;
  }, [isAuthenticated]);

  const value = {
    call: state,
    engineReady,
    isExpoGo: IS_EXPO_GO,
    presenceMap,
    audioRouteSupported,
    maxParticipants: MAX_PARTICIPANTS,
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
    toggleSpeaker,
    resumeAudio,
    minimize,
    maximize,
    expandIncoming,
    queryPresence,
  };

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
          <CallEngineWebView
            ref={webRef}
            onEvent={onEngineEvent}
            style={styles.engineFill}
          />
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
      <IncomingCallBanner />
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
