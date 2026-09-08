import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, Image, ScrollView,
  ActivityIndicator, Animated, StyleSheet, Alert, Modal,
  Platform, ToastAndroid, Dimensions, StatusBar,
} from 'react-native';

const { width: SCREEN_W } = Dimensions.get('window');
const HERO_H = Math.min(SCREEN_W, 380);
const STATUS_H = Platform.OS === 'ios' ? 50 : StatusBar.currentHeight || 24;
import { useTheme } from '../../contexts/ThemeContext';
import { Ionicons, MaterialCommunityIcons, FontAwesome6 } from '@expo/vector-icons';
import { useDispatch, useSelector } from 'react-redux';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { viewGroup, deleteGroup, transferOwnership } from '../../Redux/Reducer/Group/Group.reducer';
import { useRealtimeChatActions } from '../../contexts/RealtimeChatContext';
import { getSocket } from '../../Redux/Services/Socket/socket';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCall } from '../../calls/useCall';
import useContactDirectory from '../../hooks/useContactDirectory';
import ReportBottomSheet from '../../components/ReportBottomSheet';
import VerifiedBadge from '../../components/VerifiedBadge';
import GroupMemberSheet from '../../components/GroupMemberSheet';
import useDisplayName from '../../hooks/useDisplayName';
const AVATAR_COLORS = ['#6C5CE7', '#00B894', '#E17055', '#0984E3', '#E84393', '#00CEC9', '#FDCB6E', '#D63031'];
const getAvatarColor = (n) => { if (!n) return AVATAR_COLORS[0]; let h = 0; for (let i = 0; i < n.length; i++) h = n.charCodeAt(i) + ((h << 5) - h); return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]; };
const showToast = (m) => { Platform.OS === 'android' ? ToastAndroid.show(m, ToastAndroid.SHORT) : Alert.alert('', m); };

// Smooth dark bottom gradient (14 stacked bands, quadratic easing)
const GRADIENT_BANDS = 14;
const GRADIENT_HEIGHT = 220;
function HeroGradient() {
  const bandH = GRADIENT_HEIGHT / GRADIENT_BANDS;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, justifyContent: 'flex-end' }}>
      {Array.from({ length: GRADIENT_BANDS }).map((_, i) => {
        const t = (i + 1) / GRADIENT_BANDS;
        const alpha = Math.min(0.62, t * t * 0.7);
        return (
          <View
            key={i}
            style={{ height: bandH, backgroundColor: `rgba(0,0,0,${alpha.toFixed(3)})` }}
          />
        );
      })}
    </View>
  );
}

const getMemberUser = (m) => {
  if (!m) return {};
  const u = (typeof m.userId === 'object' && m.userId !== null) ? m.userId : {};
  // The populated user carries `mobile: { code, number }` (code includes the
  // leading '+'); older/flatter payload shapes may carry a plain string field.
  const mobileObj = (u.mobile && typeof u.mobile === 'object') ? u.mobile : null;
  const mobileFromObj = mobileObj?.number ? `${mobileObj.code || ''}${mobileObj.number}` : null;
  return {
    id: u._id || (typeof m.userId === 'string' ? m.userId : null) || m._id,
    fullName: u.fullName || m.fullName || m.name || 'Unknown',
    profileImage: u.profileImage || m.profileImage || null,
    email: u.email || m.email || null,
    mobile: u.mobileNumber || u.phoneNumber || u.phone || mobileFromObj || m.mobileNumber || m.phone || null,
    isVerified: Boolean(u.isVerified || m.isVerified),
    about: u.about || u.bio || u.status || null,
    // Contact privacy. These were NOT extracted before, so `resolveMemberName`
    // below always received `username: null, hideContact: false` and the
    // privacy branch could never fire — the group member list kept showing a
    // hidden member under the viewer's saved name for them.
    userName: u.userName || u.username || m.userName || null,
    hideContact: Boolean(
      u.hideContact ?? u.privacySettings?.hideContact ?? m.hideContact ?? false,
    ),
  };
};

