/**
 * HTML for the WebView "call engine". This runs inside react-native-webview as
 * a real browser context (the only place browser WebRTC/mediasoup can run).
 *
 * The media stack is the mediasoup SFU calling server (CALL_BASE_URL, e.g.
 * https://mediacall.vigorousit.com). socket.io-client + mediasoup-client are
 * INLINED from the generated vendor bundle (callEngineVendor.js), so the engine
 * boots with zero external <script> loads; the page still uses the calling
 * server origin as baseUrl so it is a secure context (required for
 * getUserMedia). The `CallingSDK` class below is an adapter that keeps the OLD
 * SDK's public API (connect / startCall / accept / reject / hangup /
 * toggleMic/Camera / switchCamera / queryPresence / restartIce + events) but
 * speaks the mediasoup server's contract:
 *   signalling — register / callUser / acceptCall / declineCall / cancelCall /
 *     endCall / startGroupCall / joinGroupCall / inviteToGroupCall …
 *   media — joinRoom / setRtpCapabilities / createWebRtcTransport /
 *     connectTransport / produce / consume / resumeConsumer / restartIce.
 * Identity: the server keys users on `sessionId` (register ack id ===
 * sessionId), so we register with sessionId = the app userId — a call targets
 * the peer's app userId directly.
 *
 * It renders the video tiles itself (MediaStream can only attach to a real
 * <video> element); React Native draws all call chrome as a native overlay on
 * top. Remote tiles are created/destroyed dynamically per peer so the same
 * engine serves both 1:1 and group calls (up to 32 participants). For audio
 * calls RN keeps this WebView hidden — audio still plays through the sinks.
 *
 * Audio output routing (speaker vs earpiece) is done with HTMLMediaElement
 * setSinkId() where the platform supports it (Android WebView / Chromium); on
 * iOS WKWebView the OS controls routing and setSinkId is a no-op.
 */

import { VENDOR_JS } from './callEngineVendor';

const SDK_ORIGIN = 'https://mediacall.vigorousit.com';

export const CALL_ENGINE_BASE_URL = SDK_ORIGIN;

