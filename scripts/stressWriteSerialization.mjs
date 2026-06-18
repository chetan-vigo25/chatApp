// Stress test for the SQLite write-serialization fix.
//
// expo-sqlite is a NATIVE module and cannot run under Node, so this test models
// the exact failure mode in pure JS: a mock connection whose
// `withExclusiveTransaction` holds a writer lock, and whose write primitives
// THROW "database is locked" if any other write overlaps the lock — i.e. the
// SQLITE_BUSY collision we fixed. It then drives the real production primitives
// (runExclusive + the status coalescer) under a burst and asserts:
//   1. ZERO "database is locked" — proves serialization removes the race.
//   2. Correct final monotonic statuses — proves coalescing never downgrades.
//   3. No deadlock when a write is triggered from INSIDE a batch (re-entrancy
//      handled by the passed-handle convention).
//
// Run: node scripts/stressWriteSerialization.mjs

// ── Production primitive (copied verbatim from ChatDatabase.js) ──────────────
let _writeChain = Promise.resolve();
const runExclusive = (task) => {
  const next = _writeChain.then(task, task);
  _writeChain = next.catch(() => {});
  return next;
};

// ── Mock connection that reproduces WAL writer-lock contention ───────────────
let lockHeld = false;
let busyErrors = 0;
const rows = new Map(); // messageId -> status
const STATUS_PRIORITY = { scheduled: 0, cancelled: 0, processing: 0, sending: 1, uploaded: 2, sent: 3, delivered: 4, seen: 5, read: 5 };

const tick = () => new Promise((r) => setTimeout(r, 1));

const assertNotLocked = () => {
  if (lockHeld) { busyErrors++; throw new Error('database is locked'); }
};

const db = {
  // Bare single-statement write — fails if a transaction currently holds the lock.
  async runAsync(setRows) {
    assertNotLocked();
    await tick();
    assertNotLocked();
    setRows();
  },
  // Exclusive transaction — grabs the lock for its whole duration.
  async withExclusiveTransactionAsync(task) {
    assertNotLocked();           // BEGIN EXCLUSIVE fails if someone else holds it
    lockHeld = true;
    try {
      await task({ runAsync: async (setRows) => { await tick(); setRows(); } });
    } finally {
      lockHeld = false;
    }
  },
};

// ── Production-shaped writers (all routed through runExclusive) ───────────────
const upsertBatch = (ids) => runExclusive(() => db.withExclusiveTransactionAsync(async (tx) => {
  for (const id of ids) await tx.runAsync(() => { if (!rows.has(id)) rows.set(id, 'sent'); });
}));

// Coalescer (mirrors the ChatDatabase implementation)
let buffer = new Map();
let flushTimer = null;
const flushStatus = () => runExclusive(async () => {
  flushTimer = null;
  if (buffer.size === 0) return;
  const buf = buffer; buffer = new Map();
  const byStatus = new Map();
  for (const [id, status] of buf) { if (!byStatus.has(status)) byStatus.set(status, []); byStatus.get(status).push(id); }
  for (const [status, ids] of byStatus) {
    const tp = STATUS_PRIORITY[status];
    const lower = new Set(Object.entries(STATUS_PRIORITY).filter(([, p]) => p > 0 && p < tp).map(([s]) => s));
    await db.runAsync(() => {
      for (const id of ids) {
        const cur = rows.get(id);
        if (cur !== undefined && lower.has(cur)) rows.set(id, status); // monotonic, protected excluded
      }
    });
  }
});
const queueStatus = (id, status) => {
  const np = STATUS_PRIORITY[status] || 0;
  const prev = buffer.get(id);
  if (!prev || (STATUS_PRIORITY[prev] || 0) < np) buffer.set(id, status);
  if (!flushTimer) flushTimer = setTimeout(() => flushStatus().catch(() => {}), 5);
};

// ── Drive the collision ──────────────────────────────────────────────────────
const N = 200;
const ids = Array.from({ length: N }, (_, i) => `m${i}`);

const work = [];
// Bursts of incoming-message batches (exclusive transactions)
for (let i = 0; i < N; i += 10) work.push(upsertBatch(ids.slice(i, i + 10)));
// Overlapping per-message delivered + read receipts (coalesced)
for (const id of ids) { queueStatus(id, 'delivered'); }
// Out-of-order: some reads arrive before the delivered flush — must NOT downgrade
for (const id of ids) { queueStatus(id, 'read'); queueStatus(id, 'delivered'); }
// Direct chat-list writers racing the batches
for (let i = 0; i < 30; i++) work.push(runExclusive(() => db.runAsync(() => {})));

// Re-entrancy / no-deadlock: a write triggered from INSIDE a batch via the passed
// handle (the saveReplyData convention) must complete without deadlocking.
let reentrantOk = false;
work.push(runExclusive(() => db.withExclusiveTransactionAsync(async (tx) => {
  await tx.runAsync(() => {});          // uses the tx handle, never re-enters runExclusive
  reentrantOk = true;
})));

await Promise.all(work);
// Let the coalescer timers fire and settle.
await new Promise((r) => setTimeout(r, 50));
await flushStatus();
await _writeChain;

// ── Assertions ───────────────────────────────────────────────────────────────
let pass = true;
const fail = (m) => { pass = false; console.error('  ✗', m); };

if (busyErrors !== 0) fail(`expected 0 "database is locked", got ${busyErrors}`);
else console.log('  ✓ zero SQLITE_BUSY under contention');

const wrongStatus = ids.filter((id) => rows.get(id) !== 'read');
if (wrongStatus.length) fail(`expected all rows 'read' (monotonic), ${wrongStatus.length} wrong (e.g. ${wrongStatus[0]}=${rows.get(wrongStatus[0])})`);
else console.log('  ✓ all rows reached final status "read" (no downgrade from out-of-order events)');

if (!reentrantOk) fail('re-entrant in-transaction write deadlocked / did not complete');
else console.log('  ✓ in-transaction (re-entrant) write completed — no deadlock');

console.log(pass ? '\nPASS — write serialization eliminates the lock class\n' : '\nFAIL\n');
process.exit(pass ? 0 : 1);
