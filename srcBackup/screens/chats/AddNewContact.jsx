import React, { useState, useEffect, useRef } from "react";
import { View, Text, ScrollView, Animated, TouchableOpacity, Image, ActivityIndicator, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../../contexts/ThemeContext";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { TextInput } from 'react-native-paper';
import countryCodes from '../../jsonFile/countryCodes.json';
import CountryCodeContact from "../../components/CountryCodeContact";
import { getSocket, isSocketConnected, reconnectSocket } from "../../Redux/Services/Socket/socket";
import { APP_TAG_NAME } from '@env';
import { FontAwesome6 } from '@expo/vector-icons';

// ============================================
// 🎯 DEBOUNCE DELAY CONFIGURATION (in milliseconds)
// ============================================
const DEBOUNCE_DELAY = 500;
const MIN_SEARCH_LENGTH = 5;

export default function AddNewContact({ navigation }) {
    const { theme } = useTheme();
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const [phoneNumber, setPhoneNumber] = useState('');
    const [focusedInput, setFocusedInput] = useState(null);
    const [selectedCountry, setSelectedCountry] = useState(countryCodes[0]);
    const [isSearching, setIsSearching] = useState(false);
    const [searchResult, setSearchResult] = useState(null);
    const socketRef = useRef(null);
    const searchTimeoutRef = useRef(null);
    const isSocketListenerActive = useRef(false);
    const pendingUserDataRef = useRef(null); // Add this to store user data persistently

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

    const handleCountrySelect = (country) => {
      setSelectedCountry(country);
    };

    const handleClearPhoneNumber = () => {
      console.log('🗑️ Clearing phone number and search results');
      setPhoneNumber('');
      setSearchResult(null);
      pendingUserDataRef.current = null; // Clear stored user data
      setIsSearching(false);
      
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = null;
      }
      
      if (socketRef.current) {
        removeSocketListeners(socketRef.current);
      }
    };

    const initializeSocket = async () => {
      try {
        const socket = getSocket();
        
        if (!socket) {
          console.error('❌ Socket not initialized');
          return null;
        }

        if (!isSocketConnected()) {
          console.log('🔄 Socket not connected, re-authenticating...');
          await reconnectSocket(navigation);
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          const reconnectedSocket = getSocket();
          if (!reconnectedSocket || !isSocketConnected()) {
            console.error('❌ Failed to reconnect socket');
            return null;
          }
        }
        
        socketRef.current = socket;
        return socket;
      } catch (error) {
        console.error('❌ Error initializing socket:', error);
        return null;
      }
    }

    const setupSocketListeners = (socket) => {
        if (isSocketListenerActive.current) {
          console.log('⚠️ Socket listeners already active');
          return;
        }

        console.log('🎧 Setting up socket listeners for contact search');
        
        socket.on('searchuserbymobile:response', (response) => {
          console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          console.log("📥 SEARCH USER BY MOBILE RESPONSE");
          console.log("   Status:", response.status);
          console.log("   Data:", JSON.stringify(response.data, null, 2));
          console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          
          setIsSearching(false);
          
          if (response.status && response.data) {
            if (response.data.exists) {
              // Store user data in ref for persistence
              pendingUserDataRef.current = response.data.user;
              
              setSearchResult({
                found: true,
                user: response.data.user,
                message: response.data.message,
                chatId: response.data.chatId,
                hasExistingChat: response.data.hasExistingChat,
                isContact: response.data.isContact
              });
            } else {
              pendingUserDataRef.current = null;
              setSearchResult({
                found: false,
                message: 'User not found'
              });
            }
          } else {
            pendingUserDataRef.current = null;
            setSearchResult({
              found: false,
              message: response?.message || 'User not found'
            });
          }
        });

        socket.on('createchat:response', (response) => {
          console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          console.log("📥 CREATE CHAT RESPONSE");
          console.log("   Response:", JSON.stringify(response, null, 2));
          console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          
          if (response.status && response.data) {
            console.log("✅ Chat created successfully, navigating to ChatScreen");
            
            // Use the stored user data from ref
            const userData = pendingUserDataRef.current;
            
            if (!userData) {
              console.error("❌ No user data found in ref");
              Alert.alert('Error', 'User data not found. Please search again.');
              return;
            }
            
            const chatData = response.data;
            const chatId = chatData.chatId || chatData._id;
            
            const userToPass = {
              _id: userData._id,
              fullName: userData.fullName || userData.name || '',
              profileImage: userData.profileImage || userData.profilePicture || '',
              mobileNumber: userData.mobileNumber || userData.phone || '',
              countryCode: userData.countryCode || selectedCountry.code,
              email: userData.email || '',
              userName: userData.userName || userData.username || ''
            };
            
            console.log("📤 Navigating with user data:", JSON.stringify(userToPass, null, 2));
            
            // Clear stored data before navigation
            pendingUserDataRef.current = null;
            setSearchResult(null);
            
            navigation.replace('ChatScreen', {
              chatId: chatId,
              user: userToPass,
              isNewContact: true,
              hasExistingChat: false,
              chatData: chatData,
              isNewChat: true
            });
          } else {
            console.error("❌ Failed to create chat:", response.message);
            Alert.alert('Error', response.message || 'Failed to create chat');
          }
        });

        isSocketListenerActive.current = true;
    }

    useEffect(() => {
        initializeSocket().then(socket => {
          if (socket) {
            setupSocketListeners(socket);
          }
        });
        
        return () => {
          if (socketRef.current) {
            removeSocketListeners(socketRef.current);
          }
          if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
          }
        };
    }, []);

    const removeSocketListeners = (socket) => {
        if (!isSocketListenerActive.current || !socket) {
          return;
        }
        
        console.log("🔇 Removing socket listeners for contact search");
        socket.off('searchuserbymobile:response');
        socket.off('createchat:response');
        isSocketListenerActive.current = false;
    }; 

    const searchUserByPhone = async (phoneNum) => {
      if (phoneNum.length < MIN_SEARCH_LENGTH) {
        setSearchResult(null);
        pendingUserDataRef.current = null;
        setIsSearching(false);
        return;
      }
      
      setIsSearching(true);
      
      try {
        if (!isSocketConnected()) {
          console.log('🔄 Socket disconnected, re-authenticating before search...');
          await reconnectSocket(navigation);
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          if (!isSocketConnected()) {
            console.error('❌ Failed to reconnect socket');
            setIsSearching(false);
            setSearchResult({
              found: false,
              message: 'Connection error. Please try again.'
            });
            return;
          }
        }

        const socket = getSocket();
        if (!socket) {
          console.error('❌ Socket not available');
          setIsSearching(false);
          setSearchResult({
            found: false,
            message: 'Connection error. Please try again.'
          });
          return;
        }
        
        if (!isSocketListenerActive.current) {
          console.log('🔄 Re-setting up socket listeners...');
          setupSocketListeners(socket);
        }
        
        console.log(`📤 Searching for user with ${selectedCountry.code}${phoneNum}`);
        
        socket.emit('user:search:mobile', { 
          countryCode: selectedCountry.code,
          mobileNumber: phoneNum 
        }, (ackResponse) => {
          if (ackResponse) {
            console.log("✅ Search acknowledgment:", ackResponse);
          }
        });
        
      } catch (error) {
        console.error('❌ Error searching user:', error);
        setIsSearching(false);
        setSearchResult({
          found: false,
          message: 'Search failed. Please try again.'
        });
      }
    }

    const handleCreateChat = async (userId) => {
      try {
          console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          console.log("💬 CREATING CHAT");
          console.log("   User ID:", userId);
          console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          
          // Use the stored user data from ref instead of searchResult
          const userData = pendingUserDataRef.current;
          
          if (!userData) {
            console.error('❌ No user data found in ref');
            Alert.alert('Error', 'User data not found. Please search again.');
            return;
          }
          
          if (!isSocketConnected()) {
              console.log('🔄 Socket disconnected, re-authenticating before creating chat...');
              await reconnectSocket(navigation);
              await new Promise(resolve => setTimeout(resolve, 1000));
              
              if (!isSocketConnected()) {
                  console.error('❌ Failed to reconnect socket');
                  Alert.alert('Error', 'Connection error. Please try again.');
                  return;
              }
          }
          
          const socket = getSocket();
          
          if (!socket) {
              console.error('❌ Socket not available');
              Alert.alert('Error', 'Connection error. Please try again.');
              return;
          }
          
          if (!isSocketListenerActive.current) {
            setupSocketListeners(socket);
          }
          
          socket.emit('chat:create', { 
              userId: userId 
          }, (ackResponse) => {
              console.log("📥 CHAT CREATE ACKNOWLEDGMENT:", ackResponse);
              
              if (ackResponse && ackResponse.error) {
                console.error("❌ Chat create acknowledgment error:", ackResponse.error);
                Alert.alert('Error', ackResponse.error || 'Failed to create chat');
              }
          });
          
      } catch (error) {
          console.error('❌ Error creating chat:', error);
          Alert.alert('Error', 'Failed to create chat. Please try again.');
      }
  };
    
    const handleAddContact = () => {
      // First check if we have searchResult
      if (!searchResult) {
        console.log('❌ No search result found');
        Alert.alert('Error', 'Please search for a contact first');
        return;
      }
      
      if (!searchResult.found) {
        console.log('❌ User not found in search result');
        Alert.alert('Error', 'User not found');
        return;
      }
      
      // Check if we have user data in searchResult
      if (!searchResult.user) {
        console.log('❌ No user data in search result');
        Alert.alert('Error', 'User data not found. Please search again.');
        return;
      }
      
      // Store user data in ref for persistence
      pendingUserDataRef.current = searchResult.user;
      
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("📱 ADDING CONTACT");
      console.log("   User:", searchResult.user?.fullName || searchResult.user?.name);
      console.log("   User ID:", searchResult.user?._id);
      console.log("   Chat ID:", searchResult.chatId);
      console.log("   Has Existing Chat:", searchResult.hasExistingChat);
      console.log("   Is Contact:", searchResult.isContact);
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      
      // If chat already exists, navigate directly
      if (searchResult.hasExistingChat && searchResult.chatId) {
          console.log("✅ Chat already exists, navigating to existing chat");
          
          const userToPass = {
              _id: searchResult.user._id,
              fullName: searchResult.user.fullName || searchResult.user.name,
              profileImage: searchResult.user.profileImage || searchResult.user.profilePicture,
              mobileNumber: searchResult.user.mobileNumber || searchResult.user.phone,
              countryCode: searchResult.user.countryCode || selectedCountry.code,
              email: searchResult.user.email || '',
              userName: searchResult.user.userName || searchResult.user.username
          };
          
          // Clear stored data before navigation
          pendingUserDataRef.current = null;
          
          navigation.replace('ChatScreen', { 
              chatId: searchResult.chatId,
              user: userToPass,
              isNewContact: !searchResult.isContact,
              hasExistingChat: true
          });
      } else {
          // Create new chat and navigate
          console.log("🆕 Creating new chat...");
          handleCreateChat(searchResult.user._id);
      }
  };

    const handlePhoneNumberChange = (text) => {
      console.log(`⌨️ User typing: "${text}" (Length: ${text.length})`);
      
      setPhoneNumber(text);
      
      if (searchResult !== null) {
        console.log('🗑️ Clearing previous search result');
        setSearchResult(null);
        pendingUserDataRef.current = null;
      }
      
      if (searchTimeoutRef.current) {
        console.log('⏱️ Clearing previous debounce timer');
        clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = null;
      }

      if (text.length >= MIN_SEARCH_LENGTH) {
        console.log(`⏰ Setting debounce timer (${DEBOUNCE_DELAY}ms)...`);
        
        searchTimeoutRef.current = setTimeout(() => {
          console.log('✅ Debounce timer completed - Executing search!');
          searchUserByPhone(text);
        }, DEBOUNCE_DELAY);
      } else {
        console.log('⚠️ Less than minimum digits, not searching');
        setIsSearching(false);
        setSearchResult(null);
        pendingUserDataRef.current = null;
      }
    }

    useEffect(() => {
      if (phoneNumber.length >= MIN_SEARCH_LENGTH) {
        console.log('🌍 Country code changed, triggering debounced search...');
        
        setSearchResult(null);
        pendingUserDataRef.current = null;
        
        if (searchTimeoutRef.current) {
          clearTimeout(searchTimeoutRef.current);
        }
        
        searchTimeoutRef.current = setTimeout(() => {
          console.log('✅ Country code debounce completed - Executing search!');
          searchUserByPhone(phoneNumber);
        }, DEBOUNCE_DELAY);
      }
      
      return () => {
        if (searchTimeoutRef.current) {
          clearTimeout(searchTimeoutRef.current);
        }
      };
    }, [selectedCountry]);

    return(
       <Animated.View style={{ flex: 1, opacity: fadeAnim, backgroundColor: theme.colors.background }} >
         <View style={{ width:'100%', flexDirection:'row', gap:10, alignItems:'center', padding:10, borderBottomWidth:1, borderBottomColor:theme.colors.borderColor }} >
           <TouchableOpacity onPress={() => navigation.goBack()} style={{ width:40, height:40, alignItems:'center', justifyContent:'center', }} >
              <FontAwesome6 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
           </TouchableOpacity>
           <View style={{ flex:1 }} >
               <Text style={{ color:theme.colors.primaryTextColor, fontFamily:'Poppins-Medium', fontSize:16, textTransform:'capitalize' }} >New Contact</Text>
           </View>
         </View>
         <ScrollView style={{ flex:1, padding:20 }} >
         <View style={{ width:'100%', gap:10, flexDirection:"row" }} >
            <TouchableOpacity onPress={handleCountrySelect} style={{ width:60, height:52, marginTop:5, justifyContent:"center", alignItems:"center", borderWidth:1.5, borderColor:theme.colors.themeColor, borderRadius:6 }} >
              <CountryCodeContact
                selectedCountry={selectedCountry}
                onCountrySelect={handleCountrySelect}
                showFlag={true}
                showCode={true}
                showName={false}
              />
            </TouchableOpacity>
            <View style={{ flex:1 }} >
              <TextInput
                mode="outlined"
                label="Phone"
                value={phoneNumber}
                maxLength={10}
                keyboardType="phone-pad"
                onChangeText={handlePhoneNumberChange}
                activeOutlineColor={ theme.colors.themeColor }
                outlineColor={ theme.colors.themeColor }
                right={
                    isSearching ? (
                      <TextInput.Icon
                        icon={() => <ActivityIndicator size={20} color={theme.colors.themeColor} />}
                      />
                    ) : searchResult && searchResult.found && phoneNumber.length >= MIN_SEARCH_LENGTH ? (
                      <TextInput.Icon
                        icon={'check-circle'}
                        color={'#25D366'}
                        onPress={handleClearPhoneNumber}
                      />
                    ) : searchResult && !searchResult.found && phoneNumber.length >= MIN_SEARCH_LENGTH ? (
                      <TextInput.Icon
                        icon={'close-circle'}
                        color={'#FF3B30'}
                        onPress={handleClearPhoneNumber}
                      />
                    ) : phoneNumber.length > 0 ? (
                      <TextInput.Icon
                        icon={'close-circle'}
                        color={theme.colors.secondaryTextColor}
                        onPress={handleClearPhoneNumber}
                      />
                    ) : null
                  }
              />
            </View>
         </View>

         {/* Display search result - User Found */}
         {searchResult && searchResult.found && phoneNumber.length >= MIN_SEARCH_LENGTH && !isSearching && (
           <View style={{ marginTop: 20 }}>
             <View style={{ flex: 1 }}>
               <Text style={{ color: theme.colors.placeHolderTextColor, fontFamily: 'Poppins-Medium', fontSize: 14, marginTop: 2 }}>
                 This phone number is on {APP_TAG_NAME}.
               </Text>
             </View>
             <View style={{ alignSelf:'flex-start', marginTop: 8 }}>
               <Text style={{ color: theme.colors.themeColor, fontFamily: 'Poppins-SemiBold', fontSize: 14 }}>
                 View Contact →
               </Text>
             </View>

             {/* Show user info preview */}
             <TouchableOpacity onPress={handleAddContact} style={{ 
               marginTop: 16, 
               padding: 12, 
               backgroundColor: theme.colors.cardBackground, 
               borderRadius: 8,
               borderWidth: 1,
               borderColor: theme.colors.borderColor
             }}>
               <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                 {searchResult.user?.profileImage || searchResult.user?.profilePicture ? (
                   <Image 
                     source={{ uri: searchResult.user.profileImage || searchResult.user.profilePicture }}
                     style={{ width: 40, height: 40, borderRadius: 20 }}
                   />
                 ) : (
                   <View style={{ 
                     width: 40, 
                     height: 40, 
                     borderRadius: 20, 
                     backgroundColor: theme.colors.themeColor,
                     justifyContent: 'center',
                     alignItems: 'center'
                   }}>
                     <Text style={{ color: '#fff', fontSize: 18, fontFamily: 'Poppins-Medium' }}>
                       {(searchResult.user?.fullName || searchResult.user?.name || 'U').charAt(0).toUpperCase()}
                     </Text>
                   </View>
                 )}
                 <View style={{ marginLeft: 12 }}>
                   <Text style={{ color: theme.colors.primaryTextColor, fontFamily: 'Poppins-Medium', fontSize: 16 }}>
                     {searchResult.user?.fullName || searchResult.user?.name || 'User'}
                   </Text>
                   <Text style={{ color: theme.colors.placeHolderTextColor, fontFamily: 'Poppins-Regular', fontSize: 12 }}>
                     {selectedCountry.code} {phoneNumber}
                   </Text>
                 </View>
               </View>
             </TouchableOpacity>
           </View>
         )}

         {/* Display search result - User Not Found */}
         {searchResult && !searchResult.found && phoneNumber.length >= MIN_SEARCH_LENGTH && !isSearching && (
           <View style={{ marginTop: 20 }}>
             <View style={{ flex: 1 }}>
               <Text style={{ color: theme.colors.placeHolderTextColor, fontFamily: 'Poppins-Medium', fontSize: 14, marginTop: 2 }}>
                 This phone number is not on {APP_TAG_NAME}.
               </Text>
             </View>
           </View>
         )}
         </ScrollView>
       </Animated.View>
    )
}