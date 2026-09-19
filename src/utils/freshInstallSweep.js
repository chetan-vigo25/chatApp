import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { KEYPAIR_STORAGE_KEY } from '../features/device-linking/constants';
import { SECURE_TOKEN_KEYS } from '../services/secureTokenStore';

// Uninstalling the app wipes AsyncStorage and every SQLite database (they live
// in the app sandbox), but iOS KEYCHAIN entries written via expo-secure-store
// SURVIVE an uninstall. So: AsyncStorage empty + a keychain value present means
// this is a fresh (re)install carrying secrets from a previous one — delete
// them so an uninstall truly leaves nothing behind. Android's keystore prefs
// die with the sandbox, so this is a no-op there (and with allowBackup=false
// nothing is restored from cloud backup either).
// Exported because sessionManager must PRESERVE this across its
// AsyncStorage.clear() on logout. If the marker is lost, the next cold boot
// mistakes a logged-in install for a fresh one and deletes the auth tokens
// below — signing the user out. See DEVICE_PREFERENCE_KEYS there.
export const INSTALL_MARKER_KEY = 'app_install_marker_v1';

// Every key this app ever writes through expo-secure-store. Keep this list in
// sync when a new SecureStore key is introduced.
const SECURE_STORE_KEYS = [KEYPAIR_STORAGE_KEY, ...SECURE_TOKEN_KEYS];

// Evidence that a real session has lived in THIS sandbox. A reinstall cannot
// have these (the sandbox was wiped); an app UPGRADE always does.
const SESSION_EVIDENCE_KEYS = ['userInfo', 'userData', 'deviceId', ...SECURE_TOKEN_KEYS];

export async function runFreshInstallSweep() {
  try {
    const marker = await AsyncStorage.getItem(INSTALL_MARKER_KEY);
    if (marker) return; // same install as last boot — nothing to do

    // ── Why the marker alone is not enough ────────────────────────────────
    // On the FIRST boot after an upgrade that introduces a new SecureStore key,
    // the marker can legitimately be missing while a live session exists. The
    // auth tokens are migrated out of AsyncStorage into the keychain lazily, by
    // whichever code path reads a token first (AuthContext.checkLoginStatus
    // usually) — and that runs CONCURRENTLY with this sweep. If the delete
    // below landed after that migration's write, it would destroy the token the
    // migration had just moved AND the plaintext copy it had just removed:
    // every upgrading user silently signed out.
    //
    // So confirm this is really a fresh install before deleting anything. A
    // wiped sandbox has no session evidence at all; an upgrade has plenty.
    // Defaults to TRUE so that any failure to read the evidence means "assume a
    // session lives here, delete nothing". Losing a user's session is far worse
    // than leaving a stale keychain entry behind for one more launch.
    let hasPriorSession = true;
    try {
      const evidence = await AsyncStorage.multiGet(SESSION_EVIDENCE_KEYS);
      hasPriorSession = (evidence || []).some(([, value]) => value != null);
    } catch { /* keep the safe default */ }

    if (!hasPriorSession) {
      await Promise.all(
        SECURE_STORE_KEYS.map((key) =>
          SecureStore.deleteItemAsync(key).catch(() => {})
        )
      );
    }

    // Set the marker either way: the install has now been accounted for.
    await AsyncStorage.setItem(INSTALL_MARKER_KEY, String(Date.now()));
  } catch {
    // Never block boot on the sweep — worst case it re-runs next launch.
  }
}
