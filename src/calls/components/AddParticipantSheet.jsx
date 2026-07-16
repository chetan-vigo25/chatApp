import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Modal, View, Text, TouchableOpacity, FlatList, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useDispatch, useSelector } from 'react-redux';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';
import { viewGroup } from '../../Redux/Reducer/Group/Group.reducer';
import { toSecureMediaUri } from '../../utils/mediaService';
import CallAvatar from './CallAvatar';

/**
 * Mid-call "Add participant" picker for a GROUP call. Lists the group's members
 * who are NOT already on the call roster; selected members are rung into the
 * live call (they get a normal incoming-call request and join on Accept).
 *
 * Member source: redux `currentGroup` (the viewGroup fetch). It is re-fetched
 * on open when the slice holds a different group, so the list is correct even
 * if another group's info was viewed since.
 */
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

export default function AddParticipantSheet({ visible, onClose, groupId, existingIds = [], onInvite }) {
  const { theme, isDarkMode } = useTheme();
  const { user } = useAuth();
  const myId = user?._id ? String(user._id) : null;
  const dispatch = useDispatch();
  const { currentGroup } = useSelector((s) => s.group || {});
  const [selected, setSelected] = useState({});

  const cgId = currentGroup?.group?._id || currentGroup?.group?.id || null;
  const matches = sameId(cgId, groupId);

  // Fresh member list whenever the sheet opens for a group the slice doesn't
  // currently hold (or to pick up members added since the call started).
  useEffect(() => {
    if (!visible || !groupId) return;
    setSelected({});
    dispatch(viewGroup({ groupId })).catch(() => {});
  }, [visible, groupId, dispatch]);

  const candidates = useMemo(() => {
    if (!visible || !matches || !Array.isArray(currentGroup?.members)) return [];
    const excluded = new Set([...(existingIds || []).map(String), ...(myId ? [myId] : [])]);
    const out = [];
    const seen = new Set();
    currentGroup.members.forEach((m) => {
      if (!m || m.status === 'removed' || m.isDeleted) return;
      const u = (typeof m.userId === 'object' && m.userId !== null) ? m.userId : {};
      const id = u._id || (typeof m.userId === 'string' ? m.userId : null) || m._id || m.id;
      if (!id) return;
      const sid = String(id);
      if (excluded.has(sid) || seen.has(sid)) return;
      seen.add(sid);
      const img = u.profileImage || m.profileImage || null;
      out.push({
        id: sid,
        name: u.fullName || m.fullName || m.name || 'Member',
        avatar: img ? toSecureMediaUri(img) : null,
      });
    });
    return out;
  }, [visible, matches, currentGroup, existingIds, myId]);

  const toggle = useCallback((id) => {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const chosen = candidates.filter((c) => selected[c.id]);

  const invite = useCallback(() => {
    if (chosen.length && onInvite) onInvite(chosen);
    onClose && onClose();
  }, [chosen, onInvite, onClose]);

  const c = theme.colors;
  const cardBg = isDarkMode ? '#111B21' : '#FFFFFF';
  const rowBorder = isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const primary = isDarkMode ? '#FFFFFF' : c.primaryTextColor;
  const soft = isDarkMode ? 'rgba(255,255,255,0.65)' : c.secondaryTextColor;
  const accent = c.themeColor || '#03b0a2';

  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.card, { backgroundColor: cardBg }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: primary }]}>Add participant</Text>
            <TouchableOpacity onPress={onClose} hitSlop={styles.hit}>
              <Ionicons name="close" size={24} color={soft} />
            </TouchableOpacity>
          </View>
          {candidates.length === 0 ? (
            <Text style={[styles.empty, { color: soft }]}>
              {matches ? 'Everyone in this group is already on the call.' : 'Loading group members…'}
            </Text>
          ) : (
            <FlatList
              data={candidates}
              keyExtractor={(item) => item.id}
              style={styles.list}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.row, { borderBottomColor: rowBorder }]}
                  activeOpacity={0.7}
                  onPress={() => toggle(item.id)}
                >
                  <CallAvatar uri={item.avatar} name={item.name} id={item.id} size={40} />
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
          <TouchableOpacity
            style={[styles.inviteBtn, { backgroundColor: chosen.length ? accent : rowBorder }]}
            disabled={!chosen.length}
            activeOpacity={0.85}
            onPress={invite}
          >
            <Ionicons name="call" size={18} color="#fff" />
            <Text style={styles.inviteText}>
              {chosen.length ? `Ring ${chosen.length} member${chosen.length > 1 ? 's' : ''}` : 'Select members'}
            </Text>
          </TouchableOpacity>
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
    paddingTop: 16,
    paddingBottom: 28,
    maxHeight: '70%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  title: {
    fontFamily: 'Roboto-Medium',
    fontSize: 17,
  },
  empty: {
    fontFamily: 'Roboto-Regular',
    fontSize: 14,
    paddingVertical: 24,
    textAlign: 'center',
  },
  list: {
    flexGrow: 0,
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowName: {
    flex: 1,
    marginLeft: 12,
    fontFamily: 'Roboto-Regular',
    fontSize: 15.5,
  },
  inviteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 24,
    paddingVertical: 13,
    marginTop: 4,
  },
  inviteText: {
    color: '#fff',
    fontFamily: 'Roboto-Medium',
    fontSize: 15,
  },
  hit: { top: 8, bottom: 8, left: 8, right: 8 },
});
