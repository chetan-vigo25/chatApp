import React from 'react';
import { View, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { WebView } from 'react-native-webview';
import { WEB_URL } from '@env'
import { FontAwesome6 } from '@expo/vector-icons'

export default function Privacy({ navigation }) {
  const { theme } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={{ flexDirection:'row', alignItems:'center', gap:10 }} >
        <TouchableOpacity onPress={()=> navigation.goBack()} style={{ width:40, height:40, justifyContent:'center', alignItems:'center' }} >
          <FontAwesome6 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
        <Text style={{ color: theme.colors.primaryTextColor, fontSize:16, fontFamily:'Roboto-Regular' }} >Privacy</Text>
      </View>
      <WebView
        source={{ uri: `${WEB_URL}/webview/privacy-policy` }}
        style={{ flex:1 }}
        startInLoadingState={true}  // shows a loader while loading
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  webview: {
    flex: 1,
  },
});
