/**
 * The signed-in user's contact QR token — load, share, reset.
 *
 * Shared by the QR screen's header (share icon, ⋮ → Reset) and the My code tab
 * (renders the code), so the token lives in one place.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Platform, ToastAndroid } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import { suspendAppLock, resumeAppLock } from '../../../services/appLockGuard';
import {
  fetchMyContactQrToken,
  getCachedContactQrToken,
  resetMyContactQrToken,
} from '../services/contactQrApi';

const showToast = (msg) => {
  if (Platform.OS === 'android') ToastAndroid.show(msg, ToastAndroid.SHORT);
  else Alert.alert('', msg);
};

export default function useMyContactQr(userId) {
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // 'share' | 'reset' | null

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    // Paint the last known code at once; the network call confirms or replaces it.
    const cached = await getCachedContactQrToken(userId);
    if (cached) setToken(cached);
    try {
      setToken(await fetchMyContactQrToken(userId));
    } catch {
      if (!cached) setError("QR code isn't available right now.");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  /** Share the rendered card (`targetRef` → the view to capture) as a PNG. */
  const share = useCallback(async (targetRef) => {
    if (!token || busy || !targetRef?.current) return;
    setBusy('share');
    // The share sheet backgrounds the app — keep the app lock from firing.
    suspendAppLock();
    try {
      const uri = await captureRef(targetRef, { format: 'png', quality: 1, result: 'tmpfile' });
      if (!(await Sharing.isAvailableAsync())) {
        showToast('Sharing is not available on this device');
        return;
      }
      await Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: 'Share my QR code' });
    } catch (err) {
      console.warn('[MyQR] share failed:', err?.message);
      showToast("Couldn't share the QR code");
    } finally {
      resumeAppLock();
      setBusy(null);
    }
  }, [token, busy]);

  const doReset = useCallback(async () => {
    setBusy('reset');
    // The old code dies the moment the server rotates it — never leave it on
    // screen (or in the share capture) while the reset is in flight.
    setToken(null);
    setError(null);
    setLoading(true);
    try {
      setToken(await resetMyContactQrToken(userId));
      setLoading(false);
      showToast('QR code reset');
    } catch {
      showToast("Couldn't reset the QR code");
      // Unknown whether the server rotated it — ask for the current code
      // (the cache was cleared, so nothing stale can repaint).
      await load();
    } finally {
      setBusy(null);
    }
  }, [userId, load]);

  const confirmReset = useCallback(() => {
    if (busy) return;
    Alert.alert(
      'Reset QR code?',
      'Your current QR code will stop working. Anyone who has it — including screenshots — will no longer be able to scan it.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reset', style: 'destructive', onPress: doReset },
      ],
    );
  }, [busy, doReset]);

  return { token, loading, error, busy, load, share, confirmReset };
}
