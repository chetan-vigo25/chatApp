import { CMD, EVT } from '../engine/protocol';
import { ensureWebrtcGlobals, audioSessionDidActivate, getWebrtc } from './webrtcGlobals';
import NativeCallingSDK from './NativeCallingSDK';
import * as AudioRoute from './AudioRoute';
import * as registry from './streamRegistry';

/**
 * Native call engine — drop-in replacement for the WebView engine behind the
 * protocol.js CMD/EVT seam. Full port of the WebView glue (callEngineHtml.js
 * window.__cmd switch + wireEvents), driving NativeCallingSDK instead of the
 * in-page CallingSDK. Every event reaches CallProvider.onEngineEvent with the
 * SAME name and payload shape the WebView posted.
 *
 * WebView-era machinery that is intentionally NOT ported: resumeAudio/autoplay
 * unlock, sink juggling, the audio-interruption watchdog. RESTART_AUDIO *is*
 * kept, but natively it means "sync RTCAudioSession with the CallKit-activated
 * session + repair an OS-ended mic track" rather than the WebView's full
 * pipeline rebuild. Speaker routing = AudioRoute (InCallManager);
 * video rendering = streamRegistry → NativeVideoStage (RTCView).
 *
 * Screen share: NATIVE via react-native-webrtc getDisplayMedia — real on
 * Android (MediaProjection + the library's bundled foreground service; the
 * WebView engine could never do this, Android WebView has no getDisplayMedia).
 * iOS rejects without a ReplayKit broadcast extension → reported `unsupported`
 * and the UI shows the "not supported" alert. Recording: unsupported on-device
 * — the admin "Listen Live" pipeline moves server-side (mediasoup recording
 * REST), per the migration plan's R1 decision.
 */
const toIdList = (to) => {
  if (to == null) return [];
  const arr = Array.isArray(to) ? to : [to];
  return arr.map((x) => String(x)).filter(Boolean);
};

class NativeCallEngine {
  constructor() {
    this._listeners = [];
    this._sdk = null;
    this._currentMedia = 'audio';
    this._micWanted = true;
    this._camWanted = true; // user's last camera choice for the current call
    this._localFacing = 'user';
  }

  subscribe(fn) {
    this._listeners.push(fn);
    return () => { this._listeners = this._listeners.filter((f) => f !== fn); };
  }

  _post(type, payload = {}) {
    this._listeners.forEach((fn) => { try { fn(type, payload); } catch (_) {} });
  }

  _log(message) {
    this._post(EVT.LOG, { message: `[native-engine] ${message}` });
  }

  // Track-level mic enable (glue's enableLocalMic): reliable mute/unmute
  // regardless of producer state; returns the audio-track count for logs.
  _enableLocalMic(on) {
    const s = this._sdk && this._sdk._localStream;
    if (!s) return 0;
    let n = 0;
    try { s.getAudioTracks().forEach((t) => { t.enabled = !!on; n += 1; }); } catch (_) {}
    return n;
  }

  _enableLocalCamera(on) {
    const s = this._sdk && this._sdk._localStream;
    if (!s) return 0;
    let n = 0;
    try { s.getVideoTracks().forEach((t) => { t.enabled = !!on; n += 1; }); } catch (_) {}
    return n;
  }

  _teardownCallState() {
    AudioRoute.stop();
    registry.clearAll();
    this._currentMedia = 'audio';
    this._micWanted = true;
    this._camWanted = true;
  }

