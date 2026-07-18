import React, { useEffect, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getWebrtc } from './webrtcGlobals';
import * as registry from './streamRegistry';
import CallAvatar from '../components/CallAvatar';
import useDraggablePip from '../components/useDraggablePip';

/**
 * Video surface for the NATIVE call engine — replaces the WebView (which WAS
 * the video surface) on the native path. Mounted by CallProvider in the same
 * host container the WebView occupied (full-screen stage or draggable PiP), so
 * all existing layout/gesture logic is reused unchanged.
 *
 * Layout parity with the WebView tiles:
 *  - 1:1 → remote full-bleed + small DRAGGABLE local self-preview (WhatsApp
 *    drag-and-snap via useDraggablePip), and tap-to-SWAP which feed is
 *    full-bleed. CallOverlay sits above with pointerEvents="box-none".
 *  - group → equal flex-wrap grid of remote tiles (+ the self-preview; no swap)
 *  - audio-only (no video tracks anywhere) → renders nothing; CallOverlay's
 *    existing avatar UI is the whole screen, exactly like today.
 *
 * Camera-off placeholders are PER TILE (WhatsApp behavior — only the side
 *  whose camera is off changes):
 *  - peer camera off (1:1, `remoteCameraOn` prop) → THEIR area shows their
 *    circular avatar on a dark card; the self tile keeps its live feed.
 *  - own camera off (`cameraOn` prop) → only the SELF tile shows the
 *    camera-off badge; the remote feed stays live.
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

const PIP_W = 108;
const PIP_H = 156;

// Own camera off — dark card with the camera-off badge (mirrors the WebView
// engine's .camoff placeholder). `big` = the card fills the whole stage.
function LocalCamOffCard({ big }) {
  return (
    <View style={styles.camOffCard}>
      <View style={[styles.camOffBadge, big && styles.camOffBadgeBig]}>
        <Ionicons name="videocam-off" size={big ? 44 : 22} color="rgba(255,255,255,0.9)" />
      </View>
      {big ? <Text style={styles.camOffText}>Camera off</Text> : null}
    </View>
  );
}

// Peer camera off — their circular profile photo centered on a dark card.
function RemoteCamOffCard({ peer, big }) {
  return (
    <View style={styles.camOffCard}>
      <CallAvatar uri={peer?.avatar} name={peer?.name} id={peer?.id} size={big ? 150 : 52} />
    </View>
  );
}

// Column-width / row-height style lookups for the split grid (see render).
let COL_W;
let ROW_H;

export default function NativeVideoStage({ peer = null, cameraOn = true, remoteCameraOn = true }) {
  const [snap, setSnap] = useState(registry.getSnapshot);
  // 1:1 only: true = local feed full-bleed, remote in the small tile.
  const [swapped, setSwapped] = useState(false);

  useEffect(() => registry.subscribe(() => setSnap(registry.getSnapshot())), []);

  const videoRemotes = (snap.remotes || []).filter((r) => r.stream && r.hasVideo);
  const local = snap.local;
  const showLocal = !!(local && local.stream && local.hasVideo);
  const oneToOne = videoRemotes.length === 1 && showLocal;
  const localOff = cameraOn === false;
  const remoteOff = remoteCameraOn === false;

  // A swap only makes sense while both 1:1 feeds are live — reset it whenever
  // that stops being true (call ended, peer left, group grew).
  useEffect(() => {
    if (!oneToOne && swapped) setSwapped(false);
  }, [oneToOne, swapped]);

  // WhatsApp-style drag-and-snap for the small self/PiP tile. One shared pan —
  // the chosen spot survives a tap-to-swap.
  const { pan, panHandlers } = useDraggablePip({
    width: PIP_W, height: PIP_H, enabled: true, initial: 'top-right',
  });

  const webrtc = getWebrtc();
  if (!webrtc || !webrtc.RTCView) return null;
  const { RTCView } = webrtc;

  if (!videoRemotes.length && !showLocal) return null; // audio-only call

  const grid = videoRemotes.length > 1;
  const mirrorLocal = !!(local && local.facing === 'user');

  // ---- 1:1 with both feeds: full-bleed + swappable draggable self tile ----
  if (oneToOne) {
    const remote = videoRemotes[0];
    const big = swapped ? local : remote;
    const small = swapped ? remote : local;
    const bigIsLocal = swapped;
    const smallIsLocal = !swapped;
    const bigOff = bigIsLocal ? localOff : remoteOff;
    const smallOff = smallIsLocal ? localOff : remoteOff;
    return (
      <View style={styles.stage} pointerEvents="box-none">
        {bigOff ? (
          <View style={styles.fillAbsolute} pointerEvents="none">
            {bigIsLocal ? <LocalCamOffCard big /> : <RemoteCamOffCard peer={peer} big />}
          </View>
        ) : (
          <RTCView
            key={`big:${bigIsLocal ? 'local' : remote.key}:${videoTrackId(big.stream)}`}
            streamURL={big.stream.toURL()}
            style={styles.fillAbsolute}
            objectFit="cover"
            zOrder={0}
            mirror={bigIsLocal && mirrorLocal}
          />
        )}
        <Animated.View
          style={[styles.selfPreview, { transform: pan.getTranslateTransform() }]}
          {...panHandlers}
        >
          <Pressable
            onPress={() => setSwapped((s) => !s)}
            style={styles.smallFill}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            {smallOff ? (
              smallIsLocal ? <LocalCamOffCard /> : <RemoteCamOffCard peer={peer} />
            ) : (
              <RTCView
                key={`small:${smallIsLocal ? 'local' : remote.key}:${videoTrackId(small.stream)}`}
                streamURL={small.stream.toURL()}
                style={styles.smallFill}
                objectFit="cover"
                zOrder={1}
                mirror={smallIsLocal && mirrorLocal}
              />
            )}
          </Pressable>
        </Animated.View>
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
  // 1:1 where the peer's camera is off and their (paused) video track is gone:
  // their area is still THEIR avatar card, and the self tile stays small — the
  // self feed only goes full-bleed (solo) when there's genuinely no remote.
  const remoteOffFull = remoteOff && !videoRemotes.length && !!peer;
  const soloLocal = !videoRemotes.length && !remoteOffFull;
  return (
    <View style={styles.stage} pointerEvents="box-none">
      {remoteOffFull ? (
        <View style={styles.fillAbsolute} pointerEvents="none">
          <RemoteCamOffCard peer={peer} big />
        </View>
      ) : null}
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
        soloLocal ? (
          <View pointerEvents="none" style={styles.fillAbsolute}>
            {localOff ? (
              <LocalCamOffCard big />
            ) : (
              <RTCView
                key={`local:${videoTrackId(local.stream)}`}
                streamURL={local.stream.toURL()}
                style={styles.smallFill}
                objectFit="cover"
                zOrder={1}
                mirror={mirrorLocal}
              />
            )}
          </View>
        ) : (
          <Animated.View
            style={[styles.selfPreview, { transform: pan.getTranslateTransform() }]}
            {...panHandlers}
          >
            {localOff ? (
              <LocalCamOffCard />
            ) : (
              <RTCView
                key={`local:${videoTrackId(local.stream)}`}
                streamURL={local.stream.toURL()}
                style={styles.smallFill}
                objectFit="cover"
                zOrder={1}
                mirror={mirrorLocal}
              />
            )}
          </Animated.View>
        )
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
  // Draggable small self/PiP tile — position comes from useDraggablePip's
  // translate transform (anchored at the stage origin), not fixed offsets.
  selfPreview: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: PIP_W,
    height: PIP_H,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#111',
  },
  // Camera-off placeholder card (both tiles) — dark surface, centered content.
  camOffCard: {
    flex: 1,
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: '#1F2C34',
  },
  camOffBadge: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  camOffBadgeBig: {
    width: 96,
    height: 96,
    borderRadius: 48,
  },
  camOffText: {
    color: 'rgba(255,255,255,0.85)',
    fontFamily: 'Roboto-Regular',
    fontSize: 15,
  },
});

COL_W = { 1: styles.w100, 2: styles.w50, 3: styles.w33, 4: styles.w25 };
ROW_H = { 1: styles.h100, 2: styles.h50, 3: styles.h33, 4: styles.h25 };
