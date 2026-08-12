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

// An id may arrive as a raw string or as a populated object — flatten both.
const flatId = (v) => {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const c = v._id?.$oid || v._id || v.id || v.userId || v.$oid;
    return c == null ? null : String(c);
  }
  return null;
};

/**
 * EVERY id that could identify this conversation, most-canonical first.
 *
 * The two list sources do NOT agree on which field carries the id: the Redux REST
 * doc keeps the chat document `_id`, while the realtime store keys the same
 * conversation on `chatId` (and rows it creates itself carry `_id === chatId`).
 * Deduping on a single field therefore filed one chat under two keys and the
 * picker rendered it twice. Matching on ANY shared id makes the merge immune to
 * whichever field a given source happened to populate.
 */
const candidateIds = (c) => {
  if (!c) return [];
  const out = [];
  const push = (v) => { const s = flatId(v); if (s && !out.includes(s)) out.push(s); };
  if (c.chatType === 'group' || c.isGroup) {
    push(c.groupId); push(c.group?._id); push(c.chatId); push(c._id);
  } else {
    push(c.peerUser?._id); push(c.peerUser?.userId); push(c.peerUser?.id);
    push(c.peerUserId); push(c.participantId); push(c.chatId); push(c._id);
  }
  return out;
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
  const { theme } = useTheme();
  const colors = theme.colors;
  const share = route?.params?.share || { files: [], text: undefined };

  const { chatList: realtimeChatList } = useRealtimeChat();
  const { chatsData = [] } = useSelector((state) => state.chat || {});
  const [query, setQuery] = useState('');

  // Merge both sources: Redux first, then the realtime list overwrites so the
  // fresher copy wins. Reads only what is already in memory — a share must never
  // wait on a network round-trip. Both are needed because a share can arrive
  // before the realtime store has hydrated (cold start), and the Redux list can
  // be stale/absent once it has.
  //
  // Dedupe by conversation IDENTITY, not by one id field: `slotOf` maps every
  // candidate id of a chat onto a single slot, so the same conversation lands in
  // one row no matter which id field each source filled in (that mismatch is what
  // rendered every chat twice).
  const allChats = useMemo(() => {
    const slotOf = new Map(); // any candidate id → slot key
    const bySlot = new Map(); // slot key → chat

    const add = (c) => {
      const ids = candidateIds(c);
      if (!ids.length) return;
      const known = ids.find((id) => slotOf.has(id));
      const slot = known ? slotOf.get(known) : ids[0];
      ids.forEach((id) => slotOf.set(id, slot));
      bySlot.set(slot, c); // later source (realtime) wins, as before
    };

    for (const c of Array.isArray(chatsData) ? chatsData : []) add(c);
    for (const c of Array.isArray(realtimeChatList) ? realtimeChatList : []) add(c);
    return [...bySlot.values()];
  }, [chatsData, realtimeChatList]);

  const getName = (c) =>
    (c?.chatType === 'group' || c?.isGroup)
      ? (c.chatName || c.group?.name || c.groupName || 'Group')
      : (c?.peerUser?.fullName || c?.chatName || 'Unknown');
  const getAvatar = (c) =>
    (c?.chatType === 'group')
      ? (c.chatAvatar || c.group?.avatar || c.groupAvatar)
      : (c?.peerUser?.profileImage || c?.chatAvatar);

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
    // replace() (not navigate) so Back from the chat doesn't land on a stale
    // picker holding a share that was already sent.
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
          <Text style={[styles.headerSub, { color: colors.placeHolderTextColor }]}>{subtitle}</Text>
        </View>
      </View>

      <View style={styles.searchWrap}>
        <View style={[styles.searchBox, { backgroundColor: colors.menuBackground }]}>
          <Ionicons name="search" size={18} color={colors.placeHolderTextColor} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search chats"
            placeholderTextColor={colors.placeHolderTextColor}
            style={[styles.searchInput, { color: colors.primaryTextColor }]}
          />
        </View>
      </View>

      <FlatList
        data={chats}
        keyExtractor={(item, i) => candidateIds(item)[0] || String(i)}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={(
          <Text style={[styles.empty, { color: colors.placeHolderTextColor }]}>
            No chats to share with
          </Text>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { padding: 4, marginRight: 8 },
  headerTitleWrap: { flex: 1 },
  headerTitle: { fontSize: 18, fontWeight: '600' },
  headerSub: { fontSize: 12, marginTop: 2 },
  searchWrap: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4 },
  searchBox: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: 10, paddingHorizontal: 10, height: 42,
  },
  searchInput: { flex: 1, marginLeft: 8, fontSize: 15, padding: 0 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: { width: 44, height: 44, borderRadius: 22, marginRight: 14 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: '#fff', fontSize: 18, fontWeight: '600' },
  name: { flex: 1, fontSize: 16, fontWeight: '500' },
  empty: { textAlign: 'center', marginTop: 40, fontSize: 14 },
});
