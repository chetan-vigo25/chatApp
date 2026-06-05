/**
 * StatusCreate — entry screen for creating a new status.
 *
 * Modes:
 *   null   → mode picker (Camera / Gallery / Text / Link)
 *   camera → launch camera directly
 *   gallery → ImagePicker multi-select (up to 10)
 *   text    → inline text composer
 *   link    → link URL input
 *
 * After capturing/selecting, navigates to StatusCustomise for editing,
 * then StatusPreview for the final post step.
 *
 * Text statuses skip Customise and go directly to StatusPreview.
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, TextInput,
  ScrollView, ActivityIndicator, Alert,
  FlatList, Image, Dimensions, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons, MaterialCommunityIcons, FontAwesome5 } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import useStatusSettings from '../../hooks/useStatusSettings';
import { suspendAppLock, resumeAppLock } from '../../services/appLockGuard';

const { width: SCREEN_W } = Dimensions.get('window');
const GRID_COLS = 3;
const GRID_GAP = 2;
const CELL = Math.floor((SCREEN_W - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS);

// mm:ss for the video-duration badge.
function fmtDuration(secs) {
  const s = Math.max(0, Math.round(Number(secs) || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

const BG_COLORS = [
  '#075e54', '#128C7E', '#25D366', '#FF6B6B',
  '#C44569', '#F8B500', '#6C5CE7', '#00B894',
  '#2d3436', '#e17055', '#0984e3', '#fd79a8',
];
const MAX_FILES = 10;

// Normalize an ImagePicker asset into our internal item shape.
function normaliseAsset(a) {
  return {
    uri:       a.uri,
    type:      a.type === 'video' ? 'video' : 'image',
    width:     a.width,
    height:    a.height,
    duration:  a.duration || null,
    fileSize:  a.fileSize || a.size || null,
    mimeType:  a.mimeType || (a.type === 'video' ? 'video/mp4' : 'image/jpeg'),
  };
}

export default function StatusCreate({ navigation, route }) {
  const { theme, isDarkMode } = useTheme();
  const initialMode = route?.params?.type || null;
  const { validateMediaList, limits } = useStatusSettings();

  const [mode, setMode]       = useState(initialMode);
  const [text, setText]       = useState('');
  const [bgColor, setBgColor] = useState(BG_COLORS[0]);
  const [linkUrl, setLinkUrl] = useState('');
  const [fetching, setFetching] = useState(false);

  // Device gallery for the WhatsApp-style picker.
  const [permission, requestPermission] = MediaLibrary.usePermissions();
  const [recents, setRecents] = useState([]);
  const [loadingRecents, setLoadingRecents] = useState(false);
  // Album (folder) filtering — Recents / Camera / Videos / Screenshots / …
  const [albums, setAlbums] = useState([]);            // [{ id, title, count, cover }]
  const [selectedAlbum, setSelectedAlbum] = useState({ id: null, title: 'Recents' });
  const [albumPickerOpen, setAlbumPickerOpen] = useState(false);

  // ── Camera ──────────────────────────────────────────────────────────────
  const launchCamera = useCallback(async () => {
    // Opening the camera backgrounds the app — keep the 2-step app lock from
    // re-locking when we come back.
    suspendAppLock();
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return Alert.alert('Permission needed', 'Please allow camera access');

      // Pre-cap video recording length to the configured limit so the OS
      // won't even capture a video that we'd have to reject afterwards.
      const result = await ImagePicker.launchCameraAsync({
        quality: 0.85,
        allowsEditing: false,
        videoMaxDuration: limits.maxVideoSecs,
      });
      if (result.canceled || !result.assets?.[0]) return;

      const item = normaliseAsset(result.assets[0]);
      const check = validateMediaList([item]);
      if (!check.ok) return Alert.alert('Cannot use this media', check.message);

      navigation.navigate('StatusCustomise', { items: [item] });
    } catch (err) {
      Alert.alert('Camera error', err?.message || 'Could not open camera');
    } finally {
      resumeAppLock();
    }
  }, [navigation, limits.maxVideoSecs, validateMediaList]);

  // Ensure we have photo-library permission, prompting if needed. Returns true
  // when access is granted (full or limited).
  const ensurePerm = useCallback(async () => {
    if (permission?.granted) return true;
    const res = await requestPermission();
    return !!(res?.granted || res?.status === 'granted');
  }, [permission, requestPermission]);

  // Load assets for the grid. `album = null` → all recent media; otherwise the
  // assets inside that device album/folder.
  const loadAssets = useCallback(async (album) => {
    setLoadingRecents(true);
    try {
      if (!(await ensurePerm())) { setRecents([]); return; }
      const page = await MediaLibrary.getAssetsAsync({
        first: 120,
        mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
        ...(album?.id ? { album: album.id } : {}),
      });
      setRecents(page.assets || []);
    } catch (err) {
      setRecents([]);
    } finally {
      setLoadingRecents(false);
    }
  }, [ensurePerm]);

  // Load the device albums (folders) + a cover thumbnail and count for each,
  // so the dropdown can mirror WhatsApp's "Recents / Camera / Videos / …" list.
  const loadAlbums = useCallback(async () => {
    try {
      if (!(await ensurePerm())) return;
      const raw = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
      const withAssets = (raw || []).filter(a => (a.assetCount || 0) > 0);
      // Largest albums first (Camera, Screenshots, … bubble to the top).
      withAssets.sort((a, b) => (b.assetCount || 0) - (a.assetCount || 0));
      const enriched = await Promise.all(
        withAssets.map(async (a) => {
          let cover = null;
          try {
            const page = await MediaLibrary.getAssetsAsync({
              first: 1, album: a.id,
              mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
              sortBy: [[MediaLibrary.SortBy.creationTime, false]],
            });
            cover = page.assets?.[0]?.uri || null;
          } catch {}
          return { id: a.id, title: a.title, count: a.assetCount || 0, cover };
        })
      );
      setAlbums(enriched);
    } catch {}
  }, [ensurePerm]);

  // Load whenever the picker is shown / re-focused or the album changes.
  useEffect(() => {
    if (!mode) {
      loadAssets(selectedAlbum);
      loadAlbums();
    }
  }, [mode, selectedAlbum, loadAssets, loadAlbums]);

  // Re-load on screen focus too (e.g. after the user grants access in Settings).
  useFocusEffect(
    useCallback(() => {
      if (!mode) {
        loadAssets(selectedAlbum);
        loadAlbums();
      }
    }, [mode, selectedAlbum, loadAssets, loadAlbums])
  );

  const onSelectAlbum = useCallback((album) => {
    setAlbumPickerOpen(false);
    setSelectedAlbum(album);
  }, []);

  // Pick an asset from the in-app grid → resolve a usable local URI, validate,
  // then continue to the editor.
  const onPickAsset = useCallback(async (asset) => {
    suspendAppLock();
    try {
      let uri = asset.uri;
      // iOS ph:// URIs aren't directly usable — resolve the real localUri.
      if (Platform.OS === 'ios' || String(uri).startsWith('ph://')) {
        try {
          const info = await MediaLibrary.getAssetInfoAsync(asset);
          uri = info?.localUri || info?.uri || uri;
        } catch {}
      }
      const isVideo = asset.mediaType === MediaLibrary.MediaType.video || asset.mediaType === 'video';
      const item = {
        uri,
        type: isVideo ? 'video' : 'image',
        width: asset.width,
        height: asset.height,
        duration: asset.duration || null,
        fileSize: null,
        mimeType: isVideo ? 'video/mp4' : 'image/jpeg',
      };
      const check = validateMediaList([item]);
      if (!check.ok) return Alert.alert('Cannot use this media', check.message);
      navigation.navigate('StatusCustomise', { items: [item] });
    } catch (err) {
      Alert.alert('Error', err?.message || 'Could not open this item');
    } finally {
      resumeAppLock();
    }
  }, [navigation, validateMediaList]);

  // ── Gallery multi-select ─────────────────────────────────────────────────
  const launchGallery = useCallback(async () => {
    // Opening the gallery backgrounds the app — keep the 2-step app lock from
    // re-locking when we come back.
    suspendAppLock();
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return Alert.alert('Permission needed', 'Please allow media library access');

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        allowsMultipleSelection: true,
        selectionLimit: MAX_FILES,
        quality: 0.85,
        orderedSelection: true,
        videoMaxDuration: limits.maxVideoSecs,
      });
      if (result.canceled || !result.assets?.length) return;

      // De-dupe by URI (multi-select picker can return the same asset twice).
      const seen = new Set();
      const items = [];
      for (const a of result.assets) {
        const item = normaliseAsset(a);
        if (item.uri && !seen.has(item.uri)) {
          seen.add(item.uri);
          items.push(item);
        }
      }

      // Pre-validate every picked file against the backend-driven limits.
      // First failure short-circuits with a specific message.
      const check = validateMediaList(items);
      if (!check.ok) return Alert.alert('Cannot use this media', check.message);

      navigation.navigate('StatusCustomise', { items });
    } catch (err) {
      Alert.alert('Gallery error', err?.message || 'Could not open gallery');
    } finally {
      resumeAppLock();
    }
  }, [navigation, limits.maxVideoSecs, validateMediaList]);

  // ── Text status — go straight to Preview ────────────────────────────────
  const submitText = useCallback(() => {
    if (!text.trim()) return Alert.alert('', 'Please type something');
    navigation.navigate('StatusPreview', {
      items: [],
      statusType: 'text',
      textContent: text.trim(),
      backgroundColor: bgColor,
      caption: '',
      filtersApplied: [],
      visibility: 'contacts',
    });
  }, [text, bgColor, navigation]);

  // ── Link status ──────────────────────────────────────────────────────────
  const submitLink = useCallback(async () => {
    if (!linkUrl.trim()) return Alert.alert('', 'Please enter a URL');
    const url = linkUrl.trim().startsWith('http') ? linkUrl.trim() : `https://${linkUrl.trim()}`;
    navigation.navigate('StatusCustomise', {
      items: [],
      statusType: 'link',
      linkUrl: url,
    });
  }, [linkUrl, navigation]);

  // ── Add status picker (WhatsApp-style) ────────────────────────────────────
  if (!mode) {
    const text2 = theme.colors.primaryTextColor;
    const sub = theme.colors.placeHolderTextColor;
    const cardBorder = isDarkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)';
    const cameraTileBg = isDarkMode ? '#0E1A22' : '#ECE7E1';

    const actionCards = [
      { key: 'text', label: 'Text', render: (c) => <MaterialCommunityIcons name="format-text" size={26} color={c} />, onPress: () => setMode('text') },
      { key: 'link', label: 'Link', render: (c) => <FontAwesome5 name="link" size={20} color={c} />, onPress: () => setMode('link') },
    ];

    const gridData = [{ _camera: true, id: '__camera__' }, ...recents];

    const renderCell = ({ item }) => {
      if (item._camera) {
        return (
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={launchCamera}
            style={[styles.cell, styles.cameraTile, { backgroundColor: cameraTileBg }]}
          >
            <Ionicons name="camera" size={26} color={theme.colors.themeColor} />
            <Text style={[styles.cameraTileLabel, { color: text2 }]}>Camera</Text>
          </TouchableOpacity>
        );
      }
      const isVideo = item.mediaType === MediaLibrary.MediaType.video || item.mediaType === 'video';
      return (
        <TouchableOpacity activeOpacity={0.85} onPress={() => onPickAsset(item)} style={styles.cell}>
          <Image source={{ uri: item.uri }} style={styles.cellImg} />
          {isVideo && (
            <View style={styles.videoBadge}>
              <Ionicons name="videocam" size={11} color="#fff" />
              <Text style={styles.videoBadgeText}>{fmtDuration(item.duration)}</Text>
            </View>
          )}
        </TouchableOpacity>
      );
    };

    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        {/* <SafeAreaView edges={['top']} /> */}
        {/* Header */}
        <View style={styles.addHeader}>
          <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close" size={26} color={text2} />
          </TouchableOpacity>
          <Text style={[styles.addHeaderTitle, { color: text2 }]}>Add status</Text>
          <View style={{ width: 26 }} />
        </View>

        {/* Quick-action cards */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.actionRow}
        >
          {actionCards.map((c) => (
            <TouchableOpacity
              key={c.key}
              activeOpacity={0.8}
              onPress={c.onPress}
              style={[styles.actionCard, { borderColor: cardBorder }]}
            >
              {c.render(theme.colors.themeColor)}
              <Text style={[styles.actionCardLabel, { color: text2 }]}>{c.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Album selector (Recents / Camera / Videos / Screenshots / …) */}
        <TouchableOpacity
          style={styles.albumSelector}
          activeOpacity={0.7}
          onPress={() => setAlbumPickerOpen(true)}
        >
          <Text style={[styles.recentsLabel, { color: sub }]} numberOfLines={1}>
            {selectedAlbum.title}
          </Text>
          <Ionicons name="chevron-down" size={16} color={sub} />
        </TouchableOpacity>

        <FlatList
          data={gridData}
          keyExtractor={(item) => (item._camera ? '__camera__' : String(item.id))}
          renderItem={renderCell}
          numColumns={GRID_COLS}
          columnWrapperStyle={{ gap: GRID_GAP }}
          contentContainerStyle={{ paddingBottom: 120, gap: GRID_GAP }}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            permission && !permission.granted ? (
              <TouchableOpacity
                onPress={async () => {
                  const res = await requestPermission();
                  if (res?.granted) { loadAssets(selectedAlbum); loadAlbums(); }
                }}
                style={styles.permRow}
                activeOpacity={0.7}
              >
                <Ionicons name="lock-closed-outline" size={16} color={sub} />
                <Text style={[styles.permText, { color: sub }]}>
                  Tap to allow photo access and show your gallery
                </Text>
              </TouchableOpacity>
            ) : loadingRecents && recents.length === 0 ? (
              <ActivityIndicator style={{ marginVertical: 24 }} color={theme.colors.themeColor} />
            ) : null
          }
        />

        {/* Floating folder button → full OS gallery picker */}
        <TouchableOpacity
          style={[styles.folderFab, { backgroundColor: isDarkMode ? theme.colors.surface : '#FFFFFF', borderColor: cardBorder }]}
          activeOpacity={0.85}
          onPress={launchGallery}
          accessibilityLabel="Open gallery"
        >
          <Ionicons name="albums-outline" size={22} color={text2} />
        </TouchableOpacity>

        {/* Album dropdown */}
        <Modal
          visible={albumPickerOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setAlbumPickerOpen(false)}
        >
          <TouchableOpacity
            style={styles.albumScrim}
            activeOpacity={1}
            onPress={() => setAlbumPickerOpen(false)}
          >
            <View style={[styles.albumSheet, { backgroundColor: isDarkMode ? theme.colors.surface : '#FFFFFF' }]}>
              <FlatList
                data={[{ id: null, title: 'Recents', count: recents.length, cover: recents[0]?.uri }, ...albums]}
                keyExtractor={(a) => String(a.id ?? '__recents__')}
                showsVerticalScrollIndicator={false}
                renderItem={({ item: a }) => {
                  const active = (selectedAlbum.id ?? null) === (a.id ?? null);
                  return (
                    <TouchableOpacity
                      style={styles.albumRow}
                      activeOpacity={0.7}
                      onPress={() => onSelectAlbum({ id: a.id, title: a.title })}
                    >
                      {a.cover
                        ? <Image source={{ uri: a.cover }} style={styles.albumCover} />
                        : <View style={[styles.albumCover, { backgroundColor: 'rgba(127,127,127,0.2)' }]} />}
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.albumTitle, { color: text2 }]} numberOfLines={1}>{a.title}</Text>
                        <Text style={[styles.albumCount, { color: sub }]} numberOfLines={1}>
                          {a.count != null ? `${a.count} items` : ''}
                        </Text>
                      </View>
                      {active && <Ionicons name="checkmark" size={20} color={theme.colors.themeColor} />}
                    </TouchableOpacity>
                  );
                }}
              />
            </View>
          </TouchableOpacity>
        </Modal>
      </View>
    );
  }

  // ── Text composer ────────────────────────────────────────────────────────
  if (mode === 'text') {
    return (
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.textScreen, { backgroundColor: bgColor }]}>
          {/* Header */}
          <View style={styles.textHeader}>
            <TouchableOpacity onPress={() => setMode(null)}>
              <Ionicons name="close" size={28} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.textHeaderTitle}>Text Status</Text>
            <TouchableOpacity
              style={[styles.nextBtn, { opacity: text.trim() ? 1 : 0.4 }]}
              onPress={submitText}
              disabled={!text.trim()}
            >
              <Text style={styles.nextBtnText}>Next</Text>
              <Ionicons name="arrow-forward" size={18} color="#fff" />
            </TouchableOpacity>
          </View>

          {/* Input */}
          <View style={styles.textInputArea}>
            <TextInput
              style={styles.textInput}
              placeholder="Type a status…"
              placeholderTextColor="rgba(255,255,255,0.45)"
              multiline
              autoFocus
              maxLength={700}
              value={text}
              onChangeText={setText}
            />
          </View>

          {/* Colour palette */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.palette}
            contentContainerStyle={styles.paletteContent}
          >
            {BG_COLORS.map(c => (
              <TouchableOpacity
                key={c}
                onPress={() => setBgColor(c)}
                style={[
                  styles.colorDot,
                  { backgroundColor: c },
                  bgColor === c && styles.colorDotActive,
                ]}
              />
            ))}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    );
  }

  // ── Link input ───────────────────────────────────────────────────────────
  if (mode === 'link') {
    return (
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
          <View style={styles.header}>
            <TouchableOpacity onPress={() => setMode(null)} style={styles.backBtn}>
              <Ionicons name="arrow-back" size={24} color={theme.colors.themeColor} />
            </TouchableOpacity>
            <Text style={[styles.headerTitle, { color: theme.colors.themeColor }]}>Share a Link</Text>
          </View>

          <View style={styles.linkContainer}>
            <View style={[styles.linkInputRow, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
              <FontAwesome5 name="link" size={16} color={theme.colors.placeHolderTextColor} style={{ marginRight: 10 }} />
              <TextInput
                style={[styles.linkInput, { color: theme.colors.primaryTextColor }]}
                placeholder="Paste a URL…"
                placeholderTextColor={theme.colors.placeHolderTextColor}
                value={linkUrl}
                onChangeText={setLinkUrl}
                autoFocus
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: theme.colors.themeColor, opacity: linkUrl.trim() ? 1 : 0.4 }]}
              onPress={submitLink}
              disabled={!linkUrl.trim() || fetching}
            >
              {fetching
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.primaryBtnText}>Preview Link</Text>
              }
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    );
  }

  return null;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingTop: Platform.OS === 'ios' ? 0 : 0,
    paddingBottom: 16, paddingHorizontal: 16,
    flexDirection: 'row', alignItems: 'center',
  },
  backBtn: { marginRight: 14 },
  headerTitle: { fontSize: 18, fontFamily: 'Roboto-Bold' },

  // ── Add status picker (WhatsApp-style) ─────────────────────────────────────
  addHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
  },
  addHeaderTitle: { flex: 1, textAlign: 'center', fontSize: 20, fontFamily: 'Roboto-Medium' },

  actionRow: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 16, gap: 12 },
  actionCard: {
    width: (SCREEN_W - 32 - 24) / 3,
    height: 92, borderRadius: 14, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  actionCardLabel: { fontSize: 14, fontFamily: 'Roboto-Medium' },

  albumSelector: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    alignSelf: 'flex-start',
    paddingRight: 16,
  },
  recentsLabel: {
    fontSize: 14, fontFamily: 'Roboto-Medium',
    paddingLeft: 16, paddingBottom: 10,
  },

  // Album dropdown
  albumScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  albumSheet: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 150 : 130,
    left: 0,
    width: '78%',
    maxHeight: '70%',
    borderTopRightRadius: 16, borderBottomRightRadius: 16,
    paddingVertical: 8,
    shadowColor: '#000', shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.3, shadowRadius: 12,
    elevation: 12,
  },
  albumRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 16, paddingVertical: 8,
  },
  albumCover: { width: 52, height: 52, borderRadius: 8 },
  albumTitle: { fontSize: 16, fontFamily: 'Roboto-Medium' },
  albumCount: { fontSize: 13, fontFamily: 'Roboto-Regular', marginTop: 2 },

  cell: { width: CELL, height: CELL, backgroundColor: 'rgba(127,127,127,0.12)' },
  cellImg: { width: '100%', height: '100%' },
  cameraTile: { alignItems: 'center', justifyContent: 'center', gap: 8 },
  cameraTileLabel: { fontSize: 13, fontFamily: 'Roboto-Medium' },

  videoBadge: {
    position: 'absolute', left: 6, bottom: 6,
    flexDirection: 'row', alignItems: 'center', gap: 3,
  },
  videoBadgeText: { color: '#fff', fontSize: 11, fontFamily: 'Roboto-Medium' },

  permRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 24, paddingTop: 30 },
  permText: { fontSize: 13, fontFamily: 'Roboto-Regular', textAlign: 'center' },

  folderFab: {
    position: 'absolute', right: 18, bottom: 28,
    width: 56, height: 56, borderRadius: 28, borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 8,
    elevation: 6,
  },

  // Text status
  textScreen:    { flex: 1 },
  textHeader:    {
    paddingTop: 50, paddingHorizontal: 20,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  textHeaderTitle: { color: '#fff', fontSize: 17, fontFamily: 'Roboto-Bold' },
  nextBtn:       { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.2)' },
  nextBtnText:   { color: '#fff', fontSize: 15, fontFamily: 'Roboto-SemiBold' },
  textInputArea: { flex: 1, justifyContent: 'center', paddingHorizontal: 30 },
  textInput:     { fontSize: 24, color: '#fff', textAlign: 'center', fontFamily: 'Roboto-Medium', maxHeight: 300 },
  palette:       { paddingBottom: 30 },
  paletteContent:{ paddingHorizontal: 20, gap: 10, alignItems: 'center' },
  colorDot:      { width: 36, height: 36, borderRadius: 18 },
  colorDotActive:{ borderWidth: 3, borderColor: '#fff' },

  // Link
  linkContainer: { flex: 1, padding: 20, gap: 16 },
  linkInputRow:  {
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderRadius: 12, padding: 14,
  },
  linkInput:     { flex: 1, fontSize: 15 },
  primaryBtn:    {
    borderRadius: 12, padding: 14, alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontSize: 16, fontFamily: 'Roboto-SemiBold' },
});
