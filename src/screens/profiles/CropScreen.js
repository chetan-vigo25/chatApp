import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  ActivityIndicator,
  Alert,
  Image,
  PanResponder,
  Modal
} from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';
import { AntDesign, MaterialIcons, Feather } from '@expo/vector-icons';
import * as ImageManipulator from 'expo-image-manipulator';

const { width, height } = Dimensions.get('window');
const CROP_SIZE = width - 40;

export default function CropScreen({ navigation, route }) {
  const { theme } = useTheme();
  const { imageUri, onCropComplete } = route.params || {};
  const [isProcessing, setIsProcessing] = useState(false);
  const [imageDimensions, setImageDimensions] = useState({ width: 0, height: 0 });
  
  // Transform values
  const scale = useRef(1);
  const lastScale = useRef(1);
  const offsetX = useRef(0);
  const offsetY = useRef(0);
  const lastOffsetX = useRef(0);
  const lastOffsetY = useRef(0);
  
  const [transform, setTransform] = useState({
    scale: 1,
    translateX: 0,
    translateY: 0
  });

  // Get image dimensions on load
  const onImageLoad = (event) => {
    const { width, height } = event.nativeEvent.source;
    setImageDimensions({ width, height });
  };

  // Calculate max offset based on scale
  const getMaxOffset = () => {
    const scaledSize = CROP_SIZE * transform.scale;
    const maxOffset = (scaledSize - CROP_SIZE) / 2;
    return maxOffset;
  };

  // Pan responder for dragging
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        lastOffsetX.current = offsetX.current;
        lastOffsetY.current = offsetY.current;
      },
      onPanResponderMove: (evt, gestureState) => {
        const maxOffset = getMaxOffset();
        
        let newX = lastOffsetX.current + gestureState.dx;
        let newY = lastOffsetY.current + gestureState.dy;
        
        // Limit dragging to prevent image from moving out of crop area
        newX = Math.min(Math.max(newX, -maxOffset), maxOffset);
        newY = Math.min(Math.max(newY, -maxOffset), maxOffset);
        
        offsetX.current = newX;
        offsetY.current = newY;
        
        setTransform(prev => ({
          ...prev,
          translateX: newX,
          translateY: newY
        }));
      },
    })
  ).current;

  // Handle pinch to zoom
  const handlePinch = (event) => {
    const newScale = Math.min(Math.max(lastScale.current * event.nativeEvent.scale, 1), 3);
    scale.current = newScale;
    
    // Adjust offset to keep image centered while zooming
    const maxOffset = (CROP_SIZE * (newScale - 1)) / 2;
    offsetX.current = Math.min(Math.max(offsetX.current, -maxOffset), maxOffset);
    offsetY.current = Math.min(Math.max(offsetY.current, -maxOffset), maxOffset);
    
    setTransform({
      scale: newScale,
      translateX: offsetX.current,
      translateY: offsetY.current
    });
  };

  const handlePinchStart = () => {
    lastScale.current = scale.current;
  };

  const handlePinchEnd = () => {
    lastScale.current = scale.current;
  };

  // Crop and save function
  const handleCropAndSave = async () => {
    try {
      setIsProcessing(true);

      // Calculate crop region based on current transform
      const visibleWidth = CROP_SIZE / transform.scale;
      const visibleHeight = CROP_SIZE / transform.scale;
      
      // Calculate offset in image coordinates
      const offsetInImageX = -transform.translateX / transform.scale;
      const offsetInImageY = -transform.translateY / transform.scale;

      // Calculate crop origin (center of image)
      const imageCenterX = imageDimensions.width / 2;
      const imageCenterY = imageDimensions.height / 2;
      
      const cropX = Math.max(0, Math.min(
        imageDimensions.width - visibleWidth,
        imageCenterX - visibleWidth / 2 + offsetInImageX
      ));
      
      const cropY = Math.max(0, Math.min(
        imageDimensions.height - visibleHeight,
        imageCenterY - visibleHeight / 2 + offsetInImageY
      ));

      // Crop and resize the image
      const manipResult = await ImageManipulator.manipulateAsync(
        imageUri,
        [
          {
            crop: {
              originX: cropX,
              originY: cropY,
              width: visibleWidth,
              height: visibleHeight,
            }
          },
          {
            resize: {
              width: 500,
              height: 500,
            }
          }
        ],
        {
          compress: 0.8,
          format: ImageManipulator.SaveFormat.JPEG,
        }
      );

      // Return the cropped image
      if (onCropComplete) {
        onCropComplete(manipResult.uri);
      }

      // Go back
      navigation.goBack();

    } catch (error) {
      console.error('Error cropping image:', error);
      Alert.alert('Error', 'Failed to crop image. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  };

  // Reset transformations
  const resetTransform = () => {
    scale.current = 1;
    lastScale.current = 1;
    offsetX.current = 0;
    offsetY.current = 0;
    lastOffsetX.current = 0;
    lastOffsetY.current = 0;
    
    setTransform({
      scale: 1,
      translateX: 0,
      translateY: 0
    });
  };

  // Zoom in
  const zoomIn = () => {
    const newScale = Math.min(scale.current + 0.5, 3);
    scale.current = newScale;
    lastScale.current = newScale;
    
    const maxOffset = (CROP_SIZE * (newScale - 1)) / 2;
    offsetX.current = Math.min(Math.max(offsetX.current, -maxOffset), maxOffset);
    offsetY.current = Math.min(Math.max(offsetY.current, -maxOffset), maxOffset);
    
    setTransform({
      scale: newScale,
      translateX: offsetX.current,
      translateY: offsetY.current
    });
  };

  // Zoom out
  const zoomOut = () => {
    const newScale = Math.max(scale.current - 0.5, 1);
    scale.current = newScale;
    lastScale.current = newScale;
    
    const maxOffset = (CROP_SIZE * (newScale - 1)) / 2;
    offsetX.current = Math.min(Math.max(offsetX.current, -maxOffset), maxOffset);
    offsetY.current = Math.min(Math.max(offsetY.current, -maxOffset), maxOffset);
    
    setTransform({
      scale: newScale,
      translateX: offsetX.current,
      translateY: offsetY.current
    });
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: theme.colors.borderColor }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerButton}>
          <AntDesign name="close" size={24} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.primaryTextColor }]}>
          Crop & Edit
        </Text>
        <TouchableOpacity 
          onPress={handleCropAndSave} 
          style={styles.headerButton}
          disabled={isProcessing}
        >
          {isProcessing ? (
            <ActivityIndicator size="small" color={theme.colors.themeColor} />
          ) : (
            <MaterialIcons name="done" size={24} color={theme.colors.themeColor} />
          )}
        </TouchableOpacity>
      </View>

      {/* Image Container with Crop Overlay */}
      <View 
        style={styles.cropContainer}
        onTouchStart={handlePinchStart}
      >
        {/* Crop Overlay */}
        <View style={styles.cropOverlay}>
          <View style={styles.cropArea} />
          <View style={[styles.grid, styles.gridRow1]} />
          <View style={[styles.grid, styles.gridRow2]} />
          <View style={[styles.grid, styles.gridCol1]} />
          <View style={[styles.grid, styles.gridCol2]} />
        </View>

        {/* Image with Pan and Pinch */}
        <View 
          {...panResponder.panHandlers}
          onPinchStart={handlePinchStart}
          onPinchEnd={handlePinchEnd}
          onPinch={handlePinch}
          style={styles.imageWrapper}
        >
          <Image
            source={{ uri: imageUri }}
            style={[
              styles.image,
              {
                transform: [
                  { scale: transform.scale },
                  { translateX: transform.translateX },
                  { translateY: transform.translateY }
                ]
              }
            ]}
            onLoad={onImageLoad}
            resizeMode="contain"
          />
        </View>
      </View>

      {/* Zoom Controls */}
      <View style={styles.controlsContainer}>
        <TouchableOpacity 
          style={[styles.controlButton, { backgroundColor: theme.colors.cardBackground }]}
          onPress={zoomOut}
        >
          <Feather name="zoom-out" size={24} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
        
        <TouchableOpacity 
          style={[styles.controlButton, { backgroundColor: theme.colors.cardBackground }]}
          onPress={resetTransform}
        >
          <MaterialIcons name="refresh" size={24} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
        
        <TouchableOpacity 
          style={[styles.controlButton, { backgroundColor: theme.colors.cardBackground }]}
          onPress={zoomIn}
        >
          <Feather name="zoom-in" size={24} color={theme.colors.primaryTextColor} />
        </TouchableOpacity>
      </View>

      {/* Instruction Text */}
      <Text style={[styles.hintText, { color: theme.colors.placeHolderTextColor }]}>
        Pinch to zoom • Drag to reposition
      </Text>

      {/* Processing Modal */}
      <Modal transparent visible={isProcessing}>
        <View style={styles.modalContainer}>
          <View style={[styles.modalContent, { backgroundColor: theme.colors.cardBackground }]}>
            <ActivityIndicator size="large" color={theme.colors.themeColor} />
            <Text style={[styles.modalText, { color: theme.colors.primaryTextColor }]}>
              Processing image...
            </Text>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
  },
  headerButton: {
    padding: 8,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: 'Roboto-Medium',
  },
  cropContainer: {
    width: CROP_SIZE,
    height: CROP_SIZE,
    alignSelf: 'center',
    marginTop: 20,
    overflow: 'hidden',
    borderRadius: 10,
    backgroundColor: '#000',
  },
  cropOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cropArea: {
    width: CROP_SIZE,
    height: CROP_SIZE,
    borderWidth: 2,
    borderColor: '#fff',
    backgroundColor: 'transparent',
  },
  grid: {
    position: 'absolute',
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  gridRow1: {
    top: CROP_SIZE / 3,
    left: 0,
    right: 0,
    height: 1,
  },
  gridRow2: {
    top: (CROP_SIZE / 3) * 2,
    left: 0,
    right: 0,
    height: 1,
  },
  gridCol1: {
    left: CROP_SIZE / 3,
    top: 0,
    bottom: 0,
    width: 1,
  },
  gridCol2: {
    left: (CROP_SIZE / 3) * 2,
    top: 0,
    bottom: 0,
    width: 1,
  },
  imageWrapper: {
    width: CROP_SIZE,
    height: CROP_SIZE,
  },
  image: {
    width: CROP_SIZE,
    height: CROP_SIZE,
  },
  controlsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 20,
    gap: 20,
  },
  controlButton: {
    width: 50,
    height: 50,
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  hintText: {
    marginTop: 20,
    fontSize: 14,
    fontFamily: 'Roboto-Regular',
    textAlign: 'center',
  },
  modalContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  modalContent: {
    padding: 20,
    borderRadius: 10,
    alignItems: 'center',
    gap: 10,
  },
  modalText: {
    fontSize: 16,
    fontFamily: 'Roboto-Medium',
  },
});