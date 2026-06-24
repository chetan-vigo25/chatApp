/**
 * HTML for the WebView "call engine". This runs inside react-native-webview as
 * a real browser context (the only place the browser-only CallingSDK can run).
 *
 * Load order is mandated by the SDK: socket.io FIRST, then calling-sdk, then our
 * glue. The page is loaded with baseUrl https://call.vigorousit.com so it is a
 * secure context (required for getUserMedia) and the SDK's same-origin socket
 * resolves correctly.
 *
 * It renders the video tiles itself (MediaStream can only attach to a real
 * <video> element); React Native draws all call chrome as a native overlay on
 * top. Remote tiles are created/destroyed dynamically per peer so the same
 * engine serves both 1:1 and small group calls. For audio calls RN keeps this
 * WebView hidden — audio still plays through the <video> sinks.
 *
 * Audio output routing (speaker vs earpiece) is done with HTMLMediaElement
 * setSinkId() where the platform supports it (Android WebView / Chromium); on
 * iOS WKWebView the OS controls routing and setSinkId is a no-op.
 */

const SDK_ORIGIN = 'https://call.vigorousit.com';

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
  .hidden { display:none !important; }
</style>
</head>
<body>
  <div id="stage">
    <div id="remotes" class="count-1"></div>
    <div id="localWrap" class="hidden">
      <video id="local" autoplay playsinline muted class="mirror"></video>
    </div>
  </div>

  <script src="${SDK_ORIGIN}/socket.io/socket.io.js"></script>
  <script src="${SDK_ORIGIN}/sdk/calling-sdk.js"></script>
  <script>
  (function () {
    var remotes = document.getElementById('remotes');
    var local   = document.getElementById('local');
    var localWrap = document.getElementById('localWrap');
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
    var currentMedia = 'audio';// 'audio' | 'video' for the active call
    var tiles = {};            // peerId -> { wrap, video }
    var remoteStreams = {};    // peerId -> remote MediaStream (for the recording mix)
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
      if (n <= 1) remotes.classList.add('count-1');
      else remotes.classList.add('cols-2');
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
      var v = document.createElement('video');
      v.autoplay = true; v.playsInline = true; v.muted = false;
      // The moment the element actually starts playing audible media, tell RN to
      // drop any "Tap to enable audio" prompt — audio is live, no gesture needed.
      v.addEventListener('playing', function () { if (!v.muted) post('audioResumed', {}); });
      wrap.appendChild(v);
      remotes.appendChild(wrap);
      tiles[id] = { wrap: wrap, video: v };
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

    function clearTiles() {
      Object.keys(tiles).forEach(removeTile);
      tiles = {};
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
        var t = tileFor(peerId);
        try { t.video.srcObject = stream; } catch (e) {}
        // Keep the remote stream for the recording mix; wire it in if recording.
        if (peerId && stream) { remoteStreams[String(peerId)] = stream; recAddStream(stream); }
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
        post('stream', { peerId: peerId ? String(peerId) : null });
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
        if (id) removeTile(id);
        post('peerleft', { id: id });
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
      // Temporary WebRTC diagnostics — only fires when the SDK was built with
      // debug:true (passed on 'connect'). Surfaces PC/ICE/DTLS transitions,
      // candidate-type counts and periodic getStats to the RN log stream.
      call.on('debug', function (d) {
        if (!d) return;
        logToRN('[RTC] ' + d.tag + ' ' + (d.data ? JSON.stringify(d.data) : ''));
        post('rtcDebug', d);
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
            if (typeof CallingSDK === 'undefined') {
              post('connectError', { message: 'CallingSDK failed to load' });
              return;
            }
            logToRN('connecting to ' + (msg.url || '${SDK_ORIGIN}'));
            call = new CallingSDK({ url: msg.url || '${SDK_ORIGIN}', token: msg.token, debug: !!msg.debug });
            wireEvents();
            Promise.resolve(call.connect()).then(function () {
              logToRN('engine connected — SDK ready');
              post('engineReady', {});
            }).catch(function (e) {
              logToRN('connect failed: ' + (e && e.message));
              post('connectError', { message: (e && e.message) ? e.message : 'connect failed' });
            });
            break;
          }
          case 'startCall': {
            if (!call) { post('startCallError', { ref: msg.ref, message: 'not connected' }); return; }
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
            if (call) Promise.resolve(call.accept(msg.callId))
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
            // Hide the self-preview when the camera is off.
            try { if (!!msg.on) localWrap.classList.remove('hidden'); else localWrap.classList.add('hidden'); } catch (e) {}
            logToRN('toggleCamera → ' + (!!msg.on ? 'ON' : 'OFF') + ' (videoTracks=' + camN + ')');
            break;
          }
          case 'switchCamera': {
            if (call) Promise.resolve(call.switchCamera()).then(function (facing) {
              localFacing = facing || localFacing; applyLocalMirror();
            }).catch(function(){});
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
          case 'setSpeaker': { wantSpeaker = !!msg.on; applySpeakerPreference(); break; }
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
