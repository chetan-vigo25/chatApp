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

export const isMessageGroupingAvailable = () => Platform.OS === 'android' && !!getNotifee();

// notifee rejects the whole displayNotification call if ANY `data` value is not
// a string (the canonical model carries boolean `isGroup`, numeric `timestamp`)
// — and a rejected call means the notification is NEVER SHOWN. Coerce
// everything: primitives via String(), objects via JSON.stringify, drop
// null/undefined. Tap consumers already parse strings (isTruthyString handles
// 'true'/'false'; Number() handles numeric strings).
const toNotifeeData = (obj = {}) => {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined || typeof value === 'function') continue;
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'object') {
      try { out[key] = JSON.stringify(value); } catch (_) { /* skip unserializable */ }
    } else out[key] = String(value);
  }
  return out;
};

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
  const senderName = data?.senderName || data?.senderFullName || data?.name || data?.title || 'New message';
  // Prefer the un-prefixed per-line preview (`lineBody`); MessagingStyle attaches
  // the sender to each line itself, so the "Sender: " prefix must not be doubled.
  const text = data?.lineBody || data?.body || data?.message || data?.text || data?.content || '';
  if (!text) return false;
  const timestamp = Number(data?.timestamp || data?.sentAt || Date.now()) || Date.now();
  const senderId = String(data?.senderId || senderName);

  // Accumulate this message into the chat's recent-message list.
  const prior = await loadMessages(chatId);
  prior.push({ text, timestamp, senderName, senderId });
  const msgs = prior.slice(-MAX_LINES);
  await saveMessages(chatId, msgs);

  const { AndroidImportance, AndroidStyle, AndroidVisibility } = _consts;
  try {
    await notifee.createChannel({
      id: CHANNEL_ID,
      name: 'Chat Messages',
      importance: AndroidImportance.HIGH,
      sound: 'notification_sound',
    });
  } catch (_) { /* channel may already exist (created by expo) */ }

  const convoTitle = isGroup ? (data?.groupName || senderName) : senderName;

  try {
    await notifee.displayNotification({
      id: `msg-${chatId}`,
      title: convoTitle,
      body: text,
      data: { ...toNotifeeData(data), type: 'message' },
      android: {
        channelId: CHANNEL_ID,
        smallIcon: 'notification_icon',
        color: '#03b0a2',
        importance: AndroidImportance.HIGH,
        visibility: AndroidVisibility.PRIVATE,
        pressAction: { id: 'default', launchActivity: 'default' },
        // Join the shared group so multiple chats collapse under one summary.
        groupId: ANDROID_GROUP_KEY,
        style: {
          type: AndroidStyle.MESSAGING,
          person: { name: 'You' }, // the receiver (this device)
          group: isGroup,
          ...(isGroup && data?.groupName ? { title: data.groupName } : {}),
          messages: msgs.map((m) => ({
            text: m.text,
            timestamp: m.timestamp,
            // sender of each line — drives the "Name: message" rows + avatars
            person: { name: m.senderName || 'Unknown', id: String(m.senderId || m.senderName || '') },
          })),
        },
      },
    });
    await ensureGroupSummary(notifee, AndroidImportance, AndroidVisibility);
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
const ensureGroupSummary = async (notifee, AndroidImportance, AndroidVisibility) => {
  try {
    await notifee.displayNotification({
      id: GROUP_SUMMARY_ID,
      title: 'New messages',
      body: 'You have new messages',
      android: {
        channelId: CHANNEL_ID,
        smallIcon: 'notification_icon',
        color: '#03b0a2',
        importance: AndroidImportance.HIGH,
        visibility: AndroidVisibility.PRIVATE,
        groupId: ANDROID_GROUP_KEY,
        groupSummary: true,
        pressAction: { id: 'default', launchActivity: 'default' },
      },
    });
  } catch (_) { /* summary is best-effort; per-chat notifications still show */ }
};

// Call when the user opens/reads a chat → clear its notification + accumulated
// lines so the thread doesn't keep showing already-seen messages.
export const clearMessageNotification = async (chatId) => {
  if (!chatId) return;
  const notifee = getNotifee();
  try { if (notifee) await notifee.cancelNotification(`msg-${chatId}`); } catch (_) { /* */ }
  try { await AsyncStorage.removeItem(STORE_PREFIX + chatId); } catch (_) { /* */ }
  // If no per-chat message notifications remain, drop the group summary so an
  // empty "New messages" header doesn't linger in the tray.
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
