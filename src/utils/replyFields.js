/**
 * Reply/quote fields from any server message shape.
 *
 * The server sends a reply as (2026-09-25, live `message:new` capture):
 *   replyToMessageId: <UUID>              — the id every local row is keyed by
 *   replyTo:          <Mongo _id string>  — NOT a local row id
 *   replyPreview:     { messageId: <UUID>, text, messageType, senderId,
 *                       senderName, mediaUrl, mediaThumbnailUrl }
 * Some shapes (sync docs, echoes) omit replyToMessageId. Falling back straight
 * to `replyTo` stored the Mongo _id, which matches no local row — the quote
 * then lost its image ("reply bubble shows text but no image"). And nothing
 * read replyPreview, so the thumbnail never reached the receiver.
 *
 * Order: explicit fields → replyPreview (schema snapshot) → a populated replyTo
 * object → a bare replyTo string (Mongo id; last resort only).
 */
const str = (v) => (v == null || v === '' ? null : String(v));

export const extractReplyFields = (src = {}) => {
  const s = src || {};
  const preview = s.replyPreview && typeof s.replyPreview === 'object' ? s.replyPreview : null;
  const replyObj = s.replyTo && typeof s.replyTo === 'object' ? s.replyTo : null;
  const replyStr = typeof s.replyTo === 'string' ? s.replyTo : null;

  const replyToMessageId = str(
    s.replyToMessageId || s.quotedMessageId || s.reply_to_message_id
    || preview?.messageId
    || replyObj?.messageId || replyObj?._id || replyObj?.id
    || replyStr,
  );
  if (!replyToMessageId) {
    return {
      replyToMessageId: null, replyPreviewText: null, replyPreviewType: null,
      replySenderName: null, replySenderId: null, replyPreviewThumbnail: null,
    };
  }
  return {
    replyToMessageId,
    replyPreviewText: str(s.replyPreviewText || s.quotedText || s.reply_preview_text
      || preview?.text || replyObj?.text || replyObj?.content),
    replyPreviewType: str(s.replyPreviewType || s.reply_preview_type
      || preview?.messageType || replyObj?.messageType || replyObj?.type),
    replySenderName: str(s.replySenderName || s.quotedSender || s.reply_sender_name
      || preview?.senderName || replyObj?.senderName || replyObj?.sender?.fullName || replyObj?.sender?.name),
    replySenderId: str(s.replySenderId || s.reply_sender_id
      || preview?.senderId || replyObj?.senderId || replyObj?.sender?._id
      || (typeof replyObj?.sender === 'string' ? replyObj.sender : null)),
    replyPreviewThumbnail: str(s.replyPreviewThumbnail
      || preview?.mediaThumbnailUrl || replyObj?.mediaThumbnailUrl),
  };
};

export default extractReplyFields;
