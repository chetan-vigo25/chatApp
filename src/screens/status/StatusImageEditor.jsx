/**
 * StatusImageEditor — a single-screen (modal) image editor for status images.
 *
 * Tools: CROP (draggable rectangle), ROTATE (90° steps), TEXT (draggable text
 * overlays with colour). Crop + rotate are baked into the file with
 * expo-image-manipulator (no native rebuild). Text overlays are baked by
 * capturing the composited view with react-native-view-shot — that native
 * module requires ONE `npx expo prebuild` + rebuild; until then crop/rotate
 * still work and adding text warns instead of crashing.
 *
 * Usage:
 *   <StatusImageEditor visible uri={uri} onCancel={..} onDone={(newUri)=>..} />
 */
import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Image,
  PanResponder, Dimensions, ActivityIndicator, Alert, Modal, Platform,
} from 'react-native';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

// react-native-view-shot is a native module; require lazily so a not-yet-rebuilt
// binary doesn't crash the whole editor at import time.
let captureRef = null;
try { captureRef = require('react-native-view-shot').captureRef; } catch { /* rebuild pending */ }

const { width: SW, height: SH } = Dimensions.get('window');
const TOP_BAR = 56;
const BOTTOM_BAR = 76;
const CANVAS_W = SW;
const CANVAS_H = SH - TOP_BAR - BOTTOM_BAR;

const TEXT_COLORS = ['#ffffff', '#000000', '#03b0a2', '#f6c945', '#e0457b', '#1d9bf0', '#e53935', '#22b07d'];
const MIN_CROP = 48; // min crop side in display points

// Fit an (w×h) image inside the canvas with "contain" and return its on-screen rect.
function fitContain(w, h) {
  if (!w || !h) return { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H };
  const scale = Math.min(CANVAS_W / w, CANVAS_H / h);
  const dw = w * scale, dh = h * scale;
  return { x: (CANVAS_W - dw) / 2, y: (CANVAS_H - dh) / 2, w: dw, h: dh };
}

