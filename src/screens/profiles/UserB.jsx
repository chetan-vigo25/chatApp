import React, { useState, useEffect, useRef } from "react";
import { View, Text, Image, Animated, TouchableOpacity, ScrollView, ActivityIndicator } from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { useDispatch, useSelector } from "react-redux";
import { profileDetail } from "../../Redux/Reducer/Profile/Profile.reducer";
import { AntDesign, FontAwesome5, MaterialIcons } from '@expo/vector-icons';

export default function UserB({ navigation, route }) {
  const { item: routeItem } = route.params || {};
  const { theme } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const dispatch = useDispatch();
  const { profileData, isLoading } = useSelector(state => state.profile);

  // Normalize peer object whether coming from chatList (item.peerUser) or AddUser (item)
  const peer = routeItem?.peerUser ? routeItem.peerUser : (routeItem || {});
  const peerId = peer?._id || peer?.userId || peer?.id || null;

  useEffect(() => {
    if (peerId) {
      dispatch(profileDetail(peerId));
    }
  }, [peerId, dispatch]);

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

  const pastelColors = ["#FF5C5C", "#8AFF8A", "#FFC0CB", "#ADADAD", "#BAE1FF"];
  function getUserColor(str) {
    if (!str) return pastelColors[0];
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % pastelColors.length;
    return pastelColors[index];
  }

  // Display name preference: redux profileData first, then peer fields
  const displayName = (profileData?.fullName) || peer?.fullName || peer?.name || peer?.username || "";
  const initial = (displayName && displayName.length > 0) ? displayName.charAt(0).toUpperCase() : '?';

  // Determine image source: prefer redux profileData, then peer.profileImage / peer.profilePicture
  const reduxImage = profileData?.profileImage;
  const peerImage = peer?.profileImage || peer?.profilePicture || peer?.profilePictureUri;
  const imageSource = reduxImage
    ? (typeof reduxImage === 'string' ? { uri: reduxImage } : reduxImage)
    : (peerImage ? { uri: peerImage } : null);

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: theme.colors.background }}>
        <ActivityIndicator size="large" color={theme.colors.themeColor} />
      </View>
    );
  }

  return (
    <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <View style={{ width:'100%', flexDirection:'row', justifyContent:"space-between", borderBottomWidth:.5, borderBottomColor:theme.colors.borderColor, padding:10 }}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={{ width:30, height:30, justifyContent:'center', alignItems:'flex-end' }}>
            <FontAwesome5 name="arrow-left" size={20} color={ theme.colors.primaryTextColor } />
          </TouchableOpacity>
        </View>

        <ScrollView style={{ flex:1, padding:20 }}>
          <View style={{ width:180, height:180, borderRadius:100, alignSelf:'center', overflow:'hidden' }}>
            { imageSource ? (
              <Image
                resizeMode="cover"
                source={{ uri: profileData.profileImage }}
                style={{ width: '100%', height: '100%', borderRadius: 100 }}
              />
            ) : (
              <View style={{ flex:1, alignItems:'center', justifyContent:'center', backgroundColor: getUserColor(peer?._id || peer?.fullName || ""), borderRadius:100 }}>
                <Text style={{ color:theme.colors.textWhite, fontFamily:'Poppins-Medium', fontSize:100, textTransform:'uppercase' }}>{initial}</Text>
              </View>
            )}
          </View>

          <View>
            <View style={{ width:'100%', marginBottom:20 }}>
              <View style={{ width:'100%', height:40, flexDirection:'row', gap:10, alignItems:'center', justifyContent:'space-between', borderBottomWidth:.4, borderBottomColor:theme.colors.borderColor, marginBottom:10 }}>
                <View style={{ width:30, height:30, justifyContent:"center", alignItems:'center', borderRadius:50 }}>
                 <AntDesign name="exclamation-circle" size={20} color={theme.colors.placeHolderTextColor} />
                </View>
                <View style={{ flex:1 }}>
                  <Text style={{ fontFamily:'Poppins-Medium', fontSize:14, color:theme.colors.primaryTextColor }}>About</Text>
                  <Text style={{ fontFamily:'Poppins-Medium', fontSize:12, color:theme.colors.placeHolderTextColor }}>
                    { profileData?.about ?? peer?.about ?? '' }
                  </Text>
                </View>
              </View>
            </View>

            <View style={{ width:'100%', marginBottom:20 }}>
              <View style={{ width:'100%', height:40, flexDirection:'row', gap:10, alignItems:'center', justifyContent:'space-between', borderBottomWidth:.4, borderBottomColor:theme.colors.borderColor, marginBottom:10 }}>
                <View style={{ width:30, height:30, justifyContent:"center", alignItems:'center', borderRadius:50 }}>
                 <FontAwesome5 name="user" size={20} color={theme.colors.placeHolderTextColor} />
                </View>
                <View style={{ flex:1 }}>
                  <Text style={{ fontFamily:'Poppins-Medium', fontSize:14, color:theme.colors.primaryTextColor }}>Name</Text>
                  <Text style={{ fontFamily:'Poppins-Medium', fontSize:12, color:theme.colors.placeHolderTextColor }}>{ displayName }</Text>
                </View>
              </View>
            </View>

            <View style={{ width:'100%', marginBottom:20 }}>
              <View style={{ width:'100%', height:40, flexDirection:'row', gap:10, alignItems:'center', justifyContent:'space-between', borderBottomWidth:.4, borderBottomColor:theme.colors.borderColor, marginBottom:10 }}>
                <View style={{ width:30, height:30, justifyContent:"center", alignItems:'center', borderRadius:50 }}>
                 <MaterialIcons name="email" size={20} color={theme.colors.placeHolderTextColor} />
                </View>
                <View style={{ flex:1 }}>
                  <Text style={{ fontFamily:'Poppins-Medium', fontSize:14, color:theme.colors.primaryTextColor }}>Email</Text>
                  <Text style={{ fontFamily:'Poppins-Medium', fontSize:12, color:theme.colors.placeHolderTextColor }}>
                    { profileData?.email ?? peer?.email ?? '' }
                  </Text>
                </View>
              </View>
            </View>
          </View>
        </ScrollView>
      </View>
    </Animated.View>
  );
}