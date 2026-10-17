// Pure helper: which APNs environment does THIS build's VoIP token belong to?
// CommonJS + dependency-free so it can be unit-tested with node:test.
//
// Input comes from expo-application (already a dependency):
//   getIosPushNotificationServiceEnvironmentAsync() -> 'development' | 'production' | null
//       (reads aps-environment from the embedded provisioning profile)
//   getIosApplicationReleaseTypeAsync()             -> numeric ApplicationReleaseType
// Anything we cannot derive reliably returns null and the caller omits the field
// (the backend then falls back to its own env guess, exactly as before).

const RELEASE_TYPE_SIMULATOR = 1;
const RELEASE_TYPE_APP_STORE = 5;

const deriveVoipEnv = ({ apsEnvironment, releaseType } = {}) => {
  if (apsEnvironment === 'development' || apsEnvironment === 'production') return apsEnvironment;
  // App Store builds ship without an embedded provisioning profile, so the
  // profile read is null; an App Store binary is by definition 'production'.
  if (Number(releaseType) === RELEASE_TYPE_APP_STORE) return 'production';
  // Simulator (no APNs) / unknown release type: do not guess.
  if (Number(releaseType) === RELEASE_TYPE_SIMULATOR) return null;
  return null;
};

module.exports = { deriveVoipEnv, RELEASE_TYPE_APP_STORE, RELEASE_TYPE_SIMULATOR };
