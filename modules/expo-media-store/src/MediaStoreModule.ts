import { requireOptionalNativeModule } from 'expo-modules-core';

interface NativeMediaStore {
  getMediaRoot(): string;
  saveToMedia(srcUri: string, subDir: string, fileName: string, scan: boolean, move: boolean): Promise<string>;
  fileExists(uri: string): boolean;
}

// null on iOS / Expo Go / a build made before this module existed — callers
// fall back to app-private storage.
const Native = requireOptionalNativeModule<NativeMediaStore>('ExpoMediaStore');

export function isAvailable(): boolean {
  return Native != null;
}

/** Absolute path of Android/media/<package>/TalksTry/Media (created on demand). */
export function getMediaRoot(): string | null {
  return Native ? Native.getMediaRoot() : null;
}

/**
 * Copy (or move) a local file into <root>/<subDir>/<fileName>, de-duplicating
 * the name, and media-scan it when `scan` (gallery-visible). Returns a file://
 * URI. Sent/ folders carry a .nomedia so they never reach the gallery.
 */
export async function saveToMedia(
  srcUri: string,
  subDir: string,
  fileName: string,
  { scan = true, move = false }: { scan?: boolean; move?: boolean } = {},
): Promise<string | null> {
  if (!Native) return null;
  return Native.saveToMedia(srcUri, subDir, fileName, scan, move);
}

/** Plain existence check — works on the external media path (no permission). */
export function fileExists(uri: string): boolean {
  return Native ? Native.fileExists(uri) : false;
}

export default { isAvailable, getMediaRoot, saveToMedia, fileExists };