  /** protocol.js command entry — same payloads as the WebView injection path. */
  cmd(msg) {
    const c = msg && msg.cmd;
    try {
      switch (c) {
        case CMD.CONNECT: { this._connect(msg); return; }

        case CMD.PING: {
          // The client-side "connected" flag LIES on a half-open socket
          // (backgrounded device, NAT idle drop): the server keeps emitting
          // rings into the dead socket while this side never reconnects — the
          // callee accepted but their engine never heard the SFU ring (stuck
          // "Connecting…" → 30s watchdog). So pong only reports connected
          // after a REAL server round trip (1.5s bound — inside the provider's
          // 2s ping window); a dead socket reports connected:false and
          // ensureConnected rebuilds the connection.
          const sdk = this._sdk;
          if (!sdk || !sdk._socket || !sdk._socket.connected) {
            this._post(EVT.PONG, { ref: msg.ref, hasCall: !!sdk, connected: false });
            return;
          }
          sdk.verifyAlive(1500).then((ok) => {
            this._post(EVT.PONG, { ref: msg.ref, hasCall: true, connected: !!ok });
          });
          return;
        }

        case CMD.START_CALL: {
          if (!this._sdk) {
            this._post(EVT.CONNECT_ERROR, { message: 'engine had no SDK at dial time' });
            this._post(EVT.START_CALL_ERROR, { ref: msg.ref, message: 'Call engine restarting — please try again' });
            return;
          }
          const targets = toIdList(msg.to);
          this._currentMedia = (msg.media === 'video') ? 'video' : 'audio';
          this._log(`startCall → [${targets.join(',')}] media=${this._currentMedia}`);
          AudioRoute.start({ video: this._currentMedia === 'video' });
          if (msg.speaker) AudioRoute.setSpeaker(true);
          Promise.resolve(this._sdk.startCall(targets, msg.media)).then((res = {}) => {
            this._enableLocalMic(true);
            if (this._currentMedia === 'video') this._enableLocalCamera(true);
            const offline = Array.isArray(res.offline) ? res.offline.map(String)
              : (res.offline ? [String(targets[0] || '')] : []);
            this._log(`startCall ok callId=${res.callId || 'none'}${offline.length ? ` OFFLINE=${offline.join(',')}` : ''}`);
            this._post(EVT.START_CALL_RESULT, { ref: msg.ref, callId: res.callId || null, offline });
          }).catch((e) => {
            this._log(`startCall error: ${e && e.message}`);
            AudioRoute.stop();
            this._post(EVT.START_CALL_ERROR, { ref: msg.ref, message: (e && e.message) ? e.message : 'startCall failed' });
          });
          return;
        }

        case CMD.ACCEPT: {
          if (!this._sdk) { this._post(EVT.CMD_ERROR, { cmd: c, message: 'not connected' }); return; }
          if (msg.media) this._currentMedia = (msg.media === 'video') ? 'video' : 'audio';
          this._log(`accept → callId=${msg.callId} media=${this._currentMedia} speaker=${!!msg.speaker}`);
          AudioRoute.start({ video: this._currentMedia === 'video' });
          if (msg.speaker) AudioRoute.setSpeaker(true);
          Promise.resolve(this._sdk.accept(msg.callId, msg.media, { isGroup: msg.isGroup, peerId: msg.peerId }))
            .then(() => {
              this._enableLocalMic(true);
              if (this._currentMedia === 'video') this._enableLocalCamera(true);
              this._log(`accept ok — establishing media (mic on, cam=${this._currentMedia === 'video' ? 'on' : 'n/a'})`);
            })
            .catch((e) => {
              this._log(`accept failed: ${e && e.message}`);
              AudioRoute.stop();
              this._post(EVT.CMD_ERROR, { cmd: c, message: String(e && e.message) });
            });
          return;
        }

        case CMD.REJECT: {
          if (this._sdk) this._sdk.reject(msg.callId);
          return;
        }

        case CMD.HANGUP: {
          if (this._sdk) this._sdk.hangup();
          this._teardownCallState();
          return;
        }

        case CMD.TOGGLE_MIC: {
          this._micWanted = !!msg.on;
          if (this._sdk) { try { this._sdk.toggleMic(!!msg.on); } catch (_) {} }
          const n = this._enableLocalMic(!!msg.on);
          this._log(`toggleMic → ${msg.on ? 'ON' : 'OFF'} (audioTracks=${n})`);
          return;
        }

        case CMD.TOGGLE_CAMERA: {
          this._camWanted = !!msg.on;
          if (this._sdk) { try { this._sdk.toggleCamera(!!msg.on); } catch (_) {} }
          const n = this._enableLocalCamera(!!msg.on);
          registry.refreshLocal();
          this._log(`toggleCamera → ${msg.on ? 'ON' : 'OFF'} (videoTracks=${n})`);
          return;
        }

        case CMD.SWITCH_CAMERA: {
          if (!this._sdk) return;
          Promise.resolve(this._sdk.switchCamera()).then((facing) => {
            this._localFacing = facing || this._localFacing;
            registry.setLocalFacing(this._localFacing);
          }).catch(() => {});
          return;
        }

        case CMD.INVITE_TO_GROUP: {
          if (!this._sdk) return;
          Promise.resolve(this._sdk.inviteToGroup(msg.ids || []))
            .then(() => this._log('group invite sent'))
            .catch((e) => this._log(`group invite failed: ${e && e.message}`));
          return;
        }

        case CMD.STOP_INVITE: {
          if (this._sdk && msg.id) { try { this._sdk.stopInviting(msg.id); } catch (_) {} }
          return;
        }

        case CMD.QUERY_PRESENCE: {
          if (!this._sdk) { this._post(EVT.PRESENCE_RESULT, { ref: msg.ref, map: {} }); return; }
          Promise.resolve(this._sdk.queryPresence(msg.ids || []))
            .then((map) => this._post(EVT.PRESENCE_RESULT, { ref: msg.ref, map: map || {} }))
            .catch(() => this._post(EVT.PRESENCE_RESULT, { ref: msg.ref, map: {} }));
          return;
        }

        case CMD.SET_SPEAKER: {
          AudioRoute.setSpeaker(!!msg.on);
          this._post(EVT.SPEAKER_RESULT, { speaker: !!msg.on, supported: AudioRoute.isAvailable(), deviceId: null });
          return;
        }

        case CMD.RESTART_ICE: {
          if (this._sdk) { try { this._sdk.restartIce(); this._log('restartIce requested'); } catch (e) { this._log(`restartIce failed: ${e && e.message}`); } }
          return;
        }

        case CMD.RESTART_AUDIO: {
          // Fired on CallKit audio-session activation and foreground return.
          // Sync WebRTC's RTCAudioSession with the now-active session (restarts
          // its audio unit if it started against the dead pre-CallKit session),
          // then repair an OS-ended mic track and re-assert the mute state.
          const synced = audioSessionDidActivate();
          this._log(`restartAudio: session sync ${synced ? 'ok' : 'skipped'}`);
          if (this._sdk && typeof this._sdk.restartAudio === 'function') {
            this._sdk.restartAudio()
              .then((recaptured) => {
                if (recaptured) this._log('audio pipeline recovered (mic re-captured)');
                this._enableLocalMic(this._micWanted);
              })
              .catch((e) => this._log(`restartAudio failed: ${e && e.message}`));
          }
          // VIDEO repair on the same trigger: a background/CallKit answer can't
          // capture the camera (audio-only downgrade) and backgrounding can
          // OS-end a live camera track. toggleCamera(true) is the idempotent
          // repair — it captures+produces / replaceTracks only when needed, and
          // a still-backgrounded attempt fails harmlessly (retried on the
          // provider's foreground pass). Never fights the user: only when the
          // camera is WANTED on.
          if (this._sdk && this._currentMedia === 'video' && this._camWanted) {
            try { this._sdk.toggleCamera(true); } catch (_) {}
            registry.refreshLocal();
          }
          return;
        }

        // Browser autoplay-unlock concept — nothing to do natively.
        case CMD.RESUME_AUDIO:
          return;

        case CMD.TOGGLE_SCREEN: {
          if (!this._sdk) { this._post(EVT.CMD_ERROR, { cmd: c, message: 'not connected' }); return; }
          if (msg.on) {
            this._sdk.startScreenShare()
              .then(() => this._post(EVT.SCREEN_SHARE_STARTED, {}))
              .catch((e) => this._post(EVT.SCREEN_SHARE_ERROR, {
                message: (e && e.message) || 'Could not share the screen',
                unsupported: !!(e && e.unsupported),
              }));
          } else {
            this._sdk.stopScreenShare()
              .then(() => this._post(EVT.SCREEN_SHARE_STOPPED, {}))
              .catch(() => this._post(EVT.SCREEN_SHARE_STOPPED, {}));
          }
          return;
        }

        case CMD.START_RECORDING: {
          // On-device recording is a WebView-MediaRecorder feature; the native
          // path records SERVER-SIDE (mediasoup recording REST). Best-effort
          // consumer (callRecordingService) treats this as a clean no-start.
          this._post(EVT.RECORDING_ERROR, { message: 'on-device recording unavailable (native engine — use server-side recording)', unsupported: true });
          return;
        }
        case CMD.STOP_RECORDING:
          return;

        default:
          this._log(`unknown command '${String(c)}'`);
      }
    } catch (e) {
      this._post(EVT.CMD_ERROR, { cmd: c, message: (e && e.message) ? e.message : 'cmd failed' });
    }
  }

