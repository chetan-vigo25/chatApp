
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
  StyleSheet,
  DeviceEventEmitter
} from "react-native";
import moment from "moment";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as Location from "expo-location";
import * as Contacts from "expo-contacts";
import { suspendAppLock, resumeAppLock } from "../../services/appLockGuard";
import useDelayedVisible from "../../hooks/useDelayedVisible";
import { useTheme } from "../../contexts/ThemeContext";
import { useNetwork } from "../../contexts/NetworkContext";
import { FontAwesome6, AntDesign, Ionicons, MaterialIcons, MaterialCommunityIcons, Entypo } from "@expo/vector-icons";
import useChatLogic from "../../contexts/useChatLogic";
import { useSelector, useDispatch } from "react-redux";
import { unblockUser } from "../../Redux/Reducer/Block/Block.reducer";
import ChatHeaderPresence from "../../presence/components/ChatHeaderPresence";
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { BlurView } from 'expo-blur';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Circle as SvgCircle } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import * as IntentLauncher from 'expo-intent-launcher';
import { Video, ResizeMode, Audio } from 'expo-av';
import { ImageZoom } from '@likashefqet/react-native-image-zoom';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MEDIA_DOWNLOAD_STATUS } from '../../services/MediaDownloadManager';
import localStorageService from '../../services/LocalStorageService';
import { mediaDownloadSigned, toSecureMediaUri } from '../../utils/mediaService';
import ReportBottomSheet from '../../components/ReportBottomSheet';
import ChatWallpaper from '../../components/ChatWallpaper';
import MentionSuggestions, { useMentions } from '../../components/MentionInput';
import MentionText from '../../components/MentionText';
import ReplyPreviewBox from '../../components/ReplyPreviewBox';
import ScheduleTimePicker from '../../components/ScheduleTimePicker';
import ReplyBubble from '../../components/ReplyBubble';
import StatusReplyPreview from '../../components/StatusReplyPreview';
import { statusServices } from '../../Redux/Services/Status/Status.Services';
import LocationBubble from '../../components/LocationBubble';
import AlbumMessage from '../../components/AlbumMessage';
import ReactionPicker from '../../components/ReactionPicker';
import ReactionBar from '../../components/ReactionBar';
import ReactionDetailSheet from '../../components/ReactionDetailSheet';
import SaveContactBanner from '../../components/SaveContactBanner';
import useSaveContact from '../../hooks/useSaveContact';
import useContactDirectory from '../../hooks/useContactDirectory';
import * as ScreenCapture from 'expo-screen-capture';
import { getSocket, isSocketConnected } from '../../Redux/Services/Socket/socket';
import CallButtons from '../../calls/components/CallButtons';
import GroupCallButtons from '../../calls/components/GroupCallButtons';
import CallMessageBubble from '../../calls/components/CallMessageBubble';

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

// WhatsApp-style attachment tiles: solid two-tone gradient discs with a white
// glyph. `grad` is [topColor, bottomColor] for the vertical gradient fill.
const MEDIA_PANEL_OPTIONS = [
  { key: 'gallery', label: 'Gallery', icon: 'images', iconFamily: 'Ionicons', grad: ['#C13BCB', '#8A2BE6'], color: '#A431D8' },
  { key: 'camera', label: 'Camera', icon: 'camera', iconFamily: 'Ionicons', grad: ['#FF5E7E', '#F0264B'], color: '#F73A5C' },
  { key: 'video', label: 'Video', icon: 'videocam', iconFamily: 'Ionicons', grad: ['#FF7A59', '#F4452B'], color: '#F75A3A' },
  { key: 'document', label: 'Document', icon: 'document-text', iconFamily: 'Ionicons', grad: ['#7E72FF', '#5B43E8'], color: '#6B57F0' },
  { key: 'audio', label: 'Audio', icon: 'headset', iconFamily: 'Ionicons', grad: ['#FFA836', '#FF7A00'], color: '#FF8A1B' },
  { key: 'contact', label: 'Contact', icon: 'person', iconFamily: 'Ionicons', grad: ['#37A4FF', '#137FE8'], color: '#1E8FF5' },
  { key: 'location', label: 'Location', icon: 'location', iconFamily: 'Ionicons', grad: ['#3BD17A', '#16A34A'], color: '#23B85F' },
];

