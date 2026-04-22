/**
 * StatusCustomise
 * Per-item editing step for media statuses.
 *
 * Capabilities by type:
 *   image  — filter strip (tint overlays), rotate, text overlay, caption
 *   video  — mute toggle, caption
 *   link   — OG preview fetch + caption
 *
 * Route params (from StatusCreate):
 *   items[]     — [{ uri, type, width, height, duration, mimeType }]
 *   statusType? — 'link' | undefined (for link-only flow)
 *   linkUrl?    — string (for link-only flow)
 *
 * Navigates to StatusPreview with assembled payload.
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, Image, TouchableOpacity, StyleSheet,
  ScrollView, TextInput, Platform, Alert, ActivityIndicator,
  Dimensions, Switch,
} from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';

const { width: SW } = Dimensions.get('window');

// ── Filter definitions ─────────────────────────────────────────────────────
const FILTERS = [
  { id: 'none',     label: 'Original', tint: null },
  { id: 'warm',     label: 'Warm',     tint: 'rgba(255,160,50,0.25)' },
  { id: 'cool',     label: 'Cool',     tint: 'rgba(50,130,255,0.25)' },
  { id: 'mono',     label: 'Mono',     tint: 'rgba(120,120,120,0.45)' },
  { id: 'vintage',  label: 'Vintage',  tint: 'rgba(180,120,60,0.3)'  },
  { id: 'fade',     label: 'Fade',     tint: 'rgba(220,220,220,0.3)' },
  { id: 'vivid',    label: 'Vivid',    tint: 'rgba(255,50,50,0.15)'  },
  { id: 'dramatic', label: 'Drama',    tint: 'rgba(0,0,0,0.3)'       },
];

// ── Filter thumbnail ──────────────────────────────────────────────────────
function FilterThumb({ uri, filter, selected, onPress }) {
  return (
    <TouchableOpacity style={[styles.filterThumbWrap, selected && styles.filterThumbSelected]} onPress={onPress} activeOpacity={0.8}>
      <View style={styles.filterThumbFrame}>
        <Image source={{ uri }} style={styles.filterThumbImg} resizeMode="cover" />
        {filter.tint && <View style={[StyleSheet.absoluteFill, { backgroundColor: filter.tint }]} />}
      </View>
      <Text style={[styles.filterLabel, selected && styles.filterLabelSelected]}>{filter.label}</Text>
    </TouchableOpacity>
  );
}

// ── OG preview fetch ────────────────────────────────────────────────────────
async function fetchOgPreview(url) {
  try {
    const res  = await fetch(`https://api.microlink.io?url=${encodeURIComponent(url)}&screenshot=false&meta=true`);
    const json = await res.json();
    if (json.status === 'success') {
      return {
        title:       json.data?.title || url,
        description: json.data?.description || '',
        imageUrl:    json.data?.image?.url || null,
        url:         json.data?.url || url,
      };
    }
  } catch {
    // Silently fail — user still proceeds with plain URL
  }
  return { title: url, description: '', imageUrl: null, url };
}

// ── Main component ────────────────────────────────────────────────────────────

export default function StatusCustomise({ navigation, route }) {
  const { theme } = useTheme();
  const {
    items = [],
    statusType,
    linkUrl,
  } = route.params || {};

  const isLink    = statusType === 'link';
  const totalItems = items.length;

  // Per-item state (index-keyed)
  const [selectedIndex, setSelectedIndex]   = useState(0);
  const [filters, setFilters]               = useState({});    // { [i]: filterId }
  const [captions, setCaptions]             = useState({});    // { [i]: string }
  const [textOverlays, setTextOverlays]     = useState({});    // { [i]: string }
  const [muted, setMuted]                   = useState({});    // { [i]: bool }

  // Link-specific
  const [ogData, setOgData]         = useState(null);
  const [ogLoading, setOgLoading]   = useState(false);
  const [linkCaption, setLinkCaption] = useState('');

  const currentItem   = items[selectedIndex];
  const currentFilter = FILTERS.find(f => f.id === (filters[selectedIndex] || 'none')) || FILTERS[0];
  const currentCaption = captions[selectedIndex] || '';
  const currentOverlay = textOverlays[selectedIndex] || '';

  // ── Fetch OG on mount if link ─────────────────────────────────────────
  useEffect(() => {
    if (!isLink || !linkUrl) return;
    setOgLoading(true);
    fetchOgPreview(linkUrl).then(data => {
      setOgData(data);
      setOgLoading(false);
    });
  }, [isLink, linkUrl]);

  // ── Assemble payload and go to Preview ───────────────────────────────────
  const handleNext = useCallback(() => {
    if (isLink) {
      navigation.navigate('StatusPreview', {
        items: [],
        statusType: 'link',
        linkUrl,
        ogData,
        caption: linkCaption.trim(),
        filtersApplied: [],
        visibility: 'contacts',
      });
      return;
    }

    const assembledItems = items.map((item, i) => ({
      ...item,
      filterId:    filters[i] || 'none',
      filterTint:  (FILTERS.find(f => f.id === (filters[i] || 'none')) || FILTERS[0]).tint,
      caption:     captions[i] || '',
      textOverlay: textOverlays[i] || '',
      muted:       muted[i] || false,
    }));

    navigation.navigate('StatusPreview', {
      items: assembledItems,
      statusType: assembledItems[0]?.type || 'image',
      caption: captions[0] || '',
      filtersApplied: assembledItems.map(it => it.filterId).filter(f => f !== 'none'),
      visibility: 'contacts',
    });
  }, [items, filters, captions, textOverlays, muted, isLink, linkUrl, ogData, linkCaption, navigation]);

  // ── Link layout ──────────────────────────────────────────────────────────
  if (isLink) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <Header onBack={() => navigation.goBack()} onNext={handleNext} title="Customise" />

        <ScrollView contentContainerStyle={styles.linkScroll}>
          {ogLoading ? (
            <ActivityIndicator color={theme.colors.themeColor} style={{ marginTop: 40 }} size="large" />
          ) : ogData ? (
            <View style={[styles.ogCard, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
              {ogData.imageUrl && (
                <Image source={{ uri: ogData.imageUrl }} style={styles.ogImage} resizeMode="cover" />
              )}
              <View style={styles.ogBody}>
                <Text style={[styles.ogTitle, { color: theme.colors.primaryTextColor }]} numberOfLines={2}>
                  {ogData.title}
                </Text>
                {ogData.description ? (
                  <Text style={[styles.ogDesc, { color: theme.colors.placeHolderTextColor }]} numberOfLines={3}>
                    {ogData.description}
                  </Text>
                ) : null}
                <Text style={[styles.ogUrl, { color: theme.colors.themeColor }]} numberOfLines={1}>
                  {ogData.url}
                </Text>
              </View>
            </View>
          ) : (
            <View style={[styles.ogCard, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
              <View style={styles.ogBody}>
                <Text style={[styles.ogTitle, { color: theme.colors.primaryTextColor }]}>{linkUrl}</Text>
              </View>
            </View>
          )}

          <TextInput
            style={[styles.captionInput, { backgroundColor: theme.colors.surface, color: theme.colors.primaryTextColor, borderColor: theme.colors.border }]}
            placeholder="Add a caption…"
            placeholderTextColor={theme.colors.placeHolderTextColor}
            value={linkCaption}
            onChangeText={setLinkCaption}
            maxLength={500}
            multiline
          />
        </ScrollView>
      </View>
    );
  }

  // ── Media layout ──────────────────────────────────────────────────────────

  return (
    <View style={[styles.container, { backgroundColor: '#000' }]}>
      <Header
        onBack={() => navigation.goBack()}
        onNext={handleNext}
        title={totalItems > 1 ? `${selectedIndex + 1} / ${totalItems}` : 'Customise'}
        dark
      />

      {/* Preview */}
      <View style={styles.preview}>
        {currentItem?.type === 'video' ? (
          <Video
            source={{ uri: currentItem.uri }}
            style={styles.previewMedia}
            resizeMode={ResizeMode.CONTAIN}
            shouldPlay
            isLooping
            isMuted={muted[selectedIndex] || false}
            useNativeControls={false}
          />
        ) : currentItem?.uri ? (
          <Image source={{ uri: currentItem.uri }} style={styles.previewMedia} resizeMode="contain" />
        ) : null}

        {/* Filter tint overlay */}
        {currentFilter.tint && (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: currentFilter.tint, pointerEvents: 'none' }]} />
        )}

        {/* Text overlay badge */}
        {currentOverlay ? (
          <View style={styles.textOverlayBadge}>
            <Text style={styles.textOverlayText}>{currentOverlay}</Text>
          </View>
        ) : null}
      </View>

      {/* Caption input (floated above the toolbar) */}
      <TextInput
        style={styles.floatCaption}
        placeholder="Add a caption…"
        placeholderTextColor="rgba(255,255,255,0.5)"
        value={currentCaption}
        onChangeText={v => setCaptions(c => ({ ...c, [selectedIndex]: v }))}
        maxLength={500}
      />

      {/* Toolbar */}
      <View style={styles.toolbar}>
        {/* Mute (video only) */}
        {currentItem?.type === 'video' && (
          <TouchableOpacity
            style={styles.toolBtn}
            onPress={() => setMuted(m => ({ ...m, [selectedIndex]: !m[selectedIndex] }))}
          >
            <Ionicons
              name={muted[selectedIndex] ? 'volume-mute' : 'volume-high'}
              size={22}
              color="#fff"
            />
            <Text style={styles.toolLabel}>Mute</Text>
          </TouchableOpacity>
        )}

        {/* Text overlay */}
        {currentItem?.type === 'image' && (
          <TouchableOpacity
            style={styles.toolBtn}
            onPress={() => {
              Alert.prompt
                ? Alert.prompt('Add text overlay', '', v => setTextOverlays(t => ({ ...t, [selectedIndex]: v })))
                : Alert.alert('Text overlay', 'Use the caption field below for text.');
            }}
          >
            <MaterialCommunityIcons name="format-text" size={22} color="#fff" />
            <Text style={styles.toolLabel}>Text</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Filter strip (images only) */}
      {currentItem?.type === 'image' && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterStrip} contentContainerStyle={styles.filterStripContent}>
          {FILTERS.map(f => (
            <FilterThumb
              key={f.id}
              uri={currentItem.uri}
              filter={f}
              selected={(filters[selectedIndex] || 'none') === f.id}
              onPress={() => setFilters(prev => ({ ...prev, [selectedIndex]: f.id }))}
            />
          ))}
        </ScrollView>
      )}

      {/* Slide selector (multi-item) */}
      {totalItems > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.thumbStrip} contentContainerStyle={styles.thumbStripContent}>
          {items.map((item, i) => (
            <TouchableOpacity key={i} onPress={() => setSelectedIndex(i)} activeOpacity={0.8}>
              <View style={[styles.thumb, selectedIndex === i && styles.thumbSelected]}>
                <Image source={{ uri: item.uri }} style={styles.thumbImg} resizeMode="cover" />
                {item.type === 'video' && (
                  <View style={styles.thumbVideo}>
                    <Ionicons name="videocam" size={10} color="#fff" />
                  </View>
                )}
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

// ── Header sub-component ──────────────────────────────────────────────────────

function Header({ onBack, onNext, title, dark }) {
  const { theme } = useTheme();
  const textColor = dark ? '#fff' : theme.colors.primaryTextColor;
  const bg        = dark ? 'rgba(0,0,0,0.5)' : theme.colors.background;

  return (
    <View style={[styles.header, { backgroundColor: bg }]}>
      <TouchableOpacity onPress={onBack} style={styles.headerBack}>
        <Ionicons name="arrow-back" size={24} color={dark ? '#fff' : theme.colors.themeColor} />
      </TouchableOpacity>
      <Text style={[styles.headerTitle, { color: textColor }]}>{title}</Text>
      <TouchableOpacity onPress={onNext} style={[styles.headerNext, { backgroundColor: dark ? 'rgba(255,255,255,0.18)' : theme.colors.themeColor }]}>
        <Text style={[styles.headerNextText, { color: dark ? '#fff' : '#fff' }]}>Next</Text>
        <Ionicons name="arrow-forward" size={18} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const THUMB_SIZE = 58;
const FILTER_SIZE = 68;

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12,
    paddingTop: Platform.OS === 'ios' ? 0 : 0, paddingBottom: 10,
  },
  headerBack:     { padding: 6, marginRight: 8 },
  headerTitle:    { flex: 1, fontSize: 17, fontWeight: '700', textAlign: 'center' },
  headerNext:     { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20 },
  headerNextText: { fontSize: 15, fontWeight: '600' },

  // Preview
  preview:      { flex: 1, position: 'relative' },
  previewMedia: { flex: 1, width: '100%' },

  // Float caption
  floatCaption: {
    position: 'absolute',
    bottom: Platform.OS === 'ios' ? 170 : 150,
    left: 16, right: 16,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8,
    color: '#fff', fontSize: 14,
  },

  // Text overlay
  textOverlayBadge: {
    position: 'absolute', top: '40%', left: 20, right: 20,
    alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.4)', padding: 10, borderRadius: 8,
  },
  textOverlayText: { color: '#fff', fontSize: 22, fontWeight: '700', textAlign: 'center' },

  // Toolbar
  toolbar: { flexDirection: 'row', padding: 10, gap: 20, justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.5)' },
  toolBtn:  { alignItems: 'center', gap: 3 },
  toolLabel:{ color: '#fff', fontSize: 11 },

  // Filter strip
  filterStrip:        { backgroundColor: 'rgba(0,0,0,0.6)', maxHeight: 100 },
  filterStripContent: { paddingHorizontal: 10, paddingVertical: 8, gap: 8, alignItems: 'center' },
  filterThumbWrap:    { alignItems: 'center', gap: 4 },
  filterThumbSelected:{ opacity: 1 },
  filterThumbFrame:   { width: FILTER_SIZE, height: FILTER_SIZE, borderRadius: 8, overflow: 'hidden', position: 'relative' },
  filterThumbImg:     { width: FILTER_SIZE, height: FILTER_SIZE },
  filterLabel:        { color: 'rgba(255,255,255,0.6)', fontSize: 10 },
  filterLabelSelected:{ color: '#fff', fontWeight: '700' },

  // Thumb strip
  thumbStrip:        { backgroundColor: 'rgba(0,0,0,0.7)', maxHeight: THUMB_SIZE + 16 },
  thumbStripContent: { paddingHorizontal: 8, paddingVertical: 8, gap: 6, alignItems: 'center' },
  thumb:             { width: THUMB_SIZE, height: THUMB_SIZE, borderRadius: 8, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' },
  thumbSelected:     { borderColor: '#8B5CF6' },
  thumbImg:          { width: '100%', height: '100%' },
  thumbVideo:        { position: 'absolute', top: 3, right: 3, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 3, padding: 2 },

  // Link
  linkScroll:  { padding: 16, gap: 16 },
  ogCard:      { borderRadius: 16, overflow: 'hidden', borderWidth: 1 },
  ogImage:     { width: '100%', height: 180 },
  ogBody:      { padding: 14 },
  ogTitle:     { fontSize: 16, fontWeight: '700', marginBottom: 4 },
  ogDesc:      { fontSize: 13, marginBottom: 6 },
  ogUrl:       { fontSize: 12 },
  captionInput:{ borderRadius: 12, borderWidth: 1, padding: 12, fontSize: 15, minHeight: 80, textAlignVertical: 'top' },
});
