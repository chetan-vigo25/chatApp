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
import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, Image, TouchableOpacity, StyleSheet,
  ScrollView, TextInput, ActivityIndicator, Alert,
  Platform, FlatList, Dimensions,
} from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useDispatch } from 'react-redux';
import { createStatus } from '../../Redux/Reducer/Status/Status.reducer';
import { statusServices } from '../../Redux/Services/Status/Status.Services';
import { useTheme } from '../../contexts/ThemeContext';

const { width: SW } = Dimensions.get('window');

// Backend enum: ['all', 'contacts', 'except', 'only']
const VISIBILITY_OPTIONS = [
  { id: 'contacts', label: 'My Contacts', icon: 'people-outline' },
  { id: 'all',      label: 'Everyone',    icon: 'globe-outline' },
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

  const [caption, setCaption]       = useState(initialCaption);
  const [visibility, setVisibility] = useState(initialVisibility);
  const [posting, setPosting]       = useState(false);
  const [progress, setProgress]     = useState({ current: 0, total: items.length || 1 });
  const [currentPreview, setCurrentPreview] = useState(0);
  const flatRef = useRef(null);

  const totalItems = items.length;

  // ── Upload + create ──────────────────────────────────────────────────────
  const handlePost = useCallback(async () => {
    setPosting(true);
    try {
      if (statusType === 'text') {
        // Backend expects: textContent, bgColor (NOT text / backgroundColor)
        await dispatch(createStatus({
          textContent,
          bgColor: backgroundColor,
          caption: caption.trim() || null,
          visibility,
        })).unwrap();
      } else if (statusType === 'link') {
        // Link — send as textContent with ogMetadata so the backend stores it
        await dispatch(createStatus({
          textContent: linkUrl,
          ogMetadata: ogData || null,
          caption: caption.trim() || null,
          visibility,
        })).unwrap();
      } else {
        // Media — upload each item then send assembled mediaItems[]
        const mediaItems = [];
        for (let i = 0; i < items.length; i++) {
          setProgress({ current: i + 1, total: items.length });
          const item = items[i];
          const ext  = item.uri.split('.').pop()?.split('?')[0] || (item.type === 'video' ? 'mp4' : 'jpg');
          const fd   = new FormData();
          fd.append('files', {
            uri:  item.uri,
            name: `status_${Date.now()}_${i}.${ext}`,
            type: item.mimeType || (item.type === 'video' ? `video/${ext}` : `image/${ext}`),
          });

          const uploadRes = await statusServices.uploadStatusMedia(fd);
          // uploadMediaBatch returns an array via Promise.all; unwrap the first element
          const rawData   = uploadRes?.data;
          const media     = Array.isArray(rawData) ? rawData[0] : rawData;

          if (!media) throw new Error(`Upload failed for item ${i + 1}`);

          // Backend mediaItem schema fields: mediaType, mediaUrl, thumbnailUrl, duration, width, height
          mediaItems.push({
            mediaType:       item.type,
            mediaUrl:        media.mediaUrl || media.url,
            thumbnailUrl:    media.thumbnailUrl || null,
            duration:        media.duration || item.duration || null,
            width:           media.width  || item.width  || 0,
            height:          media.height || item.height || 0,
          });
        }

        await dispatch(createStatus({
          mediaItems,
          caption: caption.trim() || null,
          visibility,
        })).unwrap();
      }

      // Navigate back to StatusList tab
      navigation.reset({
        index: 0,
        routes: [{ name: 'ChatList' }],
      });
    } catch (err) {
      Alert.alert('Failed to post', err?.message || 'Please try again.');
    } finally {
      setPosting(false);
    }
  }, [
    statusType, textContent, backgroundColor, linkUrl, ogData,
    items, caption, visibility, filtersApplied, dispatch, navigation,
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

  const renderLinkPreview = () => (
    <View style={[styles.linkPreview, { backgroundColor: theme.colors.surface }]}>
      {ogData?.imageUrl && (
        <Image source={{ uri: ogData.imageUrl }} style={styles.ogImage} resizeMode="cover" />
      )}
      <View style={styles.ogBody}>
        <MaterialCommunityIcons name="link-variant" size={16} color={theme.colors.themeColor} style={{ marginBottom: 4 }} />
        <Text style={[styles.ogTitle, { color: theme.colors.primaryTextColor }]} numberOfLines={2}>{ogData?.title || linkUrl}</Text>
        {ogData?.description ? (
          <Text style={[styles.ogDesc, { color: theme.colors.placeHolderTextColor }]} numberOfLines={2}>{ogData.description}</Text>
        ) : null}
        <Text style={[styles.ogUrl, { color: theme.colors.themeColor }]} numberOfLines={1}>{ogData?.url || linkUrl}</Text>
      </View>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* ── Posting overlay ── */}
      {posting && (
        <View style={styles.postingOverlay}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.postingText}>
            Posting{totalItems > 1 ? ` (${progress.current}/${progress.total})` : ''}…
          </Text>
        </View>
      )}

      {/* ── Header ── */}
      <View style={[styles.header, { backgroundColor: theme.colors.background }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={theme.colors.themeColor} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[styles.headerTitle, { color: theme.colors.primaryTextColor }]}>
            Preview
          </Text>
          {totalItems > 1 && (
            <Text style={[styles.headerSub, { color: theme.colors.placeHolderTextColor }]}>
              {currentPreview + 1} of {totalItems}
            </Text>
          )}
        </View>
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
          <Text style={[styles.sectionLabel, { color: theme.colors.placeHolderTextColor }]}>CAPTION</Text>
          <TextInput
            style={[styles.captionInput, { backgroundColor: theme.colors.surface, color: theme.colors.primaryTextColor, borderColor: theme.colors.border }]}
            placeholder="Write a caption…"
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
            {VISIBILITY_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.id}
                style={[
                  styles.visibilityChip,
                  { borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
                  visibility === opt.id && { borderColor: theme.colors.themeColor, backgroundColor: `${theme.colors.themeColor}22` },
                ]}
                onPress={() => setVisibility(opt.id)}
              >
                <Ionicons
                  name={opt.icon}
                  size={16}
                  color={visibility === opt.id ? theme.colors.themeColor : theme.colors.placeHolderTextColor}
                />
                <Text
                  style={[
                    styles.visibilityLabel,
                    { color: visibility === opt.id ? theme.colors.themeColor : theme.colors.placeHolderTextColor },
                  ]}
                >
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
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

        {/* Post button */}
        <TouchableOpacity
          style={[styles.postBtn, { backgroundColor: theme.colors.themeColor, opacity: posting ? 0.6 : 1 }]}
          onPress={handlePost}
          disabled={posting}
        >
          {posting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons name="checkmark-circle-outline" size={22} color="#fff" />
              <Text style={styles.postBtnText}>Post Status</Text>
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

  // Posting overlay
  postingOverlay: {
    ...StyleSheet.absoluteFillObject, zIndex: 999,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center', alignItems: 'center', gap: 14,
  },
  postingText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingBottom: 12,
  },
  backBtn:    { marginRight: 14 },
  headerTitle:{ fontSize: 18, fontWeight: '700' },
  headerSub:  { fontSize: 12, marginTop: 1 },

  // Preview area
  previewArea: { height: 280, backgroundColor: '#000', position: 'relative' },
  previewMedia:{ width: SW, height: 280 },
  textPreview: { width: SW, height: 280, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 },
  textPreviewBody: { color: '#fff', fontSize: 22, fontWeight: '600', textAlign: 'center' },
  textOverlayBadge:{ position: 'absolute', top: '35%', left: 20, right: 20, alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.4)', padding: 8, borderRadius: 8 },
  textOverlayText: { color: '#fff', fontSize: 20, fontWeight: '700', textAlign: 'center' },

  // Link preview
  linkPreview: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  ogImage:     { width: '100%', height: 150 },
  ogBody:      { padding: 14, width: '100%' },
  ogTitle:     { fontSize: 15, fontWeight: '700', marginBottom: 4 },
  ogDesc:      { fontSize: 12, marginBottom: 4 },
  ogUrl:       { fontSize: 11 },

  // Dot indicators
  dotRow:      { position: 'absolute', bottom: 8, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 5 },
  dot:         { width: 7, height: 7, borderRadius: 4 },
  dotActive:   { backgroundColor: '#fff' },
  dotInactive: { backgroundColor: 'rgba(255,255,255,0.4)' },

  // Settings panel
  panel: { flex: 1 },
  section: { paddingHorizontal: 16, paddingTop: 18 },
  sectionLabel: { fontSize: 11, fontWeight: '600', letterSpacing: 0.6, marginBottom: 8 },
  captionInput: {
    borderRadius: 12, borderWidth: 1, padding: 12,
    fontSize: 15, minHeight: 70, textAlignVertical: 'top',
  },
  visibilityRow:  { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  visibilityChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: 20, borderWidth: 1.5,
  },
  visibilityLabel: { fontSize: 13, fontWeight: '600' },
  filtersSummary:  { fontSize: 13, textTransform: 'capitalize' },

  // Post button
  postBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    margin: 16, borderRadius: 14, paddingVertical: 14, gap: 8,
  },
  postBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
