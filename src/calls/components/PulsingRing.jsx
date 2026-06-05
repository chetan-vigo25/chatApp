import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

/**
 * Expanding concentric rings behind the caller avatar while a call is ringing
 * (outgoing or incoming). Pure RN Animated (no reanimated dependency) so it is
 * safe to mount inside the call overlay. `size` is the avatar diameter; the
 * rings bloom out to ~1.7x that.
 */
export default function PulsingRing({ size = 140, active = true, color = 'rgba(255,255,255,0.18)' }) {
  const a1 = useRef(new Animated.Value(0)).current;
  const a2 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) return undefined;
    const make = (val, delay) => Animated.loop(
      Animated.timing(val, {
        toValue: 1,
        duration: 2000,
        delay,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    );
    const l1 = make(a1, 0);
    const l2 = make(a2, 1000);
    l1.start();
    l2.start();
    return () => { l1.stop(); l2.stop(); a1.setValue(0); a2.setValue(0); };
  }, [active, a1, a2]);

  if (!active) return null;
  const ring = (val) => ({
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: color,
    transform: [{
      scale: val.interpolate({ inputRange: [0, 1], outputRange: [1, 1.7] }),
    }],
    opacity: val.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
  });

  return (
    <View pointerEvents="none" style={[styles.wrap, { width: size, height: size }]}>
      <Animated.View style={[styles.ring, ring(a1)]} />
      <Animated.View style={[styles.ring, ring(a2)]} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute' },
});
