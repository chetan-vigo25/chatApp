// One delivery receipt per message, app-wide.
//
// Three independent code paths emit `message:delivered` / `group:message:delivered`
// for an incoming message — the app-wide listener in RealtimeChatContext, the
// open chat screen (useChatLogic), and the batched emitter in ChatSocketProvider —
// and the server fans every message out twice (`message:received` + `message:new`).
// Each path deduped only against itself, so one message produced THREE receipts
// (verified on device), and the sender processed three delivered events for it.
//
// Claim the id right before emitting; a false return means another path already
// sent the receipt. Only claim when the emit will really happen (socket up), so
// an offline moment can never suppress the receipt for good.

const MAX_TRACKED = 3000;
const _claimed = new Set();

export const claimDeliveryReceipt = (messageId) => {
  if (messageId == null) return false;
  const key = String(messageId);
  if (!key || _claimed.has(key)) return false;
  _claimed.add(key);
  if (_claimed.size > MAX_TRACKED) {
    const oldest = _claimed.values().next().value;
    _claimed.delete(oldest);
  }
  return true;
};

// Account switch: receipts belong to the signed-in user.
export const resetDeliveryReceipts = () => { _claimed.clear(); };

export default { claimDeliveryReceipt, resetDeliveryReceipts };
