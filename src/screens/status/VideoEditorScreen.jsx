/**
 * VideoEditorScreen — Rich video editor for status uploads.
 *
 * Features:
 *  • Full-screen video preview with play/pause
 *  • Timeline trim strip with draggable left/right handles
 *  • Real-time duration & position display
 *  • Progress playhead synced to video position
 *  • Aspect ratio / crop selector (Original, 9:16, 1:1, 4:5, 16:9)
 *  • Mute toggle with animated pill
 *  • "Upload without edit" skips editor → StatusCustomise
 *  • "Apply & Continue" attaches trimStart, trimEnd, aspectRatio, muted metadata
 *
 * Navigation params:
 *  { item?: videoItem, items?: videoItem[] }
 *
 * Routes to: StatusCustomise
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Dimensions, PanResponder, Animated, ScrollView, Platform,
} from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';

const { width: SW } = Dimensions.get('window');

// ── Layout constants ──────────────────────────────────────────────────────────
const TRIM_PAD  = 20;
const TRACK_W   = SW - TRIM_PAD * 2;
const TRIM_H    = 54;
const HANDLE_W  = 18;
const HANDLE_HR = HANDLE_W / 2;
const MIN_GAP   = TRACK_W * 0.05;  // 5% minimum trim selection

const ASPECT_RATIOS = [
  { key: 'original', label: 'Original', icon: 'aspect-ratio-outline' },
  { key: '9:16',     label: '9:16',     icon: null },
  { key: '1:1',      label: '1:1',      icon: null },
  { key: '4:5',      label: '4:5',      icon: null },
  { key: '16:9',     label: '16:9',     icon: null },
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const fmtMs = (ms) => {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
};

// ─────────────────────────────────────────────────────────────────────────────

export default function VideoEditorScreen({ navigation, route }) {
  const { theme } = useTheme();
  const { item, items } = route.params || {};

  const allItems  = Array.isArray(items) ? items : (item ? [item] : []);
  const videoItem = allItems[0] || {};

  // ── Video state ────────────────────────────────────────────────────────────
  const videoRef = useRef(null);
  const [pbStatus, setPbStatus] = useState({});
  const [duration, setDuration] = useState(videoItem.duration || 0);
  const [isMuted,  setIsMuted]  = useState(false);
  const [arKey,    setArKey]    = useState('original');
  const [playing,  setPlaying]  = useState(false);

  // ── Trim animated values (pixel offsets 0..TRACK_W) ───────────────────────
  const leftAnim  = useRef(new Animated.Value(0)).current;
  const rightAnim = useRef(new Animated.Value(TRACK_W)).current;
  const phAnim    = useRef(new Animated.Value(0)).current; // playhead

  // Mutable refs so PanResponder closures see latest values without stale closure
  const leftRef  = useRef(0);
  const rightRef = useRef(TRACK_W);
  const durRef   = useRef(0);

  // State-driven trim display (fractions 0..1) — updates on drag
  const [trimDisplay, setTrimDisplay] = useState({ left: 0, right: 1 });

  useEffect(() => {
    const ls = leftAnim.addListener(({ value }) => { leftRef.current = value; });
    const rs = rightAnim.addListener(({ value }) => { rightRef.current = value; });
    return () => { leftAnim.removeListener(ls); rightAnim.removeListener(rs); };
  }, [leftAnim, rightAnim]);

  // ── Playback status handler ────────────────────────────────────────────────
  const onPlaybackStatusUpdate = useCallback((s) => {
    setPbStatus(s);
    if (!s.isLoaded) return;

    if (s.durationMillis) {
      setDuration(prev => prev || s.durationMillis);
      durRef.current = s.durationMillis;
      const frac = s.positionMillis / s.durationMillis;
      phAnim.setValue(frac * TRACK_W);
      setPlaying(s.isPlaying);

      // Auto-stop at right trim handle
      if (s.isPlaying && frac >= rightRef.current / TRACK_W - 0.01) {
        videoRef.current?.pauseAsync();
        videoRef.current?.setPositionAsync((leftRef.current / TRACK_W) * s.durationMillis);
      }
    }
  }, [phAnim]);

  const togglePlay = useCallback(async () => {
    if (!videoRef.current) return;
    if (pbStatus.isPlaying) {
      videoRef.current.pauseAsync();
      return;
    }
    // If at/past trim end → seek to trim start before playing
    const dur = pbStatus.durationMillis || durRef.current || 0;
    const pos = pbStatus.positionMillis || 0;
    if (dur > 0 && pos / dur >= rightRef.current / TRACK_W - 0.01) {
      await videoRef.current.setPositionAsync((leftRef.current / TRACK_W) * dur);
    }
    videoRef.current.playAsync();
  }, [pbStatus]);

  // ── Left trim PanResponder ─────────────────────────────────────────────────
  const leftStart = useRef(0);
  const leftPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        leftStart.current = leftRef.current;
      },
      onPanResponderMove: (_, { dx }) => {
        const next = clamp(leftStart.current + dx, 0, rightRef.current - MIN_GAP);
        leftAnim.setValue(next);
        setTrimDisplay(prev => ({ ...prev, left: next / TRACK_W }));
        if (durRef.current) {
          videoRef.current?.setPositionAsync((next / TRACK_W) * durRef.current);
        }
      },
      onPanResponderRelease: () => {},
    })
  ).current;

  // ── Right trim PanResponder ────────────────────────────────────────────────
  const rightStart = useRef(0);
  const rightPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        rightStart.current = rightRef.current;
      },
      onPanResponderMove: (_, { dx }) => {
        const next = clamp(rightStart.current + dx, leftRef.current + MIN_GAP, TRACK_W);
        rightAnim.setValue(next);
        setTrimDisplay(prev => ({ ...prev, right: next / TRACK_W }));
      },
      onPanResponderRelease: () => {},
    })
  ).current;

  // ── Navigate out ───────────────────────────────────────────────────────────
  const goNext = useCallback((withEdits) => {
    const dur = durRef.current || duration;
    const editedItems = allItems.map(it => {
      if (it.type !== 'video' || !withEdits) return it;
      return {
        ...it,
        trimStart:   (leftRef.current  / TRACK_W) * dur,
        trimEnd:     (rightRef.current / TRACK_W) * dur,
        aspectRatio: arKey !== 'original' ? arKey : undefined,
        muted:       isMuted,
      };
    });
    navigation.navigate('StatusCustomise', { items: editedItems });
  }, [duration, arKey, isMuted, allItems, navigation]);

  // ── Derived display values ─────────────────────────────────────────────────
  const totalMs = pbStatus.durationMillis || duration || 1;
  const posMs   = pbStatus.positionMillis || 0;
  const trimStartMs = trimDisplay.left  * totalMs;
  const trimEndMs   = trimDisplay.right * totalMs;

  // Video container style — changes based on selected aspect ratio
  const videoContainerStyle = (() => {
    switch (arKey) {
      case '9:16': return { width: SW * 0.48, aspectRatio: 9 / 16, alignSelf: 'center' };
      case '1:1':  return { width: SW * 0.75, aspectRatio: 1,      alignSelf: 'center' };
      case '4:5':  return { width: SW * 0.72, aspectRatio: 4 / 5,  alignSelf: 'center' };
      case '16:9': return { width: '100%',    aspectRatio: 16 / 9 };
      default:     return { width: '100%', flex: 1 };
    }
  })();

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <View style={styles.root}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={styles.closeBtn}
        >
          <Ionicons name="close" size={26} color="#fff" />
        </TouchableOpacity>

        <Text style={styles.headerTitle}>Video Editor</Text>

        <TouchableOpacity
          onPress={() => goNext(true)}
          style={[styles.continueBtn, { backgroundColor: theme.colors.themeColor }]}
          activeOpacity={0.85}
        >
          <Text style={styles.continueBtnText}>Continue</Text>
          <Ionicons name="arrow-forward" size={14} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* ── Video preview ──────────────────────────────────────────────────── */}
      <View style={styles.videoArea}>
        <View style={[styles.videoBg, videoContainerStyle]}>
          <Video
            ref={videoRef}
            source={{ uri: videoItem.uri }}
            style={StyleSheet.absoluteFill}
            resizeMode={ResizeMode.CONTAIN}
            isLooping={false}
            isMuted={isMuted}
            onPlaybackStatusUpdate={onPlaybackStatusUpdate}
            useNativeControls={false}
          />

          {/* Play / pause overlay */}
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            onPress={togglePlay}
            activeOpacity={0.9}
          >
            <View style={styles.playOverlay}>
              {!playing && (
                <View style={styles.playCircle}>
                  <Ionicons name="play" size={30} color="#fff" style={{ marginLeft: 4 }} />
                </View>
              )}
            </View>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Editor panel ───────────────────────────────────────────────────── */}
      <View style={styles.panel}>

        {/* Time row */}
        <View style={styles.timeRow}>
          <Ionicons
            name={playing ? 'pause-circle' : 'play-circle'}
            size={16}
            color="rgba(255,255,255,0.45)"
          />
          <Text style={styles.timeCurrent}> {fmtMs(posMs)}</Text>
          <Text style={styles.timeSep}> / </Text>
          <Text style={styles.timeTotal}>{fmtMs(totalMs)}</Text>
          <View style={{ flex: 1 }} />

          {/* Trim badge */}
          <View style={[styles.trimBadge, { borderColor: theme.colors.themeColor + '60', backgroundColor: theme.colors.themeColor + '18' }]}>
            <MaterialCommunityIcons name="content-cut" size={11} color={theme.colors.themeColor} />
            <Text style={[styles.trimBadgeText, { color: theme.colors.themeColor }]}>
              {fmtMs(trimStartMs)} – {fmtMs(trimEndMs)}
            </Text>
          </View>
        </View>

        {/* ── Trim strip ──────────────────────────────────────────────────── */}
        <View style={[styles.trimOuter, { paddingHorizontal: TRIM_PAD }]}>
          {/* Tick marks */}
          <View style={styles.ticks}>
            {Array.from({ length: 5 }).map((_, i) => (
              <Text key={i} style={styles.tickText}>
                {fmtMs((i / 4) * totalMs)}
              </Text>
            ))}
          </View>

          {/* Main track */}
          <View style={[styles.trimTrack, { width: TRACK_W, height: TRIM_H }]}>

            {/* Dimmed outer-left region */}
            <Animated.View
              style={[
                styles.dimRegion,
                { left: 0, width: leftAnim, borderTopLeftRadius: 6, borderBottomLeftRadius: 6 },
              ]}
            />

            {/* Dimmed outer-right region */}
            <Animated.View
              style={[
                styles.dimRegion,
                {
                  right: 0,
                  width: Animated.subtract(new Animated.Value(TRACK_W), rightAnim),
                  borderTopRightRadius: 6,
                  borderBottomRightRadius: 6,
                },
              ]}
            />

            {/* Selected region border */}
            <Animated.View
              style={[
                styles.selectedRegion,
                {
                  left:  leftAnim,
                  width: Animated.subtract(rightAnim, leftAnim),
                  borderColor: theme.colors.themeColor,
                },
              ]}
            />

            {/* Playhead */}
            <Animated.View
              style={[
                styles.playhead,
                { left: Animated.add(phAnim, new Animated.Value(-1)) },
              ]}
            />

            {/* Left trim handle */}
            <Animated.View
              style={[
                styles.handle,
                {
                  left: Animated.add(leftAnim, new Animated.Value(-HANDLE_HR)),
                  backgroundColor: theme.colors.themeColor,
                },
              ]}
              {...leftPan.panHandlers}
            >
              <View style={styles.handleDots}>
                <View style={styles.hdot} />
                <View style={styles.hdot} />
                <View style={styles.hdot} />
              </View>
            </Animated.View>

            {/* Right trim handle */}
            <Animated.View
              style={[
                styles.handle,
                {
                  left: Animated.add(rightAnim, new Animated.Value(-HANDLE_HR)),
                  backgroundColor: theme.colors.themeColor,
                },
              ]}
              {...rightPan.panHandlers}
            >
              <View style={styles.handleDots}>
                <View style={styles.hdot} />
                <View style={styles.hdot} />
                <View style={styles.hdot} />
              </View>
            </Animated.View>
          </View>
        </View>

        {/* ── Crop / Aspect Ratio ──────────────────────────────────────────── */}
        <Text style={styles.secLabel}>CROP / ASPECT RATIO</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.aspectRow}
        >
          {ASPECT_RATIOS.map(ar => {
            const active = arKey === ar.key;
            return (
              <TouchableOpacity
                key={ar.key}
                onPress={() => setArKey(ar.key)}
                activeOpacity={0.7}
                style={[
                  styles.aspectBtn,
                  active
                    ? { backgroundColor: theme.colors.themeColor, borderColor: theme.colors.themeColor }
                    : { borderColor: 'rgba(255,255,255,0.2)' },
                ]}
              >
                {ar.key === 'original' && (
                  <MaterialCommunityIcons
                    name="aspect-ratio"
                    size={13}
                    color={active ? '#fff' : 'rgba(255,255,255,0.55)'}
                    style={{ marginRight: 4 }}
                  />
                )}
                <Text style={[styles.aspectText, active && { color: '#fff' }]}>
                  {ar.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* ── Mute toggle ─────────────────────────────────────────────────── */}
        <TouchableOpacity
          onPress={() => setIsMuted(v => !v)}
          style={styles.muteRow}
          activeOpacity={0.75}
        >
          <View style={[
            styles.muteIconWrap,
            { backgroundColor: isMuted ? theme.colors.themeColor + '22' : 'rgba(255,255,255,0.07)' },
          ]}>
            <Ionicons
              name={isMuted ? 'volume-mute' : 'volume-high-outline'}
              size={18}
              color={isMuted ? theme.colors.themeColor : 'rgba(255,255,255,0.5)'}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.muteTitle, { color: isMuted ? '#fff' : 'rgba(255,255,255,0.55)' }]}>
              {isMuted ? 'Audio muted' : 'Mute audio'}
            </Text>
            <Text style={styles.muteSub}>
              {isMuted ? 'Video will upload without sound' : 'Keep original audio'}
            </Text>
          </View>
          {/* Toggle pill */}
          <View style={[
            styles.togglePill,
            { backgroundColor: isMuted ? theme.colors.themeColor : 'rgba(255,255,255,0.15)' },
          ]}>
            <Animated.View
              style={[styles.toggleKnob, { left: isMuted ? 18 : 2 }]}
            />
          </View>
        </TouchableOpacity>

        {/* ── Bottom actions ───────────────────────────────────────────────── */}
        <View style={styles.actions}>
          <TouchableOpacity
            onPress={() => goNext(false)}
            style={styles.skipBtn}
            activeOpacity={0.7}
          >
            <Ionicons name="cloud-upload-outline" size={15} color="rgba(255,255,255,0.55)" />
            <Text style={styles.skipText}>Upload without edit</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => goNext(true)}
            style={[styles.applyBtn, { backgroundColor: theme.colors.themeColor }]}
            activeOpacity={0.85}
          >
            <Ionicons name="checkmark-circle" size={17} color="#fff" />
            <Text style={styles.applyText}>Apply & Continue</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },

  // ── Header ────────────────────────────────────────────────────────────────
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 52 : 18,
    paddingBottom: 10,
  },
  closeBtn:  {},
  headerTitle: {
    flex: 1, color: '#fff', fontSize: 17, fontWeight: '700', marginLeft: 16,
  },
  continueBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8,
  },
  continueBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },

  // ── Video ─────────────────────────────────────────────────────────────────
  videoArea: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  videoBg: { overflow: 'hidden', backgroundColor: '#000' },
  playOverlay: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
  },
  playCircle: {
    width: 68, height: 68, borderRadius: 34,
    backgroundColor: 'rgba(0,0,0,0.52)',
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.25)',
  },

  // ── Editor panel ──────────────────────────────────────────────────────────
  panel: {
    backgroundColor: '#111',
    paddingTop: 14,
    paddingBottom: Platform.OS === 'ios' ? 30 : 16,
  },

  // Time row
  timeRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: TRIM_PAD, marginBottom: 10,
  },
  timeCurrent: { color: '#fff', fontSize: 13, fontWeight: '600' },
  timeSep:     { color: 'rgba(255,255,255,0.3)', fontSize: 13 },
  timeTotal:   { color: 'rgba(255,255,255,0.4)', fontSize: 13 },
  trimBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 9, paddingVertical: 4,
    borderRadius: 12, borderWidth: 1,
  },
  trimBadgeText: { fontSize: 11, fontWeight: '600' },

  // Trim strip
  trimOuter: { marginBottom: 6 },
  ticks: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingHorizontal: 2, marginBottom: 4,
  },
  tickText: { color: 'rgba(255,255,255,0.25)', fontSize: 9 },
  trimTrack: {
    position: 'relative',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 6, overflow: 'visible',
    marginBottom: 18,
  },

  // Dim region (outside trim)
  dimRegion: {
    position: 'absolute', top: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },

  // Selected region (bright border)
  selectedRegion: {
    position: 'absolute', top: 0, bottom: 0,
    borderTopWidth: 2.5, borderBottomWidth: 2.5,
    borderLeftWidth: 0, borderRightWidth: 0,
  },

  // Playhead
  playhead: {
    position: 'absolute', top: -7, bottom: -7,
    width: 2, backgroundColor: '#fff', borderRadius: 1,
    shadowColor: '#fff', shadowOpacity: 0.7, shadowRadius: 3, elevation: 6,
  },

  // Drag handles
  handle: {
    position: 'absolute', top: 0, bottom: 0,
    width: HANDLE_W, borderRadius: 5,
    justifyContent: 'center', alignItems: 'center',
    zIndex: 10,
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 3, elevation: 4,
  },
  handleDots: { gap: 4, alignItems: 'center' },
  hdot: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.85)' },

  // Crop
  secLabel: {
    color: 'rgba(255,255,255,0.3)', fontSize: 10, letterSpacing: 1.4,
    fontWeight: '700', paddingHorizontal: TRIM_PAD, marginBottom: 8,
  },
  aspectRow: {
    paddingHorizontal: TRIM_PAD, gap: 8, paddingBottom: 14,
  },
  aspectBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 7,
    borderRadius: 20, borderWidth: 1.5,
  },
  aspectText: { color: 'rgba(255,255,255,0.55)', fontSize: 13, fontWeight: '600' },

  // Mute
  muteRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: TRIM_PAD, marginBottom: 14, gap: 10,
  },
  muteIconWrap: {
    width: 38, height: 38, borderRadius: 19,
    justifyContent: 'center', alignItems: 'center',
  },
  muteTitle: { fontSize: 13, fontWeight: '600' },
  muteSub:   { fontSize: 11, color: 'rgba(255,255,255,0.3)', marginTop: 1 },
  togglePill: {
    width: 38, height: 22, borderRadius: 11,
    position: 'relative',
  },
  toggleKnob: {
    position: 'absolute', top: 3,
    width: 16, height: 16, borderRadius: 8,
    backgroundColor: '#fff',
  },

  // Bottom actions
  actions: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: TRIM_PAD, gap: 10,
  },
  skipBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 13, borderRadius: 12, gap: 6,
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.18)',
  },
  skipText: { color: 'rgba(255,255,255,0.6)', fontSize: 12.5, fontWeight: '600' },
  applyBtn: {
    flex: 1.4, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 13, borderRadius: 12, gap: 8,
  },
  applyText: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
