/**
 * App-icon badge (P-A-14). ONE value: the sum of unread counts in SQLite
 * `chats.unread_count` — the same numbers the in-app unread state mirrors
 * (RealtimeChatContext.unreadByChat -> chats.unread_count). Event-driven only:
 * callers invoke syncAppBadge() on foreground/background transitions and after a
 * chat is read; there is no timer. Uses notifee.setBadgeCount (already a
 * dependency; iOS badge + launchers that support it on Android).
 */
import { badgeValue } from '../utils/messagePushPolicy';

let _inFlight = null;
let _again = false;

const run = async () => {
  let notifee = null;
  try {
    const mod = require('@notifee/react-native');
    notifee = mod.default || mod;
  } catch (_) { return; }
  if (!notifee || typeof notifee.setBadgeCount !== 'function') return;
  try {
    const ChatDatabase = require('../services/ChatDatabase').default || require('../services/ChatDatabase');
    const total = await ChatDatabase.getTotalUnread();
    await notifee.setBadgeCount(badgeValue(total));
  } catch (_) { /* best-effort */ }
};

// Coalesces overlapping calls: at most one run in flight plus one trailing run.
export const syncAppBadge = () => {
  if (_inFlight) { _again = true; return _inFlight; }
  _inFlight = run().finally(() => {
    _inFlight = null;
    if (_again) { _again = false; syncAppBadge(); }
  });
  return _inFlight;
};
