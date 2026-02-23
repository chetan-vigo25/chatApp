import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Pressable,
  Animated,
  Image,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  RefreshControl,
  Modal,
  Keyboard,
} from "react-native";
import moment from "moment";
import { useTheme } from "../../contexts/ThemeContext";
import { FontAwesome6, AntDesign, Ionicons } from "@expo/vector-icons";
import useChatLogic from "../../contexts/useChatLogic";

export default function ChatScreen({ navigation, route }) {
  const { theme, chatColor } = useTheme();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [isAtTop, setIsAtTop] = useState(false); // Track if at top (oldest messages)

  const {
    flatListRef,
    chatData,
    getUserColor,
    messages,
    isLoadingInitial,
    isRefreshing,
    isSearching,
    search,
    handleSearch,
    clearSearch,
    searchResults,
    currentSearchIndex,
    goToNextResult,
    goToPreviousResult,
    selectedMessage,
    handleToggleSelectMessages,
    handleDeleteSelected,
    text,
    handleTextChange,
    handleSendText,
    pendingMedia,
    setPendingMedia,
    openMediaOptions,
    showMediaOptions,
    closeMediaOptions,
    handlePickMedia,
    sendMedia,
    mediaViewer,
    closeMediaViewer,
    handleDownloadMedia,
    downloadedMedia,
    downloadProgress,
    resendMessage,
    // FIXED: Use isPeerTyping instead of isTyping
    isPeerTyping, // This is the correct state from useChatLogic
    renderStatusText,
    isLoadingMore,
    hasMoreMessages,
    onRefresh,
    loadMoreMessages,
    currentUserId,
  } = useChatLogic({ navigation, route });

  useEffect(() => {
    const showSub = Keyboard.addListener("keyboardDidShow", (e) => setKeyboardHeight(e.endCoordinates.height));
    const hideSub = Keyboard.addListener("keyboardDidHide", () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Add scroll handler to track position
  const handleScroll = (event) => {
    const { contentOffset } = event.nativeEvent;
    
    // With inverted list, top (oldest messages) is when contentOffset.y is close to 0
    const isTop = contentOffset.y <= 5; // Small threshold for "at top"
    
    setIsAtTop(isTop);
  };

  // Debug log to verify typing status
  useEffect(() => {
    console.log("📱 [ChatScreen] isPeerTyping status:", isPeerTyping);
  }, [isPeerTyping]);

  if (isLoadingInitial) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator size="large" color={theme.colors.themeColor} />
        <Text style={{ marginTop: 20, fontSize: 16, color: theme.colors.primaryTextColor }}>Loading chat...</Text>
      </View>
    );
  }

  if (!chatData || !chatData.peerUser) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background, justifyContent: "center", alignItems: "center", padding: 20 }}>
        <FontAwesome6 name="exclamation-triangle" size={50} color={theme.colors.themeColor} />
        <Text style={{ marginTop: 20, fontSize: 16, color: theme.colors.primaryTextColor, textAlign: "center" }}>Unable to load chat. User information is missing.</Text>
        <TouchableOpacity onPress={() => navigation.goBack()} style={{ marginTop: 20, paddingHorizontal: 30, paddingVertical: 12, backgroundColor: theme.colors.themeColor, borderRadius: 8 }}>
          <Text style={{ color: theme.colors.textWhite }}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const renderDateSeparator = (date, index, messagesArray) => {
    const today = moment().format("YYYY-MM-DD");
    const yesterday = moment().subtract(1, 'days').format("YYYY-MM-DD");
    const displayDate = date === today ? "Today" : (date === yesterday ? "Yesterday" : moment(date).format("MMMM DD, YYYY"));
    const showSeparator = index === messagesArray.length - 1 || (index < messagesArray.length - 1 && messagesArray[index + 1]?.date !== date);
    if (!showSeparator) return null;
    return (
      <View style={{ alignItems: "center", paddingVertical: 10 }}>
        <View style={{ backgroundColor: theme.colors.menuBackground, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12 }}>
          <Text style={{ fontSize: 12, color: theme.colors.placeHolderTextColor, fontFamily: "Poppins-Medium" }}>{displayDate}</Text>
        </View>
      </View>
    );
  };

  const highlightSearchText = (textToHighlight) => {
    if (!isSearching || !search.trim()) return textToHighlight;
    const searchQuery = search.trim();
    const regex = new RegExp(`(${searchQuery})`, 'gi');
    const parts = (textToHighlight || "").split(regex);
    return parts.map((part, i) => part.toLowerCase() === searchQuery.toLowerCase() ? <Text key={i} style={{ backgroundColor: '#FFEB3B', color: '#000' }}>{part}</Text> : part);
  };

  const renderChatsItem = ({ item: msg, index }) => {
    const isSelected = selectedMessage.includes(msg.id);
    const isMyMessage = msg.senderId === currentUserId;
    const isHighlighted = isSearching && searchResults.length > 0 && currentSearchIndex >= 0 && searchResults[currentSearchIndex]?.id === msg.id;
    const isDownloaded = !!(downloadedMedia[msg.id] || msg.localUri);
  
    return (
      <React.Fragment key={msg.id || `msg-${index}`}>
        {renderDateSeparator(msg.date, index, messages)}
        <Pressable 
          onPress={() => selectedMessage.length > 0 && handleToggleSelectMessages(msg.id)} 
          onLongPress={() => handleToggleSelectMessages(msg.id)} 
          style={{ 
            alignItems: isMyMessage ? "flex-end" : "flex-start", 
            paddingVertical: 5, 
            paddingHorizontal: 12, 
            backgroundColor: isSelected ? theme.colors.menuBackground : isHighlighted ? 'rgba(0, 0, 0, 0.1)' : "transparent" 
          }}
        >
          <View style={{ 
            maxWidth: "78%", 
            borderRadius: 20, 
            flexDirection: msg.type === "text" ? "row" : "column", 
            flexWrap: "wrap", 
            gap: 5, 
            alignItems: "flex-end", 
            justifyContent: "flex-end", 
            backgroundColor: isMyMessage ? chatColor : '#bbbbbb', 
            borderBottomRightRadius: isMyMessage ? 4 : 20, 
            borderBottomLeftRadius: isMyMessage ? 20 : 4, 
            paddingVertical: 6, 
            paddingHorizontal: 12, 
            borderWidth: isHighlighted ? 2 : 0, 
            borderColor: isHighlighted ? '#FFC107' : 'transparent' 
          }}>
            
            {/* TEXT MESSAGES */}
            {msg.type === "text" && (
              <Text style={{ 
                flexShrink: 1, 
                fontSize: 14, 
                color: theme.colors.textWhite, 
                fontFamily: "Poppins-Medium", 
                marginBottom: 4 
              }}>
                {highlightSearchText(msg.text)}
              </Text>
            )}
  
            {/* MEDIA MESSAGES */}
            {msg.type !== 'text' && (
              (() => {
                const isImage = msg.type === 'image' || msg.mediaType === 'image' || msg.type === 'photo';
                const isVideo = msg.type === 'video' || msg.mediaType === 'video';
                const isFile = msg.type === 'file' || msg.type === 'document';
  
                const localUri = downloadedMedia[msg.id] || msg.localUri || null;
                const previewUri = msg.previewUrl || msg.thumbnailUrl || msg.mediaUrl || null;
                const resolvedImageSrc = localUri || previewUri;
  
                // ===== IMAGE MESSAGES =====
                // SENDER IMAGES - ALWAYS use localUri
                if (isImage && isMyMessage) {
                  // CRITICAL: Always use localUri for sender, never server URL
                  const imageSource = msg.localUri || msg.previewUrl || msg.mediaUrl;
                  
                  if (!imageSource) {
                    return (
                      <View style={{ 
                        width: 160, 
                        height: 120, 
                        borderRadius: 8, 
                        backgroundColor: '#e1e1e1', 
                        alignItems: 'center', 
                        justifyContent: 'center', 
                        marginBottom: 6 
                      }}>
                        {msg.status === 'sending' ? 
                          <ActivityIndicator size="small" color={theme.colors.themeColor} /> : 
                          <Ionicons name="image-outline" size={28} color={theme.colors.placeHolderTextColor} />
                        }
                      </View>
                    );
                  }
                  
                  return (
                    <Image 
                      source={{ uri: imageSource }} 
                      style={{ width: 160, height: 120, borderRadius: 8, marginBottom: 6 }}
                      onError={(e) => {
                        console.log('❌ Image load error:', imageSource);
                        // If local file fails, try payload
                        if (msg.payload?.file?.uri && msg.payload.file.uri !== imageSource) {
                          console.log('Trying payload URI:', msg.payload.file.uri);
                        }
                      }}
                    />
                  );
                }

                // RECEIVER IMAGES
                if (isImage && !isMyMessage) {
                  const isDownloaded = !!(downloadedMedia[msg.id] || msg.localUri);
                  const hasPreview = !!(msg.previewUrl || msg.mediaUrl);
                  
                  // If downloaded, show full image
                  if (isDownloaded) {
                    const imageSrc = downloadedMedia[msg.id] || msg.localUri || msg.previewUrl;
                    return (
                      <TouchableOpacity onPress={() => handleDownloadMedia(msg)}>
                        <Image 
                          source={{ uri: imageSrc }} 
                          style={{ width: 160, height: 120, borderRadius: 8, marginBottom: 6 }} 
                          onError={(e) => console.error('Image load error:', imageSrc)}
                        />
                      </TouchableOpacity>
                    );
                  }
                  
                  // If no preview, show simple placeholder
                  if (!hasPreview) {
                    return (
                      <TouchableOpacity 
                        onPress={() => handleDownloadMedia(msg)} 
                        style={{ 
                          width: 160, 
                          height: 120, 
                          borderRadius: 8, 
                          backgroundColor: theme.colors.menuBackground,
                          alignItems: 'center', 
                          justifyContent: 'center', 
                          marginBottom: 6 
                        }}
                      >
                        <Ionicons name="image-outline" size={32} color={theme.colors.primaryTextColor} />
                        <Text style={{ 
                          fontSize: 12, 
                          color: theme.colors.primaryTextColor,
                          marginTop: 4
                        }}>
                          {msg.time}
                        </Text>
                        <Text style={{ 
                          fontSize: 10, 
                          color: theme.colors.placeHolderTextColor
                        }}>
                          Tap to download
                        </Text>
                      </TouchableOpacity>
                    );
                  }
                  
                  // Show blurred thumbnail with download button
                  const progress = downloadProgress[msg.id];
                  return (
                    <TouchableOpacity 
                      onPress={() => handleDownloadMedia(msg)} 
                      style={{ 
                        width: 160, 
                        height: 120, 
                        borderRadius: 8, 
                        overflow: 'hidden', 
                        marginBottom: 6 
                      }}
                    >
                      <Image 
                        source={{ uri: msg.previewUrl }} 
                        style={{ width: '100%', height: '100%' }} 
                        blurRadius={Platform.OS === 'android' ? 6 : 8}  
                      />
                      <View style={{ 
                        position: 'absolute', 
                        left: 0, 
                        right: 0, 
                        top: 0, 
                        bottom: 0, 
                        alignItems: 'center', 
                        justifyContent: 'center' 
                      }}>
                        <View style={{ 
                          backgroundColor: 'rgba(0,0,0,0.45)', 
                          padding: 8, 
                          borderRadius: 28,
                          alignItems: 'center'
                        }}>
                          {progress ? (
                            <>
                              <ActivityIndicator size="small" color="#fff" />
                              <Text style={{ color: '#fff', fontSize: 10, marginTop: 4 }}>
                                {Math.round(progress * 100)}%
                              </Text>
                            </>
                          ) : (
                            <>
                              <Ionicons name="cloud-download" size={28} color="#fff" />
                              <Text style={{ color: '#fff', fontSize: 10, marginTop: 4 }}>
                                {msg.time}
                              </Text>
                            </>
                          )}
                        </View>
                      </View>
                    </TouchableOpacity>
                  );
                }
  
                // ===== VIDEO MESSAGES =====
                if (isVideo) {
                  const thumbnail = previewUri || msg.mediaUrl || null;
                  const isDownloadedVideo = !!(downloadedMedia[msg.id] || msg.localUri);
                  
                  // SENDER VIDEO
                  if (isMyMessage) {
                    const videoSrc = msg.localUri || msg.mediaUrl || msg.previewUrl;
                    if (!videoSrc) {
                      return (
                        <View style={{ 
                          width: 160, 
                          height: 120, 
                          borderRadius: 8, 
                          backgroundColor: '#e1e1e1', 
                          alignItems: 'center', 
                          justifyContent: 'center', 
                          marginBottom: 6 
                        }}>
                          {msg.status === 'sending' ? 
                            <ActivityIndicator size="small" color={theme.colors.themeColor} /> : 
                            <Ionicons name="videocam-outline" size={28} color={theme.colors.placeHolderTextColor} />
                          }
                        </View>
                      );
                    }
                    
                    return (
                      <TouchableOpacity 
                        onPress={() => handleDownloadMedia(msg)} 
                        style={{ 
                          width: 160, 
                          height: 120, 
                          borderRadius: 8, 
                          backgroundColor: '#000', 
                          alignItems: 'center', 
                          justifyContent: 'center', 
                          marginBottom: 6 
                        }}
                      >
                        {thumbnail ? (
                          <Image 
                            source={{ uri: thumbnail }} 
                            style={{ width: '100%', height: '100%', position: 'absolute' }}
                            blurRadius={5}
                          />
                        ) : null}
                        <Ionicons name="play-circle" size={48} color="#fff" />
                      </TouchableOpacity>
                    );
                  }
                  
                  // RECEIVER VIDEO
                  if (!thumbnail && !isDownloadedVideo) {
                    return (
                      <View style={{ 
                        width: 160, 
                        height: 120, 
                        borderRadius: 8, 
                        backgroundColor: '#e1e1e1', 
                        alignItems: 'center', 
                        justifyContent: 'center', 
                        marginBottom: 6 
                      }}>
                        <Ionicons name="videocam-outline" size={28} color={theme.colors.placeHolderTextColor} />
                      </View>
                    );
                  }
  
                  if (isDownloadedVideo) {
                    return (
                      <TouchableOpacity 
                        onPress={() => handleDownloadMedia(msg)} 
                        style={{ 
                          width: 160, 
                          height: 120, 
                          borderRadius: 8, 
                          backgroundColor: '#000', 
                          alignItems: 'center', 
                          justifyContent: 'center', 
                          marginBottom: 6 
                        }}
                      >
                        <Ionicons name="play-circle" size={48} color="#fff" />
                      </TouchableOpacity>
                    );
                  }
                  
                  // Show blurred thumbnail with download button
                  const progress = downloadProgress[msg.id];
                  return (
                    <TouchableOpacity 
                      onPress={() => handleDownloadMedia(msg)} 
                      style={{ 
                        width: 160, 
                        height: 120, 
                        borderRadius: 8, 
                        overflow: 'hidden', 
                        marginBottom: 6 
                      }}
                    >
                      <Image 
                        source={{ uri: thumbnail }} 
                        style={{ width: '100%', height: '100%' }} 
                        blurRadius={6} 
                      />
                      <View style={{ 
                        position: 'absolute', 
                        left: 0, 
                        right: 0, 
                        top: 0, 
                        bottom: 0, 
                        alignItems: 'center', 
                        justifyContent: 'center' 
                      }}>
                        <View style={{ 
                          backgroundColor: 'rgba(0,0,0,0.45)', 
                          padding: 8, 
                          borderRadius: 28,
                          alignItems: 'center'
                        }}>
                          {progress ? (
                            <View style={{ alignItems: 'center' }}>
                              <ActivityIndicator size="small" color="#fff" />
                              <Text style={{ color: '#fff', fontSize: 12, marginTop: 6 }}>
                                {Math.round((progress || 0) * 100)}%
                              </Text>
                            </View>
                          ) : (
                            <>
                              <Ionicons name="cloud-download" size={28} color={theme.colors.textWhite} />
                              <Text style={{ 
                                color: '#fff', 
                                fontSize: 10, 
                                marginTop: 4,
                                textAlign: 'center'
                              }}>
                                {msg.time}
                              </Text>
                            </>
                          )}
                        </View>
                      </View>
                    </TouchableOpacity>
                  );
                }
  
                // ===== FILE/DOCUMENT MESSAGES =====
                if (isFile) {
                  // SENDER FILE
                  if (isMyMessage) {
                    return (
                      <View style={{ 
                        width: 160, 
                        height: 90, 
                        borderRadius: 8, 
                        backgroundColor: '#333', 
                        alignItems: 'center', 
                        justifyContent: 'center', 
                        marginBottom: 6 
                      }}>
                        <Ionicons name="document-text" size={32} color="#fff" />
                        <Text style={{ color: '#fff', fontSize: 12, marginTop: 4, textAlign: 'center' }} numberOfLines={2}>
                          {msg.text || 'Document'}
                        </Text>
                      </View>
                    );
                  } 
                  
                  // RECEIVER FILE
                  if (isDownloaded) {
                    return (
                      <TouchableOpacity 
                        onPress={() => handleDownloadMedia(msg)} 
                        style={{ 
                          width: 160, 
                          height: 90, 
                          borderRadius: 8, 
                          backgroundColor: '#333', 
                          alignItems: 'center', 
                          justifyContent: 'center', 
                          marginBottom: 6 
                        }}
                      >
                        <Ionicons name="document-text" size={32} color="#fff" />
                        <Text style={{ color: '#fff', fontSize: 12, marginTop: 4, textAlign: 'center' }} numberOfLines={2}>
                          {msg.text || 'Document'}
                        </Text>
                      </TouchableOpacity>
                    );
                  }
  
                  const progress = downloadProgress[msg.id];
                  return (
                    <TouchableOpacity 
                      onPress={() => handleDownloadMedia(msg)} 
                      onStartShouldSetResponder={() => true} 
                      style={{ 
                        width: 160, 
                        height: 90, 
                        borderRadius: 8, 
                        backgroundColor: theme.colors.menuBackground, 
                        alignItems: 'center', 
                        justifyContent: 'center', 
                        marginBottom: 6,
                        borderWidth: 1,
                        borderColor: theme.colors.borderColor
                      }}
                    >
                      {progress ? (
                        <View style={{ alignItems: 'center' }}>
                          <ActivityIndicator size="small" color={theme.colors.themeColor} />
                          <Text style={{ color: theme.colors.primaryTextColor, fontSize: 12, marginTop: 4 }}>
                            {Math.round(progress * 100)}%
                          </Text>
                        </View>
                      ) : (
                        <>
                          <Ionicons name="cloud-download" size={28} color={theme.colors.primaryTextColor} />
                          <Text style={{ color: theme.colors.placeHolderTextColor, marginTop: 6, fontSize: 12, textAlign: 'center' }} numberOfLines={1}>
                            {msg.text || 'Document'}
                          </Text>
                          <Text style={{ color: theme.colors.placeHolderTextColor, fontSize: 10, marginTop: 2 }}>
                            {msg.time} • Tap to download
                          </Text>
                        </>
                      )}
                    </TouchableOpacity>
                  );
                }
  
                return null;
              })()
            )}
  
            {/* Message Status and Timestamp */}
            <View style={{ 
              flexDirection: "row", 
              alignItems: "flex-end", 
              justifyContent: "flex-end", 
              gap: 4,
              marginTop: msg.type !== 'text' ? 4 : 0
            }}>
              <Text style={{ 
                fontSize: 10, 
                color: theme.colors.textWhite, 
                fontFamily: "Poppins-Medium" 
              }}>
                {msg.time}
              </Text>
              
              {isMyMessage && (
                <>
                  {msg.status === "sending" && (
                    <Ionicons name="time-outline" size={14} color={theme.colors.textWhite} />
                  )}
                  {msg.status === "sent" && (
                    <Ionicons name="checkmark" size={14} color="#CCCCCC" />
                  )}
                  {msg.status === "delivered" && (
                    <Ionicons name="checkmark-done" size={14} color="#CCCCCC" />
                  )}
                  {msg.status === "seen" && (
                    <Ionicons name="checkmark-done" size={14} color="#0084FF"/>
                  )}
                  {msg.status === "failed" && (
                    <TouchableOpacity onPress={() => resendMessage(msg)}>
                      <Ionicons name="alert-circle" size={14} color="#FF0000" />
                    </TouchableOpacity>
                  )}
                </>
              )}
            </View>
          </View>
        </Pressable>
      </React.Fragment>
    );
  };

  // FIXED: Use isPeerTyping for the typing indicator
  const renderHeader = () => {
    if (!isPeerTyping) return null;
    return (
      <View style={{ alignItems: "flex-start", paddingVertical: 5, paddingHorizontal: 12 }}>
        <View style={{ 
          borderRadius: 20, 
          flexDirection: 'row', 
          alignItems: "center", 
          gap: 8, 
          backgroundColor: '#bbbbbb', 
          borderBottomLeftRadius: 4, 
          paddingVertical: 10, 
          paddingHorizontal: 15 
        }}>
          <View style={{ flexDirection: 'row', gap: 4 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff', opacity: 0.6 }} />
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff', opacity: 0.8 }} />
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' }} />
          </View>
          <Text style={{ 
            fontSize: 14, 
            color: theme.colors.textWhite, 
            fontFamily: "Poppins-Medium", 
            fontStyle: 'italic' 
          }}>
            typing...
          </Text>
        </View>
      </View>
    );
  };

  const renderFooter = () => {
    if (isLoadingMore) {
      return (
        <View style={{ paddingVertical: 20, alignItems: "center" }}>
          <ActivityIndicator size="small" color={theme.colors.themeColor} />
          <Text style={{ marginTop: 8, fontSize: 12, color: theme.colors.placeHolderTextColor }}>Loading more messages...</Text>
        </View>
      );
    }
    if (!hasMoreMessages && messages.length > 0 && !isSearching) {
      return (
        <View style={{ paddingVertical: 15, alignItems: "center" }}>
          <View style={{ backgroundColor: theme.colors.menuBackground, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 }}>
            <Text style={{ fontSize: 12, color: theme.colors.placeHolderTextColor }}>📜 No more messages</Text>
          </View>
        </View>
      );
    }
    return null;
  };

  return (
    <KeyboardAvoidingView 
      style={{ flex: 1, backgroundColor: theme.colors.background, marginBottom:keyboardHeight }} 
      behavior={Platform.OS === "ios" ? "padding" : undefined} 
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <Animated.View style={{ flex: 1 }}>
        {/* Header */}
        <View style={{ width: "100%", flexDirection: "row", alignItems: "center", padding: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.borderColor, gap: 10 }}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={{ width: 40, height: 40, justifyContent: "center", alignItems: "center" }}>
            <FontAwesome6 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
          </TouchableOpacity>
          
          <TouchableOpacity style={{ width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" }}>
            {chatData.peerUser?.profileImage ? 
              <Image source={{ uri: chatData.peerUser.profileImage }} style={{ width: "100%", height: "100%", borderRadius: 24 }} /> : 
              <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", backgroundColor: getUserColor(chatData.peerUser?._id || "") }}>
                <Text style={{ color: theme.colors.textWhite, fontFamily: "Poppins-Medium", fontSize: 18 }}>
                  {chatData.peerUser?.fullName?.charAt(0).toUpperCase() || "?"}
                </Text>
              </View>
            }
          </TouchableOpacity>
          
          <View style={{ flex: 1 }}>
            <Text style={{ color: theme.colors.primaryTextColor, fontFamily: "Poppins-Medium", fontSize: 16 }}>
              {chatData.peerUser?.fullName || "Unknown User"}
            </Text>
            {/* FIXED: Use isPeerTyping for typing indicator color */}
            <Text style={{ 
              color: isPeerTyping ? theme.colors.themeColor : theme.colors.placeHolderTextColor, 
              fontFamily: "Poppins-Medium", 
              fontSize: 12, 
              fontStyle: isPeerTyping ? 'italic' : 'normal' 
            }}>
              {renderStatusText()}
            </Text>
          </View>
          
          {selectedMessage.length > 0 && (
            <>
              <TouchableOpacity onPress={handleDeleteSelected} style={{ padding: 10, borderRadius: 20, backgroundColor: "#FF3B30", marginRight: 5 }}>
                <Ionicons name="trash" size={18} color="#fff" />
              </TouchableOpacity>
              <View style={{ padding: 10, borderRadius: 20, backgroundColor: theme.colors.menuBackground}}>
                <Text style={{ fontFamily: "Poppins-Medium", fontSize: 12, color: theme.colors.primaryTextColor}}>
                  {selectedMessage.length}
                </Text>
              </View>
            </>
          )}
        </View>

        {/* Search Bar */}
        <View style={{ flexDirection: "row", padding: 10, alignItems: "center", borderBottomWidth: 1, borderBottomColor: theme.colors.borderColor }}>
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", backgroundColor: theme.colors.menuBackground, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 8 }}>
            <Ionicons name="search" size={18} color={theme.colors.placeHolderTextColor} style={{ marginRight: 8 }} />
            <TextInput 
              placeholder="Search messages..." 
              value={search} 
              onChangeText={handleSearch} 
              placeholderTextColor={theme.colors.placeHolderTextColor} 
              returnKeyType="search" 
              autoCorrect={false} 
              style={{ flex: 1, fontSize: 14, color: theme.colors.primaryTextColor, fontFamily: "Poppins-Regular" }} 
            />
            {search.length > 0 && (
              <TouchableOpacity onPress={clearSearch} style={{ marginLeft: 4 }}>
                <Ionicons name="close-circle" size={18} color={theme.colors.placeHolderTextColor} />
              </TouchableOpacity>
            )}
          </View>
          
          {isSearching && searchResults.length > 0 && (
            <View style={{ flexDirection: 'row', marginLeft: 8, gap: 4 }}>
              <View style={{ backgroundColor: theme.colors.menuBackground, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12 }}>
                <Text style={{ fontSize: 10, color: theme.colors.primaryTextColor }}>
                  {currentSearchIndex + 1}/{searchResults.length}
                </Text>
              </View>
              <TouchableOpacity onPress={goToPreviousResult} style={{ backgroundColor: theme.colors.menuBackground, padding: 6, borderRadius: 12 }}>
                <Ionicons name="chevron-up" size={16} color={theme.colors.primaryTextColor} />
              </TouchableOpacity>
              <TouchableOpacity onPress={goToNextResult} style={{ backgroundColor: theme.colors.menuBackground, padding: 6, borderRadius: 12 }}>
                <Ionicons name="chevron-down" size={16} color={theme.colors.primaryTextColor} />
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Messages List */}
        {isSearching && messages.length === 0 ? (
          <View style={{ flex: 1, justifyContent: "center", alignItems: "center", paddingVertical: 50 }}>
            <Ionicons name="search-outline" size={60} color={theme.colors.placeHolderTextColor} />
            <Text style={{ marginTop: 20, fontSize: 16, color: theme.colors.placeHolderTextColor }}>No messages found</Text>
          </View>
        ) : (
          <FlatList 
            ref={flatListRef} 
            data={messages} 
            keyExtractor={(item) => item.id || `msg-${item.timestamp}`} 
            renderItem={renderChatsItem} 
            inverted 
            keyboardShouldPersistTaps="handled" 
            contentContainerStyle={{ paddingBottom: 10, paddingTop: 10 }} 
            showsVerticalScrollIndicator={false} 
            
            // FIXED: Use renderHeader for typing indicator
            ListFooterComponent={renderHeader}
            onEndReached={!isSearching ? loadMoreMessages : undefined} 
            onEndReachedThreshold={0.1} 
            
            onScroll={handleScroll}
            scrollEventThrottle={16}
            
            refreshControl={
              isAtTop ? (
                <RefreshControl 
                  refreshing={isRefreshing} 
                  onRefresh={onRefresh} 
                  tintColor={theme.colors.themeColor} 
                  colors={[theme.colors.themeColor]} 
                />
              ) : undefined
            }
            
            removeClippedSubviews={false} 
            maxToRenderPerBatch={15} 
            updateCellsBatchingPeriod={50} 
            windowSize={10} 
            onScrollToIndexFailed={(info) => { console.warn("Scroll to index failed:", info); }} 
          />
        )}

        {/* Input Bar */}
        <View style={{ flexDirection: "row", padding: 10, alignItems: "center", marginBottom: 0, borderTopWidth: 1, borderTopColor: theme.colors.borderColor }}>
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", backgroundColor: theme.colors.menuBackground, borderRadius: 40, borderWidth: 1, borderColor: theme.colors.borderColor, paddingHorizontal: 12, paddingVertical: Platform.OS === "ios" ? 10 : 6, marginRight: 10 }}>
            {pendingMedia ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                <Image source={{ uri: pendingMedia.file.uri }} style={{ width: 48, height: 48, borderRadius: 8 }} />
                <Text style={{ color: theme.colors.primaryTextColor, flex: 1 }} numberOfLines={2}>
                  {pendingMedia.file.name || 'Media ready to send'}
                </Text>
                <TouchableOpacity onPress={() => setPendingMedia(null)}>
                  <Ionicons name="close-circle" size={20} color={theme.colors.placeHolderTextColor} />
                </TouchableOpacity>
              </View>
            ) : (
              <TextInput 
                placeholder="Type a message" 
                value={text} 
                onChangeText={handleTextChange} 
                multiline 
                textAlignVertical="top" 
                placeholderTextColor={theme.colors.placeHolderTextColor} 
                editable={!isSearching} 
                style={{ flex: 1, fontSize: 14, color: theme.colors.primaryTextColor, fontFamily: "Poppins-Regular", maxHeight: 100 }} 
              />
            )}
            <TouchableOpacity onPress={openMediaOptions} style={{ width:40, height:40, justifyContent:"center", alignItems:"center", borderRadius:50 }} >
              <Ionicons name="attach" size={26} color={ theme.colors.primaryTextColor } />
            </TouchableOpacity>
          </View>

          <TouchableOpacity 
            onPress={async () => {
              if (pendingMedia) {
                await sendMedia(pendingMedia);
              } else {
                await handleSendText();
              }
            }} 
            disabled={(!text.trim() && !pendingMedia) || isSearching} 
            style={{ 
              width: 48, 
              height: 48, 
              borderRadius: 24, 
              backgroundColor: ((!text.trim() && !pendingMedia) || isSearching) ? theme.colors.menuBackground : (chatColor || theme.colors.themeColor), 
              alignItems: "center", 
              justifyContent: "center", 
              opacity: ((!text.trim() && !pendingMedia) || isSearching) ? 0.5 : 1 
            }}>
            <AntDesign name="send" size={20} color={theme.colors.textWhite} />
          </TouchableOpacity>
        </View>

        {/* Media options modal */}
        <Modal visible={showMediaOptions} transparent animationType="fade" onRequestClose={closeMediaOptions}>
          <TouchableOpacity onPress={closeMediaOptions} style={{ flex:1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }} activeOpacity={1}>
            <View style={{ backgroundColor: theme.colors.background, padding: 16, borderTopLeftRadius: 12, borderTopRightRadius: 12 }}>
              <Text style={{ fontSize: 16, fontFamily: 'Poppins-Medium', color: theme.colors.primaryTextColor, marginBottom: 12 }}>Send Media</Text>
              <TouchableOpacity onPress={() => handlePickMedia('image')} style={{ paddingVertical: 12 }}>
                <Text style={{ color: theme.colors.primaryTextColor }}>Photo</Text>
              </TouchableOpacity>
              {/* <TouchableOpacity onPress={() => handlePickMedia('video')} style={{ paddingVertical: 12 }}>
                <Text style={{ color: theme.colors.primaryTextColor }}>Video</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => handlePickMedia('document')} style={{ paddingVertical: 12 }}>
                <Text style={{ color: theme.colors.primaryTextColor }}>Document</Text>
              </TouchableOpacity> */}
              <TouchableOpacity onPress={closeMediaOptions} style={{ paddingVertical: 12 }}>
                <Text style={{ color: '#FF3B30' }}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>

        {/* Media viewer modal */}
        <Modal visible={mediaViewer.visible} transparent animationType="fade" onRequestClose={closeMediaViewer}>
          <TouchableOpacity activeOpacity={1} onPress={closeMediaViewer} style={{ flex:1, backgroundColor: 'rgba(0,0,0,0.95)', justifyContent: 'center', alignItems: 'center' }}>
            {mediaViewer.type === 'image' && mediaViewer.uri && (
              <Image source={{ uri: mediaViewer.uri }} style={{ width: '100%', height: '100%', resizeMode: 'contain' }} />
            )}
          </TouchableOpacity>
        </Modal>
      </Animated.View>
    </KeyboardAvoidingView>
  );
}