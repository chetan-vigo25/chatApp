/**
 * The card shown after a contact QR resolves — details only, never the full
 * profile.
 *
 * Buttons are gated on the server's flags, not re-derived here:
 *   canSave → "Save contact" (hidden, not disabled, when false)
 *   canChat → "Chat" (works with or without a number)
 *
 * Saving reuses useSaveContact (permission → sync gate → phone-book check →
 * save → contact:sync + chat-list reload). Once the save lands, the 1:1
 * connection is created in the background with `chat:create` unless a chat
 * already exists. "Chat" is handled by the screen (it navigates).
 */
import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Animated,
  Platform,
  ToastAndroid,
  Alert,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../../../contexts/ThemeContext';
import { useRealtimeChatLists } from '../../../contexts/RealtimeChatContext';
import VerifiedBadge from '../../../components/VerifiedBadge';
import useSaveContact, { SAVE_CONTACT_STATUS } from '../../../hooks/useSaveContact';
import { findExistingChatFor } from '../../../hooks/useOpenUserChat';
import { formatPhoneNumber } from '../../../services/contactNameStore';
import { connectWithUser } from '../services/contactQrApi';

const AVATAR_COLORS = ['#6C5CE7', '#00B894', '#E17055', '#0984E3', '#D63031', '#E84393', '#00CEC9'];

const showToast = (msg) => {
  if (Platform.OS === 'android') ToastAndroid.show(msg, ToastAndroid.SHORT);
  else Alert.alert('', msg);
};

