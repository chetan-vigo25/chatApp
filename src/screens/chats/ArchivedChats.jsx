import React, { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, Image, Modal, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useTheme } from '../../contexts/ThemeContext';
import { useRealtimeChat } from '../../contexts/RealtimeChatContext';
import ChatCard from '../../components/ChatCard';

const MUTE_OPTIONS = [
  { key: '8h', label: '8 hours', duration: 8 * 60 * 60 * 1000 },
  { key: '1w', label: '1 week', duration: 7 * 24 * 60 * 60 * 1000 },
  { key: 'always', label: 'Always', duration: 0 },
];

export default function ArchivedChats({ navigation }) {
  const { theme } = useTheme();
  const {
    archivedChatList,
    requestChatInfo,
    pinChat,
    unpinChat,
    muteChat,
    unmuteChat,
    archiveChat,
    unarchiveChat,
  } = useRealtimeChat();

  const [selectedChatItem, setSelectedChatItem] = useState(null);
  const [actionSheetVisible, setActionSheetVisible] = useState(false);
  const [muteSheetVisible, setMuteSheetVisible] = useState(false);
  const [profilePreviewVisible, setProfilePreviewVisible] = useState(false);

  const getPreviewText = (text, maxLength = 20) => {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return `${text.substring(0, maxLength)}... `;
  };

  const getRelativeTime = (value) => {
    const ts = value ? new Date(value).getTime() : 0;
    if (!ts) return '';
    const diffMs = Date.now() - ts;
    if (diffMs < 60000) return 'Just now';
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 60) return `${diffMin}m`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h`;
    return new Date(ts).toLocaleDateString(undefined, { weekday: 'short' });
  };

  const getLastMessageText = (item) => item?.lastMessageDisplay?.fullText || item?.lastMessageDisplay?.text || 'No messages yet';

  const getLastMessageStatus = (item) => (
    item?.lastMessageStatus || item?.lastMessage?.status || item?.status || null
  );

  const renderMessageStatus = (item) => {
    const status = (getLastMessageStatus(item) || '').toLowerCase();
    if (!status) return null;

    if (status === 'read' || status === 'seen') {
      return (
        <View style={{ flexDirection: 'row', marginRight: 4 }}>
          <Ionicons name="checkmark-done" size={12} color="#34B7F1" />
        </View>
      );
    }

    if (status === 'delivered') {
      return (
        <View style={{ flexDirection: 'row', marginRight: 4 }}>
          <Ionicons name="checkmark-done" size={12} color={theme.colors.placeHolderTextColor} />
        </View>
      );
    }

    if (status === 'sent') {
      return <Ionicons name="checkmark" size={12} color={theme.colors.placeHolderTextColor} style={{ marginRight: 4 }} />;
    }

    return null;
  };

  const getUserColor = (str) => {
    const colors = ['#833AB4', '#1DB954', '#128C7E', '#075E54', '#777737', '#F56040', '#34B7F1'];
    let hash = 0;
    for (let i = 0; i < (str || '').length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  };

  const closeActionMenu = useCallback(() => {
    setActionSheetVisible(false);
    setMuteSheetVisible(false);
    setSelectedChatItem(null);
  }, []);

  const openActionMenu = useCallback((item) => {
    setSelectedChatItem(item);
    setActionSheetVisible(true);
  }, []);

  const openProfilePreview = useCallback((item) => {
    setSelectedChatItem(item);
    setProfilePreviewVisible(true);
  }, []);

  const closeProfilePreview = useCallback(() => {
    setProfilePreviewVisible(false);
    setSelectedChatItem(null);
  }, []);

  const onTogglePin = useCallback(() => {
    const chatId = selectedChatItem?.chatId || selectedChatItem?._id;
    if (!chatId) return;
    if (selectedChatItem?.isPinned) unpinChat(chatId);
    else pinChat(chatId);
    closeActionMenu();
  }, [selectedChatItem, pinChat, unpinChat, closeActionMenu]);

  const onPressMute = useCallback(() => {
    const chatId = selectedChatItem?.chatId || selectedChatItem?._id;
    if (!chatId) return;
    if (selectedChatItem?.isMuted) {
      unmuteChat(chatId);
      closeActionMenu();
      return;
    }
    setMuteSheetVisible(true);
  }, [selectedChatItem, unmuteChat, closeActionMenu]);

  const onSelectMuteDuration = useCallback((duration) => {
    const chatId = selectedChatItem?.chatId || selectedChatItem?._id;
    if (!chatId) return;
    muteChat(chatId, duration);
    closeActionMenu();
  }, [selectedChatItem, muteChat, closeActionMenu]);

  const onToggleArchive = useCallback(() => {
    const chatId = selectedChatItem?.chatId || selectedChatItem?._id;
    if (!chatId) return;
    if (selectedChatItem?.isArchived) unarchiveChat(chatId);
    else archiveChat(chatId);
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
    Alert.alert('Delete Chat', 'Delete chat endpoint is not connected yet in this client build.');
    closeActionMenu();
  }, [closeActionMenu]);

  const emptyState = useMemo(() => {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: theme.colors.placeHolderTextColor, fontSize: 15 }}>No archived chats</Text>
      </View>
    );
  }, [theme.colors.placeHolderTextColor]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingHorizontal: 10, paddingTop: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="arrow-back" size={22} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
        <Text style={{ color: theme.colors.primaryTextColor, fontSize: 20, fontFamily: 'Poppins-SemiBold' }}>
          Archived Chats
        </Text>
      </View>

      {!Array.isArray(archivedChatList) || archivedChatList.length === 0 ? (
        emptyState
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
              onSwipePin={() => (item?.isPinned ? unpinChat(item?.chatId || item?._id) : pinChat(item?.chatId || item?._id))}
              onSwipeMute={() => (item?.isMuted ? unmuteChat(item?.chatId || item?._id) : muteChat(item?.chatId || item?._id, 8 * 60 * 60 * 1000))}
              onSwipeArchive={() => unarchiveChat(item?.chatId || item?._id)}
              getUserColor={getUserColor}
              getPreviewText={getPreviewText}
              getRelativeTime={getRelativeTime}
              getLastMessageText={getLastMessageText}
              renderMessageStatus={renderMessageStatus}
            />
          )}
          removeClippedSubviews
          showsVerticalScrollIndicator={false}
        />
      )}

      <Modal animationType="fade" transparent visible={actionSheetVisible} onRequestClose={closeActionMenu}>
        <TouchableOpacity activeOpacity={1} onPress={closeActionMenu} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.34)', justifyContent: 'flex-end' }}>
          <TouchableOpacity activeOpacity={1} style={{ backgroundColor: theme.colors.cardBackground, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 24, borderTopLeftRadius: 20, borderTopRightRadius: 20 }}>
            <Text style={{ color: theme.colors.primaryTextColor, fontFamily: 'Poppins-SemiBold', fontSize: 16, marginBottom: 12 }}>
              Chat Options
            </Text>

            {selectedChatItem?.isArchived && (
              <TouchableOpacity onPress={onToggleArchive} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center' }}>
                <MaterialCommunityIcons name="archive-arrow-up-outline" size={20} color={theme.colors.primaryTextColor} />
                <Text style={{ marginLeft: 10, color: theme.colors.primaryTextColor }}>Unarchive Chat</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity onPress={onTogglePin} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center' }}>
              <MaterialCommunityIcons name={selectedChatItem?.isPinned ? 'pin-off-outline' : 'pin-outline'} size={20} color={theme.colors.primaryTextColor} />
              <Text style={{ marginLeft: 10, color: theme.colors.primaryTextColor }}>{selectedChatItem?.isPinned ? 'Unpin Chat' : 'Pin Chat'}</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={onPressMute} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center' }}>
              <MaterialCommunityIcons name={selectedChatItem?.isMuted ? 'volume-high' : 'volume-off'} size={20} color={theme.colors.primaryTextColor} />
              <Text style={{ marginLeft: 10, color: theme.colors.primaryTextColor }}>{selectedChatItem?.isMuted ? 'Unmute Chat' : 'Mute Chat'}</Text>
            </TouchableOpacity>

            {!selectedChatItem?.isArchived && (
              <TouchableOpacity onPress={onToggleArchive} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center' }}>
                <MaterialCommunityIcons name="archive-outline" size={20} color={theme.colors.primaryTextColor} />
                <Text style={{ marginLeft: 10, color: theme.colors.primaryTextColor }}>Archive Chat</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity onPress={onViewInfo} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center' }}>
              <MaterialCommunityIcons name="information-outline" size={20} color={theme.colors.primaryTextColor} />
              <Text style={{ marginLeft: 10, color: theme.colors.primaryTextColor }}>View Chat Info</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={onDeleteChat} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center' }}>
              <MaterialCommunityIcons name="delete-outline" size={20} color="#E06A6A" />
              <Text style={{ marginLeft: 10, color: '#E06A6A' }}>Delete Chat</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={closeActionMenu} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center' }}>
              <MaterialCommunityIcons name="close-circle-outline" size={20} color={theme.colors.placeHolderTextColor} />
              <Text style={{ marginLeft: 10, color: theme.colors.placeHolderTextColor }}>Cancel</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal animationType="fade" transparent visible={muteSheetVisible} onRequestClose={() => setMuteSheetVisible(false)}>
        <TouchableOpacity activeOpacity={1} onPress={() => setMuteSheetVisible(false)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.34)', justifyContent: 'flex-end' }}>
          <TouchableOpacity activeOpacity={1} style={{ backgroundColor: theme.colors.cardBackground, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 24, borderTopLeftRadius: 20, borderTopRightRadius: 20 }}>
            <Text style={{ color: theme.colors.primaryTextColor, fontFamily: 'Poppins-SemiBold', fontSize: 16, marginBottom: 12 }}>
              Mute Chat For
            </Text>

            {MUTE_OPTIONS.map((option) => (
              <TouchableOpacity key={option.key} onPress={() => onSelectMuteDuration(option.duration)} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center' }}>
                <MaterialCommunityIcons name="clock-time-four-outline" size={20} color={theme.colors.primaryTextColor} />
                <Text style={{ marginLeft: 10, color: theme.colors.primaryTextColor }}>{option.label}</Text>
              </TouchableOpacity>
            ))}

            <TouchableOpacity onPress={() => setMuteSheetVisible(false)} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center' }}>
              <MaterialCommunityIcons name="close-circle-outline" size={20} color={theme.colors.placeHolderTextColor} />
              <Text style={{ marginLeft: 10, color: theme.colors.placeHolderTextColor }}>Cancel</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal animationType="slide" transparent visible={profilePreviewVisible} onRequestClose={closeProfilePreview}>
        <TouchableOpacity activeOpacity={1} onPress={closeProfilePreview} style={{ flex: 1, justifyContent: 'flex-end' }}>
          <BlurView intensity={50} tint={theme.colors.background === '#ffffff' ? 'light' : 'dark'} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
          <TouchableOpacity activeOpacity={1} style={{ backgroundColor: theme.colors.cardBackground, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 28, alignItems: 'center' }}>
            <View style={{ width: 88, height: 88, borderRadius: 44, backgroundColor: theme.colors.menuBackground, alignItems: 'center', justifyContent: 'center' }}>
              {selectedChatItem?.peerUser?.profileImage ? (
                <Image source={{ uri: selectedChatItem.peerUser.profileImage }} style={{ width: 88, height: 88, borderRadius: 44 }} />
              ) : (
                <Text style={{ color: theme.colors.primaryTextColor, fontSize: 34, fontFamily: 'Poppins-Bold' }}>
                  {(selectedChatItem?.peerUser?.fullName || '?').charAt(0).toUpperCase()}
                </Text>
              )}
            </View>
            <Text style={{ marginTop: 12, color: theme.colors.primaryTextColor, fontSize: 18, fontFamily: 'Poppins-SemiBold' }}>
              {selectedChatItem?.peerUser?.fullName || 'Unknown User'}
            </Text>
            <Text style={{ marginTop: 4, color: theme.colors.placeHolderTextColor, fontSize: 13 }}>
              {selectedChatItem?.peerUser?.mobileNumber || selectedChatItem?.peerUser?.phoneNumber || 'Phone not available'}
            </Text>
            <Text style={{ marginTop: 2, color: theme.colors.placeHolderTextColor, fontSize: 12 }} numberOfLines={2}>
              {selectedChatItem?.peerUser?.bio || selectedChatItem?.peerUser?.status || 'Available'}
            </Text>

            <View style={{ marginTop: 18, width: '100%', flexDirection: 'row', justifyContent: 'space-between' }}>
              <TouchableOpacity
                onPress={() => {
                  if (selectedChatItem) navigation.navigate('ChatScreen', { item: selectedChatItem });
                  closeProfilePreview();
                }}
                style={{ flex: 1, height: 46, borderRadius: 12, backgroundColor: theme.colors.themeColor, alignItems: 'center', justifyContent: 'center', marginRight: 8 }}
              >
                <Text style={{ color: theme.colors.textWhite, fontFamily: 'Poppins-Medium' }}>Message</Text>
              </TouchableOpacity>
              <TouchableOpacity style={{ flex: 1, height: 46, borderRadius: 12, backgroundColor: theme.colors.menuBackground, alignItems: 'center', justifyContent: 'center', marginHorizontal: 4 }}>
                <Text style={{ color: theme.colors.primaryTextColor, fontFamily: 'Poppins-Medium' }}>Call</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  if (selectedChatItem) navigation.navigate('UserB', { item: selectedChatItem });
                  closeProfilePreview();
                }}
                style={{ flex: 1, height: 46, borderRadius: 12, backgroundColor: theme.colors.menuBackground, alignItems: 'center', justifyContent: 'center', marginLeft: 8 }}
              >
                <Text style={{ color: theme.colors.primaryTextColor, fontFamily: 'Poppins-Medium' }}>Profile</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}