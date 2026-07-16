import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Modal, View, Text, TouchableOpacity, FlatList, StyleSheet, Image,
  Platform, ToastAndroid, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useDispatch, useSelector } from 'react-redux';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';
import { viewGroup } from '../../Redux/Reducer/Group/Group.reducer';
import { toSecureMediaUri } from '../../utils/mediaService';
import { useCall } from '../useCall';
import CallAvatar from './CallAvatar';

/**
 * WhatsApp-style PRE-CALL "Select people" sheet for a GROUP chat. Lists the
 * group's other members with multi-select circles; the Voice / Video buttons
 * at the bottom ring only the chosen subset (enabled once ≥1 is selected).
 *
 * Member source: the `peers` prop when the caller already has the roster
 * (ChatScreen header), otherwise redux `currentGroup` — re-fetched on open via
 * viewGroup so the list is correct even if another group was viewed since.
 *
 * `onStart(media, chosenPeers)` — media is 'audio' | 'video'.
 */
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

const showToast = (m) => {
  if (Platform.OS === 'android') ToastAndroid.show(m, ToastAndroid.SHORT);
  else Alert.alert('', m);
};

export default function SelectPeopleSheet({
  visible, onClose, groupId, groupName, groupAvatar, peers = [], onStart,
}) {
  const { theme, isDarkMode } = useTheme();
  const { user } = useAuth();
  const myId = user?._id ? String(user._id) : null;
  const dispatch = useDispatch();
  const { currentGroup } = useSelector((s) => s.group || {});
  const { maxParticipants = 32 } = useCall();
  const [selected, setSelected] = useState({});

  const hasPeers = Array.isArray(peers) && peers.length > 0;
  const cgId = currentGroup?.group?._id || currentGroup?.group?.id || null;
  const matches = sameId(cgId, groupId);

  // Reset the selection each open; fetch the roster only when the caller
  // didn't supply one (or the slice holds a different group).
  useEffect(() => {
    if (!visible || !groupId) return;
    setSelected({});
    if (!hasPeers) dispatch(viewGroup({ groupId })).catch(() => {});
  }, [visible, groupId, hasPeers, dispatch]);

  const candidates = useMemo(() => {
    if (!visible) return [];
    if (hasPeers) return peers.filter((p) => p && p.id && !sameId(p.id, myId));
    if (!matches || !Array.isArray(currentGroup?.members)) return [];
    const out = [];
    const seen = new Set();
    currentGroup.members.forEach((m) => {
      if (!m || m.status === 'removed' || m.isDeleted) return;
      const u = (typeof m.userId === 'object' && m.userId !== null) ? m.userId : {};
      const id = u._id || (typeof m.userId === 'string' ? m.userId : null) || m._id || m.id;
      if (!id) return;
      const sid = String(id);
      if (sid === myId || seen.has(sid)) return;
      seen.add(sid);
      const img = u.profileImage || m.profileImage || null;
      out.push({
        id: sid,
        name: u.fullName || m.fullName || m.name || 'Member',
        avatar: img ? toSecureMediaUri(img) : null,
      });
    });
    return out;
  }, [visible, hasPeers, peers, matches, currentGroup, myId]);

  const maxOthers = Math.max(1, maxParticipants - 1);

  const toggle = useCallback((id) => {
    setSelected((prev) => {
      if (!prev[id]) {
        const count = Object.values(prev).filter(Boolean).length;
        if (count >= maxOthers) {
          showToast(`Group calls support up to ${maxParticipants} people`);
          return prev;
        }
      }
      return { ...prev, [id]: !prev[id] };
    });
  }, [maxOthers, maxParticipants]);

  const chosen = candidates.filter((c) => selected[c.id]);

  const start = useCallback((media) => {
    if (!chosen.length || !onStart) return;
    onStart(media, chosen);
  }, [chosen, onStart]);

  const c = theme.colors;
  const cardBg = isDarkMode ? '#111B21' : '#FFFFFF';
  const rowBorder = isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const primary = isDarkMode ? '#FFFFFF' : c.primaryTextColor;
  const soft = isDarkMode ? 'rgba(255,255,255,0.65)' : c.secondaryTextColor;
  const accent = c.themeColor || '#03b0a2';
  const btnIdleBg = isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const avatarUri = groupAvatar ? toSecureMediaUri(groupAvatar) : null;

  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.card, { backgroundColor: cardBg }]}>
          <View style={[styles.grabber, { backgroundColor: rowBorder }]} />

          {/* Group header: avatar · name + "Select people" · collapse chevron */}
          <View style={styles.header}>
            <View style={[styles.groupAvatar, { backgroundColor: isDarkMode ? '#233138' : '#E9EDEF' }]}>
              {avatarUri ? (
                <Image source={{ uri: avatarUri }} style={styles.groupAvatarImg} resizeMode="cover" />
              ) : (
                <Ionicons name="people" size={22} color={soft} />
              )}
            </View>
            <View style={styles.headerText}>
              <Text style={[styles.title, { color: primary }]} numberOfLines={1}>
                {groupName || 'Group'}
              </Text>
              <Text style={[styles.subtitle, { color: soft }]}>Select people</Text>
            </View>
            <TouchableOpacity
              onPress={onClose}
              style={[styles.collapseBtn, { backgroundColor: btnIdleBg }]}
              hitSlop={styles.hit}
            >
              <Ionicons name="chevron-down" size={20} color={primary} />
            </TouchableOpacity>
          </View>

          {candidates.length === 0 ? (
            <Text style={[styles.empty, { color: soft }]}>
              {hasPeers || matches ? 'No other members to call.' : 'Loading group members…'}
            </Text>
          ) : (
            <FlatList
              data={candidates}
              keyExtractor={(item) => item.id}
              style={styles.list}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.memberRow}
                  activeOpacity={0.7}
                  onPress={() => toggle(item.id)}
                >
                  <CallAvatar uri={item.avatar} name={item.name} id={item.id} size={42} />
                  <Text style={[styles.rowName, { color: primary }]} numberOfLines={1}>{item.name}</Text>
                  <Ionicons
                    name={selected[item.id] ? 'checkmark-circle' : 'ellipse-outline'}
                    size={24}
                    color={selected[item.id] ? accent : soft}
                  />
                </TouchableOpacity>
              )}
            />
          )}

          {/* Voice / Video — enabled once at least one member is selected */}
          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.callBtn, { backgroundColor: chosen.length ? accent : btnIdleBg }]}
              disabled={!chosen.length}
              activeOpacity={0.85}
              onPress={() => start('audio')}
            >
              <Ionicons name="call" size={18} color={chosen.length ? '#fff' : soft} />
              <Text style={[styles.callBtnText, { color: chosen.length ? '#fff' : soft }]}>Voice</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.callBtn, { backgroundColor: chosen.length ? accent : btnIdleBg }]}
              disabled={!chosen.length}
              activeOpacity={0.85}
              onPress={() => start('video')}
            >
              <Ionicons name="videocam" size={19} color={chosen.length ? '#fff' : soft} />
              <Text style={[styles.callBtnText, { color: chosen.length ? '#fff' : soft }]}>Video</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  card: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 24,
    maxHeight: '78%',
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  groupAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  groupAvatarImg: { width: '100%', height: '100%' },
  headerText: {
    flex: 1,
    marginLeft: 12,
  },
  title: {
    fontFamily: 'Roboto-Medium',
    fontSize: 16.5,
  },
  subtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    marginTop: 1,
  },
  collapseBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: {
    fontFamily: 'Roboto-Regular',
    fontSize: 14,
    paddingVertical: 26,
    textAlign: 'center',
  },
  list: {
    flexGrow: 0,
    marginBottom: 12,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
  },
  rowName: {
    flex: 1,
    marginLeft: 12,
    fontFamily: 'Roboto-Regular',
    fontSize: 15.5,
  },
  footer: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 4,
  },
  callBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 24,
    paddingVertical: 13,
  },
  callBtnText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 15,
  },
  hit: { top: 8, bottom: 8, left: 8, right: 8 },
});
