import React, { useState, useEffect, useRef, useCallback } from "react";
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, Modal, Animated, Image, TextInput, RefreshControl } from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { Menu } from 'react-native-paper';
import { useDispatch, useSelector } from "react-redux";
import { chatListData } from "../../Redux/Reducer/Chat/Chat.reducer";
import { profileDetail } from "../../Redux/Reducer/Profile/Profile.reducer";
import moment from "moment";
import { useFocusEffect } from '@react-navigation/native';
import { FontAwesome6, AntDesign, MaterialCommunityIcons } from '@expo/vector-icons';

export default function ChatList({ navigation }) {
  const { theme } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const dispatch = useDispatch();
  const { chatsData, isLoading } = useSelector(state => state.chat);
  const { profileData } = useSelector(state => state.profile);
  const [visible, setVisible] = useState(false);
  const [menuKey, setMenuKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const [modalVisible, setModalVisible] = useState(false);
  const [selectedChatItem, setSelectedChatItem] = useState(null);

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

  const closeModal = () => {
    setModalVisible(false);
    setSelectedChatItem(null);
  }

  const renderChatListItem = ({ item }) => (
    <TouchableOpacity onPress={() => handleModal(item)} activeOpacity={0.8} style={{ width:'100%', flexDirection:'row', gap:10, alignItems:'center', marginBottom:15 }} >
      <View style={{ width:50, height:50, borderRadius:100, alignItems:'center', justifyContent:'center' }} >
        {item.peerUser?.profileImage ? (
          <Image resizeMode="cover" source={{ uri: item.peerUser?.profileImage }} style={{ width:'100%', height:'100%', borderRadius:100 }} />
        ) : (
          <View style={{ width:50, height:50, borderRadius:100, backgroundColor: getUserColor(item.peerUser?._id || item.peerUser?.fullName || ""), alignItems:'center', justifyContent:'center' }}>
            <Text style={{ color:theme.colors.textWhite, fontSize:28, textTransform:'uppercase', fontFamily:'Poppins-Medium' }}>{item.peerUser?.fullName?.charAt(0)}</Text>
          </View>
        )}
      </View>
      <TouchableOpacity onPress={() => navigation.navigate('ChatScreen', { item })} style={{width:'85%', flexDirection:"row", justifyContent:"space-between", alignItems:"center"}} >
        <View>
          <Text style={{ color:theme.colors.primaryTextColor, fontSize:16, fontFamily:'Poppins-Medium', textTransform:'capitalize' }}>{item.peerUser?.fullName}</Text>
          <Text style={{ color:theme.colors.placeHolderTextColor, fontSize:12, fontFamily:'Poppins-Regular' }}>{getPreviewText(item?.lastMessage?.text)}</Text>
        </View>
        <View style={{ alignItems:'center', justifyContent:'space-between' }} >
          <Text style={{ color:theme.colors.placeHolderTextColor, fontSize:10 }}>{moment(item.lastMessageAt).format('hh:mm A')}</Text>
          {item.unreadCount > 0 && (
            <View style={{ width:20, height:20, backgroundColor:theme.colors.themeColor, alignItems:'center', justifyContent:'center', borderRadius:50, marginVertical:2 }} >
              <Text style={{ color:theme.colors.textWhite, fontSize:10 }}>{item.unreadCount}</Text>
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
          <Text style={{ fontSize:24, color:theme.colors.themeColor, fontFamily:'Poppins-SemiBold' }}>Chats</Text>
          <Menu key={menuKey} visible={visible} onDismiss={() => { setVisible(false); setMenuKey(prev=>prev+1) }} contentStyle={{ backgroundColor: theme.colors.cardBackground }} anchor={
            <TouchableOpacity onPress={() => setVisible(true)} style={{ width:30, height:30, alignItems:'center', justifyContent:'center' }} >
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
          <TextInput placeholder="Search" placeholderTextColor={theme.colors.placeHolderTextColor} style={{ backgroundColor:theme.colors.menuBackground, borderRadius:50, width:'100%', padding:14, fontSize:12, marginBottom:10 }} />
          {isLoading ? (
            <ActivityIndicator size="large" color={theme.colors.themeColor} />
          ) : (
            <FlatList
              data={chatsData}
              keyExtractor={(item) => item._id}
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
              <View style={{ flexDirection:'row', width:'100%', backgroundColor:'rgba(0, 0, 0, 0.5)', alignItems:'flex-start', justifyContent:'center', position:'absolute', bottom:0,}} >
                <TouchableOpacity onPress={() => {navigation.navigate('ChatScreen', {item: selectedChatItem}); closeModal();}} activeOpacity={0.9} style={{ flex:1, alignItems:'center', justifyContent:'center', padding:5 }} >
                  <MaterialCommunityIcons name="message-reply-text-outline" size={24} color={theme.colors.textWhite} />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => {navigation.navigate('UserB', {item: selectedChatItem}); closeModal();}} activeOpacity={0.9} style={{ flex:1, alignItems:'center', justifyContent:'center', padding:5 }} >
                  <AntDesign name="exclamation-circle" size={24} color={theme.colors.textWhite} />
                </TouchableOpacity>
              </View>
            </View>
          </TouchableOpacity>
        </Modal>

      </View>
    </Animated.View>
  );
}