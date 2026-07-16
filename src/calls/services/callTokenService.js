import { apiCall } from '../../Config/Https';

/**
 * Fetches a short-lived calling-service token from OUR backend (which mints it
 * server-side with the secret API key). The browser/app never sees the secret.
 *
 * Endpoint: GET /api/v2/user/call/token
 *   -> { data: { token, callBaseUrl, ringDurationSec } }
 */

let cached = null; // { token, callBaseUrl, ringDurationSec, iceServers, fetchedAt }
// Last backend-provided ring duration (seconds). Kept across token-cache clears
// so it survives reconnects; null until the first successful mint.
let serverRingSec = null;
// Last backend-provided recording config { enabled, chunkMs }. Tells the app
// whether the caller should capture+upload the call for the admin "Listen Live".
let serverRecording = { enabled: false, chunkMs: 3000 };

export const getCallToken = async ({ force = false } = {}) => {
  // Re-use a token for a short window; tokens are short-lived so re-mint often.
  const FRESH_MS = 60 * 1000;
  if (!force && cached && (Date.now() - cached.fetchedAt) < FRESH_MS) {
    if (__DEV__) console.log('[CALL][APP][token] using cached token', { callBaseUrl: cached.callBaseUrl, ageMs: Date.now() - cached.fetchedAt });
    return cached;
  }
  if (__DEV__) console.log('[CALL][APP][token] → GET user/call/token', { force });
  let res;
  try {
    res = await apiCall('get', 'user/call/token', {}, { silent: true });
  } catch (err) {
    // The token GET failed at the network layer (no HTTP response → status is
    // undefined). Surface the REAL axios diagnostics so we can tell apart an
    // ATS/cleartext block, a connection refusal, a timeout, and an auth (401)
    // failure — the generic [API:silent] log only prints the (undefined) status.
    if (__DEV__) {
      console.log('[CALL][APP][token] ✗ request FAILED', {
        code: err?.code,
        name: err?.name,
        message: err?.message,
        status: err?.response?.status,
        hasResponse: !!err?.response,
        hasRequest: !!err?.request,
      });
    }
    throw err;
  }
  const data = res?.data || {};
  if (!data.token) {
    if (__DEV__) console.log('[CALL][APP][token] ✗ no token in response', res);
    throw new Error('No call token returned');
  }
  const ring = Number(data.ringDurationSec);
  if (Number.isFinite(ring) && ring > 0) serverRingSec = ring;
  if (data.recording && typeof data.recording === 'object') {
    serverRecording = {
      enabled: !!data.recording.enabled,
      chunkMs: Number(data.recording.chunkMs) > 0 ? Number(data.recording.chunkMs) : 3000,
    };
  }
  cached = {
    token: data.token,
    callBaseUrl: data.callBaseUrl,
    ringDurationSec: serverRingSec,
    // Backend-configured STUN/TURN fallback for the engine's mediasoup
    // transports (used when the media server's joinRoom returns none).
    iceServers: Array.isArray(data.iceServers) && data.iceServers.length ? data.iceServers : null,
    fetchedAt: Date.now(),
  };
  if (__DEV__) console.log('[CALL][APP][token] ✓ minted', { callBaseUrl: cached.callBaseUrl, ringDurationSec: cached.ringDurationSec, tokenLen: String(data.token).length });
  return cached;
};

export const clearCachedCallToken = () => { cached = null; };

// Backend-configured ring duration (seconds), or null if never received.
export const getServerRingDurationSec = () => serverRingSec;

// Backend-configured recording config { enabled, chunkMs } for this user.
export const getServerRecordingConfig = () => serverRecording;
