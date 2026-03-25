import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, Modal, TouchableOpacity, FlatList, Image,
  ScrollView, StyleSheet, Dimensions, ActivityIndicator,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';

const { height: SCREEN_H } = Dimensions.get('window');

const ReactorRow = React.memo(({
  userId, username, avatar, emoji, isMe, isDarkMode, themeColor, primaryTextColor, placeholderColor, onRemove,
}) => (
  <TouchableOpacity
    activeOpacity={isMe ? 0.6 : 1}
    onPress={() => {
      if (isMe) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onRemove?.();
      }
    }}
    style={[styles.reactorRow, { borderBottomColor: isDarkMode ? '#1A2A34' : '#F0F0F0' }]}
  >
    <View style={[styles.avatar, { backgroundColor: isDarkMode ? '#2A3A44' : '#E8E8E8' }]}>
      {avatar ? (
        <Image source={{ uri: avatar }} style={styles.avatarImg} />
      ) : (
        <Ionicons name="person" size={18} color={isDarkMode ? '#6A7A84' : '#ADADAD'} />
      )}
    </View>
    <View style={styles.nameCol}>
      <Text style={[styles.nameText, { color: primaryTextColor }]}>
        {isMe ? 'You' : (username || 'User')}
      </Text>
      {isMe && (
        <Text style={[styles.tapRemove, { color: placeholderColor }]}>Tap to remove</Text>
      )}
    </View>
    <Text style={styles.rowEmoji}>{emoji}</Text>
  </TouchableOpacity>
));

