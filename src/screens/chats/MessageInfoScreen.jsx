import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Image,
  ActivityIndicator,
  RefreshControl,
  Platform,
  StatusBar,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import moment from 'moment';
import { useTheme } from '../../contexts/ThemeContext';
import { getMessageInfo } from '../../Redux/Services/Chat/Chat.Services';
import { getSocket } from '../../Redux/Services/Socket/socket';
import { resolveDisplayName as resolveCanonicalName } from '../../services/contactNameStore';
import useDisplayName from '../../hooks/useDisplayName';
import { useRealtimeChatSlice } from '../../contexts/RealtimeChatContext';

const READ_BLUE = '#53BDEB';
const GRAY_LIGHT = '#8696A0';
const GRAY_DARK = '#AEBAC1';

const previewLabelFor = (preview) => {
  if (!preview) return '(no preview)';
  const text = (preview.text || '').trim();
  if (text) return text;
  const type = preview.messageType || 'media';
  const map = {
    image: '📷 Photo',
    video: '📹 Video',
    audio: '🎵 Audio',
    file: '📎 Document',
    location: '📍 Location',
    contact: '👤 Contact',
  };
  return map[type] || `[${type}]`;
};

// WhatsApp-style receipt time: "today at 3:42 pm" / "yesterday at 9:10 am" /
// "Jul 12, 2026 at 8:05 pm" — matches the Message info screen in WhatsApp.
const formatReceiptTime = (ts) => {
  if (!ts) return '—';
  const m = moment(ts);
  if (!m.isValid()) return '—';
  if (m.isSame(moment(), 'day')) return `today at ${m.format('h:mm a')}`;
  if (m.isSame(moment().subtract(1, 'day'), 'day')) return `yesterday at ${m.format('h:mm a')}`;
  return m.format('MMM D, YYYY [at] h:mm a');
};

const Tick = ({ status, size = 16, isDarkMode }) => {
  const gray = isDarkMode ? GRAY_DARK : GRAY_LIGHT;
  if (status === 'read' || status === 'seen') {
    return <Ionicons name="checkmark-done" size={size} color={READ_BLUE} />;
  }
  if (status === 'delivered') {
    return <Ionicons name="checkmark-done" size={size} color={gray} />;
  }
  return <Ionicons name="checkmark" size={size} color={gray} />;
};

// A receipt entry is not one fixed shape. The user fields may sit at the top
// level ({ userId, fullName, ... }), be nested under `user`/`userInfo`, arrive
// as a Mongo-POPULATED `userId` (an object, not an id string — the same shape
// GroupInfo's getMemberUser unwraps), or the entry may be nothing but the id
// string, as the socket receipts are (ChatSocketProvider's _appendReader rows).
//
// Getting this wrong is not cosmetic: it decides what reaches the resolver.
// Reading `entry.user` blindly gave `undefined` for the flat shape, which lost
// the userId too and printed "Unknown"; leaving a populated `userId` object in
// place made every store lookup miss, so a peer who is NOT hiding lost their
// saved name and number and fell through to their account name.
const normalizeReceipt = (entry) => {
  if (!entry) return { userId: null, fullName: null, phone: null, timestamp: null };
  if (typeof entry === 'string') return { userId: entry, fullName: null, phone: null, timestamp: null };

  const populated = (typeof entry.userId === 'object' && entry.userId !== null) ? entry.userId : null;
  const u = populated || entry.user || entry.userInfo || entry;
  // A populated user carries `mobile: { code, number }` (code includes the '+');
  // flatter payloads carry a plain string under one of several names.
  const mobileObj = (u?.mobile && typeof u.mobile === 'object') ? u.mobile : null;
  const mobileFromObj = mobileObj?.number ? `${mobileObj.code || ''}${mobileObj.number}` : null;

  return {
    userId: u?._id
      || (typeof entry.userId === 'string' ? entry.userId : null)
      || u?.userId
      || entry?._id
      || null,
    fullName: u?.fullName || u?.name || u?.displayName || entry?.fullName || entry?.name || null,
    phone: u?.mobileNumber || u?.phoneNumber || u?.phone || mobileFromObj
      || entry?.mobileNumber || entry?.phone || null,
    profileImage: u?.profileImage || u?.profilePic || u?.avatar || entry?.profileImage || null,
    userName: u?.userName || u?.username || u?.publicUsername
      || entry?.userName || entry?.publicUsername || null,
    hideContact: Boolean(
      u?.hideContact ?? u?.privacySettings?.hideContact ?? entry?.hideContact ?? false,
    ),
    timestamp: entry?.timestamp || entry?.readAt || entry?.deliveredAt || entry?.at || null,
  };
};

