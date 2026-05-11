import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import {
  View,
  Text,
  FlatList,
  Animated,
  Easing,
  TouchableOpacity,
  Image,
  TextInput,
  ActivityIndicator,
  Platform,
  ToastAndroid,
  Alert,
  Modal,
  Linking,
  RefreshControl,
  StyleSheet,
  Dimensions,
  InteractionManager,
  Keyboard,
} from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { APP_TAG_NAME } from '@env';
import useContactSync from "../../contexts/useContactSync";
import { FontAwesome6, FontAwesome5, AntDesign, MaterialCommunityIcons, FontAwesome, Ionicons } from '@expo/vector-icons';
import { useSelector } from "react-redux";
import { useFocusEffect } from '@react-navigation/native';
import { SALT_SECRET } from '@env';
import contactHasher from "../../Redux/Services/Contact/ContactHasher";
import * as SMS from 'expo-sms';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const COLLAPSED_MAX_HEIGHT = 210;
const CONTACT_ROW_HEIGHT = 68; // fixed height for getItemLayout

const AVATAR_COLORS = [
  '#6C5CE7', '#00B894', '#E17055', '#0984E3',
  '#E84393', '#00CEC9', '#FDCB6E', '#D63031',
  '#A29BFE', '#55A3E8', '#FF7675', '#74B9FF',
];

