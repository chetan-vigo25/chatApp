/**
 * ChatPrewarm — fills ChatCache from SQLite BEFORE the user opens a chat.
 *
 * WHY THIS EXISTS
 * ---------------
 * ChatScreen renders instantly only when ChatCache already holds the thread:
 * that lookup is a synchronous Map hit, so the very first frame can paint real
 * bubbles. A cache MISS instead falls into the async path (getClearedAt →
 * loadMessages → reply batch → setState → derive → render), which reliably
 * blows past the 200ms spinner threshold in ChatScreen.
 *
 * The old warm-up ran fire-and-forget from ChatList's `openChat`, i.e. it
 * STARTED at the moment of the tap and raced ChatScreen's own mount. It almost
 * always lost — both go to the same DB, and ChatScreen gets there first. So the
 * cache was cold on exactly the open it was supposed to make fast.
 *
 * This module moves the read EARLIER: the chat list warms its top rows once it
 * has data, while the user is still looking at the list and deciding what to
 * tap. By the time a tap happens the thread is already in memory.
 *
 * COST CONTROL
 * ------------
 * Warming is deliberately conservative. It reads one screenful per chat for a
 * handful of chats, runs strictly serially (parallel reads on one SQLite
 * connection just queue anyway, while adding lock contention with live writes),
 * yields to the JS thread between chats, and waits for interactions to settle
 * so it never competes with the list's own render or a navigation animation.
 */

import { InteractionManager } from 'react-native';
import ChatCache from './ChatCache';
import ChatDatabase from './ChatDatabase';
import { subscribeSessionReset, subscribeUserChanged } from './sessionEvents';

// How many of the most recent chats to keep hot. The list itself shows ~8-10
// above the fold, and those are overwhelmingly what gets tapped.
const PREWARM_CHAT_COUNT = 10;

// One visible screenful. Matches FIRST_PAINT_PAGE_SIZE in useChatLogic — the
// window grows from SQLite in a background follow-up right after first paint,
// so reading more here would only slow the warm down for no visible gain.
const PREWARM_MESSAGE_LIMIT = 20;

// A chat is re-warmed at most this often. Live writes already keep a warm entry
// current via ChatCache.addMessage, so re-reading is pure waste.
const REWARM_INTERVAL_MS = 60000;

const _lastWarmedAt = new Map();
let _inFlight = null;
let _cancelled = false;

const _yield = () => new Promise((r) => setTimeout(r, 0));

/**
 * Warm a single chat. Resolves to true if the cache now holds this thread.
 * Never throws — a failed warm just means ChatScreen takes the async path.
 */
export const prewarmChat = async (chatId) => {
  if (!chatId) return false;
  const id = String(chatId);

  // Already hot and recently refreshed → nothing to do.
  if (ChatCache.hasMessages(id)) {
    const last = _lastWarmedAt.get(id) || 0;
    if (Date.now() - last < REWARM_INTERVAL_MS) return true;
  }

  try {
    // Honors the per-chat clear tombstone, exactly like the chat's own read
    // path — without it a warmed cache would resurrect cleared history.
    // getClearedAt is memoized after the first call, so this is ~free on
    // repeat warms.
    const clearedAt = (await ChatDatabase.getClearedAt(id)) || 0;
    const msgs = await ChatDatabase.loadMessages(id, {
      limit: PREWARM_MESSAGE_LIMIT,
      afterTimestamp: clearedAt,
      // Never let a warm take the write mutex. The inline temp-row cleanup is
      // maintenance; the chat's own open path runs the broader dedup anyway.
      skipCleanup: true,
    });
    _lastWarmedAt.set(id, Date.now());
    if (msgs && msgs.length > 0) {
      ChatCache.setMessages(id, msgs);
      return true;
    }
  } catch {
    // Swallowed on purpose: a warm is an optimization, never a correctness
    // requirement. Schema migrations, a locked DB, a missing chat — all fine.
  }
  return false;
};

/**
 * Warm the top chats from an ordered chat list. Safe to call on every list
 * update: already-hot chats are skipped, and a second call while one is still
 * running is coalesced into the in-flight pass rather than doubling the reads.
 *
 * @param chatIds  chat ids in display order (most recent first)
 */
export const prewarmChats = (chatIds) => {
  if (!Array.isArray(chatIds) || chatIds.length === 0) return Promise.resolve();
  if (_inFlight) return _inFlight;

  const targets = chatIds
    .map((c) => (c == null ? null : String(c)))
    .filter(Boolean)
    .slice(0, PREWARM_CHAT_COUNT);
  if (targets.length === 0) return Promise.resolve();

  _cancelled = false;
  _inFlight = (async () => {
    // Let the list finish painting (and any navigation animation finish) before
    // touching the DB. Warming is never urgent; a janky list is very visible.
    await new Promise((resolve) => InteractionManager.runAfterInteractions(resolve));
    for (const id of targets) {
      if (_cancelled) break;
      await prewarmChat(id);
      await _yield(); // hand the JS thread back between chats
    }
  })()
    .catch(() => {})
    .finally(() => { _inFlight = null; });

  return _inFlight;
};

/**
 * Stop an in-progress pass. Called on logout/account switch so a warm started
 * under the old session can't write another user's rows into the cache.
 */
export const cancelPrewarm = () => {
  _cancelled = true;
  _lastWarmedAt.clear();
};

// A pass started under the previous session must never land another account's
// rows in the cache, and the "recently warmed" memo would otherwise suppress
// the new user's first warm.
subscribeSessionReset(() => cancelPrewarm());
subscribeUserChanged(() => cancelPrewarm());

export default { prewarmChat, prewarmChats, cancelPrewarm };
