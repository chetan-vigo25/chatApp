import React, { useCallback, useState, useEffect } from 'react';
import { View, Text, FlatList, TouchableOpacity, Image, StyleSheet, RefreshControl, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useDispatch, useSelector } from 'react-redux';
import { useTheme } from '../../contexts/ThemeContext';
import { fetchMyStatuses, fetchContactStatuses } from '../../Redux/Reducer/Status/Status.reducer';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

const STATUS_COLORS = ['#075e54', '#128C7E', '#25D366', '#DCF8C6', '#34B7F1', '#FF6B6B', '#C44569', '#F8B500', '#6C5CE7', '#00B894'];

const timeAgo = (date) => {
  if (!date) return '';
  const diff = Date.now() - new Date(date).getTime();
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return 'Yesterday';
};

export default function StatusList({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const dispatch = useDispatch();
  const { myStatuses, contactStatuses, isLoading } = useSelector(state => state.status);
  const { user } = useSelector(state => state.authentication);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(() => {
    dispatch(fetchMyStatuses());
    dispatch(fetchContactStatuses());
  }, [dispatch]);

  useFocusEffect(useCallback(() => { loadData(); }, [loadData]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([dispatch(fetchMyStatuses()), dispatch(fetchContactStatuses())]);
    setRefreshing(false);
  }, [dispatch]);

  const hasMyStatus = myStatuses && myStatuses.length > 0;

  const renderMyStatus = () => (
    <TouchableOpacity
      style={[styles.statusItem, { backgroundColor: theme.colors.cardBackground }]}
      onPress={() => hasMyStatus
        ? navigation.navigate('StatusViewer', { statuses: myStatuses, startIndex: 0, isMine: true })
        : navigation.navigate('StatusCreate')
      }
    >
      <View style={styles.avatarContainer}>
        <Image
          source={user?.profileImage ? { uri: user.profileImage } : require('../../../assets/icon.png')}
          style={styles.avatar}
        />
        {hasMyStatus ? (
          <View style={[styles.statusRing, { borderColor: '#25D366' }]}>
            <Text style={styles.statusCount}>{myStatuses.length}</Text>
          </View>
        ) : (
          <View style={[styles.addButton, { backgroundColor: theme.colors.themeColor }]}>
            <Ionicons name="add" size={16} color="#fff" />
          </View>
        )}
      </View>
      <View style={styles.textContainer}>
        <Text style={[styles.name, { color: theme.colors.primaryTextColor }]}>My Status</Text>
        <Text style={[styles.time, { color: theme.colors.placeHolderTextColor }]}>
          {hasMyStatus ? `${myStatuses.length} status${myStatuses.length > 1 ? 'es' : ''} • ${timeAgo(myStatuses[0]?.createdAt)}` : 'Tap to add status update'}
        </Text>
      </View>
      {hasMyStatus && (
        <TouchableOpacity
          style={styles.cameraBtn}
          onPress={() => navigation.navigate('StatusCreate')}
        >
          <Ionicons name="camera" size={22} color={theme.colors.themeColor} />
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );

  const renderContactStatus = ({ item }) => {
    const statusCount = item.count || item.statuses?.length || 0;
    const viewed = false; // TODO: track viewed statuses locally

    return (
      <TouchableOpacity
        style={[styles.statusItem, { backgroundColor: theme.colors.cardBackground }]}
        onPress={() => navigation.navigate('StatusViewer', {
          statuses: item.statuses || [],
          startIndex: 0,
          isMine: false,
          userName: item.fullName,
          userImage: item.profileImage,
        })}
      >
        <View style={styles.avatarContainer}>
          <View style={[styles.statusRingOuter, { borderColor: viewed ? '#94a3b8' : '#25D366' }]}>
            <Image
              source={item.profileImage ? { uri: item.profileImage } : require('../../../assets/icon.png')}
              style={styles.avatar}
            />
          </View>
        </View>
        <View style={styles.textContainer}>
          <Text style={[styles.name, { color: theme.colors.primaryTextColor }]}>{item.fullName || 'Unknown'}</Text>
          <Text style={[styles.time, { color: theme.colors.placeHolderTextColor }]}>
            {statusCount} status{statusCount > 1 ? 'es' : ''} • {timeAgo(item.latestAt)}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Header */}
      <View style={[styles.header, {  }]}>
        <Text style={[styles.headerTitle, { color: theme.colors.themeColor }]}>Status</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={() => navigation.navigate('StatusCreate')} style={styles.headerBtn}>
            <Ionicons name="camera" size={22} color={ theme.colors.themeColor } />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => navigation.navigate('StatusCreate', { type: 'text' })} style={styles.headerBtn}>
            <MaterialCommunityIcons name="pencil" size={22} color={theme.colors.themeColor} />
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        data={contactStatuses || []}
        keyExtractor={(item) => String(item.userId || item._id)}
        ListHeaderComponent={() => (
          <View>
            {renderMyStatus()}
            {(contactStatuses || []).length > 0 && (
              <Text style={[styles.sectionTitle, { color: theme.colors.placeHolderTextColor }]}>Recent updates</Text>
            )}
          </View>
        )}
        renderItem={renderContactStatus}
        ListEmptyComponent={() => (
          !isLoading && (
            <View style={styles.emptyContainer}>
              <MaterialCommunityIcons name="circle-outline" size={60} color={theme.colors.placeHolderTextColor} />
              <Text style={[styles.emptyText, { color: theme.colors.placeHolderTextColor }]}>
                No status updates from contacts
              </Text>
              <Text style={[styles.emptySubText, { color: theme.colors.placeHolderTextColor }]}>
                Status updates from your contacts will appear here
              </Text>
            </View>
          )
        )}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.themeColor} />}
        contentContainerStyle={styles.listContent}
      />

      {/* FAB */}
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: theme.colors.themeColor }]}
        onPress={() => navigation.navigate('StatusCreate')}
      >
        <Ionicons name="camera" size={24} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingTop: 0, paddingBottom: 16, paddingHorizontal: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerTitle: { fontSize: 20, fontWeight: '700', color: '#fff' },
  headerActions: { flexDirection: 'row', gap: 16 },
  headerBtn: { padding: 4 },
  listContent: { paddingBottom: 100 },
  statusItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  avatarContainer: { position: 'relative', marginRight: 14 },
  avatar: { width: 50, height: 50, borderRadius: 25 },
  statusRingOuter: { width: 56, height: 56, borderRadius: 28, borderWidth: 2.5, padding: 2, alignItems: 'center', justifyContent: 'center' },
  statusRing: { position: 'absolute', bottom: -2, right: -2, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' },
  statusCount: { fontSize: 10, fontWeight: '700', color: '#fff' },
  addButton: { position: 'absolute', bottom: -2, right: -2, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' },
  textContainer: { flex: 1 },
  name: { fontSize: 16, fontWeight: '600', marginBottom: 2 },
  time: { fontSize: 13 },
  cameraBtn: { padding: 8 },
  sectionTitle: { fontSize: 13, fontWeight: '600', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  emptyContainer: { alignItems: 'center', paddingTop: 80, paddingHorizontal: 40 },
  emptyText: { fontSize: 16, fontWeight: '600', marginTop: 16 },
  emptySubText: { fontSize: 13, marginTop: 6, textAlign: 'center' },
  fab: { position: 'absolute', bottom: 24, right: 20, width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', elevation: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6 },
});
