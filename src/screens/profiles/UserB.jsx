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
  ScrollView,
  Switch,
} from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { useRealtimeChat } from "../../contexts/RealtimeChatContext";
import { profileServices } from "../../Redux/Services/Profile/Profile.Services";
import { getSocket } from "../../Redux/Services/Socket/socket";
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import ContactDatabase from "../../services/ContactDatabase";
import useSaveContact from "../../hooks/useSaveContact";
import { findInDeviceContacts } from "../../services/SaveContactService";
import { useCall } from "../../calls/useCall";
import { SafeAreaView } from 'react-native-safe-area-context';

const { width } = Dimensions.get('window');
const STATUS_BAR_HEIGHT = Platform.OS === 'ios' ? 50 : StatusBar.currentHeight || 24;
const HERO_HEIGHT = Math.min(width, 430);

// Smooth dark bottom gradient over the hero photo (stacked bands → no
// LinearGradient dependency; renders identically on Android + iOS).
const GRADIENT_BANDS = 14;
const GRADIENT_HEIGHT = 200;
function HeroGradient() {
  const bandH = GRADIENT_HEIGHT / GRADIENT_BANDS;
  return (
    <View pointerEvents="none" style={styles.heroGradientWrap}>
      {Array.from({ length: GRADIENT_BANDS }).map((_, i) => {
        const t = (i + 1) / GRADIENT_BANDS;
        const alpha = Math.min(0.7, t * t * 0.8);
        return <View key={i} style={{ height: bandH, backgroundColor: `rgba(0,0,0,${alpha.toFixed(3)})` }} />;
      })}
    </View>
  );
}

