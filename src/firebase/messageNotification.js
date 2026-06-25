import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * WhatsApp-style message notifications (Android) via notifee's MessagingStyle.
 *
 * The problem this solves: posting a fresh notification per message makes each
 * one REPLACE the last (only the newest shows). MessagingStyle instead shows ONE
 * notification per chat that lists the recent messages (a conversation thread)
 * and a count — exactly like WhatsApp.
 *
 * notifee doesn't accumulate messages itself — every update must pass the full
 * recent-message list — so we persist the last few messages per chat in
 * AsyncStorage (survives the background/killed handler) and rebuild the thread on
 * each new message. The notification id is stable per chat (`msg-<chatId>`) so
 * updates grow the same conversation instead of stacking duplicates.
 *
 * REQUIRES the backend to send message pushes as DATA-ONLY (no `notification`
 * block) — otherwise the OS draws its own notification and collapses them, and no
 * client code can change that. iOS is left on the expo path (it threads by app).
 */

// Match the existing chat channel created in fcmService (custom sound).
const CHANNEL_ID = 'chat_messages_v2';
const STORE_PREFIX = '@msgnotif/';
const MAX_LINES = 6;            // most recent N messages kept per chat
const STALE_MS = 6 * 60 * 60 * 1000; // drop accumulated lines older than 6h

// Android multi-chat grouping: every per-chat MessagingStyle notification joins
// this group so the tray coalesces them under ONE summary (WhatsApp-style),
// instead of N loose notifications. The summary is a separate notification.
const ANDROID_GROUP_KEY = 'baatcheet.messages';
const GROUP_SUMMARY_ID = 'msg-summary';

let _notifee = null;
let _consts = null;
let _resolved = false;
const getNotifee = () => {
  if (_resolved) return _notifee;
  _resolved = true;
  try {
    // eslint-disable-next-line global-require
    const mod = require('@notifee/react-native');
    _notifee = mod.default || mod;
    _consts = mod;
  } catch (_) { _notifee = null; }
  return _notifee;
};

// Lazy, crash-safe ChatDatabase accessor — used ONLY to recover a missing group
// name from the local chat list (so a group push without `groupName` still shows
// the group as the title instead of falling back to the sender). Safe in the
// headless background handler; no-ops if SQLite isn't available.
let _chatDb = null;
let _chatDbResolved = false;
const getChatDb = () => {
  if (_chatDbResolved) return _chatDb;
  _chatDbResolved = true;
  try {
    // eslint-disable-next-line global-require
    const mod = require('../services/ChatDatabase');
    _chatDb = mod.default || mod;
  } catch (_) { _chatDb = null; }
  return _chatDb;
};

// Look up the group/chat display name cached locally (the user is a member, so the
// group is in their chat list). Keyed by chatId OR groupId.
const resolveGroupName = async (chatId, groupId) => {
  const db = getChatDb();
  if (!db?.getChatById) return null;
  try {
    const chat = await db.getChatById(groupId || chatId);
    return chat?.groupName || chat?.chatName || null;
  } catch (_) { return null; }
};

export const isMessageGroupingAvailable = () => Platform.OS === 'android' && !!getNotifee();

const loadMessages = async (chatId) => {
  try {
    const raw = await AsyncStorage.getItem(STORE_PREFIX + chatId);
    const arr = raw ? JSON.parse(raw) : [];
    const cutoff = Date.now() - STALE_MS;
    return Array.isArray(arr) ? arr.filter((m) => (m?.timestamp || 0) >= cutoff) : [];
  } catch (_) { return []; }
};
const saveMessages = async (chatId, msgs) => {
  try { await AsyncStorage.setItem(STORE_PREFIX + chatId, JSON.stringify(msgs.slice(-MAX_LINES))); } catch (_) { /* */ }
};

// Per-chat unread COUNT (kept separately from the capped message-line list, which
// only stores the last few). Drives the WhatsApp-style summary header
// "N messages from M chats". Reset when the user opens a chat.
const COUNTS_KEY = `${STORE_PREFIX}__counts`;
const loadCounts = async () => {
  try { return JSON.parse(await AsyncStorage.getItem(COUNTS_KEY)) || {}; } catch (_) { return {}; }
};
const saveCounts = async (counts) => {
  try { await AsyncStorage.setItem(COUNTS_KEY, JSON.stringify(counts)); } catch (_) { /* */ }
};
const bumpCount = async (chatId) => {
  const counts = await loadCounts();
  counts[chatId] = (counts[chatId] || 0) + 1;
  await saveCounts(counts);
  return counts;
};
const clearCount = async (chatId) => {
  const counts = await loadCounts();
  if (counts[chatId] != null) { delete counts[chatId]; await saveCounts(counts); }
};

