import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, Image,
  ActivityIndicator, Alert, Modal,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons, MaterialCommunityIcons, FontAwesome6 } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import ChatDatabase from '../../services/ChatDatabase';
import ChatCache from '../../services/ChatCache';
import { apiCall } from '../../Config/Https';
import { updateUserSettings } from '../../Redux/Services/Profile/Settings.Services';

const AVATAR_COLORS = ['#6C5CE7', '#00B894', '#E17055', '#0984E3', '#E84393'];

const getInitials = (name) => {
  if (!name) return '?';
  return String(name).trim().split(' ').map((p) => p.charAt(0).toUpperCase()).join('').slice(0, 2);
};

const normalizeId = (id) => (id == null ? '' : String(id));

export default function DeletedChatsSelector({ navigation }) {
  const { theme, isDarkMode } = useTheme();

  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [deleting, setDeleting] = useState(false);
  const [scopeModal, setScopeModal] = useState(false);
  const [progressLabel, setProgressLabel] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const rows = await ChatDatabase.loadChatList({ includeArchived: true });
        setChats(rows || []);
      } catch (e) {
        console.warn('[DeletedChatsSelector] loadChatList failed', e);
        setChats([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const themeColor = theme.colors.themeColor;
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const pageBg = isDarkMode ? '#0B141A' : '#F4F6F9';
  const cardBg = isDarkMode ? '#16222C' : '#FFFFFF';
  const borderClr = isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(15,30,50,0.06)';

  const allSelected = chats.length > 0 && selectedIds.size === chats.length;
  const selectedCount = selectedIds.size;

  const toggleOne = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (prev.size === chats.length) return new Set();
      return new Set(chats.map((c) => normalizeId(c.chatId || c._id)));
    });
  }, [chats]);

  const goToChatList = () => {
    navigation.reset({ index: 0, routes: [{ name: 'ChatList' }] });
  };

  const performDelete = useCallback(async (scope) => {
    if (deleting) return;
    const ids = Array.from(selectedIds).filter(Boolean);
    if (ids.length === 0) {
      setScopeModal(false);
      return;
    }
    setScopeModal(false);
    setDeleting(true);
    setProgressLabel(`Deleting ${ids.length} chat${ids.length === 1 ? '' : 's'}…`);

    const rawUser = await AsyncStorage.getItem('userInfo');
    const user = rawUser ? JSON.parse(rawUser) : null;
    const userId = normalizeId(user?._id || user?.id);

    let failures = 0;
    for (let i = 0; i < ids.length; i++) {
      const chatId = ids[i];
      setProgressLabel(`Deleting ${i + 1} of ${ids.length}…`);
      try {
        // Mirrors the per-chat path in ChatList so the server + Kafka flow
        // behaves identically to a user-initiated delete.
        const endpoint = scope === 'everyone'
          ? 'user/chat/clear/everyone'
          : 'user/chat/clear/me';
        const response = await apiCall('POST', endpoint, { chatId, userId });
        const failed = response && (response.success === false || response.status === false || response.ok === false || response.error);
        if (failed) {
          failures += 1;
          continue;
        }
        try { await ChatDatabase.clearChat(chatId, Date.now()); } catch {}
        try { await ChatDatabase.deleteChatRow(chatId); } catch {}
        try { ChatCache.clearMessages(chatId); } catch {}
        try { ChatCache.removeChat(chatId); } catch {}
      } catch (e) {
        console.warn('[DeletedChatsSelector] delete failed', chatId, e?.message);
        failures += 1;
      }
    }

    // Per spec: once the locked workflow is done, the deleted-chats password
    // is consumed — clear it so the next launch goes straight to the list.
    try {
      await updateUserSettings({ chat: { deletedPassword: null } });
    } catch (e) {
      console.warn('[DeletedChatsSelector] could not reset deletedPassword', e);
    }

    setDeleting(false);
    setProgressLabel('');

    if (failures > 0) {
      Alert.alert(
        'Some chats not deleted',
        `${ids.length - failures} chat(s) deleted. ${failures} could not be deleted.`,
        [{ text: 'OK', onPress: goToChatList }]
      );
    } else {
      goToChatList();
    }
  }, [deleting, selectedIds]);

  // ─── Renderers ───
  const renderHeader = () => (
    <View style={[styles.header, { borderBottomColor: borderClr }]}>
      <TouchableOpacity
        onPress={goToChatList}
        activeOpacity={0.6}
        style={[styles.headerBtn, { backgroundColor: cardBg }]}
      >
        <FontAwesome6 name="arrow-left" size={18} color={primaryText} />
      </TouchableOpacity>
      <View style={styles.flex}>
        <Text style={[styles.headerTitle, { color: primaryText }]} numberOfLines={1}>
          {selectedCount > 0 ? `${selectedCount} selected` : 'Select chats to delete'}
        </Text>
        <Text style={[styles.headerSub, { color: subText }]} numberOfLines={1}>
          Password verified · unlocked area
        </Text>
      </View>
      <TouchableOpacity
        onPress={toggleAll}
        disabled={chats.length === 0}
        activeOpacity={0.7}
        style={[styles.selectAllBtn, {
          backgroundColor: allSelected ? themeColor : themeColor + '1A',
          opacity: chats.length === 0 ? 0.4 : 1,
        }]}
      >
        <Ionicons
          name={allSelected ? 'checkbox' : 'square-outline'}
          size={16}
          color={allSelected ? '#fff' : themeColor}
        />
        <Text style={[styles.selectAllText, {
          color: allSelected ? '#fff' : themeColor,
        }]}>
          {allSelected ? 'All' : 'All'}
        </Text>
      </TouchableOpacity>
    </View>
  );

  const renderItem = ({ item }) => {
    const id = normalizeId(item.chatId || item._id);
    const selected = selectedIds.has(id);
    const name = item.name || item.fullName || item.peerName || item.groupName || 'Chat';
    const avatarBg = AVATAR_COLORS[(name.charCodeAt(0) || 0) % AVATAR_COLORS.length];
    const lastMsg =
      item.lastMessage?.text ||
      item.lastMessage?.content ||
      item.lastMessageText ||
      '';

    return (
      <TouchableOpacity
        activeOpacity={0.6}
        onPress={() => toggleOne(id)}
        style={[styles.row, {
          backgroundColor: selected ? themeColor + '12' : 'transparent',
          borderBottomColor: borderClr,
        }]}
      >
        <View style={[styles.checkbox, {
          borderColor: selected ? themeColor : (isDarkMode ? '#3A4A56' : '#C8CFD8'),
          backgroundColor: selected ? themeColor : 'transparent',
        }]}>
          {selected && <Ionicons name="checkmark" size={14} color="#fff" />}
        </View>
        <View style={[styles.avatar, { backgroundColor: avatarBg }]}>
          {item.profileImage || item.avatar ? (
            <Image source={{ uri: item.profileImage || item.avatar }} style={styles.avatarImg} />
          ) : (
            <Text style={styles.avatarText}>{getInitials(name)}</Text>
          )}
        </View>
        <View style={styles.rowText}>
          <Text style={[styles.rowName, { color: primaryText }]} numberOfLines={1}>
            {name}
          </Text>
          {!!lastMsg && (
            <Text style={[styles.rowSub, { color: subText }]} numberOfLines={1}>
              {lastMsg}
            </Text>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmpty = () => (
    <View style={styles.emptyWrap}>
      <View style={[styles.emptyIcon, { backgroundColor: themeColor + '1A' }]}>
        <MaterialCommunityIcons name="chat-remove-outline" size={36} color={themeColor} />
      </View>
      <Text style={[styles.emptyTitle, { color: primaryText }]}>No chats on this device</Text>
      <Text style={[styles.emptyBody, { color: subText }]}>
        There's nothing to delete from here. The password will be reset when
        you continue.
      </Text>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={async () => {
          try { await updateUserSettings({ chat: { deletedPassword: null } }); } catch {}
          goToChatList();
        }}
        style={[styles.emptyBtn, { backgroundColor: themeColor }]}
      >
        <Text style={styles.emptyBtnText}>Continue to chat list</Text>
      </TouchableOpacity>
    </View>
  );

  const renderActionBar = () => {
    if (selectedCount === 0) return null;
    return (
      <View style={[styles.actionBar, { backgroundColor: cardBg, borderTopColor: borderClr }]}>
        <View style={styles.flex}>
          <Text style={[styles.actionCount, { color: primaryText }]}>
            {selectedCount} chat{selectedCount === 1 ? '' : 's'} selected
          </Text>
          <Text style={[styles.actionHint, { color: subText }]}>
            Password resets after delete
          </Text>
        </View>
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => setScopeModal(true)}
          disabled={deleting}
          style={[styles.deleteBtn, { backgroundColor: '#E53935', opacity: deleting ? 0.7 : 1 }]}
        >
          <Ionicons name="trash-outline" size={18} color="#fff" />
          <Text style={styles.deleteBtnText}>Delete</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderScopeModal = () => (
    <Modal visible={scopeModal} transparent animationType="fade" onRequestClose={() => setScopeModal(false)}>
      <TouchableOpacity
        activeOpacity={1}
        onPress={() => setScopeModal(false)}
        style={styles.modalBackdrop}
      >
        <TouchableOpacity activeOpacity={1} style={[styles.modalCard, { backgroundColor: cardBg }]}>
          <Text style={[styles.modalTitle, { color: primaryText }]}>
            Delete {selectedCount} chat{selectedCount === 1 ? '' : 's'}?
          </Text>
          <Text style={[styles.modalBody, { color: subText }]}>
            Choose how to delete. The deleted-chats password will be reset
            after this action.
          </Text>

          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => performDelete('me')}
            style={[styles.scopeRow, { borderColor: borderClr }]}
          >
            <View style={[styles.scopeIcon, { backgroundColor: themeColor + '1A' }]}>
              <Ionicons name="person-outline" size={20} color={themeColor} />
            </View>
            <View style={styles.flex}>
              <Text style={[styles.scopeLabel, { color: primaryText }]}>Delete for me</Text>
              <Text style={[styles.scopeDesc, { color: subText }]}>
                Removes these chats from your device only.
              </Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => performDelete('everyone')}
            style={[styles.scopeRow, { borderColor: borderClr }]}
          >
            <View style={[styles.scopeIcon, { backgroundColor: '#E5393520' }]}>
              <Ionicons name="people-outline" size={20} color="#E53935" />
            </View>
            <View style={styles.flex}>
              <Text style={[styles.scopeLabel, { color: '#E53935' }]}>Delete for everyone</Text>
              <Text style={[styles.scopeDesc, { color: subText }]}>
                Removes these chats for you and the other participants.
              </Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => setScopeModal(false)}
            style={styles.cancelBtn}
          >
            <Text style={[styles.cancelText, { color: subText }]}>Cancel</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );

  const renderProgress = () => (
    <Modal visible={deleting} transparent animationType="fade">
      <View style={styles.progressBackdrop}>
        <View style={[styles.progressCard, { backgroundColor: cardBg }]}>
          <ActivityIndicator size="large" color={themeColor} />
          <Text style={[styles.progressText, { color: primaryText }]}>
            {progressLabel || 'Working…'}
          </Text>
        </View>
      </View>
    </Modal>
  );

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { backgroundColor: pageBg }]}>
        <ActivityIndicator size="large" color={themeColor} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: pageBg }]}>
      {renderHeader()}
      {chats.length === 0 ? renderEmpty() : (
        <FlatList
          data={chats}
          keyExtractor={(item) => normalizeId(item.chatId || item._id)}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: selectedCount > 0 ? 96 : 24 }}
          showsVerticalScrollIndicator={false}
        />
      )}
      {renderActionBar()}
      {renderScopeModal()}
      {renderProgress()}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: {
    fontFamily: 'Roboto-Bold',
    fontSize: 17,
    letterSpacing: -0.2,
  },
  headerSub: {
    fontFamily: 'Roboto-Regular',
    fontSize: 11,
    marginTop: 1,
  },
  selectAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    height: 32,
    borderRadius: 10,
  },
  selectAllText: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 12,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  checkbox: {
    width: 22, height: 22, borderRadius: 6,
    borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  avatar: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImg: { width: 44, height: 44, borderRadius: 22 },
  avatarText: {
    color: '#fff',
    fontFamily: 'Roboto-Bold',
    fontSize: 15,
  },
  rowText: { flex: 1 },
  rowName: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 15,
    textTransform: 'capitalize',
  },
  rowSub: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 2,
  },

  // Empty
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 14,
  },
  emptyIcon: {
    width: 72, height: 72, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
  },
  emptyTitle: {
    fontFamily: 'Roboto-Bold',
    fontSize: 18,
    textAlign: 'center',
  },
  emptyBody: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  emptyBtn: {
    paddingHorizontal: 20,
    height: 46,
    borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    marginTop: 6,
  },
  emptyBtnText: {
    color: '#fff',
    fontFamily: 'Roboto-SemiBold',
    fontSize: 14,
  },

  // Action bar
  actionBar: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  actionCount: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 14,
  },
  actionHint: {
    fontFamily: 'Roboto-Regular',
    fontSize: 11,
    marginTop: 2,
  },
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 18,
    height: 44,
    borderRadius: 12,
  },
  deleteBtnText: {
    color: '#fff',
    fontFamily: 'Roboto-SemiBold',
    fontSize: 14,
  },

  // Scope modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    padding: 20,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  modalTitle: {
    fontFamily: 'Roboto-Bold',
    fontSize: 17,
    marginBottom: 6,
  },
  modalBody: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 16,
  },
  scopeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 10,
  },
  scopeIcon: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  scopeLabel: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 14,
  },
  scopeDesc: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 2,
  },
  cancelBtn: {
    alignItems: 'center',
    paddingVertical: 14,
    marginTop: 4,
  },
  cancelText: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 14,
  },

  // Progress
  progressBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'center',
  },
  progressCard: {
    minWidth: 220,
    paddingHorizontal: 24,
    paddingVertical: 24,
    borderRadius: 18,
    alignItems: 'center',
    gap: 12,
  },
  progressText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
  },
});
