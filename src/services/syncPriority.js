// syncPriority — cooperative pause for low-priority background SQLite work.
//
// Why: heavy writers (e.g. SyncScreen's post-login message warm) run
// `upsertMessages`, which opens a BEGIN EXCLUSIVE transaction on a dedicated
// connection and therefore BLOCKS all reads for its duration. When the user taps
// a chat right after login, the chat-open read (`loadMessages`) gets queued
// behind that write storm → the thread doesn't paint instantly.
//
// This module lets the UI signal "a chat is opening — back off" so the
// background warm yields the writer for a short window, giving the read an
// uncontended slot. It's a time-boxed pause (auto-expires) so a missed
// resume can never permanently stall the background work.

let _pausedUntil = 0;

/**
 * Ask background sync work to pause for `ms`. Repeated calls extend the window.
 * Call this when a chat is opening / actively being read.
 */
export const pauseBackgroundSyncFor = (ms = 1500) => {
  const until = Date.now() + Math.max(0, ms);
  if (until > _pausedUntil) _pausedUntil = until;
};

export const isBackgroundSyncPaused = () => Date.now() < _pausedUntil;

/**
 * Resolve once the current pause window has elapsed. Background workers `await`
 * this before each unit of write work so they cooperatively yield to the UI.
 */
export const waitWhilePaused = async () => {
  // Poll in short slices so a freshly-extended pause is respected promptly.
  while (true) {
    const remaining = _pausedUntil - Date.now();
    if (remaining <= 0) return;
    await new Promise((r) => setTimeout(r, Math.min(remaining, 200)));
  }
};

export default { pauseBackgroundSyncFor, isBackgroundSyncPaused, waitWhilePaused };