  _connect({ url, token, userId, name, iceServers }) {
    this._log('engine build 2026-07-14a (camera-recovery+swap+track-keys)');
    if (!ensureWebrtcGlobals()) {
      this._post(EVT.CONNECT_ERROR, { message: 'react-native-webrtc native module unavailable (rebuild the dev client)' });
      return;
    }
    // REUSE a live, registered SDK when the identity + server are unchanged.
    // The old unconditional teardown dropped the PRE-WARMED socket at every
    // call start (server logs: connected → disconnected → connected) and
    // burned ~1s re-handshaking before joinRoom — and a CONNECT arriving
    // during a LIVE call killed the call outright. A token refresh doesn't
    // need a reconnect: the token is only read at joinRoom time.
    {
      const sdk = this._sdk;
      const reuseUrl = String(url || '').replace(/\/+$/, '');
      if (sdk && sdk._socket && sdk._socket.connected && sdk._registered
          && String(sdk.userId) === String(userId || sdk.userId)
          && sdk.url === reuseUrl) {
        if (typeof token === 'string' && token.split('.').length === 3) sdk._token = token;
        if (Array.isArray(iceServers) && iceServers.length) sdk._fallbackIceServers = iceServers;
        // `connected` can lie on a backgrounded app (half-open TCP) — verify
        // with a real round trip before trusting the socket; the probe doubles
        // as a registration refresh. Dead → fall through to a fresh build.
        sdk.verifyAlive(2500).then((ok) => {
          if (this._sdk !== sdk) return; // superseded meanwhile
          if (ok) {
            this._log('connect: reusing live engine socket (identity unchanged, probe ok)');
            this._post(EVT.ENGINE_READY, { screenShare: this._screenShareSupported() });
          } else {
            this._log('connect: reuse probe FAILED — rebuilding the engine socket');
            this._connectFresh({ url, token, userId, name, iceServers });
          }
        });
        return;
      }
    }
    this._connectFresh({ url, token, userId, name, iceServers });
  }

