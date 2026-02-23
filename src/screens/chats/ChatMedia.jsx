import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, Image, ActivityIndicator, Alert, Platform } from 'react-native';
import { useImage } from '../../contexts/ImageProvider';
import { useDispatch } from 'react-redux';
import { mediaUpload } from '../../Redux/Reducer/Chat/Chat.reducer';
import { Ionicons } from '@expo/vector-icons';

export default function ChatMedia({ navigation, route }) {
  const { type = 'image', chatId = null, onUploadComplete } = route.params || {};
  const { pickMedia } = useImage();
  const dispatch = useDispatch();
  const [file, setFile] = useState(null);
  const [isUploading, setIsUploading] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const picked = await pickMedia(type);
        if (!mounted) return;
        if (!picked) {
          navigation.goBack();
          return;
        }
        setFile(picked);
      } catch (err) {
        console.error('ChatMedia pick error', err);
        Alert.alert('Error', 'Failed to pick media');
        navigation.goBack();
      }
    })();
    return () => { mounted = false; };
  }, [pickMedia, type]);

  const doUpload = useCallback(async () => {
    if (!file) return;
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', {
        uri: Platform.OS === 'android' && file.uri.startsWith('file://') ? file.uri : file.uri,
        name: file.name || `file_${Date.now()}`,
        type: file.type || (type === 'video' ? 'video/mp4' : 'application/octet-stream'),
      });
      if (chatId) formData.append('chatid', chatId);

      const action = await dispatch(mediaUpload(formData));
      const payload = action?.payload ?? action;
      const success = payload && (payload.status === true || payload.statusCode === 200 || payload.success === true);

      // prefer returning the full payload (server may return different shapes)
      const result = payload?.data ?? payload;

      if (!success) {
        Alert.alert('Upload failed', (result && result.message) || 'Unable to upload media');
        if (onUploadComplete) onUploadComplete({ success: false, data: result });
        navigation.goBack();
        return;
      }

      if (onUploadComplete) onUploadComplete({ success: true, data: result });
      navigation.goBack();
    } catch (err) {
      console.error('ChatMedia upload error', err);
      Alert.alert('Upload failed', 'An unexpected error occurred while uploading');
      if (onUploadComplete) onUploadComplete({ success: false, data: null });
      navigation.goBack();
    } finally {
      setIsUploading(false);
    }
  }, [file, dispatch, chatId, onUploadComplete, type]);

  if (!file) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color="#fff" />
        <Text style={{ marginTop: 12, color: '#fff' }}>Preparing media...</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000', padding: 12, justifyContent: 'center' }}>
      <View style={{ alignItems: 'center', marginBottom: 12 }}>
        {file.uri && (file.type?.startsWith('image') || file.uri.match(/\.(jpg|jpeg|png|gif|webp)$/i)) ? (
          <Image source={{ uri: file.uri }} style={{ width: '100%', height: 420, borderRadius: 12, resizeMode: 'cover' }} />
        ) : (
          <View style={{ width: '100%', height: 420, borderRadius: 12, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="document-text-outline" size={48} color="#fff" />
            <Text style={{ color: '#fff', marginTop: 8 }}>{file.name || 'Selected file'}</Text>
          </View>
        )}
      </View>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={{ flex: 1, padding: 12, borderRadius: 8, backgroundColor: '#333', alignItems: 'center' }}>
          <Text style={{ color: '#fff' }}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={doUpload} disabled={isUploading} style={{ flex: 1, padding: 12, borderRadius: 8, backgroundColor: isUploading ? '#666' : '#2196F3', alignItems: 'center' }}>
          {isUploading ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff' }}>Upload</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}
