/* eslint-disable no-console */
// WhatsApp-style older-history backfill — verification harness (Phase 4)
// =============================================================================
// The orchestration lives in a React hook (useChatLogic.loadMoreMessages) that
// can't run under plain Node, and the real endpoint needs Mongo + Socket.IO. So
// this harness ports the ORCHESTRATION ALGORITHM verbatim and drives it against:
//   - a model SERVER holding full seq-ordered history (mirrors handleMessageHistory:
//     seq < beforeSeq, limit+1 → hasMore, newest page when no cursor), and
//   - a model CLIENT SQLite reusing the production serializer (runExclusive /
//     runExclusiveBatch) + the WAL writer-lock semantics, so concurrent live
//     writes during backfill can be checked for "database is locked".
// Run: `node scripts/history-backfill-stress.js`
// =============================================================================

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = 50;          // SOCKET_FETCH_LIMIT
const CHUNK = 25;         // persist chunk size
const BUSY_TIMEOUT_MS = 40;
const BATCH_HOLD_MS = 6;

// ── Production serializer (verbatim from ChatDatabase.js) ────────────────────
let _writeChain = Promise.resolve();
let _holding = false;
const runExclusive = (task) => {
  if (_holding) return Promise.resolve().then(task);
  const run = async () => { _holding = true; try { return await task(); } finally { _holding = false; } };
  const next = _writeChain.then(run, run);
  _writeChain = next.catch(() => {});
  return next;
};
const runExclusiveBatch = (task) => {
  const next = _writeChain.then(task, task);
  _writeChain = next.catch(() => {});
  return next;
};
const resetWriter = () => { _writeChain = Promise.resolve(); _holding = false; };

const STATUS_RANK = { sent: 3, delivered: 4, seen: 5, read: 5 };

// ── Model server: full history, seq 1..total ─────────────────────────────────
function makeServer(total, chatId = 'c1') {
  const all = [];
  for (let s = 1; s <= total; s++) {
    all.push({ seq: s, messageId: `srv_${s}`, _id: `srv_${s}`, chatId, senderId: 'peer',
      text: `m${s}`, messageType: 'text', createdAt: new Date(s * 1000).toISOString(), status: 'read' });
  }
  let calls = 0;
  const history = ({ beforeSeq, limit = PAGE }) => {
    calls++;
    let rows = all.filter((m) => m.seq > 0 && (beforeSeq ? m.seq < beforeSeq : true));
    rows.sort((a, b) => b.seq - a.seq);            // desc
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();    // ascending (oldest→newest)
    const oldestCursor = page.length ? page[0].seq : (beforeSeq || null);
    return { ok: true, chatId, messages: page, hasMore, oldestCursor };
  };
  return { history, callCount: () => calls };
}

