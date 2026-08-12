import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  Modal, View, Text, TouchableOpacity, FlatList, StyleSheet, TextInput, ScrollView,
  ActivityIndicator, Animated, PanResponder, Keyboard, Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';
import ContactDatabase from '../../services/ContactDatabase';
import { useContactSync } from '../../contexts/useContactSync';
import { toSecureMediaUri } from '../../utils/mediaService';
import CallAvatar from './CallAvatar';

/**
 * Conference "Add people" sheet (WhatsApp-style):
 *  • header: "<N> connected" + the current participant roster (animated ring on
 *    a still-connecting/ringing tile is handled by the grid; here they read
 *    "Ringing…" / "Connected")
 *  • "Add people": search + multi-select with removable chips, sourced from the
 *    EXISTING registered-contacts store (ContactDatabase) — never a new list
 *  • footer: "Add to call" rings everyone selected into the live conference.
 * Contacts already on the call (connected or ringing) are shown disabled.
 */
export default function ConferenceAddPeopleSheet(props) {
  // The heavy contact-sync hook must only mount while the sheet is OPEN —
  // the sheet component itself stays mounted for the whole call.
  if (!props.visible) return null;
  return <ConferenceAddPeopleSheetInner {...props} />;
}

function ConferenceAddPeopleSheetInner({
  visible, onClose, participants = {}, existingIds = [], onInvite, maxSelectable = 30,
}) {
  const { isDarkMode } = useTheme();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const myId = user?._id ? String(user._id) : null;

  // ── Draggable sheet: drag the handle/header down to dismiss ───────────────
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dragY = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 4,
    onPanResponderMove: (_e, g) => { if (g.dy > 0) dragY.setValue(g.dy); },
    onPanResponderRelease: (_e, g) => {
      if (g.dy > 110 || g.vy > 1.2) {
        Animated.timing(dragY, { toValue: 600, duration: 160, useNativeDriver: true })
          .start(() => { dragY.setValue(0); onCloseRef.current?.(); });
      } else {
        Animated.spring(dragY, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
      }
    },
  })).current;

  // ── Keyboard lift (edge-to-edge Android: Modal lives in its own window, so
  // KeyboardAvoidingView can't help — track kbHeight with the SCREEN height,
  // never the window height, and pad the sheet up by it). ──
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    const SCREEN_H = Dimensions.get('screen').height;
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      const y = e?.endCoordinates?.screenY;
      setKbHeight(Number.isFinite(y) ? Math.max(0, SCREEN_H - y) : (e?.endCoordinates?.height || 0));
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKbHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState({});
  // Contacts never synced on this install → run the app's normal device→server
  // contact sync right here so the picker isn't empty (same machinery as the
  // AddUser / AddGroupMembers screens).
  const { syncContacts, isSyncing, isProcessing } = useContactSync();
  const syncTriggeredRef = useRef(false);

  const loadFromDb = useCallback(async () => {
    const rows = await ContactDatabase.loadRegisteredContacts().catch(() => []);
    const mapped = (rows || [])
      .filter((r) => r && (r.user_id || r.userId))
      .map((r) => ({
        id: String(r.user_id || r.userId),
        name: r.full_name || r.fullName || r.name || r.phone_number || 'Unknown',
        phone: r.phone_number || r.phoneNumber || null,
        avatar: r.profile_image ? toSecureMediaUri(r.profile_image) : (r.profileImage ? toSecureMediaUri(r.profileImage) : null),
      }));
    setContacts(mapped);
    return mapped;
  }, []);

  useEffect(() => {
    if (!visible) return;
    setSelected({});
    setQuery('');
    let alive = true;
    let poll = null;
    (async () => {
      setLoading(true);
      const mapped = await loadFromDb();
      if (!alive) return;
      // Empty local store = contacts were never fetched — trigger the full
      // sync ONCE per open. The sync lands in BATCHES, so instead of blocking
      // the picker until the whole device book is processed (slow on big
      // contact lists), poll SQLite while it runs and surface registered
      // matches PROGRESSIVELY — the user can pick someone as soon as their
      // batch arrives instead of staring at the spinner till the end.
      if (!mapped.length && !syncTriggeredRef.current) {
        syncTriggeredRef.current = true;
        poll = setInterval(() => {
          if (alive) loadFromDb();
        }, 1200);
        try { await syncContacts(); } catch (_) { /* permission denied / offline */ }
        if (poll) { clearInterval(poll); poll = null; }
        if (alive) await loadFromDb();
      }
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
      if (poll) clearInterval(poll);
    };
  }, [visible, loadFromDb, syncContacts]);

  // A background sync finishing while the sheet is open refreshes the list.
  useEffect(() => {
    if (!visible || isSyncing || isProcessing) return;
    loadFromDb();
  }, [visible, isSyncing, isProcessing, loadFromDb]);

  const onCallIds = useMemo(() => new Set([
    ...(existingIds || []).map(String),
    ...Object.keys(participants || {}),
    ...(myId ? [myId] : []),
  ]), [existingIds, participants, myId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = contacts.filter((c) => c.id !== myId);
    if (!q) return base;
    return base.filter((c) => (c.name || '').toLowerCase().includes(q)
      || (c.phone || '').toLowerCase().includes(q));
  }, [contacts, query, myId]);

  const roster = useMemo(() => Object.values(participants || {}), [participants]);
  const connectedCount = roster.filter((p) => p && p.joined).length + 1; // + self

  const toggle = useCallback((c) => {
    if (onCallIds.has(c.id)) return; // already on the call / ringing — disabled
    setSelected((prev) => {
      const next = { ...prev };
      if (next[c.id]) delete next[c.id];
      else if (Object.keys(next).length < maxSelectable) next[c.id] = c;
      return next;
    });
  }, [onCallIds, maxSelectable]);

  const selectedList = Object.values(selected);
  const bg = isDarkMode ? '#111B21' : '#FFFFFF';
  const txt = isDarkMode ? '#E9EDEF' : '#111B21';
  const sub = isDarkMode ? '#8696A0' : '#667781';
  const line = isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const brand = '#03b0a2';

  const renderContact = ({ item }) => {
    const disabled = onCallIds.has(item.id);
    const isSel = !!selected[item.id];
    return (
      <TouchableOpacity
        style={[styles.row, disabled && { opacity: 0.45 }]}
        onPress={() => toggle(item)}
        disabled={disabled}
        activeOpacity={0.7}
      >
        <CallAvatar uri={item.avatar} name={item.name} size={44} />
        <View style={styles.rowText}>
          <Text style={[styles.rowName, { color: txt }]} numberOfLines={1}>{item.name}</Text>
          {disabled ? (
            <Text style={[styles.rowSub, { color: sub }]}>Already in this call</Text>
          ) : item.phone ? (
            <Text style={[styles.rowSub, { color: sub }]} numberOfLines={1}>{item.phone}</Text>
          ) : null}
        </View>
        {isSel ? <Ionicons name="checkmark-circle" size={24} color={brand} /> : null}
      </TouchableOpacity>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.scrim}>
        <TouchableOpacity style={styles.scrimTap} activeOpacity={1} onPress={onClose} />
        <Animated.View
          style={[
            styles.sheet,
            { backgroundColor: bg, transform: [{ translateY: dragY }] },
            { paddingBottom: Math.max(insets.bottom, 12) + kbHeight },
          ]}
        >
          {/* Drag zone: grabber + header — swipe down to dismiss */}
          <View {...panResponder.panHandlers} style={styles.dragZone}>
            <View style={styles.grabber} />
            {/* Roster header — "N connected" (Image 3) */}
            <Text style={[styles.header, { color: txt }]}>{connectedCount} connected</Text>
          </View>
          {roster.length ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={[styles.rosterWrap, { borderBottomColor: line }]}
              contentContainerStyle={styles.rosterContent}
            >
              {roster.map((p) => (
                <View key={p.id} style={styles.rosterItem}>
                  <CallAvatar uri={p.avatar} name={p.name} id={p.id} size={46} />
                  <Text style={[styles.rosterName, { color: txt }]} numberOfLines={1}>
                    {p.name}
                  </Text>
                  <Text style={[styles.rosterState, { color: p.joined ? brand : sub }]} numberOfLines={1}>
                    {p.joined ? 'Connected' : 'Ringing…'}
                  </Text>
                </View>
              ))}
            </ScrollView>
          ) : null}

          {/* Add people — search (Image 6/8) */}
          <View style={[styles.searchWrap, { borderColor: line }]}>
            <Ionicons name="search" size={18} color={sub} />
            <TextInput
              style={[styles.search, { color: txt }]}
              placeholder="Search name or number"
              placeholderTextColor={sub}
              value={query}
              onChangeText={setQuery}
              autoCorrect={false}
            />
          </View>

          {/* Selected chips */}
          {selectedList.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsRow} keyboardShouldPersistTaps="handled">
              {selectedList.map((s) => (
                <TouchableOpacity key={s.id} style={[styles.chip, { backgroundColor: isDarkMode ? 'rgba(3,176,162,0.18)' : 'rgba(3,176,162,0.12)' }]} onPress={() => toggle(s)}>
                  <Text style={[styles.chipText, { color: brand }]} numberOfLines={1}>{s.name}</Text>
                  <Ionicons name="close-circle" size={16} color={brand} />
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : null}

          {(loading || isSyncing || isProcessing) && !contacts.length ? (
            // First-time open with no local contacts: the device→server sync is
            // running right now — show progress instead of an empty list.
            <View style={styles.syncWrap}>
              <ActivityIndicator size="small" color={brand} />
              <Text style={[styles.syncText, { color: sub }]}>Syncing your contacts…</Text>
            </View>
          ) : !filtered.length ? (
            <View style={styles.syncWrap}>
              <Text style={[styles.syncText, { color: sub }]}>
                {query ? 'No contact matches your search.' : 'No contacts on the app yet.'}
              </Text>
            </View>
          ) : (
            <>
              <Text style={[styles.count, { color: sub }]}>
                {filtered.length} contacts{(isSyncing || isProcessing) ? '  ·  syncing more…' : ''}
              </Text>
              <FlatList
                data={filtered}
                keyExtractor={(item) => item.id}
                renderItem={renderContact}
                style={styles.list}
                keyboardShouldPersistTaps="handled"
              />
            </>
          )}

          {/* Add to call */}
          <TouchableOpacity
            style={[styles.addBtn, { backgroundColor: selectedList.length ? brand : (isDarkMode ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)') }]}
            disabled={!selectedList.length}
            onPress={() => {
              const members = selectedList.map((s) => ({ id: s.id, name: s.name, mobile: s.phone || null, avatar: s.avatar }));
              onClose?.();
              onInvite?.(members);
            }}
          >
            <Ionicons name="person-add" size={18} color={selectedList.length ? '#fff' : sub} />
            <Text style={[styles.addBtnText, { color: selectedList.length ? '#fff' : sub }]}>
              Add to call{selectedList.length ? ` (${selectedList.length})` : ''}
            </Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  scrimTap: { flex: 1 },
  sheet: {
    maxHeight: '84%', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 16, paddingTop: 6,
  },
  dragZone: { paddingBottom: 2 },
  grabber: {
    alignSelf: 'center', width: 40, height: 4.5, borderRadius: 3,
    backgroundColor: 'rgba(128,128,128,0.45)', marginTop: 6, marginBottom: 12,
  },
  header: { fontSize: 18, fontWeight: '700', marginBottom: 10 },
  rosterWrap: {
    flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 12,
  },
  rosterContent: { paddingBottom: 12 },
  rosterItem: { alignItems: 'center', width: 84, marginRight: 6 },
  rosterName: { fontSize: 12, marginTop: 5, maxWidth: 80, textAlign: 'center' },
  rosterState: { fontSize: 10.5, marginTop: 1.5 },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 10,
    paddingHorizontal: 10, height: 42, marginBottom: 8,
  },
  search: { flex: 1, marginLeft: 8, fontSize: 15, paddingVertical: 0 },
  chipsRow: { flexGrow: 0, marginBottom: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center', borderRadius: 16,
    paddingHorizontal: 10, paddingVertical: 6, marginRight: 8,
  },
  chipText: { fontSize: 13, fontWeight: '600', marginRight: 4, maxWidth: 120 },
  count: { fontSize: 12, marginBottom: 4 },
  syncWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 34 },
  syncText: { fontSize: 13.5, marginTop: 8 },
  list: { flexGrow: 0, maxHeight: 320 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9 },
  rowText: { flex: 1, marginLeft: 12 },
  rowName: { fontSize: 15.5, fontWeight: '600' },
  rowSub: { fontSize: 12.5, marginTop: 1 },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    height: 48, borderRadius: 24, marginTop: 10,
  },
  addBtnText: { fontSize: 15.5, fontWeight: '700', marginLeft: 8 },
});
