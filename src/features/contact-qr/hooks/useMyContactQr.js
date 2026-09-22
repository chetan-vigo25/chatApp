/**
 * The signed-in user's contact QR token — load, share, reset.
 *
 * Shared by the QR screen's header (share icon, ⋮ → Reset) and the My code tab
 * (renders the code), so the token lives in one place.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Platform, ToastAndroid } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import { shareFile as shareFileNative } from '../../../../modules/expo-call-ui';
import * as FileSystem from 'expo-file-system/legacy';
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

// NEVER share a file that sits in the cache ROOT.
//
// Sharing INTO our own app destroyed the picture: expo-share-intent copies an
// incoming file to `cacheDir/<display name>` — and view-shot had written the
// snapshot to exactly that path, so the library opened an output stream on the
// very file it was reading, truncated it to 0 bytes and shipped an empty image
// (which is also why the cached snapshots kept turning up empty afterwards).
// A sub-folder gives the copy somewhere else to land.
const SHARE_DIR = `${FileSystem.cacheDirectory}qr-share/`;
const moveOutOfCacheRoot = async (uri) => {
  try {
    const from = uri.startsWith('file://') ? uri : `file://${uri}`;
    await FileSystem.makeDirectoryAsync(SHARE_DIR, { intermediates: true }).catch(() => {});
    // A friendly, stable name: it is what the receiving app shows.
    const to = `${SHARE_DIR}TalksTry-QR-${Date.now()}.png`;
    await FileSystem.copyAsync({ from, to });
    const info = await FileSystem.getInfoAsync(to, { size: true });
    if (info?.exists && (info.size ?? 0) > 0) return to;
  } catch (err) {
    console.warn('[MyQR] share copy failed:', err?.message);
  }
  return uri; // fall back to the original rather than losing the share
};

  /** Share the rendered card (`targetRef` → the view to capture) as a PNG. */
  // Snapshot the card, making sure we actually got PIXELS. react-native-view-shot
  // occasionally returns a 0-byte file (the view is mid-layout / the window has
  // just come back) — that empty file was shared as a blank image and the
  // receiver saw nothing. Verify the size and take one more shot before giving up.
  const captureCard = useCallback(async (targetRef) => {
    const shoot = () => captureRef(targetRef, { format: 'png', quality: 1, result: 'tmpfile' });
    // view-shot returns a BARE path ("/data/.../cache/x.png"); getInfoAsync needs
    // a file:// uri or it reports the file as missing (which silently defeated
    // this whole check and shipped the empty snapshot anyway).
    const sizeOf = async (uri) => {
      const fileUri = uri.startsWith('file://') ? uri : `file://${uri}`;
      try {
        const info = await FileSystem.getInfoAsync(fileUri, { size: true });
        return info?.exists ? (info.size ?? 0) : -1; // -1 = couldn't tell
      } catch (_) {
        return -1;
      }
    };
    let last = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const uri = await shoot();
      last = uri;
      const size = await sizeOf(uri);
      if (size !== 0) return moveOutOfCacheRoot(uri); // real pixels
      // Empty PNG: the view wasn't ready to draw. Give it a frame and re-shoot.
      await new Promise((r) => setTimeout(r, 200));
    }
    if ((await sizeOf(last)) === 0) throw new Error('empty snapshot');
    return moveOutOfCacheRoot(last);
  }, []);

  // App-lock suspension has to outlive the spinner: the sheet keeps the app
  // backgrounded long after the button is usable again.
  const lockHeldRef = useRef(false);
  const releaseLock = useCallback(() => {
    if (!lockHeldRef.current) return;
    lockHeldRef.current = false;
    resumeAppLock();
  }, []);

  const share = useCallback(async (targetRef) => {
    if (!token || busy || !targetRef?.current) return;
    setBusy('share');
    // The share sheet backgrounds the app — keep the app lock from firing.
    lockHeldRef.current = true;
    suspendAppLock();
    try {
      const uri = await captureCard(targetRef);
      // ANDROID: go straight to the system chooser through our own native
      // module. expo-sharing keeps a pendingPromise that only clears on an
      // activity RESULT, and the chooser routinely returns none (the user taps
      // WhatsApp and comes back through Recents) — after one share every later
      // one failed with "Another share request is being processed now" and no
      // sheet opened at all.
      if (Platform.OS === 'android' && shareFileNative(uri, 'image/png', 'Share my QR code')) {
        // The sheet is the OS's UI now; the button is free again.
        setTimeout(releaseLock, 60000);
        return;
      }
      if (!(await Sharing.isAvailableAsync())) {
        showToast('Sharing is not available on this device');
        releaseLock();
        return;
      }
      Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: 'Share my QR code' })
        .catch((err) => { console.warn('[MyQR] share sheet:', err?.message); })
        .finally(releaseLock);
      setTimeout(releaseLock, 60000);
    } catch (err) {
      console.warn('[MyQR] share failed:', err?.message);
      showToast("Couldn't share the QR code");
      releaseLock();
    } finally {
      setBusy(null);
    }
  }, [token, busy, captureCard, releaseLock]);

  // Returning to the app is the other moment the sheet is certainly behind us.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') releaseLock();
    });
    return () => sub.remove();
  }, [releaseLock]);

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
