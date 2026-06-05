import { getSocket } from '../../Redux/Services/Socket/socket';

/**
 * Cross-device call-LOG sync over the app's backend socket. Distinct from
 * callSignalService (which signals live calls): these events keep the Calls tab
 * in sync across a user's devices WITHOUT polling. The backend emits them to the
 * owner's `user:{id}` room whenever their history changes:
 *
 *   call:log:new      { item, created }   a call was recorded / updated
 *   call:log:deleted  { callIds }         rows were deleted
 *   call:logs:cleared { ts }              the whole history was cleared
 *
 * Returns an unsubscribe. Re-call on socket (re)connect so a fresh underlying
 * socket instance keeps the listeners (mirrors registerCallSignalListeners).
 */
export const registerCallLogListeners = (handlers = {}) => {
  const socket = getSocket();
  if (!socket) return () => {};

  const wrap = (evt, fn) => (payload) => {
    if (__DEV__) console.log(`[CALL][APP][log] ← ${evt}`, payload);
    if (fn) fn(payload);
  };

  const map = {
    'call:log:new': wrap('call:log:new', handlers.onNew),
    'call:log:deleted': wrap('call:log:deleted', handlers.onDeleted),
    'call:logs:cleared': wrap('call:logs:cleared', handlers.onCleared),
  };

  Object.keys(map).forEach((evt) => socket.on(evt, map[evt]));
  return () => {
    Object.keys(map).forEach((evt) => socket.off(evt, map[evt]));
  };
};
