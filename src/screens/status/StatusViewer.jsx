/**
 * StatusViewer — full-screen status story player.
 * Uses only react-native Animated (no react-native-reanimated worklets).
 *
 * Features:
 *  • Animated.timing progress bars per slide
 *  • TouchableOpacity tap L/R to navigate, long-press to pause
 *  • Floating hearts on socket `status_like_animation` (Animated.Value)
 *  • Socket: status_reaction_update, status_expired / status_deleted
 *  • Owner bottom bar: views count + expandable viewers list
 *  • Viewer bottom bar: like/dislike reactions, reply modal, more options ActionSheet
 *  • expo-haptics on slide navigation
 */
import React, {
  useState, useEffect, useRef, useCallback,
} from 'react';
import {
  View, Text, Image, TouchableOpacity, StyleSheet,
  Dimensions, StatusBar, Alert, FlatList, TextInput,
  KeyboardAvoidingView, Platform, ActionSheetIOS,
  Modal, ActivityIndicator, Animated, Linking,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Video, ResizeMode } from 'expo-av';
import { useDispatch, useSelector } from 'react-redux';
import { Ionicons } from '@expo/vector-icons';
import {
  viewStatusAction, deleteStatusAction, fetchStatusViewers, fetchStatusLikers,
  removeLocalStatus, reactToStatusAction, replyToStatusAction,
  reportStatusAction, hideStatusAction, removeStatusFromSocket,
  handleReactionUpdateFromSocket, triggerLikeAnimation,
  clearLikeAnimation, seedReactionCache,
} from '../../Redux/Reducer/Status/Status.reducer';
import { getSocket } from '../../Redux/Services/Socket/socket';

const { width: SW, height: SH } = Dimensions.get('window');
const STORY_DURATION = 5000;
const VIDEO_MAX_MS   = 30000;
const PROGRESS_H     = 3;
const HEART_COUNT    = 6;

const timeAgo = (date) => {
  if (!date) return '';
  const d = Date.now() - new Date(date).getTime();
  if (d < 60000)   return 'Just now';
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  return `${Math.floor(d / 3600000)}h ago`;
};

// ── Floating heart (pure react-native Animated) ───────────────────────────────