  _connectFresh({ url, token, userId, name, iceServers }) {
    // Tear down any PREVIOUS instance first (token refresh / re-login) so only
    // the fresh instance is ever wired — a stale one could post ghost events
    // for a dead call (WebView glue APP-7 rule).
    if (this._sdk) {
      try { this._sdk.hangup(); } catch (_) {}
      try { this._sdk.disconnect(); } catch (_) {}
      this._sdk = null;
    }
    this._teardownCallState();
    this._log(`connecting to ${url}`);
    const sdk = new NativeCallingSDK({
      url, token, userId, name, iceServers: iceServers || null, onLog: (m) => this._log(m),
    });
    this._sdk = sdk;
    this._wireEvents(sdk);
    Promise.resolve(sdk.connect()).then(() => {
      if (this._sdk !== sdk) return; // superseded by a newer connect
      this._log('engine connected — SDK ready');
      this._post(EVT.ENGINE_READY, { screenShare: this._screenShareSupported() });
    }).catch((e) => {
      this._log(`connect failed: ${e && e.message}`);
      if (this._sdk === sdk) { try { sdk.disconnect(); } catch (_) {} this._sdk = null; }
      this._post(EVT.CONNECT_ERROR, { message: (e && e.message) ? e.message : 'connect failed' });
    });
  }

  // Whether THIS device can CAPTURE the screen (receiving always works).
  // Android: react-native-webrtc ships getDisplayMedia (MediaProjection).
  // iOS: needs a ReplayKit broadcast extension the app doesn't bundle.
  _screenShareSupported() {
    const webrtc = getWebrtc();
    return !!(webrtc && webrtc.mediaDevices && typeof webrtc.mediaDevices.getDisplayMedia === 'function');
  }

