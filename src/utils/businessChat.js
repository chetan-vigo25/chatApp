// Business chats — a private chat whose peer is a Business-API sender profile
// (a real user row nobody signs in as). Such a chat is a read-only inbox of
// updates: no calls, no composer, no reply/react/forward/edit, and messages are
// drawn like the business's template. See docs/BUSINESS_CHAT_README.md.
//
// The ONLY source of truth is the server's `isBusinessSender` flag on the chat
// row (or its peerUser). Always derive from the row — never store a second flag.
// (Servers that don't send the flag yet are covered by utils/businessPeerProbe.)
//
// CommonJS on purpose, so `node --test __tests__/` can load it without Babel.

const BUSINESS_SUBTITLE = 'Business account';
const BUSINESS_COMPOSER_NOTICE = "This is a business account. It sends you updates here — you can't reply.";

const readFlag = (chat) => {
  if (!chat || typeof chat !== 'object') return undefined;
  if (typeof chat.isBusinessSender === 'boolean') return chat.isBusinessSender;
  const peer = chat.peerUser || chat.otherUser;
  if (peer && typeof peer.isBusinessSender === 'boolean') return peer.isBusinessSender;
  return undefined;
};

const isGroupLike = (chat) => Boolean(chat && (chat.chatType === 'group' || chat.isGroup
  || chat.chatType === 'broadcast' || chat.chatType === 'channel' || chat.isBroadcast));

const isBusinessChat = (chat) => {
  if (!chat || isGroupLike(chat)) return false;
  return readFlag(chat) === true;
};

// Sticky merge for chat-list reducers: a lean realtime update carries no peer
// identity (so no flag) and must never clear a `true` we already have. An
// explicit boolean from the server wins; otherwise keep the previous value.
// Returns undefined when neither side knows.
const mergeBusinessFlag = (incoming, prev) => {
  const next = readFlag(incoming);
  if (next !== undefined) return next;
  return readFlag(prev);
};

const peerIdOf = (c) => {
  const pid = c && ((c.peerUser && (c.peerUser._id || c.peerUser.userId || c.peerUser.id)) || c.peerUserId);
  return pid != null ? String(pid) : null;
};

// Every business-sender peer id found in any of the given chat lists (arrays or
// id-keyed maps). Pickers merge several sources and a merge can drop the flag,
// so they test against this set instead of the merged row alone.
const businessPeerIdSet = (...lists) => {
  const out = new Set();
  lists.forEach((list) => {
    const rows = Array.isArray(list) ? list : Object.values(list || {});
    rows.forEach((c) => {
      if (!isBusinessChat(c)) return;
      const pid = peerIdOf(c);
      if (pid) out.add(pid);
    });
  });
  // Peers the profile probe identified (servers without the flag).
  knownProbedPeers.forEach((pid) => out.add(pid));
  return out;
};

// Is this chat row (or its peer) a business sender? `peerSet` from businessPeerIdSet.
const isBusinessRow = (chat, peerSet) => {
  if (isBusinessChat(chat)) return true;
  if (!peerSet || !peerSet.size || isGroupLike(chat)) return false;
  const pid = peerIdOf(chat);
  return Boolean(pid && peerSet.has(pid));
};

// Is this user id a business sender, judged from the chat list? Lets screens
// that only hold a peer id (contact info, call log) gate themselves.
const isBusinessPeerInChats = (chats, peerId) => {
  if (!peerId) return false;
  return businessPeerIdSet(chats).has(String(peerId));
};

// Module-level registry of business-sender peer ids, fed by RealtimeChatContext
// from the chat list (and by the profile probe). Lets non-React code
// (CallProvider.startCall) refuse to ring a business without subscribing to the
// whole chat list.
let knownBusinessPeers = new Set();
const knownProbedPeers = new Set();
const setKnownBusinessPeers = (set) => { knownBusinessPeers = set instanceof Set ? set : new Set(); };
const addProbedBusinessPeer = (peerId) => { if (peerId != null) knownProbedPeers.add(String(peerId)); };
const isKnownBusinessPeer = (peerId) => (peerId != null
  && (knownBusinessPeers.has(String(peerId)) || knownProbedPeers.has(String(peerId))));

// Does a `user/auth/view` profile describe a business sender? Used only when
// the chat row carries no flag (an older backend): the new server sends a
// `business` object / `isSenderProfile`; an older one at least marks the
// account as an organization with no phone number.
const looksLikeBusinessSender = (profile) => {
  if (!profile || typeof profile !== 'object') return false;
  if (profile.isBusinessSender === true || profile.isSenderProfile === true) return true;
  if (profile.business && typeof profile.business === 'object') return true;
  const hasPhone = Boolean(profile.mobile && profile.mobile.number) || Boolean(profile.mobileNumber);
  return String(profile.userType || '').toLowerCase() === 'organization' && !hasPhone;
};

module.exports = {
  looksLikeBusinessSender,
  BUSINESS_SUBTITLE,
  BUSINESS_COMPOSER_NOTICE,
  isBusinessChat,
  mergeBusinessFlag,
  businessPeerIdSet,
  isBusinessRow,
  isBusinessPeerInChats,
  setKnownBusinessPeers,
  addProbedBusinessPeer,
  isKnownBusinessPeer,
};
