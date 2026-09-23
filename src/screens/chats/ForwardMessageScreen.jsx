import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput, Image,
  ActivityIndicator, StyleSheet, Platform, ToastAndroid, Alert,
  Animated, Keyboard,
} from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';
import { useSelector } from 'react-redux';
import { Ionicons, FontAwesome6 } from '@expo/vector-icons';
import { getSocket, isSocketConnected } from '../../Redux/Services/Socket/socket';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { setForwardTimestamp } from '../../utils/forwardState';
import { useRealtimeChatLists } from '../../contexts/RealtimeChatContext';
import ChatCache from '../../services/ChatCache';
import ChatDatabase from '../../services/ChatDatabase';
import OutboxWorker from '../../services/OutboxWorker';
import { resolveDisplayName as resolveCanonicalName } from '../../services/contactNameStore';

// Same display rule as every other surface: my saved name → the peer's number
// → their own account name only when no number is known.
const privateChatLabel = (chat) => resolveCanonicalName({
  userId: chat?.peerUser?._id || chat?.peerUser?.userId || chat?.peerUserId,
  phone: chat?.mobileNumber
    || chat?.peerUser?.mobileNumber
    || (chat?.peerUser?.mobile?.number
      ? `${chat.peerUser.mobile.code || ''}${chat.peerUser.mobile.number}`
      : null),
  pushName: chat?.peerUser?.fullName || chat?.chatName,
  // Contact privacy — the forward picker is a full list of peers, so a hidden
  // number showing here would defeat the toggle everywhere else.
  username: chat?.peerUser?.userName || null,
  hideContact: Boolean(chat?.peerUser?.hideContact ?? chat?.hideContact),
  fallback: 'Unknown',
});

// Mongo ids arrive as strings, `{ _id }` refs or `{ $oid }` — flatten them so
// two spellings of the same id never read as two different chats.
const normalizeId = (value) => {
  if (!value) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  const candidate = value?._id || value?.id || value?.userId || value?.$oid;
  return candidate ? String(candidate) : null;
};

// Identity of the CONVERSATION, not of the row that carries it.
// Redux (REST docs), the realtime store and the SQLite hydrate each key a chat
// differently (`_id` / `chatId` / an aliased peer row), so deduping on those
// fields let the same person or group show up twice in this picker. A group is
// its groupId, a 1-1 chat is its peer — that is stable across all three
// sources; only a row with neither falls back to its own id.
const chatIdentityKey = (chat) => {
  if (!chat) return null;
  const isGroup = chat.chatType === 'group' || chat.isGroup;
  if (isGroup) {
    const gid = normalizeId(chat.groupId || chat.group?._id || chat.group);
    if (gid) return `g_${gid}`;
  } else {
    const pid = normalizeId(
      chat.peerUser?._id || chat.peerUser?.userId || chat.peerUser?.id
      || chat.peerUserId || chat.participantId
      || chat.otherUser?._id || chat.otherUser?.userId
    );
    if (pid) return `p_${pid}`;
  }
  const cid = normalizeId(chat._id || chat.chatId);
  return cid ? `c_${cid}` : null;
};

// Later source wins, but only where it actually has a value — a realtime row
// with a not-yet-hydrated name/avatar must not blank out what REST already had.
const mergeChatRows = (base, next) => {
  if (!base) return next;
  if (!next) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  const basePeer = base.peerUser || base.otherUser || null;
  const nextPeer = next.peerUser || next.otherUser || null;
  if (basePeer || nextPeer) {
    const peer = { ...(basePeer || {}) };
    for (const [k, v] of Object.entries(nextPeer || {})) {
      if (v === undefined || v === null || v === '') continue;
      peer[k] = v;
    }
    out.peerUser = peer;
  }
  return out;
};

const AVATAR_COLORS = [
  '#6C5CE7', '#00B894', '#E17055', '#0984E3',
  '#E84393', '#00CEC9', '#FDCB6E', '#D63031',
];

