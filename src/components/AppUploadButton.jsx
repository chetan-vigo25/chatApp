import React, { useState, useRef } from 'react';
import { View, TouchableOpacity, Animated, StyleSheet, Text, Platform, Pressable, Modal } from 'react-native';
import { Ionicons, MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';

const CATEGORY_OPTIONS = [
  {
    key: 'photo',
    icon: <Ionicons name="image" size={28} color="#075e54" />, // WhatsApp green
    label: 'Photo/Video',
    testID: 'option-photo',
  },
  {
    key: 'video',
    icon: <MaterialIcons name="videocam" size={28} color="#075e54" />,
    label: 'Video',
    testID: 'option-video',
  },
  {
    key: 'audio',
    icon: <MaterialCommunityIcons name="microphone" size={28} color="#075e54" />,
    label: 'Audio',
    testID: 'option-audio',
  },
  {
    key: 'document',
    icon: <MaterialIcons name="attach-file" size={28} color="#075e54" />,
    label: 'Document',
    testID: 'option-document',
  },
  // Optional: Location, Contact
];

export default function AppUploadButton({ onSelectCategory }) {
  const [expanded, setExpanded] = useState(false);
  const animation = useRef(new Animated.Value(0)).current;

  const handleToggle = () => {
    setExpanded((prev) => !prev);
    Animated.timing(animation, {
      toValue: expanded ? 0 : 1,
      duration: expanded ? 150 : 200,
      useNativeDriver: true,
      easing: expanded ? undefined : undefined,
    }).start();
  };

  const handleSelect = (key) => {
    setExpanded(false);
    Animated.timing(animation, {
      toValue: 0,
      duration: 150,
      useNativeDriver: true,
    }).start(() => {
      if (onSelectCategory) onSelectCategory(key);
    });
  };

  // Animate menu slide-up
  const translateY = animation.interpolate({
    inputRange: [0, 1],
    outputRange: [60, 0],
  });
  const opacity = animation.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

  return (
    <View style={styles.root} pointerEvents="box-none">
      {/* Backdrop */}
      {expanded && (
        <Pressable
          style={styles.backdrop}
          onPress={handleToggle}
          accessibilityLabel="Dismiss upload options"
          accessibilityRole="button"
        />
      )}
      {/* Options Menu */}
      <Animated.View
        style={[
          styles.menu,
          {
            opacity,
            transform: [{ translateY }],
            pointerEvents: expanded ? 'auto' : 'none',
          },
        ]}
        accessibilityViewIsModal={expanded}
        accessibilityLabel="Media upload options"
      >
        {CATEGORY_OPTIONS.map((opt, idx) => (
          <TouchableOpacity
            key={opt.key}
            style={styles.option}
            onPress={() => handleSelect(opt.key)}
            accessibilityLabel={opt.label}
            accessibilityRole="button"
            testID={opt.testID}
          >
            {opt.icon}
            <Text style={styles.optionLabel}>{opt.label}</Text>
          </TouchableOpacity>
        ))}
      </Animated.View>
      {/* Main Upload Button */}
      <TouchableOpacity
        style={styles.fab}
        onPress={handleToggle}
        accessibilityLabel="Attach media"
        accessibilityRole="button"
        testID="upload-fab"
      >
        <MaterialIcons name="attach-file" size={28} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    zIndex: 100,
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#25d366', // WhatsApp green
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  menu: {
    position: 'absolute',
    bottom: 72,
    right: 0,
    backgroundColor: 'rgba(255,255,255,0.98)',
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 0,
    minWidth: 180,
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  optionLabel: {
    marginLeft: 16,
    fontSize: 16,
    color: '#222',
    fontWeight: '500',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.18)',
    zIndex: 1,
  },
});