/**
 * Pure call-state reducer. Supports a single active call at a time, which may be
 * 1:1 OR a small group (up to MAX_PARTICIPANTS including self).
 *
 * status:  idle → outgoing → active → ended → idle
 *          idle → incoming → active → ended → idle
 *
 * 1:1 vs group:
 *   - `peer`          : the other party for a 1:1 call (kept for back-compat; for
 *                       a group it is the first invitee, used only as a fallback
 *                       label).
 *   - `peers`         : the full invited list [{ id, name, avatar }] (length 1 for 1:1).
 *   - `participants`  : { [id]: { id, name, avatar, joined } } — live roster; a
 *                       peer flips `joined:true` when their media stream arrives
 *                       and is removed (or joined:false) when they leave.
 *   - `isGroup`       : peers.length > 1 (or an incoming call flagged as group).
 */

export const CALL_STATUS = {
  IDLE: 'idle',
  OUTGOING: 'outgoing',
  INCOMING: 'incoming',
  ACTIVE: 'active',
  ENDED: 'ended',
};

// Including yourself. The hosted service caps a call at 4 tiles; 1 is local.
export const MAX_PARTICIPANTS = 4;

export const initialCallState = {
  status: CALL_STATUS.IDLE,
  callId: null,          // the calling-service (WebRTC) call id — needed to accept
  signalId: null,        // the app-socket signaling id (busy lock / call:* events)
  awaitingEngine: false, // incoming shown from the socket signal; WebRTC id pending
  pendingAccept: false,  // user tapped Accept before the WebRTC id arrived
  // WhatsApp-style incoming UI: a call first rings as a compact top heads-up
  // banner (incomingExpanded:false) while the user keeps using the app; tapping
  // it expands to the full-screen ring screen (incomingExpanded:true). Reset to
  // false on every new INCOMING since that action spreads initialCallState.
  incomingExpanded: false,
  // Foreground incoming calls are presented ONLY via the OS push notification
  // (CallStyle Accept/Decline), NOT the in-app banner/ring screen. We still enter
  // INCOMING state so the lifecycle works (notification Accept/Decline answer or
  // reject; cancel/timeout dismiss it) — this flag just hides the in-app ring UI.
  notificationOnly: false,
  peer: null,            // { id, name, avatar } — 1:1 other party / group fallback
  peers: [],             // [{ id, name, avatar }] — full invited list
  participants: {},      // { [id]: { id, name, avatar, joined } }
  isGroup: false,
  groupId: null,         // app-side group/thread id when the call originates from a group
  groupName: null,
  media: 'audio',        // 'audio' | 'video'
  direction: null,       // 'incoming' | 'outgoing'
  chatId: null,
  // control flags
  micOn: true,
  cameraOn: true,        // only meaningful for video
  speakerOn: false,
  facingMode: 'user',
  // WhatsApp-style minimize: the call shrinks to a draggable floating window
  // (video PiP / audio pill) so the rest of the app stays usable; tap to restore.
  minimized: false,
  // lifecycle
  accepted: false,       // callee tapped Accept; waiting for media to connect
  remoteJoined: false,
  needsUnmuteGesture: false,
  endReason: null,       // 'completed'|'rejected'|'cancelled'|'missed'|'failed'
  startedAt: null,
  answeredAt: null,
  endedAt: null,
  errorMessage: null,
};

export const ACT = {
  START_OUTGOING: 'START_OUTGOING',
  OUTGOING_CONFIRMED: 'OUTGOING_CONFIRMED',
  INCOMING: 'INCOMING',
  RECONCILE_CALLID: 'RECONCILE_CALLID',
  SET_SIGNAL: 'SET_SIGNAL',
  ACCEPT: 'ACCEPT',
  REMOTE_JOINED: 'REMOTE_JOINED',
  PARTICIPANT_JOINED: 'PARTICIPANT_JOINED',
  PARTICIPANT_LEFT: 'PARTICIPANT_LEFT',
  SET_FLAG: 'SET_FLAG',
  CAMERA_CHANGED: 'CAMERA_CHANGED',
  NEEDS_UNMUTE: 'NEEDS_UNMUTE',
  ENDED: 'ENDED',
  RESET: 'RESET',
};

// Build the initial participant roster from an invited list (all joined:false).
const rosterFrom = (peers = []) => {
  const map = {};
  peers.forEach((p) => {
    if (!p || !p.id) return;
    map[String(p.id)] = {
      id: String(p.id),
      name: p.name || 'Unknown',
      avatar: p.avatar || null,
      joined: false,
    };
  });
  return map;
};

// Count peers who currently have media flowing (joined).
export const joinedCount = (participants = {}) =>
  Object.values(participants).filter((p) => p && p.joined).length;

// True when the minimized call should show the WhatsApp-style top BANNER (and
// the app content below it should be pushed down). That's a minimized AUDIO call
// (a minimized video call uses the floating draggable PiP instead, which floats
// over the app and needs no content push), plus the brief "Call ended" flash of
// a minimized video call once its video stage is gone. Kept here so the overlay
// and the content-inset wrapper stay in exact agreement.
export const isMiniBannerActive = (s) => (
  !!s
  && s.minimized
  && s.status !== CALL_STATUS.IDLE
  && (s.media !== 'video' || s.status === CALL_STATUS.ENDED)
);

