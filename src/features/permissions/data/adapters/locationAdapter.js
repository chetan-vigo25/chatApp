import * as Location from 'expo-location';

import { fromExpoResponse } from '../../domain/permissionTypes';

/**
 * Location adapter — FOREGROUND ("when in use") only.
 *
 * ACCESS_FINE_LOCATION / NSLocationWhenInUseUsageDescription. Used solely for the
 * "share my current location" attachment. Background location is intentionally never
 * requested here: Google Play requires a separate declaration and review for it, and
 * the app has no feature that needs it at startup.
 *
 * On Android 12+ the OS additionally offers approximate-vs-precise; either choice
 * comes back as granted, which is correct — location sharing works with both.
 */
const locationAdapter = {
  id: 'location',

  isSupported() {
    return true;
  },

  async check() {
    return fromExpoResponse(await Location.getForegroundPermissionsAsync());
  },

  async request() {
    return fromExpoResponse(await Location.requestForegroundPermissionsAsync());
  },
};

export default locationAdapter;
