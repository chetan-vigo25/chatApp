import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Animated,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../../../contexts/ThemeContext';

export default function LinkingLoader({ visible, success }) {
  const { theme } = useTheme();
  const scaleAnim = useRef(new Animated.Value(0)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const checkScaleAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: 1,
          friction: 8,
          tension: 60,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.timing(opacityAnim, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }).start();
      scaleAnim.setValue(0);
      checkScaleAnim.setValue(0);
    }
  }, [visible]);

  useEffect(() => {
    if (success) {
      Animated.spring(checkScaleAnim, {
        toValue: 1,
        friction: 4,
        tension: 80,
        useNativeDriver: true,
      }).start();
    }
  }, [success]);

  if (!visible) return null;

  return (
    <Animated.View style={[styles.overlay, { opacity: opacityAnim }]}>
      <Animated.View
        style={[
          styles.card,
          { backgroundColor: theme.colors.cardBackground, transform: [{ scale: scaleAnim }] },
        ]}
      >
        {success ? (
          <Animated.View style={{ transform: [{ scale: checkScaleAnim }] }}>
            <View style={styles.successCircle}>
              <MaterialIcons name="check" size={40} color="#fff" />
            </View>
          </Animated.View>
        ) : (
          <ActivityIndicator size="large" color={theme.colors.themeColor} />
        )}
        <Text style={[styles.text, { color: theme.colors.primaryTextColor }]}>
          {success ? 'Device Linked!' : 'Linking device...'}
        </Text>
        {!success && (
          <Text style={[styles.subtext, { color: theme.colors.placeHolderTextColor }]}>
            Verifying and establishing connection
          </Text>
        )}
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  card: {
    borderRadius: 16,
    paddingHorizontal: 40,
    paddingVertical: 32,
    alignItems: 'center',
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  successCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#25D366',
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 16,
    marginTop: 16,
    textAlign: 'center',
  },
  subtext: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    marginTop: 6,
    textAlign: 'center',
  },
});