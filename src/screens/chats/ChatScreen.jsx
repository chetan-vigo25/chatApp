import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Pressable,
  Animated,
  Image,
  TextInput,
  ScrollView,
  Platform,
  ActivityIndicator,
  RefreshControl,
  Modal,
  Alert,
  Keyboard,
  Dimensions,
  StatusBar,
  Linking,
  LayoutAnimation,
  UIManager,
  PanResponder,
  useWindowDimensions,
  StyleSheet
} from "react-native";
import moment from "moment";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as Location from "expo-location";
import * as Contacts from "expo-contacts";
import { useTheme } from "../../contexts/ThemeContext";
import { useNetwork } from "../../contexts/NetworkContext";
import { FontAwesome6, AntDesign, Ionicons, MaterialIcons, Entypo } from "@expo/vector-icons";
import useChatLogic from "../../contexts/useChatLogic";
import ChatHeaderPresence from "../../presence/components/ChatHeaderPresence";
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import * as IntentLauncher from 'expo-intent-launcher';
import { Video, ResizeMode, Audio } from 'expo-av';
import { ImageZoom } from '@likashefqet/react-native-image-zoom';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { MEDIA_DOWNLOAD_STATUS } from '../../services/MediaDownloadManager';
import localStorageService from '../../services/LocalStorageService';
import { mediaDownloadSigned } from '../../utils/mediaService';
import ReportBottomSheet from '../../components/ReportBottomSheet';
import MentionSuggestions, { useMentions } from '../../components/MentionInput';
import MentionText from '../../components/MentionText';
import ReplyPreviewBox from '../../components/ReplyPreviewBox';
import ScheduleTimePicker from '../../components/ScheduleTimePicker';
import ReplyBubble from '../../components/ReplyBubble';
import LocationBubble from '../../components/LocationBubble';
import ReactionPicker from '../../components/ReactionPicker';
import ReactionBar from '../../components/ReactionBar';
import ReactionDetailSheet from '../../components/ReactionDetailSheet';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const MAX_MEDIA_BUBBLE_WIDTH = Math.floor(SCREEN_WIDTH * 0.68);
const MIN_MEDIA_BUBBLE_WIDTH = 120;
const MAX_MEDIA_BUBBLE_HEIGHT = 280;
const MIN_MEDIA_BUBBLE_HEIGHT = 96;
const LARGE_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const RICH_TEXT_CHAR_LIMIT = 520;
const RICH_TEXT_COLLAPSED_LINES = 30;
const RICH_PARSE_CACHE_LIMIT = 500;
const MEDIA_PANEL_SHEET_HEIGHT = 360;
const AUDIO_RECORDING_MAX_MS = 120000;

const MEDIA_PANEL_OPTIONS = [
  { key: 'gallery', label: 'Photo', icon: 'images', iconFamily: 'Ionicons', color: '#0EA5FF' },
  { key: 'camera', label: 'Camera', icon: 'camera', iconFamily: 'Ionicons', color: '#F43F5E' },
  { key: 'video', label: 'Video', icon: 'videocam', iconFamily: 'Ionicons', color: '#22C55E' },
  { key: 'document', label: 'Document', icon: 'document-text', iconFamily: 'Ionicons', color: '#8B5CF6' },
  { key: 'audio', label: 'Audio', icon: 'headset', iconFamily: 'Ionicons', color: '#F97316' },
  { key: 'contact', label: 'Contact', icon: 'person', iconFamily: 'Ionicons', color: '#06B6D4' },
  { key: 'location', label: 'Location', icon: 'location', iconFamily: 'Ionicons', color: '#10B981' },
];

const CHAT_WALLPAPER_TEXTURE = require('../../../assets/images/chat-background.jpg');

const ChatWallpaperLayer = React.memo(function ChatWallpaperLayer({ isDarkMode }) {
  return (
    <View pointerEvents="none" style={wpStyles.container}>
      <Image
        source={CHAT_WALLPAPER_TEXTURE}
        resizeMode="cover"
        style={wpStyles.image}
      />
      <View style={[wpStyles.overlay, {
        backgroundColor: isDarkMode ? 'rgba(0,0,0,0.45)' : 'rgba(192, 192, 192, 0.15)',
      }]} />
    </View>
  );
});

const wpStyles = StyleSheet.create({
  container: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: '#0B141A' },
  image: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, width: '100%', height: '100%' },
  overlay: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
});

const EMOJI_SECTIONS = {
  smileys: ['😀', '😄', '😁', '😂', '😊', '😍', '😘', '😎', '🤩', '🥰', '😇', '🤗', '🙂', '🙃', '😉', '🤔', '😴', '😭', '😤', '🥲'],
  animals: ['🐶', '🐱', '🐼', '🦁', '🐯', '🐮', '🐸', '🐵', '🐨', '🐰', '🦊', '🐧', '🐦', '🦄', '🐙', '🦋', '🐢', '🐬', '🦜', '🐘'],
  food: ['🍎', '🍇', '🍉', '🍌', '🍕', '🍔', '🍟', '🌮', '🍣', '🍩', '🍪', '🍫', '🍿', '🥗', '🍜', '🍛', '🍦', '🍓', '🥑', '☕'],
  activities: ['⚽', '🏀', '🏏', '🏸', '🎮', '🎯', '🎸', '🎹', '🎬', '📸', '✈️', '🏖️', '🚴', '🏃', '🧘', '🎉', '🎁', '🏆', '🎲', '🧩'],
};

const ChatInputBar = React.memo(React.forwardRef(function ChatInputBar({
  theme,
  isDarkMode,
  chatColor,
  text,
  pendingMedia,
  inputHeight,
  isInputFocused,
  isSearching,
  showEmojiPanel,
  onTextChange,
  onInputContentSizeChange,
  onSelectionChange,
  onFocus,
  onBlur,
  onOpenEmoji,
  onOpenAttachment,
  onRemovePendingMedia,
  onSubmit,
  onSchedule,
  mentionSuggestionsNode,
}, ref) {
  const hasContent = Boolean(text.trim() || pendingMedia);
  const showAttachment = !hasContent;
  const [showSchedulePicker, setShowSchedulePicker] = useState(false);
  const iconColor = isDarkMode ? 'rgba(212,229,240,0.68)': '#111111';
  const inputTextColor = isDarkMode ? '#F2F8FC' : '#111111';
  const pendingTextColor = isDarkMode ? '#E8F2F8' : '#111111';
  const placeholderColor = isDarkMode ? 'rgba(212,229,240,0.68)' : 'rgba(17,17,17,0.58)';

  const sendAnim = useRef(new Animated.Value(hasContent ? 1 : 0)).current;
  const attachAnim = useRef(new Animated.Value(showAttachment ? 1 : 0)).current;
  const inputAnimHeight = useRef(new Animated.Value(Math.max(36, inputHeight || 36))).current;
  const submitScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.timing(sendAnim, {
      toValue: hasContent ? 1 : 0,
      duration: 170,
      useNativeDriver: true,
    }).start();
  }, [sendAnim, hasContent]);

  useEffect(() => {
    Animated.timing(attachAnim, {
      toValue: showAttachment ? 1 : 0,
      duration: 180,
      useNativeDriver: false,
    }).start();
  }, [attachAnim, showAttachment]);

  useEffect(() => {
    Animated.timing(inputAnimHeight, {
      toValue: Math.max(36, Number(inputHeight || 36)),
      duration: 180,
      useNativeDriver: false,
    }).start();
  }, [inputAnimHeight, inputHeight]);

  const handlePressInSubmit = () => {
    Animated.timing(submitScale, {
      toValue: 0.94,
      duration: 120,
      useNativeDriver: true,
    }).start();
  };

  const handlePressOutSubmit = () => {
    Animated.timing(submitScale, {
      toValue: 1,
      duration: 120,
      useNativeDriver: true,
    }).start();
  };

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingHorizontal: 10,
        paddingTop: 6,
        paddingBottom: Platform.OS === 'ios' ? 10 : 8,
        backgroundColor: theme.colors.cardBackground,
        // borderTopWidth: 1,
        borderTopColor: theme.colors.borderColor,
        overflow: 'visible',
        borderWidth: 0,
        zIndex: 10,
      }}
    >
      {mentionSuggestionsNode}
      <Animated.View
        style={{
          flex: 1,
          minHeight: 52,
          borderRadius: 26,
          paddingHorizontal: 8,
          paddingVertical: 2,
          backgroundColor: theme.colors.menuBackground,
          borderWidth: 0.5,
          borderColor: isInputFocused ? theme.colors.themeColor : theme.colors.borderColor,
          justifyContent: 'center',
          overflow: 'hidden',
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.2,
          shadowRadius: 4,
        }}
      >

        <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
          <TouchableOpacity
            onPress={onOpenEmoji}
            accessibilityRole="button"
            accessibilityLabel={showEmojiPanel ? "Open keyboard" : "Open emoji panel"}
            activeOpacity={0.75}
            style={{
              width: 42,
              height: 42,
              borderRadius: 21,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Entypo name={showEmojiPanel ? "keyboard" : "emoji-happy"} size={22} color={iconColor} />
          </TouchableOpacity>

          <Animated.View
            style={{
              flex: 1,
              minHeight: 34,
              maxHeight: 104,
              height: inputAnimHeight,
              justifyContent: 'center',
              paddingLeft: 2,
              paddingRight: 2,
            }}
          >
            {pendingMedia ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Image source={{ uri: pendingMedia.file.uri }} style={{ width: 34, height: 34, borderRadius: 8 }} />
                <Text style={{ color: pendingTextColor, flex: 1, fontSize: 13 }} numberOfLines={2}>
                  {pendingMedia.file.name || 'Media ready to send'}
                </Text>
                <TouchableOpacity
                  onPress={onRemovePendingMedia}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel="Remove selected media"
                >
                  <Ionicons name="close-circle" size={20} color={iconColor} />
                </TouchableOpacity>
              </View>
            ) : (
              <TextInput
                ref={ref}
                placeholder="Message"
                value={text}
                onChangeText={onTextChange}
                multiline
                onContentSizeChange={onInputContentSizeChange}
                onSelectionChange={onSelectionChange}
                onFocus={onFocus}
                onBlur={onBlur}
                placeholderTextColor={placeholderColor}
                editable={!isSearching}
                scrollEnabled={Number(inputHeight || 0) >= 108}
                accessibilityLabel="Message input"
                style={{
                  flex: 1,
                  fontSize: 15,
                  color: inputTextColor,
                  fontFamily: 'Roboto-Regular',
                  minHeight: 32,
                  maxHeight: 96,
                  paddingTop: Platform.OS === 'ios' ? 5 : 2,
                  paddingBottom: Platform.OS === 'ios' ? 5 : 2,
                }}
              />
            )}
          </Animated.View>

          <Animated.View
            style={{
              width: attachAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 40] }),
              opacity: attachAnim,
              transform: [
                {
                  translateX: attachAnim.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }),
                },
              ],
              overflow: 'hidden',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 2,
            }}
          >
            <TouchableOpacity
              onPress={onOpenAttachment}
              accessibilityRole="button"
              accessibilityLabel="Open attachment menu"
              activeOpacity={0.75}
              style={{
                width: 40,
                height: 40,
                borderRadius: 20,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name="attach" size={25} color={iconColor} />
            </TouchableOpacity>
          </Animated.View>
        </View>
      </Animated.View>

      <Animated.View style={{ marginLeft: 8, transform: [{ scale: submitScale }] }}>
        <TouchableOpacity
          onPress={onSubmit}
          onLongPress={hasContent ? () => setShowSchedulePicker(true) : undefined}
          delayLongPress={400}
          onPressIn={handlePressInSubmit}
          onPressOut={handlePressOutSubmit}
          disabled={isSearching}
          accessibilityRole="button"
          accessibilityLabel={hasContent ? 'Send message (long press to schedule)' : 'Voice message'}
          activeOpacity={0.85}
          style={{
            width: 52,
            height: 52,
            borderRadius: 26,
            backgroundColor: ((!text.trim() && !pendingMedia) || isSearching)
              ? (chatColor ||  'rgba(37, 160, 235, 0.74)' )
              : (chatColor || '#1DA1F2'),
            alignItems: 'center',
            justifyContent: 'center',
            opacity: 1,
            borderWidth: 2,
            borderColor: 'rgba(0,0,0,0.18)',
            shadowColor: '#0B4667',
            shadowOffset: { width: 0, height: 3 },
            shadowOpacity: 0.3,
            shadowRadius: 6,
            elevation: 7,
          }}
        >
          <Animated.View
            style={{
              position: 'absolute',
              opacity: sendAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
              transform: [{ scale: sendAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.9] }) }],
            }}
          >
            <Ionicons name="mic" size={24} color="#F7FEFF" />
          </Animated.View>

          <Animated.View
            style={{
              position: 'absolute',
              opacity: sendAnim,
              transform: [{ scale: sendAnim }],
            }}
          >
            <Ionicons name="send" size={21} color="#FFFFFF" />
          </Animated.View>
        </TouchableOpacity>
      </Animated.View>

      {/* Schedule Time Picker */}
      <ScheduleTimePicker
        visible={showSchedulePicker}
        onClose={() => setShowSchedulePicker(false)}
        onSchedule={(isoTime) => {
          setShowSchedulePicker(false);
          if (onSchedule) onSchedule(isoTime);
        }}
        theme={theme}
      />
    </View>
  );
}));

// ── Swipe-to-reply wrapper (proper component so hooks work) ──
const SWIPE_THRESHOLD = 60;
const SwipeReplyRow = React.memo(function SwipeReplyRow({ isMyMessage, disabled, onReply, children }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, gs) => {
      if (disabled) return false;
      const isHorizontal = Math.abs(gs.dx) > Math.abs(gs.dy) && Math.abs(gs.dx) > 10;
      if (!isHorizontal) return false;
      return isMyMessage ? gs.dx < -10 : gs.dx > 10;
    },
    onPanResponderMove: (_, gs) => {
      const dx = isMyMessage
        ? Math.min(0, Math.max(gs.dx, -SWIPE_THRESHOLD - 20))
        : Math.max(0, Math.min(gs.dx, SWIPE_THRESHOLD + 20));
      translateX.setValue(dx);
    },
    onPanResponderRelease: (_, gs) => {
      const triggered = isMyMessage ? gs.dx < -SWIPE_THRESHOLD : gs.dx > SWIPE_THRESHOLD;
      if (triggered && onReply) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        onReply();
      }
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true, friction: 8 }).start();
    },
    onPanResponderTerminate: () => {
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true, friction: 8 }).start();
    },
  })).current;

  return (
    <Animated.View {...panResponder.panHandlers} style={{ transform: [{ translateX }] }}>
      {children}
    </Animated.View>
  );
});

// ── Smooth seekable audio progress bar ──
const AudioSeekBar = React.memo(function AudioSeekBar({
  isThisPlaying, isDownloading, totalMs, seekRatio, progress,
  trackBg, trackFill, subColor, posLabel, durLabel, dlStatus, onSeek,
}) {
  const trackWidthRef = useRef(0);
  const canSeekRef = useRef(false);
  const onSeekRef = useRef(onSeek);
  const totalMsRef = useRef(totalMs);
  const isDraggingRef = useRef(false);
  const dragRatioRef = useRef(0);

  // fillAnim  → drives fill bar width (JS driver only, layout prop)
  // thumbScale → drives thumb grow/shrink (native driver only, transform)
  // thumbPx    → plain state for thumb left position (avoids mixing drivers)
  const fillAnim = useRef(new Animated.Value(0)).current;
  const thumbScale = useRef(new Animated.Value(1)).current;
  const [thumbPx, setThumbPx] = useState(0);
  const [dragLabel, setDragLabel] = useState(null);

  const canSeek = isThisPlaying && totalMs > 0;
  canSeekRef.current = canSeek;
  onSeekRef.current = onSeek;
  totalMsRef.current = totalMs;

  // Sync fill to playback position when not dragging
  useEffect(() => {
    if (isDraggingRef.current) return;
    const w = trackWidthRef.current;
    if (w > 0) {
      const px = seekRatio * w;
      fillAnim.setValue(px);
      setThumbPx(px);
    }
  }, [seekRatio, fillAnim]);

  const clampPx = (px) => Math.min(Math.max(px, 0), trackWidthRef.current || 1);

  const formatMsLabel = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const setPosition = (px) => {
    fillAnim.setValue(px);
    setThumbPx(px);
    dragRatioRef.current = px / (trackWidthRef.current || 1);
    setDragLabel(formatMsLabel(dragRatioRef.current * totalMsRef.current));
  };

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => canSeekRef.current,
    onMoveShouldSetPanResponder: (_, gs) => canSeekRef.current && Math.abs(gs.dx) > 1,
    onPanResponderGrant: (evt) => {
      if (!canSeekRef.current) return;
      isDraggingRef.current = true;
      setPosition(clampPx(evt.nativeEvent.locationX));
      Animated.spring(thumbScale, { toValue: 1.4, useNativeDriver: true, friction: 8, tension: 200 }).start();
    },
    onPanResponderMove: (evt) => {
      if (!isDraggingRef.current) return;
      setPosition(clampPx(evt.nativeEvent.locationX));
    },
    onPanResponderRelease: () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      Animated.spring(thumbScale, { toValue: 1, useNativeDriver: true, friction: 8, tension: 200 }).start();
      setDragLabel(null);
      onSeekRef.current?.(dragRatioRef.current);
    },
    onPanResponderTerminate: () => {
      isDraggingRef.current = false;
      Animated.spring(thumbScale, { toValue: 1, useNativeDriver: true, friction: 8, tension: 200 }).start();
      setDragLabel(null);
    },
  }), [fillAnim, thumbScale]);

  // Tap-to-seek
  const handleTapSeek = useCallback((evt) => {
    if (!canSeekRef.current || isDraggingRef.current) return;
    const px = clampPx(evt.nativeEvent.locationX);
    const ratio = px / (trackWidthRef.current || 1);
    Animated.timing(fillAnim, { toValue: px, duration: 100, useNativeDriver: false }).start();
    setThumbPx(px);
    onSeekRef.current?.(ratio);
  }, [fillAnim]);

  const showThumb = canSeek || (isThisPlaying && seekRatio > 0);
  const shownPosLabel = dragLabel !== null ? dragLabel : posLabel;

  return (
    <View style={{ flex: 1, marginLeft: 10 }}>
      <View
        onLayout={(e) => {
          const newW = e.nativeEvent.layout.width;
          trackWidthRef.current = newW;
          if (!isDraggingRef.current) {
            const px = seekRatio * newW;
            fillAnim.setValue(px);
            setThumbPx(px);
          }
        }}
        {...panResponder.panHandlers}
        onTouchEnd={handleTapSeek}
        style={{ height: 28, justifyContent: 'center' }}
      >
        {/* Track bg */}
        <View style={{ height: 3.5, borderRadius: 3, backgroundColor: trackBg, overflow: 'hidden' }}>
          {isDownloading ? (
            <View style={{
              width: `${Math.round(Math.max(6, progress * 100))}%`,
              height: 3.5, borderRadius: 3, backgroundColor: trackFill,
            }} />
          ) : (
            <Animated.View style={{
              width: fillAnim,
              maxWidth: '100%',
              height: 3.5, borderRadius: 3, backgroundColor: trackFill,
            }} />
          )}
        </View>

        {/* Thumb — plain View for position, Animated.View only for native scale */}
        {showThumb && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: thumbPx - 6,
              top: 8,
              width: 12,
              height: 12,
            }}
          >
            <Animated.View
              style={{
                width: 12,
                height: 12,
                borderRadius: 6,
                backgroundColor: trackFill,
                transform: [{ scale: thumbScale }],
                elevation: 2,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: 0.18,
                shadowRadius: 1.5,
              }}
            />
          </View>
        )}
      </View>

      {/* Time labels */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: subColor, fontSize: 10, fontFamily: 'Roboto-Regular' }}>
          {isDownloading
            ? `${Math.round(progress * 100)}%`
            : dlStatus === MEDIA_DOWNLOAD_STATUS.FAILED
              ? 'Failed'
              : shownPosLabel}
        </Text>
        <Text style={{ color: subColor, fontSize: 10, fontFamily: 'Roboto-Regular' }}>
          {isDownloading ? 'downloading...' : durLabel}
        </Text>
      </View>
    </View>
  );
});

