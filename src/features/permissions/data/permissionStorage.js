import AsyncStorage from '@react-native-async-storage/async-storage';

import { PermissionStatus } from '../domain/permissionTypes';

/**
 * Permission state persistence.
 *
 * Two independent pieces of state:
 *
 * 1. ONBOARDING FLAG — has the user been through the permission introduction screen
 *    and reached the end of it? Once set, the screen is never forced again. This is
 *    what makes returning users go straight from Splash to the app, and it also
 *    guarantees the user can never be locked out of the app by revoking a permission
 *    in system Settings later on (features re-ask in context when they need it).
 *
 * 2. STATUS MEMORY — the last status we observed per permission. Its only job is to
 *    remember "permanently denied": Android's passive `PermissionsAndroid.check()`
 *    cannot tell denied from don't-ask-again, so without this the Files row would
 *    offer an Allow button that silently does nothing after a "Don't ask again".
 *
 * All reads/writes are best-effort — storage failures must never break the flow.
 */

const ONBOARDING_KEY = '@permissions/onboarding_completed_v1';
const STATUS_KEY = '@permissions/status_memory_v1';

export async function isOnboardingCompleted() {
  try {
    return (await AsyncStorage.getItem(ONBOARDING_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function markOnboardingCompleted() {
  try {
    await AsyncStorage.setItem(ONBOARDING_KEY, '1');
  } catch {
    // non-fatal: worst case the intro screen is shown once more
  }
}

/** Test/QA helper — lets the intro flow be replayed without reinstalling. */
export async function resetOnboarding() {
  try {
    await AsyncStorage.multiRemove([ONBOARDING_KEY, STATUS_KEY]);
  } catch {
    // ignore
  }
}

/** @returns {Promise<Record<string, string>>} id → last known PermissionStatus */
export async function loadStatusMemory() {
  try {
    const raw = await AsyncStorage.getItem(STATUS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function rememberStatus(id, status) {
  try {
    const memory = await loadStatusMemory();

    // Only the BLOCKED verdict is worth persisting; anything else is re-derivable
    // from a live check and stale entries would just fight the OS.
    if (status === PermissionStatus.BLOCKED) {
      memory[id] = status;
    } else {
      delete memory[id];
    }

    await AsyncStorage.setItem(STATUS_KEY, JSON.stringify(memory));
  } catch {
    // ignore
  }
}
