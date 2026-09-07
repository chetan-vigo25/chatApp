/**
 * AttachmentSheet — the WhatsApp-style two-snap attachment sheet behind the
 * composer's paperclip.
 *
 *   half — grab handle, 2x4 attach grid, a peek of the gallery grid below it.
 *          The composer stays visible above the sheet (the host lifts its
 *          content by `liftSV`).
 *   full — the attach grid crossfades out, a `x  Recents  HD` picker header
 *          takes its place, and the gallery grid gets the whole sheet, stopping
 *          just under the chat header.
 *
 * It is NOT a <Modal>. On Android a Modal renders in its own dialog window,
 * which inherits neither the activity's adjustResize nor the gesture-handler
 * root; rendering as an in-screen absolute overlay makes both problems vanish.
 *
 * ── Rules this file holds to (each one was a real, observed bug) ──
 *  • Nothing that affects layout is ever animated. Only `transform` and
 *    `opacity` live inside a useAnimatedStyle — the attach panel fades in
 *    place, the picker header + grid are ONE block that slides. Animating
 *    `height` re-measured the whole grid every frame and visibly lagged on
 *    Android.
 *  • `overflow: 'hidden'` is deliberately absent — rounded-corner clipping
 *    costs a clip path per frame. The sheet is FULL_H tall at every snap, so
 *    whatever slides down leaves through the bottom of the screen, never out
 *    of the sheet. PICKER_SHIFT is clamped to HALF_Y to keep that true.
 *  • Paint order is load-bearing: `pickerBlock` renders BEFORE `attachWrap`,
 *    so the opaque attach panel paints on top and fades out to reveal the
 *    grid — a true crossfade. The handle row renders last and is transparent.
 *  • No `elevation` on the FABs (Android recomputes the shadow every frame);
 *    a hairline border carries the edge in both themes instead.
 *
 * Media selected here is normalized to the SAME `{ uri, name, type, ... }`
 * shape the system picker produces (utils/deviceMedia), so an in-sheet pick
 * and a picker pick travel the identical sendMedia / sendMediaGroup path — no
 * new API surface, no new socket events.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Dimensions,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  Easing,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '../contexts/ThemeContext';
import useDeviceMediaLibrary from '../hooks/useDeviceMediaLibrary';
import { createSelectionStore } from '../utils/mediaSelectionStore';
import { normalizeLibraryAssets } from '../utils/deviceMedia';
import MediaGridCell from './MediaGridCell';

const SCREEN_W = Dimensions.get('window').width;

// ── Geometry. Change these to retune; everything else derives. ──────────────
const HEADER_H = Platform.OS === 'ios' ? 56 : 60; // chat header — full stops below it
const HANDLE_H = 24;   // grab-handle strip
const ATTACH_H = 208;  // 2 rows x 88 + 16 row gap + 16 vertical padding
const PICKER_H = 56;   // "x  Recents  HD" row
const PEEK_H = 150;    // gallery visible in the half state (~1.5 rows)
const GRID_GAP = 12;   // breathing room between the attach grid and the peek
const ATTACH_ROW_H = 88;

const GUTTER = 2;
const COLS = 4;
const TILE = (SCREEN_W - GUTTER * (COLS + 1)) / COLS;

const SPRING = { damping: 24, stiffness: 240, overshootClamping: true };
const CLOSE_MS = 180;

// How far a release velocity is projected forward before the nearest snap
// point is chosen. Raise it to make flicks travel further, lower it to make
// the sheet stickier.
const VELOCITY_PROJECTION = 0.2;

/**
 * The attach grid: four tiles per row, wrapping. ATTACH_H is sized for exactly
 * TWO rows, so any count from 5 to 8 fits (a short last row just leaves a gap
 * on the right, as WhatsApp's does). Drop to 4 or fewer, or go past 8, and
 * ATTACH_H must be re-derived — see the geometry block above.
 *
 * `id` is the key ChatScreen's option handler already switches on, so the
 * existing gallery / camera / video / document / audio / contact / location
 * flows are untouched.
 *
 * The disc behind each glyph is always `colors.surface` and the tint colours
 * the glyph alone — that flat treatment is what makes the row read as
 * icons-with-captions rather than a sheet of coloured stickers. One hue cannot
 * hold contrast on both a near-black and a white sheet, so each tile carries a
 * lighter step for dark mode and a deeper one for light.
 */
