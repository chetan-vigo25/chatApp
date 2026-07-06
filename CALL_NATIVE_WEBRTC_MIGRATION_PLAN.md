# Native WebRTC migration — plan

**Goal:** iOS incoming calls ring on the **native CallKit screen even when the
phone is locked / the app is killed**, AND the call audio works on answer.

**Why a migration is required (not a flag):** today's call media runs inside a
**WKWebView** (a proprietary browser-only `CallingSDK`). iOS has ONE process-global
`AVAudioSession`. When CallKit answers a call it seizes that session; a WKWebView's
WebRTC audio unit is owned by WebKit and cannot be re-coordinated with CallKit, so
the media goes silent. **Native `react-native-webrtc` owns an `RTCAudioSession`
that CAN share CallKit's session** — this is the only way to have both the native
lock-screen ring and working audio (it's exactly how WhatsApp does it).

---

## 1. Current architecture (what exists today)

```
CallProvider.jsx  ──CMD/EVT (protocol.js)──►  CallEngineWebView.jsx
   (all call state,                              └─ WKWebView loads callEngineHtml.js
    ringing UI, CallKit,                            ├─ socket.io.js         (from call.vigorousit.com)
    audio session,                                  ├─ sdk/calling-sdk.js   (PROPRIETARY, minified)
    push, recording)                                └─ glue: new CallingSDK({url,token}) + call.on(...)
                                                          ▲
                                          socket.io  ─────┘  signaling + SDP/ICE to call.vigorousit.com
```

- **The clean seam:** `src/calls/engine/protocol.js` defines the entire RN↔engine
  contract — `CMD.*` (connect, startCall, accept, reject, hangup, toggleMic,
  toggleCamera, switchCamera, setSpeaker, restartIce, resumeAudio, queryPresence,
  start/stopRecording) and `EVT.*` (engineReady, localstream, stream, incoming,
  ended, rejected, cancelled, peerleft, presence, mediaDown/Up, camerachanged,
  recording*, …). **CallProvider only knows this contract — not WebRTC.**
- **The engine (to be replaced):** `callEngineHtml.js` (~1000 lines) + the
  `CallEngineWebView.jsx` host. All the WebRTC lives behind the `CallingSDK` object:
  `new CallingSDK({url, token, debug})`, then `call.startCall/accept/reject/hangup`
  and `call.on('localstream'|'stream'|'incoming'|'ended'|…)`.
- Supports **1:1 and small group** (up to 4/group) audio + video, plus on-device
  recording (admin "Listen Live"), presence, ICE restart on network change.

## 2. 🚨 THE CRITICAL DEPENDENCY (this gates everything)

The `CallingSDK` is a **closed, minified, browser-only** script served from
`call.vigorousit.com/sdk/calling-sdk.js`. It speaks an **undocumented signaling
protocol** (socket.io events + SDP/ICE exchange) to that server. To run the media
natively we must **re-implement that exact client protocol on top of
`react-native-webrtc`** — the RN client must talk the SAME socket.io signaling to
`call.vigorousit.com` that the SDK does.

**Nothing else in the migration is hard; THIS is.** Before any code, we need ONE of:

| Option | What it gives | Effort |
|---|---|---|
| **A. Vendor provides the signaling protocol spec** (the `vigorousit` calling team) — the socket.io event names, payloads, and SDP/ICE handshake order | We reimplement the client cleanly on react-native-webrtc | Best case |
| **B. Vendor provides a React-Native-compatible SDK** (or the SDK source so we can strip the browser-only bits) | We wrap their SDK, minimal protocol work | Best case if it exists |
| **C. Reverse-engineer the protocol** by capturing the WebView's socket.io traffic during a real call | Works without vendor help, but slow + brittle to server changes | Weeks, risky |

➡️ **First action is a decision/ask to the `call.vigorousit.com` (vigorousit)
team, NOT code.** Get A or B if at all possible.

## 3. Migration strategy — keep the seam, swap the engine

The `protocol.js` CMD/EVT contract is the migration's best friend: **CallProvider
and all UI stay essentially unchanged.** We build a new native engine that honours
the same contract, then flip a source to use it instead of the WebView.

New module (proposed): `src/calls/engine/nativeEngine.js` — a JS object exposing
the same surface CallProvider already drives, but implemented with:
- `react-native-webrtc` (`RTCPeerConnection`, `mediaDevices.getUserMedia`,
  `MediaStream`, `RTCView` for video tiles),
- a `socket.io-client` connection to `call.vigorousit.com` speaking the protocol
  from §2,
- `@config-plugins/react-native-webrtc` (Expo config plugin) for the native
  build + iOS mic/camera background entitlements.

Then CallKit can stay ON and coordinate with react-native-webrtc's
`RTCAudioSession` (start audio in `didActivateAudioSession`, which we already wire
in `nativeCallService`).

## 4. Phased plan

- **Phase 0 — Protocol (BLOCKER):** obtain the CallingSDK signaling protocol (§2,
  option A/B/C). Deliverable: a written spec of socket.io events + SDP/ICE order.
- **Phase 1 — Native deps + build:** add `react-native-webrtc` +
  `@config-plugins/react-native-webrtc`, prebuild, verify a bare
  getUserMedia + loopback `RTCPeerConnection` works on a physical iPhone/Android.
- **Phase 2 — Native engine (1:1 audio):** implement `nativeEngine.js` against the
  `protocol.js` contract — connect, startCall, accept, reject, hangup, toggleMic,
  the `localstream`/`stream`/`incoming`/`ended` events. Ship behind a flag
  (`USE_NATIVE_ENGINE`) so the WebView stays the default until proven.
- **Phase 3 — Video + group:** camera on/off, switch camera, the multi-peer
  `stream` tiles, speaker routing.
- **Phase 4 — CallKit re-enable + audio coordination:** flip
  `IOS_CALLKIT_ENABLED = true`, wire react-native-webrtc audio start to
  `didActivateAudioSession`, verify audio on a **locked/killed** answer.
  Re-enable the backend iOS **VoIP** push (undo the "alert-only" interim in
  CALL_PUSH_BACKEND_SPEC.md).
- **Phase 5 — Parity items:** ICE restart on network change, on-device recording
  ("Listen Live"), presence, silent-switch audio, interruption recovery — port
  each from the WebView engine.
- **Phase 6 — Cutover:** make native the default, keep the WebView as a fallback
  for one release, then remove `callEngineHtml.js` / `CallEngineWebView.jsx`.

## 5. Risks / notes

- **Group calls:** if `call.vigorousit.com` is an SFU (server-side mixing), the
  native client must implement the SFU's publish/subscribe protocol, not just
  1:1 offer/answer — raises Phase 3 cost. Confirm SFU vs mesh in Phase 0.
- **Recording ("Listen Live"):** currently mixes remote streams in the WebView;
  native needs an equivalent capture path.
- **react-native-webrtc + Expo:** requires a dev/EAS build (native module); does
  nothing in Expo Go — same constraint as CallKit already.
- **Effort:** realistically a multi-week project dominated by Phase 0 + Phases 2–4.
  The clean `protocol.js` seam keeps CallProvider/UI churn low.

## 6. What's needed to start

1. **Decision on §2** — can the `vigorousit` calling team give us the signaling
   protocol spec (A) or an RN-capable SDK/source (B)? This unblocks everything.
2. Confirm **SFU vs mesh** for group calls.
3. Green-light Phase 1 (add react-native-webrtc, new dev build).

Until Phase 4 lands, keep the current interim: **CallKit OFF, iOS rings via the
in-app UI + notification, backend sends the iOS ALERT push (not VoIP)** — see
CALL_PUSH_BACKEND_SPEC.md.
