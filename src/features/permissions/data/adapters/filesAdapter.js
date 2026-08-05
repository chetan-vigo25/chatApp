import { Platform, PermissionsAndroid } from 'react-native';

import { PermissionStatus } from '../../domain/permissionTypes';

const LEGACY_STORAGE = PermissionsAndroid.PERMISSIONS?.READ_EXTERNAL_STORAGE;

/**
 * Files & storage adapter.
 *
 * This permission only EXISTS on Android 8–12, where reading a document off shared
 * storage needs READ_EXTERNAL_STORAGE. From Android 13 (API 33) that permission was
 * split into the granular media permissions (handled by the Photos row) and document
 * access moved to the Storage Access Framework, which grants per-file access with no
 * runtime permission at all. iOS document picking likewise needs no permission —
 * UIDocumentPickerViewController hands back a security-scoped URL.
 *
 * So on modern Android and on iOS this adapter reports "unsupported" and the row is
 * not rendered at all. Showing an Allow button that cannot open a system dialog would
 * either be a dead control or a faked approval — both are exactly what the flow must
 * never do, and requesting a permission the app does not need is a Play policy
 * violation in its own right.
 */
const filesAdapter = {
  id: 'files',

  isSupported() {
    return Platform.OS === 'android' && Number(Platform.Version) < 33 && !!LEGACY_STORAGE;
  },

  async check() {
    if (!filesAdapter.isSupported()) return PermissionStatus.UNAVAILABLE;

    // `check()` is passive and safe from any context, but it cannot distinguish
    // "denied" from "don't ask again" — the PermissionManager layers the remembered
    // BLOCKED state from a previous request() on top of this result.
    const granted = await PermissionsAndroid.check(LEGACY_STORAGE);
    return granted ? PermissionStatus.GRANTED : PermissionStatus.DENIED;
  },

  async request() {
    if (!filesAdapter.isSupported()) return PermissionStatus.UNAVAILABLE;

    const result = await PermissionsAndroid.request(LEGACY_STORAGE);

    if (result === PermissionsAndroid.RESULTS.GRANTED) return PermissionStatus.GRANTED;
    if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return PermissionStatus.BLOCKED;
    return PermissionStatus.DENIED;
  },
};

export default filesAdapter;
