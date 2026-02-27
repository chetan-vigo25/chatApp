import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Easing, Animated, Dimensions } from 'react-native';
import LottieView from 'lottie-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../contexts/ThemeContext';
import { APP_TAG_NAME } from '@env';

const { width, height } = Dimensions.get('window');

export default function Splash({ navigation }) {
    const { theme } = useTheme();
    const fadeAnim = useRef(new Animated.Value(0)).current;

    useEffect(() => {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }).start();
    
      const timer = setTimeout(() => {
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 2000,
          useNativeDriver: true,
        }).start(() => {
          navigation.navigate('UserAgree');
        });
      }, 3500);
    
      return () => clearTimeout(timer);
    }, [navigation]);


  return (
    <SafeAreaView style={{ flex: 1, justifyContent:'center', alignItems:'center', backgroundColor: theme.colors.background }}>
        <View style={{ }} >
            <LottieView style={{ width: 220, height: 220 }} source={require('../../assets/lottie/Chat.json')} autoPlay loop />
        </View>
        <View style={styles.versionContainer}>
          <Text style={{ fontFamily:'Poppins-Medium', fontSize: 12, color: theme.colors.primaryTextColor, textAlign: 'center' }} > © 2026 {APP_TAG_NAME}</Text>
        </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
    versionContainer: {
      position: 'absolute',
      bottom: 30,
      left: '50%',
      right: '50%',
      transform: [{ translateX: -width * 0.25 }],
      width: width * 0.5,
      alignItems: 'center',
      justifyContent:'center',
    },
})