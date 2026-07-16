/**
 * Silences KNOWN, accepted deprecation notices — and nothing else — so real
 * warnings stay visible in the Metro terminal and LogBox.
 *
 * MUST be the FIRST import in index.js: these notices fire at module-import
 * time (expo-av warns the moment it is required anywhere in the app tree), so
 * the filter has to be installed before the rest of the app graph evaluates.
 *
 * Currently silenced:
 *   • expo-av deprecation — informational; the library still works on SDK 54.
 *     Migrating to expo-audio is a PLANNED task, not a quick swap: expo-av
 *     `Audio` powers call ringtone + earpiece/speaker routing and voice notes
 *     across ~10 files, and audio-session behavior differs between libraries.
 *
 * Do NOT add RN Firebase deprecation strings here — those namespaced calls
 * were actually migrated to the modular API (fcmService.js getMessaging shim);
 * if that warning ever reappears it means a new namespaced call crept in and
 * should be fixed, not hidden.
 */
const SILENCED_PATTERNS = [
  '[expo-av]: Expo AV has been deprecated',
];

const originalWarn = console.warn;
console.warn = (...args) => {
  const first = args[0];
  if (typeof first === 'string' && SILENCED_PATTERNS.some((p) => first.startsWith(p))) {
    return;
  }
  originalWarn(...args);
};
