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
  Image,
  Easing,
} from 'react-native';
import { CameraView } from 'expo-camera';
import { FontAwesome6, MaterialIcons, Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../../contexts/ThemeContext';
import useQRScanner from '../hooks/useQRScanner';
import useDeviceLinking from '../hooks/useDeviceLinking';
import QROverlay from '../components/QROverlay';
import LinkingLoader from '../components/LinkingLoader';

function showToast(message) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    Alert.alert('', message);
  }
}

// TalksTry brand lockup — the app logo inside a softly-pulsing brand ring with
// the "TalksTry" wordmark beneath. Used on the permission prompt (onDark=false)
// and over the live camera (onDark). The pulse is the WhatsApp-style "we're
// listening" cue while the scanner waits for a code.
function BrandLockup({ theme, onDark = false, style }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 1800,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const brand = theme.colors.themeColor;
  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.7] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 0.12, 1], outputRange: [0, 0.45, 0] });

  return (
    <View style={[lockupStyles.wrap, style]}>
      <View style={lockupStyles.badgeWrap}>
        <Animated.View
          style={[lockupStyles.pulseRing, { borderColor: brand, transform: [{ scale: ringScale }], opacity: ringOpacity }]}
        />
        <View
          style={[
            lockupStyles.badge,
            {
              backgroundColor: onDark ? 'rgba(255,255,255,0.08)' : brand + '14',
              borderColor: onDark ? 'rgba(255,255,255,0.20)' : brand + '33',
            },
          ]}
        >
          <Image source={require('../../../../assets/icon.png')} style={lockupStyles.logo} />
        </View>
      </View>
      <Text style={[lockupStyles.word, { color: onDark ? '#fff' : theme.colors.primaryTextColor }]}>
        Talks<Text style={{ color: brand }}>Try</Text>
      </Text>
    </View>
  );
}

const lockupStyles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  badgeWrap: { width: 72, height: 72, alignItems: 'center', justifyContent: 'center' },
  pulseRing: { position: 'absolute', width: 64, height: 64, borderRadius: 20, borderWidth: 2 },
  badge: {
    width: 60, height: 60, borderRadius: 18, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  logo: { width: 38, height: 38, borderRadius: 9, resizeMode: 'contain' },
  word: { fontFamily: 'Roboto-Bold', fontSize: 17, marginTop: 8, letterSpacing: -0.2 },
});

