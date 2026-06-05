import { apiCall } from '../../Config/Https';

/**
 * Uploads on-device call-recording chunks for the admin "Listen Live" monitor.
 * Only the CALLER records (decided in CallProvider). `callId` is the app
 * signaling id — the same id the admin Active-Calls board shows — so the admin
 * can map a live call to its in-progress recording.
 *
 *  POST /api/v2/user/call/recording/chunk     { callId, seq, mime, data, media }
 *  POST /api/v2/user/call/recording/finalize  { callId, durationSec }
 *
 * Best-effort: a failed chunk must never disturb the call, so callers ignore
 * errors. Chunks carry an explicit seq so the backend stores them in order even
 * if uploads race.
 */

export const uploadRecordingChunk = async ({ callId, seq, mime, data, media }) => {
  if (!callId || !data) return false;
  try {
    await apiCall('post', 'user/call/recording/chunk', { callId, seq, mime, data, media }, { silent: true });
    return true;
  } catch (_) {
    return false;
  }
};

export const finalizeRecording = async ({ callId, durationSec } = {}) => {
  if (!callId) return false;
  try {
    await apiCall('post', 'user/call/recording/finalize', { callId, durationSec }, { silent: true });
    return true;
  } catch (_) {
    return false;
  }
};
