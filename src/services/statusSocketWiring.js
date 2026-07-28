/**
 * ONE shared attach point for all realtime status socket listeners.
 *
 * Previously StatusList, StatusFeedRow and useStatusIndicators each attached
 * their OWN copies of these handlers with their own 2s re-attach polls —
 * mounting two of them dispatched every socket event twice (and three, three
 * times). This module refcounts consumers and keeps exactly one listener set
 * alive on the current socket instance, re-attaching when the socket
 * reconnects as a new instance.
 */
import {
  addNewStatusFromSocket,
  removeStatusFromSocket,
  fetchBroadcasts,
  removeBroadcastFromSocket,
} from '../Redux/Reducer/Status/Status.reducer';
import { getSocket } from '../Redux/Services/Socket/socket';

let refCount = 0;
let attachedSocket = null;
let detachFn = null;
let pollTimer = null;
let dispatchRef = null;

function attach() {
  const socket = getSocket?.();
  if (!socket || attachedSocket === socket) return;
  detachFn?.();

  const dispatch = (...args) => dispatchRef?.(...args);

  const onStatusNew = (payload) => {
    // Admin broadcasts arrive on the same channel but flagged.
    if (payload?.isBroadcast || payload?.isOfficial || payload?.isAdminBroadcast) {
      dispatch(fetchBroadcasts());
      return;
    }
    dispatch(addNewStatusFromSocket(payload));
  };
  const onStatusGone = (payload) => dispatch(removeStatusFromSocket(payload));
  const onBroadcastChanged = () => dispatch(fetchBroadcasts());
  const onBroadcastDeleted = (payload) => dispatch(removeBroadcastFromSocket(payload));

  // Canonical events use a colon; underscore variants are legacy aliases.
  socket.on('status:new', onStatusNew);
  socket.on('new_status', onStatusNew);
  socket.on('status:deleted', onStatusGone);
  socket.on('status_deleted', onStatusGone);
  socket.on('status_expired', onStatusGone);
  socket.on('broadcast:new', onBroadcastChanged);
  socket.on('broadcast:updated', onBroadcastChanged);
  socket.on('broadcast:deleted', onBroadcastDeleted);

  attachedSocket = socket;
  detachFn = () => {
    socket.off('status:new', onStatusNew);
    socket.off('new_status', onStatusNew);
    socket.off('status:deleted', onStatusGone);
    socket.off('status_deleted', onStatusGone);
    socket.off('status_expired', onStatusGone);
    socket.off('broadcast:new', onBroadcastChanged);
    socket.off('broadcast:updated', onBroadcastChanged);
    socket.off('broadcast:deleted', onBroadcastDeleted);
    attachedSocket = null;
  };
}

/**
 * Call from a useEffect; returns the cleanup. Multiple concurrent consumers
 * share one listener set — handlers detach only when the LAST one unmounts.
 */
export function ensureStatusSocketListeners(dispatch) {
  dispatchRef = dispatch;
  refCount += 1;
  attach();
  if (!pollTimer) {
    // The socket may connect (or reconnect as a new instance) at any time.
    pollTimer = setInterval(() => {
      const s = getSocket?.();
      if (s && attachedSocket !== s) attach();
    }, 2000);
  }
  return () => {
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      detachFn?.();
      detachFn = null;
    }
  };
}
