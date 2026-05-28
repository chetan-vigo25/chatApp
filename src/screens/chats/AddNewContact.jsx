import React, { useState, useEffect, useRef } from "react";
import { View, Text, ScrollView, Animated, TouchableOpacity, Image, ActivityIndicator, Alert, StyleSheet, Dimensions } from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { TextInput } from 'react-native-paper';
import countryCodes from '../../jsonFile/countryCodes.json';
import CountryCodeContact from "../../components/CountryCodeContact";
import { getSocket, isSocketConnected, reconnectSocket } from "../../Redux/Services/Socket/socket";
import { APP_TAG_NAME } from '@env';
import { FontAwesome6, Ionicons } from '@expo/vector-icons';

const { width: SCREEN_W } = Dimensions.get('window');

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
    const socketHandlersRef = useRef({
      onSearchResponse: null,
      onChatCreateResponse: null,
    });

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

    const handleBack = () => {
      if (navigation?.canGoBack?.()) {
        navigation.goBack();
        return;
      }

      navigation?.navigate?.('ChatList');
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
        
        const onSearchResponse = (response) => {
          // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          // console.log("📥 SEARCH USER BY MOBILE RESPONSE");
          // console.log("   Status:", response.status);
          // console.log("   Data:", JSON.stringify(response.data, null, 2));
          // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          
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
        };
        socketHandlersRef.current.onSearchResponse = onSearchResponse;
        socket.on('user:search:mobile:response', onSearchResponse);

        const onChatCreateResponse = (response) => {
          // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          // console.log("📥 CREATE CHAT RESPONSE");
          // console.log("   Response:", JSON.stringify(response, null, 2));
          // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          
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
            
            const mobileCode = userData.mobile?.code || userData.countryCode || selectedCountry.code;
            const mobileNum  = userData.mobile?.number || userData.mobileNumber || userData.phone || phoneNumber;
            const userToPass = {
              _id: userData._id,
              fullName: userData.fullName || userData.name || '',
              profileImage: userData.profileImage || userData.profilePicture || '',
              mobileNumber: mobileNum,
              countryCode: mobileCode,
              mobile: { code: mobileCode, number: mobileNum },
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
        };
        socketHandlersRef.current.onChatCreateResponse = onChatCreateResponse;
        socket.on('chat:create:response', onChatCreateResponse);

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
        if (socketHandlersRef.current.onSearchResponse) {
          socket.off('user:search:mobile:response', socketHandlersRef.current.onSearchResponse);
        }
        if (socketHandlersRef.current.onChatCreateResponse) {
          socket.off('chat:create:response', socketHandlersRef.current.onChatCreateResponse);
        }
        socketHandlersRef.current.onSearchResponse = null;
        socketHandlersRef.current.onChatCreateResponse = null;
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
          // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          // console.log("💬 CREATING CHAT");
          // console.log("   User ID:", userId);
          // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          
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
      
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      // console.log("📱 ADDING CONTACT");
      // console.log("   User:", searchResult.user?.fullName || searchResult.user?.name);
      // console.log("   User ID:", searchResult.user?._id);
      // console.log("   Chat ID:", searchResult.chatId);
      // console.log("   Has Existing Chat:", searchResult.hasExistingChat);
      // console.log("   Is Contact:", searchResult.isContact);
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      
      // If chat already exists, navigate directly
      if (searchResult.hasExistingChat && searchResult.chatId) {
          console.log("✅ Chat already exists, navigating to existing chat");

          // Always navigate to the *exact* searched user.
          // Prefer pendingUserDataRef (set on search response) so a stale
          // searchResult never points us at a different user.
          const exactUser = pendingUserDataRef.current || searchResult.user;
          const mobileCode = exactUser.mobile?.code || exactUser.countryCode || selectedCountry.code;
          const mobileNum  = exactUser.mobile?.number || exactUser.mobileNumber || exactUser.phone || phoneNumber;

          const userToPass = {
              _id: exactUser._id,
              fullName: exactUser.fullName || exactUser.name || '',
              profileImage: exactUser.profileImage || exactUser.profilePicture || '',
              mobileNumber: mobileNum,
              countryCode: mobileCode,
              mobile: { code: mobileCode, number: mobileNum },
              email: exactUser.email || '',
              userName: exactUser.userName || exactUser.username || '',
          };

          // Clear stored data before navigation
          pendingUserDataRef.current = null;

          navigation.replace('ChatScreen', {
              chatId: searchResult.chatId,
              user: userToPass,
              peerUserId: exactUser._id,
              isNewContact: !searchResult.isContact,
              hasExistingChat: true,
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

    const themeColor = theme.colors.themeColor;
    const primaryText = theme.colors.primaryTextColor;
    const subText = theme.colors.placeHolderTextColor;
    const pageBg = theme.colors.background;
    const cardBg = theme.colors.cardBackground || theme.colors.menuBackground;

    const userFound = !!(searchResult && searchResult.found && phoneNumber.length >= MIN_SEARCH_LENGTH && !isSearching);
    const userNotFound = !!(searchResult && !searchResult.found && phoneNumber.length >= MIN_SEARCH_LENGTH && !isSearching);
    const userDisplayName = searchResult?.user?.fullName || searchResult?.user?.name || 'User';
    const userAvatar = searchResult?.user?.profileImage || searchResult?.user?.profilePicture;

    return (
      <Animated.View style={[styles.root, { opacity: fadeAnim, backgroundColor: pageBg }]}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={handleBack}
            activeOpacity={0.6}
            style={[styles.headerBackBtn, { backgroundColor: cardBg }]}
          >
            <FontAwesome6 name="arrow-left" size={18} color={primaryText} />
          </TouchableOpacity>
          <View style={styles.headerTitleWrap}>
            <Text style={[styles.headerTitle, { color: primaryText }]}>New Contact</Text>
            <Text style={[styles.headerSubtitle, { color: subText }]}>
              Search by phone number
            </Text>
          </View>
        </View>

        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Hero halo + illustration */}
          <View style={styles.illustrationWrap}>
            <View style={[styles.illHalo, { backgroundColor: themeColor + '14' }]} />
            <View style={[styles.illHalo2, { backgroundColor: themeColor + '08' }]} />
            <View style={[styles.illIcon, { backgroundColor: themeColor + '18', borderColor: themeColor + '30' }]}>
              <Ionicons name="person-add-outline" size={36} color={themeColor} />
            </View>
            <Text style={[styles.illTitle, { color: primaryText }]}>
              Add a new contact
            </Text>
            <Text style={[styles.illSubtitle, { color: subText }]}>
              Enter their {APP_TAG_NAME} registered number to start chatting.
            </Text>
          </View>

          {/* Input row */}
          <View style={styles.inputRow}>
            <TouchableOpacity
              activeOpacity={0.75}
              style={[styles.countryBtn, { borderColor: themeColor, backgroundColor: cardBg }]}
            >
              <CountryCodeContact
                selectedCountry={selectedCountry}
                onCountrySelect={handleCountrySelect}
                showFlag={true}
                showCode={true}
                showName={false}
              />
            </TouchableOpacity>
            <View style={styles.flex}>
              <TextInput
                mode="outlined"
                label="Phone"
                value={phoneNumber}
                maxLength={10}
                keyboardType="phone-pad"
                onChangeText={handlePhoneNumberChange}
                activeOutlineColor={themeColor}
                outlineColor={themeColor + '60'}
                textColor={primaryText}
                outlineStyle={styles.paperOutline}
                style={styles.paperInput}
                theme={{
                  colors: {
                    background: pageBg,
                    surfaceVariant: 'transparent',
                    onSurfaceVariant: subText,
                  },
                }}
                right={
                  isSearching ? (
                    <TextInput.Icon
                      icon={() => <ActivityIndicator size={20} color={themeColor} />}
                    />
                  ) : userFound ? (
                    <TextInput.Icon icon={'check-circle'} color={'#25D366'} onPress={handleClearPhoneNumber} />
                  ) : userNotFound ? (
                    <TextInput.Icon icon={'close-circle'} color={'#FF3B30'} onPress={handleClearPhoneNumber} />
                  ) : phoneNumber.length > 0 ? (
                    <TextInput.Icon icon={'close-circle'} color={subText} onPress={handleClearPhoneNumber} />
                  ) : null
                }
              />
            </View>
          </View>

          {/* Status pill */}
          {phoneNumber.length > 0 && phoneNumber.length < MIN_SEARCH_LENGTH && (
            <View style={[styles.statusPill, { backgroundColor: themeColor + '12' }]}>
              <Ionicons name="information-circle" size={14} color={themeColor} />
              <Text style={[styles.statusPillText, { color: themeColor }]}>
                Enter at least {MIN_SEARCH_LENGTH} digits to search
              </Text>
            </View>
          )}

          {/* User Found card */}
          {userFound && (
            <View style={styles.resultWrap}>
              <View style={styles.resultHeader}>
                <View style={styles.resultStatusDot} />
                <Text style={[styles.resultStatusText, { color: subText }]}>
                  Found on {APP_TAG_NAME}
                </Text>
              </View>

              <TouchableOpacity
                onPress={handleAddContact}
                activeOpacity={0.85}
                style={[styles.userCard, { backgroundColor: cardBg }]}
              >
                <View style={[styles.userAvatarRing, { borderColor: themeColor + '30' }]}>
                  {userAvatar ? (
                    <Image source={{ uri: userAvatar }} style={styles.userAvatar} />
                  ) : (
                    <View style={[styles.userAvatar, styles.userAvatarFallback, { backgroundColor: themeColor }]}>
                      <Text style={styles.userAvatarLetter}>
                        {userDisplayName.charAt(0).toUpperCase()}
                      </Text>
                    </View>
                  )}
                </View>
                <View style={styles.flex}>
                  <Text style={[styles.userName, { color: primaryText }]} numberOfLines={1}>
                    {userDisplayName}
                  </Text>
                  <Text style={[styles.userPhone, { color: subText }]} numberOfLines={1}>
                    {selectedCountry.code} {phoneNumber}
                  </Text>
                </View>
                <View style={[styles.userCta, { backgroundColor: themeColor }]}>
                  <Ionicons name="chatbubble-ellipses-outline" size={18} color="#fff" />
                </View>
              </TouchableOpacity>

              <Text style={[styles.resultHint, { color: subText }]}>
                Tap to open a new conversation.
              </Text>
            </View>
          )}

          {/* Not found state */}
          {userNotFound && (
            <View style={styles.notFoundWrap}>
              <View style={[styles.notFoundIcon, { backgroundColor: '#FF3B3015' }]}>
                <Ionicons name="search" size={26} color="#FF3B30" />
              </View>
              <Text style={[styles.notFoundTitle, { color: primaryText }]}>
                Not on {APP_TAG_NAME}
              </Text>
              <Text style={[styles.notFoundSubtitle, { color: subText }]}>
                This phone number isn't registered yet. Double-check the country code and number, or invite them later.
              </Text>
            </View>
          )}
        </ScrollView>
      </Animated.View>
    );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingBottom: 40 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 12,
  },
  headerBackBtn: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitleWrap: { flex: 1 },
  headerTitle: {
    fontFamily: 'Roboto-Bold',
    fontSize: 20,
    letterSpacing: -0.3,
  },
  headerSubtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 2,
  },

  // Illustration
  illustrationWrap: {
    alignItems: 'center',
    paddingTop: 26,
    paddingBottom: 26,
    position: 'relative',
  },
  illHalo: {
    position: 'absolute', top: 4,
    width: 150, height: 150, borderRadius: 75,
  },
  illHalo2: {
    position: 'absolute', top: -16,
    width: 200, height: 200, borderRadius: 100,
  },
  illIcon: {
    width: 78, height: 78, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
    marginBottom: 16,
  },
  illTitle: {
    fontFamily: 'Roboto-Bold',
    fontSize: 18,
    letterSpacing: -0.2,
  },
  illSubtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 6,
    paddingHorizontal: 30,
    lineHeight: 18,
  },

  // Input
  inputRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    marginTop: 4,
  },
  countryBtn: {
    width: 64, height: 56,
    marginTop: 6,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 1.5,
    borderRadius: 14,
  },
  paperInput: { backgroundColor: 'transparent' },
  paperOutline: { borderRadius: 14, borderWidth: 1.5 },

  // Status pill
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    marginTop: 14,
  },
  statusPillText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 12,
  },

  // Result
  resultWrap: { marginTop: 22 },
  resultHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
    paddingHorizontal: 4,
  },
  resultStatusDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: '#25D366',
  },
  resultStatusText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 12,
    letterSpacing: 0.3,
  },
  userCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 14,
    borderRadius: 18,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 12,
    elevation: 2,
  },
  userAvatarRing: {
    width: 56, height: 56, borderRadius: 28,
    borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  userAvatar: {
    width: 48, height: 48, borderRadius: 24,
  },
  userAvatarFallback: {
    alignItems: 'center', justifyContent: 'center',
  },
  userAvatarLetter: {
    color: '#fff',
    fontFamily: 'Roboto-Bold',
    fontSize: 20,
  },
  userName: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 16,
    textTransform: 'capitalize',
  },
  userPhone: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    marginTop: 2,
  },
  userCta: {
    width: 44, height: 44, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  resultHint: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 10,
    marginLeft: 4,
  },

  // Not found
  notFoundWrap: {
    alignItems: 'center',
    paddingTop: 30,
    paddingHorizontal: 30,
  },
  notFoundIcon: {
    width: 64, height: 64, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 14,
  },
  notFoundTitle: {
    fontFamily: 'Roboto-Bold',
    fontSize: 17,
  },
  notFoundSubtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 19,
  },
});