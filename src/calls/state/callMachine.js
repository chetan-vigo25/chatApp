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

// Including yourself. The mediasoup SFU calling server scales a group call to
// 32 participants (matches backend content CALL_MAX_GROUP_PARTICIPANTS).
export const MAX_PARTICIPANTS = 32;

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
  // The user swiped the in-app call banner away. UI-ONLY and deliberately
  // short-lived: the call stays exactly as it was (still ringing, still
  // answerable) and the flag is cleared the next time the app comes to the
  // foreground, so the banner comes back — WhatsApp-style. Part of
  // initialCallState, so a new call always starts with a visible banner.
  bannerDismissed: false,
  peer: null,            // { id, name, avatar } — 1:1 other party / group fallback
  peers: [],             // [{ id, name, avatar }] — full invited list
  participants: {},      // { [id]: { id, name, avatar, joined } }
  // Who the SFU currently hears talking ({ peerId } relayed by the media server),
  // or null in silence. Drives the speaking highlight on a group participant tile.
  activeSpeakerId: null,
  isGroup: false,
  // Multi-party CONFERENCE (converted from 1:1 / invited into one). Renders
  // with "Conference call" labels everywhere; the backend roster is the truth.
  isConference: false,
  hostId: null,          // current conference host (migrates when host leaves)
  groupId: null,         // app-side group/thread id when the call originates from a group
  groupName: null,
  media: 'audio',        // 'audio' | 'video'
  direction: null,       // 'incoming' | 'outgoing'
  chatId: null,
  // control flags
  micOn: true,
  cameraOn: true,        // only meaningful for video
  screenSharing: false,  // this side is sharing its screen (video calls)
  speakerOn: false,
  facingMode: 'user',
  // WhatsApp-style minimize: the call shrinks to a draggable floating window
  // (video PiP / audio pill) so the rest of the app stays usable; tap to restore.
  minimized: false,
  // lifecycle
  accepted: false,       // callee tapped Accept; waiting for media to connect
  remoteJoined: false,
  // Mid-call media-layer drop (network blip): the peer connection reported
  // disconnect/ICE-failed. The overlay shows "Reconnecting…" while true; a
  // watchdog ends the call if it doesn't recover. Cleared on media recovery.
  reconnecting: false,
  needsUnmuteGesture: false,
  endReason: null,       // 'completed'|'rejected'|'cancelled'|'missed'|'failed'
  startedAt: null,
  answeredAt: null,
  // First moment REAL remote media arrived (REMOTE_JOINED/PARTICIPANT_JOINED).
  // The call timer counts from HERE, not from answeredAt — the accepted→media
  // gap (ICE/DTLS, 1-8s on weak networks) must not be billed as talk time.
  connectedAt: null,
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
  PARTICIPANT_INVITED: 'PARTICIPANT_INVITED',
  PARTICIPANT_LEFT: 'PARTICIPANT_LEFT',
  PARTICIPANT_REMOVED: 'PARTICIPANT_REMOVED',
  ACTIVE_SPEAKER: 'ACTIVE_SPEAKER',
  // Server-authoritative conference roster sync (call:conference:roster) —
  // merges statuses/media flags into `participants`, sets host + flags.
  CONFERENCE_SYNC: 'CONFERENCE_SYNC',
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

/**
 * A GROUP call and a CONFERENCE are the same multi-party call.
 *
 * `isConference` used to gate every host / roster / conference-signaling
 * feature, which left a plain group call (one that never had anyone added
 * mid-call) with no host, no authoritative roster, no kick, and no per-member
 * mute state — the backend broadcasts all of it for group rings too. Every one
 * of those gates now asks THIS question instead, so the two behave identically.
 *
 * The `isConference` flag itself is still meaningful, but only for WORDING
 * ("Conference call" vs "3 in call") — never for capability.
 */
export const isMultiParty = (s) => !!(s && (s.isConference || s.isGroup));

// Count peers who currently have media flowing (joined).
export const joinedCount = (participants = {}) =>
  Object.values(participants).filter((p) => p && p.joined).length;