// ── Model client SQLite (WAL writer lock + idempotent monotonic upsert) ──────
function makeClientDb() {
  let dedicatedHeld = false;
  const rows = new Map();   // id -> { id, seq, timestamp, status }
  const meta = new Map();   // sync_meta
  const stats = { busy: 0, batches: 0, singleWrites: 0 };

  const applyRow = (m) => {
    const id = m.id || m.serverMessageId || m.messageId || m._id;
    if (!id) return;
    const seq = (m.seq != null && !Number.isNaN(Number(m.seq))) ? Number(m.seq) : null;
    const ts = Number(m.timestamp != null ? m.timestamp : (m.createdAt ? new Date(m.createdAt).getTime() : 0));
    const existing = rows.get(id);
    if (!existing) { rows.set(id, { id, seq, timestamp: ts, status: m.status || 'sent' }); return; }
    // idempotent + monotonic: never downgrade status, keep seq once known
    if ((STATUS_RANK[m.status] || 0) > (STATUS_RANK[existing.status] || 0)) existing.status = m.status;
    if (existing.seq == null && seq != null) existing.seq = seq;
  };

  // batch write (dedicated connection, BEGIN EXCLUSIVE) — used by upsertMessages
  const upsertMessages = (msgs) => runExclusiveBatch(async () => {
    dedicatedHeld = true;
    try {
      stats.batches++;
      for (const m of msgs) { applyRow(m); }
      await delay(BATCH_HOLD_MS);   // hold the writer lock for the txn duration
    } finally { dedicatedHeld = false; }
  });

  // single-statement write on the MAIN connection (live receipt) — busies if a
  // batch holds BEGIN EXCLUSIVE and it is NOT serialized behind it.
  const liveStatusWrite = (id, status) => runExclusive(async () => {
    const start = Date.now();
    while (dedicatedHeld) {
      if (Date.now() - start >= BUSY_TIMEOUT_MS) { stats.busy++; throw new Error('database is locked'); }
      await delay(4);
    }
    stats.singleWrites++;
    const r = rows.get(id);
    if (r && (STATUS_RANK[status] || 0) > (STATUS_RANK[r.status] || 0)) r.status = status;
  });

  const loadMessages = async (_cid, { beforeTimestamp = 0, limit = PAGE } = {}) => {
    let arr = [...rows.values()];
    if (beforeTimestamp > 0) arr = arr.filter((r) => r.timestamp < beforeTimestamp);
    arr.sort((a, b) => b.timestamp - a.timestamp);
    return arr.slice(0, limit).map((r) => ({ ...r }));
  };
  const getOldestSeq = async () => {
    let min = 0;
    for (const r of rows.values()) if (r.seq != null && (min === 0 || r.seq < min)) min = r.seq;
    return min;
  };
  const getClearedAt = async () => 0;
  const isHistoryFullyLoaded = async (cid) => meta.get(`hist_done:${cid}`) === '1';
  const setHistoryFullyLoaded = async (cid) => { meta.set(`hist_done:${cid}`, '1'); };

  return { upsertMessages, liveStatusWrite, loadMessages, getOldestSeq, getClearedAt,
    isHistoryFullyLoaded, setHistoryFullyLoaded, rows, stats };
}

// ── Orchestrator: faithful port of loadMoreMessages STEP 1 + STEP 2 ──────────
// `state` = { displayed: [...msgs], hasMore }. `abortAfterChunk` lets a test
// simulate an app kill mid-backfill.
async function loadMore(server, db, state, cid, opts = {}) {
  if (!state.hasMore) return;
  const displayed = state.displayed;
  const oldest = displayed.length
    ? displayed.reduce((acc, m) => (!acc || m.timestamp < acc ? m.timestamp : acc), 0)
    : null;
  if (!oldest) return; // empty handled by open-path bootstrap (see testBootstrap)

  const mergeOlder = (older) => {
    const seen = new Set(displayed.map((m) => m.id));
    for (const m of older) if (!seen.has(m.id)) { displayed.push(m); seen.add(m.id); }
    displayed.sort((a, b) => b.timestamp - a.timestamp);
  };

  // STEP 1 — local-first
  const olderLocal = await db.loadMessages(cid, { beforeTimestamp: oldest, limit: PAGE });
  if (olderLocal.length > 0) { mergeOlder(olderLocal); return; }

  // STEP 2 — local exhausted → backfill one page
  if (await db.isHistoryFullyLoaded(cid)) { state.hasMore = false; return; }
  const beforeSeq = await db.getOldestSeq(cid);
  const resp = server.history({ beforeSeq, limit: PAGE });
  if (resp.messages.length > 0) {
    const normalized = resp.messages.map((m) => ({
      id: m._id || m.messageId, seq: m.seq, timestamp: new Date(m.createdAt).getTime(), status: m.status,
    }));
    normalized.sort((a, b) => (Number(b.seq) || 0) - (Number(a.seq) || 0)); // newest-seq first
    for (let i = 0; i < normalized.length; i += CHUNK) {
      await db.upsertMessages(normalized.slice(i, i + CHUNK));
      await new Promise((r) => setTimeout(r, 0)); // yield to live writers
      if (opts.abortAfterChunk && i / CHUNK + 1 >= opts.abortAfterChunk) throw new Error('ABORT_KILL');
    }
    const olderNow = await db.loadMessages(cid, { beforeTimestamp: oldest, limit: PAGE });
    mergeOlder(olderNow);
  }
  if (resp.ok && !resp.hasMore) { await db.setHistoryFullyLoaded(cid); state.hasMore = false; }
}

