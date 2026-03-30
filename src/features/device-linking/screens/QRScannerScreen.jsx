import React, { useEffect, useRef, useCallback, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Linking,
  Platform,
  ToastAndroid,
  Alert,
} from 'react-native';
import { CameraView } from 'expo-camera';
import { FontAwesome6, MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../../../contexts/ThemeContext';
import useQRScanner from '../hooks/useQRScanner';
import useDeviceLinking from '../hooks/useDeviceLinking';
import QROverlay from '../components/QROverlay';
import ScanConfirmSheet from '../components/ScanConfirmSheet';
import LinkingLoader from '../components/LinkingLoader';

function showToast(message) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    Alert.alert('', message);
  }
}

export default function QRScannerScreen({ navigation }) {
  const { theme } = useTheme();
  const scanLineAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scannedDataRef = useRef(null);

  const [linkSuccess, setLinkSuccess] = useState(false);
  const [linkErrorState, setLinkErrorState] = useState(null);

  const {
    hasPermission,
    canAskPermission,
    requestPermission,
    isScanning,
    scannedData,
    error: scanError,
    handleBarCodeScanned,
    resetScan,
    isServerUrlTrusted,
  } = useQRScanner();

  const {
    linkDevice,
    isLinking,
    error: linkError,
    clearError,
  } = useDeviceLinking();

  useEffect(() => {
    scannedDataRef.current = scannedData;
  }, [scannedData]);

  // Fade in on mount
  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, []);

  // Animate scan line while scanning
  useEffect(() => {
    if (hasPermission && isScanning && !scannedData) {
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
  }, [hasPermission, isScanning, scannedData]);

  const handleConfirmLink = useCallback(async () => {
    const data = scannedDataRef.current;
    if (!data) return;

    setLinkErrorState(null);

    try {
      const result = await linkDevice(data.sessionId, data.publicKey);

      if (result) {
        setLinkSuccess(true);
        showToast('Device linked!');

        // After success animation, go back to LinkedDevicesScreen so it refreshes the list
        setTimeout(() => {
          if (navigation.canGoBack()) {
            navigation.goBack();
          } else {
            navigation.navigate('LinkDevice');
          }
        }, 1500);
      } else {
        setLinkErrorState(linkError || 'Something went wrong. Please try again.');
      }
    } catch (err) {
      setLinkErrorState(err?.message || 'Something went wrong. Please try again.');
    }
  }, [linkDevice, linkError, navigation]);

  const handleCancel = useCallback(() => {
    resetScan();
    clearError();
    setLinkErrorState(null);
  }, [resetScan, clearError]);

  const handleTryAgain = useCallback(() => {
    resetScan();
    clearError();
    setLinkErrorState(null);
  }, [resetScan, clearError]);

  const handleGoBack = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  const activeError = linkErrorState || linkError;
  const showScanError = scanError && !scannedData;
  const showLinkError = activeError && scannedData && !isLinking && !linkSuccess;
  const isTrustedUrl = scannedData ? isServerUrlTrusted(scannedData.serverUrl) : true;

  // -- Permission screen --
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

  // -- Scanner screen --
  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: '#000' }]}>
      {/* Camera */}
      {!scannedData && !linkSuccess && (
        <CameraView
          style={StyleSheet.absoluteFillObject}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={isScanning ? handleBarCodeScanned : undefined}
        />
      )}

      {/* Overlay with cutout */}
      <QROverlay
        scanLineAnim={scanLineAnim}
        showScanLine={isScanning && !scannedData && !showScanError}
      />

      {/* Header */}
      <View style={styles.scanHeader}>
        <TouchableOpacity onPress={handleGoBack} style={styles.backBtn}>
          <FontAwesome6 name="arrow-left" size={20} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.scanTitle}>Scan QR Code</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Instruction text */}
      <Text style={styles.instruction}>
        Point your camera at the QR code displayed on the web browser
      </Text>

      {/* Scan error state */}
      {showScanError && (
        <View style={styles.errorContainer}>
          <MaterialIcons name="error-outline" size={28} color="#FF4444" />
          <Text style={styles.errorText}>{scanError}</Text>
          <View style={styles.errorButtons}>
            <TouchableOpacity onPress={handleTryAgain} style={styles.retryBtn}>
              <MaterialIcons name="refresh" size={18} color="#fff" />
              <Text style={styles.retryText}>Try Again</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleGoBack} style={styles.goBackBtn}>
              <Text style={styles.goBackText}>Go Back</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Link error state (after confirm failed) */}
      {showLinkError && (
        <View style={styles.errorContainer}>
          <MaterialIcons name="error-outline" size={28} color="#FF4444" />
          <Text style={styles.errorText}>{activeError}</Text>
          <View style={styles.errorButtons}>
            <TouchableOpacity onPress={handleTryAgain} style={styles.retryBtn}>
              <MaterialIcons name="refresh" size={18} color="#fff" />
              <Text style={styles.retryText}>Try Again</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleGoBack} style={styles.goBackBtn}>
              <Text style={styles.goBackText}>Go Back</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Confirmation bottom sheet */}
      {!showLinkError && (
        <ScanConfirmSheet
          visible={!!scannedData && !linkSuccess}
          qrData={scannedData}
          isLinking={isLinking}
          isTrustedUrl={isTrustedUrl}
          onConfirm={handleConfirmLink}
          onCancel={handleCancel}
        />
      )}

      {/* Loading / Success overlay */}
      <LinkingLoader visible={isLinking || linkSuccess} success={linkSuccess} />
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
  scanHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingTop: Platform.OS === 'ios' ? 50 : 16,
    paddingBottom: 10,
    zIndex: 10,
  },
  scanTitle: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 18,
    color: '#fff',
  },
  instruction: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 100 : 70,
    left: 0,
    right: 0,
    fontFamily: 'Roboto-Regular',
    fontSize: 14,
    color: 'rgba(255,255,255,0.8)',
    textAlign: 'center',
    marginHorizontal: 40,
    zIndex: 10,
  },
  errorContainer: {
    position: 'absolute',
    bottom: 80,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: 30,
    zIndex: 10,
  },
  errorText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 14,
    color: '#FF4444',
    textAlign: 'center',
    marginTop: 8,
  },
  errorButtons: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
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
  goBackBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 40,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  goBackText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
    color: '#fff',
  },
});