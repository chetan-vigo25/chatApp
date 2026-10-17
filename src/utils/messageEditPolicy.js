// Pure, dependency-free message-edit policy (Oct-15 message-edit audit,
// E-A-01/02/03/05/07/08/09/11). CommonJS on purpose so
// `node --test __tests__/messageEditPolicy.test.js` loads it without React
// Native. Nothing here touches SQLite, Redux or the socket.
//
// Product rule: the sender can edit a text message only until the recipient
// has READ it. The server is the final authority; everything here is derived
// from the STORED row so the UI never keeps a separate "canEdit" state.

const EDIT_WINDOW_MS = 15 * 60 * 1000; // client UX hint only
const MAX_EDIT_TEXT_LENGTH = 10000;

const READ_STATUSES = new Set(['seen', 'read']);
// A row in any of these is not (yet) a settled, server-acked message.
const NOT_SETTLED = new Set([
  'sending', 'queued', 'uploading', 'failed', 'scheduled', 'processing', 'cancelled',
]);

const REASON = {
  NONE: null,
  MISSING: 'missing',
  NOT_OWN: 'not_own',
  NOT_TEXT: 'not_text',
  DELETED: 'deleted',
  NO_SERVER_ID: 'no_server_id',
  NOT_SETTLED: 'not_settled',
  BROADCAST: 'broadcast',
  READ: 'read',
  EXPIRED: 'expired',
};

const MSG_ALREADY_READ = "Message already read — can't edit";
const MSG_NOT_EDITABLE = "This message can't be edited";
const MSG_EXPIRED = 'You can only edit within 15 minutes';
const MSG_OFFLINE = 'Not connected. Please try again.';

const lc = (v) => String(v == null ? '' : v).toLowerCase();
const sid = (v) => (v == null ? '' : String(v));

const toMs = (v) => {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  const n = Number(v);
  if (Number.isFinite(n) && /^\d+$/.test(String(v).trim())) return n;
  return Date.parse(v);
};

const isBroadcastChat = (chat) =>
  Boolean(chat && (chat.chatType === 'broadcast' || chat.isBroadcast || chat.readOnly));

const serverIdOf = (msg) =>
  [msg && msg.serverMessageId, msg && msg.messageId, msg && msg.id]
    .map(sid)
    .find((v) => v && !v.startsWith('temp_')) || null;

// Has anybody other than the sender read this row? Uses the stored status
// ('seen' / 'read', which for a group is the aggregate) AND the readBy map
// (group: any single member read).
const hasBeenRead = (msg, myUserId) => {
  if (!msg) return false;
  if (READ_STATUSES.has(lc(msg.status))) return true;
  const rb = msg.readBy;
  const me = sid(myUserId || msg.senderId);
  if (Array.isArray(rb)) return rb.some((u) => sid(u && (u._id || u.userId || u)) !== me);
  if (rb && typeof rb === 'object') return Object.keys(rb).some((k) => k && k !== me);
  return false;
};

// Returns null when editable, else a REASON string.
const getEditBlockReason = (msg, opts = {}) => {
  const { chat = null, now = Date.now(), myUserId = null } = opts;
  if (!msg) return REASON.MISSING;
  const isOwn = typeof opts.isOwn === 'boolean'
    ? opts.isOwn
    : (Boolean(myUserId) && sid(msg.senderId) === sid(myUserId));
  if (!isOwn) return REASON.NOT_OWN;
  if (!(msg.type === 'text' || msg.type === undefined || msg.type === null)) return REASON.NOT_TEXT;
  if (msg.isDeleted) return REASON.DELETED;
  if (!serverIdOf(msg)) return REASON.NO_SERVER_ID;
  // a temp-id-only row (id is temp_ and no server id) is caught above.
  if (isBroadcastChat(chat)) return REASON.BROADCAST;
  if (hasBeenRead(msg, myUserId)) return REASON.READ;
  if (NOT_SETTLED.has(lc(msg.status))) return REASON.NOT_SETTLED;
  const created = toMs(msg.createdAt != null ? msg.createdAt : msg.timestamp);
  if (Number.isFinite(created) && created > 0 && now - created > EDIT_WINDOW_MS) return REASON.EXPIRED;
  return REASON.NONE;
};

const canEditMessage = (msg, opts = {}) => getEditBlockReason(msg, opts) === null;

// User-facing line for a block reason (null when nothing worth saying).
const blockReasonMessage = (reason) => {
  switch (reason) {
    case REASON.READ: return MSG_ALREADY_READ;
    case REASON.EXPIRED: return MSG_EXPIRED;
    case REASON.NO_SERVER_ID:
    case REASON.NOT_SETTLED: return 'Message is still sending. Please wait.';
    case REASON.DELETED: return 'This message was deleted';
    case REASON.BROADCAST: return "Can't edit messages in this chat";
    default: return null;
  }
};

