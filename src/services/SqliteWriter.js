// SqliteWriter — single-writer FIFO queue for all SQLite mutations.
//
// Why:
//   - expo-sqlite serializes per-connection, but two concurrent JS callers
//     race the "database is locked" error.
//   - Realtime handlers (incoming message, reaction, receipt, edit, delete)
//     fire in burst. Each used to await its own SQLite write inline,
//     blocking the React render — that's the root cause of the
//     few-seconds delay the user reported.
//
// Design:
//   - Module-level FIFO `_queue` of `{ op, payload, resolve, reject }`.
//   - One drainer running at a time (no parallel writes).
//   - `enqueue(op, payload)` returns a Promise; callers may await for ordering
//     guarantees (e.g. `refreshMessagesFromDB`) or fire-and-forget otherwise.
//   - `awaitDrain()` lets a reader wait until the queue is empty.
//   - Errors are caught per-op so one bad write doesn't poison the queue.

import ChatDatabase from './ChatDatabase';

const _queue = [];
let _draining = false;
let _drainPromise = null;
let _drainResolve = null;

// Dispatch table — every supported op maps to a ChatDatabase function.
// Adding a new op? Add it here, don't sprinkle direct ChatDatabase calls
// in realtime handlers.
const OPS = {
  upsertMessage:        (p) => ChatDatabase.upsertMessage(p),
  upsertMessages:       (p) => ChatDatabase.upsertMessages(p),
  acknowledgeMessage:   ({ tempId, serverMessageId, extra }) =>
                           ChatDatabase.acknowledgeMessage(tempId, serverMessageId, extra),
  updateMessageStatus:  ({ id, status, extra }) =>
                           ChatDatabase.updateMessageStatus(id, status, extra),
  bulkUpdateStatus:     ({ ids, status, extra }) =>
                           ChatDatabase.bulkUpdateStatus(ids, status, extra),
  updateReactions:      ({ messageId, reactions }) =>
                           ChatDatabase.updateReactions(messageId, reactions),
  updateMessageEdit:    ({ messageId, newText, editedAt }) =>
                           ChatDatabase.updateMessageEdit(messageId, newText, editedAt),
  markMessageDeleted:   ({ messageId, placeholderText, deletedBy }) =>
                           ChatDatabase.markMessageDeleted(messageId, placeholderText, deletedBy),
  deleteMessageForMe:   ({ messageId, userId }) =>
                           ChatDatabase.deleteMessageForMe(messageId, userId),
  clearChat:            ({ chatId, clearedAt }) =>
                           ChatDatabase.clearChat(chatId, clearedAt),
  upsertChat:           (p) => ChatDatabase.upsertChat(p),
  upsertChats:          (p) => ChatDatabase.upsertChats(p),
  updateChatLastMessage: (p) => ChatDatabase.updateChatLastMessage(p),
  updateChatUnread:     ({ chatId, unread }) =>
                           ChatDatabase.updateChatUnread(chatId, unread),
};

async function _drain() {
  if (_draining) return;
  _draining = true;
  try {
    while (_queue.length > 0) {
      const job = _queue.shift();
      const fn = OPS[job.op];
      if (!fn) {
        job.reject(new Error(`SqliteWriter: unknown op "${job.op}"`));
        continue;
      }
      try {
        const result = await fn(job.payload);
        job.resolve(result);
      } catch (err) {
        // Swallow into per-job reject; never poison the queue.
        job.reject(err);
      }
    }
  } finally {
    _draining = false;
    if (_drainResolve) {
      const r = _drainResolve;
      _drainResolve = null;
      _drainPromise = null;
      r();
    }
  }
}

/**
 * Enqueue a single write op. Returns a Promise resolving with the result
 * (or rejecting on per-op error). Callers may await for ordering guarantees
 * or fire-and-forget for instant UI paths.
 *
 * @param {string} op   — one of the keys in OPS above
 * @param {object} payload — args forwarded to the ChatDatabase function
 */
export const enqueue = (op, payload) => {
  return new Promise((resolve, reject) => {
    _queue.push({ op, payload, resolve, reject });
    // Drain on the next tick so a burst of enqueues all land in the same loop.
    if (!_draining) {
      Promise.resolve().then(_drain).catch(() => {});
    }
  });
};

/**
 * Await an empty queue. Used by reader paths (e.g. refreshMessagesFromDB)
 * that need to be sure all pending writes have landed before reading.
 */
export const awaitDrain = () => {
  if (!_draining && _queue.length === 0) return Promise.resolve();
  if (_drainPromise) return _drainPromise;
  _drainPromise = new Promise((resolve) => { _drainResolve = resolve; });
  return _drainPromise;
};

/** Diagnostics for dev logs. */
export const stats = () => ({ depth: _queue.length, draining: _draining });

export default { enqueue, awaitDrain, stats };
