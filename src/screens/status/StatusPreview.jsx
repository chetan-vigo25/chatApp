/**
 * StatusPreview — final step before posting.
 *
 * Shows a full-screen preview of each item (swipeable if batch),
 * caption input, visibility selector, and a [Post Status] button.
 *
 * Post flow:
 *  1. Upload each media item via statusServices.uploadStatusMedia
 *  2. Dispatch createStatus with assembled payload
 *  3. Navigate back to the StatusList tab
 *
 * Route params (from StatusCustomise or StatusCreate for text):
 *   items[]         — assembled items from Customise (may be empty for text/link)
 *   statusType      — 'image' | 'video' | 'text' | 'link' | 'audio'
 *   caption         — string
 *   textContent     — string (text statuses)
 *   backgroundColor — string (text statuses)
 *   linkUrl         — string (link statuses)
 *   ogData          — { title, description, imageUrl, url }
 *   filtersApplied  — string[] of filter IDs used
 *   visibility      — 'contacts' | 'all'  (backend enum: all/contacts/except/only)
 */
import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, Image, TouchableOpacity, StyleSheet,
  ScrollView, TextInput, ActivityIndicator, Alert,
  Platform, FlatList, Dimensions, BackHandler, Animated, Easing, Keyboard,
} from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useDispatch } from 'react-redux';
import { createStatus } from '../../Redux/Reducer/Status/Status.reducer';
import { statusServices } from '../../Redux/Services/Status/Status.Services';
import { useTheme } from '../../contexts/ThemeContext';
import useStatusSettings from '../../hooks/useStatusSettings';
import { STATUS_TYPE, STATUS_SPACE, STATUS_RADIUS } from './_statusDesign';

const { width: SW } = Dimensions.get('window');
// Full-SCREEN height (incl. system bars) — the keyboard's endCoordinates.screenY
// is in full-screen coords, so deriving keyboard height from it must use the
// SCREEN height, not the window height (smaller in Android edge-to-edge mode).
const SCREEN_H = Dimensions.get('screen').height;

// Backend enum: ['all', 'contacts', 'except', 'only']
const VISIBILITY_OPTIONS = [
  {
    id: 'contacts',
    label: 'My Contacts',
    icon: 'people-outline',
    hint: 'Only people saved in your contacts',
  },
  {
    id: 'all',
    label: 'Everyone',
    icon: 'globe-outline',
    hint: 'Contacts + people you have chatted with',
  },
];

// Animated upload progress bar — smooth fill, glowing leading cap, and a
// looping shimmer sweep. Pure RN Animated (no extra deps).
function UploadProgressBar({ percent = 0, color = '#03b0a2', trackWidth = 0 }) {
  const fill = useRef(new Animated.Value(0)).current;
  const shimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fill, {
      toValue: Math.max(0, Math.min(100, percent)),
      duration: 320,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [percent, fill]);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(shimmer, {
        toValue: 1,
        duration: 1100,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [shimmer]);

  const widthInterpolate = fill.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });
  const shimmerX = shimmer.interpolate({
    inputRange: [0, 1],
    outputRange: [-60, (trackWidth || 280) + 60],
  });

  return (
    <View style={progressStyles.track}>
      <Animated.View style={[progressStyles.fill, { width: widthInterpolate, backgroundColor: color }]}>
        {/* Glowing leading cap */}
        <View style={[progressStyles.cap, { backgroundColor: '#fff', shadowColor: color }]} />
      </Animated.View>
      {/* Shimmer sweep */}
      <Animated.View
        pointerEvents="none"
        style={[progressStyles.shimmer, { transform: [{ translateX: shimmerX }, { rotate: '18deg' }] }]}
      />
    </View>
  );
}