// Live-row watcher for an open edit composer / menu (E-A-02): given the live
// row, should the composer exit, and with what message?
const editExitDecision = (liveMsg, opts = {}) => {
  const reason = getEditBlockReason(liveMsg, opts);
  // The 15-minute hint must not yank the composer from under someone typing.
  if (reason === null || reason === REASON.EXPIRED || reason === REASON.MISSING) {
    return { exit: false, message: null };
  }
  return { exit: true, reason, message: blockReasonMessage(reason) || MSG_ALREADY_READ };
};

// ack / error code -> user text (E-A-03).
const EDIT_ERROR_TEXT = {
  ALREADY_READ: MSG_ALREADY_READ,
  MESSAGE_ALREADY_READ: MSG_ALREADY_READ,
  NOT_EDITABLE: MSG_NOT_EDITABLE,
  EDIT_TIMEOUT: MSG_EXPIRED,
  MESSAGE_DELETED: 'This message was deleted',
  NOT_MESSAGE_OWNER: 'You can only edit your own messages',
  BROADCAST_READ_ONLY: "Can't edit messages in this chat",
  TEXT_TOO_LONG: 'Message is too long',
  NO_EDIT_CONTENT: 'Nothing to change',
  MESSAGE_NOT_FOUND: 'Message not found',
  RATE_LIMIT_EXCEEDED: 'Too many edits. Please try again in a moment.',
};
const GENERIC_EDIT_ERROR = 'The message could not be edited.';

const editErrorCode = (ack) => {
  if (!ack || typeof ack !== 'object') return null;
  const c = ack.code || (ack.error && (ack.error.code || (typeof ack.error === 'string' ? ack.error : null)));
  return c ? String(c).toUpperCase() : null;
};
const editErrorMessage = (ack) => {
  const code = editErrorCode(ack);
  return (code && EDIT_ERROR_TEXT[code]) || GENERIC_EDIT_ERROR;
};

// Did the server reject the edit? Old server: {status:false}/{success:false};
// new server error acks carry {code,message,category}.
const isEditRejected = (ack) => {
  if (!ack || typeof ack !== 'object') return false;
  if (ack.status === false || ack.success === false) return true;
  if (ack.status === true || ack.success === true) return false;
  return Boolean(ack.code || ack.error);
};

// Revert only if the row still shows OUR optimistic text: a newer server edit
// that landed while we waited must not be clobbered by the rollback (E-A-03).
const shouldRevertEdit = ({ optimisticText, currentText } = {}) =>
  currentText === undefined || currentText === null
    ? true
    : String(currentText) === String(optimisticText);

// Version/ordering guard for every edit applier (E-A-07).
// stored/incoming: { editVersion, editedAt }. Incoming wins when its version is
// higher, or (version equal / absent) its editedAt is not older.
const toVersion = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const shouldApplyEdit = (stored, incoming) => {
  const sv = toVersion(stored && stored.editVersion);
  const iv = toVersion(incoming && incoming.editVersion);
  if (iv !== null && iv !== undefined) {
    const base = sv === null ? 0 : sv;
    if (iv > base) return true;
    if (iv < base) return false;
  }
  const ie = toMs(incoming && incoming.editedAt);
  const se = toMs(stored && stored.editedAt);
  if (!Number.isFinite(ie)) return true; // nothing to compare against
  if (!Number.isFinite(se)) return true;
  return ie >= se;
};

// Fingerprint fragment so the message-list gate repaints on a 2nd edit (E-A-05).
const editFingerprint = (m) => {
  if (!m || !(m.isEdited || m.editedAt)) return '';
  return `:e${m.editVersion || 0}.${m.editedAt || ''}.${m.text ? String(m.text).length : 0}`;
};

// Client-side cap (E-A-09). Returns trimmed text or null if unusable.
const checkEditText = (text) => {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return { ok: false, reason: 'empty', text: '' };
  if (t.length > MAX_EDIT_TEXT_LENGTH) return { ok: false, reason: 'too_long', text: t };
  return { ok: true, reason: null, text: t };
};

module.exports = {
  EDIT_WINDOW_MS,
  MAX_EDIT_TEXT_LENGTH,
  REASON,
  MSG_ALREADY_READ,
  MSG_NOT_EDITABLE,
  MSG_EXPIRED,
  MSG_OFFLINE,
  GENERIC_EDIT_ERROR,
  isBroadcastChat,
  serverIdOf,
  hasBeenRead,
  getEditBlockReason,
  canEditMessage,
  blockReasonMessage,
  editExitDecision,
  editErrorCode,
  editErrorMessage,
  isEditRejected,
  shouldRevertEdit,
  shouldApplyEdit,
  editFingerprint,
  checkEditText,
};
