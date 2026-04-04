import React, { useState, useEffect, useRef } from "react";
import { View, Text, Image, Animated, TouchableOpacity, ScrollView, Alert, Platform, ToastAndroid, ActivityIndicator } from "react-native";
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../../contexts/ThemeContext";
import { useDispatch, useSelector } from "react-redux";
import { editProfile, profileDetail, editImage } from "../../Redux/Reducer/Profile/Profile.reducer";

import { BACKEND_URL } from '@env';

import { FontAwesome6, Ionicons, FontAwesome5, AntDesign, MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';

function showToast(message) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    Alert.alert('', message);
  }
}

export default function Profile({ navigation }) {
    const { theme, isDarkMode, toggleTheme } = useTheme();
    const [selectedImage, setSelectedImage] = useState(null);
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const dispatch = useDispatch();
    const { profileData, isLoading, error } = useSelector(state => state.profile);
    const [loader, setLoader] = useState(false);

    useFocusEffect(
      React.useCallback(() => {
        dispatch(profileDetail()); 
        const timer = setTimeout(() => {
          Animated.timing(fadeAnim, {
            toValue: 1,
            duration: 400,
            useNativeDriver: true,
          }).start();
        }, 400);
        return () => clearTimeout(timer);
      }, [])
    );

    const requestPermission = async () => {
      if (Platform.OS !== 'web') {
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert('Permission needed', 'Sorry, we need camera roll permissions to make this work!');
          return false;
        }
        return true;
      }
      return true;
    };

    const pickImage = async () => {
      const hasPermission = await requestPermission();
      if (!hasPermission) return;
    
      try {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          allowsEditing: true,
          aspect: [1, 1],
          quality: 0.8,
          base64: false,
        });
    
        if (!result.canceled && result.assets && result.assets.length > 0) {
          const uri = result.assets[0].uri;
          setSelectedImage(uri);
    
          // 🔹 Immediately upload the selected image
          await imageEdit(uri);
        }
         
      } catch (error) {
        console.error('Error picking image:', error);
        showToast('Failed to pick image');
      }
    };

    const takePhoto = async () => {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Sorry, we need camera permissions to make this work!');
        return;
      }
    
      try {
        const result = await ImagePicker.launchCameraAsync({
          allowsEditing: true,
          aspect: [1, 1],
          quality: 0.8,
        });
    
        if (!result.canceled && result.assets && result.assets.length > 0) {
          const uri = result.assets[0].uri;
          setSelectedImage(uri);
    
          // 🔹 Immediately upload the captured photo
          await imageEdit(uri);
        }
      } catch (error) {
        console.error('Error taking photo:', error);
        showToast('Failed to take photo');
      }
    };

    const showImagePickerOptions = () => {
      Alert.alert(
        'Select Profile Picture',
        'Choose an option',
        [
          // {
          //   text: 'Take Photo',
          //   onPress: takePhoto,
          // },
          {
            text: 'Choose from Gallery',
            onPress: pickImage,
          },
          {
            text: 'Cancel',
            style: 'cancel',
          },
        ],
        { cancelable: true }
      );
    };
    
    const imageEdit = async (uri) => {
      if (!uri) {
        showToast('No image selected');
        return;
      }
    
      setLoader(true);
      try {
        let token = await AsyncStorage.getItem("accessToken");
        const myHeaders = new Headers();
        myHeaders.append("Authorization", "Bearer " + token);
    
        const formData = new FormData();
        const uriParts = uri.split('.');
        const fileType = uriParts[uriParts.length - 1];
        const mimeType = fileType === 'jpg' || fileType === 'jpeg' ? 'image/jpeg' : 'image/png';
    
        formData.append("file", {
          uri,
          name: `profile.${fileType}`,
          type: mimeType,
        });
    
        const requestOptions = {
          method: "POST",
          headers: myHeaders,
          body: formData,
        };
    
        const response = await fetch(`${BACKEND_URL}user/profile/picture`, requestOptions);
        const result = await response.json();
    
        if (result?.statusCode === 200) {
          showToast("Profile image updated");
          setLoader(false);
          dispatch(profileDetail());
          setSelectedImage(null); // Clear after successful upload
        } else {
          const msg = result?.message || "Image upload failed";
          showToast(msg);
          setLoader(false);
        }
      } catch (error) {
        console.error("Network request failed:", error);
        showToast("Network request failed");
        setLoader(false);
      }
    };

    const removeDp = async () => {
      setLoader(true);
      const token = await AsyncStorage.getItem("accessToken");
      const myHeaders = new Headers();

      myHeaders.append("Authorization", "Bearer " + token);
       
      const raw = "";
      const requestOptions = {
        method: "POST",
        headers: myHeaders,
        body: raw,
        redirect: "follow"
      };
       
      fetch(`${BACKEND_URL}user/profile/picture/remove`, requestOptions)
        .then((response) => response.json())
        .then((result) => {
          if(result?.statusCode === 200){
            showToast("Profile image removed");
            dispatch(profileDetail());
            setSelectedImage(null);
            setLoader(false);
          }else{
            const msg = result?.message || "Failed to remove profile image";
            showToast(msg);
            setLoader(false);
          }
        })
        .catch((error) => {
          console.error(error);
          showToast("Failed to remove profile image");
          setLoader(false);
        });
    }

    const getImageSource = () => {
      if (selectedImage) {
        return { uri: selectedImage };
      } else if (profileData?.profileImage) {
        return { uri: profileData.profileImage };
      }
      return null;
    };

    // console.log("profile data---", profileData)
    return (
      <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
        <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
          <View style={{ width: '100%', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 12 }}>
            <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.6} style={{ width: 40, height: 40, justifyContent: 'center', alignItems: 'center', borderRadius: 20 }}>
              <FontAwesome6 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
            </TouchableOpacity>
            <Text style={{ fontFamily: 'Roboto-SemiBold', fontSize: 18, color: theme.colors.primaryTextColor, marginLeft: 12 }}>Profile</Text>
          </View>
          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
            <View>
              {/* Avatar Section */}
              <View style={{ alignItems: 'center', paddingTop: 24, paddingBottom: 24 }}>
                <View style={{ position: 'relative', marginBottom: 16 }}>
                  <View style={{ width: 120, height: 120, borderRadius: 60, overflow: 'hidden', backgroundColor: theme.colors.menuBackground || '#e0e0e0' }}>
                    {loader ? (
                      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                        <ActivityIndicator size="large" color={theme.colors.themeColor} />
                      </View>
                    ) : (
                      <>
                        {getImageSource() ? (
                          <Image
                            resizeMode="cover"
                            source={getImageSource()}
                            style={{ width: '100%', height: '100%' }}
                          />
                        ) : (
                          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                            <FontAwesome5 name="user-alt" size={50} color={theme.colors.placeHolderTextColor || '#aaa'} />
                          </View>
                        )}
                      </>
                    )}
                  </View>
                  <TouchableOpacity
                    onPress={showImagePickerOptions}
                    disabled={loader}
                    activeOpacity={0.7}
                    style={{
                      position: 'absolute',
                      bottom: 0,
                      right: 0,
                      width: 38,
                      height: 38,
                      borderRadius: 19,
                      backgroundColor: theme.colors.themeColor,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderWidth: 3,
                      borderColor: theme.colors.background,
                    }}
                  >
                    <Ionicons name="camera" size={18} color="#fff" />
                  </TouchableOpacity>
                </View>

                {profileData?.fullName && (
                  <Text style={{ fontFamily: 'Roboto-SemiBold', fontSize: 22, color: theme.colors.primaryTextColor, textTransform: 'capitalize' }}>
                    {profileData.fullName}
                  </Text>
                )}
                {profileData?.about ? (
                  <Text style={{ fontFamily: 'Roboto-Regular', fontSize: 13, color: theme.colors.placeHolderTextColor, marginTop: 2, paddingHorizontal: 40, textAlign: 'center' }} numberOfLines={2}>
                    {profileData.about}
                  </Text>
                ) : null}

                {profileData?.profileImage && (
                  <TouchableOpacity onPress={removeDp} disabled={loader} activeOpacity={0.6} style={{ marginTop: 14 }}>
                    <Text style={{ color: '#E53935', fontFamily: 'Roboto-Medium', fontSize: 13 }}>
                      Remove Photo
                    </Text>
                  </TouchableOpacity>
                )}
              </View>

              {/* Divider */}
              <View style={{ height: 6, backgroundColor: theme.colors.menuBackground || (isDarkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)') }} />

              {/* Info Rows — flat, no card container */}
              <View style={{ paddingTop: 8 }}>

                {/* Name */}
                <TouchableOpacity
                  onPress={() => navigation.navigate('PersonalInfoEdit', { field: 'fullName', value: profileData?.fullName })}
                  activeOpacity={0.5}
                  style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14 }}
                >
                  <Ionicons name="person-outline" size={22} color={theme.colors.placeHolderTextColor} style={{ width: 28 }} />
                  <View style={{ flex: 1, marginLeft: 16 }}>
                    <Text style={{ fontFamily: 'Roboto-Regular', fontSize: 11, color: theme.colors.placeHolderTextColor, lineHeight: 14 }}>Name</Text>
                    <Text style={{ fontFamily: 'Roboto-Medium', fontSize: 16, color: theme.colors.primaryTextColor, textTransform: 'capitalize', lineHeight: 22 }}>{profileData?.fullName}</Text>
                  </View>
                  <Ionicons name="pencil-outline" size={18} color={theme.colors.placeHolderTextColor} />
                </TouchableOpacity>

                <View style={{ height: 0.5, backgroundColor: theme.colors.borderColor, marginLeft: 64, opacity: 0.35 }} />

                {/* About */}
                <TouchableOpacity
                  onPress={() => navigation.navigate('PersonalInfoEdit', { field: 'about', value: profileData?.about })}
                  activeOpacity={0.5}
                  style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14 }}
                >
                  <Ionicons name="information-circle-outline" size={22} color={theme.colors.placeHolderTextColor} style={{ width: 28 }} />
                  <View style={{ flex: 1, marginLeft: 16 }}>
                    <Text style={{ fontFamily: 'Roboto-Regular', fontSize: 11, color: theme.colors.placeHolderTextColor, lineHeight: 14 }}>About</Text>
                    <Text style={{ fontFamily: 'Roboto-Medium', fontSize: 16, color: theme.colors.primaryTextColor, lineHeight: 22 }} numberOfLines={1}>{profileData?.about || 'Add about'}</Text>
                  </View>
                  <Ionicons name="pencil-outline" size={18} color={theme.colors.placeHolderTextColor} />
                </TouchableOpacity>

                <View style={{ height: 0.5, backgroundColor: theme.colors.borderColor, marginLeft: 64, opacity: 0.35 }} />

                {/* Phone */}
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14 }}>
                  <Ionicons name="call-outline" size={22} color={theme.colors.placeHolderTextColor} style={{ width: 28 }} />
                  <View style={{ flex: 1, marginLeft: 16 }}>
                    <Text style={{ fontFamily: 'Roboto-Regular', fontSize: 11, color: theme.colors.placeHolderTextColor, lineHeight: 14 }}>Phone</Text>
                    <Text style={{ fontFamily: 'Roboto-Medium', fontSize: 16, color: theme.colors.primaryTextColor, lineHeight: 22 }}>
                      {profileData?.mobile?.code} {profileData?.mobile?.number}
                    </Text>
                  </View>
                </View>

                <View style={{ height: 0.5, backgroundColor: theme.colors.borderColor, marginLeft: 64, opacity: 0.35 }} />

                {/* Email */}
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14 }}>
                  <Ionicons name="mail-outline" size={22} color={theme.colors.placeHolderTextColor} style={{ width: 28 }} />
                  <View style={{ flex: 1, marginLeft: 16 }}>
                    <Text style={{ fontFamily: 'Roboto-Regular', fontSize: 11, color: theme.colors.placeHolderTextColor, lineHeight: 14 }}>Email</Text>
                    <Text style={{ fontFamily: 'Roboto-Medium', fontSize: 16, color: theme.colors.primaryTextColor, lineHeight: 22 }}>{profileData?.email || "N/A"}</Text>
                  </View>
                </View>

              </View>
            </View>
          </ScrollView>
        </View>
      </Animated.View>
    );
}