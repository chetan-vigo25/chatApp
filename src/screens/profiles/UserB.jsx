import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  ActivityIndicator,
  Dimensions,
  StyleSheet,
  StatusBar,
  Platform,
  Linking,
  Modal,
  ScrollView,
} from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { useRealtimeChat } from "../../contexts/RealtimeChatContext";
import { profileServices } from "../../Redux/Services/Profile/Profile.Services";
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

const { width } = Dimensions.get('window');
const STATUS_BAR_HEIGHT = Platform.OS === 'ios' ? 50 : StatusBar.currentHeight || 24;
const TOP_BAR_HEIGHT = 56 + STATUS_BAR_HEIGHT;
const AVATAR_SIZE = 120;

const MUTE_OPTIONS = [
  { key: '8h', label: '8 hours', icon: 'clock-time-eight-outline', duration: 8 * 60 * 60 * 1000 },
  { key: '1w', label: '1 week', icon: 'calendar-week', duration: 7 * 24 * 60 * 60 * 1000 },
  { key: 'always', label: 'Always', icon: 'bell-off-outline', duration: 0 },
];

export default function UserB({ navigation, route }) {
  const { item: routeItem } = route.params || {};
  const { theme, isDarkMode } = useTheme();
  const [peerProfile, setPeerProfile] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [muteSheetVisible, setMuteSheetVisible] = useState(false);
  const [scrolledPastHeader, setScrolledPastHeader] = useState(false);

  // Safe access to realtime context
  let muteChat, unmuteChat, chatList;
  try {
    const realtime = useRealtimeChat();
    muteChat = realtime.muteChat;
    unmuteChat = realtime.unmuteChat;
    chatList = realtime.chatList;
  } catch (e) {
    muteChat = () => {};
    unmuteChat = () => {};
    chatList = [];
  }

  // Normalize peer object
  const peer = routeItem?.peerUser ? routeItem.peerUser : (routeItem || {});
  const peerId = peer?._id || peer?.userId || peer?.id || null;
  const chatId = routeItem?.chatId || routeItem?._id || null;

  // Get mute state
  const chatItem = (chatList || []).find(c => (c?.chatId || c?._id) === chatId) || routeItem || {};
  const isMuted = chatItem?.isMuted || false;

  // Fetch peer profile into local state (not Redux) to avoid polluting shared profileData
  useEffect(() => {
    if (peerId) {
      setIsLoading(true);
      profileServices.profileDetails(peerId)
        .then((response) => {
          setPeerProfile(response?.data || null);
        })
        .catch(() => {})
        .finally(() => setIsLoading(false));
    }
  }, [peerId]);

  // Display info — use local peerProfile instead of Redux profileData
  const displayName = peerProfile?.fullName || peer?.fullName || peer?.name || peer?.username || "User";
  const initial = displayName ? displayName.charAt(0).toUpperCase() : '?';
  const lastSeen = peerProfile?.lastSeen || peer?.lastSeen || '';
  const about = peerProfile?.about || peer?.about || '';
  const phoneNumber = peerProfile?.mobile?.number || peer?.mobile?.number || '';
  const countryCode = peerProfile?.mobile?.countryCode || peer?.mobile?.countryCode || '';
  const displayPhone = countryCode ? `${countryCode} ${phoneNumber}` : phoneNumber;

  // Image source
  const peerProfileImage = peerProfile?.profileImage;
  const peerImage = peer?.profileImage || peer?.profilePicture || peer?.profilePictureUri;
  const imageSource = peerProfileImage
    ? (typeof peerProfileImage === 'string' ? { uri: peerProfileImage } : peerProfileImage)
    : (peerImage ? { uri: peerImage } : null);

  const pastelColors = ["#6C5CE7", "#00B894", "#E17055", "#0984E3", "#D63031", "#E84393", "#00CEC9"];
  function getUserColor(str) {
    if (!str) return pastelColors[0];
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    return pastelColors[Math.abs(hash) % pastelColors.length];
  }

  const avatarBgColor = getUserColor(peerId || displayName);

  // Handlers
  const handleMessage = useCallback(() => {
    navigation.navigate('ChatScreen', {
      item: routeItem,
      user: peer,
      chatId: chatId,
      hasExistingChat: !!chatId,
    });
  }, [navigation, routeItem, peer, chatId]);

  const handleMutePress = useCallback(() => {
    if (isMuted) {
      if (chatId) unmuteChat(chatId);
    } else {
      setMuteSheetVisible(true);
    }
  }, [isMuted, chatId, unmuteChat]);

  const onSelectMuteDuration = useCallback((duration) => {
    if (chatId) muteChat(chatId, duration);
    setMuteSheetVisible(false);
  }, [chatId, muteChat]);

  const handleCall = useCallback(() => {
    const fullPhone = countryCode ? `${countryCode}${phoneNumber}` : phoneNumber;
    if (fullPhone) Linking.openURL(`tel:${fullPhone}`).catch(() => {});
  }, [countryCode, phoneNumber]);

  const onScroll = useCallback((e) => {
    const y = e.nativeEvent.contentOffset.y;
    setScrolledPastHeader(y > 140);
  }, []);

  if (isLoading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator size="large" color={theme.colors.themeColor} />
      </View>
    );
  }

  const cardBg = isDarkMode ? '#0e1621' : theme.colors.cardBackground || '#fff';
  const borderClr = isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const iconBtnBg = isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)';

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StatusBar translucent backgroundColor="transparent" barStyle={isDarkMode ? "light-content" : "dark-content"} />

      {/* Fixed Top Bar */}
      <View style={[styles.topBar, { backgroundColor: scrolledPastHeader ? cardBg : 'transparent', borderBottomColor: scrolledPastHeader ? borderClr : 'transparent', borderBottomWidth: scrolledPastHeader ? 0.5 : 0 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.topBarBtn} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>

        {/* Collapsed title - visible when scrolled */}
        {scrolledPastHeader && (
          <View style={styles.collapsedInfo}>
            <Text style={[styles.collapsedName, { color: theme.colors.primaryTextColor }]} numberOfLines={1}>
              {displayName}
            </Text>
            <Text style={[styles.collapsedSub, { color: theme.colors.placeHolderTextColor }]} numberOfLines={1}>
              {/* {lastSeen ? `last seen ${lastSeen}` : 'last seen recently'} */}
            </Text>
          </View>
        )}

        <TouchableOpacity style={styles.topBarBtn} activeOpacity={0.7}>
          <MaterialCommunityIcons name="dots-vertical" size={24} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
      </View>

      {/* Scrollable Content */}
      <ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40 }}
      >
        {/* Profile Header */}
        <View style={[styles.profileHeader, { backgroundColor: cardBg, borderBottomColor: borderClr }]}>
          {/* Avatar */}
          <View style={styles.avatarWrap}>
            {imageSource ? (
              <Image source={imageSource} style={styles.avatarImg} resizeMode="cover" />
            ) : (
              <View style={[styles.avatarImg, { backgroundColor: avatarBgColor, justifyContent: 'center', alignItems: 'center' }]}>
                <Text style={styles.avatarInitial}>{initial}</Text>
              </View>
            )}
          </View>

          {/* Name */}
          <Text style={[styles.profileName, { color: theme.colors.primaryTextColor }]} numberOfLines={1}>
            {displayName}
          </Text>
          <Text style={[styles.profileSub, { color: theme.colors.placeHolderTextColor }]}>
            {/* {lastSeen ? `last seen ${lastSeen}` : 'last seen recently'} */}
          </Text>

          {/* Action Buttons Row */}
          <View style={styles.actionsRow}>
            {/* Message */}
            <TouchableOpacity style={styles.actionBtn} onPress={handleMessage} activeOpacity={0.7}>
              <View style={[styles.actionIconWrap, { backgroundColor: iconBtnBg }]}>
                <Ionicons name="chatbubble" size={20} color={theme.colors.themeColor} />
              </View>
              <Text style={[styles.actionLabel, { color: theme.colors.primaryTextColor }]}>Message</Text>
            </TouchableOpacity>

            {/* Mute */}
            <TouchableOpacity style={styles.actionBtn} onPress={handleMutePress} activeOpacity={0.7}>
              <View style={[styles.actionIconWrap, { backgroundColor: iconBtnBg }]}>
                <Ionicons
                  name={isMuted ? "volume-mute" : "notifications"}
                  size={20}
                  color={isMuted ? '#F0A030' : theme.colors.themeColor}
                />
              </View>
              <Text style={[styles.actionLabel, { color: isMuted ? '#F0A030' : theme.colors.primaryTextColor }]}>
                {isMuted ? 'Unmute' : 'Mute'}
              </Text>
            </TouchableOpacity>

            {/* Call */}
            <TouchableOpacity style={styles.actionBtn} onPress={handleCall} activeOpacity={0.7}>
              <View style={[styles.actionIconWrap, { backgroundColor: iconBtnBg }]}>
                <Ionicons name="call" size={20} color={theme.colors.themeColor} />
              </View>
              <Text style={[styles.actionLabel, { color: theme.colors.primaryTextColor }]}>Call</Text>
            </TouchableOpacity>

            {/* Video */}
            <TouchableOpacity style={styles.actionBtn} onPress={() => {}} activeOpacity={0.7}>
              <View style={[styles.actionIconWrap, { backgroundColor: iconBtnBg }]}>
                <Ionicons name="videocam" size={22} color={theme.colors.themeColor} />
              </View>
              <Text style={[styles.actionLabel, { color: theme.colors.primaryTextColor }]}>Video</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Phone Section */}
        <View style={[styles.infoSection, { borderBottomColor: borderClr }]}>
          <View style={styles.infoRow}>
            <Text style={[styles.infoTitle, { color: theme.colors.primaryTextColor }]}>
              {displayPhone || 'Unknown'}
            </Text>
            <Text style={[styles.infoSub, { color: theme.colors.placeHolderTextColor }]}>Mobile</Text>
          </View>

          <TouchableOpacity
            style={[styles.addContactRow, { borderTopColor: borderClr }]}
            activeOpacity={0.6}
            onPress={() => {
              const fullPhone = countryCode ? `${countryCode}${phoneNumber}` : phoneNumber;
              if (fullPhone) Linking.openURL(`tel:${fullPhone}`).catch(() => {});
            }}
          >
            <Ionicons name="person-add-outline" size={20} color={theme.colors.themeColor} />
            <Text style={[styles.addContactText, { color: theme.colors.themeColor }]}>Add to contacts</Text>
          </TouchableOpacity>
        </View>

        {/* About Section */}
        {about ? (
          <View style={[styles.infoSection, { borderBottomColor: borderClr }]}>
            <View style={styles.infoRow}>
              <Text style={[styles.infoTitle, { color: theme.colors.primaryTextColor }]}>{about}</Text>
              <Text style={[styles.infoSub, { color: theme.colors.placeHolderTextColor }]}>About</Text>
            </View>
          </View>
        ) : null}

        {/* Email Section */}
        {(peerProfile?.email || peer?.email) ? (
          <View style={[styles.infoSection, { borderBottomColor: borderClr }]}>
            <View style={styles.infoRow}>
              <Text style={[styles.infoTitle, { color: theme.colors.primaryTextColor }]}>
                {peerProfile?.email || peer?.email}
              </Text>
              <Text style={[styles.infoSub, { color: theme.colors.placeHolderTextColor }]}>Email</Text>
            </View>
          </View>
        ) : null}
      </ScrollView>

      {/* Mute Duration Modal */}
      <Modal animationType="fade" transparent visible={muteSheetVisible} onRequestClose={() => setMuteSheetVisible(false)}>
        <TouchableOpacity activeOpacity={1} onPress={() => setMuteSheetVisible(false)} style={styles.muteOverlay}>
          <TouchableOpacity activeOpacity={1} style={[styles.muteCard, { backgroundColor: isDarkMode ? '#1a2b3c' : '#fff' }]}>
            <View style={[styles.muteIconWrapModal, { backgroundColor: '#F0A03015' }]}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Top Bar
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    // paddingTop: STATUS_BAR_HEIGHT,
    // height: TOP_BAR_HEIGHT,
  },
  topBarBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  collapsedInfo: {
    flex: 1,
    marginHorizontal: 4,
    justifyContent: 'center',
  },
  collapsedName: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 16,
    lineHeight: 20,
  },
  collapsedSub: {
    fontFamily: 'Roboto-Regular',
    fontSize: 11,
    lineHeight: 14,
  },
  // Profile Header
  profileHeader: {
    alignItems: 'center',
    paddingTop: TOP_BAR_HEIGHT + 0,
    paddingBottom: 20,
    borderBottomWidth: 0.5,
  },
  avatarWrap: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    overflow: 'hidden',
    marginBottom: 14,
  },
  avatarImg: {
    width: '100%',
    height: '100%',
    borderRadius: AVATAR_SIZE / 2,
  },
  avatarInitial: {
    color: '#fff',
    fontFamily: 'Roboto-SemiBold',
    fontSize: 46,
    textTransform: 'uppercase',
    includeFontPadding: false,
  },
  profileName: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 22,
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  profileSub: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 2,
    marginBottom: 18,
  },
  // Actions
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    width: '100%',
    paddingHorizontal: 10,
  },
  actionBtn: {
    alignItems: 'center',
    width: 72,
  },
  actionIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  actionLabel: {
    fontFamily: 'Roboto-Medium',
    fontSize: 11,
  },
  // Info Sections
  infoSection: {
    paddingHorizontal: 20,
    borderBottomWidth: 0.5,
  },
  infoRow: {
    paddingVertical: 14,
  },
  infoTitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 15,
  },
  infoSub: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 2,
  },
  addContactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 12,
    borderTopWidth: 0.5,
  },
  addContactText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
  },
  // Mute Modal
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
  muteIconWrapModal: {
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
});
