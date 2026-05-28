// OutboxWorker — drains the SQLite `outbox` table with exponential backoff.
//
// Lifecycle:
//   start()  — call once at app boot (or when the socket connects).
//   stop()   — call on logout / session reset.
//   wake()   — call after enqueueing a new outbox row to drain immediately
//              instead of waiting for the next tick.
//
// The worker is intentionally simple: one in-flight send at a time per
// instance, polling on a 1.5s loop, plus an event-triggered wake. The
// per-row `next_retry_at` timestamp gates retries so we don't hammer a
// failing path.

import ChatDatabase from './ChatDatabase';
import { apiCall } from '../Config/Https';

let _running = false;
let _timer = null;
let _wakePromise = null;
let _wakeResolve = null;

const POLL_INTERVAL_MS = 1500;
const MAX_BATCH = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const armWake = () => {
  if (_wakePromise) return;
  _wakePromise = new Promise((resolve) => { _wakeResolve = resolve; });
};

export const wake = () => {
  if (_wakeResolve) {
    const fn = _wakeResolve;
    _wakeResolve = null;
    _wakePromise = null;
    fn();
  }
};

const sendOnce = async (row) => {
  // The payload was created by useChatLogic / send code at compose time and
  // contains everything the REST endpoint needs: receiverId / chatType /
  // messageType / text / mediaUrl / clientMessageId / ...
  const payload = row.payload || {};
  const response = await apiCall('POST', 'user/chat/message/send', payload);
  const failed = response && (response.success === false || response.status === false || response.ok === false || response.error);
  if (failed) {
    throw new Error(response?.message || 'send failed');
  }
  return response?.data || null;
};

const tick = async () => {
  let rows = [];
  try {
    rows = await ChatDatabase.outboxDrainDue(MAX_BATCH);
  } catch (e) { /* DB transient */ }

  for (const row of rows || []) {
    if (!_running) break;
    const { client_message_id: cid } = row;
    try {
      const ack = await sendOnce(row);
      // Server responded — drop from outbox. ChatDatabase.acknowledgeMessage
      // (called from the realtime ack path) will merge the optimistic SQLite
      // row with the canonical one; here we just remove our outbox entry.
      await ChatDatabase.outboxRemove(cid);
      // Tell any listener that this client message is now settled.
      try { _onAckListeners.forEach((cb) => cb({ clientMessageId: cid, ack })); } catch {}
    } catch (err) {
      const { exhausted } = await ChatDatabase.outboxRecordFailure(cid, err?.message);
      if (exhausted) {
        // Final failure — drop and surface to UI via listener.
        await ChatDatabase.outboxRemove(cid);
        try { _onFailureListeners.forEach((cb) => cb({ clientMessageId: cid, error: err?.message })); } catch {}
      }
    }
  }
};

const _onAckListeners = new Set();
const _onFailureListeners = new Set();

export const onAck = (cb) => { _onAckListeners.add(cb); return () => _onAckListeners.delete(cb); };
export const onFailure = (cb) => { _onFailureListeners.add(cb); return () => _onFailureListeners.delete(cb); };

export const start = () => {
  if (_running) return;
  _running = true;

  const loop = async () => {
    while (_running) {
      await tick();
      armWake();
      // Race a wake signal against the poll interval.
      await Promise.race([
        _wakePromise,
        sleep(POLL_INTERVAL_MS),
      ]);
    }
  };
  loop();
};

export const stop = () => {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (_wakeResolve) { _wakeResolve(); _wakeResolve = null; _wakePromise = null; }
};

export default { start, stop, wake, onAck, onFailure };
