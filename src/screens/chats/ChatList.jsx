import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Animated,
  TextInput,
  Image,
  Platform,
  Alert,
  StyleSheet,
  Dimensions,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../../contexts/ThemeContext';
import { Menu } from 'react-native-paper';
import { useDispatch, useSelector } from 'react-redux';
import { chatListData } from '../../Redux/Reducer/Chat/Chat.reducer';
import { useFocusEffect } from '@react-navigation/native';
import { FontAwesome6, AntDesign, MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import { useRealtimeChat } from '../../contexts/RealtimeChatContext';
import ChatCard from '../../components/ChatCard';
import ProfilePreviewModal from '../../components/ProfilePreviewModal';
import useStatusIndicators from '../../hooks/useStatusIndicators';
import useContactDirectory from '../../hooks/useContactDirectory';
import { useCall } from '../../calls/useCall';
import { viewGroup as viewGroupApi } from '../../Redux/Services/Group/Group.Services';
import ChatCache from '../../services/ChatCache';
import ChatDatabase from '../../services/ChatDatabase';
import ContactDatabase from '../../services/ContactDatabase';
import { subscribeSessionReset } from '../../services/sessionEvents';
import { apiCall } from '../../Config/Https';
import { normalizeChatStorageId, removeMessagesByChatId } from '../../utils/chatClearStorage';
import { getUserSettings } from '../../Redux/Services/Profile/Settings.Services';
import {
  DELETED_PWD_SET_KEY,
  getDeletedChatConfig,
  saveDeletedChatConfig,
  markDeletedPasswordSet,
} from '../../utils/deletedChatConfig';
import { APP_TAG_NAME } from '@env';
import { ImageZoom } from '@likashefqet/react-native-image-zoom';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Debug switch for tracing WHERE the chat list comes from (SQLite cache vs the
// REST API). The list renders from SQLite (via the realtime context); the API
// is only hit when SQLite is empty (first login), on pull-to-refresh, or to
// hydrate a brand-new chat missing its name/avatar. Flip to false to silence.
const DEBUG_CHAT_SOURCE = true;
const cllog = (...args) => { if (DEBUG_CHAT_SOURCE) console.log('[CHAT-SOURCE]', ...args); };

const MUTE_OPTIONS = [
  { key: '8h', label: '8 hours', icon: 'clock-time-eight-outline', duration: 8 * 60 * 60 * 1000 },
  { key: '1w', label: '1 week', icon: 'calendar-week', duration: 7 * 24 * 60 * 60 * 1000 },
  { key: 'always', label: 'Always', icon: 'bell-off-outline', duration: 0 },
];

const name = APP_TAG_NAME

const AVATAR_COLORS = ['#6C5CE7', '#00B894', '#E17055', '#0984E3', '#E84393', '#00CEC9', '#D63031', '#A29BFE'];

const getAvatarColor = (name) => {
  if (!name) return AVATAR_COLORS[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

// Resolve the peer's registered user id for a private chat. Prefer the explicit
// peerUser id, then peerUserId, and finally fall back to parsing it out of a
// canonical chatId (`u_<idA>_<idB>`) — that last case catches half-hydrated rows
// (e.g. an incoming-message stub) that carry only a chatId. Returns '' for
// groups or when nothing resolves.
const peerIdOf = (chat, currentUserId) => {
  const isGroup = chat?.chatType === 'group' || chat?.isGroup;
  if (isGroup) return '';
  const direct = String(chat?.peerUser?._id || chat?.peerUserId || '');
  if (direct) return direct;
  const cid = String(chat?.chatId || chat?._id || '');
  if (currentUserId && cid.startsWith('u_')) {
    const parts = cid.slice(2).split('_');
    if (parts.length === 2) {
      const other = parts.find((p) => p && p !== String(currentUserId));
      if (other) return other;
    }
  }
  return '';
};

// Force the chat row's displayed name to match the user's saved contact name.
// `contactMap` is userId -> { fullName, profileImage } built from the locally
// synced registered-contacts (ContactDatabase). When the peer is a saved
// contact we override peerUser.fullName so the chat list name is ALWAYS the
// same as the name in the registered contact list — regardless of which path
// (socket / api / sqlite) delivered the row or what name it shipped. The
// account profile image is kept (only used as a fallback). Unsaved peers and
// groups are returned unchanged.
const applyContactName = (chat, peerId, contactMap) => {
  if (!contactMap || !peerId) return chat;
  const saved = contactMap[peerId];
  const savedName = saved && String(saved.fullName || '').trim();
  if (!savedName) return chat;
  return {
    ...chat,
    peerUser: {
      ...(chat?.peerUser || {}),
      _id: peerId,
      fullName: savedName,
      profileImage: chat?.peerUser?.profileImage || saved.profileImage || null,
    },
  };
};

// Collapse any private chats that resolve to the SAME peer user into ONE row,
// so the chat list is always unique per contact. The in-memory state can
// momentarily hold two rows for one peer — e.g. an old number-only row plus a
// freshly saved-contact row, or a legacy unsorted chatId alongside the canonical
// sorted one. We key strictly by the peer's registered user id. When a peer has
// duplicates the CANONICAL (sorted-id) row wins, else the most recently active
// one; name/avatar/unread are merged so the surviving row never loses data.
// Groups and rows with no resolved peer id pass through untouched. The surviving
// row's name is then forced to the saved-contact name via `contactMap`.
const dedupeChatsByPeer = (list, currentUserId, contactMap) => {
  if (!Array.isArray(list) || list.length === 0) return [];
  const canonicalId = (peerId) =>
    currentUserId && peerId ? `u_${[String(currentUserId), String(peerId)].sort().join('_')}` : null;
  const tsOf = (c) => new Date(c?.lastMessageAt || c?.updatedAt || 0).getTime() || 0;

  const indexByPeer = new Map();
  const result = [];
  for (const chat of list) {
    const peerId = peerIdOf(chat, currentUserId);
    if (!peerId) { result.push(chat); continue; }

    if (!indexByPeer.has(peerId)) {
      indexByPeer.set(peerId, result.length);
      result.push(applyContactName(chat, peerId, contactMap));
      continue;
    }

    const idx = indexByPeer.get(peerId);
    const keeper = result[idx];
    const cid = canonicalId(peerId);
    const chatCanon = Boolean(cid && String(chat?.chatId || chat?._id) === cid);
    const keeperCanon = Boolean(cid && String(keeper?.chatId || keeper?._id) === cid);

    let winner = keeper;
    let loser = chat;
    if (chatCanon && !keeperCanon) { winner = chat; loser = keeper; }
    else if (chatCanon === keeperCanon && tsOf(chat) > tsOf(keeper)) { winner = chat; loser = keeper; }

    const merged = {
      ...loser,
      ...winner,
      peerUser: {
        ...(loser?.peerUser || {}),
        ...(winner?.peerUser || {}),
        _id: peerId,
        fullName: winner?.peerUser?.fullName || loser?.peerUser?.fullName || '',
        profileImage: winner?.peerUser?.profileImage || loser?.peerUser?.profileImage || null,
      },
      unreadCount: Math.max(Number(winner?.unreadCount || 0), Number(loser?.unreadCount || 0)),
    };
    result[idx] = applyContactName(merged, peerId, contactMap);
  }
  return result;
};

// Module-level warm cache for the saved-contact name map (userId ->
// { fullName, profileImage }). It lives OUTSIDE the component so it survives the
// ChatList unmount/remount that `detachInactiveScreens` triggers on tab switches.
// Re-entering the Chats tab seeds names synchronously from this cache — no
// "Unknown" name flash, and no blocking ContactDatabase read on the render path.
// A non-blocking background refresh on focus still keeps it fresh, and it is
// cleared on session reset so contact names never leak across account switches.
let _contactMapCache = null;
subscribeSessionReset(() => {
  _contactMapCache = null;
});

// Shallow content equality so a background refresh that produced an identical
// map does not create a new reference (which would needlessly re-run the
// dedupe/derivation memo on the warm chat list).
const isSameContactMap = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const av = a[k];
    const bv = b[k];
    if (!bv || av.fullName !== bv.fullName || av.profileImage !== bv.profileImage) return false;
  }
  return true;
};

// Memoized chat-row wrapper. The FlatList renderItem previously inlined the row,
// minting fresh onPress/onLongPress/onAvatarPress closures (and getter props) for
// EVERY row on EVERY parent render (presence/typing/status/list ticks), which
// defeated memo(ChatCard) → the whole visible list re-rendered each tick ("slow
// to update" warning, jank, OOM crash on large lists). This component is memo'd on
// stable props (item ref, theme, booleans, stable callbacks/getters), so only rows
// whose own data actually changed re-render. The per-row closures are built HERE,
// inside a component that re-renders only when its props change — not in the parent.
const ChatListRow = memo(function ChatListRow({
  item,
  theme,
  isSelected,
  statusInfo,
  selectionMode,
  onOpen,
  onToggleSelect,
  onEnterSelection,
  onOpenStatusViewer,
  onOpenProfile,
  getUserColor,
  getPreviewText,
  getRelativeTime,
  getLastMessageText,
  renderMessageStatus,
}) {
  const itemChatId = item?.chatId || item?._id;
  return (
    <View>
      <ChatCard
        item={item}
        theme={theme}
        isSelected={isSelected}
        statusInfo={statusInfo}
        onPress={() => {
          if (selectionMode) onToggleSelect(itemChatId);
          else onOpen(item);
        }}
        onLongPress={() => {
          if (selectionMode) onToggleSelect(itemChatId);
          else onEnterSelection(itemChatId);
        }}
        onAvatarPress={() => {
          if (selectionMode) onToggleSelect(itemChatId);
          else if (statusInfo && statusInfo.count > 0) onOpenStatusViewer(statusInfo.group);
          else onOpenProfile(item);
        }}
        getUserColor={getUserColor}
        getPreviewText={getPreviewText}
        getRelativeTime={getRelativeTime}
        getLastMessageText={getLastMessageText}
        renderMessageStatus={renderMessageStatus}
      />
      {isSelected && (
        <View style={styles.selectionCheckOverlay} pointerEvents="none">
          <View style={[styles.selectionCheckCircle, { backgroundColor: theme.colors.themeColor }]}>
            <Ionicons name="checkmark" size={14} color="#fff" />
          </View>
        </View>
      )}
    </View>
  );
});

export default function ChatList({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const openSwipeableRef = useRef(null);
  const dispatch = useDispatch();
  const { chatsData, isLoading } = useSelector((state) => state.chat);

  // WhatsApp-style status rings on chat rows: a userId → indicator map kept live
  // via the status feed + realtime sockets (see the hook for data-source order).
  const statusByUserId = useStatusIndicators();
  const { resolveName } = useContactDirectory();
  const { startAudioCall, startVideoCall, startGroupAudioCall, startGroupVideoCall } = useCall();

  const [visible, setVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // timeTick drives the 30s relative-time refresh. With memoized rows it must be
  // threaded into renderItem so visible rows re-render and recompute "Today" /
  // "Yesterday" etc. (only the ~10-15 mounted rows re-render — negligible).
  const [timeTick, setTimeTick] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('all');
  const [actionSheetVisible, setActionSheetVisible] = useState(false);
  const [muteSheetVisible, setMuteSheetVisible] = useState(false);
  const [selectedChatItem, setSelectedChatItem] = useState(null);
  const [profilePreviewVisible, setProfilePreviewVisible] = useState(false);
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [deleteForEveryone, setDeleteForEveryone] = useState(false);
  const [currentUserId, setCurrentUserId] = useState(null);
  // userId -> { fullName, profileImage } for locally-synced registered contacts.
  // Used to force each chat row's name to the saved-contact name (the same name
  // shown in the contact list). Refreshed whenever the screen regains focus, so
  // a contact saved/renamed elsewhere is reflected on return.
  const [contactMap, setContactMap] = useState(_contactMapCache);

  // Multi-select state (WhatsApp-style "delete for me" of multiple chats)
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedChatIds, setSelectedChatIds] = useState([]);
  // "Add to deleted chats" (panic-password automation). The header action only
  // appears when a deleted-chats password actually exists — arming chats with no
  // password to trigger them would be a dead switch. `armedChatIds` is the set
  // already armed, so re-adding the same chat is a no-op instead of a duplicate.
  const [deletedPwdSet, setDeletedPwdSet] = useState(false);
  const [armedChatIds, setArmedChatIds] = useState([]);
  const [armedScope, setArmedScope] = useState('me');
  const [isArming, setIsArming] = useState(false);
  const [bulkDeleteModalVisible, setBulkDeleteModalVisible] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  // Visible during the entire blocking delete (server call + local cleanup).
  // Prevents the user from interacting with the list mid-delete.
  const [bulkDeleteProgress, setBulkDeleteProgress] = useState({ visible: false, label: '' });

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedChatIds([]);
  }, []);

  const toggleChatSelection = useCallback((chatId) => {
    if (!chatId) return;
    setSelectedChatIds((prev) => {
      if (prev.includes(chatId)) {
        const next = prev.filter((id) => id !== chatId);
        if (next.length === 0) setSelectionMode(false);
        return next;
      }
      return [...prev, chatId];
    });
  }, []);

  const enterSelectionMode = useCallback((chatId) => {
    if (!chatId) return;
    setSelectionMode(true);
    setSelectedChatIds((prev) => (prev.includes(chatId) ? prev : [...prev, chatId]));
  }, []);

  // Load current user id once — used to gate tick rendering to outgoing last-messages only
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('userInfo');
        const u = raw ? JSON.parse(raw) : null;
        const id = u?._id || u?.id || null;
        if (id) setCurrentUserId(String(id));
      } catch {}
    })();
  }, []);

  // Navigate IMMEDIATELY. The previous version awaited SQLite reads first,
  // which on a freshly-updated app would block behind expo-sqlite schema
  // migrations — making the chat list look unresponsive until migrations
  // finished. The preload is now fire-and-forget; ChatScreen has its own
  // SQLite load fallback if the cache is cold when it mounts.
  const openChat = useCallback((item) => {
    const chatId = item?.chatId || item?._id;
    // Always navigate first — never let a tap depend on async work completing.
    navigation.navigate('ChatScreen', { item });

    if (!chatId) return;
    if (ChatCache.hasMessages(chatId)) return; // cache already warm

    // Fire-and-forget preload. Honors the per-chat tombstone. Any error
    // (including a hang during schema migration) is swallowed silently —
    // ChatScreen will read SQLite directly once it's ready.
    (async () => {
      try {
        const clearedAt = (await ChatDatabase.getClearedAt(chatId)) || 0;
        const msgs = await ChatDatabase.loadMessages(chatId, { limit: 30, afterTimestamp: clearedAt });
        if (msgs && msgs.length > 0) ChatCache.setMessages(chatId, msgs);
      } catch {}
    })();
  }, [navigation]);
  const [isDeletingChat, setIsDeletingChat] = useState(false);
  const [imageViewerVisible, setImageViewerVisible] = useState(false);
  // Profile modal animations
  const profileOpacityAnim = useRef(new Animated.Value(0)).current;
  const profileScaleAnim = useRef(new Animated.Value(0)).current;
  // Action sheet slide animation
  const sheetSlideAnim = useRef(new Animated.Value(300)).current;
  const sheetBgAnim = useRef(new Animated.Value(0)).current;

  const {
    chatList: realtimeChatList,
    archivedChatList: realtimeArchivedChatList,
    hydrateChats,
    state: realtimeState,
    requestChatInfo,
    pinChat,
    unpinChat,
    muteChat,
    unmuteChat,
    archiveChat,
    unarchiveChat,
    applyChatClearedPreview,
    removeChat,
  } = useRealtimeChat();

  const effectiveChatList = Array.isArray(realtimeChatList)
    ? realtimeChatList
    : (Array.isArray(chatsData) ? chatsData.filter((chat) => !chat?.isArchived) : []);

  const effectiveArchivedChatList = Array.isArray(realtimeArchivedChatList)
    ? realtimeArchivedChatList
    : (Array.isArray(chatsData) ? chatsData.filter((chat) => Boolean(chat?.isArchived)) : []);

  // Guarantee a unique-per-contact list — never render two rows for the same
  // peer user id. (Defensive: the realtime reducer alias-merges on updates, but
  // this collapses any residual duplicates, e.g. a legacy unsorted-id row.)
  const dedupedChatList = useMemo(
    () => dedupeChatsByPeer(effectiveChatList, currentUserId, contactMap),
    [effectiveChatList, currentUserId, contactMap]
  );

  const getLastMessageText = useCallback((item) => item?.lastMessageDisplay?.fullText || item?.lastMessageDisplay?.text || item?.lastMessage?.text || 'No messages yet', []);

  // LayoutAnimation disabled — causes frame drops on low-end Android devices

  const filteredChats = useMemo(() => {
    if (dedupedChatList.length === 0) return [];
    let chats = dedupedChatList;
    if (activeFilter === 'groups') {
      chats = chats.filter((item) => item?.chatType === 'group' || item?.isGroup);
    } else if (activeFilter === 'chats') {
      chats = chats.filter((item) => item?.chatType !== 'group' && !item?.isGroup);
    } else if (activeFilter === 'unread') {
      chats = chats.filter((item) => Number(item?.unreadCount || 0) > 0);
    }
    if (searchQuery.trim() === '') return chats;
    const query = searchQuery.toLowerCase().trim();
    return chats.filter((item) => {
      const isGroupItem = item?.chatType === 'group' || item?.isGroup;
      const isBroadcastItem = item?.chatType === 'broadcast' || item?.isBroadcast;
      const chatDisplayName = (isGroupItem || isBroadcastItem)
        ? (item?.chatName || item?.group?.name || '').toLowerCase()
        : (item?.peerUser?.fullName || '').toLowerCase();
      const lastMessage = getLastMessageText(item).toLowerCase();
      return chatDisplayName.includes(query) || lastMessage.includes(query);
    });
  }, [searchQuery, dedupedChatList, activeFilter]);

  const isSearching = searchQuery.trim() !== '';

  // listOrderSignature + LayoutAnimation removed — causes jank on low-end devices

  useEffect(() => {
    const id = setInterval(() => setTimeTick((prev) => prev + 1), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (effectiveChatList.length > 0) {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 120,
        useNativeDriver: true,
      }).start();
    } else {
      fadeAnim.setValue(1); // No animation if no chats
    }
  }, [fadeAnim, effectiveChatList]);

  // Build the saved-contact name map from the locally-synced registered
  // contacts (ContactDatabase). The current map is already seeded synchronously
  // from `_contactMapCache` (so a tab re-entry shows names instantly with no DB
  // read on the render path); this focus effect only does a NON-BLOCKING
  // background refresh so a contact saved or renamed while away is reflected on
  // return. The warm cache is updated and state is set only when the map content
  // actually changed, avoiding a needless re-derivation of the chat list.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        try {
          const registered = await ContactDatabase.loadRegisteredContacts();
          if (!active) return;
          const map = {};
          for (const c of registered) {
            if (!c?.userId) continue;
            const fullName = String(c.fullName || c.name || '').trim();
            if (!fullName) continue;
            map[String(c.userId)] = { fullName, profileImage: c.profileImage || c.profilePicture || null };
          }
          if (isSameContactMap(_contactMapCache, map)) return;
          _contactMapCache = map;
          setContactMap(map);
        } catch (err) {
          if (active && !_contactMapCache) setContactMap({});
        }
      })();
      return () => { active = false; };
    }, [])
  );

  // Keep the "add to deleted chats" action in sync with the panic-password state:
  // the cached flag paints immediately, the server settings call corrects it (the
  // password can be cleared from another device), and the armed config tells us
  // which chats are already in the list so we never add one twice.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        try {
          const [cached, config] = await Promise.all([
            AsyncStorage.getItem(DELETED_PWD_SET_KEY),
            getDeletedChatConfig(),
          ]);
          if (!active) return;
          setDeletedPwdSet(cached === '1');
          setArmedChatIds(config?.chatIds || []);
          setArmedScope(config?.scope || 'me');
        } catch {}

        try {
          const settings = await getUserSettings();
          if (!active) return;
          const isSet = !!settings?.chat?.hasDeletedPassword;
          setDeletedPwdSet(isSet);
          await markDeletedPasswordSet(isSet);
        } catch {
          /* offline — keep the cached flag */
        }
      })();
      return () => { active = false; };
    }, [])
  );

  // Arm the currently-selected chats for the panic purge. Chats already armed are
  // skipped, so selecting a mix of new + already-added chats only adds the new
  // ones. Nothing is deleted here — the purge runs at the login gate when the
  // deleted-chats password is entered.
  const onBulkAddToDeletedChats = useCallback(async () => {
    if (isArming || selectedChatIds.length === 0) return;

    const already = new Set(armedChatIds.map(String));
    const picked = selectedChatIds.map((id) => String(id)).filter(Boolean);
    const fresh = picked.filter((id) => !already.has(id));

    if (fresh.length === 0) {
      Alert.alert(
        'Already added',
        picked.length === 1
          ? 'This chat is already in your deleted-chats list.'
          : 'These chats are already in your deleted-chats list.'
      );
      return;
    }

    setIsArming(true);
    try {
      const merged = [...armedChatIds.map(String), ...fresh];
      const saved = await saveDeletedChatConfig({ scope: armedScope, chatIds: merged });
      if (!saved) throw new Error('save failed');

      setArmedChatIds(saved.chatIds);
      const skipped = picked.length - fresh.length;
      Alert.alert(
        'Added to deleted chats',
        `${fresh.length} chat${fresh.length === 1 ? '' : 's'} added${skipped > 0 ? ` (${skipped} already there)` : ''}. ` +
        `${saved.chatIds.length} chat${saved.chatIds.length === 1 ? '' : 's'} will be deleted ` +
        `(${saved.scope === 'everyone' ? 'for everyone' : 'for me'}) when the deleted-chats password is entered at login.`
      );
      exitSelectionMode();
    } catch {
      Alert.alert('Could not add', 'Please try again.');
    } finally {
      setIsArming(false);
    }
  }, [isArming, selectedChatIds, armedChatIds, armedScope, exitSelectionMode]);

  // Initial sync: only call API if SQLite has no chatlist data (first login)
  // After first sync, chatlist is driven entirely by SQLite + socket updates
  const initialSyncDone = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (initialSyncDone.current) return;
      initialSyncDone.current = true;
      // Only fetch from API if realtime chatlist is empty (no SQLite data loaded yet)
      if (!realtimeChatList || realtimeChatList.length === 0) {
        cllog('🌐 CHAT LIST: SQLite empty → fetching from REST API (chatListData)');
        dispatch(chatListData(''));
      } else {
        cllog('📂 CHAT LIST rendered from SQLite cache (no API call)', {
          rows: realtimeChatList.length,
          source: 'SQLite via RealtimeChatContext — NOT a REST API call',
        });
      }
    }, [dispatch, realtimeChatList])
  );

  // When a chat appears without a resolved peer (e.g. a brand-new chat created
  // by an incoming message, which arrives over the socket with no name/avatar),
  // refetch the chat list so the row is fully hydrated (name / number / avatar)
  // instead of showing "Unknown". This is gated on MISSING IDENTITY rather than
  // on "first population", so it also fixes the very first chat a user ever
  // receives (the old `size === 0` early-return skipped it).
  // Attempts are tracked PER CHAT with a cap + backoff, instead of the old
  // "once per chatId ever" gate. That gate stranded rows as "Unknown" forever:
  // when the app is opened FROM a notification the very first refetch usually
  // races a network/socket that is still coming up — the fetch fails silently,
  // the id is already marked known, and no retry ever happens.
  const HYDRATION_MAX_ATTEMPTS = 4;
  const hydrationAttemptsRef = useRef({});
  const newChatRefetchTimerRef = useRef(null);
  const [hydrationTick, setHydrationTick] = useState(0);
  useEffect(() => {
    if (!Array.isArray(realtimeChatList) || realtimeChatList.length === 0) return undefined;

    // Collect private rows that still have NO displayable identity — no saved/
    // profile name, no chatName, and no number to fall back on ("Unknown").
    // Groups and broadcast channels are named server-side (chatName) and must
    // NOT trigger peer hydration (they have no peerUser to resolve).
    const namelessIds = [];
    realtimeChatList.forEach((c) => {
      const id = String(c?.chatId || c?._id || '');
      if (!id) return;
      const isGroupItem = c?.chatType === 'group' || c?.isGroup;
      const isBroadcastItem = c?.chatType === 'broadcast' || c?.isBroadcast;
      const isNamedNonPrivate = isGroupItem || isBroadcastItem;
      const hasName = isNamedNonPrivate
        ? Boolean(c?.chatName || c?.group?.name || c?.groupName)
        : Boolean(
            c?.peerUser?.fullName
            || c?.chatName
            || c?.mobileNumber
            || c?.peerUser?.mobileNumber
            || c?.peerUser?.userName
          );
      if (!isNamedNonPrivate && !hasName) namelessIds.push(id);
    });

    if (!namelessIds.length) return undefined;

    // Backoff off the least-attempted nameless row; stop once every nameless
    // row has exhausted its attempts (server genuinely has no identity for it —
    // ChatCard then degrades to number/username, never a permanent blank).
    const attempt = Math.min(
      ...namelessIds.map((id) => hydrationAttemptsRef.current[id] || 0)
    );
    if (attempt >= HYDRATION_MAX_ATTEMPTS) return undefined;

    if (newChatRefetchTimerRef.current) clearTimeout(newChatRefetchTimerRef.current);
    newChatRefetchTimerRef.current = setTimeout(() => {
      newChatRefetchTimerRef.current = null;
      namelessIds.forEach((id) => {
        hydrationAttemptsRef.current[id] = (hydrationAttemptsRef.current[id] || 0) + 1;
      });
      cllog('🌐 CHAT LIST: chats missing identity → REST refetch to hydrate name/avatar', {
        chats: namelessIds.length, attempt: attempt + 1,
      });
      dispatch(chatListData(''));
      // Re-evaluate after the fetch settles even if the list reference didn't
      // change (a failed fetch changes nothing — without this tick the effect
      // would never re-run and the row would stay "Unknown" until pull-refresh).
      setTimeout(() => setHydrationTick((t) => t + 1), 2000);
    }, 400 * Math.pow(2, attempt)); // 400ms, 800ms, 1.6s, 3.2s
  }, [realtimeChatList, hydrationTick, dispatch]);

  useEffect(() => () => {
    if (newChatRefetchTimerRef.current) clearTimeout(newChatRefetchTimerRef.current);
  }, []);

  // Pull-to-refresh: the ONLY time API is called after initial sync
  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      cllog('🌐 CHAT LIST: pull-to-refresh → REST API call (chatListData)');
      await dispatch(chatListData(''));
    } catch (err) {
      console.warn('Failed to refresh chats:', err);
    } finally {
      setRefreshing(false);
    }
  };

  const clearSearch = () => setSearchQuery('');

  const getPreviewText = useCallback((text, maxLength = 20) => {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return `${text.substring(0, maxLength)}... `;
  }, []);

  const getRelativeTime = useCallback((value) => {
    const ts = value ? new Date(value).getTime() : 0;
    if (!ts) return '';
    const msgDate = new Date(ts);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = todayStart - 86400000;
    const weekAgoStart = todayStart - 6 * 86400000;
    const formatTime = (d) => {
      let h = d.getHours();
      const m = String(d.getMinutes()).padStart(2, '0');
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return `${h}:${m} ${ampm}`;
    };
    if (ts >= todayStart) return formatTime(msgDate);
    if (ts >= yesterdayStart) return 'Yesterday';
    if (ts >= weekAgoStart) return msgDate.toLocaleDateString(undefined, { weekday: 'long' });
    return `${String(msgDate.getDate()).padStart(2, '0')}/${String(msgDate.getMonth() + 1).padStart(2, '0')}/${String(msgDate.getFullYear()).slice(-2)}`;
  }, []);

  const renderMessageStatus = useCallback((item) => {
    // Hide ticks on chat summary when the last message is incoming (receiver side).
    const senderId = item?.lastMessage?.senderId
      || item?.lastMessageSender
      || item?.lastMessageSenderId
      || item?.lastMessage?.createdBy
      || item?.lastSenderId;
    const isMine = currentUserId && senderId && String(senderId) === currentUserId;
    if (!isMine) return null;
    const status = String(item?.lastMessageStatus || item?.lastMessage?.status || item?.status || '').toLowerCase();
    if (!status) return null;
    const grayColor = theme.colors.placeHolderTextColor;
    if (status === 'read' || status === 'seen') {
      return <Ionicons name="checkmark-done" size={14} color="#53BDEB" style={{ marginRight: 4 }} />;
    }
    if (status === 'delivered') {
      return <Ionicons name="checkmark-done" size={14} color={grayColor} style={{ marginRight: 4 }} />;
    }
    if (status === 'sent' || status === 'sending' || status === 'pending' || status === 'uploaded') {
      return <Ionicons name="checkmark" size={14} color={grayColor} style={{ marginRight: 4 }} />;
    }
    if (status === 'failed') {
      return <Ionicons name="alert-circle" size={14} color="#FF8A80" style={{ marginRight: 4 }} />;
    }
    return null;
  }, [theme, currentUserId]);

  const getUserColor = useCallback((str) => {
    const colors = ['#833AB4', '#1DB954', '#02958a', '#026158', '#777737', '#F56040', '#34B7F1', '#03b0a2'];
    if (!str) return colors[0];
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  }, []);

  // ─── ACTION SHEET (animated) ───

  const openActionMenu = useCallback((item) => {
    setSelectedChatItem(item);
    setActionSheetVisible(true);
    sheetSlideAnim.setValue(300);
    sheetBgAnim.setValue(0);
    Animated.parallel([
      Animated.timing(sheetSlideAnim, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }),
      Animated.timing(sheetBgAnim, {
        toValue: 1,
        duration: 150,
        useNativeDriver: true,
      }),
    ]).start();
  }, [sheetSlideAnim, sheetBgAnim]);

  const closeActionMenu = useCallback(() => {
    Animated.parallel([
      Animated.timing(sheetSlideAnim, {
        toValue: 300,
        duration: 120,
        useNativeDriver: true,
      }),
      Animated.timing(sheetBgAnim, {
        toValue: 0,
        duration: 120,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setActionSheetVisible(false);
      setMuteSheetVisible(false);
      setSelectedChatItem(null);
    });
  }, [sheetSlideAnim, sheetBgAnim]);

  // ─── PROFILE PREVIEW ───

  // The preview card (ProfilePreviewModal) owns its own enter/exit animation,
  // so these just toggle visibility + remember which row was tapped.
  const openProfilePreview = useCallback((item) => {
    setSelectedChatItem(item);
    setProfilePreviewVisible(true);
  }, []);

  // WhatsApp behaviour: tapping a contact's avatar that has a live status opens
  // the Status Viewer (oldest → newest); viewing marks each status seen, which
  // clears the ring automatically (Redux viewedStatusIds → statusByUserId).
  const openContactStatusViewer = useCallback((group) => {
    if (!group) return;
    const serverName = group.name || group.fullName || group.userName;
    const phone = group.phone || group.number || group.mobile?.number || group.mobileNumber;
    const label = resolveName(group.userId, serverName, phone);
    navigation.navigate('StatusViewer', {
      statuses: group.statuses || [],
      startIndex: 0,
      isMine: false,
      userName: label,
      userImage: group.avatar || group.profileImage || group.userAvatar,
      userId: group.userId,
    });
  }, [navigation, resolveName]);

  const closeProfilePreview = useCallback(() => {
    setProfilePreviewVisible(false);
    // Don't clear selectedChatItem here — image viewer may need it
  }, []);

  // Stable renderItem → memoized ChatListRow. Per-row derived values (isSelected,
  // statusInfo) are computed here from primitives; everything passed to the row is
  // either a stable ref or a stable callback, so memo(ChatListRow) holds and only
  // changed rows re-render. Defined AFTER all its dependencies so the deps array
  // never references a const in the temporal dead zone.
  const renderChatRow = useCallback(({ item }) => {
    const itemChatId = item?.chatId || item?._id;
    const isSelected = selectionMode && selectedChatIds.includes(itemChatId);
    const isGroupRow = item?.chatType === 'group' || item?.isGroup;
    const peerId = !isGroupRow ? String(item?.peerUser?._id || item?.peerUserId || '') : '';
    const statusInfo = peerId ? (statusByUserId[peerId] || null) : null;
    return (
      <ChatListRow
        item={item}
        theme={theme}
        isSelected={isSelected}
        statusInfo={statusInfo}
        selectionMode={selectionMode}
        timeTick={timeTick}
        onOpen={openChat}
        onToggleSelect={toggleChatSelection}
        onEnterSelection={enterSelectionMode}
        onOpenStatusViewer={openContactStatusViewer}
        onOpenProfile={openProfilePreview}
        getUserColor={getUserColor}
        getPreviewText={getPreviewText}
        getRelativeTime={getRelativeTime}
        getLastMessageText={getLastMessageText}
        renderMessageStatus={renderMessageStatus}
      />
    );
  }, [
    selectionMode, selectedChatIds, statusByUserId, theme, timeTick,
    openChat, toggleChatSelection, enterSelectionMode, openContactStatusViewer, openProfilePreview,
    getUserColor, getPreviewText, getRelativeTime, getLastMessageText, renderMessageStatus,
  ]);

  // Start an audio/video call from the preview popup — 1-1 contact, or a GROUP
  // (rings every other member, WhatsApp parity). Chat-list rows don't carry the
  // group roster, so the group path fetches it via group/view before dialing;
  // the call engine trims the list to its participant cap.
  const startPreviewCall = useCallback((media) => {
    const item = selectedChatItem;
    if (!item) return;
    const isGroup = item?.chatType === 'group' || item?.isGroup;
    if (isGroup) {
      const groupId = item?.groupId || item?.group?._id || item?.chatId || item?._id;
      const groupName = item?.chatName || item?.group?.name || item?.groupName || 'Group';
      if (!groupId) return;
      closeProfilePreview();
      setTimeout(async () => {
        try {
          const res = await viewGroupApi({ groupId });
          const members = res?.data?.members || [];
          const seen = new Set();
          const peers = [];
          members.forEach((m) => {
            if (!m || m.status === 'removed' || m.isDeleted) return;
            const u = (typeof m.userId === 'object' && m.userId !== null) ? m.userId : {};
            const id = u._id || (typeof m.userId === 'string' ? m.userId : null) || m._id || m.id;
            if (!id) return;
            const sid = String(id);
            if (sid === String(currentUserId) || seen.has(sid)) return;
            seen.add(sid);
            peers.push({
              id: sid,
              name: u.fullName || m.fullName || m.name || 'Member',
              avatar: u.profileImage || m.profileImage || null,
            });
          });
          if (!peers.length) return;
          if (media === 'video') startGroupVideoCall?.(peers, { groupId, groupName });
          else startGroupAudioCall?.(peers, { groupId, groupName });
        } catch (e) {
          // group/view already surfaces its own failure toast
        }
      }, 220);
      return;
    }
    const peer = item?.peerUser;
    const peerId = peer?._id || item?.peerUserId;
    if (!peerId) return;
    const peerObj = {
      id: String(peerId),
      name: peer?.fullName || 'Unknown User',
      avatar: peer?.profileImage || null,
    };
    closeProfilePreview();
    // Let the modal dismiss before the call engine takes over the screen.
    setTimeout(() => {
      if (media === 'video') startVideoCall?.(peerObj);
      else startAudioCall?.(peerObj);
    }, 220);
  }, [
    selectedChatItem, closeProfilePreview, startVideoCall, startAudioCall,
    startGroupVideoCall, startGroupAudioCall, currentUserId,
  ]);

  const openPreviewInfo = useCallback(() => {
    const isGroup = selectedChatItem?.chatType === 'group' || selectedChatItem?.isGroup;
    const isBroadcast = selectedChatItem?.chatType === 'broadcast' || selectedChatItem?.isBroadcast;
    if (selectedChatItem) {
      if (isBroadcast) {
        navigation.navigate('ChannelInfo', {
          channelId: selectedChatItem?.broadcastChannelId || selectedChatItem?.chatId || selectedChatItem?._id,
          item: selectedChatItem,
        });
      } else if (isGroup) {
        navigation.navigate('GroupInfo', {
          groupId: selectedChatItem?.groupId || selectedChatItem?.group?._id || selectedChatItem?.chatId,
          item: selectedChatItem,
        });
      } else {
        navigation.navigate('UserB', { item: selectedChatItem });
      }
    }
    closeProfilePreview();
  }, [selectedChatItem, navigation, closeProfilePreview]);

  // ─── CHAT ACTIONS ───

  const onTogglePin = useCallback(() => {
    const chatId = selectedChatItem?.chatId || selectedChatItem?._id;
    if (!chatId) return;
    const ct = selectedChatItem?.chatType || 'private';

    if (selectedChatItem?.isPinned) unpinChat(chatId, ct);
    else pinChat(chatId, ct);
    closeActionMenu();
  }, [selectedChatItem, pinChat, unpinChat, closeActionMenu]);

  const onPressMute = useCallback(() => {
    const chatId = selectedChatItem?.chatId || selectedChatItem?._id;
    if (!chatId) return;
    const ct = selectedChatItem?.chatType || 'private';
    if (selectedChatItem?.isMuted) {
      unmuteChat(chatId, ct);
      closeActionMenu();
      return;
    }
    setMuteSheetVisible(true);
  }, [selectedChatItem, unmuteChat, closeActionMenu]);

  const onSelectMuteDuration = useCallback((duration) => {
    // Multi-select: mute every selected chat for the chosen duration.
    if (selectionMode && selectedChatIds.length) {
      getSelectedChats().forEach(c => {
        if (!c?.isMuted) muteChat(c?.chatId || c?._id, duration, c?.chatType || 'private');
      });
      setMuteSheetVisible(false);
      exitSelectionMode();
      return;
    }
    const chatId = selectedChatItem?.chatId || selectedChatItem?._id;
    if (!chatId) return;
    const ct = selectedChatItem?.chatType || 'private';
    muteChat(chatId, duration, ct);
    closeActionMenu();
  }, [selectionMode, selectedChatIds, getSelectedChats, selectedChatItem, muteChat, closeActionMenu, exitSelectionMode]);

  const onToggleArchive = useCallback(() => {
    const chatId = selectedChatItem?.chatId || selectedChatItem?._id;
    if (!chatId) return;
    const ct = selectedChatItem?.chatType || 'private';

    if (selectedChatItem?.isArchived) unarchiveChat(chatId, ct);
    else archiveChat(chatId, ct);
    closeActionMenu();
  }, [selectedChatItem, archiveChat, unarchiveChat, closeActionMenu]);

  // ─── BULK ACTIONS (multi-select selection mode) ───
  const getSelectedChats = useCallback(
    () => (dedupedChatList || []).filter(c => selectedChatIds.includes(c?.chatId || c?._id)),
    [dedupedChatList, selectedChatIds]
  );

  const onBulkTogglePin = useCallback(() => {
    const chats = getSelectedChats();
    if (!chats.length) return;
    const allPinned = chats.every(c => c?.isPinned);
    chats.forEach(c => {
      const id = c?.chatId || c?._id;
      const ct = c?.chatType || 'private';
      if (allPinned) unpinChat(id, ct);
      else if (!c?.isPinned) pinChat(id, ct);
    });
    exitSelectionMode();
  }, [getSelectedChats, pinChat, unpinChat, exitSelectionMode]);

  const onBulkToggleArchive = useCallback(() => {
    const chats = getSelectedChats();
    if (!chats.length) return;
    const allArchived = chats.every(c => c?.isArchived);
    chats.forEach(c => {
      const id = c?.chatId || c?._id;
      const ct = c?.chatType || 'private';
      if (allArchived) unarchiveChat(id, ct);
      else if (!c?.isArchived) archiveChat(id, ct);
    });
    exitSelectionMode();
  }, [getSelectedChats, archiveChat, unarchiveChat, exitSelectionMode]);

  const onBulkMute = useCallback(() => {
    const chats = getSelectedChats();
    if (!chats.length) return;
    const allMuted = chats.every(c => c?.isMuted);
    // Direct toggle — no duration picker. Mute uses "Always" (duration 0).
    chats.forEach(c => {
      const id = c?.chatId || c?._id;
      const ct = c?.chatType || 'private';
      if (allMuted) unmuteChat(id, ct);
      else if (!c?.isMuted) muteChat(id, 0, ct);
    });
    exitSelectionMode();
  }, [getSelectedChats, muteChat, unmuteChat, exitSelectionMode]);

  const onViewInfo = useCallback(() => {
    const chatId = selectedChatItem?.chatId || selectedChatItem?._id;
    if (!chatId) return;
    requestChatInfo(chatId);
    const isGroup = selectedChatItem?.chatType === 'group' || selectedChatItem?.isGroup;
    if (isGroup) {
      navigation.navigate('GroupInfo', {
        groupId: selectedChatItem?.groupId || selectedChatItem?.group?._id || chatId,
        item: selectedChatItem,
      });
    } else {
      navigation.navigate('UserB', { item: selectedChatItem });
    }
    closeActionMenu();
  }, [selectedChatItem, requestChatInfo, navigation, closeActionMenu]);

  const onDeleteChat = useCallback(() => {
    setDeleteForEveryone(false);
    setDeleteModalVisible(true);
    setActionSheetVisible(false);
    setMuteSheetVisible(false);
  }, []);

  const closeDeleteModal = useCallback(() => {
    if (isDeletingChat) return;
    setDeleteModalVisible(false);
    setDeleteForEveryone(false);
  }, [isDeletingChat]);

  const onConfirmDeleteChat = useCallback(async () => {
    const chatId = normalizeChatStorageId(selectedChatItem?.chatId || selectedChatItem?._id);
    if (!chatId || isDeletingChat) return;
    setIsDeletingChat(true);
    try {
      const rawUser = await AsyncStorage.getItem('userInfo');
      const user = rawUser ? JSON.parse(rawUser) : null;
      const userId = normalizeChatStorageId(user?._id || user?.id);
      if (!userId) throw new Error('User id not available');
      const scope = deleteForEveryone ? 'everyone' : 'me';
      const endpoint = deleteForEveryone ? 'user/chat/clear/everyone' : 'user/chat/clear/me';
      const response = await apiCall('POST', endpoint, { chatId, userId });
      const hasFailure = response && (response.success === false || response.status === false || response.ok === false || response.error);
      if (hasFailure) throw new Error(response?.message || 'Delete API returned failure');
      const clearType = String(response?.clearType || response?.data?.clearType || '').toLowerCase();
      if (clearType) {
        const expectedClearType = deleteForEveryone ? 'everyone' : 'me';
        if (clearType !== expectedClearType) throw new Error(`Unexpected clearType: ${clearType}`);
      }
      await removeMessagesByChatId(chatId);
      applyChatClearedPreview(chatId, scope);
      // Delete all SQLite messages for this chat AND stamp chat_meta.cleared_at
      // so any post-delete message from the peer never resurfaces old history.
      try { await ChatDatabase.clearChat(chatId, Date.now()); } catch (e) { console.warn('clearChat failed', e); }
      // Remove the chat row from the list on the user's own side.
      try { await ChatDatabase.deleteChatRow(chatId); } catch (e) { console.warn('deleteChatRow failed', e); }
      // Wipe the in-memory ChatCache — without this, openChat() finds cached
      // messages via ChatCache.hasMessages() and re-shows the deleted history.
      try { ChatCache.clearMessages(chatId); } catch (e) {}
      try { ChatCache.removeChat(chatId); } catch (e) {}
      // Reset hydration attempts so a future incoming message from User B is
      // treated as a brand-new chat and re-triggers the identity refetch
      // (otherwise the row re-appears as a bare stub with no name / avatar).
      delete hydrationAttemptsRef.current[String(chatId)];
      removeChat?.(chatId);
      setDeleteModalVisible(false);
      setDeleteForEveryone(false);
      setSelectedChatItem(null);
    } catch (error) {
      console.error('Chat delete failed', error);
      Alert.alert('Delete Chat', 'Could not delete this chat right now. Please try again.');
    } finally {
      setIsDeletingChat(false);
    }
  }, [selectedChatItem, isDeletingChat, deleteForEveryone, applyChatClearedPreview, removeChat]);

  const onConfirmBulkDelete = useCallback(async () => {
    if (isBulkDeleting) return;
    const normalizedIds = selectedChatIds
      .map((id) => normalizeChatStorageId(id))
      .filter(Boolean);
    if (normalizedIds.length === 0) {
      setBulkDeleteModalVisible(false);
      exitSelectionMode();
      return;
    }

    setIsBulkDeleting(true);
    setBulkDeleteModalVisible(false);
    setBulkDeleteProgress({ visible: true, label: `Deleting ${normalizedIds.length} chat${normalizedIds.length === 1 ? '' : 's'}...` });

    let serverDeletedIds = [];
    let serverFailed = [];
    try {
      // 1. Server delete (Kafka publish happens server-side as part of this call).
      //    The response tells us EXACTLY which chats were deleted server-side.
      const response = await apiCall('POST', 'user/chat/delete/bulk', { chatIds: normalizedIds });
      const hasFailure = response && (response.success === false || response.status === false || response.ok === false || response.error);
      if (hasFailure) throw new Error(response?.message || 'Bulk delete failed');

      const data = response?.data || {};
      serverDeletedIds = Array.isArray(data.deletedChatIds) ? data.deletedChatIds.map(String) : normalizedIds.map(String);
      serverFailed = Array.isArray(data.failed) ? data.failed : [];

      // 2. Local cleanup — ONLY for chats the server actually deleted.
      //    Each step is sequential and per-chat errors are tracked so we can
      //    report them instead of silently dropping work.
      const clearedAt = Date.now();
      const localErrors = [];
      let processed = 0;
      for (const chatId of serverDeletedIds) {
        processed += 1;
        setBulkDeleteProgress({
          visible: true,
          label: `Cleaning up ${processed} of ${serverDeletedIds.length}...`
        });

        try {
          await removeMessagesByChatId(chatId);
        } catch (e) { localErrors.push({ chatId, step: 'asyncStorage', error: e?.message }); }

        try {
          applyChatClearedPreview(chatId, 'me');
        } catch (e) { localErrors.push({ chatId, step: 'previewReset', error: e?.message }); }

        // SQLite messages delete + tombstone — this is what guarantees that
        // re-deleting after a peer message works the same as the first delete.
        try {
          await ChatDatabase.clearChat(chatId, clearedAt);
        } catch (e) { localErrors.push({ chatId, step: 'sqliteClearChat', error: e?.message }); }

        try {
          await ChatDatabase.deleteChatRow(chatId);
        } catch (e) { localErrors.push({ chatId, step: 'sqliteDeleteRow', error: e?.message }); }

        // Wipe in-memory ChatCache so openChat() can't surface deleted messages
        // from the cache after the chat is re-created by a new peer message.
        try { ChatCache.clearMessages(chatId); } catch (e) { localErrors.push({ chatId, step: 'cacheClearMessages', error: e?.message }); }
        try { ChatCache.removeChat(chatId); } catch (e) { localErrors.push({ chatId, step: 'cacheRemoveChat', error: e?.message }); }

        try { delete hydrationAttemptsRef.current[String(chatId)]; } catch (e) {}
        try { removeChat?.(chatId); } catch (e) {}
      }

      if (localErrors.length > 0) {
        console.warn('[bulkDelete] partial local cleanup errors', localErrors);
      }

      exitSelectionMode();

      // 3. Surface partial server failures explicitly
      if (serverFailed.length > 0) {
        const failedNames = serverFailed.map((f) => f?.chatId).filter(Boolean).join(', ');
        Alert.alert(
          'Some chats not deleted',
          `Deleted ${serverDeletedIds.length} chat(s). ${serverFailed.length} could not be deleted${failedNames ? ` (${failedNames})` : ''}. Please try again.`
        );
      }
    } catch (error) {
      console.error('Bulk chat delete failed', error);
      Alert.alert('Delete Chats', error?.message || 'Could not delete the selected chats. Please try again.');
    } finally {
      setBulkDeleteProgress({ visible: false, label: '' });
      setIsBulkDeleting(false);
    }
  }, [selectedChatIds, isBulkDeleting, applyChatClearedPreview, removeChat, exitSelectionMode]);

  useEffect(() => {
    if (Array.isArray(chatsData)) {
      hydrateChats(chatsData);
    }
  }, [chatsData, hydrateChats]);

  // ─── ACTION SHEET OPTIONS ───

  const actionSheetOptions = useMemo(() => {
    if (!selectedChatItem) return [];
    const opts = [];

    if (selectedChatItem?.isArchived) {
      opts.push({
        icon: 'archive-arrow-up-outline',
        label: 'Unarchive Chat',
        iconColor: '#00B894',
        onPress: onToggleArchive,
      });
    }

    opts.push({
      icon: selectedChatItem?.isPinned ? 'pin-off-outline' : 'pin-outline',
      label: selectedChatItem?.isPinned ? 'Unpin Chat' : 'Pin Chat',
      iconColor: '#4D7CFE',
      onPress: onTogglePin,
    });

    opts.push({
      icon: selectedChatItem?.isMuted ? 'volume-high' : 'volume-off',
      label: selectedChatItem?.isMuted ? 'Unmute Chat' : 'Mute Chat',
      iconColor: '#F0A030',
      onPress: onPressMute,
    });

    if (!selectedChatItem?.isArchived) {
      opts.push({
        icon: 'archive-arrow-down-outline',
        label: 'Archive Chat',
        iconColor: '#556070',
        onPress: onToggleArchive,
      });
    }

    opts.push({
      icon: 'information-outline',
      label: 'View Chat Info',
      iconColor: '#0984E3',
      onPress: onViewInfo,
    });

    opts.push({
      icon: 'delete-outline',
      label: 'Delete Chat',
      iconColor: '#E06A6A',
      onPress: onDeleteChat,
      isDanger: true,
    });

    return opts;
  }, [selectedChatItem, onTogglePin, onPressMute, onToggleArchive, onViewInfo, onDeleteChat]);

  // ─── PREVIEW DATA ───

  const isPreviewGroup = Boolean(selectedChatItem?.chatType === 'group' || selectedChatItem?.isGroup);
  const isPreviewBroadcast = Boolean(selectedChatItem?.chatType === 'broadcast' || selectedChatItem?.isBroadcast);
  const previewName = isPreviewBroadcast
    ? (selectedChatItem?.chatName || 'Channel')
    : isPreviewGroup
      ? (selectedChatItem?.chatName || selectedChatItem?.group?.name || selectedChatItem?.groupName || 'Group')
      : (selectedChatItem?.peerUser?.fullName || 'Unknown User');
  const previewImage = (isPreviewGroup || isPreviewBroadcast)
    ? (selectedChatItem?.chatAvatar || selectedChatItem?.group?.avatar || selectedChatItem?.groupAvatar)
    : selectedChatItem?.peerUser?.profileImage;
  const previewAvatarColor = getAvatarColor(previewName);
  // WhatsApp's profile-popup action icons are a bright green (dark mode) /
  // teal-green (light mode) — distinct from the app's own brand teal.
  const previewActionGreen = isDarkMode ? '#03b0a2' : '#028578';

  // ─── RENDER ───

  const renderEmptyComponent = () => {
    if (isSearching) {
      return (
        <View style={styles.emptyWrap}>
          <View style={[styles.emptyIconCircle, { backgroundColor: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]}>
            <Ionicons name="search-outline" size={36} color={theme.colors.placeHolderTextColor} />
          </View>
          <Text style={[styles.emptyTitle, { color: theme.colors.primaryTextColor }]}>
            No results found
          </Text>
          <Text style={[styles.emptySubtitle, { color: theme.colors.placeHolderTextColor }]}>
            No chats matching "{searchQuery}"
          </Text>
        </View>
      );
    }

    return (
      <View style={styles.emptyWrap}>
        <View style={[styles.emptyIconCircle, { backgroundColor: theme.colors.themeColor + '10' }]}>
          <Ionicons name="chatbubbles-outline" size={36} color={theme.colors.themeColor} />
        </View>
        <Text style={[styles.emptyTitle, { color: theme.colors.primaryTextColor }]}>
          No conversations yet
        </Text>
        <Text style={[styles.emptySubtitle, { color: theme.colors.placeHolderTextColor }]}>
          Start a new chat by tapping the button below
        </Text>
      </View>
    );
  };

  const renderArchivedRow = () => {
    if (effectiveArchivedChatList.length === 0) return null;

    return (
      <TouchableOpacity
        onPress={() => navigation.navigate('ArchivedChats')}
        activeOpacity={0.6}
        style={styles.archiveRow}
      >
        <View style={[styles.archiveIconWrap, { backgroundColor: theme.colors.themeColor + '12' }]}>
          <MaterialCommunityIcons name="archive-outline" size={18} color={theme.colors.themeColor} />
        </View>
        <Text style={[styles.archiveLabel, { color: theme.colors.primaryTextColor }]}>
          Archived
        </Text>
        <Text style={[styles.archiveCount, { color: theme.colors.placeHolderTextColor }]}>
          {effectiveArchivedChatList.length}
        </Text>
        <Ionicons name="chevron-forward" size={16} color={theme.colors.placeHolderTextColor} />
      </TouchableOpacity>
    );
  };

  // Pinned (non-scrolling) section: ONLY the search bar.
  const pinnedSearchAndFilters = (
    <View style={[styles.pinnedHeaderWrap, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.searchBar, { backgroundColor: isDarkMode ? '#1F2C3380' : '#f0f2f5' }]}>
        <Ionicons name="search" size={18} color={theme.colors.iconColor} />
        <TextInput
          placeholder="Search"
          placeholderTextColor={theme.colors.placeHolderTextColor}
          value={searchQuery}
          onChangeText={setSearchQuery}
          style={[styles.searchInput, { color: theme.colors.primaryTextColor }]}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={clearSearch} activeOpacity={0.6} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <View style={[styles.searchClearCircle, { backgroundColor: theme.colors.placeHolderTextColor + '28' }]}>
              <Ionicons name="close" size={12} color={theme.colors.placeHolderTextColor} />
            </View>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );

  // Filter pills + archived row scroll with the list.
  const listHeader = (
    <View style={styles.listHeaderWrap}>
      <View style={styles.filterRow}>
        {[
          { key: 'all', label: 'All' },
          { key: 'unread', label: 'Unread' },
          { key: 'chats', label: 'Chats' },
          { key: 'groups', label: 'Groups' },
        ].map((f) => {
          const isActive = activeFilter === f.key;
          return (
            <TouchableOpacity
              key={f.key}
              onPress={() => setActiveFilter(f.key)}
              activeOpacity={0.7}
              style={[
                styles.filterPill,
                isActive
                  ? { backgroundColor: isDarkMode ? theme.colors.themeColor + '33' : theme.colors.themeColor + '1F', borderColor: 'transparent' }
                  : { backgroundColor: 'transparent', borderColor: isDarkMode ? 'rgba(255,255,255,0.16)' : '#d1d7db' },
              ]}
            >
              <Text
                style={[
                  styles.filterPillText,
                  { color: isActive ? theme.colors.themeColor : theme.colors.iconColor },
                ]}
              >
                {f.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {renderArchivedRow()}
    </View>
  );

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: theme.colors.background }]}>

      {/* ─── SELECTION HEADER (multi-select mode) ─── */}
      {selectionMode ? (
        <View style={[styles.header, { backgroundColor: theme.colors.themeColor + '14' }]}>
          <View style={styles.headerLeft}>
            <TouchableOpacity
              onPress={exitSelectionMode}
              activeOpacity={0.6}
              style={[styles.headerBtn, { backgroundColor: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]}
            >
              <Ionicons name="arrow-back" size={22} color={theme.colors.primaryTextColor} />
            </TouchableOpacity>
            <Text style={[styles.headerTitle, { color: theme.colors.primaryTextColor, fontSize: 18 }]}>
              {selectedChatIds.length}
            </Text>
          </View>
          {(() => {
            const sel = getSelectedChats();
            const allPinned = sel.length > 0 && sel.every(c => c?.isPinned);
            const allMuted = sel.length > 0 && sel.every(c => c?.isMuted);
            const allArchived = sel.length > 0 && sel.every(c => c?.isArchived);
            const btnBg = isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
            const iconColor = theme.colors.primaryTextColor;
            // Every selected chat is already armed → nothing left to add.
            const armedSet = new Set(armedChatIds.map(String));
            const allArmed = selectedChatIds.length > 0
              && selectedChatIds.every((id) => armedSet.has(String(id)));
            return (
              <View style={styles.headerRight}>
                {/* Add to deleted chats — only when a deleted-chats password exists */}
                {deletedPwdSet && (
                  <TouchableOpacity
                    onPress={onBulkAddToDeletedChats}
                    disabled={isArming || allArmed}
                    activeOpacity={0.6}
                    style={[styles.headerBtn, { backgroundColor: btnBg, opacity: (isArming || allArmed) ? 0.45 : 1 }]}
                  >
                    <MaterialCommunityIcons
                      name={allArmed ? 'delete-clock' : 'delete-clock-outline'}
                      size={20}
                      color={allArmed ? theme.colors.themeColor : iconColor}
                    />
                  </TouchableOpacity>
                )}
                {/* Pin */}
                <TouchableOpacity
                  onPress={onBulkTogglePin}
                  activeOpacity={0.6}
                  style={[styles.headerBtn, { backgroundColor: btnBg }]}
                >
                  <MaterialCommunityIcons name={allPinned ? 'pin-off-outline' : 'pin-outline'} size={20} color={iconColor} />
                </TouchableOpacity>
                {/* Mute */}
                <TouchableOpacity
                  onPress={onBulkMute}
                  activeOpacity={0.6}
                  style={[styles.headerBtn, { backgroundColor: btnBg }]}
                >
                  <Ionicons name={allMuted ? 'notifications-outline' : 'notifications-off-outline'} size={20} color={iconColor} />
                </TouchableOpacity>
                {/* Archive */}
                <TouchableOpacity
                  onPress={onBulkToggleArchive}
                  activeOpacity={0.6}
                  style={[styles.headerBtn, { backgroundColor: btnBg }]}
                >
                  <MaterialCommunityIcons name={allArchived ? 'archive-arrow-up-outline' : 'archive-arrow-down-outline'} size={20} color={iconColor} />
                </TouchableOpacity>
                {/* Delete */}
                <TouchableOpacity
                  onPress={() => {
                    if (selectedChatIds.length === 0) return;
                    setBulkDeleteModalVisible(true);
                  }}
                  activeOpacity={0.6}
                  style={[styles.headerBtn, { backgroundColor: '#E06A6A22' }]}
                >
                  <MaterialCommunityIcons name="delete-outline" size={20} color="#E06A6A" />
                </TouchableOpacity>
              </View>
            );
          })()}
        </View>
      ) : (
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.headerLogoWrap}>
            <Image source={require('../../../assets/icon0.png')} resizeMethod='cover' style={styles.headerLogoImg} />
          </View>
          {/* {Number(realtimeState?.totalUnread || 0) > 0 && (
            <View style={[styles.unreadBadge, { backgroundColor: theme.colors.themeColor }]}>
              <Text style={styles.unreadBadgeText}>
                {Number(realtimeState.totalUnread) > 99 ? '99+' : Number(realtimeState.totalUnread)}
              </Text>
            </View>
          )} */}
        </View>

        <View style={styles.headerRight}>
          <Menu
            visible={visible}
            onDismiss={() => setVisible(false)}
            contentStyle={[styles.menuContent, { backgroundColor: theme.colors.cardBackground }]}
            anchor={(
              <TouchableOpacity
                onPress={() => setVisible(true)}
                activeOpacity={0.6}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                style={styles.headerBtn}
              >
                <Ionicons name="ellipsis-vertical" size={22} color={theme.colors.iconColor} />
              </TouchableOpacity>
            )}
          >
            <Menu.Item
              onPress={() => { navigation.navigate('ProfileTab'); setVisible(false); }}
              title="Profile"
              titleStyle={[styles.menuItemText, { color: theme.colors.primaryTextColor }]}
              leadingIcon={() => <Ionicons name="person-outline" size={18} color={theme.colors.placeHolderTextColor} />}
            />
            <Menu.Item
              onPress={() => { navigation.navigate('SettingsTab'); setVisible(false); }}
              title="Settings"
              titleStyle={[styles.menuItemText, { color: theme.colors.primaryTextColor }]}
              leadingIcon={() => <Ionicons name="settings-outline" size={18} color={theme.colors.placeHolderTextColor} />}
            />
            <Menu.Item
              onPress={() => { navigation.navigate('LinkDevice'); setVisible(false); }}
              title="Linked Devices"
              titleStyle={[styles.menuItemText, { color: theme.colors.primaryTextColor }]}
              leadingIcon={() => <Ionicons name="qr-code-outline" size={18} color={theme.colors.placeHolderTextColor} />}
            />
          </Menu>
        </View>
      </View>
      )}

      {/* ─── PINNED: Search bar + filter pills (do NOT scroll with the list) ─── */}
      {pinnedSearchAndFilters}

      {/* ─── CHAT LIST ─── */}
      <View style={styles.listWrap}>
        {isLoading && effectiveChatList.length === 0 ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="large" color={theme.colors.themeColor} />
            <Text style={[styles.loadingText, { color: theme.colors.placeHolderTextColor }]}>
              Loading chats...
            </Text>
          </View>
        ) : (
          <FlatList
            data={filteredChats}
            keyExtractor={(item) => String(item?.chatId || item?._id)}
            renderItem={renderChatRow}
            showsVerticalScrollIndicator={false}
            extraData={statusByUserId}
            refreshing={refreshing}
            onRefresh={handleRefresh}
            ListHeaderComponent={listHeader}
            ListEmptyComponent={renderEmptyComponent}
            style={{ width: '100%' }}
            contentContainerStyle={styles.listContent}
            removeClippedSubviews={Platform.OS === 'android'}
            windowSize={7}
            initialNumToRender={10}
            maxToRenderPerBatch={8}
            updateCellsBatchingPeriod={50}
            getItemLayout={(_, index) => ({ length: 76, offset: 76 * index, index })}
          />
        )}
      </View>

      {/* ─── FAB ─── */}
      <TouchableOpacity
        onPress={() => navigation.navigate('ContactsTab')}
        activeOpacity={0.85}
        style={[styles.fab, { backgroundColor: theme.colors.themeColor }]}
      >
        <Ionicons name="chatbubble-ellipses" size={24} color="#fff" />
      </TouchableOpacity>

      {/* ─── ACTION SHEET MODAL ─── */}
      <Modal animationType="none" transparent visible={actionSheetVisible} onRequestClose={closeActionMenu}>
        <View style={styles.sheetContainer}>
          <Animated.View style={[styles.sheetBg, { opacity: sheetBgAnim }]}>
            <TouchableOpacity activeOpacity={1} onPress={closeActionMenu} style={StyleSheet.absoluteFill} />
          </Animated.View>

          <Animated.View style={[styles.sheetCard, { backgroundColor: theme.colors.cardBackground, transform: [{ translateY: sheetSlideAnim }] }]}>
            <View style={styles.sheetHandle}>
              <View style={[styles.sheetHandleBar, { backgroundColor: isDarkMode ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)' }]} />
            </View>

            {/* Selected chat info — works for both 1-on-1 and group chats */}
            {selectedChatItem && (
              <View style={styles.sheetUserRow}>
                {previewImage ? (
                  <Image source={{ uri: previewImage }} style={styles.sheetUserAvatar} />
                ) : (
                  <View style={[styles.sheetUserAvatar, { backgroundColor: previewAvatarColor || getUserColor(previewName) }]}>
                    {isPreviewGroup ? (
                      <Ionicons name="people" size={20} color="#fff" />
                    ) : (
                      <Text style={styles.sheetUserInitial}>
                        {(previewName || '?').charAt(0).toUpperCase()}
                      </Text>
                    )}
                  </View>
                )}
                <Text style={[styles.sheetUserName, { color: theme.colors.primaryTextColor }]} numberOfLines={1}>
                  {previewName}
                </Text>
              </View>
            )}

            <View style={[styles.sheetDivider, { backgroundColor: isDarkMode ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)' }]} />

            {actionSheetOptions.map((opt, i) => (
              <TouchableOpacity
                key={i}
                onPress={opt.onPress}
                activeOpacity={0.6}
                style={styles.sheetOption}
              >
                <View style={[styles.sheetOptionIcon, { backgroundColor: opt.iconColor + '12' }]}>
                  <MaterialCommunityIcons name={opt.icon} size={20} color={opt.iconColor} />
                </View>
                <Text style={[styles.sheetOptionLabel, { color: opt.isDanger ? '#E06A6A' : theme.colors.primaryTextColor }]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </Animated.View>
        </View>
      </Modal>

      {/* ─── MUTE SHEET MODAL ─── */}
      <Modal animationType="fade" transparent visible={muteSheetVisible} onRequestClose={() => setMuteSheetVisible(false)}>
        <TouchableOpacity activeOpacity={1} onPress={() => setMuteSheetVisible(false)} style={styles.muteOverlay}>
          <TouchableOpacity activeOpacity={1} style={[styles.muteCard, { backgroundColor: theme.colors.cardBackground }]}>
            <View style={[styles.muteIconWrap, { backgroundColor: '#F0A03012' }]}>
              <Ionicons name="volume-mute" size={28} color="#F0A030" />
            </View>
            <Text style={[styles.muteTitle, { color: theme.colors.primaryTextColor }]}>
              Mute notifications
            </Text>
            <Text style={[styles.muteSubtitle, { color: theme.colors.placeHolderTextColor }]}>
              Choose how long to mute this chat
            </Text>

            <View style={styles.muteOptionsWrap}>
              {MUTE_OPTIONS.map((option) => (
                <TouchableOpacity
                  key={option.key}
                  onPress={() => onSelectMuteDuration(option.duration)}
                  activeOpacity={0.7}
                  style={[styles.muteOptionBtn, { backgroundColor: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.03)' }]}
                >
                  <MaterialCommunityIcons name={option.icon} size={18} color={theme.colors.themeColor} />
                  <Text style={[styles.muteOptionText, { color: theme.colors.primaryTextColor }]}>{option.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity onPress={() => setMuteSheetVisible(false)} activeOpacity={0.6} style={styles.muteCancelBtn}>
              <Text style={[styles.muteCancelText, { color: theme.colors.placeHolderTextColor }]}>Cancel</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ─── DELETE MODAL ─── */}
      <Modal animationType="fade" transparent visible={deleteModalVisible} onRequestClose={closeDeleteModal}>
        <TouchableOpacity activeOpacity={1} onPress={closeDeleteModal} style={styles.deleteOverlay}>
          <TouchableOpacity activeOpacity={1} style={[styles.deleteCard, { backgroundColor: theme.colors.cardBackground }]}>
            <View style={styles.deleteIconWrap}>
              <MaterialCommunityIcons name="delete-alert-outline" size={30} color="#E06A6A" />
            </View>

            <Text style={[styles.deleteTitle, { color: theme.colors.primaryTextColor }]}>
              Delete Chat
            </Text>
            <Text style={[styles.deleteSubtitle, { color: theme.colors.placeHolderTextColor }]}>
              This will clear all messages in this chat on your device.
            </Text>

            <TouchableOpacity
              onPress={() => setDeleteForEveryone((prev) => !prev)}
              activeOpacity={0.7}
              style={styles.deleteCheckRow}
            >
              <MaterialCommunityIcons
                name={deleteForEveryone ? 'checkbox-marked' : 'checkbox-blank-outline'}
                size={22}
                color={deleteForEveryone ? theme.colors.themeColor : theme.colors.placeHolderTextColor}
              />
              <Text style={[styles.deleteCheckLabel, { color: theme.colors.primaryTextColor }]}>
                Delete for both users
              </Text>
            </TouchableOpacity>

            <View style={styles.deleteActions}>
              <TouchableOpacity
                onPress={closeDeleteModal}
                disabled={isDeletingChat}
                activeOpacity={0.7}
                style={[styles.deleteCancelBtn, { borderColor: isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }]}
              >
                <Text style={[styles.deleteCancelText, { color: theme.colors.primaryTextColor }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onConfirmDeleteChat}
                disabled={isDeletingChat}
                activeOpacity={0.7}
                style={styles.deleteConfirmBtn}
              >
                {isDeletingChat ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.deleteConfirmText}>Delete</Text>
                )}
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ─── BLOCKING DELETE PROGRESS OVERLAY ─── */}
      <Modal
        animationType="fade"
        transparent
        visible={bulkDeleteProgress.visible}
        statusBarTranslucent
        onRequestClose={() => { /* swallow back-press during delete */ }}
      >
        <View style={styles.deleteProgressOverlay}>
          <View style={[styles.deleteProgressCard, { backgroundColor: theme.colors.cardBackground }]}>
            <ActivityIndicator size="large" color={theme.colors.themeColor} />
            <Text style={[styles.deleteProgressLabel, { color: theme.colors.primaryTextColor }]}>
              {bulkDeleteProgress.label || 'Deleting...'}
            </Text>
            <Text style={[styles.deleteProgressHint, { color: theme.colors.placeHolderTextColor }]}>
              Please wait — do not close the app
            </Text>
          </View>
        </View>
      </Modal>

      {/* ─── BULK DELETE MODAL ─── */}
      <Modal
        animationType="fade"
        transparent
        visible={bulkDeleteModalVisible}
        onRequestClose={() => { if (!isBulkDeleting) setBulkDeleteModalVisible(false); }}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => { if (!isBulkDeleting) setBulkDeleteModalVisible(false); }}
          style={styles.deleteOverlay}
        >
          <TouchableOpacity activeOpacity={1} style={[styles.deleteCard, { backgroundColor: theme.colors.cardBackground }]}>
            <View style={styles.deleteIconWrap}>
              <MaterialCommunityIcons name="delete-alert-outline" size={30} color="#E06A6A" />
            </View>
            <Text style={[styles.deleteTitle, { color: theme.colors.primaryTextColor }]}>
              Delete {selectedChatIds.length} chat{selectedChatIds.length === 1 ? '' : 's'}?
            </Text>
            <Text style={[styles.deleteSubtitle, { color: theme.colors.placeHolderTextColor }]}>
              The selected chats will be removed from your device. Other participants will still see them.
            </Text>

            <View style={styles.deleteActions}>
              <TouchableOpacity
                onPress={() => setBulkDeleteModalVisible(false)}
                disabled={isBulkDeleting}
                activeOpacity={0.7}
                style={[styles.deleteCancelBtn, { borderColor: isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }]}
              >
                <Text style={[styles.deleteCancelText, { color: theme.colors.primaryTextColor }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onConfirmBulkDelete}
                disabled={isBulkDeleting}
                activeOpacity={0.7}
                style={styles.deleteConfirmBtn}
              >
                {isBulkDeleting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.deleteConfirmText}>Delete</Text>
                )}
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ─── PROFILE PREVIEW MODAL (shared WhatsApp popup) ─── */}
      <ProfilePreviewModal
        visible={profilePreviewVisible}
        onClose={closeProfilePreview}
        name={previewName}
        image={previewImage}
        avatarColor={previewAvatarColor}
        isGroup={isPreviewGroup || isPreviewBroadcast}
        isBroadcast={isPreviewBroadcast}
        isVerified={Boolean(selectedChatItem?.isVerified || selectedChatItem?.peerUser?.isVerified)}
        subtitle={isPreviewBroadcast ? 'Broadcast channel' : undefined}
        peerId={(isPreviewGroup || isPreviewBroadcast) ? null : (selectedChatItem?.peerUser?._id || selectedChatItem?.peerUserId || null)}
        onMessage={() => { if (selectedChatItem) openChat(selectedChatItem); closeProfilePreview(); }}
        onCall={isPreviewBroadcast ? undefined : () => startPreviewCall('audio')}
        onVideo={isPreviewBroadcast ? undefined : () => startPreviewCall('video')}
        onInfo={openPreviewInfo}
        onViewPhoto={previewImage ? () => {
          closeProfilePreview();
          setTimeout(() => setImageViewerVisible(true), 250);
        } : undefined}
      />

      {/* Full-screen Image Viewer with zoom */}
      <Modal
        visible={imageViewerVisible}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => { setImageViewerVisible(false); setSelectedChatItem(null); }}
      >
        <View style={styles.imageViewerContainer}>
          {/* Top bar with back button and name */}
          <View style={styles.imageViewerTopBar}>
            <TouchableOpacity
              onPress={() => { setImageViewerVisible(false); setSelectedChatItem(null); }}
              style={styles.imageViewerBackBtn}
              activeOpacity={0.7}
            >
              <Ionicons name="arrow-back" size={24} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.imageViewerName} numberOfLines={1}>{previewName}</Text>
          </View>

          {previewImage ? (
            <GestureHandlerRootView style={{ flex: 1 }}>
              <ImageZoom
                uri={previewImage}
                minScale={1}
                maxScale={5}
                doubleTapScale={3}
                style={{ flex: 1 }}
                resizeMode="contain"
              />
            </GestureHandlerRootView>
          ) : (
            <View style={styles.imageViewerNoPhoto}>
              <View style={[styles.imageViewerFallbackCircle, { backgroundColor: previewAvatarColor }]}>
                {isPreviewGroup ? (
                  <Ionicons name="people" size={64} color="#fff" />
                ) : (
                  <Text style={styles.imageViewerFallbackLetter}>
                    {(previewName || '?').charAt(0).toUpperCase()}
                  </Text>
                )}
              </View>
              <Text style={styles.imageViewerNoPhotoText}>{isPreviewGroup ? 'No group photo' : 'No profile photo'}</Text>
            </View>
          )}
        </View>
      </Modal>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },

  // ─── HEADER ───
  header: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 8,
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerWordmark: {
    fontSize: 25,
    fontFamily: 'Roboto-Bold',
    letterSpacing: -0.6,
  },
  headerTitle: {
    fontSize: 22,
    fontFamily: 'Roboto-Bold',
    letterSpacing: -0.4,
    textTransform: 'capitalize',
  },
  unreadBadge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 7,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadBadgeText: {
    fontSize: 11,
    fontFamily: 'Roboto-SemiBold',
    color: '#fff',
    letterSpacing: 0.2,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
  },
  menuContent: {
    borderRadius: 16,
    marginTop: 6,
    paddingVertical: 4,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.16,
    shadowRadius: 14,
  },
  menuItemText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
  },

  // ─── DELETE PROGRESS OVERLAY ───
  deleteProgressOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  deleteProgressCard: {
    width: '100%',
    maxWidth: 320,
    borderRadius: 18,
    paddingVertical: 28,
    paddingHorizontal: 22,
    alignItems: 'center',
    gap: 14,
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
  },
  deleteProgressLabel: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 15,
    letterSpacing: 0.2,
    textAlign: 'center',
  },
  deleteProgressHint: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    letterSpacing: 0.2,
    textAlign: 'center',
  },

  // ─── SELECTION OVERLAY ───
  selectionCheckOverlay: {
    position: 'absolute',
    left: 50,
    top: 38,
  },
  selectionCheckCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },

  // ─── LIST ───
  listWrap: {
    flex: 1,
  },
  listHeaderWrap: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 4,
  },
  pinnedHeaderWrap: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 6,
  },
  listContent: {
    flexGrow: 1,
    paddingBottom: 100,
  },
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 80,
    gap: 14,
  },
  loadingText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    letterSpacing: 0.2,
  },

  // ─── SEARCH ───
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 24,
    paddingHorizontal: 16,
    height: 46,
    gap: 12,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: 'Roboto-Regular',
    paddingVertical: 0,
    height: '100%',
    letterSpacing: 0.1,
  },
  searchClearCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ─── FILTER PILLS ───
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 10,
    paddingBottom: 6,
  },
  filterPill: {
    paddingHorizontal: 15,
    paddingVertical: 7,
    borderRadius: 18,
    borderWidth: 1,
  },
  filterPillText: {
    fontSize: 13,
    fontFamily: 'Roboto-Medium',
    letterSpacing: 0.1,
  },

  // ─── ARCHIVE ROW ───
  archiveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 12,
    borderRadius: 14,
    marginTop: 8,
    marginBottom: 2,
  },
  archiveIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  archiveLabel: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 14,
    flex: 1,
  },
  archiveCount: {
    fontFamily: 'Roboto-Medium',
    fontSize: 12,
    marginRight: 4,
  },

  // ─── EMPTY STATE ───
  emptyWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 110,
    paddingHorizontal: 40,
  },
  emptyIconCircle: {
    width: 96,
    height: 96,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  emptyTitle: {
    fontFamily: 'Roboto-Bold',
    fontSize: 18,
    marginBottom: 8,
    letterSpacing: -0.2,
  },
  emptySubtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
  },

  // ─── FAB ───
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    width: 60,
    height: 60,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.28,
    shadowRadius: 14,
  },

  // ─── ACTION SHEET ───
  sheetContainer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetBg: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheetCard: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 16,
    paddingBottom: 30,
  },
  sheetHandle: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 6,
  },
  sheetHandleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
  },
  sheetUserRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 4,
    gap: 12,
  },
  sheetUserAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  sheetUserInitial: {
    color: '#fff',
    fontFamily: 'Roboto-SemiBold',
    fontSize: 16,
  },
  sheetUserName: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 16,
    flex: 1,
    textTransform: 'capitalize',
  },
  sheetDivider: {
    height: StyleSheet.hairlineWidth,
    marginBottom: 4,
  },
  sheetOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    gap: 14,
  },
  sheetOptionIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetOptionLabel: {
    fontFamily: 'Roboto-Medium',
    fontSize: 14.5,
    flex: 1,
  },

  // ─── MUTE MODAL ───
  muteOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    paddingHorizontal: 30,
  },
  muteCard: {
    borderRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 28,
    paddingBottom: 18,
    alignItems: 'center',
  },
  muteIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  muteTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 17,
    marginBottom: 4,
  },
  muteSubtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    marginBottom: 18,
  },
  muteOptionsWrap: {
    width: '100%',
    gap: 6,
    marginBottom: 8,
  },
  muteOptionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderRadius: 14,
    gap: 12,
  },
  muteOptionText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
  },
  muteCancelBtn: {
    paddingVertical: 10,
    marginTop: 4,
  },
  muteCancelText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
  },

  // ─── DELETE MODAL ───
  deleteOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  deleteCard: {
    borderRadius: 20,
    paddingHorizontal: 22,
    paddingTop: 28,
    paddingBottom: 20,
    alignItems: 'center',
  },
  deleteIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#E06A6A10',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  deleteTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 17,
    marginBottom: 6,
  },
  deleteSubtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
  },
  deleteCheckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
    gap: 8,
    alignSelf: 'flex-start',
  },
  deleteCheckLabel: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13.5,
  },
  deleteActions: {
    flexDirection: 'row',
    marginTop: 22,
    gap: 10,
    width: '100%',
  },
  deleteCancelBtn: {
    flex: 1,
    height: 46,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  deleteCancelText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
  },
  deleteConfirmBtn: {
    flex: 1,
    height: 46,
    borderRadius: 14,
    backgroundColor: '#E06A6A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteConfirmText: {
    color: '#fff',
    fontFamily: 'Roboto-SemiBold',
    fontSize: 14,
  },

  // ─── PROFILE PREVIEW MODAL ───
  profileBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  profileOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 28,
  },
  // WhatsApp profile popup: name header → square photo → action row.
  // Width ≈ 70% of screen; the square photo drives the height, with a compact
  // ~56dp header above and ~56dp action bar below (matches WhatsApp's popup).
  profileCard: {
    width: SCREEN_WIDTH * 0.60,
    maxWidth: 270,
    borderRadius: 12,
    overflow: 'hidden',
    elevation: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.45,
    shadowRadius: 24,
  },
  profileImageWrap: {
    width: '100%',
    aspectRatio: 1,
    position: 'relative',
  },
  // Faux gradient scrim — stacked black layers anchored to the top edge; the
  // overlap makes it darkest at the very top and fade to clear (~92px down).
  profileNameScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  profileScrimLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.16)',
  },
  profileNameOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    minHeight: 46,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingTop: 4,
  },
  profileNameText: {
    color: '#fff',
    fontFamily: 'Roboto-Medium',
    fontSize: 16,
    letterSpacing: 0.1,
    textShadowColor: 'rgba(0,0,0,0.75)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  profileImageInner: { width: '100%', height: '100%' },
  profileFallback: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileFallbackText: {
    color: '#fff',
    fontFamily: 'Roboto-Bold',
    fontSize: 92,
    letterSpacing: -2,
  },
  profileActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    minHeight: 44,
    paddingHorizontal: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  profileActionBtn: {
    flex: 1,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ─── IMAGE VIEWER ───
  imageViewerContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  imageViewerTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: Platform.OS === 'ios' ? 54 : 38,
    paddingBottom: 12,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    zIndex: 10,
  },
  imageViewerBackBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageViewerName: {
    flex: 1,
    color: '#fff',
    fontSize: 18,
    fontFamily: 'Roboto-SemiBold',
    marginLeft: 8,
    textTransform: 'capitalize',
  },
  imageViewerNoPhoto: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageViewerFallbackCircle: {
    width: 140,
    height: 140,
    borderRadius: 70,
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageViewerFallbackLetter: {
    color: '#fff',
    fontSize: 64,
    fontFamily: 'Roboto-SemiBold',
    textTransform: 'uppercase',
  },
  imageViewerNoPhotoText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 15,
    fontFamily: 'Roboto-Regular',
    marginTop: 20,
  },
  headerLogoWrap: {
    width: 38, height: 38, borderRadius: 12,
    overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
  },
  headerLogoImg: { width: 38, height: 38 },
});