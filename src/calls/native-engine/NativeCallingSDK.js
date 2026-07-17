import { io } from 'socket.io-client';
import { Device } from 'mediasoup-client';
import { getWebrtc } from './webrtcGlobals';

/**
 * NATIVE port of the WebView engine's CallingSDK (callEngineHtml.js) — the
 * mediasoup SFU client for 1:1 + group calls, running on react-native-webrtc
 * instead of a browser. METHOD-FOR-METHOD parity with the field-proven
 * reference: same socket contract, same state fields, same event names/payload
 * shapes, same redial / re-invite / resume semantics. Server-side NOTHING
 * changes (docs/native-call-migration/PHASE_2_ARCHITECTURE.md).
 *
 * Deliberate differences from the WebView reference (all iOS-reliability wins):
 *  - getUserMedia is react-native-webrtc's — capture is legal in background
 *    under a CallKit call, so the 3×retry + empty-stream fallback machinery and
 *    the restartAudio/ensureLocalAudio watchdogs are NOT ported (the
 *    AVAudioSession conflict they patched around does not exist natively).
 *  - No <video>/<audio> elements: remote audio plays through the native WebRTC
 *    audio unit automatically; video surfaces publish via streamRegistry.
 *  - Speaker routing lives in AudioRoute (InCallManager), not setSinkId.
 *  - Screen share is not offered (parity with mobile WebView: unsupported).
 *
 * Events emitted (same as reference): incoming, localstream, stream,
 * streamremoved, peerleft, ended, rejected, cancelled, camerachanged,
 * mediaupgraded, mediaupgradefailed, activespeaker, disconnected, connected,
 * error, users.
 */
const RETRY_MS = 2500;
const RETRY_WINDOW_MS = 40000;
const REASSERT_MS = 5000; // min gap between ring reasserts after a successful dial

const CAM_ENCODINGS = [
  { scaleResolutionDownBy: 4, maxBitrate: 150000 },
  { scaleResolutionDownBy: 2, maxBitrate: 500000 },
  { scaleResolutionDownBy: 1, maxBitrate: 1200000 },
];

// Legacy token = base64(JSON { sub, name }); JWT mode carries identity in
// explicit opts instead. Same fallback semantics as the reference.
const decodeToken = (token) => {
  try {
    const raw = global.atob
      ? global.atob(String(token || ''))
      : Buffer.from(String(token || ''), 'base64').toString('binary');
    const json = decodeURIComponent(Array.prototype.map.call(raw, (c) => (
      `%${(`00${c.charCodeAt(0).toString(16)}`).slice(-2)}`
    )).join(''));
    const obj = JSON.parse(json);
    if (obj && obj.sub) return { userId: String(obj.sub), name: obj.name || 'User' };
  } catch (_) { /* not a base64 envelope (JWT mode) */ }
  return null;
};

export default class NativeCallingSDK {
  constructor(opts = {}) {
    this.url = String(opts.url || '').replace(/\/+$/, '');
    const id = decodeToken(opts.token);
    this.userId = String(opts.userId || (id && id.userId) || '');
    this.name = String(opts.name || (id && id.name) || 'User');
    // Forward ONLY a real JWT on joinRoom (the server verifies any provided
    // token; the legacy base64 envelope would fail verification).
    this._token = (typeof opts.token === 'string' && opts.token.split('.').length === 3)
      ? opts.token : '';
    this._fallbackIceServers = (Array.isArray(opts.iceServers) && opts.iceServers.length)
      ? opts.iceServers : null;
    this._onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};

