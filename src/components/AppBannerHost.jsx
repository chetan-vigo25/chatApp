import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Dimensions,
  Image,
  PanResponder,
  Platform,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import { useTheme } from '../contexts/ThemeContext';
import { useRealtimeChat } from '../contexts/RealtimeChatContext';
import { getSocket, isSocketConnected } from '../Redux/Services/Socket/socket';
import {
  getActiveChatFromRoute,
  getCurrentRouteSnapshot,
  navigationRef,
  subscribeNavigationSnapshot,
} from '../Redux/Services/navigationService';
import { subscribeSessionReset } from '../services/sessionEvents';

// Preload the notification sound once at module level
const MESSAGE_SOUND = require('../../assets/sounds/message-sound-01.mp3');

let OptionalBlurView = null;
try {
  OptionalBlurView = require('expo-blur').BlurView;
} catch {
  OptionalBlurView = null;
}

const AUTO_DISMISS_MS = 4000;
const ATTACH_RETRY_MS = 800;
const DND_KEYS = ['do_not_disturb', 'dnd_enabled', 'notifications_dnd_enabled'];

const normalizeId = (value) => {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    const candidate = value?._id || value?.id || value?.userId || value?.$oid || null;
    return candidate == null ? null : String(candidate);
  }
  return null;
};

