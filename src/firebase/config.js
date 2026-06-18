// Resolves the Firebase [DEFAULT] app and makes sure it's ready before any
// @react-native-firebase module (messaging, etc.) is used.
//
// The [DEFAULT] app is created NATIVELY from google-services.json (Android) /
// GoogleService-Info.plist (iOS) by the Google Services Gradle/CocoaPods plugin
// at build time — it CANNOT be reliably created from JS (initializeApp() is
// async and returns a Promise, so it isn't ready for the synchronous messaging()
// call that needs it). So this module does NOT try to init from JS; it just
// resolves the native default app and surfaces a clear warning if it's missing.
//
// If you ever see that warning, the build didn't apply google-services.json:
// re-run `npx expo prebuild --clean -p android` and rebuild. The app package
// (com.chat.baatCheet) must match a client in google-services.json.
//
// Crash-safe: if the native RNFirebase module is absent (Expo Go, or a build
// made before Firebase was added) this no-ops instead of throwing at import.

let _ensured = false;
let firebaseApp = null;

// Idempotent. Safe to call before every messaging() use. Returns the app or null.
export const ensureFirebaseApp = () => {
  if (_ensured) return firebaseApp;
  _ensured = true;

  try {
    // eslint-disable-next-line global-require
    const mod = require('@react-native-firebase/app');
    const ns = mod && (mod.default || mod);
    const getApps = mod.getApps || (ns && ns.apps !== undefined ? () => ns.apps : null);
    const getApp = mod.getApp || (ns && ns.app ? ns.app.bind(ns) : null);

    const apps = getApps ? getApps() : [];
    if (apps && apps.length) {
      firebaseApp = getApp ? getApp() : apps[0];
    } else {
      console.warn(
        '[Firebase] No [DEFAULT] app — google-services.json was not applied at ' +
        'build time. Re-run `expo prebuild --clean -p android` and rebuild.'
      );
    }
  } catch (err) {
    console.warn('[Firebase] native app module unavailable — push disabled until rebuild:', err?.message);
  }

  return firebaseApp;
};

// Resolve at import time too, so a side-effect import (from fcmService) is enough.
ensureFirebaseApp();

export { firebaseApp };
