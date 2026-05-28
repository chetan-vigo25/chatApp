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
import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, TextInput,
  ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons, MaterialCommunityIcons, FontAwesome5 } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import useStatusSettings from '../../hooks/useStatusSettings';

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
  const { theme } = useTheme();
  const initialMode = route?.params?.type || null;
  const { validateMediaList, limits } = useStatusSettings();

  const [mode, setMode]       = useState(initialMode);
  const [text, setText]       = useState('');
  const [bgColor, setBgColor] = useState(BG_COLORS[0]);
  const [linkUrl, setLinkUrl] = useState('');
  const [fetching, setFetching] = useState(false);

  // ── Camera ──────────────────────────────────────────────────────────────
  const launchCamera = useCallback(async () => {
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
    }
  }, [navigation, limits.maxVideoSecs, validateMediaList]);

  // ── Gallery multi-select ─────────────────────────────────────────────────
  const launchGallery = useCallback(async () => {
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

  // ── Mode picker ──────────────────────────────────────────────────────────
  if (!mode) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color={theme.colors.themeColor} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: theme.colors.themeColor }]}>New Status</Text>
        </View>

        <View style={styles.grid}>
          <TouchableOpacity style={[styles.card, { backgroundColor: '#075e54' }]} onPress={launchCamera}>
            <Ionicons name="camera" size={40} color="#fff" />
            <Text style={styles.cardLabel}>Camera</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.card, { backgroundColor: '#6C5CE7' }]} onPress={launchGallery}>
            <Ionicons name="images" size={40} color="#fff" />
            <Text style={styles.cardLabel}>Gallery</Text>
            <Text style={styles.cardSub}>up to 10</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.card, { backgroundColor: '#00B894' }]} onPress={() => setMode('text')}>
            <MaterialCommunityIcons name="format-text" size={40} color="#fff" />
            <Text style={styles.cardLabel}>Text</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.card, { backgroundColor: '#0984e3' }]} onPress={() => setMode('link')}>
            <FontAwesome5 name="link" size={34} color="#fff" />
            <Text style={styles.cardLabel}>Link</Text>
          </TouchableOpacity>
        </View>
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
  headerTitle: { fontSize: 18, fontWeight: '700' },

  // Picker grid
  grid: {
    flex: 1, flexDirection: 'row', flexWrap: 'wrap',
    justifyContent: 'center', alignItems: 'center', gap: 20, padding: 30,
  },
  card: {
    width: 140, height: 140, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    elevation: 4, shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4,
  },
  cardLabel: { color: '#fff', fontSize: 16, fontWeight: '600', marginTop: 10 },
  cardSub:   { color: 'rgba(255,255,255,0.7)', fontSize: 11, marginTop: 2 },

  // Text status
  textScreen:    { flex: 1 },
  textHeader:    {
    paddingTop: 50, paddingHorizontal: 20,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  textHeaderTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  nextBtn:       { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.2)' },
  nextBtnText:   { color: '#fff', fontSize: 15, fontWeight: '600' },
  textInputArea: { flex: 1, justifyContent: 'center', paddingHorizontal: 30 },
  textInput:     { fontSize: 24, color: '#fff', textAlign: 'center', fontWeight: '500', maxHeight: 300 },
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
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
