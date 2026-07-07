import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, Dimensions, Image, PanResponder, Platform, Text, TouchableOpacity, View,} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import { useTheme } from '../contexts/ThemeContext';
import { useRealtimeChat } from '../contexts/RealtimeChatContext';
import ChatDatabase from '../services/ChatDatabase';
import ContactDatabase from '../services/ContactDatabase';
import { getSocket, isSocketConnected } from '../Redux/Services/Socket/socket';
import {
  getActiveChatFromRoute,
  getCurrentRouteSnapshot,
  navigationRef,
  subscribeNavigationSnapshot,
} from '../Redux/Services/navigationService';
import { subscribeSessionReset } from '../services/sessionEvents';
import { previewFor, buildNotificationModel } from '../firebase/notificationModel';
import { onlyDigits } from '../utils/savedContactName';
import { claimNotification } from '../firebase/notificationDedupe';

// Preload the notification sound once at module level
const MESSAGE_SOUND = require('../../assets/sounds/message-sound-001.mp3');

let OptionalBlurView = null;
try {
  OptionalBlurView = require('expo-blur').BlurView;
} catch {
  OptionalBlurView = null;
}

const AUTO_DISMISS_MS = 4000;
// Absolute upper bound a banner may stay visible, regardless of interaction /
// dropped timers. Pure safety net — normal dismissal happens at AUTO_DISMISS_MS.
const MAX_VISIBLE_MS = 12000;
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
  // Route the banner CONTENT through the SAME canonical model the OS push uses
  // (firebase/notificationModel.buildNotificationModel) so the foreground in-app
  // banner and the background/killed push render identically — same title/body,
  // same media-preview text, same avatar and group rules. Before this the banner
  // had its own divergent copy of that logic.
  const model = buildNotificationModel(payload);

  // Legacy fallbacks for the few fields the canonical model doesn't carry, and
  // for routing-only payloads where it returns null.
  const notification = payload?.notificationData?.notification || {};
  const data = payload?.notificationData?.data || {};

  const chatId = model?.chatId
    || normalizeId(payload?.chatId)
    || normalizeId(data?.groupId || payload?.groupId);
  if (!chatId) return null;

  const isGroup = !!model?.isGroup;
  const groupId = model?.groupId || normalizeId(data?.groupId || payload?.groupId);

  // Bare preview WITHOUT the "Sender: " prefix — kept so a group banner's sender
  // prefix can be re-resolved against this device's own contacts in enqueueBanner.
  const lineBody = model?.lineBody
    || notification?.body || data?.text || payload?.text || '';

  return {
    id: String(payload?.notificationId || model?.messageId || payload?.messageId
      || `${chatId}_${payload?.timestamp || model?.timestamp || Date.now()}`),
    notificationId: payload?.notificationId || null,
    messageId: model?.messageId || payload?.messageId || null,
    chatId,
    groupId,
    senderId: model?.senderId || normalizeId(payload?.senderId),
    senderName: model?.senderName || data?.senderName || notification?.title
      || payload?.senderName || 'New Message',
    // Sender's number so this device can resolve its OWN saved-contact name and
    // fall back to the number when the sender isn't saved (matches the push).
    senderMobile: model?.senderMobile || data?.senderMobile || payload?.senderMobile || null,
    groupName: model?.groupName || data?.groupName || payload?.groupName
      || data?.chatName || payload?.chatName || '',
    groupAvatar: model?.groupAvatar || data?.groupAvatar || payload?.groupAvatar
      || data?.chatAvatar || payload?.chatAvatar || null,
    title: model?.title || notification?.title || 'New Message',
    body: model?.body || notification?.body || lineBody || '',
    lineBody,
    avatarUrl: model?.avatar || data?.profileImage || payload?.profileImage || null,
    timestamp: Number(payload?.timestamp || payload?.sentAt || model?.timestamp || Date.now()),
    isGroup,
    chatType: model?.chatType || (isGroup ? 'group' : 'private'),
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
  // Backstops so a banner can NEVER get stuck on screen (the "K + blur card on
  // every screen until restart" bug): a guaranteed fallback for the exit
  // animation's dropped completion callback, and an absolute max-visible cap.
  const dismissFallbackRef = useRef(null);
  const maxVisibleRef = useRef(null);
  const dismissCurrentRef = useRef(null);
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
      if (dismissFallbackRef.current) { clearTimeout(dismissFallbackRef.current); dismissFallbackRef.current = null; }
      if (maxVisibleRef.current) { clearTimeout(maxVisibleRef.current); maxVisibleRef.current = null; }
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
      // Absolute backstop: force this banner away after MAX_VISIBLE_MS no matter
      // what (a dropped onPressOut, a cleared auto-dismiss, a swallowed animation
      // callback). Uses a ref to the latest dismissCurrent to avoid a dep cycle.
      if (maxVisibleRef.current) clearTimeout(maxVisibleRef.current);
      maxVisibleRef.current = setTimeout(() => {
        if (currentRef.current) dismissCurrentRef.current?.('max_visible');
      }, MAX_VISIBLE_MS);
      animateIn();
      return;
    }
  }, [animateIn, shouldSuppressForActiveRoute]);

  const dismissCurrent = useCallback((reason = 'manual', onDone) => {
    clearAutoDismiss();
    if (maxVisibleRef.current) { clearTimeout(maxVisibleRef.current); maxVisibleRef.current = null; }
    // The state reset MUST NOT depend solely on the native animation's completion
    // callback — on iOS that callback can be dropped (app goes inactive/background
    // mid-animation, or the animated node detaches), which left `banner` set and
    // the blurred card stuck on every screen until an app restart. Run the reset
    // through a guarded `finish()` invoked by BOTH the animation callback AND a
    // guaranteed fallback timer, so whichever fires first clears the banner.
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (dismissFallbackRef.current) { clearTimeout(dismissFallbackRef.current); dismissFallbackRef.current = null; }
      dragY.setValue(0);
      currentRef.current = null;
      setBanner(null);
      if (typeof onDone === 'function') onDone(reason);
      requestAnimationFrame(() => {
        showNext();
      });
    };
    Animated.timing(translateY, {
      toValue: -130,
      duration: 180,
      useNativeDriver: true,
    }).start(finish);
    if (dismissFallbackRef.current) clearTimeout(dismissFallbackRef.current);
    dismissFallbackRef.current = setTimeout(finish, 320);
  }, [clearAutoDismiss, dragY, showNext, translateY]);

  // Keep a live ref to dismissCurrent so backstop timers (armed in showNext) can
  // call the latest version without creating a useCallback dependency cycle.
  useEffect(() => {
    dismissCurrentRef.current = dismissCurrent;
  }, [dismissCurrent]);

  // Is this chat currently muted FOR THIS USER? Checks the in-memory chatMap
  // first (cheap, kept fresh by mute:updated), then falls back to SQLite. A null
  // mute_until on a muted row = indefinite ("Always"); a past value has expired.
  const isMutedNow = useCallback(async (item) => {
    // muteUntil may be a number (live chatMap) or a string (SQLite TEXT) holding
    // either epoch ms ("253370764800000") or an ISO date. Coerce both robustly.
    const toMs = (v) => {
      if (v == null) return null;
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      const s = String(v).trim();
      if (/^\d+$/.test(s)) return Number(s);
      const t = new Date(s).getTime();
      return Number.isFinite(t) ? t : null;
    };
    const isActive = (isMuted, muteUntil) => {
      if (!isMuted) return false;
      const until = toMs(muteUntil);
      return until == null || until > Date.now();
    };
    const id = item?.chatId || item?.groupId;
    if (!id) return false;
    const entry = realtimeStateRef.current?.chatMap?.[String(id)]
      || (item?.groupId ? realtimeStateRef.current?.chatMap?.[String(item.groupId)] : null);
    if (entry && entry.isMuted != null) {
      return isActive(entry.isMuted, entry.muteUntil);
    }
    try {
      const row = await ChatDatabase.getChatById(String(id));
      return row ? isActive(row.isMuted, row.muteUntil) : false;
    } catch {
      return false;
    }
  }, []);

  const enqueueBanner = useCallback(async (rawPayload) => {
    if (appStateRef.current !== 'active') return;

    // Call-log entries (the in-thread "call" message the backend writes when a
    // call ends) still fan out as a normal message:new so the call bubble renders
    // in the thread — but they must NEVER raise a chat banner. Suppress here, the
    // single chokepoint every banner path funnels through.
    const msgType = rawPayload?.notificationData?.data?.messageType
      || rawPayload?.notificationData?.data?.type
      || rawPayload?.messageType
      || rawPayload?.type
      || 'text';
    if (String(msgType).toLowerCase() === 'call') return;

    const dndEnabled = await shouldRespectDnd();
    if (dndEnabled) return;

    const item = buildBannerModel(rawPayload);
    if (!item?.id || !item?.chatId) return;

    if (seenRef.current.has(item.id)) return;
    seenRef.current.add(item.id);

    // Cross-path dedupe: if a push already notified this messageId (common across
    // a background→foreground transition where the OS showed the push and the
    // socket then re-flushes the same message), suppress the banner. Keyed on
    // messageId so it matches what the OS push path claims; payloads without a
    // messageId fall back to the in-session seenRef guard above.
    if (item.messageId && !claimNotification(item.messageId)) return;

    if (shouldSuppressForActiveRoute(item)) {
      return;
    }

    // ── Mute gate ──────────────────────────────────────────────────
    // WhatsApp-style mute suppresses the ALERT only (in-app banner + sound) for
    // THIS chat — the message has already been persisted + unread-bumped by the
    // realtime pipeline; we only withhold the notification here. Source of truth
    // is the local mute mirror (SQLite is_muted/mute_until), hydrated by
    // mute:sync / mute:updated. Lazy expiry: a timed mute that has passed no
    // longer suppresses. getChatById matches on chat_id OR group_id, so one
    // lookup covers both 1:1 and group banners.
    if (await isMutedNow(item)) return;

    // ── Display-name resolution (matches the chat list AND the OS push) ─────
    // The sender is shown exactly as THIS DEVICE knows them, applying the
    // product rule:
    //   • saved / registered contact   → show the saved name
    //   • unsaved sender               → show the mobile number
    //   • mobile number missing        → fall back to whatever name we have
    // The device-saved contact name is authoritative (the chat list reads the
    // same contacts table) so the banner stays correct even when the server's
    // contact sync is stale. Best-effort: any failure keeps the canonical name.
    try {
      const local = (item.senderId || item.senderMobile)
        ? await ContactDatabase.getContactDisplay({ userId: item.senderId, phone: item.senderMobile })
        : null;
      const localName = local?.fullName || null;

      const mobile = item.senderMobile ? String(item.senderMobile) : null;
      const rawName = (item.senderName && item.senderName !== 'New Message') ? item.senderName : null;
      // The server name can itself BE the mobile number (the backend uses it for
      // unsaved senders) — don't treat a bare number as a "registered" name.
      const serverRealName = rawName && (!mobile || onlyDigits(rawName) !== onlyDigits(mobile))
        ? rawName : null;

      const resolvedName = localName || serverRealName || mobile || item.senderName || 'New Message';

      if (item.isGroup) {
        // Group: the title stays the group name — only the "Sender: " body
        // prefix uses the resolved sender name.
        if (resolvedName && resolvedName !== 'New Message') {
          item.body = `${resolvedName}: ${item.lineBody || ''}`.trim();
        }
      } else {
        item.senderName = resolvedName;
        item.title = resolvedName;
      }
      if (!item.avatarUrl && local?.profileImage) item.avatarUrl = local.profileImage;
    } catch {
      // keep whatever buildNotificationModel resolved
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
  }, [shouldRespectDnd, shouldSuppressForActiveRoute, showNext, startAutoDismiss, playNotificationSound, isMutedNow]);

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
        // Hard-clear any visible banner on leaving the foreground. A transient
        // message banner must never survive a background→foreground cycle: the
        // exit-animation callback that normally clears it can be dropped while
        // backgrounding, which is exactly what left the blurred "K" card stuck on
        // every screen until a restart. Dropping a stale banner here is harmless.
        clearAutoDismiss();
        if (dismissFallbackRef.current) { clearTimeout(dismissFallbackRef.current); dismissFallbackRef.current = null; }
        if (maxVisibleRef.current) { clearTimeout(maxVisibleRef.current); maxVisibleRef.current = null; }
        if (currentRef.current) {
          currentRef.current = null;
          setBanner(null);
          dragY.setValue(0);
          translateY.setValue(-120);
        }
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
    // 1-on-1 messages arrive as `message:new` / `message:received` — the events
    // the backend actually emits (and RealtimeChatContext consumes). The old
    // binding to `notification:message:new` never fired because nothing emits it,
    // so direct-message banners never showed. Transform the raw message payload
    // into the banner shape here (mirrors groupMessageHandler).
    const directMessageHandler = (payload) => {
      // Mirror RealtimeChatContext.normalizeMessagePayload: the actual message may
      // be nested under `message`/`data`, and chatId can arrive as `roomId`/`chat`.
      // This handler previously read only `data.chatId`, so 1-1 payloads that nested
      // the message or used a roomId/chat alias were silently dropped (no banner),
      // while groups still worked because groupId sits at the top level.
      const source = payload?.data || payload;
      const data = source?.message || source?.data || source;

      // Groups are handled by groupMessageHandler; only treat as group when the
      // message explicitly targets a group (chatType 'group' AND a groupId), so a
      // 1-on-1 message that merely references a groupId isn't dropped.
      if ((data?.chatType === 'group' || source?.chatType === 'group')
        && (data?.groupId || source?.groupId)) return;

      const chatId = data?.chatId || data?.roomId || data?.chat
        || source?.chatId || source?.roomId || source?.chat;
      const senderId = data?.senderId || data?.sender?._id || data?.sender?.id
        || source?.senderId || source?.from;
      if (!chatId) return;

      // Skip our own messages.
      const currentUserId = realtimeStateRef.current?.currentUserId;
      if (currentUserId && senderId && String(senderId) === String(currentUserId)) return;

      const senderName = data?.senderName || data?.sender?.fullName || data?.sender?.name
        || data?.sender?.username || source?.senderName || 'New Message';
      // Backend attaches the receiver-resolved number on the receiver-bound emit
      // as `senderMobile` so this device can show it for an unsaved sender.
      const senderMobile = data?.senderMobile || source?.senderMobile || null;
      const avatar = data?.sender?.profileImage || data?.sender?.profileImageUrl
        || data?.profileImage || data?.senderProfileImage || data?.senderImage
        || source?.profileImage || null;

      // Preview text per message type (WhatsApp-style) — shared with the OS push
      // path so the banner and the notification show identical text.
      const messageType = data?.messageType || data?.type || 'text';
      const bodyText = previewFor(messageType, data?.text || data?.content || '');

      enqueueBanner({
        messageId: data?.messageId || data?._id,
        chatId,
        senderId,
        senderName,
        senderMobile,
        chatType: 'private',
        isGroup: false,
        text: bodyText,
        profileImage: avatar,
        timestamp: data?.timestamp || data?.sentAt || data?.createdAt || Date.now(),
        notificationData: {
          notification: { title: senderName, body: bodyText },
          data: { ...data, chatType: 'private', senderName, senderMobile, profileImage: avatar },
        },
      });
    };

    // Handler for group:message:received / group:message:new — look up names from chatMap
    const groupMessageHandler = (payload) => {
      const data = payload?.data || payload;
      const groupId = data?.groupId;
      if (!groupId) return;

      // Skip groups the user has left or been removed from — no banner for an ex-member.
      const inactiveGroupIds = realtimeStateRef.current?.inactiveGroupIds || {};
      if (inactiveGroupIds[String(groupId)] || (data?.chatId && inactiveGroupIds[String(data.chatId)])) return;

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

      // Build preview text based on message type — shared with the OS push path
      // so the banner and the notification show identical text.
      const messageType = data?.messageType || 'text';
      const bodyText = previewFor(messageType, data?.text || '');

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
        listenerSocketRef.current.off('message:new', directMessageHandler);
        listenerSocketRef.current.off('message:received', directMessageHandler);
        listenerSocketRef.current.off('group:message:received', groupMessageHandler);
        listenerSocketRef.current.off('group:message:new', groupMessageHandler);
      }

      socket.on('message:new', directMessageHandler);
      socket.on('message:received', directMessageHandler);
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
        listenerSocketRef.current.off('message:new', directMessageHandler);
        listenerSocketRef.current.off('message:received', directMessageHandler);
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