import React, { useState, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, Image, ActivityIndicator, Alert, ScrollView } from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import { useTheme } from '../../contexts/ThemeContext';
import { createStatus } from '../../Redux/Reducer/Status/Status.reducer';
import { statusServices } from '../../Redux/Services/Status/Status.Services';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

const BG_COLORS = ['#075e54', '#128C7E', '#25D366', '#FF6B6B', '#C44569', '#F8B500', '#6C5CE7', '#00B894', '#2d3436', '#e17055', '#0984e3', '#fd79a8'];

export default function StatusCreate({ navigation, route }) {
  const { theme } = useTheme();
  const dispatch = useDispatch();
  const { isCreating } = useSelector(state => state.status);

  const initialType = route?.params?.type || null;
  const [mode, setMode] = useState(initialType || null); // null = picker, 'text', 'image', 'video'
  const [text, setText] = useState('');
  const [bgColor, setBgColor] = useState('#075e54');
  const [caption, setCaption] = useState('');
  const [mediaUri, setMediaUri] = useState(null);
  const [mediaType, setMediaType] = useState(null);
  const [uploading, setUploading] = useState(false);

  const pickMedia = async (type) => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Please allow access to your media library');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: type === 'video' ? ['videos'] : ['images'],
      quality: 0.8,
      allowsEditing: true,
    });

    if (!result.canceled && result.assets?.[0]) {
      const asset = result.assets[0];
      setMediaUri(asset.uri);
      setMediaType(type === 'video' ? 'video' : 'image');
      setMode(type === 'video' ? 'video' : 'image');
    }
  };

  const takePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Please allow camera access');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({ quality: 0.8, allowsEditing: true });
    if (!result.canceled && result.assets?.[0]) {
      setMediaUri(result.assets[0].uri);
      setMediaType('image');
      setMode('image');
    }
  };

  const handlePost = async () => {
    if (mode === 'text') {
      if (!text.trim()) return Alert.alert('Error', 'Please enter some text');
      dispatch(createStatus({ type: 'text', text: text.trim(), backgroundColor: bgColor }))
        .unwrap()
        .then(() => navigation.goBack())
        .catch(() => {});
    } else if (mediaUri && mediaType) {
      setUploading(true);
      try {
        // Upload media first
        const formData = new FormData();
        const ext = mediaUri.split('.').pop() || 'jpg';
        formData.append('file', {
          uri: mediaUri,
          name: `status_${Date.now()}.${ext}`,
          type: mediaType === 'video' ? `video/${ext}` : `image/${ext}`,
        });
        formData.append('chatId', 'status');

        const uploadRes = await statusServices.createMediaStatus(formData);
        const media = uploadRes?.data;

        if (!media?.url && !media?.mediaUrl) {
          throw new Error('Upload failed');
        }

        await dispatch(createStatus({
          type: mediaType,
          mediaUrl: media.url || media.mediaUrl,
          mediaThumbnailUrl: media.thumbnailUrl || media.mediaThumbnailUrl || null,
          mediaKey: media.storedName || media.s3Key || null,
          mediaStorageType: media.storageType || 'local',
          mediaMeta: {
            fileName: media.originalName,
            fileSize: media.sizeAfter || media.fileSize,
            mimeType: media.mimeType,
            width: media.width,
            height: media.height,
            duration: media.duration,
          },
          caption: caption.trim() || null,
        })).unwrap();

        navigation.goBack();
      } catch (error) {
        Alert.alert('Error', 'Failed to upload status');
      } finally {
        setUploading(false);
      }
    }
  };

  // Mode picker
  if (!mode) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <View style={[styles.header, { }]}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color={theme.colors.themeColor} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: theme.colors.themeColor }]}>New Status</Text>
        </View>
        <View style={styles.pickerContainer}>
          <TouchableOpacity style={[styles.pickerOption, { backgroundColor: '#075e54' }]} onPress={() => setMode('text')}>
            <MaterialCommunityIcons name="format-text" size={40} color="#fff" />
            <Text style={styles.pickerLabel}>Text</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.pickerOption, { backgroundColor: '#6C5CE7' }]} onPress={() => pickMedia('image')}>
            <Ionicons name="image" size={40} color="#fff" />
            <Text style={styles.pickerLabel}>Photo</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.pickerOption, { backgroundColor: '#00B894' }]} onPress={takePhoto}>
            <Ionicons name="camera" size={40} color="#fff" />
            <Text style={styles.pickerLabel}>Camera</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.pickerOption, { backgroundColor: '#FF6B6B' }]} onPress={() => pickMedia('video')}>
            <Ionicons name="videocam" size={40} color="#fff" />
            <Text style={styles.pickerLabel}>Video</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Text status
  if (mode === 'text') {
    return (
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.textStatusContainer, { backgroundColor: bgColor }]}>
          <View style={styles.textHeader}>
            <TouchableOpacity onPress={() => navigation.goBack()}>
              <Ionicons name="close" size={28} color={ '#fff' } />
            </TouchableOpacity>
            <TouchableOpacity onPress={handlePost} disabled={isCreating}>
              {isCreating ? <ActivityIndicator color={ theme.colors.themeColor } /> : <Ionicons name="send" size={24} color="#fff" />}
            </TouchableOpacity>
          </View>

          <View style={styles.textInputWrapper}>
            <TextInput
              style={styles.textInput}
              placeholder="Type a status..."
              placeholderTextColor="rgba(255,255,255,0.5)"
              multiline
              autoFocus
              maxLength={700}
              value={text}
              onChangeText={setText}
            />
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.colorPicker} contentContainerStyle={styles.colorPickerContent}>
            {BG_COLORS.map(color => (
              <TouchableOpacity key={color} onPress={() => setBgColor(color)}
                style={[styles.colorDot, { backgroundColor: color, borderWidth: bgColor === color ? 3 : 0, borderColor: '#fff' }]}
              />
            ))}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    );
  }

  // Media status (image/video)
  return (
    <View style={[styles.container, { backgroundColor: '#000' }]}>
      <View style={styles.mediaHeader}>
        <TouchableOpacity onPress={() => { setMode(null); setMediaUri(null); }}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.mediaHeaderTitle}>{mediaType === 'video' ? 'Video Status' : 'Photo Status'}</Text>
      </View>

      <View style={styles.mediaPreview}>
        {mediaType === 'video' ? (
          <View style={styles.videoPlaceholder}>
            <Ionicons name="videocam" size={60} color="#fff" />
            <Text style={styles.videoText}>Video selected</Text>
          </View>
        ) : (
          <Image source={{ uri: mediaUri }} style={styles.imagePreview} resizeMode="contain" />
        )}
      </View>

      <View style={styles.mediaFooter}>
        <TextInput
          style={styles.captionInput}
          placeholder="Add a caption..."
          placeholderTextColor="rgba(255,255,255,0.5)"
          value={caption}
          onChangeText={setCaption}
          maxLength={500}
        />
        <TouchableOpacity
          style={[styles.sendBtn, { backgroundColor: theme.colors.themeColor }]}
          onPress={handlePost}
          disabled={isCreating || uploading}
        >
          {(isCreating || uploading) ? <ActivityIndicator color="#fff" /> : <Ionicons name="send" size={22} color="#fff" />}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingTop: 0, paddingBottom: 16, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center' },
  backBtn: { marginRight: 16 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#fff' },
  pickerContainer: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 20, padding: 30 },
  pickerOption: { width: 140, height: 140, borderRadius: 20, alignItems: 'center', justifyContent: 'center', elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4 },
  pickerLabel: { color: '#fff', fontSize: 16, fontWeight: '600', marginTop: 10 },
  // Text status
  textStatusContainer: { flex: 1 },
  textHeader: { paddingTop: 50, paddingHorizontal: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  textInputWrapper: { flex: 1, justifyContent: 'center', paddingHorizontal: 30 },
  textInput: { fontSize: 24, color: '#fff', textAlign: 'center', fontWeight: '500', maxHeight: 300 },
  colorPicker: { paddingBottom: 30 },
  colorPickerContent: { paddingHorizontal: 20, gap: 10, alignItems: 'center' },
  colorDot: { width: 36, height: 36, borderRadius: 18 },
  // Media status
  mediaHeader: { paddingTop: 50, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 16 },
  mediaHeaderTitle: { fontSize: 18, fontWeight: '600', color: '#fff' },
  mediaPreview: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  imagePreview: { width: '100%', height: '100%' },
  videoPlaceholder: { alignItems: 'center' },
  videoText: { color: '#fff', marginTop: 12, fontSize: 16 },
  mediaFooter: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10 },
  captionInput: { flex: 1, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 24, paddingHorizontal: 16, paddingVertical: 10, color: '#fff', fontSize: 15 },
  sendBtn: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
});
