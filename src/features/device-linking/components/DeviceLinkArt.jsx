/**
 * DeviceLinkArt — "Linked devices" hero illustration.
 *
 * A modern front-facing phone (left) and laptop (right) with a stream of
 * COLOURFUL data packets arcing from the phone to the laptop on a loop —
 * visualising chat data syncing from the mobile device to the linked desktop.
 *
 * The laptop screen pulses as packets land and the whole scene gently
 * breathes. The illustration is non-interactive (no rotation / 3D effect).
 *
 * Theme-aware (light / dark) via the `dark` prop. Pure SVG + RN Animated.
 */
import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Easing } from 'react-native';
import Svg, {
  Defs,
  LinearGradient,
  Stop,
  Rect,
  Path,
  G,
  Line,
} from 'react-native-svg';

// Vivid packet colours — green, sky, amber, violet, pink.
const PACKET_COLORS = ['#25D366', '#34B7F1', '#FFB400', '#AB6BFF', '#FF5E7E'];

export default function DeviceLinkArt({
  size = 230,
  accent = '#00A884',
  accentDark = '#017A68',
  dark = true,
  animated = true,
}) {
  const W = size;
  const H = size * 0.74;
  const scale = size / 240; // viewBox 240 wide

  // Theme-aware ink / surfaces.
  const stroke = dark ? '#CBD5DA' : '#0B141A';
  const phoneBody = dark ? '#1F2C33' : '#FFFFFF';
  const phoneScreen = dark ? '#0B141A' : '#EAF8EF';
  const laptopDeck = dark ? '#243640' : '#D7DEE3';
  const bubbleA = accent;
  const bubbleB = dark ? '#2A3942' : '#FFFFFF';

  // Packet travel: phone screen (left) → laptop screen (right), arcing up.
  const startX = 92 * scale;
  const endX = 152 * scale;
  const baseY = 86 * scale;
  const arc = 30 * scale;

  // Five staggered packets + breathe + laptop receive-glow.
  const p0 = useRef(new Animated.Value(0)).current;
  const p1 = useRef(new Animated.Value(0)).current;
  const p2 = useRef(new Animated.Value(0)).current;
  const p3 = useRef(new Animated.Value(0)).current;
  const p4 = useRef(new Animated.Value(0)).current;
  const breathe = useRef(new Animated.Value(0)).current;
  const packets = [p0, p1, p2, p3, p4];

  useEffect(() => {
    if (!animated) return undefined;
    const make = (val, delay) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(val, {
            toValue: 1,
            duration: 1600,
            easing: Easing.inOut(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(val, { toValue: 0, duration: 1, useNativeDriver: true }),
        ]),
      );
    const breatheAnim = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: 2200, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(breathe, { toValue: 0, duration: 2200, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    const anims = [...packets.map((v, i) => make(v, i * 320)), breatheAnim];
    anims.forEach((a) => a.start());
    return () => anims.forEach((a) => a.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animated]);

  const packetStyle = (val, color, sizePx) => ({
    position: 'absolute',
    top: baseY - sizePx / 2,
    left: 0,
    width: sizePx,
    height: sizePx,
    borderRadius: sizePx / 2,
    backgroundColor: color,
    shadowColor: color,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 5,
    elevation: 6,
    transform: [
      { translateX: val.interpolate({ inputRange: [0, 1], outputRange: [startX, endX] }) },
      { translateY: val.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, -arc, 0] }) },
      { scale: val.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.45, 1, 0.45] }) },
    ],
    opacity: val.interpolate({ inputRange: [0, 0.12, 0.85, 1], outputRange: [0, 1, 1, 0] }),
  });

  const sceneScale = breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 1.022] });
  const screenGlow = p0.interpolate({ inputRange: [0, 0.72, 0.94, 1], outputRange: [0, 0, 0.55, 0] });

  return (
    <Animated.View
      style={[
        styles.wrap,
        {
          width: W,
          height: H,
          transform: [{ scale: animated ? sceneScale : 1 }],
        },
      ]}
    >
        <Svg width={W} height={H} viewBox="0 0 240 178">
          <Defs>
            <LinearGradient id="lapScreen" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0%" stopColor={accent} />
              <Stop offset="100%" stopColor={accentDark} />
            </LinearGradient>
            <LinearGradient id="phoneGlass" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0%" stopColor={phoneScreen} />
              <Stop offset="100%" stopColor={dark ? '#10242C' : '#DDF3E6'} />
            </LinearGradient>
          </Defs>

          {/* ground shadow */}
          <G opacity={dark ? 0.22 : 0.08}>
            <Path d="M40 160 q80 12 160 0 q-80 8 -160 0 Z" fill={stroke} />
          </G>

          {/* ───────── Phone (front, left) ───────── */}
          <G>
            <Rect x="20" y="26" width="72" height="124" rx="16" fill={phoneBody} stroke={stroke} strokeWidth="3.5" />
            <Rect x="27" y="38" width="58" height="100" rx="9" fill="url(#phoneGlass)" />
            <Rect x="46" y="31" width="20" height="5" rx="2.5" fill={stroke} opacity="0.7" />
            <Rect x="46" y="141" width="20" height="4" rx="2" fill={stroke} opacity="0.5" />
            {/* chat bubbles on phone screen */}
            <Rect x="35" y="58" width="34" height="20" rx="7" fill={bubbleA} />
            <Path d="M40 78 l0 7 l8 -7 Z" fill={bubbleA} />
            <Rect x="35" y="92" width="42" height="16" rx="7" fill={bubbleB} stroke={stroke} strokeWidth="2" />
          </G>

          {/* ───────── Laptop (front, right) — fully inside the viewBox ───────── */}
          <G>
            {/* lid / screen frame */}
            <Rect x="148" y="38" width="80" height="60" rx="7" fill={phoneBody} stroke={stroke} strokeWidth="3.5" />
            {/* full screen */}
            <Rect x="154" y="44" width="68" height="48" rx="4" fill="url(#lapScreen)" />
            {/* screen content: chat lines */}
            <Rect x="160" y="53" width="34" height="7" rx="3.5" fill="#FFFFFF" opacity="0.92" />
            <Rect x="160" y="65" width="50" height="7" rx="3.5" fill="#FFFFFF" opacity="0.6" />
            <Rect x="160" y="77" width="26" height="7" rx="3.5" fill="#FFFFFF" opacity="0.45" />
            {/* base / deck (kept within x ≤ 238) */}
            <Path d="M136 98 L236 98 L240 110 a3 3 0 0 1 -3 3 L133 113 a3 3 0 0 1 -3 -3 Z" fill={laptopDeck} stroke={stroke} strokeWidth="3.5" strokeLinejoin="round" />
            {/* trackpad notch */}
            <Rect x="174" y="103" width="24" height="4" rx="2" fill={stroke} opacity="0.5" />
          </G>

          {/* dashed data channel between devices */}
          <Line x1="94" y1="88" x2="152" y2="88" stroke={accent} strokeWidth="2" strokeDasharray="2 6" strokeLinecap="round" opacity={dark ? 0.5 : 0.4} />
        </Svg>

        {/* ───────── Colourful data packets phone → laptop ───────── */}
        {animated && (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            {/* laptop receive-glow */}
            <Animated.View
              style={{
                position: 'absolute',
                left: 152 * scale,
                top: 42 * scale,
                width: 72 * scale,
                height: 52 * scale,
                borderRadius: 6 * scale,
                backgroundColor: accent,
                opacity: screenGlow,
              }}
            />
            {packets.map((v, i) => (
              <Animated.View key={i} style={packetStyle(v, PACKET_COLORS[i % PACKET_COLORS.length], i % 2 === 0 ? 11 : 9)} />
            ))}
          </View>
        )}
      </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
});
