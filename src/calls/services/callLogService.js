import { apiCall } from '../../Config/Https';

/**
 * Durable call-history persistence (backend CallLog). Best-effort: a failed log
 * write must never block the call UX, so callers should catch/ignore errors.
 *
 *  POST /api/v2/user/call/log
 *  GET  /api/v2/user/call/logs?chatId=&page=&limit=
 */

export const recordCall = async (payload) => {
  try {
    const res = await apiCall('post', 'user/call/log', payload, { silent: true });
    return res?.data || null;
  } catch (err) {
    // A backend that predates outcome 'no_answer' answers 400 (seen 2026-10-27)
    // — re-send as the old 'cancelled' so the log is never lost.
    // A silent apiCall rejects with the response BODY ({ statusCode, … }), or
    // with the axios error when there was no body.
    const status = err?.statusCode ?? err?.response?.status;
    if (payload?.outcome === 'no_answer' && Number(status) === 400) {
      return recordCall({ ...payload, outcome: 'cancelled' });
    }
    return null;
  }
};

// Delete selected call-history rows (owner-scoped) by their callIds.
export const deleteCalls = async (callIds = []) => {
  const ids = (callIds || []).map(String).filter(Boolean);
  if (!ids.length) return { deleted: 0 };
  const res = await apiCall('post', 'user/call/logs/delete', { callIds: ids }, { silent: true });
  return res?.data || { deleted: ids.length };
};

export const listCalls = async ({ chatId, page = 1, limit = 30 } = {}) => {
  const qs = [];
  if (chatId) qs.push(`chatId=${encodeURIComponent(chatId)}`);
  qs.push(`page=${page}`);
  qs.push(`limit=${limit}`);
  const res = await apiCall('get', `user/call/logs?${qs.join('&')}`, {}, { silent: true });
  return res?.data || { items: [], pagination: {} };
};

// Clear ALL of the current user's call history (owner-scoped — the other party
// keeps their own copy). Not silenced: the caller surfaces success/failure.
export const clearCalls = async () => {
  const res = await apiCall('post', 'user/call/logs/clear', {});
  return res?.data || { deleted: 0 };
};

// Aggregate call stats for the Call info screen, optionally scoped to one peer:
//   { total, incoming, outgoing, missed, audio, video, totalDurationSec, lastCallAt }
export const getCallStats = async (peerId = null) => {
  const qs = peerId ? `?peerId=${encodeURIComponent(peerId)}` : '';
  const res = await apiCall('get', `user/call/logs/stats${qs}`, {}, { silent: true });
  return res?.data || null;
};
