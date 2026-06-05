import { useEffect, useRef } from 'react';
import { AppState, Dimensions, PixelRatio, Platform } from 'react-native';
import * as Location from 'expo-location';
import * as Battery from 'expo-battery';
import NetInfo from '@react-native-community/netinfo';
import { useDeviceInfo } from '../contexts/DeviceInfoContext';
import { emitSocketEvent } from '../Redux/Services/Socket/socket';

// How often / how far the device must move before a new fix is streamed.
const LOCATION_TIME_INTERVAL = 60000; // 60s
const LOCATION_DISTANCE_INTERVAL = 50; // 50m

const getTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
};

/**
 * Streams the device's realtime location + device/network telemetry to the
 * backend via the existing socket (`location:update`). The backend persists it
 * onto the user's active session so the admin panel can show live location.
 *
 * Foreground-only (matches the ACCESS_FINE_LOCATION foreground permission in
 * app.json). No-ops gracefully if the user denies the location permission.
 *
 * Mount this exactly once from an always-mounted, post-authentication provider.
 *
 * @param {boolean} enabled  gate tracking on auth/socket readiness
 */
export const useLocationTracking = (enabled = true) => {
  const deviceInfo = useDeviceInfo();
  const deviceInfoRef = useRef(deviceInfo);
  const watcherRef = useRef(null);

  // Keep the latest hardware info available to the long-lived watcher callback.
  useEffect(() => {
    deviceInfoRef.current = deviceInfo;
  }, [deviceInfo]);

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;
    let appStateSub = null;

    // Assemble the device/network telemetry block sent alongside each fix.
    const buildDeviceInfo = async () => {
      const base = deviceInfoRef.current || {};
      const payload = {
        deviceName: base.modelName,
        brand: base.brand,
        os: base.osName,
        osVersion: base.version,
        memory: base.memory,
        deviceYearClass: base.deviceYearClass,
        deviceType: base.deviceType,
        platform: Platform.OS,
        appVersion: base.appVersion,
        timezone: getTimezone(),
      };

      try {
        const level = await Battery.getBatteryLevelAsync();
        const state = await Battery.getBatteryStateAsync();
        payload.batteryLevel = level >= 0 ? level : null;
        payload.isCharging =
          state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL;
      } catch {
        // battery info is best-effort
      }

      try {
        const net = await NetInfo.fetch();
        payload.networkType = net?.type || null;
        payload.carrier = net?.details?.carrier || null;
      } catch {
        // network info is best-effort
      }

      const { width, height } = Dimensions.get('window');
      payload.screenWidth = Math.round(width);
      payload.screenHeight = Math.round(height);
      payload.pixelRatio = PixelRatio.get();

      return payload;
    };

    // Reverse-geocode a fix into a human-readable address (best-effort).
    const buildAddress = async (latitude, longitude) => {
      try {
        const geo = await Location.reverseGeocodeAsync({ latitude, longitude });
        const g = geo?.[0];
        if (!g) return null;
        return {
          street: [g.name, g.street].filter(Boolean).join(' ').trim() || null,
          city: g.city || g.subregion || null,
          state: g.region || null,
          country: g.country || null,
          zipCode: g.postalCode || null,
          timezone: getTimezone(),
        };
      } catch {
        return null;
      }
    };

    const emitFix = async (loc) => {
      const coords = loc?.coords;
      if (!coords || cancelled) return;
      const { latitude, longitude, accuracy, altitude } = coords;
      if (latitude == null || longitude == null) return;

      const [address, deviceInfoPayload] = await Promise.all([
        buildAddress(latitude, longitude),
        buildDeviceInfo(),
      ]);
      if (cancelled) return;

      // Don't queue stale fixes while offline — the watcher will emit again.
      emitSocketEvent(
        'location:update',
        { coords: { latitude, longitude, accuracy, altitude }, address, deviceInfo: deviceInfoPayload },
        undefined,
        { queueIfOffline: false },
      );
    };

    const emitCurrent = async () => {
      try {
        const current = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        await emitFix(current);
      } catch {
        // unable to get a one-off fix; the watcher will cover it
      }
    };

    const start = async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted' || cancelled) return;

      // Send an immediate fix, then keep streaming on movement / interval.
      await emitCurrent();
      if (cancelled) return;

      watcherRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: LOCATION_TIME_INTERVAL,
          distanceInterval: LOCATION_DISTANCE_INTERVAL,
        },
        emitFix,
      );

      // Re-emit when the app returns to the foreground.
      appStateSub = AppState.addEventListener('change', (next) => {
        if (next === 'active' && !cancelled) emitCurrent();
      });
    };

    start();

    return () => {
      cancelled = true;
      if (watcherRef.current) {
        watcherRef.current.remove();
        watcherRef.current = null;
      }
      if (appStateSub) appStateSub.remove();
    };
  }, [enabled]);
};

export default useLocationTracking;
