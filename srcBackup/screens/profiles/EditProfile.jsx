import React, { useState, useEffect, useRef } from "react";
import { View, Text, Image, Animated, TouchableOpacity, ScrollView, Alert, Platform, ToastAndroid, ActivityIndicator, TextInput } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../../contexts/ThemeContext";
import { useDispatch, useSelector } from "react-redux";
import * as ImagePicker from 'expo-image-picker';
import { editProfile, profileDetail } from "../../Redux/Reducer/Profile/Profile.reducer";

import { BACKEND_URL } from '@env';

import { Feather, FontAwesome5, Ionicons } from '@expo/vector-icons';

function showToast(message) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    Alert.alert('', message);
  }
}

export default function EditProfile({ navigation, route }) {
    const { selectedCountry, phoneNumber } = route.params;
    const { theme, isDarkMode, toggleTheme } = useTheme();
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const [focusedInput, setFocusedInput] = useState(null);
    const [formErrors, setFormErrors] = useState({}); 
    const [selectedImage, setSelectedImage] = useState(null);
    const [imageUploadLoader, setImageUploadLoader] = useState(false);
    const dispatch = useDispatch();
    const { profileData, updateProfileData, isLoading, error } = useSelector(state => state.profile);
    const fullNumber = selectedCountry?.code + phoneNumber;

    const [form, setForm] = useState({
      fullName: '',
      email: '',
      about: '',
    });

    useEffect(() => {
      // Pre-fill form with existing profile data if available
      if (profileData) {
        setForm({
          fullName: profileData.fullName || '',
          email: profileData.email || '',
          about: profileData.about || '',
        });
      }
    }, [profileData]);

    useEffect(() => {
      // Fetch profile data if not available
      if (!profileData) {
        dispatch(profileDetail());
      }
    }, []);

    const handleChange = (name, value) => {
      setForm(prev => ({
        ...prev,
        [name]: value,
      }));
      // Clear error for this field when user starts typing
      if (formErrors[name]) {
        setFormErrors(prev => ({
          ...prev,
          [name]: null
        }));
      }
    };

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

    const validateForm = () => {
      let newErrors = {};
  
      if (!form.fullName?.trim()) newErrors.fullName = 'Full Name is required';
      if (!form.email?.trim()) newErrors.email = 'Email is required';
      else {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(form.email)) newErrors.email = 'Please enter a valid email address';
      }
      if (!form.about?.trim()) newErrors.about = 'About is required';
      if (!phoneNumber?.trim()) newErrors.phoneNumber = 'Phone number is required';
  
      setFormErrors(newErrors);
      return Object.keys(newErrors).length === 0; // returns true if no errors
    };

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

      setImageUploadLoader(true);
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
          setImageUploadLoader(false);
          dispatch(profileDetail());
          setSelectedImage(null); // Clear selected image after successful upload
        } else {
          console.error("Image upload failed with response:", result);
          const msg = result?.message || "Image upload failed";
          showToast(msg);
          setImageUploadLoader(false);
        }
      } catch (error) {
        console.error("Network request failed:", error);
        showToast("Network request failed");
        setImageUploadLoader(false);
      }
    };

    const getImageSource = () => {
      if (selectedImage) {
        return { uri: selectedImage };
      } else if (profileData?.profileImage) {
        return { uri: profileData.profileImage };
      }
      return null;
    };

    const handleUpdateProfile = async () => {
      if (!validateForm()) return;
      
      const payload = {
        fullName: form.fullName,
        email: form.email,
        about: form.about,
        profileImage: '',
        mobile: {
            code: selectedCountry?.code || '',
            number: phoneNumber || ''
        },
      };
  
      try {
        const response = await dispatch(editProfile(payload)).unwrap();
        showToast("Profile updated successfully");
        dispatch(profileDetail());
        setForm({ fullName: '', email: '', about: '' }); 
        navigation.navigate('ChatList')
      } catch (error) {
        console.error("Profile update failed", error);
        showToast(error?.message || "Profile update failed");
      }
    };

    return (
        <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
            <View style={{ flex:1, backgroundColor: theme.colors.background }} >
                <View style={{ width:'100%', flexDirection:'row', borderBottomWidth:.5, borderBottomColor:theme.colors.borderColor, padding:10,}} >
                    <View style={{ flex:1, alignItems:'center', justifyContent:'center' }} >
                        <Text style={{ fontFamily:'Poppins-SemiBold', fontSize:16, color:theme.colors.primaryTextColor }} >Edit Profile</Text>
                    </View>
                    <View style={{ width:40 }} />
                </View>
                
                <ScrollView style={{ flex:1, padding:20 }} showsVerticalScrollIndicator={false}>
                    <View style={{ alignItems:'center' }} >
                        <View style={{ width:150, height:150, alignItems:'center', justifyContent:'center', borderRadius:75, overflow: 'hidden', marginBottom:10 }} >
                            <View style={{ width:150, height:150, backgroundColor:'#ccc', borderRadius:100, overflow: 'hidden', justifyContent: 'center', alignItems:"center" }} >
                              {imageUploadLoader ? (
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
                              disabled={imageUploadLoader}
                              style={{ width:150, height:35, justifyContent:'center', alignItems:'center', backgroundColor:'#00000080', position:'absolute', bottom:0, borderBottomLeftRadius:100, borderBottomRightRadius:100 }} 
                            >
                              <Ionicons name="camera-reverse" size={24} color="#fff" />
                            </TouchableOpacity>
                        </View>
                        
                        {selectedImage && (
                          <TouchableOpacity 
                            onPress={imageEdit} 
                            disabled={imageUploadLoader}
                            style={{ marginBottom: 20 }}
                          >
                            <Text style={{ color: theme.colors.themeColor, fontFamily: 'Poppins-Medium', fontSize: 14 }}>
                              {imageUploadLoader ? 'Uploading...' : 'Upload Image'}
                            </Text>
                          </TouchableOpacity>
                        )}
                        
                        <View style={{ width:'100%', marginTop:20 }} >
                          <View style={{ width:'100%', marginBottom:20 }} >
                            <View style={{ width:'100%', height:50, backgroundColor:theme.colors.menuBackground, justifyContent:'center', borderRadius:6, borderWidth:1, borderColor:focusedInput === 'fullName' ? theme.colors.themeColor : theme.colors.borderColor, }} >
                                <TextInput 
                                  placeholder="Full Name" 
                                  placeholderTextColor={theme.colors.placeHolderTextColor} 
                                  style={{ flex:1, paddingLeft:15, color:theme.colors.primaryTextColor, fontFamily:'Poppins-Medium', fontSize:16, }} 
                                  value={form.fullName}
                                  onChangeText={(value) => handleChange('fullName', value)}
                                  onFocus={() => setFocusedInput('fullName')}
                                  onBlur={() => setFocusedInput(null)}
                                />
                            </View>
                            {formErrors.fullName && <Text style={{ fontSize: 12, fontFamily:"Poppins-Medium", color: 'red', marginTop: 5 }}>{formErrors.fullName}</Text>}
                          </View>
                          
                          <View style={{ width:'100%', marginBottom:20 }} >
                           <View style={{ width:'100%', height:50, backgroundColor:theme.colors.menuBackground, justifyContent:'center', borderRadius:6, borderWidth:1, borderColor:focusedInput === 'email' ? theme.colors.themeColor : theme.colors.borderColor, }} >
                               <TextInput 
                                 placeholder="Email" 
                                 placeholderTextColor={theme.colors.placeHolderTextColor} 
                                 style={{ flex:1, paddingLeft:15, color:theme.colors.primaryTextColor, fontFamily:'Poppins-Medium', fontSize:16, }} 
                                 value={form.email}
                                 keyboardType="email-address"
                                 autoCapitalize="none"
                                 onChangeText={(value) => handleChange('email', value)}
                                 onFocus={() => setFocusedInput('email')}
                                 onBlur={() => setFocusedInput(null)}
                               />
                           </View>
                           {formErrors.email && <Text style={{ fontSize: 12, fontFamily:"Poppins-Medium", color: 'red', marginTop: 5 }}>{formErrors.email}</Text>}
                          </View>
                          
                          <View style={{ width:'100%', marginBottom:20 }} >
                          <View style={{ width:'100%', height:50, backgroundColor:theme.colors.menuBackground, justifyContent:'center', borderRadius:6, borderWidth:1, borderColor:focusedInput === 'about' ? theme.colors.themeColor : theme.colors.borderColor, }} >
                              <TextInput 
                                placeholder="About" 
                                placeholderTextColor={theme.colors.placeHolderTextColor} 
                                style={{ flex:1, paddingLeft:15, color:theme.colors.primaryTextColor, fontFamily:'Poppins-Medium', fontSize:16, }} 
                                value={form.about}
                                onChangeText={(value) => handleChange('about', value)}
                                onFocus={() => setFocusedInput('about')}
                                onBlur={() => setFocusedInput(null)}
                                multiline={false}
                              />
                          </View>
                          {formErrors.about && <Text style={{ fontSize: 12, fontFamily:"Poppins-Medium", color: 'red', marginTop: 5 }}>{formErrors.about}</Text>}
                          </View>
                          
                          <View style={{ width:'100%', height:50, backgroundColor:theme.colors.menuBackground, justifyContent:'center', borderRadius:6, marginBottom:10, borderWidth:1, borderColor:theme.colors.borderColor }} >
                              <TextInput 
                                editable={false}
                                placeholderTextColor={theme.colors.placeHolderTextColor} 
                                style={{ flex:1, paddingLeft:15, color:theme.colors.primaryTextColor, fontFamily:'Poppins-Medium', fontSize:16, }} 
                                value={fullNumber}
                              />
                          </View>
                          <Text style={{ fontFamily:'Poppins-Medium', fontSize:12, color:theme.colors.placeHolderTextColor, textAlign:'center', marginTop:5 }}>
                            Phone number cannot be changed
                          </Text>
                        </View>
                    </View>
                </ScrollView>
               
                <TouchableOpacity 
                  onPress={handleUpdateProfile} 
                  disabled={isLoading || imageUploadLoader}
                  style={{ 
                    width:55, 
                    height:55, 
                    backgroundColor: theme.colors.themeColor, 
                    position:'absolute', 
                    bottom:20, 
                    right:20, 
                    borderRadius:15, 
                    alignItems:'center', 
                    justifyContent:'center',
                    opacity: (isLoading || imageUploadLoader) ? 0.5 : 1
                  }} 
                >
                  {isLoading ? (
                    <ActivityIndicator size="small" color={theme.colors.textWhite} />
                  ) : (
                    <Feather name="check" size={24} color={theme.colors.textWhite} />
                  )}
                </TouchableOpacity>
            </View>
        </Animated.View>
    );
}