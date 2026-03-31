import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  Animated,
  StyleSheet,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { APP_TAG_NAME } from '@env';
import ChatDatabase from '../services/ChatDatabase';
import ChatCache from '../services/ChatCache';
import { chatServices } from '../Redux/Services/Chat/Chat.Services';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

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

      // Check if initial sync already done for this user
      try {
        const alreadySynced = await ChatDatabase.isInitialSyncDone(userId);
        if (alreadySynced) {
          navigateAway();
          return;
        }
      } catch {
        // DB not ready — proceed with sync anyway
      }

      // ── Step 1: Fetch chatlist from API ──
      updateProgress(10, 'Fetching chats...');
      let chatList = [];
      try {
        const response = await chatServices.chatListData('');
        chatList = response?.data?.docs || [];
      } catch (err) {
        console.warn('[Sync] chatlist fetch failed:', err?.message);
      }

      if (!mountedRef.current) return;

      if (chatList.length === 0) {
        // No chats — mark sync done and proceed
        await ChatDatabase.setSyncMeta('INITIAL_SYNC_COMPLETE', userId);
        updateProgress(100, 'Ready!');
        setTimeout(navigateAway, 300);
        return;
      }

      // ── Step 2: Save chatlist to SQLite ──
      updateProgress(20, `Syncing ${chatList.length} chats...`);

      // Normalize flat API format before saving
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

      if (!mountedRef.current) return;

      // ── Step 3: Fetch latest 50 messages for each chat ──
      const totalChats = normalizedChats.length;
      let synced = 0;

      // Process chats in batches of 3 for speed without overwhelming the server
      const BATCH_SIZE = 3;
      for (let i = 0; i < totalChats; i += BATCH_SIZE) {
        if (!mountedRef.current) return;

        const batch = normalizedChats.slice(i, i + BATCH_SIZE);
        const promises = batch.map(async (chat) => {
          const chatId = chat.chatId || chat._id;
          if (!chatId) return;

          try {
            const msgResponse = await chatServices.chatMessageList({
              chatId,
              page: 1,
              limit: 50,
            });
            const messages = msgResponse?.data?.docs || [];
            if (messages.length > 0) {
              // Normalize messages for SQLite
              const normalizedMsgs = messages.map((msg) => ({
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
              }));
              await ChatDatabase.upsertMessages(normalizedMsgs);
            }
          } catch (err) {
            // Skip failed chats — non-blocking
            console.warn('[Sync] messages fetch failed for', chatId, err?.message);
          }
        });

        await Promise.all(promises);
        synced += batch.length;

        if (!mountedRef.current) return;
        const percent = 30 + Math.round((synced / totalChats) * 65);
        updateProgress(percent, `Syncing messages... ${synced}/${totalChats}`);
      }

      // ── Step 4: Mark sync complete ──
      await ChatDatabase.setSyncMeta('INITIAL_SYNC_COMPLETE', userId);
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

  const name = APP_TAG_NAME || 'VibeConnect';

  return (
    <Animated.View style={[styles.container, { backgroundColor: theme.colors.background, opacity: fadeAnim }]}>
      {/* App name */}
      <View style={styles.header}>
        <Text style={[styles.appName, { color: theme.colors.themeColor }]}>
          <Text style={{ fontFamily: 'Roboto-SemiBold' }}>{name.slice(0, 4)}</Text>
          <Text style={{ fontFamily: 'Roboto-Regular' }}>{name.slice(4)}</Text>
        </Text>
      </View>

      {/* Center content */}
      <View style={styles.center}>
        <ActivityIndicator size="large" color={theme.colors.themeColor} style={{ marginBottom: 24 }} />

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

      {/* Footer */}
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
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 60,
  },
  header: {
    alignItems: 'center',
    paddingTop: 20,
  },
  appName: {
    fontSize: 24,
  },
  center: {
    alignItems: 'center',
    width: '100%',
    paddingHorizontal: 40,
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