/**
 * "Couldn't download" signal for chat media.
 *
 * Any place that finds a media message can't be opened or fetched — the saved
 * file was deleted from the device/gallery and the server copy can't be
 * downloaded again, or the download itself failed — calls
 * showMediaUnavailable(). ChatScreen listens and shows ONE WhatsApp-style
 * dialog ("Couldn't download · Can't download. Please ask that it be resent
 * to you. · OK"), instead of the mix of Alerts / black viewers it had before.
 * A bus (not a prop) because useChatLogic's download path has no UI of its own.
 */
const listeners = new Set();

export const showMediaUnavailable = (info = {}) => {
  listeners.forEach((fn) => { try { fn(info); } catch {} });
};

export const subscribeMediaUnavailable = (fn) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};
