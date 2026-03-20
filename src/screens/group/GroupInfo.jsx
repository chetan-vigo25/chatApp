import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, Image, ScrollView,
  ActivityIndicator, Animated, StyleSheet, Alert, Modal,
  Platform, ToastAndroid,
} from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';
import { Ionicons, MaterialCommunityIcons, FontAwesome6 } from '@expo/vector-icons';
import { useDispatch, useSelector } from 'react-redux';
import { viewGroup, deleteGroup, transferOwnership } from '../../Redux/Reducer/Group/Group.reducer';
import { useRealtimeChat } from '../../contexts/RealtimeChatContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
const AVATAR_COLORS = ['#6C5CE7', '#00B894', '#E17055', '#0984E3', '#E84393', '#00CEC9', '#FDCB6E', '#D63031'];
const getAvatarColor = (n) => { if (!n) return AVATAR_COLORS[0]; let h = 0; for (let i = 0; i < n.length; i++) h = n.charCodeAt(i) + ((h << 5) - h); return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]; };
const showToast = (m) => { Platform.OS === 'android' ? ToastAndroid.show(m, ToastAndroid.SHORT) : Alert.alert('', m); };

const getMemberUser = (m) => {
  if (!m) return {};
  const u = (typeof m.userId === 'object' && m.userId !== null) ? m.userId : {};
  return {
    id: u._id || (typeof m.userId === 'string' ? m.userId : null) || m._id,
    fullName: u.fullName || m.fullName || m.name || 'Unknown',
    profileImage: u.profileImage || m.profileImage || null,
    email: u.email || m.email || null,
  };
};

