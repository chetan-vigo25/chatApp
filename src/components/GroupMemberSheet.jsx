/**
 * GroupMemberSheet
 *
 * WhatsApp-style draggable bottom sheet for a GROUP MEMBER (opened by tapping
 * a row in Group info). Slides up, drags down to dismiss, and mirrors the web
 * member action sheet: big avatar, name, "~push name", round quick actions
 * (Message · Voice · Video · Status) and a list of rows — Info (full profile),
 * View status, then the permission-gated admin rows (make/dismiss admin,
 * make owner, remove).
 *
 * Presentational: the caller resolves names/permissions and supplies the
 * callbacks, so display-name rules stay in one place (GroupInfo).
 *
 * Surface colours come from the theme (page background for the sheet, border
 * token for dividers) so light/dark follow the app automatically.
 *
 * Pure React Native — Animated + PanResponder for the drag (same mechanism as
 * UserDetailsSheet), identical on Android + iOS.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated, Dimensions, Image, Modal, PanResponder, StyleSheet, Text,
  TouchableOpacity, View, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../contexts/ThemeContext';

const { height: SCREEN_H } = Dimensions.get('window');

export default function GroupMemberSheet({
  visible,
  onClose,
  name = 'Member',
  subtitle = null,        // "~push name" / "@username"
  about = null,
  image = null,
  avatarColor = '#6C5CE7',
  roleLabel = null,       // "Owner" / "Admin" badge text, or null
  isVerified = false,
  callBusy = false,
  hasStatus = false,
  statusUnseen = 0,
  onMessage,
  onAudioCall,
  onVideoCall,
  onViewStatus,
  onViewProfile,
  // Admin rows (each rendered only when its callback is supplied).
  onPromote,
  onDemote,
  onTransfer,
  onRemove,
}) {
  const { theme, isDarkMode } = useTheme();
  const insets = useSafeAreaInsets();

  const translateY = useRef(new Animated.Value(SCREEN_H)).current;
  const backdrop = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);

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

  // Drag-to-dismiss on the handle + hero region (rows below still tap).
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_, g) => { if (g.dy > 0) translateY.setValue(g.dy); },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 120 || g.vy > 0.8) onClose?.();
        else Animated.spring(translateY, { toValue: 0, tension: 62, friction: 11, useNativeDriver: true }).start();
      },
    }),
  ).current;

  if (!mounted) return null;

  const pageBg = theme.colors.background;
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.secondaryTextColor || theme.colors.placeHolderTextColor;
  const dividerClr = theme.colors.divider || theme.colors.borderColor;
  const themeColor = theme.colors.themeColor;
  const pillBg = isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)';
  const iconClr = theme.colors.iconColor || primaryText;
  const initial = (name || '?').trim().charAt(0).toUpperCase();

  const close = () => onClose?.();
  // Close first, act after: the screen underneath navigates / dials.
  const after = (fn) => () => { close(); fn?.(); };

  const Pill = ({ icon, label, onPress, disabled }) => (
    <TouchableOpacity style={[styles.pillCol, disabled && { opacity: 0.4 }]} onPress={onPress} disabled={disabled} activeOpacity={0.6}>
      <View style={[styles.pill, { backgroundColor: pillBg }]}>
        <Ionicons name={icon} size={22} color={iconClr} />
      </View>
      <Text style={[styles.pillLabel, { color: primaryText }]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );

  const Row = ({ icon, iconSet: IconSet = Ionicons, label, onPress, color }) => (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.6}>
      <IconSet name={icon} size={22} color={color || iconClr} />
      <Text style={[styles.rowText, { color: color || primaryText }]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );

  const hasAdminRows = !!(onPromote || onDemote || onTransfer || onRemove);

  return (
    <Modal transparent visible={mounted} onRequestClose={close} statusBarTranslucent>
      <View style={styles.fill}>
        <Animated.View style={[styles.backdrop, { opacity: backdrop, backgroundColor: theme.colors.scrim || 'rgba(0,0,0,0.5)' }]}>
          <TouchableOpacity style={styles.fill} activeOpacity={1} onPress={close} />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: pageBg,
              paddingBottom: insets.bottom + 10,
              maxHeight: SCREEN_H * 0.9,
              transform: [{ translateY }],
              // Dark mode: the sheet sits on a black page, so a hairline edge
              // (not a shadow) is what separates it.
              borderColor: dividerClr,
              borderWidth: isDarkMode ? StyleSheet.hairlineWidth : 0,
            },
          ]}
        >
          {/* Grab handle + hero = drag region */}
          <View {...pan.panHandlers} style={styles.hero}>
            <View style={[styles.grabBar, { backgroundColor: subText + '66' }]} />

            <TouchableOpacity onPress={after(onViewProfile)} activeOpacity={0.8} style={styles.avatarWrap}>
              {image ? (
                <Image source={{ uri: image }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: avatarColor }]}>
                  <Text style={styles.avatarLetter}>{initial}</Text>
                </View>
              )}
            </TouchableOpacity>

            <View style={styles.nameLine}>
              <Text style={[styles.name, { color: primaryText }]} numberOfLines={1}>{name}</Text>
              {isVerified && <MaterialCommunityIcons name="check-decagram" size={18} color={themeColor} />}
            </View>
            {!!subtitle && <Text style={[styles.subtitle, { color: subText }]} numberOfLines={1}>{subtitle}</Text>}
            {!!about && <Text style={[styles.about, { color: primaryText }]} numberOfLines={2}>{about}</Text>}
            {!!roleLabel && (
              <View style={[styles.roleBadge, { backgroundColor: themeColor + '18' }]}>
                <Text style={[styles.roleBadgeText, { color: themeColor }]}>{roleLabel}</Text>
              </View>
            )}

            {/* Round quick actions — WhatsApp layout */}
            <View style={styles.pills}>
              <Pill icon="chatbubble-outline" label="Message" onPress={after(onMessage)} />
              <Pill icon="call-outline" label="Voice" onPress={after(onAudioCall)} disabled={callBusy} />
              <Pill icon="videocam-outline" label="Video" onPress={after(onVideoCall)} disabled={callBusy} />
              {hasStatus && <Pill icon="radio-button-on-outline" label="Status" onPress={after(onViewStatus)} />}
            </View>
          </View>

          <ScrollView bounces={false} style={styles.rowsScroll} contentContainerStyle={styles.rows}>
            <Row icon="information-circle-outline" label="Info" onPress={after(onViewProfile)} />
            {hasStatus && (
              <Row icon="eye-outline" label={statusUnseen ? `View status (${statusUnseen} new)` : 'View status'} onPress={after(onViewStatus)} />
            )}

            {hasAdminRows && <View style={[styles.divider, { backgroundColor: dividerClr }]} />}

            {onPromote && <Row icon="shield-outline" label="Make group admin" onPress={after(onPromote)} />}
            {onDemote && <Row icon="shield-off-outline" iconSet={MaterialCommunityIcons} label="Dismiss as admin" onPress={after(onDemote)} />}
            {onTransfer && <Row icon="account-switch-outline" iconSet={MaterialCommunityIcons} label="Make group owner" onPress={after(onTransfer)} />}
            {onRemove && <Row icon="person-remove-outline" label="Remove from group" color={theme.colors.danger} onPress={after(onRemove)} />}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: { ...StyleSheet.absoluteFillObject },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingTop: 8,
    elevation: 24,
    shadowColor: '#000', shadowOffset: { width: 0, height: -6 }, shadowOpacity: 0.25, shadowRadius: 18,
  },
  hero: { alignItems: 'center', paddingHorizontal: 16 },
  grabBar: { width: 40, height: 4.5, borderRadius: 3, marginBottom: 14 },

  avatarWrap: { marginBottom: 12 },
  avatar: { width: 120, height: 120, borderRadius: 60 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: '#fff', fontFamily: 'Roboto-Bold', fontSize: 48 },

  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '92%' },
  name: { fontFamily: 'Roboto-Medium', fontSize: 22, textAlign: 'center', flexShrink: 1 },
  subtitle: { fontFamily: 'Roboto-Regular', fontSize: 15, marginTop: 4 },
  about: { fontFamily: 'Roboto-Regular', fontSize: 13.5, marginTop: 6, textAlign: 'center', maxWidth: '88%' },
  roleBadge: { marginTop: 8, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10 },
  roleBadgeText: { fontFamily: 'Roboto-Medium', fontSize: 11.5 },

  pills: { flexDirection: 'row', justifyContent: 'center', gap: 22, marginTop: 20, marginBottom: 10 },
  pillCol: { alignItems: 'center', width: 72 },
  pill: { width: 62, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  pillLabel: { fontFamily: 'Roboto-Regular', fontSize: 12.5, marginTop: 6 },

  rowsScroll: { flexGrow: 0 },
  rows: { paddingTop: 6, paddingBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 22, paddingVertical: 15, paddingHorizontal: 24 },
  rowText: { fontFamily: 'Roboto-Regular', fontSize: 16, flex: 1 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 6, marginHorizontal: 24 },
});
