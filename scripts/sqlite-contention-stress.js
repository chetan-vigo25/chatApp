/* eslint-disable no-console */
// SQLite write-contention stress harness (Phase 4)
// =============================================================================
// Reproduces the real "database is locked" (SQLITE_BUSY) collision from
// src/services/ChatDatabase.js and proves the serializer fix removes it.
//
// WHY A MODEL (not the real module): the production module depends on the
// expo-sqlite NATIVE addon, which cannot load under plain Node. So this harness
// copies the concurrency primitives VERBATIM from ChatDatabase.js
// (runExclusive / runExclusiveBatch + the coalescing status writer + the
// STATUS_PRIORITY monotonic rule) and drives them against a small model DB that
// reproduces expo-sqlite's locking semantics:
//   - ONE WAL writer lock.
//   - A dedicated connection runs BEGIN EXCLUSIVE (withExclusiveTransactionAsync)
//     and holds the writer lock for the whole transaction.
//   - A bare main-connection write that finds the lock held waits out
//     busy_timeout and then rejects with "database is locked".
// The primitives under test are byte-for-byte the production ones; only the I/O
// layer is modelled. Run: `node scripts/sqlite-contention-stress.js`
// =============================================================================

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Tunables chosen so a single bare overlap deterministically exceeds the
//    modelled busy_timeout (proves the control/negative case really BUSYs). ──
const BUSY_TIMEOUT_MS = 40;
const BATCH_HOLD_MS = 60; // > BUSY_TIMEOUT_MS

// ─────────────────────────────────────────────────────────────────────────────
// PRIMITIVES — copied verbatim from src/services/ChatDatabase.js (strict FIFO;
// the re-entrant inline path was removed — see [6] for why).
// ─────────────────────────────────────────────────────────────────────────────
let _writeChain = Promise.resolve();
const runExclusive = (task) => {
  const next = _writeChain.then(task, task);
  _writeChain = next.catch(() => {});
  return next;
};
const runExclusiveBatch = runExclusive;
const awaitWriteChain = () => _writeChain;

const STATUS_PRIORITY = { scheduled: 0, cancelled: 0, processing: 0, sending: 1, uploaded: 2, sent: 3, delivered: 4, seen: 5, read: 5 };

// Coalescing status writer — control logic copied from ChatDatabase.js; the only
// change is the single `db.runAsync(UPDATE ... WHERE id IN (...) AND status IN
// (...))` is expressed as a structured op the model DB applies, so the test can
// assert final state. The buffering / priority / chunking / runExclusive wrap
// (the behaviour under test) are unchanged.
const STATUS_COALESCE_MS = 150;
let _statusBuffer = new Map();
let _statusFlushTimer = null;
let _DB = null; // model DB injected per-test

const _flushStatusBuffer = async () => {
  _statusFlushTimer = null;
  if (_statusBuffer.size === 0) return;
  const buf = _statusBuffer;
  _statusBuffer = new Map();
  const byStatus = new Map();
  for (const [id, status] of buf) {
    if (!byStatus.has(status)) byStatus.set(status, []);
    byStatus.get(status).push(String(id));
  }
  await runExclusive(async () => {
    for (const [status, ids] of byStatus) {
      const tp = STATUS_PRIORITY[status] || 0;
      const lower = Object.entries(STATUS_PRIORITY).filter(([, p]) => p > 0 && p < tp).map(([s]) => s);
      if (!lower.length) continue;
      const CHUNK = 200;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        await _DB.runAsync({ kind: 'statusUpdate', status, ids: slice, lower: new Set(lower) });
      }
    }
  });
};