export default function QRScannerScreen({ navigation }) {
  const { theme } = useTheme();
  const scanLineAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scannedDataRef = useRef(null);
  // Ensures the auto-link fires exactly once per successful scan.
  const autoTriggeredRef = useRef(false);

  const [linkSuccess, setLinkSuccess] = useState(false);
  const [linkErrorState, setLinkErrorState] = useState(null);
  const [torch, setTorch] = useState(false);

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

  const { linkDevice, isLinking, error: linkError, clearError } = useDeviceLinking();

  useEffect(() => {
    scannedDataRef.current = scannedData;
  }, [scannedData]);

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }).start();
  }, []);

  // Animate scan line while scanning
  useEffect(() => {
    if (hasPermission && isScanning && !scannedData) {
      const animation = Animated.loop(
        Animated.sequence([
          Animated.timing(scanLineAnim, { toValue: 1, duration: 2400, useNativeDriver: true }),
          Animated.timing(scanLineAnim, { toValue: 0, duration: 2400, useNativeDriver: true }),
        ])
      );
      animation.start();
      return () => animation.stop();
    }
  }, [hasPermission, isScanning, scannedData]);

  // The link flow — runs automatically as soon as a valid QR is scanned.
  const runLink = useCallback(async () => {
    const data = scannedDataRef.current;
    if (!data) return;
    setLinkErrorState(null);
    try {
      const result = await linkDevice(data.sessionId, data.publicKey);
      if (result) {
        setLinkSuccess(true);
        showToast('Device linked!');
        setTimeout(() => {
          if (navigation.canGoBack()) navigation.goBack();
          else navigation.navigate('LinkDevice');
        }, 1400);
      } else {
        setLinkErrorState(linkError || 'Something went wrong. Please try again.');
      }
    } catch (err) {
      setLinkErrorState(err?.message || 'Something went wrong. Please try again.');
    }
  }, [linkDevice, linkError, navigation]);

  // Auto-connect: scan → link, no confirmation step. In production an
  // unrecognized server origin is blocked for safety; in development (__DEV__)
  // the trust gate is skipped so QR codes from a local/LAN web client link
  // straight through.
  useEffect(() => {
    if (!scannedData || autoTriggeredRef.current || linkSuccess || linkErrorState) return;
    // TEMP: server-origin trust gate disabled so QR codes from the production
    // web client link through even when their origin differs from this build's
    // BACKEND_URL. Re-enable before shipping (uncomment the block below).
    // if (!__DEV__ && !isServerUrlTrusted(scannedData.serverUrl)) {
    //   setLinkErrorState('This QR code is from an unrecognized server and was blocked for your security.');
    //   return;
    // }
    autoTriggeredRef.current = true;
    runLink();
  }, [scannedData, linkSuccess, linkErrorState, isServerUrlTrusted, runLink]);

  const handleTryAgain = useCallback(() => {
    autoTriggeredRef.current = false;
    resetScan();
    clearError();
    setLinkErrorState(null);
  }, [resetScan, clearError]);

  const handleGoBack = useCallback(() => navigation.goBack(), [navigation]);

  const activeError = linkErrorState || linkError;
  const showScanError = scanError && !scannedData;
  const showLinkError = activeError && scannedData && !isLinking && !linkSuccess;

  // -- Permission screen --
  if (!hasPermission) {
    return (
      <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: theme.colors.background }]}>
        <View style={[styles.header, { borderBottomColor: theme.colors.borderColor }]}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <FontAwesome6 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: theme.colors.primaryTextColor }]}>Scan QR Code</Text>
        </View>
        <View style={styles.centered}>
          <BrandLockup theme={theme} style={{ marginBottom: 30 }} />
          <View style={[styles.permHalo, { backgroundColor: theme.colors.themeColor + '14' }]}>
            <MaterialIcons name="photo-camera" size={42} color={theme.colors.themeColor} />
          </View>
          <Text style={[styles.permissionTitle, { color: theme.colors.primaryTextColor }]}>
            Camera access needed
          </Text>
          <Text style={[styles.permissionText, { color: theme.colors.secondaryTextColor }]}>
            We use the camera only to read the QR code shown on your web or desktop screen.
          </Text>
          <TouchableOpacity
            onPress={canAskPermission ? requestPermission : () => Linking.openSettings()}
            activeOpacity={0.88}
            style={[styles.permissionBtn, { backgroundColor: theme.colors.themeColor }]}
          >
            <Text style={styles.permissionBtnText}>
              {canAskPermission ? 'Allow camera' : 'Open settings'}
            </Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    );
  }

  // -- Scanner screen --
  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim, backgroundColor: '#000' }]}>
      {!scannedData && !linkSuccess && (
        <CameraView
          style={StyleSheet.absoluteFillObject}
          facing="back"
          enableTorch={torch}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={isScanning ? handleBarCodeScanned : undefined}
        />
      )}

      <QROverlay scanLineAnim={scanLineAnim} showScanLine={isScanning && !scannedData && !showScanError} />

      {/* Header — icon controls only; branding sits centered below */}
      <View style={styles.scanHeader}>
        <TouchableOpacity onPress={handleGoBack} style={styles.scanIconBtn}>
          <FontAwesome6 name="arrow-left" size={19} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setTorch((t) => !t)} style={styles.scanIconBtn}>
          <Ionicons name={torch ? 'flash' : 'flash-off'} size={20} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* TalksTry brand lockup + instruction */}
      {!showScanError && !showLinkError && (
        <View style={styles.brandTop} pointerEvents="none">
          <BrandLockup theme={theme} onDark />
          <Text style={styles.brandCaption}>Scan to link a device</Text>
          <Text style={styles.brandSub}>
            Open the web app and hold the QR code inside the frame — it links automatically.
          </Text>
        </View>
      )}

      {/* Scanning pill */}
      {isScanning && !scannedData && !showScanError && (
        <View style={styles.scanningPillWrap} pointerEvents="none">
          <View style={styles.scanningPill}>
            <View style={[styles.scanningDot, { backgroundColor: theme.colors.themeColor }]} />
            <Text style={styles.scanningText}>Scanning…</Text>
          </View>
        </View>
      )}

      {/* Scan error */}
      {showScanError && (
        <View style={styles.errorContainer}>
          <View style={styles.errorBadge}>
            <MaterialIcons name="error-outline" size={26} color="#FF5A5A" />
          </View>
          <Text style={styles.errorText}>{scanError}</Text>
          <View style={styles.errorButtons}>
            <TouchableOpacity onPress={handleTryAgain} style={styles.retryBtn}>
              <MaterialIcons name="refresh" size={18} color="#fff" />
              <Text style={styles.retryText}>Try again</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleGoBack} style={styles.goBackBtn}>
              <Text style={styles.goBackText}>Go back</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Link error */}
      {showLinkError && (
        <View style={styles.errorContainer}>
          <View style={styles.errorBadge}>
            <MaterialIcons name="error-outline" size={26} color="#FF5A5A" />
          </View>
          <Text style={styles.errorText}>{activeError}</Text>
          <View style={styles.errorButtons}>
            <TouchableOpacity onPress={handleTryAgain} style={styles.retryBtn}>
              <MaterialIcons name="refresh" size={18} color="#fff" />
              <Text style={styles.retryText}>Scan again</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleGoBack} style={styles.goBackBtn}>
              <Text style={styles.goBackText}>Go back</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Connecting / success overlay (auto, no confirm step) */}
      <LinkingLoader visible={isLinking || linkSuccess} success={linkSuccess} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    gap: 10,
    borderBottomWidth: 1,
  },
  headerTitle: { fontFamily: 'Roboto-SemiBold', fontSize: 16 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },

  permHalo: {
    width: 96, height: 96, borderRadius: 48,
    alignItems: 'center', justifyContent: 'center',
  },
  permissionTitle: { fontFamily: 'Roboto-Bold', fontSize: 19, marginTop: 22, textAlign: 'center', letterSpacing: -0.3 },
  permissionText: { fontFamily: 'Roboto-Regular', fontSize: 14, marginTop: 10, textAlign: 'center', lineHeight: 20 },
  permissionBtn: { marginTop: 26, paddingHorizontal: 36, paddingVertical: 13, borderRadius: 40 },
  permissionBtnText: { fontFamily: 'Roboto-SemiBold', fontSize: 15, color: '#fff' },

  scanHeader: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: Platform.OS === 'ios' ? 52 : 18,
    paddingBottom: 10,
    zIndex: 10,
  },
  scanIconBtn: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center', justifyContent: 'center',
  },
  scanTitle: { fontFamily: 'Roboto-SemiBold', fontSize: 18, color: '#fff' },

  brandTop: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 100 : 70,
    left: 28, right: 28,
    alignItems: 'center',
    zIndex: 10,
  },
  brandCaption: { fontFamily: 'Roboto-SemiBold', fontSize: 16, color: '#fff', marginTop: 14 },
  brandSub: {
    fontFamily: 'Roboto-Regular', fontSize: 12.5, color: 'rgba(255,255,255,0.80)',
    textAlign: 'center', lineHeight: 18, marginTop: 6, maxWidth: 280,
  },

  scanningPillWrap: {
    position: 'absolute',
    bottom: Platform.OS === 'ios' ? 110 : 90,
    left: 0, right: 0,
    alignItems: 'center',
    zIndex: 10,
  },
  scanningPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 30,
  },
  scanningDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#03b0a2' },
  scanningText: { fontFamily: 'Roboto-Medium', fontSize: 13.5, color: '#fff' },

  errorContainer: {
    position: 'absolute',
    bottom: 88, left: 0, right: 0,
    alignItems: 'center',
    paddingHorizontal: 30,
    zIndex: 10,
  },
  errorBadge: {
    width: 54, height: 54, borderRadius: 27,
    backgroundColor: 'rgba(255,90,90,0.16)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 10,
  },
  errorText: { fontFamily: 'Roboto-Regular', fontSize: 14, color: '#fff', textAlign: 'center', lineHeight: 20 },
  errorButtons: { flexDirection: 'row', gap: 12, marginTop: 18 },
  retryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#03b0a2',
    paddingHorizontal: 22, paddingVertical: 11, borderRadius: 40,
  },
  retryText: { fontFamily: 'Roboto-SemiBold', fontSize: 14, color: '#fff' },
  goBackBtn: {
    paddingHorizontal: 22, paddingVertical: 11, borderRadius: 40,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)',
  },
  goBackText: { fontFamily: 'Roboto-Medium', fontSize: 14, color: '#fff' },
});