// ── Test harness ─────────────────────────────────────────────────────────────
let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗ FAIL:'} ${m}`); if (!c) failures++; };
const orderedNoDupes = (displayed) => {
  const ids = displayed.map((m) => m.id);
  const uniq = new Set(ids).size === ids.length;
  let sorted = true;
  for (let i = 1; i < displayed.length; i++) if (displayed[i - 1].timestamp < displayed[i].timestamp) sorted = false;
  return { uniq, sorted };
};

async function testScrollLoadsHistory() {
  console.log('\n[1] recent-only local → scroll up repeatedly loads every older page, in order, no dupes');
  resetWriter();
  const TOTAL = 230;
  const server = makeServer(TOTAL); const db = makeClientDb();
  // seed: newest 30 already local (seq 201..230)
  await db.upsertMessages(server.history({ beforeSeq: null, limit: 30 }).messages
    .map((m) => ({ id: m._id, seq: m.seq, timestamp: new Date(m.createdAt).getTime(), status: m.status })));
  const state = { displayed: await db.loadMessages('c1', { limit: 30 }), hasMore: true };
  let guard = 0;
  while (state.hasMore && guard++ < 50) await loadMore(server, db, state, 'c1');
  const { uniq, sorted } = orderedNoDupes(state.displayed);
  ok(state.displayed.length === TOTAL, `all ${TOTAL} messages now displayed (got ${state.displayed.length})`);
  ok(uniq, 'no duplicate messages');
  ok(sorted, 'displayed strictly newest→oldest');
  ok(db.stats.busy === 0, `zero SQLITE_BUSY (busy=${db.stats.busy})`);
}

async function testBootstrapEmpty() {
  console.log('\n[2] empty local → bootstrap NEWEST server page (no cursor), then page older');
  resetWriter();
  const server = makeServer(120); const db = makeClientDb();
  // Open-path bootstrap: no cursor → newest page.
  const boot = server.history({ beforeSeq: null, limit: PAGE });
  ok(boot.messages.length === PAGE && boot.messages[boot.messages.length - 1].seq === 120,
    `bootstrap returned newest ${PAGE} (top seq=${boot.messages[boot.messages.length - 1].seq})`);
  await db.upsertMessages(boot.messages.map((m) => ({ id: m._id, seq: m.seq, timestamp: new Date(m.createdAt).getTime(), status: m.status })));
  const state = { displayed: await db.loadMessages('c1', { limit: PAGE }), hasMore: true };
  let guard = 0;
  while (state.hasMore && guard++ < 50) await loadMore(server, db, state, 'c1');
  ok(state.displayed.length === 120, `paged the rest from server (got ${state.displayed.length}/120)`);
}