// WhatsApp-style summary header text: "3 messages from 2 chats" (or "5 messages"
// for a single chat). Correct singular/plural.
const summaryText = (counts) => {
  const chats = Object.keys(counts).filter((id) => counts[id] > 0);
  const total = chats.reduce((sum, id) => sum + counts[id], 0);
  const msgWord = `${total} message${total === 1 ? '' : 's'}`;
  if (chats.length <= 1) return msgWord;
  return `${msgWord} from ${chats.length} chats`;
};

// `data` = the canonical model from notificationModel.buildNotificationModel:
// { chatId, senderId, senderName, lineBody, body, isGroup, groupId, groupName,
//   timestamp, messageId }. Older raw-FCM keys are still tolerated as fallbacks.
export const displayGroupedMessage = async (data) => {
  const notifee = getNotifee();
  if (!notifee) return false;
  const chatId = data?.chatId;
  if (!chatId) return false;

  const isGroup = typeof data?.isGroup === 'boolean'
    ? data.isGroup
    : (data?.chatType === 'group' || !!data?.groupId);
  // STABLE thread key. A group ALWAYS threads under its groupId, so the same group
  // conversation can never fragment into a second (sender-named) notification when
  // the payload's chatId differs between pushes — the cause of "Emmaa's group
  // message also showing as a 1-to-1 chat".
  const threadKey = String((isGroup ? (data?.groupId || chatId) : chatId));
  const senderName = data?.senderName || data?.senderFullName || data?.name || data?.title || 'New message';
  // Prefer the un-prefixed per-line preview (`lineBody`); MessagingStyle attaches
  // the sender to each line itself, so the "Sender: " prefix must not be doubled.
  const text = data?.lineBody || data?.body || data?.message || data?.text || data?.content || '';
  if (!text) return false;
  const timestamp = Number(data?.timestamp || data?.sentAt || Date.now()) || Date.now();
  const senderId = String(data?.senderId || senderName);

  const senderAvatar = data?.avatar || data?.senderImage || data?.profileImage || null;

  // Accumulate this message into the chat's recent-message list + bump the unread
  // count that feeds the "N messages from M chats" summary. Keyed on threadKey so a
  // group's lines/count stay unified across pushes with different chatIds.
  const prior = await loadMessages(threadKey);
  prior.push({ text, timestamp, senderName, senderId, avatar: senderAvatar });
  const msgs = prior.slice(-MAX_LINES);
  await saveMessages(threadKey, msgs);
  const counts = await bumpCount(threadKey);

  const { AndroidImportance, AndroidStyle, AndroidVisibility } = _consts;
  try {
    await notifee.createChannel({
      id: CHANNEL_ID,
      name: 'Chat Messages',
      importance: AndroidImportance.HIGH,
      sound: 'notification_sound',
    });
  } catch (_) { /* channel may already exist (created by expo) */ }

  // The group name MUST be the notification title for a group message. If the push
  // payload didn't carry one (the common cause of "group message looks like a DM"),
  // recover it from the local chat list before falling back to the sender name.
  let groupName = data?.groupName || '';
  if (isGroup && !groupName) {
    groupName = (await resolveGroupName(chatId, data?.groupId)) || '';
  }
  const convoTitle = isGroup ? (groupName || senderName) : senderName;
  // Conversation avatar (round, like WhatsApp): the group photo for a group, the
  // sender's photo for a 1-1. notifee loads http(s) URLs for largeIcon on Android.
  const convoAvatar = isGroup
    ? (data?.groupAvatar || data?.chatAvatar || null)
    : (senderAvatar || null);

  try {
    await notifee.displayNotification({
      id: `msg-${threadKey}`,
      title: convoTitle,
      body: text,
      data: { ...(data || {}), type: 'message' },
      android: {
        channelId: CHANNEL_ID,
        smallIcon: 'notification_icon',
        color: '#00A884',
        importance: AndroidImportance.HIGH,
        visibility: AndroidVisibility.PRIVATE,
        pressAction: { id: 'default', launchActivity: 'default' },
        ...(convoAvatar ? { largeIcon: convoAvatar, circularLargeIcon: true } : {}),
        // Join the shared group so multiple chats collapse under one summary.
        groupId: ANDROID_GROUP_KEY,
        style: {
          type: AndroidStyle.MESSAGING,
          person: { name: 'You' }, // the receiver (this device)
          group: isGroup,
          ...(isGroup && groupName ? { title: groupName } : {}),
          messages: msgs.map((m) => ({
            text: m.text,
            timestamp: m.timestamp,
            // sender of each line — drives the "Name: message" rows + per-sender avatars
            person: {
              name: m.senderName || 'Unknown',
              id: String(m.senderId || m.senderName || ''),
              ...(m.avatar ? { icon: m.avatar } : {}),
            },
          })),
        },
      },
    });
    await ensureGroupSummary(notifee, AndroidImportance, AndroidVisibility, summaryText(counts));
    return true;
  } catch (err) {
    console.warn('[msgNotif] MessagingStyle display failed:', err?.message);
    return false;
  }
};

