import { requireOptionalNativeModule } from 'expo-modules-core';

import {
  MLKIT_ERROR,
  UNDETERMINED_LANGUAGE,
  type DownloadArgs,
  type MlkitLanguage,
  type TranslateArgs,
} from './MlkitTranslate.types';

interface NativeMlkitTranslateModule {
  translate(args: TranslateArgs): Promise<string>;
  identifyLanguage(text: string): Promise<string>;
  isModelDownloaded(language: MlkitLanguage): Promise<boolean>;
  downloadModel(args: DownloadArgs): Promise<void>;
  deleteModel(language: MlkitLanguage): Promise<void>;
  getDownloadedModels(): Promise<string[]>;
  getSupportedLanguages(): string[];
}

// Null instead of throwing when the native side isn't in the binary — Expo Go,
// or a JS-only reload before the app has been rebuilt. Callers degrade to
// untranslated text rather than crashing at import.
const Native = requireOptionalNativeModule<NativeMlkitTranslateModule>('MlkitTranslateModule');

/** True on builds that actually contain the native module. */
export function isAvailable(): boolean {
  return Native != null;
}

class UnavailableError extends Error {
  code = MLKIT_ERROR.UNAVAILABLE;
  constructor() {
    super(
      'expo-mlkit-translate native module is unavailable. It needs a development/' +
        'production build (not Expo Go). Run `npx expo prebuild` then ' +
        '`npx expo run:android` / `npx expo run:ios`.'
    );
  }
}

/**
 * ML Kit's own list of translatable languages, straight from the native enum.
 *
 * Read this instead of hard-coding — ML Kit does NOT cover every language the
 * app might want to offer (Malayalam and Punjabi, for two), and the list grows
 * between SDK versions.
 */
function getSupportedLanguages(): string[] {
  return Native?.getSupportedLanguages() ?? [];
}

function isLanguageSupported(language: MlkitLanguage): boolean {
  return getSupportedLanguages().includes(language);
}

/**
 * Best-effort source-language detection.
 *
 * Resolves to `'und'` when ML Kit has no confident answer — short or mixed
 * strings often land there, and the caller decides what to do about it.
 */
async function identifyLanguage(text: string): Promise<string> {
  if (!Native) throw new UnavailableError();
  if (typeof text !== 'string' || !text.trim()) return UNDETERMINED_LANGUAGE;
  return Native.identifyLanguage(text);
}

/**
 * Translate one string between two DOWNLOADED models.
 *
 * Rejects with `ERR_MLKIT_MODEL_MISSING` when a model is absent and
 * `allowDownload` is false — that is the normal chat path, and the caller is
 * expected to treat it as "not yet", not as a hard failure.
 */
async function translate(args: TranslateArgs): Promise<string> {
  if (!Native) throw new UnavailableError();
  return Native.translate({ allowDownload: false, ...args });
}

async function isModelDownloaded(language: MlkitLanguage): Promise<boolean> {
  if (!Native) return false;
  return Native.isModelDownloaded(language);
}

/** Fetch a ~30MB model. Wi-Fi-only by default. Resolves once it is usable. */
async function downloadModel(args: DownloadArgs): Promise<void> {
  if (!Native) throw new UnavailableError();
  return Native.downloadModel({ requireWifi: true, ...args });
}

async function deleteModel(language: MlkitLanguage): Promise<void> {
  if (!Native) throw new UnavailableError();
  return Native.deleteModel(language);
}

async function getDownloadedModels(): Promise<string[]> {
  if (!Native) return [];
  return Native.getDownloadedModels();
}

export const MlkitTranslate = {
  isAvailable,
  getSupportedLanguages,
  isLanguageSupported,
  identifyLanguage,
  translate,
  isModelDownloaded,
  downloadModel,
  deleteModel,
  getDownloadedModels,
};

export default MlkitTranslate;
