/**
 * One server message, two ids.
 *
 * Every message carries a UUID `messageId` (the canonical id the realtime /
 * sync normalizers key rows by) AND a Mongo `_id`. A writer that keyed a row by
 * `_id` instead — the post-login background warm in SyncScreen did — stored the
 * SAME message a second time next to the UUID copy written later by chat-open
 * sync / catch-up. Neither row carries the other's id, so no id-based dedupe
 * could pair them: every restored message rendered twice, and media showed once
 * with its size and once as "Unknown size" (the `_id` copy had no mediaMeta).
 *
 * The pair is provable without either id: both copies carry the server's
 * createdAt to the millisecond, so one chat + one sender + one type + one exact
 * timestamp is one message. Only a pair where exactly ONE side is an
 * ObjectId-shaped id is collapsed — two canonical ids are never assumed equal.
 *
 * Self-contained on purpose: imported by ChatDatabase, so it must not pull in
 * modules that import the database back.
 */

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

export const isMongoObjectId = (id) => OBJECT_ID_RE.test(String(id ?? ''));

/** SQL twin of isMongoObjectId for a column expression. */
export const sqlIsObjectId = (col) => `(length(${col}) = 24 AND ${col} NOT GLOB '*[^0-9a-fA-F]*')`;

const plainId = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') return String(v._id ?? v.id ?? '');
  return String(v);
};

const rowIdOf = (m) => plainId(m?.serverMessageId || m?.id);

// sender|type|timestamp — callers pass ONE chat's list, so the chat is implied
// (the two copies may even spell the chat id differently).
const twinKeyOf = (m) => {
  const ts = Number(m?.timestamp || 0);
  const sender = plainId(m?.senderId);
  const id = rowIdOf(m);
  if (!(ts > 0) || !sender || !id || id.startsWith('temp_')) return null;
  return `${sender}|${String(m.type || 'text').toLowerCase()}|${ts}`;
};

/**
 * Drop the ObjectId-keyed copy of any message that is also present under its
 * canonical id. Returns the input array untouched when nothing was dropped.
 */
export const dropAlternateIdTwins = (messages) => {
  if (!Array.isArray(messages) || messages.length < 2) return messages;
  const canonical = new Set();
  for (const m of messages) {
    const key = twinKeyOf(m);
    if (key && !isMongoObjectId(rowIdOf(m))) canonical.add(key);
  }
  if (canonical.size === 0) return messages;
  const out = messages.filter((m) => {
    const key = twinKeyOf(m);
    return !(key && isMongoObjectId(rowIdOf(m)) && canonical.has(key));
  });
  return out.length === messages.length ? messages : out;
};
