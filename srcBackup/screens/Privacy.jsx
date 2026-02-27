import React from 'react';
import { View, Text } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { WebView } from 'react-native-webview';

export default function Privacy({ navigation }) {
  const { theme } = useTheme();
  return (
    <View style={{ flex: 1, }}>
       <WebView
         style={{ flex:1 }}
         source={{ uri: 'https://www.google.com/' }}
       />
    </View>
  );
}
