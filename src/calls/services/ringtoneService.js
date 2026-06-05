import { Audio } from 'expo-av';

/**
 * Ringtone / ringback playback for the calling feature.
 *
 *  - Incoming call (callee, "user B"): loud, looping ringtone until the call is
 *    answered, rejected, or times out.
 *  - Outgoing call (caller): a classic telephone RINGBACK tone (dual 440+480Hz
 *    double-ring cadence, like a normal phone ringing) looped so the caller hears
 *    the other side being rung — same feel as a mobile/landline ringing tone.
 *
 * Audio routing is configured so the ringtone is audible even when the phone is
 * on silent (iOS) and is not ducked away on Android. We keep a single active
 * Sound instance and always stop/unload the previous one before starting a new
 * one, so a fast call → reject → call sequence can never stack tones.
 *
 * A monotonically increasing `gen` token guards the async createAsync(): if a
 * stop()/new start() happened while a sound was loading, the stale sound is
 * unloaded immediately instead of looping forever.
 */

// We ship these in assets/sounds. Looping a short clip gives a continuous ring.
const RINGTONE = require('../../../assets/sounds/notification_sound.wav');
// Caller ringback = a real telephone ringing tone (440+480Hz dual tone, 3s
// double-ring cadence) that loops seamlessly — sounds like a phone ringing.
const RINGBACK = require('../../../assets/sounds/call_ringback.wav');

let activeSound = null;
let gen = 0;

const configureAudioMode = async () => {
  try {
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      shouldDuckAndroid: false,
      staysActiveInBackground: false,
    });
  } catch (_) { /* best-effort */ }
};

const start = async (asset, volume) => {
  const myGen = ++gen; // invalidates any in-flight load and the current sound
  const prev = activeSound;
  activeSound = null;
  if (prev) {
    try { await prev.stopAsync(); } catch (_) {}
    try { await prev.unloadAsync(); } catch (_) {}
  }
  await configureAudioMode();
  try {
    const { sound } = await Audio.Sound.createAsync(asset, {
      shouldPlay: true,
      isLooping: true,
      volume,
    });
    // A stop() or newer start() superseded us while loading → discard.
    if (myGen !== gen) {
      try { await sound.stopAsync(); } catch (_) {}
      try { await sound.unloadAsync(); } catch (_) {}
      return;
    }
    activeSound = sound;
  } catch (_) { /* best-effort: vibration still covers the alert */ }
};

export const playRingtone = () => start(RINGTONE, 1.0);

export const playRingback = () => start(RINGBACK, 0.7);

export const stopRingtone = async () => {
  gen += 1; // cancel any in-flight load
  const s = activeSound;
  activeSound = null;
  if (!s) return;
  try { await s.stopAsync(); } catch (_) {}
  try { await s.unloadAsync(); } catch (_) {}
};
