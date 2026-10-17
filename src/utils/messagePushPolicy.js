// Pure, dependency-free decisions for MESSAGE pushes (no React Native imports so
// `node --test __tests__/messagePushPolicy.test.js` can load it). CommonJS on
// purpose, like catchupChunks.js: Metro/babel interop handles the named imports.

// Ids reach the push layer as strings, numbers or wrapped documents.
const normalizeId = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    const c = value._id || value.id || value.userId || value.$oid;
    return c == null ? '' : normalizeId(c);
  }
  return '';
};

/**
 * P-A-01. Should a NEW-message push be displayed for the signed-in user?
 * Only a POSITIVE mismatch blocks it: a push without `recipientId` (old server)
 * or an unknown signed-in id (keystore/storage miss in a headless wake) fails
 * OPEN, exactly like the clear-push and tap guards.
 */
const isPushForUser = (data, signedInUserId) => {
  const recipient = normalizeId(data && data.recipientId);
  const me = normalizeId(signedInUserId);
  if (!recipient || !me) return true;
  return recipient === me;
};

// FCM data values are strings: 'false' must not read as true.
const isHideFlag = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

/**
 * P-A-03. The two sender-privacy fields every push carries, normalised for the
 * notification model so the display resolver can apply "hide-contact =>
 * @userName" instead of the saved name / number.
 */
const senderPrivacyFields = (...sources) => {
  let hide = false;
  let userName = '';
  for (const s of sources) {
    if (!s || typeof s !== 'object') continue;
    if (!hide && isHideFlag(s.senderHideContact)) hide = true;
    if (!userName && s.senderUserName) userName = String(s.senderUserName).replace(/^@/, '').trim();
  }
  return { senderHideContact: hide, senderUserName: userName || null };
};

// ── Android inline actions (P-A-10) ──────────────────────────────────────────
const ACTION_REPLY = 'msg_reply';
const ACTION_MARK_READ = 'msg_mark_read';

const buildAndroidMessageActions = () => ([
  // Inline Reply is switched OFF for this release (owner decision) — it ships in
  // a later update. Uncomment to bring it back; the handler
  // (firebase/messageNotificationActions) is still in place, so a notification
  // from an older build that still shows the box keeps working.
  // {
  //   title: 'Reply',
  //   pressAction: { id: ACTION_REPLY },
  //   input: { allowFreeFormInput: true, placeholder: 'Reply' },
  // },
  // No "Mark as read" button (removed by owner decision). ACTION_MARK_READ stays
  // exported only so a notification already in the tray from an older build is
  // still handled if its button is pressed.
]);

// Inline actions make no sense on one-way broadcast channels or system threads.
const supportsInlineActions = (data) => {
  if (!data) return false;
  const type = String(data.chatType || '');
  if (type === 'broadcast' || isHideFlag(data.isBroadcast)) return false;
  const chatId = normalizeId(data.chatId || data.groupId);
  if (!chatId || chatId.startsWith('sys_')) return false;
  return true;
};

const isGroupData = (data) => {
  if (!data) return false;
  if (isHideFlag(data.isGroup)) return true;
  if (String(data.chatType || '') === 'group') return true;
  return false;
};

/**
 * Outgoing payload for a notification Reply. Mirrors useChatLogic.handleSendText
 * (same keys, same idempotency key) so the normal send path / OutboxWorker / the
 * server's (chatId, clientMessageId) dedupe treat it as any other text message.
 * Returns null when it cannot be addressed (no text, no chat, 1:1 without peer).
 */
const buildReplyPayload = ({ data, text, myUserId, myName, tempId, nowIso }) => {
  const body = String(text == null ? '' : text).trim();
  if (!body || !data) return null;
  const chatId = normalizeId(data.chatId || data.groupId);
  if (!chatId) return null;
  const group = isGroupData(data);
  const peerId = normalizeId(data.senderId);
  if (!group && !peerId) return null;
  if (!tempId) return null;
  const createdAt = nowIso || new Date().toISOString();
  const groupId = group ? normalizeId(data.groupId || chatId) : '';
  const payload = {
    receiverId: group ? null : peerId,
    messageType: 'text',
    chatType: group ? 'group' : 'private',
    text: body,
    mediaUrl: '',
    mediaMeta: {},
    forwardedFrom: null,
    chatId,
    senderId: normalizeId(myUserId) || null,
    senderName: myName || '',
    tempId,
    createdAt,
    ...(group ? { groupId } : {}),
  };
  const outboxPayload = group
    ? { ...payload, clientMessageId: tempId, clientId: tempId, tempId }
    : { ...payload, clientMessageId: tempId };
  return { chatId, isGroup: group, payload, outboxPayload };
};

// App-icon badge value: one clamped, non-negative integer.
const badgeValue = (total) => {
  const n = Math.floor(Number(total));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 99999);
};

module.exports = {
  normalizeId,
  isPushForUser,
  isHideFlag,
  senderPrivacyFields,
  ACTION_REPLY,
  ACTION_MARK_READ,
  buildAndroidMessageActions,
  supportsInlineActions,
  isGroupData,
  buildReplyPayload,
  badgeValue,
};
