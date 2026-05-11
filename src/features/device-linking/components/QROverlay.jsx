/**
 * QR Scanner overlay with a transparent cutout and animated scan line.
 * Renders the dark overlay around the scan area with corner bracket markers.
 */
import React from 'react';
import { View, StyleSheet, Dimensions, Animated } from 'react-native';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const SCAN_SIZE = SCREEN_WIDTH * 0.7;
const CORNER_SIZE = 28;
const CORNER_WIDTH = 3;
const ACCENT = '#25D366';

export default function QROverlay({ scanLineAnim, showScanLine = true }) {
  const translateY = scanLineAnim
    ? scanLineAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [0, SCAN_SIZE - 4],
      })
    : new Animated.Value(0);

  return (
    <View style={styles.wrapper} pointerEvents="none">
      {/* Top overlay */}
      <View style={styles.overlayTop} />

      {/* Middle row: left overlay | scan area | right overlay */}
      <View style={styles.middleRow}>
        <View style={styles.overlaySide} />
        <View style={styles.scanArea}>
          {/* Corner brackets */}
          <View style={[styles.corner, styles.tl]} />
          <View style={[styles.corner, styles.tr]} />
          <View style={[styles.corner, styles.bl]} />
          <View style={[styles.corner, styles.br]} />

          {/* Animated scan line */}
          {showScanLine && (
            <Animated.View
              style={[styles.scanLine, { transform: [{ translateY }] }]}
            />
          )}
        </View>
        <View style={styles.overlaySide} />
      </View>

      {/* Bottom overlay */}
      <View style={styles.overlayBottom} />
    </View>
  );
}

/** Exported so screens can reference the same size */
QROverlay.SCAN_SIZE = SCAN_SIZE;

const OVERLAY_COLOR = 'rgba(0,0,0,0.55)';

const styles = StyleSheet.create({
  wrapper: {
    ...StyleSheet.absoluteFillObject,
  },
  overlayTop: {
    flex: 1,
    backgroundColor: OVERLAY_COLOR,
  },
  middleRow: {
    flexDirection: 'row',
    height: SCAN_SIZE,
  },
  overlaySide: {
    flex: 1,
    backgroundColor: OVERLAY_COLOR,
  },
  scanArea: {
    width: SCAN_SIZE,
    height: SCAN_SIZE,
    backgroundColor: 'transparent',
    overflow: 'hidden',
  },
  overlayBottom: {
    flex: 1,
    backgroundColor: OVERLAY_COLOR,
  },
  corner: {
    position: 'absolute',
    width: CORNER_SIZE,
    height: CORNER_SIZE,
  },
  tl: {
    top: 0,
    left: 0,
    borderTopWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderColor: ACCENT,
  },
  tr: {
    top: 0,
    right: 0,
    borderTopWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderColor: ACCENT,
  },
  bl: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderColor: ACCENT,
  },
  br: {
    bottom: 0,
    right: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderColor: ACCENT,
  },
  scanLine: {
    width: '100%',
    height: 2,
    backgroundColor: ACCENT,
  },
});