const isTruthyString = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const formatClock = (timestamp) => {
  if (!timestamp) return '';
  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const buildBannerModel = (payload = {}) => {
  const notification = payload?.notificationData?.notification || {};
  const data = payload?.notificationData?.data || {};
  const avtar = data?.profileImage || payload?.profileImage || null;

  const isGroup = String(data?.isGroup || payload?.isGroup || data?.chatType === 'group' || payload?.chatType === 'group' || 'false').toLowerCase() === 'true'
    || data?.chatType === 'group' || payload?.chatType === 'group';

  const senderName =
    data?.senderName ||
    notification?.title ||
    payload?.senderName ||
    'New Message';

  // For group chats: extract group metadata
  const groupId = normalizeId(data?.groupId || payload?.groupId);
  const groupName = data?.groupName || payload?.groupName || data?.chatName || payload?.chatName || notification?.title || '';
  const groupAvatar = data?.groupAvatar || payload?.groupAvatar || data?.chatAvatar || payload?.chatAvatar || null;

  // For group banners: title = group name, body = "SenderName: message"
  const title = isGroup
    ? (groupName || notification?.title || senderName)
    : (notification?.title || senderName);
  const body = isGroup
    ? (notification?.body || (senderName !== 'New Message' ? `${senderName}: ${data?.text || payload?.text || ''}` : (data?.text || payload?.text || '')))
    : (notification?.body || '');

  return {
    id: String(payload?.notificationId || payload?.messageId || `${payload?.chatId || 'chat'}_${payload?.timestamp || Date.now()}`),
    notificationId: payload?.notificationId || null,
    messageId: payload?.messageId || null,
    chatId: normalizeId(payload?.chatId) || groupId,
    groupId,
    senderId: normalizeId(payload?.senderId),
    senderName,
    groupName,
    groupAvatar,
    title,
    body,
    avatarUrl: isGroup ? (groupAvatar || avtar) : avtar,
    timestamp: Number(payload?.timestamp || payload?.sentAt || Date.now()),
    isGroup,
    chatType: isGroup ? 'group' : 'private',
    metadata: payload?.metadata || {},
    raw: payload,
  };
};

export default function WhatsAppBannerHost() {
  const { theme } = useTheme();
  const { state: realtimeState } = useRealtimeChat();
  const insets = useSafeAreaInsets();
  const [banner, setBanner] = useState(null);
  const [screenWidth, setScreenWidth] = useState(Dimensions.get('window').width);

  const translateY = useRef(new Animated.Value(-120)).current;
  const dragY = useRef(new Animated.Value(0)).current;
  const autoDismissRef = useRef(null);
  const attachTimerRef = useRef(null);
  const queueRef = useRef([]);
  const currentRef = useRef(null);
  const listenerSocketRef = useRef(null);
  const seenRef = useRef(new Set());
  const appStateRef = useRef(AppState.currentState);

  // Keep a ref to realtime state so socket handlers can read latest chatMap/currentUserId
  const realtimeStateRef = useRef(realtimeState);
  realtimeStateRef.current = realtimeState;

  // Notification sound — preload once, reuse on every banner
  const soundRef = useRef(null);

  const playNotificationSound = useCallback(async () => {
    try {
      // Unload previous instance to avoid memory leak
      if (soundRef.current) {
        try { await soundRef.current.unloadAsync(); } catch {}
        soundRef.current = null;
      }
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        staysActiveInBackground: false,
      });
      const { sound } = await Audio.Sound.createAsync(MESSAGE_SOUND, {
        shouldPlay: true,
        volume: 1.0,
      });
      soundRef.current = sound;
      // Auto-unload when playback finishes
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.didJustFinish) {
          sound.unloadAsync().catch(() => {});
          if (soundRef.current === sound) soundRef.current = null;
        }
      });
    } catch {}
  }, []);

  // Cleanup sound on unmount
  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync().catch(() => {});
        soundRef.current = null;
      }
    };
  }, []);

  const clearAutoDismiss = useCallback(() => {
    if (autoDismissRef.current) {
      clearTimeout(autoDismissRef.current);
      autoDismissRef.current = null;
    }
  }, []);

  const startAutoDismiss = useCallback(() => {
    clearAutoDismiss();
    autoDismissRef.current = setTimeout(() => {
      const current = currentRef.current;
      if (!current) return;
      dismissCurrent('timeout');
    }, AUTO_DISMISS_MS);
  }, [clearAutoDismiss]);

  const shouldRespectDnd = useCallback(async () => {
    try {
      const values = await AsyncStorage.multiGet(DND_KEYS);
      return values.some(([, value]) => isTruthyString(value));
    } catch {
      return false;
    }
  }, []);

  const shouldSuppressForActiveRoute = useCallback((item) => {
    const route = getCurrentRouteSnapshot();
    const active = getActiveChatFromRoute(route);

    if (active.routeName !== 'ChatScreen') {
      return false;
    }

    if (active.chatId && item.chatId && active.chatId === item.chatId) {
      return true;
    }

    // For group chats, also check if active chat matches the groupId
    if (active.chatId && item.groupId && active.chatId === item.groupId) {
      return true;
    }

    if (!active.chatId && active.peerUserId && item.senderId && active.peerUserId === item.senderId) {
      return true;
    }

    return false;
  }, []);

  const animateIn = useCallback(() => {
    translateY.setValue(-120);
    dragY.setValue(0);
    Animated.spring(translateY, {
      toValue: 0,
      useNativeDriver: true,
      damping: 16,
      stiffness: 220,
      mass: 0.9,
    }).start(() => {
      startAutoDismiss();
    });
  }, [dragY, startAutoDismiss, translateY]);

  const showNext = useCallback(() => {
    if (currentRef.current) return;
    if (queueRef.current.length === 0) return;

    while (queueRef.current.length > 0) {
      const next = queueRef.current.shift();
      if (!next) continue;
      if (shouldSuppressForActiveRoute(next)) {
        continue;
      }

      currentRef.current = next;
      setBanner(next);
      animateIn();
      return;
    }
  }, [animateIn, shouldSuppressForActiveRoute]);

  const dismissCurrent = useCallback((reason = 'manual', onDone) => {
    clearAutoDismiss();
    Animated.timing(translateY, {
      toValue: -130,
      duration: 180,
      useNativeDriver: true,
    }).start(() => {
      dragY.setValue(0);
      currentRef.current = null;
      setBanner(null);
      if (typeof onDone === 'function') onDone(reason);
      requestAnimationFrame(() => {
        showNext();
      });
    });
  }, [clearAutoDismiss, dragY, showNext, translateY]);

  const enqueueBanner = useCallback(async (rawPayload) => {
    if (appStateRef.current !== 'active') return;

    const dndEnabled = await shouldRespectDnd();
    if (dndEnabled) return;

    const item = buildBannerModel(rawPayload);
    if (!item?.id || !item?.chatId) return;

    if (seenRef.current.has(item.id)) return;
    seenRef.current.add(item.id);

    if (shouldSuppressForActiveRoute(item)) {
      return;
    }

    // Play notification sound for every new banner
    playNotificationSound();

    if (currentRef.current?.chatId && currentRef.current.chatId === item.chatId) {
      currentRef.current = item;
      setBanner(item);
      startAutoDismiss();
      return;
    }

    const existingIndex = queueRef.current.findIndex((entry) => entry.chatId === item.chatId);
    if (existingIndex >= 0) {
      queueRef.current[existingIndex] = item;
    } else {
      queueRef.current.push(item);
    }

    showNext();
  }, [shouldRespectDnd, shouldSuppressForActiveRoute, showNext, startAutoDismiss, playNotificationSound]);

  const handleBannerPress = useCallback(() => {
    const current = currentRef.current;
    if (!current) return;

    dismissCurrent('navigate', () => {
      if (!navigationRef.isReady()) return;

      if (current.isGroup) {
        // Navigate as group chat — pass item with group metadata so ChatScreen/useChatLogic recognizes it
        navigationRef.navigate('ChatScreen', {
          item: {
            chatId: current.chatId,
            _id: current.chatId,
            chatType: 'group',
            isGroup: true,
            groupId: current.groupId || current.chatId,
            chatName: current.groupName || current.title || 'Group',
            chatAvatar: current.groupAvatar || null,
            group: {
              _id: current.groupId || current.chatId,
              name: current.groupName || current.title || 'Group',
              avatar: current.groupAvatar || null,
            },
          },
        });
      } else {
        // Navigate as 1-on-1 chat
        navigationRef.navigate('ChatScreen', {
          chatId: current.chatId,
          user: {
            _id: current.senderId,
            fullName: current.senderName,
            profileImage: current.avatarUrl || null,
          },
        });
      }
    });
  }, [dismissCurrent]);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) => Math.abs(gestureState.dy) > 8,
    onPanResponderGrant: () => {
      clearAutoDismiss();
    },
    onPanResponderMove: (_, gestureState) => {
      if (gestureState.dy < 0) {
        dragY.setValue(gestureState.dy);
      }
    },
    onPanResponderRelease: (_, gestureState) => {
      if (gestureState.dy < -42 || gestureState.vy < -0.65) {
        dismissCurrent('swipe');
        return;
      }

      Animated.spring(dragY, {
        toValue: 0,
        useNativeDriver: true,
        damping: 16,
        stiffness: 180,
      }).start(() => startAutoDismiss());
    },
    onPanResponderTerminate: () => {
      Animated.spring(dragY, {
        toValue: 0,
        useNativeDriver: true,
      }).start(() => startAutoDismiss());
    },
  }), [clearAutoDismiss, dismissCurrent, dragY, startAutoDismiss]);

  useEffect(() => {
    const onAppState = (next) => {
      appStateRef.current = next;
      if (next !== 'active') {
        clearAutoDismiss();
      } else if (currentRef.current) {
        startAutoDismiss();
      }
    };

    const appSub = AppState.addEventListener('change', onAppState);
    return () => appSub.remove();
  }, [clearAutoDismiss, startAutoDismiss]);

  useEffect(() => {
    const unsubscribeNav = subscribeNavigationSnapshot(() => {
      const current = currentRef.current;
      if (!current) return;
      if (shouldSuppressForActiveRoute(current)) {
        dismissCurrent('route_match');
      }
    });

    const unsubscribeReset = subscribeSessionReset(() => {
      queueRef.current = [];
      currentRef.current = null;
      setBanner(null);
      clearAutoDismiss();
      dragY.setValue(0);
      translateY.setValue(-120);
      seenRef.current.clear();
    });

    return () => {
      unsubscribeNav();
      unsubscribeReset();
    };
  }, [clearAutoDismiss, dismissCurrent, dragY, shouldSuppressForActiveRoute, translateY]);

  useEffect(() => {
    const onDimensionChange = ({ window }) => {
      setScreenWidth(window.width);
    };
    const dimensionSub = Dimensions.addEventListener('change', onDimensionChange);
    return () => {
      dimensionSub?.remove?.();
    };
  }, []);

  useEffect(() => {
    const handler = (payload) => {
      enqueueBanner(payload);
    };

    // Handler for group:message:received / group:message:new — look up names from chatMap
    const groupMessageHandler = (payload) => {
      const data = payload?.data || payload;
      const groupId = data?.groupId;
      if (!groupId) return;

      // Skip own messages
      const currentUserId = realtimeStateRef.current?.currentUserId;
      if (currentUserId && data?.senderId && String(data.senderId) === String(currentUserId)) return;

      // Look up group name and sender name from chatMap
      const chatMap = realtimeStateRef.current?.chatMap || {};
      const groupEntry = chatMap[groupId] || chatMap[data?.chatId] || {};
      const groupName = groupEntry?.chatName || groupEntry?.group?.name || groupEntry?.groupName || data?.groupName || '';
      const groupAvatar = groupEntry?.chatAvatar || groupEntry?.group?.avatar || groupEntry?.groupAvatar || data?.groupAvatar || null;

      // Look up sender name from group members/participants
      let senderName = data?.senderName || '';
      if (!senderName && data?.senderId) {
        const members = Array.isArray(groupEntry?.members) ? groupEntry.members : (Array.isArray(groupEntry?.participants) ? groupEntry.participants : []);
        const member = members.find((m) => {
          const mId = normalizeId(m?.userId || m?._id || m?.id);
          return mId && String(mId) === String(data.senderId);
        });
        senderName = member?.fullName || member?.username || member?.name || '';
      }

      // Build preview text based on message type
      const messageType = data?.messageType || 'text';
      let bodyText = data?.text || '';
      if (messageType === 'image') bodyText = 'Photo';
      else if (messageType === 'video') bodyText = 'Video';
      else if (messageType === 'audio') bodyText = 'Audio';
      else if (messageType === 'file') bodyText = 'Document';
      else if (messageType === 'location') bodyText = 'Location';
      else if (messageType === 'contact') bodyText = 'Contact';

      const senderPrefix = senderName ? `${senderName}: ` : '';

      enqueueBanner({
        messageId: data?.messageId || data?._id,
        chatId: data?.chatId || groupId,
        groupId,
        senderId: data?.senderId,
        senderName: senderName || 'New Message',
        chatType: 'group',
        isGroup: true,
        groupName,
        groupAvatar,
        text: bodyText,
        timestamp: data?.timestamp || data?.sentAt || Date.now(),
        notificationData: {
          notification: {
            title: groupName || 'Group',
            body: `${senderPrefix}${bodyText}`,
          },
          data: {
            ...data,
            isGroup: 'true',
            chatType: 'group',
            senderName,
            groupName,
            groupAvatar,
          },
        },
      });
    };

    const attach = () => {
      const socket = getSocket();
      if (!socket || !isSocketConnected()) {
        return false;
      }

      if (listenerSocketRef.current === socket) {
        return true;
      }

      if (listenerSocketRef.current) {
        listenerSocketRef.current.off('notification:message:new', handler);
        listenerSocketRef.current.off('group:message:received', groupMessageHandler);
        listenerSocketRef.current.off('group:message:new', groupMessageHandler);
      }

      socket.on('notification:message:new', handler);
      socket.on('group:message:received', groupMessageHandler);
      socket.on('group:message:new', groupMessageHandler);
      listenerSocketRef.current = socket;
      return true;
    };

    attach();
    attachTimerRef.current = setInterval(attach, ATTACH_RETRY_MS);

    return () => {
      clearAutoDismiss();
      if (attachTimerRef.current) {
        clearInterval(attachTimerRef.current);
        attachTimerRef.current = null;
      }
      if (listenerSocketRef.current) {
        listenerSocketRef.current.off('notification:message:new', handler);
        listenerSocketRef.current.off('group:message:received', groupMessageHandler);
        listenerSocketRef.current.off('group:message:new', groupMessageHandler);
        listenerSocketRef.current = null;
      }
    };
  }, [clearAutoDismiss, enqueueBanner]);

  if (!banner) return null;

  const topOffset = Math.max(insets.top + 4, Platform.OS === 'android' ? 10 : 8);
  const timeLabel = formatClock(banner.timestamp);

  const cardStyle = {
    minHeight: 74,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    overflow: 'hidden',
    justifyContent: 'center',
    borderWidth: Platform.OS === 'ios' ? 0.5 : 0,
    borderColor: 'rgba(255,255,255,0.28)',
    backgroundColor: Platform.OS === 'ios' ? 'rgba(255,255,255,0.18)' : theme.colors.cardBackground,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 18,
    elevation: 7,
  };

  const BannerBody = (
    <View style={cardStyle}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ width: 44, height: 44, borderRadius: 22, overflow: 'hidden', marginRight: 10, backgroundColor: theme.colors.themeColor, alignItems: 'center', justifyContent: 'center' }}>
          {banner.avatarUrl ? (
            <Image source={{ uri: banner.avatarUrl }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
          ) : (
            <Text style={{ color: theme.colors.textWhite, fontFamily: 'Roboto-SemiBold', fontSize: 16 }}>
              {(banner.senderName || 'U').charAt(0).toUpperCase()}
            </Text>
          )}
        </View>

        <View style={{ flex: 1, paddingRight: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.primaryTextColor, fontFamily: 'Roboto-SemiBold', fontSize: 14 }}>
              {banner.title || banner.senderName}
            </Text>
            {banner.isGroup ? (
              <View style={{ marginLeft: 6, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8, backgroundColor: theme.colors.menuBackground }}>
                <Text style={{ fontSize: 10, color: theme.colors.placeHolderTextColor, fontFamily: 'Roboto-Medium' }}>Group</Text>
              </View>
            ) : null}
          </View>
          <Text numberOfLines={1} style={{ marginTop: 2, color: theme.colors.placeHolderTextColor, fontSize: 13, fontFamily: 'Roboto-Regular' }}>
            {banner.body || 'New message'}
          </Text>
        </View>

        <Text style={{ color: theme.colors.placeHolderTextColor, fontSize: 11, fontFamily: 'Roboto-Medium' }}>
          {timeLabel}
        </Text>
      </View>
    </View>
  );

  return (
    <Animated.View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: topOffset,
        left: 10,
        right: 10,
        width: screenWidth - 20,
        zIndex: 9999,
        transform: [{ translateY }, { translateY: dragY }],
      }}
      {...panResponder.panHandlers}
    >
      <TouchableOpacity
        activeOpacity={0.96}
        onPressIn={clearAutoDismiss}
        onPressOut={startAutoDismiss}
        onPress={handleBannerPress}
      >
        {Platform.OS === 'ios' && OptionalBlurView ? (
          <OptionalBlurView intensity={45} tint={theme.colors.background === '#121212' ? 'dark' : 'light'} style={{ borderRadius: 14 }}>
            {BannerBody}
          </OptionalBlurView>
        ) : BannerBody}
      </TouchableOpacity>
    </Animated.View>
  );
}