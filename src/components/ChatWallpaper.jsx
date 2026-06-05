import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, Pattern, Rect, G, Path, Circle } from 'react-native-svg';

// WhatsApp-style chat wallpaper, drawn entirely as a tiled SVG doodle pattern
// (no raster image assets). A repeating <Pattern> tile scatters a set of
// line-art doodles over a flat background; the whole thing is theme-aware so
// light and dark modes share one vector source instead of two PNG/JPEGs.
//
// Palette:
//   light → WhatsApp beige (#EAE1D6) with faint dark doodles
//   dark  → WhatsApp deep-teal (#0B141A) with faint light doodles

const TILE = 240;          // doodle tile size in px (pattern repeat unit)
const STROKE_W = 1.6;      // hand-drawn line weight

// Each doodle is authored in a ~24×24 box and placed into the tile with a
// translate / rotate / scale transform (see PLACEMENTS). The `color` arg is
// only needed for the few solid bits (e.g. smiley eyes) — strokes inherit
// from the parent <G>. Keeping a margin from the tile edges avoids hard
// clipping seams where tiles meet.
const buildDoodles = (color) => ({
  heart: (
    <Path d="M12 20.4C12 20.4 3.8 15.4 3.8 9.3 3.8 6.6 5.9 4.7 8.3 4.7 10 4.7 11.3 5.7 12 7 12.7 5.7 14 4.7 15.7 4.7 18.1 4.7 20.2 6.6 20.2 9.3 20.2 15.4 12 20.4 12 20.4Z" />
  ),
  star: (
    <Path d="M12 3 L14.2 9 L20.5 9 L15.4 13 L17.4 19.4 L12 15.6 L6.6 19.4 L8.6 13 L3.5 9 L9.8 9 Z" />
  ),
  smiley: (
    <G>
      <Circle cx={12} cy={12} r={9} />
      <Circle cx={9} cy={10} r={1} fill={color} stroke="none" />
      <Circle cx={15} cy={10} r={1} fill={color} stroke="none" />
      <Path d="M8 14 Q12 17.5 16 14" />
    </G>
  ),
  music: (
    <G>
      <Path d="M9 17.5 L9 6 L19 4 L19 15" />
      <Circle cx={7} cy={17.5} r={2} />
      <Circle cx={17} cy={15} r={2} />
    </G>
  ),
  chat: (
    <Path d="M4 5 H20 V15 H10 L5 19 V15 H4 Z" />
  ),
  camera: (
    <G>
      <Path d="M4 8 H8 L9.4 6 H14.6 L16 8 H20 V18 H4 Z" />
      <Circle cx={12} cy={13} r={3} />
    </G>
  ),
  sun: (
    <G>
      <Circle cx={12} cy={12} r={4} />
      <Path d="M12 3 V5.5 M12 18.5 V21 M3 12 H5.5 M18.5 12 H21 M5.6 5.6 L7.4 7.4 M16.6 16.6 L18.4 18.4 M18.4 5.6 L16.6 7.4 M7.4 16.6 L5.6 18.4" />
    </G>
  ),
  leaf: (
    <G>
      <Path d="M6 18 C6 10 12 5 19 5 C19 12 13 18 6 18 Z" />
      <Path d="M6.5 17.5 L18.5 5.5" />
    </G>
  ),
  lightning: (
    <Path d="M13 3 L6 13 H11 L9 21 L18 10 H13 Z" />
  ),
  plane: (
    <G>
      <Path d="M3 11 L21 4 L14 21 L11 13 Z" />
      <Path d="M11 13 L21 4" />
    </G>
  ),
  cup: (
    <G>
      <Path d="M5 9 H17 V13.5 A4 4 0 0 1 13 17.5 H9 A4 4 0 0 1 5 13.5 Z" />
      <Path d="M17 10 H18.5 A2 2 0 0 1 18.5 14 H17" />
      <Path d="M8 5 V7 M11 5 V7 M14 5 V7" />
    </G>
  ),
  cloud: (
    <Path d="M7.5 17 A4 4 0 0 1 7.5 9.2 A5 5 0 0 1 16.5 9 A3.4 3.4 0 0 1 17 17 Z" />
  ),
});

// (doodleKey, x, y, rotation°, scale) — scattered placement inside one tile.
const PLACEMENTS = [
  ['heart', 14, 18, -12, 1.35],
  ['star', 96, 10, 8, 1.25],
  ['smiley', 168, 22, -6, 1.3],
  ['music', 48, 70, 14, 1.25],
  ['chat', 132, 66, -10, 1.3],
  ['leaf', 196, 84, 10, 1.2],
  ['sun', 18, 130, -8, 1.3],
  ['camera', 100, 132, 12, 1.2],
  ['lightning', 172, 150, -14, 1.3],
  ['cloud', 52, 192, 6, 1.25],
  ['plane', 132, 194, -8, 1.25],
  ['cup', 200, 200, 10, 1.2],
];

function ChatWallpaper({ isDarkMode }) {
  const bg = isDarkMode ? '#0B141A' : '#EAE1D6';
  const doodle = isDarkMode ? '#FFFFFF' : '#5C4B36';
  const doodleOpacity = isDarkMode ? 0.05 : 0.06;
  const doodles = buildDoodles(doodle);

  return (
    <View pointerEvents="none" style={[styles.container, { backgroundColor: bg }]}>
      <Svg width="100%" height="100%">
        <Defs>
          <Pattern id="waDoodles" patternUnits="userSpaceOnUse" width={TILE} height={TILE}>
            <G
              stroke={doodle}
              fill="none"
              strokeWidth={STROKE_W}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={doodleOpacity}
            >
              {PLACEMENTS.map(([key, x, y, rot, scale], i) => (
                <G key={i} transform={`translate(${x}, ${y}) rotate(${rot}) scale(${scale})`}>
                  {doodles[key]}
                </G>
              ))}
            </G>
          </Pattern>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={bg} />
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#waDoodles)" />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
});

export default React.memo(ChatWallpaper);