// True when the WhatsApp-style top call BAR should be up (and the app content
// below it pushed down). Two cases: a MINIMIZED live call, and a RINGING call
// that has no full-screen UI of its own. Kept here so the overlay and the
// content-inset wrapper stay in exact agreement — they must never disagree, or
// the bar covers a screen header (or reserves space with nothing in it).
export const isMiniBannerActive = (s) => {
  if (!s || s.status === CALL_STATUS.IDLE) return false;
  // A MINIMIZED live call → the top bar. (A minimized video call uses the
  // floating draggable PiP instead, except for its brief "Call ended" flash.)
  if (s.minimized) return s.media !== 'video' || s.status === CALL_STATUS.ENDED;
  // A RINGING incoming call with no full-screen UI up. Such a call is presented
  // ONLY by the OS — the Android CallStyle notification or the iOS CallKit
  // banner — and the user can swipe that away (or it can time out on its own)
  // while the call is still ringing. Without an in-app fallback the call then
  // becomes completely invisible inside the app: it is still live, still
  // ringing the caller, and there is no way to reach it. This strip is that
  // fallback, and it is what makes an active call always discoverable in-app.
  if (s.status === CALL_STATUS.INCOMING && !s.accepted && !s.incomingExpanded) return !s.bannerDismissed;
  return false;
};

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
        // The dialer hosts the call. The backend is still authoritative (it can
        // migrate the host when someone leaves, via call:conference:host) but
        // host-only affordances must work from the first second of the call,
        // long before any roster broadcast could arrive.
        hostId: isGroup && action.selfId ? String(action.selfId) : null,
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
        notificationOnly, isConference, hostId,
      } = action;
      // Same-caller duplicate while ALREADY ringing = the sibling of the ring we
      // staged (app-socket signal and engine 'incoming' land within ms of each
      // other; the provider's stateRef can lag the first dispatch and stage
      // instead of reconciling). MERGE the ids instead of dropping the action —
      // dropping lost the engine callId, which left accept stuck on
      // pendingAccept forever ("Connecting…" until the caller gave up).
      if (state.status === CALL_STATUS.INCOMING
          && !isGroup && !state.isGroup
          && action.peer && state.peer
          && String(action.peer.id) === String(state.peer.id)) {
        const mergedCallId = state.callId || action.callId || null;
        return {
          ...state,
          callId: mergedCallId,
          signalId: state.signalId || action.signalId || null,
          awaitingEngine: mergedCallId ? false : state.awaitingEngine,
        };
      }
      // Same for a GROUP / CONFERENCE ring. The merge above is 1:1-only because it
      // matches on the peer, and on a conference the two planes disagree about who
      // "from" is: the app socket names whoever INVITED us, the media server names
      // the host. So the sibling ring fell through to the busy-guard below and was
      // dropped WHOLESALE — taking the engine callId with it, which is the one
      // thing accept() needs. The result was an invitee parked on pendingAccept
      // until the media-ring watchdog killed the call. Match on the ids that a
      // conference actually keeps stable (groupId / signalId / callId) instead.
      if (state.status === CALL_STATUS.INCOMING && (isGroup || state.isGroup)) {
        const same = (a, b) => !!a && !!b && String(a) === String(b);
        // The peer fallback is gated on `!state.callId`: it exists purely to
        // recover the engine id we don't have yet, so it can never hijack a ring
        // that is already fully identified.
        if (same(groupId, state.groupId) || same(signalId, state.signalId)
          || same(callId, state.callId)
          || (!state.callId && action.peer && state.peer && same(action.peer.id, state.peer.id))) {
          const mergedCallId = state.callId || callId || null;
          return {
            ...state,
            callId: mergedCallId,
            signalId: state.signalId || signalId || null,
            groupId: state.groupId || groupId || null,
            groupName: state.groupName || groupName || null,
            isGroup: true,
            isConference: state.isConference || !!isConference,
            hostId: state.hostId || (hostId ? String(hostId) : null),
            awaitingEngine: mergedCallId ? false : state.awaitingEngine,
          };
        }
      }
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
        isGroup: group || !!isConference,
        isConference: !!isConference,
        // Server-named host wins; otherwise the caller is the host, which is
        // true for every group ring and lets the callee's UI reason about who
        // owns the call before the first roster broadcast.
        hostId: hostId ? String(hostId)
          : ((group || !!isConference) && (peer?.id || list[0]?.id)
            ? String(peer?.id || list[0].id) : null),
        groupId: groupId || null,
        groupName: groupName || null,
        media,
        chatId: chatId || null,
        // Conference: WhatsApp-style camera default OFF on join — the user
        // opts in with the video toggle. 1:1 video keeps the legacy default.
        cameraOn: isConference ? false : media === 'video',
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
        connectedAt: state.connectedAt || action.nowMs || null,
      };
    }
    case ACT.PARTICIPANT_JOINED: {
      if (state.status === CALL_STATUS.ENDED || state.status === CALL_STATUS.IDLE) return state;
      const id = action.id ? String(action.id) : null;
      if (!id) return state;
      const existing = state.participants[id] || {};
      // A member can join AFTER the ring sweep removed their roster entry —
      // recover name/avatar from the invited list so they don't show "Unknown".
      const invited = (state.peers || []).find((p) => p && String(p.id) === id) || {};
      return {
        ...state,
        status: CALL_STATUS.ACTIVE,
        remoteJoined: true,
        answeredAt: state.answeredAt || action.nowMs || null,
        connectedAt: state.connectedAt || action.nowMs || null,
        participants: {
          ...state.participants,
          [id]: {
            id,
            name: existing.name || invited.name || action.name || 'Unknown',
            mobile: existing.mobile || invited.mobile || null,
            avatar: existing.avatar || invited.avatar || action.avatar || null,
            joined: true,
          },
        },
      };
    }
    case ACT.PARTICIPANT_INVITED: {
      // Mid-call "Add participant": put the invitee on the roster (joined:false
      // → the grid shows them ringing) — PARTICIPANT_JOINED flips them live
      // when their media arrives.
      const p = action.peer;
      if (!p || !p.id) return state;
      const id = String(p.id);
      if (state.participants[id]) return state;
      const invitedName = p.name || p.mobile || p.phone || 'Member';
      const invitedMobile = p.mobile || p.phone || null;
      return {
        ...state,
        peers: [...state.peers, { id, name: invitedName, mobile: invitedMobile, avatar: p.avatar || null }],
        participants: {
          ...state.participants,
          [id]: { id, name: invitedName, mobile: invitedMobile, avatar: p.avatar || null, joined: false, confStatus: 'RINGING' },
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
    case ACT.PARTICIPANT_REMOVED: {
      // Drop a member from the LIVE roster entirely — declined / never answered
      // (ring window over) / left. `peers` (the invited list) is kept intact for
      // the call log. The grid simply stops showing them.
      const id = action.id ? String(action.id) : null;
      if (!id || !state.participants[id]) return state;
      const next = { ...state.participants };
      delete next[id];
      return { ...state, participants: next };
    }
    case ACT.CONFERENCE_SYNC: {
      // Merge the backend roster into `participants` WITHOUT losing names/
      // avatars we already resolved locally. Terminal members (declined/missed/
      // left…) are dropped from the grid; RINGING/INVITED render as connecting.
      const roster = action.roster || {};
      const list = Array.isArray(roster.participants) ? roster.participants : [];
      const selfId = action.selfId ? String(action.selfId) : null;
      const next = {};
      list.forEach((rp) => {
        const id = String(rp.userId);
        if (selfId && id === selfId) return; // grid shows self separately
        const live = rp.status === 'CONNECTED' || rp.status === 'RINGING' || rp.status === 'INVITED';
        if (!live) return;
        const prev = state.participants[id] || {};
        // Roster now carries identity (fullName/mobileNumber/avatar). A locally
        // resolved REAL name wins; the 'Member' placeholder never sticks when
        // the roster can do better. `mobile` is kept so the UI can apply the
        // "saved contact → name, unsaved → number" rule via the contact directory.
        const prevRealName = prev.name && prev.name !== 'Member' && prev.name !== 'Unknown' ? prev.name : null;
        next[id] = {
          id,
          name: prevRealName || rp.fullName || rp.mobileNumber
            || (action.names && action.names[id]) || prev.name || 'Member',
          mobile: rp.mobileNumber || prev.mobile || null,
          avatar: prev.avatar || rp.avatar || null,
          joined: rp.status === 'CONNECTED',
          confStatus: rp.status,
          audioEnabled: rp.audioEnabled !== false,
          videoEnabled: !!rp.videoEnabled,
        };
      });
      return {
        ...state,
        // `isConference` is now WORDING ONLY (isMultiParty drives capability),
        // so a roster broadcast must not rename a group call into a "conference".
        // A call that was already multi-party keeps its identity; only a 1:1 that
        // an invite promoted becomes a conference here.
        isConference: state.isConference || !state.isGroup,
        isGroup: true, // conference reuses the multi-party grid/controls
        // Server-named host wins; otherwise keep whoever we already believe hosts
        // the call (the dialer / the caller — see START_OUTGOING and INCOMING).
        hostId: roster.hostId ? String(roster.hostId) : state.hostId,
        participants: next,
      };
    }
    case ACT.ACTIVE_SPEAKER: {
      // Ignore once the call is over — a late relay must not resurrect a highlight.
      if (state.status === CALL_STATUS.ENDED || state.status === CALL_STATUS.IDLE) return state;
      const id = action.id ? String(action.id) : null;
      if (id === state.activeSpeakerId) return state; // no-op re-render guard
      return { ...state, activeSpeakerId: id };
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
