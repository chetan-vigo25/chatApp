/**
 * contactEvents
 * ─────────────
 * Tiny pub/sub fired by ContactDatabase whenever the on-device contacts table
 * changes (sync upsert, contact removed, stale sweep, wipe).
 *
 * It exists as its own module so ContactDatabase can announce a change without
 * importing the name store (which imports ContactDatabase — a require cycle the
 * app has been bitten by before; see the "Require Cycles Fixed" note).
 *
 * This is the signal that makes display names re-resolve live across every
 * mounted screen: DB write → emit → contactNameStore reloads → subscribers
 * re-render. No restart, no re-navigation, no new message needed.
 */

const listeners = new Set();

export const emitContactsChanged = (reason = 'unknown') => {
  for (const fn of listeners) {
    try { fn(reason); } catch { /* one bad listener must not break the rest */ }
  }
};

export const subscribeContactsChanged = (fn) => {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

export default { emitContactsChanged, subscribeContactsChanged };
