import { Platform } from 'react-native';
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
 * SCOPED TO ['photo', 'video'] ON PURPOSE.
 *
 * Called with no granular list, expo-media-library defaults to
 * [PHOTO, VIDEO, AUDIO], and its response is granted ONLY when every one of
 * them came back granted. On Android 13+ that means a second "music and audio"
 * system dialog the app has no use for — and denying it reports PHOTOS as
 * denied even though the user just allowed every photo on the device. That is
 * how a full grant at startup could still leave the picker asking again.
 *
 * The app has no audio-library feature; asking for it can only lose.
 */
const GRANULAR = Platform.OS === 'android' ? ['photo', 'video'] : undefined;

/**
 * The scoped form THROWS when a granular permission is missing from the
 * manifest, so an old install must still degrade to the unscoped call rather
 * than reporting a hard failure.
 */
const withGranular = async (fn) => {
  try {
    return await fn(false, GRANULAR);
  } catch (error) {
    console.warn('[permissions] scoped photo permission failed:', error?.message);
    return fn();
  }
};

const photosAdapter = {
  id: 'photos',

  isSupported() {
    return true;
  },

  async check() {
    return fromExpoResponse(await withGranular(MediaLibrary.getPermissionsAsync));
  },

  async request() {
    return fromExpoResponse(await withGranular(MediaLibrary.requestPermissionsAsync));
  },
};

export default photosAdapter;
