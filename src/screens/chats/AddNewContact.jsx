import React, { useState, useEffect, useRef } from "react";
import {
  View, Text, ScrollView, Animated, TouchableOpacity, Image,
  ActivityIndicator, Alert, StyleSheet, TextInput, Platform, KeyboardAvoidingView,
} from "react-native";
import { useSelector } from "react-redux";
import { useTheme } from "../../contexts/ThemeContext";
import countryCodes from '../../jsonFile/countryCodes.json';
import { detectIpCountry, getCachedIpCountry } from "../../utils/ipCountry";

// The user's own registered dial code (e.g. "+91") is stored on their profile as
// mobile.code and matches a countryCodes[].code exactly, so we can default the
// picker to the country they signed up from — i.e. the country they use the app in.
const matchCountryByDialCode = (dialCode) =>
  (dialCode ? countryCodes.find((c) => c.code === dialCode) : null) || null;
import CountryCodeContact from "../../components/CountryCodeContact";
import { getSocket, isSocketConnected, reconnectSocket } from "../../Redux/Services/Socket/socket";
import { getPhoneRule, isPhoneValid, phoneLengthHint } from "../../utils/phoneValidation";
import { APP_TAG_NAME } from '@env';
import { Ionicons } from '@expo/vector-icons';

const DEBOUNCE_DELAY = 500;
// Minimum characters before we search by username (system-generated, e.g. "ballu1").
const MIN_USERNAME_LENGTH = 3;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ONE search box, three query kinds. We auto-detect what the user typed:
//  - contains "@"                      → email
//  - only phone characters (0-9 +-() ) → phone number (uses the country code)
//  - anything else (has letters)       → username
const detectQueryType = (raw) => {
  const s = String(raw || '').trim();
  if (!s) return 'empty';
  if (s.includes('@')) return 'email';
  if (/^[0-9+\-()\s]+$/.test(s)) return 'phone';
  return 'username';
};

