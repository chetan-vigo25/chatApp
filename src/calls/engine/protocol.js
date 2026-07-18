/**
 * Message protocol between React Native (CallProvider) and the WebView call
 * engine that hosts the browser CallingSDK.
 *
 *  RN  → Engine : webRef.injectJavaScript(`window.__cmd(${JSON.stringify(JSON.stringify(msg))});true;`)
 *  Engine → RN  : window.ReactNativeWebView.postMessage(JSON.stringify({ type, payload }))
 *
 * Keeping the names in one place so the HTML glue and the RN side never drift.
 */

// RN → Engine commands
export const CMD = {
  CONNECT: 'connect',
  START_CALL: 'startCall',
  ACCEPT: 'accept',
  REJECT: 'reject',
  HANGUP: 'hangup',
  TOGGLE_MIC: 'toggleMic',
  TOGGLE_CAMERA: 'toggleCamera',
  SWITCH_CAMERA: 'switchCamera',
  // Screen share (getDisplayMedia → SFU producer {source:'screen'}). Supported
  // where the WebView/browser exposes getDisplayMedia; the engine reports an
  // `unsupported` screenShareError otherwise.
  TOGGLE_SCREEN: 'toggleScreen',
  // Mid-call group invite: ring more members into the LIVE group call (they get
  // a normal incoming-call request and join on accept).
  INVITE_TO_GROUP: 'inviteToGroup',
  // Stop re-inviting ONE member (they declined over the app socket / their ring
  // window closed) — the engine's re-invite loop must not re-ring them.
  STOP_INVITE: 'stopInvite',
  QUERY_PRESENCE: 'queryPresence',
  RESUME_AUDIO: 'resumeAudio',
  // iOS CallKit answered → the OS re-activated the process audio session UNDER
  // WebKit, silently killing the WebView's WebRTC audio units in BOTH directions
  // while every track still reads 'live'. Force-rebuild the pipeline: fresh mic
  // getUserMedia + replaceTrack on the producer, and re-attach every remote
  // stream so playback restarts under the new session.
  RESTART_AUDIO: 'restartAudio',
  SET_SPEAKER: 'setSpeaker',
  START_RECORDING: 'startRecording',
  STOP_RECORDING: 'stopRecording',
  // 1:1 peer identity for in-stage placeholders ({ peerId, name, avatar }) —
  // the WebView engine draws the peer's circular avatar over their tile while
  // their camera is off (peervideo). The native engine renders tiles in RN
  // (props on NativeVideoStage) and ignores this.
  PEER_META: 'peerMeta',
  // Ask the SDK to restart ICE (renegotiate transport) after a network change —
  // e.g. wifi↔cellular — so a live call recovers its media path instead of hanging.
  RESTART_ICE: 'restartIce',
  // Liveness probe: is the SDK instance alive and its socket connected? Used by
  // ensureConnected to catch a reloaded WebView page / dropped engine socket
  // BEFORE dialing (a stale "ready" otherwise fails the call with 'not connected').
  PING: 'ping',
};

// Engine → RN events (SDK passthroughs + engine/control results)
export const EVT = {
  // engine lifecycle
  ENGINE_READY: 'engineReady',
  CONNECT_ERROR: 'connectError',
  LOG: 'log',
  // SDK passthroughs
  LOCALSTREAM: 'localstream',
  STREAM: 'stream',
  INCOMING: 'incoming',
  PEERLEFT: 'peerleft',
  ENDED: 'ended',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  PRESENCE: 'presence',
  CAMERACHANGED: 'camerachanged',
  PEERFACING: 'peerfacing',
  // Peer paused/resumed their camera producer mid-call (camera off/on without
  // closing it) — { peerId, on }. The UI swaps the frozen tile for the avatar.
  PEER_VIDEO: 'peervideo',
  // SFU active-speaker relay — { peerId } of whoever is currently talking (null
  // when nobody is). Both engines already emit it; the group UI highlights the tile.
  ACTIVE_SPEAKER: 'activeSpeaker',
  ERROR: 'error',
  // mid-call media-layer connection state (network resilience)
  MEDIA_DOWN: 'mediaDown',
  MEDIA_UP: 'mediaUp',
  // command results
  START_CALL_RESULT: 'startCallResult',
  START_CALL_ERROR: 'startCallError',
  PRESENCE_RESULT: 'presenceResult',
  PONG: 'pong',
  SCREEN_SHARE_STARTED: 'screenShareStarted',
  SCREEN_SHARE_STOPPED: 'screenShareStopped',
  SCREEN_SHARE_ERROR: 'screenShareError',
  SPEAKER_RESULT: 'speakerResult',
  NEEDS_UNMUTE_GESTURE: 'needsUnmuteGesture',
  CMD_ERROR: 'cmdError',
  // on-device recording (admin "Listen Live")
  RECORDING_CHUNK: 'recordingChunk',
  RECORDING_STARTED: 'recordingStarted',
  RECORDING_STOPPED: 'recordingStopped',
  RECORDING_ERROR: 'recordingError',
};

// Serialize a command for injection into the WebView.
export const buildCmdInjection = (msg) => {
  const json = JSON.stringify(JSON.stringify(msg));
  return `window.__cmd(${json});true;`;
};

// Parse an event coming up from the WebView. Returns { type, payload } or null.
export const parseEngineEvent = (raw) => {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj.type === 'string') return { type: obj.type, payload: obj.payload || {} };
    return null;
  } catch (_) {
    return null;
  }
};
