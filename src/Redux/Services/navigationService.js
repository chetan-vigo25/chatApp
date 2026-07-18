import { createNavigationContainerRef, StackActions } from '@react-navigation/native';

export const navigationRef = createNavigationContainerRef();

let currentRouteSnapshot = null;
const navigationStateListeners = new Set();

const normalizeId = (value) => {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') {
    const s = String(value).trim();
    // Push/notifee data is a string map — a stringified empty value must not
    // count as a real id (it would misroute the tap, e.g. open a 1-1 chat as
    // a group because groupId === 'null').
    if (!s || s === 'null' || s === 'undefined') return null;
    return s;
  }
  if (typeof value === 'object') {
    const candidate = value?._id || value?.id || value?.userId || value?.$oid || null;
    return candidate == null ? null : String(candidate);
  }
  return null;
};

// Boolean-ish flags arriving from a notification tap are STRINGS ("false",
// "true") — notifee/FCM data payloads are string maps. `!!"false"` is true, so
// naive truthiness misclassifies every 1-1 message as a broadcast/channel and
// opens it read-only with the channel header. Parse explicitly.
const isTruthyFlag = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
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

// Routes where a chat-navigation intent must WAIT, not fire. On a cold tap-
// launch the container becomes ready while Splash is still checking auth; if we
// navigate('ChatScreen') then, Splash's follow-up `reset({routes:[ChatList]})`
// WIPES the chat off the stack and the tap lands on the chat list instead of
// the chat. Same for the first-time SyncScreen and the whole login flow. Hold
// the intent and keep retrying until the app has settled on a main route.
const PRE_MAIN_ROUTES = new Set([
  'Splash', 'SyncScreen', 'UserAgree', 'Login', 'LoginEmail', 'Otp',
  'AccountStatus', 'NoInternet',
]);

// Navigate to a chat from a tapped push notification. The push `data` carries
// { chatId, chatType, groupId, senderId, senderName, profileImage, senderMobile,
// groupName }. On a COLD launch the nav container isn't mounted yet, so retry
// until it's ready (best-effort, ~30s — first-time sync can take a while)
// instead of dropping the intent.
export function navigateToChat(data = {}, attempt = 0) {
  const chatId = normalizeId(data?.chatId || data?.groupId);
  if (!chatId) return false;

  if (!navigationRef.isReady()) {
    if (attempt < 150) setTimeout(() => navigateToChat(data, attempt + 1), 200);
    return false;
  }

  // Container ready but the app is still on Splash / sync / login — navigating
  // now would be reset away a moment later. Park the intent and retry.
  const curName = navigationRef.getCurrentRoute()?.name || null;
  if (curName && PRE_MAIN_ROUTES.has(curName)) {
    if (attempt < 150) setTimeout(() => navigateToChat(data, attempt + 1), 200);
    return false;
  }

  const isBroadcast = data?.chatType === 'broadcast' || isTruthyFlag(data?.isBroadcast) || data?.kind === 'broadcast';
  const isGroup = !isBroadcast
    && (data?.chatType === 'group' || isTruthyFlag(data?.isGroup) || !!normalizeId(data?.groupId));
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
    // Already inside a ChatScreen? Tapping a notification for the SAME chat is
    // a no-op; for a DIFFERENT chat, PUSH a fresh instance — `navigate` would
    // just mutate the open screen's params and risk showing chat A's messages
    // under chat B's header while its state catches up.
    const active = getActiveChatFromRoute(navigationRef.getCurrentRoute());
    if (active.routeName === 'ChatScreen') {
      if (active.chatId && String(active.chatId) === String(chatId)) return true;
      navigationRef.dispatch(StackActions.push('ChatScreen', { chatId, item }));
      return true;
    }
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