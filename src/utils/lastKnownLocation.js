// In-memory cache of the device's most recent location fix.
//
// Written by every fix the legacy location streamer produces
// (useLocationTracking emits one immediately on app start/foreground and then
// every 60s / 50m), so by the time the user places a call a warm coordinate is
// almost always sitting here — no GPS round-trip needed on the call path.
// Module-level on purpose: survives across screens, resets on app relaunch.

let _last = null; // { latitude, longitude, accuracy, capturedAt }

export const setLastKnownLocation = (coords) => {
  const lat = Number(coords?.latitude);
  const lng = Number(coords?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  const acc = Number(coords?.accuracy);
  _last = {
    latitude: lat,
    longitude: lng,
    accuracy: Number.isFinite(acc) ? acc : null,
    capturedAt: Date.now(),
  };
};

// Returns the cached fix, or null when nothing was captured yet or the fix is
// older than maxAgeMs.
export const getLastKnownLocation = (maxAgeMs = 5 * 60 * 1000) => {
  if (!_last) return null;
  if (Date.now() - _last.capturedAt > maxAgeMs) return null;
  return _last;
};

export default { setLastKnownLocation, getLastKnownLocation };
