/**
 * StatusCreate — entry screen for creating a new status.
 *
 * Opens as a WhatsApp-style bottom sheet with four options:
 *   Camera  → capture a photo/video
 *   Gallery → system photo picker (multi-select, up to 10)
 *   Text    → inline text composer
 *   Link    → link URL input
 *
 * Modes:
 *   null   → the bottom-sheet option picker
 *   text   → inline text composer
 *   link   → link URL input
 *
 * After capturing/selecting media, navigates to StatusCustomise for editing,
 * then StatusPreview for the final post step. Text statuses skip Customise and
 * go directly to StatusPreview.
 *
 * Media selection deliberately uses ImagePicker's system gallery (Android Photo
 * Picker / iOS PHPicker) rather than an in-app MediaLibrary grid: the system
 * picker needs no runtime permission and reliably shows both photos and videos.
 */
import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, TextInput,
  ScrollView, ActivityIndicator, Alert, Dimensions, Pressable,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { Ionicons, MaterialCommunityIcons, FontAwesome5 } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import useStatusSettings from '../../hooks/useStatusSettings';
import { suspendAppLock, resumeAppLock } from '../../services/appLockGuard';

const { width: SCREEN_W } = Dimensions.get('window');

const BG_COLORS = [
  '#026158', '#02958a', '#03b0a2', '#FF6B6B',
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
  const textInputRef = useRef(null);

  const [mode, setMode]       = useState(initialMode);
  const [text, setText]       = useState('');
  const [bgColor, setBgColor] = useState(BG_COLORS[0]);
  const [linkUrl, setLinkUrl] = useState('');
  const [fetching] = useState(false);

  // Camera + mic permissions are cached by these hooks, so we only ever prompt
  // once (instead of re-requesting on every Camera tap).
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [micPerm, requestMicPerm] = useMicrophonePermissions();
  const [, setLaunchingCam] = useState(false);

  // ── Camera ──────────────────────────────────────────────────────────────
  const launchCamera = useCallback(async () => {
    // Opening the camera backgrounds the app — keep the 2-step app lock from
    // re-locking when we come back.
    suspendAppLock();
    setLaunchingCam(true);
    try {
      // Only prompt when we don't already hold the permission — the cached hook
      // means a granted permission never re-prompts.
      if (!camPerm?.granted) {
        const r = await requestCamPerm();
        if (!r?.granted) return Alert.alert('Permission needed', 'Please allow camera access');
      }
      // Video status needs the mic. Request it once up front (best-effort) so the
      // camera doesn't pop a second dialog mid-capture.
      if (!micPerm?.granted) { try { await requestMicPerm(); } catch {} }

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
      setLaunchingCam(false);
      resumeAppLock();
    }
  }, [camPerm, requestCamPerm, micPerm, requestMicPerm, navigation, limits.maxVideoSecs, validateMediaList]);

  // ── Gallery multi-select (system photo picker) ────────────────────────────
  // Uses the OS picker, which on Android 13+ is the privacy-friendly Photo
  // Picker and needs NO runtime permission — so it always shows photos+videos.
  const launchGallery = useCallback(async () => {
    suspendAppLock();
    try {
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

  // ── Add status picker (WhatsApp-style bottom sheet) ────────────────────────
  if (!mode) {
    const text2 = theme.colors.primaryTextColor;
    const cardBorder = isDarkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)';
    const themeColor = theme.colors.themeColor;

    const optionCards = [
      { key: 'camera',  label: 'Camera',  render: () => <Ionicons name="camera" size={28} color={themeColor} />,             onPress: launchCamera },
      { key: 'gallery', label: 'Gallery', render: () => <Ionicons name="images" size={26} color={themeColor} />,             onPress: launchGallery },
      { key: 'text',    label: 'Text',    render: () => <MaterialCommunityIcons name="format-text" size={28} color={themeColor} />, onPress: () => setMode('text') },
      { key: 'link',    label: 'Link',    render: () => <FontAwesome5 name="link" size={22} color={themeColor} />,           onPress: () => setMode('link') },
    ];

    return (
      <View style={styles.sheetRoot}>
        {/* Dim area above the sheet — tap to dismiss, exactly like WhatsApp. */}
        <TouchableOpacity
          style={styles.sheetScrim}
          activeOpacity={1}
          onPress={() => navigation.goBack()}
        />
        <View style={[styles.sheet, { backgroundColor: theme.colors.background }]}>
          {/* Drag handle */}
          <View style={styles.sheetHandleWrap}>
            <View style={[styles.sheetHandle, { backgroundColor: isDarkMode ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)' }]} />
          </View>

          {/* Header */}
          <View style={styles.addHeader}>
            <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={26} color={text2} />
            </TouchableOpacity>
            <Text style={[styles.addHeaderTitle, { color: text2 }]}>Add status</Text>
            <View style={{ width: 26 }} />
          </View>

          {/* Option cards */}
          <View style={styles.optionGrid}>
            {optionCards.map((c) => (
              <TouchableOpacity
                key={c.key}
                activeOpacity={0.8}
                onPress={c.onPress}
                style={[styles.optionCard, { borderColor: cardBorder }]}
              >
                {c.render()}
                <Text style={[styles.optionCardLabel, { color: text2 }]}>{c.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>
    );
  }

  // ── Text composer ────────────────────────────────────────────────────────
  if (mode === 'text') {
    // Auto-scale the text so short statuses look bold and long ones still fit —
    // the same feel as WhatsApp's text composer.
    const len = text.length;
    const fontSize = len > 200 ? 18 : len > 120 ? 22 : len > 60 ? 27 : 32;

    return (
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.textScreen, { backgroundColor: bgColor }]}>
          {/* Header — balanced 3-section layout keeps the title dead-center. */}
          <View style={styles.textHeader}>
            <View style={styles.textHeaderSide}>
              <TouchableOpacity onPress={() => setMode(null)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Ionicons name="close" size={26} color="#fff" />
              </TouchableOpacity>
            </View>
            <Text style={styles.textHeaderTitle} numberOfLines={1}>Text status</Text>
            <View style={[styles.textHeaderSide, { alignItems: 'flex-end' }]}>
              <TouchableOpacity
                style={[styles.nextBtn, { opacity: text.trim() ? 1 : 0.45 }]}
                onPress={submitText}
                disabled={!text.trim()}
              >
                <Text style={styles.nextBtnText}>Next</Text>
                <Ionicons name="arrow-forward" size={17} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>

          {/* Input — tapping anywhere in this area focuses the field. */}
          <Pressable style={styles.textInputArea} onPress={() => textInputRef.current?.focus()}>
            <TextInput
              ref={textInputRef}
              style={[styles.textInput, { fontSize }]}
              placeholder="Type a status…"
              placeholderTextColor="rgba(255,255,255,0.55)"
              multiline
              autoFocus
              maxLength={700}
              value={text}
              onChangeText={setText}
              textAlignVertical="center"
            />
          </Pressable>

          {/* Character counter */}
          {len > 0 && (
            <Text style={styles.charCount}>{len}/700</Text>
          )}

          {/* Colour palette */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.palette}
            contentContainerStyle={styles.paletteContent}
            keyboardShouldPersistTaps="always"
          >
            {BG_COLORS.map(c => {
              const active = bgColor === c;
              return (
                <TouchableOpacity
                  key={c}
                  activeOpacity={0.8}
                  onPress={() => setBgColor(c)}
                  style={[styles.colorDotWrap, active && styles.colorDotWrapActive]}
                >
                  <View style={[styles.colorDot, { backgroundColor: c }]} />
                </TouchableOpacity>
              );
            })}
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
    paddingBottom: 16, paddingHorizontal: 16,
    flexDirection: 'row', alignItems: 'center',
  },
  backBtn: { marginRight: 14 },
  headerTitle: { fontSize: 18, fontFamily: 'Roboto-Bold' },

  // ── WhatsApp-style bottom sheet ────────────────────────────────────────────
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  // The dim area above the sheet; tapping it dismisses the picker.
  sheetScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    borderTopLeftRadius: 18, borderTopRightRadius: 18,
    paddingBottom: Platform.OS === 'ios' ? 34 : 24,
    overflow: 'hidden',
  },
  sheetHandleWrap: { alignItems: 'center', paddingTop: 8, paddingBottom: 2 },
  sheetHandle: { width: 38, height: 4, borderRadius: 2 },

  // Header
  addHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
  },
  addHeaderTitle: { flex: 1, textAlign: 'center', fontSize: 20, fontFamily: 'Roboto-Medium' },

  // Option cards (2×2 grid)
  optionGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    paddingHorizontal: 16, paddingTop: 8,
    justifyContent: 'space-between',
    rowGap: 12,
  },
  optionCard: {
    width: (SCREEN_W - 32 - 12) / 2,
    height: 104, borderRadius: 16, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  optionCardLabel: { fontSize: 15, fontFamily: 'Roboto-Medium' },

  // Text status
  textScreen:    { flex: 1 },
  textHeader:    {
    paddingTop: 10, paddingHorizontal: 16, paddingBottom: 8,
    flexDirection: 'row', alignItems: 'center',
  },
  textHeaderSide:  { flex: 1, justifyContent: 'center' },
  textHeaderTitle: { color: '#fff', fontSize: 17, fontFamily: 'Roboto-Bold', textAlign: 'center' },
  nextBtn:       { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.22)' },
  nextBtnText:   { color: '#fff', fontSize: 15, fontFamily: 'Roboto-SemiBold' },
  textInputArea: { flex: 1, justifyContent: 'center', paddingHorizontal: 28 },
  textInput:     {
    color: '#fff', textAlign: 'center', fontFamily: 'Roboto-Medium',
    maxHeight: 340,
    textShadowColor: 'rgba(0,0,0,0.18)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2,
  },
  charCount:     { color: 'rgba(255,255,255,0.7)', fontSize: 12, fontFamily: 'Roboto-Medium', alignSelf: 'flex-end', paddingRight: 22, paddingBottom: 8 },
  palette:       { flexGrow: 0, marginBottom: 16 },
  paletteContent:{ paddingHorizontal: 16, alignItems: 'center' },
  colorDotWrap:  {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2.5, borderColor: 'transparent',
    marginRight: 8,
  },
  colorDotWrapActive: { borderColor: '#fff' },
  colorDot:      { width: 32, height: 32, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)' },

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