// WhatsApp attachment disc — a true vertical gradient circle (SVG) with a white
// glyph centred on top. Drop shadow tinted to the disc colour gives the lift.
function GradientDisc({ id, grad = ['#888', '#666'], color = '#777', icon, size = 54 }) {
  const gid = `mediaDisc-${id}`;
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: color,
        shadowOpacity: 0.4,
        shadowRadius: 7,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
      }}
    >
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Defs>
          <SvgLinearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={grad[0]} />
            <Stop offset="1" stopColor={grad[1]} />
          </SvgLinearGradient>
        </Defs>
        <SvgCircle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${gid})`} />
      </Svg>
      <Ionicons name={icon} size={Math.round(size * 0.45)} color="#fff" />
    </View>
  );
}

// Theme-aware chat wallpaper. Rendered as a tiled SVG doodle pattern
// (WhatsApp-style) — see components/ChatWallpaper. No raster image assets.

const EMOJI_SECTIONS = {
  smileys: [
    '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '🫠', '😉', '😊', '😇',
    '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤑',
    '🤗', '🤭', '🫢', '🫣', '🤫', '🤔', '🫡', '🤐', '🤨', '😐', '😑', '😶', '🫥', '😏',
    '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮',
    '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐', '😕', '🫤',
    '😟', '🙁', '😮', '😯', '😲', '😳', '🥺', '🥹', '😦', '😧', '😨', '😰', '😥', '😢',
    '😭', '😱', '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '😈',
    '👿', '💀', '💩', '🤡', '👹', '👺', '👻', '👽', '🤖', '😺', '😸', '😹', '😻', '😼',
  ],
  gestures: [
    '👋', '🤚', '🖐️', '✋', '🖖', '🫱', '🫲', '🫳', '🫴', '👌', '🤌', '🤏', '✌️', '🤞',
    '🫰', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍', '👎', '✊', '👊',
    '🤛', '🤜', '👏', '🙌', '🫶', '👐', '🤲', '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦵',
    '🦶', '👂', '👃', '🧠', '👀', '👁️', '👅', '👄', '🫦', '💋', '🩸', '💯', '💢', '💥',
  ],
  animals: [
    '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐻‍❄️', '🐨', '🐯', '🦁', '🐮', '🐷',
    '🐸', '🐵', '🙈', '🙉', '🙊', '🐒', '🐔', '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🦇',
    '🐺', '🐗', '🐴', '🦄', '🐝', '🪲', '🐛', '🦋', '🐌', '🐞', '🐜', '🦗', '🕷️', '🦂',
    '🐢', '🐍', '🦎', '🦖', '🐙', '🦑', '🦐', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋',
    '🦈', '🐊', '🐅', '🐆', '🦓', '🦍', '🦣', '🐘', '🦏', '🐪', '🐫', '🦒', '🦘', '🐃',
    '🐎', '🐖', '🐏', '🐑', '🐐', '🦌', '🐕', '🐩', '🐈', '🐓', '🦃', '🦚', '🦜', '🐉',
    '🌵', '🌲', '🌳', '🌴', '🌱', '🌿', '☘️', '🍀', '🎋', '🍃', '🍂', '🍁', '🌾', '🌷',
    '🌹', '🥀', '🌺', '🌸', '🌼', '🌻', '🌞', '🌝', '🌙', '⭐', '🌟', '✨', '⚡', '🔥',
  ],
  food: [
    '🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭',
    '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶️', '🫑', '🌽', '🥕', '🫒',
    '🧄', '🧅', '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇',
    '🥓', '🥩', '🍗', '🍖', '🌭', '🍔', '🍟', '🍕', '🥪', '🌮', '🌯', '🫔', '🥗', '🥘',
    '🍝', '🍜', '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠',
    '🍢', '🍡', '🍧', '🍨', '🍦', '🥧', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬', '🍫', '🍿',
    '🍩', '🍪', '🌰', '🥜', '🍯', '🥛', '🍼', '☕', '🍵', '🧃', '🥤', '🧋', '🍺', '🍷',
  ],
  activities: [
    '⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒',
    '🏑', '🥍', '🏏', '🥅', '⛳', '🪁', '🎣', '🤿', '🎽', '🛹', '🛼', '🛷', '⛸️', '🥌',
    '🎿', '⛷️', '🏂', '🏋️', '🤼', '🤸', '⛹️', '🤺', '🤾', '🏌️', '🏇', '🧘', '🏄', '🏊',
    '🤽', '🚣', '🧗', '🚵', '🚴', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖️', '🎗️', '🎫', '🎟️',
    '🎪', '🤹', '🎭', '🎨', '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🎷', '🎺', '🎸', '🪕',
    '🎻', '🎲', '♟️', '🎯', '🎳', '🎮', '🕹️', '🎰', '🧩', '🎉', '🎊', '🎈', '🎁', '🎀',
  ],
  travel: [
    '🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🚛', '🚜',
    '🦯', '🦽', '🦼', '🛴', '🚲', '🛵', '🏍️', '🛺', '🚨', '🚔', '🚍', '🚘', '🚖', '🚡',
    '🚠', '🚟', '🚃', '🚋', '🚞', '🚝', '🚄', '🚅', '🚈', '🚂', '🚆', '🚇', '🚊', '🚉',
    '✈️', '🛫', '🛬', '🛩️', '💺', '🛰️', '🚀', '🛸', '🚁', '🛶', '⛵', '🚤', '🛥️', '🛳️',
    '⛴️', '🚢', '⚓', '⛽', '🚧', '🚦', '🚥', '🗺️', '🗿', '🗽', '🗼', '🏰', '🏯', '🏟️',
    '🎡', '🎢', '🎠', '⛲', '⛱️', '🏖️', '🏝️', '🏜️', '🌋', '⛰️', '🏔️', '🗻', '🏕️', '⛺',
  ],
  objects: [
    '⌚', '📱', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '💽', '💾', '💿', '📷', '📸', '📹', '🎥',
    '📞', '☎️', '📟', '📠', '📺', '📻', '🎙️', '⏰', '⏱️', '⏲️', '🕰️', '🔋', '🔌', '💡',
    '🔦', '🕯️', '🧯', '🛢️', '💸', '💵', '💴', '💶', '💷', '🪙', '💰', '💳', '💎', '⚖️',
    '🔧', '🔨', '⚒️', '🛠️', '🪛', '🔩', '⚙️', '🧰', '🧲', '🔫', '💣', '🪦', '🔪', '🗡️',
    '🚪', '🪑', '🚽', '🚿', '🛁', '🧴', '🧷', '🧹', '🧺', '🧻', '🪣', '🧼', '🪥', '🧽',
    '🔑', '🗝️', '🔒', '🔓', '📦', '📫', '📬', '📭', '✉️', '📧', '📝', '📚', '📖', '🔖',
  ],
  symbols: [
    '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓',
    '💗', '💖', '💘', '💝', '💟', '☮️', '✝️', '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️',
    '☦️', '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓',
    '🆔', '⚛️', '🉑', '☢️', '☣️', '📴', '📳', '🈶', '🈚', '🈸', '🈺', '🈷️', '✴️', '🆚',
    '✅', '❎', '➕', '➖', '➗', '✖️', '♾️', '‼️', '⁉️', '❓', '❔', '❕', '❗', '〰️',
    '🔆', '🔅', '⚠️', '🚸', '🔱', '⚜️', '🔰', '♻️', '✳️', '❇️', '💲', '💱', '©️', '®️',
  ],
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
      duration: 100,
      useNativeDriver: true,
    }).start();
  }, [sendAnim, hasContent]);

  useEffect(() => {
    Animated.timing(attachAnim, {
      toValue: showAttachment ? 1 : 0,
      duration: 100,
      useNativeDriver: false,
    }).start();
  }, [attachAnim, showAttachment]);

  useEffect(() => {
    Animated.timing(inputAnimHeight, {
      toValue: Math.max(36, Number(inputHeight || 36)),
      duration: 80,
      useNativeDriver: false,
    }).start();
  }, [inputAnimHeight, inputHeight]);

  const handlePressInSubmit = () => {
    Animated.timing(submitScale, {
      toValue: 0.94,
      duration: 60,
      useNativeDriver: true,
    }).start();
  };

  const handlePressOutSubmit = () => {
    Animated.timing(submitScale, {
      toValue: 1,
      duration: 60,
      useNativeDriver: true,
    }).start();
  };

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingHorizontal: 10,
        paddingTop: 8,
        paddingBottom: Platform.OS === 'ios' ? 12 : 10,
        // backgroundColor: theme.colors.background,
        backgroundColor: 'transparent',
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
          backgroundColor: theme.colors.cardBackground,
          borderWidth: 1.5,
          borderColor: isInputFocused ? theme.colors.themeColor : 'transparent',
          justifyContent: 'center',
          overflow: 'hidden',
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 3 },
          shadowOpacity: 0.08,
          shadowRadius: 8,
          elevation: 1,
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
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  {pendingMedia.isAlbum ? (
                    <>
                      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        {(pendingMedia.files || []).slice(0, 4).map((f, i) => (
                          <Image
                            key={`${f.uri}_${i}`}
                            source={{ uri: f.uri }}
                            style={{ width: 34, height: 34, borderRadius: 8, marginLeft: i === 0 ? 0 : -10, borderWidth: 1.5, borderColor: '#00000022' }}
                          />
                        ))}
                      </View>
                      <Text style={{ color: pendingTextColor, flex: 1, fontSize: 13 }} numberOfLines={1}>
                        {(pendingMedia.files || []).length} items selected
                      </Text>
                    </>
                  ) : (
                    <>
                      <Image source={{ uri: pendingMedia.file.uri }} style={{ width: 34, height: 34, borderRadius: 8 }} />
                      <Text style={{ color: pendingTextColor, flex: 1, fontSize: 13 }} numberOfLines={2}>
                        {pendingMedia.file.name || 'Media ready to send'}
                      </Text>
                    </>
                  )}
                  <TouchableOpacity
                    onPress={onRemovePendingMedia}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel="Remove selected media"
                  >
                    <Ionicons name="close-circle" size={20} color={iconColor} />
                  </TouchableOpacity>
                </View>
                {pendingMedia.isAlbum ? (
                  <TextInput
                    placeholder="Add a caption..."
                    value={text}
                    onChangeText={onTextChange}
                    placeholderTextColor={placeholderColor}
                    accessibilityLabel="Album caption input"
                    style={{ fontSize: 14, color: pendingTextColor, paddingVertical: 2 }}
                  />
                ) : null}
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
          // onLongPress={hasContent ? () => setShowSchedulePicker(true) : undefined}
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
              ? (chatColor || 'rgba(0,168,132,0.5)')
              : (chatColor || '#00A884'),
            alignItems: 'center',
            justifyContent: 'center',
            opacity: 1,
            shadowColor: chatColor || '#00A884',
            shadowOffset: { width: 0, height: 6 },
            shadowOpacity: 0.42,
            shadowRadius: 10,
            elevation: 8,
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
      Animated.timing(translateX, { toValue: 0, duration: 120, useNativeDriver: true }).start();
    },
    onPanResponderTerminate: () => {
      Animated.timing(translateX, { toValue: 0, duration: 120, useNativeDriver: true }).start();
    },
  })).current;

  return (
    <Animated.View {...panResponder.panHandlers} style={{ transform: [{ translateX }] }}>
      {children}
    </Animated.View>
  );
});

// Deterministic pseudo-waveform bar heights (0.15..1) from a stable seed string
// (the message id) so the bars look identical on every render and across the two
// participants, without needing real amplitude data. Envelope keeps the middle
// bars a touch taller for a natural WhatsApp voice-note shape.
const makeWaveBars = (seed, count) => {
  let h = 2166136261;
  const s = String(seed || 'a');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let x = (h >>> 0) || 1;
  const bars = [];
  for (let i = 0; i < count; i++) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    const r = (x % 1000) / 1000; // 0..1
    const env = Math.sin((i / Math.max(1, count - 1)) * Math.PI); // taller mid
    const v = 0.2 + r * 0.8 * (0.45 + 0.55 * env);
    bars.push(Math.max(0.15, Math.min(1, v)));
  }
  return bars;
};

// ── WhatsApp-style seekable voice-note waveform ──
const AudioSeekBar = React.memo(function AudioSeekBar({
  isThisPlaying, isDownloading, totalMs, seekRatio, progress,
  trackBg, trackFill, subColor, posLabel, durLabel, dlStatus, onSeek, seedKey,
}) {
  const widthRef = useRef(0);
  const canSeekRef = useRef(false);
  const onSeekRef = useRef(onSeek);
  const totalMsRef = useRef(totalMs);
  const draggingRef = useRef(false);

  const [trackW, setTrackW] = useState(0);
  const [displayRatio, setDisplayRatio] = useState(0);
  const [dragLabel, setDragLabel] = useState(null);

  const canSeek = isThisPlaying && totalMs > 0;
  canSeekRef.current = canSeek;
  onSeekRef.current = onSeek;
  totalMsRef.current = totalMs;

  // Follow playback position when the user isn't actively scrubbing. Guard with
  // a functional equality bail so an unchanged ratio never triggers a redundant
  // re-render (prevents any setState feedback loop).
  useEffect(() => {
    if (draggingRef.current) return;
    setDisplayRatio((prev) => (prev === seekRatio ? prev : seekRatio));
  }, [seekRatio]);

  const BAR_W = 2.6;
  const BAR_GAP = 2;
  const BAR_MAX_H = 22;
  const barCount = Math.max(14, Math.floor((trackW || 150) / (BAR_W + BAR_GAP)));
  const bars = useMemo(() => makeWaveBars(seedKey, barCount), [seedKey, barCount]);

  const ratioFromX = (x) => Math.min(1, Math.max(0, x / (widthRef.current || 1)));
  const formatMsLabel = (ms) => {
    const s = Math.floor((ms || 0) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => canSeekRef.current,
    onMoveShouldSetPanResponder: (_, gs) => canSeekRef.current && Math.abs(gs.dx) > 1,
    onPanResponderGrant: (evt) => {
      if (!canSeekRef.current) return;
      draggingRef.current = true;
      const r = ratioFromX(evt.nativeEvent.locationX);
      setDisplayRatio(r);
      setDragLabel(formatMsLabel(r * totalMsRef.current));
    },
    onPanResponderMove: (evt) => {
      if (!draggingRef.current) return;
      const r = ratioFromX(evt.nativeEvent.locationX);
      setDisplayRatio(r);
      setDragLabel(formatMsLabel(r * totalMsRef.current));
    },
    onPanResponderRelease: (evt) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      const r = ratioFromX(evt.nativeEvent.locationX);
      setDisplayRatio(r);
      setDragLabel(null);
      onSeekRef.current?.(r);
    },
    onPanResponderTerminate: () => {
      draggingRef.current = false;
      setDragLabel(null);
    },
  }), []);

  // While downloading, fill the bars to the download progress; otherwise to the
  // playback / scrub position.
  const fillRatio = isDownloading ? Math.max(0, Math.min(1, progress || 0)) : displayRatio;
  const showThumb = canSeek || (isThisPlaying && displayRatio > 0);
  const shownPosLabel = dragLabel !== null
    ? dragLabel
    : (isThisPlaying ? posLabel : durLabel);

  return (
    <View style={{ flex: 1, marginLeft: 10 }}>
      <View
        onLayout={(e) => {
          const w = Math.round(e.nativeEvent.layout.width);
          widthRef.current = w;
          // Integer + functional bail: identical/near-identical layout widths
          // never cause a re-render, so bar-count churn can't feed back a loop.
          setTrackW((prev) => (prev === w ? prev : w));
        }}
        {...panResponder.panHandlers}
        style={{ height: 30, justifyContent: 'center' }}
      >
        {/* Waveform bars */}
        <View style={{ flexDirection: 'row', alignItems: 'center', height: BAR_MAX_H }}>
          {bars.map((bh, i) => {
            const filled = (i + 0.5) / barCount <= fillRatio;
            return (
              <View
                key={i}
                style={{
                  width: BAR_W,
                  marginRight: BAR_GAP,
                  height: Math.max(3, bh * BAR_MAX_H),
                  borderRadius: BAR_W,
                  backgroundColor: filled ? trackFill : trackBg,
                }}
              />
            );
          })}
        </View>

        {/* Playhead dot */}
        {showThumb && trackW > 0 && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: Math.min(trackW - 6, Math.max(-6, fillRatio * trackW - 6)),
              top: 9,
              width: 12,
              height: 12,
              borderRadius: 6,
              backgroundColor: trackFill,
              elevation: 2,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 1 },
              shadowOpacity: 0.18,
              shadowRadius: 1.5,
            }}
          />
        )}
      </View>

      {/* Single duration/elapsed label (WhatsApp shows total when idle, elapsed
          while playing). Message time + ticks come from the media time overlay. */}
      <Text style={{ color: subColor, fontSize: 11, fontFamily: 'Roboto-Regular', marginTop: 1 }}>
        {isDownloading
          ? `${Math.round((progress || 0) * 100)}%`
          : dlStatus === MEDIA_DOWNLOAD_STATUS.FAILED
            ? 'Failed'
            : shownPosLabel}
      </Text>
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

  const bgColor = isDarkMode ? '#0b141a' : '#f5f5f5';
  const cardBg = isDarkMode ? '#1a2b3c' : '#fff';
  const textColor = isDarkMode ? '#EDF6FC' : '#111';
  const subColor = isDarkMode ? 'rgba(200,216,228,0.6)' : '#666';
  const accentColor = theme.colors.themeColor || '#00A884';
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
            <Text style={{ fontSize: 13, color: '#25D366', fontFamily: 'Roboto-Medium' }}>On TalksTry</Text>
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

// ─── Chat menu sheet — polished bottom sheet item ──────────────────────
// A single tappable row inside the redesigned 3-dot menu. Uses a tinted
// circular icon + label (+ optional sublabel) to match the production design
// vocabulary already established by the ChatList action sheet.
const ChatMenuItem = ({ label, sublabel, onPress, theme, isDanger = false }) => (
  <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={chatMenuStyles.menuItem}>
    <View style={{ flex: 1 }}>
      <Text style={[chatMenuStyles.menuItemLabel, { color: isDanger ? '#E06A6A' : theme.colors.primaryTextColor }]}>
        {label}
      </Text>
      {sublabel ? (
        <Text style={[chatMenuStyles.menuItemSub, { color: theme.colors.placeHolderTextColor }]}>
          {sublabel}
        </Text>
      ) : null}
    </View>
  </TouchableOpacity>
);

const chatMenuStyles = StyleSheet.create({
  // Popover container — fills the screen so taps outside dismiss
  popoverRoot: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  // The dropdown card itself — anchored near the top-right where the 3-dot
  // button lives. Compact width, soft elevation, hairline border for a
  // premium feel in both light and dark themes.
  popoverCard: {
    position: 'absolute',
    top: Platform.select({ ios: 92, android: 80 }),
    right: 10,
    // Size to content — no fixed width. minWidth keeps short labels readable;
    // maxWidth caps a long label from stretching across the screen.
    minWidth: 170,
    maxWidth: 260,
    borderRadius: 16,
    paddingVertical: 6,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.22,
    shadowRadius: 22,
    elevation: 18,
  },
  popoverDivider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 6,
    marginHorizontal: 10,
  },

  // Menu item rows — text-only, WhatsApp-style compact list
  menuItem: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    marginHorizontal: 4,
  },
  menuItemLabel: { fontFamily: 'Roboto-Medium', fontSize: 14.5, letterSpacing: 0.1 },
  menuItemSub: { fontFamily: 'Roboto-Regular', fontSize: 11.5, letterSpacing: 0.2, marginTop: 2 },

  // Confirm modal
  confirmOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  confirmCard: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 22,
    paddingVertical: 24,
    paddingHorizontal: 22,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.22,
    shadowRadius: 18,
    elevation: 14,
  },
  confirmIconWrap: {
    width: 60,
    height: 60,
    borderRadius: 20,
    backgroundColor: '#E06A6A18',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  confirmTitle: { fontFamily: 'Roboto-SemiBold', fontSize: 17, letterSpacing: 0.1, textAlign: 'center' },
  confirmSubtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    lineHeight: 19,
    letterSpacing: 0.2,
    textAlign: 'center',
    marginTop: 8,
  },
  confirmActions: {
    flexDirection: 'row',
    width: '100%',
    gap: 10,
    marginTop: 22,
  },
  confirmCancelBtn: {
    flex: 1,
    height: 46,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmCancelText: { fontFamily: 'Roboto-SemiBold', fontSize: 14, letterSpacing: 0.2 },
  confirmDangerBtn: {
    flex: 1,
    height: 46,
    borderRadius: 14,
    backgroundColor: '#E06A6A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmDangerText: { fontFamily: 'Roboto-SemiBold', fontSize: 14, color: '#fff', letterSpacing: 0.2 },
});

export default function ChatScreen({ navigation, route }) {
  // Reporting state
  const [reportModalVisible, setReportModalVisible] = useState(false);
  const [reportPayload, setReportPayload] = useState({});
  // Tracks media whose local downloaded file failed to render, so we fall back
  // to the remote https URL (keyed by message key).
  const [failedLocalMedia, setFailedLocalMedia] = useState({});
  const [replyHighlightId, setReplyHighlightId] = useState(null);
  const replyHighlightTimer = useRef(null);
  const [reportAnalytics, setReportAnalytics] = useState({
    report_opened: () => {/* analytics event */},
    report_submitted: () => {/* analytics event */},
    report_failed: () => {/* analytics event */},
  });

  // Open report modal for message (uses chatDataRef to avoid TDZ on web)
  const chatDataRef = useRef(null);
  const handleReportMessage = useCallback((msg) => {
    const cd = chatDataRef.current;
    setReportPayload({
      reportType: 'message',
      chatId: cd?.chatId || cd?._id || route?.params?.chatId,
      messageId: msg.id || msg.serverMessageId || msg.tempId,
      reportedUserId: msg.senderId,
    });
    setReportModalVisible(true);
  }, [route]);

  // Open report modal for chat
  const handleReportChat = useCallback(() => {
    const cd = chatDataRef.current;
    setReportPayload({
      reportType: 'chat',
      chatId: cd?.chatId || cd?._id || route?.params?.chatId,
      reportedUserId: cd?.peerUser?._id || cd?.peerUser?.userId,
    });
    setReportModalVisible(true);
  }, [route]);

  // Add report chat option to menu
  const handleMenuReportChat = () => {
    setShowMenu(false);
    handleReportChat();
  };

  // Tap the status-reply preview pill in a chat bubble → open the StatusViewer
  // for that owner. We try the live status first so the viewer can render the
  // full slideshow (with reactions, viewers, etc.). If that fails for any
  // reason (expired, network, auth) we silently fall back to a single-card
  // viewer seeded from the snapshot we captured at reply-time, so the user
  // still sees the status they originally replied to.
  const handleOpenStatusFromChat = useCallback(async (statusRef, statusPreview) => {
    const buildSnapshotStatus = () => ({
      _id:         statusRef,
      ownerId:     statusPreview?.ownerId || null,
      mediaItems: [{
        _id:          `${statusRef}_snap`,
        mediaType:    statusPreview?.mediaType || 'text',
        mediaUrl:     statusPreview?.mediaUrl || null,
        thumbnailUrl: statusPreview?.thumbnailUrl || statusPreview?.mediaUrl || null,
        order:        0,
      }],
      caption:     statusPreview?.text || null,
      textContent: statusPreview?.text || null,
      bgColor:     statusPreview?.backgroundColor || '#075e54',
      createdAt:   statusPreview?.createdAt || new Date().toISOString(),
      expiresAt:   null,
      viewCount:   0,
      likeCount:   0,
      dislikeCount: 0,
      replyCount:  0,
      myReaction:  null,
      _isExpiredSnapshot: true,
    });

    const ownerIdForResolve = String(statusPreview?.ownerId || '');
    const isOwnStatusNav = currentUserId && ownerIdForResolve === String(currentUserId);
    const resolvedNavName = isOwnStatusNav
      ? (statusPreview?.ownerName || 'You')
      : resolveContactName(
          ownerIdForResolve,
          statusPreview?.ownerName,
          statusPreview?.ownerPhone || statusPreview?.phone
        );

    const navigateWithSnapshot = () => {
      const fallback = buildSnapshotStatus();
      navigation.navigate('StatusViewer', {
        statuses:   [fallback],
        startIndex: 0,
        isMine:     isOwnStatusNav,
        userName:   resolvedNavName,
        userImage:  '',
        userId:     ownerIdForResolve,
      });
    };

    try {
      const resp = await statusServices.getStatusById(statusRef);
      const live = resp?.data?.status || resp?.data;

      if (live && (live._id || live.id)) {
        const ownerIdStr = String(live.ownerId?._id || live.ownerId || statusPreview?.ownerId || '');
        const isMine     = currentUserId && String(currentUserId) === ownerIdStr;
        // Prefer the saved contact name; fall back to live profile name, then
        // the snapshot's server name. Phone number is used if none are saved.
        const liveName = isMine
          ? (live.ownerId?.fullName || 'You')
          : resolveContactName(
              ownerIdStr,
              live.ownerId?.fullName || statusPreview?.ownerName,
              live.ownerId?.mobile?.number || statusPreview?.ownerPhone
            );
        navigation.navigate('StatusViewer', {
          statuses:  [live],
          startIndex: 0,
          isMine,
          userName:  liveName,
          userImage: live.ownerId?.profileImage || '',
          userId:    ownerIdStr,
        });
        return;
      }

      // Live fetch returned null/empty (expired, hidden, etc.) — silently use
      // the snapshot. The viewer will render the preview without the live-only
      // affordances (reactions, view count) which is fine for an old status.
      navigateWithSnapshot();
    } catch {
      navigateWithSnapshot();
    }
  }, [navigation, currentUserId, resolveContactName]);

  const { theme, chatColor, isDarkMode } = useTheme();
  const { isConnected, networkType } = useNetwork();
  const { width: windowWidth } = useWindowDimensions();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  // Frame-synced keyboard height from react-native-keyboard-controller. Tracks the
  // native keyboard 1:1 on iOS + Android (60fps, no jump). `height` is negative
  // while the keyboard is up; we subtract the bottom inset so the input sits flush
  // against the keyboard (no nav-bar gap). Clamped at 0 so resting layout is unchanged.
  const { height: kbHeightSV } = useReanimatedKeyboardAnimation();
  const insets = useSafeAreaInsets();
  const rootKeyboardStyle = useAnimatedStyle(() => ({
    paddingBottom: Math.max(0, Math.abs(kbHeightSV.value) - insets.bottom),
  }), [insets.bottom]);
  const [isAtTop, setIsAtTop] = useState(false);
  const [isAtLatest, setIsAtLatest] = useState(true);
  const [showSearchBar, setShowSearchBar] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  // Manual "load older messages" spinner for the 3-dots menu action.
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  // WhatsApp-style dropdown — pop-in from the top-right corner via combined
  // scale + opacity. Origin is set so the transform appears to grow out of
  // the 3-dot button rather than from the center.
  const menuScaleAnim = useRef(new Animated.Value(0.85)).current;
  const menuOpacityAnim = useRef(new Animated.Value(0)).current;
  // Clear-chat confirmation modal (delete for me)
  const [clearChatModalVisible, setClearChatModalVisible] = useState(false);
  const [isClearingChat, setIsClearingChat] = useState(false);
  // Delete-for-everyone confirmation modal (soft-deletes the chat on both sides)
  const [deleteEveryoneModalVisible, setDeleteEveryoneModalVisible] = useState(false);
  const [isDeletingEveryone, setIsDeletingEveryone] = useState(false);
  // Draggable peer-details bottom sheet (opened by tapping the header avatar)
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
  // Broadcast-channel media is public (uploaded via the Status media pipeline)
  // and one-way — there's no per-user mediaId to sign a download with. So we
  // render it straight from the remote URL, exactly like the web client, rather
  // than gating it behind the 1-1 download flow (which would never resolve).
  const isBroadcastMedia = (msg) =>
    Boolean((chatData?.chatType === 'broadcast' || chatData?.isBroadcast) &&
      (msg?.mediaUrl || msg?.mediaThumbnailUrl || msg?.previewUrl));

  const isMediaDownloaded = (msg) => {
    if (!msg) return false;

    // Broadcast media is always "available" — served directly from its remote URL.
    if (isBroadcastMedia(msg)) return true;

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

    // Broadcast media resolves straight to its (secure) remote URL — no local
    // download file exists, and web renders the same URL directly.
    if (isBroadcastMedia(msg)) {
      const remote = msg.mediaUrl || msg.mediaThumbnailUrl || msg.previewUrl;
      if (remote) return toSecureMediaUri(remote);
    }

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
    amNotGroupMember,
    liveMemberCount,
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
    promptDeleteSingleMessage,
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
    sendMediaGroup,
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
    isBackfilling,
    hasMoreMessages,
    onRefresh,
    loadMoreMessages,
    currentUserId,
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

  // ── First-paint loading UX (local-first + spinner) ────────────────────────
  // Messages render from SQLite instantly. A small spinner appears ONLY if
  // that local read is slow (>200ms) and, once shown, stays ≥300ms so it never
  // flickers (useDelayedVisible). A long stall with nothing loaded surfaces a
  // retry. Sub-threshold loads fall straight through to the list — no flash.
  const initialLoading = isLoadingInitial && messages.length === 0;
  const showSkeleton = useDelayedVisible(initialLoading, { delay: 200, minVisible: 300 });
  const [loadTimedOut, setLoadTimedOut] = useState(false);
  useEffect(() => {
    if (!initialLoading) { setLoadTimedOut(false); return undefined; }
    const t = setTimeout(() => setLoadTimedOut(true), 12000);
    return () => clearTimeout(t);
  }, [initialLoading]);

  // A blocked user (set by an admin) can still browse chats but cannot send.
  // The server rejects sends too; this just gives immediate feedback.
  const amBlocked = useSelector((s) => s?.profile?.isBlocked);

  // My avatar — shown on the sender side of a voice-note bubble (WhatsApp shows
  // the SENDER's avatar with a mic badge next to the waveform).
  const myProfileImage = useSelector((s) =>
    s?.profile?.profileData?.profileImage
    || s?.profile?.profileData?.profileImageThumbnailUrl
    || null,
  );

  // User-to-user (contact) block state for this 1-1 chat. `iBlockedPeer` hides
  // the composer with an Unblock CTA; `peerBlockedMe` silently disables sending.
  const chatPeerId = chatData?.peerUser?._id || chatData?.peerUserId || null;
  const iBlockedPeer = useSelector((s) =>
    chatPeerId ? (s?.block?.blockedIds || []).map(String).includes(String(chatPeerId)) : false,
  );
  const peerBlockedMe = useSelector((s) =>
    chatPeerId ? (s?.block?.blockedByIds || []).map(String).includes(String(chatPeerId)) : false,
  );
  const blockDispatch = useDispatch();

  // Live verified-badge override for the header. chatData is built from static
  // route params, so when an admin toggles the badge while this thread is open
  // the realtime `profile:update` path (RealtimeChatContext) re-emits it here.
  const [liveVerified, setLiveVerified] = useState(null);
  useEffect(() => {
    if (!chatPeerId) return undefined;
    const sub = DeviceEventEmitter.addListener('peer:profile:updated', (p) => {
      if (p && String(p.userId) === String(chatPeerId) && typeof p.isVerified === 'boolean') {
        setLiveVerified(p.isVerified);
      }
    });
    return () => sub.remove();
  }, [chatPeerId]);

  // Sync chatData to ref for callbacks declared before destructuring (web TDZ fix)
  useEffect(() => { chatDataRef.current = chatData; }, [chatData]);

  // Screenshot detection — notifies the peer that this user captured the chat.
  // Silent for the screenshotter (the system message is hidden on their side
  // server-side via deletedFor + skipped chat-summary update).
  //
  // Why permissions: on Android, expo-screen-capture's listener is backed by a
  // ContentObserver on MediaStore. Without READ_MEDIA_IMAGES / READ_EXTERNAL_STORAGE
  // the observer never receives change notifications, so the listener silently
  // never fires — that's the "some devices don't notify" bug. We request the
  // permission lazily right before subscribing.
  useEffect(() => {
    const isGroup = Boolean(chatData?.chatType === 'group' || chatData?.isGroup);
    if (isGroup) return undefined;

    const peerId = chatData?.peerUser?._id || chatData?.peerUserId;
    const cid = chatData?.chatId || chatData?._id || route?.params?.chatId;
    if (!peerId || !cid) return undefined;

    let sub = null;
    let cancelled = false;

    const onScreenshot = () => {
      try {
        const socket = getSocket();
        if (socket && isSocketConnected()) {
          socket.emit('chat:screenshot', {
            chatId: String(cid),
            receiverId: String(peerId),
          });
        }
      } catch (_err) {
        // best-effort — never crash the chat screen on screenshot detection
      }
    };

    (async () => {
      try {
        if (Platform.OS === 'android') {
          // Required for the MediaStore ContentObserver that backs the listener.
          // Use the granular READ_MEDIA_IMAGES on Android 13+ (handled internally).
          try {
            const perm = await MediaLibrary.getPermissionsAsync();
            if (!perm?.granted) {
              await MediaLibrary.requestPermissionsAsync(false, ['photo']);
            }
          } catch (_e) {
            // If permission flow fails, still try to subscribe — iOS path and
            // newer Android (14+) ScreenCaptureCallback don't need it.
          }
        }
        if (cancelled) return;
        sub = ScreenCapture.addScreenshotListener(onScreenshot);
      } catch (_err) {
        // listener registration failed — nothing we can do, fail silently
      }
    })();

    return () => {
      cancelled = true;
      try { sub?.remove?.(); } catch (_err) {}
    };
  }, [chatData, route?.params?.chatId]);

  // ── Mentions ──
  const isGroupChat = Boolean(chatData?.chatType === 'group' || chatData?.isGroup);

  // ── Save Contact ──
  const {
    isUnknown: isPeerUnknownContact,
    isSaving: isContactSaving,
    isSyncing: isContactSyncing,
    savedSuccessfully: contactSavedSuccessfully,
    saveError: contactSaveError,
    saveContact,
  } = useSaveContact(!isGroupChat ? chatData?.peerUser : null);

  // Used to resolve status-reply preview owner names against the local
  // saved-contacts directory (saved name → phone number → server name).
  const { resolveName: resolveContactName } = useContactDirectory();
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

  // Resolve userId to display name — saved contact name (matched by id / phone
  // hash) first, then member/peer name, then phone number.
  const getReactionUserName = useCallback((userId) => {
    if (userId === currentUserId) return 'You';
    const member = groupMembersMap?.[userId];
    const peer = !chatData?.isGroup ? chatData?.peerUser : null;
    const fallback = member?.fullName || peer?.fullName || peer?.name || userId;
    const phone = member?.mobileNumber
      || peer?.mobileNumber || peer?.mobile?.number || peer?.phone || null;
    return resolveContactName(userId, fallback, phone);
  }, [currentUserId, groupMembersMap, chatData, resolveContactName]);

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
          const result = await FileSystem.downloadAsync(toSecureMediaUri(signedUrl), dest);
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
        const result = await FileSystem.downloadAsync(toSecureMediaUri(url), dest);
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

    // Resolve URI. For received notes we STREAM from the remote URL when the
    // file isn't downloaded yet (WhatsApp-style) instead of blocking on a full
    // download — expo-av plays remote https progressively.
    const isSender = msg?.senderType === 'self' || msg?.senderId === currentUserId;
    let uri = null;

    if (isSender) {
      uri = msg?.localUri || msg?.payload?.file?.uri || resolveDownloadedUri(msg) || toSecureMediaUri(msg?.mediaUrl) || msg?.mediaUrl;
    } else {
      // Prefer an already-downloaded local file (instant + offline); otherwise
      // stream straight from the secure remote URL.
      uri = resolveDownloadedUri(msg) || msg?.localUri || toSecureMediaUri(msg?.mediaUrl);
      if (!uri) {
        // No remote URL either — fall back to the download-then-open path.
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
        // progressUpdateIntervalMillis 60ms → the waveform playhead advances
        // smoothly (default is ~500ms, which looks choppy/jumpy while playing).
        { shouldPlay: true, progressUpdateIntervalMillis: 60 },
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
    { key: 'gestures', label: 'Gestures', icon: 'hand-left-outline' },
    { key: 'animals', label: 'Animals & Nature', icon: 'paw-outline' },
    { key: 'food', label: 'Food', icon: 'pizza-outline' },
    { key: 'activities', label: 'Activities', icon: 'football-outline' },
    { key: 'travel', label: 'Travel', icon: 'airplane-outline' },
    { key: 'objects', label: 'Objects', icon: 'bulb-outline' },
    { key: 'symbols', label: 'Symbols', icon: 'heart-outline' },
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

    // Blocked accounts can't send anything — text, media, contact or voice note.
    if (amBlocked) {
      Alert.alert('Account blocked', 'Your account has been blocked by an admin. You cannot send messages.');
      return;
    }

    // Contact-block: if I blocked this peer, prompt to unblock first. If the peer
    // blocked ME, do NOT reveal it (WhatsApp parity) — the send proceeds and the
    // server silently drops it; the message just stays on a single "sent" tick.
    if (!isGroupChat && iBlockedPeer) {
      Alert.alert('You blocked this contact', 'Unblock them to send a message.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Unblock', onPress: handleUnblockFromChat },
      ]);
      return;
    }

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
      const caption = text.trim();
      setPendingMedia(null);
      handleTextChange('');
      if (mediaToSend.isAlbum) {
        // Multi-select → ONE WhatsApp-style album message (grid bubble)
        await sendMediaGroup({ files: mediaToSend.files, caption });
      } else {
        await sendMedia(mediaToSend);
      }
      return;
    }
    // Extract mentions before sending (text gets cleared after send)
    const mentions = isGroupChat ? getMentionsPayload(text) : undefined;
    // Fire-and-forget: message appears instantly via optimistic UI, no need to await
    if (amBlocked) {
      Alert.alert('Account blocked', 'Your account has been blocked by an admin. You cannot send messages.');
      return;
    }
    handleSendText(mentions).catch(err => console.warn('[Send] error:', err?.message));
    if (isGroupChat) resetMentions();
  };

  // ── Reply-tap navigation (supports chain replies) ───────────────────────
  // Tapping the ↪ preview on a reply scrolls the chat to the parent and
  // flashes the highlight. Works for any depth of reply chain because each
  // ReplyBubble carries its OWN replyToMessageId — the user can keep
  // tapping back through the chain. When the parent is older than the
  // currently-loaded `messages` window, this paginates older messages in.
  const navigateToReplyParent = useCallback(async (originalMsgId, depth = 0) => {
    if (!originalMsgId) return;
    const idStr = String(originalMsgId);

    const findIdx = (list) => list.findIndex(m =>
      sameId(m.serverMessageId, idStr) ||
      sameId(m.id, idStr) ||
      sameId(m.tempId, idStr) ||
      sameId(m.clientMessageId, idStr) ||
      sameId(m.messageId, idStr)
    );

    let idx = findIdx(messages);

    // Not in current window? Try paging older messages in — once. Depth cap
    // prevents an infinite loop if the parent really doesn't exist locally.
    if (idx === -1 && hasMoreMessages && depth < 4) {
      try {
        await loadMoreMessages();
      } catch {}
      // Try again with the (possibly) updated list. Note: messages is a
      // closure capture, so re-derive via state setter or call setImmediate.
      // The simplest robust path: requestAnimationFrame + recurse with depth+1.
      requestAnimationFrame(() => navigateToReplyParent(originalMsgId, depth + 1));
      return;
    }

    if (idx === -1) {
      // Last-ditch fallback — flash the highlight on whichever id matches
      // when this row eventually renders. Gives the user a visual cue.
      if (replyHighlightTimer.current) clearTimeout(replyHighlightTimer.current);
      setReplyHighlightId(idStr);
      replyHighlightTimer.current = setTimeout(() => {
        setReplyHighlightId(null);
        replyHighlightTimer.current = null;
      }, 3000);
      return;
    }

    if (flatListRef?.current) {
      try {
        flatListRef.current.scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 });
      } catch {}
    }

    const targetMsg = messages[idx];
    const targetKey =
      targetMsg?.serverMessageId ||
      targetMsg?.id ||
      targetMsg?.tempId ||
      targetMsg?.clientMessageId ||
      targetMsg?.messageId;
    if (targetKey) {
      if (replyHighlightTimer.current) clearTimeout(replyHighlightTimer.current);
      setReplyHighlightId(targetKey);
      replyHighlightTimer.current = setTimeout(() => {
        setReplyHighlightId(null);
        replyHighlightTimer.current = null;
      }, 3000);
    }
  }, [messages, hasMoreMessages, loadMoreMessages]);

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
    // Camera backgrounds the app; suspend the app lock so returning isn't a re-lock.
    suspendAppLock();
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
    } finally {
      resumeAppLock();
    }
  }, [setPendingMedia]);

  const handleAudioPick = useCallback(async () => {
    // Document picker backgrounds the app; suspend the app lock for the round trip.
    suspendAppLock();
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
    } finally {
      resumeAppLock();
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
    // The contact picker backgrounds the app; suspend the app lock for the round trip.
    suspendAppLock();
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
    } finally {
      resumeAppLock();
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
        Animated.timing(mediaSheetAnim, {
          toValue: 0,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.timing(mediaBackdropAnim, {
          toValue: 1,
          duration: 120,
          useNativeDriver: true,
        }),
      ]).start();
    },
  }), [closeMediaPanelAnimated, mediaBackdropAnim, mediaSheetAnim]);

  // The live keyboard movement is driven by react-native-keyboard-controller via
  // `rootKeyboardStyle`. These listeners only (a) capture the resting keyboard
  // height so the emoji panel can match it, and (b) keep focus/emoji UI state.
  useEffect(() => {
    const isIOS = Platform.OS === 'ios';
    const showEvent = isIOS ? 'keyboardDidShow' : 'keyboardDidShow';
    const hideEvent = isIOS ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvent, (event) => {
      const nextHeight = event?.endCoordinates?.height || 0;
      if (nextHeight > 0) setKeyboardHeight(nextHeight);
      setIsInputFocused(true);
      setShowEmojiPanel(false);
    });

    const hideSub = Keyboard.addListener(hideEvent, () => {
      setIsInputFocused(false);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

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
    // Tiles start hidden, then pop in with a brief stagger (WhatsApp reveal).
    mediaOptionEntryAnims.forEach((anim) => anim.setValue(0));

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

    Animated.stagger(
      26,
      mediaOptionEntryAnims.map((anim) =>
        Animated.spring(anim, {
          toValue: 1,
          damping: 14,
          stiffness: 240,
          mass: 0.7,
          useNativeDriver: true,
        }),
      ),
    ).start();
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
    const isBroadcast = Boolean(chatData?.chatType === 'broadcast' || chatData?.isBroadcast);
    if (isBroadcast) {
      navigation.navigate('ChannelInfo', {
        channelId: chatData?.broadcastChannelId || chatData?.chatId || chatData?._id || route?.params?.chatId,
        item: chatData,
      });
    } else if (isGroupChat) {
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


  // Animated open/close for the WhatsApp-style dropdown popover
  const openChatMenu = useCallback(() => {
    setShowMenu(true);
    menuScaleAnim.setValue(0.85);
    menuOpacityAnim.setValue(0);
    Animated.parallel([
      Animated.spring(menuScaleAnim, { toValue: 1, tension: 110, friction: 9, useNativeDriver: true }),
      Animated.timing(menuOpacityAnim, { toValue: 1, duration: 140, useNativeDriver: true }),
    ]).start();
  }, [menuScaleAnim, menuOpacityAnim]);

  const closeChatMenu = useCallback(() => {
    Animated.parallel([
      Animated.timing(menuScaleAnim, { toValue: 0.9, duration: 110, useNativeDriver: true }),
      Animated.timing(menuOpacityAnim, { toValue: 0, duration: 110, useNativeDriver: true }),
    ]).start(() => setShowMenu(false));
  }, [menuScaleAnim, menuOpacityAnim]);

  // Open the confirmation modal — "Clear chat" only soft-deletes for the
  // requesting user (User A). The peer's chat history stays intact.
  const handleClearChatOptions = useCallback(() => {
    closeChatMenu();
    // small delay so the sheet exits before the modal enters
    setTimeout(() => setClearChatModalVisible(true), 200);
  }, [closeChatMenu]);

  const onConfirmClearChat = useCallback(async () => {
    if (isClearingChat) return;
    setIsClearingChat(true);
    try {
      await clearChatForMe();
      setClearChatModalVisible(false);
    } catch (error) {
      Alert.alert('Clear Chat', error?.message || 'Unable to clear chat right now. Please try again.');
    } finally {
      setIsClearingChat(false);
    }
  }, [clearChatForMe, isClearingChat]);

  // Delete for everyone — soft-deletes the chat on the server for both
  // participants (each message gets BOTH users added to `deletedFor`,
  // each user's ChatSummary is removed). Both User A and User B see the
  // chat disappear from their list.
  const handleDeleteForEveryone = useCallback(() => {
    closeChatMenu();
    setTimeout(() => setDeleteEveryoneModalVisible(true), 200);
  }, [closeChatMenu]);

  const onConfirmDeleteForEveryone = useCallback(async () => {
    if (isDeletingEveryone) return;
    setIsDeletingEveryone(true);
    try {
      await clearChatForEveryone();
      setDeleteEveryoneModalVisible(false);
      // Chat row stays in both users' lists — only the messages are cleared.
      // The user remains in the chat, which now shows the empty state.
    } catch (error) {
      Alert.alert(
        'Clear for everyone',
        error?.message || 'Unable to clear this chat for everyone right now. Please try again.'
      );
    } finally {
      setIsDeletingEveryone(false);
    }
  }, [clearChatForEveryone, isDeletingEveryone]);

  const renderChatEmptyState = useCallback(() => (
    // Rendered as a normal (non-inverted) overlay OUTSIDE the inverted FlatList,
    // so NO inversion transform is applied — text stays upright on both iOS and
    // Android (incl. the new architecture, where a manual scaleY:-1 inside an
    // inverted list was rendering mirrored).
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 }}>
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
    // setLayoutAnimationEnabledExperimental is a no-op under the New Architecture
    // (Fabric). LayoutAnimation works natively now, so we don't need to opt in.
    if (Platform.OS === 'android'
        && UIManager?.setLayoutAnimationEnabledExperimental
        && !global?.nativeFabricUIManager) {
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
        ? <Text key={i} style={{ backgroundColor: '#FFEB3B', color: '#000', fontFamily: 'Roboto-SemiBold' }}>{part}</Text>
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

    const baseColor = isMyMessage ? '#E9EDEF' : (isDarkMode ? '#E9EDEF' : theme.colors.primaryTextColor);
    const linkColor = isMyMessage ? '#D8ECFF' : theme.colors.themeColor;
    const mentionColor = isMyMessage ? '#D8ECFF' : '#00A884';
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
            fontSize: 15,
            color: baseColor,
            fontFamily: 'Roboto-Regular',
            lineHeight: 20,
          }}
        >
          {renderInlineTokens()}
        </Text>

        <Text
          numberOfLines={!isExpanded && showReadMore ? RICH_TEXT_COLLAPSED_LINES : undefined}
          ellipsizeMode="tail"
          style={{
            fontSize: 15,
            color: baseColor,
            fontFamily: 'Roboto-Regular',
            lineHeight: 20,
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

  // WhatsApp delivery ticks (single/double check, blue on read). Shared by the
  // inline text-bubble footer and the bottom status row.
  const renderTicks = (msg, { size = 16 } = {}) => {
    const c = 'rgba(233,237,239,0.65)';
    switch (msg?.status) {
      case 'scheduled':
      case 'processing':
      case 'pending':
        return <Ionicons name="time-outline" size={14} color={c} style={{ marginLeft: 1 }} />;
      case 'cancelled':
        return <Ionicons name="close-circle" size={14} color="#FF8A80" style={{ marginLeft: 1 }} />;
      case 'sending':
        return <ActivityIndicator size={10} color={c} style={{ marginLeft: 1 }} />;
      case 'uploaded':
      case 'sent':
        return <Ionicons name="checkmark" size={size} color={c} style={{ marginLeft: 1 }} />;
      case 'delivered':
        return <Ionicons name="checkmark-done" size={size} color={c} style={{ marginLeft: 1 }} />;
      case 'seen':
      case 'read':
        return <Ionicons name="checkmark-done" size={size} color="#53BDEB" style={{ marginLeft: 1 }} />;
      case 'failed':
        return (
          <TouchableOpacity onPress={() => resendMessage(msg)}>
            <Ionicons name="alert-circle" size={14} color="#FF5252" style={{ marginLeft: 1 }} />
          </TouchableOpacity>
        );
      default:
        return null;
    }
  };

  // The "edited · 10:56 AM ✓✓" footer. `inline` floats it into the bottom-right
  // of a text bubble (WhatsApp tucks the meta onto the last line of text).
  const renderMessageMeta = (msg, isMyMessage, { inline = false } = {}) => {
    const showEdited = Boolean(msg?.isEdited || msg?.editedAt || msg?.edited);
    const metaColor = isMyMessage ? 'rgba(233,237,239,0.6)' : theme.colors.placeHolderTextColor;
    return (
      <View
        style={[
          { flexDirection: 'row', alignItems: 'center', gap: 3 },
          inline
            ? { marginLeft: 'auto', paddingLeft: 10, marginBottom: -1 }
            : { justifyContent: 'flex-end', marginTop: 1 },
        ]}
      >
        {showEdited && (
          <Text style={{ fontSize: 11, color: metaColor, fontFamily: 'Roboto-Regular', fontStyle: 'italic' }}>
            edited
          </Text>
        )}
        <Text style={{ fontSize: 11, color: metaColor, fontFamily: 'Roboto-Regular' }}>{msg.time}</Text>
        {isMyMessage && renderTicks(msg)}
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

      // pending = message not yet sent (e.g. queued offline)
      if (msg?.status === 'pending') {
        return <Ionicons name="time-outline" size={11} color="rgba(255,255,255,0.75)" style={{ marginLeft: 3 }} />;
      }
      if (msg?.status === 'sending') {
        return <ActivityIndicator size={8} color="rgba(255,255,255,0.85)" style={{ marginLeft: 3 }} />;
      }
      if (msg?.status === 'uploaded' || msg?.status === 'sent') {
        // single gray tick — sent but not yet delivered
        return <Ionicons name="checkmark" size={11} color="rgba(255,255,255,0.75)" style={{ marginLeft: 3 }} />;
      }
      if (msg?.status === 'delivered') {
        // double gray tick
        return <Ionicons name="checkmark-done" size={11} color="rgba(255,255,255,0.75)" style={{ marginLeft: 3 }} />;
      }
      if (msg?.status === 'seen' || msg?.status === 'read') {
        // double blue tick — WhatsApp blue #53BDEB
        return <Ionicons name="checkmark-done" size={11} color="#53BDEB" style={{ marginLeft: 3 }} />;
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

    // Remote https URL (server thumbnail / full media) — the fallback when the
    // local downloaded file is missing or unreadable (common on the iOS
    // simulator after reinstalls, where the app container path goes stale).
    const remoteImageSource = toSecureMediaUri(getServerThumbnailUrl(msg) || msg?.mediaUrl);
    const localImageSource = toSecureMediaUri(isMyMessage
      ? (msg.localUri || resolveCachedThumbnailUrl(msg) || msg.mediaUrl)
      : (downloadedUri || resolveCachedThumbnailUrl(msg)));
    // If the local file already failed to render once, use the remote URL.
    const imageSource = (failedLocalMedia[messageKey] && remoteImageSource)
      ? remoteImageSource
      : (localImageSource || remoteImageSource);
    const onImageLoadError = () => {
      if (!failedLocalMedia[messageKey] && remoteImageSource && imageSource !== remoteImageSource) {
        setFailedLocalMedia(prev => (prev[messageKey] ? prev : { ...prev, [messageKey]: true }));
      }
    };
    const shouldRenderThumbnail = Boolean(imageSource);
    const isDownloading = status === MEDIA_DOWNLOAD_STATUS.DOWNLOADING;
    // Blur: full (20) before download, reduces progressively during download, 0 when done
    const blurAmount = (!isMyMessage && !downloaded && shouldRenderThumbnail)
      ? (isDownloading ? Math.round(20 * (1 - Math.min(1, progress))) : 20)
      : 0;

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
            <Image
              source={{ uri: imageSource }}
              style={imageStyle}
              resizeMode="cover"
              blurRadius={blurAmount}
              onError={onImageLoadError}
            />
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
    const thumbnailSource = toSecureMediaUri(resolveCachedThumbnailUrl(msg));
    const shouldRenderThumbnail = Boolean(thumbnailSource || downloaded);
    const isDownloading = status === MEDIA_DOWNLOAD_STATUS.DOWNLOADING;
    const videoBlurAmount = (!isMyMessage && !downloaded && Boolean(thumbnailSource))
      ? (isDownloading ? Math.round(20 * (1 - Math.min(1, progress))) : 20)
      : 0;
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
            <Image
              source={{ uri: thumbnailSource }}
              style={videoStyle}
              resizeMode="cover"
              blurRadius={videoBlurAmount}
            />
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
    // Received voice notes STREAM from the remote URL (WhatsApp-style) — no need
    // to download first, so the play button shows immediately.
    const remoteAudioUrl = toSecureMediaUri(msg?.mediaUrl);
    const canPlay = isMyMessage || downloaded || Boolean(remoteAudioUrl);
    const bubbleColor = isMyMessage
      ? (chatColor || '#00A884')
      : (isDarkMode ? 'rgba(30, 45, 60, 0.95)' : '#fff');
    const subColor = isMyMessage ? 'rgba(255,255,255,0.72)' : theme.colors.placeHolderTextColor;
    const trackBg = isMyMessage ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.16)';
    const trackFill = isMyMessage ? '#fff' : theme.colors.themeColor;
    const iconBg = isMyMessage ? 'rgba(255,255,255,0.22)' : (theme.colors.themeColor + '22');
    const iconColor = isMyMessage ? '#fff' : theme.colors.themeColor;

    // Sender's avatar (with a mic badge) beside the waveform — mine on my
    // messages, the peer's / the group member's on received ones.
    const isGroupChat = chatData?.chatType === 'group' || chatData?.isGroup;
    const rawAvatar = isMyMessage
      ? myProfileImage
      : (isGroupChat
          ? (groupMembersMapRef.current?.[msg?.senderId]?.profileImage || null)
          : (chatData?.peerUser?.profileImage || chatData?.peerUser?.profilePicture || null));
    const avatarUri = rawAvatar ? toSecureMediaUri(rawAvatar) : null;

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
        width: Math.min(MAX_MEDIA_BUBBLE_WIDTH, 288),
        borderRadius: 14,
        paddingVertical: 8,
        paddingHorizontal: 8,
        marginBottom: 4,
        overflow: 'hidden',
      }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {/* Sender avatar + mic badge */}
          <View style={{ width: 44, height: 44, marginRight: 6 }}>
            <View style={{
              width: 44, height: 44, borderRadius: 22, overflow: 'hidden',
              backgroundColor: isMyMessage ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.10)',
              alignItems: 'center', justifyContent: 'center',
            }}>
              {avatarUri
                ? <Image source={{ uri: avatarUri }} style={{ width: 44, height: 44 }} />
                : <Ionicons name="person" size={24} color={isMyMessage ? 'rgba(255,255,255,0.85)' : theme.colors.placeHolderTextColor} />}
            </View>
            <View style={{
              position: 'absolute', right: -2, bottom: -2,
              width: 18, height: 18, borderRadius: 9,
              backgroundColor: '#00A884',
              alignItems: 'center', justifyContent: 'center',
              borderWidth: 1.5, borderColor: bubbleColor,
            }}>
              <Ionicons name="mic" size={10} color="#fff" />
            </View>
          </View>

          {/* Play/Pause/Download button */}
          <TouchableOpacity onPress={handleTap} activeOpacity={0.7}
            style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: iconBg, alignItems: 'center', justifyContent: 'center' }}>
            {isDownloading || msg.status === 'sending'
              ? <ActivityIndicator size="small" color={iconColor} />
              : <Ionicons
                  name={canPlay ? (isPlaying ? 'pause' : 'play') : 'cloud-download'}
                  size={canPlay ? 21 : 18}
                  color={iconColor}
                  style={canPlay && !isPlaying ? { marginLeft: 2 } : undefined}
                />
            }
          </TouchableOpacity>

          {/* Waveform + duration */}
          <AudioSeekBar
            seedKey={msgKey}
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
                  On TalksTry
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
              {/* <Pressable
                onPress={handleMessageContact}
                style={{ flex: 1, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' }}
              >
                <Text style={{ color: btnColor, fontFamily: 'Roboto-Medium', fontSize: 13 }}>Message</Text>
              </Pressable> */}
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
    const isSearchHighlighted = isSearching && searchResults.length > 0 && currentSearchIndex >= 0 && sameId(highlightedId, messageKey);
    // Match against every identifier the parent might have stored — same set
    // the reply-tap handler tries — so the highlight survives the temp→server
    // id swap that happens when an optimistic parent is acked.
    const isReplyHighlighted = replyHighlightId && (
      sameId(replyHighlightId, messageKey) ||
      sameId(replyHighlightId, msg?.serverMessageId) ||
      sameId(replyHighlightId, msg?.id) ||
      sameId(replyHighlightId, msg?.tempId) ||
      sameId(replyHighlightId, msg?.clientMessageId) ||
      sameId(replyHighlightId, msg?.messageId)
    );
    const isHighlighted = isSearchHighlighted || isReplyHighlighted;
    
    const progress = resolveMediaProgress(msg);
    const downloadState = resolveMediaState(msg);
    
    const deletedFor = msg?.deletedFor;
    const isDeletedForCurrentUser = Array.isArray(deletedFor)
      ? deletedFor.some((id) => sameId(id, currentUserId))
      : (typeof deletedFor === 'string' ? (deletedFor.toLowerCase() === 'everyone' || sameId(deletedFor, currentUserId)) : false);
    const isDeletedMessage = Boolean(msg?.isDeleted) || isDeletedForCurrentUser;
    const isSystemMessage = (msg?.type === 'system' || msg?.messageType === 'system') && !isDeletedMessage;
    const deletedText = msg?.placeholderText || (isMyMessage ? 'You deleted this message' : 'This message was deleted');

    // WhatsApp-style album: one message bubble carrying N attachments
    const isAlbum = (msg.type === 'album' || msg.messageType === 'album'
      || (Array.isArray(msg.mediaItems) && msg.mediaItems.length > 1)) && !isDeletedMessage;
    const isImage = !isAlbum && (msg.type === 'image' || msg.mediaType === 'image' || msg.type === 'photo');
    const isVideo = !isAlbum && (msg.type === 'video' || msg.mediaType === 'video');
    const isAudio = msg.type === 'audio' || msg.mediaType === 'audio';
    const isFile = msg.type === 'file' || msg.type === 'document';
    const isLocation = msg.type === 'location' || msg.mediaType === 'location';
    const isContact = msg.type === 'contact' || msg.mediaType === 'contact';
    const isCall = (msg.type === 'call' || msg.messageType === 'call') && !isDeletedMessage;
    const isMediaMessage = isAlbum || isImage || isVideo || isAudio || isFile || isLocation || isContact;
    const inlineMediaTime = !isDeletedMessage && (isImage || isVideo || isAudio || isLocation || isContact);
    // Plain text bubbles tuck the time/ticks into the bottom-right of the last
    // line (WhatsApp footer). Other types keep the separate bottom meta row.
    const showInlineMeta = msg.type === 'text' && !isDeletedMessage;

    const dateBadgeKey = shouldShowDateAbove(msg, index, messages);

    // ── Call log entry (audio/video call, missed/outgoing/incoming) ──
    if (isCall) {
      return (
        <React.Fragment>
          {dateBadgeKey && (
            <View style={{ alignItems: 'center', paddingVertical: 8 }}>
              <View style={{ backgroundColor: theme.colors.menuBackground, paddingHorizontal: 14, paddingVertical: 4, borderRadius: 12 }}>
                <Text style={{ fontSize: 11, color: theme.colors.placeHolderTextColor, fontFamily: 'Roboto-Medium' }}>{dateBadgeKey}</Text>
              </View>
            </View>
          )}
          <View style={{ paddingHorizontal: 12 }}>
            <CallMessageBubble
              msg={msg}
              peer={chatData?.peerUser}
              chatId={chatData?.chatId || chatData?._id || route?.params?.chatId}
              timeText={msg?.time || (msg?.createdAt ? moment(msg.createdAt).format('hh:mm A') : '')}
            />
          </View>
        </React.Fragment>
      );
    }

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

    // Group chats only: show the SENDER's avatar beside RECEIVED messages.
    // Tapping it opens that member's profile. Own messages get no avatar.
    const isGroupChatRow = chatData?.chatType === 'group' || chatData?.isGroup;
    const isGroupReceived = !isMyMessage && isGroupChatRow && !isSystemMessage;

    // WhatsApp-style consecutive grouping: only the FIRST message in a run from
    // the same sender carries the avatar + name. In this inverted list the
    // message shown directly ABOVE (chronologically older) sits at index + 1.
    // A run restarts when the sender changes, a date divider splits the two, or
    // a significant time gap passes between them.
    const CONSECUTIVE_GROUP_GAP_MS = 5 * 60 * 1000; // 5 min restarts the run
    const olderMsg = index < messages.length - 1 ? messages[index + 1] : null;
    const olderIsSystemLike = !!olderMsg && (
      olderMsg?.type === 'system' || olderMsg?.messageType === 'system' ||
      olderMsg?.type === 'call' || olderMsg?.messageType === 'call'
    );
    const msgTsMs = (m) => {
      const raw = m?.timestamp || m?.createdAt || m?.updatedAt || m?.date || null;
      const t = raw ? new Date(raw).getTime() : NaN;
      return Number.isFinite(t) ? t : null;
    };
    const curTsMs = msgTsMs(msg);
    const olderTsMs = msgTsMs(olderMsg);
    const withinGroupGap = (curTsMs != null && olderTsMs != null)
      ? (curTsMs - olderTsMs) <= CONSECUTIVE_GROUP_GAP_MS
      : true;
    const continuesRun = isGroupReceived
      && !!olderMsg
      && !olderIsSystemLike
      && sameId(olderMsg.senderId, msg.senderId)
      && !dateBadgeKey
      && withinGroupGap;
    // First message of a run → show avatar + name. Follow-ups → bubble only.
    const showSenderAvatar = isGroupReceived && !continuesRun;
    const showSenderName = showSenderAvatar;
    const senderMeta = showSenderAvatar ? (groupMembersMap?.[msg.senderId] || {}) : {};
    const senderAvatarUri = senderMeta.profileImage ? toSecureMediaUri(senderMeta.profileImage) : null;
    // Always prefer the device's saved contact name for this user (registered
    // contact name). When they're NOT a saved contact, show their phone number
    // (passed as the 3rd arg), and only fall back to the backend/profile name
    // when no number is known — matching the contacts-app behaviour the user
    // expects in group chats.
    const senderLabel = resolveContactName(
      msg.senderId,
      senderMeta.fullName || msg.senderName || 'Member',
      senderMeta.mobileNumber
    );
    const openSenderProfile = () => {
      if (!msg.senderId) return;
      navigation.navigate('UserB', {
        item: {
          peerUser: { _id: msg.senderId, fullName: senderLabel, profileImage: senderMeta.profileImage || null },
          chatType: 'private',
        },
      });
    };

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
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
            // WhatsApp style: actions appear in the TOP bar (header rightActions
            // selection toolbar) + a floating emoji reaction row above the message.
            // Select the message (drives the top toolbar) for ANY message incl.
            // tombstones (top toolbar then offers Delete). Emoji picker itself is
            // gated to non-deleted messages.
            setReactionMsgId(prev => prev === messageKey ? null : messageKey);
            if (!selectedMessage.includes(messageKey)) {
              handleToggleSelectMessages(messageKey);
            }
          }}
          delayLongPress={300}
          style={{
            flexDirection: isGroupReceived ? "row" : "column",
            alignItems: isGroupReceived ? "flex-start" : (isMyMessage ? "flex-end" : "flex-start"),
            paddingVertical: 2,
            paddingHorizontal: 12,
            backgroundColor: isSelected
              ? theme.colors.themeColor + '20'
              : isHighlighted 
                ? 'rgba(255, 193, 7, 0.15)' 
                : "transparent",
          }}
        >
          {showSenderAvatar ? (
            <TouchableOpacity onPress={openSenderProfile} activeOpacity={0.7} style={{ marginRight: 6, marginTop: 2 }}>
              {senderAvatarUri ? (
                <Image source={{ uri: senderAvatarUri }} style={{ width: 30, height: 30, borderRadius: 15 }} />
              ) : (
                <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: getUserColor?.(msg.senderId) || theme.colors.themeColor, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: '#fff', fontFamily: 'Roboto-SemiBold', fontSize: 13 }}>
                    {String(senderLabel || 'M').charAt(0).toUpperCase()}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          ) : isGroupReceived ? (
            // Consecutive same-sender message: reserve the avatar's footprint so
            // the bubble stays left-aligned under the run's first bubble.
            <View style={{ width: 30, marginRight: 6 }} />
          ) : null}
          {/* Column wrapper around bubble + reaction picker + pill. The picker
              and pill position themselves with alignSelf/stacking margins, so
              they MUST live in a column. In group-received rows the outer
              Pressable is a row ([avatar | bubble]); without this wrapper the
              picker/pill would render beside the bubble instead of above/below. */}
          <View style={
            isGroupReceived
              ? { flex: 1, alignItems: 'flex-start' }
              : { alignItems: isMyMessage ? 'flex-end' : 'flex-start' }
          }>
          <View style={{
            // WhatsApp bubble geometry: ~7.5px corners with a small tail at the
            // TOP corner on the sender's side (top-right for me, top-left for them).
            maxWidth: "80%",
            borderRadius: 8,
            borderTopRightRadius: isMyMessage ? 3 : 8,
            borderTopLeftRadius: isMyMessage ? 8 : 3,
            backgroundColor: isDeletedMessage
              ? (isDarkMode ? '#182229' : theme.colors.menuBackground)
              : (isMyMessage
                  // Keep a user-customised bubble colour; otherwise WhatsApp's
                  // dark-mode outgoing green (#005C4B), not the bright accent.
                  ? ((chatColor && chatColor !== '#00A884') ? chatColor : '#005C4B')
                  : (isDarkMode ? '#202C33' : theme.colors.cardBackground)),
            paddingVertical: (isMediaMessage && !msg.replyToMessageId) ? 3 : 6,
            paddingHorizontal: (isMediaMessage && !msg.replyToMessageId) ? 3 : 9,
            borderWidth: isHighlighted ? 2 : 0,
            borderColor: '#FFC107',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: isDarkMode ? 0.2 : 0.08,
            shadowRadius: 1,
            elevation: 1,
          }}>
            
            {/* Sender name — only on the first message of a consecutive run */}
            {showSenderName && (
              <Text
                numberOfLines={1}
                style={{
                  fontSize: 13,
                  color: getUserColor?.(msg.senderId) || theme.colors.themeColor,
                  fontFamily: "Roboto-SemiBold",
                  marginBottom: 2,
                  paddingRight: 8,
                }}>
                {/* Saved contact → device contact name. Not saved → phone
                    number (3rd arg). Backend/profile name is only the final
                    fallback when no number is known. */}
                {resolveContactName(
                  msg.senderId,
                  groupMembersMap?.[msg.senderId]?.fullName
                    || msg.senderName
                    || 'Member',
                  groupMembersMap?.[msg.senderId]?.mobileNumber
                )}
              </Text>
            )}

            {/* Scheduled message label — same UI before and after delivery, both sender and receiver */}
            {!isDeletedMessage && msg.status !== 'cancelled' && (msg.scheduleTimeLabel || msg.payload?.scheduleTimeLabel || msg.wasScheduled || msg.payload?.wasScheduled || ((msg.status === 'scheduled' || msg.status === 'processing') && msg.isScheduled)) && (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 3, paddingTop: 1 }}>
                <Ionicons name="time-outline" size={13} color={isMyMessage ? 'rgba(255,255,255,0.65)' : '#8696A0'} style={{ marginRight: 4 }} />
                <Text style={{
                  fontFamily: 'Roboto-Regular', fontSize: 11, fontStyle: 'italic',
                  color: isMyMessage ? 'rgba(255,255,255,0.65)' : '#8696A0',
                }}>
                  {msg.scheduleTimeLabel || msg.payload?.scheduleTimeLabel
                    ? `Scheduled ${msg.scheduleTimeLabel || msg.payload?.scheduleTimeLabel}`
                    : 'Scheduled message'}
                </Text>
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

            {/* Status reply / share preview — tap opens the StatusViewer */}
            {msg.statusRef && msg.statusPreview && !isDeletedMessage && (() => {
              const sp = msg.statusPreview;
              // Resolve the owner label: saved contact name → phone number →
              // server-side name. Own status keeps its server name (it's you).
              const isOwnStatus = sp.ownerId && currentUserId
                && String(sp.ownerId) === String(currentUserId);
              // Own status → show "Your status". Otherwise resolve the owner's
              // display name (saved contact → phone → server name).
              const resolvedOwnerName = isOwnStatus
                ? sp.ownerName
                : resolveContactName(
                    sp.ownerId,
                    sp.ownerName,
                    sp.ownerPhone || sp.phone
                  );
              const resolvedPreview = resolvedOwnerName === sp.ownerName
                ? sp
                : { ...sp, ownerName: resolvedOwnerName };
              return (
                <StatusReplyPreview
                  statusRef={msg.statusRef}
                  statusPreview={resolvedPreview}
                  isMyMessage={isMyMessage}
                  isOwnStatus={isOwnStatus}
                  chatColor={chatColor}
                  theme={theme}
                  onPress={handleOpenStatusFromChat}
                />
              );
            })()}

            {/* Reply quote bubble — resolve missing data from messages array at render time */}
            {msg.replyToMessageId && !isDeletedMessage && (() => {
              let replyText = msg.replyPreviewText;
              let replyType = msg.replyPreviewType;
              let replySName = msg.replySenderName;
              let replySId = msg.replySenderId;
              let replyThumb = null;

              // Always try to resolve a thumbnail for image/video quotes from the
              // original message (preview data alone doesn't carry the URL).
              const quotedOriginal = messages.find(m =>
                sameId(m.serverMessageId, msg.replyToMessageId) ||
                sameId(m.id, msg.replyToMessageId) ||
                sameId(m.tempId, msg.replyToMessageId)
              );
              if (quotedOriginal && !quotedOriginal.isDeleted) {
                replyThumb = quotedOriginal.mediaThumbnailUrl || quotedOriginal.previewUrl || quotedOriginal.mediaUrl || null;
              }

              // If reply preview data is missing, look up the original message
              if (!replyText || !replySName) {
                const originalMsg = quotedOriginal;
                if (originalMsg) {
                  if (!replyText) {
                    replyText = originalMsg.isDeleted ? 'This message was deleted' : (originalMsg.text || originalMsg.content || null);
                    replyType = replyType || originalMsg.type || 'text';
                  }
                  if (!replySId) replySId = originalMsg.senderId;
                  if (!replySName) {
                    replySName = originalMsg.senderName
                      || groupMembersMap?.[originalMsg.senderId]?.fullName
                      || (sameId(originalMsg.senderId, currentUserId) ? 'You' : null);
                  }
                }
                // Final fallback: resolve sender name from group members using replySenderId
                if (!replySName && replySId) {
                  replySName = groupMembersMap?.[replySId]?.fullName
                    || (sameId(replySId, currentUserId) ? 'You' : null);
                }
              }

              // Keep the quoted-sender label consistent with the bubble label:
              // saved contact name → phone number → backend name. Leave "You"
              // (own messages) untouched.
              if (replySId && !sameId(replySId, currentUserId)) {
                replySName = resolveContactName(
                  replySId,
                  replySName || groupMembersMap?.[replySId]?.fullName || 'Member',
                  groupMembersMap?.[replySId]?.mobileNumber
                );
              }

              return (
                <ReplyBubble
                  replyToMessageId={msg.replyToMessageId}
                  replyPreviewText={replyText}
                  replyPreviewType={replyType}
                  replySenderName={replySName}
                  replySenderId={replySId}
                  replyThumbnailUrl={replyThumb}
                  currentUserId={currentUserId}
                  isMyMessage={isMyMessage}
                  chatColor={chatColor}
                  theme={theme}
                  onPress={(originalMsgId) => navigateToReplyParent(originalMsgId)}
                />
              );
            })()}

            {/* TEXT MESSAGES — text flows, time/ticks tuck into the bottom-right
                (WhatsApp). Short text → meta sits inline; long/multi-line text →
                meta drops to the bottom-right corner. */}
            {msg.type === "text" && !isDeletedMessage && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <View style={{ flexShrink: 1 }}>
                  {renderRichMessageText(msg, isMyMessage, messageKey)}
                </View>
                {renderMessageMeta(msg, isMyMessage, { inline: true })}
              </View>
            )}
            
            {/* DELETED MESSAGES */}
            {isDeletedMessage && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Ionicons name="ban-outline" size={14} color={theme.colors.placeHolderTextColor} />
                <Text style={{
                  fontSize: 13,
                  color: theme.colors.placeHolderTextColor,
                  fontFamily: "Roboto-Regular",
                  fontStyle: 'italic',
                }}>
                  {deletedText}
                </Text>
              </View>
            )}
  
            {/* ALBUM (multiple media in one bubble) */}
            {isAlbum && (
              <>
                <AlbumMessage
                  message={msg}
                  isMine={isMyMessage}
                  onPressItem={(item) => {
                    if (item?.uploadStatus === 'uploading' || item?.uploadStatus === 'pending') return;
                    const uri = item?.localUri || item?.mediaUrl || item?.mediaThumbnailUrl;
                    if (!uri) return;
                    openMediaViewer(
                      { ...msg, mediaUrl: item.mediaUrl || uri, mediaThumbnailUrl: item.mediaThumbnailUrl, localUri: item.localUri || null, mediaMeta: item.mediaMeta },
                      uri,
                      item.fileCategory === 'video' ? 'video' : 'image'
                    );
                  }}
                />
                {Boolean(msg.text) && (
                  <Text style={{
                    fontSize: 15,
                    lineHeight: 20,
                    color: isMyMessage ? '#E9EDEF' : (isDarkMode ? '#E9EDEF' : theme.colors.textColor),
                    fontFamily: 'Roboto-Regular',
                    marginTop: 5,
                    paddingHorizontal: 4,
                    maxWidth: 220,
                  }}>
                    {msg.text}
                  </Text>
                )}
              </>
            )}

            {/* MEDIA MESSAGES */}
            {!isDeletedMessage && isImage && renderImageMessage(msg, isMyMessage, progress, messageKey, downloadState)}
            {!isDeletedMessage && isVideo && renderVideoMessage(msg, isMyMessage, progress, messageKey, downloadState)}
            {!isDeletedMessage && isAudio && renderAudioMessage(msg, isMyMessage, progress, downloadState)}
            {!isDeletedMessage && isFile && renderFileMessage(msg, isMyMessage, progress, downloadState)}
            {!isDeletedMessage && isLocation && renderLocationMessage(msg, isMyMessage)}
            {!isDeletedMessage && isContact && renderContactMessage(msg, isMyMessage)}
  
            {/* Message Status and Timestamp — bottom meta row for non-text,
                non-overlay bubbles (file, album, deleted). Text uses the inline
                footer above; image/video/audio/location/contact show the time on
                the media overlay. */}
            {!showInlineMeta && !inlineMediaTime && (
              renderMessageMeta(msg, isMyMessage && !isDeletedMessage, { inline: false })
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

          {/* WhatsApp-style reaction pill — overlaps bottom edge of bubble */}
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
  }, [selectedMessage, currentUserId, chatColor, theme, isDarkMode, chatData, isSearching, searchResults, currentSearchIndex, expandedRichMessages, richMessageLineCounts, playingAudioId, audioPlaybackStatus, downloadProgress, uploadProgress, mediaDownloadStates, downloadedMedia, reactionMsgId, toggleReaction, removeReaction, handleDeleteSelected, startEditMessage, startReply, groupMembersMap, handleToggleSelectMessages, clearSelectedMessages, replyHighlightId]);

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
    // Inverted list → footer renders at the visual TOP. Show the spinner only
    // while an older-history page is being fetched over the NETWORK
    // (isBackfilling); local SQLite paging is instant and shows nothing.
    if (isBackfilling) {
      return (
        <View style={{ paddingVertical: 20, alignItems: "center" }}>
          <ActivityIndicator size="small" color={theme.colors.themeColor} />
          <Text style={{ marginTop: 8, fontSize: 11, color: theme.colors.placeHolderTextColor }}>
            Loading older messages...
          </Text>
        </View>
      );
    }
    if (!hasMoreMessages && !isSearching) {
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

  // NOTE: first-paint loading UI (skeleton / error / blank) is rendered INSIDE
  // the messages region of the main layout (below) — NOT as a full-screen early
  // return — so the header, input bar and footer stay visible while messages
  // load. See the "Messages List" block.

  const isBroadcastChat = Boolean(chatData?.chatType === 'broadcast' || chatData?.isBroadcast);
  if (!chatData || (!chatData.peerUser && !chatData.isGroup && !isBroadcastChat)) {
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

  // Other members to ring for a group call (everyone except me). Resolves
  // name/avatar from the populated member record or the groupMembersMap.
  // NOTE: a plain computation (not useMemo) — this lives after the component's
  // early returns above, so a hook here would break the rules-of-hooks order.
  const groupCallPeers = (() => {
    if (!isGroupChat) return [];
    const out = [];
    const seen = new Set();
    (chatData?.members || []).forEach((m) => {
      const u = (m && typeof m.userId === 'object' && m.userId !== null) ? m.userId : {};
      const id = u._id || (typeof m?.userId === 'string' ? m.userId : null) || m?._id || m?.id;
      if (!id) return;
      const sid = String(id);
      if (sid === String(currentUserId) || seen.has(sid)) return;
      seen.add(sid);
      const info = groupMembersMap?.[sid] || {};
      const img = u.profileImage || info.profileImage || null;
      out.push({
        id: sid,
        name: u.fullName || info.fullName || m?.name || 'Member',
        avatar: img ? toSecureMediaUri(img) : null,
      });
    });
    return out;
  })();
  const messagingDisabledText = !memberCanSend
    ? 'You are restricted from sending messages'
    : 'Only admins can send messages';

  // Contact-block: when *I* blocked this 1-1 peer, WhatsApp hides the composer
  // and shows an inline "You blocked this contact / Tap to unblock" bar. (A peer
  // who blocked ME is not revealed — those sends just fail server-side.)
  const contactBlockedHide = !isGroupChat && iBlockedPeer;
  const handleUnblockFromChat = () => {
    if (!chatPeerId) return;
    blockDispatch(unblockUser(String(chatPeerId)));
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <StatusBar backgroundColor={theme.colors.background} barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <Reanimated.View style={[{ flex: 1 }, rootKeyboardStyle]}>
        <ChatWallpaper isDarkMode={isDarkMode} />
        
        {/* Header */}
        <ChatHeaderPresence
          user={chatData.peerUser}
          chatId={chatData.chatId || chatData?._id || route?.params?.chatId}
          isPeerTyping={isPeerTyping}
          fallbackStatusText={renderStatusText()}
          onBack={() => navigation.goBack()}
          // Broadcast: tapping the header/avatar opens the channel info page.
          onPressProfile={handleOpenContactInfo}
          onPressAvatar={handleOpenContactInfo}
          getUserColor={getUserColor}
          // Render the channel via the group-like header path (name + logo, no
          // peer presence). isBroadcast lets the header suppress "last seen".
          isGroup={Boolean(chatData?.chatType === 'group' || chatData?.isGroup || isBroadcastChat)}
          isBroadcast={isBroadcastChat}
          isVerified={liveVerified ?? Boolean(chatData?.isVerified || chatData?.peerUser?.isVerified)}
          groupName={chatData?.chatName || chatData?.group?.name || chatData?.groupName}
          groupAvatar={chatData?.chatAvatar || chatData?.group?.avatar || chatData?.groupAvatar}
          memberCount={isBroadcastChat ? undefined : (liveMemberCount ?? (chatData?.group?.memberCount || chatData?.members?.length || chatData?.memberCount))}
          rightActions={selectedMessage.length > 0 ? (() => {
            const selMsg = selectedMessage.length === 1
              ? messages.find(m => sameId(m.id, selectedMessage[0]) || sameId(m.serverMessageId, selectedMessage[0]) || sameId(m.tempId, selectedMessage[0]))
              : null;
            const isOwnMsg = selMsg && sameId(selMsg?.senderId, currentUserId);
            const msgStatus = (selMsg?.status || '').toLowerCase();
            const isSeen = msgStatus === 'seen' || msgStatus === 'read';
            const hasServerId = Boolean(selMsg?.serverMessageId) && !String(selMsg?.serverMessageId).startsWith('temp_');
            const canEdit = selectedMessage.length === 1 && isOwnMsg && selMsg?.type === 'text' && !selMsg?.isDeleted && hasServerId;
            const isTextMsg = selMsg?.type === 'text';
            // Copy allowed whenever the message has any text — including a media caption.
            const hasCopyableText = Boolean(selMsg?.text && String(selMsg.text).trim().length > 0);
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
                {/* Copy — text messages AND media captions */}
                {selectedMessage.length === 1 && hasCopyableText && (
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
                {/* Edit — own text message, server-acked, not deleted */}
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
                {/* Message Info — only for own, non-deleted messages */}
                {selectedMessage.length === 1 && isOwnMsg && selMsg && !selMsg?.isDeleted && (
                  <TouchableOpacity
                    onPress={() => {
                      const mid = selMsg.serverMessageId || selMsg.id;
                      const cid = selMsg.chatId || chatData?.chatId || chatData?._id;
                      clearSelectedMessages();
                      setReactionMsgId(null);
                      navigation.navigate('MessageInfo', {
                        messageId: mid,
                        chatId: cid,
                        message: {
                          text: selMsg.text,
                          mediaUrl: selMsg.mediaUrl,
                          type: selMsg.type,
                        },
                      });
                    }}
                    style={{ padding: 10 }}>
                    <Ionicons name="information-circle-outline" size={22} color={theme.colors.primaryTextColor} />
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
              {isBroadcastChat ? null : !isGroupChat ? (
                <CallButtons
                  peer={chatData.peerUser}
                  chatId={chatData.chatId || chatData?._id || route?.params?.chatId}
                />
              ) : (
                <GroupCallButtons
                  peers={groupCallPeers}
                  groupId={chatData.chatId || chatData?._id || route?.params?.chatId}
                  groupName={chatData?.chatName || chatData?.group?.name || chatData?.groupName}
                />
              )}
              {isChatMuted && (
                <View style={{ marginRight: 8 }}>
                  <Ionicons name="notifications-off" size={20} color={theme.colors.placeHolderTextColor} />
                </View>
              )}
              <TouchableOpacity
                onPress={openChatMenu}
                activeOpacity={0.7}
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

        {/* Save Contact Banner — shown for unknown TalksTry users in 1:1 chats */}
        {/* {!isGroupChat && (isPeerUnknownContact || contactSavedSuccessfully) && (
          <SaveContactBanner
            peerName={chatData?.peerUser?.fullName || chatData?.peerUser?.name || ''}
            isSaving={isContactSaving}
            isSyncing={isContactSyncing}
            savedSuccessfully={contactSavedSuccessfully}
            saveError={contactSaveError}
            onSave={saveContact}
          />
        )} */}

        {/* Messages List — first-paint loading states render HERE (inside the
            messages region only) so the header above and the input bar/footer
            below stay visible. Priority: error > skeleton > sub-threshold blank
            > search-empty > the real list. */}
        {(initialLoading && loadTimedOut) ? (
          // error state — local read never produced anything; offer a retry.
          <View style={{ flex: 1, backgroundColor: theme.colors.background, justifyContent: "center", alignItems: "center", padding: 24 }}>
            <Text style={{ color: theme.colors.placeHolderTextColor, fontSize: 14, marginBottom: 14, textAlign: "center" }}>
              Couldn't load messages. Check your connection and try again.
            </Text>
            <TouchableOpacity
              onPress={() => { setLoadTimedOut(false); onRefresh && onRefresh(); }}
              style={{ paddingHorizontal: 22, paddingVertical: 10, borderRadius: 22, backgroundColor: theme.colors.themeColor }}
            >
              <Text style={{ color: "#fff", fontSize: 14, fontFamily: "Roboto-Medium" }}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : showSkeleton ? (
          // small spinner — only past the ~200ms threshold, kept ≥300ms so it
          // never flickers; centered in just the message area. Transparent
          // background so the chat wallpaper shows through (header + chat bar
          // also remain visible).
          <View style={{ flex: 1, backgroundColor: "transparent", justifyContent: "center", alignItems: "center" }}>
            <ActivityIndicator size="small" color={theme.colors.themeColor} />
          </View>
        ) : initialLoading ? (
          // sub-threshold beat: plain themed message area, no spinner/flash.
          <View style={{ flex: 1, backgroundColor: theme.colors.background }} />
        ) : isSearching && messages.length === 0 ? (
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
          <View style={{ flex: 1 }}>
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

            removeClippedSubviews={Platform.OS === 'android'}
            maxToRenderPerBatch={10}
            updateCellsBatchingPeriod={50}
            windowSize={11}
            ListFooterComponent={!isSearching ? renderFooter : null}
            maintainVisibleContentPosition={{
              minIndexForVisible: 0,
              autoscrollToTopThreshold: 5,
            }}
            onScrollToIndexFailed={(info) => {
              // Scroll to approximate offset, then retry scrollToIndex after layout
              const offset = info.averageItemLength * info.index;
              flatListRef.current?.scrollToOffset({ offset, animated: true });
              setTimeout(() => {
                try {
                  flatListRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.5 });
                } catch {}
              }, 300);
            }}
          />
          {/* Empty-state overlay — rendered outside the inverted list so it is
              never affected by the inversion transform (fixes mirrored text on
              Android new arch, correct on iOS too). */}
          {!isSearching && !isLoadingInitial && messages.length === 0 && (
            <View style={StyleSheet.absoluteFill} pointerEvents="none">
              {renderChatEmptyState()}
            </View>
          )}
          </View>
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

        {isBroadcastChat ? (
          // Read-only broadcast channel: no composer — users can only read.
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 14, paddingHorizontal: 20, backgroundColor: isDarkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)', borderTopWidth: 0.5, borderTopColor: theme.colors.borderColor }}>
            <Ionicons name="megaphone-outline" size={16} color={theme.colors.placeHolderTextColor} style={{ marginRight: 8 }} />
            <Text style={{ fontFamily: 'Roboto-Regular', fontSize: 13, color: theme.colors.placeHolderTextColor }}>Only the admin can post in this channel.</Text>
          </View>
        ) : contactBlockedHide ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 20, backgroundColor: isDarkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)', borderTopWidth: 0.5, borderTopColor: theme.colors.borderColor }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
              <Ionicons name="ban-outline" size={16} color={theme.colors.placeHolderTextColor} style={{ marginRight: 8 }} />
              <Text style={{ fontFamily: 'Roboto-Regular', fontSize: 13, color: theme.colors.placeHolderTextColor }}>You blocked this contact.</Text>
            </View>
            <TouchableOpacity onPress={handleUnblockFromChat} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={{ fontFamily: 'Roboto-Medium', fontSize: 14, color: theme.colors.primaryColor || '#03b0a2' }}>Unblock</Text>
            </TouchableOpacity>
          </View>
        ) : (messagingDisabled || amBlocked || amNotGroupMember) ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 14, paddingHorizontal: 20, backgroundColor: isDarkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)', borderTopWidth: 0.5, borderTopColor: theme.colors.borderColor }}>
            <Ionicons name="lock-closed-outline" size={16} color={theme.colors.placeHolderTextColor} style={{ marginRight: 8 }} />
            <Text style={{ fontFamily: 'Roboto-Regular', fontSize: 13, color: theme.colors.placeHolderTextColor }}>{amNotGroupMember ? "You can't send messages because you're no longer a member of this group." : amBlocked ? "You can't send messages because your account has been blocked." : messagingDisabledText}</Text>
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
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ flexGrow: 0, height: 44 }}
              contentContainerStyle={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 18 }}
            >
              {emojiSectionsMeta.map((section) => {
                const active = section.key === activeEmojiSection;
                return (
                  <TouchableOpacity
                    key={section.key}
                    onPress={() => setActiveEmojiSection(section.key)}
                    activeOpacity={0.7}
                    style={{
                      height: 44,
                      alignItems: 'center',
                      justifyContent: 'center',
                      paddingHorizontal: 6,
                      borderBottomWidth: 2,
                      borderBottomColor: active ? theme.colors.themeColor : 'transparent',
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
            </ScrollView>

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

        {/* ─── REDESIGNED 3-DOT DROPDOWN (WhatsApp-style popover) ─── */}
        <Modal visible={showMenu} transparent animationType="none" onRequestClose={closeChatMenu} statusBarTranslucent>
          {/* Translucent tap-catcher — the dropdown floats over the chat */}
          <TouchableOpacity activeOpacity={1} onPress={closeChatMenu} style={chatMenuStyles.popoverRoot}>
            {/* The dropdown card itself. transformOrigin via small offset and scale
                + opacity gives the impression of popping out of the 3-dot icon. */}
            <Animated.View
              pointerEvents="box-none"
              style={[
                chatMenuStyles.popoverCard,
                {
                  backgroundColor: theme.colors.cardBackground,
                  borderColor: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
                  opacity: menuOpacityAnim,
                  transform: [
                    { scale: menuScaleAnim },
                    { translateX: menuOpacityAnim.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) },
                    { translateY: menuOpacityAnim.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }) },
                  ],
                },
              ]}
            >
              <ChatMenuItem
                icon="search-outline"
                iconLib="Ionicons"
                color="#4D7CFE"
                label="Search"
                onPress={() => { closeChatMenu(); setTimeout(() => handleToggleSearchBar(), 140); }}
                theme={theme}
              />
              <ChatMenuItem
                icon="person-outline"
                iconLib="Ionicons"
                color="#7C4DFF"
                label="Contact info"
                onPress={() => { closeChatMenu(); setTimeout(() => handleOpenContactInfo(), 140); }}
                theme={theme}
              />
              {/* Load older messages — WhatsApp-style backfill of history from the
                  server. Only shown while older messages remain (hasMoreMessages). */}
              {/* {hasMoreMessages && (
                <ChatMenuItem
                  icon="history"
                  iconLib="MaterialCommunityIcons"
                  color="#4DB6AC"
                  label={isLoadingOlder ? 'Loading older messages…' : 'Load older messages'}
                  onPress={() => {
                    closeChatMenu();
                    setTimeout(async () => {
                      if (isLoadingOlder || !hasMoreMessages) return;
                      setIsLoadingOlder(true);
                      if (Platform.OS === 'android') {
                        const { ToastAndroid: T } = require('react-native');
                        T.show('Loading older messages…', T.SHORT);
                      }
                      try { await loadMoreMessages?.(); } catch (_) {} finally { setIsLoadingOlder(false); }
                    }, 140);
                  }}
                  theme={theme}
                />
              )} */}
              <View style={[chatMenuStyles.popoverDivider, { backgroundColor: isDarkMode ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)' }]} />

              <ChatMenuItem
                icon="delete-sweep-outline"
                iconLib="MaterialCommunityIcons"
                color="#E06A6A"
                label="Clear chat"
                onPress={handleClearChatOptions}
                theme={theme}
                isDanger
              />
              <ChatMenuItem
                icon="broom"
                iconLib="MaterialCommunityIcons"
                color="#E06A6A"
                label="Clear for everyone"
                onPress={handleDeleteForEveryone}
                theme={theme}
                isDanger
              />
            </Animated.View>
          </TouchableOpacity>
        </Modal>

        {/* ─── CLEAR CHAT CONFIRMATION ─── */}
        <Modal
          animationType="fade"
          transparent
          visible={clearChatModalVisible}
          statusBarTranslucent
          onRequestClose={() => { if (!isClearingChat) setClearChatModalVisible(false); }}
        >
          <TouchableOpacity
            activeOpacity={1}
            onPress={() => { if (!isClearingChat) setClearChatModalVisible(false); }}
            style={chatMenuStyles.confirmOverlay}
          >
            <TouchableOpacity activeOpacity={1} style={[chatMenuStyles.confirmCard, { backgroundColor: theme.colors.cardBackground }]}>
              <View style={chatMenuStyles.confirmIconWrap}>
                <MaterialIcons name="delete-sweep" size={30} color="#E06A6A" />
              </View>
              <Text style={[chatMenuStyles.confirmTitle, { color: theme.colors.primaryTextColor }]}>
                Clear this chat?
              </Text>
              <Text style={[chatMenuStyles.confirmSubtitle, { color: theme.colors.placeHolderTextColor }]}>
                All messages will be removed from your device. The other person will still see them and can continue messaging you in this chat.
              </Text>

              <View style={chatMenuStyles.confirmActions}>
                <TouchableOpacity
                  onPress={() => setClearChatModalVisible(false)}
                  disabled={isClearingChat}
                  activeOpacity={0.7}
                  style={[chatMenuStyles.confirmCancelBtn, { borderColor: isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }]}
                >
                  <Text style={[chatMenuStyles.confirmCancelText, { color: theme.colors.primaryTextColor }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={onConfirmClearChat}
                  disabled={isClearingChat}
                  activeOpacity={0.7}
                  style={chatMenuStyles.confirmDangerBtn}
                >
                  {isClearingChat ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={chatMenuStyles.confirmDangerText}>Clear chat</Text>
                  )}
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>

        {/* ─── DELETE FOR EVERYONE CONFIRMATION ─── */}
        <Modal
          animationType="fade"
          transparent
          visible={deleteEveryoneModalVisible}
          statusBarTranslucent
          onRequestClose={() => { if (!isDeletingEveryone) setDeleteEveryoneModalVisible(false); }}
        >
          <TouchableOpacity
            activeOpacity={1}
            onPress={() => { if (!isDeletingEveryone) setDeleteEveryoneModalVisible(false); }}
            style={chatMenuStyles.confirmOverlay}
          >
            <TouchableOpacity activeOpacity={1} style={[chatMenuStyles.confirmCard, { backgroundColor: theme.colors.cardBackground }]}>
              <View style={chatMenuStyles.confirmIconWrap}>
                <MaterialCommunityIcons name="broom" size={30} color="#E06A6A" />
              </View>
              <Text style={[chatMenuStyles.confirmTitle, { color: theme.colors.primaryTextColor }]}>
                Clear chat for everyone?
              </Text>
              <Text style={[chatMenuStyles.confirmSubtitle, { color: theme.colors.placeHolderTextColor }]}>
                All messages will be cleared for both you and {chatData?.peerUser?.fullName || 'the other person'}. The chat stays in both lists, so you can keep messaging. This cannot be undone.
              </Text>

              <View style={chatMenuStyles.confirmActions}>
                <TouchableOpacity
                  onPress={() => setDeleteEveryoneModalVisible(false)}
                  disabled={isDeletingEveryone}
                  activeOpacity={0.7}
                  style={[chatMenuStyles.confirmCancelBtn, { borderColor: isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }]}
                >
                  <Text style={[chatMenuStyles.confirmCancelText, { color: theme.colors.primaryTextColor }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={onConfirmDeleteForEveryone}
                  disabled={isDeletingEveryone}
                  activeOpacity={0.7}
                  style={chatMenuStyles.confirmDangerBtn}
                >
                  {isDeletingEveryone ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={chatMenuStyles.confirmDangerText}>Clear for all</Text>
                  )}
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
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
                borderRadius: 22,
                overflow: 'hidden',
                backgroundColor: isDarkMode ? '#233138' : '#FFFFFF',
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
                transform: [{ translateY: mediaSheetAnim }],
                shadowColor: '#000',
                shadowOpacity: isDarkMode ? 0.45 : 0.18,
                shadowRadius: 18,
                shadowOffset: { width: 0, height: 8 },
                elevation: 14,
              }}
            >
              {/* Grip handle — tap-outside, swipe-down, or grip all dismiss. */}
              <View style={{ alignItems: 'center', paddingTop: 9, paddingBottom: 4 }}>
                <View style={{ width: 38, height: 4, borderRadius: 2, backgroundColor: isDarkMode ? 'rgba(233,237,239,0.28)' : 'rgba(0,0,0,0.16)' }} />
              </View>

              <View
                style={{
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  paddingHorizontal: 6,
                  paddingTop: 10,
                  paddingBottom: Platform.OS === 'ios' ? 26 : 20,
                  rowGap: 20,
                }}
              >
                {MEDIA_PANEL_OPTIONS.map((item, idx) => {
                  const press = mediaOptionPressAnims[item.key];
                  const entry = mediaOptionEntryAnims[idx];
                  return (
                    <Animated.View
                      key={item.key}
                      style={{
                        width: '25%',
                        alignItems: 'center',
                        opacity: entry,
                        transform: [
                          { scale: Animated.multiply(press, entry.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] })) },
                          { translateY: entry.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
                        ],
                      }}
                    >
                      <Pressable
                        onPressIn={() => handleMediaOptionPressIn(item.key)}
                        onPressOut={() => handleMediaOptionPressOut(item.key)}
                        onPress={() => handleMediaOptionSelect(item.key)}
                        style={{ alignItems: 'center' }}
                        accessibilityRole="button"
                        accessibilityLabel={item.label}
                      >
                        <GradientDisc id={item.key} grad={item.grad} color={item.color} icon={item.icon} size={54} />
                        <Text
                          style={{
                            marginTop: 8,
                            fontSize: 12,
                            color: isDarkMode ? '#AEBAC1' : '#54656F',
                            fontFamily: 'Roboto-Regular',
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
                  {localMediaViewer.message?.senderId === currentUserId
                    ? 'You'
                    : resolveContactName(
                        localMediaViewer.message?.senderId,
                        localMediaViewer.message?.senderName || chatData?.peerUser?.name || 'Photo',
                        groupMembersMap?.[localMediaViewer.message?.senderId]?.mobileNumber
                      )}
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
                  uri={toSecureMediaUri(localMediaViewer.uri)}
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
                source={{ uri: toSecureMediaUri(localMediaViewer.uri) }}
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
      </Reanimated.View>
    </View>
  );
}