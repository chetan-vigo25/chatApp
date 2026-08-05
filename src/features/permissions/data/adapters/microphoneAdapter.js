import { Camera } from 'expo-camera';

import { fromExpoResponse } from '../../domain/permissionTypes';

/**
 * Microphone adapter — android.permission.RECORD_AUDIO / NSMicrophoneUsageDescription.
 *
 * Backs voice messages and voice/video calls. expo-camera's microphone helpers map to
 * the same OS permission that expo-av's recorder and the call engine ask for, so
 * granting it here means the call flow (calls/CallProvider) finds it already granted
 * and never prompts a second time.
 */
const microphoneAdapter = {
  id: 'microphone',

  isSupported() {
    return true;
  },

  async check() {
    return fromExpoResponse(await Camera.getMicrophonePermissionsAsync());
  },

  async request() {
    return fromExpoResponse(await Camera.requestMicrophonePermissionsAsync());
  },
};

export default microphoneAdapter;
