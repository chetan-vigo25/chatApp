import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadContactNames, resolveDisplayName as resolveCanonicalName } from '../services/contactNameStore';
import { createKeyedSerial } from '../utils/keyedSerial';
import { buildAndroidMessageActions, supportsInlineActions } from '../utils/messagePushPolicy';

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
const CHANNEL_ID = 'chat_messages_v3'; // must match fcmService.js CHANNEL_VERSION
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

// P-A-09: every read-modify-write of a chat's stored lines (and the notification
// rebuilt from them) runs through this per-chat chain, so two pushes for the same
// chat can no longer both read the old list and overwrite each other's line.
const runForChat = createKeyedSerial();

// Inline Reply (P-A-10) on 1:1 and group threads only.
const inlineActionsFor = (data) => {
  if (!supportsInlineActions(data)) return {};
  const actions = buildAndroidMessageActions();
  return actions.length ? { actions } : {};
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
  return runForChat(String(chatId), () => displayGroupedMessageUnlocked(notifee, chatId, data));
};

const displayGroupedMessageUnlocked = async (notifee, chatId, data) => {

  const isGroup = typeof data?.isGroup === 'boolean'
    ? data.isGroup
    : (data?.chatType === 'group' || !!data?.groupId);
  // The push carries the sender's SELF-SET account name as a fallback; the name
  // actually shown must follow the device's address book: saved name → number →
  // push name. Runs headless on a killed app, so load the index explicitly.
  await loadContactNames().catch(() => {});
  const serverSenderName = data?.senderName || data?.senderFullName || data?.name || data?.title || '';
  // Contact privacy. FCM data values are always STRINGS, so the flag arrives as
  // 'true'/'false' (or absent) and must be compared as text — `Boolean('false')`
  // is true and would hide the number for everyone.
  const senderHidesContact = String(data?.senderHideContact ?? '') === 'true';
  const senderName = resolveCanonicalName({
    userId: data?.senderId,
    phone: data?.senderMobile || data?.mobileNumber || null,
    pushName: serverSenderName,
    // The resolver puts this branch AFTER the saved-contact check and BEFORE the
    // number, so a sender who hides their number shows as "@handle" even if an
    // older/cached payload still carries `senderMobile`.
    username: data?.senderUserName || null,
    hideContact: senderHidesContact,
    fallback: 'New message',
  });
  // Prefer the un-prefixed per-line preview (`lineBody`); MessagingStyle attaches
  // the sender to each line itself, so the "Sender: " prefix must not be doubled.
  const text = data?.lineBody || data?.body || data?.message || data?.text || data?.content || '';
  if (!text) return false;
  const timestamp = Number(data?.timestamp || data?.sentAt || Date.now()) || Date.now();
  const senderId = String(data?.senderId || senderName);

  // Accumulate this message into the chat's recent-message list.
  const prior = await loadMessages(chatId);
  prior.push({ text, timestamp, senderName, senderId, ...(data?.messageId ? { messageId: String(data.messageId) } : {}) });
  const msgs = prior.slice(-MAX_LINES);
  await saveMessages(chatId, msgs);

  const { AndroidImportance, AndroidStyle, AndroidVisibility, AndroidGroupAlertBehavior } = _consts;
  try {
    await notifee.createChannel({
      id: CHANNEL_ID,
      name: 'Chat Messages',
      importance: AndroidImportance.HIGH,
      sound: 'default',
    });
  } catch (_) { /* channel may already exist (created by expo) */ }

  // A push for a GROUP message often carries no group name (the server only
  // sends the sender), and the notification then read like a 1-1 chat from
  // that person — the same message showing twice, once as the group and once
  // as "@sender". The local chat row already knows the group's name, so use it
  // whenever the payload leaves it out. Headless-safe: SQLite is available in
  // the background handler.
  let groupTitle = data?.groupName || data?.chatName || '';
  if (isGroup && !groupTitle) {
    try {
      const ChatDatabase = require('../services/ChatDatabase').default || require('../services/ChatDatabase');
      const row = await ChatDatabase.getChatById(String(data?.groupId || chatId));
      groupTitle = row?.chatName || row?.group?.name || row?.groupName || '';
    } catch (_) { /* fall back to the sender's name below */ }
  }
  const convoTitle = isGroup ? (groupTitle || senderName) : senderName;

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
        ...inlineActionsFor(data),
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
    await ensureGroupSummary(notifee, AndroidImportance, AndroidVisibility, AndroidGroupAlertBehavior);
    await cancelForeignChatNotifications(notifee);
    return true;
  } catch (err) {
    console.warn('[msgNotif] MessagingStyle display failed:', err?.message);
    return false;
  }
};

