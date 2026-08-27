import React, { useEffect, useMemo, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, PanResponder, Platform,
  AppState,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import CallTimer from './CallTimer';
import CallAvatar from './CallAvatar';

/**
 * The minimized VOICE-call top banner — WhatsApp style (see reference: a full
 * width bar pinned to the top, sitting over the status bar, that pushes the app
 * content down). Layout matches WhatsApp exactly:
 *
 *   [ mute ]            📞 Name · 0:43            [ end ]
 *    left circle         green centre (tap → expand)   red circle
 *
 * Tapping the centre restores the full call screen; the two round buttons mute
 * and end the call. Theme-aware: the bar blends with the app (dark surface in
 * dark mode, light surface in light mode) since it lives over the app content,
 * while the green call accent and red End stay constant like WhatsApp.
 * Cross-platform (Android + iOS) — pure RN views + insets.
 */
export const MINI_BAR_HEIGHT = 54;
// The RINGING variant is taller than the in-call bar: it carries the caller's
// avatar and the Answer / Decline buttons, so the call can be taken without
// opening anything first — the same affordances the OS notification gives when
// the app is closed. Opening the app used to swap that notification for a bare
// 54px name strip with no way to answer from it, which read as "the call banner
// did not come back".
export const RING_BAR_HEIGHT = 76;

// WhatsApp's in-call green — matches the connected-call green used in the Calls
// list. Kept constant across light/dark (it's the call accent, like WhatsApp).
const GREEN = '#1DAB61';
// End button stays a solid WhatsApp red in both modes.
const END_RED = '#EA0038';
const HITSLOP = { top: 8, bottom: 8, left: 8, right: 8 };

export default function CallMiniBanner({
  peer,
  displayName,
  isGroup,
  groupName,
  media,
  statusText,
  showTimer,
  answeredAt,
  micOn,
  onToggleMic,
  onExpand,
  onHangup,
  // RINGING variant: the call is not answered yet, so there is nothing to mute
  // and an End here would be a decline one mis-tap away on a 54px strip. Render
  // the bar as a single full-width tappable label — exactly the WhatsApp
  // reference ("📞 <name> - Incoming call") — whose only action is to open the
  // full-screen call UI, where Accept/Decline live.
  ringing = false,
  // RINGING variant only — answer / decline in place.
  onAnswer,
  onDecline,
  // Swipe the RINGING banner up to push it out of the way. This does NOT touch
  // the call: it keeps ringing and stays answerable from the OS notification /
  // CallKit, and the banner comes back the next time the app is foregrounded.
  // Only offered while ringing — an ANSWERED call's bar must stay put, or the
  // user would lose the only handle on a call that is actually running.
  onDismiss,
}) {
  const insets = useSafeAreaInsets();
  const swipeY = useRef(new Animated.Value(0)).current;
  const canSwipe = ringing && typeof onDismiss === 'function';
  // NOTE — `useNativeDriver: false` here is deliberate and load-bearing, not an
  // oversight. The drag feeds this value with `setValue()` from JS, and the
  // moment an Animated.Value is driven NATIVELY once, RN owns that node on the
  // native side and later JS `setValue()` calls no longer reach it. Mixing the
  // two left the value stuck at the dismiss target (-240) after the first swipe:
  // every later render drew the bar 240px above the screen, so the app reported
  // it was rendering the banner while nothing was visible — "banner ek baar aaya
  // phir kabhi nahi". A 54px bar animates perfectly smoothly on the JS driver.
  const pan = useMemo(() => PanResponder.create({
    // Claim the gesture only once it is clearly a VERTICAL drag — otherwise the
    // responder would swallow the tap that opens the full-screen call UI.
    onMoveShouldSetPanResponder: (_e, g) => canSwipe
      && Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderMove: (_e, g) => {
      // Upward only; a downward pull just rubber-bands a little.
      swipeY.setValue(g.dy < 0 ? g.dy : g.dy * 0.25);
    },
    onPanResponderRelease: (_e, g) => {
      if (g.dy < -28 || g.vy < -0.6) {
        // Record the dismissal FIRST, then animate. The old order waited for the
        // timing callback and only dismissed from inside it — and a JS-driven
        // animation stops being stepped the moment the app leaves the
        // foreground. A swipe followed straight away by Home froze the animation
        // mid-flight: the callback never ran, so `onDismiss()` never fired (the
        // call state still said "show the banner", and no dismissal was ever
        // logged) while the bar itself was left parked off-screen with nothing
        // to put it back. That is the exact "banner hata diya, app kholi, banner
        // nahi aaya" report — the bar was mounted and 'rendering' the whole
        // time, just translated out of view.
        //
        // Dismissing first makes the slide purely cosmetic: the component
        // unmounts on the state change either way, and the next time the ring is
        // presented it mounts fresh at rest.
        onDismiss();
        Animated.timing(swipeY, { toValue: -240, duration: 160, useNativeDriver: false }).start();
        return;
      }
      Animated.spring(swipeY, { toValue: 0, useNativeDriver: false, bounciness: 6 }).start();
    },
    onPanResponderTerminate: () => {
      Animated.spring(swipeY, { toValue: 0, useNativeDriver: false, bounciness: 6 }).start();
    },
  }), [canSwipe, onDismiss, swipeY]);

  // Belt for the same class of failure: whatever happened to the offset during a
  // previous gesture, a freshly shown bar always starts at rest. Without this a
  // value left mid-flight (gesture interrupted by the call ending, the component
  // being reused, an animation whose callback never ran) would silently render
  // the bar off-screen for the rest of its life.
  useEffect(() => {
    swipeY.stopAnimation(() => swipeY.setValue(0));
  }, [swipeY]);

  // …and the same belt on every RESUME, because a mount-time reset only helps a
  // bar that actually remounts. This one never does: it stays mounted for the
  // whole ring, so a transform left behind by an interrupted gesture or a
  // half-finished spring (JS animations are not stepped while the app is
  // backgrounded) would otherwise hold it off-screen for the rest of the call —
  // with every log still reporting the banner as rendered. Snapping to rest on
  // resume makes "app opened → the bar is where it belongs" unconditional.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      swipeY.stopAnimation((value) => {
        if (__DEV__ && value !== 0) {
          console.log('[CALL][UI] banner was parked off-screen on resume — snapping it back', { platform: Platform.OS, translateY: value });
        }
        swipeY.setValue(0);
      });
    });
    return () => { try { sub.remove(); } catch (_) { /* */ } };
  }, [swipeY]);

  // MOUNT / UNMOUNT — the one signal `onLayout` cannot give. onLayout only fires
  // when the layout CHANGES, so a bar that mounted once and then merely
  // re-rendered stays silent, and its absence from a log window proves nothing.
  // This fires exactly once per mount and once per unmount, so "the app said it
  // would render the banner" can finally be checked against "the banner actually
  // existed" — and a bar that vanishes says exactly when it went.
  useEffect(() => {
    if (!__DEV__) return undefined;
    console.log('[CALL][UI] banner MOUNTED', { platform: Platform.OS, ringing });
    return () => console.log('[CALL][UI] banner UNMOUNTED', { platform: Platform.OS, ringing });
  }, [ringing]);
  const { theme, isDarkMode } = useTheme();
  const c = theme.colors;
  const title = isGroup ? (groupName || 'Group call') : (displayName || peer?.name || 'Unknown');

  // Round side-button surface: translucent white on a dark bar, translucent
  // dark on a light bar — so the mute button reads on either background.
  const sideBg = isDarkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)';
  const sideActiveBg = isDarkMode ? 'rgba(255,255,255,0.26)' : 'rgba(0,0,0,0.14)';
  const sideIcon = micOn ? (isDarkMode ? '#fff' : c.iconColor) : (isDarkMode ? '#fff' : c.primaryTextColor);

  return (
    <Animated.View
      {...(canSwipe ? pan.panHandlers : {})}
      // Where the bar ACTUALLY landed on screen. The render decision is already
      // logged upstream; this closes the last gap between "we returned the bar"
      // and "the user can see it": y far above 0 means a stuck transform, a 0
      // height means a layout problem, and no log at all means the element never
      // mounted. Without it, "banner nahi aaya" cannot be told apart from
      // "banner is there but something is covering it".
      onLayout={__DEV__ ? (e) => {
        const { x, y, width, height } = e.nativeEvent.layout;
        console.log('[CALL][UI] banner laid out', {
          platform: Platform.OS, x, y, width, height, ringing, canSwipe, insetTop: insets.top,
        });
      } : undefined}
      style={[
        styles.banner,
        canSwipe ? { transform: [{ translateY: swipeY }] } : null,
        {
          paddingTop: insets.top,
          height: insets.top + (ringing ? RING_BAR_HEIGHT : MINI_BAR_HEIGHT),
          // Match the app's themed background so the bar blends seamlessly with
          // the screen behind it (WhatsApp-style): white in light mode, the deep
          // #0B141A in dark mode — not the lighter surface grey.
          backgroundColor: c.background,
          borderBottomColor: c.borderColor,
        },
      ]}
    >
      {ringing ? (
        <View style={styles.ringRow}>
          <TouchableOpacity style={styles.ringInfo} activeOpacity={0.7} onPress={onExpand}>
            <CallAvatar uri={peer?.avatar || null} name={title} id={peer?.id || ''} size={44} />
            <View style={styles.ringText}>
              <Text style={[styles.ringName, { color: c.primaryTextColor }]} numberOfLines={1}>{title}</Text>
              <Text style={[styles.ringStatus, { color: GREEN }]} numberOfLines={1}>{statusText}</Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onDecline}
            activeOpacity={0.85}
            hitSlop={HITSLOP}
            style={[styles.sideBtn, styles.endBtn]}
          >
            <MaterialIcons name="call-end" size={20} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onAnswer}
            activeOpacity={0.85}
            hitSlop={HITSLOP}
            style={[styles.sideBtn, styles.answerBtn]}
          >
            <MaterialIcons name={media === 'video' ? 'videocam' : 'call'} size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      ) : (
      <View style={styles.row}>
        {ringing ? null : (
          <TouchableOpacity
            onPress={onToggleMic}
            activeOpacity={0.8}
            hitSlop={HITSLOP}
            style={[styles.sideBtn, { backgroundColor: micOn ? sideBg : sideActiveBg }]}
          >
            <Ionicons name={micOn ? 'mic' : 'mic-off'} size={20} color={sideIcon} />
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.center} activeOpacity={0.7} onPress={onExpand}>
          <Ionicons
            name={media === 'video' ? 'videocam' : 'call'}
            size={15}
            color={GREEN}
            style={styles.centerIcon}
          />
          <Text style={[styles.title, { color: GREEN }]} numberOfLines={1}>{title}</Text>
          <Text style={[styles.dash, { color: GREEN }]}> - </Text>
          {showTimer ? (
            <CallTimer startMs={answeredAt} style={styles.timer} />
          ) : (
            <Text style={[styles.timer, { color: GREEN }]} numberOfLines={1}>{statusText}</Text>
          )}
        </TouchableOpacity>

        {ringing ? null : (
          <TouchableOpacity
            onPress={onHangup}
            activeOpacity={0.85}
            hitSlop={HITSLOP}
            style={[styles.sideBtn, styles.endBtn]}
          >
            <MaterialIcons name="call-end" size={18} color="#fff" />
          </TouchableOpacity>
        )}
      </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    elevation: 1000,
    borderBottomWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 4,
  },
  row: {
    height: MINI_BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
  },
  sideBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  endBtn: { backgroundColor: END_RED },
  answerBtn: { backgroundColor: GREEN, marginLeft: 10 },
  ringRow: {
    height: RING_BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
  },
  ringInfo: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  ringText: { flex: 1, marginLeft: 12 },
  ringName: { fontFamily: 'Roboto-Medium', fontSize: 16 },
  ringStatus: { fontFamily: 'Roboto-Regular', fontSize: 13, marginTop: 2 },
  center: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  centerIcon: { marginRight: 6 },
  title: {
    fontFamily: 'Roboto-Medium',
    fontSize: 16,
    flexShrink: 1,
  },
  dash: { fontFamily: 'Roboto-Medium', fontSize: 16 },
  timer: {
    color: GREEN,
    fontFamily: 'Roboto-Medium',
    fontSize: 16,
    opacity: 1,
  },
});
