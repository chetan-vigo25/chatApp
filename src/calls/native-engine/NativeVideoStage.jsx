import React, { useEffect, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { alwaysDark } from '../../contexts/ThemeContext';
import { getWebrtc } from './webrtcGlobals';
import * as registry from './streamRegistry';
import CallAvatar from '../components/CallAvatar';
import useDraggablePip from '../components/useDraggablePip';
import useCallRoster from '../useCallRoster';
import { gridLayout, MAX_VIDEO_TILES } from '../callGridLayout';

/**
 * Video surface for the NATIVE call engine — replaces the WebView (which WAS
 * the video surface) on the native path. Mounted by CallProvider in the same
 * host container the WebView occupied (full-screen stage or draggable PiP), so
 * all existing layout/gesture logic is reused unchanged.
 *
 * Layout:
 *  - 1:1 → remote full-bleed + small DRAGGABLE local self-preview (WhatsApp
 *    drag-and-snap via useDraggablePip), and tap-to-SWAP which feed is
 *    full-bleed. CallOverlay sits above with pointerEvents="box-none".
 *  - GROUP / CONFERENCE → a real participant grid (CallGroupGrid below). YOUR
 *    OWN tile is part of the grid, not a floating PiP, so two people on a group
 *    call sit one ABOVE the other rather than one-in-a-corner-of-the-other.
 *    Geometry is shared with the voice roster via src/calls/callGridLayout.js:
 *    2 = stacked halves, 3 = the odd tile stretches its row, 4-6 = grid, and
 *    the overflow collapses into a "+N" chip. Every participant gets a tile
 *    whether or not they have video — no camera just means an avatar tile.
 *  - audio-only 1:1 (no video tracks anywhere) → renders nothing; CallOverlay's
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


// Status line under a participant who has no live feed yet — mirrors the voice
// roster's wording so a call reads the same on voice and video.
const tileStatus = (p) => {
  if (p.left) return 'Left';
  if (p.joined) return null;
  if (p.confStatus === 'RINGING' || p.confStatus === 'INVITED') return 'Ringing…';
  return 'Connecting…';
};

// Avatars shrink as the grid densifies so a 6-way call still reads.
const groupAvatarFor = (n) => (n <= 2 ? 110 : n <= 4 ? 80 : 62);

// CallOverlay floats its top bar and its control row OVER this stage. In a 1:1
// call that is the point (full-bleed video under the chrome), but a grid tile's
// name chip would end up hidden behind the controls — so the group grid insets
// itself to sit BETWEEN them. Keep these in step with CallOverlay's
// videoTopBar / videoControls padding.
const TOP_BAR_H = 60;   // insets.top + 8 padding + 38 button + 14 padding
const CONTROLS_H = 94;  // 16 padding + 56 button + 22 padding

/**
 * The GROUP / CONFERENCE participant grid.
 *
 * Split out as its own component on purpose: it owns the contact-directory
 * lookup (useCallRoster), and NativeVideoStage stays mounted for the whole app
 * session — so those hooks must only run while a group VIDEO call is actually
 * on screen, not from app start.
 *
 * Every person on the call gets exactly one tile, video or not:
 *  • you (always first, mirrored, "You"),
 *  • each roster member — their live feed if they have one, otherwise their
 *    avatar with "Ringing…"/"Connecting…"/"Left",
 *  • any screen share, as an extra tile (contain, not cover — a cropped
 *    shared screen is useless).
 *
 * Tiles are ORDERED so the limited slots go to people you can actually see:
 * live video first, then joined, then still-ringing. Past MAX_VIDEO_TILES the
 * remainder collapses into a "+N" chip on the last tile instead of shrinking
 * every tile into uselessness.
 */
function CallGroupGrid({
  snap, RTCView, participants, rosterConnectedOnly,
  selfId, selfName, selfAvatar, cameraOn, micOn, activeSpeakerId,
}) {
  const roster = useCallRoster(participants, { connectedOnly: rosterConnectedOnly });
  const insets = useSafeAreaInsets();

  const local = snap.local;
  const localOff = cameraOn === false;
  const localHasVideo = !!(local && local.stream && local.hasVideo) && !localOff;
  const mirrorLocal = !!(local && local.facing === 'user');
  const self = selfId != null ? String(selfId) : null;

  // Index the live remote feeds by peer, keeping screen shares aside — they are
  // their own tile, not a replacement for the owner's camera tile.
  const byPeer = new Map();
  const screens = [];
  (snap.remotes || []).forEach((r) => {
    if (!r || !r.stream) return;
    if (String(r.key).endsWith('#screen')) { if (r.hasVideo) screens.push(r); return; }
    if (r.peerId) byPeer.set(String(r.peerId), r);
  });

  const others = [];
  const seen = new Set();
  Object.values(roster || {}).forEach((p) => {
    if (!p || !p.id) return;
    const pid = String(p.id);
    if (self && pid === self) return; // never a second "You" tile
    seen.add(pid);
    const r = byPeer.get(pid);
    // The server roster is authoritative for a peer's camera: a paused track
    // can linger after they turn the camera off, so an `videoEnabled: false`
    // member shows their avatar even while a stale stream is still attached.
    const camOn = p.videoEnabled !== false;
    others.push({
      key: `p:${pid}`,
      id: p.id,
      name: p.name || 'Member',
      avatar: p.avatar,
      stream: camOn && r && r.hasVideo ? r.stream : null,
      status: tileStatus(p),
      joined: !!p.joined,
      dim: !!p.left,
      // Roster-driven mute (broadcast for group calls and conferences alike).
      // `undefined` on an older roster entry means UNKNOWN, never muted.
      muted: p.audioEnabled === false,
      speaking: !!p.joined && !p.left && pid === String(activeSpeakerId),
    });
  });
  // A live feed whose peer never landed in the roster still gets a tile —
  // otherwise their video would simply be invisible.
  byPeer.forEach((r, pid) => {
    if (seen.has(pid) || (self && pid === self) || !r.hasVideo) return;
    others.push({ key: `x:${pid}`, id: pid, name: 'Member', stream: r.stream, joined: true });
  });
  // Live video wins the limited slots, then people who are actually in the
  // call, then whoever is still ringing.
  others.sort((a, b) => (Number(!!b.stream) - Number(!!a.stream))
    || (Number(!!b.joined) - Number(!!a.joined)));

  // A shared screen is what everyone is looking AT, so it sits right after your
  // own tile — never sorted down among the faces, and never the tile that the
  // "+N" truncation eats.
  const shares = screens.map((r) => {
    const owner = roster?.[r.peerId];
    return {
      key: r.key,
      id: r.peerId,
      name: `${owner?.name || 'Someone'} · screen`,
      stream: r.stream,
      isScreen: true,
      joined: true,
    };
  });

  const tiles = [{
    key: 'self',
    id: selfId,
    name: selfName || 'You',
    avatar: selfAvatar,
    stream: localHasVideo ? local.stream : null,
    mirror: mirrorLocal,
    camOff: localOff,
    muted: micOn === false,
    isSelf: true,
  }, ...shares, ...others];

  const layout = gridLayout(tiles.length, MAX_VIDEO_TILES);
  const shown = tiles.slice(0, layout.count);
  const avatarSize = groupAvatarFor(layout.count);

  return (
    <View style={styles.stage} pointerEvents="box-none">
      <View
        style={[styles.gGrid, {
          paddingTop: insets.top + TOP_BAR_H,
          paddingBottom: insets.bottom + CONTROLS_H,
        }]}
        pointerEvents="none"
      >
        {shown.map((t, i) => (
          <View key={t.key} style={[styles.gCell, layout.tileStyle(i)]}>
            <View style={[
              styles.gTile,
              t.dim && styles.gDim,
              t.speaking && styles.gSpeaking,
            ]}>
              {t.stream ? (
                <RTCView
                  // Keyed on the TRACK: a replaceTrack/rejoin keeps the same
                  // stream URL, and a stale key would keep painting a dead track.
                  key={`${t.key}:${videoTrackId(t.stream)}`}
                  streamURL={t.stream.toURL()}
                  style={styles.gFill}
                  // A shared screen must never be cropped to fill the tile.
                  objectFit={t.isScreen ? 'contain' : 'cover'}
                  zOrder={0}
                  mirror={!!t.mirror}
                />
              ) : (
                <View style={styles.gPlaceholder}>
                  {t.isSelf && t.camOff ? (
                    <View style={styles.camOffBadge}>
                      <Ionicons name="videocam-off" size={22} color="rgba(255,255,255,0.9)" />
                    </View>
                  ) : (
                    <CallAvatar uri={t.avatar} name={t.name} id={t.id} size={avatarSize} />
                  )}
                  {t.status ? <Text style={styles.gStatus}>{t.status}</Text> : null}
                </View>
              )}

              <View style={styles.gNameChip}>
                <Text style={styles.gNameText} numberOfLines={1}>{t.name}</Text>
              </View>

              {/* Mic state is only known for YOURSELF — the roster carries no
                  per-member mute flag, so a remote tile never claims one. */}
              {t.muted ? (
                <View style={styles.gMicBadge}>
                  <Ionicons name="mic-off" size={13} color="#fff" />
                </View>
              ) : null}

              {layout.extra > 0 && layout.isLast(i) ? (
                <View style={styles.gMoreChip}>
                  <Text style={styles.gMoreText}>+{layout.extra}</Text>
                </View>
              ) : null}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

// Column-width / row-height style lookups for the split grid (see render).
let COL_W;
let ROW_H;

export default function NativeVideoStage({
  peer = null,
  cameraOn = true,
  remoteCameraOn = true,
  // ---- group / conference ----
  isGroup = false,
  isVideo = true,
  participants = null,        // raw call-machine roster (name-resolved here)
  rosterConnectedOnly = false, // receiver, once answered: hide non-joiners
  selfId = null,
  selfName = 'You',
  selfAvatar = null,
  micOn = true,
  activeSpeakerId = null,
}) {
  const [snap, setSnap] = useState(registry.getSnapshot);
  // 1:1 only: true = local feed full-bleed, remote in the small tile.
  const [swapped, setSwapped] = useState(false);

  useEffect(() => registry.subscribe(() => setSnap(registry.getSnapshot())), []);

  const videoRemotes = (snap.remotes || []).filter((r) => r.stream && r.hasVideo);
  const local = snap.local;
  const showLocal = !!(local && local.stream && local.hasVideo);
  // A 2-person GROUP/conference call is NOT the 1:1 layout — it stacks (see below).
  const oneToOne = !isGroup && videoRemotes.length === 1 && showLocal;
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

  // ---- GROUP / CONFERENCE: the participant grid (self is a TILE) ----
  // Rendered even when every camera is off — the avatar tiles ARE the group
  // video UI, and CallOverlay only draws the top bar and controls over them.
  if (isGroup && isVideo) {
    return (
      <CallGroupGrid
        snap={snap}
        RTCView={RTCView}
        participants={participants}
        rosterConnectedOnly={rosterConnectedOnly}
        selfId={selfId}
        selfName={selfName}
        selfAvatar={selfAvatar}
        cameraOn={cameraOn}
        micOn={micOn}
        activeSpeakerId={activeSpeakerId}
      />
    );
  }

  if (!videoRemotes.length && !showLocal) return null; // audio-only 1:1

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
    backgroundColor: alwaysDark.background,
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
  // ---- group / conference grid ----
  gGrid: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  // 2pt per cell = a 4pt visual gutter between neighbouring tiles.
  gCell: { padding: 2 },
  gTile: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: '#1F2C34',
    // Keeps the RTCView clipped to the tile's rounded corners.
    overflow: 'hidden',
  },
  gFill: { flex: 1 },
  gPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  gStatus: {
    color: 'rgba(255,255,255,0.7)',
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
  },
  // Someone the SFU currently hears.
  gSpeaking: { borderColor: '#00D26A' },
  gDim: { opacity: 0.45 },
  gNameChip: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    maxWidth: '70%',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  gNameText: { color: '#fff', fontFamily: 'Roboto-Medium', fontSize: 12 },
  gMicBadge: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  gMoreChip: {
    position: 'absolute',
    right: 8,
    top: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  gMoreText: { color: '#fff', fontFamily: 'Roboto-Medium', fontSize: 13 },
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
