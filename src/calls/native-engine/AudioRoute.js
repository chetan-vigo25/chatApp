import { Platform } from 'react-native';

/**
 * Call audio routing for the NATIVE engine via react-native-incall-manager.
 *
 * Replaces (on the native path only) BOTH WebView-era mechanisms: expo-av's
 * setAudioModeAsync session juggling AND the engine's setSinkId speaker hack.
 * InCallManager owns the platform call-audio session: earpiece by default,
 * proximity sensor, loudspeaker on demand, Bluetooth/headset auto-routing.
 *
 * With CallKit, iOS activates the audio session itself (didActivateAudioSession)
 * — react-native-webrtc's RTCAudioSession cooperates with that natively, which
 * is precisely the reliability win of this migration. InCallManager here only
 * handles ROUTING (speaker/earpiece), started at call setup and stopped at end.
 *
 * Lazy + guarded require (nativeCallService pattern): a bundle running where
 * the pod was never compiled must not crash — every method quietly no-ops.
 */
let InCallManager = null;
let probed = false;

const get = () => {
  if (!probed) {
    probed = true;
    try {
      // eslint-disable-next-line global-require
      InCallManager = require('react-native-incall-manager').default
        || require('react-native-incall-manager');
    } catch (_) {
      InCallManager = null;
    }
  }
  return InCallManager;
};

let started = false;

/** Call setup (dial or accept). Video calls default to the loudspeaker. */
export const start = ({ video = false } = {}) => {
  const icm = get();
  if (!icm || started) return;
  started = true;
  try {
    // iOS: CallKit owns AVAudioSession activation and category — icm.start()
    // re-categorizes/re-activates the session right when CallKit is handing it
    // over, intermittently killing the WebRTC audio unit (the "connected but
    // silent" lock-screen answers). Routing only here; the session itself is
    // CallKit + RTCAudioSession.audioSessionDidActivate (webrtcGlobals).
    if (Platform.OS === 'ios') {
      if (video) icm.setForceSpeakerphoneOn(true);
      return;
    }
    icm.start({ media: video ? 'video' : 'audio' });
    if (video) icm.setForceSpeakerphoneOn(true);
  } catch (_) { /* no-op */ }
};

/** Explicit Speaker toggle (SET_SPEAKER cmd). */
export const setSpeaker = (on) => {
  const icm = get();
  if (!icm) return;
  try {
    if (Platform.OS === 'ios') icm.setForceSpeakerphoneOn(!!on);
    else icm.setSpeakerphoneOn(!!on);
  } catch (_) { /* no-op */ }
};

/**
 * iOS forced route BOUNCE — flip to the opposite output and straight back.
 * This is the repair the manual Speaker toggle performs implicitly: the
 * AVAudioSession route CHANGE restarts iOS's voice-processing audio unit when
 * it was started against the pre-CallKit (dead) session. Re-asserting the
 * SAME route (off→off) changes nothing at the session level, which is why the
 * plain reassert passes can leave the caller silent while one Speaker tap
 * fixes it. Final state is always `on` — the user's choice is never changed.
 */
export const bounceRoute = (on, delayMs = 250) => {
  const icm = get();
  if (!icm || Platform.OS !== 'ios') return;
  try {
    icm.setForceSpeakerphoneOn(!on);
    setTimeout(() => {
      try { icm.setForceSpeakerphoneOn(!!on); } catch (_) { /* no-op */ }
    }, delayMs);
  } catch (_) { /* no-op */ }
};

/** Call teardown — release routing back to the OS default. */
export const stop = () => {
  const icm = get();
  if (!icm || !started) return;
  started = false;
  try {
    icm.setForceSpeakerphoneOn(false);
    // iOS never called icm.start() (CallKit owns the session) — a bare stop()
    // would deactivate the session out from under CallKit's own teardown.
    if (Platform.OS !== 'ios') icm.stop();
  } catch (_) { /* no-op */ }
};

export const isAvailable = () => !!get();
