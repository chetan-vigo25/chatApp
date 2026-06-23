import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCall } from '../useCall';
import { isMiniBannerActive } from '../state/callMachine';
import { MINI_BAR_HEIGHT } from './CallMiniBanner';

/**
 * Pushes the whole app (the navigator) down by the FULL height of the minimized
 * call banner so the banner never covers a screen's header — exactly like
 * WhatsApp, where the in-call bar shifts the chat list down rather than
 * overlapping it.
 *
 * The banner spans `insets.top + MINI_BAR_HEIGHT` (it draws over the status bar,
 * WhatsApp-style), so we must reserve that whole height here. We can't lean on
 * the navigator's root SafeAreaView to cover the status-bar inset: that native
 * SafeAreaView clamps its top padding to the on-screen overlap with the status
 * bar (`max(0, statusBarBottom − viewTop)`), so once this wrapper pushes it
 * below the status bar its contribution collapses to ~0 and the screen header
 * would otherwise land under the bar (clipped). Adding `insets.top` here is what
 * keeps the content flush against the bar's bottom edge on every device.
 *
 * Wrapping ONLY the navigator (not the full-screen overlays like AppLockGate)
 * keeps those overlays covering the entire screen, banner included.
 */
export default function CallContentInset({ children }) {
  const { call } = useCall();
  const insets = useSafeAreaInsets();
  const active = isMiniBannerActive(call);
  return (
    <View style={[styles.fill, active ? { paddingTop: insets.top + MINI_BAR_HEIGHT } : null]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
