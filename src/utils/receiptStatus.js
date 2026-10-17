// Pure, dependency-free helpers for message receipt / tick logic (Oct-14 receipts
// audit, T-A-01/02/03/06/12). CommonJS on purpose so
// `node --test __tests__/receiptStatus.test.js` can load it without React Native.
// Nothing here touches SQLite, Redux or the socket.

const RANK = {
  failed: 0,
  queued: 1, pending: 1, sending: 1,
  uploaded: 2,
  sent: 3,
  delivered: 4,
  seen: 5, read: 5,
};
// Statuses owned by their dedicated handlers: a receipt never overwrites them.
const OWNED = new Set(['scheduled', 'processing', 'cancelled']);

const canon = (s) => {
  const v = String(s || '').toLowerCase();
  if (!v) return null;
  return v === 'read' ? 'seen' : v;
};
const rank = (s) => {
  const c = canon(s);
  return c && Object.prototype.hasOwnProperty.call(RANK, c) ? RANK[c] : 0;
};

// Forward-only status merge.
//  - a receipt (delivered/seen) never lowers a row;
//  - `failed` is the only error state, and it may replace ONLY a not-yet-acked
//    row: once the row is sent/delivered/seen or carries server proof (server id
//    or seq), a late 'failed' is ignored (T-A-12);
//  - a stored `failed` row moves to any live status (retry: sending, or an ack);
//  - scheduled/processing/cancelled are never overwritten here.
const mergeStatus = (current, incoming, opts = {}) => {
  const cur = canon(current);
  const inc = canon(incoming);
  if (!inc) return cur;
  if (!cur) return inc;
  if (OWNED.has(cur)) return cur;
  if (OWNED.has(inc)) return cur;
  if (inc === 'failed') {
    if (cur === 'failed') return cur;
    if (opts.hasServerProof || rank(cur) >= RANK.sent) return cur;
    return 'failed';
  }
  if (cur === 'failed') return inc;
  return rank(inc) > rank(cur) ? inc : cur;
};

// Receipts that arrive BEFORE the temp->server id swap cannot match any row (the
// row has no server id yet). Remember them by id for a short window; the ack
// path asks `peek([serverId, tempId])` and applies the result forward-only.
// Bounded (max entries, TTL) and clock-injectable. Only delivered/seen are kept.
const createEarlyReceiptBuffer = ({ ttlMs = 60000, max = 500, now = Date.now } = {}) => {
  const map = new Map(); // id -> { status, at }
  const prune = () => {
    const t = now();
    for (const [id, e] of map) if (t - e.at > ttlMs) map.delete(id);
    while (map.size > max) map.delete(map.keys().next().value);
  };
  return {
    record(ids, status) {
      const st = canon(status);
      if (!st || rank(st) < RANK.delivered) return;
      const list = Array.isArray(ids) ? ids : [ids];
      const t = now();
      for (const raw of list) {
        if (raw === null || raw === undefined || raw === '') continue;
        const id = String(raw);
        const prev = map.get(id);
        const next = prev && rank(prev.status) >= rank(st) ? prev.status : st;
        map.delete(id); // re-insert so Map order stays oldest-first
        map.set(id, { status: next, at: t });
      }
      if (map.size > max) prune();
    },
    peek(ids) {
      const t = now();
      let best = null;
      for (const raw of Array.isArray(ids) ? ids : [ids]) {
        if (raw === null || raw === undefined || raw === '') continue;
        const e = map.get(String(raw));
        if (!e) continue;
        if (t - e.at > ttlMs) { map.delete(String(raw)); continue; }
        if (!best || rank(e.status) > rank(best)) best = e.status;
      }
      return best;
    },
    size() { prune(); return map.size; },
    clear() { map.clear(); },
  };
};

// Status the ack should write: the ack's own 'sent' lifted by any early receipt
// (and any watermark that already covers the row's seq). Forward-only.
const statusAtAck = ({ stored, early, seq, readUpToSeq, deliveredUpToSeq }) => {
  let st = mergeStatus(stored || 'sent', 'sent');
  if (early) st = mergeStatus(st, early);
  const s = Number(seq);
  if (Number.isFinite(s) && s > 0) {
    if (Number(readUpToSeq) >= s) st = mergeStatus(st, 'seen');
    else if (Number(deliveredUpToSeq) >= s) st = mergeStatus(st, 'delivered');
  }
  return st;
};

// Does the peer watermark change the chat-list tick? Returns the new status
// ('delivered' | 'seen') or null (no change). Only OUR last message can show a
// tick, and only when its seq is known and covered by the watermark.
const watermarkTickDecision = ({ currentStatus, lastSeq, lastIsMine, readUpToSeq, deliveredUpToSeq }) => {
  if (!lastIsMine) return null;
  const seq = Number(lastSeq);
  if (!Number.isFinite(seq) || seq <= 0) return null;
  let target = null;
  if (Number(readUpToSeq) >= seq) target = 'seen';
  else if (Number(deliveredUpToSeq) >= seq) target = 'delivered';
  if (!target) return null;
  const next = mergeStatus(currentStatus || 'sent', target);
  return canon(next) === canon(currentStatus) ? null : next;
};

// Does a receipt that names `receiptIds` refer to a row known by `rowIds`?
const sharesAnyId = (receiptIds, rowIds) => {
  const a = new Set((receiptIds || []).filter((x) => x !== null && x !== undefined && x !== '').map(String));
  for (const r of rowIds || []) if (a.has(String(r))) return true;
  return false;
};

// Read-receipt gate (T-A-06): only when the chat is open, its screen is focused,
// nothing covers it and the app is in the foreground.
const canSendReadReceipt = ({ appState, screenFocused = true, chatOpen = true, covered = false } = {}) =>
  appState === 'active' && screenFocused !== false && chatOpen !== false && !covered;

// Bulk read-all bound (T-A-06): only rows held locally. Never the chat-list seq
// (which can name a message this device has not stored).
const readAllUpToSeq = (localMaxSeq) => {
  const n = Number(localMaxSeq);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

module.exports = {
  RANK,
  canon,
  rank,
  mergeStatus,
  createEarlyReceiptBuffer,
  statusAtAck,
  watermarkTickDecision,
  sharesAnyId,
  canSendReadReceipt,
  readAllUpToSeq,
};
