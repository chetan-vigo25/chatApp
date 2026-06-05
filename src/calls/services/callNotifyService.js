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
    await apiCall('post', 'user/call/notify', { peerId, media, callId }, { silent: true });
  } catch (_) { /* ignore — push is a best-effort assist */ }
};
