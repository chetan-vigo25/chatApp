import React, { useEffect, useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { getWebrtc } from './webrtcGlobals';
import * as registry from './streamRegistry';

/**
 * Video surface for the NATIVE call engine — replaces the WebView (which WAS
 * the video surface) on the native path. Mounted by CallProvider in the same
 * host container the WebView occupied (full-screen stage or draggable PiP), so
 * all existing layout/gesture logic is reused unchanged.
 *
 * Layout parity with the WebView tiles:
 *  - 1:1 → remote full-bleed + small local self-preview (top-right), and the
 *    WhatsApp tap-to-SWAP: tapping the small tile exchanges which feed is
 *    full-bleed. CallOverlay sits above with pointerEvents="box-none", so the
 *    tap lands here; the stage itself is box-none so everything else still
 *    falls through.
 *  - group → equal flex-wrap grid of remote tiles (+ the self-preview; no swap)
 *  - audio-only (no video tracks anywhere) → renders nothing; CallOverlay's
 *    existing avatar UI is the whole screen, exactly like today.
 *
 * RTCViews are keyed on the VIDEO TRACK id, not just the stream: replaceTrack /
 * a rejoin re-produce keeps the same stream URL, and an RTCView that kept its
 * key would keep rendering the dead old track (frozen/black tile). A track
 * swap changes the key → clean remount on the live track.
 *
 * RTCView comes through the guarded loader: this component only mounts when
 * the native engine flag is ON, but a missing pod must still never crash.
 */
const videoTrackId = (stream) => {
  try {
    const t = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
    return (t && t.id) || 'novid';
  } catch (_) { return 'novid'; }
};

// Column-width / row-height style lookups for the split grid (see render).
let COL_W;
let ROW_H;

export default function NativeVideoStage() {
  const [snap, setSnap] = useState(registry.getSnapshot);
  // 1:1 only: true = local feed full-bleed, remote in the small tile.
  const [swapped, setSwapped] = useState(false);

  useEffect(() => registry.subscribe(() => setSnap(registry.getSnapshot())), []);

  const videoRemotes = (snap.remotes || []).filter((r) => r.stream && r.hasVideo);
  const local = snap.local;
  const showLocal = !!(local && local.stream && local.hasVideo);
  const oneToOne = videoRemotes.length === 1 && showLocal;

  // A swap only makes sense while both 1:1 feeds are live — reset it whenever
  // that stops being true (call ended, peer left, camera off, group grew).
  useEffect(() => {
    if (!oneToOne && swapped) setSwapped(false);
  }, [oneToOne, swapped]);

  const webrtc = getWebrtc();
  if (!webrtc || !webrtc.RTCView) return null;
  const { RTCView } = webrtc;

  if (!videoRemotes.length && !showLocal) return null; // audio-only call

  const grid = videoRemotes.length > 1;
  const mirrorLocal = !!(local && local.facing === 'user');

  // ---- 1:1 with both feeds: full-bleed + swappable self tile ----
  if (oneToOne) {
    const remote = videoRemotes[0];
    const big = swapped ? local : remote;
    const small = swapped ? remote : local;
    const bigIsLocal = swapped;
    const smallIsLocal = !swapped;
    return (
      <View style={styles.stage} pointerEvents="box-none">
        <RTCView
          key={`big:${bigIsLocal ? 'local' : remote.key}:${videoTrackId(big.stream)}`}
          streamURL={big.stream.toURL()}
          style={styles.fillAbsolute}
          objectFit="cover"
          zOrder={0}
          mirror={bigIsLocal && mirrorLocal}
        />
        <Pressable
          onPress={() => setSwapped((s) => !s)}
          style={styles.selfPreview}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <RTCView
            key={`small:${smallIsLocal ? 'local' : remote.key}:${videoTrackId(small.stream)}`}
            streamURL={small.stream.toURL()}
            style={styles.smallFill}
            objectFit="cover"
            zOrder={1}
            mirror={smallIsLocal && mirrorLocal}
          />
        </Pressable>
      </View>
    );
  }

  // ---- group grid / single-feed fallbacks ----
  // SPLIT-SCREEN parity with the WebView engine's #remotes grid: the tiles
  // always fill the whole stage. 2 feeds = full-height half/half split,
  // 3–4 = 2×2, 5–9 = 3 columns, 10+ = 4 columns.
  const n = videoRemotes.length;
  const cols = n <= 1 ? 1 : (n <= 4 ? 2 : (n <= 9 ? 3 : 4));
  const rows = Math.max(1, Math.ceil(n / cols));
  const tileSize = [COL_W[cols] || styles.w25, ROW_H[Math.min(rows, 4)] || styles.h25];
  return (
    <View style={styles.stage} pointerEvents="box-none">
      {videoRemotes.length > 0 && (
        <View style={grid ? styles.grid : styles.single} pointerEvents="none">
          {videoRemotes.map((r) => (
            <RTCView
              key={`${r.key}:${videoTrackId(r.stream)}`}
              streamURL={r.stream.toURL()}
              style={grid ? tileSize : styles.fill}
              objectFit="cover"
              zOrder={0}
            />
          ))}
        </View>
      )}
      {showLocal && (
        <View
          pointerEvents="none"
          style={[styles.selfPreview, !videoRemotes.length && styles.fillAbsolute]}
        >
          <RTCView
            key={`local:${videoTrackId(local.stream)}`}
            streamURL={local.stream.toURL()}
            style={styles.smallFill}
            objectFit="cover"
            zOrder={1}
            mirror={mirrorLocal}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stage: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  single: { flex: 1 },
  fill: { flex: 1 },
  smallFill: { width: '100%', height: '100%' },
  // Full-bleed feed (remote in 1:1, or the self-view before the peer connects).
  fillAbsolute: {
    ...StyleSheet.absoluteFillObject,
    width: undefined,
    height: undefined,
    borderRadius: 0,
  },
  grid: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  // Split-grid tile fractions (cols × rows picked at render time).
  w100: { width: '100%' },
  w50: { width: '50%' },
  w33: { width: '33.333%' },
  w25: { width: '25%' },
  h100: { height: '100%' },
  h50: { height: '50%' },
  h33: { height: '33.333%' },
  h25: { height: '25%' },
  selfPreview: {
    position: 'absolute',
    top: 60,
    right: 12,
    width: 108,
    height: 156,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#111',
  },
});

COL_W = { 1: styles.w100, 2: styles.w50, 3: styles.w33, 4: styles.w25 };
ROW_H = { 1: styles.h100, 2: styles.h50, 3: styles.h33, 4: styles.h25 };
