/**
 * Hook for QR code scanning with expo-camera.
 *
 * Handles camera permissions, barcode parsing, validation,
 * haptic feedback on successful scan, and retry logic.
 */
import { useState, useCallback, useRef } from 'react';
import { useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { EXPECTED_SERVER_URL, SCAN_RETRY_DELAY_MS } from '../constants';

/**
 * @typedef {Object} QRPayload
 * @property {string} sessionId  - UUID from the QR
 * @property {string} publicKey  - PEM public key from the web client
 * @property {string} serverUrl  - Backend URL encoded in the QR
 */

export default function useQRScanner() {
  const [permission, requestPermission] = useCameraPermissions();
  const [scannedData, setScannedData] = useState(null);
  const [error, setError] = useState(null);
  const [isScanning, setIsScanning] = useState(true);
  const isProcessingRef = useRef(false);

  const hasPermission = permission?.granted ?? false;
  const canAskPermission = permission?.canAskAgain ?? true;

  /**
   * Parse and validate a scanned QR barcode payload.
   * Expected JSON: { sessionId, publicKey, serverUrl }
   */
  const handleBarCodeScanned = useCallback(({ data }) => {
    if (isProcessingRef.current || !isScanning) return;
    isProcessingRef.current = true;
    setError(null);

    console.log('[QRScanner] Raw barcode data:', data);

    try {
      const parsed = JSON.parse(data);
      console.log('[QRScanner] Parsed QR JSON:', JSON.stringify({
        sessionId: parsed.sessionId,
        publicKey: parsed.publicKey ? parsed.publicKey.substring(0, 60) + '...' : '(missing)',
        serverUrl: parsed.serverUrl || '(missing)',
        allKeys: Object.keys(parsed),
      }, null, 2));

      if (!parsed.sessionId) {
        throw new Error('Invalid QR code: missing sessionId');
      }
      if (!parsed.publicKey) {
        throw new Error('Invalid QR code: missing publicKey');
      }

      // Haptic feedback on successful scan
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

      const scanned = {
        sessionId: parsed.sessionId,
        publicKey: parsed.publicKey,
        serverUrl: parsed.serverUrl || '',
      };
      console.log('[QRScanner] Setting scannedData, publicKey length:', parsed.publicKey?.length);
      setScannedData(scanned);
      setIsScanning(false);
    } catch (e) {
      const message =
        e instanceof SyntaxError
          ? 'Invalid QR code format. Please scan a valid device-linking QR code.'
          : e.message || 'Failed to process QR code';
      setError(message);

      // Allow retry after delay
      setTimeout(() => {
        isProcessingRef.current = false;
      }, SCAN_RETRY_DELAY_MS);
    }
  }, [isScanning]);

  /** Start scanning (resume camera processing) */
  const startScan = useCallback(() => {
    setIsScanning(true);
    isProcessingRef.current = false;
    setError(null);
  }, []);

  /** Stop scanning (pause camera processing) */
  const stopScan = useCallback(() => {
    setIsScanning(false);
  }, []);

  /** Clear scanned data and errors, ready for a fresh scan */
  const resetScan = useCallback(() => {
    setScannedData(null);
    setError(null);
    setIsScanning(true);
    isProcessingRef.current = false;
  }, []);

  /**
   * Validate that the QR's serverUrl matches our expected backend.
   * @param {string} serverUrl
   * @returns {boolean}
   */
  const isServerUrlTrusted = useCallback((serverUrl) => {
    if (!EXPECTED_SERVER_URL || !serverUrl) return true; // skip validation if not configured
    try {
      const expected = new URL(EXPECTED_SERVER_URL).origin;
      const actual = new URL(serverUrl).origin;
      return expected === actual;
    } catch {
      return false;
    }
  }, []);

  return {
    // Permission
    hasPermission,
    canAskPermission,
    requestPermission,
    // Scanning state
    isActive: isScanning,
    isScanning,
    scannedData,
    error,
    // Actions
    handleScan: handleBarCodeScanned,
    handleBarCodeScanned,
    pauseScan: stopScan,
    resumeScan: startScan,
    startScan,
    stopScan,
    resetScan,
    isServerUrlTrusted,
  };
}