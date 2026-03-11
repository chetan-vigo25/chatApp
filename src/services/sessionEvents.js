const listeners = {
  sessionReset: new Set(),
  userChanged: new Set(),
};

const safeInvoke = (callback, payload) => {
  try {
    callback(payload);
  } catch (error) {
    console.warn('sessionEvents callback error', error);
  }
};

export const emitSessionReset = (payload = {}) => {
  listeners.sessionReset.forEach((callback) => safeInvoke(callback, payload));
};

export const subscribeSessionReset = (callback) => {
  if (typeof callback !== 'function') return () => {};
  listeners.sessionReset.add(callback);
  return () => {
    listeners.sessionReset.delete(callback);
  };
};

export const emitUserChanged = (payload = {}) => {
  listeners.userChanged.forEach((callback) => safeInvoke(callback, payload));
};

export const subscribeUserChanged = (callback) => {
  if (typeof callback !== 'function') return () => {};
  listeners.userChanged.add(callback);
  return () => {
    listeners.userChanged.delete(callback);
  };
};

export default {
  emitSessionReset,
  subscribeSessionReset,
  emitUserChanged,
  subscribeUserChanged,
};