export default function UserB({ navigation, route }) {
  const { item: routeItem } = route.params || {};
  const { theme, isDarkMode } = useTheme();
  const { startAudioCall, startVideoCall } = useCall();
  const [peerProfile, setPeerProfile] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
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

  // Local device-saved contact (from SQLite). When present, its name/phone wins.
  const [localContact, setLocalContact] = useState(null);
  const [isInDeviceBook, setIsInDeviceBook] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);

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
  }, [peerId, reloadVersion]);

  // Realtime: when this peer changes their own profile (photo / name / about),
  // patch the displayed profile live — no reopen needed.
  useEffect(() => {
    if (!peerId) return undefined;
    let socket = null;
    const onContactUpdated = (payload) => {
      const data = payload?.data || payload || {};
      const updatedId = String(data?.contactUserId || data?.userId || data?._id || '');
      if (!updatedId || updatedId !== String(peerId)) return;
      const image = data?.profileImage ?? data?.profilePicture;
      setPeerProfile((prev) => ({
        ...(prev || {}),
        ...(image !== undefined ? { profileImage: image } : {}),
        ...(data?.about !== undefined ? { about: data.about } : {}),
        ...((data?.fullName || data?.name) ? { fullName: data.fullName || data.name } : {}),
      }));
    };
    const attach = () => {
      const s = getSocket?.();
      if (!s || socket === s) return;
      socket = s;
      s.on('contact:updated', onContactUpdated);
    };
    attach();
    const interval = setInterval(attach, 2000);
    return () => {
      clearInterval(interval);
      if (socket) socket.off('contact:updated', onContactUpdated);
    };
  }, [peerId]);

  // Look up the contact in our local SQLite store
  useEffect(() => {
    if (!peerId) { setLocalContact(null); return; }
    let cancelled = false;
    ContactDatabase.getContactByUserId(String(peerId))
      .then((row) => { if (!cancelled) setLocalContact(row || null); })
      .catch(() => { if (!cancelled) setLocalContact(null); });
    return () => { cancelled = true; };
  }, [peerId, reloadVersion]);

  // Defensive device-book check (covers contacts saved outside the app)
  useEffect(() => {
    let cancelled = false;
    const phoneForCheck =
      localContact?.normalizedPhone ||
      (peerProfile?.mobile?.code && peerProfile?.mobile?.number
        ? `${peerProfile.mobile.code}${peerProfile.mobile.number}`
        : null);
    if (!phoneForCheck) { setIsInDeviceBook(Boolean(localContact?.originalId)); return; }
    findInDeviceContacts(phoneForCheck)
      .then((match) => { if (!cancelled) setIsInDeviceBook(Boolean(match) || Boolean(localContact?.originalId)); })
      .catch(() => { if (!cancelled) setIsInDeviceBook(Boolean(localContact?.originalId)); });
    return () => { cancelled = true; };
  }, [peerProfile?.mobile?.code, peerProfile?.mobile?.number, localContact?.originalId, localContact?.normalizedPhone]);

  // Phone: prefer device-saved number, then server's mobile
  const serverNumber = peerProfile?.mobile?.number || peer?.mobile?.number || '';
  const serverCode = peerProfile?.mobile?.code || peerProfile?.mobile?.countryCode || peer?.mobile?.code || peer?.mobile?.countryCode || '';
  const phoneNumber = localContact?.mobile?.number || localContact?.normalizedPhone || serverNumber;
  const countryCode = localContact?.mobile?.code || (localContact?.normalizedPhone ? '' : serverCode);
  const displayPhone = localContact?.normalizedPhone
    ? localContact.normalizedPhone
    : (countryCode ? `${countryCode} ${phoneNumber}` : phoneNumber);

  // Display info — apply the same rule used everywhere else:
  //   1. Locally-saved contact name (device-saved wins)
  //   2. Server's saved-contact name when this viewer has them synced
  //      server-side (peerProfile.displayName + isSavedContact flag)
  //   3. Formatted phone number
  //   4. Server profile fullName (last-resort fallback)
  const serverDisplayName =
    peerProfile?.isSavedContact ? peerProfile?.displayName : null;
  const displayName =
    localContact?.fullName ||
    serverDisplayName ||
    displayPhone ||
    peerProfile?.fullName ||
    peer?.fullName ||
    peer?.name ||
    peer?.username ||
    "User";
  const initial = displayName ? displayName.charAt(0).toUpperCase() : '?';
  const lastSeen = peerProfile?.lastSeen || peer?.lastSeen || '';
  const about = peerProfile?.about || peer?.about || '';

  // Image source — the live server profile photo wins so profile-picture
  // changes show up immediately (the locally-saved contact image is only a
  // stale snapshot from save-time). Saved-contact NAME still wins above; only
  // the photo follows the server, matching WhatsApp.
  const peerProfileImage = peerProfile?.profileImage;
  const peerImage = peer?.profileImage || peer?.profilePicture || peer?.profilePictureUri;
  const localImage = localContact?.profileImage;
  const imageSource = peerProfileImage
    ? (typeof peerProfileImage === 'string' ? { uri: peerProfileImage } : peerProfileImage)
    : (localImage
        ? { uri: localImage }
        : (peerImage ? { uri: peerImage } : null));

  // Save Contact flow — only show button when not already in device
  const peerForSave = {
    _id: peerId,
    fullName: peerProfile?.fullName || peer?.fullName || peer?.name || displayName,
    mobileNumber: serverNumber || phoneNumber,
    mobile: { code: serverCode || '', number: serverNumber || phoneNumber },
    profileImage: peerProfileImage || peerImage || '',
  };
  const {
    isSaving: isSavingContact,
    saveError: saveContactError,
    savedSuccessfully: contactJustSaved,
    saveContact,
  } = useSaveContact(peerForSave);

  // After save succeeds, re-pull local contact + profile so UI reflects new state
  useEffect(() => {
    if (contactJustSaved) {
      const t = setTimeout(() => setReloadVersion((v) => v + 1), 600);
      return () => clearTimeout(t);
    }
  }, [contactJustSaved]);

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

  // Single-tap mute toggle — no duration prompt.
  // Mutes "Always" by default; tap again to unmute.
  const handleMutePress = useCallback(() => {
    if (!chatId) return;
    if (isMuted) {
      unmuteChat(chatId);
    } else {
      muteChat(chatId, 0); // 0 = Always
    }
  }, [isMuted, chatId, muteChat, unmuteChat]);

  // In-app audio/video calls (WhatsApp parity) via the call engine. Falls back
  // to the phone dialer only if we have no userId to place an in-app call.
  const handleCall = useCallback(() => {
    if (peerId && startAudioCall) {
      startAudioCall({ id: String(peerId), name: displayName, avatar: peerProfileImage || peerImage || null });
      return;
    }
    const fullPhone = countryCode ? `${countryCode}${phoneNumber}` : phoneNumber;
    if (fullPhone) Linking.openURL(`tel:${fullPhone}`).catch(() => {});
  }, [peerId, startAudioCall, displayName, peerProfileImage, peerImage, countryCode, phoneNumber]);

  const handleVideoCall = useCallback(() => {
    if (peerId && startVideoCall) {
      startVideoCall({ id: String(peerId), name: displayName, avatar: peerProfileImage || peerImage || null });
    }
  }, [peerId, startVideoCall, displayName, peerProfileImage, peerImage]);

  const onScroll = useCallback((e) => {
    const y = e.nativeEvent.contentOffset.y;
    setScrolledPastHeader(y > HERO_HEIGHT - 90);
  }, []);

  if (isLoading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator size="large" color={theme.colors.themeColor} />
      </View>
    );
  }

  // WhatsApp grouped palette: page sits a shade behind the inset cards.
  const pageBg = isDarkMode ? '#0B141A' : '#EFF2F5';
  const cardBg = isDarkMode ? '#1F2C33' : '#FFFFFF';
  const dividerClr = isDarkMode ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
  const headerBg = isDarkMode ? '#1F2C33' : '#FFFFFF';
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const themeColor = theme.colors.themeColor;
  const isOnline = Boolean(peerProfile?.isOnline || peer?.isOnline);
  const statusLine = isOnline ? 'online' : (lastSeen ? `last seen ${lastSeen}` : '');

  return (
    <View style={[styles.container, { backgroundColor: pageBg }]}>
      <StatusBar translucent backgroundColor="transparent" barStyle={scrolledPastHeader && !isDarkMode ? "dark-content" : "light-content"} />

      {/* Floating top bar — transparent over the photo, solid once scrolled */}
      <View
        style={[
          styles.topBarSafe,
          {
            backgroundColor: scrolledPastHeader ? headerBg : 'transparent',
            borderBottomColor: scrolledPastHeader ? dividerClr : 'transparent',
            borderBottomWidth: scrolledPastHeader ? StyleSheet.hairlineWidth : 0,
          },
        ]}
      >
        <View style={styles.topBarRow}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={[styles.topBarBtn, !scrolledPastHeader && styles.topBarBtnFloating]}
            activeOpacity={0.7}
          >
            <Ionicons name="arrow-back" size={22} color={scrolledPastHeader ? primaryText : '#fff'} />
          </TouchableOpacity>

          {scrolledPastHeader && (
            <View style={styles.collapsedInfo}>
              <Text style={[styles.collapsedName, { color: primaryText }]} numberOfLines={1}>
                {displayName}
              </Text>
              {!!statusLine && (
                <Text style={[styles.collapsedSub, { color: subText }]} numberOfLines={1}>
                  {statusLine}
                </Text>
              )}
            </View>
          )}

          {/* <TouchableOpacity
            style={[styles.topBarBtn, !scrolledPastHeader && styles.topBarBtnFloating]}
            activeOpacity={0.7}
          >
            <MaterialCommunityIcons name="dots-vertical" size={22} color={scrolledPastHeader ? primaryText : '#fff'} />
          </TouchableOpacity> */}
        </View>
      </View>

      <ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 36 }}
      >
        {/* ─── Hero photo with name overlaid (WhatsApp) ─── */}
        <View style={[styles.hero, { backgroundColor: imageSource ? '#000' : avatarBgColor }]}>
          {imageSource ? (
            <Image source={imageSource} style={styles.heroImage} resizeMode="cover" />
          ) : (
            <View style={styles.heroFallback}>
              <Text style={styles.heroInitial}>{initial}</Text>
            </View>
          )}
          <HeroGradient />
          <View style={styles.heroOverlay}>
            <View style={styles.heroNameRow}>
              <Text style={styles.heroName} numberOfLines={1}>{displayName}</Text>
              {isOnline && <View style={styles.heroOnlineDot} />}
            </View>
            {(displayPhone || statusLine) ? (
              <Text style={styles.heroStatus} numberOfLines={1}>
                {displayPhone ? displayPhone : statusLine}
              </Text>
            ) : null}
          </View>
        </View>

        {/* ─── Action buttons (Message · Audio · Video) ─── */}
        <View style={styles.actionsRow}>
          <ActionButton icon="chatbubble" label="Message" color={themeColor} cardBg={cardBg} onPress={handleMessage} />
          <ActionButton icon="call" label="Audio" color={themeColor} cardBg={cardBg} onPress={handleCall} />
          <ActionButton icon="videocam" label="Video" color={themeColor} cardBg={cardBg} onPress={handleVideoCall} />
        </View>

        {/* ─── About ─── */}
        {about ? (
          <View style={[styles.card, { backgroundColor: cardBg }]}>
            <View style={styles.aboutRow}>
              <Text style={[styles.aboutText, { color: primaryText }]} selectable>{about}</Text>
              <Text style={[styles.fieldLabel, { color: subText }]}>About</Text>
            </View>
          </View>
        ) : null}

        {/* ─── Phone (with inline mini actions) ─── */}
        {displayPhone ? (
          <View style={[styles.card, { backgroundColor: cardBg }]}>
            <View style={styles.phoneRow}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.phoneValue, { color: primaryText }]} selectable numberOfLines={1}>{displayPhone}</Text>
                <Text style={[styles.fieldLabel, { color: subText }]}>Mobile</Text>
              </View>
              <TouchableOpacity style={styles.miniAction} onPress={handleMessage} activeOpacity={0.6} hitSlop={miniHit}>
                <Ionicons name="chatbubble-outline" size={20} color={themeColor} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.miniAction} onPress={handleCall} activeOpacity={0.6} hitSlop={miniHit}>
                <Ionicons name="call-outline" size={20} color={themeColor} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.miniAction} onPress={handleVideoCall} activeOpacity={0.6} hitSlop={miniHit}>
                <Ionicons name="videocam-outline" size={21} color={themeColor} />
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        {/* ─── Email / Username ─── */}
        {((peerProfile?.email || peer?.email) || (peer?.userName || peerProfile?.userName)) ? (
          <View style={[styles.card, { backgroundColor: cardBg }]}>
            {(peerProfile?.email || peer?.email) ? (
              <InfoRow
                icon="mail-outline"
                iconColor={themeColor}
                value={peerProfile?.email || peer?.email}
                label="Email"
                primary={primaryText}
                sub={subText}
              />
            ) : null}
            {(peerProfile?.email || peer?.email) && (peer?.userName || peerProfile?.userName) ? (
              <View style={[styles.divider, { backgroundColor: dividerClr }]} />
            ) : null}
            {(peer?.userName || peerProfile?.userName) ? (
              <InfoRow
                icon="at-outline"
                iconColor={themeColor}
                value={`@${peer?.userName || peerProfile?.userName}`}
                label="Username"
                primary={primaryText}
                sub={subText}
              />
            ) : null}
          </View>
        ) : null}

        {/* ─── Notifications (Mute toggle) ─── */}
        {/* {chatId ? (
          <View style={[styles.card, { backgroundColor: cardBg }]}>
            <View style={styles.card_row}>
              <View style={[styles.rowIconWrap, { backgroundColor: themeColor + '18' }]}>
                <Ionicons name={isMuted ? 'notifications-off-outline' : 'notifications-outline'} size={19} color={themeColor} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.rowValue, { color: primaryText }]}>Mute notifications</Text>
              </View>
              <Switch
                value={isMuted}
                onValueChange={handleMutePress}
                trackColor={{ false: isDarkMode ? '#3A4A54' : '#D1D7DB', true: themeColor + '99' }}
                thumbColor={isMuted ? themeColor : (isDarkMode ? '#cfd6da' : '#ffffff')}
                ios_backgroundColor={isDarkMode ? '#3A4A54' : '#D1D7DB'}
              />
            </View>
          </View>
        ) : null} */}

        {/* ─── Encryption hint (informational) ─── */}
        {/* <View style={styles.encryptionRow}>
          <Ionicons name="lock-closed" size={13} color={subText} style={{ marginTop: 1 }} />
          <Text style={[styles.encryptionText, { color: subText }]}>
            Your personal messages are end-to-end encrypted
          </Text>
        </View> */}

        {/* ─── Save Contact ─── */}
        {!isInDeviceBook && !contactJustSaved && (
          <View style={[styles.card, { backgroundColor: cardBg }]}>
            <TouchableOpacity
              style={[styles.card_row, { opacity: isSavingContact ? 0.6 : 1 }]}
              activeOpacity={0.6}
              disabled={isSavingContact}
              onPress={saveContact}
            >
              <View style={[styles.rowIconWrap, { backgroundColor: themeColor + '18' }]}>
                {isSavingContact ? (
                  <ActivityIndicator size="small" color={themeColor} />
                ) : (
                  <Ionicons name="person-add-outline" size={19} color={themeColor} />
                )}
              </View>
              <Text style={[styles.rowAction, { color: themeColor }]}>
                {isSavingContact ? 'Saving…' : 'Save to contacts'}
              </Text>
            </TouchableOpacity>
            {saveContactError && !isSavingContact && (
              <Text style={styles.errorText}>
                {saveContactError === 'permission_denied'
                  ? 'Contacts permission denied. Enable it from Settings.'
                  : saveContactError}
              </Text>
            )}
          </View>
        )}

        {contactJustSaved && (
          <View style={[styles.card, { backgroundColor: cardBg }]}>
            <View style={styles.card_row}>
              <View style={[styles.rowIconWrap, { backgroundColor: '#22C55E18' }]}>
                <Ionicons name="checkmark-circle" size={20} color="#22C55E" />
              </View>
              <Text style={[styles.rowAction, { color: '#22C55E' }]}>Contact saved</Text>
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────
// Reusable bits
// ─────────────────────────────────────────────

const miniHit = { top: 8, bottom: 8, left: 6, right: 6 };

function ActionButton({ icon, label, color, cardBg, onPress }) {
  return (
    <TouchableOpacity style={[styles.actionBtn, { backgroundColor: cardBg }]} onPress={onPress} activeOpacity={0.7}>
      <Ionicons name={icon} size={23} color={color} />
      <Text style={[styles.actionBtnLabel, { color }]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

function InfoRow({ icon, iconColor, value, label, primary, sub, onPress, multiline }) {
  const Wrapper = onPress ? TouchableOpacity : View;
  return (
    <Wrapper style={styles.card_row} onPress={onPress} activeOpacity={0.6}>
      <View style={[styles.rowIconWrap, { backgroundColor: iconColor + '18' }]}>
        <Ionicons name={icon} size={18} color={iconColor} />
      </View>
      <View style={{ flex: 1 }}>
        <Text
          style={[styles.rowValue, { color: primary }]}
          numberOfLines={multiline ? 0 : 1}
          selectable
        >
          {value}
        </Text>
        <Text style={[styles.fieldLabel, { color: sub }]}>{label}</Text>
      </View>
    </Wrapper>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  // ── Top bar (transparent over hero, solid when scrolled) ──
  topBarSafe: {
    position: 'absolute',
    top: 20,
    left: 0,
    right: 0,
    zIndex: 100,
  },
  topBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingTop: 4,
    paddingBottom: 6,
  },
  topBarBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topBarBtnFloating: {
    backgroundColor: 'rgba(0,0,0,0.32)',
  },
  collapsedInfo: { flex: 1, paddingHorizontal: 8, justifyContent: 'center' },
  collapsedName: { fontFamily: 'Roboto-SemiBold', fontSize: 16, lineHeight: 20 },
  collapsedSub: { fontFamily: 'Roboto-Regular', fontSize: 11, lineHeight: 14, marginTop: 1 },

  // ── Hero ──
  hero: {
    width: '100%',
    height: HERO_HEIGHT,
    position: 'relative',
    overflow: 'hidden',
  },
  heroImage: { width: '100%', height: '100%' },
  heroFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  heroInitial: {
    color: '#fff',
    fontSize: 120,
    fontFamily: 'Roboto-SemiBold',
    includeFontPadding: false,
  },
  heroGradientWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
  },
  heroOverlay: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 18,
  },
  heroNameRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  heroName: {
    color: '#fff',
    fontFamily: 'Roboto-SemiBold',
    fontSize: 27,
    flexShrink: 1,
    letterSpacing: 0.2,
    textShadowColor: 'rgba(0,0,0,0.45)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 5,
  },
  heroOnlineDot: {
    width: 11,
    height: 11,
    borderRadius: 6,
    backgroundColor: '#25D366',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.9)',
  },
  heroStatus: {
    color: 'rgba(255,255,255,0.9)',
    fontFamily: 'Roboto-Regular',
    fontSize: 14,
    marginTop: 5,
    textShadowColor: 'rgba(0,0,0,0.45)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },

  // ── Action buttons row ──
  actionsRow: {
    flexDirection: 'row',
    paddingHorizontal: 10,
    paddingTop: 12,
    paddingBottom: 4,
    gap: 8,
  },
  actionBtn: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  actionBtnLabel: {
    fontFamily: 'Roboto-Medium',
    fontSize: 12.5,
    letterSpacing: 0.1,
  },

  // ── Inset grouped cards ──
  card: {
    marginHorizontal: 10,
    marginTop: 12,
    borderRadius: 14,
    overflow: 'hidden',
  },
  card_row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 14,
    gap: 14,
  },
  rowIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowValue: {
    fontFamily: 'Roboto-Medium',
    fontSize: 15.5,
  },
  rowAction: {
    fontFamily: 'Roboto-Medium',
    fontSize: 15,
    flex: 1,
  },
  fieldLabel: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12.5,
    marginTop: 3,
  },

  // About
  aboutRow: {
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  aboutText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 15.5,
    lineHeight: 21,
  },

  // Phone
  phoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 6,
  },
  phoneValue: {
    fontFamily: 'Roboto-Medium',
    fontSize: 16,
  },
  miniAction: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },

  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 64,
  },

  // Encryption hint
  encryptionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 30,
    paddingTop: 18,
    paddingBottom: 2,
  },
  encryptionText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12.5,
    textAlign: 'center',
    lineHeight: 17,
  },

  errorText: {
    color: '#FF3B30',
    fontSize: 12,
    paddingHorizontal: 18,
    paddingBottom: 10,
  },
});
