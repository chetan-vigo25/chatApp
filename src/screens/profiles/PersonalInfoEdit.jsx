import React, { useState, useEffect, useRef } from "react";
import { View, Text, Image, Animated, TouchableOpacity, ScrollView, Alert, Platform, ToastAndroid, ActivityIndicator, TextInput } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../../contexts/ThemeContext";
import { useDispatch, useSelector } from "react-redux";
import { editProfile, profileDetail } from "../../Redux/Reducer/Profile/Profile.reducer";
import * as SMS from 'expo-sms';

import { FontAwesome6 } from '@expo/vector-icons';

function showToast(message) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    Alert.alert('', message);
  }
}

export default function PersonalInfoEdit({ navigation, route }) {
  const { field, value } = route.params;
  const { theme, isDarkMode, toggleTheme } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const dispatch = useDispatch();
  const { profileData, isLoading, error } = useSelector(state => state.profile);
  const [inputValue, setInputValue] = useState(value || "");  // Default to an empty string if value is null
  const [focusedInput, setFocusedInput] = useState(null);
  const [charCount, setCharCount] = useState((value || "").length);  // Ensure length is computed for a string
  const maxLength = 30;

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
    // Set initial value to input field
    setInputValue(value || "");  // Ensure value is a string
    setCharCount((value || "").length);  // Ensure length is computed for a string
  }, [value]);

  const handleSave = async () => {
    const updatedData = {
      ...profileData,
      [field]: inputValue,
    };
    try {
      await dispatch(editProfile(updatedData));
      await dispatch(profileDetail());
      navigation.goBack();
    } catch (error) {
      console.error("Error updating profile:", error);
      Alert.alert("Error", "Failed to update profile. Please try again.");
    }
  };

  const handleInputChange = (text) => {
    if (text.length <= maxLength) {
      setInputValue(text);
      setCharCount(text.length);
    }
  };

  const sendInvitation = async (receiverPhoneNumber) => {
    const message = "Hey! I'm inviting you to join our app. Please check it out!";

    // Use Expo's SMS API to send message
    const { result } = await SMS.sendSMSAsync(
      receiverPhoneNumber, // Receiver's phone number
      message // Your message
    );

    if (result === 'sent') {
      Alert.alert('Message Sent', 'The invitation message has been sent!');
    } else {
      Alert.alert('Error', 'Message could not be sent');
    }
  };

  return (
    <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
      <View style={{ width: '100%', flexDirection: 'row', gap: 20, borderBottomWidth: .5, borderBottomColor: theme.colors.borderColor, padding: 10 }}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={{ width: 30, height: 30, justifyContent: 'center', alignItems: 'flex-end' }} >
          <FontAwesome6 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'flex-start', justifyContent: 'center' }} >
          <Text style={{ fontFamily: 'Poppins-SemiBold', fontSize: 16, color: theme.colors.primaryTextColor }} >
            Edit {field === 'fullName' ? 'Name' : field === 'about' ? 'About' : ''}
          </Text>
        </View>
      </View>
      <View style={{ flex: 1, backgroundColor: theme.colors.background, padding: 20 }} >
        <View style={{
          width: '100%', height: 50, backgroundColor: theme.colors.background, justifyContent: 'center', borderRadius: 6, borderWidth: 1, borderColor: focusedInput === field ? theme.colors.themeColor : theme.colors.borderColor,
        }} >
          <Text style={{
            color: focusedInput === field ? theme.colors.themeColor : theme.colors.primaryTextColor, alignSelf: "flex-start", fontSize: 12, fontFamily: 'Poppins-SemiBold', paddingHorizontal: 5, position: 'absolute', top: -10, left: 15, backgroundColor: theme.colors.background
          }} >{field === 'fullName' ? 'Name' : field === 'about' ? 'About' : ''}</Text>
          <TextInput placeholder="" placeholderTextColor={theme.colors.placeHolderTextColor} style={{
            flex: 1, paddingLeft: 15, color: theme.colors.primaryTextColor, fontFamily: 'Poppins-Medium', fontSize: 16,
          }}
            value={inputValue}
            onChangeText={handleInputChange}
            onFocus={() => setFocusedInput(field)}
            onBlur={() => setFocusedInput(null)}
            maxLength={maxLength}
          />
        </View>
        <Text style={{ fontFamily: 'Poppins-SemiBold', fontSize: 12, color: theme.colors.placeHolderTextColor, alignSelf: 'flex-end', marginTop: 5 }} >{charCount}/{maxLength}</Text>
        <TouchableOpacity onPress={handleSave} disabled={isLoading} style={{ opacity: isLoading ? 0.5 : 1, width: '100%', height: 50, alignSelf: "center", backgroundColor: theme.colors.themeColor, justifyContent: 'center', alignItems: 'center', borderRadius: 40, marginTop: 20, position: 'absolute', bottom: 40 }} >
          {
            isLoading ? (
              <ActivityIndicator size="small" color={theme.colors.textWhite} />
            ) : (
              <Text style={{ fontFamily: 'Poppins-SemiBold', fontSize: 16, color: '#fff' }} >Save</Text>
            )
          }
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}
