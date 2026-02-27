import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, Modal, Animated, Image, TextInput, RefreshControl, LayoutAnimation, Platform, UIManager } from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { Menu } from 'react-native-paper';
import { useDispatch, useSelector } from "react-redux";
import { chatListData } from "../../Redux/Reducer/Chat/Chat.reducer";
import { profileDetail } from "../../Redux/Reducer/Profile/Profile.reducer";
import { useFocusEffect } from '@react-navigation/native';
import { FontAwesome6, AntDesign, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRealtimeChat } from '../../contexts/RealtimeChatContext';

export default function ChatList({ navigation }) {
  const { theme } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const dispatch = useDispatch();
  const { chatsData, isLoading } = useSelector(state => state.chat);
  const { profileData } = useSelector(state => state.profile);
  const [visible, setVisible] = useState(false);
  const [menuKey, setMenuKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [, setTimeTick] = useState(0);

  const [modalVisible, setModalVisible] = useState(false);
  const [selectedChatItem, setSelectedChatItem] = useState(null);
  const { chatList: realtimeChatList, hydrateChats, state: realtimeState } = useRealtimeChat();

  const effectiveChatList = Array.isArray(realtimeChatList)
    ? realtimeChatList
    : (Array.isArray(chatsData) ? chatsData : []);

  useEffect(() => {
    if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
  }, []);

  const listOrderSignature = useMemo(
    () => (effectiveChatList || []).map((item) => item?.chatId || item?._id).filter(Boolean).join('|'),
    [effectiveChatList]
  );

  useEffect(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  }, [listOrderSignature]);

  useEffect(() => {
    const id = setInterval(() => {
      setTimeTick((prev) => prev + 1);
    }, 30000);

    return () => clearInterval(id);
  }, []);

  // Fade-in animation
  useEffect(() => {
    const timer = setTimeout(() => {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }).start();
    }, 400);
    return () => clearTimeout(timer);
  }, []);

  // Fetch chats on screen focus
  useFocusEffect(
    useCallback(() => {
      dispatch(chatListData(""));
    }, [dispatch])
  );

  // Pull-to-refresh
  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await dispatch(chatListData(""));
    } catch (err) {
      console.warn("Failed to refresh chats:", err);
    } finally {
      setRefreshing(false);
    }
  };

  const getPreviewText = (text, maxLength = 20) => {
    if (!text) return "";
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + " ";
  };

  const getRelativeTime = (value) => {
    const ts = value ? new Date(value).getTime() : 0;
    if (!ts) return '';

    const diffMs = Date.now() - ts;
    if (diffMs < 60000) return 'Just now';

    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 60) return `${diffMin}m`;

    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h`;

    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) {
      return new Date(ts).toLocaleDateString(undefined, { weekday: 'short' });
    }

    const date = new Date(ts);
    const day = `${date.getDate()}`.padStart(2, '0');
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const year = `${date.getFullYear()}`.slice(-2);
    return `${day}/${month}/${year}`;
  };

  const getPresenceDotColor = (status) => {
    const normalized = (status || '').toLowerCase();
    if (normalized === 'online') return '#2CC84D';
    if (normalized === 'away') return '#FFC107';
    if (normalized === 'busy') return '#F44336';
    return '#9E9E9E';
  };

  const getLastMessageText = (item) => item?.lastMessageDisplay?.fullText || item?.lastMessageDisplay?.text || 'No messages yet';

  const getLastMessageStatus = (item) => {
    return (
      item?.lastMessageStatus ||
      item?.lastMessage?.status ||
      item?.status ||
      null
    );
  };

  const renderMessageStatus = (item) => {
    const status = (getLastMessageStatus(item) || '').toLowerCase();
    if (!status) return null;

    if (status === 'read') {
      return (
        <View style={{ flexDirection: 'row', marginRight: 4 }}>
          <FontAwesome6 name="check" size={10} color="#34B7F1" style={{ marginRight: -2 }} />
          <FontAwesome6 name="check" size={10} color="#34B7F1" />
        </View>
      );
    }

    if (status === 'delivered') {
      return (
        <View style={{ flexDirection: 'row', marginRight: 4 }}>
          <FontAwesome6 name="check" size={10} color={theme.colors.placeHolderTextColor} style={{ marginRight: -2 }} />
          <FontAwesome6 name="check" size={10} color={theme.colors.placeHolderTextColor} />
        </View>
      );
    }

    if (status === 'sent') {
      return <FontAwesome6 name="check" size={10} color={theme.colors.placeHolderTextColor} style={{ marginRight: 4 }} />;
    }

    return null;
  };

  const pastelColors = ["#833AB4","#1DB954","#128C7E","#075E54","#777737","#F56040","#34B7F1","#25D366","#FF5A5F","#3A3A3A","#FF0000","#00A699"];
  const getUserColor = (str) => {
    if (!str) return pastelColors[0];
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return pastelColors[Math.abs(hash) % pastelColors.length];
  };

  const handleModal = (item) => {
    setSelectedChatItem(item);
    setModalVisible(true);
    if (item?.peerUser?._id) {
      dispatch(profileDetail(item.peerUser._id));
    }
  }

  useEffect(() => {
    if (Array.isArray(chatsData)) {
      hydrateChats(chatsData);
    }
  }, [chatsData, hydrateChats]);

  const closeModal = () => {
    setModalVisible(false);
    setSelectedChatItem(null);
  }

  const renderChatListItem = ({ item }) => (
    <TouchableOpacity
      onPress={() => handleModal(item)}
      activeOpacity={0.8}
      style={{
        width:'100%',
        flexDirection:'row',
        gap:10,
        alignItems:'center',
        marginBottom:15,
        backgroundColor: item?.realtime?.isHighlighted ? 'rgba(52,183,241,0.14)' : 'transparent',
        borderRadius: 10,
        paddingHorizontal: 6,
        paddingVertical: 4,
      }}
    >
      <View style={{ width:50, height:50, borderRadius:100, alignItems:'center', justifyContent:'center' }} >
        {item.peerUser?.profileImage ? (
          <View>
            <Image resizeMode="cover" source={{ uri: item.peerUser?.profileImage }} style={{ width:50, height:50, borderRadius:100 }} />
            {!!item?.realtime?.presence?.status && (
              <View style={{ position:'absolute', right:1, bottom:1, width:12, height:12, borderRadius:6, backgroundColor:getPresenceDotColor(item?.realtime?.presence?.status), borderWidth:1.5, borderColor:theme.colors.background }} />
            )}
          </View>
        ) : (
          <View>
            <View style={{ width:50, height:50, borderRadius:100, backgroundColor: getUserColor(item.peerUser?._id || item.peerUser?.fullName || ""), alignItems:'center', justifyContent:'center' }}>
              <Text style={{ color:theme.colors.textWhite, fontSize:20, textTransform:'uppercase', fontFamily:'Poppins-Bold' }}>{item.peerUser?.fullName?.charAt(0)}</Text>
            </View>
            {/* {!!item?.realtime?.presence?.status && (
              <View style={{ position:'absolute', right:1, bottom:1, width:12, height:12, borderRadius:6, backgroundColor:getPresenceDotColor(item?.realtime?.presence?.status), borderWidth:1.5, borderColor:theme.colors.background }} />
            )} */}
          </View>
        )}
      </View>
      <TouchableOpacity onPress={() => navigation.navigate('ChatScreen', { item })} style={{width:'80%', flexDirection:"row", justifyContent:"space-between", alignItems:"center"}} >
        <View>
          <View style={{ flexDirection:'row', alignItems:'center', gap:6 }}>
            <Text style={{ color:theme.colors.primaryTextColor, fontSize:16, textTransform:'capitalize', fontFamily:'Poppins-Medium' }}>{item.peerUser?.fullName}</Text>
            {item?.isPinned && <MaterialCommunityIcons name="pin" size={14} color={theme.colors.placeHolderTextColor} />}
            {item?.isMuted && <MaterialCommunityIcons name="volume-off" size={14} color={theme.colors.placeHolderTextColor} />}
          </View>
          <View style={{ flexDirection:'row', alignItems:'center' }}>
            {!item?.realtime?.typing?.isTyping && renderMessageStatus(item)}
            <Text style={{ color: item?.realtime?.typing?.isTyping ? theme.colors.themeColor : theme.colors.placeHolderTextColor, fontSize:12, fontStyle: item?.realtime?.typing?.isTyping ? 'italic' : 'normal' }}>
              {item?.realtime?.typing?.isTyping
                ? 'Typing...'
                : getPreviewText(getLastMessageText(item))}
            </Text>
          </View>
          {/* {!item?.realtime?.typing?.isTyping && item?.realtime?.presence?.status === 'offline' && !!item?.lastSeenDisplay && (
            <Text style={{ color: theme.colors.placeHolderTextColor, fontSize:10 }}>
              {item.lastSeenDisplay}
            </Text>
          )} */}
        </View>
        <View style={{ alignItems:'center', justifyContent:'space-between' }} >
          <Text style={{ color:theme.colors.placeHolderTextColor, fontSize:10 }}>
            {getRelativeTime(item?.lastMessageAt)}
          </Text>
          {Number(item.unreadCount || 0) > 0 && (
            <View style={{ width:20, height:20, backgroundColor:theme.colors.themeColor, alignItems:'center', justifyContent:'center', borderRadius:50, marginVertical:2 }} >
              <Text style={{ color:theme.colors.textWhite, fontSize:10 }}>{Number(item.unreadCount || 0)}</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    </TouchableOpacity>
  );

  return (
    <Animated.View style={{ flex:1, opacity:fadeAnim }}>
      <View style={{ flex:1, backgroundColor: theme.colors.background }}>
        {/* Header */}
        <View style={{ flexDirection:'row', padding:8, justifyContent:'space-between', alignItems:'center', borderBottomWidth:0.5, borderBottomColor:theme.colors.borderColor }} >
          <View style={{ flexDirection:'row', alignItems:'center', gap:8 }}>
            <Text style={{ fontSize:24, color:theme.colors.themeColor, fontFamily:'Poppins-SemiBold' }}>Chats</Text>
            {Number(realtimeState?.totalUnread || 0) > 0 && (
              <View style={{ minWidth:22, height:22, paddingHorizontal:6, borderRadius:11, backgroundColor:theme.colors.themeColor, alignItems:'center', justifyContent:'center' }}>
                <Text style={{ color:theme.colors.textWhite, fontSize:10 }}>
                  {Number(realtimeState.totalUnread) > 99 ? '99+' : Number(realtimeState.totalUnread)}
                </Text>
              </View>
            )}
          </View>
          <Menu key={menuKey} visible={visible} onDismiss={() => { setVisible(false); setMenuKey(prev=>prev+1) }} contentStyle={{ backgroundColor: theme.colors.cardBackground }} anchor={
            <TouchableOpacity onPress={() => setVisible(true)} style={{ width:40, height:40, alignItems:'center', justifyContent:'center' }} >
              <FontAwesome6 name="bars-staggered" size={18} color={ theme.colors.placeHolderTextColor } />
            </TouchableOpacity>
          }>
            <Menu.Item onPress={() => { navigation.navigate('Profile'); setVisible(false); setMenuKey(prev=>prev+1) }} title="Profile" titleStyle={{ color: theme.colors.primaryTextColor }} />
            <Menu.Item onPress={() => { navigation.navigate('Setting'); setVisible(false); setMenuKey(prev=>prev+1) }} title="Settings" titleStyle={{ color: theme.colors.primaryTextColor }} />
            <Menu.Item onPress={() => { navigation.navigate('LinkDevice'); setVisible(false); setMenuKey(prev=>prev+1) }} title="Linked Devices" titleStyle={{ color: theme.colors.primaryTextColor }} />
            <Menu.Item onPress={() => { setVisible(false); setMenuKey(prev=>prev+1) }} title="Help" titleStyle={{ color: theme.colors.primaryTextColor }} />
          </Menu>
        </View>

        {/* Search & Chat List */}
        <View style={{ flex:1, alignItems:'center', padding:10 }}>
          {/* <TextInput placeholder="Search" placeholderTextColor={theme.colors.placeHolderTextColor} style={{ backgroundColor:theme.colors.menuBackground, borderRadius:50, width:'100%', padding:14, fontSize:12, marginBottom:10 }} /> */}
          {isLoading ? (
            <ActivityIndicator size="large" color={theme.colors.themeColor} />
          ) : (
            <FlatList
              data={effectiveChatList}
              keyExtractor={(item) => String(item?.chatId || item?._id)}
              renderItem={renderChatListItem}
              showsVerticalScrollIndicator={false}
              refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} colors={[theme.colors.themeColor]} />
              }
              ListEmptyComponent={() => (
                <View style={{ flex:1, justifyContent:'center', alignItems:'center', padding:20 }} />
              )}
            />
          )}
        </View>

        {/* Add User Button */}
        <TouchableOpacity onPress={() => navigation.navigate('AddUser')} style={{ width:60, height:60, backgroundColor: theme.colors.themeColor, position:'absolute', bottom:20, right:20, borderRadius:15, alignItems:'center', justifyContent:'center' }} >
          <AntDesign name="user-add" size={20} color={theme.colors.textWhite} />
        </TouchableOpacity>

        {/* Modal */}
        <Modal animationType="slide" transparent visible={modalVisible} onRequestClose={closeModal}>
          <TouchableOpacity onPress={closeModal} activeOpacity={1} style={{ flex:1, justifyContent:'center', alignItems:'center', backgroundColor:'transparent', padding:20 }} >
            <View style={{ width:'60%', backgroundColor:theme.colors.cardBackground }} >
              <View style={{ width:'100%', height:250 }} >
                {profileData?.profileImage ? (
                  <Image resizeMode="cover" source={{ uri: profileData?.profileImage }} style={{ width:'100%', height:'100%' }} />
                ) : (
                  <View style={{ flex:1, alignItems:'center', justifyContent:'center', backgroundColor: getUserColor(selectedChatItem?.peerUser?._id || selectedChatItem?.peerUser?.fullName || "") }}>
                    <Text style={{ color:theme.colors.textWhite, fontSize:150, textTransform:'uppercase' }}>{(profileData?.fullName || selectedChatItem?.peerUser?.fullName || "").charAt(0)}</Text>
                  </View>
                )}
              </View>
            </View>
          </TouchableOpacity>
        </Modal>

      </View>
    </Animated.View>
  );
}