import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Keyboard, Platform, DeviceEventEmitter } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from 'expo-file-system/legacy';
import moment from "moment";
import { useDispatch, useSelector } from "react-redux";
import { chatMessage, chatListData, mediaUpload } from "../Redux/Reducer/Chat/Chat.reducer";
import { viewGroup } from "../Redux/Reducer/Group/Group.reducer";
import { getSocket, isSocketConnected, reconnectSocket, emitSocketEvent } from "../Redux/Services/Socket/socket";
import { useNetwork } from "../contexts/NetworkContext";
import { useImage } from "../contexts/ImageProvider";
import { useFocusEffect } from "@react-navigation/native";
import { normalizePresencePayload, normalizeStatus, PRESENCE_STATUS } from "../utils/presence";
import { useRealtimeChat } from "./RealtimeChatContext";
import localStorageService from '../services/LocalStorageService';
import ChatDatabase from '../services/ChatDatabase';
import ContactDatabase from '../services/ContactDatabase';
import { hashPhoneForMatch, onlyDigits } from '../utils/savedContactName';
import ChatCache from '../services/ChatCache';
import OutboxWorker from '../services/OutboxWorker';
import { isInForwardWindow, clearForwardTimestamp } from '../utils/forwardState';
import { shouldEmitReadAll } from '../utils/readAllThrottle';
import mediaDownloadManager, { MEDIA_DOWNLOAD_STATUS, resolveMediaIdentity } from '../services/MediaDownloadManager';
import { apiCall } from '../Config/Https';
import {
  clearChatLocalArtifacts,
  getChatClearedAt,
  getChatMessagesKey,
  removeMessagesByChatId,
  performDurableChatClear,
} from '../utils/chatClearStorage';

import {
  normalizeUri,
  uploadMediaFile,
} from "../utils/mediaService";
import SqliteWriter from "../services/SqliteWriter";
import { pauseBackgroundSyncFor } from "../services/syncPriority";
import { subscribeSessionReset, subscribeUserChanged } from "../services/sessionEvents";

// Module-level cache of the logged-in user (id + display name). `initializeChat`
// used to `await AsyncStorage.getItem("userInfo")` on EVERY chat open before it
// could paint the cached/SQLite messages — an async I/O hop on the first-paint
// critical path. The value never changes within a session, so we read it once
// and reuse it synchronously on every later open. Cleared on session reset or
// account switch so the next open re-reads the new account.
let _cachedUserInfo = null;
subscribeSessionReset(() => { _cachedUserInfo = null; });
subscribeUserChanged(() => { _cachedUserInfo = null; });

// Per-chat "last on-open server delta-sync" timestamp, MODULE-LEVEL so it survives
// ChatScreen unmount/remount (rapid open→close→reopen remounts the screen). WhatsApp
// doesn't re-sync a chat from the server on every open: while a chat is open the live
// socket delivers new messages, and on reconnect message:sync:catchup fills gaps. So
// a re-open within the throttle window skips the redundant server request — far fewer
// requests, no reload churn. Cleared on logout/account switch so a new account never
// reuses a stale throttle.
const _lastChatSyncAt = new Map();
subscribeSessionReset(() => { _lastChatSyncAt.clear(); });
subscribeUserChanged(() => { _lastChatSyncAt.clear(); });
const getCachedUserInfo = async () => {
  if (_cachedUserInfo) return _cachedUserInfo;
  try {
    const raw = await AsyncStorage.getItem("userInfo");
    if (!raw) return null;
    _cachedUserInfo = JSON.parse(raw);
    return _cachedUserInfo;
  } catch {
    return null;
  }
};

/* Constants */
const MAX_LOCAL_SAVE = 300;
const MAX_RECONNECT_ATTEMPTS = 5;
// Once the fast attempts are exhausted we keep retrying silently at this
// interval (never surfacing an error) so the socket self-heals after a
// screen-off suspend or a Wi-Fi/data drop the moment the host is reachable.
const MAX_RECONNECT_BACKOFF_MS = 15000;

// Debug switch for tracing WHERE chat-thread messages come from (SQLite vs the
// socket sync). Flip to false to silence. The chat thread always renders from
// SQLite first; the socket sync only fills gaps — these logs make that visible.
const DEBUG_CHAT_SOURCE = true;
const cslog = (...args) => { if (DEBUG_CHAT_SOURCE) console.log('[CHAT-SOURCE]', ...args); };
const TYPING_TIMEOUT = 3000; // 3 seconds
const PRESENCE_HEARTBEAT_INTERVAL = 30000;
const PRESENCE_POLL_INTERVAL = 45000;
const PRESENCE_BACKGROUND_AWAY_DELAY = 30000;
const PRESENCE_IDLE_TIMEOUT = 5 * 60 * 1000;
const MANUAL_PRESENCE_QUEUE_KEY = "presence_manual_queue";
const MEDIA_STATUS_QUEUE_KEY = 'media_status_update_queue';
const DELETED_TOMBSTONES_PREFIX = "chat_deleted_tombstones_";
const PENDING_EDITS_PREFIX = "chat_pending_edits_";
const MUTATION_CURSOR_PREFIX = "chat_mutation_cursor_";
const READ_MARK_DELAY = 800;
const SOCKET_FETCH_LIMIT = 50;
// First-paint page: small for the fastest possible initial render. Scroll-up
// paging grows the displayed window; refreshMessagesFromDB then reads at least
// the whole loaded window so a re-read never shrinks the list back to one page.
const INITIAL_PAGE_SIZE = 40;
const LOCAL_SAVE_DEBOUNCE_MS = 220;
const MEDIA_STATUS_ACK_TIMEOUT_MS = 9000;
const MEDIA_STATUS_MAX_RETRIES = 5;
const MEDIA_STATUS_BASE_RETRY_DELAY_MS = 2000;
const MEDIA_UPLOAD_QUEUE_KEY = 'media_upload_queue';
const MEDIA_UPLOAD_MAX_RETRIES = 4;
const MEDIA_UPLOAD_TIMEOUT_MS = 30000;

const normalizeId = (value) => {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object") {
    // Prefer _id.$oid for MongoDB
    if (value._id && value._id.$oid) return String(value._id.$oid);
    const candidate = value._id || value.id || value.userId || value.$oid || null;
    if (candidate == null) return null;
    return String(candidate);
  }
  return null;
};

const sameId = (a, b) => {
  const left = normalizeId(a);
  const right = normalizeId(b);
  return Boolean(left && right && left === right);
};

// Private chat ids MUST be deterministic so the sender, the receiver, and the
// backend all compute the SAME id for a pair. The backend sorts the two user
// ids (`u_<min>_<max>`); the app must do the identical sort, otherwise the
// sender stores `u_A_B` while everyone else uses `u_<min>_<max>` → duplicate
// SQLite/chatMap rows and "Unknown User" on brand-new chats.
export const buildPrivateChatId = (a, b) => {
  const left = a == null ? '' : String(a);
  const right = b == null ? '' : String(b);
  return `u_${[left, right].sort().join('_')}`;
};

// Private chat ids are minted as `u_<userA>_<userB>` and the two participants may
// have opposite orderings locally. Compare by the participant set so a message
// arriving as `u_A_B` is not dropped on a receiver whose local id is `u_B_A`.
const sameChatId = (a, b) => {
  const left = normalizeId(a);
  const right = normalizeId(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.startsWith('u_') && right.startsWith('u_')) {
    const lp = left.slice(2).split('_').filter(Boolean).sort().join('_');
    const rp = right.slice(2).split('_').filter(Boolean).sort().join('_');
    return lp === rp;
  }
  return false;
};

const isDeletedForUser = (deletedFor, userId) => {
  const normalizedUserId = normalizeId(userId);
  if (!deletedFor) return false;

  if (typeof deletedFor === 'string') {
    return deletedFor.toLowerCase() === 'everyone' || sameId(deletedFor, normalizedUserId);
  }

  if (Array.isArray(deletedFor)) {
    return deletedFor.some((id) => sameId(id, normalizedUserId));
  }

  if (typeof deletedFor === 'object') {
    const users = Array.isArray(deletedFor?.users) ? deletedFor.users : [];
    if (users.some((id) => sameId(id, normalizedUserId))) return true;
    return sameId(deletedFor?.userId || deletedFor?._id || deletedFor?.id, normalizedUserId);
  }

  return false;
};

const computeSenderType = (senderId, currentUserId) => (
  sameId(senderId, currentUserId) ? 'self' : 'other'
);

// Sanitize reactions from any source (API, SQLite, socket) into { emoji: { count, users } }
const sanitizeReactions = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  // Handle array format: [ { emoji, userId }, ... ]
  if (Array.isArray(raw)) {
    const result = {};
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const emoji = item.emoji || item.key || item.type;
      if (!emoji || typeof emoji !== 'string') continue;
      if (!result[emoji]) result[emoji] = { count: 0, users: [] };
      const uid = item.userId || item.user || item.reactedBy;
      if (uid && !result[emoji].users.includes(String(uid))) result[emoji].users.push(String(uid));
      if (Array.isArray(item.users)) {
        for (const u of item.users) { const s = String(u); if (!result[emoji].users.includes(s)) result[emoji].users.push(s); }
      }
      result[emoji].count = result[emoji].users.length;
    }
    return Object.keys(result).length > 0 ? result : null;
  }
  // Handle object map — filter out invalid keys
  const result = {};
  for (const [k, v] of Object.entries(raw)) {
    if (/^\d+$/.test(k) || !k || k === 'undefined' || k === 'null') continue;
    if (v && typeof v === 'object' && Array.isArray(v.users) && v.users.length > 0) {
      result[k] = { count: v.users.length, users: [...v.users] };
    }
  }
  return Object.keys(result).length > 0 ? result : null;
};

const buildDeletePlaceholderText = (isDeletedBySelf) => (
  isDeletedBySelf ? 'You deleted this message' : 'This message was deleted'
);

const generateClientMessageId = () => (
  `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
);

const extractFileName = (nameOrUri = '') => {
  const value = String(nameOrUri || '').trim();
  if (!value) return 'media';
  const withoutQuery = value.split('?')[0];
  const parts = withoutQuery.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : 'media';
};

const resolveUploadMediaId = (uploadData = {}) => {
  if (uploadData?.mediaId) return String(uploadData.mediaId);
  if (uploadData?._id?.$oid) return String(uploadData._id.$oid);
  if (uploadData?._id) return String(uploadData._id);
  if (uploadData?.id) return String(uploadData.id);
  return null;
};

export default function useChatLogic({ navigation, route }) {
  const dispatch = useDispatch();
  const { isConnected, networkType } = useNetwork();
  const { pickMedia, pickMediaMultiple } = useImage();
  const { setActiveChat, markChatRead, onLocalOutgoingMessage, updateLocalLastMessagePreview, removeChat, restoreGroupMembership, inactiveGroupIds } = useRealtimeChat();
  const { currentGroup } = useSelector((s) => s.group || {});

  const deferRealtimeUpdate = useCallback((fn) => {
    // Ensure provider mutations run after current render/commit cycle.
    setTimeout(() => {
      try {
        fn?.();
      } catch (error) {
        console.warn('deferRealtimeUpdate error', error);
      }
    }, 0);
  }, []);
  const chatMessagesData = useSelector(state => state.chat?.chatMessagesData || state.chat?.data || state.chat);
  
  const ENUM_MESSAGE_TYPES = new Set(['text', 'image', 'video', 'audio', 'file', 'location', 'contact', 'system', 'call', 'album']);
  const MEDIA_MESSAGE_TYPES = new Set(['image', 'photo', 'video', 'audio', 'file', 'document']);

  const normalizeOutboundMessageType = (value) => {
    const type = String(value || '').toLowerCase();
    if (type === 'photo') return 'image';
    if (type === 'document') return 'file';
    if (ENUM_MESSAGE_TYPES.has(type)) return type;
    return 'file';
  };
  
  const isMediaMessageType = (value) => {
    const type = String(value || '').toLowerCase();
    return MEDIA_MESSAGE_TYPES.has(type);
  };
  
  const normalizeMessagePayloadWithDownloadFlag = (messageType, payload = {}) => {
    const base = payload && typeof payload === 'object' ? { ...payload } : {};
    if (isMediaMessageType(messageType)) {
      return {
        ...base,
        isMediaDownloaded: Boolean(base?.isMediaDownloaded),
      };
    }
    if ('isMediaDownloaded' in base) {
      delete base.isMediaDownloaded;
    }
    return base;
  };

  const mergePayloadKeepingDownloadState = (existingMessage = {}, incomingMessage = {}) => {
    const resolvedType = incomingMessage?.type || incomingMessage?.mediaType || incomingMessage?.messageType || existingMessage?.type || 'text';
    const mergedLocalUri = incomingMessage?.localUri || existingMessage?.localUri || null;
    const isDownloaded = Boolean(
      existingMessage?.payload?.isMediaDownloaded ||
      incomingMessage?.payload?.isMediaDownloaded ||
      existingMessage?.isMediaDownloaded ||
      incomingMessage?.isMediaDownloaded ||
      mergedLocalUri
    );

    return normalizeMessagePayloadWithDownloadFlag(resolvedType, {
      ...(existingMessage?.payload || {}),
      ...(incomingMessage?.payload || {}),
      isMediaDownloaded: isDownloaded,
    });
  };

  // Build chatData safely from route.params (supports both `item` and `user`)
  const { item, chatId: routeChatId, user } = (route && route.params) || {};
  const routePeerUser = item?.peerUser || user || null;
  const normalizedPeerUser = routePeerUser
    ? {
        ...routePeerUser,
        _id: routePeerUser._id || routePeerUser.userId || routePeerUser.id || null,
      }
    : null;
  // Preserve chatType + group fields from the route item
  const isGroupChat = item?.chatType === 'group' || item?.isGroup || Boolean(item?.group);
  // Broadcast channel: a one-way, read-only chat. It has no peer and no group —
  // its branding (name/logo/verified) rides on the chat-list item, so carry it
  // onto chatData explicitly (otherwise the header falls back to "Group").
  const isBroadcastChat = item?.chatType === 'broadcast' || Boolean(item?.isBroadcast);
  const chatTypeField = item?.chatType || (isGroupChat ? 'group' : (isBroadcastChat ? 'broadcast' : 'private'));
  const broadcastFields = isBroadcastChat ? {
    isBroadcast: true,
    readOnly: true,
    broadcastChannelId: item.broadcastChannelId || item.chatId || item._id || null,
    chatName: item.chatName || item.broadcastChannel?.name || null,
    chatAvatar: item.chatAvatar || item.broadcastChannel?.avatarUrl || null,
    groupName: item.chatName || null,
    groupAvatar: item.chatAvatar || null,
    isVerified: item.isVerified ?? item.broadcastChannel?.isVerified ?? false,
  } : {};
  // Live group metadata overlay — updated in realtime when an admin/owner
  // changes the group name/avatar/description while this chat is open, so the
  // header reflects it instantly. Keyed by groupId so it never leaks to another chat.
  const [liveGroupMeta, setLiveGroupMeta] = useState(null);
  const _gid = isGroupChat ? (item.groupId || item.group?._id) : null;
  const _meta = (liveGroupMeta && _gid && String(liveGroupMeta.groupId) === String(_gid)) ? liveGroupMeta : null;
  const _liveName = _meta?.name;
  const _liveAvatar = _meta?.avatar;
  const groupFields = isGroupChat ? {
    isGroup: true,
    groupId: _gid,
    group: {
      ...(item.group || {}),
      ...(_liveName != null ? { name: _liveName } : {}),
      ...(_liveAvatar != null ? { avatar: _liveAvatar } : {}),
      ...(_meta?.description != null ? { description: _meta.description } : {}),
    },
    chatName: _liveName || item.chatName || item.group?.name,
    chatAvatar: _liveAvatar || item.chatAvatar || item.group?.avatar,
    groupName: _liveName || item.chatName || item.group?.name,
    groupAvatar: _liveAvatar || item.chatAvatar || item.group?.avatar,
    members: item.members,
    memberCount: item.members?.length || item.memberCount,
  } : {};

  // Group chats take priority — even if peerUser exists on the item, treat as group.
  // Memoized so its object reference stays stable across renders: chatData feeds
  // many useCallback/useEffect dependency arrays (e.g. renderChatsItem), and an
  // unstable reference here forces the whole message list to re-render every
  // render — which shows up as old messages "blinking"/refreshing repeatedly.
  // All inputs below are pure functions of [item, user, routeChatId, liveGroupMeta].
  const chatData = useMemo(() => (
    isBroadcastChat
      ? { peerUser: null, chatId: item?.chatId || item?._id || routeChatId || null, chatType: 'broadcast', ...broadcastFields }
      : isGroupChat
        ? { peerUser: null, chatId: item?.chatId || item?._id || routeChatId || null, chatType: 'group', ...groupFields }
        : (item && normalizedPeerUser)
          ? { peerUser: normalizedPeerUser, chatId: item.chatId || item._id || routeChatId || null, chatType: chatTypeField }
          : (normalizedPeerUser ? { peerUser: normalizedPeerUser, chatId: routeChatId || null, chatType: chatTypeField } : { peerUser: null, chatId: null, chatType: 'private' })
  ), [item, user, routeChatId, liveGroupMeta]);

  // True when this is a group chat the current user has left or been removed
  // from — used to disable the message input (you can no longer send messages).
  const amNotGroupMember = useMemo(() => {
    if (!isGroupChat || !inactiveGroupIds) return false;
    const gid = _gid || chatData?.groupId || chatData?.chatId;
    return Boolean(gid && inactiveGroupIds[String(gid)]);
  }, [isGroupChat, inactiveGroupIds, _gid, chatData]);
  // Mirror into a ref so send handlers can short-circuit without adding this to
  // every useCallback dependency array.
  const amNotGroupMemberRef = useRef(false);
  amNotGroupMemberRef.current = amNotGroupMember;

  // Reconcile the realtime "inactive group" flag against authoritative server
  // membership. When an admin re-adds a member who previously left/was removed,
  // the realtime `group:member:added` event may not reach this client (or arrives
  // with a non-matching id), so the inactiveGroupIds flag — which gates BOTH
  // sending and receiving — stays set and the "you're no longer a member" banner
  // persists. viewGroup (dispatched on open) fetches the real member list with
  // per-member status, so if it shows us as an active member while the flag is
  // still set, clear it to re-enable send + receive.
  useEffect(() => {
    if (!isGroupChat) return;
    const gid = _gid || chatData?.groupId || chatData?.chatId;
    if (!gid || !inactiveGroupIds || !inactiveGroupIds[String(gid)]) return;
    const cgId = currentGroup?.group?._id || currentGroup?.group?.id;
    if (!cgId || !sameId(cgId, gid) || !Array.isArray(currentGroup?.members)) return;
    const me = currentGroup.members.find((m) => {
      const mid = (typeof m.userId === 'object' && m.userId !== null)
        ? (m.userId._id || m.userId.id)
        : (m.userId || m._id || m.id);
      return sameId(mid, currentUserId);
    });
    if (me && me.status !== 'removed' && !me.isDeleted) {
      restoreGroupMembership(gid);
    }
  }, [isGroupChat, _gid, chatData, inactiveGroupIds, currentGroup, currentUserId, restoreGroupMembership]);

  // Live participant count for the header — prefer the freshly-fetched
  // currentGroup.members (kept in sync by viewGroup) so the count drops live when
  // a member leaves/is removed, instead of the stale route-param count. Guarded by
  // a group-id match because currentGroup is a single shared redux slot.
  const liveMemberCount = useMemo(() => {
    if (!isGroupChat) return undefined;
    const cgId = currentGroup?.group?._id || currentGroup?.group?.id;
    if (cgId && _gid && sameId(cgId, _gid) && Array.isArray(currentGroup?.members)) {
      return currentGroup.members.filter((m) => m?.status !== 'removed' && !m?.isDeleted).length;
    }
    return chatData?.group?.memberCount || chatData?.members?.length || chatData?.memberCount;
  }, [isGroupChat, currentGroup, _gid, chatData]);

  // Refs
  const fadeAnimRef = useRef(null);
  const flatListRef = useRef(null);
  const socketRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const peerTypingTimeoutRef = useRef(null); // Separate timeout for peer typing
  const appState = useRef(AppState.currentState);
  const presenceCheckInterval = useRef(null);
  const hasSyncedRef = useRef(false);
  const chatIdRef = useRef(null);
  const currentUserIdRef = useRef(null);
  const currentUserNameRef = useRef('');
  const groupMembersMapRef = useRef({});
  const allMessagesRef = useRef([]);
  // Size of the currently-loaded message window (grows as the user scrolls up).
  // refreshMessagesFromDB reads at least this many rows so a re-read triggered
  // by an incoming message / receipt / reaction never collapses the list back
  // to the first page (which made it "load again and again" on every event).
  const loadedLimitRef = useRef(INITIAL_PAGE_SIZE);
  const pendingMessagesRef = useRef([]);
  const socketCheckInterval = useRef(null);
  const isComponentMounted = useRef(true);
  const reconnectAttempts = useRef(0);
  const reconnectTimeoutRef = useRef(null);
  const searchTimeoutRef = useRef(null);
  const initialLoadDoneRef = useRef(false);
  // Cold-start recovery: set when the on-open message fetch could not be
  // emitted (socket still connecting). The `connect` handler checks it and
  // fires the FULL fetch the open owed, instead of a seq-delta that assumes
  // local rows already exist.
  const pendingInitialFetchRef = useRef(false);
  const heartbeatIntervalRef = useRef(null);
  const idleTimeoutRef = useRef(null);
  const backgroundAwayTimeoutRef = useRef(null);
  const lastInteractionAtRef = useRef(Date.now());
  const queuedManualPresenceRef = useRef([]);
  const queuedMediaStatusRef = useRef([]);
  const queuedMediaUploadsRef = useRef([]);
  const mediaUploadQueueInFlightRef = useRef(false);
  const flushQueuedMediaUploadsRef = useRef(async () => {});
  const mediaStatusInFlightRef = useRef(false);
  const mediaStatusProcessedRef = useRef(new Set());
  const presenceUpdateVersionRef = useRef(0);
  const readMarkTimeoutRef = useRef(null);
  const lastMessageSyncAtRef = useRef(0);
  const forceReloadPendingRef = useRef(false);
  const visibilityReadTimeoutRef = useRef(null);
  const loadMoreInFlightRef = useRef(false);
  const fetchOlderCursorRef = useRef(null);
  const lastInitializedChatRef = useRef(null);
  const isHardReloadingRef = useRef(false);
  const deletedTombstonesRef = useRef({});
  // Pending edits for messages not yet in local state (out-of-order arrival).
  // Keyed by normalized messageId → { text, editedAt }. Persisted per-chat so a
  // relaunch before the message syncs in still applies the edit on arrival.
  const pendingEditsRef = useRef({});
  // Latest applyMutatedMessages — held in a ref so the socket-handler closure
  // (setupSocketListeners, defined earlier) can call the up-to-date function
  // without a TDZ forward-reference in its dependency array.
  const applyMutatedMessagesRef = useRef(null);
  // Snapshots of messages optimistically deleted-for-everyone, keyed by resolved
  // id, so a server rejection (CANNOT_DELETE_FOR_EVERYONE / DELETE_TIMEOUT) can
  // restore the original message.
  const pendingDeleteSnapshotsRef = useRef({});
  // Tracks chatIds whose local "clear" cleanup is currently in-flight.
  // Prevents the REST success path and the `chat:cleared:*` socket echo from
  // racing on the same SQLite writes (which surfaces as "database is locked").
  const clearInFlightRef = useRef(new Set());
  // Track tempIds of recently sent messages for dedup against sync responses
  const sentTempIdsRef = useRef(new Set());
  // Track message IDs that were created by forwarding — persists across chat navigations
  const forwardedMsgIdsRef = useRef(new Set());
  const cancelledMsgIdsRef = useRef(new Set());
  const groupScheduleTimersRef = useRef(new Map()); // tempId → timer for client-side group scheduling
  const pendingPreviewSyncRef = useRef(false);
  // Cache reply data by messageId — never lost even if SQLite row is overwritten
  const replyDataCacheRef = useRef({});
  // Track pending reply/quote tempIds for response mapping (server doesn't echo tempId)
  const pendingReplyTempIdRef = useRef(null);
  const localSaveTimeoutRef = useRef(null);
  const socketHandlerRegistryRef = useRef(new Map());

  // State
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [messages, setMessages] = useState([]);
  const [allMessages, setAllMessages] = useState([]);
  const [scheduledMessages, setScheduledMessages] = useState([]);
  const [selectedMessage, setSelectedMessages] = useState([]);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [chatId, setChatId] = useState(null);
  const [isLoadingInitial, setIsLoadingInitial] = useState(true);
  const [userStatus, setUserStatus] = useState("");
  const [lastSeen, setLastSeen] = useState(null);
  const [customStatus, setCustomStatus] = useState("");
  const [presenceDetails, setPresenceDetails] = useState(null);
  const [manualPresencePending, setManualPresencePending] = useState(false);
  
  // FIXED: Separate typing states for local user and peer
  const [isPeerTyping, setIsPeerTyping] = useState(false); // Peer is typing
  const [isLocalTyping, setIsLocalTyping] = useState(false); // Local user is typing
  
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMoreMessages, setHasMoreMessages] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // True ONLY while an older-history page is being fetched from the server
  // (network), never during local SQLite reads — drives the top-of-list spinner.
  const [isBackfilling, setIsBackfilling] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isManualReloading, setIsManualReloading] = useState(false);
  const [isLoadingFromLocal, setIsLoadingFromLocal] = useState(true);
  const [hasLoadedFromAPI, setHasLoadedFromAPI] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [currentSearchIndex, setCurrentSearchIndex] = useState(-1);
  const [showMediaOptions, setShowMediaOptions] = useState(false);
  const [downloadedMedia, setDownloadedMedia] = useState({});
  const [mediaViewer, setMediaViewer] = useState({ visible: false, uri: null, type: null });
  const [pendingMedia, setPendingMedia] = useState(null);
  const [downloadProgress, setDownloadProgress] = useState({});
  const [uploadProgress, setUploadProgress] = useState({});
  const [mediaDownloadStates, setMediaDownloadStates] = useState({});
  const [isChatMuted, setIsChatMuted] = useState(Boolean(item?.isMuted));
  const [muteUntil, setMuteUntil] = useState(item?.muteUntil || null);
  const [editingMessage, setEditingMessage] = useState(null);
  const [replyTarget, setReplyTarget] = useState(null);

  const buildMediaStatusQueueStorageKey = useCallback(
    () => `${MEDIA_STATUS_QUEUE_KEY}_${currentUserIdRef.current || 'anon'}`,
    []
  );

  const buildMediaUploadQueueStorageKey = useCallback(
    () => `${MEDIA_UPLOAD_QUEUE_KEY}_${currentUserIdRef.current || 'anon'}`,
    []
  );

  const buildMediaStatusEventKey = useCallback((chatIdValue, messageIdValue) => {
    const normalizedChatId = normalizeId(chatIdValue);
    const normalizedMessageId = normalizeId(messageIdValue);
    if (!normalizedChatId || !normalizedMessageId) return null;
    return `${normalizedChatId}:${normalizedMessageId}:downloaded`;
  }, []);

  const getOrCreateDeviceId = useCallback(async () => {
    try {
      const existing = await AsyncStorage.getItem('deviceId');
      if (existing && String(existing).trim()) {
        return String(existing);
      }
      const generated = `device_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
      await AsyncStorage.setItem('deviceId', generated);
      return generated;
    } catch (error) {
      console.error('getOrCreateDeviceId error', error);
      return `device_fallback_${Date.now()}`;
    }
  }, []);

  const validateMediaMessagePayload = useCallback((messagePayload = {}) => {
    const missing = [];
    if (!messagePayload?.mediaId) missing.push('mediaId');
    if (!messagePayload?.mediaUrl) missing.push('mediaUrl');
    if (!messagePayload?.mediaThumbnailUrl) missing.push('mediaThumbnailUrl');
    if (!messagePayload?.mediaMeta || typeof messagePayload.mediaMeta !== 'object') {
      missing.push('mediaMeta');
    }
    return {
      isValid: missing.length === 0,
      missing,
    };
  }, []);

  const createMediaMessagePayload = useCallback(({
    uploadResponse,
    file,
    messageType,
    senderId,
    senderDeviceId,
    receiverId,
    chatId,
    messageId,
  }) => {
    const uploadData = uploadResponse?.data || uploadResponse || {};
    const normalizedMessageType = normalizeOutboundMessageType(
      uploadData?.fileCategory || messageType || file?.type || 'file'
    );
    const generatedMessageId = String(
      messageId ||
      uploadData?.messageId ||
      uploadData?._id?.$oid ||
      uploadData?._id ||
      generateClientMessageId()
    );
    const resolvedFileName = file?.name || extractFileName(file?.uri || uploadData?.previewUrl || uploadData?.thumbnailUrl);
    const resolvedMimeType = file?.type || uploadData?.mimeType || `application/${normalizedMessageType}`;
    const mediaId = resolveUploadMediaId(uploadData) || generatedMessageId;

    const isGrpPayload = chatData?.chatType === 'group' || chatData?.isGroup;
    return {
      chatId,
      chatType: chatData?.chatType || 'private',
      ...(isGrpPayload && { groupId: chatData?.groupId || chatData?.group?._id || chatId }),
      messageId: generatedMessageId,
      senderId,
      senderDeviceId,
      receiverId: isGrpPayload ? null : receiverId,
      messageType: normalizedMessageType,
      mediaId,
      mediaUrl: uploadData?.previewUrl || uploadData?.mediaUrl || '',
      mediaThumbnailUrl: uploadData?.thumbnailUrl || uploadData?.previewUrl || '',
      mediaMeta: {
        fileName: resolvedFileName,
        fileSize: uploadData?.sizeAfter || file?.size || null,
        mimeType: resolvedMimeType,
        width: uploadData?.width || null,
        height: uploadData?.height || null,
      },
      status: 'sent',
      text: file?.name || '',
      createdAt: uploadData?.createdAt || new Date().toISOString(),
    };
  }, [normalizeOutboundMessageType]);

  const persistMediaStatusQueue = useCallback(async (queueItems) => {
    try {
      await AsyncStorage.setItem(buildMediaStatusQueueStorageKey(), JSON.stringify(queueItems || []));
    } catch (error) {
      console.error('persistMediaStatusQueue error', error);
    }
  }, [buildMediaStatusQueueStorageKey]);

  const loadQueuedMediaStatusUpdates = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(buildMediaStatusQueueStorageKey());
      const parsed = raw ? JSON.parse(raw) : [];
      const queue = Array.isArray(parsed) ? parsed : [];
      queuedMediaStatusRef.current = queue;
      queue.forEach((item) => {
        const key = buildMediaStatusEventKey(item?.chatId, item?.messageId);
        if (key && item?.isMediaDownloaded === true) {
          mediaStatusProcessedRef.current.add(key);
        }
      });
    } catch (error) {
      console.error('loadQueuedMediaStatusUpdates error', error);
      queuedMediaStatusRef.current = [];
    }
  }, [buildMediaStatusQueueStorageKey, buildMediaStatusEventKey]);

  const persistMediaUploadQueue = useCallback(async (queueItems) => {
    try {
      await AsyncStorage.setItem(buildMediaUploadQueueStorageKey(), JSON.stringify(queueItems || []));
    } catch (error) {
      console.error('persistMediaUploadQueue error', error);
    }
  }, [buildMediaUploadQueueStorageKey]);

  const loadQueuedMediaUploads = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(buildMediaUploadQueueStorageKey());
      const parsed = raw ? JSON.parse(raw) : [];
      queuedMediaUploadsRef.current = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error('loadQueuedMediaUploads error', error);
      queuedMediaUploadsRef.current = [];
    }
  }, [buildMediaUploadQueueStorageKey]);

  const persistMessagesForChatImmediate = useCallback(async (chatIdValue, nextMessages) => {
    try {
      const normalizedChatId = normalizeId(chatIdValue || chatIdRef.current);
      if (!normalizedChatId) return;
      const rows = Array.isArray(nextMessages) ? nextMessages : [];
      if (rows.length > 0) {
        await ChatDatabase.saveMessages(rows.map(m => ({ ...m, chatId: m.chatId || normalizedChatId })));
      }
    } catch (error) {
      console.error('persistMessagesForChatImmediate error', error);
    }
  }, []);

  const applyMediaDownloadedStateLocally = useCallback(async ({ messageId, chatId: targetChatId, isMediaDownloaded = true, localUri = null }) => {
    const normalizedMessageId = normalizeId(messageId);
    if (!normalizedMessageId) return;

    const applyPatch = (msg) => {
      const msgId = normalizeId(msg?.serverMessageId || msg?.id || msg?.tempId || msg?.mediaId);
      if (!sameId(msgId, normalizedMessageId)) return msg;
      if (msg?.isDeleted || isDeletedForUser(msg?.deletedFor, currentUserIdRef.current) || msg?.type === 'system') {
        return msg;
      }

      const nextPayload = normalizeMessagePayloadWithDownloadFlag(
        msg.type || msg.mediaType || msg.messageType,
        { ...(msg.payload || {}), isMediaDownloaded: Boolean(isMediaDownloaded) }
      );

      return {
        ...msg,
        localUri: localUri || msg.localUri || null,
        payload: nextPayload,
        isMediaDownloaded: Boolean(nextPayload?.isMediaDownloaded || localUri || msg?.localUri),
        downloadStatus: Boolean(isMediaDownloaded)
          ? MEDIA_DOWNLOAD_STATUS.DOWNLOADED
          : (msg?.downloadStatus || MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED),
      };
    };

    setMessages((prev) => prev.map(applyPatch));

    let cachedUpdated = null;
    setAllMessages((prev) => {
      const updated = prev.map(applyPatch);
      cachedUpdated = updated;
      return updated;
    });

    if (cachedUpdated) {
      await persistMessagesForChatImmediate(targetChatId || chatIdRef.current, cachedUpdated);
    }
  }, [persistMessagesForChatImmediate]);

  const markMediaRemovedLocally = useCallback(async (mediaIds = []) => {
    const normalizedIds = Array.isArray(mediaIds)
      ? mediaIds.map(normalizeId).filter(Boolean)
      : [];

    if (normalizedIds.length === 0) return;

    const idSet = new Set(normalizedIds);
    const matchesMedia = (msg = {}) => {
      const candidates = [
        normalizeId(msg?.mediaId),
        normalizeId(msg?.serverMessageId),
        normalizeId(msg?.id),
        normalizeId(msg?.tempId),
      ].filter(Boolean);
      return candidates.some((candidate) => idSet.has(candidate));
    };

    const applyPatch = (msg = {}) => {
      if (!matchesMedia(msg)) return msg;
      const nextPayload = normalizeMessagePayloadWithDownloadFlag(
        msg.type || msg.mediaType || msg.messageType,
        { ...(msg.payload || {}), isMediaDownloaded: false }
      );

      return {
        ...msg,
        localUri: null,
        payload: nextPayload,
        isMediaDownloaded: false,
        downloadStatus: MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED,
      };
    };

    setDownloadedMedia((prev) => {
      const next = { ...prev };
      normalizedIds.forEach((id) => {
        delete next[id];
      });
      return next;
    });

    setMediaDownloadStates((prev) => {
      const next = { ...prev };
      normalizedIds.forEach((id) => {
        next[id] = {
          ...(next[id] || { mediaId: id }),
          status: MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED,
          progress: 0,
          localPath: null,
          error: null,
          updatedAt: Date.now(),
        };
      });
      return next;
    });

    setMessages((prev) => prev.map(applyPatch));

    let cachedUpdated = null;
    setAllMessages((prev) => {
      const updated = prev.map(applyPatch);
      cachedUpdated = updated;
      return updated;
    });

    if (cachedUpdated) {
      await persistMessagesForChatImmediate(chatIdRef.current, cachedUpdated);
    }
  }, [persistMessagesForChatImmediate]);

  useEffect(() => {
    let mounted = true;

    const bootstrap = async () => {
      try {
        await mediaDownloadManager.rehydrate();
        const cachedMap = await mediaDownloadManager.getCachedMediaMap();
        if (!mounted) return;

        const nextDownloaded = {};
        const nextStates = {};

        Object.entries(cachedMap || {}).forEach(([mediaId, row]) => {
          if (!mediaId) return;
          if (row?.localPath) {
            nextDownloaded[String(mediaId)] = row.localPath;
          }
          nextStates[String(mediaId)] = {
            mediaId: String(mediaId),
            status: row?.downloadStatus || MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED,
            progress: row?.downloadStatus === MEDIA_DOWNLOAD_STATUS.DOWNLOADED ? 100 : 0,
            localPath: row?.localPath || null,
            error: null,
          };
        });

        setDownloadedMedia((prev) => ({ ...prev, ...nextDownloaded }));
        setMediaDownloadStates((prev) => ({ ...prev, ...nextStates }));
      } catch (error) {
        console.warn('media download bootstrap failed', error);
      }
    };

    bootstrap().catch(() => {});

    const unsubscribe = mediaDownloadManager.subscribe((event) => {
      if (!mounted || !event?.mediaId) return;

      const mediaId = String(event.mediaId);
      const state = event?.state || {};
      const stateStatus = String(state?.status || '').toUpperCase();

      setMediaDownloadStates((prev) => ({
        ...prev,
        [mediaId]: {
          ...(prev[mediaId] || { mediaId, status: MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED, progress: 0 }),
          status: stateStatus || MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED,
          progress: Number(state?.progress || 0),
          localPath: state?.localPath || null,
          error: state?.error || null,
          updatedAt: Date.now(),
        },
      }));

      if (stateStatus === MEDIA_DOWNLOAD_STATUS.DOWNLOADING) {
        setDownloadProgress((prev) => ({
          ...prev,
          [mediaId]: Math.max(0, Math.min(1, Number(state?.progress || 0) / 100)),
        }));
      }

      if (stateStatus === MEDIA_DOWNLOAD_STATUS.DOWNLOADED && state?.localPath) {
        setDownloadedMedia((prev) => ({ ...prev, [mediaId]: state.localPath }));
        setDownloadProgress((prev) => {
          const copy = { ...prev };
          delete copy[mediaId];
          return copy;
        });
      }

      if (stateStatus === MEDIA_DOWNLOAD_STATUS.FAILED) {
        setDownloadProgress((prev) => {
          const copy = { ...prev };
          delete copy[mediaId];
          return copy;
        });
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  // Color helper
  const pastelColors = [
    "#833AB4", "#1DB954", "#128C7E", "#075E54", "#777737",
    "#F56040", "#34B7F1", "#25D366", "#FF5A5F", "#3A3A3A",
    "#FF0000", "#00A699",
  ];
  const getUserColor = useCallback((str) => {
    if (!str) return pastelColors[0];
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % pastelColors.length;
    return pastelColors[index];
  }, []);

  // Keep refs in sync
  useEffect(() => {
    chatIdRef.current = chatId;
    currentUserIdRef.current = currentUserId;
  }, [chatId, currentUserId]);

  // Keep allMessagesRef in sync for stale-closure-safe reads
  useEffect(() => {
    allMessagesRef.current = allMessages;
  }, [allMessages]);

  // Keep scheduledMessagesRef in sync for stale-closure-safe reads
  const scheduledMessagesRef = useRef([]);
  useEffect(() => {
    scheduledMessagesRef.current = scheduledMessages;
  }, [scheduledMessages]);

  // Build group members name lookup map from route item members or Redux currentGroup.
  // Display-name priority (per product spec): device contact name > backend name >
  // mobile number. The device contact name is resolved purely client-side from the
  // local contacts SQLite table (ContactDatabase) — contacts never leave the device.
  useEffect(() => {
    if (!isGroupChat) return;
    // Prefer currentGroup.members (from viewGroup API - has populated user objects with fullName)
    // over chatData.members (from chat list - may have unpopulated userId strings)
    const membersList = (currentGroup?.members?.length > 0 ? currentGroup.members : null)
      || chatData.members;
    if (!membersList || !Array.isArray(membersList) || membersList.length === 0) return;

    let cancelled = false;

    (async () => {
      const map = {};
      membersList.forEach((m) => {
        const u = (typeof m.userId === 'object' && m.userId !== null) ? m.userId : {};
        const id = u._id || (typeof m.userId === 'string' ? m.userId : null) || m._id || m.id;
        if (id) {
          const serverName = u.fullName || m.fullName || m.name || m.username || '';
          const mobileNumber = u.mobileNumber || u.phoneNumber || u.phone || m.mobileNumber || null;
          map[String(id)] = {
            // `fullName` is the resolved display name; device contact name is
            // overlaid below. `serverName` keeps the backend name as fallback.
            fullName: serverName || mobileNumber || '',
            serverName,
            profileImage: u.profileImage || m.profileImage || null,
            mobileNumber,
            role: m.role || 'member',
          };
        }
      });
      if (Object.keys(map).length === 0) return;

      // Overlay device/saved contact names (single bulk read — O(contacts), no
      // per-member DB hits, safe for large groups). Device name wins over backend.
      // Match each member against the registered contact list by user id first,
      // then by the phone-number HASH (the canonical join — works even when the
      // saved contact row has no user_id), then by normalized phone digits.
      try {
        const contacts = await ContactDatabase.loadRegisteredContacts();
        if (!cancelled && Array.isArray(contacts)) {
          const byUserId = {};
          const byHash = {};
          const byPhone = {};
          for (const c of contacts) {
            const nm = (c?.fullName || '').trim();
            if (!nm) continue;
            if (c.userId) byUserId[String(c.userId)] = nm;
            if (c.hash) byHash[String(c.hash).toLowerCase()] = nm;
            const p = onlyDigits(c.normalizedPhone || c.phone || c.number);
            if (p) byPhone[p] = nm;
          }
          Object.keys(map).forEach((id) => {
            let saved = byUserId[id];
            const mobile = map[id].mobileNumber;
            if (!saved && mobile) {
              const h = hashPhoneForMatch(mobile);
              if (h) saved = byHash[h];
              if (!saved) saved = byPhone[onlyDigits(mobile)];
            }
            if (saved) map[id].fullName = saved;
          });
        }
      } catch (_) { /* contacts optional — fall back to backend names */ }

      if (cancelled) return;
      groupMembersMapRef.current = map;

      // Patch existing messages so device-resolved names take effect immediately.
      // Override (not just fill) so a device contact name replaces a stale backend name.
      setAllMessages((prev) => {
        let changed = false;
        const patched = prev.map((msg) => {
          let updates = null;

          if (msg.senderId) {
            const resolved = map[String(msg.senderId)]?.fullName;
            if (resolved && resolved !== msg.senderName) {
              updates = { ...updates, senderName: resolved };
            }
          }

          if (msg.replyToMessageId && msg.replySenderId) {
            if (sameId(msg.replySenderId, currentUserIdRef.current)) {
              const youName = currentUserNameRef.current || 'You';
              if (msg.replySenderName !== youName) updates = { ...updates, replySenderName: youName };
            } else {
              const resolvedReply = map[String(msg.replySenderId)]?.fullName;
              if (resolvedReply && resolvedReply !== msg.replySenderName) {
                updates = { ...updates, replySenderName: resolvedReply };
              }
            }
          }

          if (updates) {
            changed = true;
            return { ...msg, ...updates };
          }
          return msg;
        });
        return changed ? patched : prev;
      });
    })();

    return () => { cancelled = true; };
  }, [isGroupChat, chatData.members, currentGroup?.members]);

  // Keyboard listeners
  useEffect(() => {
    const showSub = Keyboard.addListener("keyboardDidShow", (e) => setKeyboardHeight(e.endCoordinates.height));
    const hideSub = Keyboard.addListener("keyboardDidHide", () => setKeyboardHeight(0));
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (peerTypingTimeoutRef.current) clearTimeout(peerTypingTimeoutRef.current);
      if (readMarkTimeoutRef.current) clearTimeout(readMarkTimeoutRef.current);
      if (visibilityReadTimeoutRef.current) clearTimeout(visibilityReadTimeoutRef.current);
      if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
      if (backgroundAwayTimeoutRef.current) clearTimeout(backgroundAwayTimeoutRef.current);
      if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
      if (localSaveTimeoutRef.current) {
        clearTimeout(localSaveTimeoutRef.current);
        localSaveTimeoutRef.current = null;
      }
    };
  }, []);

  // Focus effect: ensure socket reconnect on focus
  useEffect(() => {
    hasSyncedRef.current = false;
    isComponentMounted.current = true;
    reconnectAttempts.current = 0;
    initialLoadDoneRef.current = false;
    checkAndReconnectSocket();
    return () => {
      isComponentMounted.current = false;
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (peerTypingTimeoutRef.current) clearTimeout(peerTypingTimeoutRef.current);
      if (readMarkTimeoutRef.current) clearTimeout(readMarkTimeoutRef.current);
      if (visibilityReadTimeoutRef.current) clearTimeout(visibilityReadTimeoutRef.current);
      if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
      if (backgroundAwayTimeoutRef.current) clearTimeout(backgroundAwayTimeoutRef.current);
      if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Watch network connectivity
  useEffect(() => {
    if (isConnected) {
      reconnectAttempts.current = 0;
      checkAndReconnectSocket();
      if (queuedManualPresenceRef.current.length > 0) {
        flushQueuedManualPresence();
      }
      if (queuedMediaStatusRef.current.length > 0) {
        flushQueuedMediaStatusUpdates();
      }
      if (queuedMediaUploadsRef.current.length > 0) {
        flushQueuedMediaUploadsRef.current();
      }
    } else {
      setUserStatus("offline");
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    }
  }, [isConnected, checkAndReconnectSocket]);

  useEffect(() => {
    if (isConnected && isSocketConnected()) {
      emitPresenceActivity({ reason: "network-switch", metadata: { networkType } });
    }
  }, [networkType, isConnected]);

  // App state changes
  useEffect(() => {
    const appStateSubscription = AppState.addEventListener("change", nextAppState => {
      if (appState.current.match(/inactive|background/) && nextAppState === "active") {
        reconnectAttempts.current = 0;
        checkAndReconnectSocket();
        emitPresenceActivity({ reason: "app-foreground" });
        startHeartbeat();
        resetIdleTimer();
        if (backgroundAwayTimeoutRef.current) {
          clearTimeout(backgroundAwayTimeoutRef.current);
          backgroundAwayTimeoutRef.current = null;
        }

        const socket = socketRef.current || getSocket();
        if (socket && isSocketConnected()) {
          socket.emit("app:state", {
            state: "foreground",
            userId: currentUserIdRef.current,
            chatId: chatIdRef.current,
            networkType,
          });
        }

        requestUserPresence();
        if (chatIdRef.current) {
          fetchAndSyncMessagesViaSocket(chatIdRef.current, { limit: SOCKET_FETCH_LIMIT });
        }
        hasSyncedRef.current = false;
      } else if (nextAppState.match(/inactive|background/)) {
        if (!hasSyncedRef.current && chatIdRef.current) {
          syncMessagesToAPI();
          hasSyncedRef.current = true;
        }
        // FIXED: Use isLocalTyping state
        if (isLocalTyping) {
          sendTypingStatus(false);
          setIsLocalTyping(false);
        }

        stopHeartbeat();
        if (idleTimeoutRef.current) {
          clearTimeout(idleTimeoutRef.current);
          idleTimeoutRef.current = null;
        }

        const socket = socketRef.current || getSocket();
        if (socket && isSocketConnected()) {
          socket.emit("app:state", {
            state: "background",
            userId: currentUserIdRef.current,
            chatId: chatIdRef.current,
            networkType,
          });
        }

        if (backgroundAwayTimeoutRef.current) {
          clearTimeout(backgroundAwayTimeoutRef.current);
        }

        backgroundAwayTimeoutRef.current = setTimeout(() => {
          if (!isConnected || appState.current === "active") return;
          updatePresenceStatus(PRESENCE_STATUS.AWAY, { reason: "background-timeout" });
        }, PRESENCE_BACKGROUND_AWAY_DELAY);

        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
      }
      appState.current = nextAppState;
    });
    return () => { appStateSubscription.remove(); };
  }, [isLocalTyping, checkAndReconnectSocket, isConnected, networkType]);

  // Periodic socket check
  useEffect(() => {
    socketCheckInterval.current = setInterval(() => {
      if (isComponentMounted.current && appState.current === 'active') {
        const socket = getSocket();
        if (!socket || !isSocketConnected()) {
          checkAndReconnectSocket();
        } else {
          reconnectAttempts.current = 0;
        }
      }
    }, PRESENCE_HEARTBEAT_INTERVAL);
    return () => { if (socketCheckInterval.current) clearInterval(socketCheckInterval.current); };
  }, [checkAndReconnectSocket]);

  // Filter messages by current chat ID — always immediate for real-time feel
  // Merges scheduledMessages (sender-only) with chatMessages for display
  // Uses shallow comparison to skip setMessages when nothing actually changed
  const lastMessagesFingerprintRef = useRef('');
  useEffect(() => {
    if (!chatId || (allMessages.length === 0 && scheduledMessages.length === 0)) {
      if (messages.length > 0) setMessages([]);
      return;
    }

    const isGrpFilter = chatData.chatType === 'group' || chatData.isGroup;
    const peerId = normalizeId(chatData.peerUser?._id);
    const myId = normalizeId(currentUserId);
    const normalizedChatId = normalizeId(chatId);
    const normalizedGroupId = normalizeId(chatData.groupId);

    const matchesChat = (msg) => {
      if (msg.chatId && sameId(msg.chatId, normalizedChatId)) return true;
      if (isGrpFilter && msg.groupId && (sameId(msg.groupId, normalizedChatId) || sameId(msg.groupId, normalizedGroupId))) return true;
      if (!peerId || !myId) return false;
      return (
        (sameId(msg.receiverId, myId) && sameId(msg.senderId, peerId)) ||
        (sameId(msg.senderId, myId) && sameId(msg.receiverId, peerId))
      );
    };

    const filteredChat = allMessages.filter(msg => {
      if (!matchesChat(msg)) return false;
      if ((msg.status === 'cancelled' || msg.status === 'failed') && !sameId(msg.senderId, myId)) return false;
      return true;
    });
    const filteredScheduled = scheduledMessages.filter(matchesChat);
    const combined = [...filteredScheduled, ...filteredChat];
    const sorted = combined.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    // Dedup by ID, plus a content fingerprint that ONLY suppresses
    // (a) optimistic-temp ↔ server twins (the pre-ack duplicate flash) and
    // (b) EXACT-same-timestamp twins — the same server message stored under
    // two id forms (uuid messageId vs Mongo _id) shares the identical ms.
    // Two server-confirmed messages may legitimately repeat the same short
    // text from the same sender within seconds ("ok", "hi", "?") — broad
    // fingerprinting those silently dropped real messages from history.
    const seenIds = new Set();
    const fpMap = new Map(); // fp → { tempish, ts } of the row that claimed it
    const isTempish = (m) => !m.serverMessageId
      && (Boolean(m.tempId) || String(m.id || '').startsWith('temp_'));
    const deduped = sorted.filter(msg => {
      const ids = [normalizeId(msg.serverMessageId), normalizeId(msg.id), normalizeId(msg.tempId)].filter(Boolean);
      if (ids.some(id => seenIds.has(id))) return false;
      if (msg.senderId && msg.text != null) {
        const roundedTs = Math.round((msg.timestamp || 0) / 30000);
        const fp = `${normalizeId(msg.senderId)}|${msg.text}|${roundedTs}`;
        const fpPrev = `${normalizeId(msg.senderId)}|${msg.text}|${roundedTs - 1}`;
        const fpNext = `${normalizeId(msg.senderId)}|${msg.text}|${roundedTs + 1}`;
        const clash = fpMap.get(fp) || fpMap.get(fpPrev) || fpMap.get(fpNext);
        const tempish = isTempish(msg);
        if (clash && (tempish || clash.tempish || clash.ts === Number(msg.timestamp || 0))) return false;
        if (!fpMap.has(fp)) fpMap.set(fp, { tempish, ts: Number(msg.timestamp || 0) });
      }
      for (const id of ids) seenIds.add(id);
      return true;
    });

    // Skip setMessages if content hasn't actually changed — prevents unnecessary FlatList reconciliation
    const fingerprint = deduped.map(m =>
      `${m.serverMessageId || m.id || m.tempId}:${m.status}:${m.isEdited ? 1 : 0}:${m.isDeleted ? 1 : 0}:${m.reactions ? Object.keys(m.reactions).join(',') : ''}`
    ).join('|');
    if (fingerprint === lastMessagesFingerprintRef.current) return;
    lastMessagesFingerprintRef.current = fingerprint;

    setMessages(deduped);
  }, [chatId, allMessages, scheduledMessages, chatData.peerUser?._id, currentUserId]);

  useEffect(() => {
    if (!chatIdRef.current || !currentUserIdRef.current || allMessages.length === 0) return;
    if (appState.current !== 'active') return;
    scheduleMarkVisibleUnreadAsRead();
  }, [allMessages, scheduleMarkVisibleUnreadAsRead]);

  // Initialize chat on mount or when peer user / group changes
  const isGroupInit = chatData.chatType === 'group' || chatData.isGroup || Boolean(chatData.group);
  const isBroadcastInit = chatData.chatType === 'broadcast' || Boolean(chatData.isBroadcast);
  useEffect(() => {
    if (chatData.peerUser || isGroupInit || isBroadcastInit) {
      console.log('🔄 Initializing chat:', isBroadcastInit ? `broadcast:${chatData.chatId}` : isGroupInit ? `group:${chatData.groupId || chatData.chatId}` : `user:${chatData.peerUser?._id}`);
      
      setMessages([]);
      setAllMessages([]);
      setCurrentPage(1);
      setHasMoreMessages(true);
      setHasLoadedFromAPI(false);
      setSearchResults([]);
      setCurrentSearchIndex(-1);
      setIsSearching(false);
      setIsPeerTyping(false); // Reset typing state
      setIsLocalTyping(false);
      initialLoadDoneRef.current = false;
      
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
      if (peerTypingTimeoutRef.current) {
        clearTimeout(peerTypingTimeoutRef.current);
        peerTypingTimeoutRef.current = null;
      }
      if (presenceCheckInterval.current) {
        clearInterval(presenceCheckInterval.current);
        presenceCheckInterval.current = null;
      }
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current);
        idleTimeoutRef.current = null;
      }
      if (backgroundAwayTimeoutRef.current) {
        clearTimeout(backgroundAwayTimeoutRef.current);
        backgroundAwayTimeoutRef.current = null;
      }
      stopHeartbeat();
      
      if (socketRef.current) {
        removeSocketListeners(socketRef.current);
      }
      
      initializeChat();
    } else {
      setIsLoadingInitial(false);
      setIsLoadingFromLocal(false);
    }

    return () => {
      console.log('🧹 Cleaning up chat for user:', chatData.peerUser?._id);

      const unreadOnExit = allMessages
        .filter(msg =>
          msg.chatId === chatIdRef.current &&
          msg.senderId &&
          msg.senderId !== currentUserIdRef.current &&
          msg.status !== 'seen'
        )
        .map(msg => msg.serverMessageId || msg.id || msg.tempId)
        .filter(Boolean);

      if (unreadOnExit.length > 0) {
        markMessagesAsRead(unreadOnExit);
      }

      deferRealtimeUpdate(() => setActiveChat(null));
      
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
      if (peerTypingTimeoutRef.current) {
        clearTimeout(peerTypingTimeoutRef.current);
        peerTypingTimeoutRef.current = null;
      }
      if (presenceCheckInterval.current) {
        clearInterval(presenceCheckInterval.current);
        presenceCheckInterval.current = null;
      }
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current);
        idleTimeoutRef.current = null;
      }
      if (backgroundAwayTimeoutRef.current) {
        clearTimeout(backgroundAwayTimeoutRef.current);
        backgroundAwayTimeoutRef.current = null;
      }
      stopHeartbeat();
      
      const socket = getSocket();
      if (socket && isSocketConnected() && currentUserIdRef.current && chatIdRef.current) {
        socket.emit('user:status', { 
          userId: currentUserIdRef.current, 
          status: 'offline', 
          chatId: chatIdRef.current 
        });
      }
      
      if (socketRef.current) {
        removeSocketListeners(socketRef.current);
      }

      // Clear any group schedule timers
      for (const timer of groupScheduleTimersRef.current.values()) {
        clearTimeout(timer);
      }
      groupScheduleTimersRef.current.clear();

      initialLoadDoneRef.current = false;
      pendingInitialFetchRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatData.peerUser?._id, isGroupInit && chatData.chatId, isBroadcastInit && chatData.chatId]);

  /* ========== Socket connection & reconnection logic ========== */
  const checkAndReconnectSocket = useCallback(async () => {
    if (reconnectTimeoutRef.current) return;
    const socket = getSocket();
    if (!socket || !isSocketConnected()) {
      // We never block the user with a "Connection Error" dialog. The socket is
      // expected to drop on a screen-off suspend or a Wi-Fi/data toggle, so we
      // just keep retrying quietly until the host is reachable again. Past the
      // fast-retry budget we pin the counter (so the backoff stays capped at
      // MAX_RECONNECT_BACKOFF_MS) and keep going instead of giving up. NetInfo
      // and AppState-foreground also reset the counter to re-kick the fast loop.
      const exhaustedFastRetries = reconnectAttempts.current >= MAX_RECONNECT_ATTEMPTS;
      if (!exhaustedFastRetries) {
        reconnectAttempts.current += 1;
      }
      try {
        await reconnectSocket(navigation);
        const backoffDelay = exhaustedFastRetries
          ? MAX_RECONNECT_BACKOFF_MS
          : Math.min(1000 * Math.pow(2, reconnectAttempts.current - 1), 10000);
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = null;
          const newSocket = getSocket();
          if (newSocket && isSocketConnected()) {
            socketRef.current = newSocket;
            reconnectAttempts.current = 0;
            if (chatIdRef.current && currentUserIdRef.current) {
              setupSocketListeners(newSocket, chatIdRef.current);
              newSocket.emit('chat:join', { chatId: chatIdRef.current, userId: currentUserIdRef.current }, (response) => {});
              newSocket.emit('user:status', { userId: currentUserIdRef.current, status: 'online', chatId: chatIdRef.current });
              markUserOnline("socket-reconnect");
              startHeartbeat();
              flushQueuedManualPresence();
              flushQueuedMediaStatusUpdates();
              requestUserPresence();
              // Listeners were registered AFTER `connect` fired on this socket,
              // so the onConnect fetch never ran on this path. Settle any owed
              // cold-start full fetch (or a cheap delta) explicitly.
              if (pendingInitialFetchRef.current) {
                const emitted = fetchAndSyncMessagesViaSocket(chatIdRef.current, { limit: SOCKET_FETCH_LIMIT });
                if (emitted) {
                  pendingInitialFetchRef.current = false;
                  _lastChatSyncAt.set(chatIdRef.current, Date.now());
                }
              } else {
                fetchAndSyncMessagesViaSocket(chatIdRef.current, { limit: SOCKET_FETCH_LIMIT, syncOnly: true });
              }
            }
          } else {
            if (isComponentMounted.current) checkAndReconnectSocket();
          }
        }, backoffDelay);
      } catch (error) {
        reconnectTimeoutRef.current = null;
        if (isComponentMounted.current) {
          const retryDelay = Math.min(2000 * Math.pow(2, reconnectAttempts.current - 1), 15000);
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null;
            checkAndReconnectSocket();
          }, retryDelay);
        }
      }
    } else {
      socketRef.current = socket;
      reconnectAttempts.current = 0;
    }
  }, [navigation]);

  /* ========== Chat initialization ========== */
  const initializeChat = async () => {
    if (initialLoadDoneRef.current) {
      console.log('⏭️ Skipping initialization - already done');
      return;
    }
    
    try {
      // Read the logged-in user from the module cache (synchronous after the
      // first open) instead of hitting AsyncStorage on every chat open — that
      // read sat on the first-paint critical path before any messages rendered.
      const user = await getCachedUserInfo();
      if (!user) {
        setIsLoadingInitial(false);
        setIsLoadingFromLocal(false);
        return;
      }
      const userId = user._id || user.id;
      const userName = user.fullName || user.name || user.username || '';
      setCurrentUserId(userId);
      currentUserIdRef.current = userId;
      currentUserNameRef.current = userName;

      const isGrpInit = chatData.chatType === 'group' || chatData.isGroup;
      const generatedChatId = chatData.chatId || routeChatId || (isGrpInit
        ? (chatData.groupId || chatData.group?._id || `grp_${Date.now()}`)
        : buildPrivateChatId(userId, chatData.peerUser?._id || 'unknown'));
      if (lastInitializedChatRef.current && lastInitializedChatRef.current === generatedChatId) {
        setIsLoadingInitial(false);
        setIsLoadingFromLocal(false);
        initialLoadDoneRef.current = true;
        return;
      }
      const isSameChat = lastInitializedChatRef.current === generatedChatId;
      setChatId(generatedChatId);
      chatIdRef.current = generatedChatId;
      deferRealtimeUpdate(() => {
        setActiveChat(generatedChatId);
        markChatRead(generatedChatId);
      });
      lastInitializedChatRef.current = generatedChatId;

      // Build group members map from route item data (no API call needed)
      if (isGrpInit && Array.isArray(chatData.members) && chatData.members.length > 0) {
        const map = {};
        chatData.members.forEach((m) => {
          const u = (typeof m.userId === 'object' && m.userId !== null) ? m.userId : {};
          const id = u._id || (typeof m.userId === 'string' ? m.userId : null) || m._id || m.id;
          if (id) {
            map[String(id)] = {
              fullName: u.fullName || m.fullName || m.name || m.username || '',
              profileImage: u.profileImage || m.profileImage || null,
              role: m.role || 'member',
            };
          }
        });
        groupMembersMapRef.current = map;
      }

      // ═══════════════════════════════════════════════════════════
      // STEP 1: INSTANT RENDER — Load messages from cache/SQLite FIRST
      // This MUST happen before any awaits so the screen renders immediately
      // ═══════════════════════════════════════════════════════════
      // Tell the post-login background message-warm to back off for a moment so
      // its BEGIN EXCLUSIVE writes don't block this chat's SQLite read. Keeps
      // chat-open instant even mid-warm; auto-expires so warming resumes after.
      pauseBackgroundSyncFor(1500);

      if (!isSameChat) {
        // New chat → start with a small fast first page; the window grows again
        // as the user scrolls up in this chat.
        loadedLimitRef.current = INITIAL_PAGE_SIZE;
        // Try memory cache first (synchronous — zero delay)
        const cached = ChatCache.hasMessages(generatedChatId)
          ? ChatCache.getMessages(generatedChatId)
          : [];

        if (cached.length > 0) {
          setAllMessages(cached);
          // The cache may already hold a grown window from a prior visit; keep
          // the floor at least that big so the first refresh doesn't shrink it.
          loadedLimitRef.current = Math.max(INITIAL_PAGE_SIZE, cached.length);
          allMessagesRef.current = cached;
          setIsLoadingInitial(false);
          setIsLoadingFromLocal(false);
        } else {
          // Cache miss — clear old messages and let SQLite load below
          setMessages([]);
          setAllMessages([]);
        }
        setScheduledMessages([]);
      } else {
        // Same chat — already have messages, just clear loading
        setIsLoadingInitial(false);
        setIsLoadingFromLocal(false);
      }

      // ═══════════════════════════════════════════════════════════
      // STEP 2: BACKGROUND — Load from SQLite for full data (non-blocking)
      // This enriches the cache data with reply previews, sender names, etc.
      // ═══════════════════════════════════════════════════════════
      const localLoadPromise = isSameChat
        ? Promise.resolve(allMessages.length)
        : loadMessagesFromLocal(generatedChatId);

      // Clear the loading state the moment local messages are ready — do NOT
      // wait for the socket reconnect/join below. On a slow or reconnecting
      // socket, `checkAndReconnectSocket()` in the parallel block can take
      // several seconds; gating the spinner on it (the old behavior) made an
      // already-cached chat appear to "load" for 15s. Messages render from
      // SQLite immediately; live sync catches up in the background.
      localLoadPromise
        .then(() => {
          setIsLoadingInitial(false);
          setIsLoadingFromLocal(false);
        })
        .catch(() => {
          setIsLoadingInitial(false);
          setIsLoadingFromLocal(false);
        });

      // ═══════════════════════════════════════════════════════════
      // STEP 3: BACKGROUND — Socket setup + queued tasks (parallel with step 2)
      // ═══════════════════════════════════════════════════════════
      // Fetch full group details (fire-and-forget, updates members map when done)
      if (isGrpInit) {
        const grpId = chatData.groupId || chatData.group?._id;
        if (grpId) dispatch(viewGroup({ groupId: grpId })).catch(() => {});
      }

      // Run all queued tasks + socket setup in parallel with SQLite load
      const [localCount] = await Promise.all([
        localLoadPromise,
        (async () => {
          await Promise.all([
            loadQueuedManualPresence(),
            loadQueuedMediaStatusUpdates(),
            loadQueuedMediaUploads(),
            loadDeletedTombstones(generatedChatId),
            loadPendingEdits(generatedChatId),
          ]);
          await checkAndReconnectSocket();
          const socket = getSocket();
          // Register listeners on the socket OBJECT even while it is still
          // connecting (cold start): socket.io queues `.on` handlers, and the
          // `connect` handler is the ONLY thing that re-fetches this chat once
          // the connection comes up. Gating registration on isSocketConnected()
          // left the first open with no listeners at all — the socket connected
          // 1-2s later, nothing fetched, and the screen stayed empty until the
          // user backed out and reopened.
          if (socket) {
            socketRef.current = socket;
            setupSocketListeners(socket, generatedChatId);
          }
          if (socket && isSocketConnected()) {
            requestUserPresence();
            socket.emit('user:status', { userId, status: 'online', chatId: generatedChatId });
            socket.emit('chat:join', { chatId: generatedChatId, userId }, (response) => {});
            // Group chat IDs are raw ObjectIds; the private `message:read:all`
            // handler validates membership via `u_a_b` parsing and rejects
            // group ids with NOT_IN_CHAT. Route groups to the group handler.
            // Throttled: setActiveChat also emits read:all on open; collapse the
            // duplicate so the backend isn't hit with two read:all per open.
            if (shouldEmitReadAll(generatedChatId)) {
              if (isGrpInit) {
                socket.emit('group:message:read:all', { groupId: generatedChatId });
              } else {
                socket.emit('message:read:all', { chatId: generatedChatId, senderId: userId });
              }
            }
            markUserOnline("chat-init");
            startHeartbeat();
            resetIdleTimer();
            flushQueuedManualPresence();
            flushQueuedMediaStatusUpdates();
            flushQueuedMediaUploadsRef.current();
            presenceCheckInterval.current = setInterval(() => {
              if (isSocketConnected()) requestUserPresence();
              else checkAndReconnectSocket();
            }, PRESENCE_POLL_INTERVAL);
          } else {
            setUserStatus("offline");
          }
        })(),
      ]);

      // ═══════════════════════════════════════════════════════════
      // STEP 4: BACKGROUND SYNC — fetch only new messages from server
      // ═══════════════════════════════════════════════════════════
      const SYNC_THROTTLE_MS = 15000;
      const nowTs = Date.now();
      const lastSyncTs = _lastChatSyncAt.get(generatedChatId) || 0;
      if (localCount === 0) {
        // No local data → must do the one full fetch regardless of throttle.
        cslog('🌐 SQLite empty for this chat → FULL fetch over SOCKET (message:sync/fetch)', {
          chatId: generatedChatId,
        });
        const emitted = fetchAndSyncMessagesViaSocket(generatedChatId, { limit: SOCKET_FETCH_LIMIT });
        if (emitted) {
          _lastChatSyncAt.set(generatedChatId, nowTs);
        } else {
          // Socket still connecting (cold start): the fetch never left the
          // device. Leave the throttle UNARMED (so a quick reopen retries) and
          // flag the owed full fetch for the `connect` handler to fire.
          pendingInitialFetchRef.current = true;
        }
      } else if (nowTs - lastSyncTs > SYNC_THROTTLE_MS) {
        // Has local data → cheap forward delta (seq cursor; never re-downloads
        // stored rows), but only if we haven't just synced this chat.
        cslog('🔄 SQLite had messages → DELTA sync only over SOCKET (fills gaps, not a reload)', {
          chatId: generatedChatId,
          sqliteRecordCount: localCount,
        });
        const emitted = fetchAndSyncMessagesViaSocket(generatedChatId, { limit: SOCKET_FETCH_LIMIT, syncOnly: true });
        if (emitted) _lastChatSyncAt.set(generatedChatId, nowTs);
      } else {
        // Re-opened within the throttle window → skip the server request entirely.
        // SQLite already rendered; the live socket keeps this chat fresh while open.
        cslog('⏭️ Skipped on-open delta sync (synced recently) — local-first, no server hit', {
          chatId: generatedChatId,
          msSinceLastSync: nowTs - lastSyncTs,
        });
      }
      scheduleMarkVisibleUnreadAsRead();

      if (route?.params?.openedFromForward) {
        setTimeout(() => {
          fetchAndSyncMessagesViaSocket(generatedChatId, { limit: SOCKET_FETCH_LIMIT });
        }, 400);
      }

      setIsLoadingInitial(false);
      setIsLoadingFromLocal(false);
      initialLoadDoneRef.current = true;
    } catch (error) {
      console.error("initializeChat error", error);
      setIsLoadingInitial(false);
      setIsLoadingFromLocal(false);
    }
  };

  /* ========== Local storage helpers ========== */
  const loadMessagesFromLocal = async (chatIdParam) => {
    try {
      if (!chatIdParam) return 0;

      // INSTANT: If memory cache has messages, render immediately
      if (ChatCache.hasMessages(chatIdParam)) {
        const cached = ChatCache.getMessages(chatIdParam);
        if (cached.length > 0) {
          setAllMessages(cached);
        }
      }

      // Paint whatever SQLite already has, immediately — the user waits on this.
      refreshMessagesFromDB(true);

      // Restore PREVIOUS messages that exist only in the AsyncStorage backup
      // (the legacy/pre-SQLite per-chat store, or history SQLite somehow lost)
      // back INTO SQLite. Two fixes vs. the old migration: (1) it ran ONLY when
      // SQLite was completely empty (count===0), so once any row existed the
      // older backed-up messages were never reloaded — now it restores whenever
      // the backup holds MORE than SQLite; (2) it did one bulk upsert that held
      // the writer lock — now it writes in small AWAITED BATCHES with a yield
      // between, in the BACKGROUND, so it never blocks the first paint nor
      // contends with live writers. Idempotent + monotonic upsert dedups against
      // rows already present, so re-running is always safe.
      (async () => {
        try {
          const localKey = getChatMessagesKey(chatIdParam);
          if (!localKey) return;
          const saved = await AsyncStorage.getItem(localKey);
          if (!saved) return;
          let parsed = null;
          try { parsed = JSON.parse(saved); } catch { return; }
          if (!Array.isArray(parsed) || parsed.length === 0) return;

          const sqliteCount = await ChatDatabase.getMessageCount(chatIdParam);
          if (sqliteCount >= parsed.length) return; // nothing missing to restore

          // Newest-first so the most recent history lands (and paints) first.
          const rows = parsed
            .map((m) => ({ ...m, chatId: m.chatId || chatIdParam }))
            .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));

          const CHUNK = 25;
          for (let i = 0; i < rows.length; i += CHUNK) {
            await SqliteWriter.enqueue('upsertMessages', rows.slice(i, i + CHUNK));
            await new Promise((r) => setTimeout(r, 0)); // yield → live writers interleave
            // Surface the newest batch quickly; full reconcile happens at the end.
            if (i === 0 && chatIdRef.current === chatIdParam) refreshMessagesFromDB(true);
          }
          if (chatIdRef.current === chatIdParam) refreshMessagesFromDB(true);
        } catch (e) {
          console.warn('[restorePreviousMessages] failed:', e?.message);
        }
      })();

      const finalCount = await ChatDatabase.getMessageCount(chatIdParam);
      cslog('📂 MESSAGES rendered from SQLite', {
        chatId: chatIdParam,
        sqliteRecordCount: finalCount,
        memoryCacheHit: ChatCache.hasMessages(chatIdParam),
        source: 'SQLite (on-device DB) — NOT a REST API call',
      });

      // Heavy duplicate cleanup (4 full GROUP BY/correlated-subquery DELETEs)
      // is MAINTENANCE — it must not block the first render. The displayed list
      // is already correct: loadMessages does a lightweight temp-row sweep + an
      // in-memory dedup. Run the deep dedup AFTER render, off the critical path,
      // then refresh once more to drop anything it removed. Previously this was
      // awaited BEFORE render on every chat open — a major cause of the multi-
      // second open delay, made worse by SQLite write-lock contention.
      ChatDatabase.deduplicateChat(chatIdParam)
        .then(() => { refreshMessagesFromDB(true); })
        .catch(() => {});

      return finalCount;
    } catch (err) {
      console.error("Error loading from local storage:", err);
      return 0;
    }
  };

  const normalizeMessageStatus = useCallback((status) => {
    const s = (status || '').toString().toLowerCase();
    if (s === 'read') return 'seen';
    if (s === 'seen') return 'seen';
    if (s === 'delivered') return 'delivered';
    if (s === 'sent') return 'sent';
    if (s === 'uploaded') return 'uploaded';
    if (s === 'sending') return 'sending';
    if (s === 'failed') return 'failed';
    if (s === 'scheduled') return 'scheduled';
    if (s === 'processing') return 'processing';
    if (s === 'cancelled') return 'cancelled';
    return undefined;
  }, []);

  const getMessageStatusPriority = useCallback((status) => {
    const normalized = normalizeMessageStatus(status) || status;
    if (normalized === 'seen') return 5;
    if (normalized === 'delivered') return 4;
    if (normalized === 'sent') return 3;
    if (normalized === 'uploaded') return 2;
    if (normalized === 'sending') return 1;
    if (normalized === 'failed') return 0;
    return 0;
  }, [normalizeMessageStatus]);

  const deletedKeyForChat = useCallback((chatIdParam) => `${DELETED_TOMBSTONES_PREFIX}${chatIdParam}`, []);

  const persistDeletedTombstones = useCallback(async () => {
    try {
      if (!chatIdRef.current) return;
      await AsyncStorage.setItem(
        deletedKeyForChat(chatIdRef.current),
        JSON.stringify(deletedTombstonesRef.current || {})
      );
    } catch (error) {
      console.error('persistDeletedTombstones error', error);
    }
  }, [deletedKeyForChat]);

  const loadDeletedTombstones = useCallback(async (chatIdParam) => {
    try {
      if (!chatIdParam) return;
      const raw = await AsyncStorage.getItem(deletedKeyForChat(chatIdParam));
      const parsed = raw ? JSON.parse(raw) : {};
      deletedTombstonesRef.current = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      deletedTombstonesRef.current = {};
      console.error('loadDeletedTombstones error', error);
    }
  }, [deletedKeyForChat]);

  const registerDeletedTombstone = useCallback(async (messageId, meta = {}) => {
    const normalizedId = normalizeId(messageId);
    if (!normalizedId) return;
    deletedTombstonesRef.current = {
      ...(deletedTombstonesRef.current || {}),
      [normalizedId]: {
        deletedFor: 'everyone',
        deletedBy: normalizeId(meta?.deletedBy) || null,
        placeholderText: meta?.placeholderText || null,
        updatedAt: Date.now(),
      },
    };
    await persistDeletedTombstones();
  }, [persistDeletedTombstones]);

  const removeDeletedTombstone = useCallback(async (messageId) => {
    const normalizedId = normalizeId(messageId);
    if (!normalizedId || !deletedTombstonesRef.current?.[normalizedId]) return;
    const next = { ...(deletedTombstonesRef.current || {}) };
    delete next[normalizedId];
    deletedTombstonesRef.current = next;
    await persistDeletedTombstones();
  }, [persistDeletedTombstones]);

  // ─── PENDING EDITS (out-of-order edit arrival) ───
  const pendingEditsKeyForChat = useCallback((chatIdParam) => `${PENDING_EDITS_PREFIX}${chatIdParam}`, []);

  const persistPendingEdits = useCallback(async () => {
    try {
      if (!chatIdRef.current) return;
      await AsyncStorage.setItem(
        pendingEditsKeyForChat(chatIdRef.current),
        JSON.stringify(pendingEditsRef.current || {})
      );
    } catch {}
  }, [pendingEditsKeyForChat]);

  const loadPendingEdits = useCallback(async (chatIdParam) => {
    try {
      if (!chatIdParam) return;
      const raw = await AsyncStorage.getItem(pendingEditsKeyForChat(chatIdParam));
      const parsed = raw ? JSON.parse(raw) : {};
      pendingEditsRef.current = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      pendingEditsRef.current = {};
    }
  }, [pendingEditsKeyForChat]);

  const registerPendingEdit = useCallback(async (messageId, text, editedAt) => {
    const normalizedId = normalizeId(messageId);
    if (!normalizedId || !text) return;
    pendingEditsRef.current = {
      ...(pendingEditsRef.current || {}),
      [normalizedId]: { text, editedAt: editedAt || new Date().toISOString() },
    };
    await persistPendingEdits();
  }, [persistPendingEdits]);

  const removePendingEdit = useCallback(async (messageId) => {
    const normalizedId = normalizeId(messageId);
    if (!normalizedId || !pendingEditsRef.current?.[normalizedId]) return;
    const next = { ...(pendingEditsRef.current || {}) };
    delete next[normalizedId];
    pendingEditsRef.current = next;
    await persistPendingEdits();
  }, [persistPendingEdits]);

  // ─── MUTATION CURSOR (reconnect mutation delta — edits/deletes) ───
  const getMutationCursor = useCallback(async (chatIdParam) => {
    try {
      if (!chatIdParam) return 0;
      const raw = await AsyncStorage.getItem(`${MUTATION_CURSOR_PREFIX}${chatIdParam}`);
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }, []);

  const setMutationCursor = useCallback(async (chatIdParam, at) => {
    try {
      const n = Number(at);
      if (!chatIdParam || !Number.isFinite(n) || n <= 0) return;
      const prev = await getMutationCursor(chatIdParam);
      if (n <= prev) return; // monotonic — never move the cursor backwards
      await AsyncStorage.setItem(`${MUTATION_CURSOR_PREFIX}${chatIdParam}`, String(n));
    } catch {}
  }, [getMutationCursor]);

  const normalizeIncomingMessage = useCallback((apiMsg) => {
    const mediaMeta = apiMsg?.mediaMeta || apiMsg?.contact || apiMsg?.payload?.mediaMeta || apiMsg?.payload?.contact || {};
    // Canonical id MUST prefer the UUID `messageId` over the Mongo `_id` —
    // the realtime path (normalizeMessagePayload) keys rows by messageId, so
    // preferring `_id` here gave the SAME message two different SQLite ids
    // (one from the live event, one from sync/REST/history) → duplicate
    // bubbles that no dedupe rule could bridge.
    const serverId = normalizeId(apiMsg?.messageId || apiMsg?._id || apiMsg?.id);
    const normalizedMediaId = normalizeId(
      apiMsg?.mediaId ||
      mediaMeta?.mediaId ||
      apiMsg?.serverMessageId ||
      apiMsg?._id ||
      apiMsg?.messageId ||
      apiMsg?.id
    );
    const createdAtRaw = apiMsg?.createdAt || apiMsg?.timestamp || new Date().toISOString();
    const createdAt = typeof createdAtRaw === 'number' ? new Date(createdAtRaw).toISOString() : createdAtRaw;

    const normalizedSenderId = normalizeId(apiMsg?.senderId);
    const normalizedReceiverId = normalizeId(apiMsg?.receiverId);
    const normalizedCurrentUser = normalizeId(currentUserIdRef.current);
    const normalizedServerId = normalizeId(serverId);
    const tombstone = normalizedServerId ? deletedTombstonesRef.current?.[normalizedServerId] : null;
    const resolvedDeletedFor = apiMsg?.deletedFor ?? apiMsg?.deleteFor ?? apiMsg?.delete_type ?? null;
    const resolvedIsDeleted = apiMsg?.isDeleted === true || isDeletedForUser(resolvedDeletedFor, normalizedCurrentUser) || Boolean(tombstone);
    const resolvedDeletedBy = normalizeId(apiMsg?.deletedBy) || normalizeId(tombstone?.deletedBy) || null;
    const isDeletedBySelf = sameId(resolvedDeletedBy, normalizedCurrentUser);
    const resolvedPlaceholderText = apiMsg?.placeholderText || tombstone?.placeholderText || buildDeletePlaceholderText(isDeletedBySelf);

    // OUT-OF-ORDER edit: an edit that arrived before this message is applied here
    // on arrival. Only override when NOT deleted (a delete wins over an edit).
    const pendingEdit = (!resolvedIsDeleted && normalizedServerId)
      ? pendingEditsRef.current?.[normalizedServerId]
      : null;

    const incomingRawType = String(apiMsg?.messageType || apiMsg?.fileCategory || apiMsg?.type || '').toLowerCase();
    const incomingCategory = String(apiMsg?.fileCategory || mediaMeta?.fileCategory || '').toLowerCase();
    const hasMediaHints = Boolean(
      apiMsg?.mediaUrl ||
      apiMsg?.mediaThumbnailUrl ||
      apiMsg?.url ||
      apiMsg?.previewUrl ||
      apiMsg?.thumbnailUrl ||
      apiMsg?.payload?.mediaUrl ||
      apiMsg?.payload?.mediaThumbnailUrl ||
      apiMsg?.payload?.previewUrl ||
      apiMsg?.payload?.thumbnailUrl ||
      apiMsg?.payload?.file?.uri ||
      apiMsg?.payload?.file?.url ||
      apiMsg?.payload?.file?.previewUrl ||
      apiMsg?.payload?.file?.thumbnailUrl ||
      apiMsg?.payload?.fileName ||
      apiMsg?.mimeType
    );
    const resolvedMessageType = incomingRawType === 'media'
      ? (incomingCategory || 'file')
      : (isMediaMessageType(incomingRawType)
        ? incomingRawType
        : (ENUM_MESSAGE_TYPES.has(incomingRawType)
          ? incomingRawType
          : (hasMediaHints ? 'file' : 'text')));
    const payloadFile = apiMsg?.payload?.file || {};
    const resolvedMediaUrl =
      apiMsg?.mediaUrl ||
      apiMsg?.payload?.mediaUrl ||
      apiMsg?.previewUrl ||
      apiMsg?.payload?.previewUrl ||
      apiMsg?.url ||
      payloadFile?.url ||
      payloadFile?.uri ||
      null;
    const resolvedMediaThumbnailUrl =
      apiMsg?.mediaThumbnailUrl ||
      apiMsg?.payload?.mediaThumbnailUrl ||
      apiMsg?.thumbnailUrl ||
      apiMsg?.payload?.thumbnailUrl ||
      payloadFile?.thumbnailUrl ||
      payloadFile?.previewUrl ||
      apiMsg?.previewUrl ||
      apiMsg?.payload?.previewUrl ||
      resolvedMediaUrl;
    const incomingLocalUri = apiMsg?.localUri || apiMsg?.payload?.localUri || apiMsg?.payload?.file?.uri || null;
    const basePayload = apiMsg?.payload || {};
    // Ensure contact data is preserved in payload
    if (resolvedMessageType === 'contact' && !basePayload.contact && apiMsg?.contact) {
      basePayload.contact = apiMsg.contact;
    }
    // Call entries carry render details in `callDetails` over the wire (REST /
    // sync) or already in `payload` (realtime). Normalize both into the payload
    // shape CallMessageBubble reads (kind/media/outcome/durationSec). Direction
    // is derived per-viewer from senderType, so it is intentionally NOT stored.
    if (resolvedMessageType === 'call') {
      const cd = apiMsg?.callDetails || {};
      basePayload.kind = 'call';
      basePayload.media = (basePayload.media || cd.media) === 'video' ? 'video' : 'audio';
      basePayload.outcome = basePayload.outcome || cd.outcome || 'completed';
      basePayload.durationSec = Math.max(0, Number(basePayload.durationSec ?? cd.durationSec) || 0);
    }
    const normalizedPayload = normalizeMessagePayloadWithDownloadFlag(
      resolvedMessageType,
      {
        ...basePayload,
        isMediaDownloaded: Boolean(
          apiMsg?.payload?.isMediaDownloaded ||
          apiMsg?.isMediaDownloaded ||
          incomingLocalUri
        ),
      }
    );

    // Preserve the original tempId if present — it's the link to the optimistic message
    const originalTempId = normalizeId(apiMsg?.tempId || apiMsg?.payload?.tempId);

    // Extract reply object from multiple possible locations
    const replyObj = (apiMsg?.replyTo && typeof apiMsg.replyTo === 'object' ? apiMsg.replyTo : null)
      || (apiMsg?.quotedMessage && typeof apiMsg.quotedMessage === 'object' ? apiMsg.quotedMessage : null)
      || (apiMsg?.reply && typeof apiMsg.reply === 'object' ? apiMsg.reply : null)
      || (normalizedPayload?.replyTo && typeof normalizedPayload.replyTo === 'object' ? normalizedPayload.replyTo : null)
      || null;

    return {
      id: serverId,
      serverMessageId: serverId,
      tempId: originalTempId || serverId,
      // Cross-transport idempotency key — lets the SQLite upsert reconcile
      // this row against one stored under a different id form (uuid vs _id)
      // or against the optimistic outbox row.
      clientMessageId: normalizeId(apiMsg?.clientMessageId || apiMsg?.clientId) || null,
      // Alternate id form for the upsert's dedupe bridge (see
      // cleanBeforeUpsert rule 0) — rows persisted under the Mongo _id by
      // older normalizers get replaced instead of duplicated.
      mongoId: normalizeId(apiMsg?._id) || null,
      mediaId: normalizedMediaId,
      type: resolvedMessageType,
      mediaType: apiMsg?.fileCategory || (isMediaMessageType(resolvedMessageType) ? resolvedMessageType : null),
      text: pendingEdit ? pendingEdit.text : (apiMsg?.text || apiMsg?.content || ""),
      time: moment(createdAt).format("hh:mm A"),
      date: moment(createdAt).format("YYYY-MM-DD"),
      senderId: normalizedSenderId,
      senderType: computeSenderType(normalizedSenderId, normalizedCurrentUser),
      receiverId: normalizedReceiverId,
      status: sameId(normalizedSenderId, normalizedCurrentUser)
        ? (normalizeMessageStatus(apiMsg?.status) || "sent")
        : normalizeMessageStatus(apiMsg?.status),
      mediaUrl: resolvedMediaUrl,
      mediaThumbnailUrl: resolvedMediaThumbnailUrl,
      previewUrl: incomingLocalUri || resolvedMediaThumbnailUrl || resolvedMediaUrl,
      // Album fields — N attachments in one bubble (WhatsApp media group)
      mediaGroupId: apiMsg?.mediaGroupId || apiMsg?.payload?.mediaGroupId || null,
      mediaItems: Array.isArray(apiMsg?.mediaItems) && apiMsg.mediaItems.length
        ? apiMsg.mediaItems
        : (Array.isArray(apiMsg?.payload?.mediaItems) && apiMsg.payload.mediaItems.length
          ? apiMsg.payload.mediaItems
          : null),
      createdAt,
      timestamp: new Date(createdAt).getTime(),
      // Server-allocated monotonic per-chat sequence. MUST be preserved so the
      // SQLite cursor (MAX(seq)) advances for live + synced messages alike —
      // otherwise the next delta/catchup re-requests already-stored rows.
      seq: (apiMsg?.seq != null && !Number.isNaN(Number(apiMsg?.seq))) ? Number(apiMsg.seq) : null,
      synced: true,
      chatId: apiMsg?.chatId || chatIdRef.current,
      groupId: apiMsg?.groupId || null,
      // Prefer the device-contact-resolved group member name over the backend name.
      senderName: groupMembersMapRef.current?.[normalizedSenderId]?.fullName || apiMsg?.senderName || apiMsg?.sender?.fullName || apiMsg?.sender?.name || null,
      localUri: incomingLocalUri,
      payload: normalizedPayload,
      mediaMeta,
      isMediaDownloaded: Boolean(normalizedPayload?.isMediaDownloaded || incomingLocalUri),
      downloadStatus: Boolean(normalizedPayload?.isMediaDownloaded || incomingLocalUri)
        ? MEDIA_DOWNLOAD_STATUS.DOWNLOADED
        : MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED,
      reactions: sanitizeReactions(apiMsg?.reactions),
      isEdited: Boolean(apiMsg?.isEdited || apiMsg?.editedAt || apiMsg?.is_edited || pendingEdit),
      editedAt: (pendingEdit ? pendingEdit.editedAt : null) || apiMsg?.editedAt || apiMsg?.edited_at || null,
      isForwarded: Boolean(apiMsg?.isForwarded || apiMsg?.is_forwarded || apiMsg?.forwarded || apiMsg?.forwardedFrom || apiMsg?.forwarded_from || apiMsg?.forwardedMessage || apiMsg?.isForwardedMessage),
      forwardedFrom: apiMsg?.forwardedFrom || apiMsg?.forwarded_from || apiMsg?.originalMessageId || apiMsg?.forwardedMessageId || null,
      isDeleted: resolvedIsDeleted,
      deletedFor: resolvedDeletedFor,
      deletedBy: resolvedDeletedBy,
      placeholderText: resolvedIsDeleted ? resolvedPlaceholderText : null,
      // Reply/Quote fields — support both local field names and server field names
      // Handle replyTo being an object (server populates it) vs a plain ID string
      // Check top-level, payload, and multiple server naming conventions
      // `apiMsg.replyPreview` is the SCHEMA snapshot the server persists (1-1
      // reply + group send/reply now store it) — raw Mongo docs from sync /
      // history / catch-up carry the preview ONLY there, so without these
      // fallbacks a refetched reply rendered as "Unknown / Message".
      replyToMessageId: apiMsg?.replyToMessageId || apiMsg?.quotedMessageId || apiMsg?.reply_to_message_id
        || normalizedPayload?.replyToMessageId || normalizedPayload?._replyToMessageId
        || (replyObj ? (replyObj._id || replyObj.id || replyObj.messageId) : null)
        || apiMsg?.replyPreview?.messageId
        || (typeof apiMsg?.replyTo === 'string' ? apiMsg.replyTo : null)
        || null,
      replyPreviewText: apiMsg?.replyPreviewText || apiMsg?.quotedText || apiMsg?.reply_preview_text
        || normalizedPayload?.replyPreviewText || normalizedPayload?._replyPreviewText
        || replyObj?.text || replyObj?.content || replyObj?.message
        || apiMsg?.replyPreview?.text
        || null,
      replyPreviewType: apiMsg?.replyPreviewType || apiMsg?.reply_preview_type
        || normalizedPayload?.replyPreviewType || normalizedPayload?._replyPreviewType
        || replyObj?.messageType || replyObj?.type
        || apiMsg?.replyPreview?.messageType
        || null,
      replySenderName: apiMsg?.replySenderName || apiMsg?.quotedSender || apiMsg?.reply_sender_name
        || normalizedPayload?.replySenderName || normalizedPayload?._replySenderName
        || replyObj?.senderName || replyObj?.sender?.fullName || replyObj?.sender?.name
        || apiMsg?.replyPreview?.senderName
        || null,
      replySenderId: apiMsg?.replySenderId || apiMsg?.reply_sender_id
        || normalizedPayload?.replySenderId || normalizedPayload?._replySenderId
        || replyObj?.senderId || replyObj?.sender?._id || (typeof replyObj?.sender === 'string' ? replyObj.sender : null)
        || (apiMsg?.replyPreview?.senderId != null ? String(apiMsg.replyPreview.senderId) : null)
        || null,
      // Status reply / share — preserve both the id reference and the preview snapshot
      // so the chat bubble can render the preview pill and link back to the StatusViewer.
      statusRef: apiMsg?.statusRef
        || apiMsg?.statusRefId
        || normalizedPayload?.statusRef
        || (apiMsg?.statusPreview && (apiMsg.statusPreview.statusId || apiMsg.statusPreview._id))
        || (normalizedPayload?.statusPreview && (normalizedPayload.statusPreview.statusId || normalizedPayload.statusPreview._id))
        || null,
      statusPreview: apiMsg?.statusPreview
        || normalizedPayload?.statusPreview
        || null,
    };
  }, [normalizeMessageStatus]);

  const mergeMessagesIntoState = useCallback(async (incomingMessages = []) => {
    if (!Array.isArray(incomingMessages) || incomingMessages.length === 0) return;

    // Filter out pending scheduled messages — they belong in scheduledMessages state, not allMessages
    // Also skip server versions of messages that are still pending in scheduledMessages
    // (server may return them with status 'sent' which would overwrite local 'scheduled' in DB)
    const pendingSchedIds = new Set();
    for (const sm of (scheduledMessagesRef.current || [])) {
      if (sm.status === 'scheduled' || sm.status === 'processing') {
        if (sm.id) pendingSchedIds.add(String(sm.id));
        if (sm.tempId) pendingSchedIds.add(String(sm.tempId));
        if (sm.serverMessageId) pendingSchedIds.add(String(sm.serverMessageId));
      }
    }

    const filtered = incomingMessages.filter(raw => {
      if (raw?.status === 'scheduled') return false;
      if (raw?.status === 'processing') return false;
      if (raw?.status === 'cancelled') return false;
      // Block isScheduled messages meant for receiver — only if scheduleTime is still in the future
      // If scheduleTime has passed, it's a legitimate delivery from the server
      const isSelf = raw?.senderId && sameId(raw.senderId, currentUserIdRef.current);
      const schedTime = raw?.scheduleTime || raw?.schedule_time;
      const st = schedTime ? new Date(schedTime).getTime() : 0;
      const isFuture = Number.isFinite(st) && st > Date.now() + 5000;
      if (!isSelf && raw?.isScheduled && isFuture) return false;
      // Strip schedule flags on receiver side for delivered scheduled messages
      if (!isSelf && raw?.isScheduled && !isFuture) {
        raw.isScheduled = false;
        raw.scheduleTime = null;
        raw.scheduleTimeLabel = null;
        raw.schedule_time = null;
      }
      // Block server echoes of our pending scheduled messages
      const rawId = raw?.messageId || raw?._id || raw?.id || raw?.serverMessageId;
      if (rawId && pendingSchedIds.has(String(rawId))) return false;
      // Block premature messages (scheduleTime in the future)
      return !isFuture;
    });

    // SQLite-first: normalize all incoming, batch write to SQLite, then refresh UI
    const normalized = filtered.map(raw => {
      const msg = normalizeIncomingMessage(raw);
      if (msg.senderId) {
        msg.senderType = computeSenderType(msg.senderId, currentUserIdRef.current);
      }
      msg.chatId = msg.chatId || chatIdRef.current;
      return msg;
    });

    await ChatDatabase.upsertMessages(normalized);
    refreshMessagesFromDB();
  }, [normalizeIncomingMessage, refreshMessagesFromDB]);

  const replaceMessagesForChat = useCallback(async (incomingMessages = [], targetChatId = null) => {
    const effectiveChatId = targetChatId || chatIdRef.current;
    if (!effectiveChatId) return;

    // Build set of pending scheduled message IDs to protect from overwrite
    const pendingSchedIds = new Set();
    for (const sm of (scheduledMessagesRef.current || [])) {
      if (sm.status === 'scheduled' || sm.status === 'processing') {
        if (sm.id) pendingSchedIds.add(String(sm.id));
        if (sm.tempId) pendingSchedIds.add(String(sm.tempId));
        if (sm.serverMessageId) pendingSchedIds.add(String(sm.serverMessageId));
      }
    }

    const normalizedIncoming = (Array.isArray(incomingMessages) ? incomingMessages : [])
      .filter(raw => {
        // Don't let server overwrite pending scheduled messages
        const rawId = raw?.messageId || raw?._id || raw?.id || raw?.serverMessageId;
        if (rawId && pendingSchedIds.has(String(rawId))) return false;
        if (raw?.status === 'scheduled') return false;
        if (raw?.status === 'processing') return false;
        if (raw?.status === 'cancelled') return false;
        // Block isScheduled messages on receiver side only if scheduleTime is still in the future
        const isSelf = raw?.senderId && sameId(raw.senderId, currentUserIdRef.current);
        if (!isSelf && raw?.isScheduled) {
          const schedTime = raw?.scheduleTime || raw?.schedule_time;
          const st = schedTime ? new Date(schedTime).getTime() : 0;
          if (Number.isFinite(st) && st > Date.now() + 5000) return false;
          // scheduleTime passed — strip schedule flags, allow through
          raw.isScheduled = false;
          raw.scheduleTime = null;
          raw.scheduleTimeLabel = null;
        }
        return true;
      })
      .map(raw => {
          const msg = normalizeIncomingMessage(raw);
          msg.chatId = msg.chatId || effectiveChatId;
          if (msg.senderId) msg.senderType = computeSenderType(msg.senderId, currentUserIdRef.current);
          return msg;
        });

    // SQLite-first: batch write then refresh
    await ChatDatabase.upsertMessages(normalizedIncoming);
    refreshMessagesFromDB(true);
  }, [normalizeIncomingMessage, refreshMessagesFromDB]);

  const markMessagesAsRead = useCallback((messageIds = []) => {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return;

    setAllMessages(prev => {
      const idSet = new Set(messageIds.map(String));
      let changed = false;
      const updated = prev.map(msg => {
        const id = msg.serverMessageId || msg.id || msg.tempId;
        if (!id || !idSet.has(String(id))) return msg;
        if (msg.status === 'seen' || msg.status === 'read') return msg;
        changed = true;
        return { ...msg, status: 'seen' };
      });
      if (changed) saveMessagesToLocal(updated);
      return changed ? updated : prev;
    });

    if (chatIdRef.current) {
      const targetChatId = chatIdRef.current;
      deferRealtimeUpdate(() => {
        if (targetChatId) {
          markChatRead(targetChatId);
        }
      });
    }
  }, [markChatRead, saveMessagesToLocal, deferRealtimeUpdate]);

  const markVisibleIncomingAsRead = useCallback((visibleMessageIds = []) => {
    if (!Array.isArray(visibleMessageIds) || visibleMessageIds.length === 0) return;

    if (visibilityReadTimeoutRef.current) {
      clearTimeout(visibilityReadTimeoutRef.current);
    }

    visibilityReadTimeoutRef.current = setTimeout(() => {
      // Use ref for latest messages to avoid stale closure
      const latestMessages = allMessagesRef.current || [];
      const unreadVisibleIds = latestMessages
        .filter(msg => {
          const id = msg.serverMessageId || msg.id || msg.tempId;
          if (!id || !visibleMessageIds.includes(id)) return false;
          if (msg.chatId !== chatIdRef.current) return false;
          if (!msg.senderId || msg.senderId === currentUserIdRef.current) return false;
          // Skip scheduled/processing/cancelled/failed — not real messages, don't emit read
          if (msg.status === 'scheduled' || msg.status === 'processing' || msg.status === 'cancelled' || msg.status === 'failed') return false;
          return msg.status !== 'seen' && msg.status !== 'read';
        })
        .map(msg => msg.serverMessageId || msg.id || msg.tempId)
        .filter(Boolean);

      if (unreadVisibleIds.length === 0) return;

      const socket = socketRef.current || getSocket();
      const isGrpRead = chatData?.chatType === 'group' || chatData?.isGroup;
      if (socket && isSocketConnected() && chatIdRef.current && currentUserIdRef.current) {
        if (isGrpRead) {
          socket.emit('group:message:read', {
            groupId: chatData?.groupId || chatData?.group?._id || chatIdRef.current,
            messageIds: unreadVisibleIds,
            userId: currentUserIdRef.current,
            readAt: new Date().toISOString(),
          });
        } else {
          // Emit individual read + seen for each message, plus bulk
          unreadVisibleIds.forEach(msgId => {
            socket.emit('message:read', {
              messageId: msgId,
              chatId: chatIdRef.current,
              senderId: currentUserIdRef.current,
              timestamp: Date.now(),
            });
            socket.emit('message:seen', {
              messageId: msgId,
              chatId: chatIdRef.current,
            });
          });
        }
      }

      // Update local state to 'seen'
      setAllMessages(prev => {
        const idSet = new Set(unreadVisibleIds);
        let changed = false;
        const updated = prev.map(msg => {
          const id = msg.serverMessageId || msg.id || msg.tempId;
          if (!id || !idSet.has(id)) return msg;
          if (msg.status === 'seen' || msg.status === 'read') return msg;
          changed = true;
          return { ...msg, status: 'seen' };
        });
        if (changed) saveMessagesToLocal(updated);
        return changed ? updated : prev;
      });

      if (chatIdRef.current) {
        deferRealtimeUpdate(() => markChatRead(chatIdRef.current));
      }
    }, 500);
  }, [saveMessagesToLocal, markChatRead, deferRealtimeUpdate, chatData]);

  const scheduleMarkVisibleUnreadAsRead = useCallback(() => {
    if (readMarkTimeoutRef.current) {
      clearTimeout(readMarkTimeoutRef.current);
    }

    readMarkTimeoutRef.current = setTimeout(() => {
      const latestMessages = allMessagesRef.current || [];
      const unreadIds = latestMessages
        .filter(msg =>
          (msg.chatId === chatIdRef.current) &&
          msg.senderId &&
          msg.senderId !== currentUserIdRef.current &&
          // Skip scheduled/processing/cancelled/failed — not real messages, don't emit read
          msg.status !== 'scheduled' && msg.status !== 'processing' && msg.status !== 'cancelled' && msg.status !== 'failed' &&
          msg.status !== 'seen' && msg.status !== 'read'
        )
        .map(msg => msg.serverMessageId || msg.id || msg.tempId)
        .filter(Boolean);

      if (unreadIds.length === 0) return;

      // Emit read events to server
      const socket = socketRef.current || getSocket();
      const isGrp = chatData?.chatType === 'group' || chatData?.isGroup;
      if (socket && isSocketConnected() && chatIdRef.current && currentUserIdRef.current) {
        if (isGrp) {
          socket.emit('group:message:read', {
            groupId: chatData?.groupId || chatData?.group?._id || chatIdRef.current,
            messageIds: unreadIds,
            userId: currentUserIdRef.current,
            readAt: new Date().toISOString(),
          });
        } else {
          socket.emit('message:read:bulk', {
            chatId: chatIdRef.current,
            messageIds: unreadIds,
            senderId: currentUserIdRef.current,
            timestamp: Date.now(),
          });
        }
      }

      markMessagesAsRead(unreadIds);
    }, READ_MARK_DELAY);
  }, [markMessagesAsRead, chatData]);

  const deduplicateMessages = useCallback((messagesArray) => {
    const uniqueMap = new Map();
    // Track tempId→serverMessageId links so temp and server versions merge
    const tempToServerMap = new Map();
    // Secondary index: content-based dedup for messages with same sender+text+time
    const contentKeyMap = new Map();

    messagesArray.forEach(msg => {
      // Build cross-reference: if a message has both tempId and serverMessageId, link them
      if (msg.tempId && msg.serverMessageId && msg.tempId !== msg.serverMessageId) {
        tempToServerMap.set(msg.tempId, msg.serverMessageId);
      }
    });

    const mergeInto = (key, msg) => {
      if (uniqueMap.has(key)) {
        const existing = uniqueMap.get(key);

        // Prefer the version with serverMessageId (server-confirmed)
        if (msg.serverMessageId && !existing.serverMessageId) {
          const merged = { ...msg };
          if (existing.localUri && !merged.localUri) merged.localUri = existing.localUri;
          if (existing.previewUrl && !merged.previewUrl) merged.previewUrl = existing.previewUrl;
          if (existing.time && !merged.time) merged.time = existing.time;
          if (existing.date && !merged.date) merged.date = existing.date;
          uniqueMap.set(key, merged);
          return;
        }

        // Prefer version with time/date
        if (msg.time && !existing.time) {
          uniqueMap.set(key, { ...existing, ...msg });
          return;
        }

        if (msg.localUri && !existing.localUri) {
          uniqueMap.set(key, msg);
          return;
        }

        if ((msg.timestamp || 0) > (existing.timestamp || 0)) {
          uniqueMap.set(key, msg);
          return;
        }
      } else {
        uniqueMap.set(key, msg);
      }
    };

    messagesArray.forEach(msg => {
      // Primary key: prefer serverMessageId, then check if tempId maps to a known serverMessageId
      let key =
        msg.serverMessageId ||
        (msg.tempId && tempToServerMap.get(msg.tempId)) ||
        msg.id ||
        msg.tempId ||
        msg.mediaId ||
        null;

      // Content-based fallback: match by sender + text + ~5s time window
      // Use 5-second buckets; check both current and adjacent bucket to handle boundaries
      const sender = normalizeId(msg?.senderId) || 'unknown';
      const rawTs = Number(msg?.timestamp || 0);
      const textSlice = (msg?.text || '').toString().trim().slice(0, 48);
      const bucketSize = 5000;
      const bucket = rawTs > 0 ? Math.floor(rawTs / bucketSize) : 0;
      const contentKeys = bucket > 0
        ? [`content_${sender}_${bucket}_${textSlice}`, `content_${sender}_${bucket - 1}_${textSlice}`, `content_${sender}_${bucket + 1}_${textSlice}`]
        : [];

      if (!key) {
        // No ID-based key — use content key or generate a truly unique one
        key = (contentKeys.length > 0 ? contentKeys[0] : null) || `fallback_${sender}_${Date.now()}_${Math.random()}`;
      }

      // Check if this message already exists under a different key via content matching
      let matchedExistingKey = null;
      for (const ck of contentKeys) {
        if (contentKeyMap.has(ck)) {
          const existingKey = contentKeyMap.get(ck);
          if (existingKey !== key && uniqueMap.has(existingKey)) {
            matchedExistingKey = existingKey;
            break;
          }
        }
      }
      if (matchedExistingKey) {
        mergeInto(matchedExistingKey, msg);
        return;
      }

      for (const ck of contentKeys) {
        contentKeyMap.set(ck, key);
      }

      mergeInto(key, msg);
    });

    return Array.from(uniqueMap.values());
  }, []);

  const refreshTimerRef = useRef(null);

  /**
   * CORE: Reload messages from SQLite → UI. This is the ONLY path to update displayed messages.
   * Debounced to collapse rapid writes (e.g., multiple socket events in quick succession).
   */
  const refreshMessagesFromDB = useCallback((immediate = false) => {
    const doRefresh = async () => {
      try {
        const cid = chatIdRef.current;
        if (!cid) return;
        // COLD-START FIX: never block the FIRST paint on the writer queue. On a
        // cold restart the SqliteWriter queue is loaded with the reconnect
        // catch-up write storm (plus history backfill), so awaiting a full drain
        // here — together with the inline cleanup WRITE inside loadMessages — was
        // the 5–7s blank chat screen. WAL readers never block on the writer, so
        // we read the already-persisted messages immediately and paint them;
        // messages still being written are additive (they arrived while the app
        // was killed) and land via the follow-up refresh each incoming write
        // triggers. Subsequent refreshes keep the drain so a just-landed realtime
        // upsert is included (the queue is shallow by then).
        const isFirstRender = !initialLoadDoneRef.current;
        if (!isFirstRender) {
          try { await SqliteWriter.awaitDrain(); } catch {}
        }
        const clearedAt = await ChatDatabase.getClearedAt(cid) || 0;
        // First paint reads one small screenful (INITIAL_PAGE_SIZE) for the
        // fastest possible render. Once the user has scrolled up and grown the
        // window, read AT LEAST that many rows so this re-read preserves the
        // loaded window instead of snapping back to page one — which is what
        // made the screen re-trigger pagination ("load again and again") on
        // every incoming message, receipt or reaction.
        const pageLimit = Math.max(
          INITIAL_PAGE_SIZE,
          loadedLimitRef.current || 0,
          allMessagesRef.current?.length || 0,
        );
        const dbMessages = await ChatDatabase.loadMessagesWithReplies(cid, {
          limit: pageLimit,
          afterTimestamp: clearedAt,
          // Always skip the inline temp-row cleanup WRITE on the read path — it
          // queues behind the cold-start storm and stalls the first paint. The
          // deferred deduplicateChat() in loadMessagesFromLocal performs the
          // equivalent (broader) maintenance after the screen is on-screen.
          skipCleanup: true,
        });

        const currentUser = currentUserIdRef.current;

        // Separate still-pending scheduled messages from DB — they go to scheduledMessages state
        // Only status==='scheduled' means pending. Delivered messages (status sent/delivered) go to allMessages.
        const isPendingScheduled = (m) => m.status === 'scheduled' || m.status === 'processing';
        // Cancelled/failed messages from OTHER users should never be shown to receiver
        const isOtherUserCancelledOrFailed = (m) =>
          (m.status === 'cancelled' || m.status === 'failed') && !sameId(m.senderId, currentUser);
        const dbScheduled = dbMessages.filter(isPendingScheduled);
        const otherCancelled = dbMessages.filter(isOtherUserCancelledOrFailed);
        const dbRegular = dbMessages.filter(m => !isPendingScheduled(m) && !isOtherUserCancelledOrFailed(m));

        // Clean up: delete cancelled messages from other users from DB so they don't come back
        if (otherCancelled.length > 0) {
          for (const m of otherCancelled) {
            const delId = m.serverMessageId || m.id || m.tempId;
            if (delId) SqliteWriter.enqueue('deleteMessageForMe', { messageId: delId }).catch(() => {});
          }
        }

        if (dbScheduled.length > 0) {
          const enrichedScheduled = dbScheduled
            .filter(m => sameId(m.senderId, currentUser)) // sender-only
            .map(m => ({ ...m, senderType: computeSenderType(m.senderId, currentUser) }));
          if (enrichedScheduled.length > 0) {
            setScheduledMessages(prev => {
              // Collect ALL known IDs from existing scheduled messages
              const existingIds = new Set();
              for (const p of prev) {
                if (p.id) existingIds.add(String(p.id));
                if (p.tempId) existingIds.add(String(p.tempId));
                if (p.serverMessageId) existingIds.add(String(p.serverMessageId));
              }
              const newOnes = enrichedScheduled.filter(m => {
                const ids = [m.id, m.tempId, m.serverMessageId].filter(Boolean).map(String);
                return !ids.some(id => existingIds.has(id));
              });
              return newOnes.length > 0 ? [...prev, ...newOnes] : prev;
            });
          }
        }

        // Batch-load reply data for messages that have replyToMessageId but missing preview
        const replyDataCache = {};
        const replyMsgKeys = dbRegular
          .filter(m => m.replyToMessageId && !m.replyPreviewText)
          .map(m => m.serverMessageId || m.id || m.tempId)
          .filter(Boolean);
        if (replyMsgKeys.length > 0) {
          for (const key of replyMsgKeys) {
            try {
              const rd = await ChatDatabase.getReplyData(key);
              if (rd) replyDataCache[key] = rd;
            } catch {}
          }
        }

        const enriched = dbRegular.map(msg => {
          let status = msg.status;
          if ((status === 'sending' || status === 'uploaded') && msg.serverMessageId && msg.synced) {
            status = 'sent';
          }

          // Resolve missing reply data from permanent reply table or group members
          let { replySenderName, replyPreviewText, replyPreviewType, replySenderId } = msg;
          if (msg.replyToMessageId) {
            // If reply preview text is missing, try the permanent reply table
            if (!replyPreviewText) {
              const msgKey = msg.serverMessageId || msg.id || msg.tempId;
              if (msgKey && replyDataCache[msgKey]) {
                const rd = replyDataCache[msgKey];
                replyPreviewText = rd.replyPreviewText || replyPreviewText;
                replyPreviewType = rd.replyPreviewType || replyPreviewType;
                replySenderId = rd.replySenderId || replySenderId;
                replySenderName = rd.replySenderName || replySenderName;
              }
            }
            // Resolve sender name from context
            if (!replySenderName && replySenderId) {
              if (sameId(replySenderId, currentUser)) {
                replySenderName = currentUserNameRef.current || 'You';
              } else if (chatData?.peerUser?.fullName && !isGroupChat) {
                replySenderName = chatData.peerUser.fullName;
              } else if (groupMembersMapRef.current?.[replySenderId]?.fullName) {
                replySenderName = groupMembersMapRef.current[replySenderId].fullName;
              }
            }
          }

          return {
            ...msg,
            status,
            senderType: computeSenderType(msg.senderId, currentUser),
            ...(replyPreviewText && !msg.replyPreviewText ? { replyPreviewText } : {}),
            ...(replyPreviewType && !msg.replyPreviewType ? { replyPreviewType } : {}),
            ...(replySenderId && !msg.replySenderId ? { replySenderId } : {}),
            ...(replySenderName && !msg.replySenderName ? { replySenderName } : {}),
            ...(msg.localUri && msg.type !== 'text' ? {
              previewUrl: msg.previewUrl || msg.localUri,
              mediaUrl: msg.mediaUrl || msg.localUri,
            } : {}),
          };
        });

        // MERGE strategy: keep optimistic messages that aren't in SQLite yet,
        // and preserve in-memory reply/sender data that SQLite may not have yet.
        setAllMessages(prev => {
          // Build a lookup of previous in-memory messages by ID for data recovery
          const prevById = new Map();
          for (const m of prev) {
            if (m.id) prevById.set(String(m.id), m);
            if (m.serverMessageId) prevById.set(String(m.serverMessageId), m);
            if (m.tempId) prevById.set(String(m.tempId), m);
          }

          // Preserve reply data and senderName from in-memory state onto enriched messages
          // when SQLite didn't have them (race condition with async writes)
          const patchedEnriched = enriched.map(m => {
            const prevMsg = prevById.get(String(m.id)) || prevById.get(String(m.serverMessageId)) || prevById.get(String(m.tempId));
            if (!prevMsg) return m;
            let patch = null;
            if (m.replyToMessageId && !m.replyPreviewText && prevMsg.replyPreviewText) {
              patch = {
                replyPreviewText: prevMsg.replyPreviewText,
                replyPreviewType: prevMsg.replyPreviewType || m.replyPreviewType,
                replySenderName: prevMsg.replySenderName || m.replySenderName,
                replySenderId: prevMsg.replySenderId || m.replySenderId,
              };
            }
            if (!m.senderName && prevMsg.senderName) {
              patch = { ...(patch || {}), senderName: prevMsg.senderName };
            }
            // Always prefer in-memory reactions over SQLite — optimistic updates are more recent
            if (prevMsg.reactions && typeof prevMsg.reactions === 'object' && Object.keys(prevMsg.reactions).length > 0) {
              if (!m.reactions || typeof m.reactions !== 'object' || Object.keys(m.reactions).length === 0) {
                patch = { ...(patch || {}), reactions: prevMsg.reactions };
              }
            }
            return patch ? { ...m, ...patch } : m;
          });

          // Build a set of ALL IDs from DB messages
          const dbIdSet = new Set();
          for (const m of patchedEnriched) {
            if (m.id) dbIdSet.add(m.id);
            if (m.serverMessageId) dbIdSet.add(m.serverMessageId);
            if (m.tempId) dbIdSet.add(m.tempId);
          }

          // Find locally-originated messages not yet reflected in the DB load and
          // preserve them so a just-sent message never blinks out of the thread.
          const optimistic = prev.filter(m => {
            const id = m.id || m.tempId;
            if (!id) return false;
            const inDB = dbIdSet.has(m.id) || dbIdSet.has(m.tempId) || dbIdSet.has(m.serverMessageId);
            if (inDB) return false;
            // Keep ANY message we created locally (it carries a tempId) that the DB
            // load doesn't yet contain. This covers BOTH a pre-ack temp row AND a
            // just-acked row whose `id` was already swapped to the serverMessageId
            // before its DB write landed — the latter no longer starts with
            // 'temp_', so the old `id`-prefix check dropped it and the sent
            // message disappeared. A locally-created row is only kept while it's
            // absent from the DB; the moment its write lands it's in dbIdSet and
            // renders from the DB instead (no duplicate, no resurrection).
            if (m.tempId || String(id).startsWith('temp_')) return true;
            return false;
          });

          if (optimistic.length === 0) return patchedEnriched;

          // Merge: optimistic messages first (newest), then DB messages
          // Dedup by ID to prevent any doubles
          const seenIds = new Set();
          const merged = [];
          for (const m of [...optimistic, ...patchedEnriched]) {
            const ids = [m.id, m.serverMessageId, m.tempId].filter(Boolean);
            if (ids.some(id => seenIds.has(id))) continue;
            for (const id of ids) seenIds.add(id);
            merged.push(m);
          }

          // Sort by timestamp descending (newest first)
          merged.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
          return merged;
        });

        // Sync memory cache with the latest enriched messages from SQLite.
        // Skip empty reads: merging [] on a cold start creates a hydrated-but-
        // empty cache entry for a chat whose rows simply haven't landed yet,
        // and later opens would trust that empty entry instead of re-reading.
        if (cid && enriched.length > 0) ChatCache.mergeMessages(cid, enriched);

        // Clean up: remove sent/delivered messages from scheduledMessages
        // (they're now in allMessages via DB, no longer need the in-memory copy)
        setScheduledMessages(prev => {
          const cleaned = prev.filter(m => m.status === 'scheduled' || m.status === 'processing' || m.status === 'failed');
          return cleaned.length !== prev.length ? cleaned : prev;
        });
      } catch (err) {
        console.warn('[ChatDB] refreshMessagesFromDB error:', err);
      }
    };

    if (immediate) {
      if (refreshTimerRef.current) { clearTimeout(refreshTimerRef.current); refreshTimerRef.current = null; }
      doRefresh();
    } else {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(doRefresh, 50);
    }
  }, []);

  // A call ended → the calling layer wrote an in-thread "call" entry to SQLite.
  // Refresh if it belongs to the chat currently open.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('call:thread:update', (payload) => {
      const cid = payload?.chatId;
      if (cid && chatIdRef.current && String(cid) === String(chatIdRef.current)) {
        refreshMessagesFromDB(true);
      }
    });
    return () => sub.remove();
  }, [refreshMessagesFromDB]);

  // Safety-net bridge: RealtimeChatContext persists EVERY incoming message to
  // SQLite (it powers the chat list, and is not gated on the active chat). The
  // open chat screen has its own message:new listener, but that can drop a
  // message via the active-chatId filter or a handler race — leaving it visible
  // in the chat LIST but missing from the open SCREEN. When the context signals a
  // message landed in this chat's thread, re-read from the DB so the open screen
  // always reflects what was actually persisted. Debounced refresh coalesces
  // bursts and dedupes, so a message the screen already rendered is a no-op.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('chat:thread:update', (payload) => {
      const cid = payload?.chatId;
      if (cid && chatIdRef.current && String(cid) === String(chatIdRef.current)) {
        refreshMessagesFromDB();
      }
    });
    return () => sub.remove();
  }, [refreshMessagesFromDB]);

  /**
   * Legacy-compatible wrapper — writes to SQLite then refreshes UI.
   * Used by code paths that still pass message arrays (e.g., reactions, status updates).
   * Skips stale temp-ID messages whose server-confirmed version already exists in SQLite.
   */
  const saveMessagesToLocal = useCallback(async (msgs) => {
    try {
      if (!chatIdRef.current || !msgs) return;
      // Filter out stale temp messages: if a message only has a temp ID but SQLite
      // already has a server-acknowledged version (via acknowledgeMessage), skip it.
      // This prevents the race where state has a stale temp version while SQLite has
      // the server version, and writing the temp version back creates a duplicate.
      const toWrite = [];
      for (const msg of msgs) {
        const msgId = msg.id || msg.tempId;
        if (msgId && String(msgId).startsWith('temp_') && !msg.serverMessageId) {
          // Check if this temp message was already acknowledged in SQLite
          const acknowledged = await ChatDatabase.messageExists(msgId);
          if (acknowledged) {
            // The temp ID exists in SQLite — check if it was already converted to a server row
            const existing = await ChatDatabase.getMessage(msgId);
            if (existing && existing.serverMessageId && existing.id !== msgId) {
              // Already acknowledged — skip this stale temp version
              continue;
            }
          }
        }
        toWrite.push({
          ...msg,
          chatId: msg.chatId || chatIdRef.current,
          senderType: msg.senderType || computeSenderType(msg.senderId, currentUserIdRef.current),
        });
      }
      if (toWrite.length > 0) {
        await ChatDatabase.upsertMessages(toWrite);
      }
      refreshMessagesFromDB();
    } catch (err) {
      console.warn('[ChatDB] saveMessagesToLocal error:', err);
    }
  }, [refreshMessagesFromDB]);

  const applyDeleteToLocalStorage = useCallback(async (messageId, isDeletedForEveryone, options = {}) => {
    try {
      if (!chatIdRef.current || !messageId) return;
      const localKey = getChatMessagesKey(chatIdRef.current);
      if (!localKey) return;
      const savedMessages = await AsyncStorage.getItem(localKey);
      if (!savedMessages) return;

      const parsed = JSON.parse(savedMessages);
      if (!Array.isArray(parsed) || parsed.length === 0) return;

      const deletedBy = normalizeId(options?.deletedBy) || null;
      const isDeletedBySelf = deletedBy ? sameId(deletedBy, currentUserIdRef.current) : false;

      const updated = isDeletedForEveryone
        ? parsed.map((msg) => {
            const isMatch = sameId(msg?.id, messageId) || sameId(msg?.serverMessageId, messageId) || sameId(msg?.tempId, messageId);
            if (!isMatch) return msg;
            return {
              ...msg,
              type: 'system',
              text: 'This message was deleted',
              isDeleted: true,
              deletedFor: 'everyone',
              deletedBy,
              placeholderText: buildDeletePlaceholderText(isDeletedBySelf),
              mediaUrl: null,
              previewUrl: null,
              localUri: null,
            };
          })
        : parsed.filter((msg) => !(
            sameId(msg?.id, messageId) ||
            sameId(msg?.serverMessageId, messageId) ||
            sameId(msg?.tempId, messageId)
          ));

      const deduped = deduplicateMessages(updated).slice(0, MAX_LOCAL_SAVE);
      await AsyncStorage.setItem(localKey, JSON.stringify(deduped));
    } catch (err) {
      console.error('Failed to apply delete in local storage:', err);
    }
  }, [deduplicateMessages]);

  const applyDeleteEveryoneToChatStorage = useCallback(async (chatIdParam, messageId, options = {}) => {
    try {
      const normalizedChatId = normalizeId(chatIdParam);
      const normalizedMessageId = normalizeId(messageId);
      if (!normalizedChatId || !normalizedMessageId) {
        return { ok: false, updated: false, reason: 'missing-required-fields' };
      }

      const localKey = getChatMessagesKey(normalizedChatId);
      if (!localKey) {
        return { ok: false, updated: false, reason: 'invalid-local-key' };
      }
      const savedMessages = await AsyncStorage.getItem(localKey);
      if (!savedMessages) {
        return { ok: true, updated: false, reason: 'chat-not-found', localKey };
      }

      let parsed = [];
      try {
        parsed = JSON.parse(savedMessages);
      } catch {
        return { ok: false, updated: false, reason: 'invalid-json', localKey };
      }

      if (!Array.isArray(parsed) || parsed.length === 0) {
        return { ok: true, updated: false, reason: 'no-messages', localKey };
      }

      console.log('🧪 [B:LOCAL:BEFORE]', {
        chatId: normalizedChatId,
        messageId: normalizedMessageId,
        count: parsed.length,
        matched: parsed.some((m) =>
          String(m?.id) === String(normalizedMessageId) ||
          String(m?.serverMessageId) === String(normalizedMessageId) ||
          String(m?.tempId) === String(normalizedMessageId)
        ),
      });

      const deletedBy = normalizeId(options?.deletedBy) || null;
      const isDeletedBySelf = deletedBy ? sameId(deletedBy, currentUserIdRef.current) : false;

      let didUpdate = false;
      const updated = parsed.map((msg) => {
        const isMatch =
          sameId(msg?.id, normalizedMessageId) ||
          sameId(msg?.serverMessageId, normalizedMessageId) ||
          sameId(msg?.tempId, normalizedMessageId);

        if (!isMatch) return msg;
        didUpdate = true;

        return {
          ...msg,
          type: 'system',
          text: 'This message was deleted',
          isDeleted: true,
          deletedFor: 'everyone',
          deletedBy,
          placeholderText: buildDeletePlaceholderText(isDeletedBySelf),
          mediaUrl: null,
          previewUrl: null,
          localUri: null,
        };
      });

      if (!didUpdate) {
        return { ok: true, updated: false, reason: 'message-not-found', localKey };
      }

      const deduped = deduplicateMessages(updated).slice(0, MAX_LOCAL_SAVE);
      await AsyncStorage.setItem(localKey, JSON.stringify(deduped));

      console.log('🧪 [B:LOCAL:AFTER]', {
        chatId: normalizedChatId,
        messageId: normalizedMessageId,
        updated: didUpdate,
        count: deduped.length,
      });

      return { ok: true, updated: true, localKey, messages: deduped };
    } catch (error) {
      console.error('applyDeleteEveryoneToChatStorage error', error);
      return { ok: false, updated: false, reason: 'storage-error', error };
    }
  }, [deduplicateMessages]);

  const updateChatListLastMessagePreview = useCallback((messagesArray) => {
    if (!chatIdRef.current) return;
    const sameChatMessages = (messagesArray || [])
      .filter((msg) => {
        if (msg?.chatId && msg.chatId === chatIdRef.current) return true;
        const peerId = normalizeId(chatData?.peerUser?._id);
        const myId = normalizeId(currentUserIdRef.current);
        if (!peerId || !myId) return false;
        return (
          (sameId(msg?.senderId, myId) && sameId(msg?.receiverId, peerId)) ||
          (sameId(msg?.senderId, peerId) && sameId(msg?.receiverId, myId))
        );
      })
      .sort((a, b) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0));

    // Get the most recent message (could be deleted)
    const latestMsg = sameChatMessages[0];

    if (latestMsg) {
      const isMsgDeleted = latestMsg.isDeleted || isDeletedForUser(latestMsg.deletedFor, currentUserIdRef.current);
      const isSystem = latestMsg.type === 'system' && !isMsgDeleted;

      if (isMsgDeleted) {
        // Show WhatsApp-style deleted placeholder in chat list
        const deletedBySelf = sameId(latestMsg.deletedBy, currentUserIdRef.current) ||
          sameId(latestMsg.senderId, currentUserIdRef.current);
        const deletedText = latestMsg.placeholderText ||
          (deletedBySelf ? 'You deleted this message' : 'This message was deleted');
        updateLocalLastMessagePreview({
          chatId: chatIdRef.current,
          lastMessage: {
            text: deletedText,
            placeholderText: deletedText,
            type: 'text',
            senderId: latestMsg.senderId || null,
            status: latestMsg.status || null,
            createdAt: latestMsg.createdAt || new Date(latestMsg.timestamp || Date.now()).toISOString(),
            isDeleted: true,
            deletedFor: 'everyone',
          },
          lastMessageAt: latestMsg.createdAt || new Date(latestMsg.timestamp || Date.now()).toISOString(),
          lastMessageType: 'text',
          lastMessageSender: latestMsg.senderId || null,
        });
        return;
      }

      if (!isSystem) {
        updateLocalLastMessagePreview({
          chatId: chatIdRef.current,
          lastMessage: {
            text: latestMsg.text || '',
            type: latestMsg.type || 'text',
            senderId: latestMsg.senderId || null,
            status: latestMsg.status || null,
            createdAt: latestMsg.createdAt || new Date(latestMsg.timestamp || Date.now()).toISOString(),
            isDeleted: false,
            isEdited: Boolean(latestMsg.isEdited),
            editedAt: latestMsg.editedAt || null,
          },
          lastMessageAt: latestMsg.createdAt || new Date(latestMsg.timestamp || Date.now()).toISOString(),
          lastMessageType: latestMsg.type || 'text',
          lastMessageSender: latestMsg.senderId || null,
          lastMessageEdited: Boolean(latestMsg.isEdited),
        });
        return;
      }

      // Latest is a system message — find the next non-system message
      const nextVisible = sameChatMessages.find((msg) => msg.type !== 'system');
      if (nextVisible) {
        updateLocalLastMessagePreview({
          chatId: chatIdRef.current,
          lastMessage: {
            text: nextVisible.text || '',
            type: nextVisible.type || 'text',
            senderId: nextVisible.senderId || null,
            status: nextVisible.status || null,
            createdAt: nextVisible.createdAt || new Date(nextVisible.timestamp || Date.now()).toISOString(),
            isDeleted: false,
          },
          lastMessageAt: nextVisible.createdAt || new Date(nextVisible.timestamp || Date.now()).toISOString(),
          lastMessageType: nextVisible.type || 'text',
          lastMessageSender: nextVisible.senderId || null,
        });
        return;
      }
    }

    updateLocalLastMessagePreview({
      chatId: chatIdRef.current,
      lastMessage: {
        text: 'No messages yet',
        type: 'text',
        senderId: null,
        status: null,
        createdAt: null,
        isDeleted: false,
      },
      lastMessageAt: null,
      lastMessageType: 'text',
      lastMessageSender: null,
    });
  }, [updateLocalLastMessagePreview, chatData?.peerUser?._id]);

  const applyChatClearedLocally = useCallback(async (targetChatId, scope = 'me') => {
    const normalizedChatId = normalizeId(targetChatId || chatIdRef.current);
    if (!normalizedChatId) return;

    // Re-entrancy guard — a concurrent call for the same chat (REST resolution
    // + socket echo arriving in the same tick) would race two transactions
    // against the same SQLite db and surface as "database is locked".
    const inFlightKey = `${normalizedChatId}::${scope}`;
    if (clearInFlightRef.current.has(inFlightKey)) return;
    clearInFlightRef.current.add(inFlightKey);

    const isCurrentChat = sameId(normalizedChatId, chatIdRef.current);
    deferRealtimeUpdate(() => markChatRead(normalizedChatId));

    if (isCurrentChat) {
      if (localSaveTimeoutRef.current) {
        clearTimeout(localSaveTimeoutRef.current);
        localSaveTimeoutRef.current = null;
      }
      setMessages([]);
      setAllMessages([]);
      setHasMoreMessages(false);
      setCurrentPage(1);
    }

    try {
      await AsyncStorage.removeItem(deletedKeyForChat(normalizedChatId));
      // Durable cleanup (AsyncStorage tombstone + SQLite messages wipe +
      // chat_meta.cleared_at stamp + in-memory ChatCache messages) runs
      // through the shared module-level helper. That helper dedupes across
      // every code path that can request a clear (REST resolution, the
      // global socket echo handler in RealtimeChatContext, and this hook),
      // so we never race the SQLite "database is locked" error.
      await performDurableChatClear(normalizedChatId);

      if (isCurrentChat) {
        deletedTombstonesRef.current = {};
      }

      // Both scopes reset the preview to "No messages yet" — the chat row
      // stays in the list. 'everyone' just means the peer also sees this
      // reset (driven by the backend ChatSummary update and the matching
      // `chat:cleared:everyone` socket event on the peer's device).
      updateLocalLastMessagePreview({
        chatId: normalizedChatId,
        lastMessage: {
          text: 'No messages yet',
          type: 'text',
          senderId: null,
          status: null,
          createdAt: null,
          isDeleted: false,
        },
        lastMessageAt: null,
        lastMessageType: 'text',
        lastMessageSender: null,
      });
    } catch (error) {
      console.error('applyChatClearedLocally storage cleanup error', error);
    } finally {
      clearInFlightRef.current.delete(inFlightKey);
    }
  }, [deletedKeyForChat, markChatRead, updateLocalLastMessagePreview, deferRealtimeUpdate, removeChat]);

  const clearChatForMe = useCallback(async () => {
    const targetChatId = normalizeId(chatIdRef.current);
    const userId = normalizeId(currentUserIdRef.current);
    if (!targetChatId || !userId) {
      throw new Error('Missing chat or user id');
    }

    try {
      const response = await apiCall('POST', 'user/chat/clear/me', {
        chatId: targetChatId,
        userId,
      });

      const hasFailure = response && (
        response.success === false ||
        response.status === false ||
        response.ok === false ||
        response.error
      );
      if (hasFailure) {
        throw new Error(response?.message || 'clear/me failed');
      }
      const clearType = String(response?.clearType || response?.data?.clearType || '').toLowerCase();
      if (clearType && clearType !== 'me') {
        throw new Error(`Unexpected clearType: ${clearType}`);
      }

      await removeMessagesByChatId(targetChatId);
      await applyChatClearedLocally(targetChatId, 'me');
      return { success: true };
    } catch (error) {
      console.error('clearChatForMe API error', error);
      throw error;
    }
  }, [applyChatClearedLocally]);

  const clearChatForEveryone = useCallback(async () => {
    const targetChatId = normalizeId(chatIdRef.current);
    const userId = normalizeId(currentUserIdRef.current);
    if (!targetChatId || !userId) {
      throw new Error('Missing chat or user id');
    }

    try {
      const response = await apiCall('POST', 'user/chat/clear/everyone', {
        chatId: targetChatId,
        userId,
      });

      const hasFailure = response && (
        response.success === false ||
        response.status === false ||
        response.ok === false ||
        response.error
      );
      if (hasFailure) {
        throw new Error(response?.message || 'clear/everyone failed');
      }
      const clearType = String(response?.clearType || response?.data?.clearType || '').toLowerCase();
      if (clearType && clearType !== 'everyone') {
        throw new Error(`Unexpected clearType: ${clearType}`);
      }

      await removeMessagesByChatId(targetChatId);
      await applyChatClearedLocally(targetChatId, 'everyone');
      return { success: true };
    } catch (error) {
      console.error('clearChatForEveryone API error', error);
      throw error;
    }
  }, [applyChatClearedLocally]);

  /* ========== API fetch handler ========= */
  const fetchMessagesFromAPI = async (chatIdParam) => {
    try {
      dispatch(chatMessage({ chatId: chatIdParam, search: '', page: 1, limit: 50 }));
    } catch (err) {
      console.error("fetchMessagesFromAPI error", err);
    }
  };

  // Returns true when a sync/fetch request was actually emitted, false when it
  // bailed (socket down). Callers use this to avoid arming throttles/cursors on
  // a request that never left the device.
  const fetchAndSyncMessagesViaSocket = useCallback((chatIdParam, options = {}) => {
    const socket = socketRef.current || getSocket();
    if (!socket || !isSocketConnected() || !chatIdParam) {
      return false;
    }

    const { before = null, limit = SOCKET_FETCH_LIMIT } = options;
    const force = options?.force === true;
    const syncOnly = options?.syncOnly === true;

    const isGrpSync = chatData?.chatType === 'group' || chatData?.isGroup;

    cslog('📡 message sync via SOCKET', {
      chatId: chatIdParam,
      mode: force ? 'force-full' : syncOnly ? 'delta-syncOnly' : 'full-fetch',
      isGroup: isGrpSync,
      transport: 'socket.io (server) — refreshes/fills SQLite, then UI re-reads SQLite',
    });

    if (force) {
      forceReloadPendingRef.current = true;
      isHardReloadingRef.current = true;
      lastMessageSyncAtRef.current = 0;

      // Force reload — single full fetch
      if (isGrpSync) {
        socket.emit('group:message:sync', {
          groupId: chatData?.groupId || chatData?.group?._id || chatIdParam,
          lastMessageId: null,
          limit,
        });
      } else {
        socket.emit('message:fetch', {
          chatId: chatIdParam,
          page: 1,
          limit,
          before,
          force: true,
        });
      }
      return true;
    }

    if (syncOnly) {
      // Delta sync only — fetch messages NEWER than what SQLite already has.
      const currentMessages = allMessagesRef.current || [];
      const latestMessage = currentMessages.reduce((candidate, msg) => {
        const ts = Number(msg?.timestamp || new Date(msg?.createdAt || 0).getTime() || 0);
        if (!candidate) return { msg, ts };
        return ts > candidate.ts ? { msg, ts } : candidate;
      }, null);

      const lastMessageId = String(
        latestMessage?.msg?.serverMessageId ||
        latestMessage?.msg?.id ||
        latestMessage?.msg?.tempId ||
        ''
      ) || null;

      if (isGrpSync) {
        // Group sync is a correct forward delta server-side (createdAt > cursor);
        // it still keys on lastMessageId.
        socket.emit('group:message:sync', {
          groupId: chatData?.groupId || chatData?.group?._id || chatIdParam,
          lastMessageId,
          limit: Number(limit) > 0 ? Number(limit) : 50,
        });
      } else {
        // 1-1 delta is keyed on the per-chat seq cursor so opening a chat only
        // pulls messages with seq > MAX(seq) — never re-downloads stored rows.
        // Fall back to the in-memory max seq, then to lastMessageId for safety.
        (async () => {
          let sinceSeq = 0;
          try {
            sinceSeq = await ChatDatabase.getLatestSeq(chatIdParam);
          } catch {
            sinceSeq = 0;
          }
          if (!sinceSeq) {
            const memMax = currentMessages.reduce((mx, m) => {
              const s = Number(m?.seq || 0);
              return s > mx ? s : mx;
            }, 0);
            sinceSeq = memMax;
          }
          // Mutation-delta cursor: pull edits/deletes applied to already-stored
          // messages since we last synced. With no stored cursor, seed from the
          // newest stored message time so we only pull FUTURE mutations (the
          // delta above already carries current state for anything it returns).
          let mutatedSince = await getMutationCursor(chatIdParam);
          if (!mutatedSince) {
            mutatedSince = currentMessages.reduce((mx, m) => {
              const t = Number(m?.timestamp || new Date(m?.createdAt || 0).getTime() || 0);
              return t > mx ? t : mx;
            }, 0);
          }
          const liveSocket = socketRef.current || getSocket();
          if (!liveSocket || !isSocketConnected()) return;
          liveSocket.emit('message:sync', {
            chatId: chatIdParam,
            sinceSeq,
            lastMessageId, // legacy fallback (server resolves it to its own seq)
            ...(mutatedSince > 0 ? { mutatedSince } : {}),
            limit: Number(limit) > 0 ? Number(limit) : 50,
          });
        })();
      }
      return true;
    }

    // Full fetch (no local messages) — single request only
    if (isGrpSync) {
      socket.emit('group:message:sync', {
        groupId: chatData?.groupId || chatData?.group?._id || chatIdParam,
        lastMessageId: null,
        limit,
      });
    } else {
      socket.emit('message:fetch', {
        chatId: chatIdParam,
        page: 1,
        limit,
        before,
      });
    }
    return true;
  }, [chatData, getMutationCursor]);

  useEffect(() => {
    const docs = chatMessagesData?.data?.docs || chatMessagesData?.docs || null;
    const hasNext = chatMessagesData?.data?.hasNextPage || chatMessagesData?.hasNextPage || false;
    if (isHardReloadingRef.current) return;
    if (Array.isArray(docs) && currentUserId && chatId && !hasLoadedFromAPI && currentPage === 1 && !isLoadingMore && docs.length > 0) {
      processAPIResponse(docs);
      setHasLoadedFromAPI(true);
      setHasMoreMessages(!!hasNext);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessagesData, currentUserId, chatId, hasLoadedFromAPI, currentPage, isLoadingMore]);

  const processAPIResponse = useCallback(async (apiMessages) => {
    // Build set of pending scheduled IDs to protect from server overwrite
    const pendingSchedIds = new Set();
    for (const sm of (scheduledMessagesRef.current || [])) {
      if (sm.status === 'scheduled' || sm.status === 'processing') {
        if (sm.id) pendingSchedIds.add(String(sm.id));
        if (sm.tempId) pendingSchedIds.add(String(sm.tempId));
        if (sm.serverMessageId) pendingSchedIds.add(String(sm.serverMessageId));
      }
    }

    // SQLite-first: normalize, batch write, refresh — skip pending scheduled messages
    const normalized = apiMessages
      .filter(raw => {
        if (raw?.status === 'scheduled') return false;
        if (raw?.status === 'processing') return false;
        if (raw?.status === 'cancelled') return false;
        // Block isScheduled messages on receiver side only if scheduleTime is still in the future
        const isSelf = raw?.senderId && sameId(raw.senderId, currentUserIdRef.current);
        if (!isSelf && raw?.isScheduled) {
          const schedTime = raw?.scheduleTime || raw?.schedule_time;
          const st = schedTime ? new Date(schedTime).getTime() : 0;
          if (Number.isFinite(st) && st > Date.now() + 5000) return false;
          // scheduleTime passed — strip schedule flags, allow through
          raw.isScheduled = false;
          raw.scheduleTime = null;
          raw.scheduleTimeLabel = null;
        }
        const rawId = raw?.messageId || raw?._id || raw?.id || raw?.serverMessageId;
        return !(rawId && pendingSchedIds.has(String(rawId)));
      })
      .map(raw => {
        const msg = normalizeIncomingMessage(raw);
        msg.chatId = msg.chatId || chatIdRef.current;
        if (msg.senderId) msg.senderType = computeSenderType(msg.senderId, currentUserIdRef.current);
        return msg;
      });
    await ChatDatabase.upsertMessages(normalized);
    refreshMessagesFromDB();
  }, [normalizeIncomingMessage, refreshMessagesFromDB]);

  const syncMessagesToAPI = async () => {
    try {
      if (!chatIdRef.current) return;
      const localKey = getChatMessagesKey(chatIdRef.current);
      if (!localKey) return;
      const savedMessages = await AsyncStorage.getItem(localKey);
      if (!savedMessages) return;
      const parsedMessages = JSON.parse(savedMessages);
      const unsyncedMessages = parsedMessages.filter(msg => msg.senderId === currentUserIdRef.current && !msg.synced && msg.status !== "sending" && msg.status !== "failed");
      if (unsyncedMessages.length > 0) {
        for (const msg of unsyncedMessages) {
          if (msg.payload) msg.synced = true;
        }
        const updatedMessages = parsedMessages.map(msg => unsyncedMessages.find(um => um.id === msg.id) ? { ...msg, synced: true } : msg);
        await AsyncStorage.setItem(localKey, JSON.stringify(updatedMessages));
      }
    } catch (err) {
      console.error("syncMessagesToAPI error", err);
    }
  };

  /* ========== Presence & typing helpers ========== */
  const applyPresenceState = useCallback((rawPayload) => {
    const normalized = normalizePresencePayload(rawPayload);
    if (!normalized) return;

    const incomingVersion = Number(rawPayload?.version || rawPayload?.data?.version || 0);
    if (incomingVersion && incomingVersion < presenceUpdateVersionRef.current) {
      return;
    }
    if (incomingVersion > presenceUpdateVersionRef.current) {
      presenceUpdateVersionRef.current = incomingVersion;
    }

    setPresenceDetails(normalized);
    setUserStatus(normalized.status || PRESENCE_STATUS.OFFLINE);
    setLastSeen(normalized.lastSeen || null);
    setCustomStatus(normalized.customStatus || "");
  }, []);

  const emitPresenceActivity = useCallback(({ reason = "interaction", metadata = {} } = {}) => {
    const socket = socketRef.current || getSocket();
    if (!socket || !isSocketConnected() || !currentUserIdRef.current) return;

    socket.emit("presence:activity", {
      userId: currentUserIdRef.current,
      chatId: chatIdRef.current,
      reason,
      appState: appState.current,
      networkType,
      timestamp: Date.now(),
      metadata,
    });
  }, [networkType]);

  const updatePresenceStatus = useCallback((status, options = {}) => {
    const socket = socketRef.current || getSocket();
    const normalizedStatus = normalizeStatus(status);

    if (!socket || !isSocketConnected() || !currentUserIdRef.current) {
      return;
    }

    const payload = {
      userId: currentUserIdRef.current,
      status: normalizedStatus,
      chatId: chatIdRef.current,
      source: options.source || "system",
      reason: options.reason || "state-update",
      networkType,
      timestamp: Date.now(),
    };

    socket.emit("user:status", payload);
    socket.emit("presence:update:self", payload);
  }, [networkType]);

  const startHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) return;
    heartbeatIntervalRef.current = setInterval(() => {
      const socket = socketRef.current || getSocket();
      if (!socket || !isSocketConnected() || !currentUserIdRef.current) return;
      socket.emit("presence:heartbeat", {
        userId: currentUserIdRef.current,
        chatId: chatIdRef.current,
        appState: appState.current,
        networkType,
        timestamp: Date.now(),
      });
    }, PRESENCE_HEARTBEAT_INTERVAL);
  }, [networkType]);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
  }, []);

  const resetIdleTimer = useCallback(() => {
    lastInteractionAtRef.current = Date.now();
    if (idleTimeoutRef.current) {
      clearTimeout(idleTimeoutRef.current);
    }

    idleTimeoutRef.current = setTimeout(() => {
      if (appState.current !== "active") return;
      updatePresenceStatus(PRESENCE_STATUS.AWAY, { reason: "idle-timeout" });
    }, PRESENCE_IDLE_TIMEOUT);
  }, [updatePresenceStatus]);

  const markUserOnline = useCallback((reason = "active") => {
    updatePresenceStatus(PRESENCE_STATUS.ONLINE, { reason });
    emitPresenceActivity({ reason });
    resetIdleTimer();
  }, [emitPresenceActivity, resetIdleTimer, updatePresenceStatus]);

  const queueManualPresence = useCallback(async (payload) => {
    try {
      const existing = queuedManualPresenceRef.current || [];
      const updated = [...existing, payload];
      queuedManualPresenceRef.current = updated;
      await AsyncStorage.setItem(
        `${MANUAL_PRESENCE_QUEUE_KEY}_${currentUserIdRef.current || "anon"}`,
        JSON.stringify(updated)
      );
      setManualPresencePending(true);
    } catch (error) {
      console.error("queueManualPresence error", error);
    }
  }, []);

  const flushQueuedManualPresence = useCallback(async () => {
    const socket = socketRef.current || getSocket();
    if (!socket || !isSocketConnected()) return;
    if (!queuedManualPresenceRef.current.length) {
      setManualPresencePending(false);
      return;
    }

    const queue = [...queuedManualPresenceRef.current];
    const failed = [];

    for (const queued of queue) {
      await new Promise((resolve) => {
        socket.emit("presence:manual", queued, (response) => {
          if (!(response?.status === true || response?.success === true || response?.data)) {
            failed.push(queued);
          } else {
            applyPresenceState(response);
          }
          resolve();
        });
      });
    }

    queuedManualPresenceRef.current = failed;
    setManualPresencePending(failed.length > 0);

    try {
      await AsyncStorage.setItem(
        `${MANUAL_PRESENCE_QUEUE_KEY}_${currentUserIdRef.current || "anon"}`,
        JSON.stringify(failed)
      );
    } catch (error) {
      console.error("flushQueuedManualPresence error", error);
    }
  }, [applyPresenceState]);

  const loadQueuedManualPresence = useCallback(async () => {
    try {
      const saved = await AsyncStorage.getItem(
        `${MANUAL_PRESENCE_QUEUE_KEY}_${currentUserIdRef.current || "anon"}`
      );
      const parsed = saved ? JSON.parse(saved) : [];
      queuedManualPresenceRef.current = Array.isArray(parsed) ? parsed : [];
      setManualPresencePending(queuedManualPresenceRef.current.length > 0);
    } catch (error) {
      console.error("loadQueuedManualPresence error", error);
    }
  }, []);

  const emitMediaStatusUpdate = useCallback((payload) => {
    return new Promise((resolve, reject) => {
      const socket = socketRef.current || getSocket();
      if (!socket || !isSocketConnected()) {
        reject(new Error('socket_not_connected'));
        return;
      }

      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('media_status_timeout'));
      }, MEDIA_STATUS_ACK_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeoutId);
        socket.off('message:media:update:response', onResponse);
      };

      const matchesPayload = (source = {}) => {
        const responseMessageId = normalizeId(source?.messageId || source?.id || source?._id);
        const responseChatId = normalizeId(source?.chatId || source?.chat || source?.roomId);
        return sameId(responseMessageId, payload?.messageId) && sameId(responseChatId, payload?.chatId);
      };

      const onResponse = (responseData) => {
        const source = responseData?.data || responseData || {};
        if (!matchesPayload(source)) return;
        cleanup();
        if (source?.status === false || source?.success === false || responseData?.status === false) {
          reject(new Error(source?.message || responseData?.message || 'media_status_update_failed'));
          return;
        }
        resolve(responseData);
      };

      socket.on('message:media:update:response', onResponse);

      socket.emit('message:media:update', payload, (ack) => {
        if (!ack) return;
        const ackSource = ack?.data || ack;
        if (!matchesPayload(ackSource)) return;
        cleanup();
        if (ack?.status === false || ackSource?.status === false || ackSource?.success === false) {
          reject(new Error(ackSource?.message || ack?.message || 'media_status_update_failed'));
          return;
        }
        resolve(ack);
      });
    });
  }, []);

  const flushQueuedMediaStatusUpdates = useCallback(async () => {
    if (mediaStatusInFlightRef.current) return;

    const socket = socketRef.current || getSocket();
    if (!socket || !isSocketConnected() || !isConnected) {
      return;
    }

    mediaStatusInFlightRef.current = true;
    try {
      const nowTs = Date.now();
      const queue = [...(queuedMediaStatusRef.current || [])];
      const nextQueue = [];

      for (const queued of queue) {
        const normalizedMessageId = normalizeId(queued?.messageId);
        const normalizedChatId = normalizeId(queued?.chatId);
        const eventKey = buildMediaStatusEventKey(normalizedChatId, normalizedMessageId);

        if (!normalizedMessageId || !normalizedChatId) {
          continue;
        }

        const messageDeleted = allMessages.some((msg) => {
          const msgId = normalizeId(msg?.serverMessageId || msg?.id || msg?.tempId || msg?.mediaId);
          if (!sameId(msgId, normalizedMessageId)) return false;
          return msg?.isDeleted || isDeletedForUser(msg?.deletedFor, currentUserIdRef.current) || msg?.type === 'system';
        });
        if (messageDeleted) {
          if (eventKey) mediaStatusProcessedRef.current.delete(eventKey);
          continue;
        }

        if (Number(queued?.nextAttemptAt || 0) > nowTs) {
          nextQueue.push(queued);
          continue;
        }

        try {
          await emitMediaStatusUpdate({
            messageId: normalizedMessageId,
            chatId: normalizedChatId,
            deviceId: queued?.deviceId,
            isMediaDownloaded: true,
          });
          if (eventKey) mediaStatusProcessedRef.current.add(eventKey);
        } catch (error) {
          const attempts = Number(queued?.attempts || 0) + 1;
          const cappedAttempts = Math.min(attempts, MEDIA_STATUS_MAX_RETRIES);
          const retryDelay = MEDIA_STATUS_BASE_RETRY_DELAY_MS * Math.pow(2, Math.max(0, cappedAttempts - 1));
          nextQueue.push({
            ...queued,
            attempts: cappedAttempts,
            nextAttemptAt: Date.now() + retryDelay,
            lastError: error?.message || 'media_status_update_failed',
          });
        }
      }

      queuedMediaStatusRef.current = nextQueue;
      await persistMediaStatusQueue(nextQueue);
    } finally {
      mediaStatusInFlightRef.current = false;
    }
  }, [allMessages, buildMediaStatusEventKey, emitMediaStatusUpdate, isConnected, persistMediaStatusQueue]);

  const queueMediaStatusUpdate = useCallback(async ({ messageId, chatId: targetChatId, deviceId, isMediaDownloaded = true }) => {
    const normalizedMessageId = normalizeId(messageId);
    const normalizedChatId = normalizeId(targetChatId || chatIdRef.current);
    if (!normalizedMessageId || !normalizedChatId || !isMediaDownloaded) return;

    const eventKey = buildMediaStatusEventKey(normalizedChatId, normalizedMessageId);
    if (!eventKey) return;

    const existingQueue = [...(queuedMediaStatusRef.current || [])];
    const existingIdx = existingQueue.findIndex((item) => (
      sameId(item?.messageId, normalizedMessageId) && sameId(item?.chatId, normalizedChatId)
    ));

    const queueItem = {
      messageId: normalizedMessageId,
      chatId: normalizedChatId,
      deviceId,
      isMediaDownloaded: true,
      attempts: 0,
      nextAttemptAt: Date.now(),
      updatedAt: Date.now(),
    };

    if (existingIdx >= 0) {
      existingQueue[existingIdx] = {
        ...existingQueue[existingIdx],
        ...queueItem,
      };
    } else if (!mediaStatusProcessedRef.current.has(eventKey)) {
      existingQueue.push(queueItem);
    }

    queuedMediaStatusRef.current = existingQueue;
    await persistMediaStatusQueue(existingQueue);
    await flushQueuedMediaStatusUpdates();
  }, [buildMediaStatusEventKey, flushQueuedMediaStatusUpdates, persistMediaStatusQueue]);

  const retryMediaStatusUpdate = useCallback(async ({ messageId, chatId: targetChatId }) => {
    const normalizedMessageId = normalizeId(messageId);
    const normalizedChatId = normalizeId(targetChatId || chatIdRef.current);
    if (!normalizedMessageId || !normalizedChatId) return;

    const deviceId = await getOrCreateDeviceId();
    const nextQueue = [...(queuedMediaStatusRef.current || [])];
    const idx = nextQueue.findIndex((item) => (
      sameId(item?.messageId, normalizedMessageId) && sameId(item?.chatId, normalizedChatId)
    ));

    const patch = {
      messageId: normalizedMessageId,
      chatId: normalizedChatId,
      deviceId,
      isMediaDownloaded: true,
      attempts: 0,
      nextAttemptAt: Date.now(),
      lastError: null,
      updatedAt: Date.now(),
    };

    if (idx >= 0) {
      nextQueue[idx] = { ...nextQueue[idx], ...patch };
    } else {
      nextQueue.push(patch);
    }

    queuedMediaStatusRef.current = nextQueue;
    await persistMediaStatusQueue(nextQueue);
    await flushQueuedMediaStatusUpdates();
  }, [flushQueuedMediaStatusUpdates, getOrCreateDeviceId, persistMediaStatusQueue]);

  const retryAllFailedMediaStatusUpdates = useCallback(async () => {
    const nextQueue = (queuedMediaStatusRef.current || []).map((item) => ({
      ...item,
      nextAttemptAt: Date.now(),
      lastError: null,
    }));
    queuedMediaStatusRef.current = nextQueue;
    await persistMediaStatusQueue(nextQueue);
    await flushQueuedMediaStatusUpdates();
  }, [flushQueuedMediaStatusUpdates, persistMediaStatusQueue]);

  const requestUserPresence = useCallback(() => {
    const socket = socketRef.current || getSocket();
    if (!socket || !isSocketConnected() || !chatData.peerUser?._id) {
      setUserStatus(PRESENCE_STATUS.OFFLINE);
      return;
    }

    socket.emit("presence:get", { userId: chatData.peerUser._id }, (response) => {
      if (response?.status === false) {
        setUserStatus(PRESENCE_STATUS.OFFLINE);
        return;
      }
      applyPresenceState(response?.data ? response.data : response);
    });
  }, [chatData.peerUser?._id, applyPresenceState]);

  const setManualPresence = useCallback(async ({ status, customStatus: custom = "", expiresAt = null, metadata = {} }) => {
    const normalizedStatus = normalizeStatus(status);
    const payload = {
      status: normalizedStatus,
      customStatus: custom,
      expiresAt,
      metadata,
      manualOverride: true,
      deviceId: await AsyncStorage.getItem("deviceId"),
      userId: currentUserIdRef.current,
      chatId: chatIdRef.current,
    };

    const socket = socketRef.current || getSocket();
    if (!socket || !isSocketConnected()) {
      await queueManualPresence(payload);
      return { queued: true };
    }

    return new Promise((resolve) => {
      socket.emit("presence:manual", payload, async (response) => {
        if (response?.status === true || response?.success === true || response?.data) {
          resolve({ queued: false, success: true, response });
          return;
        }
        await queueManualPresence(payload);
        resolve({ queued: true, success: false, response });
      });
    });
  }, [queueManualPresence]);

  const clearManualPresence = useCallback(async () => {
    return setManualPresence({
      status: PRESENCE_STATUS.ONLINE,
      customStatus: "",
      expiresAt: null,
      metadata: { clearManual: true },
    });
  }, [setManualPresence]);

  // FIXED: Send typing status with proper error handling
  const sendTypingStatus = useCallback((isTypingNow) => {
    const socket = socketRef.current || getSocket();
    
    if (!socket || !isSocketConnected()) {
      console.warn("⚠️ Cannot send typing status - socket not connected");
      return;
    }
    
    const isGroupChat = chatData.chatType === 'group' || chatData.isGroup;
    if (!chatIdRef.current || !currentUserIdRef.current || (!isGroupChat && !chatData.peerUser?._id)) {
      console.warn("⚠️ Cannot send typing status - missing data", {
        chatId: chatIdRef.current,
        userId: currentUserIdRef.current,
        peerId: chatData.peerUser?._id
      });
      return;
    }

    const payload = {
      chatId: chatIdRef.current,
      chatType: chatData.chatType || 'private',
      senderId: currentUserIdRef.current,
      receiverId: chatData.peerUser?._id || null,
      isTyping: isTypingNow,
      ...(isGroupChat && { groupId: chatData.groupId || chatData.group?._id || chatIdRef.current }),
    };

    // Emit appropriate event based on typing state and chat type
    if (isGroupChat) {
      socket.emit(isTypingNow ? 'group:typing:start' : 'group:typing:stop', payload);
    } else {
      socket.emit(isTypingNow ? 'typing:start' : 'typing:stop', payload);
    }
  }, [chatData.peerUser, chatData.chatType, chatData.isGroup, chatData.groupId, chatData.group]);

  /* ========== Socket listeners setup ========== */
  const removeSocketListeners = useCallback((socket) => {
    if (!socket) return;

    socketHandlerRegistryRef.current.forEach((handlers, eventName) => {
      handlers.forEach((handler) => {
        socket.off(eventName, handler);
      });
    });

    socketHandlerRegistryRef.current.clear();
  }, []);

  // FIXED: Setup socket listeners with proper typing handlers
  const setupSocketListeners = useCallback((socket, currentChatId) => {
    removeSocketListeners(socket);

    const registerSocketHandler = (eventName, handler) => {
      if (!eventName || typeof handler !== 'function') return;
      socket.on(eventName, handler);
      const existing = socketHandlerRegistryRef.current.get(eventName) || new Set();
      existing.add(handler);
      socketHandlerRegistryRef.current.set(eventName, existing);
    };

    const onMessageSentAck = (data) => {
      // Skip scheduled message acks — handled by onScheduledSentAck below
      if (data?.isScheduled || data?.data?.isScheduled) return;
      const source = data?.data || data || {};
      const messageId = source.messageId || source._id;
      // Server now echoes both clientMessageId AND tempId; older builds may
      // only send one. Use whichever is present — both refer to the same row.
      const tempId =
        source.clientMessageId ||
        source.tempId ||
        data.tempId ||
        null;
      if (data.persistenceConfirmed === true || data.status === true || messageId) {
        if (tempId) {
          updateMessageStatus(tempId, 'sent', { messageId, ...source });
        }
        if (tempId && messageId) {
          // Swap the optimistic temp_xxx PK for the canonical server id so any
          // subsequent action that takes `messageId` (reply / read / edit /
          // delete / reaction) uses the value the server recognizes.
          ChatDatabase.acknowledgeMessage(tempId, messageId).catch(() => {});
        }
      }
    };
    registerSocketHandler('message:sent:ack', onMessageSentAck);
    // Group send: matching ack event — same reconciliation logic.
    registerSocketHandler('group:message:sent', onMessageSentAck);

    // Handle message:quote:response and message:reply:response — ACK for quoted/reply messages
    const onQuoteResponse = (data) => {
      const source = data?.data || data;
      const serverMessageId = source?.messageId || source?._id;
      // Server responses for reply/quote don't include tempId — use our pending tracker
      const tempId = source?.tempId || pendingReplyTempIdRef.current;
      if (tempId) pendingReplyTempIdRef.current = null; // consume it
      if (serverMessageId) {
        updateMessageStatus(tempId || serverMessageId, 'sent', { messageId: serverMessageId, ...source });
        if (tempId && serverMessageId && tempId !== serverMessageId) {
          ChatDatabase.acknowledgeMessage(tempId, serverMessageId).catch(() => {});
        }
        // Update chat list preview with the reply text
        updateLocalLastMessagePreview({
          chatId: chatIdRef.current,
          text: source?.text || '',
          senderId: currentUserIdRef.current,
          messageId: serverMessageId,
          createdAt: source?.createdAt || new Date().toISOString(),
        });
      }
    };
    registerSocketHandler('message:quote:response', onQuoteResponse);
    registerSocketHandler('message:reply:response', onQuoteResponse);

    // Track forwarded message IDs — when these arrive via message:new, mark as forwarded
    const onForwardedMessage = (data) => {
      const source = data?.data || data;
      // Collect all forwarded message IDs so we can tag them when they arrive
      const msgs = source?.forwardedMessages || [];
      for (const fwd of msgs) {
        const fwdId = fwd?.messageId || fwd?._id;
        if (fwdId) forwardedMsgIdsRef.current.add(String(fwdId));
      }
      // Update chat list with the forwarded message preview
      const firstFwd = msgs[0];
      if (firstFwd) {
        onLocalOutgoingMessage({
          chatId: firstFwd?.chatId || chatIdRef.current,
          senderId: currentUserIdRef.current,
          text: firstFwd?.text || source?.text || 'Forwarded message',
          messageId: firstFwd?.messageId || firstFwd?._id,
          createdAt: firstFwd?.createdAt || new Date().toISOString(),
          ...(chatData?.chatType === 'group' || chatData?.isGroup
            ? { groupId: chatData.groupId || chatData.group?._id || chatIdRef.current }
            : { peerUser: chatData?.peerUser ? { ...chatData.peerUser, _id: chatData.peerUser._id || chatData.peerUser.userId || null } : null }),
        });
      }
      // Trigger an immediate sync to pick up forwarded messages.
      // The previous 500ms artificial delay made forwards appear sluggish;
      // refreshMessagesFromDB already has its own internal debounce.
      refreshMessagesFromDB(true);
    };
    registerSocketHandler('message:forward:response', onForwardedMessage);
    registerSocketHandler('message:forward:multiple:response', onForwardedMessage);

    // ─── SCHEDULED MESSAGE LISTENERS ───
    // ─── SCHEDULED MESSAGE LISTENERS ───

    // Server confirms schedule was created → replace tempId with real messageId
    // KEEP all schedule fields (isScheduled, scheduleTime, scheduleTimeLabel)
    const onScheduleResponse = (data) => {
      const source = data?.data || data;
      const serverId = source?.messageId;
      const schedTime = source?.scheduleTime;
      const responseChatId = source?.chatId;
      if (!serverId) return;

      setScheduledMessages(prev => {
        // Find the most recent unconfirmed scheduled message
        const idx = prev.findIndex(m =>
          m.isScheduled && m.status === 'scheduled' &&
          String(m.id || '').startsWith('temp_sched_')
        );
        if (idx === -1) return prev;
        const updated = [...prev];
        const old = updated[idx];
        updated[idx] = {
          ...old,
          id: serverId,
          serverMessageId: serverId,
          tempId: old.tempId, // keep tempId for reference
          synced: true,
          // PRESERVE all schedule fields
          isScheduled: true,
          status: 'scheduled',
          scheduleTime: schedTime || old.scheduleTime,
          scheduleTimeLabel: old.scheduleTimeLabel,
          ...(responseChatId ? { chatId: responseChatId } : {}),
        };
        return updated;
      });

      // Persist the tempId → serverId transition in SQLite (sequential to avoid race)
      setTimeout(async () => {
        const scheduled = scheduledMessagesRef.current || [];
        const tempMsg = scheduled.find(m =>
          m.serverMessageId === serverId ||
          (m.isScheduled && m.status === 'scheduled' && String(m.tempId || '').startsWith('temp_sched_'))
        );
        if (tempMsg?.tempId && tempMsg.tempId !== serverId) {
          try {
            await ChatDatabase.acknowledgeMessage(tempMsg.tempId, serverId);
            // Re-save with schedule data to ensure it's preserved after acknowledge
            await ChatDatabase.upsertMessage({
              ...tempMsg,
              id: serverId,
              serverMessageId: serverId,
              status: 'scheduled',
              isScheduled: true,
            });
          } catch (e) {
            console.warn('[Schedule] DB persist error:', e);
          }
        }
      }, 100);
    };
    registerSocketHandler('message:schedule:response', onScheduleResponse);
    registerSocketHandler('group:message:schedule:response', onScheduleResponse);

    // Server confirms cancel — promote to allMessages as cancelled, remove from scheduled
    const onScheduleCancelResponse = (data) => {
      const source = data?.data || data;
      const msgId = source?.messageId;
      if (msgId && source?.cancelled) {
        setScheduledMessages(prev => {
          const match = prev.find(m => m.id === msgId || m.serverMessageId === msgId);
          if (match) {
            const cancelledMsg = {
              ...match,
              status: 'cancelled',
              isScheduled: false,
              scheduleTimeLabel: null,
              scheduleTime: null,
            };
            setAllMessages(all => {
              const exists = all.some(m => m.id === msgId || m.serverMessageId === msgId);
              return exists ? all : [cancelledMsg, ...all];
            });
          }
          return prev.filter(m => m.id !== msgId && m.serverMessageId !== msgId);
        });
        ChatDatabase.clearScheduleData(msgId, 'cancelled').then(() => {
          refreshMessagesFromDB();
        }).catch(() => {});
      }
    };
    registerSocketHandler('message:cancel:scheduled:response', onScheduleCancelResponse);
    registerSocketHandler('group:message:cancel:scheduled:response', onScheduleCancelResponse);

    // Receiver-side: server notifies that a scheduled message was cancelled by the sender
    // Remove the message from receiver's UI and DB if it somehow got through
    const onScheduledCancelledReceiver = (data) => {
      const source = data?.data || data;
      const msgId = source?.messageId || source?._id || source?.id;
      if (!msgId) return;
      console.log('[Schedule] Receiver got cancel notification for:', msgId);
      // Remove from allMessages immediately
      setAllMessages(prev => {
        const filtered = prev.filter(m =>
          m.id !== msgId && m.serverMessageId !== msgId && m.tempId !== msgId
        );
        return filtered.length !== prev.length ? filtered : prev;
      });
      // Remove from DB through the writer queue (avoids racing other writes);
      // refresh once the queue drains so we see the post-delete state.
      SqliteWriter.enqueue('deleteMessageForMe', { messageId: msgId }).then(() => {
        refreshMessagesFromDB(true);
      }).catch(() => {});
    };
    registerSocketHandler('message:scheduled:cancelled', onScheduledCancelledReceiver);
    registerSocketHandler('message:cancel:scheduled', onScheduledCancelledReceiver);
    registerSocketHandler('group:message:scheduled:cancelled', onScheduledCancelledReceiver);
    registerSocketHandler('group:message:cancel:scheduled', onScheduledCancelledReceiver);

    // Server sent the scheduled message at the scheduled time → sender gets this
    // message:sent:ack with isScheduled: true
    // Update in-place: clock → tick, no array swap to avoid UI revert
    const onScheduledSentAck = (data) => {
      const source = data?.data || data;
      if (!source?.isScheduled) return;
      const msgId = source?.messageId || source?._id;
      if (!msgId) return;

      // Move from scheduledMessages → allMessages with status 'sent'
      setScheduledMessages(prev => {
        const match = prev.find(m => m.id === msgId || m.serverMessageId === msgId || m.tempId === msgId);
        if (!match) {
          // Fallback: not in scheduledMessages (e.g. app restarted) — add to allMessages
          setAllMessages(all => {
            const exists = all.some(m => m.id === msgId || m.serverMessageId === msgId);
            if (exists) return all;
            return [{
              id: msgId, serverMessageId: msgId, status: 'sent',
              isScheduled: false, scheduleTimeLabel: null, scheduleTime: null,
              chatId: currentChatId, senderType: 'self', ...source,
            }, ...all];
          });
          return prev;
        }
        // Build the sent message and move to allMessages
        const sentMsg = {
          ...match,
          ...source,
          id: msgId,
          serverMessageId: msgId,
          status: 'sent',
          isScheduled: false,
          wasScheduled: true,
          scheduleTimeLabel: match.scheduleTimeLabel || null,
          scheduleTime: null,
          chatId: match.chatId || currentChatId,
          senderType: 'self',
        };
        setAllMessages(all => {
          const filtered = all.filter(m =>
            m.id !== msgId && m.serverMessageId !== msgId &&
            m.tempId !== (match.tempId || '__none__')
          );
          return [sentMsg, ...filtered];
        });
        // Remove from scheduledMessages
        return prev.filter(m => m.id !== msgId && m.serverMessageId !== msgId && m.tempId !== msgId);
      });

      // Update DB: status + clear schedule data from payload so reload is clean
      ChatDatabase.clearScheduleData(msgId, 'sent').then(() => {
        refreshMessagesFromDB();
      }).catch(() => {});
    };
    registerSocketHandler('message:sent:ack', onScheduledSentAck);
    registerSocketHandler('group:message:sent:ack', onScheduledSentAck);
    registerSocketHandler('group:message:sent', onScheduledSentAck);
    registerSocketHandler('group:message:send:response', onScheduledSentAck);

    // If server fails to deliver after 3 retries
    const onScheduleFailed = (data) => {
      const source = data?.data || data;
      const msgId = source?.messageId || source?._id;
      if (msgId) {
        setScheduledMessages(prev => prev.map(m => {
          if (m.id === msgId || m.serverMessageId === msgId) {
            return { ...m, status: 'failed', isScheduled: false, scheduleTimeLabel: null, scheduleTime: null };
          }
          return m;
        }));
        ChatDatabase.clearScheduleData(msgId, 'failed').then(() => {
          refreshMessagesFromDB();
        }).catch(() => {});
      }
    };
    registerSocketHandler('message:schedule:failed', onScheduleFailed);
    registerSocketHandler('group:message:schedule:failed', onScheduleFailed);

    const onMessageSent = (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId || source?._id;
      const tempId = source?.tempId;
      if (tempId || messageId) {
        updateMessageStatus(tempId || messageId, 'sent', { messageId, ...source });
        if (tempId && messageId) {
          ChatDatabase.acknowledgeMessage(tempId, messageId).catch(() => {});
        }
      }
    };
    registerSocketHandler('message:sent', onMessageSent);

    // Track which messageIds we've already processed to prevent duplicates
    // from message:new + message:received firing for the same message
    const handledMsgIds = new Set();

    // Block scheduled messages that arrive before their time (server bug safety net)
    const isScheduledAndPremature = (source) => {
      const schedTime = source?.scheduleTime || source?.schedule_time;
      if (!schedTime) return false;
      const st = new Date(schedTime).getTime();
      // If scheduleTime is in the future (more than 5s from now), block it
      return Number.isFinite(st) && st > Date.now() + 5000;
    };

    // Check if a message is already tracked in scheduledMessages (sender-only)
    const isInScheduledMessages = (msgId) => {
      if (!msgId) return false;
      const id = String(msgId);
      return scheduledMessagesRef.current.some(m =>
        String(m.id || '') === id || String(m.serverMessageId || '') === id || String(m.tempId || '') === id
      );
    };

    const onMessageNew = (data) => {
      const source = data?.data || data;
      const chatInPayload = source?.chatId || source?.chat || source?.roomId;
      // Use sameChatId (set-equality on participants) so a private chatId in the
      // payload doesn't drop the message when ordering differs from the local key.
      if (chatInPayload && !sameChatId(chatInPayload, currentChatId) && !sameChatId(chatInPayload, chatIdRef.current)) return;
      // Normalize chatId on the payload to whatever this client uses, so the message
      // is stored under the same chat row both sides see.
      if (chatInPayload && (currentChatId || chatIdRef.current)) {
        source.chatId = currentChatId || chatIdRef.current;
      }

      const isSelfMsg = source?.senderId && sameId(source.senderId, currentUserIdRef.current);

      // Determine if this is a scheduled message being delivered now (scheduleTime has passed)
      const isScheduledDelivery = source?.isScheduled && !isScheduledAndPremature(source);

      // Block still-pending scheduled/processing messages — UNLESS it's a delivery (scheduleTime passed)
      if ((source?.status === 'scheduled' || source?.status === 'processing') && !isScheduledDelivery) {
        console.log('[Schedule] Blocked pending scheduled message:new:', source?.messageId || source?._id);
        return;
      }

      // Block cancelled/failed messages — they should never appear in chat
      if (source?.status === 'cancelled' || source?.status === 'failed') {
        console.log('[Schedule] Blocked cancelled/failed message:new:', source?.messageId || source?._id);
        return;
      }

      // For receiver: if isScheduled but scheduleTime has NOT passed → block premature
      if (!isSelfMsg && source?.isScheduled && isScheduledAndPremature(source)) {
        console.log('[Schedule] Blocked premature scheduled message on receiver side:new:', source?.messageId || source?._id);
        return;
      }

      // If it's a delivered scheduled message on receiver side, strip active schedule flags but mark as wasScheduled
      if (!isSelfMsg && source?.isScheduled) {
        source.wasScheduled = true;
        source.isScheduled = false;
        source.scheduleTime = null;
        source.schedule_time = null;
        // Keep scheduleTimeLabel for display — shows "Scheduled Mar 26, 11:55 AM" on receiver side
        if (source?.status === 'scheduled' || source?.status === 'processing') {
          source.status = 'sent';
        }
      }

      // Block premature scheduled messages (sender side safety net)
      if (isSelfMsg && isScheduledAndPremature(source)) {
        console.log('[Schedule] Blocked premature message:new:', source?.messageId || source?._id);
        return;
      }

      const msgId = source?.messageId || source?._id || source?.id;

      // Block cancelled scheduled messages — server may still deliver after cancel
      if (msgId && cancelledMsgIdsRef.current.has(String(msgId))) {
        console.log('[Schedule] Blocked cancelled message:new:', msgId);
        return;
      }

      // Block if this message is already in scheduledMessages (server echo for sender)
      if (isInScheduledMessages(msgId)) {
        console.log('[Schedule] Blocked echo for scheduled message:new:', msgId);
        return;
      }

      if (msgId) handledMsgIds.add(String(msgId));

      // Check if this message was forwarded (tagged by forward response handler)
      if (msgId && forwardedMsgIdsRef.current.has(String(msgId))) {
        source.isForwarded = true;
        forwardedMsgIdsRef.current.delete(String(msgId));
      }

      handleReceivedMessage(source);
    };
    registerSocketHandler('message:new', onMessageNew);

    const onMessageReceived = (data) => {
      const source = data?.data || data;

      const isSelfMsg = source?.senderId && sameId(source.senderId, currentUserIdRef.current);
      const isScheduledDelivery = source?.isScheduled && !isScheduledAndPremature(source);

      // Block still-pending scheduled/processing messages — UNLESS it's a delivery (scheduleTime passed)
      if ((source?.status === 'scheduled' || source?.status === 'processing') && !isScheduledDelivery) {
        console.log('[Schedule] Blocked pending scheduled message:received:', source?.messageId || source?._id);
        return;
      }

      // Block cancelled/failed messages — they should never appear in chat
      if (source?.status === 'cancelled' || source?.status === 'failed') {
        console.log('[Schedule] Blocked cancelled/failed message:received:', source?.messageId || source?._id);
        return;
      }

      // For receiver: if isScheduled but scheduleTime has NOT passed → block premature
      if (!isSelfMsg && source?.isScheduled && isScheduledAndPremature(source)) {
        console.log('[Schedule] Blocked premature scheduled message on receiver side:received:', source?.messageId || source?._id);
        return;
      }

      // If it's a delivered scheduled message on receiver side, mark as wasScheduled for visual indicator
      if (!isSelfMsg && source?.isScheduled) {
        source.wasScheduled = true;
        source.isScheduled = false;
        source.scheduleTime = null;
        source.schedule_time = null;
        if (source?.status === 'scheduled' || source?.status === 'processing') {
          source.status = 'sent';
        }
      }

      // Block premature scheduled messages (sender side safety net)
      if (isSelfMsg && isScheduledAndPremature(source)) {
        console.log('[Schedule] Blocked premature message:received:', source?.messageId || source?._id);
        return;
      }

      const msgId = source?.messageId || source?._id || source?.id;

      // Block cancelled scheduled messages — server may still deliver after cancel
      if (msgId && cancelledMsgIdsRef.current.has(String(msgId))) {
        console.log('[Schedule] Blocked cancelled message:received:', msgId);
        return;
      }

      // Block if this message is already in scheduledMessages (server echo for sender)
      if (isInScheduledMessages(msgId)) {
        console.log('[Schedule] Blocked echo for scheduled message:received:', msgId);
        return;
      }

      // Skip if already handled by message:new
      if (msgId && handledMsgIds.has(String(msgId))) return;
      if (msgId) handledMsgIds.add(String(msgId));
      handleReceivedMessage(source);
    };
    const onMessageDelivered = (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId || source?._id;
      if (!messageId) return;
      // Do NOT emit delivered for scheduled/processing/cancelled/failed messages
      if (isInScheduledMessages(messageId)) return;
      updateMessageStatus(messageId, 'delivered', source);
    };
    const onMessageRead = (data) => {
      const source = data?.data || data;
      // Determine WHO triggered the read — must be the PEER, not ourselves
      // Backend sends field as `readerId`; also check legacy aliases
      const readerId = source?.readerId || source?.senderId || source?.readBy || source?.userId;

      // If readerId is us, ignore (we triggered this via message:read:all on chat open)
      if (readerId && String(readerId) === String(currentUserIdRef.current)) return;

      // If no readerId at all, we can't confirm a peer read — ignore to prevent false blue ticks
      if (!readerId) return;

      // Single message read — only mark if it's our outgoing message being read by the peer
      if (source?.messageId) {
        updateMessageStatus(source.messageId, 'seen', source);
        return;
      }

      // Bulk read by chatId — peer has read all messages in this chat
      const sourceChatId = source?.chatId || source?.chat;
      if (sourceChatId && sourceChatId === currentChatId) {
        setAllMessages(prev => {
          let changed = false;
          const updated = prev.map(msg => {
            const isMine = msg.senderId === currentUserIdRef.current;
            if (!isMine) return msg;
            // Skip scheduled/processing/cancelled/failed — not real messages yet
            if (msg.status === 'scheduled' || msg.status === 'processing' || msg.status === 'cancelled' || msg.status === 'failed') return msg;
            if (msg.status === 'sent' || msg.status === 'delivered') {
              changed = true;
              return { ...msg, status: 'seen' };
            }
            return msg;
          });
          if (changed) {
            saveMessagesToLocal(updated);
            updateChatListLastMessagePreview(updated);
            return updated;
          }
          return prev;
        });
      }
    };
    registerSocketHandler('message:received', onMessageReceived);
    registerSocketHandler('message:delivered', onMessageDelivered);
    registerSocketHandler('message:read', onMessageRead);

    const onMessageReadBulk = (data) => {
      const source = data?.data || data;
      // Must have a readerId that is NOT us — only peer reads should turn ticks blue
      const readerId = source?.readerId || source?.senderId || source?.readBy || source?.userId;
      if (!readerId || String(readerId) === String(currentUserIdRef.current)) return;
      const messageIds = Array.isArray(source?.messageIds) ? source.messageIds : [];
      if (messageIds.length > 0) {
        setAllMessages(prev => {
          const idSet = new Set(messageIds.map((id) => String(id)));
          let changed = false;
          const updated = prev.map(msg => {
            const id = String(msg.serverMessageId || msg.id || msg.tempId || '');
            if (!idSet.has(id)) return msg;
            // Skip scheduled/processing/cancelled/failed — not real messages yet
            if (msg.status === 'scheduled' || msg.status === 'processing' || msg.status === 'cancelled' || msg.status === 'failed') return msg;
            if (msg.status === 'seen' || msg.status === 'read') return msg;
            changed = true;
            return { ...msg, status: 'seen' };
          });
          if (changed) {
            saveMessagesToLocal(updated);
            updateChatListLastMessagePreview(updated);
            return updated;
          }
          return prev;
        });
      }
    };
    registerSocketHandler('message:read:bulk', onMessageReadBulk);

    // message:read:bulk:ack → sent by server to the ORIGINAL MESSAGE SENDER when the
    // peer calls message:read:bulk. This is what turns OUR outgoing ticks blue.
    const onMessageReadBulkAck = (data) => {
      const source = data?.data || data;
      // readerId = the person who read (the peer) — must NOT be us
      const readerId = source?.readerId || source?.senderId || source?.readBy || source?.userId;
      if (!readerId || String(readerId) === String(currentUserIdRef.current)) return;

      const messageIds = Array.isArray(source?.messageIds) ? source.messageIds : [];
      const bulkChatId = source?.chatId;
      if (messageIds.length === 0 && !bulkChatId) return;

      setAllMessages(prev => {
        const idSet = new Set(messageIds.map(id => String(id)));
        let changed = false;
        const updated = prev.map(msg => {
          // Match by messageId list OR by chatId (bulk-all case)
          const msgId = String(msg.serverMessageId || msg.id || msg.tempId || '');
          const matchById = idSet.size > 0 && idSet.has(msgId);
          const matchByChat = !matchById && bulkChatId && sameId(msg.chatId, bulkChatId) && sameId(msg.senderId, currentUserIdRef.current);
          if (!matchById && !matchByChat) return msg;
          if (msg.status === 'scheduled' || msg.status === 'processing' || msg.status === 'cancelled' || msg.status === 'failed') return msg;
          if (msg.status === 'seen' || msg.status === 'read') return msg;
          changed = true;
          return { ...msg, status: 'seen' };
        });
        if (changed) {
          saveMessagesToLocal(updated);
          updateChatListLastMessagePreview(updated);
          // Persist 'seen' to SQLite for each matched message
          messageIds.forEach(msgId => {
            SqliteWriter.enqueue('updateMessageStatus', { id: String(msgId), status: 'seen' }).catch(() => {});
          });
          // Update chats table last_message_status
          if (bulkChatId) {
            ChatDatabase.updateChatLastMessageStatus(bulkChatId, 'seen').catch(() => {});
          }
        }
        return changed ? updated : prev;
      });
    };
    registerSocketHandler('message:read:bulk:ack', onMessageReadBulkAck);

    const onMessageStatus = (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId;
      const status = source?.status;
      if (!messageId || !status) return;
      // Do NOT update status for messages that are in scheduledMessages
      if (isInScheduledMessages(messageId)) return;
      updateMessageStatus(messageId, status, source);
    };
    registerSocketHandler('message:status', onMessageStatus);

    // ─── RESPONSE LISTENERS for delivery/read/seen events ───

    const onDeliveredResponse = (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId;
      if (!messageId) return;
      // Do NOT update delivery for scheduled/processing/cancelled/failed messages
      if (isInScheduledMessages(messageId)) return;
      updateMessageStatus(messageId, 'delivered', source);
    };
    registerSocketHandler('message:delivered:response', onDeliveredResponse);

    const onReadResponse = (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId;
      if (!messageId) return;
      // Only mark as 'seen' if the reader is the peer, not ourselves
      const readerId = source?.readerId || source?.senderId || source?.readBy || source?.userId;
      if (readerId && String(readerId) === String(currentUserIdRef.current)) return;
      // Do NOT update read for scheduled/processing/cancelled/failed messages
      if (isInScheduledMessages(messageId)) return;
      updateMessageStatus(messageId, 'seen', source);
    };
    registerSocketHandler('message:read:response', onReadResponse);

    const onReadBulkResponse = (data) => {
      const source = data?.data || data;
      // This is a response to our own message:read:bulk — we marked incoming messages as read.
      // These confirmed IDs are incoming messages we read, so just update those specific messages
      // (not our outgoing ones). Only incoming messages should be set to 'seen' here.
      const results = Array.isArray(source?.results) ? source.results : [];
      const successIds = results.filter(r => r?.success).map(r => String(r?.messageId)).filter(Boolean);
      if (successIds.length === 0) return;

      setAllMessages(prev => {
        const idSet = new Set(successIds);
        let changed = false;
        const updated = prev.map(msg => {
          const id = String(msg.serverMessageId || msg.id || msg.tempId || '');
          if (!idSet.has(id)) return msg;
          // Only update incoming messages (from peer), not our own outgoing messages
          if (msg.senderId === currentUserIdRef.current) return msg;
          // Skip scheduled/processing/cancelled/failed — not real messages yet
          if (msg.status === 'scheduled' || msg.status === 'processing' || msg.status === 'cancelled' || msg.status === 'failed') return msg;
          if (msg.status === 'seen' || msg.status === 'read') return msg;
          changed = true;
          return { ...msg, status: 'seen' };
        });
        if (changed) {
          saveMessagesToLocal(updated);
          updateChatListLastMessagePreview(updated);
        }
        return changed ? updated : prev;
      });
    };
    registerSocketHandler('message:read:bulk:response', onReadBulkResponse);

    // onReadAllResponse: fires on the SENDER when the peer calls message:read:all
    // (i.e. the peer opened our chat → all our messages are now read → turn ticks blue)
    const onReadAllResponse = (data) => {
      const source = data?.data || data;
      const responseChatId = source?.chatId;
      if (!responseChatId) return;

      // readerId = the person who READ (the peer), must NOT be ourselves
      const readerId = source?.readerId || source?.senderId || source?.readBy || source?.userId;
      if (!readerId || String(readerId) === String(currentUserIdRef.current)) return;

      // Always update SQLite (even when this chat is not currently open)
      ChatDatabase.updateAllSentMessagesInChatToSeen(responseChatId, currentUserIdRef.current)
        .catch(() => {});
      ChatDatabase.updateChatLastMessageStatus(responseChatId, 'seen').catch(() => {});

      // Update in-memory state only for the currently open chat
      if (!sameId(responseChatId, currentChatId)) return;

      setAllMessages(prev => {
        let changed = false;
        const updated = prev.map(msg => {
          // Only update OUR outgoing messages — not messages from the peer
          if (!sameId(msg.senderId, currentUserIdRef.current)) return msg;
          // Skip scheduled/processing/cancelled/failed — not real messages yet
          if (msg.status === 'scheduled' || msg.status === 'processing' || msg.status === 'cancelled' || msg.status === 'failed') return msg;
          if (msg.status === 'seen' || msg.status === 'read') return msg;
          changed = true;
          return { ...msg, status: 'seen' };
        });
        if (changed) {
          saveMessagesToLocal(updated);
          updateChatListLastMessagePreview(updated);
        }
        return changed ? updated : prev;
      });
    };
    // Backend sends this event name to the SENDER when the peer bulk-reads all messages
    registerSocketHandler('message:read:all:ack', onReadAllResponse);
    // Also listen on legacy response event for backwards-compat
    registerSocketHandler('message:read:all:response', onReadAllResponse);

    const onSeenResponse = (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId;
      if (!messageId) return;
      // Only mark as 'seen' if the reader is the peer, not ourselves
      const readerId = source?.readerId || source?.senderId || source?.readBy || source?.userId;
      if (readerId && String(readerId) === String(currentUserIdRef.current)) return;
      // Do NOT update seen for scheduled/processing/cancelled/failed messages
      if (isInScheduledMessages(messageId)) return;
      updateMessageStatus(messageId, 'seen', source);
    };
    registerSocketHandler('message:seen:response', onSeenResponse);
    registerSocketHandler('message:seen', onSeenResponse);

    // ─── MESSAGE EDIT (sender confirmation + receiver broadcast) ───
    const onEditResponse = async (data) => {
      const source = data?.data || data || {};
      if (source?.status === false || data?.status === false) return;

      const messageId = source?.messageId || source?.id || source?._id;
      const newText = source?.text || source?.newText || source?.message;
      const editedChatId = source?.chatId || source?.chat;
      const editedAt = source?.editedAt || source?.updatedAt || new Date().toISOString();
      if (!messageId) return;

      if (editedChatId && !sameId(editedChatId, currentChatId)) return;

      // OUT-OF-ORDER: if the message isn't in local state yet, stash the edit so
      // normalizeIncomingMessage applies it when the message later syncs in.
      if (newText) {
        const existing = await ChatDatabase.getMessage(messageId);
        if (!existing) {
          registerPendingEdit(messageId, newText, editedAt);
          return;
        }
        await ChatDatabase.updateMessageEdit(messageId, newText, editedAt);
        removePendingEdit(messageId);
      }
      refreshMessagesFromDB();
    };
    // Sender gets: message:edit:response
    registerSocketHandler('message:edit:response', onEditResponse);
    // Receiver gets: message:edited (broadcast from server)
    registerSocketHandler('message:edited', onEditResponse);

    const handleMediaDownloadedUpdate = (data) => {
      const source = data?.data || data || {};
      const updatedMessageId = String(source?.messageId || source?.id || source?._id || '');
      const sourceChatId = source?.chatId || source?.chat || source?.roomId;
      const isMediaDownloaded = Boolean(source?.isMediaDownloaded);

      if (!updatedMessageId || !sameId(sourceChatId, currentChatId)) {
        return;
      }

      applyMediaDownloadedStateLocally({
        messageId: updatedMessageId,
        chatId: sourceChatId,
        isMediaDownloaded,
        localUri: source?.localUri || source?.path || null,
      });
    };

    const handleMediaUpdateResponse = async (data) => {
      const source = data?.data || data || {};
      const responseMessageId = source?.messageId || source?.id || source?._id;
      const responseChatId = source?.chatId || source?.chat || source?.roomId;
      if (!responseMessageId || !responseChatId) {
        return;
      }

      if (source?.status === false || source?.success === false || data?.status === false) {
        const deviceId = await getOrCreateDeviceId();
        await queueMediaStatusUpdate({
          messageId: responseMessageId,
          chatId: responseChatId,
          deviceId,
          isMediaDownloaded: true,
        });
        return;
      }

      if (sameId(responseChatId, currentChatId)) {
        handleMediaDownloadedUpdate(source);
      }
    };

    registerSocketHandler('message:media:update', handleMediaDownloadedUpdate);
    registerSocketHandler('message:media:update:response', handleMediaUpdateResponse);
    registerSocketHandler('message:media:downloaded:update', handleMediaDownloadedUpdate);
    registerSocketHandler('message:media:downloaded:response', handleMediaUpdateResponse);
    registerSocketHandler('message:media:downloaded', handleMediaDownloadedUpdate);

    const onMessageFetchResponse = (data) => {
      const source = data?.data || data;
      const rows = source?.messages || source?.docs || [];
      if (Array.isArray(rows) && rows.length > 0) {
        if (forceReloadPendingRef.current) {
          replaceMessagesForChat(rows, currentChatId);
          forceReloadPendingRef.current = false;
        } else {
          mergeMessagesIntoState(rows);
        }
      } else if (forceReloadPendingRef.current) {
        replaceMessagesForChat([], currentChatId);
        forceReloadPendingRef.current = false;
      }
      if (typeof source?.hasMore === 'boolean') {
        setHasMoreMessages(source.hasMore);
      }
      setIsLoadingMore(false);
      setIsRefreshing(false);
      setIsManualReloading(false);
      loadMoreInFlightRef.current = false;
      fetchOlderCursorRef.current = null;
      isHardReloadingRef.current = false;
    };
    registerSocketHandler('message:fetch:response', onMessageFetchResponse);

    const onMessageSyncResponse = (data) => {
      if (isHardReloadingRef.current) {
        isHardReloadingRef.current = false;
        setIsLoadingMore(false);
        loadMoreInFlightRef.current = false;
        return;
      }

      const source = data?.data || data;
      const rows = source?.messages || [];
      if (Array.isArray(rows) && rows.length > 0) {
        mergeMessagesIntoState(rows);
        const latestTs = rows.reduce((acc, msg) => {
          const ts = new Date(msg?.createdAt || msg?.timestamp || 0).getTime();
          return Math.max(acc, Number.isNaN(ts) ? 0 : ts);
        }, 0);
        if (latestTs > 0) {
          lastMessageSyncAtRef.current = Math.max(lastMessageSyncAtRef.current, latestTs);
        }
      }

      // Apply the mutation delta (edits/deletes done while away) to stored rows,
      // then advance the per-chat mutation cursor.
      const mutated = source?.mutatedMessages;
      if (Array.isArray(mutated) && mutated.length > 0) {
        applyMutatedMessagesRef.current?.(mutated, currentChatId, source?.latestMutationAt);
      } else if (Number(source?.latestMutationAt) > 0) {
        setMutationCursor(currentChatId, source.latestMutationAt);
      }

      // Do NOT touch hasMoreMessages here. `message:sync` is the on-open
      // FORWARD delta (messages newer than our seq cursor) — its hasMore /
      // emptiness says "no more NEWER messages", while hasMoreMessages gates
      // OLDER-history scroll-up. Writing it here made pagination die on any
      // already-caught-up chat (delta returns 0 rows → flag false → scroll-up
      // no-ops). Older-history exhaustion is owned by loadMoreMessages via
      // the `message:history` response + the persisted hist_done marker.

      // Reset loading states — critical for stopping the spinner
      setIsLoadingMore(false);
      setIsRefreshing(false);
      loadMoreInFlightRef.current = false;
    };
    registerSocketHandler('message:sync:response', onMessageSyncResponse);
    // Also handle group sync response with the same logic
    registerSocketHandler('group:message:sync:response', onMessageSyncResponse);

    // ─── GROUP-SPECIFIC MESSAGE LISTENERS ───
    const groupOwnId = chatData?.groupId || chatData?.group?._id;
    const isGroupEvent = (source) => {
      const gid = source?.groupId || source?.group?._id || source?.group;
      const cid = source?.chatId || source?.chat;
      return sameId(gid, currentChatId) || sameId(cid, currentChatId) || sameId(gid, groupOwnId) || sameId(cid, groupOwnId);
    };

    const onGroupMessageNew = (data) => {
      const source = data?.data || data;
      if (!isGroupEvent(source)) return;
      // This screen's group was left / removed — don't show incoming messages.
      if (amNotGroupMemberRef.current) return;

      // Block cancelled/failed
      if (source?.status === 'cancelled' || source?.status === 'failed') return;
      // Block scheduled/processing ONLY if scheduleTime is still in the future
      if (source?.status === 'scheduled' || source?.status === 'processing') {
        const st = source?.scheduleTime || source?.schedule_time;
        const stMs = st ? new Date(st).getTime() : 0;
        const isDeliveryNow = source?.isScheduled === false || !st || !Number.isFinite(stMs) || stMs <= Date.now() + 5000;
        if (!isDeliveryNow) return;
      }

      const msgId = source?.messageId || source?._id || source?.id;
      if (msgId && handledMsgIds.has(String(msgId))) return;
      if (msgId) handledMsgIds.add(String(msgId));

      // If this is our own scheduled message being delivered by the server,
      // transition it from scheduledMessages → allMessages (same as onScheduledSentAck)
      const isSelf = source?.senderId && sameId(source.senderId, currentUserIdRef.current);
      if (isSelf && msgId) {
        const inScheduled = scheduledMessagesRef.current.some(m =>
          m.id === msgId || m.serverMessageId === msgId || m.tempId === msgId
        );
        if (inScheduled) {
          // Transition: remove from scheduledMessages, add as sent
          setScheduledMessages(prev => {
            const match = prev.find(m => m.id === msgId || m.serverMessageId === msgId || m.tempId === msgId);
            if (match) {
              const sentMsg = {
                ...match,
                ...source,
                id: msgId,
                serverMessageId: msgId,
                status: 'sent',
                isScheduled: false,
                wasScheduled: true,
                scheduleTimeLabel: match.scheduleTimeLabel || null,
                scheduleTime: null,
                chatId: currentChatId,
                senderType: 'self',
              };
              setAllMessages(all => [sentMsg, ...all.filter(m =>
                m.id !== msgId && m.serverMessageId !== msgId && m.tempId !== (match.tempId || '__none__')
              )]);
            }
            return prev.filter(m => m.id !== msgId && m.serverMessageId !== msgId && m.tempId !== msgId);
          });
          ChatDatabase.clearScheduleData(msgId, 'sent').catch(() => {});
          return; // handled — don't pass to handleReceivedMessage
        }
      }

      // For receiver side: strip isScheduled if scheduleTime has passed, mark wasScheduled
      if (!isSelf && source?.isScheduled) {
        const schedTime = source?.scheduleTime || source?.schedule_time;
        const st = schedTime ? new Date(schedTime).getTime() : 0;
        if (Number.isFinite(st) && st > Date.now() + 5000) return; // premature, block
        source.wasScheduled = true;
        source.isScheduled = false;
        source.scheduleTime = null;
      }

      handleReceivedMessage({
        ...source,
        chatId: currentChatId,
      });
    };
    registerSocketHandler('group:message:new', onGroupMessageNew);
    registerSocketHandler('group:message:received', onGroupMessageNew);

    // ── group:joined — insert "X created this group" system message into chat ──
    const onGroupJoinedForChat = (data) => {
      const source = data?.data || data;
      const gid = source?.groupId || source?.group?._id;
      if (!gid) return;
      // Only handle if this group is the currently open chat
      if (!sameId(gid, currentChatId) && !sameId(gid, groupOwnId)) return;

      const creatorName = source?.createdByName || source?.creatorName || source?.username || source?.fullName || '';
      const groupName = source?.groupName || source?.name || '';
      const sysText = creatorName
        ? `${creatorName} created group "${groupName || 'this group'}"`
        : `Group "${groupName || ''}" created`;
      const sysId = source?.messageId || `sys_created_${gid}_${Date.now()}`;

      // Avoid duplicating if already in messages
      const alreadyExists = allMessagesRef.current?.some(m =>
        (m.id === sysId || m.text === sysText) && m.type === 'system'
      );
      if (alreadyExists) return;

      const systemMsg = {
        id: sysId,
        tempId: sysId,
        type: 'system',
        messageType: 'system',
        text: sysText,
        senderId: null,
        senderType: 'system',
        status: 'sent',
        chatId: currentChatId,
        createdAt: source?.joinedAt ? new Date(source.joinedAt).toISOString() : new Date().toISOString(),
        timestamp: source?.joinedAt || Date.now(),
      };

      setAllMessages(prev => [...prev, systemMsg]);
      ChatDatabase.upsertMessage({ ...systemMsg, chatId: currentChatId }).catch(() => {});
    };
    registerSocketHandler('group:joined', onGroupJoinedForChat);
    registerSocketHandler('group:member:joined', (data) => {
      const source = data?.data || data;
      const gid = source?.groupId || source?.group?._id;
      if (!gid || (!sameId(gid, currentChatId) && !sameId(gid, groupOwnId))) return;
      const memberName = source?.username || source?.fullName || source?.name || '';
      const sysId = source?.messageId || `sys_joined_${source?.userId || ''}_${Date.now()}`;
      const sysText = memberName ? `${memberName} joined` : 'A member joined';

      const alreadyExists = allMessagesRef.current?.some(m =>
        (m.id === sysId || m.text === sysText) && m.type === 'system'
      );
      if (alreadyExists) return;

      const systemMsg = {
        id: sysId,
        tempId: sysId,
        type: 'system',
        messageType: 'system',
        text: sysText,
        senderId: null,
        senderType: 'system',
        status: 'sent',
        chatId: currentChatId,
        createdAt: source?.timestamp ? new Date(source.timestamp).toISOString() : new Date().toISOString(),
        timestamp: source?.timestamp || Date.now(),
      };

      setAllMessages(prev => [...prev, systemMsg]);
      ChatDatabase.upsertMessage({ ...systemMsg, chatId: currentChatId }).catch(() => {});
    });
    registerSocketHandler('group:member:left', (data) => {
      const source = data?.data || data;
      const gid = source?.groupId || source?.group?._id;
      if (!gid || (!sameId(gid, currentChatId) && !sameId(gid, groupOwnId))) return;
      const memberName = source?.username || source?.fullName || source?.name || '';
      const sysId = source?.messageId || `sys_left_${source?.userId || ''}_${Date.now()}`;
      const sysText = memberName ? `${memberName} left` : 'A member left';

      const systemMsg = {
        id: sysId,
        tempId: sysId,
        type: 'system',
        messageType: 'system',
        text: sysText,
        senderId: null,
        senderType: 'system',
        status: 'sent',
        chatId: currentChatId,
        createdAt: source?.timestamp ? new Date(source.timestamp).toISOString() : new Date().toISOString(),
        timestamp: source?.timestamp || Date.now(),
      };

      setAllMessages(prev => [...prev, systemMsg]);
      ChatDatabase.upsertMessage({ ...systemMsg, chatId: currentChatId }).catch(() => {});
    });

    // ─── GROUP PROFILE (name / avatar / description) LIVE HEADER UPDATES ───
    // When an admin/owner changes the group while this chat is open, update the
    // header instantly via the liveGroupMeta overlay (keyed by groupId).
    const applyGroupMeta = (source, patch) => {
      const gid = source?.groupId || source?.group?._id;
      if (!gid || (!sameId(gid, currentChatId) && !sameId(gid, groupOwnId))) return;
      setLiveGroupMeta(prev => ({ ...(prev?.groupId === String(gid) ? prev : {}), groupId: String(gid), ...patch }));
    };
    registerSocketHandler('group:name:updated', (data) => {
      const s = data?.data || data; if (s?.name != null) applyGroupMeta(s, { name: s.name });
    });
    registerSocketHandler('group:avatar:updated', (data) => {
      const s = data?.data || data; const av = s?.avatarUrl || s?.avatar; if (av != null) applyGroupMeta(s, { avatar: av });
    });
    registerSocketHandler('group:description:updated', (data) => {
      const s = data?.data || data; if (s?.description != null) applyGroupMeta(s, { description: s.description });
    });

    const onGroupMessageEdited = async (data) => {
      const source = data?.data || data;
      if (!isGroupEvent(source)) return;
      const messageId = source?.messageId || source?._id;
      if (!messageId) return;
      // SQLite-first: update in DB then refresh UI
      await ChatDatabase.updateMessageEdit(messageId, source?.text, source?.editedAt || new Date().toISOString());
      refreshMessagesFromDB();
    };
    registerSocketHandler('group:message:edited', onGroupMessageEdited);

    // ─── GROUP MESSAGE DELETE HANDLERS ───

    // group:message:deleted — broadcast to ALL group members (including sender).
    // This is the ONLY event that should trigger UI/DB updates.
    const onGroupMessageDeleted = (data) => {
      const source = data?.data || data;
      console.log('[DELETE:GROUP:BROADCAST]', JSON.stringify(source));

      if (!isGroupEvent(source)) return;

      const messageId = normalizeId(source?.messageId || source?._id || source?.id);
      if (!messageId) return;

      const isEveryoneDel = Boolean(source?.deleteForEveryone);
      const deletedBy = normalizeId(source?.deletedBy || source?.senderId || source?.userId);

      if (isEveryoneDel) {
        // Delete for everyone — update for all members
        handleDeleteMessage(messageId, true, { deletedBy });
      } else {
        // Delete for me — only the user who deleted sees the removal.
        // If we are the one who deleted, it was already handled optimistically.
        // If another user deleted for themselves, we should NOT see any change.
        if (sameId(deletedBy, currentUserIdRef.current)) {
          refreshMessagesFromDB();
        }
      }
    };
    registerSocketHandler('group:message:deleted', onGroupMessageDeleted);

    // group:message:delete:success — confirmation to the SENDER only.
    // Used only for logging / hiding pending indicator.
    // Do NOT re-trigger UI update here — optimistic update already handled it.
    const onGroupMessageDeleteSuccess = (data) => {
      const source = data?.data || data;
      console.log('[DELETE:GROUP:SUCCESS]', source?.messageId);
      // No-op: optimistic update + broadcast handler already cover everything.
    };
    registerSocketHandler('group:message:delete:success', onGroupMessageDeleteSuccess);

    // WhatsApp group-tick semantics: a single member's receipt must NOT flip
    // the bubble — 'delivered' only when ALL recipients have it, blue only
    // when ALL read. The backend recomputes that aggregate and ships it as
    // `aggregate` (single receipt) or `aggregateStatuses` (bulk read map:
    // messageId → status). Per-user receipt maps are still tracked locally for
    // the message-info breakdown. Without aggregate info the status is left
    // untouched — never blind-advance off one receipt.
    const GROUP_TICK_RANK = { sent: 1, delivered: 2, seen: 3, read: 4 };
    const resolveAggregateStatus = (msg, mid, source) => {
      const fromBulk = source?.aggregateStatuses?.[String(mid)];
      const agg = source?.aggregate;
      const candidate = fromBulk
        || (agg?.allRead ? 'read' : (agg?.allDelivered ? 'delivered' : null));
      if (!candidate) return msg.status;
      const currentRank = GROUP_TICK_RANK[msg.status] || 0;
      const nextRank = GROUP_TICK_RANK[candidate] || 0;
      return nextRank > currentRank ? candidate : msg.status;
    };

    const onGroupMessageDelivered = (data) => {
      const source = data?.data || data;
      if (!isGroupEvent(source)) return;
      const messageIds = source?.messageIds || [source?.messageId].filter(Boolean);
      const userId = source?.userId || (typeof source?.deliveredTo === 'string' ? source.deliveredTo : null);
      const deliveredAt = source?.deliveredAt || new Date().toISOString();
      setAllMessages((prev) => {
        let changed = false;
        const updated = prev.map((msg) => {
          const id = msg.serverMessageId || msg.id || msg.tempId;
          if (!messageIds.some(mid => sameId(mid, id))) return msg;
          // Skip scheduled/processing/cancelled/failed — not real messages yet
          if (msg.status === 'scheduled' || msg.status === 'processing' || msg.status === 'cancelled' || msg.status === 'failed') return msg;
          // Track per-user delivery
          let rowChanged = false;
          const deliveredTo = { ...(msg.deliveredTo || {}) };
          if (userId && !deliveredTo[userId]) {
            deliveredTo[userId] = deliveredAt;
            rowChanged = true;
          }
          // Tick advances only on the backend's all-recipients aggregate
          const newStatus = resolveAggregateStatus(msg, msg.serverMessageId || msg.id, source);
          if (newStatus !== msg.status) rowChanged = true;
          if (!rowChanged) return msg;
          changed = true;
          return { ...msg, status: newStatus, deliveredTo };
        });
        if (changed) {
          saveMessagesToLocal(updated);
          updateChatListLastMessagePreview(updated);
        }
        return changed ? updated : prev;
      });
    };
    registerSocketHandler('group:message:delivered:update', onGroupMessageDelivered);
    registerSocketHandler('group:message:delivered', onGroupMessageDelivered);
    registerSocketHandler('group:message:delivered:receipt', onGroupMessageDelivered);

    const onGroupMessageRead = (data) => {
      const source = data?.data || data;
      if (!isGroupEvent(source)) return;
      const messageIds = source?.messageIds || [source?.messageId].filter(Boolean);
      // Per-member room broadcasts carry the reader as `readBy` (scalar),
      // sender-directed updates carry `userId`.
      const userId = source?.userId || (typeof source?.readBy === 'string' ? source.readBy : null);
      const readAt = source?.readAt || new Date().toISOString();
      // Ignore our own read events
      if (userId && sameId(userId, currentUserIdRef.current)) return;
      setAllMessages((prev) => {
        let changed = false;
        const updated = prev.map((msg) => {
          const id = msg.serverMessageId || msg.id || msg.tempId;
          if (!messageIds.some(mid => sameId(mid, id))) return msg;
          // Skip scheduled/processing/cancelled/failed — not real messages yet
          if (msg.status === 'scheduled' || msg.status === 'processing' || msg.status === 'cancelled' || msg.status === 'failed') return msg;
          // Track per-user read
          let rowChanged = false;
          const readBy = { ...(msg.readBy || {}) };
          if (userId && !readBy[userId]) {
            readBy[userId] = readAt;
            rowChanged = true;
          }
          // Tick advances only on the backend's all-recipients aggregate —
          // one reader must not turn the whole group bubble blue.
          const newStatus = resolveAggregateStatus(msg, msg.serverMessageId || msg.id, source);
          if (newStatus !== msg.status) rowChanged = true;
          if (!rowChanged) return msg;
          changed = true;
          return { ...msg, status: newStatus, readBy };
        });
        if (changed) {
          saveMessagesToLocal(updated);
          updateChatListLastMessagePreview(updated);
        }
        return changed ? updated : prev;
      });
    };
    registerSocketHandler('group:message:read:update', onGroupMessageRead);
    registerSocketHandler('group:message:read', onGroupMessageRead);

    // Helper: apply a reaction change to allMessages in-memory + persist to SQLite (no full reload)
    const applyReactionUpdate = (messageId, updater) => {
      if (!messageId) return;
      // Accept either a single id or an array of candidate ids
      // (canonical messageId, Mongo _id, clientMessageId) — match any.
      const candidates = (Array.isArray(messageId) ? messageId : [messageId])
        .filter(Boolean)
        .map(String);
      if (candidates.length === 0) return;
      const mid = candidates[0];
      const idSet = new Set(candidates);
      setAllMessages(prev => {
        let changed = false;
        const updated = prev.map(m => {
          const isMatch =
            idSet.has(String(m.id || '')) ||
            idSet.has(String(m.serverMessageId || '')) ||
            idSet.has(String(m.tempId || ''));
          if (!isMatch) return m;
          changed = true;
          // Deep-copy each emoji entry, skip invalid keys (numeric "0","1", etc.)
          const copy = {};
          if (m.reactions && typeof m.reactions === 'object' && !Array.isArray(m.reactions)) {
            for (const [k, v] of Object.entries(m.reactions)) {
              if (/^\d+$/.test(k) || !k || k === 'undefined' || k === 'null') continue;
              if (v && Array.isArray(v.users)) {
                copy[k] = { count: v.users.length, users: [...v.users] };
              }
            }
          }
          const newReactions = updater(copy);
          // Sanitize output — only keep valid emoji keys with valid users
          const sanitized = {};
          if (newReactions && typeof newReactions === 'object') {
            for (const [k, v] of Object.entries(newReactions)) {
              if (/^\d+$/.test(k) || !k || k === 'undefined' || k === 'null') continue;
              if (v && Array.isArray(v.users) && v.users.length > 0) {
                sanitized[k] = { count: v.users.length, users: v.users };
              }
            }
          }
          const finalReactions = Object.keys(sanitized).length > 0 ? sanitized : undefined;
          // Persist to SQLite + memory cache
          SqliteWriter.enqueue('updateReactions', { messageId: mid, reactions: finalReactions || null }).catch(() => {});
          ChatCache.updateMessage(chatIdRef.current, mid, { reactions: finalReactions });
          return { ...m, reactions: finalReactions };
        });
        if (!changed) {
          console.log('[Reaction] ⚠️ NO message found for id:', mid, '| total msgs:', prev.length, '| sample ids:', prev.slice(0, 3).map(m => ({ id: m.id, sid: m.serverMessageId, tid: m.tempId })));
        }
        return changed ? updated : prev;
      });
    };

    // Group reaction handler — processes broadcasts from server to all group members
    const onGroupReactionUpdate = (data) => {
      const source = data?.data || data;

      // Extract fields from ALL levels (server nests differently per event)
      const reactionUserId = source?.userId || data?.userId || source?.user || data?.senderId;
      const emoji = source?.emoji || data?.emoji;
      const action = source?.action || data?.action || (emoji ? 'add' : null);
      const messageId = source?.messageId || data?.messageId || source?._id;

      // Check group match
      if (!isGroupEvent(source) && !isGroupEvent(data)) return;
      if (!messageId) return;

      // If server sends full reactions map, apply for ALL users (no self-echo skip)
      const rawReactions = source?.reactions || source?.reaction || data?.reactions;
      if (rawReactions && typeof rawReactions === 'object') {
        const normalized = sanitizeReactions(rawReactions);
        if (normalized) {
          applyReactionUpdate(messageId, () => normalized);
          return;
        }
      }

      // Success confirmation without userId — sender already applied optimistically, skip
      if (!reactionUserId) return;

      // Self-echo for incremental — sender already applied, skip
      if (sameId(reactionUserId, currentUserIdRef.current)) return;

      if (!emoji) return;

      // Apply incremental update for OTHER users' reactions
      applyReactionUpdate(messageId, (reactions) => {
        if (action === 'remove') {
          const existing = reactions[emoji] || { count: 0, users: [] };
          reactions[emoji] = {
            count: Math.max(0, existing.count - 1),
            users: existing.users.filter(u => String(u) !== String(reactionUserId)),
          };
          if (reactions[emoji].count === 0) delete reactions[emoji];
        } else {
          // Add — remove from all emojis first (one-reaction-per-user)
          for (const [k, d] of Object.entries(reactions)) {
            const idx = (d.users || []).findIndex(u => String(u) === String(reactionUserId));
            if (idx !== -1) {
              d.users.splice(idx, 1);
              d.count = Math.max(0, d.count - 1);
              if (d.count === 0) delete reactions[k];
            }
          }
          const entry = reactions[emoji] || { count: 0, users: [] };
          if (!entry.users.some(u => String(u) === String(reactionUserId))) {
            entry.users.push(reactionUserId);
          }
          entry.count = entry.users.length;
          reactions[emoji] = entry;
        }
        return reactions;
      });
    };
    registerSocketHandler('group:message:reaction:success', onGroupReactionUpdate);
    registerSocketHandler('group:message:reaction:update', onGroupReactionUpdate);
    registerSocketHandler('group:message:reaction', onGroupReactionUpdate);
    registerSocketHandler('group:message:reacted', onGroupReactionUpdate);
    registerSocketHandler('group:message:reaction:response', onGroupReactionUpdate);
    registerSocketHandler('group:reaction', onGroupReactionUpdate);
    registerSocketHandler('group:reaction:update', onGroupReactionUpdate);

    // ── group:message:media:updated — media download status broadcast ──
    const onGroupMessageMediaUpdated = (data) => {
      const source = data?.data || data;
      if (!isGroupEvent(source)) return;
      const messageId = source?.messageId || source?._id;
      if (!messageId) return;
      setAllMessages(prev => {
        const idx = prev.findIndex(m => m.id === messageId || m.serverMessageId === messageId);
        if (idx === -1) return prev;
        const updated = [...prev];
        updated[idx] = {
          ...updated[idx],
          isMediaDownloaded: source?.isMediaDownloaded ?? updated[idx].isMediaDownloaded,
          messageType: source?.messageType || updated[idx].messageType || updated[idx].type,
        };
        return updated;
      });
      // Also persist to SQLite
      ChatDatabase.upsertMessage({
        id: messageId,
        chatId: currentChatId,
        isMediaDownloaded: source?.isMediaDownloaded,
      }).catch(() => {});
    };
    registerSocketHandler('group:message:media:updated', onGroupMessageMediaUpdated);

    // ── 1-on-1 reaction: apply server's authoritative reaction state ──
    const applyServerReactions = (source) => {
      // Server now emits canonical messageId + _id (and echoes clientMessageId).
      // Try each in turn so we still match when the local copy was keyed by
      // a temp id or only the Mongo _id.
      const candidateIds = [
        source?.messageId,
        source?.message,
        source?._id,
        source?.id,
        source?.clientMessageId,
      ].filter(Boolean);
      const messageId = candidateIds;
      if (!messageId.length) {
        console.log('[Reaction] ⚠️ No messageId in source:', source);
        return;
      }
      const chatId = source?.chatId || source?.chat;
      if (chatId && !sameId(chatId, currentChatId)) return;

      // If server sends full reactions (object map OR array), normalize and apply
      const rawReactions = source?.reactions || source?.reaction;
      if (rawReactions && typeof rawReactions === 'object') {
        const normalized = sanitizeReactions(rawReactions);
        if (normalized) {
          console.log('[Reaction] Applying server reactions for', messageId, JSON.stringify(normalized));
          applyReactionUpdate(messageId, () => normalized);
          return;
        }
      }

      // Otherwise apply incremental update from individual fields
      const reactionUserId = source?.userId || source?.user || source?.reactedBy || source?.senderId;
      const emoji = source?.emoji;
      const action = source?.action;

      if (!emoji || !reactionUserId) {
        console.log('[Reaction] ⚠️ Missing emoji or userId for incremental update:', { emoji, reactionUserId });
        return;
      }

      console.log('[Reaction] Applying incremental:', action, emoji, 'by', reactionUserId, 'on', messageId);

      if (action === 'remove') {
        applyReactionUpdate(messageId, (reactions) => {
          const existing = reactions[emoji] || { count: 0, users: [] };
          reactions[emoji] = {
            count: Math.max(0, existing.count - 1),
            users: existing.users.filter(u => String(u) !== String(reactionUserId)),
          };
          if (reactions[emoji].count === 0) delete reactions[emoji];
          return reactions;
        });
      } else {
        applyReactionUpdate(messageId, (reactions) => {
          // Remove user from ALL emojis first (one-reaction-per-user)
          for (const [k, d] of Object.entries(reactions)) {
            const idx = d.users.findIndex(u => String(u) === String(reactionUserId));
            if (idx !== -1) {
              d.users.splice(idx, 1);
              d.count = Math.max(0, d.count - 1);
              if (d.count === 0) delete reactions[k];
            }
          }
          const entry = reactions[emoji] || { count: 0, users: [] };
          if (!entry.users.some(u => String(u) === String(reactionUserId))) {
            entry.users.push(String(reactionUserId));
          }
          entry.count = entry.users.length;
          reactions[emoji] = entry;
          return reactions;
        });
      }
    };

    // Dedup guard — broadcast and :response fire for the same reaction, only process once
    const reactionDedup = new Map();
    const isReactionDuplicate = (messageId, emoji, userId) => {
      const key = `${messageId}|${emoji}|${userId}`;
      const now = Date.now();
      if (reactionDedup.has(key) && now - reactionDedup.get(key) < 2000) return true;
      reactionDedup.set(key, now);
      // Cleanup old entries
      if (reactionDedup.size > 100) {
        for (const [k, t] of reactionDedup) { if (now - t > 5000) reactionDedup.delete(k); }
      }
      return false;
    };

    // ── Broadcast: message:reaction:added (server sends to ALL users in chat) ──
    const onMessageReactionAdded = (data) => {
      console.log('[Reaction] broadcast added received:', JSON.stringify(data));
      const source = data?.data || data;
      const chatId = source?.chatId || source?.chat;
      if (chatId && !sameId(chatId, currentChatId)) return;
      const mid = source?.messageId || source?.message || source?._id || source?.id;
      const emoji = source?.emoji;
      const uid = source?.userId || source?.user || source?.reactedBy || source?.senderId;
      if (mid && emoji && uid && isReactionDuplicate(mid, emoji, uid)) return;
      applyServerReactions({ ...source, action: 'add' });
    };
    registerSocketHandler('message:reaction:added', onMessageReactionAdded);
    registerSocketHandler('message:reaction', onMessageReactionAdded);
    registerSocketHandler('message:reaction:update', onMessageReactionAdded);

    // ── Broadcast: message:reaction:removed (server sends to ALL users in chat) ──
    const onMessageReactionRemoved = (data) => {
      console.log('[Reaction] broadcast removed received:', JSON.stringify(data));
      const source = data?.data || data;
      const chatId = source?.chatId || source?.chat;
      if (chatId && !sameId(chatId, currentChatId)) return;
      const mid = source?.messageId || source?.message || source?._id || source?.id;
      const emoji = source?.emoji;
      const uid = source?.userId || source?.user || source?.reactedBy || source?.senderId;
      if (mid && emoji && uid && isReactionDuplicate(mid, emoji, uid)) return;
      applyServerReactions({ ...source, action: 'remove' });
    };
    registerSocketHandler('message:reaction:removed', onMessageReactionRemoved);

    // ── :response events — also handled with dedup guard ──
    const onReactionAddResponse = (data) => {
      console.log('[Reaction] add:response received:', JSON.stringify(data));
      const source = data?.data || data;
      const mid = source?.messageId || source?._id || source?.id;
      const emoji = source?.emoji;
      const uid = source?.userId || source?.user || source?.senderId;
      if (mid && emoji && uid && isReactionDuplicate(mid, emoji, uid)) return;
      applyServerReactions({ ...source, action: 'add' });
    };
    registerSocketHandler('message:reaction:add:response', onReactionAddResponse);

    const onReactionRemoveResponse = (data) => {
      console.log('[Reaction] remove:response received:', JSON.stringify(data));
      const source = data?.data || data;
      const mid = source?.messageId || source?._id || source?.id;
      const emoji = source?.emoji;
      const uid = source?.userId || source?.user || source?.senderId;
      if (mid && emoji && uid && isReactionDuplicate(mid, emoji, uid)) return;
      applyServerReactions({ ...source, action: 'remove' });
    };
    registerSocketHandler('message:reaction:remove:response', onReactionRemoveResponse);

    const onMessageDeleteEveryone = (data) => {
      console.log('🧪 [B:SOCKET:DELETE:RECV]', {
        event: 'message:delete:everyone',
        raw: data,
      });
      const source = data?.data || data;
      const messageId = source?.messageId || source?._id || source?.id;
      const chatId = source?.chatId || source?.chat || source?.roomId;
      const gid = source?.groupId || source?.group?._id || source?.group;
      // Match by chatId OR groupId (group deletes may arrive on generic events)
      if (!sameId(chatId, currentChatId) && !sameId(gid, currentChatId) && !sameId(gid, groupOwnId)) return;
      handleDeleteMessage(messageId, true, { deletedBy: source?.deletedBy || source?.senderId || source?.userId });
    };
    registerSocketHandler('message:delete:everyone', onMessageDeleteEveryone);

    const onMessageDeleteMe = (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId || source?._id || source?.id;
      const chatId = source?.chatId || source?.chat || source?.roomId;
      const deletedBy = source?.deletedBy;
      const isDeleteForEveryone = (
        source?.deleteForEveryone === true ||
        source?.deleted === true ||
        source?.deleteFor === 'everyone' ||
        source?.delete_type === 'everyone'
      );
      if (isDeleteForEveryone) return;
      if (!sameId(chatId, currentChatId)) return;
      if (!deletedBy || sameId(deletedBy, currentUserIdRef.current)) {
        handleDeleteMessage(messageId, false, { deletedBy });
      }
    };
    registerSocketHandler('message:delete:me', onMessageDeleteMe);

    const onMessageDeleted = (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId || source?._id || source?.id;
      const chatIdInPayload = source?.chatId || source?.chat || source?.roomId;
      const gidInPayload = source?.groupId || source?.group?._id || source?.group;
      const deleteFor = source?.deleteFor || source?.delete_type || (source?.isDeletedForEveryone ? 'everyone' : 'me') || 'everyone';
      // Match by chatId OR groupId
      const matchesChat = chatIdInPayload ? sameId(chatIdInPayload, currentChatId) : false;
      const matchesGroup = gidInPayload ? (sameId(gidInPayload, currentChatId) || sameId(gidInPayload, groupOwnId)) : false;
      if (!messageId || (!matchesChat && !matchesGroup && chatIdInPayload)) return;
      handleDeleteMessage(messageId, deleteFor === 'everyone', { deletedBy: source?.deletedBy || source?.senderId || source?.userId });
    };
    registerSocketHandler('message:deleted', onMessageDeleted);

    const onMessageDeleteSync = (data) => {
      const source = data?.data || data;
      const messageId = source?.messageId || source?._id || source?.id;
      const chatIdInPayload = source?.chatId || source?.chat || source?.roomId;
      if (!messageId || (chatIdInPayload && !sameId(chatIdInPayload, currentChatId))) return;
      handleDeleteMessage(messageId, false, { deletedBy: source?.deletedBy || source?.senderId || source?.userId });
    };
    registerSocketHandler('message:delete:sync', onMessageDeleteSync);

    const onMessageDeleteEveryoneResponse = async (data) => {
      const source = data?.data || data || {};

      if (source?.status === false || source?.success === false) {
        // ROLLBACK (CANNOT_DELETE_FOR_EVERYONE / DELETE_TIMEOUT): restore the
        // optimistically-deleted message from its snapshot + drop the tombstone.
        const failedId = source?.messageId || source?._id || source?.id;
        const snapKey = failedId != null ? String(failedId) : null;
        const snapshot = snapKey ? pendingDeleteSnapshotsRef.current[snapKey] : null;
        if (snapshot) {
          delete pendingDeleteSnapshotsRef.current[snapKey];
          await removeDeletedTombstone(failedId);
          const restored = { ...snapshot, isDeleted: false, deletedFor: null, deletedBy: null, placeholderText: null };
          // Directly un-delete in SQLite (upsert can only RAISE is_deleted).
          ChatDatabase.restoreDeletedMessage(failedId, restored).catch(() => {});
          setAllMessages(prev => {
            const exists = prev.some(m =>
              sameId(m.serverMessageId, failedId) || sameId(m.id, failedId) || sameId(m.tempId, failedId)
            );
            if (exists) {
              return prev.map(m => {
                const isMatch = sameId(m.serverMessageId, failedId) || sameId(m.id, failedId) || sameId(m.tempId, failedId);
                return isMatch ? restored : m;
              });
            }
            return [...prev, restored];
          });
        }
        const code = source?.code || source?.error;
        Alert.alert('Delete failed', source?.message || (code ? String(code) : 'Failed to delete message for everyone'));
        return;
      }
      const messageId = source?.messageId || source?._id || source?.id;
      if (messageId) delete pendingDeleteSnapshotsRef.current[String(messageId)];
      const responseChatId = source?.chatId || source?.chat || source?.roomId;
      const isDeleteForEveryone = (
        source?.deleteForEveryone === true ||
        source?.deleted === true ||
        source?.deleteFor === 'everyone' ||
        source?.delete_type === 'everyone'
      );
      if (!messageId || !responseChatId || !isDeleteForEveryone) {
        console.warn('message:delete:everyone:response invalid payload', source);
        return;
      }
      const deletedBy = source?.deletedBy || source?.senderId || source?.userId || currentUserIdRef.current;
      const normalizedResponseChatId = normalizeId(responseChatId);
      if (sameId(normalizedResponseChatId, currentChatId)) {
        handleDeleteMessage(messageId, true, { deletedBy });
        return;
      }
      const result = await applyDeleteEveryoneToChatStorage(normalizedResponseChatId, messageId, { deletedBy });
      if (!result?.ok) {
        console.warn('message:delete:everyone:response local storage update failed', {
          chatId: normalizedResponseChatId,
          messageId,
          reason: result?.reason,
        });
      }
    };
    registerSocketHandler('message:delete:everyone:response', onMessageDeleteEveryoneResponse);

    const onMessageDeleteResponse = async (data) => {
      console.log('🧪 [B:SOCKET:DELETE:RECV]', {
        event: 'message:delete:response',
        raw: data,
      });

      const source = data?.data || data || {};
      const messageId = source?.messageId || source?._id || source?.id;
      const responseChatId = source?.chatId || source?.chat || source?.roomId;
      const isDeleteForEveryone = (
        source?.deleteForEveryone === true ||
        source?.deleted === true ||
        source?.deleteFor === 'everyone' ||
        source?.delete_type === 'everyone'
      );

      if (!messageId || !responseChatId || !isDeleteForEveryone) {
        return;
      }

      const deletedBy = source?.deletedBy || source?.senderId || source?.userId || currentUserIdRef.current;
      const normalizedResponseChatId = normalizeId(responseChatId);

      if (sameId(normalizedResponseChatId, currentChatId)) {
        handleDeleteMessage(messageId, true, { deletedBy });
        return;
      }

      await applyDeleteEveryoneToChatStorage(normalizedResponseChatId, messageId, { deletedBy });
    };
    registerSocketHandler('message:delete:response', onMessageDeleteResponse);

    const onMessageDeleteMeResponse = (data) => {
      if (data.status === false) Alert.alert("Error", data.message || "Failed to delete message");
    };
    registerSocketHandler('message:delete:me:response', onMessageDeleteMeResponse);

    const onPresenceUpdate = (data) => {
      if (data.userId === chatData.peerUser._id || data?.data?.userId === chatData.peerUser._id) {
        applyPresenceState(data);
      }
    };
    registerSocketHandler('presence:update', onPresenceUpdate);

    const onPresenceGetResponse = (data) => {
      if (data.userId === chatData.peerUser._id || data?.data?.userId === chatData.peerUser._id) {
        applyPresenceState(data);
      }
    };
    registerSocketHandler('presence:get:response', onPresenceGetResponse);

    const onPresenceStatusResponse = (data) => {
      if (data.userId === chatData.peerUser._id || data?.data?.userId === chatData.peerUser._id) {
        applyPresenceState(data);
      }
    };
    registerSocketHandler('presence:status:response', onPresenceStatusResponse);

    const onPresenceManualUpdated = (data) => {
      const sourceUserId = data.userId || data?.data?.userId;
      if (sourceUserId === chatData.peerUser._id) {
        applyPresenceState(data);
      }
    };
    registerSocketHandler('presence:manual:updated', onPresenceManualUpdated);

    const onUserOnline = (data) => {
      console.log("user:online", data);
      if (data.userId === chatData.peerUser._id) { 
        setUserStatus(PRESENCE_STATUS.ONLINE);
        setLastSeen(null); 
      }
    };
    registerSocketHandler('user:online', onUserOnline);

    const onUserOffline = (data) => {
      console.log("user:offline", data);
      if (data.userId === chatData.peerUser._id) { 
        setUserStatus(PRESENCE_STATUS.OFFLINE);
        setLastSeen(data.lastSeen || new Date().toISOString()); 
      }
    };
    registerSocketHandler('user:offline', onUserOffline);

    // Typing event handlers — support both 1:1 and group chats
    const isGroupChat = chatData.chatType === 'group' || chatData.isGroup;
    const matchesTypingSender = (senderId, chatIdInPayload) => {
      if (!senderId || String(senderId) === String(currentUserIdRef.current)) return false;
      const chatIdMatch = chatIdInPayload && (
        chatIdInPayload === currentChatId ||
        chatIdInPayload === chatData.groupId ||
        chatIdInPayload === chatData.group?._id
      );
      if (isGroupChat) {
        // For groups: any other member typing in this group chat
        return chatIdMatch;
      }
      // For 1:1: match peer user
      return chatData.peerUser?._id && senderId === chatData.peerUser._id &&
        (!chatIdInPayload || chatIdInPayload === currentChatId);
    };

    const startPeerTyping = () => {
      setIsPeerTyping(true);
      if (peerTypingTimeoutRef.current) clearTimeout(peerTypingTimeoutRef.current);
      peerTypingTimeoutRef.current = setTimeout(() => {
        setIsPeerTyping(false);
        peerTypingTimeoutRef.current = null;
      }, TYPING_TIMEOUT);
    };

    const stopPeerTyping = () => {
      setIsPeerTyping(false);
      if (peerTypingTimeoutRef.current) {
        clearTimeout(peerTypingTimeoutRef.current);
        peerTypingTimeoutRef.current = null;
      }
    };

    const onTypingStart = (data) => {
      const senderId = data.userId || data.senderId || data.from;
      const chatIdInPayload = data.chatId || data.groupId || data.roomId;
      if (matchesTypingSender(senderId, chatIdInPayload)) startPeerTyping();
    };
    registerSocketHandler('typing:start', onTypingStart);
    if (isGroupChat) {
      registerSocketHandler('group:typing:started', onTypingStart);
      registerSocketHandler('group:typing:start', onTypingStart);
    }

    const onTypingStop = (data) => {
      const chatIdInPayload = data.chatId || data.groupId || data.roomId;
      if (chatIdInPayload && (chatIdInPayload === currentChatId || chatIdInPayload === chatData.groupId || chatIdInPayload === chatData.group?._id)) {
        stopPeerTyping();
      }
    };
    registerSocketHandler('typing:stop', onTypingStop);
    if (isGroupChat) {
      registerSocketHandler('group:typing:stopped', onTypingStop);
      registerSocketHandler('group:typing:stop', onTypingStop);
    }

    // Handle recording as typing
    const onTypingRecording = (data) => {
      const senderId = data.userId || data.senderId || data.from;
      const chatIdInPayload = data.chatId || data.groupId || data.roomId;
      if (matchesTypingSender(senderId, chatIdInPayload)) startPeerTyping();
    };
    registerSocketHandler('typing:recording', onTypingRecording);

    const onTypingRecordingUpdate = (data) => {
      const senderId = data.userId || data.senderId || data.from;
      const chatIdInPayload = data.chatId || data.groupId || data.roomId;
      if (matchesTypingSender(senderId, chatIdInPayload)) startPeerTyping();
    };
    registerSocketHandler('typing:recording:update', onTypingRecordingUpdate);

    const onDisconnect = () => {
      setUserStatus(PRESENCE_STATUS.OFFLINE);
      setIsPeerTyping(false); // Reset typing state on disconnect
      stopHeartbeat();
      setTimeout(() => { if (isComponentMounted.current) checkAndReconnectSocket(); }, 2000);
    };
    registerSocketHandler('disconnect', onDisconnect);

    const onConnect = () => {
      reconnectAttempts.current = 0;
      requestUserPresence();
      flushQueuedManualPresence();
      flushQueuedMediaStatusUpdates();
      startHeartbeat();
      markUserOnline("socket-connect");
      socket.emit('chat:join', { chatId: currentChatId, userId: currentUserIdRef.current });
      socket.emit('user:status', { userId: currentUserIdRef.current, status: 'online', chatId: currentChatId });
      // pendingInitialFetch = the on-open fetch for an EMPTY local chat never
      // emitted (cold start, socket was still connecting). It must be the FULL
      // fetch here — initializeChat may have already finished (setting
      // initialLoadDoneRef), and a seq-delta over an empty local store is not
      // guaranteed to backfill history.
      const owesInitialFetch = pendingInitialFetchRef.current;
      if (owesInitialFetch || !initialLoadDoneRef.current) {
        const emitted = fetchAndSyncMessagesViaSocket(currentChatId, { limit: SOCKET_FETCH_LIMIT });
        if (emitted) {
          pendingInitialFetchRef.current = false;
          _lastChatSyncAt.set(currentChatId, Date.now());
        }
      } else {
        fetchAndSyncMessagesViaSocket(currentChatId, { limit: SOCKET_FETCH_LIMIT, syncOnly: true });
      }
    };
    registerSocketHandler('connect', onConnect);

    const onChatClearedMe = (data) => {
      const source = data?.data || data || {};
      const targetChatId = source?.chatId || source?.chat || source?.roomId;
      if (!targetChatId) return;
      applyChatClearedLocally(targetChatId, 'me');
    };
    registerSocketHandler('chat:cleared:me', onChatClearedMe);

    const onChatClearedEveryone = (data) => {
      const source = data?.data || data || {};
      const targetChatId = source?.chatId || source?.chat || source?.roomId;
      if (!targetChatId) return;
      applyChatClearedLocally(targetChatId, 'everyone');
    };
    registerSocketHandler('chat:cleared:everyone', onChatClearedEveryone);
  }, [
    chatData.peerUser,
    removeSocketListeners,
    requestUserPresence,
    checkAndReconnectSocket,
    applyPresenceState,
    flushQueuedManualPresence,
    flushQueuedMediaStatusUpdates,
    startHeartbeat,
    stopHeartbeat,
    markUserOnline,
    updateMessageStatus,
    mergeMessagesIntoState,
    replaceMessagesForChat,
    applyDeleteEveryoneToChatStorage,
    applyMediaDownloadedStateLocally,
    getOrCreateDeviceId,
    queueMediaStatusUpdate,
    saveMessagesToLocal,
    applyChatClearedLocally,
    setMutationCursor,
    removeDeletedTombstone,
  ]);

  const removeDuplicateMessages = useCallback((messagesArr) => {
    const seen = new Set();
    return messagesArr.filter((msg) => {
      const ids = [msg.serverMessageId, msg.id, msg.tempId].filter(Boolean).map(String);
      if (ids.length === 0) return true; // no IDs → keep (can't dedup)
      if (ids.some(id => seen.has(id))) return false;
      ids.forEach(id => seen.add(id));
      return true;
    });
  }, []);

  const updateMessageStatus = useCallback(async (tempId, status, serverData = null) => {
    const normalizedStatus = normalizeMessageStatus(status) || status;
    const serverMessageId = serverData?.messageId || serverData?._id;

    // Do NOT update status for messages that are scheduled/processing/cancelled/failed
    // These statuses are managed by their own dedicated handlers
    const PROTECTED_STATUSES = new Set(['scheduled', 'processing', 'cancelled', 'failed']);

    // Check if this message is in scheduledMessages (protected from delivery/read updates)
    const checkId = serverMessageId || tempId;
    if (checkId) {
      const scheduled = scheduledMessagesRef.current || [];
      const isProtected = scheduled.some(m =>
        PROTECTED_STATUSES.has(m.status) &&
        (m.id === checkId || m.serverMessageId === checkId || m.tempId === checkId)
      );
      if (isProtected && (normalizedStatus === 'delivered' || normalizedStatus === 'seen' || normalizedStatus === 'read')) {
        return; // Block delivery/read/seen for scheduled/processing/cancelled/failed messages
      }
    }

    // INSTANT UI: update status in state immediately (no flicker)
    // Mirrors the SQLite guard in ChatDatabase.updateMessageStatus so the live
    // ticks and the persisted truth agree.
    const STATUS_OWNED_BY_HANDLERS = new Set(['scheduled', 'processing', 'cancelled']);
    setAllMessages(prev => {
      let changed = false;
      const updated = prev.map(m => {
        const isMatch = (tempId && (m.id === tempId || m.tempId === tempId)) ||
                        (serverMessageId && (m.id === serverMessageId || m.serverMessageId === serverMessageId));
        if (!isMatch) return m;

        // Never downgrade a live message: a late 'delivered' must not undo 'seen',
        // a stale 'sent' must not undo 'delivered', etc. 'failed' is the one
        // exception (an error state may replace a higher one), and scheduled/
        // processing/cancelled are owned by their dedicated handlers.
        let nextStatus = normalizedStatus;
        if (normalizedStatus !== 'failed') {
          if (STATUS_OWNED_BY_HANDLERS.has(m.status)) {
            nextStatus = m.status;
          } else if (getMessageStatusPriority(normalizedStatus) < getMessageStatusPriority(m.status)) {
            nextStatus = m.status;
          }
        }

        const needsIdSync = !!serverMessageId &&
          (m.serverMessageId !== serverMessageId || m.id !== serverMessageId || !m.synced);
        if (nextStatus === m.status && !needsIdSync) return m;

        changed = true;
        return {
          ...m,
          status: nextStatus,
          ...(serverMessageId ? { serverMessageId, id: serverMessageId, synced: true } : {}),
        };
      });
      return changed ? updated : prev;
    });

    // Background: persist to SQLite
    if (serverMessageId && tempId && serverMessageId !== tempId) {
      ChatDatabase.acknowledgeMessage(tempId, serverMessageId).catch(() => {});
      const tempReply = await ChatDatabase.getReplyData(tempId);
      if (tempReply) {
        ChatDatabase.saveReplyData(serverMessageId, tempReply).catch(() => {});
      }
    }

    const targetId = serverMessageId || tempId;
    if (targetId) {
      SqliteWriter.enqueue('updateMessageStatus', { id: targetId, status: normalizedStatus }).catch(() => {});
    }

    // Debounced DB refresh (merge strategy preserves optimistic messages)
    refreshMessagesFromDB();

    // Update chat list preview
    const currentMsgs = allMessagesRef.current || [];
    if (currentMsgs.length > 0) {
      updateChatListLastMessagePreview(currentMsgs);
    }
  }, [
    normalizeMessageStatus,
    getMessageStatusPriority,
    refreshMessagesFromDB,
    updateChatListLastMessagePreview,
  ]);

  const sendMessageViaSocket = useCallback((payload, tempId) => {
    return new Promise(async (resolve, reject) => {
      try {
        const isGroupPayload = payload?.chatType === 'group' || payload?.groupId;
        const isReplyPayload = Boolean(payload?.replyToMessageId);
        const isQuotePayload = Boolean(payload?.quotedMessageId && payload?.quotedText);
        // message:reply for 1-on-1 replies, message:quote for 1-on-1 quotes with embedded text,
        // group:message:send for groups (reply/quote data embedded in payload)
        const sendEvent = isGroupPayload
          ? 'group:message:send'
          : isQuotePayload
            ? 'message:quote'
            : isReplyPayload
              ? 'message:reply'
              : 'message:send';

        // Track tempId for reply/quote response handlers (server responses lack tempId)
        if (sendEvent === 'message:reply' || sendEvent === 'message:quote') {
          pendingReplyTempIdRef.current = tempId;
        }

        // The server now echoes both the canonical messageId AND the
        // clientMessageId (== our tempId) in the ack. Match on
        // clientMessageId to be 100% certain we're updating the right
        // optimistic row, then write `server_message_id` to SQLite.
        const reconcile = (ack) => {
          const ackData = ack?.data || ack || {};
          const serverMessageId =
            ackData.messageId || ackData._id || ack?.messageId || ack?._id;
          const ackClientId =
            ackData.clientMessageId || ack?.clientMessageId ||
            ackData.tempId          || ack?.tempId          || null;
          // Trust the echo when present; otherwise fall back to our own
          // tempId (server may be older and not echoing yet).
          const targetTempId = ackClientId || tempId;
          if (!serverMessageId || !targetTempId) return;
          updateMessageStatus(targetTempId, 'sent', { messageId: serverMessageId, ...ackData });
          // SQLite — swap `id = temp_xxx` for the canonical `server_message_id`
          // so all future actions (reply / react / read / edit / delete) use
          // the server-recognized id, not the temp one.
          ChatDatabase.acknowledgeMessage(targetTempId, serverMessageId).catch(() => {});
          // Socket delivered it — drop the durable outbox row so the REST drain
          // worker never re-sends. (Server dedupes on (chatId, clientMessageId)
          // anyway, but removing it keeps the happy path socket-only.)
          ChatDatabase.outboxRemove(targetTempId).catch(() => {});
        };

        // Shared ack handler — runs for both the live emit and the queued
        // (offline) replay that flushPendingEmitQueue fires on reconnect.
        const onAck = (response) => {
          if (response && (response.status === true || response.success === true || response.data)) {
            reconcile(response);
            return resolve(response);
          } else if (response && response.status === false) {
            updateMessageStatus(tempId, 'failed');
            return reject(new Error(response.message || 'send failed'));
          } else {
            reconcile(response);
            const serverMessageId = response?.messageId || response?._id;
            if (serverMessageId) return resolve(response);
            return resolve({ status: true, noAck: true });
          }
        };

        // clientMessageId is the explicit idempotency key the server stores on the
        // doc and echoes back. `tempId` is kept as a legacy alias. Because it
        // dedupes server-side, replaying a queued message after reconnect can
        // never create a duplicate.
        const emitPayload = {
          ...payload,
          clientMessageId: tempId,
          tempId,
          // Local-first contract aliases (additive, non-breaking). The backend
          // accepts either spelling; emitting both keeps the wire self-describing
          // across all three packages. See repo-root MESSAGING_CONTRACT.md.
          clientId: tempId,
          content: payload?.text ?? '',
          type: payload?.messageType,
        };

        const socket = socketRef.current || getSocket();
        if (!socket || !isSocketConnected()) {
          // OFFLINE — do NOT drop the message (the old behaviour: it was marked
          // 'failed' and lost, the root cause of "messages I sent never reached
          // the other device"). Instead QUEUE it: emitSocketEvent buffers it in
          // pendingEmitQueue and replays it — WITH this same ack — the instant the
          // socket reconnects. Keep it visibly 'sending' (clock); it flips to
          // 'sent' once the queued emit flushes and the ack returns.
          console.warn('⚠️ sendMessageViaSocket: socket offline → queued for reconnect');
          updateMessageStatus(tempId, 'sending');
          emitSocketEvent(sendEvent, emitPayload, onAck);
          return resolve({ status: true, queued: true });
        }

        // ONLINE — keep the honest 'sending' clock until the server confirms.
        // The single tick comes from the ack (inline callback or the global
        // message:sent:ack / group:message:sent event handlers); a pre-ack
        // 'sent' lied whenever the server never stored the message, and for
        // groups there was no retry path behind it.
        updateMessageStatus(tempId, 'sending');
        socket.emit(sendEvent, emitPayload, onAck);
        resolve({ status: true, optimistic: true });
      } catch (err) {
        console.error("❌ sendMessageViaSocket error:", err);
        updateMessageStatus(tempId, 'failed');
        return reject(err);
      }
    });
  }, [updateMessageStatus]);

  /* ========== Text send flow ========== */
  const handleSendText = useCallback(async (mentions) => {
    if (!text.trim()) return;
    if (amNotGroupMemberRef.current) return; // left / removed from group — can't send

    const tempId = `temp_${Date.now()}_${Math.random()}`;
    const timestamp = new Date().toISOString();
    sentTempIdsRef.current.add(tempId);

    const isGrpSend = chatData.chatType === 'group' || chatData.isGroup;
    const mentionsArray = Array.isArray(mentions) && mentions.length > 0 ? mentions : undefined;

    // Build reply metadata if replying
    const currentReply = replyTarget;
    const replyToMsgId = currentReply
      ? (currentReply.serverMessageId || currentReply.id || currentReply.tempId)
      : null;
    // Resolve reply sender name — in 1-on-1 chats, senderName may be missing
    let resolvedReplySenderName = currentReply?.senderName || null;
    if (!resolvedReplySenderName && currentReply?.senderId) {
      if (sameId(currentReply.senderId, currentUserIdRef.current)) {
        resolvedReplySenderName = currentUserNameRef.current || 'You';
      } else if (chatData?.peerUser?.fullName) {
        resolvedReplySenderName = chatData.peerUser.fullName;
      } else if (groupMembersMapRef.current?.[currentReply.senderId]?.fullName) {
        resolvedReplySenderName = groupMembersMapRef.current[currentReply.senderId].fullName;
      }
    }
    const quotedText = currentReply
      ? (currentReply.isDeleted ? 'This message was deleted' : (currentReply.text || ''))
      : null;
    const replyMeta = currentReply ? {
      replyToMessageId: replyToMsgId,
      replyPreviewText: quotedText,
      replyPreviewType: currentReply.type || 'text',
      replySenderName: resolvedReplySenderName,
      replySenderId: currentReply.senderId || null,
    } : {};

    const payload = {
      receiverId: isGrpSend ? null : (chatData.peerUser?._id || null),
      messageType: "text",
      chatType: chatData.chatType || 'private',
      text: text.trim(),
      mediaUrl: '',
      mediaMeta: {},
      forwardedFrom: null,
      chatId: chatIdRef.current,
      senderId: currentUserIdRef.current,
      senderName: currentUserNameRef.current || '',
      tempId,
      createdAt: timestamp,
      ...(isGrpSend && { groupId: chatData.groupId || chatData.group?._id || chatIdRef.current }),
      ...(mentionsArray && { mentions: mentionsArray }),
      // Reply data — include full preview so receivers can display it without lookup
      ...(replyToMsgId && {
        replyToMessageId: replyToMsgId,
        replyTo: {
          _id: replyToMsgId,
          text: quotedText || '',
          messageType: currentReply?.type || 'text',
          senderId: currentReply?.senderId || null,
          senderName: resolvedReplySenderName || null,
        },
        replyPreviewText: quotedText || '',
        replyPreviewType: currentReply?.type || 'text',
        replySenderName: resolvedReplySenderName || null,
        replySenderId: currentReply?.senderId || null,
      }),
    };

    onLocalOutgoingMessage({
      chatId: chatIdRef.current,
      senderId: currentUserIdRef.current,
      text: text.trim(),
      createdAt: timestamp,
      ...(isGrpSend
        ? { groupId: chatData.groupId || chatData.group?._id || chatIdRef.current }
        : {
            peerUser: chatData?.peerUser
              ? {
                  ...chatData.peerUser,
                  _id: chatData.peerUser._id || chatData.peerUser.userId || chatData.peerUser.id || null,
                }
              : null,
          }),
    });

    const newMessage = {
      id: tempId,
      tempId,
      type: "text",
      text: text.trim(),
      time: moment(timestamp).format("hh:mm A"),
      date: moment(timestamp).format("YYYY-MM-DD"),
      senderId: currentUserIdRef.current,
      senderName: currentUserNameRef.current || '',
      senderType: 'self',
      receiverId: isGrpSend ? null : (chatData.peerUser?._id || null),
      chatType: chatData.chatType || 'private',
      // WhatsApp semantics: clock icon until the SERVER confirms via
      // message:sent:ack / group:message:sent — never a pre-ack single tick.
      status: "sending",
      createdAt: timestamp,
      timestamp: new Date(timestamp).getTime(),
      payload,
      synced: false,
      chatId: chatIdRef.current,
      ...(isGrpSend && { groupId: chatData.groupId || chatData.group?._id || chatIdRef.current }),
      ...(mentionsArray && { mentions: mentionsArray }),
      ...replyMeta,
    };

    setText("");
    if (currentReply) setReplyTarget(null);
    markUserOnline("send-message");

    if (isLocalTyping) {
      sendTypingStatus(false);
      setIsLocalTyping(false);
    }
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }

    // Save reply data to permanent reply table (never overwritten)
    if (newMessage.replyToMessageId) {
      ChatDatabase.saveReplyData(tempId, {
        replyToMessageId: newMessage.replyToMessageId,
        replyPreviewText: newMessage.replyPreviewText,
        replyPreviewType: newMessage.replyPreviewType,
        replySenderName: newMessage.replySenderName,
        replySenderId: newMessage.replySenderId,
      }).catch(() => {});
    }

    // INSTANT UI: Add message to state immediately (WhatsApp-style optimistic update)
    // Don't wait for SQLite — show it NOW, persist in background
    ChatCache.addMessage(chatIdRef.current, newMessage);
    setAllMessages(prev => {
      const updated = [newMessage, ...prev];
      return updated;
    });

    // Write to SQLite in background (non-blocking)
    ChatDatabase.upsertMessage({ ...newMessage, chatId: chatIdRef.current }).catch(err => {
      console.warn('[handleSendText] SQLite write failed:', err?.message);
    });

    // Durable outbox for BOTH 1-1 and group sends: persist the send so it
    // survives an app kill while offline. The OutboxWorker drains 1-1 rows via
    // REST and group rows via a socket re-emit (the REST send endpoint requires
    // a receiverId, which is why groups used to be excluded — and a group
    // message composed offline was silently LOST on app kill). The socket
    // fast-path below races the worker and removes the row on ack, so on the
    // happy path the worker never fires (4s grace window). The server dedupes
    // on (chatId, clientMessageId), so a race can't duplicate.
    if (isGrpSend || chatData.peerUser?._id) {
      // REST createMessage expects replyTo as an id + replyPreview as an object;
      // the socket payload carries replyTo as an embedded object, so remap for
      // the REST-based outbox worker (1-1 only — group rows replay the socket
      // payload verbatim). clientMessageId is the cross-transport dedupe key,
      // so a socket+REST race can't duplicate.
      const outboxPayload = isGrpSend
        ? { ...payload, clientMessageId: tempId, clientId: tempId, tempId }
        : {
            ...payload,
            clientMessageId: tempId,
            ...(replyToMsgId
              ? {
                  replyTo: replyToMsgId,
                  replyPreview: {
                    text: quotedText || '',
                    messageType: currentReply?.type || 'text',
                    senderName: resolvedReplySenderName || null,
                    senderId: currentReply?.senderId || null,
                  },
                }
              : {}),
          };
      ChatDatabase.outboxEnqueue({
        clientMessageId: tempId,
        chatId: chatIdRef.current,
        payload: outboxPayload,
        notBefore: Date.now() + 4000,
      }).then(() => OutboxWorker.wake()).catch(() => {});
    }

    // Fire-and-forget socket send — message is already in UI via optimistic update.
    // If the socket is down, kick a reconnect but DON'T drop the message:
    // sendMessageViaSocket buffers it in the in-memory queue (replayed with its
    // ack on reconnect), and the durable outbox above is the app-kill safety net.
    const socket = socketRef.current || getSocket();
    if (!socket || !isSocketConnected()) {
      checkAndReconnectSocket();
    }

    sendMessageViaSocket(payload, tempId).catch((error) => {
      console.error("Send message failed:", error);
      updateMessageStatus(tempId, 'failed');
    });
  }, [text, replyTarget, chatData.peerUser, sendTypingStatus, updateMessageStatus, checkAndReconnectSocket, isLocalTyping, markUserOnline, onLocalOutgoingMessage, sendMessageViaSocket, refreshMessagesFromDB]);

  /* ========== Schedule message flow ========== */
  const scheduleMessage = useCallback(async (scheduleTime) => {
    if (!text.trim() || !scheduleTime) return;
    if (amNotGroupMemberRef.current) return; // left / removed from group — can't send

    const msgText = text.trim();
    const tempId = `temp_sched_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const timestamp = new Date().toISOString();
    const isGrpSend = chatData.chatType === 'group' || chatData.isGroup;

    const scheduledDate = new Date(scheduleTime);
    const schedTimeStr = scheduledDate.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit', hour12: true });
    const schedDateStr = scheduledDate.toLocaleDateString('en', { month: 'short', day: 'numeric' });

    const receiverId = isGrpSend ? null : (chatData.peerUser?._id || null);
    const groupId = isGrpSend ? (chatData.groupId || chatData.group?._id || chatIdRef.current) : null;

    const newMessage = {
      id: tempId,
      tempId,
      type: 'text',
      text: msgText,
      time: moment(timestamp).format('hh:mm A'),
      date: moment(timestamp).format('YYYY-MM-DD'),
      senderId: currentUserIdRef.current,
      senderName: currentUserNameRef.current || '',
      senderType: 'self',
      receiverId,
      chatType: chatData.chatType || 'private',
      status: 'scheduled',
      createdAt: timestamp,
      timestamp: new Date(timestamp).getTime(),
      synced: false,
      chatId: chatIdRef.current,
      isScheduled: true,
      scheduleTime: scheduleTime,
      scheduleTimeLabel: `${schedDateStr}, ${schedTimeStr}`,
      ...(isGrpSend && { groupId }),
    };

    setText('');

    // Instant UI — show with clock icon on sender side only (separate state)
    setScheduledMessages(prev => [newMessage, ...prev]);

    // Persist locally
    ChatDatabase.upsertMessage({ ...newMessage, chatId: chatIdRef.current }).catch(() => {});

    if (isGrpSend) {
      // ── GROUP: server-side scheduling ──
      // Server supports group:message:schedule — same pattern as 1-on-1.
      // Server holds the message and delivers at scheduleTime via group:message:sent + group:message:received.
      const socket = socketRef.current || getSocket();
      if (socket && isSocketConnected()) {
        socket.emit('group:message:schedule', {
          groupId,
          text: msgText,
          messageType: 'text',
          scheduleTime: scheduleTime,
        }, (ack) => {
          if (ack?.error) {
            console.warn('[Schedule] Group server error:', ack.error);
            setScheduledMessages(prev => prev.map(m =>
              m.tempId === tempId ? { ...m, status: 'failed' } : m
            ));
          }
        });
      } else {
        setScheduledMessages(prev => prev.map(m =>
          m.tempId === tempId ? { ...m, status: 'failed' } : m
        ));
      }
    } else {
      // ── 1-on-1: server-side scheduling ──
      const socket = socketRef.current || getSocket();
      if (socket && isSocketConnected()) {
        socket.emit('message:schedule', {
          receiverId,
          text: msgText,
          messageType: 'text',
          scheduleTime: scheduleTime,
        }, (ack) => {
          if (ack?.error) {
            console.warn('[Schedule] Server error:', ack.error);
            setScheduledMessages(prev => prev.map(m =>
              m.tempId === tempId ? { ...m, status: 'failed' } : m
            ));
          }
        });
      } else {
        setScheduledMessages(prev => prev.map(m =>
          m.tempId === tempId ? { ...m, status: 'failed' } : m
        ));
      }
    }
  }, [text, chatData, updateMessageStatus]);

  const cancelScheduledMessage = useCallback(async (messageId) => {
    if (!messageId) return;

    // Track cancelled ID — block this message from reaching receiver even if server delivers it
    cancelledMsgIdsRef.current.add(String(messageId));
    // Also track all ID variants from scheduledMessages
    const scheduled = scheduledMessagesRef.current || [];
    const match = scheduled.find(m =>
      m.id === messageId || m.serverMessageId === messageId || m.tempId === messageId
    );
    const allIds = match
      ? [match.id, match.serverMessageId, match.tempId].filter(Boolean)
      : [messageId];
    allIds.forEach(id => cancelledMsgIdsRef.current.add(String(id)));

    // Clear group schedule timer if exists
    for (const id of allIds) {
      const timer = groupScheduleTimersRef.current.get(id);
      if (timer) {
        clearTimeout(timer);
        groupScheduleTimersRef.current.delete(id);
      }
    }

    // Determine the best server-side ID to send for cancel
    const serverMsgId = match?.serverMessageId || match?.id || messageId;
    const isGrpCancel = chatData?.chatType === 'group' || chatData?.isGroup;

    // Move from scheduledMessages → allMessages with status 'cancelled' (in-place, no flicker)
    setScheduledMessages(prev => {
      const found = prev.find(m =>
        m.id === messageId || m.serverMessageId === messageId || m.tempId === messageId
      );
      if (found) {
        const cancelledMsg = {
          ...found,
          status: 'cancelled',
          isScheduled: false,
          scheduleTimeLabel: null,
          scheduleTime: null,
        };
        setAllMessages(all => [cancelledMsg, ...all.filter(m =>
          m.id !== messageId && m.serverMessageId !== messageId && m.tempId !== messageId
        )]);
      }
      return prev.filter(m =>
        m.id !== messageId && m.serverMessageId !== messageId && m.tempId !== messageId
      );
    });

    // Persist: clear schedule data, set status cancelled — persist ALL known IDs
    const clearPromises = [...new Set(allIds)].map(id =>
      ChatDatabase.clearScheduleData(id, 'cancelled').catch(() => {})
    );
    Promise.all(clearPromises).then(() => refreshMessagesFromDB());

    // Tell server to cancel
    const socket = socketRef.current || getSocket();
    if (socket && isSocketConnected()) {
      if (isGrpCancel) {
        // Group: server-side cancel
        socket.emit('group:message:cancel:scheduled', {
          messageId: serverMsgId,
          groupId: chatData?.groupId || chatData?.group?._id || chatIdRef.current,
        }, (ack) => {
          if (ack?.error) console.warn('[Schedule] group cancel error:', ack.error);
        });
      } else {
        // 1-on-1: server-side cancel
        socket.emit('message:cancel:scheduled', {
          messageId: serverMsgId,
          tempId: match?.tempId || null,
        }, (ack) => {
          if (ack?.error) console.warn('[Schedule] cancel error:', ack.error);
        });
      }
    }
  }, [chatData]);

  const sendLocationMessage = useCallback(async ({ latitude, longitude, address = '', mapPreviewUrl = '' } = {}) => {
    if (amNotGroupMemberRef.current) return; // left / removed from group — can't send
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error('invalid location coordinates');
    }

    const tempId = `temp_location_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timestamp = new Date().toISOString();

    const isGrpLoc = chatData?.chatType === 'group' || chatData?.isGroup;
    const payload = {
      receiverId: isGrpLoc ? null : (chatData.peerUser?._id || null),
      chatType: chatData?.chatType || 'private',
      ...(isGrpLoc && { groupId: chatData?.groupId || chatData?.group?._id || chatIdRef.current }),
      messageType: 'location',
      text: address || 'Shared location',
      mediaUrl: mapPreviewUrl || `https://maps.google.com/?q=${lat},${lng}`,
      mediaMeta: {
        latitude: lat,
        longitude: lng,
        address: address || '',
        mapPreviewUrl: mapPreviewUrl || `https://maps.google.com/?q=${lat},${lng}`,
      },
      replyTo: null,
      forwardedFrom: null,
      chatId: chatIdRef.current,
      senderId: currentUserIdRef.current,
      senderName: currentUserNameRef.current || '',
      tempId,
      createdAt: timestamp,
    };

    onLocalOutgoingMessage({
      chatId: chatIdRef.current,
      senderId: currentUserIdRef.current,
      text: 'Location',
      createdAt: timestamp,
      peerUser: chatData?.peerUser ? {
        ...chatData.peerUser,
        _id: chatData.peerUser._id || chatData.peerUser.userId || chatData.peerUser.id || null,
      } : null,
    });

    const localMsg = {
      id: tempId,
      tempId,
      type: 'location',
      mediaType: 'location',
      text: payload.text,
      mediaUrl: payload.mediaUrl,
      previewUrl: payload.mediaUrl,
      mediaMeta: payload.mediaMeta,
      time: moment(timestamp).format('hh:mm A'),
      date: moment(timestamp).format('YYYY-MM-DD'),
      senderId: currentUserIdRef.current,
      senderType: 'self',
      receiverId: chatData.peerUser?._id || null,
      status: 'sent',
      createdAt: timestamp,
      timestamp: new Date(timestamp).getTime(),
      payload,
      chatId: chatIdRef.current,
    };

    // INSTANT UI: show message immediately
    setAllMessages((prev) => [localMsg, ...prev]);

    // Write to SQLite in background (non-blocking)
    ChatDatabase.upsertMessage({ ...localMsg, chatId: chatIdRef.current }).catch(() => {});

    // Fire-and-forget socket send
    sendMessageViaSocket(payload, tempId).catch(() => {
      updateMessageStatus(tempId, 'failed');
    });
    return { success: true, tempId };
  }, [chatData.peerUser, deduplicateMessages, onLocalOutgoingMessage, saveMessagesToLocal, sendMessageViaSocket, updateMessageStatus]);

  const sendContactMessage = useCallback(async ({
    fullName, countryCode = '', mobileNumber,
    userId = null, profileImage = '', isRegistered = false,
  } = {}) => {
    if (amNotGroupMemberRef.current) return; // left / removed from group — can't send
    const name = String(fullName || '').trim();
    const phone = String(mobileNumber || '').trim();
    if (!name || !phone) {
      throw new Error('missing contact details');
    }

    const tempId = `temp_contact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const messageId = generateClientMessageId();
    const timestamp = new Date().toISOString();
    const senderDeviceId = await getOrCreateDeviceId();

    const contactData = {
      fullName: name,
      countryCode: countryCode || '',
      mobileNumber: phone,
      userId: userId || null,
      profileImage: profileImage || '',
      isRegistered: !!isRegistered,
    };

    const isGrpContact = chatData?.chatType === 'group' || chatData?.isGroup;
    const payload = {
      chatId: chatIdRef.current,
      messageId,
      chatType: chatData?.chatType || 'private',
      ...(isGrpContact && { groupId: chatData?.groupId || chatData?.group?._id || chatIdRef.current }),
      senderId: currentUserIdRef.current,
      senderName: currentUserNameRef.current || '',
      senderDeviceId,
      receiverId: isGrpContact ? null : (chatData.peerUser?._id || null),
      messageType: 'contact',
      text: name,
      contact: contactData,
      mediaId: null,
      mediaUrl: null,
      mediaThumbnailUrl: null,
      mediaMeta: {},
      replyTo: null,
      forwardedFrom: null,
      tempId,
      createdAt: timestamp,
      timestamp: new Date(timestamp).getTime(),
    };

    onLocalOutgoingMessage({
      chatId: chatIdRef.current,
      senderId: currentUserIdRef.current,
      text: `Contact: ${name}`,
      createdAt: timestamp,
      peerUser: chatData?.peerUser ? {
        ...chatData.peerUser,
        _id: chatData.peerUser._id || chatData.peerUser.userId || chatData.peerUser.id || null,
      } : null,
    });

    const localMsg = {
      id: tempId,
      tempId,
      serverMessageId: messageId,
      type: 'contact',
      mediaType: 'contact',
      text: name,
      mediaUrl: profileImage || '',
      previewUrl: profileImage || '',
      mediaMeta: contactData,
      payload: { contact: contactData, isMediaDownloaded: false },
      time: moment(timestamp).format('hh:mm A'),
      date: moment(timestamp).format('YYYY-MM-DD'),
      senderId: currentUserIdRef.current,
      senderType: 'self',
      receiverId: chatData.peerUser?._id || null,
      status: 'sent',
      createdAt: timestamp,
      timestamp: new Date(timestamp).getTime(),
      synced: false,
      chatId: chatIdRef.current,
    };

    // INSTANT UI: show message immediately
    setAllMessages((prev) => [localMsg, ...prev]);

    // Write to SQLite in background (non-blocking)
    ChatDatabase.upsertMessage({ ...localMsg, chatId: chatIdRef.current }).catch(() => {});

    // Fire-and-forget socket send — message already shown via optimistic UI
    const socket = socketRef.current || getSocket();
    if (!socket || !isSocketConnected()) {
      updateMessageStatus(tempId, 'failed');
      checkAndReconnectSocket();
      return { success: false, tempId };
    }

    sendMessageViaSocket(payload, tempId).catch(() => {
      updateMessageStatus(tempId, 'sent', { messageId });
    });

    return { success: true, tempId };
  }, [chatData.peerUser, deduplicateMessages, onLocalOutgoingMessage, saveMessagesToLocal, sendMessageViaSocket, getOrCreateDeviceId, updateMessageStatus, checkAndReconnectSocket]);

  /* ========== FIXED: Text input change handler with proper typing ========== */
  const handleTextChange = useCallback((value) => {
    setText(value);
    resetIdleTimer();
    emitPresenceActivity({ reason: "typing" });

    if (value.length > 0) {
      // If we weren't typing before, send typing:start
      if (!isLocalTyping) {
        sendTypingStatus(true);
        setIsLocalTyping(true);
      }
      
      // Clear existing timeout
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      
      // Set new timeout to stop typing after inactivity
      typingTimeoutRef.current = setTimeout(() => {
        if (isLocalTyping) {
          sendTypingStatus(false);
          setIsLocalTyping(false);
        }
        typingTimeoutRef.current = null;
      }, TYPING_TIMEOUT);
      
    } else {
      // Text is empty, stop typing
      if (isLocalTyping) {
        sendTypingStatus(false);
        setIsLocalTyping(false);
      }
      
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
    }
  }, [sendTypingStatus, isLocalTyping, resetIdleTimer, emitPresenceActivity]);

  const handleReceivedMessage = useCallback(async (msg) => {
    resetIdleTimer();

    const isSelfMsg = msg?.senderId && sameId(msg.senderId, currentUserIdRef.current);
    const schedTimeVal = msg?.scheduleTime || msg?.schedule_time;
    const schedMs = schedTimeVal ? new Date(schedTimeVal).getTime() : 0;
    const isScheduledDelivery = msg?.isScheduled && (!schedTimeVal || !Number.isFinite(schedMs) || schedMs <= Date.now() + 5000);

    // Block still-pending scheduled/processing messages — UNLESS it's a delivery (scheduleTime passed)
    if ((msg?.status === 'scheduled' || msg?.status === 'processing') && !isScheduledDelivery) {
      console.log('[Schedule] Blocking pending scheduled message from handleReceivedMessage:', msg?.messageId || msg?._id);
      return;
    }
    // Block cancelled/failed messages
    if (msg?.status === 'cancelled' || msg?.status === 'failed') {
      console.log('[Schedule] Blocking cancelled/failed message from handleReceivedMessage:', msg?.messageId || msg?._id);
      return;
    }
    // For receiver: if isScheduled but scheduleTime has NOT passed → block premature
    if (!isSelfMsg && msg?.isScheduled) {
      if (Number.isFinite(schedMs) && schedMs > Date.now() + 5000) {
        console.log('[Schedule] Blocking premature isScheduled message on receiver side:', msg?.messageId || msg?._id);
        return;
      }
      // scheduleTime has passed — strip active schedule flags, keep label for display
      msg.wasScheduled = true;
      msg.isScheduled = false;
      msg.scheduleTime = null;
      msg.schedule_time = null;
      // Keep scheduleTimeLabel for visual indicator
      if (msg?.status === 'scheduled' || msg?.status === 'processing') {
        msg.status = 'sent';
      }
    }
    // Block messages with future scheduleTime on sender side (safety net)
    if (isSelfMsg && msg?.scheduleTime) {
      const schedTime = new Date(msg.scheduleTime).getTime();
      if (Number.isFinite(schedTime) && schedTime > Date.now() + 5000) {
        console.log('[Schedule] Ignoring premature scheduled message:', msg?.messageId || msg?._id);
        return;
      }
    }

    // A real message from the peer means they are no longer typing — clear the
    // "typing…" indicator the instant the bubble lands instead of waiting up to
    // TYPING_TIMEOUT for it to auto-expire (otherwise it lingers AFTER the
    // message is already visible, which reads as "typing when not typing").
    if (!isSelfMsg) {
      setIsPeerTyping(false);
      if (peerTypingTimeoutRef.current) {
        clearTimeout(peerTypingTimeoutRef.current);
        peerTypingTimeoutRef.current = null;
      }
    }

    // Debug: log forwarded message fields from server
    if (msg?.isForwarded || msg?.forwarded || msg?.forwardedFrom || msg?.forwardedMessage) {
      console.log('[FWD_DEBUG] Received forwarded message:', JSON.stringify({
        messageId: msg?.messageId || msg?._id,
        isForwarded: msg?.isForwarded,
        forwarded: msg?.forwarded,
        forwardedFrom: msg?.forwardedFrom,
        forwardedMessage: msg?.forwardedMessage,
        is_forwarded: msg?.is_forwarded,
        text: msg?.text?.slice(0, 30),
      }));
    }

    const messageId = normalizeId(msg.messageId || msg._id);
    const incomingTempId = normalizeId(msg.tempId);
    const incomingSenderId = msg?.senderId;
    const isSelfMessage = incomingSenderId && sameId(incomingSenderId, currentUserIdRef.current);

    // Self-echo: if we sent this message, the ACK handler already wrote it to SQLite.
    // Just update the temp row with the server ID if needed.
    if (isSelfMessage && incomingTempId && messageId && incomingTempId !== messageId) {
      await ChatDatabase.acknowledgeMessage(incomingTempId, messageId);
      // Copy reply data to server ID in permanent table
      const rd = await ChatDatabase.getReplyData(incomingTempId);
      if (rd) ChatDatabase.saveReplyData(messageId, rd).catch(() => {});
      refreshMessagesFromDB();
      return;
    }
    // Self-echo without tempId: check if we recently sent a message with matching tempId
    if (isSelfMessage && messageId && !incomingTempId) {
      // Check sentTempIdsRef — if any pending temp matches, do the ACK
      for (const pendingTempId of sentTempIdsRef.current) {
        const tempExists = await ChatDatabase.messageExists(pendingTempId);
        if (tempExists) {
          const tempMsg = await ChatDatabase.getMessage(pendingTempId);
          // Match by text + close timestamp (within 10s)
          if (tempMsg && tempMsg.text === (msg.text || msg.message) &&
              Math.abs((tempMsg.timestamp || 0) - new Date(msg.createdAt || msg.timestamp || 0).getTime()) < 10000) {
            await ChatDatabase.acknowledgeMessage(pendingTempId, messageId);
            const rd = await ChatDatabase.getReplyData(pendingTempId);
            if (rd) ChatDatabase.saveReplyData(messageId, rd).catch(() => {});
            sentTempIdsRef.current.delete(pendingTempId);
            refreshMessagesFromDB();
            return;
          }
        }
      }
      // Fallback: search SQLite directly for a temp row matching this message's content
      const matchingTemp = await ChatDatabase.findTempRowByContent(
        chatIdRef.current,
        currentUserIdRef.current,
        msg.text || msg.message || '',
        new Date(msg.createdAt || msg.timestamp || 0).getTime()
      );
      if (matchingTemp) {
        await ChatDatabase.acknowledgeMessage(matchingTemp.id, messageId);
        const rd = await ChatDatabase.getReplyData(matchingTemp.id);
        if (rd) ChatDatabase.saveReplyData(messageId, rd).catch(() => {});
        sentTempIdsRef.current.delete(matchingTemp.id);
        refreshMessagesFromDB();
        return;
      }
    }
    if (isSelfMessage && messageId) {
      // Check if already in SQLite (from our optimistic insert)
      const exists = await ChatDatabase.messageExists(messageId);
      if (exists) return; // Already have it — skip
      // Also check by tempId
      if (incomingTempId) {
        const existsByTemp = await ChatDatabase.messageExists(incomingTempId);
        if (existsByTemp) {
          // We have the temp version — upgrade it
          await ChatDatabase.acknowledgeMessage(incomingTempId, messageId);
          refreshMessagesFromDB();
          return;
        }
      }
    }

    // Detect forwarded messages:
    // 1. Server explicitly marks it (isForwarded, forwarded, forwardedFrom, etc.)
    // 2. Message ID is in our forwardedMsgIds set (from forward:response)
    // 3. Message arrived within the forward time window (set by ForwardMessageScreen)
    const isKnownForwarded = Boolean(msg.isForwarded || msg.forwarded || msg.forwardedFrom || msg.is_forwarded || msg.forwardedMessage);
    const isTrackedForward = messageId && forwardedMsgIdsRef.current.has(String(messageId));
    const isWindowForward = isInForwardWindow(15000) && isSelfMessage;
    const shouldMarkForwarded = isKnownForwarded || isTrackedForward || isWindowForward;

    if (isTrackedForward) forwardedMsgIdsRef.current.delete(String(messageId));
    if (isWindowForward && shouldMarkForwarded) clearForwardTimestamp();

    // Normalize the incoming message
    const receivedMessage = normalizeIncomingMessage({
      ...msg,
      ...(shouldMarkForwarded ? { isForwarded: true } : {}),
      messageId,
      chatId: msg?.chatId || chatIdRef.current,
    });
    if (receivedMessage.senderId) {
      receivedMessage.senderType = sameId(receivedMessage.senderId, currentUserIdRef.current) ? 'self' : 'other';
    }

    // Anti-resurrection: a message the user delete-for-me'd must not come back via
    // a realtime re-delivery / echo. The registry is warm after any load or the
    // delete itself; ensure it's loaded before the sync check.
    await ChatDatabase.ensureDeletedForMeLoaded();
    if (ChatDatabase.isDeletedForMe(receivedMessage.serverMessageId, receivedMessage.id, receivedMessage.tempId)) {
      return;
    }

    // If this message is a reply but missing preview data, try multiple sources
    if (receivedMessage.replyToMessageId && !receivedMessage.replyPreviewText) {
      // Source 1: Check permanent reply table first (fastest)
      const savedReply = await ChatDatabase.getReplyData(receivedMessage.serverMessageId || receivedMessage.id);
      if (savedReply?.replyPreviewText) {
        receivedMessage.replyPreviewText = savedReply.replyPreviewText;
        receivedMessage.replyPreviewType = savedReply.replyPreviewType || receivedMessage.replyPreviewType;
        receivedMessage.replySenderId = savedReply.replySenderId || receivedMessage.replySenderId;
        receivedMessage.replySenderName = savedReply.replySenderName || receivedMessage.replySenderName;
      }

      // Source 2: Look up the original message from SQLite
      if (!receivedMessage.replyPreviewText) {
        const originalMsg = await ChatDatabase.getMessage(receivedMessage.replyToMessageId);
        if (originalMsg) {
          receivedMessage.replyPreviewText = originalMsg.isDeleted ? 'This message was deleted' : (originalMsg.text || '');
          receivedMessage.replyPreviewType = originalMsg.type || 'text';
          receivedMessage.replySenderId = receivedMessage.replySenderId || originalMsg.senderId || null;
          // Resolve sender name
          let rSenderName = originalMsg.senderName || null;
          if (!rSenderName && originalMsg.senderId) {
            if (sameId(originalMsg.senderId, currentUserIdRef.current)) {
              rSenderName = currentUserNameRef.current || 'You';
            } else if (chatData?.peerUser?.fullName) {
              rSenderName = chatData.peerUser.fullName;
            } else if (groupMembersMapRef.current?.[originalMsg.senderId]?.fullName) {
              rSenderName = groupMembersMapRef.current[originalMsg.senderId].fullName;
            }
          }
          receivedMessage.replySenderName = receivedMessage.replySenderName || rSenderName;
        }
      }

      // Source 3: Try to extract from the raw replyTo / quotedMessage / payload in socket data
      if (!receivedMessage.replyPreviewText) {
        const rawReplyTo = msg?.replyTo || msg?.quotedMessage || msg?.reply || msg?.payload?.replyTo;
        if (rawReplyTo && typeof rawReplyTo === 'object') {
          receivedMessage.replyPreviewText = rawReplyTo.text || rawReplyTo.content || rawReplyTo.message || null;
          receivedMessage.replyPreviewType = rawReplyTo.messageType || rawReplyTo.type || 'text';
          receivedMessage.replySenderId = receivedMessage.replySenderId || rawReplyTo.senderId || rawReplyTo.sender?._id || (typeof rawReplyTo.sender === 'string' ? rawReplyTo.sender : null) || null;
          receivedMessage.replySenderName = receivedMessage.replySenderName || rawReplyTo.senderName || rawReplyTo.sender?.fullName || rawReplyTo.sender?.name || null;
        }
        // Also check flat fields on the raw msg that normalizeIncomingMessage might have missed
        if (!receivedMessage.replyPreviewText) {
          receivedMessage.replyPreviewText = msg?.replyPreviewText || msg?.quotedText || msg?.payload?.replyPreviewText || msg?.payload?._replyPreviewText || null;
        }
        if (!receivedMessage.replySenderName) {
          receivedMessage.replySenderName = msg?.replySenderName || msg?.quotedSender || msg?.payload?.replySenderName || msg?.payload?._replySenderName || null;
        }
        if (!receivedMessage.replySenderId) {
          receivedMessage.replySenderId = msg?.replySenderId || msg?.payload?.replySenderId || msg?.payload?._replySenderId || null;
        }
      }

      // Final fallback
      if (!receivedMessage.replyPreviewText) {
        receivedMessage.replyPreviewText = 'Message';
        receivedMessage.replyPreviewType = 'text';
      }

      // Resolve sender name from group members if still missing
      if (!receivedMessage.replySenderName && receivedMessage.replySenderId) {
        if (sameId(receivedMessage.replySenderId, currentUserIdRef.current)) {
          receivedMessage.replySenderName = currentUserNameRef.current || 'You';
        } else if (groupMembersMapRef.current?.[receivedMessage.replySenderId]?.fullName) {
          receivedMessage.replySenderName = groupMembersMapRef.current[receivedMessage.replySenderId].fullName;
        }
      }
    }

    // Save reply data to permanent reply table (never overwritten)
    // MUST complete BEFORE delivery receipt can trigger refreshMessagesFromDB
    if (receivedMessage.replyToMessageId) {
      const rKey = receivedMessage.serverMessageId || receivedMessage.id || receivedMessage.tempId;
      if (rKey) {
        await ChatDatabase.saveReplyData(rKey, {
          replyToMessageId: receivedMessage.replyToMessageId,
          replyPreviewText: receivedMessage.replyPreviewText,
          replyPreviewType: receivedMessage.replyPreviewType,
          replySenderName: receivedMessage.replySenderName,
          replySenderId: receivedMessage.replySenderId,
        }).catch(() => {});
      }
    }

    // Resolve senderName from group members if missing
    if (!receivedMessage.senderName && receivedMessage.senderId && !sameId(receivedMessage.senderId, currentUserIdRef.current)) {
      // Device-contact-resolved map name wins; keep any existing name as fallback.
      receivedMessage.senderName = groupMembersMapRef.current?.[receivedMessage.senderId]?.fullName || receivedMessage.senderName || null;
    }

    // RENDER FIRST — never block the React render on SQLite. expo-sqlite
    // upsert can take 500ms-2s on slow Android devices; awaiting it before
    // state update is what caused the perceived "few seconds delay" the
    // user reported. State + ChatCache update synchronously here; the
    // SQLite write is queued through SqliteWriter (single-writer FIFO).
    // `refreshMessagesFromDB` calls awaitDrain() before reading, so it
    // still sees this row when it runs.
    const persistChatId = receivedMessage.chatId || chatIdRef.current;
    ChatCache.addMessage(persistChatId, receivedMessage);
    SqliteWriter.enqueue('upsertMessage', { ...receivedMessage, chatId: persistChatId }).catch(() => {});

    // INSTANT UI: merge into state — update existing if reply/sender data was missing
    setAllMessages(prev => {
      // Dedup chain — clientMessageId is the most reliable handle (echoed by
      // server on every reconnect retry); serverMessageId/id/tempId as fallback.
      const ids = [
        receivedMessage.clientMessageId,
        receivedMessage.serverMessageId,
        receivedMessage.id,
        receivedMessage.tempId,
      ].filter(Boolean);
      const existingIdx = prev.findIndex(m =>
        ids.some(id =>
          sameId(id, m.clientMessageId) ||
          sameId(id, m.serverMessageId) ||
          sameId(id, m.id) ||
          sameId(id, m.tempId)
        )
      );

      if (existingIdx !== -1) {
        // Message already in state — patch it with reply/sender data if it was missing
        const existing = prev[existingIdx];
        let patch = null;
        if (receivedMessage.replyToMessageId) {
          if (!existing.replyPreviewText && receivedMessage.replyPreviewText) {
            patch = {
              ...(patch || {}),
              replyPreviewText: receivedMessage.replyPreviewText,
              replyPreviewType: receivedMessage.replyPreviewType,
              replySenderName: receivedMessage.replySenderName,
              replySenderId: receivedMessage.replySenderId,
              replyToMessageId: receivedMessage.replyToMessageId,
            };
          }
        }
        if (!existing.senderName && receivedMessage.senderName) {
          patch = { ...(patch || {}), senderName: receivedMessage.senderName };
        }
        if (!patch) return prev; // Nothing to patch
        const updated = [...prev];
        updated[existingIdx] = { ...existing, ...patch };
        return updated;
      }

      // New message — insert. Sort by server-assigned `seq` (monotonic per
      // chat — never lies about ordering even when two messages share a
      // millisecond timestamp), falling back to timestamp for legacy rows
      // that don't have seq yet.
      const merged = [receivedMessage, ...prev];
      merged.sort((a, b) => {
        const aSeq = typeof a.seq === 'number' ? a.seq : null;
        const bSeq = typeof b.seq === 'number' ? b.seq : null;
        if (aSeq != null && bSeq != null) return bSeq - aSeq;
        return (b.timestamp || 0) - (a.timestamp || 0);
      });
      return merged;
    });

    // Emit delivery receipt for incoming messages from others
    // Do NOT emit delivery for scheduled/processing/cancelled/failed messages
    const msgStatus = (msg?.status || receivedMessage?.status || '').toLowerCase();
    const isProtectedStatus = msgStatus === 'scheduled' || msgStatus === 'processing' || msgStatus === 'cancelled' || msgStatus === 'failed';
    const senderId = msg?.senderId;
    if (senderId && !sameId(senderId, currentUserIdRef.current) && messageId && !isProtectedStatus) {
      const socket = socketRef.current || getSocket();
      if (socket && isSocketConnected() && chatIdRef.current) {
        const isGrpDel = chatData?.chatType === 'group' || chatData?.isGroup;
        if (isGrpDel) {
          socket.emit('group:message:delivered', {
            groupId: chatData?.groupId || chatData?.group?._id || chatIdRef.current,
            messageIds: [messageId],
            userId: currentUserIdRef.current,
            deliveredAt: new Date().toISOString(),
          });
        } else {
          socket.emit('message:delivered', {
            messageId,
            chatId: chatIdRef.current,
            senderId,
          });
        }
      }

      // Mark as 'delivered' in SQLite
      const changed = await ChatDatabase.updateMessageStatus(messageId, 'delivered');
      if (changed) refreshMessagesFromDB();
    }
  }, [refreshMessagesFromDB, resetIdleTimer]);

  const handleDeleteMessage = useCallback(async (messageId, isDeletedForEveryone, options = {}) => {
    const normalizedMsgId = normalizeId(messageId);
    if (!normalizedMsgId) return;

    const deletedBy = normalizeId(options?.deletedBy) || null;
    const isDeletedBySelf = deletedBy
      ? sameId(deletedBy, currentUserIdRef.current)
      : Boolean(options?._initiatedLocally);

    // Check SQLite first — if already deleted, only refresh UI (no duplicate write)
    const existing = await ChatDatabase.getMessage(normalizedMsgId);
    if (!existing) {
      // OUT-OF-ORDER: the delete arrived before the message itself. Persist the
      // intent so it's re-applied when the message later syncs in.
      if (isDeletedForEveryone) {
        // Everyone-tombstone registry already re-applies on arrival
        // (normalizeIncomingMessage resolves isDeleted from it).
        registerDeletedTombstone(normalizedMsgId, {
          deletedBy,
          placeholderText: buildDeletePlaceholderText(isDeletedBySelf),
        });
      } else {
        // Delete-for-me before arrival: register so upsert/load never inserts it.
        ChatDatabase.registerDeletedForMe(normalizedMsgId).catch(() => {});
      }
      return;
    }
    if (existing.isDeleted && isDeletedForEveryone) {
      // Already marked deleted — just make sure UI reflects it
      refreshMessagesFromDB(true);
      return;
    }

    // 1. Update in-memory state immediately (optimistic — instant UI update)
    setAllMessages(prev => prev.map(msg => {
      const msgId = msg.serverMessageId || msg.id || msg.tempId;
      if (!sameId(msgId, normalizedMsgId)) return msg;

      if (!isDeletedForEveryone) {
        // Delete for me: filter out in the next step
        return { ...msg, _removedForMe: true };
      }

      // Delete for everyone: mark as deleted in-place
      return {
        ...msg,
        isDeleted: true,
        deletedFor: 'everyone',
        deletedBy,
        placeholderText: buildDeletePlaceholderText(isDeletedBySelf),
        text: buildDeletePlaceholderText(isDeletedBySelf),
        mediaUrl: null,
        mediaThumbnailUrl: null,
        previewUrl: null,
        localUri: null,
      };
    }).filter(msg => !msg._removedForMe));

    // 2. Persist to SQLite (source of truth for next load)
    if (isDeletedForEveryone) {
      registerDeletedTombstone(normalizedMsgId, {
        deletedBy,
        placeholderText: buildDeletePlaceholderText(isDeletedBySelf),
      });
      await ChatDatabase.markMessageDeleted(normalizedMsgId, deletedBy, buildDeletePlaceholderText(isDeletedBySelf));
    } else {
      removeDeletedTombstone(normalizedMsgId);
      await ChatDatabase.deleteMessageForMe(normalizedMsgId);
    }

    // 3. Sync chat list preview
    pendingPreviewSyncRef.current = true;
  }, [
    refreshMessagesFromDB,
    registerDeletedTombstone,
    removeDeletedTombstone,
  ]);

  // ─── RECONNECT MUTATION DELTA ───
  // Apply the server's mutation delta (edits / deletes that happened while we
  // were away) to already-stored messages. Reuses the SAME handlers as the live
  // edit/delete socket events so there is no parallel apply path. Each apply is
  // idempotent (absolute values), so replaying the same mutation is a no-op.
  const applyMutatedMessages = useCallback(async (mutatedMessages, chatIdParam, latestMutationAt) => {
    try {
      const list = Array.isArray(mutatedMessages) ? mutatedMessages : [];
      const myId = normalizeId(currentUserIdRef.current);
      for (const doc of list) {
        const mid = normalizeId(doc?._id || doc?.messageId || doc?.id);
        if (!mid) continue;

        if (doc?.isDeleted === true) {
          // Server-side tombstone (edit-then-delete or delete-for-everyone).
          await handleDeleteMessage(mid, true, {
            deletedBy: doc?.deletedBy || doc?.senderId || doc?.userId,
          });
          continue;
        }

        const deletedForArr = doc?.deletedFor;
        const isDeletedForMe = Array.isArray(deletedForArr)
          ? deletedForArr.some((u) => sameId(u, myId))
          : false;
        if (isDeletedForMe) {
          await handleDeleteMessage(mid, false, { deletedBy: myId, _initiatedLocally: true });
          continue;
        }

        if (doc?.isEdited === true) {
          const newText = doc?.text || doc?.content;
          const editedAt = doc?.editedAt || doc?.updatedAt || new Date().toISOString();
          if (newText) {
            const existing = await ChatDatabase.getMessage(mid);
            if (!existing) {
              await registerPendingEdit(mid, newText, editedAt);
            } else {
              await ChatDatabase.updateMessageEdit(mid, newText, editedAt);
              await removePendingEdit(mid);
            }
          }
        }
      }
      if (list.length > 0) refreshMessagesFromDB();
    } catch (err) {
      console.warn('[Mutation] applyMutatedMessages error:', err?.message);
    } finally {
      if (chatIdParam && Number(latestMutationAt) > 0) {
        setMutationCursor(chatIdParam, latestMutationAt);
      }
    }
  }, [handleDeleteMessage, registerPendingEdit, removePendingEdit, refreshMessagesFromDB, setMutationCursor]);

  useEffect(() => {
    applyMutatedMessagesRef.current = applyMutatedMessages;
  }, [applyMutatedMessages]);

  useEffect(() => {
    if (!pendingPreviewSyncRef.current) return;
    pendingPreviewSyncRef.current = false;
    saveMessagesToLocal(allMessages);
    updateChatListLastMessagePreview(allMessages);
  }, [allMessages, saveMessagesToLocal, updateChatListLastMessagePreview]);

  const handleToggleSelectMessages = useCallback((messageId) => {
    console.log("messageId === ", messageId)
    setSelectedMessages((prevSelected) => prevSelected.includes(messageId) ? prevSelected.filter((id) => id !== messageId) : [...prevSelected, messageId]);
  }, []);

  // Stable reference so it can safely sit in renderChatsItem's dependency array
  // without forcing the whole message list to re-render every render.
  const clearSelectedMessages = useCallback(() => setSelectedMessages([]), []);

  // Delete an explicit set of message ids (used by both the multi-select flow and
  // the long-press action sheet, which deletes a single message WITHOUT ever
  // entering selection mode — so no header selection toolbar appears).
  const deleteMessagesByIds = useCallback(async (ids, deleteForEveryone) => {
    try {
      const socket = getSocket();
      const latestMessages = allMessagesRef.current || [];
      const isGroupDel = chatData?.chatType === 'group' || chatData?.isGroup;
      const groupId = isGroupDel ? (chatData?.groupId || chatData?.group?._id || chatIdRef.current) : null;

      const selectedResolved = (ids || [])
        .map((messageId) => {
          const found = latestMessages.find(m =>
            sameId(m.id, messageId) ||
            sameId(m.serverMessageId, messageId) ||
            sameId(m.tempId, messageId)
          );
          const resolvedId = found?.serverMessageId || found?.id || found?.tempId || messageId;
          return { found, resolvedId };
        })
        .filter(entry => {
          if (!entry.resolvedId) return false;
          // Skip messages already marked as deleted locally
          if (entry.found?.isDeleted) return false;
          return true;
        });

      if (selectedResolved.length === 0) {
        setSelectedMessages([]);
        return;
      }

      // 1. Optimistic local update — instant UI change.
      // For delete-for-everyone, snapshot the original row first so a server
      // rejection can restore it (the optimistic delete wipes local content).
      for (const { resolvedId, found } of selectedResolved) {
        if (deleteForEveryone && found) {
          pendingDeleteSnapshotsRef.current[String(resolvedId)] = { ...found };
        }
        await handleDeleteMessage(resolvedId, deleteForEveryone, {
          deletedBy: currentUserIdRef.current,
          _initiatedLocally: true,
        });
      }

      // 2. Emit to server
      if (socket && isSocketConnected()) {
        for (const { resolvedId, found } of selectedResolved) {
          if (isGroupDel) {
            // Group: emit { groupId, messageId, deleteForEveryone }
            // "Delete for everyone" only allowed for own messages
            const canDeleteForEveryone = deleteForEveryone && found && sameId(found.senderId, currentUserIdRef.current);
            const payload = {
              groupId,
              messageId: resolvedId,
              deleteForEveryone: Boolean(canDeleteForEveryone),
            };
            socket.emit('group:message:delete', payload);
            console.log('[DELETE:GROUP:EMIT]', payload);
          } else {
            // Private chat
            if (deleteForEveryone && found && sameId(found.senderId, currentUserIdRef.current)) {
              socket.emit('message:delete', { messageId: resolvedId, chatId: chatIdRef.current, deleteFor: 'everyone', senderId: currentUserIdRef.current });
              socket.emit('message:delete:everyone', { messageId: resolvedId, chatId: chatIdRef.current, senderId: currentUserIdRef.current });
            } else {
              socket.emit('message:delete', { messageId: resolvedId, chatId: chatIdRef.current, deleteFor: 'me' });
              socket.emit('message:delete:me', { messageId: resolvedId, chatId: chatIdRef.current });
            }
          }
        }
      }

      setSelectedMessages([]);
    } catch (error) {
      Alert.alert("Error", "Failed to delete messages");
    }
  }, [handleDeleteMessage, chatData]);

  // Backward-compatible wrapper: delete the currently multi-selected messages.
  const deleteSelectedMessages = useCallback(
    (deleteForEveryone) => deleteMessagesByIds(selectedMessage, deleteForEveryone),
    [deleteMessagesByIds, selectedMessage]
  );

  // Prompt (me / everyone) + delete a SINGLE message by id — for the action sheet.
  // `msg` is used only to decide whether "Delete for everyone" is offered.
  const promptDeleteSingleMessage = useCallback((msg) => {
    if (!msg) return;
    const resolvedId = msg.serverMessageId || msg.id || msg.tempId;
    if (!resolvedId) return;
    const isMine = sameId(msg.senderId, currentUserIdRef.current);
    const options = [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete for me', onPress: () => deleteMessagesByIds([resolvedId], false) },
    ];
    if (isMine) options.push({ text: 'Delete for everyone', style: 'destructive', onPress: () => deleteMessagesByIds([resolvedId], true) });
    Alert.alert('Delete Message', 'Delete this message?', options);
  }, [deleteMessagesByIds]);

  // ─── MESSAGE EDITING ───

  const startEditMessage = useCallback((msg) => {
    if (!msg) return;
    const isMine = sameId(msg.senderId, currentUserIdRef.current);
    if (!isMine) return;
    if (msg.type !== 'text' && msg.type !== undefined) return;
    if (msg.isDeleted) return;
    // Must have server ID — temp messages can't be edited on server
    if (!msg.serverMessageId || String(msg.serverMessageId).startsWith('temp_')) return;
    setEditingMessage(msg);
    setSelectedMessages([]);
  }, []);

  const cancelEditMessage = useCallback(() => {
    setEditingMessage(null);
  }, []);

  // ─── REPLY ───
  const startReply = useCallback((msg) => {
    if (!msg || msg.isDeleted) return;
    // Resolve sender name if missing
    let enriched = msg;
    if (!msg.senderName && msg.senderId) {
      let name = null;
      if (sameId(msg.senderId, currentUserIdRef.current)) {
        name = currentUserNameRef.current || 'You';
      } else if (chatData?.peerUser?.fullName) {
        name = chatData.peerUser.fullName;
      } else if (groupMembersMapRef.current?.[msg.senderId]?.fullName) {
        name = groupMembersMapRef.current[msg.senderId].fullName;
      }
      if (name) enriched = { ...msg, senderName: name };
    }
    setReplyTarget(enriched);
    setEditingMessage(null);
    setSelectedMessages([]);
  }, [chatData?.peerUser?.fullName]);

  const cancelReply = useCallback(() => {
    setReplyTarget(null);
  }, []);

  const submitEditMessage = useCallback(async (newText) => {
    if (!editingMessage || !newText?.trim()) return;

    // MUST use the server message ID — temp IDs are not known to the server
    const serverMsgId = editingMessage.serverMessageId;
    const localId = editingMessage.id || editingMessage.tempId;
    const messageId = serverMsgId || localId;
    const cId = chatIdRef.current;
    if (!messageId || !cId) return;

    // Block editing if the message hasn't been acknowledged by the server yet
    if (!serverMsgId || String(serverMsgId).startsWith('temp_')) {
      Alert.alert('Cannot edit', 'Message is still sending. Please wait.');
      return;
    }

    try {
      const socket = socketRef.current || getSocket();
      if (!socket || !isSocketConnected()) {
        Alert.alert('Error', 'Not connected. Please try again.');
        return;
      }

      const trimmedText = newText.trim();
      const editedAt = new Date().toISOString();

      // Snapshot pre-edit values so we can roll back if the server rejects.
      const preEdit = {
        text: editingMessage.text,
        isEdited: Boolean(editingMessage.isEdited),
        editedAt: editingMessage.editedAt || null,
      };

      // Optimistic UI: update state immediately
      setAllMessages(prev => prev.map(m => {
        const isMatch = sameId(m.serverMessageId, serverMsgId) || sameId(m.id, serverMsgId);
        if (!isMatch) return m;
        return { ...m, text: trimmedText, isEdited: true, editedAt };
      }));

      // Persist to SQLite
      await ChatDatabase.updateMessageEdit(serverMsgId, trimmedText, editedAt);

      // Update chat list preview
      updateLocalLastMessagePreview({
        chatId: cId,
        lastMessage: {
          text: trimmedText,
          type: editingMessage.type || 'text',
          senderId: editingMessage.senderId || currentUserIdRef.current,
          status: editingMessage.status || 'sent',
          createdAt: editingMessage.createdAt || editedAt,
          isEdited: true,
          editedAt,
          serverMessageId: serverMsgId,
          messageId: serverMsgId,
        },
        lastMessageAt: editingMessage.createdAt || editedAt,
        lastMessageType: editingMessage.type || 'text',
        lastMessageSender: editingMessage.senderId || currentUserIdRef.current,
        lastMessageEdited: true,
      });

      // Emit to server with the SERVER message ID
      const isGroupEdit = chatData?.chatType === 'group' || chatData?.isGroup;
      const editEvent = isGroupEdit ? 'group:message:edit' : 'message:edit';
      const editPayload = {
        messageId: serverMsgId,
        chatId: cId,
        ...(isGroupEdit && { groupId: chatData?.groupId || chatData?.group?._id || cId }),
        text: trimmedText,
      };
      socket.emit(editEvent, editPayload, (ack) => {
        // Rollback on server rejection (NOT_MESSAGE_OWNER / EDIT_TIMEOUT /
        // MESSAGE_DELETED / NO_EDIT_CONTENT). Restore the snapshot in state +
        // SQLite so the optimistic edit doesn't stick.
        if (ack?.status === false || ack?.success === false) {
          setAllMessages(prev => prev.map(m => {
            const isMatch = sameId(m.serverMessageId, serverMsgId) || sameId(m.id, serverMsgId);
            if (!isMatch) return m;
            return { ...m, text: preEdit.text, isEdited: preEdit.isEdited, editedAt: preEdit.editedAt };
          }));
          // Restore the pre-edit TEXT in SQLite. (upsert can't lower is_edited —
          // its merge does MAX(is_edited) — so we write the original text back
          // via updateMessageEdit; the in-memory state above governs the UI.)
          if (preEdit.text) {
            ChatDatabase.updateMessageEdit(serverMsgId, preEdit.text, preEdit.editedAt || editedAt).catch(() => {});
          }
          const code = ack?.code || ack?.error;
          Alert.alert('Edit failed', ack?.message || (code ? String(code) : 'The message could not be edited.'));
        }
      });
    } catch (err) {
      console.warn('[EDIT] submitEditMessage error:', err);
    } finally {
      setEditingMessage(null);
    }
  }, [editingMessage, updateLocalLastMessagePreview]);

  const handleDeleteSelected = useCallback(() => {
    if (selectedMessage.length === 0) return;
    const latestMessages = allMessagesRef.current || [];
    const allMyMessages = selectedMessage.every(msgId => {
      const msg = latestMessages.find(m =>
        sameId(m.id, msgId) || sameId(m.serverMessageId, msgId) || sameId(m.tempId, msgId)
      );
      return msg && sameId(msg.senderId, currentUserIdRef.current);
    });
    const options = [{ text: "Cancel", style: "cancel" }, { text: "Delete for me", onPress: () => deleteSelectedMessages(false) }];
    if (allMyMessages) options.push({ text: "Delete for everyone", style: "destructive", onPress: () => deleteSelectedMessages(true) });
    Alert.alert("Delete Messages", `Delete ${selectedMessage.length} message(s)?`, options);
  }, [selectedMessage, deleteSelectedMessages]);

  const handleSearch = useCallback((searchText) => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    setSearch(searchText);
    if (!searchText || searchText.trim() === '') { 
      setIsSearching(false); 
      setSearchResults([]); 
      setCurrentSearchIndex(-1); 
      setMessages(allMessages.filter(msg => msg.chatId === chatIdRef.current)); 
      return; 
    }
    setIsSearching(true);
    searchTimeoutRef.current = setTimeout(() => {
      const searchQuery = searchText.trim().toLowerCase();
      const results = allMessages.filter(msg => 
        msg.chatId === chatIdRef.current && 
        msg.type === 'text' && 
        msg.text && 
        msg.text.toLowerCase().includes(searchQuery)
      );
      const sortedResults = results.sort((a,b) => (b.timestamp || new Date(b.createdAt).getTime()) - (a.timestamp || new Date(a.createdAt).getTime()));
      setSearchResults(sortedResults);
      setMessages(sortedResults);
      setCurrentSearchIndex(sortedResults.length > 0 ? 0 : -1);
    }, 300);
  }, [allMessages]);

  const clearSearch = useCallback(() => { 
    setSearch(''); 
    setIsSearching(false); 
    setSearchResults([]); 
    setCurrentSearchIndex(-1); 
    setMessages(allMessages.filter(msg => msg.chatId === chatIdRef.current)); 
  }, [allMessages]);

  const goToNextResult = useCallback(() => {
    if (searchResults.length === 0) return;
    const nextIndex = (currentSearchIndex + 1) % searchResults.length;
    setCurrentSearchIndex(nextIndex);
    if (flatListRef.current && searchResults[nextIndex]) {
      const messageIndex = messages.findIndex(m => m.id === searchResults[nextIndex].id);
      if (messageIndex !== -1) flatListRef.current.scrollToIndex({ index: messageIndex, animated: true, viewPosition: 0.5 });
    }
  }, [searchResults, currentSearchIndex, messages]);

  const goToPreviousResult = useCallback(() => {
    if (searchResults.length === 0) return;
    const prevIndex = currentSearchIndex === 0 ? searchResults.length - 1 : currentSearchIndex - 1;
    setCurrentSearchIndex(prevIndex);
    if (flatListRef.current && searchResults[prevIndex]) {
      const messageIndex = messages.findIndex(m => m.id === searchResults[prevIndex].id);
      if (messageIndex !== -1) flatListRef.current.scrollToIndex({ index: messageIndex, animated: true, viewPosition: 0.5 });
    }
  }, [searchResults, currentSearchIndex, messages]);

  const handleDownloadMedia = async (msg) => {
    try {
      if (!msg) return;

      if (msg?.isDeleted || isDeletedForUser(msg?.deletedFor, currentUserIdRef.current) || msg?.type === 'system') {
        return;
      }
  
      const messageType = String(msg?.type || msg?.mediaType || msg?.messageType || '').toLowerCase();
      if (!isMediaMessageType(messageType)) {
        return;
      }

      const resolvedIdentity = resolveMediaIdentity(msg);
      const mediaId = String(resolvedIdentity?.mediaId || msg?.mediaId || msg?.serverMessageId || msg?.id || msg?.messageId || '');
      const serverMsgId = String(resolvedIdentity?.messageId || msg?.serverMessageId || msg?.id || msg?.messageId || '');

      // Resolve groupId: explicit field, or from chat data, or from chatIdRef for group chats
      const isGroup = Boolean(chatData?.chatType === 'group' || chatData?.isGroup);
      const resolvedGroupId = normalizeId(
        msg?.groupId || resolvedIdentity?.groupId || chatData?.groupId || chatData?.group?._id || (isGroup ? chatIdRef.current : null)
      );

      console.log('=== DOWNLOAD MSG DATA ===', JSON.stringify({
        mediaId,
        serverMsgId,
        isGroup,
        resolvedGroupId,
        mediaUrl: msg?.mediaUrl,
        previewUrl: msg?.previewUrl,
        chatId: msg?.chatId,
        groupId: msg?.groupId,
        mediaMeta: msg?.mediaMeta ? Object.keys(msg.mediaMeta) : null,
        resolvedMediaId: resolvedIdentity?.mediaId,
        resolvedMediaUrl: resolvedIdentity?.mediaUrl,
      }));
      if (!mediaId) {
        Alert.alert('Download failed', 'Media identifier missing for this message');
        return;
      }

      if (!resolvedIdentity?.mediaUrl && !msg?.mediaUrl && !msg?.previewUrl && !msg?.url) {
        Alert.alert('Download failed', 'Media URL missing for this message');
        return;
      }

      const effectiveChatId = normalizeId(msg?.chatId || msg?.groupId || chatIdRef.current);
      const eventKey = buildMediaStatusEventKey(effectiveChatId, mediaId);

      setMediaDownloadStates((prev) => ({
        ...prev,
        [mediaId]: {
          ...(prev[mediaId] || { mediaId }),
          status: MEDIA_DOWNLOAD_STATUS.DOWNLOADING,
          progress: 0,
          error: null,
          updatedAt: Date.now(),
        },
      }));

      setDownloadProgress(prev => ({
        ...prev,
        [mediaId]: 0
      }));

      const localUri = await mediaDownloadManager.download(
        {
          ...msg,
          mediaId,
          messageId: serverMsgId || mediaId,
          mediaUrl: resolvedIdentity?.mediaUrl || msg?.mediaUrl || msg?.previewUrl || msg?.url,
          mediaThumbnailUrl: resolvedIdentity?.mediaThumbnailUrl || msg?.mediaThumbnailUrl || msg?.thumbnailUrl || msg?.previewUrl,
          mediaMeta: resolvedIdentity?.mediaMeta || msg?.mediaMeta || msg?.payload?.mediaMeta || {},
          messageType: messageType,
          fileCategory: msg?.fileCategory || resolvedIdentity?.messageType || messageType,
          chatId: effectiveChatId || chatIdRef.current,
          groupId: resolvedGroupId,
        },
        {
          chatId: effectiveChatId || chatIdRef.current,
          filename: msg.text || msg.fileName || `${mediaId}`,
          onProgress: (progressPct) => {
            const normalized = Math.max(0, Math.min(100, Number(progressPct || 0)));
            setDownloadProgress(prev => ({
              ...prev,
              [mediaId]: normalized / 100,
            }));
          },
        }
      );

      if (!localUri) throw new Error("Download failed");

      await localStorageService.upsertMediaFile({
        mediaId,
        id: mediaId,
        serverMessageId: serverMsgId || mediaId,
        chatId: msg.chatId || chatIdRef.current,
        localPath: localUri,
        messageType: resolvedIdentity?.messageType || msg.type || msg.mediaType || 'file',
        serverUrl: resolvedIdentity?.mediaUrl || msg.mediaUrl || msg.previewUrl || null,
        thumbnailUrl: resolvedIdentity?.mediaThumbnailUrl || msg?.mediaThumbnailUrl || msg?.thumbnailUrl || msg.previewUrl || null,
        metadata: resolvedIdentity?.mediaMeta || msg?.mediaMeta || msg?.payload?.mediaMeta || {},
        downloadStatus: MEDIA_DOWNLOAD_STATUS.DOWNLOADED,
        downloadProgress: 100,
        downloadedAt: Date.now(),
        lastError: null,
        createdAtTs: Number(msg?.timestamp || Date.now()),
      });

      setDownloadedMedia((prev) => ({ ...prev, [mediaId]: localUri }));
      setMediaDownloadStates((prev) => ({
        ...prev,
        [mediaId]: {
          ...(prev[mediaId] || { mediaId }),
          status: MEDIA_DOWNLOAD_STATUS.DOWNLOADED,
          progress: 100,
          localPath: localUri,
          error: null,
          updatedAt: Date.now(),
        },
      }));

      await applyMediaDownloadedStateLocally({
        messageId: serverMsgId || mediaId,
        chatId: effectiveChatId,
        isMediaDownloaded: true,
        localUri,
      });

      if (eventKey && !mediaStatusProcessedRef.current.has(eventKey)) {
        const deviceId = await getOrCreateDeviceId();
        await queueMediaStatusUpdate({
          messageId: serverMsgId || mediaId,
          chatId: effectiveChatId,
          deviceId,
          isMediaDownloaded: true,
        });
      }

      setDownloadProgress(prev => {
        const copy = { ...prev };
        delete copy[mediaId];
        return copy;
      });

      return localUri;
  
    } catch (error) {
      console.log("❌ handleDownloadMedia error:", error);
      Alert.alert("Download failed", error?.message || "Unable to download media");

      const failedId = String(msg?.mediaId || msg?.serverMessageId || msg?.id || '');
      if (failedId) {
        setMediaDownloadStates((prev) => ({
          ...prev,
          [failedId]: {
            ...(prev[failedId] || { mediaId: failedId }),
            status: MEDIA_DOWNLOAD_STATUS.FAILED,
            progress: Number((prev[failedId]?.progress || 0)),
            localPath: prev[failedId]?.localPath || null,
            error: error?.message || 'download failed',
            updatedAt: Date.now(),
          },
        }));
      }
  
      setDownloadProgress(prev => {
        const copy = { ...prev };
        delete copy[String(msg?.mediaId || msg?.serverMessageId || msg?.id || '')];
        return copy;
      });

      return null;
    }
  };

  const cleanupTempMediaUri = useCallback(async (uri) => {
    try {
      if (!uri) return;
      const normalized = normalizeUri(uri);
      const cacheDir = normalizeUri(FileSystem.cacheDirectory || '');
      if (!normalized || !cacheDir || !normalized.startsWith(cacheDir)) return;
      const info = await FileSystem.getInfoAsync(normalized);
      if (info?.exists) {
        await FileSystem.deleteAsync(normalized, { idempotent: true });
      }
    } catch (error) {
      console.warn('cleanupTempMediaUri failed', error);
    }
  }, []);

  const sendMedia = useCallback(async (mediaObj, options = {}) => {
    if (!mediaObj || !mediaObj.file) return { success: false, error: 'invalid media payload' };
    if (amNotGroupMemberRef.current) return { success: false, error: 'not a group member' }; // left / removed

    const { file, type } = mediaObj;
    const normalizedType = type === 'document' ? 'file' : type;
    const tempId = options?.tempId || `temp_media_${Date.now()}_${Math.random()}`;
    const timestamp = options?.createdAt || new Date().toISOString();
    const localSourceUri = normalizeUri(file.uri);
    const shouldInsertLocal = !options?.skipLocalInsert;

    const isGrpMedia = chatData?.chatType === 'group' || chatData?.isGroup;
    const localMsg = {
      id: tempId,
      tempId,
      type: normalizedType,
      mediaType: normalizedType,
      text: file.name || '',
      mediaUrl: '',
      mediaThumbnailUrl: localSourceUri,
      previewUrl: localSourceUri,
      localUri: localSourceUri,
      time: moment(timestamp).format("hh:mm A"),
      date: moment(timestamp).format("YYYY-MM-DD"),
      senderId: currentUserIdRef.current,
      senderName: currentUserNameRef.current || '',
      senderType: 'self',
      receiverId: isGrpMedia ? null : (chatData.peerUser?._id || null),
      chatType: chatData?.chatType || 'private',
      status: 'sending',
      createdAt: timestamp,
      timestamp: new Date(timestamp).getTime(),
      payload: {
        chatId: chatIdRef.current,
        file: { ...file, uri: localSourceUri },
        tempId,
        isMediaDownloaded: true,
        uploadQueued: false,
      },
      downloadStatus: MEDIA_DOWNLOAD_STATUS.DOWNLOADED,
      isMediaDownloaded: true,
      synced: false,
      chatId: chatIdRef.current,
      ...(isGrpMedia && { groupId: chatData?.groupId || chatData?.group?._id || chatIdRef.current }),
      useLocalForSender: true,
    };

    if (shouldInsertLocal) {
      // INSTANT UI: show message immediately with local preview
      setAllMessages((prev) => [localMsg, ...prev]);

      // Write to SQLite in background (non-blocking)
      ChatDatabase.upsertMessage({ ...localMsg, chatId: chatIdRef.current }).catch(() => {});
    }

    if (!isConnected) {
      const queue = [...(queuedMediaUploadsRef.current || [])];
      const existingIndex = queue.findIndex((item) => item?.tempId === tempId);
      const queuedTask = {
        tempId,
        mediaObj: {
          ...mediaObj,
          file: { ...file, uri: localSourceUri },
        },
        createdAt: timestamp,
        retries: Number(queue[existingIndex]?.retries || 0),
      };
      if (existingIndex >= 0) queue[existingIndex] = queuedTask;
      else queue.push(queuedTask);
      queuedMediaUploadsRef.current = queue;
      await persistMediaUploadQueue(queue);

      setAllMessages((prev) => prev.map((m) => (
        m.tempId === tempId
          ? {
              ...m,
              status: 'failed',
              payload: {
                ...(m.payload || {}),
                uploadQueued: true,
              },
            }
          : m
      )));

      return { success: false, queued: true, error: 'offline queued' };
    }

    let uploadTick = 0;
    const uploadTimer = setInterval(() => {
      uploadTick += 1;
      setUploadProgress((prev) => {
        const current = Number(prev[tempId] || 0);
        if (current >= 0.92) return prev;
        const next = Math.min(0.92, current + 0.08);
        return { ...prev, [tempId]: next };
      });
      if (uploadTick > 40) clearInterval(uploadTimer);
    }, 250);

    setUploadProgress((prev) => ({ ...prev, [tempId]: 0.05 }));

    try {
      const uploadPromise = uploadMediaFile({
        file: { ...file, uri: localSourceUri },
        chatId: chatIdRef.current,
        dispatch,
        mediaUploadAction: mediaUpload,
      });

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`upload timeout after ${MEDIA_UPLOAD_TIMEOUT_MS}ms`)), MEDIA_UPLOAD_TIMEOUT_MS);
      });

      const action = await Promise.race([uploadPromise, timeoutPromise]);
      const uploadedLocalUri = normalizeUri(action?.localUri || localSourceUri);
      const payloadData = action?.payload || action;
      const success = payloadData && (payloadData.status === true || payloadData.statusCode === 200 || payloadData.success === true);

      if (!success) {
        setAllMessages((prev) => prev.map((m) => (m.tempId === tempId ? { ...m, status: 'failed' } : m)));
        setUploadProgress((prev) => ({ ...prev, [tempId]: 0 }));
        return { success: false, error: payloadData?.message || 'upload failed' };
      }

      clearInterval(uploadTimer);
      setUploadProgress((prev) => ({ ...prev, [tempId]: 1 }));

      const uploadResponse = payloadData;
      const responseData = uploadResponse.data || uploadResponse;
      const deviceId = await getOrCreateDeviceId();
      const messagePayload = createMediaMessagePayload({
        uploadResponse: responseData,
        file,
        messageType: type,
        chatType: chatData?.chatType || 'private',
        senderId: currentUserIdRef.current,
        senderDeviceId: deviceId,
        receiverId: chatData.peerUser?._id || null,
        chatId: chatIdRef.current,
        messageId: responseData?.messageId,
      });

      const payloadValidation = validateMediaMessagePayload(messagePayload);
      if (!payloadValidation.isValid) {
        setAllMessages((prev) => prev.map((m) => (m.tempId === tempId ? { ...m, status: 'failed' } : m)));
        setUploadProgress((prev) => ({ ...prev, [tempId]: 0 }));
        return { success: false, error: `missing fields: ${payloadValidation.missing.join(',')}` };
      }

      const uploadedPreviewUrl = messagePayload.mediaUrl || '';
      const uploadedThumbnailUrl = messagePayload.mediaThumbnailUrl || '';
      const serverMessageId = messagePayload.messageId;
      const mediaId = messagePayload.mediaId;
      const normalizedCategory = messagePayload.messageType;
      const mediaMeta = messagePayload.mediaMeta;

      // For sender, always ensure mediaUrl/previewUrl are usable — fall back to localUri
      const resolvedMediaUrl = uploadedPreviewUrl || uploadedLocalUri;
      const resolvedPreviewUrl = uploadedThumbnailUrl || uploadedPreviewUrl || uploadedLocalUri;

      setAllMessages((prevMessages) => {
        const withoutTemp = prevMessages.filter((m) => m.tempId !== tempId && m.id !== tempId);
        const permanentMsg = {
          id: serverMessageId,
          serverMessageId,
          tempId,
          type: normalizedCategory,
          mediaType: normalizedCategory,
          text: file.name || '',
          mediaUrl: resolvedMediaUrl,
          mediaThumbnailUrl: resolvedPreviewUrl,
          previewUrl: resolvedPreviewUrl,
          localUri: uploadedLocalUri,
          serverMediaUrl: uploadedPreviewUrl,
          serverPreviewUrl: uploadedThumbnailUrl,
          time: moment(timestamp).format("hh:mm A"),
          date: moment(timestamp).format("YYYY-MM-DD"),
          senderId: currentUserIdRef.current,
          senderName: currentUserNameRef.current || '',
          senderType: 'self',
          receiverId: isGrpMedia ? null : (chatData.peerUser?._id || null),
          chatType: chatData?.chatType || 'private',
          status: 'uploaded',
          createdAt: timestamp,
          timestamp: new Date(timestamp).getTime(),
          synced: true,
          payload: {
            ...messagePayload,
            file: { ...file, uri: uploadedLocalUri },
            isMediaDownloaded: true,
            uploadQueued: false,
          },
          mediaMeta,
          downloadStatus: MEDIA_DOWNLOAD_STATUS.DOWNLOADED,
          isMediaDownloaded: true,
          chatId: chatIdRef.current,
          ...(isGrpMedia && { groupId: chatData?.groupId || chatData?.group?._id || chatIdRef.current }),
          useLocalForSender: true,
          mediaId,
        };

        const updated = [permanentMsg, ...withoutTemp];
        const uniqueMessages = deduplicateMessages(updated);
        const sorted = uniqueMessages.sort((a, b) => b.timestamp - a.timestamp);
        saveMessagesToLocal(sorted);
        return sorted;
      });

      await sendMessageViaSocket({ ...messagePayload, tempId }, tempId).catch((err) => {
        console.warn('media socket ack failed', err?.message || err);
      });

      const queue = [...(queuedMediaUploadsRef.current || [])].filter((item) => item?.tempId !== tempId);
      queuedMediaUploadsRef.current = queue;
      await persistMediaUploadQueue(queue);
      return { success: true, tempId, messageId: serverMessageId };
    } catch (err) {
      const message = String(err?.message || err || 'upload failed');
      const isNetworkFailure = /network request failed|timeout|aborted|socket not connected/i.test(message);

      console.error('❌ [SEND MEDIA] Error:', {
        message,
        isConnected,
        networkType,
        fileUri: localSourceUri,
        fileType: file?.type,
        fileName: file?.name,
      });

      setAllMessages((prev) => prev.map((m) => (m.tempId === tempId ? { ...m, status: 'failed' } : m)));
      setUploadProgress((prev) => ({ ...prev, [tempId]: 0 }));

      if (isNetworkFailure) {
        const queue = [...(queuedMediaUploadsRef.current || [])];
        const existingIndex = queue.findIndex((item) => item?.tempId === tempId);
        const nextRetries = Number((existingIndex >= 0 ? queue[existingIndex]?.retries : 0) || 0);
        const task = {
          tempId,
          mediaObj: {
            ...mediaObj,
            file: { ...file, uri: localSourceUri },
          },
          createdAt: timestamp,
          retries: nextRetries,
        };
        if (existingIndex >= 0) queue[existingIndex] = task;
        else queue.push(task);
        queuedMediaUploadsRef.current = queue;
        await persistMediaUploadQueue(queue);
      }

      return { success: false, error: message };
    } finally {
      clearInterval(uploadTimer);
      if (!options?.fromQueue) {
        setPendingMedia(null);
      }
      setDownloadProgress((prev) => {
        const p = { ...prev };
        delete p[tempId];
        return p;
      });
      setTimeout(() => {
        setUploadProgress((prev) => {
          const next = { ...prev };
          delete next[tempId];
          return next;
        });
      }, 900);

      // Safety net: if the message is still stuck at 'sending'/'uploaded' after 5s,
      // check if it has a serverMessageId and promote it to 'sent'
      setTimeout(() => {
        setAllMessages((prev) => {
          let changed = false;
          const updated = prev.map((m) => {
            if (m.tempId !== tempId) return m;
            if ((m.status === 'sending' || m.status === 'uploaded') && m.serverMessageId) {
              changed = true;
              return { ...m, status: 'sent', synced: true };
            }
            return m;
          });
          if (changed) {
            saveMessagesToLocal(updated);
            return updated;
          }
          return prev;
        });
      }, 5000);
    }
  }, [
    isConnected,
    networkType,
    dispatch,
    chatData.peerUser,
    deduplicateMessages,
    saveMessagesToLocal,
    getOrCreateDeviceId,
    createMediaMessagePayload,
    validateMediaMessagePayload,
    sendMessageViaSocket,
    persistMediaUploadQueue,
  ]);

  /* ========== WhatsApp-style media album send ==========
     One message bubble carries every file picked together:
       1. Optimistic 'album' row with local previews (per-tile upload state).
       2. Files upload in parallel (3 at a time, per-file retry + timeout).
       3. A single message:send / group:message:send goes out with
          mediaItems[] + mediaGroupId; ack reconciles via tempId as usual.
     Offline / network failure re-queues the WHOLE album (same queue as
     single media — flushQueuedMediaUploads branches on `albumObj`). */
  const ALBUM_UPLOAD_CONCURRENCY = 3;

  const albumFileCategory = (mime) => {
    const m = String(mime || '').toLowerCase();
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('audio/')) return 'audio';
    return 'document';
  };

  const sendMediaGroup = useCallback(async (albumObj, options = {}) => {
    const files = (albumObj?.files || []).filter((f) => f?.uri);
    if (!files.length) return { success: false, error: 'invalid album payload' };
    if (amNotGroupMemberRef.current) return { success: false, error: 'not a group member' };

    const caption = albumObj?.caption || '';
    const tempId = options?.tempId || `temp_album_${Date.now()}_${Math.random()}`;
    const timestamp = options?.createdAt || new Date().toISOString();
    const mediaGroupId = albumObj?.mediaGroupId || `mg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const isGrpMedia = chatData?.chatType === 'group' || chatData?.isGroup;
    const shouldInsertLocal = !options?.skipLocalInsert;

    const normFiles = files.map((f) => ({ ...f, uri: normalizeUri(f.uri) }));
    let liveItems = normFiles.map((f) => ({
      mediaId: null,
      fileCategory: albumFileCategory(f.type),
      mediaUrl: null,
      mediaThumbnailUrl: null,
      localUri: f.uri,
      mediaMeta: { fileName: f.name, fileSize: f.size || null, mimeType: f.type },
      uploadStatus: 'pending',
      uploadProgress: 0,
    }));

    const localMsg = {
      id: tempId,
      tempId,
      type: 'album',
      mediaType: 'album',
      text: caption,
      mediaGroupId,
      mediaItems: liveItems,
      mediaUrl: '',
      mediaThumbnailUrl: liveItems[0]?.localUri || '',
      previewUrl: liveItems[0]?.localUri || '',
      localUri: liveItems[0]?.localUri || '',
      time: moment(timestamp).format("hh:mm A"),
      date: moment(timestamp).format("YYYY-MM-DD"),
      senderId: currentUserIdRef.current,
      senderName: currentUserNameRef.current || '',
      senderType: 'self',
      receiverId: isGrpMedia ? null : (chatData.peerUser?._id || null),
      chatType: chatData?.chatType || 'private',
      status: 'sending',
      createdAt: timestamp,
      timestamp: new Date(timestamp).getTime(),
      payload: {
        chatId: chatIdRef.current,
        albumFiles: normFiles,
        caption,
        mediaGroupId,
        tempId,
        isMediaDownloaded: true,
        uploadQueued: false,
      },
      downloadStatus: MEDIA_DOWNLOAD_STATUS.DOWNLOADED,
      isMediaDownloaded: true,
      synced: false,
      chatId: chatIdRef.current,
      ...(isGrpMedia && { groupId: chatData?.groupId || chatData?.group?._id || chatIdRef.current }),
      useLocalForSender: true,
    };

    if (shouldInsertLocal) {
      setAllMessages((prev) => [localMsg, ...prev]);
      ChatDatabase.upsertMessage({ ...localMsg, chatId: chatIdRef.current }).catch(() => {});
    }

    const queueAlbumTask = async () => {
      const queue = [...(queuedMediaUploadsRef.current || [])];
      const existingIndex = queue.findIndex((item) => item?.tempId === tempId);
      const task = {
        tempId,
        albumObj: { files: normFiles, caption, mediaGroupId },
        createdAt: timestamp,
        retries: Number((existingIndex >= 0 ? queue[existingIndex]?.retries : 0) || 0),
      };
      if (existingIndex >= 0) queue[existingIndex] = task;
      else queue.push(task);
      queuedMediaUploadsRef.current = queue;
      await persistMediaUploadQueue(queue);
    };

    if (!isConnected) {
      await queueAlbumTask();
      setAllMessages((prev) => prev.map((m) => (
        m.tempId === tempId
          ? { ...m, status: 'failed', payload: { ...(m.payload || {}), uploadQueued: true } }
          : m
      )));
      return { success: false, queued: true, error: 'offline queued' };
    }

    const patchItem = (index, patch) => {
      liveItems = liveItems.map((item, i) => (i === index ? { ...item, ...patch } : item));
      const snapshot = liveItems;
      setAllMessages((prev) => prev.map((m) => (
        m.tempId === tempId ? { ...m, mediaItems: snapshot } : m
      )));
    };

    setUploadProgress((prev) => ({ ...prev, [tempId]: 0.05 }));
    const refreshOverallProgress = () => {
      const total = liveItems.length || 1;
      const done = liveItems.filter((i) => i.uploadStatus === 'done' || i.uploadStatus === 'failed').length;
      setUploadProgress((prev) => ({ ...prev, [tempId]: Math.max(0.05, Math.min(0.98, done / total)) }));
    };

    const uploadOne = async (index) => {
      const file = normFiles[index];
      const attempt = async () => {
        const uploadPromise = uploadMediaFile({
          file,
          chatId: chatIdRef.current,
          dispatch,
          mediaUploadAction: mediaUpload,
        });
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`upload timeout after ${MEDIA_UPLOAD_TIMEOUT_MS}ms`)), MEDIA_UPLOAD_TIMEOUT_MS);
        });
        const action = await Promise.race([uploadPromise, timeoutPromise]);
        const payloadData = action?.payload || action;
        const ok = payloadData && (payloadData.status === true || payloadData.statusCode === 200 || payloadData.success === true);
        if (!ok) throw new Error(payloadData?.message || 'upload failed');
        const data = payloadData.data || payloadData;
        return {
          mediaId: String(data?.mediaId || ''),
          fileCategory: data?.fileCategory || albumFileCategory(file.type),
          mediaUrl: data?.previewUrl || data?.mediaUrl || '',
          mediaThumbnailUrl: data?.thumbnailUrl || data?.mediaThumbnailUrl || '',
          mediaMeta: {
            fileName: file.name,
            fileSize: data?.sizeAfter || file.size || null,
            mimeType: file.type,
            width: data?.width || null,
            height: data?.height || null,
            duration: data?.duration || null,
          },
        };
      };

      patchItem(index, { uploadStatus: 'uploading' });
      for (let tries = 0; tries < 2; tries += 1) {
        try {
          const item = await attempt();
          patchItem(index, { ...item, uploadStatus: 'done', uploadProgress: 100 });
          refreshOverallProgress();
          return item;
        } catch (err) {
          if (tries === 0) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          patchItem(index, { uploadStatus: 'failed', uploadProgress: 0 });
          refreshOverallProgress();
          return { error: String(err?.message || err) };
        }
      }
      return { error: 'upload failed' };
    };

    try {
      const results = new Array(normFiles.length);
      let cursor = 0;
      const workerCount = Math.min(ALBUM_UPLOAD_CONCURRENCY, normFiles.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (cursor < normFiles.length) {
          const index = cursor;
          cursor += 1;
          results[index] = await uploadOne(index);
        }
      }));

      const uploaded = results.filter((r) => r && !r.error);
      const failedCount = results.length - uploaded.length;

      if (!uploaded.length) {
        setAllMessages((prev) => prev.map((m) => (m.tempId === tempId ? { ...m, status: 'failed' } : m)));
        setUploadProgress((prev) => ({ ...prev, [tempId]: 0 }));
        const allNetwork = results.every((r) => /network request failed|timeout|aborted/i.test(String(r?.error || '')));
        if (allNetwork) await queueAlbumTask();
        return { success: false, error: 'all uploads failed' };
      }

      setUploadProgress((prev) => ({ ...prev, [tempId]: 1 }));
      const deviceId = await getOrCreateDeviceId();
      const first = uploaded[0];
      const messagePayload = {
        chatId: chatIdRef.current,
        chatType: chatData?.chatType || 'private',
        senderId: currentUserIdRef.current,
        senderDeviceId: deviceId,
        receiverId: isGrpMedia ? null : (chatData.peerUser?._id || null),
        ...(isGrpMedia && { groupId: chatData?.groupId || chatData?.group?._id || chatIdRef.current }),
        messageType: uploaded.length > 1 ? 'album' : (first.fileCategory === 'document' ? 'file' : first.fileCategory),
        text: caption,
        mediaGroupId,
        mediaItems: uploaded,
        // First-item mirrors — pre-album clients still render a thumbnail.
        mediaId: first.mediaId,
        mediaUrl: first.mediaUrl,
        mediaThumbnailUrl: first.mediaThumbnailUrl || first.mediaUrl,
        mediaMeta: first.mediaMeta,
        status: 'sent',
        createdAt: timestamp,
      };

      // Final attachments keep the local uri so the sender renders instantly.
      const finalItems = liveItems.map((item, i) => {
        const server = results[i] && !results[i].error ? results[i] : null;
        return server ? { ...item, ...server, uploadStatus: 'done' } : item;
      });
      liveItems = finalItems;

      setAllMessages((prev) => {
        const updated = prev.map((m) => (
          m.tempId === tempId
            ? {
                ...m,
                type: messagePayload.messageType,
                mediaType: messagePayload.messageType,
                mediaItems: finalItems,
                mediaUrl: first.mediaUrl,
                mediaThumbnailUrl: first.mediaThumbnailUrl || m.mediaThumbnailUrl,
                mediaId: first.mediaId,
                status: 'uploaded',
                payload: { ...(m.payload || {}), mediaItems: finalItems, mediaGroupId, uploadQueued: false },
              }
            : m
        ));
        saveMessagesToLocal(updated);
        return updated;
      });

      await sendMessageViaSocket({ ...messagePayload, tempId }, tempId).catch((err) => {
        console.warn('album socket ack failed', err?.message || err);
      });

      const queue = [...(queuedMediaUploadsRef.current || [])].filter((item) => item?.tempId !== tempId);
      queuedMediaUploadsRef.current = queue;
      await persistMediaUploadQueue(queue);
      return { success: true, tempId, failedCount };
    } catch (err) {
      const message = String(err?.message || err || 'album send failed');
      setAllMessages((prev) => prev.map((m) => (m.tempId === tempId ? { ...m, status: 'failed' } : m)));
      setUploadProgress((prev) => ({ ...prev, [tempId]: 0 }));
      if (/network request failed|timeout|aborted|socket not connected/i.test(message)) {
        await queueAlbumTask();
      }
      return { success: false, error: message };
    } finally {
      if (!options?.fromQueue) setPendingMedia(null);
      setTimeout(() => {
        setUploadProgress((prev) => {
          const next = { ...prev };
          delete next[tempId];
          return next;
        });
      }, 900);
    }
  }, [
    isConnected,
    dispatch,
    chatData.peerUser,
    saveMessagesToLocal,
    getOrCreateDeviceId,
    sendMessageViaSocket,
    persistMediaUploadQueue,
  ]);

  const flushQueuedMediaUploads = useCallback(async () => {
    if (mediaUploadQueueInFlightRef.current) return;
    if (!isConnected) return;

    const queue = [...(queuedMediaUploadsRef.current || [])];
    if (queue.length === 0) return;

    mediaUploadQueueInFlightRef.current = true;
    try {
      let working = [...queue];
      for (const item of queue) {
        const retries = Number(item?.retries || 0);
        if (retries >= MEDIA_UPLOAD_MAX_RETRIES) {
          working = working.filter((q) => q?.tempId !== item?.tempId);
          continue;
        }

        // Album tasks (multi-file) re-send through sendMediaGroup; single
        // media keeps the legacy path.
        const result = item?.albumObj
          ? await sendMediaGroup(item.albumObj, {
              tempId: item?.tempId,
              skipLocalInsert: true,
              fromQueue: true,
              createdAt: item?.createdAt,
            })
          : await sendMedia(item?.mediaObj, {
              tempId: item?.tempId,
              skipLocalInsert: true,
              fromQueue: true,
              createdAt: item?.createdAt,
            });

        if (result?.success) {
          working = working.filter((q) => q?.tempId !== item?.tempId);
        } else {
          working = working.map((q) => (
            q?.tempId === item?.tempId
              ? { ...q, retries: retries + 1 }
              : q
          ));
        }
      }

      queuedMediaUploadsRef.current = working;
      await persistMediaUploadQueue(working);
    } catch (error) {
      console.error('flushQueuedMediaUploads error', error);
    } finally {
      mediaUploadQueueInFlightRef.current = false;
    }
  }, [isConnected, persistMediaUploadQueue, sendMedia, sendMediaGroup]);

  flushQueuedMediaUploadsRef.current = flushQueuedMediaUploads;

  const resendMessage = useCallback(async (msg) => {
    if (!msg) return;
    if (msg.mediaUrl) {
      const normalizedCategory = normalizeOutboundMessageType(
        msg?.mediaType || msg?.type || msg?.fileCategory || 'file'
      );

      const deviceId = await getOrCreateDeviceId();

      const resolvedThumb =
        msg?.mediaThumbnailUrl ||
        msg?.thumbnailUrl ||
        msg?.payload?.mediaThumbnailUrl ||
        msg?.payload?.thumbnailUrl ||
        msg?.payload?.file?.mediaThumbnailUrl ||
        msg?.payload?.file?.thumbnailUrl ||
        msg?.payload?.file?.previewUrl ||
        msg?.previewUrl ||
        msg?.mediaUrl;
      const resolvedMediaUrl = msg?.mediaUrl || msg?.previewUrl || msg?.payload?.mediaUrl || '';
      const existingMeta = msg?.mediaMeta || msg?.payload?.mediaMeta || {};
      const messagePayload = {
        chatId: chatIdRef.current,
        chatType: chatData?.chatType || 'private',
        messageId: String(msg?.serverMessageId || msg?.id || msg?.tempId || generateClientMessageId()),
        senderId: currentUserIdRef.current,
        senderDeviceId: deviceId,
        receiverId: chatData.peerUser?._id || null,
        messageType: normalizedCategory,
        mediaId: String(msg?.mediaId || existingMeta?.mediaId || msg?.serverMessageId || msg?.id || ''),
        mediaUrl: resolvedMediaUrl,
        mediaThumbnailUrl: resolvedThumb || resolvedMediaUrl,
        mediaMeta: {
          fileName: existingMeta?.fileName || msg?.text || extractFileName(resolvedMediaUrl),
          fileSize: existingMeta?.fileSize || existingMeta?.sizeAfter || null,
          mimeType: existingMeta?.mimeType || msg?.payload?.file?.type || `application/${normalizedCategory}`,
          width: existingMeta?.width || null,
          height: existingMeta?.height || null,
        },
        status: 'sent',
        text: msg.text || '',
        createdAt: new Date().toISOString(),
      };

      const payloadValidation = validateMediaMessagePayload(messagePayload);
      if (!payloadValidation.isValid) {
        console.warn('❌ resendMessage: missing required media fields', payloadValidation.missing);
        updateMessageStatus(msg.tempId || msg.id, 'failed');
        return;
      }

      console.log("MESSAGE PAYLOAD", messagePayload);
      const payload = {
        ...messagePayload,
        fileCategory: normalizedCategory,
        previewUrl: messagePayload.mediaThumbnailUrl,
        thumbnailUrl: messagePayload.mediaThumbnailUrl,
        tempId: msg.tempId || `temp_retry_${Date.now()}`,
      };

      console.log('🔄 Resending media message with payload: *******', payload);
      try {
        await sendMessageViaSocket(payload, msg.tempId || payload.tempId);
      } catch (err) {
        console.warn('resendMessage failed', err);
      }
    } else if (msg.payload && msg.payload.file) {
      await sendMedia({ file: msg.payload.file, type: msg.type });
    } else {
      await sendMessageViaSocket({
        chatId: chatIdRef.current,
        chatType: chatData?.chatType || 'private',
        senderId: currentUserIdRef.current,
        receiverId: chatData.peerUser?._id || null,
        messageType: 'text',
        text: msg.text || '',
        tempId: msg.tempId || `temp_retry_${Date.now()}`,
        createdAt: new Date().toISOString(),
      }, msg.tempId || `temp_retry_${Date.now()}`);
    }
  }, [
    sendMessageViaSocket,
    sendMedia,
    chatData.peerUser,
    getOrCreateDeviceId,
    normalizeOutboundMessageType,
    validateMediaMessagePayload,
    updateMessageStatus,
  ]);

  const onRefresh = useCallback(async () => {
    setIsRefreshing(true);
    setIsManualReloading(false);
    reconnectAttempts.current = 0;
    loadMoreInFlightRef.current = false;
    fetchOlderCursorRef.current = null;
    await checkAndReconnectSocket();
    await syncMessagesToAPI();
    setHasLoadedFromAPI(false);
    setCurrentPage(1);
    setHasMoreMessages(true);
    fetchAndSyncMessagesViaSocket(chatIdRef.current, { limit: SOCKET_FETCH_LIMIT, force: true });
    dispatch(chatMessage({ chatId: chatIdRef.current, search: '', page: 1, limit: 50 }));
    setTimeout(() => setIsRefreshing(false), 1000);
  }, [dispatch, checkAndReconnectSocket, fetchAndSyncMessagesViaSocket]);

  const manualReloadMessages = useCallback(async () => {
    setIsManualReloading(true);
    setIsRefreshing(true);
    try {
      isHardReloadingRef.current = true;
      await checkAndReconnectSocket();
      forceReloadPendingRef.current = true;
      fetchAndSyncMessagesViaSocket(chatIdRef.current, {
        limit: SOCKET_FETCH_LIMIT,
        force: true,
      });
    } finally {
      setTimeout(() => {
        setIsRefreshing(false);
        setIsManualReloading(false);
      }, 800);

      setTimeout(() => {
        if (isHardReloadingRef.current) {
          isHardReloadingRef.current = false;
          forceReloadPendingRef.current = false;
        }
      }, 10000);
    }
  }, [checkAndReconnectSocket, fetchAndSyncMessagesViaSocket]);

  const refreshMessagesFromLocal = useCallback(async () => {
    if (!chatIdRef.current) return;

    setIsRefreshing(true);
    try {
      await loadDeletedTombstones(chatIdRef.current);
      await loadPendingEdits(chatIdRef.current);

      setAllMessages((prevMessages) => (
        prevMessages.filter((msg) => msg.chatId !== chatIdRef.current)
      ));

      await loadMessagesFromLocal(chatIdRef.current);
    } catch (error) {
      console.error('refreshMessagesFromLocal error', error);
    } finally {
      setTimeout(() => {
        setIsRefreshing(false);
      }, 500);
    }
  }, [loadDeletedTombstones, loadPendingEdits]);

  const toggleChatMute = useCallback((durationMs = null) => {
    const socket = socketRef.current || getSocket();
    const now = Date.now();
    const nextMuteUntil = durationMs ? now + durationMs : null;

    const currentlyMuted = Boolean(isChatMuted) && (!muteUntil || muteUntil > now);
    if (currentlyMuted && durationMs === null) {
      if (socket && isSocketConnected() && chatIdRef.current) {
        socket.emit('chat:unmute', { chatId: chatIdRef.current });
      }
      setIsChatMuted(false);
      setMuteUntil(null);
      return;
    }

    if (socket && isSocketConnected() && chatIdRef.current) {
      socket.emit('chat:mute', { chatId: chatIdRef.current, muteUntil: nextMuteUntil });
    }
    setIsChatMuted(true);
    setMuteUntil(nextMuteUntil);
  }, [isChatMuted, muteUntil]);

  // One-shot request/response for a single older-history page. The server's
  // wrapHandler replies on the `message:history:response` EVENT (not an ack
  // callback), carrying the result under `.data`. Resolves { ok, messages,
  // hasMore, oldestCursor }; ok=false on offline/timeout so the caller does NOT
  // mark the chat fully loaded on a mere network failure.
  const requestHistoryPage = useCallback(({ chatId, beforeSeq, limit, afterClearedAt, beforeCreatedAt }) => {
    return new Promise((resolve) => {
      const socket = getSocket();
      if (!socket || !isSocketConnected()) {
        resolve({ ok: false, messages: [], hasMore: false, oldestCursor: beforeSeq });
        return;
      }
      let settled = false;
      const cleanup = () => { socket.off('message:history:response', onResp); clearTimeout(timer); };
      const onResp = (response) => {
        const payload = response?.data || response || {};
        if (String(payload.chatId || '') !== String(chatId)) return; // not our chat
        if (settled) return;
        settled = true; cleanup();
        resolve({
          ok: true,
          messages: Array.isArray(payload.messages) ? payload.messages : [],
          hasMore: Boolean(payload.hasMore),
          oldestCursor: payload.oldestCursor != null ? payload.oldestCursor : beforeSeq,
        });
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true; cleanup();
        resolve({ ok: false, messages: [], hasMore: false, oldestCursor: beforeSeq, timedOut: true });
      }, 12000);
      socket.on('message:history:response', onResp);
      socket.emit('message:history', {
        chatId,
        beforeSeq: beforeSeq || null,
        // Legacy (pre-seq) fallback cursor: when seq paging bottoms out at the
        // first seq'd message, the server pages older null-seq rows by createdAt.
        beforeCreatedAt: beforeCreatedAt || null,
        limit: limit || SOCKET_FETCH_LIMIT,
        afterClearedAt: afterClearedAt || null,
      });
    });
  }, []);

  const loadMoreMessages = useCallback(async () => {
    if (isLoadingMore || loadMoreInFlightRef.current) return;
    if (!hasMoreMessages) return;

    // Oldest DISPLAYED anchor as a composite (timestamp, id) keyset cursor.
    // Ignore 0/NaN timestamps: one malformed row used to collapse the cursor
    // to 0 (or poison it with NaN), which disabled pagination for the whole
    // chat. The id tiebreak lets SQLite page past same-millisecond boundary
    // ties that a strict `timestamp <` could never reach.
    let oldest = 0;
    let oldestId = null;
    for (const msg of messages) {
      const ts = Number(msg?.timestamp);
      if (!Number.isFinite(ts) || ts <= 0) continue;
      const mid = String(msg.id || msg.serverMessageId || msg.tempId || '') || null;
      if (!oldest || ts < oldest) {
        oldest = ts;
        oldestId = mid;
      } else if (ts === oldest && mid && (!oldestId || mid < oldestId)) {
        oldestId = mid;
      }
    }
    if (!oldest) return;

    const cursorKey = `${oldest}:${oldestId || ''}`;
    if (fetchOlderCursorRef.current === cursorKey) return;

    loadMoreInFlightRef.current = true;
    fetchOlderCursorRef.current = cursorKey;
    setIsLoadingMore(true);

    try {
      const cid = chatIdRef.current;

      // Merge a page of older rows (from SQLite) into the displayed list,
      // de-duping by id and re-sorting newest-first.
      const mergeOlderRows = (olderRows) => {
        if (!olderRows || olderRows.length === 0) return;
        setAllMessages(prev => {
          const seenIds = new Set();
          for (const m of prev) {
            if (m.id) seenIds.add(m.id);
            if (m.serverMessageId) seenIds.add(m.serverMessageId);
            if (m.tempId) seenIds.add(m.tempId);
          }
          const newOnes = olderRows.filter(m => {
            const ids = [m.id, m.serverMessageId, m.tempId].filter(Boolean);
            return !ids.some(id => seenIds.has(id));
          }).map(m => ({
            ...m,
            senderType: m.senderId && sameId(m.senderId, currentUserIdRef.current) ? 'self' : 'other',
          }));
          if (newOnes.length === 0) return prev;
          const merged = [...prev, ...newOnes];
          merged.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
          // Grow the loaded-window floor so a later refreshMessagesFromDB reads
          // the whole window and doesn't drop these older rows we just paged in.
          loadedLimitRef.current = Math.max(loadedLimitRef.current || 0, merged.length);
          return merged;
        });
      };

      // STEP 1 — LOCAL-FIRST: page older rows straight from SQLite (timestamp
      // keyset cursor; immune to displayed-vs-DB count drift). No network, no
      // top spinner. A SHORT local page does NOT stop pagination — the server
      // may still have older history; the next scroll falls through to STEP 2.
      const olderLocal = await ChatDatabase.loadMessages(cid, {
        limit: SOCKET_FETCH_LIMIT,
        beforeTimestamp: oldest,
        beforeId: oldestId,
        skipCleanup: true,
      });
      if (olderLocal.length > 0) {
        mergeOlderRows(olderLocal);
        return;
      }

      // STEP 2 — LOCAL EXHAUSTED: backfill exactly ONE older page from MongoDB,
      // persist it in small serialized chunks, then re-read it locally.
      if (await ChatDatabase.isHistoryFullyLoaded(cid)) {
        setHasMoreMessages(false);
        return;
      }

      setIsBackfilling(true); // network fetch in progress → top-of-list spinner
      try {
        // MIN(seq) locally; 0 → "no cursor" so the server returns the NEWEST page
        // (bootstraps a chat that has nothing seq'd locally). clearedAt bounds the
        // backfill so a cleared chat's history is never resurrected.
        const beforeSeq = await ChatDatabase.getOldestSeq(cid);
        const clearedAt = await ChatDatabase.getClearedAt(cid);
        const resp = await requestHistoryPage({
          chatId: cid,
          beforeSeq,
          // Once seq paging bottoms out (beforeSeq pinned at the lowest seq),
          // the server pages legacy null-seq rows OLDER than this timestamp.
          // `oldest` = the oldest loaded message's timestamp; it descends as
          // legacy rows are paged in, so this cursor advances each page.
          beforeCreatedAt: oldest || 0,
          limit: SOCKET_FETCH_LIMIT,
          afterClearedAt: clearedAt || 0,
        });

        if (resp.messages.length > 0) {
          // Map raw Mongo docs → client shape, PRESERVING seq (the generic
          // normalizer drops it) so the backfill cursor advances and the same
          // page is never refetched. Idempotent + monotonic upsert handles any
          // overlap with a message that also arrived live.
          const normalized = resp.messages.map(m => ({
            ...normalizeIncomingMessage(m),
            seq: (m.seq != null && !Number.isNaN(Number(m.seq))) ? Number(m.seq) : null,
            synced: true,
          }));
          // Persist NEWEST-FIRST so the oldest cursor only ever descends one
          // chunk at a time; a kill mid-page resumes exactly at the gap (oldest-
          // first would jump the floor past the un-persisted middle → skip).
          // seq'd rows: by MIN(seq). Legacy (seq null) rows: by createdAt, since
          // the legacy backfill cursor is `beforeCreatedAt` (timestamp), not seq.
          normalized.sort((a, b) => {
            const sa = Number(a.seq), sb = Number(b.seq);
            const aHas = Number.isFinite(sa), bHas = Number.isFinite(sb);
            if (aHas && bHas && sa !== sb) return sb - sa;       // both seq'd → newest seq first
            if (aHas !== bHas) return aHas ? -1 : 1;             // seq'd before legacy (pages don't mix)
            return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0); // legacy → newest createdAt first
          });
          // Persist in SHORT chunks through the existing serialized writer,
          // AWAITED, yielding a macrotask between chunks so live message/receipt
          // writers win the writer lock — never one long/bulk transaction.
          const CHUNK = 25;
          for (let i = 0; i < normalized.length; i += CHUNK) {
            await SqliteWriter.enqueue('upsertMessages', normalized.slice(i, i + CHUNK));
            await new Promise(r => setTimeout(r, 0));
          }
          // The just-persisted older rows now satisfy the local timestamp cursor.
          const olderNow = await ChatDatabase.loadMessages(cid, {
            limit: SOCKET_FETCH_LIMIT,
            beforeTimestamp: oldest,
            beforeId: oldestId,
            skipCleanup: true,
          });
          mergeOlderRows(olderNow);
        }

        if (resp.ok && !resp.hasMore) {
          // Reached the first message — stop asking the server for this chat.
          await ChatDatabase.setHistoryFullyLoaded(cid);
          setHasMoreMessages(false);
        } else if (!resp.ok) {
          // Network failure/timeout — let a later scroll retry the same cursor.
          fetchOlderCursorRef.current = null;
        } else {
          // resp.ok && hasMore: clear the cursor guard even if this page
          // produced no VISIBLE older rows (seq-vs-timestamp order can make a
          // whole page dedupe into the current window). The persisted page
          // still moved MIN(seq) down, so the next scroll fetches strictly
          // older rows — without this reset the guard froze on an unchanged
          // `oldest` and pagination was dead until remount.
          fetchOlderCursorRef.current = null;
        }
      } finally {
        setIsBackfilling(false);
      }
    } catch (err) {
      console.warn('[loadMoreMessages] error:', err);
      fetchOlderCursorRef.current = null;
    } finally {
      setIsLoadingMore(false);
      loadMoreInFlightRef.current = false;
    }
  }, [isLoadingMore, hasMoreMessages, messages, requestHistoryPage, normalizeIncomingMessage]);

  /* ========== FIXED: Render status helper ========== */
  const renderStatusText = useCallback(() => {
    if (isPeerTyping) {
      return 'typing...';
    }
    if (customStatus) {
      return customStatus;
    }
    if (userStatus === PRESENCE_STATUS.ONLINE) {
      return 'online';
    }
    if (userStatus === PRESENCE_STATUS.AWAY) {
      return 'away';
    }
    if (userStatus === PRESENCE_STATUS.BUSY) {
      return 'busy';
    }
    if (lastSeen) {
      return `last seen ${moment(lastSeen).fromNow()}`;
    }
    return 'offline';
  }, [isPeerTyping, userStatus, lastSeen, customStatus]);

  const openMediaOptions = () => {
    Keyboard.dismiss();
    setShowMediaOptions(true);
  };
  const closeMediaOptions = () => setShowMediaOptions(false);
  const closeMediaViewer = useCallback(() => setMediaViewer({ visible: false, uri: null, type: null }), []);
  
  const handlePickMedia = useCallback(async (type) => {
    try {
      closeMediaOptions();
      // Gallery / video / document pickers allow WhatsApp-style multi-select.
      // One file keeps the legacy single-media flow; several files stage an
      // album (sent as ONE message with a media grid bubble).
      if (typeof pickMediaMultiple === 'function' && (type === 'image' || type === 'video' || type === 'document')) {
        const files = await pickMediaMultiple(type);
        if (!files || !files.length) return;
        if (files.length === 1) {
          setPendingMedia({ file: files[0], type });
        } else {
          setPendingMedia({ files, type, isAlbum: true });
        }
        return;
      }
      const file = await pickMedia(type);
      if (!file) return;
      setPendingMedia({ file, type });
    } catch (err) {
      console.error("handlePickMedia error", err);
    }
  }, [pickMedia, pickMediaMultiple]);

  // SQLite is the single source of truth — no in-memory dedup needed.
  // The periodic dedup cleanup runs via ChatDatabase.deduplicateChat() on chat open.

  useEffect(() => {
    console.log("📱 ChatScreen received params:", {
      params: route.params,
      chatId: route.params?.chatId,
      user: route.params?.user,
      isNewContact: route.params?.isNewContact,
      hasExistingChat: route.params?.hasExistingChat,
      isNewChat: route.params?.isNewChat
    });
  }, [route.params]);

  // ─── MESSAGE REACTIONS ───
  // Helper: update reactions for a message directly in allMessages state (instant, no flicker)
  const updateReactionsInState = useCallback((msgId, newReactions) => {
    if (!msgId) return;
    const mid = String(msgId);
    setAllMessages(prev => {
      let changed = false;
      const updated = prev.map(m => {
        const isMatch =
          String(m.id || '') === mid ||
          String(m.serverMessageId || '') === mid ||
          String(m.tempId || '') === mid;
        if (!isMatch) return m;
        changed = true;
        const finalReactions = (newReactions && typeof newReactions === 'object' && Object.keys(newReactions).length > 0)
          ? newReactions
          : undefined;
        return { ...m, reactions: finalReactions };
      });
      return changed ? updated : prev;
    });
  }, []);

  const toggleReaction = useCallback((msgId, emoji, skinTone) => {
    if (!msgId || !emoji || !currentUserIdRef.current) return;

    const uid = currentUserIdRef.current;
    const isGrpReact = chatData?.chatType === 'group' || chatData?.isGroup;

    // Get current reactions from in-memory state first (instant, no async wait)
    const currentMsgs = allMessagesRef.current || [];
    const targetMsg = currentMsgs.find(m =>
      String(m.id || '') === String(msgId) ||
      String(m.serverMessageId || '') === String(msgId) ||
      String(m.tempId || '') === String(msgId)
    );

    console.log('[toggleReaction] msgId:', msgId, '| found:', !!targetMsg, '| uid:', uid, '| emoji:', emoji, '| totalMsgs:', currentMsgs.length);

    const oldReactions = targetMsg?.reactions || {};

    // Deep-copy each emoji entry so we don't mutate state
    const reactions = {};
    for (const [k, v] of Object.entries(oldReactions)) {
      if (/^\d+$/.test(k) || !k) continue; // skip invalid keys
      reactions[k] = { count: v.count, users: [...(v.users || [])] };
    }

    const existing = reactions[emoji] || { count: 0, users: [] };
    const hasReacted = existing.users?.some(u => String(u) === String(uid));
    const action = hasReacted ? 'remove' : 'add';

    // STEP 1: Remove this user from ALL emojis (enforce one-reaction-per-user)
    for (const [key, data] of Object.entries(reactions)) {
      const idx = data.users.findIndex(u => String(u) === String(uid));
      if (idx !== -1) {
        data.users.splice(idx, 1);
        data.count = Math.max(0, data.count - 1);
        if (data.count === 0) delete reactions[key];
      }
    }

    // STEP 2: If it was a different emoji (not toggle-off), add to the new one
    if (!hasReacted) {
      const entry = reactions[emoji] || { count: 0, users: [] };
      entry.users.push(uid);
      entry.count = entry.users.length;
      reactions[emoji] = entry;
    }

    console.log('[toggleReaction] action:', action, '| finalReactions:', JSON.stringify(reactions));

    // INSTANT UI update — no DB round-trip, no flicker
    updateReactionsInState(msgId, reactions);

    // Also update memory cache so refreshMessagesFromDB preserves it
    ChatCache.updateMessage(chatIdRef.current, msgId, { reactions: Object.keys(reactions).length > 0 ? reactions : undefined });

    // Persist to SQLite SYNCHRONOUSLY (awaited) — must complete before any refreshMessagesFromDB
    SqliteWriter.enqueue('updateReactions', { messageId: msgId, reactions }).catch(() => {});

    // Emit to server
    const socket = socketRef.current || getSocket();
    if (socket && isSocketConnected()) {
      if (isGrpReact) {
        // Group chat — emit with ack for server confirmation
        const reactionPayload = {
          groupId: chatData?.groupId || chatData?.group?._id || chatIdRef.current,
          chatId: chatIdRef.current,
          messageId: msgId,
          emoji,
          action,
          userId: uid,
        };
        console.log('[GroupReaction] emit group:message:reaction:', reactionPayload);
        socket.emit('group:message:reaction', reactionPayload, (ack) => {
          console.log('[GroupReaction] ack:', JSON.stringify(ack));
          if (!ack) return;
          const source = ack?.data || ack;
          // If server returns authoritative reactions, apply them
          const rawReactions = source?.reactions || source?.reaction;
          if (rawReactions && typeof rawReactions === 'object') {
            const normalized = sanitizeReactions(rawReactions);
            if (normalized) {
              updateReactionsInState(msgId, normalized);
              SqliteWriter.enqueue('updateReactions', { messageId: msgId, reactions: normalized }).catch(() => {});
            }
          }
        });
      } else {
        // 1-on-1 chat — emit with ack callback to capture server response
        const event = action === 'add' ? 'message:reaction:add' : 'message:reaction:remove';
        const reactionPayload = {
          messageId: msgId,
          chatId: chatIdRef.current,
          emoji,
          userId: uid,
          ...(action === 'add' && skinTone ? { skinTone } : {}),
        };
        console.log(`[Reaction] emit ${event}:`, reactionPayload);
        socket.emit(event, reactionPayload, (ack) => {
          console.log(`[Reaction] ${event} ack:`, JSON.stringify(ack));
          if (!ack) return;
          const source = ack?.data || ack;
          // If server returns authoritative reactions map, apply it
          if (source?.reactions && typeof source.reactions === 'object') {
            updateReactionsInState(msgId, source.reactions);
            SqliteWriter.enqueue('updateReactions', { messageId: msgId, reactions: source.reactions }).catch(() => {});
          }
        });
      }
    }

  }, [chatData, updateReactionsInState]);

  const removeReaction = useCallback((msgId, emoji) => {
    if (!msgId || !emoji || !currentUserIdRef.current) return;

    const uid = currentUserIdRef.current;
    const isGrpReact = chatData?.chatType === 'group' || chatData?.isGroup;

    // Get current reactions from in-memory state
    const currentMsgs = allMessagesRef.current || [];
    const targetMsg = currentMsgs.find(m => m.id === msgId || m.serverMessageId === msgId || m.tempId === msgId);
    const oldReactions = targetMsg?.reactions || {};

    // Deep-copy
    const reactions = {};
    for (const [k, v] of Object.entries(oldReactions)) {
      reactions[k] = { count: v.count, users: [...(v.users || [])] };
    }

    // Remove user from ALL emojis (cleans up any duplicates too)
    let removed = false;
    for (const [key, data] of Object.entries(reactions)) {
      const idx = data.users.indexOf(uid);
      if (idx !== -1) {
        data.users.splice(idx, 1);
        data.count = Math.max(0, data.count - 1);
        if (data.count === 0) delete reactions[key];
        removed = true;
      }
    }
    if (!removed) return;

    // INSTANT UI update
    updateReactionsInState(msgId, reactions);

    // Also update memory cache so refreshMessagesFromDB preserves it
    ChatCache.updateMessage(chatIdRef.current, msgId, { reactions: Object.keys(reactions).length > 0 ? reactions : undefined });

    // Persist to SQLite
    SqliteWriter.enqueue('updateReactions', { messageId: msgId, reactions }).catch(() => {});

    // Emit to server
    const socket = socketRef.current || getSocket();
    if (socket && isSocketConnected()) {
      if (isGrpReact) {
        const removePayload = {
          groupId: chatData?.groupId || chatData?.group?._id || chatIdRef.current,
          chatId: chatIdRef.current,
          messageId: msgId,
          emoji,
          action: 'remove',
          userId: uid,
        };
        console.log('[GroupReaction] emit remove:', removePayload);
        socket.emit('group:message:reaction', removePayload, (ack) => {
          console.log('[GroupReaction] remove ack:', JSON.stringify(ack));
          if (!ack) return;
          const source = ack?.data || ack;
          const rawReactions = source?.reactions || source?.reaction;
          if (rawReactions && typeof rawReactions === 'object') {
            const normalized = sanitizeReactions(rawReactions);
            if (normalized) {
              updateReactionsInState(msgId, normalized);
              SqliteWriter.enqueue('updateReactions', { messageId: msgId, reactions: normalized }).catch(() => {});
            }
          }
        });
      } else {
        const reactionPayload = {
          chatId: chatIdRef.current,
          messageId: msgId,
          emoji,
          userId: uid,
        };
        console.log('[Reaction] emit message:reaction:remove:', reactionPayload);
        socket.emit('message:reaction:remove', reactionPayload, (ack) => {
          console.log('[Reaction] message:reaction:remove ack:', JSON.stringify(ack));
          if (!ack) return;
          const source = ack?.data || ack;
          if (source?.reactions && typeof source.reactions === 'object') {
            updateReactionsInState(msgId, source.reactions);
            SqliteWriter.enqueue('updateReactions', { messageId: msgId, reactions: source.reactions }).catch(() => {});
          }
        });
      }
    }
  }, [chatData, updateReactionsInState]);

  // Server returns reactions as an ARRAY of { userId, emoji, ... } documents.
  // Local state uses a MAP { emoji: { count, users:[userId,...] } }. Convert
  // before merging — otherwise the reducer wipes reactions instead of refining.
  const reactionsArrayToMap = (arr) => {
    if (!Array.isArray(arr)) return null;
    const map = {};
    for (const r of arr) {
      const emoji = r?.emoji;
      if (!emoji) continue;
      const uid = String(r?.userId?._id || r?.userId || '');
      if (!uid) continue;
      const entry = map[emoji] || { count: 0, users: [] };
      if (!entry.users.includes(uid)) entry.users.push(uid);
      entry.count = entry.users.length;
      map[emoji] = entry;
    }
    return map;
  };

  const fetchReactionList = useCallback((msgId) => {
    return new Promise((resolve, reject) => {
      const socket = socketRef.current || getSocket();
      if (!socket || !isSocketConnected()) return reject(new Error('Socket not connected'));
      let finished = false;
      const timeout = setTimeout(() => {
        if (finished) return;
        finished = true;
        socket.off('message:reaction:list:response', onResponse);
        reject(new Error('Timeout'));
      }, 5000);

      const applyFromPayload = (payload) => {
        const arr = payload?.reactions;
        if (Array.isArray(arr)) {
          const map = reactionsArrayToMap(arr);
          if (map) applyReactionUpdate(msgId, () => map);
        } else if (arr && typeof arr === 'object') {
          applyReactionUpdate(msgId, () => arr);
        }
      };

      const onResponse = (data) => {
        if (finished) return;
        const source = data?.data || data;
        if (source?.messageId && String(source.messageId) !== String(msgId)) return;
        finished = true;
        clearTimeout(timeout);
        socket.off('message:reaction:list:response', onResponse);

        if (data?.status === false) return reject(new Error(source?.message || 'Failed'));
        applyFromPayload(source);
        resolve(source);
      };

      socket.on('message:reaction:list:response', onResponse);
      socket.emit('message:reaction:list', { messageId: msgId }, (ack) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        socket.off('message:reaction:list:response', onResponse);
        const res = ack?.data || ack;
        if (ack?.status === false) return reject(new Error(res?.message || 'Failed'));
        applyFromPayload(res);
        resolve(res);
      });
    });
  }, []);

  return {
    fadeAnimRef, flatListRef,
    chatData, chatId, currentUserId, getUserColor, groupMembersMap: groupMembersMapRef.current,
    amNotGroupMember, liveMemberCount,
    messages, allMessages, scheduledMessages, isLoadingInitial, isLoadingFromLocal, isRefreshing, isManualReloading, isSearching,
    // FIXED: Export the correct typing state
    isPeerTyping, // This is what the UI should use for "typing..." indicator
    isLocalTyping, // Optional: if UI needs to know local typing state
    userStatus, customStatus, presenceDetails, manualPresencePending, renderStatusText,
    setManualPresence, clearManualPresence,
    search, handleSearch, clearSearch, goToNextResult, goToPreviousResult, searchResults, currentSearchIndex,
    selectedMessage, handleToggleSelectMessages, handleDeleteSelected, promptDeleteSingleMessage,
    text, setText, handleTextChange, handleSendText,
    scheduleMessage, cancelScheduledMessage,
    sendLocationMessage, sendContactMessage,
    pendingMedia, setPendingMedia, sendMedia, sendMediaGroup, handlePickMedia, showMediaOptions, openMediaOptions, closeMediaOptions,
    mediaViewer, closeMediaViewer, handleDownloadMedia, downloadedMedia, downloadProgress, uploadProgress, mediaDownloadStates,
    markMediaRemovedLocally,
    retryMediaStatusUpdate, retryAllFailedMediaStatusUpdates,
    onRefresh, loadMoreMessages, isLoadingMore, isBackfilling, hasMoreMessages,
    manualReloadMessages,
    refreshMessagesFromLocal,
    isChatMuted, muteUntil, toggleChatMute,
    clearChatForMe,
    clearChatForEveryone,
    markVisibleIncomingAsRead,
    setMessages, saveMessagesToLocal, resendMessage,
    editingMessage, startEditMessage, cancelEditMessage, submitEditMessage,
    replyTarget, startReply, cancelReply,
    toggleReaction, removeReaction, fetchReactionList,
    clearSelectedMessages,
  };
}