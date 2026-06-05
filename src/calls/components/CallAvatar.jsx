import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';

// Stable color from an id/name (mirrors the app's avatar fallback style).
const COLORS = ['#6C5CE7', '#0984E3', '#00B894', '#E17055', '#E84393', '#0EA5A4', '#F39C12'];
const colorFor = (key = '') => {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) % COLORS.length;
  return COLORS[Math.abs(h) % COLORS.length];
};

export default function CallAvatar({ uri, name = '', id = '', size = 132 }) {
  const radius = size / 2;
  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={[styles.img, { width: size, height: size, borderRadius: radius }]}
      />
    );
  }
  const letter = (name || '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <View style={[styles.fallback, { width: size, height: size, borderRadius: radius, backgroundColor: colorFor(id || name) }]}>
      <Text style={[styles.letter, { fontSize: size * 0.4 }]}>{letter}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  img: { backgroundColor: '#222' },
  fallback: { alignItems: 'center', justifyContent: 'center' },
  letter: { color: '#fff', fontFamily: 'Roboto-Bold' },
});
