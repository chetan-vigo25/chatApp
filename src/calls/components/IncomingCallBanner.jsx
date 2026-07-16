import React, { useEffect, useRef } from 'react';
import {
  Animated, View, Text, TouchableOpacity, StyleSheet, Pressable, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useCall } from '../useCall';
import { useTheme } from '../../contexts/ThemeContext';
import useContactDirectory from '../../hooks/useContactDirectory';
import { CALL_STATUS } from '../state/callMachine';
import CallAvatar from './CallAvatar';
import nativeCall from '../services/nativeCallService';

/**
 * WhatsApp-style compact incoming-call heads-up banner.
 *
 * Shows at the top of the app while a call is RINGING and the user hasn't
 * answered yet (and hasn't expanded it to the full-screen ring screen). It lets
 * the user keep using the app and answer/decline in place, exactly like
 * WhatsApp's foreground call banner. Tapping the body expands to the full-screen
 * CallOverlay; Answer accepts (which opens the connecting call screen); Decline
 * rejects. The full-screen incoming UI in CallOverlay is suppressed while this
 * banner is up (see `incomingExpanded`).
 *
 * The background / app-closed equivalent is the OS notification presented by
 * fcmService (`presentIncomingCallNotification`) — this component only covers the
 * in-app foreground case.
 */
export default function IncomingCallBanner() {
  const {
    call, accept, reject, expandIncoming,
  } = useCall();
  const insets = useSafeAreaInsets();
  const { resolveName } = useContactDirectory();
  // Theme-aware card: light surface + dark text in light mode, dark surface +
  // white text in dark mode. The red Decline / green Answer stay constant (they
  // read on both), matching WhatsApp.
  const { theme, isDarkMode } = useTheme();
  const c = theme.colors;
  const avatarBg = isDarkMode ? '#0B141A' : '#E9EDEF';

  const status = call?.status || CALL_STATUS.IDLE;
  const accepted = !!call?.accepted;
  // A foreground call is presented ONLY via the OS push notification, so the
  // in-app banner stays hidden for it (notificationOnly).
  const notificationOnly = !!call?.notificationOnly;
  // iOS + CallKit: the SYSTEM call banner/screen is the one and only ring UI —
  // never stack this in-app banner on top of it. Two ring UIs at once let the
  // user answer in-app while CallKit kept ringing (dead audio session, banner
  // stuck). The CallKit answer flows back into the app via onAnswer.
  const callKitRings = Platform.OS === 'ios' && nativeCall.isAvailable();
  // Only ring as a banner: an unanswered incoming call that hasn't been expanded
  // to the full-screen ring screen.
  const visible = status === CALL_STATUS.INCOMING && !accepted
    && !call?.incomingExpanded && !notificationOnly && !callKitRings;

  const translateY = useRef(new Animated.Value(-220)).current;
  useEffect(() => {
    Animated.spring(translateY, {
      toValue: visible ? 0 : -220,
      useNativeDriver: true,
      bounciness: visible ? 7 : 0,
      speed: 14,
    }).start();
  }, [visible, translateY]);

  // Stay mounted for the whole INCOMING phase so `visible` can slide the card
  // off-screen (on accept / expand) instead of popping; unmount once the call
  // leaves the ringing state entirely. A notification-only (foreground) call
  // never shows the banner at all.
  if (status !== CALL_STATUS.INCOMING || notificationOnly) return null;

  const peer = call?.peer || {};
  const isVideo = call?.media === 'video';
  const isGroup = !!call?.isGroup;
  const displayName = isGroup
    ? (call?.groupName || 'Group call')
    : (resolveName(peer?.id, peer?.name, peer?.mobile || peer?.phone || peer?.mobileNumber) || peer?.name || 'Unknown');
  const subtitle = isGroup
    ? `Incoming group ${isVideo ? 'video' : 'voice'} call`
    : (isVideo ? 'Incoming video call' : 'Incoming voice call');

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.host, { top: insets.top + 8, transform: [{ translateY }] }]}
    >
      <Pressable
        onPress={() => expandIncoming && expandIncoming()}
        android_ripple={{ color: isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }}
        style={[styles.card, { backgroundColor: c.cardBackground }]}
      >
        <View style={styles.header}>
          <View style={[styles.avatarWrap, { backgroundColor: avatarBg }]}>
            <CallAvatar uri={peer?.avatar} name={isGroup ? displayName : peer?.name} id={peer?.id} size={42} />
          </View>
          <View style={styles.titleCol}>
            <Text style={[styles.name, { color: c.primaryTextColor }]} numberOfLines={1}>{displayName}</Text>
            <View style={styles.subRow}>
              <Ionicons name={isVideo ? 'videocam' : 'call'} size={13} color={c.secondaryTextColor} />
              <Text style={[styles.sub, { color: c.secondaryTextColor }]} numberOfLines={1}>{subtitle}</Text>
            </View>
          </View>
        </View>

        <View style={styles.actions}>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => reject && reject()}
            style={[styles.btn, styles.decline]}
          >
            <MaterialIcons name="call-end" size={20} color="#fff" />
            <Text style={styles.btnText}>Decline</Text>
          </TouchableOpacity>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => accept && accept()}
            style={[styles.btn, styles.accept]}
          >
            <Ionicons name={isVideo ? 'videocam' : 'call'} size={19} color="#fff" />
            <Text style={styles.btnText}>Answer</Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 8,
    right: 8,
    // Above the message banner / navigation, below nothing — it's the call ring.
    zIndex: 10000,
    elevation: 10000,
  },
  card: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    ...Platform.select({ android: { elevation: 12 } }),
  },
  header: { flexDirection: 'row', alignItems: 'center' },
  avatarWrap: {
    width: 42, height: 42, borderRadius: 21, overflow: 'hidden',
    marginRight: 12,
  },
  titleCol: { flex: 1 },
  name: { fontFamily: 'Roboto-SemiBold', fontSize: 16 },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  sub: { fontFamily: 'Roboto-Regular', fontSize: 13 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  btn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 42,
    borderRadius: 22,
  },
  decline: { backgroundColor: '#EA0038' },
  accept: { backgroundColor: '#03b0a2' },
  btnText: { color: '#fff', fontFamily: 'Roboto-Medium', fontSize: 15 },
});
