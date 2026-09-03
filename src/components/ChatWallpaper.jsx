import React from 'react';
import { StyleSheet, View, Image } from 'react-native';

// Chat wallpaper — ONE cover-fitted doodle image, not a repeating tile.
//
// It used to be drawn with resizeMode="repeat". On the Android build that
// turned out to scale the whole asset into the frame rather than tiling it at
// its natural size, and the bigger the asset got the SMALLER the doodles drew.
// A mirrored, seamless 2x2 asset made that worse in the most visible way: the
// entire mirrored canvas was squeezed onto the screen, so its symmetry axes
// landed mid-screen as pale lines running down and across the chat — the exact
// "white lines in the middle" that was reported.
//
// Cover-fitting a SINGLE (un-mirrored) image removes the whole class of
// problem: nothing repeats, so there is no seam and no symmetry axis to see,
// and the art is upscaled rather than shrunk, which is what makes the
// individual doodles legible instead of a fine grey noise. The asset stays
// modest (640x940) because a faint line pattern upscales gracefully.
//
// GROUND: theme.colors.chatBackground, never a colour of its own.
// This file used to hard-code #EFEAE2 / #0B141A, which made the chat the only
// surface in the app ignoring the theme — on dark mode that near-black sat
// visibly apart from the app's true black. The ground is a THEME token now:
// true black on dark (continuous with every other surface), a warm off-white
// on light (pure white would swallow the white incoming bubbles).
//
// Ink strength lives in the ASSET, not here: see
// scripts/build-chat-doodle-tiles.py. The shipped exports peaked at alpha
// 14-16/255 (~6%), which is why the pattern was invisible on device.
const TILE_LIGHT = require('../../assets/chat-doodle-light.png');
const TILE_DARK = require('../../assets/chat-doodle-dark.png');

function ChatWallpaper({ isDarkMode, backgroundColor }) {
  return (
    <View pointerEvents="none" style={[styles.container, { backgroundColor }]}>
      <Image
        source={isDarkMode ? TILE_DARK : TILE_LIGHT}
        style={styles.tile}
        resizeMode="cover"
        fadeDuration={0}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // backgroundColor comes from the theme at the call site.
  container: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  // Fills the screen; "cover" keeps the doodles' aspect ratio and crops the
  // overflow rather than stretching them.
  tile: { width: '100%', height: '100%' },
});

export default React.memo(ChatWallpaper);
