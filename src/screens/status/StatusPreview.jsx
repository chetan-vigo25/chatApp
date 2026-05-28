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
  Platform, FlatList, Dimensions, BackHandler,
} from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useDispatch } from 'react-redux';
import { createStatus } from '../../Redux/Reducer/Status/Status.reducer';
import { statusServices } from '../../Redux/Services/Status/Status.Services';
import { useTheme } from '../../contexts/ThemeContext';
import useStatusSettings from '../../hooks/useStatusSettings';
import { STATUS_TYPE, STATUS_SPACE, STATUS_RADIUS, STATUS_ACCENT } from './_statusDesign';

const { width: SW } = Dimensions.get('window');

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

export default function StatusPreview({ navigation, route }) {
  const {
    items = [],
    statusType = 'image',
    caption: initialCaption = '',
    textContent = '',
    backgroundColor = '#075e54',
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

          mediaItems.push({
            mediaType:    item.type,
            mediaUrl:     media.mediaUrl || media.url,
            thumbnailUrl: media.thumbnailUrl || null,
            duration:     media.duration || item.duration || null,
            width:        media.width  || item.width  || 0,
            height:       media.height || item.height || 0,
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
    <View style={{ width: SW }}>
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

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* ── Posting overlay — glass blur + progress bar ── */}
      {posting && (
        <BlurView intensity={50} tint="dark" style={styles.postingOverlay}>
          <View style={styles.postingCard}>
            <Text style={styles.postingEyebrow}>SENDING TO YOUR STORY</Text>
            <Text style={styles.postingTitle}>
              {totalItems > 1
                ? `Uploading ${progress.current} of ${progress.total}`
                : 'Uploading…'}
            </Text>

            <View style={styles.progressBarTrack}>
              <View style={[styles.progressBarFill, { width: `${progress.percent || 0}%` }]} />
            </View>
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

      {/* ── Editorial header ── */}
      <View style={[styles.header, { backgroundColor: theme.colors.background }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="chevron-back" size={26} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[styles.headerEyebrow, { color: theme.colors.placeHolderTextColor }]}>
            NEW STORY
          </Text>
          <Text style={[styles.headerTitle, { color: theme.colors.primaryTextColor }]}>
            Preview
          </Text>
        </View>
        {totalItems > 1 && (
          <View style={[styles.headerCounter, { borderColor: theme.colors.border }]}>
            <Text style={[styles.headerCounterText, { color: theme.colors.primaryTextColor }]}>
              {currentPreview + 1} / {totalItems}
            </Text>
          </View>
        )}
      </View>

      {/* ── Preview area ── */}
      <View style={styles.previewArea}>
        {statusType === 'text' ? renderTextPreview()
          : statusType === 'link' ? renderLinkPreview()
          : (
            <FlatList
              ref={flatRef}
              data={items}
              horizontal
              pagingEnabled
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

        {/* Batch dot indicators */}
        {totalItems > 1 && (
          <View style={styles.dotRow}>
            {items.map((_, i) => (
              <View
                key={i}
                style={[styles.dot, i === currentPreview ? styles.dotActive : styles.dotInactive]}
              />
            ))}
          </View>
        )}
      </View>

      {/* ── Settings panel ── */}
      <ScrollView
        style={[styles.panel, { backgroundColor: theme.colors.background }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Caption */}
        <View style={styles.section}>
          <View style={styles.captionHead}>
            <Text style={[styles.sectionLabel, { color: theme.colors.placeHolderTextColor }]}>CAPTION</Text>
            <Text style={[styles.captionCounter, { color: theme.colors.placeHolderTextColor }]}>
              {caption.length}/500
            </Text>
          </View>
          <TextInput
            style={[styles.captionInput, { backgroundColor: theme.colors.surface, color: theme.colors.primaryTextColor, borderColor: theme.colors.border }]}
            placeholder="Add a few words…"
            placeholderTextColor={theme.colors.placeHolderTextColor}
            value={caption}
            onChangeText={setCaption}
            maxLength={500}
            multiline
          />
        </View>

        {/* Visibility */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: theme.colors.placeHolderTextColor }]}>WHO CAN SEE</Text>
          <View style={styles.visibilityRow}>
            {VISIBILITY_OPTIONS.map(opt => {
              const active = visibility === opt.id;
              return (
                <TouchableOpacity
                  key={opt.id}
                  style={[
                    styles.visibilityChip,
                    { borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
                    active && { borderColor: theme.colors.themeColor, backgroundColor: `${theme.colors.themeColor}22` },
                  ]}
                  onPress={() => setVisibility(opt.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`${opt.label}. ${opt.hint}`}
                >
                  <View style={styles.visibilityChipRow}>
                    <Ionicons
                      name={opt.icon}
                      size={16}
                      color={active ? theme.colors.themeColor : theme.colors.placeHolderTextColor}
                    />
                    <Text
                      style={[
                        styles.visibilityLabel,
                        { color: active ? theme.colors.themeColor : theme.colors.placeHolderTextColor },
                      ]}
                    >
                      {opt.label}
                    </Text>
                    {active ? (
                      <Ionicons
                        name="checkmark-circle"
                        size={14}
                        color={theme.colors.themeColor}
                        style={styles.visibilityCheck}
                      />
                    ) : null}
                  </View>
                  <Text
                    style={[
                      styles.visibilityHint,
                      { color: theme.colors.placeHolderTextColor },
                    ]}
                  >
                    {opt.hint}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Filters summary (if any applied) */}
        {filtersApplied.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionLabel, { color: theme.colors.placeHolderTextColor }]}>FILTERS APPLIED</Text>
            <Text style={[styles.filtersSummary, { color: theme.colors.primaryTextColor }]}>
              {filtersApplied.join(', ')}
            </Text>
          </View>
        )}

        {/* Post button — full-width pill */}
        <TouchableOpacity
          style={[styles.postBtn, { backgroundColor: theme.colors.themeColor, opacity: posting ? 0.6 : 1 }]}
          onPress={handlePost}
          disabled={posting}
          activeOpacity={0.85}
        >
          {posting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Text style={styles.postBtnText}>Share to your story</Text>
              <Ionicons name="arrow-forward" size={20} color="#fff" />
            </>
          )}
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
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
  postingEyebrow: { ...STATUS_TYPE.caps, color: 'rgba(255,255,255,0.55)', marginBottom: 6 },
  postingTitle:   { ...STATUS_TYPE.title, color: '#fff', marginBottom: 22, textAlign: 'center' },
  progressBarTrack: {
    width: '100%', height: 6, borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%', borderRadius: 3,
    backgroundColor: '#fff',
  },
  postingPercent: { color: '#fff', fontSize: 13, fontWeight: '600', marginTop: 10, opacity: 0.85 },
  cancelUploadBtn: {
    marginTop: 22,
    paddingVertical: 10, paddingHorizontal: 22,
    borderRadius: STATUS_RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.45)',
  },
  cancelUploadText: { color: '#fff', fontSize: 13, fontWeight: '600', letterSpacing: 0.3 },

  // ── Editorial header ──────────────────────────────────────────────────────
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: STATUS_SPACE.gutter,
    paddingTop: STATUS_SPACE.sm, paddingBottom: STATUS_SPACE.md,
    gap: 14,
  },
  backBtn:        { padding: 4, marginLeft: -4 },
  headerEyebrow:  { ...STATUS_TYPE.caps, marginBottom: 2 },
  headerTitle:    { ...STATUS_TYPE.title, fontWeight: '400' },
  headerCounter:  {
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: STATUS_RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  headerCounterText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },

  // ── Preview area ──────────────────────────────────────────────────────────
  previewArea: { height: 320, backgroundColor: '#000', position: 'relative' },
  previewMedia:{ width: SW, height: 320 },
  textPreview: { width: SW, height: 320, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 28 },
  textPreviewBody: { color: '#fff', fontSize: 24, fontWeight: '600', textAlign: 'center', lineHeight: 32 },
  textOverlayBadge:{ position: 'absolute', top: '35%', left: 20, right: 20, alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.4)', padding: 8, borderRadius: 8 },
  textOverlayText: { color: '#fff', fontSize: 20, fontWeight: '700', textAlign: 'center' },

  // ── Link preview card ─────────────────────────────────────────────────────
  linkPreview: { flex: 1, justifyContent: 'center', alignItems: 'stretch' },
  ogImage:     { width: '100%', height: 170 },
  ogBody:      { padding: 18, width: '100%' },
  ogTitle:     { ...STATUS_TYPE.title, fontSize: 17, lineHeight: 22, marginBottom: 6 },
  ogDesc:      { ...STATUS_TYPE.body, fontSize: 13, marginBottom: 6 },
  ogSite:      { ...STATUS_TYPE.caps, marginBottom: 4 },
  ogUrl:       { fontSize: 12, fontWeight: '600' },

  // ── Dots ──────────────────────────────────────────────────────────────────
  dotRow:      { position: 'absolute', bottom: 10, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 6 },
  dot:         { width: 6, height: 6, borderRadius: 3 },
  dotActive:   { backgroundColor: '#fff', width: 18 },
  dotInactive: { backgroundColor: 'rgba(255,255,255,0.4)' },

  // ── Settings panel ────────────────────────────────────────────────────────
  panel:        { flex: 1 },
  section:      { paddingHorizontal: STATUS_SPACE.gutter, paddingTop: 22 },
  sectionLabel: { ...STATUS_TYPE.caps, marginBottom: 12 },
  captionHead:    { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  captionCounter: { ...STATUS_TYPE.meta, fontSize: 11, marginBottom: 12 },
  captionInput: {
    borderRadius: STATUS_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, lineHeight: 22,
    minHeight: 84, textAlignVertical: 'top',
  },

  // ── Visibility — card-style ───────────────────────────────────────────────
  visibilityRow:     { gap: 10 },
  visibilityChipRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  visibilityCheck:   { marginLeft: 'auto' },
  visibilityHint:    { ...STATUS_TYPE.meta, marginTop: 6, marginLeft: 26 },
  visibilityChip:    {
    paddingHorizontal: 16, paddingVertical: 14,
    borderRadius: STATUS_RADIUS.md, borderWidth: StyleSheet.hairlineWidth,
  },
  visibilityLabel:   { fontSize: 15, fontWeight: '600' },
  filtersSummary:    { fontSize: 13, textTransform: 'capitalize' },

  // ── Post button — full-width pill ─────────────────────────────────────────
  postBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginHorizontal: STATUS_SPACE.gutter, marginTop: 28,
    borderRadius: STATUS_RADIUS.pill, paddingVertical: 16, gap: 10,
    shadowColor: STATUS_ACCENT, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.18, shadowRadius: 14,
    elevation: 4,
  },
  postBtnText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },
});
