import React, { useMemo, useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput, Image,
  StyleSheet, SafeAreaView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSelector } from 'react-redux';

import { useTheme } from '../../contexts/ThemeContext';
import { useRealtimeChat } from '../../contexts/RealtimeChatContext';

const AVATAR_COLORS = ['#6C5CE7', '#00B894', '#E17055', '#0984E3', '#E84393', '#00CEC9', '#FDCB6E', '#D63031'];
const avatarColor = (name = '') => {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
};

/**
 * ShareInboxScreen — the chat picker shown when content is shared INTO the app
 * from the OS share sheet. Mirrors ForwardMessageScreen's chat list, but on
 * selecting a chat it opens that thread (ChatScreen) and hands it the shared
 * files via the `pendingShare` param. ChatScreen then feeds them into its
 * existing `sendMedia` pipeline — this screen never uploads anything itself.
 *
 * Route param: { share: { files: [{ file, type }], text } }  (from ShareIntentGate)
 */
export default function ShareInboxScreen({ navigation, route }) {
  const { theme, isDarkMode } = useTheme();
  const colors = theme.colors;
  const share = route?.params?.share || { files: [], text: undefined };

  const { chatList: realtimeChatList } = useRealtimeChat();
  const { chatsData = [] } = useSelector((state) => state.chat || {});
  const [query, setQuery] = useState('');

  const allChats = useMemo(() => {
    const map = new Map();
    for (const c of Array.isArray(chatsData) ? chatsData : []) {
      const id = c?._id || c?.chatId || c?.peerUser?._id;
      if (id) map.set(String(id), c);
    }
    for (const c of Array.isArray(realtimeChatList) ? realtimeChatList : []) {
      const id = c?._id || c?.chatId || c?.peerUser?._id;
      if (id) map.set(String(id), c);
    }
    return [...map.values()];
  }, [chatsData, realtimeChatList]);

  const getName = (c) =>
    (c?.chatType === 'group' || c?.isGroup)
      ? (c.chatName || c.group?.name || c.groupName || 'Group')
      : (c?.peerUser?.fullName || c?.chatName || 'Unknown');
  const getAvatar = (c) =>
    (c?.chatType === 'group')
      ? (c.chatAvatar || c.group?.avatar || c.groupAvatar)
      : (c?.peerUser?.profileImage || c?.chatAvatar);
  const getId = (c) => c?._id || c?.chatId || c?.peerUser?._id;

  const chats = useMemo(() => {
    return allChats
      .filter((c) => {
        if (!c || c.isArchived || c.archived) return false;
        const name = getName(c);
        if (!name) return false;
        if (query) return name.toLowerCase().includes(query.toLowerCase());
        return true;
      })
      .sort((a, b) => {
        const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
        const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
        return tb - ta;
      });
  }, [allChats, query]);

  const onSelect = useCallback((chat) => {
    // Open the thread and hand it the shared payload. `item` is the canonical
    // param useChatLogic reads; `pendingShare` is consumed by ChatScreen once.
    navigation.replace('ChatScreen', {
      item: chat,
      pendingShare: share,
    });
  }, [navigation, share]);

  const count = share.files.length;
  const subtitle = count > 0
    ? `${count} ${count === 1 ? 'item' : 'items'} • choose a chat`
    : (share.text ? 'Shared text • choose a chat' : 'Choose a chat');

  const renderItem = ({ item }) => {
    const name = getName(item);
    const avatar = getAvatar(item);
    return (
      <TouchableOpacity
        activeOpacity={0.7}
        style={[styles.row, { borderBottomColor: colors.borderColor }]}
        onPress={() => onSelect(item)}
      >
        {avatar ? (
          <Image source={{ uri: avatar }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: avatarColor(name) }]}>
            <Text style={styles.avatarLetter}>{name.charAt(0).toUpperCase()}</Text>
          </View>
        )}
        <Text style={[styles.name, { color: colors.primaryTextColor }]} numberOfLines={1}>
          {name}
        </Text>
        <Ionicons name="send" size={18} color={colors.themeColor} />
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.borderColor }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
          <Ionicons name="close" size={24} color={colors.primaryTextColor} />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <Text style={[styles.headerTitle, { color: colors.primaryTextColor }]}>Share to</Text>
          <Text style={[styles.headerSubtitle, { color: colors.secondaryTextColor }]}>{subtitle}</Text>
        </View>
      </View>

      <View style={[styles.searchBar, { backgroundColor: colors.surface }]}>
        <Ionicons name="search" size={18} color={colors.secondaryTextColor} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search chats"
          placeholderTextColor={colors.placeHolderTextColor}
          style={[styles.searchInput, { color: colors.primaryTextColor }]}
        />
      </View>

      <FlatList
        data={chats}
        keyExtractor={(item) => String(getId(item))}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <Text style={[styles.empty, { color: colors.secondaryTextColor }]}>No chats found</Text>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { padding: 4, marginRight: 8 },
  headerTitleWrap: { flex: 1 },
  headerTitle: { fontFamily: 'Roboto-SemiBold', fontSize: 18 },
  headerSubtitle: { fontFamily: 'Roboto-Regular', fontSize: 12.5, marginTop: 1 },
  searchBar: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 14, marginTop: 12, marginBottom: 6,
    paddingHorizontal: 12, height: 42, borderRadius: 12,
  },
  searchInput: { flex: 1, marginLeft: 8, fontFamily: 'Roboto-Regular', fontSize: 14 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: { width: 46, height: 46, borderRadius: 23 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: '#fff', fontFamily: 'Roboto-SemiBold', fontSize: 18 },
  name: { flex: 1, marginHorizontal: 14, fontFamily: 'Roboto-Medium', fontSize: 15.5 },
  empty: { textAlign: 'center', marginTop: 40, fontFamily: 'Roboto-Regular', fontSize: 14 },
});
