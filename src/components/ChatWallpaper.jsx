import React from 'react';
import { StyleSheet, View, Image } from 'react-native';

// WhatsApp-style chat wallpaper — the authentic dense doodle pattern, tiled.
// Pre-tinted transparent PNG tiles (one per theme, generated from the same
// source the website uses: strokes extracted to an alpha mask, JPEG noise
// floored, tinted per theme) drawn over the base color. resizeMode "repeat"
// tiles at the asset's dp size (@2x → 320dp wide), matching the website's
// 366px tile density closely.
//
// Neutral grounds, deliberately NOT tinted with the theme/chat color — a
// colored wash behind the bubbles reads as "wrong theme" (user feedback):
//   light → warm beige (#EFEAE2)
//   dark  → deep blue-teal (#0B141A) — never pure black, otherwise the
//           wallpaper is indistinguishable from the app background and
//           "disappears"
const TILE_LIGHT = require('../../assets/chat-doodle-light.png');
const TILE_DARK = require('../../assets/chat-doodle-dark.png');

function ChatWallpaper({ isDarkMode }) {
  const bg = isDarkMode ? '#0B141A' : '#EFEAE2';

  return (
    <View pointerEvents="none" style={[styles.container, { backgroundColor: bg }]}>
      <Image
        source={isDarkMode ? TILE_DARK : TILE_LIGHT}
        style={styles.tile}
        resizeMode="repeat"
        fadeDuration={0}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  tile: { width: '100%', height: '100%' },
});

export default React.memo(ChatWallpaper);
