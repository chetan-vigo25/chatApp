import React, { memo, useRef, useCallback } from 'react';
import { Animated, Image, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import { Swipeable } from 'react-native-gesture-handler';

const ChatCard = ({
  item,
  theme,
  onPress,
  onLongPress,
  onAvatarPress,
  onSwipePin,
  onSwipeMute,
  onSwipeArchive,
  getUserColor,
  getPreviewText,
  getRelativeTime,
  getLastMessageText,
  renderMessageStatus,
}) => {
  const scale = useRef(new Animated.Value(1)).current;
  const swipeableRef = useRef(null);

  const animateTo = (value) => {
    Animated.spring(scale, {
      toValue: value,
      useNativeDriver: true,
      friction: 9,
      tension: 80,
    }).start();
  };

  const closeSwipeable = useCallback(() => {
    swipeableRef.current?.close();
  }, []);

  const handleSwipePin = useCallback(() => {
    closeSwipeable();
    if (onSwipePin) onSwipePin();
  }, [onSwipePin, closeSwipeable]);

  const handleSwipeMute = useCallback(() => {
    closeSwipeable();
    if (onSwipeMute) onSwipeMute();
  }, [onSwipeMute, closeSwipeable]);

  const handleSwipeArchive = useCallback(() => {
    closeSwipeable();
    if (onSwipeArchive) onSwipeArchive();
  }, [onSwipeArchive, closeSwipeable]);

  const isArchived = Boolean(item?.isArchived);
  const hasUnread = Number(item?.unreadCount || 0) > 0;
  const isTyping = item?.realtime?.typing?.isTyping;
  const peerName = item?.peerUser?.fullName || 'Unknown';

  const renderLeftActions = (progress) => {
    const translateX = progress.interpolate({
      inputRange: [0, 1],
      outputRange: [-76, 0],
      extrapolate: 'clamp',
    });
    return (
      <Animated.View style={[styles.leftActionWrap, { transform: [{ translateX }] }]}>
        <TouchableOpacity onPress={handleSwipePin} activeOpacity={0.8} style={styles.swipePinBtn}>
          <MaterialCommunityIcons name={item?.isPinned ? 'pin-off-outline' : 'pin-outline'} size={20} color="#fff" />
          <Text style={styles.swipeBtnText}>{item?.isPinned ? 'Unpin' : 'Pin'}</Text>
        </TouchableOpacity>
      </Animated.View>
    );
  };

  const renderRightActions = (progress) => {
    const translateX = progress.interpolate({
      inputRange: [0, 1],
      outputRange: [152, 0],
      extrapolate: 'clamp',
    });
    return (
      <Animated.View style={[styles.rightActionWrap, { transform: [{ translateX }] }]}>
        <TouchableOpacity onPress={handleSwipeMute} activeOpacity={0.8} style={styles.swipeMuteBtn}>
          <MaterialCommunityIcons name={item?.isMuted ? 'volume-high' : 'volume-off'} size={20} color="#fff" />
          <Text style={styles.swipeBtnText}>{item?.isMuted ? 'Unmute' : 'Mute'}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleSwipeArchive} activeOpacity={0.8} style={[styles.swipeArchiveBtn, isArchived && { backgroundColor: '#00B894' }]}>
          <MaterialCommunityIcons name={isArchived ? 'archive-arrow-up-outline' : 'archive-arrow-down-outline'} size={20} color="#fff" />
          <Text style={styles.swipeBtnText}>{isArchived ? 'Unarchive' : 'Archive'}</Text>
        </TouchableOpacity>
      </Animated.View>
    );
  };

  return (
    <Swipeable
      ref={swipeableRef}
      overshootLeft={false}
      overshootRight={false}
      friction={2}
      renderLeftActions={renderLeftActions}
      renderRightActions={renderRightActions}
    >
      <Animated.View style={[styles.cardOuter, { backgroundColor: theme.colors.background, transform: [{ scale }] }]}>
        <TouchableOpacity
          onPress={onPress}
          onLongPress={onLongPress}
          delayLongPress={260}
          onPressIn={() => animateTo(0.98)}
          onPressOut={() => animateTo(1)}
          activeOpacity={1}
          style={styles.card}
        >
          {/* Avatar */}
          <TouchableOpacity
            onPress={onAvatarPress || onPress}
            activeOpacity={0.85}
            style={styles.avatarTouch}
          >
            {item?.peerUser?.profileImage ? (
              <Image
                resizeMode="cover"
                source={{ uri: item.peerUser.profileImage }}
                style={styles.avatarImage}
              />
            ) : (
              <View
                style={[
                  styles.avatarFallback,
                  { backgroundColor: getUserColor(item?.peerUser?._id || peerName) },
                ]}
              >
                <Text style={styles.avatarInitial}>
                  {peerName.charAt(0).toUpperCase()}
                </Text>
              </View>
            )}
            {/* Online indicator */}
            {item?.peerUser?.isOnline && (
              <View style={[styles.onlineDot, { borderColor: theme.colors.background }]} />
            )}
          </TouchableOpacity>

          {/* Content */}
          <View style={styles.contentWrap}>
            {/* Row 1: Name + Time */}
            <View style={styles.topRow}>
              <Text
                numberOfLines={1}
                style={[styles.nameText, { color: theme.colors.primaryTextColor }]}
              >
                {peerName}
              </Text>
              <Text style={[
                styles.timeText,
                { color: hasUnread ? theme.colors.themeColor : theme.colors.placeHolderTextColor }
              ]}>
                {getRelativeTime(item?.lastMessageAt || item?.timestamp)}
              </Text>
            </View>

            {/* Row 2: Preview + Meta */}
            <View style={styles.bottomRow}>
              <View style={styles.previewWrap}>
                {!isTyping && renderMessageStatus(item)}
                <Text
                  numberOfLines={1}
                  style={[
                    styles.previewText,
                    {
                      color: isTyping ? theme.colors.themeColor : theme.colors.placeHolderTextColor,
                      fontStyle: isTyping ? 'italic' : 'normal',
                      fontFamily: hasUnread ? 'Poppins-Medium' : 'Poppins-Regular',
                    },
                  ]}
                >
                  {isTyping ? 'Typing...' : getPreviewText(getLastMessageText(item), 38)}
                </Text>
              </View>

              <View style={styles.metaWrap}>
                {item?.isPinned && (
                  <MaterialCommunityIcons name="pin" size={13} color={theme.colors.placeHolderTextColor} style={{ marginRight: 4 }} />
                )}
                {item?.isMuted && (
                  <Ionicons name="volume-mute" size={13} color={theme.colors.placeHolderTextColor} style={{ marginRight: hasUnread ? 4 : 0 }} />
                )}
                {hasUnread && (
                  <View style={[styles.unreadBadge, { backgroundColor: theme.colors.themeColor }]}>
                    <Text style={styles.unreadText}>
                      {Number(item.unreadCount) > 99 ? '99+' : Number(item.unreadCount)}
                    </Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        </TouchableOpacity>
      </Animated.View>
    </Swipeable>
  );
};

const styles = StyleSheet.create({
  cardOuter: {},
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },

  // Avatar
  avatarTouch: {
    width: 52,
    height: 52,
    borderRadius: 26,
  },
  avatarImage: {
    width: 52,
    height: 52,
    borderRadius: 26,
  },
  avatarFallback: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 20,
    fontFamily: 'Poppins-SemiBold',
    color: '#fff',
  },
  onlineDot: {
    position: 'absolute',
    bottom: 1,
    right: 1,
    width: 13,
    height: 13,
    borderRadius: 7,
    backgroundColor: '#25D366',
    borderWidth: 2.5,
  },

  // Content
  contentWrap: {
    flex: 1,
    marginLeft: 14,
    justifyContent: 'center',
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 3,
  },
  nameText: {
    fontSize: 15.5,
    fontFamily: 'Poppins-SemiBold',
    textTransform: 'capitalize',
    flex: 1,
    marginRight: 10,
    letterSpacing: 0.1,
  },
  timeText: {
    fontSize: 11,
    fontFamily: 'Poppins-Regular',
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  previewWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 10,
  },
  previewText: {
    fontSize: 13,
    flexShrink: 1,
    lineHeight: 18,
  },
  metaWrap: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  unreadBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  unreadText: {
    fontSize: 10,
    fontFamily: 'Poppins-SemiBold',
    color: '#fff',
  },

  // Swipe actions
  leftActionWrap: {
    justifyContent: 'center',
    paddingRight: 2,
  },
  rightActionWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 2,
    gap: 2,
  },
  swipePinBtn: {
    width: 70,
    height: 64,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#4D7CFE',
  },
  swipeMuteBtn: {
    width: 70,
    height: 64,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F0A030',
  },
  swipeArchiveBtn: {
    width: 70,
    height: 64,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#556070',
  },
  swipeBtnText: {
    color: '#fff',
    fontSize: 10,
    fontFamily: 'Poppins-Medium',
    marginTop: 2,
  },
});

export default memo(ChatCard);