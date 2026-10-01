import React, { useEffect, useState } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { alwaysDark } from '../../contexts/ThemeContext';
import { usePeerProfileName } from '../../services/peerProfileNameStore';
import { avatarNameSource, getAvatarInitial, shouldShowAvatarInitial, UNSAVED_AVATAR_BG } from '../../utils/avatarIdentity';

// Stable color from an id/name (mirrors the app's avatar fallback style).
const COLORS = ['#6C5CE7', '#0984E3', '#00B894', '#E17055', '#E84393', '#0EA5A4', '#F39C12'];
const colorFor = (key = '') => {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) % COLORS.length;
  return COLORS[Math.abs(h) % COLORS.length];
};

export default function CallAvatar({ uri, name = '', id = '', size = 132, profileName = '' }) {
  const radius = size / 2;
  // A removed / expired photo URL used to leave an empty circle.
  const [failedUri, setFailedUri] = useState(null);
  useEffect(() => { setFailedUri(null); }, [uri]);
  // `id` is the peer's user id — its real profile name for the letter, when the
  // caller didn't pass one (see services/peerProfileNameStore).
  const storedProfileName = usePeerProfileName(id, !profileName && (!uri || uri === failedUri));
  if (uri && uri !== failedUri) {
    return (
      <Image
        source={{ uri }}
        onError={() => setFailedUri(uri)}
        style={[styles.img, { width: size, height: size, borderRadius: radius }]}
      />
    );
  }
  // Same rule as the chat list (utils/avatarIdentity): the peer's profile name
  // gives the letter; without one, the label's letter, and a bare number → icon.
  const initialSource = avatarNameSource({ profileName: profileName || storedProfileName, displayName: name });
  if (!shouldShowAvatarInitial(initialSource)) {
    return (
      <View style={[styles.fallback, { width: size, height: size, borderRadius: radius, backgroundColor: UNSAVED_AVATAR_BG }]}>
        <Ionicons name="person" size={size * 0.5} color="#fff" />
      </View>
    );
  }
  const letter = getAvatarInitial(initialSource);
  return (
    <View style={[styles.fallback, { width: size, height: size, borderRadius: radius, backgroundColor: colorFor(id || name) }]}>
      <Text style={[styles.letter, { fontSize: size * 0.4 }]}>{letter}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  img: { backgroundColor: '#222' },
  fallback: { alignItems: 'center', justifyContent: 'center' },
  letter: { color: alwaysDark.text, fontFamily: 'Roboto-Bold' },
});
