import { getCurrentUserId, normalizeUserId } from '../services/currentUser';

/**
 * THE single rule for which side of the thread a chat item renders on.
 *
 * Every conversation item — text, media, album, view-once, call log, system
 * notice, status reply — answers "mine or theirs?" through this module, so a
 * new item type cannot quietly invent a fourth rule and land on the wrong side.
 *
 * The rule is deliberately IDENTITY-FIRST, not state-first:
 *
 *   1. senderId vs the authenticated user id — authoritative whenever both are
 *      known. This is the WhatsApp rule, and it is a pure function of the row,
 *      so it gives the same answer on first paint, on reopen, and after a
 *      reinstall, no matter what order the id and the message arrived in.
 *   2. receiverId vs the authenticated user id — for rows that carry only the
 *      other half of the pair (some call/system rows).
 *   3. the stored `senderType` — a LAST resort, for rows whose participant ids
 *      never made it to disk.
 *
 * The ordering is the fix for a specific class of bug: `senderType` is decided
 * at WRITE time against whatever the user id happened to be at that instant. A
 * row ingested before the id resolved was stamped 'other' and — because the
 * column is written with COALESCE — stayed 'other' forever, pinning an outgoing
 * message to the received side across every subsequent reopen. Checking the ids
 * first makes those rows self-heal on render rather than needing a migration.
 */

export const normalizeId = normalizeUserId;

export const sameId = (a, b) => {
  const left = normalizeId(a);
  const right = normalizeId(b);
  return Boolean(left && right && left === right);
};

/**
 * Pull the author id off a chat item, whatever the transport called it.
 * Socket frames, REST documents and SQLite rows each spell it differently, and
 * a populated `sender` object has to normalize down to its id.
 */
export const getSenderId = (msg) => normalizeId(
  msg?.senderId ?? msg?.sender_id ?? msg?.sender ?? msg?.fromId ?? msg?.from ?? null,
);

export const getReceiverId = (msg) => normalizeId(
  msg?.receiverId ?? msg?.receiver_id ?? msg?.receiver ?? msg?.toId ?? msg?.to ?? null,
);

/**
 * True when the viewer authored this item (render it on the sender/right side).
 *
 * @param msg     the chat item
 * @param viewerId the authenticated user id; omitted/null falls back to the
 *                 module-level store, so callers without the id in scope still
 *                 get the right answer.
 */
export const isOutgoingMessage = (msg, viewerId) => {
  if (!msg) return false;

  const me = normalizeId(viewerId) || getCurrentUserId();

  if (me) {
    const senderId = getSenderId(msg);
    if (senderId) return senderId === me;

    // No author id on the row: a private-chat item addressed to someone else
    // must have come from us. Group rows are excluded — "not addressed to me"
    // says nothing about authorship when there are many recipients.
    const receiverId = getReceiverId(msg);
    const isGroupItem = Boolean(msg?.groupId || msg?.group_id || msg?.isGroup);
    if (receiverId && !isGroupItem) return receiverId !== me;
  }

  // Ids unusable (viewer unknown, or a row that stored neither participant):
  // fall back to whatever the write path decided.
  if (msg?.senderType) return msg.senderType === 'self';
  return false;
};

/**
 * True when the identity check above can actually run — i.e. we know who the
 * viewer is AND the row carries a participant id to compare against. Callers
 * with their own legacy fallback (a stored, viewer-relative direction) use this
 * to decide whether the ids get to win.
 */
export const hasResolvableIdentity = (msg, viewerId) => {
  const me = normalizeId(viewerId) || getCurrentUserId();
  if (!me) return false;
  if (getSenderId(msg)) return true;
  const isGroupItem = Boolean(msg?.groupId || msg?.group_id || msg?.isGroup);
  return Boolean(getReceiverId(msg)) && !isGroupItem;
};

/** 'outgoing' | 'incoming' — the same rule, for call-style APIs that want a word. */
export const resolveDirection = (msg, viewerId) => (
  isOutgoingMessage(msg, viewerId) ? 'outgoing' : 'incoming'
);

/**
 * The value to PERSIST in `sender_type`.
 *
 * Returns null — never 'other' — when the answer cannot be known yet, because
 * null is the only value that `COALESCE($sender_type, sender_type)` treats as
 * "don't write anything", and it is the only value `isOutgoingMessage` will
 * step past to re-derive from ids. Guessing 'other' here is exactly how rows
 * got pinned to the wrong side.
 */
export const computeSenderType = (senderId, viewerId) => {
  const me = normalizeId(viewerId) || getCurrentUserId();
  const sender = normalizeId(senderId);
  if (!me || !sender) return null;
  return sender === me ? 'self' : 'other';
};

export default {
  normalizeId,
  sameId,
  getSenderId,
  getReceiverId,
  isOutgoingMessage,
  hasResolvableIdentity,
  resolveDirection,
  computeSenderType,
};