export default function GroupInfo({ navigation, route }) {
  const { theme, isDarkMode } = useTheme();
  const dispatch = useDispatch();
  const { currentGroup, isLoading } = useSelector((s) => s.group);
  const { leaveGroup, removeChat, removeGroupMember: socketRemoveMember, promoteGroupMember, demoteGroupMember } = useRealtimeChat();
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const [currentUserId, setCurrentUserId] = useState(null);
  const [memberActionVisible, setMemberActionVisible] = useState(false);
  const [selectedMember, setSelectedMember] = useState(null);
  const [transferModalVisible, setTransferModalVisible] = useState(false);

  const routeItem = route.params?.item;
  const groupId = route.params?.groupId || routeItem?.groupId || routeItem?.group?._id || routeItem?.chatId || routeItem?._id;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 250, useNativeDriver: true }).start();
    if (groupId) dispatch(viewGroup({ groupId }));
    (async () => {
      const raw = await AsyncStorage.getItem('userInfo');
      const user = raw ? JSON.parse(raw) : null;
      setCurrentUserId(user?._id || user?.id);
    })();
  }, [groupId]);

  // ─── DATA ───
  const apiGroup = currentGroup?.group;
  const apiMembers = currentGroup?.members;
  const groupName = apiGroup?.name || routeItem?.chatName || routeItem?.group?.name || 'Group';
  const groupAvatarUrl = apiGroup?.avatar || routeItem?.chatAvatar || routeItem?.group?.avatar;
  const description = apiGroup?.description || routeItem?.group?.description || '';
  const createdAt = apiGroup?.createdAt || routeItem?.group?.createdAt;
  const isActive = apiGroup?.isActive !== false;
  const members = Array.isArray(apiMembers) ? apiMembers.filter((m) => m.status !== 'removed' && !m.isDeleted) : [];
  const ownerMember = members.find((m) => m.role === 'owner');
  const ownerId = getMemberUser(ownerMember).id || apiGroup?.ownerId || apiGroup?.createdBy || routeItem?.group?.ownerId || routeItem?.group?.createdBy;
  const ownerName = getMemberUser(ownerMember).fullName || 'Unknown';

  // ─── ROLE & PERMISSIONS ───
  const myMember = members.find((m) => { const uid = getMemberUser(m).id; return uid && String(uid) === String(currentUserId); });
  const myRole = myMember?.role || (currentUserId && String(ownerId) === String(currentUserId) ? 'owner' : 'member');
  const isOwner = myRole === 'owner';
  const isAdmin = isOwner || myRole === 'admin';
  const canAddMembers = isAdmin;
  const canEditGroup = isAdmin;
  const canRemoveMembers = isAdmin;
  const canPromoteDemote = isOwner;
  const canDeleteGroup = isOwner;
  const canTransferOwnership = isOwner;

  // ─── STATS ───
  const adminCount = members.filter((m) => m.role === 'admin').length;
  const memberCount = members.length;

  // ─── HELPERS ───
  const formatDate = (d) => { if (!d) return ''; const dt = new Date(d); return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); };
  const formatTime = (d) => { if (!d) return ''; const dt = new Date(d); return dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
  const formatJoinDate = (d) => { if (!d) return ''; return `Joined ${formatDate(d)}`; };

  // ─── ACTIONS ───
  const handleExitGroup = () => {
    Alert.alert('Exit Group', 'Are you sure you want to leave this group?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Exit', style: 'destructive', onPress: () => { leaveGroup(groupId); removeChat(groupId); showToast('Left the group'); navigation.reset({ index: 0, routes: [{ name: 'ChatList' }] }); } },
    ]);
  };
  const handleDeleteGroup = () => {
    Alert.alert('Delete Group', 'This will permanently delete the group for all members.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await dispatch(deleteGroup({ groupId, confirm: true })).unwrap();
          // Remove by groupId and also by route item _id/chatId to prevent duplicates
          removeChat(groupId);
          const altId = routeItem?.chatId || routeItem?._id;
          if (altId && altId !== groupId) removeChat(altId);
          showToast('Group deleted');
          navigation.reset({ index: 0, routes: [{ name: 'ChatList' }] });
        } catch (e) { console.error(e); }
      } },
    ]);
  };
  const handleRemoveMember = (member) => {
    const user = getMemberUser(member);
    if (member.role === 'owner' || String(user.id) === String(ownerId)) { showToast('Cannot remove the group owner'); setMemberActionVisible(false); setSelectedMember(null); return; }
    Alert.alert('Remove Member', `Remove ${user.fullName}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => { socketRemoveMember(groupId, user.id); showToast('Member removed'); dispatch(viewGroup({ groupId })); setMemberActionVisible(false); setSelectedMember(null); } },
    ]);
  };
  const handlePromoteMember = (member) => {
    const user = getMemberUser(member);
    Alert.alert('Make Admin', `Make ${user.fullName} a group admin?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Promote', onPress: () => { promoteGroupMember(groupId, user.id); showToast(`${user.fullName} is now an admin`); dispatch(viewGroup({ groupId })); setMemberActionVisible(false); setSelectedMember(null); } },
    ]);
  };
  const handleDemoteMember = (member) => {
    const user = getMemberUser(member);
    Alert.alert('Remove Admin', `Remove admin role from ${user.fullName}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Demote', style: 'destructive', onPress: () => { demoteGroupMember(groupId, user.id); showToast(`${user.fullName} is no longer an admin`); dispatch(viewGroup({ groupId })); setMemberActionVisible(false); setSelectedMember(null); } },
    ]);
  };
  const handleTransferOwnership = (member) => {
    const user = getMemberUser(member);
    Alert.alert('Transfer Ownership', `Make ${user.fullName} the new group owner?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Transfer', onPress: async () => { try { await dispatch(transferOwnership({ groupId, newOwnerId: user.id })).unwrap(); showToast('Ownership transferred'); setTimeout(() => dispatch(viewGroup({ groupId })), 500); } catch (e) { console.error(e); } setTransferModalVisible(false); } },
    ]);
  };
  const openMemberAction = (member) => {
    const user = getMemberUser(member);
    if (String(user.id) === String(currentUserId)) return;
    if (member.role === 'owner' || String(user.id) === String(ownerId)) return;
    if (!canRemoveMembers && !canPromoteDemote) return;
    setSelectedMember(member);
    setMemberActionVisible(true);
  };

  // ─── RENDER MEMBER ───
  const renderMember = (member, index) => {
    const user = getMemberUser(member);
    const color = getAvatarColor(user.fullName);
    const isSelf = String(user.id) === String(currentUserId);
    const memberIsOwner = member.role === 'owner' || String(user.id) === String(ownerId);
    const memberIsAdmin = member.role === 'admin';
    const isMuted = Boolean(member.isMuted);

    return (
      <TouchableOpacity
        key={user.id || member._id || index}
        onPress={() => openMemberAction(member)}
        activeOpacity={(canRemoveMembers || canPromoteDemote) && !isSelf && !memberIsOwner ? 0.6 : 1}
        style={styles.memberRow}
      >
        {/* Avatar */}
        <View>
          {user.profileImage ? (
            <Image source={{ uri: user.profileImage }} style={styles.memberAvatar} />
          ) : (
            <View style={[styles.memberAvatar, { backgroundColor: color }]}>
              <Text style={styles.memberAvatarText}>{user.fullName.charAt(0).toUpperCase()}</Text>
            </View>
          )}
          {memberIsOwner && (
            <View style={[styles.ownerStar, { backgroundColor: '#E17055' }]}>
              <Ionicons name="star" size={8} color="#fff" />
            </View>
          )}
        </View>

        {/* Info */}
        <View style={styles.memberInfo}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={[styles.memberName, { color: theme.colors.primaryTextColor }]} numberOfLines={1}>
              {user.fullName}{isSelf ? ' (You)' : ''}
            </Text>
            {isMuted && <Ionicons name="volume-mute" size={12} color={theme.colors.placeHolderTextColor} />}
          </View>
          <Text style={[styles.memberSub, { color: theme.colors.placeHolderTextColor }]} numberOfLines={1}>
            {user.email || formatJoinDate(member.joinedAt) || (member.canSendMessage === false ? 'Restricted' : '')}
          </Text>
        </View>

        {/* Role Badge */}
        {(memberIsOwner || memberIsAdmin) && (
          <View style={[styles.roleBadge, { backgroundColor: memberIsOwner ? '#E17055' + '15' : theme.colors.themeColor + '15' }]}>
            <Text style={[styles.roleBadgeText, { color: memberIsOwner ? '#E17055' : theme.colors.themeColor }]}>
              {memberIsOwner ? 'Owner' : 'Admin'}
            </Text>
          </View>
        )}

        {/* Chevron for actionable members */}
        {(canRemoveMembers || canPromoteDemote) && !isSelf && !memberIsOwner && (
          <Ionicons name="chevron-forward" size={16} color={theme.colors.placeHolderTextColor} style={{ marginLeft: 4 }} />
        )}
      </TouchableOpacity>
    );
  };

  // ─── LOADING ───
  if (isLoading && !currentGroup && !routeItem) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background, alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator size="large" color={theme.colors.themeColor} />
      </View>
    );
  }

  const cardBg = isDarkMode ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.018)';
  const dividerBg = isDarkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)';

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: theme.colors.background }]}>
      {/* ─── HEADER ─── */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.6} style={styles.headerBtn}>
          <FontAwesome6 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.primaryTextColor }]}>Group Info</Text>
        {canEditGroup && (
          <TouchableOpacity onPress={() => navigation.navigate('EditGroup', { groupId })} activeOpacity={0.6} style={styles.headerBtn}>
            <Ionicons name="create-outline" size={20} color={theme.colors.themeColor} />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 100 }}>

        {/* ═══ GROUP PROFILE HERO ═══ */}
        <View style={styles.heroSection}>
          <View style={[styles.heroAvatar, { backgroundColor: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]}>
            {groupAvatarUrl ? (
              <Image source={{ uri: groupAvatarUrl }} style={styles.heroAvatarImg} />
            ) : (
              <Ionicons name="people" size={48} color={theme.colors.placeHolderTextColor} />
            )}
          </View>
          <Text style={[styles.heroName, { color: theme.colors.primaryTextColor }]}>{groupName}</Text>
          <Text style={[styles.heroSub, { color: theme.colors.placeHolderTextColor }]}>
            Group · {memberCount} {memberCount === 1 ? 'participant' : 'participants'}
          </Text>
        </View>

        {/* ═══ QUICK ACTIONS ROW ═══ */}
        <View style={styles.quickActions}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            activeOpacity={0.7}
            style={[styles.quickBtn, { backgroundColor: cardBg }]}
          >
            <Ionicons name="chatbubble-outline" size={20} color={theme.colors.themeColor} />
            <Text style={[styles.quickBtnLabel, { color: theme.colors.primaryTextColor }]}>Message</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {}}
            activeOpacity={0.7}
            style={[styles.quickBtn, { backgroundColor: cardBg }]}
          >
            <Ionicons name="search-outline" size={20} color={theme.colors.themeColor} />
            <Text style={[styles.quickBtnLabel, { color: theme.colors.primaryTextColor }]}>Search</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => Alert.alert('Report Group', 'Are you sure?', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Report', style: 'destructive', onPress: () => showToast('Group reported') },
            ])}
            activeOpacity={0.7}
            style={[styles.quickBtn, { backgroundColor: cardBg }]}
          >
            <Ionicons name="flag-outline" size={20} color="#F0A030" />
            <Text style={[styles.quickBtnLabel, { color: theme.colors.primaryTextColor }]}>Report</Text>
          </TouchableOpacity>
        </View>

        {/* ═══ DESCRIPTION CARD ═══ */}
        {description ? (
          <>
            <View style={[styles.divider, { backgroundColor: dividerBg }]} />
            <View style={styles.infoCard}>
              <Text style={[styles.infoCardLabel, { color: theme.colors.placeHolderTextColor }]}>Description</Text>
              <Text style={[styles.infoCardValue, { color: theme.colors.primaryTextColor }]}>{description}</Text>
            </View>
          </>
        ) : null}

        {/* ═══ GROUP DETAILS CARD ═══ */}
        <View style={[styles.divider, { backgroundColor: dividerBg }]} />
        <View style={styles.detailsCard}>
          {/* Created */}
          <View style={styles.detailRow}>
            <View style={[styles.detailIcon, { backgroundColor: '#6C5CE7' + '15' }]}>
              <Ionicons name="calendar-outline" size={16} color="#6C5CE7" />
            </View>
            <View style={styles.detailText}>
              <Text style={[styles.detailLabel, { color: theme.colors.placeHolderTextColor }]}>Created</Text>
              <Text style={[styles.detailValue, { color: theme.colors.primaryTextColor }]}>
                {formatDate(createdAt)}{createdAt ? ` at ${formatTime(createdAt)}` : ''}
              </Text>
            </View>
          </View>

          {/* Created By */}
          <View style={styles.detailRow}>
            <View style={[styles.detailIcon, { backgroundColor: '#00B894' + '15' }]}>
              <Ionicons name="person-outline" size={16} color="#00B894" />
            </View>
            <View style={styles.detailText}>
              <Text style={[styles.detailLabel, { color: theme.colors.placeHolderTextColor }]}>Created by</Text>
              <Text style={[styles.detailValue, { color: theme.colors.primaryTextColor }]}>{ownerName}</Text>
            </View>
          </View>

          {/* Members count */}
          <View style={styles.detailRow}>
            <View style={[styles.detailIcon, { backgroundColor: '#0984E3' + '15' }]}>
              <Ionicons name="people-outline" size={16} color="#0984E3" />
            </View>
            <View style={styles.detailText}>
              <Text style={[styles.detailLabel, { color: theme.colors.placeHolderTextColor }]}>Members</Text>
              <Text style={[styles.detailValue, { color: theme.colors.primaryTextColor }]}>
                {memberCount} total{adminCount > 0 ? ` · ${adminCount} admin${adminCount > 1 ? 's' : ''}` : ''}
              </Text>
            </View>
          </View>

          {/* Status */}
          <View style={styles.detailRow}>
            <View style={[styles.detailIcon, { backgroundColor: isActive ? '#25D366' + '15' : '#E53935' + '15' }]}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: isActive ? '#25D366' : '#E53935' }} />
            </View>
            <View style={styles.detailText}>
              <Text style={[styles.detailLabel, { color: theme.colors.placeHolderTextColor }]}>Status</Text>
              <Text style={[styles.detailValue, { color: isActive ? '#25D366' : '#E53935' }]}>{isActive ? 'Active' : 'Inactive'}</Text>
            </View>
          </View>

          {/* Your Role */}
          <View style={styles.detailRow}>
            <View style={[styles.detailIcon, { backgroundColor: '#E84393' + '15' }]}>
              <Ionicons name="shield-checkmark-outline" size={16} color="#E84393" />
            </View>
            <View style={styles.detailText}>
              <Text style={[styles.detailLabel, { color: theme.colors.placeHolderTextColor }]}>Your role</Text>
              <Text style={[styles.detailValue, { color: theme.colors.primaryTextColor, textTransform: 'capitalize' }]}>{myRole}</Text>
            </View>
          </View>
        </View>

        {/* ═══ MEMBERS SECTION ═══ */}
        <View style={[styles.divider, { backgroundColor: dividerBg }]} />
        <View style={styles.membersSection}>
          <View style={styles.membersSectionHeader}>
            <Ionicons name="people" size={16} color={theme.colors.placeHolderTextColor} />
            <Text style={[styles.sectionTitle, { color: theme.colors.placeHolderTextColor }]}>
              {memberCount} PARTICIPANTS
            </Text>
          </View>

          {canAddMembers && (
            <TouchableOpacity onPress={() => navigation.navigate('AddGroupMembers', { groupId, existingMemberIds: members.map((m) => getMemberUser(m).id).filter(Boolean) })} activeOpacity={0.6} style={styles.addMemberRow}>
              <View style={[styles.addMemberIcon, { backgroundColor: theme.colors.themeColor }]}>
                <Ionicons name="person-add" size={18} color="#fff" />
              </View>
              <Text style={[styles.addMemberText, { color: theme.colors.themeColor }]}>Add Participants</Text>
            </TouchableOpacity>
          )}

          {members.map((member, i) => renderMember(member, i))}
        </View>

        {/* ═══ ACTIONS ═══ */}
        <View style={[styles.divider, { backgroundColor: dividerBg }]} />
        <View style={styles.actionsSection}>
          {canTransferOwnership && members.length > 1 && (
            <TouchableOpacity onPress={() => setTransferModalVisible(true)} activeOpacity={0.6} style={styles.actionRow}>
              <View style={[styles.actionIcon, { backgroundColor: theme.colors.themeColor + '12' }]}>
                <MaterialCommunityIcons name="account-switch" size={20} color={theme.colors.themeColor} />
              </View>
              <Text style={[styles.actionLabel, { color: theme.colors.themeColor }]}>Transfer Ownership</Text>
              <Ionicons name="chevron-forward" size={16} color={theme.colors.placeHolderTextColor} />
            </TouchableOpacity>
          )}

          <TouchableOpacity onPress={handleExitGroup} activeOpacity={0.6} style={styles.actionRow}>
            <View style={[styles.actionIcon, { backgroundColor: '#E5393512' }]}>
              <Ionicons name="exit-outline" size={20} color="#E53935" />
            </View>
            <Text style={[styles.actionLabel, { color: '#E53935' }]}>Exit Group</Text>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.placeHolderTextColor} />
          </TouchableOpacity>

          {canDeleteGroup && (
            <TouchableOpacity onPress={handleDeleteGroup} activeOpacity={0.6} style={styles.actionRow}>
              <View style={[styles.actionIcon, { backgroundColor: '#E5393512' }]}>
                <Ionicons name="trash-outline" size={20} color="#E53935" />
              </View>
              <Text style={[styles.actionLabel, { color: '#E53935' }]}>Delete Group</Text>
              <Ionicons name="chevron-forward" size={16} color={theme.colors.placeHolderTextColor} />
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>

      {/* ═══ MEMBER ACTION MODAL ═══ */}
      <Modal transparent visible={memberActionVisible} onRequestClose={() => { setMemberActionVisible(false); setSelectedMember(null); }} animationType="fade">
        <TouchableOpacity activeOpacity={1} onPress={() => { setMemberActionVisible(false); setSelectedMember(null); }} style={styles.modalOverlay}>
          <TouchableOpacity activeOpacity={1} style={[styles.modalCard, { backgroundColor: theme.colors.cardBackground || theme.colors.menuBackground }]}>
            {(() => {
              const u = getMemberUser(selectedMember);
              const c = getAvatarColor(u.fullName);
              return (
                <View style={styles.modalHeader}>
                  {u.profileImage ? <Image source={{ uri: u.profileImage }} style={styles.modalAvatar} /> : (
                    <View style={[styles.modalAvatar, { backgroundColor: c }]}><Text style={styles.modalAvatarText}>{(u.fullName || '?').charAt(0).toUpperCase()}</Text></View>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.modalName, { color: theme.colors.primaryTextColor }]}>{u.fullName}</Text>
                    {u.email ? <Text style={[styles.modalEmail, { color: theme.colors.placeHolderTextColor }]}>{u.email}</Text> : null}
                    {selectedMember?.role ? <Text style={[styles.modalRole, { color: theme.colors.placeHolderTextColor }]}>Role: {selectedMember.role}</Text> : null}
                  </View>
                </View>
              );
            })()}

            <View style={[styles.modalDivider, { backgroundColor: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]} />

            {canPromoteDemote && selectedMember?.role !== 'owner' && (
              selectedMember?.role === 'admin' ? (
                <TouchableOpacity onPress={() => handleDemoteMember(selectedMember)} style={styles.modalOption}>
                  <Ionicons name="arrow-down-circle-outline" size={20} color="#F0A030" />
                  <Text style={[styles.modalOptionText, { color: '#F0A030' }]}>Remove Admin</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity onPress={() => handlePromoteMember(selectedMember)} style={styles.modalOption}>
                  <Ionicons name="arrow-up-circle-outline" size={20} color={theme.colors.themeColor} />
                  <Text style={[styles.modalOptionText, { color: theme.colors.themeColor }]}>Make Admin</Text>
                </TouchableOpacity>
              )
            )}

            {canRemoveMembers && selectedMember?.role !== 'owner' && String(getMemberUser(selectedMember).id) !== String(ownerId) && (
              <TouchableOpacity onPress={() => handleRemoveMember(selectedMember)} style={styles.modalOption}>
                <Ionicons name="person-remove-outline" size={20} color="#E53935" />
                <Text style={[styles.modalOptionText, { color: '#E53935' }]}>Remove from Group</Text>
              </TouchableOpacity>
            )}

            {canTransferOwnership && (
              <TouchableOpacity onPress={() => { setMemberActionVisible(false); setSelectedMember(null); setTimeout(() => handleTransferOwnership(selectedMember), 300); }} style={styles.modalOption}>
                <MaterialCommunityIcons name="account-switch" size={20} color={theme.colors.themeColor} />
                <Text style={[styles.modalOptionText, { color: theme.colors.themeColor }]}>Make Group Owner</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity onPress={() => { setMemberActionVisible(false); setSelectedMember(null); }} style={[styles.modalOption, { justifyContent: 'center', marginTop: 6 }]}>
              <Text style={{ fontFamily: 'Roboto-Medium', fontSize: 15, color: theme.colors.placeHolderTextColor }}>Cancel</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ═══ TRANSFER OWNERSHIP MODAL ═══ */}
      <Modal transparent visible={transferModalVisible} onRequestClose={() => setTransferModalVisible(false)} animationType="fade">
        <TouchableOpacity activeOpacity={1} onPress={() => setTransferModalVisible(false)} style={styles.modalOverlay}>
          <TouchableOpacity activeOpacity={1} style={[styles.modalCard, { backgroundColor: theme.colors.cardBackground || theme.colors.menuBackground, maxHeight: '60%' }]}>
            <Text style={[styles.transferTitle, { color: theme.colors.primaryTextColor }]}>Transfer Ownership</Text>
            <Text style={[styles.transferSub, { color: theme.colors.placeHolderTextColor }]}>Select a new owner</Text>
            <View style={[styles.modalDivider, { backgroundColor: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)', marginTop: 10 }]} />
            <ScrollView>
              {members.filter((m) => String(getMemberUser(m).id) !== String(currentUserId)).map((member) => {
                const u = getMemberUser(member);
                const c = getAvatarColor(u.fullName);
                return (
                  <TouchableOpacity key={u.id} onPress={() => handleTransferOwnership(member)} activeOpacity={0.6} style={styles.transferRow}>
                    {u.profileImage ? <Image source={{ uri: u.profileImage }} style={styles.transferAvatar} /> : (
                      <View style={[styles.transferAvatar, { backgroundColor: c }]}><Text style={styles.transferAvatarText}>{u.fullName.charAt(0).toUpperCase()}</Text></View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.transferName, { color: theme.colors.primaryTextColor }]}>{u.fullName}</Text>
                      <Text style={[styles.transferRole, { color: theme.colors.placeHolderTextColor }]}>{member.role}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={theme.colors.placeHolderTextColor} />
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Header
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, paddingVertical: 10, gap: 2 },
  headerBtn: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 21 },
  headerTitle: { flex: 1, fontFamily: 'Roboto-SemiBold', fontSize: 18, marginLeft: 4 },

  // Hero
  heroSection: { alignItems: 'center', paddingTop: 8, paddingBottom: 16 },
  heroAvatar: { width: 100, height: 100, borderRadius: 50, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginBottom: 14 },
  heroAvatarImg: { width: '100%', height: '100%' },
  heroName: { fontFamily: 'Roboto-SemiBold', fontSize: 22, textTransform: 'capitalize' },
  heroSub: { fontFamily: 'Roboto-Regular', fontSize: 14, marginTop: 4 },

  // Quick Actions
  quickActions: { flexDirection: 'row', justifyContent: 'center', paddingHorizontal: 20, gap: 12, paddingBottom: 12 },
  quickBtn: { flex: 1, alignItems: 'center', paddingVertical: 14, borderRadius: 14, gap: 6 },
  quickBtnLabel: { fontFamily: 'Roboto-Medium', fontSize: 12 },

  // Divider
  divider: { height: 6 },

  // Info Card
  infoCard: { paddingHorizontal: 20, paddingVertical: 14 },
  infoCardLabel: { fontFamily: 'Roboto-SemiBold', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  infoCardValue: { fontFamily: 'Roboto-Regular', fontSize: 14, lineHeight: 20 },

  // Details Card
  detailsCard: { paddingHorizontal: 16, paddingVertical: 8 },
  detailRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 14 },
  detailIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  detailText: { flex: 1, gap: 1 },
  detailLabel: { fontFamily: 'Roboto-Regular', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.3 },
  detailValue: { fontFamily: 'Roboto-Medium', fontSize: 14 },

  // Members
  membersSection: { paddingTop: 8 },
  membersSectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 20, paddingBottom: 6 },
  sectionTitle: { fontFamily: 'Roboto-SemiBold', fontSize: 12, letterSpacing: 0.5 },
  addMemberRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 14 },
  addMemberIcon: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  addMemberText: { fontFamily: 'Roboto-Medium', fontSize: 15, flex: 1 },
  memberRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 12 },
  memberAvatar: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  memberAvatarText: { color: '#fff', fontFamily: 'Roboto-SemiBold', fontSize: 18 },
  ownerStar: { position: 'absolute', bottom: 0, right: 0, width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' },
  memberInfo: { flex: 1, gap: 2 },
  memberName: { fontFamily: 'Roboto-Medium', fontSize: 15, textTransform: 'capitalize' },
  memberSub: { fontFamily: 'Roboto-Regular', fontSize: 12 },
  roleBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 },
  roleBadgeText: { fontFamily: 'Roboto-SemiBold', fontSize: 11 },

  // Actions
  actionsSection: { paddingVertical: 6 },
  actionRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 13, gap: 14 },
  actionIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  actionLabel: { fontFamily: 'Roboto-Medium', fontSize: 15, flex: 1 },

  // Modals
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', paddingHorizontal: 24 },
  modalCard: { borderRadius: 22, paddingVertical: 20, paddingHorizontal: 18 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingBottom: 14 },
  modalAvatar: { width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  modalAvatarText: { color: '#fff', fontFamily: 'Roboto-SemiBold', fontSize: 19 },
  modalName: { fontFamily: 'Roboto-SemiBold', fontSize: 17, textTransform: 'capitalize' },
  modalEmail: { fontFamily: 'Roboto-Regular', fontSize: 12, marginTop: 1 },
  modalRole: { fontFamily: 'Roboto-Medium', fontSize: 11, marginTop: 2, textTransform: 'capitalize' },
  modalDivider: { height: StyleSheet.hairlineWidth, marginBottom: 8 },
  modalOption: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12 },
  modalOptionText: { fontFamily: 'Roboto-Medium', fontSize: 15 },

  // Transfer Modal
  transferTitle: { fontFamily: 'Roboto-SemiBold', fontSize: 18, textAlign: 'center' },
  transferSub: { fontFamily: 'Roboto-Regular', fontSize: 13, textAlign: 'center', marginTop: 2 },
  transferRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 12 },
  transferAvatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  transferAvatarText: { color: '#fff', fontFamily: 'Roboto-SemiBold', fontSize: 16 },
  transferName: { fontFamily: 'Roboto-Medium', fontSize: 15, textTransform: 'capitalize' },
  transferRole: { fontFamily: 'Roboto-Regular', fontSize: 12, textTransform: 'capitalize', marginTop: 1 },
});