const updateMessageStatus = async (messageId, newStatus) => {
  if (!messageId || !newStatus) return false;
  const np = STATUS_PRIORITY[newStatus] || 0;
  if (np <= 0) {
    return runExclusive(async () => {
      await _DB.runAsync({ kind: 'statusSet', status: newStatus, id: String(messageId) });
      return true;
    });
  }
  const key = String(messageId);
  const prev = _statusBuffer.get(key);
  if (!prev || (STATUS_PRIORITY[prev] || 0) < np) _statusBuffer.set(key, newStatus);
  if (_statusBuffer.size >= 200) {
    if (_statusFlushTimer) { clearTimeout(_statusFlushTimer); _statusFlushTimer = null; }
    _flushStatusBuffer().catch(() => {});
  } else if (!_statusFlushTimer) {
    _statusFlushTimer = setTimeout(() => { _flushStatusBuffer().catch(() => {}); }, STATUS_COALESCE_MS);
  }
  return true;
};

// Force any pending coalesced status writes to land, then let the chain drain.
const awaitStatusDrain = async () => {
  if (_statusFlushTimer) { clearTimeout(_statusFlushTimer); _statusFlushTimer = null; }
  await _flushStatusBuffer();
  await awaitWriteChain();
};

// ─────────────────────────────────────────────────────────────────────────────
// MODEL DB — reproduces expo-sqlite WAL writer-lock + busy_timeout semantics
// ─────────────────────────────────────────────────────────────────────────────
function makeModelDb() {
  let dedicatedHeld = false;            // BEGIN EXCLUSIVE on the dedicated conn
  const messages = new Map();           // id -> status (highest applied)
  const stats = { busy: 0, mainWrites: 0, batchWrites: 0 };

  const applyStatusUpdate = ({ status, ids, lower }) => {
    for (const id of ids) {
      const cur = messages.get(id);
      // monotonic: only advance a row whose current status is a strictly-lower
      // standard rank (mirrors `AND status IN (<lower ranks>)`).
      if (cur === undefined) { messages.set(id, status); continue; }
      if (lower.has(cur)) messages.set(id, status);
    }
  };

  // main-connection single-statement write
  const runAsync = async (op) => {
    const start = Date.now();
    while (dedicatedHeld) {
      if (Date.now() - start >= BUSY_TIMEOUT_MS) { stats.busy++; throw new Error('database is locked'); }
      await delay(4);
    }
    stats.mainWrites++;
    if (op.kind === 'statusUpdate') applyStatusUpdate(op);
    else if (op.kind === 'statusSet') messages.set(op.id, op.status);
    else if (op.kind === 'seed') messages.set(op.id, op.status);
    await delay(0);
  };

  // BARE main write that does NOT honour the writer lock model's queueing — used
  // ONLY by the control/negative test to reproduce the pre-fix bug.
  const bareMainWrite = runAsync;

  const withExclusiveTransactionAsync = async (fn) => {
    dedicatedHeld = true; // BEGIN EXCLUSIVE grabs the lock immediately
    try {
      const tx = { runAsync: async (op) => { stats.batchWrites++; if (op.kind === 'seed') messages.set(op.id, op.status); await delay(0); } };
      await fn(tx);
      await delay(BATCH_HOLD_MS); // hold the writer lock for the txn duration
    } finally {
      dedicatedHeld = false;
    }
  };

  return {
    db: { runAsync, withExclusiveTransactionAsync, bareMainWrite },
    messages, stats, isHeld: () => dedicatedHeld,
  };
}

// model batch writer (mirrors upsertMessages: runExclusiveBatch → exclusive txn)
const upsertBatch = (db, ids) => runExclusiveBatch(() =>
  db.withExclusiveTransactionAsync(async (tx) => {
    for (const id of ids) await tx.runAsync({ kind: 'seed', id, status: 'sent' });
  }),
);

// model outbox writer (mirrors the now-wrapped outboxRemove/outboxEnqueue)
const outboxWrite = (db, id) => runExclusive(async () => { await db.runAsync({ kind: 'statusSet', id: `outbox_${id}`, status: 'sent' }); });

