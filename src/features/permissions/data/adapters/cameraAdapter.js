import { Camera } from 'expo-camera';

import { fromExpoResponse } from '../../domain/permissionTypes';

/**
 * Camera adapter — android.permission.CAMERA / NSCameraUsageDescription.
 *
 * Uses the `Camera` namespace object rather than standalone functions because
 * expo-camera only exports the imperative permission helpers through it.
 * Backs photo/video capture in chats and status, plus video calling.
 */
const cameraAdapter = {
  id: 'camera',

  isSupported() {
    return true;
  },

  async check() {
    return fromExpoResponse(await Camera.getCameraPermissionsAsync());
  },

  async request() {
    return fromExpoResponse(await Camera.requestCameraPermissionsAsync());
  },
};

export default cameraAdapter;
