import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet, Dimensions, StatusBar, Alert, FlatList, Animated } from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import { viewStatusAction, deleteStatusAction, fetchStatusViewers, removeLocalStatus } from '../../Redux/Reducer/Status/Status.reducer';
import { Ionicons } from '@expo/vector-icons';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const STATUS_DURATION = 5000; // 5 seconds per status
const PROGRESS_HEIGHT = 3;

const timeAgo = (date) => {
  if (!date) return '';
  const diff = Date.now() - new Date(date).getTime();
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
};

export default function StatusViewer({ navigation, route }) {
  const { statuses = [], startIndex = 0, isMine = false, userName = '', userImage = '' } = route.params || {};
  const dispatch = useDispatch();
  const { viewers } = useSelector(state => state.status);
  const { user } = useSelector(state => state.authentication);

  const [currentIndex, setCurrentIndex] = useState(startIndex);
  const [paused, setPaused] = useState(false);
  const [showViewers, setShowViewers] = useState(false);
  const progressAnim = useRef(new Animated.Value(0)).current;
  const timerRef = useRef(null);

  const currentStatus = statuses[currentIndex];

  // Mark as viewed
  useEffect(() => {
    if (currentStatus && !isMine) {
      dispatch(viewStatusAction(currentStatus._id));
    }
    if (currentStatus && isMine) {
      dispatch(fetchStatusViewers(currentStatus._id));
    }
  }, [currentIndex, currentStatus]);

  // Progress animation
  const startProgress = useCallback(() => {
    progressAnim.setValue(0);
    Animated.timing(progressAnim, {
      toValue: 1,
      duration: STATUS_DURATION,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished && !paused) goNext();
    });
  }, [currentIndex, paused]);

  useEffect(() => {
    if (!paused) startProgress();
    return () => progressAnim.stopAnimation();
  }, [currentIndex, paused, startProgress]);

  const goNext = () => {
    if (currentIndex < statuses.length - 1) {
      setCurrentIndex(prev => prev + 1);
    } else {
      navigation.goBack();
    }
  };

  const goPrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex(prev => prev - 1);
    }
  };

  const handleDelete = () => {
    Alert.alert('Delete Status', 'This status will be deleted for everyone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: () => {
          dispatch(deleteStatusAction(currentStatus._id));
          dispatch(removeLocalStatus(currentStatus._id));
          if (statuses.length <= 1) {
            navigation.goBack();
          } else if (currentIndex >= statuses.length - 1) {
            setCurrentIndex(prev => prev - 1);
          }
        },
      },
    ]);
  };

  if (!currentStatus) {
    navigation.goBack();
    return null;
  }

  const displayName = isMine ? 'My Status' : userName;
  const displayImage = isMine ? user?.profileImage : userImage;

  return (
    <View style={styles.container}>
      <StatusBar hidden />

      {/* Content */}
      {currentStatus.type === 'text' ? (
        <View style={[styles.textContent, { backgroundColor: currentStatus.backgroundColor || '#075e54' }]}>
          <Text style={[styles.textBody, { fontStyle: currentStatus.fontStyle || 'normal' }]}>
            {currentStatus.text}
          </Text>
        </View>
      ) : currentStatus.type === 'image' ? (
        <Image source={{ uri: currentStatus.mediaUrl }} style={styles.mediaContent} resizeMode="contain" />
      ) : currentStatus.type === 'video' ? (
        <View style={styles.textContent}>
          <Ionicons name="videocam" size={60} color="#fff" />
          <Text style={{ color: '#fff', marginTop: 12 }}>Video Status</Text>
        </View>
      ) : (
        <View style={[styles.textContent, { backgroundColor: '#2d3436' }]}>
          <Ionicons name="musical-notes" size={60} color="#fff" />
          <Text style={{ color: '#fff', marginTop: 12 }}>Audio Status</Text>
        </View>
      )}

      {/* Caption overlay */}
      {currentStatus.caption && (
        <View style={styles.captionOverlay}>
          <Text style={styles.captionText}>{currentStatus.caption}</Text>
        </View>
      )}

      {/* Touch zones */}
      <View style={styles.touchZones}>
        <TouchableOpacity style={styles.leftZone} onPress={goPrev} onLongPress={() => setPaused(true)} onPressOut={() => setPaused(false)} activeOpacity={1} />
        <TouchableOpacity style={styles.rightZone} onPress={goNext} onLongPress={() => setPaused(true)} onPressOut={() => setPaused(false)} activeOpacity={1} />
      </View>

      {/* Progress bars */}
      <View style={styles.progressContainer}>
        {statuses.map((_, i) => (
          <View key={i} style={styles.progressTrack}>
            <Animated.View style={[styles.progressFill, {
              width: i < currentIndex ? '100%' : i === currentIndex
                ? progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] })
                : '0%',
            }]} />
          </View>
        ))}
      </View>

      {/* Header */}
      <View style={styles.headerOverlay}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Image
          source={displayImage ? { uri: displayImage } : require('../../../assets/icon.png')}
          style={styles.headerAvatar}
        />
        <View style={styles.headerText}>
          <Text style={styles.headerName}>{displayName}</Text>
          <Text style={styles.headerTime}>{timeAgo(currentStatus.createdAt)}</Text>
        </View>
        {isMine && (
          <TouchableOpacity onPress={handleDelete} style={styles.deleteBtn}>
            <Ionicons name="trash-outline" size={22} color="#fff" />
          </TouchableOpacity>
        )}
      </View>

      {/* Bottom: Viewers (my status) or Reply (others) */}
      {isMine ? (
        <TouchableOpacity style={styles.viewersBar} onPress={() => setShowViewers(!showViewers)}>
          <Ionicons name="eye-outline" size={20} color="#fff" />
          <Text style={styles.viewersText}>{viewers?.viewCount || currentStatus.viewCount || 0} views</Text>
          <Ionicons name={showViewers ? 'chevron-down' : 'chevron-up'} size={20} color="#fff" />
        </TouchableOpacity>
      ) : (
        <View style={styles.replyBar}>
          <Ionicons name="chevron-up" size={20} color="#fff" />
          <Text style={styles.replyText}>Reply</Text>
        </View>
      )}

      {/* Viewers list */}
      {showViewers && (
        <View style={styles.viewersList}>
          <FlatList
            data={viewers?.viewers || []}
            keyExtractor={(item, i) => item?.userId?._id || String(i)}
            renderItem={({ item }) => (
              <View style={styles.viewerItem}>
                <Image
                  source={item.userId?.profileImage ? { uri: item.userId.profileImage } : require('../../../assets/icon.png')}
                  style={styles.viewerAvatar}
                />
                <View>
                  <Text style={styles.viewerName}>{item.userId?.fullName || 'Unknown'}</Text>
                  <Text style={styles.viewerTime}>{timeAgo(item.viewedAt)}</Text>
                </View>
              </View>
            )}
            ListEmptyComponent={<Text style={styles.noViewers}>No views yet</Text>}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  textContent: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 30 },
  textBody: { fontSize: 24, color: '#fff', textAlign: 'center', fontWeight: '500', lineHeight: 34 },
  mediaContent: { flex: 1, width: SCREEN_WIDTH },
  captionOverlay: { position: 'absolute', bottom: 80, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.6)', padding: 12 },
  captionText: { color: '#fff', fontSize: 15, textAlign: 'center' },
  touchZones: { ...StyleSheet.absoluteFillObject, flexDirection: 'row' },
  leftZone: { flex: 1 },
  rightZone: { flex: 1 },
  progressContainer: { position: 'absolute', top: 44, left: 8, right: 8, flexDirection: 'row', gap: 3 },
  progressTrack: { flex: 1, height: PROGRESS_HEIGHT, backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: '#fff', borderRadius: 2 },
  headerOverlay: { position: 'absolute', top: 54, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
  backBtn: { padding: 4, marginRight: 8 },
  headerAvatar: { width: 36, height: 36, borderRadius: 18, marginRight: 10 },
  headerText: { flex: 1 },
  headerName: { color: '#fff', fontSize: 15, fontWeight: '600' },
  headerTime: { color: 'rgba(255,255,255,0.7)', fontSize: 12 },
  deleteBtn: { padding: 8 },
  viewersBar: { position: 'absolute', bottom: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 16, gap: 8, backgroundColor: 'rgba(0,0,0,0.5)' },
  viewersText: { color: '#fff', fontSize: 14 },
  replyBar: { position: 'absolute', bottom: 0, left: 0, right: 0, alignItems: 'center', paddingVertical: 16, backgroundColor: 'rgba(0,0,0,0.5)' },
  replyText: { color: '#fff', fontSize: 14 },
  viewersList: { position: 'absolute', bottom: 50, left: 0, right: 0, maxHeight: 300, backgroundColor: 'rgba(0,0,0,0.9)', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16 },
  viewerItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: 12 },
  viewerAvatar: { width: 40, height: 40, borderRadius: 20 },
  viewerName: { color: '#fff', fontSize: 14, fontWeight: '600' },
  viewerTime: { color: 'rgba(255,255,255,0.6)', fontSize: 12 },
  noViewers: { color: 'rgba(255,255,255,0.5)', textAlign: 'center', paddingVertical: 20 },
});