const ContactDetailSheet = React.memo(function ContactDetailSheet({ data, theme, isDarkMode, onClose, onMessageContact }) {
  if (!data) return null;

  const {
    fullName = 'Contact',
    contactName,
    profileImage = '',
    avatar = '',
    countryCode = '',
    mobileNumber = '',
    phoneNumber,
    isRegistered = false,
    userId = null,
  } = data;

  const name = fullName || contactName || 'Contact';
  const image = profileImage || avatar || '';
  const phone = mobileNumber || phoneNumber || '';
  const displayPhone = countryCode ? `${countryCode} ${phone}` : phone;
  const fullPhone = countryCode ? `${countryCode}${phone}` : phone;

  const bgColor = isDarkMode ? '#0f1b27' : '#f5f5f5';
  const cardBg = isDarkMode ? '#1a2b3c' : '#fff';
  const textColor = isDarkMode ? '#EDF6FC' : '#111';
  const subColor = isDarkMode ? 'rgba(200,216,228,0.6)' : '#666';
  const accentColor = theme.colors.themeColor || '#1DA1F2';
  const borderColor = isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

  const saveContactToDevice = () => {
    Alert.alert(
      'Save Contact',
      `Do you want to save ${name} to your contacts?`,
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'OK',
          onPress: async () => {
            try {
              let perm = await Contacts.getPermissionsAsync();
              if (perm.status !== 'granted') {
                perm = await Contacts.requestPermissionsAsync();
                if (perm.status !== 'granted') return;
              }
              await Contacts.addContactAsync({
                firstName: name,
                phoneNumbers: [{ label: 'mobile', number: fullPhone }],
              });
              Alert.alert('Saved', `${name} has been saved to your contacts.`);
            } catch (error) {
              console.error('save contact error', error);
              Alert.alert('Error', 'Unable to save contact.');
            }
          },
        },
      ],
      { cancelable: true }
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      {/* Header */}
      <View style={{ backgroundColor: cardBg, paddingTop: Platform.OS === 'ios' ? 65 : 60, paddingBottom: 20, alignItems: 'center', borderBottomWidth: 0.5, borderBottomColor: borderColor }}>
        <Pressable onPress={onClose} style={{ position: 'absolute', top: Platform.OS === 'ios' ? 60 : 50, left: 16 }}>
          <Ionicons name="arrow-back" size={24} color={accentColor} />
        </Pressable>

        {image ? (
          <Image source={{ uri: image }} style={{ width: 80, height: 80, borderRadius: 40 }} />
        ) : (
          <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: accentColor + '20', alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="person" size={40} color={accentColor} />
          </View>
        )}
        <Text style={{ fontSize: 20, color: textColor, fontFamily: 'Roboto-SemiBold', marginTop: 12 }}>{name}</Text>
        {isRegistered && (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#25D366', marginRight: 6 }} />
            <Text style={{ fontSize: 13, color: '#25D366', fontFamily: 'Roboto-Medium' }}>On VibeConnect</Text>
          </View>
        )}

        {/* Action buttons row */}
        <View style={{ flexDirection: 'row', marginTop: 18, gap: 24 }}>
          <Pressable
            onPress={() => Linking.openURL(`tel:${fullPhone}`).catch(() => {})}
            style={{ alignItems: 'center' }}
          >
            <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: '#22C55E20', alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="call" size={20} color="#22C55E" />
            </View>
            <Text style={{ fontSize: 11, color: subColor, fontFamily: 'Roboto-Medium', marginTop: 4 }}>Call</Text>
          </Pressable>
          {isRegistered && userId ? (
            <Pressable
              onPress={() => { onClose(); onMessageContact?.(userId, name, image); }}
              style={{ alignItems: 'center' }}
            >
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: accentColor + '20', alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="chatbubble" size={20} color={accentColor} />
              </View>
              <Text style={{ fontSize: 11, color: subColor, fontFamily: 'Roboto-Medium', marginTop: 4 }}>Message</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => Linking.openURL(`sms:${fullPhone}`).catch(() => {})}
              style={{ alignItems: 'center' }}
            >
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: accentColor + '20', alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="chatbubble" size={20} color={accentColor} />
              </View>
              <Text style={{ fontSize: 11, color: subColor, fontFamily: 'Roboto-Medium', marginTop: 4 }}>SMS</Text>
            </Pressable>
          )}
          <Pressable
            onPress={saveContactToDevice}
            style={{ alignItems: 'center' }}
          >
            <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: '#8B5CF620', alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="person-add" size={20} color="#8B5CF6" />
            </View>
            <Text style={{ fontSize: 11, color: subColor, fontFamily: 'Roboto-Medium', marginTop: 4 }}>Save</Text>
          </Pressable>
        </View>
      </View>

      {/* Phone number detail */}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ backgroundColor: cardBg, marginTop: 12, borderTopWidth: 0.5, borderTopColor: borderColor }}>
          <Pressable
            onPress={() => Linking.openURL(`tel:${fullPhone}`).catch(() => {})}
            style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 16, borderBottomWidth: 0.5, borderBottomColor: borderColor }}
          >
            <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: accentColor + '15', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
              <Ionicons name="call-outline" size={18} color={accentColor} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 10, color: subColor, fontFamily: 'Roboto-Regular', textTransform: 'uppercase', letterSpacing: 0.5 }}>Mobile</Text>
              <Text style={{ fontSize: 14, color: textColor, fontFamily: 'Roboto-Medium', marginTop: 1 }} selectable>{displayPhone}</Text>
            </View>
            <Ionicons name="call" size={20} color={accentColor} style={{ marginLeft: 8 }} />
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
});

