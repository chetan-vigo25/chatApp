/**
 * SegmentedRing
 * Draws a segmented ring around an avatar using pure React Native.
 * Each segment corresponds to one status item.
 * Viewed segments → gray (#94A3B8), Unviewed → green (#03b0a2).
 *
 * Props:
 *   count        — total number of statuses in the group
 *   viewedCount  — how many have been viewed (from the left/first)
 *   size         — outer diameter of the ring container (default 60)
 *   strokeWidth  — ring stroke thickness (default 2.5)
 */
import { View } from 'react-native';

const UNSEEN_COLOR = '#03b0a2';
const SEEN_COLOR   = '#94A3B8';

export default function SegmentedRing({
  count = 1,
  viewedCount = 0,
  size = 60,
  strokeWidth = 2.5,
}) {
  if (count <= 0) return <View style={{ width: size, height: size }} />;

  const radius = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;

  // Single status: simple full ring
  if (count === 1) {
    const color = viewedCount >= 1 ? SEEN_COLOR : UNSEEN_COLOR;
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: strokeWidth,
          borderColor: color,
        }}
      />
    );
  }

  // Gap between segments scales with count to always look clean
  const GAP_DEG   = Math.max(3, Math.min(8, 360 / count * 0.12));
  const SEG_DEG   = (360 - GAP_DEG * count) / count;
  const SUB_STEP  = 5; // degrees per sub-dash (smaller = smoother arc)

  const dashes = [];
  for (let i = 0; i < count; i++) {
    const color      = i < viewedCount ? SEEN_COLOR : UNSEEN_COLOR;
    const startDeg   = -90 + i * (SEG_DEG + GAP_DEG); // top = -90°
    let   d          = startDeg;

    while (d < startDeg + SEG_DEG - 0.01) {
      const subEnd   = Math.min(d + SUB_STEP, startDeg + SEG_DEG);
      const midRad   = ((d + subEnd) / 2) * (Math.PI / 180);
      const sweepDeg = subEnd - d;
      const arcLen   = (sweepDeg / 360) * 2 * Math.PI * radius;
      const x        = cx + radius * Math.cos(midRad);
      const y        = cy + radius * Math.sin(midRad);
      const rotDeg   = (d + subEnd) / 2 + 90; // tangent direction

      dashes.push({ x, y, arcLen, rotDeg, color, key: `${i}_${d.toFixed(1)}` });
      d = subEnd;
    }
  }

  return (
    <View style={{ width: size, height: size }}>
      {dashes.map(({ x, y, arcLen, rotDeg, color, key }) => (
        <View
          key={key}
          style={{
            position: 'absolute',
            width: arcLen + 0.5, // +0.5 to avoid sub-pixel gaps
            height: strokeWidth,
            backgroundColor: color,
            borderRadius: strokeWidth / 2,
            left: x - (arcLen + 0.5) / 2,
            top:  y - strokeWidth / 2,
            transform: [{ rotate: `${rotDeg}deg` }],
          }}
        />
      ))}
    </View>
  );
}