export const ATTACH_OPTIONS = [
  { id: 'gallery',  label: 'Gallery',  icon: 'images',        dark: '#C77DFF', light: '#8E24AA' },
  { id: 'camera',   label: 'Camera',   icon: 'camera',        dark: '#FF7BAC', light: '#E91E63' },
  { id: 'video',    label: 'Video',    icon: 'videocam',      dark: '#FF8A80', light: '#E53935' },
  { id: 'document', label: 'Document', icon: 'document-text', dark: '#94A0F0', light: '#5C6BC0' },
  { id: 'audio',    label: 'Audio',    icon: 'headset',       dark: '#FFB74D', light: '#EF6C00' },
  { id: 'contact',  label: 'Contact',  icon: 'person',        dark: '#5FC3F5', light: '#039BE5' },
  { id: 'location', label: 'Location', icon: 'location',      dark: '#7BD98A', light: '#43A047' },
];

const AnimatedFlatList = Reanimated.FlatList;

const CAMERA_CELL = { id: '__camera__', kind: 'camera' };

// Row pitch for getItemLayout. Fixed, so VirtualizedList can jump straight to
// any scroll offset instead of measuring its way there — the difference
// between a smooth fling and a stuttering one on a 10k-item roll.
const ROW_H = TILE + GUTTER;

const MEDIA_SELECT_LIMIT = 30;

/** Subscribe to just the selection COUNT — a number, so it never over-renders. */
function useSelectionCount(store) {
  return useSyncExternalStore(store.subscribe, store.getCount);
}