const ReactionDetailSheet = React.memo(({
  visible,
  reactions,
  selectedEmoji: initialEmoji,
  onClose,
  onRemoveReaction,
  currentUserId,
  isDarkMode,
  themeColor,
  primaryTextColor,
  placeholderColor,
  getReactionUserName,
  groupMembersMap,
  peerUser,
  fetchReactionList,
  messageId,
}) => {
  const [selectedEmoji, setSelectedEmoji] = useState(initialEmoji || 'all');
  const [serverReactors, setServerReactors] = useState(null);
  const [loading, setLoading] = useState(false);

  // Reset tab when modal opens
  useEffect(() => {
    if (visible) {
      setSelectedEmoji(initialEmoji || 'all');
      setServerReactors(null);
      // Try to fetch detailed reactor info from server
      if (fetchReactionList && messageId) {
        setLoading(true);
        fetchReactionList(messageId)
          .then((res) => {
            if (res?.reactions) setServerReactors(res.reactions);
          })
          .catch(() => {}) // fallback to local data
          .finally(() => setLoading(false));
      }
    }
  }, [visible, messageId]);

  const entries = useMemo(() => {
    if (!reactions) return [];
    return Object.entries(reactions).filter(([, d]) => d?.count > 0);
  }, [reactions]);

  // Build reactor list from server data or fall back to local
  const reactorList = useMemo(() => {
    if (selectedEmoji === 'all') {
      // Show all reactors
      if (serverReactors) {
        return serverReactors.map(r => ({
          userId: r.userId?._id || r.userId,
          username: r.userId?.username || r.userId?.fullName || getReactionUserName?.(r.userId?._id || r.userId) || 'User',
          avatar: r.userId?.avatar || r.userId?.profileImage || null,
          emoji: r.emoji,
        }));
      }
      // Fallback: local data
      const all = [];
      for (const [emoji, data] of entries) {
        for (const uid of (data.users || [])) {
          all.push({
            userId: uid,
            username: getReactionUserName?.(uid) || 'User',
            avatar: groupMembersMap?.[uid]?.profileImage || (peerUser?._id === uid ? peerUser?.profileImage : null),
            emoji,
          });
        }
      }
      return all;
    }

    // Specific emoji tab
    if (serverReactors) {
      return serverReactors
        .filter(r => r.emoji === selectedEmoji)
        .map(r => ({
          userId: r.userId?._id || r.userId,
          username: r.userId?.username || r.userId?.fullName || getReactionUserName?.(r.userId?._id || r.userId) || 'User',
          avatar: r.userId?.avatar || r.userId?.profileImage || null,
          emoji: r.emoji,
        }));
    }

    const data = reactions?.[selectedEmoji];
    if (!data?.users) return [];
    return data.users.map(uid => ({
      userId: uid,
      username: getReactionUserName?.(uid) || 'User',
      avatar: groupMembersMap?.[uid]?.profileImage || (peerUser?._id === uid ? peerUser?.profileImage : null),
      emoji: selectedEmoji,
    }));
  }, [selectedEmoji, entries, serverReactors, reactions, getReactionUserName, groupMembersMap, peerUser]);

  const totalCount = useMemo(() =>
    entries.reduce((sum, [, d]) => sum + (d.count || 0), 0),
  [entries]);

  const handleRemove = useCallback((emoji) => {
    onRemoveReaction?.(emoji);
  }, [onRemoveReaction]);

  const renderReactor = useCallback(({ item }) => (
    <ReactorRow
      userId={item.userId}
      username={item.username}
      avatar={item.avatar}
      emoji={item.emoji}
      isMe={item.userId === currentUserId}
      isDarkMode={isDarkMode}
      themeColor={themeColor}
      primaryTextColor={primaryTextColor}
      placeholderColor={placeholderColor}
      onRemove={() => handleRemove(item.emoji)}
    />
  ), [currentUserId, isDarkMode, themeColor, primaryTextColor, placeholderColor, handleRemove]);

  const keyExtractor = useCallback((item, idx) => `${item.userId}_${item.emoji}_${idx}`, []);

  if (!visible) return null;

  return (
    <Modal
      transparent
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
    >
      <TouchableOpacity
        activeOpacity={1}
        onPress={onClose}
        style={styles.overlay}
      >
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={[
          styles.sheet,
          { backgroundColor: isDarkMode ? '#1F2C34' : '#FFFFFF' },
        ]}>
          {/* Drag handle */}
          <View style={styles.dragHandle}>
            <View style={[styles.dragBar, { backgroundColor: isDarkMode ? '#3A4A54' : '#D0D0D0' }]} />
          </View>

          {/* Emoji tabs */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[styles.tabBar, { borderBottomColor: isDarkMode ? '#2A3A44' : '#E0E0E0' }]}
            contentContainerStyle={styles.tabContent}
          >
            {/* All tab */}
            <TouchableOpacity
              onPress={() => setSelectedEmoji('all')}
              style={[styles.tab, selectedEmoji === 'all' && { borderBottomColor: themeColor || '#03b0a2' }]}
            >
              <Text style={[
                styles.tabText,
                { color: selectedEmoji === 'all' ? (themeColor || '#03b0a2') : (placeholderColor || '#999') },
              ]}>All {totalCount}</Text>
            </TouchableOpacity>
            {entries.map(([emoji, data]) => {
              const isSelected = selectedEmoji === emoji;
              return (
                <TouchableOpacity
                  key={emoji}
                  onPress={() => setSelectedEmoji(emoji)}
                  style={[styles.tab, isSelected && { borderBottomColor: themeColor || '#03b0a2' }]}
                >
                  <Text style={styles.tabEmoji}>{emoji}</Text>
                  <Text style={[
                    styles.tabCount,
                    { color: isSelected ? (themeColor || '#03b0a2') : (placeholderColor || '#999') },
                  ]}>{data.count}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* Reactor list */}
          {loading ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator size="small" color={themeColor || '#03b0a2'} />
            </View>
          ) : (
            <FlatList
              data={reactorList}
              renderItem={renderReactor}
              keyExtractor={keyExtractor}
              style={styles.list}
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}
            />
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
});

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: SCREEN_H * 0.55,
    paddingBottom: 24,
  },
  dragHandle: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 6,
  },
  dragBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
  },
  tabBar: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tabContent: {
    paddingHorizontal: 12,
    gap: 4,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabText: {
    fontSize: 14,
    fontFamily: 'Roboto-Medium',
  },
  tabEmoji: {
    fontSize: 20,
  },
  tabCount: {
    fontSize: 13,
    marginLeft: 4,
    fontFamily: 'Roboto-Medium',
  },
  loadingWrap: {
    padding: 30,
    alignItems: 'center',
  },
  list: {
    paddingHorizontal: 16,
  },
  listContent: {
    paddingTop: 8,
    paddingBottom: 16,
  },
  reactorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    overflow: 'hidden',
  },
  avatarImg: {
    width: 38,
    height: 38,
    borderRadius: 19,
  },
  nameCol: {
    flex: 1,
  },
  nameText: {
    fontSize: 15,
    fontFamily: 'Roboto-Medium',
  },
  tapRemove: {
    fontSize: 12,
    marginTop: 1,
  },
  rowEmoji: {
    fontSize: 22,
  },
});

ReactorRow.displayName = 'ReactorRow';
ReactionDetailSheet.displayName = 'ReactionDetailSheet';
export default ReactionDetailSheet;
