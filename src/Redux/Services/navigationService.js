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

export function resetToLogin() {
  if (navigationRef.isReady()) {
    navigationRef.reset({
      index: 0,
      routes: [{ name: 'Login' }],
    });
  }
}