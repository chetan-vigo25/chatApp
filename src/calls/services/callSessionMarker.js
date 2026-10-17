import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { setSessionMarker as setAndroidSessionMarker } from '../../../modules/expo-call-ui';

/**
 * callSessionMarker (P-C-04) — publishes "who is signed in on this device" to
 * the NATIVE push layer, which cannot see JS auth:
 *   - iOS: the AppDelegate PushKit handler reads a Keychain item (written here
 *     through expo-secure-store, AFTER_FIRST_UNLOCK so a locked phone can read
 *     it) and, when a VoIP push is for a signed-out / other user, reports the
 *     call to CallKit and ends it at once (Apple rule) instead of ringing.
 *   - Android: CallMessagingService reads a SharedPreferences value (via the
 *     existing ExpoCallUi native module) and skips rendering the ring.
 *
 * The value is a USER ID (not a token): the id when signed in, 'none' when
 * signed out. Never written => the native side behaves as before (rings).
 *
 * Keep KEY / SIGNED_OUT in step with ios AppDelegate (withIosVoip.js) and
 * ExpoCallUiModule.kt.
 */
export const CALL_SESSION_MARKER_KEY = 'callSessionUserId';
export const CALL_SESSION_SIGNED_OUT = 'none';

const SECURE_OPTIONS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

let lastWritten;

/** userId => signed in as that user; falsy => signed out. Best-effort, never throws. */
export const writeCallSessionMarker = async (userId) => {
  const value = userId ? String(userId) : CALL_SESSION_SIGNED_OUT;
  if (value === lastWritten) return;
  lastWritten = value;
  try {
    if (Platform.OS === 'ios') {
      await SecureStore.setItemAsync(CALL_SESSION_MARKER_KEY, value, SECURE_OPTIONS);
    } else if (Platform.OS === 'android') {
      setAndroidSessionMarker(value);
    }
  } catch (_) {
    lastWritten = undefined; // retry on the next call
  }
};

export default { writeCallSessionMarker };