export const buildCallEngineHtml = () => `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<style>
  /* PiP corner offsets. --pip-top clears the native RN call top bar (name +
     timer + minimize); --pip-bottom clears the bottom controls pill — so the
     small self-view window never hides under either, and can sit in any corner. */
  :root { --pip-top: 108px; --pip-bottom: 140px; --pip-margin: 14px; }
  html, body { margin:0; padding:0; height:100%; width:100%; background:#000; overflow:hidden; }
  #stage { position:absolute; inset:0; background:#000; }

  /* Remote tiles live in a responsive grid. 1 tile fills the stage; 2-4 tiles
     split it. The grid auto-balances via a column count we set from JS. */
  #remotes {
    position:absolute; inset:0;
    display:grid; gap:2px;
    grid-template-columns:1fr; grid-auto-rows:1fr;
    background:#000;
  }
  #remotes.cols-2 { grid-template-columns:1fr 1fr; }
  #remotes.cols-3 { grid-template-columns:1fr 1fr 1fr; }
  #remotes.cols-4 { grid-template-columns:1fr 1fr 1fr 1fr; }
  #remotes.count-1 { grid-template-columns:1fr; grid-auto-rows:1fr; }
  /* Swapped (tap-to-swap): the remote feed shrinks to the PiP corner while the
     local self-camera fills the stage — WhatsApp PiP swap. */
  #remotes.pip {
    inset:auto;
    width:104px; height:148px;
    border-radius:14px; overflow:hidden; z-index:4;
    box-shadow:0 2px 10px rgba(0,0,0,0.5);
    gap:0; grid-template-columns:1fr;
    transition: top 0.18s ease, bottom 0.18s ease, left 0.18s ease, right 0.18s ease;
  }
  .rtile { position:relative; overflow:hidden; background:#0b141a; min-height:0; }
  .rtile video { width:100%; height:100%; object-fit:cover; background:#000; }

  /* Draggable self-view PiP container. The inner <video> keeps the mirror
     transform; the wrapper owns position + the drag transform so the two never
     fight. Default corner is set from JS (top-right, shifted down by --pip-top). */
  #localWrap {
    position:absolute;
    width:104px; height:148px;
    border-radius:14px; overflow:hidden; background:#111; z-index:3;
    box-shadow:0 2px 10px rgba(0,0,0,0.5);
    touch-action:none; cursor:grab;
    transition: top 0.18s ease, bottom 0.18s ease, left 0.18s ease, right 0.18s ease;
  }
  #local { width:100%; height:100%; object-fit:cover; background:#111; display:block; }
  /* While there's no remote yet (outgoing video ringing), the self-camera fills
     the whole stage like WhatsApp; it shrinks back to a corner PiP once a remote
     tile appears. */
  #localWrap.solo {
    top:0 !important; right:0 !important; left:0 !important; bottom:0 !important;
    width:100%; height:100%;
    border-radius:0; box-shadow:none; z-index:1; cursor:default;
    transform:none !important;
  }

  /* Four snap corners — applied to whichever element is the small PiP (the
     self-view wrapper, or the remote grid when swapped). Id-qualified so they
     win over the base #localWrap / #remotes.pip rules. */
  #localWrap.corner-tl, #remotes.pip.corner-tl { top: var(--pip-top); left: var(--pip-margin); right:auto; bottom:auto; }
  #localWrap.corner-tr, #remotes.pip.corner-tr { top: var(--pip-top); right: var(--pip-margin); left:auto; bottom:auto; }
  #localWrap.corner-bl, #remotes.pip.corner-bl { bottom: var(--pip-bottom); left: var(--pip-margin); right:auto; top:auto; }
  #localWrap.corner-br, #remotes.pip.corner-br { bottom: var(--pip-bottom); right: var(--pip-margin); left:auto; top:auto; }

  video { background:#000; }
  .mirror { transform: scaleX(-1); }

  /* "Camera off" placeholder shown over a tile whose camera is muted, instead of
     a black frame (WhatsApp-style). Fills the localWrap — small in the PiP, full
     in the solo full-screen self-view. */
  .camoff {
    position:absolute; inset:0; z-index:2;
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    gap:10px; background:#1f2c34;
  }
  .camoff-badge {
    width:60px; height:60px; border-radius:50%;
    background:rgba(255,255,255,0.14);
    display:flex; align-items:center; justify-content:center;
  }
  .camoff-badge svg { width:30px; height:30px; fill:rgba(255,255,255,0.9); }
  .camoff-text { color:rgba(255,255,255,0.85); font:13px/1.2 -apple-system, Roboto, system-ui, sans-serif; }
  /* Bigger badge/label when the self-view fills the whole stage. */
  #localWrap.solo .camoff-badge { width:104px; height:104px; }
  #localWrap.solo .camoff-badge svg { width:52px; height:52px; }
  #localWrap.solo .camoff-text { font-size:16px; }

  /* REMOTE camera-off overlay: the peer's circular profile photo centered on a
     dark card over their tile (WhatsApp look). Sized relative to the tile so it
     works both full-bleed and as the swapped corner PiP. */
  .camoff-avatar {
    width:42%; max-width:150px; aspect-ratio:1/1;
    border-radius:50%; object-fit:cover; background:#3b4a54;
  }
  .camoff-letter {
    width:42%; max-width:150px; aspect-ratio:1/1;
    border-radius:50%; background:#3b4a54;
    display:flex; align-items:center; justify-content:center;
    color:#fff; font:600 34px/1 -apple-system, Roboto, system-ui, sans-serif;
  }

  .hidden { display:none !important; }
</style>
</head>
<body>
  <div id="stage">
    <div id="remotes" class="count-1"></div>
    <div id="localWrap" class="hidden">
      <video id="local" autoplay playsinline muted class="mirror"></video>
      <div id="localCamOff" class="camoff hidden">
        <div class="camoff-badge">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z"></path></svg>
        </div>
        <div class="camoff-text">Camera off</div>
      </div>
    </div>
  </div>

  <script>${VENDOR_JS}</script>
  <script>
  /* CallingSDK — mediasoup adapter. Same public API as the old hosted SDK so
     the glue script + React Native side stay unchanged; internally it drives
     the mediasoup SFU server contract (see file header). No backticks in here:
     this whole page lives inside a JS template literal. */
  (function () {
    'use strict';

    var RETRY_MS = 2500;          // offline-invitee redial poll interval
    // Redial/re-invite only within roughly the ring window — past it a callee
    // who never answered must NOT get a fresh ring out of nowhere.
    var RETRY_WINDOW_MS = 40000;
    var REASSERT_MS = 5000;       // min gap between ring reasserts after a successful dial

    // Explicit voice-processing constraints — most WebViews default these ON,
    // but relying on defaults left it device-dependent (echo/level complaints
    // on some OEMs). Idempotent where already the default.
    var AUDIO_CONS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    // Opus voice tuning (WhatsApp-style): FEC hides packet loss (choppy-audio
    // killer on weak networks), DTX stops sending during silence, MONO at a
    // 32 kbps cap — voice needs no stereo/96k, and the lighter stream survives
    // jittery mobile links far better (less loss = fewer robotic patches).
    var MIC_CODEC_OPTIONS = { opusFec: true, opusDtx: true, opusStereo: false, opusMaxAverageBitrate: 32000 };
    // Camera simulcast: 3 layers; the SFU forwards the best fit per receiver.
    var CAM_ENCODINGS = [
      { scaleResolutionDownBy: 4, maxBitrate: 150000 },
      { scaleResolutionDownBy: 2, maxBitrate: 500000 },
      { scaleResolutionDownBy: 1, maxBitrate: 1200000 }
    ];

    // token = base64(JSON { sub, name }) minted by chat-backend (UTF-8 safe).
    function decodeToken(token) {
      try {
        var raw = atob(String(token || ''));
        var json = decodeURIComponent(Array.prototype.map.call(raw, function (c) {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        var obj = JSON.parse(json);
        if (obj && obj.sub) return { userId: String(obj.sub), name: obj.name || 'User' };
      } catch (e) {}
      return null;
    }

    function CallingSDK(opts) {
      opts = opts || {};
      this.url = String(opts.url || '').replace(/\\/+$/, '');
      this.debug = !!opts.debug;
      var id = decodeToken(opts.token);
      // Keep the raw token: when it is a REAL JWT (three dot-separated parts —
      // backend CALL_JWT_SECRET mode) it is forwarded on joinRoom so the media
      // server can enforce REQUIRE_TOKEN=true. The legacy base64 envelope is
      // NEVER forwarded (the server verifies any provided token, so sending a
      // non-JWT would fail the join even with requireToken off).
      this._token = (typeof opts.token === 'string' && opts.token.split('.').length === 3)
        ? opts.token : '';
      this.userId = String(opts.userId || (id && id.userId) || '');
      this.name = String(opts.name || (id && id.name) || 'User');
      this._handlers = {};
      this._socket = null;
      this._serverUrl = '';
      this._registered = false;
      this._device = null;
      this._sendTransport = null;
      this._recvTransport = null;
      this._localStream = null;
      this._screenStream = null; // getDisplayMedia stream while sharing
      this._producers = {};      // 'mic' | 'camera' | 'screen' -> Producer
      this._consumers = {};      // consumerId -> Consumer
      this._consumed = {};       // producerId -> true
      this._peerStreams = {};    // peerId (app userId) -> MediaStream
      this._pendingIn = {};      // callId | groupId -> incoming info
      this._declined = {};       // groupId -> declined-at ms (suppress re-ring briefly)
      this._out = null;          // outgoing 1:1 { callId, roomId, to } (LATEST dial)
      this._dialTarget = null;   // 1:1 callee id for the current dial (redial/reassert/grace-sweep recovery)
      this._outIds = {};         // EVERY callId minted for the current dial (redials + ring reasserts)
      this._lastDialAt = 0;      // rate-limits the ring-reassert loop
      this._declinedPeer = {};   // 1:1 peerId -> declined-at ms (swallow ring reasserts after decline)
      this._acceptedFrom = null; // 1:1 peerId whose call we accepted (dedupe post-accept reasserts)
      this._acceptedId = null;   // 1:1 callId accepted; waiting for callAccepted
      this._room = null;         // { roomId, groupId, callId, media, joined }
      this._pendingProducers = []; // newProducer events that arrived mid-join
      this._media = 'audio';
      this._facing = 'user';
      this._users = [];          // latest online-users snapshot (presence)
      this._retryTimer = null;
      this._retryUntil = 0;
      this._mediaDown = false;
      this._groupInvitees = [];
      this._groupJoined = {};
      // App-supplied STUN/TURN fallback (from the backend token mint). Used for
      // the mediasoup transports when the media server's joinRoom response
      // carries no iceServers — without a TURN relay, cross-NAT (cellular /
      // CGNAT / symmetric NAT) calls join the room but media never flows.
      this._fallbackIceServers = (Array.isArray(opts.iceServers) && opts.iceServers.length)
        ? opts.iceServers : null;
    }

    CallingSDK.prototype.on = function (ev, cb) {
      (this._handlers[ev] = this._handlers[ev] || []).push(cb);
      return this;
    };
    CallingSDK.prototype._emit = function (ev, data) {
      var list = this._handlers[ev] || [];
      for (var i = 0; i < list.length; i++) { try { list[i](data); } catch (e) {} }
    };
    CallingSDK.prototype._log = function (msg) {
      try {
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'log', payload: { message: '[sdk] ' + String(msg) } }));
        }
      } catch (e) {}
    };

    // Promise wrapper over a Socket.IO ack.
    CallingSDK.prototype._req = function (event, data) {
      var self = this;
      return new Promise(function (resolve, reject) {
        if (!self._socket || !self._socket.connected) { reject(new Error(event + ': not connected')); return; }
        var t = setTimeout(function () { reject(new Error(event + ' timeout')); }, 10000);
        self._socket.emit(event, data || {}, function (res) {
          clearTimeout(t);
          if (res && res.error) reject(new Error(res.error)); else resolve(res || {});
        });
      });
    };

    // Wait (briefly) for the auto-reconnecting socket to come back before a
    // dial-time request, instead of failing the call on a transient drop.
    CallingSDK.prototype._waitSocket = function (ms) {
      var self = this;
      if (self._socket && self._socket.connected) return Promise.resolve();
      return new Promise(function (resolve, reject) {
        var s = self._socket;
        if (!s) { reject(new Error('not connected')); return; }
        var onC = function () { cleanup(); resolve(); };
        var t = setTimeout(function () { cleanup(); reject(new Error('not connected')); }, ms || 6000);
        function cleanup() { clearTimeout(t); try { s.off('connect', onC); } catch (e) {} }
        s.on('connect', onC);
      });
    };
    // Retry-safe request for the pause/resume CONTROL PLANE. These commands are
    // idempotent server-side but were fire-and-forget — a socket flap at the
    // accept moment silently ate resumeProducer/resumeConsumer and the call sat
    // CONNECTED BUT SILENT forever (a server-paused producer DROPS the client's
    // RTP; a server-paused consumer forwards nothing). Waits for the auto-
    // reconnecting socket between attempts.
    CallingSDK.prototype._reqRetry = function (event, data, tries) {
      var self = this;
      var left = typeof tries === 'number' ? tries : 4;
      var attempt = function () {
        return self._waitSocket(4000).then(function () { return self._req(event, data); })
          .catch(function (e) {
            left -= 1;
            if (left <= 0) { self._log(event + ' FAILED after retries: ' + (e && e.message)); throw e; }
            return new Promise(function (r) { setTimeout(r, 800); }).then(attempt);
          });
      };
      return attempt();
    };

    // STATE-CONVERGENT producer sync. NEVER retry a raw pause/resume command:
    // a delayed pauseProducer retry (pre-answer privacy hold) can land AFTER
    // the promote's resumeProducer and leave the server-side producer paused
    // FOREVER — RTP silently dropped, total one-way silence. Every attempt
    // re-reads pr.paused NOW and asserts that; after success it re-checks and
    // converges if the state flipped mid-flight.
    CallingSDK.prototype._syncProducerState = function (pr, tries) {
      var self = this;
      var left = typeof tries === 'number' ? tries : 4;
      var attempt = function () {
        if (!pr || pr.closed) return Promise.resolve();
        var wantPaused = !!pr.paused;
        var ev = wantPaused ? 'pauseProducer' : 'resumeProducer';
        return self._waitSocket(4000).then(function () { return self._req(ev, { producerId: pr.id }); })
          .then(function () {
            // State flipped while the request was in flight → converge again.
            if (!pr.closed && !!pr.paused !== wantPaused) return attempt();
            return null;
          })
          .catch(function (e) {
            left -= 1;
            if (left <= 0) { self._log(ev + ' sync FAILED: ' + (e && e.message)); throw e; }
            return new Promise(function (r) { setTimeout(r, 800); }).then(attempt);
          });
      };
      return attempt();
    };

    // Produce the mic with the opus voice tuning; if a WebView rejects the
    // codecOptions, fall back to a PLAIN produce — tuning must never be the
    // reason a call has no audio at all.
    CallingSDK.prototype._produceMic = function (track) {
      var self = this;
      return self._sendTransport.produce({ track: track, codecOptions: MIC_CODEC_OPTIONS, appData: { source: 'mic' } })
        .catch(function (e) {
          self._log('mic produce with codecOptions failed (' + (e && e.message) + ') — retrying plain');
          return self._sendTransport.produce({ track: track, appData: { source: 'mic' } });
        });
    };

    // After a reconnect the server may have missed pause/resume commands sent
    // while the old socket was dying. LOCAL state is the source of truth —
    // re-assert every producer's pause state and re-resume every consumer
    // (all idempotent server-side). This is what heals a call that reconnected
    // "successfully" but stayed one-way/both-way silent.
    CallingSDK.prototype._reassertMediaState = function () {
      var self = this;
      Object.keys(self._producers || {}).forEach(function (k) {
        var pr = self._producers[k];
        if (!pr || pr.closed) return;
        self._syncProducerState(pr, 3).catch(function () {});
      });
      Object.keys(self._consumers || {}).forEach(function (k) {
        var c = self._consumers[k];
        if (!c || c.closed) return;
        self._reqRetry('resumeConsumer', { consumerId: c.id }, 3).catch(function () {});
      });
      self._log('media pause/resume state re-asserted after reconnect');
    };

    CallingSDK.prototype._reqDial = function (event, data) {
      var self = this;
      // 12s: a CallKit/killed-app answer boots the engine COLD — socket connect
      // + register can exceed the old 6s on a weak network, and the timeout
      // rejected acceptCall with 'not connected' → the just-answered call was
      // torn down ("pick karte hi cut"). The ring window (30s+) bounds this.
      return self._waitSocket(12000).then(function () { return self._req(event, data); });
    };

    // ---- connection / presence ----
    // Round-trip liveness probe for the CONNECT-reuse path. A backgrounded
    // WebView's socket can be HALF-OPEN: "connected" still reads true while the
    // TCP path is dead — reusing it would strand the next dial/accept until the
    // 10s request timeout. "register" doubles as the probe: idempotent server-
    // side and it re-asserts the lobby registration (clears any pending
    // disconnect-grace timer). Resolves true/false, never rejects.
    CallingSDK.prototype.verifyAlive = function (ms) {
      var self = this;
      return new Promise(function (resolve) {
        var s = self._socket;
        if (!s || !s.connected) { resolve(false); return; }
        var t = setTimeout(function () { resolve(false); }, ms || 2500);
        try {
          s.emit('register', { name: self.name, sessionId: self.userId }, function (res) {
            clearTimeout(t);
            if (res && res.users) self._users = res.users;
            resolve(!(res && res.error));
          });
        } catch (e) {
          clearTimeout(t);
          resolve(false);
        }
      });
    };

    CallingSDK.prototype.connect = function () {
      var self = this;
      if (!window.io) return Promise.reject(new Error('socket library missing'));
      if (!self.userId) return Promise.reject(new Error('missing user identity'));
      return new Promise(function (resolve, reject) {
        var settled = false;
        self._connectTo(self.url, function (err) {
          if (settled) return;
          settled = true;
          if (err) reject(err); else resolve();
        });
      });
    };

    CallingSDK.prototype._connectTo = function (url, done) {
      var self = this;
      if (self._socket) { try { self._socket.removeAllListeners(); self._socket.disconnect(); } catch (e) {} }
      var s = window.io(url, {
        transports: ['websocket', 'polling'],
        reconnection: true, reconnectionAttempts: Infinity,
        reconnectionDelay: 800, reconnectionDelayMax: 4000, timeout: 8000
      });
      self._socket = s;
      self._serverUrl = url;
      s.on('connect', function () {
        self._req('register', { name: self.name, sessionId: self.userId }).then(function (res) {
          self._users = (res && res.users) || [];
          self._registered = true;
          self._log('registered on ' + url + ' as ' + self.userId);
          if (done) { var d = done; done = null; d(null); }
          // Socket came back while we were in a call → resume the room media.
          if (self._room && self._room.joined) self._resume();
        }).catch(function (e) {
          self._log('register failed: ' + (e && e.message));
          if (done) { var d2 = done; done = null; d2(e); }
        });
      });
      s.on('connect_error', function (e) {
        self._log('connect_error: ' + (e && e.message));
      });
      s.on('disconnect', function (reason) {
        self._log('socket disconnected: ' + reason);
        if (self._room && self._room.joined) self._emitDown('signal:' + reason);
      });
      self._wire(s);
    };

    // Cluster room-affinity: move the socket to the server that owns the room.
    CallingSDK.prototype._migrate = function (url) {
      var self = this;
      self._log('migrating to room server ' + url);
      return new Promise(function (resolve, reject) {
        self._connectTo(url, function (err) { if (err) reject(err); else resolve(); });
      });
    };

    CallingSDK.prototype._wire = function (s) {
      var self = this;
      s.on('users', function (users) { self._users = users || []; });

      s.on('incomingCall', function (p) {
        p = p || {};
        var key = String(p.callId);
        if (self._pendingIn[key]) return;
        var fromId = p.from && p.from.id != null ? String(p.from.id) : null;
        if (fromId) {
          // Ring-REASSERT dedupe: the caller re-emits callUser every few
          // seconds (each mints a NEW callId server-side) so the ring survives
          // a dead grace-period socket. A second ring from the SAME peer while
          // we already ring/answer them is the SAME logical call — swallow it
          // silently; surfacing it would make the app auto-reject it as busy,
          // which the caller reads as a decline and kills the live dial.
          var dupRinging = Object.keys(self._pendingIn).some(function (k) {
            var q = self._pendingIn[k];
            return q && !q.group && q.from && String(q.from.id) === fromId;
          });
          var dupActive = self._acceptedFrom === fromId && (self._acceptedId || self._room);
          if (dupRinging || dupActive) { self._log('duplicate 1:1 ring from ' + fromId + ' (' + key + ') — swallowed'); return; }
          // Just declined this peer → quietly decline their reasserts too
          // (parity with the group _declined window) instead of re-ringing.
          var dec = self._declinedPeer[fromId];
          if (dec && (Date.now() - dec) < 15000) {
            try { s.emit('declineCall', { callId: key }); } catch (e) {}
            return;
          }
          delete self._declinedPeer[fromId];
        }
        self._pendingIn[key] = { group: false, callId: key, from: p.from || {}, media: p.callType === 'video' ? 'video' : 'audio' };
        self._emit('incoming', {
          callId: key,
          from: { id: p.from && p.from.id != null ? String(p.from.id) : null, name: (p.from && p.from.name) || '' },
          media: p.callType === 'video' ? 'video' : 'audio',
          isGroup: false, groupId: null, groupName: null, members: []
        });
      });

      s.on('incomingGroupCall', function (p) {
        p = p || {};
        var key = String(p.groupId);
        // The host re-invites not-yet-joined members (offline-wake support), so a
        // duplicate invite for a call we are already ringing is normal. A recent
        // DECLINE suppresses the automatic re-invites for a short window only —
        // a deliberate later re-invite (host's Add-participant) rings again.
        // Already IN this group call → re-invite echo; surfacing it would make
        // the app busy-reject OUR OWN call (declineGroupCall while connected).
        if (self._room && self._room.groupId === key) {
          self._log('re-invite for group ' + key + ' swallowed (already in the call)');
          return;
        }
        if (self._pendingIn[key]) return;
        if (self._declined[key] && (Date.now() - self._declined[key]) < 15000) {
          try { s.emit('declineGroupCall', { groupId: p.groupId }); } catch (e) {}
          return;
        }
        delete self._declined[key];
        self._pendingIn[key] = { group: true, groupId: p.groupId, roomId: p.roomId, from: p.from || {}, media: p.callType === 'video' ? 'video' : 'audio', name: p.name };
        self._emit('incoming', {
          callId: key,
          from: { id: p.from && p.from.id != null ? String(p.from.id) : null, name: (p.from && p.from.name) || '' },
          media: p.callType === 'video' ? 'video' : 'audio',
          isGroup: true, groupId: key, groupName: p.name || null, members: []
        });
      });

      // Both sides of a 1:1 get this once the callee accepts → join the room.
      s.on('callAccepted', function (p) {
        p = p || {};
        var cid = p.callId != null ? String(p.callId) : '';
        // Match ANY callId minted for this dial — the callee may have accepted
        // an EARLIER redial/reassert id than the latest in _out; matching only
        // _out.callId dropped the accept (caller kept ringing while the callee
        // sat alone in the room). No cancelCall of sibling ids here: the relay
        // would surface as 'cancelled' on a callee still holding them.
        var mine = !!self._outIds[cid] || (self._out && self._out.callId === cid) || self._acceptedId === cid;
        if (!mine) return;
        self._out = null;
        self._outIds = {};
        self._acceptedId = null;
        self._clearRetry();
        self._media = p.callType === 'video' ? 'video' : 'audio';
        // Caller pre-joined this room during the ring → the media pipeline is
        // already up (or building). Promote it: bind the callId, un-pause the
        // producers (privacy hold ends at accept). The callee consumes our
        // existing producer the moment they join — no caller-side work left.
        var pre = self._room && self._room.preAnswer;
        if (pre && String(self._room.roomId) === String(p.roomId)
            && (!p.serverUrl || p.serverUrl === self._serverUrl)) {
          self._room.callId = String(p.callId);
          self._room.media = self._media;
          self._room.preAnswer = false;
          ['mic', 'camera'].forEach(function (k) {
            var pr = self._producers[k];
            if (pr && !pr.closed) {
              try { pr.resume(); } catch (e) {}
              // STATE-SYNC (not raw retry): this is the single message that
              // un-mutes the caller for the whole call — and a stale queued
              // pause must never be able to land after it.
              self._syncProducerState(pr).catch(function () {});
            }
          });
          self._log('accepted — pre-joined room promoted (media already warm)');
          return;
        }
        if (pre) {
          // Pre-joined a STALE room (redial re-minted / cluster moved the
          // room) — drop the warm-up and join the real one from scratch.
          self._teardownMedia(true);
        }
        self._room = { roomId: p.roomId, groupId: null, callId: String(p.callId), media: self._media, joined: false };
        self._startMedia(p.serverUrl).catch(function (e) {
          self._log('media start failed: ' + (e && e.message));
          self._emit('error', { message: 'Could not connect the call media' });
        });
      });

      s.on('callDeclined', function (p) {
        var cid = p && p.callId != null ? String(p.callId) : '';
        // A PRE-ANSWER room is only the ring-time warm-up — a decline must
        // still end the dial (and tear the warm-up down); only a LIVE room
        // shields against stale sibling-id declines.
        if (self._room && !self._room.preAnswer) return;
        if ((self._out && self._out.callId === cid) || self._outIds[cid]) {
          self._out = null;
          self._outIds = {};
          self._clearRetry();
          if (self._room && self._room.preAnswer) self._teardownMedia(true);
          self._emit('rejected', {});
        }
      });
      s.on('callCancelled', function (p) {
        var key = p && p.callId != null ? String(p.callId) : null;
        if (key && self._pendingIn[key]) { delete self._pendingIn[key]; self._emit('cancelled', {}); }
      });
      s.on('callEnded', function (p) {
        // callEnded on an UN-ANSWERED outgoing dial is not a user action — it's
        // the server's disconnect-grace sweep deleting the callee's stale
        // registration ALONG WITH our pending call (killed app whose old socket
        // expired mid-ring). Ending here cut the caller right when the callee
        // answered. Drop the dead id and keep re-dialing; the signaling ring
        // window bounds the loop.
        if ((!self._room || self._room.preAnswer) && !self._acceptedId && self._out && self._dialTarget) {
          var deadId = p && p.callId != null ? String(p.callId) : self._out.callId;
          delete self._outIds[deadId];
          self._out = null;
          self._lastDialAt = 0; // let the next tick redial immediately
          self._log('SFU call leg ' + deadId + ' ended pre-answer (grace sweep) — re-arming dial loop');
          // The pre-joined warm-up room (if any) stays up; the tick re-points
          // it when the redial mints a different roomId.
          self._armRetry(function () { return self._dial1to1Tick(self._dialTarget); });
          return;
        }
        // SCOPE to the current call (parity with the native SDK): the grace
        // sweep also ends STALE 1:1 records from dead sessions — an unscoped
        // handler let one of those kill a live (even GROUP) call.
        var cid2 = p && p.callId != null ? String(p.callId) : null;
        var mine2 = !!cid2 && (
          (self._room && self._room.callId === cid2)
          || self._acceptedId === cid2
          || !!self._outIds[cid2]
          || (self._out && self._out.callId === cid2)
        );
        if (!mine2) { self._log('callEnded ' + (cid2 || '?') + ' ignored (not current call)'); return; }
        self._onRemoteEnded();
      });
      s.on('groupCallEnded', function (p) {
        var gid = p && p.groupId != null ? String(p.groupId) : null;
        if (gid && self._pendingIn[gid]) { delete self._pendingIn[gid]; self._emit('cancelled', {}); return; }
        if (!self._room || !self._room.groupId || (gid && self._room.groupId !== gid)) {
          self._log('groupCallEnded ' + (gid || '?') + ' ignored (not current call)');
          return;
        }
        self._onRemoteEnded();
      });
      s.on('groupDeclined', function (p) {
        var uid = p && p.userId != null ? String(p.userId) : null;
        if (uid) self._groupJoined[uid] = true; // stop re-inviting them
        self._log('group invite declined by ' + uid);
      });
      s.on('groupParticipantJoined', function (p) {
        var u = p && p.user;
        if (u && u.id != null) self._groupJoined[String(u.id)] = true;
      });
      s.on('callPromotedToGroup', function (p) {
        if (self._room) { self._room.groupId = p && p.groupId != null ? String(p.groupId) : self._room.groupId; self._room.callId = null; }
      });

      s.on('newProducer', function (p) {
        if (self._room && self._room.joined) {
          self._consume(p).catch(function (e) { self._log('consume error: ' + (e && e.message)); });
        } else if (self._room) {
          // Both sides join the room simultaneously — the peer can produce while
          // WE are still building transports. Dropping the event here left the
          // call connected-but-SILENT (no remote audio, "awaaz nahi aa rahi").
          // Queue it; _joinRoom drains the queue the moment we are ready.
          self._log('newProducer queued (join in progress) from ' + (p && p.peerId));
          self._pendingProducers.push(p);
        }
      });
      s.on('peerLeft', function (p) {
        var pid = p && p.peerId != null ? String(p.peerId) : null;
        // Stale-room poison guard (parity with the native SDK): the server
        // broadcasts peerLeft into OLD rooms this socket never unsubscribed
        // from — only honor it for a live/pending room, never for our own id.
        if (!pid || pid === self.userId) return;
        if (!self._room) { self._log('peerLeft ' + pid + ' ignored (no room — stale)'); return; }
        // Room-scoped filter (parity with native SDK): a stale room's peerLeft
        // between the same two users carries the same peerId — only the
        // server-stamped roomId can tell it apart from the live call's.
        var evRoom = p && p.roomId != null ? String(p.roomId) : null;
        if (evRoom && String(self._room.roomId) !== evRoom) {
          self._log('peerLeft ' + pid + ' ignored (room ' + evRoom + ' != current ' + self._room.roomId + ')');
          return;
        }
        self._dropPeer(pid);
        self._emit('peerleft', { id: pid });
      });
      s.on('producerClosed', function (p) {
        var pid = p && p.producerId;
        if (!pid) return;
        delete self._consumed[pid];
        Object.keys(self._consumers).forEach(function (cid) {
          var c = self._consumers[cid];
          if (c && c.producerId === pid) {
            var peerId = (c.appData && c.appData.peerId) || (p.peerId != null ? String(p.peerId) : null);
            var streamKey = (c.appData && c.appData.streamKey) || peerId;
            var stream = streamKey ? self._peerStreams[streamKey] : null;
            if (stream) { try { stream.removeTrack(c.track); } catch (e) {} }
            try { c.close(); } catch (e) {}
            delete self._consumers[cid];
            // A closed screen producer removes the whole screen tile (a normal
            // camera/mic close just leaves its tile black/silent like before).
            if (streamKey && streamKey.indexOf('#screen') >= 0) {
              delete self._peerStreams[streamKey];
              self._emit('streamremoved', { peerId: peerId, source: 'screen' });
            }
          }
        });
      });
      s.on('consumerClosed', function (p) {
        var cid = p && p.consumerId;
        var c = cid ? self._consumers[cid] : null;
        if (c) {
          delete self._consumed[c.producerId];
          try { c.close(); } catch (e) {}
          delete self._consumers[cid];
        }
      });
      // Peer paused/resumed their CAMERA producer (camera off/on without
      // closing it — the tile would just freeze). Relay so the UI can swap the
      // tile for the avatar. Mic pauses filtered by kind, screens by streamKey.
      var peerVideoPause = function (p, paused) {
        var pid = p && p.producerId;
        if (!pid) return;
        Object.keys(self._consumers).forEach(function (cid) {
          var c = self._consumers[cid];
          if (c && c.producerId === pid && c.kind === 'video') {
            var peerId = (c.appData && c.appData.peerId != null) ? String(c.appData.peerId) : null;
            var streamKey = (c.appData && c.appData.streamKey) || peerId;
            if (streamKey && String(streamKey).indexOf('#screen') >= 0) return;
            self._emit('peervideo', { peerId: peerId, on: !paused });
          }
        });
      };
      s.on('producerPaused', function (p) { peerVideoPause(p, true); });
      s.on('producerResumed', function (p) { peerVideoPause(p, false); });
      s.on('activeSpeaker', function (p) {
        self._emit('activespeaker', { peerId: p && p.peerId != null ? String(p.peerId) : null });
      });
    };

    CallingSDK.prototype._onRemoteEnded = function () {
      if (!this._room && !this._acceptedId && !this._out) return;
      this._clearRetry();
      this._acceptedId = null;
      this._acceptedFrom = null;
      this._out = null;
      this._outIds = {};
      this._dialTarget = null;
      // leaveRoom even on a REMOTE end — the server keeps this socket's room
      // membership until leaveRoom/disconnect, and a stale membership makes the
      // NEXT call's joinRoom fail with "already in a room".
      this._teardownMedia(true);
      this._emit('ended', {});
    };

    // ---- outgoing ----
    CallingSDK.prototype.startCall = function (to, media) {
      var self = this;
      var targets = (Array.isArray(to) ? to : [to]).map(String).filter(Boolean);
      self._media = media === 'video' ? 'video' : 'audio';
      if (!targets.length) return Promise.reject(new Error('no callee'));
      self._outIds = {};        // fresh dial — never inherit a previous dial's ids
      self._acceptedFrom = null;
      return self._capture().then(function () {
        if (targets.length > 1) return self._startGroup(targets);
        return self._start1to1(targets[0]);
      });
    };

    CallingSDK.prototype._start1to1 = function (target) {
      var self = this;
      self._dialTarget = target;
      return self._reqDial('callUser', { toUserId: target, callType: self._media }).then(function (res) {
        var cid = String(res.callId);
        self._out = { callId: cid, roomId: res.roomId, to: target };
        self._outIds[cid] = true;
        self._lastDialAt = Date.now();
        // Ring REASSERT: a "successful" callUser is NOT proof the callee heard
        // it — during the server's reconnect grace a killed app's stale
        // registration accepts the call and incomingCall goes to a DEAD socket.
        // Keep re-dialing (the server reuses the same callId/roomId for a live
        // dial; the callee dedupes) until callAccepted / callDeclined / hangup /
        // ring-window end.
        self._armRetry(function () { return self._dial1to1Tick(target); });
        // Warm the media path WHILE the callee's phone rings: join the room,
        // build both transports and produce the mic PAUSED (no audio leaves
        // this device until the accept). On accept the callee finds our
        // producer in existingProducers and consumes instantly — the whole
        // caller-side join + send handshake is off the post-accept path.
        self._preJoinOut(res.roomId);
        return { callId: cid, offline: [] };
      }).catch(function (e) {
        var msg = String((e && e.message) || '').toLowerCase();
        if (msg.indexOf('offline') >= 0 || msg.indexOf('not found') >= 0) {
          // Callee not registered on the media server yet (app closed / engine
          // cold). The app-socket ring + FCM push wake them; keep REDIALING here
          // so the WebRTC leg exists the moment their engine registers. The ring
          // window / RN hangup bounds the loop.
          self._log('callee offline on media server — arming redial loop');
          self._armRetry(function () { return self._dial1to1Tick(target); });
          return { callId: null, offline: [target] };
        }
        if (msg.indexOf('busy') >= 0) return { callId: null, offline: [] };
        throw e;
      });
    };

    // One retry-loop tick for a 1:1 dial — REDIAL while the callee is offline
    // on the media server, then RE-ASSERT the ring every REASSERT_MS after a
    // success in case the last incomingCall hit a dead grace-period socket.
    CallingSDK.prototype._dial1to1Tick = function (target) {
      var self = this;
      // A PRE-ANSWER room is the ring-time warm-up, not a live call — the loop
      // must keep re-asserting through it.
      if ((self._room && !self._room.preAnswer) || self._acceptedId) return Promise.resolve(true);
      if (self._out && (Date.now() - self._lastDialAt) < REASSERT_MS) return Promise.resolve(false);
      return self._req('callUser', { toUserId: target, callType: self._media }).then(function (res) {
        // Answered while this request was in flight — never resurrect dial
        // state over a live call (the fresh id is harmless server-side).
        if ((self._room && !self._room.preAnswer) || self._acceptedId) return true;
        // HUNG UP while this dial was in flight (instant cancel): hangup() had
        // no minted id to cancel yet, so the fresh lobby record lived on — the
        // callee rang a DEAD call for the whole window and the record was
        // re-delivered if they reconnected within it. Cancel it NOW and stop.
        // A new dial to the SAME target falls through safely (the lobby
        // REASSERT-reuses this very record for it).
        if (!self._dialTarget || String(self._dialTarget) !== String(target)) {
          self._log('dial cancelled while in flight — cancelling minted id ' + String(res.callId));
          try { if (self._socket) self._socket.emit('cancelCall', { callId: String(res.callId) }); } catch (_) {}
          return true;
        }
        var cid = String(res.callId);
        var isReassert = !!self._out;
        self._out = { callId: cid, roomId: res.roomId, to: target };
        self._outIds[cid] = true;
        self._lastDialAt = Date.now();
        self._log((isReassert ? 'ring reassert' : 'redial') + ' ok — callId ' + cid);
        // Keep the warm-up aligned with the dial: first success pre-joins; a
        // NEW roomId (grace sweep deleted the record; this redial re-minted)
        // re-points the warm-up at the room the callee will actually accept.
        if (!self._room) self._preJoinOut(res.roomId);
        else if (self._room.preAnswer && String(self._room.roomId) !== String(res.roomId)) {
          self._teardownMedia(true);
          self._preJoinOut(res.roomId);
        }
        return false; // keep looping until answered/declined/window end
      }).catch(function () { return false; });
    };

    // Ring-time warm-up for an outgoing 1:1: join the room + build transports +
    // produce the mic PAUSED while the callee is still ringing. Privacy: nothing
    // is audible until callAccepted resumes the producer. Failure is non-fatal —
    // the accept path simply joins from scratch as before.
    CallingSDK.prototype._preJoinOut = function (roomId) {
      var self = this;
      if (!roomId || self._room || self._acceptedId) return;
      var room = { roomId: String(roomId), groupId: null, callId: null, media: self._media, joined: false, preAnswer: true };
      self._room = room;
      self._log('pre-joining room ' + roomId + ' during ring (caller warm-up)');
      self._startMedia(null).catch(function (e) {
        self._log('pre-join failed (' + (e && e.message) + ')');
        if (self._room !== room) return; // superseded by a re-pre-join / teardown
        if (room.preAnswer) {
          // Still ringing — drop the half-built pipeline; accept joins fresh.
          self._teardownMedia(true);
        } else if (!room.joined) {
          // Promoted (accepted) while this join was failing — rebuild for real.
          self._teardownMedia(true);
          self._room = { roomId: room.roomId, groupId: null, callId: room.callId, media: self._media, joined: false };
          self._startMedia(null).catch(function (e2) {
            self._log('media start failed: ' + (e2 && e2.message));
            self._emit('error', { message: 'Could not connect the call media' });
          });
        }
      });
    };

    CallingSDK.prototype._startGroup = function (targets) {
      var self = this;
      return self._reqDial('startGroupCall', { callType: self._media, inviteeIds: targets }).then(function (res) {
        var gid = String(res.groupId);
        self._room = { roomId: res.roomId, groupId: gid, callId: null, media: self._media, joined: false };
        self._groupInvitees = targets.slice();
        self._groupJoined = {};
        // Re-invite members who have not joined/declined yet — an invitee woken
        // by the push registers on the media server AFTER the original invite
        // was sent, and the server does not re-deliver it on its own.
        self._armRetry(function () { return self._reinviteGroup(gid); });
        // Host joins the room right away; media errors surface as 'error'.
        self._startMedia(res.serverUrl).catch(function (e) {
          self._log('group media start failed: ' + (e && e.message));
          self._emit('error', { message: 'Could not connect the call media' });
        });
        return { callId: gid, offline: [] };
      });
    };

    CallingSDK.prototype._reinviteGroup = function (gid) {
      var self = this;
      if (!self._room || self._room.groupId !== gid) return Promise.resolve(true);
      var missing = (self._groupInvitees || []).filter(function (id) { return !self._groupJoined[id]; });
      if (!missing.length) return Promise.resolve(true);
      return self._req('inviteToGroupCall', { groupId: gid, inviteeIds: missing })
        .then(function () { return false; })
        .catch(function () { return false; });
    };

    CallingSDK.prototype._armRetry = function (fn) {
      var self = this;
      self._clearRetry();
      self._retryUntil = Date.now() + RETRY_WINDOW_MS;
      self._retryTimer = setInterval(function () {
        if (Date.now() > self._retryUntil) { self._clearRetry(); return; }
        Promise.resolve().then(fn).then(function (done) { if (done) self._clearRetry(); }).catch(function () {});
      }, RETRY_MS);
    };
    CallingSDK.prototype._clearRetry = function () {
      if (this._retryTimer) { clearInterval(this._retryTimer); this._retryTimer = null; }
    };

    // Ring MORE members into the live group call (Add participant). They get
    // incomingGroupCall like any invitee; the re-invite loop covers members
    // whose engine registers late (push-woken app).
    CallingSDK.prototype.inviteToGroup = function (ids) {
      var self = this;
      var list = (ids || []).map(String).filter(Boolean);
      if (!list.length) return Promise.resolve();
      if (!self._room || !self._room.groupId) return Promise.reject(new Error('not in a group call'));
      var gid = self._room.groupId;
      list.forEach(function (id) {
        if (self._groupInvitees.indexOf(id) < 0) self._groupInvitees.push(id);
        delete self._groupJoined[id]; // re-invite even someone who declined earlier
      });
      self._armRetry(function () { return self._reinviteGroup(gid); });
      self._log('inviting ' + list.length + ' more member(s) into group ' + gid);
      return self._req('inviteToGroupCall', { groupId: gid, inviteeIds: list });
    };

    // Stop re-inviting ONE member (declined over the app signal / ring window
    // closed for them). Marks them resolved so _reinviteGroup skips them.
    CallingSDK.prototype.stopInviting = function (id) {
      if (id != null) this._groupJoined[String(id)] = true;
    };

    // acceptCall with bounded retries. The user's ANSWER must not die with one
    // lost frame on a flapping socket (field repro: engine registered + got the
    // ring, but the single-shot acceptCall never reached the lobby → both sides
    // stuck "Connecting…" until the watchdog). acceptCall is idempotent
    // server-side; retries stop the moment the call is answered (callAccepted
    // set _room) or torn down.
    CallingSDK.prototype._acceptWithRetry = function (callId) {
      var self = this;
      var attempt = function (n) {
        return self._reqDial('acceptCall', { callId: callId }).catch(function (e) {
          if (n >= 2) throw e;
          if (!self._acceptedId || self._room) throw e; // ended, or already answered meanwhile
          self._log('acceptCall attempt ' + (n + 1) + ' failed (' + (e && e.message) + ') — retrying');
          return new Promise(function (r) { setTimeout(r, 800 * (n + 1)); }).then(function () {
            if (!self._acceptedId || self._room) return {}; // resolved while we waited
            return attempt(n + 1);
          });
        });
      };
      return attempt(0);
    };

    // ---- incoming ----
    CallingSDK.prototype.accept = function (callId, media, opts) {
      var self = this;
      opts = opts || {};
      var key = String(callId);
      var p = self._pendingIn[key];
      if (!p) {
        // No pending entry. A KNOWN 1:1 (the app reconciled the real callId but
        // this SDK instance lost/never had the ring — engine restart mid-ring,
        // or the ring hit a dead grace socket) is accepted DIRECTLY: acceptCall
        // only needs the callId. Falling into joinGroupCall with a 1:1 id made
        // the call cut the instant the user accepted.
        if (opts.isGroup === false) {
          self._log('accept: no pending entry for 1:1 ' + key + ' — accepting directly');
          self._media = media === 'video' ? 'video' : 'audio';
          self._acceptedFrom = opts.peerId != null ? String(opts.peerId) : null;
          self._acceptedId = key;
          // Capture runs CONCURRENTLY with acceptCall — getUserMedia (up to
          // seconds on a cold mic) used to sit between the user's tap and the
          // caller even LEARNING the call was answered. _capture is memoized,
          // so the join pipeline reuses this same attempt.
          return Promise.all([
            self._capture(),
            self._acceptWithRetry(key)
          ]).then(function (r) { return r[1]; });
        }
        // Group ids are joinable directly; a stale id fails at the server and
        // surfaces as a clean accept error.
        self._log('accept: no pending entry for ' + key + ' — trying joinGroupCall directly');
        delete self._declined[key];
        self._media = media === 'video' ? 'video' : self._media;
        self._capture(); // kick off now; _startMedia awaits the memoized attempt
        return self._reqDial('joinGroupCall', { groupId: key }).then(function (res) {
          self._media = res.callType === 'video' ? 'video' : self._media;
          self._room = { roomId: res.roomId, groupId: key, callId: null, media: self._media, joined: false };
          self._groupInvitees = [];
          self._groupJoined = {};
          return self._startMedia(res.serverUrl);
        });
      }
      self._media = p.media === 'video' ? 'video' : 'audio';
      delete self._pendingIn[key];
      if (p.group) {
        self._capture(); // concurrent with the join round trip
        return self._reqDial('joinGroupCall', { groupId: p.groupId }).then(function (res) {
          self._media = res.callType === 'video' ? 'video' : self._media;
          self._room = { roomId: res.roomId, groupId: String(p.groupId), callId: null, media: self._media, joined: false };
          self._groupInvitees = [];
          self._groupJoined = {};
          return self._startMedia(res.serverUrl);
        });
      }
      // 1:1 — the server answers with callAccepted (to both sides), which
      // carries roomId + serverUrl; media starts in that handler.
      self._acceptedFrom = p.from && p.from.id != null ? String(p.from.id) : (opts.peerId != null ? String(opts.peerId) : null);
      // Drop sibling reassert entries from the same caller quietly (same
      // logical call, different minted ids) — a later hangup must not decline
      // them, which the caller would read as a rejection.
      if (self._acceptedFrom) {
        Object.keys(self._pendingIn).forEach(function (k) {
          var q = self._pendingIn[k];
          if (q && !q.group && q.from && String(q.from.id) === self._acceptedFrom) delete self._pendingIn[k];
        });
      }
      self._acceptedId = key;
      // acceptCall goes out IMMEDIATELY; capture (the slow part) overlaps it.
      return Promise.all([
        self._capture(),
        self._acceptWithRetry(key)
      ]).then(function (r) { return r[1]; });
    };

    CallingSDK.prototype.reject = function (callId) {
      var key = String(callId);
      var p = this._pendingIn[key];
      delete this._pendingIn[key];
      // Remember the declined peer so their ring reasserts (fresh callIds) are
      // quietly declined instead of ghost-re-ringing.
      if (p && !p.group && p.from && p.from.id != null) this._declinedPeer[String(p.from.id)] = Date.now();
      try {
        if (p && p.group) { this._declined[key] = Date.now(); this._socket && this._socket.emit('declineGroupCall', { groupId: p.groupId }); }
        else this._socket && this._socket.emit('declineCall', { callId: key });
      } catch (e) {}
    };

    // ---- teardown ----
    CallingSDK.prototype.hangup = function () {
      var self = this;
      self._clearRetry();
      // Decline anything still pending — covers an RN reject that never knew the
      // media-server callId (app-socket-only ring).
      Object.keys(self._pendingIn).forEach(function (key) {
        var p = self._pendingIn[key];
        try {
          if (p.group) { self._declined[key] = Date.now(); self._socket && self._socket.emit('declineGroupCall', { groupId: p.groupId }); }
          else self._socket && self._socket.emit('declineCall', { callId: key });
        } catch (e) {}
      });
      self._pendingIn = {};
      try {
        if (self._room && self._room.groupId) self._socket && self._socket.emit('leaveGroupCall', { groupId: self._room.groupId });
        else if (self._room && self._room.callId) self._socket && self._socket.emit('endCall', { callId: self._room.callId });
        else if (self._acceptedId) {
          self._socket && self._socket.emit('endCall', { callId: self._acceptedId });
          // Hangup in the answered-but-not-joined window: the caller's dial
          // loop may re-ring on the pre-answer callEnded — quietly decline
          // those reasserts instead of ghost-re-ringing.
          if (self._acceptedFrom) self._declinedPeer[self._acceptedFrom] = Date.now();
        }
        else {
          // Cancel EVERY id minted for this dial (redials + reasserts), not
          // just the latest — stale server entries otherwise ring/linger.
          var outIds = Object.keys(self._outIds);
          if (self._out && outIds.indexOf(self._out.callId) < 0) outIds.push(self._out.callId);
          outIds.forEach(function (cid) { try { self._socket && self._socket.emit('cancelCall', { callId: cid }); } catch (e) {} });
        }
      } catch (e) {}
      self._acceptedId = null;
      self._acceptedFrom = null;
      self._out = null;
      self._outIds = {};
      self._dialTarget = null;
      self._teardownMedia(true);
    };

    CallingSDK.prototype.disconnect = function () {
      this._clearRetry();
      this._acceptedId = null;
      this._acceptedFrom = null;
      this._out = null;
      this._outIds = {};
      this._dialTarget = null;
      this._teardownMedia(false);
      if (this._socket) { try { this._socket.removeAllListeners(); this._socket.disconnect(); } catch (e) {} }
      this._socket = null;
      this._registered = false;
    };

    CallingSDK.prototype._teardownMedia = function (leaveRoom) {
      var self = this;
      self._clearRecovery();
      // Drop any pending ICE-disconnected debounce timers (transports are
      // about to close; a late fire would emitDown on a dead call).
      if (self._softDown) {
        for (var sdk in self._softDown) { try { clearTimeout(self._softDown[sdk]); } catch (e) {} }
        self._softDown = {};
      }
      // Invalidate any in-flight getUserMedia so its late stream can't become
      // a leaked _localStream after this teardown.
      self._capGen = (self._capGen || 0) + 1;
      self._capturing = null;
      self._producingLocal = false;
      // leaveRoom whenever a room EXISTS, not only when "joined" flipped — a
      // teardown racing an in-flight joinRoom otherwise leaves a ghost peer in
      // the room server-side (socket.io orders the frames, so the server sees
      // join → leave cleanly; leaveRoom on a never-joined socket is a no-op).
      try { if (leaveRoom && self._socket && self._room) self._socket.emit('leaveRoom'); } catch (e) {}
      Object.keys(self._producers).forEach(function (k) { try { self._producers[k].close(); } catch (e) {} });
      self._producers = {};
      Object.keys(self._consumers).forEach(function (k) { try { self._consumers[k].close(); } catch (e) {} });
      self._consumers = {};
      self._consumed = {};
      self._peerStreams = {};
      try { self._sendTransport && self._sendTransport.close(); } catch (e) {}
      try { self._recvTransport && self._recvTransport.close(); } catch (e) {}
      self._sendTransport = self._recvTransport = null;
      self._device = null;
      if (self._localStream) { try { self._localStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} }
      self._localStream = null;
      if (self._screenStream) { try { self._screenStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} }
      self._screenStream = null;
      self._room = null;
      self._pendingProducers = [];
      self._mediaDown = false;
      self._groupInvitees = [];
      self._groupJoined = {};
    };

    // ---- local media ----
    // Capture is NEVER allowed to fail the call. On a LOCKED iPhone the app is
    // woken in the BACKGROUND by a CallKit answer, and WKWebView refuses/hangs
    // getUserMedia until CallKit's audio session is fully active (or the user
    // unlocks). A single failed attempt used to reject accept() → RN got
    // 'Could not connect the call media' → the just-answered call was torn down
    // ("accept karte hi cut"); a HANGING attempt kept the CallKit timer running
    // with the room never joined ("duration but no call"). Instead: a few quick
    // retries, video→audio-only fallback, then PROCEED WITHOUT local media —
    // the room joins, the remote audio plays (playback works backgrounded),
    // and ensureLocalAudio() produces the mic the moment capture recovers.
    CallingSDK.prototype._capture = function () {
      var self = this;
      if (self._localStream && self._localStream.active) return Promise.resolve(self._localStream);
      // In-flight memo: accept()/startMedia now run capture CONCURRENTLY with
      // signalling, so a second caller must share the same getUserMedia attempt
      // (two parallel captures = two mic handles, one leaked).
      if (self._capturing) return self._capturing;
      // Generation guard: a hangup during a slow capture must not let the late
      // stream resurrect itself as _localStream (leaked mic after teardown).
      var gen = self._capGen || 0;
      var wantVideo = self._media === 'video';
      var attempt = function (constraints) {
        return navigator.mediaDevices.getUserMedia(constraints);
      };
      var tryOnce = function () {
        if (!wantVideo) return attempt({ audio: AUDIO_CONS, video: false });
        // Some cameras/WebViews reject a facingMode constraint outright
        // (NotFound/Overconstrained) even though a camera exists — retry plain,
        // then fall back to audio-only (a video call can upgrade later).
        return attempt({ audio: AUDIO_CONS, video: { facingMode: self._facing } })
          .catch(function (e) {
            self._log('getUserMedia facingMode failed (' + (e && e.name) + ') — retrying without constraint');
            return attempt({ audio: AUDIO_CONS, video: true });
          })
          .catch(function (e) {
            self._log('getUserMedia video failed (' + (e && e.name) + ') — falling back to audio-only');
            return attempt({ audio: AUDIO_CONS, video: false });
          });
      };
      var attemptsLeft = 3;
      var run = function () {
        return tryOnce().catch(function (e) {
          attemptsLeft -= 1;
          if (attemptsLeft <= 0) throw e;
          self._log('getUserMedia failed (' + (e && e.name) + ') — retrying (' + attemptsLeft + ' left)');
          return new Promise(function (res) { setTimeout(res, 1200); }).then(run);
        });
      };
      self._capturing = run().then(function (stream) {
        self._capturing = null;
        if ((self._capGen || 0) !== gen) {
          try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
          throw new Error('capture aborted (call torn down)');
        }
        self._localStream = stream;
        self._emit('localstream', stream);
        return stream;
      }).catch(function (e) {
        self._capturing = null;
        if ((self._capGen || 0) !== gen) throw e;
        self._log('getUserMedia gave up (' + (e && e.name) + ') — continuing WITHOUT local media (locked/background capture)');
        self._localStream = new MediaStream();
        self._emit('localstream', self._localStream);
        return self._localStream;
      });
      return self._capturing;
    };

    // Produce the outbound mic LATE — for a call that had to join without local
    // media (locked-phone answer) or lost its producer. Re-tried by the glue
    // watchdog + restartAudio until capture succeeds. Idempotent & re-entrant.
    CallingSDK.prototype.ensureLocalAudio = function () {
      var self = this;
      if (self._ensuringAudio) return Promise.resolve(false);
      if (!self._room || !self._room.joined || !self._sendTransport) return Promise.resolve(false);
      if (self._producers.mic) return Promise.resolve(false);
      // The join pipeline's own capture→produce is still in flight — let it
      // finish rather than racing it into a duplicate mic producer. Watchdog
      // callers retry, so a genuinely failed capture is still recovered here.
      if (self._capturing || self._producingLocal) return Promise.resolve(false);
      var liveTrack = null;
      try {
        (self._localStream ? self._localStream.getAudioTracks() : []).forEach(function (t) {
          if (t.readyState === 'live') liveTrack = t;
        });
      } catch (e) {}
      self._ensuringAudio = true;
      var get = liveTrack
        ? Promise.resolve(liveTrack)
        : navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONS }).then(function (s) {
          var t = (s.getAudioTracks() || [])[0];
          if (!self._localStream) self._localStream = new MediaStream();
          try {
            (self._localStream.getAudioTracks() || []).forEach(function (old) {
              try { old.stop(); } catch (e) {}
              try { self._localStream.removeTrack(old); } catch (e) {}
            });
            if (t) self._localStream.addTrack(t);
          } catch (e) {}
          return t;
        });
      return get.then(function (track) {
        if (!track) throw new Error('no audio track');
        return self._produceMic(track)
          .then(function (pr) {
            self._producers.mic = pr;
            self._log('mic produced (late capture recovery)');
            return true;
          });
      }).catch(function (e) {
        self._log('ensureLocalAudio failed: ' + ((e && e.name) || (e && e.message) || 'error'));
        return false;
      }).then(function (ok) { self._ensuringAudio = false; return ok; });
    };

    // ---- mediasoup room pipeline ----
    CallingSDK.prototype._startMedia = function (serverUrl) {
      var self = this;
      var pre = Promise.resolve();
      if (serverUrl && serverUrl !== self._serverUrl) pre = self._migrate(serverUrl);
      return pre.then(function () {
        // Kick capture but DON'T serialize the room join behind it — the join
        // handshake (several round trips + ICE/DTLS) runs while getUserMedia
        // warms up; _produceLocal awaits the memoized capture when it needs
        // the tracks (only a teardown-abort can reject — swallowed here).
        self._capture().catch(function () {});
        return self._joinRoom();
      });
    };

    CallingSDK.prototype._joinRoom = function () {
      var self = this;
      var room = self._room;
      if (!room) return Promise.reject(new Error('no room'));
      var joinRes = null;
      // Defensive: drop any stale server-side room membership (a missed cleanup
      // path would otherwise brick every future joinRoom). Idempotent no-op when
      // not in a room.
      try { self._socket && self._socket.emit('leaveRoom'); } catch (e) {}
      return self._req('joinRoom', { roomId: room.roomId, name: self.name, sessionId: self.userId, token: self._token || undefined }).then(function (res) {
        joinRes = res || {};
        self._device = new window.mediasoupClient.Device();
        return self._device.load({ routerRtpCapabilities: joinRes.rtpCapabilities });
      }).then(function () {
        // These three server round trips are independent of each other — batch
        // them instead of paying three sequential RTTs on the connect path.
        return Promise.all([
          self._req('setRtpCapabilities', { rtpCapabilities: self._device.rtpCapabilities }),
          self._req('createWebRtcTransport', { direction: 'send' }),
          self._req('createWebRtcTransport', { direction: 'recv' })
        ]);
      }).then(function (all) {
        // Torn down (hangup/remote end) while the join round trips were in
        // flight — building transports / re-capturing on the dead state would
        // leak a mic and mark a stale room joined.
        if (self._room !== room) throw new Error('call torn down during join');
        var sp = all[1];
        var rp = all[2];
        // Server-provided iceServers win; the app-supplied fallback fills in
        // when the media server sends none (STUN/TURN for cross-NAT relay).
        var ice = (joinRes.iceServers && joinRes.iceServers.length) ? joinRes.iceServers : (self._fallbackIceServers || []);
        self._sendTransport = self._device.createSendTransport(Object.assign({}, sp, { iceServers: ice }));
        self._wireTransport(self._sendTransport);
        self._recvTransport = self._device.createRecvTransport(Object.assign({}, rp, { iceServers: ice }));
        self._wireTransport(self._recvTransport);
        room.joined = true;
        // Consume everything: producers that existed at join time PLUS any
        // newProducer events that raced our transport setup (queued above).
        var queued = self._pendingProducers;
        self._pendingProducers = [];
        var list = (joinRes.existingProducers || []).concat(queued);
        self._log('room joined — producing + consuming ' + list.length + ' (existing+queued)');
        // All consumes fire CONCURRENTLY (each is an independent consume +
        // resumeConsumer pair; mediasoup-client serializes what it must
        // internally) — the old serial chain made every extra producer add a
        // full round trip before the first audio could flow.
        var consumeAll = Promise.all(list.map(function (p) {
          return self._consume(p).catch(function (e) { self._log('consume failed: ' + (e && e.message)); });
        }));
        // Produce (send-side ICE/DTLS) and consume (recv-side ICE/DTLS) in
        // PARALLEL — serializing them stacked the two handshakes back to back,
        // which was most of the "Connecting…" wait after an answer. Local
        // produce first awaits the (memoized) capture for its tracks.
        self._producingLocal = true;
        var produceAll = self._capture()
          .then(function () { return self._produceLocal(); })
          .then(function (v) { self._producingLocal = false; return v; },
            function (e) { self._producingLocal = false; throw e; });
        return Promise.all([produceAll, consumeAll]);
      });
    };

    CallingSDK.prototype._wireTransport = function (t) {
      var self = this;
      t.on('connect', function (args, cb, eb) {
        self._req('connectTransport', { transportId: t.id, dtlsParameters: args.dtlsParameters }).then(cb).catch(eb);
      });
      if (t.direction === 'send') {
        t.on('produce', function (args, cb, eb) {
          self._req('produce', { transportId: t.id, kind: args.kind, rtpParameters: args.rtpParameters, appData: args.appData })
            .then(function (r) { cb({ id: r.id }); }).catch(eb);
        });
      }
      t.on('connectionstatechange', function (state) {
        self._log('transport ' + t.direction + ' → ' + state);
        if (!self._softDown) self._softDown = {};
        if (state === 'failed') {
          // Hard failure — react immediately.
          if (self._softDown[t.id]) { clearTimeout(self._softDown[t.id]); delete self._softDown[t.id]; }
          self._emitDown('ice:' + state);
          if (self._socket && self._socket.connected) self._restartIceOn(t);
        } else if (state === 'disconnected') {
          // SOFT state: ICE 'disconnected' frequently self-recovers in 1-2s on
          // a radio blip. Reacting instantly flashed "Reconnecting…" and fired
          // a needless ICE restart (renegotiation churn) on every blip. Only
          // treat it as down if it PERSISTS past a short debounce; 'failed'
          // above stays immediate.
          if (self._softDown[t.id]) return;
          self._softDown[t.id] = setTimeout(function () {
            delete self._softDown[t.id];
            if (!self._room) return; // torn down while we waited
            var st = t.connectionState;
            if (st === 'disconnected' || st === 'failed') {
              self._emitDown('ice:disconnected');
              if (self._socket && self._socket.connected) self._restartIceOn(t);
            }
          }, 2500);
        } else if (state === 'connected') {
          if (self._softDown[t.id]) { clearTimeout(self._softDown[t.id]); delete self._softDown[t.id]; }
          self._emitUp('ice:connected');
        }
      });
    };

    // Producers created during a PRE-ANSWER warm-up start PAUSED — nothing is
    // audible/visible to anyone until callAccepted promotes the room and
    // resumes them. (A consumer of a paused producer receives silence, so even
    // a client that joined the room early hears nothing.)
    CallingSDK.prototype._pauseIfPreAnswer = function (pr) {
      var self = this;
      if (self._room && self._room.preAnswer && pr && !pr.closed) {
        try { pr.pause(); } catch (e) {}
        // State-sync: retries re-read pr.paused, so a slow pause attempt can
        // NEVER land after the promote resume and mute the call forever.
        self._syncProducerState(pr).catch(function () {});
      }
    };

    CallingSDK.prototype._produceLocal = function () {
      var self = this;
      var chain = Promise.resolve();
      var audio = self._localStream ? self._localStream.getAudioTracks()[0] : null;
      if (audio && !self._producers.mic) {
        chain = chain.then(function () {
          return self._produceMic(audio)
            .then(function (pr) { self._producers.mic = pr; self._pauseIfPreAnswer(pr); });
        });
      }
      if (self._media === 'video') {
        var video = self._localStream ? self._localStream.getVideoTracks()[0] : null;
        if (video && !self._producers.camera) {
          chain = chain.then(function () {
            var codecs = (self._device.rtpCapabilities && self._device.rtpCapabilities.codecs) || [];
            var vp8 = null;
            for (var i = 0; i < codecs.length; i++) {
              if (String(codecs[i].mimeType).toLowerCase() === 'video/vp8') { vp8 = codecs[i]; break; }
            }
            var opts = { track: video, encodings: CAM_ENCODINGS, codecOptions: { videoGoogleStartBitrate: 1000 }, appData: { source: 'camera' } };
            if (vp8) opts.codec = vp8;
            return self._sendTransport.produce(opts).then(function (pr) { self._producers.camera = pr; self._pauseIfPreAnswer(pr); });
          });
        }
      }
      return chain;
    };

    CallingSDK.prototype._consume = function (p) {
      var self = this;
      var producerId = p && p.producerId;
      var peerId = p && p.peerId != null ? String(p.peerId) : 'peer';
      // A peer's screen goes into its OWN stream/tile (key peerId#screen) so it
      // shows alongside their camera instead of replacing it.
      var source = (p && p.source) || (p && p.appData && p.appData.source) || null;
      var isScreen = source === 'screen';
      var streamKey = isScreen ? (peerId + '#screen') : peerId;
      if (!producerId || self._consumed[producerId]) return Promise.resolve();
      if (!self._recvTransport || !self._device) return Promise.resolve();
      self._consumed[producerId] = true;
      var consumedPaused = false; // producer already paused when we consumed (camera was off)
      return self._req('consume', {
        transportId: self._recvTransport.id, producerId: producerId, rtpCapabilities: self._device.rtpCapabilities
      }).then(function (params) {
        consumedPaused = !!params.producerPaused;
        return self._recvTransport.consume({ id: params.id, producerId: params.producerId, kind: params.kind, rtpParameters: params.rtpParameters });
      }).then(function (consumer) {
        self._consumers[consumer.id] = consumer;
        consumer.appData = consumer.appData || {};
        consumer.appData.peerId = peerId;
        consumer.appData.streamKey = streamKey;
        var stream = self._peerStreams[streamKey];
        if (!stream) { stream = new MediaStream(); self._peerStreams[streamKey] = stream; }
        // Replace any older track of the same kind (camera re-produce etc.).
        stream.getTracks().forEach(function (t) {
          if (t.kind === consumer.track.kind && t !== consumer.track) { try { stream.removeTrack(t); } catch (e) {} }
        });
        stream.addTrack(consumer.track);
        // RETRY-SAFE: a lost resumeConsumer left this stream server-paused —
        // the call looked connected but this direction stayed silent forever.
        return self._reqRetry('resumeConsumer', { consumerId: consumer.id }).then(function () {
          self._groupJoined[peerId] = true;
          self._log('consuming ' + consumer.track.kind + (isScreen ? ' (screen)' : '') + ' from ' + peerId);
          // Peer's camera was ALREADY off when we consumed — no producerPaused
          // event will come, so seed the state from the consume response.
          if (consumer.kind === 'video' && !isScreen && consumedPaused) {
            self._emit('peervideo', { peerId: peerId, on: false });
          }
          self._emit('stream', { peerId: peerId, stream: stream, source: source });
        });
      }).catch(function (e) {
        delete self._consumed[producerId];
        throw e;
      });
    };

    CallingSDK.prototype._dropPeer = function (peerId) {
      var self = this;
      Object.keys(self._consumers).forEach(function (cid) {
        var c = self._consumers[cid];
        if (c && c.appData && c.appData.peerId === peerId) {
          delete self._consumed[c.producerId];
          try { c.close(); } catch (e) {}
          delete self._consumers[cid];
        }
      });
      delete self._peerStreams[peerId];
      delete self._peerStreams[peerId + '#screen'];
    };

    // ---- reconnection / network resilience ----
    CallingSDK.prototype._emitDown = function (why) {
      if (this._mediaDown) return;
      this._mediaDown = true;
      this._log('media DOWN (' + why + ')');
      // Keep RETRYING the recovery, not just the single restartIce fired by
      // the state-change handler: a mid-call NAT rebind / network flap often
      // needs a second or third ICE restart once the path settles — one failed
      // attempt used to leave the call stuck on "Reconnecting…" until the
      // watchdog cut it.
      this._armRecovery();
      this._emit('disconnected', { reason: why });
    };
    CallingSDK.prototype._emitUp = function (why) {
      if (!this._mediaDown) return;
      this._mediaDown = false;
      this._clearRecovery();
      this._log('media UP (' + why + ')');
      // The break may have eaten in-flight pause/resume commands (mute state,
      // promote un-mute, consumer resume) — re-assert from local truth so a
      // recovered call never comes back half-silent.
      if (why !== 'rejoin') this._reassertMediaState();
      this._emit('connected', { reason: why });
    };

    CallingSDK.prototype._armRecovery = function () {
      var self = this;
      self._clearRecovery();
      self._recoverUntil = Date.now() + 30000; // RN watchdog owns the final verdict
      var downSince = Date.now();
      var escalated = false;
      self._recoverTimer = setInterval(function () {
        if (!self._mediaDown || !self._room || Date.now() > self._recoverUntil) {
          self._clearRecovery();
          return;
        }
        if (self._socket && self._socket.connected) {
          // ESCALATION: ~12s of failed ICE restarts on a LIVE socket means the
          // transports themselves are wedged (NAT gave our ports away, DTLS
          // stuck) — restartIce alone will never heal that. Rebuild the media
          // pipeline in place: fresh transports on the same room reconnect in
          // ~1s instead of the call dying at the watchdog.
          if (!escalated && Date.now() - downSince > 12000) {
            escalated = true;
            self._log('recovery escalation — full media rebuild');
            self._rebuildMedia().catch(function (e) { self._log('rebuild failed: ' + (e && e.message)); });
            return;
          }
          self._log('media recovery tick — restarting ICE');
          self.restartIce();
        }
        // Socket down → socket.io's reconnect + the 'connect' handler's
        // _resume() own the recovery; this loop resumes once it's back.
      }, 3000);
    };

    CallingSDK.prototype._clearRecovery = function () {
      if (this._recoverTimer) { clearInterval(this._recoverTimer); this._recoverTimer = null; }
    };

    CallingSDK.prototype._resume = function () {
      var self = this;
      var room = self._room;
      if (!room) return;
      self._req('joinRoom', { roomId: room.roomId, name: self.name, sessionId: self.userId, resume: true, token: self._token || undefined }).then(function (res) {
        if (res && res.resumed) {
          self.restartIce();
          // Heal any pause/resume command the dying socket ate mid-flap.
          self._reassertMediaState();
          (res.existingProducers || []).forEach(function (p) { self._consume(p).catch(function () {}); });
          self._emitUp('resume');
          self._log('call resumed after reconnect');
          return null;
        }
        // Grace expired server-side — rebuild the media pipeline from scratch on
        // the same room (fresh transports + producers), like a page-refresh rejoin.
        self._log('resume not available — rebuilding media pipeline');
        return self._rebuildMedia();
      }).catch(function (e) {
        self._log('resume failed: ' + (e && e.message));
        // Leave the reconnecting state up; the next socket reconnect retries, and
        // RN's reconnect watchdog bounds the wait.
      });
    };

    // Tear the transports/producers/consumers down and re-join the SAME room
    // fresh. Used when a resume isn't possible (server grace expired) AND as
    // the mid-call self-heal escalation: ICE restarts that keep failing mean
    // the transports themselves are wedged — a fresh join re-negotiates
    // everything in ~1s (WhatsApp-style recover-in-place, not drop-the-call).
    CallingSDK.prototype._rebuildMedia = function () {
      var self = this;
      var room = self._room;
      if (!room) return Promise.resolve();
      Object.keys(self._producers).forEach(function (k) { try { self._producers[k].close(); } catch (e) {} });
      self._producers = {};
      Object.keys(self._consumers).forEach(function (k) { try { self._consumers[k].close(); } catch (e) {} });
      self._consumers = {};
      self._consumed = {};
      self._peerStreams = {};
      try { self._sendTransport && self._sendTransport.close(); } catch (e) {}
      try { self._recvTransport && self._recvTransport.close(); } catch (e) {}
      self._sendTransport = self._recvTransport = null;
      self._device = null;
      room.joined = false;
      return self._joinRoom().then(function () {
        if (self._room !== room) return; // torn down while rebuilding
        self._emitUp('rejoin');
        self._log('call rejoined after rebuild');
      });
    };

    CallingSDK.prototype.restartIce = function () {
      var self = this;
      [self._sendTransport, self._recvTransport].forEach(function (t) { if (t) self._restartIceOn(t); });
    };
    CallingSDK.prototype._restartIceOn = function (t) {
      var self = this;
      self._req('restartIce', { transportId: t.id }).then(function (r) {
        return t.restartIce({ iceParameters: r.iceParameters });
      }).then(function () {
        self._log('ICE restarted ' + t.direction);
      }).catch(function (e) {
        self._log('ICE restart failed ' + t.direction + ': ' + (e && e.message));
      });
    };

    // ---- in-call controls ----
    CallingSDK.prototype.toggleMic = function (on) {
      var p = this._producers.mic;
      if (!p) return;
      // Local state first, then CONVERGENT sync (a lost/late request can
      // never leave the server in the opposite mute state).
      if (on) { try { p.resume(); } catch (e) {} } else { try { p.pause(); } catch (e) {} }
      this._syncProducerState(p).catch(function () {});
    };

    CallingSDK.prototype.toggleCamera = function (on) {
      var self = this;
      var p = self._producers.camera;
      if (!p) {
        // Camera ON during an AUDIO call = WhatsApp-style upgrade to video:
        // capture the camera now and produce it into the live room. While the
        // join pipeline's own capture→produce is still in flight, let it land
        // first (it produces the camera for a video call itself — racing it
        // here made a duplicate camera producer).
        if (on && self._room && self._room.joined && self._sendTransport
            && !self._capturing && !self._producingLocal) {
          self._upgradeToVideo().catch(function (e) {
            self._log('video upgrade failed: ' + (e && e.message));
            self._emit('mediaupgradefailed', { message: (e && e.message) || 'Could not start the camera' });
          });
        }
        return;
      }
      // Local state first, then CONVERGENT sync (see toggleMic).
      if (on) { try { p.resume(); } catch (e) {} } else { try { p.pause(); } catch (e) {} }
      self._syncProducerState(p).catch(function () {});
    };

    // Mid-call AUDIO → VIDEO upgrade: capture the camera, add it to the local
    // stream (the self-preview <video> element updates live) and produce it.
    CallingSDK.prototype._upgradeToVideo = function () {
      var self = this;
      if (self._producers.camera) return Promise.resolve();
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: self._facing } })
        .catch(function (e) {
          self._log('upgrade facingMode capture failed (' + (e && e.name) + ') — retrying without constraint');
          return navigator.mediaDevices.getUserMedia({ video: true });
        })
        .then(function (stream) {
          var track = stream.getVideoTracks()[0];
          if (!track) {
            try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
            throw new Error('No camera track');
          }
          if (self._localStream) {
            try { self._localStream.addTrack(track); } catch (e) {}
          } else {
            self._localStream = stream;
          }
          self._media = 'video';
          if (self._room) self._room.media = 'video';
          return self._produceLocal().then(function () {
            self._log('call upgraded to video (camera producing)');
            self._emit('mediaupgraded', { media: 'video' });
          });
        });
    };

    CallingSDK.prototype.switchCamera = function () {
      var self = this;
      var next = self._facing === 'user' ? 'environment' : 'user';
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: next } }).then(function (stream) {
        var newTrack = stream.getVideoTracks()[0];
        if (!newTrack) throw new Error('no camera track');
        var apply = self._producers.camera
          ? self._producers.camera.replaceTrack({ track: newTrack })
          : Promise.resolve();
        return Promise.resolve(apply).then(function () {
          if (self._localStream) {
            self._localStream.getVideoTracks().forEach(function (t) {
              if (t !== newTrack) {
                try { t.stop(); } catch (e) {}
                try { self._localStream.removeTrack(t); } catch (e) {}
              }
            });
            try { self._localStream.addTrack(newTrack); } catch (e) {}
          }
          stream.getTracks().forEach(function (t) { if (t !== newTrack) { try { t.stop(); } catch (e) {} } });
          self._facing = next;
          self._emit('camerachanged', { facingMode: next });
          return next;
        });
      });
    };

    // ---- screen share ----
    // Sends the device screen as a second producer ({source:'screen'}, VP8,
    // single layer, contentHint 'detail' for sharp text). Requires
    // getDisplayMedia — available on desktop browsers; most mobile WebViews do
    // not expose it (we reject with err.unsupported so RN can explain).
    CallingSDK.prototype.startScreenShare = function () {
      var self = this;
      if (self._producers.screen) return Promise.resolve();
      if (!self._room || !self._room.joined || !self._sendTransport) {
        return Promise.reject(new Error('Screen share needs a connected call'));
      }
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
        var uerr = new Error('Screen sharing is not supported on this device');
        uerr.unsupported = true;
        return Promise.reject(uerr);
      }
      return navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: false
      }).then(function (stream) {
        var track = stream.getVideoTracks()[0];
        if (!track) {
          try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
          throw new Error('No screen track');
        }
        try { if ('contentHint' in track) track.contentHint = 'detail'; } catch (e) {}
        var codecs = (self._device && self._device.rtpCapabilities && self._device.rtpCapabilities.codecs) || [];
        var vp8 = null;
        for (var i = 0; i < codecs.length; i++) {
          if (String(codecs[i].mimeType).toLowerCase() === 'video/vp8') { vp8 = codecs[i]; break; }
        }
        var opts = { track: track, appData: { source: 'screen' } };
        if (vp8) opts.codec = vp8;
        return self._sendTransport.produce(opts).then(function (pr) {
          self._producers.screen = pr;
          self._screenStream = stream;
          // System/browser "Stop sharing" ends the track → tear down cleanly.
          track.onended = function () { self.stopScreenShare(); };
          self._log('screen share producing');
          self._emit('screenshare', { on: true });
        }).catch(function (e) {
          try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (er) {}
          throw e;
        });
      });
    };

    CallingSDK.prototype.stopScreenShare = function () {
      var self = this;
      var p = self._producers.screen;
      if (!p) return Promise.resolve();
      delete self._producers.screen;
      self._req('closeProducer', { producerId: p.id }).catch(function () {});
      try { p.close(); } catch (e) {}
      if (self._screenStream) {
        try { self._screenStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        self._screenStream = null;
      }
      self._log('screen share stopped');
      self._emit('screenshare', { on: false });
      return Promise.resolve();
    };

    // Swap the outbound mic track (glue's interruption recovery re-capture).
    CallingSDK.prototype.replaceAudioTrack = function (newTrack) {
      var p = this._producers.mic;
      if (p) { try { p.replaceTrack({ track: newTrack }); } catch (e) {} }
    };

    CallingSDK.prototype.queryPresence = function (ids) {
      var self = this;
      var list = (ids || []).map(String);
      var build = function (users) {
        var online = {};
        (users || []).forEach(function (u) { if (u && u.id != null) online[String(u.id)] = true; });
        var map = {};
        list.forEach(function (id) { map[id] = !!online[id]; });
        return map;
      };
      return self._req('getUsers', {}).then(function (r) {
        if (r && r.users) self._users = r.users;
        return build(self._users);
      }).catch(function () { return build(self._users); });
    };

    window.CallingSDK = CallingSDK;
  })();
  </script>
  <script>
  (function () {
    var remotes = document.getElementById('remotes');
    var local   = document.getElementById('local');
    var localWrap = document.getElementById('localWrap');
    var localCamOff = document.getElementById('localCamOff');
    var stage   = document.getElementById('stage');
    var swapped = false;       // tap-to-swap: true = self-camera is the full-screen feed
    var pipCorner = 'tr';      // which corner the small PiP snaps to: tl|tr|bl|br
    var justDragged = false;   // suppress the swap click right after a drag
    var call = null;

    // PiP geometry (must match the CSS vars: --pip-top / --pip-bottom / --pip-margin).
    var PIP_W = 104, PIP_H = 148, PIP_MARGIN = 14, PIP_TOP = 108, PIP_BOTTOM = 140;

    function clearCorner(el) {
      el.classList.remove('corner-tl', 'corner-tr', 'corner-bl', 'corner-br');
    }
    function setCorner(el) {
      clearCorner(el);
      el.classList.add('corner-' + pipCorner);
    }
    // The top-left anchor (in stage coords) for a given corner — used to animate
    // the snap after a drag.
    function anchorFor(corner) {
      var SW = stage.clientWidth, SH = stage.clientHeight;
      var x = (corner === 'tl' || corner === 'bl') ? PIP_MARGIN : (SW - PIP_MARGIN - PIP_W);
      var y = (corner === 'tl' || corner === 'tr') ? PIP_TOP : (SH - PIP_BOTTOM - PIP_H);
      return { x: x, y: y };
    }
    function isPipEl(el) {
      return el.classList.contains('corner-tl') || el.classList.contains('corner-tr')
        || el.classList.contains('corner-bl') || el.classList.contains('corner-br');
    }

    // Make a small PiP element draggable; on release it snaps to the nearest of
    // the four corners (top/bottom × left/right). A real drag also suppresses the
    // tap-to-swap click. Only active while the element is actually the small PiP
    // (it carries a corner-* class) — never while a feed is full-screen.
    function attachPipDrag(el) {
      var sx = 0, sy = 0, baseLeft = 0, baseTop = 0, moved = false, dragging = false;
      el.addEventListener('pointerdown', function (e) {
        if (!isPipEl(el)) return;
        dragging = true; moved = false;
        sx = e.clientX; sy = e.clientY;
        var r = el.getBoundingClientRect();
        var sr = stage.getBoundingClientRect();
        baseLeft = r.left - sr.left; baseTop = r.top - sr.top;
        el.style.transition = 'none';
        try { el.setPointerCapture(e.pointerId); } catch (er) {}
        e.stopPropagation();
      });
      el.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        var dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
        el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      });
      function endDrag(e) {
        if (!dragging) return;
        dragging = false;
        var dx = (typeof e.clientX === 'number' ? e.clientX : sx) - sx;
        var dy = (typeof e.clientY === 'number' ? e.clientY : sy) - sy;
        if (!moved) { el.style.transform = ''; el.style.transition = ''; return; }
        justDragged = true;
        setTimeout(function () { justDragged = false; }, 80);
        var cx = baseLeft + dx + PIP_W / 2;
        var cy = baseTop + dy + PIP_H / 2;
        var SW = stage.clientWidth, SH = stage.clientHeight;
        pipCorner = (cy < SH / 2 ? 't' : 'b') + (cx < SW / 2 ? 'l' : 'r');
        // Re-anchor to the chosen corner, then animate the leftover offset to 0
        // so it glides into place instead of jumping.
        var na = anchorFor(pipCorner);
        var residX = (baseLeft + dx) - na.x;
        var residY = (baseTop + dy) - na.y;
        setCorner(el);
        el.style.transition = 'none';
        el.style.transform = 'translate(' + residX + 'px,' + residY + 'px)';
        requestAnimationFrame(function () {
          el.style.transition = 'transform 0.18s ease';
          el.style.transform = 'translate(0px,0px)';
        });
        setTimeout(function () { el.style.transform = ''; el.style.transition = ''; }, 240);
      }
      el.addEventListener('pointerup', endDrag);
      el.addEventListener('pointercancel', endDrag);
    }
    var localFacing = 'user';
    var localStream = null;    // our captured local MediaStream (for direct track control)
    var micWanted = true;      // the user's mic on/off choice (for interruption recovery)
    var currentMedia = 'audio';// 'audio' | 'video' for the active call
    var tiles = {};            // peerId -> { wrap, video }
    var remoteStreams = {};    // peerId -> remote MediaStream (for the recording mix)
    var peerMeta = {};         // peerId -> { name, avatar } (RN-provided, for the camoff overlay)
    var remoteCamOff = {};     // peerId -> true while their camera producer is paused
    var currentSinkId = '';    // last applied audio output device id
    var wantSpeaker = false;   // RN-requested routing preference

    // ---- on-device call recording (admin "Listen Live") ----
    // Only the CALLER records. We mix our local mic + every remote audio track
    // into one stream via Web Audio and feed it to a MediaRecorder, posting each
    // timeslice up to RN (which uploads it). Best-effort: a recording failure
    // must NEVER disturb the call, so everything here is wrapped/guarded.
    var recCtx = null;         // AudioContext for the mix
    var recDest = null;        // MediaStreamDestination the recorder records
    var recorder = null;       // MediaRecorder
    var recMixed = [];         // ids of streams already wired into the mix
    var recSeq = 0;            // monotonic chunk sequence (assigned synchronously)
    var recMime = '';          // negotiated recorder mime
    var recStartMs = 0;
    var recActive = false;

    function pickRecMime() {
      var prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      try {
        if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
        for (var i = 0; i < prefs.length; i++) { if (MediaRecorder.isTypeSupported(prefs[i])) return prefs[i]; }
      } catch (e) {}
      return '';
    }

    function recAddStream(stream) {
      if (!recCtx || !recDest || !stream) return;
      try {
        var id = stream.id || String(Math.random());
        if (recMixed.indexOf(id) >= 0) return;
        if (!(stream.getAudioTracks && stream.getAudioTracks().length)) return;
        var src = recCtx.createMediaStreamSource(stream);
        src.connect(recDest);
        recMixed.push(id);
      } catch (e) { logToRN('rec addStream failed: ' + (e && e.message)); }
    }

    function startRecording(media, chunkMs) {
      if (recActive) return;
      try {
        if (typeof MediaRecorder === 'undefined') { post('recordingError', { message: 'MediaRecorder unsupported' }); return; }
        var ACtx = window.AudioContext || window.webkitAudioContext;
        if (!ACtx) { post('recordingError', { message: 'AudioContext unsupported' }); return; }
        recCtx = new ACtx();
        try { if (recCtx.state === 'suspended' && recCtx.resume) recCtx.resume(); } catch (e) {}
        recDest = recCtx.createMediaStreamDestination();
        recMixed = [];
        recSeq = 0;
        // Mix whatever we have right now: our mic + any remote streams already in.
        if (localStream) recAddStream(localStream);
        Object.keys(remoteStreams).forEach(function (pid) { recAddStream(remoteStreams[pid]); });
        recMime = pickRecMime();
        var opts = recMime ? { mimeType: recMime } : undefined;
        recorder = new MediaRecorder(recDest.stream, opts);
        recMime = recorder.mimeType || recMime || 'audio/webm';
        recorder.ondataavailable = function (e) {
          if (!e || !e.data || !e.data.size) return;
          var seq = recSeq++; // assign synchronously to preserve order
          var reader = new FileReader();
          reader.onloadend = function () {
            try {
              var res = String(reader.result || '');
              var b64 = res.indexOf(',') >= 0 ? res.slice(res.indexOf(',') + 1) : res;
              if (b64) post('recordingChunk', { seq: seq, mime: recMime, data: b64 });
            } catch (er) {}
          };
          reader.readAsDataURL(e.data);
        };
        recorder.onerror = function (e) { post('recordingError', { message: (e && e.error && e.error.name) || 'recorder error' }); };
        recStartMs = Date.now();
        recActive = true;
        recorder.start(Math.max(1000, Number(chunkMs) || 3000));
        logToRN('recording started mime=' + recMime + ' chunkMs=' + (chunkMs || 3000));
        post('recordingStarted', { mime: recMime });
      } catch (e) {
        logToRN('startRecording failed: ' + (e && e.message));
        post('recordingError', { message: (e && e.message) || 'startRecording failed' });
        recActive = false;
      }
    }

    function stopRecording() {
      if (!recActive) return;
      var durationSec = Math.max(0, Math.round((Date.now() - recStartMs) / 1000));
      var total = recSeq;
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (e) {}
      try { if (recCtx && recCtx.close) recCtx.close(); } catch (e) {}
      recorder = null; recCtx = null; recDest = null; recMixed = []; recActive = false;
      logToRN('recording stopped chunks=' + total + ' durationSec=' + durationSec);
      post('recordingStopped', { totalChunks: total, durationSec: durationSec });
    }

    // ---- mic re-capture after a full release (APP-12, JS half) ----
    // A phone/telephony interruption can END the captured mic track outright
    // (readyState 'ended'), not just disable it. An ended track can never be
    // re-enabled — the ONLY recovery is to re-run getUserMedia and swap the fresh
    // track onto the peer connection's audio sender, else our outbound audio is
    // dead one-way for the rest of the call. Best-effort + cooldown so a persistent
    // failure (mic still held by the other call) doesn't spin.
    // NOTE: this is the JS half only. Robust telephony handling (Android audio
    // focus / MODE_IN_COMMUNICATION / TelephonyCallback, iOS AVAudioSession
    // interruption observer) needs react-native-incall-manager + a native rebuild.
    // TODO(audit APP-12): add native audio-focus/telephony interruption handling.
    var recapturing = false;
    var lastRecaptureMs = 0;
    var lastEnsureAudioMs = 0; // cooldown for the late-mic (locked answer) retry
    function replaceAudioTrackOnSenders(newTrack) {
      // Try the common SDK/peer-connection surfaces to swap the outbound audio
      // track. Any that don't exist are skipped; at least one usually matches.
      var replaced = false;
      try {
        if (call && typeof call.replaceTrack === 'function') { call.replaceTrack(newTrack, 'audio'); replaced = true; }
      } catch (e) {}
      try {
        if (call && typeof call.replaceAudioTrack === 'function') { call.replaceAudioTrack(newTrack); replaced = true; }
      } catch (e) {}
      // Direct RTCPeerConnection sender access (call.pc / call.peerConnection /
      // a map of per-peer connections).
      function swapOnPc(pc) {
        try {
          if (!pc || typeof pc.getSenders !== 'function') return;
          pc.getSenders().forEach(function (s) {
            if (s && s.track && s.track.kind === 'audio' && typeof s.replaceTrack === 'function') {
              s.replaceTrack(newTrack); replaced = true;
            }
          });
        } catch (e) {}
      }
      try { swapOnPc(call && (call.pc || call.peerConnection)); } catch (e) {}
      try {
        var pcs = call && (call.pcs || call.connections || call.peers);
        if (pcs) Object.keys(pcs).forEach(function (k) {
          var p = pcs[k]; swapOnPc(p && (p.pc || p.peerConnection || p));
        });
      } catch (e) {}
      return replaced;
    }
    function recaptureMic() {
      if (recapturing) return;
      var now = Date.now();
      if (now - lastRecaptureMs < 4000) return; // cooldown
      lastRecaptureMs = now;
      recapturing = true;
      logToRN('mic track ended — re-capturing via getUserMedia');
      try {
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function (ns) {
          try {
            var nt = (ns.getAudioTracks() || [])[0];
            if (!nt) { recapturing = false; return; }
            nt.enabled = !!micWanted;
            // Swap onto the outbound sender(s), then update our localStream so the
            // recording mix + future toggles see the live track.
            replaceAudioTrackOnSenders(nt);
            if (localStream) {
              try {
                (localStream.getAudioTracks() || []).forEach(function (old) {
                  try { old.stop(); } catch (e) {}
                  try { localStream.removeTrack(old); } catch (e) {}
                });
                localStream.addTrack(nt);
              } catch (e) {}
            }
            logToRN('mic re-captured — audio restored');
            post('micRecaptured', {});
          } catch (e) { logToRN('mic recapture apply failed: ' + (e && e.message)); }
          recapturing = false;
        }).catch(function (e) {
          logToRN('mic recapture getUserMedia failed: ' + (e && e.message));
          recapturing = false;
        });
      } catch (e) { recapturing = false; }
    }

    // Force the local mic (and, for video, camera) track(s) to enabled, so we
    // actually transmit from the moment media is captured — the CALLER at ring
    // time and the CALLEE right after accept. Returns the audio-track count.
    function enableLocalMic(on) {
      var n = 0;
      try {
        if (localStream && localStream.getAudioTracks) {
          (localStream.getAudioTracks() || []).forEach(function (t) { t.enabled = !!on; n += 1; });
        }
      } catch (e) {}
      return n;
    }

    // Force the local camera (video) track(s) enabled/disabled — used for video
    // calls so the camera is ACTIVE and streaming the moment media is captured,
    // and for the Camera on/off toggle. Returns the video-track count.
    function enableLocalCamera(on) {
      var n = 0;
      try {
        if (localStream && localStream.getVideoTracks) {
          (localStream.getVideoTracks() || []).forEach(function (t) { t.enabled = !!on; n += 1; });
        }
      } catch (e) {}
      // Show the "Camera off" placeholder over the self-view when the camera is
      // off, so the user sees a clear card instead of a black frame (esp. when the
      // self-view is the full-screen solo tile before/without a remote feed).
      try {
        if (localCamOff) {
          if (on) localCamOff.classList.add('hidden');
          else localCamOff.classList.remove('hidden');
        }
      } catch (e) {}
      return n;
    }

    function post(type, payload) {
      try {
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: type, payload: payload || {} }));
        }
      } catch (e) {}
    }
    function logToRN(msg) { post('log', { message: String(msg) }); }

    // Keep the grid balanced for the current tile count (1 → full, 2 → side by
    // side, 3-4 → 2 columns).
    function relayout() {
      var n = Object.keys(tiles).length;
      remotes.className = '';
      // Column count scales with the group size (up to 32 participants):
      // 1 → full stage, 2-4 → 2 cols, 5-9 → 3 cols, 10+ → 4 cols.
      if (n <= 1) remotes.classList.add('count-1');
      else if (n <= 4) remotes.classList.add('cols-2');
      else if (n <= 9) remotes.classList.add('cols-3');
      else remotes.classList.add('cols-4');
      var isVideo = currentMedia === 'video';
      // Self-view fills the screen when there is no remote yet (outgoing preview)
      // OR when the user has tapped to swap (self = main feed); otherwise it's the
      // small PiP. The remote grid becomes the PiP only when swapped with a remote
      // present. Only for video (the local element is hidden for audio).
      var localSolo = isVideo && (n === 0 || swapped);
      var remotesPip = isVideo && n > 0 && swapped;
      if (remotesPip) remotes.classList.add('pip');
      try {
        // The self-view wrapper: full-screen (solo) or a draggable corner PiP.
        if (localSolo) { localWrap.classList.add('solo'); clearCorner(localWrap); }
        else { localWrap.classList.remove('solo'); if (isVideo) setCorner(localWrap); else clearCorner(localWrap); }
        // The remote grid sits in the same chosen corner while swapped.
        if (remotesPip) setCorner(remotes); else clearCorner(remotes);
      } catch (e) {}
    }

    // Tap-to-swap (WhatsApp style): tapping the video stage swaps which feed is
    // full-screen vs the PiP. Only meaningful in a video call with a remote.
    function toggleSwap() {
      if (currentMedia !== 'video') return;
      if (Object.keys(tiles).length === 0) return; // nothing to swap with yet
      swapped = !swapped;
      relayout();
      logToRN('tap-to-swap → ' + (swapped ? 'self full / remote PiP' : 'remote full / self PiP'));
      post('swap', { swapped: swapped });
    }

    function tileFor(peerId) {
      var id = String(peerId || 'peer');
      if (tiles[id]) return tiles[id];
      var wrap = document.createElement('div');
      wrap.className = 'rtile';
      wrap.id = id; // addressable: '<peerId>' camera/mic tile, 'scr-<peerId>' screen tile
      var v = document.createElement('video');
      v.autoplay = true; v.playsInline = true; v.muted = false;
      // The moment the element actually starts playing audible media, tell RN to
      // drop any "Tap to enable audio" prompt — audio is live, no gesture needed.
      v.addEventListener('playing', function () { if (!v.muted) post('audioResumed', {}); });
      wrap.appendChild(v);
      remotes.appendChild(wrap);
      tiles[id] = { wrap: wrap, video: v };
      // Their camera was already off before the tile existed (pause landed first).
      applyRemoteCamOff(id);
      relayout();
      return tiles[id];
    }

    function removeTile(peerId) {
      var id = String(peerId || 'peer');
      try { delete remoteStreams[id]; } catch (e) {}
      var t = tiles[id];
      if (t) {
        try { t.video.srcObject = null; } catch (e) {}
        try { t.wrap.remove(); } catch (e) {}
        delete tiles[id];
        relayout();
      }
    }

    // ---- REMOTE camera-off overlay (WhatsApp look) ----
    // While a peer's camera producer is paused their tile would just freeze —
    // draw their circular avatar (RN supplies it via the peerMeta cmd) or an
    // initial-letter circle over the tile instead. Overlay is a child of the
    // tile wrap, so it follows the tile through swap/PiP/removal for free.
    function camoffLetterEl(meta) {
      var d = document.createElement('div');
      d.className = 'camoff-letter';
      var n = (meta && meta.name) ? String(meta.name).trim() : '';
      d.textContent = n ? n.charAt(0).toUpperCase() : '?';
      return d;
    }
    function applyRemoteCamOff(peerId) {
      var id = String(peerId || '');
      var t = tiles[id];
      if (!t) return;
      var existing = t.wrap.querySelector('.camoff');
      if (!remoteCamOff[id]) {
        if (existing) { try { existing.remove(); } catch (e) {} }
        return;
      }
      if (existing) return;
      var ov = document.createElement('div');
      ov.className = 'camoff';
      var meta = peerMeta[id] || {};
      if (meta.avatar) {
        var img = document.createElement('img');
        img.className = 'camoff-avatar';
        img.alt = '';
        img.onerror = function () {
          try { ov.replaceChild(camoffLetterEl(meta), img); } catch (e) {}
        };
        img.src = meta.avatar;
        ov.appendChild(img);
      } else {
        ov.appendChild(camoffLetterEl(meta));
      }
      t.wrap.appendChild(ov);
    }

    function clearTiles() {
      Object.keys(tiles).forEach(removeTile);
      tiles = {};
      remoteCamOff = {};
      peerMeta = {};
      relayout();
    }

    // Summarize a stream's tracks for diagnostics ("audio:1 video:0").
    function trackSummary(stream) {
      try {
        var a = 0, v = 0;
        (stream.getTracks() || []).forEach(function (t) {
          if (t.kind === 'audio') a += 1; else if (t.kind === 'video') v += 1;
        });
        return 'audio:' + a + ' video:' + v;
      } catch (e) { return 'tracks:?'; }
    }

    // Try to play a remote element with sound; if the browser blocks autoplay-
    // with-sound, ask RN to show a one-tap "enable audio" prompt.
    function playWithSound(v) {
      try {
        v.muted = false;
        v.volume = 1.0;
        var p = v.play();
        if (p && p.then) {
          p.then(function () { logToRN('remote audio playing'); post('audioResumed', {}); })
           .catch(function (e) {
             var name = e && e.name;
             // ONLY a genuine autoplay-policy block needs a user gesture. Other
             // rejections (most commonly AbortError when the stream re-attaches
             // mid-negotiation) are transient — retry shortly instead of showing
             // a stale "Tap to enable audio" prompt over audio that's fine.
             if (name === 'NotAllowedError' || name === 'SecurityError') {
               logToRN('autoplay blocked (' + name + ') — needs gesture');
               post('needsUnmuteGesture', {});
             } else {
               logToRN('play() rejected (' + name + ') — retrying');
               setTimeout(function () {
                 try { v.play().then(function () { post('audioResumed', {}); }).catch(function () {}); }
                 catch (e2) {}
               }, 300);
             }
           });
        }
      } catch (e) { logToRN('play() threw: ' + (e && e.message)); post('needsUnmuteGesture', {}); }
    }
    function playAllRemotes() {
      Object.keys(tiles).forEach(function (id) { playWithSound(tiles[id].video); });
    }

    // ---- CallKit audio-session recovery (iOS) ----
    // Answering via CallKit (or CallKit reporting the caller's connected call)
    // re-activates the process-global audio session UNDERNEATH WebKit. Tracks
    // captured/attached BEFORE that switch keep readyState 'live' but their
    // audio units are dead — the mic sends silence and remote playback is mute,
    // and the interruption watchdog below can't see it (nothing is 'paused' or
    // 'ended'). RN sends 'restartAudio' on CallKit's didActivateAudioSession
    // (and as a post-connect safety net): force-rebuild BOTH directions —
    // re-capture the mic (fresh getUserMedia → producer.replaceTrack) and
    // re-attach every remote stream so WebKit rebuilds its playback pipeline
    // under the now-active CallKit session. Idempotent; safe to run repeatedly.
    function restartAudioPipeline() {
      if (!call) { logToRN('restartAudio skipped — no live call'); return; }
      logToRN('restartAudio — rebuilding mic + remote playback (CallKit session)');
      // Locked-phone answer joined WITHOUT a mic producer (capture was refused
      // in the background) — produce it now that the audio session is live.
      try {
        if (typeof call.ensureLocalAudio === 'function') {
          call.ensureLocalAudio().then(function (ok) { if (ok) enableLocalMic(micWanted); });
        }
      } catch (e) {}
      try { lastRecaptureMs = 0; } catch (e) {}
      try { recaptureMic(); } catch (e) {}
      try {
        Object.keys(tiles).forEach(function (id) {
          var v = tiles[id] && tiles[id].video;
          if (!v || !v.srcObject) return;
          // Detach + re-attach: a plain play() on an un-paused element is a
          // no-op and never rebuilds the dead audio unit.
          try { var s = v.srcObject; v.srcObject = null; v.srcObject = s; } catch (e) {}
          playWithSound(v);
        });
      } catch (e) {}
    }

    function applyLocalMirror() {
      if (localFacing === 'user') local.classList.add('mirror');
      else local.classList.remove('mirror');
    }

    // ---- audio output routing (speaker / earpiece) ----
    // setSinkId is supported on Chromium/Android WebView; iOS WKWebView ignores
    // it (the OS routes audio). We pick the loudspeaker for speakerphone and the
    // earpiece/handset (or default) otherwise, matching device labels.
    function outputSupported() {
      try { return typeof document.createElement('video').setSinkId === 'function'; }
      catch (e) { return false; }
    }
    function pickOutput(speaker) {
      var spk = ['speaker', 'speakerphone'];
      var ear = ['earpiece', 'handset', 'receiver', 'earphone', 'headset', 'headphone', 'bluetooth', 'airpods', 'buds'];
      var keys = speaker ? spk : ear;
      return navigator.mediaDevices.enumerateDevices().then(function (devs) {
        var outs = devs.filter(function (d) { return d.kind === 'audiooutput'; });
        var hit = outs.find(function (d) {
          var l = (d.label || '').toLowerCase();
          return keys.some(function (k) { return l.indexOf(k) >= 0; });
        });
        // Earpiece falls back to "default" (usually the receiver on phones);
        // speaker falls back to default too if no explicit speaker device.
        return hit ? hit.deviceId : 'default';
      }).catch(function () { return 'default'; });
    }
    function applySink(deviceId) {
      currentSinkId = deviceId;
      Object.keys(tiles).forEach(function (id) {
        var v = tiles[id].video;
        if (v && v.setSinkId) {
          try {
            v.setSinkId(deviceId)
              .then(function () { logToRN('output → ' + String(deviceId).slice(0, 8)); })
              .catch(function (e) { logToRN('output switch failed: ' + (e && e.message)); });
          } catch (e) {}
        }
      });
    }
    function applySpeakerPreference() {
      if (!outputSupported()) { logToRN('setSinkId unsupported — OS routes audio'); post('speakerResult', { supported: false, speaker: wantSpeaker }); return; }
      pickOutput(wantSpeaker).then(function (id) {
        logToRN('speaker=' + wantSpeaker + ' → output ' + String(id).slice(0, 8));
        applySink(id);
        post('speakerResult', { supported: true, speaker: wantSpeaker, deviceId: String(id).slice(0, 8) });
      });
    }

    function wireEvents() {
      call.on('localstream', function (stream) {
        localStream = stream;
        try { local.srcObject = stream; local.play && local.play().catch(function(){}); } catch (e) {}
        applyLocalMirror();
        // Guarantee the mic is live (enabled/unmuted) the instant it's captured —
        // caller at ring, callee just after accept. The local <video> element stays
        // muted (no echo of your own voice) but the TRACK is enabled so we transmit.
        var micCount = enableLocalMic(true);
        // For a video call, make the camera ACTIVE + streaming, and show the local
        // self-preview tile (WhatsApp-style PiP). For an audio call hide it.
        var camCount = 0;
        var isVideo = currentMedia === 'video';
        if (isVideo) { camCount = enableLocalCamera(true); localWrap.classList.remove('hidden'); }
        else { localWrap.classList.add('hidden'); }
        // Size the self-view: full-screen while no remote yet, PiP once one joins.
        relayout();
        logToRN('localstream captured — ' + trackSummary(stream) + ' — mic enabled (audioTracks=' + micCount + ') cam=' + (isVideo ? ('on(videoTracks=' + camCount + ')') : 'n/a'));
        post('localstream', { mic: micCount > 0, camera: camCount > 0, media: currentMedia });
      });
      call.on('stream', function (data) {
        var peerId = data && data.peerId;
        var stream = data && data.stream;
        // A peer's SCREEN share renders as its own tile beside their camera.
        var isScreen = data && data.source === 'screen';
        var tileKey = isScreen ? ('scr-' + peerId) : peerId;
        var t = tileFor(tileKey);
        try { t.wrap.dataset.peer = String(peerId || ''); } catch (e) {}
        try { t.video.srcObject = stream; } catch (e) {}
        // Keep the remote stream for the recording mix (screen has no audio).
        if (peerId && stream && !isScreen) { remoteStreams[String(peerId)] = stream; recAddStream(stream); }
        // Re-assert our local mic is enabled now the call has connected — covers
        // any SDK path that may have left the track disabled during negotiation,
        // so the other side always hears us.
        enableLocalMic(true);
        if (currentMedia === 'video') enableLocalCamera(true);
        logToRN('remote stream from ' + (peerId || '?') + ' — ' + trackSummary(stream) + ' (local mic re-asserted on)');
        // Play through the CURRENT/default output. We do NOT auto-force setSinkId
        // here: on mobile WebViews an auto-picked sink can route to a silent /
        // inactive device and kill call audio. The default output is reliably
        // audible; the Speaker toggle (setSpeaker) applies an explicit sink only
        // when the user asks for it, and only if it actually exists.
        if (currentSinkId && t.video.setSinkId) {
          try {
            t.video.setSinkId(currentSinkId)
              .then(function () { logToRN('sink applied ' + String(currentSinkId).slice(0, 8)); })
              .catch(function (e) { logToRN('setSinkId failed: ' + (e && e.message)); });
          } catch (e) {}
        }
        playWithSound(t.video);
        // The 'video' flag tells RN a VISUAL feed arrived — in an audio call it
        // upgrades the UI to the video stage (peer turned camera on / screen).
        var hasVideo = false;
        try { hasVideo = !!(stream && stream.getVideoTracks && stream.getVideoTracks().length); } catch (e) {}
        post('stream', {
          peerId: peerId ? String(peerId) : null,
          video: hasVideo,
          source: (data && data.source) || null,
        });
      });
      // WE upgraded an audio call to video (camera turned on mid-call). Flip the
      // engine into video mode: show the self-preview (its <video> already holds
      // the localStream, which just gained the camera track) and relayout.
      call.on('mediaupgraded', function () {
        currentMedia = 'video';
        enableLocalCamera(true);
        try { localWrap.classList.remove('hidden'); } catch (e) {}
        relayout();
        logToRN('audio call upgraded to VIDEO (self camera on)');
        post('mediaUpgraded', { media: 'video' });
      });
      call.on('mediaupgradefailed', function (d) {
        post('mediaUpgradeFailed', { message: (d && d.message) || 'Could not start the camera' });
      });
      call.on('incoming', function (info) {
        info = info || {};
        var from = info.from || {};
        // Some services include a participants/members array for group calls.
        var members = [];
        var raw = info.members || info.participants || (info.group && info.group.members) || [];
        if (raw && raw.length) {
          members = raw.map(function (m) {
            return { id: m && (m.id != null) ? String(m.id) : null, name: (m && m.name) || '' };
          }).filter(function (m) { return m.id; });
        }
        logToRN('SDK incoming callId=' + (info.callId || '?') + ' from=' + (from.id || '?') + ' media=' + (info.media || 'audio'));
        post('incoming', {
          callId: info.callId || null,
          from: { id: from.id ? String(from.id) : null, name: from.name || '' },
          media: info.media || 'audio',
          // Only trust an EXPLICIT group flag here. The RN side decides group vs
          // 1:1 from the actual third-party count, so a service that ships a
          // [caller, me] roster on a normal 1:1 is never misread as a group.
          isGroup: !!(info.isGroup || info.group),
          groupId: (info.group && (info.group.id != null)) ? String(info.group.id) : (info.groupId != null ? String(info.groupId) : null),
          groupName: (info.group && info.group.name) || info.groupName || null,
          members: members,
        });
      });
      call.on('peerleft', function (data) {
        var id = (data && data.id) ? String(data.id) : null;
        if (id) { removeTile(id); removeTile('scr-' + id); }
        post('peerleft', { id: id });
      });
      // A peer stopped sharing their screen — drop just the screen tile.
      call.on('streamremoved', function (data) {
        if (data && data.source === 'screen' && data.peerId) removeTile('scr-' + String(data.peerId));
      });
      // Our own share started/stopped from INSIDE the SDK (e.g. the system
      // "Stop sharing" chip) — keep RN's button state in sync.
      call.on('screenshare', function (data) {
        post(data && data.on ? 'screenShareStarted' : 'screenShareStopped', {});
      });
      call.on('ended', function () { post('ended', {}); });
      call.on('rejected', function (info) { post('rejected', info || {}); });
      call.on('cancelled', function () { post('cancelled', {}); });
      call.on('presence', function (data) {
        data = data || {};
        post('presence', { userId: data.userId ? String(data.userId) : null, online: !!data.online });
      });
      call.on('camerachanged', function (data) {
        data = data || {};
        localFacing = data.facingMode || localFacing;
        applyLocalMirror();
        post('camerachanged', { facingMode: localFacing });
      });
      // Peer camera paused/resumed (camera off/on mid-call) — overlay their
      // avatar on THEIR tile only (self tile untouched), and relay to RN.
      call.on('peervideo', function (data) {
        data = data || {};
        var pvId = data.peerId != null ? String(data.peerId) : null;
        if (pvId) {
          if (data.on === false) remoteCamOff[pvId] = true;
          else delete remoteCamOff[pvId];
          applyRemoteCamOff(pvId);
        }
        post('peervideo', { peerId: pvId, on: data.on !== false });
      });
      call.on('peerfacing', function (data) {
        data = data || {};
        var id = data.peerId ? String(data.peerId) : null;
        var t = id ? tiles[id] : null;
        if (t) {
          if (data.facingMode === 'user') t.video.classList.add('mirror');
          else t.video.classList.remove('mirror');
        }
        post('peerfacing', { peerId: id, facingMode: data.facingMode || 'environment' });
      });
      call.on('error', function (err) {
        post('error', { message: (err && err.message) ? err.message : 'call error' });
      });
      // Who is talking right now (SFU audio-level observer) — forwarded so the
      // RN group UI can highlight the active speaker; RN ignores it otherwise.
      call.on('activespeaker', function (data) {
        post('activeSpeaker', { peerId: (data && data.peerId) || null });
      });
      // ---- mid-call media-layer connection state (network resilience) ----
      // Forward the peer-connection's up/down transitions to RN so it can show a
      // "Reconnecting…" state + arm a recovery watchdog (APP-6). The SDK exposes
      // these under a few possible event names depending on version, so we listen
      // to all of them; RN de-dupes via a flag so duplicate mediaDown/mediaUp are
      // harmless. ICE 'failed'/'disconnected' also surfaces via the debug handler
      // below.
      var mediaDownSent = false;
      function emitMediaDown(why) {
        if (mediaDownSent) return;
        mediaDownSent = true;
        logToRN('media DOWN (' + (why || '?') + ')');
        post('mediaDown', { reason: why || null });
      }
      function emitMediaUp(why) {
        if (!mediaDownSent) return;
        mediaDownSent = false;
        logToRN('media UP (' + (why || '?') + ')');
        post('mediaUp', { reason: why || null });
      }
      ['disconnect', 'disconnected', 'reconnecting'].forEach(function (ev) {
        try { call.on(ev, function () { emitMediaDown(ev); }); } catch (e) {}
      });
      ['reconnect', 'reconnected', 'peerconnected', 'connected'].forEach(function (ev) {
        try { call.on(ev, function () { emitMediaUp(ev); }); } catch (e) {}
      });
      // Temporary WebRTC diagnostics — only fires when the SDK was built with
      // debug:true (passed on 'connect'). Surfaces PC/ICE/DTLS transitions,
      // candidate-type counts and periodic getStats to the RN log stream.
      call.on('debug', function (d) {
        if (!d) return;
        logToRN('[RTC] ' + d.tag + ' ' + (d.data ? JSON.stringify(d.data) : ''));
        post('rtcDebug', d);
        // Derive media up/down from ICE / PC connection-state transitions in the
        // debug stream (covers SDK builds that don't emit the named events above).
        try {
          var data = d.data || {};
          var st = String(
            data.iceConnectionState || data.connectionState || data.state
            || (typeof d.tag === 'string' ? d.tag : '')
          ).toLowerCase();
          if (st.indexOf('failed') >= 0 || st.indexOf('disconnected') >= 0) emitMediaDown('ice:' + st);
          else if (st.indexOf('connected') >= 0 || st.indexOf('completed') >= 0) emitMediaUp('ice:' + st);
        } catch (e) {}
      });
    }

    function resetTiles() {
      stopRecording();
      remoteStreams = {};
      clearTiles();
      try { local.srcObject = null; } catch (e) {}
      localStream = null;
      currentMedia = 'audio';
      swapped = false;
      pipCorner = 'tr';
      localFacing = 'user';
      currentSinkId = '';
      try {
        localWrap.style.transform = '';
        localWrap.style.transition = '';
        localWrap.classList.add('hidden');
        localWrap.classList.remove('solo');
        clearCorner(localWrap);
      } catch (e) {}
      applyLocalMirror();
    }

    // Normalize a startCall target to an array of string ids (1:1 or group).
    function toIdList(to) {
      if (to == null) return [];
      var arr = Array.isArray(to) ? to : [to];
      return arr.map(function (x) { return String(x); }).filter(Boolean);
    }

    // ---- RN → Engine command dispatch ----
    window.__cmd = function (jsonStr) {
      var msg;
      try { msg = JSON.parse(jsonStr); } catch (e) { return; }
      var cmd = msg && msg.cmd;
      try {
        switch (cmd) {
          case 'connect': {
            logToRN('engine build 2026-07-16a (socket-reuse+prejoin)');
            if (typeof CallingSDK === 'undefined') {
              post('connectError', { message: 'CallingSDK failed to load' });
              return;
            }
            // REUSE a live, registered SDK when the identity + server are
            // unchanged. The old unconditional teardown dropped the PRE-WARMED
            // socket at every call start (server logs: connected → disconnected
            // → connected) and burned ~1s re-handshaking before joinRoom — and a
            // CONNECT arriving during a LIVE call killed the call outright. A
            // token refresh doesn't need a reconnect: the token is only read at
            // joinRoom time.
            var postReady = function () {
              post('engineReady', {
                // Whether THIS WebView can capture the screen (desktop browsers
                // yes; most mobile WebViews no — receive always works).
                screenShare: !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function'),
              });
            };
            // APP-7: tear down any PREVIOUS SDK instance before constructing a
            // new one. A re-connect that left the old instance alive kept its
            // socket + listeners → ghost 'incoming'/'stream' events for a stale
            // call. Hang up + disconnect it first so only the fresh instance is
            // ever wired.
            var buildFresh = function () {
              if (call) {
                try { call.hangup && call.hangup(); } catch (e) {}
                try { call.disconnect && call.disconnect(); } catch (e) {}
                try { call.close && call.close(); } catch (e) {}
                call = null;
              }
              resetTiles();
              logToRN('connecting to ' + (msg.url || '${SDK_ORIGIN}'));
              call = new CallingSDK({
                url: msg.url || '${SDK_ORIGIN}', token: msg.token,
                userId: msg.userId, name: msg.name, debug: !!msg.debug,
                iceServers: msg.iceServers || null,
              });
              wireEvents();
              Promise.resolve(call.connect()).then(function () {
                logToRN('engine connected — SDK ready');
                postReady();
              }).catch(function (e) {
                logToRN('connect failed: ' + (e && e.message));
                // Drop the half-connected instance so a later CONNECT retry
                // starts clean; a startCall can never fire into a dead SDK.
                try { call && call.disconnect && call.disconnect(); } catch (er) {}
                call = null;
                post('connectError', { message: (e && e.message) ? e.message : 'connect failed' });
              });
            };
            var reuseUrl = String(msg.url || '${SDK_ORIGIN}').replace(/\\/+$/, '');
            if (call && call._socket && call._socket.connected && call._registered
                && String(call.userId) === String(msg.userId || call.userId)
                && call.url === reuseUrl) {
              if (typeof msg.token === 'string' && msg.token.split('.').length === 3) call._token = msg.token;
              if (msg.iceServers && msg.iceServers.length) call._fallbackIceServers = msg.iceServers;
              // "connected" can lie on a backgrounded WebView (half-open TCP) —
              // verify with a real round trip before trusting the socket; the
              // probe doubles as a registration refresh. Dead → rebuild fresh.
              var reused = call;
              call.verifyAlive(2500).then(function (ok) {
                if (call !== reused) return; // superseded meanwhile
                if (ok) {
                  logToRN('connect: reusing live engine socket (identity unchanged, probe ok)');
                  postReady();
                } else {
                  logToRN('connect: reuse probe FAILED — rebuilding the engine socket');
                  buildFresh();
                }
              });
              return;
            }
            buildFresh();
            break;
          }
          case 'ping': {
            // Liveness probe for ensureConnected. The client-side "connected"
            // flag LIES on a half-open socket (backgrounded device, NAT idle
            // drop): the server keeps emitting rings into the dead socket while
            // this side never reconnects — the callee accepted but their engine
            // never heard the SFU ring (stuck "Connecting…" → 30s watchdog).
            // So pong only reports connected after a REAL server round trip
            // (1.5s bound — inside RN's 2s ping window); a dead socket reports
            // connected:false and ensureConnected rebuilds the connection.
            if (!call || !call._socket || !call._socket.connected) {
              post('pong', { ref: msg.ref, hasCall: !!call, connected: false });
              break;
            }
            (function (ref) {
              call.verifyAlive(1500).then(function (ok) {
                post('pong', { ref: ref, hasCall: true, connected: !!ok });
              });
            })(msg.ref);
            break;
          }
          case 'startCall': {
            if (!call) {
              // No SDK instance — the page reloaded (or connect failed) while RN
              // still thought the engine was ready. Tell RN the engine is down so
              // it reconnects for the next attempt, then fail this dial clearly.
              post('connectError', { message: 'engine had no SDK at dial time' });
              post('startCallError', { ref: msg.ref, message: 'Call engine restarting — please try again' });
              return;
            }
            var targets = toIdList(msg.to);
            // ALWAYS pass an array — even for a 1:1 call — exactly like the working
            // reference (call.startCall of [].concat(to)). Passing a bare id for 1:1
            // made the SDK startCall never resolve (no callId, no WebRTC incoming on
            // the callee, no media), so do not "optimize" this to a single id.
            var arg = targets;
            wantSpeaker = !!msg.speaker;
            currentMedia = (msg.media === 'video') ? 'video' : 'audio';
            logToRN('startCall → [' + targets.join(',') + '] media=' + currentMedia);
            Promise.resolve(call.startCall(arg, msg.media)).then(function (res) {
              res = res || {};
              // Mic (and camera for a video call) ON as soon as the dial resolves.
              enableLocalMic(true);
              if (currentMedia === 'video') enableLocalCamera(true);
              // offline may be a boolean (1:1) or an array of ids (group).
              var offline = Array.isArray(res.offline) ? res.offline.map(String)
                : (res.offline ? [String(targets[0] || '')] : []);
              logToRN('startCall ok callId=' + (res.callId || 'none') + (offline.length ? ' OFFLINE=' + offline.join(',') : ''));
              post('startCallResult', { ref: msg.ref, callId: res.callId || null, offline: offline });
            }).catch(function (e) {
              logToRN('startCall error: ' + (e && e.message));
              post('startCallError', { ref: msg.ref, message: (e && e.message) ? e.message : 'startCall failed' });
            });
            break;
          }
          case 'accept': {
            wantSpeaker = !!msg.speaker;
            if (msg.media) currentMedia = (msg.media === 'video') ? 'video' : 'audio';
            logToRN('accept → callId=' + msg.callId + ' media=' + currentMedia + ' speaker=' + wantSpeaker);
            if (call) Promise.resolve(call.accept(msg.callId, msg.media, { isGroup: msg.isGroup, peerId: msg.peerId }))
              .then(function () {
                // Mic (and camera for a video call) ON immediately after answering.
                enableLocalMic(true);
                if (currentMedia === 'video') enableLocalCamera(true);
                logToRN('accept ok — establishing media (mic on, cam=' + (currentMedia === 'video' ? 'on' : 'n/a') + ')');
              })
              .catch(function (e) { logToRN('accept failed: ' + (e && e.message)); post('cmdError', { cmd: cmd, message: String(e && e.message) }); });
            break;
          }
          case 'reject': { if (call) call.reject(msg.callId); break; }
          case 'startRecording': { startRecording(msg.media, msg.chunkMs); break; }
          case 'stopRecording': { stopRecording(); break; }
          case 'hangup': { stopRecording(); if (call) call.hangup(); resetTiles(); break; }
          case 'toggleMic': {
            micWanted = !!msg.on; // remember the choice so recovery doesn't un-mute
            if (call) { try { call.toggleMic(!!msg.on); } catch (e) {} }
            // Also set the track directly so mute/unmute is reliable regardless of
            // the SDK's internal handling.
            var micN = enableLocalMic(!!msg.on);
            logToRN('toggleMic → ' + (!!msg.on ? 'ON' : 'OFF') + ' (audioTracks=' + micN + ')');
            break;
          }
          case 'toggleCamera': {
            if (call) { try { call.toggleCamera(!!msg.on); } catch (e) {} }
            var camN = enableLocalCamera(!!msg.on);
            // Keep the self-view VISIBLE when the camera is off and show the
            // "Camera off" placeholder over it (enableLocalCamera handles the
            // placeholder) — instead of hiding it to a black frame.
            try { localWrap.classList.remove('hidden'); } catch (e) {}
            logToRN('toggleCamera → ' + (!!msg.on ? 'ON' : 'OFF') + ' (videoTracks=' + camN + ')');
            break;
          }
          case 'switchCamera': {
            if (call) Promise.resolve(call.switchCamera()).then(function (facing) {
              localFacing = facing || localFacing; applyLocalMirror();
            }).catch(function(){});
            break;
          }
          case 'peerMeta': {
            // 1:1 peer identity for the remote camera-off overlay.
            if (msg.peerId != null) {
              var pmId = String(msg.peerId);
              peerMeta[pmId] = { name: msg.name || '', avatar: msg.avatar || '' };
              // Rebuild an already-showing overlay so a late avatar upgrades
              // the letter fallback.
              var pmT = tiles[pmId];
              if (pmT) {
                var pmOv = pmT.wrap.querySelector('.camoff');
                if (pmOv) { try { pmOv.remove(); } catch (e) {} }
                applyRemoteCamOff(pmId);
              }
            }
            break;
          }
          case 'inviteToGroup': {
            if (!call) break;
            Promise.resolve(call.inviteToGroup(msg.ids || []))
              .then(function () { logToRN('group invite sent'); })
              .catch(function (e) { logToRN('group invite failed: ' + (e && e.message)); });
            break;
          }
          case 'stopInvite': {
            if (call && msg.id) { try { call.stopInviting(msg.id); } catch (e) {} }
            break;
          }
          case 'toggleScreen': {
            if (!call) { post('screenShareError', { message: 'Call engine not connected' }); break; }
            if (msg.on) {
              Promise.resolve(call.startScreenShare()).catch(function (e) {
                var name = e && e.name;
                // User cancelled the OS/browser share picker → quiet reset.
                if (name === 'NotAllowedError' || name === 'AbortError') {
                  logToRN('screen share cancelled by user');
                  post('screenShareStopped', { cancelled: true });
                  return;
                }
                logToRN('screen share failed: ' + (e && e.message));
                post('screenShareError', {
                  message: (e && e.message) ? e.message : 'Screen share failed',
                  unsupported: !!(e && e.unsupported),
                });
              });
            } else {
              Promise.resolve(call.stopScreenShare()).catch(function () { post('screenShareStopped', {}); });
            }
            break;
          }
          case 'queryPresence': {
            if (!call) { post('presenceResult', { ref: msg.ref, map: {} }); return; }
            Promise.resolve(call.queryPresence(msg.ids || [])).then(function (map) {
              post('presenceResult', { ref: msg.ref, map: map || {} });
            }).catch(function () { post('presenceResult', { ref: msg.ref, map: {} }); });
            break;
          }
          case 'resumeAudio': { playAllRemotes(); break; }
          case 'restartAudio': { restartAudioPipeline(); break; }
          case 'setSpeaker': { wantSpeaker = !!msg.on; applySpeakerPreference(); break; }
          case 'restartIce': {
            // Network changed (wifi↔cellular) mid-call — ask the SDK to renegotiate
            // its transport so media recovers instead of hanging (APP-6). Best-effort:
            // try the common method names; a no-op if the SDK lacks it.
            if (call) {
              try {
                if (typeof call.restartIce === 'function') call.restartIce();
                else if (typeof call.reconnect === 'function') call.reconnect();
                logToRN('restartIce requested');
              } catch (e) { logToRN('restartIce failed: ' + (e && e.message)); }
            }
            break;
          }
          default: break;
        }
      } catch (e) {
        post('cmdError', { cmd: cmd, message: (e && e.message) ? e.message : 'cmd failed' });
      }
    };

    // Re-play remote audio on any tap inside the webview (autoplay unlock).
    document.addEventListener('pointerdown', function () {
      playAllRemotes();
    }, { passive: true });

    // ---- audio-interruption auto-recovery (WhatsApp parity) ----
    // An incoming phone / WhatsApp / other VoIP call grabs the OS audio hardware
    // mid-call: the OS PAUSES our remote <video> elements and DISABLES our captured
    // mic track. When that other call ends nothing restarts our audio on its own —
    // both sides go silent ("awaz nahi aati / nahi jati"). Owning native audio focus
    // would fight the WebView's own WebRTC focus, so instead this watchdog re-plays
    // any paused remote stream and re-asserts the mic a few times a second, so audio
    // returns automatically the instant the interruption is over — with NO AppState
    // change required. Idempotent: play() on a playing element and enabling an
    // already-enabled track are no-ops, so this is cheap and safe to run always.
    setInterval(function () {
      try {
        // 1) Remote (incoming) audio — re-play any paused remote tile.
        var ids = Object.keys(tiles);
        for (var i = 0; i < ids.length; i++) {
          var t = tiles[ids[i]];
          var v = t && t.video;
          if (v && v.srcObject && v.paused) { try { v.play().catch(function () {}); } catch (e) {} }
        }
        // 1b) Locked-phone answer: the room was joined WITHOUT a mic producer
        //     (background WKWebView refused capture). Keep trying to produce it —
        //     capture starts working once CallKit's session is fully active or
        //     the user unlocks. ensureLocalAudio is idempotent + self-gating.
        if (call && typeof call.ensureLocalAudio === 'function'
            && Date.now() - lastEnsureAudioMs > 3000) {
          lastEnsureAudioMs = Date.now();
          try {
            call.ensureLocalAudio().then(function (ok) { if (ok) enableLocalMic(micWanted); });
          } catch (e) {}
        }
        // 2) Local (outgoing) mic — an interruption can leave the captured track
        //    disabled even though the user wants it ON; re-enable it (only while the
        //    track is still live). A track fully RELEASED by the OS (readyState
        //    'ended') can't be re-enabled — re-capture it via getUserMedia + swap it
        //    onto the sender so outbound audio isn't dead one-way (APP-12).
        if (micWanted && localStream && localStream.getAudioTracks) {
          var atracks = localStream.getAudioTracks() || [];
          var anyLive = false;
          atracks.forEach(function (a) {
            if (a && a.readyState === 'live') {
              anyLive = true;
              if (a.enabled === false) a.enabled = true;
            }
          });
          // Had audio tracks but none are live any more (all ended) → the mic was
          // released by the OS; re-capture it.
          if (!anyLive && atracks.length > 0) recaptureMic();
        }
        // 3) The recording-mix AudioContext (if any) can be left suspended.
        if (recCtx && recCtx.state === 'suspended' && recCtx.resume) {
          try { recCtx.resume().catch(function () {}); } catch (e) {}
        }
      } catch (e) { /* never let recovery throw */ }
    }, 1200);

    // Returning to the webview (interruption ended / app foregrounded) → re-play.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { try { playAllRemotes(); } catch (e) {} }
    });

    // Tap the video stage to swap the full-screen / PiP feeds (WhatsApp style).
    // Taps on the native RN controls never reach here (the overlay captures them),
    // so this only fires for taps on the video area itself. A drag of the PiP sets
    // justDragged so the trailing click doesn't also swap.
    if (stage) stage.addEventListener('click', function () {
      if (justDragged) { justDragged = false; return; }
      toggleSwap();
    });

    // The self-view PiP (and the remote PiP when swapped) is draggable to any of
    // the four corners — WhatsApp-style movable window.
    attachPipDrag(localWrap);
    attachPipDrag(remotes);

    post('log', { message: 'engine html loaded' });
  })();
  </script>
</body>
</html>`;