const getAvatarColor = (name) => {
  if (!name) return AVATAR_COLORS[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

const showToast = (msg) => {
  if (Platform.OS === 'android') ToastAndroid.show(msg, ToastAndroid.SHORT);
  else Alert.alert('', msg);
};

// Per-message ack wait in the ordered forward send; past it the outbox resends.
const FORWARD_ACK_TIMEOUT_MS = 3000;

export default function ForwardMessageScreen({ navigation, route }) {
  const { messageIds = [], messages = [] } = route.params || {};
  const { theme, isDarkMode } = useTheme();
  const { chatsData = [] } = useSelector(state => state.chat || {});
  const { chatList: realtimeChatList } = useRealtimeChatLists();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedReceivers, setSelectedReceivers] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start();
  }, []);

  // Merge both sources — RealtimeChatContext (SQLite + socket) is primary, Redux is fallback
  const allChats = useMemo(() => {
    const realtimeList = Array.isArray(realtimeChatList) ? realtimeChatList : [];
    const reduxList = Array.isArray(chatsData) ? chatsData : [];

    // Deduplicate on the conversation's identity (peer / group), not on the
    // row's id field — the two sources spell that id differently, so keying on
    // it rendered every chat twice. Realtime is applied last so it wins.
    const chatMap = new Map();
    const put = (chat) => {
      const key = chatIdentityKey(chat);
      if (!key) return;
      chatMap.set(key, mergeChatRows(chatMap.get(key), chat));
    };
    for (const chat of reduxList) put(chat);
    for (const chat of realtimeList) put(chat);
    return [...chatMap.values()];
  }, [realtimeChatList, chatsData]);

  // Build list of chats to forward to — includes both groups AND private chats
  const chatList = useMemo(() => {
    return allChats
      .filter(chat => {
        if (!chat) return false;
        // Skip archived chats
        if (chat.isArchived || chat.archived) return false;
        const isGroup = chat.chatType === 'group' || chat.isGroup;
        const name = isGroup
          ? (chat.chatName || chat.group?.name || chat.groupName || '')
          : privateChatLabel(chat);
        if (!name) return false;
        if (searchQuery) return name.toLowerCase().includes(searchQuery.toLowerCase());
        return true;
      })
      .sort((a, b) => {
        const timeA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : (a.timestamp ? new Date(a.timestamp).getTime() : 0);
        const timeB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : (b.timestamp ? new Date(b.timestamp).getTime() : 0);
        return timeB - timeA;
      });
  }, [allChats, searchQuery]);

  const toggleReceiver = useCallback((chatId) => {
    setSelectedReceivers(prev =>
      prev.includes(chatId) ? prev.filter(id => id !== chatId) : [...prev, chatId]
    );
  }, []);

  const getChatId = (chat) => chat?._id || chat?.chatId || chat?.peerUser?._id;
  const getChatName = (chat) => {
    if (chat?.chatType === 'group' || chat?.isGroup) return chat.chatName || chat.group?.name || chat.groupName || 'Group';
    return privateChatLabel(chat);
  };
  const getChatAvatar = (chat) => {
    if (chat?.chatType === 'group' || chat?.isGroup) return chat.chatAvatar || chat.group?.avatar || chat.groupAvatar;
    // chatAvatar fallback: chat-list rows carry the peer's image as chatAvatar
    // even when the local peerUser object wasn't hydrated with one.
    return chat?.peerUser?.profileImage || chat?.chatAvatar;
  };

  // ─── FORWARD HANDLER ───
  // Sends forwarded messages as NEW messages via message:send (guaranteed to work)
  // with isForwarded: true + forwardedFrom metadata
  const handleForward = useCallback(async () => {
    if (selectedReceivers.length === 0) return showToast('Select at least one chat');
    if (messages.length === 0) return showToast('No messages to forward');

    setIsSending(true);
    Keyboard.dismiss();

    try {
      const socket = getSocket();
      if (!socket || !isSocketConnected()) {
        showToast('Not connected');
        setIsSending(false);
        return;
      }

      const userInfoRaw = await AsyncStorage.getItem('userInfo');
      const userInfo = userInfoRaw ? JSON.parse(userInfoRaw) : {};
      const currentUserId = userInfo?._id || userInfo?.id || '';
      const currentUserName = userInfo?.fullName || userInfo?.name || '';

      // Mark forward timestamp
      setForwardTimestamp();

      // Chronological order (WhatsApp): selection order is tap order, but the
      // forwarded copies must read top-to-bottom like the source chat.
      const msgTime = (m) => {
        const t = m?.timestamp ?? m?.createdAt;
        const n = typeof t === 'number' ? t : Date.parse(t);
        return Number.isFinite(n) ? n : 0;
      };
      const orderedMessages = [...messages].sort((a, b) => msgTime(a) - msgTime(b));

      // Strictly increasing clock per forwarded copy: same-millisecond
      // timestamps made the batch sort unstably and look like twins to the
      // exact-timestamp dedup.
      const baseTs = Date.now();
      let seqOffset = 0;
      const localRows = [];
      // Per destination chat, the ordered emits (sent after navigation).
      const sendQueues = [];

      // Send each message to each selected chat as a NEW message
      let sentCount = 0;
      for (const chatId of selectedReceivers) {
        const chat = allChats.find(c => getChatId(c) === chatId);
        if (!chat) continue;

        // Same group test the list/render use — a row that only carries
        // `isGroup` (realtime/SQLite rows do) must not be sent down the 1-1 path.
        const isGroup = chat?.chatType === 'group' || chat?.isGroup;
        const receiverId = isGroup ? null : (chat?.peerUser?._id || chatId);
        const groupId = isGroup ? (chat.groupId || chat.group?._id || chatId) : null;

        // Generate the correct chatId for cache (same logic as useChatLogic)
        const chatIdForCache = isGroup
          ? (chat.groupId || chat.group?._id || chat._id || chat.chatId)
          : `u_${[String(currentUserId), String(chat?.peerUser?._id || 'unknown')].sort().join('_')}`;

        const queue = [];
        sendQueues.push(queue);
        for (const msg of orderedMessages) {
          const tempId = `temp_fwd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const timestamp = new Date(baseTs + seqOffset++).toISOString();

          const sendEvent = isGroup ? 'group:message:send' : 'message:send';

          // The ORIGINAL sender (not the forwarder). The server sets the canonical
          // forwardedFrom and echoes it back; we never claim the current user as
          // the original sender. Use the source message's sender if we have it.
          // Only a real Mongo ObjectId may go on the wire — the backend persists
          // it as an ObjectId ref, so a tempId/UUID must degrade to null.
          const rawOriginalSender = msg?.forwardedFrom || msg?.senderId || null;
          const originalSender = (rawOriginalSender && /^[a-f0-9]{24}$/i.test(String(rawOriginalSender)))
            ? String(rawOriginalSender)
            : null;

          const sendPayload = isGroup
            ? {
                groupId,
                text: msg.text || '',
                messageType: msg.type || 'text',
                mediaUrl: msg.mediaUrl || '',
                mediaMeta: msg.mediaMeta || {},
                isForwarded: true,
                // Original-sender ref (when known) so the server can persist the
                // canonical forwardedFrom and every receiver renders the label.
                ...(originalSender ? { forwardedFrom: originalSender } : {}),
                tempId,
                // Explicit idempotency key (tempId is only the legacy alias):
                // the server dedupes on (chatId, clientMessageId), so a retry
                // or outbox replay can never create a duplicate forward.
                clientMessageId: tempId,
                clientId: tempId,
                senderId: currentUserId,
                senderName: currentUserName,
                createdAt: timestamp,
              }
            : {
                receiverId,
                messageType: msg.type || 'text',
                chatType: 'private',
                text: msg.text || '',
                mediaUrl: msg.mediaUrl || '',
                mediaMeta: msg.mediaMeta || {},
                isForwarded: true,
                ...(originalSender ? { forwardedFrom: originalSender } : {}),
                chatId: chatIdForCache,
                senderId: currentUserId,
                senderName: currentUserName,
                tempId,
                clientMessageId: tempId,
                clientId: tempId,
                createdAt: timestamp,
              };

          // Optimistically add to cache for instant UI update
          const optimisticMessage = {
            id: tempId,
            tempId,
            clientMessageId: tempId,
            text: msg.text || '',
            type: msg.type || 'text',
            mediaUrl: msg.mediaUrl || '',
            mediaMeta: msg.mediaMeta || {},
            senderId: currentUserId,
            senderName: currentUserName,
            chatId: chatIdForCache,
            timestamp: new Date(timestamp).getTime(),
            createdAt: timestamp,
            // Honest clock until the server ack — the premature 'sent' lied
            // whenever the emit was dropped (and forwards had no retry path).
            status: 'sending',
            isForwarded: true,
            // Original sender if known; never the current user (the forwarder).
            // The server echoes the canonical forwardedFrom on the real message.
            ...(originalSender ? { forwardedFrom: originalSender } : {}),
            senderType: 'self',
          };
          ChatCache.addMessage(chatIdForCache, optimisticMessage);

          // Local-first durability: the row used to live ONLY in the in-memory
          // cache — opening the destination chat re-read SQLite (which had
          // nothing) and the forward vanished until the next sync round, and
          // an app kill lost it entirely. Rows are persisted below in ONE
          // transaction, plus a durable outbox row each so a dropped emit
          // auto-resends (server dedupes on clientMessageId, so the
          // socket/outbox race can't duplicate).
          localRows.push({ ...optimisticMessage, synced: false });
          queue.push({
            event: sendEvent,
            payload: sendPayload,
            outbox: { clientMessageId: tempId, chatId: chatIdForCache, payload: sendPayload },
          });

          sentCount++;
        }
      }

      // Everything below runs OFF the navigation path (WhatsApp closes the
      // picker instantly). The destination chat paints these rows from
      // ChatCache and its SQLite refresh keeps tempId rows the DB doesn't have
      // yet, so nothing blinks.
      //
      // Emits go one at a time per chat, each waiting for its ack: the server
      // stamps order on arrival and processes concurrent sends in parallel, so
      // a burst reached receivers shuffled. Chats run in parallel. A timed-out
      // ack just moves on — the outbox row (enqueued right after each emit, as
      // before) resends it.
      (async () => {
        try { await ChatDatabase.upsertMessages(localRows); } catch (_) {}
      })();
      const emitInOrder = async (queue) => {
        for (const item of queue) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, FORWARD_ACK_TIMEOUT_MS);
            socket.emit(item.event, item.payload, (ack) => {
              clearTimeout(timer);
              if (ack?.error) console.warn('[Forward] send ack error:', ack.error);
              resolve();
            });
            ChatDatabase.outboxEnqueue({ ...item.outbox, notBefore: Date.now() + 4000 })
              .then(() => OutboxWorker.wake())
              .catch(() => {});
          });
        }
      };
      sendQueues.forEach((queue) => { emitInOrder(queue).catch(() => {}); });

      const msgCount = messages.length;
      const chatCount = selectedReceivers.length;

      // ─── WHATSAPP BEHAVIOR ───
      if (chatCount === 1) {
        const targetChatId = selectedReceivers[0];
        const targetChat = allChats.find(c => getChatId(c) === targetChatId);

        if (targetChat) {
          const isGroup = targetChat?.chatType === 'group' || targetChat?.isGroup;
          // The REST chat list carries `peerUserId` and no `peerUser` object, so
          // reading only `peerUser._id` minted `u_<me>_unknown` — a thread id
          // that matches nothing. Take the peer id from either shape, and fall
          // back to the row's own chatId rather than inventing one.
          const peerId = targetChat?.peerUser?._id || targetChat?.peerUserId || null;
          const navChatId = isGroup
            ? (targetChat.groupId || targetChat.group?._id || targetChat._id || targetChat.chatId)
            : (peerId
              ? `u_${[String(currentUserId), String(peerId)].sort().join('_')}`
              : (targetChat.chatId || targetChat._id || null));

          showToast(`Message${msgCount > 1 ? 's' : ''} forwarded`);

          navigation.replace('ChatScreen', {
            item: targetChat,
            chatId: navChatId,
            user: targetChat.peerUser || null,
            hasExistingChat: true,
            openedFromForward: true,
          });
        } else {
          showToast('Forwarded to 1 chat');
          navigation.goBack();
        }
      } else {
        showToast(`Forwarded ${msgCount} message${msgCount > 1 ? 's' : ''} to ${chatCount} chats`);
        navigation.popToTop();
      }
    } catch (err) {
      console.error('[Forward] error:', err);
      showToast(err?.message || 'Failed to forward');
    } finally {
      setIsSending(false);
    }
  }, [selectedReceivers, messages, allChats, navigation]);

  // ─── RENDER ───
  const renderChatItem = useCallback(({ item }) => {
    const chatId = getChatId(item);
    const name = getChatName(item);
    const avatar = getChatAvatar(item);
    const isSelected = selectedReceivers.includes(chatId);
    const isGroup = item?.chatType === 'group' || item?.isGroup;
    const initials = (name || '?').charAt(0).toUpperCase();
    const avatarBg = getAvatarColor(name);

    return (
      <TouchableOpacity
        onPress={() => toggleReceiver(chatId)}
        activeOpacity={0.6}
        style={[styles.chatRow, { backgroundColor: theme.colors.background }]}
      >
        <View style={[styles.avatarWrap, { backgroundColor: avatarBg }]}>
          {avatar ? (
            <Image source={{ uri: avatar }} style={styles.avatarImage} resizeMode="cover" />
          ) : isGroup ? (
            <Ionicons name="people" size={20} color="#fff" />
          ) : (
            <Text style={styles.avatarText}>{initials}</Text>
          )}
        </View>

        <View style={styles.chatInfo}>
          <Text style={[styles.chatName, { color: theme.colors.primaryTextColor }]} numberOfLines={1}>
            {name}
          </Text>
          {isGroup && (
            <Text style={[styles.chatSub, { color: theme.colors.placeHolderTextColor }]}>Group</Text>
          )}
        </View>

        <View style={[
          styles.checkbox,
          isSelected
            ? { backgroundColor: theme.colors.themeColor, borderColor: theme.colors.themeColor }
            : { borderColor: theme.colors.placeHolderTextColor }
        ]}>
          {isSelected && <Ionicons name="checkmark" size={16} color="#fff" />}
        </View>
      </TouchableOpacity>
    );
  }, [selectedReceivers, theme, toggleReceiver]);

  const keyExtractor = useCallback((item) => getChatId(item) || String(Math.random()), []);

  // Selected chips at top
  const selectedChats = useMemo(() => {
    return selectedReceivers.map(id => {
      const chat = allChats.find(c => getChatId(c) === id);
      return chat ? { id, name: getChatName(chat), avatar: getChatAvatar(chat) } : null;
    }).filter(Boolean);
  }, [selectedReceivers, allChats]);

  return (
    <Animated.View style={[styles.container, { backgroundColor: theme.colors.background, opacity: fadeAnim }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: theme.colors.background }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <FontAwesome6 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
        <View style={styles.headerInfo}>
          <Text style={[styles.headerTitle, { color: theme.colors.primaryTextColor }]}>Forward to...</Text>
          <Text style={[styles.headerSub, { color: theme.colors.placeHolderTextColor }]}>
            {selectedReceivers.length > 0
              ? `${selectedReceivers.length} selected`
              : `${messageIds.length} message${messageIds.length > 1 ? 's' : ''}`}
          </Text>
        </View>
      </View>

      {/* Search */}
      <View style={[styles.searchWrap, { backgroundColor: theme.colors.menuBackground }]}>
        <Ionicons name="search-outline" size={18} color={theme.colors.placeHolderTextColor} />
        <TextInput
          keyboardAppearance={isDarkMode ? 'dark' : 'light'}
          placeholder="Search chats..."
          placeholderTextColor={theme.colors.placeHolderTextColor}
          value={searchQuery}
          onChangeText={setSearchQuery}
          style={[styles.searchInput, { color: theme.colors.primaryTextColor }]}
          returnKeyType="search"
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')}>
            <Ionicons name="close-circle" size={18} color={theme.colors.placeHolderTextColor} />
          </TouchableOpacity>
        )}
      </View>

      {/* Selected chips */}
      {selectedChats.length > 0 && (
        <View style={styles.chipsWrap}>
          {selectedChats.map(chat => (
            <TouchableOpacity
              key={chat.id}
              onPress={() => toggleReceiver(chat.id)}
              style={[styles.chip, { backgroundColor: theme.colors.themeColor + '18' }]}
            >
              <Text style={[styles.chipText, { color: theme.colors.themeColor }]} numberOfLines={1}>
                {chat.name}
              </Text>
              <Ionicons name="close" size={14} color={theme.colors.themeColor} />
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Chat list */}
      <FlatList
        data={chatList}
        renderItem={renderChatItem}
        keyExtractor={keyExtractor}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={20}
        maxToRenderPerBatch={15}
        windowSize={7}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={[styles.emptyText, { color: theme.colors.placeHolderTextColor }]}>
              {searchQuery ? 'No chats found' : 'No chats available'}
            </Text>
          </View>
        }
      />

      {/* Forward FAB */}
      {selectedReceivers.length > 0 && (
        <TouchableOpacity
          onPress={handleForward}
          disabled={isSending}
          activeOpacity={0.8}
          style={[styles.fab, { backgroundColor: theme.colors.themeColor }]}
        >
          {isSending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons name="send" size={22} color="#fff" />
          )}
        </TouchableOpacity>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 6, paddingVertical: 10, gap: 6,
  },
  backBtn: {
    width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 21,
  },
  headerInfo: { flex: 1 },
  headerTitle: { fontFamily: 'Roboto-SemiBold', fontSize: 18 },
  headerSub: { fontFamily: 'Roboto-Regular', fontSize: 12, marginTop: -2 },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 14, marginBottom: 8,
    borderRadius: 25, height: 42, paddingHorizontal: 14, gap: 8,
  },
  searchInput: {
    flex: 1, fontFamily: 'Roboto-Regular', fontSize: 14, paddingVertical: 0, height: 42,
  },
  chipsWrap: {
    flexDirection: 'row', flexWrap: 'wrap',
    paddingHorizontal: 14, paddingBottom: 8, gap: 6,
  },
  chip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 16, gap: 4, maxWidth: 150,
  },
  chipText: { fontFamily: 'Roboto-Medium', fontSize: 12, flexShrink: 1 },
  listContent: { paddingBottom: 100 },
  chatRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 10, gap: 14,
  },
  avatarWrap: {
    width: 48, height: 48, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  avatarImage: { width: 48, height: 48, borderRadius: 24 },
  avatarText: { color: '#fff', fontFamily: 'Roboto-SemiBold', fontSize: 18 },
  chatInfo: { flex: 1 },
  chatName: { fontFamily: 'Roboto-Medium', fontSize: 15, textTransform: 'capitalize' },
  chatSub: { fontFamily: 'Roboto-Regular', fontSize: 12, marginTop: 1 },
  checkbox: {
    width: 24, height: 24, borderRadius: 12, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  emptyWrap: { alignItems: 'center', paddingTop: 60 },
  emptyText: { fontFamily: 'Roboto-Regular', fontSize: 14 },
  fab: {
    position: 'absolute', bottom: 24, right: 20,
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
    elevation: 6, shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 6,
  },
});