// The message-info API row is NOT a privacy-serialized user: it ships the raw
// fullName and omits `userName` / `hideContact`, so a peer with "Hide phone
// number & email" ON came back as plain "Chetan" here while the chat list and
// chat header — which name from the chat row's `peerUser` — correctly showed
// "@jangid". The receipt row is the same person, so the chat's own identity is
// layered underneath the API row to supply what it left out.
//
// hideContact is OR-ed, never overwritten: if EITHER source says the peer is
// hiding, the peer is hiding. Privacy fails closed; a payload that simply
// forgot the flag must not be read as consent to show the name.
const mergeIdentity = (who, local) => {
  if (!local) return who;
  return {
    ...who,
    fullName: who.fullName || local.fullName,
    phone: who.phone || local.phone,
    profileImage: who.profileImage || local.profileImage,
    userName: who.userName || local.userName,
    hideContact: Boolean(who.hideContact || local.hideContact),
  };
};

const ReceiptRow = ({ entry, timestamp, palette, resolveName, identityById }) => {
  const parsed = normalizeReceipt(entry);
  const who = mergeIdentity(parsed, identityById?.[String(parsed.userId)] || null);
  const resolve = resolveName || resolveCanonicalName;

  // ONE rule, shared with every other naming surface (chat list, chat screen,
  // group member list): saved contact name → number → the peer's own account
  // name — and, ahead of all of it, contact privacy. A peer with "Hide phone
  // number & email" ON is shown as "@handle" here exactly as they are
  // everywhere else; that is the promise PrivacyAccount makes to them
  // ("Everyone sees @username instead of your name and number"), so this screen
  // must not second-guess the resolver and substitute the account name back in.
  const fullName = resolve({
    userId: who.userId,
    phone: who.phone,
    pushName: who.fullName,
    // Contact privacy — read/delivered lists name every recipient.
    username: who.userName || null,
    hideContact: who.hideContact,
    fallback: 'Unknown',
  }).trim();

  // "@chetan" → "C": the marker is not an identity, the letter after it is.
  const initial = (fullName.replace(/^@/, '').charAt(0) || '?').toUpperCase();
  return (
    <View style={[styles.row, { borderBottomColor: palette.divider, backgroundColor: palette.surface }]}>
      {who.profileImage ? (
        <Image source={{ uri: who.profileImage }} style={styles.avatar} />
      ) : (
        <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: palette.brand }]}>
          <Text style={[styles.avatarInitial, { color: '#fff' }]}>{initial}</Text>
        </View>
      )}
      <View style={styles.rowBody}>
        <Text style={[styles.rowName, { color: palette.text }]} numberOfLines={1}>
          {fullName}
        </Text>
        <Text style={[styles.rowTime, { color: palette.subtleText }]}>
          {formatReceiptTime(timestamp)}
        </Text>
      </View>
    </View>
  );
};

const SectionHeader = ({ status, label, count, palette, isDarkMode }) => (
  <View style={[styles.sectionHeader, { backgroundColor: palette.background }]}>
    <Tick status={status} size={16} isDarkMode={isDarkMode} />
    <Text style={[styles.sectionTitle, { color: palette.text }]}>
      {`${label}${typeof count === 'number' ? ` · ${count}` : ''}`}
    </Text>
  </View>
);

