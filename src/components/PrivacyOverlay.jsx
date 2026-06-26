import React from 'react';
import { View, Image, StyleSheet } from 'react-native';

// Full-screen opaque, branded overlay shown the instant the app leaves the
// foreground (AppState `inactive` or `background`) for ANY reason — a manual
// lock (power/lock button), an auto-lock (screen timeout), an app-switch, or a
// system-UI interruption. It exists to close three leaks:
//   1. the lock-transition flash (content briefly visible as the device locks),
//   2. content drawn over the keyguard — on Android MainActivity carries
//      `showWhenLocked` (for incoming calls) so chat content can otherwise paint
//      over the lock screen, and
//   3. the OS app-switcher / recents snapshot. This is why the overlay must be
//      cross-platform: iOS has no FLAG_SECURE, so on iOS this overlay (plus the
//      native willResignActive guard) IS the snapshot protection.
//
// Solid brand background + logo only — it must NEVER render readable chat text.
// Mounted high in the tree (CallProvider) so it sits above the whole app, and
// removed only when AppState returns to `active` (LK4).
const BRAND_BG = '#0B141A';

export default function PrivacyOverlay() {
  return (
    <View
      pointerEvents="auto"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.root}
    >
      <Image
        source={require('../../assets/icon0.png')}
        resizeMode="contain"
        style={styles.logo}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: BRAND_BG,
    alignItems: 'center',
    justifyContent: 'center',
    // Above every screen, banner and call surface.
    zIndex: 99999,
    elevation: 99999,
  },
  logo: {
    width: 120,
    height: 120,
    opacity: 0.9,
  },
});
