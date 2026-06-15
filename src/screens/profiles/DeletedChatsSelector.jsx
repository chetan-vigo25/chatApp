import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, Image,
  ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons, FontAwesome6 } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import ChatDatabase from '../../services/ChatDatabase';
import { updateUserSettings } from '../../Redux/Services/Profile/Settings.Services';
import { getDeletedChatConfig, saveDeletedChatConfig, markDeletedPasswordSet } from '../../utils/deletedChatConfig';

const AVATAR_COLORS = ['#6C5CE7', '#00B894', '#E17055', '#0984E3', '#E84393'];

const getInitials = (name) => {
  if (!name) return '?';
  return String(name).trim().split(' ').map((p) => p.charAt(0).toUpperCase()).join('').slice(0, 2);
};

const normalizeId = (id) => (id == null ? '' : String(id));

// Setup screen for the "deleted chats password" automation.
//
// The user picks which chats to auto-delete and the delete type
// ("me" | "everyone"), then saves. If a plaintext `password` was passed in
// (from the password setup screen) it is persisted here too, so the password
// and its armed selection are committed together. Nothing is deleted on this
// screen — the purge runs later, at the login gate, when the matching
// password is entered.
export default function DeletedChatsSelector({ navigation, route }) {
  const { theme, isDarkMode } = useTheme();
  const password = route?.params?.password || null;

  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [scope, setScope] = useState('me');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [rows, existing] = await Promise.all([
          ChatDatabase.loadChatList({ includeArchived: true }),
          getDeletedChatConfig(),
        ]);
        setChats(rows || []);
        if (existing) {
          setScope(existing.scope || 'me');
          // Only pre-select chats that still exist on this device.
          const available = new Set((rows || []).map((c) => normalizeId(c.chatId || c._id)));
          setSelectedIds(new Set(existing.chatIds.filter((id) => available.has(id))));
        }
      } catch (e) {
        console.warn('[DeletedChatsSelector] load failed', e);
        setChats([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const themeColor = theme.colors.themeColor;
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const pageBg = theme.colors.background;
  const cardBg = theme.colors.background;
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

  const handleSave = useCallback(async () => {
    if (saving) return;
    const ids = Array.from(selectedIds).filter(Boolean);
    if (ids.length === 0) {
      Alert.alert('No chats selected', 'Pick at least one chat to protect with the password.');
      return;
    }
    setSaving(true);
    try {
      // Commit the password (if we arrived here from the password setup screen)
      // and the armed selection together, so the lock is never half-configured.
      if (password) {
        await updateUserSettings({ chat: { deletedPassword: password } });
      }
      await saveDeletedChatConfig({ scope, chatIds: ids });
      // Mirror the "deleted password is set" flag so the app-lock overlay arms
      // on the next launch even without 2-step enabled.
      await markDeletedPasswordSet(true);
      Alert.alert(
        password ? 'Password armed' : 'Selection updated',
        `${ids.length} chat${ids.length === 1 ? '' : 's'} will be deleted (${scope === 'everyone' ? 'for everyone' : 'for me'}) when the password is entered at login.`,
        [{ text: 'Done', onPress: () => navigation.goBack() }]
      );
    } catch (e) {
      // Surface the server's message (e.g. "This password is already in use as
      // your 2-step password.") instead of a generic retry prompt — the error is
      // an object { statusCode, message, data }, not a plain string.
      const msg = typeof e === 'string'
        ? e
        : (e?.message || e?.data?.message || 'Please try again.');
      Alert.alert('Could not save', msg);
    } finally {
      setSaving(false);
    }
  }, [saving, selectedIds, scope, password, navigation]);

  // ─── Renderers ───
  const renderHeader = () => (
    <View style={[styles.header, { borderBottomColor: borderClr }]}>
      <TouchableOpacity
        onPress={() => navigation.goBack()}
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
          Auto-deleted when the password is entered
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
          All
        </Text>
      </TouchableOpacity>
    </View>
  );

  const renderItem = ({ item }) => {
    const id = normalizeId(item.chatId || item._id);
    const selected = selectedIds.has(id);
    // Resolve name + avatar the same way ChatCard does — loadChatList exposes
    // these as chatName / chatAvatar / peerUser / group, not profileImage.
    const isGroup = item.isGroup || item.chatType === 'group';
    const name = (isGroup
      ? (item.chatName || item.group?.name || item.groupName)
      : (item.peerUser?.fullName || item.chatName))
      || item.name || 'Chat';
    const image = (isGroup
      ? (item.chatAvatar || item.group?.avatar || item.groupAvatar)
      : (item.peerUser?.profileImage || item.chatAvatar))
      || item.profileImage || item.avatar || '';
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
          {image ? (
            <Image source={{ uri: image }} style={styles.avatarImg} />
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
        There's nothing to select yet. Start a chat first, then come back to
        arm the password.
      </Text>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => navigation.goBack()}
        style={[styles.emptyBtn, { backgroundColor: themeColor }]}
      >
        <Text style={styles.emptyBtnText}>Go back</Text>
      </TouchableOpacity>
    </View>
  );

  // Inline delete-type picker + Save — replaces the old "delete now" modal.
  const renderActionBar = () => {
    if (chats.length === 0) return null;
    const ScopeOption = ({ value, icon, label, danger }) => {
      const active = scope === value;
      const tint = danger ? '#E53935' : themeColor;
      return (
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={() => setScope(value)}
          style={[styles.scopeOption, {
            borderColor: active ? tint : borderClr,
            backgroundColor: active ? tint + '14' : 'transparent',
          }]}
        >
          <Ionicons name={icon} size={18} color={active ? tint : subText} />
          <Text style={[styles.scopeOptionText, { color: active ? tint : subText }]}>{label}</Text>
          {active && <Ionicons name="checkmark-circle" size={16} color={tint} style={styles.scopeCheck} />}
        </TouchableOpacity>
      );
    };

    return (
      <View style={[styles.actionBar, { backgroundColor: cardBg, borderTopColor: borderClr }]}>
        <Text style={[styles.scopeHeading, { color: subText }]}>DELETE TYPE</Text>
        <View style={styles.scopeRowWrap}>
          <ScopeOption value="me" icon="person-outline" label="For me" />
          <ScopeOption value="everyone" icon="people-outline" label="For everyone" danger />
        </View>
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={handleSave}
          disabled={saving || selectedCount === 0}
          style={[styles.saveBtn, {
            backgroundColor: themeColor,
            opacity: (saving || selectedCount === 0) ? 0.5 : 1,
          }]}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Ionicons name="lock-closed" size={18} color="#fff" />
              <Text style={styles.saveBtnText}>
                {password ? 'Set password & arm' : 'Save selection'}
                {selectedCount > 0 ? ` (${selectedCount})` : ''}
              </Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    );
  };

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
          contentContainerStyle={{ paddingBottom: 200 }}
          showsVerticalScrollIndicator={false}
        />
      )}
      {renderActionBar()}
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
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  scopeHeading: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 11,
    letterSpacing: 1,
    marginBottom: 8,
    marginLeft: 2,
  },
  scopeRowWrap: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  scopeOption: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 46,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1.5,
  },
  scopeOptionText: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 13,
  },
  scopeCheck: {
    marginLeft: 'auto',
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 50,
    borderRadius: 14,
  },
  saveBtnText: {
    color: '#fff',
    fontFamily: 'Roboto-SemiBold',
    fontSize: 15,
  },
});