export default function MessageInfoScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const { theme, isDarkMode } = useTheme();
  // Binds this screen to the contact directory: the hook loads the index (the
  // bare resolver does not) and re-renders on `contact:updated`, so a receipt
  // row shows the saved contact name instead of a raw number/account name even
  // when the screen opens before the address book has hydrated.
  const { resolveName, namesVersion } = useDisplayName();
  const { messageId, chatId, message } = route.params || {};

  // The chat this message belongs to, straight from the realtime store — the
  // same row the chat list names from, and the only place the client reliably
  // holds each participant's privacy state (see mergeIdentity above).
  const chatSelector = useCallback(
    (state) => (chatId ? (state?.chatMap?.[String(chatId)] || null) : null),
    [chatId],
  );
  const chatEntry = useRealtimeChatSlice(chatSelector);

  // userId → that participant's identity row. Covers the 1:1 peer and, for a
  // group, every member — flat or with a populated `userId` object.
  const identityById = useMemo(() => {
    const map = {};
    const add = (candidate) => {
      if (!candidate || typeof candidate !== 'object') return;
      const ident = normalizeReceipt(candidate);
      if (ident.userId) map[String(ident.userId)] = ident;
    };
    add(chatEntry?.peerUser);
    // ChatList reads `peerUser.hideContact ?? chat.hideContact` — the flag can
    // sit on the row itself, so fold that in rather than losing it.
    const peerId = normalizeReceipt(chatEntry?.peerUser || {}).userId;
    if (peerId && map[String(peerId)] && chatEntry?.hideContact) {
      map[String(peerId)] = { ...map[String(peerId)], hideContact: true };
    }
    const members = Array.isArray(chatEntry?.members)
      ? chatEntry.members
      : (Array.isArray(chatEntry?.participants) ? chatEntry.participants : []);
    members.forEach((m) => {
      add(m);
      if (m && typeof m.userId === 'object') add(m.userId);
    });
    return map;
  }, [chatEntry]);

  // Resolve a stable palette regardless of which theme keys exist.
  const palette = useMemo(() => {
    const c = theme?.colors || {};
    return {
      background: c.background || (isDarkMode ? '#000000' : '#ffffff'),
      surface: c.cardBackground || c.menuBackground || (isDarkMode ? '#1F2C33' : '#F7F8FA'),
      headerBg: c.menuBackground || c.cardBackground || (isDarkMode ? '#1F2C33' : '#F0F2F5'),
      text: c.primaryTextColor || (isDarkMode ? '#FFFFFF' : '#111B21'),
      subtleText: c.placeHolderTextColor || (isDarkMode ? '#AEBAC1' : '#667781'),
      divider: c.borderColor || (isDarkMode ? '#2A3942' : '#E9EDEF'),
      brand: c.themeColor || '#03b0a2',
      onBrand: c.textWhite || '#ffffff',
    };
  }, [theme, isDarkMode]);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await getMessageInfo({ messageId, chatId });
      setInfo(res?.data || null);
    } catch (e) {
      setError(typeof e === 'string' ? e : (e?.message || 'Failed to load message info'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [messageId, chatId]);

  useEffect(() => {
    if (messageId) {
      load();
    } else {
      setLoading(false);
      setError('Missing message id');
    }
  }, [messageId, load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  // Live refresh: while this screen is open, a receipt for THIS message
  // (someone read/delivered it) re-fetches the lists so the "Read by" /
  // "Delivered to" sections update in place instead of needing pull-to-refresh.
  const refetchTimerRef = useRef(null);
  useEffect(() => {
    const socket = getSocket();
    if (!socket || !messageId) return undefined;

    const scheduleRefetch = () => {
      if (refetchTimerRef.current) return; // coalesce receipt bursts
      refetchTimerRef.current = setTimeout(() => {
        refetchTimerRef.current = null;
        load();
      }, 600);
    };

    const onReceipt = (payload) => {
      const source = payload?.data || payload || {};
      const ids = Array.isArray(source?.messageIds)
        ? source.messageIds
        : [source?.messageId].filter(Boolean);
      if (ids.some((mid) => String(mid) === String(messageId))) scheduleRefetch();
    };

    const EVENTS = [
      'group:message:read',
      'group:message:read:update',
      'group:message:delivered:receipt',
      'group:message:delivered:update',
      'message:read',
      'message:delivered',
      'message:read:bulk:ack',
    ];
    EVENTS.forEach((ev) => socket.on(ev, onReceipt));
    return () => {
      EVENTS.forEach((ev) => socket.off(ev, onReceipt));
      if (refetchTimerRef.current) {
        clearTimeout(refetchTimerRef.current);
        refetchTimerRef.current = null;
      }
    };
  }, [messageId, load]);

  const isGroup = info?.chatType === 'group';
  const readers = useMemo(() => info?.readBy || [], [info]);
  const delivered = useMemo(() => info?.deliveredTo || [], [info]);

  const previewSource = info?.preview || message || null;
  const previewText = previewLabelFor(previewSource);

  const listData = useMemo(() => {
    const data = [{ kind: 'preview', key: 'preview' }];
    data.push({
      kind: 'section', key: 'sec-read', status: 'read',
      label: isGroup ? 'Read by' : 'Read',
      count: isGroup ? readers.length : undefined,
    });
    if (readers.length === 0) {
      data.push({ kind: 'empty', key: 'empty-read', label: 'Not read yet' });
    } else {
      // The entry is carried whole rather than spread: spreading it flattened
      // the receipt onto the list item and left `item.user` undefined for the
      // flat API shape, which is what made every name read "Unknown".
      readers.forEach((r, i) => {
        const { userId, timestamp } = normalizeReceipt(r);
        data.push({ kind: 'row', key: `r-${userId || i}-${timestamp || ''}`, entry: r, timestamp });
      });
    }
    data.push({
      kind: 'section', key: 'sec-delivered', status: 'delivered',
      label: isGroup ? 'Delivered to' : 'Delivered',
      count: isGroup ? delivered.length : undefined,
    });
    if (delivered.length === 0) {
      data.push({ kind: 'empty', key: 'empty-delivered', label: 'Not delivered yet' });
    } else {
      delivered.forEach((d, i) => {
        const { userId, timestamp } = normalizeReceipt(d);
        data.push({ kind: 'row', key: `d-${userId || i}-${timestamp || ''}`, entry: d, timestamp });
      });
    }
    return data;
  }, [isGroup, readers, delivered]);

  const renderItem = useCallback(({ item }) => {
    if (item.kind === 'preview') {
      return (
        <View style={[styles.previewCard, { backgroundColor: palette.surface, borderColor: palette.divider }]}>
          <Text style={[styles.previewText, { color: palette.text }]} numberOfLines={6}>
            {previewText}
          </Text>
          <View style={styles.previewMeta}>
            <Text style={[styles.previewTime, { color: palette.subtleText }]}>
              {info?.sentAt ? moment(info.sentAt).format('ddd, MMM D · hh:mm A') : ''}
            </Text>
            <View style={{ width: 6 }} />
            <Tick status={info?.status || 'sent'} size={14} isDarkMode={isDarkMode} />
          </View>
        </View>
      );
    }
    if (item.kind === 'section') {
      return (
        <SectionHeader
          status={item.status}
          label={item.label}
          count={item.count}
          palette={palette}
          isDarkMode={isDarkMode}
        />
      );
    }
    if (item.kind === 'empty') {
      return (
        <Text style={[styles.empty, { color: palette.subtleText, backgroundColor: palette.background }]}>
          {item.label}
        </Text>
      );
    }
    return (
      <ReceiptRow
        entry={item.entry}
        timestamp={item.timestamp}
        palette={palette}
        resolveName={resolveName}
        identityById={identityById}
      />
    );
  }, [info, previewText, palette, isDarkMode, resolveName, namesVersion, identityById]);

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <StatusBar
        barStyle={isDarkMode ? 'light-content' : 'dark-content'}
        backgroundColor={palette.headerBg}
      />
      <View style={[styles.header, { backgroundColor: palette.headerBg, borderBottomColor: palette.divider }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.headerBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="arrow-back" size={24} color={palette.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: palette.text }]}>Message info</Text>
        <View style={styles.headerBtn} />
      </View>

      {loading ? (
        <View style={[styles.center, { backgroundColor: palette.background }]}>
          <ActivityIndicator size="large" color={palette.brand} />
        </View>
      ) : error ? (
        <View style={[styles.center, { backgroundColor: palette.background }]}>
          <Ionicons name="alert-circle-outline" size={44} color={palette.subtleText} />
          <Text style={[styles.errorText, { color: palette.text }]}>{error}</Text>
          <TouchableOpacity
            style={[styles.retryBtn, { backgroundColor: palette.brand }]}
            onPress={() => { setLoading(true); load(); }}
          >
            <Text style={[styles.retryBtnText, { color: palette.onBrand }]}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={listData}
          renderItem={renderItem}
          keyExtractor={(item) => item.key}
          contentContainerStyle={{ paddingBottom: 40, backgroundColor: palette.background }}
          style={{ backgroundColor: palette.background }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={palette.brand}
              colors={[palette.brand]}
              progressBackgroundColor={palette.surface}
            />
          }
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: Platform.OS === 'ios' ? 10 : 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, fontSize: 18, fontFamily: 'Roboto-SemiBold' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorText: { marginTop: 12, fontSize: 14, textAlign: 'center', fontFamily: 'Roboto-Regular' },
  retryBtn: { marginTop: 16, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20 },
  retryBtnText: { fontFamily: 'Roboto-SemiBold' },
  previewCard: {
    marginHorizontal: 12,
    marginTop: 12,
    marginBottom: 8,
    padding: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  previewText: { fontSize: 15, lineHeight: 22, fontFamily: 'Roboto-Regular' },
  previewMeta: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', marginTop: 10 },
  previewTime: { fontSize: 11, fontFamily: 'Roboto-Regular' },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 18,
    paddingBottom: 8,
  },
  sectionTitle: { marginLeft: 10, fontSize: 14, fontFamily: 'Roboto-SemiBold', letterSpacing: 0.2 },
  empty: { paddingHorizontal: 12, paddingVertical: 10, fontSize: 13, fontStyle: 'italic', fontFamily: 'Roboto-Regular' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: { width: 42, height: 42, borderRadius: 21, marginRight: 12 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarInitial: { fontSize: 17, fontFamily: 'Roboto-Bold' },
  rowBody: { flex: 1 },
  rowName: { fontSize: 15, fontFamily: 'Roboto-Medium' },
  rowTime: { fontSize: 12, marginTop: 3, fontFamily: 'Roboto-Regular' },
});
