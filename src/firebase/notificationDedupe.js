/**
 * notificationDedupe — ONE cross-path "already notified this message?" store.
 *
 * The same message can reach the user twice: once over the live socket (→ the
 * in-app banner in AppBannerHost) and once as a push (→ the OS notification in
 * fcmService). This is common across a background↔foreground transition (the OS
 * delivers the push, then the socket re-flushes the pending message on reconnect).
 * Before this module the banner and the push deduped in SEPARATE stores, so the
 * user saw two notifications for one message.
 *
 * Both surfaces now claim the messageId here BEFORE rendering. First claim wins;
 * the second is suppressed. In-memory + bounded — it lives for the JS context
 * lifetime, which covers foreground AND backgrounded-but-alive (the only states
 * where a banner can race a push). Killed state spins up a fresh JS context with
 * no banner anyway; the iOS Notification Service Extension carries its own
 * App-Group store for its separate process.
 *
 * Pure JS — safe to import from the headless FCM background handler.
 */

const WINDOW_MS = 60000;   // a socket flush can re-deliver a just-pushed msg seconds later
const MAX_ENTRIES = 500;   // hard memory cap; evict oldest (insertion order) on overflow

const shown = new Map(); // dedupeKey -> timestamp

const sweep = (now) => {
  for (const [k, ts] of shown) {
    if (now - ts > WINDOW_MS) shown.delete(k);
  }
  while (shown.size > MAX_ENTRIES) {
    const oldest = shown.keys().next().value;
    if (oldest === undefined) break;
    shown.delete(oldest);
  }
};

/**
 * Atomic check-and-claim. Returns true if THIS caller should render the
 * notification (it was the first to claim the id); false if the message was
 * already notified by the other path and must be SKIPPED to avoid a duplicate.
 * A falsy key can't be deduped, so it is always allowed through.
 */
export const claimNotification = (key) => {
  if (!key) return true;
  const k = String(key);
  const now = Date.now();
  sweep(now);
  if (shown.has(k)) return false;
  shown.set(k, now);
  return true;
};

/** Record an id as notified without claiming (e.g. surfaced elsewhere). */
export const markNotified = (key) => {
  if (!key) return;
  shown.set(String(key), Date.now());
};

/** True if the id was notified within the dedupe window. */
export const wasNotified = (key) => {
  if (!key) return false;
  const k = String(key);
  sweep(Date.now());
  return shown.has(k);
};
