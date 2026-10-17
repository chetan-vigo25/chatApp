import { requireOptionalNativeModule } from 'expo-modules-core';

interface NativeScreenBroadcast {
  isAvailable(): boolean;
  showPicker(): Promise<boolean>;
}

// null on Android / a build made before the module and the broadcast extension
// existed — callers simply don't offer screen share there.
const Native = requireOptionalNativeModule<NativeScreenBroadcast>('ExpoScreenBroadcast');

/** True when this build ships the ReplayKit screen-share extension. */
export function isAvailable(): boolean {
  try {
    return Native != null && Native.isAvailable();
  } catch {
    return false;
  }
}

/**
 * Opens the system "Screen Broadcast" sheet preselected to TalksTry. The user
 * still taps Start Broadcast (iOS rule); frames then flow to the screen track
 * returned by getDisplayMedia.
 */
export async function showPicker(): Promise<boolean> {
  if (!Native) return false;
  return Native.showPicker();
}

export default { isAvailable, showPicker };