export default function GroupInfo({ navigation, route }) {
  const { theme, isDarkMode } = useTheme();
  const insets = useSafeAreaInsets();
  const dispatch = useDispatch();
  const { startGroupAudioCall, startGroupVideoCall, startAudioCall, startVideoCall, callBusy } = useCall();
  // Status feed: "View status" appears on a member's sheet only when they have
  // a live status in the viewer's feed (privacy already applied server-side).
  const contactStatuses = useSelector((s) => s.status?.contactStatuses) || [];
  const { currentGroup, isLoading } = useSelector((s) => s.group);
  const { leaveGroup, removeChat, removeGroupMember: socketRemoveMember, promoteGroupMember, demoteGroupMember } = useRealtimeChatActions();
  // Device contact directory (local SQLite only) — still read by other parts of
  // this screen; names themselves go through the canonical resolver.
  const { directory } = useContactDirectory();
  const { resolveName, pushNameOf } = useDisplayName();
  // ONE rule (saved name → number → account name), shared with every other
  // screen. Re-renders automatically when the address book changes.
  const resolveMemberName = (m) => {
    const u = getMemberUser(m);
    return resolveName({
      userId: u.id,
      phone: u.mobile,
      pushName: u.fullName,
      // Contact privacy — group member list is surface #4.
      username: u.userName || null,
      hideContact: Boolean(u.hideContact),
      fallback: 'Member',
    });
  };
  // WhatsApp's secondary "~name" line: an UNSAVED member is identified by their
  // number, with the name they set on their own account shown beneath it.
  const resolveMemberPushName = (m) => {
    const u = getMemberUser(m);
    // hideContact MUST be passed: a "~account name" printed beside a hidden
    // member re-attaches the identity they just asked to withhold.
    return pushNameOf({
      userId: u.id, phone: u.mobile, pushName: u.fullName, hideContact: u.hideContact,
    });
  };
  const fadeAnim = useRef(new Animated.Value(0)).current;
  // Scroll position drives the collapsing header: the solid header bar + title
  // fade in once the hero has scrolled mostly off, so the back/edit buttons
  // never hover detached over the white content below.
  const scrollY = useRef(new Animated.Value(0)).current;
  const headerSolidOpacity = scrollY.interpolate({
    inputRange: [HERO_H * 0.3, HERO_H * 0.55],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const headerTitleOpacity = scrollY.interpolate({
    inputRange: [HERO_H * 0.42, HERO_H * 0.62],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  // Inverse of the solid fade — drives the over-hero (white icon on dark circle)
  // button layer so it fades OUT as the clean solid-header layer fades in.
  const headerHeroOpacity = scrollY.interpolate({
    inputRange: [HERO_H * 0.3, HERO_H * 0.55],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const membersRef = useRef([]);

  const [currentUserId, setCurrentUserId] = useState(null);
  const [reportVisible, setReportVisible] = useState(false);
  const [memberActionVisible, setMemberActionVisible] = useState(false);
  const [selectedMember, setSelectedMember] = useState(null);
  const [transferModalVisible, setTransferModalVisible] = useState(false);

  const routeItem = route.params?.item;
  const groupId = route.params?.groupId || routeItem?.groupId || routeItem?.group?._id || routeItem?.chatId || routeItem?._id;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 250, useNativeDriver: true }).start();
    if (groupId) {
      // Self-heal: if the backend says we're not a member, this is a stale local
      // chat row for a group we already left / were removed from. Drop the row and
      // back out instead of stranding the user on an un-loadable screen.
      dispatch(viewGroup({ groupId }))
        .unwrap()
        .catch((err) => {
          const msg = String(err?.message || err || '');
          const gone = /not found|has been deleted/i.test(msg);
          if (gone || /not a member|NOT_GROUP_MEMBER/i.test(msg)) {
            removeChat(groupId);
            const altId = routeItem?.chatId || routeItem?._id;
            if (altId && altId !== groupId) removeChat(altId);
            // The owner deleting the group and being removed from it are two
            // different messages — say which one actually happened.
            showToast(gone ? 'This group has been deleted' : 'You are no longer a member of this group');
            navigation.goBack();
          }
        });
    }
    (async () => {
      const raw = await AsyncStorage.getItem('userInfo');
      const user = raw ? JSON.parse(raw) : null;
      setCurrentUserId(user?._id || user?.id);
    })();
  }, [groupId]);

  // Realtime: when this group's name / avatar / description is changed by an
  // admin, re-fetch so the open info screen reflects it without a reload.
  useEffect(() => {
    if (!groupId) return undefined;
    let socket = null;
    const onGroupProfileChanged = (payload) => {
      const data = payload?.data || payload || {};
      const gid = String(data?.groupId || '');
      if (gid && gid === String(groupId)) dispatch(viewGroup({ groupId }));
    };
    // A member joined / left / was added / removed — re-fetch so the participant
    // list and count reflect the change live (e.g. 3 → 2 when someone leaves).
    const onGroupMembershipChanged = (payload) => {
      const data = payload?.data || payload || {};
      const gid = String(data?.groupId || '');
      if (gid && gid === String(groupId)) dispatch(viewGroup({ groupId }));
    };
    // A member changed their own profile — refresh so their avatar/name in the
    // member list updates live.
    const onContactUpdated = (payload) => {
      const data = payload?.data || payload || {};
      const updatedId = String(data?.contactUserId || data?.userId || data?._id || '');
      if (!updatedId) return;
      const isMember = (membersRef.current || []).some((m) => {
        const u = (typeof m?.userId === 'object' && m.userId) ? m.userId : {};
        const mId = String(u._id || (typeof m?.userId === 'string' ? m.userId : '') || m?._id || '');
        return mId && mId === updatedId;
      });
      if (isMember) dispatch(viewGroup({ groupId }));
    };
    const handlers = {
      'group:name:updated': onGroupProfileChanged,
      'group:avatar:updated': onGroupProfileChanged,
      'group:description:updated': onGroupProfileChanged,
      'contact:updated': onContactUpdated,
      'group:member:left': onGroupMembershipChanged,
      'group:member:removed': onGroupMembershipChanged,
      'group:member:remove:success': onGroupMembershipChanged,
      'group:member:added': onGroupMembershipChanged,
      'group:member:add:success': onGroupMembershipChanged,
      'group:member:joined': onGroupMembershipChanged,
    };
    // Track the socket we actually attached to so we can detach from it. The old
    // code re-attached every 2s forever and, if the socket instance was ever
    // replaced (re-auth), leaked the previous instance's listeners.
    const detach = () => {
      if (!socket) return;
      for (const evt of Object.keys(handlers)) socket.off(evt, handlers[evt]);
      socket = null;
    };
    const attach = () => {
      const s = getSocket?.();
      if (!s || s === socket) return;
      detach(); // moving to a fresh socket instance — clean the old one first
      for (const evt of Object.keys(handlers)) s.on(evt, handlers[evt]);
      socket = s;
    };
    attach();
    // The socket may not be ready on first mount. Retry briefly, then stop —
    // the socket.io instance is stable across reconnects, so once we're attached
    // there is nothing to re-poll for.
    let tries = 0;
    const interval = setInterval(() => {
      attach();
      if (socket || ++tries > 15) clearInterval(interval);
    }, 800);
    return () => {
      clearInterval(interval);
      detach();
    };
  }, [groupId, dispatch]);

  // ─── DATA ───
  // The redux `currentGroup` slice is GLOBAL — it holds whichever group was
  // viewed last. Reading it without checking WHICH group it holds meant this
  // screen could render (and, worse, DIAL) another group's roster, or a
  // half-loaded one: a 6-person group whose slice had resolved a single member
  // dialled that one person, and startCall infers isGroup from peers.length > 1,
  // so the group call silently became a 1:1 ("call went only to @ahmed").
  // SelectPeopleSheet / AddParticipantSheet already apply exactly this guard.
  // On a mismatch we treat the data as NOT loaded — the viewGroup dispatched on
  // mount fills it in a moment later.
  const loadedGroupId = currentGroup?.group?._id || currentGroup?.group?.id || null;
  const groupDataReady = !!loadedGroupId && !!groupId
    && String(loadedGroupId) === String(groupId);
  const apiGroup = groupDataReady ? currentGroup?.group : null;
  const apiMembers = groupDataReady ? currentGroup?.members : null;
  const groupName = apiGroup?.name || routeItem?.chatName || routeItem?.group?.name || 'Group';
  const groupAvatarUrl = apiGroup?.avatar || routeItem?.chatAvatar || routeItem?.group?.avatar;
  const description = apiGroup?.description || routeItem?.group?.description || '';
  const createdAt = apiGroup?.createdAt || routeItem?.group?.createdAt;
  const isActive = apiGroup?.isActive !== false;
  const members = Array.isArray(apiMembers) ? apiMembers.filter((m) => m.status !== 'removed' && !m.isDeleted) : [];
  membersRef.current = members;
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
  // Until the fetch for THIS group lands, `members` is deliberately empty (see
  // groupDataReady) — show the count the chat row already knew instead of "0".
  const memberCount = members.length
    || routeItem?.group?.memberCount || routeItem?.memberCount
    || (Array.isArray(routeItem?.members) ? routeItem.members.length : 0);

  // Start a group audio/video call with every other participant (WhatsApp parity).
  const startGroupCall = (media) => {
    const peers = (membersRef.current || [])
      .map((m) => {
        const u = getMemberUser(m);
        return u?.id ? { id: String(u.id), name: u.fullName || 'Member', avatar: u.profileImage || null } : null;
      })
      .filter(Boolean)
      .filter((p) => String(p.id) !== String(currentUserId));
    // Never dial a roster that isn't fully loaded: startCall decides
    // isGroup from peers.length > 1, so a partial list does not fail loudly —
    // it quietly places a 1:1 call to whoever happened to load first.
    if (!groupDataReady) {
      showToast('Group members are still loading. Please try again in a moment.');
      if (groupId) dispatch(viewGroup({ groupId }));
      return;
    }
    if (!peers.length) { showToast('No participants to call'); return; }
    // groupId matters as much as the name: it is what the mid-call "Add
    // participant" sheet re-fetches members with (viewGroup), and what the
    // ring payload carries to every callee. Without it the call falls back to
    // the ad-hoc contacts picker instead of the group's own member list.
    const opts = { groupId, groupName, isGroup: true };
    if (media === 'video') startGroupVideoCall?.(peers, opts);
    else startGroupAudioCall?.(peers, opts);
  };

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
  // Every other member opens the sheet (web parity): profile, message, calls and
  // status are for everyone; the admin rows inside are permission-gated.
  const openMemberAction = (member) => {
    const user = getMemberUser(member);
    if (!user.id || String(user.id) === String(currentUserId)) return;
    setSelectedMember(member);
    setMemberActionVisible(true);
  };

  const closeMemberAction = () => { setMemberActionVisible(false); setSelectedMember(null); };

  // Open (or start) the 1:1 chat with a member — same param shape the contact
  // screens use; ChatScreen resolves the chatId itself.
  const openMemberChat = (member) => {
    const user = getMemberUser(member);
    if (!user.id) return;
    const displayName = resolveMemberName(member);
    closeMemberAction();
    navigation.navigate('ChatScreen', {
      user: {
        _id: user.id, userId: user.id, id: user.id,
        name: displayName, fullName: displayName,
        profilePicture: user.profileImage || '',
        profileImage: user.profileImage || '',
      },
      chatId: null,
      hasExistingChat: false,
    });
  };

  const dialMember = (member, media) => {
    const user = getMemberUser(member);
    if (!user.id || callBusy) return;
    const peer = { id: String(user.id), name: resolveMemberName(member), avatar: user.profileImage || null };
    closeMemberAction();
    if (media === 'video') startVideoCall?.(peer); else startAudioCall?.(peer);
  };

  const memberStatusGroup = (member) => {
    const user = getMemberUser(member);
    if (!user.id) return null;
    const g = contactStatuses.find((x) => String(x.userId) === String(user.id));
    return g && Array.isArray(g.statuses) && g.statuses.length ? g : null;
  };

  const openMemberStatus = (member) => {
    const g = memberStatusGroup(member);
    if (!g) return;
    const user = getMemberUser(member);
    closeMemberAction();
    navigation.navigate('StatusViewer', {
      statuses: g.statuses || [],
      startIndex: 0,
      isMine: false,
      userName: resolveMemberName(member),
      userImage: g.avatar || g.profileImage || user.profileImage,
      userId: g.userId,
    });
  };

  // Tapping a member's avatar opens their full profile details page.
  const openMemberProfile = (member) => {
    const user = getMemberUser(member);
    if (!user.id) return;
    const displayName = resolveMemberName(member);
    navigation.navigate('UserB', {
      item: {
        _id: user.id,
        id: user.id,
        userId: user.id,
        fullName: displayName,
        name: displayName,
        profileImage: user.profileImage || '',
        profilePicture: user.profileImage || '',
        isVerified: user.isVerified,
      },
    });
  };

  // ─── RENDER MEMBER ───
  const renderMember = (member, index) => {
    const user = getMemberUser(member);
    const displayName = resolveMemberName(member);
    const color = getAvatarColor(displayName);
    const isSelf = String(user.id) === String(currentUserId);
    const memberPushName = isSelf ? null : resolveMemberPushName(member);
    const memberIsOwner = member.role === 'owner' || String(user.id) === String(ownerId);
    const memberIsAdmin = member.role === 'admin';
    const isMuted = Boolean(member.isMuted);

    return (
      <TouchableOpacity
        key={user.id || member._id || index}
        onPress={() => openMemberAction(member)}
        activeOpacity={isSelf ? 1 : 0.6}
        style={styles.memberRow}
      >
        {/* Avatar — tap opens the member's profile details page */}
        <TouchableOpacity
          onPress={isSelf ? undefined : () => openMemberProfile(member)}
          activeOpacity={isSelf ? 1 : 0.7}
        >
          {user.profileImage ? (
            <Image source={{ uri: user.profileImage }} style={styles.memberAvatar} />
          ) : (
            <View style={[styles.memberAvatar, { backgroundColor: color }]}>
              <Text style={styles.memberAvatarText}>{(displayName || 'U').charAt(0).toUpperCase()}</Text>
            </View>
          )}
          {memberIsOwner && (
            <View style={[styles.ownerStar, { backgroundColor: '#E17055' }]}>
              <Ionicons name="star" size={8} color="#fff" />
            </View>
          )}
        </TouchableOpacity>

        {/* Info */}
        <View style={styles.memberInfo}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={[styles.memberName, { color: theme.colors.primaryTextColor }]} numberOfLines={1}>
              {displayName}{isSelf ? ' (You)' : ''}
            </Text>
            <VerifiedBadge verified={user?.isVerified} size={13} style={{ marginLeft: 0 }} />
            {isMuted && <Ionicons name="volume-mute" size={12} color={theme.colors.placeHolderTextColor} />}
          </View>
          <Text style={[styles.memberSub, { color: theme.colors.placeHolderTextColor }]} numberOfLines={1}>
            {/* Unsaved member → "~their account name" (WhatsApp parity); saved
                members keep the existing email/joined-date subtitle. */}
            {memberPushName
              || user.email
              || formatJoinDate(member.joinedAt)
              || (member.canSendMessage === false ? 'Restricted' : '')}
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
        {!isSelf && (
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

  // Uniform colour: cards/boxes and the page all share the theme `background`
  // token (matching the contact-info screen), so nothing reads as a different
  // surface shade. Cards stay delineated only by their dividers/edges.
  const pageBg = theme.colors.background;
  const cardBg = theme.colors.background;
  const dividerBg = theme.colors.borderColor || (isDarkMode ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)');

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: pageBg }]}>
      <StatusBar translucent backgroundColor="transparent" barStyle={isDarkMode ? 'light-content' : 'dark-content'} />

      {/* ─── Floating header over hero — a small gap below the system status bar.
           The root SafeAreaView (RootNavigator) already insets the top on BOTH
           iOS and Android (edge-to-edge), so we add only a small constant here.
           Using the full status-bar height on Android double-counted the inset
           and left a large empty gap above the header. ─── */}
      <View style={[styles.floatingHeaderSafe, { paddingTop: 8 }]}>
        {/* Solid header surface — transparent over the hero, fades in on scroll */}
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: pageBg,
              opacity: headerSolidOpacity,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: theme.colors.borderColor || 'rgba(0,0,0,0.08)',
              elevation: 4,
              shadowColor: theme.colors.shadow,
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.08,
              shadowRadius: 4,
            },
          ]}
        />
        <View style={styles.floatingHeaderRow}>
          <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.7} style={styles.floatingBtnTouch}>
            {/* over the hero: white icon on a dark translucent circle */}
            <Animated.View style={[styles.floatingBtnLayer, styles.floatingBtnCircle, { opacity: headerHeroOpacity }]}>
              <FontAwesome6 name="arrow-left" size={18} color="#fff" />
            </Animated.View>
            {/* on the solid header: clean dark icon, no circle */}
            <Animated.View pointerEvents="none" style={[styles.floatingBtnLayer, { opacity: headerSolidOpacity }]}>
              <FontAwesome6 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
            </Animated.View>
          </TouchableOpacity>
          <Animated.Text
            numberOfLines={1}
            style={[styles.floatingHeaderTitle, { color: theme.colors.primaryTextColor, opacity: headerTitleOpacity }]}
          >
            {groupName}
          </Animated.Text>
          {canEditGroup ? (
            <TouchableOpacity onPress={() => navigation.navigate('EditGroup', { groupId })} activeOpacity={0.7} style={styles.floatingBtnTouch}>
              <Animated.View style={[styles.floatingBtnLayer, styles.floatingBtnCircle, { opacity: headerHeroOpacity }]}>
                <Ionicons name="create-outline" size={18} color="#fff" />
              </Animated.View>
              <Animated.View pointerEvents="none" style={[styles.floatingBtnLayer, { opacity: headerSolidOpacity }]}>
                <Ionicons name="create-outline" size={22} color={theme.colors.primaryTextColor} />
              </Animated.View>
            </TouchableOpacity>
          ) : (
            <View style={styles.floatingBtnTouch} />
          )}
        </View>
      </View>

      <Animated.ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 100 }}
        scrollEventThrottle={16}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })}
      >

        {/* ═══ TELEGRAM-STYLE GROUP HERO ═══ */}
        <View style={[styles.tgHero, { backgroundColor: groupAvatarUrl ? '#000' : getAvatarColor(groupName) }]}>
          {groupAvatarUrl ? (
            <Image source={{ uri: groupAvatarUrl }} style={styles.tgHeroImg} resizeMode="cover" />
          ) : (
            <View style={styles.tgHeroFallback}>
              <Ionicons name="people" size={92} color="rgba(255,255,255,0.85)" />
            </View>
          )}
          {/* Smooth bottom gradient (many thin bands) */}
          <HeroGradient />

          <View style={styles.tgHeroOverlay} pointerEvents="none">
            <Text style={styles.tgHeroName} numberOfLines={2}>{groupName}</Text>
            <Text style={styles.tgHeroSub} numberOfLines={1}>
              {memberCount} {memberCount === 1 ? 'participant' : 'participants'}
            </Text>
          </View>
        </View>

        {/* ═══ QUICK ACTIONS ROW ═══ */}
        <View style={styles.quickActions}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            activeOpacity={0.7}
            style={[styles.quickBtn, { backgroundColor: cardBg }]}
          >
            <Ionicons name="chatbubble" size={22} color={theme.colors.themeColor} />
            <Text style={[styles.quickBtnLabel, { color: theme.colors.themeColor }]}>Message</Text>
          </TouchableOpacity>
          {/* Group audio / video call — rings every other participant.
              Dimmed and inert while another call is in progress (callBusy),
              same rule as the chat-header call button. */}
          <TouchableOpacity
            onPress={() => startGroupCall('audio')}
            disabled={callBusy}
            activeOpacity={0.7}
            style={[styles.quickBtn, { backgroundColor: cardBg }, callBusy && styles.quickBtnDisabled]}
          >
            <Ionicons name="call" size={22} color={theme.colors.themeColor} />
            <Text style={[styles.quickBtnLabel, { color: theme.colors.themeColor }]}>Audio</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => startGroupCall('video')}
            disabled={callBusy}
            activeOpacity={0.7}
            style={[styles.quickBtn, { backgroundColor: cardBg }, callBusy && styles.quickBtnDisabled]}
          >
            <Ionicons name="videocam" size={22} color={theme.colors.themeColor} />
            <Text style={[styles.quickBtnLabel, { color: theme.colors.themeColor }]}>Video</Text>
          </TouchableOpacity>
        </View>

        {/* ═══ DESCRIPTION CARD ═══ */}
        {description ? (
          <View style={[styles.gCard, { backgroundColor: cardBg }]}>
            <View style={styles.gCardPad}>
              <Text style={[styles.infoCardLabel, { color: theme.colors.themeColor }]}>Description</Text>
              <Text style={[styles.infoCardValue, { color: theme.colors.primaryTextColor }]}>{description}</Text>
            </View>
          </View>
        ) : null}

        {/* ═══ GROUP DETAILS CARD ═══ */}
        <View style={[styles.gCard, { backgroundColor: cardBg }]}>
          {/* Created */}
          <View style={styles.detailRow}>
            <View style={[styles.detailIcon, { backgroundColor: '#6C5CE7' + '18' }]}>
              <Ionicons name="calendar-outline" size={16} color="#6C5CE7" />
            </View>
            <View style={styles.detailText}>
              <Text style={[styles.detailValue, { color: theme.colors.primaryTextColor }]}>
                {formatDate(createdAt)}{createdAt ? ` at ${formatTime(createdAt)}` : ''}
              </Text>
              <Text style={[styles.detailLabel, { color: theme.colors.placeHolderTextColor }]}>Created</Text>
            </View>
          </View>
          <View style={[styles.rowDivider, { backgroundColor: dividerBg }]} />

          {/* Created By */}
          <View style={styles.detailRow}>
            <View style={[styles.detailIcon, { backgroundColor: '#00B894' + '18' }]}>
              <Ionicons name="person-outline" size={16} color="#00B894" />
            </View>
            <View style={styles.detailText}>
              <Text style={[styles.detailValue, { color: theme.colors.primaryTextColor }]}>{ownerName}</Text>
              <Text style={[styles.detailLabel, { color: theme.colors.placeHolderTextColor }]}>Created by</Text>
            </View>
          </View>
          <View style={[styles.rowDivider, { backgroundColor: dividerBg }]} />

          {/* Your Role */}
          <View style={styles.detailRow}>
            <View style={[styles.detailIcon, { backgroundColor: '#E84393' + '18' }]}>
              <Ionicons name="shield-checkmark-outline" size={16} color="#E84393" />
            </View>
            <View style={styles.detailText}>
              <Text style={[styles.detailValue, { color: theme.colors.primaryTextColor, textTransform: 'capitalize' }]}>{myRole}</Text>
              <Text style={[styles.detailLabel, { color: theme.colors.placeHolderTextColor }]}>Your role</Text>
            </View>
          </View>
        </View>

        {/* ═══ MEMBERS SECTION ═══ */}
        <Text style={[styles.gSectionLabel, { color: theme.colors.placeHolderTextColor }]}>
          {memberCount} {memberCount === 1 ? 'PARTICIPANT' : 'PARTICIPANTS'}
        </Text>
        <View style={[styles.gCard, { backgroundColor: cardBg }]}>
          {canAddMembers && (
            <TouchableOpacity onPress={() => navigation.navigate('AddGroupMembers', { groupId, existingMemberIds: members.map((m) => getMemberUser(m).id).filter(Boolean) })} activeOpacity={0.6} style={styles.addMemberRow}>
              <View style={[styles.addMemberIcon, { backgroundColor: theme.colors.themeColor }]}>
                <Ionicons name="person-add" size={18} color="#fff" />
              </View>
              <Text style={[styles.addMemberText, { color: theme.colors.themeColor }]}>Add participants</Text>
            </TouchableOpacity>
          )}
          {members.map((member, i) => renderMember(member, i))}
        </View>

        {/* ═══ ACTIONS ═══ */}
        <View style={[styles.gCard, { backgroundColor: cardBg, marginBottom: 18 }]}>
          {canTransferOwnership && members.length > 1 && (
            <TouchableOpacity onPress={() => setTransferModalVisible(true)} activeOpacity={0.6} style={styles.actionRow}>
              <View style={[styles.actionIcon, { backgroundColor: theme.colors.themeColor + '14' }]}>
                <MaterialCommunityIcons name="account-switch" size={20} color={theme.colors.themeColor} />
              </View>
              <Text style={[styles.actionLabel, { color: theme.colors.themeColor }]}>Transfer ownership</Text>
              <Ionicons name="chevron-forward" size={16} color={theme.colors.placeHolderTextColor} />
            </TouchableOpacity>
          )}

          <TouchableOpacity onPress={() => setReportVisible(true)} activeOpacity={0.6} style={styles.actionRow}>
            <View style={[styles.actionIcon, { backgroundColor: '#E5393514' }]}>
              <Ionicons name="flag-outline" size={20} color={theme.colors.danger} />
            </View>
            <Text style={[styles.actionLabel, { color: theme.colors.danger }]}>Report group</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={handleExitGroup} activeOpacity={0.6} style={styles.actionRow}>
            <View style={[styles.actionIcon, { backgroundColor: '#E5393514' }]}>
              <Ionicons name="exit-outline" size={20} color={theme.colors.danger} />
            </View>
            <Text style={[styles.actionLabel, { color: theme.colors.danger }]}>Exit group</Text>
          </TouchableOpacity>

          {canDeleteGroup && (
            <TouchableOpacity onPress={handleDeleteGroup} activeOpacity={0.6} style={styles.actionRow}>
              <View style={[styles.actionIcon, { backgroundColor: '#E5393514' }]}>
                <Ionicons name="trash-outline" size={20} color={theme.colors.danger} />
              </View>
              <Text style={[styles.actionLabel, { color: theme.colors.danger }]}>Delete group</Text>
            </TouchableOpacity>
          )}
        </View>
      </Animated.ScrollView>

      <ReportBottomSheet
        visible={reportVisible}
        onClose={() => setReportVisible(false)}
        payload={{ reportType: 'group', groupId }}
      />

      {/* ═══ MEMBER SHEET — WhatsApp-style draggable bottom sheet (web parity) ═══ */}
      {(() => {
        if (!selectedMember) return <GroupMemberSheet visible={false} onClose={closeMemberAction} />;
        const u = getMemberUser(selectedMember);
        const name = resolveMemberName(selectedMember);
        const pushName = resolveMemberPushName(selectedMember);
        const targetRole = selectedMember.role === 'owner' || String(u.id) === String(ownerId) ? 'owner' : (selectedMember.role || 'member');
        // Backend rules mirrored (server re-checks): promote/demote + transfer
        // are OWNER-only; remove is owner (any non-owner) or admin (members only).
        const showPromote = isOwner && targetRole === 'member';
        const showDemote = isOwner && targetRole === 'admin';
        const showTransfer = isOwner && targetRole !== 'owner';
        const showRemove = targetRole !== 'owner' && (isOwner || (isAdmin && targetRole === 'member'));
        const statusGroup = memberStatusGroup(selectedMember);
        const unseen = statusGroup ? (statusGroup.statuses || []).filter((st) => !st.isViewed).length : 0;
        // The Alert-based handlers close the sheet themselves; the sheet has
        // already dismissed by the time they run, so a short defer keeps the
        // native Alert from racing the Modal teardown (iOS modal-swap freeze).
        const deferred = (fn) => () => setTimeout(() => fn(selectedMember), 250);
        return (
          <GroupMemberSheet
            visible={memberActionVisible}
            onClose={closeMemberAction}
            name={name}
            subtitle={pushName || (u.userName ? `@${u.userName}` : null)}
            about={u.about}
            image={u.profileImage || null}
            avatarColor={getAvatarColor(name)}
            roleLabel={targetRole === 'owner' ? 'Owner' : targetRole === 'admin' ? 'Admin' : null}
            isVerified={!!u.isVerified}
            callBusy={callBusy}
            hasStatus={!!statusGroup}
            statusUnseen={unseen}
            onMessage={() => openMemberChat(selectedMember)}
            onAudioCall={() => dialMember(selectedMember, 'audio')}
            onVideoCall={() => dialMember(selectedMember, 'video')}
            onViewStatus={() => openMemberStatus(selectedMember)}
            onViewProfile={() => openMemberProfile(selectedMember)}
            onPromote={showPromote ? deferred(handlePromoteMember) : undefined}
            onDemote={showDemote ? deferred(handleDemoteMember) : undefined}
            onTransfer={showTransfer ? deferred(handleTransferOwnership) : undefined}
            onRemove={showRemove ? deferred(handleRemoveMember) : undefined}
          />
        );
      })()}

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

  // Floating header (over hero)
  floatingHeaderSafe: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
  },
  floatingHeaderRow: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
  },
  floatingBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Cross-fading header button (over-hero ↔ solid-header)
  floatingBtnTouch: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  floatingBtnLayer: {
    position: 'absolute',
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  floatingBtnCircle: {
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  floatingHeaderTitle: {
    flex: 1,
    fontFamily: 'Roboto-SemiBold',
    fontSize: 17,
    marginHorizontal: 12,
    textTransform: 'capitalize',
  },

  // Telegram-style hero
  tgHero: { width: '100%', height: HERO_H, position: 'relative', overflow: 'hidden' },
  tgHeroImg: { width: '100%', height: '100%' },
  tgHeroFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tgHeroOverlay: { position: 'absolute', left: 20, right: 20, bottom: 18 },
  tgHeroName: {
    color: '#fff', fontFamily: 'Roboto-SemiBold', fontSize: 26, textTransform: 'capitalize',
    textShadowColor: 'rgba(0,0,0,0.4)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },
  tgHeroSub: {
    color: 'rgba(255,255,255,0.88)', fontFamily: 'Roboto-Regular', fontSize: 13, marginTop: 4,
    textShadowColor: 'rgba(0,0,0,0.4)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3,
  },

  // Quick Actions
  quickActions: { flexDirection: 'row', justifyContent: 'center', paddingHorizontal: 10, gap: 8, paddingTop: 12, paddingBottom: 2 },
  quickBtn: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: 14, gap: 5, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(128,128,128,0.18)' },
  quickBtnDisabled: { opacity: 0.4 },
  quickBtnLabel: { fontFamily: 'Roboto-Medium', fontSize: 12.5, letterSpacing: 0.1 },

  // Grouped inset card (WhatsApp)
  gCard: { marginHorizontal: 10, marginTop: 12, borderRadius: 14, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(128,128,128,0.18)' },
  gCardPad: { paddingHorizontal: 12, paddingVertical: 14 },
  gSectionLabel: { fontFamily: 'Roboto-Medium', fontSize: 11, letterSpacing: 0.8, marginTop: 16, marginBottom: 4, paddingHorizontal: 22 },
  rowDivider: { height: StyleSheet.hairlineWidth, marginLeft: 62 },

  // Description
  infoCardLabel: { fontFamily: 'Roboto-Medium', fontSize: 13, marginBottom: 5 },
  infoCardValue: { fontFamily: 'Roboto-Regular', fontSize: 15, lineHeight: 21 },

  // Details Card
  detailRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 14, gap: 14 },
  detailIcon: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  detailText: { flex: 1, gap: 2 },
  detailLabel: { fontFamily: 'Roboto-Regular', fontSize: 12.5 },
  detailValue: { fontFamily: 'Roboto-Medium', fontSize: 15 },

  // Members
  membersSection: { paddingTop: 8 },
  membersSectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 20, paddingBottom: 6 },
  sectionTitle: { fontFamily: 'Roboto-SemiBold', fontSize: 12, letterSpacing: 0.5 },
  addMemberRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 12, gap: 14 },
  addMemberIcon: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  addMemberText: { fontFamily: 'Roboto-Medium', fontSize: 15, flex: 1 },
  memberRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, gap: 12 },
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
  actionRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 13, gap: 14 },
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
  modalOption: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 18, gap: 12 },
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