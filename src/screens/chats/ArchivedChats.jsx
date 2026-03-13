import React, { useCallback, useMemo, useState, useRef } from 'react';
import { Alert, Animated, FlatList, Image, Modal, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { ImageZoom } from '@likashefqet/react-native-image-zoom';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useTheme } from '../../contexts/ThemeContext';
import { useRealtimeChat } from '../../contexts/RealtimeChatContext';
import ChatCard from '../../components/ChatCard';

const MUTE_OPTIONS = [
  { key: '8h', label: '8 hours', duration: 8 * 60 * 60 * 1000 },
  { key: '1w', label: '1 week', duration: 7 * 24 * 60 * 60 * 1000 },
  { key: 'always', label: 'Always', duration: 0 },
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
  } = useRealtimeChat();

  const [selectedChatItem, setSelectedChatItem] = useState(null);
  const [actionSheetVisible, setActionSheetVisible] = useState(false);
  const [muteSheetVisible, setMuteSheetVisible] = useState(false);
  const [profilePreviewVisible, setProfilePreviewVisible] = useState(false);
  const [imageViewerVisible, setImageViewerVisible] = useState(false);

  const profileOpacityAnim = useRef(new Animated.Value(0)).current;
  const profileScaleAnim = useRef(new Animated.Value(0)).current;

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

  const previewName = selectedChatItem?.peerUser?.fullName || 'Unknown User';
  const previewImage = selectedChatItem?.peerUser?.profileImage;
  const previewAvatarColor = getUserColor(previewName);

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

      {/* Profile Preview Modal — same style as ChatList */}
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

              {/* Name overlay */}
              <View style={styles.profileNameOverlay}>
                <Text style={styles.profileNameText} numberOfLines={1}>{previewName}</Text>
              </View>

              {/* Action buttons */}
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

      {/* Full-screen Image Viewer with zoom */}
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
    fontFamily: 'Poppins-SemiBold',
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
    fontFamily: 'Poppins-SemiBold',
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
    fontFamily: 'Poppins-SemiBold',
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
    fontFamily: 'Poppins-SemiBold',
    textTransform: 'uppercase',
  },
  imageViewerNoPhotoText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 15,
    fontFamily: 'Poppins-Regular',
    marginTop: 20,
  },
});
