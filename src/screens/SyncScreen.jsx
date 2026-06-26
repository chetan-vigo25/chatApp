import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  Animated,
  StyleSheet,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { APP_TAG_NAME } from '@env';

// Brand logo (same asset the Splash screen uses) — keeps launch → sync branding
// consistent. WhatsApp-style restore screen: logo centered with the progress.
const BRAND_LOGO = require('../../assets/icon0.png');
import ChatDatabase from '../services/ChatDatabase';
import ChatCache from '../services/ChatCache';
import { chatServices } from '../Redux/Services/Chat/Chat.Services';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { subscribeSessionReset } from '../services/sessionEvents';
import { waitWhilePaused } from '../services/syncPriority';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// ── First-time restore dedupe (module scope) ────────────────────────────────
// The initial chatlist+messages restore must run exactly ONCE. Two guards:
//   • _initialSyncDoneFor — userId that finished restoring in THIS app session,
//     so a SyncScreen remount (navigation reset / Fast Refresh) skips instantly
//     even before the persisted INITIAL_SYNC_COMPLETE flag is read back.
//   • _initialSyncPromise — the in-flight restore; concurrent mounts ride on the
//     same promise instead of each kicking off their own parallel restore.
// Across launches the persisted ChatDatabase.isInitialSyncDone(userId) flag is
// the source of truth; these only dedupe within a single running session.
let _initialSyncPromise = null;
let _initialSyncDoneFor = null;

// Set true when the background message warm should stop (logout / user-switch).
let _warmAbort = false;

// A session reset (logout / user-switch / token-refresh failure) clears the
// in-memory "already restored" memory so the next login re-evaluates restore
// from scratch. NOTE: performSessionReset now only WIPES SQLite for a different
// user or account deletion — a same-account logout PRESERVES the cache, so a
// returning user short-circuits via the persisted INITIAL_SYNC_COMPLETE flag and
// loads local-first (no full server refetch). We still abort any in-flight
// background warm so it can't write a logging-out user's messages mid-reset.
subscribeSessionReset(() => {
  _initialSyncPromise = null;
  _initialSyncDoneFor = null;
  _warmAbort = true;
});

const MSG_WARM_LIMIT = 25;        // recent messages to pre-cache per chat
const MSG_WARM_CONCURRENCY = 4;   // parallel chat fetches (was a batch of 3)
const MSG_WARM_WRITE_GAP_MS = 60; // breathing room between writes so chat-open reads slip in

const _normalizeMessage = (msg, chat, chatId) => ({
  id: msg._id || msg.messageId,
  serverMessageId: msg._id || msg.messageId,
  chatId,
  groupId: chat.groupId || (chat.chatType === 'group' ? chatId : null),
  senderId: msg.senderId || null,
  senderName: msg.senderName || null,
  text: msg.text || '',
  type: msg.messageType || msg.type || 'text',
  status: msg.status || 'sent',
  timestamp: msg.createdAt ? new Date(msg.createdAt).getTime() : Date.now(),
  createdAt: msg.createdAt || new Date().toISOString(),
  synced: 1,
  mediaUrl: msg.mediaUrl || null,
  mediaType: msg.mediaType || null,
  replyToMessageId: msg.replyToMessageId || (typeof msg.replyTo === 'string' ? msg.replyTo : msg.replyTo?._id) || null,
  replyPreviewText: msg.replyPreviewText || msg.replyTo?.text || null,
  replyPreviewType: msg.replyPreviewType || msg.replyTo?.messageType || null,
  replySenderId: msg.replySenderId || msg.replyTo?.senderId || null,
  replySenderName: msg.replySenderName || msg.replyTo?.senderName || null,
});

// Background, fire-and-forget warm of recent messages per chat. NOT awaited by
// the restore — the user is already in the app. Uses a bounded worker pool
// (MSG_WARM_CONCURRENCY) instead of the old sequential batches-of-3, and pulls
// fewer messages (older history loads lazily on chat open via message:sync /
// history backfill). Aborts immediately on logout.
const _warmRecentMessages = (chats) => {
  _warmAbort = false;
  const queue = [...chats];
  const worker = async () => {
    while (queue.length) {
      if (_warmAbort) return;
      // Never fire authenticated message fetches without a token (e.g. mid
      // logout/session reset) — that just spams 401 "No token provided".
      const token = await AsyncStorage.getItem('accessToken');
      if (!token) { _warmAbort = true; return; }
      const chat = queue.shift();
      const chatId = chat.chatId || chat._id;
      if (!chatId) continue;
      try {
        // Same-account re-login keeps the cache, so a chat may already hold its
        // recent messages locally. Skip the REST warm for those — chat-open
        // delta sync + reconnect catchup fill any gap. Only chats with no local
        // history (a fresh/different-user restore) are warmed from the server.
        const existingCount = await ChatDatabase.getMessageCount(chatId);
        if (_warmAbort) return;
        if (existingCount > 0) continue;
        const msgResponse = await chatServices.chatMessageList({ chatId, page: 1, limit: MSG_WARM_LIMIT });
        if (_warmAbort) return;
        const messages = msgResponse?.data?.docs || [];
        if (messages.length > 0) {
          // Yield to the UI before writing: upsertMessages takes a BEGIN
          // EXCLUSIVE lock that blocks reads, so if the user is opening a chat
          // we wait out the pause window first — keeping chat-open instant.
          await waitWhilePaused();
          if (_warmAbort) return;
          await ChatDatabase.upsertMessages(messages.map((m) => _normalizeMessage(m, chat, chatId)));
          // Brief gap so back-to-back warm writes can't monopolize the writer.
          await new Promise((r) => setTimeout(r, MSG_WARM_WRITE_GAP_MS));
        }
      } catch (err) {
        console.warn('[Sync] bg messages fetch failed for', chatId, err?.message);
      }
    }
  };
  // Detach: failures here must never bubble into navigation.
  Promise.all(Array.from({ length: MSG_WARM_CONCURRENCY }, worker))
    .then(() => { if (!_warmAbort) console.log('[Sync] background message warm complete'); })
    .catch(() => {});
};

