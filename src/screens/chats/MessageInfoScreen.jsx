import React, { useEffect, useState, useCallback, useMemo } from 'react';
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

const ReceiptRow = ({ user, timestamp, palette }) => {
  const fullName = (user?.fullName || 'Unknown').trim();
  const initial = (fullName.charAt(0) || '?').toUpperCase();
  return (
    <View style={[styles.row, { borderBottomColor: palette.divider, backgroundColor: palette.surface }]}>
      {user?.profileImage ? (
        <Image source={{ uri: user.profileImage }} style={styles.avatar} />
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
          {timestamp ? moment(timestamp).format('ddd, MMM D · hh:mm A') : '—'}
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
  const { messageId, chatId, message } = route.params || {};

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
      brand: c.themeColor || '#25D366',
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
      readers.forEach((r) => data.push({ kind: 'row', key: `r-${r.userId}-${r.timestamp || ''}`, ...r }));
    }
    data.push({
      kind: 'section', key: 'sec-delivered', status: 'delivered',
      label: isGroup ? 'Delivered to' : 'Delivered',
      count: isGroup ? delivered.length : undefined,
    });
    if (delivered.length === 0) {
      data.push({ kind: 'empty', key: 'empty-delivered', label: 'Not delivered yet' });
    } else {
      delivered.forEach((d) => data.push({ kind: 'row', key: `d-${d.userId}-${d.timestamp || ''}`, ...d }));
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
    return <ReceiptRow user={item.user} timestamp={item.timestamp} palette={palette} />;
  }, [info, previewText, palette, isDarkMode]);

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
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 8,
  },
  sectionTitle: { marginLeft: 10, fontSize: 14, fontFamily: 'Roboto-SemiBold', letterSpacing: 0.2 },
  empty: { paddingHorizontal: 16, paddingVertical: 10, fontSize: 13, fontStyle: 'italic', fontFamily: 'Roboto-Regular' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
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