    this._handlers = {};
    this._socket = null;
    this._serverUrl = '';
    this._registered = false;
    this._device = null;
    this._sendTransport = null;
    this._recvTransport = null;
    this._localStream = null;
    this._screenStream = null;  // getDisplayMedia stream while sharing
    this._producers = {};       // 'mic' | 'camera' | 'screen' -> Producer
    this._consumers = {};       // consumerId -> Consumer
    this._consumed = {};        // producerId -> true
    this._peerStreams = {};     // streamKey (peerId | peerId#screen) -> MediaStream
    this._pendingIn = {};       // callId | groupId -> incoming info
    this._declined = {};        // groupId -> declined-at ms
    this._out = null;           // outgoing 1:1 { callId, roomId, to } (LATEST dial)
    this._dialTarget = null;    // 1:1 callee id for the current dial (redial/reassert/grace-sweep recovery)
    this._outIds = {};          // EVERY callId minted for the current dial (redials + ring reasserts)
    this._lastDialAt = 0;       // rate-limits the ring-reassert loop
    this._declinedPeer = {};    // 1:1 peerId -> declined-at ms (swallow ring reasserts after decline)
    this._acceptedFrom = null;  // 1:1 peerId whose call we accepted (dedupe post-accept reasserts)
    this._acceptedId = null;    // 1:1 callId accepted; waiting for callAccepted
    this._room = null;          // { roomId, groupId, callId, media, joined }
    this._pendingProducers = [];
    this._pendingStreamEmits = []; // 'stream' payloads held until recv ICE/DTLS is up
    this._media = 'audio';
    this._facing = 'user';
    this._users = [];
    this._retryTimer = null;
    this._retryUntil = 0;
    this._mediaDown = false;
    this._groupInvitees = [];
    this._groupJoined = {};
  }

  on(ev, cb) { (this._handlers[ev] = this._handlers[ev] || []).push(cb); return this; }

  _emit(ev, data) {
    (this._handlers[ev] || []).forEach((cb) => { try { cb(data); } catch (_) {} });
  }

  _log(msg) { this._onLog(`[sdk] ${msg}`); }

  _req(event, data) {
    return new Promise((resolve, reject) => {
      if (!this._socket || !this._socket.connected) { reject(new Error(`${event}: not connected`)); return; }
      const t = setTimeout(() => reject(new Error(`${event} timeout`)), 10000);
      this._socket.emit(event, data || {}, (res) => {
        clearTimeout(t);
        if (res && res.error) reject(new Error(res.error)); else resolve(res || {});
      });
    });
  }

  _waitSocket(ms) {
    if (this._socket && this._socket.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = this._socket;
      if (!s) { reject(new Error('not connected')); return; }
      let t = null;
      const onC = () => { cleanup(); resolve(); };
      const cleanup = () => { clearTimeout(t); try { s.off('connect', onC); } catch (_) {} };
      t = setTimeout(() => { cleanup(); reject(new Error('not connected')); }, ms || 6000);
      s.on('connect', onC);
    });
  }

  _reqDial(event, data) {
    // 12s: a CallKit/killed-app answer boots the engine COLD — socket connect
    // + register can exceed the old 6s on a weak network, and the timeout
    // rejected acceptCall with 'not connected' → the just-answered call was
    // torn down ("pick karte hi cut"). The ring window (30s+) bounds this.
    return this._waitSocket(12000).then(() => this._req(event, data));
  }

  // ---- connection ----
  connect() {
    if (!this.userId) return Promise.reject(new Error('missing user identity'));
    return new Promise((resolve, reject) => {
      let settled = false;
      this._connectTo(this.url, (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve();
      });
    });
  }

  _connectTo(url, done) {
    if (this._socket) { try { this._socket.removeAllListeners(); this._socket.disconnect(); } catch (_) {} }
    const s = io(url, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 4000,
      timeout: 8000,
    });
    this._socket = s;
    this._serverUrl = url;
    s.on('connect', () => {
      this._req('register', { name: this.name, sessionId: this.userId }).then((res) => {
        this._users = (res && res.users) || [];
        this._registered = true;
        this._log(`registered on ${url} as ${this.userId}`);
        if (done) { const d = done; done = null; d(null); }
        // Socket came back while in a call → resume the room media.
        if (this._room) this._resume();
      }).catch((err) => {
        this._log(`register failed: ${err && err.message}`);
        if (done) { const d = done; done = null; d(err || new Error('register failed')); }
      });
    });
    s.on('connect_error', (err) => {
      if (done) { const d = done; done = null; d(err || new Error('connect failed')); }
    });
    s.on('disconnect', (reason) => {
      this._log(`socket disconnected: ${reason}`);
      if (this._room && this._room.joined) this._emitDown(`signal:${reason}`);
    });
    this._wire(s);
  }

  // Round-trip liveness probe for the CONNECT-reuse path. A backgrounded app's
  // socket can be HALF-OPEN: `connected` still reads true client-side while the
  // TCP path is dead — reusing it would strand the next dial/accept until the
  // 10s request timeout. `register` doubles as the probe: it is idempotent
  // server-side and re-asserts the lobby registration (clearing any pending
  // disconnect-grace timer for this session) — so a successful probe also
  // REFRESHES our registration. Resolves true/false, never rejects.
  verifyAlive(ms) {
    return new Promise((resolve) => {
      const s = this._socket;
      if (!s || !s.connected) { resolve(false); return; }
      const t = setTimeout(() => resolve(false), ms || 2500);
      try {
        s.emit('register', { name: this.name, sessionId: this.userId }, (res) => {
          clearTimeout(t);
          if (res && res.users) this._users = res.users;
          resolve(!(res && res.error));
        });
      } catch (_) {
        clearTimeout(t);
        resolve(false);
      }
    });
  }

  // Cluster room-affinity: move the socket to the server that owns the room.
  _migrate(url) {
    this._log(`migrating to room server ${url}`);
    return new Promise((resolve, reject) => {
      this._connectTo(url, (err) => { if (err) reject(err); else resolve(); });
    });
  }

  _wire(s) {
    s.on('users', (users) => { this._users = users || []; });

    s.on('incomingCall', (p = {}) => {
      const key = String(p.callId);
      if (this._pendingIn[key]) return;
      const fromId = p.from && p.from.id != null ? String(p.from.id) : null;
      if (fromId) {
        // Ring-REASSERT dedupe: the caller re-emits callUser every few seconds
        // (each mints a NEW callId on the server) so the ring reaches us even
        // when the first one hit our dead grace-period socket. A second ring
        // from the SAME peer while we already ring/answer them is the SAME
        // logical call — swallow it silently. It must never reach the app
        // layer: the provider would auto-reject it as "busy", the caller would
        // read that declineCall as a rejection and kill the live dial.
        const dupRinging = Object.keys(this._pendingIn).some((k) => {
          const q = this._pendingIn[k];
          return q && !q.group && q.from && String(q.from.id) === fromId;
        });
        const dupActive = this._acceptedFrom === fromId && (this._acceptedId || this._room);
        if (dupRinging || dupActive) { this._log(`duplicate 1:1 ring from ${fromId} (${key}) — swallowed`); return; }
        // Just declined this peer → quietly decline their reasserts too instead
        // of ghost-re-ringing (parity with the group _declined window).
        const dec = this._declinedPeer[fromId];
        if (dec && (Date.now() - dec) < 15000) {
          try { s.emit('declineCall', { callId: key }); } catch (_) {}
          return;
        }
        delete this._declinedPeer[fromId];
      }
      this._pendingIn[key] = { group: false, callId: key, from: p.from || {}, media: p.callType === 'video' ? 'video' : 'audio' };
      this._emit('incoming', {
        callId: key,
        from: { id: p.from && p.from.id != null ? String(p.from.id) : null, name: (p.from && p.from.name) || '' },
        media: p.callType === 'video' ? 'video' : 'audio',
        isGroup: false, groupId: null, groupName: null, members: [],
      });
    });

    s.on('incomingGroupCall', (p = {}) => {
      const key = String(p.groupId);
      // Already IN this group call → this is the host's re-invite loop echoing
      // (their engine hadn't marked us joined yet). Surfacing it would make the
      // app busy-reject OUR OWN call (declineGroupCall while connected).
      if (this._room && this._room.groupId === key) {
        this._log(`re-invite for group ${key} swallowed (already in the call)`);
        return;
      }
      if (this._pendingIn[key]) return;
      if (this._declined[key] && (Date.now() - this._declined[key]) < 15000) {
        try { s.emit('declineGroupCall', { groupId: p.groupId }); } catch (_) {}
        return;
      }
      delete this._declined[key];
      this._pendingIn[key] = { group: true, groupId: p.groupId, roomId: p.roomId, from: p.from || {}, media: p.callType === 'video' ? 'video' : 'audio', name: p.name };
      this._emit('incoming', {
        callId: key,
        from: { id: p.from && p.from.id != null ? String(p.from.id) : null, name: (p.from && p.from.name) || '' },
        media: p.callType === 'video' ? 'video' : 'audio',
        isGroup: true, groupId: key, groupName: p.name || null, members: [],
      });
    });

    // Both sides of a 1:1 get this once the callee accepts → join the room.
    s.on('callAccepted', (p = {}) => {
      const cid = p.callId != null ? String(p.callId) : '';
      // Match ANY callId minted for this dial — the callee may have accepted an
      // EARLIER redial/reassert id than the latest one in _out; matching only
      // _out.callId dropped the accept on the floor (caller kept ringing while
      // the callee sat alone in the room until the watchdog cut the call).
      const mine = !!this._outIds[cid] || (this._out && this._out.callId === cid) || this._acceptedId === cid;
      if (!mine) return;
      // NEVER cancelCall the sibling reassert ids here: the server relays every
      // cancel to the callee as callCancelled, and a WEBVIEW-engine callee
      // (Android / older bundle) still holds those siblings in pendingIn — its
      // SDK would emit 'cancelled' and the app layer would KILL the call that
      // was just accepted (accept → instant disconnect on both sides). Stale
      // ids die on their own: the callee's hangup declines what it stored, and
      // we ignore late declines once the room is up.
      this._out = null;
      this._outIds = {};
      this._acceptedId = null;
      this._clearRetry();
      this._media = p.callType === 'video' ? 'video' : 'audio';
      // Caller pre-joined this room during the ring → the media pipeline is
      // already up (or building). Promote it: bind the callId, un-pause the
      // producers (privacy hold ends at accept). The callee consumes our
      // existing producer the moment they join — no caller-side work left.
      const pre = this._room && this._room.preAnswer;
      if (pre && String(this._room.roomId) === String(p.roomId)
        && (!p.serverUrl || p.serverUrl === this._serverUrl)) {
        this._room.callId = String(p.callId);
        this._room.media = this._media;
        this._room.preAnswer = false;
        ['mic', 'camera'].forEach((k) => {
          const pr = this._producers[k];
          if (pr && !pr.closed) {
            try { pr.resume(); } catch (_) {}
            this._req('resumeProducer', { producerId: pr.id }).catch(() => {});
          }
        });
        this._log('accepted — pre-joined room promoted (media already warm)');
        return;
      }
      if (pre) {
        // Pre-joined a STALE room (redial re-minted / cluster moved the room) —
        // drop the warm-up and join the real one from scratch.
        this._teardownMedia(true);
      }
      this._room = { roomId: p.roomId, groupId: null, callId: String(p.callId), media: this._media, joined: false };
      this._startMedia(p.serverUrl).catch((e) => {
        this._log(`media start failed: ${e && e.message}`);
        this._emit('error', { message: 'Could not connect the call media' });
      });
    });

    s.on('callDeclined', (p) => {
      const cid = p && p.callId != null ? String(p.callId) : '';
      // A PRE-ANSWER room is only the ring-time warm-up — a decline must still
      // end the dial (and tear the warm-up down); only a LIVE room shields
      // against stale sibling-id declines.
      if (this._room && !this._room.preAnswer) return;
      if ((this._out && this._out.callId === cid) || this._outIds[cid]) {
        // No sibling cancelCall here either (see callAccepted) — a WebView
        // callee holding a sibling in pendingIn would surface 'cancelled'.
        this._out = null;
        this._outIds = {};
        this._clearRetry();
        if (this._room && this._room.preAnswer) this._teardownMedia(true);
        this._emit('rejected', {});
      }
    });
    s.on('callCancelled', (p) => {
      const key = p && p.callId != null ? String(p.callId) : null;
      if (key && this._pendingIn[key]) { delete this._pendingIn[key]; this._emit('cancelled', {}); }
    });
    s.on('callEnded', (p) => {
      // callEnded on an UN-ANSWERED outgoing dial is not a user action — it's
      // the server's disconnect-grace sweep deleting the callee's stale
      // registration ALONG WITH our pending call (killed app whose old socket
      // expired mid-ring). Ending here cut the caller the moment (or seconds
      // before) the callee answered on CallKit. Drop the dead id and keep
      // re-dialing — the fresh registration the callee is booting right now
      // will receive the next ring; the signaling ring window bounds the loop.
      if ((!this._room || this._room.preAnswer) && !this._acceptedId && this._out && this._dialTarget) {
        const deadId = p && p.callId != null ? String(p.callId) : this._out.callId;
        delete this._outIds[deadId];
        this._out = null;
        this._lastDialAt = 0; // let the next tick redial immediately
        this._log(`SFU call leg ${deadId} ended pre-answer (grace sweep) — re-arming dial loop`);
        // The pre-joined warm-up room (if any) stays up; the tick re-points it
        // when the redial mints a different roomId.
        this._armRetry(() => this._dial1to1Tick(this._dialTarget));
        return;
      }
      // SCOPE the end to the CURRENT call. The lobby's disconnect grace sweep
      // ends every stale 1:1 record a dead session left behind (dev reloads /
      // crashes) — an UNSCOPED handler let one of those stale callEnded events
      // tear down a live call. Seen in the field: a member joins a GROUP call
      // and a stale 1:1 callEnded kills their leg seconds later ("3rd person
      // accepts → their call ends"). Only OUR ids may end us.
      const cid = p && p.callId != null ? String(p.callId) : null;
      const mine = !!cid && (
        (this._room && this._room.callId === cid)
        || this._acceptedId === cid
        || !!this._outIds[cid]
        || (this._out && this._out.callId === cid)
      );
      if (!mine) { this._log(`callEnded ${cid || '?'} ignored (not current call)`); return; }
      this._onRemoteEnded();
    });
    s.on('groupCallEnded', (p) => {
      const gid = p && p.groupId != null ? String(p.groupId) : null;
      // A ring we haven't answered → treat as cancelled, not an end.
      if (gid && this._pendingIn[gid]) { delete this._pendingIn[gid]; this._emit('cancelled', {}); return; }
      // Same scoping rule as callEnded: only the group we're actually IN.
      if (!this._room || !this._room.groupId || (gid && this._room.groupId !== gid)) {
        this._log(`groupCallEnded ${gid || '?'} ignored (not current call)`);
        return;
      }
      this._onRemoteEnded();
    });
    s.on('groupDeclined', (p) => {
      const uid = p && p.userId != null ? String(p.userId) : null;
      if (uid) this._groupJoined[uid] = true; // stop re-inviting them
      this._log(`group invite declined by ${uid}`);
    });
    s.on('groupParticipantJoined', (p) => {
      const u = p && p.user;
      if (u && u.id != null) this._groupJoined[String(u.id)] = true;
    });
    s.on('callPromotedToGroup', (p) => {
      if (this._room) {
        this._room.groupId = p && p.groupId != null ? String(p.groupId) : this._room.groupId;
        this._room.callId = null;
      }
    });

    s.on('newProducer', (p) => {
      if (this._room && this._room.joined) {
        this._consume(p).catch((e) => {
          // A transient failure here silently loses the peer's track for the
          // whole call (their VIDEO tile never appears / one-way audio) — retry
          // once before giving up.
          this._log(`consume error: ${e && e.message} — retrying once`);
          setTimeout(() => {
            if (this._room && this._room.joined) {
              this._consume(p).catch((e2) => this._log(`consume retry failed: ${e2 && e2.message}`));
            }
          }, 1200);
        });
      } else if (this._room) {
        // Peer produced while WE are still building transports — queue it, the
        // join drains the queue (dropping = connected-but-SILENT call).
        this._log(`newProducer queued (join in progress) from ${p && p.peerId}`);
        this._pendingProducers.push(p);
      }
    });
    s.on('peerLeft', (p) => {
      const pid = p && p.peerId != null ? String(p.peerId) : null;
      // STALE-ROOM POISON GUARD. The server never unsubscribes a socket from a
      // finished call's socket.io room, and it broadcasts `peerLeft` into OLD
      // rooms (stale-session cleanup on a fresh joinRoom, and the disconnect
      // grace sweep). Repeated calls between the same two users (dev reloads,
      // crashes) therefore delivered a previous call's peerLeft DURING the next
      // call's accept — the app read it as "caller left" and cut the call the
      // moment it was answered. A peerLeft can only be meaningful when we have
      // a live/pending room, and never for OUR OWN peer id (that's the echo of
      // our own stale peer being cleaned out of an old room).
      if (!pid || pid === this.userId) return;
      if (!this._room) { this._log(`peerLeft ${pid} ignored (no room — stale)`); return; }
      // Room-scoped filter: the server now stamps peerLeft with its roomId. A
      // stale room's event between the SAME two users carries the SAME peerId
      // as the live call's peer — only the roomId can tell them apart. (Absent
      // roomId = older server → fall through to the guards above.)
      const evRoom = p && p.roomId != null ? String(p.roomId) : null;
      if (evRoom && String(this._room.roomId) !== evRoom) {
        this._log(`peerLeft ${pid} ignored (room ${evRoom} ≠ current ${this._room.roomId})`);
        return;
      }
      this._dropPeer(pid);
      this._emit('peerleft', { id: pid });
    });
    s.on('producerClosed', (p) => {
      const pid = p && p.producerId;
      if (!pid) return;
      delete this._consumed[pid];
      Object.keys(this._consumers).forEach((cid) => {
        const c = this._consumers[cid];
        if (c && c.producerId === pid) {
          const peerId = (c.appData && c.appData.peerId) || (p.peerId != null ? String(p.peerId) : null);
          const streamKey = (c.appData && c.appData.streamKey) || peerId;
          const stream = streamKey ? this._peerStreams[streamKey] : null;
          if (stream) { try { stream.removeTrack(c.track); } catch (_) {} }
          try { c.close(); } catch (_) {}
          delete this._consumers[cid];
          if (streamKey && streamKey.indexOf('#screen') >= 0) {
            delete this._peerStreams[streamKey];
            this._emit('streamremoved', { peerId, source: 'screen' });
          } else if (streamKey) {
            // Camera/mic producer closed (peer turned their camera off or
            // re-produces after a rejoin) — tell the UI layer to re-read the
            // stream's tracks so a dead video tile doesn't stay up frozen.
            this._emit('streamchanged', { peerId, streamKey });
          }
        }
      });
    });
    s.on('consumerClosed', (p) => {
      const cid = p && p.consumerId;
      const c = cid ? this._consumers[cid] : null;
      if (c) {
        delete this._consumed[c.producerId];
        try { c.close(); } catch (_) {}
        delete this._consumers[cid];
      }
    });
    s.on('activeSpeaker', (p) => {
      this._emit('activespeaker', { peerId: p && p.peerId != null ? String(p.peerId) : null });
    });
  }

  _onRemoteEnded() {
    if (!this._room && !this._acceptedId && !this._out) return;
    this._clearRetry();
    this._acceptedId = null;
    this._acceptedFrom = null;
    this._out = null;
    this._outIds = {};
    this._dialTarget = null;
    // leaveRoom even on a REMOTE end — a stale membership makes the NEXT
    // call's joinRoom fail with "already in a room".
    this._teardownMedia(true);
    this._emit('ended', {});
  }

  // ---- outgoing ----
  startCall(to, media) {
    const targets = (Array.isArray(to) ? to : [to]).map(String).filter(Boolean);
    this._media = media === 'video' ? 'video' : 'audio';
    if (!targets.length) return Promise.reject(new Error('no callee'));
    this._outIds = {};        // fresh dial — never inherit a previous dial's ids
    this._acceptedFrom = null;
    return this._capture().then(() => {
      if (targets.length > 1) return this._startGroup(targets);
      return this._start1to1(targets[0]);
    });
  }

  _start1to1(target) {
    this._dialTarget = target;
    return this._reqDial('callUser', { toUserId: target, callType: this._media }).then((res) => {
      const cid = String(res.callId);
      this._out = { callId: cid, roomId: res.roomId, to: target };
      this._outIds[cid] = true;
      this._lastDialAt = Date.now();
      // Ring REASSERT: a "successful" callUser is NOT proof the callee heard it —
      // during the server's reconnect grace a killed app's stale registration
      // accepts the call and incomingCall goes to a DEAD socket. Keep re-dialing
      // (the server reuses the same callId/roomId for a live dial; the callee's
      // SDK swallows duplicates) until callAccepted / callDeclined / hangup /
      // the ring window ends. This is the fix for "callee accepts on CallKit
      // but the call cuts — their engine never received the SFU ring".
      this._armRetry(() => this._dial1to1Tick(target));
      // Warm the media path WHILE the callee's phone rings: join the room,
      // build both transports and produce the mic PAUSED (no audio leaves this
      // device until the accept). On accept the callee finds our producer in
      // existingProducers and consumes instantly — the whole caller-side join +
      // send handshake is off the post-accept critical path.
      this._preJoinOut(res.roomId);
      return { callId: cid, offline: [] };
    }).catch((e) => {
      const msg = String((e && e.message) || '').toLowerCase();
      if (msg.indexOf('offline') >= 0 || msg.indexOf('not found') >= 0) {
        // Callee not registered on the media server yet — the app-socket ring +
        // push wake them; keep REDIALING so the WebRTC leg exists the moment
        // their engine registers. Ring window / RN hangup bounds the loop.
        this._log('callee offline on media server — arming redial loop');
        this._armRetry(() => this._dial1to1Tick(target));
        return { callId: null, offline: [target] };
      }
      if (msg.indexOf('busy') >= 0) return { callId: null, offline: [] };
      throw e;
    });
  }

  // One retry-loop tick for a 1:1 dial. Two jobs, same mechanics:
  //  - REDIAL: callee was offline on the media server → first successful
  //    callUser puts the ring up the moment their engine registers.
  //  - REASSERT: after a success, re-ring every REASSERT_MS in case the last
  //    incomingCall landed on a dead grace-period socket (fresh callId each
  //    time; the callee dedupes by peer). callAccepted/callDeclined/hangup
  //    clear the loop; _retryUntil (ring window) bounds it.
  _dial1to1Tick(target) {
    // A PRE-ANSWER room is the ring-time warm-up, not a live call — the loop
    // must keep re-asserting through it.
    if ((this._room && !this._room.preAnswer) || this._acceptedId) return Promise.resolve(true);
    if (this._out && (Date.now() - this._lastDialAt) < REASSERT_MS) return Promise.resolve(false);
    return this._req('callUser', { toUserId: target, callType: this._media }).then((res) => {
      // The call may have been ANSWERED while this request was in flight —
      // never resurrect dial state over a live call (the id becomes harmless
      // server-side garbage; the callee dedupes/declines it).
      if ((this._room && !this._room.preAnswer) || this._acceptedId) return true;
      // HUNG UP while this dial was in flight (instant cancel): hangup() had no
      // minted id to cancel yet, so without this the freshly created lobby
      // record lived on — the callee rang a DEAD call for the whole window and
      // the record was re-delivered if they reconnected within it ("A ne turant
      // kaata phir bhi B par ring aati rahi"). Cancel it NOW and stop. A new
      // dial to the SAME target falls through safely (the lobby REASSERT-reuses
      // this very record for it).
      if (!this._dialTarget || String(this._dialTarget) !== String(target)) {
        this._log('dial cancelled while in flight — cancelling minted id ' + String(res.callId));
        try { this._socket && this._socket.emit('cancelCall', { callId: String(res.callId) }); } catch (_) {}
        return true;
      }
      const cid = String(res.callId);
      const isReassert = !!this._out;
      this._out = { callId: cid, roomId: res.roomId, to: target };
      this._outIds[cid] = true;
      this._lastDialAt = Date.now();
      this._log(`${isReassert ? 'ring reassert' : 'redial'} ok — callId ${cid}`);
      // Keep the warm-up aligned with the dial: first success pre-joins; a NEW
      // roomId (the grace sweep deleted the old record and this redial minted a
      // fresh call) re-points the warm-up at the room the callee will accept.
      if (!this._room) this._preJoinOut(res.roomId);
      else if (this._room.preAnswer && String(this._room.roomId) !== String(res.roomId)) {
        this._teardownMedia(true);
        this._preJoinOut(res.roomId);
      }
      return false; // keep looping until answered/declined/window end
    }).catch(() => false);
  }

  // Ring-time warm-up for an outgoing 1:1: join the room + build transports +
  // produce the mic PAUSED while the callee is still ringing. Privacy: nothing
  // is audible until callAccepted resumes the producer. Failure is non-fatal —
  // the accept path simply joins from scratch as before.
  _preJoinOut(roomId) {
    if (!roomId || this._room || this._acceptedId) return;
    const room = {
      roomId: String(roomId), groupId: null, callId: null, media: this._media, joined: false, preAnswer: true,
    };
    this._room = room;
    this._log(`pre-joining room ${roomId} during ring (caller warm-up)`);
    this._startMedia(null).catch((e) => {
      this._log(`pre-join failed (${e && e.message})`);
      if (this._room !== room) return; // superseded by a re-pre-join / teardown
      if (room.preAnswer) {
        // Still ringing — drop the half-built pipeline; accept joins fresh.
        this._teardownMedia(true);
      } else if (!room.joined) {
        // Promoted (accepted) while this join was failing — rebuild for real.
        this._teardownMedia(true);
        this._room = { roomId: room.roomId, groupId: null, callId: room.callId, media: this._media, joined: false };
        this._startMedia(null).catch((e2) => {
          this._log(`media start failed: ${e2 && e2.message}`);
          this._emit('error', { message: 'Could not connect the call media' });
        });
      }
    });
  }

  _startGroup(targets) {
    return this._reqDial('startGroupCall', { callType: this._media, inviteeIds: targets }).then((res) => {
      const gid = String(res.groupId);
      this._room = { roomId: res.roomId, groupId: gid, callId: null, media: this._media, joined: false };
      this._groupInvitees = targets.slice();
      this._groupJoined = {};
      // Re-invite members whose engine registers late (push-woken app).
      this._armRetry(() => this._reinviteGroup(gid));
      this._startMedia(res.serverUrl).catch((e) => {
        this._log(`group media start failed: ${e && e.message}`);
        this._emit('error', { message: 'Could not connect the call media' });
      });
      return { callId: gid, offline: [] };
    });
  }

  _reinviteGroup(gid) {
    if (!this._room || this._room.groupId !== gid) return Promise.resolve(true);
    const missing = (this._groupInvitees || []).filter((id) => !this._groupJoined[id]);
    if (!missing.length) return Promise.resolve(true);
    return this._req('inviteToGroupCall', { groupId: gid, inviteeIds: missing })
      .then(() => false)
      .catch(() => false);
  }

  _armRetry(fn) {
    this._clearRetry();
    this._retryUntil = Date.now() + RETRY_WINDOW_MS;
    this._retryTimer = setInterval(() => {
      if (Date.now() > this._retryUntil) { this._clearRetry(); return; }
      Promise.resolve().then(fn).then((done) => { if (done) this._clearRetry(); }).catch(() => {});
    }, RETRY_MS);
  }

  _clearRetry() {
    if (this._retryTimer) { clearInterval(this._retryTimer); this._retryTimer = null; }
  }

  inviteToGroup(ids) {
    const list = (ids || []).map(String).filter(Boolean);
    if (!list.length) return Promise.resolve();
    if (!this._room || !this._room.groupId) return Promise.reject(new Error('not in a group call'));
    const gid = this._room.groupId;
    list.forEach((id) => {
      if (this._groupInvitees.indexOf(id) < 0) this._groupInvitees.push(id);
      delete this._groupJoined[id]; // re-invite even someone who declined earlier
    });
    this._armRetry(() => this._reinviteGroup(gid));
    this._log(`inviting ${list.length} more member(s) into group ${gid}`);
    return this._req('inviteToGroupCall', { groupId: gid, inviteeIds: list });
  }

  stopInviting(id) {
    if (id != null) this._groupJoined[String(id)] = true;
  }

  // acceptCall with bounded retries. The user's ANSWER must not die with one
  // lost frame on a flapping socket (field repro: engine registered + got the
  // ring, but the single-shot acceptCall never reached the lobby → both sides
  // stuck "Connecting…" until the watchdog). acceptCall is idempotent
  // server-side; retries stop the moment the call is answered (callAccepted
  // set _room) or torn down.
  _acceptWithRetry(callId) {
    const attempt = (n) => this._reqDial('acceptCall', { callId }).catch((e) => {
      if (n >= 2) throw e;
      if (!this._acceptedId || this._room) throw e; // ended, or already answered meanwhile
      this._log(`acceptCall attempt ${n + 1} failed (${e && e.message}) — retrying`);
      return new Promise((r) => setTimeout(r, 1500 * (n + 1))).then(() => {
        if (!this._acceptedId || this._room) return {}; // resolved while we waited
        return attempt(n + 1);
      });
    });
    return attempt(0);
  }

  // ---- incoming ----
  accept(callId, media, opts = {}) {
    const key = String(callId);
    const p = this._pendingIn[key];
    if (!p) {
      // No pending entry. A KNOWN 1:1 (the app layer reconciled the real SFU
      // callId but this SDK instance lost/never had the ring — engine reconnect
      // mid-ring) is accepted DIRECTLY: acceptCall only needs the callId.
      // Previously this fell into joinGroupCall with a 1:1 id → server error →
      // the call cut the instant the user accepted.
      if (opts.isGroup === false) {
        this._log(`accept: no pending entry for 1:1 ${key} — accepting directly`);
        this._media = media === 'video' ? 'video' : 'audio';
        this._acceptedFrom = opts.peerId != null ? String(opts.peerId) : null;
        this._acceptedId = key;
        // Capture runs CONCURRENTLY with acceptCall — getUserMedia (slow on a
        // cold mic) used to sit between the user's tap and the caller even
        // LEARNING the call was answered. _capture is memoized, so the join
        // pipeline reuses this same attempt.
        return Promise.all([
          this._capture(),
          this._acceptWithRetry(key),
        ]).then(([, ack]) => ack);
      }
      // Group ids are joinable directly.
      this._log(`accept: no pending entry for ${key} — trying joinGroupCall directly`);
      delete this._declined[key];
      this._media = media === 'video' ? 'video' : this._media;
      this._capture().catch(() => {}); // kick off; _startMedia awaits the memoized attempt
      return this._reqDial('joinGroupCall', { groupId: key }).then((res) => {
        this._media = res.callType === 'video' ? 'video' : this._media;
        this._room = { roomId: res.roomId, groupId: key, callId: null, media: this._media, joined: false };
        this._groupInvitees = [];
        this._groupJoined = {};
        return this._startMedia(res.serverUrl);
      });
    }
    this._media = p.media === 'video' ? 'video' : 'audio';
    delete this._pendingIn[key];
    if (p.group) {
      this._capture().catch(() => {}); // concurrent with the join round trip
      return this._reqDial('joinGroupCall', { groupId: p.groupId }).then((res) => {
        this._media = res.callType === 'video' ? 'video' : this._media;
        this._room = { roomId: res.roomId, groupId: String(p.groupId), callId: null, media: this._media, joined: false };
        this._groupInvitees = [];
        this._groupJoined = {};
        return this._startMedia(res.serverUrl);
      });
    }
    // 1:1 — the server answers with callAccepted (both sides), which carries
    // roomId + serverUrl; media starts in that handler.
    this._acceptedFrom = p.from && p.from.id != null ? String(p.from.id) : (opts.peerId != null ? String(opts.peerId) : null);
    // Drop sibling reassert entries from the same caller quietly (same
    // logical call, different minted ids) — a later hangup must not decline
    // them, which the caller would read as a rejection.
    if (this._acceptedFrom) {
      Object.keys(this._pendingIn).forEach((k) => {
        const q = this._pendingIn[k];
        if (q && !q.group && q.from && String(q.from.id) === this._acceptedFrom) delete this._pendingIn[k];
      });
    }
    this._acceptedId = key;
    // acceptCall goes out IMMEDIATELY; capture (the slow part) overlaps it.
    return Promise.all([
      this._capture(),
      this._acceptWithRetry(key),
    ]).then(([, ack]) => ack);
  }

  reject(callId) {
    const key = String(callId);
    const p = this._pendingIn[key];
    delete this._pendingIn[key];
    // Remember the declined peer so their ring reasserts (fresh callIds every
    // few seconds) are quietly declined instead of ghost-re-ringing.
    if (p && !p.group && p.from && p.from.id != null) this._declinedPeer[String(p.from.id)] = Date.now();
    try {
      if (p && p.group) { this._declined[key] = Date.now(); this._socket && this._socket.emit('declineGroupCall', { groupId: p.groupId }); }
      else this._socket && this._socket.emit('declineCall', { callId: key });
    } catch (_) {}
  }

  // ---- teardown ----
  hangup() {
    this._clearRetry();
    Object.keys(this._pendingIn).forEach((key) => {
      const p = this._pendingIn[key];
      try {
        if (p.group) { this._declined[key] = Date.now(); this._socket && this._socket.emit('declineGroupCall', { groupId: p.groupId }); }
        else this._socket && this._socket.emit('declineCall', { callId: key });
      } catch (_) {}
    });
    this._pendingIn = {};
    try {
      if (this._room && this._room.groupId) this._socket && this._socket.emit('leaveGroupCall', { groupId: this._room.groupId });
      else if (this._room && this._room.callId) this._socket && this._socket.emit('endCall', { callId: this._room.callId });
      else if (this._acceptedId) {
        this._socket && this._socket.emit('endCall', { callId: this._acceptedId });
        // Hangup in the answered-but-not-joined window: the caller's dial loop
        // may re-ring on the pre-answer callEnded — quietly decline those
        // reasserts instead of ghost-re-ringing.
        if (this._acceptedFrom) this._declinedPeer[this._acceptedFrom] = Date.now();
      }
      else {
        // Cancel EVERY id minted for this dial (redials + reasserts), not just
        // the latest — stale server entries otherwise ring/linger.
        const ids = Object.keys(this._outIds);
        if (this._out && ids.indexOf(this._out.callId) < 0) ids.push(this._out.callId);
        ids.forEach((cid) => { try { this._socket && this._socket.emit('cancelCall', { callId: cid }); } catch (_) {} });
      }
    } catch (_) {}
    this._acceptedId = null;
    this._acceptedFrom = null;
    this._out = null;
    this._outIds = {};
    this._dialTarget = null;
    this._teardownMedia(true);
  }

  disconnect() {
    this._clearRetry();
    this._acceptedId = null;
    this._acceptedFrom = null;
    this._out = null;
    this._outIds = {};
    this._dialTarget = null;
    this._teardownMedia(false);
    if (this._socket) { try { this._socket.removeAllListeners(); this._socket.disconnect(); } catch (_) {} }
    this._socket = null;
    this._registered = false;
  }

  _teardownMedia(leaveRoom) {
    this._clearRecovery();
    // Invalidate any in-flight getUserMedia so its late stream can't become a
    // leaked _localStream after this teardown.
    this._capGen = (this._capGen || 0) + 1;
    this._capturing = null;
    this._producingLocal = false;
    // leaveRoom whenever a room EXISTS, not only when `joined` flipped — a
    // teardown racing an in-flight joinRoom otherwise leaves a ghost peer in
    // the room server-side (socket.io orders the frames, so the server sees
    // join → leave cleanly; leaveRoom on a never-joined socket is a no-op).
    try { if (leaveRoom && this._socket && this._room) this._socket.emit('leaveRoom'); } catch (_) {}
    Object.keys(this._producers).forEach((k) => { try { this._producers[k].close(); } catch (_) {} });
    this._producers = {};
    Object.keys(this._consumers).forEach((k) => { try { this._consumers[k].close(); } catch (_) {} });
    this._consumers = {};
    this._consumed = {};
    this._peerStreams = {};
    try { this._sendTransport && this._sendTransport.close(); } catch (_) {}
    try { this._recvTransport && this._recvTransport.close(); } catch (_) {}
    this._sendTransport = null;
    this._recvTransport = null;
    this._device = null;
    if (this._localStream) { try { this._localStream.getTracks().forEach((t) => t.stop()); } catch (_) {} }
    this._localStream = null;
    if (this._screenStream) { try { this._screenStream.getTracks().forEach((t) => t.stop()); } catch (_) {} }
    this._screenStream = null;
    this._room = null;
    this._pendingProducers = [];
    this._pendingStreamEmits = [];
    this._mediaDown = false;
    this._groupInvitees = [];
    this._groupJoined = {};
  }

  // ---- local media ----
  _capture() {
    if (this._localStream) return Promise.resolve(this._localStream);
    // In-flight memo: accept()/startMedia run capture CONCURRENTLY with
    // signalling, so a second caller shares the same getUserMedia attempt
    // (two parallel captures = two mic handles, one leaked).
    if (this._capturing) return this._capturing;
    // Generation guard: a hangup during a slow capture must not let the late
    // stream resurrect itself as _localStream (leaked mic after teardown).
    const gen = this._capGen || 0;
    const webrtc = getWebrtc();
    if (!webrtc) return Promise.reject(new Error('react-native-webrtc unavailable'));
    const { mediaDevices } = webrtc;
    const wantVideo = this._media === 'video';
    const constraints = wantVideo
      ? { audio: true, video: { facingMode: this._facing, width: 1280, height: 720, frameRate: 30 } }
      : { audio: true, video: false };
    let attempt = mediaDevices.getUserMedia(constraints);
    if (wantVideo) {
      attempt = attempt
        .catch((e) => {
          // Exact constraints (resolution/fps) can be over-constrained on some
          // cameras — retry with just the facing mode before giving up on video.
          this._log(`video capture failed (${e && e.message}) — retrying with facingMode only`);
          return mediaDevices.getUserMedia({ audio: true, video: { facingMode: this._facing } });
        })
        .catch((e) => {
          this._log(`video capture failed again (${e && e.message}) — retrying with video:true`);
          return mediaDevices.getUserMedia({ audio: true, video: true });
        })
        .catch((e) => {
          // Camera capture failed every way → audio-only downgrade (reference
          // parity): the call proceeds as voice rather than failing outright.
          this._log(`video capture failed (${e && e.message}) — falling back to audio-only`);
          return mediaDevices.getUserMedia({ audio: true, video: false });
        });
    }
    this._capturing = attempt
      .then((stream) => {
        this._capturing = null;
        if ((this._capGen || 0) !== gen) {
          try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
          throw new Error('capture aborted (call torn down)');
        }
        this._localStream = stream;
        this._emit('localstream', stream);
        return stream;
      }, (e) => {
        this._capturing = null;
        throw e;
      });
    return this._capturing;
  }

  // ---- room media ----
  _startMedia(serverUrl) {
    let pre = Promise.resolve();
    if (serverUrl && serverUrl !== this._serverUrl) pre = this._migrate(serverUrl);
    return pre.then(() => {
      // Kick capture but DON'T serialize the room join behind it — the join
      // handshake (several round trips + ICE/DTLS) runs while getUserMedia
      // warms up; _produceLocal awaits the memoized capture when it needs the
      // tracks (and surfaces its failure there).
      this._capture().catch(() => {});
      return this._joinRoom();
    });
  }

  _joinRoom() {
    const room = this._room;
    if (!room) return Promise.reject(new Error('no room'));
    let joinRes = null;
    // Defensive: drop any stale server-side room membership.
    try { this._socket && this._socket.emit('leaveRoom'); } catch (_) {}
    return this._req('joinRoom', {
      roomId: room.roomId, name: this.name, sessionId: this.userId, token: this._token || undefined,
    }).then((res) => {
      joinRes = res || {};
      this._device = this._makeDevice();
      return this._device.load({ routerRtpCapabilities: joinRes.rtpCapabilities });
    }).then(() => (
      // These three server round trips are independent of each other — batch
      // them instead of paying three sequential RTTs on the connect path.
      Promise.all([
        this._req('setRtpCapabilities', { rtpCapabilities: this._device.rtpCapabilities }),
        this._req('createWebRtcTransport', { direction: 'send' }),
        this._req('createWebRtcTransport', { direction: 'recv' }),
      ])
    ))
      .then(([, sp, rp]) => {
        // Torn down (hangup/remote end) while the join round trips were in
        // flight — building transports / re-capturing on the dead state would
        // leak a mic and mark a stale room joined.
        if (this._room !== room) throw new Error('call torn down during join');
        const ice = (joinRes.iceServers && joinRes.iceServers.length) ? joinRes.iceServers : (this._fallbackIceServers || []);
        this._sendTransport = this._device.createSendTransport({ ...sp, iceServers: ice });
        this._wireTransport(this._sendTransport);
        this._recvTransport = this._device.createRecvTransport({ ...rp, iceServers: ice });
        this._wireTransport(this._recvTransport);
        room.joined = true;
        const queued = this._pendingProducers;
        this._pendingProducers = [];
        const list = (joinRes.existingProducers || []).concat(queued);
        this._log(`room joined — producing + consuming ${list.length} (existing+queued)`);
        // All consumes fire CONCURRENTLY (each is an independent consume +
        // resumeConsumer pair; mediasoup-client serializes what it must
        // internally) — the old serial chain made every extra producer add a
        // full round trip before the first audio could flow.
        const consumeAll = Promise.all(list.map((p) => (
          this._consume(p).catch((e) => this._log(`consume failed: ${e && e.message}`))
        )));
        // Produce (send-side ICE/DTLS) and consume (recv-side ICE/DTLS) in
        // PARALLEL — serializing them stacked the two handshakes back to back,
        // which was most of the "Connecting…" wait after an answer. Local
        // produce first awaits the (memoized) capture for its tracks.
        this._producingLocal = true;
        const produceAll = this._capture()
          .then(() => this._produceLocal())
          .then(
            (v) => { this._producingLocal = false; return v; },
            (e) => { this._producingLocal = false; throw e; },
          );
        return Promise.all([produceAll, consumeAll]);
      });
  }

  // react-native-webrtc is unified-plan; tell mediasoup-client explicitly so it
  // never mis-detects the environment (registerGlobals makes auto-detection
  // work too — this is belt and braces, with auto as the fallback).
  // NOTE: mediasoup-client 3.18's RN handler is named 'ReactNative106' (for
  // react-native-webrtc >= 106); 'ReactNativeUnifiedPlan' does not exist and
  // always threw into the fallback.
  _makeDevice() {
    try {
      return new Device({ handlerName: 'ReactNative106' });
    } catch (e) {
      this._log(`ReactNative106 handler unavailable (${e && e.message}) — using auto-detection`);
      return new Device();
    }
  }

  _wireTransport(t) {
    t.on('connect', (args, cb, eb) => {
      this._req('connectTransport', { transportId: t.id, dtlsParameters: args.dtlsParameters }).then(cb).catch(eb);
    });
    if (t.direction === 'send') {
      t.on('produce', (args, cb, eb) => {
        this._req('produce', { transportId: t.id, kind: args.kind, rtpParameters: args.rtpParameters, appData: args.appData })
          .then((r) => { cb({ id: r.id }); }).catch(eb);
      });
    }
    t.on('connectionstatechange', (state) => {
      this._log(`transport ${t.direction} → ${state}`);
      if (state === 'failed' || state === 'disconnected') {
        this._emitDown(`ice:${state}`);
        if (this._socket && this._socket.connected) this._restartIceOn(t);
      } else if (state === 'connected' || state === 'completed') {
        this._emitUp('ice:connected');
        if (t.direction === 'recv') this._flushPendingStreams();
      }
    });
  }

  // Producers created during a PRE-ANSWER warm-up start PAUSED — nothing is
  // audible/visible to anyone until callAccepted promotes the room and resumes
  // them. (A consumer of a paused producer receives silence, so even a client
  // that joined the room early hears nothing.)
  _pauseIfPreAnswer(pr) {
    if (this._room && this._room.preAnswer && pr && !pr.closed) {
      try { pr.pause(); } catch (_) {}
      this._req('pauseProducer', { producerId: pr.id }).catch(() => {});
    }
  }

  _produceLocal() {
    let chain = Promise.resolve();
    const audio = this._localStream ? this._localStream.getAudioTracks()[0] : null;
    if (audio && !this._producers.mic) {
      chain = chain.then(() => this._sendTransport.produce({ track: audio, appData: { source: 'mic' } })
        .then((pr) => { this._producers.mic = pr; this._pauseIfPreAnswer(pr); }));
    }
    if (this._media === 'video') {
      const video = this._localStream ? this._localStream.getVideoTracks()[0] : null;
      if (video && !this._producers.camera) {
        chain = chain.then(() => {
          const codecs = (this._device.rtpCapabilities && this._device.rtpCapabilities.codecs) || [];
          const vp8 = codecs.find((c) => String(c.mimeType).toLowerCase() === 'video/vp8') || null;
          const opts = {
            track: video,
            encodings: CAM_ENCODINGS,
            codecOptions: { videoGoogleStartBitrate: 1000 },
            appData: { source: 'camera' },
          };
          if (vp8) opts.codec = vp8;
          return this._sendTransport.produce(opts).then((pr) => { this._producers.camera = pr; this._pauseIfPreAnswer(pr); });
        });
      }
    }
    return chain;
  }

  _consume(p) {
    const producerId = p && p.producerId;
    const peerId = p && p.peerId != null ? String(p.peerId) : 'peer';
    const source = (p && p.source) || (p && p.appData && p.appData.source) || null;
    const isScreen = source === 'screen';
    const streamKey = isScreen ? `${peerId}#screen` : peerId;
    if (!producerId || this._consumed[producerId]) return Promise.resolve();
    if (!this._recvTransport || !this._device) return Promise.resolve();
    this._consumed[producerId] = true;
    return this._req('consume', {
      transportId: this._recvTransport.id, producerId, rtpCapabilities: this._device.rtpCapabilities,
    }).then((params) => this._recvTransport.consume({
      id: params.id, producerId: params.producerId, kind: params.kind, rtpParameters: params.rtpParameters,
    })).then((consumer) => {
      this._consumers[consumer.id] = consumer;
      consumer.appData = consumer.appData || {};
      consumer.appData.peerId = peerId;
      consumer.appData.streamKey = streamKey;
      const webrtc = getWebrtc();
      let stream = this._peerStreams[streamKey];
      if (!stream) {
        stream = new webrtc.MediaStream();
        this._peerStreams[streamKey] = stream;
      }
      // Replace any older track of the same kind (camera re-produce etc.).
      stream.getTracks().forEach((t) => {
        if (t.kind === consumer.track.kind && t !== consumer.track) { try { stream.removeTrack(t); } catch (_) {} }
      });
      stream.addTrack(consumer.track);
      return this._req('resumeConsumer', { consumerId: consumer.id }).then(() => {
        this._groupJoined[peerId] = true;
        this._log(`consuming ${consumer.track.kind}${isScreen ? ' (screen)' : ''} from ${peerId}`);
        this._emitStreamWhenLive({ peerId, stream, source });
      });
    }).catch((e) => {
      delete this._consumed[producerId];
      throw e;
    });
  }

  // Emit 'stream' only once the recv transport is actually CONNECTED (ICE+DTLS
  // done = media genuinely flowing). CallProvider starts the call timer on this
  // event; emitting at consumer-creation produced "connected + duration running"
  // with dead media while ICE was still negotiating or had failed.
  _emitStreamWhenLive(payload) {
    const t = this._recvTransport;
    const st = t && t.connectionState;
    if (st === 'connected' || st === 'completed') { this._emit('stream', payload); return; }
    this._pendingStreamEmits.push(payload);
  }

  _flushPendingStreams() {
    const list = this._pendingStreamEmits;
    this._pendingStreamEmits = [];
    list.forEach((p) => this._emit('stream', p));
  }

  _dropPeer(peerId) {
    Object.keys(this._consumers).forEach((cid) => {
      const c = this._consumers[cid];
      if (c && c.appData && c.appData.peerId === peerId) {
        delete this._consumed[c.producerId];
        try { c.close(); } catch (_) {}
        delete this._consumers[cid];
      }
    });
    delete this._peerStreams[peerId];
    delete this._peerStreams[`${peerId}#screen`];
  }

  // ---- reconnection / network resilience ----
  _emitDown(why) {
    if (this._mediaDown) return;
    this._mediaDown = true;
    this._log(`media DOWN (${why})`);
    // Keep RETRYING the recovery, not just the single restartIce fired by the
    // state-change handler: a mid-call NAT rebind / network flap often needs a
    // second or third ICE restart once the path settles — one failed attempt
    // used to leave the call stuck on "Reconnecting…" until the watchdog cut
    // it ("kuch der baad Connecting… dikhta hai").
    this._armRecovery();
    this._emit('disconnected', { reason: why });
  }

  _emitUp(why) {
    if (!this._mediaDown) return;
    this._mediaDown = false;
    this._clearRecovery();
    this._log(`media UP (${why})`);
    this._emit('connected', { reason: why });
  }

  _armRecovery() {
    this._clearRecovery();
    this._recoverUntil = Date.now() + 30000; // provider watchdog owns the final verdict
    this._recoverTimer = setInterval(() => {
      if (!this._mediaDown || !this._room || Date.now() > this._recoverUntil) {
        this._clearRecovery();
        return;
      }
      if (this._socket && this._socket.connected) {
        this._log('media recovery tick — restarting ICE');
        this.restartIce();
      }
      // Socket down → socket.io's reconnect + the 'connect' handler's _resume()
      // own the recovery; this loop resumes ICE restarts once it's back.
    }, 3000);
  }

  _clearRecovery() {
    if (this._recoverTimer) { clearInterval(this._recoverTimer); this._recoverTimer = null; }
  }

  _resume() {
    const room = this._room;
    if (!room) return;
    this._req('joinRoom', {
      roomId: room.roomId, name: this.name, sessionId: this.userId, resume: true, token: this._token || undefined,
    }).then((res) => {
      if (res && res.resumed) {
        this.restartIce();
        (res.existingProducers || []).forEach((p) => { this._consume(p).catch(() => {}); });
        this._emitUp('resume');
        this._log('call resumed after reconnect');
        return null;
      }
      // Grace expired server-side — rebuild the media pipeline from scratch.
      this._log('resume not available — rebuilding media pipeline');
      Object.keys(this._producers).forEach((k) => { try { this._producers[k].close(); } catch (_) {} });
      this._producers = {};
      Object.keys(this._consumers).forEach((k) => { try { this._consumers[k].close(); } catch (_) {} });
      this._consumers = {};
      this._consumed = {};
      this._peerStreams = {};
      this._pendingStreamEmits = [];
      try { this._sendTransport && this._sendTransport.close(); } catch (_) {}
      try { this._recvTransport && this._recvTransport.close(); } catch (_) {}
      this._sendTransport = null;
      this._recvTransport = null;
      this._device = null;
      room.joined = false;
      return this._joinRoom().then(() => {
        this._emitUp('rejoin');
        this._log('call rejoined after reconnect');
      });
    }).catch((e) => {
      this._log(`resume failed: ${e && e.message}`);
      // Next socket reconnect retries; RN's reconnect watchdog bounds the wait.
    });
  }

  restartIce() {
    [this._sendTransport, this._recvTransport].forEach((t) => { if (t) this._restartIceOn(t); });
  }

  _restartIceOn(t) {
    this._req('restartIce', { transportId: t.id })
      .then((r) => t.restartIce({ iceParameters: r.iceParameters }))
      .then(() => this._log(`ICE restarted ${t.direction}`))
      .catch((e) => this._log(`ICE restart failed ${t.direction}: ${e && e.message}`));
  }

  // ---- in-call controls ----

  // Recovery pass after a CallKit audio-session (re)activation or an OS audio
  // interruption. The session handshake itself (RTCAudioSession sync) happens
  // in the engine BEFORE this; here we repair what a dead-session window can
  // break at the track level: an OS-force-ended mic track is re-captured and
  // replaceTrack'd into the live producer, preserving the mute state. Resolves
  // true only when a re-capture actually happened (idempotent otherwise).
  restartAudio() {
    const stream = this._localStream;
    const old = stream ? stream.getAudioTracks()[0] : null;
    if (!stream || (old && old.readyState !== 'ended')) return Promise.resolve(false);
    const webrtc = getWebrtc();
    if (!webrtc) return Promise.resolve(false);
    const wasEnabled = old ? old.enabled !== false : true;
    return webrtc.mediaDevices.getUserMedia({ audio: true, video: false }).then((s) => {
      const fresh = s.getAudioTracks()[0];
      if (!fresh) return false;
      fresh.enabled = wasEnabled;
      if (old) { try { stream.removeTrack(old); old.stop(); } catch (_) {} }
      try { stream.addTrack(fresh); } catch (_) {}
      const p = this._producers.mic;
      if (p && !p.closed) {
        return p.replaceTrack({ track: fresh }).then(() => {
          this._log('mic track re-captured after session interruption');
          return true;
        });
      }
      this._log('mic track re-captured (no producer yet)');
      return true;
    }).catch((e) => {
      this._log(`restartAudio re-capture failed: ${e && e.message}`);
      return false;
    });
  }

  toggleMic(on) {
    const p = this._producers.mic;
    // Track-level enable ALWAYS (mute works even before the producer exists).
    if (this._localStream) {
      try { this._localStream.getAudioTracks().forEach((t) => { t.enabled = !!on; }); } catch (_) {}
    }
    if (!p) return;
    if (on) { this._req('resumeProducer', { producerId: p.id }).catch(() => {}); try { p.resume(); } catch (_) {} }
    else { this._req('pauseProducer', { producerId: p.id }).catch(() => {}); try { p.pause(); } catch (_) {} }
  }

  toggleCamera(on) {
    const p = this._producers.camera;
    if (!p || p.closed) {
      // Camera ON with no producer covers TWO cases with the same mechanics:
      //  • WhatsApp-style upgrade of an AUDIO call to video, and
      //  • RECOVERY of a VIDEO call whose camera never captured — an iOS
      //    CallKit answer from the background can't open the camera (only the
      //    mic is legal there), so _capture() downgraded to audio-only and each
      //    side saw only ONE video tile. The app re-sends toggleCamera(on) on
      //    foreground; this path captures + produces the camera then.
      // While the join pipeline's own capture→produce is still in flight, let
      // it land first (it produces the camera for a video call itself — racing
      // it here made a duplicate camera producer).
      if (on && this._room && this._room.joined && this._sendTransport
          && !this._capturing && !this._producingLocal) {
        this._upgradeToVideo().catch((e) => {
          this._log(`video upgrade failed: ${e && e.message}`);
          this._emit('mediaupgradefailed', { message: (e && e.message) || 'Could not start the camera' });
        });
      }
      return;
    }
    const track = this._localStream ? this._localStream.getVideoTracks()[0] : null;
    // Producer exists but its track is gone/OS-ended (backgrounded video call:
    // iOS force-ends the camera track) → re-capture and swap it into the live
    // producer instead of resuming a dead track (which stays black both ways).
    if (on && (!track || track.readyState === 'ended')) {
      this._recaptureCamera(p);
      return;
    }
    if (this._localStream) {
      try { this._localStream.getVideoTracks().forEach((t) => { t.enabled = !!on; }); } catch (_) {}
    }
    if (on) { this._req('resumeProducer', { producerId: p.id }).catch(() => {}); try { p.resume(); } catch (_) {} }
    else { this._req('pauseProducer', { producerId: p.id }).catch(() => {}); try { p.pause(); } catch (_) {} }
  }

  // Fresh camera capture + replaceTrack on the live producer (mute state and
  // producing continue seamlessly on the other side). Foreground-only by nature:
  // a background attempt fails capture and resolves false (retried on the next
  // foreground pass).
  _recaptureCamera(producer) {
    const webrtc = getWebrtc();
    if (!webrtc) return Promise.resolve(false);
    const { mediaDevices } = webrtc;
    return mediaDevices.getUserMedia({ video: { facingMode: this._facing } })
      .catch(() => mediaDevices.getUserMedia({ video: true }))
      .then((s) => {
        const fresh = s.getVideoTracks()[0];
        if (!fresh) {
          try { s.getTracks().forEach((t) => t.stop()); } catch (_) {}
          throw new Error('no camera track');
        }
        const old = this._localStream ? this._localStream.getVideoTracks()[0] : null;
        if (old) { try { this._localStream.removeTrack(old); old.stop(); } catch (_) {} }
        if (this._localStream) { try { this._localStream.addTrack(fresh); } catch (_) {} }
        return producer.replaceTrack({ track: fresh }).then(() => {
          this._req('resumeProducer', { producerId: producer.id }).catch(() => {});
          try { producer.resume(); } catch (_) {}
          this._log('camera track re-captured (foreground recovery)');
          // Same event the audio→video upgrade fires: the engine refreshes the
          // local tile registry and the app re-asserts the video UI.
          this._emit('mediaupgraded', { media: 'video' });
          return true;
        });
      })
      .catch((e) => { this._log(`camera re-capture failed: ${e && e.message}`); return false; });
  }

  _upgradeToVideo() {
    if (this._producers.camera) return Promise.resolve();
    const webrtc = getWebrtc();
    if (!webrtc) return Promise.reject(new Error('react-native-webrtc unavailable'));
    const { mediaDevices } = webrtc;
    return mediaDevices.getUserMedia({ video: { facingMode: this._facing } })
      .catch((e) => {
        this._log(`upgrade facingMode capture failed (${e && e.name}) — retrying without constraint`);
        return mediaDevices.getUserMedia({ video: true });
      })
      .then((stream) => {
        const track = stream.getVideoTracks()[0];
        if (!track) {
          try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
          throw new Error('No camera track');
        }
        if (this._localStream) {
          try { this._localStream.addTrack(track); } catch (_) {}
        } else {
          this._localStream = stream;
        }
        this._media = 'video';
        if (this._room) this._room.media = 'video';
        return this._produceLocal().then(() => {
          this._log('call upgraded to video (camera producing)');
          this._emit('mediaupgraded', { media: 'video' });
        });
      });
  }

  // ---- screen share ----
  // Android: react-native-webrtc implements getDisplayMedia natively via
  // MediaProjection + its own bundled foreground service (WhatsApp-style
  // whole-screen capture — needs FOREGROUND_SERVICE_MEDIA_PROJECTION in the
  // app manifest). iOS: whole-screen capture needs a ReplayKit broadcast
  // extension the app doesn't ship, so getDisplayMedia rejects → reported as
  // `unsupported` and the UI shows the "not supported" alert. Receiving a
  // peer's shared screen works everywhere regardless.
  startScreenShare() {
    if (this._producers.screen && !this._producers.screen.closed) return Promise.resolve(true);
    if (!this._room || !this._room.joined || !this._sendTransport) {
      return Promise.reject(new Error('not in a connected call'));
    }
    const webrtc = getWebrtc();
    const md = webrtc && webrtc.mediaDevices;
    if (!md || typeof md.getDisplayMedia !== 'function') {
      const e = new Error("Screen sharing isn't supported on this device");
      e.unsupported = true;
      return Promise.reject(e);
    }
    return md.getDisplayMedia({ video: true }).then((stream) => {
      const track = stream.getVideoTracks()[0];
      if (!track) {
        try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        throw new Error('no screen track');
      }
      this._screenStream = stream;
      return this._sendTransport.produce({ track, appData: { source: 'screen' } }).then((pr) => {
        this._producers.screen = pr;
        // The OS "stop sharing" affordance (status-bar chip / notification)
        // ends the track underneath us — mirror it as a clean stop so the UI
        // flag and the remote tile both clear.
        pr.on('trackended', () => {
          this.stopScreenShare().catch(() => {});
          this._emit('screenshare', { on: false });
        });
        this._log('screen share started (native capture)');
        return true;
      });
    }).catch((e) => {
      if (this._screenStream) {
        try { this._screenStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        this._screenStream = null;
      }
      // A user cancelling the OS capture prompt is a normal outcome, not a
      // device limitation — only flag `unsupported` when the API is missing.
      throw e;
    });
  }

  stopScreenShare() {
    const pr = this._producers.screen;
    delete this._producers.screen;
    if (pr && !pr.closed) {
      // closeProducer tells the SFU to broadcast producerClosed so every peer
      // drops the `<peerId>#screen` tile immediately.
      this._req('closeProducer', { producerId: pr.id }).catch(() => {});
      try { pr.close(); } catch (_) {}
    }
    if (this._screenStream) {
      try { this._screenStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      this._screenStream = null;
    }
    return Promise.resolve(!!pr);
  }

  switchCamera() {
    const track = this._localStream ? this._localStream.getVideoTracks()[0] : null;
    const next = this._facing === 'user' ? 'environment' : 'user';
    // react-native-webrtc flips the capture in place — no re-getUserMedia, no
    // replaceTrack, no renegotiation (the reference's whole switch dance).
    if (track && typeof track._switchCamera === 'function') {
      try { track._switchCamera(); } catch (e) { return Promise.reject(e); }
      this._facing = next;
      this._emit('camerachanged', { facingMode: next });
      return Promise.resolve(next);
    }
    return Promise.reject(new Error('no camera track'));
  }

  queryPresence(ids) {
    const list = (ids || []).map(String);
    const build = (users) => {
      const online = {};
      (users || []).forEach((u) => { if (u && u.id != null) online[String(u.id)] = true; });
      const map = {};
      list.forEach((id) => { map[id] = !!online[id]; });
      return map;
    };
    return this._req('getUsers', {}).then((r) => {
      if (r && r.users) this._users = r.users;
      return build(this._users);
    }).catch(() => build(this._users));
  }
}
