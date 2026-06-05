import { apiCall } from '../../Config/Https';

/**
 * Asks OUR backend to push a high-priority "Incoming call" notification to the
 * callee's devices, so user B's phone rings even when the app is backgrounded or
 * closed (the WebRTC signaling SDK only reaches a foregrounded, connected app).
 *
 * Best-effort: a failed push must never block placing the call.
 *
 *  POST /api/v2/user/call/notify  { peerId, media, callId }
 */
export const notifyIncomingCall = async ({ peerId, media, callId }) => {
  if (!peerId) return;
  try {
    const res = await apiCall('post', 'user/call/notify', { peerId, media, callId }, { silent: true });
    if (__DEV__) console.log('[CALL][APP][notify] /call/notify ok', { peerId, callId, res });
  } catch (e) {
    // Best-effort — a failed push must never block placing the call. Logged in
    // dev so a missing/erroring endpoint (e.g. 404 → backend doesn't implement
    // it) is visible while diagnosing "callee not notified when app is closed".
    if (__DEV__) console.log('[CALL][APP][notify] /call/notify FAILED', { peerId, status: e?.response?.status, message: e?.message });
  }
};