  /** Port of the WebView glue's wireEvents() — SDK events → EVT posts. */
  _wireEvents(sdk) {
    // System-initiated share stop (status-bar chip / OS notification) — the
    // SDK mirrors the ended track as a clean stop; reflect it in the UI flag.
    sdk.on('screenshare', (p) => {
      this._post(p && p.on ? EVT.SCREEN_SHARE_STARTED : EVT.SCREEN_SHARE_STOPPED, {});
    });
    sdk.on('localstream', (stream) => {
      const micCount = this._enableLocalMic(true);
      let camCount = 0;
      const isVideo = this._currentMedia === 'video';
      if (isVideo) camCount = this._enableLocalCamera(true);
      registry.setLocalStream(stream, this._localFacing);
      this._log(`localstream captured — audio:${micCount} video:${camCount} — mic enabled (audioTracks=${micCount}) cam=${isVideo ? 'on' : 'n/a'}`);
      this._post(EVT.LOCALSTREAM, { mic: micCount > 0, camera: camCount > 0, media: this._currentMedia });
    });

    sdk.on('stream', (data) => {
      const peerId = data && data.peerId != null ? String(data.peerId) : null;
      const stream = data && data.stream;
      const source = (data && data.source) || null;
      const isScreen = source === 'screen';
      const streamKey = isScreen ? `${peerId}#screen` : peerId;
      registry.setRemoteStream(streamKey, peerId, stream, source);
      // Re-assert OUR mic per the user's last choice now the call connected.
      this._enableLocalMic(this._micWanted);
      if (this._currentMedia === 'video') this._enableLocalCamera(true);
      let hasVideo = false;
      try { hasVideo = !!(stream && stream.getVideoTracks && stream.getVideoTracks().length); } catch (_) {}
      this._log(`remote stream from ${peerId || '?'} — video:${hasVideo ? 1 : 0} (local mic re-asserted)`);
      this._post(EVT.STREAM, { peerId, video: hasVideo, source });
    });

    sdk.on('streamremoved', (data) => {
      if (data && data.source === 'screen' && data.peerId) {
        registry.removeRemote(`${String(data.peerId)}#screen`);
      }
    });

    // A remote stream's track set changed in place (peer camera off / rejoin
    // re-produce) — re-read hasVideo so the tile appears/disappears live.
    sdk.on('streamchanged', (data) => {
      if (data && data.streamKey) registry.refreshRemote(String(data.streamKey));
    });

    sdk.on('mediaupgraded', () => {
      this._currentMedia = 'video';
      this._camWanted = true;
      this._enableLocalCamera(true);
      registry.refreshLocal();
      this._log('audio call upgraded to VIDEO (self camera on)');
      this._post('mediaUpgraded', { media: 'video' });
    });

    sdk.on('mediaupgradefailed', (d) => {
      this._post('mediaUpgradeFailed', { message: (d && d.message) || 'Could not start the camera' });
    });

    sdk.on('incoming', (info = {}) => {
      const from = info.from || {};
      this._log(`SDK incoming callId=${info.callId || '?'} from=${from.id || '?'} media=${info.media || 'audio'}`);
      this._post(EVT.INCOMING, {
        callId: info.callId || null,
        from: { id: from.id ? String(from.id) : null, name: from.name || '' },
        media: info.media || 'audio',
        isGroup: !!info.isGroup,
        groupId: info.groupId != null ? String(info.groupId) : null,
        groupName: info.groupName || null,
        members: Array.isArray(info.members) ? info.members : [],
      });
    });

    sdk.on('peerleft', (data) => {
      const id = (data && data.id) ? String(data.id) : null;
      if (id) registry.dropPeer(id);
      this._post(EVT.PEERLEFT, { id });
    });

    sdk.on('ended', () => { this._teardownCallState(); this._post(EVT.ENDED, {}); });
    sdk.on('rejected', (info) => { this._teardownCallState(); this._post(EVT.REJECTED, info || {}); });
    sdk.on('cancelled', () => { this._post(EVT.CANCELLED, {}); });

    sdk.on('camerachanged', (data = {}) => {
      this._localFacing = data.facingMode || this._localFacing;
      registry.setLocalFacing(this._localFacing);
      this._post(EVT.CAMERACHANGED, { facingMode: this._localFacing });
    });

    sdk.on('activespeaker', (data) => {
      this._post('activeSpeaker', { peerId: (data && data.peerId) || null });
    });

    sdk.on('error', (err) => {
      this._post(EVT.ERROR, { message: (err && err.message) ? err.message : 'call error' });
    });

    // Mid-call media-layer up/down (network resilience) — RN de-dupes.
    sdk.on('disconnected', (d) => { this._post(EVT.MEDIA_DOWN, { reason: (d && d.reason) || null }); });
    sdk.on('connected', (d) => { this._post(EVT.MEDIA_UP, { reason: (d && d.reason) || null }); });
  }

  /** Logout/unmount teardown (CallProvider auth effect). */
  shutdown() {
    if (this._sdk) {
      try { this._sdk.hangup(); } catch (_) {}
      try { this._sdk.disconnect(); } catch (_) {}
      this._sdk = null;
    }
    this._teardownCallState();
  }
}

// Single engine instance per JS runtime — mirrors the single persistent
// WebView the WebView architecture keeps mounted.
const engine = new NativeCallEngine();
export default engine;
