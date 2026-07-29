// WhatsApp-style circular transfer-progress ring: dark translucent disc with a
// THEME-colored arc that fills until the transfer completes — no percentage
// text (WhatsApp look). Pure presentational — parents pass `percent` (0-100)
// from the REAL transfer progress and hide the ring once the message status
// moves past uploading/downloading.
//
// Pause/resume/cancel (all optional — legacy callers unaffected):
//   paused    — dims the arc and swaps the center glyph to a play triangle
//   onPause   — active center glyph = pause bars; pressing calls it
//   onCancel  — active center glyph = ✕ when no onPause; while paused it also
//               renders a small corner ✕ badge that cancels the transfer
//   onResume  — pressed while paused (play triangle)
import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, Animated, Easing } from 'react-native';
import Svg, { Circle, Rect, Path, Line } from 'react-native-svg';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const THEME_PRIMARY = '#03b0a2'; // brand teal (never WhatsApp green)
const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 };

export default function UploadRing({
  percent = 0,
  size = 48,
  showPercent = false,
  color = THEME_PRIMARY,
  paused = false,
  onPause = null,
  onResume = null,
  onCancel = null,
}) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const strokeWidth = Math.max(2.5, size * 0.07);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const fontSize = Math.max(8, Math.round(size * 0.23));

  // Ease the arc toward each new percent instead of jumping — real transfer
  // progress lands in chunky steps (per-chunk offsets, throttled patches) and
  // an untweened arc looks stuttery. SVG props animate on the JS driver.
  const animatedPercent = useRef(new Animated.Value(clamped)).current;
  useEffect(() => {
    Animated.timing(animatedPercent, {
      toValue: clamped,
      duration: 280,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [clamped, animatedPercent]);
  const dashOffset = animatedPercent.interpolate({
    inputRange: [0, 100],
    outputRange: [circumference, 0],
  });

  // Before the FIRST progress byte lands the arc sits at 0% — a static empty
  // ring + pause bars that reads as "stuck" during the pre-upload phase
  // (compression, sha256, presign round-trip). Until real progress (≥1%)
  // arrives, spin a short arc instead — an indeterminate, obviously-alive
  // loader — then hand off to the normal determinate ring. Paused stays the
  // dimmed static ring (pausing IS stillness).
  const isIndeterminate = !paused && clamped < 1;
  const spinAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!isIndeterminate) return undefined;
    const loop = Animated.loop(
      Animated.timing(spinAnim, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => { loop.stop(); spinAnim.setValue(0); };
  }, [isIndeterminate, spinAnim]);
  const spinDeg = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  const isPaused = Boolean(paused);
  const hasControls = Boolean(onPause || onResume || onCancel);
  // Glyph geometry scales with the ring so the small (36px) audio/file rings
  // and the 48px image/video rings both look right.
  const glyphBox = size * 0.42;
  const half = glyphBox / 2;
  const cx = size / 2;
  const cy = size / 2;
  const barWidth = glyphBox * 0.3;
  const barRadius = barWidth * 0.45;
  const playPath = `M ${cx - half * 0.62} ${cy - half} L ${cx + half * 0.9} ${cy} L ${cx - half * 0.62} ${cy + half} Z`;
  const xExtent = half * 0.78;
  const badgeSize = Math.max(16, Math.round(size * 0.38));
  const badgeX = badgeSize * 0.28;

  const handleCenterPress = () => {
    if (isPaused) {
      if (typeof onResume === 'function') onResume();
      return;
    }
    if (typeof onPause === 'function') {
      onPause();
      return;
    }
    if (typeof onCancel === 'function') onCancel();
  };

  const renderCenterGlyph = () => {
    if (!hasControls) return null;
    if (isPaused) {
      // Play triangle — resume
      return <Path d={playPath} fill="#fff" />;
    }
    if (onPause) {
      // Two rounded pause bars
      return (
        <>
          <Rect
            x={cx - half + barWidth * 0.35}
            y={cy - half}
            width={barWidth}
            height={glyphBox}
            rx={barRadius}
            fill="#fff"
          />
          <Rect
            x={cx + half - barWidth * 1.35}
            y={cy - half}
            width={barWidth}
            height={glyphBox}
            rx={barRadius}
            fill="#fff"
          />
        </>
      );
    }
    if (onCancel) {
      // ✕ — cancel is the only available action
      return (
        <>
          <Line x1={cx - xExtent} y1={cy - xExtent} x2={cx + xExtent} y2={cy + xExtent} stroke="#fff" strokeWidth={strokeWidth * 0.9} strokeLinecap="round" />
          <Line x1={cx - xExtent} y1={cy + xExtent} x2={cx + xExtent} y2={cy - xExtent} stroke="#fff" strokeWidth={strokeWidth * 0.9} strokeLinecap="round" />
        </>
      );
    }
    return null;
  };

  const ring = (
    <View style={[styles.container, { width: size, height: size, borderRadius: size / 2 }]}>
      <Svg width={size} height={size} style={styles.svg}>
        {/* Faint full track */}
        <Circle
          cx={cx}
          cy={cy}
          r={radius}
          stroke="rgba(255,255,255,0.28)"
          strokeWidth={strokeWidth}
          fill="none"
        />
        {/* Progress arc — starts at 12 o'clock, dimmed while paused. Hidden
            while indeterminate (it would draw a 0% seam under the spinner). */}
        {!isIndeterminate && (
          <AnimatedCircle
            cx={cx}
            cy={cy}
            r={radius}
            stroke={color}
            strokeWidth={strokeWidth}
            fill="none"
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            opacity={isPaused ? 0.6 : 1}
            transform={`rotate(-90 ${cx} ${cy})`}
          />
        )}
        {renderCenterGlyph()}
      </Svg>
      {isIndeterminate && (
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { transform: [{ rotate: spinDeg }] }]}
        >
          <Svg width={size} height={size}>
            <Circle
              cx={cx}
              cy={cy}
              r={radius}
              stroke={color}
              strokeWidth={strokeWidth}
              fill="none"
              strokeDasharray={`${circumference * 0.28} ${circumference}`}
              strokeLinecap="round"
              transform={`rotate(-90 ${cx} ${cy})`}
            />
          </Svg>
        </Animated.View>
      )}
      {showPercent && !hasControls && (
        <Text style={[styles.percentText, { fontSize }]} allowFontScaling={false}>
          {Math.round(clamped)}%
        </Text>
      )}
    </View>
  );

  if (!hasControls) return ring;

  return (
    <View style={styles.wrap}>
      <Pressable onPress={handleCenterPress} hitSlop={HIT_SLOP}>
        {ring}
      </Pressable>
      {isPaused && typeof onCancel === 'function' && (
        <Pressable
          onPress={onCancel}
          hitSlop={HIT_SLOP}
          style={[
            styles.cancelBadge,
            {
              width: badgeSize,
              height: badgeSize,
              borderRadius: badgeSize / 2,
              top: -badgeSize * 0.28,
              right: -badgeSize * 0.28,
            },
          ]}
        >
          <Svg width={badgeSize} height={badgeSize}>
            <Line x1={badgeX} y1={badgeX} x2={badgeSize - badgeX} y2={badgeSize - badgeX} stroke="#fff" strokeWidth={2} strokeLinecap="round" />
            <Line x1={badgeX} y1={badgeSize - badgeX} x2={badgeSize - badgeX} y2={badgeX} stroke="#fff" strokeWidth={2} strokeLinecap="round" />
          </Svg>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
  },
  container: {
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  svg: {
    position: 'absolute',
  },
  percentText: {
    color: '#fff',
    fontWeight: '700',
  },
  cancelBadge: {
    position: 'absolute',
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
