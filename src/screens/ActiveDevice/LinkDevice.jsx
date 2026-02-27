import React, { useState, useEffect, useRef } from "react";
import { StyleSheet, ScrollView, View, Text, TouchableOpacity, Modal, FlatList, TextInput, Image, ActivityIndicator, Platform, ToastAndroid, Animated  } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useTheme } from "../../contexts/ThemeContext";
import LottieView from 'lottie-react-native';
import moment from "moment";
import { useDispatch, useSelector } from "react-redux";
import { linkedDevice, removeDevice } from "../../Redux/Reducer/Auth/Auth.reducer";
import { initSocket, getSocket } from "../../Redux/Services/Socket/socket";

import { FontAwesome6, Entypo } from '@expo/vector-icons';

function showToast(message) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    Alert.alert('', message);
  }
}

export default function LinkDevice({ navigation }) {
    const { theme, isDarkMode, toggleTheme } = useTheme();
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const dispatch = useDispatch();
    const { activeSessionData, isLoading, error } = useSelector(state => state.authentication);
    const [activeLinkedDevices, setActiveLinkedDevices] = useState([]);
    const [modalVisible, setModalVisible] = useState(false);
    const [selectedDevice, setSelectedDevice] = useState(null);



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

    useEffect(() => {
      dispatch(linkedDevice());
    }, []);

    useEffect(() => {
      if (activeSessionData) {
        // console.log("Active session message Data:", activeSessionData.data);
        setActiveLinkedDevices([...activeSessionData.data]);
      }
    }, [activeSessionData]);

    const handleOpenModal = (item) => {
      setModalVisible(true);
      setSelectedDevice(item);
    }

    const handleCloseModal = () => {
      setModalVisible(false);
      setSelectedDevice(null);
    };
    
    // const handleLogoutDevice = async (device) => {
    //   const deviceId = device?._id;
    //   try {
    //     await dispatch(removeDevice(deviceId)).unwrap();
    //     // ✅ remove device locally
    //     setActiveLinkedDevices(prev =>
    //       prev.filter(item => item._id !== deviceId)
    //     );
    //     showToast("Device logged out successfully");
    //     handleCloseModal();
    //   } catch (error) {
    //     showToast(error || "Failed to logout device");
    //   }
    // };
    const handleLogoutDevice = async (device) => {
      const deviceId = device?.deviceId;
      const sessionId = device?._id;
    
      try {
        const socket = getSocket();
        if (!socket) {
          console.error("Socket is not initialized!");
          showToast("Socket is not available. Please try again.");
          return; // Exit early if socket is not available
        }
    
        // Logging the data to console when the function is triggered
        console.log('Initiating device termination with data:', { 
          socketId: socket.id, 
          sessionId: sessionId, 
          deviceId: deviceId 
        });
    
        // Emit device termination event using the socket
        socket.emit('device:terminate', { 
          socketId: socket.id, 
          sessionId: sessionId, 
          deviceId: deviceId 
        }, (response) => {
          // Log the response status from the server
          console.log("Device terminate response:----", response.data);
          
          // Handle success or failure of the response
          if (response.status === true) {
            // ✅ remove device locally
            dispatch(linkedDevice());
            setActiveLinkedDevices(prev =>
              prev.filter(item => item._id !== deviceId)
            );
            showToast("Device logged out successfully");
          } else {
            showToast("Failed to logout device");
          }
        });
    
        // Close the modal after logout (if needed)
        handleCloseModal();
        dispatch(linkedDevice());
      } catch (error) {
        // Handle any errors
        console.error("Error during device logout:", error);
        showToast(error || "Failed to logout device");
      }
    };
    
    
    return (
        <Animated.View style={{ flex: 1, opacity: fadeAnim,}}>
          <View style={{ width:'100%', flexDirection:'row', gap:10, alignItems:'center', padding:10, borderBottomWidth:1, borderBottomColor:theme.colors.borderColor }} >
            <TouchableOpacity onPress={() => navigation.goBack()} style={{ width:40, height:40, alignItems:'center', justifyContent:'center', }} >
               <FontAwesome6 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
            </TouchableOpacity>
            <View style={{ width:'68%' }} >
                <Text style={{ color:theme.colors.primaryTextColor, fontFamily:'Poppins-SemiBold', fontSize:16, textTransform:'capitalize' }} >Linked Devices</Text>
            </View>
          </View>
          <View style={{ flex: 1 }}>
             <ScrollView showsVerticalScrollIndicator={false} style={{ flex:1, padding:10 }} >
               <View style={{ width: '100%', height: 250, }} >
                <Image source={require('../../../assets/images/devicelink.png')} style={{ width:'100%', height:'100%', resizeMode:'contain' }} />
               </View>
               <TouchableOpacity activeOpacity={0.9} style={{ width:'100%', height:45, flexDirection:'row', gap:5, backgroundColor:theme.colors.themeColor, alignItems:'center', justifyContent:'center', borderRadius:40, marginVertical:10 }} >
                 <Entypo name="plus" size={20} color={theme.colors.textWhite} />
                 <Text style={{ color:theme.colors.textWhite, fontFamily:'Poppins-Medium', fontSize:16, }} >Link a device</Text>
               </TouchableOpacity>
                 <View>
                    <Text style={{ color:theme.colors.placeHolderTextColor, fontFamily:'Poppins-Medium', fontSize:14, }} >Linked Devices</Text>
                    <Text style={{ color:theme.colors.placeHolderTextColor, fontFamily:'Poppins-Regular', fontSize:12, }} >Tap a device to logout</Text>
                 </View>
                 <View style={{marginTop:15,}} >
                   {activeLinkedDevices && activeLinkedDevices.length > 0 ? (
                       activeLinkedDevices.map((item, index) => (
                           <TouchableOpacity onPress={()=> handleOpenModal(item)} key={index} activeOpacity={0.9} style={{ width: '100%', flexDirection:'row', gap:10, alignItems:'center', marginBottom:15 }} >
                               <View style={{ width: 50, height: 50, borderRadius:50, borderWidth:2, borderColor:theme.colors.themeColor }} />
                               {
                                 item?.isActive === true ?(
                                   <View style={{ width:15, height:15, borderRadius:15, backgroundColor:'#25D366', position:'absolute', left:35, bottom:5 }} ></View>
                                 ):(<></>)
                               }
                               <View>
                                   <Text style={{ color:theme.colors.primaryTextColor, fontFamily:'Poppins-Medium', fontSize:14 }}>
                                       { item.deviceInfo?.deviceName || 'N/A' } {''} 
                                       { item.deviceInfo?.deviceType || 'N/A' } {''}
                                       { item.deviceInfo?.os || 'N/A' }
                                   </Text>
                                   <Text style={{ color:theme.colors.placeHolderTextColor, fontFamily:'Poppins-Medium', fontSize:12 }}>
                                       Last Activity: {moment(item.lastActivity).format('hh:mm A') || 'N/A'}
                                   </Text>
                               </View>
                           </TouchableOpacity>
                       ))
                   ) : (
                       <Text style={{ color: theme.colors.placeHolderTextColor, textAlign: 'center', marginTop: 20 }}>
                           No linked devices found
                       </Text>
                   )}
                   <Modal
                     animationType="slide"
                     transparent={true} 
                     visible={modalVisible}
                     onRequestClose={() => {
                     setModalVisible(!modalVisible);
                    }}>
                      <View style={{ flex:1, justifyContent:'center',  backgroundColor:'#00000060', padding:20 }} >
                        <View style={{ width:'100%', backgroundColor:theme.colors.cardBackground, padding:20, borderRadius:10, shadowOffset: { width: 0, height: 5, }, shadowOpacity: 0.25, shadowRadius: 4, elevation: 2, }} >
                          <Text style={{ color:theme.colors.primaryTextColor, fontFamily:'Poppins-SemiBold', fontSize:16,}} >You want to logout from this device</Text>
                          <View style={{ marginVertical:15 }} >
                            {
                              selectedDevice && (
                                <View style={{ width: '100%', flexDirection:'row', gap:10, alignItems:'center', marginBottom:15 }} >
                                   <View style={{ width: 50, height: 50, borderRadius:50, borderWidth:2, borderColor:theme.colors.themeColor }} />
                                   {
                                     selectedDevice?.isActive === true ?(
                                       <View style={{ width:15, height:15, borderRadius:15, backgroundColor:'#25D366', position:'absolute', left:35, bottom:5 }} ></View>
                                     ):(<></>)
                                   }
                                   <View>
                                       <Text style={{ color:theme.colors.primaryTextColor, fontFamily:'Poppins-Medium', fontSize:14 }}>
                                           { selectedDevice.deviceInfo?.deviceName || 'N/A' }
                                           { selectedDevice.deviceInfo?.deviceType || 'N/A' }
                                           { selectedDevice.deviceInfo?.os || 'N/A' }
                                       </Text>
                                       <Text style={{ color:theme.colors.placeHolderTextColor, fontFamily:'Poppins-Medium', fontSize:12 }}>
                                           Last Activity: {moment(selectedDevice.lastActivity).format('hh:mm A') || 'N/A'}
                                       </Text>
                                   </View>
                               </View>
                              )
                            }
                          </View>
                          <View style={{ width:'40%', flexDirection:'row', gap:20, alignItems:'center', justifyContent:'center', alignSelf:'flex-end', marginTop:10 }} >
                            <TouchableOpacity onPress={() => handleCloseModal()} style={{ alignItems:'center', justifyContent:'center', }} >
                              <Text style={{ color:theme.colors.primaryTextColor, fontFamily:'Poppins-Medium', fontSize:14, }} >Cencel</Text>
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => handleLogoutDevice(selectedDevice)} style={{ alignItems:'center', justifyContent:'center', }} >
                              <Text style={{ color:'#FF0000', fontFamily:'Poppins-Medium', fontSize:14, }} >Logout</Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                      </View>
                   </Modal>
                 </View>
             </ScrollView>
          </View>
        </Animated.View>
    );
}