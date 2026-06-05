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
 *   vertical bounds), exactly like WhatsApp's floating call window.
 * - A short press is NOT captured (only a real drag > 5px claims the responder),
 *   so a child Pressable/TouchableOpacity (tap-to-expand, End) still fires.
 *
 * Cross-platform: pure Animated + PanResponder, works on Android and iOS.
 */
const SNAP_MARGIN = 12;

export default function useDraggablePip({ width, height, enabled = true, initial = 'bottom-right' }) {
  const insets = useSafeAreaInsets();
  const { width: SW, height: SH } = Dimensions.get('window');

  const startX = SW - width - SNAP_MARGIN;
  const startY = initial === 'top-right'
    ? insets.top + 70
    : SH - height - insets.bottom - 100;

  const pan = useRef(new Animated.ValueXY({ x: startX, y: startY })).current;
  const posRef = useRef({ x: startX, y: startY });
  const enabledRef = useRef(enabled);

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  // Track the live value so the responder can read the current position without
  // reaching into Animated internals.
  useEffect(() => {
    const id = pan.addListener((v) => { posRef.current = v; });
    return () => pan.removeListener(id);
  }, [pan]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) => (
        enabledRef.current && (Math.abs(g.dx) > 5 || Math.abs(g.dy) > 5)
      ),
      onPanResponderGrant: () => {
        pan.setOffset({ x: posRef.current.x, y: posRef.current.y });
        pan.setValue({ x: 0, y: 0 });
      },
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
      onPanResponderRelease: () => {
        pan.flattenOffset();
        const { x, y } = posRef.current;
        const maxX = SW - width - SNAP_MARGIN;
        const minY = insets.top + SNAP_MARGIN;
        const maxY = SH - height - insets.bottom - SNAP_MARGIN;
        const snapX = (x + width / 2) < SW / 2 ? SNAP_MARGIN : maxX;
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
