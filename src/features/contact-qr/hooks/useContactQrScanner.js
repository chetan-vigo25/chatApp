/**
 * Camera permission + scan parsing for the contact scanner.
 *
 * Separate from device-linking's useQRScanner, which only understands the web
 * client's `{ sessionId, publicKey }` JSON.
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

    setError(
      result.kind === 'device-link'
        ? 'This code is for linking a device. Open Linked devices to scan it.'
        : "This isn't a TalksTry contact QR code.",
    );
    setTimeout(() => { lockedRef.current = false; }, RETRY_DELAY_MS);
  }, []);

  const handleBarcodeScanned = useCallback(({ data }) => handleScannedValue(data), [handleScannedValue]);

  const reset = useCallback(() => {
    setToken(null);
    setError(null);
    lockedRef.current = false;
  }, []);

  return {
    hasPermission,
    canAskPermission,
    requestPermission,
    token,
    error,
    handleBarcodeScanned,
    handleScannedValue,
    reset,
  };
}
