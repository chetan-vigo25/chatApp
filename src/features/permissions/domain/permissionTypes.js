/**
 * Permission domain types.
 *
 * A single normalized status vocabulary for every OS permission the app uses, so
 * the view model and UI never have to know whether a value came from
 * expo-notifications, expo-camera, expo-media-library, expo-location or the raw
 * Android `PermissionsAndroid` API. Adapters translate INTO this vocabulary; nothing
 * above the adapter layer touches a platform status string.
 */

export const PermissionStatus = Object.freeze({
  /** Never asked on this device — the OS dialog can still be shown. */
  UNDETERMINED: 'undetermined',
  /** Full access granted. */
  GRANTED: 'granted',
  /** iOS "Limited" photo access — partial, but enough for every feature we ship. */
  LIMITED: 'limited',
  /** Denied, but the OS will still show the dialog if we ask again. */
  DENIED: 'denied',
  /** Permanently denied ("Don't ask again" / iOS second ask) — Settings only. */
  BLOCKED: 'blocked',
  /** Not applicable on this OS version (e.g. legacy storage on Android 13+). */
  UNAVAILABLE: 'unavailable',
});

/** The permission requirement is met — either granted or not needed on this device. */
export function isSatisfied(status) {
  return (
    status === PermissionStatus.GRANTED ||
    status === PermissionStatus.LIMITED ||
    status === PermissionStatus.UNAVAILABLE
  );
}

/** The OS will still present its dialog, so an "Allow" button makes sense. */
export function canRequest(status) {
  return status === PermissionStatus.UNDETERMINED || status === PermissionStatus.DENIED;
}

/** Permanently denied — the only way forward is app Settings. */
export function isBlocked(status) {
  return status === PermissionStatus.BLOCKED;
}

/**
 * Translate an expo-modules `PermissionResponse` into a {@link PermissionStatus}.
 * Every Expo permission module returns the same shape, so one translator covers
 * notifications, camera, microphone, media library and location.
 *
 * @param {{status?: string, granted?: boolean, canAskAgain?: boolean, accessPrivileges?: string}} response
 */
export function fromExpoResponse(response) {
  if (!response) return PermissionStatus.UNDETERMINED;

  const { status, granted, canAskAgain, accessPrivileges } = response;

  if (granted || status === 'granted') {
    // iOS photo picker can hand back a partial selection; treat it as usable rather
    // than nagging the user for full-library access they intentionally withheld.
    return accessPrivileges === 'limited' ? PermissionStatus.LIMITED : PermissionStatus.GRANTED;
  }

  if (status === 'undetermined') return PermissionStatus.UNDETERMINED;

  return canAskAgain === false ? PermissionStatus.BLOCKED : PermissionStatus.DENIED;
}
