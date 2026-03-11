import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

export default function MediaProgress({ progress = 0, status = 'idle', size = 'small' }) {
  const bounded = Math.max(0, Math.min(100, Number(progress || 0)));

  return (
    <View style={styles.container}>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${bounded}%` }]} />
      </View>
      <View style={styles.row}>
        {status === 'uploading' || status === 'downloading' ? (
          <ActivityIndicator size={size} color="#fff" />
        ) : null}
        <Text style={styles.text}>{status} {Math.round(bounded)}%</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 120,
    backgroundColor: 'rgba(0,0,0,0.45)',
    padding: 8,
    borderRadius: 10,
  },
  track: {
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 6,
  },
  fill: {
    height: 4,
    backgroundColor: '#ffffff',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  text: {
    color: '#fff',
    fontSize: 11,
    textTransform: 'capitalize',
  },
});