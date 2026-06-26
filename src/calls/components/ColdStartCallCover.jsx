import React, { useEffect, useRef } from 'react';
import { View, Text, Image, StyleSheet, Animated, Easing } from 'react-native';

// Instant full-screen "Incoming call" cover painted from the FIRST frame on a
// killed/locked cold start, BEFORE the Splash/ChatList boot flow can show. It is a
// lightweight placeholder that exactly fills the screen so the user sees the call —
// not the last app screen — immediately; the real interactive CallOverlay (with
// Accept / Decline) replaces it the moment the live call state mounts (~1s later),
// and the native CallStyle notification's Answer/Decline work in the meantime.
//
// Driven by the native non-consuming peek of the launch intent
// (callNotifee.peekInitialCallLaunch). Non-interactive on purpose — it never
// intercepts the real call controls.
const BRAND_BG = '#0B141A';

export default function ColdStartCallCover({ call }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.in(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
  const isVideo = (call?.callType || call?.media) === 'video';
  const name = call?.callerName || 'Incoming call';
  const avatar = call?.callerImage || null;

  return (
    <View pointerEvents="none" style={styles.root}>
      <Animated.View style={[styles.avatarWrap, { transform: [{ scale }] }]}>
        {avatar ? (
          <Image source={{ uri: avatar }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]}>
            <Text style={styles.avatarLetter}>{(name[0] || '?').toUpperCase()}</Text>
          </View>
        )}
      </Animated.View>
      <Text style={styles.name} numberOfLines={1}>{name}</Text>
      <Text style={styles.sub}>{isVideo ? 'Incoming video call' : 'Incoming voice call'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: BRAND_BG,
    alignItems: 'center',
    justifyContent: 'center',
    // Above the whole app; just under the real CallOverlay surfaces.
    zIndex: 99998,
    elevation: 99998,
  },
  avatarWrap: { marginBottom: 28 },
  avatar: { width: 132, height: 132, borderRadius: 66, backgroundColor: '#1f2c34' },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: '#fff', fontSize: 52, fontWeight: '600' },
  name: { color: '#fff', fontSize: 26, fontWeight: '600', maxWidth: '80%', textAlign: 'center' },
  sub: { color: '#8aa0ab', fontSize: 15, marginTop: 8 },
});
