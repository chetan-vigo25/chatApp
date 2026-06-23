import React, { useCallback, useMemo, useState, memo } from 'react';
import {
  View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet, Image,
  ActivityIndicator, Platform, StatusBar,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import { useCall } from '../../calls/useCall';
import useContactDirectory from '../../hooks/useContactDirectory';
import useContactsPresence from '../../presence/hooks/useContactsPresence';
import { toSecureMediaUri } from '../../utils/mediaService';
import ContactDatabase from '../../services/ContactDatabase';
import CallAvatar from '../../calls/components/CallAvatar';
import ProfilePreviewModal from '../../components/ProfilePreviewModal';

const ROW_HEIGHT = 72;

// Stable letter-avatar color (matches the chat-list / preview palette).
const AVATAR_COLORS = ['#6C5CE7', '#00B894', '#0984E3', '#E17055', '#E84393', '#FDCB6E', '#00CEC9', '#A29BFE'];
const getAvatarColor = (name = '') => {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
};

// ─── one contact row (memoized — only re-renders when its primitives change) ──
const ContactRow = memo(function ContactRow({
  name, avatarUri, peerId, subText,
  textColor, subColor, themeColor, onAudio, onVideo, onPressName, onPressAvatar,
}) {
  return (
    <View style={[styles.row, { height: ROW_HEIGHT }]}>
      {/* Avatar → opens the WhatsApp-style profile preview modal. */}
      <TouchableOpacity onPress={onPressAvatar} activeOpacity={0.7}>
        {avatarUri ? (
          <Image source={{ uri: avatarUri }} style={styles.avatar} fadeDuration={0} />
        ) : (
          <CallAvatar uri={null} name={name} id={peerId} size={48} />
        )}
      </TouchableOpacity>

      {/* Name + number → opens the chat thread. */}
      <TouchableOpacity style={styles.rowText} activeOpacity={0.6} onPress={onPressName}>
        <Text style={[styles.rowName, { color: textColor }]} numberOfLines={1}>{name}</Text>
        <Text style={[styles.rowSub, { color: subColor }]} numberOfLines={1}>
          {subText}
        </Text>
      </TouchableOpacity>

      <View style={styles.rowActions}>
        <TouchableOpacity onPress={onAudio} activeOpacity={0.6} hitSlop={styles.hit} style={styles.actionBtn}>
          <Ionicons name="call" size={22} color={themeColor} />
        </TouchableOpacity>
        <TouchableOpacity onPress={onVideo} activeOpacity={0.6} hitSlop={styles.hit} style={styles.actionBtn}>
          <Ionicons name="videocam" size={23} color={themeColor} />
        </TouchableOpacity>
      </View>
    </View>
  );
}, (a, b) => (
  a.name === b.name && a.avatarUri === b.avatarUri
  && a.textColor === b.textColor && a.themeColor === b.themeColor
  && a.subText === b.subText
));

export default function NewCallScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation();
  const { startAudioCall, startVideoCall } = useCall();
  const { resolveName } = useContactDirectory();
  const { refresh: refreshPresence } = useContactsPresence();

  const [query, setQuery] = useState('');
  const [registered, setRegistered] = useState([]);
  const [loading, setLoading] = useState(true);

  // Fast path: read ONLY the registered (callable) contacts straight from SQLite
  // — a single targeted, indexed query (registered-only, ~the rows we render)
  // instead of routing through the contact-sync hook, which loads the ENTIRE
  // phonebook (`SELECT *`, registered + unregistered) plus three metadata reads
  // before any row can paint. Filtering by userId keeps out "Unknown User" rows.
  const loadRegistered = useCallback(async () => {
    try {
      const rows = await ContactDatabase.loadRegisteredContacts();
      setRegistered((rows || []).filter((c) => !!c.userId));
    } catch {
      // leave whatever we had; never block the screen on a DB hiccup
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload every time the screen gains focus so a contact that joined the app
  // (synced from elsewhere) shows up — but it's just one cheap SQLite read.
  useFocusEffect(useCallback(() => {
    loadRegistered();
    refreshPresence?.().catch(() => {});
  }, [loadRegistered, refreshPresence]));

  // Map registered → display rows ONCE (name resolution + secure avatar URI are
  // the per-row cost). Kept separate from the query filter so typing in search
  // never re-resolves names or re-builds URIs for the whole list.
  const rows = useMemo(() => {
    const mapped = registered.map((c) => {
      const peerId = String(c.userId);
      const name = resolveName(peerId, c.fullName || c.name || 'Unknown', c.originalPhone || c.normalizedPhone);
      const profileImageRaw = c.profileImage || c.profilePicture || null;
      const avatarUri = toSecureMediaUri(profileImageRaw) || null;
      const phone = c.mobileFormatted || c.originalPhone || c.normalizedPhone || '';
      return { peerId, name, avatarUri, profileImageRaw, phone };
    });
    // De-dup by peerId + sort by name once (search keeps this order).
    const seen = new Set();
    return mapped
      .filter((r) => (seen.has(r.peerId) ? false : seen.add(r.peerId)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [registered, resolveName]);

  const data = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    const rawQ = query.trim();
    return rows.filter((r) => r.name.toLowerCase().includes(q) || (r.phone || '').includes(rawQ));
  }, [rows, query]);

  const peerObjOf = useCallback((r) => ({
    id: r.peerId,
    name: r.name,
    avatar: r.avatarUri,
  }), []);

  // Full peerUser shape ChatScreen / UserB expect. With only `user` passed and no
  // chatId, ChatScreen builds the deterministic private chatId itself (opening an
  // existing thread or starting a fresh one).
  const peerUserOf = useCallback((r) => ({
    _id: r.peerId,
    userId: r.peerId,
    fullName: r.name,
    name: r.name,
    profileImage: r.profileImageRaw || null,
    mobile: { number: r.phone || null },
  }), []);

  // Start the call, then drop back to the previous screen so the call overlay
  // (rendered at the app root by CallProvider) takes over the foreground.
  const onAudio = useCallback((r) => {
    startAudioCall?.(peerObjOf(r));
    navigation.goBack();
  }, [startAudioCall, peerObjOf, navigation]);

  const onVideo = useCallback((r) => {
    startVideoCall?.(peerObjOf(r));
    navigation.goBack();
  }, [startVideoCall, peerObjOf, navigation]);

  // Tap the name/number → open the 1:1 chat thread.
  const openChat = useCallback((r) => {
    if (!r?.peerId) return;
    navigation.navigate('ChatScreen', { user: peerUserOf(r) });
  }, [navigation, peerUserOf]);

  // ─── Profile preview modal (avatar tap) ───
  const [selected, setSelected] = useState(null);
  const [profileVisible, setProfileVisible] = useState(false);

  const openProfile = useCallback((r) => {
    setSelected(r);
    setProfileVisible(true);
  }, []);
  const closeProfile = useCallback(() => setProfileVisible(false), []);

  // Let the modal dismiss before the call engine / next screen takes over.
  const previewCall = useCallback((media) => {
    const r = selected;
    closeProfile();
    if (!r) return;
    setTimeout(() => {
      if (media === 'video') startVideoCall?.(peerObjOf(r));
      else startAudioCall?.(peerObjOf(r));
    }, 220);
  }, [selected, closeProfile, startVideoCall, startAudioCall, peerObjOf]);

  const previewMessage = useCallback(() => {
    const r = selected;
    closeProfile();
    if (r) openChat(r);
  }, [selected, closeProfile, openChat]);

  const previewInfo = useCallback(() => {
    const r = selected;
    closeProfile();
    if (r) navigation.navigate('UserB', { item: { peerUser: peerUserOf(r), chatType: 'private' } });
  }, [selected, closeProfile, navigation, peerUserOf]);

  const c = theme.colors;
  const isDark = c.background !== '#ffffff';
  const insets = useSafeAreaInsets();

  const renderItem = useCallback(({ item }) => (
    <ContactRow
      name={item.name}
      avatarUri={item.avatarUri}
      peerId={item.peerId}
      subText={item.phone || 'Tap to call'}
      textColor={c.primaryTextColor}
      subColor={c.placeHolderTextColor}
      themeColor={c.themeColor}
      onAudio={() => onAudio(item)}
      onVideo={() => onVideo(item)}
      onPressName={() => openChat(item)}
      onPressAvatar={() => openProfile(item)}
    />
  ), [c.primaryTextColor, c.placeHolderTextColor, c.themeColor, onAudio, onVideo, openChat, openProfile]);

  return (
    <View style={[styles.container, { backgroundColor: c.background, }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={c.background} />

      {/* Top bar */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.6} hitSlop={styles.hit} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={c.primaryTextColor} />
        </TouchableOpacity>
        <View style={styles.topTitleWrap}>
          <Text style={[styles.topTitle, { color: c.primaryTextColor }]}>New call</Text>
          <Text style={[styles.topSub, { color: c.placeHolderTextColor }]}>
            {loading && !data.length ? 'Loading…' : `${data.length} contact${data.length === 1 ? '' : 's'}`}
          </Text>
        </View>
      </View>

      {/* Search */}
      <View style={styles.searchOuter}>
        <View style={[styles.searchInner, { backgroundColor: c.menuBackground || c.surface }]}>
          <Ionicons name="search-outline" size={18} color={c.placeHolderTextColor} style={styles.searchIcon} />
          <TextInput
            placeholder="Search contacts…"
            placeholderTextColor={c.placeHolderTextColor}
            value={query}
            onChangeText={setQuery}
            style={[styles.searchInput, { color: c.primaryTextColor }]}
            returnKeyType="search"
          />
          {query.length > 0 ? (
            <TouchableOpacity onPress={() => setQuery('')} activeOpacity={0.6} style={styles.searchClear}>
              <Ionicons name="close-circle" size={18} color={c.placeHolderTextColor} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {loading && !data.length ? (
        <View style={styles.centerFill}>
          <ActivityIndicator color={c.themeColor} />
        </View>
      ) : (
        <FlatList
          data={data}
          keyExtractor={(r, i) => r.peerId || String(i)}
          renderItem={renderItem}
          getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={data.length ? styles.listContent : styles.listEmpty}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={15}
          windowSize={9}
          removeClippedSubviews={Platform.OS === 'android'}
          ListHeaderComponent={data.length ? (
            <Text style={[styles.sectionLabel, { color: c.placeHolderTextColor }]}>
              Contacts on the app
            </Text>
          ) : null}
          ListEmptyComponent={(
            <View style={styles.emptyWrap}>
              <View style={[styles.emptyIcon, { backgroundColor: `${c.themeColor}1F` }]}>
                <MaterialCommunityIcons name="account-search-outline" size={38} color={c.themeColor} />
              </View>
              <Text style={[styles.emptyTitle, { color: c.primaryTextColor }]}>
                {query ? 'No matching contacts' : 'No contacts to call'}
              </Text>
              <Text style={[styles.emptySub, { color: c.placeHolderTextColor }]}>
                {query ? 'Try a different name or number.' : 'Sync your contacts to find people on the app.'}
              </Text>
            </View>
          )}
        />
      )}

      {/* WhatsApp-style profile preview (avatar tap) — same modal as the chat list. */}
      <ProfilePreviewModal
        visible={profileVisible}
        onClose={closeProfile}
        name={selected?.name || 'Unknown'}
        image={selected?.avatarUri || null}
        avatarColor={getAvatarColor(selected?.name || '')}
        isGroup={false}
        onMessage={previewMessage}
        onCall={() => previewCall('audio')}
        onVideo={() => previewCall('video')}
        onInfo={previewInfo}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  hit: { top: 10, bottom: 10, left: 10, right: 10 },

  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 8 },
  backBtn: { padding: 8 },
  topTitleWrap: { flex: 1, marginLeft: 4 },
  topTitle: { fontSize: 19, fontFamily: 'Roboto-SemiBold', letterSpacing: -0.2 },
  topSub: { fontSize: 12, fontFamily: 'Roboto-Regular', marginTop: 1 },

  searchOuter: { paddingHorizontal: 14, paddingTop: 4, paddingBottom: 8 },
  searchInner: { flexDirection: 'row', alignItems: 'center', borderRadius: 14, height: 46 },
  searchIcon: { marginLeft: 14 },
  searchInput: { flex: 1, fontFamily: 'Roboto-Regular', fontSize: 14, paddingHorizontal: 10, height: 46 },
  searchClear: { marginRight: 12 },

  sectionLabel: {
    fontSize: 11, fontFamily: 'Roboto-SemiBold', letterSpacing: 1.1,
    textTransform: 'uppercase', paddingHorizontal: 18, paddingTop: 10, paddingBottom: 6,
  },

  listContent: { paddingBottom: 30 },
  listEmpty: { flexGrow: 1 },

  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
  avatar: { width: 48, height: 48, borderRadius: 24 },
  rowText: { flex: 1, minWidth: 0, marginLeft: 14 },
  rowName: { fontSize: 16, fontFamily: 'Roboto-Medium', marginBottom: 2 },
  rowSub: { fontSize: 13, fontFamily: 'Roboto-Regular' },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actionBtn: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 21 },

  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36, paddingBottom: 60 },
  emptyIcon: {
    width: 88, height: 88, borderRadius: 44,
    alignItems: 'center', justifyContent: 'center', marginBottom: 20,
  },
  emptyTitle: { fontSize: 18, fontFamily: 'Roboto-SemiBold', marginBottom: 8 },
  emptySub: { fontSize: 14, fontFamily: 'Roboto-Regular', textAlign: 'center', lineHeight: 20 },
});
