import React, { useState, useEffect, useRef } from "react";
import { 
  View, 
  Text, 
  Image, 
  Animated, 
  TouchableOpacity, 
  ActivityIndicator,
  Dimensions,
  FlatList,
  StyleSheet
} from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { useDispatch, useSelector } from "react-redux";
import { profileDetail } from "../../Redux/Reducer/Profile/Profile.reducer";
import { AntDesign, FontAwesome5, MaterialIcons, } from '@expo/vector-icons';

const { width } = Dimensions.get('window');
const headerHeight = 300;
const headerFinalHeight = 70;
const imageSize = (headerHeight / 3.5) * 2;

const AnimatedFlatList = Animated.createAnimatedComponent(FlatList);

export default function UserB({ navigation, route }) {
  const { item: routeItem } = route.params || {};
  const { theme } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scrollY = useRef(new Animated.Value(0)).current;
  const dispatch = useDispatch();
  const { profileData, isLoading } = useSelector(state => state.profile);
  const [nameWidth, setNameWidth] = useState(0);

  // Normalize peer object
  const peer = routeItem?.peerUser ? routeItem.peerUser : (routeItem || {});
  const peerId = peer?._id || peer?.userId || peer?.id || null;

  useEffect(() => {
    if (peerId) {
      dispatch(profileDetail(peerId));
    }
  }, [peerId, dispatch]);

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

  const offset = headerHeight - headerFinalHeight;

  // Header animations
  const translateHeader = scrollY.interpolate({
    inputRange: [0, offset],
    outputRange: [0, -offset],
    extrapolate: 'clamp',
  });

  // Image animations
  const translateImageY = scrollY.interpolate({
    inputRange: [0, offset],
    outputRange: [0, -(headerFinalHeight - headerHeight) / 2],
    extrapolate: 'clamp',
  });

  const translateImageX = scrollY.interpolate({
    inputRange: [0, offset],
    outputRange: [
      -40, // Initial left offset
      -(width / 2) + (imageSize * headerFinalHeight) / headerHeight + 5
    ],
    extrapolate: 'clamp',
  });

  const scaleImage = scrollY.interpolate({
    inputRange: [0, offset],
    outputRange: [1, headerFinalHeight / headerHeight],
    extrapolate: 'clamp',
  });

  // Username animations with proper positioning
  const collapsedImageSize = (imageSize * headerFinalHeight) / headerHeight;
  
  // Calculate name position based on image position
  const translateName = scrollY.interpolate({
    inputRange: [0, offset],
    outputRange: [
      20, // Initial position - small gap from center
      collapsedImageSize + 25 // Final position - right after image with proper gap
    ],
    extrapolate: 'clamp',
  });

  // Scale animation for name (slightly smaller when collapsed)
  const scaleName = scrollY.interpolate({
    inputRange: [0, offset],
    outputRange: [1, 0.85],
    extrapolate: 'clamp',
  });

  // Back button animation
  const backButtonOpacity = scrollY.interpolate({
    inputRange: [0, offset],
    outputRange: [1, 1],
    extrapolate: 'clamp',
  });

  const pastelColors = ["#FF5C5C", "#8AFF8A", "#FFC0CB", "#ADADAD", "#BAE1FF"];
  
  function getUserColor(str) {
    if (!str) return pastelColors[0];
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % pastelColors.length;
    return pastelColors[index];
  }

  // Display name
  const displayName = (profileData?.fullName) || peer?.fullName || peer?.name || peer?.username || "User";
  const initial = (displayName && displayName.length > 0) ? displayName.charAt(0).toUpperCase() : '?';

  // Image source
  const reduxImage = profileData?.profileImage;
  const peerImage = peer?.profileImage || peer?.profilePicture || peer?.profilePictureUri;
  const imageSource = reduxImage
    ? (typeof reduxImage === 'string' ? { uri: reduxImage } : reduxImage)
    : (peerImage ? { uri: peerImage } : null);

  // Generate data for FlatList
    const generateData = () => {
      const items = [
        { id: 'header', type: 'header' },
        { id: 'about', type: 'section', title: 'About', icon: 'exclamation-circle', iconFamily: 'AntDesign', value: profileData?.about ?? peer?.about ?? '' },
        { id: 'number', type: 'section', title: 'Mobile', icon: 'call', iconFamily: 'MaterialIcons', value: profileData?.mobile?.number ?? peer?.mobile?.number ?? '' },
        { id: 'email', type: 'section', title: 'Email', icon: 'email', iconFamily: 'MaterialIcons', value: profileData?.email ?? peer?.email ?? '' },
      ];
      return items;
    };

  const DATA = generateData();

  const renderHeader = () => (
    <Animated.View
      style={[
        styles.header,
        { 
          transform: [{ translateY: translateHeader }],
          backgroundColor: theme.colors.background,
          borderBottomColor: theme.colors.borderColor,
        }
      ]}
    >
      <Animated.View
        style={[
          styles.image,
          {
            transform: [
              { translateX: translateImageX },
              { translateY: translateImageY },
              { scale: scaleImage },
            ],
          },
        ]}
      >
        {imageSource ? (
          <Image
            source={imageSource}
            style={styles.img}
            resizeMode="cover"
          />
        ) : (
          <View style={[styles.img, { 
            backgroundColor: getUserColor(peer?._id || peer?.fullName || ""),
            justifyContent: 'center',
            alignItems: 'center'
          }]}>
            <Text style={{ 
              color: theme.colors.textWhite, 
              fontFamily: 'Poppins-Medium', 
              fontSize: imageSize * 0.4,
              textTransform: 'uppercase' 
            }}>
              {initial}
            </Text>
          </View>
        )}
      </Animated.View>

      {/* Username with proper positioning and maxWidth */}
      <Animated.View
        style={[
          styles.nameWrapper,
          {
            transform: [
              { translateX: translateName },
              { scale: scaleName }
            ],
          },
        ]}
      >
        <Text
          onLayout={(e) => setNameWidth(e.nativeEvent.layout.width)}
          style={[
            styles.name,
            {
              color: theme.colors.primaryTextColor,
            },
          ]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {displayName}
        </Text>
      </Animated.View>
    </Animated.View>
  );

 const renderSection = ({ item }) => {
    if (item.type === 'header') {
      return renderHeader();
    }

    let IconComponent;
    switch (item.iconFamily) {
      case 'AntDesign':
        IconComponent = AntDesign;
        break;
      case 'FontAwesome5':
        IconComponent = FontAwesome5;
        break;
      case 'MaterialIcons':
        IconComponent = MaterialIcons;
        break;
      default:
        IconComponent = AntDesign;
    }

    return (
      <View style={styles.sectionContainer}>
        <View style={[
          styles.sectionRow,
          { borderBottomColor: theme.colors.borderColor }
        ]}>
          <View style={styles.iconContainer}>
            <IconComponent name={item.icon} size={20} color={theme.colors.placeHolderTextColor} />
          </View>
          <View style={styles.textContainer}>
            <Text style={[styles.sectionTitle, { color: theme.colors.primaryTextColor }]}>
              {item.title}
            </Text>
            <Text style={[styles.sectionValue, { color: theme.colors.placeHolderTextColor }]}>
              {item.value || 'Not provided'}
            </Text>
          </View>
        </View>
      </View>
    );
  };

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: theme.colors.background }}>
        <ActivityIndicator size="large" color={theme.colors.themeColor} />
      </View>
    );
  }

  return (
    <Animated.View style={{ flex: 1, opacity: fadeAnim, backgroundColor: theme.colors.background }}>
      {/* Back Button */}
      <Animated.View
        style={[
          styles.backButtonContainer,
          { opacity: backButtonOpacity }
        ]}
      >
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
        >
          <FontAwesome5 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
      </Animated.View>

      <AnimatedFlatList
        data={DATA}
        renderItem={renderSection}
        keyExtractor={item => item.id}
        stickyHeaderIndices={[0]}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true }
        )}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  listContent: {
    paddingBottom: 20,
  },
  header: {
    height: headerHeight,
    marginBottom: 5,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 0.5,
    paddingLeft: 50, // Space for back button
  },
  image: {
    height: imageSize,
    width: imageSize,
    borderRadius: headerHeight,
    backgroundColor: '#fff',
    overflow: 'hidden',
  },
  img: {
    height: '100%',
    width: '100%',
  },
  // Name wrapper with proper constraints
  nameWrapper: {
    position: 'absolute',
    bottom: 0,
    height: headerFinalHeight,
    justifyContent: 'center',
    left: 20, // Start after back button
    right: 0, // Prevent overflow on right side
    maxWidth: width - 200, // Ensure name doesn't overflow
  },
  name: {
    fontSize: 18,
    fontFamily: 'Poppins-Medium',
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  backButtonContainer: {
    position: 'absolute',
    left: 10,
    top: 10,
    zIndex: 1000,
    borderRadius: 22,
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sectionContainer: {
    width: '100%',
    marginBottom: 0,
    paddingHorizontal: 20,
  },
  sectionRow: {
    width: '100%',
    minHeight: 40,
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    borderBottomWidth: 0,
    marginBottom: 0,
    paddingVertical: 10,
  },
  iconContainer: {
    width: 30,
    height: 30,
    justifyContent: "center",
    alignItems: 'center',
    borderRadius: 50,
  },
  textContainer: {
    flex: 1,
  },
  sectionTitle: {
    fontFamily: 'Poppins-Medium',
    fontSize: 14,
  },
  sectionValue: {
    fontFamily: 'Poppins-Medium',
    fontSize: 12,
  },
});
