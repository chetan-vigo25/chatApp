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
 *   isGroup       bool      — group → people fallback icon
 *   onMessage     fn?       — show Message button when provided
 *   onCall        fn?       — show Call button when provided (1-1 + group)
 *   onVideo       fn?       — show Video button when provided (1-1 + group)
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
import { useSelector } from 'react-redux';
import { useTheme } from '../contexts/ThemeContext';
import { useCall } from '../calls/useCall';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export default function ProfilePreviewModal({
  visible,
  onClose,
  name = 'Unknown',
  image = null,
  avatarColor = '#6C5CE7',
  isGroup = false,
  isBroadcast = false,
  isVerified = false,
  subtitle = null,
  peerId = null,
  onMessage,
  onCall,
  onVideo,
  onInfo,
  onViewPhoto,
}) {
  const { theme, isDarkMode } = useTheme();
  // Disable the call/video actions while another call is in progress.
  const { callBusy } = useCall();
  // Contact-block: when a peerId is supplied, disable calls in BOTH directions of
  // a block (I blocked them, or they me). The CallProvider gate enforces it too.
  const callBlocked = useSelector((s) => {
    const id = peerId ? String(peerId) : '';
    if (!id) return false;
    return (s?.block?.blockedIds || []).map(String).includes(id)
      || (s?.block?.blockedByIds || []).map(String).includes(id);
  });
  const callDisabled = callBusy || callBlocked;
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
  const actionGreen = isDarkMode ? '#03b0a2' : '#028578';
  const initial = (name || '?').charAt(0).toUpperCase();

  const showMessage = typeof onMessage === 'function';
  // Groups get call/video too (group call rings all members); only broadcast
  // channels never show them. Callers control availability via the callbacks.
  const showCall = typeof onCall === 'function' && !isBroadcast;
  const showVideo = typeof onVideo === 'function' && !isBroadcast;
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
                  {isBroadcast ? (
                    <Ionicons name="megaphone" size={88} color="rgba(255,255,255,0.95)" />
                  ) : isGroup ? (
                    <Ionicons name="people" size={92} color="rgba(255,255,255,0.95)" />
                  ) : (
                    <Text style={styles.fallbackText}>{initial}</Text>
                  )}
                </View>
              )}

              {/* No scrim gradient — a banded scrim showed hairline strips on
                  Android (1px-view sub-pixel seams). The name stays readable via a
                  strong text drop-shadow alone, so the photo shows clean. */}

              {/* Name on the photo, with a soft drop shadow */}
              <View style={styles.nameOverlay} pointerEvents="none">
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={[styles.nameText, { flexShrink: 1 }]} numberOfLines={1}>{name}</Text>
                  {isVerified && (
                    <Ionicons name="checkmark-circle" size={18} color={theme.colors.themeColor} style={{ marginLeft: 6 }} />
                  )}
                </View>
                {subtitle ? (
                  <Text style={styles.subtitleText} numberOfLines={1}>{subtitle}</Text>
                ) : null}
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
                  <TouchableOpacity onPress={onCall} disabled={callDisabled} activeOpacity={0.6} style={[styles.actionBtn, callDisabled && styles.actionBtnDisabled]} hitSlop={hit}>
                    <Ionicons name="call" size={19} color={actionGreen} />
                  </TouchableOpacity>
                )}
                {showVideo && (
                  <TouchableOpacity onPress={onVideo} disabled={callDisabled} activeOpacity={0.6} style={[styles.actionBtn, callDisabled && styles.actionBtnDisabled]} hitSlop={hit}>
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
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 9,
  },
  subtitleText: {
    color: 'rgba(255,255,255,0.92)',
    fontFamily: 'Roboto-Regular',
    fontSize: 12.5,
    marginTop: 2,
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 9,
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
  actionBtnDisabled: { opacity: 0.4 },
});
