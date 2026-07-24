// Two-layer blur gate for received, not-yet-downloaded media thumbnails.
//
// Why not a dynamic blurRadius: RN's Image blurRadius is NOT animatable — each
// progress tick re-rendered the bitmap with a new integer radius (a full
// native re-blur), which visibly blinked, worst on Android. Instead the SAME
// thumbnail is rendered twice, stacked: the bottom layer sharp, the top layer
// with a CONSTANT heavy blur (rendered/blurred exactly once) whose OPACITY is
// animated on the native driver. Download progress fades the blurred layer
// out, so the picture glides into focus between progress ticks.
//
// Props:
//   uri        — thumbnail source
//   style      — sizing/border style (same one previously given to <Image>)
//   resizeMode — passthrough (default 'cover')
//   gated      — received & not yet downloaded; false renders ONLY the sharp
//                image (no gate layers at all — sender's own / downloaded)
//   active     — a download is currently running (opacity eases to 1-progress)
//   paused     — hold the current reveal exactly where it is (no reset to 1)
//   progress   — REAL download progress, 0-1
//   onError    — passthrough to the sharp layer (local-file fallback logic)
//
// Rendered as a COMPONENT (never called as a hook) so it is safe inside
// FlatList renderItem per the project rule.
import React, { useEffect, useRef } from 'react';
import { View, Image, Animated, StyleSheet } from 'react-native';

// Constant heavy blur — clearly obscures content on both platforms (RN renders
// the same number stronger on iOS than Android; 25 covers both). NEVER changes
// at runtime, so the native blur is computed once per bitmap.
const GATE_BLUR_RADIUS = 25;
const REVEAL_MS = 250;

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

export default function BlurGateImage({
  uri,
  style,
  resizeMode = 'cover',
  gated = true,
  active = false,
  paused = false,
  progress = 0,
  onError = null,
}) {
  // Mount at the honest starting point: mid-download/paused remounts (chat
  // re-open) start at the eased value instead of flashing fully blurred.
  const gateOpacity = useRef(
    new Animated.Value(gated ? ((active || paused) ? clamp01(1 - progress) : 1) : 0)
  ).current;

  useEffect(() => {
    if (!gated) return undefined;
    if (paused) {
      // Pause holds the current reveal — stop any in-flight animation right
      // where it is; never snap back to fully blurred.
      gateOpacity.stopAnimation();
      return undefined;
    }
    // Glide toward the latest target between progress ticks. Idle-but-gated
    // (fresh, or a failed download) eases back to fully blurred.
    const animation = Animated.timing(gateOpacity, {
      toValue: active ? clamp01(1 - progress) : 1,
      duration: REVEAL_MS,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [gated, active, paused, progress, gateOpacity]);

  if (!gated) {
    return (
      <Image
        source={{ uri }}
        style={style}
        resizeMode={resizeMode}
        onError={onError || undefined}
      />
    );
  }

  return (
    <View style={[style, styles.clip]}>
      <Image
        source={{ uri }}
        style={styles.fill}
        resizeMode={resizeMode}
        onError={onError || undefined}
      />
      <Animated.Image
        source={{ uri }}
        style={[styles.fill, { opacity: gateOpacity }]}
        resizeMode={resizeMode}
        blurRadius={GATE_BLUR_RADIUS}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  clip: {
    overflow: 'hidden',
  },
  fill: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
});
