import React, { useEffect, useState, useRef } from 'react';
import { View, Text, ActivityIndicator, Image, Animated, Pressable, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../contexts/ThemeContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance } from "react-native";

import { APP_TAG_NAME } from '@env'; 

import { useContacts } from '../contexts/ContactContext';

export default function UserAgree({ navigation }) {
  const { theme, isDarkMode, toggleTheme } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const { askPermissionAndLoadContacts, permissionStatus, contacts } = useContacts();

  useEffect(() => {
    const timer = setTimeout(() => {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }).start();
    }, 800);

    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    askPermissionAndLoadContacts();
  }, []);

  return (
    <Animated.View style={{ flex: 1, opacity: fadeAnim,}}>
      <View style={{ flex: 1, alignItems: 'center', backgroundColor: theme.colors.background, }}>
        <View style={{ width:250, height:250, borderRadius:150, marginTop:80, }} >
          <Image resizeMode="cover" source={require('../../assets/images/sticker.png')} style={{ width: '100%', height: '100%', borderRadius: 150, overflow: 'hidden' }}/>
        </View>
        <View style={{ marginVertical: 24 }} >
          <Text style={{ fontFamily: 'Poppins-SemiBold', fontSize: 22, color: theme.colors.primaryTextColor }} >Welcome to {APP_TAG_NAME}</Text>
        </View>
        <View style={{ marginBottom: 40, alignItems:'center',}} >
          <View flexDirection="row" style={{ alignItems:'center',}} >
            <Text style={{ fontFamily: 'Roboto-Medium', fontSize: 14, color: theme.colors.placeHolderTextColor }} >Read our</Text>
            <Text onPress={() => navigation.navigate('Privacy')} style={{ fontFamily: 'Roboto-Medium', fontSize: 14, color: theme.colors.themeColor }} > Privacy Policy</Text>
            <Text style={{ fontFamily: 'Roboto-Medium', fontSize: 14, color: theme.colors.placeHolderTextColor }} >. Tap 'Agree and Continue' to</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems:'center',}} >
          <Text style={{ fontFamily: 'Roboto-Medium', fontSize: 14, color: theme.colors.placeHolderTextColor }} >accept the</Text>
            <Text onPress={() => navigation.navigate('Term')} style={{ fontFamily: 'Roboto-Medium', fontSize: 14, color: theme.colors.themeColor }} > Terms of Service</Text>
            <Text style={{ fontFamily: 'Roboto-Medium', fontSize: 14, color: theme.colors.placeHolderTextColor }} >.</Text>
          </View>
        </View>
        <TouchableOpacity onPress={() => navigation.navigate('Login')} style={{ width:'80%', height:50, backgroundColor: theme.colors.themeColor, borderRadius:8, alignItems:'center', justifyContent:'center', }} >
          <Text style={{ fontFamily: 'Poppins-Medium', fontSize: 16, color: theme.colors.textWhite, }} >AGREE AND CONTINUE</Text>
        </TouchableOpacity>
        {/* <Pressable
          onPress={toggleTheme}
          style={{
              paddingVertical: 12,
              paddingHorizontal: 24,
              borderRadius: 8,
              backgroundColor: theme.colors.background,
          }}
          >
          <Text style={{ color: theme.colors.primaryTextColor, fontSize: 16, }} >
            {isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          </Text>
        </Pressable> */}
      </View>
    </Animated.View>
  );
}

