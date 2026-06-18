// Throttle `message:read:all` / `group:message:read:all` emits per chat.
//
// Opening a chat triggers "mark all read" from MORE THAN ONE code path
// (useChatLogic chat-init AND RealtimeChatContext.setActiveChat), and re-renders
// / re-inits can re-fire them — so the backend sees a burst of duplicate
// `message:read:all` events on every open (visible as repeated
// `message:read:all:response` logs). read:all is idempotent — the local read
// watermark is already advanced and the server uses $max / updateMany — so
// collapsing repeats within a short window is safe and loses nothing.
const _lastReadAll = new Map(); // chatId -> last-emit timestamp
const READ_ALL_THROTTLE_MS = 1500;
const MAX_TRACKED = 200;

export const shouldEmitReadAll = (chatId) => {
  if (!chatId) return false;
  const now = Date.now();
  const last = _lastReadAll.get(chatId) || 0;
  if (now - last < READ_ALL_THROTTLE_MS) return false;
  _lastReadAll.set(chatId, now);
  // Bound growth: drop the oldest entry when the map gets large.
  if (_lastReadAll.size > MAX_TRACKED) {
    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [k, ts] of _lastReadAll) {
      if (ts < oldestTs) { oldestTs = ts; oldestKey = k; }
    }
    if (oldestKey != null) _lastReadAll.delete(oldestKey);
  }
  return true;
};

export default { shouldEmitReadAll };