// ─────────────────────────────────────────────────────────────────────────────
// TEST HARNESS
// ─────────────────────────────────────────────────────────────────────────────
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗ FAIL:'} ${msg}`); if (!cond) failures++; };
const withTimeout = (p, ms, label) => Promise.race([
  p,
  delay(ms).then(() => { throw new Error(`TIMEOUT (possible deadlock): ${label}`); }),
]);
const resetPrimitives = () => { _writeChain = Promise.resolve(); _statusBuffer = new Map(); if (_statusFlushTimer) { clearTimeout(_statusFlushTimer); _statusFlushTimer = null; } };

async function testContention() {
  console.log('\n[1] CONTENTION: incoming batches × delivery/read receipts × outbox, same chat');
  resetPrimitives();
  const m = makeModelDb(); _DB = m.db;

  const MSG_IDS = Array.from({ length: 60 }, (_, i) => `m${i}`);
  const expected = new Map();
  const note = (id, st) => { if ((STATUS_PRIORITY[st] || 0) > (STATUS_PRIORITY[expected.get(id)] || 0)) expected.set(id, st); };

  const work = [];
  // 40 incoming-message batches (exclusive transactions)
  for (let b = 0; b < 40; b++) work.push((async () => { await delay(Math.floor(b / 4)); await upsertBatch(m.db, MSG_IDS.slice(0, 5)); })());
  // 600 receipt status writes (coalesced), monotonic sequence sent→delivered→seen
  const ladder = ['sent', 'delivered', 'seen'];
  for (let i = 0; i < 600; i++) {
    const id = MSG_IDS[i % MSG_IDS.length];
    const st = ladder[Math.min(2, Math.floor(i / MSG_IDS.length))];
    note(id, st);
    work.push((async () => { await delay(i % 7); await updateMessageStatus(id, st); })());
  }
  // 80 outbox writes (single-statement, now serialized)
  for (let o = 0; o < 80; o++) work.push((async () => { await delay(o % 5); await outboxWrite(m.db, o); })());

  await withTimeout(Promise.all(work), 8000, 'contention burst');
  await withTimeout(awaitStatusDrain(), 4000, 'status drain');

  ok(m.stats.busy === 0, `zero SQLITE_BUSY (busy=${m.stats.busy}, mainWrites=${m.stats.mainWrites}, batchWrites=${m.stats.batchWrites})`);
  let wrong = 0;
  for (const [id, st] of expected) if (m.messages.get(id) !== st) wrong++;
  ok(wrong === 0, `all ${expected.size} message statuses converged to the highest rank (mismatches=${wrong})`);
}

async function testNoDowngrade() {
  console.log('\n[2] MONOTONIC: replayed/out-of-order receipts never downgrade read→delivered');
  resetPrimitives();
  const m = makeModelDb(); _DB = m.db;
  await updateMessageStatus('x', 'seen');      // reach top rank first
  await awaitStatusDrain();
  await updateMessageStatus('x', 'delivered'); // stale replay arrives later
  await updateMessageStatus('x', 'sent');      // even older replay
  await awaitStatusDrain();
  ok(m.messages.get('x') === 'seen', `status stayed 'seen' despite later delivered/sent replays (got '${m.messages.get('x')}')`);
}

