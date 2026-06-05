import ChatDatabase from '../services/ChatDatabase';
import ChatCache from '../services/ChatCache';
import { apiCall } from '../Config/Https';

const normalizeId = (id) => (id == null ? '' : String(id));

// Runs the pre-armed "deleted chats password" purge. Unlike the per-chat
// "clear" endpoints (which keep the chat row in the list), this uses the bulk
// DELETE endpoints so the selected chats are REMOVED from the chat list:
//   - scope 'me'       → user/chat/delete/bulk          (removes only my row)
//   - scope 'everyone' → user/chat/delete/bulk/everyone (removes BOTH sides'
//                        rows; the peer is notified over the socket so the chat
//                        leaves their list too)
// After the server confirms which chats were deleted, the same per-chat local
// cleanup ChatList uses runs (SQLite messages + tombstone + chat row delete +
// in-memory cache), and onChatDeleted(chatId) is invoked so the caller can drop
// the row from the in-memory realtime list immediately.
//
// onProgress(done, total) is invoked around the local cleanup loop.
// Returns { total, failures, deleted, deletedChatIds }.
export async function executeDeletedChatPurge({ chatIds, scope, onProgress, onChatDeleted } = {}) {
  const ids = Array.from(new Set((Array.isArray(chatIds) ? chatIds : []).map(normalizeId).filter(Boolean)));
  if (ids.length === 0) return { total: 0, failures: 0, deleted: 0, deletedChatIds: [] };

  const endpoint = scope === 'everyone' ? 'user/chat/delete/bulk/everyone' : 'user/chat/delete/bulk';

  let deletedChatIds = [];
  try {
    const response = await apiCall('POST', endpoint, { chatIds: ids });
    const failed = response && (
      response.success === false ||
      response.status === false ||
      response.ok === false ||
      response.error
    );
    if (failed) {
      return { total: ids.length, failures: ids.length, deleted: 0, deletedChatIds: [] };
    }
    const data = response?.data || {};
    deletedChatIds = Array.isArray(data.deletedChatIds)
      ? data.deletedChatIds.map(normalizeId).filter(Boolean)
      : ids;
  } catch {
    // Server call failed entirely — nothing was deleted server-side.
    return { total: ids.length, failures: ids.length, deleted: 0, deletedChatIds: [] };
  }

  // Local cleanup — ONLY for chats the server actually deleted.
  let failures = ids.length - deletedChatIds.length;
  for (let i = 0; i < deletedChatIds.length; i++) {
    const chatId = deletedChatIds[i];
    if (typeof onProgress === 'function') onProgress(i, deletedChatIds.length);
    try { await ChatDatabase.clearChat(chatId, Date.now()); } catch {}
    try { await ChatDatabase.deleteChatRow(chatId); } catch {}
    try { ChatCache.clearMessages(chatId); } catch {}
    try { ChatCache.removeChat(chatId); } catch {}
    // Drop the row from the in-memory realtime list right away.
    try { if (typeof onChatDeleted === 'function') onChatDeleted(chatId); } catch {}
  }

  if (typeof onProgress === 'function') onProgress(deletedChatIds.length, deletedChatIds.length);
  return { total: ids.length, failures, deleted: deletedChatIds.length, deletedChatIds };
}
