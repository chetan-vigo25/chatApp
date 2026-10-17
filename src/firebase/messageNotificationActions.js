/**
 * Android inline actions on message notifications (P-A-10): Reply (text input)
 * and Mark as read. Runs from notifee's background event handler (headless, app
 * killed/backgrounded) AND its foreground handler — every dependency is lazily
 * required so importing this module never pulls a React tree in.
 *
 * REPLY goes through the app's NORMAL send path:
 *   1. an optimistic SQLite row (status 'sending', temp id == clientMessageId)
 *      and the chat-list preview, exactly like handleSendText;
 *   2. a durable `outbox` row carrying the same clientMessageId;
 *   3. 1:1 — one direct REST attempt (the same `user/chat/message/send` call the
 *      OutboxWorker makes). On success the row is acked + the outbox row removed;
 *      on failure the outbox row stays and the worker re-sends it later.
 *      Group — REST cannot carry a group send, so with a live socket (JS alive)
 *      the worker is woken; with NO JS runtime (killed app) the row waits in the
 *      outbox and is sent on the next app start. OutboxWorker is only started by
 *      RealtimeChatContext, so it does NOT run headless — no timers are added.
 *
 * MARK AS READ clears the tray + local unread and emits the real read events
 * (`message:read:all` / `group:message:read:all` / `message:read:upto`) the chat
 * screen emits. Those need an authenticated socket and the message in SQLite, so
 * the chat id is also persisted in a tiny pending list that
 * flushPendingNotificationReads() drains after the next catch-up. The server
 * keeps enforcing read-receipt privacy; this only asks for the same receipts.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ACTION_REPLY, ACTION_MARK_READ, buildReplyPayload, isPushForUser, normalizeId,
} from '../utils/messagePushPolicy';

const PENDING_READ_KEY = '@notif/pendingRead';
const PENDING_READ_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_READ_MAX = 50;

const loadSession = async () => {
  try {
    const { getStoredSession } = require('../services/sessionManager');
    const s = await getStoredSession();
    return { userId: s?.userId ? String(s.userId) : '', name: s?.userInfo?.fullName || s?.userInfo?.name || '' };
  } catch (_) { return { userId: '', name: '' }; }
};

const readPending = async () => {
  try {
    const raw = await AsyncStorage.getItem(PENDING_READ_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    const cutoff = Date.now() - PENDING_READ_TTL_MS;
    return Array.isArray(arr) ? arr.filter((e) => e && e.chatId && (e.at || 0) >= cutoff) : [];
  } catch (_) { return []; }
};
const writePending = async (list) => {
  try {
    if (!list.length) await AsyncStorage.removeItem(PENDING_READ_KEY);
    else await AsyncStorage.setItem(PENDING_READ_KEY, JSON.stringify(list.slice(-PENDING_READ_MAX)));
  } catch (_) { /* best-effort */ }
};

const isSocketUp = () => {
  try {
    const { isSocketAuthed } = require('../Redux/Services/Socket/socket');
    return !!isSocketAuthed();
  } catch (_) { return false; }
};

// Same events RealtimeChatContext.setActiveChat emits when a chat is read.
// Returns true when they were emitted (socket authenticated).
const emitReadEvents = async (chatId, myUserId) => {
  if (!isSocketUp()) return false;
  try {
    const { emitSocketEvent } = require('../Redux/Services/Socket/socket');
    const ChatDatabase = require('../services/ChatDatabase').default || require('../services/ChatDatabase');
    const emit = (event, payload) => emitSocketEvent(event, payload, undefined, { queueIfOffline: false });
    const isGroupChat = !String(chatId).startsWith('u_');
    if (isGroupChat) {
      emit('group:message:read:all', { groupId: chatId });
    } else if (myUserId) {
      const dbSeq = await ChatDatabase.getLatestSeq(chatId).catch(() => 0);
      const { readAllUpToSeq } = require('../utils/receiptStatus');
      emit('message:read:all', { chatId, senderId: myUserId, upToSeq: readAllUpToSeq(dbSeq) });
    }
    const lastSeq = await ChatDatabase.getLatestSeq(chatId).catch(() => 0);
    if (lastSeq > 0) emit('message:read:upto', { chatId, readUpToSeq: lastSeq, deliveredUpToSeq: lastSeq });
    return true;
  } catch (_) { return false; }
};

// Drain the pending list (call after a catch-up pass, when the pushed message is
// in SQLite and the socket is authenticated). Idempotent on the server.
export const flushPendingNotificationReads = async () => {
  try {
    const pending = await readPending();
    if (!pending.length || !isSocketUp()) return;
    const { userId } = await loadSession();
    const left = [];
    for (const e of pending) {
      const ok = await emitReadEvents(e.chatId, userId);
      if (!ok) left.push(e);
    }
    await writePending(left);
  } catch (_) { /* best-effort */ }
};

const refreshBadge = () => {
  try { require('./appBadge').syncAppBadge(); } catch (_) { /* */ }
};

