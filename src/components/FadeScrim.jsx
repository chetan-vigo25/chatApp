import React, { useId } from 'react';
import { View } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';

/**
 * A smooth vertical colour fade (e.g. the dark scrim under a hero photo's name).
 *
 * Drawn as one SVG linear gradient. The old approach — hundreds of stacked 1dp
 * <View> bands — showed horizontal lines on Android: 1dp is a fractional number
 * of device pixels (2.625px on a 420dpi phone), so neighbouring bands rounded
 * to uneven heights and seams. A real gradient has no bands to seam.
 *
 * `stops` are { offset: 0..1 (top→bottom), opacity: 0..1 }.
 */
export default function FadeScrim({ height, color = '#000', stops, style }) {
  const id = `fade${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <View pointerEvents="none" style={[{ height }, style]}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            {stops.map((s, i) => (
              // Index key: two stops may share an offset (a hard edge).
              <Stop key={i} offset={s.offset} stopColor={color} stopOpacity={s.opacity} />
            ))}
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

// Eased stops for alpha = f(t), sampled finely enough that the curve reads smooth.
export const easedStops = (f, n = 12) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    return { offset: t, opacity: Math.max(0, Math.min(1, f(t))) };
  });
