import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, Animated, ScrollView, FlatList, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { alwaysDark } from '../../contexts/ThemeContext';
import { getWebrtc } from './webrtcGlobals';
import * as registry from './streamRegistry';
import CallAvatar from '../components/CallAvatar';
import useDraggablePip from '../components/useDraggablePip';
import useCallRoster from '../useCallRoster';
import { useCall } from '../useCall';
import {
  toggleChrome, setChromeVisible, useChromeVisible, setStageFocused,
} from '../screens/callChromeStore';
import {
  gridLayout, tileBox, fitAvatar, pageTiles, MAX_VIDEO_TILES,
} from '../callGridLayout';

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
 *    2 = stacked halves, 3 = the odd tile stretches its row, 4-8 = grid, and
 *    more people page sideways (up to 32). Tap a tile to spotlight it. Every
 *    participant gets a tile whether or not they have video — no camera just
 *    means an avatar tile.
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

// Peer camera off — their circular profile photo centered on a dark card;
// full-size, it also says WHO it is and why there is no picture (WhatsApp).
function RemoteCamOffCard({ peer, big }) {
  return (
    <View style={styles.camOffCard}>
      <CallAvatar uri={peer?.avatar} name={peer?.name} id={peer?.id} size={big ? 150 : 52} />
      {big && peer?.name ? <Text style={styles.camOffName} numberOfLines={1}>{peer.name}</Text> : null}
      {big ? (
        <View style={styles.camOffRow}>
          <Ionicons name="videocam-off" size={15} color="rgba(255,255,255,0.7)" />
          <Text style={styles.camOffSub}>Camera off</Text>
        </View>
      ) : null}
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

// Upper bound per density, and the first-frame fallback before the grid is
// measured — the real size is fitted to the measured tile (fitAvatar).
const groupAvatarFor = (n) => (n <= 2 ? 110 : n <= 4 ? 84 : 68);
// Cell padding (2 per side) + tile border (2 per side).
const G_TILE_GUTTER = 8;
// The avatar area stops above the bottom name chip (see gPlaceholder), so the
// reserve is that chip, the status line under the avatar, and breathing room.
const G_CHIP_H = 34;
const G_STATUS_H = 10 + 16;

// CallOverlay floats its top bar and its control row OVER this stage. In a 1:1
// call that is the point (full-bleed video under the chrome), but a grid tile's
// name chip would end up hidden behind the controls — so the group grid insets
// itself to sit BETWEEN them. Keep these in step with CallOverlay's
// videoTopBar / videoControls padding.
const TOP_BAR_H = 60;   // insets.top + 8 padding + 38 button + 14 padding
const CONTROLS_H = 112; // the control pill (padding + 56 button) + 22 bottom padding + a gap
// The 1:1 self / share tiles are kept below the call's top bar.
const PIP_TOP_RESERVE = TOP_BAR_H + 10;

// Spotlight filmstrip: the people who are not the big tile, in a row above the
// controls (Zoom / Meet speaker view).
const STRIP_TILE_W = 88;
const STRIP_TILE_H = 116;
const STRIP_GAP = 6;
const STRIP_H = STRIP_TILE_H + 12;
// Page dots under a multi-page gallery.
const DOTS_H = 16;

/**
 * One participant tile, used by the gallery cells, the spotlight (big) tile and
 * the filmstrip. `live` = this tile may mount its RTCView — off-screen gallery
 * pages pass false so a 32-person call never decodes 32 videos at once.
 */
function GroupTile({
  t, RTCView, live = true, avatarSize, variant = 'grid', onPress, children,
}) {
  const strip = variant === 'strip';
  const big = variant === 'focus';
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={[
        styles.gTile,
        strip && styles.gStripTile,
        big && styles.gFocusTile,
        t.dim && styles.gDim,
        t.speaking && styles.gSpeaking,
      ]}
    >
      {t.selfShare ? (
        <View style={styles.gPlaceholder}>
          <View style={[styles.camOffBadge, big && styles.camOffBadgeBig]}>
            <Ionicons name="phone-portrait-outline" size={big ? 40 : 22} color="rgba(255,255,255,0.9)" />
          </View>
          {strip ? null : <Text style={styles.gStatus}>You're sharing your screen</Text>}
        </View>
      ) : t.stream && live ? (
        <RTCView
          // Keyed on the TRACK: a replaceTrack/rejoin keeps the same
          // stream URL, and a stale key would keep painting a dead track.
          key={`${variant}:${t.key}:${videoTrackId(t.stream)}`}
          streamURL={t.stream.toURL()}
          style={styles.gFill}
          // A shared screen must never be cropped to fill the tile.
          objectFit={t.isScreen ? 'contain' : 'cover'}
          zOrder={strip ? 1 : 0}
          mirror={!!t.mirror}
        />
      ) : (
        <View style={[styles.gPlaceholder, strip && styles.gPlaceholderStrip]}>
          {t.isSelf && t.camOff ? (
            <View style={styles.camOffBadge}>
              <Ionicons name="videocam-off" size={22} color="rgba(255,255,255,0.9)" />
            </View>
          ) : (
            <CallAvatar uri={t.avatar} name={t.name} id={t.id} size={avatarSize} />
          )}
          {t.status && !strip ? <Text style={styles.gStatus}>{t.status}</Text> : null}
        </View>
      )}

      {/* The RTCView is a native view that takes the touch itself on iOS —
          the shield keeps the tap on the Pressable (see TouchShield). */}
      {onPress ? <TouchShield /> : null}

      <View style={[styles.gNameChip, strip && styles.gNameChipStrip]} pointerEvents="none">
        <Text style={[styles.gNameText, strip && styles.gNameTextStrip]} numberOfLines={1}>{t.name}</Text>
        {t.handle && !strip ? (
          <Text style={styles.gHandleText} numberOfLines={1}>{t.handle}</Text>
        ) : null}
      </View>

      {t.muted ? (
        <View style={[styles.gMicBadge, strip && styles.gMicBadgeStrip]} pointerEvents="none">
          <Ionicons name="mic-off" size={strip ? 11 : 13} color="#fff" />
        </View>
      ) : null}
      {children}
    </Pressable>
  );
}

/**
 * The GROUP / CONFERENCE participant stage.
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
 *  • every screen share, as an extra tile (contain, not cover — a cropped
 *    shared screen is useless), and "You're sharing your screen" while you are.
 *
 * Two views (Zoom / WhatsApp):
 *  • GALLERY — the grid. Up to MAX_VIDEO_TILES per page, laid out by
 *    callGridLayout so it re-flows as people join and leave (2 stacked, 3 with
 *    a stretched row, 2x2, 2x3, 2x4); more people page sideways, with dots.
 *  • SPOTLIGHT — tap any tile and it fills the stage; everyone else moves to a
 *    filmstrip above the controls (tap one to spotlight them instead, the grid
 *    button goes back). A NEW remote screen share is spotlighted on its own,
 *    and the view returns to the gallery when the spotlighted person leaves or
 *    the share stops.
 *
 * Tiles are ORDERED so the first page goes to people you can actually see:
 * shares, live video, then joined, then still-ringing.
 */
function CallGroupGrid({
  snap, RTCView, participants, rosterConnectedOnly,
  selfId, selfName, selfAvatar, cameraOn, micOn, activeSpeakerId, tapToToggle,
}) {
  const roster = useCallRoster(participants, { connectedOnly: rosterConnectedOnly });
  const { call } = useCall();
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const chromeShown = useChromeVisible();
  const [stageSize, setStageSize] = useState(null);
  const [page, setPage] = useState(0);
  const [focusKey, setFocusKey] = useState(null);
  const pagerRef = useRef(null);
  const seenShares = useRef(new Set());
  const onStageLayout = (e) => {
    const { width, height } = e.nativeEvent.layout;
    setStageSize((prev) => (prev && prev.width === width && prev.height === height
      ? prev : { width, height }));
  };
  const stageW = stageSize?.width || winW;
  const stageH = stageSize?.height || winH;
  // The minimized PiP draws this same stage, tiny, under its own tap target.
  const interactive = !!tapToToggle;

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
      // Resolved by useCallRoster, and already null when it would just repeat
      // the name — see the name chip.
      handle: p.handle || null,
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
  // Live video wins the first page, then people who are actually in the call,
  // then whoever is still ringing.
  others.sort((a, b) => (Number(!!b.stream) - Number(!!a.stream))
    || (Number(!!b.joined) - Number(!!a.joined)));

  // A shared screen is what everyone is looking AT, so it sits right after your
  // own tile — never sorted down among the faces.
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
  // Your own share: the people watching get the screen; you get a plain card
  // (a live preview of your own screen would just mirror itself).
  if (call?.screenSharing) {
    shares.unshift({ key: 'self#screen', id: selfId, name: 'You · screen', selfShare: true, joined: true });
  }

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

  // ---- spotlight bookkeeping ----
  const focused = focusKey ? tiles.find((t) => t.key === focusKey) || null : null;
  const remoteShareKeys = screens.map((r) => r.key).join('|');
  useEffect(() => {
    const cur = remoteShareKeys ? remoteShareKeys.split('|') : [];
    const fresh = cur.find((k) => !seenShares.current.has(k));
    // Forget ended shares, so the same person sharing AGAIN is spotlighted again.
    seenShares.current = new Set(cur);
    if (fresh) setFocusKey(fresh);
  }, [remoteShareKeys]);
  // The spotlighted person left / the share stopped → back to the gallery.
  useEffect(() => {
    if (focusKey && !focused) setFocusKey(null);
  }, [focusKey, focused]);
  const spotlight = !!focused;
  useEffect(() => { setStageFocused(spotlight && interactive); }, [spotlight, interactive]);
  useEffect(() => () => setStageFocused(false), []);

  const pages = pageTiles(tiles, MAX_VIDEO_TILES);
  const pageCount = pages.length;
  const curPage = Math.min(page, pageCount - 1);
  // People left and the last page vanished — slide back onto a real page.
  useEffect(() => {
    if (page > pageCount - 1) {
      setPage(pageCount - 1);
      pagerRef.current?.scrollTo?.({ x: (pageCount - 1) * stageW, animated: false });
    }
  }, [page, pageCount, stageW]);

  const focusTile = (key) => {
    if (!interactive) return;
    setFocusKey(key);
    setChromeVisible(true);
  };

  // ---- SPOTLIGHT ----
  if (focused) {
    // The big tile grows into the chrome's space while the chrome is hidden.
    const top = chromeShown || !interactive ? insets.top + TOP_BAR_H : insets.top;
    const bottom = chromeShown || !interactive ? insets.bottom + CONTROLS_H : insets.bottom + 6;
    const rest = tiles.filter((t) => t.key !== focused.key);
    const bigH = stageH - top - bottom - (rest.length ? STRIP_H : 0);
    const bigAvatar = Math.round(Math.max(56, Math.min(150, stageW * 0.36, bigH * 0.4)));
    return (
      <View style={styles.stage} pointerEvents="box-none" onLayout={onStageLayout}>
        <View style={[styles.gFocusArea, { top, height: Math.max(0, bigH) }]}>
          <GroupTile
            t={focused}
            RTCView={RTCView}
            variant="focus"
            avatarSize={bigAvatar}
            onPress={interactive ? toggleChrome : undefined}
          >
            {interactive ? (
              <Pressable
                onPress={() => setFocusKey(null)}
                style={styles.gGridBtn}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="grid-outline" size={18} color="#fff" />
              </Pressable>
            ) : null}
          </GroupTile>
        </View>
        {rest.length ? (
          <FlatList
            style={[styles.gStrip, { bottom }]}
            contentContainerStyle={styles.gStripContent}
            data={rest}
            horizontal
            keyExtractor={(t) => t.key}
            showsHorizontalScrollIndicator={false}
            initialNumToRender={6}
            windowSize={3}
            ItemSeparatorComponent={StripGap}
            renderItem={({ item }) => (
              <GroupTile
                t={item}
                RTCView={RTCView}
                variant="strip"
                avatarSize={44}
                onPress={interactive ? () => focusTile(item.key) : undefined}
              />
            )}
          />
        ) : null}
      </View>
    );
  }

  // ---- GALLERY ----
  const padTop = insets.top + TOP_BAR_H;
  const padBottom = insets.bottom + CONTROLS_H + (pageCount > 1 ? DOTS_H : 0);
  const gridH = stageH - padTop - padBottom;

  const renderPage = (pg, pi) => {
    const layout = gridLayout(pg.length, MAX_VIDEO_TILES);
    const box = tileBox(layout, stageW, gridH, G_TILE_GUTTER);
    const anyStatus = pg.some((t) => !t.stream && t.status);
    const avatarSize = fitAvatar(box, G_CHIP_H + (anyStatus ? G_STATUS_H : 0) + 12, groupAvatarFor(layout.count))
      || groupAvatarFor(layout.count);
    // Only the page on screen and its neighbours keep live video.
    const live = Math.abs(pi - curPage) <= 1;
    return (
      <View key={`page:${pi}`} style={[styles.gPage, { width: stageW, height: gridH }]}>
        {pg.map((t, i) => (
          <View key={t.key} style={[styles.gCell, layout.tileStyle(i)]}>
            <GroupTile
              t={t}
              RTCView={RTCView}
              live={live}
              avatarSize={avatarSize}
              onPress={interactive ? () => focusTile(t.key) : undefined}
            />
          </View>
        ))}
      </View>
    );
  };

  return (
    <View style={styles.stage} pointerEvents="box-none" onLayout={onStageLayout}>
      {tapToToggle ? <TapLayer /> : null}
      <View style={[styles.gPager, { top: padTop, height: gridH }]} pointerEvents={interactive ? 'box-none' : 'none'}>
        {pageCount > 1 ? (
          <ScrollView
            ref={pagerRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(e) => {
              setPage(Math.round(e.nativeEvent.contentOffset.x / Math.max(1, stageW)));
            }}
          >
            {pages.map(renderPage)}
          </ScrollView>
        ) : renderPage(pages[0], 0)}
      </View>
      {pageCount > 1 ? (
        <View style={[styles.gDots, { top: padTop + gridH }]} pointerEvents="none">
          {pages.map((_, i) => (
            <View key={i} style={[styles.gDot, i === curPage && styles.gDotOn]} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function StripGap() {
  return <View style={{ width: STRIP_GAP }} />;
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
  // Full-screen (not minimized) video: a tap on the video shows/hides the call
  // controls. Off for the minimized PiP, whose own pan/tap must win.
  tapToToggle = false,
}) {
  const [snap, setSnap] = useState(registry.getSnapshot);
  const { call, toggleScreenShare } = useCall();
  const insets = useSafeAreaInsets();
  // 1:1 only: true = local feed full-bleed, remote in the small tile.
  const [swapped, setSwapped] = useState(false);

  useEffect(() => registry.subscribe(() => setSnap(registry.getSnapshot())), []);

  const liveRemotes = (snap.remotes || []).filter((r) => r.stream && r.hasVideo);
  // A shared screen is its own feed (`<peerId>#screen`), never a camera.
  const screenRemotes = liveRemotes.filter((r) => String(r.key).endsWith('#screen'));
  const videoRemotes = liveRemotes.filter((r) => !String(r.key).endsWith('#screen'));
  const local = snap.local;
  const showLocal = !!(local && local.stream && local.hasVideo);
  // A 2-person GROUP/conference call is NOT the 1:1 layout — it stacks (see below).
  const oneToOne = !isGroup && videoRemotes.length === 1 && showLocal && !screenRemotes.length;
  const localOff = cameraOn === false;
  const remoteOff = remoteCameraOn === false;

  // A swap only makes sense while both 1:1 feeds are live — reset it whenever
  // that stops being true (call ended, peer left, group grew).
  useEffect(() => {
    if (!oneToOne && swapped) setSwapped(false);
  }, [oneToOne, swapped]);

  // WhatsApp-style drag-and-snap for the small self/PiP tile. One shared pan —
  // the chosen spot survives a tap-to-swap.
  // Free placement (no edge snap): the user parks the tiles wherever they
  // cover the least of the video / shared screen.
  const { pan, panHandlers } = useDraggablePip({
    width: PIP_W, height: PIP_H, enabled: true, initial: 'top-right', snapToEdge: false,
    topReserve: PIP_TOP_RESERVE, bottomReserve: CONTROLS_H,
  });
  // The sharer's camera tile during a 1:1 screen share — movable the same way.
  const { pan: camPan, panHandlers: camPanHandlers } = useDraggablePip({
    width: PIP_W, height: PIP_H, enabled: true, initial: 'top-left', snapToEdge: false,
    topReserve: PIP_TOP_RESERVE, bottomReserve: CONTROLS_H,
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
        tapToToggle={tapToToggle}
      />
    );
  }

  if (!videoRemotes.length && !showLocal && !screenRemotes.length) return null; // audio-only 1:1

  const grid = videoRemotes.length > 1;
  const mirrorLocal = !!(local && local.facing === 'user');

  // The draggable self tile, shared by the layouts below. It is rendered with
  // the SAME key and element tree (Animated.View → Pressable → RTCView keyed by
  // the track) in every layout, so React keeps the native view mounted when the
  // layout changes. Remounting it — e.g. when a peer's screen share ended and
  // the stage went back to the 1:1 layout — left Android's new SurfaceView
  // black (the old view of the same track was torn down in the same frame).
  const renderSelfTile = (onPress) => (
    <Animated.View
      key="self-tile"
      style={[styles.selfPreview, { transform: pan.getTranslateTransform() }]}
      {...panHandlers}
    >
      <Pressable
        onPress={onPress}
        disabled={!onPress}
        style={styles.smallFill}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
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
        <TouchShield />
      </Pressable>
    </Animated.View>
  );
  const selfTile = showLocal ? renderSelfTile(null) : null;

  // WE are sharing (1:1): the person watching gets the screen, and without
  // this the sharer's own call looked exactly like an ordinary video call.
  // Left-aligned under the top bar so it never sits under the self tile.
  const sharingPill = call?.screenSharing && tapToToggle ? (
    <View style={[styles.sharePill, { top: insets.top + TOP_BAR_H + 8 }]} pointerEvents="box-none">
      <Ionicons name="phone-portrait-outline" size={14} color="#fff" />
      <Text style={styles.sharePillText}>You're sharing your screen</Text>
      <Pressable onPress={toggleScreenShare} hitSlop={{ top: 8, bottom: 8, left: 6, right: 8 }}>
        <Text style={styles.sharePillStop}>Stop</Text>
      </Pressable>
    </View>
  ) : null;

  // ---- 1:1 screen share (WhatsApp / Meet style) ----
  // The shared screen owns the WHOLE stage, shown whole (contain, letterboxed
  // on black) — a phone or desktop screen cropped to `cover` is unreadable.
  // The sharer's camera (if on) is a small tile starting top-left, level with
  // your own tile top-right (both draggable anywhere), so neither sits on top of the shared content's
  // middle or of each other. (It used to split the stage 60/40, which shrank a
  // portrait phone screen to a sliver with the self tile parked over it.)
  if (screenRemotes.length) {
    const share = screenRemotes[0];
    const cam = !remoteOff ? videoRemotes.find((r) => r.peerId === share.peerId) || videoRemotes[0] : null;
    return (
      <View style={[styles.stage, styles.screenStage]} pointerEvents="box-none">
        <RTCView
          key={`screen:${share.key}:${videoTrackId(share.stream)}`}
          streamURL={share.stream.toURL()}
          style={styles.fillAbsolute}
          objectFit="contain"
          zOrder={0}
        />
        {tapToToggle ? <TapLayer /> : null}
        {cam ? (
          <Animated.View
            style={[styles.shareCamTile, { transform: camPan.getTranslateTransform() }]}
            {...camPanHandlers}
          >
            <RTCView
              key={`cam:${cam.key}:${videoTrackId(cam.stream)}`}
              streamURL={cam.stream.toURL()}
              style={styles.smallFill}
              objectFit="cover"
              zOrder={1}
            />
            <TouchShield />
          </Animated.View>
        ) : null}
        {selfTile}
        {sharingPill}
      </View>
    );
  }

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
        {tapToToggle ? <TapLayer /> : null}
        {smallIsLocal ? renderSelfTile(() => setSwapped((v) => !v)) : (
          <Animated.View
            key="peer-small-tile"
            style={[styles.selfPreview, { transform: pan.getTranslateTransform() }]}
            {...panHandlers}
          >
            <Pressable
              onPress={() => setSwapped((v) => !v)}
              style={styles.smallFill}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              {smallOff ? (
                <RemoteCamOffCard peer={peer} />
              ) : (
                <RTCView
                  key={`small:${remote.key}:${videoTrackId(small.stream)}`}
                  streamURL={small.stream.toURL()}
                  style={styles.smallFill}
                  objectFit="cover"
                  zOrder={1}
                />
              )}
              <TouchShield />
            </Pressable>
          </Animated.View>
        )}
        {sharingPill}
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
      {tapToToggle ? <TapLayer /> : null}
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
        ) : renderSelfTile(null)
      )}
      {sharingPill}
    </View>
  );
}

// Transparent cover over a small tile's video. On iOS (new architecture) the
// RTCView is a legacy-interop native view that took the touch itself, so the
// tile's drag (PanResponder) and tap-to-swap never saw it — the small window
// couldn't be moved on iOS while Android's could. A plain View on top makes the
// touch land on a React view every time.
function TouchShield() {
  return <View style={StyleSheet.absoluteFill} />;
}

// Transparent full-stage touch target BEHIND the self tile: tap → toggle the
// call controls (CallOverlay owns the auto-hide timer).
function TapLayer() {
  return <Pressable style={styles.tapLayer} onPress={toggleChrome} />;
}

const styles = StyleSheet.create({
  tapLayer: { ...StyleSheet.absoluteFillObject },
  sharePill: {
    position: 'absolute',
    left: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 10,
    paddingRight: 12,
    paddingVertical: 7,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sharePillText: { color: '#fff', fontFamily: 'Roboto-Medium', fontSize: 13 },
  sharePillStop: { color: '#FF5A5F', fontFamily: 'Roboto-Medium', fontSize: 13, marginLeft: 4 },
  // 1:1 screen share: the screen fills the stage on black; the sharer's camera
  // is a small fixed tile top-left (same size as the self tile).
  screenStage: { backgroundColor: '#000' },
  shareCamTile: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: PIP_W,
    height: PIP_H,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
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
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#111',
  },
  // ---- group / conference grid ----
  gPager: { position: 'absolute', left: 0, right: 0 },
  gPage: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    overflow: 'hidden',
  },
  gDots: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: DOTS_H,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  gDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.35)' },
  gDotOn: { backgroundColor: '#fff' },
  // Spotlight: the big tile, then the filmstrip of everyone else under it.
  gFocusArea: { position: 'absolute', left: 4, right: 4 },
  gFocusTile: { borderRadius: 16 },
  gGridBtn: {
    position: 'absolute',
    right: 10,
    top: 10,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  gStrip: { position: 'absolute', left: 0, right: 0, height: STRIP_H },
  gStripContent: { paddingHorizontal: 6, paddingVertical: 6 },
  gStripTile: { flex: 0, width: STRIP_TILE_W, height: STRIP_TILE_H, borderRadius: 12 },
  gPlaceholderStrip: { paddingBottom: 22, gap: 0 },
  gNameChipStrip: {
    left: 4, bottom: 4, right: 4, maxWidth: undefined, paddingHorizontal: 5, paddingVertical: 2,
  },
  gNameTextStrip: { fontSize: 10 },
  gMicBadgeStrip: {
    right: 4, top: 4, bottom: undefined, width: 20, height: 20, borderRadius: 10,
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
  // Content centres in the space ABOVE the bottom name chip, so the avatar and
  // status never slide under it on a short tile.
  gPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingTop: 6,
    paddingBottom: 34,
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
  gHandleText: { color: 'rgba(255,255,255,0.72)', fontFamily: 'Roboto-Regular', fontSize: 11 },
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
  camOffName: {
    color: '#fff',
    fontFamily: 'Roboto-Medium',
    fontSize: 20,
    marginTop: 8,
    maxWidth: '80%',
  },
  camOffRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  camOffSub: { color: 'rgba(255,255,255,0.7)', fontFamily: 'Roboto-Regular', fontSize: 14 },
  camOffText: {
    color: 'rgba(255,255,255,0.85)',
    fontFamily: 'Roboto-Regular',
    fontSize: 15,
  },
});

COL_W = { 1: styles.w100, 2: styles.w50, 3: styles.w33, 4: styles.w25 };
ROW_H = { 1: styles.h100, 2: styles.h50, 3: styles.h33, 4: styles.h25 };
