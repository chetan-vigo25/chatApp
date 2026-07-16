/**
 * UserDetailsSheet
 *
 * WhatsApp-style draggable bottom sheet shown when a user taps a contact's
 * profile photo (e.g. from the chat header). It slides up from the bottom,
 * can be dragged down to dismiss, and shows the *complete* user details
 * (photo, name, online / last-seen, about, phone) plus the primary actions:
 * Message · Audio · Video, and a "View full info" link to the full contact
 * page (UserB).
 *
 * Self-sufficient: given a `peerId` it fetches the live profile + the locally
 * saved contact, applying the same display rules used across the app
 * (saved-contact name wins, live server photo wins). Callers only pass the
 * peer id + a few fallbacks and the action callbacks.
 *
 * Pure React Native — Animated + PanResponder for the drag (no gesture-handler
 * dependency), so it renders identically on Android + iOS.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Image,
  Modal,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../contexts/ThemeContext';
import { useCall } from '../calls/useCall';
import { profileServices } from '../Redux/Services/Profile/Profile.Services';
import ContactDatabase from '../services/ContactDatabase';

const { height: SCREEN_H } = Dimensions.get('window');

export default function UserDetailsSheet({
  visible,
  onClose,
  peerId,
  fallbackName = 'User',
  fallbackImage = null,
  avatarColor = '#6C5CE7',
  onMessage,
  onViewFullInfo,
}) {
  const { theme, isDarkMode } = useTheme();
  const insets = useSafeAreaInsets();
  const { startAudioCall, startVideoCall, callBusy } = useCall();

  const translateY = useRef(new Animated.Value(SCREEN_H)).current;
  const backdrop = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);
  const [profile, setProfile] = useState(null);
  const [localContact, setLocalContact] = useState(null);

  // ── Open / close animation ──
  useEffect(() => {
    if (visible) {
      setMounted(true);
      translateY.setValue(SCREEN_H);
      Animated.parallel([
        Animated.spring(translateY, { toValue: 0, tension: 62, friction: 11, useNativeDriver: true }),
        Animated.timing(backdrop, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();
    } else if (mounted) {
      Animated.parallel([
        Animated.timing(translateY, { toValue: SCREEN_H, duration: 200, useNativeDriver: true }),
        Animated.timing(backdrop, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start(() => setMounted(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // ── Fetch complete details (live profile + locally-saved contact) ──
  useEffect(() => {
    if (!visible || !peerId) return undefined;
    let cancelled = false;
    profileServices.profileDetails(peerId)
      .then((r) => { if (!cancelled) setProfile(r?.data || null); })
      .catch(() => {});
    ContactDatabase.getContactByUserId(String(peerId))
      .then((r) => { if (!cancelled) setLocalContact(r || null); })
      .catch(() => { if (!cancelled) setLocalContact(null); });
    return () => { cancelled = true; };
  }, [visible, peerId]);

  // Drag-to-dismiss — attached to the grab-handle / header region only so the
  // body taps still work.
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_, g) => { if (g.dy > 0) translateY.setValue(g.dy); },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 120 || g.vy > 0.8) {
          onClose?.();
        } else {
          Animated.spring(translateY, { toValue: 0, tension: 62, friction: 11, useNativeDriver: true }).start();
        }
      },
    }),
  ).current;

  if (!mounted) return null;

  // ── Display rules (mirror UserB / the chat header) ──
  const name =
    localContact?.fullName ||
    (profile?.isSavedContact ? profile?.displayName : null) ||
    fallbackName ||
    profile?.fullName ||
    'User';
  const initial = (name || '?').charAt(0).toUpperCase();
  const image =
    profile?.profileImage ||
    localContact?.profileImage ||
    fallbackImage ||
    null;
  const imageSource = image ? (typeof image === 'string' ? { uri: image } : image) : null;
  const about = profile?.about || '';
  const code = profile?.mobile?.code || profile?.mobile?.countryCode || '';
  const number = localContact?.normalizedPhone || profile?.mobile?.number || '';
  const phone = localContact?.normalizedPhone
    ? localContact.normalizedPhone
    : (code ? `${code} ${number}` : number);
  const isOnline = Boolean(profile?.isOnline);
  const lastSeen = profile?.lastSeen;
  const statusLine = isOnline ? 'online' : (lastSeen ? `last seen ${lastSeen}` : '');

  const pageBg = theme.colors.background;
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.secondaryTextColor || theme.colors.placeHolderTextColor;
  const dividerClr = theme.colors.borderColor;
  const themeColor = theme.colors.themeColor;

  const close = () => onClose?.();
  const handleMessage = () => { close(); onMessage?.(); };
  const handleInfo = () => { close(); onViewFullInfo?.(); };
  const handleAudio = () => {
    close();
    if (peerId && startAudioCall) startAudioCall({ id: String(peerId), name, avatar: image || null });
  };
  const handleVideo = () => {
    close();
    if (peerId && startVideoCall) startVideoCall({ id: String(peerId), name, avatar: image || null });
  };

  return (
    <Modal transparent visible={mounted} onRequestClose={close} statusBarTranslucent>
      <View style={styles.fill}>
        <Animated.View style={[styles.backdrop, { opacity: backdrop }]}>
          <TouchableOpacity style={styles.fill} activeOpacity={1} onPress={close} />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: pageBg,
              paddingBottom: insets.bottom + 14,
              transform: [{ translateY }],
            },
          ]}
        >
          {/* Grab handle + drag region */}
          <View {...pan.panHandlers} style={styles.grabWrap}>
            <View style={[styles.grabBar, { backgroundColor: subText + '55' }]} />
          </View>

          {/* Avatar */}
          <View style={styles.avatarWrap}>
            {imageSource ? (
              <Image source={imageSource} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: avatarColor }]}>
                <Text style={styles.avatarLetter}>{initial}</Text>
              </View>
            )}
            {isOnline && <View style={[styles.onlineDot, { borderColor: pageBg }]} />}
          </View>

          {/* Name + status */}
          <Text style={[styles.name, { color: primaryText }]} numberOfLines={1}>{name}</Text>
          {!!statusLine && (
            <Text style={[styles.status, { color: isOnline ? '#03b0a2' : subText }]} numberOfLines={1}>
              {statusLine}
            </Text>
          )}

          {/* Action row: Message · Audio · Video */}
          <View style={[styles.actionsCard, { borderColor: dividerClr }]}>
            <ActionCol icon="chatbubble" label="Message" color={themeColor} onPress={handleMessage} />
            <View style={[styles.vDivider, { backgroundColor: dividerClr }]} />
            <ActionCol icon="call" label="Audio" color={themeColor} onPress={handleAudio} disabled={callBusy} />
            <View style={[styles.vDivider, { backgroundColor: dividerClr }]} />
            <ActionCol icon="videocam" label="Video" color={themeColor} onPress={handleVideo} disabled={callBusy} />
          </View>

          {/* About */}
          {!!about && (
            <View style={[styles.infoCard, { borderColor: dividerClr }]}>
              <Text style={[styles.infoValue, { color: primaryText }]} numberOfLines={3}>{about}</Text>
              <Text style={[styles.infoLabel, { color: subText }]}>About</Text>
            </View>
          )}

          {/* Phone */}
          {!!phone && (
            <View style={[styles.infoCard, { borderColor: dividerClr }]}>
              <Text style={[styles.infoValue, { color: primaryText }]} numberOfLines={1}>{phone}</Text>
              <Text style={[styles.infoLabel, { color: subText }]}>Mobile</Text>
            </View>
          )}

          {/* View full info → UserB */}
          {typeof onViewFullInfo === 'function' && (
            <TouchableOpacity
              style={[styles.fullInfoRow, { borderColor: dividerClr }]}
              activeOpacity={0.6}
              onPress={handleInfo}
            >
              <View style={[styles.fullInfoIcon, { backgroundColor: themeColor + '18' }]}>
                <Ionicons name="information-circle-outline" size={20} color={themeColor} />
              </View>
              <Text style={[styles.fullInfoText, { color: themeColor }]}>View full info</Text>
              <MaterialCommunityIcons name="chevron-right" size={22} color={subText} />
            </TouchableOpacity>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

function ActionCol({ icon, label, color, onPress, disabled }) {
  return (
    <TouchableOpacity
      style={[styles.actionCol, disabled && styles.actionColDisabled]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.6}
    >
      <Ionicons name={icon} size={24} color={color} />
      <Text style={[styles.actionColLabel, { color }]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 14,
    paddingTop: 8,
    alignItems: 'center',
    elevation: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.25,
    shadowRadius: 18,
  },
  grabWrap: {
    width: '100%',
    alignItems: 'center',
    paddingVertical: 8,
  },
  grabBar: {
    width: 40,
    height: 4.5,
    borderRadius: 3,
  },

  avatarWrap: {
    marginTop: 6,
    marginBottom: 12,
  },
  avatar: {
    width: 104,
    height: 104,
    borderRadius: 52,
  },
  avatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    color: '#fff',
    fontFamily: 'Roboto-Bold',
    fontSize: 44,
  },
  onlineDot: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#03b0a2',
    borderWidth: 3,
  },

  name: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 21,
    letterSpacing: 0.1,
    maxWidth: '90%',
    textAlign: 'center',
  },
  status: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13.5,
    marginTop: 4,
  },

  actionsCard: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    marginTop: 18,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  actionCol: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  actionColDisabled: { opacity: 0.4 },
  vDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    marginVertical: 12,
  },
  actionColLabel: {
    fontFamily: 'Roboto-Medium',
    fontSize: 13,
  },

  infoCard: {
    alignSelf: 'stretch',
    marginTop: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  infoValue: {
    fontFamily: 'Roboto-Regular',
    fontSize: 16.5,
  },
  infoLabel: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13.5,
    marginTop: 3,
  },

  fullInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    marginTop: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 14,
  },
  fullInfoIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullInfoText: {
    flex: 1,
    fontFamily: 'Roboto-Medium',
    fontSize: 15.5,
  },
});