// The upsertPresenceCache lock: a single-statement write that ran OUTSIDE chain
// order (the old re-entrant "inline" path) could still be executing on the main
// connection when the next batch grabbed BEGIN EXCLUSIVE on the dedicated
// connection → cross-connection "database is locked". Proven against BOTH the old
// inline design (reproduces the lock) and the new strict-FIFO design (fixes it).
async function testInlineEscapeFixed() {
  console.log('\n[3] INLINE-ESCAPE LOCK: a single write must never overlap a following batch (upsertPresenceCache bug)');

  const runScenario = async (serializer) => {
    let dedicatedHeld = false;
    const stats = { busy: 0 };
    // Main-connection write: getDB()+prep land it a bit LATER, then the statement
    // needs the WAL writer lock to commit — busies if a batch holds it.
    const mainWrite = async () => {
      await delay(8);
      const start = Date.now();
      while (dedicatedHeld) {
        if (Date.now() - start >= BUSY_TIMEOUT_MS) { stats.busy++; throw new Error('database is locked'); }
        await delay(4);
      }
    };
    const batch = () => serializer.batch(async () => {
      dedicatedHeld = true;                       // BEGIN EXCLUSIVE on dedicated conn
      try { await delay(BATCH_HOLD_MS); } finally { dedicatedHeld = false; }
    });

    const S = serializer.single(async () => { await delay(5); }); // a single writer in-flight
    await delay(1);                                                // P arrives WHILE S runs
    const P = serializer.single(mainWrite).catch(() => {});        // presence write
    const B = batch();                                             // sync batch right after
    await Promise.all([S, P, B]);
    return stats.busy;
  };

  // OLD design — re-entrant inline: P escapes chain order while S holds the window.
  const oldSerializer = (() => {
    let chain = Promise.resolve(), holding = false;
    const single = (task) => {
      if (holding) return Promise.resolve().then(task); // inline → escapes the chain
      const r = async () => { holding = true; try { return await task(); } finally { holding = false; } };
      const n = chain.then(r, r); chain = n.catch(() => {}); return n;
    };
    const batch = (task) => { const n = chain.then(task, task); chain = n.catch(() => {}); return n; };
    return { single, batch };
  })();
  // NEW design — strict FIFO (production): every write queues, none escapes.
  const newSerializer = (() => {
    let chain = Promise.resolve();
    const single = (task) => { const n = chain.then(task, task); chain = n.catch(() => {}); return n; };
    return { single, batch: single };
  })();

  const oldBusy = await withTimeout(runScenario(oldSerializer), 3000, 'old-inline scenario');
  const newBusy = await withTimeout(runScenario(newSerializer), 3000, 'strict-fifo scenario');
  ok(oldBusy > 0, `OLD inline design reproduces the lock (busy=${oldBusy}) — confirms the scenario is real`);
  ok(newBusy === 0, `NEW strict-FIFO: the single write queues, never overlaps the batch (busy=${newBusy})`);
}

async function testBatchInternalWrite() {
  console.log('\n[4] NO-DEADLOCK: writes issued from inside a batch use the txn handle and commit atomically');
  resetPrimitives();
  const m = makeModelDb(); _DB = m.db;
  await withTimeout(runExclusiveBatch(() => m.db.withExclusiveTransactionAsync(async (tx) => {
    // The supported pattern: batch internals write through `tx`, never via a
    // self-wrapping runExclusive writer.
    for (let i = 0; i < 5; i++) await tx.runAsync({ kind: 'seed', id: `c${i}`, status: 'sent' });
  })), 2000, 'batch internal writes');
  ok(m.stats.busy === 0 && m.stats.batchWrites === 5, `batch committed 5 rows on the dedicated connection, zero busy`);
}

async function testControlNegative() {
  console.log('\n[5] CONTROL (proves the harness catches the bug): pre-fix BARE writers DO collide');
  resetPrimitives();
  const m = makeModelDb(); _DB = m.db;
  const work = [];
  for (let b = 0; b < 20; b++) work.push(upsertBatch(m.db, ['z']));
  // Pre-fix behaviour: status/outbox writes go straight to the main connection,
  // bypassing the serializer — exactly what the fix removed.
  for (let i = 0; i < 200; i++) {
    work.push((async () => { await delay(i % 9); try { await m.db.bareMainWrite({ kind: 'statusSet', id: `bare${i}`, status: 'delivered' }); } catch { /* counted in stats.busy */ } })());
  }
  await withTimeout(Promise.all(work), 8000, 'control burst');
  ok(m.stats.busy > 0, `bare writers reproduced SQLITE_BUSY (busy=${m.stats.busy}) → confirms the fixed path's busy=0 is meaningful`);
}

(async () => {
  console.log('SQLite write-contention stress harness — Phase 4');
  await testContention();
  await testNoDowngrade();
  await testInlineEscapeFixed();
  await testBatchInternalWrite();
  await testControlNegative();
  console.log(`\n${failures === 0 ? 'ALL PASS ✓' : `${failures} FAILURE(S) ✗`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
