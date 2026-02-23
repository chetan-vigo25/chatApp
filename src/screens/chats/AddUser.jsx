import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  Animated,
  TouchableOpacity,
  Image,
  TextInput,
  ActivityIndicator,
  Platform,
  ToastAndroid,
  Alert,
  Modal,
  Linking,
  RefreshControl
} from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { APP_TAG_NAME } from '@env';
import useContactSync from "../../contexts/useContactSync";
import { FontAwesome6, FontAwesome5, AntDesign, MaterialCommunityIcons, FontAwesome } from '@expo/vector-icons';
import { useSelector } from "react-redux";
import { useFocusEffect } from '@react-navigation/native';
import CryptoJS from 'crypto-js';
import { CONTACT_SALT, SALT_SECRET } from '@env';

export default function AddUser({ navigation }) {
  const { theme } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const [searchQuery, setSearchQuery] = useState('');
  const { chatsData } = useSelector(state => state.chat || {});

  const [modalVisible, setModalVisible] = useState(false);
  const [selectedChatItem, setSelectedChatItem] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const {
    matchedContacts = [],
    matchedCount,
    isProcessing,
    isSyncing,
    error,
    lastSyncTime,
    discoverContact,
    discoverResponse,
    clearDiscoverResponse,
    syncContacts,
    handleSenInvatation,
    inviteResponse,
    clearInviteResponse,
    refreshContacts,
    loadContacts
  } = useContactSync();

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

 // Initial load - sync contacts
useEffect(() => {
  const initializeContacts = async () => {
    try {
      await syncContacts();  // ✅ use the function your hook actually exports
    } catch (err) {
      console.error('Failed to sync contacts:', err);
    }
  };
  initializeContacts();
}, []);

  // Handle discovered contact navigation
  useEffect(() => {
    if (!discoverResponse) return;
    const data = discoverResponse?.data ?? discoverResponse;
    let discoveredData = null;
    if (data?.userId) discoveredData = data;
    else if (Array.isArray(data?.contacts) && data.contacts.length > 0) discoveredData = data.contacts[0];

    if (!discoveredData) {
      showMessage(data?.message || "Contact not found on server");
      clearDiscoverResponse();
      return;
    }

    const discovered = {
      userId: discoveredData.userId,
      id: discoveredData.userId || discoveredData.id,
      name: discoveredData.name || discoveredData.fullName || 'Unknown',
      fullName: discoveredData.fullName || discoveredData.name || 'Unknown',
      profilePicture: discoveredData.profileImage || discoveredData.profilePicture || '',
      about: discoveredData.about || '',
      isActive: discoveredData.isActive ?? true,
      canMessage: discoveredData.canMessage ?? true,
      originalId: discoveredData.originalId,
      hash: discoveredData.hash
    };

    const existingChat = chatsData?.find(
      chat => chat.peerUser?._id === discovered.userId || chat.peerUser?._id === discovered.id
    );
    
    if (existingChat) {
      navigation.navigate('ChatScreen', { item: existingChat, chatId: existingChat._id || existingChat.chatId, user: discovered, hasExistingChat: true });
    } else {
      navigation.navigate('ChatScreen', { user: discovered, chatId: null, hasExistingChat: false });
    }

    clearDiscoverResponse();
  }, [discoverResponse]);

  // Handle invite response
  useEffect(() => {
    if (!inviteResponse) return;
    if (inviteResponse.error) showMessage(inviteResponse.error || 'Failed to send invitation.');
    else showMessage(inviteResponse.message || `Invitation sent to ${inviteResponse.contactName || 'contact'}`);
    clearInviteResponse();
  }, [inviteResponse, clearInviteResponse]);

  useEffect(() => { if (error) showMessage(error); }, [error]);

  const showMessage = (msg) => {
    if (!msg) return;
    if (Platform.OS === 'android') ToastAndroid.show(msg, ToastAndroid.LONG);
    else Alert.alert('Info', msg);
  };

  // Updated handleContactPress
  const handleContactPress = async (contact) => {
    if (!contact) return;

    const existingChat = chatsData?.find(
      chat => chat.peerUser?._id === contact.userId || chat.peerUser?._id === contact.id
    );

    if (existingChat) {
      navigation.navigate('ChatScreen', { item: existingChat, chatId: existingChat._id || existingChat.chatId, user: contact, hasExistingChat: true });
      return;
    }

    if (contact.hash && discoverContact) {
      try { await discoverContact(contact.hash); }
      catch (err) { showMessage(err?.message || 'Failed to discover contact.'); }
      return;
    }

    navigation.navigate('ChatScreen', { user: contact, chatId: null, hasExistingChat: false });
  };

  const handleRefresh = useCallback(async () => {
    if (refreshing || isSyncing) return;
    setRefreshing(true);
    try { await refreshContacts({ fallbackToSync: true }); } 
    catch (err) {
      console.warn('Refresh failed:', err);
      try { await syncContacts(); } catch (_) { showMessage('Failed to refresh contacts'); }
    } finally { setRefreshing(false); }
  }, [refreshContacts, syncContacts, refreshing, isSyncing]);

  const decryptContent = (cipherText) => {
    if (!cipherText) return "";
    try {
      const bytes = CryptoJS.AES.decrypt(cipherText, CONTACT_SALT);
      return bytes.toString(CryptoJS.enc.Utf8);
    } catch (error) { return ""; }
  };

  const getDisplayPhone = (contact) => {
    if (!contact) return '';
    if (contact.phone) return contact.phone;
    if (contact.number) return contact.number;
    if (contact.originalPhone) return contact.originalPhone;
    if (contact.encryptNumber) {
      const decrypted = decryptContent(contact.encryptNumber);
      const salt = contact.hashDetails?.salt || SALT_SECRET || '';
      if (salt && decrypted.endsWith(salt)) return decrypted.slice(0, decrypted.length - salt.length);
      return decrypted;
    }
    if (contact.originalId && /^[0-9]{8,}$/.test(String(contact.originalId))) {
      let num = String(contact.originalId);
      if (!num.startsWith('+')) num = '+91' + num;
      return num;
    }
    if (contact.originalId) return `ID: ${contact.originalId}`;
    return '';
  };

  const filteredContacts = matchedContacts.filter(contact => {
    const searchLower = (searchQuery || '').toLowerCase();
    return ((contact.name || '').toLowerCase().includes(searchLower) ||
            (contact.fullName || '').toLowerCase().includes(searchLower) ||
            (contact.username || '').toLowerCase().includes(searchLower) ||
            (contact.originalPhone || '').includes(searchQuery));
  });

  const registeredContacts = filteredContacts.filter(c => !!c.userId);
  const unregisteredContacts = filteredContacts.filter(c => !c.userId);

  const openSmsComposer = (contact, message) => {
    if (!contact) return;
    const phone = contact.phone || contact.number || contact.originalPhone || '';
    if (!phone) {
      showMessage('No phone number available to send invite.');
      return;
    }
    const separator = Platform.OS === 'ios' ? '&' : '?';
    const smsUrl = `sms:${phone}${separator}body=${encodeURIComponent(message)}`;
    Linking.openURL(smsUrl).catch(() => {
      showMessage('Unable to open SMS app. Please copy and send the invite message manually.');
    });
  };

  const onSendInvitationPress = async (contact) => {
    if (!contact) return;

    const payload = {
      contactHash: contact?.hash || contact?.contactHash || contact?.id || null,
      inviteMethod: "sms",
      contactName: contact?.fullName || contact?.name || '',
      message: "this is the invitation message here....."
    };

    try {
      await handleSenInvatation(payload);
      console.log('Invite emitted to server for', payload.contactHash);
    } catch (err) {
      console.warn('Failed to emit invite to server:', err?.message || err);
    }

    openSmsComposer(contact, payload.message);
  };

  const handleModal = (contact) => { setSelectedChatItem(contact); setModalVisible(true); }; 
  const closeModal = () => { setModalVisible(false); setSelectedChatItem(null); };
  const renderHeader = () => (
    <View style={{ width:'100%', flexDirection:'row', gap:10, alignItems:'center', padding:10, borderBottomWidth:1, borderBottomColor:theme.colors.borderColor }} >
      <TouchableOpacity onPress={() => navigation.goBack()} style={{ width:40, height:40, alignItems:'center', justifyContent:'center' }} >
        <FontAwesome6 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
      </TouchableOpacity>
      <View style={{ flex:1, flexDirection:'row', alignItems:'center', justifyContent:'space-between' }} >
        <View>
          <Text style={{ color:theme.colors.primaryTextColor, fontFamily:'Poppins-Medium', fontSize:16, textTransform:'capitalize' }} >
            Select Contact
          </Text>
          <Text style={{ color:theme.colors.placeHolderTextColor, fontFamily:'Poppins-Medium', fontSize:12 }} >
            {isSyncing ? 'Syncing...' : `${matchedCount} contacts`}
          </Text>
        </View>
        {/* <TouchableOpacity 
          onPress={handleRefresh} 
          disabled={isSyncing || refreshing}
          style={{ width:40, height:40, alignItems:'center', justifyContent:'center' }} 
        >
          {isSyncing || refreshing ? (
            <ActivityIndicator size="small" color={theme.colors.themeColor} />
          ) : (
            <FontAwesome name="refresh" size={24} color={theme.colors.primaryTextColor} />
          )}
        </TouchableOpacity> */}
      </View>
    </View>
  );

  const renderNewContactButton = () => (
    <TouchableOpacity onPress={() => navigation.navigate('AddNewContact')} style={{ width:'100%', padding:15, gap:10, flexDirection:"row" }} >
      <View style={{ width:40, height:40, borderRadius:100, alignItems:'center', justifyContent:'center', backgroundColor:theme.colors.themeColor }} >
        <FontAwesome5 name="user-plus" size={18} color={theme.colors.textWhite} />
      </View>
      <View style={{ flex:1, flexDirection:"row", alignItems:"center", justifyContent:"space-between" }} >
        <Text style={{ color:theme.colors.primaryTextColor, fontFamily:'Poppins-Medium', fontSize:16, textTransform:'capitalize' }} >
          New Contact
        </Text>
      </View>
    </TouchableOpacity>
  );

  const renderSearchBar = () => (
    <View style={{ width:'100%', padding:15 }} >
      <View style={{ width:'100%', alignItems:'flex-start', justifyContent:'center', borderRadius:50, marginBottom:10}} >
        <TextInput
          placeholder="Search contacts"
          placeholderTextColor={theme.colors.placeHolderTextColor}
          value={searchQuery}
          onChangeText={setSearchQuery}
          style={{
            height:45,
            backgroundColor:theme.colors.menuBackground,
            borderRadius:50,
            width:'100%',
            padding: 15,
            fontSize: 12,
            color: theme.colors.primaryTextColor,
            fontFamily: 'Poppins-Medium'
          }}
        />
      </View>
      <View style={{ flexDirection:'row', alignItems:'center', justifyContent:'space-between' }} >
        <Text style={{ color:theme.colors.placeHolderTextColor, fontFamily:'Poppins-Medium', fontSize:14 }} >
          Contacts on {APP_TAG_NAME}
        </Text>
        {lastSyncTime && (
          <Text style={{ color:theme.colors.placeHolderTextColor, fontFamily:'Poppins-Regular', fontSize:10 }} >
            Last sync: {new Date(lastSyncTime).toLocaleTimeString()}
          </Text>
        )}
      </View>
    </View>
  );

  const renderContactRow = (contact, index, showInvite = false) => {
    const initials = (contact?.name || contact?.fullName || '?').charAt(0).toUpperCase();
    const key = contact.id || contact.userId || contact.hash || index;
    
    return (
      <TouchableOpacity
        key={key}
        style={{ width:'100%', padding:10, gap:10, flexDirection:"row", alignItems:'center', marginBottom:8, borderBottomWidth:0.5, borderBottomColor: theme.colors.borderColor }}
      >
        <TouchableOpacity onPress={() => handleModal(contact)} style={{ width:50, height:50, borderRadius:100, alignItems:'center', justifyContent:'center', overflow:'hidden' }} >
          {
            contact.profilePicture ? (
              <Image resizeMode="cover" source={{ uri: contact.profilePicture }} style={{ width: '100%', height: '100%', borderRadius: 100 }} />
            ) : (
              <View style={{ width:50, height:50, flexDirection:'row', borderRadius:100, alignItems:'center', justifyContent:'center', backgroundColor: theme.colors.themeColor }} >
                <Text style={{ color:theme.colors.textWhite, fontFamily:'Poppins-Medium', fontSize:20 }}>{initials}</Text>
              </View>
            )
          }
        </TouchableOpacity>

        <TouchableOpacity onPress={() => handleContactPress(contact)} style={{ flex:1, flexDirection:"row", justifyContent:"space-between", alignItems:"center" }} >
          <View style={{ flex:1 }}>
            <Text style={{ color:theme.colors.primaryTextColor, fontFamily:'Poppins-Medium', fontSize:16, textTransform:'capitalize' }} >
              {contact?.name || contact?.fullName || 'Unknown'}
            </Text>
            <Text style={{ color:theme.colors.placeHolderTextColor, fontFamily:'Poppins-Medium', fontSize:12 }}>
              {getDisplayPhone(contact)}
            </Text>

            { showInvite ? (
              <TouchableOpacity onPress={() => onSendInvitationPress(contact)} activeOpacity={0.75}>
                <Text style={{ color: theme.colors.themeColor, fontFamily:'Poppins-Medium', fontSize:12 }}>
                  Send invitation for chat
                </Text>
              </TouchableOpacity>
            ) : (
              <Text style={{ color:theme.colors.placeHolderTextColor, fontFamily:'Poppins-Medium', fontSize:12 }}>
                Registered
              </Text>
            )}
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => (
    <View style={{ width:'100%', alignItems:'center', justifyContent:'center', marginTop:50, padding:20 }} >
      <FontAwesome6 name="address-book" size={40} color={theme.colors.borderColor} />
      <Text style={{ color:theme.colors.placeHolderTextColor, fontFamily:'Poppins-Medium', fontSize:14, marginTop:10, textAlign:'center' }} >
        {searchQuery ? 'No matching contacts' : 'No contacts found'}
      </Text>
      {error && (
        <Text style={{ color:'#ff4444', fontFamily:'Poppins-Regular', fontSize:12, marginTop:5, textAlign:'center' }} >
          {error}
        </Text>
      )}
      {!searchQuery && (
        <TouchableOpacity
          onPress={handleRefresh}
          disabled={isSyncing || refreshing}
          style={{ marginTop:20, backgroundColor:theme.colors.themeColor, paddingHorizontal:20, paddingVertical:10, borderRadius:20, opacity: (isSyncing || refreshing) ? 0.5 : 1 }}
        >
          <Text style={{ color:theme.colors.textWhite, fontFamily:'Poppins-Medium', fontSize:12 }} >
            {isSyncing || refreshing ? 'Syncing...' : 'Refresh Contacts'}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );

  const renderProcessingState = () => (
    <View style={{ flex:1, alignItems:'center', justifyContent:'center', padding:20 }} >
      <ActivityIndicator size="large" color={theme.colors.themeColor} />
      <Text style={{ color:theme.colors.placeHolderTextColor, fontFamily:'Poppins-Medium', fontSize:14, marginTop:10 }} >
        Processing contacts...
      </Text>
      <Text style={{ color:theme.colors.placeHolderTextColor, fontFamily:'Poppins-Regular', fontSize:12, marginTop:5, textAlign:'center' }} >
        Securely hashing your contacts
      </Text>
    </View>
  );

  return (
    <Animated.View style={{ flex: 1, opacity: fadeAnim }} >
      {renderHeader()}
      {renderSearchBar()}
      {renderNewContactButton()}

      {isProcessing ? (
        renderProcessingState()
      ) : (
        <ScrollView 
          style={{ flex:1, padding:15 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing || isSyncing}
              onRefresh={handleRefresh}
              colors={[theme.colors.themeColor]}
              tintColor={theme.colors.themeColor}
            />
          }
        >
          <Text style={{ color: theme.colors.primaryTextColor, fontFamily:'Poppins-Medium', fontSize:14, marginBottom:8 }}>
            Contacts on {APP_TAG_NAME}
          </Text>
          {registeredContacts.length > 0 ? (
            registeredContacts.map((c, i) => renderContactRow(c, i, false))
          ) : (
            <Text style={{ color: theme.colors.placeHolderTextColor, fontFamily:'Poppins-Regular', marginBottom:12 }}>
              No registered contacts
            </Text>
          )}

          <View style={{ height:12 }} />
          <Text style={{ color: theme.colors.primaryTextColor, fontFamily:'Poppins-Medium', fontSize:14, marginBottom:8 }}>
            Unregistered contacts
          </Text>
          {unregisteredContacts.length > 0 ? (
            unregisteredContacts.map((c, i) => renderContactRow(c, i, true))
          ) : (
            <Text style={{ color: theme.colors.placeHolderTextColor, fontFamily:'Poppins-Regular', marginBottom:12 }}>
              No unregistered contacts
            </Text>
          )}

          {registeredContacts.length === 0 && unregisteredContacts.length === 0 && renderEmptyState()}
        </ScrollView>
      )}

      <Modal
        animationType="fade"
        transparent={true}
        visible={modalVisible}
        onRequestClose={closeModal}
      >
        <TouchableOpacity onPress={closeModal} activeOpacity={1} style={{ flex:1, justifyContent:'center', alignItems:'center', backgroundColor:'rgba(0,0,0,0.4)', padding:0 }} >
          <View style={{ width:'60%', backgroundColor:theme.colors.cardBackground, borderRadius:8, overflow:'hidden' }} >
            <View style={{ width:'100%', height:200, backgroundColor: theme.colors.menuBackground }} >
              {
                (selectedChatItem?.profilePicture || selectedChatItem?.profileImage) ? (
                  <Image
                    resizeMode="cover"
                    source={{ uri: selectedChatItem?.profilePicture || selectedChatItem?.profileImage }}
                    style={{ width: '100%', height: '100%' }}
                  />
                ) : (
                  <View style={{ flex:1, alignItems:'center', justifyContent:'center', backgroundColor: theme.colors.themeColor }} >
                    <Text style={{ color:theme.colors.textWhite, fontFamily:'Poppins-Medium', fontSize:64, textTransform: 'uppercase' }} >
                      {(selectedChatItem?.fullName || selectedChatItem?.name || "?").charAt(0)}
                    </Text>
                  </View>
                )
              }
              <View style={{ position:'absolute', top:8, left:8, padding:6 }} >
                <Text style={{ color:theme.colors.textWhite, fontFamily:'Poppins-Medium', fontSize:18 }} >
                  {selectedChatItem?.fullName || selectedChatItem?.name || 'Unknown'}
                </Text>
              </View>
              {
                selectedChatItem?.type === "registered" ? (
                  <View style={{ flexDirection:'row', position:'absolute', bottom:0, width:'100%', backgroundColor:'rgba(0,0,0,0.35)' }} >
                    <TouchableOpacity
                      onPress={async () => {
                        closeModal();
                        await handleContactPress(selectedChatItem);
                      }}
                      activeOpacity={0.9}
                      style={{ flex:1, alignItems:'center', justifyContent:'center', padding:12 }}
                    >
                      <MaterialCommunityIcons name="message-reply-text-outline" size={24} color={theme.colors.textWhite} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => {
                        closeModal();
                        navigation.navigate('UserB', { item: selectedChatItem });
                      }}
                      activeOpacity={0.9}
                      style={{ flex:1, alignItems:'center', justifyContent:'center', padding:12 }}
                    >
                      <AntDesign name="exclamation-circle" size={24} color={theme.colors.textWhite} />
                    </TouchableOpacity>
                  </View>
                ) : null
              }
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </Animated.View>
  );
}
