import React, { useCallback, useMemo, useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform, StatusBar,
  Modal, ActivityIndicator,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import { useCall } from '../../calls/useCall';
import useContactDirectory from '../../hooks/useContactDirectory';
import { toSecureMediaUri } from '../../utils/mediaService';
import { getCallStats, deleteCalls } from '../../calls/services/callLogService';
import CallAvatar from '../../calls/components/CallAvatar';

const CALL_GREEN = '#1DAB61'; // WhatsApp connected-call green
const CALL_RED = '#F15C6D';   // WhatsApp missed-call red
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Connected" = the call actually went through; everything else is a red entry.
const isConnected = (outcome) => outcome === 'completed';

// Direction arrow glyph + color (mirrors the call-list row).
const directionMeta = (direction, outcome) => {
  const connected = isConnected(outcome);
  if (direction === 'outgoing') {
    return connected
      ? { icon: 'call-made', color: CALL_GREEN }
      : { icon: 'call-missed-outgoing', color: CALL_RED };
  }
  return connected
    ? { icon: 'call-received', color: CALL_GREEN }
    : { icon: 'call-missed', color: CALL_RED };
};

// Long-form, WhatsApp-style descriptor for a single call event.
//   completed  → "Incoming voice call" / "Outgoing video call"
//   missed     → "Missed voice call"
//   rejected   → "Declined" (you) / "Declined" (peer)
//   cancelled  → outgoing "Cancelled" · incoming "Missed"
//   failed     → "Not connected"
const callDescriptor = (direction, outcome, media) => {
  const mediaWord = media === 'video' ? 'video call' : 'voice call';
  const isOut = direction === 'outgoing';
  switch (outcome) {
    case 'missed':
      return `Missed ${mediaWord}`;
    case 'rejected':
      return isOut ? `Declined ${mediaWord}` : `Declined ${mediaWord}`;
    case 'cancelled':
      return isOut ? `Cancelled ${mediaWord}` : `Missed ${mediaWord}`;
    case 'failed':
      return `Not connected · ${mediaWord}`;
    case 'completed':
    default:
      return `${isOut ? 'Outgoing' : 'Incoming'} ${mediaWord}`;
  }
};

// "5:42 PM" clock.
const fmtClock = (date) => {
  let h = date.getHours();
  const m = date.getMinutes();
  const ap = h >= 12 ? 'PM' : 'AM';
  h %= 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
};

// "Today" / "Yesterday" / "12 May" / "12 May 2023".
const dayLabel = (date) => {
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'Today';
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (date.toDateString() === yest.toDateString()) return 'Yesterday';
  const label = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear() ? label : `${label} ${date.getFullYear()}`;
};

// Human duration: "45 sec" · "5 min 3 sec" · "1 hr 2 min".
const fmtDuration = (sec) => {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s < 60) return `${s} sec`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  if (h > 0) return `${h} hr${m ? ` ${m} min` : ''}`;
  return `${m} min${rs ? ` ${rs} sec` : ''}`;
};

const callTimeOf = (c) => c.startedAt || c.createdAt || c.endedAt || c.answeredAt;

