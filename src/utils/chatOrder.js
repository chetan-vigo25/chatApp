/**
 * ONE definition of chat-list order, for every surface that renders it.
 *
 * The list is assembled in three different places — the realtime reducer
 * (`buildOrderedSections`), the in-memory ChatCache, and ChatList's own render
 * path when it falls back to the raw REST payload. Each used to carry its own
 * comparator, so the same chats could legitimately come out in three different
 * orders depending on which one painted first: the cache ignored
 * `lastMessage.createdAt`, and the REST fallback was not sorted at all (server
 * order, straight to the FlatList). That is what made rows show up in the wrong
 * positions right after a login, and settle only once a later socket event
 * forced a re-sort.
 *
 * Everything now imports from here. Change the rule ONCE and every surface
 * follows.
 */

const toTimestamp = (value) => {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
};

/**
 * The sort key: the most recent of EVERY activity field.
 *
 * Taking the max (not the first truthy field) is deliberate — an incoming
 * `message:new` advances `lastMessageAt` but not `timestamp`, so a first-field
 * read left the row stuck at a stale position until some other event happened
 * to refresh that one field.
 *
 * `updatedAt` is deliberately NOT part of the max: it is a server-doc touch
 * time (mute / read / archive all bump it), so folding it in would float a
 * stale chat above rows with genuinely newer messages. It only breaks the tie
 * for rows with no message activity at all (a brand-new, empty chat).
 */
export const getChatActivityValue = (chat = {}) => {
  const messageActivity = Math.max(
    toTimestamp(chat?.timestamp),
    toTimestamp(chat?.lastMessageAt),
    toTimestamp(chat?.lastMessage?.createdAt),
  );
  return messageActivity || toTimestamp(chat?.updatedAt);
};

/**
 * Compare two chats: newest activity first, with a deterministic tie-break.
 *
 * The tie-break is not optional. Two messages can land in the same
 * millisecond, and Array.sort stability is not guaranteed on Hermes — without
 * it, equal rows flip places on every re-sort.
 */
export const compareChatsByActivity = (a = {}, b = {}) => {
  const tsA = getChatActivityValue(a);
  const tsB = getChatActivityValue(b);
  if (tsB !== tsA) return tsB - tsA;
  const idA = String(a?.chatId || a?._id || '');
  const idB = String(b?.chatId || b?._id || '');
  return idA.localeCompare(idB);
};

/**
 * Full display order for a flat list of chat objects: pinned block first, each
 * block newest-first. Archived rows are left where they are — callers that show
 * an archive section filter before calling this.
 */
export const orderChatsForDisplay = (chats = []) => {
  if (!Array.isArray(chats) || chats.length < 2) return Array.isArray(chats) ? chats : [];
  const pinned = [];
  const regular = [];
  chats.forEach((chat) => {
    (chat?.isPinned ? pinned : regular).push(chat);
  });
  return [
    ...pinned.sort(compareChatsByActivity),
    ...regular.sort(compareChatsByActivity),
  ];
};

export default { getChatActivityValue, compareChatsByActivity, orderChatsForDisplay };
