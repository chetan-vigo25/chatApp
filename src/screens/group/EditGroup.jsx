import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, Image, TextInput,
  ActivityIndicator, Animated, StyleSheet, Alert,
  Platform, ToastAndroid, ScrollView, KeyboardAvoidingView,
} from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';
import { Ionicons } from '@expo/vector-icons';
import { useDispatch, useSelector } from 'react-redux';
import { updateGroup, viewGroup } from '../../Redux/Reducer/Group/Group.reducer';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BACKEND_URL } from '@env';
import { apiCall } from '../../Config/Https';

function showToast(msg) {
  if (Platform.OS === 'android') ToastAndroid.show(msg, ToastAndroid.SHORT);
  else Alert.alert('', msg);
}

export default function EditGroup({ navigation, route }) {
  const { theme, isDarkMode } = useTheme();
  const dispatch = useDispatch();
  const { currentGroup, isLoading } = useSelector((state) => state.group);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const groupId = route.params?.groupId;

  const [groupName, setGroupName] = useState('');
  const [groupDescription, setGroupDescription] = useState('');
  const [groupAvatar, setGroupAvatar] = useState(null);
  const [newAvatarUri, setNewAvatarUri] = useState(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 250, useNativeDriver: true }).start();
    if (groupId && !currentGroup) {
      dispatch(viewGroup({ groupId }));
    }
  }, [groupId]);

  // API response: currentGroup = { group: { name, avatar, description }, members: [...] }
  useEffect(() => {
    if (currentGroup) {
      const grp = currentGroup.group || currentGroup;
      setGroupName(grp.name || '');
      setGroupDescription(grp.description || '');
      setGroupAvatar(grp.avatar || null);
    }
  }, [currentGroup]);

  const pickAvatar = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Camera roll permission is required.');
      return;
    }
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      if (!result.canceled && result.assets?.[0]) {
        setNewAvatarUri(result.assets[0].uri);
        setGroupAvatar(result.assets[0].uri);
      }
    } catch (e) {
      showToast('Failed to pick image');
    }
  };

  // Upload avatar using the same pattern as user profile picture (fetch + FormData)
  const uploadAvatar = async (uri) => {
    try {
      const token = await AsyncStorage.getItem('accessToken');
      const myHeaders = new Headers();
      myHeaders.append('Authorization', 'Bearer ' + token);

      const formData = new FormData();
      const uriParts = uri.split('.');
      const fileType = uriParts[uriParts.length - 1] || 'jpeg';
      const mimeType = fileType === 'jpg' || fileType === 'jpeg' ? 'image/jpeg' : 'image/png';

      formData.append('file', {
        uri,
        name: `group_avatar.${fileType}`,
        type: mimeType,
      });
      formData.append('groupId', groupId);

      const response = await fetch(`${BACKEND_URL}user/profile/group/picture`, {
        method: 'POST',
        headers: myHeaders,
        body: formData,
      });
      const result = await response.json();

      if (result?.statusCode === 200) {
        return result?.data?.avatarUrl || result?.data?.avatar || null;
      }
      showToast(result?.message || 'Avatar upload failed');
      return null;
    } catch (error) {
      console.error('Avatar upload failed:', error);
      showToast('Network request failed');
      return null;
    }
  };

  const removeAvatar = async () => {
    Alert.alert('Remove Photo', 'Remove the group profile photo?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          setUploading(true);
          try {
            const response = await apiCall('POST', 'user/profile/group/picture/remove', { groupId });
            if (response?.statusCode === 200) {
              showToast('Group photo removed');
              setGroupAvatar(null);
              setNewAvatarUri(null);
              dispatch(viewGroup({ groupId }));
            }
          } catch (error) {
            console.error('Remove avatar failed:', error);
          }
          setUploading(false);
        },
      },
    ]);
  };

  const handleSave = async () => {
    if (!groupName.trim()) {
      showToast('Group name is required');
      return;
    }

    setUploading(true);

    // Step 1: Upload avatar if changed — get server URL
    let avatarUrl = null;
    if (newAvatarUri) {
      const uploaded = await uploadAvatar(newAvatarUri);
      if (!uploaded) {
        setUploading(false);
        return;
      }
      avatarUrl = uploaded;
    }

    // Step 2: Update group info via API — only send fields that changed
    const payload = {
      groupId,
      name: groupName.trim(),
      description: groupDescription.trim(),
    };
    // Only include avatar in payload if user picked a new image
    if (avatarUrl) {
      payload.avatar = avatarUrl;
    }

    try {
      await dispatch(updateGroup(payload)).unwrap();
      showToast('Group updated');
      dispatch(viewGroup({ groupId }));
      navigation.goBack();
    } catch (error) {
      console.error('Update group failed:', error);
    }
    setUploading(false);
  };

  const isSaving = isLoading || uploading;

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: theme.colors.background }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.6} style={styles.headerBackBtn}>
          <Ionicons name="arrow-back" size={22} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.primaryTextColor }]}>Edit Group</Text>
        <TouchableOpacity
          onPress={handleSave}
          disabled={isSaving || !groupName.trim()}
          activeOpacity={0.6}
          style={styles.headerSaveBtn}
        >
          {isSaving ? (
            <ActivityIndicator size="small" color={theme.colors.themeColor} />
          ) : (
            <Text style={[styles.headerSaveText, { color: theme.colors.themeColor, opacity: groupName.trim() ? 1 : 0.4 }]}>Save</Text>
          )}
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
          {/* Avatar */}
          <View style={styles.avatarSection}>
            <TouchableOpacity onPress={pickAvatar} disabled={isSaving} activeOpacity={0.7} style={[styles.avatarWrap, { backgroundColor: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]}>
              {groupAvatar ? (
                <Image source={{ uri: groupAvatar }} style={styles.avatarImg} />
              ) : (
                <Ionicons name="people" size={36} color={theme.colors.placeHolderTextColor} />
              )}
              <View style={[styles.avatarOverlay, { backgroundColor: 'rgba(0,0,0,0.35)' }]}>
                <Ionicons name="camera" size={20} color="#fff" />
              </View>
            </TouchableOpacity>
            <Text style={[styles.avatarHint, { color: theme.colors.placeHolderTextColor }]}>
              {newAvatarUri ? 'New photo selected' : 'Tap to change group photo'}
            </Text>
            {groupAvatar && !newAvatarUri && (
              <TouchableOpacity onPress={removeAvatar} disabled={isSaving} activeOpacity={0.6} style={{ marginTop: 10 }}>
                <Text style={{ fontFamily: 'Roboto-Medium', fontSize: 13, color: '#E53935' }}>Remove Photo</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Fields */}
          <View style={styles.fieldSection}>
            <View style={[styles.fieldRow, { borderBottomColor: isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)' }]}>
              <Text style={[styles.fieldLabel, { color: theme.colors.placeHolderTextColor }]}>Group Name</Text>
              <TextInput
                value={groupName}
                onChangeText={setGroupName}
                maxLength={50}
                placeholder="Enter group name"
                placeholderTextColor={theme.colors.placeHolderTextColor}
                style={[styles.fieldInput, { color: theme.colors.primaryTextColor }]}
              />
              <Text style={[styles.charCount, { color: theme.colors.placeHolderTextColor }]}>{50 - groupName.length}</Text>
            </View>

            <View style={[styles.fieldRow, { borderBottomColor: isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)' }]}>
              <Text style={[styles.fieldLabel, { color: theme.colors.placeHolderTextColor }]}>Description</Text>
              <TextInput
                value={groupDescription}
                onChangeText={setGroupDescription}
                maxLength={100}
                multiline
                placeholder="Enter group description"
                placeholderTextColor={theme.colors.placeHolderTextColor}
                style={[styles.fieldInput, { color: theme.colors.primaryTextColor, maxHeight: 100 }]}
              />
              <Text style={[styles.charCount, { color: theme.colors.placeHolderTextColor }]}>{100 - groupDescription.length}</Text>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 10, gap: 4,
  },
  headerBackBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  headerTitle: { flex: 1, fontFamily: 'Roboto-SemiBold', fontSize: 18 },
  headerSaveBtn: { paddingHorizontal: 12, paddingVertical: 8 },
  headerSaveText: { fontFamily: 'Roboto-SemiBold', fontSize: 15 },

  avatarSection: { alignItems: 'center', paddingVertical: 24 },
  avatarWrap: {
    width: 100, height: 100, borderRadius: 50, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  avatarImg: { width: '100%', height: '100%' },
  avatarOverlay: {
    ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center',
  },
  avatarHint: { fontFamily: 'Roboto-Regular', fontSize: 12, marginTop: 8 },

  fieldSection: { paddingHorizontal: 20 },
  fieldRow: { borderBottomWidth: 1, paddingVertical: 14 },
  fieldLabel: { fontFamily: 'Roboto-Regular', fontSize: 12, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  fieldInput: { fontFamily: 'Roboto-Regular', fontSize: 16, paddingVertical: 0 },
  charCount: { fontFamily: 'Roboto-Regular', fontSize: 12, textAlign: 'right', marginTop: 4 },
});