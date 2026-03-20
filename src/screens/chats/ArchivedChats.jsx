import React, { useCallback, useMemo, useState, useRef } from 'react';
import { Alert, Animated, FlatList, Image, Modal, Platform, StyleSheet, Text, TouchableOpacity, View, ActivityIndicator } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
// import { ImageZoom } from '@likashefqet/react-native-image-zoom';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useTheme } from '../../contexts/ThemeContext';
import { useRealtimeChat } from '../../contexts/RealtimeChatContext';
import ChatCard from '../../components/ChatCard';
import { apiCall } from '../../Config/Https';
import { normalizeChatStorageId, removeMessagesByChatId } from '../../utils/chatClearStorage';

const MUTE_OPTIONS = [
  { key: '8h', label: '8 hours', icon: 'clock-time-eight-outline', duration: 8 * 60 * 60 * 1000 },
  { key: '1w', label: '1 week', icon: 'calendar-week', duration: 7 * 24 * 60 * 60 * 1000 },
  { key: 'always', label: 'Always', icon: 'bell-off-outline', duration: 0 },
];

export default function ArchivedChats({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const {
    archivedChatList,
    requestChatInfo,
    pinChat,
    unpinChat,
    muteChat,
    unmuteChat,
    archiveChat,
    unarchiveChat,
    applyChatClearedPreview,
  } = useRealtimeChat();

  const [selectedChatItem, setSelectedChatItem] = useState(null);
  const [actionSheetVisible, setActionSheetVisible] = useState(false);
  const [muteSheetVisible, setMuteSheetVisible] = useState(false);
  const [profilePreviewVisible, setProfilePreviewVisible] = useState(false);
  const [imageViewerVisible, setImageViewerVisible] = useState(false);
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [deleteForEveryone, setDeleteForEveryone] = useState(false);
  const [isDeletingChat, setIsDeletingChat] = useState(false);

  // Animations
  const profileOpacityAnim = useRef(new Animated.Value(0)).current;
  const profileScaleAnim = useRef(new Animated.Value(0)).current;
  const sheetSlideAnim = useRef(new Animated.Value(300)).current;
  const sheetBgAnim = useRef(new Animated.Value(0)).current;

  const getUserColor = (str) => {
    const colors = ['#833AB4', '#1DB954', '#128C7E', '#075E54', '#777737', '#F56040', '#34B7F1', '#25D366'];
    if (!str) return colors[0];
    let hash = 0;
    for (let i = 0; i < (str || '').length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  };

  const getPreviewText = (text, maxLength = 20) => {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return `${text.substring(0, maxLength)}... `;
  };

  const getRelativeTime = (value) => {
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
  };

  const getLastMessageText = (item) => item?.lastMessageDisplay?.fullText || item?.lastMessageDisplay?.text || 'No messages yet';

  const getLastMessageStatus = (item) => (
    item?.lastMessageStatus || item?.lastMessage?.status || item?.status || null
  );

  const renderMessageStatus = (item) => {
    const status = (getLastMessageStatus(item) || '').toLowerCase();
    if (!status) return null;
    if (status === 'read' || status === 'seen') {
      return <View style={{ flexDirection: 'row', marginRight: 4 }}><Ionicons name="checkmark-done" size={12} color="#34B7F1" /></View>;
    }
    if (status === 'delivered') {
      return <View style={{ flexDirection: 'row', marginRight: 4 }}><Ionicons name="checkmark-done" size={12} color={theme.colors.placeHolderTextColor} /></View>;
    }
    if (status === 'sent') {
      return <Ionicons name="checkmark" size={12} color={theme.colors.placeHolderTextColor} style={{ marginRight: 4 }} />;
    }
    return null;
  };

  // ─── ACTION SHEET (animated) ───

  const openActionMenu = useCallback((item) => {
    setSelectedChatItem(item);
    setActionSheetVisible(true);
    sheetSlideAnim.setValue(300);
    sheetBgAnim.setValue(0);
    Animated.parallel([
      Animated.spring(sheetSlideAnim, {
        toValue: 0,
        tension: 65,
        friction: 11,
        useNativeDriver: true,
      }),
      Animated.timing(sheetBgAnim, {
        toValue: 1,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start();
  }, [sheetSlideAnim, sheetBgAnim]);

  const closeActionMenu = useCallback(() => {
    Animated.parallel([
      Animated.timing(sheetSlideAnim, {
        toValue: 300,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(sheetBgAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setActionSheetVisible(false);
      setMuteSheetVisible(false);
      setSelectedChatItem(null);
    });
  }, [sheetSlideAnim, sheetBgAnim]);

  // ─── PROFILE PREVIEW ───

  const openProfilePreview = useCallback((item) => {
    setSelectedChatItem(item);
    setProfilePreviewVisible(true);
    profileScaleAnim.setValue(0);
    profileOpacityAnim.setValue(0);
    Animated.parallel([
      Animated.spring(profileScaleAnim, {
        toValue: 1,
        tension: 65,
        friction: 8,
        useNativeDriver: true,
      }),
      Animated.timing(profileOpacityAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start();
  }, [profileScaleAnim, profileOpacityAnim]);

  const closeProfilePreview = useCallback(() => {
    Animated.parallel([
      Animated.timing(profileScaleAnim, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }),
      Animated.timing(profileOpacityAnim, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setProfilePreviewVisible(false);
      setSelectedChatItem(null);
    });
  }, [profileScaleAnim, profileOpacityAnim]);

  // ─── ACTIONS ───

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
    const chatId = selectedChatItem?.chatId || selectedChatItem?._id;
    if (!chatId) return;
    const ct = selectedChatItem?.chatType || 'private';
    muteChat(chatId, duration, ct);
    closeActionMenu();
  }, [selectedChatItem, muteChat, closeActionMenu]);

  const onToggleArchive = useCallback(() => {
    const chatId = selectedChatItem?.chatId || selectedChatItem?._id;
    if (!chatId) return;
    const ct = selectedChatItem?.chatType || 'private';
    if (selectedChatItem?.isArchived) unarchiveChat(chatId, ct);
    else archiveChat(chatId, ct);
    closeActionMenu();
  }, [selectedChatItem, archiveChat, unarchiveChat, closeActionMenu]);

  const onViewInfo = useCallback(() => {
    const chatId = selectedChatItem?.chatId || selectedChatItem?._id;
    if (!chatId) return;
    requestChatInfo(chatId);
    navigation.navigate('UserB', { item: selectedChatItem });
    closeActionMenu();
  }, [selectedChatItem, navigation, requestChatInfo, closeActionMenu]);

  const onDeleteChat = useCallback(() => {
    setDeleteForEveryone(false);
    setDeleteModalVisible(true);
    setActionSheetVisible(false);
  }, []);

  const closeDeleteModal = useCallback(() => {
    setDeleteModalVisible(false);
    setDeleteForEveryone(false);
    setSelectedChatItem(null);
  }, []);

  const onConfirmDeleteChat = useCallback(async () => {
    const chatId = selectedChatItem?.chatId || selectedChatItem?._id;
    if (!chatId || isDeletingChat) return;
    setIsDeletingChat(true);
    try {
      const scope = deleteForEveryone ? 'everyone' : 'me';
      const response = await apiCall(`/chats/${normalizeChatStorageId(chatId)}/clear`, 'DELETE', { scope });
      if (!response || response.error) throw new Error(response?.message || 'Failed');
      await removeMessagesByChatId(chatId);
      applyChatClearedPreview(chatId, scope);
      setDeleteModalVisible(false);
      setDeleteForEveryone(false);
      setSelectedChatItem(null);
    } catch (error) {
      console.error('Chat delete failed', error);
      Alert.alert('Delete Chat', 'Could not delete this chat right now. Please try again.');
    } finally {
      setIsDeletingChat(false);
    }
  }, [selectedChatItem, isDeletingChat, deleteForEveryone, applyChatClearedPreview]);

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

    return opts;
  }, [selectedChatItem, onTogglePin, onPressMute, onToggleArchive, onViewInfo]);

  // ─── PREVIEW DATA ───

  const previewName = selectedChatItem?.peerUser?.fullName || 'Unknown User';
  const previewImage = selectedChatItem?.peerUser?.profileImage;
  const previewAvatarColor = getUserColor(previewName);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBackBtn}>
          <Ionicons name="arrow-back" size={22} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.primaryTextColor }]}>
          Archived Chats
        </Text>
      </View>

      {!Array.isArray(archivedChatList) || archivedChatList.length === 0 ? (
        <View style={styles.emptyWrap}>
          <View style={[styles.emptyIconCircle, { backgroundColor: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]}>
            <MaterialCommunityIcons name="archive-outline" size={36} color={theme.colors.placeHolderTextColor} />
          </View>
          <Text style={[styles.emptyTitle, { color: theme.colors.primaryTextColor }]}>No archived chats</Text>
          <Text style={[styles.emptySubtitle, { color: theme.colors.placeHolderTextColor }]}>
            Chats you archive will appear here
          </Text>
        </View>
      ) : (
        <FlatList
          data={archivedChatList}
          keyExtractor={(item) => String(item?.chatId || item?._id)}
          renderItem={({ item }) => (
            <ChatCard
              item={item}
              theme={theme}
              onPress={() => navigation.navigate('ChatScreen', { item })}
              onLongPress={() => openActionMenu(item)}
              onAvatarPress={() => openProfilePreview(item)}
              onSwipePin={() => { const ct = item?.chatType || 'private'; item?.isPinned ? unpinChat(item?.chatId || item?._id, ct) : pinChat(item?.chatId || item?._id, ct); }}
              onSwipeMute={() => { const ct = item?.chatType || 'private'; item?.isMuted ? unmuteChat(item?.chatId || item?._id, ct) : muteChat(item?.chatId || item?._id, 8 * 60 * 60 * 1000, ct); }}
              onSwipeArchive={() => unarchiveChat(item?.chatId || item?._id, item?.chatType || 'private')}
              getUserColor={getUserColor}
              getPreviewText={getPreviewText}
              getRelativeTime={getRelativeTime}
              getLastMessageText={getLastMessageText}
              renderMessageStatus={renderMessageStatus}
            />
          )}
          removeClippedSubviews
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 30 }}
          ItemSeparatorComponent={() => (
            <View style={{ marginLeft: 82, marginRight: 16 }}>
              <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }} />
            </View>
          )}
        />
      )}

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

            {selectedChatItem && (
              <View style={styles.sheetUserRow}>
                {selectedChatItem?.peerUser?.profileImage ? (
                  <Image source={{ uri: selectedChatItem.peerUser.profileImage }} style={styles.sheetUserAvatar} />
                ) : (
                  <View style={[styles.sheetUserAvatar, { backgroundColor: getUserColor(selectedChatItem?.peerUser?.fullName || '') }]}>
                    <Text style={styles.sheetUserInitial}>
                      {(selectedChatItem?.peerUser?.fullName || '?').charAt(0).toUpperCase()}
                    </Text>
                  </View>
                )}
                <Text style={[styles.sheetUserName, { color: theme.colors.primaryTextColor }]} numberOfLines={1}>
                  {selectedChatItem?.peerUser?.fullName || 'Unknown'}
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

      {/* ─── PROFILE PREVIEW MODAL ─── */}
      <Modal transparent visible={profilePreviewVisible} onRequestClose={closeProfilePreview} statusBarTranslucent>
        <TouchableOpacity onPress={closeProfilePreview} activeOpacity={1} style={styles.profileOverlay}>
          <Animated.View style={[
            styles.profileCard,
            {
              backgroundColor: theme.colors.cardBackground,
              opacity: profileOpacityAnim,
              transform: [{ scale: profileScaleAnim }],
            }
          ]}>
            <TouchableOpacity
              activeOpacity={0.9}
              onPress={() => {
                setProfilePreviewVisible(false);
                setTimeout(() => setImageViewerVisible(true), 200);
              }}
              style={[styles.profileImageWrap, { backgroundColor: isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)' }]}
            >
              {previewImage ? (
                <Image resizeMode="cover" source={{ uri: previewImage }} style={StyleSheet.absoluteFill} />
              ) : (
                <View style={[styles.profileFallback, { backgroundColor: previewAvatarColor }]}>
                  <Text style={styles.profileFallbackText}>
                    {(previewName || '?').charAt(0).toUpperCase()}
                  </Text>
                </View>
              )}

              <View style={styles.profileNameOverlay}>
                <Text style={styles.profileNameText} numberOfLines={1}>{previewName}</Text>
              </View>

              <View style={styles.profileActions}>
                <TouchableOpacity
                  onPress={() => {
                    if (selectedChatItem) navigation.navigate('ChatScreen', { item: selectedChatItem });
                    closeProfilePreview();
                  }}
                  activeOpacity={0.8}
                  style={styles.profileActionBtn}
                >
                  <Ionicons name="chatbubble-outline" size={20} color="#fff" />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => {
                    if (selectedChatItem) navigation.navigate('UserB', { item: selectedChatItem });
                    closeProfilePreview();
                  }}
                  activeOpacity={0.8}
                  style={styles.profileActionBtn}
                >
                  <Ionicons name="information-circle-outline" size={21} color="#fff" />
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          </Animated.View>
        </TouchableOpacity>
      </Modal>

      {/* ─── IMAGE VIEWER ─── */}
      <Modal
        visible={imageViewerVisible}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setImageViewerVisible(false)}
      >
        <View style={styles.imageViewerContainer}>
          <View style={styles.imageViewerTopBar}>
            <TouchableOpacity
              onPress={() => setImageViewerVisible(false)}
              style={styles.imageViewerBackBtn}
              activeOpacity={0.7}
            >
              <Ionicons name="arrow-back" size={24} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.imageViewerName} numberOfLines={1}>{previewName}</Text>
          </View>

          {previewImage ? (
            <GestureHandlerRootView style={{ flex: 1 }}>
              {/* <ImageZoom
                uri={previewImage}
                minScale={1}
                maxScale={5}
                doubleTapScale={3}
                style={{ flex: 1 }}
                resizeMode="contain"
              /> */}
            </GestureHandlerRootView>
          ) : (
            <View style={styles.imageViewerNoPhoto}>
              <View style={[styles.imageViewerFallbackCircle, { backgroundColor: previewAvatarColor }]}>
                <Text style={styles.imageViewerFallbackLetter}>
                  {(previewName || '?').charAt(0).toUpperCase()}
                </Text>
              </View>
              <Text style={styles.imageViewerNoPhotoText}>No profile photo</Text>
            </View>
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 10,
  },
  headerBackBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 20,
    fontFamily: 'Roboto-SemiBold',
  },

  // ─── EMPTY STATE ───
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  emptyIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  emptyTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 17,
    marginBottom: 6,
  },
  emptySubtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
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
  profileOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 24,
  },
  profileCard: {
    width: '74%',
    borderRadius: 18,
    overflow: 'hidden',
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 14,
  },
  profileImageWrap: {
    width: '100%',
    height: 280,
  },
  profileFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileFallbackText: {
    color: '#fff',
    fontFamily: 'Roboto-SemiBold',
    fontSize: 72,
    textTransform: 'uppercase',
  },
  profileNameOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  profileNameText: {
    color: '#fff',
    fontFamily: 'Roboto-SemiBold',
    fontSize: 17,
    textTransform: 'capitalize',
  },
  profileActions: {
    position: 'absolute',
    top: 12,
    right: 12,
    flexDirection: 'column',
    gap: 8,
  },
  profileActionBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.3)',
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
});