const progressStyles = StyleSheet.create({
  track: {
    width: '100%', height: 10, borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.14)',
    overflow: 'hidden',
    flexDirection: 'row',
    alignItems: 'center',
  },
  fill: {
    height: '100%', borderRadius: 6,
    alignItems: 'flex-end', justifyContent: 'center',
    minWidth: 10,
  },
  cap: {
    width: 6, height: 6, borderRadius: 3,
    marginRight: 3,
    shadowOpacity: 0.9, shadowRadius: 5, shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  shimmer: {
    position: 'absolute', top: -8, bottom: -8, width: 26,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
});

export default function StatusPreview({ navigation, route }) {
  const {
    items = [],
    statusType = 'image',
    caption: initialCaption = '',
    textContent = '',
    backgroundColor = '#026158',
    linkUrl = '',
    ogData = null,
    filtersApplied = [],
    visibility: initialVisibility = 'contacts',
  } = route.params || {};

  const { theme } = useTheme();
  const dispatch  = useDispatch();
  const { validateMediaList } = useStatusSettings();

  const [caption, setCaption]       = useState(initialCaption);
  const [visibility, setVisibility] = useState(initialVisibility);
  const [posting, setPosting]       = useState(false);
  const [progress, setProgress]     = useState({ current: 0, total: items.length || 1, percent: 0 });
  const [currentPreview, setCurrentPreview] = useState(0);
  const flatRef = useRef(null);
  const abortRef = useRef(null);
  const postingRef = useRef(false);

  // ── Keyboard lift for the caption composer ────────────────────────────────
  // KeyboardAvoidingView did NOTHING on Android (behavior was undefined) and in
  // edge-to-edge mode adjustResize is unreliable, so the caption input stayed
  // hidden behind the keyboard ("caption box upar nahi jata"). Track the height
  // ourselves and push the absolute bottom bar up by it — works on both
  // platforms regardless of windowSoftInputMode / edge-to-edge.
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    const onShow = (e) => {
      const coords = e?.endCoordinates;
      // Prefer the reported height; fall back to full-SCREEN − keyboard top
      // (Android edge-to-edge reports height 0 in some configs, screenY holds).
      const derived = coords?.screenY != null ? SCREEN_H - coords.screenY : 0;
      setKbHeight(Math.max(0, coords?.height ?? 0, derived));
    };
    const onHide = () => setKbHeight(0);
    const subs = [];
    if (Platform.OS === 'ios') {
      subs.push(Keyboard.addListener('keyboardWillShow', onShow));
      subs.push(Keyboard.addListener('keyboardWillHide', onHide));
    }
    subs.push(Keyboard.addListener('keyboardDidShow', onShow));
    subs.push(Keyboard.addListener('keyboardDidHide', onHide));
    return () => subs.forEach((s) => s.remove());
  }, []);

  const totalItems = items.length;

  // ── Abort handler ────────────────────────────────────────────────────────
  // Cancels the in-flight upload if user backs out or component unmounts.
  const cancelUpload = useCallback((reason) => {
    if (abortRef.current && !abortRef.current.signal.aborted) {
      try { abortRef.current.abort(reason || 'user_cancelled'); } catch {}
    }
  }, []);

  // Intercept Android hardware-back during posting → confirm before cancelling.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!postingRef.current) return false;
      Alert.alert('Cancel upload?', 'Your status has not been posted yet.', [
        { text: 'Keep uploading', style: 'cancel' },
        {
          text: 'Cancel',
          style: 'destructive',
          onPress: () => {
            cancelUpload('back_pressed');
            navigation.goBack();
          },
        },
      ]);
      return true;
    });
    return () => sub.remove();
  }, [cancelUpload, navigation]);

  // On unmount, make sure no orphaned request keeps draining bandwidth.
  useEffect(() => () => cancelUpload('unmount'), [cancelUpload]);

  // ── Upload + create ──────────────────────────────────────────────────────
  const handlePost = useCallback(async () => {
    if (postingRef.current) return; // double-tap guard

    // Re-validate against backend-driven limits right before upload — the
    // user may have left the picker hours ago and the admin row could have
    // changed (limits hook re-fetches every 5 min).
    if (items.length) {
      const check = validateMediaList(items);
      if (!check.ok) return Alert.alert('Cannot post', check.message);
    }

    postingRef.current = true;
    setPosting(true);
    abortRef.current = new AbortController();

    try {
      if (statusType === 'text') {
        await dispatch(createStatus({
          textContent,
          bgColor: backgroundColor,
          caption: caption.trim() || null,
          visibility,
        })).unwrap();
      } else if (statusType === 'link') {
        // Explicit link type — backend's mediaItem schema enum includes
        // 'link', so a single mediaItem with mediaType:'link' lets the
        // feed/list code identify the status as a link instead of falling
        // back to "looks like a text status that has a URL in it".
        await dispatch(createStatus({
          mediaItems: [{ mediaType: 'link' }],
          textContent: linkUrl,
          ogMetadata:  ogData || null,
          caption:     caption.trim() || null,
          visibility,
        })).unwrap();
      } else {
        // Media — upload each item then send assembled mediaItems[]
        const mediaItems = [];
        for (let i = 0; i < items.length; i++) {
          setProgress({ current: i + 1, total: items.length, percent: 0 });
          const item = items[i];
          const ext  = item.uri.split('.').pop()?.split('?')[0] || (item.type === 'video' ? 'mp4' : 'jpg');
          const fd   = new FormData();
          fd.append('files', {
            uri:  item.uri,
            name: `status_${Date.now()}_${i}.${ext}`,
            type: item.mimeType || (item.type === 'video' ? `video/${ext}` : `image/${ext}`),
          });

          const uploadRes = await statusServices.uploadStatusMedia(fd, {
            signal: abortRef.current.signal,
            // Videos can be much larger than the default 30s timeout allows.
            timeoutMs: item.type === 'video' ? 300000 : 60000,
            onProgress: (percent) => {
              setProgress((p) => ({ ...p, percent }));
            },
          });

          if (abortRef.current?.signal?.aborted) {
            throw Object.assign(new Error('Upload cancelled'), { name: 'AbortError' });
          }

          const rawData = uploadRes?.data;
          const media   = Array.isArray(rawData) ? rawData[0] : rawData;
          if (!media || (!media.mediaUrl && !media.url)) {
            throw new Error(`Upload failed for item ${i + 1}`);
          }

          // Forward the full storage metadata the upload returns. Without
          // mediaKey + mediaStorageType the backend's transformStatusUrls()
          // can't re-sign the URL on later fetches, so in production the
          // initial pre-signed S3 URL expires (~1h) and the status stops
          // rendering. (storageType → mediaStorageType is the schema field name.)
          mediaItems.push({
            mediaType:        item.type,
            mediaUrl:         media.mediaUrl || media.url,
            mediaKey:         media.mediaKey || null,
            mediaStorageType: media.storageType || media.mediaStorageType || 'local',
            thumbnailUrl:     media.thumbnailUrl || null,
            thumbnailKey:     media.thumbnailKey || null,
            duration:         media.duration || item.duration || null,
            width:            media.width  || item.width  || 0,
            height:           media.height || item.height || 0,
            mimeType:         media.mediaMeta?.mimeType     || item.mimeType || null,
            fileSize:         media.mediaMeta?.fileSize     || null,
            originalName:     media.mediaMeta?.originalName || null,
            order:            i,
          });
        }

        await dispatch(createStatus({
          mediaItems,
          caption: caption.trim() || null,
          visibility,
        })).unwrap();
      }

      // After a successful post, drop the user on the Status tab (not the
      // chat list). `ChatList` is the bottom-tab navigator; `StatusTab` is
      // the StatusList screen inside it.
      navigation.reset({
        index: 0,
        routes: [
          {
            name: 'ChatList',
            state: {
              index: 0,
              routes: [{ name: 'StatusTab' }],
            },
          },
        ],
      });
    } catch (err) {
      if (err?.name === 'AbortError' || /cancel/i.test(err?.message || '')) {
        // Silent on user-driven cancel — no scary toast.
      } else {
        Alert.alert('Failed to post', err?.message || 'Please try again.');
      }
    } finally {
      postingRef.current = false;
      setPosting(false);
      abortRef.current = null;
    }
  }, [
    statusType, textContent, backgroundColor, linkUrl, ogData,
    items, caption, visibility, dispatch, navigation, validateMediaList,
  ]);

  // ── Render preview content ────────────────────────────────────────────────
  const renderPreviewItem = ({ item, index }) => (
    <View style={styles.previewItem}>
      {item.type === 'video' ? (
        <Video
          source={{ uri: item.uri }}
          style={styles.previewMedia}
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay={index === currentPreview}
          isLooping
          isMuted={item.muted || false}
          useNativeControls={false}
        />
      ) : (
        <Image source={{ uri: item.uri }} style={styles.previewMedia} resizeMode="contain" />
      )}
      {item.filterTint && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: item.filterTint, pointerEvents: 'none' }]} />
      )}
      {item.textOverlay ? (
        <View style={styles.textOverlayBadge}>
          <Text style={styles.textOverlayText}>{item.textOverlay}</Text>
        </View>
      ) : null}
    </View>
  );

  const renderTextPreview = () => (
    <View style={[styles.textPreview, { backgroundColor }]}>
      <Text style={styles.textPreviewBody}>{textContent}</Text>
    </View>
  );

  const renderLinkPreview = () => {
    // Backend `ogMetadata` schema uses `image` (not `imageUrl`). Tolerate
    // either so older route params (pre-fix) still render.
    const ogImage = ogData?.image || ogData?.imageUrl || null;
    return (
      <View style={[styles.linkPreview, { backgroundColor: theme.colors.surface }]}>
        {ogImage ? (
          <Image source={{ uri: ogImage }} style={styles.ogImage} resizeMode="cover" />
        ) : null}
        <View style={styles.ogBody}>
          <MaterialCommunityIcons name="link-variant" size={16} color={theme.colors.themeColor} style={{ marginBottom: 4 }} />
          <Text style={[styles.ogTitle, { color: theme.colors.primaryTextColor }]} numberOfLines={2}>{ogData?.title || linkUrl}</Text>
          {ogData?.description ? (
            <Text style={[styles.ogDesc, { color: theme.colors.placeHolderTextColor }]} numberOfLines={2}>{ogData.description}</Text>
          ) : null}
          {ogData?.siteName ? (
            <Text style={[styles.ogSite, { color: theme.colors.placeHolderTextColor }]} numberOfLines={1}>{ogData.siteName}</Text>
          ) : null}
          <Text style={[styles.ogUrl, { color: theme.colors.themeColor }]} numberOfLines={1}>{ogData?.url || linkUrl}</Text>
        </View>
      </View>
    );
  };

  const currentVisibility =
    VISIBILITY_OPTIONS.find(o => o.id === visibility) || VISIBILITY_OPTIONS[0];

  return (
    <View style={[styles.container, { backgroundColor: '#000' }]}>
      {/* ── Posting overlay — glass blur + progress bar ── */}
      {posting && (
        <BlurView intensity={50} tint="dark" style={styles.postingOverlay}>
          <View style={styles.postingCard}>
            {/* Thumbnail of what's uploading */}
            {items?.[Math.max(0, (progress.current || 1) - 1)]?.uri ? (
              <View style={[styles.postingThumbRing, { borderColor: theme.colors.themeColor }]}>
                <Image
                  source={{ uri: items[Math.max(0, (progress.current || 1) - 1)].uri }}
                  style={styles.postingThumb}
                />
              </View>
            ) : null}

            <Text style={styles.postingEyebrow}>SENDING TO YOUR STORY</Text>
            <Text style={styles.postingTitle}>
              {totalItems > 1
                ? `Uploading ${progress.current} of ${progress.total}`
                : 'Uploading…'}
            </Text>

            <UploadProgressBar
              percent={progress.percent || 0}
              color={theme.colors.themeColor || '#03b0a2'}
              trackWidth={Math.min(SW - 2 * STATUS_SPACE.gutter - 44, 316)}
            />
            <Text style={styles.postingPercent}>{progress.percent || 0}%</Text>

            <TouchableOpacity
              onPress={() => cancelUpload('user_tap_cancel')}
              style={styles.cancelUploadBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.cancelUploadText}>Cancel upload</Text>
            </TouchableOpacity>
          </View>
        </BlurView>
      )}

      {/* ── Full-screen media preview ── */}
      <View style={styles.previewArea}>
        {statusType === 'text' ? renderTextPreview()
          : statusType === 'link' ? renderLinkPreview()
          : (
            <FlatList
              ref={flatRef}
              data={items}
              horizontal
              pagingEnabled
              style={styles.flex}
              showsHorizontalScrollIndicator={false}
              keyExtractor={(_, i) => String(i)}
              renderItem={renderPreviewItem}
              onMomentumScrollEnd={e => {
                const newIdx = Math.round(e.nativeEvent.contentOffset.x / SW);
                setCurrentPreview(newIdx);
              }}
            />
          )
        }
      </View>

      {/* ── Top controls overlay (close + counter) ── */}
      <View style={styles.topBar} pointerEvents="box-none">
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.topBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="close" size={26} color="#fff" />
        </TouchableOpacity>
        <View style={styles.flex} />
        {totalItems > 1 && (
          <View style={styles.counterPill}>
            <Text style={styles.counterText}>{currentPreview + 1}/{totalItems}</Text>
          </View>
        )}
      </View>

      {/* Batch dot indicators */}
      {totalItems > 1 && (
        <View style={styles.dotRow} pointerEvents="none">
          {items.map((_, i) => (
            <View key={i} style={[styles.dot, i === currentPreview ? styles.dotActive : styles.dotInactive]} />
          ))}
        </View>
      )}

      {/* ── Bottom composer: caption + visibility + send (WhatsApp style) ── */}
      {/* Lift the absolute bar above the keyboard via the tracked height (see
          the kbHeight effect) — reliable on Android + iOS + edge-to-edge, which
          KeyboardAvoidingView was not. */}
      <View
        style={[styles.bottomWrap, kbHeight > 0 && { bottom: kbHeight, paddingBottom: 12 }]}
        pointerEvents="box-none"
      >
        {/* Caption pill */}
        <View style={styles.captionRow}>
          <Ionicons name="happy-outline" size={22} color="rgba(255,255,255,0.7)" style={styles.captionEmoji} />
          <TextInput
            style={styles.captionInput}
            placeholder="Add a caption…"
            placeholderTextColor="rgba(255,255,255,0.6)"
            value={caption}
            onChangeText={setCaption}
            maxLength={500}
            multiline
          />
        </View>

        {/* Send row */}
        <View style={styles.sendRow}>
          <TouchableOpacity
            onPress={() => {
              const idx = VISIBILITY_OPTIONS.findIndex(o => o.id === visibility);
              const next = VISIBILITY_OPTIONS[(idx + 1) % VISIBILITY_OPTIONS.length];
              setVisibility(next.id);
            }}
            activeOpacity={0.8}
            style={styles.visPill}
          >
            <Ionicons name={currentVisibility.icon} size={15} color="#fff" />
            <Text style={styles.visPillText} numberOfLines={1}>{currentVisibility.label}</Text>
            <Ionicons name="chevron-up" size={14} color="rgba(255,255,255,0.7)" />
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handlePost}
            disabled={posting}
            activeOpacity={0.85}
            style={[styles.sendFab, { backgroundColor: theme.colors.themeColor, opacity: posting ? 0.6 : 1 }]}
          >
            {posting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Ionicons name="send" size={22} color="#fff" style={{ marginLeft: 2 }} />
            )}
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },

  // ── Posting overlay — glass card + progress bar ───────────────────────────
  postingOverlay: {
    ...StyleSheet.absoluteFillObject, zIndex: 999,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: STATUS_SPACE.gutter,
  },
  postingCard: {
    width: '100%', maxWidth: 360,
    backgroundColor: 'rgba(20,20,22,0.85)',
    borderRadius: STATUS_RADIUS.lg,
    paddingVertical: 28, paddingHorizontal: 22,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
  },
  postingThumbRing: {
    width: 72, height: 72, borderRadius: 36,
    borderWidth: 2.5, padding: 3,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 18,
  },
  postingThumb: { width: '100%', height: '100%', borderRadius: 33 },
  postingEyebrow: { ...STATUS_TYPE.caps, color: 'rgba(255,255,255,0.55)', marginBottom: 6 },
  postingTitle:   { ...STATUS_TYPE.title, color: '#fff', marginBottom: 22, textAlign: 'center' },
  postingPercent: { color: '#fff', fontSize: 14, fontFamily: 'Roboto-Bold', marginTop: 12, opacity: 0.92, letterSpacing: 0.5 },
  cancelUploadBtn: {
    marginTop: 22,
    paddingVertical: 10, paddingHorizontal: 22,
    borderRadius: STATUS_RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.45)',
  },
  cancelUploadText: { color: '#fff', fontSize: 13, fontFamily: 'Roboto-SemiBold', letterSpacing: 0.3 },

  // ── Full-screen media preview ─────────────────────────────────────────────
  previewArea: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  previewItem: { width: SW, height: '100%', alignItems: 'center', justifyContent: 'center' },
  previewMedia: { width: SW, height: '100%' },
  textPreview: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 36 },
  textPreviewBody: { color: '#fff', fontSize: 26, fontFamily: 'Roboto-SemiBold', textAlign: 'center', lineHeight: 34 },
  textOverlayBadge: { position: 'absolute', top: '35%', left: 20, right: 20, alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.4)', padding: 8, borderRadius: 8 },
  textOverlayText: { color: '#fff', fontSize: 20, fontFamily: 'Roboto-Bold', textAlign: 'center' },

  // ── Link preview card ─────────────────────────────────────────────────────
  linkPreview: { flex: 1, justifyContent: 'center', alignItems: 'stretch', backgroundColor: '#111B21' },
  ogImage:     { width: '100%', height: 200 },
  ogBody:      { padding: 18, width: '100%' },
  ogTitle:     { ...STATUS_TYPE.title, color: '#fff', fontSize: 18, lineHeight: 24, marginBottom: 6 },
  ogDesc:      { ...STATUS_TYPE.body, color: 'rgba(255,255,255,0.7)', fontSize: 13, marginBottom: 6 },
  ogSite:      { ...STATUS_TYPE.caps, color: 'rgba(255,255,255,0.55)', marginBottom: 4 },
  ogUrl:       { fontSize: 12, fontFamily: 'Roboto-SemiBold', color: '#53BDEB' },

  // ── Top controls overlay ──────────────────────────────────────────────────
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center',
    paddingTop: Platform.OS === 'ios' ? 54 : 36,
    paddingHorizontal: 14, paddingBottom: 12,
    gap: 12,
  },
  topBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  counterPill: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.45)',
  },
  counterText: { color: '#fff', fontSize: 12, fontFamily: 'Roboto-Bold', letterSpacing: 0.5 },

  // ── Dots ──────────────────────────────────────────────────────────────────
  dotRow: { position: 'absolute', bottom: 150, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotActive: { backgroundColor: '#fff', width: 18 },
  dotInactive: { backgroundColor: 'rgba(255,255,255,0.45)' },

  // ── Bottom composer ───────────────────────────────────────────────────────
  bottomWrap: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: 12,
    paddingBottom: Platform.OS === 'ios' ? 30 : 14,
  },
  captionRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 26, paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 10 : 4,
    minHeight: 48,
  },
  captionEmoji: { marginRight: 8 },
  captionInput: {
    flex: 1,
    color: '#fff', fontSize: 16, fontFamily: 'Roboto-Regular',
    paddingVertical: 0, maxHeight: 110,
  },
  sendRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 12,
  },
  visPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 22, paddingVertical: 9, paddingHorizontal: 14,
    maxWidth: SW * 0.62,
  },
  visPillText: { color: '#fff', fontSize: 14, fontFamily: 'Roboto-SemiBold' },
  sendFab: {
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 8, elevation: 6,
  },
});
