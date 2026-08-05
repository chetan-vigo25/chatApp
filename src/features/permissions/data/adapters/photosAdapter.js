import * as MediaLibrary from 'expo-media-library';

import { fromExpoResponse } from '../../domain/permissionTypes';

/**
 * Photos & videos adapter.
 *
 * Android 13+ → READ_MEDIA_IMAGES + READ_MEDIA_VIDEO (granular media permissions).
 * Android 8–12 → READ_EXTERNAL_STORAGE.
 * iOS         → Photo Library (read + add), including the "Limited" selection mode,
 *               which `fromExpoResponse` maps to PermissionStatus.LIMITED and the app
 *               treats as satisfied — we never nag for full-library access.
 *
 * expo-media-library resolves the right permission set for the running OS version by
 * itself, which is why there is no Platform.Version branching here.
 */
const photosAdapter = {
  id: 'photos',

  isSupported() {
    return true;
  },

  async check() {
    return fromExpoResponse(await MediaLibrary.getPermissionsAsync());
  },

  async request() {
    return fromExpoResponse(await MediaLibrary.requestPermissionsAsync());
  },
};

export default photosAdapter;