function FloatingHeart({ delay, x, onDone }) {
  const translateY = useRef(new Animated.Value(0)).current;
  const opacity    = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const t = setTimeout(() => {
      Animated.parallel([
        Animated.timing(translateY, { toValue: -200, duration: 1500, useNativeDriver: true }),
        Animated.timing(opacity,    { toValue: 0,    duration: 1500, useNativeDriver: true }),
      ]).start(() => onDone?.());
    }, delay);
    return () => clearTimeout(t);
  }, []);

  return (
    <Animated.View
      style={{ position: 'absolute', bottom: 120, left: x, transform: [{ translateY }], opacity }}
      pointerEvents="none"
    >
      <Text style={{ fontSize: 28 }}>❤️</Text>
    </Animated.View>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function StatusViewer({ navigation, route }) {
  const {
    statuses: initialStatuses = [],
    startIndex = 0,
    isMine = false,
    userName = '',
    userImage = '',
    userId = null,
  } = route.params || {};

  const dispatch = useDispatch();
  const { viewers, likers, reactionCache, likeAnimationStatusId } = useSelector(s => s.status);
  const { user }  = useSelector(s => s.authentication);

  const [statuses, setStatuses]           = useState(initialStatuses);
  const [currentIndex, setCurrentIndex]   = useState(Math.min(startIndex, Math.max(0, initialStatuses.length - 1)));
  const [paused, setPaused]               = useState(false);
  const [videoDuration, setVideoDuration] = useState(STORY_DURATION);
  const [showViewers, setShowViewers]     = useState(false);
  const [activeTab, setActiveTab]         = useState('views'); // 'views' | 'likes'
  const panelSlide = useRef(new Animated.Value(SH)).current;
  const [showReply, setShowReply]         = useState(false);
  const [replyText, setReplyText]         = useState('');
  const [sending, setSending]             = useState(false);
  const [hearts, setHearts]               = useState([]);

  const progressAnim = useRef(new Animated.Value(0)).current;
  const animRef      = useRef(null);
  const videoRef     = useRef(null);
  const socketRef    = useRef(null);
  const pausedRef    = useRef(false);

  const currentStatus = statuses[currentIndex];
  const reactionData  = currentStatus ? (reactionCache[String(currentStatus._id)] || {}) : {};

  // ── Progress bar ─────────────────────────────────────────────────────────
  const startProgress = useCallback((duration) => {
    progressAnim.setValue(0);
    if (animRef.current) animRef.current.stop();
    animRef.current = Animated.timing(progressAnim, {
      toValue: 1,
      duration,
      useNativeDriver: false,
    });
    animRef.current.start(({ finished }) => {
      if (finished && !pausedRef.current) goNext();
    });
  }, []);

  useEffect(() => {
    if (pausedRef.current) {
      animRef.current?.stop();
      return;
    }
    const isVideo = currentStatus?.type === 'video';
    startProgress(isVideo ? videoDuration : STORY_DURATION);
    return () => animRef.current?.stop();
  }, [currentIndex, paused, videoDuration]);

  // Safe back — always works even if StatusViewer is the root screen
  const safeGoBack = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate('ChatList');
    }
  }, [navigation]);

  // ── Navigate ──────────────────────────────────────────────────────────────
  const goNext = useCallback(() => {
    setCurrentIndex(i => {
      if (i < statuses.length - 1) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        setVideoDuration(STORY_DURATION);
        return i + 1;
      }
      safeGoBack();
      return i;
    });
  }, [statuses.length, safeGoBack]);

  const goPrev = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentIndex(i => {
      if (i > 0) { setVideoDuration(STORY_DURATION); return i - 1; }
      safeGoBack();
      return i;
    });
  }, [safeGoBack]);

  const pause  = useCallback(() => { pausedRef.current = true;  setPaused(true);  animRef.current?.stop(); }, []);
  const resume = useCallback(() => { pausedRef.current = false; setPaused(false); }, []);

  const openPanel = useCallback((tab) => {
    setActiveTab(tab);
    setShowViewers(true);
    pausedRef.current = true; setPaused(true); animRef.current?.stop();
    panelSlide.setValue(SH);
    Animated.timing(panelSlide, { toValue: 0, duration: 300, useNativeDriver: true }).start();
  }, [panelSlide]);

  const closePanel = useCallback(() => {
    Animated.timing(panelSlide, { toValue: SH, duration: 250, useNativeDriver: true }).start(() => {
      setShowViewers(false);
      pausedRef.current = false; setPaused(false);
    });
  }, [panelSlide]);

  // ── View + seed reactions on index change ──────────────────────────────────
  useEffect(() => {
    if (!currentStatus) return;
    if (!isMine) {
      dispatch(viewStatusAction(currentStatus._id));
      dispatch(seedReactionCache({
        statusId:    String(currentStatus._id),
        myReaction:  currentStatus.myReaction   || null,
        likeCount:   currentStatus.likeCount    || 0,
        dislikeCount:currentStatus.dislikeCount || 0,
      }));
    } else {
      dispatch(fetchStatusViewers(currentStatus._id));
      dispatch(fetchStatusLikers(currentStatus._id));
    }
  }, [currentIndex, currentStatus?._id, isMine, dispatch]);

  // ── Socket listeners ──────────────────────────────────────────────────────
  useEffect(() => {
    const attach = () => {
      const socket = getSocket?.();
      if (!socket || socketRef.current === socket) return;

      const onExpired = ({ statusId }) => {
        dispatch(removeStatusFromSocket({ statusId }));
        setStatuses(prev => {
          const updated = prev.filter(s => String(s._id) !== String(statusId));
          if (updated.length === 0) safeGoBack();
          return updated;
        });
      };
      const onReactionUpdate = (payload) => dispatch(handleReactionUpdateFromSocket(payload));
      const onLikeAnim = ({ statusId }) => {
        if (currentStatus && String(statusId) === String(currentStatus._id)) {
          dispatch(triggerLikeAnimation({ statusId }));
        }
      };

      socket.on('status_expired',        onExpired);
      socket.on('status_deleted',        onExpired);
      // Only owner needs live reaction counts via socket; viewer gets it from API response
      if (isMine) socket.on('status_reaction_update', onReactionUpdate);
      socket.on('status_like_animation', onLikeAnim);
      socketRef.current = socket;

      return () => {
        socket.off('status_expired',        onExpired);
        socket.off('status_deleted',        onExpired);
        if (isMine) socket.off('status_reaction_update', onReactionUpdate);
        socket.off('status_like_animation', onLikeAnim);
      };
    };

    const cleanup  = attach();
    const interval = setInterval(() => { if (!socketRef.current) attach(); }, 2000);
    return () => { clearInterval(interval); cleanup?.(); socketRef.current = null; };
  }, [dispatch, currentStatus?._id, navigation]);

  // ── Floating hearts ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!likeAnimationStatusId || !currentStatus) return;
    if (String(likeAnimationStatusId) !== String(currentStatus._id)) return;
    dispatch(clearLikeAnimation());
    const newHearts = Array.from({ length: HEART_COUNT }, (_, i) => ({
      id: Date.now() + i,
      delay: i * 120,
      x: 30 + Math.random() * (SW - 80),
    }));
    setHearts(h => [...h, ...newHearts]);
  }, [likeAnimationStatusId, currentStatus?._id, dispatch]);

  const removeHeart = useCallback((id) => {
    setHearts(h => h.filter(hh => hh.id !== id));
  }, []);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleDelete = useCallback(() => {
    pause();
    Alert.alert(
      'Delete Status',
      'This status will be deleted for everyone.',
      [
        { text: 'Cancel', style: 'cancel', onPress: resume },
        {
          text: 'Delete', style: 'destructive',
          onPress: () => {
            dispatch(deleteStatusAction(currentStatus._id));
            dispatch(removeLocalStatus(currentStatus._id));
            setStatuses(prev => {
              const updated = prev.filter(s => s._id !== currentStatus._id);
              if (updated.length === 0) safeGoBack();
              return updated;
            });
          },
        },
      ],
      { cancelable: false },
    );
  }, [currentStatus?._id, dispatch, pause, resume, safeGoBack]);

  const handleReport = useCallback(() => {
    pause();
    Alert.alert(
      'Report Status',
      'Report this status as inappropriate?',
      [
        { text: 'Cancel', style: 'cancel', onPress: resume },
        {
          text: 'Report', style: 'destructive',
          onPress: () => {
            dispatch(reportStatusAction({ statusId: currentStatus._id, reason: 'inappropriate', details: '' }));
            resume();
          },
        },
      ],
      { cancelable: false },
    );
  }, [currentStatus?._id, dispatch, pause, resume]);

  const handleHide = useCallback(() => {
    dispatch(hideStatusAction(currentStatus._id));
    setStatuses(prev => {
      const updated = prev.filter(s => s._id !== currentStatus._id);
      if (updated.length === 0) safeGoBack();
      return updated;
    });
  }, [currentStatus?._id, dispatch, navigation]);

  const openOptions = useCallback(() => {
    pause();
    if (isMine) {
      if (Platform.OS === 'ios') {
        ActionSheetIOS.showActionSheetWithOptions(
          { options: ['Cancel', 'Delete Status', 'View Viewers'], cancelButtonIndex: 0, destructiveButtonIndex: 1 },
          (idx) => {
            // handleDelete/handleReport manage their own pause; resume for all other paths
            if (idx === 1) { handleDelete(); return; }
            if (idx === 2) { resume(); openPanel('views'); return; }
            resume(); // Cancel
          },
        );
      } else {
        Alert.alert('Status Options', '', [
          { text: 'Delete Status', style: 'destructive', onPress: handleDelete },
          { text: 'View Viewers', onPress: () => { resume(); openPanel('views'); } },
          { text: 'Cancel', style: 'cancel', onPress: resume },
        ], { cancelable: false });
      }
    } else {
      if (Platform.OS === 'ios') {
        ActionSheetIOS.showActionSheetWithOptions(
          { options: ['Cancel', 'Report', 'Hide this status'], cancelButtonIndex: 0, destructiveButtonIndex: 1 },
          (idx) => {
            if (idx === 1) { handleReport(); return; }
            if (idx === 2) { resume(); handleHide(); return; }
            resume(); // Cancel
          },
        );
      } else {
        Alert.alert('Status Options', '', [
          { text: 'Report',           style: 'destructive', onPress: handleReport },
          { text: 'Hide this status', onPress: () => { resume(); handleHide(); } },
          { text: 'Cancel',           style: 'cancel',      onPress: resume },
        ], { cancelable: false });
      }
    }
  }, [isMine, pause, resume, handleDelete, handleReport, handleHide, openPanel]);

  const handleReact = useCallback((reactionType) => {
    if (!currentStatus) return;
    // Always send reactionType — backend toggle() removes if already liked, adds if not
    dispatch(reactToStatusAction({ statusId: currentStatus._id, reactionType }));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, [currentStatus?._id, dispatch]);

  const handleReply = useCallback(async () => {
    if (!replyText.trim() || !currentStatus) return;
    setSending(true);
    try {
      await dispatch(replyToStatusAction({ statusId: currentStatus._id, message: replyText.trim() })).unwrap();
      setReplyText('');
      setShowReply(false);
      resume();
    } catch {
      Alert.alert('Error', 'Could not send reply. Please try again.');
    } finally {
      setSending(false);
    }
  }, [replyText, currentStatus?._id, dispatch, resume]);

  const onPlaybackStatusUpdate = useCallback((status) => {
    if (status.isLoaded && status.durationMillis && videoDuration === STORY_DURATION) {
      setVideoDuration(Math.min(status.durationMillis, VIDEO_MAX_MS));
    }
    if (status.didJustFinish) goNext();
  }, [videoDuration, goNext]);

  // Guard: if statuses list becomes empty (e.g. all expired), go back.
  // Must be in useEffect — calling navigation during render causes the
  // "Cannot update a component while rendering a different component" error.
  useEffect(() => {
    if (!currentStatus) safeGoBack();
  }, [currentStatus, navigation]);

  if (!currentStatus) return null;

  const displayName  = isMine ? (user?.fullName || 'My Status') : userName;
  const displayImage = isMine ? user?.profileImage : userImage;
  const likeActive = reactionData.myReaction === 'like';

  // ── Render content ────────────────────────────────────────────────────────
  // Backend schema:  status.mediaItems[0].mediaType / mediaUrl
  //                  status.textContent  (text statuses)
  //                  status.bgColor      (text background)
  // There is NO top-level `type`, `text`, `backgroundColor`, or `mediaUrl`.
  const renderContent = () => {
    const firstItem  = currentStatus?.mediaItems?.[0];
    // Derive type: prefer the mediaItem's mediaType, fall back to text if textContent exists
    const statusType = firstItem?.mediaType
      ?? (currentStatus?.textContent ? 'text' : null);
    const mediaUrl   = firstItem?.mediaUrl;

    switch (statusType) {
      case 'text':
        return (
          <View style={[styles.textContent, { backgroundColor: currentStatus.bgColor || '#075e54' }]}>
            <Text style={styles.textBody}>{currentStatus.textContent}</Text>
          </View>
        );
      case 'image':
        return (
          <Image
            source={{ uri: mediaUrl }}
            style={styles.mediaContent}
            resizeMode="contain"
          />
        );
      case 'video':
        return (
          <Video
            ref={videoRef}
            source={{ uri: mediaUrl }}
            style={styles.mediaContent}
            resizeMode={ResizeMode.CONTAIN}
            shouldPlay={!paused}
            isLooping={false}
            onPlaybackStatusUpdate={onPlaybackStatusUpdate}
            useNativeControls={false}
          />
        );
      case 'audio':
        return (
          <View style={[styles.textContent, { backgroundColor: '#2d3436' }]}>
            <Ionicons name="musical-notes" size={60} color="#fff" />
            <Text style={styles.audioLabel}>Audio Status</Text>
          </View>
        );
      case 'link': {
        const linkHref = currentStatus.ogMetadata?.url || currentStatus.textContent;
        return (
          <TouchableOpacity
            style={styles.linkContent}
            activeOpacity={0.85}
            onPress={() => linkHref && Linking.openURL(linkHref).catch(() => Alert.alert('Cannot open link', linkHref))}
          >
            {currentStatus.ogMetadata?.image
              ? <Image source={{ uri: currentStatus.ogMetadata.image }} style={styles.linkImage} resizeMode="cover" />
              : null
            }
            <View style={styles.linkBody}>
              <Text style={styles.linkTitle} numberOfLines={2}>
                {currentStatus.ogMetadata?.title || linkHref}
              </Text>
              {currentStatus.ogMetadata?.description
                ? <Text style={styles.linkDesc} numberOfLines={3}>{currentStatus.ogMetadata.description}</Text>
                : null
              }
              <View style={styles.linkUrlRow}>
                <Ionicons name="open-outline" size={12} color="#60a5fa" style={{ marginRight: 4 }} />
                <Text style={styles.linkUrl} numberOfLines={1}>{linkHref}</Text>
              </View>
            </View>
          </TouchableOpacity>
        );
      }
      default:
        // Fallback: show textContent if present, otherwise loading indicator
        if (currentStatus?.textContent) {
          return (
            <View style={[styles.textContent, { backgroundColor: currentStatus.bgColor || '#075e54' }]}>
              <Text style={styles.textBody}>{currentStatus.textContent}</Text>
            </View>
          );
        }
        return (
          <View style={[styles.textContent, { backgroundColor: '#1a1a2e' }]}>
            <ActivityIndicator color="#fff" size="large" />
          </View>
        );
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar hidden />

      {/* Content */}
      {renderContent()}

      {/* Caption */}
      {currentStatus.caption && (
        <View style={styles.captionOverlay}>
          <Text style={styles.captionText}>{currentStatus.caption}</Text>
        </View>
      )}

      {/* Floating hearts */}
      {hearts.map(h => (
        <FloatingHeart key={h.id} delay={h.delay} x={h.x} onDone={() => removeHeart(h.id)} />
      ))}

      {/* Tap zones — WhatsApp asymmetric: left 30% prev, right 70% next */}
      <View style={styles.touchZones}>
        <TouchableOpacity
          style={styles.leftZone}
          onPress={goPrev}
          onLongPress={pause}
          onPressOut={resume}
          activeOpacity={1}
        />
        <TouchableOpacity
          style={styles.rightZone}
          onPress={goNext}
          onLongPress={pause}
          onPressOut={resume}
          activeOpacity={1}
        />
      </View>

      {/* Top gradient overlay — dark scrim behind progress + header */}
      <View style={styles.topGradient} pointerEvents="none">
        <View style={[styles.gradientLayer, { opacity: 0.55 }]} />
        <View style={[styles.gradientLayer, { opacity: 0.35 }]} />
        <View style={[styles.gradientLayer, { opacity: 0.18 }]} />
        <View style={[styles.gradientLayer, { opacity: 0.07 }]} />
      </View>

      {/* Bottom gradient overlay — dark scrim behind action bars */}
      <View style={styles.bottomGradient} pointerEvents="none">
        <View style={[styles.gradientLayer, { opacity: 0.07 }]} />
        <View style={[styles.gradientLayer, { opacity: 0.18 }]} />
        <View style={[styles.gradientLayer, { opacity: 0.35 }]} />
        <View style={[styles.gradientLayer, { opacity: 0.55 }]} />
      </View>

      {/* Progress bars */}
      <View style={styles.progressContainer}>
        {statuses.map((_, i) => (
          <View key={i} style={styles.progressTrack}>
            <Animated.View style={[styles.progressFill, {
              width: i < currentIndex
                ? '100%'
                : i === currentIndex
                  ? progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] })
                  : '0%',
            }]} />
          </View>
        ))}
      </View>

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeGoBack()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>

        {/* Avatar + name — tappable to open profile */}
        <TouchableOpacity
          style={styles.headerProfile}
          activeOpacity={0.8}
          onPress={() => {
            pause();
            if (isMine) {
              navigation.navigate('UserB', {
                item: { _id: user?._id, fullName: user?.fullName, profileImage: user?.profileImage },
              });
            } else if (userId) {
              navigation.navigate('UserB', {
                item: { _id: userId, fullName: displayName, profileImage: displayImage },
              });
            }
          }}
        >
          <Image
            source={displayImage ? { uri: displayImage } : require('../../../assets/icon.png')}
            style={styles.headerAvatar}
          />
          <View style={styles.headerText}>
            <Text style={styles.headerName}>{displayName}</Text>
            <Text style={styles.headerTime}>{timeAgo(currentStatus.createdAt)}</Text>
          </View>
        </TouchableOpacity>

        {/* Options only in header for owner; non-owner gets it in the bottom bar */}
        {isMine && (
          <TouchableOpacity onPress={openOptions} style={styles.moreBtn}>
            <Ionicons name="ellipsis-vertical" size={20} color="#fff" />
          </TouchableOpacity>
        )}
      </View>

      {/* Bottom bar */}
      {isMine ? (
        /* ── Owner bottom: tab bar ── */
        <View style={styles.ownerBar}>
          <View style={styles.ownerTabs}>
            <TouchableOpacity
              style={[styles.ownerTab, showViewers && activeTab === 'views' && styles.ownerTabActive]}
              onPress={() => showViewers && activeTab === 'views' ? closePanel() : openPanel('views')}
            >
              <Ionicons name="eye-outline" size={15} color="#fff" />
              <Text style={styles.ownerTabText}>
                {viewers?.viewCount ?? currentStatus.viewCount ?? 0} Viewed
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.ownerTab, showViewers && activeTab === 'likes' && styles.ownerTabActive]}
              onPress={() => showViewers && activeTab === 'likes' ? closePanel() : openPanel('likes')}
            >
              <Ionicons name="heart-outline" size={15} color="#fff" />
              <Text style={styles.ownerTabText}>
                {likers?.total ?? currentStatus.likeCount ?? 0} Liked
              </Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={handleDelete} style={styles.deleteBtn}>
            <Ionicons name="trash-outline" size={20} color="rgba(255,255,255,0.8)" />
          </TouchableOpacity>
        </View>
      ) : (
        /* ── Viewer bottom bar ── */
        <View style={styles.viewerBar}>
          <TouchableOpacity
            style={styles.replyInputTrigger}
            onPress={() => { pause(); setShowReply(true); }}
          >
            <Text style={styles.replyPlaceholder}>Reply to {displayName}…</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.reactBtn} onPress={() => handleReact('like')}>
            <Ionicons name={likeActive ? 'heart' : 'heart-outline'} size={24} color={likeActive ? '#FF4757' : '#fff'} />
            {(reactionData.likeCount > 0) && <Text style={styles.reactCount}>{reactionData.likeCount}</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.reactBtn} onPress={openOptions}>
            <Ionicons name="ellipsis-vertical" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      )}

      {/* Viewers / Likers bottom-sheet */}
      {showViewers && isMine && (
        <>
          {/* Backdrop — tap anywhere above the panel to dismiss */}
          <TouchableOpacity
            style={styles.panelBackdrop}
            activeOpacity={1}
            onPress={closePanel}
          />

          {/* Animated slide-up panel */}
          <Animated.View style={[styles.viewersList, { transform: [{ translateY: panelSlide }] }]}>
            {/* Drag handle / close tap */}
            <TouchableOpacity style={styles.viewersHandle} onPress={closePanel} activeOpacity={0.7}>
              <View style={styles.viewersHandleBar} />
            </TouchableOpacity>

            {/* Tab switcher */}
            <View style={styles.panelTabs}>
              <TouchableOpacity
                style={[styles.panelTab, activeTab === 'views' && styles.panelTabActive]}
                onPress={() => setActiveTab('views')}
              >
                <Text style={[styles.panelTabText, activeTab === 'views' && styles.panelTabTextActive]}>
                  Viewed by {viewers?.viewCount || 0}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.panelTab, activeTab === 'likes' && styles.panelTabActive]}
                onPress={() => setActiveTab('likes')}
              >
                <Text style={[styles.panelTabText, activeTab === 'likes' && styles.panelTabTextActive]}>
                  Liked by {likers?.total || 0}
                </Text>
              </TouchableOpacity>
            </View>

            {activeTab === 'views' ? (
              <FlatList
                data={viewers?.viewers || []}
                keyExtractor={(item, i) => item?.viewerId?._id || item?.userId?._id || String(i)}
                renderItem={({ item }) => {
                  const viewer = item.viewerId || item.userId;
                  return (
                    <View style={styles.viewerItem}>
                      <Image
                        source={viewer?.profileImage ? { uri: viewer.profileImage } : require('../../../assets/icon.png')}
                        style={styles.viewerAvatar}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.viewerName}>{viewer?.fullName || viewer?.userName || 'Unknown'}</Text>
                        <Text style={styles.viewerTime}>{timeAgo(item.viewedAt)}</Text>
                      </View>
                      {item.reactionType === 'like' && (
                        <Text style={{ fontSize: 16 }}>❤️</Text>
                      )}
                    </View>
                  );
                }}
                ListEmptyComponent={<Text style={styles.noViewers}>No views yet</Text>}
              />
            ) : (
              <FlatList
                data={likers?.likedBy || []}
                keyExtractor={(item, i) => item?.userId || String(i)}
                renderItem={({ item }) => (
                  <View style={styles.viewerItem}>
                    <Image
                      source={item.avatar ? { uri: item.avatar } : require('../../../assets/icon.png')}
                      style={styles.viewerAvatar}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.viewerName}>{item.name || 'Unknown'}</Text>
                      <Text style={styles.viewerTime}>{timeAgo(item.likedAt)}</Text>
                    </View>
                    <Text style={{ fontSize: 16 }}>❤️</Text>
                  </View>
                )}
                ListEmptyComponent={<Text style={styles.noViewers}>No likes yet</Text>}
              />
            )}
          </Animated.View>
        </>
      )}

      {/* Reply modal */}
      <Modal visible={showReply} transparent animationType="slide" onRequestClose={() => { setShowReply(false); resume(); }}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.replyModal}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => { setShowReply(false); resume(); }} />
          <View style={styles.replySheet}>
            <Text style={styles.replySheetTitle}>Reply to {displayName}</Text>
            <View style={styles.replyRow}>
              <TextInput
                style={styles.replyInput}
                placeholder="Type a reply…"
                placeholderTextColor="#94a3b8"
                value={replyText}
                onChangeText={setReplyText}
                autoFocus
                multiline
                maxLength={500}
              />
              <TouchableOpacity
                style={[styles.replySend, { opacity: replyText.trim() ? 1 : 0.4 }]}
                onPress={handleReply}
                disabled={sending || !replyText.trim()}
              >
                {sending
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Ionicons name="send" size={20} color="#fff" />
                }
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#111B21' },

  textContent: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 30 },
  textBody:    { fontSize: 24, color: '#fff', textAlign: 'center', fontWeight: '500', lineHeight: 34 },
  audioLabel:  { color: '#fff', marginTop: 12, fontSize: 16 },
  mediaContent:{ flex: 1, width: SW },

  captionOverlay: { position: 'absolute', bottom: 80, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.55)', padding: 12 },
  captionText:    { color: '#fff', fontSize: 15, textAlign: 'center' },

  // Tap zones — WhatsApp asymmetric (30 % prev / 70 % next)
  touchZones: { ...StyleSheet.absoluteFillObject, flexDirection: 'row' },
  leftZone:   { width: SW * 0.30 },
  rightZone:  { flex: 1 },

  // Gradient overlays (simulated with stacked semi-transparent layers)
  topGradient: {
    position: 'absolute', top: 0, left: 0, right: 0,
    height: 110,
    flexDirection: 'column',
    overflow: 'hidden',
  },
  bottomGradient: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    height: 130,
    flexDirection: 'column',
    overflow: 'hidden',
  },
  gradientLayer: {
    flex: 1,
    backgroundColor: '#000',
  },

  // Progress
  progressContainer: { position: 'absolute', top: 48, left: 8, right: 8, flexDirection: 'row', gap: 3 },
  progressTrack:     { flex: 1, height: 2, backgroundColor: 'rgba(255,255,255,0.4)', borderRadius: 1, overflow: 'hidden' },
  progressFill:      { height: '100%', backgroundColor: '#fff', borderRadius: 1 },

  // Header
  header:        { position: 'absolute', top: 56, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
  backBtn:       { padding: 4, marginRight: 8 },
  headerProfile: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  headerAvatar:  { width: 38, height: 38, borderRadius: 19, marginRight: 10, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.6)' },
  headerText:    { flex: 1 },
  headerName:  { color: '#fff', fontSize: 15, fontWeight: '600' },
  headerTime:  { color: 'rgba(255,255,255,0.65)', fontSize: 12 },
  moreBtn:     { padding: 8 },
  deleteBtn:   { padding: 8 },

  // Owner bar
  ownerBar:       { position: 'absolute', bottom: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, paddingBottom: 28, backgroundColor: 'rgba(0,0,0,0.5)' },
  ownerTabs:      { flexDirection: 'row', flex: 1, gap: 8 },
  ownerTab:       { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.12)' },
  ownerTabActive: { backgroundColor: 'rgba(255,255,255,0.25)' },
  ownerTabText:   { color: '#fff', fontSize: 13, fontWeight: '600' },
  // Panel tabs (inside the slide-up sheet)
  panelTabs:        { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.1)', marginBottom: 8 },
  panelTab:         { flex: 1, paddingVertical: 10, alignItems: 'center' },
  panelTabActive:   { borderBottomWidth: 2, borderBottomColor: '#25D366' },
  panelTabText:     { color: 'rgba(255,255,255,0.55)', fontSize: 14, fontWeight: '600' },
  panelTabTextActive: { color: '#fff' },

  // Viewer bar
  viewerBar:         { position: 'absolute', bottom: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 14, paddingBottom: 28, backgroundColor: 'rgba(0,0,0,0.3)' },
  reactBtn:          { alignItems: 'center', paddingHorizontal: 6 },
  reactCount:        { color: '#fff', fontSize: 11, marginTop: 2 },
  replyInputTrigger: { flex: 1, marginHorizontal: 8, height: 42, borderRadius: 21, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.7)', justifyContent: 'center', paddingHorizontal: 16 },
  replyPlaceholder:  { color: 'rgba(255,255,255,0.75)', fontSize: 14 },

  // Viewers panel
  panelBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'transparent' },
  viewersList:   { position: 'absolute', bottom: 0, left: 0, right: 0, height: SH * 0.50, backgroundColor: '#1D2B33', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 16, paddingBottom: 32 },
  viewersHandle: { alignItems: 'center', paddingVertical: 10 },
  viewersHandleBar: { width: 36, height: 4, backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 2 },
  viewersTitle:  { color: '#fff', fontSize: 16, fontWeight: '700', marginBottom: 8 },
  viewerItem:   { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: 12 },
  viewerAvatar: { width: 40, height: 40, borderRadius: 20 },
  viewerName:   { color: '#fff', fontSize: 14, fontWeight: '600' },
  viewerTime:   { color: 'rgba(255,255,255,0.55)', fontSize: 12 },
  noViewers:    { color: 'rgba(255,255,255,0.45)', textAlign: 'center', paddingVertical: 20 },

  // Link status
  linkContent: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#1a1a2e', padding: 20 },
  linkImage:   { width: SW, height: 220 },
  linkBody:    { padding: 20, width: '100%' },
  linkTitle:   { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  linkDesc:    { color: 'rgba(255,255,255,0.7)', fontSize: 14, marginBottom: 8 },
  linkUrlRow:  { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  linkUrl:     { color: '#60a5fa', fontSize: 12, flex: 1 },

  // Reply modal
  replyModal:      { flex: 1, justifyContent: 'flex-end' },
  replySheet:      { backgroundColor: '#1D2B33', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: Platform.OS === 'ios' ? 36 : 20 },
  replySheetTitle: { color: '#fff', fontSize: 16, fontWeight: '700', marginBottom: 12 },
  replyRow:        { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  replyInput:      { flex: 1, borderRadius: 18, backgroundColor: '#2A3942', paddingHorizontal: 14, paddingVertical: 10, color: '#fff', fontSize: 15, maxHeight: 120 },
  replySend:       { width: 44, height: 44, borderRadius: 22, backgroundColor: '#25D366', alignItems: 'center', justifyContent: 'center' },
});
