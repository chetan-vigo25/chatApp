/**
 * Camera permission + scan parsing for the "Scan code" tab.
 *
 * Reads BOTH a contact QR (→ `token`) and the web client's device-linking QR
 * (→ `deviceLink` = { sessionId, publicKey, serverUrl }); ScanCodeTab acts on
 * whichever arrived. Either one keeps the scanner locked until reset().
 */
import { useState, useCallback, useRef } from 'react';
import { useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { suspendAppLock, resumeAppLock } from '../../../services/appLockGuard';
import { parseScannedQr } from '../utils/qrPayload';

const RETRY_DELAY_MS = 1500;

export default function useContactQrScanner() {
  const [permission, requestCameraPermission] = useCameraPermissions();
  const [token, setToken] = useState(null);
  const [deviceLink, setDeviceLink] = useState(null);
  const [error, setError] = useState(null);
  const lockedRef = useRef(false);

  const hasPermission = permission?.granted ?? false;
  const canAskPermission = permission?.canAskAgain ?? true;

  // The OS dialog backgrounds the app on many devices — without the guard the
  // app lock pops up on the way back.
  const requestPermission = useCallback(async () => {
    suspendAppLock();
    try {
      return await requestCameraPermission();
    } finally {
      resumeAppLock();
    }
  }, [requestCameraPermission]);

  /** Feed a raw QR string (from the camera or a gallery image). */
  const handleScannedValue = useCallback((raw) => {
    if (lockedRef.current) return;
    lockedRef.current = true;

    const result = parseScannedQr(raw);
    if (result.kind === 'contact') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setError(null);
      setToken(result.token);
      return; // stays locked until reset()
    }

    if (result.kind === 'device-link') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setError(null);
      setDeviceLink({ sessionId: result.sessionId, publicKey: result.publicKey, serverUrl: result.serverUrl });
      return; // stays locked until reset()
    }

    setError("This isn't a TalksTry QR code.");
    setTimeout(() => { lockedRef.current = false; }, RETRY_DELAY_MS);
  }, []);

  const handleBarcodeScanned = useCallback(({ data }) => handleScannedValue(data), [handleScannedValue]);

  const reset = useCallback(() => {
    setToken(null);
    setDeviceLink(null);
    setError(null);
    lockedRef.current = false;
  }, []);

  return {
    hasPermission,
    canAskPermission,
    requestPermission,
    token,
    deviceLink,
    error,
    handleBarcodeScanned,
    handleScannedValue,
    reset,
  };
}