const markReadFromNotification = async (data, session) => {
  const chatId = normalizeId(data.chatId || data.groupId);
  if (!chatId) return;
  try { await require('./messageNotification').clearMessageNotification(chatId); } catch (_) { /* */ }
  try {
    const ChatDatabase = require('../services/ChatDatabase').default || require('../services/ChatDatabase');
    await ChatDatabase.updateChatUnread(chatId, 0);
  } catch (_) { /* */ }
  // Persist first, then try now; the post-catch-up flush removes it.
  const pending = (await readPending()).filter((e) => e.chatId !== chatId);
  pending.push({ chatId, at: Date.now() });
  await writePending(pending);
  if (await emitReadEvents(chatId, session.userId)) {
    // Emitted on a live socket: the pass after the next catch-up still confirms
    // it (covers a message that had not committed to SQLite yet).
  }
  refreshBadge();
};

const replyFromNotification = async (data, text, session) => {
  const tempId = `temp_${Date.now()}_${Math.random()}`;
  const built = buildReplyPayload({
    data, text, myUserId: session.userId, myName: session.name, tempId,
    nowIso: new Date().toISOString(),
  });
  if (!built) return;
  const { chatId, isGroup, payload, outboxPayload } = built;
  const ChatDatabase = require('../services/ChatDatabase').default || require('../services/ChatDatabase');

  // 1. optimistic row + chat-list preview (mirrors handleSendText).
  try {
    const moment = require('moment');
    const row = {
      id: tempId,
      tempId,
      clientMessageId: tempId,
      type: 'text',
      text: payload.text,
      time: moment(payload.createdAt).format('hh:mm A'),
      date: moment(payload.createdAt).format('YYYY-MM-DD'),
      senderId: payload.senderId,
      senderName: payload.senderName || '',
      senderType: 'self',
      receiverId: payload.receiverId,
      chatType: payload.chatType,
      status: 'sending',
      createdAt: payload.createdAt,
      timestamp: new Date(payload.createdAt).getTime(),
      payload,
      synced: false,
      chatId,
      ...(isGroup ? { groupId: payload.groupId } : {}),
    };
    await ChatDatabase.upsertMessage(row);
    await ChatDatabase.updateChatLastMessage(chatId, {
      text: isGroup ? `You: ${payload.text}` : payload.text,
      type: 'text',
      senderId: payload.senderId,
      status: 'sending',
      createdAt: payload.createdAt,
      serverMessageId: tempId,
      messageId: tempId,
      isEdited: false,
      isDeleted: false,
    });
    await ChatDatabase.updateChatUnread(chatId, 0);
  } catch (_) { /* the outbox row below is the durable record */ }

  // 2. durable outbox row (same idempotency key).
  try {
    await ChatDatabase.outboxEnqueue({ clientMessageId: tempId, chatId, payload: outboxPayload, notBefore: 0 });
  } catch (_) { return; }

  // 3. send.
  if (!isGroup) {
    try {
      const { apiCall } = require('../Config/Https');
      const response = await apiCall('POST', 'user/chat/message/send', outboxPayload);
      const failed = response && (response.success === false || response.status === false
        || response.ok === false || response.error);
      if (!failed) {
        const d = response?.data || {};
        const serverId = normalizeId(d.messageId || d._id || d.id);
        await ChatDatabase.outboxRemove(tempId);
        if (serverId) await ChatDatabase.acknowledgeMessage(tempId, serverId, d.seq ?? null).catch(() => {});
        // The server confirmed: the chat-list row leaves the clock state too.
        await ChatDatabase.updateChatLastMessageStatusById(chatId, tempId, 'sent').catch(() => {});
      }
    } catch (_) { /* stays in the outbox for the worker */ }
  } else {
    try { require('../services/OutboxWorker').default.wake(); } catch (_) { /* */ }
  }

  // A reply also reads the thread (WhatsApp behaviour) — clear the tray + unread.
  try { await require('./messageNotification').clearMessageNotification(chatId); } catch (_) { /* */ }
  refreshBadge();
};

/**
 * Entry point for notifee ACTION_PRESS on a message notification. Resolves when
 * the work is done so the headless task is kept alive for its duration.
 * `detail` = notifee event detail ({ notification, pressAction, input }).
 */
export const handleMessageNotificationAction = async (detail) => {
  try {
    const data = detail?.notification?.data || {};
    const actionId = detail?.pressAction?.id;
    if (actionId !== ACTION_REPLY && actionId !== ACTION_MARK_READ) return false;
    if (!normalizeId(data.chatId || data.groupId)) return false;

    const session = await loadSession();
    // Logged out, or the notification belongs to another account: do nothing
    // (the tray entry is dropped so it cannot be acted on again).
    if (!session.userId || !isPushForUser(data, session.userId)) {
      try { await require('./messageNotification').clearMessageNotification(normalizeId(data.chatId || data.groupId)); } catch (_) { /* */ }
      return true;
    }

    if (actionId === ACTION_REPLY) {
      await replyFromNotification(data, detail?.input, session);
    } else {
      await markReadFromNotification(data, session);
    }
    return true;
  } catch (_) { return false; }
};
