import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Image, TextInput,
  ActivityIndicator, Animated, StyleSheet, Alert,
  Platform, ToastAndroid, ScrollView,
} from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';
import { Ionicons } from '@expo/vector-icons';
import useContactSync from '../../contexts/useContactSync';
import { useRealtimeChat } from '../../contexts/RealtimeChatContext';
import { useDispatch } from 'react-redux';
import { viewGroup } from '../../Redux/Reducer/Group/Group.reducer';

const AVATAR_COLORS = [
  '#6C5CE7', '#00B894', '#E17055', '#0984E3',
  '#E84393', '#00CEC9', '#FDCB6E', '#D63031',
];
const getAvatarColor = (name) => {
  if (!name) return AVATAR_COLORS[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

function showToast(msg) {
  if (Platform.OS === 'android') ToastAndroid.show(msg, ToastAndroid.SHORT);
  else Alert.alert('', msg);
}

export default function AddGroupMembers({ navigation, route }) {
  const { theme, isDarkMode } = useTheme();
  const dispatch = useDispatch();
  const { addGroupMembers } = useRealtimeChat();
  const { matchedRegistered = [], isSyncing } = useContactSync();

  const groupId = route.params?.groupId;
  const existingMemberIds = route.params?.existingMemberIds || [];

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedContacts, setSelectedContacts] = useState([]);

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 250, useNativeDriver: true }).start();
  }, []);

  // Filter out contacts already in the group
  const availableContacts = useMemo(() => {
    const existingSet = new Set(existingMemberIds.map(String));
    return matchedRegistered.filter((c) => c?.userId && !existingSet.has(String(c.userId)));
  }, [matchedRegistered, existingMemberIds]);

  const filteredContacts = useMemo(() => {
    if (!searchQuery.trim()) return availableContacts;
    const q = searchQuery.toLowerCase();
    return availableContacts.filter((c) => {
      const name = (c?.fullName || c?.name || '').toLowerCase();
      const phone = (c?.mobileFormatted || '').toLowerCase();
      return name.includes(q) || phone.includes(q);
    });
  }, [availableContacts, searchQuery]);

  const toggleContact = useCallback((contact) => {
    setSelectedContacts((prev) => {
      const exists = prev.find((c) => c.userId === contact.userId);
      if (exists) return prev.filter((c) => c.userId !== contact.userId);
      return [...prev, contact];
    });
  }, []);

  const isSelected = useCallback(
    (userId) => selectedContacts.some((c) => c.userId === userId),
    [selectedContacts]
  );

  const handleAddMembers = () => {
    if (selectedContacts.length === 0) return;
    const userIds = selectedContacts.map((c) => c.userId);
    // Emit socket event: group:member:add → { groupId, userIds }
    addGroupMembers(groupId, userIds);
    showToast(`${selectedContacts.length} member${selectedContacts.length > 1 ? 's' : ''} added`);
    // Refresh group data and go back
    dispatch(viewGroup({ groupId }));
    navigation.goBack();
  };

  const renderContactItem = ({ item }) => {
    const name = item?.fullName || item?.name || 'Unknown';
    const profileImage = item?.profileImage || item?.profilePicture;
    const avatarColor = getAvatarColor(name);
    const selected = isSelected(item.userId);

    return (
      <TouchableOpacity
        onPress={() => toggleContact(item)}
        activeOpacity={0.6}
        style={[styles.contactRow, selected && { backgroundColor: theme.colors.themeColor + '08' }]}
      >
        <View style={styles.avatarWrap}>
          {profileImage ? (
            <Image source={{ uri: profileImage }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, { backgroundColor: avatarColor }]}>
              <Text style={styles.avatarText}>{name.charAt(0).toUpperCase()}</Text>
            </View>
          )}
          {selected && (
            <View style={[styles.checkBadge, { backgroundColor: theme.colors.themeColor }]}>
              <Ionicons name="checkmark" size={12} color="#fff" />
            </View>
          )}
        </View>
        <View style={styles.contactInfo}>
          <Text style={[styles.contactName, { color: theme.colors.primaryTextColor }]} numberOfLines={1}>{name}</Text>
          <Text style={[styles.contactSub, { color: theme.colors.placeHolderTextColor }]} numberOfLines={1}>
            {item?.about || item?.mobileFormatted || ''}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  const renderSelectedBar = () => {
    if (selectedContacts.length === 0) return null;
    return (
      <View style={[styles.selectedBar, { borderBottomColor: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.selectedScroll}>
          {selectedContacts.map((c) => {
            const name = c?.fullName || c?.name || '?';
            const img = c?.profileImage || c?.profilePicture;
            const color = getAvatarColor(name);
            return (
              <TouchableOpacity key={c.userId} onPress={() => toggleContact(c)} activeOpacity={0.7} style={styles.selectedChip}>
                {img ? (
                  <Image source={{ uri: img }} style={styles.selectedAvatar} />
                ) : (
                  <View style={[styles.selectedAvatar, { backgroundColor: color }]}>
                    <Text style={styles.selectedAvatarText}>{name.charAt(0).toUpperCase()}</Text>
                  </View>
                )}
                <View style={[styles.selectedRemove, { backgroundColor: theme.colors.placeHolderTextColor }]}>
                  <Ionicons name="close" size={10} color="#fff" />
                </View>
                <Text style={[styles.selectedName, { color: theme.colors.primaryTextColor }]} numberOfLines={1}>
                  {name.split(' ')[0]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    );
  };

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: theme.colors.background }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.6} style={styles.headerBtn}>
          <Ionicons name="arrow-back" size={22} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <Text style={[styles.headerTitle, { color: theme.colors.primaryTextColor }]}>Add Participants</Text>
          <Text style={[styles.headerSub, { color: theme.colors.placeHolderTextColor }]}>
            {selectedContacts.length > 0
              ? `${selectedContacts.length} selected`
              : `${availableContacts.length} contacts available`}
          </Text>
        </View>
      </View>

      {/* Selected contacts bar */}
      {renderSelectedBar()}

      {/* Search */}
      <View style={styles.searchWrap}>
        <View style={[styles.searchBar, { backgroundColor: isDarkMode ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.04)' }]}>
          <Ionicons name="search" size={17} color={theme.colors.placeHolderTextColor} />
          <TextInput
            placeholder="Search contacts..."
            placeholderTextColor={theme.colors.placeHolderTextColor}
            value={searchQuery}
            onChangeText={setSearchQuery}
            style={[styles.searchInput, { color: theme.colors.primaryTextColor }]}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')} activeOpacity={0.6}>
              <Ionicons name="close-circle" size={18} color={theme.colors.placeHolderTextColor} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Contact List */}
      {isSyncing && availableContacts.length === 0 ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={theme.colors.themeColor} />
          <Text style={[styles.loadingText, { color: theme.colors.placeHolderTextColor }]}>Loading contacts...</Text>
        </View>
      ) : (
        <FlatList
          data={filteredContacts}
          keyExtractor={(item, i) => item?.userId || String(i)}
          renderItem={renderContactItem}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 90 }}
          ItemSeparatorComponent={() => (
            <View style={{ marginLeft: 72, height: StyleSheet.hairlineWidth, backgroundColor: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }} />
          )}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Ionicons name="people-outline" size={48} color={theme.colors.placeHolderTextColor} />
              <Text style={[styles.emptyText, { color: theme.colors.placeHolderTextColor }]}>
                {availableContacts.length === 0 ? 'All contacts are already in this group' : 'No contacts found'}
              </Text>
            </View>
          }
        />
      )}

      {/* Add FAB */}
      {selectedContacts.length > 0 && (
        <TouchableOpacity
          onPress={handleAddMembers}
          activeOpacity={0.85}
          style={[styles.fab, { backgroundColor: theme.colors.themeColor }]}
        >
          <Ionicons name="checkmark" size={24} color="#fff" />
        </TouchableOpacity>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 10, gap: 4 },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  headerTitleWrap: { flex: 1 },
  headerTitle: { fontFamily: 'Roboto-SemiBold', fontSize: 18 },
  headerSub: { fontFamily: 'Roboto-Regular', fontSize: 12, marginTop: 1 },

  selectedBar: { borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 8 },
  selectedScroll: { paddingHorizontal: 12, gap: 14 },
  selectedChip: { alignItems: 'center', width: 56 },
  selectedAvatar: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  selectedAvatarText: { color: '#fff', fontFamily: 'Roboto-SemiBold', fontSize: 18 },
  selectedRemove: { position: 'absolute', top: 0, right: 0, width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  selectedName: { fontFamily: 'Roboto-Regular', fontSize: 11, marginTop: 3, textAlign: 'center' },

  searchWrap: { paddingHorizontal: 14, paddingVertical: 6 },
  searchBar: { flexDirection: 'row', alignItems: 'center', borderRadius: 24, paddingHorizontal: 14, height: 40, gap: 8 },
  searchInput: { flex: 1, fontSize: 14, fontFamily: 'Roboto-Regular', paddingVertical: 0, height: '100%' },

  contactRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, gap: 12 },
  avatarWrap: { position: 'relative' },
  avatar: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarText: { color: '#fff', fontFamily: 'Roboto-SemiBold', fontSize: 18 },
  checkBadge: { position: 'absolute', bottom: -1, right: -1, width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' },
  contactInfo: { flex: 1, gap: 2 },
  contactName: { fontFamily: 'Roboto-Medium', fontSize: 15, textTransform: 'capitalize' },
  contactSub: { fontFamily: 'Roboto-Regular', fontSize: 13 },

  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { fontFamily: 'Roboto-Regular', fontSize: 13 },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 12 },
  emptyText: { fontFamily: 'Roboto-Regular', fontSize: 14, textAlign: 'center', paddingHorizontal: 40 },
  fab: {
    position: 'absolute', bottom: 24, right: 20, width: 56, height: 56, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', elevation: 6,
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.2, shadowRadius: 6,
  },
});