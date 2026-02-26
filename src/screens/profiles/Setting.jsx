import React, { useState, useEffect, useRef } from "react";
import { View, Text, Image, Animated, TouchableOpacity, ScrollView, Alert, Button, Pressable } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView } from "react-native-safe-area-context";
import { Switch } from 'react-native-paper';
import { useTheme } from "../../contexts/ThemeContext";
import { useDispatch, useSelector } from "react-redux";
import { profileDetail } from "../../Redux/Reducer/Profile/Profile.reducer";
import { logout } from "../../Redux/Reducer/Auth/Auth.reducer";
import { getSocket } from "../../Redux/Services/Socket/socket";


import { Entypo, AntDesign, Ionicons, FontAwesome6, MaterialCommunityIcons } from '@expo/vector-icons';

export default function Setting ({ navigation }) {
    const { theme, toggleTheme, isDarkMode, hasManualTheme, setTheme, resetThemeToSystem } = useTheme()
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const dispatch = useDispatch();
    const { profileData, isLoading, error } = useSelector(state => state.profile);
 
    useEffect(() => {
      dispatch(profileDetail()); // fetch profile data
      const timer = setTimeout(() => {
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }).start();
      }, 400);
      return () => clearTimeout(timer);
    }, []);

    function getInitials(name) {
      if (!name) return "";
      const parts = name.trim().split(" ");
      return parts.map((p) => p.charAt(0).toUpperCase()).join("");
    }

    const handleLogout = async () => {
      try {
        const socket = getSocket(); // Get the socket instance
        if (socket) {
          socket.emit('logout:all', { force: true });
          console.log("🔐 Emitting logout:all to the server");
          await AsyncStorage.removeItem('accessToken');
          // await resetChatColor();
          console.log("User session cleared.");
          socket.disconnect();
          console.log("Socket disconnected.");
          navigation.reset({
            index: 0,
            routes: [{ name: "Login" }],
          });
        }
        // Dispatch logout action to update Redux state
        dispatch(logout());
        navigation.reset({
          index: 0,
          routes: [{ name: "Login" }],
        });
        // Optionally, show a confirmation alert
        console.log("Logged out", "You have been logged out from all devices.");
      } catch (error) {
        console.error("Error logging out:", error);
        // Optionally handle error (e.g., show an alert)
        Alert.alert("Error", "An error occurred while logging out. Please try again.");
      }
    };

    // console.log("profileData",profileData);

    return(
        <Animated.View style={{ flex: 1, }}>
            <View style={{ flex: 1, backgroundColor: theme.colors.background }} >
                <View style={{ width:'100%', flexDirection:'row', gap:20, borderBottomWidth:.5, borderBottomColor:theme.colors.borderColor, padding:10,}} >
                    <TouchableOpacity onPress={() => navigation.goBack()} style={{ width:30, height:30, justifyContent:'center', alignItems:'flex-end' }} >
                      <FontAwesome6 name="arrow-left" size={20} color={ theme.colors.primaryTextColor } />
                    </TouchableOpacity>
                    <View style={{ flex:1, alignItems:'flex-start', justifyContent:'center' }} >
                        <Text style={{ fontFamily:'Poppins-SemiBold', fontSize:16, color:theme.colors.primaryTextColor }} >Setting</Text>
                    </View>
                </View>
                <ScrollView style={{ flex:1, padding:20 }} >
                  <View style={{  }} >
                    <View style={{ width:'100%', flexDirection:'row', gap:10, backgroundColor:theme.colors.cardBackground, padding:10, borderRadius:6, elevation:2, marginBottom:20 }} >
                        {/* <TouchableOpacity onPress={() => navigation.navigate('PersonalInfoEdit')} activeOpacity={0.9} style={{ width:25, height:25, backgroundColor: theme.colors.themeColor, alignItems:'center', justifyContent:'center', borderRadius:100, position:'absolute', top:-10, right:30  }} >
                           <AntDesign name="edit" size={16} color={theme.colors.textWhite} />
                        </TouchableOpacity> */}
                        <View style={{ width:70, height:70, borderRadius:100 }} >
                          {
                            profileData?.profileImage ? (
                              <Image resizeMode="cover" source={{ uri: profileData?.profileImage }} style={{ width: '100%', height: '100%', borderRadius: 100, overflow: 'hidden' }}/>
                            ):(
                              <View style={{ width:70, height:70, borderRadius:100, alignItems:'center', justifyContent:'center', backgroundColor: theme.colors.themeColor }} >
                                <Text style={{ color:theme.colors.textWhite, fontFamily:'Poppins-SemiBold', fontSize:26, textTransform: 'uppercase' }} >{profileData?.fullName.charAt(0)}</Text>
                              </View>
                            )
                          }
                        </View>
                        <View style={{ flex: 1, justifyContent:'center' }} >
                            <Text style={{ fontFamily: 'Poppins-SemiBold', fontSize:14, color:theme.colors.primaryTextColor, paddingBottom:3, borderBottomWidth:.2, borderBottomColor:theme.colors.borderColor }} >{profileData?.fullName}</Text>
                            <Text style={{ fontFamily: 'Poppins-Medium', fontSize:12, color:theme.colors.placeHolderTextColor, paddingTop:3 }} >{profileData?.email}</Text>
                        </View>
                    </View>
                    <View style={{ width:'100%', marginBottom:20 }} >
                      <View style={{ width:'100%', height:40, flexDirection:'row', gap:10, alignItems:'center', justifyContent:'space-between', borderBottomWidth:.4, borderBottomColor:theme.colors.borderColor, marginBottom:10  }} >
                        <View style={{ width:30, height:30, justifyContent:"center", alignItems:'center', borderRadius:50, }} >
                         <AntDesign name="exclamation-circle" size={20} color={theme.colors.placeHolderTextColor} />
                        </View>
                        <View style={{ flex:1, }} >
                          <Text style={{ fontFamily:'Poppins-Medium', fontSize:14, color:theme.colors.primaryTextColor }} >About</Text>
                          <Text style={{ fontFamily:'Poppins-Medium', fontSize:12, color:theme.colors.placeHolderTextColor }} >{profileData?.about || 'N/A'}</Text>
                        </View>
                      </View>
                    </View>
                    <View style={{ width:'100%', padding:15, backgroundColor: theme.colors.cardBackground, borderRadius:6, elevation:2,}} >
                      <TouchableOpacity activeOpacity={0.9} style={{ width:'100%', height:40, flexDirection:'row', alignItems:'center', justifyContent:'space-between', borderBottomWidth:.4, borderBottomColor:theme.colors.borderColor, marginBottom:10 }} >
                        <View style={{ width:30, height:30, justifyContent:"center", alignItems:'center', borderRadius:50, }} >
                          <Ionicons name="key-outline" size={20} color={theme.colors.primaryTextColor} />
                        </View>
                        <View style={{ width:"75%", flexDirection:'row', gap:10, }} >
                          <Text style={{ fontFamily:'Poppins-SemiBold', fontSize:14, color:theme.colors.primaryTextColor }} >Change Password</Text>
                        </View>
                        <Entypo name="chevron-right" size={24} color={ theme.colors.placeHolderTextColor } />
                      </TouchableOpacity>
                      <TouchableOpacity onPress={()=> navigation.navigate('Privacy')} activeOpacity={0.9} style={{ width:'100%', height:40, flexDirection:'row', alignItems:'center', justifyContent:'space-between', borderBottomWidth:.4, borderBottomColor:theme.colors.borderColor, marginBottom:10 }} >
                        <View style={{ width:30, height:30, justifyContent:"center", alignItems:'center', borderRadius:50, }} >
                          <MaterialCommunityIcons name="security" size={20} color={theme.colors.primaryTextColor} />
                        </View>
                        <View style={{ width:"75%", flexDirection:'row', gap:10, }} >
                          <Text style={{ fontFamily:'Poppins-SemiBold', fontSize:14, color:theme.colors.primaryTextColor }} >Privacy Policy</Text>
                        </View>
                        <Entypo name="chevron-right" size={24} color={ theme.colors.placeHolderTextColor } />
                      </TouchableOpacity>
                      <TouchableOpacity onPress={()=> navigation.navigate('Term')} activeOpacity={0.9} style={{ width:'100%', height:40, flexDirection:'row', alignItems:'center', justifyContent:'space-between', borderBottomWidth:.4, borderBottomColor:theme.colors.borderColor, marginBottom:10 }} >
                        <View style={{ width:30, height:30, justifyContent:"center", alignItems:'center', borderRadius:50, }} >
                          <AntDesign name="file-protect" size={20} color={theme.colors.primaryTextColor} />
                        </View>
                        <View style={{ width:"75%", flexDirection:'row', gap:10, }} >
                          <Text style={{ fontFamily:'Poppins-SemiBold', fontSize:14, color:theme.colors.primaryTextColor }} >Term & Conditions</Text>
                        </View>
                        <Entypo name="chevron-right" size={24} color={ theme.colors.placeHolderTextColor } />
                      </TouchableOpacity>
                      <TouchableOpacity onPress={()=> navigation.navigate('ChatColorTheme')} activeOpacity={0.9} style={{ width:'100%', height:40, flexDirection:'row', alignItems:'center', justifyContent:'space-between', borderBottomWidth:.4, borderBottomColor:theme.colors.borderColor, marginBottom:10 }} >
                        <View style={{ width:30, height:30, justifyContent:"center", alignItems:'center', borderRadius:50, }} >
                          <Ionicons name="color-palette-outline" size={20} color={theme.colors.primaryTextColor} />
                        </View>
                        <View style={{ width:"75%", flexDirection:'row', gap:10, }} >
                          <Text style={{ fontFamily:'Poppins-SemiBold', fontSize:14, color:theme.colors.primaryTextColor }} >Change Theme</Text>
                        </View>
                        <Entypo name="chevron-right" size={24} color={ theme.colors.placeHolderTextColor } />
                      </TouchableOpacity>
                    </View>
                    <View activeOpacity={0.9} style={{ width:'100%', padding:10, backgroundColor: theme.colors.cardBackground, marginTop:20, borderRadius:6, elevation:2 }} >
                      <TouchableOpacity onPress={handleLogout} style={{ flexDirection:'row', gap:10, alignItems:'center' }} >
                      <View style={{ width:30, height:30, justifyContent:"center", alignItems:'center', borderRadius:50, }} >
                        <AntDesign name="logout" size={20} color="red" />
                      </View>
                        <Text style={{ fontFamily:'Poppins-SemiBold', fontSize:16, color:'red' }} >Logout</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </ScrollView>
            </View>
        </Animated.View>
    )
}