// Post (or refresh) the group summary that anchors the per-chat notifications.
// Android only renders the summary once 2+ notifications share the group, so a
// single chat still shows its own MessagingStyle notification — exactly like
// WhatsApp, which only shows the "N chats" summary when several chats are unread.
const ensureGroupSummary = async (notifee, AndroidImportance, AndroidVisibility, headerText) => {
  try {
    await notifee.displayNotification({
      id: GROUP_SUMMARY_ID,
      // notifee has NO `subText` field, so the count goes in the TITLE — which is
      // what the COLLAPSED group header renders (WhatsApp-style "N messages from M
      // chats"). InboxStyle.summary echoes it in the expanded summary line.
      title: headerText || 'New messages',
      body: headerText || 'You have new messages',
      android: {
        channelId: CHANNEL_ID,
        smallIcon: 'notification_icon',
        color: '#00A884',
        importance: AndroidImportance.HIGH,
        visibility: AndroidVisibility.PRIVATE,
        groupId: ANDROID_GROUP_KEY,
        groupSummary: true,
        pressAction: { id: 'default', launchActivity: 'default' },
        ...(headerText && _consts?.AndroidStyle
          ? { style: { type: _consts.AndroidStyle.INBOX, lines: [headerText], summary: headerText } }
          : {}),
      },
    });
  } catch (_) { /* summary is best-effort; per-chat notifications still show */ }
};

// Call when the user opens/reads a chat → clear its notification + accumulated
// lines so the thread doesn't keep showing already-seen messages.
export const clearMessageNotification = async (id) => {
  if (!id) return;
  const notifee = getNotifee();
  const target = String(id);
  // Direct key (covers 1-1 and the case where the caller already passes the
  // group id / thread key).
  const clearKey = async (key) => {
    try { if (notifee) await notifee.cancelNotification(`msg-${key}`); } catch (_) { /* */ }
    try { await AsyncStorage.removeItem(STORE_PREFIX + key); } catch (_) { /* */ }
    await clearCount(key);
  };
  await clearKey(target);

  // Group notifications now thread under groupId, so the id the caller passes
  // (a chatId) may not equal the notification's thread key. Match on the stored
  // data.chatId / data.groupId too so opening the chat always clears its notif.
  try {
    if (notifee) {
      const displayed = await notifee.getDisplayedNotifications();
      for (const n of displayed || []) {
        const nid = n?.id;
        if (typeof nid !== 'string' || !nid.startsWith('msg-') || nid === GROUP_SUMMARY_ID) continue;
        const d = n?.notification?.data || {};
        if (String(d.chatId || '') === target || String(d.groupId || '') === target) {
          await clearKey(nid.slice('msg-'.length));
        }
      }
    }
  } catch (_) { /* best-effort */ }

  // If no per-chat message notifications remain, drop the group summary so an
  // empty header doesn't linger in the tray.
  try {
    if (notifee) {
      const displayed = await notifee.getDisplayedNotifications();
      const stillHasChat = (displayed || []).some(
        (n) => typeof n?.id === 'string' && n.id.startsWith('msg-') && n.id !== GROUP_SUMMARY_ID,
      );
      if (!stillHasChat) await notifee.cancelNotification(GROUP_SUMMARY_ID);
    }
  } catch (_) { /* best-effort */ }
};
