import React, { useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, ScrollView, TouchableOpacity, Animated, Image, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../../contexts/ThemeContext';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { FontAwesome6, Entypo } from '@expo/vector-icons';

export default function ChatColorTheme({ navigation }) {
    const { theme, updateChatColor, chatColor } = useTheme();
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const [selectedColor, setSelectedColor] = useState(null);

    useEffect(() => {
      const loadSavedColor = async () => {
        try {
          const savedColor = await AsyncStorage.getItem('selectedColor');
          if (savedColor) {
            setSelectedColor(savedColor);
            updateChatColor(savedColor);
          } else {
            // No saved color? Use default theme color
            setSelectedColor(theme.colors.themeColor);
            updateChatColor(theme.colors.themeColor);
          }
        } catch (error) {
          console.error('Error loading saved color:', error);
          setSelectedColor(theme.colors.themeColor);
          updateChatColor(theme.colors.themeColor);
        }
      };
    
      loadSavedColor();
    }, []);

    const colors = [ "#34B7F1", "#128C7E", "#075E54", "#25D366", "#1DB954", "#833AB4", "#777737", "#F56040", "#107C10", "#FF5A5F", "#3A3A3A", "#FF0000", "#00A699", "#484848", "#767676" ];

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

    const handleColorSelect = async (color) => {
      setSelectedColor(color);

      try {
          await AsyncStorage.setItem('selectedColor', color);  // Store selected color
          updateChatColor(color);  // Optionally, update the theme in context
      } catch (error) {
          console.error("Error saving color to AsyncStorage:", error);
      }
  };

    return (
        <Animated.View style={{ flex: 1, opacity: fadeAnim }} >
            <View style={{ flex:1, backgroundColor:theme.colors.background }} >
              <View style={{ width:'100%', flexDirection:'row', gap:20, borderBottomWidth:.5, borderBottomColor:theme.colors.borderColor, padding:10,}} >
                  <TouchableOpacity onPress={() => navigation.goBack()} style={{ width:30, height:30, justifyContent:'center', alignItems:'flex-end' }} >
                    <FontAwesome6 name="arrow-left" size={20} color={ theme.colors.primaryTextColor } />
                  </TouchableOpacity>
                  <View style={{ flex:1, alignItems:'flex-start', justifyContent:'center' }} >
                      <Text style={{ fontFamily:'Poppins-SemiBold', fontSize:16, color:theme.colors.primaryTextColor }} >Chat Color</Text>
                  </View>
              </View>
              <ScrollView showsVerticalScrollIndicator={false} style={{ flex:1, padding:20 }} >
                <View style={{ flexDirection:'row', gap:10, flexWrap:'wrap', justifyContent:"flex-start", alignItems:'center', }} >
                  {/* <View style={{ width:80, height:120, borderRadius:5, borderColor:theme.colors.borderColor, borderWidth:1, justifyContent:'center', alignItems:'center' }} ></View> */}
                  {
                     colors.map((color, index) => {
                         const isSelected = selectedColor === color;
                         return (
                            <TouchableOpacity onPress={() => handleColorSelect(color)} key={index} style={{ width:75, height:100, borderRadius:5, backgroundColor:theme.colors.background, borderColor:theme.colors.borderColor, borderWidth:1, justifyContent:'center', alignItems:'center' }} >
                              <View style={{ width:40, height:15, borderRadius:2, backgroundColor:theme.colors.menuBackground, marginRight:10  }} ></View>
                              <View style={{ width:40, height:15, borderRadius:2, backgroundColor:color, marginLeft:10, marginTop:5 }} ></View>
                              <View style={{ width:75, height:100, borderRadius:2, position:'absolute',  borderRadius:5, borderColor:isSelected ? theme.colors.primaryTextColor : theme.colors.borderColor, borderWidth:1, justifyContent:'center', alignItems:'center' }} >
                                {isSelected && (
                                  <Entypo name="check" size={25} color={theme.colors.primaryTextColor} />
                                )}
                              </View>
                            </TouchableOpacity>
                         )
                     })
                  }
                </View>
              </ScrollView>
            </View>
        </Animated.View>
    );
}