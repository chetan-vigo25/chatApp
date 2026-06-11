/**
 * DeviceLinkArt — a vector homage of WhatsApp's "Linked devices" illustration:
 * a phone and an open laptop, with two hands reaching out to exchange chat
 * bubbles (a heart and a handwritten squiggle). Pure SVG, theme-aware.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, {
  Defs,
  LinearGradient,
  Stop,
  Rect,
  Path,
  G,
  Circle,
  Ellipse,
} from 'react-native-svg';

export default function DeviceLinkArt({ size = 230, accent = '#00A884', accentDark = '#017A68', dark = true }) {
  // Brand-driven: the laptop, keys, and heart all derive from the accent.
  const green = accent;
  const greenDark = accentDark;
  const phoneFill = dark ? '#E9F8EE' : '#EAF8EF';
  const ink = '#0B141A';
  const hand = '#F3E4D3';
  const bubble = '#FFFFFF';
  const teal = accent;

  return (
    <View style={[styles.wrap, { width: size, height: size * 0.74 }]}>
      <Svg width={size} height={size * 0.74} viewBox="0 0 240 178">
        <Defs>
          <LinearGradient id="lap" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor={green} />
            <Stop offset="100%" stopColor={greenDark} />
          </LinearGradient>
        </Defs>

        {/* ───── Phone (left) ───── */}
        <G>
          <Rect x="22" y="30" width="74" height="118" rx="15" fill={phoneFill} stroke={ink} strokeWidth="3.5" />
          <Circle cx="59" cy="42" r="2.6" fill={ink} />
          <Rect x="49" y="132" width="20" height="5" rx="2.5" fill={ink} opacity="0.55" />
        </G>

        {/* ───── Laptop (right, 3D) ───── */}
        <G>
          {/* screen */}
          <Path d="M150 44 L214 30 L214 96 L150 104 Z" fill="url(#lap)" stroke={ink} strokeWidth="3.5" strokeLinejoin="round" />
          {/* base / keyboard deck */}
          <Path d="M140 112 L224 112 L214 96 L150 104 Z" fill={green} stroke={ink} strokeWidth="3.5" strokeLinejoin="round" />
          {/* keyboard keys */}
          <G stroke={ink} strokeWidth="2" opacity="0.85" strokeLinecap="round">
            <Path d="M160 104 L206 99" />
            <Path d="M158 109 L209 104" />
            <Path d="M173 100 L173 110" />
            <Path d="M188 99 L188 109" />
          </G>
        </G>

        {/* ───── Left arm + fist from the phone ───── */}
        <G>
          <Path d="M88 86 L112 86 L112 100 L88 100 Z" fill={hand} stroke={ink} strokeWidth="3" strokeLinejoin="round" />
          <Path d="M110 84 q12 0 12 9 q0 9 -12 9 q-6 0 -6 -9 q0 -9 6 -9 Z" fill={hand} stroke={ink} strokeWidth="3" strokeLinejoin="round" />
        </G>

        {/* ───── Right arm + fist from the laptop ───── */}
        <G>
          <Path d="M152 86 L128 86 L128 100 L152 100 Z" fill={hand} stroke={ink} strokeWidth="3" strokeLinejoin="round" />
          <Path d="M130 84 q-12 0 -12 9 q0 9 12 9 q6 0 6 -9 q0 -9 -6 -9 Z" fill={hand} stroke={ink} strokeWidth="3" strokeLinejoin="round" />
        </G>

        {/* ───── Chat bubbles ───── */}
        {/* heart bubble */}
        <G>
          <Rect x="96" y="64" width="34" height="26" rx="9" fill={bubble} stroke={ink} strokeWidth="3" />
          <Path
            d="M113 86 c-7 -5 -11 -9 -11 -13 a4.4 4.4 0 0 1 8.5 -1.6 a4.4 4.4 0 0 1 8.5 1.6 c0 4 -4 8 -6 10.5 Z"
            fill={teal}
          />
        </G>
        {/* squiggle bubble */}
        <G>
          <Rect x="120" y="64" width="34" height="26" rx="9" fill={bubble} stroke={ink} strokeWidth="3" />
          <Path d="M128 82 q3 -12 8 -10 q4 2 0 9 q-2 4 4 1 q4 -2 6 -8" fill="none" stroke={ink} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </G>

        {/* subtle ground shadow */}
        <Ellipse cx="120" cy="160" rx="92" ry="7" fill={ink} opacity={dark ? 0.18 : 0.06} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
});
