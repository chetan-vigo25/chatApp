import React, { useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, Easing, PanResponder,
} from 'react-native';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import CallAvatar from './CallAvatar';

/**
 * Incoming-call screen body — WhatsApp style:
 *   top    → caller NAME (big, centered) + app/call-type line (+ number if known)
 *   middle → large round avatar
 *   bottom → [ Decline ]   [ animated SWIPE-UP-TO-ACCEPT ]
 *
 * The green Accept button both TAPS and SWIPES UP (drag past the threshold =
 * accept), with three chevrons rippling upward above it — the WhatsApp
 * "swipe up to accept" affordance. Theme-aware: text/labels follow light/dark;
 * the green Accept / red Decline stay constant on both themes.
 */

const SWIPE_ACCEPT_DY = -70; // drag this far up = accept

export default function IncomingCallCard({
  peer, displayName, media, onAccept, onReject,
}) {
  const isVideo = media === 'video';
  const { theme, isDarkMode } = useTheme();
  const c = theme.colors;
  const onBg = isDarkMode ? '#FFFFFF' : c.primaryTextColor;
  const onBgSoft = isDarkMode ? 'rgba(255,255,255,0.8)' : c.secondaryTextColor;

  // ---- swipe-up-to-accept ----
  const dragY = useRef(new Animated.Value(0)).current;
  const acceptedRef = useRef(false);
  const fireAccept = () => {
    if (acceptedRef.current) return;
    acceptedRef.current = true;
    onAccept && onAccept();
  };
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 4,
    onPanResponderMove: (_e, g) => {
      // Only follow upward drags (clamped) — downward does nothing.
      dragY.setValue(Math.max(Math.min(g.dy, 0), -120));
    },
    onPanResponderRelease: (_e, g) => {
      if (g.dy <= SWIPE_ACCEPT_DY) {
        fireAccept();
        dragY.setValue(0);
        return;
      }
      // A near-still release is a TAP — accept too (chevrons only hint the swipe).
      if (Math.abs(g.dy) < 6 && Math.abs(g.dx) < 6) {
        fireAccept();
      }
      Animated.spring(dragY, { toValue: 0, useNativeDriver: true, friction: 6 }).start();
    },
    onPanResponderTerminate: () => {
      Animated.spring(dragY, { toValue: 0, useNativeDriver: true, friction: 6 }).start();
    },
  })).current;

  // ---- chevron ripple above the accept button (the "swipe up" hint) ----
  // One looping driver; the three chevrons read staggered slices of it so they
  // light up bottom→top like WhatsApp's.
  const ripple = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(ripple, {
      toValue: 1, duration: 1600, easing: Easing.inOut(Easing.ease), useNativeDriver: true,
    }));
    loop.start();
    return () => loop.stop();
  }, [ripple]);
  const chevronStyle = (i) => {
    // Slices: chevron 0 (closest to the button) brightens first.
    const start = i * 0.18;
    const opacity = ripple.interpolate({
      inputRange: [0, start, start + 0.25, Math.min(start + 0.5, 1), 1],
      outputRange: [0.25, 0.25, 1, 0.25, 0.25],
    });
    const translateY = ripple.interpolate({
      inputRange: [0, 1],
      outputRange: [4, -4],
    });
    return { opacity, transform: [{ translateY }] };
  };

  return (
    <View style={styles.wrap}>
      {/* ---- caller identity (top, WhatsApp-style) ---- */}
      <View style={styles.top}>
        <Text style={[styles.name, { color: onBg }]} numberOfLines={1}>
          {displayName || peer?.name || 'Unknown'}
        </Text>
        <View style={styles.mediaRow}>
          <Ionicons name={isVideo ? 'videocam' : 'call'} size={15} color={onBgSoft} />
          <Text style={[styles.mediaText, { color: onBgSoft }]}>
            {peer?.mobile || peer?.phone || (isVideo ? 'Incoming video call' : 'Incoming voice call')}
          </Text>
        </View>
      </View>

      {/* ---- avatar (center) ---- */}
      <View style={styles.avatarWrap}>
        <CallAvatar uri={peer?.avatar} name={peer?.name} id={peer?.id} size={170} />
      </View>

      {/* ---- actions (bottom): Decline · Swipe-up Accept · Message ---- */}
      <View style={styles.actions}>
        <View style={styles.actionItem}>
          <TouchableOpacity activeOpacity={0.85} onPress={onReject} style={[styles.sideBtn, styles.decline]}>
            <MaterialIcons name="call-end" size={30} color="#fff" />
          </TouchableOpacity>
          <Text style={[styles.actionLabel, { color: onBgSoft }]}>Decline</Text>
        </View>

        <View style={styles.actionItem}>
          <View style={styles.chevrons} pointerEvents="none">
            {[2, 1, 0].map((i) => (
              <Animated.View key={i} style={chevronStyle(i)}>
                <Ionicons name="chevron-up" size={20} color={onBgSoft} />
              </Animated.View>
            ))}
          </View>
          <Animated.View style={{ transform: [{ translateY: dragY }] }} {...pan.panHandlers}>
            <View style={[styles.acceptBtn]}>
              <Ionicons name={isVideo ? 'videocam' : 'call'} size={32} color="#fff" />
            </View>
          </Animated.View>
          <Text style={[styles.actionLabel, { color: onBgSoft }]}>Swipe up to accept</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', paddingTop: 60, paddingBottom: 44 },
  top: { alignItems: 'center' },
  name: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 30,
    maxWidth: '85%',
    textAlign: 'center',
  },
  mediaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  mediaText: { fontFamily: 'Roboto-Regular', fontSize: 15 },
  avatarWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    width: '100%',
    paddingHorizontal: 48,
  },
  actionItem: { alignItems: 'center', gap: 10, minWidth: 86 },
  chevrons: { alignItems: 'center', marginBottom: 2, gap: -6 },
  sideBtn: {
    width: 64, height: 64, borderRadius: 32,
    alignItems: 'center', justifyContent: 'center',
  },
  acceptBtn: {
    width: 74, height: 74, borderRadius: 37,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#00C853',
  },
  decline: { backgroundColor: '#EA0038' },
  actionLabel: { fontFamily: 'Roboto-Regular', fontSize: 13 },
});
