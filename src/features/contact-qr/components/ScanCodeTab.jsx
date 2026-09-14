/**
 * "Scan code" tab — read someone's contact QR.
 *
 * Scan (camera or a gallery image) → resolve the token on the server → show
 * ScannedContactSheet over the paused camera. Nothing navigates on a scan: the
 * user sees the person's card and chooses Save contact and/or Chat. Only Chat
 * leaves the screen.
 *
 * The camera is mounted only while `active` (this tab is showing and the screen
 * is focused) — sitting on "My code" must not keep the camera running.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  ActivityIndicator,
  BackHandler,
} from 'react-native';
import { CameraView, scanFromURLAsync } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { CommonActions } from '@react-navigation/native';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../../contexts/ThemeContext';
import { useRealtimeChatLists } from '../../../contexts/RealtimeChatContext';
import useOpenUserChat from '../../../hooks/useOpenUserChat';
import { suspendAppLock, resumeAppLock } from '../../../services/appLockGuard';
import QROverlay from '../../device-linking/components/QROverlay';
import useContactQrScanner from '../hooks/useContactQrScanner';
import { resolveContactQrToken } from '../services/contactQrApi';
import ScannedContactSheet from './ScannedContactSheet';

const showToast = (msg) => {
  if (Platform.OS === 'android') ToastAndroid.show(msg, ToastAndroid.SHORT);
  else Alert.alert('', msg);
};

// QR_INVALID covers a bad token, a reset code, a deleted account AND "the owner
// blocked you" — the server merges them on purpose, so the copy must never
// hint at which one it was.
const resolveErrorMessage = (err) => {
  if (err?.code === 'RATE_LIMITED') return 'Too many scans. Please wait a moment and try again.';
  return "Couldn't read this QR code.";
};

export default function ScanCodeTab({ active, navigation, routeKey, onSheetOpenChange }) {
  const { theme } = useTheme();
  const scanLineAnim = useRef(new Animated.Value(0)).current;
  const [torch, setTorch] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [card, setCard] = useState(null);
  const [resolveError, setResolveError] = useState(null);

  const {
    hasPermission,
    canAskPermission,
    requestPermission,
    token,
    error: scanError,
    handleBarcodeScanned,
    handleScannedValue,
    reset,
  } = useContactQrScanner();

  let chatList = [];
  try {
    chatList = useRealtimeChatLists().chatList || [];
  } catch { /* provider missing — openUserChat still creates the chat */ }
  const { openUserChat } = useOpenUserChat({ chats: chatList });
  const [openingChat, setOpeningChat] = useState(false);

  // The pager must not swipe away from an open contact card.
  useEffect(() => { onSheetOpenChange?.(Boolean(card)); }, [card, onSheetOpenChange]);

  // Leaving the tab turns the torch off with the camera.
  useEffect(() => { if (!active) setTorch(false); }, [active]);

  // "Chat": open the existing thread, or `chat:create` and wait for the ack
  // before navigating — useOpenUserChat already does both, plus the double-tap
  // guard. No phone-book write happens on this path.
  const openChat = useCallback(async () => {
    if (!card?.canChat || !card.userId || openingChat) return;
    setOpeningChat(true);
    try {
      const outcome = await openUserChat({
        _id: card.userId,
        userId: card.userId,
        fullName: card.fullName,
        profileImage: card.profileImage,
        type: 'registered',
      });
      if (outcome === 'opened' || outcome === 'created') {
        // Drop the QR screen from the stack so Back from the chat returns to
        // where the scan started, not to a paused camera with a stale card.
        navigation.dispatch((state) => {
          const routes = state.routes.filter((r) => r.key !== routeKey);
          return CommonActions.reset({ ...state, routes, index: routes.length - 1 });
        });
      }
    } finally {
      setOpeningChat(false);
    }
  }, [card, openingChat, openUserChat, navigation, routeKey]);

  // Resolve each new token once; a late answer for an abandoned scan is dropped.
  const activeTokenRef = useRef(null);
  useEffect(() => {
    activeTokenRef.current = token;
    if (!token) return;
    setResolving(true);
    setResolveError(null);
    resolveContactQrToken(token)
      .then((result) => { if (activeTokenRef.current === token) setCard(result); })
      .catch((err) => { if (activeTokenRef.current === token) setResolveError(resolveErrorMessage(err)); })
      .finally(() => { if (activeTokenRef.current === token) setResolving(false); });
  }, [token]);

  const scanAgain = useCallback(() => {
    setCard(null);
    setResolveError(null);
    setResolving(false);
    reset();
  }, [reset]);

  // Hardware back closes the card first, like any bottom sheet.
  useEffect(() => {
    if (!active || (!card && !resolveError)) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { scanAgain(); return true; });
    return () => sub.remove();
  }, [active, card, resolveError, scanAgain]);

  const idle = active && hasPermission && !token && !card;
  useEffect(() => {
    if (!idle) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scanLineAnim, { toValue: 1, duration: 2400, useNativeDriver: true }),
        Animated.timing(scanLineAnim, { toValue: 0, duration: 2400, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [idle, scanLineAnim]);

  const pickFromGallery = useCallback(async () => {
    let uri = null;
    suspendAppLock();
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      if (!result.canceled) uri = result.assets?.[0]?.uri || null;
    } catch (err) {
      console.warn('[ContactScanner] gallery pick failed:', err?.message);
    } finally {
      resumeAppLock();
    }
    if (!uri) return;

    try {
      const found = await scanFromURLAsync(uri, ['qr']);
      const data = found?.[0]?.data;
      if (data) handleScannedValue(data);
      else showToast('No QR code found in this image');
    } catch (err) {
      console.warn('[ContactScanner] image scan failed:', err?.message);
      showToast('No QR code found in this image');
    }
  }, [handleScannedValue]);

  const accent = theme.colors.themeColor;

  if (!hasPermission) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.colors.background }]}>
        <View style={[styles.permHalo, { backgroundColor: accent + '14' }]}>
          <MaterialIcons name="qr-code-scanner" size={42} color={accent} />
        </View>
        <Text style={[styles.permTitle, { color: theme.colors.primaryTextColor }]}>Camera access needed</Text>
        <Text style={[styles.permText, { color: theme.colors.secondaryTextColor }]}>
          The camera is used only to read a contact's TalksTry QR code.
        </Text>
        <TouchableOpacity
          onPress={canAskPermission ? requestPermission : () => Linking.openSettings()}
          activeOpacity={0.88}
          style={[styles.permBtn, { backgroundColor: accent }]}
        >
          <Text style={styles.permBtnText}>{canAskPermission ? 'Allow camera' : 'Open settings'}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={pickFromGallery} activeOpacity={0.7} style={styles.permGallery}>
          <Ionicons name="image-outline" size={18} color={accent} />
          <Text style={[styles.permGalleryText, { color: accent }]}>Scan from gallery instead</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const bannerError = resolveError || (!token ? scanError : null);

  return (
    <View style={[styles.container, { backgroundColor: '#000' }]}>
      {active ? (
        <CameraView
          style={StyleSheet.absoluteFillObject}
          facing="back"
          enableTorch={torch}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={!token ? handleBarcodeScanned : undefined}
        />
      ) : null}

      <QROverlay scanLineAnim={scanLineAnim} showScanLine={idle && !scanError} />

      {!card && (
        <View style={styles.hintWrap} pointerEvents="none">
          <Text style={styles.hint}>Scan a TalksTry QR code to save or chat with someone</Text>
        </View>
      )}

      {resolving && (
        <View style={styles.pillWrap} pointerEvents="none">
          <View style={styles.pill}>
            <ActivityIndicator size="small" color="#fff" />
            <Text style={styles.pillText}>Getting contact…</Text>
          </View>
        </View>
      )}

      {bannerError && !card && !resolving && (
        <View style={styles.errorWrap}>
          <View style={styles.errorBadge}>
            <MaterialIcons name="error-outline" size={24} color="#FF5A5A" />
          </View>
          <Text style={styles.errorText}>{bannerError}</Text>
          {resolveError ? (
            <TouchableOpacity onPress={scanAgain} style={[styles.retryBtn, { backgroundColor: accent }]}>
              <MaterialIcons name="refresh" size={18} color="#fff" />
              <Text style={styles.retryText}>Scan again</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      )}

      {!card && !resolving && !bannerError && (
        <View style={styles.bottomBar}>
          <TouchableOpacity onPress={pickFromGallery} style={styles.roundBtn} activeOpacity={0.8}>
            <Ionicons name="image-outline" size={24} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setTorch((t) => !t)} style={styles.roundBtn} activeOpacity={0.8}>
            <Ionicons name={torch ? 'flash' : 'flash-off'} size={22} color="#fff" />
          </TouchableOpacity>
        </View>
      )}

      {card && (
        <>
          <TouchableOpacity activeOpacity={1} onPress={scanAgain} style={styles.scrim} />
          <ScannedContactSheet
            key={token || card.userId}
            card={card}
            onScanAgain={scanAgain}
            onDone={() => navigation.goBack()}
            onChat={openChat}
            chatBusy={openingChat}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  centered: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  permHalo: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center' },
  permTitle: { fontFamily: 'Roboto-Bold', fontSize: 19, marginTop: 22, textAlign: 'center' },
  permText: { fontFamily: 'Roboto-Regular', fontSize: 14, marginTop: 10, textAlign: 'center', lineHeight: 20 },
  permBtn: { marginTop: 26, paddingHorizontal: 36, paddingVertical: 13, borderRadius: 40 },
  permBtnText: { fontFamily: 'Roboto-SemiBold', fontSize: 15, color: '#fff' },
  permGallery: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 18, padding: 8 },
  permGalleryText: { fontFamily: 'Roboto-Medium', fontSize: 14 },

  hintWrap: { position: 'absolute', top: 28, left: 32, right: 32, alignItems: 'center', zIndex: 10 },
  hint: {
    fontFamily: 'Roboto-Regular', fontSize: 14, color: 'rgba(255,255,255,0.9)',
    textAlign: 'center', lineHeight: 20,
  },

  pillWrap: { position: 'absolute', bottom: 120, left: 0, right: 0, alignItems: 'center', zIndex: 10 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 30,
  },
  pillText: { fontFamily: 'Roboto-Medium', fontSize: 14, color: '#fff' },

  errorWrap: { position: 'absolute', bottom: 100, left: 0, right: 0, alignItems: 'center', paddingHorizontal: 30, zIndex: 10 },
  errorBadge: {
    width: 50, height: 50, borderRadius: 25, backgroundColor: 'rgba(255,90,90,0.16)',
    alignItems: 'center', justifyContent: 'center', marginBottom: 10,
  },
  errorText: { fontFamily: 'Roboto-Regular', fontSize: 14, color: '#fff', textAlign: 'center', lineHeight: 20 },
  retryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 16,
    paddingHorizontal: 22, paddingVertical: 11, borderRadius: 40,
  },
  retryText: { fontFamily: 'Roboto-SemiBold', fontSize: 14, color: '#fff' },

  bottomBar: {
    position: 'absolute', bottom: 36, left: 32, right: 32,
    flexDirection: 'row', justifyContent: 'space-between', zIndex: 10,
  },
  roundBtn: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center',
  },

  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)', zIndex: 15 },
});
