// Pure, dependency-free helpers for the reconnect catch-up (no React Native
// imports so `node --test __tests__/catchupChunks.test.js` can load it).
// CommonJS on purpose: node loads it as-is, Metro/babel interop handles the
// named `import { x } from` in the app.

// Server cap is 200 chats per request; stay well under it so a slow response
// never carries a huge payload and a timeout only costs one chunk.
const CATCHUP_CHUNK_SIZE = 100;

/**
 * Order chat ids most-recently-active first. `activity` maps chatId -> last
 * activity ms (chats table last message time). Unknown chats sort last, ties
 * keep input order (stable) so the result is deterministic.
 */
const orderChatIdsByActivity = (ids, activity) => {
  const act = activity || {};
  return (Array.isArray(ids) ? ids : [])
    .map((id, i) => ({ id, i, t: Number(act[id]) || 0 }))
    .sort((a, b) => (b.t - a.t) || (a.i - b.i))
    .map((x) => x.id);
};

/** Split `list` into arrays of at most `size` items. */
const chunk = (list, size = CATCHUP_CHUNK_SIZE) => {
  const out = [];
  const n = Math.max(1, Number(size) || CATCHUP_CHUNK_SIZE);
  const arr = Array.isArray(list) ? list : [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/**
 * Next catch-up cursor for a chat from what is COMMITTED locally (never the
 * server's latestSeq: a swallowed write would make the loop skip the page).
 * Returns { next, advanced }. A chat whose cursor did not advance must stop
 * looping so the next trigger retries the same cursor.
 */
const nextCursorFromLocal = (prevCursor, localMaxSeq) => {
  const prev = Number(prevCursor) || 0;
  const local = Number(localMaxSeq) || 0;
  return { next: Math.max(prev, local), advanced: local > prev };
};

/**
 * Cursor to continue a chat from after a round. With no failed row the server
 * page is fully accounted for (rows skipped on purpose never raise MAX(seq)),
 * so its latestSeq is safe; with any failed row hold at the local committed max.
 */
const effectiveLocalMax = ({ failed, local, latestSeq }) => {
  const l = Number(local) || 0;
  return (Number(failed) || 0) > 0 ? l : Math.max(l, Number(latestSeq) || 0);
};

/**
 * Continuation entries for the next round, from the server's per-chat results
 * and a { chatId -> local committed max seq } map read AFTER the writes.
 * `sent` is { chatId -> cursor we sent }. Continue a chat only when the server
 * said hasMore AND the local cursor really advanced; mutation overflow
 * (hasMoreMutations) continues with the returned mutation cursor.
 */
const continuationEntries = (results, localMax, sent) => {
  const out = [];
  for (const c of Array.isArray(results) ? results : []) {
    if (!c || !c.chatId) continue;
    const prev = Number(sent?.[c.chatId]) || 0;
    const { next, advanced } = nextCursorFromLocal(prev, localMax?.[c.chatId]);
    const moreSeq = c.hasMore === true && advanced;
    const moreMut = c.hasMoreMutations === true && Number(c.latestMutationAt) > 0;
    if (!moreSeq && !moreMut) continue;
    out.push({
      chatId: c.chatId,
      lastSeq: moreSeq ? next : Math.max(prev, Number(localMax?.[c.chatId]) || 0),
      ...(moreMut ? { mutatedSince: Number(c.latestMutationAt) } : {}),
    });
  }
  return out;
};

/**
 * Chats the server did not answer for (response truncated at its 200-chat cap)
 * as entries to re-request. `entriesById` maps chatId -> original entry.
 */
const followUpEntries = (response, entriesById) => {
  const skipped = Array.isArray(response?.skippedChatIds) ? response.skippedChatIds : [];
  const out = [];
  for (const id of skipped) {
    const e = entriesById?.[id];
    if (e) out.push(e);
  }
  return out;
};

/**
 * Mutation-cursor seed when none is stored. A held message can only be mutated
 * after it was created, so the oldest local message time (minus a clock-skew
 * margin) is a safe lower bound: nothing older can matter. 0 local messages ->
 * 0 (= "no seed": a chat with no local rows has no row to mutate, and its
 * messages arrive in their current state).
 */
const MUTATION_SEED_SKEW_MS = 5 * 60 * 1000;
const deriveMutationSeed = ({ stored, oldestLocalTs, skewMs = MUTATION_SEED_SKEW_MS } = {}) => {
  const s = Number(stored);
  if (Number.isFinite(s) && s > 0) return s;
  const o = Number(oldestLocalTs);
  if (Number.isFinite(o) && o > 0) return Math.max(1, o - skewMs);
  return 0;
};

/**
 * Split an upsertMessages() outcome. `undefined` (sealed write / dropped job)
 * or a malformed value means NOTHING was committed. Returns a Set of ids.
 */
const committedIdSet = (outcome) => {
  const ids = outcome && Array.isArray(outcome.committedIds) ? outcome.committedIds : [];
  return new Set(ids.map(String));
};

/** Keep only the raw docs whose id is in the committed set. */
const filterCommitted = (rawMsgs, committed, idOf) => {
  const get = idOf || ((m) => m?.messageId || m?.serverMessageId || m?.id || m?._id);
  return (Array.isArray(rawMsgs) ? rawMsgs : []).filter((m) => {
    const id = get(m);
    return id != null && committed.has(String(id));
  });
};

// Transport-level failures that say nothing about the message itself.
const OFFLINE_ERROR_RE = /socket offline|network request failed|network error|no internet|timeout of \d+ms exceeded|failed to connect/i;
const isOfflineError = (message) => OFFLINE_ERROR_RE.test(String(message || ''));

/**
 * Should an outbox failure count toward max_attempts? A failure while the
 * device is offline (or a pure transport error such as "socket offline") never
 * does; an online failure or an explicit server rejection does.
 */
const shouldCountOutboxFailure = ({ online, errorMessage = '', serverRejected = false } = {}) => {
  if (serverRejected) return true;
  if (!online) return false;
  return !isOfflineError(errorMessage);
};

/**
 * Bounded in-line retry around a transactional write pass. `writePass(msgs)`
 * resolves { committed:[msg], failed:[msg] } (a batch-level failure reports
 * everything failed). Rows that fail are re-run up to `retryPasses` more times
 * with a growing delay; whatever is still failing is reported, never dropped.
 * Resolves { committedIds, failedIds } in input terms of `keyOf(msg)`.
 */
const upsertWithRetry = async (writePass, messages, { retryPasses = 2, delay, keyOf } = {}) => {
  const key = keyOf || ((m) => m?.serverMessageId || m?.id || m?.tempId || null);
  const wait = delay || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const committedIds = [];
  let pending = Array.isArray(messages) ? messages : [];
  for (let pass = 0; pass <= retryPasses && pending.length; pass += 1) {
    if (pass > 0) await wait(80 * pass);
    const out = (await writePass(pending)) || { committed: [], failed: pending };
    for (const m of out.committed || []) { const k = key(m); if (k) committedIds.push(k); }
    pending = out.failed || [];
  }
  return { committedIds, failedIds: pending.map(key).filter(Boolean) };
};

/**
 * Delivered watermark to (re)announce for a chat: local max seq when it is
 * above the last one we sent, else 0 (nothing to send).
 */
const deliveredWatermarkToSend = (localMaxSeq, lastSentSeq) => {
  const local = Number(localMaxSeq) || 0;
  const last = Number(lastSentSeq) || 0;
  return local > last ? local : 0;
};

const STATUS_RANK = { sending: 0, pending: 0, sent: 1, delivered: 2, read: 3, seen: 3 };
/** Forward-only status merge: returns the status to store, or null to skip. */
const forwardOnlyStatus = (current, incoming) => {
  const inc = String(incoming || '').toLowerCase();
  if (inc !== 'delivered' && inc !== 'read') return null;
  const cur = STATUS_RANK[String(current || '').toLowerCase()] ?? 0;
  return STATUS_RANK[inc] > cur ? inc : null;
};

module.exports = {
  CATCHUP_CHUNK_SIZE,
  MUTATION_SEED_SKEW_MS,
  orderChatIdsByActivity,
  chunk,
  nextCursorFromLocal,
  effectiveLocalMax,
  continuationEntries,
  followUpEntries,
  deriveMutationSeed,
  committedIdSet,
  filterCommitted,
  upsertWithRetry,
  isOfflineError,
  shouldCountOutboxFailure,
  deliveredWatermarkToSend,
  forwardOnlyStatus,
};
