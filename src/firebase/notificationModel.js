/**
 * notificationModel — the SINGLE source of truth for message-notification CONTENT.
 *
 * Both notification surfaces import from here so the SAME message looks identical
 * no matter which path renders it:
 *   • the foreground in-app banner            (components/AppBannerHost.jsx)
 *   • the OS notification (background/killed)  (firebase/fcmService.js →
 *     firebase/messageNotification.js Notifee MessagingStyle / iOS comms)
 *
 * Before this module the media-preview text was duplicated in four places and
 * disagreed (banner showed "Photo", the push body showed "📷 Photo"), so the two
 * paths rendered different text for the same message. Centralising it here is the
 * convergence the notification rework requires.
 *
 * Pure JS — NO native modules, NO react-native imports beyond Platform-free
 * helpers — so it is safe to import from the headless FCM background handler.
 */

// Media preview labels. MUST stay byte-for-byte identical to the backend's
// MEDIA_PREVIEW in chat-backend/src/services/messageNotify.service.js so a
// message previews the same whether it arrives over the socket (banner) or as a
// push the backend already formatted.
export const MEDIA_PREVIEW = {
  image: '📷 Photo',
  video: '📹 Video',
  audio: '🎵 Audio',
  voice: '🎤 Voice message',
  document: '📄 Document',
  file: '📄 Document',
  contact: '👤 Contact',
  location: '📍 Location',
  sticker: 'Sticker',
};

export const previewFor = (messageType, text) => {
  if (!messageType || messageType === 'text') return text || '';
  return MEDIA_PREVIEW[messageType] || text || 'New message';
};

export const normalizeId = (value) => {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    const candidate = value?._id || value?.id || value?.userId || value?.$oid || null;
    return candidate == null ? null : String(candidate);
  }
  return null;
};

export const isTruthyString = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

/**
 * Canonical message-notification model.
 *
 * Accepts EITHER:
 *   • an FCM remoteMessage  → { notification, data }
 *   • a raw socket payload  → the message (possibly nested under message/data,
 *     with chatId aliased as roomId/chat)
 *
 * and returns one normalized shape both render surfaces read from:
 *   {
 *     messageId, chatId, threadId, senderId, senderName, senderMobile,
 *     avatar, isGroup, groupId, groupName, messageType, title, body, timestamp,
 *     chatType, type
 *   }
 *
 * `title`/`body` follow the WhatsApp convention the backend push already uses:
 *   • 1-1   → title = sender name,           body = preview
 *   • group → title = group name,            body = "Sender: preview"
 * so the banner and the OS notification agree.
 *
 * Returns null when the payload carries no chat to attribute the notification to
 * (routing-only / contentless) — callers must skip rendering in that case.
 */
export const buildNotificationModel = (raw = {}) => {
  // Unwrap an FCM remoteMessage; fall back to treating `raw` as the payload.
  const notification = raw?.notification || raw?.notificationData?.notification || null;
  const source = raw?.data || raw?.notificationData?.data || raw;
  const data = source?.message || source?.data || source;

  const chatId = normalizeId(
    data?.chatId || data?.roomId || data?.chat ||
    source?.chatId || source?.roomId || source?.chat
  );
  const groupId = normalizeId(data?.groupId || source?.groupId);

  // Group when the payload explicitly targets a group (chatType 'group' AND a
  // group/chat id) or carries an isGroup flag. Mirrors the existing banner rule
  // so a 1-1 message that merely references a groupId is NOT treated as a group.
  const explicitGroup =
    (data?.chatType === 'group' || source?.chatType === 'group') && !!(groupId || chatId);
  const isGroup = explicitGroup || isTruthyString(data?.isGroup || source?.isGroup);

  if (!chatId && !groupId) return null;

  const senderId = normalizeId(
    data?.senderId || data?.sender?._id || data?.sender?.id ||
    source?.senderId || source?.from
  );

  // Left un-defaulted (may be '') so callers can detect a contentless,
  // routing-only payload and suppress it. Each render site applies its own
  // 'New message' display fallback.
  const senderName =
    data?.senderName || data?.sender?.fullName || data?.sender?.name ||
    data?.sender?.username || data?.senderFullName || data?.fullName ||
    data?.name || source?.senderName ||
    notification?.title || '';

  const senderMobile =
    data?.senderMobile || data?.mobileNumber || source?.senderMobile || null;

  const avatar =
    data?.sender?.profileImage || data?.sender?.profileImageUrl ||
    data?.profileImage || data?.senderImage || source?.profileImage || null;

  const groupName =
    data?.groupName || source?.groupName || data?.chatName || source?.chatName ||
    (isGroup ? notification?.title : '') || '';
  const groupAvatar =
    data?.groupAvatar || source?.groupAvatar || data?.chatAvatar || source?.chatAvatar || null;

  // Broadcast channel push: a one-way admin announcement. Title = channel name,
  // avatar = channel logo, body = message — no "Sender:" prefix.
  const isBroadcast =
    (data?.kind === 'broadcast' || source?.kind === 'broadcast') ||
    isTruthyString(data?.isBroadcast || source?.isBroadcast) ||
    (data?.chatType === 'broadcast' || source?.chatType === 'broadcast');
  const channelName = data?.chatName || source?.chatName || notification?.title || '';
  const channelAvatar = data?.chatAvatar || source?.chatAvatar || null;

  const messageType = data?.messageType || data?.type || source?.messageType || 'text';
  const rawText =
    data?.text || data?.body || data?.message || data?.content ||
    data?.messageText || source?.text || '';
  const body = previewFor(messageType, rawText);

  // 1-1: title is the sender. Group: title is the group, body carries the sender
  // prefix (mirrors the backend push + the existing group banner).
  const title = isBroadcast ? (channelName || senderName) : isGroup ? (groupName || senderName) : senderName;
  const displayBody = isGroup && senderName && senderName !== 'New message'
    ? `${senderName}: ${body}`
    : body;

  return {
    messageId: normalizeId(data?.messageId || data?._id || data?.id || source?.messageId),
    chatId: chatId || groupId,
    // iOS thread / Android per-chat grouping key.
    threadId: chatId || groupId,
    senderId,
    senderName,
    senderMobile,
    avatar: isBroadcast ? (channelAvatar || avatar) : isGroup ? (groupAvatar || avatar) : avatar,
    isGroup,
    isBroadcast,
    chatName: channelName || undefined,
    chatAvatar: channelAvatar || undefined,
    groupId,
    groupName,
    groupAvatar,
    messageType,
    title,
    body: displayBody,
    // Bare preview without the "Sender:" prefix — the OS MessagingStyle attaches
    // the sender per line itself, so it wants the un-prefixed text.
    lineBody: body,
    timestamp: Number(
      data?.timestamp || data?.sentAt || data?.createdAt || source?.timestamp || Date.now()
    ) || Date.now(),
    chatType: isBroadcast ? 'broadcast' : isGroup ? 'group' : 'private',
    type: 'message',
  };
};