// "Today, 5:42 PM" · "12 May, 5:42 PM" — compact last-call stamp.
const lastCallLabel = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${dayLabel(d)}, ${fmtClock(d)}`;
};

// Aggregate counts from a set of call rows — used as an instant fallback before
// the server stats arrive (and as the source of truth for group calls).
const deriveStats = (calls = []) => {
  const s = {
    total: 0, incoming: 0, outgoing: 0, missed: 0, audio: 0, video: 0,
    totalDurationSec: 0, lastCallAt: null,
  };
  for (const c of calls) {
    s.total += 1;
    if (c.direction === 'incoming') s.incoming += 1; else s.outgoing += 1;
    if (c.direction === 'incoming' && (c.outcome === 'missed' || c.outcome === 'rejected')) s.missed += 1;
    if (c.media === 'video') s.video += 1; else s.audio += 1;
    s.totalDurationSec += Math.max(0, Number(c.durationSec) || 0);
    const t = new Date(callTimeOf(c)).getTime();
    if (!Number.isNaN(t) && (!s.lastCallAt || t > new Date(s.lastCallAt).getTime())) s.lastCallAt = callTimeOf(c);
  }
  return s;
};

export default function CallDetailScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation();
  const route = useRoute();
  const { startAudioCall, startVideoCall, startGroupAudioCall, startGroupVideoCall } = useCall();
  const { resolveName, directory } = useContactDirectory();

  const {
    peer = null,
    isGroup = false,
    groupName = null,
    participants = [],
    participantNames = null,
    calls = [],
  } = route.params || {};

  const peerId = String(peer?._id || peer?.id || '');
  const avatarUri = peer ? toSecureMediaUri(peer.profileImageUrl || peer.profileImage) || null : null;

  // Saved phone number from the device contact directory (the server only keeps
  // a hash, so the human-readable number lives on-device).
  const phone = useMemo(() => {
    const c = peerId ? directory?.[peerId] : null;
    return c?.phone || c?.normalizedPhone || null;
  }, [directory, peerId]);

  // Derive stats from the loaded rows as an instant fallback; the server stats
  // (full history) replace them once fetched.
  const localStats = useMemo(() => deriveStats(calls), [calls]);
  const [stats, setStats] = useState(localStats);
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => { setStats(localStats); }, [localStats]);

  // Authoritative counts for a 1:1 contact come from the backend aggregate
  // (covers the whole history, not just the rows passed in). Groups keep the
  // derived counts (peerId-scoped stats don't apply to a multi-party call).
  useEffect(() => {
    let alive = true;
    if (!isGroup && peerId) {
      getCallStats(peerId)
        .then((s) => { if (alive && s) setStats(s); })
        .catch(() => {});
    }
    return () => { alive = false; };
  }, [isGroup, peerId]);

  const name = useMemo(() => {
    if (isGroup) {
      const names = participantNames
        || (participants || []).map((u) => u?.fullName || u?.userName).filter(Boolean);
      return groupName || (names && names.length ? names.join(', ') : 'Group call');
    }
    return resolveName(peerId, peer?.fullName || peer?.userName || 'Unknown', null);
  }, [isGroup, groupName, participants, participantNames, peer, peerId, resolveName]);

  // Newest-first, then bucket into day sections (Today / Yesterday / dated).
  const sections = useMemo(() => {
    const sorted = [...(calls || [])].sort((a, b) => {
      const ta = new Date(callTimeOf(a)).getTime() || 0;
      const tb = new Date(callTimeOf(b)).getTime() || 0;
      return tb - ta;
    });
    const out = [];
    let current = null;
    sorted.forEach((c) => {
      const t = new Date(callTimeOf(c));
      const valid = !Number.isNaN(t.getTime());
      const title = valid ? dayLabel(t) : 'Earlier';
      if (!current || current.title !== title) {
        current = { title, data: [] };
        out.push(current);
      }
      current.data.push(c);
    });
    return out;
  }, [calls]);

  const total = (calls || []).length;
  const lastCall = sections[0]?.data?.[0] || (calls || [])[0] || null;

  const redial = useCallback((media) => {
    if (isGroup) {
      const peers = (participants || [])
        .map((u) => (u && u._id ? {
          id: String(u._id),
          name: u.fullName || u.userName || 'Member',
          avatar: toSecureMediaUri(u.profileImageUrl || u.profileImage) || null,
        } : null))
        .filter(Boolean);
      if (!peers.length) return;
      const opts = { groupName };
      if (media === 'video') startGroupVideoCall?.(peers, opts);
      else startGroupAudioCall?.(peers, opts);
      return;
    }
    if (!peerId) return;
    const peerObj = {
      id: peerId,
      name,
      avatar: avatarUri,
    };
    if (media === 'video') startVideoCall?.(peerObj);
    else startAudioCall?.(peerObj);
  }, [isGroup, participants, groupName, peerId, name, avatarUri,
    startAudioCall, startVideoCall, startGroupAudioCall, startGroupVideoCall]);

  const peerObjForNav = useMemo(() => ({
    _id: peerId,
    id: peerId,
    userId: peerId,
    name,
    fullName: name,
    profileImage: peer?.profileImage || peer?.profileImageUrl || '',
    profilePicture: peer?.profileImage || peer?.profileImageUrl || '',
  }), [peerId, name, peer]);

  // Send a message: open the chat thread with this contact.
  const openMessage = useCallback(() => {
    if (isGroup || !peerId) return;
    navigation.navigate('ChatScreen', { user: peerObjForNav });
  }, [isGroup, peerId, navigation, peerObjForNav]);

  // View the contact's profile.
  const openProfile = useCallback(() => {
    if (isGroup || !peerId) return;
    navigation.navigate('UserB', { item: peerObjForNav });
  }, [isGroup, peerId, navigation, peerObjForNav]);

  // Delete every call this detail page represents from MY history, then leave.
  const onConfirmDeleteRecord = useCallback(async () => {
    const callIds = (calls || []).map((x) => x.callId).filter(Boolean);
    setIsDeleting(true);
    try { await deleteCalls(callIds); } catch (_) { /* server best-effort */ }
    setIsDeleting(false);
    setDeleteModalVisible(false);
    navigation.goBack();
  }, [calls, navigation]);

  const c = theme.colors;
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.screen, { backgroundColor: c.background }]}>
      <StatusBar
        barStyle={c.background === '#ffffff' ? 'dark-content' : 'light-content'}
        backgroundColor={c.background}
      />

      {/* ── Top bar ── */}
      <View style={[styles.topBar, { borderBottomColor: c.borderColor }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          activeOpacity={0.6}
          hitSlop={styles.hit}
          style={styles.backBtn}
        >
          <Ionicons name="arrow-back" size={24} color={c.primaryTextColor} />
        </TouchableOpacity>
        <Text style={[styles.topTitle, { color: c.primaryTextColor }]}>Call info</Text>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scrollBody, { paddingBottom: insets.bottom + 40 }]}
      >
        {/* ── Hero: avatar + name + summary ── */}
        <View style={styles.hero}>
          {isGroup ? (
            <View style={[styles.groupHero, { backgroundColor: `${c.themeColor}26` }]}>
              <Ionicons name="people" size={56} color={c.themeColor} />
            </View>
          ) : (
            <CallAvatar uri={avatarUri} name={name} id={peerId} size={108} />
          )}
          <Text style={[styles.heroName, { color: c.primaryTextColor }]} numberOfLines={2}>
            {name}
          </Text>
          {!isGroup && phone ? (
            <Text style={[styles.heroPhone, { color: c.placeHolderTextColor }]} numberOfLines={1}>
              {phone}
            </Text>
          ) : null}
          {lastCall ? (
            <Text style={[styles.heroSub, { color: c.placeHolderTextColor }]}>
              {total} call{total === 1 ? '' : 's'}
              {lastCall.media === 'video' ? ' · Video' : ' · Voice'}
            </Text>
          ) : null}
        </View>

        {/* ── Quick actions ── */}
        <View style={styles.actions}>
          {!isGroup && peerId ? (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: c.surface }]}
              activeOpacity={0.75}
              onPress={openMessage}
            >
              <Ionicons name="chatbubble-ellipses-outline" size={21} color={c.themeColor} />
              <Text style={[styles.actionLabel, { color: c.primaryTextColor }]}>Message</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: c.surface }]}
            activeOpacity={0.75}
            onPress={() => redial('audio')}
          >
            <Ionicons name="call" size={21} color={c.themeColor} />
            <Text style={[styles.actionLabel, { color: c.primaryTextColor }]}>Audio</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: c.surface }]}
            activeOpacity={0.75}
            onPress={() => redial('video')}
          >
            <Ionicons name="videocam" size={21} color={c.themeColor} />
            <Text style={[styles.actionLabel, { color: c.primaryTextColor }]}>Video</Text>
          </TouchableOpacity>
          {!isGroup && peerId ? (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: c.surface }]}
              activeOpacity={0.75}
              onPress={openProfile}
            >
              <Ionicons name="person-outline" size={21} color={c.themeColor} />
              <Text style={[styles.actionLabel, { color: c.primaryTextColor }]}>Profile</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {/* ── Stats summary ── */}
        {/* {stats && stats.total > 0 ? (
          <View style={styles.section}>
            <Text style={[styles.sectionLabel, { color: c.placeHolderTextColor }]}>Overview</Text>
            <View style={[styles.statsCard, { backgroundColor: c.cardBackground, borderColor: c.borderColor }]}>
              <View style={styles.statsGrid}>
                {[
                  { label: 'Total', value: stats.total, icon: 'phone-outline', color: c.themeColor },
                  { label: 'Incoming', value: stats.incoming, icon: 'phone-incoming-outline', color: CALL_GREEN },
                  { label: 'Outgoing', value: stats.outgoing, icon: 'phone-outgoing-outline', color: CALL_GREEN },
                  { label: 'Missed', value: stats.missed, icon: 'phone-missed-outline', color: CALL_RED },
                  { label: 'Voice', value: stats.audio, icon: 'phone-outline', color: c.themeColor },
                  { label: 'Video', value: stats.video, icon: 'video-outline', color: c.themeColor },
                ].map((s) => (
                  <View key={s.label} style={styles.statCell}>
                    <MaterialCommunityIcons name={s.icon} size={18} color={s.color} />
                    <Text style={[styles.statValue, { color: c.primaryTextColor }]}>{s.value}</Text>
                    <Text style={[styles.statLabel, { color: c.placeHolderTextColor }]}>{s.label}</Text>
                  </View>
                ))}
              </View>
              <View style={[styles.statsFooter, { borderTopColor: c.borderColor }]}>
                <View style={styles.statsFooterItem}>
                  <Text style={[styles.statsFooterLabel, { color: c.placeHolderTextColor }]}>Total talk time</Text>
                  <Text style={[styles.statsFooterValue, { color: c.primaryTextColor }]}>
                    {fmtDuration(stats.totalDurationSec)}
                  </Text>
                </View>
                {stats.lastCallAt ? (
                  <View style={styles.statsFooterItem}>
                    <Text style={[styles.statsFooterLabel, { color: c.placeHolderTextColor }]}>Last call</Text>
                    <Text style={[styles.statsFooterValue, { color: c.primaryTextColor }]}>
                      {lastCallLabel(stats.lastCallAt)}
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>
          </View>
        ) : null} */}

        {/* ── Per-call history ── */}
        {sections.map((section) => (
          <View key={section.title} style={styles.section}>
            <Text style={[styles.sectionLabel, { color: c.placeHolderTextColor }]}>
              {section.title}
            </Text>
            <View style={[styles.sectionCard, { backgroundColor: c.cardBackground, borderColor: c.borderColor }]}>
              {section.data.map((call, idx) => {
                const { icon, color } = directionMeta(call.direction, call.outcome);
                const connected = isConnected(call.outcome);
                const t = new Date(callTimeOf(call));
                const timeStr = Number.isNaN(t.getTime()) ? '' : fmtClock(t);
                const descriptor = callDescriptor(call.direction, call.outcome, call.media);
                const showDuration = connected && Number(call.durationSec) > 0;
                return (
                  <View
                    key={String(call.callId || call._id || idx)}
                    style={[
                      styles.eventRow,
                      idx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.borderColor },
                    ]}
                  >
                    <View style={[styles.eventIconWrap, { backgroundColor: `${color}1A` }]}>
                      <MaterialIcons name={icon} size={20} color={color} />
                    </View>
                    <View style={styles.eventBody}>
                      <View style={styles.eventTitleRow}>
                        <Ionicons
                          name={call.media === 'video' ? 'videocam' : 'call'}
                          size={14}
                          color={c.placeHolderTextColor}
                          style={styles.eventMediaIcon}
                        />
                        <Text
                          style={[styles.eventTitle, { color: connected ? c.primaryTextColor : CALL_RED }]}
                          numberOfLines={1}
                        >
                          {descriptor}
                        </Text>
                      </View>
                      <Text style={[styles.eventMeta, { color: c.placeHolderTextColor }]} numberOfLines={1}>
                        {timeStr}{showDuration ? ` · ${fmtDuration(call.durationSec)}` : ''}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => redial(call.media)}
                      activeOpacity={0.6}
                      hitSlop={styles.hit}
                      style={styles.eventCallBtn}
                    >
                      <Ionicons
                        name={call.media === 'video' ? 'videocam-outline' : 'call-outline'}
                        size={20}
                        color={c.themeColor}
                      />
                    </TouchableOpacity>
                  </View>
                );
              })}
            </View>
          </View>
        ))}

        {!total && (
          <View style={styles.emptyWrap}>
            <MaterialCommunityIcons name="phone-off-outline" size={36} color={c.placeHolderTextColor} />
            <Text style={[styles.emptyText, { color: c.placeHolderTextColor }]}>
              No call details available
            </Text>
          </View>
        )}

        {/* ── Delete this call record ── */}
        {total > 0 ? (
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => setDeleteModalVisible(true)}
            style={styles.deleteRow}
          >
            <MaterialCommunityIcons name="delete-outline" size={21} color={CALL_RED} />
            <Text style={[styles.deleteRowText, { color: CALL_RED }]}>
              Delete call record{total > 1 ? 's' : ''}
            </Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>

      {/* Delete confirmation. */}
      <Modal
        animationType="fade"
        transparent
        visible={deleteModalVisible}
        onRequestClose={() => !isDeleting && setDeleteModalVisible(false)}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => !isDeleting && setDeleteModalVisible(false)}
          style={styles.modalOverlay}
        >
          <TouchableOpacity activeOpacity={1} style={[styles.modalCard, { backgroundColor: c.cardBackground }]}>
            <View style={[styles.modalIconWrap, { backgroundColor: `${CALL_RED}1A` }]}>
              <MaterialCommunityIcons name="delete-alert-outline" size={28} color={CALL_RED} />
            </View>
            <Text style={[styles.modalTitle, { color: c.primaryTextColor }]}>
              Delete {total} call record{total === 1 ? '' : 's'}?
            </Text>
            <Text style={[styles.modalSubtitle, { color: c.placeHolderTextColor }]}>
              This removes these entries from your call history. {isGroup ? 'Other members' : name} keep their own copy.
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                onPress={() => setDeleteModalVisible(false)}
                disabled={isDeleting}
                activeOpacity={0.7}
                style={[styles.modalCancelBtn, { borderColor: c.borderColor || '#e6e6e6' }]}
              >
                <Text style={[styles.modalCancelText, { color: c.primaryTextColor }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onConfirmDeleteRecord}
                disabled={isDeleting}
                activeOpacity={0.7}
                style={[styles.modalConfirmBtn, { backgroundColor: CALL_RED }]}
              >
                {isDeleting
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={styles.modalConfirmText}>Delete</Text>}
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  container: { flex: 1, paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight || 0 : 0 },
  hit: { top: 10, bottom: 10, left: 10, right: 10 },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { padding: 8 },
  topTitle: { fontSize: 18, fontFamily: 'Roboto-SemiBold', marginLeft: 6 },

  scrollBody: { paddingBottom: 40 },

  hero: { alignItems: 'center', paddingTop: 26, paddingBottom: 18, paddingHorizontal: 24 },
  groupHero: {
    width: 108, height: 108, borderRadius: 54,
    alignItems: 'center', justifyContent: 'center',
  },
  heroName: {
    fontSize: 22, fontFamily: 'Roboto-SemiBold',
    marginTop: 16, textAlign: 'center', letterSpacing: -0.2,
  },
  heroPhone: { fontSize: 14.5, fontFamily: 'Roboto-Regular', marginTop: 8 },
  heroSub: { fontSize: 13.5, fontFamily: 'Roboto-Regular', marginTop: 6 },

  actions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 22,
  },
  actionBtn: {
    flex: 1,
    height: 64,
    borderRadius: 14,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  actionLabel: { fontSize: 12.5, fontFamily: 'Roboto-Medium' },

  // stats card
  statsCard: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingVertical: 8,
  },
  statCell: {
    width: '33.33%',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 5,
  },
  statValue: { fontSize: 19, fontFamily: 'Roboto-SemiBold' },
  statLabel: { fontSize: 11.5, fontFamily: 'Roboto-Regular' },
  statsFooter: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 14,
    paddingHorizontal: 18,
  },
  statsFooterItem: { flex: 1 },
  statsFooterLabel: { fontSize: 11.5, fontFamily: 'Roboto-Regular', marginBottom: 3 },
  statsFooterValue: { fontSize: 14, fontFamily: 'Roboto-Medium' },

  // delete row + modal
  deleteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 22,
    paddingVertical: 16,
    marginTop: 4,
  },
  deleteRowText: { fontSize: 15, fontFamily: 'Roboto-Medium' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  modalCard: {
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
  modalIconWrap: {
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 16,
  },
  modalTitle: { fontSize: 18, fontFamily: 'Roboto-SemiBold', textAlign: 'center', marginBottom: 8 },
  modalSubtitle: {
    fontSize: 13.5, fontFamily: 'Roboto-Regular',
    textAlign: 'center', lineHeight: 20, marginBottom: 22,
  },
  modalActions: { flexDirection: 'row', alignItems: 'center', gap: 12, width: '100%' },
  modalCancelBtn: {
    flex: 1, height: 46, borderRadius: 23, borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
  },
  modalCancelText: { fontSize: 15, fontFamily: 'Roboto-Medium' },
  modalConfirmBtn: {
    flex: 1, height: 46, borderRadius: 23,
    alignItems: 'center', justifyContent: 'center',
  },
  modalConfirmText: { fontSize: 15, fontFamily: 'Roboto-SemiBold', color: '#fff' },

  section: { paddingHorizontal: 16, marginBottom: 18 },
  sectionLabel: {
    fontSize: 13, fontFamily: 'Roboto-Medium',
    marginBottom: 8, marginLeft: 4, textTransform: 'none',
  },
  sectionCard: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  eventIconWrap: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
  },
  eventBody: { flex: 1, minWidth: 0, marginLeft: 12 },
  eventTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 3 },
  eventMediaIcon: { marginRight: 6 },
  eventTitle: { fontSize: 15, fontFamily: 'Roboto-Medium', flexShrink: 1 },
  eventMeta: { fontSize: 12.5, fontFamily: 'Roboto-Regular' },
  eventCallBtn: { paddingLeft: 10, paddingVertical: 4 },

  emptyWrap: { alignItems: 'center', paddingTop: 40, gap: 10 },
  emptyText: { fontSize: 14, fontFamily: 'Roboto-Regular' },
});
