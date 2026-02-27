import React, { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import useMediaDownload from '../hooks/useMediaDownload';
import localStorageService from '../services/LocalStorageService';
import MediaProgress from './MediaProgress';

export default function MediaMessage({ message, chatId, onPressMedia }) {
  // Always use media._id.$oid if present
  const mediaId = message?._id?.$oid
    ? String(message._id.$oid)
    : String(message?.mediaId || message?.serverMessageId || message?.id || '');
  const messageType = (message?.type || message?.fileCategory || 'file').toLowerCase();
  const { requestDownload, status, progress, localPath, isDownloaded } = useMediaDownload(mediaId);
  const [cachedThumb, setCachedThumb] = useState(null);

  useEffect(() => {
    let mounted = true;
    const loadThumb = async () => {
      if (!mediaId) return;
      const thumbPath = await localStorageService.getThumbnail(mediaId);
      if (mounted) setCachedThumb(thumbPath || null);
    };
    loadThumb().catch(() => {});
    return () => { mounted = false; };
  }, [mediaId]);

  const previewSource = useMemo(() => {
    const local = localPath || message?.localUri || null;
    if (local) return local;
    return cachedThumb || message?.thumbnailUrl || message?.previewUrl || message?.mediaUrl || null;
  }, [cachedThumb, localPath, message?.localUri, message?.mediaUrl, message?.previewUrl, message?.thumbnailUrl]);

  const showDownload = !isDownloaded && status !== 'downloading';
  const isVideo = messageType === 'video';
  const isImage = messageType === 'image' || messageType === 'photo';
  const isFile = !isImage && !isVideo;

  const onDownload = () => {
    requestDownload({
      chatId,
      messageType,
      filename: message?.text || message?.fileName || `${mediaId}`,
    }).catch(() => {});
  };

  const openMedia = () => {
    if (typeof onPressMedia === 'function') {
      onPressMedia({
        ...message,
        resolvedUri: localPath || message?.localUri || message?.mediaUrl || message?.previewUrl,
      });
    }
  };

  if (isFile) {
    return (
      <Pressable style={styles.fileCard} onPress={isDownloaded ? openMedia : onDownload}>
        <Ionicons name="document-text" size={28} color="#fff" />
        <Text style={styles.fileText} numberOfLines={1}>{message?.text || message?.fileName || 'Document'}</Text>
        {status === 'downloading' ? <MediaProgress progress={progress} status={status} /> : null}
        {showDownload ? <Ionicons name="cloud-download" size={20} color="#fff" /> : null}
      </Pressable>
    );
  }

  return (
    <Pressable style={styles.mediaWrap} onPress={isDownloaded ? openMedia : onDownload}>
      {previewSource ? (
        <Image source={{ uri: previewSource }} style={styles.mediaPreview} blurRadius={isDownloaded ? 0 : 2} />
      ) : (
        <View style={[styles.mediaPreview, styles.placeholder]}>
          <Ionicons name={isVideo ? 'videocam-outline' : 'image-outline'} size={30} color="#fff" />
        </View>
      )}

      <View style={styles.overlay}>
        {isVideo ? <Ionicons name="play-circle" size={44} color="#fff" /> : null}
        {status === 'downloading' ? <MediaProgress progress={progress} status={status} /> : null}
        {showDownload ? <Ionicons name="cloud-download" size={26} color="#fff" /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  mediaWrap: {
    width: 170,
    height: 130,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#1f1f1f',
  },
  mediaPreview: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  fileCard: {
    width: 170,
    minHeight: 94,
    borderRadius: 10,
    backgroundColor: '#333',
    padding: 12,
    justifyContent: 'center',
    gap: 8,
  },
  fileText: {
    color: '#fff',
    fontSize: 12,
  },
});
