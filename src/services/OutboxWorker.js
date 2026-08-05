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

const SOCKET_ACK_TIMEOUT_MS = 12000;

// Group rows can't drain over REST (the endpoint requires a receiverId), so
// they re-emit `group:message:send` with the SAME clientMessageId — the server
// dedupes on (chatId, clientMessageId), so a replay can never duplicate. If
// the socket is down the throw feeds the normal backoff/retry cycle.
const sendViaSocket = (payload) => new Promise((resolve, reject) => {
  // Lazy require — the socket module transitively imports app state; a
  // top-level import here would re-create the require cycles that were
  // deliberately broken (see sessionManager.resetRuntimeState).
  const { getSocket, isSocketConnected } = require('../Redux/Services/Socket/socket');
  const socket = getSocket();
  if (!socket || !isSocketConnected()) {
    reject(new Error('socket offline'));
    return;
  }
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    reject(new Error('ack timeout'));
  }, SOCKET_ACK_TIMEOUT_MS);
  socket.emit('group:message:send', payload, (response) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (response && response.status === false) {
      reject(new Error(response?.message || 'send failed'));
      return;
    }
    resolve(response?.data || response || null);
  });
});

// Tracking rows (record_type='tracking') re-emit the stored `location:update`
// payload (eventId/deviceTs/coords/telemetry) over the socket — never the chat
// REST path. The server dedupes on eventId, so a replay can never duplicate.
// A TRACKING_DISABLED error ack is a TERMINAL signal, not a failure: resolve
// with a marker so the caller deletes the row and runs the stop flow.
const sendTrackingViaSocket = (payload) => new Promise((resolve, reject) => {
  // Lazy require — same cycle-avoidance rationale as sendViaSocket above.
  const { getSocket, isSocketConnected } = require('../Redux/Services/Socket/socket');
  const socket = getSocket();
  if (!socket || !isSocketConnected()) {
    reject(new Error('socket offline'));
    return;
  }
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    reject(new Error('ack timeout'));
  }, SOCKET_ACK_TIMEOUT_MS);
  socket.emit('location:update', payload, (response) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (response && response.status === false) {
      if (response?.data?.code === 'TRACKING_DISABLED') {
        resolve({ trackingDisabled: true });
        return;
      }
      reject(new Error(response?.message || 'send failed'));
      return;
    }
    resolve(response?.data || response || null);
  });
});

// Admin disabled tracking while rows were queued: purge every queued tracking
// row and stop the watcher/indicator via the tracking slice.
const handleTrackingDisabled = async () => {
  try { await ChatDatabase.purgeTrackingRows(); } catch {}
  try {
    const mod = require('../Redux/Store');
    const store = mod.store || mod.default || mod;
    const { stopped, configReceived } = require('../Redux/Reducer/Tracking/Tracking.reducer');
    if (store?.dispatch && stopped) store.dispatch(stopped());
    // A row drained during a brief pause can bring TRACKING_DISABLED back
    // AFTER the admin already resumed — re-request the config so the server's
    // current answer wins instead of the stale ack (pause→resume race).
    const { emitSocketEvent } = require('../Redux/Services/Socket/socket');
    if (emitSocketEvent && store?.dispatch && configReceived) {
      emitSocketEvent('tracking:config:request', {}, (resp) => {
        const cfg = resp?.config || resp?.data?.config || resp?.data || null;
        if (cfg && (resp?.ok || resp?.status === true)) store.dispatch(configReceived(cfg));
      }, { queueIfOffline: false });
    }
  } catch {}
};

const sendOnce = async (row) => {
  if (row.record_type === 'tracking') {
    return sendTrackingViaSocket(row.payload || {});
  }
  // The payload was created by useChatLogic / send code at compose time and
  // contains everything the transport needs: receiverId / chatType /
  // messageType / text / mediaUrl / clientMessageId / ...
  const payload = row.payload || {};
  if (payload.chatType === 'group' || payload.groupId) {
    return sendViaSocket(payload);
  }
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
    const isTracking = row.record_type === 'tracking';
    try {
      const ack = await sendOnce(row);
      // Server responded — drop from outbox. ChatDatabase.acknowledgeMessage
      // (called from the realtime ack path) will merge the optimistic SQLite
      // row with the canonical one; here we just remove our outbox entry.
      await ChatDatabase.outboxRemove(cid);
      if (isTracking) {
        // No message row to settle. A TRACKING_DISABLED ack additionally purges
        // the remaining queued fixes and stops the watcher/indicator.
        if (ack?.trackingDisabled) await handleTrackingDisabled();
      } else {
        // Tell any listener that this client message is now settled.
        try { _onAckListeners.forEach((cb) => cb({ clientMessageId: cid, ack })); } catch {}
      }
    } catch (err) {
      const { exhausted } = await ChatDatabase.outboxRecordFailure(cid, err?.message);
      // Tracking rows are NEVER dropped on exhaustion — they keep retrying with
      // the (capped) backoff and are bounded by the 500-row drop-oldest cap in
      // enqueueTrackingEvent instead. Only chat message rows fail terminally.
      if (exhausted && !isTracking) {
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
