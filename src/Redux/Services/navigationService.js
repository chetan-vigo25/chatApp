import { createNavigationContainerRef } from '@react-navigation/native';

export const navigationRef = createNavigationContainerRef();

let currentRouteSnapshot = null;
const navigationStateListeners = new Set();

const normalizeId = (value) => {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    const candidate = value?._id || value?.id || value?.userId || value?.$oid || null;
    return candidate == null ? null : String(candidate);
  }
  return null;
};

export function getCurrentRouteSnapshot() {
  return currentRouteSnapshot;
}

export function getActiveChatFromRoute(route = null) {
  const activeRoute = route || currentRouteSnapshot;
  if (!activeRoute || activeRoute.name !== 'ChatScreen') {
    return { chatId: null, peerUserId: null, routeName: activeRoute?.name || null };
  }

  const params = activeRoute.params || {};
  const item = params.item || {};
  const user = params.user || {};

  const chatId = normalizeId(
    params.chatId ||
    item.chatId ||
    item._id ||
    null
  );

  const peerUserId = normalizeId(
    item?.peerUser?._id ||
    item?.peerUser?.userId ||
    item?.peerUser?.id ||
    user?._id ||
    user?.userId ||
    user?.id ||
    null
  );

  return {
    chatId,
    peerUserId,
    routeName: activeRoute.name,
  };
}

export function updateNavigationSnapshot() {
  if (!navigationRef.isReady()) return null;
  currentRouteSnapshot = navigationRef.getCurrentRoute() || null;
  navigationStateListeners.forEach((listener) => {
    try {
      listener(currentRouteSnapshot);
    } catch (error) {
      console.warn('navigation listener error', error);
    }
  });
  return currentRouteSnapshot;
}

export function subscribeNavigationSnapshot(listener) {
  if (typeof listener !== 'function') return () => {};
  navigationStateListeners.add(listener);
  return () => {
    navigationStateListeners.delete(listener);
  };
}

// Navigate to a chat from a tapped push notification. The push `data` carries
// { chatId, chatType, groupId, senderId, senderName, profileImage, senderMobile,
// groupName }. On a COLD launch the nav container isn't mounted yet, so retry
// until it's ready (best-effort, ~8s) instead of dropping the intent.
export function navigateToChat(data = {}, attempt = 0) {
  const chatId = normalizeId(data?.chatId || data?.groupId);
  if (!chatId) return false;

  if (!navigationRef.isReady()) {
    if (attempt < 40) setTimeout(() => navigateToChat(data, attempt + 1), 200);
    return false;
  }

  const isBroadcast = data?.chatType === 'broadcast' || !!data?.isBroadcast || data?.kind === 'broadcast';
  const isGroup = data?.chatType === 'group' || !!data?.groupId;
  const item = isBroadcast
    ? {
        chatId,
        chatType: 'broadcast',
        isBroadcast: true,
        readOnly: true,
        broadcastChannelId: normalizeId(data?.channelId || chatId),
        chatName: data?.chatName || data?.senderName || '',
        chatAvatar: data?.chatAvatar || '',
        isVerified: data?.isVerified === true || data?.isVerified === 'true',
      }
    : isGroup
    ? {
        chatId,
        chatType: 'group',
        isGroup: true,
        groupId: normalizeId(data?.groupId || chatId),
        chatName: data?.groupName || '',
        group: { _id: normalizeId(data?.groupId || chatId), name: data?.groupName || '', avatar: '' },
      }
    : {
        chatId,
        chatType: 'private',
        // peerUser = the message SENDER (the other party in the receiver's view),
        // so the chat header resolves a real name instead of "Unknown User".
        peerUser: {
          _id: normalizeId(data?.senderId),
          fullName: data?.senderName || '',
          profileImage: data?.profileImage || '',
          mobileNumber: data?.senderMobile || '',
        },
      };

  try {
    navigationRef.navigate('ChatScreen', { chatId, item });
    return true;
  } catch {
    return false;
  }
}

// Reset the ROOT navigator to the Login screen. Used on logout (manual from
// Settings, or forced by a server session-terminate). The nav container can be
// momentarily NOT ready right when logout fires — the session reset clears
// storage + dispatches a Redux reset, which can briefly re-render the tree. The
// old version silently did nothing in that window, leaving the user stranded on
// the Settings screen. Retry until the container is ready (best-effort, ~8s),
// mirroring navigateToChat, so the redirect always lands.
export function resetToLogin(attempt = 0) {
  if (navigationRef.isReady()) {
    try {
      navigationRef.reset({
        index: 0,
        routes: [{ name: 'Login' }],
      });
      return;
    } catch {
      // Fall through to retry — a reset issued mid-transition can throw.
    }
  }
  if (attempt < 40) {
    setTimeout(() => resetToLogin(attempt + 1), 200);
  }
}

// Reset the ROOT navigator to the dedicated account-state screen (blocked /
// inactive / deleted). Mirrors resetToLogin's retry-until-ready so the redirect
// always lands even when the session reset is re-rendering the tree. `state` is
// one of 'blocked' | 'inactive' | 'deleted'; `message` is the server copy.
export function resetToAccountStatus(state, message, attempt = 0) {
  if (navigationRef.isReady()) {
    try {
      navigationRef.reset({
        index: 0,
        routes: [{ name: 'AccountStatus', params: { state, message } }],
      });
      return;
    } catch {
      // Fall through to retry.
    }
  }
  if (attempt < 40) {
    setTimeout(() => resetToAccountStatus(state, message, attempt + 1), 200);
  }
}