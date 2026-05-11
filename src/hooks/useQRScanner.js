import { useState, useCallback, useRef } from 'react';
import { useCameraPermissions } from 'expo-camera';

export default function useQRScanner() {
  const [permission, requestPermission] = useCameraPermissions();
  const [scannedData, setScannedData] = useState(null);
  const [error, setError] = useState(null);
  const isProcessing = useRef(false);

  const hasPermission = permission?.granted ?? false;
  const canAskPermission = permission?.canAskAgain ?? true;

  const handleBarCodeScanned = useCallback(({ data }) => {
    if (isProcessing.current) return;
    isProcessing.current = true;
    setError(null);

    try {
      const parsed = JSON.parse(data);

      if (!parsed.sessionId || !parsed.publicKey) {
        throw new Error('Invalid QR code: missing sessionId or publicKey');
      }

      setScannedData({
        sessionId: parsed.sessionId,
        publicKey: parsed.publicKey,
      });
    } catch (e) {
      const message =
        e instanceof SyntaxError
          ? 'Invalid QR code format'
          : e.message || 'Failed to process QR code';
      setError(message);
      // Allow retry after a short delay
      setTimeout(() => {
        isProcessing.current = false;
      }, 2000);
    }
  }, []);

  const reset = useCallback(() => {
    setScannedData(null);
    setError(null);
    isProcessing.current = false;
  }, []);

  return {
    hasPermission,
    canAskPermission,
    requestPermission,
    scannedData,
    error,
    handleBarCodeScanned,
    reset,
  };
}