async function testConcurrentLiveWrites() {
  console.log('\n[3] backfill while live messages + read receipts arrive → ZERO "database is locked"');
  resetWriter();
  const server = makeServer(200); const db = makeClientDb();
  await db.upsertMessages(server.history({ beforeSeq: null, limit: 30 }).messages
    .map((m) => ({ id: m._id, seq: m.seq, timestamp: new Date(m.createdAt).getTime(), status: m.status })));
  const state = { displayed: await db.loadMessages('c1', { limit: 30 }), hasMore: true };

  // Fire live traffic concurrently with the whole scroll-to-top backfill.
  let live = true;
  const liveLoop = (async () => {
    let n = 1000;
    while (live) {
      await db.upsertMessages([{ id: `live_${n}`, seq: 1000 + n, timestamp: 10_000_000 + n, status: 'sent' }]); // incoming
      db.liveStatusWrite(`live_${n}`, 'read').catch(() => {});                                                   // receipt
      n++;
      await delay(1);
    }
  })();

  let guard = 0;
  while (state.hasMore && guard++ < 80) await loadMore(server, db, state, 'c1');
  live = false; await liveLoop;
  await _writeChain;
  ok(db.stats.busy === 0, `zero SQLITE_BUSY under contention (busy=${db.stats.busy}, batches=${db.stats.batches}, singles=${db.stats.singleWrites})`);
  ok(state.displayed.filter((m) => String(m.id).startsWith('srv_')).length === 200, 'all 200 history messages backfilled correctly');
}

async function testFullyLoadedStops() {
  console.log('\n[4] history_fully_loaded stops further network calls once the first message is reached');
  resetWriter();
  const server = makeServer(90); const db = makeClientDb();
  await db.upsertMessages(server.history({ beforeSeq: null, limit: 30 }).messages
    .map((m) => ({ id: m._id, seq: m.seq, timestamp: new Date(m.createdAt).getTime(), status: m.status })));
  const state = { displayed: await db.loadMessages('c1', { limit: 30 }), hasMore: true };
  let guard = 0;
  while (state.hasMore && guard++ < 50) await loadMore(server, db, state, 'c1');
  const callsAfterDone = server.callCount();
  // Extra scrolls must NOT hit the server again.
  for (let i = 0; i < 5; i++) await loadMore(server, db, state, 'c1');
  ok(await db.isHistoryFullyLoaded('c1'), 'chat marked history_fully_loaded');
  ok(server.callCount() === callsAfterDone, `no further server calls after fully loaded (stayed at ${callsAfterDone})`);
}

async function testResumeAfterKill() {
  console.log('\n[5] kill mid-backfill → reopen → resume with NO gap and NO refetch of persisted rows');
  resetWriter();
  const server = makeServer(200); const db = makeClientDb();
  await db.upsertMessages(server.history({ beforeSeq: null, limit: 30 }).messages
    .map((m) => ({ id: m._id, seq: m.seq, timestamp: new Date(m.createdAt).getTime(), status: m.status })));
  let state = { displayed: await db.loadMessages('c1', { limit: 30 }), hasMore: true };
  // First backfill page: kill after the FIRST chunk (25 of 50 rows persisted).
  try { await loadMore(server, db, state, 'c1', { abortAfterChunk: 1 }); } catch (e) { /* simulated kill */ }
  const afterKillCount = db.rows.size;
  ok(afterKillCount === 30 + CHUNK, `only the first chunk persisted before kill (${afterKillCount} rows)`);

  // "Reopen": fresh display state from SQLite, then keep scrolling to the top.
  resetWriter();
  state = { displayed: await db.loadMessages('c1', { limit: PAGE }), hasMore: true };
  let guard = 0;
  while (state.hasMore && guard++ < 80) await loadMore(server, db, state, 'c1');

  // No gap: every seq 1..200 present exactly once.
  const seqs = [...db.rows.values()].map((r) => r.seq).filter((s) => s != null && s <= 200).sort((a, b) => a - b);
  const complete = seqs.length === 200 && seqs[0] === 1 && seqs[199] === 200 && new Set(seqs).size === 200;
  ok(complete, `resumed gap-free: all seq 1..200 present exactly once (have ${seqs.length})`);
}

(async () => {
  console.log('WhatsApp-style older-history backfill — Phase 4 verification');
  await testScrollLoadsHistory();
  await testBootstrapEmpty();
  await testConcurrentLiveWrites();
  await testFullyLoadedStops();
  await testResumeAfterKill();
  console.log(`\n${failures === 0 ? 'ALL PASS ✓' : `${failures} FAILURE(S) ✗`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
