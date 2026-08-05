import { useEffect, useRef } from 'react';
import { AppState, Dimensions, PixelRatio, Platform } from 'react-native';
import * as Location from 'expo-location';
import * as Battery from 'expo-battery';
import NetInfo from '@react-native-community/netinfo';
import { useDispatch, useSelector } from 'react-redux';
import { useDeviceInfo } from '../contexts/DeviceInfoContext';
import { emitSocketEvent } from '../Redux/Services/Socket/socket';
import ChatDatabase from '../services/ChatDatabase';
import OutboxWorker from '../services/OutboxWorker';
import { stopped, configReceived } from '../Redux/Reducer/Tracking/Tracking.reducer';

// How often / how far the device must move before a new fix is streamed
// (defaults — overridden by the server tracking config when tracking is on).
const LOCATION_TIME_INTERVAL = 60000; // 60s
const LOCATION_DISTANCE_INTERVAL = 50; // 50m

const getTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
};

// Tiny non-crypto string hash (djb2 xor, hex) — good enough for the tracking
// eventId idempotency key: hash(deviceIdentity | deviceTs | coords).
const tinyHash = (str) => {
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = ((h1 * 33) ^ c) >>> 0;
    h2 = ((h2 * 31) ^ c) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
};

/**
 * Streams the device's realtime location + device/network telemetry to the
 * backend via the existing socket (`location:update`). The backend persists it
 * onto the user's active session so the admin panel can show live location.
 *
 * TRACKING MODE (admin-controlled Tracking module, Phase 1 foreground-only):
 * when the Redux `tracking` slice says enabled && consent granted, the watcher
 * re-arms with the server's intervalSec/distanceM, every fix carries an
 * idempotent eventId + deviceTs + trackingType, and — unlike the untracked
 * default, which drops fixes while offline — offline fixes are enqueued into
 * the durable SQLite outbox (record_type='tracking', 500-row drop-oldest cap)
 * and drained by OutboxWorker on reconnect. A TRACKING_DISABLED error ack
 * purges the queue and stops tracking.
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
  const dispatch = useDispatch();
  const deviceInfoRef = useRef(deviceInfo);
  const watcherRef = useRef(null);

  // Admin-controlled tracking state (server-pushed via tracking:config).
  const trackingEnabled = useSelector((s) => !!s?.tracking?.enabled);
  const trackingConsent = useSelector((s) => s?.tracking?.consent);
  const intervalSec = useSelector((s) => s?.tracking?.config?.intervalSec);
  const distanceM = useSelector((s) => s?.tracking?.config?.distanceM);
  const tracked = trackingEnabled && trackingConsent === 'granted';

  const timeInterval =
    tracked && Number(intervalSec) > 0 ? Number(intervalSec) * 1000 : LOCATION_TIME_INTERVAL;
  const distanceInterval =
    tracked && Number(distanceM) > 0 ? Number(distanceM) : LOCATION_DISTANCE_INTERVAL;

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
        // The device's own network IP. Server-side detection can't see it when
        // the app connects over adb-reverse/a proxy (traffic arrives as
        // loopback), so the device reports it directly (wifi exposes it;
        // cellular usually doesn't).
        payload.deviceIp = net?.details?.ipAddress || null;
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

    // TRACKING_DISABLED ack (admin disabled while we were emitting/queued):
    // purge queued tracking rows, stop watcher + indicator via the slice.
    //
    // Then RE-REQUEST the config and let the server's answer win: a fix sent
    // during a brief pause can bring its TRACKING_DISABLED ack back AFTER the
    // admin has already resumed — without this re-check that late ack would
    // clobber the resumed state and tracking would stay off until the next
    // reconnect (the pause→resume "tracking never restarts" bug).
    const onTrackingAck = (response) => {
      const code = response?.data?.code || response?.code;
      if (response?.status === false && code === 'TRACKING_DISABLED') {
        ChatDatabase.purgeTrackingRows().catch(() => {});
        dispatch(stopped());
        emitSocketEvent('tracking:config:request', {}, (resp) => {
          const cfg = resp?.config || resp?.data?.config || resp?.data || null;
          if (cfg && (resp?.ok || resp?.status === true)) dispatch(configReceived(cfg));
        }, { queueIfOffline: false });
      }
    };

    const emitFix = async (loc) => {
      const coords = loc?.coords;
      if (!coords || cancelled) return;
      const { latitude, longitude, accuracy, altitude, speed, heading } = coords;
      if (latitude == null || longitude == null) return;

      const [address, deviceInfoPayload] = await Promise.all([
        buildAddress(latitude, longitude),
        buildDeviceInfo(),
      ]);
      if (cancelled) return;

      const payload = {
        coords: { latitude, longitude, accuracy, altitude },
        address,
        deviceInfo: deviceInfoPayload,
      };

      if (!tracked) {
        // Untracked users keep the original behaviour: don't queue stale fixes
        // while offline — the watcher will emit again.
        emitSocketEvent('location:update', payload, undefined, { queueIfOffline: false });
        return;
      }

      // Tracking mode: idempotent eventId + device timestamp + telemetry.
      const deviceTs = Number(loc?.timestamp) || Date.now();
      const base = deviceInfoRef.current || {};
      const identity = base.deviceId || base.modelName || 'device';
      const eventId = tinyHash(`${identity}|${deviceTs}|${latitude}|${longitude}`);
      payload.eventId = eventId;
      payload.deviceTs = deviceTs;
      payload.trackingType = 'fix';
      if (speed != null) payload.speed = speed;
      if (heading != null) payload.heading = heading;

      const sent = emitSocketEvent('location:update', payload, onTrackingAck, {
        queueIfOffline: false,
      });
      if (!sent) {
        // Socket down/unauthenticated — persist into the durable outbox so the
        // fix drains exactly once on reconnect (server dedupes on eventId).
        try {
          await ChatDatabase.enqueueTrackingEvent(eventId, payload);
          OutboxWorker.wake();
        } catch {
          // storage is best-effort; the watcher keeps producing fixes
        }
      }
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
      if (status !== 'granted' || cancelled) {
        if (status !== 'granted' && tracked) {
          // OS-level denial while org tracking is on — surface an observed stop
          // so the admin sees "os_permission_denied" instead of a silent gap.
          emitSocketEvent(
            'location:update',
            { trackingType: 'stop', stopReason: 'os_permission_denied', deviceTs: Date.now() },
            onTrackingAck,
            { queueIfOffline: false },
          );
        }
        return;
      }

      // Send an immediate fix, then keep streaming on movement / interval.
      await emitCurrent();
      if (cancelled) return;

      watcherRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          timeInterval,
          distanceInterval,
        },
        emitFix,
      );

      // Tracked mode: the OS watcher is movement-gated (distanceInterval), so
      // a STATIONARY device gets no callbacks at all — the admin timeline
      // would go silent and read as "signal lost". This heartbeat emits a
      // periodic fix at the configured interval even when the device hasn't
      // moved (foreground-only, so no extra battery cost while backgrounded).
      if (tracked) {
        heartbeatTimer = setInterval(() => {
          if (!cancelled && AppState.currentState === 'active') emitCurrent();
        }, timeInterval);
      }

      // Re-emit when the app returns to the foreground.
      appStateSub = AppState.addEventListener('change', (next) => {
        if (next === 'active' && !cancelled) emitCurrent();
      });
    };

    let heartbeatTimer = null;
    start();

    return () => {
      cancelled = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (watcherRef.current) {
        watcherRef.current.remove();
        watcherRef.current = null;
      }
      if (appStateSub) appStateSub.remove();
    };
    // Re-arm the watcher whenever tracking mode or the server params change.
  }, [enabled, tracked, timeInterval, distanceInterval, dispatch]);
};

export default useLocationTracking;
