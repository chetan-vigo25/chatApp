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
  QUERY_PRESENCE: 'queryPresence',
  RESUME_AUDIO: 'resumeAudio',
  SET_SPEAKER: 'setSpeaker',
  START_RECORDING: 'startRecording',
  STOP_RECORDING: 'stopRecording',
  // Ask the SDK to restart ICE (renegotiate transport) after a network change —
  // e.g. wifi↔cellular — so a live call recovers its media path instead of hanging.
  RESTART_ICE: 'restartIce',
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
  ERROR: 'error',
  // mid-call media-layer connection state (network resilience)
  MEDIA_DOWN: 'mediaDown',
  MEDIA_UP: 'mediaUp',
  // command results
  START_CALL_RESULT: 'startCallResult',
  START_CALL_ERROR: 'startCallError',
  PRESENCE_RESULT: 'presenceResult',
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
