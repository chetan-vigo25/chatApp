import { useEffect, useState } from 'react';
import {
  View, Text, Image, ScrollView, TouchableOpacity, ActivityIndicator,
  StyleSheet, Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../../contexts/ThemeContext';
import { apiCall } from '../../Config/Https';

const { width: SCREEN_W } = Dimensions.get('window');

const fmtDate = (v) => {
  if (!v) return null;
  try { return new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }); }
  catch { return null; }
};

/**
 * Read-only broadcast channel info / profile page. Opened from the channel
 * thread header. Renders the channel branding (logo, name, verified badge),
 * description, and read-only notice; fetches full details from the backend while
 * showing whatever the chat item already carries for an instant first paint.
 */
export default function ChannelInfo({ route, navigation }) {
  const { theme } = useTheme();
  const item = route?.params?.item || {};
  const channelId = route?.params?.channelId
    || item?.broadcastChannelId || item?.chatId || item?._id;

  const [channel, setChannel] = useState({
    name: item?.chatName || 'Channel',
    avatarUrl: item?.chatAvatar || null,
    isVerified: !!item?.isVerified,
    description: item?.description || null,
    messageCount: null,
    createdAt: null,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!channelId) { setLoading(false); return; }
      try {
        const res = await apiCall('get', `/api/v2/user/broadcast/channels/${channelId}`, {}, { silent: true });
        const d = res?.data;
        if (alive && d) {
          setChannel((prev) => ({
            ...prev,
            name: d.name || prev.name,
            avatarUrl: d.avatarUrl ?? prev.avatarUrl,
            isVerified: !!d.isVerified,
            description: d.description ?? prev.description,
            messageCount: d.messageCount ?? null,
            createdAt: d.createdAt || null,
          }));
        }
      } catch (e) { /* keep the item-derived values */ }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [channelId]);

  const C = theme.colors;
  const created = fmtDate(channel.createdAt);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: C.background }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: C.borderColor }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="arrow-back" size={24} color={C.primaryTextColor} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: C.primaryTextColor }]}>Channel info</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Branding */}
        <View style={styles.brandWrap}>
          {channel.avatarUrl ? (
            <Image source={{ uri: channel.avatarUrl }} style={styles.avatar} resizeMode="cover" />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: C.themeColor }]}>
              <Ionicons name="megaphone" size={48} color="#fff" />
            </View>
          )}

          <View style={styles.nameRow}>
            <Text style={[styles.name, { color: C.primaryTextColor }]} numberOfLines={2}>{channel.name}</Text>
            {channel.isVerified && (
              <Ionicons name="checkmark-circle" size={20} color={C.themeColor} style={{ marginLeft: 6 }} />
            )}
          </View>

          <View style={[styles.badge, { backgroundColor: C.menuBackground }]}>
            <Ionicons name="megaphone-outline" size={13} color={C.placeHolderTextColor} />
            <Text style={[styles.badgeText, { color: C.placeHolderTextColor }]}>
              Broadcast channel{channel.messageCount != null ? ` · ${channel.messageCount} message${channel.messageCount === 1 ? '' : 's'}` : ''}
            </Text>
          </View>
        </View>

        {/* Read-only notice */}
        <View style={[styles.notice, { backgroundColor: C.menuBackground }]}>
          <Ionicons name="lock-closed-outline" size={16} color={C.placeHolderTextColor} style={{ marginRight: 8 }} />
          <Text style={[styles.noticeText, { color: C.placeHolderTextColor }]}>
            Only the admin can post in this channel. You can read messages and open links.
          </Text>
        </View>

        {/* Description */}
        {channel.description ? (
          <View style={[styles.section, { borderTopColor: C.borderColor, borderBottomColor: C.borderColor }]}>
            <Text style={[styles.sectionLabel, { color: C.themeColor }]}>About</Text>
            <Text style={[styles.sectionBody, { color: C.primaryTextColor }]}>{channel.description}</Text>
          </View>
        ) : null}

        {created ? (
          <Text style={[styles.created, { color: C.placeHolderTextColor }]}>Created {created}</Text>
        ) : null}

        {loading && (
          <ActivityIndicator size="small" color={C.themeColor} style={{ marginTop: 16 }} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 14, borderBottomWidth: 0.5,
  },
  headerTitle: { fontSize: 17, fontFamily: 'Roboto-Medium' },
  brandWrap: { alignItems: 'center', paddingVertical: 28, paddingHorizontal: 24 },
  avatar: { width: 120, height: 120, borderRadius: 60 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'center', marginTop: 16, maxWidth: SCREEN_W - 64 },
  name: { fontSize: 23, fontFamily: 'Roboto-Medium', textAlign: 'center' },
  badge: {
    flexDirection: 'row', alignItems: 'center', marginTop: 10,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16,
  },
  badgeText: { fontSize: 12.5, fontFamily: 'Roboto-Regular', marginLeft: 6 },
  notice: {
    flexDirection: 'row', alignItems: 'center', marginHorizontal: 12,
    paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, marginTop: 4,
  },
  noticeText: { flex: 1, fontSize: 13, fontFamily: 'Roboto-Regular', lineHeight: 18 },
  section: {
    marginTop: 20, paddingHorizontal: 12, paddingVertical: 16,
    borderTopWidth: 0.5, borderBottomWidth: 0.5,
  },
  sectionLabel: { fontSize: 13, fontFamily: 'Roboto-Medium', marginBottom: 6 },
  sectionBody: { fontSize: 15, fontFamily: 'Roboto-Regular', lineHeight: 21 },
  created: { textAlign: 'center', fontSize: 12.5, fontFamily: 'Roboto-Regular', marginTop: 20 },
});
