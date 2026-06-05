/**
 * ProfilePreviewModal
 *
 * WhatsApp-style avatar popup shown when a user taps a contact/chat avatar.
 * Layout: square photo with the name overlaid on top (soft shadow + faux
 * gradient scrim), and a compact action row below (Message · Call · Video ·
 * Info). Presentational + self-animating — callers pass data + action
 * callbacks, so the exact same card renders from the Chat List and the
 * Contacts list.
 *
 * Works on both Android and iOS:
 *   • `statusBarTranslucent` is Android-only and ignored on iOS.
 *   • `textShadow*` and the stacked-layer scrim are pure RN (no native deps).
 *
 * Props:
 *   visible       bool      — controlled visibility (parent owns the flag)
 *   onClose       fn        — called after the dismiss animation finishes
 *   name          string    — contact / group display name
 *   image         uri|null  — avatar URL (falls back to a colored initial)
 *   avatarColor   string    — fallback circle background
 *   isGroup       bool      — group → people icon + no call buttons
 *   onMessage     fn?       — show Message button when provided
 *   onCall        fn?       — show Call button when provided (1-1 only)
 *   onVideo       fn?       — show Video button when provided (1-1 only)
 *   onInfo        fn?       — show Info button when provided
 *   onViewPhoto   fn?       — tapping the photo (e.g. open full-screen viewer)
 */
import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Image,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../contexts/ThemeContext';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export default function ProfilePreviewModal({
  visible,
  onClose,
  name = 'Unknown',
  image = null,
  avatarColor = '#6C5CE7',
  isGroup = false,
  onMessage,
  onCall,
  onVideo,
  onInfo,
  onViewPhoto,
}) {
  const { theme, isDarkMode } = useTheme();
  const scale = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  // Keep the modal mounted through the exit animation.
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      scale.setValue(0);
      opacity.setValue(0);
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, tension: 65, friction: 8, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      ]).start();
    } else if (mounted) {
      Animated.parallel([
        Animated.timing(scale, { toValue: 0, duration: 160, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0, duration: 160, useNativeDriver: true }),
      ]).start(() => setMounted(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!mounted) return null;

  // WhatsApp's popup action icons are bright green (dark) / teal-green (light).
  const actionGreen = isDarkMode ? '#25D366' : '#008069';
  const initial = (name || '?').charAt(0).toUpperCase();

  const showMessage = typeof onMessage === 'function';
  const showCall = typeof onCall === 'function' && !isGroup;
  const showVideo = typeof onVideo === 'function' && !isGroup;
  const showInfo = typeof onInfo === 'function';
  const hasActions = showMessage || showCall || showVideo || showInfo;

  const hit = { top: 8, bottom: 8, left: 8, right: 8 };

  return (
    <Modal transparent visible={mounted} onRequestClose={onClose} statusBarTranslucent>
      <TouchableOpacity onPress={onClose} activeOpacity={1} style={styles.overlay}>
        <Animated.View
          style={[
            styles.card,
            { backgroundColor: theme.colors.cardBackground, opacity, transform: [{ scale }] },
          ]}
        >
          {/* Absorb taps on the card so only an outside tap dismisses. */}
          <TouchableOpacity activeOpacity={1} onPress={() => {}}>
            {/* Square photo with name overlaid on top */}
            <View style={[styles.imageWrap, { backgroundColor: image ? '#000' : avatarColor }]}>
              {image ? (
                <TouchableOpacity
                  activeOpacity={onViewPhoto ? 0.95 : 1}
                  style={styles.imageInner}
                  onPress={onViewPhoto || undefined}
                  disabled={!onViewPhoto}
                >
                  <Image resizeMode="cover" source={{ uri: image }} style={styles.imageInner} fadeDuration={0} />
                </TouchableOpacity>
              ) : (
                <View style={styles.fallback}>
                  {isGroup ? (
                    <Ionicons name="people" size={92} color="rgba(255,255,255,0.95)" />
                  ) : (
                    <Text style={styles.fallbackText}>{initial}</Text>
                  )}
                </View>
              )}

              {/* Faux top gradient (no LinearGradient dep) */}
              <View style={styles.scrim} pointerEvents="none">
                <View style={[styles.scrimLayer, { height: 92 }]} />
                <View style={[styles.scrimLayer, { height: 66 }]} />
                <View style={[styles.scrimLayer, { height: 44 }]} />
                <View style={[styles.scrimLayer, { height: 26 }]} />
              </View>

              {/* Name on the photo, with a soft drop shadow */}
              <View style={styles.nameOverlay} pointerEvents="none">
                <Text style={styles.nameText} numberOfLines={1}>{name}</Text>
              </View>
            </View>

            {/* Action row */}
            {hasActions && (
              <View style={[styles.actionRow, { borderTopColor: theme.colors.borderColor }]}>
                {showMessage && (
                  <TouchableOpacity onPress={onMessage} activeOpacity={0.6} style={styles.actionBtn} hitSlop={hit}>
                    <MaterialCommunityIcons name="message-text" size={20} color={actionGreen} />
                  </TouchableOpacity>
                )}
                {showCall && (
                  <TouchableOpacity onPress={onCall} activeOpacity={0.6} style={styles.actionBtn} hitSlop={hit}>
                    <Ionicons name="call" size={19} color={actionGreen} />
                  </TouchableOpacity>
                )}
                {showVideo && (
                  <TouchableOpacity onPress={onVideo} activeOpacity={0.6} style={styles.actionBtn} hitSlop={hit}>
                    <Ionicons name="videocam" size={21} color={actionGreen} />
                  </TouchableOpacity>
                )}
                {showInfo && (
                  <TouchableOpacity onPress={onInfo} activeOpacity={0.6} style={styles.actionBtn} hitSlop={hit}>
                    <Ionicons name="information-circle-outline" size={21} color={actionGreen} />
                  </TouchableOpacity>
                )}
              </View>
            )}
          </TouchableOpacity>
        </Animated.View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 28,
  },
  card: {
    width: SCREEN_WIDTH * 0.60,
    maxWidth: 270,
    borderRadius: 12,
    overflow: 'hidden',
    elevation: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.45,
    shadowRadius: 24,
  },
  imageWrap: {
    width: '100%',
    aspectRatio: 1,
    position: 'relative',
  },
  imageInner: { width: '100%', height: '100%' },
  fallback: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fallbackText: {
    color: '#fff',
    fontFamily: 'Roboto-Bold',
    fontSize: 92,
    letterSpacing: -2,
  },
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  scrimLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.16)',
  },
  nameOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    minHeight: 46,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingTop: 4,
  },
  nameText: {
    color: '#fff',
    fontFamily: 'Roboto-Medium',
    fontSize: 16,
    letterSpacing: 0.1,
    textShadowColor: 'rgba(0,0,0,0.75)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    minHeight: 44,
    paddingHorizontal: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  actionBtn: {
    flex: 1,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
