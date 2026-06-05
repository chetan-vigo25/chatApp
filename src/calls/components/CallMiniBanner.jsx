import React from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import CallTimer from './CallTimer';

/**
 * The minimized VOICE-call top banner — WhatsApp style (see reference: a full
 * width bar pinned to the top, sitting over the status bar, that pushes the app
 * content down). Layout matches WhatsApp exactly:
 *
 *   [ mute ]            📞 Name · 0:43            [ end ]
 *    left circle         green centre (tap → expand)   red circle
 *
 * Tapping the centre restores the full call screen; the two round buttons mute
 * and end the call. Theme-aware: the bar blends with the app (dark surface in
 * dark mode, light surface in light mode) since it lives over the app content,
 * while the green call accent and red End stay constant like WhatsApp.
 * Cross-platform (Android + iOS) — pure RN views + insets.
 */
export const MINI_BAR_HEIGHT = 54;

// WhatsApp's in-call green — matches the connected-call green used in the Calls
// list. Kept constant across light/dark (it's the call accent, like WhatsApp).
const GREEN = '#1DAB61';
// End button stays a solid WhatsApp red in both modes.
const END_RED = '#EA0038';
const HITSLOP = { top: 8, bottom: 8, left: 8, right: 8 };

export default function CallMiniBanner({
  peer,
  displayName,
  isGroup,
  groupName,
  media,
  statusText,
  showTimer,
  answeredAt,
  micOn,
  onToggleMic,
  onExpand,
  onHangup,
}) {
  const insets = useSafeAreaInsets();
  const { theme, isDarkMode } = useTheme();
  const c = theme.colors;
  const title = isGroup ? (groupName || 'Group call') : (displayName || peer?.name || 'Unknown');

  // Round side-button surface: translucent white on a dark bar, translucent
  // dark on a light bar — so the mute button reads on either background.
  const sideBg = isDarkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)';
  const sideActiveBg = isDarkMode ? 'rgba(255,255,255,0.26)' : 'rgba(0,0,0,0.14)';
  const sideIcon = micOn ? (isDarkMode ? '#fff' : c.iconColor) : (isDarkMode ? '#fff' : c.primaryTextColor);

  return (
    <View
      style={[
        styles.banner,
        {
          paddingTop: insets.top,
          height: insets.top + MINI_BAR_HEIGHT,
          // Match the app's themed background so the bar blends seamlessly with
          // the screen behind it (WhatsApp-style): white in light mode, the deep
          // #0B141A in dark mode — not the lighter surface grey.
          backgroundColor: c.background,
          borderBottomColor: c.borderColor,
        },
      ]}
    >
      <View style={styles.row}>
        <TouchableOpacity
          onPress={onToggleMic}
          activeOpacity={0.8}
          hitSlop={HITSLOP}
          style={[styles.sideBtn, { backgroundColor: micOn ? sideBg : sideActiveBg }]}
        >
          <Ionicons name={micOn ? 'mic' : 'mic-off'} size={20} color={sideIcon} />
        </TouchableOpacity>

        <TouchableOpacity style={styles.center} activeOpacity={0.7} onPress={onExpand}>
          <Ionicons
            name={media === 'video' ? 'videocam' : 'call'}
            size={15}
            color={GREEN}
            style={styles.centerIcon}
          />
          <Text style={[styles.title, { color: GREEN }]} numberOfLines={1}>{title}</Text>
          <Text style={[styles.dash, { color: GREEN }]}> - </Text>
          {showTimer ? (
            <CallTimer startMs={answeredAt} style={styles.timer} />
          ) : (
            <Text style={[styles.timer, { color: GREEN }]} numberOfLines={1}>{statusText}</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          onPress={onHangup}
          activeOpacity={0.85}
          hitSlop={HITSLOP}
          style={[styles.sideBtn, styles.endBtn]}
        >
          <MaterialIcons name="call-end" size={18} color="#fff" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    elevation: 1000,
    borderBottomWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 4,
  },
  row: {
    height: MINI_BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
  },
  sideBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  endBtn: { backgroundColor: END_RED },
  center: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  centerIcon: { marginRight: 6 },
  title: {
    fontFamily: 'Roboto-Medium',
    fontSize: 16,
    flexShrink: 1,
  },
  dash: { fontFamily: 'Roboto-Medium', fontSize: 16 },
  timer: {
    color: GREEN,
    fontFamily: 'Roboto-Medium',
    fontSize: 16,
    opacity: 1,
  },
});
