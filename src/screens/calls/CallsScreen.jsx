import React, { useCallback, useState, useRef, useEffect } from 'react';
import {
  View, Text, SectionList, TouchableOpacity, StyleSheet, RefreshControl,
  ActivityIndicator, Animated, Platform, DeviceEventEmitter, Modal, BackHandler,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { Ionicons, MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import { useCall } from '../../calls/useCall';
import useContactDirectory from '../../hooks/useContactDirectory';
import { toSecureMediaUri } from '../../utils/mediaService';
import { listCalls, deleteCalls, clearCalls } from '../../calls/services/callLogService';
import { registerCallLogListeners } from '../../calls/services/callLogSyncService';
import { clearMissed } from '../../calls/services/missedCallBadge';
import { subscribeSocketState } from '../../Redux/Services/Socket/socket';
import CallAvatar from '../../calls/components/CallAvatar';
import CallsEmptyState from './CallsEmptyState';

const PAGE_SIZE = 30;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── time label: "Today, 10:30 AM" · "Yesterday, 9:14 PM" · "12 May, 3:01 PM" ──
const fmtClock = (date) => {
  let h = date.getHours();
  const m = date.getMinutes();
  const ap = h >= 12 ? 'PM' : 'AM';
  h %= 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
};
// Just the clock time — the date now lives in the section header.
const rowTime = (iso) => {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : fmtClock(date);
};

// Section header label for a call's timestamp: "Today" · "Yesterday" ·
// "12 May" (this year) · "12 May 2023" (older).
const sectionTitleFor = (iso) => {
  if (!iso) return 'Earlier';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Earlier';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'Today';
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (date.toDateString() === yest.toDateString()) return 'Yesterday';
  const label = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear() ? label : `${label} ${date.getFullYear()}`;
};

// Bucket the (recency-sorted) collapsed groups into dated sections for a
// SectionList. Order is preserved, so each date appears once in sequence.
const buildSections = (groups) => {
  const sections = [];
  let current = null;
  groups.forEach((g) => {
    const title = sectionTitleFor(g.at);
    if (!current || current.title !== title) {
      current = { title, data: [] };
      sections.push(current);
    }
    current.data.push(g);
  });
  return sections;
};

// WhatsApp call-direction indicator. Uses the Material Design call glyphs
// (the same ones WhatsApp Android uses) and colors by whether the call
// actually connected — green when answered, red when not:
//   outgoing answered      → call-made            (green ↗ with corner)
//   outgoing not answered  → call-missed-outgoing (red ↗)
//   incoming answered      → call-received        (green ↙ with corner)
//   incoming missed/decl.  → call-missed          (red ↙)
const CALL_GREEN = '#1DAB61'; // WhatsApp connected-call green
const CALL_RED = '#F15C6D';   // WhatsApp missed-call red

const directionMeta = (direction, outcome) => {
  const connected = outcome === 'completed';
  if (direction === 'outgoing') {
    return connected
      ? { icon: 'call-made', color: CALL_GREEN }
      : { icon: 'call-missed-outgoing', color: CALL_RED };
  }
  return connected
    ? { icon: 'call-received', color: CALL_GREEN }
    : { icon: 'call-missed', color: CALL_RED };
};

// Only a genuinely missed incoming call turns the contact name red (WhatsApp
// reserves the red name for "Missed call", not for calls you declined yourself).
const isMissedIncoming = (direction, outcome) => direction === 'incoming' && outcome === 'missed';

// Second-line label combining direction + outcome (WhatsApp wording).
const callMetaLabel = (direction, outcome) => {
  const isOut = direction === 'outgoing';
  switch (outcome) {
    case 'missed': return 'Missed';
    case 'rejected': return 'Declined';
    case 'cancelled': return isOut ? 'Cancelled' : 'Missed';
    case 'failed': return 'Not connected';
    case 'completed':
    default: return isOut ? 'Outgoing' : 'Incoming';
  }
};

// ── press-scale micro-interaction (matches StatusList rows) ──────────────────
function PressScale({ children, onPress, onLongPress, style }) {
  const v = useRef(new Animated.Value(1)).current;
  const to = useCallback((t) => Animated.spring(v, {
    toValue: t, useNativeDriver: true, speed: 40, bounciness: 0,
  }).start(), [v]);
  return (
    <Animated.View style={[{ transform: [{ scale: v }] }, style]}>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={250}
        onPressIn={() => to(0.97)}
        onPressOut={() => to(1)}
      >
        {children}
      </TouchableOpacity>
    </Animated.View>
  );
}

// Collapse consecutive log rows for the same peer into one entry (count badge),
// keeping the most-recent row's direction/outcome/media — exactly like WhatsApp.
const groupCalls = (items) => {
  // Defensive de-dup: realtime prepends + paginated appends can land the same
  // call in `items` twice (by callId, or by _id). Drop repeats before grouping
  // so two groups can never share a key ("duplicate key" warning) or double-count.
  const seenIds = new Set();
  const deduped = [];
  for (const it of items) {
    const id = String(it.callId || it._id || '');
    if (id && seenIds.has(id)) continue;
    if (id) seenIds.add(id);
    deduped.push(it);
  }

  const groups = [];
  for (const it of deduped) {
    const peerId = String(it.peerId?._id || it.peerId || '');
    const prev = groups[groups.length - 1];
    if (prev && prev.peerKey === peerId && peerId) {
      prev.count += 1;
      appendCallId(prev, it);
      continue;
    }
    groups.push({
      peerKey: peerId,
      // Stable + unique: after the de-dup above, each group's first row has a
      // distinct callId/_id, so this never collides (React list-key invariant)
      // and — unlike an index-based key — survives realtime reordering, so a
      // multi-select stays correct when a new call prepends.
      key: `${it.callId || it._id || `row-${groups.length}`}`,
      peer: it.peerId && typeof it.peerId === 'object' ? it.peerId : null,
      isGroup: !!it.isGroup,
      groupName: it.groupName || null,
      // Server rows populate `participants` (user objects); realtime rows carry
      // `participantNames` only. Keep both so we can label + redial.
      participants: Array.isArray(it.participants) ? it.participants : [],
      participantNames: Array.isArray(it.participantNames) ? it.participantNames : null,
      direction: it.direction,
      outcome: it.outcome,
      media: it.media,
      at: it.createdAt || it.endedAt || it.startedAt,
      count: 1,
      // Every underlying callId this collapsed row represents — so deleting the
      // row removes ALL the calls it stands for, not just the most recent.
      callIds: it.callId ? [String(it.callId)] : [],
    });
  }
  return groups;
};

// Collect the callId of a collapsed row (and its merged siblings).
const appendCallId = (group, it) => {
  if (it.callId) group.callIds.push(String(it.callId));
};

export default function CallsScreen({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const {
    startAudioCall, startVideoCall, startGroupAudioCall, startGroupVideoCall, callBusy,
  } = useCall();
  const { resolveName, refresh: refreshContacts } = useContactDirectory();

  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [initialised, setInitialised] = useState(false);
  const loadingRef = useRef(false);

  // ── multi-select + delete (WhatsApp-style) ──
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState([]); // group keys
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // ── header overflow menu + clear-all ──
  const [menuVisible, setMenuVisible] = useState(false);
  const [clearModalVisible, setClearModalVisible] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  // True once the first load has run — so focus re-entry doesn't refetch on
  // every tab switch (single initial fetch + realtime, per spec). Pull-to-
  // refresh and the realtime socket events keep the list current after that.
  const initialFetchedRef = useRef(false);

  const exitSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedKeys([]);
  }, []);

  const enterSelection = useCallback((key) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setSelectionMode(true);
    setSelectedKeys([key]);
  }, []);

  const toggleSelect = useCallback((key) => {
    setSelectedKeys((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      if (next.length === 0) setSelectionMode(false);
      return next;
    });
  }, []);

  const fetchPage = useCallback(async (targetPage, replace) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const res = await listCalls({ page: targetPage, limit: PAGE_SIZE });
      const next = res?.items || [];
      const pages = res?.pagination?.totalPages || 1;
      setTotalPages(pages);
      setPage(targetPage);
      setItems((prev) => (replace ? next : [...prev, ...next]));
    } catch (_) {
      if (replace) setItems([]);
    } finally {
      loadingRef.current = false;
      setLoading(false);
      setInitialised(true);
    }
  }, []);

  // Single initial fetch: load page 1 only on the FIRST focus. After that the
  // list stays current via realtime socket events (below) and pull-to-refresh —
  // no refetch on every tab switch.
  useFocusEffect(useCallback(() => {
    if (!initialFetchedRef.current) {
      initialFetchedRef.current = true;
      fetchPage(1, true);
    }
    refreshContacts?.();
    // Opening the Calls tab clears the unseen missed-call badge (APP-9).
    clearMissed();
  }, [fetchPage, refreshContacts]));

  // De-duped prepend/patch of a single call row, keyed by callId, so neither a
  // server refresh nor a duplicate realtime event ever creates a double row.
  const upsertRow = useCallback((row) => {
    if (!row?.callId) return;
    setItems((prev) => {
      const filtered = prev.filter((it) => String(it.callId) !== String(row.callId));
      return [row, ...filtered];
    });
    setInitialised(true);
  }, []);

  const removeByCallIds = useCallback((callIds = []) => {
    const idSet = new Set((callIds || []).map(String));
    if (!idSet.size) return;
    setItems((prev) => prev.filter((it) => !idSet.has(String(it.callId))));
  }, []);

  // Real-time #1 (same device): a call just ended here → prepend it immediately,
  // before the backend round-trip, so the row appears instantly.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('call:log:update', upsertRow);
    return () => sub.remove();
  }, [upsertRow]);

  // Real-time #2 (cross-device): the backend pushes call:log:* to every device
  // of this user when their history changes — new/updated row, deletion, or a
  // full clear — so a second device updates without polling. Re-attach on
  // socket reconnect (a fresh socket instance loses the old listeners).
  useEffect(() => {
    const handlers = {
      onNew: (payload) => { if (payload?.item) upsertRow(payload.item); },
      onDeleted: (payload) => removeByCallIds(payload?.callIds),
      onCleared: () => { setItems([]); setInitialised(true); },
    };
    let unsub = registerCallLogListeners(handlers);
    let wasConnected = false;
    const unsubState = subscribeSocketState((s) => {
      const connected = !!s.connected;
      if (connected && !wasConnected) {
        unsub?.();
        unsub = registerCallLogListeners(handlers);
      }
      wasConnected = connected;
    });
    return () => { unsub?.(); unsubState?.(); };
  }, [upsertRow, removeByCallIds]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([fetchPage(1, true), refreshContacts?.()]);
    setRefreshing(false);
  }, [fetchPage, refreshContacts]);

  const onEndReached = useCallback(() => {
    if (loadingRef.current) return;
    if (page < totalPages) fetchPage(page + 1, false);
  }, [page, totalPages, fetchPage]);

  const groups = groupCalls(items);
  const sections = buildSections(groups);

  const redial = useCallback((group, media) => {
    if (group.isGroup) {
      // Rebuild the participant list from the populated server records.
      const peers = (group.participants || [])
        .map((u) => (u && u._id ? {
          id: String(u._id),
          name: u.fullName || u.userName || 'Member',
          avatar: toSecureMediaUri(u.profileImageUrl || u.profileImage) || null,
        } : null))
        .filter(Boolean);
      if (!peers.length) return;
      const opts = { groupName: group.groupName };
      if (media === 'video') startGroupVideoCall?.(peers, opts);
      else startGroupAudioCall?.(peers, opts);
      return;
    }
    const p = group.peer;
    if (!p?._id) return;
    const peerObj = {
      id: String(p._id),
      name: p.fullName || p.userName || 'Unknown',
      avatar: toSecureMediaUri(p.profileImageUrl || p.profileImage) || null,
    };
    if (media === 'video') startVideoCall?.(peerObj);
    else startAudioCall?.(peerObj);
  }, [startAudioCall, startVideoCall, startGroupAudioCall, startGroupVideoCall]);

  // Open the WhatsApp-style call-info page for a collapsed row: pass the peer/
  // group identity plus every underlying log entry this row stands for, so the
  // detail screen can break the history down by day with per-call outcomes.
  const openDetail = useCallback((g) => {
    const idSet = new Set((g.callIds || []).map(String));
    const calls = items.filter((it) => idSet.has(String(it.callId)));
    navigation?.navigate?.('CallDetail', {
      peer: g.peer,
      isGroup: g.isGroup,
      groupName: g.groupName,
      participants: g.participants,
      participantNames: g.participantNames,
      calls,
    });
  }, [items, navigation]);

  // Row interactions: in selection mode a tap toggles; otherwise it opens the
  // call-info detail page (the trailing call button is what redials).
  const onRowPress = (g) => {
    if (selectionMode) toggleSelect(g.key);
    else openDetail(g);
  };
  const onRowLongPress = (g) => {
    if (selectionMode) toggleSelect(g.key);
    else enterSelection(g.key);
  };

  // Delete the selected groups: resolve every underlying callId, hit the server
  // (owner-scoped), then drop them from the local list. Best-effort server call
  // — local removal still happens so the UI stays responsive.
  const onConfirmDelete = async () => {
    const keySet = new Set(selectedKeys);
    const callIds = [];
    groups.forEach((g) => { if (keySet.has(g.key)) callIds.push(...(g.callIds || [])); });
    if (!callIds.length) { setDeleteModalVisible(false); exitSelection(); return; }
    setIsDeleting(true);
    try { await deleteCalls(callIds); } catch (_) { /* still remove locally */ }
    const idSet = new Set(callIds.map(String));
    setItems((prev) => prev.filter((it) => !idSet.has(String(it.callId))));
    setIsDeleting(false);
    setDeleteModalVisible(false);
    exitSelection();
  };

  // Clear ALL call history (owner-scoped). Optimistically empties the list, then
  // hits the server; on failure we reload so the UI never lies about the data.
  const onConfirmClear = async () => {
    setIsClearing(true);
    try {
      await clearCalls();
      setItems([]);
    } catch (_) {
      await fetchPage(1, true); // restore the real state
    } finally {
      setIsClearing(false);
      setClearModalVisible(false);
    }
  };

  // Android hardware back exits selection mode first (WhatsApp behavior).
  useFocusEffect(useCallback(() => {
    const onBack = () => {
      if (selectionMode) { exitSelection(); return true; }
      return false;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [selectionMode, exitSelection]));

  const renderItem = ({ item: g }) => {
    const isSelected = selectedKeys.includes(g.key);
    const p = g.peer || {};
    const peerId = String(p._id || g.peerKey || '');
    const isVideo = g.media === 'video';

    // Group rows: label by group name or the participant names; no peer avatar.
    let name;
    let avatarUri = null;
    if (g.isGroup) {
      const names = g.participantNames
        || (g.participants || []).map((u) => u?.fullName || u?.userName).filter(Boolean);
      name = g.groupName || (names && names.length ? names.join(', ') : 'Group call');
    } else {
      name = resolveName(peerId, p.fullName || p.userName || 'Unknown', null);
      avatarUri = toSecureMediaUri(p.profileImageUrl || p.profileImage) || null;
    }

    const { icon: arrowIcon, color: arrowColor } = directionMeta(g.direction, g.outcome);
    const missed = isMissedIncoming(g.direction, g.outcome);
    const nameColor = missed ? CALL_RED : theme.colors.primaryTextColor;
    const label = callMetaLabel(g.direction, g.outcome);

    return (
      <PressScale
        onPress={() => onRowPress(g)}
        onLongPress={() => onRowLongPress(g)}
        style={[styles.rowWrap, isSelected && { backgroundColor: `${theme.colors.themeColor}22` }]}
      >
        <View style={styles.row}>
          <View>
            {g.isGroup ? (
              <View style={[styles.groupIcon, { backgroundColor: `${theme.colors.themeColor}26` }]}>
                <Ionicons name="people" size={26} color={theme.colors.themeColor} />
              </View>
            ) : (
              <CallAvatar uri={avatarUri} name={name} id={peerId} size={52} />
            )}
            {isSelected && (
              <View
                style={[styles.avatarCheck, {
                  backgroundColor: theme.colors.themeColor, borderColor: theme.colors.background,
                }]}
                pointerEvents="none"
              >
                <Ionicons name="checkmark" size={12} color="#fff" />
              </View>
            )}
          </View>

          <View style={styles.rowText}>
            <View style={styles.nameLine}>
              <Text style={[styles.rowName, { color: nameColor, flexShrink: 1 }]} numberOfLines={1}>
                {name}{g.count > 1 ? `  (${g.count})` : ''}
              </Text>
            </View>
            <View style={styles.metaRow}>
              {/* direction arrow — green when connected, red when missed/declined */}
              <MaterialIcons name={arrowIcon} size={16} color={arrowColor} style={styles.metaArrow} />
              {/* audio/video call type */}
              <Ionicons
                name={isVideo ? 'videocam' : 'call'}
                size={13}
                color={theme.colors.placeHolderTextColor}
                style={styles.metaMedia}
              />
              <Text
                style={[styles.rowMeta, { color: missed ? CALL_RED : theme.colors.placeHolderTextColor }]}
                numberOfLines={1}
              >
                {label}
              </Text>
            </View>
          </View>

          <View style={styles.rightCol}>
            <Text style={[styles.timeText, { color: theme.colors.placeHolderTextColor }]}>
              {rowTime(g.at)}
            </Text>
            {selectionMode ? (
              <View
                style={[styles.checkbox, isSelected
                  ? { backgroundColor: theme.colors.themeColor, borderColor: theme.colors.themeColor }
                  : { borderColor: theme.colors.placeHolderTextColor }]}
              >
                {isSelected && <Ionicons name="checkmark" size={15} color="#fff" />}
              </View>
            ) : g.isGroup ? (
              /* GROUP CALLS TEMPORARILY DISABLED — no redial button on group
                 call-log rows. Re-enable by removing this `g.isGroup ? null :`
                 branch so groups get the same redial button as 1-1. */
              null
            ) : (
              <TouchableOpacity
                onPress={() => redial(g, g.media)}
                disabled={callBusy}
                activeOpacity={0.6}
                hitSlop={styles.hit}
                style={[styles.callBtnRight, callBusy && { opacity: 0.4 }]}
              >
                <Ionicons
                  name={isVideo ? 'videocam' : 'call'}
                  size={22}
                  color={theme.colors.themeColor}
                />
              </TouchableOpacity>
            )}
          </View>
        </View>
      </PressScale>
    );
  };

  const renderEmpty = () => {
    if (!initialised) {
      return (
        <View style={styles.centerFill}>
          <ActivityIndicator color={theme.colors.themeColor} />
        </View>
      );
    }
    return (
      <CallsEmptyState
        theme={theme}
        icon="call"
        title="No calls yet"
        subtitle="Your voice and video calls will appear here. Tap the button below to start one."
      />
    );
  };

  const renderFooter = () => {
    if (!loading || refreshing || !items.length) return null;
    return (
      <View style={styles.footerLoad}>
        <ActivityIndicator color={theme.colors.themeColor} size="small" />
      </View>
    );
  };

  const selectedCount = selectedKeys.length;

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Header — switches to a contextual selection bar (WhatsApp-style). */}
      {selectionMode ? (
        <View style={[styles.header, styles.selectionHeader, { backgroundColor: `${theme.colors.themeColor}14` }]}>
          <View style={styles.selectionLeft}>
            <TouchableOpacity onPress={exitSelection} activeOpacity={0.6} hitSlop={styles.hit} style={styles.headerIconBtn}>
              <Ionicons name="close" size={24} color={theme.colors.primaryTextColor} />
            </TouchableOpacity>
            <Text style={[styles.selectionCount, { color: theme.colors.primaryTextColor }]}>{selectedCount}</Text>
          </View>
          <TouchableOpacity
            onPress={() => selectedCount > 0 && setDeleteModalVisible(true)}
            activeOpacity={0.6}
            hitSlop={styles.hit}
            style={styles.headerIconBtn}
          >
            <MaterialCommunityIcons name="delete-outline" size={24} color={theme.colors.primaryTextColor} />
          </TouchableOpacity>
        </View>
      ) : (
        <View style={[styles.header, styles.headerRow]}>
          <Text style={[styles.headerTitle, { color: theme.colors.primaryTextColor }]}>Calls</Text>
          <TouchableOpacity
            onPress={() => setMenuVisible(true)}
            activeOpacity={0.6}
            hitSlop={styles.hit}
            style={styles.headerIconBtn}
          >
            <MaterialCommunityIcons name="dots-vertical" size={24} color={theme.colors.primaryTextColor} />
          </TouchableOpacity>
        </View>
      )}

      {/* Overflow menu → Clear call logs (WhatsApp top-right menu). */}
      <Modal animationType="fade" transparent visible={menuVisible} onRequestClose={() => setMenuVisible(false)}>
        <TouchableOpacity activeOpacity={1} onPress={() => setMenuVisible(false)} style={styles.menuOverlay}>
          <View style={[styles.menuCard, { backgroundColor: theme.colors.cardBackground }]}>
            <TouchableOpacity
              activeOpacity={0.7}
              disabled={!items.length}
              onPress={() => { setMenuVisible(false); setClearModalVisible(true); }}
              style={styles.menuItem}
            >
              <MaterialCommunityIcons
                name="delete-sweep-outline"
                size={20}
                color={items.length ? theme.colors.primaryTextColor : theme.colors.placeHolderTextColor}
              />
              <Text
                style={[styles.menuItemText, {
                  color: items.length ? theme.colors.primaryTextColor : theme.colors.placeHolderTextColor,
                }]}
              >
                Clear call logs
              </Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <SectionList
        sections={sections}
        keyExtractor={(g) => g.key}
        renderItem={renderItem}
        renderSectionHeader={({ section }) => (
          <Text style={[styles.sectionLabel, { color: theme.colors.placeHolderTextColor, backgroundColor: theme.colors.background }]}>
            {section.title}
          </Text>
        )}
        stickySectionHeadersEnabled={false}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={renderEmpty}
        ListFooterComponent={renderFooter}
        contentContainerStyle={sections.length ? styles.listContent : styles.listContentEmpty}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.4}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.colors.themeColor}
            colors={[theme.colors.themeColor]}
          />
        )}
      />

      {/* Start-a-call FAB → New Call contact picker (hidden during selection). */}
      {!selectionMode && (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => navigation?.navigate?.('NewCall')}
          style={[styles.fab, { backgroundColor: theme.colors.themeColor }]}
        >
          <MaterialCommunityIcons name="phone-plus" size={24} color="#fff" />
        </TouchableOpacity>
      )}

      {/* Delete confirmation (matches the app's chat-delete modal). */}
      <Modal
        animationType="fade"
        transparent
        visible={deleteModalVisible}
        onRequestClose={() => !isDeleting && setDeleteModalVisible(false)}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => !isDeleting && setDeleteModalVisible(false)}
          style={styles.deleteOverlay}
        >
          <TouchableOpacity activeOpacity={1} style={[styles.deleteCard, { backgroundColor: theme.colors.cardBackground }]}>
            <View style={[styles.deleteIconWrap, { backgroundColor: `${theme.colors.danger}1A` }]}>
              <MaterialCommunityIcons name="delete-alert-outline" size={28} color={theme.colors.danger} />
            </View>
            <Text style={[styles.deleteTitle, { color: theme.colors.primaryTextColor }]}>
              Delete {selectedCount} call{selectedCount === 1 ? '' : 's'}?
            </Text>
            <Text style={[styles.deleteSubtitle, { color: theme.colors.placeHolderTextColor }]}>
              This removes the selected entries from your call history. The other participants keep their own copy.
            </Text>
            <View style={styles.deleteActions}>
              <TouchableOpacity
                onPress={() => setDeleteModalVisible(false)}
                disabled={isDeleting}
                activeOpacity={0.7}
                style={[styles.deleteCancelBtn, { borderColor: theme.colors.borderColor || '#e6e6e6' }]}
              >
                <Text style={[styles.deleteCancelText, { color: theme.colors.primaryTextColor }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onConfirmDelete}
                disabled={isDeleting}
                activeOpacity={0.7}
                style={[styles.deleteConfirmBtn, { backgroundColor: theme.colors.danger }]}
              >
                {isDeleting
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={styles.deleteConfirmText}>Delete</Text>}
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Clear-all confirmation. */}
      <Modal
        animationType="fade"
        transparent
        visible={clearModalVisible}
        onRequestClose={() => !isClearing && setClearModalVisible(false)}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => !isClearing && setClearModalVisible(false)}
          style={styles.deleteOverlay}
        >
          <TouchableOpacity activeOpacity={1} style={[styles.deleteCard, { backgroundColor: theme.colors.cardBackground }]}>
            <View style={[styles.deleteIconWrap, { backgroundColor: `${theme.colors.danger}1A` }]}>
              <MaterialCommunityIcons name="delete-sweep-outline" size={28} color={theme.colors.danger} />
            </View>
            <Text style={[styles.deleteTitle, { color: theme.colors.primaryTextColor }]}>
              Clear call log?
            </Text>
            <Text style={[styles.deleteSubtitle, { color: theme.colors.placeHolderTextColor }]}>
              Are you sure you want to clear all call history? This only clears it for you — the other participants keep their own copy.
            </Text>
            <View style={styles.deleteActions}>
              <TouchableOpacity
                onPress={() => setClearModalVisible(false)}
                disabled={isClearing}
                activeOpacity={0.7}
                style={[styles.deleteCancelBtn, { borderColor: theme.colors.borderColor || '#e6e6e6' }]}
              >
                <Text style={[styles.deleteCancelText, { color: theme.colors.primaryTextColor }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onConfirmClear}
                disabled={isClearing}
                activeOpacity={0.7}
                style={[styles.deleteConfirmBtn, { backgroundColor: theme.colors.danger }]}
              >
                {isClearing
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={styles.deleteConfirmText}>Clear</Text>}
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 18,
    paddingTop: 6,
    paddingBottom: 10,
  },
  headerTitle: { fontSize: 22, fontFamily: 'Roboto-Bold', letterSpacing: -0.2 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  // overflow menu popover (top-right)
  menuOverlay: { flex: 1, paddingTop: 52, paddingRight: 12, alignItems: 'flex-end' },
  menuCard: {
    minWidth: 190,
    borderRadius: 14,
    paddingVertical: 6,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.18,
        shadowRadius: 14,
      },
      android: { elevation: 8 },
    }),
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  menuItemText: { fontSize: 15, fontFamily: 'Roboto-Medium' },

  selectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 8,
    paddingBottom: 8,
  },
  selectionLeft: { flexDirection: 'row', alignItems: 'center' },
  selectionCount: { fontSize: 19, fontFamily: 'Roboto-SemiBold', marginLeft: 18 },
  headerIconBtn: { padding: 4 },

  sectionLabel: {
    fontSize: 14,
    fontFamily: 'Roboto-Medium',
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 6,
  },

  listContent: { paddingBottom: 110 },
  listContentEmpty: { flexGrow: 1 },

  rowWrap: { paddingHorizontal: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
  },
  groupIcon: {
    width: 52, height: 52, borderRadius: 26,
    alignItems: 'center', justifyContent: 'center',
  },
  rowText: { flex: 1, minWidth: 0, marginLeft: 14 },
  nameLine: { flexDirection: 'row', alignItems: 'center', marginBottom: 3 },
  rowName: { fontSize: 16, fontFamily: 'Roboto-Medium' },
  metaRow: { flexDirection: 'row', alignItems: 'center' },
  metaArrow: { marginRight: 4 },
  metaMedia: { marginRight: 5 },
  rowMeta: { fontSize: 13, fontFamily: 'Roboto-Regular', flexShrink: 1 },

  // right column: time on top, redial/checkbox below (WhatsApp layout)
  rightCol: {
    marginLeft: 10,
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 8,
    minWidth: 56,
  },
  timeText: { fontSize: 12, fontFamily: 'Roboto-Regular' },
  callBtnRight: {
    paddingVertical: 2,
    paddingLeft: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hit: { top: 10, bottom: 10, left: 10, right: 10 },

  // selection visuals
  avatarCheck: {
    position: 'absolute',
    right: -2, bottom: -2,
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  checkbox: {
    width: 24, height: 24, borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },

  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },

  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 36,
    paddingBottom: 60,
  },
  emptyIcon: {
    width: 92, height: 92, borderRadius: 46,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 22,
  },
  emptyTitle: { fontSize: 19, fontFamily: 'Roboto-SemiBold', marginBottom: 8 },
  emptySubText: { fontSize: 14, fontFamily: 'Roboto-Regular', textAlign: 'center', lineHeight: 20 },

  footerLoad: { paddingVertical: 18, alignItems: 'center' },

  fab: {
    position: 'absolute',
    right: 18,
    bottom: 24,
    width: 56, height: 56, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.22,
        shadowRadius: 8,
      },
      android: { elevation: 6 },
    }),
  },

  // delete confirmation modal
  deleteOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  deleteCard: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 22,
    paddingTop: 24,
    paddingBottom: 16,
    paddingHorizontal: 22,
    alignItems: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.25,
        shadowRadius: 16,
      },
      android: { elevation: 10 },
    }),
  },
  deleteIconWrap: {
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 16,
  },
  deleteTitle: { fontSize: 18, fontFamily: 'Roboto-SemiBold', textAlign: 'center', marginBottom: 8 },
  deleteSubtitle: {
    fontSize: 13.5, fontFamily: 'Roboto-Regular',
    textAlign: 'center', lineHeight: 20, marginBottom: 22,
  },
  deleteActions: { flexDirection: 'row', alignItems: 'center', gap: 12, width: '100%' },
  deleteCancelBtn: {
    flex: 1,
    height: 46, borderRadius: 23,
    borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
  },
  deleteCancelText: { fontSize: 15, fontFamily: 'Roboto-Medium' },
  deleteConfirmBtn: {
    flex: 1,
    height: 46, borderRadius: 23,
    alignItems: 'center', justifyContent: 'center',
  },
  deleteConfirmText: { fontSize: 15, fontFamily: 'Roboto-SemiBold', color: '#fff' },
});
