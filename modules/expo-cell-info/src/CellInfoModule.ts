import { requireOptionalNativeModule } from 'expo-modules-core';

import type {
  CellInfo,
  GetCellInfoOptions,
  PermissionResponse,
} from './CellInfo.types';

// Shape of the underlying native module (Android only).
interface NativeCellInfoModule {
  getAllCellInfo(options: GetCellInfoOptions): Promise<CellInfo[]>;
  hasPermissions(): boolean;
  getPermissionsAsync(): Promise<PermissionResponse>;
  requestPermissionsAsync(): Promise<PermissionResponse>;
  requestPhoneStatePermissionsAsync(): Promise<PermissionResponse>;
}

// `requireOptionalNativeModule` returns null instead of throwing when the native
// module isn't present (iOS, Expo Go, or before a dev-build rebuild). This lets
// callers degrade gracefully rather than crash at import time.
const Native = requireOptionalNativeModule<NativeCellInfoModule>('CellInfoModule');

/**
 * True on builds that actually include the native module (Android dev build /
 * release). False on iOS and in Expo Go.
 */
export function isAvailable(): boolean {
  return Native != null;
}

class UnavailableError extends Error {
  code = 'ERR_CELL_INFO_UNAVAILABLE';
  constructor() {
    super(
      'expo-cell-info native module is unavailable. It is Android-only and ' +
        'requires a development/production build (not Expo Go). Run ' +
        '`npx expo prebuild` + `npx expo run:android`.'
    );
  }
}

/**
 * Reads cell towers via Android TelephonyManager.getAllCellInfo().
 *
 * @throws if FINE location permission is missing (code `ERR_MISSING_PERMISSION`)
 *         or the native module is unavailable (code `ERR_CELL_INFO_UNAVAILABLE`).
 */
async function getAllCellInfo(
  options: GetCellInfoOptions = {}
): Promise<CellInfo[]> {
  if (!Native) throw new UnavailableError();
  // Always pass a concrete object so the native arg count matches.
  return Native.getAllCellInfo({ includeNeighbors: false, ...options });
}

/** Synchronous check: is FINE location already granted? (false if unavailable) */
function hasPermissions(): boolean {
  return Native?.hasPermissions() ?? false;
}

/** Current permission status (FINE_LOCATION + READ_PHONE_STATE). */
async function getPermissionsAsync(): Promise<PermissionResponse> {
  if (!Native) throw new UnavailableError();
  return Native.getPermissionsAsync();
}

/** Prompts for the required runtime permission (FINE location) and returns status. */
async function requestPermissionsAsync(): Promise<PermissionResponse> {
  if (!Native) throw new UnavailableError();
  return Native.requestPermissionsAsync();
}

/**
 * Optional: prompt for READ_PHONE_STATE to improve dual-SIM enumeration. Not
 * required for basic getAllCellInfo(). Call only if you need per-SIM data.
 */
async function requestPhoneStatePermissionsAsync(): Promise<PermissionResponse> {
  if (!Native) throw new UnavailableError();
  return Native.requestPhoneStatePermissionsAsync();
}

export const CellInfoModule = {
  isAvailable,
  getAllCellInfo,
  hasPermissions,
  getPermissionsAsync,
  requestPermissionsAsync,
  requestPhoneStatePermissionsAsync,
};

export default CellInfoModule;