export default function AddNewContact({ navigation }) {
    const { theme, isDarkMode } = useTheme();
    const fadeAnim = useRef(new Animated.Value(0)).current;
    // Single unified search box — phone number, username, or email.
    const [query, setQuery] = useState('');
    const [queryFocused, setQueryFocused] = useState(false);
    // Default country priority: user's manual pick > current IP/VPN country >
    // the user's registered number's country > first catalogue entry. IP is the
    // requested primary (follows a VPN); the registered number is the fallback when
    // the geo lookup fails. `userPickedCountry` guards against overriding a choice.
    const myDialCode = useSelector((state) => state.profile?.profileData?.mobile?.code) || null;
    const userPickedCountry = useRef(false);
    const [selectedCountry, setSelectedCountry] = useState(
      () => getCachedIpCountry() || matchCountryByDialCode(myDialCode) || countryCodes[0]
    );

    // Resolve the IP/VPN country (async); fall back to the registered number.
    // Never overrides a country the user picked.
    useEffect(() => {
      let alive = true;
      detectIpCountry().then((ipCountry) => {
        if (!alive || userPickedCountry.current) return;
        const next = ipCountry || matchCountryByDialCode(myDialCode);
        if (next && next.code !== selectedCountry?.code) {
          setSelectedCountry(next);
        }
      });
      return () => { alive = false; };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [myDialCode]);
    const [isSearching, setIsSearching] = useState(false);
    const [searchResult, setSearchResult] = useState(null);

    const socketRef = useRef(null);
    const searchTimeoutRef = useRef(null);
    const isSocketListenerActive = useRef(false);
    const pendingUserDataRef = useRef(null);
    const socketHandlersRef = useRef({ onSearchResponse: null, onChatCreateResponse: null });

    // Country-aware validation rules (min/max digits for the selected dial code).
    const phoneRule = getPhoneRule(selectedCountry?.code);
    const maxLen = phoneRule.max;

    // Derived view of the current query.
    const queryType = detectQueryType(query);
    const phoneDigits = query.replace(/[^0-9]/g, '');
    const isCompleteNumber = isPhoneValid(selectedCountry?.code, phoneDigits);
    const isCompleteEmail = EMAIL_REGEX.test(query.trim());
    const isCompleteUsername = query.trim().replace(/\s+/g, '').length >= MIN_USERNAME_LENGTH;

    useEffect(() => {
      const timer = setTimeout(() => {
        Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }).start();
      }, 400);
      return () => clearTimeout(timer);
    }, []);

    const handleCountrySelect = (country) => {
      userPickedCountry.current = true;
      setSelectedCountry(country);
    };

    const handleBack = () => {
      if (navigation?.canGoBack?.()) { navigation.goBack(); return; }
      navigation?.navigate?.('ChatList');
    };

    const resetSearchState = () => {
      setIsSearching(false);
      setSearchResult(null);
      pendingUserDataRef.current = null;
    };

    const handleClearQuery = () => {
      setQuery('');
      resetSearchState();
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
        // Mobile, username and email searches all return the same response shape,
        // so they share one handler.
        socket.on('user:search:mobile:response', onSearchResponse);
        socket.on('user:search:username:response', onSearchResponse);
        socket.on('user:search:email:response', onSearchResponse);

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
            const mobileNum  = userData.mobile?.number || userData.mobileNumber || userData.phone || phoneDigits;
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
          socket.off('user:search:username:response', socketHandlersRef.current.onSearchResponse);
          socket.off('user:search:email:response', socketHandlersRef.current.onSearchResponse);
        }
        if (socketHandlersRef.current.onChatCreateResponse) {
          socket.off('chat:create:response', socketHandlersRef.current.onChatCreateResponse);
        }
        socketHandlersRef.current.onSearchResponse = null;
        socketHandlersRef.current.onChatCreateResponse = null;
        isSocketListenerActive.current = false;
    };

    // Ensure a live socket + listeners, then emit `event` with `payload`. Shared by
    // all three search kinds so the connection-recovery logic lives in one place.
    const emitSearch = async (event, payload) => {
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
        socket.emit(event, payload, () => {});
      } catch (error) {
        setIsSearching(false);
        setSearchResult({ found: false, message: 'Search failed. Please try again.' });
      }
    };

    const searchUserByPhone = (digits) => {
      if (!isPhoneValid(selectedCountry?.code, digits)) { resetSearchState(); return; }
      emitSearch('user:search:mobile', { countryCode: selectedCountry.code, mobileNumber: digits });
    };

    const searchUserByUsername = (uname) => {
      const q = String(uname || '').trim().toLowerCase();
      if (q.length < MIN_USERNAME_LENGTH) { resetSearchState(); return; }
      emitSearch('user:search:username', { userName: q });
    };

    const searchUserByEmail = (email) => {
      const q = String(email || '').trim().toLowerCase();
      if (!EMAIL_REGEX.test(q)) { resetSearchState(); return; }
      // NOTE: needs the backend to handle `user:search:email` and reply with
      // `user:search:email:response` (same shape as mobile/username). Mobile and
      // username searches already work; email is wired here on the client side.
      emitSearch('user:search:email', { email: q });
    };

    // Route the query to the right search based on what the user typed.
    const runSearch = (raw) => {
      const type = detectQueryType(raw);
      if (type === 'email') { searchUserByEmail(raw.trim().toLowerCase()); }
      else if (type === 'phone') { searchUserByPhone(raw.replace(/[^0-9]/g, '').slice(0, maxLen)); }
      else if (type === 'username') { searchUserByUsername(raw.replace(/\s+/g, '').toLowerCase()); }
      else { resetSearchState(); }
    };

    const handleQueryChange = (text) => {
      setQuery(text);

      if (searchResult !== null) { setSearchResult(null); pendingUserDataRef.current = null; }
      if (searchTimeoutRef.current) { clearTimeout(searchTimeoutRef.current); searchTimeoutRef.current = null; }

      const type = detectQueryType(text);
      const complete =
        type === 'email' ? EMAIL_REGEX.test(text.trim())
        : type === 'phone' ? isPhoneValid(selectedCountry?.code, text.replace(/[^0-9]/g, ''))
        : type === 'username' ? text.trim().replace(/\s+/g, '').length >= MIN_USERNAME_LENGTH
        : false;

      if (complete) {
        searchTimeoutRef.current = setTimeout(() => { runSearch(text); }, DEBOUNCE_DELAY);
      } else {
        resetSearchState();
      }
    };

    // Re-run a phone search when the country changes (a different dial code can
    // make the same digits valid/invalid). Only relevant while typing a number.
    useEffect(() => {
      if (queryType === 'phone' && isPhoneValid(selectedCountry?.code, phoneDigits)) {
        setSearchResult(null);
        pendingUserDataRef.current = null;
        if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = setTimeout(() => { searchUserByPhone(phoneDigits); }, DEBOUNCE_DELAY);
      }
      return () => { if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current); };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedCountry]);

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
          const mobileNum  = exactUser.mobile?.number || exactUser.mobileNumber || exactUser.phone || phoneDigits;
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

    // WhatsApp palette
    const accent = isDarkMode ? '#00A884' : '#008069';
    const bg = isDarkMode ? '#000000' : '#FFFFFF';
    const primaryText = isDarkMode ? '#E9EDEF' : '#111B21';
    const secondaryText = isDarkMode ? '#8696A0' : '#54656F';
    const placeholderText = isDarkMode ? '#5E7280' : '#A6B0BD';
    const underlineIdle = isDarkMode ? '#2A3942' : '#D1D7DB';
    const cardBg = isDarkMode ? '#1F2C33' : '#F7F8FA';
    const errorColor = '#E5484D';

    // Whether the current query is "complete enough" to trust the search result.
    const queryComplete =
      queryType === 'email' ? isCompleteEmail
      : queryType === 'phone' ? isCompleteNumber
      : queryType === 'username' ? isCompleteUsername
      : false;

    const hasInput = query.length > 0;
    // Only phone numbers have a strict length rule to warn about.
    const showLengthError = queryType === 'phone' && hasInput && !isCompleteNumber;
    const userFound = !!(searchResult && searchResult.found && queryComplete && !isSearching);
    const userNotFound = !!(searchResult && !searchResult.found && queryComplete && !isSearching);
    const userDisplayName = searchResult?.user?.fullName || searchResult?.user?.name || 'User';
    const userAvatar = searchResult?.user?.profileImage || searchResult?.user?.profilePicture;

    const queryUnderline = showLengthError ? errorColor : (queryFocused ? accent : underlineIdle);

    // Sub-label of the found user, shown according to what was searched.
    const resultSubLabel =
      queryType === 'email' ? (searchResult?.user?.email || query.trim())
      : queryType === 'username' ? `@${searchResult?.user?.userName || query.trim()}`
      : `${selectedCountry.code} ${phoneDigits}`;

    // Helper line under the input, based on what the user is typing.
    const helperLine = (() => {
      if (queryType === 'email') {
        return isCompleteEmail ? 'Searching by email' : 'Enter a full email address';
      }
      if (queryType === 'username') {
        return `Searching by username (at least ${MIN_USERNAME_LENGTH} characters)`;
      }
      if (queryType === 'phone') {
        return showLengthError
          ? `${selectedCountry?.name || 'This country'} numbers are ${phoneLengthHint(selectedCountry?.code)}`
          : `Enter a ${phoneLengthHint(selectedCountry?.code)} ${selectedCountry?.name || ''} number`.trimEnd();
      }
      return 'Search by phone number, username or email';
    })();

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
              {selectedCountry?.name || 'Search'}
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
                {`Enter their phone number, username or email to start chatting on ${String(APP_TAG_NAME || 'the app')}.`}
              </Text>
            </View>

            {/* Unified search row — country code chip + smart input. The chip is
                used only when a phone number is detected; username/email ignore it. */}
            <View style={[styles.phoneRow, { borderBottomColor: queryUnderline }]}>
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
                placeholder="Phone, username or email"
                placeholderTextColor={placeholderText}
                value={query}
                onChangeText={handleQueryChange}
                keyboardType="default"
                autoCapitalize="none"
                autoCorrect={false}
                onFocus={() => setQueryFocused(true)}
                onBlur={() => setQueryFocused(false)}
              />

              {/* Trailing status icon */}
              {isSearching ? (
                <ActivityIndicator size="small" color={accent} style={styles.trailIcon} />
              ) : userFound ? (
                <Ionicons name="checkmark-circle" size={22} color="#25D366" style={styles.trailIcon} />
              ) : userNotFound ? (
                <TouchableOpacity onPress={handleClearQuery} style={styles.trailIcon}>
                  <Ionicons name="close-circle" size={22} color={errorColor} />
                </TouchableOpacity>
              ) : hasInput ? (
                <TouchableOpacity onPress={handleClearQuery} style={styles.trailIcon}>
                  <Ionicons name="close-circle" size={20} color={secondaryText} />
                </TouchableOpacity>
              ) : null}
            </View>

            {/* Validation / helper line (query-aware) */}
            <Text style={[styles.helperText, { color: showLengthError ? errorColor : secondaryText }]}>
              {helperLine}
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
                      {resultSubLabel}
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
                  {queryType === 'phone' ? `Not on ${String(APP_TAG_NAME || 'the app')}` : 'No match found'}
                </Text>
                <Text style={[styles.notFoundSubtitle, { color: secondaryText }]}>
                  {queryType === 'phone'
                    ? "This number isn't registered yet. Double-check the country code and number, or invite them later."
                    : "No account matches that. Double-check the spelling and try again."}
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

  // Search row
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
