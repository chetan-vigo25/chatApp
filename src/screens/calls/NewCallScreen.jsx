import React, { useCallback, useEffect, useMemo, useState, memo } from 'react';
import {
  View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet, Image,
  ActivityIndicator, Platform, StatusBar,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import { useCall } from '../../calls/useCall';
import useContactSync from '../../contexts/useContactSync';
import useContactDirectory from '../../hooks/useContactDirectory';
import useContactsPresence from '../../presence/hooks/useContactsPresence';
import { toSecureMediaUri } from '../../utils/mediaService';
import CallAvatar from '../../calls/components/CallAvatar';

const ROW_HEIGHT = 72;

// ─── one contact row (memoized — only re-renders when its primitives change) ──
const ContactRow = memo(function ContactRow({
  name, avatarUri, peerId, subText,
  textColor, subColor, themeColor, onAudio, onVideo,
}) {
  return (
    <View style={[styles.row, { height: ROW_HEIGHT }]}>
      <View>
        {avatarUri ? (
          <Image source={{ uri: avatarUri }} style={styles.avatar} fadeDuration={0} />
        ) : (
          <CallAvatar uri={null} name={name} id={peerId} size={48} />
        )}
      </View>

      <View style={styles.rowText}>
        <Text style={[styles.rowName, { color: textColor }]} numberOfLines={1}>{name}</Text>
        <Text style={[styles.rowSub, { color: subColor }]} numberOfLines={1}>
          {subText}
        </Text>
      </View>

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
  const {
    matchedRegistered = [], matchedContacts = [], loadContacts, refreshContacts, isSyncing,
  } = useContactSync();
  const { refresh: refreshPresence } = useContactsPresence();

  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  // Registered (callable) contacts only — never show "Unknown User" rows.
  const registered = useMemo(() => {
    const src = (matchedRegistered && matchedRegistered.length)
      ? matchedRegistered
      : (matchedContacts || []).filter((c) => !!c.userId);
    return src.filter((c) => !!c.userId);
  }, [matchedRegistered, matchedContacts]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await loadContacts?.();
        refreshPresence?.().catch(() => {});
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [loadContacts, refreshPresence]);

  const data = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = registered.map((c) => {
      const peerId = String(c.userId);
      const name = resolveName(peerId, c.fullName || c.name || 'Unknown', c.originalPhone || c.normalizedPhone);
      const avatarUri = toSecureMediaUri(c.profileImage || c.profilePicture) || null;
      const phone = c.mobileFormatted || c.originalPhone || c.normalizedPhone || '';
      return { peerId, name, avatarUri, phone, raw: c };
    });
    const filtered = q
      ? rows.filter((r) => r.name.toLowerCase().includes(q) || (r.phone || '').includes(query.trim()))
      : rows;
    // De-dup by peerId and sort by name (no duplicate/broken rows).
    const seen = new Set();
    return filtered
      .filter((r) => (seen.has(r.peerId) ? false : seen.add(r.peerId)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [registered, query, resolveName]);

  const peerObjOf = useCallback((r) => ({
    id: r.peerId,
    name: r.name,
    avatar: r.avatarUri,
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
    />
  ), [c.primaryTextColor, c.placeHolderTextColor, c.themeColor, onAudio, onVideo]);

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
            {isSyncing ? 'Syncing…' : `${data.length} contact${data.length === 1 ? '' : 's'}`}
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

      {loading ? (
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
