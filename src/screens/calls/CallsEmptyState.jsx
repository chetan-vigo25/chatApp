/**
 * CallsEmptyState — animated empty-state for the call logs screen.
 *
 * A call icon inside a soft disc, ringed by expanding "call ripple" circles
 * (like an outgoing signal) plus a gentle breathing pulse + float. Shown when
 * there are no call logs / no contacts to list. Theme-aware; pure RN Animated
 * (transform + opacity only, native driver) — no extra dependencies.
 */
import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, Easing, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export default function CallsEmptyState({
  theme,
  title = 'No calls yet',
  subtitle,
  icon = 'call',
}) {
  const accent = theme.colors.themeColor;

  const r1 = useRef(new Animated.Value(0)).current;
  const r2 = useRef(new Animated.Value(0)).current;
  const r3 = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const float = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const ripple = (v, delay) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(v, { toValue: 1, duration: 2200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        ]),
      );
    const breathe = (v, d) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(v, { toValue: 1, duration: d, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0, duration: d, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ]),
      );
    const anims = [
      ripple(r1, 0),
      ripple(r2, 730),
      ripple(r3, 1460),
      breathe(pulse, 1100),
      breathe(float, 1600),
    ];
    anims.forEach((a) => a.start());
    return () => anims.forEach((a) => a.stop());
  }, [r1, r2, r3, pulse, float]);

  const ringStyle = (v) => ({
    position: 'absolute',
    width: 116,
    height: 116,
    borderRadius: 58,
    borderWidth: 2,
    borderColor: accent,
    transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1.75] }) }],
    opacity: v.interpolate({ inputRange: [0, 0.12, 1], outputRange: [0, 0.32, 0] }),
  });

  const iconScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
  const iconFloat = float.interpolate({ inputRange: [0, 1], outputRange: [0, -6] });

  return (
    <View style={styles.wrap}>
      <View style={styles.art} pointerEvents="none">
        <Animated.View style={ringStyle(r1)} />
        <Animated.View style={ringStyle(r2)} />
        <Animated.View style={ringStyle(r3)} />
        <Animated.View
          style={[
            styles.iconCircle,
            { backgroundColor: `${accent}1F`, transform: [{ scale: iconScale }, { translateY: iconFloat }] },
          ]}
        >
          <Ionicons name={icon} size={42} color={accent} />
        </Animated.View>
      </View>

      <Text style={[styles.title, { color: theme.colors.primaryTextColor }]}>{title}</Text>
      {!!subtitle && (
        <Text style={[styles.sub, { color: theme.colors.placeHolderTextColor }]}>{subtitle}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    paddingBottom: 40,
  },
  art: {
    width: 150,
    height: 150,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 26,
  },
  iconCircle: {
    width: 92,
    height: 92,
    borderRadius: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 19,
    fontFamily: 'Roboto-SemiBold',
    marginBottom: 8,
    textAlign: 'center',
  },
  sub: {
    fontSize: 14,
    fontFamily: 'Roboto-Regular',
    textAlign: 'center',
    lineHeight: 20,
  },
});
