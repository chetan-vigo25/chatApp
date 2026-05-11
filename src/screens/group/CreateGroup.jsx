import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Image, TextInput,
  ActivityIndicator, Animated, StyleSheet, Alert,
  Platform, ToastAndroid, ScrollView, KeyboardAvoidingView,
} from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';
import { Ionicons } from '@expo/vector-icons';
import useContactSync from '../../contexts/useContactSync';
import { useDispatch, useSelector } from 'react-redux';
import { createGroup } from '../../Redux/Reducer/Group/Group.reducer';

const MAX_MEMBERS = 100;

const AVATAR_COLORS = [
  '#6C5CE7', '#00B894', '#E17055', '#0984E3',
  '#E84393', '#00CEC9', '#FDCB6E', '#D63031',
];

const getAvatarColor = (name) => {
  if (!name) return AVATAR_COLORS[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

function showToast(msg) {
  if (Platform.OS === 'android') ToastAndroid.show(msg, ToastAndroid.SHORT);
  else Alert.alert('', msg);
}

export default function CreateGroup({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const dispatch = useDispatch();
  const { isCreating } = useSelector((state) => state.group);
  const { matchedRegistered = [], isSyncing } = useContactSync();

  // ─── STEP STATE ───
  const [step, setStep] = useState(1); // 1 = select contacts, 2 = group details
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const stepAnim = useRef(new Animated.Value(0)).current;

  // ─── STEP 1: Contact Selection ───
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedContacts, setSelectedContacts] = useState([]);

  // ─── STEP 2: Group Details ───
  const [groupName, setGroupName] = useState('');
  const [groupDescription, setGroupDescription] = useState('');

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }).start();
  }, []);

  const filteredContacts = useMemo(() => {
    const registered = matchedRegistered.filter((c) => c?.userId);
    if (!searchQuery.trim()) return registered;
    const q = searchQuery.toLowerCase();
    return registered.filter((c) => {
      const name = (c?.fullName || c?.name || '').toLowerCase();
      const phone = (c?.mobileFormatted || '').toLowerCase();
      return name.includes(q) || phone.includes(q);
    });
  }, [matchedRegistered, searchQuery]);

  // ─── CONTACT SELECTION ───
  const toggleContact = useCallback((contact) => {
    setSelectedContacts((prev) => {
      const exists = prev.find((c) => c.userId === contact.userId);
      if (exists) return prev.filter((c) => c.userId !== contact.userId);
      if (prev.length >= MAX_MEMBERS) {
        showToast(`Maximum ${MAX_MEMBERS} members allowed`);
        return prev;
      }
      return [...prev, contact];
    });
  }, []);

  const isSelected = useCallback(
    (userId) => selectedContacts.some((c) => c.userId === userId),
    [selectedContacts]
  );

  // ─── STEP NAVIGATION ───
  const goToStep2 = () => {
    if (selectedContacts.length === 0) {
      showToast('Select at least 1 contact');
      return;
    }
    setStep(2);
    Animated.timing(stepAnim, { toValue: 1, duration: 250, useNativeDriver: true }).start();
  };

  const goBackToStep1 = () => {
    Animated.timing(stepAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
      setStep(1);
    });
  };

  // ─── CREATE GROUP ───
  const handleCreateGroup = async () => {
    if (!groupName.trim()) {
      showToast('Group name is required');
      return;
    }
    const payload = {
      name: groupName.trim(),
      description: groupDescription.trim() || undefined,
      members: selectedContacts.map((c) => ({
        userId: c.userId,
        role: 'member',
      })),
    };

    try {
      await dispatch(createGroup(payload)).unwrap();
      showToast('Group created successfully');
      // Navigate back to chat list so the new group appears after refresh
      navigation.reset({
        index: 0,
        routes: [{ name: 'ChatList' }],
      });
    } catch (error) {
      console.error('Create group failed:', error);
    }
  };

  // ─── RENDER CONTACT ITEM ───
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
        <View style={styles.contactAvatarWrap}>
          {profileImage ? (
            <Image source={{ uri: profileImage }} style={styles.contactAvatar} />
          ) : (
            <View style={[styles.contactAvatar, { backgroundColor: avatarColor }]}>
              <Text style={styles.contactAvatarText}>{name.charAt(0).toUpperCase()}</Text>
            </View>
          )}
          {selected && (
            <View style={[styles.checkBadge, { backgroundColor: theme.colors.themeColor }]}>
              <Ionicons name="checkmark" size={12} color="#fff" />
            </View>
          )}
        </View>

        <View style={styles.contactInfo}>
          <Text style={[styles.contactName, { color: theme.colors.primaryTextColor }]} numberOfLines={1}>
            {name}
          </Text>
          <Text style={[styles.contactAbout, { color: theme.colors.placeHolderTextColor }]} numberOfLines={1}>
            {item?.about || item?.mobileFormatted || ''}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  // ─── SELECTED CONTACTS BAR ───
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

  // ═══════════════════════════════════════════
  // STEP 1: Contact Selection
  // ═══════════════════════════════════════════
  const renderStep1 = () => (
    <View style={{ flex: 1 }}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.6} style={styles.headerBackBtn}>
          <Ionicons name="arrow-back" size={22} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <Text style={[styles.headerTitle, { color: theme.colors.primaryTextColor }]}>New Group</Text>
          <Text style={[styles.headerSubtitle, { color: theme.colors.placeHolderTextColor }]}>
            {selectedContacts.length > 0
              ? `${selectedContacts.length} of ${MAX_MEMBERS} selected`
              : 'Add participants'}
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
      {isSyncing && filteredContacts.length === 0 ? (
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
              <Text style={[styles.emptyText, { color: theme.colors.placeHolderTextColor }]}>No contacts found</Text>
            </View>
          }
        />
      )}

      {/* Next FAB */}
      {selectedContacts.length > 0 && (
        <TouchableOpacity onPress={goToStep2} activeOpacity={0.85} style={[styles.fab, { backgroundColor: theme.colors.themeColor }]}>
          <Ionicons name="arrow-forward" size={24} color="#fff" />
        </TouchableOpacity>
      )}
    </View>
  );

  // ═══════════════════════════════════════════
  // STEP 2: Group Details
  // ═══════════════════════════════════════════
  const renderStep2 = () => (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={goBackToStep1} activeOpacity={0.6} style={styles.headerBackBtn}>
          <Ionicons name="arrow-back" size={22} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <Text style={[styles.headerTitle, { color: theme.colors.primaryTextColor }]}>New Group</Text>
          <Text style={[styles.headerSubtitle, { color: theme.colors.placeHolderTextColor }]}>
            Add group details
          </Text>
        </View>
      </View>

      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 100 }}>
        {/* Group Name */}
        <View style={styles.inputSection}>
          <View style={[styles.inputRow, { borderBottomColor: isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)' }]}>
            <Ionicons name="people" size={20} color={theme.colors.themeColor} style={{ marginRight: 12 }} />
            <TextInput
              placeholder="Group name (required)"
              placeholderTextColor={theme.colors.placeHolderTextColor}
              value={groupName}
              onChangeText={setGroupName}
              maxLength={50}
              style={[styles.inputField, { color: theme.colors.primaryTextColor }]}
            />
            <Text style={[styles.charCount, { color: theme.colors.placeHolderTextColor }]}>{50 - groupName.length}</Text>
          </View>

          <View style={[styles.inputRow, { borderBottomColor: isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)' }]}>
            <Ionicons name="document-text-outline" size={20} color={theme.colors.themeColor} style={{ marginRight: 12 }} />
            <TextInput
              placeholder="Group description (optional)"
              placeholderTextColor={theme.colors.placeHolderTextColor}
              value={groupDescription}
              onChangeText={setGroupDescription}
              maxLength={100}
              multiline
              style={[styles.inputField, { color: theme.colors.primaryTextColor, maxHeight: 80 }]}
            />
            <Text style={[styles.charCount, { color: theme.colors.placeHolderTextColor }]}>{100 - groupDescription.length}</Text>
          </View>
        </View>

        {/* Members Preview */}
        <View style={styles.membersPreview}>
          <Text style={[styles.membersTitle, { color: theme.colors.placeHolderTextColor }]}>
            PARTICIPANTS: {selectedContacts.length}
          </Text>
          <View style={styles.membersGrid}>
            {selectedContacts.map((c) => {
              const name = c?.fullName || c?.name || '?';
              const img = c?.profileImage || c?.profilePicture;
              const color = getAvatarColor(name);
              return (
                <View key={c.userId} style={styles.memberChip}>
                  {img ? (
                    <Image source={{ uri: img }} style={styles.memberAvatar} />
                  ) : (
                    <View style={[styles.memberAvatar, { backgroundColor: color }]}>
                      <Text style={styles.memberAvatarText}>{name.charAt(0).toUpperCase()}</Text>
                    </View>
                  )}
                  <Text style={[styles.memberName, { color: theme.colors.primaryTextColor }]} numberOfLines={1}>
                    {name.split(' ')[0]}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      </ScrollView>

      {/* Create FAB */}
      <TouchableOpacity
        onPress={handleCreateGroup}
        disabled={isCreating || !groupName.trim()}
        activeOpacity={0.85}
        style={[styles.fab, { backgroundColor: theme.colors.themeColor, opacity: (!groupName.trim() || isCreating) ? 0.5 : 1 }]}
      >
        {isCreating ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Ionicons name="checkmark" size={24} color="#fff" />
        )}
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: theme.colors.background }]}>
      {step === 1 ? renderStep1() : renderStep2()}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // ─── HEADER ───
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 10,
    gap: 4,
  },
  headerBackBtn: {
    width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20,
  },
  headerTitleWrap: { flex: 1 },
  headerTitle: { fontFamily: 'Roboto-SemiBold', fontSize: 18 },
  headerSubtitle: { fontFamily: 'Roboto-Regular', fontSize: 12, marginTop: 1 },

  // ─── SELECTED BAR ───
  selectedBar: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
  },
  selectedScroll: { paddingHorizontal: 12, gap: 14 },
  selectedChip: { alignItems: 'center', width: 56 },
  selectedAvatar: {
    width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  selectedAvatarText: { color: '#fff', fontFamily: 'Roboto-SemiBold', fontSize: 18 },
  selectedRemove: {
    position: 'absolute', top: 0, right: 0, width: 18, height: 18, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
  },
  selectedName: { fontFamily: 'Roboto-Regular', fontSize: 11, marginTop: 3, textAlign: 'center' },

  // ─── SEARCH ───
  searchWrap: { paddingHorizontal: 14, paddingVertical: 6 },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', borderRadius: 24, paddingHorizontal: 14, height: 40, gap: 8,
  },
  searchInput: { flex: 1, fontSize: 14, fontFamily: 'Roboto-Regular', paddingVertical: 0, height: '100%' },

  // ─── CONTACT ROW ───
  contactRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, gap: 12 },
  contactAvatarWrap: { position: 'relative' },
  contactAvatar: {
    width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  contactAvatarText: { color: '#fff', fontFamily: 'Roboto-SemiBold', fontSize: 18 },
  checkBadge: {
    position: 'absolute', bottom: -1, right: -1, width: 20, height: 20, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff',
  },
  contactInfo: { flex: 1, gap: 2 },
  contactName: { fontFamily: 'Roboto-Medium', fontSize: 15, textTransform: 'capitalize' },
  contactAbout: { fontFamily: 'Roboto-Regular', fontSize: 13 },

  // ─── STEP 2: INPUTS ───
  inputSection: { paddingHorizontal: 16 },
  inputRow: {
    flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, paddingVertical: 10,
  },
  inputField: { flex: 1, fontFamily: 'Roboto-Regular', fontSize: 15, paddingVertical: 0 },
  charCount: { fontFamily: 'Roboto-Regular', fontSize: 12, marginLeft: 8 },

  // ─── STEP 2: MEMBERS PREVIEW ───
  membersPreview: { paddingHorizontal: 16, paddingTop: 24 },
  membersTitle: { fontFamily: 'Roboto-SemiBold', fontSize: 12, letterSpacing: 0.5, marginBottom: 12 },
  membersGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  memberChip: { alignItems: 'center', width: 60 },
  memberAvatar: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  memberAvatarText: { color: '#fff', fontFamily: 'Roboto-SemiBold', fontSize: 16 },
  memberName: { fontFamily: 'Roboto-Regular', fontSize: 11, marginTop: 4, textAlign: 'center' },

  // ─── SHARED ───
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { fontFamily: 'Roboto-Regular', fontSize: 13 },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 12 },
  emptyText: { fontFamily: 'Roboto-Regular', fontSize: 14 },
  fab: {
    position: 'absolute', bottom: 24, right: 20, width: 56, height: 56, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', elevation: 6,
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.2, shadowRadius: 6,
  },
});