// Drop the tray copy Android rendered ITSELF from a push that carried a
// `notification` block. That copy is ungrouped, says whatever generic text the
// server put in it ("New media message"), and shows a 1-1 style row even for a
// group — so the user saw the same message twice, once right and once wrong.
// We cannot stop the OS from drawing it, but we can take it away right after
// our own MessagingStyle notification lands.
//
// Everything this app posts itself carries a known id ('msg-…' here, 'call-…' /
// 'missed-…' / 'ongoing-call' for calls), so anything else in our tray came
// from the OS push path. Call alerts are never touched, by id and by wording.
const cancelForeignChatNotifications = async (notifee) => {
  try {
    const displayed = await notifee.getDisplayedNotifications();
    for (const entry of displayed || []) {
      const id = entry?.id == null ? '' : String(entry.id);
      if (!id) continue;
      if (id.startsWith('msg-') || id.startsWith('call-') || id.startsWith('missed-') || id === 'ongoing-call') continue;
      const text = `${entry?.notification?.title || ''} ${entry?.notification?.body || ''}`.toLowerCase();
      if (text.includes('call')) continue;
      const tag = entry?.notification?.android?.tag;
      try { await notifee.cancelDisplayedNotification(id, tag); } catch (_) { /* */ }
    }
  } catch (_) { /* best-effort */ }
};

// Post (or refresh) the group summary that anchors the per-chat notifications.
// Android only renders the summary once 2+ notifications share the group, so a
// single chat still shows its own MessagingStyle notification — exactly like
// WhatsApp, which only shows the "N chats" summary when several chats are unread.
const ensureGroupSummary = async (notifee, AndroidImportance, AndroidVisibility, AndroidGroupAlertBehavior) => {
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
        // The summary is posted right after the chat's own MessagingStyle
        // notification, on the same HIGH channel. Left to alert on its own,
        // Android treats the pair as one app being noisy and silences one of
        // them ("NotifAttentionHelper: Muting recently noisy") — measured on
        // device, and the one it silenced was sometimes the REAL message, so
        // the phone stayed quiet for an incoming message. CHILDREN says only
        // the per-chat notifications may make a sound.
        ...(AndroidGroupAlertBehavior ? { groupAlertBehavior: AndroidGroupAlertBehavior.CHILDREN } : {}),
        pressAction: { id: 'default', launchActivity: 'default' },
      },
    });
  } catch (_) { /* summary is best-effort; per-chat notifications still show */ }
};