export function callReducer(state, action) {
  switch (action.type) {
    case ACT.START_OUTGOING: {
      const {
        peers, media, chatId, groupId, groupName, nowMs,
      } = action;
      const list = (peers || []).filter((p) => p && p.id);
      const isGroup = list.length > 1;
      return {
        ...initialCallState,
        status: CALL_STATUS.OUTGOING,
        direction: 'outgoing',
        signalId: action.signalId || null,
        peer: list[0] || null,
        peers: list,
        participants: rosterFrom(list),
        isGroup,
        groupId: groupId || null,
        groupName: groupName || null,
        media,
        chatId: chatId || null,
        cameraOn: media === 'video',
        // Video and group calls default to the loudspeaker (hands-free); a 1:1
        // voice call starts on the earpiece like a normal phone call.
        speakerOn: media === 'video' || isGroup,
        startedAt: nowMs || null,
      };
    }
    case ACT.OUTGOING_CONFIRMED: {
      if (state.status !== CALL_STATUS.OUTGOING) return state;
      return { ...state, callId: action.callId || state.callId };
    }
    case ACT.INCOMING: {
      const {
        callId, signalId, awaitingEngine, peer, peers, media, chatId, isGroup, groupId, groupName, nowMs,
        notificationOnly,
      } = action;
      // Ignore a second incoming while busy.
      if (state.status !== CALL_STATUS.IDLE && state.status !== CALL_STATUS.ENDED) return state;
      const list = (peers && peers.length ? peers : (peer ? [peer] : [])).filter((p) => p && p.id);
      const group = !!isGroup || list.length > 1;
      return {
        ...initialCallState,
        status: CALL_STATUS.INCOMING,
        direction: 'incoming',
        callId: callId || null,
        signalId: signalId || null,
        awaitingEngine: !!awaitingEngine,
        peer: peer || list[0] || null,
        peers: list,
        participants: rosterFrom(list),
        isGroup: group,
        groupId: groupId || null,
        groupName: groupName || null,
        media,
        chatId: chatId || null,
        cameraOn: media === 'video',
        speakerOn: media === 'video' || group,
        startedAt: nowMs || null,
        notificationOnly: !!notificationOnly,
      };
    }
    case ACT.RECONCILE_CALLID: {
      // The calling-service (WebRTC) `incoming` arrived after a socket-signaled
      // incoming — record the real callId so accept() can complete.
      if (state.status === CALL_STATUS.IDLE) return state;
      return {
        ...state,
        callId: action.callId || state.callId,
        awaitingEngine: false,
        // carry any peer detail the WebRTC event resolved (name/avatar)
        peer: action.peer ? { ...state.peer, ...action.peer } : state.peer,
      };
    }
    case ACT.SET_SIGNAL: {
      return { ...state, signalId: action.signalId || state.signalId };
    }
    case ACT.ACCEPT: {
      if (state.status !== CALL_STATUS.INCOMING) return state;
      // Stay INCOMING (remote media hasn't arrived) but flag accepted so the UI
      // swaps the Accept/Decline card for a connected screen immediately. Stamp
      // answeredAt now so the call timer starts ticking the moment the user
      // accepts (the ACTIVE transition preserves it via `state.answeredAt ||`).
      return { ...state, accepted: true, answeredAt: state.answeredAt || action.nowMs || null };
    }
    case ACT.REMOTE_JOINED: {
      // 1:1 fast-path (single remote). Keeps the original behavior intact.
      if (state.status === CALL_STATUS.ENDED || state.status === CALL_STATUS.IDLE) return state;
      return {
        ...state,
        status: CALL_STATUS.ACTIVE,
        remoteJoined: true,
        answeredAt: state.answeredAt || action.nowMs || null,
      };
    }
    case ACT.PARTICIPANT_JOINED: {
      if (state.status === CALL_STATUS.ENDED || state.status === CALL_STATUS.IDLE) return state;
      const id = action.id ? String(action.id) : null;
      if (!id) return state;
      const existing = state.participants[id] || {};
      return {
        ...state,
        status: CALL_STATUS.ACTIVE,
        remoteJoined: true,
        answeredAt: state.answeredAt || action.nowMs || null,
        participants: {
          ...state.participants,
          [id]: {
            id,
            name: existing.name || action.name || 'Unknown',
            avatar: existing.avatar || action.avatar || null,
            joined: true,
          },
        },
      };
    }
    case ACT.PARTICIPANT_LEFT: {
      const id = action.id ? String(action.id) : null;
      if (!id || !state.participants[id]) return state;
      const next = { ...state.participants };
      // Keep the roster entry but flag it left so the UI can show "left".
      next[id] = { ...next[id], joined: false, left: true };
      return { ...state, participants: next };
    }
    case ACT.SET_FLAG: {
      return { ...state, [action.key]: action.value };
    }
    case ACT.CAMERA_CHANGED: {
      return { ...state, facingMode: action.facingMode || state.facingMode };
    }
    case ACT.NEEDS_UNMUTE: {
      return { ...state, needsUnmuteGesture: !!action.value };
    }
    case ACT.ENDED: {
      if (state.status === CALL_STATUS.IDLE) return state;
      return {
        ...state,
        status: CALL_STATUS.ENDED,
        endReason: action.reason || 'completed',
        endedAt: action.nowMs || null,
        errorMessage: action.message || null,
      };
    }
    case ACT.RESET:
      return { ...initialCallState };
    default:
      return state;
  }
}

// Derive the outcome to persist from the terminal state.
export function deriveOutcome(state, reason) {
  const wasActive = !!state.answeredAt;
  if (reason === 'rejected') return 'rejected';
  if (reason === 'cancelled') return 'cancelled';
  if (reason === 'failed') return 'failed';
  if (reason === 'missed') return 'missed';
  // 'completed'/'ended'/'peerleft'
  if (wasActive) return 'completed';
  // ended before answer: caller = cancelled, callee = missed
  return state.direction === 'outgoing' ? 'cancelled' : 'missed';
}
