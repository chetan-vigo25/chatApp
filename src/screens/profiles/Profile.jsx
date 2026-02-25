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

    useEffect(() => {
      dispatch(profileDetail()); 
      const timer = setTimeout(() => {
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }).start();
      }, 400);
      return () => clearTimeout(timer);
    }, []);

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
          setSelectedImage(result.assets[0].uri);
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
          setSelectedImage(result.assets[0].uri);
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
    
    const imageEdit = async () => {
      if (!selectedImage) {
        showToast('No image selected');
        return;
      }

      setLoader(true);
      try {
        let token = await AsyncStorage.getItem("accessToken");
        const myHeaders = new Headers();
        myHeaders.append("Authorization", "Bearer " + token);

        const formData = new FormData();
        
        // Get file extension and mime type
        const uriParts = selectedImage.split('.');
        const fileType = uriParts[uriParts.length - 1];
        const mimeType = fileType === 'jpg' || fileType === 'jpeg' ? 'image/jpeg' : 'image/png';

        formData.append("file", {
          uri: selectedImage,
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
          setSelectedImage(null); // Clear selected image after successful upload
        } else {
          console.error("Image upload failed with response:", result);
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

    return (
      <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
        <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
          <View style={{ width: '100%', flexDirection: 'row', gap: 20, borderBottomWidth: 0.5, borderBottomColor: theme.colors.borderColor, padding: 10 }}>
            <TouchableOpacity onPress={() => navigation.goBack()} style={{ width: 30, height: 30, justifyContent: 'center', alignItems: 'flex-end' }}>
              <FontAwesome6 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
            </TouchableOpacity>
            <View style={{ flex: 1, alignItems: 'flex-start', justifyContent: 'center' }}>
              <Text style={{ fontFamily: 'Poppins-SemiBold', fontSize: 16, color: theme.colors.primaryTextColor }}>Profile</Text>
            </View>
          </View>
          <ScrollView style={{ flex: 1, padding: 20 }} showsVerticalScrollIndicator={false}>
            <View>
              <View style={{ width: 150, height: 150, alignSelf: 'center', alignItems: 'center', justifyContent: 'center', borderRadius: 75, overflow: 'hidden', marginBottom: 10 }}>
                <View style={{ width: 150, height: 150, backgroundColor: '#ccc', borderRadius: 100, overflow: 'hidden', justifyContent: 'center', alignItems: "center" }}>
                  {loader ? (
                    <ActivityIndicator size="large" color={theme.colors.themeColor} />
                  ) : (
                    <>
                      {getImageSource() ? (
                        <Image
                          resizeMode="cover"
                          source={getImageSource()}
                          style={{ width: '100%', height: '100%' }}
                        />
                      ) : (
                        <FontAwesome5 name="user-alt" size={80} color="#fff" />
                      )}
                    </>
                  )}
                </View>
                <TouchableOpacity 
                  onPress={showImagePickerOptions} 
                  disabled={loader}
                  style={{ 
                    width: 150, 
                    height: 35, 
                    justifyContent: 'center', 
                    alignItems: 'center', 
                    backgroundColor: '#00000080', 
                    position: 'absolute', 
                    bottom: 0, 
                    borderBottomLeftRadius: 100, 
                    borderBottomRightRadius: 100 
                  }}
                >
                  <Ionicons name="camera-reverse" size={24} color="#fff" />
                </TouchableOpacity>
              </View>
              
              {profileData?.profileImage && (
                <TouchableOpacity onPress={removeDp} disabled={loader}>
                  <Text style={{ color: theme.colors.placeHolderTextColor, fontFamily: 'Poppins-Medium', fontSize: 14, textAlign: "center" }}>
                    Remove Picture
                  </Text>
                </TouchableOpacity>
              )}
              
              <View style={{ width: '100%', marginTop: 40 }}>
                <View style={{ width: '100%', marginBottom: 20 }}>
                  <TouchableOpacity 
                    onPress={() => navigation.navigate('PersonalInfoEdit', { field: 'fullName', value: profileData?.fullName })} 
                    activeOpacity={0.9} 
                    style={{ width: '100%', height: 40, flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 0.4, borderBottomColor: theme.colors.borderColor, marginBottom: 10 }}
                  >
                    <View style={{ width: 30, height: 30, justifyContent: "center", alignItems: 'center', borderRadius: 50 }}>
                      <FontAwesome5 name="user" size={20} color={theme.colors.placeHolderTextColor} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontFamily: 'Poppins-Medium', fontSize: 14, color: theme.colors.primaryTextColor }}>Name</Text>
                      <Text style={{ fontFamily: 'Poppins-Medium', fontSize: 12, color: theme.colors.placeHolderTextColor }}>{profileData?.fullName}</Text>
                    </View>
                  </TouchableOpacity>
                </View>
                
                <View style={{ width: '100%', marginBottom: 20 }}>
                  <TouchableOpacity 
                    onPress={() => navigation.navigate('PersonalInfoEdit', { field: 'about', value: profileData?.about })} 
                    activeOpacity={0.9} 
                    style={{ width: '100%', height: 40, flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 0.4, borderBottomColor: theme.colors.borderColor, marginBottom: 10 }}
                  >
                    <View style={{ width: 30, height: 30, justifyContent: "center", alignItems: 'center', borderRadius: 50 }}>
                      <AntDesign name="exclamation-circle" size={20} color={theme.colors.placeHolderTextColor} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontFamily: 'Poppins-Medium', fontSize: 14, color: theme.colors.primaryTextColor }}>About</Text>
                      <Text style={{ fontFamily: 'Poppins-Medium', fontSize: 12, color: theme.colors.placeHolderTextColor }}>{profileData?.about || 'N/A'}</Text>
                    </View>
                  </TouchableOpacity>
                </View>
                
                <View style={{ width: '100%', marginBottom: 20 }}>
                  <View style={{ width: '100%', height: 40, flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 0.4, borderBottomColor: theme.colors.borderColor, marginBottom: 10 }}>
                    <View style={{ width: 30, height: 30, justifyContent: "center", alignItems: 'center', borderRadius: 50 }}>
                      <MaterialIcons name="call" size={20} color={theme.colors.placeHolderTextColor} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontFamily: 'Poppins-Medium', fontSize: 14, color: theme.colors.primaryTextColor }}>Phone</Text>
                      <Text style={{ fontFamily: 'Poppins-Medium', fontSize: 12, color: theme.colors.placeHolderTextColor }}>
                        {profileData?.mobile?.code} {profileData?.mobile?.number}
                      </Text>
                    </View>
                  </View>
                </View>
                
                <View style={{ width: '100%', marginBottom: 20 }}>
                  <View style={{ width: '100%', height: 40, flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 0.4, borderBottomColor: theme.colors.borderColor, marginBottom: 10 }}>
                    <View style={{ width: 30, height: 30, justifyContent: "center", alignItems: 'center', borderRadius: 50 }}>
                      <MaterialIcons name="email" size={20} color={theme.colors.placeHolderTextColor} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontFamily: 'Poppins-Medium', fontSize: 14, color: theme.colors.primaryTextColor }}>Email</Text>
                      <Text style={{ fontFamily: 'Poppins-Medium', fontSize: 12, color: theme.colors.placeHolderTextColor }}>{profileData?.email}</Text>
                    </View>
                  </View>
                </View>
              </View>
            </View>
          </ScrollView>
          
          {selectedImage && (
            <TouchableOpacity 
              onPress={imageEdit} 
              disabled={loader} 
              style={{ 
                opacity: loader ? 0.5 : 1, 
                width: '80%', 
                height: 50, 
                alignSelf: "center", 
                backgroundColor: theme.colors.themeColor, 
                justifyContent: 'center', 
                alignItems: 'center', 
                borderRadius: 40, 
                marginBottom: 20 
              }}
            >
              <Text style={{ fontFamily: 'Poppins-SemiBold', fontSize: 16, color: '#fff' }}>
                {loader ? 'Uploading...' : 'Upload'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </Animated.View>
    );
}