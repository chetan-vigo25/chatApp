import { useCallback, useRef, useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import { getSocket, isSocketConnected, reconnectSocket } from '../Redux/Services/Socket/socket';

/**
 * "I tapped a person — put me in their chat."
 *
 * One flow, three screens: the contact picker, the chat-list search, and
 * anywhere else a user row can be tapped. It was written inside AddUser and
 * lifted here when chat-list search grew the same button, because the parts
 * that are easy to get wrong are exactly the parts you do NOT want two copies
 * of: the duplicate-chat guard, the double-tap guard, and the fallbacks for a
 * socket that is not there.
 *
 * The order is deliberate:
 *
 *   1. ALREADY HAVE A CHAT → just open it. The peer is merged with the local
 *      contact's name/photo, so the header reads the way the phonebook does
 *      rather than showing the name the person signed up with.
 *
 *   2. REGISTERED, NO CHAT YET → create it on the backend FIRST, then navigate
 *      with the chat the server returned. Navigating with only a user opens the
 *      screen with chatId=null, and the backend then mints a SECOND chat doc
 *      when the first message is sent — the "duplicate chat" bug.
 *
 *   3. Anything else is handed back to the caller (`'unregistered'`), which is
 *      the contact picker's cue to run its invite/discover flow. Chat-list
 *      search never hits this: its rows are registered users by construction.
 *
 * Every failure path still opens the chat — with the degraded `{ user }` param —
 * because a tap that appears to do nothing is worse than a chat that has to
 * mint its id a moment later.
 */

/** A create request should never leave the row spinning; the chat opens anyway. */
const CREATE_CHAT_TIMEOUT_MS = 8000;
/** Re-arm the tap slightly after navigating — covers back-then-tap-again. */
const TAP_REARM_MS = 600;

const sameId = (a, b) => {
  const left = a == null ? '' : String(a);
  const right = b == null ? '' : String(b);
  return Boolean(left && right && left === right);
};

/**
 * Fold every shape a "user" arrives in — device contact, directory hit, chat
 * peer — into the one the chat screen expects. The local name wins over the
 * server's, and both spellings of each field are set because different
 * consumers read different keys.
 */
export function normalizeChatUser(contact) {
  if (!contact) return null;
  const resolvedId = contact._id || contact.userId || contact.id || null;
  const localName =
    contact.fullName || contact.name || contact.displayName || contact.username || 'Unknown';
  const image = contact.profileImage || contact.profilePicture || contact.avatar || '';
  return {
    ...contact,
    _id: resolvedId,
    id: contact.id || resolvedId,
    userId: contact.userId || resolvedId,
    name: localName,
    fullName: localName,
    profileImage: image,
    profilePicture: image,
  };
}

/**
 * Find this user's existing 1:1 chat in a list, across every shape the row
 * might carry the peer in (peerUser / otherUser / user, `_id` or `userId`).
 */
export function findExistingChatFor(chats, normalizedUser) {
  if (!normalizedUser || !Array.isArray(chats)) return null;
  const candidates = [normalizedUser._id, normalizedUser.userId, normalizedUser.id].filter(Boolean);
  if (candidates.length === 0) return null;

  return chats.find((chat) => {
    if (!chat || chat.chatType === 'group' || chat.isGroup) return false;
    if (chat.chatType === 'broadcast' || chat.isBroadcast) return false;
    const peerIds = [
      chat?.peerUser?._id,
      chat?.peerUser?.userId,
      chat?.otherUser?._id,
      chat?.otherUser?.userId,
      chat?.user?._id,
      chat?.user?.userId,
    ];
    return peerIds.some((pid) => candidates.some((c) => sameId(pid, c)));
  }) || null;
}

/**
 * @param {object} opts
 * @param {Array}  opts.chats  the chat rows to search for an existing thread
 * @returns {{ openUserChat: (contact) => Promise<string>, openingUserId: string|null }}
 *   `openUserChat` resolves with 'opened' | 'created' | 'unregistered' | 'ignored'.
 *   `openingUserId` is the user whose chat is being created right now, so a row
 *   can show a spinner instead of looking like the tap was swallowed.
 */
export default function useOpenUserChat({ chats } = {}) {
  const navigation = useNavigation();
  const [openingUserId, setOpeningUserId] = useState(null);
  // Guards against a double-tap creating two chats. A ref, not state: it has to
  // be true for the very next tap, not after a render.
  const inFlightRef = useRef(false);
  // Read at call time so a stale closure can't search yesterday's chat list.
  const chatsRef = useRef(chats);
  chatsRef.current = chats;

  const navigateToExistingChat = useCallback((existingChat, normalizedUser) => {
    const mergedPeer = {
      ...(existingChat?.peerUser || {}),
      ...(normalizedUser?.fullName
        ? { fullName: normalizedUser.fullName, name: normalizedUser.fullName }
        : {}),
      ...(normalizedUser?.profileImage
        ? { profileImage: normalizedUser.profileImage, profilePicture: normalizedUser.profileImage }
        : {}),
      _id: existingChat?.peerUser?._id || normalizedUser?._id || normalizedUser?.userId,
    };
    navigation.navigate('ChatScreen', { item: { ...existingChat, peerUser: mergedPeer } });
  }, [navigation]);

  const createChatThenNavigate = useCallback(async (normalizedUser) => {
    return new Promise(async (resolve) => {
      try {
        if (!isSocketConnected()) {
          await reconnectSocket(navigation);
          await new Promise((r) => setTimeout(r, 500));
        }
        const socket = getSocket();
        if (!socket) {
          navigation.navigate('ChatScreen', { user: normalizedUser });
          return resolve('created');
        }

        let settled = false;
        const cleanup = () => {
          socket.off('chat:create:response', onResponse);
          clearTimeout(timer);
        };
        const onResponse = (response) => {
          if (settled) return;
          settled = true;
          cleanup();
          const chatPayload = response?.data;
          if (response?.status && chatPayload) {
            // The server's peerUser carries the sign-up name; the local contact
            // carries what this user actually calls them. Local wins.
            const serverPeer = chatPayload.peerUser || {};
            const mergedPeer = {
              ...serverPeer,
              fullName: normalizedUser?.fullName || serverPeer.fullName || 'Unknown',
              name: normalizedUser?.fullName || serverPeer.fullName || 'Unknown',
              profileImage: normalizedUser?.profileImage || serverPeer.profileImage || serverPeer.profilePicture || '',
              profilePicture: normalizedUser?.profileImage || serverPeer.profileImage || serverPeer.profilePicture || '',
              _id: serverPeer._id || normalizedUser?._id || normalizedUser?.userId,
            };
            navigation.navigate('ChatScreen', { item: { ...chatPayload, peerUser: mergedPeer } });
          } else {
            navigation.navigate('ChatScreen', { user: normalizedUser });
          }
          resolve('created');
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          navigation.navigate('ChatScreen', { user: normalizedUser });
          resolve('created');
        }, CREATE_CHAT_TIMEOUT_MS);

        socket.on('chat:create:response', onResponse);
        socket.emit('chat:create', { userId: normalizedUser._id || normalizedUser.userId });
      } catch (err) {
        console.warn('[openUserChat] create failed:', err?.message);
        navigation.navigate('ChatScreen', { user: normalizedUser });
        resolve('created');
      }
    });
  }, [navigation]);

  const openUserChat = useCallback(async (contact) => {
    if (!contact) return 'ignored';
    if (inFlightRef.current) return 'ignored';
    inFlightRef.current = true;

    const normalizedUser = normalizeChatUser(contact);
    let navigated = false;
    try {
      const existingChat = findExistingChatFor(chatsRef.current, normalizedUser);
      if (existingChat) {
        navigateToExistingChat(existingChat, normalizedUser);
        navigated = true;
        return 'opened';
      }

      const isRegistered = normalizedUser?.type === 'registered' || Boolean(normalizedUser?.userId);
      if (isRegistered && (normalizedUser?._id || normalizedUser?.userId)) {
        setOpeningUserId(String(normalizedUser._id || normalizedUser.userId));
        await createChatThenNavigate(normalizedUser);
        navigated = true;
        return 'created';
      }

      // Not on the app (a phonebook number and nothing else) — the caller owns
      // what happens next (invite / discover).
      return 'unregistered';
    } finally {
      setOpeningUserId(null);
      if (navigated) {
        // Late re-arm, so a back-then-tap-again on the row we just opened can't
        // fire a second create before the first one is visible.
        setTimeout(() => { inFlightRef.current = false; }, TAP_REARM_MS);
      } else {
        // Nothing was opened. The contact picker answers an 'unregistered' by
        // discovering the number and calling straight back in — a delayed
        // re-arm would swallow that second call and the tap would do nothing.
        inFlightRef.current = false;
      }
    }
  }, [navigateToExistingChat, createChatThenNavigate]);

  return { openUserChat, openingUserId };
}
