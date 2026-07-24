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
  Platform, ActionSheetIOS,
  Modal, ActivityIndicator, Animated, Linking, AppState, Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Video, ResizeMode } from 'expo-av';
import { useDispatch, useSelector } from 'react-redux';
import { Ionicons } from '@expo/vector-icons';
import {
  viewStatusAction, deleteStatusAction, fetchStatusViewers, fetchStatusLikers,
  removeLocalStatus, reactToStatusAction, replyToStatusAction, optimisticReact,
  reportStatusAction, hideStatusAction, removeStatusFromSocket,
  handleReactionUpdateFromSocket, triggerLikeAnimation,
  clearLikeAnimation, seedReactionCache,
} from '../../Redux/Reducer/Status/Status.reducer';
import { getSocket } from '../../Redux/Services/Socket/socket';
import useContactDirectory from '../../hooks/useContactDirectory';
import { toSecureMediaUri } from '../../utils/mediaService';
import { profileDetail } from '../../Redux/Reducer/Profile/Profile.reducer';
import ReportBottomSheet from '../../components/ReportBottomSheet';

const { width: SW, height: SH } = Dimensions.get('window');
// Full-SCREEN height (incl. system bars). The keyboard's endCoordinates.screenY
// is measured in full-screen coordinates, so deriving keyboard height as
// (screenY − top) must use the SCREEN height — not the window height, which in
// Android edge-to-edge mode is smaller and made (window − screenY) go negative
// → kbHeight clamped to 0 → the composer never lifted ("input box bottom pe").
const SCREEN_H = Dimensions.get('screen').height;
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
    isBroadcast = false,
  } = route.params || {};

  const dispatch = useDispatch();
  const { viewers, likers, reactionCache, likeAnimationStatusId } = useSelector(s => s.status);
  const { user }  = useSelector(s => s.authentication);
  const { profileData } = useSelector(s => s.profile);
  // Saved-contact resolver for the viewers/likers lists. Saved name → phone
  // number → server-provided name. Same rule used across the status list.
  const { resolveName: resolveContactName } = useContactDirectory();

  const [statuses, setStatuses]           = useState(initialStatuses);
  const [currentIndex, setCurrentIndex]   = useState(Math.min(startIndex, Math.max(0, initialStatuses.length - 1)));
  const [paused, setPaused]               = useState(false);
  const [videoDuration, setVideoDuration] = useState(STORY_DURATION);
  const [showViewers, setShowViewers]     = useState(false);
  const [reportVisible, setReportVisible] = useState(false);
  const [activeTab, setActiveTab]         = useState('views'); // 'views' | 'likes'
  const panelSlide = useRef(new Animated.Value(SH)).current;
  const [showReply, setShowReply]         = useState(false);
  const [replyText, setReplyText]         = useState('');
  const [sending, setSending]             = useState(false);
  const insets = useSafeAreaInsets();
  // The reply composer lives inside a <Modal>, which on Android renders in a
  // separate dialog window that does NOT inherit the activity's adjustResize.
  // So KeyboardAvoidingView can't lift it — we track the keyboard height
  // ourselves and offset the sheet above the keyboard manually.
  const [kbHeight, setKbHeight] = useState(0);
  // Hide the system status bar ONLY while this viewer is focused, and always
  // restore it on blur/unmount. Using the declarative `<StatusBar hidden />`
  // leaked the hidden state onto the next screen (its prop persisted in RN's
  // merge stack while this screen stayed mounted underneath), so other screens
  // — e.g. a contact profile — opened with no time/battery/signal. This
  // focus-scoped imperative control guarantees the bar comes back.
  useEffect(() => {
    const hideBar = () => StatusBar.setHidden(true, 'fade');
    const showBar = () => StatusBar.setHidden(false, 'fade');
    hideBar();
    const focusSub = navigation.addListener('focus', hideBar);
    const blurSub = navigation.addListener('blur', showBar);
    return () => {
      showBar();
      focusSub();
      blurSub();
    };
  }, [navigation]);

  // Attached for the SCREEN's lifetime — deliberately NOT gated on showReply.
  // The reply input autoFocuses, so the keyboard's show event can fire before
  // a showReply-gated effect had attached its listener; the missed event left
  // kbHeight at 0 and the composer sat hidden BEHIND the keyboard ("keyboard
  // khul gaya par input box bottom pe hi reh gaya").
  useEffect(() => {
    const onShow = (e) => {
      const coords = e?.endCoordinates;
      // Prefer the reported height, but ALSO derive it from screenY (FULL-screen
      // height − keyboard top): Android in edge-to-edge mode reports height 0
      // for some translucent-Modal configurations, and screenY still holds.
      // Must use SCREEN_H (not window height SH) — screenY is in full-screen
      // coords, so window − screenY under-counted / went negative in edge-to-edge
      // and the lift collapsed to 0.
      const derived = coords?.screenY != null ? SCREEN_H - coords.screenY : 0;
      setKbHeight(Math.max(0, coords?.height ?? 0, derived));
    };
    const onHide = () => setKbHeight(0);
    const subs = [];
    if (Platform.OS === 'ios') {
      subs.push(Keyboard.addListener('keyboardWillShow', onShow));
      subs.push(Keyboard.addListener('keyboardWillHide', onHide));
    }
    // Android only emits the did* pair; kept on iOS too as a safety net for a
    // will* event missed during a modal presentation transition.
    subs.push(Keyboard.addListener('keyboardDidShow', onShow));
    subs.push(Keyboard.addListener('keyboardDidHide', onHide));
    return () => subs.forEach((s) => s.remove());
  }, []);
  // Opening the composer while the keyboard is ALREADY up (e.g. it never
  // animated away between two replies) fires no new show event — seed the
  // offset from the live keyboard metrics so the sheet starts lifted.
  useEffect(() => {
    if (!showReply) return;
    const m = typeof Keyboard.metrics === 'function' ? Keyboard.metrics() : null;
    if (m && m.height > 0) setKbHeight(m.height);
  }, [showReply]);
  const [hearts, setHearts]               = useState([]);
  // Mute toggle for video / audio statuses (top-right speaker icon). Default
  // to unmuted; the user can tap to silence — preference persists across
  // slides within the same viewer session.
  const [isMuted, setIsMuted]             = useState(false);
  // WhatsApp-style: hold the progress bar until the slide's media has actually
  // loaded, and show a blurred placeholder until then. Reset for every slide.
  const [mediaLoaded, setMediaLoaded]     = useState(false);

  const progressAnim = useRef(new Animated.Value(0)).current;
  const animRef      = useRef(null);
  const videoRef     = useRef(null);
  const socketRef    = useRef(null);
  const pausedRef    = useRef(false);

  const currentStatus = statuses[currentIndex];
  const reactionData  = currentStatus ? (reactionCache[String(currentStatus._id)] || {}) : {};

  // Media fields live under `mediaItems[0]` for OWN statuses (/my endpoint) but at
  // the TOP LEVEL of the status object for OTHER users' statuses (/feed endpoint
  // and the socket fan-out). Resolve from BOTH shapes so others' statuses render
  // and gate the progress bar correctly instead of being skipped over a blank.
  const currentMediaItem = currentStatus?.mediaItems?.[0] || null;
  const currentMediaType =
    currentMediaItem?.mediaType || currentStatus?.mediaType || currentStatus?.type
    || (currentStatus?.textContent ? 'text' : null);
  const currentMediaUrl =
    currentMediaItem?.mediaUrl || currentStatus?.mediaUrl
    || currentMediaItem?.thumbnailUrl || currentStatus?.thumbnailUrl || null;
  const currentThumbUrl =
    currentMediaItem?.thumbnailUrl || currentStatus?.thumbnailUrl
    || currentMediaItem?.mediaUrl || currentStatus?.mediaUrl || null;

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

  // Every slide starts "not loaded" so the bar waits for its own media.
  useEffect(() => { setMediaLoaded(false); }, [currentIndex]);

  useEffect(() => {
    if (pausedRef.current) {
      animRef.current?.stop();
      return;
    }
    // Schema has no top-level `type` field on a Status — derive from the
    // first media item's mediaType so videos actually run for their full
    // duration instead of getting auto-skipped after STORY_DURATION.
    const isVideo = currentMediaType === 'video';
    const needsMedia = currentMediaType === 'image' || isVideo;
    // WhatsApp behaviour: for image/video slides, DON'T advance the progress bar
    // until the media has actually loaded (onLoad / playback isLoaded). Hold it at
    // 0 so a slow-loading photo/video is never skipped over a blank screen.
    // Text / link / audio have nothing to wait for.
    if (needsMedia && !mediaLoaded) {
      animRef.current?.stop();
      progressAnim.setValue(0);
      return;
    }
    startProgress(isVideo ? videoDuration : STORY_DURATION);
    return () => animRef.current?.stop();
  }, [currentIndex, paused, videoDuration, mediaLoaded]);

  // Safe back — always works even if StatusViewer is the root screen
  const safeGoBack = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate('ChatList');
    }
  }, [navigation]);

  // ── Navigate ──────────────────────────────────────────────────────────────
  // Note: navigation calls must NEVER happen inside a setState updater —
  // React may invoke the updater during render, which triggers
  // "Cannot update a component while rendering a different component"
  // and can also abort in-flight network requests (iOS surfaces this as ERR_NETWORK).
  const goNext = useCallback(() => {
    setCurrentIndex(i => {
      if (i < statuses.length - 1) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        setVideoDuration(STORY_DURATION);
        return i + 1;
      }
      setTimeout(() => safeGoBack(), 0);
      return i;
    });
  }, [statuses.length, safeGoBack]);

  const goPrev = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentIndex(i => {
      if (i > 0) { setVideoDuration(STORY_DURATION); return i - 1; }
      setTimeout(() => safeGoBack(), 0);
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

  // Ensure the current user's profile image is loaded for the "My Status"
  // header avatar — the profile slice may be empty if the user hasn't opened
  // the Profile/Settings screen this session.
  useEffect(() => {
    if (isMine && !profileData?.profileImage) {
      dispatch(profileDetail()).catch?.(() => {});
    }
  }, [isMine, profileData?.profileImage, dispatch]);

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

  // ── Pause auto-progress when app backgrounded ─────────────────────────────
  // Without this the progress timer keeps running while the user is in
  // another app, then snaps several slides forward on return.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        pausedRef.current = false; setPaused(false);
      } else {
        pausedRef.current = true;  setPaused(true);
        animRef.current?.stop();
      }
    });
    return () => sub.remove();
  }, []);

  // ── Socket listeners ──────────────────────────────────────────────────────
  useEffect(() => {
    const attach = () => {
      const socket = getSocket?.();
      if (!socket || socketRef.current === socket) return;

      const onExpired = ({ statusId }) => {
        dispatch(removeStatusFromSocket({ statusId }));
        // Don't call safeGoBack here — useEffect on `!currentStatus` handles
        // navigating back once the list becomes empty.
        setStatuses(prev => prev.filter(s => String(s._id) !== String(statusId)));
      };
      const onReactionUpdate = (payload) => dispatch(handleReactionUpdateFromSocket(payload));
      const onLikeAnim = ({ statusId }) => {
        if (currentStatus && String(statusId) === String(currentStatus._id)) {
          dispatch(triggerLikeAnimation({ statusId }));
        }
      };

      // Canonical backend event is `status:deleted` (colon); underscore
      // variants kept as legacy aliases.
      socket.on('status:deleted',        onExpired);
      socket.on('status_deleted',        onExpired);
      socket.on('status_expired',        onExpired);
      // Only owner needs live reaction counts via socket; viewer gets it from API response
      if (isMine) socket.on('status_reaction_update', onReactionUpdate);
      socket.on('status_like_animation', onLikeAnim);
      socketRef.current = socket;

      return () => {
        socket.off('status:deleted',        onExpired);
        socket.off('status_deleted',        onExpired);
        socket.off('status_expired',        onExpired);
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
            setStatuses(prev => prev.filter(s => s._id !== currentStatus._id));
          },
        },
      ],
      { cancelable: false },
    );
  }, [currentStatus?._id, dispatch, pause, resume, safeGoBack]);

  const handleReport = useCallback(() => {
    pause();
    setReportVisible(true);
  }, [pause]);

  const handleHide = useCallback(() => {
    dispatch(hideStatusAction(currentStatus._id));
    setStatuses(prev => prev.filter(s => s._id !== currentStatus._id));
  }, [currentStatus?._id, dispatch]);

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
          { options: ['Cancel', 'Report'], cancelButtonIndex: 0, destructiveButtonIndex: 1 },
          (idx) => {
            if (idx === 1) { handleReport(); return; }
            resume(); // Cancel
          },
        );
      } else {
        Alert.alert('Status Options', '', [
          { text: 'Report', style: 'destructive', onPress: handleReport },
          { text: 'Cancel', style: 'cancel',     onPress: resume },
        ], { cancelable: false });
      }
    }
  }, [isMine, pause, resume, handleDelete, handleReport, openPanel]);

  const handleReact = useCallback((reactionType) => {
    if (!currentStatus) return;
    // Optimistic flip first so the heart/icon updates instantly; the thunk's
    // .rejected handler rolls back from the snapshot if the request fails.
    dispatch(optimisticReact({ statusId: currentStatus._id, reactionType }));
    dispatch(reactToStatusAction({ statusId: currentStatus._id, reactionType }));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, [currentStatus?._id, dispatch]);

  const handleReply = useCallback(async () => {
    if (!replyText.trim() || !currentStatus) return;
    setSending(true);
    const body = replyText.trim();
    try {
      const res = await dispatch(replyToStatusAction({
        statusId: currentStatus._id,
        message:  body,
      })).unwrap();

      // Optimistically write the chat-side message into local SQLite so the
      // sender immediately sees it in their chat thread with the status
      // preview attached. Server has already created the canonical record;
      // this just keeps the local DB in sync without waiting for a sync round.
      try {
        // ESM default-export interop: a bare require() returns the module
        // namespace ({ default: ... }) — reading upsertMessage off it was
        // undefined, so this whole optimistic write silently no-oped and the
        // reply only appeared after the next (15s-throttled) sync round.
        const dbModule = require('../../services/ChatDatabase');
        const ChatDatabase = dbModule?.default || dbModule;
        const chatMessage = res?.data?.chatMessage;
        if (chatMessage && ChatDatabase?.upsertMessage) {
          const firstMedia = currentStatus?.mediaItems?.[0] || {};
          const canonicalId = String(chatMessage.messageId || chatMessage._id);
          await ChatDatabase.upsertMessage({
            // Key by the UUID messageId (realtime/sync canonical form) — the
            // Mongo _id form used to create a twin row when the echo landed.
            id:               canonicalId,
            serverMessageId:  canonicalId,
            mongoId:          chatMessage._id ? String(chatMessage._id) : null,
            clientMessageId:  chatMessage.clientMessageId || null,
            seq:              (chatMessage.seq != null && !Number.isNaN(Number(chatMessage.seq)))
              ? Number(chatMessage.seq) : null,
            chatId:           chatMessage.chatId,
            // The server response carries the authoritative senderId (us) —
            // the redux auth `user` shape isn't guaranteed to expose _id, and
            // String(undefined) produced "undefined", which made the bubble
            // fail the isMyMessage check and render LEFT (as a received
            // message). senderType pins the side explicitly either way.
            senderId:         String(chatMessage.senderId || user?._id || user?.id || ''),
            senderType:       'self',
            senderName:       user?.fullName || null,
            receiverId:       String(chatMessage.receiverId || userId || currentStatus.ownerId),
            text:             body,
            type:             'text',
            status:           'sent',
            timestamp:        Date.parse(chatMessage.createdAt) || Date.now(),
            createdAt:        chatMessage.createdAt || new Date().toISOString(),
            synced:           true,
            statusRef:        String(currentStatus._id),
            statusPreview:    chatMessage.statusPreview || {
              statusId:        String(currentStatus._id),
              ownerId:         String(currentStatus.ownerId || userId),
              ownerName:       userName || null,
              mediaType:       firstMedia.mediaType || 'text',
              mediaUrl:        firstMedia.mediaUrl || null,
              thumbnailUrl:    firstMedia.thumbnailUrl || firstMedia.mediaUrl || null,
              text:            currentStatus.caption || currentStatus.textContent || null,
              backgroundColor: currentStatus.bgColor || null,
              createdAt:       currentStatus.createdAt || null,
            },
          });
        }
      } catch (e) {
        // Local optimistic write is best-effort — chat will pick it up on sync
      }

      setReplyText('');
      setShowReply(false);
      resume();
    } catch {
      Alert.alert('Error', 'Could not send reply. Please try again.');
    } finally {
      setSending(false);
    }
  }, [replyText, currentStatus, dispatch, resume, user, userId, userName]);

  const onPlaybackStatusUpdate = useCallback((status) => {
    if (status.isLoaded) {
      // Video is ready → release the progress bar (WhatsApp behaviour).
      setMediaLoaded(true);
      if (status.durationMillis && videoDuration === STORY_DURATION) {
        setVideoDuration(Math.min(status.durationMillis, VIDEO_MAX_MS));
      }
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
  // For "My Status" show the current user's real avatar in the header instead
  // of the app logo. The reliable source is the profile slice (same one the
  // Profile screen uses); fall back to whatever the auth slice happens to hold.
  // Run it through toSecureMediaUri so an http URL still loads on iOS (ATS).
  const displayImage = isMine
    ? (toSecureMediaUri(
        profileData?.profileImage
        || profileData?.profileImageThumbnailUrl
        || user?.profileImage
        || user?.profilePicture
        || user?.profilePic
        || user?.avatar
        || user?.image
      ) || null)
    : toSecureMediaUri(userImage);
  const likeActive = reactionData.myReaction === 'like';

  // Does the currently-visible slide play audio? Used to gate the mute icon.
  const currentSlideIsAudible = (() => {
    const t = currentStatus?.mediaItems?.[0]?.mediaType;
    return t === 'video' || t === 'audio';
  })();

  // ── Render content ────────────────────────────────────────────────────────
  // Backend schema:  status.mediaItems[0].mediaType / mediaUrl
  //                  status.textContent  (text statuses)
  //                  status.bgColor      (text background)
  // There is NO top-level `type`, `text`, `backgroundColor`, or `mediaUrl`.
  const renderContent = () => {
    // Resolved from BOTH the nested (own) and top-level (others) shapes above.
    const statusType = currentMediaType;
    const mediaUrl   = toSecureMediaUri(currentMediaUrl);

    switch (statusType) {
      case 'text':
        return (
          <View style={[styles.textContent, { backgroundColor: currentStatus.bgColor || '#026158' }]}>
            <Text style={styles.textBody}>{currentStatus.textContent}</Text>
          </View>
        );
      case 'image': {
        const thumbUrl = toSecureMediaUri(currentThumbUrl);
        return (
          <View style={styles.mediaContent}>
            {/* Blurred low-res placeholder (WhatsApp blur-up) — visible until the
                full-resolution image finishes loading, then it clears sharp. */}
            {!mediaLoaded && thumbUrl ? (
              <Image
                source={{ uri: thumbUrl }}
                style={StyleSheet.absoluteFill}
                resizeMode="contain"
                blurRadius={18}
              />
            ) : null}
            <Image
              source={{ uri: mediaUrl }}
              style={styles.mediaContent}
              resizeMode="contain"
              onLoad={() => setMediaLoaded(true)}
              // Never hang the progress bar forever on a broken URL.
              onError={() => setMediaLoaded(true)}
            />
            {!mediaLoaded ? (
              <View
                style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}
                pointerEvents="none"
              >
                <ActivityIndicator color="#fff" size="large" />
              </View>
            ) : null}
          </View>
        );
      }
      case 'video':
        return (
          <Video
            ref={videoRef}
            source={{ uri: mediaUrl }}
            style={styles.mediaContent}
            resizeMode={ResizeMode.CONTAIN}
            shouldPlay={!paused}
            isLooping={false}
            isMuted={isMuted}
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
        // Pure visual card — the actual tap target is rendered AFTER the
        // touchZones overlay (see openLinkOverlay below) so navigation taps
        // don't swallow the Open Link button.
        return (
          <View style={styles.linkContent}>
            {currentStatus.ogMetadata?.image
              ? <Image source={{ uri: toSecureMediaUri(currentStatus.ogMetadata.image) }} style={styles.linkImage} resizeMode="cover" />
              : null
            }
            <View style={styles.linkBody}>
              <Text style={styles.linkTitle} numberOfLines={2}>
                {currentStatus.ogMetadata?.title || currentStatus.textContent}
              </Text>
              {currentStatus.ogMetadata?.description
                ? <Text style={styles.linkDesc} numberOfLines={3}>{currentStatus.ogMetadata.description}</Text>
                : null
              }
              {currentStatus.ogMetadata?.siteName
                ? <Text style={styles.linkSite} numberOfLines={1}>{currentStatus.ogMetadata.siteName}</Text>
                : null
              }
              <View style={styles.linkUrlRow}>
                <Ionicons name="link-outline" size={12} color="#60a5fa" style={{ marginRight: 4 }} />
                <Text style={styles.linkUrl} numberOfLines={1}>
                  {currentStatus.ogMetadata?.url || currentStatus.textContent}
                </Text>
              </View>
            </View>
          </View>
        );
      }
      default:
        // Fallback: show textContent if present, otherwise loading indicator
        if (currentStatus?.textContent) {
          return (
            <View style={[styles.textContent, { backgroundColor: currentStatus.bgColor || '#026158' }]}>
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

      {/* Open-link CTA — rendered AFTER touchZones so the navigation overlay
          doesn't steal the tap. Only shown for link-type statuses. */}
      {currentStatus.mediaItems?.[0]?.mediaType === 'link' && (() => {
        const linkHref = currentStatus.ogMetadata?.url || currentStatus.textContent;
        if (!linkHref) return null;
        const openLink = () => {
          pause();
          Linking.openURL(linkHref).catch(() => Alert.alert('Cannot open link', linkHref));
        };
        return (
          <View style={styles.openLinkOverlay} pointerEvents="box-none">
            <TouchableOpacity
              style={styles.openLinkBtn}
              activeOpacity={0.85}
              onPress={openLink}
              accessibilityLabel="Open link"
            >
              <Ionicons name="open-outline" size={16} color="#fff" />
              <Text style={styles.openLinkBtnText}>Open Link</Text>
            </TouchableOpacity>
          </View>
        );
      })()}

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
              // Own status — go to the ProfileTab inside the bottom-tab
              // navigator. UserB is the "other user" profile screen and
              // doesn't make sense for the logged-in user.
              navigation.navigate('ChatList', { screen: 'ProfileTab' });
              return;
            }
            if (userId) {
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
            <View style={styles.headerNameRow}>
              <Text style={styles.headerName}>{displayName}</Text>
              {isBroadcast && (
                <View style={styles.headerVerified}>
                  <Ionicons name="checkmark-circle" size={15} color="#03b0a2" />
                </View>
              )}
            </View>
            <Text style={styles.headerTime}>
              {isBroadcast ? 'Official update' : ''}{isBroadcast ? '  ·  ' : ''}{timeAgo(currentStatus.createdAt)}
            </Text>
          </View>
        </TouchableOpacity>

        {/* Mute toggle — only shown when the current slide has audio */}
        {currentSlideIsAudible && (
          <TouchableOpacity
            onPress={() => setIsMuted(m => !m)}
            style={styles.muteBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel={isMuted ? 'Unmute' : 'Mute'}
          >
            <Ionicons
              name={isMuted ? 'volume-mute' : 'volume-high'}
              size={20}
              color="#fff"
            />
          </TouchableOpacity>
        )}

        {/* Options only in header for owner; non-owner gets it in the bottom bar */}
        {isMine && (
          <TouchableOpacity onPress={openOptions} style={styles.moreBtn}>
            <Ionicons name="ellipsis-vertical" size={20} color="#fff" />
          </TouchableOpacity>
        )}
      </View>

      {/* Bottom bar — WhatsApp-style: no dark scrim, no pill tabs */}
      {isMine ? (
        /* ── Owner bottom: single-row Views/Likes summary + delete ── */
        <View style={styles.ownerBar}>
          <TouchableOpacity
            style={styles.ownerSummary}
            activeOpacity={0.7}
            onPress={() => showViewers ? closePanel() : openPanel('views')}
            accessibilityLabel="Open viewers list"
          >
            <View style={styles.ownerStat}>
              <Ionicons name="eye" size={18} color="#fff" />
              <Text style={styles.ownerStatText}>
                {viewers?.viewCount ?? currentStatus.viewCount ?? 0}
              </Text>
            </View>
            <View style={styles.ownerStat}>
              <Ionicons
                name={(likers?.total ?? currentStatus.likeCount ?? 0) > 0 ? 'heart' : 'heart-outline'}
                size={18}
                color={(likers?.total ?? currentStatus.likeCount ?? 0) > 0 ? '#FF3B5C' : '#fff'}
              />
              <Text style={styles.ownerStatText}>
                {likers?.total ?? currentStatus.likeCount ?? 0}
              </Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleDelete}
            style={styles.ownerIconBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel="Delete status"
          >
            <Ionicons name="trash-outline" size={22} color="#fff" />
          </TouchableOpacity>
        </View>
      ) : (
        /* ── Viewer bottom: rounded reply + heart, no background scrim ── */
        <View style={styles.viewerBar}>
          {/* Reply: hidden entirely for official admin broadcasts; for normal
              statuses it respects the per-status allowReplies flag. */}
          {isBroadcast ? (
            <View style={styles.replySpacer} />
          ) : currentStatus?.allowReplies !== false ? (
            <TouchableOpacity
              style={styles.replyInputTrigger}
              activeOpacity={0.85}
              onPress={() => { pause(); setShowReply(true); }}
              accessibilityLabel={`Reply to ${displayName}`}
            >
              <Ionicons name="chevron-up" size={14} color="rgba(255,255,255,0.75)" style={{ marginRight: 6 }} />
              <Text style={styles.replyPlaceholder}>Reply</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.replyInputTrigger}>
              <Text style={styles.replyPlaceholder}>Replies are off</Text>
            </View>
          )}
          {currentStatus?.allowReactions !== false && (
            <TouchableOpacity
              style={styles.reactBtn}
              onPress={() => handleReact('like')}
              accessibilityLabel={likeActive ? 'Unlike' : 'Like'}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Ionicons
                name={likeActive ? 'heart' : 'heart-outline'}
                size={28}
                color={likeActive ? '#FF3B5C' : '#fff'}
              />
            </TouchableOpacity>
          )}
          {/* Options (report / hide) make no sense for an official broadcast,
              so the menu is removed for admin statuses. */}
          {!isBroadcast && (
            <TouchableOpacity
              style={styles.reactBtn}
              onPress={openOptions}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Ionicons name="ellipsis-vertical" size={22} color="#fff" />
            </TouchableOpacity>
          )}
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
                  Viewed · {viewers?.viewCount || 0}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.panelTab, activeTab === 'likes' && styles.panelTabActive]}
                onPress={() => setActiveTab('likes')}
              >
                <Text style={[styles.panelTabText, activeTab === 'likes' && styles.panelTabTextActive]}>
                  Liked · {likers?.total || 0}
                </Text>
              </TouchableOpacity>
            </View>

            {activeTab === 'views' ? (
              (() => {
                // Build a Set of userIds who liked, so even an older backend
                // that doesn't enrich /viewers with reactionType still gets a
                // heart rendered next to viewers who appear in the likers list.
                const likedSet = new Set(
                  (likers?.likedBy || []).map(l => String(l.userId || l._id || ''))
                );
                return (
                  <FlatList
                    data={viewers?.viewers || []}
                    keyExtractor={(item, i) => item?.viewerId?._id || item?.userId?._id || String(i)}
                    renderItem={({ item }) => {
                      const viewer = item.viewerId || item.userId;
                      const viewerIdStr = String(viewer?._id || viewer || '');
                      const liked = item.reactionType === 'like' || likedSet.has(viewerIdStr);
                      // Resolve label using local saved-contacts first, then
                      // server's phone field, then server-supplied name.
                      const serverName = viewer?.fullName || viewer?.userName;
                      const phone      = item.phone || viewer?.phone
                        || (viewer?.mobile?.code && viewer?.mobile?.number
                              ? `${viewer.mobile.code} ${viewer.mobile.number}`
                              : viewer?.mobile?.number);
                      const displayName = resolveContactName(viewerIdStr, serverName, phone);
                      const openProfile = () => {
                        if (!viewerIdStr) return;
                        closePanel();
                        navigation.navigate('UserB', {
                          item: {
                            _id:          viewerIdStr,
                            fullName:     displayName,
                            profileImage: viewer?.profileImage || null,
                          },
                        });
                      };
                      return (
                        <TouchableOpacity
                          style={styles.viewerItem}
                          activeOpacity={0.7}
                          onPress={openProfile}
                          accessibilityLabel={`Open ${displayName}'s profile`}
                        >
                          <Image
                            source={viewer?.profileImage ? { uri: viewer.profileImage } : require('../../../assets/icon.png')}
                            style={styles.viewerAvatar}
                          />
                          <View style={{ flex: 1 }}>
                            <Text style={styles.viewerName}>{displayName}</Text>
                            <Text style={styles.viewerTime}>{timeAgo(item.viewedAt)}</Text>
                          </View>
                          {liked && (
                            <Ionicons name="heart" size={18} color="#FF3B5C" />
                          )}
                        </TouchableOpacity>
                      );
                    }}
                    ListEmptyComponent={<Text style={styles.noViewers}>No views yet</Text>}
                  />
                );
              })()
            ) : (
              <FlatList
                data={likers?.likedBy || []}
                keyExtractor={(item, i) => item?.userId || String(i)}
                renderItem={({ item }) => {
                  const likerIdStr = String(item?.userId || item?._id || '');
                  const phone      = item.phone
                    || (item.mobile?.code && item.mobile?.number
                          ? `${item.mobile.code} ${item.mobile.number}`
                          : item.mobile?.number);
                  const displayName = resolveContactName(likerIdStr, item.name, phone);
                  const openProfile = () => {
                    if (!likerIdStr) return;
                    closePanel();
                    navigation.navigate('UserB', {
                      item: {
                        _id:          likerIdStr,
                        fullName:     displayName,
                        profileImage: item.avatar || null,
                      },
                    });
                  };
                  return (
                    <TouchableOpacity
                      style={styles.viewerItem}
                      activeOpacity={0.7}
                      onPress={openProfile}
                      accessibilityLabel={`Open ${displayName}'s profile`}
                    >
                      <Image
                        source={item.avatar ? { uri: item.avatar } : require('../../../assets/icon.png')}
                        style={styles.viewerAvatar}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.viewerName}>{displayName}</Text>
                        <Text style={styles.viewerTime}>{timeAgo(item.likedAt)}</Text>
                      </View>
                      <Ionicons name="heart" size={18} color="#FF3B5C" />
                    </TouchableOpacity>
                  );
                }}
                ListEmptyComponent={<Text style={styles.noViewers}>No likes yet</Text>}
              />
            )}
          </Animated.View>
        </>
      )}

      {/* Reply modal — WhatsApp-style composer pinned above the keyboard */}
      <Modal visible={showReply} transparent statusBarTranslucent animationType="slide" onRequestClose={() => { setShowReply(false); resume(); }}>
        <View style={styles.replyModal}>
          {/* Tap anywhere on the dim backdrop to dismiss — status stays
              faintly visible behind it like WhatsApp does. */}
          <TouchableOpacity
            style={styles.replyBackdrop}
            activeOpacity={1}
            onPress={() => { setShowReply(false); resume(); }}
          />

          <View
            style={[
              styles.replySheet,
              // Lift above the keyboard when open; otherwise clear the nav bar.
              { marginBottom: kbHeight, paddingBottom: kbHeight > 0 ? 14 : insets.bottom + 14 },
            ]}
          >
            {/* Drag handle hints "swipe to dismiss" */}
            <View style={styles.replyHandle} />

            {/* "Replying to {name}" header strip with the status thumbnail
                so the recipient sees the context of what they're answering. */}
            <View style={styles.replyContext}>
              <View style={styles.replyContextThumb}>
                {currentStatus?.mediaItems?.[0]?.thumbnailUrl || currentStatus?.mediaItems?.[0]?.mediaUrl ? (
                  <Image
                    source={{ uri: toSecureMediaUri(currentStatus.mediaItems[0].thumbnailUrl || currentStatus.mediaItems[0].mediaUrl) }}
                    style={styles.replyContextThumbImg}
                  />
                ) : (
                  <View
                    style={[
                      styles.replyContextThumbImg,
                      styles.replyContextThumbFallback,
                      { backgroundColor: currentStatus?.bgColor || '#026158' },
                    ]}
                  >
                    <Ionicons name="chatbubble-ellipses" size={14} color="#fff" />
                  </View>
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.replyContextLabel}>Replying to</Text>
                <Text style={styles.replyContextName} numberOfLines={1}>{displayName}</Text>
              </View>
              <TouchableOpacity
                onPress={() => { setShowReply(false); resume(); }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="close" size={20} color="rgba(255,255,255,0.7)" />
              </TouchableOpacity>
            </View>

            {/* Composer — emoji + pill input + green circular send (WhatsApp) */}
            <View style={styles.replyRow}>
              <View style={styles.replyInputPill}>
                <Ionicons name="happy-outline" size={22} color="rgba(255,255,255,0.55)" />
                <TextInput
                  style={styles.replyInput}
                  placeholder="Message"
                  placeholderTextColor="rgba(255,255,255,0.45)"
                  value={replyText}
                  onChangeText={setReplyText}
                  autoFocus
                  multiline
                  maxLength={500}
                />
              </View>
              <TouchableOpacity
                style={[
                  styles.replySend,
                  { opacity: replyText.trim() ? 1 : 0.55 },
                ]}
                onPress={handleReply}
                disabled={sending || !replyText.trim()}
                accessibilityLabel="Send reply"
              >
                {sending
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Ionicons name="send" size={18} color="#fff" />
                }
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <ReportBottomSheet
        visible={reportVisible}
        onClose={() => { setReportVisible(false); resume(); }}
        payload={{
          reportType: 'status',
          statusId: currentStatus?._id,
          reportedUserId: currentStatus?.ownerId || userId,
        }}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#111B21' },

  textContent: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 30 },
  textBody:    { fontSize: 24, color: '#fff', textAlign: 'center', fontFamily: 'Roboto-Medium', lineHeight: 34 },
  audioLabel:  { color: '#fff', marginTop: 12, fontSize: 16 },
  mediaContent:{ flex: 1, width: SW },

  captionOverlay: { position: 'absolute', bottom: 80, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.55)', padding: 12 },
  captionText:    { color: '#fff', fontSize: 15, textAlign: 'center' },

  // Tap zones — WhatsApp asymmetric (30 % prev / 70 % next)
  touchZones: { ...StyleSheet.absoluteFillObject, flexDirection: 'row' },
  leftZone:   { width: SW * 0.30 },
  rightZone:  { flex: 1 },

  // ── Progress bars — WhatsApp top edge ────────────────────────────────────
  progressContainer: { position: 'absolute', top: 46, left: 8, right: 8, flexDirection: 'row', gap: 3 },
  progressTrack:     { flex: 1, height: 2.5, backgroundColor: 'rgba(255,255,255,0.35)', borderRadius: 2, overflow: 'hidden' },
  progressFill:      { height: '100%', backgroundColor: '#fff', borderRadius: 2 },

  // ── Header — WhatsApp style: compact, transparent, text-shadow for legibility ──
  header: {
    position: 'absolute', top: 56, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12,
  },
  backBtn:       { padding: 4, marginRight: 6 },
  headerProfile: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  headerAvatar:  { width: 38, height: 38, borderRadius: 19, marginRight: 10 },
  headerText:    { flex: 1 },
  headerNameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  headerVerified: { marginLeft: 1 },
  headerName: {
    color: '#fff', fontSize: 16, fontFamily: 'Roboto-SemiBold',
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3,
  },
  headerTime: {
    color: 'rgba(255,255,255,0.85)', fontSize: 12,
    marginTop: 1,
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3,
  },
  moreBtn:     { padding: 8 },
  muteBtn:     { padding: 8, marginRight: 2 },
  deleteBtn:   { padding: 8 },

  // ── Owner bar — counts pill on the left, delete pill on the right ───────
  ownerBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingTop: 12, paddingBottom: 26,
    gap: 10,
  },
  // Tinted pill behind the views/likes counts so they stay legible on
  // bright media without darkening the whole bottom band.
  ownerSummary: {
    flexDirection: 'row', alignItems: 'center', gap: 18,
    paddingVertical: 10, paddingHorizontal: 12,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 999,
  },
  ownerStat: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
  },
  ownerStatText: {
    color: '#fff', fontSize: 14, fontFamily: 'Roboto-SemiBold',
  },
  // Matching circular pill for the delete affordance — same surface tone
  // so the two controls read as one row visually.
  ownerIconBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },

  // ── Panel tabs (inside slide-up sheet) — small caps + accent underline ───
  panelTabs:        {
    flexDirection: 'row', marginHorizontal: 4, marginBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.12)',
  },
  panelTab:         { flex: 1, paddingVertical: 14, alignItems: 'center' },
  panelTabActive:   { borderBottomWidth: 2, borderBottomColor: '#fff' },
  panelTabText:     {
    color: 'rgba(255,255,255,0.55)', fontSize: 11, fontFamily: 'Roboto-Bold',
    letterSpacing: 1.6, textTransform: 'uppercase',
  },
  panelTabTextActive: { color: '#fff' },

  // ── Viewer bar (non-owner) — WhatsApp style: transparent, rounded reply ──
  viewerBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingTop: 10, paddingBottom: 26,
  },
  reactBtn:          { alignItems: 'center', paddingHorizontal: 6 },
  reactCount:        { color: '#fff', fontSize: 11, marginTop: 2 },
  // WhatsApp's status reply hint: chevron + "Reply" centred in a small pill.
  replyInputTrigger: {
    flex: 1, marginRight: 6, height: 42,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.45)',
    backgroundColor: 'rgba(0,0,0,0.35)',
    flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 18,
  },
  replyPlaceholder: {
    color: 'rgba(255,255,255,0.85)', fontSize: 14, fontFamily: 'Roboto-Medium',
  },
  // Keeps the heart button pinned right when the reply trigger is hidden
  // (official admin broadcasts).
  replySpacer: { flex: 1 },

  // ── Viewers panel — editorial sheet ──────────────────────────────────────
  panelBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'transparent' },
  viewersList:   {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    height: SH * 0.58,
    backgroundColor: '#10171B',
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: 22, paddingBottom: 32,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  viewersHandle:    { alignItems: 'center', paddingVertical: 14 },
  viewersHandleBar: { width: 40, height: 3, backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 2 },
  viewersTitle:     {
    color: '#fff', fontSize: 13, fontFamily: 'Roboto-Bold', marginBottom: 6,
    letterSpacing: 1.6, textTransform: 'uppercase',
  },
  viewerItem:   {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, gap: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  viewerAvatar: { width: 42, height: 42, borderRadius: 21 },
  viewerName:   {
    color: '#fff', fontSize: 15, fontWeight: '500', marginBottom: 2,
    fontFamily: Platform.select({ ios: 'Georgia', android: 'serif', default: 'serif' }),
    letterSpacing: -0.2,
  },
  viewerTime:   {
    color: 'rgba(255,255,255,0.55)', fontSize: 11,
    fontFamily: Platform.select({ ios: 'Georgia', android: 'serif', default: 'serif' }),
    fontStyle: 'italic',
  },
  noViewers:    {
    color: 'rgba(255,255,255,0.45)', textAlign: 'center', paddingVertical: 32,
    fontSize: 13, letterSpacing: 0.3,
  },

  // Link status
  linkContent: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#1a1a2e', padding: 20 },
  linkImage:   { width: SW, height: 220 },
  linkBody:    { padding: 20, width: '100%' },
  linkTitle:   { color: '#fff', fontSize: 18, fontFamily: 'Roboto-Bold', marginBottom: 8 },
  linkDesc:    { color: 'rgba(255,255,255,0.7)', fontSize: 14, marginBottom: 8 },
  linkUrlRow:  { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  linkUrl:     { color: '#60a5fa', fontSize: 12, flex: 1 },
  linkSite:    { color: 'rgba(255,255,255,0.7)', fontSize: 11, fontFamily: 'Roboto-Bold', marginBottom: 2 },
  // Centred floating CTA layered on top of the tap-zones overlay so the
  // navigation taps can't steal it. `pointerEvents: 'box-none'` on the
  // parent lets background taps still go through to the navigation zones.
  openLinkOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 160, // sits above the bottom action bar
  },
  openLinkBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#3b82f6',
    paddingHorizontal: 22, paddingVertical: 12,
    borderRadius: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 6,
  },
  openLinkBtnText: { color: '#fff', fontSize: 14, fontFamily: 'Roboto-Bold' },

  // ── Reply modal — WhatsApp composer ──────────────────────────────────────
  replyModal:    { flex: 1, justifyContent: 'flex-end' },
  // Transparent backdrop — only catches taps to dismiss; the status stays
  // fully visible behind the composer (no dimming).
  replyBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
  },
  // Floating composer sheet pinned to the bottom edge.
  replySheet: {
    backgroundColor: '#0B141A',           // WhatsApp dark chat bg
    borderTopLeftRadius: 18, borderTopRightRadius: 18,
    paddingHorizontal: 12,
    paddingTop: 10,
    // paddingBottom is applied inline (keyboard height vs. nav-bar inset).
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  replyHandle: {
    alignSelf: 'center',
    width: 38, height: 4, borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.22)',
    marginBottom: 12,
  },
  // "Replying to" context row — small thumb + label + close.
  replyContext: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 4, paddingBottom: 10, gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.06)',
    marginBottom: 10,
  },
  replyContextThumb:    { width: 34, height: 34 },
  replyContextThumbImg: { width: 34, height: 34, borderRadius: 6, resizeMode: 'cover' },
  replyContextThumbFallback: { alignItems: 'center', justifyContent: 'center' },
  replyContextLabel:    { color: 'rgba(255,255,255,0.5)', fontSize: 11, marginBottom: 1 },
  replyContextName:     { color: '#fff', fontSize: 14, fontFamily: 'Roboto-SemiBold' },

  // Composer row: pill input + circular send (matches WhatsApp chat).
  replyRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 4 },
  replyInputPill: {
    flex: 1,
    flexDirection: 'row', alignItems: 'flex-end',
    gap: 8,
    backgroundColor: '#1F2C33',
    borderRadius: 24,
    paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 10 : 6,
    minHeight: 44,
    maxHeight: 130,
  },
  replyInput: {
    flex: 1,
    color: '#fff', fontSize: 15, lineHeight: 20,
    paddingVertical: Platform.OS === 'ios' ? 0 : 4,
    maxHeight: 110,
  },
  replySend: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: '#03b0a2', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#03b0a2', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.35, shadowRadius: 6,
    elevation: 4,
  },
});
