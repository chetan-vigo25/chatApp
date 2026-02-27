import React from 'react';
import { View, Text, StatusBar, StyleSheet, Button } from 'react-native';
import LottieView from 'lottie-react-native';
import { useTheme } from '../contexts/ThemeContext';

import { MaterialIcons } from '@expo/vector-icons';

export default function NoInternetScreen({ onRetry, isRetrying }) {
    const { theme } = useTheme();
  return (
    <View style={{ flex:1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.colors.background }}>
      <Text style={styles.title}>Ooops!</Text>
      {/* <MaterialIcons name="wifi-off" size={80} color="gray" /> */}
      <LottieView source={require('../../assets/lottie/NoInternet.json')} autoPlay loop style={{ width: 200, height: 200 }} />
      <Text style={{ fontSize: 18, color: 'gray', fontFamily:'Poppins-Medium' }}>You are currently offline.</Text>
      <Text style={{ fontSize: 14, color: 'gray', fontFamily:'Poppins-Medium' }}>No Internet connection found.</Text>
      <Text style={styles.subtitle}>Please check your Internet connection.</Text>
      {/* <Button title={isRetrying ? "Checking..." : "Try Again"} onPress={onRetry} disabled={isRetrying} /> */}
    </View>
  );
}

const styles = StyleSheet.create({
  title: {
    fontSize: 24, marginBottom: 10, fontFamily:'Poppins-Bold', color: 'gray'
  },
  subtitle: {
    fontSize: 14, color: 'gray', marginBottom: 20, fontFamily:'Poppins-Medium'
  }
});