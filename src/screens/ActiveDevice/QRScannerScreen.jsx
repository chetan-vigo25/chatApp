import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Dimensions,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { CameraView } from 'expo-camera';
import { FontAwesome6, MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import useQRScanner from '../../hooks/useQRScanner';
import useLinkDevice from '../../hooks/useLinkDevice';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const SCAN_AREA_SIZE = SCREEN_WIDTH * 0.7;

export default function QRScannerScreen({ navigation }) {
  const { theme } = useTheme();
  const scanLineAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const {
    hasPermission,
    canAskPermission,
    requestPermission,
    scannedData,
    error: scanError,
    handleBarCodeScanned,
    reset: resetScanner,
  } = useQRScanner();

  const {
    linkDevice,
    isLinking,
    linkError,
    linkSuccess,
    linkedDevice,
    reset: resetLink,
  } = useLinkDevice();

  // Fade in on mount
  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, []);

  // Animate scan line
  useEffect(() => {
    if (hasPermission && !scannedData) {
      const animation = Animated.loop(
        Animated.sequence([
          Animated.timing(scanLineAnim, {
            toValue: 1,
            duration: 2500,
            useNativeDriver: true,
          }),
          Animated.timing(scanLineAnim, {
            toValue: 0,
            duration: 2500,
            useNativeDriver: true,
          }),
        ])
      );
      animation.start();
      return () => animation.stop();
    }
  }, [hasPermission, scannedData]);

  // Auto-link when QR is scanned
  useEffect(() => {
    if (scannedData) {
      linkDevice(scannedData);
    }
  }, [scannedData]);

  // Navigate to success on link
  useEffect(() => {
    if (linkSuccess && linkedDevice) {
      navigation.replace('DeviceLinkSuccess', { device: linkedDevice });
    }
  }, [linkSuccess, linkedDevice]);

  const handleRetry = () => {
    resetScanner();
    resetLink();
  };

  const scanLineTranslate = scanLineAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, SCAN_AREA_SIZE - 4],
  });

  // Permission not yet determined
  if (!hasPermission) {
    return (
      <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: theme.colors.background }]}>
        <Header theme={theme} navigation={navigation} />
        <View style={styles.centered}>
          <MaterialIcons name="camera-alt" size={64} color={theme.colors.placeHolderTextColor} />
          <Text style={[styles.permissionTitle, { color: theme.colors.primaryTextColor }]}>
            Camera Access Required
          </Text>
          <Text style={[styles.permissionText, { color: theme.colors.placeHolderTextColor }]}>
            To scan QR codes and link devices, we need access to your camera.
          </Text>
          {canAskPermission ? (
            <TouchableOpacity
              onPress={requestPermission}
              style={[styles.permissionBtn, { backgroundColor: theme.colors.themeColor }]}
            >
              <Text style={[styles.permissionBtnText, { color: theme.colors.textWhite }]}>
                Grant Permission
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={() => Linking.openSettings()}
              style={[styles.permissionBtn, { backgroundColor: theme.colors.themeColor }]}
            >
              <Text style={[styles.permissionBtnText, { color: theme.colors.textWhite }]}>
                Open Settings
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </Animated.View>
    );
  }

  const showError = scanError || linkError;

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: '#000' }]}>
      {/* Camera */}
      {!scannedData && (
        <CameraView
          style={StyleSheet.absoluteFillObject}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleBarCodeScanned}
        />
      )}

      {/* Overlay */}
      <View style={styles.overlay}>
        {/* Header */}
        <View style={styles.scanHeader}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <FontAwesome6 name="arrow-left" size={20} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.scanTitle}>Scan QR Code</Text>
          <View style={{ width: 40 }} />
        </View>

        {/* Instruction */}
        <Text style={styles.instruction}>
          Point your camera at the QR code displayed on the web browser
        </Text>

        {/* Scan Area */}
        <View style={styles.scanAreaContainer}>
          <View style={styles.scanArea}>
            {/* Corner markers */}
            <View style={[styles.corner, styles.topLeft]} />
            <View style={[styles.corner, styles.topRight]} />
            <View style={[styles.corner, styles.bottomLeft]} />
            <View style={[styles.corner, styles.bottomRight]} />

            {/* Scanning line */}
            {!scannedData && !showError && (
              <Animated.View
                style={[
                  styles.scanLine,
                  { transform: [{ translateY: scanLineTranslate }] },
                ]}
              />
            )}

            {/* Loading overlay */}
            {isLinking && (
              <View style={styles.scanOverlay}>
                <ActivityIndicator size="large" color="#25D366" />
                <Text style={styles.linkingText}>Linking device...</Text>
              </View>
            )}
          </View>
        </View>

        {/* Error / Retry */}
        {showError && (
          <View style={styles.errorContainer}>
            <MaterialIcons name="error-outline" size={24} color="#FF4444" />
            <Text style={styles.errorText}>{showError}</Text>
            <TouchableOpacity onPress={handleRetry} style={styles.retryBtn}>
              <MaterialIcons name="refresh" size={20} color="#fff" />
              <Text style={styles.retryText}>Try Again</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </Animated.View>
  );
}

function Header({ theme, navigation }) {
  return (
    <View style={[styles.header, { borderBottomColor: theme.colors.borderColor }]}>
      <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
        <FontAwesome6 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
      </TouchableOpacity>
      <Text style={[styles.headerTitle, { color: theme.colors.primaryTextColor }]}>
        Scan QR Code
      </Text>
    </View>
  );
}

const CORNER_SIZE = 24;
const CORNER_WIDTH = 3;

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    gap: 10,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 16,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  permissionTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 18,
    marginTop: 20,
    textAlign: 'center',
  },
  permissionText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 14,
    marginTop: 10,
    textAlign: 'center',
    lineHeight: 20,
  },
  permissionBtn: {
    marginTop: 24,
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 40,
  },
  permissionBtnText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 15,
  },
  // Scanner overlay
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  scanHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingTop: 16,
    paddingBottom: 10,
  },
  scanTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 18,
    color: '#fff',
  },
  instruction: {
    fontFamily: 'Roboto-Regular',
    fontSize: 14,
    color: 'rgba(255,255,255,0.8)',
    textAlign: 'center',
    marginHorizontal: 40,
    marginTop: 10,
  },
  scanAreaContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanArea: {
    width: SCAN_AREA_SIZE,
    height: SCAN_AREA_SIZE,
    backgroundColor: 'transparent',
    overflow: 'hidden',
  },
  corner: {
    position: 'absolute',
    width: CORNER_SIZE,
    height: CORNER_SIZE,
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderColor: '#25D366',
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderColor: '#25D366',
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderColor: '#25D366',
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderColor: '#25D366',
  },
  scanLine: {
    width: '100%',
    height: 2,
    backgroundColor: '#25D366',
  },
  scanOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkingText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
    color: '#fff',
    marginTop: 12,
  },
  errorContainer: {
    alignItems: 'center',
    paddingBottom: 60,
    paddingHorizontal: 30,
  },
  errorText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 14,
    color: '#FF4444',
    textAlign: 'center',
    marginTop: 8,
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 16,
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 40,
  },
  retryText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
    color: '#fff',
  },
});