export default function AttachmentSheet({
  visible,
  onClose,
  onSelectOption,
  onSendMedia,
  onOpenSystemPicker,
  liftSV,
  containerHeight,
  options = ATTACH_OPTIONS,
}) {
  const { theme, chatColor, isDarkMode } = useTheme();
  const colors = theme.colors;
  const fonts = theme.fonts;
  const accent = chatColor || colors.themeColor;

  // Host callbacks behind a ref so every handler below can be declared with []
  // deps and stay referentially stable for the sheet's whole life. Without
  // this, a host that re-creates `onClose` each render (a chat screen
  // re-rendering per keystroke, say) would change `renderItem`'s identity and
  // make VirtualizedList reconcile every visible tile on every keypress.
  const callbacks = useRef({ onClose, onSelectOption, onSendMedia, onOpenSystemPicker });
  callbacks.current = { onClose, onSelectOption, onSendMedia, onOpenSystemPicker };

  // Kept alive through the 180ms close animation, so the sheet can slide out
  // after the host has already flipped `visible` to false.
  const [mounted, setMounted] = useState(visible);
  const [expanded, setExpanded] = useState(false);

  // ── Derived geometry ──────────────────────────────────────────────────────
  // The screen sits inside RootNavigator's SafeAreaView, so `containerHeight`
  // is already inset on both edges — subtracting insets here would double-count
  // them. The host measures it and hands it over.
  const FULL_H = Math.max(240, (containerHeight || 0) - HEADER_H);
  const HALF_H = HANDLE_H + ATTACH_H + GRID_GAP + PEEK_H;
  // The max() floors keep every interpolate() input range strictly monotonic on
  // a very short screen where HALF_H could swallow FULL_H — duplicate input
  // points are undefined behaviour.
  const HALF_Y = Math.max(1, FULL_H - HALF_H);
  const SWAP = Math.max(0.5, HALF_Y * 0.35);
  const FADE_IN = Math.max(SWAP + 0.5, HALF_Y * 0.8);
  // Subtracting PICKER_H is on purpose: in the half state the picker header
  // (at opacity 0) hides BEHIND the opaque attach panel. Without it, its 56pt
  // would read as a blank band above the peek. Clamped to HALF_Y so the block
  // can never slide past the bottom of the screen (see the overflow note above).
  const PICKER_SHIFT = Math.min(ATTACH_H - PICKER_H + GRID_GAP, HALF_Y);

  // ── Gesture / animation state ─────────────────────────────────────────────
  const ty = useSharedValue(FULL_H);          // 0 = full, HALF_Y = half, FULL_H = closed
  const expandedSV = useSharedValue(false);   // same flag as `expanded`, worklet-readable
  const scrollY = useSharedValue(0);          // grid scroll offset
  const start = useSharedValue(0);            // ty at drag start
  const anchor = useSharedValue(0);           // translation the list already ate
  const moved = useSharedValue(false);        // did the sheet itself move this drag?
  // `mounted`, readable from the lift reaction. The host pads its content by
  // whatever this component reports, so the reaction must never be able to
  // report a lift while the sheet is off screen.
  const mountedSV = useSharedValue(false);

  const closingRef = useRef(false);
  const listRef = useRef(null);

  // ── Media ─────────────────────────────────────────────────────────────────
  // Permission, paging and the native change observer all live in the hook, so
  // this component never touches MediaLibrary directly. `enabled` is the only
  // input: closed sheet, zero listeners and zero queries.
  const media = useDeviceMediaLibrary({ enabled: mounted && visible });

  // Selection lives OUTSIDE React on purpose — see utils/mediaSelectionStore.
  // Held in a ref so its identity is stable for the life of the sheet, which is
  // what lets `renderItem` and every cell prop stay referentially stable.
  const selectionRef = useRef(null);
  if (selectionRef.current === null) {
    selectionRef.current = createSelectionStore({ limit: MEDIA_SELECT_LIMIT });
  }
  const selection = selectionRef.current;
  const selectedCount = useSelectionCount(selection);

  const [sending, setSending] = useState(false);
  const [albumOpen, setAlbumOpen] = useState(false);
  // View once — the same "1" affordance the composer's pending-media strip
  // carries, offered here so a multi-select can be sent view-once without
  // going through the composer one item at a time.
  const [viewOnce, setViewOnce] = useState(false);

  // Set true on SETUP, not just false on cleanup. A cleanup-only version leaks
  // across any remount that reuses the ref — Fast Refresh and StrictMode both
  // run cleanup→setup on the same instance — leaving `alive` false for the rest
  // of the session, so every guarded write below would silently no-op.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // The camera tile is data, not a header, so it scrolls with the grid and
  // shares its recycling. Rebuilt only when the asset array identity changes —
  // which the hook does only on a real insert, never on selection.
  const gridData = useMemo(() => [CAMERA_CELL, ...media.assets], [media.assets]);

  // ── Open / close ──────────────────────────────────────────────────────────
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    callbacks.current.onClose?.();
  }, []);

  useEffect(() => {
    if (visible) {
      closingRef.current = false;
      // Park at the closed position BEFORE the first painted frame. `ty` still
      // holds whatever the previous open left behind (or an initial FULL_H
      // computed before the container was measured), and mounting at that value
      // flashes a half-drawn sheet for one frame.
      ty.value = FULL_H;
      mountedSV.value = true;
      setMounted(true);
      return;
    }
    if (!mounted) return;
    setExpanded(false);
    expandedSV.value = false;
    ty.value = withTiming(
      FULL_H,
      { duration: CLOSE_MS, easing: Easing.bezier(0.4, 0, 1, 1) },
      (finished) => {
        if (!finished) return;
        mountedSV.value = false;
        runOnJS(setMounted)(false);
      },
    );

    // A sheet that fails to unmount leaves an invisible scrim over the whole
    // chat and nothing on the screen responds again, so unmounting must not
    // hinge on the animation reporting completion. Anything that interrupts it
    // (a re-open) clears this timer through the effect's own cleanup.
    const failsafe = setTimeout(() => {
      mountedSV.value = false;
      setMounted(false);
    }, CLOSE_MS + 120);
    return () => clearTimeout(failsafe);
  }, [visible, mounted, FULL_H, ty, expandedSV, mountedSV]);

  // Slide in only once the container has actually been measured — opening
  // against a FULL_H of 0 would snap the sheet to the wrong place.
  const openedRef = useRef(false);
  useEffect(() => {
    if (!mounted || !visible || !containerHeight) return;
    if (openedRef.current) return;
    openedRef.current = true;
    ty.value = FULL_H;
    ty.value = withSpring(HALF_Y, SPRING);
  }, [mounted, visible, containerHeight, FULL_H, HALF_Y, ty]);

  useEffect(() => {
    if (!visible) {
      openedRef.current = false;
      selection.clear();
      setAlbumOpen(false);
      setViewOnce(false);
    }
  }, [visible, selection]);

  // `ty` is seeded from a FULL_H computed BEFORE the host had measured itself,
  // so it starts far above the real closed position. Re-park it every time
  // FULL_H changes while the sheet is down (first measure, rotation, a resize):
  // otherwise `FULL_H - ty` reads as a sheet that is partly open and the host
  // pads its content by a phantom lift — a permanent gap under the composer.
  //
  // `!mounted` is load-bearing, not a micro-optimisation. While the sheet is
  // sliding out, `visible` is ALREADY false and the close animation owns `ty`;
  // assigning to it here cancels that animation, its completion callback fires
  // with finished === false, and the sheet never unmounts — leaving an
  // invisible full-screen scrim over the chat that swallows every touch.
  useEffect(() => {
    if (!visible && !mounted) ty.value = FULL_H;
  }, [visible, mounted, FULL_H, ty]);

  // The host lifts its content by this much so the composer rides above the
  // sheet. Clamped to HALF_H: past the half snap the sheet covers the composer
  // anyway, and padding the content by the full sheet height would collapse the
  // message list to nothing mid-drag.
  useAnimatedReaction(
    () => (mountedSV.value ? Math.max(0, Math.min(HALF_H, FULL_H - ty.value)) : 0),
    (v) => {
      if (liftSV) liftSV.value = v;
    },
    [FULL_H, HALF_H],
  );

  useEffect(() => () => { if (liftSV) liftSV.value = 0; }, [liftSV]);

  // Collapsing always returns the grid to the top: the half state shows a
  // 150pt peek, and leaving it parked wherever the user had scrolled to makes
  // that peek a slice of arbitrary mid-roll photos.
  const resetGridScroll = useCallback(() => {
    scrollY.value = 0;
    try { listRef.current?.scrollToOffset?.({ offset: 0, animated: false }); } catch { /* list not mounted */ }
  }, [scrollY]);

  const collapseToHalf = useCallback(() => {
    setExpanded(false);
    expandedSV.value = false;
    resetGridScroll();
    ty.value = withSpring(HALF_Y, SPRING);
  }, [HALF_Y, ty, expandedSV, resetGridScroll]);

  useEffect(() => {
    if (!expanded) resetGridScroll();
  }, [expanded, resetGridScroll]);

  // Android back collapses full → half first, and only closes from half.
  // Registered while the sheet is up, so it runs before the screen's own
  // handler (LIFO).
  useEffect(() => {
    if (!mounted || !visible) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (albumOpen) { setAlbumOpen(false); return true; }
      if (selectedCount > 0) { selection.clear(); setViewOnce(false); return true; }
      if (expanded) { collapseToHalf(); return true; }
      requestClose();
      return true;
    });
    return () => sub.remove();
  }, [mounted, visible, expanded, albumOpen, selectedCount, selection, collapseToHalf, requestClose]);

  const chooseAlbum = useCallback((next) => {
    setAlbumOpen(false);
    selection.clear();
    media.selectAlbum(next);
  }, [media, selection]);

  const toggleAlbumDropdown = useCallback(() => {
    // Albums are fetched on first open, never on sheet open: counting them
    // walks every row in MediaStore. See useDeviceMediaLibrary.ensureAlbums.
    media.ensureAlbums();
    setAlbumOpen((open) => !open);
  }, [media]);

  // ── Selection ─────────────────────────────────────────────────────────────
  // Stable for the life of the sheet: `selection` is a ref, so this identity
  // never changes and neither does any cell's onPress prop.
  const togglePick = useCallback((id) => {
    // `toggle` refuses past the limit rather than silently dropping the tap —
    // an unresponsive tile reads as a broken grid.
    if (!selection.toggle(id)) {
      Alert.alert('Limit reached', `You can send up to ${MEDIA_SELECT_LIMIT} items at once.`);
    }
  }, [selection]);

  /**
   * Resolve ORIGINALS — and only now.
   *
   * The grid has been rendering the OS's own thumbnail-sized decodes all along;
   * this is the first and only point where full-resolution assets are touched,
   * for the handful the user actually picked. On iOS that means resolving each
   * ph:// identifier to a real file, which is why it is emphatically not
   * something to do per visible tile.
   */
  const handleSend = useCallback(async () => {
    const ids = selection.getIds();
    if (sending || ids.length === 0) return;
    setSending(true);
    try {
      const byId = new Map(media.assets.map((asset) => [asset.id, asset]));
      const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
      const files = await normalizeLibraryAssets(ordered);
      const once = viewOnce;
      selection.clear();
      setViewOnce(false);
      requestClose();
      if (files.length) callbacks.current.onSendMedia?.(files, { viewOnce: once });
    } catch (err) {
      console.warn('[AttachmentSheet] send failed', err?.message || err);
    } finally {
      if (aliveRef.current) setSending(false);
    }
  }, [media.assets, requestClose, selection, sending, viewOnce]);

  const handleOptionPress = useCallback((option) => {
    requestClose();
    callbacks.current.onSelectOption?.(option);
  }, [requestClose]);

  const handleCameraCell = useCallback(() => {
    handleOptionPress({ id: 'camera' });
  }, [handleOptionPress]);

  const handleFolder = useCallback(() => {
    requestClose();
    callbacks.current.onOpenSystemPicker?.();
  }, [requestClose]);

  // ── Gestures ──────────────────────────────────────────────────────────────
  // A plain FlatList carries no gesture-handler handler, so
  // simultaneousWithExternalGesture(ref) establishes nothing and the scroll
  // swallows the pan entirely — pulling down in the full state would do
  // nothing. The list must be wrapped in an explicit Gesture.Native() and the
  // pan must reference THAT.
  const listGesture = useMemo(() => Gesture.Native(), []);

  const pan = useMemo(() => Gesture.Pan()
    .simultaneousWithExternalGesture(listGesture)
    .activeOffsetY([-8, 8])
    .onBegin(() => {
      start.value = ty.value;
      anchor.value = 0;
      moved.value = false;
    })
    .onUpdate((e) => {
      // Full state: the list has first claim — it is either already scrolled,
      // or the user is swiping up. Leave the sheet alone, but bank the
      // translation in `anchor` so that when the list hits the top and hands
      // over, the sheet starts from the finger's current position instead of
      // jumping by the distance the list already ate.
      const listOwns = expandedSV.value && (scrollY.value > 0 || e.translationY < 0);
      if (listOwns) {
        anchor.value = e.translationY;
        start.value = ty.value;
        return;
      }
      moved.value = true;
      ty.value = Math.min(FULL_H, Math.max(0, start.value + (e.translationY - anchor.value)));
    })
    .onEnd((e) => {
      // The list ate the whole drag — a scroll fling must not be read as a
      // sheet flick.
      if (!moved.value) return;

      const projected = ty.value + e.velocityY * VELOCITY_PROJECTION;
      const points = [0, HALF_Y, FULL_H];
      let best = points[0];
      for (let i = 1; i < points.length; i += 1) {
        if (Math.abs(points[i] - projected) < Math.abs(best - projected)) best = points[i];
      }

      if (best === FULL_H) {
        runOnJS(requestClose)();
        return;
      }
      const isFull = best === 0;
      expandedSV.value = isFull;
      runOnJS(setExpanded)(isFull);
      ty.value = withSpring(best, SPRING);
    }), [listGesture, FULL_H, HALF_Y, ty, start, anchor, moved, expandedSV, scrollY, requestClose]);

  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => { scrollY.value = e.contentOffset.y; },
  });

  // ── Animated styles (transform + opacity only) ────────────────────────────
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: ty.value }],
  }));

  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(ty.value, [0, HALF_Y, FULL_H], [0.5, 0.22, 0], Extrapolation.CLAMP),
  }));

  const attachStyle = useAnimatedStyle(() => ({
    opacity: interpolate(ty.value, [SWAP, FADE_IN], [0, 1], Extrapolation.CLAMP),
  }));

  const pickerBlockStyle = useAnimatedStyle(() => ({
    transform: [{
      translateY: interpolate(ty.value, [0, HALF_Y], [0, PICKER_SHIFT], Extrapolation.CLAMP),
    }],
  }));

  const pickerHeaderStyle = useAnimatedStyle(() => ({
    opacity: interpolate(ty.value, [0, SWAP], [1, 0], Extrapolation.CLAMP),
  }));

  // ── Render ────────────────────────────────────────────────────────────────
  //
  // `renderCell` MUST NOT depend on the selection. Every prop it passes is
  // either a primitive or something stable for the life of the sheet, so its
  // identity survives every tap — which is what stops VirtualizedList from
  // re-running the whole rendered window each time a checkbox changes. Each
  // MediaGridCell subscribes to its own order instead.
  const cellTheme = useMemo(() => ({
    surface: colors.surface,
    accent,
    labelFont: fonts.medium,
  }), [colors.surface, accent, fonts.medium]);

  const renderCell = useCallback(({ item }) => {
    if (item.kind === 'camera') {
      return (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={handleCameraCell}
          style={[styles.cell, styles.cameraCell, { backgroundColor: cellTheme.surface }]}
          accessibilityRole="button"
          accessibilityLabel="Open camera"
        >
          <Ionicons name="camera-outline" size={26} color={colors.primaryTextColor} />
          <Text style={[styles.cameraLabel, { color: colors.primaryTextColor, fontFamily: cellTheme.labelFont }]}>
            Camera
          </Text>
        </TouchableOpacity>
      );
    }

    return (
      <MediaGridCell
        id={item.id}
        uri={item.uri}
        isVideo={item.mediaType === 'video'}
        duration={item.duration}
        size={TILE}
        gutter={GUTTER}
        store={selection}
        onPress={togglePick}
        accent={cellTheme.accent}
        surface={cellTheme.surface}
        labelFont={cellTheme.labelFont}
      />
    );
  }, [cellTheme, colors.primaryTextColor, handleCameraCell, selection, togglePick]);

  const keyExtractor = useCallback((item) => item.id, []);

  // Every row is the same height, so offsets are arithmetic rather than
  // measurement — no layout pass per row while flinging a long roll.
  //
  // `index` here is the ROW index, not the item index: with numColumns set,
  // FlatList's getItemCount returns ceil(items / numColumns) and hands
  // VirtualizedList one array per row, but passes getItemLayout straight
  // through. Dividing by COLS again would give four consecutive rows the same
  // offset and wreck every scroll position.
  const getItemLayout = useCallback((_data, index) => ({
    length: ROW_H,
    offset: ROW_H * index,
    index,
  }), []);

  if (!mounted) return null;

  const isLimitedAccess = media.isLimited;
  const showFolderFab = expanded && selectedCount === 0 && media.permissionGranted;
  const showSendFab = selectedCount > 0;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Tied to `visible`, not to `mounted`: the scrim is a full-screen touch
          target, so the instant the sheet is dismissed it must stop taking
          taps — both during the slide-out and, should the sheet ever fail to
          unmount, forever after. A scrim left live over the chat is the
          difference between a cosmetic bug and a screen nothing responds on. */}
      <Reanimated.View
        style={[StyleSheet.absoluteFill, styles.scrim, scrimStyle]}
        pointerEvents={visible ? 'auto' : 'none'}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={requestClose} accessibilityLabel="Close attachment sheet" />
      </Reanimated.View>

      <GestureDetector gesture={pan}>
        <Reanimated.View
          pointerEvents={visible ? 'auto' : 'none'}
          style={[
            styles.sheet,
            {
              height: FULL_H,
              backgroundColor: colors.cardBackground,
              borderTopColor: colors.divider,
            },
            sheetStyle,
          ]}
        >
          {/* Renders FIRST so the opaque attach panel below paints on top of it
              and fades out to reveal the grid — a true crossfade. */}
          <Reanimated.View
            style={[styles.pickerBlock, { top: HANDLE_H }, pickerBlockStyle]}
          >
            <Reanimated.View
              style={[styles.pickerHeader, { height: PICKER_H }, pickerHeaderStyle]}
              pointerEvents={expanded ? 'auto' : 'none'}
            >
              <TouchableOpacity
                onPress={requestClose}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <Ionicons name="close" size={24} color={colors.primaryTextColor} />
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.albumButton}
                onPress={toggleAlbumDropdown}
                accessibilityRole="button"
                accessibilityLabel="Choose album"
              >
                <Text
                  numberOfLines={1}
                  style={[styles.albumLabel, { color: colors.primaryTextColor, fontFamily: fonts.semibold }]}
                >
                  {media.album?.title || 'Recents'}
                </Text>
                <Ionicons
                  name={albumOpen ? 'chevron-up' : 'chevron-down'}
                  size={16}
                  color={colors.primaryTextColor}
                />
              </TouchableOpacity>

              <View style={[styles.hdBadge, { borderColor: colors.border }]}>
                <Text style={[styles.hdText, { color: colors.secondaryTextColor, fontFamily: fonts.bold }]}>HD</Text>
              </View>
            </Reanimated.View>

            {isLimitedAccess && media.permissionGranted ? (
              <TouchableOpacity
                style={[styles.limitedBar, { backgroundColor: colors.surface, borderColor: colors.divider }]}
                onPress={media.openSettings}
                accessibilityRole="button"
                accessibilityLabel="Allow access to all photos"
              >
                <Ionicons name="information-circle-outline" size={16} color={colors.secondaryTextColor} />
                <Text
                  numberOfLines={1}
                  style={[styles.limitedBarText, { color: colors.secondaryTextColor, fontFamily: fonts.regular }]}
                >
                  Only selected photos are visible
                </Text>
                <Text style={[styles.limitedBarAction, { color: accent, fontFamily: fonts.semibold }]}>
                  Allow all
                </Text>
              </TouchableOpacity>
            ) : null}

            {media.permissionGranted === false ? (
              <View style={styles.permissionWrap}>
                <Ionicons name="images-outline" size={34} color={colors.secondaryTextColor} />
                <Text style={[styles.permissionText, { color: colors.secondaryTextColor, fontFamily: fonts.regular }]}>
                  Allow photo access to pick from your gallery.
                </Text>
                <TouchableOpacity
                  onPress={media.requestAccess}
                  style={[styles.permissionBtn, { backgroundColor: accent }]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.permissionBtnText, { fontFamily: fonts.semibold }]}>Allow access</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <GestureDetector gesture={listGesture}>
                <AnimatedFlatList
                  ref={listRef}
                  data={gridData}
                  keyExtractor={keyExtractor}
                  renderItem={renderCell}
                  numColumns={COLS}
                  scrollEnabled={expanded}
                  onScroll={onScroll}
                  scrollEventThrottle={16}
                  // Both overscroll behaviours fight the collapse drag and read
                  // as rubber-band lag: Android's stretch, and iOS's bounce
                  // (which would also let the list travel above offset 0 while
                  // the sheet is trying to take the gesture over).
                  overScrollMode="never"
                  bounces={false}
                  showsVerticalScrollIndicator={false}
                  getItemLayout={getItemLayout}
                  removeClippedSubviews
                  // ~6 rows: enough to fill the sheet at both snap points
                  // without paying for anything below the fold on open.
                  initialNumToRender={24}
                  windowSize={5}
                  maxToRenderPerBatch={12}
                  updateCellsBatchingPeriod={50}
                  onEndReachedThreshold={0.6}
                  onEndReached={media.loadMore}
                  contentContainerStyle={{ paddingRight: GUTTER, paddingBottom: PICKER_SHIFT + 96 }}
                  // The camera cell means `data` is never empty, so
                  // ListEmptyComponent can never fire — both the spinner and
                  // the empty note belong in the footer.
                  ListFooterComponent={
                    media.loading ? (
                      <View style={styles.footerLoader}>
                        <ActivityIndicator size="small" color={colors.secondaryTextColor} />
                      </View>
                    ) : media.error ? (
                      <View style={styles.emptyWrap}>
                        <Text style={[styles.emptyText, { color: colors.secondaryTextColor, fontFamily: fonts.regular }]}>
                          {media.error}
                        </Text>
                        <TouchableOpacity
                          onPress={media.retry}
                          style={[styles.permissionBtn, { backgroundColor: accent }]}
                          accessibilityRole="button"
                        >
                          <Text style={[styles.permissionBtnText, { fontFamily: fonts.semibold }]}>Retry</Text>
                        </TouchableOpacity>
                      </View>
                    ) : media.manifestMissingPhotos && media.assets.length === 0 ? (
                      <View style={styles.emptyWrap}>
                        <Text style={[styles.emptyText, { color: colors.secondaryTextColor, fontFamily: fonts.regular }]}>
                          This installed build can&apos;t read your photos — the photo
                          permission is missing from it. Reinstall the app to enable it.
                        </Text>
                      </View>
                    ) : isLimitedAccess ? (
                      // Under limited access the grid can only ever show the
                      // hand-picked subset, so BOTH ways out are offered every
                      // time — amend the selection, or go to Settings for the
                      // whole library. "Allow all" is deliberately the primary
                      // button: it is what the user is actually asking for when
                      // they say the app should look like WhatsApp.
                      <View style={styles.emptyWrap}>
                        <Text style={[styles.emptyText, { color: colors.secondaryTextColor, fontFamily: fonts.regular }]}>
                          {media.assets.length === 0
                            ? "This app can only see photos you pick for it, and none are picked yet."
                            : "This app can only see the photos you picked for it."}
                        </Text>
                        <TouchableOpacity
                          onPress={media.openSettings}
                          style={[styles.permissionBtn, { backgroundColor: accent }]}
                          accessibilityRole="button"
                        >
                          <Text style={[styles.permissionBtnText, { fontFamily: fonts.semibold }]}>
                            Allow all photos
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={media.manageSelection} accessibilityRole="button">
                          <Text style={[styles.linkText, { color: accent, fontFamily: fonts.semibold }]}>
                            {media.assets.length === 0 ? 'Or pick photos' : 'Or pick more photos'}
                          </Text>
                        </TouchableOpacity>
                      </View>
                    ) : media.assets.length === 0 ? (
                      <View style={styles.emptyWrap}>
                        <Text style={[styles.emptyText, { color: colors.secondaryTextColor, fontFamily: fonts.regular }]}>
                          No photos or videos here.
                        </Text>
                      </View>
                    ) : null
                  }
                />
              </GestureDetector>
            )}
          </Reanimated.View>

          {/* Opaque — paints over the picker block and fades in place. */}
          <Reanimated.View
            style={[
              styles.attachWrap,
              { top: HANDLE_H, height: ATTACH_H, backgroundColor: colors.cardBackground },
              attachStyle,
            ]}
            pointerEvents={expanded ? 'none' : 'auto'}
          >
            {options.map((option) => (
              <Pressable
                key={option.id}
                style={styles.attachCell}
                onPress={() => handleOptionPress(option)}
                accessibilityRole="button"
                accessibilityLabel={option.label}
              >
                <View style={[styles.attachDisc, { backgroundColor: colors.surface }]}>
                  <Ionicons
                    name={option.icon}
                    size={26}
                    color={isDarkMode ? option.dark : option.light}
                  />
                </View>
                <Text
                  numberOfLines={1}
                  style={[styles.attachLabel, { color: colors.secondaryTextColor, fontFamily: fonts.medium }]}
                >
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </Reanimated.View>

          {/* Last, and transparent: the sheet itself carries the background, so
              the rounded top corners stay clean without a clip. */}
          <View style={[styles.handleRow, { height: HANDLE_H }]} pointerEvents="none">
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
          </View>
        </Reanimated.View>
      </GestureDetector>

      {/* Album dropdown — a sibling of the sheet so it is never clipped by the
          sliding picker block. */}
      {albumOpen && expanded && (
        <View style={[styles.albumSheet, { top: HEADER_H + HANDLE_H + PICKER_H, backgroundColor: colors.cardBackground, borderColor: colors.divider }]}>
          <ScrollView bounces={false} style={{ maxHeight: 260 }}>
            {[{ id: null, title: 'Recents' }, ...media.albums].map((a) => {
              const active = (media.album?.id || null) === (a.id || null);
              return (
                <TouchableOpacity
                  key={a.id || 'recents'}
                  style={styles.albumRow}
                  onPress={() => chooseAlbum(a.id ? a : null)}
                >
                  <Text
                    numberOfLines={1}
                    style={[styles.albumRowText, {
                      color: active ? accent : colors.primaryTextColor,
                      fontFamily: active ? fonts.semibold : fonts.regular,
                    }]}
                  >
                    {a.title}
                  </Text>
                  {typeof a.count === 'number' && (
                    <Text style={[styles.albumCount, { color: colors.secondaryTextColor, fontFamily: fonts.regular }]}>
                      {a.count}
                    </Text>
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* FABs are siblings of the sheet, anchored to the screen bottom, so they
          stay reachable in the half state too (where the sheet's own bottom
          edge is already below the viewport). No elevation — Android would
          recompute the shadow every frame; a hairline carries the edge. */}
      {showFolderFab && (
        <TouchableOpacity
          style={[styles.fab, { backgroundColor: colors.surface, borderColor: colors.divider }]}
          onPress={handleFolder}
          accessibilityRole="button"
          accessibilityLabel="Browse all files"
        >
          <Ionicons name="folder-outline" size={22} color={colors.primaryTextColor} />
        </TouchableOpacity>
      )}

      {/* View once — sits beside the send FAB so the choice is made at the same
          moment as the send, exactly like the composer's pending-media strip.
          Same "1" disc, filled when armed, so the two read as one control. */}
      {showSendFab && (
        <TouchableOpacity
          style={[styles.viewOnceFab, {
            backgroundColor: viewOnce ? accent : colors.surface,
            borderColor: viewOnce ? accent : colors.divider,
          }]}
          onPress={() => setViewOnce((on) => !on)}
          accessibilityRole="button"
          accessibilityState={{ selected: viewOnce }}
          accessibilityLabel={viewOnce ? 'View once on' : 'View once'}
        >
          <Text style={[styles.viewOnceText, {
            color: viewOnce ? '#fff' : colors.primaryTextColor,
            fontFamily: fonts.bold,
          }]}>
            1
          </Text>
        </TouchableOpacity>
      )}

      {showSendFab && (
        <TouchableOpacity
          style={[styles.fab, styles.sendFab, { backgroundColor: accent, borderColor: colors.divider }]}
          onPress={handleSend}
          disabled={sending}
          accessibilityRole="button"
          accessibilityLabel={`Send ${selectedCount} item${selectedCount === 1 ? '' : 's'}`}
        >
          {sending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Ionicons name="send" size={20} color="#fff" />
              <View style={[styles.sendCount, { backgroundColor: colors.cardBackground }]}>
                <Text style={[styles.sendCountText, { color: accent, fontFamily: fonts.bold }]}>
                  {selectedCount}
                </Text>
              </View>
            </>
          )}
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: '#000' },

  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },

  handleRow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  handle: { width: 38, height: 4, borderRadius: 2 },

  pickerBlock: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  pickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    gap: 14,
  },
  albumButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  albumLabel: { fontSize: 16 },
  hdBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: 1,
  },
  hdText: { fontSize: 11, letterSpacing: 0.4 },

  attachWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 8,
    paddingVertical: 8,
    rowGap: 16,
  },
  attachCell: {
    width: '25%',
    height: ATTACH_ROW_H,
    alignItems: 'center',
  },
  attachDisc: {
    width: 60,
    height: 60,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachLabel: { fontSize: 12, lineHeight: 15, marginTop: 7, textAlign: 'center' },

  cell: {
    width: TILE,
    height: TILE,
    marginLeft: GUTTER,
    marginBottom: GUTTER,
  },
  cameraCell: { alignItems: 'center', justifyContent: 'center', gap: 6 },
  cameraLabel: { fontSize: 12 },
  // Tile visuals live in components/MediaGridCell — only the camera tile,
  // which is not a media cell, is styled here.
  permissionWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 12 },
  permissionText: { fontSize: 13, textAlign: 'center' },
  permissionBtn: { paddingHorizontal: 18, paddingVertical: 9, borderRadius: 20 },
  permissionBtnText: { fontSize: 13, color: '#fff' },

  emptyWrap: { paddingTop: 40, alignItems: 'center', width: '100%', gap: 14, paddingHorizontal: 32 },
  linkText: { fontSize: 13 },
  limitedBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 10,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  limitedBarText: { flex: 1, fontSize: 12 },
  limitedBarAction: { fontSize: 12 },
  emptyText: { fontSize: 13 },
  footerLoader: { width: '100%', paddingVertical: 16, alignItems: 'center' },

  albumSheet: {
    position: 'absolute',
    left: 16,
    right: 16,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  albumRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 13,
    gap: 12,
  },
  albumRowText: { fontSize: 14, flex: 1 },
  albumCount: { fontSize: 12 },

  fab: {
    position: 'absolute',
    right: 16,
    bottom: 20,
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  sendFab: {},
  viewOnceFab: {
    position: 'absolute',
    right: 80,
    bottom: 31,
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
  },
  viewOnceText: { fontSize: 13 },
  sendCount: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendCountText: { fontSize: 11 },
});