const getAvatarColor = (name) => {
  if (!name) return AVATAR_COLORS[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

// ─── MEMOIZED CONTACT ROW COMPONENT ───
// Props compared by value: contactHash, showInvite, isInviting, and color strings.
// Callbacks are looked up from refs inside the parent (never change identity).
const ContactRow = memo(function ContactRow({
  contactHash, contact, showInvite, isInviting,
  bgColor, textColor, subTextColor, themeColor, inviteBgColor,
  onPressContact, onPressAvatar, onPressInfo, onPressInvite, displayPhone,
}) {
  const displayName = contact?.name || contact?.fullName || '?';
  const initials = displayName.charAt(0).toUpperCase();
  const avatarBg = getAvatarColor(displayName);

  return (
    <TouchableOpacity
      activeOpacity={0.6}
      onPress={showInvite ? undefined : onPressContact}
      style={[styles.contactRow, { backgroundColor: bgColor }]}
    >
      <TouchableOpacity
        onPress={showInvite ? undefined : onPressAvatar}
        activeOpacity={0.8}
        style={styles.avatarWrap}
      >
        {contact.profilePicture ? (
          <Image
            resizeMode="cover"
            source={{ uri: contact.profilePicture }}
            style={styles.avatarImage}
            fadeDuration={0}
          />
        ) : (
          <View style={[styles.avatarFallback, { backgroundColor: avatarBg }]}>
            <Text style={styles.avatarInitials}>{initials}</Text>
          </View>
        )}
      </TouchableOpacity>

      <View style={styles.contactInfo}>
        <Text style={[styles.contactName, { color: textColor }]} numberOfLines={1}>
          {displayName}
        </Text>
        <Text style={[styles.contactPhone, { color: subTextColor }]} numberOfLines={1}>
          {displayPhone || (showInvite ? 'Not on ' + APP_TAG_NAME : 'Registered')}
        </Text>
      </View>

      {showInvite ? (
        <TouchableOpacity
          onPress={onPressInvite}
          disabled={isInviting}
          activeOpacity={0.7}
          style={[styles.inviteBtn, { backgroundColor: inviteBgColor }]}
        >
          {isInviting ? (
            <ActivityIndicator size="small" color={themeColor} />
          ) : (
            <Text style={[styles.inviteBtnText, { color: themeColor }]}>Invite</Text>
          )}
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          onPress={onPressInfo}
          activeOpacity={0.6}
          style={styles.infoBtn}
        >
          <Ionicons name="information-circle-outline" size={22} color={subTextColor} />
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}, (prev, next) => {
  // Custom comparison — only re-render when these change:
  return prev.contactHash === next.contactHash &&
    prev.showInvite === next.showInvite &&
    prev.isInviting === next.isInviting &&
    prev.displayPhone === next.displayPhone &&
    prev.textColor === next.textColor &&
    prev.contact?.profilePicture === next.contact?.profilePicture &&
    prev.contact?.name === next.contact?.name;
});

export default function AddUser({ navigation }) {
  const { theme } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0)).current;
  const [searchQuery, setSearchQuery] = useState('');
  const { chatsData } = useSelector(state => state.chat || {});

  // Clear search when navigating away from this tab
  useFocusEffect(
    useCallback(() => {
      return () => setSearchQuery('');
    }, [])
  );

  const [modalVisible, setModalVisible] = useState(false);
  const [selectedChatItem, setSelectedChatItem] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [invitingContactId, setInvitingContactId] = useState(null);

  // Scroll-based collapsible animation
  const collapseAnim = useRef(new Animated.Value(1)).current;
  const headerSearchAnim = useRef(new Animated.Value(0)).current;
  const lastScrollY = useRef(0);
  const isCollapsed = useRef(false);
  const [headerSearchVisible, setHeaderSearchVisible] = useState(false);

  // Search input ref for auto-focus
  const searchInputRef = useRef(null);

  // Cancel flag: set to true when user scrolls down during a refresh
  const refreshCancelledRef = useRef(false);

  const {
    matchedContacts = [],
    matchedCount,
    isInitialLoading,
    isProcessing,
    isSyncing,
    error,
    lastSyncTime,
    discoverContact,
    discoverResponse,
    clearDiscoverResponse,
    syncContacts,
    handleSenInvatation,
    inviteResponse,
    clearInviteResponse,
    refreshContacts,
    loadContacts
  } = useContactSync();

  // ─── ALL EXISTING LOGIC (UNCHANGED) ───

  const normalizeId = (value) => {
    if (value == null) return null;
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (typeof value === 'object') {
      if (value?._id?.$oid) return String(value._id.$oid);
      const candidate = value?._id || value?.id || value?.userId || value?.$oid || null;
      return candidate == null ? null : String(candidate);
    }
    return null;
  };

  const sameId = (left, right) => {
    const a = normalizeId(left);
    const b = normalizeId(right);
    return Boolean(a && b && a === b);
  };

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, []);

  useEffect(() => {
    // Only load cached contacts from SQLite on mount — no server sync.
    // Server sync only happens when the user taps the refresh button.
    loadContacts().catch((err) => console.warn('Failed to load contacts:', err));
  }, []);

  useEffect(() => {
    if (!discoverResponse) return;
    const data = discoverResponse?.data ?? discoverResponse;
    let discoveredData = null;
    if (data?.userId) discoveredData = data;
    else if (Array.isArray(data?.contacts) && data.contacts.length > 0) discoveredData = data.contacts[0];

    if (!discoveredData) {
      showMessage(data?.message || "Contact not found on server");
      clearDiscoverResponse();
      return;
    }

    const discovered = {
      _id: discoveredData.userId || discoveredData._id || discoveredData.id,
      userId: discoveredData.userId,
      id: discoveredData.userId || discoveredData.id,
      name: discoveredData.name || discoveredData.fullName || 'Unknown',
      fullName: discoveredData.fullName || discoveredData.name || 'Unknown',
      profilePicture: discoveredData.profileImage || discoveredData.profilePicture || '',
      about: discoveredData.about || '',
      isActive: discoveredData.isActive ?? true,
      canMessage: discoveredData.canMessage ?? true,
      originalId: discoveredData.originalId,
      hash: discoveredData.hash
    };

    const existingChat = chatsData?.find((chat) => (
      sameId(chat?.peerUser?._id, discovered?.userId) ||
      sameId(chat?.peerUser?._id, discovered?.id)
    ));

    if (existingChat) {
      navigation.navigate('ChatScreen', { item: existingChat, chatId: existingChat._id || existingChat.chatId, user: discovered, hasExistingChat: true });
    } else {
      navigation.navigate('ChatScreen', { user: discovered, chatId: null, hasExistingChat: false });
    }

    clearDiscoverResponse();
  }, [discoverResponse]);

  useEffect(() => {
    if (!inviteResponse) return;
    if (inviteResponse.error) showMessage(inviteResponse.error || 'Failed to send invitation.');
    else showMessage(inviteResponse.message || `Invitation sent to ${inviteResponse.contactName || 'contact'}`);
    clearInviteResponse();
  }, [inviteResponse, clearInviteResponse]);

  useEffect(() => { if (error) showMessage(error); }, [error]);

  const showMessage = (msg) => {
    if (!msg) return;
    if (Platform.OS === 'android') ToastAndroid.show(msg, ToastAndroid.LONG);
    else Alert.alert('Info', msg);
  };

  const normalizeChatUser = useCallback((contact) => {
    if (!contact) return null;
    const resolvedId = contact._id || contact.userId || contact.id || null;
    return {
      ...contact,
      _id: resolvedId,
      id: contact.id || resolvedId,
      userId: contact.userId || resolvedId,
      name: contact.name || contact.fullName || 'Unknown',
      fullName: contact.fullName || contact.name || 'Unknown',
      profilePicture: contact.profilePicture || contact.profileImage || '',
    };
  }, []);

  const handleContactPress = useCallback(async (contact) => {
    if (!contact) return;

    const normalizedUser = normalizeChatUser(contact);

    const existingChat = chatsData?.find((chat) => (
      sameId(chat?.peerUser?._id, normalizedUser?.userId) ||
      sameId(chat?.peerUser?._id, normalizedUser?.id)
    ));

    if (existingChat) {
      navigation.navigate('ChatScreen', { item: existingChat, chatId: existingChat._id || existingChat.chatId, user: normalizedUser, hasExistingChat: true });
      return;
    }

    const isRegistered = normalizedUser?.type === 'registered' || !!normalizedUser?.userId;
    if (isRegistered && normalizedUser?._id) {
      navigation.navigate('ChatScreen', { user: normalizedUser, chatId: null, hasExistingChat: false });
      return;
    }

    if (normalizedUser?.hash && discoverContact) {
      try { await discoverContact(normalizedUser.hash); }
      catch (err) { showMessage(err?.message || 'Failed to discover contact.'); }
      return;
    }

    navigation.navigate('ChatScreen', { user: normalizedUser, chatId: null, hasExistingChat: false });
  }, [chatsData, normalizeChatUser, discoverContact, navigation]);

  const handleRefresh = useCallback(async () => {
    if (refreshing || isSyncing) return;
    refreshCancelledRef.current = false;
    setRefreshing(true);
    try {
      await refreshContacts({ fallbackToSync: true });
      if (refreshCancelledRef.current) return;
    } catch (err) {
      if (refreshCancelledRef.current) return;
      console.warn('Refresh failed:', err);
      try { await syncContacts(); } catch (_) { showMessage('Failed to refresh contacts'); }
    } finally { setRefreshing(false); }
  }, [refreshContacts, syncContacts, refreshing, isSyncing]);

  const getDisplayPhone = useCallback((contact) => {
    if (!contact) return '';
    if (contact.phone) return contact.phone;
    if (contact.number) return contact.number;
    if (contact.originalPhone) return contact.originalPhone;
    if (contact.encryptNumber) {
      const salt = contact.hashDetails?.salt || SALT_SECRET || '';
      return contactHasher.decryptPhoneNumber(contact.encryptNumber, salt);
    }
    if (contact.originalId && /^[0-9]{8,}$/.test(String(contact.originalId))) {
      let num = String(contact.originalId);
      if (!num.startsWith('+')) num = '+91' + num;
      return num;
    }
    if (contact.originalId) return `ID: ${contact.originalId}`;
    return '';
  }, []);

  // ─── MEMOIZED FILTERED DATA ───
  const { registeredContacts, unregisteredContacts } = useMemo(() => {
    const searchLower = (searchQuery || '').toLowerCase();
    const filtered = matchedContacts.filter(contact =>
      (contact.name || '').toLowerCase().includes(searchLower) ||
      (contact.fullName || '').toLowerCase().includes(searchLower) ||
      (contact.username || '').toLowerCase().includes(searchLower) ||
      (contact.originalPhone || '').includes(searchQuery)
    );
    return {
      registeredContacts: filtered.filter(c => !!c.userId),
      unregisteredContacts: filtered.filter(c => !c.userId),
    };
  }, [matchedContacts, searchQuery]);

  const onSendInvitationPress = useCallback(async (contact) => {
    if (!contact) return;

    const contactId = contact.id || contact.userId || contact.hash || Date.now().toString();
    setInvitingContactId(contactId);

    const message = "Hey! Join me on this chat app. Download it now!";
    const phone = contact.phone || contact.number || contact.originalPhone;

    if (!phone) {
      showMessage("No phone number available to send invite.");
      setInvitingContactId(null);
      return;
    }

    try {
      if (handleSenInvatation) {
        const payload = {
          contactHash: contact?.hash || contact?.contactHash || contact?.id || null,
          inviteMethod: "sms",
          contactName: contact?.fullName || contact?.name || "",
          message,
        };

        await Promise.race([
          handleSenInvatation(payload),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Server timeout')), 5000))
        ]).catch(err => {
          console.warn("Server invite warning:", err?.message || err);
        });
      }

      const isAvailable = await SMS.isAvailableAsync();

      if (isAvailable) {
        await SMS.sendSMSAsync([phone], message);
        showMessage(`Invitation sent to ${contact?.fullName || contact?.name || 'contact'}`);
      } else {
        const separator = Platform.OS === 'ios' ? '&' : '?';
        const smsUrl = `sms:${phone}${separator}body=${encodeURIComponent(message)}`;
        await Linking.openURL(smsUrl);
      }
    } catch (err) {
      console.warn("Failed to send invitation:", err);

      if (Platform.OS === 'ios') {
        Alert.alert(
          "Send Invitation",
          `Please send this message to ${phone}:\n\n"${message}"`,
          [{ text: "OK" }]
        );
      } else {
        showMessage("Please send SMS manually");
      }
    } finally {
      setInvitingContactId(null);
    }
  }, [handleSenInvatation]);

  const handleModal = useCallback((contact) => {
    setSelectedChatItem(contact);
    setModalVisible(true);
    Animated.parallel([
      Animated.spring(scaleAnim, {
        toValue: 1,
        tension: 65,
        friction: 8,
        useNativeDriver: true,
      }),
      Animated.timing(opacityAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start();
  }, [scaleAnim, opacityAnim]);

  const closeModal = useCallback(() => {
    Animated.parallel([
      Animated.timing(scaleAnim, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }),
      Animated.timing(opacityAnim, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setModalVisible(false);
      setSelectedChatItem(null);
    });
  }, [scaleAnim, opacityAnim]);

  // ─── SCROLL HANDLER FOR COLLAPSIBLE SECTION ───

  const collapseAnimating = useRef(false);

  const expandCollapsible = useCallback(() => {
    if (!isCollapsed.current) return;
    isCollapsed.current = false;
    collapseAnimating.current = true;

    Animated.timing(headerSearchAnim, {
      toValue: 0,
      duration: 150,
      easing: Easing.out(Easing.ease),
      useNativeDriver: true,
    }).start(() => {
      setHeaderSearchVisible(false);
      Animated.timing(collapseAnim, {
        toValue: 1,
        duration: 300,
        easing: Easing.out(Easing.bezier(0.25, 0.46, 0.45, 0.94)),
        useNativeDriver: false,
      }).start(() => {
        collapseAnimating.current = false;
        // Auto-focus search input after expanding
        InteractionManager.runAfterInteractions(() => {
          searchInputRef.current?.focus();
        });
      });
    });
  }, [collapseAnim, headerSearchAnim]);

  const collapseCollapsible = useCallback(() => {
    if (isCollapsed.current) return;
    isCollapsed.current = true;
    collapseAnimating.current = true;

    // Dismiss keyboard when collapsing
    Keyboard.dismiss();

    Animated.timing(collapseAnim, {
      toValue: 0,
      duration: 260,
      easing: Easing.in(Easing.bezier(0.55, 0.06, 0.68, 0.19)),
      useNativeDriver: false,
    }).start(() => {
      setHeaderSearchVisible(true);
      Animated.spring(headerSearchAnim, {
        toValue: 1,
        tension: 120,
        friction: 8,
        useNativeDriver: true,
      }).start(() => {
        collapseAnimating.current = false;
      });
    });
  }, [collapseAnim, headerSearchAnim]);

  const handleScroll = useCallback((event) => {
    if (collapseAnimating.current) return;

    const currentY = event.nativeEvent.contentOffset.y;
    const diff = currentY - lastScrollY.current;

    // Cancel ongoing refresh when user scrolls down
    if (diff > 10 && (refreshing || isSyncing)) {
      refreshCancelledRef.current = true;
      setRefreshing(false);
    }

    if (diff > 15 && !isCollapsed.current && currentY > 40) {
      collapseCollapsible();
    } else if (diff < -15 && isCollapsed.current) {
      expandCollapsible();
    }

    lastScrollY.current = currentY;
  }, [collapseCollapsible, expandCollapsible, refreshing, isSyncing]);

  // ─── BUILD FLATLIST DATA (MEMOIZED) ───

  const listData = useMemo(() => {
    const data = [];

    if (lastSyncTime) {
      data.push({ type: 'syncInfo', time: lastSyncTime });
    }

    if (registeredContacts.length === 0 && unregisteredContacts.length === 0) {
      data.push({ type: 'empty' });
      return data;
    }

    if (registeredContacts.length > 0) {
      data.push({ type: 'sectionHeader', title: `Contacts on ${APP_TAG_NAME}`, count: registeredContacts.length });
      registeredContacts.forEach((c, i) => {
        data.push({ type: 'contact', contact: c, index: i, showInvite: false });
      });
    } else {
      data.push({ type: 'sectionEmpty', title: 'No registered contacts' });
    }

    data.push({ type: 'spacer' });

    if (unregisteredContacts.length > 0) {
      data.push({ type: 'sectionHeader', title: 'Invite to ' + APP_TAG_NAME, count: unregisteredContacts.length });
      unregisteredContacts.forEach((c, i) => {
        data.push({ type: 'contact', contact: c, index: i, showInvite: true });
      });
    } else {
      data.push({ type: 'sectionEmpty', title: 'No unregistered contacts' });
    }

    return data;
  }, [registeredContacts, unregisteredContacts, lastSyncTime]);

  // ─── RENDER FUNCTIONS ───

  let isInTabNavigator = false;
  try { isInTabNavigator = navigation.getParent()?.getState()?.type === 'tab'; } catch (e) {}

  const renderHeader = () => (
    <View style={[styles.header, { backgroundColor: theme.colors.background }]}>
      {!isInTabNavigator && (
        <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.6} style={styles.headerBackBtn}>
          <FontAwesome6 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
      )}
      <View style={styles.headerTitleWrap}>
        <View>
          <Text style={[styles.headerTitle, { color: theme.colors.primaryTextColor }]}>
            Select Contact
          </Text>
          <Text style={[styles.headerSubtitle, { color: theme.colors.placeHolderTextColor }]}>
            {isSyncing ? 'Syncing...' : `${matchedCount} contacts`}
          </Text>
        </View>
        <View style={styles.headerActions}>
          {headerSearchVisible && (
            <Animated.View style={{ opacity: headerSearchAnim, transform: [{ scale: headerSearchAnim }] }}>
              <TouchableOpacity
                onPress={expandCollapsible}
                activeOpacity={0.6}
                style={styles.headerActionBtn}
              >
                <Ionicons name="search-outline" size={21} color={theme.colors.primaryTextColor} />
              </TouchableOpacity>
            </Animated.View>
          )}
          <TouchableOpacity
            onPress={handleRefresh}
            disabled={isSyncing || refreshing}
            activeOpacity={0.6}
            style={styles.headerActionBtn}
          >
            {isSyncing || refreshing ? (
              <ActivityIndicator size="small" color={theme.colors.themeColor} />
            ) : (
              <Ionicons name="sync-outline" size={22} color={theme.colors.primaryTextColor} />
            )}
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );

  const collapseMaxHeight = collapseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, COLLAPSED_MAX_HEIGHT],
    extrapolate: 'clamp',
  });
  const collapseOpacity = collapseAnim.interpolate({
    inputRange: [0, 0.4, 0.7, 1],
    outputRange: [0, 0, 0.6, 1],
    extrapolate: 'clamp',
  });

  const renderCollapsibleSection = () => (
    <Animated.View
      style={[
        styles.collapsibleWrap,
        {
          maxHeight: collapseMaxHeight,
          opacity: collapseOpacity,
          backgroundColor: theme.colors.background,
        },
      ]}
    >
      <View style={styles.searchBarOuter}>
        <View style={[styles.searchBarInner, { backgroundColor: theme.colors.menuBackground }]}>
          <Ionicons name="search-outline" size={18} color={theme.colors.placeHolderTextColor} style={{ marginLeft: 14 }} />
          <TextInput
            ref={searchInputRef}
            placeholder="Search contacts..."
            placeholderTextColor={theme.colors.placeHolderTextColor}
            value={searchQuery}
            onChangeText={setSearchQuery}
            style={[styles.searchInput, { color: theme.colors.primaryTextColor }]}
            returnKeyType="search"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')} activeOpacity={0.6} style={{ marginRight: 12 }}>
              <Ionicons name="close-circle" size={18} color={theme.colors.placeHolderTextColor} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <TouchableOpacity
        onPress={() => navigation.navigate('AddNewContact')}
        activeOpacity={0.7}
        style={styles.newContactBtn}
      >
        <View style={[styles.newContactIcon, { backgroundColor: theme.colors.themeColor }]}>
          <FontAwesome5 name="user-plus" size={15} color={theme.colors.textWhite} />
        </View>
        <Text style={[styles.newContactText, { color: theme.colors.primaryTextColor }]}>
          New Contact
        </Text>
        <FontAwesome6 name="chevron-right" size={14} color={theme.colors.placeHolderTextColor} />
      </TouchableOpacity>

      <TouchableOpacity
        onPress={() => navigation.navigate('CreateGroup')}
        activeOpacity={0.7}
        style={styles.newContactBtn}
      >
        <View style={[styles.newContactIcon, { backgroundColor: theme.colors.themeColor }]}>
          <Ionicons name="people" size={17} color={theme.colors.textWhite} />
        </View>
        <Text style={[styles.newContactText, { color: theme.colors.primaryTextColor }]}>
          New Group
        </Text>
        <FontAwesome6 name="chevron-right" size={14} color={theme.colors.placeHolderTextColor} />
      </TouchableOpacity>
    </Animated.View>
  );

  // ─── STABLE CALLBACK REFS (never change identity → memo works) ───
  const handleContactPressRef = useRef(handleContactPress);
  handleContactPressRef.current = handleContactPress;
  const handleModalRef = useRef(handleModal);
  handleModalRef.current = handleModal;
  const onSendInvitationPressRef = useRef(onSendInvitationPress);
  onSendInvitationPressRef.current = onSendInvitationPress;
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;

  // Pre-compute stable color strings so ContactRow gets primitives, not objects
  const bgColor = theme.colors.background;
  const textColor = theme.colors.primaryTextColor;
  const subTextColor = theme.colors.placeHolderTextColor;
  const themeColor = theme.colors.themeColor;
  const inviteBgColor = theme.colors.themeColor + '15';
  const menuBgColor = theme.colors.menuBackground;
  const badgeBgColor = theme.colors.themeColor + '18';
  const textWhite = theme.colors.textWhite;

  // Static spacer to avoid re-creating on each render
  const SpacerItem = useMemo(() => <View style={styles.spacerItem} />, []);

  const renderItem = useCallback(({ item }) => {
    switch (item.type) {
      case 'syncInfo':
        return (
          <View style={[styles.syncBar, { backgroundColor: menuBgColor }]}>
            <Ionicons name="time-outline" size={12} color={subTextColor} />
            <Text style={[styles.syncText, { color: subTextColor }]}>
              Last sync: {new Date(item.time).toLocaleTimeString()}
            </Text>
          </View>
        );
      case 'sectionHeader':
        return (
          <View style={styles.sectionHeaderWrap}>
            <Text style={[styles.sectionHeaderText, { color: themeColor }]}>
              {item.title}
            </Text>
            {item.count != null && (
              <View style={[styles.sectionBadge, { backgroundColor: badgeBgColor }]}>
                <Text style={[styles.sectionBadgeText, { color: themeColor }]}>{item.count}</Text>
              </View>
            )}
          </View>
        );
      case 'sectionEmpty':
        return (
          <Text style={[styles.sectionEmptyText, { color: subTextColor }]}>
            {item.title}
          </Text>
        );
      case 'contact': {
        const c = item.contact;
        const cHash = c.hash || c.id || c.userId || String(item.index);
        return (
          <ContactRow
            contactHash={cHash}
            contact={c}
            showInvite={item.showInvite}
            isInviting={invitingContactId === (c.id || c.userId || c.hash || item.index)}
            bgColor={bgColor}
            textColor={textColor}
            subTextColor={subTextColor}
            themeColor={themeColor}
            inviteBgColor={inviteBgColor}
            displayPhone={getDisplayPhone(c)}
            onPressContact={() => handleContactPressRef.current(c)}
            onPressAvatar={() => handleModalRef.current(c)}
            onPressInfo={() => navigationRef.current.navigate('UserB', { item: c })}
            onPressInvite={() => onSendInvitationPressRef.current(c)}
          />
        );
      }
      case 'spacer':
        return SpacerItem;
      case 'empty':
        return (
          <View style={styles.emptyWrap}>
            <View style={[styles.emptyIconWrap, { backgroundColor: menuBgColor }]}>
              <FontAwesome6 name="address-book" size={32} color={subTextColor} />
            </View>
            <Text style={[styles.emptyTitle, { color: textColor }]}>
              {searchQuery ? 'No matching contacts' : 'No contacts found'}
            </Text>
            <Text style={[styles.emptySubtitle, { color: subTextColor }]}>
              {searchQuery ? 'Try a different search term' : 'Pull down to refresh or sync your contacts'}
            </Text>
            {error && (
              <Text style={styles.emptyError}>{error}</Text>
            )}
            {!searchQuery && (
              <TouchableOpacity
                onPress={handleRefresh}
                disabled={isSyncing || refreshing}
                activeOpacity={0.7}
                style={[styles.emptyRefreshBtn, { backgroundColor: themeColor, opacity: (isSyncing || refreshing) ? 0.5 : 1 }]}
              >
                <Ionicons name="sync-outline" size={16} color={textWhite} style={{ marginRight: 6 }} />
                <Text style={[styles.emptyRefreshText, { color: textWhite }]}>
                  {isSyncing || refreshing ? 'Syncing...' : 'Refresh Contacts'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        );
      default:
        return null;
    }
  }, [bgColor, textColor, subTextColor, themeColor, inviteBgColor, menuBgColor, badgeBgColor, textWhite, invitingContactId, getDisplayPhone, searchQuery, error, isSyncing, refreshing, handleRefresh, SpacerItem]);

  const keyExtractor = useCallback((item, index) => {
    if (item.type === 'contact') {
      return `c-${item.contact.id || item.contact.userId || item.contact.hash || index}`;
    }
    return `${item.type}-${index}`;
  }, []);

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: theme.colors.background }]}>
      {renderHeader()}
      {renderCollapsibleSection()}

      {(isProcessing || isInitialLoading) ? (
        <View style={styles.processingWrap}>
          <ActivityIndicator size="large" color={theme.colors.themeColor} />
          {isProcessing && (
            <View style={[styles.processingCard, { backgroundColor: theme.colors.menuBackground, marginTop: 16 }]}>
              <Text style={[styles.processingTitle, { color: theme.colors.primaryTextColor }]}>
                Processing contacts...
              </Text>
              <Text style={[styles.processingSubtitle, { color: theme.colors.placeHolderTextColor }]}>
                Securely hashing your contacts
              </Text>
            </View>
          )}
        </View>
      ) : (
        <FlatList
          data={listData}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          // ─── PERFORMANCE OPTIMIZATIONS ───
          initialNumToRender={20}
          maxToRenderPerBatch={20}
          updateCellsBatchingPeriod={30}
          windowSize={7}
          removeClippedSubviews={Platform.OS === 'android'}
          // No getItemLayout — mixed item types have different heights.
          // Wrong offsets cause scroll jumping which feels worse than no layout hint.
          refreshControl={
            <RefreshControl
              refreshing={refreshing || isSyncing}
              onRefresh={handleRefresh}
              colors={[theme.colors.themeColor]}
              tintColor={theme.colors.themeColor}
              progressBackgroundColor={theme.colors.menuBackground}
            />
          }
        />
      )}

      {/* Profile Preview Modal */}
      <Modal
        transparent
        visible={modalVisible}
        onRequestClose={closeModal}
        statusBarTranslucent
      >
        <TouchableOpacity onPress={closeModal} activeOpacity={1} style={styles.modalOverlay}>
          <Animated.View style={[
            styles.modalCard,
            {
              backgroundColor: theme.colors.cardBackground,
              opacity: opacityAnim,
              transform: [{ scale: scaleAnim }],
            }
          ]}>
            <View style={[styles.modalImageWrap, { backgroundColor: theme.colors.menuBackground }]}>
              {(selectedChatItem?.profilePicture || selectedChatItem?.profileImage) ? (
                <Image
                  resizeMode="cover"
                  source={{ uri: selectedChatItem?.profilePicture || selectedChatItem?.profileImage }}
                  style={{ width: '100%', height: '100%' }}
                  fadeDuration={0}
                />
              ) : (
                <View style={[styles.modalFallback, { backgroundColor: getAvatarColor(selectedChatItem?.fullName || selectedChatItem?.name) }]}>
                  <Text style={styles.modalFallbackText}>
                    {(selectedChatItem?.fullName || selectedChatItem?.name || "?").charAt(0).toUpperCase()}
                  </Text>
                </View>
              )}

              <View style={styles.modalNameOverlay}>
                <Text style={styles.modalName} numberOfLines={1}>
                  {selectedChatItem?.fullName || selectedChatItem?.name || 'Unknown'}
                </Text>
              </View>

              {selectedChatItem?.type === "registered" && (
                <View style={styles.modalActions}>
                  <TouchableOpacity
                    onPress={async () => {
                      closeModal();
                      await handleContactPress(selectedChatItem);
                    }}
                    activeOpacity={0.8}
                    style={styles.modalActionBtn}
                  >
                    <MaterialCommunityIcons name="message-reply-text-outline" size={22} color="#fff" />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => {
                      closeModal();
                      navigation.navigate('UserB', { item: selectedChatItem });
                    }}
                    activeOpacity={0.8}
                    style={styles.modalActionBtn}
                  >
                    <Ionicons name="information-circle-outline" size={22} color="#fff" />
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </Animated.View>
        </TouchableOpacity>
      </Modal>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },

  // ─── HEADER ───
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 10,
    gap: 4,
  },
  headerBackBtn: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 21,
  },
  headerTitleWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 18,
    letterSpacing: 0.2,
  },
  headerSubtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: -2,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  headerActionBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },

  // ─── COLLAPSIBLE (SEARCH + NEW CONTACT) ───
  collapsibleWrap: {
    overflow: 'hidden',
  },
  searchBarOuter: {
    paddingHorizontal: 14,
    paddingTop: 2,
    paddingBottom: 8,
  },
  searchBarInner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 25,
    height: 44,
  },
  searchInput: {
    flex: 1,
    fontFamily: 'Roboto-Regular',
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 0,
    height: 44,
  },
  newContactBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 14,
  },
  newContactIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  newContactText: {
    flex: 1,
    fontFamily: 'Roboto-Medium',
    fontSize: 15,
  },

  // ─── SYNC BAR ───
  syncBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 5,
    marginHorizontal: 14,
    borderRadius: 8,
    marginBottom: 4,
  },
  syncText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 10,
  },

  // ─── SECTION HEADERS ───
  sectionHeaderWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  sectionHeaderText: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 13,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  sectionBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  sectionBadgeText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 11,
  },
  sectionEmptyText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },

  // ─── CONTACT ROW ───
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 14,
    height: CONTACT_ROW_HEIGHT,
  },
  avatarWrap: {
    width: 48,
    height: 48,
    borderRadius: 24,
    overflow: 'hidden',
  },
  avatarImage: {
    width: 48,
    height: 48,
    borderRadius: 24,
  },
  avatarFallback: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    color: '#fff',
    fontFamily: 'Roboto-SemiBold',
    fontSize: 18,
  },
  onlineDot: {
    position: 'absolute',
    bottom: 1,
    right: 1,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#25D366',
    borderWidth: 2,
  },
  contactInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  contactName: {
    fontFamily: 'Roboto-Medium',
    fontSize: 15,
    textTransform: 'capitalize',
    lineHeight: 21,
  },
  contactPhone: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    marginTop: 1,
    lineHeight: 18,
  },
  inviteBtn: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 70,
  },
  inviteBtnText: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 12,
  },
  infoBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
  },

  // ─── LIST ───
  listContent: {
    paddingBottom: 30,
  },
  spacerItem: {
    height: 16,
  },

  // ─── EMPTY STATE ───
  emptyWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
    paddingHorizontal: 30,
  },
  emptyIconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 16,
    marginBottom: 6,
  },
  emptySubtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
  },
  emptyError: {
    color: '#ff4444',
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 8,
    textAlign: 'center',
  },
  emptyRefreshBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 20,
    paddingHorizontal: 22,
    paddingVertical: 10,
    borderRadius: 22,
  },
  emptyRefreshText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 13,
  },

  // ─── PROCESSING STATE ───
  processingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 30,
  },
  processingCard: {
    alignItems: 'center',
    paddingVertical: 36,
    paddingHorizontal: 30,
    borderRadius: 16,
    width: '80%',
  },
  processingTitle: {
    fontFamily: 'Roboto-Medium',
    fontSize: 15,
    marginTop: 16,
  },
  processingSubtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    marginTop: 6,
  },

  // ─── MODAL ───
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  modalCard: {
    width: SCREEN_WIDTH * 0.60,
    borderRadius: 6,
    overflow: 'hidden',
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
  },
  modalImageWrap: {
    width: '100%',
    aspectRatio: 1,
  },
  modalFallback: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalFallbackText: {
    color: '#fff',
    fontFamily: 'Roboto-SemiBold',
    fontSize: 60,
  },
  modalNameOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  modalName: {
    color: '#fff',
    fontFamily: 'Roboto-SemiBold',
    fontSize: 17,
  },
  modalActions: {
    position: 'absolute',
    bottom: 52,
    right: 10,
    flexDirection: 'row',
    gap: 10,
  },
  modalActionBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});