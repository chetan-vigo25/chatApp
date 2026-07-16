import React, { useCallback, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Alert, Modal, Dimensions,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import { useCall } from '../useCall';
import SelectPeopleSheet from './SelectPeopleSheet';

const { width: SCREEN_W } = Dimensions.get('window');

/**
 * WhatsApp-style group-call control for a GROUP chat header: a single
 * camera+chevron button that opens a dropdown with three options —
 * Voice call / Video call (ring every other member, as before) and
 * Select people (opens a member-picker sheet, rings only the chosen subset).
 *
 * The mediasoup SFU scales a group call to maxParticipants (32 incl. self);
 * lists are trimmed to maxParticipants-1 others before dialing.
 *
 * `peers`: [{ id, name, avatar }] — other members, already excluding self.
 * `groupId`/`groupName`/`groupAvatar`: originating group (avatar feeds the
 * picker-sheet header only).
 *
 * Always rendered for a group — when the member list hasn't loaded yet the tap
 * explains, instead of the buttons silently not existing.
 */
export default function GroupCallButtons({ peers = [], groupId, groupName, groupAvatar }) {
  const { theme, isDarkMode } = useTheme();
  const {
    startGroupAudioCall, startGroupVideoCall, maxParticipants = 4, callBusy,
  } = useCall();
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuTop, setMenuTop] = useState(56);
  const [pickerVisible, setPickerVisible] = useState(false);
  const anchorRef = useRef(null);

  const cleanPeers = (peers || []).filter((p) => p && p.id);

  const dial = useCallback((media, list) => {
    const clean = (list || []).filter((p) => p && p.id);
    const trimmed = clean.slice(0, maxParticipants - 1);
    const dropped = clean.length - trimmed.length;
    if (!trimmed.length) {
      Alert.alert('Group call', 'Group members are still loading (or there is no other member to call). Please try again in a moment.');
      return;
    }
    const start = media === 'video' ? startGroupVideoCall : startGroupAudioCall;
    const go = () => start?.(trimmed, { groupId, groupName });
    if (dropped > 0) {
      Alert.alert(
        'Group call',
        `Group calls support up to ${maxParticipants} people. The first ${trimmed.length} members will be rung.`,
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Call', onPress: go }],
      );
    } else {
      go();
    }
  }, [maxParticipants, groupId, groupName, startGroupAudioCall, startGroupVideoCall]);

  const openMenu = useCallback(() => {
    const node = anchorRef.current;
    if (node && node.measureInWindow) {
      node.measureInWindow((x, y, w, h) => {
        setMenuTop(Math.max(40, y + h + 6));
        setMenuVisible(true);
      });
    } else {
      setMenuVisible(true);
    }
  }, []);

  const closeMenu = useCallback(() => setMenuVisible(false), []);

  const onMenuPick = useCallback((action) => {
    setMenuVisible(false);
    if (action === 'voice') {
      // Small delay lets the menu Modal fully dismiss before an Alert/call UI
      // takes over (stacked-modal issues on Android).
      setTimeout(() => dial('audio', cleanPeers), 160);
    } else if (action === 'video') {
      setTimeout(() => dial('video', cleanPeers), 160);
    } else if (action === 'select') {
      setTimeout(() => setPickerVisible(true), 160);
    }
  }, [dial, cleanPeers]);

  const startWithSelected = useCallback((media, chosen) => {
    setPickerVisible(false);
    setTimeout(() => dial(media, chosen), 200);
  }, [dial]);

  // Dim + disable while another call is in progress (can't start a second call).
  const color = callBusy ? theme.colors.secondaryTextColor : theme.colors.primaryTextColor;
  const menuBg = isDarkMode ? '#233138' : '#FFFFFF';
  const menuText = theme.colors.primaryTextColor;

  return (
    <View style={styles.row} ref={anchorRef} collapsable={false}>
      <TouchableOpacity
        onPress={openMenu}
        disabled={callBusy}
        activeOpacity={0.7}
        style={[styles.btn, callBusy && styles.disabled]}
        hitSlop={styles.hit}
      >
        <View style={styles.combo}>
          <Ionicons name="videocam-outline" size={23} color={color} />
          <Ionicons name="chevron-down" size={14} color={color} style={styles.caret} />
        </View>
      </TouchableOpacity>

      {/* Dropdown: Voice call / Video call / Select people */}
      <Modal visible={menuVisible} transparent animationType="fade" onRequestClose={closeMenu}>
        <TouchableOpacity style={styles.menuBackdrop} activeOpacity={1} onPress={closeMenu}>
          <View style={[styles.menuCard, { backgroundColor: menuBg, top: menuTop }]}>
            <TouchableOpacity style={styles.menuItem} activeOpacity={0.6} onPress={() => onMenuPick('voice')}>
              <Ionicons name="call-outline" size={20} color={menuText} />
              <Text style={[styles.menuLabel, { color: menuText }]}>Voice call</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} activeOpacity={0.6} onPress={() => onMenuPick('video')}>
              <Ionicons name="videocam-outline" size={20} color={menuText} />
              <Text style={[styles.menuLabel, { color: menuText }]}>Video call</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} activeOpacity={0.6} onPress={() => onMenuPick('select')}>
              <MaterialCommunityIcons name="account-check-outline" size={21} color={menuText} />
              <Text style={[styles.menuLabel, { color: menuText }]}>Select people</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Pre-call member picker ("Select people") */}
      <SelectPeopleSheet
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        groupId={groupId}
        groupName={groupName}
        groupAvatar={groupAvatar}
        peers={cleanPeers}
        onStart={startWithSelected}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  btn: { paddingHorizontal: 9, paddingVertical: 6 },
  combo: { flexDirection: 'row', alignItems: 'center' },
  caret: { marginLeft: 1, marginTop: 2 },
  disabled: { opacity: 0.4 },
  hit: { top: 8, bottom: 8, left: 8, right: 8 },
  menuBackdrop: { flex: 1 },
  menuCard: {
    position: 'absolute',
    right: 10,
    minWidth: Math.min(210, SCREEN_W * 0.6),
    borderRadius: 12,
    paddingVertical: 6,
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  menuLabel: {
    marginLeft: 14,
    fontFamily: 'Roboto-Regular',
    fontSize: 15.5,
  },
});
