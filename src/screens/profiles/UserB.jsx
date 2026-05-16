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
} from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { useRealtimeChat } from "../../contexts/RealtimeChatContext";
import { profileServices } from "../../Redux/Services/Profile/Profile.Services";
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import ContactDatabase from "../../services/ContactDatabase";
import useSaveContact from "../../hooks/useSaveContact";
import { findInDeviceContacts } from "../../services/SaveContactService";
import { SafeAreaView } from 'react-native-safe-area-context';

const { width } = Dimensions.get('window');
const STATUS_BAR_HEIGHT = Platform.OS === 'ios' ? 50 : StatusBar.currentHeight || 24;
const TOP_BAR_HEIGHT = 56 + STATUS_BAR_HEIGHT;
const AVATAR_SIZE = 120;
const HERO_HEIGHT = Math.min(width, 420);

export default function UserB({ navigation, route }) {
  const { item: routeItem } = route.params || {};
  const { theme, isDarkMode } = useTheme();
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

  // Display info — LOCAL contact (device-saved) takes priority over server
  const displayName =
    localContact?.fullName ||
    peerProfile?.fullName ||
    peer?.fullName ||
    peer?.name ||
    peer?.username ||
    "User";
  const initial = displayName ? displayName.charAt(0).toUpperCase() : '?';
  const lastSeen = peerProfile?.lastSeen || peer?.lastSeen || '';
  const about = peerProfile?.about || peer?.about || '';
  // Phone: prefer device-saved number, then server's mobile
  const serverNumber = peerProfile?.mobile?.number || peer?.mobile?.number || '';
  const serverCode = peerProfile?.mobile?.code || peerProfile?.mobile?.countryCode || peer?.mobile?.code || peer?.mobile?.countryCode || '';
  const phoneNumber = localContact?.mobile?.number || localContact?.normalizedPhone || serverNumber;
  const countryCode = localContact?.mobile?.code || (localContact?.normalizedPhone ? '' : serverCode);
  const displayPhone = localContact?.normalizedPhone
    ? localContact.normalizedPhone
    : (countryCode ? `${countryCode} ${phoneNumber}` : phoneNumber);

  // Image source — local profile image wins
  const peerProfileImage = peerProfile?.profileImage;
  const peerImage = peer?.profileImage || peer?.profilePicture || peer?.profilePictureUri;
  const localImage = localContact?.profileImage;
  const imageSource = localImage
    ? { uri: localImage }
    : (peerProfileImage
        ? (typeof peerProfileImage === 'string' ? { uri: peerProfileImage } : peerProfileImage)
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

  const handleCall = useCallback(() => {
    const fullPhone = countryCode ? `${countryCode}${phoneNumber}` : phoneNumber;
    if (fullPhone) Linking.openURL(`tel:${fullPhone}`).catch(() => {});
  }, [countryCode, phoneNumber]);

  const onScroll = useCallback((e) => {
    const y = e.nativeEvent.contentOffset.y;
    setScrolledPastHeader(y > HERO_HEIGHT - 110);
  }, []);

  if (isLoading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator size="large" color={theme.colors.themeColor} />
      </View>
    );
  }

  const pageBg = isDarkMode ? '#0f1923' : '#F4F5F7';
  const cardBg = isDarkMode ? '#172533' : '#FFFFFF';
  const borderClr = isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const themeColor = theme.colors.themeColor || '#1DA1F2';
  const isOnline = Boolean(peerProfile?.isOnline || peer?.isOnline);

  return (
    <View style={[styles.container, { backgroundColor: pageBg }]}>
      <StatusBar translucent backgroundColor="transparent" barStyle={scrolledPastHeader && !isDarkMode ? "dark-content" : "light-content"} />

      {/* Floating top bar — SafeAreaView auto-applies the correct top inset */}
      <SafeAreaView
        edges={['top']}
        style={[
          styles.topBarSafe,
          {
            backgroundColor: scrolledPastHeader ? cardBg : 'transparent',
            borderBottomColor: scrolledPastHeader ? borderClr : 'transparent',
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
              <Text style={[styles.collapsedSub, { color: subText }]} numberOfLines={1}>
                {isOnline ? 'online' : (lastSeen ? `last seen ${lastSeen}` : '')}
              </Text>
            </View>
          )}

          <TouchableOpacity
            style={[styles.topBarBtn, !scrolledPastHeader && styles.topBarBtnFloating]}
            activeOpacity={0.7}
          >
            <MaterialCommunityIcons name="dots-vertical" size={22} color={scrolledPastHeader ? primaryText : '#fff'} />
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      <ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 32 }}
      >
        {/* ─── Telegram-style Hero ─── */}
        <View style={[styles.hero, { backgroundColor: imageSource ? '#000' : avatarBgColor }]}>
          {imageSource ? (
            <Image source={imageSource} style={styles.heroImage} resizeMode="cover" />
          ) : (
            <View style={styles.heroFallback}>
              <Text style={styles.heroInitial}>{initial}</Text>
            </View>
          )}

          {/* Smooth dark gradient at bottom of hero — many thin bands fake a gradient */}
          <HeroGradient />

          {/* Name + status overlay */}
          <View style={styles.heroOverlay} pointerEvents="none">
            <View style={styles.heroNameRow}>
              <Text style={styles.heroName} numberOfLines={1}>{displayName}</Text>
              {isOnline && <View style={styles.heroOnlineDot} />}
            </View>
            <Text style={styles.heroStatus} numberOfLines={1}>
              {isOnline ? 'online' : (lastSeen ? `last seen ${lastSeen}` : 'tap for info')}
            </Text>
          </View>
        </View>

        {/* ─── Action Pills Row ─── */}
        <View style={[styles.actionsCard, { backgroundColor: cardBg }]}>
          <ActionPill icon="chatbubble" label="Message" color={themeColor} onPress={handleMessage} textColor={primaryText} />
          <ActionPill
            icon={isMuted ? 'volume-mute' : 'notifications-outline'}
            label={isMuted ? 'Unmute' : 'Mute'}
            color={isMuted ? '#F0A030' : themeColor}
            onPress={handleMutePress}
            textColor={primaryText}
          />
          <ActionPill icon="call" label="Call" color={themeColor} onPress={handleCall} textColor={primaryText} />
          <ActionPill icon="videocam" label="Video" color={themeColor} onPress={() => {}} textColor={primaryText} />
        </View>

        {/* ─── Info / Bio Card ─── */}
        <Text style={[styles.sectionLabel, { color: subText }]}>INFO</Text>
        <View style={[styles.card, { backgroundColor: cardBg }]}>
          {/* Phone row */}
          <InfoRow
            icon="call-outline"
            iconColor={themeColor}
            value={displayPhone || 'Unknown'}
            label="mobile"
            primary={primaryText}
            sub={subText}
            onPress={() => {
              const fullPhone = countryCode ? `${countryCode}${phoneNumber}` : phoneNumber;
              if (fullPhone) Linking.openURL(`tel:${fullPhone}`).catch(() => {});
            }}
          />

          {about ? (
            <>
              <View style={[styles.divider, { backgroundColor: borderClr }]} />
              <InfoRow
                icon="information-circle-outline"
                iconColor={themeColor}
                value={about}
                label="bio"
                primary={primaryText}
                sub={subText}
                multiline
              />
            </>
          ) : null}

          {(peerProfile?.email || peer?.email) ? (
            <>
              <View style={[styles.divider, { backgroundColor: borderClr }]} />
              <InfoRow
                icon="mail-outline"
                iconColor={themeColor}
                value={peerProfile?.email || peer?.email}
                label="email"
                primary={primaryText}
                sub={subText}
              />
            </>
          ) : null}

          {(peer?.userName || peerProfile?.userName) ? (
            <>
              <View style={[styles.divider, { backgroundColor: borderClr }]} />
              <InfoRow
                icon="at-outline"
                iconColor={themeColor}
                value={`@${peer?.userName || peerProfile?.userName}`}
                label="username"
                primary={primaryText}
                sub={subText}
              />
            </>
          ) : null}
        </View>

        {/* ─── Save Contact Card ─── */}
        {!isInDeviceBook && !contactJustSaved && (
          <View style={[styles.card, { backgroundColor: cardBg, marginTop: 14 }]}>
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
                  <Ionicons name="person-add-outline" size={20} color={themeColor} />
                )}
              </View>
              <Text style={[styles.rowAction, { color: themeColor }]}>
                {isSavingContact ? 'Saving…' : 'Save Contact'}
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
          <View style={[styles.card, { backgroundColor: cardBg, marginTop: 14 }]}>
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

// Smooth bottom gradient (faked via 14 thin stacked bands, ~14px each).
// Each band has a slightly higher alpha than the previous → no hard edges,
// no "double shade" effect from stacking just 2 overlays.
const GRADIENT_BANDS = 14;
const GRADIENT_HEIGHT = 220; // total fade height in px
function HeroGradient() {
  const bandHeight = GRADIENT_HEIGHT / GRADIENT_BANDS;
  return (
    <View pointerEvents="none" style={styles.gradientWrap}>
      {Array.from({ length: GRADIENT_BANDS }).map((_, i) => {
        // Quadratic easing → softer top, deeper bottom
        const t = (i + 1) / GRADIENT_BANDS;
        const alpha = Math.min(0.62, t * t * 0.7);
        return (
          <View
            key={i}
            style={{
              height: bandHeight,
              backgroundColor: `rgba(0,0,0,${alpha.toFixed(3)})`,
            }}
          />
        );
      })}
    </View>
  );
}

function ActionPill({ icon, label, color, onPress, textColor }) {
  return (
    <TouchableOpacity style={styles.actionPill} onPress={onPress} activeOpacity={0.7}>
      <View style={[styles.actionPillIcon, { backgroundColor: color + '15' }]}>
        <Ionicons name={icon} size={22} color={color} />
      </View>
      <Text style={[styles.actionPillLabel, { color: textColor }]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

function InfoRow({ icon, iconColor, value, label, primary, sub, onPress, multiline }) {
  const Wrapper = onPress ? TouchableOpacity : View;
  return (
    <Wrapper style={styles.card_row} onPress={onPress} activeOpacity={0.6}>
      <View style={[styles.rowIconWrap, { backgroundColor: iconColor + '15' }]}>
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
        <Text style={[styles.rowLabel, { color: sub }]}>{label}</Text>
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
    top: 0,
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
    fontSize: 110,
    fontFamily: 'Roboto-SemiBold',
    includeFontPadding: false,
  },
  // Wrapper for the smooth gradient (bands rendered by <HeroGradient />)
  gradientWrap: {
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
  heroNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  heroName: {
    color: '#fff',
    fontFamily: 'Roboto-SemiBold',
    fontSize: 26,
    flexShrink: 1,
    textShadowColor: 'rgba(0,0,0,0.4)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  heroOnlineDot: {
    width: 11,
    height: 11,
    borderRadius: 6,
    backgroundColor: '#25D366',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.85)',
  },
  heroStatus: {
    color: 'rgba(255,255,255,0.88)',
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    marginTop: 4,
    textShadowColor: 'rgba(0,0,0,0.4)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },

  // ── Action pills (right under hero) ──
  actionsCard: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 14,
    paddingHorizontal: 6,
    marginTop: 0,
  },
  actionPill: {
    alignItems: 'center',
    flex: 1,
    paddingVertical: 4,
  },
  actionPillIcon: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  actionPillLabel: {
    fontFamily: 'Roboto-Medium',
    fontSize: 11.5,
  },

  // ── Section label (small, above each card) ──
  sectionLabel: {
    fontFamily: 'Roboto-Medium',
    fontSize: 11,
    letterSpacing: 0.8,
    marginTop: 14,
    marginBottom: 6,
    paddingHorizontal: 24,
  },

  // ── Card (rounded container with rows) ──
  card: {
    marginHorizontal: 12,
    borderRadius: 14,
    paddingHorizontal: 4,
    overflow: 'hidden',
  },
  card_row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
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
    fontSize: 15,
  },
  rowLabel: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 2,
  },
  rowAction: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 14,
    flex: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 64,
  },
  errorText: {
    color: '#FF3B30',
    fontSize: 12,
    paddingHorizontal: 18,
    paddingBottom: 10,
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