export default function StatusImageEditor({ visible, uri, initialMode = 'idle', onCancel, onDone }) {
  const [workingUri, setWorkingUri] = useState(uri);
  const [natural, setNatural] = useState({ w: 0, h: 0 });   // real pixel size of workingUri
  const [mode, setMode] = useState('idle');                  // 'idle' | 'crop'
  const [busy, setBusy] = useState(false);
  const [overlays, setOverlays] = useState([]);              // {id,text,color,x,y}
  const [addingText, setAddingText] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [draftColor, setDraftColor] = useState('#ffffff');

  const shotRef = useRef(null);
  const idRef = useRef(1);

  // Reset when a new uri is opened — and jump straight into the tool the user
  // tapped on the preview (crop / text), so it never feels like a new screen.
  useEffect(() => {
    if (!visible) return;
    setWorkingUri(uri);
    setOverlays([]);
    setNatural({ w: 0, h: 0 });
    setMode(initialMode === 'crop' ? 'crop' : 'idle');
    setAddingText(initialMode === 'text');
  }, [visible, uri, initialMode]);

  // Measure the working image's natural pixel size (needed for crop mapping).
  useEffect(() => {
    if (!workingUri) return;
    let alive = true;
    Image.getSize(workingUri, (w, h) => { if (alive) setNatural({ w, h }); }, () => {});
    return () => { alive = false; };
  }, [workingUri]);

  const disp = fitContain(natural.w, natural.h); // displayed image rect within canvas

  // ── Crop rectangle (display coords, relative to canvas) ─────────────────────
  const [crop, setCrop] = useState(null); // {x,y,w,h}
  useEffect(() => {
    if (mode === 'crop' && disp.w) {
      // Start with an inset rectangle over the whole image.
      const inset = 0.08;
      setCrop({
        x: disp.x + disp.w * inset,
        y: disp.y + disp.h * inset,
        w: disp.w * (1 - 2 * inset),
        h: disp.h * (1 - 2 * inset),
      });
    }
  }, [mode, disp.x, disp.y, disp.w, disp.h]);

  const cropRef = useRef(crop);
  useEffect(() => { cropRef.current = crop; }, [crop]);

  const clampCrop = useCallback((c) => {
    const minX = disp.x, minY = disp.y, maxX = disp.x + disp.w, maxY = disp.y + disp.h;
    let { x, y, w, h } = c;
    w = Math.max(MIN_CROP, Math.min(w, disp.w));
    h = Math.max(MIN_CROP, Math.min(h, disp.h));
    x = Math.max(minX, Math.min(x, maxX - w));
    y = Math.max(minY, Math.min(y, maxY - h));
    return { x, y, w, h };
  }, [disp.x, disp.y, disp.w, disp.h]);

  // Drag the whole crop box.
  const moveResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { moveResponder.start = cropRef.current; },
    onPanResponderMove: (_e, g) => {
      const s = moveResponder.start; if (!s) return;
      setCrop(clampCrop({ ...s, x: s.x + g.dx, y: s.y + g.dy }));
    },
  })).current;

  // Resize handle factory (corner: 'tl' | 'br').
  const makeHandle = (corner) => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { makeHandle._start = cropRef.current; },
    onPanResponderMove: (_e, g) => {
      const s = makeHandle._start; if (!s) return;
      let next;
      if (corner === 'br') {
        next = { x: s.x, y: s.y, w: s.w + g.dx, h: s.h + g.dy };
      } else { // tl
        next = { x: s.x + g.dx, y: s.y + g.dy, w: s.w - g.dx, h: s.h - g.dy };
      }
      setCrop(clampCrop(next));
    },
  });
  const tlHandle = useRef(makeHandle('tl')).current;
  const brHandle = useRef(makeHandle('br')).current;

  // ── Apply crop → bake with expo-image-manipulator ───────────────────────────
  const applyCrop = useCallback(async () => {
    const c = cropRef.current;
    if (!c || !natural.w || !disp.w) { setMode('idle'); return; }
    setBusy(true);
    try {
      const scale = natural.w / disp.w; // px per display point
      const originX = Math.max(0, Math.round((c.x - disp.x) * scale));
      const originY = Math.max(0, Math.round((c.y - disp.y) * scale));
      const width  = Math.min(natural.w - originX, Math.round(c.w * scale));
      const height = Math.min(natural.h - originY, Math.round(c.h * scale));
      const out = await manipulateAsync(workingUri, [{ crop: { originX, originY, width, height } }], {
        compress: 0.92, format: SaveFormat.JPEG,
      });
      // One-shot: return the cropped file straight to the preview (in place).
      // Chaining another tool = tap it again on the preview.
      onDone?.(out.uri);
    } catch (err) {
      Alert.alert('Crop failed', err?.message || 'Try again');
    } finally { setBusy(false); }
  }, [natural.w, natural.h, disp.w, disp.x, disp.y, workingUri, onDone]);

  // ── Rotate 90° → bake ───────────────────────────────────────────────────────
  const rotate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const out = await manipulateAsync(workingUri, [{ rotate: 90 }], { compress: 0.92, format: SaveFormat.JPEG });
      setWorkingUri(out.uri);
      setNatural({ w: out.width, h: out.height });
      setOverlays([]);
    } catch (err) {
      Alert.alert('Rotate failed', err?.message || 'Try again');
    } finally { setBusy(false); }
  }, [workingUri, busy]);

  // ── Text overlays ───────────────────────────────────────────────────────────
  const confirmAddText = useCallback(() => {
    const t = draftText.trim();
    setAddingText(false);
    if (!t) return;
    setOverlays((prev) => [...prev, {
      id: idRef.current++, text: t, color: draftColor,
      x: CANVAS_W / 2 - 60, y: CANVAS_H / 2 - 20,
    }]);
    setDraftText('');
  }, [draftText, draftColor]);

  const overlayPan = (id) => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { overlayPan._s = overlays.find(o => o.id === id); },
    onPanResponderMove: (_e, g) => {
      const s = overlayPan._s; if (!s) return;
      setOverlays((prev) => prev.map(o => o.id === id ? { ...o, x: s.x + g.dx, y: s.y + g.dy } : o));
    },
  });

  // ── Done → return final uri (bake text if any) ──────────────────────────────
  const finish = useCallback(async () => {
    if (busy) return;
    if (overlays.length === 0) { onDone?.(workingUri); return; }
    if (!captureRef) {
      Alert.alert(
        'Rebuild required for text',
        'Text-on-image needs a new app build (react-native-view-shot). Crop & rotate are applied; text was not baked. Run a fresh build to enable text.',
        [{ text: 'Post without text', onPress: () => onDone?.(workingUri) }, { text: 'Keep editing', style: 'cancel' }],
      );
      return;
    }
    setBusy(true);
    try {
      const shot = await captureRef(shotRef, { format: 'jpg', quality: 0.92, result: 'tmpfile' });
      onDone?.(shot);
    } catch (err) {
      Alert.alert('Could not apply text', (err?.message || '') + '\nPosting without baked text.', [
        { text: 'OK', onPress: () => onDone?.(workingUri) },
      ]);
    } finally { setBusy(false); }
  }, [busy, overlays.length, workingUri, onDone]);

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="none" onRequestClose={onCancel} transparent={false}>
      <View style={styles.root}>
        {/* Top bar */}
        <View style={styles.topBar}>
          {mode === 'crop' ? (
            <>
              <TouchableOpacity onPress={onCancel} style={styles.tBtn}><Text style={styles.tCancel}>Cancel</Text></TouchableOpacity>
              <Text style={styles.tTitle}>Crop</Text>
              <TouchableOpacity onPress={applyCrop} style={styles.tBtn}><Text style={styles.tDone}>Done</Text></TouchableOpacity>
            </>
          ) : (
            <>
              <TouchableOpacity onPress={onCancel} style={styles.tBtn}><Ionicons name="close" size={26} color="#fff" /></TouchableOpacity>
              <View style={styles.toolRow}>
                <TouchableOpacity onPress={() => setMode('crop')} style={styles.toolBtn} disabled={busy}>
                  <MaterialCommunityIcons name="crop" size={22} color="#fff" />
                </TouchableOpacity>
                <TouchableOpacity onPress={rotate} style={styles.toolBtn} disabled={busy}>
                  <MaterialCommunityIcons name="rotate-right" size={22} color="#fff" />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { setDraftText(''); setAddingText(true); }} style={styles.toolBtn} disabled={busy}>
                  <MaterialCommunityIcons name="format-text" size={22} color="#fff" />
                </TouchableOpacity>
              </View>
              <TouchableOpacity onPress={finish} style={styles.tBtn}><Text style={styles.tDone}>Done</Text></TouchableOpacity>
            </>
          )}
        </View>

        {/* Canvas: black backdrop + the captured image-rect (image + text). The
            captured view is EXACTLY the displayed image rect so a baked-text
            status has no black letterbox bars. Overlays are positioned relative
            to that rect (canvas coords minus the rect origin). */}
        <View style={styles.canvas}>
          <View style={styles.canvasInner} />
          {workingUri ? (
            <View
              ref={shotRef}
              collapsable={false}
              style={{ position: 'absolute', left: disp.x, top: disp.y, width: disp.w, height: disp.h, overflow: 'hidden' }}
            >
              <Image source={{ uri: workingUri }} style={{ width: disp.w, height: disp.h }} resizeMode="cover" />
              {overlays.map((o) => (
                <View key={o.id} {...overlayPan(o.id).panHandlers} style={{ position: 'absolute', left: o.x - disp.x, top: o.y - disp.y }}>
                  <Text style={[styles.overlayText, { color: o.color }]}>{o.text}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {/* Crop overlay */}
          {mode === 'crop' && crop && (
            <>
              <View pointerEvents="none" style={styles.cropDim} />
              <View {...moveResponder.panHandlers} style={[styles.cropBox, { left: crop.x, top: crop.y, width: crop.w, height: crop.h }]}>
                <View {...tlHandle.panHandlers} style={[styles.handle, styles.handleTL]} />
                <View {...brHandle.panHandlers} style={[styles.handle, styles.handleBR]} />
              </View>
            </>
          )}

          {busy && <View style={styles.busy}><ActivityIndicator color="#fff" size="large" /></View>}
        </View>

        {/* Bottom hint */}
        <View style={styles.bottomBar}>
          <Text style={styles.hint}>
            {mode === 'crop' ? 'Drag the corners to crop' : 'Crop · Rotate · Add text, then tap Done'}
          </Text>
        </View>

        {/* Add-text sheet */}
        {addingText && (
          <View style={styles.textSheet}>
            <TextInput
              value={draftText}
              onChangeText={setDraftText}
              placeholder="Type text…"
              placeholderTextColor="rgba(255,255,255,0.5)"
              autoFocus
              multiline
              style={[styles.textInput, { color: draftColor }]}
            />
            <View style={styles.colorRow}>
              {TEXT_COLORS.map((c) => (
                <TouchableOpacity key={c} onPress={() => setDraftColor(c)} style={[styles.swatch, { backgroundColor: c }, draftColor === c && styles.swatchActive]} />
              ))}
            </View>
            <View style={styles.sheetActions}>
              <TouchableOpacity onPress={() => { setAddingText(false); if (overlays.length === 0) onCancel?.(); }}>
                <Text style={styles.tCancel}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={confirmAddText}><Text style={styles.tDone}>Add</Text></TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  topBar: { height: TOP_BAR, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12 },
  tBtn: { minWidth: 60, paddingVertical: 8, justifyContent: 'center' },
  tTitle: { color: '#fff', fontSize: 16, fontFamily: 'Roboto-Medium' },
  tCancel: { color: 'rgba(255,255,255,0.85)', fontSize: 15, fontFamily: 'Roboto-Medium' },
  tDone: { color: '#03b0a2', fontSize: 15, fontFamily: 'Roboto-Bold', textAlign: 'right' },
  toolRow: { flexDirection: 'row', gap: 6 },
  toolBtn: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 21 },
  canvas: { width: CANVAS_W, height: CANVAS_H, position: 'relative' },
  canvasInner: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  overlayText: { fontSize: 30, fontFamily: 'Roboto-Bold', textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4, padding: 6 },
  cropDim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  cropBox: { position: 'absolute', borderWidth: 2, borderColor: '#fff' },
  handle: { position: 'absolute', width: 26, height: 26, borderColor: '#03b0a2', borderWidth: 3 },
  handleTL: { left: -3, top: -3, borderRightWidth: 0, borderBottomWidth: 0 },
  handleBR: { right: -3, bottom: -3, borderLeftWidth: 0, borderTopWidth: 0 },
  busy: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.3)' },
  bottomBar: { height: BOTTOM_BAR, alignItems: 'center', justifyContent: 'center' },
  hint: { color: 'rgba(255,255,255,0.6)', fontSize: 13, fontFamily: 'Roboto-Regular' },
  textSheet: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.92)', padding: 16, paddingBottom: 28 },
  textInput: { minHeight: 48, fontSize: 22, fontFamily: 'Roboto-Bold', textAlign: 'center' },
  colorRow: { flexDirection: 'row', justifyContent: 'center', gap: 10, marginVertical: 14 },
  swatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: 'transparent' },
  swatchActive: { borderColor: '#fff' },
  sheetActions: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 8 },
});
