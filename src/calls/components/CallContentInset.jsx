import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useCall } from '../useCall';
import { isMiniBannerActive } from '../state/callMachine';
import { MINI_BAR_HEIGHT } from './CallMiniBanner';

/**
 * Pushes the whole app (the navigator) down by the height of the minimized
 * call banner so the banner never covers a screen's header — exactly like
 * WhatsApp, where the in-call bar shifts the chat list down rather than
 * overlapping it.
 *
 * Only the bar's own height is added here: the navigator already wraps its
 * screens in a root SafeAreaView (which applies the status-bar inset), so that
 * inset region simply sits hidden behind the banner and the screen content
 * lands flush against the bar's bottom edge. Wrapping ONLY the navigator (not
 * the full-screen overlays like AppLockGate) keeps those overlays covering the
 * entire screen, banner included.
 */
export default function CallContentInset({ children }) {
  const { call } = useCall();
  const active = isMiniBannerActive(call);
  return (
    <View style={[styles.fill, active ? { paddingTop: MINI_BAR_HEIGHT } : null]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
