import { useRef, useEffect } from 'react';
import { Animated, PanResponder, Dimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Drag-and-snap behaviour for a small floating call window (the WhatsApp-style
 * minimized PiP / audio pill). Returns an Animated value to drive a translate
 * transform plus PanResponder handlers to spread on the floating view.
 *
 * - The window can be dragged anywhere on screen.
 * - On release it springs to the nearest left/right edge (kept within the safe
 *   vertical bounds), exactly like WhatsApp's floating call window — or, with
 *   `snapToEdge: false`, stays where it was dropped (clamped on screen).
 * - A short press is NOT captured (only a real drag > 5px claims the responder),
 *   so a child Pressable/TouchableOpacity (tap-to-expand, End) still fires.
 *
 * Cross-platform: pure Animated + PanResponder, works on Android and iOS.
 */
const SNAP_MARGIN = 12;

export default function useDraggablePip({
  width, height, enabled = true, initial = 'bottom-right', snapToEdge = true,
  // Screen space the window must not be dropped into, below the top inset /
  // above the bottom inset — e.g. the full-screen call's top bar and control
  // row, so the self-view never parks behind the buttons.
  topReserve = 0, bottomReserve = 0,
}) {
  const insets = useSafeAreaInsets();
  const { width: SW, height: SH } = Dimensions.get('window');

  const startX = initial === 'top-left' ? SNAP_MARGIN : SW - width - SNAP_MARGIN;
  const startY = (initial === 'top-right' || initial === 'top-left')
    ? insets.top + 70
    : SH - height - insets.bottom - 100;

  const pan = useRef(new Animated.ValueXY({ x: startX, y: startY })).current;
  // Where the window was when the current drag began. Read straight off the
  // value at grant time — NOT kept fresh by pan.addListener: Animated removes
  // every listener when the view driven by `pan` unmounts (AnimatedNode
  // __detach → removeAllListeners), which tap-to-swap does by switching the
  // tile, so after one swap the listener was gone and every drop sprang back.
  const startRef = useRef({ x: startX, y: startY });
  const enabledRef = useRef(enabled);

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) => (
        enabledRef.current && (Math.abs(g.dx) > 5 || Math.abs(g.dy) > 5)
      ),
      // Also claim a real drag in the CAPTURE phase: a child that already owns
      // the touch (the tile's tap-to-swap Pressable) must not keep the window
      // from moving. Taps still reach the child — this only fires past 5px.
      onMoveShouldSetPanResponderCapture: (_, g) => (
        enabledRef.current && (Math.abs(g.dx) > 5 || Math.abs(g.dy) > 5)
      ),
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        // stopAnimation hands back the live position (mid-spring included).
        pan.stopAnimation((v) => { startRef.current = v; });
        pan.setOffset({ x: startRef.current.x, y: startRef.current.y });
        pan.setValue({ x: 0, y: 0 });
      },
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
      onPanResponderRelease: (_, g) => {
        pan.flattenOffset();
        const x = startRef.current.x + g.dx;
        const y = startRef.current.y + g.dy;
        const maxX = SW - width - SNAP_MARGIN;
        const minY = insets.top + Math.max(SNAP_MARGIN, topReserve);
        const maxY = SH - height - insets.bottom - Math.max(SNAP_MARGIN, bottomReserve);
        const snapX = snapToEdge
          ? ((x + width / 2) < SW / 2 ? SNAP_MARGIN : maxX)
          : Math.min(Math.max(x, SNAP_MARGIN), maxX);
        const clampedY = Math.min(Math.max(y, minY), maxY);
        Animated.spring(pan, {
          toValue: { x: snapX, y: clampedY },
          useNativeDriver: false,
          friction: 7,
          tension: 60,
        }).start();
      },
    }),
  ).current;

  return { pan, panHandlers: panResponder.panHandlers };
}
