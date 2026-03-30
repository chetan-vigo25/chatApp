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

export default function ForwardMessageScreen({ navigation, route }) {
  const { messageIds = [], messages = [] } = route.params || {};
  const { theme, isDarkMode } = useTheme();
  const { chatsData = [] } = useSelector(state => state.chat || {});
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedReceivers, setSelectedReceivers] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start();
  }, []);

  // Build list of chats to forward to
  const chatList = useMemo(() => {
    return (chatsData || [])
      .filter(chat => {
        if (!chat) return false;
        const name = chat.chatType === 'group'
          ? (chat.chatName || chat.group?.name || chat.groupName || '')
          : (chat.peerUser?.fullName || '');
        if (!name) return false;
        if (searchQuery) return name.toLowerCase().includes(searchQuery.toLowerCase());
        return true;
      })
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
  }, [chatsData, searchQuery]);

  const toggleReceiver = useCallback((chatId) => {
    setSelectedReceivers(prev =>
      prev.includes(chatId) ? prev.filter(id => id !== chatId) : [...prev, chatId]
    );
  }, []);

  const getChatId = (chat) => chat?._id || chat?.chatId || chat?.peerUser?._id;
  const getChatName = (chat) => {
    if (chat?.chatType === 'group') return chat.chatName || chat.group?.name || chat.groupName || 'Group';
    return chat?.peerUser?.fullName || 'Unknown';
  };
  const getChatAvatar = (chat) => {
    if (chat?.chatType === 'group') return chat.chatAvatar || chat.group?.avatar || chat.groupAvatar;
    return chat?.peerUser?.profileImage;
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

      // Send each message to each selected chat as a NEW message
      let sentCount = 0;
      for (const chatId of selectedReceivers) {
        const chat = chatsData.find(c => getChatId(c) === chatId);
        if (!chat) continue;

        const isGroup = chat?.chatType === 'group';
        const receiverId = isGroup ? null : (chat?.peerUser?._id || chatId);
        const groupId = isGroup ? (chat.groupId || chat.group?._id || chatId) : null;

        for (const msg of messages) {
          const tempId = `temp_fwd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const timestamp = new Date().toISOString();

          const sendEvent = isGroup ? 'group:message:send' : 'message:send';

          const sendPayload = isGroup
            ? {
                groupId,
                text: msg.text || '',
                messageType: msg.type || 'text',
                mediaUrl: msg.mediaUrl || '',
                mediaMeta: msg.mediaMeta || {},
                forwardedFrom: currentUserId,
                isForwarded: true,
                tempId,
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
                forwardedFrom: currentUserId,
                isForwarded: true,
                chatId: chat._id || chat.chatId || chatId,
                senderId: currentUserId,
                senderName: currentUserName,
                tempId,
                createdAt: timestamp,
              };

          // Fire and don't wait — the existing message:new handler will pick it up
          console.log('[Forward] Emitting:', sendEvent, JSON.stringify(sendPayload, null, 2));
          socket.emit(sendEvent, sendPayload, (ack) => {
            console.log('[Forward] ACK received:', JSON.stringify(ack));
            if (ack?.error) console.warn('[Forward] send ack error:', ack.error);
          });

          sentCount++;
          // Small delay between messages to avoid flooding
          if (messages.length > 1) await new Promise(r => setTimeout(r, 100));
        }
      }

      const msgCount = messages.length;
      const chatCount = selectedReceivers.length;

      // ─── WHATSAPP BEHAVIOR ───
      if (chatCount === 1) {
        const targetChatId = selectedReceivers[0];
        const targetChat = chatsData.find(c => getChatId(c) === targetChatId);

        if (targetChat) {
          showToast(`Message${msgCount > 1 ? 's' : ''} forwarded`);

          navigation.replace('ChatScreen', {
            item: targetChat,
            chatId: targetChat._id || targetChat.chatId,
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
  }, [selectedReceivers, messages, chatsData, navigation]);

  // ─── RENDER ───
  const renderChatItem = useCallback(({ item }) => {
    const chatId = getChatId(item);
    const name = getChatName(item);
    const avatar = getChatAvatar(item);
    const isSelected = selectedReceivers.includes(chatId);
    const isGroup = item?.chatType === 'group';
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
      const chat = chatsData.find(c => getChatId(c) === id);
      return chat ? { id, name: getChatName(chat), avatar: getChatAvatar(chat) } : null;
    }).filter(Boolean);
  }, [selectedReceivers, chatsData]);

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
    paddingHorizontal: 16, paddingVertical: 10, gap: 14,
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