// Restore that GATES entry to the app on the chatlist only. The chat list renders
// entirely from the chatlist payload (names, avatars, last-message previews), so
// once it's persisted we mark sync complete and let the user in — per-chat message
// history is warmed in the background (and lazily on chat open). This is what
// turns the old 1–2 min "Syncing messages…" wait into a couple of seconds.
// Module-level so it's decoupled from the screen instance.
const _performInitialRestore = async (userId, onProgress) => {
  // Don't attempt an authenticated restore without a token (session not fully
  // saved yet / mid-reset) — it would 401 with "No token provided".
  const token = await AsyncStorage.getItem('accessToken');
  if (!token) {
    console.warn('[Sync] no access token yet — skipping restore');
    return false;
  }

  // ── Step 1: Fetch chatlist (the ONLY thing gating entry to the app) ──
  onProgress(15, 'Fetching chats...');
  let chatList = [];
  try {
    const response = await chatServices.chatListData('');
    chatList = response?.data?.docs || [];
  } catch (err) {
    console.warn('[Sync] chatlist fetch failed:', err?.message);
  }

  if (chatList.length === 0) {
    // Nothing to restore (brand-new account or no history) — mark done so we
    // never route through this screen again for this user.
    await ChatDatabase.setSyncMeta('INITIAL_SYNC_COMPLETE', userId);
    return true;
  }

  // ── Step 2: Persist chatlist to SQLite (renders the whole chat list) ──
  onProgress(60, `Syncing ${chatList.length} chats...`);

  const normalizedChats = chatList.map((chat) => {
    const isGroup = chat.chatType === 'group';
    return {
      ...chat,
      isArchived: Boolean(chat.archived),
      ...((!isGroup && !chat.peerUser && chat.peerUserId) ? {
        peerUser: {
          _id: chat.peerUserId,
          fullName: chat.chatName || '',
          profileImage: chat.chatAvatar || null,
        },
      } : {}),
      ...((isGroup && !chat.group) ? {
        isGroup: true,
        groupId: chat.groupId || chat.chatId,
        group: {
          _id: chat.groupId || chat.chatId,
          name: chat.chatName || '',
          avatar: chat.chatAvatar || null,
        },
        groupName: chat.chatName || '',
        groupAvatar: chat.chatAvatar || null,
        memberCount: chat.groupMembersCount || 0,
      } : {}),
    };
  });

  await ChatDatabase.upsertChats(normalizedChats);
  ChatCache.setChats(normalizedChats);

  // Tag the freshly-populated cache with its owner so a later session reset can
  // tell a same-account re-login (keep) from a different user (wipe).
  await ChatDatabase.setDBOwner(userId);

  // ── Step 3: Mark complete + let the user in NOW. Message history is warmed
  // in the background (not awaited) and lazily on chat open. ──
  await ChatDatabase.setSyncMeta('INITIAL_SYNC_COMPLETE', userId);
  onProgress(100, 'Ready!');
  _warmRecentMessages(normalizedChats);
  return true;
};

