/**
 * Self chat ("Message yourself").
 *
 * A chat with yourself is a normal 1:1 chat whose two participants are the same
 * user, so its canonical id degenerates to `u_<id>_<id>`. That makes the id
 * itself self-describing — no need to know who the logged-in user is to detect
 * one, which matters for the many half-hydrated rows (SQLite stubs, socket
 * payloads) that carry a chatId and nothing else.
 */

const SELF_CHAT_ID = /^u_([0-9a-fA-F]{24})_\1$/;

export const isSelfChatId = (chatId) => SELF_CHAT_ID.test(String(chatId || ''));

// True for any chat row/message that belongs to the self chat. Trusts the
// server's explicit flag first (REST getChatList / realtime chat:list:update),
// then falls back to the chatId shape, then to an explicit peer === me match.
export const isSelfChat = (item, currentUserId) => {
  if (!item) return false;
  if (item.isSelfChat === true) return true;
  if (isSelfChatId(item.chatId || item._id)) return true;
  const peerId = String(item?.peerUser?._id || item?.peerUserId || '');
  return Boolean(currentUserId && peerId && peerId === String(currentUserId));
};

// The label shown wherever the self chat is listed. WhatsApp marks it with
// "(You)"; we lead with the user's own number (the display rule everywhere else
// prefers the number over a self-set push name) and fall back to the name.
//
// Contact privacy applies to the OWNER's own row too: once the toggle is on,
// the handle replaces the number on every surface — so the one place the user
// sees their own row must not keep printing the number they just hid. It is the
// same ordering the resolvers use (privacy first, then number, then name), and
// the identity is the owner's own, since the self chat's peer IS the owner.
export const selfChatLabel = ({ mobileNumber, name, username, hideContact } = {}) => {
  const handle = String(username || '').trim();
  const base = (hideContact && handle && `@${handle}`)
    || String(mobileNumber || '').trim()
    || String(name || '').trim()
    || 'You';
  return `${base} (You)`;
};

/**
 * The owner's identity bits for `selfChatLabel`, pulled off the profile slice
 * (`state.profile.profileData`) — the one source that always holds the CURRENT
 * toggle. A self-chat row shipped by the server carries no `hideContact`, so
 * reading it off the row would silently keep showing the number.
 */
export const selfIdentityOf = (profileData = {}) => ({
  username: profileData?.userName || null,
  hideContact: Boolean(profileData?.privacySettings?.hideContact ?? profileData?.hideContact),
});

export const SELF_CHAT_SUBTITLE = 'Message yourself';

export default { isSelfChatId, isSelfChat, selfChatLabel, selfIdentityOf, SELF_CHAT_SUBTITLE };