export default function ChatScreen({ navigation, route }) {
  // Reporting state
  const [reportModalVisible, setReportModalVisible] = useState(false);
  const [reportPayload, setReportPayload] = useState({});
  const [reportAnalytics, setReportAnalytics] = useState({
    report_opened: () => {/* analytics event */},
    report_submitted: () => {/* analytics event */},
    report_failed: () => {/* analytics event */},
  });

  // Open report modal for message
  const handleReportMessage = useCallback((msg) => {
    setReportPayload({
      reportType: 'message',
      chatId: chatData.chatId || chatData?._id || route?.params?.chatId,
      messageId: msg.id || msg.serverMessageId || msg.tempId,
      reportedUserId: msg.senderId,
    });
    setReportModalVisible(true);
  }, [chatData, route]);

  // Open report modal for chat
  const handleReportChat = useCallback(() => {
    setReportPayload({
      reportType: 'chat',
      chatId: chatData.chatId || chatData?._id || route?.params?.chatId,
      reportedUserId: chatData.peerUser?._id || chatData.peerUser?.userId,
    });
    setReportModalVisible(true);
  }, [chatData, route]);

  // Add report chat option to menu
  const handleMenuReportChat = () => {
    setShowMenu(false);
    handleReportChat();
  };

  const { theme, chatColor, isDarkMode } = useTheme();
  const { isConnected, networkType } = useNetwork();
  const { width: windowWidth } = useWindowDimensions();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const keyboardAnim = useRef(new Animated.Value(0)).current;
  const [isAtTop, setIsAtTop] = useState(false);
  const [isAtLatest, setIsAtLatest] = useState(true);
  const [showSearchBar, setShowSearchBar] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [newMessagesCount, setNewMessagesCount] = useState(0);
  const [inputHeight, setInputHeight] = useState(34);
  const [showEmojiPanel, setShowEmojiPanel] = useState(false);
  const [activeEmojiSection, setActiveEmojiSection] = useState('recent');
  const [recentEmojis, setRecentEmojis] = useState(['😀', '😂', '❤️', '👍', '🔥', '🙏']);
  const [expandedRichMessages, setExpandedRichMessages] = useState({});
  const [richMessageLineCounts, setRichMessageLineCounts] = useState({});
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [recordingDurationMs, setRecordingDurationMs] = useState(0);
  const audioRecordingRef = useRef(null);
  const audioDurationIntervalRef = useRef(null);
  const recPulseAnim = useRef(new Animated.Value(1)).current;
  const recSlideAnim = useRef(new Animated.Value(0)).current;
  const recBarAnim = useRef(new Animated.Value(0)).current;
  const recWaveAnims = useRef(Array.from({ length: 28 }, () => new Animated.Value(0.3))).current;
  const [playingAudioId, setPlayingAudioId] = useState(null);
  const [audioPlaybackStatus, setAudioPlaybackStatus] = useState({});
  const audioSoundRef = useRef(null);
  const previousTopMessageRef = useRef(null);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [contactViewer, setContactViewer] = useState({ visible: false, data: null });
  const videoRefs = useRef({});
  const mediaAnimRef = useRef({});
  const chatInputRef = useRef(null);
  const emojiPanelAnim = useRef(new Animated.Value(0)).current;
  const richParseCacheRef = useRef(new Map());
  const [visibleMessageKeys, setVisibleMessageKeys] = useState({});
  const thumbnailCacheRef = useRef({});
  const thumbnailLoadInFlightRef = useRef(new Set());
  const [, setThumbnailCacheVersion] = useState(0);
  const lastScrollStateRef = useRef({ isAtLatest: true, isAtTop: false, showScrollButton: false });
  const visibleMapRef = useRef({});
  const [stickyDateLabel, setStickyDateLabel] = useState('');
  const [pendingVisibleReadIds, setPendingVisibleReadIds] = useState([]);
  const pendingVisibleReadSignatureRef = useRef('');
  const stickyDateOpacity = useRef(new Animated.Value(0)).current;
  const stickyDateScale = useRef(new Animated.Value(0.96)).current;
  const stickyDateHideTimerRef = useRef(null);
  const isUserScrollingRef = useRef(false);
  const topVisibleIndexRef = useRef(-1);
  const scrollBtnAnim = useRef(new Animated.Value(0)).current;
  const mediaBackdropAnim = useRef(new Animated.Value(0)).current;
  const mediaSheetAnim = useRef(new Animated.Value(MEDIA_PANEL_SHEET_HEIGHT)).current;
  const mediaOptionEntryAnims = useRef(MEDIA_PANEL_OPTIONS.map(() => new Animated.Value(0))).current;
  const mediaOptionPressAnims = useRef(
    MEDIA_PANEL_OPTIONS.reduce((acc, item) => {
      acc[item.key] = new Animated.Value(1);
      return acc;
    }, {})
  ).current;

  const mediaOptionsColumns = windowWidth >= 640 ? 4 : 3;
  const mediaPanelWidth = Math.min(windowWidth - 20, 560);
  
  const viewabilityConfig = useRef({ 
    itemVisiblePercentThreshold: 12,
    minimumViewTime: 80
  }).current;

  useEffect(() => {
    const resolved = Image.resolveAssetSource(CHAT_WALLPAPER_TEXTURE);
    if (resolved?.uri) {
      Image.prefetch(resolved.uri).catch(() => {});
    }
  }, []);

  const getMessageDateKey = useCallback((msg) => {
    const rawTs = msg?.timestamp || msg?.createdAt || msg?.updatedAt || msg?.date || null;
    const parsed = moment(rawTs);
    if (parsed.isValid()) return parsed.format('YYYY-MM-DD');
    if (typeof rawTs === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawTs)) return rawTs;
    return moment().format('YYYY-MM-DD');
  }, []);

  const getDateLabel = useCallback((dateKey) => {
    const today = moment().format('YYYY-MM-DD');
    const yesterday = moment().subtract(1, 'days').format('YYYY-MM-DD');
    if (dateKey === today) return 'TODAY';
    if (dateKey === yesterday) return 'YESTERDAY';
    return moment(dateKey).format('D MMMM YYYY').toUpperCase();
  }, []);

  const getFloatingDateLabel = useCallback((dateKey) => {
    const targetDate = moment(dateKey, 'YYYY-MM-DD', true);
    if (!targetDate.isValid()) return '';

    const today = moment().startOf('day');
    if (targetDate.isSame(today, 'day')) return 'Today';
    if (targetDate.isSame(moment(today).subtract(1, 'day'), 'day')) return 'Yesterday';
    return targetDate.format('D MMMM YYYY');
  }, []);

  const clearStickyDateHideTimer = useCallback(() => {
    if (stickyDateHideTimerRef.current) {
      clearTimeout(stickyDateHideTimerRef.current);
      stickyDateHideTimerRef.current = null;
    }
  }, []);

  const showStickyDateBadge = useCallback(() => {
    clearStickyDateHideTimer();
    Animated.parallel([
      Animated.timing(stickyDateOpacity, {
        toValue: 1,
        duration: 120,
        useNativeDriver: true,
      }),
      Animated.spring(stickyDateScale, {
        toValue: 1,
        damping: 20,
        stiffness: 280,
        mass: 0.7,
        useNativeDriver: true,
      }),
    ]).start();
  }, [clearStickyDateHideTimer, stickyDateOpacity, stickyDateScale]);

  const hideStickyDateBadge = useCallback((delayMs = 950) => {
    clearStickyDateHideTimer();
    stickyDateHideTimerRef.current = setTimeout(() => {
      Animated.parallel([
        Animated.timing(stickyDateOpacity, {
          toValue: 0,
          duration: 190,
          useNativeDriver: true,
        }),
        Animated.timing(stickyDateScale, {
          toValue: 0.96,
          duration: 190,
          useNativeDriver: true,
        }),
      ]).start();
    }, delayMs);
  }, [clearStickyDateHideTimer, stickyDateOpacity, stickyDateScale]);

  // Normalization functions
  const normalizeId = (value) => {
    if (value == null) return null;
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (typeof value === "object") {
      const candidate = value._id || value.id || value.userId || value.$oid || null;
      return candidate == null ? null : String(candidate);
    }
    return null;
  };

  const sameId = (a, b) => {
    const left = normalizeId(a);
    const right = normalizeId(b);
    return Boolean(left && right && left === right);
  };

  const getMessageKey = (msg, index) => {
    const key = normalizeId(msg?.serverMessageId) ||
      normalizeId(msg?.id) ||
      normalizeId(msg?.tempId) ||
      normalizeId(msg?.mediaId) ||
      `${normalizeId(msg?.senderId) || "unknown"}_${Number(msg?.timestamp || 0)}`;
    return key || `msg_${index || 0}`;
  };

  const getMediaKeyCandidates = (msg) => {
    const set = new Set([
      normalizeId(msg?.mediaId),
      normalizeId(msg?.serverMessageId),
      normalizeId(msg?.id),
      normalizeId(msg?.tempId),
      getMessageKey(msg),
    ].filter(Boolean));
    return Array.from(set);
  };

  const normalizeDownloadStatus = (value) => String(value || MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED).toUpperCase();

  const getResolvedMediaId = (msg) => (
    normalizeId(msg?.mediaId) ||
    normalizeId(msg?.serverMessageId) ||
    normalizeId(msg?.id) ||
    normalizeId(msg?.tempId) ||
    getMessageKey(msg)
  );

  const isMediaType = (msg) => {
    const t = String(msg?.type || msg?.mediaType || msg?.messageType || '').toLowerCase();
    return ['image', 'photo', 'video', 'audio', 'file', 'document'].includes(t);
  };

  const formatBytes = (bytes) => {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return 'Unknown size';
    if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    if (value >= 1024) return `${Math.round(value / 1024)} KB`;
    return `${value} B`;
  };

  const resolveMediaInfo = (msg) => {
    const mediaMeta = msg?.mediaMeta || msg?.payload?.mediaMeta || {};
    const mediaWidth = Number(mediaMeta?.width || msg?.mediaWidth || msg?.width || 0);
    const mediaHeight = Number(mediaMeta?.height || msg?.mediaHeight || msg?.height || 0);
    const mediaSize = Number(mediaMeta?.fileSize || msg?.mediaSize || msg?.fileSize || msg?.sizeAfter || 0);
    const mediaType = String(msg?.type || msg?.mediaType || msg?.messageType || mediaMeta?.fileCategory || 'file').toLowerCase();
    const fileName = mediaMeta?.fileName || msg?.fileName || msg?.text || 'Media';

    return {
      mediaWidth,
      mediaHeight,
      mediaSize,
      mediaType,
      fileName,
      sizeLabel: formatBytes(mediaSize),
      typeLabel: mediaType === 'photo' ? 'image' : mediaType,
    };
  };

  const getServerThumbnailUrl = (msg) => (
    msg?.mediaThumbnailUrl ||
    msg?.thumbnailUrl ||
    msg?.previewUrl ||
    msg?.mediaUrl ||
    null
  );

  const resolveCachedThumbnailUrl = (msg) => {
    const mediaId = getResolvedMediaId(msg);
    if (!mediaId) return getServerThumbnailUrl(msg);
    return thumbnailCacheRef.current[mediaId] || getServerThumbnailUrl(msg);
  };

  const getAdaptiveMediaStyle = (msg, fallbackWidth = 200, fallbackHeight = 200) => {
    const info = resolveMediaInfo(msg);
    let width = Number(info.mediaWidth || fallbackWidth);
    let height = Number(info.mediaHeight || fallbackHeight);

    if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) {
      width = fallbackWidth;
      height = fallbackHeight;
    }

    const ratio = width / height;
    let finalWidth = Math.min(MAX_MEDIA_BUBBLE_WIDTH, Math.max(MIN_MEDIA_BUBBLE_WIDTH, width));
    let finalHeight = finalWidth / Math.max(0.2, ratio);

    if (finalHeight > MAX_MEDIA_BUBBLE_HEIGHT) {
      finalHeight = MAX_MEDIA_BUBBLE_HEIGHT;
      finalWidth = finalHeight * ratio;
    }

    if (finalHeight < MIN_MEDIA_BUBBLE_HEIGHT) {
      finalHeight = MIN_MEDIA_BUBBLE_HEIGHT;
      finalWidth = finalHeight * ratio;
    }

    finalWidth = Math.min(MAX_MEDIA_BUBBLE_WIDTH, Math.max(MIN_MEDIA_BUBBLE_WIDTH, finalWidth));

    return {
      width: Math.round(finalWidth),
      height: Math.round(finalHeight),
      borderRadius: 12,
      marginBottom: 2,
    };
  };

  const getMediaAnimationStyle = (messageKey, shouldAnimate) => {
    const key = String(messageKey || 'media');
    let state = mediaAnimRef.current[key];
    if (!state) {
      state = {
        opacity: new Animated.Value(1),
        scale: new Animated.Value(1),
        hasAnimated: false,
      };
      mediaAnimRef.current[key] = state;
    }

    if (shouldAnimate && !state.hasAnimated) {
      state.opacity.setValue(0);
      state.scale.setValue(0.95);
      Animated.parallel([
        Animated.timing(state.opacity, { toValue: 1, duration: 150, useNativeDriver: true }),
        Animated.timing(state.scale, { toValue: 1, duration: 150, useNativeDriver: true }),
      ]).start();
      state.hasAnimated = true;
    }

    return {
      opacity: state.opacity,
      transform: [{ scale: state.scale }],
    };
  };

  const primeThumbnailCacheForMessage = useCallback(async (msg) => {
    if (!msg || !isMediaType(msg)) return;
    const mediaId = getResolvedMediaId(msg);
    if (!mediaId) return;

    if (thumbnailCacheRef.current[mediaId]) {
      return;
    }

    if (thumbnailLoadInFlightRef.current.has(mediaId)) {
      return;
    }

    thumbnailLoadInFlightRef.current.add(mediaId);
    try {
      const cached = await localStorageService.getThumbnailReference(mediaId);
      let resolved = cached?.thumbnailUrl || null;
      if (!resolved) {
        resolved = getServerThumbnailUrl(msg);
        if (resolved) {
          await localStorageService.saveThumbnailReference(mediaId, resolved, resolveMediaInfo(msg).mediaType).catch(() => {});
        }
      }

      if (resolved) {
        thumbnailCacheRef.current[mediaId] = resolved;
        Image.prefetch(resolved).catch(() => {});
        setThumbnailCacheVersion((v) => v + 1);
      }
    } finally {
      thumbnailLoadInFlightRef.current.delete(mediaId);
    }
  }, []);

  // IMPROVED: Better function to check if media is downloaded
  const isMediaDownloaded = (msg) => {
    if (!msg) return false;

    // Check persisted download flag on the message itself (survives app restart)
    if (msg.isMediaDownloaded === true || msg.downloadStatus === MEDIA_DOWNLOAD_STATUS.DOWNLOADED) {
      return true;
    }

    // Check payload download flag
    if (msg.payload?.isMediaDownloaded === true) {
      return true;
    }

    const state = resolveMediaState(msg);
    if (state?.status === MEDIA_DOWNLOAD_STATUS.DOWNLOADED && state?.localPath) {
      return true;
    }

    const keys = getMediaKeyCandidates(msg);

    // Check in downloadedMedia state
    for (const key of keys) {
      if (downloadedMedia[key]) {
        return true;
      }
    }

    // Also check msg.localUri
    if (msg.localUri) {
      return true;
    }

    return false;
  };

  const resolveDownloadedUri = (msg) => {
    if (!msg) return null;

    // Check msg.localUri first (persisted across app restarts)
    if (msg.localUri) {
      return msg.localUri;
    }

    const state = resolveMediaState(msg);
    if (state?.status === MEDIA_DOWNLOAD_STATUS.DOWNLOADED && state?.localPath) {
      return state.localPath;
    }

    const keys = getMediaKeyCandidates(msg);

    // Check downloadedMedia state
    for (const key of keys) {
      if (downloadedMedia[key]) {
        return downloadedMedia[key];
      }
    }

    // Fallback: check payload file uri (sender's own media)
    if (msg.payload?.file?.uri) {
      return msg.payload.file.uri;
    }

    return null;
  };

  const resolveMediaState = (msg) => {
    if (!msg || !mediaDownloadStates) {
      return {
        status: MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED,
        progress: 0,
        localPath: null,
      };
    }
    const keys = getMediaKeyCandidates(msg);
    for (const key of keys) {
      if (mediaDownloadStates[key]) {
        return {
          ...mediaDownloadStates[key],
          status: normalizeDownloadStatus(mediaDownloadStates[key]?.status),
        };
      }
    }
    return {
      status: MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED,
      progress: 0,
      localPath: null,
    };
  };

  const resolveMediaProgress = (msg) => {
    const keys = getMediaKeyCandidates(msg);
    for (const key of keys) {
      if (typeof downloadProgress[key] === 'number') {
        return downloadProgress[key];
      }
    }

    const state = resolveMediaState(msg);
    if (state?.status === MEDIA_DOWNLOAD_STATUS.DOWNLOADING) {
      return Math.max(0, Math.min(1, Number(state?.progress || 0) / 100));
    }

    return 0;
  };

  const resolveUploadProgress = (msg) => {
    const keys = getMediaKeyCandidates(msg);
    for (const key of keys) {
      if (typeof uploadProgress[key] === 'number') {
        return Math.max(0, Math.min(1, Number(uploadProgress[key] || 0)));
      }
    }
    return 0;
  };

  const {
    flatListRef,
    chatData,
    getUserColor,
    groupMembersMap,
    messages,
    isLoadingInitial,
    isRefreshing,
    isManualReloading,
    isSearching,
    search,
    handleSearch,
    clearSearch,
    searchResults,
    currentSearchIndex,
    goToNextResult,
    goToPreviousResult,
    selectedMessage,
    handleToggleSelectMessages,
    clearSelectedMessages,
    handleDeleteSelected,
    text,
    handleTextChange,
    handleSendText,
    scheduleMessage,
    cancelScheduledMessage,
    sendLocationMessage,
    sendContactMessage,
    pendingMedia,
    setPendingMedia,
    openMediaOptions,
    showMediaOptions,
    closeMediaOptions,
    handlePickMedia,
    sendMedia,
    mediaViewer,
    closeMediaViewer,
    handleDownloadMedia,
    downloadedMedia,
    downloadProgress,
    uploadProgress,
    mediaDownloadStates,
    markMediaRemovedLocally,
    resendMessage,
    isPeerTyping,
    renderStatusText,
    isLoadingMore,
    hasMoreMessages,
    onRefresh,
    loadMoreMessages,
    currentUserId,
    manualReloadMessages,
    refreshMessagesFromLocal,
    isChatMuted,
    muteUntil,
    toggleChatMute,
    clearChatForMe,
    clearChatForEveryone,
    markVisibleIncomingAsRead,
    editingMessage, startEditMessage, cancelEditMessage, submitEditMessage,
    replyTarget, startReply, cancelReply,
    toggleReaction, removeReaction, fetchReactionList,
  } = useChatLogic({ navigation, route });

  // ── Mentions ──
  const isGroupChat = Boolean(chatData?.chatType === 'group' || chatData?.isGroup);
  const {
    showSuggestions: showMentionSuggestions,
    suggestions: mentionSuggestions,
    handleTextChangeForMentions,
    handleSelectionChange: handleMentionSelectionChange,
    handleSelectMention,
    getMentionsPayload,
    resetMentions,
    membersList: mentionMembersList,
  } = useMentions(isGroupChat ? groupMembersMap : null, currentUserId);

  const handleTextChangeWithMentions = useCallback((newText) => {
    handleTextChange(newText);
    if (isGroupChat) {
      handleTextChangeForMentions(newText);
    }
  }, [handleTextChange, isGroupChat, handleTextChangeForMentions]);

  const handleMentionSelect = useCallback((member) => {
    handleSelectMention(member, text, (newText) => {
      handleTextChange(newText);
      handleTextChangeForMentions(newText);
    });
  }, [handleSelectMention, text, handleTextChange, handleTextChangeForMentions]);

  // Reaction state
  const [reactionMsgId, setReactionMsgId] = useState(null);
  const [reactionDetailModal, setReactionDetailModal] = useState({ visible: false, reactions: null, selectedEmoji: null, messageId: null });
  const reactionScaleAnims = useRef({}).current;

  // Resolve userId to display name
  const getReactionUserName = useCallback((userId) => {
    if (userId === currentUserId) return 'You';
    const member = groupMembersMap?.[userId];
    if (member?.fullName) return member.fullName;
    // For 1-on-1 chats, use peer name
    if (chatData?.peerUser?.fullName && !chatData?.isGroup) return chatData.peerUser.fullName;
    return userId;
  }, [currentUserId, groupMembersMap, chatData]);

  // Local media viewer state
  const [localMediaViewer, setLocalMediaViewer] = useState({
    visible: false,
    uri: null,
    thumbnailUri: null,
    type: 'image',
    message: null,
    isDownloaded: false
  });
  const [viewerSavedToast, setViewerSavedToast] = useState(false);
  const viewerToastTimer = useRef(null);

  // Media handling functions
  const verifyFileExists = async (uri) => {
    if (!uri) return false;
    // Skip http URLs — those aren't local files
    if (uri.startsWith('http://') || uri.startsWith('https://')) return false;
    try {
      const info = await FileSystem.getInfoAsync(uri);
      return info.exists;
    } catch (_) {
      return false;
    }
  };

  const resolveFileForOpen = async (msg) => {
    // 1. Collect all possible local file URIs
    const candidates = [
      resolveDownloadedUri(msg),
      msg?.localUri,
      msg?.payload?.file?.uri,
      msg?.mediaUrl,
      msg?.previewUrl,
    ].filter(Boolean);

    // Deduplicate
    const uniqueCandidates = [...new Set(candidates)];

    for (const uri of uniqueCandidates) {
      if (await verifyFileExists(uri)) return uri;
    }

    console.log('📂 [resolveFileForOpen] No local file found, trying server download. Candidates tried:', uniqueCandidates);

    // 2. Try signed download URL from API first (most reliable)
    const mediaId = msg?.mediaId || msg?.serverMessageId || msg?.id;
    const fileName = msg?.mediaMeta?.fileName || msg?.payload?.file?.name || msg?.text || `file_${Date.now()}`;
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dest = `${FileSystem.cacheDirectory}${safeName}`;

    if (mediaId && isConnected) {
      try {
        const signedResponse = await mediaDownloadSigned(mediaId);
        const responseData = signedResponse?.data?.data || signedResponse?.data || signedResponse || {};
        const signedUrl =
          responseData?.downloadUrl ||
          responseData?.url ||
          responseData?.mediaUrl ||
          responseData?.previewUrl || null;
        if (signedUrl && (signedUrl.startsWith('http://') || signedUrl.startsWith('https://'))) {
          const result = await FileSystem.downloadAsync(signedUrl, dest);
          if (result?.uri && await verifyFileExists(result.uri)) {
            console.log('✅ [resolveFileForOpen] Downloaded via signed URL');
            return result.uri;
          }
        }
      } catch (signedErr) {
        console.warn('Signed download failed:', signedErr?.message);
      }
    }

    // 3. Try direct server URLs as last resort
    const serverUrls = uniqueCandidates.filter(u => u && (u.startsWith('http://') || u.startsWith('https://')));
    // Also check deeper payload fields
    const extraUrls = [
      msg?.serverMediaUrl,
      msg?.payload?.mediaUrl,
      msg?.mediaMeta?.mediaUrl,
    ].filter(u => u && (u.startsWith('http://') || u.startsWith('https://')));
    const allServerUrls = [...new Set([...serverUrls, ...extraUrls])];

    for (const url of allServerUrls) {
      try {
        const result = await FileSystem.downloadAsync(url, dest);
        if (result?.uri && await verifyFileExists(result.uri)) {
          console.log('✅ [resolveFileForOpen] Downloaded via direct URL');
          return result.uri;
        }
      } catch (_) {}
    }

    return null;
  };

  // ── MIME / extension helpers ──
  const getMimeType = (msg) => {
    return msg?.mimeType || msg?.mediaMeta?.mimeType || msg?.payload?.file?.type || msg?.mediaMeta?.type || 'application/octet-stream';
  };

  const isAudioMime = (mime) => {
    if (!mime) return false;
    const m = mime.toLowerCase();
    return m.startsWith('audio/') || ['application/ogg'].includes(m);
  };

  const isDocumentMime = (mime) => {
    if (!mime) return false;
    const m = mime.toLowerCase();
    return m === 'application/pdf' ||
      m === 'application/msword' ||
      m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      m === 'application/vnd.ms-excel' ||
      m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      m === 'application/vnd.ms-powerpoint' ||
      m === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      m === 'text/plain' ||
      m === 'application/zip' ||
      m === 'application/x-rar-compressed' ||
      m === 'application/rtf';
  };

  const getExtFromName = (name) => {
    if (!name) return '';
    return (name.split('.').pop() || '').toLowerCase();
  };

  const isAudioByExtension = (name) => {
    const ext = getExtFromName(name);
    return ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac', 'wma', 'opus', 'amr', '3gp'].includes(ext);
  };

  // ── In-app audio player ──
  const stopCurrentAudio = useCallback(async () => {
    try {
      if (audioSoundRef.current) {
        await audioSoundRef.current.stopAsync();
        await audioSoundRef.current.unloadAsync();
      }
    } catch (_) {}
    audioSoundRef.current = null;
    setPlayingAudioId(null);
    setAudioPlaybackStatus({});
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioSoundRef.current) {
        audioSoundRef.current.stopAsync().catch(() => {});
        audioSoundRef.current.unloadAsync().catch(() => {});
      }
    };
  }, []);

  const handlePlayAudio = useCallback(async (msg) => {
    const msgKey = msg?.serverMessageId || msg?.id || msg?.tempId;

    // If same audio is playing, toggle pause/play
    if (playingAudioId === msgKey && audioSoundRef.current) {
      const status = await audioSoundRef.current.getStatusAsync();
      if (status.isPlaying) {
        await audioSoundRef.current.pauseAsync();
        return;
      }
      // If finished, replay from start
      if (status.didJustFinish || status.positionMillis >= status.durationMillis) {
        await audioSoundRef.current.setPositionAsync(0);
      }
      await audioSoundRef.current.playAsync();
      return;
    }

    // Stop previous audio
    await stopCurrentAudio();

    // Resolve URI
    const isSender = msg?.senderType === 'self' || msg?.senderId === currentUserId;
    let uri = null;

    if (isSender) {
      uri = msg?.localUri || msg?.payload?.file?.uri || resolveDownloadedUri(msg) || msg?.mediaUrl;
    } else {
      uri = resolveDownloadedUri(msg) || msg?.localUri;
      if (!uri) {
        // Need to download first
        uri = await resolveFileForOpen(msg);
      }
    }

    if (!uri) {
      Alert.alert('Audio unavailable', 'Could not load this audio file.');
      return;
    }

    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });

      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true },
        (status) => {
          if (status.isLoaded) {
            setAudioPlaybackStatus({
              isPlaying: status.isPlaying,
              positionMillis: status.positionMillis || 0,
              durationMillis: status.durationMillis || 0,
              didJustFinish: status.didJustFinish,
            });
            if (status.didJustFinish) {
              setPlayingAudioId(null);
            }
          }
        }
      );

      audioSoundRef.current = sound;
      setPlayingAudioId(msgKey);
    } catch (err) {
      console.error('Audio playback error:', err);
      Alert.alert('Error', 'Failed to play audio.');
      setPlayingAudioId(null);
    }
  }, [playingAudioId, currentUserId, stopCurrentAudio]);

  const handleSeekAudio = useCallback(async (ratio) => {
    if (!audioSoundRef.current) return;
    try {
      const status = await audioSoundRef.current.getStatusAsync();
      if (status.isLoaded && status.durationMillis > 0) {
        const position = Math.floor(ratio * status.durationMillis);
        await audioSoundRef.current.setPositionAsync(position);
      }
    } catch (_) {}
  }, []);

  // ── Document opener (external app chooser) ──
  const openDocumentWithChooser = async (uri, msg) => {
    const mimeType = getMimeType(msg);

    if (Platform.OS === 'android') {
      try {
        // Convert file:// URI to content:// URI for Android app chooser
        // getContentUriAsync is available in both legacy and non-legacy expo-file-system
        let contentUri = uri;
        if (uri.startsWith('file://') && FileSystem.getContentUriAsync) {
          contentUri = await FileSystem.getContentUriAsync(uri);
        }
        await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
          data: contentUri,
          flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
          type: mimeType,
        });
        return;
      } catch (err) {
        console.warn('IntentLauncher failed:', err?.message);
        // Fallback: try Sharing which also opens app chooser on Android
        try {
          if (await Sharing.isAvailableAsync()) {
            await Sharing.shareAsync(uri, { mimeType, UTI: mimeType, dialogTitle: 'Open with' });
            return;
          }
        } catch (_) {}
        Alert.alert('No app found', 'No app found to open this document. Please install a compatible viewer.');
      }
    } else {
      // iOS: Sharing presents Quick Look / app chooser
      try {
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(uri, { mimeType, dialogTitle: 'Open' });
          return;
        }
      } catch (_) {}
      try {
        await Linking.openURL(uri);
      } catch (_) {
        Alert.alert('No app found', 'No app found to open this document.');
      }
    }
  };

  const openFileWithSharing = async (uri, msg) => {
    const mimeType = getMimeType(msg);
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, { mimeType, dialogTitle: 'Open' });
    } else {
      await Linking.openURL(uri);
    }
  };

  // Resolve a local file URI for a message (sender or receiver)
  const resolveLocalFileUri = async (msg) => {
    const isSenderMsg = msg?.senderType === 'self' || msg?.senderId === currentUserId;
    if (isSenderMsg) {
      const directUris = [
        msg?.localUri,
        msg?.payload?.file?.uri,
        resolveDownloadedUri(msg),
        msg?.mediaUrl,
        msg?.previewUrl,
      ].filter(u => u && !u.startsWith('http://') && !u.startsWith('https://'));

      for (const uri of directUris) {
        if (await verifyFileExists(uri)) return uri;
      }
    }
    // Full resolve with download fallback
    return await resolveFileForOpen(msg);
  };

  const handleShareMedia = async (msg) => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      const mime = getMimeType(msg);
      const fileName = msg?.mediaMeta?.fileName || msg?.payload?.file?.name || msg?.text || '';
      const msgType = String(msg?.type || msg?.mediaType || '').toLowerCase();

      // ── Audio: play in-app ──
      if (msgType === 'audio' || isAudioMime(mime) || isAudioByExtension(fileName)) {
        await handlePlayAudio(msg);
        return;
      }

      // ── Document / File: open with external app chooser ──
      if (msgType === 'file' || msgType === 'document' || isDocumentMime(mime)) {
        const localUri = await resolveLocalFileUri(msg);
        if (!localUri) {
          Alert.alert('File unavailable', 'Could not load this file. Check your internet connection and try again.');
          return;
        }
        await openDocumentWithChooser(localUri, msg);
        return;
      }

      // ── All other media (images, videos, etc.): use sharing ──
      const localUri = await resolveLocalFileUri(msg);
      if (!localUri) {
        Alert.alert('File unavailable', 'Could not load this file. Check your internet connection and try again.');
        return;
      }
      await openFileWithSharing(localUri, msg);
    } catch (error) {
      console.error('Error sharing media:', error);
      Alert.alert('Error', 'Failed to open file.');
    }
  };

  const handleSaveToGallery = async (msg) => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const localUri = await resolveFileForOpen(msg);

      if (!localUri) {
        Alert.alert('File unavailable', 'Could not load this file. Check your internet connection and try again.');
        return;
      }

      // Check existing permission first — only prompt if not yet granted
      let perm = await MediaLibrary.getPermissionsAsync();
      if (perm.status !== 'granted') {
        perm = await MediaLibrary.requestPermissionsAsync();
        if (perm.status !== 'granted') return;
      }

      await MediaLibrary.createAssetAsync(localUri);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    } catch (error) {
      console.error('Error saving to library:', error);
    }
  };

  const handleDeleteMedia = async (msg) => {
    Alert.alert(
      'Delete Media',
      'Are you sure you want to delete this media from your device?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
              const messageKey = getMessageKey(msg);
              const mediaKeys = getMediaKeyCandidates(msg);
              const localUri = resolveDownloadedUri(msg);
              
              if (localUri) {
                await FileSystem.deleteAsync(localUri, { idempotent: true });

                const localStorageService = (await import('../../services/LocalStorageService')).default;
                await Promise.all(mediaKeys.map((key) => localStorageService.removeDownloadedMedia(key).catch(() => {})));
                await localStorageService.removeDownloadedMedia(messageKey).catch(() => {});
                await markMediaRemovedLocally([...mediaKeys, messageKey]);
                
                Alert.alert('Success', 'Media deleted from device');
              }
            } catch (error) {
              console.error('Error deleting media:', error);
              Alert.alert('Error', 'Failed to delete media');
            }
          }
        }
      ]
    );
  };

  // IMPROVED: Enhanced download function with better persistence
  const handleDownloadWithPersistence = async (msg) => {
    try {
      if (!isConnected) {
        Alert.alert('Offline', 'Connect to the internet to download this media.');
        return;
      }

      // First check if already downloaded
      const existingUri = resolveDownloadedUri(msg);
      if (existingUri) {
        console.log('📁 Media already downloaded, opening viewer instead');
        openMediaViewer(msg, existingUri, msg.type === 'video' ? 'video' : 'image');
        return;
      }

      const mediaInfo = resolveMediaInfo(msg);
      const isMetered = ['cellular', 'mobile', 'unknown'].includes(String(networkType || '').toLowerCase());
      if (isMetered && mediaInfo.mediaSize > LARGE_DOWNLOAD_BYTES) {
        const proceed = await new Promise((resolve) => {
          Alert.alert(
            'Large download on mobile data',
            `This media is ${mediaInfo.sizeLabel}. Continue downloading?`,
            [
              { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
              { text: 'Download', onPress: () => resolve(true) },
            ],
            { cancelable: true }
          );
        });

        if (!proceed) return;
      }

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      
      // Show downloading state
      // The actual download happens in handleDownloadMedia from useChatLogic
      const localUri = await handleDownloadMedia(msg);

      const downloadedUri = localUri || resolveDownloadedUri(msg);
      
      if (downloadedUri) {
        console.log('✅ Media downloaded and persisted:', downloadedUri);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (error) {
      console.error('Error downloading media:', error);
      Alert.alert('Error', 'Failed to download media');
    }
  };

  const openMediaViewer = (msg, uri, type = 'image') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const isDownloaded = !!resolveDownloadedUri(msg);
    
    setLocalMediaViewer({
      visible: true,
      uri: uri || (isDownloaded ? resolveDownloadedUri(msg) : msg.mediaUrl),
      thumbnailUri: msg.mediaThumbnailUrl || msg.previewUrl,
      type: type,
      message: msg,
      isDownloaded: isDownloaded
    });
  };

  const closeLocalMediaViewer = () => {
    setLocalMediaViewer(prev => ({ ...prev, visible: false }));
    setViewerSavedToast(false);
    if (viewerToastTimer.current) clearTimeout(viewerToastTimer.current);
  };

  // Scroll handling
  const handleScroll = (event) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const offsetY = Math.max(0, contentOffset?.y || 0);
    const maxOffset = Math.max(0, (contentSize?.height || 0) - (layoutMeasurement?.height || 0));
    const nearLatest = offsetY <= 80;
    const nearOldest = maxOffset > 0 ? (maxOffset - offsetY) <= 60 : true;
    const shouldShowScroll = !nearLatest;
    const prev = lastScrollStateRef.current;

    if (prev.isAtLatest !== nearLatest) {
      setIsAtLatest(nearLatest);
      lastScrollStateRef.current.isAtLatest = nearLatest;
    }

    if (prev.showScrollButton !== shouldShowScroll) {
      setShowScrollButton(shouldShowScroll);
      lastScrollStateRef.current.showScrollButton = shouldShowScroll;
    }

    if (prev.isAtTop !== nearOldest) {
      setIsAtTop(nearOldest);
      lastScrollStateRef.current.isAtTop = nearOldest;
    }

    if (nearLatest) {
      setNewMessagesCount(0);
    }
  };

  const handleScrollBeginDrag = useCallback(() => {
    isUserScrollingRef.current = true;
    showStickyDateBadge();
  }, [showStickyDateBadge]);

  const handleScrollEndDrag = useCallback(() => {
    isUserScrollingRef.current = false;
    hideStickyDateBadge(950);
  }, [hideStickyDateBadge]);

  const handleMomentumScrollBegin = useCallback(() => {
    isUserScrollingRef.current = true;
    showStickyDateBadge();
  }, [showStickyDateBadge]);

  const handleMomentumScrollEnd = useCallback(() => {
    isUserScrollingRef.current = false;
    hideStickyDateBadge(950);
  }, [hideStickyDateBadge]);

  const handleScrollToLatest = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    flatListRef?.current?.scrollToOffset?.({ offset: 0, animated: true });
    setNewMessagesCount(0);
  };

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    const list = viewableItems || [];
    const visibleIds = [];
    const nextVisibleMap = {};

    list.forEach(({ item }) => {
      const id = getMessageKey(item);
      if (!id) return;
      visibleIds.push(id);
      nextVisibleMap[id] = true;
    });

    const prevMap = visibleMapRef.current;
    const prevKeys = Object.keys(prevMap);
    const nextKeys = Object.keys(nextVisibleMap);
    const mapChanged = prevKeys.length !== nextKeys.length || nextKeys.some((key) => !prevMap[key]);
    if (mapChanged) {
      visibleMapRef.current = nextVisibleMap;
      setVisibleMessageKeys(nextVisibleMap);
    }

    if (visibleIds.length > 0) {
      const nextSignature = visibleIds.join('|');
      if (pendingVisibleReadSignatureRef.current !== nextSignature) {
        pendingVisibleReadSignatureRef.current = nextSignature;
        setPendingVisibleReadIds(visibleIds);
      }
    }

    let topVisibleEntry = null;
    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i];
      if (typeof entry?.index !== 'number') continue;
      if (!topVisibleEntry || entry.index > topVisibleEntry.index) {
        topVisibleEntry = entry;
      }
    }

    const topVisible = topVisibleEntry?.item;
    if (topVisible && topVisibleEntry && topVisibleEntry.index !== topVisibleIndexRef.current) {
      topVisibleIndexRef.current = topVisibleEntry.index;
      const nextLabel = getFloatingDateLabel(getMessageDateKey(topVisible));
      setStickyDateLabel((prevLabel) => (prevLabel === nextLabel ? prevLabel : nextLabel));
      if (isUserScrollingRef.current) {
        showStickyDateBadge();
      }
    }
  }).current;

  useEffect(() => {
    if (!Array.isArray(pendingVisibleReadIds) || pendingVisibleReadIds.length === 0) return;
    // Defer read sync to an effect so provider updates never run during render.
    markVisibleIncomingAsRead(pendingVisibleReadIds);
  }, [pendingVisibleReadIds, markVisibleIncomingAsRead]);

  useEffect(() => {
    const visibleMessages = messages.filter((msg) => visibleMessageKeys[getMessageKey(msg)]);
    if (visibleMessages.length === 0) return;
    visibleMessages.forEach((msg) => {
      if (isMediaType(msg)) {
        primeThumbnailCacheForMessage(msg).catch(() => {});
      }
    });
  }, [messages, visibleMessageKeys, primeThumbnailCacheForMessage]);

  // Populate text input when entering edit mode
  useEffect(() => {
    if (editingMessage) {
      handleTextChange(editingMessage.text || '');
    }
  }, [editingMessage]);

  // Input handling
  const handleInputContentSizeChange = (event) => {
    const nextHeight = Math.max(34, Math.min(108, event?.nativeEvent?.contentSize?.height || 34));
    setInputHeight(nextHeight);
  };

  const emojiSectionsMeta = useMemo(() => ([
    { key: 'recent', label: 'Recent', icon: 'time-outline' },
    { key: 'smileys', label: 'Smileys', icon: 'happy-outline' },
    { key: 'animals', label: 'Animals', icon: 'paw-outline' },
    { key: 'food', label: 'Food', icon: 'pizza-outline' },
    { key: 'activities', label: 'Activities', icon: 'football-outline' },
  ]), []);

  const activeEmojiList = useMemo(() => {
    if (activeEmojiSection === 'recent') return recentEmojis;
    return EMOJI_SECTIONS[activeEmojiSection] || [];
  }, [activeEmojiSection, recentEmojis]);

  const handleOpenEmojiPanel = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShowEmojiPanel((prev) => {
      if (prev) {
        // Emoji panel is open → close it and show keyboard
        chatInputRef.current?.focus();
        return false;
      } else {
        // Emoji panel is closed → dismiss keyboard and show emoji panel
        Keyboard.dismiss();
        return true;
      }
    });
  }, []);

  const handleSelectEmoji = useCallback((emoji) => {
    if (!emoji) return;
    handleTextChange(`${text || ''}${emoji}`);
    setRecentEmojis((prev) => {
      const filtered = (prev || []).filter((item) => item !== emoji);
      return [emoji, ...filtered].slice(0, 30);
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [handleTextChange, text]);

  const clearRecordingInterval = useCallback(() => {
    if (audioDurationIntervalRef.current) {
      clearInterval(audioDurationIntervalRef.current);
      audioDurationIntervalRef.current = null;
    }
  }, []);

  const stopVoiceRecording = useCallback(async ({ cancel = false } = {}) => {
    try {
      clearRecordingInterval();
      // Stop recording animations
      if (recPulseAnim._pulseRef) { recPulseAnim._pulseRef.stop(); recPulseAnim._pulseRef = null; }
      if (recWaveAnims._loops) { recWaveAnims._loops.forEach(l => l.stop()); recWaveAnims._loops = null; }
      recWaveAnims.forEach(a => a.setValue(0.3));
      recPulseAnim.setValue(1);
      recSlideAnim.setValue(0);
      Animated.timing(recBarAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start();

      const recording = audioRecordingRef.current;
      audioRecordingRef.current = null;
      setIsRecordingAudio(false);

      if (!recording) {
        setRecordingDurationMs(0);
        return;
      }

      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      const status = await recording.getStatusAsync();

      if (cancel || !uri) {
        setRecordingDurationMs(0);
        if (uri) {
          FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
        }
        return;
      }

      const fileInfo = await FileSystem.getInfoAsync(uri);
      const ext = Platform.OS === 'ios' ? 'm4a' : 'aac';
      const duration = Number(status?.durationMillis || recordingDurationMs || 0);

      setPendingMedia({
        file: {
          uri,
          name: `voice_${Date.now()}.${ext}`,
          type: Platform.OS === 'ios' ? 'audio/m4a' : 'audio/aac',
          size: Number(fileInfo?.size || 0),
          duration,
        },
        type: 'audio',
      });
      setRecordingDurationMs(0);
    } catch (error) {
      console.error('stopVoiceRecording error', error);
      setIsRecordingAudio(false);
      setRecordingDurationMs(0);
      Alert.alert('Error', 'Unable to complete voice recording.');
    }
  }, [clearRecordingInterval, recordingDurationMs, setPendingMedia]);

  const startVoiceRecording = useCallback(async () => {
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (permission.status !== 'granted') {
        Alert.alert('Permission required', 'Microphone permission is required to record audio.');
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await recording.startAsync();

      audioRecordingRef.current = recording;
      setIsRecordingAudio(true);
      setRecordingDurationMs(0);

      // Start recording animations
      recBarAnim.setValue(0);
      Animated.spring(recBarAnim, { toValue: 1, tension: 60, friction: 8, useNativeDriver: true }).start();
      // Pulse red dot
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(recPulseAnim, { toValue: 0.3, duration: 600, useNativeDriver: true }),
          Animated.timing(recPulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
        ])
      );
      pulse.start();
      recPulseAnim._pulseRef = pulse;
      // Waveform bars animation
      const waveLoops = recWaveAnims.map((anim, i) => {
        const delay = i * 60;
        const duration = 300 + Math.random() * 400;
        const loop = Animated.loop(
          Animated.sequence([
            Animated.timing(anim, { toValue: 0.4 + Math.random() * 0.6, duration, delay, useNativeDriver: true }),
            Animated.timing(anim, { toValue: 0.15 + Math.random() * 0.2, duration: duration * 0.8, useNativeDriver: true }),
          ])
        );
        loop.start();
        return loop;
      });
      recWaveAnims._loops = waveLoops;

      clearRecordingInterval();
      audioDurationIntervalRef.current = setInterval(() => {
        setRecordingDurationMs((prev) => {
          const next = prev + 1000;
          if (next >= AUDIO_RECORDING_MAX_MS) {
            stopVoiceRecording({ cancel: false }).catch(() => {});
          }
          return next;
        });
      }, 1000);
    } catch (error) {
      console.error('startVoiceRecording error', error);
      Alert.alert('Error', 'Unable to start voice recording.');
      setIsRecordingAudio(false);
      clearRecordingInterval();
    }
  }, [clearRecordingInterval, stopVoiceRecording]);

  const handleSubmitInput = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setShowEmojiPanel(false);

    // Handle edit mode submission
    if (editingMessage) {
      if (text.trim()) {
        await submitEditMessage(text);
        handleTextChange('');
      }
      return;
    }

    if (!text.trim() && !pendingMedia) {
      if (isRecordingAudio) {
        await stopVoiceRecording({ cancel: false });
      } else {
        await startVoiceRecording();
      }
      return;
    }
    if (pendingMedia) {
      const mediaToSend = pendingMedia;
      setPendingMedia(null);
      handleTextChange('');
      await sendMedia(mediaToSend);
      return;
    }
    // Extract mentions before sending (text gets cleared after send)
    const mentions = isGroupChat ? getMentionsPayload(text) : undefined;
    // Fire-and-forget: message appears instantly via optimistic UI, no need to await
    handleSendText(mentions).catch(err => console.warn('[Send] error:', err?.message));
    if (isGroupChat) resetMentions();
  };

  const recordingDurationLabel = useMemo(() => {
    const totalSec = Math.max(0, Math.floor(recordingDurationMs / 1000));
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const ss = String(totalSec % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }, [recordingDurationMs]);

  const mediaPanelClosingRef = useRef(false);

  const closeMediaPanelAnimated = useCallback((afterClose) => {
    if (mediaPanelClosingRef.current) return;
    mediaPanelClosingRef.current = true;

    Animated.parallel([
      Animated.timing(mediaBackdropAnim, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }),
      Animated.timing(mediaSheetAnim, {
        toValue: MEDIA_PANEL_SHEET_HEIGHT,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start(() => {
      closeMediaOptions();
      mediaPanelClosingRef.current = false;
      if (typeof afterClose === 'function') afterClose();
    });
  }, [closeMediaOptions, mediaBackdropAnim, mediaSheetAnim]);

  const handleToggleMediaOptions = useCallback(() => {
    if (showMediaOptions) {
      closeMediaPanelAnimated();
      return;
    }
    openMediaOptions();
  }, [showMediaOptions, closeMediaPanelAnimated, openMediaOptions]);

  const handleMediaOptionPressIn = useCallback((key) => {
    const scale = mediaOptionPressAnims[key];
    if (!scale) return;
    Animated.timing(scale, {
      toValue: 0.92,
      duration: 90,
      useNativeDriver: true,
    }).start();
  }, [mediaOptionPressAnims]);

  const handleMediaOptionPressOut = useCallback((key) => {
    const scale = mediaOptionPressAnims[key];
    if (!scale) return;
    Animated.timing(scale, {
      toValue: 1,
      duration: 120,
      useNativeDriver: true,
    }).start();
  }, [mediaOptionPressAnims]);

  const handleCameraCapture = useCallback(async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (permission.status !== 'granted') {
        Alert.alert('Permission required', 'Camera permission is required to capture a photo.');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
        allowsEditing: false,
      });

      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset?.uri) return;

      setPendingMedia({
        file: {
          uri: asset.uri,
          name: asset.fileName || `camera_${Date.now()}.jpg`,
          type: asset.mimeType || 'image/jpeg',
          size: asset.fileSize || 0,
        },
        type: 'image',
      });
    } catch (error) {
      console.error('camera capture error', error);
      Alert.alert('Error', 'Unable to open camera right now.');
    }
  }, [setPendingMedia]);

  const handleAudioPick = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['audio/*'],
        copyToCacheDirectory: false,
      });
      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset?.uri) return;

      setPendingMedia({
        file: {
          uri: asset.uri,
          name: asset.name || `audio_${Date.now()}`,
          type: asset.mimeType || 'audio/mpeg',
          size: asset.size || 0,
        },
        type: 'audio',
      });
    } catch (error) {
      console.error('audio picker error', error);
      Alert.alert('Error', 'Unable to pick audio file.');
    }
  }, [setPendingMedia]);

  const handleShareLocation = useCallback(async () => {
    try {
      if (!isConnected) {
        Alert.alert('Offline', 'Connect to internet to share live location.');
        return;
      }

      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        Alert.alert('Permission required', 'Location permission is required to share location.');
        return;
      }

      const position = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('location timeout')), 12000)),
      ]);

      const latitude = Number(position?.coords?.latitude || 0);
      const longitude = Number(position?.coords?.longitude || 0);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        Alert.alert('Error', 'Could not read your device location.');
        return;
      }

      let address = '';
      try {
        const geo = await Location.reverseGeocodeAsync({ latitude, longitude });
        const first = geo?.[0];
        if (first) {
          address = [first.name, first.street, first.city, first.region, first.country]
            .filter(Boolean)
            .join(', ');
        }
      } catch (_err) {
        // Address is optional; ignore reverse geocode failures.
      }

      const mapPreviewUrl = `https://maps.google.com/?q=${latitude},${longitude}`;
      await sendLocationMessage({ latitude, longitude, address, mapPreviewUrl });
    } catch (error) {
      console.error('share location error', error);
      Alert.alert('Error', 'Unable to fetch current location.');
    }
  }, [isConnected, sendLocationMessage]);

  const handleShareDeviceContact = useCallback(async () => {
    try {
      if (!isConnected) {
        Alert.alert('Offline', 'Connect to internet to share contact.');
        return;
      }

      const permission = await Contacts.requestPermissionsAsync();
      if (permission.status !== 'granted') {
        Alert.alert('Permission required', 'Contacts permission is required to share a contact.');
        return;
      }

      const selected = await Contacts.presentContactPickerAsync();
      if (!selected?.id) return;

      const full = await Contacts.getContactByIdAsync(selected.id, [
        Contacts.Fields.PhoneNumbers,
        Contacts.Fields.Image,
      ]);

      const contactName = full?.name || full?.firstName || 'Unknown contact';
      const phoneNumbers = (full?.phoneNumbers || []).map(p => ({
        label: p.label || 'mobile',
        number: p.number || '',
      })).filter(p => p.number);
      const primaryPhone = phoneNumbers[0]?.number || '';

      if (!primaryPhone) {
        Alert.alert('No phone number', 'Selected contact has no phone number.');
        return;
      }

      // Extract country code and clean number
      const phoneClean = primaryPhone.replace(/[\s\-()]/g, '');
      let countryCode = '';
      let mobileNumber = phoneClean;
      if (phoneClean.startsWith('+')) {
        // Try to split country code (assume 1-3 digits after +)
        const match = phoneClean.match(/^(\+\d{1,3})(.+)$/);
        if (match) {
          countryCode = match[1];
          mobileNumber = match[2];
        }
      }

      // Check if this contact is registered in the app
      // Try to find in existing chat list or matched contacts
      let isRegistered = false;
      let registeredUserId = null;
      let registeredProfileImage = '';

      // Check from chatData list in useChatLogic (via allMessages sender/receiver IDs won't help)
      // We'll use the API discover approach — but for simplicity, check local storage for synced contacts
      try {
        const syncedRaw = await AsyncStorage.getItem('@matched_contacts');
        if (syncedRaw) {
          const contacts = JSON.parse(syncedRaw);
          if (Array.isArray(contacts)) {
            const normalizedPhone = phoneClean.replace(/^\+/, '');
            const found = contacts.find(c => {
              if (!c) return false;
              const cPhone = (c.mobileFormatted || c.mobile?.number || c.phone || '').replace(/[\s\-()+ ]/g, '');
              return cPhone && (normalizedPhone.endsWith(cPhone) || cPhone.endsWith(normalizedPhone));
            });
            if (found && (found.type === 'registered' || found.userId)) {
              isRegistered = true;
              registeredUserId = found.userId || found._id || null;
              registeredProfileImage = found.profileImage || found.profilePicture || '';
            }
          }
        }
      } catch (e) {
        // Ignore lookup errors
      }

      await sendContactMessage({
        fullName: contactName,
        countryCode,
        mobileNumber,
        userId: registeredUserId,
        profileImage: registeredProfileImage,
        isRegistered,
      });
    } catch (error) {
      console.error('share contact error', error);
      Alert.alert('Error', 'Unable to share contact right now.');
    }
  }, [isConnected, sendContactMessage]);

  const handleMediaOptionSelect = useCallback((key) => {
    const run = async () => {
      if (key === 'gallery') {
        await handlePickMedia('image');
        return;
      }
      if (key === 'video') {
        await handlePickMedia('video');
        return;
      }
      if (key === 'document') {
        await handlePickMedia('document');
        return;
      }
      if (key === 'camera') {
        await handleCameraCapture();
        return;
      }
      if (key === 'audio') {
        await handleAudioPick();
        return;
      }
      if (key === 'contact') {
        await handleShareDeviceContact();
        return;
      }
      if (key === 'location') {
        await handleShareLocation();
        return;
      }
      Alert.alert('Coming soon', 'Poll sharing will be available soon.');
    };

    closeMediaPanelAnimated(() => {
      run().catch((error) => {
        console.error('media option action error', error);
      });
    });
  }, [
    closeMediaPanelAnimated,
    handlePickMedia,
    handleCameraCapture,
    handleAudioPick,
    handleShareDeviceContact,
    handleShareLocation,
  ]);

  const mediaPanelPanResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) => gestureState.dy > 8 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx),
    onPanResponderMove: (_, gestureState) => {
      const next = Math.max(0, gestureState.dy);
      mediaSheetAnim.setValue(next);
      const opacity = Math.max(0, Math.min(1, 1 - (next / MEDIA_PANEL_SHEET_HEIGHT)));
      mediaBackdropAnim.setValue(opacity);
    },
    onPanResponderRelease: (_, gestureState) => {
      if (gestureState.dy > 110 || gestureState.vy > 1.05) {
        closeMediaPanelAnimated();
        return;
      }
      Animated.parallel([
        Animated.spring(mediaSheetAnim, {
          toValue: 0,
          damping: 18,
          stiffness: 220,
          mass: 0.9,
          useNativeDriver: true,
        }),
        Animated.timing(mediaBackdropAnim, {
          toValue: 1,
          duration: 140,
          useNativeDriver: true,
        }),
      ]).start();
    },
  }), [closeMediaPanelAnimated, mediaBackdropAnim, mediaSheetAnim]);

  // Keyboard handling — smooth animated transitions like WhatsApp
  const kbHideTimerRef = useRef(null);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvent, (event) => {
      if (kbHideTimerRef.current) {
        clearTimeout(kbHideTimerRef.current);
        kbHideTimerRef.current = null;
      }
      const nextHeight = event?.endCoordinates?.height || 0;
      const duration = Platform.OS === 'ios' ? (event?.duration || 250) : 220;
      setKeyboardHeight(nextHeight);
      setIsInputFocused(true);
      setShowEmojiPanel(false);
      Animated.timing(keyboardAnim, {
        toValue: nextHeight,
        duration,
        useNativeDriver: false,
      }).start();
    });

    const hideSub = Keyboard.addListener(hideEvent, (event) => {
      kbHideTimerRef.current = setTimeout(() => {
        kbHideTimerRef.current = null;
        const duration = Platform.OS === 'ios' ? (event?.duration || 250) : 200;
        // Don't reset keyboard height if emoji panel is opening (keeps panel same height)
        setKeyboardHeight((prev) => prev);
        setIsInputFocused(false);
        Animated.timing(keyboardAnim, {
          toValue: 0,
          duration,
          useNativeDriver: false,
        }).start();
      }, 80);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
      if (kbHideTimerRef.current) clearTimeout(kbHideTimerRef.current);
    };
  }, [keyboardAnim]);

  useEffect(() => {
    return () => {
      clearRecordingInterval();
      if (audioRecordingRef.current) {
        audioRecordingRef.current.stopAndUnloadAsync().catch(() => {});
      }
    };
  }, [clearRecordingInterval]);

  // emojiPanelAnim no longer needed — emoji panel is inline below input bar

  useEffect(() => {
    if (!showMediaOptions) {
      mediaBackdropAnim.setValue(0);
      mediaSheetAnim.setValue(MEDIA_PANEL_SHEET_HEIGHT);
      mediaOptionEntryAnims.forEach((anim) => anim.setValue(0));
      return;
    }

    mediaBackdropAnim.setValue(0);
    mediaSheetAnim.setValue(MEDIA_PANEL_SHEET_HEIGHT);
    // Set all entry anims to 1 immediately — no stagger delay
    mediaOptionEntryAnims.forEach((anim) => anim.setValue(1));

    Animated.parallel([
      Animated.timing(mediaBackdropAnim, {
        toValue: 1,
        duration: 150,
        useNativeDriver: true,
      }),
      Animated.spring(mediaSheetAnim, {
        toValue: 0,
        damping: 22,
        stiffness: 300,
        mass: 0.8,
        useNativeDriver: true,
      }),
    ]).start();
  }, [showMediaOptions, mediaBackdropAnim, mediaSheetAnim, mediaOptionEntryAnims]);

  useEffect(() => () => {
    clearStickyDateHideTimer();
  }, [clearStickyDateHideTimer]);

  // Animate scroll-to-bottom button
  useEffect(() => {
    Animated.spring(scrollBtnAnim, {
      toValue: showScrollButton ? 1 : 0,
      damping: 18,
      stiffness: 280,
      mass: 0.6,
      useNativeDriver: true,
    }).start();
  }, [showScrollButton, scrollBtnAnim]);

  // New messages counter
  useEffect(() => {
    const latestId = messages?.[0]?.id || messages?.[0]?.serverMessageId || null;
    if (!latestId) return;
    if (!previousTopMessageRef.current) {
      previousTopMessageRef.current = latestId;
      return;
    }
    if (previousTopMessageRef.current !== latestId && !isAtLatest) {
      setNewMessagesCount(prev => prev + 1);
    }
    previousTopMessageRef.current = latestId;
  }, [messages, isAtLatest]);

  useEffect(() => {
    if (!messages?.length) {
      setStickyDateLabel('');
      topVisibleIndexRef.current = -1;
      return;
    }
    setStickyDateLabel((prev) => prev || getFloatingDateLabel(getMessageDateKey(messages[0])));
  }, [messages, getFloatingDateLabel, getMessageDateKey]);

  // Menu handlers
  const handleToggleSearchBar = () => {
    setShowMenu(false);
    setShowSearchBar(prev => {
      const next = !prev;
      if (!next) {
        clearSearch();
      }
      return next;
    });
  };

  const handleCloseSearchBar = () => {
    clearSearch();
    setShowSearchBar(false);
  };

  const handleOpenContactInfo = () => {
    setShowMenu(false);
    const isGroupChat = Boolean(chatData?.chatType === 'group' || chatData?.isGroup);
    if (isGroupChat) {
      navigation.navigate('GroupInfo', {
        groupId: chatData?.groupId || chatData?.group?._id || chatData?.chatId || chatData?._id || route?.params?.chatId,
        item: chatData,
      });
    } else {
      navigation.navigate('UserB', { item: chatData });
    }
  };

  const handleChatMuteOptions = () => {
    setShowMenu(false);
    const now = Date.now();
    const currentlyMuted = Boolean(isChatMuted) && (!muteUntil || muteUntil > now);
    const options = [
      { text: 'Cancel', style: 'cancel' },
      { text: '1 hour', onPress: () => toggleChatMute(60 * 60 * 1000) },
      { text: '8 hours', onPress: () => toggleChatMute(8 * 60 * 60 * 1000) },
      { text: '1 week', onPress: () => toggleChatMute(7 * 24 * 60 * 60 * 1000) },
      { text: 'Always', onPress: () => toggleChatMute(365 * 24 * 60 * 60 * 1000) },
    ];

    if (currentlyMuted) {
      options.splice(1, 0, { text: 'Unmute', onPress: () => toggleChatMute(null) });
    }

    Alert.alert('Mute notifications', 'Choose mute duration', options);
  };

  const handleMenuReload = async () => {
    setShowMenu(false);
    await manualReloadMessages();
  };

  const handleMenuLocalRefresh = async () => {
    setShowMenu(false);
    await refreshMessagesFromLocal();
  };

  const handleClearChatOptions = useCallback(() => {
    setShowMenu(false);

    Alert.alert(
      'Clear Chat',
      'Are you sure you want to clear this chat?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear for me',
          onPress: async () => {
            try {
              await clearChatForMe();
            } catch {
              Alert.alert('Error', 'Unable to clear chat for you right now.');
            }
          },
        },
        {
          text: 'Clear for everyone',
          style: 'destructive',
          onPress: async () => {
            try {
              await clearChatForEveryone();
            } catch {
              Alert.alert('Error', 'Unable to clear chat for everyone right now.');
            }
          },
        },
      ]
    );
  }, [clearChatForMe, clearChatForEveryone]);

  const renderChatEmptyState = useCallback(() => (
    <View style={{ flexGrow: 1, justifyContent: 'flex-end', alignItems: 'center', paddingHorizontal: 24, paddingBottom: 20, transform: [{ rotate: '180deg' }] }}>
      <View style={{
        backgroundColor: isDarkMode ? 'rgba(25,40,55,0.85)' : 'rgba(225,230,236,0.85)',
        paddingHorizontal: 14,
        paddingVertical: 5,
        borderRadius: 8,
        marginBottom: 10,
      }}>
        <Text style={{
          fontSize: 11.5,
          color: isDarkMode ? 'rgba(210,220,230,0.85)' : '#5f6769',
          fontFamily: 'Roboto-Medium',
          letterSpacing: 0.1,
        }}>
          TODAY
        </Text>
      </View>
      <View style={{
        backgroundColor: isDarkMode ? 'rgba(25,40,55,0.75)' : 'rgba(225,230,236,0.75)',
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 8,
        alignItems: 'center',
        maxWidth: '85%',
      }}>
        <Text style={{ color: theme.colors.placeHolderTextColor, fontSize: 11.5, fontFamily: 'Roboto-Regular', textAlign: 'center' }}>
          Messages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them.
        </Text>
      </View>
    </View>
  ), [theme.colors.placeHolderTextColor, isDarkMode]);

  useEffect(() => {
    if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
  }, []);

  // Render functions
  const renderDateBadge = useCallback((dateKey) => {
    const displayDate = getDateLabel(dateKey);
    return (
      <View style={{ alignItems: 'center', marginVertical: 8 }}>
        <View style={{
          backgroundColor: isDarkMode ? 'rgba(25,40,55,0.92)' : 'rgba(225,230,236,0.92)',
          paddingHorizontal: 12,
          paddingVertical: 5,
          borderRadius: 8,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 0.5 },
          shadowOpacity: 0.08,
          shadowRadius: 2,
          elevation: 1,
        }}>
          <Text style={{
            fontSize: 11.5,
            color: isDarkMode ? 'rgba(210,220,230,0.85)' : '#5f6769',
            fontFamily: 'Roboto-Medium',
            letterSpacing: 0.1,
          }}>
            {displayDate}
          </Text>
        </View>
      </View>
    );
  }, [isDarkMode, getDateLabel]);

  // In inverted FlatList: index 0 = newest (bottom), last = oldest (top)
  // We render the badge AFTER the message item in JSX → appears ABOVE in inverted view
  // Show badge when this message's date differs from the next item (older) — meaning
  // this is the LAST message of its date group when scrolling up
  const shouldShowDateAbove = useCallback((msg, index, messagesArray) => {
    const dateKey = getMessageDateKey(msg);
    // Always show for the oldest message (top of chat)
    if (index === messagesArray.length - 1) return dateKey;
    const olderDateKey = getMessageDateKey(messagesArray[index + 1]);
    if (dateKey !== olderDateKey) return dateKey;
    return null;
  }, [getMessageDateKey]);

  const highlightSearchText = (textToHighlight) => {
    if (!isSearching || !search.trim()) return textToHighlight;
    const searchQuery = search.trim();
    const regex = new RegExp(`(${searchQuery})`, 'gi');
    const parts = (textToHighlight || "").split(regex);
    return parts.map((part, i) => 
      part.toLowerCase() === searchQuery.toLowerCase() 
        ? <Text key={i} style={{ backgroundColor: '#FFEB3B', color: '#000', fontWeight: '600' }}>{part}</Text> 
        : part
    );
  };

  const decodeHtmlEntities = (value = '') => {
    return String(value)
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'");
  };

  const sanitizeRichMessage = useCallback((rawValue) => {
    let safe = String(rawValue ?? '');

    // Strip high-risk tags and inline event handlers.
    safe = safe
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
      .replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, '')
      .replace(/<object[\s\S]*?>[\s\S]*?<\/object>/gi, '')
      .replace(/<embed[\s\S]*?>[\s\S]*?<\/embed>/gi, '')
      .replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/javascript\s*:/gi, '');

    // Preserve only safe formatting semantics by converting allowed tags to lightweight inline markers.
    safe = safe
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
      .replace(/<p[^>]*>/gi, '')
      .replace(/<\/p>/gi, '\n')
      .replace(/<strong[^>]*>|<b[^>]*>/gi, '**')
      .replace(/<\/strong>|<\/b>/gi, '**')
      .replace(/<em[^>]*>|<i[^>]*>/gi, '*')
      .replace(/<\/em>|<\/i>/gi, '*')
      .replace(/<u[^>]*>/gi, '++')
      .replace(/<\/u>/gi, '++')
      .replace(/<code[^>]*>/gi, '`')
      .replace(/<\/code>/gi, '`')
      .replace(/<ul[^>]*>|<\/ul>|<ol[^>]*>|<\/ol>/gi, '')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<\/li>/gi, '\n')
      .replace(/<a\b[^>]*href\s*=\s*("|')([^"']+)("|')[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q1, href, _q2, label) => {
        const cleanedLabel = String(label || '').replace(/<[^>]+>/g, '').trim() || href;
        return `[${cleanedLabel}](${href})`;
      })
      .replace(/<[^>]+>/g, '');

    safe = decodeHtmlEntities(safe)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\u00A0/g, ' ')
      .replace(/\n{4,}/g, '\n\n\n');

    return safe;
  }, []);

  const parseInlineTokens = useCallback((line = '') => {
    const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+|www\.[^\s)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|\+\+([^+]+)\+\+|(https?:\/\/[^\s]+|www\.[^\s]+)/g;
    const tokens = [];
    let cursor = 0;
    let match;

    while ((match = pattern.exec(line)) !== null) {
      if (match.index > cursor) {
        tokens.push({ type: 'text', text: line.slice(cursor, match.index) });
      }

      if (match[1] && match[2]) {
        tokens.push({ type: 'link', text: match[1], href: match[2] });
      } else if (match[3]) {
        tokens.push({ type: 'code', text: match[3] });
      } else if (match[4]) {
        tokens.push({ type: 'bold', text: match[4] });
      } else if (match[5]) {
        tokens.push({ type: 'bold', text: match[5] });
      } else if (match[6]) {
        tokens.push({ type: 'italic', text: match[6] });
      } else if (match[7]) {
        tokens.push({ type: 'italic', text: match[7] });
      } else if (match[8]) {
        tokens.push({ type: 'underline', text: match[8] });
      } else if (match[9]) {
        tokens.push({ type: 'link', text: match[9], href: match[9] });
      }

      cursor = match.index + match[0].length;
    }

    if (cursor < line.length) {
      tokens.push({ type: 'text', text: line.slice(cursor) });
    }

    return tokens;
  }, []);

  const getParsedRichMessage = useCallback((rawValue) => {
    const cacheKey = String(rawValue ?? '');
    if (richParseCacheRef.current.has(cacheKey)) {
      return richParseCacheRef.current.get(cacheKey);
    }

    const safeText = sanitizeRichMessage(cacheKey);
    const normalizedLines = safeText.split('\n');
    const lines = normalizedLines.map((line) => parseInlineTokens(line));
    const shouldCollapse = safeText.length > RICH_TEXT_CHAR_LIMIT || normalizedLines.length > RICH_TEXT_COLLAPSED_LINES;

    const parsed = { safeText, lines, shouldCollapse };

    if (richParseCacheRef.current.size >= RICH_PARSE_CACHE_LIMIT) {
      const firstKey = richParseCacheRef.current.keys().next().value;
      if (firstKey != null) richParseCacheRef.current.delete(firstKey);
    }
    richParseCacheRef.current.set(cacheKey, parsed);
    return parsed;
  }, [parseInlineTokens, sanitizeRichMessage]);

  const normalizeLink = (rawLink = '') => {
    const value = String(rawLink || '').trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    if (/^www\./i.test(value)) return `https://${value}`;
    return value;
  };

  const handleOpenLink = useCallback(async (rawLink) => {
    try {
      const next = normalizeLink(rawLink);
      if (!next) return;
      const canOpen = await Linking.canOpenURL(next);
      if (!canOpen) return;
      await Linking.openURL(next);
    } catch (error) {
      console.warn('Unable to open link', error?.message || error);
    }
  }, []);

  const toggleReadMore = useCallback((messageKey) => {
    if (!messageKey) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedRichMessages((prev) => ({
      ...prev,
      [messageKey]: !prev[messageKey],
    }));
  }, []);

  // Helper: split a text string on @mention boundaries for highlighting
  const renderTextWithMentions = (textStr, mentions, baseColor, mentionColor, keyPrefix) => {
    if (!mentions || mentions.length === 0 || !textStr) {
      return <Text style={{ color: baseColor }}>{textStr}</Text>;
    }
    // Build a set of mentioned display names
    const mentionNames = mentions
      .filter((m) => m.displayName)
      .map((m) => m.displayName);
    if (mentionNames.length === 0) {
      return <Text style={{ color: baseColor }}>{textStr}</Text>;
    }
    // Escape regex special chars and build pattern
    const escaped = mentionNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(`(@(?:${escaped.join('|')}))`, 'g');
    const parts = textStr.split(pattern);
    if (parts.length <= 1) {
      return <Text style={{ color: baseColor }}>{textStr}</Text>;
    }
    return parts.map((part, i) => {
      if (pattern.test(part)) {
        // Reset regex lastIndex after test
        pattern.lastIndex = 0;
        return (
          <Text key={`${keyPrefix}_m${i}`} style={{ color: mentionColor, fontFamily: 'Roboto-SemiBold' }}>
            {part}
          </Text>
        );
      }
      pattern.lastIndex = 0;
      return <Text key={`${keyPrefix}_t${i}`} style={{ color: baseColor }}>{part}</Text>;
    });
  };

  const renderRichMessageText = (msg, isMyMessage, messageKey) => {
    const parsed = getParsedRichMessage(msg?.text || '');
    const isExpanded = Boolean(expandedRichMessages[messageKey]);
    const measuredLineCount = Number(richMessageLineCounts[messageKey] || 0);
    const showReadMore = measuredLineCount > RICH_TEXT_COLLAPSED_LINES;

    const baseColor = isMyMessage ? '#FFFFFF' : theme.colors.primaryTextColor;
    const linkColor = isMyMessage ? '#D8ECFF' : theme.colors.themeColor;
    const mentionColor = isMyMessage ? '#D8ECFF' : '#1DA1F2';
    const msgMentions = msg?.mentions || msg?.payload?.mentions;

    const handleMeasureLayout = (event) => {
      const lineCount = event?.nativeEvent?.lines?.length || 0;
      setRichMessageLineCounts((prev) => {
        if (prev[messageKey] === lineCount) return prev;
        return { ...prev, [messageKey]: lineCount };
      });
    };

    const renderInlineTokens = () => (
      parsed.lines.map((lineTokens, lineIndex) => (
        <Text key={`line_${messageKey}_${lineIndex}`}>
          {(lineTokens.length === 0 ? [{ type: 'text', text: ' ' }] : lineTokens).map((token, tokenIndex) => {
            const key = `token_${messageKey}_${lineIndex}_${tokenIndex}`;
            if (token.type === 'link') {
              return (
                <Text
                  key={key}
                  onPress={() => handleOpenLink(token.href)}
                  style={{
                    color: linkColor,
                    textDecorationLine: 'underline',
                    fontFamily: 'Roboto-Medium',
                  }}
                >
                  {token.text}
                </Text>
              );
            }
            if (token.type === 'code') {
              return (
                <Text
                  key={key}
                  style={{
                    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                    backgroundColor: isMyMessage ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.09)',
                    color: baseColor,
                  }}
                >
                  {token.text}
                </Text>
              );
            }
            if (token.type === 'bold') {
              return (
                <Text key={key} style={{ fontFamily: 'Roboto-SemiBold', color: baseColor }}>
                  {token.text}
                </Text>
              );
            }
            if (token.type === 'italic') {
              return (
                <Text key={key} style={{ fontFamily: 'Roboto-Regular', fontStyle: 'italic', color: baseColor }}>
                  {token.text}
                </Text>
              );
            }
            if (token.type === 'underline') {
              return (
                <Text key={key} style={{ textDecorationLine: 'underline', color: baseColor }}>
                  {token.text}
                </Text>
              );
            }
            return (
              <Text key={key} style={{ color: baseColor }}>
                {msgMentions ? renderTextWithMentions(token.text, msgMentions, baseColor, mentionColor, key) : token.text}
              </Text>
            );
          })}
          {lineIndex < parsed.lines.length - 1 ? '\n' : ''}
        </Text>
      ))
    );

    return (
      <View>
        <Text
          onTextLayout={handleMeasureLayout}
          style={{
            position: 'absolute',
            opacity: 0,
            zIndex: -1,
            fontSize: 14,
            color: baseColor,
            fontFamily: 'Roboto-Regular',
            lineHeight: 18,
          }}
        >
          {renderInlineTokens()}
        </Text>

        <Text
          numberOfLines={!isExpanded && showReadMore ? RICH_TEXT_COLLAPSED_LINES : undefined}
          ellipsizeMode="tail"
          style={{
            fontSize: 14,
            color: baseColor,
            fontFamily: 'Roboto-Regular',
            lineHeight: 18,
          }}
        >
          {renderInlineTokens()}
        </Text>

        {showReadMore && (
          <TouchableOpacity
            onPress={() => toggleReadMore(messageKey)}
            activeOpacity={0.75}
            style={{ alignSelf: 'flex-start', marginTop: 6, paddingVertical: 2, paddingRight: 8 }}
            accessibilityRole="button"
            accessibilityLabel={isExpanded ? 'Read less message' : 'Read more message'}
          >
            <Text
              style={{
                fontSize: 12,
                fontFamily: 'Roboto-Medium',
                color: isMyMessage ? '#D8ECFF' : theme.colors.themeColor,
                textDecorationLine: 'underline',
              }}
            >
              {isExpanded ? 'Read Less' : 'Read More'}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  const renderMediaOverlay = ({ msg, status, progress, isVideo = false }) => {
    const mediaInfo = resolveMediaInfo(msg);
    const isDownloading = status === MEDIA_DOWNLOAD_STATUS.DOWNLOADING;
    const isFailed = status === MEDIA_DOWNLOAD_STATUS.FAILED;

    return (
      <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
        {/* WhatsApp-style download button */}
        {isDownloading ? (
          <View style={{ alignItems: 'center' }}>
            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator size="small" color="#fff" />
            </View>
            <View style={{ backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, marginTop: 6 }}>
              <Text style={{ color: '#fff', fontSize: 10, fontFamily: 'Roboto-Medium' }}>
                {Math.round(progress * 100)}%
              </Text>
            </View>
          </View>
        ) : (
          <View style={{ alignItems: 'center' }}>
            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name={isFailed ? 'refresh' : 'arrow-down'} size={22} color="#fff" />
            </View>
            <View style={{ backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, marginTop: 6 }}>
              <Text style={{ color: '#fff', fontSize: 10, fontFamily: 'Roboto-Medium' }}>
                {mediaInfo.sizeLabel}
              </Text>
            </View>
          </View>
        )}
      </View>
    );
  };

  const renderMediaTimeOverlay = (msg, isMyMessage = false) => {
    const edited = Boolean(msg?.isEdited || msg?.editedAt || msg?.edited);

    const renderTick = () => {
      if (!isMyMessage) return null;

      if (msg?.status === 'sending') {
        return <ActivityIndicator size={8} color="rgba(255,255,255,0.85)" style={{ marginLeft: 3 }} />;
      }
      if (msg?.status === 'uploaded') {
        return <Ionicons name="checkmark" size={11} color="rgba(255,255,255,0.9)" style={{ marginLeft: 3 }} />;
      }
      if (msg?.status === 'sent') {
        return <Ionicons name="checkmark" size={11} color="rgba(255,255,255,0.9)" style={{ marginLeft: 3 }} />;
      }
      if (msg?.status === 'delivered') {
        return <Ionicons name="checkmark-done" size={11} color="rgba(255,255,255,0.92)" style={{ marginLeft: 3 }} />;
      }
      if (msg?.status === 'seen' || msg?.status === 'read') {
        return <Ionicons name="checkmark-done" size={11} color="#67B7FF" style={{ marginLeft: 3 }} />;
      }
      if (msg?.status === 'failed') {
        return <Ionicons name="alert-circle" size={11} color="#FF8A80" style={{ marginLeft: 3 }} />;
      }
      return null;
    };

    return (
    <View
      style={{
        position: 'absolute',
        right: 8,
        bottom: 7,
        backgroundColor: 'rgba(0,0,0,0.4)',
        borderRadius: 7,
        paddingHorizontal: 6,
        paddingVertical: 2,
        flexDirection: 'row',
        alignItems: 'center',
      }}
    >
      {edited && (
        <Text style={{ color: 'rgba(255,255,255,0.9)', fontSize: 9, marginRight: 3, fontFamily: 'Roboto-Regular' }}>
          edited
        </Text>
      )}
      <Text style={{ color: '#fff', fontSize: 9, fontFamily: 'Roboto-Medium' }}>{msg?.time}</Text>
      {renderTick()}
    </View>
    );
  };

  const renderImageMessage = (msg, isMyMessage, progress, messageKey, downloadState) => {
    const imageStyle = getAdaptiveMediaStyle(msg, 200, 220);
    const sendingProgress = resolveUploadProgress(msg);
    const downloaded = isMediaDownloaded(msg);
    const downloadedUri = downloaded ? resolveDownloadedUri(msg) : null;
    const status = normalizeDownloadStatus(downloadState?.status);
    const mediaInfo = resolveMediaInfo(msg);

    const imageSource = isMyMessage
      ? (msg.localUri || resolveCachedThumbnailUrl(msg) || msg.mediaUrl)
      : (downloadedUri || resolveCachedThumbnailUrl(msg));
    const shouldRenderThumbnail = Boolean(imageSource);

    const animationStyle = getMediaAnimationStyle(messageKey, !isMyMessage && shouldRenderThumbnail);

    if (!imageSource) {
      return (
        <TouchableOpacity
          onPress={() => !isMyMessage && handleDownloadWithPersistence(msg)}
          style={[imageStyle, { backgroundColor: theme.colors.menuBackground, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.colors.borderColor }]}
          activeOpacity={0.85}
        >
          <Ionicons name="image-outline" size={34} color={theme.colors.placeHolderTextColor} />
          {!isMyMessage && (
            <Text style={{ fontSize: 11, color: theme.colors.placeHolderTextColor, marginTop: 6 }}>
              {mediaInfo.sizeLabel}
            </Text>
          )}
        </TouchableOpacity>
      );
    }

    return (
      <TouchableOpacity
        onPress={() => {
          if (isMyMessage || downloaded) {
            openMediaViewer(msg, downloadedUri || imageSource, 'image');
            return;
          }
          if (!isConnected) return;
          handleDownloadWithPersistence(msg);
        }}
        onLongPress={() => {
          if (!downloaded || !downloadedUri) return;
          Alert.alert('Image Options', 'Choose an action', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Share', onPress: () => handleShareMedia(msg) },
            { text: 'Save to Gallery', onPress: () => handleSaveToGallery(msg) },
            { text: 'Delete', onPress: () => handleDeleteMedia(msg), style: 'destructive' },
          ]);
        }}
        activeOpacity={0.9}
        style={{ borderRadius: 12, overflow: 'hidden' }}
      >
        <Animated.View style={animationStyle}>
          {shouldRenderThumbnail ? (
            <Image source={{ uri: imageSource }} style={imageStyle} resizeMode="cover" />
          ) : (
            <View style={[imageStyle, { backgroundColor: theme.colors.menuBackground, alignItems: 'center', justifyContent: 'center' }]}>
              <Ionicons name="image-outline" size={30} color={theme.colors.placeHolderTextColor} />
            </View>
          )}
        </Animated.View>

        {isMyMessage && msg.status === 'sending' && (
          <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.32)', alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size="small" color="#fff" />
            <Text style={{ color: '#fff', fontSize: 11, marginTop: 4 }}>{Math.round((sendingProgress || 0.05) * 100)}%</Text>
          </View>
        )}

        {!isMyMessage && !downloaded && renderMediaOverlay({ msg, status, progress, isVideo: false })}
        {renderMediaTimeOverlay(msg, isMyMessage)}
      </TouchableOpacity>
    );
  };

  const renderVideoMessage = (msg, isMyMessage, progress, messageKey, downloadState) => {
    const videoStyle = getAdaptiveMediaStyle(msg, 220, 140);
    const downloaded = isMediaDownloaded(msg);
    const downloadedUri = downloaded ? resolveDownloadedUri(msg) : null;
    const status = normalizeDownloadStatus(downloadState?.status);
    const sendingProgress = resolveUploadProgress(msg);
    const thumbnailSource = resolveCachedThumbnailUrl(msg);
    const shouldRenderThumbnail = Boolean(thumbnailSource || downloaded);
    const animationStyle = getMediaAnimationStyle(`${messageKey}_video`, !isMyMessage && shouldRenderThumbnail);

    return (
      <TouchableOpacity
        onPress={() => {
          if (isMyMessage || downloaded) {
            openMediaViewer(msg, downloadedUri || msg.mediaUrl || msg.previewUrl, 'video');
            return;
          }
          if (!isConnected) return;
          handleDownloadWithPersistence(msg);
        }}
        onLongPress={() => {
          if (!downloaded || !downloadedUri) return;
          Alert.alert('Video Options', 'Choose an action', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Share', onPress: () => handleShareMedia(msg) },
            { text: 'Save to Gallery', onPress: () => handleSaveToGallery(msg) },
            { text: 'Delete', onPress: () => handleDeleteMedia(msg), style: 'destructive' },
          ]);
        }}
        activeOpacity={0.9}
        style={[videoStyle, { overflow: 'hidden', backgroundColor: '#000' }]}
      >
        <Animated.View style={animationStyle}>
          {thumbnailSource && shouldRenderThumbnail ? (
            <Image source={{ uri: thumbnailSource }} style={videoStyle} resizeMode="cover" />
          ) : (
            <View style={[videoStyle, { alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.menuBackground }]}>
              <Ionicons name="videocam-outline" size={34} color={theme.colors.placeHolderTextColor} />
            </View>
          )}
        </Animated.View>

        {(isMyMessage || downloaded) && (
          <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ backgroundColor: 'rgba(0,0,0,0.5)', width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' }}>
              {isMyMessage && msg.status === 'sending' ? (
                <>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={{ color: '#fff', fontSize: 9, marginTop: 3 }}>{Math.round((sendingProgress || 0.05) * 100)}%</Text>
                </>
              ) : (
                <Ionicons name="play" size={26} color="#fff" />
              )}
            </View>
          </View>
        )}

        {!isMyMessage && !downloaded && renderMediaOverlay({ msg, status, progress, isVideo: true })}
        {renderMediaTimeOverlay(msg, isMyMessage)}
      </TouchableOpacity>
    );
  };

  const renderAudioMessage = (msg, isMyMessage, progress, downloadState) => {
    const dlStatus = normalizeDownloadStatus(downloadState?.status);
    const downloaded = isMediaDownloaded(msg);
    const mediaInfo = resolveMediaInfo(msg);
    const msgKey = msg?.serverMessageId || msg?.id || msg?.tempId;
    const isThisPlaying = playingAudioId === msgKey;
    const isPlaying = isThisPlaying && audioPlaybackStatus.isPlaying;

    // Duration: from playback status (accurate) or from message meta
    const totalMs = (isThisPlaying && audioPlaybackStatus.durationMillis > 0)
      ? audioPlaybackStatus.durationMillis
      : Number(msg?.duration || msg?.mediaMeta?.duration || 0) * 1000;
    const positionMs = isThisPlaying ? (audioPlaybackStatus.positionMillis || 0) : 0;
    const seekRatio = totalMs > 0 ? positionMs / totalMs : 0;

    const formatMs = (ms) => {
      const sec = Math.floor(ms / 1000);
      return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    };

    const posLabel = isThisPlaying ? formatMs(positionMs) : '0:00';
    const durLabel = totalMs > 0 ? formatMs(totalMs) : '--:--';

    const isDownloading = dlStatus === MEDIA_DOWNLOAD_STATUS.DOWNLOADING;
    const canPlay = isMyMessage || downloaded;
    const bubbleColor = isMyMessage
      ? (chatColor || '#1DA1F2')
      : (isDarkMode ? 'rgba(30, 45, 60, 0.95)' : '#fff');
    const textColor = isMyMessage ? '#fff' : theme.colors.primaryTextColor;
    const subColor = isMyMessage ? 'rgba(255,255,255,0.65)' : theme.colors.placeHolderTextColor;
    const trackBg = isMyMessage ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.12)';
    const trackFill = isMyMessage ? '#fff' : theme.colors.themeColor;
    const iconBg = isMyMessage ? 'rgba(255,255,255,0.2)' : (theme.colors.themeColor + '22');
    const iconColor = isMyMessage ? '#fff' : theme.colors.themeColor;

    const handleTap = () => {
      if (msg.status === 'sending') return;
      if (canPlay) {
        handlePlayAudio(msg);
        return;
      }
      if (isDownloading) return;
      if (!isConnected) return;
      handleDownloadWithPersistence(msg);
    };

    return (
      <View style={{
        width: Math.min(MAX_MEDIA_BUBBLE_WIDTH, 280),
        borderRadius: 14,
        paddingVertical: 8,
        paddingHorizontal: 10,
        marginBottom: 4,
        overflow: 'hidden',
      }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {/* Play/Pause/Download button */}
          <TouchableOpacity onPress={handleTap} activeOpacity={0.7}
            style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: iconBg, alignItems: 'center', justifyContent: 'center' }}>
            {isDownloading || msg.status === 'sending'
              ? <ActivityIndicator size="small" color={iconColor} />
              : <Ionicons
                  name={canPlay ? (isPlaying ? 'pause' : 'play') : 'cloud-download'}
                  size={canPlay ? 22 : 18}
                  color={iconColor}
                  style={canPlay && !isPlaying ? { marginLeft: 2 } : undefined}
                />
            }
          </TouchableOpacity>

          {/* Progress bar + time */}
          <AudioSeekBar
            isThisPlaying={isThisPlaying}
            isDownloading={isDownloading}
            totalMs={totalMs}
            seekRatio={seekRatio}
            progress={progress}
            trackBg={trackBg}
            trackFill={trackFill}
            subColor={subColor}
            posLabel={posLabel}
            durLabel={durLabel}
            dlStatus={dlStatus}
            onSeek={handleSeekAudio}
          />
        </View>
        {renderMediaTimeOverlay(msg, isMyMessage)}
      </View>
    );
  };

  const renderFileMessage = (msg, isMyMessage, progress, downloadState) => {
    const dlStatus = normalizeDownloadStatus(downloadState?.status);
    const downloaded = isMediaDownloaded(msg);
    const sendingProgress = resolveUploadProgress(msg);
    const mediaInfo = resolveMediaInfo(msg);
    const mime = getMimeType(msg);
    const fileName = mediaInfo.fileName || 'Document';

    // If this "file" is actually audio, render as audio player
    if (isAudioMime(mime) || isAudioByExtension(fileName)) {
      return renderAudioMessage(msg, isMyMessage, progress, downloadState);
    }

    const isDownloading = dlStatus === MEDIA_DOWNLOAD_STATUS.DOWNLOADING;

    // File icon based on extension
    const ext = getExtFromName(fileName);
    let fileIcon = 'document-text';
    let fileIconColor = theme.colors.themeColor;
    if (ext === 'pdf') { fileIcon = 'document-text'; fileIconColor = '#E53935'; }
    else if (['doc', 'docx'].includes(ext)) { fileIcon = 'document-text'; fileIconColor = '#1565C0'; }
    else if (['xls', 'xlsx'].includes(ext)) { fileIcon = 'document-text'; fileIconColor = '#2E7D32'; }
    else if (['ppt', 'pptx'].includes(ext)) { fileIcon = 'document-text'; fileIconColor = '#E65100'; }
    else if (['zip', 'rar', '7z'].includes(ext)) { fileIcon = 'file-tray-stacked'; fileIconColor = '#6D4C41'; }

    const handleFileTap = async () => {
      if (msg.status === 'sending') return;

      if (isMyMessage || downloaded) {
        await handleShareMedia(msg);
        return;
      }
      if (!isConnected) {
        Alert.alert('Offline', 'Connect to internet to download this file.');
        return;
      }
      handleDownloadWithPersistence(msg);
    };

    const senderReady = isMyMessage && msg.status !== 'sending' && msg.status !== 'failed';
    const fileReady = downloaded || senderReady;

    return (
      <TouchableOpacity
        onPress={handleFileTap}
        onLongPress={() => {
          if (!fileReady) return;
          Alert.alert('File Options', 'Choose an action', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Share', onPress: () => openFileWithSharing(resolveDownloadedUri(msg) || msg?.localUri || '', msg) },
            { text: 'Delete', onPress: () => handleDeleteMedia(msg), style: 'destructive' },
          ]);
        }}
        style={{
          width: Math.min(320, MAX_MEDIA_BUBBLE_WIDTH),
          borderRadius: 12,
          marginBottom: 4,
          padding: 12,
          backgroundColor: theme.colors.menuBackground,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          borderWidth: 0.5,
          borderColor: theme.colors.borderColor,
        }}
        activeOpacity={0.85}
      >
        <View style={{ width: 42, height: 42, borderRadius: 10, backgroundColor: fileIconColor + '20', alignItems: 'center', justifyContent: 'center' }}>
          {isDownloading || msg.status === 'sending'
            ? <ActivityIndicator size="small" color={fileIconColor} />
            : <Ionicons name={fileIcon} size={24} color={fileIconColor} />}
        </View>

        <View style={{ flex: 1 }}>
          <Text style={{ color: theme.colors.primaryTextColor, fontSize: 13, fontFamily: 'Roboto-Medium' }} numberOfLines={1}>
            {fileName}
          </Text>

          {/* Download progress bar */}
          {isDownloading && (
            <View style={{ height: 3, borderRadius: 3, backgroundColor: 'rgba(0,0,0,0.08)', marginTop: 4, marginBottom: 2, overflow: 'hidden' }}>
              <View style={{ width: `${Math.round(Math.max(5, progress * 100))}%`, height: 3, borderRadius: 3, backgroundColor: fileIconColor }} />
            </View>
          )}

          <Text style={{ color: theme.colors.placeHolderTextColor, fontSize: 10, marginTop: 2 }}>
            {msg.status === 'sending'
              ? `Uploading ${Math.round((sendingProgress || 0.05) * 100)}%`
              : msg.status === 'failed'
                ? 'Failed • Tap to retry'
                : isMyMessage
                  ? `${mediaInfo.sizeLabel} • Tap to open`
                  : dlStatus === MEDIA_DOWNLOAD_STATUS.FAILED
                    ? 'Download failed • Tap to retry'
                    : isDownloading
                      ? `${Math.round(progress * 100)}% downloading...`
                      : dlStatus === MEDIA_DOWNLOAD_STATUS.DOWNLOADED
                        ? `${mediaInfo.sizeLabel} • Tap to open`
                        : `${mediaInfo.sizeLabel} • Tap to download`}
          </Text>
          {!isConnected && !downloaded && !isMyMessage && (
            <Text style={{ color: '#D97706', fontSize: 10, marginTop: 2 }}>Offline</Text>
          )}
        </View>

        {!isMyMessage && !downloaded && dlStatus === MEDIA_DOWNLOAD_STATUS.NOT_DOWNLOADED && (
          <Ionicons name="cloud-download" size={22} color={fileIconColor} />
        )}
      </TouchableOpacity>
    );
  };

  const renderLocationMessage = (msg, isMyMessage) => {
    // Extract location data from ALL possible sources — bulletproof chain
    const meta = msg?.mediaMeta || msg?.payload?.mediaMeta || {};
    let latitude = Number(meta?.latitude || msg?.payload?.latitude || 0);
    let longitude = Number(meta?.longitude || msg?.payload?.longitude || 0);

    // Last resort: parse coordinates from mediaUrl (e.g. "https://maps.google.com/?q=27.17,76.84")
    if (latitude === 0 && longitude === 0) {
      const url = msg?.mediaUrl || msg?.previewUrl || meta?.mapPreviewUrl || msg?.payload?.mediaUrl || '';
      const match = url.match(/[?&]q=([-\d.]+),([-\d.]+)/);
      if (match) {
        latitude = Number(match[1]) || 0;
        longitude = Number(match[2]) || 0;
      }
    }

    const address = meta?.address || msg?.payload?.address || (msg?.text !== 'Shared location' && msg?.text !== 'Location' ? msg?.text : '') || 'Shared location';
    const mapPreviewUrl = meta?.mapPreviewUrl || msg?.mediaUrl || '';

    return (
      <LocationBubble
        latitude={latitude}
        longitude={longitude}
        address={address}
        mapPreviewUrl={mapPreviewUrl}
        isMyMessage={isMyMessage}
        time={msg?.time}
        status={msg?.status}
        isEdited={Boolean(msg?.isEdited || msg?.editedAt)}
        themeColors={theme.colors}
      />
    );
  };

  const renderContactMessage = (msg, isMyMessage) => {
    // Support both old format (mediaMeta.contactName) and new format (mediaMeta.fullName / contact)
    const meta = msg?.mediaMeta || msg?.payload?.mediaMeta || msg?.payload?.contact || {};
    const contact = msg?.payload?.contact || meta;
    const contactName = contact.fullName || meta.contactName || msg?.text || 'Contact';
    const countryCode = contact.countryCode || '';
    const mobileNumber = contact.mobileNumber || meta.phoneNumber || '';
    const displayPhone = countryCode ? `${countryCode} ${mobileNumber}` : mobileNumber;
    const profileImage = contact.profileImage || meta.avatar || msg?.mediaUrl || '';
    const isRegistered = contact.isRegistered === true;
    const contactUserId = contact.userId || null;

    const textColor = isMyMessage ? '#fff' : theme.colors.primaryTextColor;
    const subColor = isMyMessage ? 'rgba(255,255,255,0.7)' : theme.colors.placeHolderTextColor;
    const dividerColor = isMyMessage ? 'rgba(255,255,255,0.18)' : theme.colors.borderColor;
    const btnColor = isMyMessage ? '#fff' : theme.colors.themeColor;

    const openContactDetail = () => {
      setContactViewer({ visible: true, data: { ...contact, fullName: contactName, countryCode, mobileNumber, profileImage, isRegistered, userId: contactUserId } });
    };

    const handleMessageContact = () => {
      if (!isRegistered || !contactUserId) return;
      // Navigate to chat with this registered user
      navigation.navigate('ChatScreen', {
        user: {
          _id: contactUserId,
          userId: contactUserId,
          id: contactUserId,
          name: contactName,
          fullName: contactName,
          profilePicture: profileImage,
        },
        chatId: null,
        hasExistingChat: false,
      });
    };

    const handleSaveContact = () => {
      Alert.alert(
        'Save Contact',
        `Do you want to save ${contactName} to your contacts?`,
        [
          {
            text: 'Cancel',
            style: 'cancel',
          },
          {
            text: 'OK',
            onPress: async () => {
              try {
                let perm = await Contacts.getPermissionsAsync();
                if (perm.status !== 'granted') {
                  perm = await Contacts.requestPermissionsAsync();
                  if (perm.status !== 'granted') return;
                }
                const contactData = {
                  firstName: contactName,
                  phoneNumbers: [{ label: 'mobile', number: countryCode ? `${countryCode}${mobileNumber}` : mobileNumber }],
                };
                await Contacts.addContactAsync(contactData);
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                Alert.alert('Saved', `${contactName} has been saved to your contacts.`);
              } catch (error) {
                console.error('save contact error', error);
                Alert.alert('Error', 'Unable to save contact.');
              }
            },
          },
        ],
        { cancelable: true }
      );
    };

    return (
      <View style={{ width: Math.min(280, MAX_MEDIA_BUBBLE_WIDTH), borderRadius: 12, overflow: 'hidden' }}>
        {/* Contact card top — tappable */}
        <Pressable onPress={openContactDetail} style={{ flexDirection: 'row', alignItems: 'center', padding: 10 }}>
          {profileImage ? (
            <Image source={{ uri: profileImage }} style={{ width: 46, height: 46, borderRadius: 23 }} />
          ) : (
            <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: isMyMessage ? 'rgba(255,255,255,0.2)' : (theme.colors.themeColor + '20'), alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="person" size={24} color={isMyMessage ? '#fff' : theme.colors.themeColor} />
            </View>
          )}
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={{ color: textColor, fontFamily: 'Roboto-SemiBold', fontSize: 14 }} numberOfLines={1}>
              {contactName}
            </Text>
            <Text style={{ color: subColor, fontSize: 12, marginTop: 1 }} numberOfLines={1}>
              {displayPhone}
            </Text>
            {isRegistered && (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#25D366', marginRight: 4 }} />
                <Text style={{ color: isMyMessage ? 'rgba(255,255,255,0.8)' : '#25D366', fontSize: 10, fontFamily: 'Roboto-Medium' }}>
                  On VibeConnect
                </Text>
              </View>
            )}
          </View>
        </Pressable>

        {/* Divider + Action buttons (WhatsApp style) */}
        <View style={{ height: 0.5, backgroundColor: dividerColor }} />
        <View style={{ flexDirection: 'row' }}>
          {isRegistered && contactUserId && (
            <>
              <Pressable
                onPress={handleMessageContact}
                style={{ flex: 1, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' }}
              >
                <Text style={{ color: btnColor, fontFamily: 'Roboto-Medium', fontSize: 13 }}>Message</Text>
              </Pressable>
              <View style={{ width: 0.5, backgroundColor: dividerColor }} />
            </>
          )}
          <Pressable
            onPress={handleSaveContact}
            style={{ flex: 1, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' }}
          >
            <Text style={{ color: btnColor, fontFamily: 'Roboto-Medium', fontSize: 13 }}>Save Contact</Text>
          </Pressable>
        </View>
        {renderMediaTimeOverlay(msg, isMyMessage)}
      </View>
    );
  };

  // Main message renderer
  const renderChatsItem = useCallback(({ item: msg, index }) => {
    const messageKey = getMessageKey(msg);
    const isSelected = selectedMessage.some(sel => sameId(sel, messageKey));
    const isMyMessage = msg?.senderType
      ? msg.senderType === 'self'
      : sameId(msg.senderId, currentUserId);
    const highlightedId = searchResults[currentSearchIndex]?.serverMessageId || searchResults[currentSearchIndex]?.id || searchResults[currentSearchIndex]?.tempId;
    const isHighlighted = isSearching && searchResults.length > 0 && currentSearchIndex >= 0 && sameId(highlightedId, messageKey);
    
    const progress = resolveMediaProgress(msg);
    const downloadState = resolveMediaState(msg);
    
    const deletedFor = msg?.deletedFor;
    const isDeletedForCurrentUser = Array.isArray(deletedFor)
      ? deletedFor.some((id) => sameId(id, currentUserId))
      : (typeof deletedFor === 'string' ? (deletedFor.toLowerCase() === 'everyone' || sameId(deletedFor, currentUserId)) : false);
    const isDeletedMessage = Boolean(msg?.isDeleted) || isDeletedForCurrentUser;
    const isSystemMessage = (msg?.type === 'system' || msg?.messageType === 'system') && !isDeletedMessage;
    const deletedText = msg?.placeholderText || (isMyMessage ? 'You deleted this message' : 'This message was deleted');

    const isImage = msg.type === 'image' || msg.mediaType === 'image' || msg.type === 'photo';
    const isVideo = msg.type === 'video' || msg.mediaType === 'video';
    const isAudio = msg.type === 'audio' || msg.mediaType === 'audio';
    const isFile = msg.type === 'file' || msg.type === 'document';
    const isLocation = msg.type === 'location' || msg.mediaType === 'location';
    const isContact = msg.type === 'contact' || msg.mediaType === 'contact';
    const isMediaMessage = isImage || isVideo || isAudio || isFile || isLocation || isContact;
    const inlineMediaTime = !isDeletedMessage && (isImage || isVideo || isAudio || isLocation || isContact);

    const dateBadgeKey = shouldShowDateAbove(msg, index, messages);

    // ── System messages (group created, member joined/left/removed) ──
    if (isSystemMessage) {
      const systemText = msg?.text || msg?.content || '';

      // Hide "created the group" system messages — the footer already shows this
      const isCreatedMsg = /created\s+(the\s+)?group/i.test(systemText);
      if (isCreatedMsg) return null;

      // Resolve any raw user IDs in system text to actual names
      const resolvedText = systemText.replace(/\b([a-f0-9]{24})\b/g, (match) => {
        return groupMembersMap?.[match]?.fullName || match;
      });
      return (
        <React.Fragment>
          {dateBadgeKey && (
            <View style={{ alignItems: 'center', paddingVertical: 8 }}>
              <View style={{ backgroundColor: theme.colors.menuBackground, paddingHorizontal: 14, paddingVertical: 4, borderRadius: 12 }}>
                <Text style={{ fontSize: 11, color: theme.colors.placeHolderTextColor, fontFamily: 'Roboto-Medium' }}>{dateBadgeKey}</Text>
              </View>
            </View>
          )}
          <View style={{ alignItems: 'center', paddingVertical: 3, paddingHorizontal: 30 }}>
            <View style={{ backgroundColor: theme.colors.menuBackground, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 10, maxWidth: '85%' }}>
              <Text style={{ fontSize: 12, color: theme.colors.placeHolderTextColor, fontFamily: 'Roboto-Regular', textAlign: 'center' }}>
                {resolvedText}
              </Text>
            </View>
          </View>
        </React.Fragment>
      );
    }

    return (
      <React.Fragment>
        <SwipeReplyRow isMyMessage={isMyMessage} disabled={isDeletedMessage || isSystemMessage} onReply={() => startReply(msg)}>
        <Pressable
          onPress={() => {
            if (reactionMsgId) {
              setReactionMsgId(null);
              clearSelectedMessages();
              return;
            }
            if (selectedMessage.length > 0) {
              handleToggleSelectMessages(messageKey);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              return;
            }
            // Double-tap detection for quick heart react
            const now = Date.now();
            const lastTap = msg._lastTap || 0;
            msg._lastTap = now;
            if (now - lastTap < 350 && !isDeletedMessage) {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              toggleReaction(messageKey, '❤️');
            }
          }}
          onLongPress={() => {
            if (!isDeletedMessage) {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
              // Show emoji bar + select message for header toolbar
              setReactionMsgId(prev => prev === messageKey ? null : messageKey);
              if (!selectedMessage.includes(messageKey)) {
                handleToggleSelectMessages(messageKey);
              }
            }
          }}
          delayLongPress={300}
          style={{ 
            alignItems: isMyMessage ? "flex-end" : "flex-start", 
            paddingVertical: 2, 
            paddingHorizontal: 12, 
            backgroundColor: isSelected 
              ? theme.colors.themeColor + '20'
              : isHighlighted 
                ? 'rgba(255, 193, 7, 0.15)' 
                : "transparent",
          }}
        >
          <View style={{ 
            maxWidth: "80%", 
            borderRadius: 16, 
            backgroundColor: isDeletedMessage
              ? theme.colors.menuBackground
              : (isMyMessage ? chatColor : theme.colors.cardBackground), 
            borderBottomRightRadius: isMyMessage ? 4 : 16, 
            borderBottomLeftRadius: isMyMessage ? 16 : 4, 
            paddingVertical: (isMediaMessage && !msg.replyToMessageId) ? 2 : 7,
            paddingHorizontal: (isMediaMessage && !msg.replyToMessageId) ? 3 : 10,
            borderWidth: isHighlighted ? 2 : 0, 
            borderColor: '#FFC107',
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.1,
            shadowRadius: 1,
            elevation: 1,
          }}>
            
            {/* Sender name for group chats */}
            {!isMyMessage && chatData?.isGroup && (
              <Text style={{
                fontSize: 11,
                color: getUserColor?.(msg.senderId) || theme.colors.themeColor,
                fontFamily: "Roboto-Medium",
                marginBottom: 2,
              }}>
                {msg.senderName
                  || groupMembersMap?.[msg.senderId]?.fullName
                  || 'Member'}
              </Text>
            )}

            {/* Scheduled message label — only show while still pending (status==='scheduled' or 'processing') */}
            {!isDeletedMessage && isMyMessage && (msg.status === 'scheduled' || msg.status === 'processing') && msg.scheduleTimeLabel && (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 3, paddingTop: 1 }}>
                <Ionicons name="time-outline" size={13} color="rgba(255,255,255,0.65)" style={{ marginRight: 4 }} />
                <Text style={{
                  fontFamily: 'Roboto-Regular', fontSize: 11, fontStyle: 'italic',
                  color: 'rgba(255,255,255,0.65)',
                }}>Scheduled {msg.scheduleTimeLabel}</Text>
              </View>
            )}

            {/* Cancelled message label */}
            {!isDeletedMessage && msg.status === 'cancelled' && (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 3, paddingTop: 1 }}>
                <Ionicons name="close-circle" size={13} color="#FF8A80" style={{ marginRight: 4 }} />
                <Text style={{
                  fontFamily: 'Roboto-Regular', fontSize: 11, fontStyle: 'italic', color: '#FF8A80',
                }}>Cancelled</Text>
              </View>
            )}

            {/* Forwarded label — WhatsApp style */}
            {!isDeletedMessage && (msg.isForwarded || msg.forwardedFrom || msg.forwarded || msg.payload?.isForwarded || msg.payload?.forwarded) && (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 3, paddingTop: 1 }}>
                <Ionicons
                  name="arrow-redo"
                  size={14}
                  color={isMyMessage ? 'rgba(255,255,255,0.65)' : '#8696A0'}
                  style={{ marginRight: 4 }}
                />
                <Text style={{
                  fontFamily: 'Roboto-Regular',
                  fontSize: 12,
                  fontStyle: 'italic',
                  color: isMyMessage ? 'rgba(255,255,255,0.65)' : '#8696A0',
                }}>Forwarded</Text>
              </View>
            )}

            {/* Reply quote bubble */}
            {msg.replyToMessageId && !isDeletedMessage && (
              <ReplyBubble
                replyToMessageId={msg.replyToMessageId}
                replyPreviewText={msg.replyPreviewText}
                replyPreviewType={msg.replyPreviewType}
                replySenderName={msg.replySenderName}
                replySenderId={msg.replySenderId}
                currentUserId={currentUserId}
                isMyMessage={isMyMessage}
                chatColor={chatColor}
                theme={theme}
                onPress={(originalMsgId) => {
                  const idx = messages.findIndex(m =>
                    sameId(m.serverMessageId, originalMsgId) ||
                    sameId(m.id, originalMsgId) ||
                    sameId(m.tempId, originalMsgId)
                  );
                  if (idx !== -1 && flatListRef?.current) {
                    try {
                      flatListRef.current.scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 });
                    } catch {}
                  }
                }}
              />
            )}

            {/* TEXT MESSAGES */}
            {msg.type === "text" && !isDeletedMessage && (
              renderRichMessageText(msg, isMyMessage, messageKey)
            )}
            
            {/* DELETED MESSAGES */}
            {isDeletedMessage && (
              <Text style={{ 
                fontSize: 13, 
                color: theme.colors.placeHolderTextColor,
                fontFamily: "Roboto-Regular", 
                fontStyle: 'italic',
              }}>
                {deletedText}
              </Text>
            )}
  
            {/* MEDIA MESSAGES */}
            {!isDeletedMessage && isImage && renderImageMessage(msg, isMyMessage, progress, messageKey, downloadState)}
            {!isDeletedMessage && isVideo && renderVideoMessage(msg, isMyMessage, progress, messageKey, downloadState)}
            {!isDeletedMessage && isAudio && renderAudioMessage(msg, isMyMessage, progress, downloadState)}
            {!isDeletedMessage && isFile && renderFileMessage(msg, isMyMessage, progress, downloadState)}
            {!isDeletedMessage && isLocation && renderLocationMessage(msg, isMyMessage)}
            {!isDeletedMessage && isContact && renderContactMessage(msg, isMyMessage)}
  
            {/* Message Status and Timestamp */}
            <View style={{ 
              flexDirection: "row", 
              alignItems: "center", 
              justifyContent: "flex-end", 
              gap: 4,
              marginTop: (msg.type !== 'text' && !isDeletedMessage) ? 4 : 2,
            }}>
              {!inlineMediaTime && !isDeletedMessage && Boolean(msg?.isEdited || msg?.editedAt || msg?.edited) && (
                <Text style={{
                  fontSize: 9,
                  color: isMyMessage
                    ? 'rgba(255,255,255,0.55)'
                    : theme.colors.placeHolderTextColor,
                  fontFamily: "Roboto-Regular",
                  fontStyle: 'italic',
                }}>
                  edited
                </Text>
              )}
              {!inlineMediaTime && (
                <Text style={{
                  fontSize: 9,
                  color: isMyMessage
                    ? 'rgba(255,255,255,0.7)'
                    : theme.colors.placeHolderTextColor,
                  fontFamily: "Roboto-Medium"
                }}>
                  {msg.time}
                </Text>
              )}
              
              {isMyMessage && !isDeletedMessage && !inlineMediaTime && (
                <>
                  {(msg.status === "scheduled" || msg.status === "processing") && (
                    <Ionicons name="time-outline" size={12} color="rgba(255,255,255,0.7)" style={{ marginLeft: 2 }} />
                  )}
                  {msg.status === "cancelled" && (
                    <Ionicons name="close-circle" size={12} color="#FF8A80" style={{ marginLeft: 2 }} />
                  )}
                  {msg.status === "sending" && (
                    <ActivityIndicator size={8} color="rgba(255,255,255,0.7)" style={{ marginLeft: 2 }} />
                  )}
                  {msg.status === "uploaded" && (
                    <Ionicons name="checkmark" size={12} color="rgba(255,255,255,0.7)" />
                  )}
                  {msg.status === "sent" && (
                    <Ionicons name="checkmark" size={12} color="rgba(255,255,255,0.7)" />
                  )}
                  {msg.status === "delivered" && (
                    <Ionicons name="checkmark-done" size={12} color="rgba(255,255,255,0.7)" />
                  )}
                  {(msg.status === "seen" || msg.status === "read") && (
                    <Ionicons name="checkmark-done" size={12} color="#4FC3F7"/>
                  )}
                  {msg.status === "failed" && (
                    <TouchableOpacity onPress={() => resendMessage(msg)}>
                      <Ionicons name="alert-circle" size={12} color="#FF5252" />
                    </TouchableOpacity>
                  )}
                </>
              )}
            </View>

            {/* Floating emoji reaction picker — WhatsApp style (over the message) */}
            <ReactionPicker
              visible={reactionMsgId === messageKey && !isDeletedMessage}
              isMyMessage={isMyMessage}
              isDarkMode={isDarkMode}
              themeColor={theme.colors.themeColor}
              currentReactions={msg?.reactions}
              currentUserId={currentUserId}
              onSelect={(emoji) => {
                toggleReaction(messageKey, emoji);
                setReactionMsgId(null);
                clearSelectedMessages();
              }}
              onClose={() => {
                setReactionMsgId(null);
                clearSelectedMessages();
              }}
            />

            {/* WhatsApp-style reaction pill — overlaps bottom of bubble */}
            {!isDeletedMessage && (
              <ReactionBar
                reactions={msg?.reactions}
                currentUserId={currentUserId}
                isMyMessage={isMyMessage}
                isDarkMode={isDarkMode}
                themeColor={theme.colors.themeColor}
                scaleAnims={reactionScaleAnims}
                onToggleReaction={(emoji) => toggleReaction(messageKey, emoji)}
                onShowDetail={(emoji) => {
                  setReactionDetailModal({ visible: true, reactions: msg.reactions, selectedEmoji: emoji, messageId: messageKey });
                }}
              />
            )}
          </View>
        </Pressable>
        </SwipeReplyRow>
        {dateBadgeKey && renderDateBadge(dateBadgeKey)}
      </React.Fragment>
    );
  }, [selectedMessage, currentUserId, chatColor, theme, isDarkMode, chatData, isSearching, searchResults, currentSearchIndex, expandedRichMessages, richMessageLineCounts, playingAudioId, audioPlaybackStatus, downloadProgress, uploadProgress, mediaDownloadStates, downloadedMedia, reactionMsgId, toggleReaction, removeReaction, handleDeleteSelected, startEditMessage, startReply, groupMembersMap, handleToggleSelectMessages, clearSelectedMessages]);

  // Typing indicator
  const renderTypingIndicator = () => {
    if (!isPeerTyping) return null;
    return (
      <View style={{ alignItems: "flex-start", paddingVertical: 4, paddingHorizontal: 12 }}>
        <View style={{ 
          borderRadius: 16, 
          flexDirection: 'row', 
          alignItems: "center", 
          gap: 4, 
          backgroundColor: theme.colors.cardBackground,
          borderBottomLeftRadius: 4, 
          paddingVertical: 8, 
          paddingHorizontal: 12,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.05,
          shadowRadius: 1,
          elevation: 1,
        }}>
          <View style={{ flexDirection: 'row', gap: 3 }}>
            {[0, 1, 2].map((i) => (
              <Animated.View
                key={i}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: theme.colors.themeColor,
                  opacity: 0.6,
                }}
              />
            ))}
          </View>
          <Text style={{ fontSize: 12, color: theme.colors.placeHolderTextColor, fontFamily: "Roboto-Medium", fontStyle: 'italic', marginLeft: 4 }}>
            typing...
          </Text>
        </View>
      </View>
    );
  };

  const renderFooter = () => {
    if (isLoadingMore) {
      return (
        <View style={{ paddingVertical: 20, alignItems: "center" }}>
          <ActivityIndicator size="small" color={theme.colors.themeColor} />
          <Text style={{ marginTop: 8, fontSize: 11, color: theme.colors.placeHolderTextColor }}>
            Loading more messages...
          </Text>
        </View>
      );
    }
    if (!hasMoreMessages && messages.length > 0 && !isSearching) {
      const isGrpFooter = chatData?.isGroup || chatData?.chatType === 'group';
      const creatorId = chatData?.group?.createdBy || chatData?.group?.ownerId;
      const creatorName = creatorId
        ? (groupMembersMap?.[String(creatorId)]?.fullName || 'someone')
        : '';
      const groupCreatedDate = chatData?.group?.createdAt
        ? new Date(chatData.group.createdAt).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })
        : '';

      return (
        <View style={{ paddingVertical: 16, alignItems: "center", paddingHorizontal: 30 }}>
          {isGrpFooter ? (
            <View style={{ alignItems: 'center', gap: 6 }}>
              <View style={{ backgroundColor: theme.colors.menuBackground, paddingHorizontal: 16, paddingVertical: 6, borderRadius: 10 }}>
                <Text style={{ fontSize: 12, color: theme.colors.placeHolderTextColor, fontFamily: 'Roboto-Regular', textAlign: 'center' }}>
                  {creatorName
                    ? `${creatorName} created group "${chatData?.chatName || chatData?.groupName || 'this group'}"`
                    : `Group "${chatData?.chatName || chatData?.groupName || ''}" created`}
                  {groupCreatedDate ? ` on ${groupCreatedDate}` : ''}
                </Text>
              </View>
              <View style={{ backgroundColor: theme.colors.menuBackground, paddingHorizontal: 16, paddingVertical: 6, borderRadius: 10 }}>
                <Text style={{ fontSize: 11, color: theme.colors.placeHolderTextColor, fontFamily: 'Roboto-Regular', textAlign: 'center' }}>
                  Messages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them.
                </Text>
              </View>
            </View>
          ) : (
            <View style={{ backgroundColor: theme.colors.menuBackground, paddingHorizontal: 20, paddingVertical: 6, borderRadius: 20 }}>
              <Text style={{ fontSize: 11, color: theme.colors.placeHolderTextColor }}>
                Beginning of conversation
              </Text>
            </View>
          )}
        </View>
      );
    }
    return null;
  };

  if (isLoadingInitial) {
    return (
      <View style={{ 
        flex: 1, 
        backgroundColor: theme.colors.background, 
        justifyContent: "center", 
        alignItems: "center" 
      }}>
        <ActivityIndicator size="large" color={theme.colors.themeColor} />
        <Text style={{ 
          marginTop: 16, 
          fontSize: 14, 
          color: theme.colors.primaryTextColor,
          fontFamily: "Roboto-Regular",
        }}>
          Loading chat...
        </Text>
      </View>
    );
  }

  if (!chatData || (!chatData.peerUser && !chatData.isGroup)) {
    return (
      <View style={{ 
        flex: 1, 
        backgroundColor: theme.colors.background, 
        justifyContent: "center", 
        alignItems: "center", 
        padding: 20 
      }}>
        <FontAwesome6 name="exclamation-triangle" size={50} color={theme.colors.themeColor} />
        <Text style={{ marginTop: 16, fontSize: 14, color: theme.colors.primaryTextColor, textAlign: "center", fontFamily: "Roboto-Regular" }}>
          Unable to load chat. User information is missing.
        </Text>
        <TouchableOpacity 
          onPress={() => navigation.goBack()} 
          style={{ marginTop: 24, paddingHorizontal: 32, paddingVertical: 12, backgroundColor: theme.colors.themeColor, borderRadius: 24 }} >
          <Text style={{ color: '#FFFFFF', fontFamily: "Roboto-Medium" }}>
            Go Back
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ─── GROUP MESSAGING PERMISSION ───
  const groupSettings = chatData?.group?.settings || {};
  const adminsOnlyMessaging = Boolean(groupSettings?.adminsOnlyMessaging);
  const myGroupRole = chatData?.myRole || chatData?.group?.myRole || 'member';
  const isGroupAdmin = myGroupRole === 'owner' || myGroupRole === 'admin';
  // Members can't send if adminsOnlyMessaging is on; also check per-member canSendMessage flag
  const myMemberRecord = (chatData?.members || []).find((m) => {
    const uid = typeof m.userId === 'object' ? m.userId?._id : m.userId;
    return uid && String(uid) === String(currentUserId);
  });
  const memberCanSend = myMemberRecord?.canSendMessage !== false;
  const messagingDisabled = isGroupChat && ((adminsOnlyMessaging && !isGroupAdmin) || !memberCanSend);
  const messagingDisabledText = !memberCanSend
    ? 'You are restricted from sending messages'
    : 'Only admins can send messages';

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <StatusBar backgroundColor={theme.colors.background} barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <Animated.View style={{ flex: 1, paddingBottom: Platform.OS === 'android' ? keyboardAnim : 0 }}>
        <ChatWallpaperLayer isDarkMode={isDarkMode} />
        
        {/* Header */}
        <ChatHeaderPresence
          user={chatData.peerUser}
          chatId={chatData.chatId || chatData?._id || route?.params?.chatId}
          isPeerTyping={isPeerTyping}
          fallbackStatusText={renderStatusText()}
          onBack={() => navigation.goBack()}
          onPressProfile={handleOpenContactInfo}
          getUserColor={getUserColor}
          isGroup={Boolean(chatData?.chatType === 'group' || chatData?.isGroup)}
          groupName={chatData?.chatName || chatData?.group?.name || chatData?.groupName}
          groupAvatar={chatData?.chatAvatar || chatData?.group?.avatar || chatData?.groupAvatar}
          memberCount={chatData?.group?.memberCount || chatData?.members?.length || chatData?.memberCount}
          rightActions={selectedMessage.length > 0 ? (() => {
            const selMsg = selectedMessage.length === 1
              ? messages.find(m => sameId(m.id, selectedMessage[0]) || sameId(m.serverMessageId, selectedMessage[0]) || sameId(m.tempId, selectedMessage[0]))
              : null;
            const isOwnMsg = selMsg && sameId(selMsg?.senderId, currentUserId);
            const msgStatus = (selMsg?.status || '').toLowerCase();
            const isSeen = msgStatus === 'seen' || msgStatus === 'read';
            const canEdit = isOwnMsg && selMsg?.type === 'text' && !selMsg?.isDeleted && !isSeen;
            const isTextMsg = selMsg?.type === 'text';
            const canReport = selectedMessage.length === 1 && selMsg && !isOwnMsg && !selMsg?.isDeleted;
            const canCancelSchedule = selectedMessage.length === 1 && (selMsg?.status === 'scheduled' || selMsg?.status === 'processing') && isOwnMsg;
            return (
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {/* Count */}
                <Text style={{ fontFamily: "Roboto-SemiBold", fontSize: 18, color: theme.colors.primaryTextColor, marginRight: 16, marginLeft: 4 }}>
                  {selectedMessage.length}
                </Text>
                {/* Cancel Scheduled */}
                {canCancelSchedule && (
                  <TouchableOpacity
                    onPress={() => {
                      const msgId = selMsg.serverMessageId || selMsg.id;
                      cancelScheduledMessage(msgId);
                      clearSelectedMessages();
                      setReactionMsgId(null);
                    }}
                    style={{ padding: 10 }}>
                    <Ionicons name="time-outline" size={22} color="#FF5252" />
                  </TouchableOpacity>
                )}
                {/* Delete */}
                <TouchableOpacity
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
                    setReactionMsgId(null);
                    handleDeleteSelected();
                  }}
                  style={{ padding: 10 }}>
                  <Ionicons name="trash-outline" size={22} color={theme.colors.primaryTextColor} />
                </TouchableOpacity>
                {/* Copy */}
                {selectedMessage.length === 1 && isTextMsg && (
                  <TouchableOpacity
                    onPress={() => {
                      const Clipboard = require('expo-clipboard');
                      Clipboard.setStringAsync(selMsg?.text || '');
                      if (Platform.OS === 'android') {
                        const { ToastAndroid: T } = require('react-native');
                        T.show('Copied', T.SHORT);
                      }
                      clearSelectedMessages();
                      setReactionMsgId(null);
                    }}
                    style={{ padding: 10 }}>
                    <Ionicons name="copy-outline" size={22} color={theme.colors.primaryTextColor} />
                  </TouchableOpacity>
                )}
                {/* Reply */}
                {selectedMessage.length === 1 && selMsg && !selMsg?.isDeleted && (
                  <TouchableOpacity
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                      setReactionMsgId(null);
                      clearSelectedMessages();
                      startReply(selMsg);
                    }}
                    style={{ padding: 10 }}>
                    <Ionicons name="arrow-undo-outline" size={22} color={theme.colors.primaryTextColor} />
                  </TouchableOpacity>
                )}
                {/* Forward */}
                {selectedMessage.length > 0 && (() => {
                  const selectedMsgs = selectedMessage
                    .map(id => messages.find(m => sameId(m.id, id) || sameId(m.serverMessageId, id) || sameId(m.tempId, id)))
                    .filter(m => m && !m.isDeleted);
                  // Server needs the MongoDB _id — use serverMessageId (which IS the _id)
                  // Fallback: if id is not a temp ID, it was set by acknowledgeMessage to the server _id
                  const forwardableIds = selectedMsgs.map(m => {
                    if (m.serverMessageId) return m.serverMessageId;
                    if (m.id && !String(m.id).startsWith('temp_')) return m.id;
                    return null;
                  }).filter(Boolean);
                  if (forwardableIds.length === 0) return null;
                  return (
                    <TouchableOpacity
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                        setReactionMsgId(null);
                        clearSelectedMessages();
                        navigation.navigate('ForwardMessage', {
                          messageIds: forwardableIds,
                          messages: selectedMsgs,
                        });
                      }}
                      style={{ padding: 10 }}>
                      <Ionicons name="arrow-redo-outline" size={22} color={theme.colors.primaryTextColor} />
                    </TouchableOpacity>
                  );
                })()}
                {/* Edit — only if NOT seen/read */}
                {canEdit && (
                  <TouchableOpacity
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                      setReactionMsgId(null);
                      startEditMessage(selMsg);
                    }}
                    style={{ padding: 10 }}>
                    <MaterialIcons name="edit" size={22} color={theme.colors.primaryTextColor} />
                  </TouchableOpacity>
                )}
                {/* Report Message — only for other's messages */}
                {canReport && (
                  <TouchableOpacity
                    onPress={() => {
                      setReactionMsgId(null);
                      clearSelectedMessages();
                      handleReportMessage(selMsg);
                    }}
                    style={{ padding: 10 }}>
                    <Ionicons name="flag-outline" size={22} color="#E53935" />
                  </TouchableOpacity>
                )}
              </View>
            );
          })() : (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              {isChatMuted && (
                <View style={{ marginRight: 8 }}>
                  <Ionicons name="notifications-off" size={20} color={theme.colors.placeHolderTextColor} />
                </View>
              )}
              <TouchableOpacity 
                onPress={() => setShowMenu(true)} 
                style={{ padding: 8, borderRadius: 20, backgroundColor: theme.colors.menuBackground }} >
                <Ionicons name="ellipsis-vertical" size={18} color={theme.colors.primaryTextColor} />
              </TouchableOpacity>
            </View>
          )}
        />

        {/* Search Bar */}
        {showSearchBar && (
          <View style={{ 
            flexDirection: "row", 
            padding: 8, 
            alignItems: "center", 
            // borderBottomWidth: 1, 
            borderBottomColor: theme.colors.borderColor,
            backgroundColor: theme.colors.background,
          }}>
            <View style={{ 
              flex: 1, 
              flexDirection: "row", 
              alignItems: "center", 
              backgroundColor: theme.colors.menuBackground, 
              borderRadius: 24, 
              paddingHorizontal: 12, 
              paddingVertical: Platform.OS === "ios" ? 8 : 4,
            }}>
              <Ionicons name="search" size={18} color={theme.colors.placeHolderTextColor} style={{ marginRight: 8 }} />
              <TextInput 
                placeholder="Search messages..." 
                value={search} 
                onChangeText={handleSearch} 
                placeholderTextColor={theme.colors.placeHolderTextColor} 
                returnKeyType="search" 
                autoCorrect={false} 
                autoFocus
                style={{ 
                  flex: 1, 
                  fontSize: 14, 
                  color: theme.colors.primaryTextColor, 
                  fontFamily: "Roboto-Regular",
                  paddingVertical: Platform.OS === "ios" ? 8 : 4,
                }} 
              />
              {search.length > 0 && (
                <TouchableOpacity onPress={clearSearch} style={{ marginLeft: 4 }}>
                  <Ionicons name="close-circle" size={18} color={theme.colors.placeHolderTextColor} />
                </TouchableOpacity>
              )}
            </View>
            
            {isSearching && searchResults.length > 0 && (
              <View style={{ flexDirection: 'row', marginLeft: 8, gap: 4 }}>
                <View style={{ 
                  backgroundColor: theme.colors.menuBackground, 
                  paddingHorizontal: 8, 
                  paddingVertical: 4, 
                  borderRadius: 12,
                }}>
                  <Text style={{ fontSize: 10, color: theme.colors.primaryTextColor }}>
                    {currentSearchIndex + 1}/{searchResults.length}
                  </Text>
                </View>
                <TouchableOpacity 
                  onPress={goToPreviousResult} 
                  style={{ 
                    backgroundColor: theme.colors.menuBackground, 
                    padding: 6, 
                    borderRadius: 12,
                  }}
                >
                  <Ionicons name="chevron-up" size={16} color={theme.colors.primaryTextColor} />
                </TouchableOpacity>
                <TouchableOpacity 
                  onPress={goToNextResult} 
                  style={{ 
                    backgroundColor: theme.colors.menuBackground, 
                    padding: 6, 
                    borderRadius: 12,
                  }}
                >
                  <Ionicons name="chevron-down" size={16} color={theme.colors.primaryTextColor} />
                </TouchableOpacity>
              </View>
            )}

            <TouchableOpacity 
              onPress={handleCloseSearchBar} 
              style={{ 
                marginLeft: 8, 
                width: 36, 
                height: 36, 
                borderRadius: 18, 
                alignItems: 'center', 
                justifyContent: 'center', 
                backgroundColor: theme.colors.menuBackground,
              }}
            >
              <Ionicons name="close" size={20} color={theme.colors.primaryTextColor} />
            </TouchableOpacity>
          </View>
        )}

        {/* Messages List */}
        {isSearching && messages.length === 0 ? (
          <View style={{ flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 32 }}>
            <Ionicons name="search-outline" size={64} color={theme.colors.placeHolderTextColor} />
            <Text style={{ 
              marginTop: 16, 
              fontSize: 15, 
              color: theme.colors.placeHolderTextColor,
              textAlign: 'center',
              fontFamily: "Roboto-Regular",
            }}>
              No messages found
            </Text>
          </View>
        ) : (
          <FlatList
            ref={flatListRef}
            data={messages}
            keyExtractor={getMessageKey}
            renderItem={renderChatsItem}
            inverted
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              paddingBottom: 8,
              paddingTop: 8,
              flexGrow: 1,
            }}
            showsVerticalScrollIndicator={false}
            initialNumToRender={15}
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}

            ListHeaderComponent={renderTypingIndicator}

            onEndReached={!isSearching ? loadMoreMessages : undefined}
            onEndReachedThreshold={0.3}

            onScroll={(e) => { if (reactionMsgId) { setReactionMsgId(null); clearSelectedMessages(); } handleScroll(e); }}
            onScrollBeginDrag={handleScrollBeginDrag}
            onScrollEndDrag={handleScrollEndDrag}
            onMomentumScrollBegin={handleMomentumScrollBegin}
            onMomentumScrollEnd={handleMomentumScrollEnd}
            scrollEventThrottle={16}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}

            removeClippedSubviews={Platform.OS !== 'web'}
            maxToRenderPerBatch={20}
            updateCellsBatchingPeriod={100}
            windowSize={17}
            ListFooterComponent={!isSearching ? renderFooter : null}
            ListEmptyComponent={!isSearching ? renderChatEmptyState : null}
            maintainVisibleContentPosition={{
              minIndexForVisible: 0,
              autoscrollToTopThreshold: 5,
            }}
            onScrollToIndexFailed={(info) => {
              console.warn("Scroll to index failed:", info);
            }}
          />
        )}

        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: showSearchBar ? 108 : 74,
            left: 0,
            right: 0,
            alignItems: 'center',
            opacity: stickyDateOpacity,
            transform: [
              { scale: stickyDateScale },
              {
                translateY: stickyDateOpacity.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }),
              },
            ],
            zIndex: 11,
          }}
        >
          <View
            style={{
              minWidth: 88,
              borderRadius: 14,
              overflow: 'hidden',
              borderWidth: 1,
              borderColor: isDarkMode ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.08)',
              backgroundColor: isDarkMode ? 'rgba(25,40,55,0.92)' : 'rgba(225,230,236,0.96)',
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.16,
              shadowRadius: 4,
              elevation: 4,
            }}
          >

            <Text
              style={{
                fontSize: 11,
                color: isDarkMode ? 'rgba(233,245,255,0.96)' : '#4f5a60',
                fontFamily: 'Roboto-Medium',
                textAlign: 'center',
                paddingHorizontal: 12,
                paddingVertical: 5,
              }}
            >
              {stickyDateLabel}
            </Text>
          </View>
        </Animated.View>

        {/* Manual reload indicator */}
        {isManualReloading && (
          <View
            pointerEvents="none"
            style={{ 
              position: 'absolute', 
              top: 74, 
              left: 0, 
              right: 0, 
              alignItems: 'center',
            }}
          >
            <View style={{ 
              flexDirection: 'row', 
              alignItems: 'center', 
              backgroundColor: theme.colors.menuBackground, 
              borderRadius: 20, 
              paddingHorizontal: 14, 
              paddingVertical: 8, 
              borderWidth: 1, 
              borderColor: theme.colors.borderColor,
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.1,
              shadowRadius: 3,
              elevation: 3,
            }}>
              <ActivityIndicator size="small" color={theme.colors.themeColor} />
              <Text style={{ 
                marginLeft: 8, 
                color: theme.colors.primaryTextColor, 
                fontSize: 12,
                fontFamily: "Roboto-Medium",
              }}>
                Reloading messages...
              </Text>
            </View>
          </View>
        )}

        {/* Scroll to bottom button */}
        {showScrollButton && (
          <TouchableOpacity
            onPress={handleScrollToLatest}
            style={{ 
              position: 'absolute', 
              right: 16, 
              bottom: 78, 
              width: 44, 
              height: 44, 
              borderRadius: 22, 
              backgroundColor: theme.colors.cardBackground, 
              alignItems: 'center', 
              justifyContent: 'center', 
              // borderWidth: 1, 
              // borderColor: theme.colors.themeColor,
              // shadowColor: "#000",
              // shadowOffset: { width: 0, height: 2 },
              // shadowOpacity: 0.2,
              // shadowRadius: 3,
              // elevation: 4,
            }}
          >
            <Ionicons name="arrow-down" size={20} color={theme.colors.themeColor} />
            {newMessagesCount > 0 && (
              <View style={{ 
                position: 'absolute', 
                top: -6, 
                right: -4, 
                minWidth: 20, 
                height: 20, 
                borderRadius: 10, 
                backgroundColor: theme.colors.themeColor, 
                alignItems: 'center', 
                justifyContent: 'center', 
                paddingHorizontal: 5,
                borderWidth: 1.5,
                borderColor: theme.colors.background,
              }}>
                <Text style={{ 
                  fontSize: 9, 
                  color: '#FFFFFF', 
                  fontFamily: 'Roboto-Medium',
                }}>
                  {newMessagesCount > 99 ? '99+' : newMessagesCount}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        )}

        {isRecordingAudio && (
          <Animated.View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 14,
              paddingVertical: 10,
              backgroundColor: isDarkMode ? theme.colors.cardBackground : '#fff',
              opacity: recBarAnim,
              transform: [{ translateY: recBarAnim.interpolate({ inputRange: [0, 1], outputRange: [30, 0] }) }],
            }}
          >
            {/* Red pulsing dot + timer */}
            <Animated.View style={{ opacity: recPulseAnim, width: 12, height: 12, borderRadius: 6, backgroundColor: '#FF3B30', marginRight: 10 }} />
            <Text style={{ color: theme.colors.primaryTextColor, fontFamily: 'Roboto-Medium', fontSize: 16, minWidth: 50 }}>
              {recordingDurationLabel}
            </Text>

            {/* Voice waveform bars */}
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 32, marginHorizontal: 8 }}>
              {recWaveAnims.map((anim, i) => (
                <Animated.View
                  key={i}
                  style={{
                    width: 3,
                    marginHorizontal: 1,
                    borderRadius: 1.5,
                    backgroundColor: theme.colors.themeColor,
                    height: 28,
                    transform: [{ scaleY: anim }],
                  }}
                />
              ))}
            </View>

            {/* Delete (cancel) button */}
            <TouchableOpacity
              onPress={() => stopVoiceRecording({ cancel: true })}
              accessibilityRole="button"
              accessibilityLabel="Cancel voice recording"
              style={{ width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', marginRight: 6 }}
            >
              <Ionicons name="trash-outline" size={22} color="#FF3B30" />
            </TouchableOpacity>

            {/* Send (stop + send) button */}
            <TouchableOpacity
              onPress={() => stopVoiceRecording({ cancel: false })}
              accessibilityRole="button"
              accessibilityLabel="Send voice recording"
              style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: theme.colors.themeColor, justifyContent: 'center', alignItems: 'center' }}
            >
              <Ionicons name="send" size={18} color="#fff" style={{ marginLeft: 2 }} />
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* Reply preview bar */}
        {replyTarget && !editingMessage && (
          <ReplyPreviewBox
            replyTarget={replyTarget}
            currentUserId={currentUserId}
            onClose={cancelReply}
            theme={theme}
            chatColor={chatColor}
            isDarkMode={isDarkMode}
          />
        )}

        {/* Edit mode bar */}
        {editingMessage && (
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 12,
            paddingVertical: 8,
            backgroundColor: theme.colors.cardBackground,
            borderTopWidth: 1,
            borderTopColor: theme.colors.borderColor,
          }}>
            <View style={{
              width: 3,
              height: '100%',
              minHeight: 28,
              backgroundColor: theme.colors.themeColor,
              borderRadius: 2,
              marginRight: 10,
            }} />
            <View style={{ flex: 1 }}>
              <Text style={{
                fontSize: 12,
                fontFamily: 'Roboto-SemiBold',
                color: theme.colors.themeColor,
              }}>
                Editing
              </Text>
              <Text
                numberOfLines={1}
                style={{
                  fontSize: 13,
                  fontFamily: 'Roboto-Regular',
                  color: theme.colors.secondaryTextColor,
                }}
              >
                {editingMessage.text}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => {
                cancelEditMessage();
                handleTextChange('');
              }}
              style={{ padding: 8 }}
            >
              <Ionicons name="close-circle" size={22} color={theme.colors.placeHolderTextColor} />
            </TouchableOpacity>
          </View>
        )}

        {messagingDisabled ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 14, paddingHorizontal: 20, backgroundColor: isDarkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)', borderTopWidth: 0.5, borderTopColor: theme.colors.borderColor }}>
            <Ionicons name="lock-closed-outline" size={16} color={theme.colors.placeHolderTextColor} style={{ marginRight: 8 }} />
            <Text style={{ fontFamily: 'Roboto-Regular', fontSize: 13, color: theme.colors.placeHolderTextColor }}>{messagingDisabledText}</Text>
          </View>
        ) : (
          <ChatInputBar
            ref={chatInputRef}
            theme={theme}
            isDarkMode={isDarkMode}
            chatColor={chatColor}
            text={text}
            pendingMedia={editingMessage ? null : pendingMedia}
            inputHeight={inputHeight}
            isInputFocused={isInputFocused}
            isSearching={isSearching}
            showEmojiPanel={showEmojiPanel}
            onTextChange={handleTextChangeWithMentions}
            onInputContentSizeChange={handleInputContentSizeChange}
            onSelectionChange={isGroupChat ? handleMentionSelectionChange : undefined}
            onFocus={() => { setIsInputFocused(true); setShowEmojiPanel(false); }}
            onBlur={() => setIsInputFocused(false)}
            onOpenEmoji={handleOpenEmojiPanel}
            onOpenAttachment={editingMessage ? undefined : handleToggleMediaOptions}
            onRemovePendingMedia={() => setPendingMedia(null)}
            onSubmit={handleSubmitInput}
            onSchedule={scheduleMessage}
            mentionSuggestionsNode={isGroupChat ? (
              <MentionSuggestions
                suggestions={mentionSuggestions}
                onSelect={handleMentionSelect}
                theme={theme}
                isDarkMode={isDarkMode}
                visible={showMentionSuggestions}
              />
            ) : null}
          />
        )}

        {/* Emoji Panel — WhatsApp style, replaces keyboard */}
        {showEmojiPanel && (
          <View style={{
            height: Math.max(keyboardHeight, 280),
            backgroundColor: isDarkMode ? theme.colors.cardBackground : '#F0F2F5',
            borderTopWidth: 0,
            borderTopColor: theme.colors.borderColor,
          }}>
            <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 16, paddingTop: 6, paddingBottom: 4, gap: 20 }}>
              {emojiSectionsMeta.map((section) => {
                const active = section.key === activeEmojiSection;
                return (
                  <TouchableOpacity
                    key={section.key}
                    onPress={() => setActiveEmojiSection(section.key)}
                    activeOpacity={0.7}
                    style={{
                      alignItems: 'center',
                      justifyContent: 'center',
                      paddingVertical: 4,
                      paddingHorizontal: 6,
                      borderBottomWidth: active ? 2 : 0,
                      borderBottomColor: theme.colors.themeColor,
                    }}
                  >
                    <Ionicons
                      name={section.icon}
                      size={20}
                      color={active
                        ? theme.colors.themeColor
                        : (isDarkMode ? 'rgba(224,236,245,0.5)' : '#999')}
                    />
                  </TouchableOpacity>
                );
              })}
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              style={{ flex: 1, }}
              contentContainerStyle={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                paddingHorizontal: 6,
                paddingBottom: 10,
              }}
            >
              {activeEmojiList.map((emoji, index) => (
                <TouchableOpacity
                  key={`${emoji}_${index}`}
                  onPress={() => handleSelectEmoji(emoji)}
                  activeOpacity={0.7}
                  style={{
                    width: '14.28%',
                    alignItems: 'center',
                    justifyContent: 'center',
                    paddingVertical: 7,
                  }}
                >
                  <Text style={{ fontSize: 28 }}>{emoji}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            {/* Backspace button */}
            <View style={{
              flexDirection: 'row',
              justifyContent: 'flex-end',
              paddingHorizontal: 16,
              paddingBottom: Platform.OS === 'ios' ? 20 : 8,
              paddingTop: 4,
              borderTopWidth: 0.5,
              borderTopColor: isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
            }}>
              <TouchableOpacity
                onPress={() => {
                  // Remove last emoji or character
                  if (text && text.length > 0) {
                    // Handle multi-codepoint emoji
                    const arr = [...text];
                    arr.pop();
                    handleTextChange(arr.join(''));
                  }
                }}
                activeOpacity={0.7}
                style={{
                  width: 44,
                  height: 36,
                  borderRadius: 8,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)',
                }}
              >
                <Ionicons name="backspace-outline" size={22} color={isDarkMode ? '#ccc' : '#555'} />
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Menu Modal */}
        <Modal visible={showMenu} transparent animationType="fade" onRequestClose={() => setShowMenu(false)}>
          <TouchableOpacity
            activeOpacity={1}
            onPress={() => setShowMenu(false)}
            style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' }}
          >
            <View style={{ 
              marginTop: 84, 
              marginRight: 12, 
              backgroundColor: theme.colors.cardBackground, 
              borderRadius: 12, 
              borderWidth: 1, 
              borderColor: theme.colors.borderColor, 
              overflow: 'hidden', 
              alignSelf: 'flex-end', 
              minWidth: 200,
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.2,
              shadowRadius: 4,
              elevation: 5,
            }}>
              <TouchableOpacity 
                onPress={handleToggleSearchBar} 
                style={{ 
                  paddingVertical: 14, 
                  paddingHorizontal: 16,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <Ionicons name="search" size={18} color={theme.colors.primaryTextColor} />
                <Text style={{ color: theme.colors.primaryTextColor, fontFamily: 'Roboto-Regular' }}>
                  Search
                </Text>
              </TouchableOpacity>
              
              <TouchableOpacity 
                onPress={handleMenuReload} 
                style={{ 
                  paddingVertical: 14, 
                  paddingHorizontal: 16,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <Ionicons name="refresh" size={18} color={theme.colors.primaryTextColor} />
                <Text style={{ color: theme.colors.primaryTextColor, fontFamily: 'Roboto-Regular' }}>
                  Reload
                </Text>
              </TouchableOpacity>
              
              <TouchableOpacity 
                onPress={handleMenuLocalRefresh} 
                style={{ 
                  paddingVertical: 14, 
                  paddingHorizontal: 16,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <MaterialIcons name="restore" size={18} color={theme.colors.primaryTextColor} />
                <Text style={{ color: theme.colors.primaryTextColor, fontFamily: 'Roboto-Regular' }}>
                  Refresh
                </Text>
              </TouchableOpacity>
              
              <TouchableOpacity 
                onPress={handleOpenContactInfo} 
                style={{ 
                  paddingVertical: 14, 
                  paddingHorizontal: 16,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <Ionicons name="person" size={18} color={theme.colors.primaryTextColor} />
                <Text style={{ color: theme.colors.primaryTextColor, fontFamily: 'Roboto-Regular' }}>
                  Contact Info
                </Text>
              </TouchableOpacity>
{/* Report Chat removed — use Report Message via long press instead */}

              {/* <TouchableOpacity
                onPress={handleClearChatOptions}
                style={{
                  paddingVertical: 14,
                  paddingHorizontal: 16,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <MaterialIcons name="delete-sweep" size={18} color={theme.colors.primaryTextColor} />
                <Text style={{ color: theme.colors.primaryTextColor, fontFamily: 'Roboto-Regular' }}>
                  Clear Chat
                </Text>
              </TouchableOpacity> */}
            </View>
          </TouchableOpacity>
        </Modal>

        {/* Media options overlay — no Modal, no BlurView, lightweight */}
        {showMediaOptions && (
          <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 50 }} pointerEvents="box-none">
            <Animated.View
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 0,
                bottom: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.38)',
                opacity: mediaBackdropAnim,
              }}
            >
              <Pressable
                onPress={closeMediaPanelAnimated}
                style={{ flex: 1 }}
              />
            </Animated.View>

            <Animated.View
              {...mediaPanelPanResponder.panHandlers}
              style={{
                position: 'absolute',
                bottom: Platform.OS === 'ios' ? 14 : 10,
                alignSelf: 'center',
                width: mediaPanelWidth,
                borderRadius: 28,
                overflow: 'hidden',
                backgroundColor: isDarkMode ? 'rgba(18, 32, 47, 0.97)' : 'rgba(255, 255, 255, 0.97)',
                transform: [{ translateY: mediaSheetAnim }],
                elevation: 12,
              }}
            >
              <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 2 }}>
                <View style={{ width: 44, height: 4, borderRadius: 2, backgroundColor: isDarkMode ? 'rgba(218, 232, 242, 0.35)' : 'rgba(0,0,0,0.15)' }} />
              </View>

              <Text
                style={{
                  fontSize: 16,
                  textAlign: 'center',
                  color: isDarkMode ? '#EDF6FC' : '#111',
                  fontFamily: 'Roboto-SemiBold',
                  marginTop: 6,
                  marginBottom: 16,
                }}
              >
                Share
              </Text>

              <View
                style={{
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  justifyContent: 'space-evenly',
                  paddingHorizontal: 10,
                  paddingBottom: 8,
                  rowGap: 16,
                }}
              >
                {MEDIA_PANEL_OPTIONS.map((item) => {
                  const press = mediaOptionPressAnims[item.key];
                  return (
                    <Animated.View
                      key={item.key}
                      style={{
                        width: 76,
                        alignItems: 'center',
                        transform: [{ scale: press }],
                      }}
                    >
                      <Pressable
                        onPressIn={() => handleMediaOptionPressIn(item.key)}
                        onPressOut={() => handleMediaOptionPressOut(item.key)}
                        onPress={() => handleMediaOptionSelect(item.key)}
                        style={{ alignItems: 'center' }}
                      >
                        <View
                          style={{
                            width: 56,
                            height: 56,
                            borderRadius: 28,
                            backgroundColor: item.color + '18',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <Ionicons name={item.icon} size={26} color={item.color} />
                        </View>
                        <Text
                          style={{
                            marginTop: 6,
                            fontSize: 12,
                            color: isDarkMode ? '#C8D8E4' : '#444',
                            fontFamily: 'Roboto-Medium',
                            textAlign: 'center',
                          }}
                        >
                          {item.label}
                        </Text>
                      </Pressable>
                    </Animated.View>
                  );
                })}
              </View>

              <Pressable
                onPress={closeMediaPanelAnimated}
                style={{
                  alignSelf: 'center',
                  marginTop: 10,
                  marginBottom: Platform.OS === 'ios' ? 22 : 18,
                  paddingVertical: 8,
                  paddingHorizontal: 20,
                  borderRadius: 16,
                  backgroundColor: isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
                }}
              >
                <Text style={{ color: '#F97373', fontFamily: 'Roboto-SemiBold', fontSize: 13 }}>Close</Text>
              </Pressable>
            </Animated.View>
          </View>
        )}

        {/* WhatsApp-style Media viewer modal */}
        <Modal visible={localMediaViewer.visible} transparent animationType="fade" onRequestClose={closeLocalMediaViewer} statusBarTranslucent>
          <View style={{ flex: 1, backgroundColor: '#000' }}>
            {/* ── Top bar ── */}
            <View style={{
              position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20,
              paddingTop: Platform.OS === 'ios' ? 54 : (StatusBar.currentHeight || 24) + 10,
              paddingHorizontal: 12, paddingBottom: 10,
              backgroundColor: 'rgba(0,0,0,0.5)',
              flexDirection: 'row', alignItems: 'center',
            }}>
              <TouchableOpacity onPress={closeLocalMediaViewer} style={{ padding: 6 }}>
                <Ionicons name="arrow-back" size={24} color="#fff" />
              </TouchableOpacity>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={{ color: '#fff', fontSize: 15, fontFamily: 'Roboto-SemiBold' }} numberOfLines={1}>
                  {localMediaViewer.message?.senderName || (localMediaViewer.message?.senderId === currentUserId ? 'You' : chatData?.peerUser?.name || 'Photo')}
                </Text>
                {localMediaViewer.message?.time && (
                  <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11, fontFamily: 'Roboto-Regular' }}>
                    {localMediaViewer.message?.date ? `${localMediaViewer.message.date} • ${localMediaViewer.message.time}` : localMediaViewer.message.time}
                  </Text>
                )}
              </View>
              {/* Action icons — right side */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {/* Share */}
                <TouchableOpacity
                  onPress={async () => {
                    const msg = localMediaViewer.message;
                    try {
                      const localUri = await resolveFileForOpen(msg);
                      if (localUri && await Sharing.isAvailableAsync()) {
                        await Sharing.shareAsync(localUri);
                      }
                    } catch (e) {
                      console.error('Share error:', e);
                    }
                  }}
                  style={{ padding: 8 }}
                >
                  <Ionicons name="share-social-outline" size={22} color="#fff" />
                </TouchableOpacity>
                {/* Save to gallery — one tap, no repeat permission prompt */}
                <TouchableOpacity
                  onPress={async () => {
                    const msg = localMediaViewer.message;
                    try {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      const localUri = await resolveFileForOpen(msg);
                      if (!localUri) return;
                      // Check existing permission first — only prompt if undetermined
                      let perm = await MediaLibrary.getPermissionsAsync();
                      if (perm.status !== 'granted') {
                        perm = await MediaLibrary.requestPermissionsAsync();
                        if (perm.status !== 'granted') return;
                      }
                      await MediaLibrary.createAssetAsync(localUri);
                      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                      setViewerSavedToast(true);
                      if (viewerToastTimer.current) clearTimeout(viewerToastTimer.current);
                      viewerToastTimer.current = setTimeout(() => setViewerSavedToast(false), 2000);
                    } catch (e) {
                      console.error('Save error:', e);
                    }
                  }}
                  style={{ padding: 8 }}
                >
                  <Ionicons name="download-outline" size={22} color="#fff" />
                </TouchableOpacity>
              </View>
            </View>

            {/* ── Image with pinch & double-tap zoom ── */}
            {localMediaViewer.type === 'image' && localMediaViewer.uri && (
              <GestureHandlerRootView style={{ flex: 1 }}>
                <ImageZoom
                  uri={localMediaViewer.uri}
                  minScale={1}
                  maxScale={5}
                  doubleTapScale={3}
                  minPanPointers={1}
                  isSingleTapEnabled
                  isDoubleTapEnabled
                  style={{ flex: 1 }}
                  resizeMode="contain"
                />
              </GestureHandlerRootView>
            )}

            {/* ── Video player ── */}
            {localMediaViewer.type === 'video' && localMediaViewer.uri && (
              <Video
                ref={ref => { videoRefs.current[localMediaViewer.uri] = ref; }}
                source={{ uri: localMediaViewer.uri }}
                style={{ width: '100%', height: '100%' }}
                useNativeControls
                resizeMode={ResizeMode.CONTAIN}
                shouldPlay
              />
            )}

            {/* ── Saved toast ── */}
            {viewerSavedToast && (
              <View style={{
                position: 'absolute', bottom: 30, alignSelf: 'center', zIndex: 30,
                backgroundColor: 'rgba(0,0,0,0.75)', borderRadius: 20,
                paddingHorizontal: 18, paddingVertical: 10,
                flexDirection: 'row', alignItems: 'center', gap: 8,
              }}>
                <Ionicons name="checkmark-circle" size={18} color="#25D366" />
                <Text style={{ color: '#fff', fontSize: 13, fontFamily: 'Roboto-Medium' }}>Saved</Text>
              </View>
            )}

          </View>
        </Modal>

        {/* Contact detail modal — WhatsApp style */}
        <Modal visible={contactViewer.visible} transparent animationType="slide" onRequestClose={() => setContactViewer({ visible: false, data: null })}>
          <ContactDetailSheet
            data={contactViewer.data}
            theme={theme}
            isDarkMode={isDarkMode}
            onClose={() => setContactViewer({ visible: false, data: null })}
            onMessageContact={(userId, name, profilePicture) => {
              setContactViewer({ visible: false, data: null });
              navigation.navigate('ChatScreen', {
                user: { _id: userId, userId, id: userId, name, fullName: name, profilePicture: profilePicture || '' },
                chatId: null,
                hasExistingChat: false,
              });
            }}
          />
        </Modal>
      {/* Reaction Detail Sheet — shows who reacted */}
      <ReactionDetailSheet
        visible={reactionDetailModal.visible}
        reactions={reactionDetailModal.reactions}
        selectedEmoji={reactionDetailModal.selectedEmoji}
        messageId={reactionDetailModal.messageId}
        onClose={() => setReactionDetailModal({ visible: false, reactions: null, selectedEmoji: null, messageId: null })}
        onRemoveReaction={(emoji) => {
          if (reactionDetailModal.messageId) {
            removeReaction(reactionDetailModal.messageId, emoji);
            setReactionDetailModal({ visible: false, reactions: null, selectedEmoji: null, messageId: null });
          }
        }}
        currentUserId={currentUserId}
        isDarkMode={isDarkMode}
        themeColor={theme.colors.themeColor}
        primaryTextColor={theme.colors.primaryTextColor}
        placeholderColor={theme.colors.placeHolderTextColor}
        getReactionUserName={getReactionUserName}
        groupMembersMap={groupMembersMap}
        peerUser={chatData?.peerUser}
        fetchReactionList={fetchReactionList}
      />

      {/* Report Modal */}
      <ReportBottomSheet
        visible={reportModalVisible}
        onClose={() => setReportModalVisible(false)}
        onSuccess={() => clearSelectedMessages()}
        payload={reportPayload}
        analytics={reportAnalytics}
      />

      {/* Schedule Time Picker is rendered inside ChatInputBar */}
      </Animated.View>
    </View>
  );
}