// Call when the user opens/reads a chat → clear its notification + accumulated
// lines so the thread doesn't keep showing already-seen messages.
const clearMessageNotificationUnlocked = async (chatId) => {
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

export const clearMessageNotification = async (chatId) => {
  if (!chatId) return;
  return runForChat(String(chatId), () => clearMessageNotificationUnlocked(chatId));
};

// Re-post the chat's notification IN PLACE from `lines` (silent: same id,
// onlyAlertOnce). Title / data / group flag are not stored with the lines, so
// they are read back from the notification currently in the tray. Returns false
// when nothing is visible to update.
const refreshNotificationInPlace = async (notifee, chatId, lines) => {
  const displayed = await notifee.getDisplayedNotifications();
  const entry = (displayed || []).find((n) => String(n?.id || '') === `msg-${chatId}`);
  if (!entry?.notification) return false;
  const cur = entry.notification;
  const curStyle = cur.android?.style || {};
  const { AndroidImportance, AndroidStyle, AndroidVisibility } = _consts;
  const last = lines[lines.length - 1];
  await notifee.displayNotification({
    id: `msg-${chatId}`,
    title: cur.title,
    body: last.text,
    data: cur.data || {},
    android: {
      channelId: CHANNEL_ID,
      smallIcon: 'notification_icon',
      color: '#03b0a2',
      importance: AndroidImportance.HIGH,
      visibility: AndroidVisibility.PRIVATE,
      pressAction: { id: 'default', launchActivity: 'default' },
      ...inlineActionsFor(cur.data || {}),
      groupId: ANDROID_GROUP_KEY,
      onlyAlertOnce: true, // silent in-place refresh: no sound / heads-up
      style: {
        type: AndroidStyle.MESSAGING,
        person: { name: 'You' },
        group: !!curStyle.group,
        ...(curStyle.title ? { title: curStyle.title } : {}),
        messages: lines.map((m) => ({
          text: m.text,
          timestamp: m.timestamp,
          person: { name: m.senderName || 'Unknown', id: String(m.senderId || m.senderName || '') },
        })),
      },
    },
  });
  return true;
};

// A message was deleted for everyone (silent `message_deleted` push, or the live
// socket event). Drop its line from the chat's stored thread and refresh the
// notification IN PLACE with the remaining lines, or cancel it when none remain.
// Never alerts. Lines stored before messageId was recorded cannot be matched, so
// the notification is left as is (best-effort). Returns true when a stored line
// was removed.
export const removeMessageFromNotification = async (chatId, deletedMessageId) => {
  if (!chatId || !deletedMessageId) return false;
  const notifee = getNotifee();
  if (!notifee) return false;
  const target = String(deletedMessageId);
  return runForChat(String(chatId), async () => {
    try {
      const msgs = await loadMessages(chatId);
      const remaining = msgs.filter((m) => String(m?.messageId || '') !== target);
      if (remaining.length === msgs.length) return false;

      if (!remaining.length) {
        await clearMessageNotificationUnlocked(chatId);
        return true;
      }
      await saveMessages(chatId, remaining);
      await refreshNotificationInPlace(notifee, chatId, remaining);
      return true;
    } catch (_) { return false; }
  });
};

// A displayed message was EDITED for everyone (P-A-05): swap the line's text and
// refresh the notification in place, silently. Returns true when a line matched.
export const updateMessageInNotification = async (chatId, messageId, newText) => {
  const text = String(newText == null ? '' : newText);
  if (!chatId || !messageId || !text) return false;
  const notifee = getNotifee();
  if (!notifee) return false;
  const target = String(messageId);
  return runForChat(String(chatId), async () => {
    try {
      const msgs = await loadMessages(chatId);
      let hit = false;
      const next = msgs.map((m) => {
        if (String(m?.messageId || '') !== target) return m;
        hit = true;
        return { ...m, text };
      });
      if (!hit) return false;
      await saveMessages(chatId, next);
      await refreshNotificationInPlace(notifee, chatId, next);
      return true;
    } catch (_) { return false; }
  });
};

// Logout / session reset: drop every displayed message notification and the
// accumulated @msgnotif/* lines so a stale notification from the old account
// cannot be tapped. Best-effort; never throws.
export const clearAllMessageNotifications = async () => {
  try {
    const notifee = getNotifee();
    if (notifee) {
      try { await notifee.cancelAllNotifications(); } catch (_) { /* */ }
    }
  } catch (_) { /* */ }
  try {
    const Notifications = require('expo-notifications');
    await Notifications.dismissAllNotificationsAsync();
  } catch (_) { /* */ }
  // The previous account's unread count must not stay on the launcher icon.
  try {
    const notifee = getNotifee();
    if (notifee && typeof notifee.setBadgeCount === 'function') await notifee.setBadgeCount(0);
  } catch (_) { /* */ }
  try {
    const keys = await AsyncStorage.getAllKeys();
    const mine = keys.filter((k) => k.startsWith(STORE_PREFIX));
    if (mine.length) await AsyncStorage.multiRemove(mine);
  } catch (_) { /* */ }
};