const colorFor = (key) => {
  let hash = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

export default function ScannedContactSheet({ card, onScanAgain, onDone, onChat, chatBusy = false }) {
  const { theme, isDarkMode } = useTheme();
  const slide = useRef(new Animated.Value(320)).current;

  let chatList = [];
  try {
    chatList = useRealtimeChatLists().chatList || [];
  } catch { /* provider missing — connection falls back to the server's chatId */ }
  const chatListRef = useRef(chatList);
  chatListRef.current = chatList;

  const phone = card?.mobile ? `${card.mobile.code || ''}${card.mobile.number}` : '';
  // The server already substitutes the @handle for a hidden owner.
  const displayName = card?.fullName || (card?.userName ? `@${card.userName}` : 'TalksTry user');

  const peerForSave = card?.canSave
    ? {
      _id: card.userId,
      fullName: card.fullName,
      mobileNumber: phone,
      mobile: card.mobile,
      profileImage: card.profileImage,
    }
    : null;

  const {
    status,
    isSaving,
    isSyncing,
    savedSuccessfully,
    saveError,
    saveContact,
    syncNow,
    requestPermission,
  } = useSaveContact(peerForSave);

  useEffect(() => {
    Animated.spring(slide, { toValue: 0, tension: 70, friction: 12, useNativeDriver: true }).start();
  }, [slide]);

  // Save landed → create the connection once, without leaving the scanner.
  // An existing chat (server chatId, or one already in the list) is left alone;
  // useSaveContact's post-save reload refreshes it.
  const connectedRef = useRef(false);
  useEffect(() => {
    if (!savedSuccessfully || connectedRef.current || !card?.userId) return;
    connectedRef.current = true;
    const hasChat = card.chatId
      || findExistingChatFor(chatListRef.current, { _id: card.userId, userId: card.userId });
    if (!hasChat) connectWithUser(card.userId);
    showToast('Contact saved');
  }, [savedSuccessfully, card]);

  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.secondaryTextColor;
  const accent = theme.colors.themeColor;
  const outline = isDarkMode ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.14)';

  const renderNotice = (icon, text, color = subText) => (
    <View style={styles.notice}>
      <MaterialCommunityIcons name={icon} size={18} color={color} />
      <Text style={[styles.noticeText, { color }]}>{text}</Text>
    </View>
  );

  const renderButton = ({ key, label, onPress, icon, filled, busy = false, disabled = false }) => (
    <TouchableOpacity
      key={key}
      onPress={onPress}
      disabled={disabled || busy}
      activeOpacity={0.85}
      style={[
        styles.btn,
        filled ? { backgroundColor: accent } : [styles.btnOutline, { borderColor: outline }],
      ]}
    >
      {busy
        ? <ActivityIndicator size="small" color={filled ? '#fff' : accent} />
        : (icon ? <Ionicons name={icon} size={18} color={filled ? '#fff' : primaryText} /> : null)}
      <Text style={[styles.btnText, { color: filled ? '#fff' : primaryText }]}>{label}</Text>
    </TouchableOpacity>
  );

  const renderLink = () => {
    const done = savedSuccessfully && onDone;
    return (
      <TouchableOpacity onPress={done ? onDone : onScanAgain} style={styles.link} activeOpacity={0.6}>
        <Text style={[styles.linkText, { color: accent }]}>{done ? 'Done' : 'Scan again'}</Text>
      </TouchableOpacity>
    );
  };

  const renderSaveButton = (filled) => {
    if (status === SAVE_CONTACT_STATUS.SAVED) {
      return renderButton({ key: 'save', label: 'Saved', icon: 'checkmark-circle-outline', filled: false, disabled: true });
    }
    if (status === SAVE_CONTACT_STATUS.PERMISSION) {
      return renderButton({ key: 'save', label: 'Allow contacts', icon: 'people-outline', filled, onPress: requestPermission });
    }
    if (status === SAVE_CONTACT_STATUS.NEEDS_SYNC) {
      return renderButton({ key: 'save', label: 'Sync contacts', icon: 'sync-outline', filled, onPress: syncNow, busy: isSyncing });
    }
    return renderButton({
      key: 'save',
      label: 'Save contact',
      icon: 'person-add-outline',
      filled,
      onPress: saveContact,
      busy: isSaving || isSyncing || status === SAVE_CONTACT_STATUS.CHECKING,
    });
  };

  const renderActions = () => {
    if (card.isSelf) {
      return (
        <>
          {renderNotice('account-check-outline', 'This is your QR code.')}
          {renderLink()}
        </>
      );
    }
    if (!card.canChat) {
      return (
        <>
          {card.isBlocked
            ? renderNotice('block-helper', "You've blocked this contact. Unblock them to continue.", theme.colors.danger)
            : null}
          {renderLink()}
        </>
      );
    }

    let hint = null;
    if (card.canSave) {
      if (status === SAVE_CONTACT_STATUS.SAVED) {
        hint = renderNotice('check-circle', savedSuccessfully ? 'Contact saved' : 'Already in your contacts', accent);
      } else if (status === SAVE_CONTACT_STATUS.PERMISSION) {
        hint = renderNotice('information-outline', 'Contacts access is needed to save this person to your phone.');
      } else if (status === SAVE_CONTACT_STATUS.NEEDS_SYNC) {
        hint = renderNotice('information-outline', 'Sync your contacts first so we can check whether this number is already saved.');
      }
    }

    // Save leads while it is still to do; once saved (or when it isn't offered)
    // Chat becomes the one filled button, so a single button never looks
    // secondary and two never compete.
    const saveIsPrimary = card.canSave && status !== SAVE_CONTACT_STATUS.SAVED;

    return (
      <>
        {hint}
        {saveError ? renderNotice(
          'alert-circle-outline',
          saveError === 'permission_denied'
            ? 'Contacts permission was denied. Allow it in Settings to save.'
            : saveError,
          theme.colors.danger,
        ) : null}
        <View style={styles.row}>
          {card.canSave ? renderSaveButton(saveIsPrimary) : null}
          {renderButton({
            key: 'chat',
            label: 'Chat',
            icon: 'chatbubble-ellipses-outline',
            filled: !saveIsPrimary,
            onPress: onChat,
            busy: chatBusy,
          })}
        </View>
        {renderLink()}
      </>
    );
  };

  if (!card) return null;

  return (
    <Animated.View
      style={[
        styles.sheet,
        { backgroundColor: theme.colors.cardBackground, transform: [{ translateY: slide }] },
      ]}
    >
      <View style={[styles.handle, { backgroundColor: outline }]} />

      <View style={styles.identity}>
        <View style={[styles.avatar, { backgroundColor: colorFor(card.userId || displayName) }]}>
          {card.profileImage ? (
            <Image source={{ uri: card.profileImage }} style={styles.avatarImg} />
          ) : (
            <Text style={styles.avatarText}>{displayName.replace(/^@/, '').charAt(0).toUpperCase()}</Text>
          )}
        </View>
        <View style={styles.identityText}>
          <View style={styles.nameRow}>
            <Text style={[styles.name, { color: primaryText }]} numberOfLines={1}>{displayName}</Text>
            <VerifiedBadge verified={card.isVerified} size={16} />
          </View>
          {card.userName && !displayName.startsWith('@') ? (
            <Text style={[styles.sub, { color: subText }]} numberOfLines={1}>@{card.userName}</Text>
          ) : null}
          {phone ? (
            <Text style={[styles.sub, { color: subText }]} numberOfLines={1}>{formatPhoneNumber(phone)}</Text>
          ) : null}
        </View>
      </View>

      {renderActions()}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 16,
    zIndex: 20,
    elevation: 12,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginBottom: 16 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatar: {
    width: 60, height: 60, borderRadius: 30,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  avatarImg: { width: 60, height: 60, borderRadius: 30 },
  avatarText: { color: '#fff', fontFamily: 'Roboto-Bold', fontSize: 22 },
  identityText: { flex: 1, gap: 2 },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  name: { fontFamily: 'Roboto-SemiBold', fontSize: 18, flexShrink: 1 },
  sub: { fontFamily: 'Roboto-Regular', fontSize: 13.5 },

  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 16 },
  noticeText: { flex: 1, fontFamily: 'Roboto-Regular', fontSize: 13.5, lineHeight: 19 },

  // One button fills the row; two split it evenly — no gap left by a hidden one.
  row: { flexDirection: 'row', gap: 12, marginTop: 18 },
  btn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 13, borderRadius: 30,
  },
  btnOutline: { borderWidth: 1 },
  btnText: { fontFamily: 'Roboto-SemiBold', fontSize: 15 },

  link: { alignSelf: 'center', marginTop: 12, paddingVertical: 8, paddingHorizontal: 16 },
  linkText: { fontFamily: 'Roboto-Medium', fontSize: 14 },
});
