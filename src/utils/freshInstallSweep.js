import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { KEYPAIR_STORAGE_KEY } from '../features/device-linking/constants';

// Uninstalling the app wipes AsyncStorage and every SQLite database (they live
// in the app sandbox), but iOS KEYCHAIN entries written via expo-secure-store
// SURVIVE an uninstall. So: AsyncStorage empty + a keychain value present means
// this is a fresh (re)install carrying secrets from a previous one — delete
// them so an uninstall truly leaves nothing behind. Android's keystore prefs
// die with the sandbox, so this is a no-op there (and with allowBackup=false
// nothing is restored from cloud backup either).
const INSTALL_MARKER_KEY = 'app_install_marker_v1';

// Every key this app ever writes through expo-secure-store. Keep this list in
// sync when a new SecureStore key is introduced.
const SECURE_STORE_KEYS = [KEYPAIR_STORAGE_KEY];

export async function runFreshInstallSweep() {
  try {
    const marker = await AsyncStorage.getItem(INSTALL_MARKER_KEY);
    if (marker) return; // same install as last boot — nothing to do

    await Promise.all(
      SECURE_STORE_KEYS.map((key) =>
        SecureStore.deleteItemAsync(key).catch(() => {})
      )
    );

    await AsyncStorage.setItem(INSTALL_MARKER_KEY, String(Date.now()));
  } catch {
    // Never block boot on the sweep — worst case it re-runs next launch.
  }
}
