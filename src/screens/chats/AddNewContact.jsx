import React, { useState, useEffect, useRef } from "react";
import {
  View, Text, ScrollView, Animated, TouchableOpacity, Image,
  ActivityIndicator, Alert, StyleSheet, TextInput, Platform, KeyboardAvoidingView,
} from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import countryCodes from '../../jsonFile/countryCodes.json';
import CountryCodeContact from "../../components/CountryCodeContact";
import { getSocket, isSocketConnected, reconnectSocket } from "../../Redux/Services/Socket/socket";
import { getPhoneRule, isPhoneValid, phoneLengthHint } from "../../utils/phoneValidation";
import { APP_TAG_NAME } from '@env';
import { Ionicons } from '@expo/vector-icons';

const DEBOUNCE_DELAY = 500;

export default function AddNewContact({ navigation }) {
    const { theme, isDarkMode } = useTheme();
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const [phoneNumber, setPhoneNumber] = useState('');
    const [phoneFocused, setPhoneFocused] = useState(false);
    const [selectedCountry, setSelectedCountry] = useState(countryCodes[0]);
    const [isSearching, setIsSearching] = useState(false);
    const [searchResult, setSearchResult] = useState(null);

    const socketRef = useRef(null);
    const searchTimeoutRef = useRef(null);
    const isSocketListenerActive = useRef(false);
    const pendingUserDataRef = useRef(null);
    const socketHandlersRef = useRef({ onSearchResponse: null, onChatCreateResponse: null });

    // Country-aware validation rules (min/max digits for the selected dial code).
    const phoneRule = getPhoneRule(selectedCountry?.code);
    const minLen = phoneRule.min;
    const maxLen = phoneRule.max;
    const isCompleteNumber = isPhoneValid(selectedCountry?.code, phoneNumber);

    useEffect(() => {
      const timer = setTimeout(() => {
        Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }).start();
      }, 400);
      return () => clearTimeout(timer);
    }, []);

    const handleCountrySelect = (country) => {
      setSelectedCountry(country);
      // Trim a now-too-long number when switching to a shorter-format country.
      const { max } = getPhoneRule(country?.code);
      setPhoneNumber((prev) => prev.slice(0, max));
    };

    const handleBack = () => {
      if (navigation?.canGoBack?.()) { navigation.goBack(); return; }
      navigation?.navigate?.('ChatList');
    };

    const handleClearPhoneNumber = () => {
      setPhoneNumber('');
      setSearchResult(null);
      pendingUserDataRef.current = null;
      setIsSearching(false);
      if (searchTimeoutRef.current) { clearTimeout(searchTimeoutRef.current); searchTimeoutRef.current = null; }
      if (socketRef.current) removeSocketListeners(socketRef.current);
    };

    const initializeSocket = async () => {
      try {
        const socket = getSocket();
        if (!socket) return null;
        if (!isSocketConnected()) {
          await reconnectSocket(navigation);
          await new Promise(resolve => setTimeout(resolve, 1000));
          const reconnectedSocket = getSocket();
          if (!reconnectedSocket || !isSocketConnected()) return null;
        }
        socketRef.current = socket;
        return socket;
      } catch (error) {
        return null;
      }
    };

    const setupSocketListeners = (socket) => {
        if (isSocketListenerActive.current) return;

        const onSearchResponse = (response) => {
          setIsSearching(false);
          if (response.status && response.data) {
            if (response.data.exists) {
              pendingUserDataRef.current = response.data.user;
              setSearchResult({
                found: true,
                user: response.data.user,
                message: response.data.message,
                chatId: response.data.chatId,
                hasExistingChat: response.data.hasExistingChat,
                isContact: response.data.isContact,
              });
            } else {
              pendingUserDataRef.current = null;
              setSearchResult({ found: false, message: 'User not found' });
            }
          } else {
            pendingUserDataRef.current = null;
            setSearchResult({ found: false, message: response?.message || 'User not found' });
          }
        };
        socketHandlersRef.current.onSearchResponse = onSearchResponse;
        socket.on('user:search:mobile:response', onSearchResponse);

        const onChatCreateResponse = (response) => {
          if (response.status && response.data) {
            const userData = pendingUserDataRef.current;
            if (!userData) {
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
              userName: userData.userName || userData.username || '',
            };
            pendingUserDataRef.current = null;
            setSearchResult(null);
            navigation.replace('ChatScreen', {
              chatId,
              user: userToPass,
              isNewContact: true,
              hasExistingChat: false,
              chatData,
              isNewChat: true,
            });
          } else {
            Alert.alert('Error', response.message || 'Failed to create chat');
          }
        };
        socketHandlersRef.current.onChatCreateResponse = onChatCreateResponse;
        socket.on('chat:create:response', onChatCreateResponse);

        isSocketListenerActive.current = true;
    };

    useEffect(() => {
        initializeSocket().then(socket => { if (socket) setupSocketListeners(socket); });
        return () => {
          if (socketRef.current) removeSocketListeners(socketRef.current);
          if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
        };
    }, []);

    const removeSocketListeners = (socket) => {
        if (!isSocketListenerActive.current || !socket) return;
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
      if (!isPhoneValid(selectedCountry?.code, phoneNum)) {
        setSearchResult(null);
        pendingUserDataRef.current = null;
        setIsSearching(false);
        return;
      }
      setIsSearching(true);
      try {
        if (!isSocketConnected()) {
          await reconnectSocket(navigation);
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (!isSocketConnected()) {
            setIsSearching(false);
            setSearchResult({ found: false, message: 'Connection error. Please try again.' });
            return;
          }
        }
        const socket = getSocket();
        if (!socket) {
          setIsSearching(false);
          setSearchResult({ found: false, message: 'Connection error. Please try again.' });
          return;
        }
        if (!isSocketListenerActive.current) setupSocketListeners(socket);
        socket.emit('user:search:mobile', {
          countryCode: selectedCountry.code,
          mobileNumber: phoneNum,
        }, () => {});
      } catch (error) {
        setIsSearching(false);
        setSearchResult({ found: false, message: 'Search failed. Please try again.' });
      }
    };

    const handleCreateChat = async (userId) => {
      try {
          const userData = pendingUserDataRef.current;
          if (!userData) {
            Alert.alert('Error', 'User data not found. Please search again.');
            return;
          }
          if (!isSocketConnected()) {
              await reconnectSocket(navigation);
              await new Promise(resolve => setTimeout(resolve, 1000));
              if (!isSocketConnected()) {
                  Alert.alert('Error', 'Connection error. Please try again.');
                  return;
              }
          }
          const socket = getSocket();
          if (!socket) {
              Alert.alert('Error', 'Connection error. Please try again.');
              return;
          }
          if (!isSocketListenerActive.current) setupSocketListeners(socket);
          socket.emit('chat:create', { userId }, (ackResponse) => {
              if (ackResponse && ackResponse.error) {
                Alert.alert('Error', ackResponse.error || 'Failed to create chat');
              }
          });
      } catch (error) {
          Alert.alert('Error', 'Failed to create chat. Please try again.');
      }
  };

    const handleAddContact = () => {
      if (!searchResult || !searchResult.found || !searchResult.user) {
        Alert.alert('Error', 'Please search for a valid contact first');
        return;
      }
      pendingUserDataRef.current = searchResult.user;

      if (searchResult.hasExistingChat && searchResult.chatId) {
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
          pendingUserDataRef.current = null;
          navigation.replace('ChatScreen', {
              chatId: searchResult.chatId,
              user: userToPass,
              peerUserId: exactUser._id,
              isNewContact: !searchResult.isContact,
              hasExistingChat: true,
          });
      } else {
          handleCreateChat(searchResult.user._id);
      }
  };

    const handlePhoneNumberChange = (text) => {
      const digits = text.replace(/[^0-9]/g, '').slice(0, maxLen);
      setPhoneNumber(digits);

      if (searchResult !== null) {
        setSearchResult(null);
        pendingUserDataRef.current = null;
      }
      if (searchTimeoutRef.current) { clearTimeout(searchTimeoutRef.current); searchTimeoutRef.current = null; }

      if (isPhoneValid(selectedCountry?.code, digits)) {
        searchTimeoutRef.current = setTimeout(() => { searchUserByPhone(digits); }, DEBOUNCE_DELAY);
      } else {
        setIsSearching(false);
        setSearchResult(null);
        pendingUserDataRef.current = null;
      }
    };

    useEffect(() => {
      if (isPhoneValid(selectedCountry?.code, phoneNumber)) {
        setSearchResult(null);
        pendingUserDataRef.current = null;
        if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = setTimeout(() => { searchUserByPhone(phoneNumber); }, DEBOUNCE_DELAY);
      }
      return () => { if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current); };
    }, [selectedCountry]);

    // WhatsApp palette
    const accent = isDarkMode ? '#00A884' : '#008069';
    const bg = isDarkMode ? '#0B141A' : '#FFFFFF';
    const primaryText = isDarkMode ? '#E9EDEF' : '#111B21';
    const secondaryText = isDarkMode ? '#8696A0' : '#54656F';
    const placeholderText = isDarkMode ? '#5E7280' : '#A6B0BD';
    const underlineIdle = isDarkMode ? '#2A3942' : '#D1D7DB';
    const cardBg = isDarkMode ? '#1F2C33' : '#F7F8FA';
    const errorColor = '#E5484D';

    const hasInput = phoneNumber.length > 0;
    const showLengthError = hasInput && !isCompleteNumber;
    const userFound = !!(searchResult && searchResult.found && isCompleteNumber && !isSearching);
    const userNotFound = !!(searchResult && !searchResult.found && isCompleteNumber && !isSearching);
    const userDisplayName = searchResult?.user?.fullName || searchResult?.user?.name || 'User';
    const userAvatar = searchResult?.user?.profileImage || searchResult?.user?.profilePicture;

    const phoneUnderline = showLengthError ? errorColor : (phoneFocused ? accent : underlineIdle);

    return (
      <Animated.View style={[styles.root, { opacity: fadeAnim, backgroundColor: bg }]}>
        {/* Top bar */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={handleBack}
            activeOpacity={0.6}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={styles.headerBackBtn}
          >
            <Ionicons name="arrow-back" size={24} color={primaryText} />
          </TouchableOpacity>
          <View style={styles.headerTitleWrap}>
            <Text style={[styles.headerTitle, { color: primaryText }]}>New contact</Text>
            <Text style={[styles.headerSubtitle, { color: secondaryText }]}>
              {selectedCountry?.name || 'Search by phone number'}
            </Text>
          </View>
        </View>

        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Icon + heading */}
            <View style={styles.illustrationWrap}>
              <View style={[styles.illIcon, { backgroundColor: accent + '18' }]}>
                <Ionicons name="person-add" size={32} color={accent} />
              </View>
              <Text style={[styles.illTitle, { color: primaryText }]}>Add a new contact</Text>
              <Text style={[styles.illSubtitle, { color: secondaryText }]}>
                Enter their phone number to start chatting on {String(APP_TAG_NAME || 'the app')}.
              </Text>
            </View>

            {/* Phone row — code chip + number, WhatsApp underline */}
            <View style={[styles.phoneRow, { borderBottomColor: phoneUnderline }]}>
              <View style={[styles.codeChip, { backgroundColor: cardBg }]}>
                <CountryCodeContact
                  selectedCountry={selectedCountry}
                  onCountrySelect={handleCountrySelect}
                  showFlag={true}
                  showCode={true}
                  showName={false}
                />
                <Ionicons name="chevron-down" size={14} color={secondaryText} style={styles.codeChevron} />
              </View>

              <TextInput
                style={[styles.phoneInput, { color: primaryText }]}
                placeholder="phone number"
                placeholderTextColor={placeholderText}
                value={phoneNumber}
                onChangeText={handlePhoneNumberChange}
                keyboardType="phone-pad"
                maxLength={maxLen}
                onFocus={() => setPhoneFocused(true)}
                onBlur={() => setPhoneFocused(false)}
              />

              {/* Trailing status icon */}
              {isSearching ? (
                <ActivityIndicator size="small" color={accent} style={styles.trailIcon} />
              ) : userFound ? (
                <Ionicons name="checkmark-circle" size={22} color="#25D366" style={styles.trailIcon} />
              ) : userNotFound ? (
                <TouchableOpacity onPress={handleClearPhoneNumber} style={styles.trailIcon}>
                  <Ionicons name="close-circle" size={22} color={errorColor} />
                </TouchableOpacity>
              ) : hasInput ? (
                <TouchableOpacity onPress={handleClearPhoneNumber} style={styles.trailIcon}>
                  <Ionicons name="close-circle" size={20} color={secondaryText} />
                </TouchableOpacity>
              ) : null}
            </View>

            {/* Validation / helper line (country-aware) */}
            <Text style={[styles.helperText, { color: showLengthError ? errorColor : secondaryText }]}>
              {showLengthError
                ? `${selectedCountry?.name || 'This country'} numbers are ${phoneLengthHint(selectedCountry?.code)}`
                : `Enter a ${phoneLengthHint(selectedCountry?.code)} ${selectedCountry?.name || ''} number`.trimEnd()}
            </Text>

            {/* User found card */}
            {userFound && (
              <View style={styles.resultWrap}>
                <View style={styles.resultHeader}>
                  <View style={styles.resultStatusDot} />
                  <Text style={[styles.resultStatusText, { color: secondaryText }]}>
                    On {String(APP_TAG_NAME || 'the app')}
                  </Text>
                </View>

                <TouchableOpacity
                  onPress={handleAddContact}
                  activeOpacity={0.85}
                  style={[styles.userCard, { backgroundColor: cardBg }]}
                >
                  <View style={[styles.userAvatarRing, { borderColor: accent + '40' }]}>
                    {userAvatar ? (
                      <Image source={{ uri: userAvatar }} style={styles.userAvatar} />
                    ) : (
                      <View style={[styles.userAvatar, styles.userAvatarFallback, { backgroundColor: accent }]}>
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
                    <Text style={[styles.userPhone, { color: secondaryText }]} numberOfLines={1}>
                      {selectedCountry.code} {phoneNumber}
                    </Text>
                  </View>
                  <View style={[styles.userCta, { backgroundColor: accent }]}>
                    <Ionicons name="chatbubble-ellipses" size={18} color="#fff" />
                  </View>
                </TouchableOpacity>

                <Text style={[styles.resultHint, { color: secondaryText }]}>
                  Tap to open a new conversation.
                </Text>
              </View>
            )}

            {/* Not found */}
            {userNotFound && (
              <View style={styles.notFoundWrap}>
                <View style={[styles.notFoundIcon, { backgroundColor: errorColor + '15' }]}>
                  <Ionicons name="person-remove-outline" size={26} color={errorColor} />
                </View>
                <Text style={[styles.notFoundTitle, { color: primaryText }]}>
                  Not on {String(APP_TAG_NAME || 'the app')}
                </Text>
                <Text style={[styles.notFoundSubtitle, { color: secondaryText }]}>
                  This number isn't registered yet. Double-check the country code and number, or invite them later.
                </Text>
              </View>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </Animated.View>
    );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  scrollContent: { paddingHorizontal: 24, paddingBottom: 40 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    height: 56,
    gap: 14,
  },
  headerBackBtn: {
    width: 32, height: 32,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitleWrap: { flex: 1 },
  headerTitle: {
    fontFamily: 'Roboto-Medium',
    fontSize: 18,
    letterSpacing: 0.1,
  },
  headerSubtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 1,
  },

  // Icon + heading
  illustrationWrap: {
    alignItems: 'center',
    paddingTop: 28,
    paddingBottom: 30,
  },
  illIcon: {
    width: 72, height: 72, borderRadius: 36,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 16,
  },
  illTitle: {
    fontFamily: 'Roboto-Medium',
    fontSize: 18,
  },
  illSubtitle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 6,
    paddingHorizontal: 24,
    lineHeight: 19,
  },

  // Phone row
  phoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 2,
    paddingBottom: 4,
    minHeight: 52,
  },
  codeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    paddingRight: 8,
    marginRight: 10,
  },
  codeChevron: { marginLeft: -4 },
  phoneInput: {
    flex: 1,
    fontFamily: 'Roboto-Regular',
    fontSize: 18,
    letterSpacing: 0.5,
    paddingVertical: 0,
  },
  trailIcon: { marginLeft: 8 },

  helperText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 10,
  },

  // Result
  resultWrap: { marginTop: 26 },
  resultHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
    paddingHorizontal: 2,
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
    borderRadius: 16,
  },
  userAvatarRing: {
    width: 56, height: 56, borderRadius: 28,
    borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  userAvatar: { width: 48, height: 48, borderRadius: 24 },
  userAvatarFallback: { alignItems: 'center', justifyContent: 'center' },
  userAvatarLetter: {
    color: '#fff',
    fontFamily: 'Roboto-Bold',
    fontSize: 20,
  },
  userName: {
    fontFamily: 'Roboto-Medium',
    fontSize: 16,
    textTransform: 'capitalize',
  },
  userPhone: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    marginTop: 2,
  },
  userCta: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
  },
  resultHint: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 10,
    marginLeft: 2,
  },

  // Not found
  notFoundWrap: {
    alignItems: 'center',
    paddingTop: 34,
    paddingHorizontal: 28,
  },
  notFoundIcon: {
    width: 64, height: 64, borderRadius: 32,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 14,
  },
  notFoundTitle: {
    fontFamily: 'Roboto-Medium',
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
