import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { setServerClockOffset } from '../../../modules/expo-call-ui';
import { learnServerOffset } from '../callPushGuards';

/**
 * callServerClock (P-C-16) — the server-minus-device clock offset, learned from
 * the backend `ts` of a call ring that arrived LIVE over the socket. Call-push
 * staleness is judged on server time (classifyCallPush) so a phone whose clock
 * runs fast no longer drops live calls. Persisted so a cold start from a push
 * (before any socket ring) still has it, and mirrored to the Android native FCM
 * service. Pure maths lives in ../callPushGuards.js (unit-tested).
 */
const STORAGE_KEY = '@call/serverClockOffsetMs';
// Persist/mirror only when the estimate moved by more than this.
const PERSIST_DELTA_MS = 1000;

let offsetMs; // undefined = never learned

const mirrorToNative = (value) => {
  if (Platform.OS === 'android') setServerClockOffset(value);
};

// Restore the persisted estimate (one async read at module load; no timers).
AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
  if (offsetMs !== undefined) return; // a live sample already won
  const n = Number(raw);
  if (raw != null && raw !== '' && Number.isFinite(n)) {
    offsetMs = n;
    mirrorToNative(n);
  }
}).catch(() => {});

export const getServerOffsetMs = () => offsetMs;

/** Feed one live (backend ts) sample. */
export const observeServerTime = (serverTs, receivedAt = Date.now()) => {
  const next = learnServerOffset(offsetMs, serverTs, receivedAt);
  if (!Number.isFinite(next) || next === offsetMs) return;
  const moved = !Number.isFinite(offsetMs) || Math.abs(next - offsetMs) > PERSIST_DELTA_MS;
  offsetMs = next;
  if (moved) {
    AsyncStorage.setItem(STORAGE_KEY, String(next)).catch(() => {});
    mirrorToNative(next);
  }
};

export default { getServerOffsetMs, observeServerTime };
