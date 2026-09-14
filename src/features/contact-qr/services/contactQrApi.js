import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiCall } from '../../../Config/Https';
import { getSocket, isSocketConnected } from '../../../Redux/Services/Socket/socket';

/**
 * Contact QR endpoints — contract in docs/CONTACT_QR_SERVER_SPEC.md.
 *
 * Every call is `silent`: the screens own their error states, and a shared
 * toast on top of them would say the same thing twice.
 */

const tokenCacheKey = (userId) => `contactQr:token:${userId || 'me'}`;

// Screens branch on `code`, never on the server's prose, and always show their
// own copy — the server message is not user-facing text.
const toError = (errOrResponse, message) => {
  const status = errOrResponse?.statusCode || errOrResponse?.status || errOrResponse?.response?.status;
  let code = errOrResponse?.data?.code || errOrResponse?.code || 'UNKNOWN';
  if (status === 429) code = 'RATE_LIMITED';
  return { code, message };
};

/** Last token this device saw for `userId` — lets My QR paint before the network. */
export async function getCachedContactQrToken(userId) {
  try {
    return (await AsyncStorage.getItem(tokenCacheKey(userId))) || null;
  } catch {
    return null;
  }
}

async function cacheToken(userId, token) {
  try {
    if (token) await AsyncStorage.setItem(tokenCacheKey(userId), token);
    else await AsyncStorage.removeItem(tokenCacheKey(userId));
  } catch { /* cache only */ }
}

async function requestToken(endpoint, userId) {
  try {
    const res = await apiCall('POST', endpoint, {}, { silent: true });
    const token = res?.data?.token;
    if (res?.statusCode === 200 && token) {
      await cacheToken(userId, token);
      return token;
    }
    return Promise.reject(toError(res, "QR code isn't available right now."));
  } catch (err) {
    return Promise.reject(toError(err, "QR code isn't available right now."));
  }
}

/** The caller's QR token (created server-side on first call). */
export const fetchMyContactQrToken = (userId) => requestToken('user/qr/token', userId);

/** Revoke the current code and get a new one. */
export async function resetMyContactQrToken(userId) {
  await cacheToken(userId, null);
  return requestToken('user/qr/reset', userId);
}

const normalizeCard = (d = {}) => {
  const number = d?.mobile?.number ? String(d.mobile.number) : '';
  const mobile = number ? { code: String(d.mobile.code || ''), number } : null;
  const isSelf = Boolean(d.isSelf);
  const isBlocked = Boolean(d.isBlocked);
  // The server owns the button rule (canChat / canSave). The derivation below
  // is only a fallback for a response that predates those flags.
  const canChat = typeof d.canChat === 'boolean' ? d.canChat : (!isSelf && !isBlocked);
  const canSave = typeof d.canSave === 'boolean' ? d.canSave : (canChat && Boolean(mobile));
  return {
    userId: String(d.userId || d._id || ''),
    // Already the @handle when the owner hides their contact — never re-derive.
    fullName: d.fullName || d.name || '',
    userName: d.userName || d.username || '',
    profileImage: d.profileImage || d.profilePicture || d.avatar || '',
    isVerified: Boolean(d.isVerified),
    hideContact: Boolean(d.hideContact),
    mobile,
    isSelf,
    isBlocked,
    chatId: d.chatId ? String(d.chatId) : null,
    canChat,
    // A phone contact can't be saved without a number, whatever a flag says.
    canSave: canSave && Boolean(mobile),
  };
};

/** Resolve a scanned token to the owner's limited public card. */
export async function resolveContactQrToken(token) {
  try {
    const res = await apiCall('POST', 'user/qr/resolve', { token }, { silent: true });
    if (res?.statusCode === 200 && res?.data) {
      const card = normalizeCard(res.data);
      if (card.userId) return card;
    }
    return Promise.reject(toError(res, "Couldn't read this QR code."));
  } catch (err) {
    return Promise.reject(toError(err, "Couldn't read this QR code."));
  }
}

/**
 * Create the 1:1 connection after "Save contact", without opening the chat —
 * the scanner stays put. Fire-and-forget over the existing `chat:create` event
 * (find-or-create server-side); the chat list picks the thread up from the
 * reload useSaveContact runs after a save. The "Chat" button does NOT use this:
 * it goes through useOpenUserChat, which waits for the ack before navigating.
 */
export function connectWithUser(userId) {
  if (!userId) return false;
  try {
    const socket = getSocket();
    if (!socket || !isSocketConnected()) return false;
    socket.emit('chat:create', { userId: String(userId) });
    return true;
  } catch {
    return false;
  }
}