export default function SyncScreen({ navigation, route }) {
  const { theme, isDarkMode } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const [statusText, setStatusText] = useState('Connecting...');
  const [progressPercent, setProgressPercent] = useState(0);
  const mountedRef = useRef(true);

  const isNewUser = route?.params?.isNewUser || false;
  const navigateTarget = route?.params?.navigateTarget || 'ChatList';
  const navigateParams = route?.params?.navigateParams || {};

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start();

    return () => { mountedRef.current = false; };
  }, []);

  const updateProgress = useCallback((percent, text) => {
    if (!mountedRef.current) return;
    setProgressPercent(percent);
    setStatusText(text);
    Animated.timing(progressAnim, {
      toValue: percent / 100,
      duration: 200,
      useNativeDriver: false,
    }).start();
  }, [progressAnim]);

  const runInitialSync = useCallback(async () => {
    try {
      // On web, skip SQLite-dependent sync and go directly to chat
      if (require('react-native').Platform.OS === 'web') {
        updateProgress(100, 'Ready!');
        setTimeout(navigateAway, 300);
        return;
      }

      // Get current user ID
      let userId = null;
      try {
        const rawUser = await AsyncStorage.getItem('userInfo');
        const user = rawUser ? JSON.parse(rawUser) : null;
        userId = user?._id || user?.id;
      } catch {}
      if (!userId) {
        navigateAway();
        return;
      }

      // Already restored this session — skip straight through (cheapest guard).
      if (_initialSyncDoneFor === userId) {
        navigateAway();
        return;
      }

      // Persisted cross-launch guard: restored on a previous launch?
      try {
        if (await ChatDatabase.isInitialSyncDone(userId)) {
          _initialSyncDoneFor = userId;
          navigateAway();
          return;
        }
      } catch {
        // DB not ready — fall through and (de-duped) attempt the restore.
      }

      // Dedupe concurrent runs: if a restore is already in flight (e.g. another
      // SyncScreen mount), ride on the SAME promise instead of starting a second
      // parallel restore. Only the first caller creates it.
      if (!_initialSyncPromise) {
        _initialSyncPromise = _performInitialRestore(userId, updateProgress)
          // Only remember "restored this session" when it actually completed; a
          // no-token bail returns false so it retries on the next mount/launch.
          .then((done) => { if (done) _initialSyncDoneFor = userId; })
          .finally(() => { _initialSyncPromise = null; });
      }
      await _initialSyncPromise;

      updateProgress(100, 'Ready!');
      setTimeout(navigateAway, 400);

    } catch (error) {
      console.error('[SyncScreen] sync error:', error);
      // Even if sync fails, let the user proceed
      updateProgress(100, 'Ready!');
      setTimeout(navigateAway, 300);
    }
  }, [updateProgress]);

  const navigateAway = useCallback(() => {
    if (!mountedRef.current) return;
    navigation.reset({
      index: 0,
      routes: [{ name: navigateTarget, params: navigateParams }],
    });
  }, [navigation, navigateTarget, navigateParams]);

  useEffect(() => {
    runInitialSync();
  }, []);

  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, SCREEN_WIDTH - 80],
  });

  const name = APP_TAG_NAME || 'TalksTry';

  return (
    <Animated.View style={[styles.container, { backgroundColor: theme.colors.background, opacity: fadeAnim }]}>
      {/* Top spacer keeps the brand block optically centered above the footer */}
      <View style={styles.flex} />

      {/* ── Brand block (logo + name) — WhatsApp-style centered identity ── */}
      <View style={styles.brand}>
        <Image source={BRAND_LOGO} resizeMode="contain" style={styles.logo} />
        <Text style={[styles.appName, { color: theme.colors.themeColor }]}>
          <Text style={{ fontFamily: 'Roboto-SemiBold' }}>{name.slice(0, 4)}</Text>
          <Text style={{ fontFamily: 'Roboto-Regular' }}>{name.slice(4)}</Text>
        </Text>
      </View>

      {/* ── Progress block ── */}
      <View style={styles.center}>
        <ActivityIndicator size="small" color={theme.colors.themeColor} style={{ marginBottom: 20 }} />

        {/* Progress bar */}
        <View style={[styles.progressTrack, { backgroundColor: isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }]}>
          <Animated.View style={[styles.progressFill, { width: progressWidth, backgroundColor: theme.colors.themeColor }]} />
        </View>

        {/* Status text */}
        <Text style={[styles.statusText, { color: theme.colors.placeHolderTextColor }]}>
          {statusText}
        </Text>

        {progressPercent > 0 && progressPercent < 100 && (
          <Text style={[styles.percentText, { color: theme.colors.themeColor }]}>
            {progressPercent}%
          </Text>
        )}
      </View>

      <View style={styles.flex} />

      {/* ── Footer ── */}
      <View style={styles.footer}>
        <Text style={[styles.footerText, { color: theme.colors.placeHolderTextColor }]}>
          Setting up your chats
        </Text>
        <Text style={[styles.footerSub, { color: theme.colors.placeHolderTextColor }]}>
          This may take a moment
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 56,
  },
  flex: {
    flex: 1,
  },
  brand: {
    alignItems: 'center',
  },
  logo: {
    width: 88,
    height: 88,
    marginBottom: 18,
  },
  appName: {
    fontSize: 26,
    letterSpacing: 0.3,
  },
  center: {
    alignItems: 'center',
    width: '100%',
    paddingHorizontal: 40,
    marginTop: 56,
  },
  progressTrack: {
    width: '100%',
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  statusText: {
    marginTop: 16,
    fontSize: 14,
    fontFamily: 'Roboto-Regular',
    textAlign: 'center',
  },
  percentText: {
    marginTop: 6,
    fontSize: 13,
    fontFamily: 'Roboto-Medium',
  },
  footer: {
    alignItems: 'center',
  },
  footerText: {
    fontSize: 13,
    fontFamily: 'Roboto-Regular',
  },
  footerSub: {
    fontSize: 12,
    fontFamily: 'Roboto-Regular',
    marginTop: 4,
  },
});